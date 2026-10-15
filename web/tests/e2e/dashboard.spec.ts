import { test, expect } from '@playwright/test';
import { loginUI, seedRequest } from './_helpers';

/**
 * 서명요청 대시보드 UI(I1·I2) — 목록 렌더·검색·상태 필터·CSV 내보내기.
 * 대응 백엔드 e2e: search.e2e / pagination.e2e / export-csv.e2e (이 spec 은 브라우저 경로를 검증).
 */
test.describe('서명요청 대시보드', () => {
  const titleA = `통합테스트 동의서 ${Date.now()}A`;
  const titleB = `통합테스트 동의서 ${Date.now()}B`;

  test.beforeAll(async ({ request }) => {
    await seedRequest(request, { title: titleA });
    await seedRequest(request, { title: titleB });
  });

  test('시드 요청이 목록에 표시된다', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await expect(page.getByText(titleA)).toBeVisible();
    await expect(page.getByText(titleB)).toBeVisible();
  });

  test('검색으로 단일 요청만 필터링', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByText(titleA)).toBeVisible();
    await page.getByLabel('서명요청 검색').fill(titleA);
    await expect(page.getByText(titleB)).toHaveCount(0);
    await expect(page.getByText(titleA)).toBeVisible();
  });

  test('상태 필터 UI가 존재하고 동작한다', async ({ page }) => {
    await loginUI(page);
    const statusFilter = page.getByLabel('상태 필터');
    await expect(statusFilter).toBeVisible();
    await statusFilter.selectOption('COMPLETED');
    // 시드 요청은 미완료(CREATED) 이므로 완료 필터 시 사라진다
    await expect(page.getByText(titleA)).toHaveCount(0);
  });

  test('CSV 내보내기 → 다운로드 트리거', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByText(titleA)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV 내보내기' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });
});
