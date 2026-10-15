# PACS 통합 가이드 — sign 전자서명 트러스트 연동 (판독보고서·영상동의서)

> **대상**: PACS(OpenPACS) 개발팀이 **판독보고서 서명(A)** 과 **영상·조영제 동의서(B)** 에 sign 전자서명을 붙이는 단일 통합 가이드.
> **모델**: PACS = 문서(보고서/동의서)·UX·저장 / **sign = 전자서명 트러스트**(발급·서명·검증·감사). PACS는 sign API 호출 + 결과 미러.

---

## 0. 핵심 모델 + 2 유스케이스
```
PACS                                  sign (트러스트)
─ 보고서/동의서 PDF 생성·저장          ─ 인증서 발급(HSM-앵커 CA)
─ documentHash(SHA-256) 계산  ───────▶─ 서명·감사 해시체인·TSA
─ 판독의/환자 서명 UX                  ─ 검증·감사추적인증서
─ signCertSerial 미러                 ◀── webhook(완료, PACS callbackUrl) 또는 verify 폴링
```
| 유스케이스 | 서명자 | 채널 | 인증서 |
|---|---|---|---|
| **A. 판독보고서** | 판독의(STAFF) | `STAFF` | 사전 1회 발급(면허) → 재사용 |
| **B. 영상·조영제 동의서** | 환자(PATIENT) | `PORTAL`/`DIRECT` | facade **자동발급** |
- PACS는 **같은 서버(198.51.100.73)** → `sign.url = http://127.0.0.1:4100/v1`(내부). 환자 서명만 공개 `https://sign.example.org`.
- 인증서 발급은 **sign 단독**. PACS는 serial 미러(읽기전용)만.

## 1. 사전 준비
| 키 | 값 | 비고 |
|---|---|---|
| `sign.url` | `http://127.0.0.1:4100/v1` (동일서버 내부) | 서버↔서버 |
| `PACS_API_KEY` | sign 발급(안전채널) | `x-api-key`, scope `certificates:write`·`requests:write` |
| `sign.webhookSecret` | = sign `HIS_WEBHOOK_SECRET`(공유) | webhook HMAC(사용 시) |
- SSO(판독의): JWKS `https://his.example.org/api/v1/sign-integration/jwks`, iss=`hospitalrun`, **aud=`sign`**. staff-token은 **병원 공통 SSO 재사용**(HIS 발급).
- ⚠️ **webhook 대상 주의**: sign 전역 기본(`HIS_WEBHOOK_URL`)은 **HIS 수신처**다. **PACS는 요청마다 `callbackUrl`(PACS 수신 URL)을 명시**하거나 **verify 폴링**을 써야 한다(§6).

## 2. 인증 3종
| 주체 | 방식 |
|---|---|
| PACS 시스템 | `x-api-key: <PACS_API_KEY>` |
| 판독의(STAFF) | staff-token(aud=sign) → `Authorization: Bearer` (sign이 JWKS 검증) |
| 환자(동의) | 본인확인(PASS/대면) + 포털 토큰 |

## 3. 유스케이스 A — 판독보고서 서명 (STAFF)
```
① (판독의 사전 1회) enroll(STAFF,면허) → sign_cert_serial 영속·매핑
② 보고서 확정 시: POST /v1/sign-requests (channel:STAFF, documentHash, certSerial, callbackUrl)
③ 판독의: POST /v1/sign/staff (Bearer staff-token, aud=sign)
④ 완료 → webhook(PACS callbackUrl) 또는 verify 폴링
⑤ GET /v1/verify/:id (assuranceLevel·chainValid) ⑥ audit-certificate PDF
```
```bash
# ① 판독의 인증서(1회)
curl -XPOST $B/certificates/enroll -H "x-api-key: $PK" -d '{"ownerType":"STAFF","subjectDn":"CN=박판독,O=병원,C=KR","licenseNumber":"MD-1003","identity":{"method":"STAFF_SSO"},"ownerRef":"<판독의 user.id>"}'
# ② 보고서 서명요청 (STAFF)
curl -XPOST $B/sign-requests -H "x-api-key: $PK" -d '{"documentType":"판독보고서","documentHash":"<64hex>","channel":"STAFF","issueNo":"RPT-2026-001","certSerial":"<판독의 serial>","externalSignerRef":"<판독의 ref>","signerRole":"DOCTOR","callbackUrl":"https://pacs.../webhook"}'
# ③ 판독의 서명
curl -XPOST $B/sign/staff -H "authorization: Bearer <staff-token>" -d '{"participantId":"<pid>"}'
```

## 4. 유스케이스 B — 영상·조영제 동의서 (PATIENT)
```
① 동의서 생성 시: POST /v1/sign-requests (channel:PORTAL, documentHash, patientSigner, callbackUrl) → portalUrl
② 환자: portalUrl 본인확인+서명
③ 완료 → webhook(PACS) 또는 verify 폴링 → ④ 검증·증빙
```
```bash
curl -XPOST $B/sign-requests -H "x-api-key: $PK" -d '{
  "documentType":"조영제 사용 동의서","documentHash":"<64hex>","channel":"PORTAL",
  "issueNo":"CONSENT-IMG-001","requiredIdentityLevel":"PASS",
  "patientSigner":{"name":"홍길동","ci":"<CI>"},"callbackUrl":"https://pacs.../webhook"}'
# → { "data":{ "signatureRequestId","participantId","portalUrl" } }
# 대리(보호자): channel:"PROXY", relationship:"법정대리인", onBehalfOf:"<환자 ref>"
```

