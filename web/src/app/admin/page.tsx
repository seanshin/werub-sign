'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 관리자 콘솔 — 대시보드(계약 현황). 서명요청·계약 통계와 최근 목록, SSE(/v1/events/stream)로
 * 새 요청이 새로고침 없이 자동 등장한다. 로그인 후 첫 화면.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { requestsApi, contractsApi, authStorage } from '@/lib/api';
import { useRealtime } from '@/lib/useRealtime';
import { RequestDto, ContractStats } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Table } from '@/components/ui/Table';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Alert } from '@/components/ui/Toast';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import styles from './page.module.css';

const WITHDRAWABLE = ['CREATED', 'IN_PROGRESS'];

const DEFAULT_LIMIT = 50;
const DEFAULT_PERIOD = '90'; // 기본 기간(일) — 대시보드 working set 상한(데이터 누적 대비)

const PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '7', label: '최근 7일' },
  { value: '30', label: '최근 30일' },
  { value: '90', label: '최근 90일' },
  { value: '365', label: '최근 1년' },
  { value: '', label: '전체 기간' },
];

const INCOMPLETE = '__incomplete__'; // 미완료(서명 대기) 다중상태 센티넬

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '전체 상태' },
  { value: INCOMPLETE, label: '미완료(서명 대기)' },
  { value: 'CREATED', label: '생성됨' },
  { value: 'IN_PROGRESS', label: '진행중' },
  { value: 'COMPLETED', label: '완료' },
  { value: 'EXPIRED', label: '만료' },
  { value: 'WITHDRAWN', label: '철회' },
  { value: 'SUPERSEDED', label: '개정됨' },
];

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '전체 출처' },
  { value: 'hospitalrun', label: 'HIS' },
  { value: 'pacs', label: 'PACS' },
  { value: 'erp', label: 'ERP' },
  { value: 'console', label: '콘솔' },
];

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '전체 모드' },
  { value: 'APP', label: 'APP' },
  { value: 'PORTAL', label: 'PORTAL' },
  { value: 'MULTI', label: 'MULTI' },
];

