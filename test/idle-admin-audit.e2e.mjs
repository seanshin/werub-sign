// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 콘솔 세션 부가기능 e2e — v1.6.0 이후 증분(전용 커버리지 보강).
 *  A) 비활동 자동 로그아웃 사용자 설정(F004): GET/POST /v1/auth/idle-timeout
 *     - 세션 필요(기계 키 불가 401), 정책 캡 클램프, <1분 400, null=정책 복귀, 즉시 반영.
 *  B) 관리자 감사 스트림: /v1/admin/audit(list·streams·export.csv·verify)
 *     - users:admin 한정(기계 HIS 키 403·무권한 401), admin:auth 화이트리스트, 서버측 필터·CSV·체인 무결성.
 *  C) 임상행위 감사(audit-events): record→streams·list·export.csv·verify
 *     - requests:write, 테넌트 격리(자기 system), eventType·q 서버측 필터, BOM CSV, 체인 무결성.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4823, B = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'admin-pass-123';
const K = 'his-machine-key'; // HIS 기계 키(users:admin 없음)
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const sessH = (t) => ({ ...J, 'x-session-token': t });
const post = (p, b, h = J) => fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(b ?? {}) });
const get = (p, h) => fetch(B + p, { headers: h });

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT), CRYPTO_MASTER_KEY: Buffer.alloc(32, 73).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, HIS_INBOUND_API_KEY: K, SESSION_TTL_MIN: '480',
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const login = async (u, p) => (await post('/v1/auth/login', { username: u, password: p })).json();

