// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, Body, Controller, Get, Header, Headers, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { AuditAnchorService } from '../application/audit-anchor.service';
import { SsoVerifierService } from '../infrastructure/auth/sso-verifier.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { AuditEventDto } from './dto';
import { parsePage, paginate } from './pagination';
import { parseAuditFilter, filterAudit, auditToCsv } from './audit-filter';
import { ApiTags } from '@nestjs/swagger';

/**
 * 의료진 중요 행위 — 블록체인 인증 로그 (FR 확장).
 * HIS/PACS가 임상 행위(처방·판독승인·동의취득 등)를 제출하면 **append-only 감사 해시체인**에 봉인하고,
 * 요청 시 **TSA로 시점봉인(앵커)** 한다. 위변조 탐지(체인) + 시점증명(TSA) + 행위자 책임추적.
 * 스트림(`events:<stream>`)별로 분리 보관. PHI 원본은 넣지 말 것(식별자·해시만).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('감사·인증 로그')
@Controller('v1/audit-events')
export class AuditEventController {
  constructor(
    private readonly audit: AuditChainService,
    private readonly anchor: AuditAnchorService,
    private readonly sso: SsoVerifierService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  private key(stream?: string): string {
    const s = (stream ?? 'clinical-events').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'clinical-events';
    return `events:${s}`;
  }

  /** 행위 기록 — 해시체인 봉인(+옵션 TSA 앵커). 인증 영수증(entryHash·seq) 반환 */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async record(
    @Body() dto: AuditEventDto,
    @Req() req: { consumerApp?: { name: string } },
    @Headers('authorization') authz?: string,
  ) {
    const key = this.key(dto.stream);
    const occurredAt = dto.occurredAt ?? new Date().toISOString();

    // 의료진 본인 인증(선택) — staff-token(aud=sign) JWKS 검증 시 검증된 신원을 봉인.
    // 토큰 없으면 시스템 주장(API_KEY) 수준. 토큰 있으나 무효면 401.
    let auth: Record<string, unknown> = { method: 'API_KEY' };
    let actor = dto.actor;
    let actorRole = dto.actorRole;
    if (authz) {
      const c = await this.sso.verify(authz); // 무효 토큰 → 401
      // 타인 명의 위조 차단 — actor는 검증된 의료진(sub/사번)과 일치해야 함
      if (dto.actor && dto.actor !== c.sub && dto.actor !== c.employeeNumber) {
        throw new BadRequestException('actor가 인증된 의료진(sub/employeeNumber)과 불일치 — 타인 명의 기록 불가');
      }
      actor = c.sub; // 검증된 신원을 권위 행위자로 확정
      actorRole = dto.actorRole ?? c.role;
      auth = { method: 'SSO', sub: c.sub, role: c.role, employeeNumber: c.employeeNumber, acr: c.acr, signCertSerial: c.signCertSerial };
    }

    const data = {
      actor,
      actorRole,
      targetType: dto.targetType,
      targetRef: dto.targetRef,
      system: req.consumerApp?.name ?? 'unknown', // 기록을 제출한 시스템(HIS/PACS) — 책임추적
      auth, // 의료진 인증 — SSO 검증 신원 또는 API_KEY(시스템 주장)
      ...(dto.data ?? {}),
    };
    // prevHash 조회~append 는 반드시 한 구간에서 — SSO 검증(네트워크)이 그 사이에 있으면 TOCTOU 창이
    // 수백 ms 로 벌어져 동시 제출 시 체인이 분기한다. 직렬화 + 저장소 충돌 재시도(R16).
    const entry = await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const e = this.audit.next(prev, dto.action, data, occurredAt);
      await this.store.appendAudit(key, e);
      return e;
    });

    let anchored: { headHash: string; tsGenTime?: string } | undefined;
    if (dto.anchor) {
      await this.anchor.anchor(key); // 체인 head TSA 시점봉인
      const a = await this.store.getLatestAnchor(key);
      anchored = a ? { headHash: a.headHash, tsGenTime: (a.tsToken as { genTime?: string })?.genTime } : undefined;
    }
    // 인증 영수증
    return {
      data: {
        stream: dto.stream ?? 'clinical-events',
        action: dto.action,
        actor, // SSO 시 검증된 신원으로 확정
        occurredAt,
        entryHash: entry.entryHash, // 블록체인 인증 해시(증명)
        prevHash: entry.prevHash,
        authMethod: auth.method, // SSO(의료진 검증) | API_KEY(시스템 주장)
        authenticatedSub: auth.method === 'SSO' ? auth.sub : undefined,
        anchored: !!dto.anchor,
        anchor: anchored,
      },
    };
  }

  // 테넌트 격리(M3) — ca:admin/콘솔은 전체, 그 외 consumerApp은 자기 system 항목만.
  private mine(req: { consumerApp?: { name: string; allowedScopes: string[] } }): string | null {
    const app = req.consumerApp;
    if (!app) return null;
    if (app.allowedScopes.includes('ca:admin') || app.name === 'console') return null; // 전체 열람
    return app.name;
  }

  /** 감사 스트림 목록 — 의료기록(medical-records)·임상행위(clinical-events) 등 별도 관리 */
  @Get('streams')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async streams(@Req() req: { consumerApp?: { name: string; allowedScopes: string[] } }) {
    const only = this.mine(req);
    const keys = await this.store.auditKeys('events:');
    const rows = await Promise.all(
      keys.map(async (k) => {
        const entries = await this.store.auditEntries(k);
        const count = only ? entries.filter((e) => (e.data as { system?: string })?.system === only).length : entries.length;
        return { stream: k.slice('events:'.length), count };
      }),
    );
    return { data: rows.filter((r) => r.count > 0).sort((a, b) => a.stream.localeCompare(b.stream)) };
  }

  /** 스트림 행위 로그 조회 — 테넌트 격리 */
  @Get()
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async list(@Req() req: { consumerApp?: { name: string; allowedScopes: string[] } }, @Query('stream') stream?: string, @Query('limit') limit?: string, @Query('offset') offset?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }) {
    const filtered = await this.queryEntries(req, stream, query);
    return paginate(filtered, parsePage({ limit, offset })); // { data, page }
  }

  /** 서버측 필터 CSV(전체 일치분, 페이지 무관) — 심사·보존. */
  @Get('export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-events.csv"')
  async exportCsv(@Req() req: { consumerApp?: { name: string; allowedScopes: string[] } }, @Query('stream') stream?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }): Promise<string> {
    return auditToCsv(await this.queryEntries(req, stream, query));
  }

  /** 테넌트 격리 + 서버측 필터(eventType·기간·검색) 적용한 엔트리. */
  private async queryEntries(req: { consumerApp?: { name: string; allowedScopes: string[] } }, stream?: string, query?: { eventType?: string; from?: string; to?: string; q?: string }) {
    const only = this.mine(req);
    const entries = await this.store.auditEntries(this.key(stream));
    const scoped = only ? entries.filter((e) => (e.data as { system?: string })?.system === only) : entries;
    return filterAudit(scoped, parseAuditFilter(query ?? {}));
  }

  /** 체인 무결성 + 앵커 검증 (위변조 탐지) */
  @Get('verify')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async verify(@Query('stream') stream?: string) {
    return { data: await this.anchor.verify(this.key(stream)) };
  }
}
