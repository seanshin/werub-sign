# Phase 1 — Data Schema: sign (전자서명 서비스)

> **Feature**: 의료-전자동의서-플랫폼
> **Date**: 2026-06-12
> **Scope**: 독립 서명 서비스(sign)의 데이터 모델 + Hospital RUN(HIS) 매핑 + 상태머신
> **Stack 가정**: NestJS + Prisma + PostgreSQL (Hospital RUN 스택 재사용) — 별도 DB

---

## 0. 설계 원칙

1. **자체 DB 소유**: sign은 인증서·키·서명·타임스탬프·본인인증·감사추적을 직접 소유. Hospital RUN의 `ConsentForm`(임상 콘텐츠)과 분리.
2. **실 PKI**: mock(`sha256(signatureValue)`)이 아니라 개인키 서명 + 공개키 `crypto.verify`. 개인키는 DB 평문 저장 금지 → `KeyMaterial`로 HSM/암호화 키스토어 참조.
3. **시점·본인확인 1급화**: TSA 토큰(`Timestamp`)·본인인증(`IdentityVerification`)을 서명에 강결합.
4. **무결성 보장 감사추적**: `AuditTrail`은 append-only + 해시체인(prevHash→entryHash)로 위변조 탐지.
5. **교체 가능 추상화**: 키스토어(SOFT↔HSM), TSA(자체↔외부 공인)를 enum/provider로 교체 가능.
6. **멱등 연동**: Hospital RUN ↔ sign 은 `idempotencyKey` + Webhook HMAC.

---

## 1. 도메인 용어 (Terminology)

| 용어 | 정의 | Hospital RUN 대응 |
|------|------|------------------|
| SignatureRequest | 한 문서에 대한 서명 봉투(요청 단위) | ConsentForm 1건 |
| SignerParticipant | 요청 내 개별 서명자(순차) | 환자/보호자/의사/간호사/입회인 |
| Certificate | 자체 CA가 발급한 X.509 인증서 | (기존 BlockchainCertificate 대체) |
| KeyMaterial | 키쌍/개인키 보관 참조(HSM/keystore) | (신규 — 기존엔 없음) |
| Signature | 문서해시에 대한 실제 암호 서명 | (기존 DocumentSignature 대체) |
| Timestamp | RFC3161 신뢰 시점 토큰 | (신규 — 기존엔 signedAt만) |
| IdentityVerification | 본인확인 기록(대면/명의/PASS) | (신규 — 기존엔 boolean) |
| AuditTrail | 서명 전 과정 이벤트 로그(해시체인) | audit/audit-enhanced 정합 |
| AuditCertificate | 감사추적인증서(증거 산출물) | (신규) |

---

## 2. 엔티티 정의 (Prisma 스케치)

### 2.1 PKI — KeyMaterial / Certificate

