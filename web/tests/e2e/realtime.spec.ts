import { test, expect } from '@playwright/test';
import { loginUI, seedRequest } from './_helpers';

/**
 * 실시간 SSE 자동 갱신(I4) — 대시보드를 연 채로 새 요청이 생기면 수동 새로고침 없이 목록에 등장.
 * 대응 백엔드 e2e: sse-events.e2e (이 spec 은 브라우저가 SSE 로 목록을 갱신하는지 검증).
 */
test.describe('실시간 자동 갱신', () => {
  test('대시보드 오픈 중 새 요청 → 자동 등장(새로고침 없이)', async ({ page, request }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    // SSE 연결이 자리잡도록 잠깐 대기 후 API 로 새 요청 시드
    await page.waitForTimeout(1000);
    const title = `실시간 등장 ${Date.now()}`;
    await seedRequest(request, { title });

    // 수동 새로고침 없이 SSE 디바운스(1.2s) 후 목록에 등장
    await expect(page.getByText(title)).toBeVisible({ timeout: 8000 });
  });
});
