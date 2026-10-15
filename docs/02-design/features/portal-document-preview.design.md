# 환자 포털 문서 미리보기 (PDF 뷰어) 설계

> 환자가 **서명하기 전에 실제 동의서 PDF를 열람**하도록 하는 기능의 설계 문서.
> 계획서 `docs/02-design/ui-ux-extension-plan.md` §P0-1(최우선)의 선행 결정(문서 전달/PHI 보관 정책)을 확정하고 구현 설계를 확정한다.
>
> 작성: 2026-07-04 · 대상: 제품/백엔드/프론트엔드 · 상태: **설계 확정, 구현 대기(보안검토 선행)**
> 확정 결정: **Option A — 서명창 한정 암호화 임시보관** (사용자 승인 2026-07-04)

## 0. 결론

- 문제: 현재 sign은 문서 **바이트를 보유하지 않고** `documentHash`(SHA-256 64자)만 가진다. 포털은 해시 앞 12자만 표시(`web/src/app/portal/[token]/page.tsx:481`)하고 **실제 문서를 못 보여준다** → 환자가 무엇에 서명하는지 시각 확인 불가(설명동의·법적 무결성 약점).
- 결정: **Option A** — caller(HIS/PACS/ERP)가 서명 대상 PDF를 sign에 업로드, sign이 `SHA-256 == documentHash`를 검증하고 **AES-256-GCM으로 암호화 저장**, 포털 토큰으로만 스트리밍, **서명 완료/만료 시 자동 파기**.
- 핵심 프레이밍: sign은 문서를 **영구 PHI 저장소가 아니라 "서명 창(signing window) 한정 암호화 임시 캐시"** 로 보관한다 → 기존 "PHI 원본 금지 — 해시만" 원칙과 충돌하지 않는다(§2).

## 1. 현재 상태 (구현 조사 결과)

| 영역 | 현재 | 근거 |
|---|---|---|
| 포털 화면 | 메타데이터 카드(제목·문서ID·해시 앞 12자)만. **PDF 없음** | `web/src/app/portal/[token]/page.tsx:470-490` |
| 문서 표현 | `documentHash`(전체) + `externalDocId` + `title`만 저장. **바이트 없음** | `prisma/schema.prisma:82-110`, `src/domain/types/store.types.ts:55-74` |
| ~~`documentUri` 슬롯~~ | ~~Prisma·plan 스키마에 존재하나 **완전 미배선**(read/write 0건) — 죽은 슬롯~~ **→ P1.1에서 제거**(`0005_drop_document_uri`) | ~~`schema.prisma:92`~~ |
| 유일한 PDF | 감사인증서(`pdf-lib`+`PadesSignerService.signPdf`) — 서명대상 문서 아님. 재사용 가능 인프라 | `src/application/audit-certificate.service.ts`, `src/infrastructure/pades/pades-signer.service.ts` |
| 포털 토큰 | 단일사용+만료만. phone/IP/device 바인딩 **코드 미구현**(DMZ 프록시 이연) | `src/application/patient-token.service.ts:5-63` |
| 포털 엔드포인트 | `GET /v1/portal/:token`·`POST /v1/portal/:token/sign` **공개**(토큰이 자격증명) | `src/presentation/portal.controller.ts:36-47` |
| PHI 원칙 | "PHI 원본 금지 — 식별자·해시만" 전 핸드오프 문서 반복 명시 | `docs/05-handoff/his-integration-guide.md:143,147` 외 |

## 2. 선행 결정: A vs B — 왜 A인가

계획서가 남긴 유일한 미결정. 두 안의 트레이드오프와 **재구성 논거**:

