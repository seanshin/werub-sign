// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 14 — 환자 본인인증 프록시 분리(IDV) e2e.
 * idv-proxy(mock 백엔드)를 분리 구동하고, 앱을 IDV_DRIVER=proxy로 띄워
 * 비대면(PASS) 본인확인이 분리 프록시 경유로 수행되고 서명에 강결합됨을 검증.
 *
 * 검증: (1) 분리 프록시 경유 비대면 본인확인→서명→검증 overall=true + identityMethod 바인딩,
 *      (2) 본인확인 정보 없으면 403(강결합),
 *      (3) idv-proxy 토큰 인증(잘못된 토큰 401),
 *      (4) 실 사업자(PASS) 백엔드 미설정 시 명확한 드롭인 안내 오류(설치 지점).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const IDV_PORT = 4921;
const APP_PORT = 4716;
const IDV = `http://localhost:${IDV_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const TOKEN = 'inc14-idv-token';
const KEY = 'inc14-api-key';

let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (b, p, body, hdr = {}) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify(body ?? {}) });
const postApp = (p, body) => post(APP, p, body, { 'x-api-key': KEY });
const getj = async (p) => (await fetch(APP + p)).json();

function startIdv(provider = 'mock') {
  return spawn('node', ['dist/idv-proxy/main.js'], {
    env: { ...process.env, IDV_PROXY_PORT: String(IDV_PORT), IDV_PROXY_TOKEN: TOKEN, IDV_PROVIDER: provider, CRYPTO_PEPPER: 'inc14-pepper' },
    stdio: 'ignore',
  });
}
function startApp() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(APP_PORT), IDV_DRIVER: 'proxy', IDV_PROXY_URL: IDV, IDV_PROXY_TOKEN: TOKEN, HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') },
    stdio: 'ignore',
  });
}
async function up(b, p) { for (let i = 0; i < 40; i++) { try { if ((await fetch(b + p)).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Increment 14 — 본인인증 프록시 분리(IDV) e2e ══════\n');
  let idv = startIdv('mock');
  if (!(await up(IDV, '/health'))) { console.log('❌ idv-proxy 기동 실패'); idv.kill(); process.exit(1); }

  // (3) 토큰 인증
  const bad = await fetch(IDV + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-idv-token': 'WRONG' }, body: '{}' });
  check(bad.status === 401, 'idv-proxy 잘못된 토큰 401');

  const app = startApp();
  if (!(await up(APP, '/v1/crl'))) { console.log('❌ 앱(IDV proxy 모드) 기동 실패'); app.kill(); idv.kill(); process.exit(1); }

  try {
    const docHash = createHash('sha256').update('동의서-idv').digest('hex');
    const pat = await (await postApp('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=IdvPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const serial = pat.data.serialNumber;
    // 비대면(PASS) 요구 참가자
    const req = await (await postApp('/v1/requests', { idempotencyKey: 'i14', externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] })).json();
    const pid = req.data.participants[0].participantId;

    // (2) 본인확인 정보 없이 submit → 403
    const noId = await postApp('/v1/sign/' + pid + '/submit', {});
    check(noId.status === 403, '본인확인 정보 없으면 서명 403 (강결합)');

    // (1) 비대면 본인확인(ci) 동반 submit → 프록시 경유 SUCCESS → 서명
    const okSub = await postApp('/v1/sign/' + pid + '/submit', { identity: { method: 'PASS', ci: '900101-XXXXXXX', name: '김환자' } });
    check(okSub.status === 201 || okSub.status === 200, '본인확인(PASS, 프록시 경유) 동반 서명 성공');
    const ver = (await getj('/v1/verify/' + req.data.requestId)).data;
    check(ver.overall === true, '분리 IDV 경유 서명·검증 overall=true');
    check(ver.signatures[0].identityMethod === 'PASS', '본인확인 방식이 서명에 바인딩(identityMethod=PASS)');
  } finally { app.kill(); await sleep(200); }

  // (4) 실 사업자(PASS) 백엔드 미설정 → 드롭인 안내 오류
  idv.kill(); await sleep(200);
  idv = startIdv('pass'); await up(IDV, '/health');
  const passRes = await post(IDV, '/verify', { method: 'PASS', ci: 'C' }, { 'x-idv-token': TOKEN });
  const body = await passRes.json().catch(() => ({}));
  check(passRes.status === 500 && /자격증명|미설정|미구현/.test(body.error ?? ''), '실 PASS 미설정 시 드롭인 안내 오류(설치 지점 확인)');
  idv.kill();

  console.log('\n' + (failures === 0 ? '✅ Increment 14 통과 — 본인인증 프록시 분리 + 강결합 + 사업자 드롭인' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
