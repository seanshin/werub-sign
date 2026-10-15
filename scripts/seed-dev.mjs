// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 개발/테스트용 시드 — 인증서·서명요청을 다양한 상태로 생성해 콘솔·연동 테스트를 채운다.
 * 실 서비스 운영 데이터는 별도(운영 단계에서 진행). 본 스크립트는 운영 환경 차단 가드 포함.
 *
 * 사용:
 *   1) 앱 기동(개발): HIS_INBOUND_API_KEY=devkey npm run start  (또는 start:dev)
 *   2) 시드:          SEED_API_KEY=devkey npm run seed:dev
 *
 * 환경변수:
 *   SEED_BASE_URL  기본 http://localhost:4000
 *   SEED_API_KEY   필수 — HIS_INBOUND_API_KEY 또는 CONSOLE_API_KEY 값
 *   SEED_FORCE=1   운영(env=production) 대상에도 강제 실행(기본 차단)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const BASE = process.env.SEED_BASE_URL ?? 'http://localhost:4000';
const KEY = process.env.SEED_API_KEY ?? process.env.HIS_INBOUND_API_KEY ?? process.env.CONSOLE_API_KEY ?? '';
const FORCE = process.env.SEED_FORCE === '1';

if (!KEY) {
  console.error('❌ SEED_API_KEY 미설정 — 앱의 HIS_INBOUND_API_KEY(또는 CONSOLE_API_KEY) 값을 지정하세요.');
  process.exit(1);
}

const H = { 'Content-Type': 'application/json', 'x-api-key': KEY };
const sha256 = async (s) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex');
};
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.data ?? json;
}
const enroll = (ownerType, name, opts = {}) =>
  api('POST', '/v1/certificates/enroll', {
    ownerType,
    subjectDn: `CN=${name},O=Medical Foundation`,
    identity: { method: opts.method ?? (ownerType === 'STAFF' ? 'STAFF_SSO' : 'PASS'), ci: opts.ci ?? `CI_${name}` },
    licenseNumber: opts.license,
    ownerRef: opts.ownerRef,
  });
const createReq = (idem, title, docHash, participants, extra = {}) =>
  api('POST', '/v1/requests', { idempotencyKey: idem, externalDocId: extra.docId ?? idem, title, documentHash: docHash, signMode: extra.signMode ?? 'APP', ttlDays: extra.ttlDays, participants });
const submit = (pid) => api('POST', `/v1/sign/${pid}/submit`, {});

