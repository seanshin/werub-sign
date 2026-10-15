// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * C-1 인앱 스케줄러 + C-5 API키 회전 콘솔 백엔드 e2e.
 *  - 스케줄러: ops-status 노출 + 기동 catch-up 이 실패 Webhook 을 외부호출 없이 재시도.
 *  - 소비자: GET /v1/admin/consumers(ca:admin) 목록·스코프 차단, rotate→grace→commit 무중단 회전.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4745, B = `http://127.0.0.1:${PORT}`;
const HIS = 'his-k', CON = 'con-k', ADM = 'adm-k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const post = (p, b, k) => fetch(B + p, { method: 'POST', headers: H(k), body: JSON.stringify(b ?? {}) });
const getj = async (p, k) => (await fetch(B + p, { headers: H(k) })).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: HIS, CONSOLE_API_KEY: CON, SIGN_ADMIN_API_KEY: ADM, CRYPTO_MASTER_KEY: Buffer.alloc(32, 45).toString('base64'), SCHEDULER_WEBHOOK_RETRY_MIN: '0.05' },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const enroll = (k) => post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=S', identity: { method: 'PASS', ci: 'C' } }, k);

async function main() {
  console.log('\n══════ C-1 스케줄러 + C-5 키회전 백엔드 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 1) 스케줄러 ops-status 노출
    const ops = (await getj('/v1/admin/ops-status', CON)).data;
    check(ops.scheduler?.enabled === true && ops.scheduler.expireMin === 60 && ops.scheduler.webhookRetryMin > 0, `스케줄러 활성 노출 (retry ${ops.scheduler?.webhookRetryMin}분/expire ${ops.scheduler?.expireMin}분)`);

    // 2) 소비자 목록 — ca:admin 강제
    check((await fetch(B + '/v1/admin/consumers', { headers: H(CON) })).status === 403, '콘솔 키(ca:admin 없음) → 목록 403');
    const list = (await getj('/v1/admin/consumers', ADM)).data;
    const names = list.map((c) => c.name);
    check(names.includes('hospitalrun') && names.includes('console') && names.includes('sign-admin'), `목록(admin) — ${names.join(',')}`);
    check(list.every((c) => c.activeKeys >= 1 && Array.isArray(c.scopes) && !('apiKeyHashes' in c)), '목록에 키값/해시 미노출(name·scopes·activeKeys만)');

    // 3) 무중단 회전 — hospitalrun
    const rot = (await (await post('/v1/admin/consumers/hospitalrun/rotate', {}, ADM)).json()).data;
    check(rot.generated && !!rot.newApiKey && rot.activeKeys === 2, `rotate — 신규키 생성·grace(activeKeys=${rot.activeKeys})`);
    const NEW = rot.newApiKey;
    check((await enroll(HIS)).status === 201 && (await enroll(NEW)).status === 201, 'grace 윈도우 — 구키·신규키 모두 동작');
    await post('/v1/admin/consumers/hospitalrun/commit', { keepApiKey: NEW }, ADM);
    check((await enroll(HIS)).status === 401 && (await enroll(NEW)).status === 201, 'commit — 구키 폐기(401)·신규키 유지(201)');

    // 4) 스케줄러 기동 catch-up — 실패 Webhook 을 외부호출 없이 재시도
    const ser = (await (await enroll(CON)).json()).data.serialNumber;
    const dh = createHash('sha256').update('sched').digest('hex');
    const req = await (await post('/v1/requests', { idempotencyKey: 'sched1', externalDocId: 'cf', title: 't', documentHash: dh, signMode: 'APP', callbackUrl: 'http://127.0.0.1:1/down', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }] }, CON)).json();
    const rid = req.data.requestId;
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'C' } }, CON);
    await sleep(800); // 최초 발송(실패) 반영
    const before = (await getj('/v1/requests/' + rid + '/webhooks', CON)).data;
    const attBefore = Math.max(0, ...before.map((w) => w.attempts ?? 0));
    await sleep(3000); // 기동 catch-up(1.5s) 경과 — 외부 /maintenance 호출 없이 재시도돼야
    const after = (await getj('/v1/requests/' + rid + '/webhooks', CON)).data;
    const attAfter = Math.max(0, ...after.map((w) => w.attempts ?? 0));
    check(attAfter > attBefore, `스케줄러 catch-up 재시도 — attempts ${attBefore}→${attAfter}(외부호출 없이 증가)`);
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ C-1·C-5 백엔드 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
