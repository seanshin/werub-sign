// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 12 — HSM 프록시 경계 분리 e2e.
 * crypto-proxy(SOFT 백엔드, HSM_PROVIDER=none)를 분리 구동하고,
 * 앱을 KEY_SIGNER_DRIVER=proxy(개인키·마스터키 미보유)로 띄워 전체 서명 흐름을 검증.
 *
 * 검증: (1) 분리 프록시 경유 enroll→sign→verify 무결성(체인·LTV·감사),
 *      (2) keyClass 최소화 — CA 앵커만 HSM 클래스 요청(통계),
 *      (3) 프록시 토큰 인증(잘못된 토큰 401),
 *      (4) 앱은 CRYPTO_MASTER_KEY 없이도 동작(키가 프록시에 격리).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const PROXY_PORT = 4901;
const APP_PORT = 4713;
const PROXY = `http://localhost:${PROXY_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const TOKEN = 'proxy-secret-token';
const KEY = 'inc12-api-key';
const MASTER = Buffer.alloc(32, 7).toString('base64');
const VAULT = `/tmp/sign-inc12-vault-${process.pid}.json`;

let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (b, p, body) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body ?? {}) });
const getj = async (b, p, headers) => (await fetch(b + p, { headers })).json();

function startProxy() {
  return spawn('node', ['dist/crypto-proxy/main.js'], {
    env: { ...process.env, CRYPTO_PROXY_PORT: String(PROXY_PORT), CRYPTO_PROXY_TOKEN: TOKEN, CRYPTO_PROXY_VAULT: VAULT, HSM_PROVIDER: 'none', CRYPTO_MASTER_KEY: MASTER },
    stdio: 'ignore',
  });
}
function startApp() {
  // 주의: 앱에는 CRYPTO_MASTER_KEY를 주지 않는다(개인키 격리 입증).
  const env = { ...process.env, SIGN_PORT: String(APP_PORT), KEY_SIGNER_DRIVER: 'proxy', CRYPTO_PROXY_URL: PROXY, CRYPTO_PROXY_TOKEN: TOKEN, HIS_INBOUND_API_KEY: KEY };
  delete env.CRYPTO_MASTER_KEY;
  return spawn('node', ['dist/main.js'], { env, stdio: 'ignore' });
}
async function waitUp(b, p) { for (let i = 0; i < 40; i++) { try { if ((await fetch(b + p)).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Increment 12 — HSM 프록시 분리 e2e ══════\n');
  const proxy = startProxy();
  if (!(await waitUp(PROXY, '/health'))) { console.log('❌ crypto-proxy 기동 실패'); proxy.kill(); process.exit(1); }

  // (3) 토큰 인증 — 잘못된 토큰 401
  const bad = await fetch(PROXY + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-proxy-token': 'WRONG' }, body: '{}' });
  check(bad.status === 401, '프록시 잘못된 토큰 401');

  const app = startApp();
  if (!(await waitUp(APP, '/v1/crl'))) { console.log('❌ 앱(proxy 모드) 기동 실패'); app.kill(); proxy.kill(); rmSync(VAULT, { force: true }); process.exit(1); }

  try {
    const docHash = createHash('sha256').update('동의서-proxy').digest('hex');
    const pat = await (await post(APP, '/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=ProxyPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const serial = pat.data.serialNumber;
    check(!!serial, '프록시 경유 인증서 발급(앱은 개인키 미보유)');

    const req = await (await post(APP, '/v1/requests', { idempotencyKey: 'i12', externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'INPERSON' }] })).json();
    await post(APP, '/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
    const ver = (await getj(APP, '/v1/verify/' + req.data.requestId)).data;
    check(ver.overall === true, '프록시 경유 서명·검증 overall=true');
    check(ver.signatures[0].chainValid === true, '체인 검증 chainValid=true (CA키=프록시 상주)');
    check(ver.signatures[0].ltvValid === true, 'LTV 검증 ltvValid=true');
    check(ver.auditChainValid === true, '감사 해시체인 auditChainValid=true');

    // (2) keyClass 최소화 — CA Root+Issuing만 HSM 클래스 요청
    const stats = await getj(PROXY, '/stats', { 'x-proxy-token': TOKEN });
    check(stats.requestedHsm >= 2, `HSM 클래스 요청=CA 앵커만 (requestedHsm=${stats.requestedHsm} ≥ 2)`);
    check(stats.requestedSoft >= 1, `말단/TSA키는 SOFT (requestedSoft=${stats.requestedSoft} ≥ 1)`);
    check(stats.provider === 'none' && stats.backendHsm === 0, '개발=HSM_PROVIDER:none → 백엔드 전부 SOFT(실 HSM 불요)');
  } finally {
    app.kill(); proxy.kill(); await sleep(300); rmSync(VAULT, { force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ Increment 12 통과 — 개인키 프록시 분리 + HSM 최소화 배선' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
