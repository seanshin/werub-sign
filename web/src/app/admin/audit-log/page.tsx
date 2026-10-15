'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 감사·로그 — 관리자 감사 스트림(/v1/admin/audit: admin:auth·admin:users 등) 조회.
 * 행 확장 상세(LogDetail)·entryHash·무결성 배지·서버측 검색·전체 CSV.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { caApi, revocationApi, adminAuditApi, authStorage } from '@/lib/api';
import { CaHistoryRow, AuditEntry, CrlResult, AuditVerifyResult } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { LogDetail, shortHash } from '@/components/log/LogDetail';
import { AuditFilterBar, AuditFilters, EMPTY_FILTERS, toApiRange } from '@/components/log/AuditFilterBar';

const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '8px 12px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };
const hashTd: React.CSSProperties = { ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-secondary)' };
const ADMIN_LABEL: Record<string, string> = { 'admin:auth': '로그인·인증', 'admin:users': '계정 관리' };

const IntegrityBadge = ({ v }: { v: AuditVerifyResult | null }) => {
  if (!v) return null;
  const type = !v.chainValid ? 'error' : v.valid ? 'success' : 'info';
  return <Alert type={type} message={`체인 무결성: ${v.chainValid ? '유효' : '깨짐(위변조 의심)'} · TSA 앵커: ${v.anchored ? (v.anchorMatchesChain ? '일치' : '불일치') : '미앵커(대기)'}`} />;
};

