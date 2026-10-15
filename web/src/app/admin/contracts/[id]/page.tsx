'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 계약 상세 — 진행 타임라인·문서/첨부 탭·내부 서명(배치 편집기·손글씨)·기재값 증적·
 * 이력(감사 체인)·교부/보관/철회 액션. 계약 트랙의 중심 화면.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi, requestsApi, authStorage } from '@/lib/api';
import { ContractDto, ContractAttachment, ContractDeliverLink, ContractFillValues, VerifyResult, AuditEntry, AuditVerifyResult } from '@/types/api';
import { FIELD_TYPE_LABEL, fieldInputProps, validateFieldValue } from '@/lib/field-type';
import { LogDetail, shortHash } from '@/components/log/LogDetail';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/ui/Modal';
import { StatusPill } from '@/components/ui/StatusPill';
import { SignaturePad } from '@/components/contracts/SignaturePad';
import { PdfPlacementModal } from '@/components/contracts/PdfMarkEditor';
import { ContractVerifyPanel } from '@/components/contracts/ContractVerifyPanel';
import { PlacedMark, FieldValueType } from '@/types/api';

type PageProps = { params: { id: string } };
const dt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14, borderBottom: '1px solid var(--color-border-subtle, #eee)' };

export default function ContractDetailPage({ params }: PageProps) {
  const { id } = params;
  const router = useRouter();
  const [dto, setDto] = useState<ContractDto | null>(null);
  const [verifyR, setVerifyR] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false); // 기능 비활성(플래그 OFF)
  const [canAct, setCanAct] = useState(false);
  const [msg, setMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signImage, setSignImage] = useState<string | null>(null); // 내부 서명 손글씨
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [sigParticipants, setSigParticipants] = useState<string[]>([]); // 손글씨 보유 참가자
  const [sigUrls, setSigUrls] = useState<Record<string, string>>({});
  const [fillRows, setFillRows] = useState<ContractFillValues[]>([]); // 기재값 증적(A4)
  // 서명란 위치 재지정(기존 계약 손글씨 합성)
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementLoading, setPlacementLoading] = useState(false);
  const [placementBytes, setPlacementBytes] = useState<ArrayBuffer | null>(null);
  const [placementMarks, setPlacementMarks] = useState<PlacedMark[]>([]);
  const [deliverLinks, setDeliverLinks] = useState<ContractDeliverLink[] | null>(null); // 교부 재발급 결과 Modal
  const [attachList, setAttachList] = useState<ContractAttachment[]>([]); // 첨부(열람용 부속 문서, 설계 §11)
  const [log, setLog] = useState<AuditEntry[]>([]); // 계약 이력(contract:<id> 스트림, 최신순)
  const [logVerify, setLogVerify] = useState<AuditVerifyResult | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => { const r = authStorage.getRole(); setCanAct(r === null || r === 'admin' || r === 'operator'); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try {
      const d = await contractsApi.get(id);
      setDto(d);
      requestsApi.verify(id).then(setVerifyR).catch(() => setVerifyR(null));
      contractsApi.log(id).then((es) => setLog([...es].reverse())).catch(() => setLog([]));
      contractsApi.logVerify(id).then(setLogVerify).catch(() => setLogVerify(null));
      contractsApi.attachments(id).then(setAttachList).catch(() => setAttachList([]));
      contractsApi.fillValues(id).then(setFillRows).catch(() => setFillRows([]));
      if (d.documentAvailable) contractsApi.documentObjectUrl(id).then(setDocUrl).catch(() => setDocUrl(null));
      contractsApi.signatureImages(id).then(async (pids) => {
        setSigParticipants(pids);
        const urls: Record<string, string> = {};
        for (const pid of pids) { try { urls[pid] = await contractsApi.signatureImageObjectUrl(id, pid); } catch { /* skip */ } }
        setSigUrls(urls);
      }).catch(() => setSigParticipants([]));
    } catch (e) {
      const m = e instanceof Error ? e.message : '조회 실패';
      if (/비활성/.test(m)) setDisabled(true); else setError(m);
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (docUrl) URL.revokeObjectURL(docUrl); }, [docUrl]);
  useEffect(() => () => { Object.values(sigUrls).forEach((u) => URL.revokeObjectURL(u)); }, [sigUrls]);

  const current = dto?.participants ? [...dto.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED') : undefined;
  const isOpen = dto?.status === 'CREATED' || dto?.status === 'IN_PROGRESS';
  const isParallel = dto?.signingMode === 'PARALLEL';
  // 순차=현재 단계 기준 / 동시=미서명 존재 기준(내부 서명 본인 배정 여부는 서버가 강제)
  const currentIsInternal = isParallel
    ? !!dto?.participants.some((p) => p.signerType === 'INTERNAL' && p.status !== 'SIGNED')
    : current?.signerType === 'INTERNAL';
  const currentIsExternal = isParallel
    ? !!dto?.participants.some((p) => p.signerType === 'EXTERNAL_PARTY' && p.status !== 'SIGNED')
    : current?.signerType === 'EXTERNAL_PARTY';

  const portalBase = () => window.location.origin;

  const doSend = async (remind: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const out = remind ? await contractsApi.remind(id, portalBase()) : await contractsApi.send(id, portalBase());
      const sent = out.filter((o) => o.result === 'SENT').length;
      const failed = out.filter((o) => o.result === 'FAIL').length;
      const label = remind ? '독촉 재발송' : '발송';
      if (failed > 0 && sent === 0) {
        setMsg({ type: 'error', text: `${label} 실패 — 이메일이 전송되지 않았습니다(${failed}건). 메일 발송 설정(SMTP/발신 도메인)을 확인하세요.` });
      } else if (failed > 0) {
        setMsg({ type: 'error', text: `${label} 일부 실패 — 성공 ${sent}건 · 실패 ${failed}건. 메일 발송 설정을 확인하세요.` });
      } else {
        setMsg({ type: 'success', text: `${label} 완료 — ${sent}건 전송` });
      }
      await load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '발송 실패' }); }
    finally { setBusy(false); }
  };

  const doCategory = async (category: string) => {
    setBusy(true); setMsg(null);
    try { await contractsApi.setCategory(id, category); await load(); setMsg({ type: 'success', text: `카테고리를 "${category}"(으)로 변경했습니다.` }); }
    catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '카테고리 변경 실패' }); }
    finally { setBusy(false); }
  };
  const doArchive = async () => {
    const reason = window.prompt('이 계약을 계약함에서 제거(보관)합니다.\n데이터·서명·감사 이력은 보존되며 계약함 "보관됨" 탭에서 확인·복원할 수 있습니다.\n\n제거 사유(선택):', '');
    if (reason === null) return;
    setBusy(true); setMsg(null);
    try { await contractsApi.archive(id, reason.trim() || undefined); await load(); setMsg({ type: 'success', text: '계약함에서 제거(보관)되었습니다. "보관됨" 탭에서 복원할 수 있습니다.' }); }
    catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '보관 처리 실패' }); }
    finally { setBusy(false); }
  };
  const doUnarchive = async () => {
    setBusy(true); setMsg(null);
    try { await contractsApi.unarchive(id); await load(); setMsg({ type: 'success', text: '보관이 복원되어 계약함에 다시 표시됩니다.' }); }
    catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '복원 실패' }); }
    finally { setBusy(false); }
  };

  const doDeliver = async () => {
    setBusy(true); setMsg(null);
    try {
      const links = await contractsApi.deliver(id);
      setDeliverLinks(links);
      setMsg({ type: 'success', text: `교부 링크 재발급 완료 — ${links.length}건 이메일 발송` });
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '교부 재발급 실패' }); }
    finally { setBusy(false); }
  };

  const openPlacement = async () => {
    setPlacementLoading(true); setMsg(null);
    try {
      // 원본 PDF(raw) — 서명란 배치는 합성 전 문서 위에서
      const url = await contractsApi.documentObjectUrl(id, true);
      const buf = await (await fetch(url)).arrayBuffer();
      URL.revokeObjectURL(url);
      setPlacementBytes(buf);
      setPlacementMarks(dto?.signMarks ?? []);
      setPlacementOpen(true);
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '문서를 불러오지 못했습니다' }); }
    finally { setPlacementLoading(false); }
  };
  const savePlacement = async () => {
    setPlacementOpen(false);
    try {
      // SIGN·FIELD 전량 전송 — SIGN 만 보내면 서버가 meta.signMarks 를 통째로 교체하면서 입력란(FIELD)이 소멸한다
      const r = await contractsApi.updateSignMarks(id, placementMarks.filter((m) => m.type === 'SIGN' || m.type === 'FIELD'));
      setMsg({ type: 'success', text: `서명란 위치 저장 — ${r.count}개. 서명 완료분은 문서에 손글씨가 합성됩니다.` });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '서명란 저장 실패' }); }
  };

  // fill-at-signing(A4) — 내 차례 참가자에게 배정된 입력란(FIELD 마크, 제출 순번=signOrder 정렬 위치)
  const myFillFields = React.useMemo(() => {
    if (!dto) return [] as Array<{ label: string; fieldType: FieldValueType }>;
    const ordered = [...dto.participants].sort((a, b) => a.signOrder - b.signOrder);
    const username = authStorage.getUsername();
    // 순차=현재 pending, 동시=내(세션 계정) 미서명 내부 항목 — 서버 바인딩 규칙과 동일.
    // 계정 매핑은 internalNotify(username↔표시명) 경유(참가자 DTO는 외부 이메일 비노출 원칙이라 ref 없음).
    const myNames = new Set((dto.internalNotify ?? []).filter((n) => !username || n.username === username).map((n) => n.displayName));
    const targetIdx = isParallel
      ? ordered.findIndex((p) => p.signerType === 'INTERNAL' && p.status !== 'SIGNED' && myNames.has(p.displayName))
      : ordered.findIndex((p) => p.status !== 'SIGNED');
    if (targetIdx < 0) return [];
    const signerNo = targetIdx + 1;
    // 라벨 폴백은 서버 assignedFieldMarks 와 동일하게 **전체 마크 인덱스** 기준(순번 어긋남 방지)
    return (dto.signMarks ?? [])
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.type === 'FIELD' && m.signer === signerNo)
      .map(({ m, index }) => ({ label: (m.label ?? '').trim() || `입력란 ${index + 1}`, fieldType: m.fieldType ?? 'text' }));
  }, [dto, isParallel]);
  const [fillForm, setFillForm] = useState<Record<string, string>>({});

  const doSign = async () => {
    const missing = myFillFields.filter((f) => !(fillForm[f.label] ?? '').trim());
    if (missing.length) { setMsg({ type: 'error', text: `입력란을 기재해 주세요: ${missing.map((f) => f.label).join(', ')}` }); return; }
    const bad = myFillFields.map((f) => validateFieldValue(f.fieldType, f.label, fillForm[f.label] ?? '')).find(Boolean);
    if (bad) { setMsg({ type: 'error', text: bad }); return; }
    setBusy(true); setMsg(null);
    try {
      const fillValues = myFillFields.length ? myFillFields.map((f) => ({ label: f.label, value: (fillForm[f.label] ?? '').trim() })) : undefined;
      const r = await contractsApi.sign(id, signImage || undefined, fillValues);
      setSignOpen(false); setSignImage(null); setFillForm({});
      setMsg({ type: 'success', text: `서명 완료 — 상태 ${r.status}` });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '서명 실패' }); }
    finally { setBusy(false); }
  };

  if (loading) return <AdminLayout title="계약 상세"><div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div></AdminLayout>;
  if (disabled) return (
    <AdminLayout title="계약 상세">
      <Button onClick={() => router.push('/admin/contracts')} variant="ghost" size="sm">← 계약함</Button>
      <div style={{ marginTop: 16 }}><Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." /></div>
    </AdminLayout>
  );
  if (error || !dto) return (
    <AdminLayout title="계약 상세">
      <Button onClick={() => router.push('/admin/contracts')} variant="ghost" size="sm">← 계약함</Button>
      <div style={{ marginTop: 16 }}><Alert type="error" message={error || '계약 문서 없음'} /></div>
    </AdminLayout>
  );

  const signersTab = (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr><th style={th}>순서</th><th style={th}>서명자</th><th style={th}>구분</th><th style={th}>연락처</th><th style={th}>상태</th><th style={th}>손글씨 서명</th></tr></thead>
        <tbody>
          {[...dto.participants].sort((a, b) => a.signOrder - b.signOrder).map((p) => {
            const isCur = !isParallel && current?.participantId === p.participantId && isOpen;
            // 동시 모드는 봉투 order 전원 1 → 표시명 기준 매칭(같은 이름이면 order 폴백)
            const party = dto.parties.find((x) => x.displayName === p.displayName) ?? dto.parties.find((x) => x.order === p.signOrder);
            const internal = p.signerType === 'INTERNAL';
            const intNotify = internal ? (dto.internalNotify?.find((x) => x.displayName === p.displayName) ?? dto.internalNotify?.find((x) => x.order === p.signOrder)) : undefined;
            const sigUrl = sigUrls[p.participantId];
            return (
              <tr key={p.participantId} style={{ background: isCur ? 'var(--color-bg-secondary)' : undefined }}>
                <td style={td}>{isParallel ? '동시' : `${p.signOrder}차`}{isCur ? ' ◀ 현재' : ''}</td>
                <td style={td}><strong>{p.displayName}</strong></td>
                <td style={td}>{internal ? '내부(콘솔)' : '외부(이메일)'}</td>
                <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
                  {internal
                    ? (intNotify?.email ? <span title="내부 서명자 알림 이메일">✉ {intNotify.email}</span> : <span style={{ color: 'var(--color-text-muted)' }}>알림 이메일 없음</span>)
                    : party?.email ?? '-'}
                </td>
                <td style={td}><StatusPill status={p.status} /></td>
                <td style={td}>{sigUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={sigUrl} alt={`${p.displayName} 손글씨 서명`} style={{ height: 40, maxWidth: 160, objectFit: 'contain', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 4 }} />
                  : sigParticipants.includes(p.participantId) ? <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>있음</span> : <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>-</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 기재값 증적(A4) — 서명자가 서명 시 기재한 입력란 값(암호화 보관·SHA-256 봉인) */}
      {fillRows.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 }}>입력란 기재값</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {fillRows.map((f) => (
              <div key={f.participantId} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>
                  <strong>{f.displayName}</strong>
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>
                    {isParallel ? '동시' : `${f.signerNo}차`} · {f.via === 'PORTAL' ? '포털 기재' : '콘솔 기재'}{f.filledAt ? ` · ${dt(f.filledAt)}` : ''}
                  </span>
                  {/* 대비 확보 토큰 사용(--color-success 는 12px 본문에서 AA 미달 — a11y 회귀 가드) */}
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: f.integrityOk ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>
                    {f.integrityOk ? '✓ 무결성 확인' : '✗ 무결성 검증 실패'}
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>입력란</th><th style={th}>타입</th><th style={th}>기재값</th></tr></thead>
                  <tbody>
                    {f.values.map((v) => (
                      <tr key={v.index}>
                        <td style={td}>{v.label}</td>
                        <td style={{ ...td, fontSize: 12, color: 'var(--color-text-muted)' }}>{FIELD_TYPE_LABEL[v.fieldType] ?? '텍스트'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)' }}>{v.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, wordBreak: 'break-all' }}>봉인 해시(SHA-256) {f.sha256}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 진행 타임라인(U5) — 감사 스트림(contract:<id>) 주요 사건을 시간순으로 */}
      {(() => {
        const tlLabel: Record<string, string> = {
          CONTRACT_CREATED: '계약 생성',
          CONTRACT_SENT: '발송',
          CONTRACT_REMINDED: '독촉 재발송',
          CONTRACT_UNLOCKED: '접근암호 확인(외부 열람 시작)',
          CONTRACT_FILLED: '입력란 기재',
          CONTRACT_SIGNED_EXTERNAL: '외부 서명',
          CONTRACT_SIGNED_INTERNAL: '내부 서명',
          CONTRACT_DELIVERED: '완료문서 교부',
          CONTRACT_ARCHIVED: '보관 처리',
          CONTRACT_UNARCHIVED: '보관 복원',
        };
        const events = [...log].reverse().filter((e) => tlLabel[e.eventType]); // log=최신순 → 시간순
        if (events.length === 0) return null;
        return (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 }}>진행 타임라인</div>
            <ol style={{ margin: 0, padding: 0, listStyle: 'none', borderLeft: '2px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {events.map((e, i) => {
                const step = typeof e.step === 'number' ? ` (${isParallel ? '동시' : `${e.step}차`})` : '';
                const signed = e.eventType === 'CONTRACT_SIGNED_EXTERNAL' || e.eventType === 'CONTRACT_SIGNED_INTERNAL';
                return (
                  <li key={`${e.seq ?? i}-${e.eventType}`} style={{ position: 'relative', paddingLeft: 16, fontSize: 13 }}>
                    <span aria-hidden="true" style={{ position: 'absolute', left: -6, top: 4, width: 10, height: 10, borderRadius: '50%', background: signed ? 'var(--color-primary,#2563eb)' : 'var(--color-border)' }} />
                    <span style={{ fontWeight: signed ? 600 : 400 }}>{tlLabel[e.eventType]}{step}</span>
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>{dt(e.occurredAt)}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}
    </div>
  );

  const documentTab = dto.documentAvailable && docUrl ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>원본은 암호화 보관되며 열람은 전건 접속기록(F008)에 봉인됩니다.</span>
      <iframe src={docUrl} title="계약 문서" style={{ width: '100%', height: 560, border: '1px solid var(--color-border)', borderRadius: 8, background: '#fff' }} />
    </div>
  ) : (
    <Alert type="info" message={dto.documentAvailable ? '문서를 불러오는 중…' : '업로드된 계약 문서가 없습니다.'} />
  );

  const lastDelivered = log.find((e) => e.eventType === 'CONTRACT_DELIVERED');

  // 첨부 — 추가/삭제는 작성(미발송) 상태만(발송 후 불변 — 서명자 열람 정합, 설계 §11)
  const attachEditable = canAct && dto?.status === 'CREATED' && !dto?.lastSentAt && !dto?.archived;
  const onAttachUpload = async (file: File) => {
    setBusy(true); setMsg(null);
    try {
      const type = file.type === 'application/pdf' || file.type === 'image/png' || file.type === 'image/jpeg' ? file.type : '';
      if (!type) throw new Error('허용 형식: PDF·PNG·JPEG');
      await contractsApi.attachmentAdd(id, await file.arrayBuffer(), type, file.name);
      setAttachList(await contractsApi.attachments(id));
      setMsg({ type: 'success', text: `첨부 추가 — ${file.name}` });
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '첨부 업로드 실패' }); }
    finally { setBusy(false); }
  };
  const onAttachOpen = async (a: ContractAttachment) => {
    try { window.open(await contractsApi.attachmentObjectUrl(id, a.attachId), '_blank', 'noopener'); }
    catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '첨부 열람 실패' }); }
  };
  const onAttachRemove = async (a: ContractAttachment) => {
    if (!window.confirm(`첨부 "${a.name}" 을(를) 삭제할까요?`)) return;
    setBusy(true); setMsg(null);
    try { await contractsApi.attachmentRemove(id, a.attachId); setAttachList(await contractsApi.attachments(id)); }
    catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : '첨부 삭제 실패' }); }
    finally { setBusy(false); }
  };
  const attachTab = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
        열람용 부속 문서(견적서·사업자등록증 등) — 서명 대상이 아니며, 각 첨부의 SHA-256이 감사 이력에 봉인됩니다.
        {attachEditable ? ' 발송 후에는 추가·삭제할 수 없습니다.' : ' 발송 후에는 변경할 수 없습니다(열람만).'}
      </div>
      {attachEditable && (
        <label style={{ alignSelf: 'flex-start' }}>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onAttachUpload(f); e.target.value = ''; }}
          />
          <span className="btn" role="button" tabIndex={0} style={{ display: 'inline-block', padding: '8px 14px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
            + 첨부 추가 (PDF·PNG·JPEG, 최대 10MB)
          </span>
        </label>
      )}
      {attachList.length === 0 ? (
        <Alert type="info" message="첨부된 부속 문서가 없습니다." />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>이름</th><th style={th}>형식</th><th style={th}>크기</th><th style={th}>등록</th><th style={th}>SHA-256</th><th style={th} /></tr></thead>
          <tbody>
            {attachList.map((a) => (
              <tr key={a.attachId}>
                <td style={td}>{a.name}</td>
                <td style={td}>{a.contentType.replace('application/', '').replace('image/', '').toUpperCase()}</td>
                <td style={td}>{(a.sizeBytes / 1024).toFixed(0)}KB</td>
                <td style={td}>{dt(a.uploadedAt)}</td>
                <td style={td}><code style={{ fontSize: 12 }}>{a.sha256.slice(0, 12)}…</code></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <Button size="sm" variant="ghost" onClick={() => void onAttachOpen(a)}>열람</Button>
                  {attachEditable && <Button size="sm" variant="ghost" onClick={() => void onAttachRemove(a)} disabled={busy}>삭제</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const logTab = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>생성·발송·독촉·접근암호·서명·교부 이력(해시체인 봉인) · {log.length}건</span>
        <div style={{ marginLeft: 'auto' }}>
          <Button onClick={() => contractsApi.logExportCsv(id).catch(() => setMsg({ type: 'error', text: '내보내기 실패' }))} variant="ghost" size="sm" disabled={log.length === 0}>CSV</Button>
        </div>
      </div>
      {logVerify && (
        <Alert
          type={!logVerify.chainValid ? 'error' : 'success'}
          message={`이력 무결성: 체인 ${logVerify.chainValid ? '유효' : '깨짐(위변조 의심)'} · TSA 앵커 ${logVerify.anchored ? '봉인됨' : '미앵커(진행중)'}`} />
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
          <thead><tr>
            <th style={{ ...th, width: 24 }}></th><th style={th}>시각</th><th style={th}>이벤트</th><th style={th}>주체</th><th style={th}>entryHash</th>
          </tr></thead>
          <tbody>
            {log.map((e, i) => {
              const d = (e.data ?? {}) as Record<string, unknown>;
              const open = expanded === i;
              return (
                <React.Fragment key={i}>
                  <tr onClick={() => setExpanded(open ? null : i)} style={{ cursor: 'pointer', background: open ? 'var(--color-bg-secondary)' : undefined }} aria-expanded={open}>
                    <td style={{ ...td, color: 'var(--color-text-muted)' }}>{open ? '▾' : '▸'}</td>
                    <td style={td}>{dt(e.occurredAt)}</td>
                    <td style={td}><strong>{e.eventType}</strong></td>
                    <td style={td}>{String(d.actor ?? '-')}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--color-text-secondary)' }}>{shortHash(e.entryHash as string | undefined)}</td>
                  </tr>
                  {open && <tr><td colSpan={5} style={{ padding: '4px 10px 12px' }}><LogDetail entry={e} /></td></tr>}
                </React.Fragment>
              );
            })}
            {log.length === 0 && <tr><td style={td} colSpan={5}>이력 없음</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );

  const verifyTab = verifyR
    ? <ContractVerifyPanel verify={verifyR} audit={logVerify} completedSigners={dto.completedSigners} verifyToken={dto.verifyToken ?? null} />
    : <Spinner />;

  return (
    <AdminLayout title="계약 상세">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Button onClick={() => router.push('/admin/contracts')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>← 계약함</Button>
        {msg && <Alert type={msg.type} message={msg.text} onClose={() => setMsg(null)} />}
        {dto.archived && (
          <Alert type="info" message={`이 계약은 계약함에서 제거(보관)된 상태입니다${dto.archivedAt ? ` · ${dt(dto.archivedAt)}` : ''}${dto.archiveReason ? ` · 사유: ${dto.archiveReason}` : ''}. 데이터·서명·감사 이력은 보존됩니다.`} />
        )}

        <Card>
          <CardHeader
            title={dto.title}
            description={`문서 ${dto.externalDocId} · ${dto.category ?? '기타'}${isParallel ? ' · 동시 서명' : ' · 순차 서명'}${dto.hasAccessCode ? ' · 접근암호 🔒' : ''}${dto.labels.length ? ` · ${dto.labels.join(', ')}` : ''}`}
            actions={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusPill status={dto.status} />
                {canAct && isOpen && currentIsExternal && <>
                  <Button onClick={() => doSend(false)} variant="primary" size="sm" loading={busy}>발송</Button>
                  <Button onClick={() => doSend(true)} variant="ghost" size="sm" disabled={busy}>독촉</Button>
                </>}
                {canAct && isOpen && currentIsInternal && (
                  <Button onClick={() => setSignOpen(true)} variant="primary" size="sm">내부 서명</Button>
                )}
                {canAct && dto.status === 'COMPLETED' && dto.parties.length > 0 && (
                  <Button onClick={doDeliver} variant="ghost" size="sm" loading={busy}>교부 링크 재발급</Button>
                )}
                {canAct && dto.documentAvailable && !dto.archived && (
                  <Button onClick={openPlacement} variant="ghost" size="sm" loading={placementLoading}>서명란 위치 지정</Button>
                )}
                {canAct && (dto.archived
                  ? <Button onClick={doUnarchive} variant="ghost" size="sm" loading={busy}>복원</Button>
                  : <Button onClick={doArchive} variant="ghost" size="sm" loading={busy}>제거(보관)</Button>)}
              </div>
            }
          />
          <CardBody>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 14 }}>
              <span>서명 진행 <strong>{dto.completedSigners} / {dto.requiredSigners}</strong></span>
              {isOpen && (isParallel
                ? <span>진행 <strong>동시 서명 — 남은 {dto.requiredSigners - dto.completedSigners}명</strong></span>
                : current && <span>현재 단계 <strong>{current.signOrder}차 · {current.displayName}</strong>{currentIsExternal ? ' (외부 — 이메일 발송)' : ' (내부 — 콘솔 서명)'}</span>)}
              <span style={{ color: 'var(--color-text-muted)' }}>생성일 {dt(dto.createdAt)}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>감사 봉인 {dto.auditCount}건</span>
              {dto.status === 'COMPLETED' && lastDelivered && <span style={{ color: 'var(--color-text-muted)' }}>최근 교부 {dt(lastDelivered.occurredAt)}</span>}
              {canAct && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>카테고리</span>
                  <select
                    value={dto.category ?? '기타'}
                    onChange={(e) => doCategory(e.target.value)}
                    aria-label="계약 카테고리 변경"
                    style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)' }}
                  >
                    {['근로', '의료인력', '용역', '임대차', '구매', '보안', '협약', '보건행정', '기타'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </span>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Tabs tabs={[
              { key: 'signers', label: '서명자', content: signersTab },
              { key: 'document', label: '계약 문서', content: documentTab },
              { key: 'attachments', label: `첨부 (${attachList.length})`, content: attachTab },
              { key: 'log', label: `이력 (${log.length})`, content: logTab },
              { key: 'verify', label: '서명 검증', content: verifyTab },
            ]} />
          </CardBody>
        </Card>
      </div>

      <Modal
        open={deliverLinks !== null}
        onClose={() => setDeliverLinks(null)}
        title="교부 링크 재발급 결과"
        footer={<Button onClick={() => setDeliverLinks(null)} variant="ghost">닫기</Button>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
          <p style={{ margin: 0 }}>외부 서명자에게 이메일로 재발송되었습니다. 필요 시 아래 링크를 별도 채널로 전달할 수 있습니다.</p>
          {(deliverLinks ?? []).map((l) => (
            <div key={l.url} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong>{l.email}</strong>
              <a href={l.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>{l.url}</a>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>만료 {dt(l.expiresAt)}</span>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={signOpen}
        onClose={() => setSignOpen(false)}
        title="내부 서명"
        footer={<>
          <Button onClick={() => setSignOpen(false)} variant="ghost" disabled={busy}>취소</Button>
          <Button onClick={doSign} loading={busy} variant="primary">서명</Button>
        </>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            현재 단계({current?.signOrder}차 · {current?.displayName})의 지정 서명자 본인 계정으로 전자서명합니다.
            서명은 PKI 실서명(F010)으로 봉인되며 취소할 수 없습니다.
          </p>
          {myFillFields.length > 0 && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>입력란 기재(필수) — 기재값은 암호화 보관·감사 봉인되며 문서 표시본에 합성됩니다</div>
              {myFillFields.map((f) => (
                <label key={f.label} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                  {f.label}
                  {f.fieldType !== 'text' && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{FIELD_TYPE_LABEL[f.fieldType]}</span>}
                  <input
                    value={fillForm[f.label] ?? ''}
                    onChange={(e) => setFillForm((v) => ({ ...v, [f.label]: e.target.value }))}
                    {...fieldInputProps(f.fieldType, f.label)}
                    style={{ padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, background: 'var(--color-bg)', color: 'var(--color-text)' }}
                  />
                </label>
              ))}
            </div>
          )}
          <SignaturePad onChange={setSignImage} label="손글씨 서명(선택) — 마우스·터치로 서명하면 행위 증거로 함께 기록됩니다" />
        </div>
      </Modal>

      <PdfPlacementModal
        open={placementOpen}
        onClose={savePlacement}
        title={`서명란 위치 지정 — ${dto.title}`}
        pdfBytes={placementBytes}
        signers={[...dto.participants].sort((a, b) => a.signOrder - b.signOrder).map((p, i) => ({ order: i + 1, displayName: p.displayName, kind: p.signerType === 'INTERNAL' ? 'INTERNAL' : 'EXTERNAL' }))}
        marks={placementMarks}
        onChange={setPlacementMarks}
      />
    </AdminLayout>
  );
}
