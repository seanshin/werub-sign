// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * C-4 다중관리자 RBAC — 역할 정의 및 역할→스코프 매핑.
 *
 * 기존 ApiKeyGuard 스코프 모델(requests:write·certificates:write·settings:write·ca:admin)을
 * 재사용하되, 사람(관리자) 계정은 역할(role)로 스코프 묶음을 부여한다. 기계 키(HIS/PACS/console)는
 * 종전대로 ConsumerApp.allowedScopes 를 직접 사용 — RBAC 영향 없음.
 *
 * 역할 3단계:
 *  - admin    : 전권 — 서명요청·인증서·연동설정·CA운영·사용자관리.
 *  - operator : 일상 운영 — 서명요청·인증서 발급/관리. CA·연동설정·사용자관리 불가.
 *  - viewer   : 읽기 전용 — 운영 데이터 GET 만. 변경(POST/PUT/PATCH/DELETE) 및 민감 스코프 불가.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export type AdminRole = 'admin' | 'operator' | 'viewer';

export const ADMIN_ROLES: readonly AdminRole[] = ['admin', 'operator', 'viewer'] as const;

/** 사용자 관리 전용 스코프 — admin 역할 및 sign-admin 기계키(break-glass)에만 부여. */
export const USERS_ADMIN_SCOPE = 'users:admin';

/**
 * 계약 서식(내장 오버라이드·커스텀) 쓰기 전용 스코프 — D4.
 * 서식 본문은 이후 생성되는 **모든 계약의 문안**을 좌우하므로, 일반 계약 작성 권한(contracts:write)과 분리한다.
 * 사람 계정은 admin 역할에만 부여하며, 연동 기계키에는 부여하지 않는다(ASSIGNABLE 제외).
 */
export const CONTRACT_TEMPLATES_SCOPE = 'contracts:templates';

/** viewer 의 GET 우회조차 허용하지 않는 민감 스코프 — 명시적 보유자만 접근. */
export const SENSITIVE_SCOPES: readonly string[] = ['ca:admin', USERS_ADMIN_SCOPE] as const;

const ROLE_SCOPES: Record<AdminRole, string[]> = {
  admin: ['requests:write', 'certificates:write', 'settings:write', 'ca:admin', USERS_ADMIN_SCOPE, 'documents:read', 'approval:write', 'approval:act', 'contracts:read', 'contracts:write', CONTRACT_TEMPLATES_SCOPE],
  operator: ['requests:write', 'certificates:write', 'documents:read', 'approval:write', 'approval:act', 'contracts:read', 'contracts:write'],
  viewer: [], // 변경 스코프 없음 — readOnly 규칙으로 운영 데이터 GET 만 허용
};

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

export function scopesForRole(role: AdminRole): string[] {
  return [...ROLE_SCOPES[role]];
}

export function isReadOnlyRole(role: AdminRole): boolean {
  return role === 'viewer';
}
