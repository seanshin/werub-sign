import { test, expect } from '@playwright/test';
import { loginUI, enrollCert } from './_helpers';

/**
 * 콘솔 화면 커버리지 — 연동설정·인증서목록·감사로그(접근·렌더·핵심 상호작용).
 * 대응 백엔드 e2e: integration-settings / increment(인증서) / increment11(감사). 이 spec 은 화면 경로 검증.
 */
test.describe('콘솔 화면', () => {
  test('연동 설정 화면 렌더', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/integrations');
    await expect(page.getByRole('heading', { name: '연동 설정' })).toBeVisible();
  });

  test('인증서 목록 — 발급 인증서 노출·검색·CSV', async ({ page, request }) => {
    const cn = `uicert${Date.now()}`;
    await enrollCert(request, cn);

    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/certificates-list');
    await expect(page.getByRole('heading', { name: '인증서 목록·관리' })).toBeVisible();

    // 발급 인증서가 검색으로 노출
    await page.getByPlaceholder('시리얼·주체·유형·면허 검색(전체)').fill(cn);
    await expect(page.getByText(cn)).toBeVisible();

    // CSV 내보내기 → 다운로드 트리거
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV 내보내기' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });

  test('감사·로그 화면 렌더(CA 회전 이력)', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/audit-log');
    await expect(page.getByRole('heading', { name: '감사·로그' })).toBeVisible();
    await expect(page.getByText('CA 회전 이력', { exact: false })).toBeVisible();
  });
});
