// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 앵커 이중화 e2e (보안 트랙 S1) — `docs/01-plan/security-enhancement-plan.md` §3 S1.
 *
 * 자체 TSA(SELF)는 서명키가 sign 자신의 KeySigner 에 있어 운영자 독립 증거가 아니다(T1).
 * 본 릴리즈: ①외부 RFC3161 TSA 교차 앵커(best-effort) ②주기 앵커 스윕(미앵커 관리 스트림 포함).
 *
 * 검증:
 *  ① 이벤트 구동 앵커에 외부 토큰 병기 — verify 의 externalAnchors[].structureValid=true
 *  ② 관리 스트림(admin:auth) — 종전엔 앵커 경로가 없었다 → 스윕이 앵커함
 *  ③ 외부 TSA 다운 — 완료 경로 비차단(자체 앵커만으로 성공, externalAnchors 비움)
 *  ④ 스윕 보충 — 외부 실패분을 TSA 복구 후 스윕이 외부 토큰으로 채움
 *
 * mock TSA: 실 RFC3161 구조(TSTInfo + CMS SignedData, node-forge)로 응답 — 상호운용은
 * 실 freeTSA 대상 수동 검증(openssl ts -verify OK, 2026-07-29) 완료. 본 테스트는 배관 회귀용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import forge from 'node-forge';

const PORT = 4857, B = `http://127.0.0.1:${PORT}`;
const TSA_PORT = 4858;
const KEY = 'anchor-his-key';
const ADMIN_PW = 'admin-pass-123';

let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };

// ── mock RFC3161 TSA — 요청 imprint·nonce 를 파싱해 실 구조의 TimeStampResp 반환 ──
const { asn1 } = forge;
function mkTsaCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  const attrs = [{ name: 'commonName', value: 'Mock External TSA' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}
function buildResp(imprintDigestBinary, nonceNode, tsa) {
  const TST_OID = '1.2.840.113549.1.9.16.1.4';
  const algId = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
  ]);
  const tstFields = [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('1.2.3.4.1').getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      algId, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, imprintDigestBinary),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(7).getBytes()), // serial
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(new Date())),
  ];
  if (nonceNode) tstFields.push(nonceNode); // 요청 nonce 에코(재생 차단 경로 검증)
  const tstInfoDer = asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, tstFields)).getBytes();
  const p7 = forge.pkcs7.createSignedData();
  p7.contentInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(TST_OID).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, tstInfoDer),
    ]),
  ]);
  p7.content = forge.util.createBuffer(tstInfoDer);
  p7.addCertificate(tsa.cert);
  p7.addSigner({
    key: tsa.keys.privateKey, certificate: tsa.cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: TST_OID },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: false });
  const tokenDer = asn1.toDer(p7.toAsn1()).getBytes();
  const statusInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(0).getBytes()),
  ]);
  const resp = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [statusInfo, asn1.fromDer(forge.util.createBuffer(tokenDer))]);
  return Buffer.from(asn1.toDer(resp).getBytes(), 'binary');
}
function startMockTsa(tsa) {
  let stamped = 0;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const der = asn1.fromDer(forge.util.createBuffer(Buffer.concat(chunks).toString('binary')));
        const parts = der.value; // TimeStampReq: [version, messageImprint, nonce?, certReq?]
        const imprint = parts[1].value[1].value; // OCTET STRING(binary)
        const nonceNode = parts.find((p, i) => i >= 2 && p.type === asn1.Type.INTEGER) ?? null;
        stamped++;
        res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' });
        res.end(buildResp(imprint, nonceNode, tsa));
      } catch (e) {
        res.writeHead(400); res.end(String(e));
      }
    });
  });
  return new Promise((resolve) => srv.listen(TSA_PORT, '127.0.0.1', () => resolve({ srv, count: () => stamped })));
}

