// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHmac } from 'node:crypto';
import { IdentityProvider, IdentityResult, IdentityVerifyInput } from '../../domain/ports/identity-provider.port';

/**
 * Mock 본인확인 — 개발/PoC. 운영은 PASS/명의 사업자 어댑터로 교체(IdentityProvider 포트).
 * 비대면(PASS/MOBILE_NAME)은 ci/phone 필수 → 미제공 시 FAIL.
 * 식별자는 HMAC 해시 저장(conventions §5, 평문 금지).
 *
 * pepper 주입형 — app(in-process)·idv-proxy(분리) 양쪽에서 재사용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class MockIdentityProvider implements IdentityProvider {
  constructor(private readonly pepper: string = 'dev-pepper') {}

  async verify(input: IdentityVerifyInput): Promise<IdentityResult> {
    const verifiedAt = new Date().toISOString();
    const base = {
      method: input.method,
      provider: input.method === 'STAFF_SSO' ? 'HIS-SSO' : input.method === 'INPERSON' ? 'INPERSON' : 'MOCK-IDV',
      verifiedAt,
    };

    // 대면/SSO는 외부 식별자 불요
    if (input.method === 'INPERSON' || input.method === 'STAFF_SSO') {
      return { ...base, result: 'SUCCESS', verifiedName: input.name, providerTxId: input.subjectRef };
    }

    // 비대면(PASS/명의/카카오)은 ci 또는 phone 필요
    if (!input.ci && !input.phone) {
      return { ...base, result: 'FAIL' };
    }
    return {
      ...base,
      result: 'SUCCESS',
      verifiedName: input.name,
      ciHash: input.ci ? this.hash(`ci:${input.ci}`) : undefined,
      phoneHash: input.phone ? this.hash(`phone:${input.phone}`) : undefined,
      providerTxId: `mock-${Date.now()}`,
    };
  }

  private hash(s: string): string {
    return createHmac('sha256', this.pepper).update(s).digest('hex');
  }
}