async function main() {
  console.log('\n══════ 콘솔 세션 부가기능(idle-timeout·admin-audit) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 세션 확보 — LOGIN 이 admin:auth 스트림에 봉인됨(admin-audit 조회 대상 생성).
    const tok = (await login('root', ADMIN_PW)).data?.token;
    check(!!tok, '관리자 로그인 → 세션 발급');

    // ── A) 비활동 자동 로그아웃 설정(F004) ──────────────────────────────
    console.log('\n── A0) 본인 알림 이메일 설정 ──');
    let me = (await (await get('/v1/auth/me', sessH(tok))).json()).data;
    check(me?.username && 'email' in me, `me → username=${me?.username}·email 필드 노출`);
    check((await post('/v1/auth/email', { email: 'me@example.org' }, sessH(tok))).status === 201, '본인 이메일 설정 201');
    me = (await (await get('/v1/auth/me', sessH(tok))).json()).data;
    check(me?.email === 'me@example.org', 'me → 설정 이메일 반영');
    check((await post('/v1/auth/email', { email: 'bad-email' }, sessH(tok))).status === 400, '이메일 형식 오류 → 400');
    check((await post('/v1/auth/email', { email: '' }, sessH(tok))).status === 201, '빈 값 → 제거(201)');
    me = (await (await get('/v1/auth/me', sessH(tok))).json()).data;
    check((me?.email ?? null) === null, 'me → 이메일 제거 반영');
    check((await post('/v1/auth/email', { email: 'x@y.com' }, { 'x-api-key': K })).status === 401, '기계 키 → 401(세션 필요)');

    console.log('\n── A) idle-timeout 설정 ──');
    let r = await (await get('/v1/auth/idle-timeout', sessH(tok))).json();
    let d = r.data;
    check(d?.idleTimeoutMin > 0 && d.minMin === 1 && d.maxMin > 0, `GET → 현재값·상한(idle=${d?.idleTimeoutMin}, cap=${d?.maxMin})`);
    check(d?.devMode === true, '개발모드 → devMode=true(정책 초과 옵션 노출)');
    check(d?.preference === null, '초기 선호 없음 → preference=null(정책값 적용)');
    const cap = d.maxMin, policy = d.policyMaxMin;

    // 기계 키(세션 없음) → 401(관리자 세션 필요)
    check((await get('/v1/auth/idle-timeout', { 'x-api-key': K })).status === 401, '기계 키(세션 없음) → 401');

    // 정책보다 짧게 설정 → 그대로 저장·즉시 반영
    const want = Math.max(1, Math.min(policy > 1 ? policy - 1 : cap, cap));
    let sr = await (await post('/v1/auth/idle-timeout', { minutes: want }, sessH(tok))).json();
    check(sr.data?.preference === want && sr.data?.idleTimeoutMin === want, `POST minutes=${want} → 저장(preference=idleTimeoutMin=${want})`);
    d = (await (await get('/v1/auth/idle-timeout', sessH(tok))).json()).data;
    check(d?.preference === want && d?.idleTimeoutMin === want, 'GET → 변경 반영');

    // 정책 캡 초과 → 캡으로 클램프
    sr = await (await post('/v1/auth/idle-timeout', { minutes: cap + 5000 }, sessH(tok))).json();
    check(sr.data?.preference === cap, `POST minutes>캡 → 캡(${cap})으로 클램프`);

    // 1분 미만 → 400
    check((await post('/v1/auth/idle-timeout', { minutes: 0 }, sessH(tok))).status === 400, 'POST minutes=0 → 400');
    check((await post('/v1/auth/idle-timeout', { minutes: -3 }, sessH(tok))).status === 400, 'POST minutes<0 → 400');

    // null → 해제(정책 복귀)
    sr = await (await post('/v1/auth/idle-timeout', { minutes: null }, sessH(tok))).json();
    check(sr.data?.preference === null, 'POST minutes=null → 해제(preference=null)');
    d = (await (await get('/v1/auth/idle-timeout', sessH(tok))).json()).data;
    check(d?.preference === null && d?.idleTimeoutMin === policy, 'GET → 정책값 복귀');

    // ── B) 관리자 감사 스트림 ────────────────────────────────────────────
    console.log('\n── B) admin-audit ──');
    // 권한 경계
    check((await get('/v1/admin/audit', { 'x-api-key': K })).status === 403, '기계 HIS 키(users:admin 없음) → 403');
    check((await get('/v1/admin/audit')).status === 401, '무권한 → 401');

    // 스트림 목록
    const st = (await (await get('/v1/admin/audit/streams', sessH(tok))).json()).data;
    check(Array.isArray(st) && st.some((s) => s.stream === 'admin:auth') && st.some((s) => s.stream === 'admin:users'), 'streams → admin:auth·admin:users');
    const authCount = st.find((s) => s.stream === 'admin:auth')?.count ?? 0;
    check(authCount >= 1, `admin:auth 봉인 존재(count=${authCount}, 로그인 이력)`);

    // 목록(페이지네이션)
    const page = await (await get('/v1/admin/audit?stream=admin:auth&limit=50', sessH(tok))).json();
    check(Array.isArray(page.data) && page.data.length >= 1, 'list → 페이지 data 배열');
    check(page.data.some((e) => e.eventType === 'LOGIN'), 'LOGIN 이벤트 포함');

    // 화이트리스트 — 임의 stream → admin:auth 로 폴백(임의 키 조회 차단)
    const fb = await (await get('/v1/admin/audit?stream=..%2Fsecret', sessH(tok))).json();
    check(Array.isArray(fb.data), '임의 stream → 폴백(admin:auth), 임의 키 조회 차단');

    // 서버측 필터(eventType)
    const flt = await (await get('/v1/admin/audit?stream=admin:auth&eventType=LOGIN&limit=50', sessH(tok))).json();
    check(flt.data.length >= 1 && flt.data.every((e) => e.eventType === 'LOGIN'), 'eventType=LOGIN 필터 → 전건 LOGIN');
    const none = await (await get('/v1/admin/audit?stream=admin:auth&eventType=__NOPE__', sessH(tok))).json();
    check(none.data.length === 0, '없는 eventType → 0건');

    // 서버측 검색(q)
    const q = await (await get('/v1/admin/audit?stream=admin:auth&q=login', sessH(tok))).json();
    check(q.data.length >= 1, 'q=login → 부분일치 검색');

    // 전체 CSV — BOM(한글 Excel)은 바이트 레벨 검증(fetch .text()는 선행 BOM을 디코딩 시 제거).
    const csvRes = await get('/v1/admin/audit/export.csv?stream=admin:auth', sessH(tok));
    const bytes = Buffer.from(await csvRes.arrayBuffer());
    check(csvRes.status === 200 && (csvRes.headers.get('content-type') || '').includes('text/csv'), 'export.csv → 200 text/csv');
    check(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'CSV → UTF-8 BOM(한글 Excel)');
    const csv = bytes.slice(3).toString('utf8');
    check(csv.startsWith('occurredAt') && csv.includes('eventType') && csv.includes('entryHash'), 'CSV → 헤더(occurredAt·eventType·entryHash)');

    // 무결성 검증(해시체인)
    const vr = (await (await get('/v1/admin/audit/verify?stream=admin:auth', sessH(tok))).json()).data;
    check(vr?.chainValid === true, 'verify → chainValid=true(봉인 무결)');

    // ── C) 임상행위 감사(audit-events) — 서버측 필터·CSV(같은 audit-filter 공용) ──────
    console.log('\n── C) audit-events(임상행위) ──');
    const kh = { ...J, 'x-api-key': K }; // HIS 기계 키(requests:write, system=hospitalrun)
    const STREAM = 'clinical-events';
    // 권한 — 무키 401
    check((await get('/v1/audit-events')).status === 401, '무권한 → 401');
    // 행위 봉인(2건, 검색 대상 구성)
    let rec = await (await post('/v1/audit-events', { action: 'CONSENT_OBTAINED', actor: 'doc-77', actorRole: 'DOCTOR', targetType: 'CONSENT', targetRef: 'C-9001', stream: STREAM }, kh)).json();
    check(!!rec.data?.entryHash && rec.data?.authMethod === 'API_KEY', 'record #1 → 봉인(entryHash·API_KEY)');
    await post('/v1/audit-events', { action: 'REPORT_APPROVED', actor: 'doc-88', actorRole: 'DOCTOR', targetType: 'STUDY', targetRef: 'S-1234', stream: STREAM }, kh);

    // 스트림 목록(테넌트 격리 — hospitalrun 자기 항목만)
    const est = (await (await get('/v1/audit-events/streams', kh)).json()).data;
    check(Array.isArray(est) && est.some((s) => s.stream === STREAM && s.count >= 2), `streams → ${STREAM}(자기 system 격리, count≥2)`);

    // 목록 + eventType(=action) 필터
    const el = await (await get(`/v1/audit-events?stream=${STREAM}&limit=50`, kh)).json();
    check(Array.isArray(el.data) && el.data.length >= 2, 'list → 봉인 2건 이상');
    const ef = await (await get(`/v1/audit-events?stream=${STREAM}&eventType=CONSENT_OBTAINED`, kh)).json();
    check(ef.data.length >= 1 && ef.data.every((e) => e.eventType === 'CONSENT_OBTAINED'), 'eventType=CONSENT_OBTAINED → 전건 일치');

    // 서버측 검색(q) — data 본문(targetRef) 부분일치
    const eq = await (await get(`/v1/audit-events?stream=${STREAM}&q=${encodeURIComponent('c-9001')}`, kh)).json();
    check(eq.data.length === 1 && eq.data[0].eventType === 'CONSENT_OBTAINED', 'q=c-9001 → data 본문 부분일치 1건');

    // 전체 CSV(BOM 바이트 검증)
    const ecsvRes = await get(`/v1/audit-events/export.csv?stream=${STREAM}`, kh);
    const eb = Buffer.from(await ecsvRes.arrayBuffer());
    check(ecsvRes.status === 200 && eb[0] === 0xEF && eb[1] === 0xBB && eb[2] === 0xBF, 'export.csv → 200 + UTF-8 BOM');
    const ecsv = eb.slice(3).toString('utf8');
    check(ecsv.startsWith('occurredAt') && ecsv.includes('CONSENT_OBTAINED'), 'CSV → 헤더 + 봉인 행위 포함');

    // 무결성 검증
    const evr = (await (await get(`/v1/audit-events/verify?stream=${STREAM}`, kh)).json()).data;
    check(evr?.chainValid === true, 'verify → chainValid=true(봉인 무결)');

  } finally { app.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — idle-timeout · admin-audit (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
