// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Header, NotFoundException, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { PatientTokenService } from '../application/patient-token.service';
import { SignatureRequestService } from '../application/signature-request.service';
import { IntegrationSettingsService } from '../application/integration-settings.service';
import { PortalDocumentService } from '../application/portal-document.service';
import { ContractService } from '../application/contract.service';
import { ContractAttachmentService } from '../application/contract-attachment.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { PortalSignDto, PortalUnlockDto } from './dto';
import { renderPortalPage } from './portal.view';
import { setAttachmentResponseHeaders, setDocResponseHeaders, FramableRes } from './document-headers';
import { ApiTags } from '@nestjs/swagger';
import { TokenAuth } from './api-auth.decorators';

/**
 * 환자 서명 포털 — 원외/standalone fallback 흐름(FR-14/15, design §2.5).
 * 토큰 링크로 비로그인 환자가 동의서 열람→본인확인→서명. HIS 앱이 주 채널, 본 흐름은 fallback.
 *  - 발급(HIS, 보호): POST /v1/requests/:id/portal-tokens
 *  - 열람(공개): GET /v1/portal/:token (JSON) · GET /portal/:token (HTML)
 *  - 서명(공개): POST /v1/portal/:token/sign  (토큰이 환자 컨텍스트, 본인확인 강결합)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('서명 포털(수신자)')
@Controller()
export class PortalController {
  constructor(
    private readonly tokens: PatientTokenService,
    private readonly svc: SignatureRequestService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly settings: IntegrationSettingsService,
    private readonly docs: PortalDocumentService,
    private readonly contracts: ContractService,
    private readonly attachments: ContractAttachmentService,
    private readonly config: ConfigService,
  ) {}

  /** 포털 서명 링크 발급 — 참가자별 1회용 토큰. 앱 미설치 수신자가 브라우저로 서명하는 경로. */
  @Post('v1/requests/:id/portal-tokens')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async issue(@Param('id') id: string) {
    return { data: await this.tokens.issueForRequest(id) };
  }

  /** 포털 서명 화면 데이터(토큰 인증) — 문서 요약·서명자·동의 항목. 토큰 만료·사용완료 시 4xx. */
  @Get('v1/portal/:token')
  @TokenAuth('portal')
  async info(@Param('token') token: string) {
    return { data: await this.view(token) };
  }

  /**
   * 환자 문서 열람(공개, 토큰) — 서명 대상 PDF 스트리밍. 토큰 미소비(재열람 허용, 소비는 서명에만).
   * 미보유 404·만료/파기 410. DOCUMENT_VIEWED 접속기록(F008). 표시 문서 == 서명 대상(업로드 시 해시검증).
   */
  @Get('v1/portal/:token/document')
  @TokenAuth('portal')
  async document(@Param('token') token: string, @Req() req: { ip?: string }, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const t = await this.tokens.resolve(token); // 만료/무효 토큰 → 401/403
    await this.contracts.assertPortalUnlocked(t.requestId, t); // 계약+접근암호: unlock 전 열람 차단
    const doc = await this.docs.fetch(t.requestId); // 미보유 null·만료 GoneException(410)
    if (!doc) throw new NotFoundException('저장된 문서가 없습니다(미업로드 또는 파기됨)');
    // 계약 트랙(D1) — 앞 서명자가 기재·서명한 내용이 반영된 **표시본**을 보여준다.
    // 원본(서명 대상·documentHash)은 불변이며 포털 화면이 원본 해시를 그대로 표기한다.
    // 실패 시 원본으로 폴백(열람 자체를 막지 않는다).
    const view = await this.contracts.renderPortalView(t.requestId).catch(() => null);
    await this.docs.recordView(t.requestId, { participantId: t.participantId, ip: req.ip, via: 'PORTAL' }, new Date().toISOString());
    if (view) {
      setDocResponseHeaders(res, 'consent-document.pdf');
      return new StreamableFile(view.bytes, { type: view.contentType });
    }
    setDocResponseHeaders(res, 'consent-document.pdf'); // inline·no-store·nosniff·크로스오리진 프레이밍 허용
    return new StreamableFile(doc.bytes, { type: doc.contentType });
  }

  /** 계약 첨부 목록(공개, 토큰) — 열람용 부속 문서 메타. 접근암호 계약은 unlock 후 열람. */
  @Get('v1/portal/:token/attachments')
  @TokenAuth('portal')
  async attachmentList(@Param('token') token: string) {
    const t = await this.tokens.resolve(token);
    await this.contracts.assertPortalUnlocked(t.requestId, t);
    return { data: await this.attachments.list(t.requestId) };
  }

  /** 계약 첨부 다운로드(공개, 토큰) — unlock 게이트 + 접근 감사(best-effort). */
  @Get('v1/portal/:token/attachments/:aid')
  @TokenAuth('portal')
  async attachmentGet(@Param('token') token: string, @Param('aid') aid: string, @Req() req: { ip?: string }, @Res({ passthrough: true }) res: FramableRes): Promise<StreamableFile> {
    const t = await this.tokens.resolve(token);
    await this.contracts.assertPortalUnlocked(t.requestId, t);
    const { stream, rec } = await this.attachments.fetch(t.requestId, aid, { via: 'PORTAL', actor: `party:${t.participantId}`, ip: req?.ip });
    setAttachmentResponseHeaders(res, rec.name, rec.contentType);
    return new StreamableFile(stream, { type: rec.contentType, length: rec.sizeBytes });
  }

  /** 포털 서명 제출(토큰 인증) — 동의·손글씨 서명값을 봉인하고 서명을 완료한다. */
  @Post('v1/portal/:token/sign')
  @TokenAuth('portal')
  async sign(@Param('token') token: string, @Body() dto: PortalSignDto, @Req() req: { ip?: string }) {
    const t = await this.tokens.resolve(token);
    await this.contracts.assertPortalUnlocked(t.requestId, t); // 계약+접근암호: unlock 전 서명 차단
    // fill-at-signing(A4) — 배정 입력란 기재값 봉인(fail-closed: 누락 409·봉인 실패 시 서명 미수행). 비계약 no-op.
    await this.contracts.saveFillBeforeSign(t.requestId, t.participantId, dto?.fillValues, 'PORTAL');
    const result = await this.svc.submit(t.participantId, { identity: dto?.identity });
    await this.tokens.consume(token);
    await this.contracts.onPortalSigned(t.requestId, t.participantId, req?.ip, dto?.signatureImage); // 계약 스트림 기록·손글씨 증거·체결 시점봉인(비계약 no-op)
    return { data: { signed: true, requestStatus: result.requestStatus } };
  }

  /** 일반 전자계약 접근암호 확인(unlock) — 통과 시 동일 토큰의 열람·서명 허용. 무차별 대입 방지 rate-limit. */
  @Post('v1/portal/:token/unlock')
  @TokenAuth('portal')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async unlock(@Param('token') token: string, @Body() dto: PortalUnlockDto, @Req() req: { ip?: string }) {
    return { data: await this.contracts.unlock(token, dto.code, req?.ip) };
  }

  /** 포털 서명 페이지(HTML, 무인증 링크) — 수신자가 브라우저로 여는 진입점. */
  @Get('portal/:token')
  @TokenAuth('portal')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(@Param('token') token: string): Promise<string> {
    try {
      const v = await this.view(token);
      if ('locked' in v) return renderPortalPage(token, null, '접근암호 확인이 필요합니다 — 안내받은 링크의 웹 화면에서 접근암호를 입력하세요');
      return renderPortalPage(token, v);
    } catch (e) {
      return renderPortalPage(token, null, (e as Error).message);
    }
  }

  /** 공개 열람용 최소 투영(내부 필드 비노출) */
  private async view(token: string) {
    const t = await this.tokens.resolve(token);
    const req = await this.store.getRequest(t.requestId);
    if (!req) throw new Error('request not found');
    const p = req.participants.find((x) => x.participantId === t.participantId)!;
    // 수신처 정정(R4) 이전 링크는 정보 조회 단계에서 차단 — 잘못된 수신자에게 계약 정보를 보이지 않는다
    await this.contracts.assertTokenNotSuperseded(t.requestId, t);
    // 일반 전자계약 접근암호 잠금 — unlock 전에는 제목·서명자 표시명만(내용·진행상태 비노출).
    if (await this.contracts.isLocked(t.requestId, t)) {
      return {
        locked: true as const,
        request: { title: req.title, signMode: req.signMode },
        signer: { displayName: p.displayName },
        expiresAt: new Date(t.expiresAt).toISOString(),
      };
    }
    const blocked = req.participants.some((x) => x.signOrder < p.signOrder && x.status !== 'SIGNED');
    // 본인인증 시연 모드 — idv provider=mock(실서비스 전)이면 PASS 등 본인확인 생략 가능.
    // 실 사업자(IDV_PROVIDER=pass 등) 설정 시 자동으로 false → 실 본인확인 요구.
    const idv = await this.settings.effective('idv').catch(() => null);
    const provider = (idv?.provider as string | undefined) ?? this.config.get<string>('IDV_PROVIDER') ?? 'mock';
    return {
      request: { title: req.title, externalDocId: req.externalDocId, documentHashPrefix: req.documentHash.slice(0, 12), signMode: req.signMode },
      signer: { role: p.signerRole, displayName: p.displayName, requiredIdentityLevel: p.requiredIdentityLevel, signOrder: p.signOrder, status: p.status },
      // fill-at-signing(A4) — 이 서명자가 서명 시 기재해야 할 입력란(계약 트랙만, 없으면 빈 배열)
      inputFields: req.signMode === 'CONTRACT' ? await this.contracts.portalInputFields(t.requestId, t.participantId) : [],
      canSignNow: p.status !== 'SIGNED' && !blocked,
      identityDemo: provider === 'mock', // 실서비스 전 본인인증 생략 가능 여부
      documentAvailable: await this.docs.has(t.requestId), // 서명 대상 PDF 열람 가능 여부(포털 뷰어 노출)
      expiresAt: new Date(t.expiresAt).toISOString(),
    };
  }
}
