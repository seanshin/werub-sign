# UI E2E (Playwright) — 콘솔/포털 브라우저 자동화 (L4)

통합 테스트 기획서(`docs/06-ops/integration-test-plan.md`) **로드맵 1순위**. 백엔드 e2e(`npm run e2e`)가 HTTP 경로를 검증한다면, 이 스위트는 **브라우저에서 실제 화면·상호작용**을 검증한다.

## 실행 (루트에서)
```bash
npm run e2e:ui:install   # 최초 1회 — chromium 다운로드
npm run e2e:ui           # 백엔드+웹 빌드 → 두 서버 자동 기동 → 테스트
npm run e2e:ui:headed    # 브라우저 표시(디버그)
```
`e2e:ui` 가 하는 일:
1. `npm run build` — 백엔드(`dist/main.js`).
2. `SIGN_E2E_BUILD=1 NEXT_PUBLIC_SIGN_API_URL=http://127.0.0.1:4790 next build` — 웹을 테스트 백엔드 포트로 빌드(`NEXT_PUBLIC_*` 는 빌드 시 인라인되므로 필수). `SIGN_E2E_BUILD` 가 `output: standalone` 을 꺼 `next start` 호환.
3. `playwright.config.ts` 의 `webServer` 2개가 백엔드(4790, 인메모리·휘발)·웹(3390)을 자동 기동.

## 구성
| 파일 | 검증(기획서 ID) | 대응 백엔드 e2e |
|---|---|---|
| `auth.spec.ts` | 로그인 성공/실패·보호 라우트 리다이렉트·로그아웃 (G1·G3) | `rbac`, `session-registry` |
| `dashboard.spec.ts` | 목록·검색·상태 필터·CSV 다운로드 (I1·I2) | `search`, `pagination`, `export-csv` |
| `mfa.spec.ts` | 2FA 등록·활성화·재로그인 코드 검증 (G4u) | `mfa-2fa` |
| `_helpers.ts` | 로그인·API 시드(인증서/요청/계정)·TOTP 계산 | — |

## 특징
- **격리**: 백엔드는 인메모리 저장소로 매 실행 휘발. 시드는 콘솔 키(`x-api-key`)로 API 직접 호출.
- **직렬**: `workers: 1` — 단일 백엔드 인스턴스 공유. MFA 는 전용 계정에 적용(root 영향 없음).
- **확장 예정**: 포털 서명(C2), idle 자동 로그아웃 UI(G2u), 일괄 작업(I3), SSE 자동 갱신(I4), 접근성 axe(C4·I5), 검증 탭(I6).
