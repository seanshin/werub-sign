import { test, expect } from '@playwright/test';
import { loginUI, seedWsignDoc } from './_helpers';

/** 문서 인증 목록(wsign) 콘솔 UI E2E — 외부 문서인증 어테스테이션 통합 목록. */
test.describe('문서 인증 목록(wsign)', () => {
  test('wsign 문서 어테스테이션 → 목록 표시', async ({ page, request }) => {
    await seedWsignDoc(request, { docId: 'DOC-UI-1', title: '차량사용 신청(UI)' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    await page.goto('/admin/wsign-documents');
    await expect(page.getByRole('heading', { name: '문서 인증 목록' })).toBeVisible();
    await expect(page.getByText('차량사용 신청(UI)')).toBeVisible();
    await expect(page.getByText('DOC-UI-1').first()).toBeVisible();
    await expect(page.getByText('체인 유효').first()).toBeVisible();

    // 필터 확장: 기간(날짜)·이벤트 유형 컨트롤 존재
    await expect(page.getByLabel('시작일')).toBeVisible();
    await expect(page.getByLabel('종료일')).toBeVisible();
    await expect(page.getByLabel('이벤트 유형')).toBeVisible();

    // 문서 클릭 → 상세
    await page.getByText('차량사용 신청(UI)').click();
    await expect(page.getByRole('heading', { name: '문서 인증 상세' })).toBeVisible();
    await expect(page.getByText(/무결성 유효/)).toBeVisible();
    await expect(page.getByText('WSIGN_ATTEST').first()).toBeVisible(); // 어테스테이션 이력
    await expect(page.getByRole('button', { name: '해시 복사' })).toBeVisible();
  });
});
