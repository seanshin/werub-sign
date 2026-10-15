// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 런타임 연동 설정 스토어 e2e — IDV·Notifier·HSM provider·자격증명을 UI(API)로 입력·암호화 보관.
 *
 * 검증:
 *  - settings:write 스코프(콘솔 키 O / HIS 기계키 X=403)
 *  - GET 마스킹(시크릿 평문 미반환, secretsSet 만)
 *  - PUT 후 영속·ops-status 반영(provider·source=settings-store)
 *  - 시크릿 안전: 입력한 평문이 어떤 응답에도 부재
 *  - 런타임 전환: provider=mock→서명 정상, provider=pass→벤더 스텁 라우팅(서명 차단), mock 복귀→정상
 *  - 설정 변경 감사(SETTINGS_UPDATED)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4733, B = `http://127.0.0.1:${PORT}`;
const CONSOLE = 'console-key', HIS = 'his-key', SECRET = 'SUPER-SECRET-APIKEY-9999';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const put = (p, body, k = CONSOLE) => fetch(B + p, { method: 'PUT', headers: J(k), body: JSON.stringify(body) });
const post = (p, body, k = CONSOLE) => fetch(B + p, { method: 'POST', headers: J(k), body: JSON.stringify(body ?? {}) });
const getj = async (p, k = CONSOLE) => (await fetch(B + p, { headers: J(k) })).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), CONSOLE_API_KEY: CONSOLE, HIS_INBOUND_API_KEY: HIS, CRYPTO_MASTER_KEY: Buffer.alloc(32, 33).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

// 전체 서명 1건 — overall 반환
async function signFlow(ci = 'CI-X') {
  const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=S', identity: { method: 'PASS', ci } })).json()).data.serialNumber;
  const dh = createHash('sha256').update('settings-' + Math.random()).digest('hex');
  const req = await (await post('/v1/requests', { idempotencyKey: 'set-' + dh.slice(0, 8), externalDocId: 'cf', title: 't', documentHash: dh, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }] })).json();
  const pid = req.data.participants[0].participantId;
  const sub = await post('/v1/sign/' + pid + '/submit', { identity: { method: 'PASS', ci } });
  if (sub.status !== 201 && sub.status !== 200) return { ok: false, status: sub.status };
  const v = await getj('/v1/verify/' + req.data.requestId);
  return { ok: v.data.overall === true, status: sub.status };
}

async function main() {
  console.log('\n══════ 런타임 연동 설정 스토어 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 1) 스코프
    check((await put('/v1/admin/settings/idv', { provider: 'mock' }, HIS)).status === 403, 'HIS 기계키 settings:write 없음 → 403');
    check((await put('/v1/admin/settings/idv', { provider: 'mock' }, CONSOLE)).status === 200, '콘솔 키 settings:write → 200');

    // 2) 전체 조회(3종)
    const all = (await getj('/v1/admin/settings')).data;
    check(Array.isArray(all) && all.length === 3 && all.map((s) => s.type).sort().join() === 'hsm,idv,notifier', `연동 3종 노출 (${all.map((s) => s.type).join(',')})`);

    // 3) 기준: mock → 서명 정상
    check((await signFlow()).ok, '기준(provider=mock) 서명 overall=true');

    // 4) IDV provider=pass + 자격증명 입력
    const upd = await (await put('/v1/admin/settings/idv', { provider: 'pass', enabled: true, fields: { endpoint: 'https://idv.example/pass' }, secrets: { apiKey: SECRET } })).json();
    check(upd.data.provider === 'pass' && upd.data.secretsSet.apiKey === true, 'IDV provider=pass·apiKey 설정됨(secretsSet)');

    // 5) 시크릿 안전: 어떤 응답에도 평문 부재
    const masked = await getj('/v1/admin/settings/idv');
    const opsBlob = JSON.stringify(await getj('/v1/admin/ops-status')) + JSON.stringify(masked) + JSON.stringify(all);
    check(!opsBlob.includes(SECRET), 'apiKey 평문이 masked/ops 응답 어디에도 부재');
    check(masked.data.source === 'settings-store' && masked.data.fields.endpoint === 'https://idv.example/pass', 'IDV source=settings-store·endpoint 영속');

    // 6) ops-status 반영
    const ops = (await getj('/v1/admin/ops-status')).data;
    check(ops.config.identity.provider === 'pass' && ops.config.identity.source === 'settings-store', 'ops-status identity.provider=pass(settings-store)');

    // 7) 런타임 전환 — pass=벤더 스텁 라우팅 → 서명 차단(미구현 throw)
    const passFlow = await signFlow('CI-PASS');
    check(passFlow.ok === false, `provider=pass 런타임 라우팅 — 벤더 스텁(미구현)로 서명 차단(status=${passFlow.status})`);

    // 8) mock 복귀 → 정상
    await put('/v1/admin/settings/idv', { provider: 'mock', enabled: false });
    check((await signFlow('CI-BACK')).ok, 'provider=mock 복귀 → 서명 overall=true');

    // 9) Notifier·HSM 설정
    const noti = await (await put('/v1/admin/settings/notifier', { provider: 'kakao', fields: { templateId: 'T-001' }, secrets: { apiKey: SECRET, senderKey: 'SK-1' } })).json();
    check(noti.data.provider === 'kakao' && noti.data.secretsSet.apiKey && noti.data.secretsSet.senderKey, 'Notifier=kakao·apiKey·senderKey 설정');
    const hsm = await (await put('/v1/admin/settings/hsm', { provider: 'aws-kms', fields: { region: 'ap-northeast-2', keyId: 'alias/sign-ca' } })).json();
    check(hsm.data.provider === 'aws-kms' && hsm.data.schema.runtimeApplied === false, 'HSM=aws-kms 캡처(runtimeApplied=false=cutover 필요)');

    // 10) 감사
    const aud = (await getj('/v1/admin/settings/idv/audit')).data;
    const kinds = (Array.isArray(aud) ? aud : []).map((e) => e.eventType);
    check(kinds.filter((k) => k === 'SETTINGS_UPDATED').length >= 3, `IDV 설정변경 감사(SETTINGS_UPDATED ${kinds.filter((k) => k === 'SETTINGS_UPDATED').length}건)`);
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ 런타임 연동 설정 스토어 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
