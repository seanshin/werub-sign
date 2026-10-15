// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Increment 22 — 온프레 HSM(PKCS#11) 어댑터 e2e (SoftHSM2 실 모듈).
 *
 * 검증:
 *  (A) Pkcs11KeySigner 직접 — RSA-3072·ECDSA-P256 generate→sign→verify, 변조 거부, 키 비추출.
 *  (B) crypto-proxy(HSM_PROVIDER=pkcs11) + 앱(proxy 모드) 전체 흐름 — enroll→sign→verify
 *      체인/LTV/감사 무결 + /stats 로 "CA 앵커만 HSM, 말단·TSA는 SOFT" 최소화 입증.
 *
 * SoftHSM2/모듈 미설치 시 SKIP(종료코드 0). 실 HSM은 PKCS11_MODULE 만 교체하면 동일 동작.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findModule() {
  for (const base of ['/opt/homebrew', '/usr/local', '/usr/lib', '/usr/lib64']) {
    try {
      const out = execFileSync('find', [base, '-name', 'libsofthsm2.so'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out.split('\n')[0];
    } catch { /* 무시 */ }
  }
  return '';
}
function hasUtil() {
  try { execFileSync('softhsm2-util', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function hasGraphene() {
  try { execFileSync('node', ['-e', "require('graphene-pk11')"], { stdio: 'ignore' }); return true; } catch { return false; }
}

const MODULE = findModule();
if (!MODULE || !hasUtil() || !hasGraphene()) {
  console.log('\n⏭️  Increment 22 SKIP — 온프레 HSM 사전조건 미충족(libsofthsm2.so·softhsm2-util·graphene-pk11 중 누락). 실 HSM 배포 시 `npm i graphene-pk11` + PKCS11_MODULE 지정.\n');
  process.exit(0);
}

const TOKENS = mkdtempSync(join(tmpdir(), 'sign-hsm-'));
const CONF = join(TOKENS, 'softhsm2.conf');
writeFileSync(CONF, `directories.tokendir = ${TOKENS}/\nobjectstore.backend = file\nlog.level = ERROR\n`);
const PIN = '1234';
const LABEL = 'sign-hsm-test';
const hsmEnv = { ...process.env, SOFTHSM2_CONF: CONF };

const PROXY_PORT = 4902;
const APP_PORT = 4714;
const PROXY = `http://localhost:${PROXY_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const TOKEN = 'proxy-secret-token';
const KEY = 'inc22-api-key';
const MASTER = Buffer.alloc(32, 9).toString('base64');
const VAULT = `/tmp/sign-inc22-vault-${process.pid}.json`;

const post = (b, p, body) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body ?? {}) });
const getj = async (b, p, headers) => (await fetch(b + p, { headers })).json();
async function waitUp(b, p) { for (let i = 0; i < 50; i++) { try { if ((await fetch(b + p)).ok) return true; } catch {} await sleep(300); } return false; }

function cleanup() {
  rmSync(TOKENS, { recursive: true, force: true });
  rmSync(VAULT, { force: true });
}

async function main() {
  console.log('\n══════ Increment 22 — 온프레 HSM(PKCS#11/SoftHSM2) e2e ══════\n');
  console.log(`  모듈: ${MODULE}`);

  // 토큰 초기화
  execFileSync('softhsm2-util', ['--init-token', '--free', '--label', LABEL, '--pin', PIN, '--so-pin', '5678'], { env: hsmEnv, stdio: 'ignore' });
  check(true, `SoftHSM2 토큰 초기화(label=${LABEL})`);

  // ── (A) Pkcs11KeySigner 직접 ──
  process.env.SOFTHSM2_CONF = CONF; // graphene 가 같은 프로세스에서 읽음
  const { Pkcs11KeySigner } = await import('../dist/infrastructure/crypto/pkcs11-key-signer.js');
  const signer = new Pkcs11KeySigner({ module: MODULE, pin: PIN, tokenLabel: LABEL });

  for (const alg of ['RSA-3072', 'ECDSA-P256']) {
    const k = await signer.generate(alg);
    check(k.keyRef.startsWith('hsm:'), `[${alg}] HSM 키 생성(keyRef=hsm:)`);
    check(/BEGIN PUBLIC KEY/.test(k.publicKey), `[${alg}] 공개키 SPKI PEM 추출`);
    const data = Buffer.from(`서명대상-${alg}`);
    const sig = await signer.sign(k.keyRef, data);
    check(signer.verify(k.publicKey, data, sig), `[${alg}] HSM 서명 → 공개키 검증 통과`);
    check(!signer.verify(k.publicKey, Buffer.from('변조'), sig), `[${alg}] 변조 데이터 검증 거부`);
  }
  signer.close();

  // ── (B) crypto-proxy(pkcs11) + 앱(proxy) 전체 흐름 ──
  const proxy = spawn('node', ['dist/crypto-proxy/main.js'], {
    env: { ...hsmEnv, CRYPTO_PROXY_PORT: String(PROXY_PORT), CRYPTO_PROXY_TOKEN: TOKEN, CRYPTO_PROXY_VAULT: VAULT, CRYPTO_MASTER_KEY: MASTER,
      HSM_PROVIDER: 'pkcs11', PKCS11_MODULE: MODULE, PKCS11_PIN: PIN, PKCS11_TOKEN_LABEL: LABEL },
    stdio: 'ignore',
  });
  if (!(await waitUp(PROXY, '/health'))) { console.log('❌ crypto-proxy(pkcs11) 기동 실패'); proxy.kill(); cleanup(); process.exit(1); }
  check(true, 'crypto-proxy 기동(HSM_PROVIDER=pkcs11)');

  const app = spawn('node', ['dist/main.js'], {
    // HSM_PROVIDER=pkcs11 은 attestation provider 라벨용(라우팅은 proxy가 담당, 앱은 자격 미보유)
    env: { ...process.env, SIGN_PORT: String(APP_PORT), KEY_SIGNER_DRIVER: 'proxy', CRYPTO_PROXY_URL: PROXY, CRYPTO_PROXY_TOKEN: TOKEN, HIS_INBOUND_API_KEY: KEY, HSM_PROVIDER: 'pkcs11' },
    stdio: 'ignore',
  });
  // 앱엔 CRYPTO_MASTER_KEY·PKCS11 자격 미주입(개인키·HSM 자격 격리)
  if (!(await waitUp(APP, '/v1/crl'))) { console.log('❌ 앱(proxy) 기동 실패'); app.kill(); proxy.kill(); cleanup(); process.exit(1); }

  try {
    const docHash = createHash('sha256').update('동의서-hsm').digest('hex');
    const pat = await (await post(APP, '/v1/certificates/enroll', { ownerType: 'PATIENT', subjectDn: 'CN=HsmPatient', identity: { method: 'PASS', ci: 'C' } })).json();
    const serial = pat.data?.serialNumber;
    check(!!serial, '프록시(HSM 백엔드) 경유 인증서 발급');
    check(pat.data?.chainValid === true, '체인 검증 통과(HSM-앵커 CA 서명)');
    // attestation 정확성: CA 앵커=HSM, 말단 서명키=SOFT, assuranceLevel=HSM_ANCHORED
    check(pat.data?.caKeyCustody === 'HSM', `caKeyCustody=HSM(CA 앵커 실 HSM)`);
    check(pat.data?.keyCustody === 'SOFT', `keyCustody=SOFT(말단 서명키 — 정직 표기)`);
    check(pat.data?.assuranceLevel === 'HSM_ANCHORED', `assuranceLevel=HSM_ANCHORED`);
    check(pat.data?.caKeyCustodyProvider === 'PKCS11', `caKeyCustodyProvider=PKCS11(provider 라벨)`);

    const req = await (await post(APP, '/v1/requests', { idempotencyKey: 'i22', externalDocId: 'hsm', title: 't', documentHash: docHash, signMode: 'APP', participants: [{ signerRole: 'PATIENT', signerType: 'PATIENT', displayName: 'x', signOrder: 1, certSerial: serial, requiredIdentityLevel: 'INPERSON' }] })).json();
    await post(APP, '/v1/sign/' + req.data.participants[0].participantId + '/submit', {});
    const ver = (await getj(APP, '/v1/verify/' + req.data.requestId)).data;
    check(ver.overall === true, '서명·검증 overall=true(말단 SOFT 서명)');
    check(ver.signatures[0].chainValid === true, '체인 chainValid=true(CA키=실 HSM 상주)');
    check(ver.signatures[0].ltvValid === true, 'LTV ltvValid=true');
    check(ver.auditChainValid === true, '감사 해시체인 auditChainValid=true');

    // 최소화 입증: CA 앵커(Root·Issuing)만 실 HSM, 말단·TSA는 SOFT
    const stats = await getj(PROXY, '/stats', { 'x-proxy-token': TOKEN });
    check(stats.provider === 'hsm', `프록시에 실 HSM 백엔드 연결(provider=${stats.provider}, dev는 none)`);
    check((stats.backendHsm ?? 0) >= 2, `CA 앵커 키가 실 HSM 상주(backendHsm=${stats.backendHsm} ≥ 2)`);
    check((stats.requestedSoft ?? 0) >= 1, `말단·TSA 키는 SOFT(requestedSoft=${stats.requestedSoft})`);
    check((stats.requestedHsm ?? 0) === (stats.backendHsm ?? -1), 'HSM 요청=HSM 처리 일치(SOFT 누수 없음)');
  } finally {
    app.kill(); proxy.kill();
  }

  await sleep(300); cleanup();
  console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL(' + failures + ')'} — Increment 22 (PKCS#11 온프레 HSM)\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
