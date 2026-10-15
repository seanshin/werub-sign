/**
 * Playwright UI E2E 공용 헬퍼 — 콘솔/포털 브라우저 자동화(L4).
 * 백엔드(인메모리)·웹(next start)을 playwright.config.ts 의 webServer 로 띄우고,
 * 여기서 고정 자격증명·API 시드·UI 로그인·TOTP 계산을 제공한다.
 */
import { Page, APIRequestContext, expect } from '@playwright/test';
import { createHash, createHmac } from 'crypto';

export const API_PORT = Number(process.env.SIGN_E2E_API_PORT || 4790);
export const WEB_PORT = Number(process.env.SIGN_E2E_WEB_PORT || 3390);
export const API_BASE = `http://127.0.0.1:${API_PORT}`;

/** 테스트 고정값 — playwright.config.ts 백엔드 webServer env 와 일치해야 함. */
export const CREDS = {
  user: 'root',
  pass: 'pw-e2e-12345',
  consoleKey: 'console-e2e-key',
  adminApiKey: 'admin-e2e-key',
  hisKey: 'his-e2e-key',
};

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

const jsonKey = (key: string) => ({ 'Content-Type': 'application/json', 'x-api-key': key });

/** UI 로그인 — 아이디/비밀번호 입력 후 대시보드 진입(2FA 미사용 계정). */
export async function loginUI(page: Page, user = CREDS.user, pass = CREDS.pass): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('아이디').fill(user);
  await page.getByLabel('비밀번호').fill(pass);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

/** 인증서 발급(콘솔 키) → serialNumber. */
export async function enrollCert(req: APIRequestContext, cn: string, key = CREDS.consoleKey): Promise<string> {
  const r = await req.post(`${API_BASE}/v1/certificates/enroll`, {
    headers: jsonKey(key),
    data: { ownerType: 'PATIENT', subjectDn: `CN=${cn}`, identity: { method: 'PASS', ci: `C${uniq()}` } },
  });
  expect(r.ok(), `enroll ${cn}: ${r.status()}`).toBeTruthy();
  return (await r.json()).data.serialNumber;
}

/** 서명요청 시드(콘솔 키) — 인증서 발급 후 요청 생성. 대시보드 목록·필터 테스트용. */
export async function seedRequest(
  req: APIRequestContext,
  opts: { title: string; key?: string; signMode?: 'APP' | 'PORTAL' | 'MULTI' },
): Promise<{ requestId: string; title: string }> {
  const key = opts.key ?? CREDS.consoleKey;
  const serial = await enrollCert(req, opts.title.replace(/\s/g, '') + uniq(), key);
  const docHash = createHash('sha256').update(opts.title + uniq()).digest('hex');
  const r = await req.post(`${API_BASE}/v1/requests`, {
    headers: jsonKey(key),
    data: {
      idempotencyKey: `ui-${uniq()}`,
      externalDocId: `ui-${uniq()}`,
      title: opts.title,
      documentHash: docHash,
      signMode: opts.signMode ?? 'APP',
      participants: [
        { signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '테스트환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' },
      ],
    },
  });
  expect(r.ok(), `seedRequest: ${r.status()} ${await r.text()}`).toBeTruthy();
  const data = (await r.json()).data;
  return { requestId: data.requestId, title: opts.title };
}

