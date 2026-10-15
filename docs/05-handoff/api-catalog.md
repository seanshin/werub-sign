# sign API 카탈로그 — 연동·SaaS 온보딩 기준 문서

> 대상: sign 을 API 로 연동하는 외부 시스템 개발자 · SaaS 로 sign 을 쓰는 테넌트 담당자
> 기준: **v1.25.0** (`docs/openapi.json`, 140 경로 / 158 오퍼레이션)
> 기계가독 스펙: [`docs/openapi.json`](../openapi.json) — 이 문서의 엔드포인트 표는 그 스펙에서 생성한다(`npm run api:catalog`).

이 문서 하나로 **무엇을 부를 수 있고, 어떤 자격증명이 필요하며, 무엇이 연동 대상이 아닌지**를 판단할 수 있게 하는 것이 목표다.
설계 배경은 [`../02-design/signing-flows.md`](../02-design/signing-flows.md), 시스템별 연동 절차는 [`README.md`](./README.md) 의 각 핸드오프 문서를 본다.

---

## 1. 시작하기

| 항목 | 값 |
|---|---|
| 운영 베이스 URL | `https://sign.example.org` |
| 경로 접두사 | `/v1` (계약 단위 — 파괴적 변경 시 `/v2` 를 신설한다) |
| 인코딩 | UTF-8 · JSON. 문서 업로드만 `application/pdf` 바이트 |
| 시각 | ISO-8601 UTC (`2026-07-29T01:23:45.678Z`) |
| 문서 해시 | SHA-256 소문자 hex |
| 스펙 | `docs/openapi.json` (Swagger UI 는 운영 비공개 — 내부망/개발에서만 `/api-docs`) |

**첫 호출까지의 순서**
1. 테넌트 관리자가 콘솔에서 **소비자(ConsumerApp)** 를 발급한다 → `x-api-key` 와 스코프를 받는다(§2.2).
2. 서명 주체의 **인증서를 발급**한다(`POST /v1/certificates/enroll`) → `serialNumber`.
3. **서명요청을 생성**한다(`POST /v1/requests`) — 문서 해시·참가자·`callbackUrl`·`idempotencyKey`.
4. 발송(`/notify`) 또는 포털 링크 발급(`/portal-tokens`) → 수신자가 서명.
5. 완료 시 `callbackUrl` 로 **webhook** 수신 → 필요하면 `GET /v1/verify/{requestId}` 로 검증.

---

## 2. 인증

### 2.1 네 가지 경로

| 방식 | 헤더/위치 | 쓰는 곳 | 실패 |
|---|---|---|---|
| **기계 API 키** | `x-api-key: <key>` | 시스템 연동 전반 | 401 `UNAUTHORIZED` / 스코프 부족 403 `FORBIDDEN` |
| **콘솔 세션** | `x-session-token` 또는 `Authorization: Bearer` | 사람이 쓰는 관리 콘솔 — **연동 API 아님** | 401 |
| **STAFF SSO** | `Authorization: Bearer <HIS SSO>` (`aud=sign`) | 의료진 본인의 서명·결재 | 401 / 바인딩 불일치 403 |
| **URL 토큰** | 경로에 포함된 1회용 토큰 | 수신자 서명 포털 · 완료 문서 교부 · 공개 검증 | 만료·사용완료·철회 시 4xx |

무인증 공개는 검증(`/v1/verify/...`)·OCSP·CRL·헬스체크·감사추적인증서다.
`GET /v1/requests/{id}` 등 **PII 상세 조회는 운영에서만 키를 요구**한다(개발 환경은 통과) — 개발에서 되던 호출이 운영에서 401 이 나는 전형적인 함정이라, 스펙에도 `x-auth: prod-api-key` 로 표기했다.

### 2.2 스코프 — 최소권한으로 발급한다

각 엔드포인트가 요구하는 스코프는 스펙의 **`x-required-scope`** 에 그대로 들어 있다(아래 §5 표의 "인증" 열과 동일).

| 스코프 | 할 수 있는 일 | 연동 키에 부여 |
|---|---|---|
| `requests:write` | 서명요청 생성·발송·철회·조회, 배치, webhook 재발송/폐기 | ✅ 기본 |
| `certificates:write` | 인증서 발급·정지·재개·폐기 | ✅ 발급 주체만 |
| `contracts:read` / `contracts:write` | 전자계약 조회 / 생성·발송·관리 | ✅ 계약 연동만 |
| `documents:read` | 서명 대상 PDF 열람 | ⚠️ 필요한 경우만 |
| `approval:write` / `approval:act` | 전자결재 상신 / 결재 행위 | ⚠️ 플래그 ON 시 |
| `settings:write` | 연동 설정(본인확인·발송·키수탁) 변경 | ❌ 콘솔 |
| `contracts:templates` | 계약 **서식 본문** 변경 — 이후 모든 계약 문안을 좌우 | ❌ 사람(admin)만 |
| `ca:admin` | CA 키 회전·소비자 발급 | ❌ 콘솔(민감) |
| `users:admin` | 관리자 계정·관리자 감사 | ❌ 콘솔(민감) |

