// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * ERP 다자 봉투 — PORTAL + STAFF 혼합 채널 순차 서명 e2e (e-sign #6 합동 검증 sign측 절반).
 *  - 한 봉투에 PORTAL(외부 거래처, order1) + STAFF SSO(병원 결재자, order2) 혼합.
 *  - per-signer certSerial(STAFF) 바인딩 + per-signer portalUrl(PORTAL만) 반환.
 *  - 순차 게이팅(order2 STAFF 먼저=409), 전원 서명 시 단일 request.completed.
 *  - signatures[] echo: 두 채널 모두 externalSignerRef·certSerial·signedAt·tsaToken + 최상위 assuranceLevel·auditCertUri.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const PORT = 4802, HOOK = 4803, B = `http://127.0.0.1:${PORT}`;
const K = 'k', ISSUER = 'hospitalrun', STAFF_SUB = 'staff-ceo-1';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'x-api-key': K };
const post = (p, b, hdr = H) => fetch(B + p, { method: 'POST', headers: hdr, body: JSON.stringify(b ?? {}) });
const dh = (s) => createHash('sha256').update(s).digest('hex');
const tokenOf = (url) => url.split('/portal/')[1];

const received = [];
const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { received.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); }); });

let privateKey;
function start(jwks) {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: K, HIS_WEBHOOK_SECRET: 'whs',
      HIS_SSO_JWKS_JSON: jwks, HIS_SSO_ISSUER: ISSUER, CRYPTO_MASTER_KEY: Buffer.alloc(32, 53).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ ERP 다자 봉투 — PORTAL+STAFF 혼합 e2e ══════\n');
  // HIS SSO 키쌍 + JWKS(병원이 발급, sign이 검증)
  const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
  privateKey = pk;
  const jwk = await exportJWK(publicKey); jwk.kid = 'his-key-1'; jwk.alg = 'RS256';
  const jwks = JSON.stringify({ keys: [jwk] });

  await new Promise((r) => hookSrv.listen(HOOK, r));
  const app = start(jwks);
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hookSrv.close(); process.exit(1); }
  try {
    // STAFF 인증서 사전 발급(HIS가 온보딩 시 대행 → certSerial 확보)
    const staffEnroll = await (await post('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=병원장', identity: { method: 'STAFF_SSO' }, licenseNumber: 'MD-CEO' })).json();
    const staffSerial = staffEnroll.data.serialNumber;
    check(!!staffSerial, `STAFF 인증서 발급(certSerial=${staffSerial?.slice(0, 10)}…)`);

    // 혼합 봉투 — PORTAL(거래처, order1) + STAFF(병원장, order2, certSerial 바인딩)
    const r = await post('/v1/sign-requests', {
      documentType: 'ERP_OUTSOURCING_CONTRACT', documentHash: dh('mixed-contract'), issueNo: 'ERP-MIX-1',
      externalDocId: 'erpcontract:mixed:7', callbackUrl: `http://127.0.0.1:${HOOK}/hook`,
      signers: [
        { signerType: 'WITNESS_EXTERNAL', channel: 'PORTAL', displayName: '거래처대표', signOrder: 1, externalSignerRef: 'erp:vendor:1', requiredIdentityLevel: 'NONE' },
        { signerType: 'STAFF', channel: 'STAFF', displayName: '병원장', signOrder: 2, externalSignerRef: STAFF_SUB, certSerial: staffSerial, requiredIdentityLevel: 'STAFF_SSO' },
      ],
    });
    const d = (await r.json()).data;
    check(r.status === 201 && d.signers?.length === 2, `혼합 봉투 생성 — signers ${d.signers?.length}명`);
    // per-signer channel/portalUrl: PORTAL은 deep-link, STAFF는 portalUrl 없음(SSO 채널)
    check(d.signers[0].channel === 'PORTAL' && d.signers[0].portalUrl?.includes('/portal/'), 'order1 PORTAL → deep-link 발급');
    check(d.signers[1].channel === 'STAFF' && !d.signers[1].portalUrl, 'order2 STAFF → portalUrl 없음(SSO 채널)');
    const t1 = tokenOf(d.signers[0].portalUrl);
    const staffPid = d.signers[1].participantId;

    // 유효 STAFF SSO 토큰(sub=externalSignerRef, aud=sign)
    const jwt = await new SignJWT({ role: 'CEO', employee_number: 'E-CEO', sign_cert_serial: staffSerial })
      .setProtectedHeader({ alg: 'RS256', kid: 'his-key-1' })
      .setIssuer(ISSUER).setAudience('sign').setSubject(STAFF_SUB).setIssuedAt().setExpirationTime('5m').sign(privateKey);

    // 순차 게이팅 — order2(STAFF) 먼저 → 409
    const early = await post('/v1/sign/staff', { participantId: staffPid }, { 'Content-Type': 'application/json', authorization: 'Bearer ' + jwt });
    check(early.status === 409, '순서 위반(order2 STAFF 먼저) → 409');

    // order1 PORTAL 서명(NONE 무인증) → IN_PROGRESS
    const s1 = (await (await post(`/v1/portal/${t1}/sign`, {}, { 'Content-Type': 'application/json' })).json()).data;
    check(s1.requestStatus === 'IN_PROGRESS', 'order1(거래처 PORTAL) 서명 → IN_PROGRESS');

    // order2 STAFF SSO 서명 → COMPLETED
    const s2 = (await (await post('/v1/sign/staff', { participantId: staffPid }, { 'Content-Type': 'application/json', authorization: 'Bearer ' + jwt })).json()).data;
    check(s2?.requestStatus === 'COMPLETED', `order2(병원장 STAFF SSO) 서명 → COMPLETED (${s2?.requestStatus})`);
    check(s2?.staffSub === STAFF_SUB, 'STAFF SSO sub↔externalSignerRef 바인딩');

    // 단일 request.completed + signatures[] echo(두 채널 혼합)
    await sleep(800);
    const done = received.filter((h) => h.requestId === d.signatureRequestId && h.status === 'COMPLETED');
    check(done.length === 1, `단일 request.completed webhook(${done.length}건)`);
    const w = done[0] ?? {};
    check(Array.isArray(w.signatures) && w.signatures.length === 2, `signatures[] 2명(PORTAL+STAFF)`);
    const refs = (w.signatures ?? []).map((s) => s.externalSignerRef).sort();
    check(refs.join(',') === `erp:vendor:1,${STAFF_SUB}`, 'signatures[].externalSignerRef echo(거래처·병원장)');
    const staffSig = (w.signatures ?? []).find((s) => s.externalSignerRef === STAFF_SUB);
    check(staffSig?.certSerial === staffSerial, 'STAFF 원소 certSerial 바인딩 echo(HIS 주입 serial)');
    check((w.signatures ?? []).every((s) => s.certSerial && s.tsaToken && s.signedAt), 'signatures[] certSerial·tsaToken·signedAt');
    check(!!w.auditCertUri && !!w.assuranceLevel, `최상위 auditCertUri·assuranceLevel(assurance=${w.assuranceLevel})`);

    // 전체 검증
    check((await (await fetch(`${B}/v1/verify/${d.signatureRequestId}`)).json()).data.overall === true, '전체 서명 검증 overall=true');
  } finally { app.kill(); hookSrv.close(); }
  console.log('\n' + (failures === 0 ? '✅ ERP 다자 PORTAL+STAFF 혼합 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
