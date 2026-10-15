// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 저장소 레코드 타입 (도메인 — 순수). 포트/어댑터가 공유.
 * conventions §2: domain은 외부 레이어 의존 금지.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { IssuedCertificate } from './pki.types';

/** PAdES-LTA 장기검증(LTV) 봉인 자료 — design §10 */
export interface LtvData {
  format: string; // PAdES-B-LTA
  chain: unknown[]; // [leaf, issuing, root] 인증서 (자체 검증 가능)
  ocsp: { serial: string; status: string; at: string }; // 서명 시점 폐기상태
  archiveTimestamp: { genTime: string; tsaProvider: string; token: unknown }; // 아카이브 TS
}

/** 서명 산출물 (서명값 + 시점 + LTV) */
export interface SignatureArtifact {
  signatureValue: string;
  signatureAlgorithm: string;
  signedAttrsHash: string;
  timestamp: { genTime: string; tsaProvider: string; token: unknown };
  ltv?: LtvData;
}

/** 감사 해시체인 엔트리 */
export interface AuditEntry {
  eventType: string;
  data: unknown;
  occurredAt: string;
  prevHash: string;
  entryHash: string;
}

export interface StoredCert {
  certId: string;
  cert: IssuedCertificate;
  x509Pem?: string; // 실 X.509 말단 인증서 (표준화 — PAdES/CMS용)
  x509ChainPem?: string;
  x509Serial?: string;
}

export interface StoredParticipant {
  participantId: string;
  signerRole: string;
  signerType: string;
  externalSignerRef?: string;
  displayName: string;
  signOrder: number;
  certSerial: string;
  requiredIdentityLevel: string; // NONE/INPERSON/MOBILE_NAME/PASS/APP_STEPUP/STAFF_SSO
  relationship?: string; // PROXY 대리인↔환자 관계 (법정대리인/배우자/직계가족/응급보호자)
  onBehalfOf?: string; // PROXY 대리 대상(환자) 식별
  status: 'PENDING' | 'IDENTIFIED' | 'SIGNED' | 'DECLINED';
}

export interface StoredRequest {
  requestId: string;
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  signMode: string;
  callbackUrl?: string;
  status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED' | 'REVOKED' | 'WITHDRAWN' | 'FAILED' | 'SUPERSEDED';
  createdAt?: string; // ISO — 생성 시각(목록 최신순 정렬·기간 필터). 레거시 행은 부재 가능(저장소가 보정).
  expiresAt?: string; // ISO — 미서명 만료 시각(배치가 EXPIRED 처리)
  requiredSigners: number;
  completedSigners: number;
  participants: StoredParticipant[];
  createdBy?: string; // 생성 소비자(hospitalrun·pacs·erp·console) — 소비자별 webhook 시크릿·감사 귀속
  // C-2 문서 개정 재동의 — 버전 체인. 개정 시 원본 status=SUPERSEDED·supersededBy=신규, 신규 supersedes=원본.
  version?: number; // 1=최초, 개정마다 +1
  supersedes?: string; // 이 요청이 대체한 이전 requestId
  supersededBy?: string; // 이 요청을 대체한 다음 requestId(현행 아님 표시)
  // 계약 트랙(signMode=CONTRACT) 목록 필터 캐시(A3) — 정본은 contract-meta(saveMeta),
  // 보관/분류/라벨 변경 시 ContractService 가 동기화(saveRequest). DB 푸시다운·상한 스캔 제거용.
  ctArchived?: boolean;
  ctCategory?: string;
  ctLabels?: string[];
}

export interface StoredIdentity {
  id: string;
  subjectRef?: string;
  method: string;
  provider: string;
  providerTxId?: string;
  verifiedName?: string;
  ciHash?: string;
  phoneHash?: string;
  result: 'SUCCESS' | 'FAIL';
  verifiedAt: string;
  role?: string; // STAFF: 토큰 role (예: DOCTOR)
  employeeNumber?: string; // STAFF: 사번(보조 식별)
  acr?: string; // 인증 강도(step-up)
}

export interface StoredSignature {
  signatureId: string;
  requestId: string;
  participantId: string;
  certSerial: string;
  signerRole: string;
  result: SignatureArtifact;
  cmsSignature?: string; // 실 CMS(PKCS#7/CAdES-BES) detached 서명 — 표준화
  x509Serial?: string;
  identityVerificationId: string; // §15 서명-인증 강결합 (NOT NULL)
  identityMethod: string;
  signerType?: string;
  relationship?: string; // PROXY 대리 서명 관계(봉인·감사)
  onBehalfOf?: string;
  signedAt: string;
}

export interface Revocation {
  serialNumber: string;
  revokedAt: string;
  reason: string;
  crlNumber: number;
}

/** 감사체인 TSA 앵커 — 내부자 전체 재계산 위변조 탐지 (design §16) */
export interface StoredAnchor {
  key: string; // requestId 등 감사 체인 키
  headHash: string; // 앵커 시점 체인 head(entryHash)
  entryCount: number;
  tsToken: unknown; // 자체 TSA 토큰(로컬 암호 검증)
  periodAt: string;
  /**
   * 외부 RFC3161 TSA 토큰(S1 앵커 이중화) — 운영자 독립 증거.
   * 자체 TSA 키는 운영자 수중이라 재앵커 위조가 가능하지만, 외부 토큰은 불가.
   * 발급 실패 시 비어 있을 수 있고(best-effort), 주기 스윕이 보충한다.
   */
  externalTokens?: unknown[];
}

export interface WebhookDelivery {
  id: string;
  eventId: string; // 멱등 키 — 재시도 시 동일 body 재구성에 사용
  requestId: string;
  eventType: string;
  targetUrl: string;
  payload: unknown;
  hmac: string;
  // DEAD=최대 재시도 초과 / DISCARDED=운영자가 폐기(수신처 폐지 등 — 재발송 대상에서 제외, 이력은 보존)
  status: 'PENDING' | 'SENT' | 'FAILED' | 'DEAD' | 'DISCARDED';
  /**
   * 서명에 쓸 시크릿의 **환경변수 이름**(값 아님) — 재시도·재발송이 최초 전송과 같은 시크릿으로 서명하도록.
   * 미지정(구 레코드)은 HIS_WEBHOOK_SECRET 폴백.
   */
  secretEnv?: string;
  attempts: number;
  lastAttempt?: string;
  /** 폐기 처리(DISCARDED) 기록 — 누가·언제·왜. 레코드는 지우지 않고 상태만 바꾼다(감사 추적 보존). */
  discardedAt?: string;
  discardedBy?: string;
  discardReason?: string;
}

/** 발송 이력 — 연락처 평문 미저장(마스킹만). 관리 콘솔 발송 이력 화면용. */
export interface NotifyRecord {
  id: string;
  requestId: string;
  participantId: string;
  channel: string; // ALIMTALK | SMS
  provider: string; // mock | kakao | sms
  result: string; // SENT | FAIL | SKIP
  reason?: string;
  providerMsgId?: string;
  toMasked: string; // 수신번호 마스킹(끝 4자리 등) — 평문 금지
  title?: string;
  sentAt: string;
}
