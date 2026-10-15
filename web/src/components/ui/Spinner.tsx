// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 로딩 스피너 — 비동기 조회 중 표시(aria-busy 연계).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import React from 'react';

interface SpinnerProps {
  size?: number;
  color?: string;
  label?: string;
}

export function Spinner({ size = 24, color = 'var(--color-primary)', label = '로딩 중...' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `${Math.max(2, size / 10)}px solid var(--color-gray-200)`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}
