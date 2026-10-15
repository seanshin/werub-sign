// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { KeySigner } from '../../domain/ports/key-signer.port';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';
import { TsaProvider } from '../../domain/ports/tsa-provider.port';
import { TimestampToken } from '../../domain/types/pki.types';

const TSA_KEY_META = 'tsa:key';

/**
 * 자체 TSA (RFC3161 유사) — TSA 전용 키로 messageHash+시각에 서명한 시점 토큰.
 * 외부 공인 TSA 전환 시 동일 포트(TsaProvider)로 external-tsa.provider.ts 교체.
 *
 * production note: 표준 RFC3161 TimeStampToken(DER)이 필요하면 외부 TSA 또는
 * asn1 라이브러리로 교체. 본 구현은 시점 봉인의 암호적 실체를 보장한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SelfTsaProvider implements TsaProvider, OnModuleInit {
  private keyRef?: string;
  private publicKey?: string;

  constructor(
    private readonly signer: KeySigner,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /** 기동 시 영속된 TSA 공개키를 선로딩(생성 없음) → 재기동 직후 검증 가능. */
  async onModuleInit(): Promise<void> {
    await this.ensurePublicKey();
  }

  /**
   * TSA 키 확보 — 스토어에 있으면 복원(재기동 영속), 없으면 생성·영속.
   * 영속하지 않으면 재기동 후 기존 타임스탬프 검증이 깨져 LTV 증거력이 손상된다.
   * 검증은 publicKey만 필요(공개) → 영속 store만 있으면 재기동 후에도 timestampValid 유지.
   */
  private async ensureKey(): Promise<void> {
    if (this.keyRef && this.publicKey) return;
    const saved = await this.store.getMeta<{ keyRef: string; publicKey: string }>(TSA_KEY_META);
    if (saved?.keyRef && saved?.publicKey) {
      this.keyRef = saved.keyRef;
      this.publicKey = saved.publicKey;
      return;
    }
    const k = await this.signer.generate('RSA-3072');
    this.keyRef = k.keyRef;
    this.publicKey = k.publicKey;
    await this.store.saveMeta(TSA_KEY_META, { keyRef: k.keyRef, publicKey: k.publicKey });
  }

  /** 검증 전 publicKey 확보(서명 없이도 복원) */
  private async ensurePublicKey(): Promise<void> {
    if (this.publicKey) return;
    const saved = await this.store.getMeta<{ keyRef: string; publicKey: string }>(TSA_KEY_META);
    if (saved?.publicKey) {
      this.keyRef = saved.keyRef;
      this.publicKey = saved.publicKey;
    }
  }

  async stamp(messageHashHex: string): Promise<TimestampToken> {
    await this.ensureKey();
    const genTime = new Date().toISOString();
    const tbs = Buffer.from(
      JSON.stringify({ messageHashHex, genTime, tsaSerial: randomBytes(4).toString('hex') }),
    );
    const sig = await this.signer.sign(this.keyRef!, tbs);
    return { tsaProvider: 'SELF', tbs: tbs.toString('base64'), sig: sig.toString('base64'), genTime };
  }

  verify(token: TimestampToken, expectedHashHex: string): boolean {
    if (!this.publicKey) return false;
    const tbs = Buffer.from(token.tbs, 'base64');
    const parsed = JSON.parse(tbs.toString()) as { messageHashHex: string };
    const sigOk = this.signer.verify(this.publicKey, tbs, Buffer.from(token.sig, 'base64'));
    return sigOk && parsed.messageHashHex === expectedHashHex;
  }
}
