'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 발송 이력 — 서명요청 링크 발송 기록(수신처는 마스킹 저장). 재발송 진입점.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useCallback, useEffect, useState } from 'react';
import { notificationsApi } from '@/lib/api';
import { NotifyRecord } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { StatusPill } from '@/components/ui/StatusPill';
import { Pagination } from '@/components/ui/Pagination';
import styles from './page.module.css';

const DEFAULT_LIMIT = 50;

const dt = (s: string) =>
  new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

export default function NotificationsPage() {
  const [records, setRecords] = useState<NotifyRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      await notificationsApi.exportCsv();
    } catch (e) {
      setError(e instanceof Error ? e.message : '내보내기에 실패했습니다.');
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async (currentOffset = 0, currentLimit = limit) => {
    setLoading(true);
    setError('');
    try {
      const result = await notificationsApi.listAll({ limit: currentLimit, offset: currentOffset });
      setRecords(result.data);
      setTotal(result.page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : '발송 이력을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load(offset, limit);
  }, [offset, limit, load]);

  const handleOffsetChange = (newOffset: number) => {
    setOffset(newOffset);
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0);
  };

  return (
    <AdminLayout title="발송 이력">
      <div className={styles.wrap}>
        <div className={styles.toolbar}>
          <Button onClick={() => load(offset, limit)} loading={loading} variant="ghost" size="sm">
            새로고침
          </Button>
          <Button onClick={handleExport} loading={exporting} variant="ghost" size="sm" aria-label="CSV 내보내기">
            내보내기
          </Button>
        </div>

        {error && (
          <Alert type="error" message={error} onClose={() => setError('')} />
        )}

        <Card>
          <CardHeader title={`전체 발송 이력 (${total.toLocaleString('ko-KR')}건)`} />
          <CardBody>
            {loading && records.length === 0 ? (
              <div className={styles.center}>
                <Spinner size={36} />
              </div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>발송 시각</th>
                      <th>요청 ID</th>
                      <th>참가자 ID</th>
                      <th>채널</th>
                      <th>Provider</th>
                      <th>결과</th>
                      <th>수신 (마스킹)</th>
                      <th>메시지 ID</th>
                      <th>제목/이유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 && !loading ? (
                      <tr>
                        <td colSpan={9} className={styles.empty}>
                          발송 이력이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      records.map((r) => (
                        <tr key={r.id}>
                          <td className={styles.mono}>{dt(r.sentAt)}</td>
                          <td>
                            <code className={styles.idCode}>
                              {r.requestId.slice(0, 8)}...
                            </code>
                          </td>
                          <td>
                            <code className={styles.idCode}>
                              {r.participantId.slice(0, 8)}...
                            </code>
                          </td>
                          <td>{r.channel}</td>
                          <td>{r.provider}</td>
                          <td>
                            <StatusPill status={r.result} />
                          </td>
                          <td className={styles.mono}>{r.toMasked}</td>
                          <td>
                            {r.providerMsgId ? (
                              <code className={styles.idCode}>
                                {r.providerMsgId}
                              </code>
                            ) : (
                              <span className={styles.na}>-</span>
                            )}
                          </td>
                          <td className={styles.reasonCell}>
                            {r.title && (
                              <span className={styles.title}>{r.title}</span>
                            )}
                            {r.reason && (
                              <span className={styles.reason}>{r.reason}</span>
                            )}
                            {!r.title && !r.reason && (
                              <span className={styles.na}>-</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              total={total}
              offset={offset}
              limit={limit}
              onOffsetChange={handleOffsetChange}
              onLimitChange={handleLimitChange}
            />
          </CardBody>
        </Card>
      </div>
    </AdminLayout>
  );
}
