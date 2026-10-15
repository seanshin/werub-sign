// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';
import { WebhookDelivery } from '../../domain/types/store.types';
import { AuditChainService } from '../audit/audit-chain.service';
import { isHardened, validateCallbackUrl } from '../security/hardening';

const MAX_ATTEMPTS = 8; // 초과 시 DEAD(조회/수동 reconcile 대상)

/**
 * Webhook Outbox — sign → Hospital RUN (design §4.3 / FR-08).
 * HMAC 서명 + eventId 멱등. **실패 시 재시도 배치**(retryPending)로 유실 방지.
 * conventions §6: Webhook 보안.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class WebhookOutboxService {
  private readonly logger = new Logger('WebhookOutbox');

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly config: ConfigService,
    private readonly audit: AuditChainService,
  ) {}

  /** 전송 중(in-flight) 항목 — 최초 전송과 재시도 배치(스케줄러 catch-up)가 겹칠 때 중복 전송 방지. */
  private readonly inFlight = new Set<string>();

  private secret(): string {
    return this.config.get<string>('HIS_WEBHOOK_SECRET') ?? this.missing('HIS_WEBHOOK_SECRET');
  }

  /** 공개판: 운영(하드닝)에서는 알려진 개발용 값이나 다른 소비자의 시크릿으로 대신 서명하지 않는다. */
  private missing(envName: string): string {
    if (isHardened()) throw new Error(`${envName} 미설정 — 웹훅을 서명하지 않습니다(PUBLIC-EDITION.md)`);
    return 'dev-secret';
  }

  /**
   * 전달 건별 서명 시크릿 — **최초 전송과 동일한 소비자 시크릿**으로 재시도·재발송한다.
   * 종전에는 항상 HIS 시크릿으로 재서명해, ERP·edu 등 다른 소비자 대상 재시도가 서명 불일치로 거부됐다.
   */
  private async secretOf(d: WebhookDelivery): Promise<string> {
    if (d.secretEnv) return this.config.get<string>(d.secretEnv) ?? (d.secretEnv === 'HIS_WEBHOOK_SECRET' ? this.secret() : this.missing(d.secretEnv));
    // 구 레코드(secretEnv 미보유) — 요청 출처(createdBy)로 `<소비자>_WEBHOOK_SECRET` 복원
    const req = await this.store.getRequest(d.requestId).catch(() => null);
    const key = (req?.createdBy ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const envName = key ? `${key}_WEBHOOK_SECRET` : 'HIS_WEBHOOK_SECRET';
    return this.config.get<string>(envName) ?? (['', 'HOSPITALRUN', 'CONSOLE', 'PACS'].includes(key) ? this.secret() : this.missing(envName));
  }

  /** 재시도 시에도 동일 바이트가 되도록 결정적 body 재구성(eventId 포함) */
  private buildBody(d: WebhookDelivery): string {
    return JSON.stringify({ ...(d.payload as object), eventId: d.eventId, eventType: d.eventType });
  }

  async enqueueAndDeliver(params: {
    requestId: string;
    eventType: string;
    payload: Record<string, unknown>;
    targetUrl: string;
    secret: string;
    secretEnv?: string; // 재시도·재발송이 같은 시크릿으로 서명하도록 이름을 보관(값은 미저장)
  }): Promise<void> {
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      eventId: randomUUID(),
      requestId: params.requestId,
      eventType: params.eventType,
      targetUrl: params.targetUrl,
      payload: params.payload,
      hmac: '',
      status: 'PENDING',
      attempts: 0,
      secretEnv: params.secretEnv,
    };
    await this.store.saveWebhook(delivery);
    await this.attempt(delivery, params.secret);
  }

  /**
   * 실패/대기 건 재시도 — 크론/유지보수 엔드포인트가 주기 호출.
   * 현재 시크릿으로 HMAC 재계산(회전 대응). 최대 시도 초과 시 DEAD.
   */
  async retryPending(): Promise<{ retried: number; sent: number; dead: number; remaining: number }> {
    const targets = await this.store.webhooksByStatus(['PENDING', 'FAILED']); // 전량 스캔 대신 상태 푸시다운(F2)
    let sent = 0,
      dead = 0,
      remaining = 0;
    for (const snap of targets) {
      if (this.inFlight.has(snap.id)) { remaining++; continue; } // 최초 전송 진행 중 — 중복 전송 방지(다음 주기 재평가)
      // 스냅샷 이후 다른 경로(최초 전송·재발송)가 이미 전송을 끝냈을 수 있다 — 최신 상태를 다시 읽어
      // PENDING/FAILED 가 아니면 건너뛴다(stale 스냅샷 기반 재전송·레코드 덮어쓰기 방지).
      const d = await this.store.getWebhook(snap.id);
      if (!d || (d.status !== 'PENDING' && d.status !== 'FAILED')) continue; // 이미 다른 경로가 종결 — 재전송 안 함
      if (d.attempts >= MAX_ATTEMPTS) {
        d.status = 'DEAD';
        await this.store.updateWebhook(d);
        dead++;
        continue;
      }
      await this.attempt(d, await this.secretOf(d));
      // attempt() 가 d.status 를 갱신하지만 TS 는 위 가드로 'PENDING'|'FAILED' 로 좁혀 두므로 명시 캐스트
      const after = d.status as WebhookDelivery['status'];
      if (after === 'SENT') sent++;
      else if (after === 'DEAD') dead++;
      else remaining++;
    }
    if (dead) this.deadCache = null; // 새 DEAD 발생 — 캐시 무효화
    if (targets.length) this.logger.log(`webhook 재시도 ${targets.length}건 → 성공 ${sent}·DEAD ${dead}·잔여 ${remaining}`);
    return { retried: targets.length, sent, dead, remaining };
  }

  // DEAD 대상 URL 집계 캐시 — 요청 생성마다 전량 스캔하지 않도록 짧게 캐시(운영 경고용)
  private deadCache: { at: number; map: Map<string, number> } | null = null;

  /** 수신 URL별 DEAD 건수 — 콘솔 표시·요청 생성 시 경고 판정에 사용(60초 캐시). */
  async deadTargetCounts(maxAgeMs = 60_000): Promise<Map<string, number>> {
    const now = Date.now();
    if (this.deadCache && now - this.deadCache.at < maxAgeMs) return this.deadCache.map;
    const map = new Map<string, number>();
    for (const d of await this.store.webhooksByStatus(['DEAD'])) { // DEAD 만 푸시다운(F2)
      map.set(d.targetUrl, (map.get(d.targetUrl) ?? 0) + 1);
    }
    this.deadCache = { at: now, map };
    return map;
  }

  /**
   * 이 수신 주소로 이미 전송이 사망(DEAD)한 이력 수 — 0 이면 정상.
   * 호출자가 넘긴 `callbackUrl` 을 임의로 바꾸지는 않고, **경고만** 하기 위한 판정(안전장치).
   */
  async deadCountFor(targetUrl?: string): Promise<number> {
    if (!targetUrl) return 0;
    return (await this.deadTargetCounts()).get(targetUrl) ?? 0;
  }

  /**
   * 이 주소(부분일치)를 물고 있는 **아직 끝나지 않은** 통지 수 — 요청 주소를 정정한 뒤 남는 잔여를 알린다.
   * 이미 만들어진 통지에는 발송 시점의 targetUrl 이 박혀 있어 요청을 고쳐도 따라오지 않는다:
   *  - pending(PENDING·FAILED) = 자동 재시도가 계속 옛 주소로 간다 → 결국 DEAD 가 된다
   *  - dead = 재시도 소진 → `redriveDead({ newTargetUrl })` 로만 구제된다
   */
  async openCountsFor(urlPart: string): Promise<{ pending: number; dead: number }> {
    const hit = (await this.store.webhooksByStatus(['PENDING', 'FAILED', 'DEAD'])) // 종결 상태(SENT·DISCARDED) 제외 푸시다운(F2)
      .filter((d) => (d.targetUrl ?? '').includes(urlPart));
    return {
      pending: hit.filter((d) => d.status === 'PENDING' || d.status === 'FAILED').length,
      dead: hit.filter((d) => d.status === 'DEAD').length,
    };
  }

  /** DEAD 적체 목록 — 재발송 전 대상·수신 URL 확인용(페이로드는 제외, 요약만). */
  async listDead(targetUrl?: string): Promise<Array<{ id: string; requestId: string; eventType: string; targetUrl: string; attempts: number; lastAttempt?: string }>> {
    return (await this.store.webhooksByStatus(['DEAD'])) // DEAD 만 푸시다운(F2)
      .filter((d) => !targetUrl || (d.targetUrl ?? '').includes(targetUrl))
      .map((d) => ({ id: d.id, requestId: d.requestId, eventType: d.eventType, targetUrl: d.targetUrl, attempts: d.attempts, lastAttempt: d.lastAttempt }));
  }

  /**
   * DEAD 건 재발송(re-drive) — 수신 측 장애·경로 오류로 재시도가 소진된 건을 **운영자 판단**으로 되살린다.
   * 자동 재시도 대상이 아니므로(상한 소진) 명시 호출로만 동작하며, 시도 횟수를 0 으로 되돌리고
   * 현재 시크릿으로 HMAC 를 재계산해 재전송한다(시크릿 회전 후에도 유효). eventId 는 보존 —
   * 수신 측이 멱등 처리하면 중복 반영되지 않는다.
   * 필터: requestId·targetUrl 부분일치·최대 건수(기본 100). 실패 건은 다시 상한까지 재시도된다.
   */
  async redriveDead(filter: { requestId?: string; targetUrl?: string; limit?: number; newTargetUrl?: string } = {}): Promise<{
    matched: number; requeued: number; sent: number; failed: number; ids: string[];
  }> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    // 재지정 주소도 요청 생성과 동일한 SSRF 검증을 거친다 — 이 경로만 검증을 건너뛰면
    // 인증된 호출자가 통지를 사설망/메타데이터 주소로 돌릴 수 있다(createRequest·retarget 와 정합).
    if (filter.newTargetUrl) {
      try {
        validateCallbackUrl(filter.newTargetUrl);
      } catch (e) {
        throw new BadRequestException(`newTargetUrl 검증 실패: ${(e as Error).message}`);
      }
    }
    const all = await this.store.webhooksByStatus(['DEAD']); // DEAD 만 푸시다운(F2)
    const matched = all.filter(
      (d) =>
        (!filter.requestId || d.requestId === filter.requestId) &&
        (!filter.targetUrl || (d.targetUrl ?? '').includes(filter.targetUrl)),
    );
    const targets = matched.slice(0, limit);
    let sent = 0, failed = 0;
    const ids: string[] = [];
    for (const snap of targets) {
      if (this.inFlight.has(snap.id)) continue; // 다른 경로가 전송 중 — 이번 회차 제외
      // 스냅샷 이후 상태가 바뀌었을 수 있다(재발송·폐기) — 최신을 다시 읽어 DEAD 인 건만 되살린다.
      const d = await this.store.getWebhook(snap.id);
      if (!d || d.status !== 'DEAD') continue;
      // 수신 경로가 바뀐 경우(수신 측 URL 변경) 저장된 옛 주소로는 영원히 실패하므로 재지정 허용
      if (filter.newTargetUrl) {
        this.logger.log(`webhook 재지정 ${d.id}: ${d.targetUrl} → ${filter.newTargetUrl}`);
        d.targetUrl = filter.newTargetUrl;
      }
      d.attempts = 0;
      d.status = 'PENDING';
      await this.store.updateWebhook(d);
      ids.push(d.id);
      await this.attempt(d, await this.secretOf(d));
      // attempt() 가 d.status 를 갱신하지만 TS 는 위 대입('PENDING')으로 좁혀 두므로 명시 캐스트
      const after = d.status as WebhookDelivery['status'];
      if (after === 'SENT') sent++;
      else failed++;
    }
    this.deadCache = null; // 적체 변동 — 캐시 무효화
    this.logger.log(`webhook DEAD 재발송 ${targets.length}건 → 성공 ${sent}·실패 ${failed}(대상 ${matched.length}건)`);
    return { matched: matched.length, requeued: ids.length, sent, failed, ids };
  }

  /**
   * DEAD 건 **폐기(discard)** — 수신처 자체가 없어진 건(경로 폐지·시스템 철수)은 재발송해도 영원히 실패한다.
   * 이런 건을 DEAD 로 남겨두면 신규 요청 생성 시 "이 주소로 실패 이력 N건" 경고가 계속 뜨고,
   * 적체 목록이 실제 조치 대상과 섞인다. 그래서 **레코드를 지우지 않고** 상태만 `DISCARDED` 로 바꿔
   * 재발송·경고 판정에서 제외하고 이력은 보존한다(누가·언제·왜 를 함께 기록).
   *
   * 되살릴 일이 생기면 폐기 사유가 해소된 뒤 `newTargetUrl` 을 지정해 새로 발송하는 것이 맞다
   * (폐기 자체가 "이 수신처로는 보내지 않는다"는 운영 판단이므로 되돌리기는 의도적으로 제공하지 않는다).
   */
  async discardDead(filter: { requestId?: string; targetUrl?: string; limit?: number; reason: string; actor?: string }): Promise<{
    matched: number; discarded: number; ids: string[];
  }> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    const all = await this.store.webhooksByStatus(['DEAD']); // DEAD 만 푸시다운(F2)
    const matched = all.filter(
      (d) =>
        (!filter.requestId || d.requestId === filter.requestId) &&
        (!filter.targetUrl || (d.targetUrl ?? '').includes(filter.targetUrl)),
    );
    const targets = matched.slice(0, limit);
    const at = new Date().toISOString();
    const actor = filter.actor ?? '-';
    const ids: string[] = [];
    for (const d of targets) {
      if (this.inFlight.has(d.id)) continue; // 재발송이 진행 중 — 결과가 확정된 뒤에 판단
      d.status = 'DISCARDED';
      d.discardedAt = at;
      d.discardedBy = actor;
      d.discardReason = filter.reason;
      await this.store.updateWebhook(d);
      ids.push(d.id);
      // 요청 감사 스트림에 봉인 — 통지가 끝내 전달되지 않았다는 사실과 그 처리 근거를 남긴다.
      await this.audit
        .appendSerialized(d.requestId, async () => {
          const prev = await this.store.lastAudit(d.requestId);
          const entry = this.audit.next(
            prev,
            'WEBHOOK_DISCARDED',
            { actorType: 'OPERATOR', actor, webhookId: d.id, eventType: d.eventType, targetUrl: d.targetUrl, attempts: d.attempts, reason: filter.reason },
            at,
          );
          await this.store.appendAudit(d.requestId, entry);
        })
        .catch((e) => this.logger.warn(`webhook 폐기 감사 기록 실패 ${d.id}: ${(e as Error).message}`));
    }
    this.deadCache = null; // 적체 변동 — 경고 판정 캐시 무효화
    this.logger.log(`webhook DEAD 폐기 ${ids.length}건(대상 ${matched.length}건) 사유="${filter.reason}" 처리자=${actor}`);
    return { matched: matched.length, discarded: ids.length, ids };
  }

  private async attempt(d: WebhookDelivery, secret: string): Promise<void> {
    this.inFlight.add(d.id);
    try {
      await this.attemptInner(d, secret);
    } finally {
      this.inFlight.delete(d.id);
    }
  }

  private async attemptInner(d: WebhookDelivery, secret: string): Promise<void> {
    const body = this.buildBody(d);
    d.hmac = createHmac('sha256', secret).update(body).digest('hex');
    d.attempts += 1;
    d.lastAttempt = new Date().toISOString();
    try {
      const res = await fetch(d.targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sign-Signature': d.hmac },
        body,
        redirect: 'error', // 리다이렉트 추종 시 검증한 주소를 벗어난다(사설망/메타데이터로의 SSRF 우회 차단)
      });
      d.status = res.ok ? 'SENT' : 'FAILED';
      if (res.ok) this.logger.log(`webhook 전송 성공 ${d.eventType} → ${d.targetUrl} (HTTP ${res.status})`);
      else this.logger.warn(`webhook 전송 실패 HTTP ${res.status} (시도 ${d.attempts}/${MAX_ATTEMPTS})`);
    } catch (e) {
      d.status = 'FAILED';
      this.logger.warn(`webhook 전송 예외 (시도 ${d.attempts}/${MAX_ATTEMPTS}): ${(e as Error).message}`);
    }
    if (d.status === 'FAILED' && d.attempts >= MAX_ATTEMPTS) d.status = 'DEAD';
    await this.store.updateWebhook(d);
  }
}
