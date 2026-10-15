'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 서명요청 생성 — 문서 해시·참가자(역할/순서/인증서)를 구성해 /v1/requests 생성.
 * 생성 후 포털 토큰 발급·발송으로 이어지는 진입점.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { requestsApi, certificatesApi } from '@/lib/api';
import { CreateRequestParticipant, IdentityLevel, SignerType, ProxyRelationship, CertListRow } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';

async function fileToSha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const cnOf = (dn: string) => dn.replace(/^CN=/i, '').replace(/,.*$/, '').trim();
const MANUAL = '__MANUAL__';

const PROXY_RELATIONSHIPS: ProxyRelationship[] = ['법정대리인', '배우자', '직계가족', '응급보호자'];

type PRow = CreateRequestParticipant & { participantId: string; certManual?: boolean };

const EMPTY_PARTICIPANT: Omit<CreateRequestParticipant, 'participantId'> = {
  signerRole: '',
  signerType: 'PATIENT',
  displayName: '',
  signOrder: 1,
  certSerial: '',
  requiredIdentityLevel: 'INPERSON',
  relationship: undefined,
  onBehalfOf: undefined,
};

export default function NewRequestPage() {
  const router = useRouter();

  // Request fields
  const [title, setTitle] = useState('');
  const [externalDocId, setExternalDocId] = useState('');
  const [documentHash, setDocumentHash] = useState('');
  const [signMode, setSignMode] = useState('PARALLEL');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [ttlDays, setTtlDays] = useState('30');

  // Participants
  const [participants, setParticipants] = useState<PRow[]>([
    { ...EMPTY_PARTICIPANT, participantId: crypto.randomUUID() } as PRow,
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hashLoading, setHashLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 발급 인증서 목록(인라인 선택기) — ACTIVE만
  const [certs, setCerts] = useState<CertListRow[]>([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const loadCerts = useCallback(async () => {
    setCertsLoading(true);
    try {
      const res = await certificatesApi.list({ limit: 200 });
      setCerts(res.data.filter((c) => c.status === 'ACTIVE'));
    } catch {
      /* 인증서 목록 실패 시 직접 입력으로 폴백 */
    } finally {
      setCertsLoading(false);
    }
  }, []);
  useEffect(() => { void loadCerts(); }, [loadCerts]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setHashLoading(true);
    try {
      const hex = await fileToSha256Hex(file);
      setDocumentHash(hex);
    } catch {
      setError('파일 해시 계산에 실패했습니다.');
    } finally {
      setHashLoading(false);
    }
  };

  const addParticipant = () => {
    setParticipants((prev) => [
      ...prev,
      { ...EMPTY_PARTICIPANT, participantId: crypto.randomUUID() } as PRow,
    ]);
  };

  const removeParticipant = (idx: number) => {
    setParticipants((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateParticipant = (idx: number, field: string, value: unknown) => {
    setParticipants((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('제목을 입력해 주세요.'); return; }
    if (!externalDocId.trim()) { setError('외부 문서 ID를 입력해 주세요.'); return; }
    if (documentHash.length !== 64) { setError('문서 해시는 정확히 64자의 hex 값이어야 합니다. 파일을 업로드하거나 직접 입력해 주세요.'); return; }
    if (participants.length === 0) { setError('참가자를 1명 이상 추가해 주세요.'); return; }
    for (const p of participants) {
      if (!p.signerRole || !p.displayName || !p.certSerial) {
        setError('모든 참가자의 역할, 이름, 인증서 Serial을 입력해 주세요.');
        return;
      }
      if (p.signerType === 'PROXY') {
        if (!p.relationship) {
          setError('보호자/대리인의 관계를 선택해 주세요.');
          return;
        }
        if (!p.onBehalfOf) {
          setError('보호자/대리인의 대리 대상 환자 정보를 입력해 주세요.');
          return;
        }
      }
    }

    setError('');
    setLoading(true);
    try {
      const res = await requestsApi.create({
        idempotencyKey: crypto.randomUUID(),
        externalDocId: externalDocId.trim(),
        title: title.trim(),
        documentHash,
        signMode,
        callbackUrl: callbackUrl.trim() || undefined,
        ttlDays: ttlDays ? parseInt(ttlDays, 10) : undefined,
        // signOrder = 실제 게이팅 기준. PARALLEL→전원 동일(1, 동시) / SEQUENTIAL→순번(1,2,3…)
        participants: participants.map((p, idx) => ({
          signerRole: p.signerRole,
          signerType: p.signerType as SignerType,
          displayName: p.displayName,
          signOrder: signMode === 'PARALLEL' ? 1 : idx + 1,
          certSerial: p.certSerial.trim(),
          requiredIdentityLevel: p.requiredIdentityLevel as IdentityLevel,
          ...(p.signerType === 'PROXY' && p.relationship ? { relationship: p.relationship } : {}),
          ...(p.signerType === 'PROXY' && p.onBehalfOf ? { onBehalfOf: p.onBehalfOf } : {}),
        })),
      });
      router.push(`/admin/requests/${res.requestId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '서명요청 생성에 실패했습니다.');
      setLoading(false);
    }
  };

  return (
    <AdminLayout title="새 서명요청 생성">
      <form onSubmit={handleSubmit}>
        {/* Basic Info */}
        <Card style={{ marginBottom: 'var(--space-4)' }}>
          <CardHeader title="기본 정보" />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {error && <Alert type="error" message={error} onClose={() => setError('')} />}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <Field label="서명요청 제목" htmlFor="title" required>
                  <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="수술 동의서 서명" hasError={!!error && !title} />
                </Field>
                <Field label="외부 문서 ID" htmlFor="extDocId" required hint="EMR 문서 식별자">
                  <Input id="extDocId" value={externalDocId} onChange={(e) => setExternalDocId(e.target.value)} placeholder="DOC-2025-001" />
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <Field label="서명 모드" htmlFor="signMode" required hint={signMode === 'PARALLEL' ? '병렬 — 참가자가 순서 없이 동시에 서명' : '순차 — 위에서부터 차례로 서명(앞 참가자 완료 후 다음)'}>
                  <Select id="signMode" value={signMode} onChange={(e) => setSignMode(e.target.value)}>
                    <option value="PARALLEL">병렬 (PARALLEL) — 동시 서명</option>
                    <option value="SEQUENTIAL">순차 (SEQUENTIAL) — 순서대로</option>
                  </Select>
                </Field>
                <Field label="TTL (일)" htmlFor="ttlDays">
                  <Input id="ttlDays" type="number" min="1" max="365" value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} placeholder="30" />
                </Field>
              </div>

              <Field label="Callback URL" htmlFor="callbackUrl" hint="서명 완료/철회/만료 시 Webhook 수신 URL">
                <Input id="callbackUrl" type="url" value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} placeholder="https://his.example.com/webhook" />
              </Field>

              <Field
                label="문서 해시 (SHA-256, 64자 hex)"
                htmlFor="documentHash"
                required
                hint="파일을 업로드하면 자동 계산됩니다. 또는 직접 입력할 수 있습니다."
              >
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
                  <Input
                    id="documentHash"
                    type="text"
                    value={documentHash}
                    onChange={(e) => setDocumentHash(e.target.value)}
                    placeholder="64자 hex (0-9a-f)"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                    hasError={!!error && documentHash.length !== 64}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => fileRef.current?.click()}
                    loading={hashLoading}
                    style={{ flexShrink: 0 }}
                  >
                    파일 선택
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                    aria-label="문서 파일 선택"
                  />
                </div>
              </Field>
            </div>
          </CardBody>
        </Card>

        {/* Participants */}
        <Card style={{ marginBottom: 'var(--space-4)' }}>
          <CardHeader
            title={`참가자 (${participants.length}명)`}
            description={signMode === 'PARALLEL' ? '병렬 모드 — 전원 동시 서명(순서 없음)' : '순차 모드 — 위에서부터 서명 순서 1, 2, 3…'}
            actions={
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button type="button" variant="ghost" size="sm" onClick={loadCerts} loading={certsLoading}>인증서 새로고침</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => window.open('/admin/certificates', '_blank')}>+ 인증서 발급</Button>
                <Button type="button" variant="ghost" size="sm" onClick={addParticipant}>+ 참가자</Button>
              </div>
            }
          />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {participants.map((p, idx) => (
                <div key={(p as CreateRequestParticipant & { participantId?: string }).participantId ?? idx} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                    <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)' }}>참가자 {idx + 1}</h4>
                    {participants.length > 1 && (
                      <Button type="button" variant="danger" size="sm" onClick={() => removeParticipant(idx)}>
                        삭제
                      </Button>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
                    <Field label="이름" htmlFor={`name-${idx}`} required>
                      <Input id={`name-${idx}`} value={p.displayName} onChange={(e) => updateParticipant(idx, 'displayName', e.target.value)} placeholder="홍길동" />
                    </Field>
                    <Field label="서명자 역할" htmlFor={`role-${idx}`} required>
                      <Input id={`role-${idx}`} value={p.signerRole} onChange={(e) => updateParticipant(idx, 'signerRole', e.target.value)} placeholder="PATIENT / DOCTOR 등" />
                    </Field>
                    <Field label="서명 순서">
                      <div style={{ display: 'flex', alignItems: 'center', height: 38, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                        {signMode === 'PARALLEL' ? '동시 서명 (순서 없음)' : `${idx + 1}번째`}
                      </div>
                    </Field>
                    <Field label="유형" htmlFor={`type-${idx}`}>
                      <Select id={`type-${idx}`} value={p.signerType} onChange={(e) => {
                        updateParticipant(idx, 'signerType', e.target.value);
                        if (e.target.value !== 'PROXY') {
                          updateParticipant(idx, 'relationship', undefined);
                          updateParticipant(idx, 'onBehalfOf', undefined);
                        }
                      }}>
                        <option value="PATIENT">환자 (PATIENT)</option>
                        <option value="STAFF">의료진 (STAFF)</option>
                        <option value="WITNESS">증인 (WITNESS)</option>
                        <option value="PROXY">보호자/대리 (PROXY)</option>
                      </Select>
                    </Field>
                    <Field label="본인확인 레벨" htmlFor={`idlevel-${idx}`}>
                      <Select id={`idlevel-${idx}`} value={p.requiredIdentityLevel ?? 'INPERSON'} onChange={(e) => updateParticipant(idx, 'requiredIdentityLevel', e.target.value)}>
                        <option value="INPERSON">대면 (INPERSON)</option>
                        <option value="NONE">없음 (NONE)</option>
                        <option value="PASS">PASS</option>
                        <option value="MOBILE_NAME">휴대폰 (MOBILE_NAME)</option>
                        <option value="APP_STEPUP">앱 (APP_STEPUP)</option>
                        <option value="STAFF_SSO">직원 SSO</option>
                      </Select>
                    </Field>
                    <Field label="인증서" htmlFor={`cert-${idx}`} required hint={certs.length === 0 ? '발급된 인증서 없음 — 직접 입력 또는 발급' : '발급 인증서에서 선택'}>
                      {certs.length > 0 && !p.certManual ? (
                        <Select
                          id={`cert-${idx}`}
                          value={p.certSerial}
                          onChange={(e) => {
                            if (e.target.value === MANUAL) { updateParticipant(idx, 'certManual', true); updateParticipant(idx, 'certSerial', ''); }
                            else updateParticipant(idx, 'certSerial', e.target.value);
                          }}
                        >
                          <option value="">인증서 선택</option>
                          {certs.map((c) => (
                            <option key={c.serialNumber} value={c.serialNumber}>
                              {cnOf(c.subjectDn)} · {c.ownerType} · {c.serialNumber}
                            </option>
                          ))}
                          <option value={MANUAL}>— 직접 입력 —</option>
                        </Select>
                      ) : (
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <Input id={`cert-${idx}`} value={p.certSerial} onChange={(e) => updateParticipant(idx, 'certSerial', e.target.value)} placeholder="인증서 Serial 직접 입력" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} />
                          {certs.length > 0 && (
                            <Button type="button" variant="ghost" size="sm" style={{ flexShrink: 0 }} onClick={() => { updateParticipant(idx, 'certManual', false); updateParticipant(idx, 'certSerial', ''); }}>목록</Button>
                          )}
                        </div>
                      )}
                    </Field>
                  </div>

                  {/* PROXY 전용 필드 */}
                  {p.signerType === 'PROXY' && (
                    <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--color-info-bg)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-primary-light)' }}>
                      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--color-info-text)', marginBottom: 'var(--space-3)' }}>
                        보호자/대리인 추가 정보
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                        <Field label="대리인 관계" htmlFor={`relationship-${idx}`} required>
                          <Select
                            id={`relationship-${idx}`}
                            value={p.relationship ?? ''}
                            onChange={(e) => updateParticipant(idx, 'relationship', e.target.value as ProxyRelationship || undefined)}
                          >
                            <option value="">선택하세요</option>
                            {PROXY_RELATIONSHIPS.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="대리 대상 환자 식별" htmlFor={`onBehalfOf-${idx}`} required hint="환자 이름 또는 환자 ID">
                          <Input
                            id={`onBehalfOf-${idx}`}
                            value={p.onBehalfOf ?? ''}
                            onChange={(e) => updateParticipant(idx, 'onBehalfOf', e.target.value || undefined)}
                            placeholder="홍길동 / P-20250001"
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        {/* Submit */}
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Button type="submit" loading={loading}>
            서명요청 생성
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            취소
          </Button>
        </div>
      </form>
    </AdminLayout>
  );
}
