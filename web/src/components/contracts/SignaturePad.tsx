'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * 손글씨 서명 패드 — 마우스/터치(태블릿·패드)로 사인을 그리고 PNG(data URL)로 반환.
 * PKI 실서명이 법적 효력을 담당하고, 이 이미지는 서명 행위의 시각 증거로 함께 기록된다.
 * onChange(null) = 비어 있음(미서명). 지우기/다시 그리기 지원.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function SignaturePad({ onChange, height = 160, label = '아래 칸에 서명해 주세요 (마우스·터치)' }: {
  onChange: (dataUrl: string | null) => void;
  height?: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.parentElement?.clientWidth ?? 400;
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e293b';
  }, [height]);

  useEffect(() => { setup(); }, [setup]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    drawing.current = true;
    last.current = pos(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!dirty.current) { dirty.current = true; setEmpty(false); }
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(canvasRef.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    setEmpty(true);
    onChange(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{label}</span>
      <div style={{ position: 'relative', border: '1px dashed var(--color-border)', borderRadius: 8, background: '#fff', touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          style={{ display: 'block', cursor: 'crosshair', borderRadius: 8 }}
          aria-label="손글씨 서명 입력 영역"
        />
        {empty && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 14, pointerEvents: 'none' }}>여기에 서명</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button size="sm" variant="ghost" onClick={clear} disabled={empty}>지우기</Button>
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{empty ? '아직 서명하지 않았습니다' : '서명이 입력되었습니다'}</span>
      </div>
    </div>
  );
}
