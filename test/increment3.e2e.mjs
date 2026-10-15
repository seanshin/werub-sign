// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 3 e2e: 폐기(CRL/OCSP) + STAFF SSO(JWKS) + Webhook(Outbox)
 * 실행: node test/increment3.e2e.mjs  (사전: npm run build)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const B = 'http://localhost:4199';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ISSUER = 'hospitalrun';
const API_KEY = 'test-api-key';
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, ...headers }, body: JSON.stringify(body ?? {}) });
const get = (p) => fetch(B + p);
const sha256hex = (s) => createHmac('sha256', '').update(s).digest('hex'); // not used; placeholder

async function main() {
  // 1) HIS SSO 키쌍 + JWKS (HIS가 발급, sign이 JWKS로 검증)
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'his-key-1';
  jwk.alg = 'RS256';
  const jwks = JSON.stringify({ keys: [jwk] });

  // 2) Webhook 수신기 (Hospital RUN 역할) — HMAC 검증
  let webhookReceived = null;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sig = req.headers['x-sign-signature'];
      const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
      webhookReceived = { hmacValid: sig === expected, body: JSON.parse(body) };
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(9099, r));
  const callbackUrl = 'http://localhost:9099/webhook';

  // 3) 서버 기동 (SSO JWKS + webhook secret 주입)
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: '4199', HIS_SSO_JWKS_JSON: jwks, HIS_SSO_ISSUER: ISSUER, HIS_WEBHOOK_SECRET: WEBHOOK_SECRET, HIS_INBOUND_API_KEY: API_KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') },
    stdio: 'ignore',
  });
  try {
    // 서버 대기
    for (let i = 0; i < 30; i++) { try { if ((await get('/v1/crl')).ok) break; } catch {} await sleep(300); }

    console.log('\n[A] 폐기 CRL/OCSP');
    const pa = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=폐기테스트', identity: { method: 'PASS', ci: 'C1' } })).json();
    const serial = pa.data.serialNumber;
    const ocsp1 = await (await get('/v1/ocsp/' + serial)).json();
    check(ocsp1.data.status === 'GOOD', `발급 직후 OCSP=GOOD (${ocsp1.data.status})`);
    const rev = await (await post(`/v1/certificates/${serial}/revoke`, { reason: 'keyCompromise' })).json();
    check(rev.data.status === 'REVOKED', '폐기 성공');
    const ocsp2 = await (await get('/v1/ocsp/' + serial)).json();
    check(ocsp2.data.status === 'REVOKED', `폐기 후 OCSP=REVOKED (${ocsp2.data.status})`);
    const crl = await (await get('/v1/crl')).json();
    check(crl.data.revoked.some((r) => r.serialNumber === serial), 'CRL에 폐기 항목 포함');

    console.log('\n[B] STAFF SSO(JWKS) + 다채널 서명 + Webhook');
    const patient = await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=김환자', identity: { method: 'PASS', ci: 'C2' } })).json();
    const doctor = await (await post('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=이의사', identity: { method: 'STAFF_SSO' }, licenseNumber: 'MD-1' })).json();
    const docHash = createHmac('sha256', 'k').update('수술동의서').digest('hex');
    const req = await (await post('/v1/requests', {
      idempotencyKey: 'inc3-1', externalDocId: 'cf-9', title: '수술 동의서', documentHash: docHash, signMode: 'APP', callbackUrl,
      participants: [
        { signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '김환자', signOrder: 1, certSerial: patient.data.serialNumber },
        { signerRole: 'DOCTOR', signerType: 'STAFF', displayName: '이의사', signOrder: 2, certSerial: doctor.data.serialNumber },
      ],
    })).json();
    const p1 = req.data.participants[0].participantId;
    const p2 = req.data.participants[1].participantId;

    // 환자 서명
    const s1 = await post('/v1/sign/' + p1 + '/submit', {});
    check(s1.ok, '환자 서명 성공');

    // 의사가 일반 submit 시도 → STAFF는 SSO 필요(409)
    const sBad = await post('/v1/sign/' + p2 + '/submit', {});
    check(sBad.status === 409, `STAFF 일반 제출 차단 (HTTP ${sBad.status})`);

    // 잘못된 토큰 → 401
    const sNoAuth = await post('/v1/sign/staff', { participantId: p2 }, { authorization: 'Bearer invalid.token.here' });
    check(sNoAuth.status === 401, `위조 SSO 토큰 거부 (HTTP ${sNoAuth.status})`);

    // 유효한 HIS SSO 토큰 발급(JWT) → STAFF 서명
    const jwt = await new SignJWT({ licenseNumber: 'MD-1', acr: 'urn:mace:step-up', role: 'DOCTOR', employee_number: 'E-010' })
      .setProtectedHeader({ alg: 'RS256', kid: 'his-key-1' })
      .setIssuer(ISSUER).setAudience('sign').setSubject('user-010').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const sStaff = await (await post('/v1/sign/staff', { participantId: p2 }, { authorization: 'Bearer ' + jwt })).json();
    check(sStaff.data?.requestStatus === 'COMPLETED', `STAFF SSO 서명 → COMPLETED (${sStaff.data?.requestStatus})`);
    check(sStaff.data?.staffSub === 'user-010', 'SSO sub 바인딩 확인');

    // 뷰어용 SSO 토큰(aud=ohif) 거부 — 서명 토큰(aud=sign)과 분리 (2종 SSO 혼동 방지)
    const viewerJwt = await new SignJWT({ role: 'DOCTOR' })
      .setProtectedHeader({ alg: 'RS256', kid: 'his-key-1' })
      .setIssuer(ISSUER).setAudience('ohif').setSubject('user-010').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const sViewer = await post('/v1/sign/staff', { participantId: p2 }, { authorization: 'Bearer ' + viewerJwt });
    check(sViewer.status === 401, `뷰어 토큰(aud=ohif) 거부 (HTTP ${sViewer.status})`);

    // 검증
    const ver = await (await get('/v1/verify/' + req.data.requestId)).json();
    check(ver.data.overall === true, '전체 검증 overall=true');

    // Webhook 수신 확인
    await sleep(300);
    check(webhookReceived !== null, 'Webhook 수신됨');
    check(webhookReceived?.hmacValid === true, 'Webhook HMAC 유효');
    check(webhookReceived?.body?.eventType === 'request.completed', `Webhook eventType=request.completed`);
    check(typeof webhookReceived?.body?.eventId === 'string', 'Webhook eventId(멱등키) 포함');

    console.log('\n[C] 폐기 인증서로 신규 서명 차단');
    const req2 = await (await post('/v1/requests', {
      idempotencyKey: 'inc3-2', externalDocId: 'cf-10', title: 't', documentHash: docHash, signMode: 'APP',
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial }],
    })).json();
    const sRevoked = await post('/v1/sign/' + req2.data.participants[0].participantId + '/submit', {});
    check(sRevoked.status === 409, `폐기 인증서 서명 차단 (HTTP ${sRevoked.status})`);

    console.log('\n' + (failures === 0 ? '✅ Increment 3 전체 통과' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
    receiver.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
