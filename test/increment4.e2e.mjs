// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 4 e2e: 정합 갭 보강 검증
 *  - 전역 에러 포맷 {error:{code,message,requestId}}
 *  - cert 발급/폐기 감사 (CERT_ISSUED/CERT_REVOKED) + 해시체인
 *  - 파일 durable 저장소: 서버 재기동 후 데이터 보존
 * 실행: npm run build && node test/increment4.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 4211; // 라운드 포트(x00) 금지 — CI 러너 상주 서비스가 3000~4200을 점유(2026-08 실측)
const B = `http://localhost:${PORT}`;
const STORE_FILE = '/tmp/sign-store-e2e.json';
const API_KEY = 'test-api-key';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

function startServer() {
  const s = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), STORE_DRIVER: 'file', STORE_FILE, HIS_INBOUND_API_KEY: API_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') },
    stdio: 'ignore',
  });
  return s;
}
// fail-fast: 미기동인 채 진행하면 포트 선점자의 404 가 뒤섞여 원인이 가려진다
async function waitUp() { for (let i = 0; i < 30; i++) { try { if ((await get('/v1/crl')).ok) return; } catch {} await sleep(300); } throw new Error(`sign 서버 미기동(포트 ${PORT} 점유 또는 기동 실패)`); }

async function main() {
  try { rmSync(STORE_FILE, { force: true }); } catch {}

  // ── 1차 기동 (file store) ──
  let server = startServer();
  await waitUp();
  let serial;
  try {
    console.log('\n[A] 전역 에러 포맷');
    const bad = await post('/v1/requests', { idempotencyKey: 'x', externalDocId: 'd', title: 't', documentHash: 'short', signMode: 'APP', participants: [] });
    const body = await bad.json();
    check(bad.status === 400, `잘못된 입력 → 400 (${bad.status})`);
    check(body.error && body.error.code === 'INVALID_REQUEST', `error.code=INVALID_REQUEST (${body.error?.code})`);
    check(typeof body.error?.message === 'string' && typeof body.error?.requestId === 'string', 'error.{message,requestId} 포함');

    const notFound = await (await get('/v1/requests/nonexistent')).json();
    check(notFound.error?.code === 'NOT_FOUND', `404 → NOT_FOUND (${notFound.error?.code})`);

    console.log('\n[B] cert 발급/폐기 감사 (CERT_ISSUED/REVOKED 해시체인)');
    const enr = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=감사테스트', identity: { method: 'PASS', ci: 'C' } })).json();
    serial = enr.data.serialNumber;
    let audit = await (await get(`/v1/certificates/${serial}/audit`)).json();
    check(audit.data.length === 1 && audit.data[0].eventType === 'CERT_ISSUED', `발급 후 CERT_ISSUED 기록 (${audit.data[0]?.eventType})`);
    await post(`/v1/certificates/${serial}/revoke`, { reason: 'keyCompromise' });
    audit = await (await get(`/v1/certificates/${serial}/audit`)).json();
    check(audit.data.length === 2 && audit.data[1].eventType === 'CERT_REVOKED', `폐기 후 CERT_REVOKED 기록 (${audit.data[1]?.eventType})`);
    check(audit.data[1].prevHash === audit.data[0].entryHash, '감사 해시체인 연결(prevHash=직전 entryHash)');
  } finally {
    server.kill();
    await sleep(500);
  }

  // ── 2차 기동 (동일 파일) — durability 확인 ──
  console.log('\n[C] 파일 durable 저장소: 재기동 후 데이터 보존');
  server = startServer();
  await waitUp();
  try {
    const ocsp = await (await get('/v1/ocsp/' + serial)).json();
    check(ocsp.data.status === 'REVOKED', `재기동 후 폐기상태 보존 OCSP=REVOKED (${ocsp.data.status})`);
    const audit = await (await get(`/v1/certificates/${serial}/audit`)).json();
    check(audit.data.length === 2, `재기동 후 감사기록 보존 (${audit.data.length}건)`);
  } finally {
    server.kill();
  }

  console.log('\n' + (failures === 0 ? '✅ Increment 4 전체 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
