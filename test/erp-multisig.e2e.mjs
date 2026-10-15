// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * ERP 계약 다중봉투 순차 서명 e2e (facade signers[]).
 *  - 단일 호출 signers[](신원·순서·채널) → 다수 참가자 fan-out + PORTAL deep-link 발급.
 *  - 신규입사 의료진(HIS 미등록·certSerial 없음) 자동 임시 인증서 → PORTAL 서명.
 *  - 순차 게이팅(order2 먼저=409), 전 봉투 완료 시 단일 request.completed.
 *  - webhook signatures[] echo: externalSignerRef·certSerial·tsaToken + assuranceLevel·auditCertUri.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';

const PORT = 4798, HOOK = 4799, B = `http://127.0.0.1:${PORT}`;
const K = 'k';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'x-api-key': K };
const post = (p, b, hdr = H) => fetch(B + p, { method: 'POST', headers: hdr, body: JSON.stringify(b ?? {}) });
const dh = (s) => createHash('sha256').update(s).digest('hex');
const tokenOf = (url) => url.split('/portal/')[1];

const received = [];
const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { received.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); }); });

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: K, HIS_WEBHOOK_SECRET: 'whs', CRYPTO_MASTER_KEY: Buffer.alloc(32, 51).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ ERP 계약 다중봉투 순차 서명 e2e ══════\n');
  await new Promise((r) => hookSrv.listen(HOOK, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hookSrv.close(); process.exit(1); }
  try {
    // 다중봉투 제출 — 거래처(order1) + 신규입사 의료진(order2, HIS 미등록·certSerial 없음)
    const r = await post('/v1/sign-requests', {
      documentType: 'ERP_OUTSOURCING_CONTRACT', documentHash: dh('contract'), issueNo: 'ERP-MS-1',
      externalDocId: 'erpcontract:medical:42', callbackUrl: `http://127.0.0.1:${HOOK}/hook`,
      signers: [
        { signerType: 'WITNESS_EXTERNAL', channel: 'PORTAL', displayName: '거래처대표', signOrder: 1, externalSignerRef: 'erp:vendor:1', requiredIdentityLevel: 'NONE' },
        { signerType: 'WITNESS_EXTERNAL', channel: 'PORTAL', displayName: '신규의사', signOrder: 2, externalSignerRef: 'erp:newstaff:1', requiredIdentityLevel: 'NONE' },
      ],
    });
    const d = (await r.json()).data;
    check(r.status === 201 && d.signatureRequestId && d.signers?.length === 2, `다중봉투 생성 — signers ${d.signers?.length}명`);
    check(d.signers.every((s) => s.portalUrl?.includes('/portal/')), '각 PORTAL 서명자 deep-link 발급');
    check(d.signers[0].externalSignerRef === 'erp:vendor:1' && d.signers[1].externalSignerRef === 'erp:newstaff:1', 'signOrder 순 정렬·externalSignerRef echo');
    const t1 = tokenOf(d.signers[0].portalUrl), t2 = tokenOf(d.signers[1].portalUrl);

    // 순차 게이팅 — order2 먼저 → 409
    check((await post(`/v1/portal/${t2}/sign`, {}, { 'Content-Type': 'application/json' })).status === 409, '순서 위반(order2 먼저) → 409');
    // order1 서명 → IN_PROGRESS
    const s1 = (await (await post(`/v1/portal/${t1}/sign`, {}, { 'Content-Type': 'application/json' })).json()).data;
    check(s1.requestStatus === 'IN_PROGRESS', 'order1(거래처) 서명 → IN_PROGRESS(미완료)');
    // order2(신규의사) 서명 → COMPLETED
    const s2 = (await (await post(`/v1/portal/${t2}/sign`, {}, { 'Content-Type': 'application/json' })).json()).data;
    check(s2.requestStatus === 'COMPLETED', 'order2(신규의사) 서명 → COMPLETED(전 봉투 완료)');

    // 단일 request.completed webhook + echo
    await sleep(800);
    const done = received.filter((h) => h.requestId === d.signatureRequestId && h.status === 'COMPLETED');
    check(done.length === 1, `단일 request.completed webhook(${done.length}건)`);
    const w = done[0];
    check(Array.isArray(w.signatures) && w.signatures.length === 2, `signatures[] 2명`);
    const refs = (w.signatures ?? []).map((s) => s.externalSignerRef).sort();
    check(refs.join(',') === 'erp:newstaff:1,erp:vendor:1', 'signatures[].externalSignerRef echo(거래처·신규의사)');
    check(w.signatures.every((s) => s.certSerial && s.tsaToken && s.signedAt), 'signatures[] certSerial·tsaToken·signedAt 동봉');
    check(!!w.auditCertUri && !!w.assuranceLevel, `auditCertUri·assuranceLevel 동봉(assurance=${w.assuranceLevel})`);

    // 검증
    check((await (await fetch(`${B}/v1/verify/${d.signatureRequestId}`)).json()).data.overall === true, '전체 서명 검증 overall=true');
  } finally { app.kill(); hookSrv.close(); }
  console.log('\n' + (failures === 0 ? '✅ ERP 다중봉투 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