function startApp() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 83).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60',
      ANCHOR_TSA_URLS: `http://127.0.0.1:${TSA_PORT}/tsr`,
      SCHEDULER_ANCHOR_MIN: '0.05', // 3초 — 스윕 회귀 검증용 단주기
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch { /* 기동 대기 */ } await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 앵커 이중화 e2e (S1 — 외부 TSA 교차 앵커 + 주기 스윕) ══════\n');
  const tsa = mkTsaCert();
  const mock = await startMockTsa(tsa);
  const srv = startApp();
  if (!(await up())) { console.error('서버 기동 실패'); srv.kill(); mock.srv.close(); process.exit(1); }
  try {
    // ── ① 이벤트 구동 앵커 + 외부 토큰 병기 ──
    console.log('── 이벤트 앵커의 외부 토큰 ──');
    const rec = await (await fetch(B + '/v1/audit-events', { method: 'POST', headers: KH, body: JSON.stringify({ stream: 'anchor-e2e', action: 'ANCHOR_TEST', actor: 'tester', anchor: true }) })).json();
    check(rec?.data?.anchored === true, '감사 이벤트 anchor:true → 앵커 수행');
    const v1 = (await (await fetch(B + '/v1/audit-events/verify?stream=anchor-e2e', { headers: KH })).json()).data;
    check(v1?.valid === true && v1?.anchorTsValid === true, '자체 앵커 검증 통과(종전 동작 유지)');
    check(Array.isArray(v1?.externalAnchors) && v1.externalAnchors.length === 1, '외부 앵커 토큰 1건 병기', JSON.stringify(v1?.externalAnchors?.map((e) => e.tsaProvider)));
    check(v1?.externalAnchors?.[0]?.structureValid === true, '외부 토큰 구조 검증(imprint=head) 통과');
    check(typeof v1?.externalAnchors?.[0]?.genTime === 'string' && v1.externalAnchors[0].genTime.endsWith('Z'), '외부 TSA genTime(ISO) 보존');

    // ── ② 관리 스트림 스윕 — 종전엔 영영 미앵커였다 ──
    console.log('── 관리 스트림(admin:auth) 스윕 앵커 ──');
    await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: 'wrong' }) }); // admin:auth append
    await sleep(4500); // 스윕 주기(3s)+여유
    const root = (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json()).data?.token;
    const av = (await (await fetch(B + '/v1/admin/audit/verify?stream=admin:auth', { headers: { 'x-session-token': root } })).json()).data;
    check(av?.anchored === true, 'admin:auth 스트림 앵커됨(스윕 경로 — 종전 미앵커 갭 해소)');
    check((av?.externalAnchors?.length ?? 0) >= 1 && av.externalAnchors.every((e) => e.structureValid), 'admin:auth 외부 토큰 포함·구조 검증 통과');
    check(mock.count() > 0, `mock TSA 실호출 확인(${mock.count()}회)`);

    // ── ③ 외부 TSA 다운 — 완료 경로 비차단 ──
    console.log('── 외부 TSA 장애 시 비차단 ──');
    await new Promise((r) => mock.srv.close(r));
    const rec2 = await (await fetch(B + '/v1/audit-events', { method: 'POST', headers: KH, body: JSON.stringify({ stream: 'anchor-down', action: 'ANCHOR_TEST', actor: 'tester', anchor: true }) })).json();
    check(rec2?.data?.anchored === true, 'TSA 다운에도 앵커 성공(자체 TSA, best-effort 외부)');
    const v2 = (await (await fetch(B + '/v1/audit-events/verify?stream=anchor-down', { headers: KH })).json()).data;
    check(v2?.valid === true && (v2?.externalAnchors?.length ?? 0) === 0, '자체 앵커 valid 유지 · 외부 토큰 없음(정직한 보고)');

    // ── ④ TSA 복구 → 스윕이 외부 토큰 보충 ──
    console.log('── 스윕의 외부 토큰 보충 ──');
    const mock2 = await startMockTsa(tsa);
    await sleep(4500);
    const v3 = (await (await fetch(B + '/v1/audit-events/verify?stream=anchor-down', { headers: KH })).json()).data;
    check((v3?.externalAnchors?.length ?? 0) >= 1 && v3.externalAnchors[0].structureValid, '복구 후 스윕이 외부 토큰 보충(재앵커)');
    check(v3?.valid === true && v3?.anchorMatchesChain === true, '보충 재앵커 후에도 체인 정합 유지');
    await new Promise((r) => mock2.srv.close(r));

    console.log('\n' + (failures === 0 ? '✅ 앵커 이중화(S1) 전부 통과' : `❌ ${failures}건 실패`));
  } finally {
    srv.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
