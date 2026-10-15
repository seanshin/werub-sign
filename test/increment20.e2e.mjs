// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 20 — 보호자/대리(PROXY) 서명.
 * 대리인이 자신의 PASS 본인인증으로 환자를 대신해 서명 + relationship·onBehalfOf 봉인.
 * 검증: enroll(PROXY), facade channel=PROXY → 서명 → verify에 signerType=PROXY·relationship·onBehalfOf,
 *      감사 SIGNED에 관계 기록, 대리인 본인확인 강결합(정보없으면 차단).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4725, B = `http://localhost:${PORT}`, KEY = 'inc20-key';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p)).json();
const H = (s) => createHash('sha256').update(s).digest('hex');

function start() {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 20).toString('base64') }, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Increment 20 — 보호자/대리(PROXY) 서명 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // PROXY 인증서 발급(대리인 PASS 본인인증)
    const pe = await (await post('/v1/certificates/enroll', { ownerType: 'PROXY', subjectDn: 'CN=김보호자', identity: { method: 'PASS', ci: 'PROXY-CI' } })).json();
    check(pe.data?.serialNumber?.startsWith('CERT-') && pe.data.ownerType === 'PROXY', 'PROXY 인증서 발급(대리인 본인인증)');

    // facade channel=PROXY: 대리인 자동발급 + 관계 기록 + 서명요청
    const r = await (await post('/v1/sign-requests', {
      documentType: '수술 동의서', documentHash: H('proxy-doc'), channel: 'PROXY', issueNo: 'PRX-1',
      requiredIdentityLevel: 'PASS', relationship: '법정대리인', onBehalfOf: '미성년환자(P-001)',
      patientSigner: { name: '김보호자', ci: 'PROXY-CI' },
    })).json();
    const rid = r.data.signatureRequestId, pid = r.data.participantId;
    check(!!rid && !!pid, 'PROXY 서명요청 생성');

    // 대리인 본인확인 없이 서명 → 차단
    const noId = await post('/v1/sign/' + pid + '/submit', {});
    check(noId.status === 403, '대리인 본인확인 없으면 차단(403, 강결합)');

    // 대리인 PASS로 서명
    const ok = await post('/v1/sign/' + pid + '/submit', { identity: { method: 'PASS', ci: 'PROXY-CI', name: '김보호자' } });
    check(ok.status === 201 || ok.status === 200, '대리인 PASS 본인인증으로 서명 성공');

    // 검증 — signerType=PROXY + 관계
    const v = (await getj('/v1/verify/' + rid)).data;
    check(v.overall === true, '검증 overall=true');
    const s0 = v.signatures[0];
    check(s0.signerType === 'PROXY' && s0.relationship === '법정대리인' && s0.onBehalfOf === '미성년환자(P-001)', 'verify에 signerType=PROXY·relationship·onBehalfOf 노출');

    // 감사 이력에 관계 봉인
    const audit = (await getj('/v1/requests/' + rid + '/audit')).data;
    const signed = audit.find((a) => a.eventType === 'SIGNED');
    check(signed?.data?.relationship === '법정대리인' && signed?.data?.onBehalfOf === '미성년환자(P-001)', '감사 SIGNED에 대리 관계 봉인(해시체인)');
    const av = (await getj('/v1/requests/' + rid + '/audit/verify')).data;
    check(av.valid === true, '감사 무결성 valid=true(관계 봉인 포함)');
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ Increment 20 통과 — 보호자/대리(PROXY) 서명' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
