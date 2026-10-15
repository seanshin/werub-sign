# sign — 의료/IT 전자서명 트러스트 서비스 (v1.30.1)

> 🟢 **운영 라이브**: <https://sign.example.org> (TLS) · 내부 `http://127.0.0.1:4100/v1`
> 🔗 HIS·PACS·ERP·edu·weRub **연동 가동 중** — sign 단독 발급(HSM-앵커 CA), 양방향 e2e 검증 완료.

**sign** 은 병원 정보시스템(Hospital RUN)·영상시스템(OpenPACS)·그룹웨어 등과 API·Webhook·SSO 로 연동되는
**독립 전자서명 서비스**입니다. 전자동의서·판독보고서 같은 의료 문서와 일반 전자계약에 대해
**"이 문서에 이 사람이 이 시점에 서명했고, 그 뒤로 한 글자도 바뀌지 않았다"** 를 법적으로 증명합니다.

증명 수단은 자체 PKI(2단 CA) + RFC3161 타임스탬프 + PAdES-LTA + CMS(CAdES) + 감사 해시체인입니다.
아래에서 각각이 무엇을 막아 주는지 차례로 설명합니다.

---

## 목차

1. [왜 필요한가 — mock 서명과 무엇이 다른가](#1-왜-필요한가--mock-서명과-무엇이-다른가)
2. [핵심 개념 미리 알기](#2-핵심-개념-미리-알기)
3. [시스템 구성](#3-시스템-구성)
4. [기능 현황](#4-기능-현황)
5. [빠르게 시작하기 (개발)](#5-빠르게-시작하기-개발)
6. [API 사용법](#6-api-사용법)
7. [연동 시 반드시 확인할 것](#7-연동-시-반드시-확인할-것)
8. [운영 배포](#8-운영-배포)
9. [테스트](#9-테스트)
10. [문서 지도](#10-문서-지도)
11. [보안 원칙](#11-보안-원칙)

---

## 1. 왜 필요한가 — mock 서명과 무엇이 다른가

많은 시스템의 "전자서명"은 사실 **서명값의 해시를 다시 해시한 것**입니다.
검증이 `sha256(signatureValue)` 라면, 서명값을 통째로 바꿔치기해도 검증은 통과합니다. 증명력이 없습니다.

sign 은 다음을 실제로 수행합니다.

| 위협 | mock 서명 | sign |
|---|---|---|
| 서명값 위조 | 막지 못함(해시의 해시) | **공개키 `crypto.verify` 로 실제 서명 검증** |
| 문서 내용 변조 | 탐지 못 함 | 문서 해시가 서명 대상에 포함 — 1바이트만 바뀌어도 검증 실패 |
| "그때는 유효했나" | 알 수 없음 | **RFC3161 TSA 타임스탬프** + 서명 시점 폐기(CRL/OCSP) 확인 |
| 인증서 만료 후 검증 | 불가 | **PAdES-LTA**(LTV) — 검증 자료를 PDF 안에 봉인해 장기 검증 |
| 내부자가 이력 통째 재계산 | 탐지 못 함 | 감사 **해시체인** + 주기적 **TSA 앵커** |
| **운영자(서버 장악자) 자신의 위변조** | 불가능 개념 없음 | **외부 RFC3161 TSA 교차 앵커**(v1.27) — 운영자도 위조할 수 없는 제3자 토큰을 병기, `openssl` 로 독립 검증 |
| 서명자가 본인이 맞나 | 시스템 주장뿐 | 본인확인(PASS/앱 step-up/대면/의료진 SSO)을 **서명에 강결합** |

> **발급 권위는 sign 단독입니다.** HIS·PACS 등 연동 시스템은 개인키를 갖지 않습니다.
> sign 이 발급한 인증서와 해시체인 무결성만으로 동작하므로, 연동 시스템이 뚫려도 서명을 위조할 수 없습니다.

---

## 2. 핵심 개념 미리 알기

처음 보는 분이 문서를 읽다 막히는 지점을 먼저 풀어 둡니다.

**서명요청(request)** — "누가 무엇에 서명해야 하는가"를 담은 봉투입니다. 문서 해시, 서명자 목록,
기한, 서명 순서를 갖습니다. 서명자가 여럿이면 **다자 봉투**이고 순차·동시 진행을 고를 수 있습니다.

**서명 모델 A / B** — 서명자가 sign 에 도달하는 경로입니다.
- **모델 A(직접 제출)**: 연동 시스템이 서명값을 만들어 API 로 제출합니다. 환자 앱 등.
- **모델 B(포털 토큰)**: sign 이 1회용 링크를 발급하고, 서명자가 브라우저에서 직접 서명합니다.
  외부 상대방(사번·계정이 없는 사람)에게 씁니다.

**의료진 SSO 서명** — HIS 가 발급한 `staff-token`(aud=`sign`)을 제시하면, sign 이 JWKS 로 검증하고
토큰의 `sub` 와 서명자를 **바인딩**합니다. 남의 명의로 서명할 수 없습니다.

**감사 해시체인** — 모든 행위(생성·발송·열람·서명·폐기…)를 append-only 로 쌓되, 각 항목이
직전 항목의 해시를 품습니다. 중간을 고치면 그 뒤가 전부 깨집니다. 주기적으로 체인의 머리(head)를
**TSA 로 앵커링**하므로, 내부자가 체인 전체를 재계산해도 앵커 시점과 어긋나 탐지됩니다.

**앵커 이중화**(v1.27) — 자체 TSA 의 서명키는 결국 sign 운영자 수중이므로, 자체 앵커만으로는
"운영자 자신"까지는 못 막습니다. 그래서 앵커마다 **외부 RFC3161 TSA 토큰을 함께** 받아 둡니다.
외부 토큰은 운영자가 위조할 수 없고, 제3자가 `openssl ts -verify` 만으로 sign 과 무관하게
"이 시각에 이 체인 head 가 존재했다"를 검증합니다. 외부 TSA 가 죽어 있어도 서명 완료는 막히지
않으며(best-effort), 못 받은 토큰은 주기 스윕이 보충합니다.

**attestation(키 수탁 증명)** — 이 인증서의 개인키가 **소프트웨어에 있었는지 HSM 에 있었는지**를
발급·검증 응답에 함께 실어 보냅니다(`assuranceLevel`: `SOFTWARE` ↔ `HSM_ANCHORED`).
검증하는 쪽이 신뢰 수준을 스스로 판단할 수 있게 하기 위함입니다.

**교부(delivery)** — 체결이 끝난 계약을 상대방에게 전달하는 **만료형 다운로드 링크**입니다.
수신자가 기한을 1회 연장하거나 지정 이메일로 전달할 수 있고, 그 행위도 전부 감사에 남습니다.

**소비자(consumer) / 기계 키** — HIS·PACS·ERP 같은 **시스템 대 시스템** 호출자입니다.
콘솔에서 발급하며 스코프(권한)를 개별 부여합니다. 사람 계정(콘솔 로그인)과는 별개 축입니다.

---

## 3. 시스템 구성

### 4계층 (포트/어댑터)

```
presentation   컨트롤러·가드·인터셉터·에러필터 (REST)
  ↓
application    유스케이스 (서명요청·서명·검증·폐기·발송·facade·계약·ops)
  ↓
domain         순수 타입 + 포트 (KeySigner·TsaProvider·IdentityProvider·Notifier·SignStore)
  ↑
infrastructure 어댑터 (SOFT/HSM · 2단 CA · TSA · 감사체인 · SSO · Webhook · 저장소 · 보안)

web/           프론트 SPA (Next.js) — 환자 포털 + 관리자 콘솔
```

**핵심 규칙**: `application` 은 포트(인터페이스)에만 의존합니다. 구체 저장소·HSM·벤더를 직접 부르지 않습니다.
덕분에 아래 축을 코드 변경 없이 갈아끼울 수 있습니다.

| 교체축 | 현재 | 교체 대상 |
|---|---|---|
| 키 수탁 | SOFT(파일 볼트 암호화) | **AWS KMS · 온프레 PKCS#11(HSM)** |
| 타임스탬프(서명) | 자체 TSA | 공인 TSA |
| **감사 앵커(외부)** | 공개 TSA(freeTSA) 교차 앵커 | 공인 TSA — `ANCHOR_TSA_URLS` 만 교체 |
| 본인확인 | mock | **PASS · 명의인증** |
| 저장소 | Prisma/PostgreSQL | InMemory · File (개발용) |
| 알림 | mock | 알림톡 · SMS |

### 개인키를 어떻게 다루는가

개인키는 **crypto-proxy 로 분리**되어 앱 프로세스는 키도, HSM SDK 도 갖지 않습니다.
HSM 은 **sign 만** 연동하며, 범위를 **CA 앵커 2키(Root·Issuing)로 최소화**했습니다.
말단(환자·의료진 서명)키와 TSA 키는 SOFT 라 **서명 건당 HSM 비용이 0** 입니다 — 보안 등급을 지키면서 비용을 억제하는 설계입니다.

### 저장소

운영은 PostgreSQL(Prisma)입니다. 런타임 데이터는 `store_records` 테이블에 lossless JSON 으로
즉시 영속되고, 관계형 모델은 분석·인증심사 조회용입니다. 마이그레이션은 `prisma/migrations/` 에 9개.

**동시성**(v1.26): 배열형 메타 슬롯은 **버전 일치 CAS**로, 감사 체인은 **유니크 인덱스**로 보호합니다.
프로세스가 여럿이어도(수평 확장·롤링 배포) lost update 와 체인 분기가 발생하지 않습니다.

---

## 4. 기능 현황

Increment 1~22 전부 e2e 검증되었고 운영 라이브입니다.

### 4.1 서명·PKI 코어
- **PKI/서명**: 2단 CA · 실 X.509 · CMS(CAdES-BES) · PAdES-LTA(LTV) · RFC3161 TSA · CA/TSA 키 영속·회전·이력
- **검증/폐기**: 공개키 검증 · CRL/OCSP · **서명 시점** 폐기 확인 · 감사 해시체인 + TSA 앵커(**자체+외부 이중**, v1.27 — 검증 응답의 `externalAnchors[]`)
- **HSM 키 수탁**: AWS KMS(`AwsKmsKeySigner`) · 온프레 PKCS#11(`Pkcs11KeySigner`, SoftHSM2 e2e) — 비추출, CA 앵커만
- **attestation**: enroll·webhook·verify 응답에 `keyCustody`·`caKeyCustody`·`caKeyCustodyProvider`·`assuranceLevel`
- **본인확인**: IdentityProvider 분리(idv-proxy), 위험도별(PASS·APP_STEPUP·INPERSON·STAFF_SSO), 서명과 강결합
- **채널**: 환자 앱(모델 A) · 포털 토큰(모델 B) · 의료진 SSO(`staff-token` aud=sign, `sub` 바인딩) · **대리(PROXY) 서명**

### 4.2 연동
- **HIS/PACS facade** `/v1/sign-requests` — 단일 호출로 발급 + 요청 생성
- **Webhook**: `eventId` 멱등 · HMAC 서명 · 재시도(최대 8회) · 소비자별 시크릿 격리
- **중간 서명 웹훅** `request.signer_completed` — 다자 서명 진행 상황과 다음 차례 통지
- **DEAD 재발송/폐기**: 수신 경로가 바뀌었으면 재지정 후 재발송, 수신처가 폐지됐으면 사유를 남기고 폐기
- **의료진 행위 인증 로그** `/v1/audit-events` — 처방·판독승인 등을 해시체인+TSA 로 봉인, SSO 본인인증과 결합

### 4.3 일반 전자계약 트랙 (`GENERAL_CONTRACTS`)
준비 → 발송 → 체결 → 관리의 전 과정을 다룹니다.

- **준비**: PDF 업로드 또는 서식으로 작성. **내장 서식 36종**(근로·용역·임대차·구매·보안·협약 + 의료특화 10 + 보건행정 10) + 기관 커스텀 등록
- **서식 편집기**: 내장 서식 **직접 편집**(오버라이드 · 기본값 복원) · 버전 이력 20건 · 리치 에디터(TipTap) · PDF 배치 편집기(서명란·입력란 드래그) · 한글 PDF 조판(나눔고딕 임베드)
- **표 조판**: 열 폭 비율 · **셀 병합**(colspan·rowspan) · 셀 단위 음영 · **페이지 넘김 시 헤더 행 반복** · 미지원 글리프 대체 보고
- **발송**: SMTP · **접근암호**(scrypt · IP 레이트리밋 · 5회 오류 시 계약 단위 10분 잠금)
- **체결**: 내부 콘솔 서명 + 외부 포털 서명, 순차/동시 선택. 손글씨 서명(암호화 보관 후 서명란 합성)
- **fill-at-signing**: 서명자가 포털에서 **직접 기재**(입력 타입 검증·박스 맞춤·기재값 증적). 기재값은 봉인되고 표시용으로만 합성되어 **원본 해시는 불변**
- **첨부 문서**: 열람용 부속 문서(견적서·사업자등록증 등). SHA-256 감사 봉인, 발송 후 불변
- **관리**: 계약함 · 현황 · 이력 · 카테고리 · 보관 · 자동 리마인더 · 완료 교부 · 주소록 · 프리셋
- **공개 진위 확인**: 완료 문서 QR 로 누구나 진위를 확인(기재값이 봉인된 계약은 문서 열람 차단, 요약만 공개)

### 4.4 콘솔·운영
- **콘솔**: 대시보드 · 인증서 발급/목록/관리 · 폐기·OCSP · STAFF SSO · 시스템 상태 · 문서·발급 로그 · 인증 행위 로그 · 감사/로그 · **2FA(TOTP)** · 사용자 관리(RBAC) · 자동 로그아웃 설정
- **문서 인증 목록**: 외부 시스템(weRB 등)이 `/v1/audit-events` 로 봉인한 문서 어테스테이션 통합 조회
- **운영/보안**: 발송·철회·만료 · **API 키 무중단 회전**(영속) · 접근로그(actor) · 관리 행위자 감사 · 하드닝(prod-gated) · SSRF 방어 · 테넌트 격리 · canonical-json
- **확장성·동시성**(v1.26): 첨부 **청크 스트리밍**(피크 힙이 파일 크기가 아니라 청크 하나 — 청크별 해시를 방출 전 검증) · 메타 슬롯 **CAS** + 감사 체인 **유니크 제약**
- **감사 앵커 이중화**(v1.27, 보안 트랙 S1): 자체 TSA 에 더해 **외부 RFC3161 TSA 토큰을 앵커에 병기**(`ANCHOR_TSA_URLS`) — 자체 TSA 키는 운영자 수중이라 외부 토큰이 있어야 **운영자조차 위조할 수 없는** 제3자 증거가 됩니다(`openssl ts -verify` 로 독립 검증, 운영 가이드 §1.3.1). 외부 발급은 best-effort(장애 시 서명 완료 비차단), **주기 앵커 스윕**이 실패분과 관리 스트림(`admin:auth` 등)을 보충합니다

### 4.5 피처 플래그

기본 OFF 이며, 켜지 않으면 해당 엔드포인트가 404 이고 콘솔 메뉴도 숨겨집니다.

| 플래그 | 기능 | 비고 |
|---|---|---|
| `GENERAL_CONTRACTS` | 일반 전자계약 트랙 | 라이브 **ON** |
| `ELECTRONIC_APPROVAL` | 전자결재(상신→결재) | 콘솔 메뉴 숨김·코드 보존. 실서비스 결재는 weRB 문서인증이 담당 |
| `PORTAL_DOC_PREVIEW` | 포털 PDF 미리보기 | 보안검토 sign-off 대기 |
| `SECURITY_HARDENING` | go-live 하드닝(H3/H4/M1/M2) | 운영에서 ON |
| `CONTRACT_ATTACH_RETAIN_DAYS` | 첨부 보존연한 파기 | 미설정 = 영구 보관(기본) |

---

## 5. 빠르게 시작하기 (개발)

```bash
# 1) 의존성 + Prisma 클라이언트
npm install && npm run prisma:generate

# 2) 환경변수 — 마스터키는 반드시 생성해서 넣습니다
cp .env.example .env.local
#   CRYPTO_MASTER_KEY=$(openssl rand -base64 32)
#   CRYPTO_PEPPER=$(openssl rand -base64 32)

# 3) 백엔드 (:4000)
npm run start:dev

# 4) 프론트 (:3000) — 별도 터미널
cd web && npm i
NEXT_PUBLIC_SIGN_API_URL=http://localhost:4000 npm run dev

# 5) (선택) 개발 시드 — 상태별 더미 데이터. 운영에서는 차단됩니다
SEED_API_KEY=<key> npm run seed:dev
```

**저장소 선택**: `STORE_DRIVER` 미설정이면 인메모리(재기동 시 소실), `file` 이면 파일 영속,
`prisma` 면 PostgreSQL(운영). PostgreSQL 로 붙이려면 `npm run db:up` 후 `DB_URL` 을 지정하세요.

---

## 6. API 사용법

전체 명세는 `docs/openapi.json`(**140 경로 · 158 오퍼레이션**)입니다.

> 💡 **연동을 시작한다면 [`docs/05-handoff/api-catalog.md`](docs/05-handoff/api-catalog.md) 부터 보세요.**
> 인증 4경로 · 스코프 부여 기준 · 오류 코드 · 멱등 규약 · webhook 계약 · **연동 대상이 아닌 것**까지
> 한 문서에 정리돼 있고, 엔드포인트 표는 스펙에서 자동 생성됩니다(`npm run api:catalog`).

### 6.1 인증 4경로

| 방식 | 헤더 | 쓰는 곳 |
|---|---|---|
| **기계 키** | `x-api-key: <key>` | HIS·PACS·ERP 등 시스템 대 시스템 |
| **의료진 SSO** | `Authorization: Bearer <staff-token>` (aud=`sign`) | 의료진 본인 서명 |
| **포털·교부 토큰** | URL 경로에 포함 | 외부 서명자·수신자(로그인 없음) |
| **콘솔 세션** | `x-session-token` | 관리자 콘솔 |

응답 규약은 성공 `{ data }`, 실패 `{ error: { code, message, requestId } }` 입니다.
스펙에는 엔드포인트별 **필요 스코프**(`x-required-scope`)와 **인증 방식**(`x-auth`)이 표기됩니다.

### 6.2 권한(스코프)과 역할

| 역할 | 부여 스코프 |
|---|---|
| `admin` | `requests:write` `certificates:write` `settings:write` `ca:admin` `users:admin` `documents:read` `approval:write` `approval:act` `contracts:read` `contracts:write` `contracts:templates` |
| `operator` | `requests:write` `certificates:write` `documents:read` `approval:write` `approval:act` `contracts:read` `contracts:write` |
| `viewer` | 변경 스코프 없음 — 운영 데이터 GET 만 |

`ca:admin` 과 `users:admin` 은 **민감 스코프**라 기계 키에 부여할 수 없습니다.
`contracts:templates` 도 admin 전용입니다(서식 본문이 이후 모든 계약 문안을 좌우하기 때문).

### 6.3 주요 엔드포인트

| 메서드 | 경로 | 인증 | 용도 |
|---|---|---|---|
| POST | `/sign-requests` | x-api-key | **HIS/PACS facade** — 단일 호출로 발급+요청(+포털 URL, callbackUrl) |
| POST | `/certificates/enroll` · `/:serial/revoke` | x-api-key | 인증서 발급(PATIENT/STAFF)·폐기 |
| POST | `/requests` · `/sign/:pid/submit` | x-api-key | 서명요청 · 직접 제출(모델 A) |
| POST | `/sign/staff` | SSO Bearer | 의료진 서명 |
| POST | `/requests/:id/portal-tokens` · `/portal/:token/sign` | x-api-key / 토큰 | 포털 서명(모델 B) |
| GET | `/verify/:id` · `/requests/:id/audit-certificate` | 공개 | 검증(+attestation) · 감사추적 PDF |
| GET | `/certificates` · POST `/:serial/{suspend,resume}` | x-api-key | 인증서 목록 · 중단/재개 |
| POST | `/audit-events` · GET `?stream=`·`/streams`·`/verify` | x-api-key(+SSO) | **의료진 행위 인증 로그 · 문서 어테스테이션** |
| GET | `/admin/wsign-documents` · `/detail` · `/export.csv` | requests:write | 문서 인증 목록(통합·상세·무결성) |
| POST | `/approvals` · `/:id/act` · `/:id/act-staff` · GET `/:id/authlog` | approval:write·act / SSO | 전자결재(플래그 `ELECTRONIC_APPROVAL`) |
| GET | `/requests/:id/audit` · `/audit/verify` | x-api-key | 감사 이력 · 체인 검증 |
| POST | `/contracts` · PUT `/:id/document` · POST `/:id/{send,remind,sign,deliver,archive}` | contracts:write | **일반 전자계약** 전 과정 |
| GET | `/contracts/:id/status` | contracts:write | **경량 상태 조회**(개인정보 없음 — 웹훅 유실 시 정합 복구) |
| PATCH/POST | `/contracts/:id/participants/:pid/email` · `/:id/withdraw` | contracts:write | 수신처 정정(기존 링크 즉시 무효화) · 철회 |
| GET | `/contracts/:id/fill-values` | **contracts:write** | 기재값 증적(원문·봉인 해시·무결성) |
| POST | `/contracts/delivery/:token/{extend,forward}` | 공개(교부 토큰) | 교부 링크 기한 연장 · 지정 이메일 전달 |
| GET/POST | `/contracts/templates` · `/:tid/{reset,history,restore,duplicate}` | **contracts:templates** | 계약 서식 편집(admin 전용) |
| POST | `/contracts/compose` · `/stamp` | contracts:write | 한글 PDF 조판 · 마크 스탬프 |
| POST/GET | `/maintenance/webhook-{retry,redrive,dead,discard}` | requests:write | Webhook 재시도·재발송·적체 조회·폐기 |
| POST | `/portal/:token/unlock` | 공개(토큰) | 계약 접근암호 확인(5회 오류 시 10분 잠금) |
| GET | `/contracts/verify/:token` · `/document` · `/delivery/:token` | 공개 | QR 진위 확인 · 만료형 교부 다운로드 |
| POST | `/ca/rotate-issuing` · GET `/ca/history` · `/ca/audit` | ca:admin | CA 회전·이력·행위자 감사 |
| POST/PATCH | `/admin/consumers` · `/:name/{rotate,commit}` | ca:admin | 소비자 등록·스코프·**무중단 키 회전** |
| GET | `/admin/ops-status` · `/health/ready` | x-api-key / 공개 | 운영 상태 · readiness |
| GET | `/ocsp/:serial` · `/crl` | 공개 | 폐기 조회 |

---

## 7. 연동 시 반드시 확인할 것

### ⚠ 2026-07-28 스코프 변경 — 모르고 호출하면 **403** 입니다

| 대상 | 변경 | 이유 |
|---|---|---|
| `POST/PATCH/DELETE /contracts/templates…` | `contracts:write` → **`contracts:templates`** (admin 전용, 기계 키 부여 불가) | 서식 본문이 이후 모든 계약 문안을 좌우하므로 분리 |
| `GET /contracts/:id/fill-values` | `contracts:read` → **`contracts:write`** | 계좌번호 등 구조화 PII — 계약 이력 열람과 동일 등급 |

> **서식으로 계약을 작성하는 것은 종전대로** `contracts:write` 입니다. 변경된 것은 **서식 자체의 편집**뿐입니다.

### ⚠ 완료 웹훅의 상관키는 `externalDocId` 를 권장합니다

sign 은 `submit` 처리 **도중에** 완료 통지를 발화합니다. 따라서 동기 발급 흐름에서는
**호출자가 `requestId` 를 저장하기 전에 통지가 먼저 도착할 수 있습니다.**
`requestId` 로 매칭하면 "모르는 요청"으로 버려지므로, 호출자가 정한 `externalDocId` 를 상관키로 쓰세요.
(자세히: `docs/05-handoff/his-integration-guide.md` §5)

### 웹훅 수신 측 체크리스트
- **2xx 를 반환**해야 성공으로 판정합니다. 그 외 응답·타임아웃은 재시도(최대 8회) 후 DEAD 입니다.
- `eventId` 로 **멱등 처리**하세요(재시도 시 같은 `eventId` 가 옵니다).
- HMAC 서명을 검증하세요. 시크릿은 **소비자별로 격리**됩니다.
- 수신 경로를 바꿨다면 알려 주세요 — DEAD 적체를 새 경로로 **재발송**할 수 있습니다.

---

## 8. 운영 배포

```bash
cp .env.prod.example .env.prod        # 시크릿 생성·주입
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

- 구성: `sign-core`(4100) + `sign-web`(3050) + `sign-postgres`. nginx(TLS)는 `deploy/nginx` 참조.
- **`--env-file .env.prod` 를 빠뜨리면 변수 보간 오류**가 납니다(`docker compose ps` 에도 필요).
- 컨테이너 기동 시 `prisma migrate deploy` 가 자동 실행됩니다(`STORE_DRIVER=prisma` 일 때만).
- 전면 교체(개발·시드 초기화): `CONFIRM=RESET bash scripts/clean-reset.sh` — CA·DB·키를 재기준화합니다.

### 감사 앵커 외부 TSA (v1.27, 권장)

```bash
# .env.prod 에 추가 — 외부 RFC3161 TSA(쉼표 구분 복수 가능). 미설정 시 자체 앵커만(종전 동작).
ANCHOR_TSA_URLS=https://freetsa.org/tsr
SCHEDULER_ANCHOR_MIN=1440   # 앵커 스윕 주기(분) — 미앵커 스트림·외부 실패분 보충
```

- 자체 TSA 키는 운영자 수중이라 **외부 토큰이 있어야 운영자 독립 증거**가 됩니다.
- 외부 TSA 장애는 서명 완료를 막지 않고(best-effort), 스윕이 나중에 보충합니다.
- 공인 TSA 계약 시 URL 만 교체하면 됩니다(코드 무변경).
- 제3자 검증 절차(`openssl ts -verify` — 실측 OK): `docs/06-ops/operations-guide.md` §1.3.1.

### 마이그레이션 주의 — 0009 (동시성 가드)

`0009` 는 유니크 인덱스 2종을 만듭니다. 그중 감사 체인 인덱스는 **기존에 체인 분기가 있으면
마이그레이션이 의도적으로 실패**합니다(끊긴 체인 위에 "무결" 제약을 얹어 오인시키지 않기 위함).
**배포 전에** 아래 읽기 전용 점검을 실행하세요.

```sql
-- ① 감사 체인 분기 — 0행이어야 정상. 행이 나오면 해당 스트림을 먼저 조사할 것
SELECT rkey, count(*) FROM store_records
 WHERE kind='audit' GROUP BY rkey, (data->>'prevHash') HAVING count(*) > 1;

-- ② meta 중복 슬롯 — 있어도 마이그레이션이 최신 행만 남기고 자동 정리(조치 불요)
SELECT kind, rkey, count(*) FROM store_records
 WHERE kind='meta' GROUP BY kind, rkey HAVING count(*) > 1;
```

행 수가 수백만 규모인 설치는 인덱스를 `CONCURRENTLY` 로 **먼저 수동 생성**한 뒤 배포하세요
(Prisma 는 마이그레이션을 트랜잭션으로 감싸 `CONCURRENTLY` 를 쓸 수 없습니다).
자세한 절차: `docs/06-ops/operations-guide.md` §1.2.

---

## 9. 테스트

```bash
node scripts/pki-proof.mjs      # PKI 코어 증명 (외부 의존성 0)
node scripts/pades-proof.mjs    # 표준 PAdES PDF + 실 RFC3161 타임스탬프

npm run e2e                     # 백엔드 e2e 전체 (increment3~22 + 계약 + 동시성 + 앵커 이중화 + 스펙 회귀)
npm run e2e:ui                  # Playwright UI E2E 69개 (+ axe 접근성)
npm run e2e:all                 # 게이트 — 위 전부 + prisma 계약 검증

npm run e2e:external            # EXTERNAL 계약 셀프검증(골든 레퍼런스)
npm run e2e:hsm                 # 온프레 HSM(PKCS#11/SoftHSM2)
npm run e2e:prisma              # 라이브 PostgreSQL 영속 (npm run db:up 후)
npm run contract:prisma         # 저장소 어댑터 계약 검증(시뮬 PG)
```

> ⚠ **게이트는 단독으로 실행하세요.** 다른 e2e 와 동시에 돌리면 테스트 서버가 포트를 다투어
> `fetch failed` 나 404 가 납니다. 중단된 실행이 남아 있으면 `ps aux | grep dist/main.js` 로 정리하세요.

CI(GitHub Actions)는 push·PR 마다 `e2e:all` 게이트와 **PostgreSQL 잡**(마이그레이션 실적용 + 푸시다운 검증)을 돌립니다.

---

## 10. 문서 지도

| 무엇을 하려는가 | 문서 |
|---|---|
| **API 연동을 시작한다** | [`docs/05-handoff/api-catalog.md`](docs/05-handoff/api-catalog.md) ⭐ |
| 서명·연동 흐름 전체를 이해한다 | [`docs/02-design/signing-flows.md`](docs/02-design/signing-flows.md) ⭐ |
| 전체 문서 목록을 본다 | [`docs/README.md`](docs/README.md) |
| 남은 개발 항목을 본다 | [`docs/01-plan/backlog-roadmap.md`](docs/01-plan/backlog-roadmap.md) |
| 배포·키 수탁·하드닝 상세 | [`docs/06-ops/operations-guide.md`](docs/06-ops/operations-guide.md) |
| 변경 이력 | [`CHANGELOG.md`](CHANGELOG.md) |

**설계 기준 문서** — 왜 이렇게 만들었는지가 궁금할 때:
`hsm-single-custody-architecture.md`(HSM 단독 수탁·블록체인 무결성) ·
`certificate-issuance-authority.md`(발급 주체) · `his-issuance-delegation.md`(발급 일원화)

**연동별 문서**:
- HIS — `sign-to-his-external-e2e-answers.md` · `his-delivery-summary.md` · `integration-decisions.md`
- PACS — `pacs-auth-handoff.md` · `sign-to-pacs-attestation-answers.md` · `sign-to-pacs-answers.md`(curl)
- ERP — `erp-track-a-handoff.md` · 환자앱 — `patient-app-fr14-15-handoff.md` · 파일럿 — `p1-pilot-checklist.md`

---

## 11. 보안 원칙

`docs/01-plan/conventions.md` §3 의 요약입니다. 코드 리뷰 시 이 기준으로 봅니다.

1. **개인키를 평문으로 DB·로그·응답에 남기지 않습니다.** 접근은 `KeySigner` 포트(또는 crypto-proxy) 경유만.
2. **식별자(주민등록 CI·전화번호)는 HMAC 해시로 저장**합니다. 원문 보관 금지.
3. **HSM 은 sign 만 연동**합니다. 내부 서비스는 키를 갖지 않습니다.
4. **감사 기록은 append-only** 입니다. UPDATE·DELETE 금지, 기록은 해시체인 단일 경로로만.
5. **하드닝은 운영에서 켭니다** — IP 제한 · mTLS · rate-limit · PII 인증(`SECURITY_HARDENING`, go-live 시 ON).
6. 민간 의료법인은 KCMVP 비강제라 표준 알고리즘을 씁니다. **공공 확장 시 검증필 모듈로 교체**합니다.
7. **증거는 운영자 독립이어야 합니다** — 감사 앵커에 외부 RFC3161 토큰을 병기해(v1.27) 운영자 자신도 되돌릴 수 없게 합니다. "블록체인" 이라는 표현은 쓰지 않습니다 — 실체(해시체인 + TSA 앵커)를 그대로 말합니다.

---

<sub>© (주)위루비 · 문의·연동 요청은 `docs/05-handoff/README.md` 참조</sub>
