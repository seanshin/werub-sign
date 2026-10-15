'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 비활동(idle) 자동 로그아웃 훅 — EMR 보안성 F004(미사용 접속차단) 대응.
 *
 * 일정 시간 사용자 입력(마우스·키보드·스크롤·터치)이 없으면 세션을 종료한다.
 * 만료 직전 경고 모달(카운트다운)을 띄워 사용자가 "계속 사용"으로 연장할 수 있게 한다.
 * 절대 만료(absoluteExpiry, 서버 세션 토큰 exp)도 함께 감시 — 둘 중 먼저 도래하는 시점에 로그아웃.
 *
 * 무상태 토큰이라 서버는 절대 만료만 강제하므로, idle 차단은 클라이언트가 담당한다.
 * sessionStorage 기반이라 탭별로 독립 적용된다(콘솔은 통상 단일 탭 운영).
 *
 * 백그라운드 탭 보정: 브라우저가 백그라운드 탭의 setInterval 을 늦추거나 정지시키므로,
 * 탭이 다시 보일 때(visibilitychange·focus) 즉시 idle 을 재검사한다 — 복귀 시 mousemove 가
 * 활동시각을 리셋하기 전에 동작하므로, 백그라운드 동안 경과한 idle 도 놓치지 않는다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click', 'wheel'] as const;
const THROTTLE_MS = 1_000; // 활동 이벤트 처리 throttle(과도한 갱신 방지)
const TICK_MS = 1_000; // idle 점검 주기

export interface IdleLogoutOptions {
  /** 비활동 허용 시간(ms). 0 이하면 idle 차단 비활성(절대 만료만 적용). */
  idleMs: number;
  /** 만료 전 경고 카운트다운 시간(ms). idleMs보다 작아야 의미 있음. */
  warningMs: number;
  /** 절대 만료 시각(epoch ms). 지정 시 이 시각에도 로그아웃. */
  absoluteExpiry?: number | null;
  /** 활성화 여부(인증 상태일 때만 true). */
  enabled: boolean;
  /** 로그아웃 트리거. reason: timeout=비활동 / expired=절대 만료. */
  onLogout: (reason: 'timeout' | 'expired') => void;
}

export interface IdleLogoutState {
  /** 경고 표시 중 남은 초(정수). null=경고 미표시. */
  warnSecondsLeft: number | null;
  /** "계속 사용" — 타이머 리셋(경고 해제). */
  extend: () => void;
}

export function useIdleLogout(opts: IdleLogoutOptions): IdleLogoutState {
  const { idleMs, warningMs, absoluteExpiry, enabled, onLogout } = opts;
  const lastActivityRef = useRef<number>(Date.now());
  const lastThrottleRef = useRef<number>(0);
  const firedRef = useRef<boolean>(false); // 중복 로그아웃 방지
  const onLogoutRef = useRef(onLogout);
  onLogoutRef.current = onLogout;
  const [warnSecondsLeft, setWarnSecondsLeft] = useState<number | null>(null);

  const extend = useCallback(() => {
    lastActivityRef.current = Date.now();
    setWarnSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setWarnSecondsLeft(null);
      return;
    }
    firedRef.current = false;
    lastActivityRef.current = Date.now();

    const onActivity = () => {
      const now = Date.now();
      if (now - lastThrottleRef.current < THROTTLE_MS) return;
      lastThrottleRef.current = now;
      lastActivityRef.current = now;
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const tick = () => {
      if (firedRef.current) return;
      const now = Date.now();

      // 절대 만료(서버 토큰 exp) 우선 — 만료 후 호출은 어차피 401
      if (absoluteExpiry && now >= absoluteExpiry) {
        firedRef.current = true;
        setWarnSecondsLeft(null);
        onLogoutRef.current('expired');
        return;
      }

      if (idleMs <= 0) return; // idle 차단 비활성
      const idleFor = now - lastActivityRef.current;
      if (idleFor >= idleMs) {
        firedRef.current = true;
        setWarnSecondsLeft(null);
        onLogoutRef.current('timeout');
        return;
      }
      const remaining = idleMs - idleFor;
      if (remaining <= warningMs) {
        setWarnSecondsLeft(Math.max(1, Math.ceil(remaining / 1000)));
      } else {
        setWarnSecondsLeft((prev) => (prev === null ? prev : null));
      }
    };

    // 탭 복귀 시 즉시 재검사(백그라운드 타이머 정지 보정) — mousemove 가 리셋하기 전에 동작.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    const timer = window.setInterval(tick, TICK_MS);
    tick();

    return () => {
      window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, idleMs, warningMs, absoluteExpiry]);

  return { warnSecondsLeft, extend };
}