```prisma
// 개인키 보관 추상화 (평문 DB 저장 금지)
model KeyMaterial {
  id           String   @id @default(uuid()) @db.Uuid
  ownerType    String   @db.VarChar(10)        // CA, STAFF, PATIENT, WITNESS, SERVICE
  ownerRef     String?  @db.VarChar(64)        // 외부 식별자(userId/patientId)
  keyStoreType String   @db.VarChar(10)        // SOFT, HSM   ← 교체 가능
  keyRef       String   @db.VarChar(256)       // HSM 핸들 또는 KMS-암호화 blob 참조
  algorithm    String   @db.VarChar(20)        // RSA-3072, ECDSA-P256
  publicKey    String   @db.Text               // PEM
  status       String   @default("ACTIVE") @db.VarChar(20) // ACTIVE, RETIRED, COMPROMISED
  createdAt    DateTime @default(now()) @db.Timestamptz()

  certificate  Certificate?
  @@index([ownerType, ownerRef])
}

// 자체 CA 발급 인증서 (실제 X.509, 유한 수명)
model Certificate {
  id            String   @id @default(uuid()) @db.Uuid
  serialNumber  String   @unique @db.VarChar(64)
  subjectDn     String   @db.VarChar(500)
  issuerDn      String   @db.VarChar(500)       // CA DN
  ownerType     String   @db.VarChar(10)        // CA, STAFF, PATIENT, WITNESS (KeyMaterial과 통일)
  ownerRef      String?  @db.VarChar(64)         // 외부 userId/patientId
  keyId         String   @unique @db.Uuid
  x509Pem       String   @db.Text                // 실제 인코딩 인증서
  fingerprint   String   @db.VarChar(64)
  algorithm     String   @db.VarChar(20)
  notBefore     DateTime @db.Timestamptz()
  notAfter      DateTime @db.Timestamptz()       // ★ 실 만료(2099 금지)
  status        String   @default("ACTIVE") @db.VarChar(20) // ACTIVE, SUSPENDED, REVOKED, EXPIRED
  revokedAt     DateTime? @db.Timestamptz()
  revokeReason  String?  @db.VarChar(200)
  issuerCertId  String?  @db.Uuid                // 체인(→ CA cert)
  identityVerificationId String? @db.Uuid        // 발급 시 본인확인 근거
  createdAt     DateTime @default(now()) @db.Timestamptz()

  keyMaterial   KeyMaterial @relation(fields: [keyId], references: [id])
  issuerCert    Certificate?  @relation("CertChain", fields: [issuerCertId], references: [id])
  issued        Certificate[] @relation("CertChain")
  signatures    Signature[]
  @@index([ownerType, ownerRef])
  @@index([status])
}
```

### 2.2 서명 봉투 — SignatureRequest / SignerParticipant

```prisma
model SignatureRequest {
  id                 String   @id @default(uuid()) @db.Uuid
  externalSystem     String   @db.VarChar(30)    // HOSPITALRUN
  externalDocType    String   @db.VarChar(50)    // CONSENT
  externalDocId      String   @db.VarChar(64)    // ConsentForm.id  ← 매핑 키
  patientRef         String?  @db.VarChar(64)
  title              String   @db.VarChar(200)
  documentHash       String   @db.VarChar(64)    // 봉인된 원본 SHA-256
  documentVersion    Int      @default(1)
  documentUri        String?  @db.VarChar(500)   // 원본/서명본 보관(원내)
  signMode           String   @db.VarChar(20)    // APP(환자앱 primary), TABLET, PC(의료진), PORTAL, REMOTE(웹뷰 fallback)
  channel            String?  @db.VarChar(20)    // KAKAO, SMS, INPERSON
  status             String   @default("CREATED") @db.VarChar(20)
  requiredSigners    Int      @default(1)
  completedSigners   Int      @default(0)
  idempotencyKey     String   @unique @db.VarChar(64)
  callbackUrl        String?  @db.VarChar(500)
  expiresAt          DateTime? @db.Timestamptz()
  createdAt          DateTime @default(now()) @db.Timestamptz()

  participants  SignerParticipant[]
  signatures    Signature[]
  auditTrail    AuditTrail[]
  auditCert     AuditCertificate?
  @@index([externalSystem, externalDocType, externalDocId])
  @@index([status, createdAt])
}

model SignerParticipant {
  id                  String  @id @default(uuid()) @db.Uuid
  requestId           String  @db.Uuid
  signerRole          String  @db.VarChar(20)   // PATIENT, GUARDIAN, DOCTOR, NURSE, WITNESS
  signerType          String  @db.VarChar(20)   // PATIENT, STAFF, GUARDIAN, WITNESS_EXTERNAL
  externalSignerRef   String? @db.VarChar(64)   // Hospital RUN user/patient id
  displayName         String  @db.VarChar(100)
  signOrder           Int     @default(1)        // 순차 서명
  requiredIdentityLevel String @default("INPERSON") @db.VarChar(20) // NONE, INPERSON, MOBILE_NAME, PASS, APP_STEPUP, STAFF_SSO
  guardianName        String? @db.VarChar(100)
  guardianRelation    String? @db.VarChar(30)    // PARENT, SPOUSE, CHILD, LEGAL_GUARDIAN
  guardianLegalBasis  String? @db.VarChar(50)    // POA, FAMILY
  status              String  @default("PENDING") @db.VarChar(20) // PENDING, IDENTIFIED, SIGNED, DECLINED

  request   SignatureRequest @relation(fields: [requestId], references: [id])
  signature Signature?
  @@index([requestId, signOrder])
}
```

