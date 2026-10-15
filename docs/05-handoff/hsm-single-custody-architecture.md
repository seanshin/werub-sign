# [sign → 내부서비스(HIS·PACS·환자앱)] HSM 단일 수탁 + 블록체인 기반 트러스트 — 아키텍처 원칙·요청서

> 본 문서는 HSM 관련 산출물(hsm-key-custody-design·sign-to-his-hsm-answers·his-pkcs11-complete·
> sign-to-his-kms-confirm)을 **하나의 원칙**으로 묶는 기준 문서다. 충돌 시 본 문서가 우선한다.

---

## 0. 핵심 원칙 (두 문장)
1. **HSM은 sign에서만 연동한다.** HSM에 상주하는 **CA 마스터키**가 전 기관 전자서명의 **유일한 신뢰 근원**이다.
2. **내부 서비스(HIS·PACS·환자앱)는 HSM 키를 보유하지 않는다.** 그 마스터키로 발급된 인증서 + **블록체인(감사 해시체인 + TSA 앵커) 기반 무결성**으로 동작한다.

```
                 ┌──────────────── sign (유일한 HSM 연동점) ────────────────┐
   [ HSM/AWS KMS ]──▶ CA 마스터키(Root·Issuing, 비추출) ──▶ 인증서 발급(환자·의료진·대리)
        FIPS L3            │                                         │
                          ▼                                         ▼
                 감사 해시체인(append-only) ─── TSA 앵커(head 시점봉인) = "블록체인"
                          └──────────────── 검증 API ────────────────┘
                                   ▲              ▲              ▲
                              [ HIS ]        [ PACS ]      [ 환자앱 ]   ← HSM 키 미보유
                          (키 미보유, 마스터키 발급 인증서 + 해시체인으로만 동작)
```

## 1. 왜 HSM은 sign 단독인가 (단일 수탁 경계)
- **비용**: HSM 연동점 1개 → 클라우드 HSM 상주 키 **2개(CA Root·Issuing)** 로 고정, 말단·TSA는 SOFT(서명 건당 HSM 비용 0).
- **보안·인증**: FIPS 140-2 L3·키 회전·감사 범위가 **sign 한 곳**으로 한정 → 감사·KCMVP 대응 단순.
- **분산 금지**: 내부 서비스가 각자 HSM을 붙이면 키 분산·비용 폭증·감사 복잡 → **금지**. 모든 HSM 의존은 sign으로 수렴.
- ※ **환자 단말의 로컬 SE(Secure Element)** 는 별개다(환자 디바이스 보조 수단). **중앙 신뢰 HSM 수탁은 sign 단독.**

## 2. 마스터키 중심 트러스트 전파
- HSM CA 마스터키 → 환자/의료진/대리 **인증서 발급**(2-tier 체인). 개인키는 HSM 밖으로 안 나간다(다이제스트만 서명).
- 모든 서명은 이 체인으로 검증된다 → "이 서명은 **HSM 앵커 CA**가 보증한 키로 만들어졌다"(=`assuranceLevel: HSM_ANCHORED`).
- 내부 서비스는 **인증서를 신뢰**할 뿐 키를 복제·보관하지 않는다.

## 3. "블록체인 기반"의 정확한 의미 (해시체인 + TSA 앵커)
sign이 운영하는 무결성 메커니즘(외부 퍼블릭 체인이 아니라 **내부 검증가능 원장**):
- **감사 해시체인**: append-only. `entryHash = SHA256(prevHash + canonicalJson(data) + occurredAt + eventType)`, genesis=ZERO. 한 칸이라도 바뀌면 이후 전부 깨짐(위변조 탐지). `canonicalJson`으로 저장소 키순서 무관 안정.
- **TSA 앵커**: 체인 head를 **TSA 토큰으로 시점봉인** → 내부자가 전체 체인을 재계산하는 위변조까지 탐지(고정 기준점).
- 결과: 내부 서비스는 키를 들지 않고도 **(HSM-앵커 CA) + (해시체인·TSA 앵커)** 로 "누가·언제·무엇을 서명했고 변조되지 않았다"를 증명. 이것이 "마스터키를 중심으로 블록체인 기반으로 움직인다"의 실체.

