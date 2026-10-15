'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 인증서 발급 — 유형별(환자/의료진/증인/대리) 탭 폼으로 /v1/certificates/enroll 호출.
 * 발급 결과의 serial·attestation(keyCustody·assuranceLevel)을 즉시 표시한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState } from 'react';
import { certificatesApi } from '@/lib/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { CopyButton } from '@/components/ui/CopyButton';

type Tab = 'STAFF' | 'PATIENT' | 'ETC';
type IdentityMethod = 'INPERSON' | 'PASS' | 'MOBILE_NAME' | 'STAFF_SSO';

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'STAFF', label: '의료진 (STAFF)', hint: '면허 기반 1회 발급 후 SSO로 재사용' },
  { key: 'PATIENT', label: '환자 (PATIENT)', hint: '본인확인(PASS/대면) 기반. 운영은 보통 서명 시 자동발급' },
  { key: 'ETC', label: '대리·증인', hint: '대리(PROXY)/증인(WITNESS)' },
];

export default function CertificatesPage() {
  const [tab, setTab] = useState<Tab>('STAFF');
  const [etcType, setEtcType] = useState<'WITNESS' | 'PROXY'>('WITNESS');
  const [subjectDn, setSubjectDn] = useState('');
  const [identityMethod, setIdentityMethod] = useState<IdentityMethod>('STAFF_SSO');
  const [ci, setCi] = useState('');
  const [phone, setPhone] = useState('');
  const [ownerRef, setOwnerRef] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [validDays, setValidDays] = useState('365');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ serialNumber: string } | null>(null);

  const ownerType = tab === 'ETC' ? etcType : tab;
  const needsCi = identityMethod === 'PASS' || identityMethod === 'MOBILE_NAME';

  const switchTab = (t: Tab) => {
    setTab(t); setError(''); setResult(null);
    setIdentityMethod(t === 'STAFF' ? 'STAFF_SSO' : t === 'PATIENT' ? 'PASS' : 'INPERSON');
    if (t !== 'STAFF') setLicenseNumber('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subjectDn.trim()) { setError('Subject DN을 입력해 주세요.'); return; }
    if (tab === 'STAFF' && !licenseNumber.trim()) { setError('의료진은 면허 번호가 필요합니다.'); return; }
    setError(''); setLoading(true);
    try {
      const res = await certificatesApi.enroll({
        ownerType,
        subjectDn: subjectDn.trim(),
        identity: { method: identityMethod, ci: ci || undefined, phone: phone || undefined },
        ownerRef: ownerRef || undefined,
        licenseNumber: licenseNumber || undefined,
        validDays: validDays ? parseInt(validDays, 10) : undefined,
      });
      setResult({ serialNumber: res.serialNumber });
      setSubjectDn(''); setCi(''); setPhone(''); setOwnerRef(''); setLicenseNumber('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '인증서 발급에 실패했습니다.');
    } finally { setLoading(false); }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '8px 18px', borderRadius: 999, fontSize: 14, cursor: 'pointer', border: '1px solid var(--color-border)',
    background: active ? 'var(--color-primary, #2563eb)' : 'transparent', color: active ? '#fff' : 'var(--color-text)',
    fontWeight: active ? 600 : 400,
  });

  return (
    <AdminLayout title="인증서 발급">
      {/* 유형 탭 — 의료진/환자/대리·증인 구분 발급 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
        {TABS.map((t) => <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => switchTab(t.key)}>{t.label}</button>)}
      </div>

      <Card>
        <form onSubmit={handleSubmit}>
          <CardHeader title={`${TABS.find((t) => t.key === tab)!.label} 발급`} description={TABS.find((t) => t.key === tab)!.hint} />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {error && <Alert type="error" message={error} onClose={() => setError('')} />}
              {result && (
                <>
                  <Alert type="success" message={`인증서가 발급되었습니다. Serial: ${result.serialNumber}`} />
                  <div style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>발급된 인증서 Serial Number</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', flex: 1, wordBreak: 'break-all' }}>{result.serialNumber}</code>
                      <CopyButton text={result.serialNumber} />
                    </div>
                  </div>
                </>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                {tab === 'ETC' ? (
                  <Field label="유형" htmlFor="etcType" required>
                    <Select id="etcType" value={etcType} onChange={(e) => setEtcType(e.target.value as 'WITNESS' | 'PROXY')}>
                      <option value="WITNESS">증인 (WITNESS)</option>
                      <option value="PROXY">대리 (PROXY)</option>
                    </Select>
                  </Field>
                ) : (
                  <Field label="소유자 유형" htmlFor="ownerType">
                    <Input id="ownerType" type="text" value={ownerType} disabled />
                  </Field>
                )}
                <Field label="유효 기간 (일)" htmlFor="validDays">
                  <Input id="validDays" type="number" min="1" max="3650" value={validDays} onChange={(e) => setValidDays(e.target.value)} placeholder="365" />
                </Field>
              </div>

              <Field label="Subject DN" htmlFor="subjectDn" required hint={tab === 'STAFF' ? '예: CN=김외과,O=병원명,C=KR' : tab === 'PATIENT' ? '예: CN=홍길동,O=병원명,C=KR' : '예: CN=보호자,O=병원명,C=KR'}>
                <Input id="subjectDn" type="text" value={subjectDn} onChange={(e) => setSubjectDn(e.target.value)} placeholder="CN=이름,O=병원명,C=KR" hasError={!!error && !subjectDn} />
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <Field label="소유자 참조 ID" htmlFor="ownerRef" hint={tab === 'STAFF' ? 'HIS user.id 등' : 'EMR 환자 ID 등'}>
                  <Input id="ownerRef" type="text" value={ownerRef} onChange={(e) => setOwnerRef(e.target.value)} placeholder={tab === 'STAFF' ? 'HIS user.id' : 'EMR 환자 번호'} />
                </Field>
                {tab === 'STAFF' && (
                  <Field label="면허 번호" htmlFor="licenseNumber" required>
                    <Input id="licenseNumber" type="text" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} placeholder="의사면허 번호" />
                  </Field>
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-4)' }}>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-4)' }}>본인확인 정보</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  {tab === 'STAFF' ? (
                    <Field label="확인 방법" htmlFor="identityMethod">
                      <Input id="identityMethod" type="text" value="STAFF_SSO (병원 SSO)" disabled />
                    </Field>
                  ) : (
                    <Field label="확인 방법" htmlFor="identityMethod" required>
                      <Select id="identityMethod" value={identityMethod} onChange={(e) => setIdentityMethod(e.target.value as IdentityMethod)}>
                        <option value="PASS">PASS 인증</option>
                        <option value="INPERSON">대면 (INPERSON)</option>
                        <option value="MOBILE_NAME">휴대폰 본인확인</option>
                      </Select>
                    </Field>
                  )}
                  {needsCi && tab !== 'STAFF' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                      <Field label="CI (연계정보)" htmlFor="ci"><Input id="ci" type="text" value={ci} onChange={(e) => setCi(e.target.value)} placeholder="CI 값" /></Field>
                      <Field label="휴대폰 번호" htmlFor="phone"><Input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01012345678" /></Field>
                    </div>
                  )}
                </div>
                {tab === 'PATIENT' && (
                  <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 'var(--space-3)' }}>
                    ※ 운영에선 환자 인증서가 동의서 서명 시 <strong>자동발급</strong>(facade+본인확인)됩니다. 본 화면은 대면 현장·예외·테스트용 수동 발급입니다.
                  </p>
                )}
              </div>
            </div>
          </CardBody>
          <CardFooter>
            <Button type="submit" loading={loading}>{TABS.find((t) => t.key === tab)!.label} 발급</Button>
          </CardFooter>
        </form>
      </Card>
    </AdminLayout>
  );
}
