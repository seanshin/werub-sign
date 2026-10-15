# sign 통합 테스트 기획서 — 자동화 중심 (Automated Integration Test Plan)

작성: 2026-06-29 · 대상: QA/개발/연동팀 · 기준: v1.5.2 + 미릴리즈(2FA·SSE·필터)
원칙: **모든 통합 시나리오를 자동 실행 가능하게** 한다. 실 외부 사업자(PASS/알림톡/KMS) 품질만 범위 밖.

---

## 1. 목적·원칙
- 컴포넌트·서비스·UI·외부팀 경로를 **반복 가능한 자동 테스트**로 검증(수동 의존 최소화).
- **단일 명령(CI 게이트)으로 전 회귀** 실행 → 전 PR/배포 차단 조건.
- 외부팀(HIS/PACS/ERP)·벤더는 **mock 하니스로 계약을 자동 검증**(실 합동은 그 위에 1회 얹음).
- 수용 기준은 코드 단언으로 표현(법적효력·EMR·ISMS-P 추적).

## 2. 자동화 레벨·도구
| 레벨 | 대상 | 도구 | 현황 | 산출물 |
|---|---|---|---|---|
| **L1 계약** | 저장소·query 변환 | ts-node `*.contract.ts` | ✅ | `prisma-store.contract`, `consumer-rotation.contract` |
| **L2 백엔드 e2e** | HTTP 실서버 전 경로 | node `*.e2e.mjs` | ✅ ~34 | `npm run e2e` |
| **L3 라이브 스모크** | 운영/스테이징 헬스·계약 | node(읽기전용 GET) | ✅ 스크립트화 | `scripts/smoke.mjs`, `npm run smoke:live` |
| **L4 UI E2E** | 콘솔·포털 브라우저 | **Playwright** | ✅ 1차(9 테스트)·확장중 | `web/tests/e2e/*.spec.ts`, `npm run e2e:ui` |
| **L5 3자 합동(mock)** | HIS+PACS+ERP 종단 | node mock 하니스 | ✅ 통합(`e2e` 편입) | `test/joint-3party.e2e.mjs` |
| **L6 비기능** | 접근성·부하 | axe-core/Playwright·k6 | ✅ 접근성(axe) 도입 / 부하 예정 | `web/tests/e2e/a11y.spec.ts`, `test/load/*`(예정) |

> L4/L5/L6 신규 구축 = §5 로드맵. 구축 후 전부 **`npm run e2e:all`(신규)**로 단일 게이트화.

## 3. 기존 자동 커버리지(L1·L2) — 유지·회귀 게이트
`npm run e2e` = increment3~22 + 아래(전부 통과 = 머지 조건).

| 영역 | 테스트 | 검증 골자 |
|---|---|---|
| 폐기·SSO·Webhook | `increment3` | CRL/OCSP·STAFF SSO(aud=sign)·Webhook·HMAC |
| 본인확인 결합 | `increment6,14` | 비대면 PASS 강결합·프록시 분리 |
| PAdES/CMS/X.509/LTV | `increment7,8,9,10` | 표준 서명·감사인증서 PDF·CMS |
| 감사 TSA 앵커 | `increment11` | head 봉인·위변조 탐지 |
| 키 프록시·HSM | `increment12,22` | crypto-proxy·PKCS#11(SoftHSM2)·attestation |
| CA 영속·회전 | `increment13` | 재기동 영속·Issuing 회전·이력 |
| 포털·발송·철회·만료 | `increment15,16` | 포털 토큰·알림·철회·만료 배치 |
| Webhook 재시도·facade | `increment17,18` | DEAD·reconcile·sign-requests |
| 운영·PROXY | `increment19,20` | readiness·ops-status·대리서명 |
| EXTERNAL 계약 | `external-contract` | 골든 계약·assuranceLevel |
| ERP 다자 | `erp-track-a, erp-multisig, erp-multisig-mixed` | signers[]·PORTAL+STAFF·순차 409·완료 echo |
| HIS 연동(mock) | `integration-his` | JWKS·SSO·Webhook 종단 |
| RBAC·세션 | `rbac, session-registry` | 역할·idle 서버강제·동시세션·즉시폐기 |
| 2차 인증 | `mfa-2fa` | TOTP·복구코드 1회용·해제 |
| 실시간 | `sse-events` | SSE 인증·X-Accel-Buffering·이벤트 |
| 목록·검색·CSV | `search, pagination, export-csv` | 푸시다운·필터·BOM·마스킹·401 |
| 개정 | `supersede` | SUPERSEDED·버전 체인 |
| 하드닝·설정 | `hardening-ratelimit, integration-settings, settings-security, webhook-internal-host` | H3/H4·SSRF·봉인·내부호스트 |
| 스케줄러·키회전 | `scheduler-consumers` | 인앱 배치·무중단 회전 |
| 영속화 | `prisma-store.contract, prisma-live(PG)` | query·라운드트립·canonical-json |

