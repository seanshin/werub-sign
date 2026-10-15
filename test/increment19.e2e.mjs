// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 19 — 운영 가시성: readiness + ops-status.
 * GET /health/ready(공개): DB·CA 준비. GET /v1/admin/ops-status(보호): Webhook 적체·요청 분포·CA.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4724, B = `http://localhost:${PORT}`, KEY = 'inc19-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const getj = async (p, key) => (await fetch(B + p, key ? { headers: { 'x-api-key': KEY } } : {})).json();

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 19).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Increment 19 — readiness + ops-status e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const r = await getj('/health/ready');
    check(r.ready === true && r.checks.db === true && r.checks.ca === true, 'readiness ready=true (db·ca)');

    // ops-status 보호
    const noauth = await fetch(B + '/v1/admin/ops-status');
    check(noauth.status === 401, 'ops-status 무키 401');

    // 데이터 생성 후 상태 반영
    const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=O', identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
    const docHash = createHash('sha256').update('ops').digest('hex');
    const req = await (await post('/v1/requests', { idempotencyKey: 'i19', externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP', callbackUrl: 'http://127.0.0.1:1/down', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }] })).json();
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    await sleep(400);
    const s = (await getj('/v1/admin/ops-status', true)).data;
    check(s.requests.total >= 1 && s.requests.COMPLETED >= 1, `요청 분포 반영 (COMPLETED=${s.requests.COMPLETED})`);
    check(s.webhooks.total >= 1 && (s.webhooks.FAILED >= 1 || s.webhooks.DEAD >= 1), `Webhook 적체 가시화 (FAILED=${s.webhooks.FAILED ?? 0})`);
    check(!!s.ca.issuingSerial && !!s.ca.rootSerial, 'CA 시리얼 노출');
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ Increment 19 통과 — 운영 가시성' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
