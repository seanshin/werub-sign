'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 콘솔 로그인 — username/password + (활성화 시) TOTP 2차 인증. 성공 시 세션 토큰을 저장하고
 * 대시보드로 이동. 세션 만료·자동 로그아웃(reason=timeout) 시 이 화면으로 되돌아온다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, authStorage } from '@/lib/api';
import { ApiError } from '@/types/api';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { APP_VERSION, MAKER } from '@/lib/version';
import styles from './page.module.css';

type Mode = 'user' | 'key';

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('user');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  // 2차 인증(TOTP) 단계
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  // 자동 로그아웃 사유 안내(비활동/세션 만료) — AdminLayout이 ?reason= 으로 리다이렉트
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'timeout') setNotice('장시간 활동이 없어 자동으로 로그아웃되었습니다. 다시 로그인해 주세요.');
    else if (reason === 'expired') setNotice('세션이 만료되어 로그아웃되었습니다. 다시 로그인해 주세요.');
  }, []);

  const handleUserLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('아이디와 비밀번호를 입력해 주세요.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      authStorage.clear();
      const result = await authApi.login(username.trim(), password);
      if ('mfaRequired' in result) {
        // 2차 인증 필요 — 코드 입력 단계로 전환(세션 미발급)
        setMfaToken(result.mfaToken);
        setLoading(false);
        return;
      }
      authStorage.setSession(result);
      router.push('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인에 실패했습니다.');
      setLoading(false);
    }
  };

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaCode.trim()) { setError('인증 코드를 입력해 주세요.'); return; }
    setLoading(true);
    setError('');
    try {
      const session = await authApi.verify2fa(mfaToken, mfaCode.trim());
      authStorage.setSession(session);
      router.push('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '인증에 실패했습니다.');
      setLoading(false);
    }
  };

  const handleKeyLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('API Key를 입력해 주세요.');
      return;
    }
    authStorage.clear();
    authStorage.setApiKey(apiKey.trim());
    if (adminKey.trim()) authStorage.setAdminKey(adminKey.trim());
    router.push('/admin');
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.logo}>
            <span aria-hidden="true">&#9670;</span>
            트러스트 서비스
          </div>
          <p className={styles.subtitle}>의료/IT 전자서명 관리 콘솔</p>
        </div>

        {notice && (
          <div style={{ marginBottom: 16 }}>
            <Alert type="info" message={notice} onClose={() => setNotice('')} />
          </div>
        )}

        <Card>
          {mfaToken ? (
            <form onSubmit={handleMfaVerify}>
              <CardBody>
                <div className={styles.form}>
                  {error && <Alert type="error" message={error} onClose={() => setError('')} />}
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                    인증앱(Google/Naver Authenticator 등)의 <strong>6자리 코드</strong> 또는 복구코드를 입력하세요.
                  </p>
                  <Field label="인증 코드" htmlFor="mfa-code" required>
                    <Input
                      id="mfa-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      placeholder="000000"
                      autoFocus
                      hasError={!!error}
                    />
                  </Field>
                </div>
              </CardBody>
              <CardFooter>
                <div className={styles.footerCol}>
                  <Button type="submit" fullWidth loading={loading}>인증하고 로그인</Button>
                  <button type="button" className={styles.linkBtn} onClick={() => { setMfaToken(''); setMfaCode(''); setError(''); }}>
                    돌아가기
                  </button>
                </div>
              </CardFooter>
            </form>
          ) : mode === 'user' ? (
            <form onSubmit={handleUserLogin}>
              <CardBody>
                <div className={styles.form}>
                  {error && <Alert type="error" message={error} onClose={() => setError('')} />}

                  <Field label="아이디" htmlFor="username" required>
                    <Input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="관리자 아이디"
                      autoComplete="username"
                      hasError={!!error && !username}
                    />
                  </Field>

                  <Field label="비밀번호" htmlFor="password" required>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="비밀번호"
                      autoComplete="current-password"
                      hasError={!!error && !password}
                    />
                  </Field>
                </div>
              </CardBody>
              <CardFooter>
                <div className={styles.footerCol}>
                  <Button type="submit" fullWidth loading={loading}>
                    로그인
                  </Button>
                  <button type="button" className={styles.linkBtn} onClick={() => { setMode('key'); setError(''); }}>
                    고급: API 키로 로그인 (break-glass)
                  </button>
                </div>
              </CardFooter>
            </form>
          ) : (
            <form onSubmit={handleKeyLogin}>
              <CardBody>
                <div className={styles.form}>
                  {error && <Alert type="error" message={error} onClose={() => setError('')} />}

                  <Field
                    label="API Key"
                    htmlFor="apiKey"
                    required
                    hint="x-api-key 헤더로 전송됩니다 (기계/break-glass 키)"
                  >
                    <Input
                      id="apiKey"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="API 키를 입력하세요"
                      autoComplete="off"
                      hasError={!!error && !apiKey}
                    />
                  </Field>

                  <div className={styles.divider}>선택 — CA 관리 기능 사용 시</div>

                  <Field label="Admin Key (CA 전용)" htmlFor="adminKey" hint="scope: ca:admin — CA Issuing 회전 등 고권한 작업">
                    <Input
                      id="adminKey"
                      type="password"
                      value={adminKey}
                      onChange={(e) => setAdminKey(e.target.value)}
                      placeholder="CA Admin 키 (선택)"
                      autoComplete="off"
                    />
                  </Field>
                </div>
              </CardBody>
              <CardFooter>
                <div className={styles.footerCol}>
                  <Button type="submit" fullWidth>
                    로그인
                  </Button>
                  <button type="button" className={styles.linkBtn} onClick={() => { setMode('user'); setError(''); }}>
                    아이디/비밀번호로 로그인
                  </button>
                </div>
              </CardFooter>
            </form>
          )}
        </Card>
        <p className={styles.maker}>sign v{APP_VERSION} · 제작 {MAKER}</p>
      </div>
    </div>
  );
}
