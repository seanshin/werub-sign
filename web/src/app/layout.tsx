// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import '@/design/globals.css';
import { ToastProvider } from '@/components/ui/Toast';

export const metadata: Metadata = {
  title: '의료/IT 전자서명 트러스트 서비스',
  description: '의료 전자동의서 서명 및 관리 플랫폼',
};

// 반응형 — 휴대폰/태블릿/PC 자동 최적화(device-width 스케일). 포털 서명·콘솔 공통.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // CSP nonce(middleware.ts)가 매 응답 인라인 스크립트에 반영되려면 동적 렌더링이 전제 —
  // headers() 호출이 전 페이지를 요청 단위 렌더링으로 강제한다(콘솔·포털은 소규모 트래픽).
  headers();
  return (
    <html lang="ko">
      <head>
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </head>
      <body>
        <ToastProvider>
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
