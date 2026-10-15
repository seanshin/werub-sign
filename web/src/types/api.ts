// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/* ============================================================
   API 공통 타입 — 백엔드 응답 봉투 및 오류 구조
   ============================================================ */

export interface ApiResponse<T> {
  data: T;
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
}

/** 서버 페이지네이션 응답 — data 배열 + page 메타 */
export interface Paged<T> {
  data: T[];
  page: PageMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ── 상태 타입 ── */
export type RequestStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED' | 'WITHDRAWN' | 'SUPERSEDED';
export type ParticipantStatus = 'PENDING' | 'SIGNED';
export type SignerType = 'PATIENT' | 'STAFF' | 'WITNESS' | 'PROXY';
export type ProxyRelationship = '법정대리인' | '배우자' | '직계가족' | '응급보호자';
export type IdentityLevel = 'INPERSON' | 'NONE' | 'PASS' | 'MOBILE_NAME' | 'APP_STEPUP' | 'STAFF_SSO';
export type SignMode = string;
export type NotifyChannel = 'ALIMTALK' | 'SMS' | 'EMAIL';

/* ── Participant DTO (toDto에서 확인한 필드) ── */
export interface ParticipantDto {
  participantId: string;
  signerRole: string;
  signerType: string; // PATIENT/STAFF/WITNESS/PROXY + APPROVER(결재)·INTERNAL/EXTERNAL_PARTY(계약) 등 확장 문자열
  displayName: string;
  requiredIdentityLevel: IdentityLevel;
  certSerial: string;
  signOrder: number;
  status: ParticipantStatus;
}

/* ── Request DTO ── */
export interface RequestDto {
  requestId: string;
  status: RequestStatus;
  title: string;
  externalDocId: string;
  signMode: SignMode;
  createdBy?: string; // 출처 소비자(hospitalrun·pacs·erp·console)
  createdAt?: string; // 생성 시각(ISO) — 최신순·생성일 표시
  expiresAt: string;
  version?: number; // C-2 문서 개정 버전(1=최초)
  supersedes?: string; // 이 요청이 대체한 이전 requestId
  supersededBy?: string; // 이 요청을 대체한 다음 requestId(현행 아님)
  requiredSigners: number;
  completedSigners: number;
  participants: ParticipantDto[];
}

/* ── 전자결재(상신→결재) ── */
export interface ApprovalDto extends RequestDto {
  highRisk?: boolean;
  docType?: string | null;
  currentStep?: number | null;
  currentApprover?: string | null;
  authLogCount?: number;
}
export interface ApprovalLineItem {
  approverId: string;
  displayName: string;
  order: number;
  certSerial?: string; // 미지정 시 서버 자동발급
  role?: string;
}
export interface CreateApprovalBody {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  docType?: string;
  highRisk?: boolean;
  ttlDays?: number;
  line: ApprovalLineItem[];
}
export interface ApprovalActBody {
  decision: 'APPROVE' | 'REJECT';
  opinion?: string;
  stepUp?: { mfaCode?: string; method?: string; ci?: string; phone?: string };
}
export interface ApprovalActResult {
  requestId: string;
  status: string;
  step: number;
  decision: 'APPROVE' | 'REJECT';
}

/** 통합 결재 인증로그 1행 — 감사 엔트리 + 소속 결재(requestId·title) */
export type ApprovalAuditRow = AuditEntry & { requestId: string; title?: string | null };

/** 문서 인증(wsign) 1행 — 외부 문서인증 어테스테이션(감사 엔트리 + 문서 메타) */
export type WsignDocRow = AuditEntry & { stream: string; targetRef?: string; title?: string; documentHash?: string; system?: string; chainValid?: boolean };

/** 문서 인증(wsign) 상세 — 문서 스트림의 전체 어테스테이션 이력 + 무결성 */
export interface WsignDocDetail {
  stream: string;
  targetRef?: string;
  title?: string;
  documentHash?: string;
  system?: string;
  hashAlgo?: string;
  chainValid: boolean;
  count: number;
  entries: AuditEntry[];
}

/* ── Portal Info ── */
export interface PortalInfo {
  /** 일반 전자계약 접근암호 잠금 — true 면 아래 필드는 제목·표시명만 유효(내용 비노출), unlock 후 재조회. */
  locked?: boolean;
  request: {
    title: string;
    externalDocId: string;
    documentHashPrefix: string;
    signMode: string;
  };
  signer: {
    role: string;
    displayName: string;
    requiredIdentityLevel: IdentityLevel;
    signOrder: number;
    status: ParticipantStatus;
  };
  canSignNow: boolean;
  identityDemo?: boolean; // 실서비스 전(idv mock) — 본인인증 생략 가능
  documentAvailable?: boolean; // 서명 대상 PDF 열람 가능(포털 문서 뷰어)
  inputFields?: Array<{ label: string; fieldType?: FieldValueType; maxLength?: number }>; // fill-at-signing(A4) — 서명 시 기재할 입력란(계약 트랙)
  expiresAt: string;
}

/* ── 일반 전자계약(행정·일반 계약) ── */
export interface ContractRow {
  requestId: string;
  title: string;
  externalDocId: string;
  status: RequestStatus;
  createdAt?: string;
  expiresAt?: string;
  requiredSigners: number;
  completedSigners: number;
  labels: string[];
  category?: string; // 계약 분류
  hasAccessCode: boolean;
  signingMode?: 'SEQUENTIAL' | 'PARALLEL'; // 순차|동시
  hasDocument?: boolean;
  lastSentAt?: string | null; // 마지막 서명요청 이메일([교부] 제외)
  archived?: boolean;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  currentStep?: { order: number; kind: 'INTERNAL' | 'EXTERNAL'; displayName: string; username?: string } | null;
}
export interface ContractDto extends RequestDto {
  labels: string[];
  hasAccessCode: boolean;
  signingMode?: 'SEQUENTIAL' | 'PARALLEL';
  parties: Array<{ displayName: string; email: string; order: number }>; // email 마스킹됨
  internalNotify?: Array<{ username: string; displayName: string; order: number; email: string | null }>; // 내부 서명자 알림 이메일(마스킹, null=미등록)
  documentAvailable: boolean;
  auditCount: number;
  archived?: boolean;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  signMarks?: PlacedMark[]; // 서명란 좌표(손글씨 합성 위치)
  verifyToken?: string | null; // 완료문서 QR 검증 링크 토큰(체결 후)
  category?: string; // 계약 분류
  lastSentAt?: string | null; // 발송됨 여부 — 첨부 편집 가능(작성·미발송) 판정
}
/** 새 계약 프리셋(U5) — 자주 쓰는 요청 구성(제목·서명자열·방식·라벨·분류). 접근암호 값 미저장. 기관 공용. */
export interface ContractPreset {
  presetId: string;
  name: string;
  title?: string;
  category?: string;
  labels?: string[];
  signingMode?: 'SEQUENTIAL' | 'PARALLEL';
  useAccessCode?: boolean;
  signers: Array<{ kind: 'INTERNAL' | 'EXTERNAL'; displayName: string; order: number; username?: string; email?: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
/** 계약 첨부(열람용 부속 문서, 설계 §11) — 서명 대상 아님, SHA-256 감사 봉인. */
export interface ContractAttachment {
  attachId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: string;
}
export interface ContractCategorySummary {
  category: string;
  total: number;
  completed: number;
}
export interface ContractSignerItem {
  kind: 'INTERNAL' | 'EXTERNAL';
  displayName: string;
  order: number;
  signerRole?: string;
  username?: string; // INTERNAL 콘솔 계정
  email?: string; // EXTERNAL 수신
  certSerial?: string;
}
export interface CreateContractBody {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  ttlDays?: number;
  labels?: string[];
  category?: string; // 계약 분류
  accessCode?: string;
  signingMode?: 'SEQUENTIAL' | 'PARALLEL'; // 순차(기본)|동시(전원 병렬)
  signMarks?: PlacedMark[]; // 서명란 좌표(서명 후 손글씨 합성 위치)
  signers: ContractSignerItem[];
}
export interface ContractSendResult {
  participantId: string;
  channel?: string;
  result: string;
  reason?: string;
  url?: string;
}
export interface ContractSignResult {
  requestId: string;
  status: string;
  step: number;
}
/** 기재값(fill-at-signing) 증적 — 서명자별 기재 원문·봉인 해시·무결성 재검증 결과 */
export interface ContractFillValues {
  participantId: string;
  displayName: string;
  signerNo: number;
  sha256: string;
  filledAt?: string;
  via?: string;
  integrityOk: boolean;
  values: Array<{ index: number; label: string; fieldType: FieldValueType; value: string }>;
}
export interface ContractStats {
  total: number;
  created: number;
  inProgress: number;
  completed: number;
  open: number;
  expiringSoon?: number; // 7일 이내 만료 예정(미완료)
  archived?: number; // 보관 처리된 계약 수
}
export interface ContractReminderStatus {
  remindAfterDays: number; // 0=자동 독촉 끔
  expiryWarningHours: number;
  deliveryTtlHours: number;
  schedulerMin: number;
  provider: string; // mock=실발송 없음 / smtp=원내 메일서버
  smtpConfigured: boolean;
  portalBaseUrlSet: boolean;
}
export interface ContractAutoRemindResult {
  reminded: number;
  expiryWarned: number;
  skipped: number;
}
export interface ContractDeliverLink {
  email: string; // 마스킹됨
  url: string;
  expiresAt: string;
}
export interface ContractDeliveryInfo {
  title: string;
  status: RequestStatus;
  expiresAt: string; // 교부 링크 만료
  documentAvailable: boolean;
  extendable?: boolean; // 교부 링크 1회 연장 가능 여부
  forwardRemaining?: number; // 다른 주소로 전달 가능한 남은 횟수
}
export interface ContractVerifyPublic {
  title: string;
  status: RequestStatus;
  completedAt: string | null;
  documentHash: string;
  signers: Array<{ displayName: string; type: 'INTERNAL' | 'EXTERNAL'; signedAt: string | null }>;
  verified: boolean;
  signatureCount: number;
  auditChainValid: boolean;
  documentPublic?: boolean; // 기재 정보가 봉인된 계약은 문서 비공개(요약 검증만) — D2
}
export interface AddressEntry {
  id: string;
  email: string;
  name: string;
  org?: string;
  memo?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ContractTemplateField {
  key: string;
  label: string;
  type: 'text' | 'date' | 'money' | 'textarea';
  placeholder?: string;
  required?: boolean;
}
export interface ContractTemplateMeta {
  id: string;
  name: string;
  category: string;
  description: string;
  builtin?: boolean; // 내장 여부. 커스텀=false
  overridden?: boolean; // 내장이 기관 편집본(오버라이드)으로 대체됨
}
export interface ContractTemplate extends ContractTemplateMeta {
  fields: ContractTemplateField[];
  body: string; // {{key}} 플레이스홀더 포함
}
/** 서식 변경 이력 한 건(변경 직전 스냅샷) */
export interface TemplateVersion {
  version: number;
  savedAt: string;
  savedBy: string;
  action: 'edit' | 'reset' | 'restore';
  name: string;
  category: string;
  description: string;
  fields: ContractTemplateField[];
  body: string;
}
export interface CustomTemplateBody {
  name: string;
  category?: string;
  description?: string;
  fields?: ContractTemplateField[];
  body: string;
}
/** 리치 본문 블록 — 에디터→PDF 조판 매핑(h1/h2=굵게 큰 글씨, 문단=굵기 런) */
export interface ComposeRun {
  text: string;
  bold?: boolean;
}
export interface ComposeBlock {
  type: 'heading' | 'paragraph' | 'listItem' | 'tableRow'; // A5: 목록·표
  level?: number; // heading 1|2 · listItem 들여쓰기 깊이(1-base)
  align?: 'left' | 'center' | 'right'; // A5 정렬 — 미지정 기본: h1=center, 그 외 left
  ordered?: boolean; // listItem — true=번호 목록
  index?: number; // listItem 번호(ordered)
  header?: boolean; // tableRow — 헤더 행
  cells?: ComposeRun[][]; // tableRow — 셀별 런(연속 tableRow 가 한 표로 조판됨)
  runs: ComposeRun[];
}

/** 자유 배치 마크 — 배치 편집기 좌표(페이지 상대 0..1, y=상단 기준 좌상단 모서리) */
export interface PlacedMark {
  page: number; // 1-base
  x: number;
  y: number;
  w: number;
  h: number;
  signer: number; // 서명자 순번(1-base)
  type: 'SIGN' | 'FIELD';
  label?: string;
  fieldType?: FieldValueType; // 입력란 값 타입(미지정=text)
}

/** 입력란(FIELD) 값 타입 — 서버가 검증·정규화(날짜 YYYY-MM-DD·금액 3자리 구분) */
export type FieldValueType = 'text' | 'date' | 'money' | 'number';

/* ── Portal Sign ── */
export interface PortalSignBody {
  identity?: {
    method?: string;
    ci?: string;
    phone?: string;
    name?: string;
  };
  signatureImage?: string; // 손글씨 서명 PNG data URL(계약 트랙, 행위 증거)
  fillValues?: Array<{ label: string; value: string }>; // fill-at-signing 기재값(A4, 배정 입력란 필수)
}

export interface PortalSignResult {
  signed: boolean;
  requestStatus: RequestStatus;
}

/* ── Portal Tokens ── */
export interface PortalToken {
  participantId: string;
  signerRole: string;
  token: string;
  url: string;
}

/* ── Certificates ── */
export interface EnrollCertInput {
  ownerType: SignerType;
  subjectDn: string;
  identity: {
    method: string;
    ci?: string;
    phone?: string;
  };
  ownerRef?: string;
  licenseNumber?: string;
  validDays?: number;
}

export interface EnrollCertResult {
  serialNumber: string;
  [key: string]: unknown;
}

/* ── Verify ── */
export interface SignatureVerification {
  signerRole: string;
  signerType?: string; // INTERNAL | EXTERNAL_PARTY | STAFF ...
  relationship?: string; // PROXY 등 대리 관계
  onBehalfOf?: string;
  certSerial: string;
  identityMethod: string;
  keyCustody?: 'HSM' | 'SOFT'; // 서명키 수탁
  cryptoVerify: boolean;
  timestampValid: boolean;
  chainValid: boolean;
  notExpired: boolean;
  notRevoked: boolean;
  ltvValid: boolean;
  cmsValid: boolean;
  format: string;
  valid: boolean;
}

export interface VerifyResult {
  requestId: string;
  status: RequestStatus;
  documentIntegrity: string;
  auditChainValid: boolean;
  caKeyCustody?: 'HSM' | 'SOFT'; // CA 키 수탁(트러스트 근거)
  caKeyCustodyProvider?: string;
  assuranceLevel?: 'HSM_ANCHORED' | 'SOFTWARE';
  signatures: SignatureVerification[];
  overall: boolean;
}

/* ── Audit ── */
export interface AuditEntry {
  seq?: number;
  eventType: string;
  actorType: string;
  occurredAt: string;
  hash?: string;
  [key: string]: unknown;
}

export interface CaHistoryRow {
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  active: boolean;
}

export interface CertListRow {
  serialNumber: string;
  ownerType: string;
  subjectDn: string;
  status: string; // ACTIVE | SUSPENDED | REVOKED | EXPIRED
  notBefore: string;
  notAfter: string;
  keyCustody: string;
  licenseNumber?: string;
}

export interface AuditVerifyResult {
  chainValid: boolean;
  anchored: boolean;
  anchorTsValid?: boolean; // TSA 토큰이 head 해시에 대해 유효
  anchorMatchesChain?: boolean; // 앵커된 head 가 현재 체인과 일치(prefix 위변조 탐지)
  currentHead?: string | null; // 현재 체인 head 해시
  anchoredAt?: string | null;
  valid: boolean;
  [key: string]: unknown;
}

/* ── Notify ── */
export interface NotifyRecipient {
  participantId: string;
  to: string;
  channel?: NotifyChannel;
}

export interface NotifyBody {
  baseUrl: string;
  recipients: NotifyRecipient[];
}

/* ── Create Request ── */
export interface CreateRequestParticipant {
  signerRole: string;
  signerType: SignerType;
  displayName: string;
  signOrder: number;
  certSerial: string;
  requiredIdentityLevel?: IdentityLevel;
  externalSignerRef?: string;
  /** PROXY 유형 전용: 대리인 관계 */
  relationship?: ProxyRelationship;
  /** PROXY 유형 전용: 대리 대상 환자 식별자 */
  onBehalfOf?: string;
}

export interface CreateRequestBody {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  signMode: string;
  callbackUrl?: string;
  ttlDays?: number;
  participants: CreateRequestParticipant[];
}

/* ── Expire ── */
export interface ExpireResult {
  expired: number;
  requestIds: string[];
}

/* ── CA Rotate ── */
export interface RotateResult {
  issuingSerial: string;
  notAfter: string;
}

/* ── Revocation / OCSP / CRL ── */
export type OcspStatus = 'GOOD' | 'REVOKED' | 'UNKNOWN';

export interface OcspResult {
  serialNumber: string;
  status: OcspStatus;
  revokedAt?: string;
  reason?: string;
}

export interface CrlEntry {
  serialNumber: string;
  revokedAt: string;
  reason?: string;
}

export interface CrlResult {
  crlNumber: number;
  issuer?: string;
  producedAt: string;
  revoked: CrlEntry[];
}

export interface RevokeResult {
  serialNumber: string;
  status: string;
  revokedAt: string;
  reason: string;
  crlNumber: number;
}

/* ── Staff Sign ── */
export interface StaffSignResult {
  participantId: string;
  status: string;
  staffSub: string;
  acr?: string;
  [key: string]: unknown;
}

/* ── Ops Status ── */
export interface OpsStatusWebhooks {
  total: number;
  SENT?: number;
  FAILED?: number;
  DEAD?: number;
  PENDING?: number;
  /** 실패 확정(DEAD) 건이 몰린 수신 주소 상위 5개 — 경로 변경·수신 측 장애 조기 인지용 */
  deadTargets?: Array<{ targetUrl: string; count: number }>;
}

export interface OpsStatusRequests {
  total: number;
  CREATED?: number;
  IN_PROGRESS?: number;
  COMPLETED?: number;
  EXPIRED?: number;
  WITHDRAWN?: number;
}

export interface OpsStatusCa {
  issuingSerial: string;
  rootSerial: string;
}

export interface OpsStatusConfig {
  keyCustody: {
    driver: string;
    mode: string;
    hsm?: string;
  };
  identity: {
    driver: string;
    provider?: string;
  };
  notifier: {
    provider: string;
  };
  store: {
    driver: string;
  };
  sso: {
    issuer: string;
    audience: string;
    rolesEnforced: boolean;
  };
  session?: {
    ttlMinutes: number;
    idleTimeoutMinutes: number; // 0 = idle 비활성(절대 만료만)
    maxConcurrent?: number; // 동일 사용자 동시 세션 한도(0 = 무제한)
    activeSessions?: number; // 현재 활성 세션 수
    enforcement?: string; // 'server' = 서버측 강제
  };
  swaggerUi: boolean;
  env: string;
}

export interface OpsMetrics {
  days: number;
  statusDistribution: Record<string, number>;
  daily: Array<{ date: string; count: number }>;
  requestTotal: number;
  webhooks: { total: number; sent: number; failed: number; pending: number; successRate: number };
}

export interface OpsStatus {
  webhooks: OpsStatusWebhooks;
  requests: OpsStatusRequests;
  ca: OpsStatusCa;
  config: OpsStatusConfig;
  generatedAt: string;
}

/* ── Readiness ── */
export interface ReadinessResult {
  ready: boolean;
  checks: {
    db: boolean;
    ca: boolean;
  };
}

/* ── Webhook ── */
export type WebhookStatus = 'SENT' | 'FAILED' | 'DEAD' | 'PENDING';

export interface WebhookEntry {
  eventId: string;
  eventType: string;
  targetUrl: string;
  status: WebhookStatus;
  attempts: number;
  lastAttempt?: string;
}

export interface WebhookRetryResult {
  retried: number;
  sent: number;
  dead: number;
  remaining: number;
}
/** DEAD 적체 1건(재발송 대상 확인용 요약) */
export interface WebhookDeadItem {
  id: string;
  requestId: string;
  eventType: string;
  targetUrl: string;
  attempts: number;
  lastAttempt?: string;
}
/** DEAD 재발송 결과 */
export interface WebhookRedriveResult {
  matched: number;
  requeued: number;
  sent: number;
  failed: number;
  ids: string[];
}
/** DEAD 폐기 결과 — 레코드는 지우지 않고 DISCARDED 로 남는다 */
export interface WebhookDiscardResult {
  matched: number;
  discarded: number;
  ids: string[];
}

/* ── Integration Settings ── */

export type SettingType = 'idv' | 'notifier' | 'hsm';

export interface SettingSchema {
  providers: string[];
  fields: string[];
  secrets: string[];
  runtimeApplied: boolean;
  note: string;
}

export interface SettingItem {
  type: SettingType;
  provider: string;
  enabled: boolean;
  source: 'settings-store' | 'env-default';
  fields: Record<string, string>;
  secretsSet: Record<string, boolean>;
  schema: SettingSchema;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingUpdateBody {
  provider?: string;
  enabled?: boolean;
  fields?: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface SettingAuditEntry {
  eventType: string;
  data: Record<string, unknown>;
  occurredAt: string;
  prevHash: string;
  entryHash: string;
}

/* ── Consumer (API 키 소비자) ── */
export interface Consumer {
  name: string;
  scopes: string[];
  activeKeys: number;
  status: string;
  dynamic?: boolean; // true=UI 등록(관리 가능), false=env 시드 시스템
}

export interface CreateConsumerResult {
  name: string;
  apiKey: string; // 1회 반환(캡처 필수)
  scopes: string[];
}

export interface RotateConsumerBody {
  newApiKey?: string;
}

export interface RotateConsumerResult {
  name: string;
  activeKeys: number;
  generated: boolean;
  newApiKey?: string;
  note: string;
}

export interface CommitConsumerResult {
  name: string;
  activeKeys: number;
}

/* ── C-4 RBAC (다중관리자) ── */
export type AdminRole = 'admin' | 'operator' | 'viewer';
export type AdminUserStatus = 'active' | 'disabled';

export interface AdminUser {
  username: string;
  email?: string; // 내부 계정 이메일(계약 내부 서명자 식별·알림)
  role: AdminRole;
  status: AdminUserStatus;
  createdAt: string;
  createdBy: string;
  lastLoginAt?: string;
}

export interface LoginResult {
  token: string;
  username: string;
  role: AdminRole;
  scopes: string[];
  expiresAt: string;
  /** 비활동 자동 로그아웃 시간(분). 0/미지정=비활성(절대 만료만). EMR 보안성 F004 대응. */
  idleTimeoutMin?: number;
}

/** 2차 인증(TOTP) 챌린지 — 1차 통과·세션 미발급 시 반환. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResponse = LoginResult | MfaChallenge;

export interface MeResult {
  username: string | null;
  role: AdminRole | null;
  email?: string | null; // 본인 알림 이메일(계약 내부 서명자 알림 수신)
  scopes: string[];
  consumer: string | null;
}

export interface CreateAdminUserBody {
  username: string;
  password: string;
  role: AdminRole;
  email?: string;
}

export interface UpdateAdminUserBody {
  role?: AdminRole;
  status?: AdminUserStatus;
  email?: string;
}

/* ── Notify Record (발송 이력) ── */
export type NotifyResult = 'SENT' | 'FAIL' | 'SKIP';

export interface NotifyRecord {
  id: string;
  requestId: string;
  participantId: string;
  channel: NotifyChannel;
  provider: string;
  result: NotifyResult;
  reason?: string;
  providerMsgId?: string;
  toMasked: string;
  title?: string;
  sentAt: string;
}
