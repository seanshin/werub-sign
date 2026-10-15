/**
 * 컴포지션 루트 — 이 파일 하나가 "무엇이 무엇으로 구현되는가"를 전부 결정한다.
 *
 * 읽는 법: 도메인 포트(Symbol 토큰) ↔ 어댑터 매핑이 핵심이다.
 *  - KEY_SIGNER          : soft(인프로세스) | proxy(crypto-proxy 분리) — env KEY_SIGNER_DRIVER
 *  - SIGN_STORE          : in-memory(개발) | file(경량 영속) | prisma(운영 PG) — env STORE_DRIVER
 *  - TSA_PROVIDER        : SelfTsaProvider(자체 TSA — 외부 공인 TSA 는 교체축)
 *  - ANCHOR_EXTERNAL_TSAS: 외부 RFC3161 앵커(S1 이중화) — env ANCHOR_TSA_URLS, 미설정=빈 배열
 *  - IDENTITY_PROVIDER   : mock | remote(idv-proxy) | 런타임 설정형 — 본인확인
 *  - NOTIFIER            : mock | kakao | sms | SMTP — 발송 채널
 *
 * 원칙: application 계층은 이 포트들만 알고, 여기서만 구체 어댑터가 주입된다.
 * 따라서 "운영에서 실제로 뭐가 도는지" 확인할 곳은 이 파일 + .env.prod 두 곳뿐이다
 * (콘솔 /admin/system 의 ops-status 가 같은 정보를 런타임에 노출한다).
 */
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import { isHardened } from './infrastructure/security/hardening';

