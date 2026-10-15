'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 폼 필드 래퍼 — label·오류 메시지·도움말을 input 과 접근성 연결(htmlFor/aria).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React from 'react';
import styles from './Field.module.css';

interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, required, error, hint, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required && <span className={styles.required} aria-hidden="true">*</span>}
      </label>
      {children}
      {error && (
        <p className={styles.error} role="alert" aria-live="polite">
          {error}
        </p>
      )}
      {hint && !error && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  hasError?: boolean;
}

export function Input({ hasError, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={[styles.input, hasError ? styles.hasError : '', className].filter(Boolean).join(' ')}
    />
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  hasError?: boolean;
  children: React.ReactNode;
}

export function Select({ hasError, className, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      className={[styles.input, hasError ? styles.hasError : '', className].filter(Boolean).join(' ')}
    >
      {children}
    </select>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  hasError?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ hasError, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      {...rest}
      className={[styles.input, styles.textarea, hasError ? styles.hasError : '', className].filter(Boolean).join(' ')}
    />
  );
});
