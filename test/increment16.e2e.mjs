// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 16 — 발송(Notifier) + 철회/만료 e2e.
 * 환자 서비스 운영 기능: 원외 안내 발송(FR-10), 동의 철회·기한 만료(FR-13).
 *
 * 검증: 발송(mock)→링크 토큰 유효, 철회→이후 서명 차단, 만료배치→EXPIRED·서명 차단,
 *      실 사업자(kakao) 미설정 시 드롭인 안내(발송 오케스트레이션은 통과/스킵 처리).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4718;
const B = `http://localhost:${PORT}`;
const KEY = 'inc16-api-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postKey = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body ?? {}) });
const postPub = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const getj = async (p) => (await fetch(B + p)).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, NOTIFIER_PROVIDER: 'mock', CRYPTO_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }
async function enroll(cn) {
  return (await (await postKey('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=' + cn, identity: { method: 'PASS', ci: 'C' } })).json()).data.serialNumber;
}
async function makeReq(idem, ttlDays) {
  const docHash = createHash('sha256').update(idem).digest('hex');
  const serial = await enroll('P-' + idem);
  const body = { idempotencyKey: idem, externalDocId: 'cf-' + idem, title: '동의서 ' + idem, documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }] };
  if (ttlDays !== undefined) body.ttlDays = ttlDays;
  return (await (await postKey('/v1/requests', body)).json()).data;
}

async function main() {
  console.log('\n══════ Increment 16 — 발송 + 철회/만료 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 앱 기동 실패'); app.kill(); process.exit(1); }
  try {
    // ── 발송 ──
    const r1 = await makeReq('send1');
    const pid1 = r1.participants[0].participantId;
    const sent = await (await postKey('/v1/requests/' + r1.requestId + '/notify', { baseUrl: B, recipients: [{ participantId: pid1, to: '01012345678', channel: 'ALIMTALK' }] })).json();
    check(sent.data[0].result === 'SENT' && sent.data[0].url.startsWith('/portal/'), '발송(mock): SENT + 포털 링크 발급');
    const token = sent.data[0].url.split('/portal/')[1];
    const info = (await getj('/v1/portal/' + token)).data;
    check(info.canSignNow === true, '발송 링크 토큰으로 동의서 열람 가능');

    // (C1) 무인증 직접 서명 제출 차단 — 서명 위조 방지
    const forge = await postPub('/v1/sign/' + pid1 + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    check(forge.status === 401, '무키 직접 submit 차단 401 (C1 위조방지)');

    // ── 철회 ──
    const r2 = await makeReq('wd1');
    const pid2 = r2.participants[0].participantId;
    const wd = await (await postKey('/v1/requests/' + r2.requestId + '/withdraw', { reason: '환자 요청' })).json();
    check(wd.data.status === 'WITHDRAWN', '동의 철회 → WITHDRAWN');
    const afterWd = await postKey('/v1/sign/' + pid2 + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    check(afterWd.status === 409, '철회 후 서명 차단(409)');

    // ── 만료 ──
    const r3 = await makeReq('exp1', 0.00001); // ≈0.86초 후 만료
    const pid3 = r3.participants[0].participantId;
    await sleep(1200);
    const exp = await (await postKey('/v1/maintenance/expire', {})).json();
    check(exp.data.expired >= 1 && exp.data.requestIds.includes(r3.requestId), '만료 배치 → 기한경과 요청 EXPIRED');
    const g3 = (await getj('/v1/requests/' + r3.requestId)).data;
    check(g3.status === 'EXPIRED', '만료 요청 상태 EXPIRED');
    const afterExp = await postKey('/v1/sign/' + pid3 + '/submit', { identity: { method: 'PASS', ci: 'C' } });
    check(afterExp.status === 409, '만료 후 서명 차단(409)');
  } finally { app.kill(); }

  console.log('\n' + (failures === 0 ? '✅ Increment 16 통과 — 발송 + 철회/만료' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