import { KEY_SIGNER, KeySigner } from './domain/ports/key-signer.port';
import { TSA_PROVIDER } from './domain/ports/tsa-provider.port';
import { SoftKeySigner } from './infrastructure/crypto/soft-key-signer';
import { RemoteKeySigner } from './infrastructure/crypto/remote-key-signer';
import { FileKeyVault } from './infrastructure/crypto/key-vault';
import { SelfTsaProvider } from './infrastructure/tsa/self-tsa.provider';
import { CaService } from './infrastructure/pki/ca.service';
import { AuditChainService } from './infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from './domain/ports/sign-store.port';
import { InMemorySignStore } from './infrastructure/store/in-memory-store';
import { FileSignStore } from './infrastructure/store/file-sign-store';
import { PrismaSignStore } from './infrastructure/store/prisma-sign-store';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SignatureService } from './application/signature.service';
import { EnrollCertificateService } from './application/enroll-certificate.service';
import { SignatureRequestService } from './application/signature-request.service';
import { SchedulerService } from './application/scheduler.service';
import { RevocationService } from './application/revocation.service';
import { WebhookOutboxService } from './infrastructure/webhook/webhook-outbox.service';
import { SsoVerifierService } from './infrastructure/auth/sso-verifier.service';
import { ConsumerAppService } from './infrastructure/auth/consumer-app.service';
import { AdminUserService } from './infrastructure/auth/admin-user.service';
import { SessionTokenService } from './infrastructure/auth/session-token.service';
import { SessionRegistryService } from './infrastructure/auth/session-registry.service';
import { AuthController } from './presentation/auth.controller';
import { AdminUsersController } from './presentation/admin-users.controller';
import { ApiKeyGuard } from './presentation/guards/api-key.guard';
import { ProdApiKeyGuard } from './presentation/guards/prod-api-key.guard';
import { AccessLogInterceptor } from './presentation/access-log.interceptor';
import { IDENTITY_PROVIDER } from './domain/ports/identity-provider.port';
import { MockIdentityProvider } from './infrastructure/identity/mock-identity-provider';
import { RemoteIdentityProvider } from './infrastructure/identity/remote-identity-provider';
import { ConfigurableIdentityProvider } from './infrastructure/identity/configurable-identity-provider';
import { ConfigurableNotifier } from './infrastructure/notify/configurable-notifier';
import { IntegrationSettingsService } from './application/integration-settings.service';
import { SettingsController } from './presentation/settings.controller';
import { PadesSignerService } from './infrastructure/pades/pades-signer.service';
import { AuditCertificateService } from './application/audit-certificate.service';
import { PortalDocumentService } from './application/portal-document.service';
import { AuditAnchorService, ANCHOR_EXTERNAL_TSAS } from './application/audit-anchor.service';
import { AlertService } from './application/alert.service';
import { HealthWatchService } from './application/health-watch.service';
import { ExternalRfc3161Client } from './infrastructure/tsa/external-rfc3161.provider';
import { ApprovalService } from './application/approval.service';
import { ApprovalController } from './presentation/approval.controller';
import { ContractService } from './application/contract.service';
import { ContractAttachmentService } from './application/contract-attachment.service';
import { ContractPresetService } from './application/contract-preset.service';
import { ContractTemplateService } from './application/contract-template.service';
import { ContractAddressbookService } from './application/contract-addressbook.service';
import { ContractController } from './presentation/contract.controller';
import { ContractAddressbookController } from './presentation/contract-addressbook.controller';
import { ApprovalAuditController } from './presentation/approval-audit.controller';
import { WsignDocumentController } from './presentation/wsign-document.controller';
import { CertificatesController } from './presentation/certificates.controller';
import { RequestsController } from './presentation/requests.controller';
import { RevocationController } from './presentation/revocation.controller';
import { StaffSignController } from './presentation/staff-sign.controller';
import { CaAdminController } from './presentation/ca-admin.controller';
import { ConsumerAdminController } from './presentation/consumer-admin.controller';
import { AuditEventController } from './presentation/audit-event.controller';
import { AdminAuditController } from './presentation/admin-audit.controller';
import { OpsController } from './presentation/ops.controller';
import { EventsController } from './presentation/events.controller';
import { SignEventsService } from './application/events.service';
import { OpsService } from './application/ops.service';
import { PortalController } from './presentation/portal.controller';
import { SignRequestsController } from './presentation/sign-requests.controller';
import { PatientTokenService } from './application/patient-token.service';
import { SignRequestFacadeService } from './application/sign-request-facade.service';
import { NotifyService } from './application/notify.service';
import { NOTIFIER } from './domain/ports/notifier.port';
import { MockNotifier } from './infrastructure/notify/mock-notifier';
import { KakaoAlimtalkNotifier, SmsNotifier } from './infrastructure/notify/vendor-notifier';
import { HealthController } from './presentation/health.controller';
import { CspReportController } from './presentation/csp-report.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // H4: rate-limit — 운영(하드닝) 시에만 enforce(개발은 skipIf 통과). portal/sign/verify 포함 전역.
    // 트래커는 req.ip(trust proxy 로 XFF 의 실 클라이언트 IP). 서버↔서버(HIS/PACS 직접호출=nginx 미경유,
    // X-Forwarded-For 부재)는 면제 — 공개(nginx 경유, XFF 보유) 트래픽만 실 IP별 제한.
    // 미면제 시 모든 트래픽이 docker 게이트웨이 단일 IP 버킷으로 수렴 → HIS/PACS 연동 마비.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 120) }],
      skipIf: (ctx) => {
        if (!isHardened()) return true; // 개발/통합 무중단
        const req = ctx.switchToHttp().getRequest();
        // nginx 는 항상 XFF 추가($proxy_add_x_forwarded_for). 부재 = localhost 바인드 포트로의 직접
        // 서버↔서버 호출(HIS/PACS) → 신뢰·면제. localhost 바인드라 외부 직접 도달 불가.
        return !req.headers?.['x-forwarded-for'];
      },
    }),
  ],
  controllers: [HealthController, CspReportController, CertificatesController, RequestsController, RevocationController, StaffSignController, CaAdminController, ConsumerAdminController, AuditEventController, AdminAuditController, PortalController, SignRequestsController, OpsController, EventsController, SettingsController, AuthController, AdminUsersController, ApprovalController, ApprovalAuditController, WsignDocumentController, ContractAddressbookController, ContractController],
  providers: [
    {
      provide: KEY_SIGNER,
      useFactory: (config: ConfigService) => {
        // proxy: 개인키를 crypto-proxy로 분리(앱은 키·HSM SDK 미보유). 운영 권장.
        if (config.get<string>('KEY_SIGNER_DRIVER') === 'proxy') {
          const url = config.get<string>('CRYPTO_PROXY_URL') ?? 'http://localhost:4900';
          const token = config.get<string>('CRYPTO_PROXY_TOKEN') ?? '';
          new Logger('AppModule').log(`KeySigner=proxy(${url}) — 개인키 분리 모드`);
          return new RemoteKeySigner(url, token);
        }
        // soft: 인프로세스 SOFT. 개인키 보관 Vault — CRYPTO_KEY_VAULT 경로 설정 시 File(영속),
        // 미설정 시 메모리(개발). 운영(재기동 후 신규 발급 유지)은 File 또는 proxy 필수.
        let masterKey = config.get<string>('CRYPTO_MASTER_KEY');
        if (!masterKey) {
          if (config.get<string>('NODE_ENV') === 'production') {
            throw new Error('CRYPTO_MASTER_KEY 필수 (production) — 임시 마스터키 가동 방지');
          }
          masterKey = randomBytes(32).toString('base64');
          new Logger('AppModule').warn('CRYPTO_MASTER_KEY 미설정 — 개발용 임시 키 생성(운영 금지)');
        }
        const vaultPath = config.get<string>('CRYPTO_KEY_VAULT');
        if (vaultPath) {
          new Logger('AppModule').log(`KeySigner=soft(FileKeyVault ${vaultPath}) — 키 영속`);
          return new SoftKeySigner(masterKey, new FileKeyVault(vaultPath));
        }
        return new SoftKeySigner(masterKey);
      },
      inject: [ConfigService],
    },
    { provide: TSA_PROVIDER, useFactory: (ks: KeySigner, store: SignStore) => new SelfTsaProvider(ks, store), inject: [KEY_SIGNER, SIGN_STORE] },
    {
      provide: IDENTITY_PROVIDER,
      useFactory: (config: ConfigService, settings: IntegrationSettingsService) => {
        // proxy: 본인확인을 DMZ idv-proxy로 위임(사업자 시크릿 격리). 프록시 자체 env 사용(설정 스토어 비경유).
        if (config.get<string>('IDV_DRIVER') === 'proxy') {
          const url = config.get<string>('IDV_PROXY_URL') ?? 'http://localhost:4920';
          const token = config.get<string>('IDV_PROXY_TOKEN') ?? '';
          new Logger('AppModule').log(`IdentityProvider=proxy(${url}) — 본인확인 분리 모드`);
          return new RemoteIdentityProvider(url, token);
        }
        // local: 설정 스토어 기반(provider·자격증명 런타임 해석, 기본 mock).
        return new ConfigurableIdentityProvider(settings, (config.get<string>('CRYPTO_PEPPER') || (isHardened() ? (() => { throw new Error('CRYPTO_PEPPER 미설정(PUBLIC-EDITION.md)'); })() : 'dev-pepper')), config.get<string>('IDV_PROVIDER') ?? 'mock');
      },
      inject: [ConfigService, IntegrationSettingsService],
    },
    { provide: CaService, useFactory: (ks: KeySigner, store: SignStore) => new CaService(ks, store), inject: [KEY_SIGNER, SIGN_STORE] },
    {
      provide: SignatureService,
      useFactory: (ks: KeySigner, tsa: SelfTsaProvider, ca: CaService) => new SignatureService(ks, tsa, ca),
      inject: [KEY_SIGNER, TSA_PROVIDER, CaService],
    },
    AuditChainService,
    PrismaService,
    {
      // SIGN_STORE 포트 — prisma(운영) / file(durable) / in-memory(개발)
      provide: SIGN_STORE,
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        const driver = config.get<string>('STORE_DRIVER');
        if (driver === 'prisma') return new PrismaSignStore(prisma);
        if (driver === 'file') return new FileSignStore(config.get<string>('STORE_FILE') ?? './data/sign-store.json');
        return new InMemorySignStore();
      },
      inject: [ConfigService, PrismaService],
    },
    EnrollCertificateService,
    SignatureRequestService,
    PatientTokenService,
    SignRequestFacadeService,
    OpsService,
    SignEventsService,
    IntegrationSettingsService,
    SchedulerService,
    NotifyService,
    {
      provide: NOTIFIER,
      useFactory: (config: ConfigService, settings: IntegrationSettingsService) =>
        // 설정 스토어 기반(provider·자격증명 런타임 해석, 기본 mock). env 는 폴백.
        new ConfigurableNotifier(settings, config.get<string>('NOTIFIER_PROVIDER') ?? 'mock'),
      inject: [ConfigService, IntegrationSettingsService],
    },
    RevocationService,
    WebhookOutboxService,
    SsoVerifierService,
    ConsumerAppService,
    AdminUserService,
    SessionTokenService,
    SessionRegistryService,
    ApiKeyGuard,
    ProdApiKeyGuard,
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor }, // 접근 로그(actor·reqId)
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // H4 — skipIf 로 개발 무영향
    PadesSignerService,
    AuditCertificateService,
    PortalDocumentService,
    // 외부 RFC3161 앵커(S1) — ANCHOR_TSA_URLS(쉼표 구분) 미설정이면 빈 배열(자체 TSA 만, 종전 동작)
    {
      provide: ANCHOR_EXTERNAL_TSAS,
      useFactory: (config: ConfigService) =>
        (config.get<string>('ANCHOR_TSA_URLS') ?? '')
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => new ExternalRfc3161Client(u)),
      inject: [ConfigService],
    },
    AuditAnchorService,
    AlertService,
    HealthWatchService,
    ApprovalService,
    ContractService,
    ContractAttachmentService,
    ContractPresetService,
    ContractTemplateService,
    ContractAddressbookService,
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger('AppModule');
  constructor(private readonly ca: CaService) {}

  async onModuleInit(): Promise<void> {
    const { root, issuing } = await this.ca.bootstrap('O=Medical Foundation');
    this.logger.log(`CA bootstrap 완료 — Root=${root.tbs.serialNumber}, Issuing=${issuing.tbs.serialNumber}`);
  }
}
