# [연동팀 전달] 전자결재(상신→결재) 연동 계약 — caller ↔ sign

> **수신**: HIS(Hospital RUN) · PACS · ERP 등 상신 caller 개발팀
> **발신**: sign(전자서명 트러스트 서비스) 팀
> **Date**: 2026-07-05 · **버전**: 0.1 (초안, P3)
> **목적**: caller가 sign의 **전자결재 서비스**로 결재를 상신하고, 지정 결재자가 결재하며, 결과·**통합 인증로그**를 회신받기 위한 **양측 계약**을 규정
> **설계**: `docs/02-design/features/electronic-approval.design.md` (모델 A) · **피처플래그 `ELECTRONIC_APPROVAL` 기본 OFF**(보안검토 sign-off 후 활성)

---

## 0. 배경 (요약)

- 전자결재는 sign의 **다자 순차서명 엔진을 재사용**한다(모델 A). 각 결재 액션 = **실제 STAFF 전자서명**(EMR F010·법적효력) + **통합 인증로그**(본인확인 사실 + F008 접속기록).
- **경계**: sign은 **원본 문서를 받지 않는다.** caller가 원본을 보관하고, sign에는 **SHA-256 해시만** 전달한다(PHI 최소화·원내 경계 유지).
- 관계: **Provider(sign) · Consumer(caller)**. sign이 키·서명·검증·인증로그를 소유, caller가 문서 콘텐츠·결재선 정책·결재자 계정을 소유.
- 두 감사 스트림 분리: 서명 라이프사이클(`<requestId>`) + **결재 인증로그(`approval:<requestId>`)**.

---

## 1. 책임 범위 (체크리스트)

- [ ] **(사전)** 결재자 서명 인증서 발급 — §2.1
- [ ] **(사전)** 결재자 계정/SSO 주체 매핑(`approverId`) — §2.2
- [ ] **(상신)** 결재 문서 상신(해시 전달) — §3
- [ ] **(결재)** 지정 결재자 세션으로 승인/반려 + step-up — §4·§5
- [ ] **(회신)** 완료/반려 webhook 수신·검증·반영 — §6
- [ ] **(증거)** 통합 인증로그 조회·보존 — §7
- [ ] **(설정)** URL·키·시크릿·플래그 구성 — §9
- [ ] **(수용)** E2E 통과 — §10
- [ ] **(백엔드 델타 합의)** 기계키 상신·SSO 결재 확장 — §12

---

## 2. 사전 준비 (상신 전 계약)

### 2.1 결재자 서명 인증서 (선택 — 자동발급 지원)
결재자 서명 인증서(`certSerial`)는 **선택**이다. 상신 시 `line[].certSerial` 미지정이면 **sign이 STAFF 인증서를 자동발급**(subjectDn=결재자 표시명, ownerRef=approverId)한다. 기존 인증서를 재사용하려면 사전 발급 후 `certSerial` 전달:

```
POST {SIGN_URL}/v1/certificates/enroll
Headers: x-api-key: {SIGN_API_KEY}
Body: { "ownerType": "STAFF", "subjectDn": "CN={결재자명}", "licenseNumber": "{면허/사번}", "identity": { "method": "STAFF_SSO" } }
→ { "data": { "serialNumber": "{certSerial}" } }
```
- caller 저장: `결재자 ↔ certSerial` 매핑(상신 시 `line[].certSerial`로 전달).

### 2.2 결재자 계정/SSO 주체 매핑 (`approverId`)
`approverId`는 **결재 시점에 인증되는 주체**와 일치해야 한다(타인 대리 결재 차단 = 바인딩).
- 콘솔 결재자: `approverId` = 콘솔 계정 `username`.
- HIS SSO 결재자: `approverId` = SSO 토큰 `sub`(§12 SSO 결재 확장 시).

---

## 3. 상신 (caller → sign)

결재 문서 생성 시 sign에 결재 봉투를 만든다.

