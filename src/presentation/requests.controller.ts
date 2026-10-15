// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Header, NotFoundException, Param, Post, Put, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { setDocResponseHeaders, FramableRes } from './document-headers';
import { parsePage, parseSearch, parseDateRange, paginate } from './pagination';
import { SignatureRequestService } from '../application/signature-request.service';
import { AuditCertificateService } from '../application/audit-certificate.service';
import { PortalDocumentService } from '../application/portal-document.service';
import { NotifyService } from '../application/notify.service';
import { WebhookOutboxService } from '../infrastructure/webhook/webhook-outbox.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ProdApiKeyAuth } from './guards/prod-api-key.guard';
import { CreateRequestDto, SubmitDto, WithdrawDto, NotifyDto, SupersedeDto, WebhookRedriveDto, WebhookDiscardDto, BackupHeartbeatDto, CallbackRetargetDto } from './dto';
import { HealthWatchService } from '../application/health-watch.service';
import { ApiTags } from '@nestjs/swagger';
import { PublicApi } from './api-auth.decorators';

/** 서명요청·서명·검증 — FR-07/08, design §4 */
@ApiTags('서명요청(연동 API)')
@Controller('v1')
export class RequestsController {
  constructor(
    private readonly svc: SignatureRequestService,
    private readonly auditCert: AuditCertificateService,
    private readonly docs: PortalDocumentService,
    private readonly notify: NotifyService,
    private readonly webhook: WebhookOutboxService,
    private readonly watch: HealthWatchService,
  ) {}