## 4. 내부 서비스 요청사항 (이 원칙을 지키기 위한 합의)
| 서비스 | 요청 |
|---|---|
| **공통** | HSM 키·CA 개인키 **미보유**. 서명·인증서 발급·검증은 **sign 경유**. 자체 서명코어 신설 금지(있으면 sign EXTERNAL로 이관). |
| **HIS** | 동의서 서명 sign 경유(`signProvider=EXTERNAL` 전환). JWKS staff-token은 소프트 유지 OK(dual-kid 회전→sign 검증 무중단). attestation은 **`assuranceLevel=="HSM_ANCHORED"`** 로 봉인(키 HSM-resident 오인 금지). |
| **PACS** | 판독보고서·영상동의 서명 sign 경유. 키 미보유. |
| **환자앱** | 로컬 SE는 디바이스 보조. 인증서·서명·검증 트러스트는 sign. |

## 5. HSM 수탁 사양 (확정)
- **provider**: AWS KMS(FIPS 140-2 L3). 온프레 PKCS#11도 구현완료(드롭인 교체 가능, 현 미채택).
- **HSM 상주 키**: CA Root·Issuing **2키만**. 말단(서명)·TSA는 SOFT.
- **비추출**: 개인키 HSM 밖 미반출(다이제스트만 송신). `keyRef`=핸들/ARN.
- **attestation**(enroll·webhook additive): `keyCustody`(말단=SOFT) · `caKeyCustody`(HSM) · `caKeyCustodyProvider`(AWS_KMS) · `assuranceLevel`(HSM_ANCHORED). 현재 SOFT 운영=SOFTWARE, KMS 가동 시 자동 HSM_ANCHORED.

## 5-1. HIS "블록체인 인증서"와의 관계 (경쟁 아님 — 하위 미러)
HIS의 `document-sign`/블록체인 인증서는 **독립 발급자가 아니라 sign 결과의 하위 기록**이다.
| | sign | HIS 블록체인 인증서 |
|---|---|---|
| 역할 | **유일한 발급·서명 권위** — HSM-앵커 CA로 X.509 발급 + 서명 + 감사 해시체인 | sign 결과의 **하위 기록**(publicKey·signatureValue 체인형 저장) |
| 개인키 | HSM(KMS) 상주·비추출 | **미보유**(HIS는 HSM 없음) |
| 신뢰 근원 | HSM 마스터키 | sign이 발급한 인증서를 **참조** |

- HIS 블록체인 인증서의 각 항목 → **sign `sign_cert_serial` + `signatureValue` + attestation(`keyCustody`·`caKeyCustody`·`assuranceLevel`·`tsaToken`)** 을 저장(HIS 문서 워크플로우·표시·자체검증용).
- **전환 축**: HIS `signProvider` **SIMULATION → EXTERNAL**.
  - SIMULATION(레거시): HIS가 자체 블록체인 인증서를 독립 발급 → **이때만 트러스트 루트가 둘**(원칙 위반 소지).
  - EXTERNAL: 해당 동의서 유형은 **sign 단일 루트**, HIS store는 **미러**가 됨.
- ⚠️ **P1에서 대상 동의서를 EXTERNAL로 전환**하는 것이 "HIS 블록체인 인증서를 sign 마스터키 아래로 흡수"하는 작업. 그 전까지 SIMULATION 항목은 sign과 무관한 HIS 레거시 기록.
- 두 "블록체인"의 관계: **sign 감사 해시체인(HSM-앵커)** = 진실의 원천 / **HIS 블록체인 인증서** = sign cert serial·attestation에 키된 하위 미러.

## 6. cutover (P1, 1회)
- sign이 KMS로 CA 마스터키 재생성 → 기존 테스트 인증서 무효, 신규 CA 체인 baseline.
- 신호: `GET /v1/admin/ops-status`(`config.keyCustody.hsm`·신규 `ca.issuingSerial`·`assuranceLevel→HSM_ANCHORED`) + sign 명시 통지. 내부 서비스는 **신 CA 체인 신뢰 cutover만** 맞추면 됨(키 미보유라 영향 최소).

---

> 연계: `docs/02-design/hsm-key-custody-design.md`(비용·키수량) · `sign-to-his-kms-confirm.md`(KMS·assuranceLevel 합의) · `docs/06-ops/operations-guide.md` §3(키 커스터디)