- 기계키에 부여 가능한 스코프는 **화이트리스트**로 제한된다(`ASSIGNABLE_SCOPES`) — `ca:admin`·`users:admin`·`contracts:templates` 는 콘솔에서도 기계키에 줄 수 없다.
- 사람 계정 역할: `admin`(전체) · `operator`(운영 업무) · `viewer`(읽기 전용, 민감 스코프는 GET 도 차단).
- **키 회전**은 콘솔에서 즉시 가능하다(`/v1/admin/consumers`). 유출이 의심되면 회전이 먼저다.

---

## 3. 공통 규약

**응답 형태**
```jsonc
{ "data": { ... } }                     // 단건
{ "data": [ ... ], "page": { "limit": 20, "offset": 0, "total": 137 } }   // 목록
{ "error": { "code": "FORBIDDEN", "message": "scope 부족: requests:write", "requestId": "…" } }
```
장애 문의 시 **`requestId`** 를 함께 전달하면 서버 로그·감사와 즉시 대조된다.

**주요 오류 코드**

| HTTP | code | 의미·대응 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 입력 형식 오류 — 메시지의 필드명을 본다 |
| 401 | `UNAUTHORIZED` | 키·토큰 없음/무효 |
| 403 | `FORBIDDEN` | 스코프 부족(메시지에 필요한 스코프 명시) · 소유권 위반 |
| 404 | `NOT_FOUND` | 대상 없음 **또는 피처플래그 OFF** |
| 409 | `CONFLICT` | 상태 충돌(이미 서명·완료·철회된 건에 대한 변경) |
| 413/415/422 | — | 문서 크기·형식·해시 불일치 |
| 429 | `TOO_MANY_REQUESTS` | 분당 상한 초과(운영 하드닝) 또는 포털 unlock 잠금 |

**멱등**
- 서명요청 생성은 `idempotencyKey` 로 재시도 안전 — 같은 키는 새로 만들지 않고 기존 요청을 돌려준다. 네트워크 타임아웃 시 **같은 키로 재시도**하는 것이 올바른 복구다.
- Webhook 수신 측은 본문 `eventId` 로 멱등 처리해야 한다(재시도·재발송이 같은 값을 보낸다).

**페이지네이션·검색** — `limit`(기본 20, 최대 100)·`offset`·`q`(서버측 검색)·`from`/`to`/`days`·`status`. 목록 CSV 는 `export.csv` 경로.

---

## 4. Webhook (sign → 연동 시스템)

| 항목 | 규약 |
|---|---|
| 등록 | 요청 생성 시 `callbackUrl`(운영은 https 강제·사설망 차단) |
| 서명 | `X-Sign-Signature: <HMAC-SHA256(body, 소비자 시크릿)>` — **본문 바이트 그대로** 검증 |
| 멱등 | 본문 `eventId` |
| 성공 판정 | **2xx 만 성공** — 그 외 응답·타임아웃은 재시도 |
| 재시도 | 최대 8회(지수 백오프) → 초과 시 **DEAD**(자동 재시도 중단) |
| 복구 | 운영자가 `POST /v1/maintenance/webhook-redrive`(경로 변경 시 `newTargetUrl` 재지정) 또는 `webhook-discard`(수신처 폐지 시 폐기) |
| 확인 | `GET /v1/requests/{id}/webhooks` · `GET /v1/maintenance/webhook-dead` |


⚠️ **경로를 바꾼 뒤에는 두 곳을 고쳐야 한다**(2026-08-08 사고). 통지의 `targetUrl` 은 요청 생성 시점 `callbackUrl` 의 **사본**이라, 연동처 코드만 고치면 **그 전에 만들어진 요청**이 만료·완료될 때마다 옛 주소로 발사돼 새 DEAD 를 만든다.

1. 저장된 요청의 주소 정정 — `POST /v1/maintenance/callback-retarget {fromUrl, toUrl}`(기본 모의 실행, 적용은 `dryRun:false`)
2. 이미 만들어진 통지 재발송 — `POST /v1/maintenance/webhook-redrive {targetUrl, newTargetUrl}`

2번만 하면 다음 만료 때 같은 경보가 다시 온다.

---

## 5. 엔드포인트 카탈로그

인증 열: `스코프` 표기는 해당 스코프를 가진 `x-api-key`(또는 동등 역할의 콘솔 세션)가 필요하다는 뜻이다.

<!-- AUTO:endpoints:start -->

> 이 절은 `npm run api:catalog` 가 `docs/openapi.json`(v1.30.1)에서 생성합니다 — **직접 편집하지 마세요**.
> 전체 144 경로 · 162 오퍼레이션.

### 인증서(연동 API) (8)

