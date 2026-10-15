// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 서버측 세션 레지스트리 e2e (보안 규정 F-1/F-2 보강).
 *  - F-1 서버측 idle 강제: 짧은 idle(≈1.2s) 후 동일 토큰 → 401(클라이언트 의존 아님, 서버가 차단).
 *  - F-2 동시 세션 제한(ISMS-P 2.6.3): 한도 초과 로그인 시 가장 오래된 세션 축출 → 옛 토큰 401.
 *  - 즉시 폐기: 로그아웃 후 동일 토큰 재사용 → 401 / 비밀번호 변경 시 본인 전체 세션 폐기.
 *  - ops-status config.session 에 maxConcurrent·activeSessions·enforcement=server 노출.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4762, B = `http://127.0.0.1:${PORT}`;
const ADM = 'adm-k', ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const J = { 'Content-Type': 'application/json' };
const sessH = (t) => ({ ...J, 'x-session-token': t });
const post = (p, b, h) => fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(b ?? {}) });
const get = (p, h) => fetch(B + p, { headers: h });
const login = async (u, p) => (await post('/v1/auth/login', { username: u, password: p }, J)).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT),
      SIGN_ADMIN_API_KEY: ADM,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 47).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW,
      SESSION_TTL_MIN: '60',
      SESSION_IDLE_TIMEOUT_MIN: '0.02', // ≈1.2s — 서버측 idle 강제 검증용(소수 허용)
      SESSION_MAX_CONCURRENT: '2',
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 서버측 세션 레지스트리 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // ── F-1 서버측 idle 강제 ──
    const a = (await login('root', ADMIN_PW)).data;
    check(!!a?.token && a.idleTimeoutMin > 0, `로그인 → 토큰 발급(idleTimeoutMin=${a?.idleTimeoutMin})`);
    check((await get('/v1/auth/me', sessH(a.token))).status === 200, 'idle 전 me → 200(활동 직후 유효)');
    await sleep(1500); // idle(≈1.2s) 초과 — 그 사이 요청 없음
    check((await get('/v1/auth/me', sessH(a.token))).status === 401, '비활동 초과 후 me → 401(서버측 idle 강제)');

    // ── F-2 동시 세션 제한(한도 2) ──
    const s1 = (await login('root', ADMIN_PW)).data;
    await sleep(20);
    const s2 = (await login('root', ADMIN_PW)).data;
    check((await get('/v1/auth/me', sessH(s1.token))).status === 200, '동시세션: 1번째 세션 유효(한도 내)');
    check((await get('/v1/auth/me', sessH(s2.token))).status === 200, '동시세션: 2번째 세션 유효(한도 내)');
    await sleep(20);
    const s3 = (await login('root', ADMIN_PW)).data; // 한도 2 초과 → 가장 오래된 s1 축출
    check((await get('/v1/auth/me', sessH(s3.token))).status === 200, '동시세션: 3번째(신규) 세션 유효');
    check((await get('/v1/auth/me', sessH(s1.token))).status === 401, '동시세션 한도 초과 → 가장 오래된 세션 축출(401)');
    check((await get('/v1/auth/me', sessH(s2.token))).status === 200, '동시세션: 2번째 세션은 유지');

    // ── 즉시 폐기(로그아웃) ──
    const lo = await post('/v1/auth/logout', {}, sessH(s2.token));
    check(lo.status === 201, '로그아웃 201');
    check((await get('/v1/auth/me', sessH(s2.token))).status === 401, '로그아웃 후 동일 토큰 재사용 → 401(즉시 폐기)');

    // ── 비밀번호 변경 시 본인 전체 세션 폐기 ──
    const p1 = (await login('root', ADMIN_PW)).data;
    const p2 = (await login('root', ADMIN_PW)).data;
    const ch = await post('/v1/auth/password', { currentPassword: ADMIN_PW, newPassword: 'new-pass-456' }, sessH(p2.token));
    check(ch.status === 201, '비밀번호 변경 201');
    check((await get('/v1/auth/me', sessH(p1.token))).status === 401, '비번 변경 → 다른 세션도 폐기(401)');
    check((await get('/v1/auth/me', sessH(p2.token))).status === 401, '비번 변경 → 변경 세션 폐기(401, 재로그인)');
    const re = (await login('root', 'new-pass-456')).data;
    check(!!re?.token, '새 비밀번호로 재로그인 성공');

    // ── ops-status 노출 ── (admin 세션 토큰 = requests:write 보유)
    const ops = (await (await get('/v1/admin/ops-status', sessH(re.token))).json()).data;
    const sc = ops?.config?.session;
    check(sc?.maxConcurrent === 2 && sc?.enforcement === 'server' && typeof sc?.activeSessions === 'number',
      `ops-status session(maxConcurrent=${sc?.maxConcurrent}, enforcement=${sc?.enforcement}, active=${sc?.activeSessions})`);

  } finally {
    app.kill();
  }

  // ── F-3 운영모드 idle 비활성 금지(하한 강제) — 별도 하드닝 인스턴스 ──
  await hardenedFloorCheck();

  console.log(failures === 0 ? '\n✅ 서버측 세션 레지스트리 통과' : `\n❌ 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

const PORT2 = 4763, B2 = `http://127.0.0.1:${PORT2}`;
async function hardenedFloorCheck() {
  const app = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT2),
      SIGN_ADMIN_API_KEY: ADM,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 48).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW,
      SECURITY_HARDENING: 'true', // 운영 하드닝 모드
      SESSION_IDLE_TIMEOUT_MIN: '0', // 비활성 시도 → 운영에선 금지(15 강제)
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B2 + '/v1/crl')).ok) break; } catch {} await sleep(300); }
  try {
    const lr = await (await fetch(B2 + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json();
    check(lr?.data?.idleTimeoutMin === 15, `운영모드 idle=0 → 15분 강제(F004, idleTimeoutMin=${lr?.data?.idleTimeoutMin})`);
    const ops = (await (await fetch(B2 + '/v1/admin/ops-status', { headers: { 'x-session-token': lr.data.token } })).json()).data;
    check(ops?.config?.session?.idleTimeoutMinutes === 15, `운영모드 ops-status idle=15(서버 강제, =${ops?.config?.session?.idleTimeoutMinutes})`);
  } finally {
    app.kill();
  }
}

main();
