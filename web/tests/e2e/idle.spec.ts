import { test, expect } from '@playwright/test';
import { loginUI } from './_helpers';

/**
 * 비활동 자동 로그아웃 UI(G2u, EMR 보안성 F004) — 가짜 시계로 idle 경과를 구동.
 * 14분 경과 → 경고 모달, 15분 경과 → 자동 로그아웃·로그인 화면(reason=timeout) 안내.
 * 대응 백엔드 e2e: session-registry(서버측 idle 강제). 이 spec 은 클라이언트 idle 차단 UI 를 검증.
 */
test.describe('비활동 자동 로그아웃', () => {
  test('경고 모달 → 자동 로그아웃(reason=timeout)', async ({ page }) => {
    await page.clock.install();
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    // 14분 경과(만료 60초 전) → 경고 모달
    await page.clock.fastForward('14:05');
    await expect(page.getByText('세션 자동 로그아웃 안내')).toBeVisible();
    await expect(page.getByText('자동으로 로그아웃됩니다', { exact: false })).toBeVisible();

    // 추가 경과 → 자동 로그아웃 → 로그인 화면 + 사유 안내
    await page.clock.fastForward('01:00');
    await expect(page).toHaveURL(/\/admin\/login\?reason=timeout/);
    await expect(page.getByText('자동으로 로그아웃되었습니다', { exact: false })).toBeVisible();
  });
});
