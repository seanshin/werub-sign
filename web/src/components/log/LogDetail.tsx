'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React from 'react';

/**
 * 감사/로그 엔트리 상세 — 행 확장 시 전체 data 페이로드 + 무결성 해시(entryHash/prevHash)를 정형 표시.
 * event-log·audit-log 공용. PHI 원본은 애초에 봉인 대상이 아니므로(식별자·해시만) 그대로 노출.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface LogEntryLike {
  eventType?: string;
  actorType?: string;
  occurredAt?: string;
  seq?: number;
  hash?: string; // entryHash
  prevHash?: string;
  entryHash?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

const cell: React.CSSProperties = { padding: '4px 10px', fontSize: 13, verticalAlign: 'top' };
const keyCell: React.CSSProperties = { ...cell, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', width: 160 };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' };

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
  if (typeof v === 'object') return <code style={{ ...mono, fontSize: 12 }}>{JSON.stringify(v)}</code>;
  if (typeof v === 'string' && /^[0-9a-f]{32,}$/i.test(v)) return <code style={mono}>{v}</code>;
  return <span style={mono}>{String(v)}</span>;
}

export function LogDetail({ entry }: { entry: LogEntryLike }) {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  // data 가 별도 키 없이 펼쳐 저장된 경우(event-log)도 지원 — 메타 키 제외한 나머지를 data 로 간주
  const META = new Set(['eventType', 'actorType', 'occurredAt', 'seq', 'hash', 'prevHash', 'entryHash', 'data']);
  const flat: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(entry)) if (!META.has(k)) flat[k] = v;
  const dataKeys = Object.keys(flat).sort();
  const entryHash = entry.entryHash ?? entry.hash;

  return (
    <div style={{ background: 'var(--color-bg-secondary)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--color-border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={keyCell}>발생 시각(정밀)</td><td style={cell}><span style={mono}>{entry.occurredAt ?? '—'}</span></td></tr>
          {entry.seq !== undefined && <tr><td style={keyCell}>순번(seq)</td><td style={cell}>{entry.seq}</td></tr>}
          {entry.actorType !== undefined && <tr><td style={keyCell}>행위자 유형</td><td style={cell}>{renderValue(entry.actorType)}</td></tr>}
          {dataKeys.length > 0 && (
            <tr>
              <td style={keyCell}>데이터(data)</td>
              <td style={cell}>
                <table style={{ borderCollapse: 'collapse' }}>
                  <tbody>
                    {dataKeys.map((k) => (
                      <tr key={k}>
                        <td style={{ ...keyCell, width: 140, fontSize: 12 }}>{k}</td>
                        <td style={cell}>{renderValue(flat[k])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td>
            </tr>
          )}
          {entryHash && (
            <tr><td style={keyCell}>entryHash</td><td style={cell}><code style={{ ...mono, fontSize: 12 }}>{String(entryHash)}</code></td></tr>
          )}
          {entry.prevHash && (
            <tr><td style={keyCell}>prevHash</td><td style={cell}><code style={{ ...mono, fontSize: 12, color: 'var(--color-text-secondary)' }}>{String(entry.prevHash)}</code></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** entryHash 앞 12자 — 목록 컬럼용. */
export function shortHash(h?: string): string {
  return h ? `${h.slice(0, 12)}…` : '—';
}
