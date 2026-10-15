#!/usr/bin/env node
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 능동 감시·운영 알림(보안 S9) e2e.
 *
 * 검증 대상은 "메일이 갔는가"가 아니라 **판단이 맞는가**다(SMTP 미설정 = 로그 전용 경로로 실행):
 *  A) 백업 하트비트 — 신선하면 무알림, 노후(BACKUP_MAX_AGE_H 초과)면 알림
 *  B) 로그인 실패 폭주 — 임계 미만이면 무알림, 초과하면 알림
 *  C) 폭주 억제(throttle) — 같은 alertKey 재발생은 창 안에서 1회만
 *  D) 감시 실패가 서비스를 막지 않음 — 감시 후에도 정상 응답
 *
 * 실행: npm run build && node test/health-watch.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const PORT = 4713;
const B = `http://127.0.0.1:${PORT}`;
const KEY = 'test-api-key';
const ADMIN_PW = 'watch-admin-pw-1';
const STORE_FILE = '/tmp/sign-health-watch-e2e.json';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const post = (p, b, h) => fetch(B + p, { method: 'POST', headers: h ?? KH, body: JSON.stringify(b ?? {}) });
const getj = async (p, h) => (await fetch(B + p, { headers: h })).json();

/** 앱 로그 누적(경보 본문 관측용) — 구간 E 가 비우고 다시 채운다. */
let out = '';
function start(extraEnv) {
  const child = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env,
      SIGN_PORT: String(PORT),
      STORE_DRIVER: 'file',
      STORE_FILE,
      HIS_INBOUND_API_KEY: KEY,
      SIGN_ADMIN_USER: 'root',
      SIGN_ADMIN_PASSWORD: ADMIN_PW,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 21).toString('base64'),
      SCHEDULER_WATCH_MIN: '0', // 타이머 대신 테스트가 직접 호출(결정적 실행)
      OPS_ALERT_TO: '', // SMTP 미설정 → 로그 전용. 판단 로직만 검증한다
      ...extraEnv,
    },
    // 경보 **본문**을 검증하는 구간(E)이 있어 로그를 읽는다 — SMTP 미설정이라 로그가 유일한 관측점이다.
    // 파이프는 **항상 흘려보내야** 한다(안 읽으면 버퍼가 차서 앱이 멈춘다) → start() 가 곧바로 소비한다.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = (c) => { out = (out + c.toString()).slice(-200_000); };
  child.stdout.on('data', sink);
  child.stderr.on('data', sink);
  return child;
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  try { rmSync(STORE_FILE, { force: true }); } catch {}
  console.log('══════ 능동 감시·운영 알림(S9) e2e ══════');

  // ── A) 백업 하트비트 ──
  let app = start({ BACKUP_MAX_AGE_H: '26' });
  if (!await up()) { console.log('서버 기동 실패'); process.exit(1); }
  try {
    console.log('\n── A) 백업 하트비트 ──');
    check((await post('/v1/maintenance/backup-heartbeat', { note: 'e2e' })).status === 201, '하트비트 기록 → 201');
    const w1 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w1?.checked === 5, `감시 5종 실행 (${w1?.checked})`);
    check(w1?.alerts === 0, `신선한 백업·평시 → 알림 0 (${w1?.alerts})`);
  } finally { app.kill(); await sleep(400); }

  // 하트비트를 과거로 만든 상태에서 허용 간격을 0 으로 낮춰 재기동 — 노후 판정
  app = start({ BACKUP_MAX_AGE_H: '0' });
  if (!await up()) { console.log('서버 재기동 실패'); process.exit(1); }
  try {
    const w2 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w2?.alerts >= 1, `백업 노후 → 알림 발생 (${w2?.alerts})`);
    // ── C) 폭주 억제 ──
    console.log('\n── C) 폭주 억제(throttle) ──');
    const w3 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w3?.alerts === 0, `같은 알림 재발생 → 억제 (${w3?.alerts})`);
  } finally { app.kill(); await sleep(400); }

  // ── B) 로그인 실패 폭주 ──
  try { rmSync(STORE_FILE, { force: true }); } catch {}
  app = start({ ALERT_LOGIN_FAIL_THRESHOLD: '5', ALERT_LOGIN_FAIL_WINDOW_MIN: '10' });
  if (!await up()) { console.log('서버 기동 실패'); process.exit(1); }
  try {
    console.log('\n── B) 로그인 실패 폭주 ──');
    const bad = { username: 'root', password: 'wrong-pw' };
    for (let i = 0; i < 4; i++) await post('/v1/auth/login', bad, J);
    const w4 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w4?.alerts === 0, `임계(5) 미만 4건 → 알림 없음 (${w4?.alerts})`);
    for (let i = 0; i < 3; i++) await post('/v1/auth/login', bad, J);
    const w5 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w5?.alerts >= 1, `임계 초과 → 알림 발생 (${w5?.alerts})`);

    // ── D) 감시가 서비스를 막지 않음 ──
    console.log('\n── D) 비침습 확인 ──');
    check((await getj('/health')).status === 'ok', '감시 후에도 /health ok');
    const tok = (await (await post('/v1/auth/login', { username: 'root', password: ADMIN_PW }, J)).json()).data?.token;
    check(!!tok, '정상 자격 로그인 정상 동작(감시가 차단하지 않음)');

    // 스코프 — 하트비트는 기계키 권한 필요
    check((await post('/v1/maintenance/backup-heartbeat', {}, J)).status === 401, '하트비트 무인증 → 401');
  } finally { app.kill(); }

  // ── E) 웹훅 DEAD 경보가 "왜 반복되는지"를 말해 주는가 ──
  // DEAD 건수만 알리면 재발송으로 적체가 0 이 되고 한 시간 뒤 같은 경보가 다시 온다.
  // 옛 주소가 박힌 **대기 중 요청**이 만료·완료될 때마다 DEAD 가 새로 태어나기 때문이다(2026-08-08 사고).
  // 따라서 경보 본문에 그 사실이 실려 있어야 한다 — 로그로 실제 본문을 확인한다.
  try { rmSync(STORE_FILE, { force: true }); } catch {}
  app = start({ HIS_WEBHOOK_SECRET: 'watch-hook-secret' });
  if (!await up()) { console.log('서버 기동 실패'); process.exit(1); }
  try {
    console.log('\n── E) 웹훅 DEAD 경보의 근본 원인 표시 ──');
    const DEAD_URL = 'http://127.0.0.1:4719/gone-path';
    const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=감시', identity: { method: 'PASS', ci: 'W-1' } })).json()).data.serialNumber;
    const mk = async (key, doc) => (await (await post('/v1/requests', {
      idempotencyKey: key, externalDocId: doc, title: '감시 검증', documentHash: createHash('sha256').update(key).digest('hex'), signMode: 'APP',
      callbackUrl: DEAD_URL,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }],
    })).json()).data;
    const done = await mk('watch-dead-1', 'W-1'); // 완료시켜 DEAD 를 만든다
    await post('/v1/sign/' + done.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'W-1' } });
    await sleep(300);
    for (let i = 0; i < 10; i++) await post('/v1/maintenance/webhook-retry'); // 재시도 상한 소진 → DEAD
    check((await getj('/v1/maintenance/webhook-dead', { 'x-api-key': KEY })).data.length >= 1, 'DEAD 적체 생성');
    await mk('watch-pending-1', 'W-2'); // 같은 주소를 향하는 **대기 중** 요청 1건(= 다음 DEAD 의 씨앗)

    out = '';
    const w6 = (await (await post('/v1/maintenance/health-watch', {})).json()).data;
    check(w6?.alerts >= 1, `웹훅 DEAD → 알림 발생 (${w6?.alerts})`);
    await sleep(200);
    const alertLine = out.split('\n').filter((l) => l.includes('[ops-alert]') && l.includes('웹훅 DEAD')).join(' ');
    check(alertLine.includes('대기 중 요청 1건'), '경보 본문에 같은 주소를 향하는 대기 요청 수 표기(반복의 원인)');
    check(alertLine.includes('callback-retarget'), '경보가 근본 조치(요청 주소 정정)를 먼저 안내');
    check(alertLine.includes(DEAD_URL), '실패 수신처 주소 표기');
  } finally { app.kill(); await sleep(300); }

  console.log('\n' + (failures === 0 ? '✅ PASS — 능동 감시·운영 알림 (실패 0)' : `❌ FAIL — 능동 감시·운영 알림 (실패 ${failures})`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
