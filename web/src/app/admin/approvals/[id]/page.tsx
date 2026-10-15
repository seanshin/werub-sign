'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 전자결재 상세 — 결재선 진행·결재/반려 액션·통합 인증로그 뷰어.
 * 플래그 ELECTRONIC_APPROVAL 전용(기본 숨김 — 실서비스 결재는 weRB 문서인증 담당).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { approvalsApi, authApi } from '@/lib/api';
import { ApprovalDto, AuditEntry, AuditVerifyResult, ApprovalActBody } from '@/types/api';
import { authStorage } from '@/lib/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/ui/Modal';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { LogDetail, shortHash } from '@/components/log/LogDetail';

type PageProps = { params: { id: string } };
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

export default function ApprovalDetailPage({ params }: PageProps) {
  const { id } = params;
  const router = useRouter();
  const [dto, setDto] = useState<ApprovalDto | null>(null);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [verifyR, setVerifyR] = useState<AuditVerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false); // 기능 비활성(플래그 OFF) 안내
  const [expanded, setExpanded] = useState<number | null>(null);
  const [canAct, setCanAct] = useState(false);

  // 결재 액션 모달
  const [actOpen, setActOpen] = useState(false);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [opinion, setOpinion] = useState('');
  const [ci, setCi] = useState('');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [actMsg, setActMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => { const r = authStorage.getRole(); setCanAct(r === null || r === 'admin' || r === 'operator'); }, []);
  useEffect(() => { authApi.status2fa().then((s) => setMfaEnabled(!!s.enabled)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try {
      const d = await approvalsApi.get(id);
      setDto(d);
      const entries = await approvalsApi.authLog(id);
      setLog([...entries].reverse());
      approvalsApi.authVerify(id).then(setVerifyR).catch(() => setVerifyR(null));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '조회 실패';
      // 기능 비활성(404 '전자결재 기능 비활성') 안내
      if (/비활성/.test(msg)) setDisabled(true); else setError(msg);
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const current = dto?.participants ? [...dto.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED') : undefined;
  const isOpen = dto?.status === 'CREATED' || dto?.status === 'IN_PROGRESS';
  const isFinal = !!current && !!dto && current.signOrder >= dto.requiredSigners;
  const needStepUp = !!dto?.highRisk || isFinal;

  const openAct = (d: 'APPROVE' | 'REJECT') => { setDecision(d); setOpinion(''); setCi(''); setMfaCode(''); setActMsg(null); setActOpen(true); };

  const submitAct = async () => {
    setBusy(true); setActMsg(null);
    try {
      const body: ApprovalActBody = { decision, opinion: opinion || undefined };
      if (decision === 'APPROVE' && needStepUp) body.stepUp = mfaEnabled ? { mfaCode: mfaCode.trim() } : { method: 'PASS', ci: ci.trim() };
      const r = await approvalsApi.act(id, body);
      setActOpen(false);
      setActMsg({ type: 'success', text: `${decision === 'APPROVE' ? '승인' : '반려'} 완료 — 상태 ${r.status}` });
      await load();
    } catch (e) {
      setActMsg({ type: 'error', text: e instanceof Error ? e.message : '결재 실패' });
    } finally { setBusy(false); }
  };

  const exportCsv = async () => { try { await approvalsApi.authExportCsv(id); } catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); } };

  if (loading) return <AdminLayout title="결재 상세"><div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div></AdminLayout>;
  if (disabled) return (
    <AdminLayout title="결재 상세">
      <Button onClick={() => router.push('/admin/approvals')} variant="ghost" size="sm">← 결재함</Button>
      <div style={{ marginTop: 16 }}><Alert type="info" message="전자결재 기능이 비활성 상태입니다(보안검토 sign-off 후 활성). 관리자에게 문의하세요." /></div>
    </AdminLayout>
  );
  if (error || !dto) return (
    <AdminLayout title="결재 상세">
      <Button onClick={() => router.push('/admin/approvals')} variant="ghost" size="sm">← 결재함</Button>
      <div style={{ marginTop: 16 }}><Alert type="error" message={error || '결재 문서 없음'} /></div>
    </AdminLayout>
  );

  const lineTab = (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr><th style={th}>순서</th><th style={th}>결재자</th><th style={th}>역할</th><th style={th}>상태</th></tr></thead>
        <tbody>
          {[...dto.participants].sort((a, b) => a.signOrder - b.signOrder).map((p) => {
            const isCur = current?.participantId === p.participantId && isOpen;
            return (
              <tr key={p.participantId} style={{ background: isCur ? 'var(--color-bg-secondary)' : undefined }}>
                <td style={td}>{p.signOrder}차{isCur ? ' ◀ 현재' : ''}</td>
                <td style={td}><strong>{p.displayName}</strong></td>
                <td style={td}>{p.signerRole}</td>
                <td style={td}><StatusPill status={p.status} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const logTab = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>본인확인 사실 + F008 접속기록 통합 봉인 · {log.length}건</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={exportCsv} variant="ghost" size="sm" disabled={log.length === 0}>CSV</Button>
        </div>
      </div>
      {verifyR && (
        <Alert
          type={!verifyR.chainValid ? 'error' : verifyR.valid ? 'success' : 'info'}
          message={`인증로그 무결성: 체인 ${verifyR.chainValid ? '유효' : '깨짐(위변조 의심)'} · TSA 앵커 ${verifyR.anchored ? '봉인됨' : '미앵커(진행중)'}`} />
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
          <thead><tr>
            <th style={{ ...th, width: 24 }}></th><th style={th}>시각</th><th style={th}>이벤트</th>
            <th style={th}>결재자</th><th style={th}>인증</th><th style={th}>단계</th><th style={th}>entryHash</th>
          </tr></thead>
          <tbody>
            {log.map((e, i) => {
              const d = (e.data ?? {}) as Record<string, unknown>;
              const auth = (d.auth ?? {}) as Record<string, unknown>;
              const stepUp = auth.assurance === 'STEP_UP';
              const open = expanded === i;
              return (
                <React.Fragment key={i}>
                  <tr onClick={() => setExpanded(open ? null : i)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                    <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                    <td style={td}>{dt(e.occurredAt)}</td>
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
                  {open && <tr><td colSpan={7} style={{ padding: '4px 10px 12px' }}><LogDetail entry={e} /></td></tr>}
                </React.Fragment>
              );
            })}
            {log.length === 0 && <tr><td style={td} colSpan={7}>인증로그 없음</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <AdminLayout title="결재 상세">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Button onClick={() => router.push('/admin/approvals')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>← 결재함</Button>
        {actMsg && <Alert type={actMsg.type} message={actMsg.text} onClose={() => setActMsg(null)} />}

        <Card>
          <CardHeader
            title={dto.title}
            description={`문서 ${dto.externalDocId}${dto.docType ? ` · ${dto.docType}` : ''}${dto.highRisk ? ' · 고위험' : ''}`}
            actions={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusPill status={dto.status} />
                {canAct && isOpen && <>
                  <Button onClick={() => openAct('APPROVE')} variant="primary" size="sm">승인</Button>
                  <Button onClick={() => openAct('REJECT')} variant="danger" size="sm">반려</Button>
                </>}
              </div>
            }
          />
          <CardBody>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 14 }}>
              <span>결재 진행 <strong>{dto.completedSigners} / {dto.requiredSigners}</strong></span>
              {isOpen && current && <span>현재 단계 <strong>{current.signOrder}차 · {current.displayName}</strong>{needStepUp ? ' (본인확인 필요)' : ''}</span>}
              <span style={{ color: 'var(--color-text-muted)' }}>상신일 {dt(dto.createdAt)}</span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Tabs tabs={[{ key: 'line', label: '결재선', content: lineTab }, { key: 'log', label: `통합 인증로그 (${log.length})`, content: logTab }]} />
          </CardBody>
        </Card>
      </div>

      <Modal
        open={actOpen}
        onClose={() => setActOpen(false)}
        title={decision === 'APPROVE' ? '결재 승인' : '결재 반려'}
        footer={<>
          <Button onClick={() => setActOpen(false)} variant="ghost" disabled={busy}>취소</Button>
          <Button onClick={submitAct} loading={busy} variant={decision === 'APPROVE' ? 'primary' : 'danger'}>{decision === 'APPROVE' ? '승인' : '반려'}</Button>
        </>}
      >
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {actMsg?.type === 'error' && <Alert type="error" message={actMsg.text} />}
          <Field label="의견" htmlFor="ap-opinion" hint={decision === 'REJECT' ? '반려 사유를 입력하세요' : '결재 의견(선택)'}>
            <Textarea id="ap-opinion" value={opinion} onChange={(e) => setOpinion(e.target.value)} rows={3} />
          </Field>
          {decision === 'APPROVE' && needStepUp && (
            mfaEnabled ? (
              <Field label="인증앱 코드(MFA)" required htmlFor="ap-mfa" hint={`${dto.highRisk ? '고위험 문서' : '최종 결재 단계'} — 인증앱 6자리 코드(또는 복구코드)로 본인확인`}>
                <Input id="ap-mfa" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" autoComplete="off" inputMode="numeric" />
              </Field>
            ) : (
              <Field label="본인확인(step-up)" required htmlFor="ap-ci" hint={`${dto.highRisk ? '고위험 문서' : '최종 결재 단계'} — 본인확인 필요(MFA 미등록 시 PASS)`}>
                <Input id="ap-ci" value={ci} onChange={(e) => setCi(e.target.value)} placeholder="PASS 본인확인 값(ci)" autoComplete="off" />
              </Field>
            )
          )}
        </div>
      </Modal>
    </AdminLayout>
  );
}