### 2.3 서명·시점·본인확인 — Signature / Timestamp / IdentityVerification

```prisma
model Signature {
  id                 String   @id @default(uuid()) @db.Uuid
  requestId          String   @db.Uuid
  participantId      String   @unique @db.Uuid
  certificateId      String   @db.Uuid
  signatureValue     String   @db.Text          // ★ 실제 서명 바이트(base64)
  signatureAlgorithm String   @db.VarChar(30)    // SHA256withRSA / SHA256withECDSA
  signedAttrsHash    String   @db.VarChar(64)    // 서명 대상 속성 해시
  handwrittenImage   String?  @db.Text           // 손글씨 이미지(표시용, 비암호)
  timestampId        String?  @unique @db.Uuid    // TSA
  identityVerificationId String? @db.Uuid
  signedAt           DateTime @db.Timestamptz()
  ipAddress          String?  @db.VarChar(45)
  userAgent          String?  @db.VarChar(500)
  deviceId           String?  @db.VarChar(64)
  isValid            Boolean  @default(true)
  verifiedAt         DateTime? @db.Timestamptz()

  request       SignatureRequest @relation(fields: [requestId], references: [id])
  participant   SignerParticipant @relation(fields: [participantId], references: [id])
  certificate   Certificate @relation(fields: [certificateId], references: [id])
  timestamp     Timestamp? @relation(fields: [timestampId], references: [id])
  identity      IdentityVerification? @relation(fields: [identityVerificationId], references: [id])
  @@index([requestId])
}

// RFC3161 신뢰 시점 토큰
model Timestamp {
  id            String  @id @default(uuid()) @db.Uuid
  tsaProvider   String  @db.VarChar(30)   // SELF, EXTERNAL_KISA, ...  ← 교체 가능
  hashedMessage String  @db.VarChar(64)   // 타임스탬프 대상 해시
  hashAlgorithm String  @db.VarChar(20)
  tsToken       String  @db.Text          // base64 TimeStampToken
  genTime       DateTime @db.Timestamptz() // TSA가 보증한 시각
  tsaSerial     String? @db.VarChar(64)
  createdAt     DateTime @default(now()) @db.Timestamptz()

  signature     Signature?
}

// 비대면/대면 본인확인 기록
model IdentityVerification {
  id           String  @id @default(uuid()) @db.Uuid
  subjectRef   String? @db.VarChar(64)    // patient/guardian 외부 id
  method       String  @db.VarChar(20)    // INPERSON, MOBILE_NAME, PASS, KAKAO_CERT, ACCESS_CODE, STAFF_SSO(의료진 내부인증)
  provider     String? @db.VarChar(30)
  providerTxId String? @db.VarChar(128)
  verifiedName String? @db.VarChar(100)
  ciHash       String? @db.VarChar(128)   // 본인확인값(CI) 해시(평문 금지)
  phoneHash    String? @db.VarChar(128)
  result       String  @db.VarChar(10)    // SUCCESS, FAIL
  verifiedAt   DateTime @db.Timestamptz()
  ipAddress    String? @db.VarChar(45)

  signatures   Signature[]
  @@index([subjectRef])
}
```

### 2.4 감사추적 — AuditTrail / AuditCertificate

