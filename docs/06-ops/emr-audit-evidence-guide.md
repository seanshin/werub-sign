# EMR 인증 보안성 — 심사 증빙 수집·시연 가이드

>
> 심사 시 평가위원에게 "기준 → 구현 → 증거"를 즉석에서 보여주기 위한 문서다.

---

## 1. 자동 시연 스크립트 — `scripts/emr-security-demo.mjs`

라이브 인스턴스에 대해 **sign이 직접 충족하는 항목**(F010·F008·F009·F005/F006·F003)을 한 번에 시연하고 증빙 산출물을 모은다.

### 실행
```bash
# 내부망에서(권장): 운영 코어 직접 호출
BASE=http://127.0.0.1:4100 \
API_KEY=<requests:write+certificates:write 키>  \  # 예: CONSOLE_API_KEY
OUT=./emr-evidence \
  npm run emr:demo
```
- `API_KEY`: 관리 콘솔/HIS 기계 키(쓰기 스코프). 무키 실행 시 F003 검사만 가능.
- 산출물: `OUT/<timestamp>/` 에 `evidence-report.md`(요약표) + 항목별 JSON + 인증서 PEM + **감사추적인증서 PDF**.

### ⚠️ 실행 환경 주의 (webhook 부수효과)
- 스크립트는 **데모 서명 1건을 실제로 생성**한다(`externalDocId=EMR-DEMO-CONSENT`).
- 운영 인스턴스는 `HIS_WEBHOOK_URL`이 설정돼 있어, 데모 서명 완료 시 **HIS로 완료 webhook이 발화**(HIS에 EMR-DEMO 흔적 발생) 한다.
  - **권장**: 스테이징/시연 인스턴스(=`HIS_WEBHOOK_URL` 미설정)에서 실행, 또는 시연 후 P7 clean-reset로 데모 데이터 정리. 운영 시연 시 HIS팀에 사전 공유.
- 읽기 검증(verify/audit)만 필요하면 기존 운영 requestId로 §3 수동 절차 사용.

### 산출물 매핑
| 산출물 | 증빙 항목 |
|---|---|
| `evidence-report.md` / `.json` | 전체 항목별 PASS/INFO 요약표 |
| `00-ops-status.json` | F003/F004/F005 활성 통제(하드닝·keyCustody) |
| `10-enroll.json`·`10-certificate.pem` | F010 인증서(계정) 발급 |
| `11-request.json`·`12-submit.json` | F010 서명요청·서명(본인확인 강결합) |
| `13-verify.json` | F010 서명값 검증(공개키·TSA·체인·CMS)·부인방지 attestation |
| `08-audit-trail.json` | F008 감사 해시체인(who·when·what) |
| `09-audit-verify.json` | F009 위변조 무결성(체인+TSA앵커) |
| `10-audit-certificate.pdf` | F010/F009 표준 PAdES 서명 감사추적인증서 |

---

## 2. 항목별 증빙 — 기준·증거·확인 방법

| # | 보안성 항목 | 증거(산출물/엔드포인트) | 자동 | 비고 |
|---|------------|------------------------|:--:|------|
| F010 | 전자서명 | 인증서 발급 → 서명 → `GET /v1/verify/:id`(`overall/cryptoVerify/timestampValid/chainValid/ltvValid` true) + 감사인증서 PDF | ✅ 스크립트 | sign 핵심. 계정(인증서)·서명값·일시 전부 증빙 |
| F008 | 접속기록 생성 | 응답 `x-request-id` + 구조적 접속로그(서버 stdout/로그수집) + `GET /v1/requests/:id/audit`(해시체인) | ✅ 스크립트 | 접속로그는 §4 로그수집 연동 권장 |
| F009 | 수정이력·위변조방지 | `GET /v1/requests/:id/audit/verify`(`valid/chainValid/anchored/anchorTsValid` true) | ✅ 스크립트 | 내부자 재계산 위변조도 TSA앵커 불일치로 탐지(`test/increment11.e2e.mjs`) |
| F005 | 고유식별정보 암호화 | 응답에 제출 CI 평문 부재(스크립트 자동 검사) + 코드: pepper HMAC·AES-256-GCM | ✅ 스크립트 | CI/전화 평문 미저장 |
| F006 | 마스킹 | 접근로그 `/portal/***` 마스킹(`access-log.interceptor.ts`) | ◐ 코드제시 | |
| F003 | 인증 실패/접근통제 | 무키 쓰기 `401`(스크립트) + rate-limit(하드닝) | ✅ 스크립트 | |
| F004 | 미사용 접속 차단 | STAFF SSO aud=sign 10분·포털토큰 48h 단일사용 만료 | ◐ 코드제시 | 세션 자체는 HIS |
| F001 | 계정·비밀번호 | sign: 키 분리·해시 보관·회전. 사용자 계정은 HIS | ◐ HIS주관 | |
| F002 | 권한·이력 | scope RBAC + 키/CA 회전 행위자 감사 | ◐ | |
| F007 | 비밀번호 일방향 암호화 | api-key 해시(set) 보관·평문 미저장 | ◐ | 사용자 비번은 HIS |
| F011 | 백업 | PostgreSQL 영속 + 키 FileVault 영속 + 볼륨. 백업정책은 운영 | ◐ HIS/인프라 | |
| F012 | 외부보관·클라우드 | 원내 구축형·키 원내 고정. 클라우드 HSM은 다이제스트만 송신 | ◐ HIS/운영 | 망정책 문서화 |

---

## 3. 수동 시연 절차 (스크립트 없이, 기존 운영 데이터로)

```bash
KEY=<api-key>; B=http://127.0.0.1:4100; RID=<운영 requestId>
# F010 서명 검증
curl -s $B/v1/verify/$RID | jq '.data | {overall, auditChainValid, assuranceLevel, sig: .signatures[0]}'
# F008 접속기록(감사 해시체인)
curl -s $B/v1/requests/$RID/audit -H "x-api-key: $KEY" | jq '.data | length, .[].eventType'
# F009 위변조 무결성
curl -s $B/v1/requests/$RID/audit/verify -H "x-api-key: $KEY" | jq '.data'
# F010 감사추적인증서 PDF
curl -s $B/v1/requests/$RID/audit-certificate -H "x-api-key: $KEY" -o audit-cert.pdf
# F003 무키 차단
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/v1/certificates/enroll  # → 401
```

---

## 4. 권장 보강 (심사 전)

- [ ] **접속로그 수집·보존(F008)**: 현재 구조적 JSON 로그를 stdout 출력 → ELK/Loki 등 수집·보존정책(기간·접근통제) 연동. (코드는 `ACCESS_LOG` 기본 on, `access-log.interceptor.ts`.)
- [ ] **HIS 분담 항목 증빙(F001~F004·F007·F011·F012)**: EMR 본체(HIS)가 사용자 계정·세션·백업·망분리로 충족, sign은 연동·서명·감사 분담임을 심사자료에 명시.
- [ ] **ISMS-P 보유 시 일부 면제**: 보유 인증으로 보안성 일부 항목 심사 면제 가능 여부 인증기관 확인.
- [ ] **F012 클라우드 HSM**: KMS cutover 시 원내망/DMZ 아웃바운드(다이제스트만 송신) 정책·근거 문서화([hsm-key-custody-design.md](../02-design/hsm-key-custody-design.md)).

---

*작성 2026-06-16. 스크립트 `scripts/emr-security-demo.mjs`(로컬 instance 검증: PASS 10/FAIL 0). 산출물은 `emr-evidence/`(gitignore).*
