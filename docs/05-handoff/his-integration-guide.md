# HIS 통합 가이드 — sign 전자서명 트러스트 연동 (동의서 구현)

> **대상**: HIS(Hospital RUN) 개발팀이 **전자동의서**를 구현할 때 sign API로 전자서명을 붙이는 단일 통합 가이드.
> **모델**: HIS = 동의서 문서·환자 UX·저장 / **sign = 전자서명 트러스트**(인증서 발급·서명·검증·감사). HIS는 sign API 호출 + 결과 미러.

---

## 0. 핵심 모델 (한 장)
```
HIS                                  sign (트러스트)
─ 동의서 PDF 생성·저장               ─ 인증서 발급(HSM-앵커 CA)
─ documentHash(SHA-256) 계산  ──────▶─ 서명·감사 해시체인·TSA
─ 환자/의료진 서명 UX                ─ 검증·감사추적인증서
─ ConsentForm + signCertSerial 미러 ◀── webhook(완료·HMAC)
```
- HIS는 **문서를 보관**하고 그 **해시(64 hex)** 만 sign에 보낸다. sign은 문서를 보관하지 않는다.
- 인증서 **발급은 sign 단독**. HIS는 발급하지 않고 serial을 **읽기전용 미러**로만 보관(`user.signCertSerial`·`consentForm.signCertSerial`).

## 1. 사전 준비 (HIS system_configs 주입)
| 키 | 값 | 비고 |
|---|---|---|
| `sign.url` | 동일서버 `http://127.0.0.1:4100/v1` / 원격 `https://sign.example.org/v1` | HIS→sign 호출 base |
| `sign.apiKey` | = sign `HIS_INBOUND_API_KEY` | 안전채널 수령(채팅 금지), `x-api-key` 헤더 |
| `sign.webhookSecret` | = sign `HIS_WEBHOOK_SECRET` | webhook HMAC 검증 |
| `sign.webhookUrl`(sign측 설정) | `https://his.example.org/api/v1/sign-integration/webhook` | sign이 이 URL로 완료 webhook 발화 |
- SSO(의료진 서명): JWKS `https://his.example.org/api/v1/sign-integration/jwks`, iss=`hospitalrun`, **aud=`sign`(강제)**, staff-token 10분.
- 미주입 시 EXTERNAL 호출은 명확한 "미구성" 에러로 무중단 차단.

## 2. 인증 방식 3종
| 주체 | 방식 |
|---|---|
| HIS 시스템(기계) | `x-api-key: <sign.apiKey>` (서버↔서버) |
| 의료진(서명) | HIS 발급 staff-token(aud=sign) → `Authorization: Bearer` (sign이 JWKS 검증) |
| 환자(서명) | 본인확인(PASS/대면) + 포털 토큰(2번 응답 `portalUrl`) |

## 3. 동의서 서명 플로우 (표준)
```
① (의료진 사전 1회) enroll → user.signCertSerial 영속
② 동의서 생성 시: POST /v1/sign-requests (documentHash·channel·patientSigner)
③ 환자: portalUrl 서명  /  의료진: /v1/sign/staff(Bearer)
④ sign → HIS webhook request.completed (HMAC) → ConsentForm.status=SIGNED·미러
⑤ 검증: GET /v1/verify/:id   ⑥ 증빙: audit-certificate PDF
```

## 4. API 레퍼런스 (`$B=sign.url`, `$K=sign.apiKey`)

### 4.1 인증서 발급 — `POST /v1/certificates/enroll`
의료진은 **1회 발급 후 serial 재사용**(비멱등 — 재호출 시 새 serial). 환자는 4.2 자동발급 또는 standalone enroll 둘 다 지원.

