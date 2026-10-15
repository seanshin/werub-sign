// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * IdentityProvider 포트 — 비대면/대면 본인확인 (FR-09 / design §15).
 * mock(개발) ↔ PASS/명의 사업자(운영) 교체축.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

export type IdentityMethod = 'INPERSON' | 'MOBILE_NAME' | 'PASS' | 'KAKAO_CERT' | 'ACCESS_CODE' | 'STAFF_SSO';

export interface IdentityVerifyInput {
  method: IdentityMethod;
  subjectRef?: string;
  name?: string;
  ci?: string; // 본인확인 식별값 (해시 저장)
  phone?: string;
}

export interface IdentityResult {
  method: IdentityMethod;
  provider: string;
  providerTxId?: string;
  verifiedName?: string;
  ciHash?: string;
  phoneHash?: string;
  result: 'SUCCESS' | 'FAIL';
  verifiedAt: string;
}

export interface IdentityProvider {
  verify(input: IdentityVerifyInput): Promise<IdentityResult>;
}
