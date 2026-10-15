// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 관리자 콘솔 2차 인증(TOTP) e2e.
 *  - setup→enable(코드 확인·복구코드 발급) → 로그인 시 mfaRequired → 2fa/verify(TOTP) → 세션.
 *  - 오답 401, 복구코드 1회용, 해제 후 단일 인증 복귀.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { totp } from '../dist/infrastructure/auth/totp.js';

const PORT = 4810, B = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const sessH = (t) => ({ ...J, 'x-session-token': t });
const post = (p, b, h = J) => fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(b ?? {}) });
const get = (p, h) => fetch(B + p, { headers: h });

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), CRYPTO_MASTER_KEY: Buffer.alloc(32, 71).toString('base64'), SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60' },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const login = async (u, p) => (await post('/v1/auth/login', { username: u, password: p })).json();

async function main() {
  console.log('\n══════ 관리자 콘솔 2차 인증(TOTP) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 1) 2FA 미설정 — 로그인 시 세션 즉시 발급
    let lr = (await login('root', ADMIN_PW)).data;
    check(!!lr?.token && !lr.mfaRequired, '2FA 미설정 → 로그인 즉시 세션');
    const tok = lr.token;
    check((await get('/v1/auth/2fa/status', sessH(tok))).status === 200, '2FA 상태 조회 200');

    // 2) 등록 시작 → 시크릿
    const setup = (await (await post('/v1/auth/2fa/setup', {}, sessH(tok))).json()).data;
    check(!!setup?.secret && setup.otpauthUri?.startsWith('otpauth://totp/'), `setup → 시크릿·등록URI`);

    // 3) 활성화 — 잘못된 코드 거부, 올바른 코드 활성화
    check((await post('/v1/auth/2fa/enable', { code: '000000' }, sessH(tok))).status === 400, 'enable 오답 → 400');
    const en = (await (await post('/v1/auth/2fa/enable', { code: totp(setup.secret) }, sessH(tok))).json()).data;
    check(Array.isArray(en?.recoveryCodes) && en.recoveryCodes.length === 8, `enable → 복구코드 8개`);

    // 4) 재로그인 → mfaRequired(세션 미발급)
    lr = (await login('root', ADMIN_PW)).data;
    check(lr?.mfaRequired === true && !!lr.mfaToken && !lr.token, '2FA 설정 후 로그인 → mfaRequired(세션 없음)');

    // 5) 2fa/verify — 오답 401, 정답 세션
    check((await post('/v1/auth/2fa/verify', { mfaToken: lr.mfaToken, code: '000000' })).status === 401, '2fa/verify 오답 → 401');
    const v = (await (await post('/v1/auth/2fa/verify', { mfaToken: lr.mfaToken, code: totp(setup.secret) })).json()).data;
    check(!!v?.token && v.role === 'admin', '2fa/verify TOTP 정답 → 세션 발급');

    // 6) 복구코드 1회용
    lr = (await login('root', ADMIN_PW)).data;
    const rc = en.recoveryCodes[0];
    check(!!(await (await post('/v1/auth/2fa/verify', { mfaToken: lr.mfaToken, code: rc })).json()).data?.token, '복구코드로 2fa/verify → 세션');
    lr = (await login('root', ADMIN_PW)).data;
    check((await post('/v1/auth/2fa/verify', { mfaToken: lr.mfaToken, code: rc })).status === 401, '복구코드 재사용 → 401(1회용 소모)');

    // 7) 해제 → 단일 인증 복귀
    const sess2 = (await (await post('/v1/auth/2fa/verify', { mfaToken: (await login('root', ADMIN_PW)).data.mfaToken, code: totp(setup.secret) })).json()).data.token;
    check((await post('/v1/auth/2fa/disable', { code: '000000' }, sessH(sess2))).status === 401, 'disable 오답 → 401');
    check((await post('/v1/auth/2fa/disable', { code: totp(setup.secret) }, sessH(sess2))).status === 201, 'disable 정답 → 해제');
    lr = (await login('root', ADMIN_PW)).data;
    check(!!lr?.token && !lr.mfaRequired, '해제 후 → 로그인 즉시 세션(단일 인증)');

    console.log(failures === 0 ? '\n✅ 2차 인증(TOTP) 통과' : `\n❌ 실패 ${failures}건`);
  } finally { app.kill(); }
  process.exit(failures === 0 ? 0 : 1);
}
main();
