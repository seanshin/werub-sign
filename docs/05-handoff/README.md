# 핸드오프 문서 인덱스 (HIS · PACS · 환자앱)

> sign ↔ HIS/PACS/환자앱 연동 문서. **대상별 읽기 순서**로 정리. 현재 기준 통합본 ⭐ / 변경이력 🔄.
>
> **현황(2026-06)**: **v1.2.0** 릴리즈 · sign 운영 라이브(`https://sign.example.org` / 내부 `http://127.0.0.1:4100/v1`) · go-live 하드닝 활성·인앱 스케줄러 가동.
> **EXTERNAL 양방향 라이브 + 전면교체 단일루트 재기준 완료.** 연동 설정 콘솔·운영 매뉴얼·API키 회전 UI·서버 페이지네이션·보안 보완 반영. 잔여 = KMS cutover(→HSM_ANCHORED) + 실 사업자 자격증명(PASS·알림톡 실 REST) + 실운영 cutover(P7/P8·H2).

---

## 🧩 공통 / 코어 (먼저 읽기)
| 문서 | 내용 |
|---|---|
| [`api-catalog.md`](./api-catalog.md) ⭐ | **API 카탈로그** — 인증 4경로·스코프·오류·webhook 계약 + 엔드포인트 전건 목록(스펙 자동 생성). 연동/SaaS 온보딩의 시작점 |
| `hsm-single-custody-architecture.md` ⭐ | **기준 원칙** — HSM은 sign 단독 연동(마스터키 단일 수탁) + 내부 서비스는 블록체인(해시체인+TSA) 기반 동작. HSM 문서 충돌 시 우선 |
| `../02-design/tamper-evidence-design.md` ⭐ | **위변조 방지 설계** — 인증서×블록체인(해시체인+TSA) 조화·시나리오 탐지 매트릭스·EMR인증 대응 |
| `certificate-issuance-authority.md` ⭐ | **발급 주체 정리** — HIS 블록체인 인증서 vs sign PKI 혼란 해소(sign 단독 발급·HIS는 미러), 환자/의료진 발급 시퀀스·충돌방지·필드매핑·FAQ |
| `his-issuance-delegation.md` ⭐ | **발급 일원화 지시** — HIS 자체 발급 폐지·sign 위임(요청 치환표)·전면교체(개발/시드 clean reset)·폐지 체크리스트 |
| `hospitalrun-integration-spec.md` | 코어 연동 명세 §1~13 — 스키마·시퀀스·점진전환(signProvider 토글) |
| `integration-decisions.md` ⭐ | **확정 결정** — #6 통합모델(병행 A우선+B), #7 비대면 본인확인(위험도별) |
| `approval-submission-contract.md` 🆕 | **전자결재(상신→결재) 연동 계약** — caller↔sign 상신/결재/step-up/완료 webhook/통합 인증로그·PHI 경계(해시만)·수용기준·현재 콘솔전용 vs P3.1 기계키·SSO 결재 델타. 피처플래그 `ELECTRONIC_APPROVAL` 기본 OFF |

## 🏥 HIS (전자동의서)
**읽기 순서**: ① delivery-summary → ② decisions → ③ sso-answers → ④ updates-delta → (배경) spec·action-items·portal
| 문서 | 내용 | |
|---|---|:--:|
| `his-integration-guide.md` ⭐ | **통합 가이드(시작점)** — 동의서 구현 전과정: 설정·인증·API·webhook·검증·운영·체크리스트 | ⭐ |
| `his-delivery-summary.md` | 엔드포인트·시크릿·작업 요약 | ⭐ |
| `sign-to-his-answers.md` | 판독의 SSO 합의 5건 회신(aud·바인딩·해시·step-up·STAFF발급) | ⭐ |
| `his-updates-delta.md` | 직전 이후 신규(webhook 보강/재시도·facade·PROXY·ops) | 🔄 |
| `his-supersede-delta.md` | **문서 개정 재동의(C-2) 델타** — 신규 `request.superseded` webhook 처리(필수)·facade `supersedesRequestId`(선택)·결정 2건 | 🔄 |
| `sign-to-his-multisig-portalurl-relay.md` ✅ | **다자 봉투 per-signer portalUrl relay** — Track 1 relay(externalSignerRef 키). **HIS PR #117 배포로 해결**. 잔여=3자 합동 E2E 시 STAFF sub↔externalSignerRef 정합 확인 | ✅ |
| `sign-to-his-hsm-answers.md` | **HSM 키 수탁 회신** — R1~R5(HSM 지원)·A1~A3(keyCustody/attestation/tsaToken 구현)·G-1 조달의견 | ⭐ |
| `his-pkcs11-complete.md` | **온프레 PKCS#11 구현완료 통지** — 조달 게이트(G-1) sign측 해소, HIS 결정사항·전환 주의 | 🔄 |
| `sign-to-his-kms-confirm.md` | **AWS KMS 결정 수용 회신** — keyCustody/assuranceLevel 합의(정정: 말단 SOFT·CA HSM_ANCHORED)·attestation 동봉·KMS-CA live 신호 | ⭐ |
| `sign-to-his-external-e2e-answers.md` | **풀전환 e2e 회신 4건** — sign-requests/enroll 계약·webhook 직원식별자(externalSignerRef)·시크릿 주입값 | ⭐ |
| `his-action-items.md` | P0 액션 아이템(스키마·토글·시크릿) | |
| `patient-portal-integration.md` | 환자 포털·발송·본인인증 부속 명세 | |
| `emr-security-his-checklist.md` ⭐ | **EMR 인증 보안성 — HIS 분담 항목 증빙 체크리스트**(F001~F012 책임분담·HIS 액션·sign 분담 증빙) | |

