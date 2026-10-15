import { test, expect } from '@playwright/test';
import { loginUI, seedRequest } from './_helpers';

/**
 * 일괄 철회(I3) — 행 선택 → 선택 철회 → 확인. 선택 건이 철회 상태로 전환된다.
 * 대응 백엔드 e2e: increment16(철회) (이 spec 은 다중 선택·일괄 UI 경로를 검증).
 */
test.describe('일괄 철회', () => {
  const tag = `일괄철회-${Date.now()}`;
  const titleA = `${tag} A`;
  const titleB = `${tag} B`;

  test.beforeAll(async ({ request }) => {
    await seedRequest(request, { title: titleA });
    await seedRequest(request, { title: titleB });
  });

  test('전체 선택 → 선택 철회 → 두 건 모두 철회', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    // 태그로 검색해 대상 2건만 노출
    await page.getByLabel('서명요청 검색').fill(tag);
    await expect(page.getByText(titleA)).toBeVisible();
    await expect(page.getByText(titleB)).toBeVisible();

    // 시드 직후 SSE 자동 재조회(디바운스 1.2s)가 선택을 비우지 않도록 먼저 흘려보냄
    // (선택>0이면 이후 SSE 재조회는 대시보드가 보류). 안정화 후 선택.
    await page.waitForTimeout(1600);
    // 전체 선택 → 선택 철회 → 확인
    await page.getByLabel('전체 선택').check();
    await expect(page.getByText(/2건 선택됨/)).toBeVisible();
    await page.getByRole('button', { name: '선택 철회' }).click();
    await page.getByRole('button', { name: '철회', exact: true }).click();

    // 두 행 모두 철회 상태로 전환(목록 자동 재조회). 행은 클릭 가능한 button 역할로 렌더됨.
    await expect(page.getByRole('button', { name: new RegExp(titleA) })).toContainText('철회');
    await expect(page.getByRole('button', { name: new RegExp(titleB) })).toContainText('철회');
  });
});
