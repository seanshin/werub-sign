'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 인증서 목록·관리 — 서버측 검색/페이지네이션(/v1/certificates), 중단(suspend)/재개/폐기 액션.
 * CA 인증서는 목록에서 제외된다(운영 대상 아님).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useEffect, useMemo } from 'react';
import { certificatesApi, authStorage } from '@/lib/api';
import { CertListRow } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';

const REVOCABLE = ['ACTIVE', 'SUSPENDED'];

const DEFAULT_LIMIT = 50;

const dt = (s?: string) => (s ? new Date(s).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'var(--color-success-text)', SUSPENDED: 'var(--color-warning-text, #b45309)',
  REVOKED: 'var(--color-danger-text)', EXPIRED: 'var(--color-text-muted)',
};

// 유형 탭 (스탭/환자 구분)
const TYPE_TABS = [
  { key: 'ALL', label: '전체', match: () => true },
  { key: 'STAFF', label: '의료진', match: (t: string) => t === 'STAFF' },
  { key: 'PATIENT', label: '환자', match: (t: string) => t === 'PATIENT' },
  { key: 'ETC', label: '대리·증인', match: (t: string) => t === 'PROXY' || t === 'WITNESS' },
];

// 초성 인덱스
const LEAD = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const REP: Record<string, string> = { 'ㄲ': 'ㄱ', 'ㄸ': 'ㄷ', 'ㅃ': 'ㅂ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅈ' };
const cnOf = (dn: string) => dn.replace(/^CN=/i, '').replace(/,.*$/, '').trim();
function choseong(name: string): string {
  const c = name.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) { const l = LEAD[Math.floor((c - 0xac00) / 588)]; return REP[l] ?? l; }
  return '#';
}

