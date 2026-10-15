'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 폐기·OCSP — 시리얼로 인증서 폐기(사유 필수)와 OCSP/CRL 상태 조회.
 * 폐기는 가역 아님(중단 suspend 와 구분) — 확인 문구로 오조작 방지.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback } from 'react';
import { revocationApi } from '@/lib/api';
import { OcspResult, CrlResult, CrlEntry } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { StatusPill } from '@/components/ui/StatusPill';
import { Table } from '@/components/ui/Table';
import { Modal } from '@/components/ui/Modal';

const REVOKE_REASONS = [
  { value: 'unspecified', label: '미지정 (unspecified)' },
  { value: 'keyCompromise', label: '키 유출 (keyCompromise)' },
  { value: 'cACompromise', label: 'CA 유출 (cACompromise)' },
  { value: 'affiliationChanged', label: '소속 변경 (affiliationChanged)' },
  { value: 'superseded', label: '대체 발급 (superseded)' },
  { value: 'cessationOfOperation', label: '운용 중단 (cessationOfOperation)' },
];

const CRL_COLUMNS = [
  {
    key: 'serialNumber',
    label: '시리얼 번호',
    render: (row: CrlEntry) => (
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
        {row.serialNumber}
      </code>
    ),
  },
  {
    key: 'revokedAt',
    label: '폐기일시',
    render: (row: CrlEntry) =>
      row.revokedAt
        ? new Date(row.revokedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
        : '-',
    width: '180px',
  },
  {
    key: 'reason',
    label: '폐기 사유',
    render: (row: CrlEntry) => row.reason ?? '-',
    width: '200px',
  },
];

export default function RevocationPage() {
  /* ── OCSP 조회 ── */
  const [ocspSerial, setOcspSerial] = useState('');
  const [ocspLoading, setOcspLoading] = useState(false);
  const [ocspResult, setOcspResult] = useState<OcspResult | null>(null);
  const [ocspError, setOcspError] = useState('');

  /* ── CRL 조회 ── */
  const [crlLoading, setCrlLoading] = useState(false);
  const [crlResult, setCrlResult] = useState<CrlResult | null>(null);
  const [crlError, setCrlError] = useState('');

  /* ── 폐기 액션 ── */
  const [revokeSerial, setRevokeSerial] = useState('');
  const [revokeReason, setRevokeReason] = useState('unspecified');
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [revokeSuccess, setRevokeSuccess] = useState('');
  const [revokeModal, setRevokeModal] = useState(false);

  /* ── OCSP 조회 핸들러 ── */
  const handleOcsp = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const serial = ocspSerial.trim();
    if (!serial) {
      setOcspError('시리얼 번호를 입력해 주세요.');
      return;
    }
    setOcspError('');
    setOcspResult(null);
    setOcspLoading(true);
    try {
      const res = await revocationApi.ocsp(serial);
      setOcspResult(res);
    } catch (e) {
      setOcspError(e instanceof Error ? e.message : 'OCSP 조회에 실패했습니다.');
    } finally {
      setOcspLoading(false);
    }
  }, [ocspSerial]);

  /* ── CRL 조회 핸들러 ── */
  const handleCrl = useCallback(async () => {
    setCrlError('');
    setCrlResult(null);
    setCrlLoading(true);
    try {
      const res = await revocationApi.crl();
      setCrlResult(res);
    } catch (e) {
      setCrlError(e instanceof Error ? e.message : 'CRL 조회에 실패했습니다.');
    } finally {
      setCrlLoading(false);
    }
  }, []);

  /* ── 폐기 액션 핸들러 ── */
  const handleRevoke = useCallback(async () => {
    setRevokeModal(false);
    const serial = revokeSerial.trim();
    if (!serial) return;
    setRevokeError('');
    setRevokeSuccess('');
    setRevokeLoading(true);
    try {
      const res = await revocationApi.revoke(serial, revokeReason || undefined);
      setRevokeSuccess(
        `폐기 완료 — Serial: ${res.serialNumber}, 폐기일: ${new Date(res.revokedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}, CRL#${res.crlNumber}`,
      );
      setRevokeSerial('');
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : '인증서 폐기에 실패했습니다.');
    } finally {
      setRevokeLoading(false);
    }
  }, [revokeSerial, revokeReason]);

  return (
    <AdminLayout title="인증서 폐기/조회">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>

        {/* ── OCSP 단건 조회 ── */}
        <Card>
          <form onSubmit={handleOcsp}>
            <CardHeader
              title="OCSP 상태 조회"
              description="인증서 시리얼 번호로 실시간 폐기 여부를 확인합니다."
            />
            <CardBody>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {ocspError && (
                  <Alert type="error" message={ocspError} onClose={() => setOcspError('')} />
                )}

                <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <Field label="인증서 시리얼 번호" htmlFor="ocspSerial" required>
                      <Input
                        id="ocspSerial"
                        type="text"
                        value={ocspSerial}
                        onChange={(e) => setOcspSerial(e.target.value)}
                        placeholder="예: 1a2b3c4d…"
                        hasError={!!ocspError && !ocspSerial}
                      />
                    </Field>
                  </div>
                  <Button type="submit" loading={ocspLoading}>
                    조회
                  </Button>
                </div>

                {ocspResult && (
                  <div
                    style={{
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-lg)',
                      padding: 'var(--space-4)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        marginBottom: 'var(--space-3)',
                      }}
                    >
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                        상태
                      </span>
                      <StatusPill status={ocspResult.status} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                      <span style={{ color: 'var(--color-text-secondary)' }}>시리얼</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                        {ocspResult.serialNumber}
                      </code>
                      {ocspResult.revokedAt && (
                        <>
                          <span style={{ color: 'var(--color-text-secondary)' }}>폐기일시</span>
                          <span>{new Date(ocspResult.revokedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
                        </>
                      )}
                      {ocspResult.reason && (
                        <>
                          <span style={{ color: 'var(--color-text-secondary)' }}>폐기 사유</span>
                          <span>{ocspResult.reason}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </CardBody>
          </form>
        </Card>

        {/* ── CRL 목록 조회 ── */}
        <Card>
          <CardHeader
            title="CRL (Certificate Revocation List)"
            description="현재 발급된 폐기 목록 전체를 조회합니다."
            actions={
              <Button variant="ghost" size="sm" onClick={handleCrl} loading={crlLoading}>
                CRL 조회
              </Button>
            }
          />
          <CardBody>
            {crlError && (
              <Alert type="error" message={crlError} onClose={() => setCrlError('')} />
            )}

            {crlResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--space-6)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--color-text-secondary)',
                    background: 'var(--color-bg-secondary)',
                    padding: 'var(--space-3) var(--space-4)',
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <span>CRL 번호: <strong style={{ color: 'var(--color-text-primary)' }}>{crlResult.crlNumber}</strong></span>
                  <span>폐기 건수: <strong style={{ color: 'var(--color-text-primary)' }}>{crlResult.revoked.length}건</strong></span>
                  <span>생성일시: <strong style={{ color: 'var(--color-text-primary)' }}>{new Date(crlResult.producedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</strong></span>
                </div>
                <Table<CrlEntry>
                  columns={CRL_COLUMNS}
                  data={crlResult.revoked}
                  rowKey={(row) => row.serialNumber}
                  emptyMessage="폐기된 인증서가 없습니다."
                />
              </div>
            )}

            {!crlResult && !crlError && (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                CRL 조회 버튼을 클릭하면 폐기 목록이 표시됩니다.
              </p>
            )}
          </CardBody>
        </Card>

        {/* ── 인증서 폐기 액션 ── */}
        <Card>
          <CardHeader
            title="인증서 폐기"
            description="인증서를 즉시 폐기합니다. certificates:write 스코프 API 키가 필요합니다."
          />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {revokeError && (
                <Alert type="error" message={revokeError} onClose={() => setRevokeError('')} />
              )}
              {revokeSuccess && (
                <Alert type="success" message={revokeSuccess} onClose={() => setRevokeSuccess('')} />
              )}

              <p
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-danger-text)',
                  background: 'var(--color-danger-bg)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--color-danger)',
                }}
              >
                주의: 폐기된 인증서는 복구할 수 없습니다. 폐기 후 CRL이 즉시 갱신됩니다.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                <Field label="폐기할 인증서 시리얼" htmlFor="revokeSerial" required>
                  <Input
                    id="revokeSerial"
                    type="text"
                    value={revokeSerial}
                    onChange={(e) => setRevokeSerial(e.target.value)}
                    placeholder="인증서 시리얼 번호"
                  />
                </Field>
                <Field label="폐기 사유" htmlFor="revokeReason">
                  <Select
                    id="revokeReason"
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                  >
                    {REVOKE_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </CardBody>
          <CardFooter>
            <Button
              variant="danger"
              onClick={() => setRevokeModal(true)}
              loading={revokeLoading}
              disabled={!revokeSerial.trim()}
            >
              인증서 폐기
            </Button>
          </CardFooter>
        </Card>
      </div>

      {/* ── 폐기 확인 Modal ── */}
      <Modal
        open={revokeModal}
        onClose={() => setRevokeModal(false)}
        title="인증서 폐기 확인"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevokeModal(false)}>취소</Button>
            <Button variant="danger" onClick={handleRevoke}>확인 — 폐기 실행</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
          <p style={{ lineHeight: 'var(--leading-relaxed)' }}>
            아래 인증서를 즉시 폐기합니다. 이 작업은 되돌릴 수 없습니다.
          </p>
          <div
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-3)',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 'var(--space-2)' }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>시리얼</span>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                {revokeSerial}
              </code>
              <span style={{ color: 'var(--color-text-secondary)' }}>사유</span>
              <span>{revokeReason}</span>
            </div>
          </div>
          <p style={{ lineHeight: 'var(--leading-relaxed)' }}>
            정말 진행하시겠습니까?
          </p>
        </div>
      </Modal>
    </AdminLayout>
  );
}
