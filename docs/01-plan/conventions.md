# Phase 2 — Coding Conventions: sign (전자서명 서비스)

> **Feature**: 의료-전자동의서-플랫폼
> **Date**: 2026-06-12
> **Stack**: NestJS + Prisma + PostgreSQL + TypeScript (Hospital RUN 스택 정합)
> **Level**: Enterprise
> **원칙**: 표준 규칙은 Hospital RUN과 일치, 보안 규칙(키·감사·마스킹)은 본 서비스 강제 표준

---

## 1. 명명 규칙 (Naming)

| 대상 | 규칙 | 예 |
|------|------|----|
| 클래스/엔티티 | PascalCase | `SignatureRequest`, `KeySigner` |
| 함수/변수 | camelCase | `verifySignature`, `documentHash` |
| 상수 | UPPER_SNAKE_CASE | `MAX_IDENTITY_RETRIES` |
| 파일 | kebab-case | `key-signer.soft.ts`, `verify.controller.ts` |
| 포트(인터페이스) | PascalCase + 역할명 | `CryptoProvider`, `TsaProvider`, `IdentityProvider` |
| 어댑터 구현 | `<port>.<impl>.ts` | `key-signer.soft.ts`, `tsa.self.ts`, `notifier.kakao.ts` |
| DB 테이블 | snake_case(@@map) | `signature_requests`, `audit_trails` |
| API 경로 | kebab-case, 버전접두 | `/v1/requests`, `/v1/audit-certificate` |
| 도메인 이벤트 | dot.case | `request.completed`, `signer.signed`, `identity.failed` |

**용어 일관성** (스키마 §1과 일치): SignatureRequest, SignerParticipant, Certificate, KeyMaterial, Signature, Timestamp, IdentityVerification, AuditTrail, AuditCertificate. **약어 금지**(`sig`→`signature`, `cert`는 도메인 표준어로 허용).

---

## 2. 폴더 구조 (Enterprise 4-Layer)

```
sign/src/
├── presentation/    # 컨트롤러·서명 웹뷰·webhook sender
├── application/     # use-cases (CreateRequest, SubmitSignature, VerifyRequest, IssueCertificate…)
├── domain/          # 엔티티·타입·포트(인터페이스)·도메인 상수
│   └── ports/       # CryptoProvider, KeySigner, TsaProvider, IdentityProvider, Notifier, DocumentStore
└── infrastructure/  # prisma·어댑터(soft/hsm/kakao/...)·hospitalrun.client·webhook.outbox
```

**의존성 규칙** (위반 = 리뷰 거부):
| 레이어 | 의존 가능 | 금지 |
|---|---|---|
| presentation | application, domain | infrastructure 직접 |
| application | domain, ports | infrastructure 구현 직접(포트로만) |
| domain | 없음(순수) | 모든 외부 레이어 |
| infrastructure | domain(포트 구현) | application, presentation |

→ **암호/키/TSA/본인인증은 반드시 `domain/ports` 인터페이스 뒤에서만 사용**. 컨트롤러·유스케이스가 `crypto`·HSM·OpenSSL을 직접 호출 금지 (SOFT↔HSM, 자체↔공인 교체성 보장).

---

## 3. 🔐 키 취급 규칙 (Critical — EMR 보안성)

