// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 18 — HIS 친화 facade(POST /v1/sign-requests) + webhook 페이로드 보강.
 * HIS submitSignRequest 계약: 단일 호출로 (PATIENT 자동발급+) 서명요청, PORTAL이면 portalUrl.
 * 검증: PORTAL(자동발급·portalUrl·서명), DIRECT(자동발급), STAFF(certSerial 필수), 멱등(issueNo),
 *      완료 webhook 페이로드에 signatureRequestId·signCertSerial·auditCertUri 포함.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = 4722, HOOK = 4723;
const B = `http://localhost:${PORT}`, KEY = 'inc18-key', SECRET = 's18';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p)).json();

let lastHook = null;
const hook = createServer((req, res) => { let r = ''; req.on('data', c => r += c); req.on('end', () => { try { lastHook = JSON.parse(r); } catch {} res.writeHead(200); res.end('ok'); }); });

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, HIS_WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: 'https://sign.test', CRYPTO_MASTER_KEY: Buffer.alloc(32, 18).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
const H = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  console.log('\n══════ Increment 18 — HIS facade + webhook 보강 e2e ══════\n');
  await new Promise(r => hook.listen(HOOK, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hook.close(); process.exit(1); }
  try {
    // PORTAL: 자동 환자발급 + portalUrl + 서명
    const r1 = await (await post('/v1/sign-requests', { documentType: '검사 동의서', documentHash: H('p1'), channel: 'PORTAL', issueNo: 'ISS-1', requiredIdentityLevel: 'PASS', patientSigner: { name: '김환자', ci: 'CI1' } })).json();
    check(!!r1.data.signatureRequestId && r1.data.portalUrl?.startsWith('https://sign.test/portal/'), 'PORTAL: 단일호출 → signatureRequestId + portalUrl');
    const tok = r1.data.portalUrl.split('/portal/')[1];
    const psc = await fetch(B + '/v1/portal/' + tok + '/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: { method: 'PASS', ci: 'CI1', name: '김환자' } }) });
    check(psc.status === 201 || psc.status === 200, 'PORTAL 토큰으로 서명 성공');
    const v = (await getj('/v1/verify/' + r1.data.signatureRequestId)).data;
    check(v.overall === true, '검증 overall=true');

    // DIRECT: 자동발급(채널만 다름)
    const r2 = await (await post('/v1/sign-requests', { documentType: '처치 동의서', documentHash: H('p2'), channel: 'DIRECT', issueNo: 'ISS-2', patientSigner: { name: '이환자', ci: 'CI2' } })).json();
    check(!!r2.data.signatureRequestId && !r2.data.portalUrl, 'DIRECT: signatureRequestId(포털URL 없음)');

    // STAFF: certSerial 없으면 400
    const r3 = await post('/v1/sign-requests', { documentType: '판독보고서', documentHash: H('p3'), channel: 'STAFF', issueNo: 'ISS-3', externalSignerRef: 'rad-1' });
    check(r3.status === 400, 'STAFF: certSerial 없으면 400');

    // 멱등: 동일 issueNo 재호출 → 동일 requestId
    const r1b = await (await post('/v1/sign-requests', { documentType: '검사 동의서', documentHash: H('p1'), channel: 'PORTAL', issueNo: 'ISS-1', patientSigner: { name: '김환자', ci: 'CI1' } })).json();
    check(r1b.data.signatureRequestId === r1.data.signatureRequestId, '멱등: 동일 issueNo → 동일 signatureRequestId');

    // webhook 보강 — callbackUrl 있는 요청 완료 후 페이로드 확인
    const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=W', identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
    const wr = await (await post('/v1/requests', { idempotencyKey: 'i18w', externalDocId: 'cf', title: 't', documentHash: H('w'), signMode: 'APP', callbackUrl: `http://localhost:${HOOK}/wh`, participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }] })).json();
    await post('/v1/sign/' + wr.data.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    await sleep(500);
    check(!!lastHook?.eventId && lastHook.eventType === 'request.completed', 'webhook: eventId + type=request.completed');
    check(lastHook?.signatureRequestId === wr.data.requestId && !!lastHook?.signCertSerial, 'webhook 보강: signatureRequestId + signCertSerial');
    check(lastHook?.auditCertUri === 'https://sign.test/v1/requests/' + wr.data.requestId + '/audit-certificate', 'webhook 보강: auditCertUri');
  } finally { app.kill(); hook.close(); }
  console.log('\n' + (failures === 0 ? '✅ Increment 18 통과 — HIS facade + webhook 보강' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
