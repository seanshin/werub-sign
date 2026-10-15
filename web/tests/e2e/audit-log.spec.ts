import { test, expect } from '@playwright/test';
import { loginUI } from './_helpers';

/**
 * 감사·로그 — 관리자 감사 스트림 노출(admin:auth/users) + 행 확장·무결성(로그 뷰 강화).
 * 로그인 자체가 admin:auth LOGIN 을 기록 → 그 엔트리를 디테일로 확인.
 * 대응 백엔드: admin-audit.controller(users:admin).
 */
test.describe('감사·로그 — 관리자 감사', () => {
  test('관리자 감사 섹션 + LOGIN 행 확장(행위자·IP·해시) + 무결성', async ({ page }) => {
    await loginUI(page); // root=admin → admin:auth LOGIN 기록
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/audit-log');

    // 관리자 감사 카드(admin 한정)
    await expect(page.getByRole('heading', { name: /관리자 감사/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /로그인·인증/ })).toBeVisible();

    // 무결성 배지
    await expect(page.getByText(/체인 무결성/)).toBeVisible();

    // LOGIN 행 등장 + 행위자 user:root
    const loginRow = page.getByRole('row', { name: /LOGIN/ }).first();
    await expect(loginRow).toBeVisible();
    await expect(loginRow).toContainText('user:root');

    // 행 확장 → 상세(data: ip·role + entryHash/prevHash)
    await loginRow.click();
    await expect(page.getByText('데이터(data)')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'prevHash', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ip', exact: true })).toBeVisible();
  });
});
