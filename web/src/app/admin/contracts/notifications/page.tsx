'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { contractsApi, notificationsApi } from '@/lib/api';
import { ContractReminderStatus, NotifyRecord } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';

const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

/** 계약 알림·리마인더 — 자동 독촉 정책(읽기)·수동 실행·계약 발송이력(EMAIL). 기획서 §3.5. */
export default function ContractNotificationsPage() {
  const [policy, setPolicy] = useState<ContractReminderStatus | null>(null);
  const [records, setRecords] = useState<NotifyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try {
      const [p, all] = await Promise.all([contractsApi.reminderStatus(), notificationsApi.listAll({ limit: 200 })]);
      setPolicy(p);
      setRecords(all.data.filter((n) => n.channel === 'EMAIL'));
    } catch (e) {
      const m = e instanceof Error ? e.message : '조회 실패';
      if (/비활성/.test(m)) setDisabled(true); else setError(m);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await contractsApi.autoRemind();
      setMsg({ type: 'success', text: `자동 리마인더 실행 — 독촉 ${r.reminded}건 · 만료 경고 ${r.expiryWarned}건 · 건너뜀 ${r.skipped}건` });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '실행 실패' }); }
    finally { setBusy(false); }
  };

  if (disabled) return (
    <AdminLayout title="계약 알림·리마인더">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );

  const kindOf = (n: NotifyRecord) => ((n.title ?? '').startsWith('[교부]') ? '교부' : '서명 안내');

  return (
    <AdminLayout title="계약 알림·리마인더">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {msg && <Alert type={msg.type} message={msg.text} onClose={() => setMsg(null)} />}
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div> : (
          <>
            <Card>
              <CardHeader
                title="자동 리마인더 정책"
                description="스케줄러가 주기적으로 미서명 독촉·만료 임박 경고를 자동 발송합니다. 값 변경은 운영 환경변수로 설정합니다."
                actions={<Button variant="primary" size="sm" onClick={runNow} loading={busy}>지금 실행</Button>}
              />
              <CardBody>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 14 }}>
                  <span>미서명 독촉 <strong>{policy && policy.remindAfterDays > 0 ? `발송 후 ${policy.remindAfterDays}일 경과 시` : '끔'}</strong></span>
                  <span>만료 임박 경고 <strong>{policy?.expiryWarningHours}시간 전 · 계약당 1회</strong></span>
                  <span>점검 주기 <strong>{policy?.schedulerMin}분</strong></span>
                  <span>교부 링크 유효 <strong>{policy?.deliveryTtlHours}시간</strong></span>
                </div>
                <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span style={{ padding: '2px 8px', borderRadius: 999, background: policy?.provider === 'mock' ? 'var(--color-warning-bg,#fef3c7)' : 'var(--color-success-bg,#dcfce7)' }}>
                    발송 채널: {policy?.provider === 'mock' ? 'mock (실발송 없음 — 개발/미설정)' : `${policy?.provider}${policy?.smtpConfigured ? ' · SMTP 설정됨' : ''}`}
                  </span>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={`계약 발송이력 (${records.length}건)`} description="서명 안내·독촉·만료 경고·완료 교부 이메일(수신은 마스킹 저장)." />
              <CardBody>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                    <thead><tr><th style={th}>발송시각</th><th style={th}>종류</th><th style={th}>제목</th><th style={th}>수신</th><th style={th}>결과</th></tr></thead>
                    <tbody>
                      {records.slice(0, 100).map((n) => (
                        <tr key={n.id}>
                          <td style={td}>{dt(n.sentAt)}</td>
                          <td style={td}>{kindOf(n)}</td>
                          <td style={td}>{n.title ?? '-'}</td>
                          <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{n.toMasked}</td>
                          <td style={td}>{n.result}</td>
                        </tr>
                      ))}
                      {records.length === 0 && <tr><td style={td} colSpan={5}>계약 발송이력이 없습니다.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
