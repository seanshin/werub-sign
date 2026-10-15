// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { KeyAlgorithm, KeyStoreType } from '../types/pki.types';

/**
 * KeySigner 포트 — 개인키 취급의 유일한 경계.
 * conventions.md §3: 상위 코드는 키 바이트를 만지지 않는다.
 * SOFT(암호화 키스토어) ↔ HSM(클라우드 KMS/CloudHSM) 교체축. 구현은 infrastructure.
 *
 * 배포 형태: 이 포트를 원격 프록시(crypto-proxy)로 분리하면 앱은 개인키·HSM SDK를
 * 보유하지 않는다. 개발은 SOFT 백엔드 프록시로 진행, 운영은 백엔드만 클라우드 HSM 교체.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface GeneratedKey {
  keyRef: string; // 개인키 참조 (HSM 핸들 또는 암호화 blob). 백엔드 prefix(soft:/hsm:)
  publicKey: string; // PEM
  algorithm: KeyAlgorithm;
}

/**
 * 키 생성 옵션. keyClass로 HSM 표면을 최소화한다 —
 * HSM은 트러스트 앵커(CA Root/Issuing)에만, 환자/스태프 말단키는 SOFT.
 */
export interface GenerateOptions {
  keyClass?: KeyStoreType; // 'HSM' | 'SOFT' (기본 SOFT)
  ownerRef?: string;
}

export const KEY_SIGNER = Symbol('KEY_SIGNER');

export interface KeySigner {
  /** 키쌍 생성 — 개인키는 keyRef 뒤에 격리 보관(평문 반환 금지) */
  generate(algorithm?: KeyAlgorithm, opts?: GenerateOptions): Promise<GeneratedKey>;

  /** keyRef의 개인키로 data에 서명 (개인키는 함수 내부에서만 잠시 사용 후 폐기) */
  sign(keyRef: string, data: Buffer): Promise<Buffer>;

  /** 공개키로 서명 검증 (개인키 불요) */
  verify(publicKeyPem: string, data: Buffer, signature: Buffer): boolean;

  /** 해시 (SHA-256) */
  hash(data: Buffer): string;
}
