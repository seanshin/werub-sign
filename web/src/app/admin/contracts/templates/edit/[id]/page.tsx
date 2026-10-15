'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 서식 편집기 — 리치 에디터(TipTap: 정렬·목록·표)로 내장/커스텀 서식 편집.
 * 내장 서식은 오버라이드로 저장(원본 보존·기본값 복원 가능), 버전 이력 20건.
 * 서식 쓰기는 contracts:templates(admin 전용) — viewer/operator 는 읽기만.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { contractsApi } from '@/lib/api';
import { ContractTemplateField, TemplateVersion } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { Field, Input, Select } from '@/components/ui/Field';

const FIELD_TYPES = [
  { value: 'text', label: '한 줄 텍스트' },
  { value: 'textarea', label: '여러 줄 텍스트' },
  { value: 'date', label: '날짜' },
  { value: 'money', label: '금액' },
] as const;
const CATEGORIES = ['근로', '의료인력', '용역', '임대차', '구매', '보안', '협약', '보건행정', '기타'];
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/; // 백엔드 validate 와 동일(영문 시작 영숫자)

const BODY_HINT = `본문에 입력 필드는 {{키}} 로 넣습니다(아래 필드 목록의 key와 일치해야 저장됩니다).
서명 위치는 별도 줄에 [서명란#1] (1번 서명자), 기재란은 [입력란#1:라벨] 로 표시할 수 있습니다.`;

