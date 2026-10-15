import { test, expect } from '@playwright/test';
import { seedPortalRequestWithDoc, seedPortalRequest } from './_helpers';

/**
 * 환자 포털 문서 미리보기(PDF 뷰어) — 설계 docs/02-design/features/portal-document-preview.design.md.
 * 대응 백엔드 e2e: portal-document. 이 spec 은 포털 UI 경로(뷰어·해시 배지·동의 게이트)를 검증.
 */
test.describe('포털 문서 미리보기', () => {
  test('문서 뷰어 + 해시 배지 + 동의 게이트(확인 전 서명 진행 비활성)', async ({ page, request }) => {
    const { token } = await seedPortalRequestWithDoc(request, { title: '수술 동의서(뷰어)' });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '수술 동의서(뷰어)' })).toBeVisible();

    // 문서 뷰어 + 해시 일치 배지
    await expect(page.getByRole('heading', { name: '서명 대상 문서' })).toBeVisible();
    await expect(page.getByText(/표시 문서 = 서명 대상/)).toBeVisible();
    await expect(page.getByTitle('서명 대상 동의서 문서')).toBeVisible(); // iframe
    await expect(page.getByRole('link', { name: /새 탭에서 열기/ })).toBeVisible();

    // 동의 게이트 — 문서 확인 전에는 '서명 진행하기' 비활성
    const proceed = page.getByRole('button', { name: '서명 진행하기' });
    await expect(proceed).toBeDisabled();
    await expect(page.getByText('문서 확인 후 서명을 진행할 수 있습니다.')).toBeVisible();

    // 확인 체크 → 활성 → 진행 → 서명 → 완료
    await page.getByRole('checkbox', { name: '위 문서 내용을 확인했습니다' }).check();
    await expect(proceed).toBeEnabled();
    await proceed.click();
    await page.getByRole('button', { name: '동의하고 서명' }).click();
    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();
  });

  test('문서 미업로드 요청 → 뷰어·게이트 없음(기존 흐름 유지)', async ({ page, request }) => {
    const { token } = await seedPortalRequest(request, { title: '문서없는 동의서' });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '문서없는 동의서' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '서명 대상 문서' })).toHaveCount(0);
    // 게이트 없이 바로 진행 가능
    await expect(page.getByRole('button', { name: '서명 진행하기' })).toBeEnabled();
  });
});
