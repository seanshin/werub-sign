# sign 문서 인덱스

의료/IT 전자서명 트러스트 서비스 `sign` — PDCA 산출물 + 연동/운영 문서.
> 프로젝트 개요·실행·API: 루트 [`../README.md`](../README.md)

## 단계별 (PDCA)
| 단계 | 문서 | 내용 |
|---|---|---|
| **Plan** | `01-plan/features/의료-전자동의서-플랫폼.plan.md` | 요구사항·FR-01~23·NFR |
| | `01-plan/schema.md` · `01-plan/conventions.md` | 데이터 스키마 · 코딩/보안 규약 |
| | `01-plan/backlog-roadmap.md` ⭐ | **잔여 개발 로드맵**(트랙 A 코드 순서·트랙 B 외부 대기·트랙 C 경량 후속·트랙 D 감사 후속) |
| | `01-plan/audit-2026-07-28-followups.md` | 코드 감사(2026-07-28) 취합 — **R1~R16 · D1~D7 전건 종결**(마지막 2건 R9·R16 = v1.26.0) |
| | `01-plan/security-enhancement-plan.md` ⭐ | **보안 강화 보완 계획(트랙 S)** — 코드 실측 기반 갭 분석(T1~T8)·보완 S1~S11·우선순위. **P0 전건 완료** — S1 앵커 이중화(v1.27.0)·S6 공급망 CI(v1.27.2)·S7 백업 자동화(v1.28.0)·S3 CSP(v1.28.0, report-only→enforce 관찰 중) + **S9 능동 알림(v1.29.0)**. 잔여 P1 = S2 WebAuthn·S4 마스터키 kid/envelope·S5 LTA 재TS |
| **Design** | `02-design/features/의료-전자동의서-플랫폼.design.md` | 설계 v0.5(아키텍처·시퀀스·신뢰경계) |
| | `02-design/signing-flows.md` ⭐ | **서명·연동 흐름 통합**(HIS·PACS·ERP·포털·개정·webhook·RBAC·망) |
| | `02-design/integration-hospitalrun.md` | HIS 연동 설계 |
| | `02-design/features/general-contracts.design.md` ⭐ | **일반 전자계약 트랙**(준비→발송→체결→관리) 설계 **v1.2 as-built**(v1.9~v1.22 구현 반영 — §10 ①~⑰) |
| | `02-design/contract-management-ui-plan.md` | 전자계약 콘솔 UI 기획 v0.4 as-built(계약 현황·계약함·서식·주소록·카테고리·U1~U5 완결) |
| | `02-design/features/electronic-approval.design.md` | 전자결재(상신→결재) 설계 — 콘솔 메뉴 숨김·플래그 OFF 보존 |
| | `02-design/features/portal-document-preview.design.md` | 포털 문서 미리보기(Option A) — 플래그 OFF |
| | `02-design/features/fill-at-signing.design.md` | 포털 서명자 입력란 직접 기재 — **v1.1 as-built**(v1.13 봉인+합성, v1.15 입력 타입·박스 맞춤·증적 조회) |
| **Check** | `03-analysis/의료-전자동의서-플랫폼.analysis.md` | 갭 분석 |
| **Report** | `04-report/의료-전자동의서-플랫폼.report.md` ⭐ | 완료 보고서(Inc1~20·배포·연동·보안, Match Rate ~95%) |
| **Handoff** | `05-handoff/api-catalog.md` ⭐ | **API 카탈로그**(인증 4경로·스코프·오류·webhook 계약·엔드포인트 158건 — 연동/SaaS 온보딩 기준) |
| | `05-handoff/README.md` ⭐ | **연동 문서 인덱스**(HIS·PACS·환자앱·파일럿) |
| **Ops** | `06-ops/go-live-runbook.md` ⭐ | **실서비스 전환(go-live) 단일 체크리스트**(벤더·P7/KMS/P8·H2·검증) |
| | `06-ops/operations-guide.md` | 배포·키 커스터디·mTLS·HSM·하드닝 상세 |
| | `06-ops/backup-restore-runbook.md` ⭐ | **백업·복구 런북(S7)** — 일별 암호화 백업 구성·분기 복구 리허설(성공 기준=복원본 위 `audit/verify` 그린)·재해 복구 |
| | `06-ops/clean-reset-runbook.md` | P7 운영 DB clean-reset 절차 |

