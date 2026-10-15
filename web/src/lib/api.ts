// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 타입 안전 API 클라이언트
 * - 응답 봉투 { data: ... } 언래핑
 * - 오류 { error: { code, message } } 파싱 → ApiError throw
 * - x-api-key 주입 (sessionStorage)
 * - 빌드 시 호출 없음 (런타임 전용)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import {
  ApiError,
  ApiResponse,
  Paged,
  PortalInfo,
  PortalSignBody,
  PortalSignResult,
  PortalToken,
  EnrollCertInput,
  EnrollCertResult,
  RequestDto,
  CreateRequestBody,
  ApprovalDto,
  CreateApprovalBody,
  ApprovalActBody,
  ApprovalActResult,
  ApprovalAuditRow,
  ContractRow,
  ContractCategorySummary,
  ContractDto,
  ContractAttachment,
  ContractPreset,
  CreateContractBody,
  ContractSendResult,
  ContractSignResult,
  ContractFillValues,
  ContractStats,
  ContractDeliverLink,
  ContractDeliveryInfo,
  ContractVerifyPublic,
  ContractReminderStatus,
  ContractAutoRemindResult,
  ContractTemplate,
  ContractTemplateMeta,
  TemplateVersion,
  CustomTemplateBody,
  PlacedMark,
  ComposeBlock,
  AddressEntry,
  WsignDocRow,
  WsignDocDetail,
  VerifyResult,
  AuditEntry,
  CaHistoryRow,
  CertListRow,
  AuditVerifyResult,
  NotifyBody,
  ExpireResult,
  RotateResult,
  OcspResult,
  CrlResult,
  RevokeResult,
  StaffSignResult,
  OpsStatus,
  OpsMetrics,
  ReadinessResult,
  WebhookEntry,
  WebhookRetryResult,
  WebhookDeadItem,
  WebhookRedriveResult,
  WebhookDiscardResult,
  SettingItem,
  SettingType,
  SettingUpdateBody,
  SettingAuditEntry,
  NotifyRecord,
  Consumer,
  CreateConsumerResult,
  RotateConsumerBody,
  RotateConsumerResult,
  CommitConsumerResult,
  AdminRole,
  AdminUser,
  LoginResult,
  LoginResponse,
  MeResult,
  CreateAdminUserBody,
  UpdateAdminUserBody,
} from '@/types/api';

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SIGN_API_URL ?? 'http://localhost:4000'
  );
}

/** API 베이스 URL — SSE 등 외부 모듈용. */
export function apiBaseUrl(): string {
  return baseUrl();
}

/** 현재 인증 헤더(세션 또는 기계 키) — SSE fetch 등에서 사용. */
export function authHeaders(): Record<string, string> {
  const h = new Headers();
  applyAuthHeaders(h);
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('sign_api_key');
}

function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('sign_admin_key');
}

function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('sign_session_token');
}

/**
 * 인증 헤더 주입 — C-4 RBAC.
 * 관리자 세션(사람)이 있으면 x-session-token(역할이 스코프 결정, ca:admin 포함).
 * 없으면 기계 키 x-api-key(useAdminKey 시 CA 전용 admin 키) — break-glass·레거시.
 */
function applyAuthHeaders(headers: Headers, useAdminKey = false): void {
  const session = getSessionToken();
  if (session) {
    headers.set('x-session-token', session);
    return;
  }
  const key = useAdminKey ? getAdminKey() : getApiKey();
  if (key) headers.set('x-api-key', key);
}

/**
 * 세션 종료 시 로그인 화면 전환 — 서버측 401(세션 무효/만료/idle/축출/폐기)을 받으면
 * 세션 모드에 한해 인증 정보를 비우고 로그인 화면으로 보낸다(콘솔 어디서든 일관 전환).
 * 제외: 세션 토큰 없음(기계 api-key break-glass·공개 포털) / 이미 로그인 화면(루프 방지).
 * 로그인 요청 자체(authApi.login)는 request()를 거치지 않으므로 영향 없음.
 */
function redirectOnSessionEnd(status: number): void {
  if (status !== 401) return;
  if (typeof window === 'undefined') return;
  if (!sessionStorage.getItem('sign_session_token')) return; // 세션 모드만
  if (window.location.pathname.startsWith('/admin/login')) return; // 루프 방지
  authStorage.clear();
  window.location.replace('/admin/login?reason=expired');
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  useAdminKey = false,
): Promise<T> {
  const headers = new Headers(init.headers as HeadersInit | undefined);

  if (!headers.has('Content-Type') && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  applyAuthHeaders(headers, useAdminKey);

  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || '요청에 실패했습니다.';
    try {
      const body = await res.json() as { error?: { code?: string; message?: string } };
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // JSON 파싱 실패 시 기본 메시지 사용
    }
    redirectOnSessionEnd(res.status); // 세션 종료(401) → 로그인 화면 전환
    throw new ApiError(code, message, res.status);
  }

  // PDF 등 binary 응답은 호출자가 직접 처리
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/pdf')) {
    return res as unknown as T;
  }

  const json = (await res.json()) as ApiResponse<T>;
  return json.data;
}

/**
 * 페이지네이션 목록 요청 헬퍼
 * 백엔드 응답: { data: T[], page: { total, limit, offset } }
 * request()는 json.data를 반환하므로, 페이지네이션 응답은 직접 fetch하여
 * 최상위 { data, page }를 모두 읽는다.
 * limit 미지정 시 서버가 전체 반환, max 200 클램프.
 */
async function requestPaged<T>(
  path: string,
  params: { limit?: number; offset?: number; [key: string]: string | number | undefined } = {},
  init: RequestInit = {},
): Promise<Paged<T>> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) qs.set(k, String(v));
  });
  const sep = path.includes('?') ? '&' : '?';
  const fullPath = qs.toString() ? `${path}${sep}${qs.toString()}` : path;

  const headers = new Headers(init.headers as HeadersInit | undefined);
  applyAuthHeaders(headers);

  const url = `${baseUrl()}${fullPath}`;
  const res = await fetch(url, { method: 'GET', ...init, headers });

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || '요청에 실패했습니다.';
    try {
      const body = await res.json() as { error?: { code?: string; message?: string } };
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch { /* JSON 파싱 실패 */ }
    redirectOnSessionEnd(res.status); // 세션 종료(401) → 로그인 화면 전환
    throw new ApiError(code, message, res.status);
  }

  const json = await res.json() as { data: T[]; page?: { total: number; limit: number; offset: number } };

  // 하위호환: 백엔드가 page 필드를 아직 안 내려줄 경우 기본값 처리
  if (json.page) {
    return { data: json.data, page: json.page };
  }
  // 이전 응답 형태 폴백 (data가 배열인 경우)
  const arr = Array.isArray(json.data) ? json.data : (json as unknown as T[]);
  return { data: arr, page: { total: arr.length, limit: arr.length, offset: 0 } };
}

