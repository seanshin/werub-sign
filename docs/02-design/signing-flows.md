# sign 서명·연동 흐름 (통합 레퍼런스)

최종 갱신: 2026-06-28 · 라이브: `https://sign.example.org` (내부 `sign-core:4000` / `127.0.0.1:4100`)

> 전 서명·연동 흐름의 단일 참조. 정확한 요청/응답 스키마는 `docs/05-handoff/`(팀별)·`docs/openapi.json` 참조.

---

## 0. 공통 트러스트 흐름 (모든 채널 공통)

```
인증서 발급(enroll) → 서명요청 생성(request) → [본인확인] 서명(sign) → 검증(verify) → 완료 webhook → 감사(audit)
```
- **키 수탁**: sign이 키쌍 생성·개인키 수탁(호출자 publicKey 불요). CA 앵커=HSM(go-live), 말단·TSA=SOFT.
- **서명 포맷**: CMS(CAdES-BES) + PAdES-LTA(LTV) — 인증서 만료 후에도 검증 유효.
- **무결성**: 감사 해시체인 + TSA 앵커(완료 시 head 봉인) → 위변조 탐지.
- **인증 경계**: 기계=`x-api-key`(소비자별 scope) / 의료진=HIS SSO(JWKS, `iss=hospitalrun`·`aud=sign`) / 환자·외부=포털 1회용 토큰 / 관리자=RBAC 세션 토큰.

---

## 1. HIS 동의서 (EXTERNAL 모드)

```
HIS ──POST /v1/sign-requests(facade, x-api-key=hospitalrun)──▶ sign
       {documentType, documentHash, channel:DIRECT|PORTAL|STAFF, issueNo, requiredIdentityLevel, ...}
   ◀── {signatureRequestId, participantId, portalUrl?}
환자(앱/포털) 또는 의료진(SSO) 서명 ──▶ sign
   완료 시 ──webhook request.completed(HMAC=HIS_WEBHOOK_SECRET)──▶ HIS → ConsentForm 미러
```
- **채널**: DIRECT(앱 직접 키 submit) · PORTAL(deep-link) · STAFF(의료진 SSO `/v1/sign/staff`).
- **본인확인**: 일반=PASS(HIS 보유 CI 전달) · 고위험(SURGERY/ANESTHESIA/DNR)=APP_STEPUP(서명직전 재인증) · 대면=INPERSON · 의료진=STAFF_SSO.
- **개정 재동의**: facade `supersedesRequestId` → 원본 `SUPERSEDED`·새 버전. `request.superseded` webhook(§6).
- 상세: `docs/05-handoff/hospitalrun-integration-spec.md`·`his-integration-guide.md`.

---

## 2. PACS (판독보고서 + 영상 동의서)

- **A. 판독보고서 서명(의료진 STAFF/SSO)**: OpenPACS 백엔드가 staff-token(aud=sign) 받아 `127.0.0.1:4100/v1/sign/staff`(Bearer) 호출. 해시=최종 PDF SHA-256 hex.
- **B. 영상·조영제 동의서(환자 PORTAL)**: 기존 포털/IDV 재사용.
- **완료 통지**: 폴링(`GET /v1/verify/:id`) — webhook 미사용.
- 판독의 SSO=병원 공통 JWKS(단일). 상세: `docs/05-handoff/pacs-integration-guide.md`·`sign-to-pacs-answers.md`.

---

## 3. ERP 외부 거래처 계약 (트랙 A)

### 3.1 단독 VENDOR (라이브 가동)
```
ERP(infra-*, docker_default) ──http://sign-core:4000/v1, x-api-key=erp──▶ sign
  1) POST /certificates/enroll {ownerType:WITNESS, subjectDn}          → serialNumber (1일 단기, 서명은 LTV로 영구검증)
  2) POST /requests {signMode:PORTAL, requiredIdentityLevel:NONE, callbackUrl, participants:[WITNESS_EXTERNAL]}
  3) POST /requests/:id/portal-tokens                                   → {url:/portal/<token>}
  4) ERP가 deep-link 이메일/문자 발송 ──▶ 거래처
거래처 포털 서명(동의) ──▶ sign
  완료 ──webhook request.completed(HMAC=ERP_WEBHOOK_SECRET)──▶ https://his.example.org/erp/... → OutsourcingContract 미러
```
- **본인확인**: `NONE`(deep-link 토큰 possession + 동의). 실서비스 전 PASS 생략(`identityDemo`).
- **망**: sign-core가 `docker_default` 합류 → ERP 컨테이너가 서비스DNS `sign-core:4000` 호출(inbound). webhook은 HIS nginx 공개 split(outbound). 둘 다 공개 노출 0.
- **webhook 시크릿**: `ERP_WEBHOOK_SECRET`(HIS와 격리).

### 3.2 다중봉투 다자 계약 (구현·검증 완료, ERP 도입 대기)
```
POST /v1/sign-requests { documentType:ERP_*, externalDocId:"erpcontract:medical:<id>",
  signers:[ {signerType,channel:STAFF|PORTAL|DIRECT,signOrder,externalSignerRef,requiredIdentityLevel,certSerial?}, ... ] }
→ { signatureRequestId, signers:[{participantId,signOrder,channel,portalUrl?}, ...] }
```
- 순차(`signOrder`) 게이팅(채널 무관), 신규입사 의료진(HIS 미등록)=`channel:PORTAL`+자동 임시 인증서.
- 전 봉투 완료 시 **단일** `request.completed`(signatures[] echo).
- 상세: `docs/05-handoff/erp-track-a-handoff.md`(§2.5b).

