'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useEffect, useState, useCallback } from 'react';
import { contractsApi } from '@/lib/api';
import { ContractDeliveryInfo, ContractAttachment, ApiError } from '@/types/api';
import { Card, CardBody } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

/**
 * 완료문서 교부(공개, 만료형 토큰) — 체결 완료 계약의 원본 PDF·감사추적인증서 다운로드.
 * 외부 서명자가 이메일 링크로 접근(로그인 불요). 다운로드는 전건 접속기록(F008)에 봉인.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function ContractDeliveryPage({ params }: { params: { token: string } }) {
  const { token } = params;
  const [info, setInfo] = useState<ContractDeliveryInfo | null>(null);
  const [attachments, setAttachments] = useState<ContractAttachment[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // 링크 연장(1회)·다른 주소로 전달
  const [busy, setBusy] = useState<'extend' | 'forward' | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [fwdEmail, setFwdEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await contractsApi.deliveryInfo(token));
      contractsApi.deliveryAttachments(token).then(setAttachments).catch(() => setAttachments([]));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 410 ? '교부 링크가 만료되었습니다. 발송자에게 재발급을 요청하세요.' : '유효하지 않은 교부 링크입니다.');
    } finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const doExtend = async () => {
    setBusy('extend'); setNotice(''); setActionError('');
    try {
      const r = await contractsApi.deliveryExtend(token);
      setNotice(`링크 기한이 ${new Date(r.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 연장되었습니다.`);
      await load();
    } catch (e) { setActionError(e instanceof Error ? e.message : '연장에 실패했습니다'); }
    finally { setBusy(null); }
  };

  const doForward = async () => {
    const to = fwdEmail.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { setActionError('이메일 형식을 확인해 주세요'); return; }
    setBusy('forward'); setNotice(''); setActionError('');
    try {
      const r = await contractsApi.deliveryForward(token, to);
      setFwdEmail('');
      setNotice(`${r.email} 으로 문서 링크를 보냈습니다(남은 전달 ${r.remaining}회).`);
      await load();
    } catch (e) { setActionError(e instanceof Error ? e.message : '전달에 실패했습니다'); }
    finally { setBusy(null); }
  };

  const wrap: React.CSSProperties = { maxWidth: 560, margin: '0 auto', padding: '48px 16px', display: 'flex', flexDirection: 'column', gap: 16 };
  const btn: React.CSSProperties = { display: 'block', textAlign: 'center', padding: '14px 16px', borderRadius: 8, fontSize: 16, fontWeight: 600, textDecoration: 'none', border: '1px solid var(--color-border)' };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-secondary,#f6f7f9)' }}>
      <div style={wrap}>
        <div style={{ fontWeight: 700, fontSize: 15 }}><span aria-hidden="true">◆</span> 전자계약 문서 교부</div>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
        ) : error || !info ? (
          <Card><CardBody>
            <div style={{ textAlign: 'center', padding: 24 }}>
              <div style={{ fontSize: 32 }}>⚠️</div>
              <h1 style={{ fontSize: 18, margin: '12px 0 8px' }}>링크 오류</h1>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>{error}</p>
            </div>
          </CardBody></Card>
        ) : (
          <Card><CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <h1 style={{ fontSize: 20, margin: 0 }}>{info.title}</h1>
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '6px 0 0' }}>
                  계약이 체결 완료되었습니다. 아래 <strong>두 파일을 함께 내려받아 보관</strong>해 주세요 —
                  계약 내용은 <strong>완료 문서</strong>에, 그 문서가 위·변조되지 않았다는 증거는 <strong>감사추적인증서</strong>에 담겨 있습니다.
                </p>
              </div>
              {info.documentAvailable ? (
                <div>
                  <a href={contractsApi.deliveryDocumentUrl(token)} target="_blank" rel="noreferrer" style={{ ...btn, background: 'var(--color-primary,#2563eb)', color: '#fff', borderColor: 'transparent' }}>
                    ① 완료 문서(PDF) 내려받기
                  </a>
                  <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '6px 2px 0', lineHeight: 1.6 }}>
                    서명이 반영된 <strong>계약서 본문</strong>입니다. 각 장 우하단의 QR 을 스캔하면 누구나 진위를 확인할 수 있습니다.
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>완료 문서가 보관되어 있지 않습니다 — 발송자에게 문의하세요.</p>
              )}
              <div>
                <a href={contractsApi.deliveryCertificateUrl(token)} target="_blank" rel="noreferrer" style={{ ...btn, color: 'var(--color-text)' }}>
                  ② 감사추적인증서(PDF) 내려받기
                </a>
                <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '6px 2px 0', lineHeight: 1.6 }}>
                  <strong>증거 문서</strong>입니다 — 문서 해시·서명자·인증서 정보와 서명 이력(해시 체인)을 담고 있으며,
                  이 파일 자체가 전자서명(PAdES)으로 봉인되어 있습니다. <strong>계약서와 합치면 이 서명이 깨지므로 별도 파일로 보관</strong>하세요.
                </p>
              </div>
              {attachments.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>첨부 문서 ({attachments.length})</div>
                  {attachments.map((a) => (
                    <a key={a.attachId} href={contractsApi.deliveryAttachmentUrl(token, a.attachId)} target="_blank" rel="noreferrer" style={{ ...btn, fontSize: 14, fontWeight: 500, padding: '10px 14px', color: 'var(--color-text)' }}>
                      📎 {a.name} ({(a.sizeBytes / 1024).toFixed(0)}KB)
                    </a>
                  ))}
                </div>
              )}
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.7 }}>
                이 링크는 {new Date(info.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 유효합니다.
                기한이 지나면 계약 발송자에게 재발급을 요청하세요.
              </p>

              {notice && <div role="status" style={{ fontSize: 13, padding: '10px 12px', borderRadius: 8, background: 'var(--color-success-bg,#dcfce7)', color: 'var(--color-success-text,#166534)' }}>{notice}</div>}
              {actionError && <div role="alert" style={{ fontSize: 13, padding: '10px 12px', borderRadius: 8, background: 'var(--color-danger-bg,#fee2e2)', color: 'var(--color-danger-text,#991b1b)' }}>{actionError}</div>}

              {/* 링크 기간 연장 — 수신자가 기한 내 1회 */}
              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
                <button
                  onClick={doExtend}
                  disabled={busy !== null || info.extendable === false}
                  style={{ ...btn, width: '100%', fontSize: 15, cursor: busy || info.extendable === false ? 'not-allowed' : 'pointer', opacity: info.extendable === false ? 0.55 : 1, background: 'var(--color-bg)', color: 'var(--color-text)' }}
                >
                  {busy === 'extend' ? '연장하는 중…' : info.extendable === false ? '이미 연장한 링크입니다(1회 한정)' : '기한 연장하기 (1회)'}
                </button>
                <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '6px 2px 0', lineHeight: 1.6 }}>
                  기한이 남아 있는 동안 <strong>한 번</strong> 연장할 수 있습니다. 만료된 뒤에는 발송자에게 재발급을 요청해야 합니다.
                </p>
              </div>

              {/* 다른 이메일로 전달 */}
              {(info.forwardRemaining ?? 0) > 0 && (
                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>다른 이메일로 보내기</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="email"
                      value={fwdEmail}
                      onChange={(e) => setFwdEmail(e.target.value)}
                      placeholder="받는 사람 이메일"
                      aria-label="문서를 받을 이메일 주소"
                      style={{ flex: '1 1 220px', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', fontSize: 15, background: 'var(--color-bg)', color: 'var(--color-text)' }}
                    />
                    <button
                      onClick={doForward}
                      disabled={busy !== null}
                      style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid transparent', background: 'var(--color-primary,#2563eb)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      {busy === 'forward' ? '보내는 중…' : '보내기'}
                    </button>
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)', margin: '6px 2px 0', lineHeight: 1.6 }}>
                    담당자·보관용 주소로 문서를 넘길 수 있습니다. 파일을 첨부하는 대신 <strong>새 다운로드 링크</strong>가 발송되며(만료 동일),
                    전달 사실과 받는 주소는 계약 이력에 기록됩니다. 남은 전달 {info.forwardRemaining}회.
                  </p>
                </div>
              )}
            </div>
          </CardBody></Card>
        )}
      </div>
    </div>
  );
}