## 4. 도메인별 자동 시나리오 (전부 자동 매핑)
구분: ✅기존자동 · 🅰️신규자동(추가) · 🅿️Playwright(UI) · 🅼Mock하니스. **수용 기준=코드 단언.**

### A. PKI·서명 코어
| ID | 시나리오 | 수용 기준(단언) | 자동화 |
|---|---|---|---|
| A1 | 발급→서명→검증 | overall·chainValid·cmsValid·ltvValid·auditChainValid=true | ✅ increment7-11 |
| A2 | 폐기·폐기시점 검증 | 폐기후 신규 409·기존 폐기시점 유효 | ✅ increment3 |
| A3 | 위변조 탐지 | 변조 시 false·head 불일치 | ✅ increment11,22 |
| A4 | 재기동 내성 | 재기동 후 검증 유지·신규 발급 | ✅ `restart.e2e`(파일저장소+proxy 재기동·영속·신규발급) |

### B. 다자·순차 서명
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| B1 | PORTAL 다자 순차 | 역순 409·단일 completed | ✅ erp-multisig |
| B2 | PORTAL+STAFF 혼합 | 채널 분기·certSerial echo | ✅ erp-multisig-mixed |
| B3 | PROXY 대리 | 관계 봉인 | ✅ increment20 |
| B4 | 신규입사 자동 임시 인증서 | WITNESS 자동 발급 | ✅ erp-multisig |

### C. 환자 포털
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| C1 | 열람→본인확인→서명→결과(API) | 단계 분기·강결합·1회용·48h | ✅ increment15 |
| C2 | 포털 UI 종단(브라우저) | 단계 렌더·서명 성공 화면 | ✅ `portal-sign.spec`(열람→동의서명→완료·잘못된토큰) |
| C3 | 고위험 APP_STEPUP | 정보없음 403·재인증 201 | ✅ increment6 |
| C4 | 포털 접근성(글씨/고대비) | axe serious/critical 0 | ✅ `a11y.spec`(포털 scan, 발견 대비위반 수정) |

### D. HIS/PACS/ERP 연동 (mock 하니스)
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| D1 | HIS EXTERNAL 종단 | facade→서명→webhook(HMAC·ref·assurance) | ✅ integration-his |
| D2 | 소비자 webhook 시크릿 격리 | ERP↔HIS 비교차 | ✅ erp-track-a |
| D3 | STAFF sub↔externalSignerRef 정합 | 불일치 403·일치 echo 키 일치 | ✅ erp-multisig-mixed |
| D4 | per-signer portalUrl relay | signers[].portalUrl 반환·키 매핑 | ✅ erp-multisig-mixed |
| D5 | Webhook 유실·복구 | 다운→FAILED→재시도 SENT·reconcile | ✅ increment17 |
| D6 | **3자 동시(HIS+PACS+ERP) 종단** | 독립 3봉투·출처귀속·webhook 교차없음·시크릿격리·완료본 | ✅ `joint-3party.e2e`(mock 3팀, `e2e` 편입) |

### E. 본인인증·발송 벤더 (mock + 드롭인 계약)
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| E1 | PASS/명의 provider 전환 | 설정/프록시 드롭인·CI 미저장(HMAC) | ✅ increment14 |
| E2 | 알림톡/SMS·마스킹 | 끝4자리·미저장·이력 | ✅ increment16 |
| E3 | 실 사업자 어댑터 계약(스텁) | provider=실값 시 REST 호출 형태 | 🅰️ `vendor-contract.e2e`(스텁 서버로 호출 골든) |

### F. 키 수탁·HSM
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| F1 | SOFT FileVault | 재기동 영속 | ✅ increment13 |
| F2 | PKCS#11(SoftHSM2) | CA앵커 HSM·assurance=HSM_ANCHORED | ✅ increment22 |
| F3 | KMS cutover(스텁) | keyRef hsm:·assurance 전환 | 🅰️ `kms-cutover.e2e`(KMS 모의/스텁, 실계정은 go-live) |