---

## 4. 포털 서명 흐름 (환자·외부 공통)

```
GET /portal/<token>(web SPA) → 열람 → [본인확인 단계] → POST /v1/portal/<token>/sign → 완료
```
- **본인확인 단계(requiredIdentityLevel별)**:
  - `NONE` → identity 미전송(동의만)
  - `INPERSON` → 대면 안내 → 서명
  - `PASS`/`APP_STEPUP` → method=PASS + CI (실서비스 전 `identityDemo`면 생략 가능 — `DEMO-SKIP`)
  - `MOBILE_NAME` → 이름+CI/전화
  - `STAFF_SSO` → 포털 아닌 `/v1/sign/staff`(SSO)
- **identityDemo**: 백엔드 idv provider=`mock`이면 true → 포털이 본인확인 생략 허용. 실 사업자(`IDV_PROVIDER=pass`) 설정 시 자동 false → 실 본인확인 요구.
- 토큰=1회용·48h 만료·순차 게이팅. ⚠️ web SPA가 레벨을 method로 보내지 않도록 매핑 주의(2026-06-28 회귀 수정).

---

## 5. 문서 개정 재동의 (supersede, C-2)

```
POST /v1/requests/:id/supersede {documentHash(개정), idempotencyKey, ...}  (또는 facade supersedesRequestId)
→ 원본 status=SUPERSEDED·supersededBy=신규 / 신규 supersedes=원본·version+1 (참가자 재사용)
→ 원본에 webhook request.superseded(supersededBy) → HIS가 ConsentForm 현행아님 처리(PR#102)
```
- 원본 기존 서명·LTV·감사 보존(검증 가능), 새 서명만 차단. 다단계 개정(v1→v2→v3) 지원·멱등.

---

## 6. Webhook 이벤트·시크릿

- **이벤트**: `request.completed`·`request.withdrawn`·`request.expired`·`request.superseded`(supersededBy).
- **서명**: `X-Sign-Signature: HMAC-SHA256(rawBody, <소비자 시크릿>)`. 바디=`{...payload, eventId, eventType}`. `eventId` 멱등.
- **소비자별 시크릿 격리**: `erp`→`ERP_WEBHOOK_SECRET` / 그 외(hospitalrun·console·pacs)→`HIS_WEBHOOK_SECRET`. (한 소비자가 타 소비자 webhook 위조 불가)
- **재시도**: 실패 시 outbox 재시도(최대 8회·DEAD). `GET /v1/requests/:id/webhooks`로 reconcile. 인앱 스케줄러가 주기 재시도.
- **completed payload**: `signatureRequestId·externalDocId·status·verifiedHash·signCertSerial(s)·auditCertUri·keyCustody·assuranceLevel·signatures[]{externalSignerRef,certSerial,signedAt,tsaToken,...}`.

---

## 7. 인증서 수명주기

```
enroll(PATIENT/STAFF/WITNESS/PROXY) → [SUSPENDED↔ACTIVE(가역)] → REVOKED(영구)/EXPIRED
```
- 발급=`POST /v1/certificates/enroll` · 폐기/중단/재개=`POST /:serial/{revoke,suspend,resume}` · 목록=`GET /v1/certificates?q=&status=`.
- 폐기·중단=**향후 서명만 차단**(과거 서명 LTV 유효). OCSP/CRL 공개 검증. 행위자 감사(CERT_ISSUED/REVOKED/SUSPENDED).
- 콘솔: `/admin/certificates-list`(검색·인라인 관리).

---

## 8. 콘솔 인증 (C-4 RBAC)

- **사람(관리자)**: `/admin/login` 로컬 계정(ID/PW, scrypt) → 세션 토큰(`x-session-token`, HMAC·만료). 역할 admin/operator/viewer → 메뉴·스코프 자동 제어.
- **기계(HIS/PACS/ERP)**: `x-api-key`(소비자별 scope). **불변** — 가드는 세션 우선, Bearer는 검증되면 세션·아니면 x-api-key 폴백.
- **break-glass**: `CONSOLE_API_KEY`(계정 장애 시), `SIGN_ADMIN_API_KEY`(ca:admin·users:admin).
- 모든 로그인/관리 행위 감사(`admin:auth`·`admin:users`, actor=`user:<id>`).

---

## 9. 망·배포 토폴로지 (운영)

```
[공개] Cloudflare → nginx(sign.example.org) → sign-web(SPA) / sign-core(/v1·/health)
[내부] sign-core(컨테이너: sign_default + docker_default) ── postgres(sign-postgres) · crypto-proxy(사설) · idv-proxy(사설)
[연동] HIS/PACS(호스트 127.0.0.1) · ERP(docker_default infra-*) → sign-core:4000 (내부) / sign→HIS·ERP webhook(공개 https)
```
- sign-core 포트: 호스트 `127.0.0.1:4100`(nginx 경유) + 내부 컨테이너 `4000`(docker_default 소비자용). DB 호스트=고유 `sign-postgres`(별칭 충돌 방지).
- 상세 배포: `docs/06-ops/operations-guide.md §0`.

---

## 관련 문서
- go-live: `docs/06-ops/go-live-runbook.md` · P7: `clean-reset-runbook.md` · 운영: `operations-guide.md`
- 팀 핸드오프: `docs/05-handoff/`(HIS·PACS·ERP·환자앱) · 위변조설계: `docs/02-design/tamper-evidence-design.md`
- API: `docs/openapi.json`(52 paths)
