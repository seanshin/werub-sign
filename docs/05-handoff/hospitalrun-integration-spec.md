# [HIS팀 전달] Hospital RUN ↔ sign 전자서명 연동 명세서

> **수신**: Hospital RUN(HIS) 개발팀
> **발신**: sign(전자서명 트러스트 서비스) 팀
> **Date**: 2026-06-12 · **버전**: 1.0
> **목적**: 기존 HIS의 mock 전자서명을 독립 서비스 `sign`으로 대체하기 위해 **HIS 측에서 수행해야 할 작업**을 명세

---

## 0. 배경 (요약)

- `sign`은 자체 PKI(2단 CA)+RFC3161 TSA+PAdES-LTA 기반 **독립 전자서명 서비스**. HIS와 **REST API + Webhook + SSO(JWKS)** 로 연동.
- 관계: **Provider(sign) · Consumer(Hospital RUN)**. 독립 배포·독립 DB. sign이 키·서명·검증·증거를 소유, HIS가 동의서 콘텐츠·환자·UI·채널을 소유.
- 기존 HIS의 `blockchain-cert`/`document-sign`은 신뢰요건이 약하나(검증=`sha256(value)`, 실 키쌍/CA/TSA 없음), **HIS 실측 결과 `blockchainSignature`가 pharmacy·lab·prescription·encounter·pathology·discharge-summary·consent·credential-admin·blockchain-anchor·portal 등에 광범위 결선(단독 74참조)**.
- ⚠️ **개정(HIS팀 검토 반영)**: 초기 "clean replacement(전면 삭제)" 전제는 **철회**. 하드 삭제 시 다수 모듈·기존 동의 레코드가 깨짐 + sign측도 운영급(PAdES/RFC3161/Prisma-live/hardening) 미완. → **`sign.mode` 토글(SIMULATION=현 HIS 내부서명 / EXTERNAL=sign 서비스) 기반 점진 전환**. 자세한 전략 §13.

---

## 1. HIS팀 책임 범위 (체크리스트)

- [ ] **(제거)** mock 모듈/모델 삭제 — §2
- [ ] **(스키마)** `ConsentForm` 필드 추가·정리 — §3
- [ ] **(인증서 발급)** 환자·직원 sign 인증서 발급 연동 — §4
- [ ] **(서명요청)** 동의서 생성 시 sign에 서명요청 생성 — §5
- [ ] **(서명 클라이언트)** 환자앱/포털·의료진 포털에서 sign 서명 호출 — §6
- [ ] **(SSO 제공)** 의료진 SSO 토큰 발급 + JWKS 공개 — §7
- [ ] **(Webhook 수신)** 서명완료 콜백 수신·검증·반영 — §8
- [ ] **(설정)** 연동 URL·API Key·시크릿 구성 — §9
- [ ] **(수용기준)** E2E 통과 — §11

---

## 2. 기존 mock 처리 — ⚠️ 하드 삭제 금지, 점진 deprecate (개정)

> HIS팀 실측 반영. **즉시 삭제하지 않는다.** 운영급 전환(sign PAdES/TSA/Prisma-live 완료) 전까지 **작동 중인 HIS 내부 서명을 유지**한다.

| 대상 | 조치 (단계적) |
|---|---|
| 모듈 `blockchain-cert`/`document-sign` | **유지** → EXTERNAL 모드 안정화 후 단계 제거 |
| 모델 `BlockchainCertificate`/`SignedDocument`/`DocumentSignature` | **유지** → 후속 Phase 제거 |
| `ConsentForm.blockchainSignature`(Json, 74참조) | **deprecate(읽기전용)** → 백필 → **후속 제거** (즉시 삭제 금지) |
| 위 모델 참조 모듈(pharmacy·lab·prescription·encounter 등) | 결선 유지, `sign.mode`로 분기 |

> 손글씨 서명 이미지(`patientSignature` 등)는 표시용 유지. EXTERNAL 모드에서 법적 효력 근거는 sign의 PKI 서명으로 일원화.

---

## 3. 스키마 변경 — `ConsentForm`

추가 필드(모두 nullable, additive):

```prisma
model ConsentForm {
  // ... 기존 임상 필드 유지 ...
  signatureRequestId String?  @map("signature_request_id") @db.VarChar(64) // sign의 requestId
  signStatus         String?  @map("sign_status") @db.VarChar(20)          // CREATED/IN_PROGRESS/COMPLETED/REVOKED/FAILED (sign 동기화)
  auditCertUri       String?  @map("audit_cert_uri") @db.VarChar(500)      // 감사추적인증서 경로
  signProvider       String?  @map("sign_provider") @db.VarChar(20) @default("SIMULATION") // SIMULATION | EXTERNAL (§13)
  // ⚠️ 명명: 'signMode'는 HIS 기존 ConsentForm.signMode(서명기기 TABLET/PC/PORTAL/PAPER) 및
  //         sign 서비스 signMode(채널 APP/TABLET/PC/REMOTE)와 충돌 → 토글은 signProvider 사용 (HIS팀 지적 반영)
  // blockchainSignature: 즉시 제거 금지 → deprecate(읽기전용) 유지, 후속 Phase 제거
}
```

