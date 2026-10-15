// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { AuditEntry } from '../domain/types/store.types';

/**
 * 감사 스트림 서버측 필터·CSV — audit-events·admin-audit 공용.
 * 전체 데이터셋에 적용(클라이언트 현재 페이지 필터의 한계 해소).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface AuditFilter {
  eventType?: string; // 정확일치
  from?: string; // ISO, occurredAt >= from
  to?: string; // ISO, occurredAt <= to
  q?: string; // eventType + data 본문 부분일치(소문자)
}

export function parseAuditFilter(query: { eventType?: string; from?: string; to?: string; q?: string }): AuditFilter {
  const s = (v?: string) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const iso = (v?: string) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  };
  return { eventType: s(query.eventType), from: iso(query.from), to: iso(query.to), q: s(query.q)?.toLowerCase() };
}

export function filterAudit(entries: AuditEntry[], f: AuditFilter): AuditEntry[] {
  if (!f.eventType && !f.from && !f.to && !f.q) return entries;
  return entries.filter((e) => {
    if (f.eventType && e.eventType !== f.eventType) return false;
    const at = (e.occurredAt as string) ?? '';
    if (f.from && at < f.from) return false;
    if (f.to && at > f.to) return false;
    if (f.q) {
      const hay = `${e.eventType ?? ''} ${JSON.stringify(e.data ?? {})}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** 감사 엔트리 → CSV(UTF-8 BOM, 한글 Excel). 심사·보존용 — 식별자·해시만(PHI 미봉인). */
export function auditToCsv(entries: AuditEntry[]): string {
  const head = ['occurredAt', 'eventType', 'actor', 'actorRole', 'targetType', 'targetRef', 'system', 'ip', 'authMethod', 'entryHash', 'prevHash'];
  const lines = entries.map((e) => {
    const rec = e as unknown as Record<string, unknown>;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const auth = (d.auth ?? {}) as Record<string, unknown>;
    return [e.occurredAt, e.eventType, d.actor, d.actorRole, d.targetType, d.targetRef, d.system, d.ip, auth.method, rec.entryHash, rec.prevHash].map(esc).join(',');
  });
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
