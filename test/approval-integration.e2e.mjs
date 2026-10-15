// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 전자결재 P3.1 연동 e2e — 기계키 상신 + HIS SSO Bearer 결재.
 *  - 기계키 상신(HIS approval:write): submittedBy 상신자 표기, 고위험 문서.
 *  - SSO 결재(act-staff): JWKS 검증·sub 바인딩(타인 403·무토큰 401)·고위험/최종 step-up 을 SSO 재인증(acr)으로 충족.
 *  - 최소권한: 기계키는 결재(approval:act) 불가 → 403.
 *  - 인증로그: 상신 actor=his:*, 결재 actor=staff:sub·authMethod STAFF_SSO·assurance SSO_STEPUP. 무결성 verify.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const PORT = 4832, B = `http://127.0.0.1:${PORT}`;
const KEY = 'his-appr-int-key';
const ISSUER = 'hospitalrun';
const ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const docHash = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const postKey = (p, b) => fetch(B + p, { method: 'POST', headers: KH, body: JSON.stringify(b ?? {}) });
const sGet = (p, tok) => fetch(B + p, { headers: { 'x-session-token': tok } });
const login = async (u, pw) => (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: u, password: pw }) })).json()).data?.token;
const enroll = async (cn) => (await (await postKey('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=' + cn, licenseNumber: 'L-' + cn, identity: { method: 'STAFF_SSO' } })).json()).data?.serialNumber;
const bearer = (jwt) => ({ ...J, authorization: 'Bearer ' + jwt });

function start(port, extraEnv) {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(port), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 73).toString('base64'), SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60', ...extraEnv },
    stdio: 'ignore',
  });
}
async function up(base) { for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 전자결재 P3.1 — 기계키 상신 + SSO 결재 e2e ══════\n');
  // HIS SSO JWKS 셋업
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'his-key-1'; jwk.alg = 'RS256';
  const jwks = JSON.stringify({ keys: [jwk] });
  const mkJwt = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'his-key-1' }).setIssuer(ISSUER).setAudience('sign').setIssuedAt().setExpirationTime('5m').sign(privateKey);

  const app = start(PORT, { ELECTRONIC_APPROVAL: 'on', HIS_SSO_JWKS_JSON: jwks, HIS_SSO_ISSUER: ISSUER });
  if (!(await up(B))) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const root = await login('root', ADMIN_PW);
    const c1 = await enroll('DocSso');
    check(!!c1, '결재자 서명 인증서 발급');

    // ── 기계키 상신(HIS approval:write) ──
    console.log('── 기계키 상신 ──');
    const subRes = await postKey('/v1/approvals', {
      idempotencyKey: 'int1', externalDocId: 'surg-int-1', title: '수술 동의 결재(HIS 상신)',
      documentHash: docHash(), docType: 'SURGERY', submittedBy: 'his-user-9',
      line: [{ approverId: 'doctor-1', displayName: '집도의', order: 1, certSerial: c1 }],
    });
    const sub = (await subRes.json()).data;
    const id = sub.requestId;
    check(subRes.status === 201 && id && sub.highRisk === true, '기계키 상신 → 봉투 생성(highRisk=true)');
    // 상신 로그(actor=his:*, authMethod MACHINE_KEY) — 조회는 approval:act(root 세션)
    const log0 = (await (await sGet(`/v1/approvals/${id}/authlog`, root)).json()).data;
    const submitted = log0.find((e) => e.eventType === 'APPROVAL_SUBMITTED');
    check(submitted?.data.actor === 'his:his-user-9' && submitted?.data.auth?.method === 'MACHINE_KEY', '상신 인증로그 actor=his:*·MACHINE_KEY');

    // ── SSO Bearer 결재 ──
    console.log('── SSO 결재(act-staff) ──');
    check((await fetch(B + `/v1/approvals/${id}/act-staff`, { method: 'POST', headers: J, body: JSON.stringify({ decision: 'APPROVE' }) })).status === 401, '무토큰 SSO 결재 → 401');
    check((await fetch(B + `/v1/approvals/${id}/act-staff`, { method: 'POST', headers: bearer('bad.token.x'), body: JSON.stringify({ decision: 'APPROVE' }) })).status === 401, '위조 토큰 → 401');
    const intruder = await mkJwt({ role: 'DOCTOR', sub: 'intruder' });
    check((await fetch(B + `/v1/approvals/${id}/act-staff`, { method: 'POST', headers: bearer(intruder), body: JSON.stringify({ decision: 'APPROVE' }) })).status === 403, '타인 sub 결재 → 403(바인딩)');

    // 기계키는 결재(approval:act) 불가 — 최소권한
    check((await postKey(`/v1/approvals/${id}/act`, { decision: 'APPROVE' })).status === 403, '기계키 결재(act) → 403(approval:act 없음)');

    // 지정 결재자 SSO(고위험·최종 → SSO 재인증 acr 로 step-up 충족)
    const docJwt = await mkJwt({ role: 'DOCTOR', sub: 'doctor-1', acr: 'urn:mace:step-up', name: '김집도' });
    const actRes = await fetch(B + `/v1/approvals/${id}/act-staff`, { method: 'POST', headers: bearer(docJwt), body: JSON.stringify({ decision: 'APPROVE', opinion: '집도 승인' }) });
    const actd = (await actRes.json()).data;
    check(actRes.status === 201 && actd.status === 'COMPLETED', 'SSO 결재(고위험·acr step-up) → COMPLETED');

    // ── 인증로그 검증 ──
    console.log('── 인증로그 ──');
    const log = (await (await sGet(`/v1/approvals/${id}/authlog`, root)).json()).data;
    const approved = log.find((e) => e.eventType === 'APPROVAL_APPROVED');
    check(approved?.data.actor === 'staff:doctor-1' && approved?.data.auth?.method === 'STAFF_SSO', '결재 로그 actor=staff:sub·STAFF_SSO');
    check(String(approved?.data.auth?.assurance ?? '').startsWith('SSO_STEPUP'), '고위험/최종 = SSO 재인증(acr) step-up 봉인');
    const ver = (await (await sGet(`/v1/approvals/${id}/authlog/verify`, root)).json()).data;
    check(ver.chainValid === true && ver.anchored === true, '인증로그 무결성(체인+TSA 앵커)');
    check((await (await sGet(`/v1/verify/${id}`, root)).json()).data.overall === true, '결재 서명 봉투 verify overall=true(F010)');
  } finally { app.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — 전자결재 P3.1 연동 (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