**필드 명세** (⚠️ `publicKey`·`algorithm` **보내지 말 것** — 키 생성 주체는 **sign**):
| 필드 | 필수 | 설명 |
|---|---|---|
| `ownerType` | ✅ | PATIENT / STAFF / WITNESS / PROXY |
| `subjectDn` | ✅ | ≥2자. 권장 DN `CN=홍길동,O=병원,C=KR`(평문 이름도 허용) |
| `identity.method` | 조건부 | **PATIENT/PROXY 필수**(PASS/MOBILE_NAME/INPERSON). STAFF 생략 시 `STAFF_SSO` 기본, WITNESS 생략 시 `INPERSON` 기본 |
| `identity.ci` | 권장 | 환자 본인 바인딩(HMAC 해시 저장). PATIENT 권장 |
| `identity.phone` | 선택 | |
| `ownerRef` | 선택 | EMR 환자 ID / HIS user.id |
| `licenseNumber` | 선택(STAFF) | 면허번호 |
| `validDays` | 선택 | 기본 365(WITNESS 1) |
> 🔑 **키 생성 = sign**: sign이 키쌍을 생성하고 개인키를 수탁(SOFT/HSM·비추출), 응답으로 `serialNumber`+공개키 인증서를 반환. **HIS는 publicKey를 보내지 않는다**(보내도 무시됨). PATIENT standalone enroll 지원(일괄 발급 가능).
```bash
curl -XPOST $B/certificates/enroll -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "ownerType":"STAFF","subjectDn":"CN=김외과,O=병원,C=KR",
  "licenseNumber":"MD-1001","identity":{"method":"STAFF_SSO"},"ownerRef":"<HIS user.id>"
}'
# → { "data": { "serialNumber":"CERT-...", "chainValid":true, "assuranceLevel":"SOFTWARE", ... } }
```
응답 `serialNumber`를 `user.signCertSerial`에 영속(null일 때만 — enroll-once).

### 4.2 동의서 서명요청(발급+요청 일괄) — `POST /v1/sign-requests`
```bash
curl -XPOST $B/sign-requests -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "documentType":"조영제 사용 동의서",
  "documentHash":"<최종 PDF SHA-256, 64 hex>",
  "channel":"PORTAL",                 // DIRECT(앱직접)|PORTAL(환자 deep-link)|STAFF(의료진 SSO)|PROXY(대리)
  "issueNo":"CONSENT-2026-0001",      // 멱등키 + externalDocId
  "requiredIdentityLevel":"PASS",     // PASS|INPERSON|APP_STEPUP|STAFF_SSO
  "externalSignerRef":"<HIS 환자/직원 ref>",
  "patientSigner":{"name":"홍길동","ci":"<CI>","phone":"010..."},  // PATIENT/PROXY 자동발급 근거
  "certSerial":"<STAFF serial>",      // STAFF 채널만(2.의료진)
  "relationship":"법정대리인","onBehalfOf":"<환자 ref>"  // PROXY만
}'
# → { "data": { "signatureRequestId":"<uuid>", "participantId":"<uuid>", "portalUrl":"https://sign.example.org/portal/<token>" } }
```
- PATIENT/PROXY는 `patientSigner` 기반 **자동 발급**(별도 enroll 불요). STAFF는 `certSerial` 필수.
- `portalUrl`은 channel=PORTAL일 때만(환자에게 전달, 48h·일회용).

### 4.3 서명 제출
```bash
# 환자(포털)
curl -XPOST $B/portal/<token>/sign -H 'content-type: application/json' -d '{"identity":{"method":"PASS","ci":"<CI>"}}'
# 환자(앱 직접, 서버↔서버)
curl -XPOST $B/sign/<participantId>/submit -H "x-api-key: $K" -d '{"identity":{"method":"PASS","ci":"<CI>"}}'
# 의료진(SSO)
curl -XPOST $B/sign/staff -H "authorization: Bearer <staff-token>" -d '{"participantId":"<pid>"}'
```

### 4.4 검증 — `GET /v1/verify/:id` (공개)
```jsonc
{ "overall": true, "status":"COMPLETED", "auditChainValid": true,
  "assuranceLevel":"SOFTWARE",            // KMS 가동 시 HSM_ANCHORED ← "HSM 보호" 봉인 트리거
  "caKeyCustody":"SOFT", "caKeyCustodyProvider":"SOFT",
  "signatures":[{ "certSerial":"...","signerType":"PATIENT","keyCustody":"SOFT",
                  "cryptoVerify":true,"chainValid":true,"ltvValid":true,"valid":true }] }
```

