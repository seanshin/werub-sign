'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 시스템 상태 — /v1/admin/ops-status(키 수탁·하드닝·버전·세션 정책)와 webhook 집계
 * (SENT/FAILED/DEAD/DISCARDED), [DEAD 재발송]·[DEAD 폐기] 운영 액션의 홈.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback } from 'react';
import { opsApi, maintenanceApi } from '@/lib/api';
import { OpsStatus, OpsMetrics, ReadinessResult, WebhookRetryResult, WebhookDeadItem, WebhookRedriveResult, WebhookDiscardResult } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { BarList, Sparkbars, Gauge } from '@/components/ui/MiniChart';

const STATUS_LABEL: Record<string, string> = { CREATED: '생성됨', IN_PROGRESS: '진행중', COMPLETED: '완료', EXPIRED: '만료', WITHDRAWN: '철회', SUPERSEDED: '개정됨', REVOKED: '폐기' };
import styles from './page.module.css';

function ConfigBadge({ value }: { value: string | boolean | undefined }) {
  if (value === undefined || value === null) return <span className={styles.badge}>-</span>;
  if (typeof value === 'boolean') {
    return (
      <span className={[styles.badge, value ? styles.badgeSuccess : styles.badgeMuted].join(' ')}>
        {value ? '활성' : '비활성'}
      </span>
    );
  }
  return <span className={styles.badge}>{String(value)}</span>;
}

