// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 13 — CA/TSA 키 재기동 영속 + Issuing 회전 e2e.
 * 영속 키볼트(crypto-proxy FileVault) + 영속 스토어(file)로 앱을 재기동해도
 * 기존 발급 인증서의 서명 검증(체인·타임스탬프·LTV)이 유지됨을 확인.
 * 또한 Issuing CA 회전 후 구 leaf는 이력으로 검증되고 신규 leaf도 발급·검증됨을 확인.
 *
 * 수정 전 결함: 매 기동마다 CA/TSA 키를 새로 생성 → 재기동 후 overall=false(운영 블로커).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const PROXY_PORT = 4903;
const APP_PORT = 4715;
const PROXY = `http://localhost:${PROXY_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const TOKEN = 'inc13-proxy-token';
const HIS_KEY = 'inc13-his-key';
const ADMIN_KEY = 'inc13-admin-key';
const MASTER = Buffer.alloc(32, 11).toString('base64');
const VAULT = `/tmp/sign-inc13-vault-${process.pid}.json`;
const STORE = `/tmp/sign-inc13-store-${process.pid}.json`;

let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body, key = HIS_KEY) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body ?? {}) });
const getj = async (p) => (await fetch(APP + p)).json();

function startProxy() {
  return spawn('node', ['dist/crypto-proxy/main.js'], {
    env: { ...process.env, CRYPTO_PROXY_PORT: String(PROXY_PORT), CRYPTO_PROXY_TOKEN: TOKEN, CRYPTO_PROXY_VAULT: VAULT, HSM_PROVIDER: 'none', CRYPTO_MASTER_KEY: MASTER },
    stdio: 'ignore',
  });
}
function startApp() {
  const env = { ...process.env, SIGN_PORT: String(APP_PORT), KEY_SIGNER_DRIVER: 'proxy', CRYPTO_PROXY_URL: PROXY, CRYPTO_PROXY_TOKEN: TOKEN, STORE_DRIVER: 'file', STORE_FILE: STORE, HIS_INBOUND_API_KEY: HIS_KEY, SIGN_ADMIN_API_KEY: ADMIN_KEY };
  delete env.CRYPTO_MASTER_KEY; // 앱은 키 미보유(프록시 격리)
  return spawn('node', ['dist/main.js'], { env, stdio: 'ignore' });
}
async function up(b, p) { for (let i = 0; i < 40; i++) { try { if ((await fetch(b + p)).ok) return true; } catch {} await sleep(300); } return false; }

async function signFlow(idem, doc) {
  const docHash = createHash('sha256').update(doc).digest('hex');
  const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=' + doc, identity: { method: 'PASS', ci: 'C' } })).json();
  const serial = pat.data.serialNumber;
  const req = await (await post('/v1/requests', { idempotencyKey: idem, externalDocId: doc, title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'INPERSON' }] })).json();
  await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
  return req.data.requestId;
}

async function main() {
  rmSync(VAULT, { force: true }); rmSync(STORE, { force: true });
  console.log('\n══════ Increment 13 — CA/TSA 재기동 영속 + 회전 e2e ══════\n');
  const proxy = startProxy();
  if (!(await up(PROXY, '/health'))) { console.log('❌ proxy 기동 실패'); proxy.kill(); process.exit(1); }

  let app = startApp();
  if (!(await up(APP, '/v1/crl'))) { console.log('❌ app#1 기동 실패'); app.kill(); proxy.kill(); process.exit(1); }

  let rid1;
  try {
    rid1 = await signFlow('i13-1', 'doc1');
    const v1 = (await getj('/v1/verify/' + rid1)).data;
    check(v1.overall === true, '기동#1: 발급→서명→검증 overall=true');
  } finally { app.kill(); await sleep(400); }

  // ── 앱 재기동 (프록시·스토어 유지) ──
  app = startApp();
  if (!(await up(APP, '/v1/crl'))) { console.log('❌ app#2 기동 실패'); app.kill(); proxy.kill(); process.exit(1); }
  try {
    const v1b = (await getj('/v1/verify/' + rid1)).data;
    check(v1b.overall === true, '재기동 후 기존 서명 overall=true (CA+TSA 키 영속)');
    check(v1b.signatures[0].chainValid === true, '재기동 후 체인검증 chainValid=true (CA 키 복원)');
    check(v1b.signatures[0].ltvValid === true, '재기동 후 LTV ltvValid=true (TSA 키 복원)');

    // 재기동 후 신규 발급·서명도 정상(복원된 Issuing 키로 서명)
    const rid2 = await signFlow('i13-2', 'doc2');
    const v2 = (await getj('/v1/verify/' + rid2)).data;
    check(v2.overall === true, '재기동 후 신규 발급·서명 overall=true');

    // ── Issuing CA 회전 ──
    const noScope = await post('/v1/ca/rotate-issuing', {}, HIS_KEY); // HIS 키엔 ca:admin 없음
    check(noScope.status === 403, '회전: HIS 키 ca:admin 스코프 부족 403');
    const rot = await post('/v1/ca/rotate-issuing', {}, ADMIN_KEY);
    check(rot.status === 201 || rot.status === 200, '회전: admin 키로 Issuing 회전 성공');

    // 회전 후 — 구 leaf는 이력으로 검증, 신규 leaf는 새 Issuing으로 검증
    const v1c = (await getj('/v1/verify/' + rid1)).data;
    check(v1c.signatures[0].chainValid === true, '회전 후 구 인증서 chainValid=true (Issuing 이력 검증)');
    const rid3 = await signFlow('i13-3', 'doc3');
    const v3 = (await getj('/v1/verify/' + rid3)).data;
    check(v3.overall === true, '회전 후 신규 발급·서명 overall=true (신규 Issuing)');
  } finally {
    app.kill(); proxy.kill(); await sleep(300);
    rmSync(VAULT, { force: true }); rmSync(STORE, { force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ Increment 13 통과 — CA/TSA 재기동 영속 + Issuing 회전' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
