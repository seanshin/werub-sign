// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * EXTERNAL 계약 셀프검증 — HIS/PACS에 확약한 계약(handoff 4건)을 그 형태로 검증.
 * 골든 레퍼런스: sign-requests(facade)·enroll(비멱등)·webhook(externalSignerRef)·verify(assuranceLevel).
 *
 * mock HIS: JWKS 공개 + webhook 전체 페이로드 캡처. sign: HIS_WEBHOOK_URL 전역 기본으로 facade도 발화.
 * 실행: npm run build && node test/external-contract.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const SIGN_PORT = 4640, HIS_PORT = 9640;
const SIGN = `http://localhost:${SIGN_PORT}`;
const HIS = `http://localhost:${HIS_PORT}`;
const API_KEY = 'ext-key';
const WEBHOOK_SECRET = 'ext-webhook-secret';
const ISSUER = 'hospitalrun';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sapi = (p, b, h = {}) => fetch(SIGN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, ...h }, body: JSON.stringify(b ?? {}) });
const sget = (p) => fetch(SIGN + p);
const hash = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  console.log('\n══════ EXTERNAL 계약 셀프검증 ══════\n');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'his-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const webhooks = new Map(); // externalDocId -> 전체 payload

  const his = http.createServer((req, res) => {
    if (req.url === '/jwks') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (req.method === 'POST' && req.url === '/webhook') {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        const sig = req.headers['x-sign-signature'];
        const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
        if (sig !== expected) { res.writeHead(401); return res.end('bad sig'); }
        const evt = JSON.parse(body);
        webhooks.set(evt.externalDocId, evt);
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => his.listen(HIS_PORT, r));

  const server = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(SIGN_PORT), HIS_INBOUND_API_KEY: API_KEY, HIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HIS_WEBHOOK_URL: `${HIS}/webhook`, // 전역 기본 — facade도 webhook 발화(요청별 callbackUrl 불요)
      HIS_SSO_JWKS_URL: `${HIS}/jwks`, HIS_SSO_ISSUER: ISSUER,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
    }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 30; i++) { try { if ((await sget('/v1/crl')).ok) break; } catch {} await sleep(300); }

    // ── #2 enroll STAFF 비멱등(재사용 규칙) ──
    console.log('#2 enroll STAFF 계약(비멱등)');
    const e1 = await (await sapi('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=의사,O=병원,C=KR', licenseNumber: 'MD-1', identity: { method: 'STAFF_SSO' } })).json();
    const e2 = await (await sapi('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=의사,O=병원,C=KR', licenseNumber: 'MD-1', identity: { method: 'STAFF_SSO' } })).json();
    check(!!e1.data?.serialNumber, 'STAFF enroll → serialNumber 반환');
    check(e1.data.serialNumber !== e2.data.serialNumber, '비멱등 — 재호출 시 새 serial(HIS는 1회만 enroll·serial 영속)');
    check(e1.data.assuranceLevel === 'SOFTWARE' && e1.data.caKeyCustody === 'SOFT', 'enroll 응답에 assuranceLevel(SOFT 운영=SOFTWARE)');

    // ── #1 facade DIRECT(PATIENT 자동 enroll) + #3 webhook + verify ──
    console.log('\n#1 sign-requests DIRECT(PATIENT 자동발급) + #3 webhook + verify');
    const docA = hash('동의서-DIRECT');
    const fr = await (await sapi('/v1/sign-requests', {
      documentType: '조영제 동의서', documentHash: docA, channel: 'DIRECT', issueNo: 'EXT-DIRECT-1',
      requiredIdentityLevel: 'PASS', externalSignerRef: 'patient-ref-1', patientSigner: { name: '홍길동', ci: 'CI-홍' },
    })).json();
    check(!!fr.data?.signatureRequestId && !!fr.data?.participantId, 'facade 응답: signatureRequestId·participantId');
    await sapi(`/v1/sign/${fr.data.participantId}/submit`, { identity: { method: 'PASS', ci: 'CI-홍' } });
    await sleep(400);
    const wh = webhooks.get('EXT-DIRECT-1');
    check(!!wh, 'facade 경로도 webhook 발화(HIS_WEBHOOK_URL 전역 기본)');
    check(wh?.verifiedHash === docA, 'webhook verifiedHash = documentHash');
    check(!!wh?.signCertSerial && Array.isArray(wh?.signCertSerials), 'webhook signCertSerial(+s) 포함');
    check(wh?.assuranceLevel === 'SOFTWARE', `webhook assuranceLevel=SOFTWARE (KMS 시 HSM_ANCHORED) (${wh?.assuranceLevel})`);
    check(wh?.signatures?.[0]?.externalSignerRef === 'patient-ref-1', 'webhook signatures[].externalSignerRef(미러 매핑키)');
    check(wh?.signatures?.[0]?.keyCustody === 'SOFT', 'webhook signatures[].keyCustody');
    check(!!wh?.signatures?.[0]?.tsaToken, 'webhook signatures[].tsaToken(증거 봉인)');

    const verA = await (await sget(`/v1/verify/${fr.data.signatureRequestId}`)).json();
    check(verA.data?.overall === true, 'verify overall=true');
    check(verA.data?.assuranceLevel === 'SOFTWARE' && verA.data?.caKeyCustody === 'SOFT', 'verify에 assuranceLevel·caKeyCustody 포함');
    check(verA.data?.signatures?.[0]?.keyCustody === 'SOFT', 'verify signatures[].keyCustody');

    // ── #1 facade PORTAL(portalUrl) ──
    console.log('\n#1 sign-requests PORTAL(portalUrl)');
    const fp = await (await sapi('/v1/sign-requests', {
      documentType: '영상 동의서', documentHash: hash('동의서-PORTAL'), channel: 'PORTAL', issueNo: 'EXT-PORTAL-1',
      patientSigner: { name: '김환자', ci: 'CI-김' },
    })).json();
    check(typeof fp.data?.portalUrl === 'string' && fp.data.portalUrl.includes('/portal/'), 'PORTAL 응답에 portalUrl(환자 deep-link)');

    // ── #1 facade STAFF + SSO → webhook externalSignerRef(직원) ──
    console.log('\n#1 sign-requests STAFF + SSO(보고서 A) → webhook 직원 식별');
    const staffSerial = e1.data.serialNumber;
    const fs = await (await sapi('/v1/sign-requests', {
      documentType: '판독보고서', documentHash: hash('보고서-A'), channel: 'STAFF', issueNo: 'EXT-STAFF-1',
      certSerial: staffSerial, externalSignerRef: 'doctor-1', signerRole: 'DOCTOR',
    })).json();
    check(!!fs.data?.participantId, 'STAFF facade 요청 생성');
    const jwt = await new SignJWT({ role: 'DOCTOR', employee_number: 'E-1', sign_cert_serial: staffSerial, acr: 'urn:inperson' })
      .setProtectedHeader({ alg: 'RS256', kid: 'his-1' }).setIssuer(ISSUER).setAudience('sign').setSubject('doctor-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const ss = await (await sapi('/v1/sign/staff', { participantId: fs.data.participantId }, { authorization: `Bearer ${jwt}` })).json();
    check(ss.data?.requestStatus === 'COMPLETED' || ss.data?.staffSub === 'doctor-1', `STAFF SSO 서명 완료 (${ss.data?.requestStatus})`);
    await sleep(400);
    const whS = webhooks.get('EXT-STAFF-1');
    check(whS?.signatures?.[0]?.externalSignerRef === 'doctor-1', 'STAFF webhook externalSignerRef=doctor-1(직원 매핑)');
    check(whS?.signatures?.[0]?.signerType === 'STAFF' && whS?.signatures?.[0]?.signerRole === 'DOCTOR', 'STAFF webhook signerType/signerRole');
  } finally {
    server.kill(); his.close(); await sleep(200);
  }
  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL(' + failures + ')'} — EXTERNAL 계약 셀프검증\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
