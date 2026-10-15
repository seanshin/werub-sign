// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { AuditEntry, NotifyRecord, Revocation, StoredAnchor, StoredCert, StoredIdentity, StoredRequest, StoredSignature, WebhookDelivery } from '../types/store.types';
import { RequestQuery } from '../request-query';
import { CertQuery } from '../cert-query';

/**
 * SignStore 포트 — 영속화 추상화 (InMemory ↔ Prisma 교체축).
 * conventions §2: application은 이 포트에만 의존(구체 저장소 의존 금지).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const SIGN_STORE = Symbol('SIGN_STORE');

export interface SignStore {
  // 인증서
  saveCert(c: StoredCert): Promise<void>;
  getCertBySerial(serial: string): Promise<StoredCert | null>;
  hasCertSerial(serial: string): Promise<boolean>;
  allCerts(): Promise<StoredCert[]>;
  /** 목록 질의(검색·페이지, CA 제외, notBefore 최신순) — DB 푸시다운(Prisma)·인메모리. total=필터 후 전체 수. */
  queryCerts(query: CertQuery): Promise<{ items: StoredCert[]; total: number }>;

  // 서명요청
  saveRequest(r: StoredRequest): Promise<void>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  getRequestIdByIdempotency(key: string): Promise<string | null>;
  allRequests(): Promise<StoredRequest[]>;
  /** 목록 질의(상태·기간·검색·페이지) — DB 푸시다운(Prisma)·인메모리(InMemory/File). total=필터 후 전체 수. */
  queryRequests(query: RequestQuery): Promise<{ items: StoredRequest[]; total: number }>;
  /** participantId 로 소속 요청 조회 — 서명 제출 hot path 에서 allRequests 전량 스캔을 대체(참가자 배열 JSON 조건 푸시다운). */
  getRequestByParticipant(participantId: string): Promise<StoredRequest | null>;

  // 서명
  saveSignature(s: StoredSignature): Promise<void>;
  signaturesByRequest(requestId: string): Promise<StoredSignature[]>;

  // 본인확인
  saveIdentity(i: StoredIdentity): Promise<void>;
  getIdentity(id: string): Promise<StoredIdentity | null>;

  // 감사 (key = requestId 또는 cert:serial)
  /**
   * 체인 append. 같은 스트림에 **동일 prevHash 가 이미 있으면 거부**해야 한다(R16 — 저장소 수준 보장).
   * 거부는 `StoreConflictError` 로 던지며, 호출자는 lastAudit 재조회 후 재시도한다.
   */
  appendAudit(key: string, entry: AuditEntry): Promise<void>;
  lastAudit(key: string): Promise<AuditEntry | null>;
  auditEntries(key: string): Promise<AuditEntry[]>;
  /** 최근 N개 엔트리(시간 오름차순) — 창(window) 집계에서 전체 스트림 로드를 피한다(예: 로그인 실패 폭주 감시). */
  auditRecent(key: string, limit: number): Promise<AuditEntry[]>;
  auditKeys(prefix: string): Promise<string[]>; // prefix 매칭 감사 스트림 키 목록
  /** 최근 활동(최대 seq) 순 상위 N개 스트림 키 — 감사체인 표본 감시에서 "임의 N"이 아닌 "실제 최근 N"을 보장. */
  auditKeysByRecency(limit: number): Promise<string[]>;

  // 감사 TSA 앵커
  saveAnchor(anchor: StoredAnchor): Promise<void>;
  getLatestAnchor(key: string): Promise<StoredAnchor | null>;

  // 폐기 (CRL/OCSP)
  saveRevocation(r: Revocation): Promise<void>;
  getRevocation(serial: string): Promise<Revocation | null>;
  allRevocations(): Promise<Revocation[]>;
  nextCrlNumber(): Promise<number>;
  currentCrlNumber(): Promise<number>;

  // Webhook outbox
  saveWebhook(d: WebhookDelivery): Promise<void>;
  updateWebhook(d: WebhookDelivery): Promise<void>;
  getWebhook(id: string): Promise<WebhookDelivery | null>; // 재시도/재발송 직전 최신 상태 재확인(스냅샷 stale 재전송 방지)
  listWebhooks(): Promise<WebhookDelivery[]>; // 재시도/조회 배치용(전량)
  webhooksByStatus(statuses: string[]): Promise<WebhookDelivery[]>; // 상태별 조회(재시도·DEAD 집계) — 전량 스캔 회피 JSON 푸시다운
  webhooksByRequest(requestId: string): Promise<WebhookDelivery[]>; // HIS reconcile 조회

  // 발송 이력(연락처 마스킹) — 관리 콘솔 발송 이력
  saveNotify(r: NotifyRecord): Promise<void>;
  listNotify(): Promise<NotifyRecord[]>;
  notifyByRequest(requestId: string): Promise<NotifyRecord[]>;

  // 메타 KV — CA 번들(재기동 영속) 등 단일 슬롯 영속화
  saveMeta(key: string, value: unknown): Promise<void>;
  getMeta<T>(key: string): Promise<T | null>;
  /**
   * 값 + 버전 동시 조회 — 낙관적 잠금(CAS) 기반 read-modify-write 용(R16).
   * version=null 은 "슬롯 없음". 버전은 저장소가 정하는 불투명 값(Prisma=행 seq).
   */
  getMetaVersioned<T>(key: string): Promise<{ value: T | null; version: number | null }>;
  /**
   * 조건부 저장 — 현재 버전이 `expectedVersion` 과 같을 때만 기록한다.
   * 다른 노드/프로세스가 먼저 갱신했으면 **아무것도 쓰지 않고 false**(호출자가 재조회 후 재시도).
   * 인프로세스 뮤텍스와 달리 다중 노드·롤링 배포에서도 lost update 를 막는다.
   */
  saveMetaIfUnchanged(key: string, expectedVersion: number | null, value: unknown): Promise<boolean>;
  /** 존재 여부만 확인 — 대용량 슬롯(암호화 문서 블롭)을 값까지 읽지 않기 위한 경량 경로. */
  metaExists(key: string): Promise<boolean>;
  deleteMeta(key: string): Promise<void>; // 슬롯 파기(포털 문서 블롭 파기·토큰 만료 등)

  // 운영 readiness — 저장소 도달 가능 여부
  ping(): Promise<boolean>;
}
