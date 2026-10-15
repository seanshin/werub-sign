'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 운영 관리 — webhook 재시도·기한경과 요청 만료 등 유지보수 배치의 수동 트리거.
 * 인앱 스케줄러가 주기 실행하므로 평시엔 확인용, 장애 복구 시 수동 실행용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState } from 'react';
import { maintenanceApi } from '@/lib/api';
import { ExpireResult, RotateResult } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';

export default function MaintenancePage() {
  const [expireLoading, setExpireLoading] = useState(false);
  const [expireResult, setExpireResult] = useState<ExpireResult | null>(null);
  const [expireError, setExpireError] = useState('');

  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateResult, setRotateResult] = useState<RotateResult | null>(null);
  const [rotateError, setRotateError] = useState('');
  const [rotateModal, setRotateModal] = useState(false);

  const handleExpire = async () => {
    setExpireLoading(true);
    setExpireError('');
    setExpireResult(null);
    try {
      const res = await maintenanceApi.expire();
      setExpireResult(res);
    } catch (e) {
      setExpireError(e instanceof Error ? e.message : '만료 배치 실행 실패');
    } finally {
      setExpireLoading(false);
    }
  };

  const handleRotate = async () => {
    setRotateModal(false);
    setRotateLoading(true);
    setRotateError('');
    setRotateResult(null);
    try {
      const res = await maintenanceApi.rotateIssuing();
      setRotateResult(res);
    } catch (e) {
      setRotateError(e instanceof Error ? e.message : 'CA 회전 실패');
    } finally {
      setRotateLoading(false);
    }
  };

  return (
    <AdminLayout title="운영 관리">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {/* Expire Batch */}
        <Card>
          <CardHeader
            title="만료 배치 실행"
            description="기한이 경과된 미완료 서명요청을 EXPIRED 상태로 일괄 처리합니다."
          />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {expireError && <Alert type="error" message={expireError} onClose={() => setExpireError('')} />}
              {expireResult && (
                <Alert
                  type="success"
                  message={`만료 처리 완료: ${expireResult.expired}건 처리됨${expireResult.expired > 0 ? ` (${expireResult.requestIds.slice(0, 3).join(', ')}${expireResult.requestIds.length > 3 ? '...' : ''})` : ''}`}
                />
              )}
              <div>
                <Button onClick={handleExpire} loading={expireLoading}>
                  만료 배치 실행
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* CA Rotate */}
        <Card>
          <CardHeader
            title="CA Issuing 키 회전"
            description="Issuing CA의 서명 키를 갱신합니다. 기존 인증서는 이력으로 계속 유효합니다. 이 작업은 되돌릴 수 없습니다."
          />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {rotateError && <Alert type="error" message={rotateError} onClose={() => setRotateError('')} />}
              {rotateResult && (
                <Alert
                  type="success"
                  message={`CA 회전 완료 — 새 Serial: ${rotateResult.issuingSerial}, 만료: ${new Date(rotateResult.notAfter).toLocaleDateString('ko-KR')}`}
                />
              )}
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-danger-text)', background: 'var(--color-danger-bg)', padding: 'var(--space-3)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-danger)' }}>
                주의: Admin API Key(ca:admin 스코프)가 필요한 고권한 작업입니다. 로그인 시 Admin Key를 입력하셨는지 확인해 주세요.
              </p>
              <div>
                <Button variant="danger" onClick={() => setRotateModal(true)} loading={rotateLoading}>
                  CA Issuing 회전
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Confirm Modal */}
      <Modal
        open={rotateModal}
        onClose={() => setRotateModal(false)}
        title="CA Issuing 키 회전 확인"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotateModal(false)}>취소</Button>
            <Button variant="danger" onClick={handleRotate}>확인 — 회전 실행</Button>
          </>
        }
      >
        <p style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-relaxed)' }}>
          CA Issuing 키를 회전합니다. 이 작업은 즉시 적용되며, 이후 발급되는 모든 인증서에 새 키가 사용됩니다.
          기존 인증서는 영향 받지 않습니다. 정말 진행하시겠습니까?
        </p>
      </Modal>
    </AdminLayout>
  );
}
