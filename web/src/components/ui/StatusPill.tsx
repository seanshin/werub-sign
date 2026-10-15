// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 상태 배지 — 요청/계약/웹훅 상태를 색상 규칙으로 표준 표시(COMPLETED=녹색 등).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import React from 'react';
import styles from './StatusPill.module.css';

const LABELS: Record<string, string> = {
  CREATED:     '생성됨',
  IN_PROGRESS: '진행중',
  COMPLETED:   '완료',
  EXPIRED:     '만료',
  WITHDRAWN:   '철회',
  SUPERSEDED:  '개정됨',
  REVOKED:     '폐기',
  PENDING:     '대기',
  SIGNED:      '서명완료',
  // 발송 이력 결과
  SENT:        '발송완료',
  FAIL:        '실패',
  SKIP:        '스킵',
};

interface StatusPillProps {
  status: string;
  label?: string;
}

export function StatusPill({ status, label }: StatusPillProps) {
  const cls = styles[status as keyof typeof styles] ?? '';
  return (
    <span className={[styles.pill, cls].filter(Boolean).join(' ')}>
      {label ?? LABELS[status] ?? status}
    </span>
  );
}
