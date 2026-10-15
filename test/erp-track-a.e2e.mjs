// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * ERP 트랙 A — 외부 거래처 계약 서명 e2e (수용기준).
 *  - 전체 흐름: enroll(WITNESS) → requests(PORTAL·NONE) → portal-tokens → 포털 서명(동의) → 완료.
 *  - 완료 webhook request.completed 가 **ERP_WEBHOOK_SECRET 으로 서명**(HIS 시크릿 미사용) = 소비자별 격리.
 *  - 역격리: HIS 생성 요청의 webhook 은 HIS_WEBHOOK_SECRET 서명(ERP 아님).
 *  - ERP 키 스코프: enroll/requests 201, ca:admin(소비자목록) 403.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';

const PORT = 4788, HOOK = 4789, B = `http://127.0.0.1:${PORT}`;
const ERP = 'erp-k', HIS = 'his-k', ERP_SEC = 'erp-webhook-secret', HIS_SEC = 'his-webhook-secret';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const post = (p, b, k) => fetch(B + p, { method: 'POST', headers: H(k), body: JSON.stringify(b ?? {}) });
const postPub = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const dh = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (body, sec) => createHmac('sha256', sec).update(body).digest('hex');

const received = [];
const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { received.push({ sig: req.headers['x-sign-signature'], raw: b, body: JSON.parse(b || '{}') }); res.writeHead(200); res.end('ok'); }); });

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: HIS, ERP_API_KEY: ERP,
      HIS_WEBHOOK_SECRET: HIS_SEC, ERP_WEBHOOK_SECRET: ERP_SEC, CRYPTO_MASTER_KEY: Buffer.alloc(32, 49).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ ERP 트랙 A (외부 거래처 계약 서명) e2e ══════\n');
  await new Promise((r) => hookSrv.listen(HOOK, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hookSrv.close(); process.exit(1); }
  const HOOK_URL = `http://127.0.0.1:${HOOK}/erp-hook`;
  try {
    // ── 1) ERP 키로 외부 서명자(WITNESS) 인증서 발급
    const er = await post('/v1/certificates/enroll', { ownerType: 'WITNESS', subjectDn: 'CN=거래처대표' }, ERP);
    check(er.status === 201, 'ERP 키 — WITNESS 인증서 발급 201');
    const serial = (await er.json()).data.serialNumber;

    // ── 2) 서명요청(PORTAL·NONE=deep-link 토큰+동의, PASS 무의존)
    const cr = await post('/v1/requests', {
      idempotencyKey: 'erp-c1', externalDocId: 'ERP-CONTRACT-1', title: '외주 용역 계약서', documentHash: dh('contract-v1'),
      signMode: 'PORTAL', callbackUrl: HOOK_URL,
      participants: [{ signerRole: 'VENDOR', signerType: 'WITNESS_EXTERNAL', displayName: '거래처대표', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }],
    }, ERP);
    check(cr.status === 201, 'ERP 키 — 서명요청 생성(PORTAL) 201');
    const reqData = (await cr.json()).data;
    const rid = reqData.requestId, pid = reqData.participants[0].participantId;

    // ── 3) 포털 토큰 발급(ERP가 거래처 이메일/문자로 전달할 deep-link)
    const tk = await post(`/v1/requests/${rid}/portal-tokens`, {}, ERP);
    const tokens = (await tk.json()).data;
    check(tk.status === 201 && tokens[0]?.url?.startsWith('/portal/'), `포털 토큰 발급(deep-link ${tokens[0]?.url?.slice(0, 16)}…)`);
    const token = tokens[0].token;

    // ── 4) 거래처 포털 서명(동의 — 본인확인 정보 불요)
    const ps = await postPub(`/v1/portal/${token}/sign`, {});
    const psd = (await ps.json()).data;
    check(ps.status === 201 && psd.signed && psd.requestStatus === 'COMPLETED', '포털 서명(동의) → COMPLETED');

    // ── 5) 검증 통과
    const vf = await (await fetch(`${B}/v1/verify/${rid}`)).json();
    check(vf.data.overall === true, `서명 검증 overall=true`);

    // ── 6) 완료 webhook — ERP_WEBHOOK_SECRET 서명(소비자별 격리)
    await sleep(800);
    const erpHook = received.find((h) => h.body.requestId === rid && h.body.eventType === 'request.completed');
    check(!!erpHook, 'request.completed webhook 수신');
    check(erpHook && erpHook.sig === hmac(erpHook.raw, ERP_SEC), 'webhook HMAC = ERP_WEBHOOK_SECRET (전용 시크릿)');
    check(erpHook && erpHook.sig !== hmac(erpHook.raw, HIS_SEC), 'webhook HMAC ≠ HIS_WEBHOOK_SECRET (격리 확인)');
    check(erpHook && erpHook.body.status === 'COMPLETED' && erpHook.body.signCertSerial === serial, '페이로드 status·signCertSerial 정합');

    // ── 7) 역격리: HIS 생성 요청은 HIS 시크릿 서명
    const hser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=환자', identity: { method: 'PASS', ci: 'C' } }, HIS)).json()).data.serialNumber;
    const hr = (await (await post('/v1/requests', { idempotencyKey: 'his-c1', externalDocId: 'HIS-1', title: 'HIS', documentHash: dh('his'), signMode: 'APP', callbackUrl: HOOK_URL, participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '환자', signOrder: 1, certSerial: hser, requiredIdentityLevel: 'NONE' }] }, HIS)).json()).data;
    await post(`/v1/sign/${hr.participants[0].participantId}/submit`, {}, HIS);
    await sleep(800);
    const hisHook = received.find((h) => h.body.requestId === hr.requestId && h.body.eventType === 'request.completed');
    check(hisHook && hisHook.sig === hmac(hisHook.raw, HIS_SEC) && hisHook.sig !== hmac(hisHook.raw, ERP_SEC), 'HIS 요청 webhook = HIS 시크릿(ERP 아님) — 양방향 격리');

    // ── 8) ERP 키 스코프 — ca:admin 차단
    check((await fetch(`${B}/v1/admin/consumers`, { headers: H(ERP) })).status === 403, 'ERP 키 — 소비자목록(ca:admin) 403');
  } finally { app.kill(); hookSrv.close(); }
  console.log('\n' + (failures === 0 ? '✅ ERP 트랙 A 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
