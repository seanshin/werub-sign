// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * CSV 내보내기 e2e (P0-2 심사·보존).
 *  - GET /v1/requests/export.csv·/v1/certificates/export.csv·/v1/admin/notifications/export.csv
 *  - content-type=text/csv·attachment·UTF-8 BOM·헤더행, 필터 반영, 무권한 401.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4806, B = `http://127.0.0.1:${PORT}`;
const K = 'k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'x-api-key': K };
const post = (p, b) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const dh = (s) => createHash('sha256').update(s).digest('hex');

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: K, CRYPTO_MASTER_KEY: Buffer.alloc(32, 61).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function enroll(dn) { return (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: dn, identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber; }
async function mkReq(title, docId) {
  const s = await enroll('CN=' + title);
  return post('/v1/requests', { idempotencyKey: 'csv-' + docId, externalDocId: docId, title, documentHash: dh(docId), signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: title + '환자', signOrder: 1, certSerial: s }] });
}

async function main() {
  console.log('\n══════ CSV 내보내기 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    await mkReq('수술동의서', 'csv-doc-1');
    await mkReq('마취동의서', 'csv-doc-2');

    // 요청 CSV — BOM은 raw 바이트로 검사(text()가 선두 BOM 제거함)
    let res = await fetch(B + '/v1/requests/export.csv', { headers: { 'x-api-key': K } });
    const buf = new Uint8Array(await res.arrayBuffer());
    let body = new TextDecoder('utf-8').decode(buf);
    check(res.status === 200, '요청 export.csv 200');
    check((res.headers.get('content-type') || '').includes('text/csv'), 'content-type=text/csv');
    check((res.headers.get('content-disposition') || '').includes('attachment'), 'content-disposition=attachment');
    check(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'UTF-8 BOM 선두(EF BB BF)');
    const lines = body.replace(/^﻿/, '').trim().split('\r\n');
    check(lines[0].includes('요청ID') && lines[0].includes('생성일'), '헤더행(요청ID·생성일)');
    check(lines.length === 3, `데이터 2행 + 헤더 = 3줄 (=${lines.length})`); // 2 요청
    check(body.includes('수술동의서') && body.includes('마취동의서'), '요청 제목 포함');

    // 필터(q) 반영
    res = await fetch(B + '/v1/requests/export.csv?q=' + encodeURIComponent('마취'), { headers: { 'x-api-key': K } });
    body = await res.text();
    const flines = body.replace(/^﻿/, '').trim().split('\r\n');
    check(flines.length === 2 && body.includes('마취동의서') && !body.includes('수술동의서'), 'q=마취 필터 반영(1행)');

    // 인증서 CSV
    res = await fetch(B + '/v1/certificates/export.csv', { headers: { 'x-api-key': K } });
    body = await res.text();
    check(res.status === 200 && body.replace(/^﻿/, '').split('\r\n')[0].includes('시리얼'), '인증서 export.csv 헤더(시리얼)');

    // 발송 이력 CSV(빈 목록도 헤더)
    res = await fetch(B + '/v1/admin/notifications/export.csv', { headers: { 'x-api-key': K } });
    body = await res.text();
    check(res.status === 200 && body.replace(/^﻿/, '').split('\r\n')[0].includes('수신(마스킹)'), '발송이력 export.csv 헤더(마스킹)');

    // 무권한(키 없음) 401
    check((await fetch(B + '/v1/requests/export.csv')).status === 401, '무권한 export → 401');
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ CSV 내보내기 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
