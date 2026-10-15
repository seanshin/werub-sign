'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React from 'react';

/**
 * 의존성 없는 경량 차트(SVG/CSS) — 운영 추세 시각화.
 * BarList(가로 막대), Sparkbars(일자별 세로 막대), Gauge(성공률 %).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const PALETTE: Record<string, string> = {
  CREATED: 'var(--status-created-text)',
  IN_PROGRESS: 'var(--status-in-progress-text)',
  COMPLETED: 'var(--status-completed-text)',
  EXPIRED: 'var(--status-expired-text)',
  WITHDRAWN: 'var(--status-withdrawn-text)',
  REVOKED: 'var(--status-revoked-text)',
  SUPERSEDED: 'var(--color-text-tertiary)',
  FAILED: 'var(--color-danger)',
};

export function BarList({ data }: { data: Array<{ label: string; value: number; color?: string }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} role="list">
      {data.length === 0 && <span style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--text-sm)' }}>데이터 없음</span>}
      {data.map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)' }} role="listitem">
          <span style={{ width: 96, flexShrink: 0, color: 'var(--color-text-secondary)' }}>{d.label}</span>
          <div style={{ flex: 1, background: 'var(--color-bg-tertiary)', borderRadius: 4, height: 18, overflow: 'hidden' }}>
            <div style={{ width: `${(d.value / max) * 100}%`, height: '100%', background: d.color ?? PALETTE[d.label] ?? 'var(--color-primary)', borderRadius: 4, minWidth: d.value > 0 ? 2 : 0 }} />
          </div>
          <span style={{ width: 44, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-primary)' }}>{d.value.toLocaleString('ko-KR')}</span>
        </div>
      ))}
    </div>
  );
}

export function Sparkbars({ data, height = 56 }: { data: Array<{ date: string; count: number }>; height?: number }) {
  if (data.length === 0) return <span style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--text-sm)' }}>해당 기간 데이터 없음</span>;
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }} role="img" aria-label={`일자별 요청 생성 — 최대 ${max}건`}>
        {data.map((d) => (
          <div key={d.date} title={`${d.date}: ${d.count}건`} style={{ flex: 1, minWidth: 4, height: `${Math.max(4, (d.count / max) * height)}px`, background: 'var(--color-primary)', borderRadius: '2px 2px 0 0' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export function Gauge({ percent, label }: { percent: number; label: string }) {
  const color = percent >= 95 ? 'var(--color-success)' : percent >= 80 ? 'var(--color-warning)' : 'var(--color-danger)';
  return (
    <div role="img" aria-label={`${label} ${percent}%`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4 }}>
        <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        <strong style={{ color, fontVariantNumeric: 'tabular-nums' }}>{percent}%</strong>
      </div>
      <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}