/**
 * CSV 내보내기 — 인증 헤더로 fetch 후 blob 다운로드(<a href>는 헤더 미전송이라 불가).
 * path 에 현재 필터 쿼리 포함. filename 은 다운로드 파일명.
 */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  applyAuthHeaders(headers);
  const res = await fetch(`${baseUrl()}${path}`, { headers });
  if (!res.ok) {
    redirectOnSessionEnd(res.status);
    throw new ApiError(`HTTP_${res.status}`, '내보내기에 실패했습니다.', res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 객체를 쿼리스트링으로(빈 값 제외) — 내보내기 필터 전달용. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') u.set(k, String(v)); });
  const s = u.toString();
  return s ? `?${s}` : '';
}

/* ============================================================
   Portal (공개, 인증 불필요)
   ============================================================ */

export const portalApi = {
  getInfo(token: string): Promise<PortalInfo> {
    return request<PortalInfo>(`/v1/portal/${token}`);
  },

  sign(token: string, body: PortalSignBody): Promise<PortalSignResult> {
    return request<PortalSignResult>(`/v1/portal/${token}/sign`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** 서명 대상 PDF 열람 URL(iframe/새 탭) — 토큰 스코프 공개. 표시 문서 == 서명 대상(업로드 시 해시검증). */
  documentUrl(token: string): string {
    return `${baseUrl()}/v1/portal/${token}/document`;
  },

  /** 일반 전자계약 접근암호 확인(unlock) — 통과 시 동일 토큰의 열람·서명 허용. */
  unlock(token: string, code: string): Promise<{ unlocked: boolean }> {
    return request<{ unlocked: boolean }>(`/v1/portal/${token}/unlock`, { method: 'POST', body: JSON.stringify({ code }) });
  },

  /** 계약 첨부 목록(열람용 부속 문서) — 접근암호 계약은 unlock 후. 비계약/첨부 없음 = 빈 배열. */
  attachments(token: string): Promise<ContractAttachment[]> {
    return request<ContractAttachment[]>(`/v1/portal/${token}/attachments`);
  },
  /** 계약 첨부 다운로드 URL(새 탭) — 토큰 스코프 공개. */
  attachmentUrl(token: string, aid: string): string {
    return `${baseUrl()}/v1/portal/${token}/attachments/${aid}`;
  },
};

/* ============================================================
   Certificates (인증서 발급·폐기)
   ============================================================ */

export const certificatesApi = {
  enroll(input: EnrollCertInput): Promise<EnrollCertResult> {
    return request<EnrollCertResult>('/v1/certificates/enroll', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  revoke(serial: string, reason?: string): Promise<unknown> {
    return request<unknown>(`/v1/certificates/${serial}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /** 발급 인증서 목록(상태·소유·만료) — 서버측 검색 q·status */
  list(opts: { limit?: number; offset?: number; q?: string; status?: string } = {}): Promise<Paged<CertListRow>> {
    return requestPaged<CertListRow>('/v1/certificates', opts);
  },
  /** 현재 검색으로 인증서 목록 CSV 내보내기 */
  exportCsv(opts: { q?: string } = {}): Promise<void> {
    return downloadCsv('/v1/certificates/export.csv' + qs(opts), `인증서목록_${new Date().toISOString().slice(0, 10)}.csv`);
  },
  /** 중단(일시정지·가역) */
  suspend(serial: string): Promise<unknown> {
    return request<unknown>(`/v1/certificates/${encodeURIComponent(serial)}/suspend`, { method: 'POST' });
  },
  /** 중단 해제 */
  resume(serial: string): Promise<unknown> {
    return request<unknown>(`/v1/certificates/${encodeURIComponent(serial)}/resume`, { method: 'POST' });
  },
};

/* ============================================================
   Requests (서명요청 관리)
   ============================================================ */

export const requestsApi = {
  // days=최근 N일 또는 from/to(ISO) 커스텀 범위. createdBy=출처·signMode=서명모드·incomplete=미완료만
  list(opts: { limit?: number; offset?: number; q?: string; status?: string; days?: number; from?: string; to?: string; createdBy?: string; signMode?: string; incomplete?: boolean } = {}): Promise<Paged<RequestDto>> {
    return requestPaged<RequestDto>('/v1/requests', opts as Record<string, string | number | undefined>);
  },

  /** 현재 필터로 요청 목록 CSV 내보내기(심사·보존) */
  exportCsv(opts: { q?: string; status?: string; days?: number; from?: string; to?: string; createdBy?: string; signMode?: string; incomplete?: boolean } = {}): Promise<void> {
    const params: Record<string, string | number | undefined> = { ...opts, incomplete: opts.incomplete ? 'true' : undefined };
    return downloadCsv('/v1/requests/export.csv' + qs(params), `서명요청_${new Date().toISOString().slice(0, 10)}.csv`);
  },

  get(id: string): Promise<RequestDto> {
    return request<RequestDto>(`/v1/requests/${id}`);
  },

  create(body: CreateRequestBody): Promise<RequestDto> {
    return request<RequestDto>('/v1/requests', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  withdraw(id: string, reason?: string): Promise<{ requestId: string; status: string }> {
    return request<{ requestId: string; status: string }>(`/v1/requests/${id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /** C-2 문서 개정 재동의 — 원본을 새 버전으로 대체. 참가자 미지정 시 원본 재사용. */
  supersede(id: string, body: { idempotencyKey: string; documentHash: string; title?: string; reason?: string; ttlDays?: number }): Promise<RequestDto> {
    return request<RequestDto>(`/v1/requests/${id}/supersede`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  issuePortalTokens(id: string): Promise<PortalToken[]> {
    return request<PortalToken[]>(`/v1/requests/${id}/portal-tokens`, {
      method: 'POST',
    });
  },

  notify(id: string, body: NotifyBody): Promise<unknown> {
    return request<unknown>(`/v1/requests/${id}/notify`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  verify(id: string): Promise<VerifyResult> {
    return request<VerifyResult>(`/v1/verify/${id}`);
  },

  audit(id: string): Promise<AuditEntry[]> {
    return request<AuditEntry[]>(`/v1/requests/${id}/audit`);
  },

  auditVerify(id: string): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>(`/v1/requests/${id}/audit/verify`);
  },

  /** 감사추적인증서 PDF URL (새창 열기용) */
  auditCertificateUrl(id: string): string {
    return `${baseUrl()}/v1/requests/${id}/audit-certificate`;
  },
};

/* ============================================================
   전자결재(상신→결재) — 결재함·결재/반려·통합 인증로그
   목록은 서명요청(signMode=APPROVAL) 재사용, 상세·액션·인증로그는 /v1/approvals.
   ============================================================ */

export const approvalsApi = {
  /** 결재함 목록 — signMode=APPROVAL 봉투(대시보드 목록 재사용). */
  list(opts: { limit?: number; offset?: number; q?: string; status?: string; days?: number; from?: string; to?: string } = {}): Promise<Paged<RequestDto>> {
    return requestPaged<RequestDto>('/v1/requests', { signMode: 'APPROVAL', ...opts } as Record<string, string | number | undefined>);
  },

  /** 결재 진행 상태(결재선·현재단계·고위험·인증로그 건수). 기능 비활성 시 404. */
  get(id: string): Promise<ApprovalDto> {
    return request<ApprovalDto>(`/v1/approvals/${id}`);
  },

  /** 상신 — 결재선 지정 + 결재 봉투 생성. */
  submit(body: CreateApprovalBody): Promise<ApprovalDto> {
    return request<ApprovalDto>('/v1/approvals', { method: 'POST', body: JSON.stringify(body) });
  },

  /** 결재(승인/반려) — 지정 결재자만. 고위험/최종 단계는 stepUp 필요. */
  act(id: string, body: ApprovalActBody): Promise<ApprovalActResult> {
    return request<ApprovalActResult>(`/v1/approvals/${id}/act`, { method: 'POST', body: JSON.stringify(body) });
  },

  /** 통합 인증로그(본인확인+F008) — 전체 엔트리. */
  authLog(id: string): Promise<AuditEntry[]> {
    return request<AuditEntry[]>(`/v1/approvals/${id}/authlog`);
  },

  /** 인증로그 무결성(체인+TSA 앵커). */
  authVerify(id: string): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>(`/v1/approvals/${id}/authlog/verify`);
  },

  /** 인증로그 CSV(심사·보존, UTF-8 BOM). */
  authExportCsv(id: string): Promise<void> {
    return downloadCsv(`/v1/approvals/${id}/authlog/export.csv`, `결재인증로그_${id}_${new Date().toISOString().slice(0, 10)}.csv`);
  },

  /** (통합) 전체 결재 인증로그 — 모든 결재 병합, 서버측 필터·페이지. */
  adminAuthLog(opts: { limit?: number; offset?: number; q?: string; eventType?: string; from?: string; to?: string } = {}): Promise<Paged<ApprovalAuditRow>> {
    return requestPaged<ApprovalAuditRow>('/v1/admin/approval-audit', opts as Record<string, string | number | undefined>);
  },

  /** (통합) 전체 결재 인증로그 CSV. */
  adminAuthExportCsv(opts: { q?: string; eventType?: string; from?: string; to?: string } = {}): Promise<void> {
    return downloadCsv('/v1/admin/approval-audit/export.csv' + qs(opts), `전자결재_인증로그_${new Date().toISOString().slice(0, 10)}.csv`);
  },
};

/* ============================================================
   Contracts (일반 전자계약 — 행정·일반 계약) — general-contracts.design.md
   ============================================================ */

/** 계약 PDF 생성 계열 POST 공용 — JSON 요청 → PDF 바이트 응답. */
async function contractPdfPost(path: string, payload: unknown): Promise<ArrayBuffer> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  applyAuthHeaders(headers);
  const res = await fetch(`${baseUrl()}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    let message = '문서 생성 실패';
    try { message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* 기본 메시지 */ }
    redirectOnSessionEnd(res.status);
    throw new ApiError(`HTTP_${res.status}`, message, res.status);
  }
  return res.arrayBuffer();
}

export const contractsApi = {
  /** 계약함 목록 — 서버측 signMode=CONTRACT 필터·검색·상태·기간·라벨·보관. 기능 비활성 시 404. */
  async list(opts: { limit?: number; offset?: number; q?: string; status?: string; from?: string; to?: string; label?: string; category?: string; archived?: boolean } = {}): Promise<{ items: ContractRow[]; total: number; truncated?: boolean }> {
    return request<{ items: ContractRow[]; total: number }>('/v1/contracts' + qs(opts as Record<string, string | number | boolean | undefined>));
  },

  /** 카테고리별 집계(전체·완료 건수). */
  categories(): Promise<ContractCategorySummary[]> {
    return request<ContractCategorySummary[]>('/v1/contracts/categories');
  },
  /** 계약 카테고리 변경(재분류). */
  setCategory(id: string, category: string): Promise<{ category: string }> {
    return request<{ category: string }>(`/v1/contracts/${id}/category`, { method: 'PATCH', body: JSON.stringify({ category }) });
  },

  /** 계약 보관(계약함 제거) — 목록 숨김·데이터/감사 보존. */
  archive(id: string, reason?: string): Promise<{ requestId: string; archived: boolean }> {
    return request<{ requestId: string; archived: boolean }>(`/v1/contracts/${id}/archive`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
  },
  /** 계약 보관 복원. */
  unarchive(id: string): Promise<{ requestId: string; archived: boolean }> {
    return request<{ requestId: string; archived: boolean }>(`/v1/contracts/${id}/unarchive`, { method: 'POST', body: JSON.stringify({}) });
  },

  /** 계약 이력(contract:<id> 감사 스트림). */
  log(id: string): Promise<AuditEntry[]> {
    return request<AuditEntry[]>(`/v1/contracts/${id}/log`);
  },
  logVerify(id: string): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>(`/v1/contracts/${id}/log/verify`);
  },
  logExportCsv(id: string): Promise<void> {
    return downloadCsv(`/v1/contracts/${id}/log/export.csv`, `계약이력_${id}_${new Date().toISOString().slice(0, 10)}.csv`);
  },

  /** 계약 서식 목록(내장+커스텀)·상세. */
  templates(): Promise<ContractTemplateMeta[]> {
    return request<ContractTemplateMeta[]>('/v1/contracts/templates');
  },
  template(id: string): Promise<ContractTemplate> {
    return request<ContractTemplate>(`/v1/contracts/templates/${id}`);
  },
  // 커스텀 서식 관리
  templateCreate(body: CustomTemplateBody): Promise<ContractTemplate> {
    return request<ContractTemplate>('/v1/contracts/templates', { method: 'POST', body: JSON.stringify(body) });
  },
  templateUpdate(id: string, patch: Partial<CustomTemplateBody>): Promise<ContractTemplate> {
    return request<ContractTemplate>(`/v1/contracts/templates/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  templateDelete(id: string): Promise<{ removed: boolean }> {
    return request<{ removed: boolean }>(`/v1/contracts/templates/${id}`, { method: 'DELETE' });
  },
  templateDuplicate(id: string): Promise<ContractTemplate> {
    return request<ContractTemplate>(`/v1/contracts/templates/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
  },
  // 내장 서식 기본값 복원(오버라이드 제거)
  templateReset(id: string): Promise<ContractTemplate> {
    return request<ContractTemplate>(`/v1/contracts/templates/${id}/reset`, { method: 'POST', body: JSON.stringify({}) });
  },
  // 서식 변경 이력·되돌리기
  templateHistory(id: string): Promise<TemplateVersion[]> {
    return request<TemplateVersion[]>(`/v1/contracts/templates/${id}/history`);
  },
  templateRestore(id: string, version: number): Promise<ContractTemplate> {
    return request<ContractTemplate>(`/v1/contracts/templates/${id}/restore/${version}`, { method: 'POST', body: JSON.stringify({}) });
  },

  /** 서식 조판 — 리치 블록(doc)+자유 배치 마크 → 한글 A4 PDF 바이트(저장 안 함). body 는 플레인 폴백. */
  async compose(title: string, body: string, signers?: Array<{ order: number; displayName: string }>, marks?: PlacedMark[], doc?: ComposeBlock[]): Promise<ArrayBuffer> {
    return contractPdfPost('/v1/contracts/compose', { title, body, signers, marks, doc });
  },

  /** 업로드 PDF에 서명란·입력란 마크 스탬프(배치 편집기 좌표) — 결과 PDF 바이트 반환(저장 안 함). */
  async stamp(pdfBytes: ArrayBuffer, marks: PlacedMark[], signers?: Array<{ order: number; displayName: string }>): Promise<ArrayBuffer> {
    const pdfBase64 = btoa(Array.from(new Uint8Array(pdfBytes), (b) => String.fromCharCode(b)).join(''));
    return contractPdfPost('/v1/contracts/stamp', { pdfBase64, marks, signers });
  },

  /** 리마인더·발송 정책 상태(읽기 전용). */
  reminderStatus(): Promise<ContractReminderStatus> {
    return request<ContractReminderStatus>('/v1/contracts/reminder-status');
  },

  /** 자동 리마인더 수동 실행(스케줄러 동일 로직·멱등). */
  autoRemind(): Promise<ContractAutoRemindResult> {
    return request<ContractAutoRemindResult>('/v1/contracts/maintenance/auto-remind', { method: 'POST', body: JSON.stringify({}) });
  },

  // 발송/수신 이메일 주소록
  addressbook(q?: string): Promise<AddressEntry[]> {
    return request<AddressEntry[]>('/v1/contracts/addressbook' + qs({ q }));
  },
  addressbookAdd(body: { email: string; name: string; org?: string; memo?: string }): Promise<AddressEntry> {
    return request<AddressEntry>('/v1/contracts/addressbook', { method: 'POST', body: JSON.stringify(body) });
  },
  addressbookUpdate(id: string, patch: { email?: string; name?: string; org?: string; memo?: string }): Promise<AddressEntry> {
    return request<AddressEntry>(`/v1/contracts/addressbook/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  addressbookRemove(id: string): Promise<{ removed: boolean }> {
    return request<{ removed: boolean }>(`/v1/contracts/addressbook/${id}`, { method: 'DELETE' });
  },

  /** 계약 상세 — 봉투+라벨·상대방(마스킹)·문서 보유·감사 건수. */
  get(id: string): Promise<ContractDto> {
    return request<ContractDto>(`/v1/contracts/${id}`);
  },

  /** 계약 생성 — 서명자 구성(내부/외부)+접근암호. 문서 업로드는 별도. */
  create(body: CreateContractBody): Promise<ContractDto> {
    return request<ContractDto>('/v1/contracts', { method: 'POST', body: JSON.stringify(body) });
  },

  /** 계약 원본 PDF 업로드 — SHA-256==documentHash 검증, 영구 암호화 보관. */
  async uploadDocument(id: string, bytes: ArrayBuffer): Promise<{ sha256: string; sizeBytes: number }> {
    const headers = new Headers({ 'Content-Type': 'application/pdf' });
    applyAuthHeaders(headers);
    const res = await fetch(`${baseUrl()}/v1/contracts/${id}/document`, { method: 'PUT', headers, body: bytes });
    if (!res.ok) {
      let message = '문서 업로드 실패';
      try { message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* 기본 메시지 */ }
      redirectOnSessionEnd(res.status);
      throw new ApiError(`HTTP_${res.status}`, message, res.status);
    }
    return ((await res.json()) as ApiResponse<{ sha256: string; sizeBytes: number }>).data;
  },

  // ── 새 계약 프리셋(U5) — 요청 구성 저장/불러오기(기관 공용·암호 미저장) ──
  /** 프리셋 목록 — 이메일은 마스킹되어 온다(적용 시 presetDetail 로 원문 조회). */
  presets(): Promise<ContractPreset[]> {
    return request<ContractPreset[]>('/v1/contracts/presets');
  },
  presetSave(body: Omit<ContractPreset, 'presetId' | 'createdBy' | 'createdAt' | 'updatedAt'>): Promise<ContractPreset> {
    return request<ContractPreset>('/v1/contracts/presets', { method: 'POST', body: JSON.stringify(body) });
  },
  presetRemove(pid: string): Promise<{ removed: boolean }> {
    return request<{ removed: boolean }>(`/v1/contracts/presets/${pid}`, { method: 'DELETE' });
  },
  /** 프리셋 단건(적용용) — 원문 이메일 포함(contracts:write). */
  presetDetail(pid: string): Promise<ContractPreset> {
    return request<ContractPreset>(`/v1/contracts/presets/${pid}`);
  },

  // ── 첨부(열람용 부속 문서, 설계 §11) — 추가/삭제는 작성(미발송) 상태만 ──
  attachments(id: string): Promise<ContractAttachment[]> {
    return request<ContractAttachment[]>(`/v1/contracts/${id}/attachments`);
  },
  async attachmentAdd(id: string, bytes: ArrayBuffer, contentType: string, name: string): Promise<ContractAttachment> {
    const headers = new Headers({ 'Content-Type': contentType });
    applyAuthHeaders(headers);
    const res = await fetch(`${baseUrl()}/v1/contracts/${id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body: bytes });
    if (!res.ok) {
      let message = '첨부 업로드 실패';
      try { message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* 기본 메시지 */ }
      redirectOnSessionEnd(res.status);
      throw new ApiError(`HTTP_${res.status}`, message, res.status);
    }
    return ((await res.json()) as ApiResponse<ContractAttachment>).data;
  },
  attachmentRemove(id: string, aid: string): Promise<{ removed: boolean }> {
    return request<{ removed: boolean }>(`/v1/contracts/${id}/attachments/${aid}`, { method: 'DELETE' });
  },
  /** 첨부 열람 URL(관리자 — 인증 fetch 후 blob). */
  async attachmentObjectUrl(id: string, aid: string): Promise<string> {
    const headers = new Headers();
    applyAuthHeaders(headers);
    const res = await fetch(`${baseUrl()}/v1/contracts/${id}/attachments/${aid}`, { headers });
    if (!res.ok) { redirectOnSessionEnd(res.status); throw new ApiError(`HTTP_${res.status}`, '첨부를 불러오지 못했습니다', res.status); }
    return URL.createObjectURL(await res.blob());
  },

  /** 발송 — 외부 미서명자에게 포털 링크 이메일. baseUrl = 포털 링크 prefix(웹 오리진). */
  send(id: string, baseUrl: string): Promise<ContractSendResult[]> {
    return request<ContractSendResult[]>(`/v1/contracts/${id}/send`, { method: 'POST', body: JSON.stringify({ baseUrl }) });
  },

  /** 재발송(독촉). */
  remind(id: string, baseUrl: string): Promise<ContractSendResult[]> {
    return request<ContractSendResult[]>(`/v1/contracts/${id}/remind`, { method: 'POST', body: JSON.stringify({ baseUrl }) });
  },

  /** 내부 서명 — 콘솔 세션(지정 서명자 바인딩). 손글씨 서명 이미지(선택). */
  sign(id: string, signatureImage?: string, fillValues?: Array<{ label: string; value: string }>): Promise<ContractSignResult> {
    return request<ContractSignResult>(`/v1/contracts/${id}/sign`, {
      method: 'POST',
      body: JSON.stringify({ ...(signatureImage ? { signatureImage } : {}), ...(fillValues?.length ? { fillValues } : {}) }),
    });
  },

  /** 손글씨 서명 보유 참가자 목록. */
  signatureImages(id: string): Promise<string[]> {
    return request<string[]>(`/v1/contracts/${id}/signature-images`);
  },
  /** 기재값(fill-at-signing) — 서명자별 기재 원문·봉인 해시·무결성. */
  fillValues(id: string): Promise<ContractFillValues[]> {
    return request<ContractFillValues[]>(`/v1/contracts/${id}/fill-values`);
  },
  /** 서명란 좌표 재지정(기존 계약도 손글씨 합성 위치 지정). */
  updateSignMarks(id: string, signMarks: PlacedMark[]): Promise<{ count: number }> {
    return request<{ count: number }>(`/v1/contracts/${id}/sign-marks`, { method: 'PATCH', body: JSON.stringify({ signMarks }) });
  },
  /** 손글씨 서명 이미지 URL(관리자 뷰 — 인증 fetch 필요, blob). */
  async signatureImageObjectUrl(id: string, pid: string): Promise<string> {
    const headers = new Headers();
    applyAuthHeaders(headers);
    const res = await fetch(`${baseUrl()}/v1/contracts/${id}/signature-image/${pid}`, { headers });
    if (!res.ok) { redirectOnSessionEnd(res.status); throw new ApiError(`HTTP_${res.status}`, '서명 이미지를 불러오지 못했습니다', res.status); }
    return URL.createObjectURL(await res.blob());
  },

  /** 계약함 CSV. */
  exportCsv(opts: { q?: string; status?: string; from?: string; to?: string } = {}): Promise<void> {
    return downloadCsv('/v1/contracts/export.csv' + qs(opts), `계약함_${new Date().toISOString().slice(0, 10)}.csv`);
  },

  /** 계약 현황(대시보드 위젯) — 기능 비활성 시 404 throw(위젯 숨김 처리). */
  stats(): Promise<ContractStats> {
    return request<ContractStats>('/v1/contracts/stats');
  },

  /** 교부 링크 재발급 — 체결 완료 계약, 외부 서명자별 링크+이메일 재발송. */
  deliver(id: string): Promise<ContractDeliverLink[]> {
    return request<ContractDeliverLink[]>(`/v1/contracts/${id}/deliver`, { method: 'POST', body: JSON.stringify({}) });
  },

  /** 교부 화면 정보(공개, 만료형 토큰). */
  /** 교부 링크 1회 연장(공개). */
  deliveryExtend(token: string): Promise<{ expiresAt: string }> {
    return request<{ expiresAt: string }>(`/v1/contracts/delivery/${token}/extend`, { method: 'POST' });
  },
  /** 지정 이메일로 문서 전달(공개) — 새 교부 링크를 그 주소로 발송. */
  deliveryForward(token: string, email: string): Promise<{ email: string; expiresAt: string; remaining: number }> {
    return request<{ email: string; expiresAt: string; remaining: number }>(`/v1/contracts/delivery/${token}/forward`, { method: 'POST', body: JSON.stringify({ email }) });
  },
  deliveryInfo(token: string): Promise<ContractDeliveryInfo> {
    return request<ContractDeliveryInfo>(`/v1/contracts/delivery/${token}`);
  },

  /** 교부 다운로드 URL(공개) — <a href> 직접 사용 가능. */
  deliveryDocumentUrl(token: string): string {
    return `${baseUrl()}/v1/contracts/delivery/${token}/document`;
  },
  deliveryCertificateUrl(token: string): string {
    return `${baseUrl()}/v1/contracts/delivery/${token}/certificate`;
  },
  /** 교부 화면 첨부 목록(공개) — 열람용 부속 문서. */
  deliveryAttachments(token: string): Promise<ContractAttachment[]> {
    return request<ContractAttachment[]>(`/v1/contracts/delivery/${token}/attachments`);
  },
  deliveryAttachmentUrl(token: string, aid: string): string {
    return `${baseUrl()}/v1/contracts/delivery/${token}/attachments/${aid}`;
  },

  /** 공개 검증(QR) — 계약 진위·서명 검증 요약(인증 불요). */
  verifyPublic(token: string): Promise<ContractVerifyPublic> {
    return request<ContractVerifyPublic>(`/v1/contracts/verify/${token}`);
  },
  /** 공개 검증 문서 URL(합성본·QR 포함, 공개). */
  verifyDocumentUrl(token: string): string {
    return `${baseUrl()}/v1/contracts/verify/${token}/document`;
  },

  /** 관리자 계약 문서 열람 — 인증 헤더 fetch → blob URL(iframe 은 헤더 미전송이라 직접 URL 불가). */
  async documentObjectUrl(id: string, raw = false): Promise<string> {
    const headers = new Headers();
    applyAuthHeaders(headers);
    const res = await fetch(`${baseUrl()}/v1/contracts/${id}/document${raw ? '?raw=1' : ''}`, { headers });
    if (!res.ok) {
      redirectOnSessionEnd(res.status);
      throw new ApiError(`HTTP_${res.status}`, '문서를 불러오지 못했습니다', res.status);
    }
    return URL.createObjectURL(await res.blob());
  },
};

/* ============================================================
   Revocation (OCSP/CRL) — 공개(인증 불요) + 관리자 폐기
   ============================================================ */

export const revocationApi = {
  /** OCSP 단건 조회 (공개) */
  ocsp(serial: string): Promise<OcspResult> {
    return request<OcspResult>(`/v1/ocsp/${encodeURIComponent(serial)}`);
  },

  /** CRL 전체 목록 조회 (공개) */
  crl(): Promise<CrlResult> {
    return request<CrlResult>('/v1/crl');
  },

  /** 인증서 폐기 (관리자 — certificates:write 스코프 필요) */
  revoke(serial: string, reason?: string): Promise<RevokeResult> {
    return request<RevokeResult>(
      `/v1/certificates/${encodeURIComponent(serial)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },
};

/* ============================================================
   Staff Sign (STAFF SSO 서명)
   ============================================================ */

export const staffSignApi = {
  /**
   * STAFF SSO 서명 — Authorization: Bearer <SSO JWT> + participantId
   * token: HIS SSO 발급 RS256 JWT (Bearer 접두어 포함 또는 미포함 모두 처리)
   */
  sign(participantId: string, ssoToken: string): Promise<StaffSignResult> {
    const bearer = ssoToken.startsWith('Bearer ') ? ssoToken : `Bearer ${ssoToken}`;
    return request<StaffSignResult>(
      '/v1/sign/staff',
      {
        method: 'POST',
        body: JSON.stringify({ participantId }),
        headers: { Authorization: bearer },
      },
    );
  },
};

/* ============================================================
   Maintenance
   ============================================================ */

export const maintenanceApi = {
  expire(): Promise<ExpireResult> {
    return request<ExpireResult>('/v1/maintenance/expire', { method: 'POST' });
  },

  rotateIssuing(): Promise<RotateResult> {
    return request<RotateResult>('/v1/ca/rotate-issuing', { method: 'POST' }, true);
  },

  webhookRetry(): Promise<WebhookRetryResult> {
    return request<WebhookRetryResult>('/v1/maintenance/webhook-retry', { method: 'POST' });
  },
  /** DEAD 적체 목록(재발송 대상 확인). */
  webhookDead(targetUrl?: string): Promise<WebhookDeadItem[]> {
    return request<WebhookDeadItem[]>(`/v1/maintenance/webhook-dead${targetUrl ? `?targetUrl=${encodeURIComponent(targetUrl)}` : ''}`);
  },
  /** DEAD 재발송 — 재시도가 소진된 건을 되살린다(운영자 판단). */
  webhookRedrive(filter: { requestId?: string; targetUrl?: string; limit?: number; newTargetUrl?: string } = {}): Promise<WebhookRedriveResult> {
    return request<WebhookRedriveResult>('/v1/maintenance/webhook-redrive', { method: 'POST', body: JSON.stringify(filter) });
  },
  // 수신처가 폐지돼 재발송이 무의미한 건 — 적체·경고에서 빼되 사유와 함께 이력은 남긴다
  webhookDiscard(filter: { requestId?: string; targetUrl?: string; limit?: number; reason: string }): Promise<WebhookDiscardResult> {
    return request<WebhookDiscardResult>('/v1/maintenance/webhook-discard', { method: 'POST', body: JSON.stringify(filter) });
  },
};

/* ============================================================
   Ops Status (시스템/운영 상태)
   ============================================================ */

export const opsApi = {
  status(): Promise<OpsStatus> {
    return request<OpsStatus>('/v1/admin/ops-status');
  },
  /** 운영 추세(차트) — 상태 분포·일자별 요청·Webhook 성공률 */
  metrics(days = 30): Promise<OpsMetrics> {
    return request<OpsMetrics>(`/v1/admin/metrics?days=${days}`);
  },

  /** 공개 엔드포인트 — x-api-key 불필요, 직접 fetch */
  async ready(): Promise<ReadinessResult> {
    const url = `${baseUrl()}/health/ready`;
    const res = await fetch(url);
    if (!res.ok) {
      return { ready: false, checks: { db: false, ca: false } };
    }
    const json = (await res.json()) as ReadinessResult;
    return json;
  },
};

/* ============================================================
   CA 운영 (감사·로그)
   ============================================================ */

export const caApi = {
  /** CA 회전 이력(현재+구 Issuing) */
  history(): Promise<CaHistoryRow[]> {
    return request<CaHistoryRow[]>('/v1/ca/history');
  },
  /** CA 관리 감사 이벤트(CA_ROTATED·행위자) */
  audit(): Promise<AuditEntry[]> {
    return request<AuditEntry[]>('/v1/ca/audit');
  },
};

/* ============================================================
   인증 행위 로그 (audit-events) — 의료기록/임상행위 별도 스트림
   ============================================================ */

export interface AuditQuery { limit?: number; offset?: number; q?: string; eventType?: string; from?: string; to?: string }

export const auditEventApi = {
  streams(): Promise<{ stream: string; count: number }[]> {
    return request<{ stream: string; count: number }[]>('/v1/audit-events/streams');
  },
  list(stream: string, opts: AuditQuery = {}): Promise<Paged<AuditEntry>> {
    return requestPaged<AuditEntry>(`/v1/audit-events`, { stream, ...opts });
  },
  exportCsv(stream: string, opts: Omit<AuditQuery, 'limit' | 'offset'> = {}): Promise<void> {
    return downloadCsv(`/v1/audit-events/export.csv${qs({ stream, ...opts })}`, `행위로그_${stream}_${new Date().toISOString().slice(0, 10)}.csv`);
  },
  verify(stream: string): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>(`/v1/audit-events/verify?stream=${encodeURIComponent(stream)}`);
  },
};

/** 문서 인증 목록(wsign) — 외부 문서인증 어테스테이션(werb-docauth 등)을 문서별로 통합. */
export const wsignApi = {
  list(opts: { limit?: number; offset?: number; q?: string; eventType?: string; from?: string; to?: string; system?: string } = {}): Promise<Paged<WsignDocRow>> {
    return requestPaged<WsignDocRow>('/v1/admin/wsign-documents', opts as Record<string, string | number | undefined>);
  },
  exportCsv(opts: { q?: string; eventType?: string; from?: string; to?: string; system?: string } = {}): Promise<void> {
    return downloadCsv('/v1/admin/wsign-documents/export.csv' + qs(opts), `문서인증_${new Date().toISOString().slice(0, 10)}.csv`);
  },
  detail(stream: string): Promise<WsignDocDetail> {
    return request<WsignDocDetail>(`/v1/admin/wsign-documents/detail?stream=${encodeURIComponent(stream)}`);
  },
};

/** 관리자 감사(admin:auth·admin:users) — users:admin 한정. 로그인·MFA·비번·계정변경 + 행위자/IP. */
export const adminAuditApi = {
  streams(): Promise<{ stream: string; count: number }[]> {
    return request<{ stream: string; count: number }[]>('/v1/admin/audit/streams');
  },
  list(stream: string, opts: AuditQuery = {}): Promise<Paged<AuditEntry>> {
    return requestPaged<AuditEntry>(`/v1/admin/audit`, { stream, ...opts });
  },
  exportCsv(stream: string, opts: Omit<AuditQuery, 'limit' | 'offset'> = {}): Promise<void> {
    return downloadCsv(`/v1/admin/audit/export.csv${qs({ stream, ...opts })}`, `관리자감사_${stream}_${new Date().toISOString().slice(0, 10)}.csv`);
  },
  verify(stream: string): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>(`/v1/admin/audit/verify?stream=${encodeURIComponent(stream)}`);
  },
};

/* ============================================================
   Webhook
   ============================================================ */

export const webhookApi = {
  byRequest(requestId: string): Promise<WebhookEntry[]> {
    return request<WebhookEntry[]>(`/v1/requests/${requestId}/webhooks`);
  },
};

/* ============================================================
   Integration Settings (연동 설정)
   ============================================================ */

export const settingsApi = {
  list(): Promise<SettingItem[]> {
    return request<SettingItem[]>('/v1/admin/settings');
  },

  get(type: SettingType): Promise<SettingItem> {
    return request<SettingItem>(`/v1/admin/settings/${type}`);
  },

  update(type: SettingType, body: SettingUpdateBody): Promise<SettingItem> {
    return request<SettingItem>(`/v1/admin/settings/${type}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  audit(type: SettingType): Promise<SettingAuditEntry[]> {
    return request<SettingAuditEntry[]>(`/v1/admin/settings/${type}/audit`);
  },
};

/* ============================================================
   Notifications (발송 이력)
   ============================================================ */

export const notificationsApi = {
  /** 전체 발송 이력 */
  listAll(opts: { limit?: number; offset?: number } = {}): Promise<Paged<NotifyRecord>> {
    return requestPaged<NotifyRecord>('/v1/admin/notifications', opts);
  },
  /** 발송 이력 CSV 내보내기(수신번호 마스킹) */
  exportCsv(): Promise<void> {
    return downloadCsv('/v1/admin/notifications/export.csv', `발송이력_${new Date().toISOString().slice(0, 10)}.csv`);
  },

  /** 특정 요청의 발송 이력 */
  listForRequest(requestId: string): Promise<NotifyRecord[]> {
    return request<NotifyRecord[]>(`/v1/requests/${requestId}/notifications`);
  },
};

/* ============================================================
   Consumers (API 키 회전 — ca:admin 스코프)
   ============================================================ */

export const consumersApi = {
  /** 소비자 목록 */
  list(): Promise<Consumer[]> {
    return request<Consumer[]>('/v1/admin/consumers', {}, true);
  },

  /** 키 회전 — newApiKey 미지정 시 서버가 생성(generated=true, newApiKey 1회 반환) */
  rotate(name: string, body: RotateConsumerBody = {}): Promise<RotateConsumerResult> {
    return request<RotateConsumerResult>(
      `/v1/admin/consumers/${encodeURIComponent(name)}/rotate`,
      { method: 'POST', body: JSON.stringify(body) },
      true,
    );
  },

  /** 회전 완료 commit — 구 키 폐기, activeKeys → 1 */
  commit(name: string, keepApiKey: string): Promise<CommitConsumerResult> {
    return request<CommitConsumerResult>(
      `/v1/admin/consumers/${encodeURIComponent(name)}/commit`,
      { method: 'POST', body: JSON.stringify({ keepApiKey }) },
      true,
    );
  },

  /** UI 부여 가능 스코프(민감 제외) */
  assignableScopes(): Promise<string[]> {
    return request<string[]>('/v1/admin/consumers/assignable-scopes', {}, true);
  },

  /** 소비자 등록 — 키 서버 생성·1회 반환 */
  create(name: string, scopes: string[]): Promise<CreateConsumerResult> {
    return request<CreateConsumerResult>('/v1/admin/consumers', { method: 'POST', body: JSON.stringify({ name, scopes }) }, true);
  },

  /** 소비자 수정 — 스코프/상태(동적 소비자만) */
  update(name: string, body: { scopes?: string[]; status?: 'ACTIVE' | 'SUSPENDED' }): Promise<{ name: string; scopes?: string[]; status?: string }> {
    return request(`/v1/admin/consumers/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(body) }, true);
  },
};

/* ============================================================
   Auth (C-4 RBAC — 관리자 로그인·세션)
   ============================================================ */

export const authApi = {
  /** 로그인 — 세션 토큰 발급(공개). 인증 헤더 불필요. */
  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await fetch(`${baseUrl()}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      let message = 'username 또는 비밀번호가 올바르지 않습니다.';
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error) { code = body.error.code ?? code; message = body.error.message ?? message; }
      } catch { /* ignore */ }
      throw new ApiError(code, message, res.status);
    }
    return ((await res.json()) as ApiResponse<LoginResponse>).data;
  },

  /** 2차 인증 검증 — 챌린지 토큰 + 코드(TOTP/복구코드) → 세션. */
  async verify2fa(mfaToken: string, code: string): Promise<LoginResult> {
    const res = await fetch(`${baseUrl()}/v1/auth/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken, code }),
    });
    if (!res.ok) {
      let message = '인증 코드가 올바르지 않습니다.';
      try { const b = (await res.json()) as { error?: { message?: string } }; if (b?.error?.message) message = b.error.message; } catch { /* ignore */ }
      throw new ApiError(`HTTP_${res.status}`, message, res.status);
    }
    return ((await res.json()) as ApiResponse<LoginResult>).data;
  },

  status2fa(): Promise<{ enabled: boolean }> {
    return request<{ enabled: boolean }>('/v1/auth/2fa/status');
  },
  setup2fa(): Promise<{ secret: string; otpauthUri: string }> {
    return request<{ secret: string; otpauthUri: string }>('/v1/auth/2fa/setup', { method: 'POST' });
  },
  enable2fa(code: string): Promise<{ recoveryCodes: string[] }> {
    return request<{ recoveryCodes: string[] }>('/v1/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) });
  },
  disable2fa(code: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/v1/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) });
  },

  /** 비활동 자동 로그아웃 설정 조회 */
  getIdleTimeout(): Promise<{ idleTimeoutMin: number; preference: number | null; policyMaxMin: number; maxMin: number; minMin: number; devMode: boolean }> {
    return request('/v1/auth/idle-timeout');
  },
  /** 비활동 자동 로그아웃 설정 — minutes(>0) 또는 null(해제). 반환: 적용 유효값. */
  setIdleTimeout(minutes: number | null): Promise<{ idleTimeoutMin: number; preference: number | null }> {
    return request('/v1/auth/idle-timeout', { method: 'POST', body: JSON.stringify({ minutes }) });
  },

  /** 현재 주체(세션 또는 기계 키) */
  me(): Promise<MeResult> {
    return request<MeResult>('/v1/auth/me');
  },

  /** 본인 알림 이메일 설정/변경(세션). 빈 문자열=제거. */
  setOwnEmail(email: string): Promise<{ email: string | null }> {
    return request<{ email: string | null }>('/v1/auth/email', { method: 'POST', body: JSON.stringify({ email }) });
  },

  /** 본인 비밀번호 변경(세션) */
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/v1/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  /** 로그아웃(서버 감사 — 무상태 토큰은 클라이언트 폐기) */
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/v1/auth/logout', { method: 'POST' });
  },
};

/* ============================================================
   Admin Users (users:admin — admin 역할/sign-admin 키)
   ============================================================ */

export const usersApi = {
  list(): Promise<AdminUser[]> {
    return request<AdminUser[]>('/v1/admin/users');
  },
  create(body: CreateAdminUserBody): Promise<AdminUser> {
    return request<AdminUser>('/v1/admin/users', { method: 'POST', body: JSON.stringify(body) });
  },
  update(username: string, body: UpdateAdminUserBody): Promise<AdminUser> {
    return request<AdminUser>(`/v1/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },
  resetPassword(username: string, newPassword: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/v1/admin/users/${encodeURIComponent(username)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
  },
};

/* ============================================================
   Auth helpers (sessionStorage)
   ============================================================ */

export const authStorage = {
  /** 관리자 세션 저장(로그인 성공) */
  setSession(s: LoginResult) {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem('sign_session_token', s.token);
    sessionStorage.setItem('sign_username', s.username);
    sessionStorage.setItem('sign_role', s.role);
    sessionStorage.setItem('sign_scopes', JSON.stringify(s.scopes));
    if (s.expiresAt) sessionStorage.setItem('sign_expires_at', s.expiresAt);
    if (typeof s.idleTimeoutMin === 'number') sessionStorage.setItem('sign_idle_min', String(s.idleTimeoutMin));
  },
  getSessionToken(): string | null {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('sign_session_token');
  },
  /** 세션 절대 만료(epoch ms) — 없으면 null(기계 키 모드 등) */
  getExpiresAt(): number | null {
    if (typeof window === 'undefined') return null;
    const v = sessionStorage.getItem('sign_expires_at');
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  },
  /** 비활동 자동 로그아웃 시간(분). 미설정 시 null → 호출부 기본값 적용. 0=서버가 idle 비활성 지정. */
  getIdleTimeoutMin(): number | null {
    if (typeof window === 'undefined') return null;
    const v = sessionStorage.getItem('sign_idle_min');
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  /** idle 변경 즉시 저장 — 내 계정에서 설정 시 클라이언트 경고 타이머도 갱신(화면 이동 시 반영). */
  setIdleTimeoutMin(min: number) {
    if (typeof window !== 'undefined') sessionStorage.setItem('sign_idle_min', String(min));
  },
  getRole(): AdminRole | null {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('sign_role') as AdminRole | null;
  },
  getUsername(): string | null {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('sign_username');
  },
  getScopes(): string[] {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(sessionStorage.getItem('sign_scopes') ?? '[]') as string[]; } catch { return []; }
  },
  setApiKey(key: string) {
    sessionStorage.setItem('sign_api_key', key);
  },
  setAdminKey(key: string) {
    sessionStorage.setItem('sign_admin_key', key);
  },
  clear() {
    ['sign_api_key', 'sign_admin_key', 'sign_session_token', 'sign_username', 'sign_role', 'sign_scopes', 'sign_expires_at', 'sign_idle_min'].forEach((k) =>
      sessionStorage.removeItem(k),
    );
  },
  /** 인증 보유 여부 — 세션(사람) 또는 기계 키(break-glass) */
  hasAuth(): boolean {
    return !!sessionStorage.getItem('sign_session_token') || !!sessionStorage.getItem('sign_api_key');
  },
  /** @deprecated hasAuth 사용 — 하위호환 유지 */
  hasApiKey(): boolean {
    return this.hasAuth();
  },
};
