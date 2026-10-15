// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 7 e2e: PAdES-LTA 장기검증(LTV) — FR-20 / design §10
 * 서명에 인증서체인+OCSP+아카이브TS 봉인 → 인증서 만료 무관 self-contained 검증.
 * 실행: npm run build && node test/increment7.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4511; // 라운드 포트(x00) 금지 — CI 러너 상주 서비스와 충돌(increment4 참조)
const B = `http://localhost:${PORT}`;
const KEY = 'ltv-key';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 4).toString('base64') },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { try { up = (await get('/v1/crl')).ok; } catch {} if (!up) await sleep(300); }
    if (!up) throw new Error(`sign 서버 미기동(포트 ${PORT} 점유 또는 기동 실패)`);
    const docHash = createHash('sha256').update('동의서-ltv').digest('hex');

    const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=LTV환자', identity: { method: 'PASS', ci: 'C' } })).json();
    const req = await (await post('/v1/requests', {
      idempotencyKey: 'ltv-1', externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP',
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: pat.data.serialNumber, requiredIdentityLevel: 'INPERSON' }],
    })).json();
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});

    console.log('\n[PAdES-LTA LTV 검증]');
    const ver = await (await get('/v1/verify/' + req.data.requestId)).json();
    const s = ver.data.signatures[0];
    check(typeof s.format === 'string' && (s.format.includes('PAdES') || s.format.includes('CAdES')), `표준 서명 포맷 (${s.format})`);
    check(s.ltvValid === true, `LTV 검증 통과 ltvValid=true (${s.ltvValid})`);
    check(s.cryptoVerify === true && s.chainValid === true, '기본 서명·체인 검증 통과');
    check(ver.data.overall === true, '전체 검증 overall=true');
    console.log('  ℹ LTV는 봉인된 체인+OCSP+아카이브TS로 자체검증 → 인증서 만료 후에도 유효(notExpired와 독립)');

    console.log('\n' + (failures === 0 ? '✅ Increment 7 전체 통과' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
