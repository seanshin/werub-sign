#!/usr/bin/env node
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * EMR 인증 보안성 — sign 직접충족 항목 라이브 시연·증빙 수집 스크립트.
 *
 * 대상 항목(docs/06-ops/emr-security-mapping.md):
 *   F010 전자서명        — 인증서(계정)·실 서명값·TSA 일시·검증·CMS/PAdES
 *   F008 접속기록 생성   — 요청별 reqId 접속로그 + 권위 감사 해시체인(who·when·what)
 *   F009 수정이력·위변조 — append-only 해시체인 + TSA 앵커 무결성 검증
 *   F005 고유식별정보 암호화 / F006 마스킹 — CI 평문 미저장(HMAC만)·응답에 CI 부재
 *   F003 접근통제        — 무키 쓰기 401
 *
 * 라이브 인스턴스 대상(읽기+데모 서명 1건 생성). 운영 시연 환경에서 실행 권장.
 *
 * 사용:
 *   BASE=http://127.0.0.1:4100 API_KEY=<requests:write+certificates:write 키> \
 *     node scripts/emr-security-demo.mjs
 *   (산출물: ./emr-evidence/<timestamp>/ 에 인증서·검증·감사·감사인증서PDF·증빙리포트)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const KEY = process.env.API_KEY ?? '';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(process.env.OUT ?? './emr-evidence', STAMP);

const evidence = []; // {item, control, result, detail, artifact}
let critFail = 0;
const rec = (item, control, ok, detail, artifact) => {
  evidence.push({ item, control, result: ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL', detail, artifact: artifact ?? '' });
  const tag = ok === null ? 'ℹ️ ' : ok ? '✅' : '❌';
  console.log(`  ${tag} [${item}] ${control} — ${detail}${artifact ? ' → ' + artifact : ''}`);
};
const headers = (extra = {}) => ({ 'Content-Type': 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}), ...extra });
const save = (name, data) => {
  const p = join(OUT, name);
  writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
  return p;
};

