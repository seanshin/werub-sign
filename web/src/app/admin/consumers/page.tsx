'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 소비자(기계 연동) 관리 — HIS·PACS·ERP 등 시스템 키 발급/스코프 부여/무중단 회전.
 * 민감 스코프(ca:admin·users:admin)는 기계 키에 부여 불가(서버가 거부, UI 도 숨김).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { consumersApi } from '@/lib/api';
import {
  Consumer,
  CreateConsumerResult,
  RotateConsumerResult,
  ApiError,
} from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/ui/CopyButton';
import styles from './page.module.css';

/* ── 열 스타일 상수 ── */
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--color-text-muted)',
  borderBottom: '1px solid var(--color-border)',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 14,
  borderBottom: '1px solid var(--color-border-subtle, #eee)',
  verticalAlign: 'middle',
};

/* ── 회전 모달 ── */
type RotateMode = 'auto' | 'manual';

interface RotateModalState {
  consumer: Consumer;
  /** rotate 응답 (회전 완료 후) */
  rotateResult: RotateConsumerResult | null;
  /** 회전 단계: rotate → commit */
  phase: 'rotate' | 'commit';
  mode: RotateMode;
  manualKey: string;
  commitKey: string;
  loading: boolean;
  error: string;
}

interface RotateModalProps {
  state: RotateModalState;
  onClose: () => void;
  onChange: (patch: Partial<RotateModalState>) => void;
  onRotate: () => void;
  onCommit: () => void;
}

