# 의료/IT 전자서명 트러스트 서비스 — 프론트엔드

의료 전자동의서 서명 및 관리를 위한 Next.js App Router SPA.

## 환경 변수

`.env.example`을 복사해 `.env.local`을 만들고 값을 설정하세요.

```
NEXT_PUBLIC_SIGN_API_URL=http://localhost:4000
```

## 실행

```bash
npm install
npm run dev    # 개발 서버 (http://localhost:3000)
npm run build  # 프로덕션 빌드
npm start      # 프로덕션 서버
```

## 화면 구성

| 경로 | 설명 |
|------|------|
| `/portal/[token]` | 환자 서명 포털 (모바일 최적화, 인증 불필요) |
| `/admin/login` | 관리자 로그인 (API Key 입력) |
| `/admin` | 서명요청 대시보드 |
| `/admin/certificates` | 인증서 발급 |
| `/admin/requests/new` | 서명요청 생성 (파일 SHA-256 해시 자동 계산) |
| `/admin/requests/[id]` | 요청 상세·검증·감사이력·서명링크 발급·발송·철회 |
| `/admin/maintenance` | 만료 배치·CA 회전 |

## 기술 스택

- **Next.js 14** (App Router)
- **TypeScript** strict mode
- **CSS Modules + CSS 변수** 디자인 토큰
- 상태: React `useState` / `useCallback` (외부 상태 라이브러리 없음)
- API: 표준 `fetch` 래퍼 (`src/lib/api.ts`)
