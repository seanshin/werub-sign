// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * go-live 하드닝 — rate-limit IP 트래커 정합 검증 (§6.1 H4).
 * 결함 회귀가드: 하드닝 시 throttler 가 모든 트래픽을 단일 IP 버킷으로 수렴시키면
 * HIS/PACS 서버↔서버 연동이 429 로 마비됨. 수정 = trust proxy + skipIf(XFF 부재 면제).
 *
 * 검증:
 *  A. 공개(nginx 경유=X-Forwarded-For 보유) 트래픽은 실 클라이언트 IP별 제한 — 한도 초과 시 429.
 *  B. 서로 다른 공개 클라이언트 IP(XFF 상이)는 독립 버킷 — 한 IP 소진이 타 IP 미영향.
 *  C. 서버↔서버(XFF 부재=localhost 직접호출, HIS/PACS) 는 면제 — 한도와 무관히 항상 200.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';

const PORT = 4731, B = `http://localhost:${PORT}`, LIMIT = 3;
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// /v1/crl 은 공개(인증 불요) GET — 순수 트래픽 제어만 측정.
const hit = (xff) => fetch(B + '/v1/crl', { headers: xff ? { 'x-forwarded-for': xff } : {} }).then((r) => r.status);

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env,
      SIGN_PORT: String(PORT),
      HIS_INBOUND_API_KEY: 'hard-key',
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 31).toString('base64'),
      SECURITY_HARDENING: 'true',       // 하드닝 강제 활성
      RATE_LIMIT_PER_MIN: String(LIMIT), // 검증 위해 낮은 한도
      TRUST_PROXY: 'loopback, linklocal, uniquelocal',
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  console.log('\n══════ go-live 하드닝 — rate-limit 정합 e2e ══════\n');
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); process.exit(1); }
  try {
    // A. 공개 클라이언트 IP — 한도(LIMIT) 까지 200, 초과분 429.
    const ipA = '203.0.113.10';
    const statuses = [];
    for (let i = 0; i < LIMIT + 2; i++) statuses.push(await hit(ipA));
    const okCount = statuses.filter((s) => s === 200).length;
    const tooMany = statuses.filter((s) => s === 429).length;
    check(okCount === LIMIT && tooMany >= 1, `공개 IP 한도 적용 (200×${okCount}, 429×${tooMany})`);

    // B. 다른 공개 IP 는 독립 버킷 — ipA 소진 후에도 ipB 첫 요청 200.
    const ipB = '198.51.100.20';
    check((await hit(ipB)) === 200, '상이 공개 IP 독립 버킷 (ipB 200)');

    // C. 서버↔서버(XFF 부재) — 한도 수배 호출해도 전부 200(면제).
    let s2sAll200 = true;
    for (let i = 0; i < LIMIT + 5; i++) if ((await hit(undefined)) !== 200) s2sAll200 = false;
    check(s2sAll200, `서버↔서버(XFF 부재) 면제 — ${LIMIT + 5}회 전부 200`);
  } finally { app.kill(); }
  console.log('\n' + (failures === 0 ? '✅ 하드닝 rate-limit 정합 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main();