> ✅ **이 비파괴 추가(additive)는 안전하므로 선행 가능** (HIS팀 확인). 기존 컬럼/모듈 미변경.

서명자(환자/보호자/의사/간호사/입회인)별 `sign participantId`를 보관할 필드 또는 매핑 테이블 권장:
```prisma
// 예: ConsentForm 참가자 매핑 (또는 기존 participant 구조에 컬럼 추가)
signParticipantId  String? // sign 응답의 participants[].participantId
signCertSerial     String? // 해당 서명자의 sign 인증서 serial
```

환자/직원에 sign 인증서 serial 보관:
```prisma
model Patient { signCertSerial String? @map("sign_cert_serial") @db.VarChar(64) }
model User    { signCertSerial String? @map("sign_cert_serial") @db.VarChar(64) }
```

---

## 4. 인증서 발급 연동 (HIS → sign)

서명 전, 각 서명자는 sign 인증서를 1회 발급받아야 한다. **인증 헤더 `x-api-key` 필수**.

### 4.1 환자 인증서 (환자 등록/최초 동의 시점)
```
POST {SIGN_URL}/v1/certificates/enroll
Headers: x-api-key: {SIGN_API_KEY}, Content-Type: application/json
Body:
{
  "ownerType": "PATIENT",
  "subjectDn": "CN=홍길동",
  "ownerRef": "{Patient.id}",
  "identity": { "method": "PASS", "ci": "{본인확인 CI}", "phone": "{전화}" }
}
→ 200/201 { "data": { "serialNumber": "CERT-...", "notAfter": "...", "chainValid": true } }
```
→ `Patient.signCertSerial = data.serialNumber` 저장.

### 4.2 직원(의료진) 인증서 (직원 온보딩 시점)
```
POST {SIGN_URL}/v1/certificates/enroll   (x-api-key)
Body:
{
  "ownerType": "STAFF",
  "subjectDn": "CN=김의사",
  "ownerRef": "{User.id}",
  "identity": { "method": "STAFF_SSO" },
  "licenseNumber": "{면허번호}"
}
→ data.serialNumber → User.signCertSerial 저장.
```

> 보호자/외부입회인은 서명 직전 발급 가능(ownerType=PATIENT/WITNESS).

---

## 5. 서명요청 생성 (동의서 생성 시, HIS → sign)

의사가 `ConsentForm` 생성 시 sign에 서명요청을 만든다.

```
POST {SIGN_URL}/v1/requests
Headers: x-api-key: {SIGN_API_KEY}
Body:
{
  "idempotencyKey": "consent-{ConsentForm.id}-v{버전}",   // 멱등(재시도 안전)
  "externalDocId": "{ConsentForm.id}",
  "title": "수술 동의서",
  "documentHash": "{봉인된 동의서 본문 SHA-256(hex, 64자)}",
  "signMode": "APP",                  // APP | TABLET | PC | REMOTE
  "callbackUrl": "{HIS_URL}/api/v1/consent/sign-webhook",
  "participants": [
    { "signerRole": "PATIENT", "signerType": "PATIENT",
      "externalSignerRef": "{Patient.id}", "displayName": "홍길동",
      "signOrder": 1, "certSerial": "{Patient.signCertSerial}",
      "requiredIdentityLevel": "PASS" },     // INPERSON/MOBILE_NAME/PASS/APP_STEPUP/STAFF_SSO
    { "signerRole": "DOCTOR", "signerType": "STAFF",
      "externalSignerRef": "{User.id}", "displayName": "김의사",
      "signOrder": 2, "certSerial": "{User.signCertSerial}",
      "requiredIdentityLevel": "STAFF_SSO" }
  ]
}
→ { "data": { "requestId": "...", "status": "CREATED",
      "participants": [ { "participantId": "...", "signerRole": "PATIENT", "signOrder": 1 }, ... ] } }
```

**HIS 저장**: `ConsentForm.signatureRequestId = data.requestId`, 각 서명자에 `participantId`·`certSerial` 매핑.

**주의**
- `documentHash`는 **HIS가 봉인한 최종 동의서 본문**의 SHA-256. 서명 대상 무결성의 기준.
- `requiredIdentityLevel` 정책: 고위험(수술/마취/DNR)은 `PASS` 또는 대면(`INPERSON`), 직원은 `STAFF_SSO`.
- 서명 순서(`signOrder`)는 채널 무관 전역 게이팅(앞 순번 미서명 시 뒤 순번 거부).

