// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 소비자(기계 연동) 등록/스코프 관리 UI 백엔드 e2e — 콘솔에서 신규 consumer 발급·관리.
 *  - 등록(ca:admin): 키 서버생성·1회 반환. 등록 키로 스코프 내 호출 동작.
 *  - 최소권한: 민감 스코프(ca:admin) 부여 차단(400)·예약 이름 충돌(409)·비ca:admin 등록 차단(403).
 *  - 스코프 편집·상태(일시중지→401·재개)·시스템 소비자 편집 차단(400).
 *  - 재기동 영속(File 스토어): 등록 소비자·키 생존.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4834, B = `http://127.0.0.1:${PORT}`;
const HIS_KEY = 'his-reg-key';
const ADMIN_KEY = 'admin-reg-key'; // sign-admin(ca:admin)
const STORE = join(mkdtempSync(join(tmpdir(), 'sign-reg-')), 'store.json');
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const H = (key) => ({ ...J, 'x-api-key': key });
const post = (p, b, key) => fetch(B + p, { method: 'POST', headers: H(key), body: JSON.stringify(b ?? {}) });
const patch = (p, b, key) => fetch(B + p, { method: 'PATCH', headers: H(key), body: JSON.stringify(b ?? {}) });
const getj = async (p, key) => (await fetch(B + p, { headers: H(key) })).json();
const enroll = (key) => post('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=Reg' + Math.random(), licenseNumber: 'L1', identity: { method: 'STAFF_SSO' } }, key);

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), STORE_DRIVER: 'file', STORE_FILE: STORE, HIS_INBOUND_API_KEY: HIS_KEY, SIGN_ADMIN_API_KEY: ADMIN_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 79).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 소비자 등록/스코프 관리 e2e ══════\n');
  let app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  let werbKey;
  try {
    // ── 부여 가능 스코프 ──
    const scopes = (await getj('/v1/admin/consumers/assignable-scopes', ADMIN_KEY)).data;
    check(Array.isArray(scopes) && scopes.includes('approval:write') && !scopes.includes('ca:admin'), '부여 가능 스코프(민감 제외)');

    // ── 등록 ──
    console.log('── 등록 ──');
    const createRes = await post('/v1/admin/consumers', { name: 'werb', scopes: ['certificates:write', 'approval:write'] }, ADMIN_KEY);
    const created = (await createRes.json()).data;
    werbKey = created?.apiKey;
    check(createRes.status === 201 && werbKey?.startsWith('sk_') && created.scopes.includes('approval:write'), '소비자 등록 → 키 1회 반환');
    check((await enroll(werbKey)).status === 201, '등록 키로 certificates:write 호출 → 201');
    check((await post('/v1/admin/consumers', { name: 'x', scopes: ['requests:write'] }, werbKey)).status === 403, '등록 키(비 ca:admin)로 소비자 등록 → 403');

    // ── 검증(권한상승·충돌 차단) ──
    console.log('── 검증 ──');
    check((await post('/v1/admin/consumers', { name: 'evil', scopes: ['ca:admin'] }, ADMIN_KEY)).status === 400, '민감 스코프(ca:admin) 부여 → 400');
    check((await post('/v1/admin/consumers', { name: 'hospitalrun', scopes: ['requests:write'] }, ADMIN_KEY)).status === 409, '예약 이름(hospitalrun) → 409');
    check((await post('/v1/admin/consumers', { name: 'werb', scopes: ['requests:write'] }, ADMIN_KEY)).status === 409, '중복 이름 → 409');

    // ── 스코프 편집 ──
    console.log('── 스코프 편집·상태 ──');
    check((await patch('/v1/admin/consumers/werb', { scopes: ['approval:write'] }, ADMIN_KEY)).status === 200, '스코프 편집(certificates:write 제거) → 200');
    check((await enroll(werbKey)).status === 403, '편집 반영 — certificates:write 없음 → 403');
    // 상태(일시중지 → 재개)
    check((await patch('/v1/admin/consumers/werb', { status: 'SUSPENDED' }, ADMIN_KEY)).status === 200, '일시중지 → 200');
    check((await enroll(werbKey)).status === 401, '중지된 키 → 401');
    await patch('/v1/admin/consumers/werb', { status: 'ACTIVE', scopes: ['certificates:write'] }, ADMIN_KEY);
    check((await enroll(werbKey)).status === 201, '재개 + certificates:write 복원 → 201');
    // 시스템 소비자 편집 차단
    check((await patch('/v1/admin/consumers/hospitalrun', { scopes: ['requests:write'] }, ADMIN_KEY)).status === 400, '시스템 소비자 스코프 편집 → 400');
    check((await getj('/v1/admin/consumers', ADMIN_KEY)).data.find((c) => c.name === 'werb')?.dynamic === true, '목록 — werb dynamic=true');
    check((await getj('/v1/admin/consumers', ADMIN_KEY)).data.find((c) => c.name === 'hospitalrun')?.dynamic === false, '목록 — hospitalrun dynamic=false(시스템)');
  } finally { app.kill(); await sleep(500); }

  // ── 재기동 영속(File 스토어) ──
  console.log('── 재기동 영속 ──');
  app = start();
  if (!(await up())) { check(false, '재기동 실패'); app.kill(); process.exit(1); }
  try {
    const werb = (await getj('/v1/admin/consumers', ADMIN_KEY)).data.find((c) => c.name === 'werb');
    check(werb?.dynamic === true && werb?.activeKeys === 1, '재기동 후 werb 생존(정의·키해시 복원)');
    // CA soft 키 볼트는 이 테스트 스코프 밖(미영속)이라 enroll 대신 인증 성립만 확인:
    // werb 키가 인식되면 ca:admin 없어 403(키 미복원이면 401) → 키 해시 영속 증명.
    check((await post('/v1/admin/consumers', { name: 'z', scopes: ['requests:write'] }, werbKey)).status === 403, '재기동 후 werb 키 인증됨(403=인증 OK·스코프 거부, 401 아님)');
  } finally { app.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — 소비자 등록/스코프 관리 (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
