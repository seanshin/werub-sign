// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, Controller, Get, Header, Inject, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { parsePage, paginate } from './pagination';
import { parseAuditFilter, filterAudit } from './audit-filter';
import { toCsv } from '../domain/csv';
import { ApiTags } from '@nestjs/swagger';

/**
 * 문서 인증 목록 — 외부 문서인증 연동(weRB `werb-docauth` 등)이 `POST /v1/audit-events`로 보낸
 * 문서 어테스테이션(`targetType=wsign_document`, 예: WSIGN_ATTEST)을 **문서별 스트림에 흩어진 것**을
 * 하나의 목록으로 통합. 각 행 = 문서 인증 이벤트(제목·문서ID·해시·시각·시스템·무결성).
 * 인증 행위 로그(requests:write)와 동일 접근 권한. 상세 검증은 스트림별 해시체인.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('감사·인증 로그')
@Controller('v1/admin/wsign-documents')
@UseGuards(ApiKeyGuard)
@RequireScope('requests:write')
export class WsignDocumentController {
  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
  ) {}

  /** 전체 events:* 스트림에서 문서 어테스테이션(targetType=wsign_document) 엔트리 병합·최신순. */
  private async rows() {
    const keys = await this.store.auditKeys('events:');
    const out: Array<Record<string, unknown>> = [];
    for (const key of keys) {
      const entries = await this.store.auditEntries(key);
      const chain = this.audit.verify(entries); // 스트림(문서)별 해시체인 무결성
      for (const e of entries) {
        const d = (e.data ?? {}) as Record<string, unknown>;
        if (d.targetType !== 'wsign_document') continue;
        out.push({ ...e, stream: key.slice('events:'.length), targetRef: d.targetRef, title: d.title, documentHash: d.documentHash, system: d.system, chainValid: chain.valid });
      }
    }
    out.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    return out;
  }

  /** 문서 인증(wsign) 목록 — weRB 가 봉인한 문서 어테스테이션 통합 조회. */
  @Get()
  @RequireScope('requests:write')
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('system') system?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }) {
    let rows = await this.rows();
    if (system) rows = rows.filter((r) => r.system === system);
    return paginate(filterAudit(rows as never, parseAuditFilter(query ?? {})), parsePage({ limit, offset }));
  }

  /** 문서 상세 — 해당 문서 스트림의 전체 어테스테이션 이력 + 해시체인 무결성. */
  @Get('detail')
  @RequireScope('requests:write')
  async detail(@Query('stream') stream?: string) {
    const s = (stream ?? '').trim();
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(s)) throw new BadRequestException('스트림 형식 오류');
    const entries = await this.store.auditEntries('events:' + s);
    const docEntries = entries.filter((e) => (e.data as { targetType?: string })?.targetType === 'wsign_document');
    if (!docEntries.length) throw new NotFoundException('문서 인증 스트림 없음');
    const chain = this.audit.verify(entries);
    const d = (docEntries[docEntries.length - 1].data ?? {}) as Record<string, unknown>;
    return { data: { stream: s, targetRef: d.targetRef, title: d.title, documentHash: d.documentHash, system: d.system, hashAlgo: d.hashAlgo, chainValid: chain.valid, count: entries.length, entries } };
  }

  /** 문서 인증 목록 CSV 내보내기(심사·보존). */
  @Get('export.csv')
  @RequireScope('requests:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="document-attestations.csv"')
  async exportCsv(@Query('system') system?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }): Promise<string> {
    let src = await this.rows();
    if (system) src = src.filter((r) => r.system === system);
    const rows = filterAudit(src as never, parseAuditFilter(query ?? {})) as unknown as Array<Record<string, unknown>>;
    const headers = ['시각', '문서', '문서ID', '시스템', '이벤트', '문서해시', 'entryHash', '체인'];
    const body = rows.map((r) => [r.occurredAt, r.title, r.targetRef, r.system, r.eventType, r.documentHash, r.entryHash, r.chainValid ? '유효' : '깨짐']);
    return toCsv(headers, body);
  }
}
