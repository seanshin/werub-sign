// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 9 e2e: 모든 서명자에게 실 X.509 인증서 발급 (서명코어 표준화 1단계)
 * 실행: npm run build && node test/increment9.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import forge from 'node-forge';

const PORT = 4900;
const B = `http://localhost:${PORT}`;
const KEY = 'x509-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 17).toString('base64') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await get('/v1/crl')).ok) break; } catch {} await sleep(400); }

    console.log('\n[실 X.509 인증서 발급·조회 — 표준]');
    const enr = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=X509Patient', identity: { method: 'PASS', ci: 'C' } })).json();
    check(!!enr.data.x509Serial, `발급 응답에 x509Serial 포함 (${enr.data.x509Serial})`);
    const serial = enr.data.serialNumber;

    const x = await (await get(`/v1/certificates/${serial}/x509`)).json();
    check(typeof x.data.certPem === 'string' && x.data.certPem.includes('BEGIN CERTIFICATE'), '실 X.509 PEM 반환');

    // node-forge로 PEM 파싱 + 체인 검증
    let parseOk = false, chainOk = false, subjectOk = false;
    try {
      const leaf = forge.pki.certificateFromPem(x.data.certPem);
      parseOk = true;
      subjectOk = leaf.subject.getField('CN')?.value === 'CN=X509Patient' || leaf.subject.getField('CN')?.value === 'X509Patient';
      // 체인 PEM에서 issuing/root 추출
      const chainPems = x.data.chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      const [issuing, root] = chainPems.map((p) => forge.pki.certificateFromPem(p));
      const caStore = forge.pki.createCaStore([root]);
      chainOk = forge.pki.verifyCertificateChain(caStore, [leaf, issuing]);
    } catch (e) { /* parse fail */ }
    check(parseOk, 'X.509 PEM 파싱 성공 (node-forge)');
    check(subjectOk, 'subject CN 일치');
    check(chainOk, '실 X.509 체인 검증 (Leaf→Issuing→Root)');

    console.log('\n' + (failures === 0 ? '✅ Increment 9 전체 통과 — 서명자별 실 X.509 발급' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
