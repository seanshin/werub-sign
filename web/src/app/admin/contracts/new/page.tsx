'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 새 계약 — 서식 선택/PDF 업로드 → 서명자 구성(프리셋·주소록) → 생성→발송 원플로우(U5).
 * 접근암호·순차/동시 서명 모드 설정 포함.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi } from '@/lib/api';
import { ContractSignerItem, ContractPreset, PlacedMark, AddressEntry } from '@/types/api';
import { PdfPlacementModal } from '@/components/contracts/PdfMarkEditor';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Field, Input, Select } from '@/components/ui/Field';

type SignerRow = { kind: 'INTERNAL' | 'EXTERNAL'; displayName: string; ref: string; notifyEmail?: string };
const emptyRow = (kind: 'INTERNAL' | 'EXTERNAL' = 'EXTERNAL'): SignerRow => ({ kind, displayName: '', ref: '', notifyEmail: '' });

export default function NewContractPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [externalDocId, setExternalDocId] = useState('');
  const [labels, setLabels] = useState('');
  const [category, setCategory] = useState('기타');
  const [accessCode, setAccessCode] = useState('');
  const [documentHash, setDocumentHash] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileBytes, setFileBytes] = useState<ArrayBuffer | null>(null); // 배치 편집기·스탬프용 원본 바이트
  const [marks, setMarks] = useState<PlacedMark[]>([]);
  const [placementOpen, setPlacementOpen] = useState(false); // 전체화면 배치 모달
  const [rows, setRows] = useState<SignerRow[]>([emptyRow('EXTERNAL'), emptyRow('INTERNAL')]);
  const [addressbook, setAddressbook] = useState<AddressEntry[]>([]);
  useEffect(() => { contractsApi.addressbook().then(setAddressbook).catch(() => setAddressbook([])); }, []);
  // 프리셋(U5) — 요청 구성 저장/불러오기(기관 공용)
  const [presets, setPresets] = useState<ContractPreset[]>([]);
  const [presetSel, setPresetSel] = useState('');
  const [notice, setNotice] = useState('');
  const [sendNow, setSendNow] = useState(false); // 생성→발송 원플로우(U5)
  useEffect(() => { contractsApi.presets().then(setPresets).catch(() => setPresets([])); }, []);

  // 목록의 이메일은 마스킹되어 있으므로(D6), 적용 시에는 단건 조회로 원문 구성을 받아 채운다.
  const applyPreset = async (pid: string) => {
    setPresetSel(pid);
    if (!pid) return;
    let p: ContractPreset | undefined;
    try { p = await contractsApi.presetDetail(pid); }
    catch { p = presets.find((x) => x.presetId === pid); } // 권한 부족 등 — 마스킹 목록으로 폴백(이메일은 재입력 필요)
    if (!p) return;
    setTitle(p.title ?? '');
    setCategory(p.category ?? '기타');
    setLabels((p.labels ?? []).join(', '));
    setSigningMode(p.signingMode ?? 'SEQUENTIAL');
    setRows([...p.signers].sort((a, b) => a.order - b.order).map((s) => ({ kind: s.kind, displayName: s.displayName, ref: (s.kind === 'INTERNAL' ? s.username : s.email) ?? '', notifyEmail: '' })));
    setNotice(p.useAccessCode ? `프리셋 "${p.name}" 적용 — 이 구성은 접근암호 사용을 권장합니다(아래에 입력, 프리셋에 암호 값은 저장되지 않음)` : `프리셋 "${p.name}" 적용`);
  };
  const savePreset = async () => {
    const name = window.prompt('프리셋 이름(요청 구성 저장 — 문서·접근암호 값은 저장되지 않습니다. 동일 이름은 덮어씀):', presets.find((p) => p.presetId === presetSel)?.name ?? '');
    if (!name?.trim()) return;
    const signers = rows.filter((r) => r.ref.trim()).map((r, i) => ({ kind: r.kind, displayName: r.displayName.trim() || r.ref.trim(), order: i + 1, ...(r.kind === 'INTERNAL' ? { username: r.ref.trim() } : { email: r.ref.trim() }) }));
    if (!signers.length) { setError('프리셋으로 저장할 서명자 구성이 없습니다'); return; }
    try {
      const saved = await contractsApi.presetSave({ name: name.trim(), title: title.trim() || undefined, category, labels: labels.split(',').map((s) => s.trim()).filter(Boolean), signingMode, useAccessCode: !!accessCode.trim(), signers });
      setPresets(await contractsApi.presets());
      setPresetSel(saved.presetId);
      setNotice(`프리셋 "${saved.name}" 저장됨`);
    } catch (e) { setError(e instanceof Error ? e.message : '프리셋 저장 실패'); }
  };
  const removePreset = async () => {
    const p = presets.find((x) => x.presetId === presetSel);
    if (!p || !window.confirm(`프리셋 "${p.name}" 을(를) 삭제할까요?`)) return;
    try { await contractsApi.presetRemove(p.presetId); setPresets(await contractsApi.presets()); setPresetSel(''); setNotice(`프리셋 "${p.name}" 삭제됨`); }
    catch (e) { setError(e instanceof Error ? e.message : '프리셋 삭제 실패'); }
  };
  const [signingMode, setSigningMode] = useState<'SEQUENTIAL' | 'PARALLEL'>('SEQUENTIAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setRow = (i: number, patch: Partial<SignerRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, emptyRow()]);
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs));
  const moveRow = (i: number, dir: -1 | 1) => setRows((rs) => {
    const j = i + dir;
    if (j < 0 || j >= rs.length) return rs;
    const next = [...rs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  // 계약 PDF 선택 → SHA-256 계산 + 바이트 보관(배치 편집·스탬프·생성 직후 업로드용)
  const pickFile = async (f: File) => {
    setError('');
    try {
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      setDocumentHash(Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''));
      setFile(f);
      setFileBytes(buf);
      setMarks([]); // 새 파일 — 기존 배치 초기화
    } catch { setError('파일 해시 계산 실패'); }
  };

  const submit = async () => {
    setError('');
    if (!file || !fileBytes || !/^[0-9a-fA-F]{64}$/.test(documentHash)) { setError('계약서 PDF 파일을 선택하세요'); return; }
    const signers: ContractSignerItem[] = rows
      .filter((r) => r.ref.trim())
      .map((r, i) => ({
        kind: r.kind,
        displayName: r.displayName.trim() || r.ref.trim(),
        order: i + 1,
        ...(r.kind === 'INTERNAL'
          ? { username: r.ref.trim(), ...(r.notifyEmail?.trim() ? { email: r.notifyEmail.trim() } : {}) } // 알림 이메일(선택) — 미지정 시 계정 등록 이메일
          : { email: r.ref.trim() }),
      }));
    if (signers.length === 0) { setError('서명자가 최소 1명 필요합니다'); return; }
    const badEmail = signers.find((s) => s.kind === 'EXTERNAL' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email ?? ''));
    if (badEmail) { setError(`외부 서명자 이메일 형식 오류: ${badEmail.email}`); return; }

    setBusy(true);
    try {
      // 배치 마크가 있으면 서버 스탬프 → 최종 바이트 기준으로 해시·업로드(문서=서명 대상 일치 보장)
      let finalBytes = fileBytes;
      if (marks.length > 0) {
        finalBytes = await contractsApi.stamp(fileBytes, marks, signers.map((s, i) => ({ order: i + 1, displayName: s.displayName })));
      }
      const digest = await crypto.subtle.digest('SHA-256', finalBytes);
      const finalHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      const dto = await contractsApi.create({
        idempotencyKey: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        externalDocId: externalDocId.trim() || `contract:${Date.now()}`,
        title: title.trim() || '(제목 없음)',
        documentHash: finalHash,
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        category,
        ...(accessCode.trim() ? { accessCode: accessCode.trim() } : {}),
        signingMode,
        ...(marks.length ? { signMarks: marks } : {}), // 서명란 좌표 — 서명 후 손글씨 합성
        signers,
      });
      await contractsApi.uploadDocument(dto.requestId, finalBytes);
      // 생성→발송 원플로우(U5) — 외부 서명자 존재 시 바로 발송(best-effort: 실패해도 상세로 이동, 상세에서 재발송 가능)
      if (sendNow && signers.some((s) => s.kind === 'EXTERNAL')) {
        try { await contractsApi.send(dto.requestId, window.location.origin); }
        catch (e) { console.warn('생성 후 자동 발송 실패 — 상세에서 발송하세요:', e); }
      }
      router.push('/admin/contracts/' + dto.requestId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '계약 생성 실패');
      setBusy(false);
    }
  };

  return (
    <AdminLayout title="새 계약">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 760 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => router.push('/admin/contracts')} variant="ghost" size="sm">← 계약함</Button>
          <Button onClick={() => router.push('/admin/contracts/templates')} variant="ghost" size="sm">서식으로 작성 →</Button>
        </div>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {notice && <Alert type="info" message={notice} onClose={() => setNotice('')} />}

        <Card>
          <CardHeader title="프리셋" description="자주 쓰는 요청 구성(제목·서명자열·서명 방식·라벨·분류)을 저장하고 불러옵니다. 문서·접근암호 값은 저장되지 않습니다(기관 공용)." />
          <CardBody>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 240, flex: 1 }}>
                <Select aria-label="프리셋 선택" value={presetSel} onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">프리셋 선택…</option>
                  {presets.map((p) => <option key={p.presetId} value={p.presetId}>{p.name}{p.signingMode === 'PARALLEL' ? ' · 동시' : ''} ({p.signers.length}인)</option>)}
                </Select>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void savePreset()}>현재 구성을 프리셋으로 저장</Button>
              {presetSel && <Button variant="ghost" size="sm" onClick={() => void removePreset()}>삭제</Button>}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="계약 문서" description="계약서 PDF 원본은 암호화(AES-256-GCM)되어 원내에 보관되고, SHA-256 해시로 무결성을 봉인합니다." />
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Field label="제목" required htmlFor="ct-title"><Input id="ct-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 시설 유지보수 용역 계약" /></Field>
              <Field label="문서 ID" htmlFor="ct-docid" hint="미입력 시 자동 생성"><Input id="ct-docid" value={externalDocId} onChange={(e) => setExternalDocId(e.target.value)} placeholder="예: CT-2026-001" /></Field>
              <Field label="카테고리" htmlFor="ct-cat" hint="완료 계약 분류·관리 기준">
                <Select id="ct-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {['근로', '의료인력', '용역', '임대차', '구매', '보안', '협약', '보건행정', '기타'].map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="라벨" htmlFor="ct-labels" hint="쉼표로 구분(예: 용역, 2026)"><Input id="ct-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="용역, 2026" /></Field>
              <Field label="계약서 PDF" required htmlFor="ct-file" hint={documentHash ? `SHA-256 ${documentHash.slice(0, 16)}… 계산됨` : 'PDF 선택 시 해시가 자동 계산됩니다'}>
                <input id="ct-file" type="file" accept="application/pdf" aria-label="계약서 PDF 파일" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); }} style={{ fontSize: 13 }} />
              </Field>
              <Field label="접근암호(선택)" htmlFor="ct-code" hint="설정 시 외부 서명자는 링크 접속 후 이 암호를 입력해야 문서 열람·서명 가능(별도 채널로 전달)">
                <Input id="ct-code" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="4자 이상" autoComplete="off" />
              </Field>
              {fileBytes && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button variant="primary" size="sm" onClick={() => setPlacementOpen(true)}>서명란·입력란 배치 (전체화면)</Button>
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    배치 {marks.length}개{marks.length > 0 ? ' — 생성 시 문서에 박스로 새겨집니다' : ' (선택) — 전체화면에서 클릭·드래그로 배치'}
                  </span>
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="서명자" description="외부=이메일 발송(포털 서명), 내부=콘솔 계정 서명. 인증서는 자동발급됩니다." />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <Field label="서명 방식" htmlFor="ct-mode" hint={signingMode === 'SEQUENTIAL' ? '위에서부터 순서대로 서명(앞 사람 완료 전 차단)' : '전원이 순서 없이 동시에 서명 가능'}>
                <Select id="ct-mode" value={signingMode} onChange={(e) => setSigningMode(e.target.value as 'SEQUENTIAL' | 'PARALLEL')}>
                  <option value="SEQUENTIAL">순차 서명 (지정 순서대로)</option>
                  <option value="PARALLEL">동시 서명 (전원 병렬)</option>
                </Select>
              </Field>
              {rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '44px 110px 1fr 1.4fr 92px', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{signingMode === 'PARALLEL' ? '동시' : `${i + 1}차`}</span>
                    <Select value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as SignerRow['kind'], ref: '' })} aria-label={`${i + 1}번 서명자 구분`}>
                      <option value="EXTERNAL">외부</option>
                      <option value="INTERNAL">내부</option>
                    </Select>
                    <Input value={r.displayName} onChange={(e) => setRow(i, { displayName: e.target.value })} placeholder="표시명(예: 협력사 대표)" aria-label={`${i + 1}번 표시명`} />
                    <Input
                      value={r.ref}
                      list={r.kind === 'EXTERNAL' ? 'ab-emails' : undefined}
                      onChange={(e) => {
                        const v = e.target.value;
                        const hit = r.kind === 'EXTERNAL' ? addressbook.find((a) => a.email === v.trim().toLowerCase()) : undefined;
                        setRow(i, hit ? { ref: v, displayName: r.displayName.trim() || hit.name } : { ref: v });
                      }}
                      placeholder={r.kind === 'EXTERNAL' ? '이메일(주소록 자동완성)' : '콘솔 계정(username)'}
                      aria-label={`${i + 1}번 ${r.kind === 'EXTERNAL' ? '이메일' : '계정'}`}
                    />
                    <div style={{ display: 'flex', gap: 2 }}>
                      <Button onClick={() => moveRow(i, -1)} variant="ghost" size="sm" aria-label={`${i + 1}번 위로`} disabled={i === 0 || signingMode === 'PARALLEL'}>↑</Button>
                      <Button onClick={() => moveRow(i, 1)} variant="ghost" size="sm" aria-label={`${i + 1}번 아래로`} disabled={i === rows.length - 1 || signingMode === 'PARALLEL'}>↓</Button>
                      <Button onClick={() => removeRow(i)} variant="ghost" size="sm" aria-label={`${i + 1}번 삭제`} disabled={rows.length <= 1}>✕</Button>
                    </div>
                  </div>
                  {r.kind === 'INTERNAL' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '44px 110px 1fr 1.4fr 92px', gap: 8, alignItems: 'center' }}>
                      <span></span><span></span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)', gridColumn: 'span 1', textAlign: 'right', paddingRight: 4 }}>알림 이메일</span>
                      <Input value={r.notifyEmail ?? ''} onChange={(e) => setRow(i, { notifyEmail: e.target.value })} placeholder="선택 — 미입력 시 계정 등록 이메일 사용" aria-label={`${i + 1}번 내부 알림 이메일`} />
                      <span></span>
                    </div>
                  )}
                </div>
              ))}
              <Button onClick={addRow} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>+ 서명자 추가</Button>
              {addressbook.length > 0 && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>외부 이메일 입력 시 주소록({addressbook.length})에서 자동완성됩니다.</span>}
            </div>
            <datalist id="ab-emails">
              {addressbook.map((a) => <option key={a.id} value={a.email}>{a.name}{a.org ? ` · ${a.org}` : ''}</option>)}
            </datalist>
          </CardBody>
        </Card>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={submit} loading={busy} variant="primary">{sendNow ? '계약 생성 + 발송' : '계약 생성'}</Button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
            생성 후 바로 발송(외부 서명자 이메일 전송)
          </label>
          <Button onClick={() => router.push('/admin/contracts')} variant="ghost">취소</Button>
        </div>
      </div>

      <PdfPlacementModal
        open={placementOpen}
        onClose={() => setPlacementOpen(false)}
        title={`서명란·입력란 배치 — ${title || file?.name || '계약서'}`}
        pdfBytes={fileBytes}
        signers={rows.filter((r) => r.ref.trim()).map((r, i) => ({ order: i + 1, displayName: r.displayName.trim() || r.ref.trim() || `${i + 1}번 서명자`, kind: r.kind }))}
        marks={marks}
        onChange={setMarks}
      />
    </AdminLayout>
  );
}
