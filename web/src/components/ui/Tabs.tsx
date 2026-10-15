'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 공용 탭 — 제어형 탭 전환(키보드 접근성 포함).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState } from 'react';
import styles from './Tabs.module.css';

interface Tab {
  key: string;
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key ?? '');

  return (
    <div>
      <div className={styles.tabList} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active === tab.key}
            aria-controls={`panel-${tab.key}`}
            id={`tab-${tab.key}`}
            className={[styles.tab, active === tab.key ? styles.active : ''].filter(Boolean).join(' ')}
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.key}`}
          className={styles.panel}
          hidden={active !== tab.key}
        >
          {active === tab.key && tab.content}
        </div>
      ))}
    </div>
  );
}