function ReadinessBadge({ ok }: { ok: boolean }) {
  return (
    <span className={[styles.badge, ok ? styles.badgeSuccess : styles.badgeDanger].join(' ')}>
      {ok ? '정상' : '오류'}
    </span>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: number | undefined; highlight?: boolean }) {
  return (
    <div className={[styles.statCard, highlight && value && value > 0 ? styles.statCardDanger : ''].filter(Boolean).join(' ')}>
      <div className={styles.statValue}>{value ?? 0}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

export default function SystemPage() {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [retryLoading, setRetryLoading] = useState(false);
  const [retryResult, setRetryResult] = useState<WebhookRetryResult | null>(null);
  // DEAD 재발송(re-drive) — 재시도가 소진된 건은 자동 배치 대상이 아니라 운영자가 명시 실행한다
  const [deadList, setDeadList] = useState<WebhookDeadItem[] | null>(null);
  const [redriveResult, setRedriveResult] = useState<WebhookRedriveResult | null>(null);
  const [redriveLoading, setRedriveLoading] = useState(false);
  // 폐기 — 수신처가 없어진 건은 재발송해도 영원히 실패하므로 적체·경고에서 뺀다(이력은 보존)
  const [discardResult, setDiscardResult] = useState<WebhookDiscardResult | null>(null);
  const [discardLoading, setDiscardLoading] = useState(false);
  const [retryError, setRetryError] = useState('');

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [opsData, readyData, metricsData] = await Promise.all([
        opsApi.status(),
        opsApi.ready(),
        opsApi.metrics(30),
      ]);
      setStatus(opsData);
      setReadiness(readyData);
      setMetrics(metricsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : '상태 조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWebhookDead = async () => {
    setRetryError(''); setRedriveResult(null);
    try { setDeadList(await maintenanceApi.webhookDead()); }
    catch (e) { setRetryError(e instanceof Error ? e.message : 'DEAD 목록 조회 실패'); }
  };

  const handleWebhookRedrive = async () => {
    if (!window.confirm('재시도가 소진된 DEAD 건을 다시 전송합니다. 수신 측 경로·장애가 해소된 뒤 실행하세요. 진행할까요?')) return;
    // 수신 경로가 바뀐 경우 — 전달 레코드에는 발송 시점 주소가 박혀 있어 그대로 보내면 다시 실패한다
    const newUrl = window.prompt('수신 주소가 바뀌었다면 새 주소를 입력하세요(그대로 보내려면 비워 두고 확인).', '') ?? '';
    setRedriveLoading(true); setRetryError(''); setRedriveResult(null);
    try {
      const r = await maintenanceApi.webhookRedrive(newUrl.trim() ? { newTargetUrl: newUrl.trim() } : {});
      setRedriveResult(r);
      setDeadList(await maintenanceApi.webhookDead());
      await handleRefresh();
    } catch (e) { setRetryError(e instanceof Error ? e.message : '재발송 실패'); }
    finally { setRedriveLoading(false); }
  };

  const handleWebhookDiscard = async () => {
    const targetUrl = window.prompt('폐기할 수신 주소(부분 일치)를 입력하세요. 비우면 DEAD 전건이 대상입니다.', '') ?? '';
    const reason = window.prompt('폐기 사유를 입력하세요(감사 기록에 그대로 남습니다).', '') ?? '';
    if (!reason.trim()) { setRetryError('폐기 사유는 필수입니다.'); return; }
    if (!window.confirm(`${targetUrl.trim() ? `"${targetUrl.trim()}" 수신 주소의 ` : 'DEAD 전건을 '}통지를 폐기합니다. 재발송 대상에서 빠지며 되돌릴 수 없습니다. 진행할까요?`)) return;
    setDiscardLoading(true); setRetryError(''); setDiscardResult(null); setRedriveResult(null);
    try {
      const r = await maintenanceApi.webhookDiscard({ reason: reason.trim(), ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}) });
      setDiscardResult(r);
      setDeadList(await maintenanceApi.webhookDead());
      await handleRefresh();
    } catch (e) { setRetryError(e instanceof Error ? e.message : '폐기 실패'); }
    finally { setDiscardLoading(false); }
  };

  const handleWebhookRetry = async () => {
    setRetryLoading(true);
    setRetryError('');
    setRetryResult(null);
    try {
      const res = await maintenanceApi.webhookRetry();
      setRetryResult(res);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : '웹훅 재시도 실패');
    } finally {
      setRetryLoading(false);
    }
  };

  return (
    <AdminLayout title="시스템 상태">
      <div className={styles.root}>
        {/* 상단 액션 */}
        <div className={styles.topActions}>
          <Button onClick={handleRefresh} loading={loading} variant="ghost" size="sm">
            새로고침
          </Button>
          {status && (
            <span className={styles.generatedAt}>
              조회 시각: {new Date(status.generatedAt).toLocaleString('ko-KR')}
            </span>
          )}
        </div>

        {error && (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <Alert type="error" message={error} onClose={() => setError('')} />
          </div>
        )}

        {!status && !loading && (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>새로고침 버튼을 눌러 시스템 상태를 조회하세요.</p>
            <Button onClick={handleRefresh}>상태 조회</Button>
          </div>
        )}

        {loading && (
          <div className={styles.loadingState}>
            <Spinner size={32} />
          </div>
        )}

        {status && !loading && (
          <div className={styles.grid}>
            {/* 운영 추세(차트) */}
            {metrics && (
              <Card className={styles.fullWidth}>
                <CardHeader title={`운영 추세 (최근 ${metrics.days}일)`} description={`전체 요청 ${metrics.requestTotal.toLocaleString('ko-KR')}건`} />
                <CardBody>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-6)' }}>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-3)', color: 'var(--color-text-primary)' }}>요청 상태 분포</div>
                      <BarList data={Object.entries(metrics.statusDistribution).map(([k, v]) => ({ label: STATUS_LABEL[k] ?? k, value: v }))} />
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-3)', color: 'var(--color-text-primary)' }}>일자별 요청 생성</div>
                      <Sparkbars data={metrics.daily} />
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-3)', color: 'var(--color-text-primary)' }}>Webhook 성공률</div>
                      <Gauge percent={metrics.webhooks.successRate} label={`성공 ${metrics.webhooks.sent} / 전체 ${metrics.webhooks.total}`} />
                      <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>실패·DEAD {metrics.webhooks.failed} · 대기 {metrics.webhooks.pending}</div>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}
            {/* Readiness */}
            {readiness && (
              <Card className={styles.fullWidth}>
                <CardHeader title="서비스 준비 상태 (Readiness)" />
                <CardBody>
                  <div className={styles.readinessRow}>
                    <div className={styles.readinessItem}>
                      <span className={styles.readinessLabel}>전체</span>
                      <ReadinessBadge ok={readiness.ready} />
                    </div>
                    <div className={styles.readinessItem}>
                      <span className={styles.readinessLabel}>데이터베이스 (DB)</span>
                      <ReadinessBadge ok={readiness.checks.db} />
                    </div>
                    <div className={styles.readinessItem}>
                      <span className={styles.readinessLabel}>CA 서비스</span>
                      <ReadinessBadge ok={readiness.checks.ca} />
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}

            {/* 운영 메트릭 — 요청 상태 */}
            <Card>
              <CardHeader title="서명요청 현황" />
              <CardBody>
                <div className={styles.statGrid}>
                  <StatCard label="전체" value={status.requests.total} />
                  <StatCard label="생성됨" value={status.requests.CREATED} />
                  <StatCard label="진행중" value={status.requests.IN_PROGRESS} />
                  <StatCard label="완료" value={status.requests.COMPLETED} />
                  <StatCard label="만료" value={status.requests.EXPIRED} />
                  <StatCard label="철회" value={status.requests.WITHDRAWN} />
                </div>
              </CardBody>
            </Card>

            {/* 운영 메트릭 — Webhook */}
            <Card>
              <CardHeader
                title="Webhook 현황"
                description="FAILED/DEAD 건수가 높으면 재시도가 필요합니다."
              />
              <CardBody>
                <div className={styles.statGrid}>
                  <StatCard label="전체" value={status.webhooks.total} />
                  <StatCard label="전송완료" value={status.webhooks.SENT} />
                  <StatCard label="대기" value={status.webhooks.PENDING} />
                  <StatCard label="실패" value={status.webhooks.FAILED} highlight />
                  <StatCard label="Dead" value={status.webhooks.DEAD} highlight />
                </div>

                {(status.webhooks.deadTargets ?? []).length > 0 && (
                  <div style={{ marginTop: 'var(--space-3)', padding: '10px 12px', borderRadius: 8, background: 'var(--color-warning-bg,#fef3c7)', color: 'var(--color-warning-text,#92400e)', fontSize: 'var(--text-sm)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>실패가 몰린 수신 주소 — 경로 변경·수신 측 장애 확인 필요</div>
                    {(status.webhooks.deadTargets ?? []).map((t) => (
                      <div key={t.targetUrl} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{t.count}건</span>
                        <code style={{ fontSize: 12 }}>{t.targetUrl}</code>
                      </div>
                    ))}
                    <div style={{ marginTop: 4, fontSize: 12 }}>수신 경로가 바뀌었다면 [DEAD 재발송] 시 새 주소로 재지정할 수 있습니다.</div>
                  </div>
                )}

                <div style={{ marginTop: 'var(--space-4)' }}>
                  {retryError && (
                    <Alert type="error" message={retryError} onClose={() => setRetryError('')} />
                  )}
                  {retryResult && (
                    <Alert
                      type="success"
                      message={`재시도 완료 — 시도: ${retryResult.retried}건, 전송: ${retryResult.sent}건, Dead: ${retryResult.dead}건, 잔여: ${retryResult.remaining}건`}
                    />
                  )}
                  <div style={{ marginTop: retryResult || retryError ? 'var(--space-3)' : 0 }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleWebhookRetry}
                        loading={retryLoading}
                      >
                        실패 Webhook 재시도
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleWebhookDead}>
                        DEAD 목록 보기
                      </Button>
                      {(status.webhooks.DEAD ?? 0) > 0 && (
                        <>
                          <Button variant="ghost" size="sm" onClick={handleWebhookRedrive} loading={redriveLoading}>
                            DEAD 재발송
                          </Button>
                          <Button variant="ghost" size="sm" onClick={handleWebhookDiscard} loading={discardLoading}>
                            DEAD 폐기
                          </Button>
                        </>
                      )}
                    </div>
                    {redriveResult && (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <Alert type="success" message={`재발송 완료 — 대상 ${redriveResult.matched}건, 전송 ${redriveResult.sent}건, 실패 ${redriveResult.failed}건`} />
                      </div>
                    )}
                    {discardResult && (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <Alert type="success" message={`폐기 완료 — 대상 ${discardResult.matched}건 중 ${discardResult.discarded}건 처리(이력은 DISCARDED 로 보존·감사에 사유 기록)`} />
                      </div>
                    )}
                    {deadList && (
                      <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
                        {deadList.length === 0 ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>DEAD 적체 없음</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ color: 'var(--color-text-muted)' }}>
                              DEAD {deadList.length}건 — 수신 측 경로·장애 해소 후 [DEAD 재발송]을 실행하세요(시크릿 회전 시에도 현재 시크릿으로 재서명, eventId 보존).
                              수신처 자체가 폐지된 건은 [DEAD 폐기]로 적체·경고에서 제외합니다(레코드는 사유와 함께 보존).
                            </div>
                            {deadList.slice(0, 10).map((d) => (
                              <div key={d.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', color: 'var(--color-text-secondary)' }}>
                                <code style={{ fontSize: 12 }}>{d.eventType}</code>
                                <span style={{ fontSize: 12 }}>{d.targetUrl}</span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>시도 {d.attempts}회</span>
                              </div>
                            ))}
                            {deadList.length > 10 && <span style={{ color: 'var(--color-text-muted)' }}>… 외 {deadList.length - 10}건</span>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* CA 시리얼 */}
            <Card>
              <CardHeader title="CA 인증서 정보" />
              <CardBody>
                <div className={styles.configTable}>
                  <div className={styles.configRow}>
                    <span className={styles.configKey}>Issuing Serial</span>
                    <code className={styles.configMono}>{status.ca.issuingSerial}</code>
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configKey}>Root Serial</span>
                    <code className={styles.configMono}>{status.ca.rootSerial}</code>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* 시스템 구성 */}
            <Card className={styles.fullWidth}>
              <CardHeader
                title="시스템 구성 (읽기 전용)"
                description="런타임 변경 불가 — 배포 설정(KEY_SIGNER_DRIVER / HSM_PROVIDER 등 환경 변수)으로만 변경 가능합니다."
              />
              <CardBody>
                <div className={styles.notice}>
                  키 커스터디·HSM 설정은 배포 환경 변수로 결정됩니다. 변경이 필요한 경우 컨테이너 환경 변수(KEY_SIGNER_DRIVER, HSM_PROVIDER)를 수정 후 재배포하세요.
                </div>
                <div className={styles.configGrid}>
                  <div>
                    <div className={styles.configSection}>키 커스터디</div>
                    <div className={styles.configTable}>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Driver</span>
                        <ConfigBadge value={status.config.keyCustody.driver} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Mode</span>
                        <ConfigBadge value={status.config.keyCustody.mode} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>HSM Provider</span>
                        <ConfigBadge value={status.config.keyCustody.hsm ?? '-'} />
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className={styles.configSection}>본인인증 / 발송</div>
                    <div className={styles.configTable}>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Identity Driver</span>
                        <ConfigBadge value={status.config.identity.driver} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Identity Provider</span>
                        <ConfigBadge value={status.config.identity.provider} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Notifier</span>
                        <ConfigBadge value={status.config.notifier.provider} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Store Driver</span>
                        <ConfigBadge value={status.config.store.driver} />
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className={styles.configSection}>SSO / 기타</div>
                    <div className={styles.configTable}>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>SSO Issuer</span>
                        <span className={styles.configValue}>{status.config.sso.issuer}</span>
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>SSO Audience</span>
                        <span className={styles.configValue}>{status.config.sso.audience}</span>
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Roles Enforced</span>
                        <ConfigBadge value={status.config.sso.rolesEnforced} />
                      </div>
                      {status.config.session && (
                        <>
                          <div className={styles.configRow}>
                            <span className={styles.configKey}>세션 만료(분)</span>
                            <ConfigBadge value={String(status.config.session.ttlMinutes)} />
                          </div>
                          <div className={styles.configRow}>
                            <span className={styles.configKey}>비활동 자동 로그아웃(분)</span>
                            <ConfigBadge value={status.config.session.idleTimeoutMinutes === 0 ? '비활성' : String(status.config.session.idleTimeoutMinutes)} />
                          </div>
                          {status.config.session.maxConcurrent !== undefined && (
                            <div className={styles.configRow}>
                              <span className={styles.configKey}>동시 세션 한도</span>
                              <ConfigBadge value={status.config.session.maxConcurrent === 0 ? '무제한' : String(status.config.session.maxConcurrent)} />
                            </div>
                          )}
                          {status.config.session.activeSessions !== undefined && (
                            <div className={styles.configRow}>
                              <span className={styles.configKey}>활성 세션 수</span>
                              <ConfigBadge value={String(status.config.session.activeSessions)} />
                            </div>
                          )}
                          {status.config.session.enforcement && (
                            <div className={styles.configRow}>
                              <span className={styles.configKey}>세션 차단 강제</span>
                              <ConfigBadge value={status.config.session.enforcement === 'server' ? '서버측' : status.config.session.enforcement} />
                            </div>
                          )}
                        </>
                      )}
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Swagger UI</span>
                        <ConfigBadge value={status.config.swaggerUi} />
                      </div>
                      <div className={styles.configRow}>
                        <span className={styles.configKey}>Environment</span>
                        <ConfigBadge value={status.config.env} />
                      </div>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>

          </div>
        )}
      </div>
    </AdminLayout>
  );
}
