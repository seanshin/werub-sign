// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { CanActivate, ExecutionContext, Injectable, UseGuards, applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiSecurity } from '@nestjs/swagger';
import { ApiKeyGuard } from './api-key.guard';
import { isHardened } from '../../infrastructure/security/hardening';

/**
 * H3 — PII GET 보호(운영 전용). 하드닝(production|SECURITY_HARDENING) 시 x-api-key 강제,
 * 개발 시 통과(콘솔/로컬 접근 무영향). 무인증 PII 노출 차단.
 * 적용: GET /v1/requests/:id, /audit (verify/ocsp/crl 은 공개 유지).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class ProdApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyGuard: ApiKeyGuard) {}

  canActivate(context: ExecutionContext): boolean {
    if (!isHardened()) return true; // 개발 — 공개 접근 허용
    return this.apiKeyGuard.canActivate(context);
  }
}

/**
 * 위 가드를 붙이면서 **스펙에도 같은 사실을 적는다** — "운영에서는 키가 필요하지만 스코프는 따지지 않는다"는
 * 개발 환경에서 테스트하다 운영에서 401 을 만나는 전형적인 함정이라, 연동 개발자가 스펙만 보고 알 수 있어야 한다.
 */
export const ProdApiKeyAuth = () =>
  applyDecorators(
    UseGuards(ProdApiKeyGuard),
    ApiSecurity('x-api-key'),
    ApiExtension('x-auth', 'prod-api-key'),
    ApiExtension('x-auth-note', '운영(하드닝)에서는 `x-api-key` 필수 · 개발 환경에서는 무인증 허용. 특정 스코프는 요구하지 않는다.'),
  );
