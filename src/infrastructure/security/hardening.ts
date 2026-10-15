// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * go-live 보안 하드닝 게이트 (operations-guide §6.1).
 * 운영(NODE_ENV=production) 또는 SECURITY_HARDENING=true 일 때만 강제 —
 * 개발 환경 접근/편의는 그대로 유지(콘솔·로컬 테스트 무영향).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function isHardened(): boolean {
  // 통합 단계 이스케이프 — SECURITY_HARDENING=false 면 운영이라도 비활성(HIS/PACS 연동 중 무중단).
  // go-live 시 이 변수 제거(또는 =true)로 H3/H4/M1 활성.
  if (process.env.SECURITY_HARDENING === 'false') return false;
  return process.env.NODE_ENV === 'production' || process.env.SECURITY_HARDENING === 'true';
}

/**
 * M1 — Webhook callbackUrl SSRF 방어.
 * 하드닝 시: https 강제 + 사내/사설망·루프백 차단 + (설정 시) 호스트 allowlist.
 *   단 WEBHOOK_INTERNAL_HOSTS 에 명시한 동일서버 내부 수신부(host 또는 host:port)는 예외
 *   허용(server-to-server 루프백은 SSRF 아님 — 운영자 명시 신뢰). 정확 일치만(부분일치 없음).
 * 개발 시: 통과(http/localhost 허용).
 * @throws Error 부적합 URL
 */
export function validateCallbackUrl(raw: string | undefined): void {
  if (!raw) return;
  if (!isHardened()) return; // 개발 — 검증 생략

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`callbackUrl 형식 오류: ${raw}`);
  }

  const host = u.hostname.toLowerCase();
  const hostPort = u.port ? `${host}:${u.port}` : host;

  // 운영자가 명시 신뢰한 내부(동일서버) 수신부 — http·루프백 허용(ERP 등 server-to-server).
  const internal = (process.env.WEBHOOK_INTERNAL_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (internal.length > 0 && (internal.includes(host) || internal.includes(hostPort))) return;

  if (u.protocol !== 'https:') throw new Error('callbackUrl 은 https 만 허용(운영)');
  if (isPrivateHost(host)) throw new Error(`callbackUrl 사설망/루프백 차단(SSRF): ${host}`);

  const allow = (process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length > 0 && !allow.includes(host)) {
    throw new Error(`callbackUrl 호스트 비허용(allowlist): ${host}`);
  }
}

/**
 * URL 을 로그·알림 본문에 실을 때 자격증명 노출을 막는다 — userinfo(user:pass@)와 쿼리스트링을 제거하고
 * origin+pathname 만 남긴다. 연동처 callbackUrl 에 `?token=…` 이나 `user:pass@` 가 박혀 있어도
 * 애플리케이션 로그·운영 메일로 새지 않게 한다. 파싱 불가하면 스킴만 남기고 마스킹.
 */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw.replace(/:\/\/.*/, '://<redacted>');
  }
}

/** 루프백·사설 IP·링크로컬·.internal 차단 (우회표기 정규화 포함) */
function isPrivateHost(raw: string): boolean {
  let host = raw.replace(/\.$/, '').toLowerCase(); // 후행 점 제거
  host = host.replace(/^\[|\]$/g, ''); // IPv6 대괄호 제거(new URL hostname은 [..]로 반환)
  // IPv4-mapped IPv6(::ffff:...) — Node가 hex로 정규화(::ffff:a9fe:a9fe)하므로 전면 차단(정당 용도 없음)
  if (host.startsWith('::ffff:')) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  // IPv6 루프백/링크로컬/ULA
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  // 점 없는 순수 정수/16진 IP 표기(예: 2130706433, 0x7f000001) 차단 — 우회 방지
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  // IPv4 사설/루프백/링크로컬/메타데이터
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 링크로컬/클라우드 메타데이터(169.254.169.254)
  }
  return false;
}
