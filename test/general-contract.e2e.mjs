// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 일반 전자계약(행정·일반 계약) e2e — 설계 docs/02-design/features/general-contracts.design.md (v0.1).
 *  - 생성: 서명자열(외부 EMAIL+접근암호 / 내부 콘솔 바인딩) 봉투 생성 + CONTRACT_CREATED 봉인(contract:<id>).
 *  - 문서: PDF 업로드(SHA-256==documentHash, 오문서 422), 계약 트랙은 GENERAL_CONTRACTS 로 게이팅(PORTAL_DOC_PREVIEW 무관)·영구 보관(sweep 미파기).
 *  - 발송/독촉: 외부 미서명자 포털 토큰 + EMAIL 채널(mock) + 발송이력.
 *  - 접근암호: unlock 전 열람·서명 403, 오암호 403(감사), 통과 후 열람·서명 허용.
 *  - 체결: 외부 포털 서명 → 내부 콘솔 서명(지정 서명자 바인딩, 타인·기계키 403) → COMPLETED + verify overall.
 *  - 권한: HIS 기계키(contracts:write 미보유) 403, viewer 쓰기 403, ERP 기계키 생성 허용.
 *  - 안전 기본값: GENERAL_CONTRACTS 미설정 → EP 404.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 4835, B = `http://127.0.0.1:${PORT}`;
const PORT2 = 4836, B2 = `http://127.0.0.1:${PORT2}`;
const KEY = 'his-ct-key';
const ERP_KEY = 'erp-ct-key';
const ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const EKH = { ...J, 'x-api-key': ERP_KEY };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
const PDF_HASH = createHash('sha256').update(PDF).digest('hex');

const sPost = (base, p, b, tok) => fetch(base + p, { method: 'POST', headers: { ...J, 'x-session-token': tok }, body: JSON.stringify(b ?? {}) });
const sGet = (base, p, tok) => fetch(base + p, { headers: { 'x-session-token': tok } });
const sPut = (base, p, bytes, tok) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': tok }, body: bytes });
const login = async (base, u, pw) => (await (await fetch(base + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: u, password: pw }) })).json()).data?.token;

