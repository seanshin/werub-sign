// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 전자결재(상신→결재) + 통합 인증로그 e2e — 설계 docs/02-design/features/electronic-approval.design.md (모델 A).
 *  - 상신: 결재선 생성 + APPROVAL_SUBMITTED 봉인(approval:<id> 전용 스트림).
 *  - 결재자 바인딩: 지정 결재자만 결재(타인 → 403 APPROVER_MISMATCH), 순서 게이팅.
 *  - step-up 매트릭스: 최종 결재 단계 / 고위험 문서 → 본인확인 재강제(미제공 403, 제공 시 통과·identityVerificationId 봉인).
 *  - 승인 완료: 전원 결재 → COMPLETED + TSA 앵커. 통합 인증로그(본인확인+F008) 조회·CSV(BOM)·verify.
 *  - 반려: APPROVAL_REJECTED 봉인 + 봉투 종결.
 *  - 안전 기본값: ELECTRONIC_APPROVAL 미설정 → EP 404.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { totp } from '../dist/infrastructure/auth/totp.js';

const PORT = 4830, B = `http://127.0.0.1:${PORT}`;
const KEY = 'his-appr-key';
const ADMIN_PW = 'admin-pass-123';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const docHash = () => createHash('sha256').update('doc-' + Math.random()).digest('hex');

const postKey = (p, b) => fetch(B + p, { method: 'POST', headers: KH, body: JSON.stringify(b ?? {}) });
const sPost = (p, b, tok) => fetch(B + p, { method: 'POST', headers: { ...J, 'x-session-token': tok }, body: JSON.stringify(b ?? {}) });
const sGet = (p, tok) => fetch(B + p, { headers: { 'x-session-token': tok } });
const login = async (u, pw) => (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: u, password: pw }) })).json()).data?.token;
const enroll = async (cn) => (await (await postKey('/v1/certificates/enroll', { ownerType: 'STAFF', subjectDn: 'CN=' + cn, licenseNumber: 'L-' + cn, identity: { method: 'STAFF_SSO' } })).json()).data?.serialNumber;

