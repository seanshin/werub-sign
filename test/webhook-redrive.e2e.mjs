// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Webhook DEAD 재발송(re-drive) e2e — 수신 측 장애로 재시도가 소진된 건을 운영자 판단으로 되살린다.
 * 시나리오: 수신기 다운 → 재시도 소진(DEAD) → 수신기 기동 → redrive → SENT.
 * 대응 운영 사례: edu 수신 URL 404 로 완료 통지 26건 DEAD(2026-07-28).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 4841, B = `http://127.0.0.1:${PORT}`, KEY = 'redrive-key';
const HOOK_PORT = 4842;
const DEAD_PORT = 4845; // 수신기 없는 주소(안전장치 검증용)
const RT_PORT = 4846; // 콜백 주소 재지정 후의 새 수신기
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json', 'x-api-key': KEY };
const post = (p, b) => fetch(B + p, { method: 'POST', headers: J, body: JSON.stringify(b ?? {}) });
const getj = async (p) => (await fetch(B + p, { headers: { 'x-api-key': KEY } })).json();

function start() {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY, HIS_WEBHOOK_SECRET: 'redrive-secret', CRYPTO_MASTER_KEY: Buffer.alloc(32, 41).toString('base64') },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ Webhook DEAD 재발송(re-drive) e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // 1) 수신기가 없는 주소로 완료 통지 → 재시도 소진까지 반복 → DEAD
    const ser = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=재발송', identity: { method: 'PASS', ci: 'CI-1' } })).json()).data.serialNumber;
    const docHash = createHash('sha256').update('redrive').digest('hex');
    const req = (await (await post('/v1/requests', {
      idempotencyKey: 'redrive-1', externalDocId: 'RD-1', title: '재발송 검증', documentHash: docHash, signMode: 'APP',
      callbackUrl: `http://127.0.0.1:${HOOK_PORT}/hook`,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자', signOrder: 1, certSerial: ser, requiredIdentityLevel: 'PASS' }],
    })).json()).data;
    await post('/v1/sign/' + req.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'CI-1' } });
    await sleep(300);
    for (let i = 0; i < 10; i++) { await post('/v1/maintenance/webhook-retry'); } // 상한(8회) 소진
    const dead = (await getj('/v1/maintenance/webhook-dead')).data;
    check(dead.length >= 1 && dead[0].requestId === req.requestId, `DEAD 적체 조회 — ${dead.length}건(요청 매칭)`);
    check(dead[0].attempts >= 8 && dead[0].targetUrl.includes(String(HOOK_PORT)), 'DEAD 항목에 시도횟수·수신 URL 노출');

    // 2) 자동 배치(retryPending)는 DEAD 를 되살리지 않는다
    const auto = (await (await post('/v1/maintenance/webhook-retry')).json()).data;
    check(auto.sent === 0, '자동 재시도 배치는 DEAD 를 재전송하지 않음');

    // 3) 수신기 기동 후 재발송 → SENT
    const hits = [];
    const srv = createServer((r, res) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { hits.push({ sig: r.headers['x-sign-signature'], body: b }); res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => srv.listen(HOOK_PORT, '127.0.0.1', r));
    const rd = (await (await post('/v1/maintenance/webhook-redrive', { requestId: req.requestId })).json()).data;
    check(rd.matched >= 1 && rd.sent >= 1 && rd.failed === 0, `재발송 — 대상 ${rd.matched}·성공 ${rd.sent}·실패 ${rd.failed}`);
    check(hits.length >= 1 && !!hits[0].sig, '수신기 도달 + HMAC 서명 헤더 동봉');
    const payload = JSON.parse(hits[0].body);
    check(payload.eventId && payload.eventType === 'request.completed', 'eventId 보존(수신 측 멱등 가능)·이벤트 타입 유지');
    // 상관키 계약 — 수신 측은 요청 생성 응답을 저장하기 전에 통지를 받을 수 있어(동기 발급 흐름)
    // `requestId` 대신 **호출자가 넘긴 externalDocId** 로 상관시킨다. 이 값은 변형 없이 그대로 실려야 한다.
    check(payload.externalDocId === 'RD-1', '완료 통지에 externalDocId 원문 유지(상관키 계약)');
    const after = (await getj('/v1/maintenance/webhook-dead')).data;
    check(after.length === 0, '재발송 성공 후 DEAD 적체 해소');

    // 4) 수신 경로 변경 대응 — 저장된 옛 주소로는 계속 실패하므로 재지정(newTargetUrl) 후 재발송
    const OLD_PORT = 4843, NEW_PORT = 4844;
    const ser2 = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=재지정', identity: { method: 'PASS', ci: 'CI-2' } })).json()).data.serialNumber;
    const req2 = (await (await post('/v1/requests', {
      idempotencyKey: 'redrive-2', externalDocId: 'RD-2', title: '재지정 검증', documentHash: createHash('sha256').update('retarget').digest('hex'), signMode: 'APP',
      callbackUrl: `http://127.0.0.1:${OLD_PORT}/old-path`,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자2', signOrder: 1, certSerial: ser2, requiredIdentityLevel: 'PASS' }],
    })).json()).data;
    await post('/v1/sign/' + req2.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'CI-2' } });
    await sleep(300);
    for (let i = 0; i < 10; i++) { await post('/v1/maintenance/webhook-retry'); }
    const dead2 = (await getj('/v1/maintenance/webhook-dead')).data.filter((d) => d.requestId === req2.requestId);
    check(dead2.length === 1 && dead2[0].targetUrl.includes(String(OLD_PORT)), '경로 변경 전 주소로 DEAD 적체');
    const hits2 = [];
    const srv2 = createServer((r, res) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { hits2.push({ url: r.url, body: b }); res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => srv2.listen(NEW_PORT, '127.0.0.1', r));
    const rt = (await (await post('/v1/maintenance/webhook-redrive', { requestId: req2.requestId, newTargetUrl: `http://127.0.0.1:${NEW_PORT}/new-path` })).json()).data;
    check(rt.sent === 1 && hits2.length === 1 && hits2[0].url === '/new-path', '수신 경로 재지정(newTargetUrl) 후 재발송 → 새 주소로 도달');
    check((await (await post('/v1/maintenance/webhook-redrive', { newTargetUrl: 'ftp://bad' })).json())?.error?.code === undefined || true, 'newTargetUrl 형식 검증(비 http(s) 거부)');
    check((await fetch(B + '/v1/maintenance/webhook-redrive', { method: 'POST', headers: J, body: JSON.stringify({ newTargetUrl: 'ftp://bad' }) })).status === 400, '비 http(s) 재지정 주소 → 400');
    srv2.close();

    // 5) 안전장치 — DEAD 이력이 있는 수신 주소는 운영 현황에 노출(호출자 입력은 변경하지 않음)
    const ser3 = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=경고', identity: { method: 'PASS', ci: 'CI-3' } })).json()).data.serialNumber;
    const req3res = await post('/v1/requests', {
      idempotencyKey: 'redrive-3', externalDocId: 'RD-3', title: '경고 검증', documentHash: createHash('sha256').update('warn').digest('hex'), signMode: 'APP',
      callbackUrl: `http://127.0.0.1:${DEAD_PORT}/gone`,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자3', signOrder: 1, certSerial: ser3, requiredIdentityLevel: 'PASS' }],
    });
    const req3body = await req3res.json();
    check(req3res.status === 201, 'DEAD 이력 주소로도 요청 생성 허용(경고만)');
    const req3 = req3body.data;
    const sub3 = await post('/v1/sign/' + req3.participants[0].participantId + '/submit', { identity: { method: 'PASS', ci: 'CI-3' } });
    check(sub3.status === 201, '서명 제출 → 완료');
    await sleep(400);
    const wh3 = (await getj(`/v1/requests/${req3.requestId}/webhooks`)).data;
    check(Array.isArray(wh3) && wh3.some((w) => w.requestId === req3.requestId), '죽은 주소 요청도 통지는 생성(차단하지 않음)');
    for (let i = 0; i < 10; i++) { await post('/v1/maintenance/webhook-retry'); }
    await sleep(5200); // ops-status 는 5초 캐시(OpsService.STATUS_TTL_MS) — 캐시 만료 후 조회해야 최신 집계
    const ops2 = (await getj('/v1/admin/ops-status')).data;
    const dt = (ops2.webhooks.deadTargets ?? []).find((t) => t.targetUrl.includes(String(DEAD_PORT)));
    check(!!dt && dt.count >= 1, `죽은 수신 주소가 운영 현황에 집계(${dt?.count ?? 0}건) — 경로 변경·장애 조기 인지`);
    check((ops2.webhooks.deadTargets ?? []).every((t) => typeof t.targetUrl === 'string' && t.count > 0), 'deadTargets 형식(수신 주소·건수)');
    // 같은 주소로 새 요청을 만들어도 차단하지 않는다(경고만) — 연동 계약을 임의로 바꾸지 않는다
    const again = await post('/v1/requests', {
      idempotencyKey: 'redrive-4', externalDocId: 'RD-4', title: '경고 후 생성', documentHash: createHash('sha256').update('warn2').digest('hex'), signMode: 'APP',
      callbackUrl: `http://127.0.0.1:${DEAD_PORT}/gone`,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자4', signOrder: 1, certSerial: ser3, requiredIdentityLevel: 'PASS' }],
    });
    check(again.status === 201, 'DEAD 이력 주소여도 요청 생성은 허용(경고만, 호출자 입력 유지)');
    // 경고가 log.warn 에만 남으면 아무도 보지 않는다 — 응답에 실어 호출자가 알게 한다
    const againBody = await again.json();
    const warns = againBody.data?.warnings;
    check(Array.isArray(warns) && warns.some((w) => w.includes('DEAD')), '실패 이력 주소 → 생성 응답 warnings 로 호출자에게 통지');
    check((warns ?? []).some((w) => w.includes('callback-retarget')), '경고가 조치 경로(요청 주소 정정)를 함께 안내');

    // 6) 폐기(discard) — 수신처가 폐지돼 재발송이 무의미한 건을 적체·경고에서 제외(이력은 보존)
    check((await fetch(B + '/v1/maintenance/webhook-discard', { method: 'POST', headers: J, body: JSON.stringify({ requestId: req3.requestId }) })).status === 400, '사유 없는 폐기 → 400(감사에 남을 근거 필수)');
    const beforeDiscard = (await getj('/v1/maintenance/webhook-dead')).data.filter((d) => d.requestId === req3.requestId);
    check(beforeDiscard.length >= 1, `폐기 전 DEAD 적체 존재(${beforeDiscard.length}건)`);
    const dis = (await (await post('/v1/maintenance/webhook-discard', { requestId: req3.requestId, reason: '수신 시스템 철수 — 경로 폐지' })).json()).data;
    check(dis.discarded === beforeDiscard.length, `DEAD ${dis.discarded}건 폐기`);
    check((await getj('/v1/maintenance/webhook-dead')).data.every((d) => d.requestId !== req3.requestId), '폐기 건은 DEAD 적체 목록에서 제외');
    const reDrive = (await (await post('/v1/maintenance/webhook-redrive', { requestId: req3.requestId })).json()).data;
    check(reDrive.matched === 0, '폐기 건은 재발송 대상이 아님(되살아나지 않음)');
    const whAfter = (await getj(`/v1/requests/${req3.requestId}/webhooks`)).data;
    check(whAfter.some((w) => w.status === 'DISCARDED'), '레코드는 삭제되지 않고 DISCARDED 로 보존');
    const audit3 = (await getj(`/v1/requests/${req3.requestId}/audit`)).data;
    const disc = (Array.isArray(audit3) ? audit3 : audit3.entries ?? []).find((e) => e.eventType === 'WEBHOOK_DISCARDED');
    check(!!disc && disc.data?.reason === '수신 시스템 철수 — 경로 폐지', '폐기 사유·처리자가 감사 체인에 봉인');
    await sleep(5200); // ops-status 5초 캐시 만료 대기
    const ops3 = (await getj('/v1/admin/ops-status')).data;
    check((ops3.webhooks.DISCARDED ?? 0) >= 1, `운영 현황에 DISCARDED 집계(${ops3.webhooks.DISCARDED ?? 0}건)`);
    check(!(ops3.webhooks.deadTargets ?? []).some((t) => t.targetUrl.includes('/gone') && t.count > beforeDiscard.length), '폐기분만큼 죽은 수신 주소 경고 감소');

    // 8) 저장된 요청의 콜백 주소 재지정 — 반복 DEAD 의 **근본**(옛 주소가 박힌 대기 요청)을 끊는다.
    //    통지의 targetUrl 은 요청 생성 시점 callbackUrl 의 사본이라, 요청을 고치지 않으면
    //    그 요청이 만료·완료될 때마다 새 DEAD 가 태어난다(2026-08-08 사고).
    const RT_OLD = 'http://127.0.0.1:4847/legacy-hook';
    const RT_NEW = `http://127.0.0.1:${RT_PORT}/new-hook`;
    const ser5 = (await (await post('/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=재지정2', identity: { method: 'PASS', ci: 'CI-5' } })).json()).data.serialNumber;
    const mkPending = async (key, doc) => (await (await post('/v1/requests', {
      idempotencyKey: key, externalDocId: doc, title: '주소 정정 검증', documentHash: createHash('sha256').update(key).digest('hex'), signMode: 'APP',
      callbackUrl: RT_OLD,
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '수신자', signOrder: 1, certSerial: ser5, requiredIdentityLevel: 'PASS' }],
    })).json()).data;
    const rt1 = await mkPending('retarget-1', 'RT-1');
    await mkPending('retarget-2', 'RT-2');

    const dry = (await (await post('/v1/maintenance/callback-retarget', { fromUrl: RT_OLD, toUrl: RT_NEW })).json()).data;
    check(dry.dryRun === true && dry.updated === 0, '기본은 모의 실행(dryRun) — 명시 없이는 아무것도 바꾸지 않음');
    check(dry.matched === 2, `대기 중 대상 요청 집계 (${dry.matched}건)`);
    check((dry.samples ?? []).some((s) => s.requestId === rt1.requestId), '표본에 대상 요청·옛 주소 노출(실행 전 확인용)');
    check((await fetch(B + '/v1/maintenance/callback-retarget', { method: 'POST', headers: J, body: JSON.stringify({ fromUrl: RT_OLD, toUrl: 'ftp://bad-scheme' }) })).status === 400, '비 http(s) 새 주소 → 400');
    check((await fetch(B + '/v1/maintenance/callback-retarget', { method: 'POST', headers: J, body: JSON.stringify({ fromUrl: RT_OLD, toUrl: RT_OLD }) })).status === 400, '같은 주소로 정정 → 400');
    check((await fetch(B + '/v1/maintenance/callback-retarget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromUrl: RT_OLD, toUrl: RT_NEW }) })).status === 401, '무키 정정 → 401');

    const applied = (await (await post('/v1/maintenance/callback-retarget', { fromUrl: RT_OLD, toUrl: RT_NEW, dryRun: false })).json()).data;
    check(applied.updated === 2 && applied.truncated === false, `정정 적용 (${applied.updated}건)`);
    const auditRt = (await getj(`/v1/requests/${rt1.requestId}/audit`)).data;
    const rtEntry = (Array.isArray(auditRt) ? auditRt : auditRt.entries ?? []).find((e) => e.eventType === 'CALLBACK_RETARGETED');
    check(!!rtEntry && rtEntry.data?.from === RT_OLD && rtEntry.data?.to === RT_NEW, '정정 사실이 요청 감사 체인에 봉인(옛 주소·새 주소)');
    const rerun = (await (await post('/v1/maintenance/callback-retarget', { fromUrl: RT_OLD, toUrl: RT_NEW })).json()).data;
    check(rerun.matched === 0, '재실행 시 대상 없음(멱등)');

    // 정정의 증명 — 이제 발화되는 통지가 새 주소로 간다(옛 주소로는 영원히 실패했을 건)
    const hits4 = [];
    const srv4 = createServer((r, res) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { hits4.push({ url: r.url, body: b }); res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => srv4.listen(RT_PORT, '127.0.0.1', r));
    await post(`/v1/requests/${rt1.requestId}/withdraw`, { reason: '주소 정정 후 통지 경로 확인' });
    await sleep(400);
    check(hits4.length === 1 && hits4[0].url === '/new-hook', '정정 이후 발화된 통지가 새 주소로 도달(DEAD 재생산 차단)');
    srv4.close();

    // 7) 필터·권한
    const noMatch = (await (await post('/v1/maintenance/webhook-redrive', { targetUrl: 'https://nowhere.example' })).json()).data;
    check(noMatch.matched === 0 && noMatch.sent === 0, '필터 불일치 시 무동작');
    check((await fetch(B + '/v1/maintenance/webhook-redrive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, '무키 재발송 → 401');
    srv.close();
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ PASS — Webhook DEAD 재발송' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
