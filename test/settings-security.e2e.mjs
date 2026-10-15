// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 연동 설정 보안 보완 회귀가드 (security-architect 리뷰 HIGH-1·MEDIUM-1).
 *  HIGH-1: 하드닝/운영에서 CRYPTO_MASTER_KEY 미설정 시 SecretBox 약한 dev키 폴백 금지 → 부팅 거부.
 *  MEDIUM-1: 연동 endpoint 필드 SSRF 차단(하드닝 시 https·공인망 강제).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };

function boot(port, env) {
  return spawn('node', ['dist/main.js'], { env: { ...process.env, SIGN_PORT: String(port), ...env }, stdio: 'ignore' });
}
async function waitHealthy(port, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch {} await sleep(300); }
  return false;
}

async function main() {
  console.log('\n══════ 연동 설정 보안 보완 e2e ══════\n');

  // HIGH-1: 하드닝 + 마스터키 미설정 → 부팅 실패(SecretBox throw)
  const p1 = boot(4741, { SECURITY_HARDENING: 'true', HIS_INBOUND_API_KEY: 'k', CRYPTO_MASTER_KEY: '' });
  const up1 = await waitHealthy(4741, 6000);
  check(!up1, 'HIGH-1: 하드닝+마스터키 미설정 → 부팅 거부(health 안뜸)');
  p1.kill();

  // 대조: 하드닝 + 정상 마스터키 → 정상 부팅
  const KEY = Buffer.alloc(32, 41).toString('base64');
  const p2 = boot(4742, { SECURITY_HARDENING: 'true', HIS_INBOUND_API_KEY: 'k', CONSOLE_API_KEY: 'ck', CRYPTO_MASTER_KEY: KEY, RATE_LIMIT_PER_MIN: '500', TRUST_PROXY: 'loopback' });
  const up2 = await waitHealthy(4742, 9000);
  check(up2, '대조: 하드닝+정상 마스터키 → 정상 부팅');
  if (up2) {
    const J = { 'Content-Type': 'application/json', 'x-api-key': 'ck' };
    const put = (body) => fetch('http://127.0.0.1:4742/v1/admin/settings/idv', { method: 'PUT', headers: J, body: JSON.stringify(body) });
    // MEDIUM-1: SSRF — 사설/메타데이터 endpoint 차단
    const meta = await put({ provider: 'pass', fields: { endpoint: 'http://169.254.169.254/latest/meta-data' } });
    check(meta.status === 400, `MEDIUM-1: 메타데이터 IP endpoint → 400 (status=${meta.status})`);
    const internal = await put({ provider: 'pass', fields: { endpoint: 'http://127.0.0.1:4100/v1' } });
    check(internal.status === 400, `MEDIUM-1: 내부망 endpoint → 400 (status=${internal.status})`);
    const httpPlain = await put({ provider: 'pass', fields: { endpoint: 'http://vendor.example/api' } });
    check(httpPlain.status === 400, `MEDIUM-1: http(비-https) endpoint → 400 (status=${httpPlain.status})`);
    const ok = await put({ provider: 'pass', fields: { endpoint: 'https://vendor.example/api' } });
    check(ok.status === 200, `정상: https 공인 endpoint → 200 (status=${ok.status})`);
  }
  p2.kill();

  console.log('\n' + (failures === 0 ? '✅ 연동 설정 보안 보완 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