async function main() {
  console.log(`\n🌱 sign 개발 시드 — ${BASE}\n`);

  // ── 운영 차단 가드 ──
  try {
    const ops = await api('GET', '/v1/admin/ops-status');
    if (ops?.config?.env === 'production' && !FORCE) {
      console.error('🛑 대상이 production 입니다. 개발 시드를 차단합니다(실 운영 데이터 오염 방지).');
      console.error('   정말 필요하면 SEED_FORCE=1 로 재실행.');
      process.exit(2);
    }
    console.log(`  대상 env=${ops?.config?.env}, store=${ops?.config?.store?.driver}\n`);
  } catch (e) {
    console.error(`⚠️  ops-status 확인 실패(앱 미기동/키 불일치?): ${e.message}`);
    process.exit(1);
  }

  const out = { certs: {}, requests: [] };
  const doc = async (t) => sha256(`seed-doc-${t}-${Date.now() % 1e6}`);

  // ── 1) 인증서: 환자·의료진·입회·대리 ──
  console.log('① 인증서 발급');
  const patients = [];
  for (const n of ['홍길동', '김환자', '이수술', '박외래']) {
    const c = await enroll('PATIENT', n);
    patients.push({ name: n, serial: c.serialNumber });
    console.log(`   PATIENT ${n}: ${c.serialNumber} (assurance=${c.assuranceLevel})`);
  }
  const doctors = [];
  for (const [n, lic] of [['최의사', 'DOC-1001'], ['정판독', 'DOC-1002']]) {
    const c = await enroll('STAFF', n, { method: 'STAFF_SSO', license: lic });
    doctors.push({ name: n, serial: c.serialNumber });
    console.log(`   STAFF   ${n}: ${c.serialNumber} (lic=${lic})`);
  }
  const witness = await enroll('WITNESS', '입회간호사', { method: 'INPERSON' });
  console.log(`   WITNESS 입회간호사: ${witness.serialNumber}`);
  const proxy = await enroll('PROXY', '보호자김', { method: 'PASS', ci: 'CI_보호자김', ownerRef: patients[2].serial });
  console.log(`   PROXY   보호자김: ${proxy.serialNumber}`);
  out.certs = { patients, doctors, witness: witness.serialNumber, proxy: proxy.serialNumber };

  const P = (c, role = 'PATIENT', order = 1, extra = {}) => ({
    signerRole: role, signerType: extra.signerType ?? role, displayName: extra.displayName ?? role,
    signOrder: order, certSerial: c, requiredIdentityLevel: extra.level ?? 'INPERSON', ...extra.bind,
  });

  // ── 2) 서명요청: 상태별 ──
  console.log('\n② 서명요청(상태별)');

  // COMPLETED ×2 (환자 단독 서명)
  for (let i = 0; i < 2; i++) {
    const p = patients[i];
    const h = await doc(`done${i}`);
    const r = await createReq(`seed-done-${i}`, `외래 사전동의서 #${i + 1}`, h, [P(p.serial, 'PATIENT', 1, { displayName: p.name })], { docId: `EXT-DONE-${i}` });
    await submit(r.participants[0].participantId);
    out.requests.push({ id: r.requestId, state: 'COMPLETED', title: r.title });
    console.log(`   COMPLETED  ${r.requestId} — ${p.name} 서명`);
  }

  // IN_PROGRESS (환자 서명, 의사 SSO 대기)
  {
    const h = await doc('prog');
    const r = await createReq('seed-prog-0', '수술 동의서(의사 서명 대기)', h, [
      P(patients[2].serial, 'PATIENT', 1, { displayName: patients[2].name }),
      P(doctors[0].serial, 'STAFF', 2, { signerType: 'STAFF', displayName: doctors[0].name, level: 'STAFF_SSO' }),
    ], { docId: 'EXT-PROG-0', signMode: 'MIXED' });
    await submit(r.participants[0].participantId); // 환자만 서명
    out.requests.push({ id: r.requestId, state: 'IN_PROGRESS', title: r.title });
    console.log(`   IN_PROGRESS ${r.requestId} — 환자 서명/의사 대기`);
  }

  // CREATED (서명 전)
  {
    const h = await doc('created');
    const r = await createReq('seed-created-0', '검사 동의서(미서명)', h, [P(patients[3].serial, 'PATIENT', 1, { displayName: patients[3].name })], { docId: 'EXT-CREATED-0' });
    out.requests.push({ id: r.requestId, state: 'CREATED', title: r.title });
    console.log(`   CREATED    ${r.requestId} — 미서명`);
  }

  // WITHDRAWN
  {
    const h = await doc('withdraw');
    const r = await createReq('seed-withdraw-0', '마취 동의서(철회됨)', h, [P(patients[0].serial, 'PATIENT', 1, { displayName: patients[0].name })], { docId: 'EXT-WD-0' });
    await api('POST', `/v1/requests/${r.requestId}/withdraw`, { reason: '환자 요청으로 철회(시드)' });
    out.requests.push({ id: r.requestId, state: 'WITHDRAWN', title: r.title });
    console.log(`   WITHDRAWN  ${r.requestId} — 철회`);
  }

  // EXPIRED (ttl=0 후 만료 배치)
  {
    const h = await doc('expire');
    const r = await createReq('seed-expire-0', '동의서(만료됨)', h, [P(patients[1].serial, 'PATIENT', 1, { displayName: patients[1].name })], { docId: 'EXT-EXP-0', ttlDays: 0 });
    const ex = await api('POST', '/v1/maintenance/expire', {});
    out.requests.push({ id: r.requestId, state: 'EXPIRED', title: r.title });
    console.log(`   EXPIRED    ${r.requestId} — 만료(배치 ${ex.expired ?? '?'}건)`);
  }

  // PROXY (대리 서명 — 보호자가 환자 대신)
  {
    const h = await doc('proxy');
    const r = await createReq('seed-proxy-0', '대리 동의서(보호자)', h, [
      P(proxy.serialNumber, 'PROXY', 1, { signerType: 'PROXY', displayName: '보호자김', bind: { relationship: '법정대리인', onBehalfOf: patients[2].serial } }),
    ], { docId: 'EXT-PROXY-0' });
    await submit(r.participants[0].participantId);
    out.requests.push({ id: r.requestId, state: 'COMPLETED(PROXY)', title: r.title });
    console.log(`   PROXY      ${r.requestId} — 보호자 대리 서명(onBehalfOf=${patients[2].name})`);
  }

  // ── 요약 ──
  const byState = out.requests.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  console.log(`\n✅ 시드 완료 — 인증서 ${patients.length + doctors.length + 2}건, 요청 ${out.requests.length}건`);
  console.log(`   상태분포: ${JSON.stringify(byState)}`);
  console.log(`   확인: 관리자 콘솔 /admin/requests · GET ${BASE}/v1/requests (x-api-key)`);
  console.log(`   ※ 재실행 시 인증서는 새로 발급(요청은 idempotencyKey로 멱등). 깔끔한 시드는 빈 DB에서.\n`);
}

main().catch((e) => { console.error(`\n❌ 시드 실패: ${e.message}\n`); process.exit(1); });
