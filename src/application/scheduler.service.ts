// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookOutboxService } from '../infrastructure/webhook/webhook-outbox.service';
import { SignatureRequestService } from './signature-request.service';
import { PortalDocumentService } from './portal-document.service';
import { ContractService } from './contract.service';
import { ContractAttachmentService } from './contract-attachment.service';
import { AuditAnchorService } from './audit-anchor.service';
import { HealthWatchService } from './health-watch.service';

/**
 * 인앱 스케줄러 — Webhook 재시도·만료 배치를 주기 자동 실행(C-1 운영 갭 해소).
 * 기존엔 /v1/maintenance/{webhook-retry,expire} 엔드포인트만 있고 호출 주체가 외부 크론(HIS/ops) 위임이라
 * 단독 배포 시 실패 Webhook 미재시도·기한경과 요청 미만료였다.
 *
 * 멱등(retryPending/expireOverdue는 상태기반)이라 외부 크론과 중복돼도 무해. 멀티 인스턴스 배포 시
 * 복제본에서 SCHEDULER_ENABLED=false 로 중복 실행 억제 권장(또는 단일 워커만 활성).
 *  - SCHEDULER_ENABLED (기본 true, 'false'면 비활성 — 외부 크론 사용 시)
 *  - SCHEDULER_WEBHOOK_RETRY_MIN (기본 5분)
 *  - SCHEDULER_EXPIRE_MIN (기본 60분)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Scheduler');
  private timers: NodeJS.Timeout[] = [];
  // 실행 중인 잡 이름 — setInterval 이 이전 실행보다 빨리 재발화(느린 SMTP/네트워크로 지연)해도
  // 같은 잡이 겹쳐 돌지 않게 한다. 겹침은 리마인더·웹훅 이중 발송의 원인(2026-08-07 실측).
  private readonly inFlight = new Set<string>();

  /** 동일 잡의 재진입 차단 — 진행 중이면 이번 틱은 건너뛴다(다음 틱에 이어서). */
  private async once(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(name)) {
      this.log.debug?.(`${name}: 이전 실행이 진행 중 — 이번 틱 건너뜀`);
      return;
    }
    this.inFlight.add(name);
    try {
      await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }
  enabled = false;
  retryMin = 5;
  expireMin = 60;
  contractMin = 60;
  anchorMin = 1440; // 앵커 스윕(S1-2) — 기본 일 1회
  watchMin = 5; // 능동 감시(S9) — 기본 5분, 0 이면 비활성

  constructor(
    private readonly webhook: WebhookOutboxService,
    private readonly requests: SignatureRequestService,
    private readonly docs: PortalDocumentService,
    private readonly contracts: ContractService,
    private readonly attachments: ContractAttachmentService,
    private readonly anchor: AuditAnchorService,
    private readonly watch: HealthWatchService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.enabled = this.config.get<string>('SCHEDULER_ENABLED') !== 'false';
    // 운영은 정수 분(기본 5/60). 하한 0.02분(=1.2s)은 0/음수 방지·테스트 단주기 허용용.
    this.retryMin = Math.max(0.02, Number(this.config.get<string>('SCHEDULER_WEBHOOK_RETRY_MIN') ?? 5));
    this.expireMin = Math.max(0.02, Number(this.config.get<string>('SCHEDULER_EXPIRE_MIN') ?? 60));
    if (!this.enabled) {
      this.log.log('스케줄러 비활성(SCHEDULER_ENABLED=false) — 외부 크론으로 webhook-retry·expire 호출 필요');
      return;
    }
    this.contractMin = Math.max(0.02, Number(this.config.get<string>('SCHEDULER_CONTRACT_MIN') ?? 60));
    this.anchorMin = Math.max(0.02, Number(this.config.get<string>('SCHEDULER_ANCHOR_MIN') ?? 1440));
    const t1 = setInterval(() => void this.runRetry(), this.retryMin * 60_000);
    const t2 = setInterval(() => void this.runExpire(), this.expireMin * 60_000);
    const t3 = setInterval(() => void this.runContracts(), this.contractMin * 60_000);
    const t4 = setInterval(() => void this.runAnchorSweep(), this.anchorMin * 60_000);
    // 능동 감시(S9) — 0 이면 타이머를 만들지 않는다(명시적 비활성)
    this.watchMin = Math.max(0, Number(this.config.get<string>('SCHEDULER_WATCH_MIN') ?? 5));
    if (this.watchMin > 0) {
      const t5 = setInterval(() => void this.runWatch(), this.watchMin * 60_000);
      t5.unref?.();
      this.timers.push(t5);
    }
    t1.unref?.();
    t2.unref?.(); // 종료를 막지 않도록
    t3.unref?.();
    t4.unref?.();
    this.timers.push(t1, t2, t3, t4);
    // 재기동 직후 1회 catch-up — 다운 동안 쌓인 실패 Webhook·기한경과 요청을 즉시 처리.
    const t0 = setTimeout(() => { void this.runRetry(); void this.runExpire(); }, 1500);
    t0.unref?.();
    // 앵커 catch-up 은 별도 지연 — 기동 직후 부하와 겹치지 않게, 미앵커 스트림(관리 스트림 등)을 1회 보충
    const t0a = setTimeout(() => void this.runAnchorSweep(), 10_000);
    t0a.unref?.();
    this.timers.push(t0, t0a);
    this.log.log(`스케줄러 활성 — webhook-retry ${this.retryMin}분 / expire ${this.expireMin}분 (+ 기동 catch-up)`);
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
  }

  async runRetry(): Promise<void> {
    return this.once('retry', async () => {
      try {
        const r = await this.webhook.retryPending();
        if (r.retried) this.log.log(`webhook-retry: 재시도 ${r.retried}, 성공 ${r.sent}, DEAD ${r.dead}, 잔여 ${r.remaining}`);
      } catch (e) {
        this.log.error(`webhook-retry 실패: ${(e as Error).message}`);
      }
    });
  }

  async runExpire(): Promise<void> {
    return this.once('expire', async () => {
    try {
      const r = await this.requests.expireOverdue();
      if (r.expired) this.log.log(`expire: ${r.expired}건 만료 처리`);
    } catch (e) {
      this.log.error(`expire 실패: ${(e as Error).message}`);
    }
    // 포털 문서 보존 sweep — 종료 상태·TTL 경과 문서 파기(설계 §3.3, PHI 최소화).
    try {
      const d = await this.docs.sweep();
      if (d.purged) this.log.log(`doc-sweep: ${d.purged}건 문서 파기`);
    } catch (e) {
      this.log.error(`doc-sweep 실패: ${(e as Error).message}`);
    }
    // 계약 첨부 보존 sweep(D7) — 기본 미동작(영구 보관). CONTRACT_ATTACH_RETAIN_DAYS 설정 시에만 종결 계약 대상.
    try {
      const a = await this.attachments.sweep();
      if (a.purged) this.log.log(`attach-sweep: ${a.purged}건 첨부 파기(보존연한 경과)`);
    } catch (e) {
      this.log.error(`attach-sweep 실패: ${(e as Error).message}`);
    }
    });
  }

  /**
   * 앵커 스윕(보안 S1-2) — 전 감사 스트림 head 를 자체+외부 TSA 로 봉인.
   * 이벤트 구동 앵커가 없는 관리 스트림(admin:auth 등)은 이 잡이 유일한 앵커 경로다.
   */
  async runAnchorSweep(): Promise<void> {
    return this.once('anchor', async () => {
      try {
        const r = await this.anchor.sweep();
        if (r.anchored) this.log.log(`anchor-sweep: ${r.scanned}개 스트림 중 ${r.anchored}건 앵커${r.skippedByCap ? `, 이월 ${r.skippedByCap}` : ''}`);
      } catch (e) {
        this.log.error(`anchor-sweep 실패: ${(e as Error).message}`);
      }
    });
  }

  /** 능동 감시(보안 S9) — 백업 신선도·감사체인·로그인 실패 폭주·웹훅 DEAD·ready 를 점검해 알림. */
  async runWatch(): Promise<void> {
    return this.once('watch', async () => {
      try {
        const r = await this.watch.runAll();
        if (r.alerts) this.log.warn(`health-watch: ${r.checked}개 점검 중 ${r.alerts}건 알림 발생`);
      } catch (e) {
        this.log.error(`health-watch 실패: ${(e as Error).message}`);
      }
    });
  }

  /** 계약 자동 리마인더 — 미서명 독촉·만료 임박 경고(GENERAL_CONTRACTS 비활성 시 no-op). */
  async runContracts(): Promise<void> {
    return this.once('contracts', async () => {
      try {
        const r = await this.contracts.autoRemind();
        if (r.reminded || r.expiryWarned) this.log.log(`contract-remind: 독촉 ${r.reminded}, 만료경고 ${r.expiryWarned}, 스킵 ${r.skipped}`);
      } catch (e) {
        this.log.error(`contract-remind 실패: ${(e as Error).message}`);
      }
    });
  }

  status(): { enabled: boolean; webhookRetryMin: number; expireMin: number; contractRemindMin: number } {
    return { enabled: this.enabled, webhookRetryMin: this.retryMin, expireMin: this.expireMin, contractRemindMin: this.contractMin };
  }
}
