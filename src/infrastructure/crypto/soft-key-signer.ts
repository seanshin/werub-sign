// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { GeneratedKey, GenerateOptions, KeySigner } from '../../domain/ports/key-signer.port';
import { KeyAlgorithm } from '../../domain/types/pki.types';
import { InMemoryKeyVault, KeyVault } from './key-vault';

const SIG_HASH = 'sha256';

/**
 * SOFT KeySigner — 개인키를 마스터키로 AES-256-GCM 암호화하여 Vault에 보관(평문 DB 금지).
 * 서명 직전에만 복호화하고 사용 후 즉시 폐기.
 * HSM 도입 시 동일 포트(KeySigner)로 교체 → 상위 로직 무변경.
 * conventions.md §3 키 취급 규칙.
 *
 * Vault 주입: 기본 InMemory(개발), crypto-proxy 분리 구동 시 File(영속).
 * keyRef는 `soft:` prefix — 프록시의 라우터가 백엔드 식별에 사용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SoftKeySigner implements KeySigner {
  private readonly master: Buffer;

  constructor(
    masterKeyBase64: string,
    private readonly vault: KeyVault = new InMemoryKeyVault(),
  ) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('CRYPTO_MASTER_KEY must be 32 bytes (base64). 운영은 KMS/HSM 사용');
    }
    this.master = key;
  }

  async generate(algorithm: KeyAlgorithm = 'RSA-3072', _opts?: GenerateOptions): Promise<GeneratedKey> {
    void _opts; // SOFT 백엔드는 keyClass 무관(전부 SOFT). 라우팅은 프록시가 담당.
    const { publicKey, privateKey } =
      algorithm === 'ECDSA-P256'
        ? generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          })
        : generateKeyPairSync('rsa', {
            modulusLength: 3072,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          });

    const keyRef = `soft:${randomBytes(8).toString('hex')}`;
    await this.putEncrypted(keyRef, privateKey);
    return { keyRef, publicKey, algorithm };
  }

  async sign(keyRef: string, data: Buffer): Promise<Buffer> {
    let pem: string | null = await this.decrypt(keyRef);
    try {
      return cryptoSign(SIG_HASH, data, pem);
    } finally {
      pem = null; // 개인키 참조 폐기 (conventions §3)
    }
  }

  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
    return cryptoVerify(SIG_HASH, data, publicKeyPem, signature);
  }

  hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  // ── 내부: AES-256-GCM 암호화 보관 ──
  private async putEncrypted(keyRef: string, privateKeyPem: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
    await this.vault.put(keyRef, {
      iv: iv.toString('base64'),
      enc: enc.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
  }

  private async decrypt(keyRef: string): Promise<string> {
    const blob = await this.vault.get(keyRef);
    if (!blob) throw new Error(`key not found: ${keyRef}`);
    // authTagLength 명시 — 미지정 시 Node 가 4바이트까지 잘린 태그도 수용(위조 확률 2^-32)
    const d = createDecipheriv('aes-256-gcm', this.master, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(blob.enc, 'base64')), d.final()]).toString('utf8');
  }
}
