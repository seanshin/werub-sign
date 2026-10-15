// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * CSP 미들웨어(보안 트랙 S3) — 콘솔·포털 HTML 응답에 Content-Security-Policy 부여.
 *
 * 왜 미들웨어인가: Next 인라인 스크립트에 nonce 를 주려면 응답마다 새 nonce 가 필요하고,
 * Next 는 **요청 헤더의 Content-Security-Policy 에 실린 nonce 를 자기 인라인 스크립트에
 * 자동 적용**한다(동적 렌더링 전제 — layout.tsx 의 headers() 호출이 이를 강제).
 *
 * 모드(CSP_MODE, 런타임 env — docker-compose.prod.yml 에 명시 나열해야 전달됨):
 *   report(기본) — Report-Only 헤더: 차단 없이 위반만 /v1/csp-report 로 수집(도입 관찰 단계)
 *   enforce      — 실차단. 관찰 기간에 위반 0 확인 후 전환한다(계획서 S3).
 *   off          — 헤더 미부여(비상 롤백용)
 *
 * 정책 근거: 콘솔·포털은 외부 출처 0(전 리소스 self)·계약 미리보기 iframe 은 blob:.
 * /admin/manual 만 예외 — 매뉴얼이 srcDoc iframe 에 인라인 스크립트를 갖고 CSP 를 상속하므로
 * 해당 라우트는 nonce 없이 'unsafe-inline'(nonce 가 있으면 브라우저가 unsafe-inline 을 무시).
 * 인증 뒤 내부 페이지 + 저장소 저작 콘텐츠(manualHtml.ts)라 수용.
 */
import { NextRequest, NextResponse } from 'next/server';

function buildCsp(nonce: string | null): string {
  const dev = process.env.NODE_ENV !== 'production'; // next dev 는 eval 사용
  const frameAncestors = process.env.CSP_FRAME_ANCESTORS || "'self'"; // HIS 임베드 필요 시 env 로 확장(빈 문자열=미설정 취급)
  // 운영 기본은 nginx same-origin(/v1) — 별도 API 도메인 구성(NEXT_PUBLIC_SIGN_API_URL) 시 그 오리진을
  // 허용 목록에 추가한다(fetch·문서 iframe·이미지가 API 를 직접 가리키게 되므로). UI E2E(127.0.0.1:4790)도 이 경로.
  let apiOrigin = '';
  try {
    apiOrigin = process.env.NEXT_PUBLIC_SIGN_API_URL ? new URL(process.env.NEXT_PUBLIC_SIGN_API_URL).origin : '';
  } catch {
    /* 잘못된 URL 은 무시(self 만) */
  }
  const api = apiOrigin ? ` ${apiOrigin}` : '';
  const script = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`
    : `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`;
  return [
    "default-src 'self'",
    script,
    "style-src 'self' 'unsafe-inline'", // Next 런타임·매뉴얼 인라인 스타일
    `img-src 'self' data: blob:${api}`,
    "font-src 'self' data:",
    `connect-src 'self' blob:${api}`, // blob: — 배치 편집기가 문서 objectURL 을 fetch 로 되읽는다
    `frame-src 'self' blob:${api}`, // 계약/서식 PDF 미리보기 iframe(blob URL·문서 EP)
    "worker-src 'self' blob:", // pdf.js 워커(/pdf.worker.min.mjs) — 미지정 시 script-src(nonce)로 폴백돼 차단됨
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /v1/csp-report', // enforce 에서도 유지 — 차단 사실을 관측
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const mode = process.env.CSP_MODE ?? 'report';
  if (mode === 'off') return NextResponse.next();

  const isManual = request.nextUrl.pathname.startsWith('/admin/manual');
  const nonce = isManual ? null : Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  // 요청 헤더에 실어야 Next 가 nonce 를 인라인 스크립트에 부여한다
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  if (nonce) requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', csp);
  return response;
}

export const config = {
  // 정적 자산·프리페치는 제외(HTML 문서 응답에만 CSP 가 의미 있음)
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|svg|jpg|jpeg|ico|css|js|map|txt)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
