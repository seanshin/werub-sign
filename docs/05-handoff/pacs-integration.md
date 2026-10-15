# [PACS팀 전달] PACS ↔ sign 전자서명 연동 명세

> openpacs(PACS)가 sign 트러스트 서비스를 사용해 ①**영상 판독보고서 서명**(판독의=의료진)
> ②**영상·조영제 동의서**(환자) 를 전자서명·검증한다. 코어 개념은 HIS 명세
> (`hospitalrun-integration-spec.md`)와 동일하며, PACS 관점만 정리한다.

---

## 0. 구성 상태 (현재)

| 항목 | 상태 |
|---|---|
| 네트워크 도달 | ✅ PACS(host-net) → `http://127.0.0.1:4100/v1` 도달 확인 |
| PACS 전용 인증키 | ✅ `PACS_API_KEY`(ConsumerApp `pacs`, scope `requests:write`·`certificates:write`) |
| 의료진(판독의) SSO | ♻️ **병원 공통 SSO(JWKS) 재사용** — `/v1/sign/staff` Bearer 검증 |
| 환자 서명 흐름 | ✅ 포털 토큰 + 본인확인(PASS) + 서명 (HIS와 동일 인프라) |

- **내부 호출 엔드포인트**: `http://127.0.0.1:4100`(원내 직접 — 권장). 외부 `https://sign.example.org`는 환자 브라우저용(내부 서버→서버 호출엔 부적합, Cloudflare 헤어핀).
- 헤더: `x-api-key: <PACS_API_KEY>` (서버 `.env.prod`의 값).

---

## 1. 유스케이스 A — 영상 판독보고서 서명 (판독의 = STAFF)

판독 확정 시 보고서 PDF에 판독의가 전자서명(sign-off).

```
1) (최초 1회) 판독의 인증서 발급
   POST /v1/certificates/enroll
   { "ownerType":"STAFF", "subjectDn":"CN=홍길동,O=영상의학과",
     "ownerRef":"<직원ID>", "licenseNumber":"<면허번호>", "identity":{"method":"STAFF_SSO"} }
   → { data:{ serialNumber } }   # PACS가 직원↔serial 매핑 보관

2) 서명요청 생성 (보고서 1건)
   POST /v1/requests
   { "idempotencyKey":"report-<studyUID>", "externalDocId":"<studyUID/reportId>",
     "title":"판독보고서 <검사명>", "documentHash":"<보고서PDF SHA-256 hex>",
     "signMode":"PORTAL",
     "participants":[{ "signerRole":"RADIOLOGIST","signerType":"STAFF","displayName":"홍길동",
       "signOrder":1,"certSerial":"<위 serial>","requiredIdentityLevel":"STAFF_SSO" }] }
   → { data:{ requestId, participants:[{ participantId }] } }

3) 판독의 서명 (병원 SSO 토큰으로)
   POST /v1/sign/staff
   Authorization: Bearer <병원 SSO JWT(판독의)>
   { "participantId":"<participantId>" }
   → 서명 완료. STAFF는 반드시 이 경로(SSO)로만 서명 가능.

4) 검증/증거
   GET /v1/verify/<requestId>           # overall·CMS·LTV·체인
   GET /v1/requests/<requestId>/audit-certificate   # 감사추적 PDF
```

> 판독의 SSO 토큰은 **병원 공통 SSO(현 `HIS_SSO_JWKS_URL`)** 로 검증한다. PACS가 별도 IdP를
> 쓴다면 sign에 다중 JWKS(issuer별) 지원 추가 필요(현재 단일 issuer) — 협의 항목.

---

## 2. 유스케이스 B — 영상·조영제 동의서 (환자)

조영제 투여·시술 전 환자 동의. HIS 동의서와 동일 패턴.

```
1) 환자 인증서 발급 (없으면)
   POST /v1/certificates/enroll
   { "ownerType":"PATIENT","subjectDn":"CN=<환자>","identity":{"method":"PASS","ci":"<CI>"} }

2) 서명요청 생성
   POST /v1/requests
   { ..., "title":"조영제 사용 동의서", "documentHash":"<동의서 SHA-256>",
     "signMode":"APP",
     "participants":[{ "signerRole":"PATIENT","signerType":"PATIENT","displayName":"<환자>",
       "signOrder":1,"certSerial":"<serial>","requiredIdentityLevel":"PASS" }] }

3) 서명 링크 발급 → 환자에게 안내
   POST /v1/requests/<id>/portal-tokens   → { data:[{ url:"/portal/<token>" }] }
   (또는 POST /v1/requests/<id>/notify 로 알림톡/SMS 발송)
   환자: https://sign.example.org/portal/<token> 에서 열람→본인확인(PASS)→서명

4) 검증/철회/만료: HIS와 동일 (GET /v1/verify, POST .../withdraw, POST /v1/maintenance/expire)
```

---

## 3. PACS팀 작업 체크리스트

- [ ] `PACS_API_KEY` 수령(서버 `.env.prod`) → PACS 설정에 주입, 호출 시 `x-api-key`
- [ ] 내부 엔드포인트 `http://127.0.0.1:4100/v1` 사용(외부 도메인 아님)
- [ ] 보고서/동의서 **원본은 PACS 보관**, sign에는 **SHA-256 해시만** 전송(원본 미전송)
- [ ] 판독의 서명: 병원 SSO JWT를 `/v1/sign/staff`로 — 별도 IdP면 다중 JWKS 협의
- [ ] (선택) 완료 Webhook 수신: `request.completed` 등 `callbackUrl` 설정 시
- [ ] 환자 동의: 발송 채널(알림톡/SMS) 또는 태블릿 fallback 결정

---

## 4. 참고
- 코어/공통: `hospitalrun-integration-spec.md`, `patient-portal-integration.md`
- 운영: `docs/06-ops/operations-guide.md` · 키 회전: ConsumerApp 무중단 회전
- PACS 키는 `pacs` ConsumerApp(독립). HIS·콘솔 키와 분리되어 독립 회전·감사.
