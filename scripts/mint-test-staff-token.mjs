// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 테스트용 STAFF SSO 토큰 민팅 (aud=sign) — PACS/HIS 종단검증(flow A) 보조.
 * 운영에선 HIS가 staff-token을 발급하지만, 실 HIS 없이 sign 서명 흐름을 검증하려면
 * 본 스크립트로 (a) sign에 주입할 JWKS + (b) Bearer 토큰을 한 쌍으로 생성한다.
 *
 * 사용:
 *   CERT_SERIAL=<STAFF 인증서 serial> node scripts/mint-test-staff-token.mjs
 *   → 출력된 JWKS를 sign에 HIS_SSO_JWKS_JSON 으로 주입(테스트 인스턴스) 후,
 *     출력된 토큰을 POST /v1/sign/staff 의 Authorization: Bearer 로 사용.
 *
 * 환경변수:
 *   CERT_SERIAL  STAFF sign 인증서 serial(먼저 enroll로 발급). sign_cert_serial 클레임.
 *   SUB(기본 doctor-1) · ROLE(DOCTOR) · ISS(hospitalrun) · AUD(sign) · EXP(10m)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const SUB = process.env.SUB ?? 'doctor-1';
const ROLE = process.env.ROLE ?? 'DOCTOR';
const ISS = process.env.ISS ?? 'hospitalrun';
const AUD = process.env.AUD ?? 'sign';
const EXP = process.env.EXP ?? '10m';
const CERT_SERIAL = process.env.CERT_SERIAL ?? '';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-staff-1';
jwk.alg = 'RS256';
jwk.use = 'sig';
const jwks = { keys: [jwk] };

const token = await new SignJWT({
  role: ROLE,
  employee_number: 'E-TEST-1',
  name: '테스트의사',
  sign_cert_serial: CERT_SERIAL || undefined, // STAFF 인증서 바인딩
  acr: 'urn:inperson',
})
  .setProtectedHeader({ alg: 'RS256', kid: 'test-staff-1' })
  .setIssuer(ISS)
  .setAudience(AUD)
  .setSubject(SUB)
  .setIssuedAt()
  .setExpirationTime(EXP)
  .sign(privateKey);

console.log('\n═══ 테스트 STAFF 토큰 (aud=sign) ═══\n');
if (!CERT_SERIAL) {
  console.log('⚠️  CERT_SERIAL 미지정 — 먼저 STAFF 인증서 발급 후 serial 지정 권장:');
  console.log('    curl -XPOST $B/v1/certificates/enroll -H "x-api-key: $K" -d \'{"ownerType":"STAFF","subjectDn":"CN=의사,O=병원,C=KR","licenseNumber":"MD-1001","identity":{"method":"STAFF_SSO"}}\'\n');
}
console.log('① sign 테스트 인스턴스에 주입(env):');
console.log(`   HIS_SSO_JWKS_JSON='${JSON.stringify(jwks)}'`);
console.log(`   HIS_SSO_ISSUER=${ISS}`);
console.log(`   HIS_SSO_AUDIENCE=${AUD}\n`);
console.log('② Bearer 토큰:');
console.log(`   ${token}\n`);
console.log('③ 서명 호출(예):');
console.log(`   curl -XPOST $B/v1/sign/staff -H 'content-type: application/json' \\`);
console.log(`     -H 'authorization: Bearer ${token.slice(0, 24)}...' -d '{"participantId":"<pid>"}'\n`);