export default function AdminDashboard() {
  const router = useRouter();
  const [requests, setRequests] = useState<RequestDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState(''); // 서버 질의용 디바운스 검색어
  const [statusFilter, setStatusFilter] = useState('');
  const [source, setSource] = useState(''); // 출처(createdBy)
  const [mode, setMode] = useState(''); // 서명모드(signMode)
  const [period, setPeriod] = useState(DEFAULT_PERIOD); // 기간 필터(일). ''=전체
  const [fromDate, setFromDate] = useState(''); // 커스텀 기간 시작(YYYY-MM-DD)
  const [toDate, setToDate] = useState(''); // 커스텀 기간 종료
  const [offset, setOffset] = useState(0);
  const [ctStats, setCtStats] = useState<ContractStats | null>(null); // 전자계약 위젯(기능 비활성 시 숨김)

  useEffect(() => { contractsApi.stats().then(setCtStats).catch(() => setCtStats(null)); }, []);

  // 운영자(operator)는 전자계약 전담 — 대시보드 대신 계약 현황으로 랜딩(메뉴 정책과 일치)
  useEffect(() => {
    if (authStorage.getRole() === 'operator') router.replace('/admin/contracts/overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  // 공용 필터(상태·미완료·출처·모드·기간) — 목록·내보내기 공유. 커스텀 기간(from/to) 우선, 없으면 days 프리셋.
  const filterOpts = () => {
    const isIncomplete = statusFilter === INCOMPLETE;
    const range = (fromDate || toDate)
      ? { from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined, to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined }
      : { days: period ? Number(period) : undefined };
    return {
      q: debounced || undefined,
      status: isIncomplete ? undefined : (statusFilter || undefined),
      incomplete: isIncomplete || undefined,
      createdBy: source || undefined,
      signMode: mode || undefined,
      ...range,
    };
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      // 서버측 필터(DB 푸시다운): 검색·상태·미완료·출처·모드·기간을 백엔드로 전달(전체 집합 대상)
      const result = await requestsApi.list({ limit, offset, ...filterOpts() });
      setRequests(result.data);
      setTotal(result.page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : '목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  // 실시간(SSE): 서명요청 상태 변경 시 자동 재조회(디바운스). 선택 중엔 보류(혼동 방지).
  const loadRef = useRef(load);
  loadRef.current = load;
  const rtTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRealtime((e) => {
    if (e.type !== 'request.changed') return;
    if (selected.size > 0) return;
    if (rtTimer.current) clearTimeout(rtTimer.current);
    rtTimer.current = setTimeout(() => loadRef.current(), 1200); // 버스트 합치기
  });

  // 검색어 디바운스(300ms) — 입력 변경 시 첫 페이지로 리셋
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // offset·limit·검색어·상태·출처·모드·기간(프리셋/커스텀) 변경 시 서버 재조회
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, limit, debounced, statusFilter, source, mode, period, fromDate, toDate]);

  const handleOffsetChange = (newOffset: number) => {
    setOffset(newOffset);
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0);
  };

  const handleRefresh = () => {
    void load();
  };

  // 일괄 철회(P1-2)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [canWithdraw, setCanWithdraw] = useState(false); // 클라이언트에서만 판정(SSR 시 sessionStorage 없음)
  useEffect(() => {
    const r = authStorage.getRole();
    setCanWithdraw(r === null || r === 'admin' || r === 'operator'); // viewer 제외
  }, []);

  // 페이지/필터 변경 시 선택 초기화(페이지 간 혼동 방지)
  useEffect(() => { setSelected(new Set()); }, [offset, debounced, statusFilter, source, mode, period, fromDate, toDate]);

  const handleBulkWithdraw = async () => {
    setBulkBusy(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => requestsApi.withdraw(id, bulkReason || undefined)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    setBulkBusy(false);
    setBulkOpen(false);
    setBulkReason('');
    setSelected(new Set());
    setError(fail > 0 ? `${ok}건 철회, ${fail}건 실패(이미 완료/철회된 건 등).` : '');
    await load();
  };

  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      await requestsApi.exportCsv(filterOpts());
    } catch (e) {
      setError(e instanceof Error ? e.message : '내보내기에 실패했습니다.');
    } finally {
      setExporting(false);
    }
  };

  const handleStatusChange = (v: string) => {
    setStatusFilter(v);
    setOffset(0);
  };

  const handlePeriodChange = (v: string) => {
    setPeriod(v);
    setOffset(0);
  };

  // Stats: 현재 페이지 내 카운트 + 전체 total 표시
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    requests.forEach((r) => { counts[r.status] = (counts[r.status] ?? 0) + 1; });
    return counts;
  }, [requests]);

  const columns = [
    { key: 'requestId', label: '요청 ID', render: (r: RequestDto) => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
        {r.requestId.slice(0, 8)}...
      </span>
    )},
    { key: 'title', label: '제목', render: (r: RequestDto) => (
      <div>
        <div style={{ fontWeight: 'var(--font-medium)', fontSize: 'var(--text-sm)' }}>
          {r.title || r.externalDocId}
        </div>
        {r.title && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
            {r.externalDocId}
          </div>
        )}
      </div>
    )},
    { key: 'signMode', label: '서명 모드', render: (r: RequestDto) => (
      <span className={styles.badge}>{r.signMode}</span>
    )},
    { key: 'status', label: '상태', render: (r: RequestDto) => <StatusPill status={r.status} /> },
    { key: 'progress', label: '서명', render: (r: RequestDto) => (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
        {r.completedSigners} / {r.requiredSigners}
      </span>
    )},
    { key: 'createdAt', label: '생성일', render: (r: RequestDto) => (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
        {r.createdAt ? new Date(r.createdAt).toLocaleDateString('ko-KR') : '-'}
      </span>
    )},
    { key: 'expiresAt', label: '만료일', render: (r: RequestDto) => (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
        {r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('ko-KR') : '-'}
      </span>
    )},
    { key: 'participants', label: '참가자', render: (r: RequestDto) => (
      <span style={{ fontSize: 'var(--text-xs)' }}>{r.participants.length}명</span>
    )},
  ];

  return (
    <AdminLayout title="서명요청 대시보드">
      {/* Stats */}
      <div className={styles.stats}>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{total.toLocaleString('ko-KR')}</div>
          <div className={styles.statLabel}>전체 요청</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: 'var(--color-success-text)' }}>
            {stats['COMPLETED'] ?? 0}
          </div>
          <div className={styles.statLabel}>완료 (현 페이지)</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: 'var(--color-warning-text)' }}>
            {(stats['CREATED'] ?? 0) + (stats['IN_PROGRESS'] ?? 0)}
          </div>
          <div className={styles.statLabel}>진행 중 (현 페이지)</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: 'var(--color-danger-text)' }}>
            {(stats['EXPIRED'] ?? 0) + (stats['WITHDRAWN'] ?? 0)}
          </div>
          <div className={styles.statLabel}>만료/철회 (현 페이지)</div>
        </div>
        {ctStats && (
          <div
            className={styles.statCard}
            role="link"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => router.push('/admin/contracts/overview')}
            onKeyDown={(e) => { if (e.key === 'Enter') router.push('/admin/contracts/overview'); }}
            aria-label={`전자계약 — 진행 ${ctStats.open}건, 체결 ${ctStats.completed}건. 계약 현황으로 이동`}
          >
            <div className={styles.statValue}>{ctStats.open}</div>
            <div className={styles.statLabel}>전자계약 진행 (체결 {ctStats.completed})</div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          placeholder="요청ID·문서ID·제목·참가자명 검색(전체)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="서명요청 검색"
        />
        <select
          className={styles.filter}
          value={period}
          onChange={(e) => handlePeriodChange(e.target.value)}
          aria-label="기간 필터"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          className={styles.filter}
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          aria-label="상태 필터"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          className={styles.filter}
          value={source}
          onChange={(e) => { setSource(e.target.value); setOffset(0); }}
          aria-label="출처 필터"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          className={styles.filter}
          value={mode}
          onChange={(e) => { setMode(e.target.value); setOffset(0); }}
          aria-label="서명모드 필터"
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          className={styles.filter}
          type="date"
          value={fromDate}
          max={toDate || undefined}
          onChange={(e) => { setFromDate(e.target.value); setOffset(0); }}
          aria-label="시작일(생성일 기준)"
          title="시작일 — 지정 시 기간 프리셋 대신 적용"
        />
        <input
          className={styles.filter}
          type="date"
          value={toDate}
          min={fromDate || undefined}
          onChange={(e) => { setToDate(e.target.value); setOffset(0); }}
          aria-label="종료일(생성일 기준)"
          title="종료일 — 지정 시 기간 프리셋 대신 적용"
        />
        {(fromDate || toDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setFromDate(''); setToDate(''); setOffset(0); }} aria-label="기간 직접지정 해제">기간 초기화</Button>
        )}
        <Button variant="ghost" onClick={handleRefresh} aria-label="새로고침">
          새로고침
        </Button>
        <Button variant="ghost" onClick={handleExport} loading={exporting} aria-label="CSV 내보내기">
          내보내기
        </Button>
        <Button onClick={() => router.push('/admin/requests/new')}>
          새 서명요청
        </Button>
      </div>

      {/* Error */}
      {error && <Alert type="error" message={error} onClose={() => setError('')} />}

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-10)' }}>
          <Spinner size={36} />
        </div>
      ) : (
        <>
          {canWithdraw && selected.size > 0 && (
            <div className={styles.bulkBar}>
              <span>{selected.size}건 선택됨</span>
              <Button size="sm" variant="danger" onClick={() => setBulkOpen(true)}>선택 철회</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>선택 해제</Button>
            </div>
          )}
          <Table
            columns={columns}
            data={requests}
            rowKey={(r) => r.requestId}
            onRowClick={(r) => router.push(`/admin/requests/${r.requestId}`)}
            emptyMessage={debounced || statusFilter || source || mode || fromDate || toDate || period ? '해당 조건의 요청이 없습니다. 필터(기간·상태·출처·모드·검색)를 조정해 보세요.' : '서명요청이 없습니다. 새 서명요청을 생성해 주세요.'}
            selectable={canWithdraw}
            selectedKeys={selected}
            onSelectionChange={setSelected}
            isSelectable={(r) => WITHDRAWABLE.includes(r.status)}
          />
          <Pagination
            total={total}
            offset={offset}
            limit={limit}
            onOffsetChange={handleOffsetChange}
            onLimitChange={handleLimitChange}
          />
        </>
      )}

      {/* 일괄 철회 확인 */}
      <Modal
        open={bulkOpen}
        onClose={() => !bulkBusy && setBulkOpen(false)}
        title={`선택한 ${selected.size}건 철회`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>취소</Button>
            <Button variant="danger" size="sm" onClick={handleBulkWithdraw} loading={bulkBusy}>철회</Button>
          </>
        }
      >
        <p style={{ margin: '0 0 var(--space-3)' }}>
          선택한 <strong>{selected.size}건</strong>을 철회합니다. 철회된 요청은 이후 서명할 수 없습니다(되돌릴 수 없음).
        </p>
        <Field label="사유(선택)" htmlFor="bulk-reason">
          <Input id="bulk-reason" value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} placeholder="예: 문서 재발행" />
        </Field>
      </Modal>
    </AdminLayout>
  );
}
