// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 11 e2e: 감사 무결성 — 해시체인 + TSA 앵커링 — FR-21 / design §16
 * 완료 시 체인 head를 TSA로 봉인. 검증 API로 무결성 확인.
 * 실행: npm run build && node test/increment11.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 5102;
const B = `http://localhost:${PORT}`;
const KEY = 'anchor-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 23).toString('base64') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await get('/v1/crl')).ok) break; } catch {} await sleep(400); }
    const docHash = createHash('sha256').update('동의서-anchor').digest('hex');

    const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=AnchorPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const req = await (await post('/v1/requests', { idempotencyKey: 'an-1', externalDocId: 'cf-an', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: pat.data.serialNumber, requiredIdentityLevel: 'INPERSON' }] })).json();

    console.log('\n[감사 무결성 — 해시체인 + TSA 앵커 (FR-21)]');
    // 완료 전: 미앵커
    const before = await (await get('/v1/requests/' + req.data.requestId + '/audit/verify')).json();
    check(before.data.chainValid === true && before.data.anchored === false, '완료 전: 체인 유효·미앵커');

    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
    // 완료 후: 앵커 봉인됨
    const after = await (await get('/v1/requests/' + req.data.requestId + '/audit/verify')).json();
    const d = after.data;
    check(d.chainValid === true, '해시체인 유효');
    check(d.anchored === true, '완료 시 TSA 앵커 봉인됨');
    check(d.anchorTsValid === true, 'TSA 토큰 유효(앵커 head 시점 봉인)');
    check(d.anchorMatchesChain === true, '앵커 head == 체인 해당지점(위변조 미발생)');
    check(d.valid === true, '감사 무결성 전체 valid=true');
    console.log('  ℹ TSA-봉인 head가 고정 기준점 → 내부자가 전체 체인 재계산해도 앵커 불일치로 탐지');

    console.log('\n' + (failures === 0 ? '✅ Increment 11 전체 통과 — 감사 TSA 앵커링 동작' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
