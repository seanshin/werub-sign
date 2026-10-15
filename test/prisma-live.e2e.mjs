// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Prisma 라이브 영속화 e2e — STORE_DRIVER=prisma + 실 PostgreSQL.
 * 사전: docker compose up -d && npm run prisma:migrate
 * 실행: DB_URL=postgresql://sign:signpw@localhost:5432/sign npm run build && node test/prisma-live.e2e.mjs
 * DB 미가용 시 SKIP(개발 환경 보호).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';

const PORT = 4700;
const B = `http://localhost:${PORT}`;
const KEY = 'prisma-live-key';
const DB_URL = process.env.DB_URL ?? 'postgresql://sign:signpw@localhost:5432/sign';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

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
    env: { ...process.env, SIGN_PORT: String(PORT), STORE_DRIVER: 'prisma', DB_URL, HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 13).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 30; i++) { try { if ((await get('/v1/crl')).ok) return true; } catch {} await sleep(400); } return false; }

async function main() {
  if (!(await pgReachable())) {
    console.log('⏭  SKIP: PostgreSQL 미가용 — `docker compose up -d && npm run prisma:migrate` 후 재실행');
    process.exit(0);
  }
  console.log('\n══════ Prisma 라이브 영속화 e2e ══════\n');
  let server = start();
  if (!(await up())) {
    console.log('⏭  SKIP: sign DB 미가용/미마이그레이션 — `npm run db:up && npm run prisma:migrate` 후 재실행');
    server.kill();
    process.exit(0);
  }
  let serial;
  try {
    const docHash = createHash('sha256').update('동의서-prisma').digest('hex');
    const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=PrismaPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    serial = pat.data.serialNumber;
    const req = await (await post('/v1/requests', { idempotencyKey: 'pl-1', externalDocId: 'cf-p', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'INPERSON' }] })).json();
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
    const ver = await (await get('/v1/verify/' + req.data.requestId)).json();
    check(ver.data.overall === true, '발급→서명→검증(Postgres) overall=true');
    // JSONB 키순서 미보존 회귀 가드 — 저장 객체 재해시 무결성(canonical-json)
    const sig0 = ver.data.signatures[0];
    check(sig0.chainValid === true, '인증서 체인 검증(JSONB 라운드트립) chainValid=true');
    check(sig0.ltvValid === true, 'LTV 봉인 검증(JSONB 라운드트립) ltvValid=true');
    check(ver.data.auditChainValid === true, '감사 해시체인 검증(JSONB 라운드트립) auditChainValid=true');
    global.__rid = req.data.requestId;
  } finally { server.kill(); await sleep(500); }

  // 재기동 후 영속성 확인
  server = start(); await up();
  try {
    const ocsp = await (await get('/v1/ocsp/' + serial)).json();
    check(ocsp.data.status === 'GOOD', '재기동 후 인증서 영속(OCSP=GOOD)');
    const ver = await (await get('/v1/verify/' + global.__rid)).json();
    check(ver.data.status === 'COMPLETED', '재기동 후 서명요청 영속(COMPLETED)');
  } finally { server.kill(); }

  console.log('\n' + (failures === 0 ? '✅ Prisma 라이브 영속화 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
