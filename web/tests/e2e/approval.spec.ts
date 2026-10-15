import { test, expect } from '@playwright/test';
import { loginUI, seedApproval } from './_helpers';

/**
 * 전자결재(상신→결재) 콘솔 UI E2E — 결재함·결재선·결재 액션·통합 인증로그.
 * 백엔드 플래그 ELECTRONIC_APPROVAL=on (playwright.config.ts).
 */
test.describe('전자결재(상신→결재)', () => {
  test('결재함 → 결재선 → 승인 → 통합 인증로그', async ({ page, request }) => {
    const { title } = await seedApproval(request, { title: '진료 동의 결재(UI)' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible(); // 세션 확립 대기

    // 결재함 목록
    await page.goto('/admin/approvals');
    await expect(page.getByRole('heading', { name: '결재함' })).toBeVisible();
    await page.getByText(title).click();

    // 상세: 결재선 + 상신 인증로그
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('과장').first()).toBeVisible();
    await page.getByRole('tab', { name: /통합 인증로그/ }).click();
    await expect(page.getByText('APPROVAL_SUBMITTED')).toBeVisible();

    // order1(과장=root) 승인 — 비최종·비고위험 → step-up 불요
    await page.getByRole('button', { name: '승인', exact: true }).click(); // 헤더 액션 → 모달
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '승인', exact: true }).click();
    await expect(page.getByText(/승인 완료/)).toBeVisible();

    // 인증로그에 APPROVAL_APPROVED 봉인
    await page.getByRole('tab', { name: /통합 인증로그/ }).click();
    await expect(page.getByText('APPROVAL_APPROVED')).toBeVisible();
  });

  test('통합 인증로그 뷰 → 전체 결재 로그 표시', async ({ page, request }) => {
    const { title } = await seedApproval(request, { title: '통합로그 결재' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/approval-audit');
    await expect(page.getByRole('heading', { name: '전자결재 인증로그' })).toBeVisible();
    await expect(page.getByText('APPROVAL_SUBMITTED').first()).toBeVisible();
    await expect(page.getByText(title).first()).toBeVisible(); // 소속 결재 문서 표기
  });
});
