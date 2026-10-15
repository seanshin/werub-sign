// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * C-4 다중관리자 RBAC e2e.
 *  - 부트스트랩 admin → 로그인 → 세션 토큰 → me(역할·스코프).
 *  - 역할별 인가: admin(전권)·operator(서명/인증서, CA·사용자관리 불가)·viewer(읽기전용 GET만).
 *  - 안전장치: 마지막 활성 admin 강등/비활성 차단, 잘못된 자격증명/무효 토큰 401.
 *  - 하위호환: CONSOLE_API_KEY break-glass·HIS 기계키 무영향, sign-admin(users:admin) break-glass 사용자 생성.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4756, B = `http://127.0.0.1:${PORT}`;
const HIS = 'his-k', CON = 'con-k', ADM = 'adm-k', ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const J = { 'Content-Type': 'application/json' };
const keyH = (k) => ({ ...J, 'x-api-key': k });
const sessH = (t) => ({ ...J, 'x-session-token': t });
const post = (p, b, h) => fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(b ?? {}) });
const patch = (p, b, h) => fetch(B + p, { method: 'PATCH', headers: h, body: JSON.stringify(b ?? {}) });
const get = (p, h) => fetch(B + p, { headers: h });

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT),
      HIS_INBOUND_API_KEY: HIS, CONSOLE_API_KEY: CON, SIGN_ADMIN_API_KEY: ADM,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 45).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60',
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const enrollBody = { ownerType: 'PATIENT', subjectDn: 'CN=S', identity: { method: 'PASS', ci: 'C' } };
const login = async (u, p) => post('/v1/auth/login', { username: u, password: p }, J);