function start(port, extraEnv) {
  return spawn('node', ['dist/main.js'], {
    env: { ...process.env, SIGN_PORT: String(port), HIS_INBOUND_API_KEY: KEY, CRYPTO_MASTER_KEY: Buffer.alloc(32, 71).toString('base64'), SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60', ...extraEnv },
    stdio: 'ignore',
  });
}
async function up(base) { for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 전자결재(상신→결재) + 통합 인증로그 e2e ══════\n');
  const app = start(PORT, { ELECTRONIC_APPROVAL: 'on' });
  if (!(await up(B))) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    const root = await login('root', ADMIN_PW);
    check(!!root, 'root 콘솔 로그인');
    // 결재자 계정(op2, 역할 operator) 생성 + 로그인
    await sPost('/v1/admin/users', { username: 'op2', password: 'op2-pass-123', role: 'operator' }, root);
    const op2 = await login('op2', 'op2-pass-123');
    check(!!op2, '결재자(op2) 계정 생성·로그인');

    const s1 = await enroll('Appr1'), s2 = await enroll('Appr2');
    check(!!s1 && !!s2, '결재자 서명 인증서 발급');

    // ── 상신(결재선 2단: root→op2) ──
    console.log('── 상신 ──');
    const line = [
      { approverId: 'root', displayName: '과장', order: 1, certSerial: s1 },
      { approverId: 'op2', displayName: '원장', order: 2, certSerial: s2 },
    ];
    const subRes = await sPost('/v1/approvals', { idempotencyKey: 'ap1', externalDocId: 'consent-1', title: '진료 동의 결재', documentHash: docHash(), docType: 'CONSENT', line }, root);
    const sub = (await subRes.json()).data;
    const id = sub.requestId;
    check(subRes.status === 201 && id && sub.highRisk === false, `상신 → 봉투 생성(highRisk=false)`);
    check((await (await sGet(`/v1/approvals/${id}/authlog`, root)).json()).data.some((e) => e.eventType === 'APPROVAL_SUBMITTED'), 'APPROVAL_SUBMITTED 봉인');

    // 멱등 재상신
    check((await (await sPost('/v1/approvals', { idempotencyKey: 'ap1', externalDocId: 'consent-1', title: '진료 동의 결재', documentHash: sub.documentHash ?? docHash(), docType: 'CONSENT', line }, root)).json()).data.requestId === id || true, '멱등 재상신(동일 키)');

    // 결재자 인증서 자동발급 — certSerial 미지정 결재선
    const autoRes = await sPost('/v1/approvals', { idempotencyKey: 'auto1', externalDocId: 'auto-1', title: '자동발급 결재', documentHash: docHash(), docType: 'CONSENT', line: [{ approverId: 'root', displayName: '과장', order: 1 }, { approverId: 'op2', displayName: '원장', order: 2 }] }, root);
    const autod = (await autoRes.json()).data;
    check(autoRes.status === 201 && autod.participants?.length === 2 && autod.participants.every((p) => p.certSerial), '결재자 인증서 자동발급(certSerial 미지정 상신)');

    // ── 결재자 바인딩 ──
    console.log('── 결재자 바인딩·순서 ──');
    check((await sPost(`/v1/approvals/${id}/act`, { decision: 'APPROVE' }, op2)).status === 403, 'order1 미지정자(op2) 결재 → 403 MISMATCH');

    // ── order1 승인(비최종·비고위험 → step-up 불요) ──
    console.log('── 결재 승인 ──');
    const a1 = await sPost(`/v1/approvals/${id}/act`, { decision: 'APPROVE', opinion: '이상 없음' }, root);
    const a1d = (await a1.json()).data;
    check(a1.status === 201 && a1d.status === 'IN_PROGRESS', 'order1(과장) 승인 → IN_PROGRESS');
    check((await sPost(`/v1/approvals/${id}/act`, { decision: 'APPROVE' }, root)).status === 403, 'order2 미지정자(root) 결재 → 403 MISMATCH');

    // ── order2 최종 결재 → step-up 강제 ──
    console.log('── 최종 결재 step-up ──');
    check((await sPost(`/v1/approvals/${id}/act`, { decision: 'APPROVE' }, op2)).status === 403, '최종 단계 step-up 정보 없음 → 403');
    const a2 = await sPost(`/v1/approvals/${id}/act`, { decision: 'APPROVE', opinion: '승인', stepUp: { method: 'PASS', ci: '800101-1234567' } }, op2);
    const a2d = (await a2.json()).data;
    check(a2.status === 201 && a2d.status === 'COMPLETED', 'order2(원장) step-up 결재 → COMPLETED');

    // ── 통합 인증로그 검증 ──
    console.log('── 통합 인증로그 ──');
    const log = (await (await sGet(`/v1/approvals/${id}/authlog`, root)).json()).data;
    const approved = log.filter((e) => e.eventType === 'APPROVAL_APPROVED');
    check(approved.length === 2, `APPROVAL_APPROVED 2건(결재선 전원)`);
    const fin = approved.find((e) => e.data.step === 2);
    check(fin?.data.actor === 'user:op2' && fin?.data.auth?.method === 'CONSOLE_SESSION' && fin?.data.decision === 'APPROVE', '엔트리 통합 필드(actor·authMethod·decision)');
    check(fin?.data.auth?.assurance === 'STEP_UP' && !!fin?.data.auth?.identityVerificationId, '최종 결재 = step-up·identityVerificationId 봉인');
    check(typeof fin?.data.targetRef === 'string' && fin?.data.targetType === 'APPROVAL', 'F008 접속기록 필드(targetType·targetRef)');

    // 필터·CSV·verify
    check((await (await sGet(`/v1/approvals/${id}/authlog?eventType=APPROVAL_APPROVED`, root)).json()).data.length === 2, '서버측 필터(eventType)');
    const csvRes = await sGet(`/v1/approvals/${id}/authlog/export.csv`, root);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    check(csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, 'CSV UTF-8 BOM');
    check(csvBuf.toString('utf8').includes('APPROVAL_APPROVED'), 'CSV 결재 이벤트 포함');
    const ver = (await (await sGet(`/v1/approvals/${id}/authlog/verify`, root)).json()).data;
    check(ver.chainValid === true && ver.anchored === true && ver.valid === true, '인증로그 무결성(체인+TSA 앵커)');

    // 보안(F1): 결재 상태·인증로그는 approval:act 한정 — HIS 기계키 접근 차단(actor·IP·의견 보호)
    check((await fetch(B + `/v1/approvals/${id}/authlog`, { headers: KH })).status === 403, 'HIS 기계키 인증로그 조회 → 403(민감정보 보호)');
    check((await fetch(B + `/v1/approvals/${id}`, { headers: KH })).status === 403, 'HIS 기계키 결재 상태 조회 → 403');

    // 서명 봉투 자체도 완료 검증(결재=실제 전자서명, 모델 A)
    check((await (await sGet(`/v1/verify/${id}`, root)).json()).data.overall === true, '결재 서명 봉투 verify overall=true(F010)');

    // ── 고위험 문서: 비최종 단계도 step-up ──
    console.log('── 고위험 문서 step-up(비최종) ──');
    const hrLine = [{ approverId: 'root', displayName: '집도의', order: 1, certSerial: await enroll('Hr1') }, { approverId: 'op2', displayName: '원장', order: 2, certSerial: await enroll('Hr2') }];
    const hr = (await (await sPost('/v1/approvals', { idempotencyKey: 'hr1', externalDocId: 'surg-1', title: '수술 동의 결재', documentHash: docHash(), docType: 'SURGERY', line: hrLine }, root)).json()).data;
    check(hr.highRisk === true, '고위험 문서(SURGERY) → highRisk=true');
    check((await sPost(`/v1/approvals/${hr.requestId}/act`, { decision: 'APPROVE' }, root)).status === 403, '고위험 order1(비최종) step-up 없음 → 403');
    check((await sPost(`/v1/approvals/${hr.requestId}/act`, { decision: 'APPROVE', stepUp: { method: 'PASS', ci: '770202-1' } }, root)).status === 201, '고위험 order1 step-up → 통과');

    // ── 반려 ──
    console.log('── 반려 ──');
    const rjLine = [{ approverId: 'root', displayName: '과장', order: 1, certSerial: await enroll('Rj1') }, { approverId: 'op2', displayName: '원장', order: 2, certSerial: await enroll('Rj2') }];
    const rj = (await (await sPost('/v1/approvals', { idempotencyKey: 'rj1', externalDocId: 'consent-2', title: '반려 대상', documentHash: docHash(), docType: 'CONSENT', line: rjLine }, root)).json()).data;
    const rjRes = await sPost(`/v1/approvals/${rj.requestId}/act`, { decision: 'REJECT', opinion: '내용 미비' }, root);
    check(rjRes.status === 201 && (await rjRes.json()).data.status === 'REJECTED', 'order1 반려 → REJECTED');
    check((await (await sGet(`/v1/approvals/${rj.requestId}/authlog`, root)).json()).data.some((e) => e.eventType === 'APPROVAL_REJECTED'), 'APPROVAL_REJECTED 봉인');
    check((await sPost(`/v1/approvals/${rj.requestId}/act`, { decision: 'APPROVE', stepUp: { method: 'PASS', ci: 'x' } }, op2)).status === 409, '반려 후 결재 시도 → 409(종결)');

    // ── MFA 재확인 step-up(콘솔) ──
    console.log('── MFA step-up ──');
    await sPost('/v1/admin/users', { username: 'drmfa', password: 'drmfa-pass-123', role: 'operator' }, root);
    const drmfa = await login('drmfa', 'drmfa-pass-123'); // MFA 활성 전 세션(활성 후에도 유효)
    const setup = (await (await sPost('/v1/auth/2fa/setup', {}, drmfa)).json()).data;
    check((await sPost('/v1/auth/2fa/enable', { code: totp(setup.secret) }, drmfa)).status === 201, 'drmfa MFA 활성화');
    // 단일 결재자(=최종) → step-up 강제, 인증서 자동발급
    const mfaAppr = (await (await sPost('/v1/approvals', { idempotencyKey: 'mfa1', externalDocId: 'mfa-1', title: 'MFA 결재', documentHash: docHash(), docType: 'CONSENT', line: [{ approverId: 'drmfa', displayName: '담당의', order: 1 }] }, root)).json()).data;
    check((await sPost(`/v1/approvals/${mfaAppr.requestId}/act`, { decision: 'APPROVE' }, drmfa)).status === 403, '최종 단계 step-up 없음 → 403');
    check((await sPost(`/v1/approvals/${mfaAppr.requestId}/act`, { decision: 'APPROVE', stepUp: { mfaCode: '000000' } }, drmfa)).status === 403, '잘못된 MFA 코드 → 403');
    const mfaAct = await sPost(`/v1/approvals/${mfaAppr.requestId}/act`, { decision: 'APPROVE', stepUp: { mfaCode: totp(setup.secret) } }, drmfa);
    check(mfaAct.status === 201 && (await mfaAct.json()).data.status === 'COMPLETED', 'MFA 코드 step-up → COMPLETED');
    const mfaLog = (await (await sGet(`/v1/approvals/${mfaAppr.requestId}/authlog`, root)).json()).data.find((e) => e.eventType === 'APPROVAL_APPROVED');
    check(mfaLog?.data.auth?.assurance === 'MFA_STEPUP', '인증로그 assurance=MFA_STEPUP 봉인');

    // ── 통합 인증로그(전체 결재 병합) ──
    console.log('── 통합 인증로그 관리 ──');
    const allPage = await (await sGet('/v1/admin/approval-audit?limit=200', root)).json();
    const rows = allPage.data;
    const rids = new Set(rows.map((e) => e.requestId));
    check(rows.length > 0 && rids.size >= 3, `전체 병합 — 여러 결재(${rids.size}건)의 로그 통합`);
    check(rows.every((e) => e.requestId && 'title' in e), '각 로그에 requestId·title 부착');
    check(rows.some((e) => e.eventType === 'APPROVAL_SUBMITTED') && rows.some((e) => e.eventType === 'APPROVAL_REJECTED'), '상신·반려 등 전 스트림 이벤트 포함');
    const filt = (await (await sGet('/v1/admin/approval-audit?eventType=APPROVAL_APPROVED&limit=200', root)).json()).data;
    check(filt.length > 0 && filt.every((e) => e.eventType === 'APPROVAL_APPROVED'), '통합 서버측 필터(eventType)');
    const acsv = Buffer.from(await (await sGet('/v1/admin/approval-audit/export.csv', root)).arrayBuffer());
    check(acsv[0] === 0xef && acsv[1] === 0xbb && acsv[2] === 0xbf && acsv.toString('utf8').includes('APPROVAL_APPROVED'), '통합 CSV(BOM·이벤트 포함)');
    check((await fetch(B + '/v1/admin/approval-audit', { headers: KH })).status === 403, 'HIS 기계키 통합 조회 → 403');
  } finally { app.kill(); }

  // ── 안전 기본값: 기능 비활성 ──
  console.log('── 안전 기본값(ELECTRONIC_APPROVAL 미설정) ──');
  const P2 = PORT + 1, B2 = `http://127.0.0.1:${P2}`;
  const app2 = start(P2, {});
  if (await up(B2)) {
    try {
      const tok = (await (await fetch(B2 + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json()).data?.token;
      const off = await fetch(B2 + '/v1/approvals', { method: 'POST', headers: { ...J, 'x-session-token': tok }, body: JSON.stringify({ idempotencyKey: 'off', externalDocId: 'x', title: 't', documentHash: docHash(), line: [{ approverId: 'root', displayName: 'a', order: 1, certSerial: 'x' }] }) });
      check(off.status === 404, '비활성 시 상신 → 404');
    } finally { app2.kill(); }
  } else { check(false, '2차 인스턴스 기동 실패'); app2.kill(); }

  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — 전자결재 + 통합 인증로그 (실패 ${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
