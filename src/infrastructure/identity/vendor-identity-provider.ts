// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHmac } from 'node:crypto';
import { IdentityProvider, IdentityResult, IdentityVerifyInput } from '../../domain/ports/identity-provider.port';

/**
 * 실 본인인증 사업자 어댑터 자리표시(stub) — 설치 시점 자격증명·계약으로 드롭인.
 * 개발(IDV_PROVIDER=mock)은 미사용. 사업자 계약·API 키 확보 후 verify() 구현.
 *
 *  - PASS(통신사 본인확인/PASS앱): 표준창 호출 → 콜백 결과(CI/이름/전화) 수신·검증.
 *  - 명의(휴대폰 본인확인, MobileName): 동일 계열, 사업자별 REST 규격.
 *
 * 공통: 결과의 CI/전화는 평문 저장 금지 — pepper HMAC 해시만 반환(conventions §5).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
abstract class VendorIdentityProviderBase implements IdentityProvider {
  constructor(
    protected readonly pepper: string,
    protected readonly apiKey?: string,
    protected readonly endpoint?: string,
  ) {}

  protected abstract providerName(): string;

  async verify(input: IdentityVerifyInput): Promise<IdentityResult> {
    if (!this.apiKey || !this.endpoint) {
      throw new Error(
        `IDV ${this.providerName()} 자격증명/엔드포인트 미설정 — 사업자 계약 후 IDV_API_KEY·IDV_ENDPOINT 주입(개발은 IDV_PROVIDER=mock).`,
      );
    }
    // 설치 시 구현: 사업자 REST 호출 → 콜백/결과 검증 → 아래 형태로 매핑.
    // const res = await fetch(this.endpoint, { ... apiKey ... body: input });
    // return { method, provider, providerTxId: res.txId, verifiedName: res.name,
    //          ciHash: this.hash('ci:'+res.ci), phoneHash: this.hash('phone:'+res.phone),
    //          result: res.ok ? 'SUCCESS' : 'FAIL', verifiedAt: new Date().toISOString() };
    throw new Error(`IDV ${this.providerName()} verify() 미구현 — 사업자 API 규격으로 연동 필요.`);
  }

  protected hash(s: string): string {
    return createHmac('sha256', this.pepper).update(s).digest('hex');
  }
}

export class PassIdentityProvider extends VendorIdentityProviderBase {
  protected providerName(): string {
    return 'PASS';
  }
}

export class MobileNameIdentityProvider extends VendorIdentityProviderBase {
  protected providerName(): string {
    return 'MOBILE_NAME(명의)';
  }
}