export default function AuditLogPage() {
  const [history, setHistory] = useState<CaHistoryRow[]>([]);
  const [caAudit, setCaAudit] = useState<AuditEntry[]>([]);
  const [crl, setCrl] = useState<CrlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // 관리자 감사(admin:auth/users) — users:admin 한정
  const [isAdmin, setIsAdmin] = useState(false);
  const [admStreams, setAdmStreams] = useState<{ stream: string; count: number }[]>([]);
  const [admSel, setAdmSel] = useState('admin:auth');
  const [admRows, setAdmRows] = useState<AuditEntry[]>([]);
  const [admVerify, setAdmVerify] = useState<AuditVerifyResult | null>(null);
  const [admFilters, setAdmFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [admDebouncedQ, setAdmDebouncedQ] = useState('');
  const [admEventTypes, setAdmEventTypes] = useState<string[]>([]);
  const [admExporting, setAdmExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setExpanded(null);
    try {
      const [h, a, c] = await Promise.all([caApi.history(), caApi.audit(), revocationApi.crl()]);
      setHistory(h);
      setCaAudit([...a].reverse()); // 최신 우선
      setCrl(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : '감사·로그 조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAdmin = useCallback(async (stream: string) => {
    setAdmVerify(null);
    try {
      const [s, list] = await Promise.all([adminAuditApi.streams().catch(() => []), adminAuditApi.list(stream, { limit: 100, ...toApiRange({ ...admFilters, q: admDebouncedQ }) })]);
      if (s.length) setAdmStreams(s);
      setAdmRows([...list.data].reverse());
      setAdmEventTypes((prev) => Array.from(new Set([...prev, ...list.data.map((e) => e.eventType)])).sort());
      adminAuditApi.verify(stream).then(setAdmVerify).catch(() => setAdmVerify(null));
    } catch { /* 비관리자(403) 등 — 섹션 비표시 */ }
  }, [admFilters, admDebouncedQ]);

  const exportAdminCsv = async () => {
    setAdmExporting(true);
    try { await adminAuditApi.exportCsv(admSel, toApiRange({ ...admFilters, q: admDebouncedQ })); }
    catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setAdmExporting(false); }
  };

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const admin = authStorage.getRole() === 'admin';
    setIsAdmin(admin);
    if (admin) void loadAdmin(admSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { const t = setTimeout(() => setAdmDebouncedQ(admFilters.q.trim()), 300); return () => clearTimeout(t); }, [admFilters.q]);
  useEffect(() => { if (isAdmin) void loadAdmin(admSel); /* eslint-disable-next-line */ }, [admSel, admDebouncedQ, admFilters.from, admFilters.to, admFilters.eventType]);

  const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '5px 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer', border: '1px solid var(--color-border)', background: active ? 'var(--color-primary)' : 'transparent', color: active ? '#fff' : 'var(--color-text-primary)', fontWeight: active ? 600 : 400 });

  // 확장 가능한 감사 테이블(공용 렌더) — 행 클릭 시 LogDetail
  const auditTable = (rows: AuditEntry[], prefix: string, extraCol?: { head: string; cell: (e: AuditEntry) => React.ReactNode }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>
        <th style={{ ...th, width: 22 }}></th><th style={th}>시각</th><th style={th}>이벤트</th><th style={th}>행위자</th>
        {extraCol && <th style={th}>{extraCol.head}</th>}<th style={th}>entryHash</th>
      </tr></thead>
      <tbody>
        {rows.map((e, i) => {
          const key = `${prefix}:${i}`;
          const open = expanded === key;
          const dd = (e.data ?? {}) as Record<string, unknown>;
          return (
            <React.Fragment key={key}>
              <tr onClick={() => setExpanded(open ? null : key)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                <td style={td}>{dt(e.occurredAt)}</td>
                <td style={td}><strong>{e.eventType}</strong></td>
                <td style={td}>{String(dd.actor ?? e.actor ?? e.actorType ?? '-')}</td>
                {extraCol && <td style={td}>{extraCol.cell(e)}</td>}
                <td style={hashTd}>{shortHash((e.entryHash ?? e.hash) as string | undefined)}</td>
              </tr>
              {open && <tr><td colSpan={extraCol ? 6 : 5} style={{ padding: '4px 12px 12px' }}><LogDetail entry={e} /></td></tr>}
            </React.Fragment>
          );
        })}
        {rows.length === 0 && !loading && <tr><td style={td} colSpan={extraCol ? 6 : 5}>이벤트 없음</td></tr>}
      </tbody>
    </table>
  );

  return (
    <AdminLayout title="감사·로그">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => { void load(); if (isAdmin) void loadAdmin(admSel); }} loading={loading} variant="ghost" size="sm">새로고침</Button>
        </div>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {loading && history.length === 0 && <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>}

        {/* 관리자 감사(로그인·MFA·비번·계정변경) — admin 한정 */}
        {isAdmin && (
          <Card>
            <CardHeader title="관리자 감사 — 로그인·계정 (행위자·IP)" description="admin:auth(로그인·MFA·비밀번호·로그아웃)·admin:users(계정 생성/역할/상태). 해시체인 봉인." />
            <CardBody>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {admStreams.map((s) => (
                  <button key={s.stream} style={tabBtn(admSel === s.stream)} onClick={() => setAdmSel(s.stream)}>
                    {ADMIN_LABEL[s.stream] ?? s.stream} <span style={{ opacity: 0.7 }}>({s.count})</span>
                  </button>
                ))}
              </div>
              <div style={{ marginBottom: 12 }}>
                <AuditFilterBar
                  filters={admFilters}
                  onChange={setAdmFilters}
                  searchPlaceholder="검색(행위·행위자·IP·data)"
                  searchAriaLabel="관리자 감사 검색"
                  eventTypes={admEventTypes}
                  right={<Button onClick={exportAdminCsv} loading={admExporting} variant="ghost" size="sm" aria-label="CSV 내보내기" disabled={admRows.length === 0}>CSV</Button>}
                />
              </div>
              <div style={{ marginBottom: 12 }}><IntegrityBadge v={admVerify} /></div>
              <div style={{ overflowX: 'auto' }}>
                {auditTable(admRows, 'adm', { head: '대상', cell: (e) => { const dd = (e.data ?? {}) as Record<string, unknown>; return String(dd.target ?? dd.username ?? dd.ip ?? '-'); } })}
              </div>
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 10 }}>※ 행 클릭 → 전체 data(IP·역할·세션 등)·entryHash/prevHash. 행위자는 <code>user:&lt;아이디&gt;</code>로 개인 귀속.</p>
            </CardBody>
          </Card>
        )}

        {/* CA 회전 이력 */}
        <Card>
          <CardHeader title="CA 회전 이력 (트러스트 앵커)" />
          <CardBody>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Issuing 시리얼</th><th style={th}>유효 시작</th><th style={th}>유효 만료</th><th style={th}>상태</th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.serialNumber}>
                    <td style={td}><code>{r.serialNumber}</code></td>
                    <td style={td}>{dt(r.notBefore)}</td>
                    <td style={td}>{dt(r.notAfter)}</td>
                    <td style={td}>{r.active ? <strong style={{ color: 'var(--color-success-text)' }}>현재</strong> : '구(이력)'}</td>
                  </tr>
                ))}
                {history.length === 0 && !loading && <tr><td style={td} colSpan={4}>이력 없음</td></tr>}
              </tbody>
            </table>
          </CardBody>
        </Card>

        {/* CA 관리 감사(행위자) — 행 확장 상세 */}
        <Card>
          <CardHeader title="CA 관리 감사 — 행위자 책임추적" />
          <CardBody>
            <div style={{ overflowX: 'auto' }}>
              {auditTable(caAudit, 'ca', { head: '대상(시리얼)', cell: (e) => <code>{String(e.issuingSerial ?? (e.data as Record<string, unknown>)?.issuingSerial ?? '-')}</code> })}
            </div>
          </CardBody>
        </Card>

        {/* 폐기 인증서 */}
        <Card>
          <CardHeader title={`폐기 인증서 (CRL #${crl?.crlNumber ?? "-"})`} />
          <CardBody>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>시리얼</th><th style={th}>사유</th><th style={th}>폐기 시각</th></tr></thead>
              <tbody>
                {(crl?.revoked ?? []).map((r) => (
                  <tr key={r.serialNumber}>
                    <td style={td}><code>{r.serialNumber}</code></td>
                    <td style={td}>{r.reason ?? '-'}</td>
                    <td style={td}>{dt(r.revokedAt)}</td>
                  </tr>
                ))}
                {(crl?.revoked?.length ?? 0) === 0 && !loading && <tr><td style={td} colSpan={3}>폐기 인증서 없음</td></tr>}
              </tbody>
            </table>
          </CardBody>
        </Card>

        {/* HTTP 접근 로그 안내 */}
        <Card>
          <CardHeader title="HTTP 접근 로그" />
          <CardBody>
            <p style={{ fontSize: 14, lineHeight: 1.7, margin: 0 }}>
              요청별 접근 로그(요청자·IP·경로·상태·지연)는 <strong>컨테이너 stdout에 구조적 JSON</strong>으로 출력됩니다.
              DB 미저장이라 콘솔 표시 대신 운영에선 <strong>로그 수집기(Loki/ELK·SIEM)</strong>로 적재·검색하세요.
            </p>
            <pre style={{ background: 'var(--color-surface-subtle, #f6f8fa)', padding: 12, borderRadius: 6, fontSize: 12, overflowX: 'auto', marginTop: 12 }}>
{`docker logs sign-core 2>&1 | grep '"actor"' | tail
# {"t":"...","reqId":"...","method":"POST","path":"/v1/...","status":201,"actor":"hospitalrun"}`}
            </pre>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 8 }}>
              ※ 서명요청별 <strong>법적 감사 이력(해시체인)</strong>은 [서명요청 → 상세 → 감사 탭]에서 검증·PDF 발급 가능합니다.
            </p>
          </CardBody>
        </Card>
      </div>
    </AdminLayout>
  );
}
