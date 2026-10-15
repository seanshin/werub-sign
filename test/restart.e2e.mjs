// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 재기동 내성 e2e(A4) — 파일 저장소 + crypto-proxy(키 격리·영속)로 앱을 재기동해도
 * 기존 서명요청 검증이 유지되고(LTV/감사체인) 신규 발급·서명도 정상.
 *  - app#1: 발급→서명→검증(overall=true) → kill.
 *  - app#2(동일 STORE_FILE·동일 proxy): 기존 요청 검증 유지·상태 COMPLETED·목록 잔존 + 신규 요청 서명/검증.
 * increment13(CA 키 회전·영속)과 보완: 본 테스트는 요청/서명 데이터 영속에 초점.
 * 실행: npm run build && node test/restart.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const PROXY_PORT = 4905, APP_PORT = 4716;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, APP = `http://127.0.0.1:${APP_PORT}`;
const TOKEN = 'restart-proxy-token', HIS_KEY = 'restart-his-key';
const MASTER = Buffer.alloc(32, 23).toString('base64');
const VAULT = `/tmp/sign-restart-vault-${process.pid}.json`;
const STORE = `/tmp/sign-restart-store-${process.pid}.json`;

let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body, key = HIS_KEY) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body ?? {}) });
const getj = async (p, key) => (await fetch(APP + p, { headers: key ? { 'x-api-key': key } : {} })).json();

function startProxy() {
  return spawn('node', ['dist/crypto-proxy/main.js'], {
    env: { ...process.env, CRYPTO_PROXY_PORT: String(PROXY_PORT), CRYPTO_PROXY_TOKEN: TOKEN, CRYPTO_PROXY_VAULT: VAULT, HSM_PROVIDER: 'none', CRYPTO_MASTER_KEY: MASTER },
    stdio: 'ignore',
  });
}
function startApp() {
  const env = { ...process.env, SIGN_PORT: String(APP_PORT), KEY_SIGNER_DRIVER: 'proxy', CRYPTO_PROXY_URL: PROXY, CRYPTO_PROXY_TOKEN: TOKEN, STORE_DRIVER: 'file', STORE_FILE: STORE, HIS_INBOUND_API_KEY: HIS_KEY };
  delete env.CRYPTO_MASTER_KEY; // 앱은 키 미보유(프록시 격리)
  return spawn('node', ['dist/main.js'], { env, stdio: 'ignore' });
}
async function up(b, p) { for (let i = 0; i < 40; i++) { try { if ((await fetch(b + p)).ok) return true; } catch {} await sleep(300); } return false; }

async function signFlow(idem, doc) {
  const docHash = createHash('sha256').update(doc).digest('hex');
  const serial = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=' + doc, identity: { method: 'PASS', ci: 'C' + idem } })).json()).data.serialNumber;
  const req = await (await post('/v1/requests', { idempotencyKey: idem, externalDocId: doc, title: doc, documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }] })).json();
  await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
  return { requestId: req.data.requestId, serial };
}

async function main() {
  rmSync(VAULT, { force: true }); rmSync(STORE, { force: true });
  console.log('\n══════ 재기동 내성 e2e (A4) ══════\n');
  const proxy = startProxy();
  if (!(await up(PROXY, '/health'))) { console.log('❌ proxy 기동 실패'); proxy.kill(); process.exit(1); }
  let app = startApp();
  if (!(await up(APP, '/v1/crl'))) { console.log('❌ app#1 기동 실패'); app.kill(); proxy.kill(); process.exit(1); }
  try {
    // ── app#1: 발급→서명→검증 ──
    console.log('— app#1: 서명·검증 —');
    const { requestId: rid, serial: serial1 } = await signFlow('restart-1', 'before-restart');
    const v1 = await getj(`/v1/verify/${rid}`);
    check(v1.data.overall === true, '재기동 전 검증 overall=true');
    check(v1.data.signatures.every((s) => s.ltvValid), '재기동 전 LTV 유효');
    check(v1.data.signatures.every((s) => s.cmsValid), '재기동 전 CMS(PKCS#7) 검증 유효');

    // ── 재기동(동일 STORE·proxy 유지) ──
    console.log('— 앱 재기동 —');
    app.kill();
    await sleep(800);
    app = startApp();
    if (!(await up(APP, '/v1/crl'))) { console.log('❌ app#2 기동 실패'); app.kill(); proxy.kill(); process.exit(1); }

    // ── app#2: 기존 데이터 영속·검증 유지 ──
    console.log('— app#2: 영속·검증 유지 —');
    const v2 = await getj(`/v1/verify/${rid}`);
    check(v2.data.overall === true, '재기동 후 기존 요청 검증 overall=true(영속)');
    check(v2.data.signatures.every((s) => s.ltvValid), '재기동 후 LTV 유효 유지');
    check(v2.data.signatures.every((s) => s.cmsValid), '재기동 후 CMS(PKCS#7) 검증 유지(CMS 내장 인증서 자체완결)');
    check(v2.data.auditChainValid !== false, '재기동 후 감사체인 유효');
    const rc = await getj(`/v1/requests/${rid}`, HIS_KEY);
    check(rc.data?.status === 'COMPLETED', '재기동 후 상태 COMPLETED(reconcile)', rc.data?.status);
    const list = await getj('/v1/requests?limit=50', HIS_KEY);
    const rows = list.data ?? list.items ?? [];
    check(Array.isArray(rows) && rows.some((r) => r.requestId === rid), '재기동 후 목록에 기존 요청 잔존');

    // ── app#2: 신규 발급·서명도 정상(CA 재기동 후 사용 가능) ──
    console.log('— app#2: 신규 발급·서명 —');
    const { requestId: rid2, serial: serial2 } = await signFlow('restart-2', 'after-restart');
    const v3 = await getj(`/v1/verify/${rid2}`);
    check(v3.data.overall === true, '재기동 후 신규 요청 검증 overall=true');
    // 시리얼 접두 카운터 영속 — 재기동 후 발급 시리얼이 이전보다 커야 함(리셋 시 CERT-0001 재시작 → 연동팀 "저장소 초기화" 오인 유발)
    const seqOf = (s) => parseInt(s.split('-')[1], 10);
    check(seqOf(serial2) > seqOf(serial1), `재기동 후 시리얼 접두 연속(카운터 영속): ${serial1} → ${serial2}`);

    console.log('\n' + (failures === 0 ? '✅ 재기동 내성 e2e 전체 통과' : `❌ ${failures}건 실패`));
  } finally {
    app.kill(); proxy.kill();
    rmSync(VAULT, { force: true }); rmSync(STORE, { force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
