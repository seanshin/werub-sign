// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicApi } from './api-auth.decorators';

/**
 * 배포 헬스체크 (공개) — LB/compose healthcheck용
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('공개 검증(무인증)')
@Controller()
export class HealthController {
  /** 헬스체크 — 프로세스 생존 확인(무인증). 오케스트레이션 readiness 는 `GET /health/ready`. */
  @Get('health')
  @PublicApi()
  health() {
    return { status: 'ok', service: 'sign', ts: new Date().toISOString() };
  }
}
