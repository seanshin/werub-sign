import { test, expect } from '@playwright/test';
import { loginUI } from './_helpers';

/**
 * 다중관리자 RBAC 사용자관리 UI(G1) — admin 이 콘솔에서 계정 생성·역할 변경.
 * 대응 백엔드 e2e: rbac.e2e (이 spec 은 관리 화면 경로를 검증).
 */
test.describe('사용자 관리(RBAC)', () => {
  test('admin 계정 생성 → 목록 등장 → 역할 변경', async ({ page }) => {
    const uname = `uiop${Date.now()}`;
    await loginUI(page); // root = admin
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: '사용자 관리' })).toBeVisible();

    // 기존 root 계정 노출(역할 셀렉트)
    await expect(page.getByLabel('root 역할')).toBeVisible();

    // 운영자 계정 생성(이메일 포함)
    await page.getByLabel('아이디').fill(uname);
    await page.getByLabel('비밀번호').fill('newop-pass-123');
    await page.getByLabel('이메일(선택)').fill(`${uname}@example.org`);
    await page.getByLabel('역할', { exact: true }).selectOption('operator');
    await page.getByRole('button', { name: '계정 생성' }).click();

    // 목록에 등장(운영자·이메일) + 성공 안내
    const roleSelect = page.getByLabel(`${uname} 역할`);
    await expect(roleSelect).toBeVisible();
    await expect(roleSelect).toHaveValue('operator');
    await expect(page.getByText(`${uname}@example.org`)).toBeVisible();

    // 이메일 변경(인라인)
    await page.getByRole('button', { name: `${uname} 이메일 수정` }).click();
    await page.getByLabel(`${uname} 이메일`).fill(`${uname}-new@example.org`);
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText(`${uname}-new@example.org`)).toBeVisible();

    // 역할 변경 → 열람자
    await roleSelect.selectOption('viewer');
    await expect(page.getByLabel(`${uname} 역할`)).toHaveValue('viewer');
  });
});
