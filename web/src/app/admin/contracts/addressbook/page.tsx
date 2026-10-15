'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { contractsApi } from '@/lib/api';
import { AddressEntry } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

/** 발송/수신 이메일 주소록 — 자주 발송하는 외부 상대방 연락처 관리(추가·수정·삭제·검색). */
export default function ContractAddressbookPage() {
  const [rows, setRows] = useState<AddressEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AddressEntry | 'new' | null>(null);
  const [form, setForm] = useState({ email: '', name: '', org: '', memo: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await contractsApi.addressbook(q || undefined)); }
    catch (e) { const m = e instanceof Error ? e.message : '조회 실패'; if (/비활성/.test(m)) setDisabled(true); else setError(m); }
    finally { setLoading(false); }
  }, [q]);
  useEffect(() => { const t = setTimeout(() => setQ(filter.trim()), 300); return () => clearTimeout(t); }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const openNew = () => { setForm({ email: '', name: '', org: '', memo: '' }); setEditing('new'); setMsg(null); };
  const openEdit = (e: AddressEntry) => { setForm({ email: e.email, name: e.name, org: e.org ?? '', memo: e.memo ?? '' }); setEditing(e); setMsg(null); };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      if (editing === 'new') await contractsApi.addressbookAdd({ email: form.email, name: form.name, org: form.org || undefined, memo: form.memo || undefined });
      else if (editing) await contractsApi.addressbookUpdate(editing.id, { email: form.email, name: form.name, org: form.org, memo: form.memo });
      setEditing(null); await load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '저장 실패' }); }
    finally { setBusy(false); }
  };
  const remove = async (e: AddressEntry) => {
    if (!window.confirm(`"${e.name} <${e.email}>"을(를) 주소록에서 삭제할까요?`)) return;
    try { await contractsApi.addressbookRemove(e.id); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '삭제 실패'); }
  };

  if (disabled) return (
    <AdminLayout title="발송 주소록">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );

  return (
    <AdminLayout title="발송 주소록">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>자주 발송하는 외부 상대방 이메일을 저장해 계약 발송 시 빠르게 선택합니다.</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="검색(이메일·이름·소속)" aria-label="주소록 검색" style={{ width: 240 }} />
            <Button variant="primary" onClick={openNew}>연락처 추가</Button>
          </div>
        </div>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}

        <Card>
          <CardHeader title={`연락처 (${rows.length.toLocaleString('ko-KR')})`} />
          <CardBody>
            {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                  <thead><tr><th style={th}>이름</th><th style={th}>이메일</th><th style={th}>소속</th><th style={th}>메모</th><th style={th}></th></tr></thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td style={td}><strong>{e.name}</strong></td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{e.email}</td>
                        <td style={td}>{e.org ?? '-'}</td>
                        <td style={{ ...td, color: 'var(--color-text-muted)', fontSize: 13 }}>{e.memo ?? '-'}</td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(e)}>수정</Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(e)}>삭제</Button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && !loading && <tr><td style={td} colSpan={5}>{q ? '검색 일치 없음' : '등록된 연락처가 없습니다 — “연락처 추가”로 시작하세요'}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '연락처 추가' : '연락처 수정'}
        footer={<>
          <Button onClick={() => setEditing(null)} variant="ghost" disabled={busy}>취소</Button>
          <Button onClick={save} loading={busy} variant="primary" disabled={!form.email.trim() || !form.name.trim()}>저장</Button>
        </>}
      >
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {msg?.type === 'error' && <Alert type="error" message={msg.text} />}
          <Field label="이메일" required htmlFor="ab-email"><Input id="ab-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="partner@example.com" /></Field>
          <Field label="이름(담당자)" required htmlFor="ab-name"><Input id="ab-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="예: 홍길동" /></Field>
          <Field label="소속(회사)" htmlFor="ab-org"><Input id="ab-org" value={form.org} onChange={(e) => setForm((f) => ({ ...f, org: e.target.value }))} placeholder="예: ○○물산" /></Field>
          <Field label="메모" htmlFor="ab-memo"><Input id="ab-memo" value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} placeholder="예: 주거래 협력사" /></Field>
        </div>
      </Modal>
    </AdminLayout>
  );
}
