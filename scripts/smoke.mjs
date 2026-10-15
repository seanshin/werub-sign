// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 라이브 스모크(L3) — 배포 후 1-클릭 검증. **읽기 전용(GET)** — 운영 데이터 무변경.
 *
 * 사용:
 *   node scripts/smoke.mjs [BASE_URL]
 *   SMOKE_BASE_URL=https://sign.example.org SMOKE_API_KEY=<console-key> node scripts/smoke.mjs
 *
 * 공개 점검(키 불요): /health · /health/ready · /v1/crl
 * 인증 점검(SMOKE_API_KEY=CONSOLE_API_KEY 있을 때만): ops-status · SSE(event: ready) · 서명요청 CSV(최근 1일)
 * 종료 코드: 실패 0건=0, 그 외=1. CI/배포 파이프라인 게이트로 사용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const BASE = (process.env.SMOKE_BASE_URL || process.argv[2] || 'https://sign.example.org').replace(/\/$/, '');
const KEY = process.env.SMOKE_API_KEY || '';
let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const ms = (a) => `${Date.now() - a}ms`;

async function getJson(path, headers = {}) {
  const t = Date.now();
  const res = await fetch(BASE + path, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { res, body, took: ms(t) };
}

// SSE: 'event: ready' 프레임을 timeout 내 수신하면 통과(연결 후 즉시 종료).
async function smokeSse(path, headers, timeoutMs = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { headers, signal: ac.signal });
    if (!res.ok || !res.body) return { ok: false, status: res.status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: ready')) { ac.abort(); return { ok: true, status: res.status }; }
    }
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`\n══════ 라이브 스모크 — ${BASE} ══════\n`);
  console.log('— 공개 점검 —');

  const h = await getJson('/health');
  check(h.res.ok && h.body?.status === 'ok', `GET /health → ok`, `${h.res.status} ${h.took}`);

  const r = await getJson('/health/ready');
  const ready = r.body?.ready ?? r.body?.data?.ready ?? r.body?.status;
  check(r.res.ok, `GET /health/ready → ${r.res.status}`, `ready=${JSON.stringify(ready)} ${r.took}`);

  const crl = await fetch(BASE + '/v1/crl');
  check(crl.ok, `GET /v1/crl → ${crl.status}`, '인증서폐기목록 응답');

  if (!KEY) {
    console.log('\n(인증 점검 생략 — SMOKE_API_KEY 미설정. 콘솔 키 지정 시 ops-status·SSE·CSV 점검)');
  } else {
    console.log('\n— 인증 점검(콘솔 키) —');
    const H = { 'x-api-key': KEY };

    const ops = await getJson('/v1/admin/ops-status', H);
    check(ops.res.ok && !!ops.body?.data, `GET /v1/admin/ops-status → ${ops.res.status}`, ops.took);

    const sse = await smokeSse('/v1/events/stream', H);
    check(sse.ok, `SSE /v1/events/stream → event: ready`, sse.status ? `status=${sse.status}` : (sse.error || ''));

    const csv = await fetch(BASE + '/v1/requests/export.csv?days=1', { headers: H });
    const ct = csv.headers.get('content-type') || '';
    check(csv.ok && /csv/i.test(ct), `GET /v1/requests/export.csv(최근1일) → ${csv.status}`, ct);
  }

  console.log('\n' + (failures === 0 ? '✅ 라이브 스모크 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('스모크 실행 오류:', e); process.exit(1); });
