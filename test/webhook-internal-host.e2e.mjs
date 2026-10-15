// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * M1 예외 — WEBHOOK_INTERNAL_HOSTS (동일서버 내부 webhook 수신부 허용) 회귀가드.
 * 하드닝 시 callbackUrl 은 https+공인망만 허용하나, 운영자가 명시한 내부 host:port(ERP 등
 * server-to-server 루프백)는 예외 허용. 미명시 포트·http 공인망은 여전히 차단(좁은 opt-in).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const dh = (s) => createHash('sha256').update(s).digest('hex');

function boot(port, env) {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(port), ...env }, stdio: 'ignore' });
}
async function up(port) { for (let i = 0; i < 30; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch {} await sleep(300); } return false; }

const KEY = Buffer.alloc(32, 50).toString('base64');
const baseEnv = { SECURITY_HARDENING: 'true', HIS_INBOUND_API_KEY: 'k', CRYPTO_MASTER_KEY: KEY, HIS_WEBHOOK_SECRET: 'whs', RATE_LIMIT_PER_MIN: '500', TRUST_PROXY: 'loopback' };

async function createReq(port, callbackUrl) {
  const H = { 'Content-Type': 'application/json', 'x-api-key': 'k' };
  const ser = (await (await fetch(`http://127.0.0.1:${port}/v1/certificates/enroll`, { method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'WITNESS', subjectDn: 'CN=t' }) })).json()).data.serialNumber;
  const r = await fetch(`http://127.0.0.1:${port}/v1/requests`, { method: 'POST', headers: H, body: JSON.stringify({
    idempotencyKey: 'ih-' + Math.floor(performance.now() * 1000), externalDocId: 'oc:t', title: 't', documentHash: dh('x'), signMode: 'PORTAL', callbackUrl,
    participants: [{ signerRole: 'V', signerType: 'WITNESS_EXTERNAL', displayName: 'v', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'NONE' }] }) });
  return r.status;
}

async function main() {
  console.log('\n══════ M1 내부 호스트 예외(WEBHOOK_INTERNAL_HOSTS) e2e ══════\n');

  // 1) 미설정(하드닝) — 루프백 http callbackUrl 차단
  const p1 = boot(4751, baseEnv);
  if (!(await up(4751))) { console.log('❌ 기동 실패'); p1.kill(); process.exit(1); }
  check((await createReq(4751, 'http://127.0.0.1:8001/hook')) === 400, '미설정: 루프백 http callbackUrl → 400(차단)');
  check((await createReq(4751, 'https://erp.example.org/hook')) === 201, '미설정: 공인 https → 201(정상)');
  p1.kill(); await sleep(500);

  // 2) WEBHOOK_INTERNAL_HOSTS=127.0.0.1:8001 — 해당 host:port만 예외 허용
  const p2 = boot(4752, { ...baseEnv, WEBHOOK_INTERNAL_HOSTS: '127.0.0.1:8001' });
  if (!(await up(4752))) { console.log('❌ 기동 실패'); p2.kill(); process.exit(1); }
  check((await createReq(4752, 'http://127.0.0.1:8001/api/v1/integrations/sign/webhook')) === 201, '허용: 명시 host:port(127.0.0.1:8001) http → 201');
  check((await createReq(4752, 'http://127.0.0.1:9999/hook')) === 400, '비명시 포트(127.0.0.1:9999) → 400(여전히 차단·좁은 opt-in)');
  check((await createReq(4752, 'http://10.0.0.5/hook')) === 400, '비명시 사설망 → 400(차단)');
  check((await createReq(4752, 'https://erp.example.org/hook')) === 201, '공인 https → 201(정상 유지)');
  p2.kill();

  console.log('\n' + (failures === 0 ? '✅ M1 내부 호스트 예외 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
