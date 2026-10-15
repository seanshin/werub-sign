'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 공용 모달 — ESC/배경 클릭 닫기·포커스 트랩. 파괴적 액션 확인 등에 사용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useEffect, useRef } from 'react';
import styles from './Modal.module.css';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 접근성: 진입 시 첫 포커스·복귀 — open 전환 시 1회만(입력마다 리렌더돼도 포커스 안 뺏김).
  // ⚠️ onClose 를 deps 에 넣으면 인라인 콜백이 매 렌더 새 참조라 이펙트가 재실행→포커스가 ✕로 튐. 분리.
  useEffect(() => {
    if (!open) return;
    const prevFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
    // 첫 입력 우선(닫기 ✕ 는 건너뜀) → 없으면 첫 포커스 요소 → 없으면 다이얼로그
    const target = focusables.find((el) => el.getAttribute('aria-label') !== '닫기') ?? focusables[0] ?? dialog;
    target?.focus();
    return () => { prevFocused?.focus?.(); }; // 닫을 때 포커스 복귀
  }, [open]);

  // Esc 닫기 + Tab 순환 트랩 — onClose 최신값 반영(포커스 재설정 없음이라 재실행돼도 무해).
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) { e.preventDefault(); return; }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !dialog?.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} ref={dialogRef} tabIndex={-1}>
        <div className={styles.header}>
          <h2 id="modal-title" className={styles.title}>{title}</h2>
          <button
            className={styles.close}
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
