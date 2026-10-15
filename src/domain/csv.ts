// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * CSV 직렬화 — RFC4180 이스케이프 + UTF-8 BOM(Excel 한글 깨짐 방지).
 * 민감정보(CI·연락처 평문) 미포함은 호출부 책임(마스킹값만 전달).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const BOM = '\uFEFF';

function esc(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 헤더 + 행 배열 → CSV 문자열(BOM·CRLF). */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const out: string[] = [headers.map(esc).join(',')];
  for (const r of rows) out.push(r.map(esc).join(','));
  return BOM + out.join('\r\n') + '\r\n';
}
