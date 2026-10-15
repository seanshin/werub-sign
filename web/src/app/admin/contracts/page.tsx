'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 계약함 — 일반 전자계약 목록(상태·분류·라벨·보관 필터는 서버 푸시다운), 현황 통계 탭.
 * 플래그 GENERAL_CONTRACTS 전용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { contractsApi } from '@/lib/api';
import { ContractRow } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';

const DEFAULT_LIMIT = 20;
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

// 계약 봉투 상태(서명요청 상태 재사용): CREATED=작성/발송대기, IN_PROGRESS=서명중, COMPLETED=체결
const TABS: { key: string; label: string; status?: string; archived?: boolean }[] = [
  { key: 'all', label: '전체' },
  { key: 'open', label: '서명중', status: 'IN_PROGRESS' },
  { key: 'created', label: '작성', status: 'CREATED' },
  { key: 'done', label: '체결완료', status: 'COMPLETED' },
  { key: 'archived', label: '보관됨', archived: true },
];

export default function ContractsPage() {
  return <Suspense fallback={null}><ContractsInner /></Suspense>;
}

function ContractsInner() {
  const router = useRouter();
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false); // 기능 비활성(플래그 OFF)
  const [tab, setTab] = useState('all');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [exporting, setExporting] = useState(false);
  const [labelFilter, setLabelFilter] = useState(''); // 라벨 칩 클릭 필터
  const [categoryFilter, setCategoryFilter] = useState(''); // 카테고리 필터(카테고리 관리에서 진입)
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const searchParams = useSearchParams();
  // 카테고리 관리 화면에서 ?category=X&status=COMPLETED 로 진입 시 초기 필터 적용
  useEffect(() => {
    const c = searchParams.get('category');
    if (c) setCategoryFilter(c);
    if (searchParams.get('status') === 'COMPLETED') setTab('done');
  }, [searchParams]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const tabDef = TABS.find((t) => t.key === tab);

  const load = useCallback(async (currentOffset = 0, currentLimit = limit, search = q, status?: string, archived?: boolean) => {
    setLoading(true); setError('');
    try {
      const result = await contractsApi.list({
        limit: currentLimit, offset: currentOffset, q: search || undefined, status,
        label: labelFilter || undefined, category: categoryFilter || undefined, from: fromDate || undefined, to: toDate || undefined,
        archived: archived || undefined,
      });
      setRows(result.items);
      setTotal(result.total);
      setTruncated(!!result.truncated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '계약함 조회 실패';
      if (/비활성/.test(msg)) setDisabled(true); else setError(msg);
    } finally { setLoading(false); }
  }, [limit, q, labelFilter, categoryFilter, fromDate, toDate]);

  useEffect(() => { const t = setTimeout(() => setQ(filter.trim()), 300); return () => clearTimeout(t); }, [filter]);

  const status = tabDef?.status;
  const archived = tabDef?.archived;
  useEffect(() => {
    setOffset(0);
    void load(0, limit, q, status, archived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, labelFilter, categoryFilter, fromDate, toDate]);
  useEffect(() => { void load(offset, limit, q, status, archived); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset, limit]);

  const doArchive = async (r: ContractRow) => {
    const reason = window.prompt(`"${r.title}"을(를) 계약함에서 제거(보관)합니다.\n데이터·서명·감사 이력은 보존되며 '보관됨' 탭에서 확인·복원할 수 있습니다.\n\n제거 사유(선택):`, '');
    if (reason === null) return; // 취소
    setBusyId(r.requestId);
    try { await contractsApi.archive(r.requestId, reason.trim() || undefined); await load(offset, limit, q, status, archived); }
    catch (e) { setError(e instanceof Error ? e.message : '보관 처리 실패'); }
    finally { setBusyId(null); }
  };
  const doUnarchive = async (r: ContractRow) => {
    setBusyId(r.requestId);
    try { await contractsApi.unarchive(r.requestId); await load(offset, limit, q, status, archived); }
    catch (e) { setError(e instanceof Error ? e.message : '복원 실패'); }
    finally { setBusyId(null); }
  };

  const exportCsv = async () => {
    setExporting(true);
    try { await contractsApi.exportCsv({ q: q || undefined, status }); }
    catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setExporting(false); }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 14px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)', background: active ? 'var(--color-primary,#2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)', fontWeight: active ? 600 : 400 });

  if (disabled) return (
    <AdminLayout title="계약함">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정). 관리자에게 문의하세요." />
    </AdminLayout>
  );

  return (
    <AdminLayout title="계약함">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => setTab(t.key)} aria-pressed={tab === t.key}>{t.label}</button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="검색(제목·문서ID)" aria-label="계약 검색" style={{ width: 220 }} />
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="시작일(생성일 기준)" style={{ padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'transparent', color: 'var(--color-text)' }} />
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} aria-label="종료일(생성일 기준)" style={{ padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'transparent', color: 'var(--color-text)' }} />
            <Button variant="ghost" onClick={exportCsv} loading={exporting} aria-label="CSV 내보내기">CSV</Button>
            <Button variant="primary" onClick={() => router.push('/admin/contracts/new')}>새 계약</Button>
          </div>
        </div>

        {labelFilter && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <span>라벨 필터:</span>
            <span style={{ padding: '2px 10px', borderRadius: 999, background: 'var(--color-primary,#2563eb)', color: '#fff', fontSize: 13 }}>{labelFilter}</span>
            <Button size="sm" variant="ghost" onClick={() => setLabelFilter('')} aria-label="라벨 필터 해제">해제</Button>
          </div>
        )}
        {categoryFilter && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <span>카테고리 필터:</span>
            <span style={{ padding: '2px 10px', borderRadius: 999, background: 'var(--color-success-bg,#dcfce7)', color: 'var(--color-success-text,#166534)', fontSize: 13 }}>{categoryFilter}</span>
            <Button size="sm" variant="ghost" onClick={() => setCategoryFilter('')} aria-label="카테고리 필터 해제">해제</Button>
          </div>
        )}

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {truncated && <Alert type="info" message="계약 건수가 조회 상한(2,000건)을 초과했습니다. 목록·집계에 일부가 누락될 수 있으니 검색·필터로 범위를 좁혀 사용하세요." />}

        <Card>
          <CardHeader title={`계약 문서 (${total.toLocaleString('ko-KR')}건)`} />
          <CardBody>
            {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                  <thead><tr>
                    <th style={th}>제목</th><th style={th}>문서ID</th><th style={th}>카테고리</th><th style={th}>라벨</th><th style={th}>상태</th>
                    <th style={th}>서명 진행</th>{archived ? <th style={th}>제거 정보</th> : <th style={th}>현재 단계</th>}<th style={th}>생성일</th><th style={th}></th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.requestId} onClick={() => router.push('/admin/contracts/' + r.requestId)} style={{ cursor: 'pointer' }}>
                        <td style={td}><strong>{r.title}</strong>{r.hasAccessCode ? <span title="접근암호 설정" style={{ marginLeft: 6 }}>🔒</span> : null}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{r.externalDocId}</td>
                        <td style={td}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setCategoryFilter(r.category || '기타'); }}
                            aria-label={`카테고리 ${r.category || '기타'} 필터`}
                            style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, border: 'none', cursor: 'pointer', background: categoryFilter === (r.category || '기타') ? 'var(--color-success-text,#166534)' : 'var(--color-bg-secondary,#f3f4f6)', color: categoryFilter === (r.category || '기타') ? '#fff' : 'var(--color-text-secondary)' }}
                          >{r.category || '기타'}</button>
                        </td>
                        <td style={td}>{r.labels.map((l) => (
                          <button
                            key={l}
                            onClick={(e) => { e.stopPropagation(); setLabelFilter(l); }}
                            aria-label={`라벨 ${l} 필터`}
                            style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, border: 'none', cursor: 'pointer', background: labelFilter === l ? 'var(--color-primary,#2563eb)' : 'var(--color-bg-secondary,#f3f4f6)', color: labelFilter === l ? '#fff' : 'var(--color-text-secondary)', marginRight: 4 }}
                          >{l}</button>
                        ))}</td>
                        <td style={td}><StatusPill status={r.status} /></td>
                        <td style={td}>{r.completedSigners} / {r.requiredSigners} 서명</td>
                        {archived ? (
                          <td style={{ ...td, fontSize: 12, color: 'var(--color-text-muted)' }}>{dt(r.archivedAt)}{r.archiveReason ? ` · ${r.archiveReason}` : ''}</td>
                        ) : (
                          <td style={td}>{r.signingMode === 'PARALLEL'
                            ? (r.completedSigners < r.requiredSigners ? `동시 · 남은 ${r.requiredSigners - r.completedSigners}명` : '-')
                            : r.currentStep ? `${r.currentStep.order}차 ${r.currentStep.kind === 'INTERNAL' ? '내부' : '외부'}` : '-'}</td>
                        )}
                        <td style={td}>{dt(r.createdAt)}</td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          {archived
                            ? <Button size="sm" variant="ghost" onClick={() => doUnarchive(r)} loading={busyId === r.requestId}>복원</Button>
                            : <Button size="sm" variant="ghost" onClick={() => doArchive(r)} loading={busyId === r.requestId} aria-label={`${r.title} 제거(보관)`}>제거</Button>}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && !loading && <tr><td style={td} colSpan={9}>{archived ? '보관된 계약이 없습니다' : q || labelFilter || categoryFilter ? '검색 일치 없음' : '계약 문서 없음 — “새 계약”으로 시작하세요'}</td></tr>}
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
