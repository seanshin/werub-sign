import { test, expect } from '@playwright/test';
import { loginUI, seedContract, seedDeliveredContract, createUser, consoleLogin, API_BASE, CREDS, SAMPLE_PDF } from './_helpers';

/**
 * 일반 전자계약(준비→발송→체결→관리) UI E2E — general-contracts.design.md.
 * 백엔드 플래그 GENERAL_CONTRACTS=on (playwright.config.ts). 대응 백엔드 e2e: general-contract.
 */
test.describe('일반 전자계약', () => {
  test('계약함 → 상세 → 발송 → 외부 서명(API) → 내부 서명 → 체결', async ({ page, request }) => {
    const { requestId, title, token } = await seedContract(request, { title: '용역 계약(UI)' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await expect(page.getByText(/전자계약 진행/)).toBeVisible(); // 대시보드 위젯(P3)
    await expect(page.getByRole('link', { name: '계약 현황', exact: true })).toBeVisible(); // 플래그 ON → 메뉴 자동 등장(U1)

    // 계약함 목록 → 상세
    await page.goto('/admin/contracts');
    await expect(page.getByRole('heading', { name: '계약함' })).toBeVisible();
    await page.getByText(title).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('협력사 대표').first()).toBeVisible();

    // 발송(외부 order1 미서명) → 성공 안내
    await page.getByRole('button', { name: '발송', exact: true }).click();
    await expect(page.getByText(/발송 완료 — 1건 전송/)).toBeVisible();

    // 외부 서명자 서명(API — 포털 흐름은 별도 테스트)
    const ps = await request.post(`${API_BASE}/v1/portal/${token}/sign`, { headers: { 'Content-Type': 'application/json' }, data: {} });
    expect(ps.ok(), `portal sign: ${ps.status()} ${await ps.text()}`).toBeTruthy();

    // 내부 서명(현재 단계 = 2차 root) → 체결 완료
    await page.reload();
    await page.getByRole('button', { name: '내부 서명' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '서명', exact: true }).click();
    await expect(page.getByText(/서명 완료 — 상태 COMPLETED/)).toBeVisible();

    // 이력 탭(U3) — 감사 스트림 뷰어 + 무결성 배지
    await page.getByRole('tab', { name: /이력/ }).click();
    await expect(page.getByText('CONTRACT_SIGNED_INTERNAL')).toBeVisible();
    await expect(page.getByText(/이력 무결성: 체인 유효/)).toBeVisible();

    // 백엔드 체결 상태 확인
    const rc = await request.get(`${API_BASE}/v1/requests/${requestId}`, { headers: { 'x-api-key': CREDS.consoleKey } });
    expect((await rc.json()).data.status).toBe('COMPLETED');
  });

  test('첨부 문서(A1) — 업로드·목록·포털 노출·삭제', async ({ page, request }) => {
    const { requestId, token, title } = await seedContract(request, { title: '첨부 계약(UI)' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/contracts/${requestId}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    // 첨부 탭 — 빈 상태 → 업로드 → 목록 등장(SHA-256 봉인 안내)
    await page.getByRole('tab', { name: /첨부/ }).click();
    await expect(page.getByText('첨부된 부속 문서가 없습니다.')).toBeVisible();
    await page.setInputFiles('input[type=file]', { name: '견적서.pdf', mimeType: 'application/pdf', buffer: SAMPLE_PDF });
    await expect(page.getByText(/첨부 추가 — 견적서\.pdf/)).toBeVisible();
    await expect(page.getByRole('cell', { name: '견적서.pdf' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '첨부 (1)' })).toBeVisible();

    // 포털 — 첨부 카드 노출(서명 대상 아님 안내)
    await page.goto(`/portal/${token}`);
    await expect(page.getByText('첨부 문서 (1)')).toBeVisible();
    await expect(page.getByRole('link', { name: /견적서\.pdf/ })).toBeVisible();

    // 삭제(작성 상태) — confirm 수락 → 빈 상태 복귀
    await page.goto(`/admin/contracts/${requestId}`);
    await page.getByRole('tab', { name: /첨부/ }).click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: '삭제' }).click();
    await expect(page.getByText('첨부된 부속 문서가 없습니다.')).toBeVisible();
  });

  test('fill-at-signing(A4) — 포털 입력란 기재 필수 → 서명', async ({ page, request }) => {
    const { token } = await seedContract(request, {
      title: '기재 계약(UI)',
      signMarks: [
        { page: 1, x: 0.1, y: 0.3, w: 0.4, h: 0.05, signer: 1, type: 'FIELD', label: '계좌번호' },
        { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
      ],
    });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '기재 계약(UI)' })).toBeVisible();

    // 배정 입력란 폼 노출 — 미기재로 진행 시 차단(클라 선검증)
    await expect(page.getByText('입력란 기재 (1)')).toBeVisible();
    await page.getByRole('checkbox', { name: '위 문서 내용을 확인했습니다' }).check();
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    await expect(page.getByText(/입력란을 기재해 주세요: 계좌번호/)).toBeVisible();

    // 기재 → 진행 → 손글씨 → 서명 완료
    await page.getByLabel('계좌번호').fill('110-234-567890');
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    const pad = page.getByLabel('손글씨 서명 입력 영역');
    await expect(pad).toBeVisible();
    const box = await pad.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 30, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 70, { steps: 8 });
      await page.mouse.up();
    }
    await page.getByRole('button', { name: '동의하고 서명' }).click();
    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();
  });

  test('fill-at-signing 고도화 — 입력 타입 검증·정규화·상세 기재값 증적', async ({ page, request }) => {
    const { requestId, token } = await seedContract(request, {
      title: '타입 기재 계약(UI)',
      signMarks: [
        { page: 1, x: 0.1, y: 0.3, w: 0.35, h: 0.045, signer: 1, type: 'FIELD', label: '계약일', fieldType: 'date' },
        { page: 1, x: 0.1, y: 0.38, w: 0.35, h: 0.045, signer: 1, type: 'FIELD', label: '계약금액', fieldType: 'money' },
        { page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.06, signer: 1, type: 'SIGN' },
      ],
    });
    await page.goto(`/portal/${token}`);
    await expect(page.getByRole('heading', { name: '타입 기재 계약(UI)' })).toBeVisible();
    await expect(page.getByText('입력란 기재 (2)')).toBeVisible();
    await page.getByRole('checkbox', { name: '위 문서 내용을 확인했습니다' }).check();

    // 잘못된 날짜 — 클라 선검증에서 차단(본인확인 단계로 넘어가지 않음)
    await page.getByLabel('계약일 (날짜)').fill('2026-02-30');
    await page.getByLabel('계약금액 (금액)').fill('1500000');
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    await expect(page.getByText(/계약일: 존재하지 않는 날짜입니다/)).toBeVisible();

    // 금액 오기재도 차단 → 정상 값으로 수정 후 서명
    await page.getByLabel('계약일 (날짜)').fill('2026.7.5');
    await page.getByLabel('계약금액 (금액)').fill('백오십만원');
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    await expect(page.getByText(/계약금액: 금액은 숫자로 입력해 주세요/)).toBeVisible();
    await page.getByLabel('계약금액 (금액)').fill('1,500,000');
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    const pad2 = page.getByLabel('손글씨 서명 입력 영역');
    await expect(pad2).toBeVisible();
    const box2 = await pad2.boundingBox();
    if (box2) {
      await page.mouse.move(box2.x + 30, box2.y + 40);
      await page.mouse.down();
      await page.mouse.move(box2.x + 120, box2.y + 70, { steps: 8 });
      await page.mouse.up();
    }
    await page.getByRole('button', { name: '동의하고 서명' }).click();
    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();

    // 관리자 상세 — 서명자 탭 기재값 증적(정규화된 값·무결성)
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/contracts/${requestId}`);
    await expect(page.getByText('입력란 기재값')).toBeVisible();
    await expect(page.getByText('2026-07-05')).toBeVisible();
    await expect(page.getByText('1,500,000')).toBeVisible();
    await expect(page.getByText('✓ 무결성 확인')).toBeVisible();
  });

  test('포털 접근암호(unlock) → 문서 확인 → 서명', async ({ page, request }) => {
    const { token } = await seedContract(request, { title: '보안 계약(UI)', accessCode: 'gate-1234' });
    await page.goto(`/portal/${token}`);

    // 잠금 화면 — 제목만 노출, 접근암호 요구
    await expect(page.getByRole('heading', { name: '보안 계약(UI)' })).toBeVisible();
    const codeInput = page.getByLabel('접근암호');
    await expect(codeInput).toBeVisible();

    // 오암호 → 오류
    await codeInput.fill('wrong-code');
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await expect(page.getByText('접근암호가 일치하지 않습니다.')).toBeVisible();

    // 정상 암호 → 문서 뷰어 + 동의 게이트 → 서명 완료
    await codeInput.fill('gate-1234');
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await expect(page.getByRole('heading', { name: '서명 대상 문서' })).toBeVisible();
    await page.getByRole('checkbox', { name: '위 문서 내용을 확인했습니다' }).check();
    await page.getByRole('button', { name: '서명 진행하기' }).click();
    // 계약 손글씨 서명(필수) — 캔버스에 드로잉
    const pad = page.getByLabel('손글씨 서명 입력 영역');
    await expect(pad).toBeVisible();
    const box = await pad.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 30, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 90, box.y + 90, { steps: 8 });
      await page.mouse.move(box.x + 150, box.y + 50, { steps: 8 });
      await page.mouse.up();
    }
    const signBtn = page.getByRole('button', { name: '동의하고 서명' });
    await expect(signBtn).toBeEnabled();
    await signBtn.click();
    await expect(page.getByRole('heading', { name: '서명이 완료되었습니다' })).toBeVisible();
  });

  test('계약 보관(제거)·보관됨 탭·복원', async ({ page, request }) => {
    const { title } = await seedContract(request, { title: '보관 계약(UI)' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts');
    await expect(page.getByText(title)).toBeVisible();

    // 행 '제거' → prompt 수락(사유 입력) → 목록에서 사라짐
    page.once('dialog', (d) => void d.accept('테스트 정리'));
    await page.getByRole('button', { name: `${title} 제거(보관)` }).click();
    await expect(page.getByText(title)).toHaveCount(0);

    // 보관됨 탭 → 등장(사유 표시) → 복원 → 다시 사라짐
    await page.getByRole('button', { name: '보관됨' }).click();
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText('테스트 정리', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '복원' }).click();
    await expect(page.getByText(title)).toHaveCount(0);

    // 전체 탭에 다시 표시
    await page.getByRole('button', { name: '전체' }).click();
    await expect(page.getByText(title)).toBeVisible();
  });

  test('계약 현황(overview) — 카드·처리 필요 목록', async ({ page, request }) => {
    const { title } = await seedContract(request, { title: '현황 계약(UI)' }); // 미발송 → 발송 대기 목록 대상
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/overview');
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible();
    await expect(page.getByText('진행 중', { exact: true })).toBeVisible();
    await expect(page.getByText('만료 임박(7일)')).toBeVisible();
    await expect(page.getByRole('heading', { name: /발송 대기/ })).toBeVisible();
    await expect(page.getByText(title).first()).toBeVisible();
  });

  test('카테고리별 관리 — 집계·필터·재분류', async ({ page, request }) => {
    const tok = await consoleLogin(request);
    const H = { 'Content-Type': 'application/json', 'x-session-token': tok };
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').digest('hex');
    const title = `카테고리 계약 ${Date.now()}`;
    await request.post(`${API_BASE}/v1/contracts`, { headers: H, data: { idempotencyKey: `cat-${Date.now()}`, externalDocId: `cat-${Date.now()}`, title, documentHash: hash, category: '임대차', signers: [{ kind: 'INTERNAL', displayName: '원장', username: CREDS.user, order: 1 }] } });

    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    // 카테고리 관리 화면 — 집계 카드
    await page.goto('/admin/contracts/categories');
    await expect(page.getByRole('heading', { name: '카테고리 관리' })).toBeVisible();
    await expect(page.getByText('임대차', { exact: true }).first()).toBeVisible();

    // 계약함에서 카테고리 필터
    await page.goto('/admin/contracts');
    await expect(page.getByText(title)).toBeVisible();
    await page.getByRole('button', { name: '카테고리 임대차 필터' }).first().click();
    await expect(page.getByText('카테고리 필터:')).toBeVisible();
    await expect(page.getByText(title)).toBeVisible();

    // 상세에서 재분류
    await page.getByText(title).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByLabel('계약 카테고리 변경').selectOption('구매');
    await expect(page.getByText(/카테고리를 "구매"/)).toBeVisible();
  });

  test('완료문서 QR 공개 검증 페이지', async ({ page, request }) => {
    const tok = await consoleLogin(request);
    const H = { 'Content-Type': 'application/json', 'x-session-token': tok };
    const composed = Buffer.from(await (await request.post(`${API_BASE}/v1/contracts/compose`, { headers: H, data: { title: 'QR', body: '제1조 (목적) QR 공개검증.' } })).body());
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(composed).digest('hex');
    const sc = await (await request.post(`${API_BASE}/v1/contracts`, { headers: H, data: { idempotencyKey: `qrv-${Date.now()}`, externalDocId: `qrv-${Date.now()}`, title: 'QR 공개검증 계약', documentHash: hash, signers: [{ kind: 'INTERNAL', displayName: '원장', username: CREDS.user, order: 1 }] } })).json();
    const rid = sc.data.requestId;
    await request.put(`${API_BASE}/v1/contracts/${rid}/document`, { headers: { 'Content-Type': 'application/pdf', 'x-session-token': tok }, data: composed });
    await request.post(`${API_BASE}/v1/contracts/${rid}/send`, { headers: H, data: { baseUrl: 'https://sign.example.org' } });
    await request.post(`${API_BASE}/v1/contracts/${rid}/sign`, { headers: H, data: {} });
    await request.get(`${API_BASE}/v1/contracts/${rid}/document`, { headers: { 'x-session-token': tok } }); // QR 토큰 생성
    const vtok = (await (await request.get(`${API_BASE}/v1/contracts/${rid}`, { headers: { 'x-session-token': tok } })).json()).data.verifyToken;
    // 공개 페이지(로그인 불요)
    await page.goto(`/contracts/verify/${vtok}`);
    await expect(page.getByText('검증된 전자계약 문서입니다')).toBeVisible();
    await expect(page.getByText('QR 공개검증 계약')).toBeVisible();
    await expect(page.getByText('체결 완료')).toBeVisible();
    await expect(page.getByRole('link', { name: /계약 문서 확인/ })).toBeVisible();
    // 잘못된 토큰
    await page.goto('/contracts/verify/no-such-token');
    await expect(page.getByText(/유효하지 않은 검증 링크/)).toBeVisible();
  });

  test('서명 검증 — 체결 후 상세 검증 항목 표시', async ({ page, request }) => {
    const { requestId, title } = await seedDeliveredContract(request, { title: '검증 상세 계약' }); // 외부+내부 서명 완료(COMPLETED)
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible(); // 로그인 완료 대기(레이스 방지)
    await page.goto(`/admin/contracts/${requestId}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20000 }); // dto 로드 완료
    await page.getByRole('tab', { name: '서명 검증' }).click();
    // 상세 검증 섹션: 종합·문서무결성·감사체인·트러스트·서명자별
    await expect(page.getByText(/검증 성공 — 모든 서명과 감사체인/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: '문서 무결성', exact: true })).toBeVisible();
    await expect(page.getByText(/감사·이력 무결성/)).toBeVisible();
    await expect(page.getByText(/서명자별 검증 상세/)).toBeVisible();
    await expect(page.getByText('인증서 시리얼').first()).toBeVisible();
    await expect(page.getByText('서명 암호검증').first()).toBeVisible();
    await expect(page.getByText('미폐기(OCSP/CRL)').first()).toBeVisible();
    await expect(page.getByText('타임스탬프(TSA)').first()).toBeVisible();
  });

  test('커스텀 서식 — 새로 만들기·목록 등장·삭제', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/templates');
    await expect(page.getByRole('heading', { name: '계약 서식' })).toBeVisible();
    // 내장 서식엔 '내장' 배지·복제 버튼
    await expect(page.getByText('내장', { exact: true }).first()).toBeVisible();

    // 새 서식 만들기
    await page.getByRole('button', { name: '새 서식 만들기' }).click();
    await expect(page.getByRole('heading', { name: '새 서식 만들기' })).toBeVisible();
    const tname = `UI 커스텀 서식 ${Date.now()}`;
    await page.getByLabel('서식 이름').fill(tname);
    await page.getByLabel('1번 필드 key').fill('clientName');
    await page.getByLabel('1번 필드 라벨').fill('기관');
    await page.getByLabel('서식 본문').fill('커스텀 서식 제목\n\n{{clientName}} 계약\n\n제1조 (목적) 테스트 목적.');
    await page.getByRole('button', { name: '서식 등록' }).click();

    // 목록에 커스텀 배지로 등장
    await expect(page.getByRole('heading', { name: '계약 서식' })).toBeVisible();
    await expect(page.getByText(tname)).toBeVisible();

    // 삭제(confirm 수락)
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: '삭제' }).first().click();
    await expect(page.getByText(tname)).toHaveCount(0);
  });

  test('내장 서식 직접 편집(오버라이드)·검증·기본값 복원', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    // 내장 서식 편집 진입
    await page.goto('/admin/contracts/templates/edit/mou');
    await expect(page.getByRole('heading', { name: '내장 서식 편집' })).toBeVisible();
    await expect(page.getByText(/기관 편집본\(오버라이드\)/)).toBeVisible();
    // {{키}} 검증 — 필드 없는 토큰 삽입 시 저장 비활성
    const body = page.getByLabel('서식 본문');
    await body.fill('업무협약서 제목\n\n{{orgUnknownX}} 협약 본문 제1조 (목적) 테스트 목적 문구.');
    await expect(page.getByText(/치환 안 됨/)).toBeVisible();
    await expect(page.getByRole('button', { name: '변경 저장' })).toBeDisabled();
    // 자동 추출 → 저장 활성
    await page.getByRole('button', { name: /본문에서 필드 자동 추출/ }).click();
    await expect(page.getByRole('button', { name: '변경 저장' })).toBeEnabled();
    await page.getByLabel('설명').fill('기관 편집본(UI)');
    await page.getByRole('button', { name: '변경 저장' }).click();
    // 목록에 기관 편집본 배지
    await expect(page.getByRole('heading', { name: '계약 서식' })).toBeVisible();
    await expect(page.getByText('기관 편집본').first()).toBeVisible();
    // 다시 편집 진입 → 변경 이력 확인 → 기본값 복원
    await page.goto('/admin/contracts/templates/edit/mou');
    await expect(page.getByRole('heading', { name: '내장 서식 편집' })).toBeVisible();
    await page.getByRole('button', { name: /변경 이력/ }).click();
    await expect(page.getByText(/v1/).first()).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: '기본값 복원' }).click();
    await expect(page.getByText('기본값으로 복원했습니다.')).toBeVisible();
  });

  test('서명란 위치 지정 — 상세에서 배치 편집기 오픈', async ({ page, request }) => {
    const { requestId } = await seedContract(request, { title: '서명란 재지정 계약' });
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto(`/admin/contracts/${requestId}`);
    await expect(page.getByRole('heading', { name: '계약 상세' })).toBeVisible();
    // 문서 보유 → 버튼 노출 → 배치 편집기(pdf.js 캔버스) 오픈
    const btn = page.getByRole('button', { name: '서명란 위치 지정' });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.getByRole('dialog', { name: /서명란 위치 지정/ })).toBeVisible({ timeout: 20000 });
    // 배치 완료 → 서명란 좌표 저장(PATCH) 성공 안내
    await page.getByRole('button', { name: '배치 완료' }).click();
    await expect(page.getByText(/서명란 위치 저장/)).toBeVisible({ timeout: 15000 });
  });

  test('발송 주소록 — 추가·검색·수정·삭제', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/addressbook');
    await expect(page.getByRole('heading', { name: '발송 주소록' })).toBeVisible();

    // 추가
    await page.getByRole('button', { name: '연락처 추가' }).click();
    const email = `ab${Date.now()}@example.com`;
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('이름(담당자)').fill('테스트담당');
    await page.getByLabel('소속(회사)').fill('테스트물산');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText(email)).toBeVisible();

    // 검색
    await page.getByLabel('주소록 검색').fill('테스트물산');
    await expect(page.getByText(email)).toBeVisible();

    // 삭제(confirm 수락)
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('row', { name: /테스트담당/ }).getByRole('button', { name: '삭제' }).click();
    await expect(page.getByText(email)).toHaveCount(0);
  });

  test('알림·리마인더 — 정책 표시·지금 실행', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/notifications');
    await expect(page.getByRole('heading', { name: '계약 알림·리마인더' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '자동 리마인더 정책' })).toBeVisible();
    await page.getByRole('button', { name: '지금 실행' }).click();
    await expect(page.getByText(/자동 리마인더 실행 — 독촉/)).toBeVisible();
  });

  test('완료문서 교부 페이지 — 공개 다운로드 링크', async ({ page, request }) => {
    const { title, deliveryToken } = await seedDeliveredContract(request, { title: '교부 계약(UI)' });
    await page.goto(`/contracts/delivery/${deliveryToken}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('link', { name: /완료 문서\(PDF\) 내려받기/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /감사추적인증서\(PDF\) 내려받기/ })).toBeVisible();
    // 무효 토큰 → 링크 오류
    await page.goto('/contracts/delivery/invalid-token');
    await expect(page.getByRole('heading', { name: '링크 오류' })).toBeVisible();
  });

  test('운영자(operator) — 계약 현황 랜딩·제한 메뉴(전자계약·내 계정·매뉴얼만)', async ({ page, request }) => {
    const user = `ctop${Date.now()}`;
    await createUser(request, user, 'ctop-pass-12345', 'operator');
    await loginUI(page, user, 'ctop-pass-12345');
    // 랜딩 = 계약 현황(대시보드 자동 리다이렉트)
    await expect(page.getByRole('heading', { name: '계약 현황' })).toBeVisible();
    // 노출 메뉴: 전자계약 4 + 내 계정 + 운영 매뉴얼
    await expect(page.getByRole('link', { name: '계약함', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '새 계약', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '알림·리마인더' })).toBeVisible();
    await expect(page.getByRole('link', { name: '내 계정' })).toBeVisible();
    await expect(page.getByRole('link', { name: '운영 매뉴얼' })).toBeVisible();
    // 비노출: 대시보드·서명요청·인증서·감사 계열
    await expect(page.getByRole('link', { name: '대시보드', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '새 서명요청' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '인증서 발급' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '문서 인증 목록' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '감사·로그', exact: true })).toHaveCount(0);
  });

  test('에디터 확장(A5) — 정렬·목록·표 툴바·편집 반영', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/templates/nda');
    await expect(page.getByRole('heading', { name: /서식으로 작성/ })).toBeVisible();

    const editor = page.locator('.contract-body-editor');
    await expect(editor).toBeVisible();
    // 툴바 노출
    for (const name of ['가운데 정렬', '불릿 목록', '번호 목록', '표 삽입']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
    // 서식 본문 비동기 로드 대기 후 커서를 문서 끝으로(전체선택→우측 화살표 — OS 무관)
    await expect(editor).toContainText('제1조');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '불릿 목록' }).click();
    await page.keyboard.type('목록 항목 하나');
    await expect(editor.locator('ul li').filter({ hasText: '목록 항목 하나' })).toBeVisible();
    await expect(page.getByRole('button', { name: '불릿 목록' })).toHaveAttribute('aria-pressed', 'true');
    // 표 삽입 → 표 요소 + 표 편집 버튼 등장
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '불릿 목록' }).click(); // 목록 해제
    await page.getByRole('button', { name: '표 삽입' }).click();
    await expect(editor.locator('table')).toBeVisible();
    await expect(page.getByRole('button', { name: '행 추가' })).toBeVisible();
    // 가운데 정렬 토글 반영(문단)
    await page.getByRole('button', { name: '표 삭제' }).click();
    await page.keyboard.type('정렬 확인 문단');
    await page.getByRole('button', { name: '가운데 정렬' }).click();
    await expect(page.getByRole('button', { name: '가운데 정렬' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('계약 서식 → 에디터(필드 반영·본문) → PDF 생성 → 계약 생성', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    // 서식 갤러리
    await page.goto('/admin/contracts/templates');
    await expect(page.getByRole('heading', { name: '계약 서식' })).toBeVisible();
    await expect(page.getByText('비밀유지계약서(NDA)')).toBeVisible();
    await expect(page.getByText('표준 근로계약서', { exact: false }).first()).toBeVisible();

    // NDA 에디터 — 필드 입력 → 본문 반영
    await page.goto('/admin/contracts/templates/nda');
    await expect(page.getByRole('heading', { name: /서식으로 작성/ })).toBeVisible();
    await page.getByLabel('정보제공자(갑)').fill('의료법인 테스트재단');
    await page.getByLabel('정보수령자(을)').fill('테스트협력사');
    await page.getByRole('button', { name: '본문에 반영' }).click();
    const bodyEditor = page.getByRole('textbox', { name: '계약서 본문' });
    await expect(bodyEditor).toContainText('의료법인 테스트재단');
    // 리치 에디터 — 조항 제목이 heading 속성으로 표시(속성 보이는 에디터)
    await expect(bodyEditor.locator('h1')).toContainText('비밀유지계약서');
    await expect(bodyEditor.locator('h2').first()).toContainText('제1조');

    // 서명란·입력란 마커 삽입(툴바) — 문서에 서명 위치·기재란 표시(서명자별)
    await page.getByRole('button', { name: /서명란 삽입/ }).click();
    await expect(bodyEditor).toContainText('[서명란#1]');
    await page.getByLabel('입력란 라벨', { exact: true }).fill('연락처');
    await page.getByRole('button', { name: /입력란 삽입/ }).click();
    await expect(bodyEditor).toContainText('[입력란#1:연락처]');

    // 위치 배치 편집기 — 전체화면 모달에서 클릭 배치·드래그(서명자별)
    await page.getByRole('button', { name: /PDF 미리보기·위치 배치/ }).click();
    await expect(page.getByRole('dialog', { name: /서명란·입력란 배치/ })).toBeVisible();
    await expect(page.getByText(/1 \/ \d+ 페이지/)).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => { const c = document.querySelector('canvas'); return !!c && c.clientHeight > 300; });
    await page.getByRole('button', { name: /서명란 추가/ }).click();
    await page.getByRole('application', { name: '서명란·입력란 배치 영역' }).click({ position: { x: 200, y: 320 } });
    const placedBox = page.getByRole('button', { name: /^서명란 — 1번 서명자/ });
    await expect(placedBox).toBeVisible();
    // 드래그로 위치 조정 — 좌표(style.left) 변화 확인
    const beforeLeft = await placedBox.evaluate((el) => (el as HTMLElement).style.left);
    const bb = await placedBox.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await page.mouse.move(bb.x + bb.width / 2 + 90, bb.y + bb.height / 2 + 60, { steps: 5 });
      await page.mouse.up();
    }
    const afterLeft = await placedBox.evaluate((el) => (el as HTMLElement).style.left);
    expect(afterLeft).not.toBe(beforeLeft);
    await page.getByRole('button', { name: '배치 완료' }).click();
    await expect(page.getByRole('dialog', { name: /서명란·입력란 배치/ })).toHaveCount(0);
    await expect(page.getByText(/배치 1개/)).toBeVisible(); // 요약 표시

    // 서명 방식 = 동시(병렬)
    await page.getByLabel('서명 방식').selectOption('PARALLEL');

    // 계약 정보·서명자 → 생성(빈 필드 공란 confirm 수락)
    await page.getByLabel('계약 제목').fill('NDA 계약(서식 UI)');
    await page.getByLabel('1번 이메일').fill('nda@example.com');
    await page.getByLabel('2번 계정').fill('root');
    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'PDF 생성 후 계약 만들기' }).click();

    // 상세 도착 — 문서 자동 업로드(해시 일치) + 동시 서명 표시
    await expect(page.getByRole('heading', { name: 'NDA 계약(서식 UI)' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('외부(이메일)')).toBeVisible();
    await expect(page.getByText('동시 서명', { exact: false }).first()).toBeVisible();
  });

  test('프리셋(U5) — 저장·불러오기·바로 발송·진행 타임라인', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();
    await page.goto('/admin/contracts/new');
    await expect(page.getByRole('heading', { name: '새 계약' })).toBeVisible();

    // 구성 입력 → 프리셋 저장(prompt 이름 입력)
    await page.getByLabel('제목').fill('월간 용역(프리셋 UI)');
    await page.getByLabel('1번 이메일').fill('preset-ui@example.com');
    await page.getByLabel('2번 계정').fill('root');
    page.once('dialog', (d) => void d.accept('용역 표준(UI)'));
    await page.getByRole('button', { name: '현재 구성을 프리셋으로 저장' }).click();
    await expect(page.getByText('프리셋 "용역 표준(UI)" 저장됨')).toBeVisible();

    // 새로고침 → 프리셋 불러오기 → 구성 복원
    await page.reload();
    await page.getByLabel('프리셋 선택').selectOption({ label: '용역 표준(UI) (2인)' });
    await expect(page.getByText(/프리셋 "용역 표준\(UI\)" 적용/)).toBeVisible();
    await expect(page.getByLabel('제목')).toHaveValue('월간 용역(프리셋 UI)');
    await expect(page.getByLabel('1번 이메일')).toHaveValue('preset-ui@example.com');

    // 바로 발송(원플로우) — PDF 선택 → 생성+발송 → 상세 타임라인에 생성·발송 표시
    await page.getByLabel('계약서 PDF 파일').setInputFiles({ name: 'preset.pdf', mimeType: 'application/pdf', buffer: SAMPLE_PDF });
    await expect(page.getByText(/SHA-256 .*계산됨/)).toBeVisible();
    await page.getByLabel('생성 후 바로 발송(외부 서명자 이메일 전송)').check();
    await page.getByRole('button', { name: '계약 생성 + 발송' }).click();
    await expect(page.getByRole('heading', { name: '월간 용역(프리셋 UI)' })).toBeVisible();
    await expect(page.getByText('진행 타임라인')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: /^계약 생성/ })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: /^발송/ })).toBeVisible(); // 원플로우 자동 발송 반영
  });

  test('새 계약 폼 → 생성 → 상세 이동', async ({ page }) => {
    await loginUI(page);
    await expect(page.getByRole('heading', { name: '서명요청 대시보드' })).toBeVisible();

    await page.goto('/admin/contracts/new');
    await expect(page.getByRole('heading', { name: '새 계약' })).toBeVisible();

    // 활성 메뉴 단일 표시 — 하위 경로에서 계약함(/admin/contracts) 중복 활성 회귀 방지
    await expect(page.getByRole('link', { name: '새 계약', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: '계약함', exact: true })).not.toHaveAttribute('aria-current', 'page');

    await page.getByLabel('제목').fill('신규 계약(폼 UI)');
    await page.getByLabel('계약서 PDF 파일').setInputFiles({
      name: 'contract.pdf', mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
    });
    await expect(page.getByText(/SHA-256 .*계산됨/)).toBeVisible();

    // 서명자: 1차 외부(이메일) · 2차 내부(root) + 내부 알림 이메일
    await page.getByLabel('1번 이메일').fill('vendor@example.com');
    await page.getByLabel('2번 계정').fill('root');
    await expect(page.getByLabel('2번 내부 알림 이메일')).toBeVisible(); // 내부 행에 알림 이메일 입력 노출
    await page.getByLabel('2번 내부 알림 이메일').fill('director@hospital.example.com');
    await page.getByRole('button', { name: '계약 생성' }).click();

    // 상세로 이동 — 제목·서명자(내부/외부)·내부 알림 이메일 표시
    await expect(page.getByRole('heading', { name: '신규 계약(폼 UI)' })).toBeVisible();
    await expect(page.getByText('내부(콘솔)')).toBeVisible();
    await expect(page.getByText('외부(이메일)')).toBeVisible();
    await expect(page.getByText(/director@hospital\.example\.com|di\*+@hospital/)).toBeVisible(); // 마스킹된 내부 알림 이메일
  });
});