## 현황 (2026-07-29, **라이브 v1.27.0** — 저장소 v1.27.1: 주석·문서 릴리즈, 런타임 동일)
- 🟢 운영 배포 라이브: `https://sign.example.org` · 내부 `http://127.0.0.1:4100/v1`(컨테이너 `sign-core:4000`) · go-live 하드닝 활성·인앱 스케줄러 가동
- ✅ 트러스트 코어·프론트 SPA·**HIS·PACS·ERP·edu·weRub 연동 라이브**·연동 설정 콘솔·운영 매뉴얼·**다중관리자 RBAC**·**서버측 검색**·**문서 개정 재동의(C-2)**·다중봉투 서명·소비자별 webhook 시크릿 격리
- ✅ **일반 전자계약 트랙 완결**(v1.9~v1.22): 준비→발송→체결→관리 + 서식 36종·fill-at-signing·첨부·프리셋·교부 셀프서비스·표 조판(병합·음영·헤더 반복)
- ✅ **코드 감사 전건 종결**(2026-07-28, 4개 에이전트 병렬) — 처리 19건 + **R1~R16 전건** + **정책 D1~D7 전건 반영**(D5 = 프리셋 수정 공용·삭제 생성자/admin 제한·감사 봉인, v1.23.0). 마지막 2건은 v1.26.0 — **R9 첨부 청크 스트리밍**(피크 힙 = 청크 1개·청크별 해시를 방출 전 검증·기존 첨부는 dual-read 로 무이관)·**R16 저장소 수준 동시성**(메타 슬롯 CAS + 감사 체인 `(rkey, prevHash)` 유니크 인덱스로 분기 차단) → `01-plan/audit-2026-07-28-followups.md`
  - ✅ **migration 0009 라이브 적용 완료**(2026-07-29) — 사전 점검 감사분기 0·meta중복 0, pg_dump 백업 후 적용, 인덱스 2종 생성·**행수 전후 동일(유실 0)**·스모크 6/6·감사체인 `valid`. 신규 설치·타 기관 배포 시에도 **배포 전 점검 SQL 필수**(기존 분기가 있으면 마이그레이션이 의도적으로 실패) → `06-ops/operations-guide.md` §1.2
