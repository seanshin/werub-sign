'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 사용자 관리(RBAC, C-4) — 콘솔 계정 생성·역할(admin/operator/viewer) 변경·비활성.
 * 기계 소비자 키와 별개 축(사람 계정). 변경은 admin:users 감사 스트림에 봉인된다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useCallback, useEffect, useState } from 'react';
import { usersApi } from '@/lib/api';
import { AdminUser, AdminRole, ApiError } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';

const ROLE_LABEL: Record<AdminRole, string> = { admin: '관리자', operator: '운영자', viewer: '열람자' };
const ROLES: AdminRole[] = ['admin', 'operator', 'viewer'];

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 12px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)', verticalAlign: 'middle' };
const selectStyle: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--color-border)' };

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [success, setSuccess] = useState('');

  // 생성 폼
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<AdminRole>('operator');
  const [newEmail, setNewEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [emailEdit, setEmailEdit] = useState<string | null>(null); // 이메일 수정 대상 username
  const [emailVal, setEmailVal] = useState('');

  // 비밀번호 재설정 모달
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      setUsers(await usersApi.list());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setForbidden(true);
      else setError(e instanceof Error ? e.message : '사용자 목록 조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || newPassword.length < 8) {
      setError('아이디와 8자 이상 비밀번호를 입력하세요.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      await usersApi.create({ username: newUsername.trim(), password: newPassword, role: newRole, email: newEmail.trim() || undefined });
      setSuccess(`계정 생성: ${newUsername.trim()} (${ROLE_LABEL[newRole]})`);
      setNewUsername(''); setNewPassword(''); setNewRole('operator'); setNewEmail('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '계정 생성 실패');
    } finally {
      setCreating(false);
    }
  }, [newUsername, newPassword, newRole, newEmail, load]);

  const saveEmail = useCallback(async (username: string) => {
    setError(''); setSuccess('');
    try {
      await usersApi.update(username, { email: emailVal.trim() });
      setSuccess(`${username} 이메일 ${emailVal.trim() ? '설정' : '제거'} 완료`);
      setEmailEdit(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '이메일 변경 실패'); }
  }, [emailVal, load]);

  const changeRole = useCallback(async (username: string, role: AdminRole) => {
    setError(''); setSuccess('');
    try {
      await usersApi.update(username, { role });
      setSuccess(`${username} 역할 → ${ROLE_LABEL[role]}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '역할 변경 실패');
      await load();
    }
  }, [load]);

  const toggleStatus = useCallback(async (u: AdminUser) => {
    setError(''); setSuccess('');
    const next = u.status === 'active' ? 'disabled' : 'active';
    try {
      await usersApi.update(u.username, { status: next });
      setSuccess(`${u.username} → ${next === 'active' ? '활성화' : '비활성화'}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '상태 변경 실패');
    }
  }, [load]);

  const submitReset = useCallback(async () => {
    if (!resetTarget || resetPw.length < 8) { setResetErr('8자 이상 비밀번호를 입력하세요.'); return; }
    setResetBusy(true); setResetErr('');
    try {
      await usersApi.resetPassword(resetTarget, resetPw);
      setSuccess(`${resetTarget} 비밀번호 재설정 완료`);
      setResetTarget(null); setResetPw('');
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : '재설정 실패');
    } finally {
      setResetBusy(false);
    }
  }, [resetTarget, resetPw]);

  return (
    <AdminLayout title="사용자 관리">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {forbidden && (
          <div role="alert" style={{ padding: 16, borderRadius: 8, background: 'var(--color-warning-bg, #fffbeb)', border: '1px solid var(--color-warning-border, #fde68a)', fontSize: 14 }}>
            <strong>권한이 필요합니다 (users:admin).</strong><br />
            관리자(admin) 계정 또는 sign-admin break-glass 키로 로그인하세요.
          </div>
        )}
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {success && <Alert type="success" message={success} onClose={() => setSuccess('')} />}

        {!forbidden && (
          <>
            {/* 계정 생성 */}
            <Card>
              <CardHeader title="새 관리자 계정" description="역할: 관리자(전권)·운영자(서명/인증서)·열람자(읽기 전용)" />
              <CardBody>
                <form onSubmit={handleCreate} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div style={{ flex: '1 1 180px' }}>
                    <Field label="아이디" htmlFor="nu">
                      <Input id="nu" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="영숫자.-_ 3~40자" autoComplete="off" />
                    </Field>
                  </div>
                  <div style={{ flex: '1 1 180px' }}>
                    <Field label="비밀번호" htmlFor="np" hint="8자 이상">
                      <Input id="np" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="초기 비밀번호" autoComplete="new-password" />
                    </Field>
                  </div>
                  <div style={{ flex: '1 1 200px' }}>
                    <Field label="이메일(선택)" htmlFor="ne" hint="계약 내부 서명자 알림·식별용">
                      <Input id="ne" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.org" autoComplete="off" />
                    </Field>
                  </div>
                  <div style={{ flex: '0 1 140px' }}>
                    <Field label="역할" htmlFor="nr">
                      <select id="nr" value={newRole} onChange={(e) => setNewRole(e.target.value as AdminRole)} style={{ ...selectStyle, width: '100%' }}>
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </Field>
                  </div>
                  {/* 라벨 없는 버튼을 입력칸 높이에 맞춤 — Field 라벨과 동일 토큰의 숨김 라벨(정렬용) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <span aria-hidden style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', visibility: 'hidden', userSelect: 'none' }}>&nbsp;</span>
                    <Button type="submit" loading={creating}>계정 생성</Button>
                  </div>
                </form>
              </CardBody>
            </Card>

            {/* 목록 */}
            {loading && !users && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={32} /></div>}
            {users && (
              <Card>
                <CardHeader title={`관리자 계정 (${users.length})`} actions={<Button variant="ghost" size="sm" onClick={load} loading={loading}>새로고침</Button>} />
                <CardBody>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                      <thead>
                        <tr>
                          <th style={th}>아이디</th>
                          <th style={th}>이메일</th>
                          <th style={th}>역할</th>
                          <th style={th}>상태</th>
                          <th style={th}>마지막 로그인</th>
                          <th style={th}>작업</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.length === 0 && <tr><td style={td} colSpan={6}>계정이 없습니다.</td></tr>}
                        {users.map((u) => (
                          <tr key={u.username} style={u.status === 'disabled' ? { opacity: 0.55 } : undefined}>
                            <td style={td}><code style={{ fontSize: 13 }}>{u.username}</code></td>
                            <td style={td}>
                              {emailEdit === u.username ? (
                                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                                  <Input value={emailVal} onChange={(e) => setEmailVal(e.target.value)} placeholder="user@example.org" type="email" style={{ width: 180, fontSize: 12 }} aria-label={`${u.username} 이메일`} />
                                  <Button size="sm" variant="ghost" onClick={() => saveEmail(u.username)}>저장</Button>
                                  <Button size="sm" variant="ghost" onClick={() => setEmailEdit(null)}>취소</Button>
                                </span>
                              ) : (
                                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                  <span style={{ fontSize: 13, fontFamily: 'var(--font-mono, monospace)', color: u.email ? 'var(--color-text)' : 'var(--color-text-muted)' }}>{u.email ?? '—'}</span>
                                  <Button size="sm" variant="ghost" onClick={() => { setEmailEdit(u.username); setEmailVal(u.email ?? ''); }} aria-label={`${u.username} 이메일 수정`}>{u.email ? '변경' : '추가'}</Button>
                                </span>
                              )}
                            </td>
                            <td style={td}>
                              <select value={u.role} onChange={(e) => changeRole(u.username, e.target.value as AdminRole)} style={selectStyle} aria-label={`${u.username} 역할`}>
                                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                              </select>
                            </td>
                            <td style={td}>
                              <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: u.status === 'active' ? 'var(--color-success-bg, #ecfdf5)' : 'var(--color-bg-subtle, #f1f5f9)', color: u.status === 'active' ? 'var(--color-success-text, #047857)' : 'var(--color-text-secondary)' }}>
                                {u.status === 'active' ? '활성' : '비활성'}
                              </span>
                            </td>
                            <td style={td}><span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</span></td>
                            <td style={td}>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <Button size="sm" variant="ghost" onClick={() => { setResetTarget(u.username); setResetPw(''); setResetErr(''); }}>비밀번호 재설정</Button>
                                <Button size="sm" variant={u.status === 'active' ? 'danger' : 'ghost'} onClick={() => toggleStatus(u)}>
                                  {u.status === 'active' ? '비활성화' : '활성화'}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            )}
          </>
        )}
      </div>

      {resetTarget && (
        <Modal
          open
          onClose={() => setResetTarget(null)}
          title={`비밀번호 재설정: ${resetTarget}`}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" size="sm" onClick={() => setResetTarget(null)} disabled={resetBusy}>닫기</Button>
              <Button size="sm" onClick={submitReset} loading={resetBusy} disabled={resetPw.length < 8}>재설정</Button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {resetErr && <Alert type="error" message={resetErr} onClose={() => setResetErr('')} />}
            <Field label="새 비밀번호" htmlFor="rpw" hint="8자 이상 — 대상 사용자에게 안전 채널로 전달">
              <Input id="rpw" type="password" value={resetPw} onChange={(e) => setResetPw(e.target.value)} placeholder="새 비밀번호" autoComplete="new-password" />
            </Field>
          </div>
        </Modal>
      )}
    </AdminLayout>
  );
}
