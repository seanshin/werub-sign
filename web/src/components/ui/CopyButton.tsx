'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 클립보드 복사 버튼 — 복사 후 잠시 "복사됨" 피드백(토큰·URL 공유용).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState } from 'react';
import { Button } from './Button';

interface CopyButtonProps {
  text: string;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function CopyButton({ text, label = '복사', size = 'sm' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <Button variant="ghost" size={size} onClick={handleCopy} aria-label={`${label}: ${text}`}>
      {copied ? '복사됨 ✓' : label}
    </Button>
  );
}
