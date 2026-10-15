// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { IdentityProvider, IdentityResult, IdentityVerifyInput } from '../../domain/ports/identity-provider.port';

/**
 * RemoteIdentityProvider — 앱측 본인확인 어댑터. 본인확인을 DMZ idv-proxy로 위임한다.
 * 사업자 연동·콜백·시크릿은 idv-proxy(DMZ)에 격리 → sign-core(원내)는 결과만 수신.
 * 개발은 idv-proxy를 mock 백엔드로 구동 → 실 사업자 계약 없이 진행.
 *
 * 운영 경계: 사설망/DMZ + mTLS + 토큰(x-idv-token).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class RemoteIdentityProvider implements IdentityProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async verify(input: IdentityVerifyInput): Promise<IdentityResult> {
    const r = await fetch(this.baseUrl + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idv-token': this.token },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`idv-proxy /verify ${r.status}: ${text}`);
    }
    return (await r.json()) as IdentityResult;
  }
}
