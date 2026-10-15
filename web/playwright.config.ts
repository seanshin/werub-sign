import { defineConfig, devices } from '@playwright/test';
import { API_PORT, WEB_PORT, API_BASE, CREDS } from './tests/e2e/_helpers';

/**
 * UI E2E(L4) — 콘솔/포털 브라우저 자동화.
 * webServer 2개를 자동 기동: ① 백엔드(인메모리, dist/main.js, 저장소 휘발) ② 웹(next start).
 * NEXT_PUBLIC_SIGN_API_URL 은 빌드 시 인라인되므로 `npm run e2e:ui`(루트)가 웹을 백엔드 포트로 빌드한다.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // 단일 백엔드 인스턴스 공유 — 직렬 실행
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    actionTimeout: 10_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '..',
      url: `${API_BASE}/v1/crl`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        SIGN_PORT: String(API_PORT),
        CONSOLE_API_KEY: CREDS.consoleKey,
        SIGN_ADMIN_API_KEY: CREDS.adminApiKey,
        HIS_INBOUND_API_KEY: CREDS.hisKey,
        SIGN_ADMIN_USER: CREDS.user,
        SIGN_ADMIN_PASSWORD: CREDS.pass,
        CRYPTO_MASTER_KEY: Buffer.alloc(32, 77).toString('base64'),
        SESSION_TTL_MIN: '480', // 8h(현실값) — idle 캡(개발 2h)이 TTL에 안 묶이도록
        SIGN_IDLE_TIMEOUT_MIN: '15',
        PORTAL_DOC_PREVIEW: 'on', // 포털 문서 미리보기 — UI E2E 활성
        ELECTRONIC_APPROVAL: 'on', // 전자결재(상신→결재) — UI E2E 활성
        GENERAL_CONTRACTS: 'on', // 일반 전자계약 — UI E2E 활성

      },
    },
    {
      command: `npx next start -p ${WEB_PORT}`,
      cwd: '.',
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      // CSP 는 항상 enforce 로 검증 — 운영이 report-only 인 동안에도 UI 스위트가 실차단 회귀를 잡는다(S3)
      env: { NEXT_PUBLIC_SIGN_API_URL: API_BASE, CSP_MODE: process.env.CSP_MODE ?? 'enforce' },
    },
  ],
});
