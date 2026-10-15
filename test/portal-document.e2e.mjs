// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 환자 포털 문서 미리보기(PDF 뷰어) e2e — 설계 docs/02-design/features/portal-document-preview.design.md, Option A.
 *  - 업로드(caller): SHA-256==documentHash 검증(불일치 422)·%PDF(415)·무키(401), 봉인 저장.
 *  - 열람(환자 토큰): application/pdf inline·no-store, 바이트 왕복 일치, 미보유 404, 무효토큰 404.
 *  - 뷰 투영: documentAvailable=true.
 *  - 관리자 검토(RBAC documents:read): 세션 200, HIS 기계키 403.
 *  - 보존: 완료 후 sweep 파기 → 이후 404.
 *  - 안전 기본값: 기능 비활성(PORTAL_DOC_PREVIEW 미설정) → 업로드 404.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4826, B = `http://127.0.0.1:${PORT}`;
const KEY = 'his-doc-key';
const ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const postKey = (p, b) => fetch(B + p, { method: 'POST', headers: KH, body: JSON.stringify(b ?? {}) });
const putPdf = (p, bytes, hdr) => fetch(B + p, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', ...(hdr ?? {}) }, body: bytes });
const getj = async (p, h) => (await fetch(B + p, { headers: h })).json();

// 최소 유효 PDF(스캔/이미지 아님, %PDF 매직 포함) — 서명 대상 문서 스텁.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const OTHER_PDF = Buffer.from('%PDF-1.4\n% different bytes\n%%EOF\n', 'latin1');

function start(port, extraEnv) {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(port), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 74).toString('base64'), SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60', ...extraEnv },
    stdio: 'ignore',
  });
}
async function up(base) { for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const enroll = async (cn) => (await (await postKey('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=' + cn, identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;

async function main() {
  console.log('\n══════ 포털 문서 미리보기(PDF 뷰어) e2e ══════\n');
  // SCHEDULER_ENABLED=false — 보존 sweep 검증이 스케줄러 기동 catch-up 과 경합하지 않도록(아래 §보존 sweep 주석)
  const app = start(PORT, { PORTAL_DOC_PREVIEW: 'on', SCHEDULER_ENABLED: 'false' });
  if (!(await up(B))) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const docHash = createHash('sha256').update(PDF).digest('hex');
    const serial = await enroll('DocPatient');
    const rid = (await (await postKey('/v1/requests', { idempotencyKey: 'pd1', externalDocId: 'cf-doc', title: '수술 동의서', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '김환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] })).json()).data.requestId;

    // ── 업로드(caller) ──
    console.log('── 업로드 ──');
    check((await putPdf('/v1/requests/' + rid + '/document', PDF)).status === 401, '무키 업로드 → 401');
    check((await putPdf('/v1/requests/' + rid + '/document', OTHER_PDF, { 'x-api-key': KEY })).status === 422, '해시 불일치 → 422');
    check((await putPdf('/v1/requests/' + rid + '/document', Buffer.from('not a pdf'), { 'x-api-key': KEY })).status === 415, '비PDF(%PDF- 없음) → 415');
    const upRes = await putPdf('/v1/requests/' + rid + '/document', PDF, { 'x-api-key': KEY });
    const up = await upRes.json();
    check(upRes.status === 200 && up.data?.sha256 === docHash && up.data?.sizeBytes === PDF.length, `해시 일치 업로드 → 저장(sha256·size=${PDF.length})`);

    // ── 열람(환자 토큰) ──
    console.log('── 열람(포털 토큰) ──');
    const token = (await (await postKey('/v1/requests/' + rid + '/portal-tokens', {})).json()).data[0].token;
    const info = (await getj('/v1/portal/' + token)).data;
    check(info.documentAvailable === true, '포털 뷰 → documentAvailable=true');
    const docRes = await fetch(B + '/v1/portal/' + token + '/document');
    const gotBytes = Buffer.from(await docRes.arrayBuffer());
    check(docRes.status === 200 && (docRes.headers.get('content-type') || '').includes('application/pdf'), '문서 열람 → 200 application/pdf');
    check((docRes.headers.get('cache-control') || '').includes('no-store') && docRes.headers.get('x-content-type-options') === 'nosniff', '보안 헤더(no-store·nosniff)');
    check(!docRes.headers.get('x-frame-options') && (docRes.headers.get('content-security-policy') || '').includes('frame-ancestors'), '크로스오리진 뷰어 프레이밍 허용(XFO 해제·frame-ancestors)');
    check(gotBytes.equals(PDF), '열람 바이트 == 업로드 원본(WYSIWYS)');
    check((await fetch(B + '/v1/portal/BADTOKEN/document')).status === 404, '무효 토큰 → 404');

    // ── 관리자 검토(RBAC) ──
    console.log('── 관리자 검토(documents:read) ──');
    check((await fetch(B + '/v1/requests/' + rid + '/document', { headers: KH })).status === 403, 'HIS 기계키(documents:read 없음) → 403');
    const tok = (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json()).data.token;
    const adminRes = await fetch(B + '/v1/requests/' + rid + '/document', { headers: { 'x-session-token': tok } });
    check(adminRes.status === 200 && Buffer.from(await adminRes.arrayBuffer()).equals(PDF), '관리자 세션(documents:read) → 200 원본');

    // ── 보존 sweep(완료 후 파기) ──
    console.log('── 보존 sweep ──');
    await fetch(B + '/v1/portal/' + token + '/sign', { method: 'POST', headers: J, body: JSON.stringify({ identity: { method: 'PASS', ci: '900101', name: '김환자' } }) });
    check((await getj('/v1/verify/' + rid)).data.overall === true, '환자 서명 완료(검증 overall=true)');
    // 완료 처리(TSA 봉인·검증토큰·교부)는 서명 응답 뒤에도 이어진다 — sweep 은 **종료 상태**만 파기하므로
    // COMPLETED 관측까지 기다린다(부하 높은 CI 러너에서 purged=0 으로 실패하던 레이스).
    // ⚠ 그것만으로는 부족했다: 스케줄러의 **기동 catch-up**(runExpire, +1.5s)이 문서 sweep 을 함께 돌린다.
    //   흐름이 빨리 끝나면 그 catch-up 이 먼저 파기해 이 호출은 purged=0 을 받는다(문서는 이미 없어
    //   바로 뒤 404 검증은 통과 → 원인이 가려졌다). 그래서 이 앱은 SCHEDULER_ENABLED=false 로 띄운다
    //   (아래 검증 대상은 "명시 호출이 파기하는가"이고, 스케줄러 경로는 스케줄러 테스트가 본다).
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = (await getj('/v1/requests/' + rid, KH)).data?.status;
      if (status === 'COMPLETED') break;
      await sleep(250);
    }
    check(status === 'COMPLETED', `서명 후 상태 COMPLETED 관측 (${status})`);
    const sweep = await (await postKey('/v1/maintenance/document-sweep', {})).json();
    check(sweep.data?.purged >= 1, `sweep → 종료 요청 문서 파기(purged=${sweep.data?.purged})`);
    check((await fetch(B + '/v1/requests/' + rid + '/document', { headers: { 'x-session-token': tok } })).status === 404, '파기 후 관리자 열람 → 404');
  } finally { app.kill(); }

  // ── 안전 기본값: 기능 비활성 ──
  console.log('── 안전 기본값(PORTAL_DOC_PREVIEW 미설정) ──');
  const P2 = PORT + 1, B2 = `http://127.0.0.1:${P2}`;
  const app2 = start(P2, {}); // 플래그 미설정 → 비활성
  if (await up(B2)) {
    try {
      const dh = createHash('sha256').update(PDF).digest('hex');
      const s = (await (await fetch(B2 + '/v1/certificates/enroll', { method: 'POST', headers: KH, body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=Off', identity: { method: 'PASS', ci: 'C' } }) })).json()).data.serialNumber;
      const rid2 = (await (await fetch(B2 + '/v1/requests', { method: 'POST', headers: KH, body: JSON.stringify({ idempotencyKey: 'off1', externalDocId: 'cf-off', title: 't', documentHash: dh, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환', signOrder: 1, certSerial: s, requiredIdentityLevel: 'PASS' }] }) })).json()).data.requestId;
      const off = await fetch(B2 + '/v1/requests/' + rid2 + '/document', { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-api-key': KEY }, body: PDF });
      check(off.status === 404, '비활성 시 업로드 → 404(PHI 저장 방지)');
    } finally { app2.kill(); }
  } else { check(false, '2차 인스턴스 기동 실패'); app2.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — 포털 문서 미리보기 (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
