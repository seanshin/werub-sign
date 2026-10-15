'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi } from '@/lib/api';
import { ContractCategorySummary } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';

/**
 * 완료 계약 카테고리별 관리 — 카테고리별 체결완료·전체 건수 집계, 선택 시 해당 카테고리 계약함으로 이동.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function ContractCategoriesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ContractCategorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await contractsApi.categories()); }
    catch (e) { const m = e instanceof Error ? e.message : '조회 실패'; if (/비활성/.test(m)) setDisabled(true); else setError(m); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const totalCompleted = rows.reduce((a, r) => a + r.completed, 0);
  const totalAll = rows.reduce((a, r) => a + r.total, 0);

  if (disabled) return (
    <AdminLayout title="카테고리 관리">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );

  return (
    <AdminLayout title="카테고리 관리">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: 0 }}>
          체결 완료된 전자계약을 카테고리별로 분류·관리합니다. 카테고리를 선택하면 해당 분류의 계약 목록으로 이동합니다.
          계약 카테고리는 생성 시 지정하거나 계약 상세에서 변경할 수 있습니다.
        </p>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}

        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div> : rows.length === 0 ? (
          <Card><CardBody><p style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-muted)' }}>분류할 계약이 없습니다.</p></CardBody></Card>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {rows.map((r) => (
                <button
                  key={r.category}
                  onClick={() => router.push(`/admin/contracts?category=${encodeURIComponent(r.category)}&status=COMPLETED`)}
                  style={{ textAlign: 'left', border: '1px solid var(--color-border)', borderRadius: 12, padding: 18, background: 'var(--color-bg,#fff)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <strong style={{ fontSize: 16 }}>{r.category}</strong>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success-text,#166534)' }}>{r.completed}</span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>체결완료 / 전체 {r.total}건</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--color-primary,#2563eb)' }}>완료 계약 보기 →</span>
                </button>
              ))}
            </div>
            <Card><CardBody>
              <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
                <span>총 <strong>{rows.length}</strong>개 카테고리</span>
                <span>체결완료 <strong style={{ color: 'var(--color-success-text,#166534)' }}>{totalCompleted}</strong>건</span>
                <span>전체 <strong>{totalAll}</strong>건</span>
              </div>
            </CardBody></Card>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