```prisma
// append-only + 해시체인(위변조 탐지)
model AuditTrail {
  id           String  @id @default(uuid()) @db.Uuid
  requestId    String  @db.Uuid
  eventType    String  @db.VarChar(30)  // CREATED, SENT, VIEWED, IDENTITY_VERIFIED, IDENTITY_FAILED, SIGNED, COMPLETED, REVOKED, EXPIRED, VERIFIED, FAILED, CERT_ISSUED, CERT_REVOKED
  actorType    String  @db.VarChar(10)  // PATIENT, STAFF, SYSTEM
  actorRef     String? @db.VarChar(64)
  ipAddress    String? @db.VarChar(45)
  userAgent    String? @db.VarChar(500)
  deviceId     String? @db.VarChar(64)
  eventData    Json?
  prevHash     String? @db.VarChar(64)  // 직전 엔트리 해시
  entryHash    String  @db.VarChar(64)  // 본 엔트리 해시(체인)
  occurredAt   DateTime @default(now()) @db.Timestamptz()

  request      SignatureRequest @relation(fields: [requestId], references: [id])
  @@index([requestId, occurredAt])
}

// 감사추적인증서(증거 산출물)
model AuditCertificate {
  id             String  @id @default(uuid()) @db.Uuid
  requestId      String  @unique @db.Uuid
  contentHash    String  @db.VarChar(64)
  pdfUri         String? @db.VarChar(500)
  timestampId    String? @db.Uuid          // 인증서 자체에 TSA
  generatedAt    DateTime @default(now()) @db.Timestamptz()

  request        SignatureRequest @relation(fields: [requestId], references: [id])
}
```

### 2.5 연동 Outbox — WebhookDelivery

```prisma
model WebhookDelivery {
  id          String  @id @default(uuid()) @db.Uuid
  requestId   String  @db.Uuid
  eventType   String  @db.VarChar(30)   // request.completed, request.failed, ...
  targetUrl   String  @db.VarChar(500)
  payload     Json
  hmac        String  @db.VarChar(128)  // 무결성 서명
  status      String  @default("PENDING") @db.VarChar(20) // PENDING, SENT, FAILED
  attempts    Int     @default(0)
  lastAttempt DateTime? @db.Timestamptz()
  createdAt   DateTime @default(now()) @db.Timestamptz()
  @@index([status])
}
```

---

## 3. Hospital RUN ↔ sign 매핑

| Hospital RUN (`ConsentForm` 등) | sign | 비고 |
|---|---|---|
| `ConsentForm.id` | `SignatureRequest.externalDocId` (docType=CONSENT) | 1:1 봉투 |
| `content`(JsonB) → 봉인 | `SignatureRequest.documentHash` | 원본 해시 |
| `patientId` / `doctorId` / `nurseId` / `witnessId` / guardian | `SignerParticipant.signerRole` | 다자/순차 |
| `signMode` (TABLET/PC/PORTAL/PAPER) | `SignatureRequest.signMode` | REMOTE 추가 |
| `patientSignature`(이미지) | `Signature.handwrittenImage` | 표시용 |
| 기존 `BlockchainCertificate` | `Certificate`+`KeyMaterial` | **mock 대체** |
| 기존 `DocumentSignature` | `Signature`(+Timestamp) | **mock 대체** |
| `identityVerified`(boolean) | `IdentityVerification`(레코드) | 근거 보존 |
| (없음) | `Timestamp`/`AuditTrail`/`AuditCertificate` | **신규 무결성** |

**연동 흐름**:
1. Hospital RUN 동의서 생성 → `POST /sign/requests`(idempotencyKey, externalDocId, documentHash, participants)
2. sign이 서명 진행(대면/원외) → 본인확인 → 실서명 → TSA → 감사추적
3. 완료 시 sign → Hospital RUN **Webhook**(`request.completed`: signatureRequestId, verifiedHash, auditCertUri)
4. Hospital RUN: `ConsentForm.status=SIGNED` + sign 참조 저장 (기존 mock 필드 미사용/병행)

---

## 4. 상태머신

**SignatureRequest**: `CREATED → SENT → IN_PROGRESS → COMPLETED`
분기: `→ EXPIRED`(만료) / `→ REVOKED`(철회) / `→ FAILED`(검증/시스템 실패)

**SignerParticipant**: `PENDING → IDENTIFIED → SIGNED` (또는 `→ DECLINED`)
- `IDENTIFIED`: requiredIdentityLevel 충족(대면 또는 명의/PASS 성공) 후에만 `SIGNED` 진입 가능

**Certificate**: `ACTIVE → (SUSPENDED) → REVOKED` / 시간경과 `→ EXPIRED`

---

## 5. 보안/개인정보 (EMR 보안성 직결)