- ✅ **웹훅 적체 0건** — edu 26건 재발송 종결 + 구 ERP 주소 2건 폐기(v1.24.0 `webhook-discard`: 사유 필수·`DISCARDED` 보존·감사 봉인)
- ✅ **API 표면 정리 완료**(v1.25.0) — 오퍼레이션 158건 전건 그룹(11 태그)·설명·인증 방식 표기(`x-required-scope`/`x-auth`), 스펙 기반 카탈로그 자동 생성(`npm run api:catalog`)
- ✅ **보안 P0 트랙 종결 + 능동 알림**(v1.27.2~v1.29.0, 2026-08-04) — **S6 공급망 CI 게이트**(npm audit prod 하드게이트·lockfile-lint·Semgrep(프라이빗 저장소라 CodeQL 대체)·trivy OS 스캔, 예외는 사유 필수 `.audit-allowlist.json`) · **S7 백업 자동화**(일별 gpg 암호화·오프사이트·복구 리허설에서 **복원본 감사체인 verify 8/8 valid** 실증) · **S3 CSP**(nonce 기반, 라이브 report-only 관찰 중 — UI E2E 는 항상 enforce 로 돌려 실차단 회귀 검증) · **S9 능동 알림**(백업 중단·감사체인 붕괴·로그인 폭주·웹훅 DEAD·ready 실패 → 이메일. **백업은 "성공 신호의 부재"로 중단을 판단** — S7 의 짝)
- ✅ **백업 복구 + 운영알림 스로틀**(v1.30.1, 2026-09-10) — **운영 릴리즈(앱 코드 무변경)**. 9/9 ML 서버 이관 때 백업 크론만 누락돼 **3일간 백업 정지**했던 사고의 수습. 하트비트를 **로컬 산출물 완성 직후**로 옮겨(종전엔 오프사이트 rsync 뒤라 `set -e` 아래 **오프사이트 실패가 "백업 없음"으로 둔갑**) + 오프사이트를 `SIGN_BACKUP_OFFSITE=pull|push` 로 분리(구 오프사이트 호스트 소멸 → 운영자 Mac 04:30 회수). 라이브 반영 = **v1.30.0 배포 완료**(이관 후 첫 배포)·백업 크론 재등록·`ALERT_THROTTLE_MIN` 60→10080(7일). 기록 = 운영가이드 §5c(사고)·§5d(배포)·백업 런북 §1
- ✅ **콜백 정정 API + 코드 리뷰 후속**(v1.30.0, 2026-08-26) — 수신 URL 변경 사고(2026-08-08)의 코드 후속 **`callback-retarget`**(저장 요청의 콜백 주소 일괄 정정·기본 dryRun·SSRF 검증·감사 봉인)에 더해, **4관점 전면 코드 리뷰**(보안·동시성·성능·웹) 반영. 근본은 요청 봉투·웹훅 레코드의 last-write-wins 경합 → **요청 단위 직렬화**(submit·withdraw·expire·supersede)·**스케줄러 재진입 가드**(리마인더 이중 발송 차단)·**발송 전 CAS**(알림·교부 캡)로 마감. 보안 = 웹훅 재지정 SSRF 검증 누락·리다이렉트 우회 차단·URL 자격증명 마스킹·CORS 풋건 제거. 성능 = 서명 hot path·5분 감시 틱의 KV 전량 스캔을 JSON-path 푸시다운으로 전환(라이브 PG 실측). **보류분(ops:write 스코프·DNS 리바인딩·세션토큰 쿠키화 등)은 배포결합/위험>버그로 `01-plan/backlog-roadmap.md`·`security-enhancement-plan.md` 에 사유와 함께 등재**
- ✅ **감사 앵커 이중화 라이브**(v1.27.0, 보안 트랙 S1) — 자체 TSA 키는 운영자 수중이라 앵커가 운영자 독립 증거가 아니었다(T1) → **외부 RFC3161 TSA(freeTSA) 토큰을 전 앵커에 병기** + 주기 스윕(미앵커였던 관리 스트림 갭 해소). 라이브 첫 스윕 **227/227 스트림 전건 앵커**, 라이브 토큰 `openssl ts -verify` **제3자 검증 OK 실측**(절차 `06-ops/operations-guide.md` §1.3.1). 공인 TSA 계약 시 `ANCHOR_TSA_URLS` 만 교체
- 🚧 잔여 = **go-live cutover 중심** → `06-ops/go-live-runbook.md`: 벤더 계약(PASS/알림톡/KMS)·P7 clean-reset·KMS→HSM_ANCHORED·P8 시크릿 회전·H2 admin IP. 코드 트랙은 **A6(i18n, 수요 확인)** 만 대기
- ⏸ **SaaS 멀티테넌시 = 백로그 보류(실서비스 이후)** — edu 가 "기관별 consumer·registrar serial 발급 체계"를 요청했으나(2호 병원 온보딩 전제), 격리 모델은 1호 기관 실운영 경험 위에서 설계하는 것이 맞다고 판단해 **go-live 이후로 미뤘다**(2026-07-29). 논점 정리는 로드맵 트랙 **E1** 에 보존 → `01-plan/backlog-roadmap.md`. **edu 에 회신 필요**(진행 시점 안내)

## 빠른 진입
- **API 연동 시작(신규 테넌트·파트너)** → `05-handoff/api-catalog.md` ⭐
- **실서비스 전환(go-live)** → `06-ops/go-live-runbook.md` ⭐
- **서명·연동 흐름 전체** → `02-design/signing-flows.md` ⭐
- HIS 연동 시작 → `05-handoff/his-delivery-summary.md` + `05-handoff/integration-decisions.md`
- PACS 연동 시작 → `05-handoff/pacs-integration.md` + `05-handoff/sign-to-pacs-answers.md`(curl)
- ERP 연동 시작 → `05-handoff/erp-track-a-handoff.md`
- 환자앱 → `05-handoff/patient-app-fr14-15-handoff.md`
- 파일럿 → `05-handoff/p1-pilot-checklist.md`
- 배포/운영 상세 → `06-ops/operations-guide.md`
- 연동 팀 회신(2026-07) → `05-handoff/werub-integration-requests-2026-07-reply.md`(R1~R13)·`05-handoff/edu-webhook-dead-notice.md`(수신 경로·재발송)
