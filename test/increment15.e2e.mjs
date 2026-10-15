// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 15 — 환자 서명 웹플로우(standalone fallback) e2e.
 * HIS가 토큰 발급 → 비로그인 환자가 토큰 링크로 동의서 열람→본인확인→서명.
 * HIS 앱이 주 채널, 본 흐름은 원외/앱미사용 fallback.
 *
 * 검증: 토큰 발급(보호) → 공개 열람(JSON/HTML) → 공개 서명(본인확인 강결합) →
 *      검증 overall=true → 토큰 단일사용(재사용 403) → 잘못된 토큰 404 →
 *      다자 순서 게이팅(뒤 순서 canSignNow=false).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4717;
const B = `http://localhost:${PORT}`;
const KEY = 'inc15-api-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postKey = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body ?? {}) });
const postPub = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const getj = async (p) => (await fetch(B + p)).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 6).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function enroll(cn) {
  return (await (await postKey('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=' + cn, identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
}

async function main() {
  console.log('\n══════ Increment 15 — 환자 서명 웹플로우(fallback) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 앱 기동 실패'); app.kill(); process.exit(1); }
  try {
    const docHash = createHash('sha256').update('수술 동의서').digest('hex');
    const serial = await enroll('PortalPatient');
    const req = await (await postKey('/v1/requests', { idempotencyKey: 'i15', externalDocId: 'cf-portal', title: '수술 동의서', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '김환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] })).json();
    const rid = req.data.requestId;

    // 토큰 발급(보호) — api-key 없으면 401
    const noKey = await postPub('/v1/requests/' + rid + '/portal-tokens', {});
    check(noKey.status === 401, '토큰 발급은 보호됨(api-key 없으면 401)');
    const issued = await (await postKey('/v1/requests/' + rid + '/portal-tokens', {})).json();
    const token = issued.data[0].token;
    check(!!token && issued.data[0].url === '/portal/' + token, '참가자 토큰 발급 + 링크 URL');

    // 공개 열람 (JSON)
    const info = (await getj('/v1/portal/' + token)).data;
    check(info.request.title === '수술 동의서' && info.canSignNow === true, '공개 열람(JSON): 동의서 정보·서명가능');
    // 공개 열람 (HTML)
    const html = await (await fetch(B + '/portal/' + token)).text();
    check(html.includes('수술 동의서') && html.includes('동의하고 서명'), '공개 열람(HTML): 환자 페이지 렌더');

    // 공개 서명 (본인확인 강결합) — ci 없이는 403
    const noId = await postPub('/v1/portal/' + token + '/sign', { identity: { method: 'PASS' } });
    check(noId.status === 403, '본인확인 정보 없으면 서명 403(강결합)');
    // ci 동반 서명
    const ok = await postPub('/v1/portal/' + token + '/sign', { identity: { method: 'PASS', ci: '900101', name: '김환자' } });
    const okJson = await ok.json();
    check(ok.ok && okJson.data.signed === true && okJson.data.requestStatus === 'COMPLETED', '환자 웹 서명 완료(COMPLETED)');
    const ver = (await getj('/v1/verify/' + rid)).data;
    check(ver.overall === true, '웹플로우 서명 검증 overall=true');

    // 토큰 단일사용
    const reuse = await postPub('/v1/portal/' + token + '/sign', { identity: { method: 'PASS', ci: '900101' } });
    check(reuse.status === 403, '토큰 단일사용(재사용 403)');
    // 잘못된 토큰
    const badInfo = await fetch(B + '/v1/portal/INVALIDTOKEN');
    check(badInfo.status === 404, '잘못된 토큰 404');

    // 다자 순서 게이팅 — 뒤 순서 참가자는 canSignNow=false
    const s2a = await enroll('P1'), s2b = await enroll('P2');
    const req2 = await (await postKey('/v1/requests', { idempotencyKey: 'i15b', externalDocId: 'cf2', title: '다자', documentHash: docHash, signMode: 'APP', participants: [
      { signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환자', signOrder: 1, certSerial: s2a, requiredIdentityLevel: 'PASS' },
      { signerRole: 'DOCTOR', signerType: 'STAFF', displayName: '의사', signOrder: 2, certSerial: s2b, requiredIdentityLevel: 'STAFF_SSO' },
    ] })).json();
    const toks = (await (await postKey('/v1/requests/' + req2.data.requestId + '/portal-tokens', {})).json()).data;
    const order2 = toks.find((t) => t.signerRole === 'DOCTOR');
    const info2 = (await getj('/v1/portal/' + order2.token)).data;
    check(info2.canSignNow === false, '다자 순서 게이팅: 뒤 순서 canSignNow=false');
  } finally { app.kill(); }

  console.log('\n' + (failures === 0 ? '✅ Increment 15 통과 — 환자 서명 웹플로우(fallback)' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
