'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { approvalsApi } from '@/lib/api';
import { RequestDto } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';

const DEFAULT_LIMIT = 20;
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

// 결재 봉투 상태(서명요청 상태 재사용): CREATED=상신, IN_PROGRESS=결재중, COMPLETED=완료, WITHDRAWN=반려/철회
const TABS: { key: string; label: string; status?: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'open', label: '진행중', status: 'IN_PROGRESS' },
  { key: 'created', label: '상신', status: 'CREATED' },
  { key: 'done', label: '완료', status: 'COMPLETED' },
];

export default function ApprovalsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<RequestDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const load = useCallback(async (currentOffset = 0, currentLimit = limit, search = q, status?: string) => {
    setLoading(true); setError('');
    try {
      const result = await approvalsApi.list({ limit: currentLimit, offset: currentOffset, q: search || undefined, status });
      setRows(result.data);
      setTotal(result.page.total);
    } catch (e) { setError(e instanceof Error ? e.message : '결재함 조회 실패'); }
    finally { setLoading(false); }
  }, [limit, q]);

  useEffect(() => { const t = setTimeout(() => setQ(filter.trim()), 300); return () => clearTimeout(t); }, [filter]);

  const status = TABS.find((t) => t.key === tab)?.status;
  useEffect(() => {
    setOffset(0);
    void load(0, limit, q, status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q]);
  useEffect(() => { void load(offset, limit, q, status); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset, limit]);

  const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 14px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)', background: active ? 'var(--color-primary,#2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)', fontWeight: active ? 600 : 400 });

  return (
    <AdminLayout title="결재함">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => setTab(t.key)} aria-pressed={tab === t.key}>{t.label}</button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="검색(제목·문서ID)" aria-label="결재 검색" style={{ width: 240 }} />
          </div>
        </div>

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}

        <Card>
          <CardHeader title={`결재 문서 (${total.toLocaleString('ko-KR')}건)`} />
          <CardBody>
            {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead><tr>
                    <th style={th}>제목</th><th style={th}>문서ID</th><th style={th}>상태</th>
                    <th style={th}>결재 진행</th><th style={th}>상신일</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.requestId} onClick={() => router.push('/admin/approvals/' + r.requestId)} style={{ cursor: 'pointer' }}>
                        <td style={td}><strong>{r.title}</strong></td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{r.externalDocId}</td>
                        <td style={td}><StatusPill status={r.status} /></td>
                        <td style={td}>{r.completedSigners} / {r.requiredSigners} 결재</td>
                        <td style={td}>{dt(r.createdAt)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && !loading && <tr><td style={td} colSpan={5}>{q ? '검색 일치 없음' : '결재 문서 없음'}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination total={total} offset={offset} limit={limit} onOffsetChange={setOffset} onLimitChange={(l) => { setLimit(l); setOffset(0); }} />
          </CardBody>
        </Card>
      </div>
    </AdminLayout>
  );
}
