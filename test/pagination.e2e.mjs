// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * C-3 서버 페이지네이션 e2e — 목록 엔드포인트 limit/offset + page 메타(하위호환).
 * data=배열 유지(기존 클라 무영향) + page{total,limit,offset} 추가. limit max 200 클램프.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4748, B = `http://127.0.0.1:${PORT}`, KEY = 'pg-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getj = async (p) => (await fetch(B + p, { headers: { 'x-api-key': KEY } })).json();
const enroll = (i) => fetch(B + '/v1/certificates/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=P' + i, identity: { method: 'PASS', ci: 'C' } }) });

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CONSOLE_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 48).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ C-3 서버 페이지네이션 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    for (let i = 1; i <= 7; i++) await enroll(i);
    const all = await getj('/v1/certificates');
    check(Array.isArray(all.data) && all.data.length === 7 && all.page.total === 7 && all.page.limit === 7, `limit 없음 → 전체 ${all.data?.length}건(하위호환)·page.total=${all.page?.total}`);

    const p1 = await getj('/v1/certificates?limit=3&offset=0');
    check(p1.data.length === 3 && p1.page.total === 7 && p1.page.offset === 0, `limit=3 → 3건·total 7`);
    const p3 = await getj('/v1/certificates?limit=3&offset=6');
    check(p3.data.length === 1 && p3.page.total === 7, `offset=6 → 마지막 1건·total 7`);
    const clamp = await getj('/v1/certificates?limit=9999');
    check(clamp.page.limit === 200, `limit 999 → max 200 클램프`);

    // 다른 목록도 page 메타 포함
    const reqs = await getj('/v1/requests');
    check(Array.isArray(reqs.data) && !!reqs.page, '요청 목록도 page 메타 포함');
    const notis = await getj('/v1/admin/notifications');
    check(Array.isArray(notis.data) && !!notis.page, '발송 이력도 page 메타 포함');
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ 서버 페이지네이션 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