function RotateModal({ state, onClose, onChange, onRotate, onCommit }: RotateModalProps) {
  const { consumer, rotateResult, phase, mode, manualKey, commitKey, loading, error } = state;

  return (
    <Modal
      open
      onClose={onClose}
      title={`키 회전: ${consumer.name}`}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            닫기
          </Button>
          {phase === 'rotate' && (
            <Button
              size="sm"
              onClick={onRotate}
              loading={loading}
              disabled={mode === 'manual' && !manualKey.trim()}
            >
              회전 실행
            </Button>
          )}
          {phase === 'commit' && (
            <Button
              size="sm"
              variant="danger"
              onClick={onCommit}
              loading={loading}
              disabled={!commitKey.trim()}
            >
              commit (구 키 폐기)
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.modalSection}>
        {error && (
          <Alert type="error" message={error} onClose={() => onChange({ error: '' })} />
        )}

        {/* ── Step 1: Rotate ── */}
        <div className={styles.modalStep}>
          <p className={styles.stepHeader}>1단계. 새 키 생성 (rotate)</p>

          {phase === 'rotate' ? (
            <>
              <p className={styles.stepHint}>
                새 키를 추가합니다. 완료 후 소비자 시스템(HIS/PACS 등)에 새 키를 갱신하고 2단계 commit 을 실행하세요.
              </p>
              <div className={styles.radioRow}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="rotate-mode"
                    value="auto"
                    checked={mode === 'auto'}
                    onChange={() => onChange({ mode: 'auto', manualKey: '' })}
                  />
                  새 키 자동 생성
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="rotate-mode"
                    value="manual"
                    checked={mode === 'manual'}
                    onChange={() => onChange({ mode: 'manual' })}
                  />
                  직접 입력
                </label>
              </div>

              {mode === 'manual' && (
                <Field label="새 API 키" htmlFor="manual-key">
                  <Input
                    id="manual-key"
                    type="text"
                    value={manualKey}
                    onChange={(e) => onChange({ manualKey: e.target.value })}
                    placeholder="새 키 값 입력 (32자 이상 권장)"
                    autoComplete="off"
                  />
                </Field>
              )}
            </>
          ) : (
            /* rotate 완료 표시 */
            <div>
              {rotateResult?.generated && rotateResult.newApiKey ? (
                <div className={styles.newKeyBox}>
                  <p className={styles.newKeyLabel}>생성된 새 API 키 (1회만 표시)</p>
                  <p className={styles.newKeyValue}>{rotateResult.newApiKey}</p>
                  <div className={styles.newKeyCopyRow}>
                    <CopyButton text={rotateResult.newApiKey} label="키 복사" />
                  </div>
                  <p className={styles.newKeyWarning}>
                    이 키는 지금만 확인할 수 있습니다. 반드시 복사 후 소비자 시스템에 갱신하세요.
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-success-text)' }}>
                  회전 완료. 지정한 키가 소비자 시스템에 이미 등록되어 있어야 합니다.
                </p>
              )}
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                {rotateResult?.note}
              </p>
            </div>
          )}
        </div>

        {/* ── Step 2: Commit ── */}
        <div className={styles.modalStep} style={phase === 'rotate' ? { opacity: 0.45 } : undefined}>
          <p className={styles.stepHeader}>2단계. commit — 구 키 폐기</p>
          <p className={styles.commitGuide}>
            소비자 시스템이 새 키로 정상 동작하는지 확인한 뒤 commit 하세요.
            구 키는 즉시 삭제되며 되돌릴 수 없습니다.
          </p>
          {phase === 'commit' && (
            <Field label="유지할 키 (새 키 입력)" htmlFor="commit-key" hint="commit 할 키 = 새 키">
              <Input
                id="commit-key"
                type="text"
                value={commitKey}
                onChange={(e) => onChange({ commitKey: e.target.value })}
                placeholder="새 키 값 붙여넣기"
                autoComplete="off"
              />
            </Field>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ── 페이지 ── */
export default function ConsumersPage() {
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [noAdminKey, setNoAdminKey] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  /* 모달 상태 */
  const [modalState, setModalState] = useState<RotateModalState | null>(null);

  /* 소비자 등록/관리 상태 */
  const [assignable, setAssignable] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cScopes, setCScopes] = useState<string[]>([]);
  const [cResult, setCResult] = useState<CreateConsumerResult | null>(null);
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState('');
  const [manage, setManage] = useState<Consumer | null>(null);
  const [mScopes, setMScopes] = useState<string[]>([]);
  const [mBusy, setMBusy] = useState(false);
  const [mErr, setMErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNoAdminKey(false);
    try {
      const data = await consumersApi.list();
      setConsumers(data);
      consumersApi.assignableScopes().then(setAssignable).catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNoAdminKey(true);
      } else {
        setError(e instanceof Error ? e.message : '소비자 목록 조회에 실패했습니다.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* 모달 상태 부분 업데이트 */
  const patchModal = useCallback((patch: Partial<RotateModalState>) => {
    setModalState((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  /* 키 회전 버튼 클릭 → 모달 열기 */
  const openRotateModal = useCallback((consumer: Consumer) => {
    setModalState({
      consumer,
      rotateResult: null,
      phase: 'rotate',
      mode: 'auto',
      manualKey: '',
      commitKey: '',
      loading: false,
      error: '',
    });
  }, []);

  /* rotate 실행 */
  const handleRotate = useCallback(async () => {
    if (!modalState) return;
    patchModal({ loading: true, error: '' });
    try {
      const body =
        modalState.mode === 'manual' && modalState.manualKey.trim()
          ? { newApiKey: modalState.manualKey.trim() }
          : {};
      const result = await consumersApi.rotate(modalState.consumer.name, body);
      patchModal({
        loading: false,
        rotateResult: result,
        phase: 'commit',
        commitKey: modalState.mode === 'manual' ? modalState.manualKey.trim() : '',
      });
      // 목록 새로고침 (activeKeys 갱신)
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNoAdminKey(true);
        setModalState(null);
      } else {
        patchModal({
          loading: false,
          error: e instanceof Error ? e.message : '회전 실패',
        });
      }
    }
  }, [modalState, patchModal, load]);

  /* commit 실행 */
  const handleCommit = useCallback(async () => {
    if (!modalState || !modalState.commitKey.trim()) return;
    patchModal({ loading: true, error: '' });
    try {
      await consumersApi.commit(modalState.consumer.name, modalState.commitKey.trim());
      setSuccessMsg(`${modalState.consumer.name} — commit 완료. 구 키가 폐기되었습니다.`);
      setModalState(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNoAdminKey(true);
        setModalState(null);
      } else {
        patchModal({
          loading: false,
          error: e instanceof Error ? e.message : 'commit 실패',
        });
      }
    }
  }, [modalState, patchModal, load]);

  const toggleScope = (list: string[], s: string) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]);

  /* 소비자 등록 */
  const openCreate = () => { setCName(''); setCScopes([]); setCResult(null); setCErr(''); setCreateOpen(true); };
  const handleCreate = async () => {
    setCBusy(true); setCErr('');
    try {
      const r = await consumersApi.create(cName.trim(), cScopes);
      setCResult(r); // 1회 키 표시(모달 유지)
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) { setNoAdminKey(true); setCreateOpen(false); }
      else setCErr(e instanceof Error ? e.message : '등록 실패');
    } finally { setCBusy(false); }
  };

  /* 소비자 관리(스코프/상태) */
  const openManage = (c: Consumer) => { setManage(c); setMScopes([...c.scopes]); setMErr(''); };
  const handleSaveScopes = async () => {
    if (!manage) return;
    setMBusy(true); setMErr('');
    try { await consumersApi.update(manage.name, { scopes: mScopes }); setSuccessMsg(`${manage.name} 스코프 저장됨.`); setManage(null); await load(); }
    catch (e) { setMErr(e instanceof Error ? e.message : '저장 실패'); }
    finally { setMBusy(false); }
  };
  const handleToggleStatus = async (c: Consumer) => {
    const next = c.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    try { await consumersApi.update(c.name, { status: next }); setSuccessMsg(`${c.name} → ${next === 'ACTIVE' ? '재개' : '일시중지'}`); setManage(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '상태 변경 실패'); }
  };

  return (
    <AdminLayout title="API 키 회전·소비자 관리">
      <div className={styles.root}>
        {/* 상단 액션 */}
        <div className={styles.topActions}>
          <Button onClick={openCreate} variant="primary" size="sm">새 소비자 등록</Button>
          <Button onClick={load} loading={loading} variant="ghost" size="sm">
            새로고침
          </Button>
        </div>

        {/* 공통 경고 배너 — in-memory 안내 */}
        <div className={styles.warningBanner} role="alert">
          회전은 in-memory입니다 — 재기동 후에도 유지하려면 <code>.env.prod</code>의 해당 키도 갱신해야 합니다.
        </div>

        {/* CA Admin 키 없음 */}
        {noAdminKey && (
          <div className={styles.authBanner} role="alert">
            <strong>CA Admin 키가 필요합니다.</strong>
            <br />
            로그인 화면의 &apos;Admin Key (CA 전용)&apos; 항목에 admin 키를 입력한 뒤 다시 접근하세요.
          </div>
        )}

        {/* 오류 */}
        {error && (
          <Alert type="error" message={error} onClose={() => setError('')} />
        )}

        {/* 성공 */}
        {successMsg && (
          <Alert type="success" message={successMsg} onClose={() => setSuccessMsg('')} />
        )}

        {/* 로딩 */}
        {loading && !consumers && (
          <div className={styles.loadingState}>
            <Spinner size={32} />
          </div>
        )}

        {/* 소비자 목록 테이블 */}
        {consumers && !noAdminKey && (
          <Card>
            <CardHeader title={`소비자 목록 (${consumers.length})`} />
            <CardBody>
              <div className={styles.tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th style={th}>소비자 이름</th>
                      <th style={th}>스코프</th>
                      <th style={th}>활성 키</th>
                      <th style={th}>상태</th>
                      <th style={th}>작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consumers.length === 0 && (
                      <tr>
                        <td style={td} colSpan={5}>등록된 소비자가 없습니다.</td>
                      </tr>
                    )}
                    {consumers.map((c) => {
                      const isGrace = c.activeKeys >= 2;
                      return (
                        <tr key={c.name} style={isGrace ? { background: 'var(--color-warning-bg, #fffbeb)' } : c.status === 'SUSPENDED' ? { opacity: 0.6 } : undefined}>
                          <td style={td}>
                            <code style={{ fontSize: 13 }}>{c.name}</code>
                            <span style={{ marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)' }}>
                              {c.dynamic ? '등록' : '시스템'}
                            </span>
                          </td>
                          <td style={td}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {c.scopes.map((s) => (
                                <span key={s} className={styles.scopeBadge}>{s}</span>
                              ))}
                            </div>
                          </td>
                          <td style={td}>
                            {isGrace ? (
                              <span className={styles.graceBadge}>
                                {c.activeKeys}개 — 회전 중 (grace)
                              </span>
                            ) : (
                              <span className={styles.normalBadge}>{c.activeKeys}개</span>
                            )}
                          </td>
                          <td style={td}>
                            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                              {c.status}
                            </span>
                          </td>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <Button
                                size="sm"
                                variant={isGrace ? 'danger' : 'ghost'}
                                onClick={() => openRotateModal(c)}
                              >
                                {isGrace ? '회전 계속 (commit)' : '키 회전'}
                              </Button>
                              {c.dynamic && (
                                <Button size="sm" variant="ghost" onClick={() => openManage(c)}>관리</Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </div>

      {/* 키 회전 모달 */}
      {modalState && (
        <RotateModal
          state={modalState}
          onClose={() => setModalState(null)}
          onChange={patchModal}
          onRotate={handleRotate}
          onCommit={handleCommit}
        />
      )}

      {/* 소비자 등록 모달 */}
      {createOpen && (
        <Modal
          open
          onClose={() => setCreateOpen(false)}
          title="새 소비자 등록"
          footer={cResult ? (
            <Button variant="primary" onClick={() => setCreateOpen(false)}>확인</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={cBusy}>취소</Button>
              <Button variant="primary" loading={cBusy} onClick={handleCreate} disabled={!cName.trim() || cScopes.length === 0}>등록</Button>
            </>
          )}
        >
          {cResult ? (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Alert type="success" message={`${cResult.name} 등록됨 — 아래 키는 지금만 표시됩니다. 안전하게 보관하세요.`} />
              <div style={{ padding: 12, background: 'var(--color-bg-secondary)', borderRadius: 6 }}>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>API 키 (1회만 표시)</p>
                <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{cResult.apiKey}</code>
                <div style={{ marginTop: 8 }}><CopyButton text={cResult.apiKey} label="키 복사" /></div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>스코프: {cResult.scopes.join(', ')}</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              {cErr && <Alert type="error" message={cErr} />}
              <Field label="소비자 이름" required htmlFor="c-name" hint="영숫자·-_ 2~31자. 예: werb, docauth">
                <Input id="c-name" value={cName} onChange={(e) => setCName(e.target.value)} placeholder="werb" autoComplete="off" />
              </Field>
              <Field label="스코프" required htmlFor="c-scopes" hint="기계 연동 권한만(민감 스코프 부여 불가)">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {assignable.map((s) => (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={cScopes.includes(s)} onChange={() => setCScopes((l) => toggleScope(l, s))} />
                      <code style={{ fontSize: 12 }}>{s}</code>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          )}
        </Modal>
      )}

      {/* 소비자 관리(스코프/상태) 모달 */}
      {manage && (
        <Modal
          open
          onClose={() => setManage(null)}
          title={`소비자 관리: ${manage.name}`}
          footer={<>
            <Button variant={manage.status === 'SUSPENDED' ? 'primary' : 'danger'} onClick={() => handleToggleStatus(manage)}>
              {manage.status === 'SUSPENDED' ? '재개' : '일시중지'}
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setManage(null)} disabled={mBusy}>취소</Button>
            <Button variant="primary" loading={mBusy} onClick={handleSaveScopes} disabled={mScopes.length === 0}>스코프 저장</Button>
          </>}
        >
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            {mErr && <Alert type="error" message={mErr} />}
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>상태: <strong>{manage.status}</strong> · 활성 키 {manage.activeKeys}개</p>
            <Field label="스코프" htmlFor="m-scopes">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {assignable.map((s) => (
                  <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                    <input type="checkbox" checked={mScopes.includes(s)} onChange={() => setMScopes((l) => toggleScope(l, s))} />
                    <code style={{ fontSize: 12 }}>{s}</code>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </Modal>
      )}
    </AdminLayout>
  );
}
