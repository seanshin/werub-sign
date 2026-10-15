# 문서 위변조 방지 설계 — 인증서 × 블록체인(해시체인+TSA)의 조화

> 전자동의서·판독보고서의 **위변조 방지·부인방지**를 위해 sign이 **PKI 인증서**와 **블록체인(감사 해시체인 + TSA 앵커)** 을 어떻게 결합하는지의 설계·구현·검증 문서.
> 기획 검토·EMR 인증 심사·법적효력 입증용. 코드 검증 완료.

## 0. 결론
문서 위변조는 **단일 수단이 아니라 4개 계층의 조화**로 막는다. 각 계층이 서로 다른 공격면을 담당하고, `verify`가 이를 한 번에 통합 검증한다.
- **인증서(PKI)** = 누가(신원·키 신뢰), **서명(해시)** = 문서 그 자체, **블록체인(해시체인)** = 기록·순서, **TSA 앵커** = 시점·전체 봉인.

## 1. 4중 방어 계층
| # | 계층 | 막는 공격 | 메커니즘 | 구현 |
|---|---|---|---|---|
| ① | **인증서(PKI)** | 신원 위조·키 도용 | HSM-앵커 2단 CA가 발급한 X.509. 서명자↔키 바인딩, 체인·CRL/OCSP | `ca.service`·`revocation.service` |
| ② | **서명(문서 무결성)** | **문서 내용 변조** | CMS(CAdES)/PAdES 서명이 **documentHash에 바인딩**(`documentHash\|signerRole`). 1바이트 변조→해시 불일치→검증 실패 | `signature.service`·`pades-signer.service` |
| ③ | **블록체인(감사 해시체인)** | **기록·순서 변조/삭제** | append-only. `entryHash=SHA256(prevHash+canonicalJson(data)+occurredAt+eventType)`, genesis ZERO. 한 칸 변조→이후 전부 깨짐 | `audit-chain.service` |
| ④ | **TSA 앵커** | **내부자 전체 재계산** | 체인 head를 RFC3161 TSA 토큰으로 시점봉인 → 전체 재계산해도 앵커 불일치로 탐지 | `audit-anchor.service` |

## 2. 조화 — 서명 시 무엇이 봉인되나
```
문서 PDF ──SHA-256──▶ documentHash
                          │
        ┌─────────────────┼──────────────────────────────┐
        ▼                 ▼                                ▼
  ② 서명값            ③ 감사 해시체인                  ① 인증서
  (인증서 키로          CREATED(documentHash)            (HSM-앵커 CA
   documentHash 서명)   → SIGNED(cert·role·관계)          발급, 키 신뢰)
        │              → COMPLETED                          │
        └──────────────────┬──────────────────────────────┘
                           ▼
                   ④ TSA 앵커(체인 head 시점봉인)
```
- 서명값은 **인증서 키**로 **documentHash**에 대해 생성(②×①) → 문서·신원 동시 결속.
- 그 사건(생성·본인확인·서명·완료)이 **해시체인에 순서대로 봉인**(③) → 사후 변조 탐지.
- 체인 head를 **TSA로 시점봉인**(④) → 시점 증명 + 전체 재계산 방어.

## 3. 위변조 시나리오별 탐지 매트릭스
| 공격 | 결과 | 탐지 계층 | verify 신호 |
|---|---|---|---|
| 동의서 PDF 내용 변조 | 해시≠서명대상 | ② | `cryptoVerify=false` |
| 위조 서명 주입 | 키/체인 불일치 | ①② | `cryptoVerify`/`chainValid=false` |
| 폐기된 키로 서명 | 폐기 시점 | ①(OCSP) | `notRevoked=false` |
| 감사기록 1건 변조 | 체인 끊김 | ③ | `auditChainValid=false` |
| 감사기록 삭제·재정렬 | prevHash 불일치 | ③ | `auditChainValid=false` |
| 내부자 전체 체인 재계산 | head≠앵커 | ④ | 앵커 검증 실패 |
| 만료 후 과거 서명 부인 | 시점 봉인 | ②(LTV)·④ | `ltvValid`/`timestampValid=true` 유지 |
| 저장소 키순서 변조(JSONB) | canonical로 안정 | ③ | 영향 없음(정렬 봉인) |

## 4. 통합 검증 — `GET /v1/verify/:id` (6중)
하나라도 깨지면 `overall:false`:
```jsonc
{ "overall": true,
  "signatures":[{ "cryptoVerify":true,   // ② 문서·서명
                  "chainValid":true,     // ① 인증서 체인
                  "notRevoked":true,     // ① OCSP/CRL
                  "timestampValid":true, // ④ TSA
                  "ltvValid":true }],    // ②④ 장기검증
  "auditChainValid": true }              // ③ 블록체인
```

## 5. canonical-json (저장소 무결성)
해시체인·서명 직렬화는 **재귀 키정렬(canonical-json)** 으로 계산 → PostgreSQL JSONB 등 키순서 미보존 저장소에서도 해시가 안정. (`domain/canonical-json.ts`. 키순서 변조로 체인을 흔드는 공격 차단.)

## 6. EMR 인증·법적효력 대응
| 요구 | 충족 |
|---|---|
| 무결성(위변조 방지) | ②③④ — 문서·기록·시점 3중 봉인 |
| 부인방지 | ① 인증서(HSM-앵커) + ④ TSA 시점 + ③ 감사체인 |
| 신원확인 | 본인확인(PASS/대면) 강결합 → 감사 봉인(IDENTITY_VERIFIED) |
| 장기검증(LTV) | PAdES-LTA — 만료·폐기 후에도 과거 서명 검증 |
| 감사추적 | 감사추적인증서(PAdES PDF) + 해시체인 조회 |

## 7. 한계 + 확장축
- 여기서 "블록체인"은 **외부 퍼블릭 체인이 아니라 내부 검증가능 해시체인 + TSA 앵커**(tamper-evident ledger). 변조 탐지·부인방지에 충분.
- **확장(요구 시)**: 공인 TSA(법적효력 강화) · 외부 퍼블릭 앵커(공개 타임스탬프/퍼블릭 원장에 head 해시 등록) — 동일 `TsaProvider`/앵커 포트로 교체.

## 8. 구현·검증 위치
- 코어: `audit-chain.service`(해시체인)·`audit-anchor.service`(TSA앵커)·`signature.service`(서명·검증)·`pades-signer.service`(PAdES)·`ca.service`(PKI)·`domain/canonical-json.ts`.
- 검증: `GET /v1/verify/:id`(6중) · 증거: `GET /v1/requests/:id/audit-certificate`(PAdES PDF) · 감사조회: `/requests/:id/audit`·`/audit/verify`.
- e2e: increment 시리즈(체인·LTV·감사앵커·canonical) + `scripts/pki-proof.mjs`·`pades-proof.mjs`.

> 연계: `hsm-single-custody-architecture.md`(블록체인 의미·HSM 단독수탁) · `certificate-issuance-authority.md`(발급 권위)
