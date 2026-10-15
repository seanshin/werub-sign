# sign ↔ Hospital RUN 관계 정의 (Integration Definition)

> **Feature**: 의료-전자동의서-플랫폼
> **Date**: 2026-06-12
> **목적**: 독립 서명 서비스(sign)와 기존 자체개발 HIS(Hospital RUN)의 관계·경계·연동을 단일 정의

---

## 1. 관계 유형 — Provider · Consumer (느슨한 결합)

```
┌─────────────────────────────┐        계약(API/Webhook/SSO)        ┌──────────────────────────────┐
│  Hospital RUN (HIS)          │  ───────── 서명요청/검증 ────────▶ │  sign (전자서명 트러스트 서비스) │
│  = 업무 시스템 of record      │  ◀──────── 서명완료 Webhook ───────│  = 서명·무결성·인증서·증거       │
│  동의서 콘텐츠·환자·임상·UI    │                                   │  PKI·TSA·감사추적·검증센터      │
└─────────────────────────────┘                                    └──────────────────────────────┘
        (Consumer)                                                          (Provider)
```

- **sign** = 전자서명 **트러스트 서비스 제공자**. 서명의 생성·무결성·법적 증거·인증서를 책임. HIS에 **비종속**(타 시스템도 Consumer 가능 → 플랫폼화 FR-11).
- **Hospital RUN** = 동의서 업무의 **시스템 오브 레코드**. 콘텐츠·환자·임상·채널·UI를 소유하고 sign을 **호출**.
- 두 서비스는 **각자 독립 배포·독립 DB**, 계약(contract)으로만 결합. 한쪽 내부 변경이 다른 쪽에 전파되지 않음.

---

## 2. 책임 경계 (소유권)

| 영역 | sign (Provider) | Hospital RUN (Consumer) |
|---|---|---|
| 동의서 콘텐츠·템플릿·버전 | — | ✅ `ConsentForm` / `ConsentTemplate` |
| 환자·직원 계정·임상데이터 | 참조만(`externalRef`) | ✅ 소유(Patient/User/Encounter) |
| 서명 업무흐름·UI·채널 | 서명 웹뷰(무결성 처리) | ✅ 환자앱·의료진포털·워크스테이션·태블릿 |
| PKI 키·인증서(환자/STAFF/외부입회) | ✅ CA·KeyMaterial·Certificate | — |
| 서명 생성/검증/TSA | ✅ | — (호출만) |
| 감사추적(서명 무결성) | ✅ AuditTrail(해시체인)·AuditCertificate | 임상 감사는 자체(audit-enhanced) |
| 본인인증 기록 | ✅ IdentityVerification | 인증 수단 제공(앱/SSO) |
| 데이터 소유 정본 | 서명·인증서·타임스탬프·서명원본 해시 | 동의서 본문·환자정보 |

**원칙**: 키·서명원본·민감정보는 sign(원내) 보관, 임상·환자정보는 HIS 보관. 서로의 정본을 침범하지 않음.

---

## 3. 연동 인터페이스 (4 채널)

| # | 방향 | 채널 | 인증 | 용도 |
|---|------|------|------|------|
| ① | HIS → sign | REST `POST /v1/requests`, `/v1/certificates/enroll`, `GET /v1/verify` | API Key + **mTLS** | 서명요청 생성·인증서 발급·검증 조회 |
| ② | sign → HIS | Webhook `POST {callbackUrl}` | **HMAC**(X-Sign-Signature) + eventId 멱등 | 서명완료/실패/철회 상태 통지 |
| ③ | 의료진 포털 → sign | `POST /v1/sign/staff` (Bearer HIS SSO) | HIS SSO 토큰 **JWKS 검증** | STAFF 서명(신뢰경계 §19.2) |
| ④ | 환자앱 → sign | DMZ 포털 API → 서명 | 앱 세션 + 본인인증(§12) | 환자/보호자 서명 |

**신뢰경계**: sign은 HIS가 발급한 SSO 토큰을 **JWKS 공개키로 검증**(발급자=HIS 신뢰). 그 외 시스템 연동은 `ConsumerApp` 등록(apiKey/mTLS/webhookSecret) 기반.

---

## 4. Hospital RUN 측 변경 (clean replacement, 개발중·마이그레이션 없음)

| 대상 | 조치 |
|---|---|
| mock `blockchain-cert`/`document-sign`/`SignedDocument`/`DocumentSignature`/`BlockchainCertificate` | **제거** → sign이 대체 |
| `ConsentForm.blockchainSignature`(mock) | 제거 |
| `ConsentForm` 신규 필드 | `signatureRequestId`(uuid), `signStatus`(sign 동기화), `auditCertUri` |
| `consent`/`portal`/워크스테이션 서명 호출부 | sign API 호출 + Webhook 수신으로 교체 |
| 손글씨 서명 이미지(`patientSignature` 등) | 표시용 유지 가능, **법적 효력 근거는 sign의 PKI 서명으로 일원화** |
| 재활용 자산 | Expo 환자앱·포털·passkey/SSO/step-up·워크스테이션 SSE·FCM push |

---

## 5. 데이터 매핑 (앵커)

```
ConsentForm.id  ────────────▶  SignatureRequest.externalDocId  (externalDocType=CONSENT, externalSystem=HOSPITALRUN)
ConsentForm 서명자(환자/보호자/의사/간호사/입회) ──▶ SignerParticipant.signerRole / signerType
Patient.id / User.id  ──────▶  SignerParticipant.externalSignerRef  (+ Certificate.ownerRef)
서명완료  ◀──── Webhook ────  ConsentForm.status=SIGNED, signatureRequestId, auditCertUri
```

---

## 6. 연동 시퀀스 (대표: 수술 동의서)

```
1. 의사: 의료진 포털에서 ConsentForm 생성
2. HIS → sign: POST /v1/requests(externalDocId, documentHash, participants[환자·의사])
3. 환자: 환자앱(원내/원외) → POST /v1/sign/staff 아님, 환자 채널 서명(본인인증→PKI→TSA)
4. 의사: 의료진 포털 → POST /v1/sign/staff(HIS SSO Bearer) 서명
5. sign: 모두 서명 → COMPLETED → AuditCertificate 생성
6. sign → HIS: Webhook request.completed → ConsentForm.status=SIGNED + 참조 저장
```

---

## 7. 관계 요약 (한 줄 정의)

> **sign은 Hospital RUN에 종속되지 않는 독립 전자서명 트러스트 서비스이며, Hospital RUN은 이를 API/Webhook/SSO 계약으로 호출하는 첫 번째 Consumer다. 서명·키·증거는 sign이, 동의서·환자·UI·채널은 Hospital RUN이 소유한다.**

---

## 8. 경계가 주는 이점

- **독립 진화**: HIS 변경이 서명 무결성에 영향 없음(계약만 유지)
- **재사용**: 타 원내 시스템(원무·검진 등)도 동일 sign API로 서명 가능(플랫폼화)
- **감사 명확성**: 법적 증거(서명·감사추적)는 sign 한 곳에 집중
- **보안 경계**: 키·민감정보 분리 보관, 상호 인증(mTLS/HMAC/JWKS)
- **점진 도입**: mock 제거 후 sign 연동을 동의서 종류별로 단계 적용 가능
