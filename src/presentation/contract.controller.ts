// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Delete, ForbiddenException, Get, Header, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ContractService, ContractActor } from '../application/contract.service';
import { ContractAttachmentService } from '../application/contract-attachment.service';
import { ContractPresetService } from '../application/contract-preset.service';
import { ContractTemplateService } from '../application/contract-template.service';
import { PortalDocumentService } from '../application/portal-document.service';
import { AuditCertificateService } from '../application/audit-certificate.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { CONTRACT_TEMPLATES_SCOPE } from '../infrastructure/auth/rbac';
import { BadRequestException } from '@nestjs/common';
import { ComposeContractDto, ContractArchiveDto, ContractParticipantEmailDto, ContractCategoryDto, ContractPresetDto, ContractSendDto, ContractSignDto, CreateContractDto, CustomTemplateDto, CustomTemplateUpdateDto, StampContractDto, UpdateSignMarksDto } from './dto';
import { toCsv } from '../domain/csv';
import { parseAuditFilter, filterAudit, auditToCsv } from './audit-filter';
import { parsePage, parseDateRange } from './pagination';
import { setAttachmentResponseHeaders, setDocResponseHeaders, contractFileName, FramableRes } from './document-headers';
import { ApiTags } from '@nestjs/swagger';
import { TokenAuth } from './api-auth.decorators';