### G. 관리자 인증·세션·2FA
| ID | 시나리오 | 수용 기준 | 자동화 |
|---|---|---|---|
| G1 | RBAC 역할 스코프 | admin/operator/viewer·마지막 admin 보호 | ✅ rbac + 🅿️ `rbac-users.spec`(콘솔 계정생성·역할변경) |
| G2 | 비활동 자동 로그아웃(F004) | idle 후 서버 401·운영 0금지(15강제) | ✅ session-registry |
| G2u | idle UI(경고·백그라운드 복귀 재검사) | 경고 모달·자동 로그아웃(reason=timeout) | ✅ `idle.spec`(Playwright clock 14분→경고·15분→로그아웃) |
| G3 | 동시세션·즉시폐기·전역401 | 축출·폐기·로그인 전환 | ✅ session-registry + 🅿️ `ui/session.spec` |
| G4 | 2FA(TOTP) | mfaRequired→verify·복구코드 1회용·해제 | ✅ mfa-2fa |
| G4u | 2FA 등록 UI(QR·활성화) | 내 계정 설정→코드→복구코드 표시 | 🅿️ `ui/mfa-enroll.spec` |
| G5 | break-glass 폴백 | 키 복구·최소권한 | ✅ rbac |

### H. 운영·관리
| ID | 시나리오 | 자동화 |
|---|---|---|
| H1 CRL/OCSP·CA 회전 | ✅ increment3,13 |
| H2 API 키 무중단 회전 | ✅ scheduler-consumers |
| H3 스케줄러(retry·expire) | ✅ scheduler-consumers, increment16,17 |
| H4 metrics·readiness | 🅰️ search.e2e(metrics) + 🅿️ `ui/system.spec` |

### I. 목록·UI
| ID | 시나리오 | 자동화 |
|---|---|---|
| I1 검색·필터·푸시다운 | ✅ search + 🅿️ `ui/dashboard.spec` |
| I2 CSV 내보내기 | ✅ export-csv + 🅿️(다운로드 트리거) |
| I3 일괄(철회·폐기) | ✅(API) + 🅿️ `ui/bulk.spec` |
| I4 실시간 SSE 자동 갱신 | ✅ sse-events + 🅿️ `ui/realtime.spec` |
| I5 다크모드·접근성 | ✅ `a11y.spec`(로그인·대시보드·내계정·다크·포털 axe, serious/critical 0) |
| I6 검증 탭 미서명 표시 | 🅿️ `ui/verify-tab.spec` |

### J. 보안 하드닝
| ID | 시나리오 | 자동화 |
|---|---|---|
| J1 H3 PII 인증 · J2 H4 rate-limit · J3 M1 SSRF · J5 봉인/마스킹 | ✅ hardening-ratelimit, webhook-internal-host, settings-security |
| J4 보안 헤더(helmet/HSTS) | ✅ `headers.e2e`(nosniff·frameguard·CORP·X-Powered-By 제거·HSTS 게이트) |

### K. 영속화·재기동·마이그레이션
| ID | 시나리오 | 자동화 |
|---|---|---|
| K1 Prisma 라이브(PG) | ✅ prisma-live(PG 환경) |
| K2 마이그레이션 0001~0004·백필 | ✅ `migrate.e2e`(실 PG: 컬럼 존재+푸시다운 searchText·signMode·createdBy·status 동작, CI postgres 잡) |
| K3 푸시다운 인덱스 정합 | ✅ prisma-store.contract, search |

