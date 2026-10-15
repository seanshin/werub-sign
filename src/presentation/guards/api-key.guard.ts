// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException, applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiForbiddenResponse, ApiSecurity, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import { ConsumerAppService } from '../../infrastructure/auth/consumer-app.service';
import { AdminUserService } from '../../infrastructure/auth/admin-user.service';
import { SessionTokenService, SessionClaims } from '../../infrastructure/auth/session-token.service';
import { SessionRegistryService } from '../../infrastructure/auth/session-registry.service';
import { scopesForRole, isReadOnlyRole, SENSITIVE_SCOPES } from '../../infrastructure/auth/rbac';

export const SCOPE_KEY = 'required_scope';
/**
 * 핸들러에 필요한 스코프 지정: `@RequireScope('requests:write')`.
 * 가드 강제와 함께 **OpenAPI 에도 그대로 반영**한다 — 연동 개발자가 스펙만 보고
 * 어떤 스코프의 키가 필요한지 알 수 있어야 하기 때문(스코프 부족 403 의 사전 안내).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const RequireScope = (scope: string) =>
  applyDecorators(
    SetMetadata(SCOPE_KEY, scope),
    ApiExtension('x-required-scope', scope),
    ApiSecurity('x-api-key'),
    ApiForbiddenResponse({ description: `스코프 부족 — 이 엔드포인트는 \`${scope}\` 스코프가 필요합니다.` }),
    ApiUnauthorizedResponse({ description: '인증 없음 — `x-api-key`(기계 연동) 또는 콘솔 세션 토큰이 필요합니다.' }),
  );

/**
 * 인증 가드 — 두 경로 통합(FR-11 / C-4 RBAC):
 *  1) 관리자 세션 토큰(사람) — x-session-token 또는 Authorization: Bearer. 역할→스코프, viewer 읽기전용.
 *  2) 기계 API Key — x-api-key 를 ConsumerApp 레지스트리로 검증(HIS/PACS/console/sign-admin). 종전 불변.
 * @RequireScope 로 핸들러별 스코프 강제. 운영: mTLS 병행 권장.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly consumers: ConsumerAppService,
    private readonly reflector: Reflector,
    private readonly adminUsers: AdminUserService,
    private readonly sessions: SessionTokenService,
    private readonly registry: SessionRegistryService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<any>();
    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 1) 관리자 세션(사람). 콘솔은 x-session-token 전용 → 제시되면 엄격 검증(만료 시 명확한 401).
    //    Authorization: Bearer 는 기계 호출이 습관적으로 붙일 수 있어 "검증되면 세션, 아니면 x-api-key 폴백"
    //    (SSO Bearer 를 받는 /v1/sign/staff 는 ApiKeyGuard 비사용이라 무관).
    const strictToken = req.headers['x-session-token'];
    if (typeof strictToken === 'string' && strictToken) {
      const claims = this.sessions.verify(strictToken);
      if (!claims) throw new UnauthorizedException('세션 토큰 무효/만료 — 재로그인 필요');
      this.checkRegistry(claims); // 서버측 idle·동시세션·폐기 강제
      return this.applyUserSession(req, claims, requiredScope);
    }
    const bearer = this.extractBearer(req);
    if (bearer) {
      const claims = this.sessions.verify(bearer);
      if (claims && this.adminUsers.getActive(claims.sub)) {
        this.checkRegistry(claims); // 서명 유효한 세션 토큰이면 폴백 금지(폐기/idle은 401)
        return this.applyUserSession(req, claims, requiredScope);
      }
      // 세션 토큰이 아니면(예: 잘못된 헤더) x-api-key 경로로 폴백 — 기계 연동 무중단
    }

    // 2) 기계 API Key — 종전 경로 불변(HIS/PACS/console break-glass)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const app = this.consumers.verifyApiKey(apiKey);
    if (!app) throw new UnauthorizedException('유효한 인증 필요(x-api-key 또는 관리자 세션)');
    if (requiredScope && !app.allowedScopes.includes(requiredScope)) {
      throw new ForbiddenException(`scope 부족: ${requiredScope}`);
    }
    req.consumerApp = app;
    return true;
  }

  /** 서버측 세션 레지스트리 강제 — 비활동(idle)·동시세션 축출·로그아웃 폐기를 시스템이 차단. */
  private checkRegistry(claims: SessionClaims): void {
    const v = this.registry.validate(claims.jti);
    if (!v.ok) {
      const msg =
        v.reason === 'idle'
          ? '비활동으로 세션이 종료되었습니다 — 재로그인 필요'
          : v.reason === 'expired'
            ? '세션이 만료되었습니다 — 재로그인 필요'
            : '세션이 종료되었습니다(로그아웃/다른 기기 로그인) — 재로그인 필요';
      throw new UnauthorizedException(msg);
    }
  }

  /** 검증된 세션 사용자 적용 — 역할 스코프 강제 + req.adminUser·sessionId 세팅. */
  private applyUserSession(req: any, claims: SessionClaims, requiredScope: string | undefined): boolean {
    const user = this.adminUsers.getActive(claims.sub); // 현재 상태(역할·비활성) 재확인
    if (!user) throw new UnauthorizedException('비활성 또는 삭제된 계정');
    const scopes = scopesForRole(user.role);
    this.enforceUserScope(requiredScope, scopes, isReadOnlyRole(user.role), req.method);
    req.adminUser = { username: user.username, role: user.role };
    req.allowedScopes = scopes;
    req.sessionId = claims.jti; // 로그아웃 시 폐기 대상
    return true;
  }

  private extractBearer(req: any): string | undefined {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return undefined;
  }

  /** 세션(사람) 스코프 강제 — viewer 는 민감 스코프 제외 운영 데이터 GET 만 허용. */
  private enforceUserScope(requiredScope: string | undefined, scopes: string[], readOnly: boolean, method: string): void {
    if (!requiredScope) {
      // 스코프 무지정(예: 하드닝 PII GET) — viewer 는 변경 차단, 읽기 허용
      if (readOnly && method !== 'GET') throw new ForbiddenException('읽기 전용 계정(viewer) — 변경 불가');
      return;
    }
    if (scopes.includes(requiredScope)) return;
    if (readOnly && method === 'GET' && !SENSITIVE_SCOPES.includes(requiredScope)) return; // viewer 읽기 우회
    throw new ForbiddenException(`권한 부족: ${requiredScope}`);
  }
}