| | A — 업로드 암호화 임시보관(확정) | B — 무보관 URL 프록시 |
|---|---|---|
| sign 문서 보유 | 서명창 동안 암호화 임시보관, 완료/만료 시 파기 | 미보유 |
| WYSIWYS 무결성 | **강** — 서명하는 해시의 바로 그 바이트를 열람(업로드·열람 이중 해시검증) | 약 — 표시 문서 ≠ 서명 해시 가능(caller가 다른 바이트 서빙해도 sign 탐지 불가) |
| 원외 비대면(목표①) | 환자 기기는 sign(원내/DMZ)만 접근 | 환자 기기가 **HIS 문서 URL을 공용 인터넷에서 로드** → HIS가 문서 URL 외부 노출 |
| caller 부담 | 업로드 1회 | 3개 시스템 각각 단기 서명 URL·CORS·만료·해시검증 구현 |
| PHI 표면 | 원내망 암호화 저장(외부 반출 아님) | HIS 문서를 외부에 노출 |

**재구성 논거(핵심)**: "PHI 원본 금지" 원칙의 목적은 ⑴ PHI 표면 최소화 ⑵ PHI를 **원내망에 고정**이다. sign은 **원내 구축형(on-prem)** 이므로 암호화 저장해도 PHI가 원내망을 벗어나지 않는다 = 외부 반출 아님. 오히려 B는 원외 환자를 위해 HIS 문서 URL을 공용 인터넷에 열어야 하므로 **PHI 경계를 더 크게 연다**. 따라서 A를 "서명창 한정 암호화 임시 캐시 + 자동 파기"로 설계하면 sign은 여전히 "서명·해시의 정본"일 뿐 영구 PHI 저장소가 되지 않으며, 법적 무결성(목표②·WYSIWYS)까지 최강이 된다.

**B는 폴백으로 남긴다**: 보존 정책 `NONE` 모드(§4)로 특정 caller/문서에 대해 무저장 URL 방식을 선택할 수 있게 열어둔다.

## 3. 아키텍처

```
HIS/PACS/ERP ──(1) PUT PDF bytes──▶ sign
                                      ├─ SHA-256(bytes) == request.documentHash ? (불일치→422 거부)
                                      ├─ %PDF 매직·크기·MIME 검사
                                      └─ AES-256-GCM 암호화 저장(RequestDocument)

환자(포털 토큰) ──(2) GET .../document──▶ sign
                                      ├─ 토큰 유효·미만료 ? (소비하지 않음 — 재열람 허용)
                                      ├─ 복호화 → SHA-256 재검증(방어심층)
                                      ├─ application/pdf, Content-Disposition: inline, no-store
                                      └─ DOCUMENT_VIEWED 감사 봉인(F008)

스케줄러 ──(3) 완료/만료/TTL──▶ deleteDocument(requestId) → 이후 410 Gone
                                      (감사인증서는 해시만 쓰므로 계속 동작)
```

### 3.1 신규 엔드포인트

| 목적 | 라우트 | 인증 | 실패 |
|---|---|---|---|
| 문서 업로드(caller) | `PUT /v1/requests/:id/document` (`application/pdf`) | `ApiKeyGuard` scope `requests:write` | 해시불일치 422 · 비PDF 415 · 초과 413 · 완료요청 409 |
| 문서 열람(환자) | `GET /v1/portal/:token/document` | 공개(토큰 스코프) | 무/무효토큰 401 · 만료·파기됨 410 · 미보유 404 |
| 관리자 검토 | `GET /v1/requests/:id/document` | RBAC scope `documents:read`(admin·operator) | 미보유 404 |
| 보존 sweep(운영/크론) | `POST /v1/maintenance/document-sweep` | `requests:write` | — |

- caller 기계키는 **업로드만 가능, 되읽기 불가**(문서 read는 포털 토큰/관리자 전용) — 최소권한. 업로드 바디는 `main.ts`의 `express.raw({type:'application/pdf'})`로 Buffer 파싱.
- 열람 토큰은 **소비하지 않음**(단일사용은 서명 액션에만 유지) → 환자가 문서를 여러 번 열 수 있음.

### 3.2 저장 계층

