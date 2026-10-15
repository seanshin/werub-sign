'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 연동 설정 — 본인확인(idv)·발송(notifier)·키수탁(hsm) provider 와 자격증명을 재배포 없이 변경.
 * 비밀값은 서버가 봉인 저장하고 화면엔 항상 마스킹으로만 돌아온다. hsm 은 캡처만(cutover 별도).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { settingsApi } from '@/lib/api';
import {
  SettingItem,
  SettingType,
  SettingAuditEntry,
} from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { StatusPill } from '@/components/ui/StatusPill';
import styles from './page.module.css';

/* ── 연동 유형별 한글 제목 ── */
const TITLES: Record<SettingType, string> = {
  idv: '본인인증(PASS/명의)',
  notifier: '발송(알림톡/SMS)',
  hsm: '키수탁(KMS/HSM)',
};

/* ── 개별 연동 카드 ── */
interface IntegrationCardProps {
  item: SettingItem;
  onSaved: (updated: SettingItem) => void;
}

function IntegrationCard({ item, onSaved }: IntegrationCardProps) {
  /* 폼 상태 */
  const [provider, setProvider] = useState(item.provider ?? '');
  const [enabled, setEnabled] = useState(item.enabled);

  // fields: 스키마에 선언된 키만 관리
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const key of item.schema.fields) {
      init[key] = item.fields[key] ?? '';
    }
    return init;
  });

  // secrets: 입력값 (빈 문자열 = 변경 없음)
  const [secrets, setSecrets] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const key of item.schema.secrets) {
      init[key] = '';
    }
    return init;
  });

  // 삭제 토글 (true = "__CLEAR__" 전송)
  const [clearFlags, setClearFlags] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const key of item.schema.secrets) {
      init[key] = false;
    }
    return init;
  });

  /* UI 상태 */
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /* 이력 */
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditItems, setAuditItems] = useState<SettingAuditEntry[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');

  const handleToggleAudit = useCallback(async () => {
    if (auditOpen) {
      setAuditOpen(false);
      return;
    }
    setAuditOpen(true);
    if (auditItems !== null) return; // 이미 로드됨
    setAuditLoading(true);
    setAuditError('');
    try {
      const data = await settingsApi.audit(item.type);
      setAuditItems(data);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : '이력 조회 실패');
    } finally {
      setAuditLoading(false);
    }
  }, [auditOpen, auditItems, item.type]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      // secrets: 삭제 플래그 우선, 그 다음 입력값, 빈 문자열은 제외
      const secretsPayload: Record<string, string> = {};
      for (const key of item.schema.secrets) {
        if (clearFlags[key]) {
          secretsPayload[key] = '__CLEAR__';
        } else if (secrets[key]) {
          secretsPayload[key] = secrets[key];
        }
        // 빈 문자열/미포함 = 기존 유지
      }

      const updated = await settingsApi.update(item.type, {
        provider,
        enabled,
        fields,
        ...(Object.keys(secretsPayload).length > 0 ? { secrets: secretsPayload } : {}),
      });

      // 저장 성공 후 시크릿 입력 초기화
      setSecrets(() => {
        const init: Record<string, string> = {};
        for (const key of item.schema.secrets) init[key] = '';
        return init;
      });
      setClearFlags(() => {
        const init: Record<string, boolean> = {};
        for (const key of item.schema.secrets) init[key] = false;
        return init;
      });

      // 이력 캐시 무효화 (다음 열 때 재로드)
      setAuditItems(null);

      setSaveMsg({ type: 'success', text: '저장되었습니다.' });
      onSaved(updated);
    } catch (e) {
      setSaveMsg({ type: 'error', text: e instanceof Error ? e.message : '저장에 실패했습니다.' });
    } finally {
      setSaving(false);
    }
  }, [item.type, item.schema, provider, enabled, fields, secrets, clearFlags, onSaved]);

  const sourceLabel = item.source === 'settings-store' ? 'DB 저장' : '환경변수 기본값';
  const sourceCls = item.source === 'settings-store' ? styles.sourceBadgeStore : styles.sourceBadgeEnv;

  return (
    <Card>
      {/* 카드 헤더 */}
      <CardHeader
        title=""
        actions={
          <div className={styles.cardTitleRow}>
            <h2 className={styles.cardTitle}>{TITLES[item.type]}</h2>
            <span className={[styles.sourceBadge, sourceCls].join(' ')}>{sourceLabel}</span>
            <StatusPill status={item.provider} label={item.provider} />
          </div>
        }
      />

      <CardBody>
        <div className={styles.fieldGroup}>
          {/* 메타 정보 */}
          {(item.updatedAt || item.updatedBy) && (
            <p className={styles.metaRow}>
              {item.updatedAt && `최종 수정: ${new Date(item.updatedAt).toLocaleString('ko-KR')}`}
              {item.updatedAt && item.updatedBy && ' · '}
              {item.updatedBy && `수정자: ${item.updatedBy}`}
            </p>
          )}

          {/* 경고 배너 (runtimeApplied=false) */}
          {!item.schema.runtimeApplied && (
            <div className={styles.warningBanner} role="alert">
              이 설정은 캡처용입니다 — 실제 적용은 재배포(cutover)가 필요합니다.
            </div>
          )}

          {/* 안내문 */}
          {item.schema.note && (
            <div className={styles.noteBox}>{item.schema.note}</div>
          )}

          {/* Provider 선택 */}
          {item.schema.providers.length > 0 && (
            <Field label="Provider" htmlFor={`provider-${item.type}`}>
              <Select
                id={`provider-${item.type}`}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {item.schema.providers.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </Field>
          )}

          {/* 일반 필드 */}
          {item.schema.fields.length > 0 && (
            <div>
              <p className={styles.sectionLabel}>일반 설정</p>
              <div className={styles.fieldGroup}>
                {item.schema.fields.map((key) => (
                  <Field key={key} label={key} htmlFor={`field-${item.type}-${key}`}>
                    <Input
                      id={`field-${item.type}-${key}`}
                      type="text"
                      value={fields[key] ?? ''}
                      onChange={(e) =>
                        setFields((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={key}
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}

          {/* 시크릿 필드 */}
          {item.schema.secrets.length > 0 && (
            <div>
              <p className={styles.sectionLabel}>시크릿 (평문 화면 미표시)</p>
              <div className={styles.fieldGroup}>
                {item.schema.secrets.map((key) => {
                  const isSet = item.secretsSet[key] ?? false;
                  const willClear = clearFlags[key];
                  return (
                    <Field
                      key={key}
                      label={key}
                      htmlFor={`secret-${item.type}-${key}`}
                      hint={isSet ? '현재 설정됨' : '미설정'}
                    >
                      <div className={styles.secretRow}>
                        <div className={styles.secretInput}>
                          <Input
                            id={`secret-${item.type}-${key}`}
                            type="password"
                            value={willClear ? '' : (secrets[key] ?? '')}
                            disabled={willClear}
                            onChange={(e) =>
                              setSecrets((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            placeholder={
                              willClear
                                ? '(삭제 예정)'
                                : isSet
                                ? '●●● 설정됨(변경하려면 입력)'
                                : '미설정 — 입력하면 저장됩니다'
                            }
                            autoComplete="new-password"
                          />
                        </div>
                        {isSet && (
                          <button
                            type="button"
                            className={[
                              styles.clearToggle,
                              willClear ? styles.clearToggleActive : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() =>
                              setClearFlags((prev) => ({ ...prev, [key]: !prev[key] }))
                            }
                            aria-pressed={willClear}
                          >
                            {willClear ? '삭제 취소' : '삭제'}
                          </button>
                        )}
                      </div>
                    </Field>
                  );
                })}
              </div>
            </div>
          )}

          {/* Enabled 체크박스 */}
          <label className={styles.enabledRow}>
            <input
              className={styles.enabledCheckbox}
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            연동 활성화
          </label>

          {/* 저장 결과 메시지 */}
          {saveMsg && (
            <Alert
              type={saveMsg.type}
              message={saveMsg.text}
              onClose={() => setSaveMsg(null)}
            />
          )}
        </div>
      </CardBody>

      <CardFooter>
        <div className={styles.footerRow}>
          <Button onClick={handleSave} loading={saving}>
            저장
          </Button>
          <button
            type="button"
            className={styles.auditToggle}
            onClick={handleToggleAudit}
            aria-expanded={auditOpen}
          >
            {auditOpen ? '이력 닫기 ▲' : '설정 변경 이력 보기 ▼'}
          </button>
        </div>

        {/* 이력 테이블 */}
        {auditOpen && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <hr className={styles.divider} />
            {auditLoading && (
              <div className={styles.loadingState}>
                <Spinner size={20} />
              </div>
            )}
            {auditError && (
              <Alert type="error" message={auditError} onClose={() => setAuditError('')} />
            )}
            {!auditLoading && !auditError && auditItems !== null && (
              auditItems.length === 0 ? (
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                  변경 이력이 없습니다.
                </p>
              ) : (
                <table className={styles.auditTable} aria-label={`${TITLES[item.type]} 변경 이력`}>
                  <thead>
                    <tr>
                      <th>이벤트</th>
                      <th>발생 시각</th>
                      <th>행위자</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditItems.map((entry, idx) => (
                      <tr key={idx}>
                        <td>{entry.eventType}</td>
                        <td>{new Date(entry.occurredAt).toLocaleString('ko-KR')}</td>
                        <td>
                          {typeof entry.data?.actor === 'string'
                            ? entry.data.actor
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

/* ── 페이지 ── */
export default function IntegrationsPage() {
  const [items, setItems] = useState<SettingItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await settingsApi.list();
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '연동 설정 조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = useCallback((updated: SettingItem) => {
    setItems((prev) =>
      prev ? prev.map((it) => (it.type === updated.type ? updated : it)) : prev
    );
  }, []);

  return (
    <AdminLayout title="연동 설정">
      <div className={styles.root}>
        {/* 상단 액션 */}
        <div className={styles.topActions}>
          <Button onClick={load} loading={loading} variant="ghost" size="sm">
            새로고침
          </Button>
        </div>

        {error && (
          <Alert type="error" message={error} onClose={() => setError('')} />
        )}

        {loading && !items && (
          <div className={styles.loadingState}>
            <Spinner size={32} />
          </div>
        )}

        {items && (
          <div className={styles.grid}>
            {items.map((item) => (
              <IntegrationCard key={item.type} item={item} onSaved={handleSaved} />
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