## 👤 환자앱 (HIS 환자앱팀)
| 문서 | 내용 |
|---|---|
| `patient-app-fr14-15-handoff.md` ⭐ | FR-14/15 통합채널·등록인증→인증서·고위험 step-up·태블릿 fallback·**대리(PROXY) 서명** |

## 🩻 PACS (판독보고서 서명 + 영상 동의서)
**읽기 순서**: ① pacs-integration → ② sign-to-pacs-answers(curl) → ③ pacs-updates-delta
| 문서 | 내용 | |
|---|---|:--:|
| `pacs-integration-guide.md` ⭐ | **통합 가이드(시작점)** — 보고서(A)·동의서(B) 구현 전과정: 설정·API·webhook(callbackUrl 주의)·검증·체크리스트 | ⭐ |
| `pacs-integration.md` | 유스케이스 A(보고서)·B(동의서) 명세 | ⭐ |
| `sign-to-pacs-answers.md` | 질문 회신 + **검증된 curl 7종** | ⭐ |
| `pacs-updates-delta.md` | 직전 이후 신규(facade·A-서버 토큰·PROXY·ops) | 🔄 |
| `sign-to-pacs-attestation-answers.md` | **회신 4건** — assuranceLevel(verify 포함·HSM_ANCHORED 조건)·테스트토큰·전환영향·facade curl | ⭐ |
| `pacs-auth-handoff.md` | **인증 연동 전달본** — 기계(api-key)·판독의(SSO)·환자(포털) 3종 인증 + enroll·attestation·webhook·하드닝 | ⭐ |

## 🏢 ERP (hospital-erp)
**읽기 순서**: ① erp-track-a-handoff(확정) → (배경) erp-integration(요청서 초안·트랙 B 보류)
| 문서 | 내용 | |
|---|---|:--:|
| `erp-track-a-handoff.md` ⭐ | **트랙 A 확정 핸드오프** — 외부 거래처 계약 서명: enroll(WITNESS)·requests(PORTAL·NONE)·portal-tokens·webhook(ERP_WEBHOOK_SECRET 격리) 정확 스키마·수용기준 E2E·D8 회신 | ⭐ |
| `sign-to-erp-esign6-answers.md` ⭐ | **e-sign #6 다자 봉투 클로즈아웃 회신** — signers[] 8개 질의 코드 확정 답변(혼합 PORTAL+STAFF·NONE·per-signer certSerial/portalUrl·완료 echo) + 잔여 4건(합동E2E·COMPLETED·KMS cutover·P8) | ⭐ |
| `erp-integration.md` | ERP 연동 요청서(초안) — 트랙 A·B 개요·결정 체크리스트 D1~D8(트랙 B 인사 마스터는 보류) | 🔄 |

## 🚦 파일럿 (양팀 공동)
| 문서 | 내용 |
|---|---|
| `p1-pilot-checklist.md` ⭐ | 동의서 1종 EXTERNAL 전환 — 게이트·사전준비(P7 DB리셋·P8 시크릿회전)·E2E·수용기준 |

## ⚙️ 운영
| 문서 | 내용 |
|---|---|
| `../06-ops/operations-guide.md` | 배포·키 커스터디·mTLS·HSM(KMS)·go-live 체크리스트(§6.1 보안 보류항목) |

---

## 🎓 edu (교육 이수증 발급)
| 문서 | 내용 |
|---|---|
| `edu-store-persistence-reply.md` ⭐ | **저장소 영속화 요청(P0) 조사 회신** — 스토어는 PG 영속(오진), 실원인=edu 자가 폐기, 복구 절차(신규 enroll·시리얼 교체·폐기 allow-list)·멱등 보장 확인 |
| `edu-webhook-dead-notice.md` | **완료 webhook 26건 DEAD 통지(2026-07-28)** — edu 수신 URL 404, 실측 근거·확인 요청·미수신분 복구 옵션 A/B/C |
| `werub-integration-requests-2026-07-reply.md` ⭐ | **weRub 연동 요청 R1~R5 회신(v1.18.0 반영)** — 중간 서명 웹훅·완료 웹훅 verifyToken·경량 상태 EP·수신처 정정·계약 철회 별칭 스펙 |

---

## 📘 API 명세 (OpenAPI)
- 기계가독 명세: [`../openapi.json`](../openapi.json) (139 paths·DTO 스키마, v1.22.0) — `npm run swagger:export`로 갱신. 전자계약(서식·검증 QR·주소록·카테고리·첨부·프리셋·fill-at-signing·상태 조회·수신처 정정·철회·교부 셀프서비스)·webhook 재발송·전자결재·문서 인증·소비자 등록 포함.
- Swagger UI(`/api-docs`): **운영 공개 노출 금지** — 비-prod 자동 ON, 운영 기본 OFF(`SWAGGER_ENABLED`). 통합팀은 openapi.json import 사용.

## 핵심 합의값 (빠른 참조)
- **엔드포인트**: 내부(서버↔서버) `http://127.0.0.1:4100/v1` · 공개(환자 브라우저) `https://sign.example.org`
- **본인확인 레벨(#7)**: 일반=`PASS`(보유CI) / 고위험(수술·마취·DNR)=`APP_STEPUP` / 대면=`INPERSON` / 의료진=`STAFF_SSO`
- **SSO**: JWKS `his.example.org/api/v1/sign-integration/jwks`, iss=`hospitalrun`, **aud=`sign`(강제)**, sub=externalSignerRef
- **해시**: documentHash = 최종 PDF 바이트 SHA-256 **hex 64자**
- **단일호출 facade**: `POST /v1/sign-requests`(channel DIRECT/PORTAL/STAFF/PROXY)
- **Webhook**: eventId 멱등 · 타입 `request.completed|withdrawn|expired` · 재시도 `/v1/maintenance/webhook-retry`