async function main() {
  console.log('\n══════ C-4 다중관리자 RBAC e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 1) 부트스트랩 admin 로그인
    const badLogin = await login('root', 'wrong');
    check(badLogin.status === 401, '잘못된 비밀번호 → 401');
    const lr = await login('root', ADMIN_PW);
    const ld = (await lr.json()).data;
    check(lr.status === 201 && !!ld?.token && ld.role === 'admin', `admin 로그인 → 토큰 발급(role=${ld?.role})`);
    // 비활동 자동 로그아웃(EMR F004) — 로그인 응답에 idleTimeoutMin 노출(기본 30, TTL 캡)
    check(typeof ld.idleTimeoutMin === 'number' && ld.idleTimeoutMin >= 0, `idleTimeoutMin 노출(=${ld?.idleTimeoutMin})`);
    const adminTok = ld.token;
    const me = (await (await get('/v1/auth/me', sessH(adminTok))).json()).data;
    check(me.username === 'root' && me.scopes.includes('users:admin') && me.scopes.includes('ca:admin'), `me — username=${me.username}, users:admin·ca:admin 보유`);

    // 2) admin 이 operator·viewer 생성
    const c1 = await post('/v1/admin/users', { username: 'op1', password: 'op1-pass-123', role: 'operator', email: 'OP1@Example.org' }, sessH(adminTok));
    const c2 = await post('/v1/admin/users', { username: 'vw1', password: 'vw1-pass-123', role: 'viewer' }, sessH(adminTok));
    check(c1.status === 201 && c2.status === 201, 'admin → operator·viewer 계정 생성');
    check((await c1.json()).data.email === 'op1@example.org', '내부 계정 이메일 속성(소문자 정규화)');
    const users = (await (await get('/v1/admin/users', sessH(adminTok))).json()).data;
    check(users.length === 3 && users.every((u) => !('hash' in u) && !('salt' in u)), `사용자 목록 3명·비밀 미노출`);
    // 이메일 인라인 변경·제거
    check((await (await patch('/v1/admin/users/op1', { email: 'op1-new@example.org' }, sessH(adminTok))).json()).data.email === 'op1-new@example.org', '이메일 변경');
    check((await patch('/v1/admin/users/op1', { email: 'bad-email' }, sessH(adminTok))).status === 400, '이메일 형식 오류 → 400');
    check(((await (await patch('/v1/admin/users/op1', { email: '' }, sessH(adminTok))).json()).data.email ?? null) === null, '빈 문자열 → 이메일 제거');

    // 3) operator 인가 — 서명/인증서 OK, CA·사용자관리 차단
    const opTok = (await (await login('op1', 'op1-pass-123')).json()).data.token;
    check((await post('/v1/certificates/enroll', enrollBody, sessH(opTok))).status === 201, 'operator — 인증서 발급(certificates:write) 201');
    check((await get('/v1/admin/consumers', sessH(opTok))).status === 403, 'operator — 소비자 목록(ca:admin) 403');
    check((await post('/v1/admin/users', { username: 'x', password: 'xxxxxxxx', role: 'viewer' }, sessH(opTok))).status === 403, 'operator — 사용자 생성(users:admin) 403');

    // 4) viewer 인가 — 읽기 GET 만, 변경·민감 스코프 차단
    const vwTok = (await (await login('vw1', 'vw1-pass-123')).json()).data.token;
    check((await get('/v1/requests', sessH(vwTok))).status === 200, 'viewer — 요청 목록 GET(읽기 우회) 200');
    check((await post('/v1/certificates/enroll', enrollBody, sessH(vwTok))).status === 403, 'viewer — 인증서 발급(변경) 403');
    check((await get('/v1/admin/users', sessH(vwTok))).status === 403, 'viewer — 사용자 목록(민감 GET) 403');
    check((await get('/v1/admin/consumers', sessH(vwTok))).status === 403, 'viewer — 소비자 목록(ca:admin) 403');

    // 5) 안전장치 — 마지막 활성 admin 강등/비활성 차단
    check((await patch('/v1/admin/users/root', { role: 'operator' }, sessH(adminTok))).status === 409, '마지막 admin 강등 → 409');
    check((await patch('/v1/admin/users/root', { status: 'disabled' }, sessH(adminTok))).status === 409, '마지막 admin 비활성 → 409');

    // 6) 비활성 계정 토큰 무효화 — operator 비활성화 후 기존 토큰 401
    check((await patch('/v1/admin/users/op1', { status: 'disabled' }, sessH(adminTok))).status === 200, 'admin — operator 비활성화');
    check((await get('/v1/auth/me', sessH(opTok))).status === 401, '비활성 계정 기존 토큰 → 401');

    // 7) 무효/위조 토큰 401
    check((await get('/v1/auth/me', sessH('garbage.token'))).status === 401, '위조 세션 토큰 → 401');

    // 8) 하위호환 — CONSOLE_API_KEY break-glass·HIS 기계키 무영향
    check((await post('/v1/certificates/enroll', enrollBody, keyH(CON))).status === 201, 'CONSOLE_API_KEY break-glass 발급 201(불변)');
    check((await post('/v1/certificates/enroll', enrollBody, keyH(HIS))).status === 201, 'HIS 기계키 발급 201(불변)');
    // 기계 키 + 습관적 Authorization: Bearer(비-세션) 동시 전송 → x-api-key 로 폴백(401 아님)
    check((await post('/v1/certificates/enroll', enrollBody, { ...keyH(HIS), Authorization: 'Bearer not-a-session-token' })).status === 201, 'x-api-key + 비-세션 Bearer 동시 → 키 폴백 201(연동 무중단)');

    // 9) sign-admin(users:admin) break-glass 로 사용자 생성
    check((await post('/v1/admin/users', { username: 'bg1', password: 'bg1-pass-123', role: 'operator' }, keyH(ADM))).status === 201, 'sign-admin 키 break-glass 사용자 생성 201');
    // console 키는 users:admin 없음 → 차단
    check((await get('/v1/admin/users', keyH(CON))).status === 403, 'CONSOLE_API_KEY — 사용자관리(users:admin 없음) 403');

    // 10) ops-status RBAC 노출
    const ops = (await (await get('/v1/admin/ops-status', keyH(CON))).json()).data;
    check(ops.config?.rbac?.adminUsers >= 3 && Array.isArray(ops.config.rbac.roles), `ops-status rbac.adminUsers=${ops.config?.rbac?.adminUsers}`);
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ C-4 RBAC 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