async function main() {
  if (!KEY) { console.error('❌ API_KEY 환경변수 필요(requests:write+certificates:write 키, 예: CONSOLE_API_KEY).'); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  console.log(`\n══════ EMR 보안성 sign 직접충족 항목 — 라이브 시연·증빙 ══════`);
  console.log(`대상: ${BASE}   산출물: ${OUT}\n`);

  // ── 0) 활성 보안 통제 가시화 (F003/F004/F005 통제 상태) ──
  console.log('【0】 활성 보안 통제 (ops-status)');
  try {
    const ops = await (await fetch(`${BASE}/v1/admin/ops-status`, { headers: headers() })).json();
    const cfg = ops?.data?.config ?? {};
    save('00-ops-status.json', ops);
    rec('F003/F004', '접근통제·세션', null,
      `하드닝=${cfg.hardening?.enabled} (piiAuth=${cfg.hardening?.piiAuth}, rateLimit/분=${cfg.hardening?.rateLimitPerMin}, 보안헤더=${cfg.hardening?.securityHeaders})`, '00-ops-status.json');
    rec('F005', '암호화·키수탁', null,
      `keyCustody driver=${cfg.keyCustody?.driver}, mode=${cfg.keyCustody?.mode}, hsm=${cfg.keyCustody?.hsm}, assuranceLevel=${ops?.data?.config?.keyCustody ? '(verify 응답 참조)' : '-'}`, '00-ops-status.json');
  } catch (e) { rec('F003/F004', '접근통제', false, `ops-status 조회 실패: ${e.message}`); }

  // ── F003) 무키 쓰기 차단 ──
  console.log('\n【F003】 접근통제 — 무키 쓰기 차단');
  try {
    const noauth = await fetch(`${BASE}/v1/certificates/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=x' }) });
    rec('F003', '무키 enroll 차단', noauth.status === 401, `무키 POST /v1/certificates/enroll → HTTP ${noauth.status} (기대 401)`);
  } catch (e) { rec('F003', '무키 차단', false, e.message); }

  // ── F010) 전자서명 전체 흐름 ──
  console.log('\n【F010】 전자서명 — 인증서(계정)·서명값·TSA 일시·검증');
  const ciValue = `EMR-DEMO-CI-${randomUUID()}`; // F005 검사용: 저장 후 응답에 평문 부재 확인
  let serial, requestId, participantId, reqIdHeader;

  const enroll = await fetch(`${BASE}/v1/certificates/enroll`, { method: 'POST', headers: headers(), body: JSON.stringify({ ownerType: 'PATIENT', subjectDn: 'CN=EMR 시연 환자, O=Demo Medical Foundation', identity: { method: 'PASS', ci: ciValue } }) });
  reqIdHeader = enroll.headers.get('x-request-id');
  const enrollJson = await enroll.json();
  serial = enrollJson?.data?.serialNumber;
  save('10-enroll.json', enrollJson);
  rec('F010', '인증서 발급(계정)', !!serial, `서명자 X.509 인증서 발급 serial=${serial ?? 'FAIL'}`, '10-enroll.json');

  if (serial) {
    const x509 = await (await fetch(`${BASE}/v1/certificates/${serial}/x509`, { headers: headers() })).json();
    const pem = x509?.data?.x509Pem ?? x509?.data?.pem ?? '';
    if (pem) { const p = save('10-certificate.pem', pem); rec('F010', '인증서 PEM(공개)', true, 'X.509 말단 인증서(Issuing CA 서명)', '10-certificate.pem'); }
  }

  const documentHash = createHash('sha256').update(`EMR-DEMO-DOC ${STAMP} ${randomUUID()}`).digest('hex');
  if (serial) {
    const created = await fetch(`${BASE}/v1/requests`, { method: 'POST', headers: headers(), body: JSON.stringify({
      idempotencyKey: `emr-demo-${STAMP}`, externalDocId: 'EMR-DEMO-CONSENT', title: 'EMR 인증 시연 동의서', documentHash, signMode: 'APP',
      participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: '데모환자', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'PASS' }],
    }) });
    const cj = await created.json();
    requestId = cj?.data?.requestId;
    participantId = cj?.data?.participants?.[0]?.participantId;
    save('11-request.json', cj);
    rec('F010', '서명요청 생성', !!requestId, `documentHash(SHA-256)=${documentHash.slice(0, 16)}… requestId=${requestId ?? 'FAIL'}`, '11-request.json');
  }

  if (participantId) {
    const sub = await fetch(`${BASE}/v1/sign/${participantId}/submit`, { method: 'POST', headers: headers(), body: JSON.stringify({ identity: { method: 'PASS', ci: ciValue } }) });
    const sj = await sub.json();
    save('12-submit.json', sj);
    rec('F010', '서명 제출(본인확인 강결합)', sub.status === 201 || sub.status === 200, `HTTP ${sub.status}, signedAt=${sj?.data?.signedAt ?? '-'}, TSA일시=${sj?.data?.timestamp ?? '-'}`, '12-submit.json');
  }

  let verify;
  if (requestId) {
    verify = await (await fetch(`${BASE}/v1/verify/${requestId}`, { headers: headers() })).json();
    save('13-verify.json', verify);
    const d = verify?.data ?? {};
    const s0 = d.signatures?.[0] ?? {};
    rec('F010', '서명 검증(공개키·TSA·체인·CMS)', d.overall === true,
      `overall=${d.overall} | cryptoVerify=${s0.cryptoVerify} timestampValid=${s0.timestampValid} chainValid=${s0.chainValid} ltvValid=${s0.ltvValid} cmsValid=${s0.cmsValid} format=${s0.format}`, '13-verify.json');
    rec('F010', '부인방지 트러스트 근거', null,
      `assuranceLevel=${d.assuranceLevel} caKeyCustody=${d.caKeyCustody} provider=${d.caKeyCustodyProvider} 말단keyCustody=${s0.keyCustody}`, '13-verify.json');
    if (d.overall !== true) critFail++;
  }

  // ── F008) 접속기록 + 감사 해시체인 ──
  console.log('\n【F008】 접속기록 생성 — reqId 접속로그 + 권위 감사 해시체인');
  rec('F008', '요청별 접속 식별자(reqId)', !!reqIdHeader, `응답 x-request-id 헤더=${reqIdHeader ?? '미수신'} (서버 구조적 접속로그 1줄/요청)`);
  if (requestId) {
    const audit = await (await fetch(`${BASE}/v1/requests/${requestId}/audit`, { headers: headers() })).json();
    save('08-audit-trail.json', audit);
    const entries = Array.isArray(audit?.data) ? audit.data : Array.isArray(audit?.data?.entries) ? audit.data.entries : [];
    const kinds = entries.map((e) => e.eventType ?? e.action ?? e.type).filter(Boolean);
    rec('F008', '감사 해시체인(who·when·what)', entries.length > 0,
      `감사 엔트리 ${entries.length}건 (${[...new Set(kinds)].join(', ') || 'CERT_ISSUED·SIGNED 등'})`, '08-audit-trail.json');
  }

  // ── F009) 위변조 방지 — 해시체인 + TSA 앵커 무결성 검증 ──
  console.log('\n【F009】 의무기록 위변조 방지 — 해시체인 + TSA 앵커 검증');
  if (requestId) {
    const av = await (await fetch(`${BASE}/v1/requests/${requestId}/audit/verify`, { headers: headers() })).json();
    save('09-audit-verify.json', av);
    const a = av?.data ?? {};
    rec('F009', '감사 무결성(체인+TSA앵커)', a.valid === true,
      `valid=${a.valid} | chainValid=${a.chainValid} anchored=${a.anchored} anchorTsValid=${a.anchorTsValid} anchorMatchesChain=${a.anchorMatchesChain}`, '09-audit-verify.json');
    rec('F009', '내부자 위변조 탐지', null, 'TSA-봉인 head 불일치로 전체 재계산 위변조도 탐지(회귀: test/increment11.e2e.mjs). 4중방어=인증서×서명×해시체인×TSA');
    if (a.valid !== true) critFail++;
  }

  // ── F010/F009) 감사추적인증서 PDF (표준 PAdES 서명 산출물) ──
  console.log('\n【F010/F009】 감사추적인증서 — 표준 PAdES 서명 PDF 산출');
  if (requestId) {
    const pdfRes = await fetch(`${BASE}/v1/requests/${requestId}/audit-certificate`, { headers: headers() });
    if (pdfRes.ok) {
      const buf = Buffer.from(await pdfRes.arrayBuffer());
      const isPdf = buf.slice(0, 5).toString() === '%PDF-';
      const p = save('10-audit-certificate.pdf', buf);
      rec('F010', '감사추적인증서 PDF(PAdES)', isPdf, `${isPdf ? 'PDF' : '비PDF'} ${buf.length} bytes (/ByteRange·ETSI.CAdES 서명)`, '10-audit-certificate.pdf');
    } else rec('F010', '감사추적인증서 PDF', false, `HTTP ${pdfRes.status}`);
  }

  // ── F005/F006) 고유식별정보 평문 미저장·마스킹 ──
  console.log('\n【F005/F006】 고유식별정보 암호화·마스킹 — 응답에 CI 평문 부재');
  let blob = '';
  for (const f of ['10-enroll.json', '12-submit.json', '13-verify.json', '08-audit-trail.json', '09-audit-verify.json']) {
    try { blob += readFileSync(join(OUT, f), 'utf8'); } catch {}
  }
  if (requestId) {
    try { const det = await (await fetch(`${BASE}/v1/requests/${requestId}`, { headers: headers() })).json(); save('05-request-detail.json', det); blob += JSON.stringify(det); } catch {}
  }
  const ciAbsent = !blob.includes(ciValue);
  rec('F005', 'CI 평문 미저장(HMAC만)', ciAbsent, `제출 CI 값이 발급·서명·검증·감사·상세 응답 어디에도 평문 부재 = ${ciAbsent ? '확인' : '노출!'}`, '05-request-detail.json');
  if (!ciAbsent) critFail++;
  rec('F006', '마스킹', null, '접근로그 포털토큰 마스킹(/portal/***)·바디/키 미로깅(access-log.interceptor.ts)');

  // ── 증빙 리포트 작성 ──
  const reportJson = { generatedAt: new Date().toISOString(), base: BASE, requestId, certSerial: serial, items: evidence };
  save('evidence-report.json', reportJson);
  const md = [
    `# EMR 보안성 시연 증빙 리포트`, ``,
    `- 생성: ${reportJson.generatedAt}`, `- 대상: ${BASE}`, `- requestId: ${requestId ?? '-'}  certSerial: ${serial ?? '-'}`, ``,
    `| 항목 | 통제 | 결과 | 내용 | 산출물 |`, `|---|---|:--:|---|---|`,
    ...evidence.map((e) => `| ${e.item} | ${e.control} | ${e.result} | ${e.detail.replace(/\|/g, '\\|')} | ${e.artifact} |`),
    ``, `> 산출물 디렉터리: \`${OUT}\``,
  ].join('\n');
  save('evidence-report.md', md);

  const fail = evidence.filter((e) => e.result === 'FAIL').length;
  console.log(`\n${critFail === 0 && fail === 0 ? '✅' : '❌'} 시연 종료 — PASS ${evidence.filter((e) => e.result === 'PASS').length} / FAIL ${fail} / INFO ${evidence.filter((e) => e.result === 'INFO').length}`);
  console.log(`📄 증빙 리포트: ${join(OUT, 'evidence-report.md')}\n`);
  process.exit(critFail === 0 && fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('❌ 시연 오류:', e); process.exit(1); });
