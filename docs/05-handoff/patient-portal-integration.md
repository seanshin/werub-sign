# [HIS팀 전달] 환자 포털 · 발송 · 본인인증 연동 (부속 명세)

> 본 문서는 `hospitalrun-integration-spec.md`(코어 연동 §1~13)의 **부속**이다.
> sign에 추가된 **환자 접점**(본인인증 분리·환자 서명 웹플로우·발송·철회/만료·프론트 SPA)의
> HIS 연동 방법과 양측 결정사항을 정리한다. 코어(인증서 발급·서명요청·STAFF SSO·Webhook)는 기존 명세 유지.

---

## 0. 배경 — 무엇이 추가됐나

| 추가 | 설명 | sign측 상태 |
|---|---|---|
| 환자 본인인증 분리(IDV) | PASS/명의를 `idv-proxy`로 분리. 개발=mock, 운영=사업자 드롭인 | 흐름 완성, 자격증명 대기 |
| 환자 서명 웹플로우 | 토큰 링크로 비로그인 환자가 열람→본인확인→서명 | 완성(API+SPA) |
| 발송(Notifier) | 알림톡/SMS로 서명 링크 전송 | 흐름 완성, 사업자 드롭인 |
| 동의 철회·기한 만료 | 철회 API + 만료 배치 | 완성 |
| 프론트엔드 SPA | 환자 포털 + 관리자 콘솔(Next.js, `web/`) | 빌드 통과 |

**분담 원칙(유지)**: HIS 환자앱이 **주 채널**, sign 포털은 **원외/앱미사용 fallback**.

---

## 1. 통합 모델 — HIS가 택1 (또는 병행)

### 모델 A. HIS 앱이 직접 서명 (기존 분담, 권장 기본)
- 환자는 HIS Expo 앱에서 동의서를 보고 서명. HIS 앱이 sign 서명 API를 직접 호출.
- 호출: `POST /v1/sign/:participantId/submit { identity }` (코어 명세 §6).
- sign 포털·발송 미사용. 본인확인 정보(ci/phone)는 HIS 앱이 수집해 전달하거나, 앱 등록 시 확보한 CI 재사용.

### 모델 B. sign 포털 deep-link (원외 비대면 fallback)
- HIS가 서명요청 생성 후 **포털 토큰**을 발급받아, 환자에게 **서명 링크**를 발송.
- 환자는 sign이 호스팅하는 포털(`/portal/:token`)에서 열람→본인확인→서명.
- 외래/비대면, 앱 미설치 환자에 적합.

> 두 모델은 **동일 SignatureRequest 봉투**를 공유한다(채널 무관 signOrder 게이팅). 환자=앱, 의료진=SSO처럼 혼합 가능.

---

## 2. 신규 엔드포인트 (코어 명세 이후 추가분)

base = sign 서비스 URL. 관리자/HIS-facing은 `x-api-key`(ConsumerApp) 필요, 포털은 공개.

| 메서드 | 경로 | 인증 | 용도 |
|---|---|---|---|
| POST | `/v1/requests/:id/portal-tokens` | x-api-key (requests:write) | 미서명 참가자별 일회용 서명 토큰 발급 → `[{participantId,signerRole,token,url}]` |
| POST | `/v1/requests/:id/notify` | x-api-key | 참가자별 서명 링크 발송 `{ baseUrl, recipients:[{participantId,to,channel}] }` |
| POST | `/v1/requests/:id/withdraw` | x-api-key | 동의 철회 `{ reason }` → status WITHDRAWN, 이후 서명 차단 + Webhook |
| POST | `/v1/maintenance/expire` | x-api-key | 기한 경과 미완료 요청 EXPIRED 처리(크론 호출) |
| GET | `/v1/requests` | x-api-key | 요청 목록(관리자 콘솔용) |
| GET | `/v1/portal/:token` | 공개 | 환자 열람용 동의서 정보(최소 투영) |
| POST | `/v1/portal/:token/sign` | 공개(토큰=컨텍스트) | 환자 서명 `{ identity:{method,ci?,phone?,name?} }` |

`POST /v1/requests` 에 `ttlDays`(미서명 만료 기한, 기본 30일) 옵션 추가됨.

---

## 3. 환자 본인인증 (IDV) — HIS는 PASS를 직접 안 해도 됨

- sign이 `idv-proxy`(DMZ)로 PASS/명의를 **분리 중계**. HIS는 본인인증 사업자 연동 불요.
- **대면**(`requiredIdentityLevel=INPERSON`): 외부 식별자 불요(method=INPERSON).
- **비대면**(`PASS`/`MOBILE_NAME`): `ci` 또는 `phone` 필요.
  - 모델 A: HIS 앱이 수집/보유한 값을 submit 시 전달.
  - 모델 B: 환자가 포털 폼에 입력(또는 향후 포털에서 PASS 표준창 직접 호출 — 사업자 연동 후).
- 본인확인 결과는 **서명에 강결합**(StoredSignature.identityVerificationId/Method) — 정보 없으면 403.
- 식별자(CI/전화)는 **HMAC 해시로만 저장**(평문 금지).