### 4.5 감사추적인증서 — `GET /v1/requests/:id/audit-certificate` (PDF, 공개)
PAdES 서명된 감사추적 요약 PDF. 법적 증빙용.

### 4.6 폐기·상태 — `POST /v1/certificates/:serial/{revoke,suspend,resume}` · `GET /v1/ocsp/:serial` · `/v1/crl`
관리 UI는 sign 콘솔(`/admin/certificates-list`)에 일원화. HIS는 필요 시 API로 폐기/중단 요청 가능(`certificates:write`, actor 감사 봉인).

## 5. Webhook 수신 (HIS 구현 필수)
- **수신 URL**: `https://his.example.org/api/v1/sign-integration/webhook` (sign이 `HIS_WEBHOOK_URL`로 발화)
- **검증**: 헤더 `X-Sign-Signature` = HMAC-SHA256(rawBody, `sign.webhookSecret`). 불일치 시 401 반환(자동 재시도).
- **멱등**: `eventId` 7일 윈도우 중복 무시.
- **타입**: `request.completed` | `request.withdrawn` | `request.expired` | `request.signer_completed`(다자 서명 중간 시점).
- **상관키는 `externalDocId`(호출자 자연키) 사용 권장** ⚠ — sign 은 **`submit` 처리 중에 완료 통지를 발화**한다.
  발급을 동기 흐름(`POST /v1/sign-requests` → `submit` 연속 호출)으로 구현한 시스템은 **아직 `requestId` 를 저장하기 전에**
  통지를 받을 수 있어, `requestId` 로만 상관시키면 **정상 발급인데도 "알 수 없는 요청"으로 미반영**된다(2026-07-28 edu 실사례).
  `externalDocId` 는 호출자가 sign 호출 **이전에** 확정한 값이라 경쟁이 없다 — 우선 `externalDocId` 로 매칭하고,
  매칭되면 `requestId` 를 저장해 이후 통지는 곧바로 상관시키는 방식을 권장한다.
  sign 은 이 값을 **변형 없이 그대로** 실어 보내며(회귀 테스트로 고정), 매핑 규칙을 바꿀 경우 연동 팀에 사전 통지한다.
```jsonc
// request.completed payload
{ "eventType":"request.completed", "eventId":"...", "externalDocId":"<issueNo>",
  "requestId":"...", "signatureRequestId":"...", "verifiedHash":"<documentHash>",
  "signCertSerial":"CERT-...", "signCertSerials":["CERT-..."],
  "assuranceLevel":"SOFTWARE",
  "signatures":[{ "certSerial":"CERT-...","signerType":"STAFF","signerRole":"DOCTOR",
                  "externalSignerRef":"<직원/환자 ref>",  // ← user/consentForm 미러 매핑키
                  "keyCustody":"SOFT","tsaGenTime":"...","tsaToken":{...} }],
  "auditCertUri":"https://.../audit-certificate" }
```
- **미러 기록**: `signatures[].externalSignerRef`로 식별 → `user.signCertSerial`(직원)·`consentForm.signCertSerial`(환자) 채움(null일 때만). `consentForm.status=SIGNED`, `signAssuranceLevel` 기록.

## 6. attestation (HSM 보호 표기)
- **봉인 트리거 = `assuranceLevel == "HSM_ANCHORED"`** (⚠️ `keyCustody=="HSM"` 아님 — 서명키는 SOFT 설계).
- 현재 SOFT 운영 → `SOFTWARE`. **KMS-CA cutover 후 자동 `HSM_ANCHORED`**(코드 변경 0). cutover 시 sign이 신규 issuingSerial 통지.

