'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React from 'react';
import { Input } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';

/**
 * 감사·로그 공용 필터 — 검색(q)·기간(from/to)·이벤트 유형(eventType). 백엔드 parseAuditFilter 와 정합.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface AuditFilters {
  q: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  eventType: string;
}
export const EMPTY_FILTERS: AuditFilters = { q: '', from: '', to: '', eventType: '' };

/** UI 날짜(YYYY-MM-DD) → API 파라미터(from=일 시작, to=일 끝, 미설정 시 undefined). */
export function toApiRange(f: AuditFilters): { q?: string; eventType?: string; from?: string; to?: string } {
  return {
    q: f.q.trim() || undefined,
    eventType: f.eventType || undefined,
    from: f.from ? `${f.from}T00:00:00.000Z` : undefined,
    to: f.to ? `${f.to}T23:59:59.999Z` : undefined,
  };
}

const ctrl: React.CSSProperties = { height: 36, padding: '0 10px', fontSize: 14, border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-bg)', color: 'var(--color-text)' };

/** 페이지별 추가 드롭다운(시스템·상태 등)을 필터 바에 통일 스타일로 렌더. */
export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={ctrl}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function AuditFilterBar({ filters, onChange, searchPlaceholder = '검색', searchAriaLabel, eventTypes, extra, right }: {
  filters: AuditFilters;
  onChange: (f: AuditFilters) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  eventTypes?: string[]; // 지정 시 이벤트 유형 드롭다운 노출
  extra?: React.ReactNode; // 페이지별 추가 필터(시스템·상태 등)
  right?: React.ReactNode; // CSV·새로고침 등 우측 액션
}) {
  const set = (patch: Partial<AuditFilters>) => onChange({ ...filters, ...patch });
  const active = !!(filters.q || filters.from || filters.to || filters.eventType);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder={searchPlaceholder} aria-label={searchAriaLabel ?? '검색'} style={{ width: 240 }} />
      {eventTypes && eventTypes.length > 0 && (
        <select value={filters.eventType} onChange={(e) => set({ eventType: e.target.value })} aria-label="이벤트 유형" style={ctrl}>
          <option value="">전체 이벤트</option>
          {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      {extra}
      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>기간</span>
      <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="시작일" style={ctrl} />
      <span style={{ color: 'var(--color-text-muted)' }}>~</span>
      <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="종료일" style={ctrl} />
      {active && <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>초기화</Button>}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>{right}</div>}
    </div>
  );
}
