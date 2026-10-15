'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 문서·발급 로그 — 인증서 발급/서명 제출 등 시스템 활동 스트림 조회(기간·유형·검색 필터, CSV).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { requestsApi, certificatesApi } from '@/lib/api';
import { RequestDto, CertListRow } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { AuditFilterBar, AuditFilters, EMPTY_FILTERS, toApiRange, FilterSelect } from '@/components/log/AuditFilterBar';

const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const REQ_COLOR: Record<string, string> = { COMPLETED: 'var(--color-success-text)', IN_PROGRESS: 'var(--color-warning-text,#b45309)', CREATED: 'var(--color-text-muted)', WITHDRAWN: 'var(--color-danger-text)', EXPIRED: 'var(--color-danger-text)' };
const CERT_COLOR: Record<string, string> = { ACTIVE: 'var(--color-success-text)', SUSPENDED: 'var(--color-warning-text,#b45309)', REVOKED: 'var(--color-danger-text)', EXPIRED: 'var(--color-text-muted)' };
const cn = (dn: string) => dn.replace(/^CN=/i, '').replace(/,.*$/, '');

export default function ActivityLogPage() {
  const router = useRouter();
  const [reqs, setReqs] = useState<RequestDto[]>([]);
  const [certs, setCerts] = useState<CertListRow[]>([]);
  const [tab, setTab] = useState<'DOC' | 'CERT'>('DOC');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const [r, c] = await Promise.all([requestsApi.list(), certificatesApi.list()]); setReqs(r.data); setCerts(c.data); }
    catch (e) { setError(e instanceof Error ? e.message : '로그 조회 실패'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 검색·기간(클라측) — 전체 로드 모델이라 로드된 데이터에서 필터. from/to = 일 시작~끝(ISO).
  const { from, to } = toApiRange(filters);
  const q = filters.q.toLowerCase();
  const inRange = (iso?: string) => (!from || (!!iso && iso >= from)) && (!to || (!!iso && iso <= to));
  const docRows = reqs.filter((r) => (!q || r.title.toLowerCase().includes(q) || r.externalDocId.toLowerCase().includes(q)) && inRange(r.createdAt) && (!status || r.status === status));
  const certRows = [...certs].filter((c) => (!q || c.serialNumber.toLowerCase().includes(q) || c.subjectDn.toLowerCase().includes(q)) && inRange(c.notBefore) && (!status || c.status === status))
    .sort((a, b) => b.notBefore.localeCompare(a.notBefore));
  const statusOptions = (tab === 'DOC' ? Array.from(new Set(reqs.map((r) => r.status))) : Array.from(new Set(certs.map((c) => c.status)))).filter(Boolean).sort();

  const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 14px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)', background: active ? 'var(--color-primary,#2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)', fontWeight: active ? 600 : 400 });

  return (
    <AdminLayout title="문서·발급 로그">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={tabBtn(tab === 'DOC')} onClick={() => { setTab('DOC'); setStatus(''); }}>문서 서명 활동 ({reqs.length})</button>
          <button style={tabBtn(tab === 'CERT')} onClick={() => { setTab('CERT'); setStatus(''); }}>인증서 발급 이력 ({certs.length})</button>
        </div>
        <AuditFilterBar
          filters={filters}
          onChange={setFilters}
          searchPlaceholder={tab === 'DOC' ? '제목·외부문서ID 검색' : '시리얼·주체 검색'}
          searchAriaLabel="발급 로그 검색"
          extra={statusOptions.length > 0 && <FilterSelect label="상태" value={status} onChange={setStatus} options={[{ value: '', label: '전체 상태' }, ...statusOptions.map((s) => ({ value: s, label: s }))]} />}
          right={<Button onClick={load} loading={loading} variant="ghost" size="sm">새로고침</Button>}
        />
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}

        {tab === 'DOC' ? (
          <Card>
            <CardHeader title={`문서 서명 활동 (${docRows.length})`} />
            <CardBody>
              {loading && reqs.length === 0 ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                    <thead><tr><th style={th}>제목</th><th style={th}>외부문서ID</th><th style={th}>모드</th><th style={th}>서명</th><th style={th}>상태</th><th style={th}>만료</th><th style={th}></th></tr></thead>
                    <tbody>
                      {docRows.map((r) => (
                        <tr key={r.requestId} style={{ cursor: 'pointer' }} onClick={() => router.push(`/admin/requests/${r.requestId}`)}>
                          <td style={td}>{r.title}</td>
                          <td style={td}><code style={{ fontSize: 12 }}>{r.externalDocId}</code></td>
                          <td style={td}>{r.signMode}</td>
                          <td style={td}>{r.completedSigners}/{r.requiredSigners}</td>
                          <td style={td}><strong style={{ color: REQ_COLOR[r.status] ?? 'inherit' }}>{r.status}</strong></td>
                          <td style={td}>{dt(r.expiresAt)}</td>
                          <td style={{ ...td, color: 'var(--color-primary,#2563eb)', fontSize: 12 }}>감사 ›</td>
                        </tr>
                      ))}
                      {docRows.length === 0 && !loading && <tr><td style={td} colSpan={7}>문서 서명 활동 없음</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>행 클릭 → 요청 상세의 <strong>감사 탭</strong>(서명요청 생성·본인확인·서명·완료 이벤트 + 체인검증·감사추적 PDF).</p>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader title={`인증서 발급 이력 (${certRows.length})`} />
            <CardBody>
              {loading && certs.length === 0 ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                    <thead><tr><th style={th}>발급일</th><th style={th}>시리얼</th><th style={th}>유형</th><th style={th}>주체</th><th style={th}>키</th><th style={th}>상태</th></tr></thead>
                    <tbody>
                      {certRows.map((c) => (
                        <tr key={c.serialNumber}>
                          <td style={td}>{dt(c.notBefore)}</td>
                          <td style={td}><code style={{ fontSize: 12 }}>{c.serialNumber}</code></td>
                          <td style={td}>{c.ownerType}</td>
                          <td style={td}>{cn(c.subjectDn)}</td>
                          <td style={td}>{c.keyCustody}</td>
                          <td style={td}><strong style={{ color: CERT_COLOR[c.status] ?? 'inherit' }}>{c.status}</strong></td>
                        </tr>
                      ))}
                      {certRows.length === 0 && !loading && <tr><td style={td} colSpan={6}>발급 이력 없음</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>발급/폐기 행위자·시점 감사는 인증서별 감사체인(`/v1/certificates/:serial/audit`)에 봉인됩니다.</p>
            </CardBody>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
