'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 인증 행위 로그 — 외부 시스템이 /v1/audit-events 로 봉인한 의료진 중요 행위(처방·판독승인 등)
 * 스트림 조회. 해시체인 무결성 검증 배지 포함.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { auditEventApi } from '@/lib/api';
import { AuditEntry, AuditVerifyResult } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { LogDetail, shortHash } from '@/components/log/LogDetail';
import { AuditFilterBar, AuditFilters, EMPTY_FILTERS, toApiRange } from '@/components/log/AuditFilterBar';

const DEFAULT_LIMIT = 50;

const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const LABEL: Record<string, string> = { 'medical-records': '의료기록', 'clinical-events': '임상행위', 'pacs-events': 'PACS행위' };
const label = (s: string) => LABEL[s] ?? s;

export default function EventLogPage() {
  const [streams, setStreams] = useState<{ stream: string; count: number }[]>([]);
  const [sel, setSel] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [verifyR, setVerifyR] = useState<AuditVerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);

  const loadStreams = useCallback(async () => {
    setError('');
    try {
      const s = await auditEventApi.streams();
      setStreams(s);
      if (!sel && s.length) setSel(s.find((x) => x.stream === 'medical-records')?.stream ?? s[0].stream);
    } catch (e) { setError(e instanceof Error ? e.message : '스트림 조회 실패'); }
  }, [sel]);

  const loadEntries = useCallback(async (stream: string, o = 0, l = DEFAULT_LIMIT) => {
    if (!stream) return;
    setLoading(true); setError(''); setVerifyR(null); setExpanded(null);
    try {
      const result = await auditEventApi.list(stream, { limit: l, offset: o, ...toApiRange({ ...filters, q: debouncedQ }) });
      // 최신 항목을 앞에 표시 (역순)
      setRows([...result.data].reverse());
      setTotal(result.page.total);
      setEventTypes((prev) => Array.from(new Set([...prev, ...result.data.map((e) => e.eventType)])).sort());
      // 무결성 자동 검증(체인·앵커) — 배지로 상시 표시
      auditEventApi.verify(stream).then(setVerifyR).catch(() => setVerifyR(null));
    }
    catch (e) { setError(e instanceof Error ? e.message : '로그 조회 실패'); }
    finally { setLoading(false); }
  }, [filters, debouncedQ]);

  useEffect(() => { void loadStreams(); }, [loadStreams]);
  // 검색어 디바운스(300ms)
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 300); return () => clearTimeout(t); }, [filters.q]);

  useEffect(() => {
    if (sel) { setOffset(0); void loadEntries(sel, 0, limit); }
    // sel·필터 변경 시 오프셋 초기화 후 재조회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, debouncedQ, filters.from, filters.to, filters.eventType]);

  useEffect(() => {
    if (sel) void loadEntries(sel, offset, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, limit]);

  const handleOffsetChange = (newOffset: number) => {
    setOffset(newOffset);
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0);
  };

  const verify = async () => {
    try { setVerifyR(await auditEventApi.verify(sel)); }
    catch (e) { setError(e instanceof Error ? e.message : '검증 실패'); }
  };

  // 전체 일치분 CSV(심사·보존) — 서버측 필터(검색어) 적용, 현재 페이지 무관. PHI 미봉인(식별자·해시만).
  const exportCsv = async () => {
    setExporting(true); setError('');
    try { await auditEventApi.exportCsv(sel, toApiRange({ ...filters, q: debouncedQ })); }
    catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setExporting(false); }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 14px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)', background: active ? 'var(--color-primary,#2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)', fontWeight: active ? 600 : 400 });

  return (
    <AdminLayout title="인증 행위 로그">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {streams.map((s) => (
            <button key={s.stream} style={tabBtn(sel === s.stream)} onClick={() => setSel(s.stream)}>
              {label(s.stream)} <span style={{ opacity: 0.7 }}>({s.count.toLocaleString('ko-KR')})</span>
            </button>
          ))}
          {streams.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>기록된 행위 로그 스트림 없음</span>}
        </div>
        <AuditFilterBar
          filters={filters}
          onChange={setFilters}
          searchPlaceholder="검색(행위·행위자·대상·data 전체)"
          searchAriaLabel="행위 로그 검색"
          eventTypes={eventTypes}
          right={<>
            <Button onClick={exportCsv} loading={exporting} variant="ghost" size="sm" aria-label="CSV 내보내기" disabled={total === 0}>CSV</Button>
            <Button onClick={() => loadEntries(sel, offset, limit)} loading={loading} variant="ghost" size="sm">새로고침</Button>
            {sel && <Button onClick={verify} variant="ghost" size="sm">무결성 재검증</Button>}
          </>}
        />

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {verifyR && (
          <Alert
            // 체인 깨짐=오류, 체인 유효하나 TSA 미앵커=대기(경고), 둘 다 유효=성공
            type={!verifyR.chainValid ? 'error' : verifyR.valid ? 'success' : 'info'}
            message={`체인 무결성: ${verifyR.chainValid ? '유효' : '깨짐(위변조 의심)'} · TSA 앵커: ${verifyR.anchored ? (verifyR.anchorMatchesChain ? '일치' : '불일치') : '미앵커(대기)'}`}
            onClose={() => setVerifyR(null)} />
        )}

        <Card>
          <CardHeader title={`${sel ? label(sel) : '행위'} 로그 (${total.toLocaleString('ko-KR')}건)`} />
          <CardBody>
            {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                  <thead><tr>
                    <th style={{ ...th, width: 24 }}></th>
                    <th style={th}>시각</th><th style={th}>행위</th><th style={th}>행위자</th><th style={th}>인증</th>
                    <th style={th}>대상</th><th style={th}>제출시스템</th><th style={th}>entryHash</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((e, i) => {
                      const dd = (e.data ?? {}) as Record<string, unknown>;
                      const auth = (dd.auth ?? {}) as Record<string, unknown>;
                      const sso = auth.method === 'SSO';
                      const open = expanded === i;
                      return (
                        <React.Fragment key={i}>
                          <tr onClick={() => setExpanded(open ? null : i)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                            <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                            <td style={td}>{dt(e.occurredAt)}</td>
                            <td style={td}><strong>{e.eventType}</strong></td>
                            <td style={td}>{String(dd.actor ?? '-')}{dd.actorRole ? ` (${dd.actorRole})` : ''}</td>
                            <td style={td}>
                              <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, background: sso ? 'var(--color-success-bg,#dcfce7)' : 'var(--color-bg-secondary,#f3f4f6)', color: sso ? 'var(--color-success-text)' : 'var(--color-text-muted)' }}>
                                {sso ? `SSO·${String(auth.sub ?? '')}` : 'API_KEY'}
                              </span>
                            </td>
                            <td style={td}>{dd.targetType ? `${dd.targetType}:${dd.targetRef ?? ''}` : '-'}</td>
                            <td style={td}>{String(dd.system ?? '-')}</td>
                            <td style={{ ...td, ...{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-secondary)' } }}>{shortHash(e.entryHash as string | undefined)}</td>
                          </tr>
                          {open && (
                            <tr><td colSpan={8} style={{ padding: '4px 10px 12px' }}><LogDetail entry={e} /></td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {rows.length === 0 && !loading && <tr><td style={td} colSpan={8}>{debouncedQ || filters.from || filters.to || filters.eventType ? '필터 일치 없음' : '로그 없음'}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              total={total}
              offset={offset}
              limit={limit}
              onOffsetChange={handleOffsetChange}
              onLimitChange={handleLimitChange}
            />
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>
              ※ <strong>의료기록</strong>은 별도 스트림(`medical-records`)으로 분리 봉인됩니다. 각 행위는 해시체인+TSA로 위변조 탐지, SSO 인증 시 의료진 본인 신원(sub·면허)까지 봉인.
            </p>
          </CardBody>
        </Card>
      </div>
    </AdminLayout>
  );
}
