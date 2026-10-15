'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React from 'react';
import styles from './Pagination.module.css';

export interface PaginationProps {
  /**
   * 전체 항목 수
   * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
   */
  total: number;
  /** 현재 오프셋 (0-based) */
  offset: number;
  /** 페이지당 항목 수 */
  limit: number;
  /** 페이지 이동 콜백 — newOffset 전달 */
  onOffsetChange: (newOffset: number) => void;
  /** 페이지 크기 변경 콜백 */
  onLimitChange: (newLimit: number) => void;
  /** 선택 가능한 페이지 크기 목록 (기본: [20, 50, 100]) */
  limitOptions?: number[];
  /** 추가 클래스 */
  className?: string;
}

const DEFAULT_LIMIT_OPTIONS = [20, 50, 100];

export function Pagination({
  total,
  offset,
  limit,
  onOffsetChange,
  onLimitChange,
  limitOptions = DEFAULT_LIMIT_OPTIONS,
  className,
}: PaginationProps) {
  if (total === 0) return null;

  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const handlePrev = () => {
    if (hasPrev) onOffsetChange(Math.max(0, offset - limit));
  };

  const handleNext = () => {
    if (hasNext) onOffsetChange(offset + limit);
  };

  const handleLimitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onLimitChange(Number(e.target.value));
    // 페이지 크기 변경 시 첫 페이지로 이동
    onOffsetChange(0);
  };

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')} role="navigation" aria-label="페이지 탐색">
      {/* 페이지 크기 선택 */}
      <div className={styles.sizeSelector}>
        <label htmlFor="pagination-limit" className={styles.sizeLabel}>
          페이지당
        </label>
        <select
          id="pagination-limit"
          className={styles.sizeSelect}
          value={limit}
          onChange={handleLimitChange}
          aria-label="페이지당 항목 수"
        >
          {limitOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}건
            </option>
          ))}
        </select>
      </div>

      {/* 현재 범위 표시 */}
      <span className={styles.range} aria-live="polite">
        {start.toLocaleString('ko-KR')}–{end.toLocaleString('ko-KR')} / {total.toLocaleString('ko-KR')}건
      </span>

      {/* 이전/다음 버튼 */}
      <div className={styles.nav}>
        <button
          type="button"
          className={styles.navBtn}
          onClick={handlePrev}
          disabled={!hasPrev}
          aria-label="이전 페이지"
        >
          ‹ 이전
        </button>
        <button
          type="button"
          className={styles.navBtn}
          onClick={handleNext}
          disabled={!hasNext}
          aria-label="다음 페이지"
        >
          다음 ›
        </button>
      </div>
    </div>
  );
}
