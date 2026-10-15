'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, authStorage } from '@/lib/api';
import { AdminRole, ApiError } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import QRCode from 'qrcode';

const ROLE_LABEL: Record<AdminRole, string> = { admin: '관리자', operator: '운영자', viewer: '열람자' };

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

/** 등록 QR + 중앙 브랜드 로고(오류정정 H로 가운데 가림 허용). 로고 로드 실패 시 QR만 반환. */
async function qrWithLogo(text: string): Promise<string> {
  const size = 220;
  const base = await QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: 'H' });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return base;
    ctx.drawImage(await loadImg(base), 0, 0, size, size);
    const logo = await loadImg('/mfa-logo.svg');
    const ls = Math.round(size * 0.24);
    const lx = (size - ls) / 2, ly = (size - ls) / 2, pad = 6, r = 8;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(lx - pad, ly - pad, ls + pad * 2, ls + pad * 2, r);
    ctx.fill();
    ctx.drawImage(logo, lx, ly, ls, ls);
    return canvas.toDataURL('image/png');
  } catch {
    return base;
  }
}

export default function AccountPage() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);

  // 알림 이메일(계약 내부 서명자 알림 수신)
  const [email, setEmail] = useState<string>('');
  const [emailInput, setEmailInput] = useState<string>('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState('');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // 자동 로그아웃(비활동) 설정
  const [idleInfo, setIdleInfo] = useState<{ idleTimeoutMin: number; preference: number | null; policyMaxMin: number; maxMin: number; minMin: number; devMode: boolean } | null>(null);
  const [idleSel, setIdleSel] = useState<string>(''); // ''=정책 기본(해제), 그 외=분
  const [idleBusy, setIdleBusy] = useState(false);
  const [idleMsg, setIdleMsg] = useState('');

  // 2차 인증(TOTP)
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [enableCode, setEnableCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState('');

  useEffect(() => {
    setUsername(authStorage.getUsername());
    setRole(authStorage.getRole());
    setScopes(authStorage.getScopes());
    if (authStorage.getRole()) {
      authApi.status2fa().then((s) => setMfaEnabled(s.enabled)).catch(() => setMfaEnabled(false));
      authApi.getIdleTimeout().then((d) => { setIdleInfo(d); setIdleSel(d.preference ? String(d.preference) : ''); }).catch(() => setIdleInfo(null));
      authApi.me().then((m) => { setEmail(m.email ?? ''); setEmailInput(m.email ?? ''); }).catch(() => {});
    }
  }, []);

  const saveEmail = async () => {
    setEmailBusy(true); setEmailMsg('');
    try {
      const r = await authApi.setOwnEmail(emailInput.trim());
      setEmail(r.email ?? ''); setEmailInput(r.email ?? '');
      setEmailMsg(r.email ? `저장됨 — 계약 서명 차례가 되면 ${r.email} 로 알림을 받습니다.` : '이메일을 제거했습니다(콘솔에서만 서명 안내).');
    } catch (e) { setEmailMsg(e instanceof ApiError ? e.message : '저장 실패'); }
    finally { setEmailBusy(false); }
  };

  const saveIdle = async () => {
    setIdleBusy(true); setIdleMsg('');
    try {
      const minutes = idleSel === '' ? null : Number(idleSel);
      const r = await authApi.setIdleTimeout(minutes);
      authStorage.setIdleTimeoutMin(r.idleTimeoutMin); // 클라 경고 타이머 갱신(화면 이동 시 반영)
      setIdleInfo((p) => (p ? { ...p, idleTimeoutMin: r.idleTimeoutMin, preference: r.preference } : p));
      setIdleMsg(`적용됨 — 자동 로그아웃 ${r.idleTimeoutMin}분${r.preference === null ? '(조직 정책 기본)' : ''}. 서버가 즉시 강제합니다.`);
    } catch (e) { setIdleMsg(e instanceof ApiError ? e.message : '설정 실패'); }
    finally { setIdleBusy(false); }
  };

  const startSetup = async () => {
    setMfaBusy(true); setMfaError('');
    try {
      const d = await authApi.setup2fa();
      setSetupData(d);
      setQr(await qrWithLogo(d.otpauthUri));
    } catch (e) { setMfaError(e instanceof ApiError ? e.message : '설정 시작 실패'); }
    finally { setMfaBusy(false); }
  };
  const confirmEnable = async () => {
    setMfaBusy(true); setMfaError('');
    try {
      const r = await authApi.enable2fa(enableCode.trim());
      setRecovery(r.recoveryCodes); setMfaEnabled(true); setSetupData(null); setQr(''); setEnableCode('');
    } catch (e) { setMfaError(e instanceof ApiError ? e.message : '활성화 실패 — 코드를 확인하세요'); }
    finally { setMfaBusy(false); }
  };
  const disableMfa = async () => {
    setMfaBusy(true); setMfaError('');
    try {
      await authApi.disable2fa(disableCode.trim());
      setMfaEnabled(false); setDisableCode(''); setRecovery(null);
    } catch (e) { setMfaError(e instanceof ApiError ? e.message : '해제 실패 — 코드를 확인하세요'); }
    finally { setMfaBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) { setError('새 비밀번호는 8자 이상이어야 합니다.'); return; }
    if (next !== confirm) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      await authApi.changePassword(current, next);
      setSuccess('비밀번호가 변경되었습니다. 보안을 위해 다시 로그인해 주세요.');
      setCurrent(''); setNext(''); setConfirm('');
      setTimeout(() => { authStorage.clear(); router.push('/admin/login'); }, 1500);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '비밀번호 변경 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminLayout title="내 계정">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 520 }}>
        <Card>
          <CardHeader title="계정 정보" />
          <CardBody>
            {role ? (
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', margin: 0, fontSize: 14 }}>
                <dt style={{ color: 'var(--color-text-muted)' }}>아이디</dt>
                <dd style={{ margin: 0 }}><code>{username}</code></dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>역할</dt>
                <dd style={{ margin: 0 }}>{ROLE_LABEL[role]}</dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>권한(scope)</dt>
                <dd style={{ margin: 0 }}>{scopes.length ? scopes.join(', ') : '읽기 전용'}</dd>
                <dt style={{ color: 'var(--color-text-muted)' }}>알림 이메일</dt>
                <dd style={{ margin: 0 }}>{email ? <code>{email}</code> : <span style={{ color: 'var(--color-text-muted)' }}>미설정</span>}</dd>
              </dl>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>API 키(break-glass)로 접속 중입니다 — 비밀번호 개념이 없습니다.</p>
            )}
          </CardBody>
        </Card>

        {role && (
          <Card>
            <CardHeader title="알림 이메일" description="계약 서명 차례가 되면 이 이메일로 서명 요청 알림을 받습니다. 로그인 아이디와는 별개입니다." />
            <CardBody>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Field label="이메일" htmlFor="acc-email" hint="비우고 저장하면 알림을 받지 않습니다(콘솔에서만 서명).">
                    <Input id="acc-email" type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="user@example.org" autoComplete="off" />
                  </Field>
                </div>
                <Button variant="primary" onClick={saveEmail} loading={emailBusy} disabled={emailInput.trim() === email.trim()}>저장</Button>
              </div>
              {emailMsg && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 8 }}>{emailMsg}</p>}
            </CardBody>
          </Card>
        )}

        {role && (
          <Card>
            <CardHeader title="비밀번호 변경" />
            <CardBody>
              <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {error && <Alert type="error" message={error} onClose={() => setError('')} />}
                {success && <Alert type="success" message={success} onClose={() => setSuccess('')} />}
                <Field label="현재 비밀번호" htmlFor="cur" required>
                  <Input id="cur" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                </Field>
                <Field label="새 비밀번호" htmlFor="nx" required hint="8자 이상">
                  <Input id="nx" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="새 비밀번호 확인" htmlFor="cf" required>
                  <Input id="cf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </Field>
                <Button type="submit" loading={busy}>변경</Button>
              </form>
            </CardBody>
          </Card>
        )}

        {role && idleInfo && (
          <Card>
            <CardHeader title="자동 로그아웃 (비활동)" description="일정 시간 활동이 없으면 자동 로그아웃됩니다(EMR 보안성 F004). 서버가 강제합니다." />
            <CardBody>
              {idleMsg && <Alert type={idleMsg.startsWith('적용') ? 'success' : 'error'} message={idleMsg} onClose={() => setIdleMsg('')} />}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="자동 로그아웃 시간" htmlFor="idle-min" hint={idleInfo.devMode ? `개발 모드 — 최대 ${idleInfo.maxMin >= 60 ? `${idleInfo.maxMin / 60}시간` : `${idleInfo.maxMin}분`}(실서비스에선 정책 상한만 노출)` : (idleInfo.policyMaxMin > 0 ? `조직 정책 최대 ${idleInfo.policyMaxMin}분 — 더 길게 설정 불가` : '정책상 idle 비활성')}>
                  <Select id="idle-min" value={idleSel} onChange={(e) => setIdleSel(e.target.value)} aria-label="자동 로그아웃 시간">
                    <option value="">조직 정책 기본 ({idleInfo.policyMaxMin > 0 ? `${idleInfo.policyMaxMin}분` : '비활성'})</option>
                    {[1, 5, 10, 15, 30, 60, 120, 240, 480].filter((m) => m >= idleInfo.minMin && m <= idleInfo.maxMin).map((m) => {
                      const dev = idleInfo.devMode && idleInfo.policyMaxMin > 0 && m > idleInfo.policyMaxMin;
                      return <option key={m} value={m}>{m >= 60 ? `${m / 60}시간` : `${m}분`}{dev ? ' · 개발 모드' : ''}</option>;
                    })}
                  </Select>
                </Field>
                <Button size="sm" loading={idleBusy} onClick={saveIdle}>적용</Button>
              </div>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 10 }}>
                현재 적용: <strong>{idleInfo.idleTimeoutMin}분</strong>{idleInfo.preference === null ? ' (조직 정책 기본)' : ' (개인 설정)'}. 짧게만 설정 가능(보안). 다른 화면 이동 시 경고 타이머도 갱신됩니다.
              </p>
            </CardBody>
          </Card>
        )}

        {role && (
          <Card>
            <CardHeader title="2단계 인증 (TOTP)" description="로그인 시 인증앱 6자리 코드를 추가로 요구합니다(강화 인증)." />
            <CardBody>
              {mfaError && <Alert type="error" message={mfaError} onClose={() => setMfaError('')} />}
              {recovery ? (
                <div>
                  <Alert type="success" message="2단계 인증이 활성화되었습니다. 아래 복구코드를 안전한 곳에 보관하세요(각 1회용·기기 분실 시 사용)." />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'var(--font-mono)', margin: '12px 0', padding: 12, background: 'var(--color-bg-tertiary)', borderRadius: 8 }}>
                    {recovery.map((c) => <code key={c}>{c}</code>)}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setRecovery(null)}>확인</Button>
                </div>
              ) : mfaEnabled === null ? (
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>상태 확인 중…</span>
              ) : mfaEnabled ? (
                <div>
                  <p style={{ marginTop: 0 }}>✅ <strong>활성화됨</strong> — 로그인 시 인증앱 코드가 필요합니다.</p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="해제하려면 현재 코드 입력" htmlFor="mfa-dis">
                      <Input id="mfa-dis" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="000000 또는 복구코드" inputMode="numeric" />
                    </Field>
                    <Button variant="danger" size="sm" loading={mfaBusy} onClick={disableMfa}>2단계 인증 해제</Button>
                  </div>
                </div>
              ) : setupData ? (
                <div>
                  <p style={{ marginTop: 0, fontSize: 14 }}>① 인증앱으로 QR 스캔(또는 키 수동 입력) → ② 표시되는 6자리 코드를 입력해 활성화하세요.</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {qr && <img src={qr} alt="2단계 인증 QR 코드" width={200} height={200} style={{ display: 'block', margin: '8px 0', border: '1px solid var(--color-border)', borderRadius: 8 }} />}
                  <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>수동 키: <code style={{ wordBreak: 'break-all' }}>{setupData.secret}</code></p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="인증앱 6자리 코드" htmlFor="mfa-en">
                      <Input id="mfa-en" value={enableCode} onChange={(e) => setEnableCode(e.target.value)} placeholder="000000" inputMode="numeric" autoFocus />
                    </Field>
                    <Button size="sm" loading={mfaBusy} onClick={confirmEnable}>활성화</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setSetupData(null); setQr(''); }}>취소</Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ marginTop: 0, color: 'var(--color-text-secondary)', fontSize: 14 }}>인증앱(Google/Naver Authenticator 등)으로 로그인 보안을 강화합니다.</p>
                  <Button size="sm" loading={mfaBusy} onClick={startSetup}>2단계 인증 설정</Button>
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
