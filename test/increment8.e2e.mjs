// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 8 e2e: 감사추적인증서 (PAdES 서명 PDF) — FR-05 / design §10
 * 서비스가 감사추적 요약 PDF를 생성하고 실 X.509로 PAdES 서명 → 다운로드.
 * 실행: npm run build && node test/increment8.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const PORT = 4800;
const B = `http://localhost:${PORT}`;
const KEY = 'auditcert-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 15).toString('base64') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await get('/v1/crl')).ok) break; } catch {} await sleep(400); }
    const docHash = createHash('sha256').update('동의서-auditcert').digest('hex');

    const pat = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=AuditPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const req = await (await post('/v1/requests', { idempotencyKey: 'ac-1', externalDocId: 'cf-ac', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: pat.data.serialNumber, requiredIdentityLevel: 'INPERSON' }] })).json();
    await post('/v1/sign/' + req.data.participants[0].participantId + '/submit', {});

    console.log('\n[감사추적인증서 PAdES PDF — FR-05]');
    const res = await get('/v1/requests/' + req.data.requestId + '/audit-certificate');
    check(res.ok, `인증서 다운로드 응답 (${res.status})`);
    check((res.headers.get('content-type') || '').includes('application/pdf'), 'Content-Type application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    const out = '/tmp/audit-certificate.pdf';
    writeFileSync(out, buf);
    const s = buf.toString('latin1');
    check(s.startsWith('%PDF'), `유효한 PDF 헤더 → ${out} (${buf.length} bytes)`);
    check(s.includes('/ByteRange'), 'PAdES /ByteRange 존재(서명됨)');
    check(/\/Contents\s*</.test(s), '/Contents(PKCS#7 임베드) 존재');
    check(s.includes('ETSI.CAdES.detached') || s.includes('adbe.pkcs7.detached'), 'PAdES/CAdES SubFilter');
    const loaded = await PDFDocument.load(buf, { ignoreEncryption: true }).catch(() => null);
    check(loaded !== null && loaded.getPageCount() >= 1, `렌더 가능한 PDF (pages=${loaded?.getPageCount?.() ?? 0})`);

    console.log('\n' + (failures === 0 ? '✅ Increment 8 전체 통과 — 서비스가 실 PAdES 인증서 생성' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