## 6-1. 의료진 중요 행위 인증 로그 (선택) — `POST /v1/audit-events`
서명 외의 임상 행위(처방·판독승인·동의취득·열람 등)를 **블록체인(해시체인+TSA) 인증 로그**로 봉인.
```bash
curl -XPOST $B/audit-events -H "x-api-key: $K" -d '{
  "action":"PRESCRIPTION_ISSUED","actor":"<직원번호/user.id>","actorRole":"DOCTOR",
  "targetType":"PATIENT","targetRef":"<환자ID>","stream":"clinical-events","anchor":true,
  "data":{"note":"PHI 원본 금지 — 식별자·해시만"}}'
# → { "data": { "entryHash":"<인증 해시>","prevHash":"...","occurredAt":"...","anchored":true } }  ← 인증 영수증
```
- `GET /v1/audit-events?stream=` 조회 · `GET /v1/audit-events/verify?stream=` 무결성 검증(chainValid·앵커).
- 행위자(`actor`) + 제출 시스템(consumerApp) 봉인. `anchor:true`면 TSA 시점봉인. ⚠️ PHI 원본 금지(식별자·해시만).
- **의료진 본인 인증 봉인(권장)**: `Authorization: Bearer <staff-token(aud=sign)>` 동봉 시 sign이 JWKS 검증 → 검증된 의료진 신원(`sub·role·사번·acr·signCertSerial`)을 `auth`로 봉인(`authMethod:SSO`). 토큰 없으면 `authMethod:API_KEY`(시스템 주장). 무효 토큰 → 401·미기록.

## 7. 발급 일원화 — HIS 역할 (확정)
- HIS는 **인증서를 발급하지 않는다**(자체 블록체인 인증서 발급 폐지, `blockchain.selfIssuanceEnabled=false`).
- 발급이 필요하면 **sign API 호출**(4.1/4.2). 관리(목록/폐기/정지) **UI는 sign 콘솔로 은퇴**.
- HIS는 **serial 미러(읽기전용)만 유지** + `signProvider=EXTERNAL`·`sign.mode=EXTERNAL`.

## 8. 멱등·오류·재시도
- 멱등: `issueNo`(=idempotencyKey) 재호출 시 동일 요청 반환(중복 생성 없음).
- 오류 포맷: `{ "error": { "code","message","requestId" } }`. 인증 실패 401, scope 부족 403, 검증 실패 400.
- Webhook: sign 아웃박스가 실패 시 재시도(최대 8회·지수백오프, DEAD 후 `/v1/maintenance/webhook-retry`로 재전송).

## 9. 운영
- **전면교체(개발/시드)**: sign 신규 CA 재기준 시 기존 serial 무효 → HIS는 `user.signCertSerial=NULL` 클리어 후 재발급(`ensureStaffCert`). 절차: [`../06-ops/clean-reset-runbook.md`].
- **시크릿 회전(P8, go-live 전)**: webhookSecret dual-accept·apiKey 회전 EP(무중단).
- **하드닝**(go-live): `SECURITY_HARDENING` ON 시 webhook https 강제·rate-limit·PII GET 인증.

## 10. 구현 체크리스트
- [ ] system_configs: sign.url·apiKey·webhookSecret 주입 + signProvider=EXTERNAL
- [ ] 의료진 enroll-once → user.signCertSerial 영속
- [ ] 동의서 생성 시 documentHash(최종 PDF SHA-256) → `POST /v1/sign-requests`
- [ ] 환자=portalUrl 전달 / 의료진=staff-token(aud=sign) → 서명
- [ ] webhook 수신부: HMAC 검증·eventId 멱등·미러(externalSignerRef→signCertSerial)
- [ ] verify·audit-certificate로 검증/증빙, assuranceLevel 봉인
- [ ] (확정) 자체 발급/관리 UI 은퇴, serial 미러만 유지

---
## 관련 문서
- 기준 원칙: [`hsm-single-custody-architecture.md`](./hsm-single-custody-architecture.md) · 운영: [`../06-ops/operations-guide.md`](../06-ops/operations-guide.md)
