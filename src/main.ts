/**
 * sign 백엔드 부트스트랩 — HTTP 계층의 전역 정책이 모두 여기서 결정된다.
 *
 * 순서가 곧 의미다:
 *  1. trust proxy       — nginx 뒤에서 실 클라이언트 IP 해석(레이트리밋 정확성의 전제)
 *  2. helmet            — 보안 응답 헤더(HSTS 는 운영에서만)
 *  3. CORS              — SPA(포털·콘솔) 허용 목록
 *  4. raw/json 파서     — 문서·첨부 업로드 경로에만 raw 를 스코프(전역 등록 금지 — 아래 주석)
 *  5. ValidationPipe    — DTO 화이트리스트·형변환(선언 밖 필드는 조용히 제거)
 *  6. 전역 예외 필터    — 모든 오류를 {error:{code,message,requestId}} 규약으로 변환
 *
 * 여기 없는 것: 라우팅·비즈니스 로직(전부 AppModule 이하), DB 연결(STORE_DRIVER 에 따라 모듈에서).
 */
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './presentation/all-exceptions.filter';
import { setupSwagger } from './swagger';
import { isHardened } from './infrastructure/security/hardening';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  // trust proxy — nginx 단일 홉 뒤. X-Forwarded-For 의 실 클라이언트 IP 를 req.ip 로 해석(H4 rate-limit 정확성).
  // 사설/링크로컬/유니크로컬(=docker 게이트웨이·nginx 호스트) 홉만 신뢰 → 공개 클라이언트는 XFF 위조 불가.
  // 설정형: TRUST_PROXY(예: 'loopback, linklocal, uniquelocal' | '1' | 특정 CIDR).
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  // M2: 보안 헤더 — API(JSON)이라 CSP 비활성. SPA(콘솔·포털) CSP 는 web/src/middleware.ts(S3, CSP_MODE)가 부여. HSTS는 운영(https)만.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: isHardened() ? { maxAge: 15_552_000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // 감사인증서 PDF·SPA cross-origin 허용
    }),
  );
  // CORS — 프론트엔드 SPA(환자 포털·관리자 콘솔) 호출 허용. 운영은 CORS_ORIGINS로 화이트리스트.
  // 하드닝(운영)에서 CORS_ORIGINS 미설정 시 origin:false(교차오리진 미반사) — 임의 오리진을 credentials 와 함께
  // 반사(origin:true)하던 풋건 제거. SPA 를 서빙하는 배포는 CORS_ORIGINS 를 명시하고, 순수 API(서버↔서버)
  // 배포는 CORS 자체가 불요하므로 안전. 개발(비하드닝)은 종전대로 편의를 위해 반사 허용.
  const origins = process.env.CORS_ORIGINS;
  const corsOrigin = origins ? origins.split(',').map((o) => o.trim()) : (isHardened() ? false : true);
  app.enableCors({ origin: corsOrigin, credentials: true });
  // 포털 문서 업로드(PUT .../document) — application/pdf 원본 바이트를 req.body(Buffer)로 파싱.
  // type 필터로 JSON 등 다른 본문에는 무영향(Nest 기본 json 파서가 처리). 상한은 PORTAL_DOC_MAX_MB + 여유.
  const docMaxMb = Math.max(1, Number(process.env.PORTAL_DOC_MAX_MB ?? 20));
  // express(내장, @nestjs/platform-express 동반)의 raw 파서 — @types/express 불요(동적 require).
  const { raw, json } = require('express') as { raw: (o: { type: string | string[]; limit: string }) => unknown; json: (o: { type?: string | string[]; limit: string }) => unknown };
  // ※ 라우트 스코프로 제한 — 전역 등록 시 인증(가드) 이전에 모든 경로가 최대 21MB 를 버퍼링해
  //   무인증 대량 전송으로 힙을 소모시킬 수 있다(문서 업로드·첨부 경로에만 필요).
  const RAW_PDF_PATHS = ['/v1/contracts/:id/document', '/v1/contracts/:id/attachments', '/v1/requests/:id/document'];
  const RAW_IMG_PATHS = ['/v1/contracts/:id/attachments'];
  for (const path of RAW_PDF_PATHS) app.use(path, raw({ type: 'application/pdf', limit: `${docMaxMb + 1}mb` }));
  // 계약 첨부(설계 §11) — 이미지 첨부 raw 수용(PNG·JPEG)
  for (const path of RAW_IMG_PATHS) app.use(path, raw({ type: ['image/png', 'image/jpeg'], limit: `${docMaxMb + 1}mb` }));
  // CSP 위반 리포트(S3) — 브라우저는 application/csp-report 로 보낸다(전역 json 이 못 받음). 무인증 경로라 64kb 상한.
  app.use('/v1/csp-report', json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' }));
  // 계약 마크 스탬프(POST /v1/contracts/stamp)의 pdfBase64 수용 — base64 +33% 여유 포함 JSON 상한 상향.
  app.use(json({ limit: `${Math.ceil(docMaxMb * 1.5) + 1}mb` }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  setupSwagger(app); // /api-docs — 운영 기본 OFF(env 게이트)
  const port = Number(process.env.SIGN_PORT ?? 4000);
  await app.listen(port);
  new Logger('main').log(`sign 서비스 기동 — http://localhost:${port}`);
}

bootstrap();
