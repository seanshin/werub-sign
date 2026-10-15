import { test, expect } from '@playwright/test';
import { loginUI, seedAuditEvent } from './_helpers';

/**
 * 인증 행위 로그 디테일(로그 뷰 강화) — 행 확장 전체 data·entryHash, 무결성 배지, 필터, CSV.
 * 대응 백엔드: audit-events(해시체인). 이 spec 은 디테일 뷰 경로를 검증.
 */
test.describe('인증 행위 로그 디테일', () => {
  const ts = Date.now();
  const actorA = `drkim${ts}`;
  const refB = `PB-${ts}`;

  test.beforeAll(async ({ request }) => {
    await seedAuditEvent(request, { action: 'PRESCRIBE', actor: actorA, targetType: 'patient', targetRef: `PA-${ts}`, data: { memo: `alpha${ts}` } });
    await seedAuditEvent(request, { action: 'READ_APPROVE', actor: `drlee${ts}`, targetType: 'study', targetRef: refB, data: { memo: `beta${ts}` } });
  });

  test('행 확장 상세 + entryHash + 무결성 배지 + 필터 + CSV', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/event-log');

    // 임상행위 스트림 선택
    await page.getByRole('button', { name: /임상행위/ }).click();

    // 무결성 자동 검증 배지
    await expect(page.getByText(/체인 무결성/)).toBeVisible();

    // 행 등장 + entryHash 컬럼(축약 해시 …)
    const rowA = page.getByRole('row', { name: new RegExp(actorA) });
    await expect(rowA).toBeVisible();
    await expect(rowA).toContainText('…'); // shortHash

    // 행 클릭 → 상세(LogDetail): data 키·값 + 해시(LogDetail 고유 라벨로 확장 확인)
    await rowA.click();
    await expect(page.getByText('데이터(data)')).toBeVisible();
    await expect(page.getByText('prevHash')).toBeVisible();
    await expect(page.getByRole('cell', { name: `alpha${ts}`, exact: true })).toBeVisible(); // data.memo

    // 현재 페이지 필터 → A만
    await page.getByLabel('행위 로그 검색').fill(actorA);
    await expect(page.getByText(refB)).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(actorA) })).toBeVisible();

    // CSV 내보내기
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV 내보내기' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/행위로그.*\.csv$/i);
  });
});