```
POST {SIGN_URL}/v1/approvals
Headers: x-session-token: {콘솔 세션}   // 현재 구현. 기계키 상신은 §12(P3.1)
Scope : approval:write
Body:
{
  "idempotencyKey": "appr-{문서ID}-v{버전}",   // 멱등(재시도 안전)
  "externalDocId": "{원문서 참조 ID}",          // 예: consent:{ConsentForm.id}
  "title": "마약류 처방 결재",
  "documentHash": "{원본 문서 SHA-256(hex 64자)}",  // ⚠️ 원본 바이트 미전달
  "docType": "NARCOTIC",                        // 위험도 판정(§5). 미지정=일반
  "callbackUrl": "{CALLER_URL}/approval-webhook", // 선택(완료·반려 통지)
  "ttlDays": 7,                                  // 선택(미결재 만료)
  "line": [                                      // 결재선(순차)
    { "approverId": "dr_kim", "displayName": "김과장", "order": 1, "certSerial": "{certSerial1}", "role": "DOCTOR" },
    { "approverId": "dir_lee", "displayName": "이원장", "order": 2, "certSerial": "{certSerial2}", "role": "DIRECTOR" }
  ]
}
→ { "data": { "requestId": "...", "status": "CREATED", "highRisk": true, "docType": "NARCOTIC",
      "participants": [ { "participantId": "...", "signerRole": "DOCTOR", "signOrder": 1 }, ... ] } }
```

**필드 계약**

| 필드 | 필수 | 내용 |
|---|---|---|
| `idempotencyKey` | ✅ | 중복 상신 방지 키 |
| `externalDocId` | ✅ | 원문서 참조 ID(역매핑 키) |
| `title` | ✅ | 결재 문서 제목 |
| `documentHash` | ✅ | **원본 문서 SHA-256**(hex 64). 서명 대상 무결성 기준 |
| `docType` | 선택 | 문서 유형(위험 판정: `SURGERY`·`ANESTHESIA`·`DNR`·`NARCOTIC`·`TRANSFUSION`→고위험) |
| `line[]` | ✅ | 결재선 배열(아래) |
| `callbackUrl` | 선택 | 완료·반려 webhook |
| `ttlDays` | 선택 | 미결재 만료 기한 |

`line[]` 항목:

| 필드 | 필수 | 내용 |
|---|---|---|
| `approverId` | ✅ | 결재자 계정/SSO 주체 — **결재 시 세션 주체와 일치 필수**(바인딩) |
| `displayName` | ✅ | 표시명 |
| `order` | ✅ | 결재 순서(1→N 순차 게이팅, 앞 순번 미결재 시 뒤 순번 거부) |
| `certSerial` | 선택 | 결재자 서명 인증서 — 미지정 시 **sign 자동발급**(§2.1) |
| `role` | 선택 | 표시용 역할 |

**caller 저장**: `문서.approvalRequestId = data.requestId`, 결재자별 `participantId` 매핑.

---

## 4. 결재 — 승인/반려 (결재자 세션 → sign)

지정 결재자가 자신의 세션으로 결재한다. 순서 게이팅·바인딩·step-up은 sign이 강제.

```
POST {SIGN_URL}/v1/approvals/{requestId}/act
Headers: x-session-token: {결재자 콘솔 세션}   // SSO 결재는 §12
Scope : approval:act
Body(승인):  { "decision": "APPROVE", "opinion": "이상 없음" }
Body(반려):  { "decision": "REJECT",  "opinion": "용량 재확인 필요" }
Body(고위험/최종 승인): { "decision": "APPROVE", "opinion": "승인", "stepUp": { "method": "PASS", "ci": "{본인확인값}" } }
→ { "data": { "requestId": "...", "status": "IN_PROGRESS|COMPLETED|REJECTED", "step": 1, "decision": "APPROVE" } }
```

- **바인딩**: 세션 주체 ≠ 현재 단계 `approverId` → **403**(`APPROVER_MISMATCH`).
- **순서**: 현재 단계가 아닌 참가자 결재 시도 → 순차 게이팅.
- **반려**: 즉시 봉투 종결(`REJECTED`), 이후 결재 시도 409.
- **fail-closed**: 인증로그 봉인 실패 시 결재 미커밋(승인=로그先→서명).

---