서명 주체의 말단 인증서 발급·정지·폐기. 서명요청 참가자는 여기서 받은 시리얼로 연결한다.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/certificates` | 운영 시 키 | 발급 인증서 목록 — 소유자 유형·상태 필터, 페이지네이션. 콘솔 인증서 화면·연동 조회용(운영에서는 x-api-key 필요). |
| GET | `/v1/certificates/{serial}/audit` | 무인증 | 인증서 감사 이력 — 발급·정지·재개·폐기 등 상태 변화의 해시체인 기록. |
| POST | `/v1/certificates/{serial}/resume` | `certificates:write` | 인증서 중단 해제 |
| POST | `/v1/certificates/{serial}/revoke` | `certificates:write` | 인증서 폐기(revoke) — 되돌릴 수 없다. 일시 중지가 목적이면 `suspend` 를 쓴다. CRL·OCSP 에 즉시 반영. |
| POST | `/v1/certificates/{serial}/suspend` | `certificates:write` | 인증서 중단(일시정지·가역) |
| GET | `/v1/certificates/{serial}/x509` | 무인증 | 실 X.509 인증서(PEM) 조회 — 표준 (공개) |
| POST | `/v1/certificates/enroll` | `certificates:write` | 인증서 발급(enroll) — 서명 주체(환자·의료진·기관)의 말단 인증서를 Issuing CA 로 발급한다. |
| GET | `/v1/certificates/export.csv` | 운영 시 키 | 인증서 목록 CSV 내보내기(심사·보존) — 동일 검색 전체. `:serial` 라우트보다 먼저 정의. |

### 서명요청(연동 API) (28)

연동의 본류 — 요청 생성 → 발송 → 진행 조회 → 검증 → webhook 통지·재발송/폐기.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/notifications` | `requests:write` | 발송 이력(전체) — 관리 콘솔 발송 이력 화면 |
| GET | `/v1/admin/notifications/export.csv` | `requests:write` | 발송 이력 CSV 내보내기(심사·보존) — 수신번호 마스킹값만. |
| POST | `/v1/maintenance/backup-heartbeat` | `requests:write` | 백업 성공 하트비트(보안 S9) — 호스트 cron(`scripts/backup-sign-db.sh`)이 백업 성공 시 호출한다. |
| POST | `/v1/maintenance/callback-retarget` | `requests:write` | 저장된 요청의 **콜백 주소 재지정** — 연동처가 수신 경로를 바꿨을 때 옛 주소가 박힌 요청을 일괄 정정한다. |
| POST | `/v1/maintenance/document-sweep` | `requests:write` | 포털 문서 보존 sweep — 종료 상태·TTL 경과 문서 파기(PHI 최소화, 스케줄러 병행·수동 호출) |
| POST | `/v1/maintenance/expire` | `requests:write` | 만료 배치 — 기한 경과 미완료 요청 EXPIRED 처리 (FR-13, 크론 호출) |
| POST | `/v1/maintenance/health-watch` | `requests:write` | 능동 감시 즉시 실행(보안 S9) — 스케줄러 주기(`SCHEDULER_WATCH_MIN`)와 별개로 지금 점검한다. |
| GET | `/v1/maintenance/webhook-dead` | `requests:write` | DEAD 적체 조회 — 재발송 전에 대상·원인(수신 URL)을 확인한다. |
| POST | `/v1/maintenance/webhook-discard` | `requests:write` | Webhook **DEAD 폐기** — 수신처가 폐지돼 재발송이 무의미한 건을 적체·경고 대상에서 뺀다. |
| POST | `/v1/maintenance/webhook-redrive` | `requests:write` | Webhook **DEAD 재발송** — 수신 측 장애·경로 오류로 재시도가 소진된 건을 운영자 판단으로 되살린다. |
| POST | `/v1/maintenance/webhook-retry` | `requests:write` | Webhook 재시도 배치 — 실패/대기 건 재전송 (유실 방지, 크론 호출) |
| GET | `/v1/requests` | `requests:write` | 서명요청 목록 — 검색(`q`)·상태·기간·생성자·서명방식 필터, 페이지네이션. |
| POST | `/v1/requests` | `requests:write` | 서명요청 생성 — 연동의 시작점. 문서 해시(`documentHash`)와 참가자(서명 순서·인증서·본인확인 수준)를 등록한다. |
| GET | `/v1/requests/{id}` | 운영 시 키 | 서명요청 단건 조회 — 상태·참가자별 서명 진행·버전(개정) 정보. H3: PII 상세라 운영에서는 x-api-key 를 강제한다(개발은 통과, verify/ocsp/crl 은 공개 유지). |
| GET | `/v1/requests/{id}/audit` | 운영 시 키 | 요청 감사 이력 — append-only 해시체인 엔트리 전체(생성→발송→서명→완료→통지). H3: PII 포함이라 운영에서는 x-api-key 를 강제한다(개발은 통과). |
| GET | `/v1/requests/{id}/audit-certificate` | 무인증 | 감사추적인증서 (PAdES 서명 PDF) — FR-05 |
| GET | `/v1/requests/{id}/audit/verify` | 무인증 | 감사 무결성 검증 (해시체인 + TSA 앵커) — FR-21 |
| GET | `/v1/requests/{id}/document` | `documents:read` | 관리자 문서 검토(RBAC documents:read) — 콘솔 요청 상세에서 서명 대상 PDF 열람. |
| PUT | `/v1/requests/{id}/document` | `requests:write` | 서명 대상 문서 업로드(caller) — 포털 미리보기용(설계 Option A). application/pdf 원본 바이트. |
| GET | `/v1/requests/{id}/notifications` | `requests:write` | 발송 이력(요청별) — 연락처 마스킹. 관리 콘솔 요청 상세 |
| POST | `/v1/requests/{id}/notify` | `requests:write` | 발송 — 참가자별 서명 링크 전송 (FR-10) |
| POST | `/v1/requests/{id}/supersede` | `requests:write` | C-2 문서 개정 재동의 — 원본을 새 버전으로 대체(supersede) |
| GET | `/v1/requests/{id}/webhooks` | `requests:write` | Webhook 전송 현황 조회 — HIS reconcile (유실·미수신 확인) |
| POST | `/v1/requests/{id}/withdraw` | `requests:write` | 동의 철회 (FR-13) |
| GET | `/v1/requests/export.csv` | `requests:write` | 요청 목록 CSV 내보내기(심사·보존) — 동일 필터 전체. `:id` 라우트보다 먼저 정의(정적 경로 우선). |
| POST | `/v1/sign-requests` | `requests:write` | 간편 서명요청 생성(레거시 호환 경로) — 신규 연동은 `POST /v1/requests` 를 사용한다. |
| POST | `/v1/sign/{participantId}/submit` | `requests:write` | 직접 서명 제출 — HIS-facing(모델 A, 서버↔서버 키 보유)만 허용. |
| GET | `/v1/verify/{requestId}` | 무인증 | 서명 검증 — 서명값·인증서 체인·타임스탬프·감사체인 무결성을 종합 판정(`overall`). 연동·감사 대응의 핵심 엔드포인트. |