> HIS 결정 필요: 비대면 환자의 ci/phone 출처(HIS 보유 CI 재사용 vs 포털 입력 vs PASS 표준창).

---

## 4. 발송 (Notifier) — 링크 전송

- `POST /v1/requests/:id/notify { baseUrl, recipients:[{participantId, to, channel}] }`
  - `baseUrl`: 환자 포털 공개 도메인(예: `https://sign.<hospital>.kr`). `url`은 `baseUrl + /portal/:token`.
  - `to`: 수신 번호. **sign은 번호를 저장하지 않음**(발송 시 1회 사용) — HIS가 제공.
  - `channel`: `ALIMTALK`(기본) 또는 `SMS`.
- 운영: `NOTIFIER_PROVIDER=kakao|sms` + 사업자 자격증명. 개발은 `mock`.

> HIS 결정 필요: 알림톡/SMS **사업자 계약 주체**(sign측 발송 vs HIS측 발송 후 링크만 수신). HIS가 이미 발송 인프라 보유 시, sign은 `portal-tokens`만 발급하고 발송은 HIS가 수행해도 됨.

---

## 5. 철회 / 만료

- **철회**: `POST /v1/requests/:id/withdraw { reason }`. HIS가 동의 취소 시 호출 → 이후 서명 차단, `request.withdrawn` Webhook 통지.
- **만료**: 요청 생성 시 `ttlDays`(기본 30일). 기한 경과 시 자동 차단(지연 만료) + 배치 `POST /v1/maintenance/expire`(크론/HIS 스케줄러 주기 호출) → `request.expired` Webhook.
- Webhook 이벤트 추가: `request.withdrawn`, `request.expired` (기존 `request.completed`와 동일 HMAC 서명·eventId 멱등 — §8 방식).

> HIS 결정 필요: 만료 배치 호출 주체(sign 크론 vs HIS 스케줄러). Webhook 신규 이벤트 2종 수신 처리(ConsentForm 상태 반영).

---

## 6. 프론트엔드 SPA (`web/`) — 호스팅·배포

sign 저장소 `web/`에 Next.js SPA(환자 포털 + 관리자 콘솔) 포함.

- **환자 포털** `/portal/[token]`: 모델 B 환자 fallback 화면.
- **관리자 콘솔** `/admin`: 발급·요청·검증·발송·철회·운영(원내 운영자용).
- 설정: `NEXT_PUBLIC_SIGN_API_URL`(sign API base). 빌드 `npm run build`(정적+동적 라우트).
- 배포 옵션: 원내 정적 호스팅 / 컨테이너. 환자 포털은 **DMZ reverse-proxy 경유 공개**(외래 접근), 관리자 콘솔은 **원내망 한정**.
- **CORS**: sign 백엔드 `CORS_ORIGINS`에 프론트 도메인 화이트리스트.

> HIS 결정 필요: ① 환자 포털을 **sign이 호스팅**할지(권장, 모델 B) vs HIS 앱만 쓸지(모델 A). ② 관리자 콘솔 사용 주체(병원 행정/원무).

---

## 7. 보안 요점

- 포털 토큰: **일회용 + 만료(기본 48h)**. 순서 게이팅·단일사용·만료 적용.
- 환자 포털은 DMZ 공개, sign-core·관리자 콘솔·crypto-proxy·idv-proxy는 **원내/사설망**.
- 전 구간 TLS, HIS↔sign·sign-core↔proxy는 mTLS(ops 가이드 §2). CORS 화이트리스트.
- 식별자(CI/전화/수신번호) 평문 미저장·로그 마스킹.

---

## 8. HIS 결정·작업 체크리스트

- [ ] 통합 모델 선택: A(HIS 앱 직접) / B(sign 포털 deep-link) / 병행
- [ ] 비대면 본인확인 ci/phone 출처 합의(§3)
- [ ] 발송 주체·사업자 합의(§4) — sign 발송 vs HIS 발송 + 토큰만 발급
- [ ] 만료 배치 호출 주체(§5)
- [ ] Webhook 신규 이벤트 수신: `request.withdrawn`, `request.expired`(§5)
- [ ] 환자 포털 호스팅·도메인·CORS 화이트리스트(§6)
- [ ] 관리자 콘솔 사용 주체·접근통제(원내망)
- [ ] (운영) 본인인증·알림톡 사업자 자격증명 조달 → sign에 주입

---

## 9. 참고 (sign측 산출물)

- 코어 명세: `docs/05-handoff/hospitalrun-integration-spec.md` (§1~13)
- 액션 아이템: `docs/05-handoff/his-action-items.md` · 파일럿: `p1-pilot-checklist.md`
- 운영(키 커스터디·mTLS·HSM): `docs/06-ops/operations-guide.md`
- 프론트: `web/README.md`
- 검증 하니스: `test/integration-his.e2e.mjs`(코어), `test/increment14~16.e2e.mjs`(본인인증·포털·발송/철회)
