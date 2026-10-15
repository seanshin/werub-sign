// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import React from 'react';
import styles from './Table.module.css';

interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  width?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  /** 일괄 작업 — 행 선택 체크박스. 지정 시 선택 컬럼 노출(미지정=기존 동작). */
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /** 선택 가능 여부(미지정=모두 선택 가능). */
  isSelectable?: (row: T) => boolean;
}

export function Table<T>({ columns, data, rowKey, onRowClick, emptyMessage = '데이터가 없습니다.', selectable, selectedKeys, onSelectionChange, isSelectable }: TableProps<T>) {
  const selKeys = selectedKeys ?? new Set<string>();
  const selectableRows = data.filter((r) => (isSelectable ? isSelectable(r) : true));
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selKeys.has(rowKey(r)));
  const colSpan = columns.length + (selectable ? 1 : 0);

  const toggle = (key: string) => {
    if (!onSelectionChange) return;
    const next = new Set(selKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectionChange(next);
  };
  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) onSelectionChange(new Set());
    else onSelectionChange(new Set(selectableRows.map(rowKey)));
  };

  return (
    <div className={styles.wrapper}>
      <table className={[styles.table, onRowClick ? styles.clickable : ''].filter(Boolean).join(' ')}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 40 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="전체 선택" disabled={selectableRows.length === 0} />
              </th>
            )}
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row) => {
              const key = rowKey(row);
              const canSelect = isSelectable ? isSelectable(row) : true;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
                  role={onRowClick ? 'button' : undefined}
                >
                  {selectable && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selKeys.has(key)} onChange={() => toggle(key)} disabled={!canSelect} aria-label="행 선택" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key}>
                      {col.render
                        ? col.render(row)
                        : String((row as Record<string, unknown>)[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
