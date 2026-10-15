// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * C-2 문서 개정 재동의(supersede) e2e.
 *  - 개정 시 원본 status=SUPERSEDED·supersededBy, 신규 supersedes·version+1, 참가자 재사용.
 *  - 원본 서명 차단(409), 이미 개정된 원본 재개정 차단(409·최신본 안내), 멱등 재시도.
 *  - 다단계 개정(v1→v2→v3), request.superseded webhook, facade supersedesRequestId.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';

const PORT = 4778, B = `http://127.0.0.1:${PORT}`, HOOK = 4779;
const CON = 'con-k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'x-api-key': CON };
const post = (p, b) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p, { headers: H })).json();
const dh = (s) => createHash('sha256').update(s).digest('hex');

// webhook 수신기
const received = [];
const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { received.push(JSON.parse(b)); } catch {} res.writeHead(200); res.end('ok'); }); });

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: 'his-k', CONSOLE_API_KEY: CON,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 48).toString('base64'), HIS_WEBHOOK_SECRET: 'whsec', HIS_WEBHOOK_URL: `http://127.0.0.1:${HOOK}/hook` },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
async function enroll() { return (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=환자', identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber; }
const reqBody = (key, hash, serial) => ({ idempotencyKey: key, externalDocId: 'DOC-1', title: '수술 동의서', documentHash: hash, signMode: 'APP',
  participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '김환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] });

async function main() {
  console.log('\n══════ C-2 문서 개정 재동의(supersede) e2e ══════\n');
  await new Promise((r) => hookSrv.listen(HOOK, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hookSrv.close(); process.exit(1); }
  try {
    const ser = await enroll();
    const r1 = (await (await post('/v1/requests', reqBody('rev-1', dh('v1'), ser))).json()).data;
    check(r1.version === 1 && !r1.supersedes, `원본 R1 생성(version=${r1.version})`);

    // 개정 → R2
    const r2 = (await (await post(`/v1/requests/${r1.requestId}/supersede`, { idempotencyKey: 'rev-2', documentHash: dh('v2'), reason: '조건 변경' })).json()).data;
    check(r2.version === 2 && r2.supersedes === r1.requestId, `개정 R2(version=${r2.version}, supersedes=R1)`);
    check(r2.participants.length === 1 && r2.participants[0].certSerial === ser, '참가자 재사용(동일 certSerial)');

    // 원본 상태
    const r1after = (await getj(`/v1/requests/${r1.requestId}`)).data;
    check(r1after.status === 'SUPERSEDED' && r1after.supersededBy === r2.requestId, `원본 R1 → SUPERSEDED·supersededBy=R2`);

    // 원본 서명 차단
    const signR1 = await post(`/v1/sign/${r1.participants[0].participantId}/submit`, { identity: { method: 'PASS', ci: 'C' } });
    check(signR1.status === 409, '원본(SUPERSEDED) 서명 제출 → 409');

    // 이미 개정된 원본 재개정 차단(다른 키)
    const reSup = await post(`/v1/requests/${r1.requestId}/supersede`, { idempotencyKey: 'rev-x', documentHash: dh('vx') });
    check(reSup.status === 409, '이미 개정된 원본 재개정(다른 키) → 409');

    // 멱등: 동일 키 재시도 → 동일 R2
    const r2again = (await (await post(`/v1/requests/${r1.requestId}/supersede`, { idempotencyKey: 'rev-2', documentHash: dh('v2') })).json()).data;
    check(r2again.requestId === r2.requestId, '멱등 재시도(동일 키) → 동일 R2 반환');

    // 다단계: R2 → R3
    const r3 = (await (await post(`/v1/requests/${r2.requestId}/supersede`, { idempotencyKey: 'rev-3', documentHash: dh('v3') })).json()).data;
    check(r3.version === 3 && r3.supersedes === r2.requestId, `다단계 개정 R3(version=${r3.version}, supersedes=R2)`);
    const r2after = (await getj(`/v1/requests/${r2.requestId}`)).data;
    check(r2after.status === 'SUPERSEDED' && r2after.supersededBy === r3.requestId, 'R2 → SUPERSEDED·supersededBy=R3');

    // webhook request.superseded (R1·R2)
    await sleep(800);
    const supHooks = received.filter((h) => h.status === 'SUPERSEDED' || h.supersededBy);
    check(supHooks.some((h) => h.requestId === r1.requestId && h.supersededBy === r2.requestId), 'request.superseded webhook(R1→R2, supersededBy 포함)');

    // facade supersedesRequestId
    const fac = await (await post('/v1/sign-requests', { documentType: '마취 동의서', documentHash: dh('fac2'), channel: 'DIRECT', issueNo: 'FAC-REV-1', certSerial: ser, externalSignerRef: 'p', supersedesRequestId: r3.requestId })).json();
    check(!!fac.data?.signatureRequestId, 'facade supersedesRequestId → 새 버전 생성');
    const r3after = (await getj(`/v1/requests/${r3.requestId}`)).data;
    check(r3after.status === 'SUPERSEDED' && r3after.supersededBy === fac.data.signatureRequestId, 'facade 개정도 원본 R3 → SUPERSEDED');

    // 미존재 원본
    const nf = await post('/v1/requests/nope/supersede', { idempotencyKey: 'rev-nf', documentHash: dh('x') });
    check(nf.status === 404, '미존재 원본 개정 → 404');
  } finally { app.kill(); hookSrv.close(); }
  console.log('\n' + (failures === 0 ? '✅ C-2 supersede 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
