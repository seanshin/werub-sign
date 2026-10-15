// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHash, verify as cryptoVerify } from 'node:crypto';
import { GeneratedKey, GenerateOptions, KeySigner } from '../../domain/ports/key-signer.port';
import { KeyAlgorithm } from '../../domain/types/pki.types';

/**
 * AwsKmsKeySigner — 클라우드 HSM(AWS KMS) 백엔드. 개인키는 KMS 내부 상주(반출 불가),
 * 다이제스트만 송신해 서명 → 환자정보 외부반출과 분리(키 격리). HSM 최소화 정책상
 * keyClass=HSM(CA Root/Issuing)만 이 백엔드로 라우팅된다.
 *
 * 의존성은 optional — HSM_PROVIDER=aws-kms 일 때만 @aws-sdk/client-kms 필요(동적 로드).
 * 개발(HSM_PROVIDER=none)은 본 모듈을 로드하지 않으므로 SDK 미설치로 동작한다.
 *
 * IAM 권한: kms:CreateKey, kms:GetPublicKey, kms:Sign (필요 시 alias/tag 권한).
 * keyRef = `hsm:` + base64url({ keyId, spec }) — 라우터 prefix 호환 + 서명 알고리즘 복원.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class AwsKmsKeySigner implements KeySigner {
  private kms: any; // @aws-sdk/client-kms Client (동적 로드)
  private cmds: any;

  constructor(private readonly region?: string) {}

  private async client(): Promise<{ kms: any; cmds: any }> {
    if (this.kms) return { kms: this.kms, cmds: this.cmds };
    let sdk: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sdk = require('@aws-sdk/client-kms');
    } catch {
      throw new Error('@aws-sdk/client-kms 미설치 — HSM_PROVIDER=aws-kms 사용 시 `npm i @aws-sdk/client-kms` 필요');
    }
    this.kms = new sdk.KMSClient(this.region ? { region: this.region } : {});
    this.cmds = sdk;
    return { kms: this.kms, cmds: sdk };
  }

  async generate(algorithm: KeyAlgorithm = 'RSA-3072', opts?: GenerateOptions): Promise<GeneratedKey> {
    const { kms, cmds } = await this.client();
    const KeySpec = algorithm === 'ECDSA-P256' ? 'ECC_NIST_P256' : 'RSA_3072';
    const created = await kms.send(
      new cmds.CreateKeyCommand({
        KeySpec,
        KeyUsage: 'SIGN_VERIFY',
        Tags: opts?.ownerRef ? [{ TagKey: 'ownerRef', TagValue: opts.ownerRef }] : undefined,
      }),
    );
    const keyId = created.KeyMetadata.KeyId as string;
    const pub = await kms.send(new cmds.GetPublicKeyCommand({ KeyId: keyId }));
    const publicKey = this.derToPem(Buffer.from(pub.PublicKey));
    return { keyRef: this.encodeRef(keyId, KeySpec), publicKey, algorithm };
  }

  async sign(keyRef: string, data: Buffer): Promise<Buffer> {
    const { kms, cmds } = await this.client();
    const { keyId, spec } = this.decodeRef(keyRef);
    const SigningAlgorithm = spec === 'ECC_NIST_P256' ? 'ECDSA_SHA_256' : 'RSASSA_PKCS1_V1_5_SHA_256';
    const digest = createHash('sha256').update(data).digest();
    const out = await kms.send(
      new cmds.SignCommand({ KeyId: keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm }),
    );
    return Buffer.from(out.Signature);
  }

  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
    return cryptoVerify('sha256', data, publicKeyPem, signature);
  }

  hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  // ── 내부 ──
  private encodeRef(keyId: string, spec: string): string {
    return 'hsm:' + Buffer.from(JSON.stringify({ keyId, spec })).toString('base64url');
  }
  private decodeRef(keyRef: string): { keyId: string; spec: string } {
    return JSON.parse(Buffer.from(keyRef.slice('hsm:'.length), 'base64url').toString());
  }
  private derToPem(der: Buffer): string {
    const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
  }
}
