// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { AuditAnchorService } from '../application/audit-anchor.service';
import { parsePage, paginate } from './pagination';
import { parseAuditFilter, filterAudit, auditToCsv } from './audit-filter';
import { ApiTags } from '@nestjs/swagger';

/**
 * 관리자 감사 스트림 조회 — `admin:auth`(로그인·MFA·비번변경·로그아웃)·`admin:users`(계정 생성/역할/상태/리셋).
 * 행위자 `user:<아이디>`·IP까지 봉인된 해시체인. 민감(로그인 이력·IP)이라 users:admin 한정.
 * audit-events(임상행위)와 분리 — 콘솔 「감사·로그」 화면이 관리자 감사도 표시하도록.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
/** 조회 허용 관리자 감사 스트림 — 임의 키 조회 차단용 화이트리스트 */
const ADMIN_AUDIT_STREAMS = ['admin:auth', 'admin:users', 'admin:contract-presets'] as const;

@ApiTags('감사·인증 로그')
@Controller('v1/admin/audit')
@UseGuards(ApiKeyGuard)
@RequireScope('users:admin')
export class AdminAuditController {
  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly anchor: AuditAnchorService,
  ) {}

  /** 화이트리스트 — 임의 키 조회 차단(감사 스트림만). */
  private resolve(stream?: string): string {
    const s = (stream ?? 'admin:auth').trim();
    return (ADMIN_AUDIT_STREAMS as readonly string[]).includes(s) ? s : 'admin:auth';
  }

  /** 관리자 감사 스트림 목록(+건수). */
  @Get('streams')
  @RequireScope('users:admin')
  async streams() {
    const out = [];
    for (const key of ADMIN_AUDIT_STREAMS) {
      out.push({ stream: key, count: (await this.store.auditEntries(key)).length });
    }
    return { data: out };
  }

  /** 스트림 엔트리(페이지네이션·서버측 필터). 프론트가 최신순 표시(역순). */
  @Get()
  @RequireScope('users:admin')
  async list(@Query('stream') stream?: string, @Query('limit') limit?: string, @Query('offset') offset?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }) {
    const entries = await this.store.auditEntries(this.resolve(stream));
    return paginate(filterAudit(entries, parseAuditFilter(query ?? {})), parsePage({ limit, offset }));
  }

  /** 서버측 필터 CSV(전체 일치분) — 심사·보존. */
  @Get('export.csv')
  @RequireScope('users:admin')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="admin-audit.csv"')
  async exportCsv(@Query('stream') stream?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }): Promise<string> {
    const entries = await this.store.auditEntries(this.resolve(stream));
    return auditToCsv(filterAudit(entries, parseAuditFilter(query ?? {})));
  }

  /** 무결성 검증(체인·TSA 앵커). */
  @Get('verify')
  @RequireScope('users:admin')
  async verify(@Query('stream') stream?: string) {
    return { data: await this.anchor.verify(this.resolve(stream)) };
  }
}
