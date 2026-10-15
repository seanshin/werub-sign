'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import type { PlacedMark, FieldValueType } from '@/types/api';
import { FIELD_TYPE_LABEL, FIELD_TYPE_OPTIONS } from '@/lib/field-type';

/**
 * PDF 배치 편집기 — 서명란·입력란을 PDF 미리보기 위에서 직접 배치(서명자별).
 *  - 추가: 팔레트에서 종류 선택 → 페이지 위 원하는 곳 클릭(placing 모드, Esc 취소)
 *  - 이동: 드래그 / 방향키(0.5%씩) · 크기: 우하단 핸들 드래그 / Shift+방향키 · 삭제: ✕ / Delete
 *  - 좌표는 페이지 상대(0..1, y=상단 기준) — 서버(compose/stamp)가 동일 좌표계로 렌더
 * pdf.js 는 클라이언트 동적 로드(워커 /pdf.worker.min.mjs — public 에 버전 고정 복사본).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface EditorSigner { order: number; displayName: string; kind: 'INTERNAL' | 'EXTERNAL' }

const COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
const colorOf = (signer: number) => COLORS[(signer - 1) % COLORS.length];
const DEFAULT_SIZE: Record<PlacedMark['type'], { w: number; h: number }> = {
  SIGN: { w: 0.4, h: 0.075 },
  FIELD: { w: 0.42, h: 0.038 },
};

type Placing = { type: PlacedMark['type']; label?: string; fieldType?: FieldValueType } | null;

export function PdfMarkEditor({ pdfBytes, signers, marks, onChange, maxWidth = 860 }: {
  pdfBytes: ArrayBuffer | null;
  signers: EditorSigner[];
  marks: PlacedMark[];
  onChange: (marks: PlacedMark[]) => void;
  maxWidth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signer, setSigner] = useState(1);
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldType, setFieldType] = useState<FieldValueType>('text'); // 입력란 값 타입(A4 고도화)
  const [zoom, setZoom] = useState(1); // 0.6 ~ 2.0
  const [placing, setPlacing] = useState<Placing>(null);
  const [selected, setSelected] = useState<number | null>(null); // marks 인덱스
  const dragRef = useRef<{ idx: number; mode: 'move' | 'resize'; startX: number; startY: number; orig: PlacedMark } | null>(null);

  // 문서 로드
  useEffect(() => {
    let cancelled = false;
    if (!pdfBytes) { docRef.current = null; setPageCount(0); return; }
    setLoading(true); setError('');
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const doc = await pdfjs.getDocument({ data: pdfBytes.slice(0) }).promise;
        if (cancelled) return;
        docRef.current = doc as unknown as { numPages: number; getPage: (n: number) => Promise<unknown> };
        setPageCount(doc.numPages);
        setPage((p) => Math.min(p, doc.numPages) || 1);
      } catch {
        if (!cancelled) setError('PDF 를 불러오지 못했습니다');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfBytes]);

  // 페이지 렌더
  const renderPage = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || pageCount === 0) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = await doc.getPage(page);
      const parentW = canvas.parentElement?.parentElement?.clientWidth ?? 800; // 스크롤 래퍼 기준
      const containerW = Math.min(parentW, maxWidth) * zoom;
      const base = p.getViewport({ scale: 1 });
      const scale = containerW / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.getViewport({ scale: scale * dpr });
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = `${vp.width / dpr}px`;
      canvas.style.height = `${vp.height / dpr}px`;
      renderTaskRef.current?.cancel();
      const task = p.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      renderTaskRef.current = task;
      await task.promise.catch(() => undefined); // 취소 무해
    } catch { /* 페이지 전환 중 취소 등 */ }
  }, [page, pageCount, zoom, maxWidth]);
  useEffect(() => { void renderPage(); }, [renderPage]);

  // 좌표 변환 — 오버레이 픽셀 → 페이지 상대(0..1)
  const toRel = (clientX: number, clientY: number) => {
    const el = overlayRef.current!;
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };
  const clampMark = (m: PlacedMark): PlacedMark => ({
    ...m,
    w: Math.min(0.95, Math.max(0.05, m.w)),
    h: Math.min(0.5, Math.max(0.02, m.h)),
    x: Math.min(1 - Math.min(0.95, Math.max(0.05, m.w)), Math.max(0, m.x)),
    y: Math.min(1 - Math.min(0.5, Math.max(0.02, m.h)), Math.max(0, m.y)),
  });

  // placing 모드 — 페이지 클릭으로 배치
  const onOverlayClick = (e: React.MouseEvent) => {
    if (!placing) { setSelected(null); return; }
    const { x, y } = toRel(e.clientX, e.clientY);
    const size = DEFAULT_SIZE[placing.type];
    const mark = clampMark({ page, x: x - size.w / 2, y: y - size.h / 2, ...size, signer, type: placing.type, label: placing.label, ...(placing.type === 'FIELD' ? { fieldType: placing.fieldType ?? 'text' } : {}) });
    onChange([...marks, mark]);
    setSelected(marks.length);
    setPlacing(null);
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlacing(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  // 드래그(이동·리사이즈)
  const startDrag = (e: React.PointerEvent, idx: number, mode: 'move' | 'resize') => {
    e.stopPropagation(); e.preventDefault();
    setSelected(idx);
    dragRef.current = { idx, mode, startX: e.clientX, startY: e.clientY, orig: marks[idx] };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const el = overlayRef.current!;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / r.width;
    const dy = (e.clientY - d.startY) / r.height;
    const next = [...marks];
    next[d.idx] = clampMark(d.mode === 'move'
      ? { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }
      : { ...d.orig, w: d.orig.w + dx, h: d.orig.h + dy });
    onChange(next);
  };
  const endDrag = () => { dragRef.current = null; };

  // 키보드 — 이동/리사이즈/삭제
  const onBoxKey = (e: React.KeyboardEvent, idx: number) => {
    const step = 0.005;
    const m = marks[idx];
    let next: PlacedMark | null = null;
    if (e.key === 'Delete' || e.key === 'Backspace') { onChange(marks.filter((_, i) => i !== idx)); setSelected(null); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') next = e.shiftKey ? { ...m, w: m.w - step } : { ...m, x: m.x - step };
    if (e.key === 'ArrowRight') next = e.shiftKey ? { ...m, w: m.w + step } : { ...m, x: m.x + step };
    if (e.key === 'ArrowUp') next = e.shiftKey ? { ...m, h: m.h - step } : { ...m, y: m.y - step };
    if (e.key === 'ArrowDown') next = e.shiftKey ? { ...m, h: m.h + step } : { ...m, y: m.y + step };
    if (next) { const arr = [...marks]; arr[idx] = clampMark(next); onChange(arr); e.preventDefault(); }
  };

  const remove = (idx: number) => { onChange(marks.filter((_, i) => i !== idx)); setSelected(null); };
  const signerName = (n: number) => signers[n - 1]?.displayName?.trim() || `${n}번 서명자`;
  const pageMarks = marks.map((m, i) => ({ m, i })).filter(({ m }) => m.page === page);

  if (!pdfBytes) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 팔레트 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-secondary,#f8fafc)' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>배치:</span>
        {signers.map((s, i) => (
          <button
            key={i}
            onClick={() => setSigner(i + 1)}
            aria-pressed={signer === i + 1}
            aria-label={`${i + 1}번 서명자 ${signerName(i + 1)} 선택`}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 13, border: signer === i + 1 ? `2px solid ${colorOf(i + 1)}` : '1px solid var(--color-border)', background: signer === i + 1 ? `${colorOf(i + 1)}18` : 'transparent', color: 'var(--color-text)' }}
          >
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: colorOf(i + 1) }} />
            {signerName(i + 1)}
          </button>
        ))}
        <Button size="sm" variant={placing?.type === 'SIGN' ? 'primary' : 'ghost'} onClick={() => setPlacing(placing?.type === 'SIGN' ? null : { type: 'SIGN' })}>
          ✍ 서명란 {placing?.type === 'SIGN' ? '— 배치할 위치 클릭' : '추가'}
        </Button>
        <Input value={fieldLabel} onChange={(e) => setFieldLabel(e.target.value)} placeholder="입력란 라벨" aria-label="입력란 라벨(배치)" style={{ width: 120 }} />
        <select
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value as FieldValueType)}
          aria-label="입력란 타입(배치)"
          style={{ padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 13, background: 'var(--color-bg)', color: 'var(--color-text)' }}
        >
          {FIELD_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button size="sm" variant={placing?.type === 'FIELD' ? 'primary' : 'ghost'} onClick={() => setPlacing(placing?.type === 'FIELD' ? null : { type: 'FIELD', label: fieldLabel.trim() || '기재란', fieldType })}>
          ␣ 입력란 {placing?.type === 'FIELD' ? '— 배치할 위치 클릭' : '추가'}
        </Button>
        {placing && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>페이지에서 원하는 위치를 클릭하세요 (Esc 취소)</span>}
      </div>

      {/* 페이지 네비게이션 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="이전 페이지">◀</Button>
        <span style={{ fontSize: 13 }}>{page} / {pageCount || '-'} 페이지</span>
        <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount} aria-label="다음 페이지">▶</Button>
        <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>|</span>
        <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.2) * 10) / 10))} disabled={zoom <= 0.6} aria-label="축소">−</Button>
        <span style={{ fontSize: 13, minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.2) * 10) / 10))} disabled={zoom >= 2} aria-label="확대">＋</Button>
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>박스 드래그=이동 · 모서리=크기 · 방향키=미세 이동(Shift=크기) · Delete=삭제</span>
        {error && <span style={{ color: 'var(--color-danger,#dc2626)', fontSize: 13 }}>{error}</span>}
        {loading && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>불러오는 중…</span>}
      </div>

      {/* 캔버스 + 오버레이 (확대 시 스크롤 — 키보드 접근 가능 영역) */}
      <div tabIndex={0} role="region" aria-label="문서 미리보기 스크롤 영역" style={{ overflow: 'auto', maxHeight: '72vh', border: '1px solid var(--color-border)', borderRadius: 8, background: '#525659' }}>
      <div style={{ position: 'relative', width: 'fit-content' }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div
          ref={overlayRef}
          onClick={onOverlayClick}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          style={{ position: 'absolute', inset: 0, cursor: placing ? 'crosshair' : 'default' }}
          role="application"
          aria-label="서명란·입력란 배치 영역"
        >
          {pageMarks.map(({ m, i }) => (
            <div
              key={i}
              tabIndex={0}
              role="button"
              aria-label={`${m.type === 'SIGN' ? '서명란' : `입력란(${m.label ?? '기재란'} · ${FIELD_TYPE_LABEL[m.fieldType ?? 'text']})`} — ${signerName(m.signer)}. 방향키로 이동, Delete 로 삭제`}
              onPointerDown={(e) => startDrag(e, i, 'move')}
              onKeyDown={(e) => onBoxKey(e, i)}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`,
                border: `2px ${selected === i ? 'solid' : 'dashed'} ${colorOf(m.signer)}`,
                background: `${colorOf(m.signer)}1f`,
                borderRadius: 4, cursor: 'move', boxSizing: 'border-box',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4, padding: '2px 4px',
                fontSize: 11, color: colorOf(m.signer), fontWeight: 600, userSelect: 'none',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.type === 'SIGN' ? '✍ 서명란' : `␣ ${m.label ?? '기재란'}${(m.fieldType ?? 'text') !== 'text' ? `(${FIELD_TYPE_LABEL[m.fieldType ?? 'text']})` : ''}`} · {signerName(m.signer)}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); remove(i); }}
                aria-label="이 배치 삭제"
                style={{ border: 'none', background: colorOf(m.signer), color: '#fff', borderRadius: 3, width: 16, height: 16, lineHeight: '14px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}
              >×</button>
              <span
                onPointerDown={(e) => startDrag(e, i, 'resize')}
                aria-hidden="true"
                style={{ position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, cursor: 'nwse-resize', background: colorOf(m.signer), borderRadius: '3px 0 3px 0' }}
              />
            </div>
          ))}
        </div>
      </div>
      </div>
      {marks.length > 0 && (
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          배치 {marks.length}개{pageCount > 1 ? ` (현재 페이지 ${pageMarks.length}개)` : ''} — 최종 PDF 에 서명란·입력란 박스로 표시됩니다
        </span>
      )}
    </div>
  );
}

/** 전체화면 배치 모달 — 좁은 카드 대신 화면 전체에서 크게 보고 배치(닫기=[배치 완료], Esc는 placing 취소용이라 미사용). */
export function PdfPlacementModal({ open, onClose, title, ...editorProps }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  pdfBytes: ArrayBuffer | null;
  signers: EditorSigner[];
  marks: PlacedMark[];
  onChange: (marks: PlacedMark[]) => void;
}) {
  // 열림 동안 바디 스크롤 잠금
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title ?? '서명란·입력란 배치'} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(1240px, 98vw)', height: '94vh', background: 'var(--color-bg, #fff)', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--color-border)' }}>
          <strong style={{ fontSize: 16 }}>{title ?? '서명란·입력란 배치'}</strong>
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>배치 {editorProps.marks.length}개</span>
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="primary" size="sm" onClick={onClose}>배치 완료</Button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <PdfMarkEditor {...editorProps} maxWidth={1160} />
        </div>
      </div>
    </div>
  );
}
