'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi, authStorage } from '@/lib/api';
import { ContractRow, ContractStats } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { StatusPill } from '@/components/ui/StatusPill';

const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const D7 = 7 * 86_400_000;

/** 전자계약 랜딩 — 현황 카드 + 처리 필요 목록(내 서명 차례·발송 대기·만료 임박). 기획서 §3.1. */
export default function ContractOverviewPage() {
  const router = useRouter();
  const [stats, setStats] = useState<ContractStats | null>(null);
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => { setMe(authStorage.getUsername()); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try {
      const [st, list] = await Promise.all([contractsApi.stats(), contractsApi.list({ limit: 200 })]);
      setStats(st);
      setRows(list.items);
    } catch (e) {
      const m = e instanceof Error ? e.message : '조회 실패';
      if (/비활성/.test(m)) setDisabled(true); else setError(m);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (disabled) return (
    <AdminLayout title="계약 현황">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );

  const open = rows.filter((r) => r.status === 'CREATED' || r.status === 'IN_PROGRESS');
  const myTurn = me ? open.filter((r) => r.currentStep?.kind === 'INTERNAL' && r.currentStep.username === me) : [];
  const toSend = open.filter((r) => r.status === 'CREATED' && !r.lastSentAt && r.currentStep?.kind === 'EXTERNAL');
  const expiring = open.filter((r) => r.expiresAt && Date.parse(r.expiresAt) - Date.now() > 0 && Date.parse(r.expiresAt) - Date.now() <= D7);

  const statCard = (value: React.ReactNode, label: string, color?: string) => (
    <Card><CardBody>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{label}</div>
      </div>
    </CardBody></Card>
  );

  const taskTable = (title: string, items: ContractRow[], action: (r: ContractRow) => React.ReactNode, empty: string) => (
    <Card>
      <CardHeader title={`${title} (${items.length})`} />
      <CardBody>
        {items.length === 0 ? <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: 0 }}>{empty}</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr><th style={th}>제목</th><th style={th}>상태</th><th style={th}>현재 단계</th><th style={th}>만료</th><th style={th}></th></tr></thead>
              <tbody>
                {items.slice(0, 10).map((r) => (
                  <tr key={r.requestId} onClick={() => router.push('/admin/contracts/' + r.requestId)} style={{ cursor: 'pointer' }}>
                    <td style={td}><strong>{r.title}</strong></td>
                    <td style={td}><StatusPill status={r.status} /></td>
                    <td style={td}>{r.currentStep ? `${r.currentStep.order}차 · ${r.currentStep.displayName}${r.currentStep.kind === 'INTERNAL' ? ' (내부)' : ' (외부)'}` : '-'}</td>
                    <td style={td}>{dt(r.expiresAt)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{action(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );

  return (
    <AdminLayout title="계약 현황">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {statCard(stats?.open ?? 0, '진행 중')}
              {statCard(stats?.completed ?? 0, '체결 완료', 'var(--color-success-text)')}
              {statCard(stats?.expiringSoon ?? 0, '만료 임박(7일)', 'var(--color-warning-text)')}
              {statCard(stats?.total ?? 0, '전체 계약')}
            </div>

            {taskTable('내 서명 차례', myTurn, (r) => <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); router.push('/admin/contracts/' + r.requestId); }}>서명하러 가기</Button>, '내가 서명할 차례인 계약이 없습니다.')}
            {taskTable('발송 대기(미발송 작성분)', toSend, (r) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); router.push('/admin/contracts/' + r.requestId); }}>발송하기</Button>, '발송 대기 중인 계약이 없습니다.')}
            {taskTable('만료 임박(7일 이내)', expiring, (r) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); router.push('/admin/contracts/' + r.requestId); }}>독촉하기</Button>, '만료 임박 계약이 없습니다.')}

            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" onClick={() => router.push('/admin/contracts/new')}>새 계약</Button>
              <Button variant="ghost" onClick={() => router.push('/admin/contracts')}>계약함 전체 보기</Button>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