/**
 * 일반 전자계약(행정·일반 계약) — general-contracts.design.md §3.2 파사드.
 * 준비(생성·PDF 업로드)→발송(이메일)→체결(내부 서명은 본 EP, 외부는 포털)→관리(계약함·CSV).
 * 플래그 GENERAL_CONTRACTS OFF(기본) 시 서비스가 404. 스코프 contracts:read/write.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('전자계약')
@Controller('v1/contracts')
export class ContractController {
  constructor(
    private readonly svc: ContractService,
    private readonly templates: ContractTemplateService,
    private readonly docs: PortalDocumentService,
    private readonly auditCert: AuditCertificateService,
    private readonly attachments: ContractAttachmentService,
    private readonly presets: ContractPresetService,
  ) {}

  /** 계약 생성 — 콘솔 세션 또는 기계키(HIS/ERP caller). 멱등. */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async create(@Body() dto: CreateContractDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.create({ ...dto, actor: this.callerActor(req) }) };
  }

  /** 계약 원본 PDF 업로드 — SHA-256==documentHash 검증, 계약 트랙은 영구 암호화 보관(D4). */
  @Put(':id/document')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async uploadDocument(@Param('id') id: string, @Req() req: { body?: Buffer; headers: Record<string, string | undefined> }) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await this.docs.save(id, bytes, req.headers['content-type'] ?? 'application/pdf', new Date().toISOString());
    return { data: { requestId: id, ...r } };
  }

  /** 첨부 추가(설계 §11) — 열람용 부속 문서(PDF·PNG·JPEG, 작성 상태 한정). raw body + ?name= (URL 인코딩). */
  @Post(':id/attachments')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async addAttachment(@Param('id') id: string, @Query('name') name: string | undefined, @Req() req: ConsoleReq & { body?: Buffer; headers: Record<string, string | undefined> }) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return { data: await this.attachments.add(id, bytes, req.headers['content-type'] ?? '', name ?? '', this.callerActor(req).actor) };
  }

  /** 첨부 목록. */
  @Get(':id/attachments')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async listAttachments(@Param('id') id: string) {
    return { data: await this.attachments.list(id) };
  }

  /** 첨부 다운로드(콘솔). */
  @Get(':id/attachments/:aid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async getAttachment(@Param('id') id: string, @Param('aid') aid: string, @Res({ passthrough: true }) res: FramableRes, @Req() req: ConsoleReq): Promise<StreamableFile> {
    const actor = this.consoleActor(req);
    const { stream, rec } = await this.attachments.fetch(id, aid, { via: 'CONSOLE', actor: actor.actor, ip: actor.ip });
    setAttachmentResponseHeaders(res, rec.name, rec.contentType);
    return new StreamableFile(stream, { type: rec.contentType, length: rec.sizeBytes });
  }

  /** 첨부 삭제 — 작성(미발송) 상태 한정(멱등). */
  @Delete(':id/attachments/:aid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async removeAttachment(@Param('id') id: string, @Param('aid') aid: string, @Req() req: ConsoleReq) {
    return { data: await this.attachments.remove(id, aid, this.callerActor(req).actor) };
  }

  /** 발송 — 외부 미서명자에게 포털 링크 이메일 전송. */
  @Post(':id/send')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async send(@Param('id') id: string, @Body() dto: ContractSendDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.send(id, dto.baseUrl, this.callerActor(req)) };
  }

  /** 재발송(독촉) — 미서명 외부 서명자 리마인드. */
  @Post(':id/remind')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async remind(@Param('id') id: string, @Body() dto: ContractSendDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.send(id, dto.baseUrl, this.callerActor(req), true) };
  }

  /** 내부 서명 — 콘솔 사람 계정만(세션 주체 == 지정 서명자 바인딩). 손글씨 서명 이미지(선택). */
  @Post(':id/sign')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async sign(@Param('id') id: string, @Body() dto: ContractSignDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.sign(id, this.consoleActor(req), dto?.signatureImage, dto?.fillValues) };
  }

  /** 손글씨 서명 이미지 조회(행위 증거) — 관리자 상세 뷰. 참가자별(contracts:read — 콘솔 GET 공통 규칙, 이력 열람과 동일 신뢰경계). */
  @Get(':id/signature-image/:pid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async signatureImage(@Param('id') id: string, @Param('pid') pid: string, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const img = await this.svc.getSignatureImage(id, pid);
    if (!img) throw new NotFoundException('서명 이미지 없음');
    const sigTitle = await this.titleOf(id);
    // PNG/JPEG 이므로 문서(PDF) 헤더가 아니라 첨부 헬퍼 사용 — Content-Type 을 실제 형식으로 지정한다
    setAttachmentResponseHeaders(res, `${sigTitle.slice(0, 30)}_손글씨_${pid.slice(0, 8)}.png`, img.contentType);
    return new StreamableFile(img.bytes, { type: img.contentType });
  }

  /** 서명란 좌표 재지정 — 기존 계약도 서명란 위치를 배치해 손글씨 합성이 되도록. */
  @Patch(':id/sign-marks')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async updateSignMarks(@Param('id') id: string, @Body() dto: UpdateSignMarksDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.updateSignMarks(id, dto.signMarks ?? [], this.consoleActor(req)) };
  }

  /**
   * 기재값(fill-at-signing) 조회 — 서명자별 기재 원문·봉인 해시·무결성(증적 확인·분쟁 대응).
   * 스코프는 **contracts:write** — 계좌번호 등 구조화 PII 원문이라 계약 이력 열람(:id/log)과 같은 등급으로 맞춘다(D3).
   */
  @Get(':id/fill-values')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async fillValues(@Param('id') id: string) {
    return { data: await this.svc.fillValueSummary(id) };
  }

  /**
   * 계약 진행 상태(경량, R3) — 연동 시스템의 정합 확인용. 개인정보(이메일·기재값·문서) 미노출이라
   * 계약 생성 권한(contracts:write)만으로 조회할 수 있다(민감 스코프 contracts:read 불요).
   */
  @Get(':id/status')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async status(@Param('id') id: string) {
    return { data: await this.svc.statusOf(id) };
  }

  /** 미서명 외부 서명자 수신 이메일 정정(R4) — 기존 링크 무효화 + 감사 봉인. 발송/독촉으로 새 링크 전송. */
  @Patch(':id/participants/:pid/email')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async updateParticipantEmail(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ContractParticipantEmailDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.updateParticipantEmail(id, pid, dto.email, this.callerActor(req)) };
  }

  /** 계약 철회(R5) — 계약 API 단독 완결용(봉투 철회와 동일 동작 + 계약 감사 봉인). */
  @Post(':id/withdraw')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async withdraw(@Param('id') id: string, @Body() dto: ContractArchiveDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.withdraw(id, dto?.reason, this.callerActor(req)) };
  }

  /** 손글씨 서명 보유 참가자 목록(상세 뷰용). */
  @Get(':id/signature-images')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async signatureImages(@Param('id') id: string) {
    return { data: await this.svc.signatureImageParticipants(id) };
  }

  /** 계약함 목록 — 서버측 검색·상태·기간 필터. */
  @Get()
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('label') label?: string,
    @Query('category') category?: string,
    @Query('archived') archived?: string,
  ) {
    // 공용 헬퍼로 검증 — limit 상한 200 클램프·offset 음수/NaN 방지·기간은 ISO 유효값만(무검증 시
    // limit=9999999 로 전량 적재(OOM)·NaN take·Invalid Date 500 이 가능했다). q 는 소문자 정규화
    // (searchText 가 소문자로 저장되어 대문자 검색이 0건이 되던 문제).
    const page = parsePage({ limit, offset });
    const range = parseDateRange({ from, to });
    const parsed = {
      limit: page.limit, offset: page.offset, status,
      q: typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : undefined,
      ...range, label, category,
      archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
    };
    return { data: await this.svc.list(parsed) };
  }

  /** 카테고리별 집계(보관 제외) — 각 카테고리의 전체·체결완료 건수. */
  @Get('categories')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async categories() {
    return { data: await this.svc.categorySummary() };
  }

  /** 계약 카테고리 변경(재분류). */
  @Patch(':id/category')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async setCategory(@Param('id') id: string, @Body() dto: ContractCategoryDto) {
    return { data: await this.svc.setCategory(id, dto.category) };
  }

  /** 계약 보관(계약함에서 제거) — 목록 숨김·데이터/감사 보존·감사 기록. */
  @Post(':id/archive')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async archive(@Param('id') id: string, @Body() dto: ContractArchiveDto, @Req() req: ConsoleReq) {
    return { data: await this.svc.archive(id, this.callerActor(req), dto?.reason) };
  }

  /** 계약 보관 복원 — 계약함 재노출. */
  @Post(':id/unarchive')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async unarchive(@Param('id') id: string, @Req() req: ConsoleReq) {
    return { data: await this.svc.unarchive(id, this.callerActor(req)) };
  }

  /** 계약함 CSV — 메타만(문서 내용 미포함). */
  @Get('export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="contracts.csv"')
  async exportCsv(@Query('status') status?: string, @Query('q') q?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const rows = await this.svc.exportCsvRows({ status, q, from, to });
    return toCsv(['생성시각', '계약ID', '제목', '상태', '서명진행', '라벨', '만료'], rows);
  }

  /** 계약 현황(대시보드 위젯) — 상태별 건수. (':id' 라우트보다 먼저 선언) */
  @Get('stats')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async stats() {
    return { data: await this.svc.stats() };
  }

  /** 새 계약 프리셋 목록(U5) — 자주 쓰는 요청 구성(기관 공용). */
  @Get('presets')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async presetList() {
    return { data: await this.presets.list() };
  }

  /** 새 계약 프리셋 저장(U5) — 동일 이름 upsert. 접근암호 값 미저장. */
  @Post('presets')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async presetSave(@Body() dto: ContractPresetDto, @Req() req: ConsoleReq) {
    return { data: await this.presets.save(dto, this.callerActor(req).actor) };
  }

  /** 새 계약 프리셋 삭제(멱등). */
  /** 프리셋 단건(적용용) — 원문 이메일 포함이라 계약 생성 권한에서만(D6). */
  @Get('presets/:pid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async presetGet(@Param('pid') pid: string) {
    return { data: await this.presets.get(pid) };
  }

  /** 계약 프리셋 삭제 — 생성자 또는 admin 만 가능(그 외 403). 삭제는 `admin:contract-presets` 감사에 봉인. */
  @Delete('presets/:pid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async presetRemove(@Param('pid') pid: string, @Req() req: ConsoleReq) {
    // D5 — 삭제는 생성자·admin 만(수정은 기관 공용 유지). 역할은 콘솔 세션에서만 알 수 있다.
    const actor = this.callerActor(req);
    return { data: await this.presets.remove(pid, actor.actor, req.adminUser?.role) };
  }

  /** 계약 서식 목록 — 내장(builtin) + 기관 커스텀. */
  @Get('templates')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async templateList() {
    return { data: await this.templates.list() };
  }

  /** 서식 생성(커스텀) — 관리자. */
  @Post('templates')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateCreate(@Body() dto: CustomTemplateDto) {
    return { data: await this.templates.createCustom(dto) };
  }

  /** 계약 서식 상세 — 필드 정의 + {{키}} 본문(치환은 에디터가 수행). */
  @Get('templates/:tid')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async templateGet(@Param('tid') tid: string) {
    return { data: await this.templates.get(tid) };
  }

  /** 서식 수정 — 관리자. 내장은 기관 오버라이드로 저장(원본 보존·복원 가능), 커스텀은 직접 수정. */
  @Patch('templates/:tid')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateUpdate(@Param('tid') tid: string, @Body() dto: CustomTemplateUpdateDto, @Req() req: ConsoleReq) {
    return { data: await this.templates.update(tid, dto, this.callerActor(req).actor) };
  }

  /** 내장 서식 기본값 복원 — 오버라이드 제거(코드 원본으로). */
  @Post('templates/:tid/reset')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateReset(@Param('tid') tid: string, @Req() req: ConsoleReq) {
    return { data: await this.templates.resetBuiltin(tid, this.callerActor(req).actor) };
  }

  /** 서식 변경 이력(버전 스냅샷, 최신순). */
  @Get('templates/:tid/history')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async templateHistory(@Param('tid') tid: string) {
    return { data: await this.templates.history(tid) };
  }

  /** 서식 특정 버전으로 되돌림. */
  @Post('templates/:tid/restore/:version')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateRestore(@Param('tid') tid: string, @Param('version') version: string, @Req() req: ConsoleReq) {
    return { data: await this.templates.restore(tid, Number(version), this.callerActor(req).actor) };
  }

  /** 커스텀 서식 삭제 — 관리자(내장 불가, 대신 기본값 복원). */
  @Delete('templates/:tid')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateDelete(@Param('tid') tid: string) {
    return { data: await this.templates.removeCustom(tid) };
  }

  /** 서식 복제(내장·커스텀 → 편집용 커스텀). */
  @Post('templates/:tid/duplicate')
  @UseGuards(ApiKeyGuard)
  @RequireScope(CONTRACT_TEMPLATES_SCOPE)
  async templateDuplicate(@Param('tid') tid: string) {
    return { data: await this.templates.duplicate(tid) };
  }

  /** 서식 조판 — 최종 본문 텍스트 → 한글 A4 PDF 반환(저장 안 함). 클라가 SHA-256 계산 후 생성·업로드. */
  @Post('compose')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async compose(@Body() dto: ComposeContractDto, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const { bytes: pdf, placedMarks, glyphReplacements, pages, warnings } = await this.templates.composePdfWithMarks(dto.title, dto.body, dto.signers ?? [], dto.marks ?? [], dto.doc);
    res.setHeader('X-Sign-Pages', String(pages)); // 조판 결과 페이지 수 — 호출자가 PDF 바이트를 파싱하지 않도록
    // 조판 경고 — 발행을 막지 않되(색 오타로 멈추는 게 더 나쁘다) "조용한 어긋남"은 호출자에게 알린다(글리프 보고와 동일 방식)
    if (warnings.length) {
      res.setHeader('X-Sign-Warnings-Count', String(warnings.reduce((a, w) => a + w.count, 0)));
      const wb64 = Buffer.from(JSON.stringify(warnings), 'utf8').toString('base64');
      if (wb64.length <= 2048) res.setHeader('X-Sign-Warnings', wb64); // base64+json(글리프 상세와 동일 인코딩)
    }
    // R8 — 본문 마커로 그린 서명란·입력란의 확정 좌표를 헤더로 반환(흐름 조판이라 호출자가 알 수 없다).
    // 그대로 createContract 의 signMarks 로 넘기면 서명 이미지·기재값이 본문 위치에 합성된다.
    // 헤더 크기 보호 — 4KB 초과 시 생략(그 경우 배치 편집기/직접 좌표 지정 사용).
    if (placedMarks.length) {
      // HTTP 헤더는 latin1 만 허용 — 라벨에 한글이 들어가므로 **UTF-8 JSON 을 base64** 로 실어 보낸다.
      // 클라이언트: JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      const b64 = Buffer.from(JSON.stringify(placedMarks), 'utf8').toString('base64');
      if (b64.length <= 6144) {
        res.setHeader('X-Sign-Marks', b64);
        res.setHeader('X-Sign-Marks-Encoding', 'base64+json');
      }
      res.setHeader('X-Sign-Marks-Count', String(placedMarks.length));
    }
    // R10 — 폰트 미지원 글리프를 대체했으면 내역을 헤더로 알린다(조용한 삭제 방지).
    // 호출자는 발행 전에 원문을 교정하거나 대체 표기를 수용할지 판단할 수 있다.
    if (glyphReplacements.length) {
      const total = glyphReplacements.reduce((a, g) => a + g.count, 0);
      res.setHeader('X-Sign-Glyph-Replaced', String(total));
      const b64 = Buffer.from(JSON.stringify(glyphReplacements), 'utf8').toString('base64');
      if (b64.length <= 4096) {
        res.setHeader('X-Sign-Glyph-Detail', b64);
        res.setHeader('X-Sign-Glyph-Detail-Encoding', 'base64+json');
      }
    }
    setDocResponseHeaders(res, 'contract-draft.pdf');
    return new StreamableFile(pdf, { type: 'application/pdf' });
  }

  /** 업로드 PDF에 서명란·입력란 마크 스탬프(배치 편집기 좌표) — 저장 안 함, 결과 PDF 반환. */
  @Post('stamp')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async stamp(@Body() dto: StampContractDto, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(dto.pdfBase64, 'base64');
    } catch {
      throw new BadRequestException('pdfBase64 디코드 실패');
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BadRequestException('PDF(%PDF-) 형식만 허용됩니다');
    const pdf = await this.templates.stampPdf(bytes, dto.marks, dto.signers ?? []);
    setDocResponseHeaders(res, 'contract-marked.pdf');
    return new StreamableFile(pdf, { type: 'application/pdf' });
  }

  /** 리마인더·발송 정책 상태(알림·리마인더 화면, 읽기 전용). */
  @Get('reminder-status')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async reminderStatus() {
    return { data: await this.svc.reminderStatus() };
  }

  /**
   * 계약 이력(`contract:<id>` 감사 스트림) — 생성·발송·열람·서명·교부 타임라인. 서버측 필터(eventType/from/to/q).
   * 행위 주체·IP 를 포함하므로 `contracts:write` 를 요구해 무스코프 기계키를 차단한다(전자결재 F1 준용).
   * 콘솔 viewer 는 플랫폼 공통 규칙(비민감 스코프 GET 우회)에 따라 열람 가능 — 결재 인증로그와 동일.
   */
  @Get(':id/log')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async log(@Param('id') id: string, @Query() query: Record<string, string | undefined>) {
    const entries = await this.svc.logEntries(id);
    return { data: filterAudit(entries, parseAuditFilter(query ?? {})) };
  }

  /** 계약 이력 CSV(UTF-8 BOM). */
  @Get(':id/log/export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="contract-log.csv"')
  async logCsv(@Param('id') id: string, @Query() query: Record<string, string | undefined>): Promise<string> {
    const entries = await this.svc.logEntries(id);
    return auditToCsv(filterAudit(entries, parseAuditFilter(query ?? {})));
  }

  /** 계약 이력 무결성(체인·TSA 앵커). */
  @Get(':id/log/verify')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async logVerify(@Param('id') id: string) {
    return { data: await this.svc.logVerify(id) };
  }

  /** 공개 검증(QR 스캔) — 계약 진위·서명 검증 요약(인증 불요, 영구 토큰). */
  @Get('verify/:token')
  @TokenAuth('verify')
  async verifyPublic(@Param('token') token: string) {
    return { data: await this.svc.verifyByToken(token) };
  }

  /** 공개 검증 — 완료 문서(합성본, QR 포함) 다운로드/미리보기(인증 불요, 영구 토큰). */
  @Get('verify/:token/document')
  @TokenAuth('verify')
  async verifyDocument(@Param('token') token: string, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const doc = await this.svc.documentByVerifyToken(token);
    if (!doc) throw new NotFoundException('저장된 문서가 없습니다');
    const info = await this.svc.verifyByToken(token);
    setDocResponseHeaders(res, contractFileName(info.title, '검증본', token, info.completedAt));
    return new StreamableFile(doc.bytes, { type: doc.contentType });
  }

  /** 교부 화면 정보(공개, 만료형 토큰) — 제목·만료·다운로드 가능 여부. */
  @Get('delivery/:token')
  @TokenAuth('delivery')
  async deliveryInfo(@Param('token') token: string) {
    return { data: await this.svc.deliveryInfo(token) };
  }

  /** 교부 — 완료 문서(원본 PDF) 다운로드(공개, 토큰). 전건 접속기록(F008). */
  @Get('delivery/:token/document')
  @TokenAuth('delivery')
  async deliveryDocument(@Param('token') token: string, @Req() req: { ip?: string }, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const rec = await this.svc.resolveDelivery(token);
    const doc = await this.svc.renderSignedDocument(rec.requestId); // 서명란에 손글씨 합성한 완료본
    if (!doc) throw new NotFoundException('저장된 문서가 없습니다');
    await this.docs.recordView(rec.requestId, { ip: req.ip, via: 'DELIVERY' }, new Date().toISOString());
    // 파일명에 계약 제목·일자·식별자 — 여러 계약 파일을 한 폴더에 받아도 구분·정렬된다
    const st = await this.svc.statusOf(rec.requestId);
    setDocResponseHeaders(res, contractFileName(st.title, '체결본', rec.requestId, st.completedAt));
    return new StreamableFile(doc.bytes, { type: doc.contentType });
  }

  /** 교부 — 감사추적인증서 PDF 다운로드(공개, 토큰). */
  @Get('delivery/:token/certificate')
  @TokenAuth('delivery')
  async deliveryCertificate(@Param('token') token: string, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const rec = await this.svc.resolveDelivery(token);
    const pdf = await this.auditCert.generate(rec.requestId);
    const stc = await this.svc.statusOf(rec.requestId);
    setDocResponseHeaders(res, contractFileName(stc.title, '감사추적인증서', rec.requestId, stc.completedAt));
    return new StreamableFile(pdf, { type: 'application/pdf' });
  }

  /** 교부 화면 첨부 목록(공개, 교부 토큰) — 열람용 부속 문서 메타. */
  /** 교부 링크 1회 연장(공개, 토큰) — 수신자 자가 연장. 만료 후에는 불가(재발급 요청). */
  @Post('delivery/:token/extend')
  @TokenAuth('delivery')
  async extendDelivery(@Param('token') token: string) {
    return { data: await this.svc.extendDelivery(token) };
  }

  /** 지정 이메일로 문서 전달(공개, 토큰) — 새 교부 링크를 그 주소로 발송(링크당 3회 상한·감사 봉인). */
  @Post('delivery/:token/forward')
  @TokenAuth('delivery')
  async forwardDelivery(@Param('token') token: string, @Body() dto: ContractParticipantEmailDto) {
    return { data: await this.svc.forwardDelivery(token, dto.email) };
  }

  /** 교부 링크 첨부 목록(토큰 인증) — 완료 계약의 열람용 첨부. */
  @Get('delivery/:token/attachments')
  @TokenAuth('delivery')
  async deliveryAttachments(@Param('token') token: string) {
    const rec = await this.svc.resolveDelivery(token);
    return { data: await this.attachments.list(rec.requestId) };
  }

  /** 교부 화면 첨부 다운로드(공개, 교부 토큰) — 접근 감사(best-effort). */
  @Get('delivery/:token/attachments/:aid')
  @TokenAuth('delivery')
  async deliveryAttachment(@Param('token') token: string, @Param('aid') aid: string, @Req() req: { ip?: string }, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const rec = await this.svc.resolveDelivery(token);
    // 감사 actor 에 평문 이메일 미기록(마스킹 정책) — 교부 수신자 식별은 로컬파트 2자+도메인로 충분
    const masked = rec.email.replace(/^(.{2})[^@]*@/, '$1***@');
    const { stream, rec: att } = await this.attachments.fetch(rec.requestId, aid, { via: 'DELIVERY', actor: `delivery:${masked}`, ip: req?.ip });
    setAttachmentResponseHeaders(res, att.name, att.contentType);
    return new StreamableFile(stream, { type: att.contentType, length: att.sizeBytes });
  }

  /** 교부 링크 재발급(수동) — 체결 완료 계약의 외부 서명자별 링크 재발급 + 이메일. */
  @Post(':id/deliver')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async deliver(@Param('id') id: string, @Req() req: ConsoleReq) {
    return { data: await this.svc.deliver(id, this.callerActor(req)) };
  }

  /** 자동 리마인더 수동 트리거(운영·테스트) — 스케줄러와 동일 로직(멱등). */
  @Post('maintenance/auto-remind')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async autoRemind() {
    return { data: await this.svc.autoRemind() };
  }

  /** 계약 상세 — 봉투+메타(상대방 이메일 마스킹)+문서 보유. */
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async get(@Param('id') id: string) {
    return { data: await this.svc.get(id) };
  }

  /** 관리자 계약 문서 열람 — 서명 완료분의 손글씨를 서명란에 합성한 표시본(원본 무결성 유지, contracts:read — 콘솔 GET 공통 규칙). */
  @Get(':id/document')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async getDocument(@Param('id') id: string, @Query('raw') raw: string | undefined, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    await this.svc.get(id); // 계약 존재·플래그 확인(비계약/비활성 404)
    // raw=1 → 원본(서명란 배치 편집용), 기본 → 손글씨 합성 표시본
    const doc = raw === '1' ? await this.docs.fetch(id) : await this.svc.renderSignedDocument(id);
    if (!doc) throw new NotFoundException('저장된 문서가 없습니다(미업로드)');
    const st = await this.svc.statusOf(id);
    setDocResponseHeaders(res, contractFileName(st.title, raw === '1' ? '원본' : '문서', id, st.completedAt));
    return new StreamableFile(doc.bytes, { type: doc.contentType });
  }

  /** 파일명용 계약 제목(실패 시 기본값) — 다운로드 파일 구분에만 쓴다. */
  private async titleOf(requestId: string): Promise<string> {
    return (await this.svc.statusOf(requestId).then((st) => st.title).catch(() => '')) || '계약서';
  }

  /** 생성/발송 actor — 콘솔 세션 또는 기계키(approval submitActor 동형). */
  private callerActor(req: ConsoleReq): ContractActor {
    if (req.adminUser) return this.consoleActor(req);
    if (req.consumerApp) {
      return {
        actor: `consumer:${req.consumerApp.name}`,
        actorRole: req.consumerApp.name,
        authMethod: 'MACHINE_KEY',
        ip: this.ipOf(req),
        userAgent: req.headers?.['user-agent'] as string | undefined,
      };
    }
    throw new ForbiddenException('주체 인증 필요(콘솔 세션 또는 기계키)');
  }

  /** 내부 서명 actor — 콘솔 세션(사람 계정)만. */
  private consoleActor(req: ConsoleReq): ContractActor {
    const u = req.adminUser;
    if (!u) throw new ForbiddenException('내부 서명은 콘솔 사람 계정만 가능(기계키 불가)');
    return {
      actor: `user:${u.username}`,
      actorRole: u.role,
      authMethod: 'CONSOLE_SESSION',
      ip: this.ipOf(req),
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
  }

  private ipOf(req: ConsoleReq): string | undefined {
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    return req.ip;
  }
}

interface ConsoleReq {
  adminUser?: { username: string; role: string };
  consumerApp?: { name: string };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}
