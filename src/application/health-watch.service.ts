// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { AlertService } from './alert.service';
import { AuditAnchorService } from './audit-anchor.service';
import { CaService } from '../infrastructure/pki/ca.service';

/**
 * 능동 감시(보안 트랙 S9) — 임계 상태를 주기 점검해 {@link AlertService} 로 통지한다.
 *
 * 점검 5종(계획서 S9):
 *  ① 백업 신선도 — 호스트 cron(`scripts/backup-sign-db.sh`)이 성공 시 남기는 하트비트가
 *    `BACKUP_MAX_AGE_H`(기본 26h)보다 오래되면 경고. **앱은 호스트 크론을 볼 수 없으므로
 *    "성공 신호가 오지 않음"으로 실패를 판단한다**(무소식이 곧 나쁜 소식인 유일한 항목).
 *  ② 감사 체인 검증 실패 — 표본 스트림의 chainValid 붕괴는 최우선 경보(증거 서비스의 심장).
 *  ③ 로그인 실패 폭주 — 창(window) 내 LOGIN_FAILED 임계 초과(크리덴셜 스터핑 징후).
 *  ④ 웹훅 DEAD 발생 — 연동 상대에게 결과가 도달하지 못한 채 재시도가 소진된 상태.
 *  ⑤ ready 실패 — DB·CA 로딩 실패(트래픽을 받으면 안 되는 상태).
 *
 * 감시 자체는 절대 서비스를 막지 않는다 — 각 점검은 독립 try/catch 이고 실패해도 다음 점검을 계속한다.
 * 설정: `SCHEDULER_WATCH_MIN`(기본 5분·0 이면 비활성) · `ALERT_LOGIN_FAIL_THRESHOLD`(기본 10) ·
 *      `ALERT_LOGIN_FAIL_WINDOW_MIN`(기본 10) · `BACKUP_MAX_AGE_H`(기본 26).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const BACKUP_HEARTBEAT_KEY = 'ops:backup-heartbeat';

@Injectable()
export class HealthWatchService {
  private readonly log = new Logger('health-watch');

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly alert: AlertService,
    private readonly anchor: AuditAnchorService,
    private readonly ca: CaService,
    private readonly config: ConfigService,
  ) {}

  /** 백업 스크립트가 성공 시 호출(POST /v1/maintenance/backup-heartbeat)해 남기는 생존 신호. */
  async recordBackupHeartbeat(note?: string): Promise<{ at: string }> {
    const at = new Date().toISOString();
    await this.store.saveMeta(BACKUP_HEARTBEAT_KEY, { at, note: note?.slice(0, 200) ?? null });
    return { at };
  }

  async runAll(): Promise<{ checked: number; alerts: number }> {
    let alerts = 0;
    const checks: Array<[string, () => Promise<boolean>]> = [
      ['backup', () => this.checkBackup()],
      ['audit-chain', () => this.checkAuditChains()],
      ['login-failures', () => this.checkLoginFailures()],
      ['webhook-dead', () => this.checkWebhookDead()],
      ['readiness', () => this.checkReadiness()],
    ];
    for (const [name, fn] of checks) {
      try {
        if (await fn()) alerts++;
      } catch (e) {
        this.log.error(`감시 항목 ${name} 실패: ${(e as Error).message}`);
      }
    }
    return { checked: checks.length, alerts };
  }

  /** ① 백업 신선도 — 하트비트 부재/노후. 하트비트를 한 번도 못 받은 상태는 알리지 않는다(미도입 환경 오탐 방지). */
  private async checkBackup(): Promise<boolean> {
    const maxAgeH = Number(this.config.get<string>('BACKUP_MAX_AGE_H') ?? 26);
    const hb = await this.store.getMeta<{ at: string }>(BACKUP_HEARTBEAT_KEY);
    if (!hb?.at) return false;
    const ageH = (Date.now() - Date.parse(hb.at)) / 3_600_000;
    if (ageH <= maxAgeH) return false;
    return this.alert.raise(
      'backup-stale',
      `백업 신호 없음 — 마지막 성공 ${Math.floor(ageH)}시간 전`,
      `마지막 백업 성공: ${hb.at}\n허용 간격: ${maxAgeH}시간\n\n라이브 호스트에서 확인:\n  tail -20 ~/sign-backups/backup.log\n  crontab -l | grep backup-sign-db\n\n복구 절차는 docs/06-ops/backup-restore-runbook.md 참조.`,
    );
  }

  /** ② 감사 체인 검증 — 표본(최근 스트림 상위 N)의 chainValid 붕괴 탐지. */
  private async checkAuditChains(): Promise<boolean> {
    const sample = Number(this.config.get<string>('ALERT_CHAIN_SAMPLE') ?? 20);
    // 최근 활동(최대 seq) 상위 N 스트림 — 종전 `auditKeys('').slice(-N)` 은 distinct 순서 미정의라 "임의 N"이었다(F4).
    const keys = await this.store.auditKeysByRecency(sample);
    const broken: string[] = [];
    for (const k of keys) {
      const v = await this.anchor.verify(k);
      if (!v.chainValid) broken.push(k);
    }
    if (!broken.length) return false;
    return this.alert.raise(
      'audit-chain-broken',
      `감사 체인 검증 실패 ${broken.length}건 — 즉시 확인 필요`,
      `체인이 깨진 스트림:\n${broken.map((b) => `  - ${b}`).join('\n')}\n\n감사 체인은 이 서비스의 증거력 자체입니다. 위변조 또는 저장소 손상 가능성을 먼저 배제하세요.\n  GET /v1/requests/{id}/audit/verify 로 상세 확인.`,
    );
  }

  /** ③ 로그인 실패 폭주 — admin:auth 스트림의 창 내 LOGIN_FAILED 집계. */
  private async checkLoginFailures(): Promise<boolean> {
    const threshold = Number(this.config.get<string>('ALERT_LOGIN_FAIL_THRESHOLD') ?? 10);
    const windowMin = Number(this.config.get<string>('ALERT_LOGIN_FAIL_WINDOW_MIN') ?? 10);
    const since = Date.now() - windowMin * 60_000;
    // 전체 스트림(무한 증가) 대신 최신 tail 만 읽는다 — 창(window) 내 임계 판정에 충분(F3).
    // 상한(기본 2000)에 걸릴 만큼 최근 이벤트가 많으면 그 자체로 폭주이므로 판정에 지장 없다.
    const tail = Math.max(threshold * 5, Number(this.config.get<string>('ALERT_LOGIN_TAIL') ?? 2000));
    const entries = await this.store.auditRecent('admin:auth', tail);
    const fails = entries.filter((e) => e.eventType === 'LOGIN_FAILED' && Date.parse(e.occurredAt) >= since);
    if (fails.length < threshold) return false;
    const byIp = fails.reduce<Record<string, number>>((a, e) => {
      const ip = String((e.data as { ip?: string } | undefined)?.ip ?? 'unknown');
      a[ip] = (a[ip] ?? 0) + 1;
      return a;
    }, {});
    const top = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return this.alert.raise(
      'login-failure-burst',
      `콘솔 로그인 실패 ${fails.length}건 / ${windowMin}분`,
      `임계값 ${threshold}건을 넘었습니다(크리덴셜 스터핑 가능성).\n\n상위 출처:\n${top.map(([ip, n]) => `  ${ip}: ${n}건`).join('\n')}\n\n대응: 해당 IP 차단(nginx) · 관리자 비밀번호 회전 · 2FA 적용 여부 확인.`,
    );
  }

  /**
   * ④ 웹훅 DEAD — 재시도 소진분 존재(연동 상대에 결과 미도달).
   *
   * 본문에 **그 주소를 향하는 대기 중 요청 수**를 함께 싣는다. DEAD 건수만 알리면 재발송으로 적체가
   * 0 이 되고 한 시간 뒤 같은 경보가 다시 온다 — 옛 주소가 박힌 요청이 만료·완료될 때마다 새 DEAD 가
   * 태어나기 때문이다(2026-08-08 사고: 16시간 동안 같은 경보 반복, 근본 원인은 대기 요청 47건).
   * 반복의 원인을 첫 통에서 보이게 하는 것이 이 표시의 목적이다.
   */
  private async checkWebhookDead(): Promise<boolean> {
    // OpsService 대신 스토어 직접 조회 — Ops→Scheduler→HealthWatch 순환 의존을 만들지 않기 위해서다
    const deadList = await this.store.webhooksByStatus(['DEAD']); // DEAD 만 푸시다운(F2)
    const dead = deadList.length;
    if (!dead) return false;
    const byTarget = [...deadList.reduce((m, w) => m.set(w.targetUrl, (m.get(w.targetUrl) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const pending = await this.pendingRequestsByCallback(byTarget.map(([url]) => url));
    const pendingTotal = [...pending.values()].reduce((a, b) => a + b, 0);
    const targets = byTarget
      .map(([url, n]) => {
        const waiting = pending.get(url) ?? 0;
        return `  ${url}: DEAD ${n}건${waiting ? ` · ⚠ 대기 중 요청 ${waiting}건이 같은 주소를 향합니다` : ''}`;
      })
      .join('\n');
    const rootCause = pendingTotal
      ? '\n\n⚠ 대기 중 요청이 같은 주소를 가리키고 있습니다 — 재발송만 하면 그 요청들이 만료·완료될 때마다 DEAD 가 다시 태어나고 이 경보도 반복됩니다.\n' +
        '  ① 먼저 주소를 정정: POST /v1/maintenance/callback-retarget {"fromUrl":"옛 주소","toUrl":"새 주소","dryRun":true} 로 대상 확인 후 dryRun:false\n' +
        '  ② 그다음 재발송: POST /v1/maintenance/webhook-redrive {"targetUrl":"옛 주소","newTargetUrl":"새 주소"}'
      : '';
    return this.alert.raise(
      'webhook-dead',
      `웹훅 DEAD ${dead}건 — 연동처에 결과 미도달${pendingTotal ? ` (대기 요청 ${pendingTotal}건 동일 주소)` : ''}`,
      `재시도가 소진된 웹훅이 있습니다.\n\n수신처:\n${targets}${rootCause}\n\n대응: 수신처 복구 후 재발송(POST /v1/maintenance/webhook-redrive) 또는 폐지된 수신처면 폐기(POST /v1/maintenance/webhook-discard, 사유 필수).`,
    );
  }

  /**
   * 주어진 수신 주소별로 **아직 통지가 남은 요청**(CREATED·IN_PROGRESS) 수를 센다.
   * 통지의 targetUrl 은 요청 callbackUrl 의 사본이므로 정확일치로 비교한다.
   */
  private async pendingRequestsByCallback(urls: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(urls.map((u) => [u, 0]));
    if (!urls.length) return counts;
    const BATCH = 500;
    let offset = 0;
    for (;;) {
      const { items, total } = await this.store.queryRequests({ incomplete: true, limit: BATCH, offset });
      for (const r of items) {
        const url = r.callbackUrl;
        if (url && counts.has(url)) counts.set(url, (counts.get(url) ?? 0) + 1);
      }
      offset += items.length;
      if (!items.length || items.length < BATCH || offset >= total) break;
    }
    return counts;
  }

  /** ⑤ ready 실패 — DB·CA 이상. */
  private async checkReadiness(): Promise<boolean> {
    const db = await this.store.ping();
    const ca = !!this.ca.issuingCert;
    if (db && ca) return false;
    return this.alert.raise(
      'not-ready',
      `서비스 ready 실패 — db=${db} ca=${ca}`,
      `헬스 준비 점검이 실패했습니다.\n  db: ${db}\n  ca: ${ca}\n\n대응: 컨테이너 상태(docker compose ps)·DB 접속·CA 키 볼트(CRYPTO_MASTER_KEY) 확인.`,
    );
  }
}
