# 인증서 발급 주체 정리 — HIS "블록체인 인증서" vs sign PKI (혼란 해소)

> **혼란의 핵심**: 기존엔 HIS가 "블록체인 인증서"를 발급했는데, sign에도 발급 기능이 생겨 **발급 주체가 둘처럼** 보임.
> **결론**: 발급 권위는 **sign 단독**. HIS의 블록체인 인증서는 발급자가 아니라 **sign 발급분의 기록(미러)** 으로 전환된다.

---

## 1. 두 메커니즘의 실체 (무엇이 다른가)
| | HIS "블록체인 인증서"(기존) | **sign PKI**(현재) |
|---|---|---|
| 정체 | publicKey·signatureValue를 체인형 **기록/등록** | 2-tier CA가 발급하는 **실 X.509 인증서** |
| 개인키 수탁 | **없음**(HIS는 키 미보유 — 환자=단말 SE, 키 보관 안 함) | HSM(KMS) 앵커 CA, 비추출 |
| 신뢰 근원 | HIS 내부(자체) | **HSM 마스터키**(FIPS L3), CRL/OCSP·TSA |
| 법적효력·EMR인증 | 자체 시뮬레이션 수준 | 실 PKI·감사 해시체인·TSA로 충족 |

→ HIS의 "발급"은 **진짜 CA 발급이 아니라 키/서명의 등록**에 가깝다. 의료 전자서명의 법적효력·EMR 인증을 위해 **실 PKI가 필요**했고, 그 역할을 sign이 맡는다.

## 2. 결론 — 단일 발급 권위 = sign
- **모든 인증서는 sign의 HSM-앵커 CA가 발급**한다(환자·의료진·대리·증인). → 트러스트 루트 1개.
- HIS는 더 이상 **독립 발급하지 않는다**. HIS의 블록체인 인증서 테이블은 **sign이 발급한 결과(cert serial·publicKey·signatureValue·attestation)를 저장하는 미러**가 된다.
- 이로써 HIS의 기존 화면/워크플로우/조회는 **그대로 유지**되되, 가리키는 대상이 "HIS 자체 발급분" → "sign 발급분"으로 바뀐다.

## 3. 발급 시퀀스 (실제 운영)

### 3.1 환자(PATIENT) — 서명 플로우에 내장(자동 발급)
```
HIS/PACS                    sign (HSM-앵커 CA)                 환자
  │  POST /v1/sign-requests (patientSigner{name,ci})            │
  │──────────────────────────▶│                                │
  │                           │  본인확인(PASS/대면) ──────────▶│
  │                           │◀──────────── CI 검증 OK ────────│
  │                           │  enroll: X.509 발급(HSM-앵커 CA)│
  │                           │  서명 + 감사 해시체인 + TSA      │
  │◀── webhook request.completed ────────────────────────────────│
  │     { signCertSerial, signatureValue, assuranceLevel, tsaToken }
  │  └─ HIS 블록체인 인증서 store에 "기록"(미러)
```
→ 환자는 인증서를 의식하지 않음. **본인확인 통과 = 발급 게이트**.

### 3.2 의료진(STAFF) — 사전 1회 발급 후 SSO 재사용
```
[온보딩 1회]
  HIS ── POST /v1/certificates/enroll (STAFF, licenseNumber) ──▶ sign ──▶ X.509 발급
  sign ──▶ sign_cert_serial 반환 ──▶ HIS가 직원에 매핑(staff-token에 포함)
[서명 시]
  의료진 ── staff-token(aud=sign, sign_cert_serial) ──▶ POST /v1/sign/staff ──▶ sign 검증·서명
```
→ 의료진은 면허 기반 사전 발급(자동 발급 안 함). 이후 SSO 토큰의 serial로 재사용.

## 4. 충돌 방지 — "한 문서 = 한 발급자"
`signProvider` 토글로 **동의서 유형별** 전환(SIMULATION ↔ EXTERNAL):
- **SIMULATION**(레거시): HIS가 자체 블록체인 인증서로 처리(sign 무관). ← 여기서만 "HIS 발급"이 살아있음.
- **EXTERNAL**: sign이 발급·서명, HIS는 기록. ← 목표 상태.
- 같은 동의서가 **두 경로로 동시에 발급되지 않는다**(토글이 배타적). → 발급 주체 중복 없음.
- **P1에서 대상 동의서 1종을 EXTERNAL로 전환** = 그 유형의 발급 주체를 HIS→sign으로 이관하는 작업.

## 5. HIS 데이터 모델 보존 (필드 매핑)
HIS 블록체인 인증서 테이블은 버리지 않고 sign 발급분으로 채운다:
| HIS 블록체인 인증서 필드 | ← sign 출처 |
|---|---|
| 인증서 식별자 | `signCertSerial` (sign X.509 시리얼) |
| publicKey | sign 발급 인증서의 공개키 |
| signatureValue | sign 서명값(webhook/verify) |
| (신규) 보호수준 | `assuranceLevel`(HSM_ANCHORED)·`caKeyCustodyProvider`(AWS_KMS) |
| (신규) 시점 | `tsaToken`(genTime) |
→ HIS Phase 4가 이 필드를 수신·기록(코드 변경 최소).

## 6. FAQ (혼란 해소)
- **Q. sign과 HIS가 둘 다 발급하나?** → 아니다. **sign 단독 발급**. HIS는 기록(미러).
- **Q. 기존 HIS 블록체인 인증서는 폐기?** → 데이터 모델은 유지, sign 발급분을 가리키도록 전환. 레거시(SIMULATION) 발급분은 그대로 보존.
- **Q. 왜 sign이어야 하나?** → 법적효력·EMR 인증엔 HSM-앵커 실 PKI·CRL/OCSP·TSA가 필요. HIS 자체 메커니즘으론 불충분.
- **Q. 의료진은 매번 발급?** → 아니다. 1회 발급 후 SSO 토큰 serial 재사용. 환자만 서명 시 자동 발급(또는 재사용).
- **Q. 콘솔 "인증서 발급" 화면은?** → 운영자 수동 발급(대면·예외·의료진 사전등록). 실 대량 발급은 통합 API.

> 연계: `hsm-single-custody-architecture.md`(§5-1 블록체인 인증서 관계) · `sign-to-his-kms-confirm.md`(attestation) · `hospitalrun-integration-spec.md`(signProvider 토글)
