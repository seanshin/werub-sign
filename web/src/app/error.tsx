'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * 전역 에러 바운더리 — 예기치 못한 렌더 오류 시 친절한 폴백(흰 화면 방지).
 * App Router가 라우트 하위 트리 렌더 오류를 잡아 표시. reset()으로 재시도.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 콘솔 기록(외부 수집 연동 시 여기서 리포트). 민감정보 미포함.
    console.error('[sign] 렌더 오류:', error?.message, error?.digest ?? '');
  }, [error]);

  return (
    <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 'var(--space-3)' }} aria-hidden="true">⚠️</div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text-primary)', margin: 0 }}>
          일시적인 오류가 발생했습니다
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: 'var(--space-3) 0 var(--space-6)' }}>
          화면을 다시 시도하거나, 문제가 지속되면 관리자에게 문의해 주세요.
          {error?.digest && <><br /><span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>오류 코드: {error.digest}</span></>}
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
          <Button onClick={() => reset()}>다시 시도</Button>
          <Button variant="ghost" onClick={() => { window.location.href = '/admin'; }}>대시보드로</Button>
        </div>
      </div>
    </div>
  );
}
