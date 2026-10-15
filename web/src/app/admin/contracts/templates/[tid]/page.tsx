'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi } from '@/lib/api';
import { ContractTemplate, ContractSignerItem, PlacedMark } from '@/types/api';
import { PdfPlacementModal } from '@/components/contracts/PdfMarkEditor';
import { ContractBodyEditor, BodyEditorHandle } from '@/components/contracts/ContractBodyEditor';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';

type SignerRow = { kind: 'INTERNAL' | 'EXTERNAL'; displayName: string; ref: string };
const emptyRow = (kind: 'INTERNAL' | 'EXTERNAL' = 'EXTERNAL'): SignerRow => ({ kind, displayName: '', ref: '' });

/** 필드값 치환 — 빈 값은 밑줄 표시(문서상 공란) */
const substitute = (body: string, values: Record<string, string>) =>
  body.replace(/{{(\w+)}}/g, (_, k: string) => (values[k]?.trim() ? values[k].trim() : '＿＿＿＿'));

/** 서식 에디터 — 필드 입력→본문 생성(자유 수정)→미리보기→서명자 지정→PDF 조판·계약 생성. */
export default function ContractTemplateEditorPage({ params }: { params: { tid: string } }) {
  const { tid } = params;
  const router = useRouter();
  const [tpl, setTpl] = useState<ContractTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);

  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  const [bodyDirty, setBodyDirty] = useState(false); // 본문 직접 수정 여부(필드 적용 시 덮어쓰기 확인)
  const [title, setTitle] = useState('');
  const [labels, setLabels] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [rows, setRows] = useState<SignerRow[]>([emptyRow('EXTERNAL'), emptyRow('INTERNAL')]);
  const [signingMode, setSigningMode] = useState<'SEQUENTIAL' | 'PARALLEL'>('SEQUENTIAL');
  const [baseBytes, setBaseBytes] = useState<ArrayBuffer | null>(null); // 배치 편집기용 기본 PDF(마크 미포함)
  const [marks, setMarks] = useState<PlacedMark[]>([]); // 자유 배치(드래그) 마크 — 최종 조판에 포함
  const [placementOpen, setPlacementOpen] = useState(false); // 전체화면 배치 모달
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  // 마커 삽입 툴바 — 대상 서명자·입력란 라벨
  const editorRef = useRef<BodyEditorHandle | null>(null);
  const [markSigner, setMarkSigner] = useState(1);
  const [markLabel, setMarkLabel] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try {
      const t = await contractsApi.template(tid);
      setTpl(t);
      setTitle(t.name);
      setLabels(t.category);
      setBody(substitute(t.body, {}));
    } catch (e) {
      const m = e instanceof Error ? e.message : '서식 조회 실패';
      if (/비활성/.test(m)) setDisabled(true); else setError(m);
    } finally { setLoading(false); }
  }, [tid]);
  useEffect(() => { void load(); }, [load]);

  const applyFields = () => {
    if (!tpl) return;
    if (bodyDirty && !window.confirm('본문을 직접 수정했습니다. 필드값으로 본문을 다시 생성하면 수정 내용이 덮어써집니다. 계속할까요?')) return;
    const next = substitute(tpl.body, values);
    setBody(next);
    editorRef.current?.setDocFromText(next);
    setBodyDirty(false);
  };

  /** 마커 토큰을 커서 위치에 단독 문단으로 삽입 — [서명란#N] / [입력란#N:라벨] */
  const insertMarker = (token: string) => {
    editorRef.current?.insertBlockText(token);
    setBody(editorRef.current?.getPlainText() ?? body);
    setBodyDirty(true);
  };

  // 순번은 **생성 시와 동일하게** 지정된 행(ref 입력)만 기준으로 매긴다 — 빈 행을 세면 배치한 마크의
  // 서명자 번호가 실제 참가자 순번과 어긋나 손글씨·기재값이 합성되지 않는다(new 폼과 동일 규칙).
  const filledRows = () => rows.filter((r) => r.ref.trim());
  const composeSigners = () => filledRows().map((r, i) => ({ order: i + 1, displayName: r.displayName.trim() || r.ref.trim() || `${i + 1}번 서명자` }));

  /** 미리보기·배치 — 본문(텍스트 마커 포함) 기본 PDF 를 조판해 전체화면 배치 편집기로 오픈. */
  const openPlacement = async () => {
    setBusy('preview'); setError('');
    try {
      setBaseBytes(await contractsApi.compose(title.trim() || '(제목 없음)', body, composeSigners(), undefined, editorRef.current?.getBlocks()));
      setPlacementOpen(true);
    } catch (e) { setError(e instanceof Error ? e.message : '미리보기 실패'); }
    finally { setBusy(null); }
  };

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

  const create = async () => {
    setError('');
    const signers: ContractSignerItem[] = rows
      .filter((r) => r.ref.trim())
      .map((r, i) => ({
        kind: r.kind,
        displayName: r.displayName.trim() || r.ref.trim(),
        order: i + 1,
        ...(r.kind === 'INTERNAL' ? { username: r.ref.trim() } : { email: r.ref.trim() }),
      }));
    if (signers.length === 0) { setError('서명자가 최소 1명 필요합니다'); return; }
    const badEmail = signers.find((s) => s.kind === 'EXTERNAL' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email ?? ''));
    if (badEmail) { setError(`외부 서명자 이메일 형식 오류: ${badEmail.email}`); return; }
    if (body.includes('＿＿＿＿') && !window.confirm('본문에 채워지지 않은 공란(＿＿＿＿)이 있습니다. 그대로 진행할까요?')) return;

    setBusy('create');
    try {
      const bytes = await contractsApi.compose(title.trim() || '(제목 없음)', body, composeSigners(), marks, editorRef.current?.getBlocks()); // 최종본 조판(리치 블록+자유 배치)
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      const dto = await contractsApi.create({
        idempotencyKey: `cttpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        externalDocId: `${tid}:${Date.now()}`,
        title: title.trim() || '(제목 없음)',
        documentHash: hash,
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        ...(tpl?.category ? { category: tpl.category } : {}), // 서식 분류를 계약 카테고리로
        ...(accessCode.trim() ? { accessCode: accessCode.trim() } : {}),
        signingMode,
        ...(marks.length ? { signMarks: marks } : {}), // 서명란 좌표 — 서명 후 손글씨 합성
        signers,
      });
      await contractsApi.uploadDocument(dto.requestId, bytes);
      router.push('/admin/contracts/' + dto.requestId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '계약 생성 실패');
      setBusy(null);
    }
  };

  if (loading) return <AdminLayout title="서식으로 작성"><div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div></AdminLayout>;
  if (disabled) return (
    <AdminLayout title="서식으로 작성">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );
  if (!tpl) return (
    <AdminLayout title="서식으로 작성">
      <Button onClick={() => router.push('/admin/contracts/templates')} variant="ghost" size="sm">← 계약 서식</Button>
      <div style={{ marginTop: 16 }}><Alert type="error" message={error || '서식 없음'} /></div>
    </AdminLayout>
  );

  return (
    <AdminLayout title={`서식으로 작성 — ${tpl.name}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 920 }}>
        <Button onClick={() => router.push('/admin/contracts/templates')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>← 계약 서식</Button>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}

        <Card>
          <CardHeader title="1. 계약 내용 입력" description="필드를 채우고 [본문에 반영]을 누르면 아래 본문이 완성됩니다. 본문은 자유롭게 직접 수정할 수 있습니다." />
          <CardBody>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-3)' }}>
              {tpl.fields.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`tf-${f.key}`} required={f.required}>
                  {f.type === 'textarea' ? (
                    <Textarea id={`tf-${f.key}`} rows={2} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  ) : (
                    <Input id={`tf-${f.key}`} type={f.type === 'date' ? 'date' : 'text'} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <Button onClick={applyFields} variant="primary" size="sm">본문에 반영</Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="2. 계약서 본문"
            description="완성된 본문 — 필요한 조항을 직접 수정·추가하세요. PDF는 이 본문 그대로 생성됩니다."
            actions={<Button onClick={openPlacement} variant="ghost" size="sm" loading={busy === 'preview'}>{baseBytes ? '미리보기 새로고침' : 'PDF 미리보기·위치 배치'}</Button>}
          />
          <CardBody>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-secondary,#f8fafc)' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>문서에 표시:</span>
              <Select value={String(markSigner)} onChange={(e) => setMarkSigner(Number(e.target.value))} aria-label="마커 대상 서명자" style={{ width: 170 }}>
                {filledRows().map((r, i) => (
                  <option key={i} value={i + 1}>{i + 1}번 · {r.displayName.trim() || r.ref.trim() || (r.kind === 'EXTERNAL' ? '외부 서명자' : '내부 서명자')}</option>
                ))}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => insertMarker(`[서명란#${markSigner}]`)}>✍ 서명란 삽입</Button>
              <Input value={markLabel} onChange={(e) => setMarkLabel(e.target.value)} placeholder="입력란 라벨(예: 연락처)" aria-label="입력란 라벨" style={{ width: 160 }} />
              <Button size="sm" variant="ghost" onClick={() => { insertMarker(`[입력란#${markSigner}:${markLabel.trim() || '기재란'}]`); setMarkLabel(''); }}>␣ 입력란 삽입</Button>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>커서 위치에 삽입 — PDF에 서명 위치·기재란 박스로 표시됩니다</span>
            </div>
            <ContractBodyEditor
              ref={editorRef}
              initialText={body}
              onUpdate={(plain) => { setBody(plain); setBodyDirty(true); }}
            />
            {baseBytes && (
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="primary" size="sm" onClick={() => setPlacementOpen(true)}>배치 편집기 열기 (전체화면)</Button>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  서명란·입력란 배치 {marks.length}개{marks.length > 0 ? ' — 최종 PDF에 박스로 표시됩니다' : ' — 전체화면에서 클릭·드래그로 배치하세요'}. 본문 수정 시 [미리보기 새로고침] 후 확인.
                </span>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="3. 계약 정보·서명자" description="외부=이메일 발송(포털 서명), 내부=콘솔 계정 서명. 인증서는 자동발급됩니다." />
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Field label="계약 제목" required htmlFor="tpl-title"><Input id="tpl-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="라벨" htmlFor="tpl-labels" hint="쉼표로 구분"><Input id="tpl-labels" value={labels} onChange={(e) => setLabels(e.target.value)} /></Field>
              <Field label="접근암호(선택)" htmlFor="tpl-code" hint="외부 서명자 열람·서명 전 확인(별도 채널로 전달)">
                <Input id="tpl-code" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="서명 방식" htmlFor="tpl-mode" hint={signingMode === 'SEQUENTIAL' ? '위에서부터 순서대로 서명(앞 사람 완료 전 차단)' : '전원이 순서 없이 동시에 서명 가능'}>
                <Select id="tpl-mode" value={signingMode} onChange={(e) => setSigningMode(e.target.value as 'SEQUENTIAL' | 'PARALLEL')}>
                  <option value="SEQUENTIAL">순차 서명 (지정 순서대로)</option>
                  <option value="PARALLEL">동시 서명 (전원 병렬)</option>
                </Select>
              </Field>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {rows.map((r, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 110px 1fr 1.4fr 92px', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{signingMode === 'PARALLEL' ? '동시' : `${i + 1}차`}</span>
                    <Select value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as SignerRow['kind'], ref: '' })} aria-label={`${i + 1}번 서명자 구분`}>
                      <option value="EXTERNAL">외부</option>
                      <option value="INTERNAL">내부</option>
                    </Select>
                    <Input value={r.displayName} onChange={(e) => setRow(i, { displayName: e.target.value })} placeholder="표시명" aria-label={`${i + 1}번 표시명`} />
                    <Input value={r.ref} onChange={(e) => setRow(i, { ref: e.target.value })} placeholder={r.kind === 'EXTERNAL' ? '이메일(발송 수신)' : '콘솔 계정(username)'} aria-label={`${i + 1}번 ${r.kind === 'EXTERNAL' ? '이메일' : '계정'}`} />
                    <div style={{ display: 'flex', gap: 2 }}>
                      <Button onClick={() => moveRow(i, -1)} variant="ghost" size="sm" aria-label={`${i + 1}번 위로`} disabled={i === 0 || signingMode === 'PARALLEL'}>↑</Button>
                      <Button onClick={() => moveRow(i, 1)} variant="ghost" size="sm" aria-label={`${i + 1}번 아래로`} disabled={i === rows.length - 1 || signingMode === 'PARALLEL'}>↓</Button>
                      <Button onClick={() => removeRow(i)} variant="ghost" size="sm" aria-label={`${i + 1}번 삭제`} disabled={rows.length <= 1}>✕</Button>
                    </div>
                  </div>
                ))}
                <Button onClick={addRow} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>+ 서명자 추가</Button>
              </div>
            </div>
          </CardBody>
        </Card>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={create} loading={busy === 'create'} variant="primary">PDF 생성 후 계약 만들기</Button>
          <Button onClick={() => router.push('/admin/contracts/templates')} variant="ghost">취소</Button>
        </div>
      </div>

      <PdfPlacementModal
        open={placementOpen}
        onClose={() => setPlacementOpen(false)}
        title={`서명란·입력란 배치 — ${title || tpl.name}`}
        pdfBytes={baseBytes}
        signers={filledRows().map((r, i) => ({ order: i + 1, displayName: r.displayName.trim() || r.ref.trim() || `${i + 1}번 서명자`, kind: r.kind }))}
        marks={marks}
        onChange={setMarks}
      />
    </AdminLayout>
  );
}
