# 키 수탁·HSM 최소화 설계 (비용 최적 × 인증기준)

> 기획 요구: **① 병원 모든 인증은 sign 경유 ② HSM 키는 최소·클라우드 발급 ③ 비용 최소 ④ 인증기준 준수**.
> 본 문서는 현 설계가 4개 요구를 어떻게 충족하는지 코드 근거와 함께 검증하고, 결정사항을 확정한다.

## 0. 결론
현 설계는 4개 요구를 **이미 충족**한다. 핵심은 **HSM에 올리는 키를 CA 트러스트 앵커 2개로 고정**하고, 빈번한 연산(말단 서명·타임스탬프)은 SOFT로 처리해 **서명 건당 HSM 비용을 0으로** 만든 점이다. 트러스트는 HSM-앵커 CA의 인증서 서명 사슬로 전파되므로, 말단키를 HSM에 넣지 않아도 "HSM 보호 트러스트"가 성립한다.

---

## 1. ① 병원 모든 인증/서명은 sign 경유
- sign이 **유일한 CA·서명·검증 권한**(독립 트러스트 서비스). HIS(동의서)·PACS(판독/영상동의)·환자앱이 모두 sign으로 발급·서명·검증을 라우팅.
- 신원 인증(로그인)은 HIS가 IdP(SSO 발급), sign은 **JWKS로 검증 + 서명**(aud=sign 강제, sub↔externalSignerRef 바인딩). → "로그인"은 HIS, "전자서명 트러스트"는 sign으로 역할 분리(설계 의도).
- **유일한 우회 경로**: HIS 레거시 `SIMULATION`(내부 mock 서명). `signProvider` 토글로 `EXTERNAL`(sign) 전환하며 제거. **go-live 권고: 파일럿 후 운영 기본 `sign.mode=EXTERNAL`, prod에서 SIMULATION 비활성** → 그 시점 "모든 서명 sign 경유" 강제 성립.

## 2. ②③ HSM 키 최소화 · 클라우드 발급 · 비용 최소
### 키별 수탁 위치 (코드 근거)
| 키 | 용도 | 수탁 | 빈도 | 근거 |
|---|---|---|---|---|
| **Root CA** | 트러스트 앵커(Issuing 인증서 서명) | **HSM** | 1회+회전 | `ca.service.ts:94` `keyClass:'HSM'` |
| **Issuing CA** | 말단 인증서 발급 서명 | **HSM** | 발급 건당 | `ca.service.ts:104` `keyClass:'HSM'` |
| 말단(환자·의료진) | 문서 서명 | **SOFT** | **서명 건당** | `ca.service.ts:127`(keyClass 없음) |
| 자체 TSA | 타임스탬프 | **SOFT** | **서명 건당** | `self-tsa.provider.ts:45` |

→ **클라우드 HSM 상주 키 = 2개**(CA 앵커). AWS KMS `CreateKey(SIGN_VERIFY)`로 발급, 개인키 KMS 상주·다이제스트만 송신(`AwsKmsKeySigner`).

### 비용 모델 (왜 최소인가)
- KMS **키 보관료**: 2키 × 약 $1/월 = **~$2/월**(고정·미미).
- KMS **서명 연산료**: **인증서 발급 시에만** Issuing CA가 1회 호출(환자/의료진 등록 빈도). **문서 서명·타임스탬프는 SOFT라 KMS 호출 0** → 서명량이 폭증해도 HSM 연산비 불변.
- 대조군(말단키도 HSM): 서명 건당 KMS Sign 호출 → 동의서·판독보고서 수만 건/월 시 연산비 선형 증가. **현 설계가 이를 회피**.

### 더 줄일 여지 (선택)
- Root CA를 **오프라인 발급**(에어갭) 후 Issuing만 클라우드 HSM 상주 → 클라우드 HSM 1키. 단 2-tier 표준·운영 단순성 위해 **2키 유지 권장**(증분 비용 무의미).

## 3. ④ 인증기준 준수
| 기준 | 충족 방식 |
|---|---|
| **FIPS 140-2 L3**(HSM) | CA 앵커키 AWS KMS/CloudHSM = L3. **트러스트가 L3 모듈에 귀착** |
| **EMR 인증제 보안성** | 접근통제(api-key+SSO+scope)·암호화(AES-256-GCM)·**감사 해시체인+TSA 앵커링**·CRL/OCSP. 환자 PHI 원본 미보관(CI/전화는 HMAC 해시만) |
| **부인방지** | 서명 검증 사슬이 **HSM-앵커 CA**에 귀착 + attestation(keyCustody/signAttestationRef) + 감사체인 + TSA 시점확인. 말단키 SOFT는 AES-256-GCM 수탁·접근통제로 보호 |
| **KCMVP** | 민간 의료법인 **비강제**. 공공/적격 확장 시 동일 `KeySigner` 포트로 검증필 모듈 교체 |
| **알고리즘** | RSA-3072·SHA-256(표준). 말단도 RSA-3072 |

> **말단키 SOFT의 정당성**: 전자서명의 신뢰 근거는 *서명자 키 자체*가 아니라 *그 키를 보증하는 인증서가 누구(=HSM CA)의 서명으로 발급됐는가* + 시점·감사 증거다. HSM-앵커 CA + attestation + TSA + 감사체인이 SOFT 말단키의 부인방지를 보강한다. 법적 적격(공인전자서명) 등급이 요구되는 특정 동의서 유형이 생기면 **해당 유형만** `keyClass=HSM` 선택 적용(비용 국소화).

## 4. 확정 결정
1. **HSM 상주 키 = CA Root·Issuing 2개로 고정**(`keyClass:'HSM'`). 말단·TSA는 SOFT.
2. 말단키 HSM 확장 **미채택**(HIS R1~R5 회신 반영) — 트러스트 동일·건당 비용만 증가.
3. 조달: 원내 구축형이면 **온프레 HSM(PKCS#11)**, 신속 가동이면 **AWS KMS**. 어느 쪽이든 키 수량·비용 모델 동일(2 앵커키).
4. 가시성: `/v1/admin/ops-status` `config.keyCustody.{hsmScope,leafKeys,tsaKeys}`로 정책 감사 가능. proxy 모드 시 crypto-proxy `/stats`의 `requestedHsm/backendHsm`로 실제 HSM 호출 수 모니터.
5. "모든 서명 sign 경유" 강제: HIS `signProvider EXTERNAL` 전환 완료 시점에 성립(P1 게이트).

> 연계: `docs/05-handoff/sign-to-his-hsm-answers.md`(HIS 회신) · `docs/06-ops/operations-guide.md` §3(키 커스터디·HSM·KMS)