## 5. step-up 매트릭스 (본인확인 재강제)

아래 중 하나면 승인 시 `stepUp`(본인확인) **필수**, 미제공 시 **403**(`STEP_UP_REQUIRED`).

| 조건 | step-up | 판정 |
|---|---|---|
| 고위험 문서(`SURGERY`·`ANESTHESIA`·`DNR`·`NARCOTIC`·`TRANSFUSION`) | **강제** | 상신 `docType` |
| 최종 결재 단계(마지막 `order`) | **강제** | `signOrder == 결재선 길이` |
| 그 외(일반·중간) | 면제 | 로그인 세션 = 본인확인 근거 |

- `stepUp` 자격(우선순위): **콘솔 결재자 = `{ mfaCode }`**(인증앱 TOTP/복구코드, assurance=MFA_STEPUP) · **HIS SSO = 재인증 `acr`**(assurance=SSO_STEPUP) · **폴백 = `{ method:'PASS', ci|phone }`**(IdentityProvider, `identityVerificationId` 봉인).

---

## 6. 완료·반려 Webhook (sign → caller)

`callbackUrl` 지정 시, 최종 결재/반려에서 통지(HMAC 서명 `X-Sign-Signature`).

```
POST {callbackUrl}
Headers: X-Sign-Signature: {HMAC-SHA256}
Body(완료): { "requestId":"...", "signatureRequestId":"...", "externalDocId":"...", "status":"COMPLETED",
  "signCertSerials":[...], "auditCertUri":"{SIGN_URL}/v1/requests/{id}/audit-certificate", "occurredAt":"..." }
```
- caller: HMAC 검증(§9 시크릿) 후 `문서.approvalStatus` 반영. `eventId` 멱등 처리.

---

## 7. 통합 인증로그 조회·보존 (caller → sign)

결재 인증로그(본인확인 사실 + F008 접속기록)를 조회·검증·보존.

```
GET {SIGN_URL}/v1/approvals/{requestId}/authlog                → { data: [ {eventType, data:{actor,auth,ip,step,decision,...}, entryHash, ...}, ... ] }
GET {SIGN_URL}/v1/approvals/{requestId}/authlog/verify         → { data: { chainValid, anchored, valid } }
GET {SIGN_URL}/v1/approvals/{requestId}/authlog/export.csv     → CSV(UTF-8 BOM, 식별자·해시만)
```
- 이벤트: `APPROVAL_SUBMITTED`(상신) · `APPROVAL_APPROVED` · `APPROVAL_REJECTED` · `APPROVAL_SIGN_FAILED`(보정).
- 각 엔트리: `actor`(결재자)·`auth.method`·`auth.assurance`(SESSION/STEP_UP)·`auth.identityVerificationId`·`ip`·`userAgent`·`step`·`decision`·`opinion`. 해시체인 + 완료 시 TSA 앵커.

---

## 8. PHI 경계 / 보안

- **원본 문서 미전달**: sign은 `documentHash`만 보관. 원본은 caller 측 저장(원내 경계).
- **인증 주체 서버 도출**: 결재자 actor는 sign이 세션(콘솔/SSO)에서 도출. 요청 본문의 신원 주장 불신.
- **최소 식별**: `approverId`·`externalDocId`는 참조 식별자만(PHI 원문 금지). 인증로그 CSV도 식별자·해시만 봉인.
- **인증로그 무결성**: 해시체인 + TSA 앵커 → 사후 위변조 탐지(F008·F009).

---

## 9. 설정 / 시크릿 / 플래그 (양측 합의)

| 항목 | 값/주체 |
|---|---|
| `SIGN_URL` | sign 서비스 base URL |
| `SIGN_API_KEY` | caller용 API 키 — **콘솔에서 발급**(`/admin/consumers` "새 소비자 등록", ca:admin. 이름+스코프 지정→키 1회 반환, 재기동 영속). env/코드 수정 불요. 상신엔 `approval:write` 부여 |
| 상신·결재 주체 | 상신=콘솔 세션 또는 **기계키(approval:write)** · 결재=콘솔 세션 또는 **HIS SSO Bearer**(`act-staff`) — §12 P3.1 **구현 완료** |
| Webhook 시크릿 | caller별 HMAC 시크릿(격리) |
| `ELECTRONIC_APPROVAL` | **기본 OFF** — 보안검토 sign-off 후 caller별 on |