- **암호화**: AES-256-GCM. 기존 `SecretBox`(`CRYPTO_MASTER_KEY`) 재사용 — `sealBytes/openBytes`(Buffer) 추가. 서명키와 분리. 저장물 = `{iv, enc, tag}`.
- **모델(P1 구현 확정)**: 전용 Prisma 테이블(`RequestDocument`) 대신 **기존 meta KV**(`SIGN_STORE` `saveMeta/getMeta`, `docblob:<requestId>` 슬롯)에 봉인 블롭 저장 — ptoken·CA번들과 동일 패턴, **마이그레이션 불요**(라이브 DB 위험 회피). 파기용 `deleteMeta(key)` **한 개**만 포트에 추가 → InMemory/File/Prisma 3드라이버 드롭인. 블롭 = `{sealed, sha256, contentType, sizeBytes, uploadedAt, expiresAt}`.
  - *후속 최적화(여지)*: 대용량·다건 운영 전환 시 `Bytes` 전용 테이블 + migration으로 승격(base64 JSON KV의 저장 효율 한계). 파일럿·플래그 OFF 단계에서는 meta KV로 충분.
- **뷰 플래그**: 포털 `view()`가 `docs.has(requestId)` 로 `documentAvailable` 노출(해시·바이트 미노출, 열람은 별도 EP). `StoredRequest` 스키마 변경 없음.
- 죽은 `documentUri` 슬롯 정리는 후속(P1.1)로 이연 — 이번 P1은 비배선 슬롯 미사용 유지(스키마 무변경). **→ P1.1 완료**: `signature_requests.documentUri`(read/write 0건) 스키마 필드 제거 + `0005_drop_document_uri` migration(`DROP COLUMN IF EXISTS`). 운영 영속화는 `store_records` JSON KV라 무영향, 전체 회귀 0실패.

### 3.3 보존·파기 정책

- 설정 `PORTAL_DOC_RETENTION`:
  - `SIGNING_WINDOW`(**기본·권장**) — 요청 COMPLETED(전원 서명) + 유예 또는 만료/철회 시 파기.
  - `TTL` — 고정 만료(기본 48h, 토큰 TTL 정렬, 캡 설정).
  - `NONE` — 미저장(= Option B 폴백, URL 방식 caller용).
- 기존 인앱 스케줄러가 sweep(만료·완료 문서 `deleteDocument`). 파기 후 열람 EP는 410.

## 4. 프론트엔드 (포털 뷰어)

- `web/src/app/portal/[token]/page.tsx` 'info' 단계에 문서 패널 추가.
- **v1 렌더링 = 네이티브 `<iframe src=".../document">`** (브라우저 내장 뷰어) — JS 의존성 0, CSP 안전, 모바일 핀치줌 지원. + "새 탭에서 열기 / 다운로드" 폴백 링크.
  - iOS Safari·Android Chrome 인라인 렌더 **측정 후**, 불일치가 크면 v2에서 **pdf.js 로컬 번들**로 승격(외부 CDN 금지 — CSP·on-prem).
- **해시 일치 배지**: "표시 문서 = 서명 대상 (SHA-256 ✓)" — 백엔드가 보증, 신뢰 신호로 표시.
- **동의 게이트(권장 ON)**: 문서 열람 전 "동의하고 서명" 비활성 → "문서를 확인했습니다" 체크 후 활성. 설명동의(informed consent) 강화.
- **접근성**(P1 연계): 문서 제목·확대·다운로드 대체경로(스크린리더는 PDF 내부 불투명 → 대체 텍스트·다운로드 제공).
- 서버렌더 폴백(`src/presentation/portal.view.ts`)에도 문서 링크 추가.

## 5. 보안 고려사항