- 개인키 평문 DB 저장 금지 → `KeyMaterial.keyRef`(HSM 핸들/KMS 암호화)
- CI/전화번호 등 식별자는 **해시 저장**(`ciHash`,`phoneHash`)
- `AuditTrail` append-only + 해시체인 → 위변조 탐지
- 민감정보·서명원본·키는 **원내망 고정**, DMZ엔 서명 웹뷰만
- 모든 접근 RBAC + 감사 (Hospital RUN audit-enhanced 정합)

---

## 6. 미해결 (스키마 영향)

| # | 항목 | 상태 / 영향 |
|---|------|------|
| Q5 | HSM 보유 여부 | ✅ **결정**: `keyStoreType` 기본값 `SOFT`로 개발 시작, HSM 별도 도입 예정(인증 전 전환). `KeyMaterial` 추상화로 무중단 전환 |
| Q7 | 기존 mock 서명 데이터 처리(폐기/재서명/병행) | 미정 — 마이그레이션·`ConsentForm` 필드 |
| Q4 | 명의인증/PASS 사업자 | 미정 — `IdentityVerification.method/provider` |
| — | 서명 포맷(PAdES/CAdES) 채택 여부 | 미정 — `Signature` 구조·장기검증(LTV) |

### Q5 결정 상세 — SOFT → HSM 전환 설계
- **개발/PoC**: `keyStoreType="SOFT"`. 개인키는 KMS/앱-마스터키로 **암호화**하여 `keyRef`에 blob 참조 (평문 저장 절대 금지).
- **운영/인증**: HSM 도입 시 `keyStoreType="HSM"`, `keyRef`=HSM 키 핸들. 서명 연산은 `KeySigner` 인터페이스 뒤에서 추상화 → 상위 로직 무변경.
- **주의**: SOFT 단계에서 발급한 키는 HSM 전환 시 **신규 키로 재발급**(SOFT 키를 HSM에 넣을 수 없음). 전환 시점 인증서 재발급 정책 필요.

---

## 7. 보강 엔티티 (Design v0.2 / design-validator 대응)

설계 §10~§16에서 도출된 추가 모델·필드 (구현 시 반영):

```prisma
// §11 인증서 폐기(CRL/OCSP)
model CertRevocation {
  id String @id @default(uuid()) @db.Uuid
  certId String @db.Uuid
  serialNumber String @db.VarChar(64)
  revokedAt DateTime @db.Timestamptz()
  reason String @db.VarChar(50)
  crlNumber Int
  @@index([serialNumber])
}

// §16 감사 해시체인 앵커링
model AuditAnchor {
  id String @id @default(uuid()) @db.Uuid
  headHash String @db.VarChar(64)
  timestampId String @db.Uuid       // TSA 봉인
  periodAt DateTime @db.Timestamptz()
}

// §16 멀티테넌트(플랫폼화 FR-11) — externalSystem 문자열 대체
model ConsumerApp {
  id String @id @default(uuid()) @db.Uuid
  name String @db.VarChar(100)
  apiKeyHash String @db.VarChar(128)
  mtlsFingerprint String? @db.VarChar(64)
  allowedScopes Json
  webhookSecret String @db.VarChar(128)   // 회전 가능
  status String @default("ACTIVE") @db.VarChar(20)
}
```

추가 필드:
- `Signature`: `format`("PAdES-B-LTA"), `dssData`(Json: chain/crl/ocsp/ts), `identityVerificationId` **NOT NULL**(§15), `signedAttrsHash`가 서명 대상(§10)
- `SignerParticipant`: `contactPhoneHash`(§12 토큰-연락처 바인딩)
- `SignSession`(신규/§12): sessionId·IP·deviceId·identifiedAt — identify↔submit 동일세션 검증
- `AuditTrail.eventType`: `IDENTITY_FAILED` 추가(§15)

## 8. Next

1. [x] 본 스키마 → `/pdca design` (완료, v0.2 보강 반영)
2. [x] design-validator 일관성 검증 (완료 — 72→보강)
3. [ ] Phase 2 컨벤션(키 취급·감사로그 포맷·민감정보 마스킹)
4. [ ] 구현(`/pdca do`)
