import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginUI, seedPortalRequest, seedApproval, seedContract, seedDeliveredContract, API_BASE } from './_helpers';

/**
 * 접근성 자동검사(C4·I5) — axe-core(WCAG 2.1 A/AA) 회귀 가드.
 * 게이트: serious·critical 위반 0(KWCAG 핵심). minor·moderate 는 로그만(점진 개선).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = ['serious', 'critical'];

async function scan(page: import('@playwright/test').Page, label: string) {
  // 트랜지션/애니메이션 비활성화 → 전환 중간 프레임이 아닌 정착 상태에서 결정적으로 측정(표준 axe 관행).
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;}' });
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter((v) => BLOCKING.includes(v.impact ?? ''));
  if (results.violations.length) {
    console.log(`[a11y:${label}] 비차단 위반 ${results.violations.length}건(로그만) — ` +
      results.violations.map((v) => `${v.id}(${v.impact}, x${v.nodes.length})`).join(', '));
  }
  expect(blocking, `${label}: serious/critical a11y 위반\n` +
    blocking.map((v) => `  · ${v.id} [${v.impact}] ${v.help} — ${v.nodes.length} node(s)`).join('\n')).toEqual([]);
}

test.describe('접근성(axe)', () => {
  test('로그인 화면(공개)', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
    await scan(page, 'login');
  });

  test('대시보드(로그인 후)', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await scan(page, 'dashboard');
  });

  test('내 계정', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/account');
    await expect(page.getByRole('heading', { name: '계정 정보' })).toBeVisible();
    await scan(page, 'account');
  });

  test('대시보드 다크 모드', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.getByRole('button', { name: '다크 모드로 전환' }).click();
    await scan(page, 'dashboard-dark');
  });

  test('결재함(전자결재)', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/approvals');
    await expect(page.getByRole('heading', { name: '결재함' })).toBeVisible();
    await scan(page, 'approvals');
  });

  test('결재 상세(결재선·인증로그)', async ({ page, request }) => {
    const { requestId } = await seedApproval(request, { title: '접근성 결재 점검' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/approvals/${requestId}`);
    await expect(page.getByRole('heading', { name: '접근성 결재 점검' })).toBeVisible();
    await scan(page, 'approval-detail');
  });

  test('계약함(일반 전자계약)', async ({ page, request }) => {
    await seedContract(request, { title: '접근성 계약 점검' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts');
    await expect(page.getByRole('heading', { name: '계약함' })).toBeVisible();
    await scan(page, 'contracts');
  });

  test('새 계약 폼', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/new');
    await expect(page.getByRole('heading', { name: '새 계약' })).toBeVisible();
    await scan(page, 'contracts-new');
  });

  test('포털 입력란 기재 폼(fill-at-signing)', async ({ page, request }) => {
    const { token } = await seedContract(request, {
      title: '접근성 기재 점검',
      signMarks: [
        { page: 1, x: 0.1, y: 0.3, w: 0.35, h: 0.045, signer: 1, type: 'FIELD', label: '계약일', fieldType: 'date' },
        { page: 1, x: 0.1, y: 0.38, w: 0.35, h: 0.045, signer: 1, type: 'FIELD', label: '계약금액', fieldType: 'money' },
        { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
      ],
    });
    await page.goto(`/portal/${token}`);
    await expect(page.getByText('입력란 기재 (2)')).toBeVisible();
    await scan(page, 'portal-fill');
  });

  test('계약 상세(기재값 증적·첨부 탭)', async ({ page, request }) => {
    const { requestId, token } = await seedContract(request, {
      title: '접근성 상세 점검',
      signMarks: [
        { page: 1, x: 0.1, y: 0.3, w: 0.35, h: 0.045, signer: 1, type: 'FIELD', label: '계약일', fieldType: 'date' },
        { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
      ],
    });
    // 외부 서명자가 기재+서명(API) → 상세에 기재값 증적 카드가 렌더된 상태로 스캔
    const ps = await request.post(`${API_BASE}/v1/portal/${token}/sign`, {
      headers: { 'Content-Type': 'application/json' },
      data: { fillValues: [{ label: '계약일', value: '2026-07-28' }] },
    });
    expect(ps.ok(), `portal sign: ${ps.status()} ${await ps.text()}`).toBeTruthy();
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/contracts/${requestId}`);
    await expect(page.getByText('입력란 기재값')).toBeVisible();
    await scan(page, 'contract-detail');
  });

  test('포털 접근암호(계약 잠금 화면)', async ({ page, request }) => {
    const { token } = await seedContract(request, { title: '접근성 잠금 점검', accessCode: 'a11y-1234' });
    await page.goto(`/portal/${token}`);
    await expect(page.getByLabel('접근암호')).toBeVisible();
    await scan(page, 'portal-locked');
  });

  test('계약 현황(overview)', async ({ page, request }) => {
    await seedContract(request, { title: '접근성 현황 점검' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/overview');
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible();
    await scan(page, 'contracts-overview');
  });

  test('발송 주소록', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/addressbook');
    await expect(page.getByRole('heading', { name: '발송 주소록' })).toBeVisible();
    await scan(page, 'contracts-addressbook');
  });

  test('카테고리 관리', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/categories');
    await expect(page.getByRole('heading', { name: '카테고리 관리' })).toBeVisible();
    await scan(page, 'contracts-categories');
  });

  test('계약 알림·리마인더', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/notifications');
    await expect(page.getByRole('heading', { name: '자동 리마인더 정책' })).toBeVisible();
    await scan(page, 'contracts-notifications');
  });

  test('계약 서식 갤러리·에디터', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/templates');
    await expect(page.getByRole('heading', { name: '계약 서식' })).toBeVisible();
    await scan(page, 'contracts-templates');
    await page.goto('/admin/contracts/templates/employment-regular');
    await expect(page.getByRole('button', { name: '본문에 반영' })).toBeVisible();
    await scan(page, 'contracts-template-editor');
    // 배치 편집기(pdf.js 캔버스 + 마크 오버레이) 열어서 재스캔
    await page.getByRole('button', { name: /PDF 미리보기·위치 배치/ }).click();
    await expect(page.getByText(/1 \/ \d+ 페이지/)).toBeVisible({ timeout: 20_000 });
    await scan(page, 'contracts-placement-editor');
    // 커스텀 서식 편집기(새로 만들기)
    await page.goto('/admin/contracts/templates/edit/new');
    await expect(page.getByRole('heading', { name: '새 서식 만들기' })).toBeVisible();
    await scan(page, 'contracts-template-custom-editor');
  });

  test('완료문서 교부 페이지(공개)', async ({ page, request }) => {
    const { deliveryToken } = await seedDeliveredContract(request, { title: '접근성 교부 점검' });
    await page.goto(`/contracts/delivery/${deliveryToken}`);
    await expect(page.getByRole('link', { name: /완료 문서\(PDF\)/ })).toBeVisible();
    await scan(page, 'contract-delivery');
  });

  test('환자 포털(공개·고령자 접근성)', async ({ page, request }) => {
    const { token } = await seedPortalRequest(request, { title: '포털 접근성 점검' });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '포털 접근성 점검' })).toBeVisible();
    await scan(page, 'portal');
  });
});
