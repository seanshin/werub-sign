// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { CaService } from '../infrastructure/pki/ca.service';
import { isHardened } from '../infrastructure/security/hardening';
import { IntegrationSettingsService } from './integration-settings.service';
import { SchedulerService } from './scheduler.service';
import { AdminUserService } from '../infrastructure/auth/admin-user.service';
import { SessionTokenService } from '../infrastructure/auth/session-token.service';
import { SessionRegistryService } from '../infrastructure/auth/session-registry.service';
import { ADMIN_ROLES } from '../infrastructure/auth/rbac';

/**
 * 운영 가시성 — readiness + 운영 상태(Webhook 적체·요청 현황·CA) + 시스템 구성 모드. ops 가이드 §5.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class OpsService {
  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly ca: CaService,
    private readonly config: ConfigService,
    private readonly settings: IntegrationSettingsService,
    private readonly scheduler: SchedulerService,
    private readonly adminUsers: AdminUserService,
    private readonly sessions: SessionTokenService,
    private readonly sessionRegistry: SessionRegistryService,
  ) {}

  /** 시스템 구성 모드(비밀 제외) — 키 커스터디·HSM·본인인증·발송·저장소 활성 모드 가시화 */
  async systemConfig() {
    const g = (k: string, d = '') => this.config.get<string>(k) ?? d;
    const keyDriver = g('KEY_SIGNER_DRIVER', 'soft');
    // 런타임 설정 스토어 반영(있으면 우선) — 본인인증·발송·키수탁 provider
    const [idv, notifier, hsm] = await Promise.all([
      this.settings.effective('idv'),
      this.settings.effective('notifier'),
      this.settings.effective('hsm'),
    ]);
    return {
      keyCustody: {
        driver: keyDriver, // soft | proxy
        mode: keyDriver === 'proxy' ? 'crypto-proxy(분리)' : g('CRYPTO_KEY_VAULT') ? 'SOFT(FileVault 영속)' : 'SOFT(메모리)',
        hsm: hsm?.provider ?? (keyDriver === 'proxy' ? 'crypto-proxy 백엔드(HSM_PROVIDER는 proxy /stats 참조)' : g('HSM_PROVIDER', 'none')),
        hsmConfigSource: hsm ? 'settings-store(캡처 — 적용은 cutover)' : 'env',
        // HSM 최소화 정책(비용 최적): CA 트러스트 앵커 2키만 HSM, 말단·TSA는 SOFT → 서명/타임스탬프 건당 HSM 비용 0
        hsmScope: 'CA-only(Root·Issuing 2키)',
        leafKeys: 'SOFT', // 말단(환자·의료진 서명)키 — 발급 건당 HSM 미사용
        tsaKeys: 'SOFT', // 자체 TSA 타임스탬프키 — 서명 건당 HSM 미사용(적격TSA는 외부 교체축)
      },
      identity: { driver: g('IDV_DRIVER', 'local'), provider: idv?.provider ?? g('IDV_PROVIDER', 'mock'), source: idv ? 'settings-store' : 'env' }, // local=mock / proxy
      notifier: { provider: notifier?.provider ?? g('NOTIFIER_PROVIDER', 'mock'), source: notifier ? 'settings-store' : 'env' }, // mock | kakao | sms
      store: { driver: g('STORE_DRIVER', 'in-memory') }, // in-memory | file | prisma
      version: process.env.npm_package_version ?? '1.30.1', // 앱 버전(릴리즈마다 함께 올릴 것 — 과거 누락 이력 있음)
      maker: '(주)위루비', // 제작사
      sso: { issuer: g('HIS_SSO_ISSUER'), audience: g('HIS_SSO_AUDIENCE', 'sign'), rolesEnforced: !!g('HIS_SSO_ALLOWED_ROLES') },
      // C-4 다중관리자 RBAC — 로컬 관리자 계정 수·역할(콘솔 인증=세션토큰, 기계키는 별개)
      rbac: { adminUsers: this.adminUsers.count(), roles: [...ADMIN_ROLES] },
      // 콘솔 세션 — 절대 만료(ttl)·비활동 자동 로그아웃(idle, EMR F004)·동시세션 제한(ISMS-P 2.6.3).
      // 서버측 세션 레지스트리가 idle·동시세션·폐기를 강제(클라이언트 의존 아님).
      session: {
        ttlMinutes: this.sessions.ttlMinutes,
        idleTimeoutMinutes: this.sessions.idleTimeoutMinutes, // 0 = idle 비활성(절대 만료만)
        maxConcurrent: this.sessionRegistry.maxConcurrentSessions, // 0 = 무제한
        activeSessions: this.sessionRegistry.activeCount,
        enforcement: 'server', // 서버 강제(가드 매 요청 검증)
      },
      swaggerUi: g('SWAGGER_ENABLED') === 'true' || g('NODE_ENV') !== 'production',
      // §6.1 go-live 하드닝 — 운영(production|SECURITY_HARDENING) 시 H3/H4/M1/M2 활성
      hardening: {
        enabled: isHardened(),
        piiAuth: isHardened(), // H3 PII GET x-api-key 강제
        rateLimitPerMin: isHardened() ? Number(g('RATE_LIMIT_PER_MIN', '120')) : 0, // H4
        securityHeaders: true, // M2 helmet(HSTS는 운영만)
        webhookSsrfGuard: isHardened(), // M1 callbackUrl https+사설망 차단
        webhookAllowedHosts: g('WEBHOOK_ALLOWED_HOSTS') ? g('WEBHOOK_ALLOWED_HOSTS').split(',').length : 0,
      },
      env: g('NODE_ENV', 'development'),
    };
  }

  /**
   * 운영 추세(차트) — 상태 분포·일자별 요청 생성·Webhook 성공률. 인덱스 컬럼(reqCreatedAt) 기반.
   * 현 규모에선 인메모리 집계, 대용량 시 DB GROUP BY 교체 가능.
   */
  async metrics(days = 30) {
    const [requests, webhooks] = await Promise.all([this.store.allRequests(), this.store.listWebhooks()]);
    const count = <T extends { status: string }>(arr: T[]) =>
      arr.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});
    const fromMs = Date.now() - days * 86_400_000;
    const byDay: Record<string, number> = {};
    for (const r of requests) {
      if (!r.createdAt) continue;
      const t = Date.parse(r.createdAt);
      if (Number.isNaN(t) || t < fromMs) continue;
      const day = r.createdAt.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }
    const daily = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, n]) => ({ date, count: n }));
    const wh = count(webhooks);
    // 폐기(DISCARDED)는 운영 판단으로 닫은 건 — 성공률 분모에서 빼야 지표가 조치 대상만 반영한다.
    const whTotal = webhooks.length - (wh['DISCARDED'] ?? 0);
    const sent = wh['SENT'] ?? 0;
    return {
      days,
      statusDistribution: count(requests), // CREATED/IN_PROGRESS/COMPLETED/...
      daily, // [{date, count}] 최근 N일 요청 생성
      requestTotal: requests.length,
      webhooks: {
        total: whTotal,
        sent,
        failed: (wh['FAILED'] ?? 0) + (wh['DEAD'] ?? 0),
        pending: wh['PENDING'] ?? 0,
        successRate: whTotal ? Math.round((sent / whTotal) * 100) : 100,
      },
    };
  }

  /** 컨테이너/오케스트레이션 readiness — DB 도달 + CA 로드 */
  async readiness(): Promise<{ ready: boolean; checks: { db: boolean; ca: boolean } }> {
    const db = await this.store.ping();
    const caLoaded = !!this.ca.issuingCert;
    return { ready: db && caLoaded, checks: { db, ca: caLoaded } };
  }

  /** 운영 상태 — Webhook 적체·요청 상태 분포·CA 시리얼. 단기 캐시(통계 전체로드 부하 완화). */
  async status() {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.at < OpsService.STATUS_TTL_MS) return this.statusCache.value;
    const value = await this.computeStatus();
    this.statusCache = { at: now, value };
    return value;
  }

  private statusCache: { at: number; value: Awaited<ReturnType<OpsService['computeStatus']>> } | null = null;
  private static readonly STATUS_TTL_MS = 5_000; // 동시 조회·폴링 시 전체로드 N배 방지

  private async computeStatus() {
    const [webhooks, requests] = await Promise.all([this.store.listWebhooks(), this.store.allRequests()]);
    const count = <T extends { status: string }>(arr: T[]) =>
      arr.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});
    return {
      webhooks: {
        total: webhooks.length,
        ...count(webhooks), // PENDING/SENT/FAILED/DEAD/DISCARDED(운영자 폐기)
        // 안전장치 — 어떤 수신 주소가 죽어 있는지(경로 변경·장애) 콘솔에서 바로 보이도록 상위 5개
        deadTargets: [...webhooks.filter((w) => w.status === 'DEAD').reduce((m, w) => m.set(w.targetUrl, (m.get(w.targetUrl) ?? 0) + 1), new Map<string, number>())]
          .map(([targetUrl, count]) => ({ targetUrl, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
      },
      requests: { total: requests.length, ...count(requests) }, // CREATED/IN_PROGRESS/COMPLETED/...
      ca: { issuingSerial: this.ca.issuingCert?.tbs.serialNumber, rootSerial: this.ca.rootCert?.tbs.serialNumber },
      config: await this.systemConfig(), // 키커스터디·HSM·IDV·발송·저장소 모드(비밀 제외)
      scheduler: this.scheduler.status(), // 인앱 배치 스케줄러(webhook-retry·expire)
      generatedAt: new Date().toISOString(),
    };
  }
}
