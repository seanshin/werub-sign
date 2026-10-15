'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useEffect, useState, useCallback } from 'react';
import { contractsApi } from '@/lib/api';
import { ContractVerifyPublic } from '@/types/api';
import { Card, CardBody } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

/**
 * 공개 계약 검증(QR 스캔 진입) — 완료문서 각 페이지 QR 코드로 접근(로그인 불요).
 * 계약 진위·서명 검증 결과와 문서 미리보기를 제공한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function ContractVerifyPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [info, setInfo] = useState<ContractVerifyPublic | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setInfo(await contractsApi.verifyPublic(token)); }
    catch { setError('유효하지 않은 검증 링크입니다.'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const wrap: React.CSSProperties = { maxWidth: 620, margin: '0 auto', padding: '40px 16px', display: 'flex', flexDirection: 'column', gap: 16 };
  const fmt = (t: string | null) => (t ? new Date(t).toLocaleString('ko-KR') : '—');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-secondary,#f6f7f9)' }}>
      <div style={wrap}>
        <div style={{ fontWeight: 700, fontSize: 15 }}><span aria-hidden="true">◆</span> 전자계약 진위 확인</div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
        ) : error || !info ? (
          <Card><CardBody>
            <div style={{ textAlign: 'center', padding: 24 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
              <p style={{ fontSize: 15, color: 'var(--color-text-secondary)' }}>{error || '문서를 찾을 수 없습니다.'}</p>
            </div>
          </CardBody></Card>
        ) : (
          <>
            {/* 검증 결과 배너 */}
            <div style={{ padding: '18px 20px', borderRadius: 12, background: info.verified ? '#dcfce7' : '#fef9c3', color: info.verified ? '#166534' : '#854d0e', textAlign: 'center' }}>
              <div style={{ fontSize: 32 }}>{info.verified ? '✓' : '⏳'}</div>
              <strong style={{ fontSize: 17 }}>{info.verified ? '검증된 전자계약 문서입니다' : '검증 진행 중(미체결) 문서입니다'}</strong>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {info.verified
                  ? '모든 서명이 PKI 전자서명으로 유효하며 감사 이력이 무결합니다.'
                  : '아직 모든 서명이 완료되지 않았습니다.'}
              </div>
            </div>

            <Card><CardBody>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', margin: 0, fontSize: 14 }}>
                <dt style={{ color: 'var(--color-text-muted)' }}>계약명</dt>
                <dd style={{ margin: 0 }}><strong>{info.title}</strong></dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>상태</dt>
                <dd style={{ margin: 0 }}>{info.status === 'COMPLETED' ? '체결 완료' : info.status}</dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>체결 시각</dt>
                <dd style={{ margin: 0 }}>{fmt(info.completedAt)}</dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>서명 수</dt>
                <dd style={{ margin: 0 }}>{info.signatureCount}건 {info.auditChainValid ? '· 감사체인 유효' : ''}</dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>문서 해시</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11, wordBreak: 'break-all' }}>{info.documentHash}</dd>
              </dl>
            </CardBody></Card>

            <Card><CardBody>
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>서명자</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {info.signers.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                    <span style={{ color: s.signedAt ? '#16a34a' : 'var(--color-text-muted)', fontWeight: 700 }}>{s.signedAt ? '✓' : '○'}</span>
                    <strong>{s.displayName}</strong>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{s.type === 'INTERNAL' ? '내부' : '외부'}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>{s.signedAt ? fmt(s.signedAt) : '미서명'}</span>
                  </div>
                ))}
              </div>
            </CardBody></Card>

            {info.status === 'COMPLETED' && info.documentPublic !== false && (
              <a href={contractsApi.verifyDocumentUrl(token)} target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', textAlign: 'center', padding: '14px 16px', borderRadius: 8, fontSize: 16, fontWeight: 600, textDecoration: 'none', background: 'var(--color-primary,#2563eb)', color: '#fff' }}>
                계약 문서 확인(PDF)
              </a>
            )}
            {info.status === 'COMPLETED' && info.documentPublic === false && (
              // D2 — 서명자가 기재한 개인정보(계좌번호·주소 등)가 포함된 계약은 문서를 공개하지 않는다
              <div style={{ padding: '14px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary,#f8fafc)', fontSize: 14, lineHeight: 1.7 }}>
                이 계약에는 서명자가 직접 기재한 개인정보가 포함되어 있어 <strong>공개 링크로는 문서를 열람할 수 없습니다</strong>.
                위 진위 확인 정보(서명 검증·해시)로 문서의 진위를 확인하실 수 있으며, 계약 사본이 필요하면 계약 당사자에게 <strong>교부 링크</strong>를 요청하세요.
              </div>
            )}

            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
              이 페이지는 완료 문서의 QR 코드로 접근한 공개 진위 확인 화면입니다.
              서명은 PKI 실서명(X.509 + PKCS#7)으로 봉인되며, 전자서명법 제3조에 따라 서명으로서의 효력이 인정됩니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