---

## 10. 수용 기준 (E2E, 양측)

1. 상신 → `data.requestId`·`APPROVAL_SUBMITTED` 봉인, `highRisk` 정합.
2. 미지정자 결재 → 403(`APPROVER_MISMATCH`). 순서 위반 → 게이팅.
3. 비최종·비고위험 승인 → step-up 불요, `IN_PROGRESS`.
4. 고위험/최종 승인 → step-up 없으면 403, 있으면 `COMPLETED` + `identityVerificationId` 봉인.
5. 전원 승인 → `COMPLETED` + TSA 앵커 + (지정 시) 완료 webhook.
6. 반려 → `REJECTED` + `APPROVAL_REJECTED`, 이후 결재 409.
7. 인증로그 조회·verify(체인+앵커)·CSV(BOM) 동작.
8. 플래그 OFF → 상신/결재 404.

> sign 백엔드 회귀 `test/electronic-approval.e2e.mjs`(27) + UI `web/tests/e2e/approval.spec.ts`(2)가 위를 커버.

---

## 11. 시퀀스 (마약류 처방 결재)

```
caller ──(1) 결재자 cert enroll──▶ sign        (사전 1회)
caller ──(2) POST /v1/approvals (해시·결재선)──▶ sign  → requestId, APPROVAL_SUBMITTED
과장  ──(3) POST /:id/act APPROVE──▶ sign       → IN_PROGRESS, APPROVAL_APPROVED(step1)
원장  ──(4) POST /:id/act APPROVE +stepUp──▶ sign → COMPLETED, APPROVAL_APPROVED(step2, STEP_UP)
sign  ──(5) 완료 webhook(HMAC)──▶ caller         → 문서.approvalStatus=승인
caller ──(6) GET /:id/authlog/verify──▶ sign     → 체인+앵커 유효(증거 보존)
```

---

## 12. 현재 구현 상태 vs 백엔드 델타 (P3.1, 합의 필요)

본 계약의 **목표 형태**와 현재 P1/P2 구현의 차이 — caller 기계-대-기계/SSO 연동을 위해 sign 백엔드 확장이 필요.

| 항목 | 현재(P1/P2) | 목표(계약) | 델타 |
|---|---|---|---|
| 상신 주체 | ✅ **구현** — 콘솔 세션 또는 기계키(`approval:write`) | HIS 기계키 상신 | `POST /v1/approvals` 세션/기계키 겸용, `submittedBy`(actor=his:*, MACHINE_KEY) |
| 결재 주체 | ✅ **구현** — 콘솔 세션 또는 SSO Bearer | HIS 의료진 SSO 결재 | `POST /v1/approvals/:id/act-staff`(JWKS, sub==approverId 바인딩, 고위험/최종 step-up은 SSO acr) |
| step-up 자격 | `IdentityProvider`(PASS ci) | 콘솔 **MFA 재확인** 병행 | 세션 MFA 상태를 assurance 근거로 승격(어댑터 교체) |
| 결재자 cert | 상신 시 `certSerial` 필수 | 미보유 시 자동발급 | 상신 내 auto-enroll(sign-request-facade 패턴) |

> **권고 순서**: 보안검토 sign-off → 콘솔 파일럿(현재 구현) → P3.1(기계키 상신·SSO 결재) → caller 1곳 파일럿.

---

## 부록: 미정 / 합의 필요

- 상신 주체 인증 방식(기계키 vs 서비스계정 세션) 최종 결정.
- 결재선 정책 소유(누가 결재선을 구성하는가 — caller 자동 vs 콘솔 수동).
- 병렬 결재·전결(위임)·후결·회수(상신 취소) 요구 여부(현재 MVP=순차만).
- 완료 webhook에 결재 의견(`opinion`) 포함 여부(PHI 관점 검토).
- 대량 상신(일괄) 요구 여부.
