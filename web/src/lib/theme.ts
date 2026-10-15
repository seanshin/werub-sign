// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 다크/라이트 테마 — 관리자 콘솔. `data-theme="dark"` 토큰 오버라이드(tokens.css).
 * 저장: localStorage. 미설정 시 OS 선호(prefers-color-scheme). 환자 포털은 미적용(Light).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export type Theme = 'light' | 'dark';
const KEY = 'sign_theme';

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme): void {
  if (typeof document === 'undefined') return;
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

export function setTheme(t: Theme): void {
  if (typeof window !== 'undefined') localStorage.setItem(KEY, t);
  applyTheme(t);
}