  /**
   * 서명 대상 문서 업로드(caller) — 포털 미리보기용(설계 Option A). application/pdf 원본 바이트.
   * SHA-256 == documentHash 검증(불일치 422)·%PDF 형식(415)·크기 상한(413) 후 AES-256-GCM 봉인 저장.
   * caller 기계키는 업로드만(되읽기 불가). 기능 비활성(기본) 시 404.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
   */
  @Put('requests/:id/document')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async uploadDocument(@Param('id') id: string, @Req() req: { body?: Buffer; headers: Record<string, string | undefined> }) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await this.docs.save(id, bytes, req.headers['content-type'] ?? 'application/pdf', new Date().toISOString());
    return { data: { requestId: id, ...r } };
  }

  /** 관리자 문서 검토(RBAC documents:read) — 콘솔 요청 상세에서 서명 대상 PDF 열람. */
  @Get('requests/:id/document')
  @UseGuards(ApiKeyGuard)
  @RequireScope('documents:read')
  async getDocument(@Param('id') id: string, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const doc = await this.docs.fetch(id);
    if (!doc) throw new NotFoundException('저장된 문서가 없습니다(미업로드 또는 파기됨)');
    setDocResponseHeaders(res, 'consent-document.pdf'); // inline·no-store·nosniff·크로스오리진 프레이밍 허용
    return new StreamableFile(doc.bytes, { type: doc.contentType });
  }

  /**
   * 서명요청 생성 — 연동의 시작점. 문서 해시(`documentHash`)와 참가자(서명 순서·인증서·본인확인 수준)를 등록한다.
   * `idempotencyKey` 로 재시도 안전(같은 키는 같은 요청을 돌려준다). 완료 시 `callbackUrl` 로 webhook 통지.
   */
  @Post('requests')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async create(@Body() dto: CreateRequestDto, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.svc.createRequest({ ...dto, createdBy: req.consumerApp?.name }) };
  }

  /** 동의 철회 (FR-13) */
  @Post('requests/:id/withdraw')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async withdraw(@Param('id') id: string, @Body() dto: WithdrawDto) {
    return { data: await this.svc.withdraw(id, dto?.reason) };
  }

  /** C-2 문서 개정 재동의 — 원본을 새 버전으로 대체(supersede) */
  @Post('requests/:id/supersede')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async supersede(@Param('id') id: string, @Body() dto: SupersedeDto, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.svc.supersede(id, { ...dto, createdBy: req.consumerApp?.name }) };
  }

  /** 발송 — 참가자별 서명 링크 전송 (FR-10) */
  @Post('requests/:id/notify')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async notifyRequest(@Param('id') id: string, @Body() dto: NotifyDto) {
    return { data: await this.notify.notifyRequest(id, dto.baseUrl, dto.recipients) };
  }

  /** 발송 이력(요청별) — 연락처 마스킹. 관리 콘솔 요청 상세 */
  @Get('requests/:id/notifications')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async requestNotifications(@Param('id') id: string) {
    return { data: await this.notify.listForRequest(id) };
  }

  /** 발송 이력(전체) — 관리 콘솔 발송 이력 화면 */
  @Get('admin/notifications')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async allNotifications(@Query() q: { limit?: string; offset?: string }) {
    return paginate(await this.notify.listAll(), parsePage(q)); // { data, page }
  }

  /** 발송 이력 CSV 내보내기(심사·보존) — 수신번호 마스킹값만. */
  @Get('admin/notifications/export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="notifications.csv"')
  async exportNotifications() {
    return this.notify.exportCsv();
  }

  /** 만료 배치 — 기한 경과 미완료 요청 EXPIRED 처리 (FR-13, 크론 호출) */
  @Post('maintenance/expire')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async expire() {
    return { data: await this.svc.expireOverdue() };
  }

  /** 포털 문서 보존 sweep — 종료 상태·TTL 경과 문서 파기(PHI 최소화, 스케줄러 병행·수동 호출) */
  @Post('maintenance/document-sweep')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async documentSweep() {
    return { data: await this.docs.sweep() };
  }

  /**
   * 백업 성공 하트비트(보안 S9) — 호스트 cron(`scripts/backup-sign-db.sh`)이 백업 성공 시 호출한다.
   * 앱은 호스트 크론을 볼 수 없으므로 **성공 신호의 부재**로 백업 중단을 판단한다(감시 잡이 노후 시 경보).
   */
  @Post('maintenance/backup-heartbeat')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async backupHeartbeat(@Body() dto: BackupHeartbeatDto) {
    return { data: await this.watch.recordBackupHeartbeat(dto?.note) };
  }

  /**
   * 능동 감시 즉시 실행(보안 S9) — 스케줄러 주기(`SCHEDULER_WATCH_MIN`)와 별개로 지금 점검한다.
   * 점검 결과로 알림이 나가며(임계 초과 시), 알림 실패는 서비스에 영향을 주지 않는다.
   */
  @Post('maintenance/health-watch')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async healthWatch() {
    return { data: await this.watch.runAll() };
  }

  /** Webhook 재시도 배치 — 실패/대기 건 재전송 (유실 방지, 크론 호출) */
  @Post('maintenance/webhook-retry')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async webhookRetry() {
    return { data: await this.webhook.retryPending() };
  }

  /**
   * Webhook **DEAD 재발송** — 수신 측 장애·경로 오류로 재시도가 소진된 건을 운영자 판단으로 되살린다.
   * 자동 배치 대상이 아니므로 명시 호출 전용. 시크릿 회전 후에도 현재 시크릿으로 재서명하며 `eventId` 는 보존
   * (수신 측이 멱등 처리하면 중복 반영 없음). 필터 없이 호출하면 DEAD 전건(최대 limit)이 대상.
   */
  @Post('maintenance/webhook-redrive')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async webhookRedrive(@Body() dto: WebhookRedriveDto) {
    return { data: await this.webhook.redriveDead({ requestId: dto?.requestId, targetUrl: dto?.targetUrl, limit: dto?.limit, newTargetUrl: dto?.newTargetUrl }) };
  }

  /**
   * Webhook **DEAD 폐기** — 수신처가 폐지돼 재발송이 무의미한 건을 적체·경고 대상에서 뺀다.
   * 레코드는 삭제하지 않고 `DISCARDED` 로 바꾸며, 사유·처리자를 요청 감사 스트림에 봉인한다.
   */
  @Post('maintenance/webhook-discard')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async webhookDiscard(@Body() dto: WebhookDiscardDto, @Req() req: { consumerApp?: { name: string } }) {
    return {
      data: await this.webhook.discardDead({
        requestId: dto?.requestId,
        targetUrl: dto?.targetUrl,
        limit: dto?.limit,
        reason: dto.reason,
        actor: req.consumerApp?.name,
      }),
    };
  }

  /**
   * 저장된 요청의 **콜백 주소 재지정** — 연동처가 수신 경로를 바꿨을 때 옛 주소가 박힌 요청을 일괄 정정한다.
   *
   * 웹훅의 `targetUrl` 은 **요청 생성 시점의 `callbackUrl` 사본**이다. 그래서 연동처가 경로를 고쳐도
   * 그 전에 만들어진 요청은 완료·만료될 때마다 옛 주소로 통지를 쏘고 새 DEAD 를 만든다.
   * DEAD 재발송(`webhook-redrive`)이 **이미 태어난 것**을 되살린다면, 이 EP 는 **태어나는 것을 멈춘다** — 둘 다 필요하다.
   *
   * 기본은 모의 실행(`dryRun`) — 대상 수와 표본을 확인한 뒤 `dryRun:false` 로 적용한다.
   * `toUrl` 은 요청 생성과 같은 SSRF 검증을 거치며, 정정은 요청별 감사 스트림에 `CALLBACK_RETARGETED` 로 봉인된다.
   */
  @Post('maintenance/callback-retarget')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async callbackRetarget(@Body() dto: CallbackRetargetDto, @Req() req: { consumerApp?: { name: string } }) {
    return {
      data: await this.svc.retargetCallbacks({
        fromUrl: dto.fromUrl,
        toUrl: dto.toUrl,
        statuses: dto.statuses,
        dryRun: dto.dryRun,
        limit: dto.limit,
        actor: req.consumerApp?.name,
      }),
    };
  }

  /** DEAD 적체 조회 — 재발송 전에 대상·원인(수신 URL)을 확인한다. */
  @Get('maintenance/webhook-dead')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async webhookDead(@Query('targetUrl') targetUrl?: string) {
    const all = await this.webhook.listDead(targetUrl);
    return { data: all };
  }

  /** Webhook 전송 현황 조회 — HIS reconcile (유실·미수신 확인) */
  @Get('requests/:id/webhooks')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async webhooks(@Param('id') id: string) {
    return { data: await this.svc.webhooksOf(id) };
  }

  /** 서명요청 목록 — 검색(`q`)·상태·기간·생성자·서명방식 필터, 페이지네이션. */
  @Get('requests')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async list(@Query() q: { limit?: string; offset?: string; q?: string; status?: string; from?: string; to?: string; days?: string; createdBy?: string; signMode?: string; incomplete?: string }, @Req() req: { consumerApp?: { name: string } }) {
    // 공개판: 연동 소비자 키로 부르면 그 소비자가 만든 요청만 보인다(콘솔 · 관리 키 · 관리자 세션은 전체)
    const own = req.consumerApp && !['console', 'sign-admin'].includes(req.consumerApp.name) ? req.consumerApp.name : undefined;
    const page = parsePage(q);
    const search = parseSearch(q);
    const range = parseDateRange(q);
    // 저장소가 DB 레벨로 필터/정렬/페이지/카운트(대시보드 확장성). { data, page:{total,limit,offset} }
    return this.svc.listRequestsPage({ limit: page.limit, offset: page.offset, q: search?.q, status: search?.status, from: range.from, to: range.to, createdBy: own ?? (q.createdBy || undefined), signMode: q.signMode || undefined, incomplete: q.incomplete === 'true' });
  }

  /** 요청 목록 CSV 내보내기(심사·보존) — 동일 필터 전체. `:id` 라우트보다 먼저 정의(정적 경로 우선). */
  @Get('requests/export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="requests.csv"')
  async exportRequests(@Query() q: { q?: string; status?: string; from?: string; to?: string; days?: string; createdBy?: string; signMode?: string; incomplete?: string }, @Req() req: { consumerApp?: { name: string } }) {
    const own = req.consumerApp && !['console', 'sign-admin'].includes(req.consumerApp.name) ? req.consumerApp.name : undefined; // 공개판: 소비자 격리
    const search = parseSearch(q);
    const range = parseDateRange(q);
    return this.svc.exportRequestsCsv({ q: search?.q, status: search?.status, from: range.from, to: range.to, createdBy: own ?? (q.createdBy || undefined), signMode: q.signMode || undefined, incomplete: q.incomplete === 'true' });
  }

  /** 서명요청 단건 조회 — 상태·참가자별 서명 진행·버전(개정) 정보. H3: PII 상세라 운영에서는 x-api-key 를 강제한다(개발은 통과, verify/ocsp/crl 은 공개 유지). */
  @Get('requests/:id')
  @ProdApiKeyAuth()
  async get(@Param('id') id: string) {
    return { data: await this.svc.getRequest(id) };
  }

  /**
   * 직접 서명 제출 — HIS-facing(모델 A, 서버↔서버 키 보유)만 허용.
   * 환자 진입점은 토큰 경유 POST /v1/portal/:token/sign, STAFF는 /v1/sign/staff(SSO).
   * (C1) 무인증 직접 제출 = 서명 위조 차단을 위해 ApiKeyGuard 필수.
   */
  @Post('sign/:participantId/submit')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async submit(@Param('participantId') participantId: string, @Body() dto: SubmitDto) {
    return { data: await this.svc.submit(participantId, { identity: dto?.identity }) };
  }

  /** 서명 검증 — 서명값·인증서 체인·타임스탬프·감사체인 무결성을 종합 판정(`overall`). 연동·감사 대응의 핵심 엔드포인트. */
  @Get('verify/:requestId')
  @PublicApi()
  async verify(@Param('requestId') requestId: string) {
    return { data: await this.svc.verify(requestId) };
  }

  /** 요청 감사 이력 — append-only 해시체인 엔트리 전체(생성→발송→서명→완료→통지). H3: PII 포함이라 운영에서는 x-api-key 를 강제한다(개발은 통과). */
  @Get('requests/:id/audit')
  @ProdApiKeyAuth()
  async audit(@Param('id') id: string) {
    return { data: await this.svc.auditTrail(id) };
  }

  /** 감사 무결성 검증 (해시체인 + TSA 앵커) — FR-21 */
  @Get('requests/:id/audit/verify')
  @PublicApi()
  async auditVerify(@Param('id') id: string) {
    return { data: await this.svc.auditVerify(id) };
  }

  /** 감사추적인증서 (PAdES 서명 PDF) — FR-05 */
  @Get('requests/:id/audit-certificate')
  @PublicApi()
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'inline; filename="audit-certificate.pdf"')
  async auditCertificate(@Param('id') id: string): Promise<StreamableFile> {
    const pdf = await this.auditCert.generate(id);
    return new StreamableFile(pdf);
  }
}