---

## 6. 서명 클라이언트 연동 (서명자 → sign)

HIS는 각 서명자에게 `participantId`(또는 서명 화면)를 제공한다.

### 6.1 환자/보호자 (환자앱·포털·태블릿)
```
POST {SIGN_URL}/v1/sign/{participantId}/submit
Body(비대면): { "identity": { "method": "PASS", "ci": "{CI}", "phone": "{전화}" } }
Body(대면 INPERSON): {}     // 본인확인 정보 불요
→ 200/201 { "data": { "signatureId": "...", "requestStatus": "IN_PROGRESS|COMPLETED" } }
```
- `requiredIdentityLevel`이 비대면(PASS/MOBILE_NAME/APP_STEPUP)인데 `identity` 미제공 시 **403**.

### 6.2 의료진 (의료진 포털) — SSO 경유
```
POST {SIGN_URL}/v1/sign/staff
Headers: Authorization: Bearer {HIS가 발급한 SSO JWT}
Body: { "participantId": "{의사 participantId}" }
→ 200/201 { "data": { "signatureId": "...", "requestStatus": "COMPLETED", "staffSub": "{User.id}" } }
```
- STAFF 참가자는 **반드시 이 엔드포인트(SSO)** 로만 서명. 일반 submit은 409.

> 원내 태블릿(대면 fallback)은 6.1을 `INPERSON`으로 사용.

---

## 7. STAFF SSO 토큰 발급 + JWKS 공개 (HIS가 OIDC 발급자)

sign은 HIS가 발급한 SSO 토큰을 **JWKS로 검증**한다. HIS는 다음을 제공:

1. **JWKS 엔드포인트** 공개 (공개키): 예 `GET {HIS_URL}/.well-known/jwks.json`
2. 의료진 로그인 시 **서명용 JWT(RS256) 발급**:
   - `iss` = 합의된 issuer (예 `hospitalrun`)
   - `sub` = `User.id`
   - `acr`/`amr` = step-up 여부(고위험 서명 시 재인증 반영)
   - 헤더 `kid` = JWKS의 키 식별자, 만료 짧게(예 5분)
3. sign 설정에 `HIS_SSO_JWKS_URL`, `HIS_SSO_ISSUER` 전달.

> 기존 Hospital RUN passkey/SSO/step-up 자산을 재활용해 이 JWT를 발급하면 됨.

---

## 8. Webhook 수신 구현 (sign → HIS)

서명 완료 시 sign이 `callbackUrl`로 POST한다. **HIS가 수신 엔드포인트를 구현**.

```
POST {callbackUrl}   (예: /api/v1/consent/sign-webhook)
Headers: X-Sign-Signature: {HMAC-SHA256(rawBody, SIGN_WEBHOOK_SECRET) hex}
Body:
{
  "eventId": "{uuid}",                 // 멱등 처리 키
  "eventType": "request.completed",
  "requestId": "{sign requestId}",
  "externalDocId": "{ConsentForm.id}",
  "status": "COMPLETED",
  "verifiedHash": "{documentHash}",
  "occurredAt": "ISO8601"
}
```

**HIS 처리 의무**
1. `X-Sign-Signature` 검증: `HMAC-SHA256(원본 raw body, SIGN_WEBHOOK_SECRET)` 일치 확인 → 불일치 시 401.
2. `eventId`로 **멱등 처리**(중복 수신 무시).
3. `externalDocId`로 `ConsentForm` 조회 → `status='SIGNED'`, `signStatus='COMPLETED'`, `auditCertUri` 저장.
4. 2xx 응답(실패 시 sign이 재시도).

> 신뢰성: 네트워크 유실 대비, HIS는 주기적으로 `GET {SIGN_URL}/v1/requests/{requestId}` 로 상태 **reconcile** 권장.

---

## 9. 검증·증거 조회 (선택, HIS → sign)

```
GET {SIGN_URL}/v1/verify/{requestId}
→ { data: { overall: true, auditChainValid: true,
     signatures: [ { signerRole, cryptoVerify, timestampValid, chainValid,
                     notRevoked, ltvValid, format: "PAdES-B-LTA", identityMethod } ] } }

GET {SIGN_URL}/v1/requests/{requestId}/audit   # 감사추적 해시체인
GET {SIGN_URL}/v1/ocsp/{serial} · /v1/crl       # 인증서 폐기 조회 (공개)
```
- 검증/폐기조회 엔드포인트는 **공개**(x-api-key 불요). 발급/폐기/요청 쓰기 엔드포인트는 `x-api-key` 필수.

---

## 10. 설정 / 시크릿 (양측 합의)

