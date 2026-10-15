#!/usr/bin/env node
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 공급망 CI 게이트(S6) — npm audit 고위험 어드바이저리 차단.
 *
 * 원칙: **런타임에 실리는 것(prod 의존성)은 하드 게이트**, dev 의존성은 경고만.
 *   - root·web 두 패키지를 `npm audit --omit=dev` 로 검사하고,
 *     high/critical 어드바이저리(GHSA)가 allowlist 에 없으면 실패(exit 1).
 *   - 예외는 코드가 아니라 파일로 관리: `.audit-allowlist.json` — 항목마다
 *     사유(reason)·후속(followup)·등재일(added)을 반드시 남긴다. "왜 허용했는가"가
 *     없는 예외는 예외가 아니라 은폐다.
 *   - audit 자체가 실패(네트워크·파싱)하면 통과가 아니라 실패다(fail-closed).
 *
 * 실행: npm run audit:gate  (저장소 루트에서. CI security.yml 이 매 push·주간 호출)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  { name: 'root(sign-core)', dir: ROOT },
  { name: 'web(console/portal)', dir: join(ROOT, 'web') },
];
const GATE_SEVERITIES = new Set(['high', 'critical']);

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(join(ROOT, '.audit-allowlist.json'), 'utf8'));
  const map = new Map();
  for (const e of raw.allow ?? []) {
    if (!e.id || !e.reason) {
      console.error(`✗ allowlist 항목 불량(id·reason 필수): ${JSON.stringify(e)}`);
      process.exit(1);
    }
    map.set(e.id, e);
  }
  return map;
}

/** npm audit --json 실행 — 취약점 있으면 exit!=0 이므로 코드가 아니라 출력으로 판단 */
function runAudit(dir, omitDev) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  const r = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.error) throw new Error(parsed.error.summary ?? 'npm audit error');
    return parsed;
  } catch (err) {
    console.error(`✗ npm audit 실행 실패(${dir}): ${err.message} — fail-closed`);
    console.error((r.stderr || r.stdout || '').slice(0, 2000));
    process.exit(1);
  }
}

/** vulnerabilities 트리에서 게이트 대상(자체 severity high/critical) 어드바이저리만 추출 */
function extractAdvisories(auditJson) {
  const found = new Map(); // ghsa -> {package, severity, title}
  for (const [name, v] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !GATE_SEVERITIES.has(via.severity)) continue;
      const ghsa = String(via.url ?? '').split('/').pop();
      if (!ghsa?.startsWith('GHSA-')) continue;
      found.set(ghsa, { package: via.name ?? name, severity: via.severity, title: via.title ?? '' });
    }
  }
  return found;
}

const allowlist = loadAllowlist();
const usedAllowIds = new Set();
let failed = false;

for (const t of TARGETS) {
  const prod = runAudit(t.dir, true);
  const advisories = extractAdvisories(prod);
  const blocked = [...advisories].filter(([ghsa]) => !allowlist.has(ghsa));
  for (const [ghsa] of advisories) if (allowlist.has(ghsa)) usedAllowIds.add(ghsa);

  const meta = prod.metadata?.vulnerabilities ?? {};
  console.log(`\n■ ${t.name} — prod 의존성: high ${meta.high ?? 0} · critical ${meta.critical ?? 0} (어드바이저리 ${advisories.size}건, allowlist 외 ${blocked.length}건)`);
  for (const [ghsa, a] of blocked) {
    console.log(`  ✗ ${ghsa} [${a.severity}] ${a.package} — ${a.title}`);
  }
  if (blocked.length) {
    failed = true;
    console.log('  → 조치: 의존성 업그레이드가 원칙. 불가하면 .audit-allowlist.json 에 사유·후속 계획과 함께 등재.');
  }

  // dev 포함 전체는 정보성 경고만 — 러너/개발머신 노출이지 런타임 노출이 아니다
  const all = runAudit(t.dir, false);
  const am = all.metadata?.vulnerabilities ?? {};
  if ((am.high ?? 0) + (am.critical ?? 0) > (meta.high ?? 0) + (meta.critical ?? 0)) {
    console.log(`  ⚠ dev 포함 시 high ${am.high} · critical ${am.critical} (비차단 — 업그레이드 권장)`);
  }
}

// 더 이상 검출되지 않는 allowlist 항목은 정리 대상(낡은 예외 방치 방지)
const stale = [...allowlist.keys()].filter((id) => !usedAllowIds.has(id));
if (stale.length) console.log(`\n⚠ allowlist 에 있으나 더는 검출되지 않는 항목(정리 권장): ${stale.join(', ')}`);

if (failed) {
  console.error('\n✗ 공급망 게이트 실패 — allowlist 에 없는 high/critical prod 어드바이저리 존재');
  process.exit(1);
}
console.log('\n✓ 공급망 게이트 통과');
