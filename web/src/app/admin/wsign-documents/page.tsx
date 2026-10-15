'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 문서 인증 목록 — weRB 등 외부 시스템이 audit-events 로 봉인한 wsign_document
 * 어테스테이션 통합 조회(문서 단위 그룹핑·무결성).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { wsignApi } from '@/lib/api';
import { WsignDocRow, ApiError } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { shortHash } from '@/components/log/LogDetail';
import { AuditFilterBar, AuditFilters, EMPTY_FILTERS, toApiRange, FilterSelect } from '@/components/log/AuditFilterBar';

const DEFAULT_LIMIT = 50;
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-secondary)' };

export default function WsignDocumentsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<WsignDocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [systems, setSystems] = useState<string[]>([]);
  const [system, setSystem] = useState('');

  const load = useCallback(async (o: number, l: number) => {
    setLoading(true); setError('');
    try {
      const res = await wsignApi.list({ limit: l, offset: o, system: system || undefined, ...toApiRange({ ...filters, q: debouncedQ }) });
      setRows(res.data);
      setTotal(res.page.total);
      setForbidden(false);
      // 이벤트 유형·시스템 후보 누적(드롭다운)
      setEventTypes((prev) => Array.from(new Set([...prev, ...res.data.map((r) => r.eventType)])).sort());
      setSystems((prev) => Array.from(new Set([...prev, ...res.data.map((r) => r.system).filter((s): s is string => !!s)])).sort());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setForbidden(true);
      else setError(e instanceof Error ? e.message : '조회 실패');
    } finally { setLoading(false); }
  }, [filters, debouncedQ, system]);

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 300); return () => clearTimeout(t); }, [filters.q]);
  useEffect(() => { setOffset(0); void load(0, limit); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [debouncedQ, filters.from, filters.to, filters.eventType, system]);
  useEffect(() => { void load(offset, limit); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset, limit]);

  const exportCsv = async () => {
    setExporting(true); setError('');
    try { await wsignApi.exportCsv({ system: system || undefined, ...toApiRange({ ...filters, q: debouncedQ }) }); }
    catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setExporting(false); }
  };

  return (
    <AdminLayout title="문서 인증 목록">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <AuditFilterBar
          filters={filters}
          onChange={setFilters}
          searchPlaceholder="검색(제목·문서ID·해시·시스템)"
          searchAriaLabel="문서 인증 검색"
          eventTypes={eventTypes}
          extra={systems.length > 0 && <FilterSelect label="시스템" value={system} onChange={setSystem} options={[{ value: '', label: '전체 시스템' }, ...systems.map((s) => ({ value: s, label: s }))]} />}
          right={<>
            <Button onClick={exportCsv} loading={exporting} variant="ghost" size="sm" disabled={total === 0}>CSV</Button>
            <Button onClick={() => load(offset, limit)} loading={loading} variant="ghost" size="sm">새로고침</Button>
          </>}
        />

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {forbidden && <Alert type="info" message="접근 권한(requests:write)이 없습니다. 관리자·운영자 계정으로 접근하세요." />}

        {!forbidden && (
          <Card>
            <CardHeader title={`문서 인증 (${total.toLocaleString('ko-KR')}건)`} />
            <CardBody>
              {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
                    <thead><tr>
                      <th style={th}>시각</th><th style={th}>문서</th><th style={th}>문서 ID</th>
                      <th style={th}>시스템</th><th style={th}>이벤트</th><th style={th}>문서 해시</th><th style={th}>무결성</th>
                    </tr></thead>
                    <tbody>
                      {rows.map((e, i) => (
                        <tr key={i} onClick={() => router.push('/admin/wsign-documents/' + encodeURIComponent(e.stream))} style={{ cursor: 'pointer' }}>
                          <td style={td}>{dt(e.occurredAt)}</td>
                          <td style={td}><strong style={{ color: 'var(--color-primary, #2563eb)' }}>{e.title || '-'}</strong></td>
                          <td style={{ ...td, ...mono }}>{e.targetRef || '-'}</td>
                          <td style={td}>{e.system || '-'}</td>
                          <td style={td}>{e.eventType}</td>
                          <td style={{ ...td, ...mono }} title={e.documentHash}>{shortHash(e.documentHash)}</td>
                          <td style={td}>
                            <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, background: e.chainValid ? 'var(--color-success-bg,#dcfce7)' : 'var(--color-danger-bg,#fee2e2)', color: e.chainValid ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>
                              {e.chainValid ? '체인 유효' : '깨짐'}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && !loading && <tr><td style={td} colSpan={7}>{debouncedQ || filters.from || filters.to || filters.eventType ? '필터 일치 없음' : '문서 인증 기록 없음'}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination total={total} offset={offset} limit={limit} onOffsetChange={setOffset} onLimitChange={(l) => { setLimit(l); setOffset(0); }} />
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>
                ※ 외부 문서인증 시스템(예: <code>werb-docauth</code>)이 <code>POST /v1/audit-events</code>로 봉인한 문서 어테스테이션. 문서별 해시체인으로 위변조 탐지. <strong>문서를 클릭하면 상세(어테스테이션 이력·해시·무결성)</strong>로 이동합니다.
              </p>
            </CardBody>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