### 서명 수행 (1)

의료진(STAFF) 서명. HIS SSO Bearer 로 본인확인을 대체한다.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/v1/sign/staff` | STAFF SSO | 의료진(STAFF) 서명 — HIS SSO Bearer 토큰으로 본인확인을 대체한다(별도 인증서 발급 불요, aud=sign). |

### 서명 포털(수신자) (8)

앱 미설치 수신자용 브라우저 서명 경로. 1회용 토큰이 곧 인증이다.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/portal/{token}` | 포털 토큰 | 포털 서명 페이지(HTML, 무인증 링크) — 수신자가 브라우저로 여는 진입점. |
| GET | `/v1/portal/{token}` | 포털 토큰 | 포털 서명 화면 데이터(토큰 인증) — 문서 요약·서명자·동의 항목. 토큰 만료·사용완료 시 4xx. |
| GET | `/v1/portal/{token}/attachments` | 포털 토큰 | 계약 첨부 목록(공개, 토큰) — 열람용 부속 문서 메타. 접근암호 계약은 unlock 후 열람. |
| GET | `/v1/portal/{token}/attachments/{aid}` | 포털 토큰 | 계약 첨부 다운로드(공개, 토큰) — unlock 게이트 + 접근 감사(best-effort). |
| GET | `/v1/portal/{token}/document` | 포털 토큰 | 환자 문서 열람(공개, 토큰) — 서명 대상 PDF 스트리밍. 토큰 미소비(재열람 허용, 소비는 서명에만). |
| POST | `/v1/portal/{token}/sign` | 포털 토큰 | 포털 서명 제출(토큰 인증) — 동의·손글씨 서명값을 봉인하고 서명을 완료한다. |
| POST | `/v1/portal/{token}/unlock` | 포털 토큰 | 일반 전자계약 접근암호 확인(unlock) — 통과 시 동일 토큰의 열람·서명 허용. 무차별 대입 방지 rate-limit. |
| POST | `/v1/requests/{id}/portal-tokens` | `requests:write` | 포털 서명 링크 발급 — 참가자별 1회용 토큰. 앱 미설치 수신자가 브라우저로 서명하는 경로. |

### 전자계약 (59)

