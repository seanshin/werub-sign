// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { GeneratedKey, GenerateOptions, KeySigner } from '../../domain/ports/key-signer.port';
import { KeyAlgorithm } from '../../domain/types/pki.types';

/**
 * HsmRoutingKeySigner — crypto-proxy 백엔드. keyClass로 HSM 표면을 최소화한다.
 *  - keyClass='HSM' (CA Root/Issuing 트러스트 앵커) → HSM 백엔드(있을 때)
 *  - 그 외(환자/스태프 말단키, TSA)          → SOFT 백엔드
 * 개발(HSM 백엔드 미구성)은 전부 SOFT로 진행하되, 요청된 keyClass 통계를 보존해
 * "최소화 정책"이 배선됐음을 검증 가능하게 한다(운영은 hsm 백엔드만 주입).
 *
 * sign 라우팅은 keyRef prefix(soft:/hsm:)로 결정 — 키가 상주하는 백엔드로 전달.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class HsmRoutingKeySigner implements KeySigner {
  private requestedHsm = 0;
  private requestedSoft = 0;
  private backendHsm = 0;
  private backendSoft = 0;

  constructor(
    private readonly soft: KeySigner,
    private readonly hsm: KeySigner | null,
  ) {}

  async generate(algorithm: KeyAlgorithm = 'RSA-3072', opts?: GenerateOptions): Promise<GeneratedKey> {
    const wantHsm = opts?.keyClass === 'HSM';
    if (wantHsm) this.requestedHsm++;
    else this.requestedSoft++;

    if (wantHsm && this.hsm) {
      this.backendHsm++;
      return this.hsm.generate(algorithm, opts); // keyRef=hsm:...
    }
    this.backendSoft++;
    return this.soft.generate(algorithm, opts); // keyRef=soft:...
  }

  async sign(keyRef: string, data: Buffer): Promise<Buffer> {
    return this.backendFor(keyRef).sign(keyRef, data);
  }

  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
    return this.soft.verify(publicKeyPem, data, signature); // 공개키 연산 — 백엔드 무관
  }

  hash(data: Buffer): string {
    return this.soft.hash(data);
  }

  stats(): {
    provider: 'hsm' | 'none';
    requestedHsm: number;
    requestedSoft: number;
    backendHsm: number;
    backendSoft: number;
  } {
    return {
      provider: this.hsm ? 'hsm' : 'none',
      requestedHsm: this.requestedHsm,
      requestedSoft: this.requestedSoft,
      backendHsm: this.backendHsm,
      backendSoft: this.backendSoft,
    };
  }

  private backendFor(keyRef: string): KeySigner {
    if (keyRef.startsWith('hsm:')) {
      if (!this.hsm) throw new Error(`hsm keyRef but no HSM backend: ${keyRef}`);
      return this.hsm;
    }
    return this.soft;
  }
}
