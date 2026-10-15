// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 6 e2e: 본인확인 강결합 (FR-09 / design §15)
 * 실행: npm run build && node test/increment6.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4411; // 라운드 포트(x00) 금지 — CI 러너 상주 서비스와 충돌(increment4 참조)
const B = `http://localhost:${PORT}`;
const KEY = 'idv-key';
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const get = (p) => fetch(B + p);
const sha256 = (s) => import('node:crypto').then((c) => c.createHash('sha256').update(s).digest('hex'));

async function enrollPatient(cn, ci) {
  return (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: `CN=${cn}`, identity: { method: 'PASS', ci } })).json();
}
async function createReq(idem, docHash, serial, level) {
  return (await post('/v1/requests', {
    idempotencyKey: idem, externalDocId: 'cf', title: 't', documentHash: docHash, signMode: 'APP',
    participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: level }],
  })).json();
}

async function main() {
  const server = spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { try { up = (await get('/v1/crl')).ok; } catch {} if (!up) await sleep(300); }
    if (!up) throw new Error(`sign 서버 미기동(포트 ${PORT} 점유 또는 기동 실패)`);
    const docHash = await sha256('동의서-idv');

    console.log('\n[A] 비대면(PASS) — 본인확인 정보 없으면 차단');
    const p1 = await enrollPatient('비대면환자', 'CI-A');
    const r1 = await createReq('idv-1', docHash, p1.data.serialNumber, 'PASS');
    const noId = await post('/v1/sign/' + r1.data.participants[0].participantId + '/submit', {});
    check(noId.status === 403, `본인확인 정보 없음 → 403 (${noId.status})`);
    check((await noId.json()).error?.code === 'FORBIDDEN', 'IDENTITY_REQUIRED 차단');

    console.log('\n[B] 비대면(PASS) — 본인확인 정보 제공 시 서명·결합');
    const withId = await post('/v1/sign/' + r1.data.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'CI-A', phone: '01000000000' } });
    check(withId.ok, `본인확인 후 서명 성공 (${withId.status})`);
    const ver1 = await (await get('/v1/verify/' + r1.data.requestId)).json();
    check(ver1.data.signatures[0].identityMethod === 'PASS', `서명에 인증수단 결합 identityMethod=PASS (${ver1.data.signatures[0].identityMethod})`);
    check(ver1.data.overall === true, '검증 overall=true');
    const audit1 = await (await get('/v1/requests/' + r1.data.requestId + '/audit')).json();
    check(audit1.data.some((e) => e.eventType === 'IDENTITY_VERIFIED'), '감사에 IDENTITY_VERIFIED 기록');

    console.log('\n[C] 대면(INPERSON) — 정보 없이 서명 가능');
    const p2 = await enrollPatient('대면환자', 'CI-B');
    const r2 = await createReq('idv-2', docHash, p2.data.serialNumber, 'INPERSON');
    const inperson = await post('/v1/sign/' + r2.data.participants[0].participantId + '/submit', {});
    check(inperson.ok, `대면 서명 성공 (${inperson.status})`);
    const ver2 = await (await get('/v1/verify/' + r2.data.requestId)).json();
    check(ver2.data.signatures[0].identityMethod === 'INPERSON', `identityMethod=INPERSON (${ver2.data.signatures[0].identityMethod})`);

    console.log('\n' + (failures === 0 ? '✅ Increment 6 전체 통과' : `❌ ${failures}건 실패`));
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