/** 계약 서식 편집기 — 내장(오버라이드 저장)·커스텀 모두 편집. id='new' 는 새 서식. */
export default function TemplateEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const isNew = id === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [builtin, setBuiltin] = useState(false);
  const [overridden, setOverridden] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('기타');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<ContractTemplateField[]>([{ key: '', label: '', type: 'text' }]);
  const [body, setBody] = useState('새 서식 제목\n\n제1조 (목적) \n');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<TemplateVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const loadHistory = useCallback(async () => {
    if (isNew) return;
    try { setHistory(await contractsApi.templateHistory(id)); } catch { /* 이력 없음 무시 */ }
  }, [id, isNew]);

  const load = useCallback(async () => {
    if (isNew) return;
    setLoading(true); setError('');
    try {
      const t = await contractsApi.template(id);
      setBuiltin(!!t.builtin); setOverridden(!!t.overridden);
      setName(t.name); setCategory(t.category || '기타'); setDescription(t.description || '');
      setFields(t.fields.length ? t.fields : [{ key: '', label: '', type: 'text' }]);
      setBody(t.body);
    } catch (e) { setError(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, [id, isNew]);
  useEffect(() => { void load(); void loadHistory(); }, [load, loadHistory]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const setField = (i: number, patch: Partial<ContractTemplateField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, { key: '', label: '', type: 'text' }]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, j) => j !== i));

  // ── 본문 {{키}} ↔ 필드 정합성 실시간 검증 ────────────────────────────────
  const validation = useMemo(() => {
    const tokens = Array.from(new Set(Array.from(body.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1])));
    const keyList = fields.map((f) => f.key.trim()).filter(Boolean);
    const keySet = new Set(keyList);
    const undefinedTokens = tokens.filter((t) => !keySet.has(t)); // 본문엔 있으나 필드 없음(치환 안 됨)
    const unusedFields = keyList.filter((k) => !tokens.includes(k)); // 필드는 있으나 본문 미사용
    const dupKeys = Array.from(new Set(keyList.filter((k, i) => keyList.indexOf(k) !== i)));
    const invalidKeys = Array.from(new Set(keyList.filter((k) => !KEY_RE.test(k))));
    return { tokens, undefinedTokens, unusedFields, dupKeys, invalidKeys };
  }, [body, fields]);
  const hasErrors = validation.undefinedTokens.length > 0 || validation.dupKeys.length > 0 || validation.invalidKeys.length > 0;

  // 본문의 미정의 {{키}} 를 필드로 자동 추가
  const extractFields = () => {
    const existing = new Set(fields.map((f) => f.key.trim()).filter(Boolean));
    const add = validation.undefinedTokens.filter((t) => KEY_RE.test(t) && !existing.has(t)).map((t) => ({ key: t, label: t, type: 'text' as const }));
    if (!add.length) { setNotice('추가할 미정의 필드가 없습니다.'); return; }
    setFields((fs) => [...fs.filter((f) => f.key.trim()), ...add]);
    setNotice(`${add.length}개 필드를 본문에서 추출했습니다.`);
  };

  // 커서 위치(또는 끝)에 마커/텍스트 삽입
  const insert = (text: string) => {
    const ta = bodyRef.current;
    if (!ta) { setBody((b) => b + '\n' + text); return; }
    const s = ta.selectionStart ?? body.length;
    const e = ta.selectionEnd ?? body.length;
    const next = body.slice(0, s) + text + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => { ta.focus(); const pos = s + text.length; ta.setSelectionRange(pos, pos); });
  };

  const payload = () => ({
    name: name.trim(),
    category,
    description: description.trim(),
    // required 를 함께 전송 — 빠뜨리면 서버 기본값(`f.required !== false`)이 적용되어
    // 선택 필드가 저장만 해도 필수로 뒤집힌다(R15).
    fields: fields.filter((f) => f.key.trim()).map((f) => ({ key: f.key.trim(), label: f.label.trim() || f.key.trim(), type: f.type, placeholder: f.placeholder, required: f.required !== false })),
    body,
  });

  const save = async () => {
    setBusy(true); setError('');
    try {
      const p = payload();
      if (isNew) await contractsApi.templateCreate(p);
      else await contractsApi.templateUpdate(id, p);
      router.push('/admin/contracts/templates');
    } catch (e) { setError(e instanceof Error ? e.message : '저장 실패'); setBusy(false); }
  };

  const resetBuiltin = async () => {
    if (!window.confirm('이 내장 서식의 기관 편집본을 삭제하고 기본값으로 되돌릴까요?')) return;
    setBusy(true); setError('');
    try { await contractsApi.templateReset(id); await load(); await loadHistory(); setNotice('기본값으로 복원했습니다.'); }
    catch (e) { setError(e instanceof Error ? e.message : '복원 실패'); }
    finally { setBusy(false); }
  };

  const restore = async (version: number) => {
    if (!window.confirm(`버전 v${version} 내용으로 되돌릴까요? 현재 내용은 이력에 보관됩니다.`)) return;
    setBusy(true); setError('');
    try { await contractsApi.templateRestore(id, version); await load(); await loadHistory(); setNotice(`v${version} 내용으로 되돌렸습니다.`); }
    catch (e) { setError(e instanceof Error ? e.message : '되돌리기 실패'); }
    finally { setBusy(false); }
  };

  const preview = async () => {
    setBusy(true); setError('');
    try {
      let text = body;
      for (const f of fields) if (f.key.trim()) text = text.split(`{{${f.key.trim()}}}`).join(`〈${f.label.trim() || f.key.trim()}〉`);
      const buf = await contractsApi.compose(name.trim() || '서식 미리보기', text, [{ order: 1, displayName: '서명자1' }, { order: 2, displayName: '서명자2' }]);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })));
    } catch (e) { setError(e instanceof Error ? e.message : '미리보기 실패'); }
    finally { setBusy(false); }
  };

  if (loading) return <AdminLayout title="서식 편집"><div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div></AdminLayout>;

  return (
    <AdminLayout title={isNew ? '새 서식 만들기' : builtin ? '내장 서식 편집' : '서식 편집'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Button onClick={() => router.push('/admin/contracts/templates')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }}>← 서식 목록</Button>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {notice && <Alert type="success" message={notice} onClose={() => setNotice('')} />}
        {builtin && (
          <Alert type="info" message={`내장 서식입니다. 저장하면 코드 원본은 보존한 채 기관 편집본(오버라이드)으로 저장되며, 언제든 "기본값 복원"으로 되돌릴 수 있습니다.${overridden ? ' 현재 기관 편집본이 적용 중입니다.' : ''}`} />
        )}

        <Card>
          <CardHeader title="서식 정보" />
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <Field label="서식 이름" required htmlFor="tn"><Input id="tn" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: ○○병원 표준 용역계약서" /></Field>
              <Field label="분류" htmlFor="tc">
                <Select id="tc" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="설명" htmlFor="td"><Input id="td" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="갤러리에 표시될 한 줄 설명" /></Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="입력 필드" description="본문의 {{키}}에 대응하는 입력 항목입니다. key는 영문 시작 영숫자(예: clientName)." />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fields.map((f, i) => {
                const k = f.key.trim();
                const bad = k !== '' && (!KEY_RE.test(k) || validation.dupKeys.includes(k));
                const unused = k !== '' && validation.unusedFields.includes(k);
                return (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Input value={f.key} onChange={(e) => setField(i, { key: e.target.value })} placeholder="key (예: clientName)" aria-label={`${i + 1}번 필드 key`} style={{ width: 180, fontFamily: 'var(--font-mono, monospace)', borderColor: bad ? 'var(--color-danger,#dc2626)' : undefined }} />
                    <Input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="라벨 (예: 위탁기관)" aria-label={`${i + 1}번 필드 라벨`} style={{ width: 200 }} />
                    <Select value={f.type} onChange={(e) => setField(i, { type: e.target.value as ContractTemplateField['type'] })} aria-label={`${i + 1}번 필드 유형`} style={{ width: 150 }}>
                      {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </Select>
                    {unused && <span style={{ fontSize: 11, color: 'var(--color-warning-text,#92400e)' }}>본문 미사용</span>}
                    <Button variant="ghost" size="sm" onClick={() => removeField(i)} aria-label={`${i + 1}번 필드 삭제`}>삭제</Button>
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="ghost" size="sm" onClick={addField}>+ 필드 추가</Button>
                <Button variant="ghost" size="sm" onClick={extractFields} disabled={!validation.undefinedTokens.length}>본문에서 필드 자동 추출{validation.undefinedTokens.length ? ` (${validation.undefinedTokens.length})` : ''}</Button>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* 검증 요약 */}
        {(hasErrors || validation.unusedFields.length > 0) && (
          <Card>
            <CardBody>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                {validation.undefinedTokens.length > 0 && <div style={{ color: 'var(--color-danger,#dc2626)' }}>⚠ 본문에 있으나 필드가 없는 항목(치환 안 됨): {validation.undefinedTokens.map((t) => `{{${t}}}`).join(', ')} — 저장 불가. "필드 자동 추출"을 사용하세요.</div>}
                {validation.invalidKeys.length > 0 && <div style={{ color: 'var(--color-danger,#dc2626)' }}>⚠ key 형식 오류(영문 시작 영숫자만): {validation.invalidKeys.join(', ')}</div>}
                {validation.dupKeys.length > 0 && <div style={{ color: 'var(--color-danger,#dc2626)' }}>⚠ 중복된 key: {validation.dupKeys.join(', ')}</div>}
                {validation.unusedFields.length > 0 && <div style={{ color: 'var(--color-warning-text,#92400e)' }}>· 본문에서 쓰이지 않는 필드: {validation.unusedFields.join(', ')} (경고 — 저장은 가능)</div>}
              </div>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="본문" description="첫 줄은 제목, {{키}}는 입력값으로 치환됩니다." />
          <CardBody>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => insert('\n[서명란#1]')}>+ 서명란#1</Button>
              <Button variant="ghost" size="sm" onClick={() => insert('\n[서명란#2]')}>+ 서명란#2</Button>
              <Button variant="ghost" size="sm" onClick={() => insert('\n[입력란#1:라벨]')}>+ 입력란</Button>
            </div>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={22}
              aria-label="서식 본문"
              style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 13, lineHeight: 1.6, padding: 12, borderRadius: 8, border: '1px solid var(--color-border)', resize: 'vertical' }}
            />
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap', marginTop: 8 }}>{BODY_HINT}</p>
          </CardBody>
        </Card>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={save} loading={busy} disabled={!name.trim() || body.trim().length < 10 || hasErrors}>{isNew ? '서식 등록' : '변경 저장'}</Button>
          <Button variant="ghost" onClick={preview} disabled={busy}>미리보기(PDF)</Button>
          {!isNew && <Button variant="ghost" onClick={() => setShowHistory((v) => !v)} disabled={busy}>변경 이력{history.length ? ` (${history.length})` : ''}</Button>}
          {builtin && overridden && <Button variant="ghost" onClick={resetBuiltin} disabled={busy} style={{ marginLeft: 'auto' }}>기본값 복원</Button>}
        </div>

        {showHistory && !isNew && (
          <Card>
            <CardHeader title="변경 이력" description="변경 직전 스냅샷(최신순). 되돌리면 현재 내용도 이력에 보관됩니다." />
            <CardBody>
              {history.length === 0 ? <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>아직 변경 이력이 없습니다.</p> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {history.map((h) => (
                    <div key={h.version} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                      <span style={{ fontFamily: 'var(--font-mono, monospace)', minWidth: 42 }}>v{h.version}</span>
                      <span style={{ minWidth: 48, color: 'var(--color-text-muted)' }}>{h.action === 'edit' ? '수정' : h.action === 'reset' ? '복원' : '되돌림'}</span>
                      <span style={{ flex: 1, minWidth: 160 }}>{h.name} · {h.category}</span>
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{new Date(h.savedAt).toLocaleString('ko-KR')} · {h.savedBy}</span>
                      <Button variant="ghost" size="sm" onClick={() => restore(h.version)} disabled={busy}>이 버전으로 되돌리기</Button>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )}

        {previewUrl && (
          <Card>
            <CardHeader title="미리보기" description="필드는 〈라벨〉로 표시됩니다(실제 계약 시 입력값으로 치환)." />
            <CardBody>
              <iframe src={previewUrl} title="서식 미리보기" style={{ width: '100%', height: 640, border: '1px solid var(--color-border)', borderRadius: 8, background: '#fff' }} />
            </CardBody>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
