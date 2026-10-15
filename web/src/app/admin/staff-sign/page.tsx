'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 의료진 SSO 서명 — HIS 발급 staff-token(aud=sign)을 붙여 /v1/sign/staff 호출.
 * 토큰의 sub 와 서명자가 바인딩되므로 타인 명의 서명이 불가함을 화면에서 안내.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback } from 'react';
import { staffSignApi } from '@/lib/api';
import { StaffSignResult } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';

export default function StaffSignPage() {
  const [participantId, setParticipantId] = useState('');
  const [ssoToken, setSsoToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StaffSignResult | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const pid = participantId.trim();
    const token = ssoToken.trim();

    if (!pid) {
      setError('참가자 ID를 입력해 주세요.');
      return;
    }
    if (!token) {
      setError('SSO 토큰을 입력해 주세요.');
      return;
    }

    setError('');
    setResult(null);
    setLoading(true);
    try {
      const res = await staffSignApi.sign(pid, token);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'STAFF 서명에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [participantId, ssoToken]);

  const handleReset = useCallback(() => {
    setParticipantId('');
    setSsoToken('');
    setError('');
    setResult(null);
  }, []);

  return (
    <AdminLayout title="STAFF SSO 서명">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>

        {/* ── 안내 카드 ── */}
        <Card>
          <CardBody>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-info-text)',
                background: 'var(--color-info-bg)',
                padding: 'var(--space-4)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--color-info)',
              }}
            >
              <strong style={{ fontSize: 'var(--text-base)' }}>운영 안내</strong>
              <p style={{ lineHeight: 'var(--leading-relaxed)', margin: 0 }}>
                실제 운영 환경에서는 HIS(병원정보시스템)가 RS256 JWT 토큰을 자동 주입합니다.
                이 화면은 토큰 직접 붙여넣기를 통한 <strong>수동 테스트·대체 서명</strong>용입니다.
              </p>
              <p style={{ lineHeight: 'var(--leading-relaxed)', margin: 0 }}>
                SSO 토큰은 반드시 <strong>HIS SSO에서 발급</strong>된 유효한 JWT여야 하며,
                서버에서 JWKS를 통해 RS256 서명 검증 및 <code style={{ fontFamily: 'var(--font-mono)' }}>sub</code> 바인딩이 수행됩니다.
              </p>
            </div>
          </CardBody>
        </Card>

        {/* ── 서명 폼 ── */}
        <Card>
          <form onSubmit={handleSubmit}>
            <CardHeader
              title="STAFF SSO 서명 실행"
              description="참가자 ID와 HIS SSO 토큰으로 의료진 서명을 수행합니다."
            />
            <CardBody>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {error && (
                  <Alert type="error" message={error} onClose={() => setError('')} />
                )}

                {result && (
                  <div
                    style={{
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-lg)',
                      padding: 'var(--space-4)',
                    }}
                  >
                    <p
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 'var(--font-semibold)',
                        color: 'var(--color-success-text)',
                        marginBottom: 'var(--space-3)',
                      }}
                    >
                      서명 완료
                    </p>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '140px 1fr',
                        gap: 'var(--space-2)',
                        fontSize: 'var(--text-sm)',
                      }}
                    >
                      <span style={{ color: 'var(--color-text-secondary)' }}>참가자 ID</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                        {result.participantId}
                      </code>

                      <span style={{ color: 'var(--color-text-secondary)' }}>상태</span>
                      <span>{String(result.status)}</span>

                      <span style={{ color: 'var(--color-text-secondary)' }}>Staff Sub</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                        {result.staffSub}
                      </code>

                      {result.acr && (
                        <>
                          <span style={{ color: 'var(--color-text-secondary)' }}>ACR</span>
                          <span>{result.acr}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <Field label="참가자 ID" htmlFor="participantId" required hint="서명요청에 등록된 STAFF 참가자의 UUID">
                  <Input
                    id="participantId"
                    type="text"
                    value={participantId}
                    onChange={(e) => setParticipantId(e.target.value)}
                    placeholder="예: 550e8400-e29b-41d4-a716-446655440000"
                    hasError={!!error && !participantId}
                    disabled={!!result}
                  />
                </Field>

                <Field
                  label="SSO 토큰 (HIS 발급)"
                  htmlFor="ssoToken"
                  required
                  hint="HIS SSO에서 발급한 RS256 JWT. Bearer 접두어는 입력하지 않아도 됩니다."
                >
                  <Textarea
                    id="ssoToken"
                    value={ssoToken}
                    onChange={(e) => setSsoToken(e.target.value)}
                    placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9…"
                    rows={5}
                    hasError={!!error && !ssoToken}
                    disabled={!!result}
                    style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                  />
                </Field>
              </div>
            </CardBody>
            <CardFooter>
              {result ? (
                <Button type="button" variant="ghost" onClick={handleReset}>
                  초기화
                </Button>
              ) : (
                <Button type="submit" loading={loading}>
                  서명 실행
                </Button>
              )}
            </CardFooter>
          </form>
        </Card>

        {/* ── 기술 참고 정보 ── */}
        <Card>
          <CardHeader
            title="기술 참고"
            description="API 호출 방식 및 검증 흐름"
          />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>
              <div>
                <p style={{ fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-2)' }}>엔드포인트</p>
                <code
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-lg)',
                    padding: 'var(--space-3)',
                    lineHeight: 'var(--leading-relaxed)',
                  }}
                >
                  POST /v1/sign/staff<br />
                  Authorization: Bearer &lt;SSO JWT&gt;<br />
                  {'{'} &quot;participantId&quot;: &quot;…&quot; {'}'}
                </code>
              </div>
              <div>
                <p style={{ fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-2)' }}>서버 검증 흐름</p>
                <ol
                  style={{
                    margin: 0,
                    paddingLeft: 'var(--space-5)',
                    color: 'var(--color-text-secondary)',
                    lineHeight: 'var(--leading-relaxed)',
                  }}
                >
                  <li>Authorization 헤더에서 Bearer 토큰 추출</li>
                  <li>HIS JWKS 엔드포인트에서 공개키 조회</li>
                  <li>RS256 서명 검증 및 만료(exp) 확인</li>
                  <li>sub 클레임으로 서명자 바인딩</li>
                  <li>participantId 기준 서명 처리 및 감사 기록</li>
                </ol>
              </div>
            </div>
          </CardBody>
        </Card>

      </div>
    </AdminLayout>
  );
}
