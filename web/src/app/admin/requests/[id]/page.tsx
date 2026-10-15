'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 서명요청 상세 — 참가자 진행 상태·서명 검증 탭(공개키 재검증 결과)·감사 이력·webhook 이력.
 * 서명 0건이면 "서명 대기 중"(검증 실패가 아님 — 중립 표시).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { requestsApi, certificatesApi, webhookApi, maintenanceApi, notificationsApi } from '@/lib/api';
import { useRealtime } from '@/lib/useRealtime';
import {
  RequestDto, VerifyResult, AuditEntry, AuditVerifyResult, PortalToken, ParticipantDto,
  WebhookEntry, WebhookRetryResult, NotifyRecord,
} from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { Spinner } from '@/components/ui/Spinner';
import { Alert } from '@/components/ui/Toast';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/ui/CopyButton';
import { Field, Input, Select } from '@/components/ui/Field';
import styles from './page.module.css';

interface NotifyForm {
  baseUrl: string;
  recipients: Array<{ participantId: string; to: string; channel: 'ALIMTALK' | 'SMS' }>;
}

interface PageProps {
  params: { id: string };
}

async function fileToSha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function RequestDetailPage({ params }: PageProps) {
  const { id } = params;
  const router = useRouter();

  const [request, setRequest] = useState<RequestDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Verify
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Audit
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditVerify, setAuditVerify] = useState<AuditVerifyResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  // Portal tokens
  const [tokens, setTokens] = useState<PortalToken[]>([]);
  const [tokenLoading, setTokenLoading] = useState(false);

  // Revoke cert
  const [revokeTarget, setRevokeTarget] = useState<ParticipantDto | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);

  // Modals
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  const [notifyModal, setNotifyModal] = useState(false);
  const [notifyForm, setNotifyForm] = useState<NotifyForm>({ baseUrl: '', recipients: [] });
  const [notifying, setNotifying] = useState(false);

  // Supersede (C-2 문서 개정 재동의)
  const [supersedeModal, setSupersedeModal] = useState(false);
  const [supersedeHash, setSupersedeHash] = useState('');
  const [supersedeTitle, setSupersedeTitle] = useState('');
  const [supersedeReason, setSupersedeReason] = useState('');
  const [supersedeFileName, setSupersedeFileName] = useState('');
  const [superseding, setSuperseding] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Webhook
  const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);
  const [retryResult, setRetryResult] = useState<WebhookRetryResult | null>(null);

  // Notifications (발송 이력)
  const [notifyRecords, setNotifyRecords] = useState<NotifyRecord[]>([]);
  const [notifyLoading, setNotifyLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await requestsApi.get(id);
      setRequest(data);
      // Initialize notify form
      setNotifyForm({
        baseUrl: process.env.NEXT_PUBLIC_SIGN_API_URL ?? 'http://localhost:4000',
        recipients: data.participants.map((p) => ({
          participantId: p.participantId,
          to: '',
          channel: 'ALIMTALK' as const,
        })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // 실시간(SSE): 이 요청의 상태 변경 시 가볍게 재조회(알림 폼 등 입력 상태는 보존)
  const refreshRequest = useCallback(async () => {
    try { setRequest(await requestsApi.get(id)); } catch { /* 무시 */ }
  }, [id]);
  useRealtime((e) => { if (e.type === 'request.changed' && e.requestId === id) void refreshRequest(); });

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await requestsApi.verify(id);
      setVerifyResult(res);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '검증 실패' });
    } finally {
      setVerifying(false);
    }
  };

  const handleLoadAudit = async () => {
    setAuditLoading(true);
    try {
      const [entries, verify] = await Promise.all([
        requestsApi.audit(id),
        requestsApi.auditVerify(id),
      ]);
      setAuditEntries(entries);
      setAuditVerify(verify);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '감사 이력 로드 실패' });
    } finally {
      setAuditLoading(false);
    }
  };

  const handleIssueTokens = async () => {
    setTokenLoading(true);
    try {
      const res = await requestsApi.issuePortalTokens(id);
      setTokens(res);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '토큰 발급 실패' });
    } finally {
      setTokenLoading(false);
    }
  };

  const handleWithdraw = async () => {
    setWithdrawing(true);
    try {
      await requestsApi.withdraw(id, withdrawReason || undefined);
      setWithdrawModal(false);
      setActionMsg({ type: 'success', text: '서명요청이 철회되었습니다.' });
      load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '철회 실패' });
    } finally {
      setWithdrawing(false);
    }
  };

  const handleLoadWebhooks = async () => {
    setWebhookLoading(true);
    try {
      const res = await webhookApi.byRequest(id);
      setWebhooks(res);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : 'Webhook 조회 실패' });
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleLoadNotifications = async () => {
    setNotifyLoading(true);
    try {
      const res = await notificationsApi.listForRequest(id);
      setNotifyRecords(res);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '발송 이력 조회 실패' });
    } finally {
      setNotifyLoading(false);
    }
  };

  const handleWebhookRetry = async () => {
    setRetryLoading(true);
    setRetryResult(null);
    try {
      const res = await maintenanceApi.webhookRetry();
      setRetryResult(res);
      // 재시도 후 목록 갱신
      const updated = await webhookApi.byRequest(id);
      setWebhooks(updated);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : 'Webhook 재시도 실패' });
    } finally {
      setRetryLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await certificatesApi.revoke(revokeTarget.certSerial, revokeReason || undefined);
      setRevokeTarget(null);
      setRevokeReason('');
      setActionMsg({ type: 'success', text: `인증서 ${revokeTarget.certSerial.slice(0, 8)}... 폐기 완료` });
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '인증서 폐기 실패' });
    } finally {
      setRevoking(false);
    }
  };

  const openSupersede = () => {
    setSupersedeHash(''); setSupersedeFileName(''); setSupersedeReason('');
    setSupersedeTitle(request?.title ?? '');
    setSupersedeModal(true);
  };

  const handleSupersedeFile = async (file: File | undefined) => {
    if (!file) return;
    setSupersedeFileName(file.name);
    setSupersedeHash(await fileToSha256Hex(file));
  };

  const handleSupersede = async () => {
    if (!/^[0-9a-f]{64}$/i.test(supersedeHash)) {
      setActionMsg({ type: 'error', text: '개정 문서를 선택해 SHA-256 해시를 생성하세요.' });
      return;
    }
    setSuperseding(true);
    try {
      const created = await requestsApi.supersede(id, {
        idempotencyKey: `sup-${id}-${Date.now()}`,
        documentHash: supersedeHash.toLowerCase(),
        title: supersedeTitle || undefined,
        reason: supersedeReason || undefined,
      });
      setSupersedeModal(false);
      setActionMsg({ type: 'success', text: `개정본(v${created.version}) 생성 — 새 요청으로 이동합니다.` });
      router.push(`/admin/requests/${created.requestId}`);
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '개정 재동의 실패' });
    } finally {
      setSuperseding(false);
    }
  };

  const handleNotify = async () => {
    setNotifying(true);
    try {
      const validRecipients = notifyForm.recipients.filter((r) => r.to);
      await requestsApi.notify(id, {
        baseUrl: notifyForm.baseUrl,
        recipients: validRecipients,
      });
      setNotifyModal(false);
      setActionMsg({ type: 'success', text: `${validRecipients.length}명에게 서명 링크를 발송했습니다.` });
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : '발송 실패' });
    } finally {
      setNotifying(false);
    }
  };

  const CHECK_LABELS: Record<string, string> = {
    cryptoVerify: '암호 서명',
    timestampValid: '타임스탬프',
    chainValid: '인증서 체인',
    notExpired: '유효 기간',
    notRevoked: '폐기 여부',
    ltvValid: 'LTV 장기검증',
    cmsValid: 'CMS 서명',
  };

  if (loading) {
    return (
      <AdminLayout>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-16)' }}>
          <Spinner size={40} />
        </div>
      </AdminLayout>
    );
  }

  if (error || !request) {
    return (
      <AdminLayout>
        <Alert type="error" message={error || '요청을 찾을 수 없습니다.'} />
      </AdminLayout>
    );
  }

  const isActive = request.status === 'CREATED' || request.status === 'IN_PROGRESS';

  return (
    <AdminLayout>
      <button className={styles.backLink} onClick={() => router.push('/admin')}>
        ← 목록으로
      </button>

      {actionMsg && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert type={actionMsg.type} message={actionMsg.text} onClose={() => setActionMsg(null)} />
        </div>
      )}

      {/* Header */}
      <div className={styles.headerRow}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-1)', flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)' }}>
              {request.title || request.externalDocId}
            </h1>
            <StatusPill status={request.status} />
            <span className={styles.signModeBadge}>{request.signMode}</span>
          </div>
          {request.title && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-1)' }}>
              문서 ID: {request.externalDocId}
            </div>
          )}
          <div className={styles.requestId}>{request.requestId}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>서명 진행: {request.completedSigners} / {request.requiredSigners}명</span>
            {request.expiresAt && (
              <span>만료일: {new Date(request.expiresAt).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            {(request.version ?? 1) > 1 && <span className={styles.signModeBadge}>버전 v{request.version}</span>}
            {request.supersedes && (
              <button className={styles.backLink} style={{ margin: 0 }} onClick={() => router.push(`/admin/requests/${request.supersedes}`)}>← 이전본(개정 전) 보기</button>
            )}
            {request.supersededBy && (
              <button className={styles.backLink} style={{ margin: 0 }} onClick={() => router.push(`/admin/requests/${request.supersededBy}`)}>최신 개정본 보기 →</button>
            )}
          </div>
          {request.supersededBy && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Alert type="info" message="이 요청은 개정되어 현행본이 아닙니다. 기존 서명·감사·LTV는 검증 가능하나 새 서명은 받지 않습니다." />
            </div>
          )}
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={handleVerify} loading={verifying}>
            검증
          </Button>
          <Button variant="ghost" size="sm" onClick={handleIssueTokens} loading={tokenLoading}>
            서명 링크 발급
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNotifyModal(true)}>
            발송
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open(requestsApi.auditCertificateUrl(id), '_blank')}
          >
            감사추적 PDF
          </Button>
          {!request.supersededBy && request.status !== 'WITHDRAWN' && (
            <Button variant="ghost" size="sm" onClick={openSupersede}>
              개정 재동의
            </Button>
          )}
          {isActive && (
            <Button variant="danger" size="sm" onClick={() => setWithdrawModal(true)}>
              철회
            </Button>
          )}
        </div>
      </div>

      <Tabs
        tabs={[
          {
            key: 'participants',
            label: '참가자',
            content: (
              <div className={styles.section}>
                <div className={styles.participantTable}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>이름</th>
                        <th>역할</th>
                        <th>유형</th>
                        <th>본인확인</th>
                        <th>순서</th>
                        <th>상태</th>
                        <th>인증서</th>
                        <th>액션</th>
                      </tr>
                    </thead>
                    <tbody>
                      {request.participants.map((p) => (
                        <tr key={p.participantId}>
                          <td>
                            <div style={{ fontWeight: 'var(--font-medium)' }}>{p.displayName}</div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                              {p.participantId.slice(0, 8)}...
                            </div>
                          </td>
                          <td>{p.signerRole}</td>
                          <td>
                            <span className={styles.typeBadge}>{p.signerType}</span>
                          </td>
                          <td>
                            <span className={styles.levelBadge}>{p.requiredIdentityLevel}</span>
                          </td>
                          <td style={{ textAlign: 'center' }}>{p.signOrder}</td>
                          <td><StatusPill status={p.status} /></td>
                          <td>
                            {p.certSerial ? (
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                                {p.certSerial.slice(0, 10)}...
                              </span>
                            ) : '-'}
                          </td>
                          <td>
                            {p.certSerial && (
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => { setRevokeTarget(p); setRevokeReason(''); }}
                              >
                                폐기
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
          },
          {
            key: 'verify',
            label: '서명 검증',
            content: (
              <div className={styles.section}>
                {!verifyResult ? (
                  <div style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                    <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>
                      서명 검증 결과를 확인합니다.
                    </p>
                    <Button onClick={handleVerify} loading={verifying}>검증 실행</Button>
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 'var(--space-4)' }}>
                      {verifyResult.signatures.length === 0 ? (
                        <Alert type="info" message="아직 서명된 항목이 없습니다 — 서명 대기 중입니다(검증할 서명 없음)." />
                      ) : (
                        <Alert
                          type={verifyResult.overall ? 'success' : 'error'}
                          message={verifyResult.overall ? '전체 검증 통과 — 모든 서명이 유효합니다.' : '검증 실패 — 일부 서명에 문제가 있습니다.'}
                        />
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-4)', flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
                      <span>문서 무결성: <strong>{verifyResult.documentIntegrity}</strong></span>
                      <span>감사체인: <strong style={{ color: verifyResult.auditChainValid ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>{verifyResult.auditChainValid ? '유효' : '실패'}</strong></span>
                    </div>
                    <div className={styles.verifyGrid}>
                      {verifyResult.signatures.map((sig, i) => (
                        <div key={i} className={styles.verifyCard}>
                          <div className={styles.verifyRole}>{sig.signerRole}</div>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
                            {sig.identityMethod} · {sig.format}
                          </div>
                          {Object.entries(CHECK_LABELS).map(([k, label]) => {
                            const val = (sig as unknown as Record<string, unknown>)[k];
                            return (
                              <div key={k} className={styles.checkRow}>
                                <span className={styles.checkLabel}>{label}</span>
                                <span className={val ? styles.checkPass : styles.checkFail}>
                                  {val ? '✓ 통과' : '✗ 실패'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ),
          },
          {
            key: 'audit',
            label: '감사 이력',
            content: (
              <div className={styles.section}>
                {auditEntries.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                    <Button onClick={handleLoadAudit} loading={auditLoading}>감사 이력 로드</Button>
                  </div>
                ) : (
                  <>
                    {auditVerify && (
                      <div style={{ marginBottom: 'var(--space-4)' }}>
                        <Alert
                          type={auditVerify.valid ? 'success' : 'error'}
                          message={auditVerify.valid ? `감사 무결성 검증 통과 (체인: ${auditVerify.chainValid ? '유효' : '실패'}, TSA 앵커: ${auditVerify.anchored ? '있음' : '없음'})` : '감사 무결성 검증 실패'}
                        />
                      </div>
                    )}
                    <div>
                      {auditEntries.map((entry, i) => (
                        <div key={i} className={styles.auditEntry}>
                          <span className={styles.auditTime}>
                            {entry.occurredAt ? new Date(entry.occurredAt).toLocaleString('ko-KR') : '-'}
                          </span>
                          <span className={styles.auditEvent}>{entry.eventType}</span>
                          <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-xs)' }}>{entry.actorType}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ),
          },
          {
            key: 'webhooks',
            label: 'Webhook',
            content: (
              <div className={styles.section}>
                <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
                  <Button onClick={handleLoadWebhooks} loading={webhookLoading} size="sm" variant="ghost">
                    목록 조회
                  </Button>
                  <Button onClick={handleWebhookRetry} loading={retryLoading} size="sm" variant="ghost">
                    실패 재시도
                  </Button>
                </div>
                {retryResult && (
                  <div style={{ marginBottom: 'var(--space-3)' }}>
                    <Alert
                      type="success"
                      message={`재시도 완료 — 시도: ${retryResult.retried}건, 전송: ${retryResult.sent}건, Dead: ${retryResult.dead}건, 잔여: ${retryResult.remaining}건`}
                      onClose={() => setRetryResult(null)}
                    />
                  </div>
                )}
                {webhooks.length === 0 && !webhookLoading ? (
                  <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                    조회 버튼을 눌러 이 요청의 Webhook 발송 이력을 확인하세요.
                  </p>
                ) : (
                  <div className={styles.participantTable}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>이벤트 유형</th>
                          <th>대상 URL</th>
                          <th>상태</th>
                          <th>시도 횟수</th>
                          <th>최근 시도</th>
                        </tr>
                      </thead>
                      <tbody>
                        {webhooks.map((w) => (
                          <tr key={w.eventId}>
                            <td>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                                {w.eventType}
                              </span>
                            </td>
                            <td>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                                {w.targetUrl}
                              </span>
                            </td>
                            <td>
                              <span className={[
                                styles.typeBadge,
                                w.status === 'FAILED' || w.status === 'DEAD'
                                  ? styles.levelBadge
                                  : '',
                              ].filter(Boolean).join(' ')}>
                                {w.status}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>{w.attempts}</td>
                            <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                              {w.lastAttempt ? new Date(w.lastAttempt).toLocaleString('ko-KR') : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'notifications',
            label: '발송 이력',
            content: (
              <div className={styles.section}>
                <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                  <Button onClick={handleLoadNotifications} loading={notifyLoading} size="sm" variant="ghost">
                    발송 이력 조회
                  </Button>
                </div>
                {notifyRecords.length === 0 && !notifyLoading ? (
                  <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                    조회 버튼을 눌러 이 요청의 발송 이력을 확인하세요.
                  </p>
                ) : (
                  <div className={styles.participantTable}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>발송 시각</th>
                          <th>참가자 ID</th>
                          <th>채널</th>
                          <th>Provider</th>
                          <th>결과</th>
                          <th>수신 (마스킹)</th>
                          <th>메시지 ID</th>
                          <th>제목/이유</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notifyRecords.map((r) => (
                          <tr key={r.id}>
                            <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                              {new Date(r.sentAt).toLocaleString('ko-KR')}
                            </td>
                            <td>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                                {r.participantId.slice(0, 8)}...
                              </span>
                            </td>
                            <td>{r.channel}</td>
                            <td>{r.provider}</td>
                            <td><StatusPill status={r.result} /></td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{r.toMasked}</td>
                            <td>
                              {r.providerMsgId ? (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                                  {r.providerMsgId}
                                </span>
                              ) : '-'}
                            </td>
                            <td style={{ fontSize: 'var(--text-xs)', maxWidth: 160 }}>
                              {r.title && <div style={{ fontWeight: 'var(--font-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>}
                              {r.reason && <div style={{ color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason}</div>}
                              {!r.title && !r.reason && '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'tokens',
            label: '서명 링크',
            content: (
              <div className={styles.section}>
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <Button onClick={handleIssueTokens} loading={tokenLoading}>새 서명 링크 발급</Button>
                </div>
                {tokens.length > 0 && (
                  <div className={styles.tokenList}>
                    {tokens.map((t) => (
                      <div key={t.participantId} className={styles.tokenRow}>
                        <div className={styles.tokenLabel}>
                          {t.signerRole} — {t.participantId.slice(0, 8)}...
                        </div>
                        <div className={styles.tokenUrl}>
                          <span style={{ flex: 1 }}>{t.url}</span>
                          <CopyButton text={t.url} label="URL 복사" />
                          <CopyButton text={t.token} label="토큰 복사" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* Revoke Cert Modal */}
      <Modal
        open={!!revokeTarget}
        onClose={() => { setRevokeTarget(null); setRevokeReason(''); }}
        title="인증서 폐기"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setRevokeTarget(null); setRevokeReason(''); }}>취소</Button>
            <Button variant="danger" onClick={handleRevoke} loading={revoking}>폐기 확인</Button>
          </>
        }
      >
        {revokeTarget && (
          <>
            <p style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              <strong>{revokeTarget.displayName}</strong>({revokeTarget.signerRole})의 인증서를 폐기합니다.
              폐기된 인증서는 복구할 수 없습니다.
            </p>
            <div style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3)', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-lg)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
              Serial: {revokeTarget.certSerial}
            </div>
            <Field label="폐기 사유 (선택)" htmlFor="revokeReason">
              <Input
                id="revokeReason"
                type="text"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="폐기 사유를 입력하세요"
              />
            </Field>
          </>
        )}
      </Modal>

      {/* Withdraw Modal */}
      <Modal
        open={withdrawModal}
        onClose={() => setWithdrawModal(false)}
        title="서명요청 철회"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWithdrawModal(false)}>취소</Button>
            <Button variant="danger" onClick={handleWithdraw} loading={withdrawing}>철회 확인</Button>
          </>
        }
      >
        <p style={{ marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          철회된 서명요청은 복구할 수 없습니다. 진행하시겠습니까?
        </p>
        <Field label="철회 사유 (선택)" htmlFor="withdrawReason">
          <Input
            id="withdrawReason"
            type="text"
            value={withdrawReason}
            onChange={(e) => setWithdrawReason(e.target.value)}
            placeholder="철회 사유를 입력하세요"
          />
        </Field>
      </Modal>

      {/* Supersede Modal (C-2 문서 개정 재동의) */}
      <Modal
        open={supersedeModal}
        onClose={() => setSupersedeModal(false)}
        title="문서 개정 재동의"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSupersedeModal(false)}>취소</Button>
            <Button onClick={handleSupersede} loading={superseding} disabled={!/^[0-9a-f]{64}$/i.test(supersedeHash)}>개정본 생성</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            개정 문서로 <strong>새 버전</strong>을 생성하고 이 요청을 대체(SUPERSEDED)합니다. 참가자·인증서는 원본을 그대로 재사용하며, 새 요청으로 다시 서명을 수집합니다. 원본의 기존 서명·감사·LTV는 보존됩니다.
          </p>
          <Field label="개정 문서 (SHA-256 자동 계산)" htmlFor="supersedeFile" hint="원본은 전송되지 않고 해시만 계산됩니다">
            <input id="supersedeFile" type="file" onChange={(e) => handleSupersedeFile(e.target.files?.[0])} />
          </Field>
          {supersedeHash && (
            <div style={{ padding: 'var(--space-3)', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-lg)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
              {supersedeFileName} → {supersedeHash}
            </div>
          )}
          <Field label="제목 (선택)" htmlFor="supersedeTitle">
            <Input id="supersedeTitle" type="text" value={supersedeTitle} onChange={(e) => setSupersedeTitle(e.target.value)} placeholder="개정본 제목(미입력 시 원본 제목)" />
          </Field>
          <Field label="개정 사유 (선택)" htmlFor="supersedeReason">
            <Input id="supersedeReason" type="text" value={supersedeReason} onChange={(e) => setSupersedeReason(e.target.value)} placeholder="예: 조영제 항목 추가" />
          </Field>
        </div>
      </Modal>

      {/* Notify Modal */}
      <Modal
        open={notifyModal}
        onClose={() => setNotifyModal(false)}
        title="서명 링크 발송"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNotifyModal(false)}>취소</Button>
            <Button onClick={handleNotify} loading={notifying}>발송</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Field label="기본 URL" htmlFor="notifyBaseUrl" hint="서명 포털 베이스 URL">
            <Input
              id="notifyBaseUrl"
              type="url"
              value={notifyForm.baseUrl}
              onChange={(e) => setNotifyForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="http://localhost:3000"
            />
          </Field>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-3)' }}>
              수신자 정보
            </div>
            {notifyForm.recipients.map((r, i) => {
              const p = request.participants[i];
              return (
                <div key={r.participantId} style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-lg)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
                    {p?.signerRole ?? r.participantId.slice(0, 8)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--space-2)' }}>
                    <Input
                      type="text"
                      placeholder="01012345678 또는 채널 대상"
                      value={r.to}
                      onChange={(e) => setNotifyForm((f) => ({
                        ...f,
                        recipients: f.recipients.map((rr, ii) => ii === i ? { ...rr, to: e.target.value } : rr),
                      }))}
                    />
                    <Select
                      value={r.channel}
                      onChange={(e) => setNotifyForm((f) => ({
                        ...f,
                        recipients: f.recipients.map((rr, ii) => ii === i ? { ...rr, channel: e.target.value as 'ALIMTALK' | 'SMS' } : rr),
                      }))}
                    >
                      <option value="ALIMTALK">알림톡</option>
                      <option value="SMS">SMS</option>
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>
    </AdminLayout>
  );
}