일반 전자계약 트랙(준비→발송→체결→관리). 피처플래그 `GENERAL_CONTRACTS`.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/contracts` | `contracts:read` | 계약함 목록 — 서버측 검색·상태·기간 필터. |
| POST | `/v1/contracts` | `contracts:write` | 계약 생성 — 콘솔 세션 또는 기계키(HIS/ERP caller). 멱등. |
| GET | `/v1/contracts/{id}` | `contracts:read` | 계약 상세 — 봉투+메타(상대방 이메일 마스킹)+문서 보유. |
| POST | `/v1/contracts/{id}/archive` | `contracts:write` | 계약 보관(계약함에서 제거) — 목록 숨김·데이터/감사 보존·감사 기록. |
| GET | `/v1/contracts/{id}/attachments` | `contracts:read` | 첨부 목록. |
| POST | `/v1/contracts/{id}/attachments` | `contracts:write` | 첨부 추가(설계 §11) — 열람용 부속 문서(PDF·PNG·JPEG, 작성 상태 한정). raw body + ?name= (URL 인코딩). |
| DELETE | `/v1/contracts/{id}/attachments/{aid}` | `contracts:write` | 첨부 삭제 — 작성(미발송) 상태 한정(멱등). |
| GET | `/v1/contracts/{id}/attachments/{aid}` | `contracts:read` | 첨부 다운로드(콘솔). |
| PATCH | `/v1/contracts/{id}/category` | `contracts:write` | 계약 카테고리 변경(재분류). |
| POST | `/v1/contracts/{id}/deliver` | `contracts:write` | 교부 링크 재발급(수동) — 체결 완료 계약의 외부 서명자별 링크 재발급 + 이메일. |
| GET | `/v1/contracts/{id}/document` | `contracts:read` | 관리자 계약 문서 열람 — 서명 완료분의 손글씨를 서명란에 합성한 표시본(원본 무결성 유지, contracts:read — 콘솔 GET 공통 규칙). |
| PUT | `/v1/contracts/{id}/document` | `contracts:write` | 계약 원본 PDF 업로드 — SHA-256==documentHash 검증, 계약 트랙은 영구 암호화 보관(D4). |
| GET | `/v1/contracts/{id}/fill-values` | `contracts:write` | 기재값(fill-at-signing) 조회 — 서명자별 기재 원문·봉인 해시·무결성(증적 확인·분쟁 대응). |
| GET | `/v1/contracts/{id}/log` | `contracts:write` | 계약 이력(`contract:<id>` 감사 스트림) — 생성·발송·열람·서명·교부 타임라인. 서버측 필터(eventType/from/to/q). |
| GET | `/v1/contracts/{id}/log/export.csv` | `contracts:write` | 계약 이력 CSV(UTF-8 BOM). |
| GET | `/v1/contracts/{id}/log/verify` | `contracts:write` | 계약 이력 무결성(체인·TSA 앵커). |
| PATCH | `/v1/contracts/{id}/participants/{pid}/email` | `contracts:write` | 미서명 외부 서명자 수신 이메일 정정(R4) — 기존 링크 무효화 + 감사 봉인. 발송/독촉으로 새 링크 전송. |
| POST | `/v1/contracts/{id}/remind` | `contracts:write` | 재발송(독촉) — 미서명 외부 서명자 리마인드. |
| POST | `/v1/contracts/{id}/send` | `contracts:write` | 발송 — 외부 미서명자에게 포털 링크 이메일 전송. |
| POST | `/v1/contracts/{id}/sign` | `contracts:write` | 내부 서명 — 콘솔 사람 계정만(세션 주체 == 지정 서명자 바인딩). 손글씨 서명 이미지(선택). |
| PATCH | `/v1/contracts/{id}/sign-marks` | `contracts:write` | 서명란 좌표 재지정 — 기존 계약도 서명란 위치를 배치해 손글씨 합성이 되도록. |
| GET | `/v1/contracts/{id}/signature-image/{pid}` | `contracts:read` | 손글씨 서명 이미지 조회(행위 증거) — 관리자 상세 뷰. 참가자별(contracts:read — 콘솔 GET 공통 규칙, 이력 열람과 동일 신뢰경계). |
| GET | `/v1/contracts/{id}/signature-images` | `contracts:read` | 손글씨 서명 보유 참가자 목록(상세 뷰용). |
| GET | `/v1/contracts/{id}/status` | `contracts:write` | 계약 진행 상태(경량, R3) — 연동 시스템의 정합 확인용. 개인정보(이메일·기재값·문서) 미노출이라 |
| POST | `/v1/contracts/{id}/unarchive` | `contracts:write` | 계약 보관 복원 — 계약함 재노출. |
| POST | `/v1/contracts/{id}/withdraw` | `contracts:write` | 계약 철회(R5) — 계약 API 단독 완결용(봉투 철회와 동일 동작 + 계약 감사 봉인). |
| GET | `/v1/contracts/addressbook` | `contracts:read` | 계약 상대방 주소록 조회 — 자주 쓰는 서명자 정보. |
| POST | `/v1/contracts/addressbook` | `contracts:write` | 계약 상대방 주소록 등록. |
| DELETE | `/v1/contracts/addressbook/{id}` | `contracts:write` | 계약 상대방 주소록 삭제. |
| PATCH | `/v1/contracts/addressbook/{id}` | `contracts:write` | 계약 상대방 주소록 수정. |
| GET | `/v1/contracts/categories` | `contracts:read` | 카테고리별 집계(보관 제외) — 각 카테고리의 전체·체결완료 건수. |
| POST | `/v1/contracts/compose` | `contracts:write` | 서식 조판 — 최종 본문 텍스트 → 한글 A4 PDF 반환(저장 안 함). 클라가 SHA-256 계산 후 생성·업로드. |
| GET | `/v1/contracts/delivery/{token}` | 교부 토큰 | 교부 화면 정보(공개, 만료형 토큰) — 제목·만료·다운로드 가능 여부. |
| GET | `/v1/contracts/delivery/{token}/attachments` | 교부 토큰 | 교부 링크 첨부 목록(토큰 인증) — 완료 계약의 열람용 첨부. |
| GET | `/v1/contracts/delivery/{token}/attachments/{aid}` | 교부 토큰 | 교부 화면 첨부 다운로드(공개, 교부 토큰) — 접근 감사(best-effort). |
| GET | `/v1/contracts/delivery/{token}/certificate` | 교부 토큰 | 교부 — 감사추적인증서 PDF 다운로드(공개, 토큰). |
| GET | `/v1/contracts/delivery/{token}/document` | 교부 토큰 | 교부 — 완료 문서(원본 PDF) 다운로드(공개, 토큰). 전건 접속기록(F008). |
| POST | `/v1/contracts/delivery/{token}/extend` | 교부 토큰 | 교부 화면 첨부 목록(공개, 교부 토큰) — 열람용 부속 문서 메타. |
| POST | `/v1/contracts/delivery/{token}/forward` | 교부 토큰 | 지정 이메일로 문서 전달(공개, 토큰) — 새 교부 링크를 그 주소로 발송(링크당 3회 상한·감사 봉인). |
| GET | `/v1/contracts/export.csv` | `contracts:read` | 계약함 CSV — 메타만(문서 내용 미포함). |
| POST | `/v1/contracts/maintenance/auto-remind` | `contracts:write` | 자동 리마인더 수동 트리거(운영·테스트) — 스케줄러와 동일 로직(멱등). |
| GET | `/v1/contracts/presets` | `contracts:read` | 새 계약 프리셋 목록(U5) — 자주 쓰는 요청 구성(기관 공용). |
| POST | `/v1/contracts/presets` | `contracts:write` | 새 계약 프리셋 저장(U5) — 동일 이름 upsert. 접근암호 값 미저장. |
| DELETE | `/v1/contracts/presets/{pid}` | `contracts:write` | 계약 프리셋 삭제 — 생성자 또는 admin 만 가능(그 외 403). 삭제는 `admin:contract-presets` 감사에 봉인. |
| GET | `/v1/contracts/presets/{pid}` | `contracts:write` | 새 계약 프리셋 삭제(멱등). |
| GET | `/v1/contracts/reminder-status` | `contracts:read` | 리마인더·발송 정책 상태(알림·리마인더 화면, 읽기 전용). |
| POST | `/v1/contracts/stamp` | `contracts:write` | 업로드 PDF에 서명란·입력란 마크 스탬프(배치 편집기 좌표) — 저장 안 함, 결과 PDF 반환. |
| GET | `/v1/contracts/stats` | `contracts:read` | 계약 현황(대시보드 위젯) — 상태별 건수. (':id' 라우트보다 먼저 선언) |
| GET | `/v1/contracts/templates` | `contracts:read` | 계약 서식 목록 — 내장(builtin) + 기관 커스텀. |
| POST | `/v1/contracts/templates` | `contracts:templates` | 서식 생성(커스텀) — 관리자. |
| DELETE | `/v1/contracts/templates/{tid}` | `contracts:templates` | 커스텀 서식 삭제 — 관리자(내장 불가, 대신 기본값 복원). |
| GET | `/v1/contracts/templates/{tid}` | `contracts:read` | 계약 서식 상세 — 필드 정의 + {{키}} 본문(치환은 에디터가 수행). |
| PATCH | `/v1/contracts/templates/{tid}` | `contracts:templates` | 서식 수정 — 관리자. 내장은 기관 오버라이드로 저장(원본 보존·복원 가능), 커스텀은 직접 수정. |
| POST | `/v1/contracts/templates/{tid}/duplicate` | `contracts:templates` | 서식 복제(내장·커스텀 → 편집용 커스텀). |
| GET | `/v1/contracts/templates/{tid}/history` | `contracts:read` | 서식 변경 이력(버전 스냅샷, 최신순). |
| POST | `/v1/contracts/templates/{tid}/reset` | `contracts:templates` | 내장 서식 기본값 복원 — 오버라이드 제거(코드 원본으로). |
| POST | `/v1/contracts/templates/{tid}/restore/{version}` | `contracts:templates` | 서식 특정 버전으로 되돌림. |
| GET | `/v1/contracts/verify/{token}` | 검증 토큰 | 공개 검증(QR 스캔) — 계약 진위·서명 검증 요약(인증 불요, 영구 토큰). |
| GET | `/v1/contracts/verify/{token}/document` | 검증 토큰 | 공개 검증 — 완료 문서(합성본, QR 포함) 다운로드/미리보기(인증 불요, 영구 토큰). |

### 공개 검증(무인증) (3)

누구나 호출 가능 — 검증·OCSP·CRL·헬스체크. 키가 필요 없다.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/health` | 무인증 | 헬스체크 — 프로세스 생존 확인(무인증). 오케스트레이션 readiness 는 `GET /health/ready`. |
| GET | `/v1/crl` | 무인증 | CRL(인증서폐기목록, 무인증) — 폐기 시리얼 전체 목록. 검증 측 캐시 대상. |
| GET | `/v1/ocsp/{serial}` | 무인증 | OCSP 유사 조회(무인증) — 시리얼 단위 폐기 여부 즉시 확인. |

