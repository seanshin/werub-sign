// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 공용 카드 컨테이너 + CardHeader(제목·설명) — 콘솔 섹션 구획의 기본 단위.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import React from 'react';
import styles from './Card.module.css';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Card({ children, className, style }: CardProps) {
  return (
    <div className={[styles.card, className].filter(Boolean).join(' ')} style={style}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps) {
  return (
    <div className={styles.header} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
      <div>
        <h2 className={styles.title}>{title}</h2>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className, style }: CardProps) {
  return (
    <div className={[styles.body, className].filter(Boolean).join(' ')} style={style}>
      {children}
    </div>
  );
}

export function CardFooter({ children }: CardProps) {
  return <div className={styles.footer}>{children}</div>;
}
