'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useEffect, useState, useCallback } from 'react';

/**
 * 환자 포털 접근성 컨트롤 — 고령자 대상 글씨 크기(기본/크게/더크게)·고대비.
 * 글씨: documentElement font-size %(rem 토큰 일괄 확대). 고대비: data-portal-contrast(tokens.css 오버라이드).
 * localStorage 지속. 언마운트 시 원복(다른 페이지 누수 방지).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const KEY = 'sign_portal_a11y';
const SCALES = [
  { v: 1, label: '기본' },
  { v: 1.25, label: '크게' },
  { v: 1.5, label: '더크게' },
];

export function PortalA11y() {
  const [scale, setScale] = useState(1);
  const [contrast, setContrast] = useState(false);

  const apply = useCallback((s: number, c: boolean) => {
    document.documentElement.style.fontSize = s === 1 ? '' : `${Math.round(s * 100)}%`;
    if (c) document.documentElement.setAttribute('data-portal-contrast', 'high');
    else document.documentElement.removeAttribute('data-portal-contrast');
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      const s = typeof saved.scale === 'number' ? saved.scale : 1;
      const c = !!saved.contrast;
      setScale(s);
      setContrast(c);
      apply(s, c);
    } catch { /* 기본값 */ }
    return () => { document.documentElement.style.fontSize = ''; document.documentElement.removeAttribute('data-portal-contrast'); };
  }, [apply]);

  const update = (s: number, c: boolean) => {
    setScale(s);
    setContrast(c);
    apply(s, c);
    try { localStorage.setItem(KEY, JSON.stringify({ scale: s, contrast: c })); } catch { /* 무시 */ }
  };

  const barStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', margin: '0 auto var(--space-4)', fontSize: '0.875rem', color: 'var(--color-text-secondary)' };
  const btn = (active: boolean): React.CSSProperties => ({
    minWidth: 44, minHeight: 36, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
    background: active ? 'var(--color-primary)' : 'var(--color-bg)',
    color: active ? 'var(--color-primary-text)' : 'var(--color-text-primary)',
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={barStyle} role="group" aria-label="접근성 설정 — 글씨 크기·고대비">
      <span aria-hidden="true">글씨</span>
      {SCALES.map((s) => (
        <button key={s.v} type="button" style={btn(scale === s.v)} aria-pressed={scale === s.v}
          onClick={() => update(s.v, contrast)} aria-label={`글씨 ${s.label}`}>{s.label}</button>
      ))}
      <button type="button" style={btn(contrast)} aria-pressed={contrast}
        onClick={() => update(scale, !contrast)} aria-label="고대비 모드">고대비</button>
    </div>
  );
}