### 감사·인증 로그 (12)

해시체인 감사 이력·인증 행위 로그·문서 인증(wsign) 조회.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/audit` | `users:admin` | 스트림 엔트리(페이지네이션·서버측 필터). 프론트가 최신순 표시(역순). |
| GET | `/v1/admin/audit/export.csv` | `users:admin` | 서버측 필터 CSV(전체 일치분) — 심사·보존. |
| GET | `/v1/admin/audit/streams` | `users:admin` | 관리자 감사 스트림 목록(+건수). |
| GET | `/v1/admin/audit/verify` | `users:admin` | 무결성 검증(체인·TSA 앵커). |
| GET | `/v1/admin/wsign-documents` | `requests:write` | 문서 인증(wsign) 목록 — weRB 가 봉인한 문서 어테스테이션 통합 조회. |
| GET | `/v1/admin/wsign-documents/detail` | `requests:write` | 문서 상세 — 해당 문서 스트림의 전체 어테스테이션 이력 + 해시체인 무결성. |
| GET | `/v1/admin/wsign-documents/export.csv` | `requests:write` | 문서 인증 목록 CSV 내보내기(심사·보존). |
| GET | `/v1/audit-events` | `requests:write` | 스트림 행위 로그 조회 — 테넌트 격리 |
| POST | `/v1/audit-events` | `requests:write` | 행위 기록 — 해시체인 봉인(+옵션 TSA 앵커). 인증 영수증(entryHash·seq) 반환 |
| GET | `/v1/audit-events/export.csv` | `requests:write` | 서버측 필터 CSV(전체 일치분, 페이지 무관) — 심사·보존. |
| GET | `/v1/audit-events/streams` | `requests:write` | 감사 스트림 목록 — 의료기록(medical-records)·임상행위(clinical-events) 등 별도 관리 |
| GET | `/v1/audit-events/verify` | `requests:write` | 체인 무결성 + 앵커 검증 (위변조 탐지) |

### 전자결재(플래그) (9)

상신→결재 워크플로우. 피처플래그 `ELECTRONIC_APPROVAL`(기본 OFF).

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/approval-audit` | `approval:act` | 전체 결재 인증로그(페이지네이션·서버측 필터 eventType/from/to/q). 최신순. |
| GET | `/v1/admin/approval-audit/export.csv` | `approval:act` | 서버측 필터 CSV(전체 일치분) — 심사·보존. |
| POST | `/v1/approvals` | `approval:write` | 상신 — 결재선 지정 + 결재 봉투 생성. 콘솔 세션 또는 기계키(approval:write). |
| GET | `/v1/approvals/{id}` | `approval:act` | 결재 진행 상태 — 결재선·단계별 처리 결과. |
| POST | `/v1/approvals/{id}/act` | `approval:act` | 결재(승인/반려) — 콘솔 세션 결재자. 지정 결재자만. 고위험/최종 단계는 step-up. |
| POST | `/v1/approvals/{id}/act-staff` | STAFF SSO | 결재(승인/반려) — HIS 의료진 SSO Bearer 경유(JWKS 검증). ApiKeyGuard 비사용(staff-sign 동일 패턴). |
| GET | `/v1/approvals/{id}/authlog` | `approval:act` | 통합 인증로그(서버측 필터 eventType/from/to/q). |
| GET | `/v1/approvals/{id}/authlog/export.csv` | `approval:act` | 인증로그 CSV(심사·보존, UTF-8 BOM). |
| GET | `/v1/approvals/{id}/authlog/verify` | `approval:act` | 인증로그 무결성 검증(체인·TSA 앵커). |