## 5. API 레퍼런스 (`$B=sign.url`, `$PK=PACS_API_KEY`)
| API | 용도 |
|---|---|
| `POST /v1/certificates/enroll` | 판독의 STAFF 인증서(1회·비멱등→serial 영속). 환자는 4의 자동발급 |
| `POST /v1/sign-requests` | 발급+서명요청 일괄(channel STAFF/PORTAL/DIRECT/PROXY) |
| `POST /v1/sign/staff` | 판독의 서명(Bearer staff-token) |
| `POST /v1/portal/:token/sign` | 환자 포털 서명 |
| `GET /v1/verify/:id` | 검증(overall·attestation·서명별 keyCustody) |
| `GET /v1/requests/:id/audit-certificate` | 감사추적인증서 PDF |
| `GET /v1/ocsp/:serial`·`/v1/crl` | 폐기 조회 |

## 6. 완료 수신 — webhook 또는 verify 폴링 (⚠️ PACS 핵심)
sign 전역 webhook 기본값은 HIS 수신처이므로, **PACS는 둘 중 하나**:
- **(A) per-request callbackUrl**: `sign-requests`에 `callbackUrl:"https://pacs 수신 URL"` 명시 → 그 요청 완료 webhook이 PACS로 발화. HMAC(`sign.webhookSecret`)·eventId 멱등 검증.
- **(B) verify 폴링**: callbackUrl 미지정 시, PACS가 `GET /v1/verify/:id`를 폴링해 `status==COMPLETED` 확인.
- webhook payload는 HIS와 동일(§5 HIS 가이드): `signCertSerial`·`signatures[].externalSignerRef`·`assuranceLevel`·`tsaToken`.

## 6-1. 판독의 중요 행위 인증 로그 (선택) — `POST /v1/audit-events`
판독 승인·재판독·영상 열람 등을 **블록체인(해시체인+TSA) 인증 로그**로 봉인(서명과 별개).
```bash
curl -XPOST $B/audit-events -H "x-api-key: $PK" -d '{"action":"REPORT_APPROVED","actor":"<판독의 ref>","actorRole":"DOCTOR","targetType":"STUDY","targetRef":"<검사ID>","stream":"pacs-events","anchor":true}'
# → { "data":{ "entryHash","prevHash","anchored" } }  (인증 영수증)
```
- `GET /v1/audit-events?stream=pacs-events` 조회 · `/verify` 무결성. 행위자+제출시스템 봉인. PHI 원본 금지.

## 7. attestation
- 봉인 트리거 = **`assuranceLevel=="HSM_ANCHORED"`**(verify·webhook). 현재 SOFT 운영=`SOFTWARE`, KMS cutover 후 자동 `HSM_ANCHORED`.
- `keyCustody`(서명키)는 설계상 SOFT — 봉인 트리거로 쓰지 말 것.

## 8. 발급 일원화 — PACS 역할
- PACS는 인증서를 발급하지 않음. 판독의 STAFF 인증서는 enroll-once(또는 HIS 공통 staff cert 재사용), 환자는 자동발급.
- 관리(목록/폐기/정지) UI는 **sign 콘솔**(`/admin/certificates-list`). PACS는 serial 미러(읽기전용). 폐기/중단 필요 시 API(`certificates:write`)로 요청 가능(actor 감사 봉인).

## 9. 멱등·오류
- 멱등: `issueNo` 재호출 시 동일 요청 반환.
- 오류: `{error:{code,message,requestId}}`. 401(키)·403(scope)·400(검증).
- webhook 실패 시 sign 재시도(최대 8회), DEAD 후 `/v1/maintenance/webhook-retry`.

## 10. 운영
- 전면교체 시 신규 CA → PACS는 판독의 serial 캐시 제거 후 재enroll. 절차: [`../06-ops/clean-reset-runbook.md`].
- 하드닝(go-live): callbackUrl https 강제·rate-limit. PII GET(`/requests/:id`)은 PACS 키로 호출.

## 11. 구현 체크리스트
- [ ] PACS_API_KEY·sign.url(내부)·sign.webhookSecret 주입
- [ ] 판독의 enroll-once → serial 영속·staff-token에 sign_cert_serial 매핑
- [ ] 보고서(A): channel STAFF + certSerial / 동의서(B): channel PORTAL + patientSigner
- [ ] **callbackUrl을 요청마다 PACS 수신 URL로 명시** (또는 verify 폴링)
- [ ] webhook 수신: HMAC·eventId 멱등·미러(externalSignerRef→serial)
- [ ] verify·audit-certificate 검증/증빙, assuranceLevel 봉인
- [ ] serial 미러만 유지(관리 UI는 sign 콘솔)

---
## 관련 문서
- 기준 원칙: [`hsm-single-custody-architecture.md`](./hsm-single-custody-architecture.md) · OpenAPI: [`openapi.json`](../openapi.json)
