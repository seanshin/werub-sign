import { test, expect } from '@playwright/test';
import { createUser, loginUI, totpNow } from './_helpers';

/**
 * 2단계 인증(TOTP) UI(G4u) — 내 계정에서 등록·활성화 → 재로그인 시 코드 요구 → 검증.
 * 전용 계정에 적용(root 는 MFA 미사용 유지: 다른 spec 영향 차단).
 * 대응 백엔드 e2e: mfa-2fa.e2e (이 spec 은 등록/로그인 브라우저 경로를 검증).
 */
test.describe('2단계 인증(TOTP)', () => {
  const user = `mfauser${Date.now()}`;
  const pass = 'mfa-pass-12345';

  test.beforeAll(async ({ request }) => {
    await createUser(request, user, pass, 'operator');
  });

  test('등록 → 활성화 → 재로그인 코드 검증', async ({ page }) => {
    // 1) 로그인 후 내 계정에서 2FA 설정 시작(세션 저장 완료까지 대시보드 진입 대기)
    await loginUI(page, user, pass);
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible(); // operator 랜딩 = 계약 현황
    await page.goto('/admin/account');
    await page.getByRole('button', { name: '2단계 인증 설정' }).click();

    // 2) 표시된 수동 키(시크릿) 읽기 → 코드 계산 → 활성화
    const secret = (await page.getByText('수동 키:').locator('code').textContent())?.trim() || '';
    expect(secret.length).toBeGreaterThan(10);
    await page.getByLabel('인증앱 6자리 코드').fill(totpNow(secret));
    await page.getByRole('button', { name: '활성화', exact: true }).click();

    // 3) 복구코드가 노출되고 활성화 안내가 보인다
    await expect(page.getByText('2단계 인증이 활성화되었습니다', { exact: false })).toBeVisible();

    // 4) 로그아웃 후 재로그인 → 2차 인증 단계 등장
    await page.goto('/admin/account');
    await page.getByRole('button', { name: '로그아웃' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);

    await loginUI(page, user, pass);
    const codeField = page.getByLabel('인증 코드');
    await expect(codeField).toBeVisible();

    // 5) 인증앱 코드 입력 → 콘솔 진입(operator 랜딩 = 계약 현황)
    await codeField.fill(totpNow(secret));
    await page.getByRole('button', { name: '인증하고 로그인' }).click();
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible();
  });
});
