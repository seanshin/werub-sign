// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OpsService } from '../application/ops.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ApiTags } from '@nestjs/swagger';
import { PublicApi } from './api-auth.decorators';

/**
 * 운영 — readiness(공개, 오케스트레이션용) + 운영 상태(보호, 관리자/모니터링).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('운영 상태')
@Controller()
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  /** readiness — DB·CA 준비 여부 (k8s readinessProbe / 모니터링) */
  @Get('health/ready')
  @PublicApi()
  async ready() {
    return this.ops.readiness();
  }

  /** 운영 상태 — Webhook 적체·요청 분포·CA (관리자 콘솔·모니터링) */
  @Get('v1/admin/ops-status')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async status() {
    return { data: await this.ops.status() };
  }

  /** 운영 추세(차트) — 상태 분포·일자별 요청·Webhook 성공률. days(최근 N일, 기본 30, max 365). */
  @Get('v1/admin/metrics')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async metrics(@Query('days') days?: string) {
    const d = days !== undefined && Number.isFinite(Number(days)) ? Math.min(365, Math.max(1, Math.floor(Number(days)))) : 30;
    return { data: await this.ops.metrics(d) };
  }
}
