import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 스펙에 박히는 API 버전 — `npm_package_version` 은 npm 스크립트로 실행할 때만 채워진다.
 * `node dist/swagger-export.js` 를 직접 돌리면 비어 있어 엉뚱한 버전이 스펙에 남으므로 package.json 을 읽는다.
 */
function apiVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  for (const dir of [process.cwd(), join(__dirname, '..')]) {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version as string;
    } catch {
      /* 다음 경로 시도 */
    }
  }
  return '0.0.0';
}

/**
 * 스펙 상단 설명 — 개별 엔드포인트를 보기 전에 알아야 하는 **연동 계약**을 한곳에 모은다.
 * (인증·스코프·멱등·에러·통지·버전 정책). 서술형 가이드는 `docs/05-handoff/api-catalog.md`.
 */
const API_DESCRIPTION = [
  '의료/IT 전자서명 트러스트 서비스 REST API. HIS·PACS·ERP·교육·계약 등 외부 시스템이 이 API 로 연동한다.',
  '',
  '### 인증',
  '- **`x-api-key`** — 기계 연동(ConsumerApp). 소비자별로 **스코프**가 부여되며, 각 엔드포인트에 필요한 스코프는 `x-required-scope` 확장 필드에 표기돼 있다. 부족하면 403 `FORBIDDEN`.',
  '- **`Authorization: Bearer`** — ①콘솔 세션 토큰(사람) ②HIS SSO STAFF 토큰(`aud=sign`, 의료진 서명 전용).',
  '- **포털/교부 토큰** — URL 에 포함된 1회용 토큰 자체가 인증. 별도 키가 필요 없다.',
  '- **무인증 공개** — `verify`·`ocsp`·`crl`·`health`·포털 페이지·감사추적인증서.',
  '',
  '### 요청·응답 규약',
  '- 성공은 `{ "data": ... }`, 목록은 `{ "data": [...], "page": {...} }`. 오류는 `{ "error": { "code", "message", "requestId" } }` — 지원 문의 시 `requestId` 를 함께 전달한다.',
  '- **멱등** — 서명요청 생성은 `idempotencyKey` 로 재시도 안전(같은 키 → 같은 요청 반환). Webhook 수신 측은 본문 `eventId` 로 멱등 처리해야 한다(재시도·재발송이 같은 값을 보낸다).',
  '- **시각**은 전부 ISO-8601 UTC, **문서 해시**는 SHA-256 소문자 hex.',
  '- 운영 하드닝 시 분당 요청 상한(`RATE_LIMIT_PER_MIN`)이 적용된다 — 초과 시 429.',
  '',
  '### Webhook(sign → 연동 시스템)',
  '- 요청 생성 시 `callbackUrl` 로 등록. 서명 완료·만료·중간 서명 등 이벤트를 POST 하며 `X-Sign-Signature`(HMAC-SHA256) 로 서명한다.',
  '- 2xx 만 성공으로 보고 최대 8회 재시도 후 **DEAD**. DEAD 는 자동 재시도 대상이 아니며 운영자가 재발송(`webhook-redrive`)하거나 폐기(`webhook-discard`)한다.',
  '',
  '### 버전·호환',
  '- 경로 접두사 `/v1` 이 계약 단위다. 필드 **추가**는 호환 변경으로 보고 사전 통보 없이 배포될 수 있으므로, 수신 측은 모르는 필드를 무시하도록 구현한다.',
  '- 피처플래그로 꺼진 기능(`GENERAL_CONTRACTS`·`ELECTRONIC_APPROVAL`·`PORTAL_DOC_PREVIEW`)은 404 를 반환한다.',
].join('\n');

/**
 * OpenAPI(Swagger) 문서 — 연동·SaaS 파트너용 기계가독 API 명세.
 * 그룹(태그)·인증 표기·서버 목록까지 여기서 정의하며, 오퍼레이션별 설명·스코프는
 * 컨트롤러의 JSDoc 과 `@RequireScope`/인증 표시 데코레이터에서 자동으로 채워진다.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('sign — 의료/IT 전자서명 트러스트 서비스 API')
    .setDescription(API_DESCRIPTION)
    .setVersion(apiVersion())
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'x-api-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'staff-sso')
    .addServer(process.env.PUBLIC_BASE_URL ?? 'https://sign.example.org', '운영')
    .addServer('http://127.0.0.1:4000', '로컬 개발')
    // 태그 순서 = 연동 개발자가 읽는 순서(발급 → 요청 → 서명 → 검증 → 그 외). 콘솔 전용은 뒤로.
    .addTag('인증서(연동 API)', '서명 주체의 말단 인증서 발급·정지·폐기. 서명요청 참가자는 여기서 받은 시리얼로 연결한다.')
    .addTag('서명요청(연동 API)', '연동의 본류 — 요청 생성 → 발송 → 진행 조회 → 검증 → webhook 통지·재발송/폐기.')
    .addTag('서명 수행', '의료진(STAFF) 서명. HIS SSO Bearer 로 본인확인을 대체한다.')
    .addTag('서명 포털(수신자)', '앱 미설치 수신자용 브라우저 서명 경로. 1회용 토큰이 곧 인증이다.')
    .addTag('전자계약', '일반 전자계약 트랙(준비→발송→체결→관리). 피처플래그 `GENERAL_CONTRACTS`.')
    .addTag('공개 검증(무인증)', '누구나 호출 가능 — 검증·OCSP·CRL·헬스체크. 키가 필요 없다.')
    .addTag('감사·인증 로그', '해시체인 감사 이력·인증 행위 로그·문서 인증(wsign) 조회.')
    .addTag('전자결재(플래그)', '상신→결재 워크플로우. 피처플래그 `ELECTRONIC_APPROVAL`(기본 OFF).')
    .addTag('테넌트 운영(콘솔)', '소비자(기계 연동) 등록·키 회전, 관리자 계정, 연동 설정 — **콘솔 전용, 연동 API 아님**.')
    .addTag('CA 운영(콘솔)', 'CA 키 회전 등 트러스트 앵커 운영 — **콘솔 전용**.')
    .addTag('운영 상태', 'readiness·운영 지표·실시간 이벤트 스트림.')
    .build();
  return SwaggerModule.createDocument(app, config);
}

/**
 * Swagger UI 마운트 — **운영 공개 노출 금지**. 정찰·Try-it-out 위험.
 * 게이트: 비-production 이거나 SWAGGER_ENABLED=true 일 때만. 운영은 기본 OFF.
 * (운영에서 켜더라도 nginx 미프록시/내부망 한정 권장.)
 */
export function setupSwagger(app: INestApplication): boolean {
  const enabled = process.env.SWAGGER_ENABLED === 'true' || process.env.NODE_ENV !== 'production';
  if (!enabled) return false;
  SwaggerModule.setup('api-docs', app, buildOpenApiDocument(app));
  new Logger('Swagger').warn('Swagger UI 활성 (/api-docs) — 운영 공개 노출 금지');
  return true;
}
