// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 서버측 목록 검색 e2e (enhancement: server-side search).
 *  - 요청 목록: q(제목·문서ID·요청ID·참가자명) 전체 집합 검색 + status 필터 + 페이지네이션 정합(total=필터 결과수).
 *  - 인증서 목록: q(시리얼·주체·유형·면허) 검색.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4767, B = `http://127.0.0.1:${PORT}`;
const CON = 'con-k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'x-api-key': CON };
const post = (p, b) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p, { headers: H })).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: 'his-k', CONSOLE_API_KEY: CON, CRYPTO_MASTER_KEY: Buffer.alloc(32, 47).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const dh = (s) => createHash('sha256').update(s).digest('hex');
async function enroll(subjectDn) {
  return (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn, identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
}
async function makeReq(key, docId, title, displayName, serial) {
  return post('/v1/requests', { idempotencyKey: key, externalDocId: docId, title, documentHash: dh(key), signMode: 'APP',
    participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName, signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] });
}

async function main() {
  console.log('\n══════ 서버측 목록 검색 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const ser = await enroll('CN=환자기본');
    await makeReq('req-alpha', 'DOC-ALPHA', '수술 동의서 알파', '김알파', ser);
    await makeReq('req-beta', 'DOC-BETA', '마취 동의서 베타', '이베타', ser);
    await makeReq('req-gamma', 'DOC-GAMMA', '수혈 동의서 감마', '박감마', ser);

    // 1) 제목 부분일치
    let r = await getj('/v1/requests?q=베타');
    check(r.page.total === 1 && r.data[0].title.includes('베타'), `q=베타 → 1건(${r.data[0]?.title})`);
    // 2) 공통어 — 3건
    r = await getj('/v1/requests?q=' + encodeURIComponent('동의서'));
    check(r.page.total === 3, `q=동의서 → 3건(total=${r.page.total})`);
    // 3) 문서ID
    r = await getj('/v1/requests?q=doc-gamma');
    check(r.page.total === 1 && r.data[0].externalDocId === 'DOC-GAMMA', 'q=doc-gamma(대소문자무관) → 1건');
    // 4) 참가자명
    r = await getj('/v1/requests?q=' + encodeURIComponent('이베타'));
    check(r.page.total === 1, 'q=참가자명(이베타) → 1건');
    // 5) 검색+페이지네이션 정합 — total=필터 결과수, 페이지 슬라이스
    r = await getj('/v1/requests?q=' + encodeURIComponent('동의서') + '&limit=2&offset=0');
    check(r.data.length === 2 && r.page.total === 3, `q+limit2 → data 2 / total 3`);
    r = await getj('/v1/requests?q=' + encodeURIComponent('동의서') + '&limit=2&offset=2');
    check(r.data.length === 1 && r.page.total === 3, `q+offset2 → data 1 / total 3(페이지 가로지름)`);
    // 6) status 필터
    r = await getj('/v1/requests?status=CREATED');
    check(r.page.total === 3, `status=CREATED → 3건`);
    r = await getj('/v1/requests?status=COMPLETED');
    check(r.page.total === 0, `status=COMPLETED → 0건`);
    // 7) 미일치
    r = await getj('/v1/requests?q=존재하지않는검색어zzz');
    check(r.page.total === 0 && r.data.length === 0, 'q=미일치 → 0건');
    // 8) 검색 미지정 — 전체(하위호환)
    r = await getj('/v1/requests');
    check(r.page.total === 3, '검색 미지정 → 전체 3건(하위호환)');

    // 8b) 기간 필터(대시보드 working set 상한) — 방금 생성이므로 days=1=전체, 과거 to=0, 미래 from=0
    r = await getj('/v1/requests?days=1');
    check(r.page.total === 3, '기간 days=1(최근 1일) → 전체 3건');
    r = await getj('/v1/requests?to=2000-01-01T00:00:00.000Z');
    check(r.page.total === 0, '기간 to=과거 → 0건');
    r = await getj('/v1/requests?from=2999-01-01T00:00:00.000Z');
    check(r.page.total === 0, '기간 from=미래 → 0건');
    r = await getj('/v1/requests?from=2000-01-01T00:00:00.000Z&status=CREATED');
    check(r.page.total === 3, '기간+상태 결합 → 3건');
    // 8c) 출처·서명모드·미완료 필터(전체 console·APP·CREATED)
    r = await getj('/v1/requests?createdBy=console');
    check(r.page.total === 3, '출처 createdBy=console → 3건');
    r = await getj('/v1/requests?createdBy=pacs');
    check(r.page.total === 0, '출처 createdBy=pacs → 0건');
    r = await getj('/v1/requests?signMode=APP');
    check(r.page.total === 3, '서명모드 APP → 3건');
    r = await getj('/v1/requests?signMode=MULTI');
    check(r.page.total === 0, '서명모드 MULTI → 0건');
    r = await getj('/v1/requests?incomplete=true');
    check(r.page.total === 3, '미완료(서명 대기) → 3건(전부 CREATED)');
    r = await getj('/v1/requests?createdBy=console&signMode=APP&incomplete=true');
    check(r.page.total === 3, '복합 필터(출처+모드+미완료) → 3건');
    check(r.data[0].createdBy === 'console', 'DTO createdBy 노출(=console)');
    // 최신순 정렬(createdAt desc) — data[0].createdAt >= data[last].createdAt
    r = await getj('/v1/requests');
    const ds = r.data.map((x) => x.createdAt);
    check(ds.every((v) => typeof v === 'string') && ds[0] >= ds[ds.length - 1], '최신순 정렬(createdAt desc)');

    // 9) 인증서 검색
    await enroll('CN=검색대상병원하나');
    await enroll('CN=검색대상병원둘');
    let c = await getj('/v1/certificates?q=' + encodeURIComponent('검색대상병원'));
    check(c.page.total === 2, `cert q=검색대상병원 → 2건(total=${c.page.total})`);
    c = await getj('/v1/certificates?q=' + encodeURIComponent('하나'));
    check(c.page.total === 1, 'cert q=하나 → 1건');
    c = await getj('/v1/certificates?q=' + ser.slice(0, 6));
    check(c.page.total >= 1, 'cert q=시리얼 일부 → 일치');
    // 인증서 푸시다운: CA 제외·페이지네이션·정렬(notBefore desc)
    c = await getj('/v1/certificates');
    check(c.data.every((x) => x.ownerType !== 'CA'), 'cert 목록 CA 앵커 제외');
    const certTotal = c.page.total;
    c = await getj('/v1/certificates?limit=1&offset=0');
    check(c.data.length === 1 && c.page.total === certTotal, `cert 페이지(limit1) → data 1 / total ${certTotal}`);
    c = await getj('/v1/certificates');
    const nbAll = c.data.map((x) => x.notBefore);
    check(nbAll.length <= 1 || nbAll[0] >= nbAll[nbAll.length - 1], 'cert 최신순 정렬(notBefore desc)');

    // 운영 추세 metrics(차트) — 상태분포·일자별·webhook 성공률
    const m = (await getj('/v1/admin/metrics?days=30')).data;
    check(!!m && typeof m.requestTotal === 'number' && !!m.statusDistribution && Array.isArray(m.daily) && !!m.webhooks && typeof m.webhooks.successRate === 'number', `metrics(요청 ${m?.requestTotal}·상태분포·일자별·webhook ${m?.webhooks?.successRate}%)`);
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ 서버측 검색 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