| 규칙 | 내용 |
|---|---|
| **개인키 평문 금지** | 개인키를 DB·로그·응답·예외메시지·환경변수에 평문 저장/노출 절대 금지 |
| **포트 경유** | 서명은 `KeySigner.sign(hash, keyRef)` 로만. 상위 코드는 키 바이트를 만지지 않음 |
| **SOFT 보관** | 개인키는 KMS/마스터키로 암호화하여 `KeyMaterial.keyRef`에 blob 참조. 복호화는 서명 직전, 사용 후 **즉시 메모리 폐기**(`buffer.fill(0)`) |
| **HSM 전환** | `keyStoreType=HSM` 시 키는 HSM 밖으로 나오지 않음(PKCS#11). SOFT키는 HSM 이식 불가 → 재발급 |
| **CA 루트키** | `ownerType=CA`는 별도 최고등급 보호(오프라인/HSM). 일반 키와 동일 코드경로 금지 |
| **알고리즘 고정** | 해시 SHA-256, 서명 RSA-3072 또는 ECDSA-P256. 약한 알고리즘(MD5/SHA-1/RSA-1024) 사용 금지(lint 차단) |
| **난수** | 토큰·serial은 `crypto.randomBytes`(CSPRNG). `Math.random` 보안용도 금지 |

```typescript
// ✅ 올바른 사용
const sig = await this.keySigner.sign(signedAttrs, cert.keyId);  // 포트 경유

// ❌ 금지
const pem = await db.keyMaterial.find... ; crypto.createSign(...).update(pem) // 키 직접 취급
this.logger.debug(`key=${privateKey}`)                                       // 키 로깅
```

---

## 4. 📋 감사로그(AuditTrail) 포맷 규칙 (Critical)

모든 상태변화·접근은 `AuditTrail`에 기록. **해시체인 무결성 유지가 핵심.**

| 규칙 | 내용 |
|---|---|
| **필수 이벤트** | CREATED, SENT, VIEWED, IDENTITY_VERIFIED, **IDENTITY_FAILED**, SIGNED, COMPLETED, REVOKED, EXPIRED, VERIFIED, FAILED, **CERT_ISSUED**, **CERT_REVOKED** |
| **필수 필드** | `eventType, actorType, actorRef, ipAddress, occurredAt, prevHash, entryHash` (+ deviceId/eventData) |
| **해시체인** | `entryHash = SHA256(prevHash + canonical(eventData) + occurredAt + eventType)`. 직전 엔트리의 entryHash를 prevHash로 |
| **append-only** | AuditTrail UPDATE/DELETE 금지(코드·DB 권한 모두). 정정은 신규 보정 엔트리로 |
| **앵커링** | 주기적으로 체인 head를 TSA 앵커(`AuditAnchor`)로 봉인 |
| **표준 헬퍼** | 직접 `prisma.auditTrail.create` 금지 → `AuditTrailService.append(requestId, event)` 단일 경로만 사용 |
| **시각** | 모든 시각 UTC `Timestamptz`, 애플리케이션은 ISO8601 |

```typescript
// ✅ 단일 경로
await this.audit.append(requestId, { eventType: 'IDENTITY_FAILED', actorType: 'PATIENT',
  actorRef, ipAddress, eventData: { method: 'MOBILE_NAME', reason } });
```

---

## 5. 🙈 민감정보 마스킹 규칙 (Critical — 개인정보보호법)

| 데이터 | 저장 | 로그/응답 노출 |
|---|---|---|
| 주민번호/CI | **저장 금지** 또는 단방향 해시(`ciHash`) | 절대 금지 |
| 전화번호 | `phoneHash` 또는 암호화 | 마스킹 `010-****-1234` |
| 환자명 | 필요 최소 | 마스킹 `김*수` |
| 서명 이미지 | `documentUri`/암호화 보관 | base64 로깅 금지 |
| 개인키/시크릿/토큰 | §3 규칙 | 절대 금지 |

| 규칙 | 내용 |
|---|---|
| **로그 마스킹** | 로거에 마스킹 인터셉터 전역 적용. 민감 필드는 자동 `***` |
| **응답 마스킹** | 외부 응답 DTO에 원본 식별자 미포함. 표시는 마스킹값 |
| **해시 일관성** | 식별자 해시는 `HMAC-SHA256(value, pepper)` 고정(블라인드 인덱스), pepper는 서버 시크릿 |
| **에러메시지** | 예외/스택에 민감정보·키·토큰 절대 미포함 |

---

## 6. API · 에러 · Webhook 규칙

| 규칙 | 내용 |
|---|---|
| **응답 포맷** | 성공 `{ data, meta? }`, 실패 `{ error: { code, message, requestId } }` (bkit Phase4 표준) |
| **에러코드** | HTTP status + 문자열코드. 코드 1의미 1개(`409`는 `ALREADY_SIGNED`/`IDEMPOTENT_REPLAY` 분리) |
| **멱등** | 쓰기 API는 `idempotencyKey`, Webhook 수신은 `eventId`로 멱등 |
| **검증** | 모든 입력 DTO `class-validator`/zod 검증. 서명 대상 해시는 서버 고정(클라 입력 불신) |
| **버전** | 경로 `/v1`. 파괴적 변경은 `/v2` |
| **Webhook 보안** | `X-Sign-Signature: HMAC-SHA256(payload, secret)`, secret 회전 지원 |
| **인증** | HIS→sign: API Key + mTLS / sign→HIS: HMAC. 토큰 1회용·TTL·세션바인딩(§design 12) |

---

## 7. 환경변수 규칙

| 접두 | 용도 | 노출 |
|---|---|---|
| `SIGN_` | 서비스 일반 | 서버 |
| `DB_` | DB 연결 | 서버 |
| `CRYPTO_` | 마스터키/KMS/HSM | 서버(시크릿) |
| `TSA_` | 타임스탬프 | 서버 |
| `HIS_` | Hospital RUN 연동(URL·webhook secret·mTLS) | 서버(시크릿) |
| `IDV_` | 본인인증 사업자 | 서버(시크릿) |
| `KAKAO_` | 알림톡/발송 | 서버(시크릿) |

- `.env.example`(Git 포함, 값 비움) / `.env.local`(gitignore). 시크릿 커밋 금지
- 앱 시작 시 zod로 필수 환경변수 검증(`infrastructure/env.ts`)
- pepper·마스터키·webhook secret은 **CI/CD Secrets**로만 주입

---

## 8. 코드 스타일

- TypeScript strict, ESLint + Prettier (Hospital RUN 설정 재사용)
- 들여쓰기 2칸, 세미콜론 사용, 작은따옴표
- `any` 금지(불가피 시 `unknown`+가드), 공개 함수 반환타입 명시
- 비동기 `async/await`, 부동소수 금액·시간 연산 주의
- 도메인 상수는 config 객체화(strategy/config 패턴, switch 나열 지양)

---

## 9. 재사용·확장 원칙 (요약)

- 포트/어댑터로 교체축 분리: `CryptoProvider`(SOFT↔검증필), `KeySigner`(SOFT↔HSM), `TsaProvider`(자체↔공인), `IdentityProvider`(명의↔PASS), `Notifier`(카카오↔SMS)
- 동일 로직 2회+ → 추출. 하드코딩 값 → 상수/config
- consentType↔requiredIdentityLevel 등 정책은 **설정 매트릭스**로(분기 나열 금지)

---

## 10. Phase 8 검증 연계

| 정의(Phase2) | 검증(Phase8) |
|---|---|
| 의존성 방향 | 레이어 위반 검사 |
| 키 취급 규칙 | 개인키 노출/직접취급 검사 |
| 감사로그 포맷 | 단일경로·해시체인 검사 |
| 마스킹 규칙 | 민감정보 노출 검사 |
| 명명/환경변수 | 일관성 검사 |

---

## Next

Phase 2 완료 → **구현(`/pdca do 의료-전자동의서-플랫폼`)**. 구현 시 본 컨벤션 §3~§5(보안)를 최우선 적용.