export default function CertificatesListPage() {
  const [rows, setRows] = useState<CertListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('');
  const [debounced, setDebounced] = useState(''); // 서버 질의용 디바운스 검색어
  const [tab, setTab] = useState('ALL');
  const [cho, setCho] = useState(''); // 선택 초성('' = 전체)
  const [busy, setBusy] = useState('');
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      await certificatesApi.exportCsv({ q: debounced || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : '내보내기에 실패했습니다.');
    } finally {
      setExporting(false);
    }
  };
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const load = async () => {
    setLoading(true); setError('');
    try {
      // 서버측 검색: q(시리얼·주체·유형·면허) 전체 집합 대상. 유형 탭·초성은 현재 페이지 정제.
      const result = await certificatesApi.list({ limit, offset, q: debounced || undefined });
      setRows(result.data);
      setTotal(result.page.total);
    }
    catch (e) { setError(e instanceof Error ? e.message : '목록 조회 실패'); }
    finally { setLoading(false); }
  };

  // 검색어 디바운스(300ms) — 변경 시 첫 페이지로 리셋
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(filter); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [offset, limit, debounced]);

  const handleOffsetChange = (newOffset: number) => {
    setOffset(newOffset);
    setCho(''); // 페이지 이동 시 초성 초기화
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0);
    setCho('');
  };

  // 일괄 폐기(P1-2)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    const r = authStorage.getRole();
    setCanManage(r === null || r === 'admin' || r === 'operator'); // viewer 제외
  }, []);
  useEffect(() => { setSelected(new Set()); }, [tab, cho, debounced, offset]);

  const toggleSel = (serial: string) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(serial)) n.delete(serial); else n.add(serial); return n; });
  };
  const handleBulkRevoke = async () => {
    setBulkBusy(true);
    const serials = Array.from(selected);
    const results = await Promise.allSettled(serials.map((s) => certificatesApi.revoke(s, 'unspecified')));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    setBulkBusy(false); setBulkOpen(false); setSelected(new Set());
    if (fail > 0) setError(`${ok}건 폐기, ${fail}건 실패.`); else setMsg(`${ok}건 폐기 완료`);
    await load();
  };

  const act = async (serial: string, action: 'suspend' | 'resume' | 'revoke') => {
    const labels = { suspend: '중단', resume: '재개', revoke: '폐기' };
    if (action === 'revoke' && !confirm(`${serial} 인증서를 폐기합니다(되돌릴 수 없음). 계속?`)) return;
    setBusy(serial); setMsg(''); setError('');
    try {
      if (action === 'suspend') await certificatesApi.suspend(serial);
      else if (action === 'resume') await certificatesApi.resume(serial);
      else await certificatesApi.revoke(serial, 'unspecified');
      setMsg(`${serial} ${labels[action]} 완료`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : `${labels[action]} 실패`); }
    finally { setBusy(''); }
  };

  // 유형 탭 1차 필터 → 카운트·초성집합 (현재 페이지 내 클라이언트 필터)
  const byType = useMemo(() => rows.filter((r) => TYPE_TABS.find((t) => t.key === tab)!.match(r.ownerType)), [rows, tab]);
  const choSet = useMemo(() => new Set(byType.map((r) => choseong(cnOf(r.subjectDn)))), [byType]);
  const typeCounts = useMemo(() => Object.fromEntries(TYPE_TABS.map((t) => [t.key, rows.filter((r) => t.match(r.ownerType)).length])), [rows]);

  const filtered = byType.filter((r) => {
    if (cho && choseong(cnOf(r.subjectDn)) !== cho) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return r.serialNumber.toLowerCase().includes(q) || r.subjectDn.toLowerCase().includes(q) || (r.licenseNumber ?? '').includes(filter);
    }
    return true;
  });
  const revocableFiltered = filtered.filter((r) => REVOCABLE.includes(r.status));

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)',
    background: active ? 'var(--color-primary, #2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)',
    fontWeight: active ? 600 : 400,
  });
  const choBtn = (active: boolean, has: boolean): React.CSSProperties => ({
    minWidth: 30, padding: '4px 6px', fontSize: 13, borderRadius: 6, cursor: has ? 'pointer' : 'default',
    border: '1px solid ' + (active ? 'var(--color-primary, #2563eb)' : 'var(--color-border)'),
    background: active ? 'var(--color-primary, #2563eb)' : 'transparent',
    color: active ? '#fff' : has ? 'var(--color-text)' : 'var(--color-text-muted)', opacity: has ? 1 : 0.4,
  });

  return (
    <AdminLayout title="인증서 목록·관리">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* 유형 탭 — 스탭/환자 구분 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {TYPE_TABS.map((t) => (
            <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => { setTab(t.key); setCho(''); }}>
              {t.label} <span style={{ opacity: 0.7 }}>({typeCounts[t.key] ?? 0})</span>
            </button>
          ))}
          <Button onClick={() => load()} loading={loading} variant="ghost" size="sm" style={{ marginLeft: 'auto' }}>새로고침</Button>
          <Button onClick={handleExport} loading={exporting} variant="ghost" size="sm" aria-label="CSV 내보내기">내보내기</Button>
        </div>

        {/* 초성 인덱스 (이름 첫 자음) */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={choBtn(cho === '', true)} onClick={() => setCho('')}>전체</button>
          {['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ', '#'].map((c) => {
            const has = choSet.has(c);
            return <button key={c} style={choBtn(cho === c, has)} disabled={!has} onClick={() => has && setCho(c)}>{c}</button>;
          })}
        </div>

        <input placeholder="시리얼·주체·유형·면허 검색(전체)" value={filter} onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14 }} />

        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {msg && <Alert type="success" message={msg} onClose={() => setMsg('')} />}

        {canManage && selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'var(--color-primary-light)', border: '1px solid var(--color-primary)', borderRadius: 6, fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>
            <span>{selected.size}건 선택됨</span>
            <Button size="sm" variant="danger" onClick={() => setBulkOpen(true)}>선택 폐기</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>선택 해제</Button>
          </div>
        )}

        <Card>
          <CardHeader title={`${TYPE_TABS.find((t) => t.key === tab)!.label} 인증서 (${filtered.length} / 전체 ${total.toLocaleString('ko-KR')})`} />
          <CardBody>
            {loading && rows.length === 0 ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                  <thead><tr>
                    {canManage && <th style={{ ...th, width: 36 }}><input type="checkbox" aria-label="전체 선택"
                      checked={revocableFiltered.length > 0 && revocableFiltered.every((r) => selected.has(r.serialNumber))}
                      disabled={revocableFiltered.length === 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(revocableFiltered.map((r) => r.serialNumber)) : new Set())} /></th>}
                    <th style={th}>시리얼</th><th style={th}>주체</th><th style={th}>유형</th><th style={th}>면허</th>
                    <th style={th}>상태</th><th style={th}>키</th><th style={th}>만료</th><th style={th}>작업</th>
                  </tr></thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.serialNumber}>
                        {canManage && <td style={td}>{REVOCABLE.includes(r.status) && <input type="checkbox" aria-label="행 선택" checked={selected.has(r.serialNumber)} onChange={() => toggleSel(r.serialNumber)} />}</td>}
                        <td style={td}><code style={{ fontSize: 12 }}>{r.serialNumber}</code></td>
                        <td style={td}>{cnOf(r.subjectDn)}</td>
                        <td style={td}>{r.ownerType}</td>
                        <td style={td}>{r.licenseNumber ?? '-'}</td>
                        <td style={td}><strong style={{ color: STATUS_COLOR[r.status] ?? 'inherit' }}>{r.status}</strong></td>
                        <td style={td}>{r.keyCustody}</td>
                        <td style={td}>{dt(r.notAfter)}</td>
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {r.status === 'ACTIVE' && <Button size="sm" variant="ghost" loading={busy === r.serialNumber} onClick={() => act(r.serialNumber, 'suspend')}>중단</Button>}
                            {r.status === 'SUSPENDED' && <Button size="sm" variant="ghost" loading={busy === r.serialNumber} onClick={() => act(r.serialNumber, 'resume')}>재개</Button>}
                            {(r.status === 'ACTIVE' || r.status === 'SUSPENDED') && <Button size="sm" variant="danger" loading={busy === r.serialNumber} onClick={() => act(r.serialNumber, 'revoke')}>폐기</Button>}
                            {(r.status === 'REVOKED' || r.status === 'EXPIRED') && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>-</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && !loading && <tr><td style={td} colSpan={canManage ? 9 : 8}>해당 조건의 인증서 없음</td></tr>}
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
          </CardBody>
        </Card>
      </div>

      {/* 일괄 폐기 확인 */}
      <Modal
        open={bulkOpen}
        onClose={() => !bulkBusy && setBulkOpen(false)}
        title={`선택한 ${selected.size}건 폐기`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>취소</Button>
            <Button variant="danger" size="sm" onClick={handleBulkRevoke} loading={bulkBusy}>폐기</Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>선택한 <strong>{selected.size}건</strong>의 인증서를 폐기합니다. <strong>되돌릴 수 없으며</strong>, 폐기된 인증서로는 새 서명을 할 수 없습니다(기존 서명 검증은 폐기 시점 기준 유지).</p>
      </Modal>
    </AdminLayout>
  );
}
