// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 문서 인증 목록(wsign) e2e — 외부 문서인증 연동이 audit-events 로 보낸 문서 어테스테이션을
 * 문서별 스트림에서 하나의 목록으로 통합 관리.
 *  - targetType=wsign_document 만 집계(비-wsign 이벤트 제외)·문서/해시 필드 부착.
 *  - 서버측 필터(q)·CSV(제목·문서해시 포함)·권한(requests:write, 무키 401).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4838, B = `http://127.0.0.1:${PORT}`;
const KEY = 'his-wsign-key';       // requests:write 보유
const ADMIN_KEY = 'admin-wsign-key'; // ca:admin(requests:write 없음)
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const post = (p, b, k) => fetch(B + p, { method: 'POST', headers: H(k), body: JSON.stringify(b) });
const getj = async (p, k) => (await fetch(B + p, { headers: H(k) })).json();
const seedDoc = (id, title) => post('/v1/audit-events', { action: 'WSIGN_ATTEST', actor: 'sys', actorRole: 'SYSTEM', targetType: 'wsign_document', targetRef: id, stream: 'wsign-' + id, data: { title, documentHash: createHash('sha256').update(id).digest('hex'), system: 'werb-docauth', hashAlgo: 'sha256' } }, KEY);

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, SIGN_ADMIN_API_KEY: ADMIN_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 61).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 문서 인증 목록(wsign) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 비-wsign 이벤트(제외 대상) + wsign 문서 2건
    await post('/v1/audit-events', { action: 'RECORD_VIEWED', actor: 'dr', stream: 'medical-records', data: {} }, KEY);
    await seedDoc('DOC-1', '차량사용 신청');
    await seedDoc('DOC-2', '휴가 신청');

    const list = (await getj('/v1/admin/wsign-documents?limit=50', KEY)).data;
    check(list.length === 2, `문서 어테스테이션만 2건(비-wsign 제외) — ${list.length}`);
    check(list.every((r) => r.targetRef && r.title && r.documentHash && r.eventType === 'WSIGN_ATTEST'), '문서·해시·이벤트 필드 부착');
    check(list.every((r) => r.chainValid === true), '문서별 해시체인 무결성 표기');
    check((await getj('/v1/admin/wsign-documents?q=' + encodeURIComponent('휴가'), KEY)).data.length === 1, '서버측 필터(q=제목)');

    const csv = Buffer.from(await (await fetch(B + '/v1/admin/wsign-documents/export.csv', { headers: H(KEY) })).arrayBuffer());
    const csvText = csv.toString('utf8');
    check(csv[0] === 0xef && csv[1] === 0xbb && csv[2] === 0xbf, 'CSV UTF-8 BOM');
    check(csvText.includes('차량사용 신청') && csvText.includes(createHash('sha256').update('DOC-1').digest('hex')), 'CSV 제목·문서해시 포함');

    // 문서 상세
    const det = (await getj('/v1/admin/wsign-documents/detail?stream=wsign-DOC-1', KEY)).data;
    check(det?.targetRef === 'DOC-1' && det?.title === '차량사용 신청' && det?.documentHash === createHash('sha256').update('DOC-1').digest('hex') && det?.chainValid === true && Array.isArray(det?.entries) && det.entries.length >= 1, '문서 상세 — 이력·해시·무결성');
    check((await fetch(B + '/v1/admin/wsign-documents/detail?stream=medical-records', { headers: H(KEY) })).status === 404, '비-wsign 스트림 상세 → 404');

    // 시스템 필터
    check((await getj('/v1/admin/wsign-documents?system=werb-docauth&limit=50', KEY)).data.length === 2, '시스템 필터(werb-docauth) → 2건');
    check((await getj('/v1/admin/wsign-documents?system=other-sys&limit=50', KEY)).data.length === 0, '시스템 필터(없는 값) → 0건');

    check((await fetch(B + '/v1/admin/wsign-documents')).status === 401, '무키 → 401');
    check((await fetch(B + '/v1/admin/wsign-documents', { headers: H(ADMIN_KEY) })).status === 403, 'requests:write 없음(ca:admin 키) → 403');
  } finally { app.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — 문서 인증 목록(wsign) (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