## 5. 자동화 신규 구축 로드맵 (우선순위)
| 순번 | 항목 | 산출물 | 규모 | 효과 |
|---|---|---|---|---|
| 1 | **UI E2E(Playwright)** ✅ **완료**(19 테스트) — 로그인·로그아웃·보호라우트·목록·검색·상태필터·CSV·일괄철회·실시간SSE·검증탭·2FA·포털서명·idle자동로그아웃·접근성(axe) | `web/tests/e2e/*.spec.ts` + `playwright.config.ts` + `npm run e2e:ui` | L | L4 수동 제거, G1·G2u·G3·G4u·I1~I4·I6·C2 자동 |
| 2 | **3자 합동 mock 하니스** ✅ **완료** — 동시 3봉투·출처귀속·webhook 교차없음·시크릿 격리(ERP 전용/HIS·PACS 공유)·키 스코프 | `test/joint-3party.e2e.mjs`(`e2e`·`e2e:joint` 편입) | M | D6 자동, 실 합동 리스크 사전 제거 |
| 3 | **접근성 axe CI** ✅ **완료** — 로그인·대시보드·내계정·다크모드 scan, serious/critical 0 게이트. 발견한 실제 대비/aria 위반(사이드바·Toast·다크모드) 수정 | `web/tests/e2e/a11y.spec.ts`(`e2e:a11y`) | S~M | KWCAG 회귀 방지(C4·I5) |
| 4 | **라이브 스모크 스크립트** ✅ **완료** — 읽기전용 GET: /health·/health/ready·/v1/crl(공개) + ops-status·SSE(event:ready)·CSV(인증) | `scripts/smoke.mjs`(`npm run smoke:live [URL]`, `SMOKE_API_KEY`) | S | 배포 후 1-클릭 검증(L3) |
| 5 | **응답 헤더·재기동 e2e** ✅ **완료**(J4·A4) — helmet 헤더+HSTS 게이트, 파일저장소+proxy 재기동 후 검증/영속. 마이그레이션(K2)은 CI postgres 잡으로 완료(`migrate.e2e`·`prisma-live`) | `test/headers.e2e.mjs`·`test/restart.e2e.mjs`(`e2e` 편입) | S | J4·A4·K2 자동 |
| 6 | **부하(선택)** | `test/load/*`(k6, 목록 1만건+·SSE 동시) | M | K3·I4 스케일(데이터 누적 시) |
| — | **단일 게이트** ✅ | `e2e:all` = e2e(+joint·headers·restart) + contract:prisma + e2e:ui(+a11y) | — | CI 머지/배포 차단 |
| 6 | **부하(선택)** | k6 — 데이터 누적 시 측정(현 소량). 미구축(보류) | M | K3·I4 스케일 |

## 6. CI 게이트·실행
- **PR/머지**: `npm run e2e`(joint·headers·restart 포함) + `contract:prisma` (필수). PG 가용 시 `e2e:prisma`. UI: `e2e:ui`(a11y 포함).
- **단일 게이트**: `npm run e2e:all` = e2e + contract:prisma + e2e:ui(+a11y). **GitHub Actions(`.github/workflows/ci.yml`)가 PR·main push 마다 자동 실행** — 2개 잡: `e2e-all`(외부 인프라 불요, increment22 자동 SKIP·FakePrisma) + `pg`(postgres:16 서비스, migrate deploy→prisma-live→reset→migrate K2). 실패 시 Playwright 리포트 아티팩트 업로드.
- **배포 후**: `npm run smoke:live [URL]`(라이브 스모크, `SMOKE_API_KEY` 시 인증 점검) 자동.
- **go-live 직전**: §4 D6 실 3자(실팀) 1회(P7 직전) — mock 하니스(`e2e:joint`)가 사전 통과 보장.

## 7. 수용 기준·추적성 (규정 ↔ 자동 시나리오)
| 규정 | 자동 시나리오 |
|---|---|
| 전자서명 법적효력 | A·B·C1·F |
| EMR F004 미사용 접속차단 | G2 |
| EMR F008 접속기록·F009 위변조 | A3·H·export-csv |
| EMR F010 전자서명·F005 암호화 | A·E·settings-security |
| ISMS-P 2.5/2.6(인증·세션·2FA) | G1~G5 |
| 개인정보 안전성(접속제한·마스킹) | G2·E2·settings-security |

## 8. 잔여(자동화 불가·외부 의존)
- 실 사업자(PASS/알림톡/AWS KMS) **자체 품질·실 자격증명** — mock·스텁 계약까지 자동, 실연동은 계약 후 1회 재검증(E1·E3·F3).
- 실 3자(실팀) 동시 합동 — mock 하니스(D6)로 계약 자동화, 실팀 합동은 go-live 직전 조율.
- 부하 한계점은 데이터 누적 시 측정(현 규모 소량).

---
**실행 요약**: 현재 `npm run e2e`(~34)+`contract:prisma`로 백엔드 전 경로 자동. 다음 자동화 = ①Playwright UI ②3자 mock 하니스 ③axe ④스모크 스크립트 → `e2e:all` 단일 CI 게이트.
