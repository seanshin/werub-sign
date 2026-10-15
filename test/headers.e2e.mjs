// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 보안 응답 헤더 e2e(J4) — helmet 기본 헤더 + 운영(HSTS) 게이트.
 *  - 일반 모드: nosniff·frameguard·referrer-policy·CORP, X-Powered-By 제거, HSTS 없음.
 *  - 운영 하드닝(SECURITY_HARDENING=true): Strict-Transport-Security 적용.
 * 실행: npm run build && node test/headers.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(port, extraEnv) {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(port), HIS_INBOUND_API_KEY: 'h-key',
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 61).toString('base64'), ...extraEnv,
    },
    stdio: 'ignore',
  });
}
async function up(B) { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/health')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ 보안 응답 헤더 e2e (J4) ══════\n');

  // ── 1) 일반 모드 ──
  const P1 = 4771, B1 = `http://127.0.0.1:${P1}`;
  const app1 = start(P1, { SECURITY_HARDENING: 'false' });
  if (!(await up(B1))) { console.log('❌ 기동 실패(일반)'); app1.kill(); process.exit(1); }
  try {
    const h = (await fetch(B1 + '/health')).headers;
    console.log('— 일반 모드 —');
    check(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff', h.get('x-content-type-options') || '');
    check(!!h.get('x-frame-options'), 'X-Frame-Options 존재(클릭재킹 방지)', h.get('x-frame-options') || '');
    check(!!h.get('referrer-policy'), 'Referrer-Policy 존재', h.get('referrer-policy') || '');
    check(h.get('cross-origin-resource-policy') === 'cross-origin', 'Cross-Origin-Resource-Policy: cross-origin', h.get('cross-origin-resource-policy') || '');
    check(h.get('x-powered-by') === null, 'X-Powered-By 제거(서버 핑거프린트 숨김)');
    check(h.get('strict-transport-security') === null, '일반 모드 — HSTS 미적용(개발/HTTP)');
  } finally { app1.kill(); }

  // ── 2) 운영 하드닝 모드 ──
  await sleep(300);
  const P2 = 4772, B2 = `http://127.0.0.1:${P2}`;
  const app2 = start(P2, { SECURITY_HARDENING: 'true' });
  if (!(await up(B2))) { console.log('❌ 기동 실패(하드닝)'); app2.kill(); process.exit(1); }
  try {
    const h = (await fetch(B2 + '/health')).headers;
    console.log('— 운영 하드닝 모드 —');
    const hsts = h.get('strict-transport-security') || '';
    check(/max-age=15552000/.test(hsts), 'HSTS max-age=15552000(180일) 적용', hsts);
    check(/includeSubDomains/i.test(hsts), 'HSTS includeSubDomains 적용');
    check(h.get('x-content-type-options') === 'nosniff', 'nosniff 유지');
  } finally { app2.kill(); }

  console.log('\n' + (failures === 0 ? '✅ 보안 헤더 e2e 전체 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
