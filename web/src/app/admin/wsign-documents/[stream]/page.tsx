'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 문서 인증 상세 — 단일 문서 스트림의 어테스테이션 전체 이력과 체인 무결성.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { wsignApi } from '@/lib/api';
import { WsignDocDetail } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { CopyButton } from '@/components/ui/CopyButton';
import { LogDetail, shortHash } from '@/components/log/LogDetail';

type PageProps = { params: { stream: string } };
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 };

export default function WsignDocumentDetailPage({ params }: PageProps) {
  const stream = decodeURIComponent(params.stream);
  const router = useRouter();
  const [doc, setDoc] = useState<WsignDocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<number | null>(0);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setDoc(await wsignApi.detail(stream)); }
    catch (e) { setError(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, [stream]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <AdminLayout title="문서 인증 상세"><div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div></AdminLayout>;
  if (error || !doc) return (
    <AdminLayout title="문서 인증 상세">
      <Button onClick={() => router.push('/admin/wsign-documents')} variant="ghost" size="sm">← 문서 인증 목록</Button>
      <div style={{ marginTop: 16 }}><Alert type="error" message={error || '문서 없음'} /></div>
    </AdminLayout>
  );

  const entries = [...doc.entries].reverse(); // 최신 우선

  return (
    <AdminLayout title="문서 인증 상세">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Button onClick={() => router.push('/admin/wsign-documents')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>← 문서 인증 목록</Button>

        <Card>
          <CardHeader
            title={doc.title || doc.targetRef || stream}
            description={`문서 ID ${doc.targetRef ?? '-'} · 시스템 ${doc.system ?? '-'}`}
            actions={
              <span style={{ fontSize: 13, padding: '3px 10px', borderRadius: 6, background: doc.chainValid ? 'var(--color-success-bg,#dcfce7)' : 'var(--color-danger-bg,#fee2e2)', color: doc.chainValid ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>
                {doc.chainValid ? '무결성 유효(해시체인)' : '무결성 깨짐 — 위변조 의심'}
              </span>
            }
          />
          <CardBody>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', fontSize: 14, alignItems: 'center' }}>
              <span style={{ color: 'var(--color-text-muted)' }}>문서 해시({doc.hashAlgo ?? 'sha256'})</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ ...mono, wordBreak: 'break-all' }}>{doc.documentHash ?? '-'}</code>
                {doc.documentHash && <CopyButton text={doc.documentHash} label="해시 복사" />}
              </span>
              <span style={{ color: 'var(--color-text-muted)' }}>어테스테이션</span>
              <span>{doc.count.toLocaleString('ko-KR')}건</span>
              <span style={{ color: 'var(--color-text-muted)' }}>스트림</span>
              <code style={mono}>events:{doc.stream}</code>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`어테스테이션 이력 (${doc.count})`} description="문서 스트림에 봉인된 인증 이벤트 — 해시체인으로 연결(위변조 탐지)" />
          <CardBody>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                <thead><tr>
                  <th style={{ ...th, width: 24 }}></th>
                  <th style={th}>시각</th><th style={th}>이벤트</th><th style={th}>제출</th><th style={th}>entryHash</th><th style={th}>prevHash</th>
                </tr></thead>
                <tbody>
                  {entries.map((e, i) => {
                    const d = (e.data ?? {}) as Record<string, unknown>;
                    const auth = (d.auth ?? {}) as Record<string, unknown>;
                    const open = expanded === i;
                    return (
                      <React.Fragment key={i}>
                        <tr onClick={() => setExpanded(open ? null : i)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                          <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                          <td style={td}>{dt(e.occurredAt)}</td>
                          <td style={td}><strong>{e.eventType}</strong></td>
                          <td style={td}>{String(auth.method ?? d.actorRole ?? '-')}</td>
                          <td style={{ ...td, ...mono, color: 'var(--color-text-secondary)' }}>{shortHash(e.entryHash as string | undefined)}</td>
                          <td style={{ ...td, ...mono, color: 'var(--color-text-secondary)' }}>{shortHash(e.prevHash as string | undefined)}</td>
                        </tr>
                        {open && <tr><td colSpan={6} style={{ padding: '4px 10px 12px' }}><LogDetail entry={e} /></td></tr>}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
    </AdminLayout>
  );
}
