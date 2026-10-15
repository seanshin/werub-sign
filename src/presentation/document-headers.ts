// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 응답 헤더 조작 최소 인터페이스(@Res passthrough) — @types/express 불요.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface FramableRes {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

/**
 * 포털/관리자 문서(PDF) 응답 헤더 — inline·no-store·nosniff + 크로스오리진 뷰어 프레이밍 허용.
 * helmet 기본 X-Frame-Options: SAMEORIGIN 은 웹(다른 오리진) iframe 임베드를 차단하므로 해제하고,
 * CSP frame-ancestors 로 허용 오리진을 제한(CORS_ORIGINS). 미설정(dev/e2e)이면 개방.
 * 읽기전용·토큰스코프 PDF라 클릭재킹 위험 낮음(상호작용 없음).
 */
/** 첨부 응답 헤더 — 문서 헤더와 동일 정책 + 임의 contentType·비ASCII 파일명(RFC 5987 filename*) 지원. */
export function setAttachmentResponseHeaders(res: FramableRes, filename: string, contentType: string): void {
  setDocResponseHeaders(res, filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, ''));
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
}

export function setDocResponseHeaders(res: FramableRes, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  // 비ASCII(한글 계약 제목) 파일명 대응 — ASCII 폴백 + RFC 5987 filename*
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('X-Frame-Options');
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  res.setHeader('Content-Security-Policy', `frame-ancestors ${origins.length ? `'self' ${origins.join(' ')}` : '*'}`);
}

/**
 * 계약 문서 다운로드 파일명 — 여러 계약의 파일이 한 폴더에 섞여도 구분·정렬되도록
 * `제목_구분_YYYYMMDD_식별자8.pdf` 형태로 만든다(고정 이름이면 `contract-signed.pdf` 처럼 전부 겹친다).
 * 제목은 파일시스템 금지문자·공백을 정리하고 40자로 자른다.
 */
export function contractFileName(title: string, kind: string, requestId: string, at?: string | null): string {
  const safeTitle = (title || '계약서')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '계약서';
  const d = at ? new Date(at) : new Date();
  const day = Number.isNaN(d.getTime()) ? new Date() : d;
  const ymd = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const short = (requestId || '').replace(/-/g, '').slice(0, 8);
  return `${safeTitle}_${kind}_${ymd}${short ? `_${short}` : ''}.pdf`;
}
