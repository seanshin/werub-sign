// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 이메일 마스킹 — 목록·상세 응답에 평문 미노출(계약·프리셋 공용).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function maskEmail(email: string): string {
  const [id, domain] = email.split('@');
  if (!domain) return '****';
  return (id.length <= 2 ? id[0] + '*' : id.slice(0, 2) + '*'.repeat(Math.max(1, id.length - 2))) + '@' + domain;
}