| 항목 | 주체 | 설명 |
|---|---|---|
| `SIGN_URL` | sign 제공 | sign 서비스 베이스 URL(원내) |
| `SIGN_API_KEY` (=sign의 `HIS_INBOUND_API_KEY`) | 합의 | HIS→sign 호출 인증 키 (스코프: certificates:write, requests:write) |
| `SIGN_WEBHOOK_SECRET` (=sign의 `HIS_WEBHOOK_SECRET`) | 합의 | Webhook HMAC 공유 시크릿 |
| `HIS_SSO_JWKS_URL` / `HIS_SSO_ISSUER` | HIS 제공 | 의료진 SSO 검증용 |
| (운영) mTLS 클라이언트 인증서 | 합의 | API Key와 병행 권장 |

> 시크릿은 코드/`.env` 커밋 금지, CI/CD Secrets로 관리. 키 회전 정책 합의.

---

## 11. 수용 기준 (E2E, 양측)

> ✅ **계약 검증 완료**: 본 명세의 전체 흐름(§12)은 sign 측 **mock HIS 하니스**(`test/integration-his.e2e.mjs`)로 검증됨 — SSO JWT 발급+**remote JWKS 검증**, 서명요청, 환자(비대면)+의사(SSO) 서명, Webhook(HMAC·멱등) 수신→ConsentForm 반영, LTV 검증, reconcile, 잘못된 issuer 거부까지 13/13 통과. **HIS팀은 이 하니스의 mock HIS 부분(JWKS·Webhook 수신기)을 참조 구현으로 활용** 가능.



- [ ] 환자/직원 인증서 발급 → `signCertSerial` 저장
- [ ] 동의서 생성 → `POST /v1/requests` → `signatureRequestId` 저장
- [ ] 환자(앱) 서명 + 의사(의료진 포털 SSO) 서명 → 순서대로 완료
- [ ] 완료 Webhook 수신 → HMAC 검증 → `ConsentForm.status=SIGNED` 반영
- [ ] `GET /v1/verify` `overall=true`, `ltvValid=true`
- [ ] 잘못된 SSO/API Key → 401, 비대면 본인확인 누락 → 403
- [ ] mock 모듈/모델 제거 확인

---

## 12. 시퀀스 (수술 동의서)

```
1. 의사: HIS에서 ConsentForm 생성
2. HIS → sign: POST /v1/requests (참가자: 환자 order1, 의사 order2)  [x-api-key]
   ← requestId, participantId 2건  → HIS 저장
3. 환자: 환자앱 → POST /v1/sign/{환자 participantId}/submit (+identity)  → IN_PROGRESS
4. 의사: 의료진 포털 → POST /v1/sign/staff (Bearer HIS SSO JWT)  → COMPLETED
5. sign → HIS: Webhook request.completed (X-Sign-Signature)
6. HIS: HMAC 검증 → ConsentForm.status=SIGNED, auditCertUri 저장
7. (선택) HIS: GET /v1/verify/{requestId} 로 표시·보존
```

---

## 13. 점진 전환 전략 (sign.mode 토글) — HIS팀 검토 반영

하드 컷오버 대신 **모드 토글로 안전 전환**. HIS의 dev-simulation 레지스트리 패턴과 일관.

```
ConsentForm.signProvider (또는 config-runtime sign.provider):
  SIMULATION  = 현 HIS 내부 서명(blockchain-cert/document-sign) 유지   ← 기본/초기
  EXTERNAL    = sign 서비스 연동(본 명세 §4~§9)                        ← 점진 적용
  ※ signMode(서명기기/채널)와 별개 컬럼. 명명 충돌 회피.
```

**단계**
| Phase | HIS | sign |
|---|---|---|
| **P0 (선행, 저위험)** | §3 비파괴 컬럼 추가 + `sign.mode` 토글 스캐폴드만. 기존 동작 무변경 | 연동 하니스(✅ 완료), PAdES/RFC3161(✅ 증명), Prisma-live·hardening 진행 |
| **P1 (파일럿)** | 특정 동의서 1종만 `EXTERNAL` 전환, 나머지 SIMULATION 유지 | 운영급 안정화 |
| **P2 (확대)** | 동의서 종류 점진 EXTERNAL 전환 | 모니터링 |
| **P3 (정리)** | `blockchainSignature` deprecate→백필→제거, mock 모듈 제거 | — |

**원칙**: 전체 전환은 **sign이 PAdES/TSA/Prisma-live 완료 후**. 그 전까지 작동 중인 HIS 내부 서명 유지. `blockchainSignature`는 즉시 삭제 금지(읽기전용 deprecate→백필→후속 제거).

---

## 부록: 미정/합의 필요
- 본인인증 사업자(PASS/명의) 확정(Q4) — `identity.method` 운영값
- 원외 1차 적용 범위(Q6) — `signMode=REMOTE`/발송 채널
- 운영 영속화(sign측 Prisma/PostgreSQL), HSM, mTLS 일정
