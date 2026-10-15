'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { contractsApi, authStorage } from '@/lib/api';
import { ContractTemplateMeta } from '@/types/api';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';

/**
 * 계약 서식 갤러리 — 내장 샘플(근로·용역·NDA·구매)에서 골라 에디터로 작성.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function ContractTemplatesPage() {
  const router = useRouter();
  const [items, setItems] = useState<ContractTemplateMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);

  const [busy, setBusy] = useState(false);
  // 서식 쓰기 권한(D4) — 백엔드는 contracts:templates 스코프(admin 역할)만 허용한다.
  // role 이 null 이면 기계키 세션(브레이크글라스) — 서버 판정에 맡기고 노출한다.
  const [canEditTemplates, setCanEditTemplates] = useState(false);
  useEffect(() => { const r = authStorage.getRole(); setCanEditTemplates(r === null || r === 'admin'); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDisabled(false);
    try { setItems(await contractsApi.templates()); }
    catch (e) {
      const m = e instanceof Error ? e.message : '조회 실패';
      if (/비활성/.test(m)) setDisabled(true); else setError(m);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const duplicate = async (id: string) => {
    setBusy(true); setError('');
    try { const t = await contractsApi.templateDuplicate(id); router.push(`/admin/contracts/templates/edit/${t.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : '복제 실패'); setBusy(false); }
  };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`커스텀 서식 "${name}"을(를) 삭제할까요?`)) return;
    try { await contractsApi.templateDelete(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '삭제 실패'); }
  };
  const reset = async (id: string, name: string) => {
    if (!window.confirm(`내장 서식 "${name}"의 기관 편집본을 삭제하고 기본값으로 되돌릴까요?`)) return;
    try { await contractsApi.templateReset(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '복원 실패'); }
  };

  if (disabled) return (
    <AdminLayout title="계약 서식">
      <Alert type="info" message="일반 전자계약 기능이 비활성 상태입니다(GENERAL_CONTRACTS 미설정)." />
    </AdminLayout>
  );

  return (
    <AdminLayout title="계약 서식">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: 0, flex: 1, minWidth: 260 }}>
            표준 샘플 서식을 선택해 내용을 채우면 한글 PDF 계약서가 생성되고, 바로 서명자 지정·발송까지 이어집니다.
            내장 서식은 <strong>편집</strong>(기관 버전으로 저장, 언제든 <strong>기본값 복원</strong> 가능)하거나 <strong>복제</strong>할 수 있고,
            기관 맞춤 서식은 <strong>새 서식 만들기</strong>로 직접 등록할 수 있습니다. 모든 편집은 <strong>버전 이력</strong>으로 남아 되돌릴 수 있습니다.
          </p>
          {canEditTemplates && <Button variant="primary" onClick={() => router.push('/admin/contracts/templates/edit/new')} disabled={busy}>새 서식 만들기</Button>}
        </div>
        {error && <Alert type="error" message={error} onClose={() => setError('')} />}
        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {items.map((t) => (
              <Card key={t.id}>
                <CardBody>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 999, background: 'var(--color-bg-secondary,#f3f4f6)', color: 'var(--color-text-secondary)' }}>{t.category}</span>
                      {t.builtin
                        ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--color-bg-secondary,#eef2ff)', color: 'var(--color-text-muted)' }}>내장</span>
                        : <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--color-success-bg,#dcfce7)', color: 'var(--color-success-text,#166534)' }}>커스텀</span>}
                      {t.overridden && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--color-warning-bg,#fef3c7)', color: 'var(--color-warning-text,#92400e)' }}>기관 편집본</span>}
                    </div>
                    <strong style={{ fontSize: 15 }}>{t.name}</strong>
                    <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, flex: 1 }}>{t.description}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button variant="primary" size="sm" onClick={() => router.push(`/admin/contracts/templates/${t.id}`)}>이 서식으로 작성</Button>
                      {/* 서식 편집은 별도 권한(contracts:templates — admin) — 없는 역할에는 노출하지 않는다(D4) */}
                      {canEditTemplates && <Button variant="ghost" size="sm" onClick={() => router.push(`/admin/contracts/templates/edit/${t.id}`)}>편집</Button>}
                      {canEditTemplates && (t.builtin
                        ? <>
                            <Button variant="ghost" size="sm" onClick={() => duplicate(t.id)} disabled={busy}>복제</Button>
                            {t.overridden && <Button variant="ghost" size="sm" onClick={() => reset(t.id, t.name)}>기본값 복원</Button>}
                          </>
                        : <Button variant="ghost" size="sm" onClick={() => remove(t.id, t.name)}>삭제</Button>)}
                    </div>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
