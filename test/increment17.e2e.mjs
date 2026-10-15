// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 17 — Webhook 재시도/reconcile 배치 e2e.
 * HIS 수신기가 잠시 다운된 상황: 완료 webhook이 FAILED → 수신기 복구 후
 * 재시도 배치(POST /v1/maintenance/webhook-retry)로 재전송 → SENT.
 * + reconcile 조회(GET /v1/requests/:id/webhooks) + HMAC 멱등(eventId 동일).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';

const PORT = 4720, HOOK_PORT = 4721;
const B = `http://localhost:${PORT}`;
const KEY = 'inc17-key', SECRET = 'inc17-webhook-secret';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p, { headers: { 'x-api-key': KEY } })).json();

// HIS webhook 수신기 — down/up 토글 + HMAC 검증 + eventId 멱등
let receiverUp = false;
const received = new Map(); // eventId -> count
const hook = createServer((req, res) => {
  if (!receiverUp) { res.socket.destroy(); return; } // 다운 시 연결 거부
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const sig = req.headers['x-sign-signature'];
    const calc = createHmac('sha256', SECRET).update(raw).digest('hex');
    if (sig !== calc) { res.writeHead(401); res.end('bad hmac'); return; }
    const evt = JSON.parse(raw); received.set(evt.eventId, (received.get(evt.eventId) ?? 0) + 1);
    res.writeHead(200); res.end('ok');
  });
});

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, HIS_WEBHOOK_SECRET: SECRET, CRYPTO_MASTER_KEY: Buffer.alloc(32, 17).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Increment 17 — Webhook 재시도/reconcile e2e ══════\n');
  await new Promise((r) => hook.listen(HOOK_PORT, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hook.close(); process.exit(1); }
  try {
    // 수신기 DOWN 상태에서 완료 → webhook FAILED
    receiverUp = false;
    const docHash = createHash('sha256').update('webhook-retry').digest('hex');
    const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=W', identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
    const req = await (await post('/v1/requests', { idempotencyKey: 'i17', externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP', callbackUrl: `http://localhost:${HOOK_PORT}/webhook`, participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }] })).json();
    const rid = req.data.requestId;
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    await sleep(500);
    let hooks = (await getj('/v1/requests/' + rid + '/webhooks')).data;
    check(hooks.length === 1 && hooks[0].status === 'FAILED', `수신기 다운 → webhook FAILED (${hooks[0]?.status})`);
    check(received.size === 0, '다운 중 미수신 확인');

    // 수신기 UP → 재시도 배치
    receiverUp = true;
    const retry = await (await post('/v1/maintenance/webhook-retry', {})).json();
    await sleep(300);
    check(retry.data.sent >= 1, `재시도 배치 → 전송 성공 (sent=${retry.data.sent})`);
    hooks = (await getj('/v1/requests/' + rid + '/webhooks')).data;
    check(hooks[0].status === 'SENT', `재시도 후 SENT (${hooks[0].status})`);
    check([...received.values()][0] >= 1, 'HIS 수신기 수신 확인(HMAC 검증 통과)');
    check(received.size === 1, 'eventId 멱등(단일 이벤트)');

    // 재시도 배치 재실행 → 더 보낼 것 없음
    const again = await (await post('/v1/maintenance/webhook-retry', {})).json();
    check(again.data.retried === 0, '잔여 없으면 재시도 0건');
  } finally { app.kill(); hook.close(); }

  console.log('\n' + (failures === 0 ? '✅ Increment 17 통과 — Webhook 재시도/reconcile' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