/** PORTAL 서명요청 시드 + 포털 토큰 발급(NONE 레벨 — 동의 서명). 반환: { token, requestId }. */
export async function seedPortalRequest(
  req: APIRequestContext,
  opts: { title: string; key?: string } = { title: '포털 동의서' },
): Promise<{ token: string; requestId: string }> {
  const key = opts.key ?? CREDS.consoleKey;
  const H = jsonKey(key);
  const enroll = await req.post(`${API_BASE}/v1/certificates/enroll`, {
    headers: H, data: { ownerType: 'WITNESS', subjectDn: `CN=${opts.title.replace(/\s/g, '')}${uniq()}` },
  });
  const serial = (await enroll.json()).data.serialNumber;
  const docHash = createHash('sha256').update(opts.title + uniq()).digest('hex');
  const cr = await req.post(`${API_BASE}/v1/requests`, {
    headers: H,
    data: {
      idempotencyKey: `uiportal-${uniq()}`, externalDocId: `uiportal-${uniq()}`, title: opts.title,
      documentHash: docHash, signMode: 'PORTAL',
      participants: [{ signerRole: 'VENDOR', signerType: 'WITNESS_EXTERNAL', displayName: '서명자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }],
    },
  });
  expect(cr.ok(), `seedPortalRequest: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  const requestId = (await cr.json()).data.requestId;
  const tk = await req.post(`${API_BASE}/v1/requests/${requestId}/portal-tokens`, { headers: H, data: {} });
  expect(tk.ok(), `portal-tokens: ${tk.status()}`).toBeTruthy();
  return { token: (await tk.json()).data[0].token, requestId };
}

/** 최소 유효 PDF(%PDF 매직) — 포털 문서 뷰어 시드용. */
export const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

/** PORTAL 요청 시드 + 문서 업로드(SHA-256==documentHash) + 토큰. 문서 뷰어 테스트용. */
export async function seedPortalRequestWithDoc(
  req: APIRequestContext,
  opts: { title: string; key?: string } = { title: '포털 동의서(문서)' },
): Promise<{ token: string; requestId: string }> {
  const key = opts.key ?? CREDS.consoleKey;
  const H = jsonKey(key);
  const enroll = await req.post(`${API_BASE}/v1/certificates/enroll`, {
    headers: H, data: { ownerType: 'WITNESS', subjectDn: `CN=${opts.title.replace(/\s/g, '')}${uniq()}` },
  });
  const serial = (await enroll.json()).data.serialNumber;
  const docHash = createHash('sha256').update(SAMPLE_PDF).digest('hex');
  const cr = await req.post(`${API_BASE}/v1/requests`, {
    headers: H,
    data: {
      idempotencyKey: `uidoc-${uniq()}`, externalDocId: `uidoc-${uniq()}`, title: opts.title,
      documentHash: docHash, signMode: 'PORTAL',
      participants: [{ signerRole: 'VENDOR', signerType: 'WITNESS_EXTERNAL', displayName: '서명자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }],
    },
  });
  expect(cr.ok(), `seedPortalRequestWithDoc: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  const requestId = (await cr.json()).data.requestId;
  const up = await req.put(`${API_BASE}/v1/requests/${requestId}/document`, {
    headers: { 'Content-Type': 'application/pdf', 'x-api-key': key }, data: SAMPLE_PDF,
  });
  expect(up.ok(), `document upload: ${up.status()} ${await up.text()}`).toBeTruthy();
  const tk = await req.post(`${API_BASE}/v1/requests/${requestId}/portal-tokens`, { headers: H, data: {} });
  expect(tk.ok(), `portal-tokens: ${tk.status()}`).toBeTruthy();
  return { token: (await tk.json()).data[0].token, requestId };
}

/** 인증 행위 로그(audit-events) 시드 — 콘솔 키(requests:write). 반환: entryHash. */
export async function seedAuditEvent(
  req: APIRequestContext,
  opts: { stream?: string; action: string; actor?: string; targetType?: string; targetRef?: string; data?: Record<string, unknown> },
): Promise<void> {
  const r = await req.post(`${API_BASE}/v1/audit-events`, {
    headers: jsonKey(CREDS.consoleKey),
    data: { stream: opts.stream ?? 'clinical-events', action: opts.action, actor: opts.actor, targetType: opts.targetType, targetRef: opts.targetRef, data: opts.data ?? {} },
  });
  expect(r.ok(), `seedAuditEvent: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** 콘솔 세션 로그인(API) → 세션 토큰. 전자결재 상신처럼 사람 계정 세션이 필요한 시드용. */
export async function consoleLogin(req: APIRequestContext, user = CREDS.user, pass = CREDS.pass): Promise<string> {
  const r = await req.post(`${API_BASE}/v1/auth/login`, { headers: { 'Content-Type': 'application/json' }, data: { username: user, password: pass } });
  expect(r.ok(), `consoleLogin: ${r.status()}`).toBeTruthy();
  return (await r.json()).data.token;
}

/** 전자결재 상신 시드 — 콘솔 세션으로 결재선(root→op2 2단) 봉투 생성. 반환: { requestId, title }. */
export async function seedApproval(
  req: APIRequestContext,
  opts: { title: string; docType?: string } = { title: '결재(UI)' },
): Promise<{ requestId: string; title: string }> {
  const token = await consoleLogin(req);
  const c1 = await enrollCert(req, 'Appr1' + uniq());
  const c2 = await enrollCert(req, 'Appr2' + uniq());
  const docHash = createHash('sha256').update(opts.title + uniq()).digest('hex');
  const r = await req.post(`${API_BASE}/v1/approvals`, {
    headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    data: {
      idempotencyKey: `uiap-${uniq()}`, externalDocId: `uiap-${uniq()}`, title: opts.title,
      documentHash: docHash, docType: opts.docType ?? 'CONSENT',
      line: [
        { approverId: CREDS.user, displayName: '과장', order: 1, certSerial: c1 },
        { approverId: 'op2', displayName: '원장', order: 2, certSerial: c2 },
      ],
    },
  });
  expect(r.ok(), `seedApproval: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { requestId: (await r.json()).data.requestId, title: opts.title };
}

/** 일반 전자계약 시드 — 콘솔 세션으로 외부(order1)+내부 root(order2) 계약 생성 + PDF 업로드. */
export async function seedContract(
  req: APIRequestContext,
  opts: { title: string; accessCode?: string; email?: string; signMarks?: Array<Record<string, unknown>> } = { title: '계약(UI)' },
): Promise<{ requestId: string; title: string; token: string }> {
  const session = await consoleLogin(req);
  const H = { 'Content-Type': 'application/json', 'x-session-token': session };
  const docHash = createHash('sha256').update(SAMPLE_PDF).digest('hex');
  const r = await req.post(`${API_BASE}/v1/contracts`, {
    headers: H,
    data: {
      idempotencyKey: `uict-${uniq()}`, externalDocId: `uict-${uniq()}`, title: opts.title,
      documentHash: docHash, labels: ['e2e'],
      ...(opts.accessCode ? { accessCode: opts.accessCode } : {}),
      ...(opts.signMarks ? { signMarks: opts.signMarks } : {}),
      signers: [
        { kind: 'EXTERNAL', displayName: '협력사 대표', email: opts.email ?? 'partner@example.com', order: 1 },
        { kind: 'INTERNAL', displayName: '행정원장', username: CREDS.user, order: 2 },
      ],
    },
  });
  expect(r.ok(), `seedContract: ${r.status()} ${await r.text()}`).toBeTruthy();
  const requestId = (await r.json()).data.requestId;
  const up = await req.put(`${API_BASE}/v1/contracts/${requestId}/document`, {
    headers: { 'Content-Type': 'application/pdf', 'x-session-token': session }, data: SAMPLE_PDF,
  });
  expect(up.ok(), `contract document upload: ${up.status()} ${await up.text()}`).toBeTruthy();
  const tk = await req.post(`${API_BASE}/v1/requests/${requestId}/portal-tokens`, { headers: jsonKey(CREDS.consoleKey), data: {} });
  expect(tk.ok(), `portal-tokens: ${tk.status()}`).toBeTruthy();
  return { requestId, title: opts.title, token: (await tk.json()).data[0].token };
}

/** 계약 체결→교부 시드 — 발송·외부(포털)·내부(콘솔) 서명 후 교부 링크 재발급. 반환: deliveryToken. */
export async function seedDeliveredContract(
  req: APIRequestContext,
  opts: { title: string } = { title: '교부 계약(UI)' },
): Promise<{ requestId: string; title: string; deliveryToken: string }> {
  const { requestId, title, token } = await seedContract(req, opts);
  const session = await consoleLogin(req);
  const H = { 'Content-Type': 'application/json', 'x-session-token': session };
  const snd = await req.post(`${API_BASE}/v1/contracts/${requestId}/send`, { headers: H, data: { baseUrl: `http://127.0.0.1:${WEB_PORT}` } });
  expect(snd.ok(), `contract send: ${snd.status()} ${await snd.text()}`).toBeTruthy();
  const ps = await req.post(`${API_BASE}/v1/portal/${token}/sign`, { headers: { 'Content-Type': 'application/json' }, data: {} });
  expect(ps.ok(), `portal sign: ${ps.status()} ${await ps.text()}`).toBeTruthy();
  const si = await req.post(`${API_BASE}/v1/contracts/${requestId}/sign`, { headers: H, data: {} });
  expect(si.ok(), `internal sign: ${si.status()} ${await si.text()}`).toBeTruthy();
  const d = await req.post(`${API_BASE}/v1/contracts/${requestId}/deliver`, { headers: H, data: {} });
  expect(d.ok(), `deliver: ${d.status()} ${await d.text()}`).toBeTruthy();
  const links = (await d.json()).data as Array<{ url: string }>;
  return { requestId, title, deliveryToken: links[0].url.split('/contracts/delivery/')[1] };
}

/** 문서 인증(wsign) 어테스테이션 시드 — 외부 문서인증 연동 모사(audit-events). */
export async function seedWsignDoc(req: APIRequestContext, opts: { docId: string; title: string }): Promise<void> {
  const r = await req.post(`${API_BASE}/v1/audit-events`, {
    headers: jsonKey(CREDS.consoleKey),
    data: { action: 'WSIGN_ATTEST', actor: 'sys', actorRole: 'SYSTEM', targetType: 'wsign_document', targetRef: opts.docId, stream: `wsign-${opts.docId}`, data: { title: opts.title, documentHash: createHash('sha256').update(opts.docId).digest('hex'), system: 'werb-docauth', hashAlgo: 'sha256' } },
  });
  expect(r.ok(), `seedWsignDoc: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** 관리자 계정 생성(break-glass 키, users:admin). */
export async function createUser(
  req: APIRequestContext,
  username: string,
  password: string,
  role: 'admin' | 'operator' | 'viewer' = 'operator',
): Promise<void> {
  const r = await req.post(`${API_BASE}/v1/admin/users`, {
    headers: jsonKey(CREDS.adminApiKey),
    data: { username, password, role },
  });
  expect(r.ok(), `createUser ${username}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

// ── TOTP(RFC 6238) — 인증앱 코드 계산(SHA1·30초·6자리). 백엔드 totp.ts 와 동일 알고리즘. ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpNow(secretB32: string, time = Date.now()): string {
  const counter = Math.floor(time / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return (code % 10 ** 6).toString().padStart(6, '0');
}