### 테넌트 운영(콘솔) (26)

소비자(기계 연동) 등록·키 회전, 관리자 계정, 연동 설정 — **콘솔 전용, 연동 API 아님**.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/consumers` | `ca:admin` | 소비자 목록(키 값 제외) — 콘솔 회전·등록 UI. ca:admin. |
| POST | `/v1/admin/consumers` | `ca:admin` | 소비자 등록(UI) — 키 서버 생성·1회 반환. 민감 스코프 부여 차단(서비스 검증). |
| PATCH | `/v1/admin/consumers/{name}` | `ca:admin` | 소비자 수정(UI) — 스코프 편집·상태(일시중지/재개). 동적 소비자만. |
| POST | `/v1/admin/consumers/{name}/commit` | `ca:admin` | 회전 완료 — 지정 키만 남기고 구키 폐기 |
| POST | `/v1/admin/consumers/{name}/rotate` | `ca:admin` | 신규 키 추가(grace) — 구키와 신규키 모두 허용되는 윈도우 시작 |
| GET | `/v1/admin/consumers/assignable-scopes` | `ca:admin` | UI 부여 가능 스코프 목록(민감 스코프 제외). |
| GET | `/v1/admin/settings` | `settings:write` | 연동 설정 전체 조회(본인인증·발송·키수탁 provider) — 비밀값 제외. |
| GET | `/v1/admin/settings/{type}` | `settings:write` | 연동 설정 단건 조회(type=idv\|notifier\|hsm). |
| PUT | `/v1/admin/settings/{type}` | `settings:write` | 연동 설정 변경 — 변경 전후를 감사에 봉인한다. 적용 시점은 설정 유형별로 다르다(HSM 은 cutover). |
| GET | `/v1/admin/settings/{type}/audit` | `settings:write` | 연동 설정 변경 이력. |
| GET | `/v1/admin/users` | `users:admin` | 콘솔 관리자 계정 목록(RBAC) — 역할·활성 여부. 비밀번호 해시는 반환하지 않는다. |
| POST | `/v1/admin/users` | `users:admin` | 콘솔 관리자 계정 생성 — 역할(admin·operator·viewer)로 스코프가 결정된다. |
| PATCH | `/v1/admin/users/{username}` | `users:admin` | 콘솔 관리자 계정 수정(역할·활성 여부). |
| POST | `/v1/admin/users/{username}/reset-password` | `users:admin` | 콘솔 관리자 비밀번호 초기화 — 관리자 감사(`admin:users`)에 봉인. |
| POST | `/v1/auth/2fa/disable` | 콘솔 세션 | 2차 인증 해제(세션) — 본인확인(현재 코드) 후 해제. |
| POST | `/v1/auth/2fa/enable` | 콘솔 세션 | 2차 인증 활성화(세션) — 코드 확인 → 복구코드 발급(평문 1회). |
| POST | `/v1/auth/2fa/setup` | 콘솔 세션 | 2차 인증 등록 시작(세션) — 시크릿·등록 URI(QR) 반환. |
| GET | `/v1/auth/2fa/status` | 콘솔 세션 | 2차 인증 상태(세션) |
| POST | `/v1/auth/2fa/verify` | 콘솔 세션 | 2차 인증 검증 — 챌린지 토큰 + 인증코드(TOTP 또는 복구코드) → 세션 발급. |
| POST | `/v1/auth/email` | 콘솔 세션 | 본인 알림 이메일 설정/변경(세션 필요) — 계약 내부 서명자 알림 수신용. 빈 값=제거. |
| GET | `/v1/auth/idle-timeout` | 콘솔 세션 | 비활동 자동 로그아웃 설정 조회(세션) — 현재값·선호·정책 상한. |
| POST | `/v1/auth/idle-timeout` | 콘솔 세션 | 비활동 자동 로그아웃 설정(세션) — minutes(>0) 저장(정책 캡으로 클램프), null=해제(정책 복귀). 즉시 반영. |
| POST | `/v1/auth/login` | 콘솔 세션 | 로그인 — 1차(ID/PW) 검증. 2FA 활성 계정은 챌린지 반환(세션 미발급), 아니면 세션 발급. |
| POST | `/v1/auth/logout` | 콘솔 세션 | 로그아웃 — 서버측 세션을 즉시 폐기(절대 만료 전이라도 무효). 감사 봉인. |
| GET | `/v1/auth/me` | 콘솔 세션 | 현재 주체 정보 — 세션(사람) 또는 기계 키. 콘솔 부팅 시 역할·스코프 확인용. |
| POST | `/v1/auth/password` | 콘솔 세션 | 본인 비밀번호 변경(세션 필요) — 변경 시 본인 전체 세션 폐기(강제 재로그인). |

### CA 운영(콘솔) (3)

CA 키 회전 등 트러스트 앵커 운영 — **콘솔 전용**.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/v1/ca/audit` | 콘솔 세션 | CA 관리 감사 이벤트 — CA_ROTATED(행위자·시각). 책임추적. 읽기 전용(유효 키) |
| GET | `/v1/ca/history` | 콘솔 세션 | CA 회전 이력 — 구 Issuing 포함(검증·감사용). 읽기는 유효 키면 허용(콘솔 조회), 회전(쓰기)만 ca:admin |
| POST | `/v1/ca/rotate-issuing` | `ca:admin` | Issuing CA 키 회전 — 새 발급 CA 로 교체. 기존 인증서는 그대로 유효하며 신규 발급분만 새 CA 로 서명된다. |

