// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 개발 테스트용 STAFF 인증서 일괄 발급 — 의료진별 인증서 발급 후 serial 출력.
 * 출력 serial은 ① sign-side 테스트(token:test로 staff-token 민팅) ② HIS user.signCertSerial 매핑에 사용.
 *
 * 사용:
 *   SEED_API_KEY=<key> node scripts/seed-staff.mjs
 *   STAFF_LIST='[{"name":"김외과","license":"MD-1001","ref":"user-1","role":"DOCTOR"}]' SEED_API_KEY=<key> node scripts/seed-staff.mjs
 *
 * 환경변수: SEED_BASE_URL(기본 http://localhost:4000) · SEED_API_KEY(필수) · STAFF_LIST(JSON, 미지정 시 기본 테스트셋) · SEED_FORCE=1(운영 차단 우회)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const BASE = process.env.SEED_BASE_URL ?? 'http://localhost:4000';
const KEY = process.env.SEED_API_KEY ?? process.env.HIS_INBOUND_API_KEY ?? process.env.CONSOLE_API_KEY ?? '';
const FORCE = process.env.SEED_FORCE === '1';
if (!KEY) { console.error('❌ SEED_API_KEY 미설정'); process.exit(1); }

const DEFAULT_STAFF = [
  { name: '김외과', license: 'MD-1001', ref: 'staff-surgeon-1', role: 'DOCTOR', dept: '외과' },
  { name: '이마취', license: 'MD-1002', ref: 'staff-anesth-1', role: 'DOCTOR', dept: '마취과' },
  { name: '박판독', license: 'MD-1003', ref: 'staff-radio-1', role: 'DOCTOR', dept: '영상의학과' },
  { name: '최판독', license: 'MD-1004', ref: 'staff-radio-2', role: 'DOCTOR', dept: '영상의학과' },
  { name: '정내과', license: 'MD-1005', ref: 'staff-internal-1', role: 'DOCTOR', dept: '내과' },
];

const H = { 'Content-Type': 'application/json', 'x-api-key': KEY };
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  return json.data ?? json;
}

async function main() {
  console.log(`\n👥 STAFF 인증서 일괄 발급 — ${BASE}\n`);
  // 운영 차단 가드
  try {
    const ops = await api('GET', '/v1/admin/ops-status');
    if (ops?.config?.env === 'production' && !FORCE) {
      console.error('🛑 production 대상 — 개발 시드 차단. 필요 시 SEED_FORCE=1.');
      process.exit(2);
    }
    console.log(`  대상 env=${ops?.config?.env}, CA issuing=${ops?.ca?.issuingSerial}\n`);
  } catch (e) { console.error(`⚠️ ops-status 확인 실패: ${e.message}`); process.exit(1); }

  const staff = process.env.STAFF_LIST ? JSON.parse(process.env.STAFF_LIST) : DEFAULT_STAFF;
  const out = [];
  for (const s of staff) {
    const cert = await api('POST', '/v1/certificates/enroll', {
      ownerType: 'STAFF',
      subjectDn: `CN=${s.name},O=Medical Foundation,C=KR`,
      identity: { method: 'STAFF_SSO' },
      licenseNumber: s.license,
      ownerRef: s.ref,
    });
    out.push({ name: s.name, dept: s.dept ?? '-', license: s.license, ref: s.ref ?? '-', role: s.role ?? 'DOCTOR', serialNumber: cert.serialNumber, assuranceLevel: cert.assuranceLevel });
    console.log(`  ✅ ${s.name}(${s.dept ?? s.role}) lic=${s.license} → ${cert.serialNumber}`);
  }

  console.log(`\n발급 완료: ${out.length}명 (assurance=${out[0]?.assuranceLevel})`);
  console.log('\n── HIS 매핑용 (user.signCertSerial) ──');
  console.log(JSON.stringify(out.map((o) => ({ ref: o.ref, role: o.role, signCertSerial: o.serialNumber })), null, 2));
  console.log('\n── sign-side 서명 테스트 (각 의료진 staff-token 민팅) ──');
  out.forEach((o) => console.log(`  CERT_SERIAL=${o.serialNumber} SUB=${o.ref} ROLE=${o.role} npm run token:test`));
  console.log('  → 민팅 토큰을 POST /v1/sign/staff 의 Bearer로 사용(채널 STAFF facade로 요청 생성 후).\n');
}
main().catch((e) => { console.error(`\n❌ 실패: ${e.message}\n`); process.exit(1); });
