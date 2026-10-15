'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 결재 감사 — 전자결재 스트림(approval:<id>)의 본인확인+행위 통합 인증로그 조회.
 * 플래그 ELECTRONIC_APPROVAL 전용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { approvalsApi } from '@/lib/api';
import { ApprovalAuditRow, ApiError } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Input } from '@/components/ui/Field';
import { LogDetail, shortHash } from '@/components/log/LogDetail';

const DEFAULT_LIMIT = 50;
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

export default function ApprovalAuditPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ApprovalAuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false); // 기능 비활성/권한 없음
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (currentOffset = 0, currentLimit = limit, search = q) => {
    setLoading(true); setError(''); setExpanded(null);
    try {
      const res = await approvalsApi.adminAuthLog({ limit: currentLimit, offset: currentOffset, q: search || undefined });
      setRows(res.data);
      setTotal(res.page.total);
      setDisabled(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '조회 실패';
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setDisabled(true);
      else if (/비활성/.test(msg)) setDisabled(true);
      else setError(msg);
    } finally { setLoading(false); }
  }, [limit, q]);

  useEffect(() => { const t = setTimeout(() => setQ(filter.trim()), 300); return () => clearTimeout(t); }, [filter]);
  useEffect(() => { setOffset(0); void load(0, limit, q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);
  useEffect(() => { void load(offset, limit, q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset, limit]);

  const exportCsv = async () => {
    setExporting(true); setError('');
    try { await approvalsApi.adminAuthExportCsv({ q: q || undefined }); }
    catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setExporting(false); }
  };

  return (
    <AdminLayout title="전자결재 인증로그">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>모든 결재의 본인확인 + 접속기록(F008) 통합 감사</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="검색(이벤트·결재자·의견·문서)" aria-label="결재 인증로그 검색" style={{ width: 260 }} />
            <Button onClick={exportCsv} loading={exporting} variant="ghost" size="sm" disabled={total === 0}>CSV</Button>
            <Button onClick={() => load(offset, limit, q)} loading={loading} variant="ghost" size="sm">새로고침</Button>
          </div>
        </div>

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {disabled && <Alert type="info" message="전자결재 기능이 비활성 상태이거나 접근 권한(approval:act)이 없습니다." />}

        {!disabled && (
          <Card>
            <CardHeader title={`결재 인증로그 (${total.toLocaleString('ko-KR')}건)`} />
            <CardBody>
              {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                    <thead><tr>
                      <th style={{ ...th, width: 24 }}></th>
                      <th style={th}>시각</th><th style={th}>결재 문서</th><th style={th}>이벤트</th>
                      <th style={th}>결재자</th><th style={th}>인증</th><th style={th}>단계</th><th style={th}>entryHash</th>
                    </tr></thead>
                    <tbody>
                      {rows.map((e, i) => {
                        const d = (e.data ?? {}) as Record<string, unknown>;
                        const auth = (d.auth ?? {}) as Record<string, unknown>;
                        const stepUp = String(auth.assurance ?? '').includes('STEP_UP') || String(auth.assurance ?? '').includes('STEPUP');
                        const open = expanded === i;
                        return (
                          <React.Fragment key={i}>
                            <tr onClick={() => setExpanded(open ? null : i)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                              <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                              <td style={td}>{dt(e.occurredAt)}</td>
                              <td style={td}>
                                <button
                                  onClick={(ev) => { ev.stopPropagation(); router.push('/admin/approvals/' + e.requestId); }}
                                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary, #2563eb)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
                                  title={e.requestId}
                                >
                                  {e.title || e.requestId.slice(0, 8)}
                                </button>
                              </td>
                              <td style={td}><strong>{e.eventType}</strong>{d.decision ? ` · ${d.decision}` : ''}</td>
                              <td style={td}>{String(d.actor ?? '-')}</td>
                              <td style={td}>
                                <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, background: stepUp ? 'var(--color-success-bg,#dcfce7)' : 'var(--color-bg-secondary,#f3f4f6)', color: stepUp ? 'var(--color-success-text)' : 'var(--color-text-muted)' }}>
                                  {String(auth.method ?? '-')}{stepUp ? ' · step-up' : ''}
                                </span>
                              </td>
                              <td style={td}>{d.step != null ? `${d.step}차` : '-'}</td>
                              <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{shortHash(e.entryHash as string | undefined)}</td>
                            </tr>
                            {open && <tr><td colSpan={8} style={{ padding: '4px 10px 12px' }}><LogDetail entry={e} /></td></tr>}
                          </React.Fragment>
                        );
                      })}
                      {rows.length === 0 && !loading && <tr><td style={td} colSpan={8}>{q ? '검색 일치 없음' : '결재 인증로그 없음'}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination total={total} offset={offset} limit={limit} onOffsetChange={setOffset} onLimitChange={(l) => { setLimit(l); setOffset(0); }} />
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>
                ※ 각 결재의 상세·무결성 검증(체인·TSA)은 결재 문서를 클릭해 <strong>건별</strong> 인증로그 탭에서 확인. 해시체인+TSA로 위변조 탐지.
              </p>
            </CardBody>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
