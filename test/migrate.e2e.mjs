// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 마이그레이션·푸시다운 e2e(K2) — 실 PostgreSQL(마이그레이션 0001~0004 적용 후) 에서
 * 인덱스 컬럼(status·createdBy·signMode·searchText·ownerType) 이 존재하고 채워져
 * DB 레벨 필터가 정확히 동작함을 검증. 컬럼 부재면 prisma 질의 실패 → 테스트 실패.
 *
 * 사전(CI): `npx prisma migrate deploy` (DATABASE_URL 지정). PG 미가용 시 SKIP(개발 보호).
 * 실행: DB_URL=postgresql://sign:signpw@localhost:5432/sign npm run build && node test/migrate.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';

const PORT = 4707, B = `http://127.0.0.1:${PORT}`;
const HIS = 'mig-his-key', ERP = 'mig-erp-key';
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL ?? 'postgresql://sign:signpw@localhost:5432/sign';
const TS = Date.now();
let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const post = (p, b, k) => fetch(B + p, { method: 'POST', headers: H(k), body: JSON.stringify(b ?? {}) });
const getj = async (p, k) => (await fetch(B + p, { headers: { 'x-api-key': k } })).json();
const dh = (s) => createHash('sha256').update(s).digest('hex');

function pgReachable() {
  const m = DB_URL.match(/@([^:/]+):(\d+)/);
  const host = m?.[1] ?? 'localhost', port = Number(m?.[2] ?? 5432);
  return new Promise((res) => {
    const s = net.createConnection({ host, port });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(1500, () => { s.destroy(); res(false); });
  });
}
function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), STORE_DRIVER: 'prisma', DB_URL, DATABASE_URL: DB_URL,
      // prisma-live.e2e 와 동일 마스터키 — 공유 DB의 CA 키(봉인)를 함께 언실(키 불일치 시 서명 실패).
      HIS_INBOUND_API_KEY: HIS, ERP_API_KEY: ERP, CRYPTO_MASTER_KEY: Buffer.alloc(32, 13).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 30; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(400); } return false; }

async function makeReq(key, { ownerType, role, type, title, signMode }) {
  const serial = (await (await post('/v1/certificates/enroll', { ownerType, subjectDn: `CN=${title}`, identity: ownerType === 'PATIENT' ? { method: 'PASS', ci: 'C' + TS } : undefined }, key)).json()).data.serialNumber;
  return (await (await post('/v1/requests', {
    idempotencyKey: `mig-${title}`, externalDocId: `MIG-${title}`, title, documentHash: dh(title), signMode,
    participants: [{ signerRole: role, signerType: type, displayName: title, signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }],
  }, key)).json()).data;
}

async function main() {
  if (!(await pgReachable())) { console.log('⏭  SKIP: PostgreSQL 미가용 — CI/docker 에서만 실행(K2)'); process.exit(0); }
  console.log('\n══════ 마이그레이션·푸시다운 e2e (K2) ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패(마이그레이션 미적용?) — `npx prisma migrate deploy` 선행 필요'); app.kill(); process.exit(1); }
  try {
    const gamma = `감마동의서${TS}`, delta = `델타계약${TS}`;
    await makeReq(HIS, { ownerType: 'PATIENT', role: 'PATIENT', type: 'PATIENT', title: gamma, signMode: 'APP' });
    await makeReq(ERP, { ownerType: 'WITNESS', role: 'VENDOR', type: 'WITNESS_EXTERNAL', title: delta, signMode: 'PORTAL' });

    // q(searchText 컬럼) 단독
    console.log('— searchText(0002) —');
    check((await getj(`/v1/requests?q=${encodeURIComponent(gamma)}`, HIS)).page.total === 1, 'q=감마 → 1건(searchText 푸시다운)');

    // signMode(0004) 컬럼 — q 결합으로 공유 DB 내성
    console.log('— signMode(0004) —');
    check((await getj(`/v1/requests?signMode=APP&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 1, 'signMode=APP&q=감마 → 1건');
    check((await getj(`/v1/requests?signMode=PORTAL&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 0, 'signMode=PORTAL&q=감마 → 0건(분류 정확)');
    check((await getj(`/v1/requests?signMode=PORTAL&q=${encodeURIComponent(delta)}`, ERP)).page.total === 1, 'signMode=PORTAL&q=델타 → 1건');

    // createdBy(0004) 컬럼 — 출처 귀속 푸시다운
    console.log('— createdBy(0004) —');
    check((await getj(`/v1/requests?createdBy=hospitalrun&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 1, 'createdBy=hospitalrun&q=감마 → 1건');
    check((await getj(`/v1/requests?createdBy=erp&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 0, 'createdBy=erp&q=감마 → 0건(격리)');
    check((await getj(`/v1/requests?createdBy=erp&q=${encodeURIComponent(delta)}`, ERP)).page.total === 1, 'createdBy=erp&q=델타 → 1건');

    // status(0002) 컬럼
    console.log('— status(0002) —');
    check((await getj(`/v1/requests?status=CREATED&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 1, 'status=CREATED&q=감마 → 1건');
    check((await getj(`/v1/requests?status=COMPLETED&q=${encodeURIComponent(gamma)}`, HIS)).page.total === 0, 'status=COMPLETED&q=감마 → 0건');

    // 인증서 목록(0003 테이블 컬럼 ownerType/notBefore 존재 — 질의 성공)
    console.log('— 인증서 목록(0003) —');
    const certs = await getj(`/v1/certificates?q=${encodeURIComponent(delta)}`, ERP);
    check(Array.isArray(certs.data) && certs.data.length >= 1, '인증서 q 검색 → ≥1건(cert 푸시다운 컬럼 존재)');

    console.log('\n' + (failures === 0 ? '✅ 마이그레이션·푸시다운 e2e 전체 통과(PostgreSQL)' : `❌ ${failures}건 실패`));
  } finally { app.kill(); }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
