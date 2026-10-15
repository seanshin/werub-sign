// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * PKI 도메인 타입 (순수 — 외부 의존 없음)
 * conventions.md §2 (domain 레이어는 외부 레이어 의존 금지)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export type OwnerType = 'CA' | 'STAFF' | 'PATIENT' | 'WITNESS' | 'PROXY' | 'SERVICE';
export type KeyAlgorithm = 'RSA-3072' | 'ECDSA-P256';
export type KeyStoreType = 'SOFT' | 'HSM';

/** 인증서 TBS(To-Be-Signed) 본문 — 이 구조에 발급자 키로 서명한다 */
export interface CertificateTbs {
  serialNumber: string;
  subjectDn: string;
  issuerDn: string;
  ownerType: OwnerType;
  ownerRef?: string;
  publicKey: string; // PEM (SPKI)
  notBefore: string; // ISO8601
  notAfter: string; // ISO8601 (★ 유한 — mock 2099 무기한 금지)
  algorithm: string;
  ciHash?: string; // PATIENT
  licenseNumber?: string; // STAFF
}

export interface IssuedCertificate {
  tbs: CertificateTbs;
  signature: string; // base64 — 발급자(상위 CA) 키 서명
  issuerKeyRef?: string;
  fingerprint: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  keyRef?: string; // 소유자 개인키 참조 (말단 인증서)
  selfSigned?: boolean;
}

export interface TimestampToken {
  tsaProvider: string;
  tbs: string; // base64
  sig: string; // base64
  genTime: string; // ISO8601 (TSA가 보증한 시각)
}

export interface SignatureVerification {
  cryptoOk: boolean; // 공개키 실제 서명 검증
  timestampValid: boolean;
  chainValid: boolean;
  notExpired: boolean;
  notRevoked: boolean;
  overall: boolean;
}
