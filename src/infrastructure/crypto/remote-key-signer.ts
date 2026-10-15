// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHash, verify as cryptoVerify } from 'node:crypto';
import { GeneratedKey, GenerateOptions, KeySigner } from '../../domain/ports/key-signer.port';
import { KeyAlgorithm } from '../../domain/types/pki.types';

/**
 * RemoteKeySigner — 앱측 KeySigner. 개인키 연산(generate/sign)만 crypto-proxy로 위임한다.
 * 이 모드에서 앱 프로세스는 개인키·마스터키·HSM SDK를 일절 보유하지 않는다(키 격리).
 * verify/hash는 공개키·해시 연산(개인키 불요)이라 라운드트립 없이 로컬 수행.
 *
 * 운영 경계: proxy 호출은 사설망 + mTLS + 토큰. 본 클라이언트는 토큰 헤더를 부착.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class RemoteKeySigner implements KeySigner {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async generate(algorithm: KeyAlgorithm = 'RSA-3072', opts?: GenerateOptions): Promise<GeneratedKey> {
    return this.call<GeneratedKey>('/generate', { algorithm, ...opts });
  }

  async sign(keyRef: string, data: Buffer): Promise<Buffer> {
    const res = await this.call<{ signature: string }>('/sign', { keyRef, data: data.toString('base64') });
    return Buffer.from(res.signature, 'base64');
  }

  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
    return cryptoVerify('sha256', data, publicKeyPem, signature);
  }

  hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-token': this.token },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`crypto-proxy ${path} ${r.status}: ${text}`);
    }
    return (await r.json()) as T;
  }
}
