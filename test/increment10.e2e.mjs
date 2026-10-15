// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 10 e2e: 실 CMS(CAdES-BES) 서명코어 통합 — FR-02/20
 * 모든 서명이 실 X.509 + PKCS#7 CMS detached 서명으로 생성·검증됨.
 * 실행: npm run build && node test/increment10.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 5101;
const B = `http://localhost:${PORT}`;
const KEY = 'cms-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 19).toString('base64') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await get('/v1/crl')).ok) break; } catch {} await sleep(400); }
    const docHash = createHash('sha256').update('동의서-cms').digest('hex');

    const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=CmsPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const req = await (await post('/v1/requests', { idempotencyKey: 'cms-1', externalDocId: 'cf-cms', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: pat.data.serialNumber, requiredIdentityLevel: 'INPERSON' }] })).json();
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});

    console.log('\n[실 CMS(CAdES-BES) 서명코어 — FR-02/20]');
    const ver = await (await get('/v1/verify/' + req.data.requestId)).json();
    const s = ver.data.signatures[0];
    check(s.cmsValid === true, `CMS 검증 통과 cmsValid=true (${s.cmsValid})`);
    check(s.format === 'CAdES-BES (PKCS#7)', `서명 포맷 표준 CAdES-BES (${s.format})`);
    check(s.cryptoVerify === true && s.ltvValid === true, '자체 PKI 검증·LTV도 유지(병행)');
    check(ver.data.overall === true, '전체 검증 overall=true');
    console.log('  ℹ 서명자별 실 X.509 인증서 + PKCS#7 CMS detached 서명. signerInfo(authAttrs) + messageDigest + 체인 검증.');

    console.log('\n' + (failures === 0 ? '✅ Increment 10 전체 통과 — 실 CMS 서명코어 동작' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
