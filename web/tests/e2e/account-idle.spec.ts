import { test, expect } from '@playwright/test';
import { loginUI, createUser } from './_helpers';

/**
 * 내 계정 — 자동 로그아웃(비활동) 시간 설정(F004). 정책 캡 이내에서 사용자 설정.
 * 전용 계정에 적용(root 영향 차단: 공유 백엔드의 idle.spec 등 보호).
 * 대응 백엔드: auth idle-timeout(세션별 idleMs·정책 클램프).
 */
test.describe('내 계정 — 자동 로그아웃 설정', () => {
  const user = `idleuser${Date.now()}`;
  const pass = 'idle-pass-12345';

  test.beforeAll(async ({ request }) => {
    await createUser(request, user, pass, 'operator');
  });

  test('자동 로그아웃 시간 설정 → 적용·표시·영속', async ({ page }) => {
    await loginUI(page, user, pass);
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible(); // operator 랜딩 = 계약 현황
    await page.goto('/admin/account');

    await expect(page.getByRole('heading', { name: '자동 로그아웃 (비활동)' })).toBeVisible();

    // 개발모드 — 정책(15분) 초과 2시간 옵션 노출(실모드에선 비표시)
    await expect(page.getByRole('option', { name: /2시간.*개발 모드/ })).toBeAttached();

    // 5분으로 설정 → 적용
    await page.getByLabel('자동 로그아웃 시간').selectOption('5');
    await page.getByRole('button', { name: '적용', exact: true }).click();

    await expect(page.getByText('적용됨', { exact: false })).toBeVisible();
    await expect(page.getByText(/현재 적용:\s*5분/)).toBeVisible();

    // 영속 — 재진입 시 5분 선택 유지
    await page.reload();
    await expect(page.getByLabel('자동 로그아웃 시간')).toHaveValue('5');
    await expect(page.getByText(/현재 적용:\s*5분.*개인 설정/)).toBeVisible();
  });

  test('알림 이메일 설정 → 계정 정보 반영', async ({ page }) => {
    await loginUI(page, user, pass);
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible();
    await page.goto('/admin/account');
    await expect(page.getByRole('heading', { name: '알림 이메일' })).toBeVisible();
    const mail = `${user}@example.org`;
    await page.getByLabel('이메일').fill(mail);
    await page.getByRole('button', { name: '저장', exact: true }).click();
    // 저장 확인 메시지만 겨냥한다 — 카드 설명("계약 서명 차례가 되면 이 이메일로…")도 같은 문구를
    // 담고 있어, 넓은 정규식은 요소 2개에 걸려 strict mode 위반으로 터진다(CI 간헐 실패 원인).
    await expect(page.getByText(/^저장됨 —/)).toBeVisible();
    // 계정 정보 카드에 반영
    await page.reload();
    await expect(page.getByText(mail).first()).toBeVisible();
  });
});
