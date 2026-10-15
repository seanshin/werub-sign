import { test, expect } from '@playwright/test';
import { loginUI, CREDS } from './_helpers';

/**
 * 관리자 인증 UI(G1·G3) — 로그인 성공/실패, 보호 라우트 리다이렉트, 로그아웃.
 * 대응 백엔드 e2e: rbac.e2e / session-registry.e2e (이 spec 은 브라우저 경로를 검증).
 */
test.describe('관리자 인증', () => {
  test('유효 자격증명 → 대시보드 진입', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('잘못된 비밀번호 → 오류 표시·로그인 화면 유지', async ({ page }) => {
    await loginUI(page, CREDS.user, 'wrong-password');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('미인증 보호 라우트 접근 → 로그인으로 리다이렉트', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('로그아웃 → 로그인 화면 전환', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.getByRole('button', { name: '로그아웃' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
