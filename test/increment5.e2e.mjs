// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 5 e2e: API Key 인증(ConsumerApp) — FR-11
 * 실행: npm run build && node test/increment5.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4311; // 라운드 포트(x00) 금지 — CI 러너 상주 서비스와 충돌(increment4 참조)
const B = `http://localhost:${PORT}`;
const API_KEY = 'valid-key-123';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enroll = (headers) => fetch(B + '/v1/certificates/enroll', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=인증테스트', identity: { method: 'PASS', ci: 'C' } }),
});

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: API_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { try { up = (await fetch(B + '/v1/crl')).ok; } catch {} if (!up) await sleep(300); }
    if (!up) throw new Error(`sign 서버 미기동(포트 ${PORT} 점유 또는 기동 실패)`);

    console.log('\n[API Key 인증 — FR-11]');
    const noKey = await enroll({});
    check(noKey.status === 401, `키 없음 → 401 (${noKey.status})`);
    const noKeyBody = await noKey.json();
    check(noKeyBody.error?.code === 'UNAUTHORIZED', `에러코드 UNAUTHORIZED (${noKeyBody.error?.code})`);

    const wrongKey = await enroll({ 'x-api-key': 'wrong-key' });
    check(wrongKey.status === 401, `잘못된 키 → 401 (${wrongKey.status})`);

    const validKey = await enroll({ 'x-api-key': API_KEY });
    check(validKey.status === 201 || validKey.status === 200, `유효한 키 → 발급 성공 (${validKey.status})`);

    // 공개 엔드포인트(검증/CRL)는 키 없이 접근 가능
    const crl = await fetch(B + '/v1/crl');
    check(crl.ok, '공개 엔드포인트(CRL)는 키 없이 접근 가능');

    console.log('\n' + (failures === 0 ? '✅ Increment 5 전체 통과' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
