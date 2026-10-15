// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 실시간 이벤트 스트림(SSE) e2e.
 *  - GET /v1/events/stream (인증·text/event-stream·X-Accel-Buffering=no).
 *  - 요청 생성 시 'request.changed'(CREATED) 이벤트 수신.
 *  - 무권한 401.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4808, B = `http://127.0.0.1:${PORT}`;
const K = 'k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dh = (s) => createHash('sha256').update(s).digest('hex');

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: K, CRYPTO_MASTER_KEY: Buffer.alloc(32, 63).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 실시간 이벤트 스트림(SSE) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 무권한 401
    check((await fetch(B + '/v1/events/stream')).status === 401, '무권한 SSE → 401');

    // 인증 스트림 열기
    const ctrl = new AbortController();
    const res = await fetch(B + '/v1/events/stream', { headers: { 'x-api-key': K }, signal: ctrl.signal });
    check(res.status === 200, 'SSE 200');
    check((res.headers.get('content-type') || '').includes('text/event-stream'), 'content-type=text/event-stream');
    check(res.headers.get('x-accel-buffering') === 'no', 'X-Accel-Buffering=no(nginx 버퍼링 무력화)');

    // 백그라운드로 스트림 읽기
    const received = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) { try { received.push(JSON.parse(line.slice(6))); } catch {} }
          }
        }
      } catch { /* aborted */ }
    })();

    await sleep(300); // ready 프레임 수신

    // 인증서 발급 + 요청 생성 → request.changed(CREATED) 이벤트 발생
    const enroll = await (await fetch(B + '/v1/certificates/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': K }, body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=SSE', identity: { method: 'PASS', ci: 'C' } }) })).json();
    await fetch(B + '/v1/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': K }, body: JSON.stringify({ idempotencyKey: 'sse-1', externalDocId: 'sse-doc', title: 'SSE 동의서', documentHash: dh('sse'), signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환자', signOrder: 1, certSerial: enroll.data.serialNumber }] }) });

    await sleep(700); // 이벤트 전파 대기
    const changed = received.find((e) => e.type === 'request.changed' && e.status === 'CREATED');
    check(!!changed, `request.changed(CREATED) 이벤트 수신 (received=${received.length})`);
    check(!!changed?.requestId && !!changed?.at, '이벤트 페이로드(requestId·at)');

    ctrl.abort();
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ SSE 이벤트 스트림 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
