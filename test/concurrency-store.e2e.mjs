// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 저장소 동시성 e2e (R16) — `docs/01-plan/audit-2026-07-28-followups.md` §2 R16.
 *
 * `KeyedMutex`·`appendSerialized` 는 **인프로세스**라 수평 확장·롤링 배포에서 두 프로세스가
 * 같은 배열 슬롯을 RMW 하거나 같은 prevHash 를 읽어 감사 체인이 분기할 수 있었다.
 * 대응: 메타 슬롯은 **버전 일치 CAS**(`saveMetaIfUnchanged`), 감사 체인은 **저장소 유니크 제약**
 * (마이그레이션 0009)으로 분기를 거부하고 재조회 후 재시도한다.
 *
 * 어댑터 수준 시맨틱(CAS 성공/거부·체인 분기 거부)은 `npm run contract:prisma` 가,
 * 실 PostgreSQL 인덱스는 CI 의 `prisma migrate deploy` 가 검증한다.
 * 본 테스트는 **그 배관을 끼운 뒤에도 정상 동작이 깨지지 않는지**를 HTTP 경로로 확인한다 —
 * 특히 CAS 재시도로 mutate 콜백이 재실행돼도 결과가 어긋나지 않아야 한다(멱등 플래그·중복 감사).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PORT = 4853, B = `http://127.0.0.1:${PORT}`;
const KEY = 'conc-his-key';
const ADMIN_PW = 'admin-pass-123';

