import { test, expect } from '@playwright/test';
import { loginUI } from './_helpers';

/**
 * 소비자(기계 연동) 등록/관리 콘솔 UI E2E — 콘솔에서 신규 consumer 발급·스코프·상태.
 * root(admin) 세션은 ca:admin 보유 → 소비자 관리 접근.
 */
test.describe('소비자 등록/관리', () => {
  test('등록 → 1회 키 발급 → 목록 등장 → 일시중지', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/consumers');
    await expect(page.getByRole('heading', { name: /소비자 관리/ })).toBeVisible();

    // 등록 모달
    await page.getByRole('button', { name: '새 소비자 등록' }).click();
    const dialog = page.getByRole('dialog');
    // 회귀: 한 글자씩 입력해도 포커스가 ✕로 튀지 않아야 함(전체 값 입력·포커스 유지)
    const nameInput = dialog.getByLabel('소비자 이름');
    await nameInput.click();
    await nameInput.pressSequentially('werbui', { delay: 30 });
    await expect(nameInput).toHaveValue('werbui');
    await expect(nameInput).toBeFocused();
    await dialog.getByRole('checkbox', { name: 'approval:write' }).check();
    await dialog.getByRole('button', { name: '등록', exact: true }).click();

    // 1회 키 노출
    await expect(dialog.getByText(/1회만 표시/)).toBeVisible();
    await expect(dialog.getByText(/^sk_/)).toBeVisible();
    await dialog.getByRole('button', { name: '확인' }).click();

    // 목록 등장 + '등록' 구분 배지
    const row = page.getByRole('row', { name: /werbui/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('등록', { exact: true })).toBeVisible();

    // 관리 → 일시중지
    await row.getByRole('button', { name: '관리' }).click();
    const mdlg = page.getByRole('dialog');
    await mdlg.getByRole('button', { name: '일시중지' }).click();
    await expect(page.getByText(/일시중지/)).toBeVisible();
  });
});
