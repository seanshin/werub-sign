'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import { useEffect, useRef } from 'react';
import { apiBaseUrl, authHeaders } from '@/lib/api';

export interface RealtimeEvent {
  type: string; // request.changed 등
  requestId?: string;
  status?: string;
  at?: string;
}

/**
 * 실시간 이벤트 구독(SSE) — 서버 push로 콘솔 자동 갱신(수동 새로고침 불요).
 * fetch 기반(EventSource는 인증 헤더 미지원) + 자동 재연결(지수 backoff).
 * 세션/기계키 인증이 있을 때만 연결. 미연결(프록시 버퍼링 등) 시 기존 수동 새로고침으로 폴백(무해).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function useRealtime(onEvent: (e: RealtimeEvent) => void, enabled = true): void {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    if (!sessionStorage.getItem('sign_session_token') && !sessionStorage.getItem('sign_api_key')) return;

    let aborted = false;
    let ctrl: AbortController | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      if (aborted) return;
      ctrl = new AbortController();
      try {
        const res = await fetch(`${apiBaseUrl()}/v1/events/stream`, { headers: authHeaders(), signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
        retry = 0;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try { const e = JSON.parse(line.slice(6)) as RealtimeEvent; if (e?.type) cbRef.current(e); } catch { /* 무시 */ }
            }
          }
        }
      } catch { /* 네트워크/중단 — 재연결 */ }
      if (aborted) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(connect, 1000 * retry); // 1s,2s,…,6s backoff
    };
    void connect();

    return () => { aborted = true; ctrl?.abort(); if (timer) clearTimeout(timer); };
  }, [enabled]);
}
