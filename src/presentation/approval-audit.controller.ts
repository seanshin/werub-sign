// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ApprovalService } from '../application/approval.service';
import { parsePage, paginate } from './pagination';
import { parseAuditFilter, filterAudit, auditToCsv } from './audit-filter';
import { ApiTags } from '@nestjs/swagger';

/**
 * 전자결재 통합 인증로그 — 모든 결재(approval:<id> 스트림)의 인증로그를 한곳에서 조회.
 * 건별 조회(`/v1/approvals/:id/authlog`)와 별개의 관리자 통합 감사 뷰. actor·IP·의견 민감 → approval:act 한정.
 * 무결성 검증(verify)은 스트림별이므로 건별 EP 사용(통합에선 미제공).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('전자결재(플래그)')
@Controller('v1/admin/approval-audit')
@UseGuards(ApiKeyGuard)
@RequireScope('approval:act')
export class ApprovalAuditController {
  constructor(private readonly svc: ApprovalService) {}

  /** 전체 결재 인증로그(페이지네이션·서버측 필터 eventType/from/to/q). 최신순. */
  @Get()
  @RequireScope('approval:act')
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query() query?: { eventType?: string; from?: string; to?: string; q?: string }) {
    const entries = await this.svc.allAuthLogEntries();
    return paginate(filterAudit(entries, parseAuditFilter(query ?? {})), parsePage({ limit, offset }));
  }

  /** 서버측 필터 CSV(전체 일치분) — 심사·보존. */
  @Get('export.csv')
  @RequireScope('approval:act')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="approval-authlog-all.csv"')
  async exportCsv(@Query() query?: { eventType?: string; from?: string; to?: string; q?: string }): Promise<string> {
    const entries = await this.svc.allAuthLogEntries();
    return auditToCsv(filterAudit(entries, parseAuditFilter(query ?? {})));
  }
}
