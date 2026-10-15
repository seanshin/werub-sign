import { test, expect } from '@playwright/test';
import { seedPortalRequest, API_BASE, CREDS } from './_helpers';

/**
 * 환자/거래처 포털 서명(C2) — 공개 포털 링크 열람 → 동의 서명 → 완료 화면(브라우저 종단).
 * 대응 백엔드 e2e: increment15 / erp-track-a (이 spec 은 포털 UI 경로를 검증).
 */
test.describe('포털 서명', () => {
  test('포털 링크 → 동의하고 서명 → 완료', async ({ page, request }) => {
    const { token, requestId } = await seedPortalRequest(request, { title: '외주 용역 계약서(포털)' });

    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '외주 용역 계약서(포털)' })).toBeVisible();

    // 1단계: 문서 열람·안내 → 진행
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    // 2단계: 동의 서명
    await page.getByRole('button', { name: '동의하고 서명' }).click();

    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();
    await expect(page.getByText('최종 완료', { exact: false })).toBeVisible();

    // 백엔드 상태도 COMPLETED 로 반영
    const rc = await request.get(`${API_BASE}/v1/requests/${requestId}`, { headers: { 'x-api-key': CREDS.consoleKey } });
    expect((await rc.json()).data.status).toBe('COMPLETED');
  });

  test('잘못된 토큰 → 링크 오류', async ({ page }) => {
    await page.goto('/portal/invalid-token-xyz');
    await expect(page.getByRole('heading', { name: '링크 오류' })).toBeVisible();
  });

  test('모바일 뷰포트 — 반응형 서명(가로 스크롤 없음·터치 서명)', async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 720 }); // iPhone 세로
    const { token } = await seedPortalRequest(request, { title: '모바일 서명 계약' });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '모바일 서명 계약' })).toBeVisible();
    // 가로 스크롤 없음(뷰포트 폭 이내 — 반응형)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(overflow).toBeTruthy();
    // 서명 진행 → 완료(터치/클릭)
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    await page.getByRole('button', { name: '동의하고 서명' }).click();
    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();
  });
});