### 운영 상태 (5)

readiness·운영 지표·실시간 이벤트 스트림.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/health/ready` | 무인증 | readiness — DB·CA 준비 여부 (k8s readinessProbe / 모니터링) |
| GET | `/v1/admin/metrics` | `requests:write` | 운영 추세(차트) — 상태 분포·일자별 요청·Webhook 성공률. days(최근 N일, 기본 30, max 365). |
| GET | `/v1/admin/ops-status` | `requests:write` | 운영 상태 — Webhook 적체·요청 분포·CA (관리자 콘솔·모니터링) |
| POST | `/v1/csp-report` | 무인증 | CSP 위반 리포트 수신 — 브라우저 report-uri 전송용. 본문을 로그로만 남기고 204(무저장). |
| GET | `/v1/events/stream` | `requests:write` | 실시간 이벤트 스트림(SSE) — 콘솔 화면 갱신용. 연동 통지는 webhook 을 쓴다. |
<!-- AUTO:endpoints:end -->

---

## 6. 연동 대상이 아닌 것

아래는 **콘솔(사람) 전용**이다. 기계키로 호출하도록 설계하지 말 것 — 스코프 화이트리스트에서 이미 차단돼 있고, 정책상으로도 연동 계약의 일부가 아니다.

- `테넌트 운영(콘솔)` 그룹 — 관리자 계정·로그인/2FA·연동 설정·소비자 발급
- `CA 운영(콘솔)` 그룹 — CA 키 회전·이력
- 관리자 감사 조회(`/v1/admin/audit`) — `users:admin`

피처플래그로 꺼진 기능은 **404** 를 돌려준다. 활성 여부를 먼저 확인한다.

| 플래그 | 기능 | 기본 |
|---|---|---|
| `GENERAL_CONTRACTS` | 일반 전자계약 트랙(`/v1/contracts/**`) | OFF |
| `ELECTRONIC_APPROVAL` | 전자결재(`/v1/approvals/**`) | OFF |
| `PORTAL_DOC_PREVIEW` | 포털 문서 미리보기(문서 업로드/열람) | OFF |

---

## 7. 버전·호환 정책

- **호환 변경**(사전 통보 없이 배포될 수 있음): 응답 필드 추가, 새 엔드포인트, 새 이벤트 타입, 오류 메시지 문구.
  → 수신 측은 **모르는 필드를 무시**하고, 모르는 `eventType` 은 조용히 넘기도록 구현한다.
- **비호환 변경**(사전 합의 후 `/v2` 또는 유예기간): 필드 제거·의미 변경, 필수 파라미터 추가, 인증 방식 변경.
- 릴리즈마다 `CHANGELOG.md` 와 `docs/openapi.json` 이 함께 갱신된다. 연동 측은 스펙 diff 로 회귀를 잡는 것을 권장한다.

---

## 8. 문서 갱신 절차 (운영자용)

```bash
npm run swagger:export   # 코드 → docs/openapi.json
npm run api:catalog      # openapi.json → 이 문서의 §5 표
```
§5 는 자동 생성 구간이므로 직접 고치지 않는다. 엔드포인트 설명을 바꾸려면 **컨트롤러 핸들러의 JSDoc** 을 고친다(스펙 `description` 의 출처).
필요 스코프는 `@RequireScope` 가, 토큰·공개 여부는 `TokenAuth`/`PublicApi`/`SessionAuth`/`StaffSsoAuth`/`ProdApiKeyAuth` 표시가 그대로 스펙에 반영된다.
