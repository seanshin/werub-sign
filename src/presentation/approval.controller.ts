// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, ForbiddenException, Get, Header, Headers, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ApprovalService, ApprovalActor } from '../application/approval.service';
import { SsoVerifierService } from '../infrastructure/auth/sso-verifier.service';
import { CreateApprovalDto, ApprovalActDto } from './dto';
import { parseAuditFilter, filterAudit, auditToCsv } from './audit-filter';
import { ApiTags } from '@nestjs/swagger';
import { StaffSsoAuth } from './api-auth.decorators';

/**
 * 전자결재(상신→결재) + 통합 인증로그 — design electronic-approval.design.md.
 * 상신: 콘솔 세션 또는 기계키(HIS/PACS/ERP, approval:write). 결재: 콘솔 세션 또는 HIS SSO Bearer.
 * actor 는 서버(세션/SSO/기계키)에서 도출 — 요청 본문 신원 주장 불신. 피처플래그 OFF 시 서비스가 404.
 * 가드는 메서드별 부여(SSO 결재 `act-staff` 는 ApiKeyGuard 비사용, 자체 JWKS 검증).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('전자결재(플래그)')
@Controller('v1/approvals')
export class ApprovalController {
  constructor(
    private readonly svc: ApprovalService,
    private readonly sso: SsoVerifierService,
  ) {}

  /** 상신 — 결재선 지정 + 결재 봉투 생성. 콘솔 세션 또는 기계키(approval:write). */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:write')
  async submit(@Body() dto: CreateApprovalDto, @Req() req: ConsoleReq) {
    const data = await this.svc.submitDraft({ ...dto, actor: this.submitActor(req, dto.submittedBy) });
    return { data };
  }

  /** 결재(승인/반려) — 콘솔 세션 결재자. 지정 결재자만. 고위험/최종 단계는 step-up. */
  @Post(':id/act')
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:act')
  async act(@Param('id') id: string, @Body() dto: ApprovalActDto, @Req() req: ConsoleReq) {
    const data = await this.svc.act(id, { decision: dto.decision, opinion: dto.opinion, stepUp: dto.stepUp, actor: this.consoleActor(req) });
    return { data };
  }

  /**
   * 결재(승인/반려) — HIS 의료진 SSO Bearer 경유(JWKS 검증). ApiKeyGuard 비사용(staff-sign 동일 패턴).
   * 바인딩: 토큰 sub == 지정 결재자(approverId). 고위험/최종 step-up 은 SSO 재인증(acr)으로 충족.
   */
  @Post(':id/act-staff')
  @StaffSsoAuth()
  async actStaff(@Param('id') id: string, @Body() dto: ApprovalActDto, @Headers('authorization') auth: string | undefined, @Req() req: ConsoleReq) {
    if (!auth) throw new UnauthorizedException('Authorization Bearer 필요(SSO 결재)');
    const claims = await this.sso.verify(auth); // HIS SSO 토큰 JWKS 검증(aud=sign)
    const actor: ApprovalActor = {
      actor: `staff:${claims.sub}`,
      actorRole: claims.role,
      authMethod: 'STAFF_SSO',
      acr: claims.acr,
      ip: this.ipOf(req),
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
    const data = await this.svc.act(id, { decision: dto.decision, opinion: dto.opinion, stepUp: dto.stepUp, actor });
    return { data };
  }

  /**
   * 결재 진행 상태 — 결재선·단계별 처리 결과.
   * 결재 상태·인증로그는 actor·IP·의견 등 민감정보를 포함하므로 결재 권한(approval:act) 보유자로 제한한다.
   * (기계키·viewer 노출 차단 — admin:auth 감사가 users:admin 한정인 것과 동일 원칙)
   */
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:act')
  async get(@Param('id') id: string) {
    return { data: await this.svc.get(id) };
  }

  /** 통합 인증로그(서버측 필터 eventType/from/to/q). */
  @Get(':id/authlog')
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:act')
  async authLog(@Param('id') id: string, @Query() query: AuditQuery) {
    const entries = await this.svc.authLogEntries(id);
    return { data: filterAudit(entries, parseAuditFilter(query ?? {})) };
  }

  /** 인증로그 CSV(심사·보존, UTF-8 BOM). */
  @Get(':id/authlog/export.csv')
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:act')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="approval-authlog.csv"')
  async authLogCsv(@Param('id') id: string, @Query() query: AuditQuery): Promise<string> {
    const entries = await this.svc.authLogEntries(id);
    return auditToCsv(filterAudit(entries, parseAuditFilter(query ?? {})));
  }

  /** 인증로그 무결성 검증(체인·TSA 앵커). */
  @Get(':id/authlog/verify')
  @UseGuards(ApiKeyGuard)
  @RequireScope('approval:act')
  async authLogVerify(@Param('id') id: string) {
    return { data: await this.svc.authLogVerify(id) };
  }

  private ipOf(req: ConsoleReq): string | undefined {
    return req.ip ?? (req.headers?.['x-forwarded-for'] as string | undefined);
  }

  /** 상신 actor — 콘솔 세션 또는 기계키(caller 제공 submittedBy=정보성). */
  private submitActor(req: ConsoleReq, submittedBy?: string): ApprovalActor {
    if (req.adminUser) return this.consoleActor(req);
    if (req.consumerApp) {
      // 기계키: 상신자는 caller-asserted(검증 아님) — his:<submittedBy>, 미제공 시 consumer:<name>. authMethod 로 검증 수준 구분.
      return {
        actor: submittedBy ? `his:${submittedBy}` : `consumer:${req.consumerApp.name}`,
        actorRole: req.consumerApp.name,
        authMethod: 'MACHINE_KEY',
        ip: this.ipOf(req),
        userAgent: req.headers?.['user-agent'] as string | undefined,
      };
    }
    throw new ForbiddenException('상신 주체 인증 필요(콘솔 세션 또는 기계키)');
  }

  /** 결재 actor — 콘솔 세션(사람 계정)만. 기계키/미인증 차단. */
  private consoleActor(req: ConsoleReq): ApprovalActor {
    const u = req.adminUser;
    if (!u) throw new ForbiddenException('결재는 콘솔 사람 계정만 가능(기계키 불가)');
    return {
      actor: `user:${u.username}`,
      actorRole: u.role,
      authMethod: 'CONSOLE_SESSION',
      ip: this.ipOf(req),
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
  }
}

interface ConsoleReq {
  adminUser?: { username: string; role: string };
  consumerApp?: { name: string };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}
interface AuditQuery {
  eventType?: string;
  from?: string;
  to?: string;
  q?: string;
}
