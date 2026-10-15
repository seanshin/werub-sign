'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 토스트 알림 컨텍스트 — 성공/오류 피드백을 화면 우하단에 잠시 표시(useToast()).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { createContext, useCallback, useContext, useState, useEffect } from 'react';
import styles from './Toast.module.css';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const remove = (id: string) => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className={styles.container} role="region" aria-live="polite" aria-label="알림">
        {items.map((item) => (
          <div key={item.id} className={[styles.toast, styles[item.type]].join(' ')} role="alert">
            <span className={styles.message}>{item.message}</span>
            <button className={styles.close} onClick={() => remove(item.id)} aria-label="닫기">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.toast;
}

interface AlertProps {
  type?: ToastType;
  message: string;
  onClose?: () => void;
}

export function Alert({ type = 'info', message, onClose }: AlertProps) {
  return (
    <div className={[styles.toast, styles[type]].join(' ')} role="alert" style={{ maxWidth: '100%', animation: 'none' }}>
      <span className={styles.message}>{message}</span>
      {onClose && (
        <button className={styles.close} onClick={onClose} aria-label="닫기">✕</button>
      )}
    </div>
  );
}
