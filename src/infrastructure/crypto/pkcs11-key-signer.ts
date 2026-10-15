// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { GeneratedKey, GenerateOptions, KeySigner } from '../../domain/ports/key-signer.port';
import { KeyAlgorithm } from '../../domain/types/pki.types';

/**
 * Pkcs11KeySigner — 온프레 HSM(PKCS#11) 백엔드. AWS CloudHSM·Thales·Utimaco 등
 * 표준 PKCS#11 모듈(.so)을 통해 키를 HSM 내부에 생성·서명한다.
 *
 * 개인키는 token object(CKA_TOKEN=true)로 HSM에 영속, CKA_SENSITIVE·!CKA_EXTRACTABLE 로
 * **비추출**(평문 반출 불가). keyRef = `hsm:` + base64url({ label, alg }) — 라우터 prefix 호환,
 * 서명/재기동 시 label 로 HSM 내 개인키를 조회한다(프로세스 캐시 의존 없음).
 *
 * HSM 최소화 정책상 keyClass=HSM(CA Root/Issuing)만 이 백엔드로 라우팅된다.
 * verify/hash 는 공개키·해시 연산이라 HSM 불요 — 로컬 수행.
 *
 * 의존성은 optional — HSM_PROVIDER=pkcs11|aws-cloudhsm 일 때만 graphene-pk11(+pkcs11js)
 * 네이티브 모듈 필요(동적 로드). 개발(HSM_PROVIDER=none)은 본 모듈을 로드하지 않는다.
 *
 * 환경변수:
 *   PKCS11_MODULE       (필수) 벤더 PKCS#11 라이브러리 경로(.so/.dylib)
 *   PKCS11_PIN          (필수) 사용자 PIN
 *   PKCS11_TOKEN_LABEL  (선택) 토큰 라벨로 슬롯 탐색(권장)
 *   PKCS11_SLOT         (선택) 토큰존재 슬롯 컬렉션 내 인덱스(라벨 미지정 시)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface Pkcs11Config {
  module: string;
  pin: string;
  tokenLabel?: string;
  slot?: number;
}

export class Pkcs11KeySigner implements KeySigner {
  private graphene: any; // graphene-pk11 (동적 로드)
  private mod: any; // Module
  private session: any; // Session (로그인 상태)

  constructor(private readonly cfg: Pkcs11Config) {
    if (!cfg.module) throw new Error('PKCS11_MODULE 미설정 — 벤더 PKCS#11 라이브러리 경로 필요');
    if (!cfg.pin) throw new Error('PKCS11_PIN 미설정 — HSM 사용자 PIN 필요');
  }

  /** 모듈 로드 + 슬롯 선택 + 로그인 (최초 1회) */
  private connect(): { g: any; session: any } {
    if (this.session) return { g: this.graphene, session: this.session };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.graphene = require('graphene-pk11');
    } catch {
      throw new Error(
        'graphene-pk11 미설치 — HSM_PROVIDER=pkcs11|aws-cloudhsm 사용 시 `npm i graphene-pk11`(네이티브) 필요',
      );
    }
    const g = this.graphene;
    this.mod = g.Module.load(this.cfg.module, 'sign-hsm');
    this.mod.initialize();
    const slots = this.mod.getSlots(true); // 토큰 존재 슬롯만
    if (slots.length === 0) throw new Error(`PKCS#11 토큰 슬롯 없음 (module=${this.cfg.module})`);
    const slot = this.pickSlot(slots);
    const session = slot.open(g.SessionFlag.SERIAL_SESSION | g.SessionFlag.RW_SESSION);
    session.login(this.cfg.pin, g.UserType.USER);
    this.session = session;
    return { g, session };
  }

  private pickSlot(slots: any): any {
    if (this.cfg.tokenLabel) {
      for (let i = 0; i < slots.length; i++) {
        const s = slots.items(i);
        if (s.getToken().label.trim() === this.cfg.tokenLabel) return s;
      }
      throw new Error(`PKCS#11 토큰 라벨 '${this.cfg.tokenLabel}' 슬롯 없음`);
    }
    return slots.items(this.cfg.slot ?? 0);
  }

  async generate(algorithm: KeyAlgorithm = 'RSA-3072', opts?: GenerateOptions): Promise<GeneratedKey> {
    const { g, session } = this.connect();
    const label = `sign-${opts?.ownerRef ? opts.ownerRef.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) + '-' : ''}${randomBytes(8).toString('hex')}`;
    const id = randomBytes(16);
    const common = { token: true, label, id, private: true };

    let publicKey: any;
    if (algorithm === 'ECDSA-P256') {
      const keys = session.generateKeyPair(
        g.KeyGenMechanism.ECDSA,
        { keyType: g.KeyType.ECDSA, paramsEC: P256_OID, token: true, verify: true, label, id },
        { keyType: g.KeyType.ECDSA, ...common, sign: true, sensitive: true, extractable: false },
      );
      publicKey = this.ecPublicPem(keys.publicKey);
    } else {
      const keys = session.generateKeyPair(
        g.KeyGenMechanism.RSA,
        { keyType: g.KeyType.RSA, modulusBits: 3072, publicExponent: Buffer.from([0x01, 0x00, 0x01]), token: true, verify: true, label, id },
        { keyType: g.KeyType.RSA, ...common, sign: true, sensitive: true, extractable: false },
      );
      publicKey = this.rsaPublicPem(keys.publicKey);
    }
    return { keyRef: this.encodeRef(label, algorithm), publicKey, algorithm };
  }

  async sign(keyRef: string, data: Buffer): Promise<Buffer> {
    const { g, session } = this.connect();
    const { label, alg } = this.decodeRef(keyRef);
    const priv = this.findPrivate(g, session, label);
    if (alg === 'ECDSA-P256') {
      // PKCS#11 ECDSA: 입력은 사전 해시(다이제스트), 출력은 raw r||s → DER 변환(표준 검증 호환)
      const digest = createHash('sha256').update(data).digest();
      const s = session.createSign('ECDSA', priv);
      const raw = s.once(digest); // 64바이트 r||s
      return p1363ToDer(raw);
    }
    // RSA: SHA256_RSA_PKCS 가 내부 해시+PKCS1 v1.5 서명 → cryptoVerify('sha256') 와 호환
    const s = session.createSign('SHA256_RSA_PKCS', priv);
    s.update(data);
    return s.final();
  }

  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean {
    return cryptoVerify('sha256', data, publicKeyPem, signature);
  }

  hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /** 종료 — 세션/모듈 정리(graceful shutdown) */
  close(): void {
    try {
      this.session?.logout();
      this.session?.close();
      this.mod?.finalize();
    } catch {
      /* 무시 */
    }
    this.session = undefined;
  }

  // ── 내부 ──
  private findPrivate(g: any, session: any, label: string): any {
    const objs = session.find({ class: g.ObjectClass.PRIVATE_KEY, label });
    if (objs.length === 0) throw new Error(`PKCS#11 개인키 미발견 (label=${label})`);
    return objs.items(0).toType();
  }

  private rsaPublicPem(pub: any): string {
    const a = pub.getAttribute({ modulus: null, publicExponent: null });
    const jwk = { kty: 'RSA', n: toB64Url(a.modulus), e: toB64Url(a.publicExponent) };
    return createPublicKey({ key: jwk as any, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
  }

  private ecPublicPem(pub: any): string {
    const a = pub.getAttribute({ pointEC: null });
    // CKA_EC_POINT = DER OCTET STRING( 0x04 || X || Y ) — OCTET STRING 래퍼 제거
    const pt = stripDerOctetString(a.pointEC);
    if (pt[0] !== 0x04 || pt.length !== 65) throw new Error('예상치 못한 EC point 형식(P-256 uncompressed 아님)');
    const x = pt.subarray(1, 33);
    const y = pt.subarray(33, 65);
    const jwk = { kty: 'EC', crv: 'P-256', x: toB64Url(x), y: toB64Url(y) };
    return createPublicKey({ key: jwk as any, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
  }

  private encodeRef(label: string, alg: KeyAlgorithm): string {
    return 'hsm:' + Buffer.from(JSON.stringify({ label, alg })).toString('base64url');
  }
  private decodeRef(keyRef: string): { label: string; alg: KeyAlgorithm } {
    return JSON.parse(Buffer.from(keyRef.slice('hsm:'.length), 'base64url').toString());
  }
}

const P256_OID = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]); // 1.2.840.10045.3.1.7

function toB64Url(b: Buffer): string {
  return Buffer.from(b).toString('base64url');
}

/** DER OCTET STRING(0x04 len ...) 래퍼 제거 — 내부 바이트 반환 */
function stripDerOctetString(der: Buffer): Buffer {
  if (der[0] !== 0x04) return der; // 이미 raw 포인트
  let len = der[1];
  let off = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[off++];
  }
  return der.subarray(off, off + len);
}

/** P1363(raw r||s) → DER ECDSA-Sig-Value(SEQUENCE{INTEGER r, INTEGER s}) */
function p1363ToDer(raw: Buffer): Buffer {
  const half = raw.length / 2;
  const r = derInt(raw.subarray(0, half));
  const s = derInt(raw.subarray(half));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function derInt(v: Buffer): Buffer {
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++; // 선행 0 제거
  let val = v.subarray(i);
  if (val[0] & 0x80) val = Buffer.concat([Buffer.from([0x00]), val]); // 음수 방지 패딩
  return Buffer.concat([Buffer.from([0x02, val.length]), val]);
}