- 암호화 저장(AES-256-GCM) · **업로드+열람 이중 SHA-256 검증**(WYSIWYS + 변조 탐지).
- 열람 응답: `Cache-Control: no-store` · `X-Content-Type-Options: nosniff`. **크로스오리진 뷰어 프레이밍**: 웹(SPA)이 API 오리진의 PDF를 iframe 임베드하므로 helmet 기본 `X-Frame-Options: SAMEORIGIN` 을 문서 라우트에서 해제하고 `CSP frame-ancestors` 로 허용 오리진 제한(`CORS_ORIGINS`, 미설정=dev/e2e 개방). 읽기전용·토큰스코프 PDF라 클릭재킹 위험 낮음(`src/presentation/document-headers.ts`).
- 업로드: `%PDF` 매직바이트 검사 · 크기 상한(예 20MB) · 암호걸린 PDF 거부(렌더 불가) · MIME 검증.
- 접근통제: 열람=포털토큰(환자)/RBAC(관리자)만, caller 기계키 read 불가.
- PHI 최소화: 보존=서명창, 자동파기, **전 열람 감사(F008 접속기록)**.
- 레이트리밋(기존 하드닝 `hardening-ratelimit`) 적용.
- **go-live 전 보안검토 필수**(계획서 §133).

## 6. 수용 기준

- 포털에서 실제 PDF 렌더 · **표시 문서 SHA-256 == documentHash**(서버 검증).
- 무토큰/무효 → 401, 만료/파기 → 410, 미보유 → 404.
- 업로드 해시 불일치 → 422(요청은 문서 없는 상태 유지).
- 요청 완료/만료 후 문서 파기 → 열람 EP 410(스케줄러 테스트로 검증).
- 모바일 인라인 렌더·핀치줌(iOS Safari + Android Chrome).
- DOCUMENT_VIEWED 감사 봉인 · caller 기계키 문서 read → 403.

## 7. 테스트 계획

- **백엔드 e2e**(`test/portal-document.e2e.mjs` 신설): 업로드(매치 200 / 불일치 422 / 비PDF 415 / 초과 413) · 포털 열람(유효 200 application/pdf / 무토큰 401 / 만료 410 / 미보유 404) · 파기(스케줄러 → 410) · 접근통제(HIS키 read 403). 회귀 게이트(`e2e`→CI `e2e:all`) 편입.
- **UI E2E**(Playwright `web/tests/e2e/portal-document.spec.ts`): 포털 PDF iframe 표시 · 해시 일치 배지 · 동의 게이트(열람 전 비활성) · 다운로드 폴백. axe(뷰어 포함 포털).

## 8. 단계·규모

| 단계 | 내용 | 상태 |
|---|---|---|
| P0 | 설계 + PHI 정책 결정(A 확정) + 보안검토 sign-off | 설계·결정 완료, **보안검토 대기** |
| P1 백엔드 | meta-KV 봉인 저장(+deleteMeta) · 업로드/열람/관리자 EP · AES-256-GCM(SecretBox) · sweep 파기(스케줄러+수동 EP) · DOCUMENT_VIEWED 감사 · e2e | **완료**(`test/portal-document.e2e.mjs` 17/17, 게이트 편입) |
| P2 프론트 | 포털 뷰어(네이티브 iframe) · 해시 배지 · 동의 게이트(문서 확인 전 서명 비활성) · a11y · UI E2E | **완료**(`web/tests/e2e/portal-document.spec.ts`, UI 29/29) |
| P3 연동 | HIS/PACS/ERP 핸드오프 스펙에 업로드 계약 추가 · 1개 caller 파일럿 | 대기 |

- 피처플래그 `PORTAL_DOC_PREVIEW` 기본 **OFF**(미설정 시 업로드 404, PHI 저장 방지) → 보안검토 후 caller별 활성. 설정: `PORTAL_DOC_MAX_MB`(기본 20)·`PORTAL_DOC_RETENTION_HOURS`(기본 48). **규모 L**.

## 9. 미결/후속

- 보안검토 sign-off(정책상 선행).
- 대용량 PDF 스트리밍·메모리(청크 스트리밍 여부) — P1에서 결정.
- 스캔 PDF(이미지형) 렌더 확인 — 수용기준에 포함.
- ~~`documentUri` 죽은 슬롯 정리 위치(이 작업 P1).~~ **완료(P1.1)**: 스키마 필드 제거 + `0005_drop_document_uri` migration.
