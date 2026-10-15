import { test, expect } from '@playwright/test';
import { loginUI, seedRequest } from './_helpers';

/**
 * 검증 탭 미서명 표시(I6) — v1.5.2 회귀 가드.
 * 서명 0건 요청의 검증 탭은 "검증 실패"가 아니라 중립 "서명 대기 중" 안내를 보여야 한다.
 */
test.describe('서명 검증 탭', () => {
  let requestId = '';
  const title = `검증탭 미서명 ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    ({ requestId } = await seedRequest(request, { title }));
  });

  test('서명 0건 → 중립 "서명 대기 중"(검증 실패 아님)', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/requests/${requestId}`);

    await page.getByRole('tab', { name: '서명 검증' }).click();
    await page.getByRole('button', { name: '검증 실행' }).click();

    await expect(page.getByText('서명 대기 중', { exact: false })).toBeVisible();
    await expect(page.getByText('검증 실패 — 일부 서명에 문제가 있습니다.')).toHaveCount(0);
  });
});