let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 77).toString('base64'),
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60',
      GENERAL_CONTRACTS: 'on',
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch { /* 기동 대기 */ } await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 저장소 동시성 e2e (R16) ══════\n');
  const srv = start();
  if (!(await up())) { console.error('서버 기동 실패'); srv.kill(); process.exit(1); }
  try {
    const root = (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json()).data?.token;
    const sPost = (p, b) => fetch(B + p, { method: 'POST', headers: { ...J, 'x-session-token': root }, body: JSON.stringify(b ?? {}) });
    const sGet = (p) => fetch(B + p, { headers: { 'x-session-token': root } });
    const sDel = (p) => fetch(B + p, { method: 'DELETE', headers: { 'x-session-token': root } });
    const sPut = (p, bytes) => fetch(B + p, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: bytes });
    const jd = async (r) => (await r.json()).data;

    // ── ① 공용 배열 슬롯 동시 쓰기 — lost update 없음 ──
    console.log('── 공용 슬롯 동시 쓰기(주소록) ──');
    const N = 24;
    const abRes = await Promise.all(Array.from({ length: N }, (_, i) =>
      sPost('/v1/contracts/addressbook', { email: `conc${i}@example.com`, name: `동시${i}`, org: '테스트' })));
    check(abRes.every((r) => r.status === 201 || r.status === 200), `주소록 동시 추가 ${N}건 — 전부 성공(5xx 없음)`);
    const ab = await jd(await sGet('/v1/contracts/addressbook?limit=200'));
    const abEmails = new Set(ab.map((e) => e.email));
    const abMissing = Array.from({ length: N }, (_, i) => `conc${i}@example.com`).filter((e) => !abEmails.has(e));
    check(abMissing.length === 0, `동시 추가분 전건 보존 — 유실 0`, abMissing.length ? `유실: ${abMissing.slice(0, 3).join(',')}` : `${ab.length}건`);

    // 동시 삭제도 서로의 결과를 되돌리지 않는다
    const delIds = ab.filter((e) => e.email.startsWith('conc')).slice(0, 8).map((e) => e.id);
    await Promise.all(delIds.map((id) => sDel(`/v1/contracts/addressbook/${id}`)));
    const ab2 = await jd(await sGet('/v1/contracts/addressbook?limit=200'));
    check(delIds.every((id) => !ab2.some((e) => e.id === id)), '동시 삭제 8건 — 전부 반영(부활 없음)');
    check(ab2.filter((e) => e.email.startsWith('conc')).length === N - delIds.length, `삭제 후 잔여 = ${N - delIds.length}건(다른 항목 소실 없음)`);

    // ── ② 프리셋 동시 upsert ──
    console.log('── 프리셋 동시 upsert ──');
    const P = 12;
    const prRes = await Promise.all(Array.from({ length: P }, (_, i) =>
      sPost('/v1/contracts/presets', { name: `동시프리셋${i}`, signers: [{ kind: 'EXTERNAL', displayName: `상대${i}`, email: `p${i}@example.com`, order: 1 }] })));
    check(prRes.every((r) => r.ok), `프리셋 동시 생성 ${P}건 — 전부 성공`);
    const presets = await jd(await sGet('/v1/contracts/presets'));
    const prMissing = Array.from({ length: P }, (_, i) => `동시프리셋${i}`).filter((n) => !presets.some((p) => p.name === n));
    check(prMissing.length === 0, '프리셋 전건 보존 — 유실 0', prMissing.length ? `유실: ${prMissing.join(',')}` : `${presets.length}건`);
    // 같은 이름 동시 upsert → 중복 생성 없이 1건으로 수렴
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      sPost('/v1/contracts/presets', { name: '경합프리셋', title: `t${i}`, signers: [{ kind: 'EXTERNAL', displayName: '상대', email: 'race@example.com', order: 1 }] })));
    const dup = (await jd(await sGet('/v1/contracts/presets'))).filter((p) => p.name === '경합프리셋');
    check(dup.length === 1, '같은 이름 동시 upsert 6건 → 1건으로 수렴(중복 생성 없음)', `${dup.length}건`);

    // ── ③ 감사 체인 — 동시 append 후에도 단일 선형 ──
    console.log('── 감사 체인 동시 append ──');
    const ctBody = { idempotencyKey: 'conc-ct', externalDocId: 'CONC-1', title: '동시성 계약', documentHash: sha(PDF), accessCode: 'conc-1234', signers: [{ kind: 'EXTERNAL', displayName: '외부', email: 'conc@example.com', order: 1 }] };
    const ct = await jd(await sPost('/v1/contracts', ctBody));
    await sPut(`/v1/contracts/${ct.requestId}/document`, PDF);
    const att = await jd(await fetch(B + `/v1/contracts/${ct.requestId}/attachments?name=${encodeURIComponent('첨부.pdf')}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-session-token': root }, body: PDF }));

    // 첨부 다운로드는 매번 CONTRACT_ATTACHMENT_ACCESSED 를 같은 스트림에 append 한다 — 분기 최다 발생 지점
    const D = 20;
    const dls = await Promise.all(Array.from({ length: D }, () => fetch(B + `/v1/contracts/${ct.requestId}/attachments/${att.attachId}`, { headers: { 'x-session-token': root } })));
    check(dls.every((r) => r.status === 200), `첨부 동시 다운로드 ${D}건 — 전부 200`);
    await sleep(300);
    const log = await jd(await sGet(`/v1/contracts/${ct.requestId}/log`));
    const accessed = log.filter((e) => e.eventType === 'CONTRACT_ATTACHMENT_ACCESSED');
    check(accessed.length === D, `접근 감사 ${D}건 전건 기록(유실 없음)`, `${accessed.length}건`);
    // 체인 선형성 — prevHash 가 직전 entryHash 와 이어지고, 같은 prevHash 가 두 번 나오지 않는다
    const prevs = log.map((e) => e.prevHash);
    check(new Set(prevs).size === prevs.length, '체인 분기 없음 — prevHash 전부 유일');
    const linear = log.every((e, i) => i === 0 || e.prevHash === log[i - 1].entryHash);
    check(linear, '체인 선형 — prevHash = 직전 entryHash');
    const v = await jd(await fetch(B + `/v1/requests/${ct.requestId}/audit/verify`));
    check(v?.chain?.valid !== false, '감사 무결성 검증 통과');

    // ── ④ CAS 재시도 안전성 — 멱등 플래그가 재실행에도 어긋나지 않음 ──
    console.log('── 보관/복원 동시 요청(멱등) ──');
    const arRes = await Promise.all([
      sPost(`/v1/contracts/${ct.requestId}/archive`, { reason: '동시성 검증' }),
      sPost(`/v1/contracts/${ct.requestId}/archive`, { reason: '동시성 검증' }),
      sPost(`/v1/contracts/${ct.requestId}/archive`, { reason: '동시성 검증' }),
    ]);
    check(arRes.every((r) => r.ok), '동시 보관 3건 — 전부 성공(멱등)');
    const arLog = await jd(await sGet(`/v1/contracts/${ct.requestId}/log`));
    check(arLog.filter((e) => e.eventType === 'CONTRACT_ARCHIVED').length === 1, '보관 감사 1건만 기록(재시도 중복 없음)');
    const detail = await jd(await sGet(`/v1/contracts/${ct.requestId}`));
    check(detail?.archived === true, '보관 상태 반영');
    // 필터 캐시(ct*)와 meta 정본의 일치 — 보관함에 보이고 계약함에서 빠져야 한다
    const boxed = (await jd(await sGet('/v1/contracts?archived=true&limit=200'))).items;
    const open = (await jd(await sGet('/v1/contracts?limit=200'))).items;
    check(boxed.some((c) => c.requestId === ct.requestId), '보관함 목록에 노출(캐시 동기화)');
    check(!open.some((c) => c.requestId === ct.requestId), '계약함 목록에서 제외(캐시 동기화)');

    await Promise.all([sPost(`/v1/contracts/${ct.requestId}/unarchive`, {}), sPost(`/v1/contracts/${ct.requestId}/unarchive`, {})]);
    const unLog = await jd(await sGet(`/v1/contracts/${ct.requestId}/log`));
    check(unLog.filter((e) => e.eventType === 'CONTRACT_UNARCHIVED').length === 1, '복원 감사 1건만 기록(멱등)');

    // ── ⑤ 관리자 전역 스트림(admin:auth) 동시 append ──
    console.log('── 관리자 감사 스트림 동시 append ──');
    const L = 10;
    await Promise.all(Array.from({ length: L }, () => fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: 'wrong-password' }) })));
    await sleep(300);
    const aLog = await jd(await sGet('/v1/admin/audit?stream=admin:auth&limit=200'));
    const aPrevs = aLog.map((e) => e.prevHash);
    check(new Set(aPrevs).size === aPrevs.length, 'admin:auth — 동시 로그인 실패 append 후에도 prevHash 유일(분기 없음)');
    check(aLog.every((e, i) => i === 0 || e.prevHash === aLog[i - 1].entryHash), 'admin:auth — 체인 선형');

    console.log('\n' + (failures === 0 ? '✅ 저장소 동시성(R16) 전부 통과' : `❌ ${failures}건 실패`));
  } finally {
    srv.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
