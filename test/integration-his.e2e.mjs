// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * HIS 연동 검증 하니스 — handoff 명세서(docs/05-handoff/...) §12 시퀀스 전체 검증.
 * mock HIS를 세워 실제 연동 계약이 동작함을 입증(HIS팀 붙이기 전 리스크 제거).
 *  - mock HIS: JWKS 공개(GET /.well-known/jwks.json) + 의료진 SSO JWT 발급 + Webhook 수신(HMAC·멱등) + ConsentForm 시뮬
 *  - sign: remote JWKS로 STAFF 토큰 검증(운영에 가까운 경로)
 * 실행: npm run build && node test/integration-his.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const SIGN_PORT = 4611, HIS_PORT = 9600; // 라운드 포트(x00) 금지 — CI 러너 상주 서비스와 충돌(increment4 참조)
const SIGN = `http://localhost:${SIGN_PORT}`;
const HIS = `http://localhost:${HIS_PORT}`;
const API_KEY = 'his-to-sign-key';
const WEBHOOK_SECRET = 'shared-webhook-secret';
const ISSUER = 'hospitalrun';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sapi = (p, b, h = {}) => fetch(SIGN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, ...h }, body: JSON.stringify(b ?? {}) });
const sget = (p) => fetch(SIGN + p);

async function main() {
  // ── mock HIS: 키쌍·JWKS·상태 ──
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'his-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const consentForms = new Map(); // externalDocId -> { status, auditCertUri }
  const seenEvents = new Set();   // eventId 멱등
  let webhookCount = 0;
  const webhookTypes = []; // v1.22+ 계약: 서명자별 request.signer_completed + 최종 request.completed

  const his = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (req.method === 'POST' && req.url === '/consent/sign-webhook') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // 1) HMAC 검증
        const sig = req.headers['x-sign-signature'];
        const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
        if (sig !== expected) { res.writeHead(401); return res.end('bad signature'); }
        const evt = JSON.parse(body);
        // 2) eventId 멱등
        if (seenEvents.has(evt.eventId)) { res.writeHead(200); return res.end('dup-ignored'); }
        seenEvents.add(evt.eventId);
        webhookCount++;
        webhookTypes.push(evt.eventType);
        // 3) ConsentForm 반영
        consentForms.set(evt.externalDocId, { status: 'SIGNED', auditCertUri: evt.auditCertUri ?? null, verifiedHash: evt.verifiedHash });
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => his.listen(HIS_PORT, r));

  // ── sign 기동 (remote JWKS = mock HIS) ──
  const server = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(SIGN_PORT), HIS_INBOUND_API_KEY: API_KEY, HIS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HIS_SSO_JWKS_URL: `${HIS}/.well-known/jwks.json`, HIS_SSO_ISSUER: ISSUER,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
    }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { try { up = (await sget('/v1/crl')).ok; } catch {} if (!up) await sleep(300); }
    if (!up) throw new Error(`sign 서버 미기동(포트 ${SIGN_PORT} 점유 또는 기동 실패)`);

    console.log('\n=== 명세 §12 시퀀스: 수술 동의서 (환자앱 + 의료진 SSO) ===');
    const consentFormId = 'consentform-7788';

    // 1) HIS: 환자/의사 인증서 발급
    const pat = await (await sapi('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=홍길동', ownerRef: 'patient-1', identity: { method: 'PASS', ci: 'CI-홍' } })).json();
    const doc = await (await sapi('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=김의사', ownerRef: 'user-9', identity: { method: 'STAFF_SSO' }, licenseNumber: 'MD-77' })).json();
    check(pat.data?.serialNumber && doc.data?.serialNumber, '환자·의사 인증서 발급');

    // 2) HIS → sign: 서명요청 (callbackUrl = mock HIS webhook)
    const documentHash = createHash('sha256').update('수술 동의서 봉인본문').digest('hex');
    const req = await (await sapi('/v1/requests', {
      idempotencyKey: `consent-${consentFormId}-v1`, externalDocId: consentFormId, title: '수술 동의서',
      documentHash, signMode: 'APP', callbackUrl: `${HIS}/consent/sign-webhook`,
      participants: [
        { signerRole: 'PATIENT', signerType: 'PATIENT', externalSignerRef: 'patient-1', displayName: '홍길동', signOrder: 1, certSerial: pat.data.serialNumber, requiredIdentityLevel: 'PASS' },
        { signerRole: 'DOCTOR', signerType: 'STAFF', externalSignerRef: 'user-9', displayName: '김의사', signOrder: 2, certSerial: doc.data.serialNumber, requiredIdentityLevel: 'STAFF_SSO' },
      ],
    })).json();
    const requestId = req.data.requestId;
    const pPart = req.data.participants.find((p) => p.signerRole === 'PATIENT').participantId;
    const dPart = req.data.participants.find((p) => p.signerRole === 'DOCTOR').participantId;
    check(!!requestId, '서명요청 생성 (requestId)');

    // 3) 환자: 비대면 본인확인 + 서명
    const ps = await sapi(`/v1/sign/${pPart}/submit`, { identity: { method: 'PASS', ci: 'CI-홍', phone: '01011112222' } });
    check(ps.ok, '환자 서명(비대면 PASS)');

    // 4) 의사: HIS SSO JWT 발급 → 의료진 포털 서명
    const jwt = await new SignJWT({ acr: 'urn:step-up', licenseNumber: 'MD-77', role: 'DOCTOR', employee_number: 'E-9' })
      .setProtectedHeader({ alg: 'RS256', kid: 'his-1' }).setIssuer(ISSUER).setAudience('sign').setSubject('user-9').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const ds = await (await sapi('/v1/sign/staff', { participantId: dPart }, { authorization: `Bearer ${jwt}` })).json();
    check(ds.data?.requestStatus === 'COMPLETED', `의사 서명(SSO·remote JWKS) → COMPLETED (${ds.data?.requestStatus})`);
    check(ds.data?.staffSub === 'user-9', 'SSO sub=user-9 바인딩');

    // 5~6) Webhook 수신 → ConsentForm 반영
    await sleep(400);
    const cf = consentForms.get(consentFormId);
    check(cf?.status === 'SIGNED', `HIS Webhook 수신 → ConsentForm.status=SIGNED (${cf?.status})`);
    check(cf?.verifiedHash === documentHash, 'verifiedHash 일치');

    // 7) 검증 (LTV 포함)
    const ver = await (await sget(`/v1/verify/${requestId}`)).json();
    check(ver.data.overall === true, '검증 overall=true');
    check(ver.data.signatures.every((s) => s.ltvValid), '모든 서명 LTV 유효(PAdES-B-LTA)');
    check(ver.data.signatures.find((s) => s.signerRole === 'PATIENT').identityMethod === 'PASS', '환자 인증수단 PASS 결합');

    // 8) reconcile (Webhook 유실 대비 상태 조회)
    const rc = await (await sget(`/v1/requests/${requestId}`)).json();
    check(rc.data.status === 'COMPLETED', 'reconcile 상태 조회 COMPLETED');

    console.log('\n=== 보안/멱등 계약 검증 ===');
    // Webhook 계약(v1.22+): 서명자별 signer_completed + 최종 completed, eventId 멱등으로 각 1회
    check(webhookTypes.filter((t) => t === 'request.completed').length === 1, `request.completed 정확히 1회 (${JSON.stringify(webhookTypes)})`);
    check(webhookTypes.filter((t) => t === 'request.signer_completed').length === 1, `request.signer_completed 서명자당 1회 (${JSON.stringify(webhookTypes)})`);
    // 잘못된 SSO 발급자
    const badIss = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'his-1' }).setIssuer('attacker').setSubject('x').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const badRes = await sapi('/v1/sign/staff', { participantId: dPart }, { authorization: `Bearer ${badIss}` });
    check(badRes.status === 401, `잘못된 issuer 토큰 거부 (${badRes.status})`);

    console.log('\n' + (failures === 0 ? '✅ HIS 연동 하니스 전체 통과 — 명세 계약 동작 확인' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
    his.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