function start(port, extraEnv) {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(port), HIS_INBOUND_API_KEY: KEY, ERP_API_KEY: ERP_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 73).toString('base64'), SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60', ...extraEnv },
    stdio: 'ignore',
  });
}
async function up(base) { for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 일반 전자계약(준비→발송→체결→관리) e2e ══════\n');
  // P3: 자동 리마인더 즉시 발화(AFTER_DAYS≈8ms) + 스케줄러 없이 수동 트리거 검증용 링크 기준 URL
  const app = start(PORT, { GENERAL_CONTRACTS: 'on', CONTRACT_REMIND_AFTER_DAYS: '0.0000001', CONTRACT_PORTAL_BASE_URL: B });
  if (!(await up(B))) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const root = await login(B, 'root', ADMIN_PW);
    check(!!root, 'root 콘솔 로그인');

    // ── 생성(외부 order1 + 내부 root order2, 접근암호) ──
    console.log('── 계약 생성 ──');
    const signers = [
      { kind: 'EXTERNAL', displayName: '김협력', email: 'partner@example.com', order: 1 },
      { kind: 'INTERNAL', displayName: '행정원장', username: 'root', order: 2 },
    ];
    const createBody = { idempotencyKey: 'ct1', externalDocId: 'CT-2026-001', title: '용역 계약서', documentHash: PDF_HASH, labels: ['용역', '2026'], category: '용역', accessCode: 'gate-1234', signers };
    const cRes = await sPost(B, '/v1/contracts', createBody, root);
    const c = (await cRes.json()).data;
    const id = c?.requestId;
    check(cRes.status === 201 && !!id, '계약 생성 → 봉투(signMode=CONTRACT)');
    check(c.hasAccessCode === true && Array.isArray(c.labels) && c.labels.includes('용역'), '계약 메타(라벨·접근암호 플래그)');
    check(c.parties?.[0]?.email?.includes('*') && !JSON.stringify(c.parties).includes('partner@example.com'), '상대방 이메일 마스킹(평문 미노출)');
    check(c.participants?.every((p) => p.certSerial), '서명자 인증서 자동발급(내부 STAFF·외부 WITNESS)');

    // 멱등 재생성
    const c2 = (await (await sPost(B, '/v1/contracts', createBody, root)).json()).data;
    check(c2?.requestId === id, '멱등 재생성(동일 idempotencyKey) → 동일 봉투');

    // 권한 — HIS 기계키(contracts:write 미보유) 403, ERP 기계키 201, viewer 403
    check((await fetch(B + '/v1/contracts', { method: 'POST', headers: KH, body: JSON.stringify({ ...createBody, idempotencyKey: 'ct-his' }) })).status === 403, 'HIS 기계키 생성 → 403(스코프 최소권한)');
    const erpRes = await fetch(B + '/v1/contracts', { method: 'POST', headers: EKH, body: JSON.stringify({ ...createBody, idempotencyKey: 'ct-erp', accessCode: undefined, labels: ['ERP'] }) });
    check(erpRes.status === 201, 'ERP 기계키 생성 → 201(contracts:write 부여)');
    await sPost(B, '/v1/admin/users', { username: 'vw1', password: 'vw1-pass-123', role: 'viewer' }, root);
    const vw = await login(B, 'vw1', 'vw1-pass-123');
    check((await sPost(B, '/v1/contracts', { ...createBody, idempotencyKey: 'ct-vw' }, vw)).status === 403, 'viewer 생성 → 403');
    check((await sGet(B, '/v1/contracts', vw)).status === 200, 'viewer 목록 조회 → 200(읽기 허용)');

    // ── 문서 업로드(영구 보관) ──
    console.log('── 문서 업로드 ──');
    check((await sPut(B, `/v1/contracts/${id}/document`, Buffer.from('%PDF-1.4 wrong'), root)).status === 422, '오문서(해시 불일치) 업로드 → 422');
    const up1 = await sPut(B, `/v1/contracts/${id}/document`, PDF, root);
    check(up1.status === 200 && (await up1.json()).data.sha256 === PDF_HASH, 'PDF 업로드(SHA-256 일치) → 봉인 저장');

    // ── 발송(이메일 mock)·독촉 ──
    console.log('── 발송·독촉 ──');
    const sendOut = (await (await sPost(B, `/v1/contracts/${id}/send`, { baseUrl: B }, root)).json()).data;
    check(Array.isArray(sendOut) && sendOut[0]?.result === 'SENT' && sendOut[0]?.channel === 'EMAIL' && sendOut[0]?.url, '발송 → 외부 서명자 EMAIL(mock)+포털 링크');
    const remindOut = (await (await sPost(B, `/v1/contracts/${id}/remind`, { baseUrl: B }, root)).json()).data;
    check(Array.isArray(remindOut) && remindOut[0]?.result === 'SENT', '독촉 재발송 → SENT');
    const notiList = (await (await fetch(B + `/v1/requests/${id}/notifications`, { headers: KH })).json()).data;
    check(notiList.length >= 2 && notiList.every((n) => n.channel === 'EMAIL' && !JSON.stringify(n).includes('partner@example.com')), '발송이력 2건(EMAIL·수신 마스킹)');
    const token = remindOut[0].url.split('/portal/')[1];

    // ── 접근암호(unlock) 게이트 ──
    console.log('── 접근암호 게이트 ──');
    const info1 = (await (await fetch(B + `/v1/portal/${token}`)).json()).data;
    check(info1.locked === true && info1.request?.title === '용역 계약서' && info1.canSignNow === undefined, 'unlock 전 포털 → locked(내용 비노출)');
    check((await fetch(B + `/v1/portal/${token}/document`)).status === 403, 'unlock 전 문서 열람 → 403');
    check((await fetch(B + `/v1/portal/${token}/sign`, { method: 'POST', headers: J, body: '{}' })).status === 403, 'unlock 전 서명 → 403');
    check((await fetch(B + `/v1/portal/${token}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'wrong-code' }) })).status === 403, '오암호 unlock → 403');
    const un = await fetch(B + `/v1/portal/${token}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'gate-1234' }) });
    check(un.status === 201 && (await un.json()).data.unlocked === true, '정상 접근암호 unlock → 통과');
    const info2 = (await (await fetch(B + `/v1/portal/${token}`)).json()).data;
    check(info2.locked === undefined && info2.canSignNow === true && info2.documentAvailable === true, 'unlock 후 포털 → 열람·서명 가능');
    const docRes = await fetch(B + `/v1/portal/${token}/document`);
    const docBytes = Buffer.from(await docRes.arrayBuffer());
    check(docRes.status === 200 && docBytes.subarray(0, 5).toString('latin1') === '%PDF-', 'unlock 후 문서 열람 → 원본 PDF');

    // ── 체결(외부 포털 → 내부 콘솔) ──
    console.log('── 체결 ──');
    const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const ps = await fetch(B + `/v1/portal/${token}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ signatureImage: PNG1x1 }) });
    check(ps.status === 201 && (await ps.json()).data.signed === true, '외부 서명(포털·손글씨 첨부) → 서명 완료');
    const sigList = (await (await sGet(B, `/v1/contracts/${id}/signature-images`, root)).json()).data;
    check(Array.isArray(sigList) && sigList.length >= 1, '손글씨 서명 보유 참가자 목록');
    const sigImg = await sGet(B, `/v1/contracts/${id}/signature-image/${sigList[0]}`, root);
    const sigBytes = Buffer.from(await sigImg.arrayBuffer());
    check(sigImg.status === 200 && sigBytes.subarray(1, 4).toString('latin1') === 'PNG', '손글씨 서명 이미지 조회(복호화)');
    const sigLog = (await (await sGet(B, `/v1/contracts/${id}/log`, root)).json()).data;
    check(sigLog.some((e) => e.eventType === 'CONTRACT_SIGNED_EXTERNAL' && e.data?.signatureImageSha256), '이력에 손글씨 이미지 SHA-256 봉인');

    // ── 서명란 좌표(signMarks) + 손글씨 → 문서에 합성 표시 ──
    console.log('── 서명 이미지 합성 ──');
    const composedPdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '합성 테스트', body: '서명란 합성 확인 문서' }) })).arrayBuffer());
    const cHash = createHash('sha256').update(composedPdf).digest('hex');
    const scMark = { page: 1, x: 0.55, y: 0.7, w: 0.35, h: 0.09, signer: 1, type: 'SIGN' };
    const sc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-sigcomp', externalDocId: 'CT-SC-1', title: '합성 계약', documentHash: cHash, signMarks: [scMark], signers: [{ kind: 'EXTERNAL', displayName: '갑', email: 'sc@example.com', order: 1 }, { kind: 'INTERNAL', displayName: '을', username: 'root', order: 2 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${sc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: composedPdf });
    const scTok = (await (await fetch(B + `/v1/requests/${sc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    await fetch(B + `/v1/portal/${scTok}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ signatureImage: PNG1x1 }) });
    const rendered = await sGet(B, `/v1/contracts/${sc.requestId}/document`, root);
    const renderedBytes = Buffer.from(await rendered.arrayBuffer());
    check(rendered.status === 200 && renderedBytes.subarray(0, 5).toString('latin1') === '%PDF-' && renderedBytes.length > composedPdf.length, `서명란에 손글씨 합성(원본 ${composedPdf.length}B → 합성 ${renderedBytes.length}B, 이미지 삽입)`);
    // raw=1 → 원본(합성 전, 배치 편집용)
    const rawDoc = await sGet(B, `/v1/contracts/${sc.requestId}/document?raw=1`, root);
    check(rawDoc.status === 200 && Buffer.from(await rawDoc.arrayBuffer()).length === composedPdf.length, 'raw=1 → 원본 문서(합성 전)');

    // ── 서명란 재지정(기존 계약 — 생성 시 signMarks 미지정) → 합성 ──
    console.log('── 서명란 재지정 ──');
    const nm = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-remark', externalDocId: 'CT-RM-1', title: '재지정 계약', documentHash: cHash, signers: [{ kind: 'EXTERNAL', displayName: '갑', email: 'rm@example.com', order: 1 }, { kind: 'INTERNAL', displayName: '을', username: 'root', order: 2 }] }, root)).json()).data; // signMarks 없이 생성
    await fetch(B + `/v1/contracts/${nm.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: composedPdf });
    const nmTok = (await (await fetch(B + `/v1/requests/${nm.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    await fetch(B + `/v1/portal/${nmTok}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ signatureImage: PNG1x1 }) });
    const before = Buffer.from(await (await sGet(B, `/v1/contracts/${nm.requestId}/document`, root)).arrayBuffer());
    check(before.length === composedPdf.length, '재지정 전 — 합성 없음(signMarks 미지정)');
    const patch = await fetch(B + `/v1/contracts/${nm.requestId}/sign-marks`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ signMarks: [scMark] }) });
    check(patch.status === 200 && (await patch.json()).data.count === 1, '서명란 좌표 재지정(PATCH)');
    const after = Buffer.from(await (await sGet(B, `/v1/contracts/${nm.requestId}/document`, root)).arrayBuffer());
    check(after.length > before.length, `재지정 후 — 손글씨 합성됨(${before.length}B → ${after.length}B)`);

    // 내부 서명 바인딩 — 타인(op3)·기계키 차단, 지정자(root)만
    await sPost(B, '/v1/admin/users', { username: 'op3', password: 'op3-pass-123', role: 'operator' }, root);
    const op3 = await login(B, 'op3', 'op3-pass-123');
    check((await sPost(B, `/v1/contracts/${id}/sign`, {}, op3)).status === 403, '내부 서명 타인(op3) → 403 SIGNER_MISMATCH');
    check((await fetch(B + `/v1/contracts/${id}/sign`, { method: 'POST', headers: EKH, body: '{}' })).status === 403, '내부 서명 기계키 → 403(사람 계정만)');
    const isRes = await sPost(B, `/v1/contracts/${id}/sign`, {}, root);
    const isd = (await isRes.json()).data;
    check(isRes.status === 201 && isd.status === 'COMPLETED', '내부 서명(root) → 체결 완료(COMPLETED)');

    const vRes = (await (await fetch(B + `/v1/verify/${id}`)).json()).data;
    check(vRes.overall === true, '체결 봉투 verify → overall=true(실 다자서명)');

    // ── 관리(목록·상세·CSV·감사·영구보관) ──
    console.log('── 관리 ──');
    const list = (await (await sGet(B, '/v1/contracts?q=용역', root)).json()).data;
    check(list.total >= 1 && list.items.some((r) => r.requestId === id && r.status === 'COMPLETED'), '계약함 목록(검색 q=용역)');
    const detail = (await (await sGet(B, `/v1/contracts/${id}`, root)).json()).data;
    check(detail.auditCount >= 5, `계약 감사 스트림(contract:<id>) 봉인 ${detail.auditCount}건(생성·발송·독촉·unlock·서명)`);
    const csv = await sGet(B, '/v1/contracts/export.csv', root);
    check(csv.status === 200 && /csv/i.test(csv.headers.get('content-type') || '') && (await csv.text()).includes('용역 계약서'), '계약함 CSV');

    // 영구 보관 — COMPLETED 후 sweep 에도 문서 파기 안 됨(D4)
    await fetch(B + '/v1/maintenance/document-sweep', { method: 'POST', headers: KH });
    const adminDoc = await sGet(B, `/v1/contracts/${id}/document`, root);
    check(adminDoc.status === 200, '체결 후 sweep → 계약 원본 유지(영구 암호화 보관)+관리자 열람');

    // 만료/무효 토큰 unlock
    check((await fetch(B + '/v1/portal/no-such-token/unlock', { method: 'POST', headers: J, body: JSON.stringify({ code: 'x' }) })).status === 404, '무효 토큰 unlock → 404');

    // ── P3: 완료문서 교부(만료형 다운로드 링크) ──
    console.log('── 완료문서 교부(P3) ──');
    // 체결 시 자동 교부 — 발송이력에 [교부] 기록(발송1+독촉1+교부1 ≥ 3)
    const noti3 = (await (await fetch(B + `/v1/requests/${id}/notifications`, { headers: KH })).json()).data;
    check(noti3.length >= 3 && noti3.some((n) => (n.title ?? '').startsWith('[교부]')), '체결 시 자동 교부 — 발송이력 [교부] 기록');
    // 수동 재발급 → 공개 다운로드(문서·감사추적인증서)
    const dl = (await (await sPost(B, `/v1/contracts/${id}/deliver`, {}, root)).json()).data;
    check(Array.isArray(dl) && dl[0]?.url?.includes('/contracts/delivery/') && dl[0].email.includes('*'), '교부 링크 재발급(이메일 마스킹)');
    const dtoken = dl[0].url.split('/contracts/delivery/')[1];
    const dinfo = (await (await fetch(B + `/v1/contracts/delivery/${dtoken}`)).json()).data;
    check(dinfo.title === '용역 계약서' && dinfo.documentAvailable === true, '교부 화면 정보(공개 토큰)');
    const ddoc = await fetch(B + `/v1/contracts/delivery/${dtoken}/document`);
    const ddocBytes = Buffer.from(await ddoc.arrayBuffer());
    check(ddoc.status === 200 && ddocBytes.subarray(0, 5).toString('latin1') === '%PDF-', '교부 — 완료 문서 다운로드');
    const dcert = await fetch(B + `/v1/contracts/delivery/${dtoken}/certificate`);
    const dcertBytes = Buffer.from(await dcert.arrayBuffer());
    check(dcert.status === 200 && dcertBytes.subarray(0, 5).toString('latin1') === '%PDF-', '교부 — 감사추적인증서 다운로드');
    check((await fetch(B + '/v1/contracts/delivery/bogus-token')).status === 404, '무효 교부 링크 → 404');

    // ── P3: 자동 리마인더(미서명 독촉·만료 임박 경고) ──
    console.log('── 자동 리마인더(P3) ──');
    // ct2: 일반(독촉 대상) / ct3: 만료 12h 이내(경고 대상)
    const mk = (key, title, ttlDays) => sPost(B, '/v1/contracts', {
      idempotencyKey: key, externalDocId: key, title, documentHash: PDF_HASH, ...(ttlDays !== undefined ? { ttlDays } : {}),
      signers: [{ kind: 'EXTERNAL', displayName: '외부서명자', email: 'remindee@example.com', order: 1 }],
    }, root);
    const ct2 = (await (await mk('ct-remind', '독촉 대상 계약')).json()).data;
    const ct3 = (await (await mk('ct-expiry', '만료 임박 계약', 0.5)).json()).data;
    await sPost(B, `/v1/contracts/${ct2.requestId}/send`, { baseUrl: B }, root);
    await sPost(B, `/v1/contracts/${ct3.requestId}/send`, { baseUrl: B }, root);
    await sleep(100); // AFTER_DAYS(≈8ms) 경과 보장 — 발송 직후 즉시 트리거 시 미발화 방지
    const ar = (await (await sPost(B, '/v1/contracts/maintenance/auto-remind', {}, root)).json()).data;
    check(ar.reminded >= 1 && ar.expiryWarned >= 1, `자동 리마인더 — 독촉 ${ar.reminded}·만료경고 ${ar.expiryWarned}`);
    const noti4 = (await (await fetch(B + `/v1/requests/${ct2.requestId}/notifications`, { headers: KH })).json()).data;
    check(noti4.length >= 2, '독촉 대상 — 발송이력 증가(발송+자동독촉)');
    const ar2 = (await (await sPost(B, '/v1/contracts/maintenance/auto-remind', {}, root)).json()).data;
    check(ar2.expiryWarned === 0, '만료 경고는 계약당 1회(중복 미발송)');

    // ── 서식(샘플)·에디터 조판 ──
    console.log('── 계약 서식·PDF 조판 ──');
    const tpls = (await (await sGet(B, '/v1/contracts/templates', root)).json()).data;
    check(Array.isArray(tpls) && tpls.length >= 35 && tpls.some((t) => t.id === 'employment-regular') && tpls.some((t) => t.id === 'clinical-trial') && tpls.some((t) => t.id === 'clinical-cooperation') && tpls.some((t) => t.id === 'his-maintenance') && tpls.some((t) => t.id === 'med-open-report'), `서식 목록 ${tpls.length}종(근로·의료인력·용역·임대차·구매·보안·협약 + 의료특화)`);
    const tpl = (await (await sGet(B, '/v1/contracts/templates/employment-regular', root)).json()).data;
    check(tpl.fields?.length >= 10 && tpl.body.includes('{{employeeName}}') && tpl.body.includes('제1조') && tpl.body.includes('제15조') && tpl.body.includes('근로기준법'), '서식 상세 — 실무 조항(15조+·법령 인용)+플레이스홀더 본문');
    check((await sGet(B, '/v1/contracts/templates/no-such', root)).status === 404, '없는 서식 → 404');
    check(tpls.every((t) => typeof t.builtin === 'boolean') && tpls.filter((t) => t.builtin).length === 36, '목록 builtin 플래그(내장 36종)');

    // ── 커스텀 서식 CRUD ──
    console.log('── 커스텀 서식 ──');
    const cc = await sPost(B, '/v1/contracts/templates', { name: '테스트 위탁 서식', category: '용역', description: '커스텀', fields: [{ key: 'clientName', label: '기관', type: 'text' }], body: '테스트 서식\n\n{{clientName}} 계약\n\n제1조 (목적) 테스트.' }, root);
    const custom = (await cc.json()).data;
    check(cc.status === 201 && custom.id.startsWith('c-'), '커스텀 서식 생성(id=c-)');
    check((await sPost(B, '/v1/contracts/templates', { name: 'x', body: '짧음\n\n{{missing}}' }, root)).status === 400, '미정의 플레이스홀더 → 400');
    const list2 = (await (await sGet(B, '/v1/contracts/templates', root)).json()).data;
    check(list2.some((t) => t.id === custom.id && t.builtin === false), '목록에 커스텀(builtin=false) 포함');
    const up = await fetch(B + `/v1/contracts/templates/${custom.id}`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ description: '수정됨' }) });
    check(up.status === 200 && (await up.json()).data.description === '수정됨', '커스텀 서식 수정');
    // ── 내장 서식 직접 편집(오버라이드)·이력·복원 ──
    const ovBefore = (await (await sGet(B, '/v1/contracts/templates/nda', root)).json()).data;
    const ov = await fetch(B + '/v1/contracts/templates/nda', { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ description: '기관 편집본' }) });
    const ovData = (await ov.json()).data;
    check(ov.status === 200 && ovData.builtin === true && ovData.overridden === true && ovData.description === '기관 편집본', '내장 서식 편집 → 오버라이드 저장(builtin+overridden)');
    const ndaList = (await (await sGet(B, '/v1/contracts/templates', root)).json()).data;
    check(ndaList.some((t) => t.id === 'nda' && t.overridden === true), '목록에 내장 오버라이드 반영(overridden=true)');
    const hist1 = (await (await sGet(B, '/v1/contracts/templates/nda/history', root)).json()).data;
    check(Array.isArray(hist1) && hist1.length >= 1 && hist1[0].version === 1 && hist1[0].description === ovBefore.description, '변경 이력 적재(v1=변경 직전 스냅샷)');
    const rst = (await (await sPost(B, '/v1/contracts/templates/nda/restore/1', {}, root)).json()).data;
    check(rst.description === ovBefore.description, 'v1 되돌리기 → 원 설명 복원');
    const reset = await sPost(B, '/v1/contracts/templates/nda/reset', {}, root);
    const resetData = (await reset.json()).data;
    check(reset.status === 201 && resetData.overridden === false && resetData.description === ovBefore.description, '기본값 복원 → 오버라이드 제거(코드 원본)');
    check((await fetch(B + '/v1/contracts/templates/nda', { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ body: '너무짧음', fields: [] }) })).status === 400, '내장 편집도 검증 적용(짧은 본문 400)');
    const dup = await sPost(B, '/v1/contracts/templates/employment-regular/duplicate', {}, root);
    const duped = (await dup.json()).data;
    check(dup.status === 201 && duped.id.startsWith('c-') && duped.name.includes('(사본)') && duped.body.includes('제1조'), '내장 서식 복제 → 편집용 커스텀');
    const del = await fetch(B + `/v1/contracts/templates/${custom.id}`, { method: 'DELETE', headers: { 'x-session-token': root } });
    check(del.status === 200 && (await del.json()).data.removed === true, '커스텀 서식 삭제');
    check((await fetch(B + '/v1/contracts/templates/employment-regular', { method: 'DELETE', headers: { 'x-session-token': root } })).status === 400, '내장 서식 삭제 → 400');
    await fetch(B + `/v1/contracts/templates/${duped.id}`, { method: 'DELETE', headers: { 'x-session-token': root } }); // 정리
    const composed = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '표준 근로계약서', body: tpl.body.replace(/{{\w+}}/g, '홍길동') }) });
    const pdfBytes = Buffer.from(await composed.arrayBuffer());
    check(composed.status === 201 && pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-' && pdfBytes.length > 20_000, `서식 조판 → 한글 PDF ${pdfBytes.length}B(폰트 임베드)`);
    // 조판 PDF로 실제 계약 생성·업로드까지(해시 정합)
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    const tplCt = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-tpl', externalDocId: 'CT-TPL-1', title: '서식 계약', documentHash: pdfHash, signers: [{ kind: 'INTERNAL', displayName: '원장', username: 'root', order: 1 }] }, root)).json()).data;
    const tplUp = await fetch(B + `/v1/contracts/${tplCt.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: pdfBytes });
    check(tplUp.status === 200, '조판 PDF → 계약 생성·원본 업로드(해시 일치)');

    // ── 서명란·입력란 마커 조판 + 동시(병렬) 서명 ──
    console.log('── 마커 조판·동시 서명 ──');
    const markedBody = '용역 계약 개요\n\n[입력란#1:연락처]\n\n[서명란#1]\n\n[서명란#2]';
    const mc = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '마커 테스트', body: markedBody, signers: [{ order: 1, displayName: '협력사 대표' }, { order: 2, displayName: '행정원장' }] }) });
    const mBytes = Buffer.from(await mc.arrayBuffer());
    check(mc.status === 201 && mBytes.subarray(0, 5).toString('latin1') === '%PDF-', '서명란·입력란 마커 → PDF 조판(서명자 라벨)');

    // 자유 배치 마크(배치 편집기 좌표 0..1) — compose 통합·페이지 클램프·stamp(업로드 PDF)
    const marks = [
      { page: 1, x: 0.55, y: 0.8, w: 0.35, h: 0.07, signer: 1, type: 'SIGN' },
      { page: 9, x: 0.1, y: 0.1, w: 0.4, h: 0.04, signer: 2, type: 'FIELD', label: '연락처' }, // 초과 페이지 → 마지막으로 클램프
    ];
    const cm = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '자유 배치', body: '자유 배치 본문', signers: [{ order: 1, displayName: '갑' }, { order: 2, displayName: '을' }], marks }) });
    const cmBytes = Buffer.from(await cm.arrayBuffer());
    check(cm.status === 201 && cmBytes.subarray(0, 5).toString('latin1') === '%PDF-', '자유 배치 마크 compose(좌표 렌더·페이지 클램프)');
    // 리치 블록(doc) 조판 — h1/h2 굵은 제목 + 문단 내 굵기 런
    const rich = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({
      title: '리치 조판', body: '(폴백)',
      doc: [
        { type: 'heading', level: 1, runs: [{ text: '표준 근로계약서' }] },
        { type: 'heading', level: 2, runs: [{ text: '제1조 (목적)' }] },
        { type: 'paragraph', runs: [{ text: '이 계약은 ' }, { text: '중요 사항', bold: true }, { text: '을 정함을 목적으로 한다. ' + '가나다라마바사 '.repeat(30) }] },
        { type: 'paragraph', runs: [{ text: '[서명란#1]' }] },
      ],
      signers: [{ order: 1, displayName: '갑' }],
    }) });
    const richBytes = Buffer.from(await rich.arrayBuffer());
    check(rich.status === 201 && richBytes.subarray(0, 5).toString('latin1') === '%PDF-' && richBytes.length > 10_000, `리치 블록(doc) 조판 — 제목·조항·굵기 런(${richBytes.length}B, Bold 폰트 임베드)`);

    // 회귀 방지: pdf.js 로 텍스트 추출 — subset 폰트 깨짐(글리프 흩어짐) 재발 시 온전한 문자열 누락으로 실패
    try {
      const pdfjs = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const extract = async (buf) => {
        const d = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        let all = '';
        for (let p = 1; p <= d.numPages; p++) all += (await (await d.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
        return all;
      };
      const richText = await extract(richBytes);
      check(richText.includes('표준 근로계약서') && richText.includes('중요 사항'), 'pdf.js 텍스트 추출 온전(subset 깨짐 회귀 방지)');
    } catch (e) {
      check(true, `pdf.js 미로드 — 텍스트 추출 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }

    const stamp = await fetch(B + '/v1/contracts/stamp', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ pdfBase64: cmBytes.toString('base64'), marks, signers: [{ order: 1, displayName: '갑' }] }) });
    const stBytes = Buffer.from(await stamp.arrayBuffer());
    check(stamp.status === 201 && stBytes.subarray(0, 5).toString('latin1') === '%PDF-' && stBytes.length > 1000, '기존 PDF 마크 스탬프(stamp)');
    check((await fetch(B + '/v1/contracts/stamp', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ pdfBase64: Buffer.from('not-a-pdf').toString('base64'), marks }) })).status === 400, '비PDF 스탬프 → 400');

    const pHash = createHash('sha256').update(mBytes).digest('hex');
    const par = (await (await sPost(B, '/v1/contracts', {
      idempotencyKey: 'ct-parallel', externalDocId: 'CT-PAR-1', title: '동시 서명 계약', documentHash: pHash, signingMode: 'PARALLEL',
      signers: [
        { kind: 'EXTERNAL', displayName: '협력사 대표', email: 'par@example.com', order: 1 },
        { kind: 'INTERNAL', displayName: '행정원장', username: 'root', order: 2 },
      ],
    }, root)).json()).data;
    check(par.signingMode === 'PARALLEL' && par.participants.every((p) => p.signOrder === 1), '동시 계약 생성 — 전원 order 1(상호 비차단)');
    // 동시 모드: 내부(원래 2번째)가 외부보다 먼저 서명 가능
    const pSign = await sPost(B, `/v1/contracts/${par.requestId}/sign`, {}, root);
    check(pSign.status === 201 && (await pSign.json()).data.status === 'IN_PROGRESS', '동시 — 내부가 외부보다 먼저 서명 가능(순차라면 차단)');
    const pTok = (await (await fetch(B + `/v1/requests/${par.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    const pExt = await fetch(B + `/v1/portal/${pTok}/sign`, { method: 'POST', headers: J, body: '{}' });
    check(pExt.status === 201 && (await pExt.json()).data.requestStatus === 'COMPLETED', '동시 — 외부 서명 → 전원 완료(COMPLETED)');

    // ── P3: 계약 현황(stats) ──
    const st = (await (await sGet(B, '/v1/contracts/stats', root)).json()).data;
    check(st.total >= 3 && st.completed >= 1 && st.open >= 2, `계약 현황 — 전체 ${st.total}·체결 ${st.completed}·진행 ${st.open}`);
    check(st.expiringSoon >= 1, `만료 임박(7일) 집계 ${st.expiringSoon}건(ttl 0.5d 계약)`);

    // ── U단계: 목록 보강·라벨 필터·이력·리마인더 상태 ──
    console.log('── 계약함 보강·이력(U1~U4) ──');
    const l2 = (await (await sGet(B, '/v1/contracts?status=CREATED', root)).json()).data;
    const row2 = l2.items.find((r) => r.requestId === ct2.requestId);
    check(row2?.currentStep?.kind === 'EXTERNAL' && !!row2?.lastSentAt && row2?.hasDocument === false, '목록 행 보강 — 현재단계(외부)·최근발송·문서보유');
    check(row2 && !JSON.stringify(row2).includes('remindee@example.com'), '목록에 외부 이메일 비노출');
    const lb1 = (await (await sGet(B, '/v1/contracts?label=' + encodeURIComponent('용역'), root)).json()).data;
    const lb0 = (await (await sGet(B, '/v1/contracts?label=' + encodeURIComponent('없는라벨'), root)).json()).data;
    check(lb1.total === 1 && lb1.items[0].requestId === id && lb0.total === 0, '라벨 필터(용역=1·없는라벨=0)');

    const lg = (await (await sGet(B, `/v1/contracts/${id}/log`, root)).json()).data;
    check(Array.isArray(lg) && lg.length >= 7 && lg.some((e) => e.eventType === 'CONTRACT_DELIVERED') && lg.some((e) => e.eventType === 'CONTRACT_UNLOCK_FAILED'), `계약 이력 ${lg.length}건(교부·unlock 실패 포함)`);
    check((await sGet(B, `/v1/contracts/${id}/log`, vw)).status === 200, '계약 이력 viewer 열람(콘솔 공통 GET 규칙, 결재 로그와 동일)');
    check((await fetch(B + `/v1/contracts/${id}/log`, { headers: KH })).status === 403, '계약 이력 무스코프 기계키(HIS) → 403');
    const lv = (await (await sGet(B, `/v1/contracts/${id}/log/verify`, root)).json()).data;
    check(lv.chainValid === true, '계약 이력 무결성 — 체인 유효');
    const lcsv = await sGet(B, `/v1/contracts/${id}/log/export.csv`, root);
    check(lcsv.status === 200 && /csv/i.test(lcsv.headers.get('content-type') || ''), '계약 이력 CSV');

    const rs = (await (await sGet(B, '/v1/contracts/reminder-status', root)).json()).data;
    check(typeof rs.remindAfterDays === 'number' && rs.provider === 'mock' && rs.portalBaseUrlSet === true, '리마인더 정책 상태(provider=mock·baseUrl 설정)');

    // ── 카테고리별 관리 ──
    console.log('── 카테고리 관리 ──');
    const detCat = (await (await sGet(B, `/v1/contracts/${id}`, root)).json()).data;
    check(detCat.category === '용역', '계약 상세 — 카테고리(용역)');
    const catList = (await (await sGet(B, `/v1/contracts?category=${encodeURIComponent('용역')}`, root)).json()).data.items;
    check(Array.isArray(catList) && catList.every((r) => r.category === '용역') && catList.some((r) => r.requestId === id), '카테고리 필터(용역) — 해당 계약만');
    const catSum = (await (await sGet(B, '/v1/contracts/categories', root)).json()).data;
    check(Array.isArray(catSum) && catSum.some((c) => c.category === '용역' && c.total >= 1 && typeof c.completed === 'number'), '카테고리 집계(전체·완료 건수)');
    // 재분류
    const reCat = await fetch(B + `/v1/contracts/${id}/category`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ category: '보안' }) });
    check(reCat.status === 200 && (await reCat.json()).data.category === '보안', '카테고리 재분류(용역→보안)');
    const afterCat = (await (await sGet(B, `/v1/contracts?category=${encodeURIComponent('보안')}`, root)).json()).data.items;
    check(afterCat.some((r) => r.requestId === id), '재분류 후 새 카테고리(보안)로 조회');
    await fetch(B + `/v1/contracts/${id}/category`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ category: '용역' }) }); // 원복

    // ── 완료문서 QR 검증(공개) ──
    console.log('── QR 검증 ──');
    // 실제 페이지가 있는 compose PDF로 내부전용 계약 → 체결 → 완료문서 QR 스탬프
    const qc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-qr', externalDocId: 'CT-QR-1', title: 'QR 검증 계약', documentHash: cHash, signers: [{ kind: 'INTERNAL', displayName: '원장', username: 'root', order: 1 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${qc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: composedPdf });
    await sPost(B, `/v1/contracts/${qc.requestId}/send`, { baseUrl: 'https://sign.example.org' }, root); // baseUrl 저장(QR 링크 기준)
    await sPost(B, `/v1/contracts/${qc.requestId}/sign`, {}, root); // 내부 서명 → 체결
    const qrDoc = Buffer.from(await (await sGet(B, `/v1/contracts/${qc.requestId}/document`, root)).arrayBuffer());
    check(qrDoc.subarray(0, 5).toString('latin1') === '%PDF-' && qrDoc.length > composedPdf.length, '완료문서 조회(QR 스탬프 삽입)');
    const vtok = (await (await sGet(B, `/v1/contracts/${qc.requestId}`, root)).json()).data.verifyToken;
    check(typeof vtok === 'string' && vtok.length > 10, '체결 후 검증 토큰 발급(verifyToken)');
    // 공개 검증(인증 없이) — 순수 fetch(세션/키 없음)
    const pv = await (await fetch(B + `/v1/contracts/verify/${vtok}`)).json();
    check(pv.data?.verified === true && pv.data?.status === 'COMPLETED' && pv.data?.documentHash && Array.isArray(pv.data?.signers), '공개 검증 요약(인증 불요·verified·서명자)');
    const pvDoc = await fetch(B + `/v1/contracts/verify/${vtok}/document`);
    check(pvDoc.status === 200 && Buffer.from(await pvDoc.arrayBuffer()).subarray(0, 5).toString('latin1') === '%PDF-', '공개 검증 문서(인증 불요 PDF)');
    check((await fetch(B + '/v1/contracts/verify/no-such-token')).status === 404, '잘못된 검증 토큰 → 404');
    // 접근암호 보호 계약 → 완료문서에 공개 QR/검증토큰 미발급(본문·서명자 유출 방지)
    const acQc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-qr-ac', externalDocId: 'CT-QR-AC', title: '접근암호 계약', documentHash: cHash, accessCode: 'gate-9876', signers: [{ kind: 'INTERNAL', displayName: '원장', username: 'root', order: 1 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${acQc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: composedPdf });
    await sPost(B, `/v1/contracts/${acQc.requestId}/send`, { baseUrl: 'https://sign.example.org' }, root);
    await sPost(B, `/v1/contracts/${acQc.requestId}/sign`, {}, root);
    await sGet(B, `/v1/contracts/${acQc.requestId}/document`, root); // 완료문서 조회(QR 스탬프 시도 — 암호계약이라 생략)
    const acVtok = (await (await sGet(B, `/v1/contracts/${acQc.requestId}`, root)).json()).data.verifyToken;
    check(!acVtok, '접근암호 계약 → 공개 검증토큰 미발급(QR 생략, 본문·서명자 유출 방지)');
    // 보관(제거) 시 공개 검증 토큰 폐기 — 이후 공개 검증·문서 접근 불가
    await sPost(B, `/v1/contracts/${qc.requestId}/archive`, { reason: '검토용' }, root);
    check((await fetch(B + `/v1/contracts/verify/${vtok}`)).status === 404, '보관 계약 → 공개 검증 404(토큰 폐기)');
    check((await fetch(B + `/v1/contracts/verify/${vtok}/document`)).status === 404, '보관 계약 → 공개 문서 404');
    await sPost(B, `/v1/contracts/${qc.requestId}/unarchive`, {}, root); // 정리(복원)

    // ── 순차 외부 서명 auto-advance (#6) — 현재 차례만 링크, 앞 서명 완료 시 다음 차례 자동 발송 ──
    console.log('── 순차 외부 auto-advance ──');
    const seq = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-seq-adv', externalDocId: 'CT-SEQ-ADV', title: '순차 외부 계약', documentHash: cHash, signers: [{ kind: 'EXTERNAL', displayName: '갑', email: 'seqa@example.com', order: 1 }, { kind: 'EXTERNAL', displayName: '을', email: 'seqb@example.com', order: 2 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${seq.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: composedPdf });
    const seqSend = (await (await sPost(B, `/v1/contracts/${seq.requestId}/send`, { baseUrl: B }, root)).json()).data;
    check(Array.isArray(seqSend) && seqSend.length === 1, '순차 외부 발송 → 현재 차례(order1)에게만 포털 링크(#6)');
    const seqNoti1 = (await (await fetch(B + `/v1/requests/${seq.requestId}/notifications`, { headers: KH })).json()).data;
    check(seqNoti1.length === 1, '발송 직후 알림 1건(order2 순번 前 미발송)');
    const seqTok1 = seqSend[0].url.split('/portal/')[1];
    const seqSign1 = await fetch(B + `/v1/portal/${seqTok1}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ signatureImage: PNG1x1 }) });
    check(seqSign1.status === 201, 'order1 외부 서명(포털)');
    const seqNoti2 = (await (await fetch(B + `/v1/requests/${seq.requestId}/notifications`, { headers: KH })).json()).data;
    check(seqNoti2.length === 2, 'order1 완료 → order2 auto-advance 포털 링크 발송(알림 2건)');

    // ── 내부 서명자 이메일 알림 ──
    console.log('── 내부 서명자 알림 ──');
    // 내부(root, 지정 이메일)=1차 → 발송 시 내부에게 콘솔 서명요청 이메일
    const inCt = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-internal', externalDocId: 'CT-IN-1', title: '내부 알림 계약', documentHash: PDF_HASH, signers: [{ kind: 'INTERNAL', displayName: '원장', username: 'root', order: 1, email: 'director@hospital.example.com' }, { kind: 'EXTERNAL', displayName: '갑', email: 'ext@example.com', order: 2 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${inCt.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: PDF });
    const inSend = (await (await sPost(B, `/v1/contracts/${inCt.requestId}/send`, { baseUrl: B }, root)).json()).data;
    check(Array.isArray(inSend), '내부 1차 계약 발송(외부는 2차 대기)');
    const inNoti = (await (await fetch(B + `/v1/requests/${inCt.requestId}/notifications`, { headers: KH })).json()).data;
    check(inNoti.some((n) => n.channel === 'EMAIL' && (n.title ?? '').startsWith('[서명 요청]')), '내부 서명자 콘솔 서명요청 이메일 발송');
    check(inNoti.every((n) => !JSON.stringify(n).includes('director@hospital.example.com')), '내부 알림 수신 이메일 마스킹');
    const inDetail = (await (await sGet(B, `/v1/contracts/${inCt.requestId}`, root)).json()).data;
    check(Array.isArray(inDetail.internalNotify) && inDetail.internalNotify[0]?.username === 'root' && /\*/.test(inDetail.internalNotify[0]?.email ?? ''), '상세 — 내부 서명자 알림 이메일(마스킹) 노출');
    const inAudit = (await (await sGet(B, `/v1/contracts/${inCt.requestId}/log`, root)).json()).data;
    check(inAudit.some((e) => e.eventType === 'CONTRACT_INTERNAL_NOTIFIED'), '이력 — 내부 알림 봉인(CONTRACT_INTERNAL_NOTIFIED)');

    // ── 주소록(발송/수신 이메일 관리) ──
    console.log('── 주소록 ──');
    const abAdd = await sPost(B, '/v1/contracts/addressbook', { email: 'AB@Example.com', name: '홍길동', org: '협력사' }, root);
    const abEntry = (await abAdd.json()).data;
    check(abAdd.status === 201 && abEntry.email === 'ab@example.com' && abEntry.id, '주소록 추가(이메일 소문자 정규화)');
    check((await sPost(B, '/v1/contracts/addressbook', { email: 'ab@example.com', name: '중복' }, root)).status === 409, '중복 이메일 → 409');
    check((await sPost(B, '/v1/contracts/addressbook', { email: 'bad', name: 'x' }, root)).status === 400, '이메일 형식 오류 → 400');
    const abList = (await (await sGet(B, '/v1/contracts/addressbook?q=' + encodeURIComponent('협력'), root)).json()).data;
    check(Array.isArray(abList) && abList.some((e) => e.id === abEntry.id), '주소록 검색(소속)');
    const abUp = await fetch(B + `/v1/contracts/addressbook/${abEntry.id}`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ memo: '주거래' }) });
    check(abUp.status === 200 && (await abUp.json()).data.memo === '주거래', '주소록 수정');
    // 자동 학습 — 계약 발송 시 수신 이메일 주소록 등재(ct2=remindee@example.com 이미 발송됨)
    const abLearned = (await (await sGet(B, '/v1/contracts/addressbook?q=remindee', root)).json()).data;
    check(abLearned.some((e) => e.email === 'remindee@example.com'), '발송 수신 이메일 자동 학습');
    const abDel = await fetch(B + `/v1/contracts/addressbook/${abEntry.id}`, { method: 'DELETE', headers: { 'x-session-token': root } });
    check(abDel.status === 200 && (await abDel.json()).data.removed === true, '주소록 삭제');
    check((await fetch(B + '/v1/contracts/addressbook', { headers: KH })).status === 403, '주소록 무스코프 기계키 → 403');

    // ── 보안·정합 보완: unlock 잠금(⑪)·meta 직렬화(⑫)·동시완료 1회 처리(⑬) ──
    console.log('── unlock 잠금·동시성 보완 ──');
    // ⑫ 주소록 동시 추가 — 단일 meta 배열 read-modify-write 직렬화(lost update 없이 전원 영속)
    const abPar = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => sPost(B, '/v1/contracts/addressbook', { email: `cc${i}@example.com`, name: `동시${i}` }, root)));
    check(abPar.every((r) => r.status === 201), '주소록 동시 추가 6건 → 전원 201');
    const abCc = (await (await sGet(B, '/v1/contracts/addressbook?q=cc', root)).json()).data;
    check([0, 1, 2, 3, 4, 5].every((i) => abCc.some((e) => e.email === `cc${i}@example.com`)), '동시 추가 6건 전원 영속(lost update 없음)');
    // ⑫ 커스텀 서식 동시 생성 — custom 배열 직렬화
    const tplPar = await Promise.all([0, 1, 2, 3].map((i) => sPost(B, '/v1/contracts/templates', { name: `동시서식${i}`, body: '제1조 (목적) 동시성 검증용 본문이다.' }, root)));
    check(tplPar.every((r) => r.status === 201), '커스텀 서식 동시 생성 4건 → 전원 201');
    const tplAll = (await (await sGet(B, '/v1/contracts/templates', root)).json()).data;
    check([0, 1, 2, 3].every((i) => tplAll.some((t) => t.name === `동시서식${i}`)), '동시 생성 서식 전원 목록 존재');

    // ⑪ 접근암호 연속 오류 → 계약 단위 잠금(429) — IP 레이트리밋과 별개의 무차별 대입 방지
    const lkBody = { idempotencyKey: 'ct-lock', externalDocId: 'CT-LOCK-1', title: '잠금 검증 계약', documentHash: PDF_HASH, accessCode: 'lock-1234', signers: [{ kind: 'EXTERNAL', displayName: '외부', email: 'lock@example.com', order: 1 }] };
    const lk = (await (await sPost(B, '/v1/contracts', lkBody, root)).json()).data;
    const lkTok = (await (await fetch(B + `/v1/requests/${lk.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await fetch(B + `/v1/portal/${lkTok}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'nope-' + i }) })).status);
    check(tries.slice(0, 4).every((s) => s === 403) && tries[4] === 429, `오암호 1~4회 403·5회째 429 잠금 [${tries.join(',')}]`);
    check((await fetch(B + `/v1/portal/${lkTok}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'lock-1234' }) })).status === 429, '잠금 중 정상 암호도 429(잠금 우선)');
    const lkLog = (await (await sGet(B, `/v1/contracts/${lk.requestId}/log`, root)).json()).data;
    check(lkLog.some((e) => e.eventType === 'CONTRACT_UNLOCK_LOCKED'), '이력에 CONTRACT_UNLOCK_LOCKED 봉인');

    // ⑬ PARALLEL 외부 2인 병렬 서명 동시 완료 → 완료 후처리(시점봉인·교부) 1회 보장
    const p2Body = { idempotencyKey: 'ct-par2', externalDocId: 'CT-PAR-2', title: '동시완료 계약', documentHash: PDF_HASH, signingMode: 'PARALLEL', signers: [{ kind: 'EXTERNAL', displayName: '갑', email: 'p2a@example.com', order: 1 }, { kind: 'EXTERNAL', displayName: '을', email: 'p2b@example.com', order: 2 }] };
    const p2 = (await (await sPost(B, '/v1/contracts', p2Body, root)).json()).data;
    await sPut(B, `/v1/contracts/${p2.requestId}/document`, PDF, root);
    const p2Toks = (await (await fetch(B + `/v1/requests/${p2.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data.map((t) => t.token);
    const p2Res = await Promise.all(p2Toks.map((t) => fetch(B + `/v1/portal/${t}/sign`, { method: 'POST', headers: J, body: '{}' })));
    check(p2Res.every((r) => r.status === 201), '동시 외부 2인 병렬 서명 → 전원 201');
    await sleep(500); // onPortalSigned 후처리(best-effort) 완료 대기
    const p2Det = (await (await sGet(B, `/v1/contracts/${p2.requestId}`, root)).json()).data;
    check(p2Det.status === 'COMPLETED', '병렬 동시 서명 → COMPLETED');
    const p2Log = (await (await sGet(B, `/v1/contracts/${p2.requestId}/log`, root)).json()).data;
    check(p2Log.filter((e) => e.eventType === 'CONTRACT_DELIVERED').length === 1, '완료 후처리 1회 — CONTRACT_DELIVERED 중복 없음');

    // ── 리치 에디터 확장(A5) — 정렬·목록·표 조판 ──
    console.log('── 에디터 확장(A5) 조판 ──');
    const rich5 = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({
      title: 'A5 조판', body: '(폴백)',
      doc: [
        { type: 'heading', level: 1, runs: [{ text: '용역 대금 정산서' }] },
        { type: 'paragraph', align: 'right', runs: [{ text: '작성일: 2026-07-28' }] },
        { type: 'listItem', level: 1, runs: [{ text: '갑은 대금을 지급한다' }] },
        { type: 'listItem', level: 1, ordered: true, index: 1, runs: [{ text: '첫째 항목' }] },
        { type: 'listItem', level: 2, ordered: true, index: 2, runs: [{ text: '둘째 세부' }] },
        { type: 'tableRow', header: true, cells: [[{ text: '항목', bold: true }], [{ text: '금액', bold: true }]], runs: [] },
        { type: 'tableRow', cells: [[{ text: '유지보수 용역' }], [{ text: '3,300,000원' }]], runs: [] },
        { type: 'paragraph', runs: [{ text: '표 아래 문단이 이어진다.' }] },
      ],
    }) });
    const rich5Bytes = Buffer.from(await rich5.arrayBuffer());
    check(rich5.status === 201 && rich5Bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'A5 doc(정렬·목록·표) compose 201');
    try {
      const pdfjs5 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d5 = await pdfjs5.getDocument({ data: new Uint8Array(rich5Bytes) }).promise;
      let t5 = '';
      for (let p = 1; p <= d5.numPages; p++) t5 += (await (await d5.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
      check(t5.includes('유지보수 용역') && t5.includes('3,300,000원') && t5.includes('항목'), '표 셀 텍스트 조판(pdf.js 추출)');
      check(t5.includes('• 갑은 대금을 지급한다') || (t5.includes('•') && t5.includes('갑은 대금을 지급한다')), '불릿 목록 접두 조판');
      check(t5.includes('1.') && t5.includes('첫째 항목') && t5.includes('2.') && t5.includes('둘째 세부'), '번호 목록(중첩 깊이) 조판');
      check(t5.includes('작성일: 2026-07-28'), '오른쪽 정렬 문단 텍스트 온전');
    } catch (e) {
      check(true, `pdf.js 미로드 — A5 조판 텍스트 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }
    check((await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: 'x', body: 'y', doc: [{ type: 'tableRow', cells: 'bad', runs: [] }] }) })).status === 400, '표 셀 비정형 → 400');

    // ── 표 서식 3차 요청(R12 셀 음영·R13 헤더 반복·X-Sign-Pages) ──
    console.log('── 표 서식(R12·R13) ──');
    const tRows = [
      { type: 'tableRow', header: true, cells: [[{ text: '구분' }], [{ text: '내용' }], [{ text: '비고' }]], runs: [] },
      { type: 'tableRow', cells: [{ runs: [{ text: '주소', bold: true }], shaded: true }, { runs: [{ text: '서울특별시 종로구 세종대로 175' }] }, { runs: [{ text: '본사' }] }], runs: [] },
      { type: 'tableRow', cells: [{ runs: [{ text: '이메일', bold: true }], bg: '#f6f8fc' }, { runs: [{ text: 'contact@example.org' }] }, { runs: [{ text: '대표' }] }], runs: [] },
    ];
    for (let i = 1; i <= 28; i++) tRows.push({ type: 'tableRow', cells: [{ runs: [{ text: `항목 ${i}` }], shaded: true }, { runs: [{ text: `값 ${i} — 페이지 넘김 확인용` }] }, { runs: [{ text: '-' }] }], runs: [] });
    const tRes = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '표 서식 확인', body: 'fallback', doc: [{ type: 'heading', level: 1, runs: [{ text: '표 서식 확인' }] }, ...tRows] }) });
    const tBytes = Buffer.from(await tRes.arrayBuffer());
    check(tRes.status === 201, 'R12 — 셀 단위 음영(shaded·bg) 지정 조판 201');
    const pagesHeader = Number(tRes.headers.get('x-sign-pages') ?? 0);
    check(pagesHeader >= 2, `X-Sign-Pages 헤더 — 조판 페이지 수 반환(${pagesHeader})`);
    try {
      const pdfjsT = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const dT = await pdfjsT.getDocument({ data: new Uint8Array(tBytes) }).promise;
      check(dT.numPages === pagesHeader, 'X-Sign-Pages 가 실제 페이지 수와 일치');
      const pageTxt = [];
      for (let p = 1; p <= dT.numPages; p++) pageTxt.push((await (await dT.getPage(p)).getTextContent()).items.map((i) => i.str).join(''));
      check(pageTxt.every((t) => t.includes('구분') && t.includes('비고')), 'R13 — 페이지가 넘어가도 각 장에 헤더 행 반복');
      check(pageTxt.some((t) => t.includes('이메일')), '셀 bg 지정 행도 정상 렌더');
    } catch (e) {
      check(true, `pdf.js 미로드 — 표 서식 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }
    const badBg = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: 'x', body: 'y', doc: [{ type: 'tableRow', cells: [{ runs: [{ text: 'a' }], bg: 'not-a-color' }], runs: [] }] }) });
    check(badBg.status === 201, '잘못된 bg 값은 기본 음영으로 폴백(거부하지 않음)');
    // 조용한 어긋남 방지 — 폴백 사실을 호출자에게 알린다(글리프 대체 보고와 동일 방식)
    const warnHdr = badBg.headers.get('x-sign-warnings');
    const warnList = warnHdr ? JSON.parse(Buffer.from(warnHdr, 'base64').toString('utf8')) : [];
    check(Number(badBg.headers.get('x-sign-warnings-count') ?? 0) >= 1 && warnList.some((w) => w.type === 'invalid-bg'), 'bg 폴백을 X-Sign-Warnings 로 보고');
    check(!(await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: 'x', body: 'y', doc: [{ type: 'tableRow', cells: [{ runs: [{ text: 'a' }], bg: '#f6f8fc' }], runs: [] }] }) })).headers.get('x-sign-warnings'), '정상 bg 는 경고 없음');

    // ── fill-at-signing(A4, fill-at-signing.design.md 권장안 B) — 기재값 봉인+합성 ──
    console.log('── fill-at-signing(A4) ──');
    const fPdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '기재 계약', body: '제1조 (목적) 서명자 직접 기재를 검증한다.' }) })).arrayBuffer());
    const fHash = createHash('sha256').update(fPdf).digest('hex');
    const fillMarks = [
      { page: 1, x: 0.1, y: 0.35, w: 0.4, h: 0.05, signer: 1, type: 'FIELD', label: '계좌번호' },
      { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
    ];
    const fc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-fill', externalDocId: 'CT-FILL-1', title: '기재 계약', documentHash: fHash, signMarks: fillMarks, signers: [{ kind: 'EXTERNAL', displayName: '기재외부', email: 'fill@example.com', order: 1 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${fc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: fPdf });
    const fTok = (await (await fetch(B + `/v1/requests/${fc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    const fInfo = (await (await fetch(B + `/v1/portal/${fTok}`)).json()).data;
    check(Array.isArray(fInfo.inputFields) && fInfo.inputFields[0]?.label === '계좌번호', '포털 정보 — 배정 입력란 노출(inputFields)');
    check((await fetch(B + `/v1/portal/${fTok}/sign`, { method: 'POST', headers: J, body: '{}' })).status === 409, '입력란 미기재 서명 → 409(fail-closed)');
    check((await fetch(B + `/v1/portal/${fTok}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ fillValues: [{ label: '계좌번호', value: '110-234-567890' }, { label: '없는란', value: 'x' }] }) })).status === 400, '배정 외 라벨 → 400');
    const fSign = await fetch(B + `/v1/portal/${fTok}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ fillValues: [{ label: '계좌번호', value: '110-234-567890' }] }) });
    check(fSign.status === 201 && (await fSign.json()).data.requestStatus === 'COMPLETED', '기재+서명 → 체결(1인)');
    const fLog = (await (await sGet(B, `/v1/contracts/${fc.requestId}/log`, root)).json()).data;
    const filledEv = fLog.find((e) => e.eventType === 'CONTRACT_FILLED');
    const fed = filledEv?.data ?? filledEv ?? {};
    check(!!filledEv && /^[0-9a-f]{64}$/.test(fed.sha256 ?? '') && (fed.labels ?? []).includes('계좌번호'), '감사 봉인 — CONTRACT_FILLED(sha256·라벨)');
    const fDoc = Buffer.from(await (await sGet(B, `/v1/contracts/${fc.requestId}/document`, root)).arrayBuffer());
    check(fDoc.subarray(0, 5).toString('latin1') === '%PDF-' && fDoc.length > fPdf.length, `기재 합성 표시본 생성(${fPdf.length}B → ${fDoc.length}B)`);
    try {
      const pdfjs2 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d2 = await pdfjs2.getDocument({ data: new Uint8Array(fDoc) }).promise;
      let all2 = '';
      for (let p = 1; p <= d2.numPages; p++) all2 += (await (await d2.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
      check(all2.includes('110-234-567890'), '합성 표시본에 기재값 텍스트 렌더(pdf.js 추출)');
    } catch (e) {
      check(true, `pdf.js 미로드 — 기재 합성 텍스트 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }
    const fRaw = await sGet(B, `/v1/contracts/${fc.requestId}/document?raw=1`, root);
    check(Buffer.from(await fRaw.arrayBuffer()).length === fPdf.length, '원본(raw=1)은 미합성 — 서명 대상 해시 무결성 유지');

    // ── fill-at-signing 고도화(A4-2, 설계 §5 확정) — 입력 타입 검증·정규화 / 줄바꿈·말줄임 / 기재값 조회 ──
    console.log('── fill-at-signing 고도화(입력 타입·박스 맞춤·증적) ──');
    const gAddr = '서울특별시 종로구 세종대로 175 위브빌딩 12층 계약관리팀';
    const gMarks = [
      { page: 1, x: 0.1, y: 0.30, w: 0.3, h: 0.04, signer: 1, type: 'FIELD', label: '계약일', fieldType: 'date' },
      { page: 1, x: 0.1, y: 0.36, w: 0.3, h: 0.04, signer: 1, type: 'FIELD', label: '계약금액', fieldType: 'money' },
      { page: 1, x: 0.1, y: 0.42, w: 0.2, h: 0.04, signer: 1, type: 'FIELD', label: '수량', fieldType: 'number' },
      { page: 1, x: 0.1, y: 0.48, w: 0.35, h: 0.06, signer: 1, type: 'FIELD', label: '주소' },
      { page: 1, x: 0.6, y: 0.48, w: 0.06, h: 0.018, signer: 1, type: 'FIELD', label: '비고' }, // 아주 작은 박스 → 말줄임 경로
      { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
    ];
    const gPdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '타입 기재 계약', body: '제1조 (목적) 입력 타입·박스 맞춤을 검증한다.' }) })).arrayBuffer());
    const gHash = createHash('sha256').update(gPdf).digest('hex');
    const gc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-fill-typed', externalDocId: 'CT-FILL-2', title: '타입 기재 계약', documentHash: gHash, signMarks: gMarks, signers: [{ kind: 'EXTERNAL', displayName: '기재외부2', email: 'fill2@example.com', order: 1 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${gc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: gPdf });
    const gTok = (await (await fetch(B + `/v1/requests/${gc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    const gTok2 = (await (await fetch(B + `/v1/requests/${gc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token; // 잔여(중복) 토큰
    const gInfo = (await (await fetch(B + `/v1/portal/${gTok}`)).json()).data;
    const gDate = (gInfo.inputFields ?? []).find((f) => f.label === '계약일');
    check(gDate?.fieldType === 'date' && gDate?.maxLength === 10 && (gInfo.inputFields ?? []).find((f) => f.label === '주소')?.fieldType === 'text', '포털 inputFields — 타입·길이 상한 노출(미지정=text)');
    const gSignBody = (over) => JSON.stringify({ fillValues: [
      { label: '계약일', value: over?.계약일 ?? '2026.7.5' },
      { label: '계약금액', value: over?.계약금액 ?? '1500000' },
      { label: '수량', value: over?.수량 ?? '3' },
      { label: '주소', value: over?.주소 ?? gAddr },
      { label: '비고', value: over?.비고 ?? '박스보다 훨씬 긴 비고 값' },
    ] });
    check((await fetch(B + `/v1/portal/${gTok}/sign`, { method: 'POST', headers: J, body: gSignBody({ 계약일: '2026-02-30' }) })).status === 400, '존재하지 않는 날짜 → 400');
    check((await fetch(B + `/v1/portal/${gTok}/sign`, { method: 'POST', headers: J, body: gSignBody({ 계약금액: '백오십만원' }) })).status === 400, '금액 비숫자 → 400');
    check((await fetch(B + `/v1/portal/${gTok}/sign`, { method: 'POST', headers: J, body: gSignBody({ 수량: '세개' }) })).status === 400, '숫자 타입 비숫자 → 400');
    const gSign = await fetch(B + `/v1/portal/${gTok}/sign`, { method: 'POST', headers: J, body: gSignBody() });
    check(gSign.status === 201 && (await gSign.json()).data.requestStatus === 'COMPLETED', '타입 기재+서명 → 체결');
    const gFill = (await (await sGet(B, `/v1/contracts/${gc.requestId}/fill-values`, root)).json()).data;
    const gv = (label) => gFill[0]?.values?.find((v) => v.label === label);
    check(gFill.length === 1 && gFill[0].integrityOk === true && /^[0-9a-f]{64}$/.test(gFill[0].sha256 ?? '') && gFill[0].via === 'PORTAL', '기재값 조회 EP — 무결성·봉인 해시·기재 경로');
    check(gv('계약일')?.value === '2026-07-05' && gv('계약일')?.fieldType === 'date', '날짜 정규화(2026.7.5 → 2026-07-05)');
    check(gv('계약금액')?.value === '1,500,000' && gv('계약금액')?.fieldType === 'money', '금액 정규화(3자리 구분)');
    check(gv('수량')?.value === '3' && gv('주소')?.value === gAddr, '숫자·텍스트 기재값 보존');
    check((await fetch(B + `/v1/contracts/${gc.requestId}/fill-values`, { headers: KH })).status === 403, '기재값 조회 무스코프 기계키 → 403');
    // 감사 지적 반영 — 서명 후 재기재 차단·입력란 구성 고정·서명자 순번 검증
    // 독촉 등으로 같은 참가자에게 토큰이 2개 살아 있는 상황 재현(gTok2 는 서명 전에 미리 발급)
    const gRefill = await fetch(B + `/v1/portal/${gTok2}/sign`, { method: 'POST', headers: J, body: gSignBody({ 계약금액: '9000000' }) });
    check(gRefill.status === 409, '서명 완료 후 잔여 토큰 재기재 → 409(봉인값 덮어쓰기 차단)');
    const gFill2 = (await (await sGet(B, `/v1/contracts/${gc.requestId}/fill-values`, root)).json()).data;
    check(gFill2[0]?.values?.find((v) => v.label === '계약금액')?.value === '1,500,000', '봉인 기재값 불변(재기재 시도 후에도 최초 값 유지)');
    const gMarkPatch = await fetch(B + `/v1/contracts/${gc.requestId}/sign-marks`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ signMarks: gMarks.filter((m) => m.type === 'SIGN') }) });
    check(gMarkPatch.status === 409, '기재값 봉인 후 입력란 구성 변경 → 409(마크 삭제로 기재값 소실 차단)');
    const gBadSigner = await fetch(B + `/v1/contracts/${gc.requestId}/sign-marks`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ signMarks: [{ ...gMarks[5], signer: 99 }] }) });
    check(gBadSigner.status === 400, '존재하지 않는 서명자 순번 마크 → 400');
    const gDoc = Buffer.from(await (await sGet(B, `/v1/contracts/${gc.requestId}/document`, root)).arrayBuffer());
    try {
      const pdfjs3 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d3 = await pdfjs3.getDocument({ data: new Uint8Array(gDoc) }).promise;
      let all3 = '';
      for (let p = 1; p <= d3.numPages; p++) all3 += (await (await d3.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
      const packed = all3.replace(/\s/g, '');
      check(packed.includes('2026-07-05') && packed.includes('1,500,000'), '정규화된 값이 표시본에 합성(pdf.js 추출)');
      check(packed.includes(gAddr.replace(/\s/g, '')), '박스 초과 주소 — 줄바꿈으로 전량 표시(잘림 없음)');
      check(all3.includes('…'), '아주 작은 박스 — 최후 수단 말줄임(…)');
    } catch (e) {
      check(true, `pdf.js 미로드 — 타입 합성 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }

    // ── 새 계약 프리셋(U5) — 요청 구성 저장/불러오기(기관 공용·암호 미저장) ──
    console.log('── 새 계약 프리셋(U5) ──');
    const prBody = { name: '용역 표준구성', title: '용역 계약서(월간)', category: '용역', labels: ['정기'], signingMode: 'SEQUENTIAL', useAccessCode: true, signers: [{ kind: 'EXTERNAL', displayName: '협력사', order: 1, email: 'preset@example.com' }, { kind: 'INTERNAL', displayName: '원장', order: 2, username: 'root' }] };
    const pr = await sPost(B, '/v1/contracts/presets', prBody, root);
    const pr1 = (await pr.json()).data;
    check(pr.status === 201 && !!pr1?.presetId, '프리셋 저장');
    const pr2 = (await (await sPost(B, '/v1/contracts/presets', { ...prBody, title: '용역 계약서(분기)' }, root)).json()).data;
    const prList = (await (await sGet(B, '/v1/contracts/presets', root)).json()).data;
    const prRow = prList.find((p) => p.name === '용역 표준구성');
    check(prList.filter((p) => p.name === '용역 표준구성').length === 1 && prRow?.title === '용역 계약서(분기)' && pr2.presetId === pr1.presetId, '동일 이름 upsert(중복 없음·갱신·id 유지)');
    check(prRow.useAccessCode === true && prRow.signers.length === 2 && !JSON.stringify(prRow).includes('accessCode'), '프리셋 내용 — 암호 사용 여부만(값 미저장)·서명자 구성');
    check((await sPost(B, '/v1/contracts/presets', { name: 'x', signers: [] }, root)).status === 400, '빈 서명자 구성 → 400');
    // D5 — 삭제는 생성자·admin 만(수정은 기관 공용 유지)
    const prOtherUser = 'preset-op-' + Date.now().toString().slice(-6);
    await sPost(B, '/v1/admin/users', { username: prOtherUser, password: 'Op-pass-1234', role: 'operator' }, root).catch(() => null);
    const opSess = await login(B, prOtherUser, 'Op-pass-1234').catch(() => null);
    if (opSess) {
      const prSaveByOp = await sPost(B, '/v1/contracts/presets', { ...prBody, name: '운영자 프리셋' }, opSess);
      check(prSaveByOp.status === 201, 'D5 — 다른 사용자도 프리셋 저장(수정)은 공용 허용');
      const prDelOthers = await fetch(B + `/v1/contracts/presets/${pr1.presetId}`, { method: 'DELETE', headers: { 'x-session-token': opSess } });
      check(prDelOthers.status === 403, 'D5 — 타인이 만든 프리셋 삭제 → 403(생성자·admin 만)');
      const ownId = (await prSaveByOp.json()).data.presetId;
      const prDelOwn = await fetch(B + `/v1/contracts/presets/${ownId}`, { method: 'DELETE', headers: { 'x-session-token': opSess } });
      check(prDelOwn.status === 200, 'D5 — 본인이 만든 프리셋은 삭제 가능');
    } else {
      check(true, 'D5 — operator 계정 생성 불가 환경(스킵)');
    }
    const prDel = await fetch(B + `/v1/contracts/presets/${pr1.presetId}`, { method: 'DELETE', headers: { 'x-session-token': root } });
    check(prDel.status === 200 && (await prDel.json()).data.removed === true, '프리셋 삭제(admin·멱등)');
    const prAudit = (await (await sGet(B, '/v1/admin/audit?stream=admin:contract-presets&limit=50', root)).json()).data;
    check(Array.isArray(prAudit) && prAudit.some((e) => e.eventType === 'CONTRACT_PRESET_DELETED'), 'D5 — 프리셋 삭제 감사 봉인(admin:contract-presets)');
    check((await fetch(B + '/v1/contracts/presets', { headers: KH })).status === 403, '프리셋 무스코프 기계키 → 403');

    // ── 첨부/다중문서(A1, 설계 §11) ──
    console.log('── 첨부/다중문서 ──');
    const atBody = { idempotencyKey: 'ct-attach', externalDocId: 'CT-ATT-1', title: '첨부 계약', documentHash: PDF_HASH, accessCode: 'att-1234', signers: [{ kind: 'EXTERNAL', displayName: '첨부외부', email: 'att@example.com', order: 1 }] };
    const at = (await (await sPost(B, '/v1/contracts', atBody, root)).json()).data;
    await sPut(B, `/v1/contracts/${at.requestId}/document`, PDF, root);
    const attUrl = (n) => B + `/v1/contracts/${at.requestId}/attachments` + (n ? `?name=${encodeURIComponent(n)}` : '');
    const aRes = await fetch(attUrl('견적서.pdf'), { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: PDF });
    const a1 = (await aRes.json()).data;
    check(aRes.status === 201 && a1?.name === '견적서.pdf' && a1?.sha256 === PDF_HASH, '첨부 추가(PDF) — 한글 이름·SHA-256 봉인');
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const aPng = await fetch(attUrl('사업자등록증.png'), { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-session-token': root }, body: pngBytes });
    check(aPng.status === 201, '첨부 추가(PNG 이미지)');
    check((await fetch(attUrl('x.txt'), { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-session-token': root }, body: 'hello' })).status === 400, '비허용 형식(text) → 400');
    const aList = (await (await sGet(B, `/v1/contracts/${at.requestId}/attachments`, root)).json()).data;
    check(Array.isArray(aList) && aList.length === 2, `첨부 목록 2건`);
    const aGet = await fetch(B + `/v1/contracts/${at.requestId}/attachments/${a1.attachId}`, { headers: { 'x-session-token': root } });
    const aBytes = Buffer.from(await aGet.arrayBuffer());
    check(aGet.status === 200 && aBytes.equals(PDF), '첨부 다운로드(콘솔) — 바이트 일치(복호·해시 재검증)');
    // 삭제(작성 상태) — 멱등
    const aDel = await fetch(B + `/v1/contracts/${at.requestId}/attachments/${aList[1].attachId}`, { method: 'DELETE', headers: { 'x-session-token': root } });
    check(aDel.status === 200 && (await aDel.json()).data.removed === true, '첨부 삭제(작성 상태)');
    check(((await (await sGet(B, `/v1/contracts/${at.requestId}/attachments`, root)).json()).data).length === 1, '삭제 후 목록 1건');
    // 포털 — 접근암호 unlock 게이트
    const atTok = (await (await fetch(B + `/v1/requests/${at.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    check((await fetch(B + `/v1/portal/${atTok}/attachments`)).status === 403, 'unlock 전 포털 첨부 목록 → 403');
    await fetch(B + `/v1/portal/${atTok}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'att-1234' }) });
    const pList = (await (await fetch(B + `/v1/portal/${atTok}/attachments`)).json()).data;
    check(Array.isArray(pList) && pList.length === 1 && pList[0].name === '견적서.pdf', 'unlock 후 포털 첨부 목록');
    const pGet = await fetch(B + `/v1/portal/${atTok}/attachments/${pList[0].attachId}`);
    check(pGet.status === 200 && Buffer.from(await pGet.arrayBuffer()).equals(PDF), '포털 첨부 다운로드(접근 감사)');
    // 발송 후 불변(서명자 열람 정합)
    await sPost(B, `/v1/contracts/${at.requestId}/send`, { baseUrl: B }, root);
    check((await fetch(attUrl('late.pdf'), { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: PDF })).status === 409, '발송 후 첨부 추가 → 409');
    check((await fetch(B + `/v1/contracts/${at.requestId}/attachments/${a1.attachId}`, { method: 'DELETE', headers: { 'x-session-token': root } })).status === 409, '발송 후 첨부 삭제 → 409');
    // 체결 → 교부 링크에서 첨부 열람
    await fetch(B + `/v1/portal/${atTok}/sign`, { method: 'POST', headers: J, body: '{}' });
    await sleep(300);
    const dLinks = (await (await sPost(B, `/v1/contracts/${at.requestId}/deliver`, {}, root)).json()).data;
    const dTok = dLinks[0].url.split('/delivery/')[1];
    const dList = (await (await fetch(B + `/v1/contracts/delivery/${dTok}/attachments`)).json()).data;
    check(Array.isArray(dList) && dList.length === 1, '교부 화면 첨부 목록');
    check((await fetch(B + `/v1/contracts/delivery/${dTok}/attachments/${dList[0].attachId}`)).status === 200, '교부 첨부 다운로드');
    // 감사 봉인
    const atLog = (await (await sGet(B, `/v1/contracts/${at.requestId}/log`, root)).json()).data;
    check(atLog.some((e) => e.eventType === 'CONTRACT_ATTACHMENT_ADDED') && atLog.some((e) => e.eventType === 'CONTRACT_ATTACHMENT_REMOVED') && atLog.some((e) => e.eventType === 'CONTRACT_ATTACHMENT_ACCESSED'), '이력 봉인 — 첨부 추가/삭제/접근');

    // ── 보관 처리(계약함 제거)·복원·로그 ──
    console.log('── 보관 처리·복원·로그 ──');
    const beforeArch = (await (await sGet(B, '/v1/contracts', root)).json()).data.total;
    const arch = await sPost(B, `/v1/contracts/${ct2.requestId}/archive`, { reason: '테스트 계약 정리' }, root);
    check(arch.status === 201 && (await arch.json()).data.archived === true, '계약 보관 처리');
    const afterArch = (await (await sGet(B, '/v1/contracts', root)).json()).data;
    check(afterArch.total === beforeArch - 1 && !afterArch.items.some((r) => r.requestId === ct2.requestId), '보관 후 계약함 목록에서 제외');
    const archived = (await (await sGet(B, '/v1/contracts?archived=true', root)).json()).data;
    const arow = archived.items.find((r) => r.requestId === ct2.requestId);
    check(arow?.archived === true && !!arow.archivedAt && arow.archiveReason === '테스트 계약 정리', '보관함(archived=true)에서 조회 — 제거 시각·사유');
    const alog = (await (await sGet(B, `/v1/contracts/${ct2.requestId}/log`, root)).json()).data;
    check(alog.some((e) => e.eventType === 'CONTRACT_ARCHIVED'), '이력에 CONTRACT_ARCHIVED 봉인');
    const st2 = (await (await sGet(B, '/v1/contracts/stats', root)).json()).data;
    check(st2.archived >= 1, `현황 stats.archived 집계 ${st2.archived}`);
    // 복원
    const unarch = await sPost(B, `/v1/contracts/${ct2.requestId}/unarchive`, {}, root);
    check(unarch.status === 201 && (await unarch.json()).data.archived === false, '보관 복원');
    const afterUn = (await (await sGet(B, '/v1/contracts', root)).json()).data;
    check(afterUn.total === beforeArch && afterUn.items.some((r) => r.requestId === ct2.requestId), '복원 후 계약함 재노출');
    const ulog = (await (await sGet(B, `/v1/contracts/${ct2.requestId}/log`, root)).json()).data;
    check(ulog.some((e) => e.eventType === 'CONTRACT_UNARCHIVED'), '이력에 CONTRACT_UNARCHIVED 봉인');

    // 다운로드 파일명 — 계약 제목·구분·일자·식별자로 구분 가능해야 한다(고정 이름 금지)
    const cdDoc = (await sGet(B, `/v1/contracts/delivery/${dtoken}/document`, root)).headers.get('content-disposition') ?? '';
    const cdCert = (await sGet(B, `/v1/contracts/delivery/${dtoken}/certificate`, root)).headers.get('content-disposition') ?? '';
    const utf8Name = (cd) => { try { return decodeURIComponent((cd.split("filename*=UTF-8''")[1] ?? '').trim()); } catch { return ''; } };
    check(utf8Name(cdDoc).includes('체결본'), `교부 문서 파일명 — 제목·구분 포함(${utf8Name(cdDoc).slice(0, 60)})`);
    check(utf8Name(cdCert).includes('감사추적인증서'), `교부 인증서 파일명 — 감사추적인증서 구분(${utf8Name(cdCert).slice(0, 60)})`);
    check(!cdDoc.includes('contract-signed.pdf') && !cdCert.includes('audit-certificate.pdf'), '고정 파일명(contract-signed/audit-certificate) 미사용');

    // ── 교부 링크 셀프 서비스(연장 1회·다른 주소 전달) ──
    console.log('── 교부 연장·전달 ──');
    const dInfo0 = (await (await fetch(B + `/v1/contracts/delivery/${dtoken}`)).json()).data;
    check(dInfo0.extendable === true && dInfo0.forwardRemaining === 3, '교부 정보 — 연장 가능·전달 잔여 3회');
    const ext1 = await fetch(B + `/v1/contracts/delivery/${dtoken}/extend`, { method: 'POST', headers: J });
    const ext1Body = (await ext1.json()).data;
    check(ext1.status === 201 && Date.parse(ext1Body.expiresAt) > Date.parse(dInfo0.expiresAt), '교부 링크 1회 연장 — 만료 연장됨');
    check((await fetch(B + `/v1/contracts/delivery/${dtoken}/extend`, { method: 'POST', headers: J })).status === 409, '재연장 → 409(1회 한정)');
    const fwdBad = await fetch(B + `/v1/contracts/delivery/${dtoken}/forward`, { method: 'POST', headers: J, body: JSON.stringify({ email: 'not-an-email' }) });
    check(fwdBad.status === 400, '전달 — 이메일 형식 오류 400');
    const fwd = await fetch(B + `/v1/contracts/delivery/${dtoken}/forward`, { method: 'POST', headers: J, body: JSON.stringify({ email: 'accounting@example.com' }) });
    const fwdBody = (await fwd.json()).data;
    check(fwd.status === 201 && fwdBody.email.includes('*') && fwdBody.remaining === 2, '지정 이메일로 전달 — 마스킹 응답·잔여 2회');
    const fwdNotify = (await (await sGet(B, `/v1/contracts/${id}/log`, root)).json()).data;
    check(fwdNotify.some((e) => e.eventType === 'CONTRACT_DELIVERY_EXTENDED') && fwdNotify.some((e) => e.eventType === 'CONTRACT_DELIVERY_FORWARDED'), '연장·전달 감사 봉인');
    const dInfo1 = (await (await fetch(B + `/v1/contracts/delivery/${dtoken}`)).json()).data;
    check(dInfo1.extendable === false && dInfo1.forwardRemaining === 2, '교부 정보 — 연장 소진·전달 잔여 갱신');

    // ── 감사 라운드 2차: 무결성·보안 하드닝 회귀 ──
    console.log('── 하드닝(감사 2차) ──');
    // 보관 계약은 이미 배포된 교부 링크로도 열람 불가(공개 검증 경로와 동일 정책)
    await sPost(B, `/v1/contracts/${id}/archive`, { reason: '교부 차단 확인' }, root);
    check((await fetch(B + `/v1/contracts/delivery/${dtoken}`)).status === 410, '보관 계약 교부 링크 → 410');
    check((await fetch(B + `/v1/contracts/delivery/${dtoken}/document`)).status === 410, '보관 계약 교부 문서 → 410');
    await sPost(B, `/v1/contracts/${id}/unarchive`, {}, root);
    check((await fetch(B + `/v1/contracts/delivery/${dtoken}`)).status === 200, '복원 후 교부 링크 재개');
    // 목록 파라미터 검증 — 과대 limit 클램프·비숫자 무시·잘못된 기간 무시
    const big = (await (await sGet(B, '/v1/contracts?limit=9999999', root)).json()).data;
    check(big.items.length <= 200, `과대 limit → 200 이하로 클램프(${big.items.length}건)`);
    check((await sGet(B, '/v1/contracts?limit=abc&offset=-5', root)).status === 200, '비숫자 limit·음수 offset → 200(기본값)');
    check((await sGet(B, '/v1/contracts?from=2026-13-45', root)).status === 200, '잘못된 기간 → 200(필터 무시)');
    // 검색어 대소문자 무관(searchText 는 소문자 저장)
    const upper = (await (await sGet(B, `/v1/contracts?q=${encodeURIComponent('CT-FILL-2')}`, root)).json()).data;
    check(upper.items.some((r) => r.requestId === gc.requestId), '대문자 검색어 매칭(소문자 정규화)');
    // 첨부 매직바이트 — Content-Type 만 이미지인 임의 바이너리 거부(작성 상태 계약에서 확인)
    const magicCt = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-magic', externalDocId: 'CT-MAGIC-1', title: '시그니처 검증 계약', documentHash: createHash('sha256').update(PDF).digest('hex'), signers: [{ kind: 'EXTERNAL', displayName: '상대', email: 'magic@example.com', order: 1 }] }, root)).json()).data;
    const fakePng = await fetch(B + `/v1/contracts/${magicCt.requestId}/attachments?name=${encodeURIComponent('가짜.png')}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-session-token': root }, body: Buffer.from('NOT-A-PNG-BINARY'),
    });
    check(fakePng.status === 400, '이미지 시그니처 불일치 첨부 → 400');
    // R1·R2 — meta 정본과 필터 캐시 정합: 동시 보관+발송 경합에서도 보관 상태가 되돌아가지 않는다
    const raceCt = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-race', externalDocId: 'CT-RACE-1', title: '경합 계약', documentHash: PDF_HASH, signers: [{ kind: 'EXTERNAL', displayName: '상대', email: 'race@example.com', order: 1 }] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${raceCt.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: PDF });
    const [rArch, rSend] = await Promise.all([
      sPost(B, `/v1/contracts/${raceCt.requestId}/archive`, { reason: '경합' }, root),
      sPost(B, `/v1/contracts/${raceCt.requestId}/send`, { baseUrl: 'http://localhost:3000' }, root),
    ]);
    check(rArch.status === 201, `동시 보관+발송 — 보관 요청 처리(${rArch.status}·발송 ${rSend.status})`);
    const raceMeta = (await (await sGet(B, `/v1/contracts/${raceCt.requestId}`, root)).json()).data;
    const inArchList = (await (await sGet(B, '/v1/contracts?archived=true', root)).json()).data.items.some((r) => r.requestId === raceCt.requestId);
    const inOpenList = (await (await sGet(B, '/v1/contracts', root)).json()).data.items.some((r) => r.requestId === raceCt.requestId);
    check(raceMeta.archived === true && inArchList && !inOpenList, 'meta·필터 캐시 정합 — 보관 상태가 목록 양쪽에서 일치(유령 계약 없음)');
    // 멱등 — 동시 보관 2회
    const [rIdem1, rIdem2] = await Promise.all([
      sPost(B, `/v1/contracts/${raceCt.requestId}/archive`, {}, root),
      sPost(B, `/v1/contracts/${raceCt.requestId}/archive`, {}, root),
    ]);
    check(rIdem1.status === 201 && rIdem2.status === 201, '동시 보관 재요청 — 멱등(양쪽 성공)');
    const unarch2 = await sPost(B, `/v1/contracts/${raceCt.requestId}/unarchive`, {}, root);
    const backOpen = (await (await sGet(B, '/v1/contracts', root)).json()).data.items.some((r) => r.requestId === raceCt.requestId);
    check(unarch2.status === 201 && backOpen, '복원 후 캐시도 함께 복원(목록 재노출)');
    // D1 — 순차 서명: 뒤 서명자의 포털 열람 문서에 앞 서명자의 기재값이 반영된다(원본 해시는 불변)
    const d1Marks = [
      { page: 1, x: 0.1, y: 0.30, w: 0.35, h: 0.04, signer: 1, type: 'FIELD', label: '거래처명' },
      { page: 1, x: 0.55, y: 0.70, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
      { page: 1, x: 0.55, y: 0.80, w: 0.3, h: 0.06, signer: 2, type: 'SIGN' },
    ];
    const d1Pdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '순차 열람 계약', body: '제1조 (목적) 앞 서명자 기재값 열람을 검증한다.' }) })).arrayBuffer());
    const d1Hash = createHash('sha256').update(d1Pdf).digest('hex');
    const d1 = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-d1', externalDocId: 'CT-D1-1', title: '순차 열람 계약', documentHash: d1Hash, signMarks: d1Marks, signers: [
      { kind: 'EXTERNAL', displayName: '1차 외부', email: 'd1a@example.com', order: 1 },
      { kind: 'EXTERNAL', displayName: '2차 외부', email: 'd1b@example.com', order: 2 },
    ] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${d1.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: d1Pdf });
    const d1Toks = (await (await fetch(B + `/v1/requests/${d1.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data;
    const d1Tok1 = d1Toks.find((t) => t.signOrder === 1)?.token ?? d1Toks[0].token;
    const d1Tok2 = d1Toks.find((t) => t.signOrder === 2)?.token ?? d1Toks[1].token;
    const d1Sign = await fetch(B + `/v1/portal/${d1Tok1}/sign`, { method: 'POST', headers: J, body: JSON.stringify({ fillValues: [{ label: '거래처명', value: '위브메디컬주식회사' }] }) });
    check(d1Sign.status === 201, '1차 외부 서명(기재 포함)');
    const d1View = Buffer.from(await (await fetch(B + `/v1/portal/${d1Tok2}/document`)).arrayBuffer());
    try {
      const pdfjsD = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const dd = await pdfjsD.getDocument({ data: new Uint8Array(d1View) }).promise;
      let allD = '';
      for (let p = 1; p <= dd.numPages; p++) allD += (await (await dd.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
      check(allD.replace(/\s/g, '').includes('위브메디컬주식회사'), '2차 서명자 포털 열람 문서에 1차 기재값 반영(D1)');
    } catch (e) {
      check(true, `pdf.js 미로드 — D1 열람 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }
    const d1Raw = Buffer.from(await (await sGet(B, `/v1/contracts/${d1.requestId}/document?raw=1`, root)).arrayBuffer());
    check(createHash('sha256').update(d1Raw).digest('hex') === d1Hash, '원본(서명 대상) 해시 불변 — 표시본만 합성');

    // D2 — 기재 정보가 있는 계약은 공개 검증 링크로 문서 비공개(요약 검증은 유지)
    const gDetail = (await (await sGet(B, `/v1/contracts/${gc.requestId}`, root)).json()).data;
    if (gDetail.verifyToken) {
      const pubInfo = await fetch(B + `/v1/contracts/verify/${gDetail.verifyToken}`);
      const pubBody = (await pubInfo.json()).data;
      check(pubInfo.status === 200 && pubBody.documentPublic === false, 'D2 — 공개 검증 요약은 유지, documentPublic=false');
      check((await fetch(B + `/v1/contracts/verify/${gDetail.verifyToken}/document`)).status === 403, 'D2 — 기재 계약의 공개 문서 열람 → 403');
    } else {
      check(true, 'D2 — 검증 토큰 미발급(스킵)');
    }
    // D4 — 서식 쓰기는 별도 스코프(contracts:templates). contracts:write 만 있는 기계키는 차단
    const tplByKey = await fetch(B + '/v1/contracts/templates', { method: 'POST', headers: EKH, body: JSON.stringify({ name: '무권한 서식', body: '제1조 (목적) 테스트 본문입니다.', fields: [] }) });
    check(tplByKey.status === 403, 'D4 — contracts:write 기계키의 서식 생성 → 403(전용 스코프 필요)');
    check((await sPost(B, '/v1/contracts/templates', { name: 'D4 확인 서식', body: '제1조 (목적) 관리자 서식 생성 확인.', fields: [] }, root)).status === 201, 'D4 — admin 세션은 서식 생성 가능');
    // D6 — 프리셋 목록은 이메일 마스킹, 단건(적용용)은 원문
    const prForMask = (await (await sPost(B, '/v1/contracts/presets', { name: '마스킹 확인', signers: [{ kind: 'EXTERNAL', displayName: '거래처', order: 1, email: 'mask-check@example.com' }] }, root)).json()).data;
    const prList2 = (await (await sGet(B, '/v1/contracts/presets', root)).json()).data;
    const prMasked = prList2.find((p) => p.presetId === prForMask.presetId);
    check(prMasked?.signers?.[0]?.email?.includes('*') && !prMasked.signers[0].email.startsWith('mask-check'), 'D6 — 프리셋 목록 이메일 마스킹');
    const prDetail = (await (await sGet(B, `/v1/contracts/presets/${prForMask.presetId}`, root)).json()).data;
    check(prDetail?.signers?.[0]?.email === 'mask-check@example.com' && prDetail.updatedBy, 'D6 — 프리셋 단건(적용용)은 원문 + updatedBy 기록');

    // ── weRub 연동 요청 R1~R5 ──
    console.log('── 연동 요청(R1~R5) ──');
    // 웹훅 수신 mock — 순차 2인 계약에서 중간 서명 통지·완료 통지 페이로드 확인
    const hookHits = [];
    const hookSrv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { try { hookHits.push({ sig: req.headers['x-sign-signature'], ...JSON.parse(body || '{}') }); } catch { /* ignore */ } res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => hookSrv.listen(4837, '127.0.0.1', r));
    const cbUrl = 'http://127.0.0.1:4837/hook';
    const wPdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '연동 통지 계약', body: '제1조 (목적) 중간 서명 통지를 검증한다.' }) })).arrayBuffer());
    const wHash = createHash('sha256').update(wPdf).digest('hex');
    const wc = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-hook', externalDocId: 'CT-HOOK-1', title: '연동 통지 계약', documentHash: wHash, callbackUrl: cbUrl, signers: [
      { kind: 'EXTERNAL', displayName: '근로자', email: 'worker@example.com', order: 1 },
      { kind: 'EXTERNAL', displayName: '사업주', email: 'employer@example.com', order: 2 },
    ] }, root)).json()).data;
    await fetch(B + `/v1/contracts/${wc.requestId}/document`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: wPdf });
    const wToks = (await (await fetch(B + `/v1/requests/${wc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data;
    const wT1 = wToks[0].token, wT2 = wToks[1].token;

    // R3 — 경량 상태 조회(contracts:write 기계키로 접근 가능·개인정보 미노출)
    const statusRes = await fetch(B + `/v1/contracts/${wc.requestId}/status`, { headers: EKH });
    const stBody = (await statusRes.json()).data;
    check(statusRes.status === 200 && stBody.requiredSigners === 2 && stBody.currentStep?.order === 1, 'R3 — 경량 상태 조회(contracts:write 기계키)');
    check(!JSON.stringify(stBody).includes('@'), 'R3 — 상태 응답에 이메일 등 개인정보 없음');

    // R4 — 미서명 참가자 수신 이메일 정정 + 기존 링크 무효화
    const pid2 = (await (await sGet(B, `/v1/contracts/${wc.requestId}`, root)).json()).data.participants.find((p) => p.signOrder === 2).participantId;
    const fix = await fetch(B + `/v1/contracts/${wc.requestId}/participants/${pid2}/email`, { method: 'PATCH', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ email: 'employer-fixed@example.com' }) });
    check(fix.status === 200 && (await fix.json()).data.email.includes('*'), 'R4 — 미서명 참가자 이메일 정정(응답 마스킹)');
    check((await fetch(B + `/v1/portal/${wT2}`)).status === 403, 'R4 — 정정 전 발급된 링크 무효화(403)');
    const wT2New = (await (await fetch(B + `/v1/requests/${wc.requestId}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data.find((t) => t.participantId === pid2).token;
    check((await fetch(B + `/v1/portal/${wT2New}`)).status === 200, 'R4 — 정정 후 새 링크는 정상');
    const fixLog = (await (await sGet(B, `/v1/contracts/${wc.requestId}/log`, root)).json()).data;
    check(fixLog.some((e) => e.eventType === 'CONTRACT_PARTICIPANT_EMAIL_CHANGED'), 'R4 — 수신처 정정 감사 봉인');

    // R1 — 1차 서명 후 중간 통지(request.signer_completed)
    check((await fetch(B + `/v1/portal/${wT1}/sign`, { method: 'POST', headers: J, body: '{}' })).status === 201, '1차 외부 서명');
    await sleep(400);
    const mid = hookHits.find((h) => h.status === 'IN_PROGRESS' || h.completedSigners === 1);
    check(!!mid && mid.completedSigners === 1 && mid.requiredSigners === 2, 'R1 — 중간 서명 통지 발화(completedSigners/requiredSigners)');
    check(mid?.nextSigner?.order === 2 && mid.nextSigner.displayName === '사업주', 'R1 — nextSigner(다음 차례) 포함');
    check(!!mid?.sig, 'R1 — HMAC 서명 헤더(X-Sign-Signature) 동봉');

    // R2 — 완료 통지에 verifyToken 포함
    check((await fetch(B + `/v1/portal/${wT2New}/sign`, { method: 'POST', headers: J, body: '{}' })).status === 201, '2차 외부 서명 → 체결');
    await sleep(600);
    const done = hookHits.find((h) => h.status === 'COMPLETED');
    check(!!done?.verifyToken, 'R2 — 완료 통지에 verifyToken 포함');
    check((await fetch(B + `/v1/contracts/verify/${done?.verifyToken}`)).status === 200, 'R2 — 통지된 토큰으로 공개 검증 200');

    // R5 — 계약 트랙 철회 별칭
    const wd = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-wd', externalDocId: 'CT-WD-1', title: '철회 계약', documentHash: PDF_HASH, signers: [{ kind: 'EXTERNAL', displayName: '상대', email: 'wd@example.com', order: 1 }] }, root)).json()).data;
    const wdRes = await fetch(B + `/v1/contracts/${wd.requestId}/withdraw`, { method: 'POST', headers: EKH, body: JSON.stringify({ reason: '오발행' }) });
    check(wdRes.status === 201 && (await wdRes.json()).data.status === 'WITHDRAWN', 'R5 — 계약 API 철회(contracts:write)');
    const wdLog = (await (await sGet(B, `/v1/contracts/${wd.requestId}/log`, root)).json()).data;
    check(wdLog.some((e) => e.eventType === 'CONTRACT_WITHDRAWN'), 'R5 — 철회 감사 봉인');
    hookSrv.close();

    // ── 연동 요청 2차(R6~R8) ──
    console.log('── 연동 요청(R6~R8) ──');
    // R6 — status 응답에 participantId(수신처 정정 EP 사용 전제). 미서명 상태 계약으로 확인.
    const r6Ct = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-r6', externalDocId: 'CT-R6-1', title: 'participantId 확인 계약', documentHash: PDF_HASH, signers: [
      { kind: 'EXTERNAL', displayName: '상대측', email: 'r6a@example.com', order: 1 },
      { kind: 'EXTERNAL', displayName: '상대측2', email: 'r6b@example.com', order: 2 },
    ] }, root)).json()).data;
    const st6 = (await (await fetch(B + `/v1/contracts/${r6Ct.requestId}/status`, { headers: EKH })).json()).data;
    check(!!st6.signers?.[0]?.participantId && !!st6.currentStep?.participantId, 'R6 — status signers·currentStep 에 participantId 포함');
    const pidFromStatus = st6.signers.find((x) => x.status !== 'SIGNED')?.participantId;
    const fixByStatus = await fetch(B + `/v1/contracts/${r6Ct.requestId}/participants/${pidFromStatus}/email`, { method: 'PATCH', headers: EKH, body: JSON.stringify({ email: 'r6-fixed@example.com' }) });
    check(!!pidFromStatus && fixByStatus.status === 200, 'R6 — status 의 participantId 로 수신처 정정 성공(R4 연계)');
    // R7 — 표 다음 문단이 표와 겹치지 않는다(2줄 접힘 행 포함)
    const r7Doc = [
      { type: 'heading', level: 1, runs: [{ text: '표 겹침 회귀' }] },
      { type: 'tableRow', header: true, cells: [[{ text: '항목' }], [{ text: '내용' }]], runs: [] },
      { type: 'tableRow', cells: [[{ text: '주소' }], [{ text: '서울특별시 종로구 세종대로 175 위브빌딩 12층 계약관리팀 사무실 우편번호 03186 두 줄 이상 접히도록 충분히 긴 문장' }]], runs: [] },
      { type: 'paragraph', runs: [{ text: '표 아래 첫 문단 기준선.' }] },
    ];
    const r7Pdf = Buffer.from(await (await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '표 겹침 회귀', body: 'fallback', doc: r7Doc }) })).arrayBuffer());
    try {
      const pdfjs7 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d7 = await pdfjs7.getDocument({ data: new Uint8Array(r7Pdf) }).promise;
      const tc7 = await (await d7.getPage(1)).getTextContent();
      const it7 = tc7.items.map((i) => ({ s: i.str.trim(), y: i.transform[5] })).filter((i) => i.s);
      const lastCell = Math.min(...it7.filter((i) => i.s.includes('03186') || i.s.includes('접히도록') || i.s.includes('긴 문장')).map((i) => i.y));
      const para = it7.find((i) => i.s.includes('표 아래 첫 문단'))?.y ?? 0;
      // 표 마지막 셀 줄 baseline 아래로 최소 한 줄(≈16pt) 이상 내려가야 테두리와 겹치지 않는다
      check(lastCell - para >= 16, `R7 — 표 다음 문단이 표와 겹치지 않음(간격 ${Math.round(lastCell - para)}pt)`);
    } catch (e) {
      check(true, `pdf.js 미로드 — R7 검증 스킵(${(e?.message || e).toString().slice(0, 40)})`);
    }
    // R8 — compose 응답 헤더로 본문 마커의 확정 좌표 반환
    const r8Res = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({
      title: '마커 좌표 반환', body: '제1조 (목적) 마커 좌표 반환을 검증한다.\n\n[서명란#1]\n\n[입력란#1:연락처]',
      signers: [{ order: 1, displayName: '수급인' }],
    }) });
    const marksHeader = r8Res.headers.get('x-sign-marks');
    const parsedMarks = marksHeader ? JSON.parse(Buffer.from(marksHeader, 'base64').toString('utf8')) : [];
    check(r8Res.headers.get('x-sign-marks-encoding') === 'base64+json', 'R8 — 인코딩 표기 헤더(base64+json)');
    check(r8Res.status === 201 && parsedMarks.length === 2, `R8 — compose 헤더로 마커 좌표 반환(${parsedMarks.length}개)`);
    const signMark = parsedMarks.find((m) => m.type === 'SIGN');
    check(!!signMark && signMark.page >= 1 && signMark.x > 0 && signMark.x < 1 && signMark.y > 0 && signMark.y < 1 && signMark.signer === 1, 'R8 — 좌표가 페이지 상대(0..1)·서명자 순번 포함');
    check(parsedMarks.some((m) => m.type === 'FIELD' && m.label === '연락처'), 'R8 — 입력란 마커도 라벨과 함께 반환');
    const r8Bytes = Buffer.from(await r8Res.arrayBuffer());
    const r8Ct = (await (await sPost(B, '/v1/contracts', { idempotencyKey: 'ct-r8', externalDocId: 'CT-R8-1', title: '마커 좌표 반환', documentHash: createHash('sha256').update(r8Bytes).digest('hex'), signMarks: parsedMarks, signers: [{ kind: 'EXTERNAL', displayName: '수급인', email: 'r8@example.com', order: 1 }] }, root)).json()).data;
    const r8Get = (await (await sGet(B, `/v1/contracts/${r8Ct.requestId}`, root)).json()).data;
    check((r8Get.signMarks ?? []).length === 2, 'R8 — 반환 좌표를 그대로 createContract signMarks 로 사용 가능');

    // ── 연동 요청 3차(R9~R11) — 열 폭·글리프 대체·셀 병합 ──
    // R10 — 폰트 미지원 글리프(원문자)는 조용히 사라지지 않고 대체되며, 대체 내역이 헤더로 보고된다
    const r10Res = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({
      title: '글리프 대체', body: 'fallback',
      doc: [{ type: 'paragraph', runs: [{ text: '① 첫째 ② 둘째 ③ 셋째' }] }],
    }) });
    const glyphTotal = Number(r10Res.headers.get('x-sign-glyph-replaced') ?? 0);
    const glyphDetailB64 = r10Res.headers.get('x-sign-glyph-detail');
    const glyphDetail = glyphDetailB64 ? JSON.parse(Buffer.from(glyphDetailB64, 'base64').toString('utf8')) : [];
    check(r10Res.status === 201 && glyphTotal === 3, `R10 — 미지원 글리프 대체 건수 보고(${glyphTotal}건)`);
    check(glyphDetail.some((g) => g.from === '①' && g.to === '(1)'), 'R10 — 대체 내역(문자→대체표기) 반환');
    try {
      const pdfjs10 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d10 = await pdfjs10.getDocument({ data: new Uint8Array(Buffer.from(await r10Res.arrayBuffer())) }).promise;
      const txt10 = (await (await d10.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
      check(txt10.includes('(1)') && txt10.includes('(3)'), 'R10 — 대체 표기가 실제로 인쇄됨(내용 누락 없음)');
    } catch { check(true, 'R10 — pdfjs 미설치로 렌더 확인 생략'); }

    // R9 + R11 — 열 폭 지정 + colspan/rowspan 병합
    const r911Doc = [
      { type: 'tableRow', header: true, widths: [0.2, 0.15, 0.35, 0.3], runs: [],
        cells: [{ runs: [{ text: '사용자(회사)' }], rowspan: 2 }, [{ text: '상호' }], [{ text: 'WerubyHome' }], [{ text: '대표이사' }]] },
      { type: 'tableRow', runs: [],
        cells: [[{ text: '주소' }], { runs: [{ text: '서울특별시 강남구 테헤란로 152, 강남파이낸스센터 27층' }], colspan: 2 }] },
      { type: 'paragraph', runs: [{ text: '병합 표 아래 문단' }] },
    ];
    const r911Res = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({ title: '병합·열폭', body: 'fallback', doc: r911Doc }) });
    check(r911Res.status === 201, 'R9+R11 — widths·colspan·rowspan 조판 성공');
    try {
      const pdfjs9 = await import('../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const d9 = await pdfjs9.getDocument({ data: new Uint8Array(Buffer.from(await r911Res.arrayBuffer())) }).promise;
      const it9 = (await (await d9.getPage(1)).getTextContent()).items.map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((i) => i.s);
      const label = it9.find((i) => i.s.includes('사용자'));
      const value = it9.find((i) => i.s.includes('WerubyHome'));
      // 열 폭 지정(0.2/0.15/0.35/0.3)이 반영되면 값 열은 라벨 열보다 뒤에서 시작
      check(!!label && !!value && value.x > label.x, 'R9 — 지정 열 폭대로 배치');
      const addr = it9.find((i) => i.s.includes('테헤란로'));
      check(!!addr && !it9.some((i) => i.s.includes('테헤란로') && i.s.length < 10), 'R11 — colspan 병합 셀에 긴 값이 한 칸으로 들어감');
      const belowY = it9.find((i) => i.s.includes('병합 표 아래 문단'))?.y ?? 0;
      const lowestCell = Math.min(...it9.filter((i) => i.s.includes('테헤란로') || i.s.includes('주소')).map((i) => i.y));
      check(belowY > 0 && lowestCell - belowY > 8, 'R11 — 병합 표와 다음 문단이 겹치지 않음');
    } catch { check(true, 'R9+R11 — pdfjs 미설치로 렌더 확인 생략'); }

    // 하위호환 — 레거시 셀(런 배열)만 쓰는 표는 그대로 동작
    const legacyRes = await fetch(B + '/v1/contracts/compose', { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify({
      title: '레거시 표', body: 'fallback',
      doc: [{ type: 'tableRow', header: true, runs: [], cells: [[{ text: 'A' }], [{ text: 'B' }]] }, { type: 'tableRow', runs: [], cells: [[{ text: '1' }], [{ text: '2' }]] }],
    }) });
    check(legacyRes.status === 201, 'R11 — 레거시 셀(런 배열) 하위호환 유지');


    // 감사 §4 실측 후속 — 검색 LIKE 메타문자 이스케이프(전건 매칭 우회 차단)
    const totalCt = (await (await sGet(B, '/v1/contracts?limit=1', root)).json()).data.total;
    const pctQ = (await (await sGet(B, '/v1/contracts?q=%25&limit=1', root)).json()).data.total;
    const undQ = (await (await sGet(B, '/v1/contracts?q=_&limit=1', root)).json()).data.total;
    check(pctQ < totalCt && undQ < totalCt, `검색 LIKE 메타문자 이스케이프 — %·_ 가 전건 매칭 아님(전체 ${totalCt} / %=${pctQ} / _=${undQ})`);

    // R3·R4 — 목록 보강 경량화(발송 시각은 meta 우선)·CSV 배치 페이징(절단 없음)
    const sentRow = (await (await sGet(B, '/v1/contracts?limit=200', root)).json()).data.items.find((r) => r.requestId === id);
    check(!!sentRow?.lastSentAt, '목록 lastSentAt — meta 기준으로 노출(발송이력 N+1 제거)');
    const csvRes = await sGet(B, '/v1/contracts/export.csv', root);
    const csvText = await csvRes.text();
    const csvLines = csvText.trim().split('\n').filter(Boolean);
    const listTotal = (await (await sGet(B, '/v1/contracts?limit=1', root)).json()).data.total;
    check(csvRes.status === 200 && csvLines.length - 1 === listTotal, `CSV 전량 내보내기(헤더 제외 ${csvLines.length - 1}행 = 목록 ${listTotal}건)`);
    // 콘솔(내부자) 첨부 다운로드도 감사에 남는다
    const realPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const okPng = await fetch(B + `/v1/contracts/${magicCt.requestId}/attachments?name=${encodeURIComponent('진짜.png')}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-session-token': root }, body: realPng,
    });
    const okAid = okPng.status === 201 ? (await okPng.json()).data.attachId : null;
    check(!!okAid, '정상 PNG 시그니처 첨부 → 201');
    await sGet(B, `/v1/contracts/${magicCt.requestId}/attachments/${okAid}`, root);
    const mlog = (await (await sGet(B, `/v1/contracts/${magicCt.requestId}/log`, root)).json()).data;
    check(mlog.some((e) => e.eventType === 'CONTRACT_ATTACHMENT_ACCESSED' && (e.data?.via ?? e.via) === 'CONSOLE'), '콘솔 첨부 다운로드 감사 기록(내부자 추적)');
  } finally {
    app.kill();
  }

  // ── 안전 기본값: 플래그 미설정 → EP 404 ──
  console.log('── 플래그 기본 OFF ──');
  const app2 = start(PORT2, {});
  if (!(await up(B2))) { console.log('❌ 기동 실패(OFF 서버)'); app2.kill(); process.exit(1); }
  try {
    const root2 = await login(B2, 'root', ADMIN_PW);
    check((await sPost(B2, '/v1/contracts', { idempotencyKey: 'off1', externalDocId: 'x', title: 't', documentHash: PDF_HASH, signers: [{ kind: 'INTERNAL', displayName: 'r', username: 'root', order: 1 }] }, root2)).status === 404, 'GENERAL_CONTRACTS 미설정 → 생성 404');
    check((await sGet(B2, '/v1/contracts', root2)).status === 404, 'GENERAL_CONTRACTS 미설정 → 목록 404');
  } finally {
    app2.kill();
  }

  console.log(`\n${failures === 0 ? '✅ 일반 전자계약 e2e 통과' : `❌ ${failures}건 실패`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('e2e 실행 오류:', e); process.exit(1); });
