# 변경 이력 (CHANGELOG)

## [Unreleased]

## [1.30.1] — 2026-09-10 — 백업 복구 + 운영알림 스로틀(운영 릴리즈, 앱 코드 무변경)

**서버 이관이 컨테이너만 옮기고 크론은 두고 갔다.** 2026-09-09 sign 이 ML 서버로 이관되면서
백업 크론만 재등록에서 누락돼 **9/8~9/10 3일간 백업이 정지**했다. 앱은 정상 서비스 중이었으므로
유일한 신호는 S9 경보 메일(시간당 1통, 약 50통)이었다. 증거 서비스에서 백업 공백은 곧 증거 공백이다.

### 고침

- **백업 하트비트를 로컬 암호화 산출물 완성 직후로 이동**(`scripts/backup-sign-db.sh`).
  종전에는 오프사이트 rsync 뒤라 `set -e` 아래 **오프사이트 실패가 "백업 자체가 없다"로 둔갑**했다.
- **오프사이트를 `SIGN_BACKUP_OFFSITE=pull|push` 로 분리.** 구 오프사이트 호스트(Linode)가 소멸해
  push 대상이 없어졌다 → 기본 `pull`(운영자 Mac 04:30 회수), `push` 는 `OFFSITE_HOST/PORT/DIR/KEEP` 로 복원 가능.

### 운영(라이브 반영)

- **v1.30.0 라이브 배포 완료**(ML 서버, 이관 후 첫 배포) — `ops-status.config.version=1.30.0`,
  마이그레이션 신규 없음, 감사체인 valid, 스모크 5/6.
- 백업 크론 재등록(`40 3 * * *` KST) + gpg 암호문 재생성(⚠ **사본이 라이브 1곳뿐 — 비밀번호 관리자 보관 필수**).
- **운영알림 스로틀 `ALERT_THROTTLE_MIN` 60 → 10080(7일)**. alertKey 별 스로틀이라 새 종류의 경보는 여전히 즉시 1통.
- 운영자 Mac WARP 스플릿 터널에 라이브 호스트 예외 등록(04:30 오프사이트 풀 실패의 실제 원인이었다).

### 문서

- 운영가이드 **§5c**(이관 사고 전말·교훈), **§5d**(v1.30.0 배포 기록 + 엣지 라우팅 잔여 결함), §1.5 스로틀 반영.
- 백업 런북 §1 as-built 전면 갱신(라이브=ML 서버·pull 오프사이트·암호문 사본 경고) + 사고 2 기록.

> ⚠ **앱 코드 변경 없음** — 라이브에 도는 애플리케이션은 v1.30.0 그대로다(버전 문자열만 1.30.1).
> 이 릴리즈는 운영 스크립트·문서 묶음이며, 재배포 없이 다음 릴리즈 때 함께 올라간다.

## [1.30.0] — 2026-08-26 — 콜백 정정 API + 코드 리뷰 후속(보안·동시성·성능)

수신 URL 변경 사고(2026-08-08)의 코드 후속(`callback-retarget` API)에 더해, **4관점 전면 코드
리뷰**(백엔드 보안·동시성·성능·웹)에서 확인된 **저위험·고가치·자기완결** 건을 반영한 릴리즈.
근본 테마는 하나였다 — 요청 봉투·웹훅 레코드가 last-write-wins 인데 mutex/CAS 없는 check-then-act 라
서명 유실·이중 통지·EXPIRED 가 COMPLETED 를 덮는 경합. 요청 단위 직렬화와 발송 전 CAS 로 마감했다.
스펙 144 paths / 162 오퍼레이션. **보류분(배포결합·위험>버그)은 backlog·security-plan 에 사유와 함께 등재**.

### 성능·동시성 — go-live 전 안전 처리분(2026-08-26, 2차)

리뷰 후속으로 **스케일 대비 성능(KV 풀스캔)**·**동시성 잔여**를 추가 수정(라이브 PG 로 쿼리 검증).

#### 성능 — DB 푸시다운·경계 읽기(SignStore 포트 4종 추가)
- **F1** 서명 제출 hot path 의 `findParticipant` 전량 스캔 제거 — `getRequestByParticipant`
  (participants 배열 `@>` JSON 조건). 라이브 PG 로 정확 매칭 실측.
- **F2** 웹훅 조회 전량 로드 제거 — `webhooksByStatus`(status JSON-path). retryPending(5분 주기)·
  dead-cache·openCounts·listDead·redrive·discard·HealthWatch 전부 상태 푸시다운.
- **F3** 로그인 실패 감시가 `admin:auth` 전체 스트림 로드하던 것 → `auditRecent(key, N)` tail 상한.
- **F4** 감사체인 표본이 `distinct` 순서 미정의로 "임의 N"이던 것 → `auditKeysByRecency`
  (max(seq) desc groupBy) — 실제 최근 N 보장(정확성 겸 성능). 라이브 PG 로 순서 실측.

#### 동시성
- **supersede** 원본 단위 `reqMutex` 직렬화 — 서로 다른 idempotencyKey 동시 개정의 이중 개정본(고아) 차단.
- **forwardDelivery**(공개 교부 토큰 EP) 토큰 `mutex` + 잠금 내 카운트 재조회 — `DELIVERY_FORWARD_MAX`
  캡 우회(동시 요청 전부 used=0) 차단.
- **alert.raise** 발송 전 `saveMetaIfUnchanged`(CAS)로 슬롯 선점 — 같은 키 동시 raise 가 N 통 발송되던 창 차단.

#### 보류(문서화) — 배포결합 또는 위험>버그
- `ops:write` 스코프 분리(S12): 라이브 백업 하트비트가 별도 `SIGN_API_KEY` 동적 소비자로 호출 →
  같은 배포에서 스코프 부여 없이 EP 스코프만 바꾸면 S9 백업 신호가 깨짐(배포 조율 필요).
- DNS 리바인딩(S13): 커스텀 lookup 이 `WEBHOOK_INTERNAL_HOSTS` 루프백(ERP) 예외 없으면 정상 발송 차단 —
  단일호스트라 우선도 낮음. 세션토큰→쿠키: 현재 쿠키 0(CSRF 불가)이라 이전이 오히려 CSRF 면을 염. manual
  iframe sandbox: 유효 sandbox 가 TOC·인쇄 스크립트를 깸(정적 콘텐츠라 현 노출 없음). F5·F8·syncFilterCols:
  저장 구조/projection 변경 동반. 상세 = [backlog-roadmap](docs/01-plan/backlog-roadmap.md).

#### 검증
- 백엔드 e2e 전량 그린 · prisma-store 계약 통과 · **신규 3쿼리(array_contains·groupBy·jsonb-eq) 라이브 PG 실측** · tsc --noEmit 통과.

### 보안·정확성 — 4관점 코드 리뷰 후속(2026-08-26)

전체 검토(백엔드 보안·동시성·성능·웹)에서 확인된 항목 중 **저위험·고가치·자기완결** 건을 수정.
근본은 하나였다 — 요청 봉투(request)·웹훅 레코드가 last-write-wins 인데 여러 await 를 가로지르는
읽고-고쳐-쓰기가 mutex/CAS 없이 돌아, 서명 유실·이중 완료 웹훅·EXPIRED 가 COMPLETED 를 덮는 경합.

#### 수정 — 동시성/정확성
- **요청 단위 직렬화**(`SignatureRequestService` 에 `reqMutex`): `submit`·`withdraw`·`expireOverdue` 를
  요청별로 잠그고 **임계구역 진입 후 최신 봉투를 다시 읽어** 판정·기록한다. 병렬 서명이 서로를 덮어
  서명이 사라지거나(영구 wedge), 완료 웹훅이 두 번 나가거나, 만료 배치가 방금 완료된 요청을 EXPIRED 로
  되돌리는 것을 막는다.
- **지연 만료 통지 누락 수정**: `submit()` 의 TTL 경과 분기가 상태만 EXPIRED 로 바꾸고 **webhook·SSE 를
  발화하지 않아** 연동(HIS/ERP)이 만료를 인지 못했다(배치는 EXPIRED 를 건너뜀). `request.expired` 발화 추가.
- **스케줄러 재진입 가드**: `run{Retry,Expire,Contracts,AnchorSweep,Watch}` 에 in-flight 가드 —
  느린 SMTP/네트워크로 이전 실행이 안 끝났는데 다음 틱이 겹쳐 도는 것을 차단(**리마인더·웹훅 이중
  발송의 관찰된 원인**, 2026-08-07).
- **웹훅 재시도/재발송 stale 방지**: `retryPending`·`redriveDead` 가 스냅샷 대신 **발송 직전 레코드를
  다시 읽어**(신규 `getWebhook(id)`) 상태가 PENDING/FAILED(재발송은 DEAD)일 때만 보낸다.
- **만료 임박 경고 순번 게이팅**: 경고가 미서명 외부 서명자 **전원**에게 포털 토큰을 발급하던 것을
  `dueExternal`(현재 차례만)로 제한 — 순번 前 문서 열람 차단(send·auto-advance 와 정합).

#### 수정 — 보안
- **웹훅 재지정(`webhook-redrive` `newTargetUrl`) SSRF 검증 누락 차단**: 이 경로만 `validateCallbackUrl`
  을 건너뛰어, 인증된 호출자가 통지를 사설망/메타데이터 주소로 돌릴 수 있었다. createRequest·retarget 과
  동일 검증을 태우고 실패 시 400.
- **웹훅 발송 리다이렉트 차단**: `fetch(..., { redirect: 'error' })` — 검증한 주소가 302 로 사설망/
  메타데이터로 튀는 SSRF 우회 차단.
- **자격증명 로그/메일 노출 차단**: DEAD 이력 경고의 callbackUrl 을 `redactUrl`(userinfo·쿼리 토큰 제거)
  로 마스킹해 로그·운영 알림 본문에 실었다(판정·저장·재지정은 원본 유지).
- **CORS 풋건 제거**: 하드닝(운영)에서 `CORS_ORIGINS` 미설정 시 `origin:false`(교차오리진 미반사) —
  임의 오리진을 credentials 와 함께 반사(`origin:true`)하던 기본을 제거(개발은 종전 편의 유지).

#### 성능
- **`webhooksByRequest` DB 푸시다운**: reconcile 조회마다 `kind='webhook'` 전량 스캔하던 것을
  JSON-path 조건으로 전환(`notifyByRequest` 와 동일 패턴).

- 운영 API 스코프 분리 + redrive/retarget 테넌트 격리(**E1 멀티테넌시 선행 필수**, 현재는 전 소비자가
  동일 운영자라 비활성 위협) · DNS 리바인딩 SSRF(egress 통제 병행) · 성능 F1~F8(스케일 대비) ·
  동시성 잔여(supersede 이중개정·forwardDelivery 캡·alert 스로틀·syncFilterCols) · 웹 P2(세션 토큰
  저장·manual iframe sandbox).

#### 검증
- 백엔드 e2e 전량 그린(변경분 재실행: webhook-redrive·concurrency-store·joint-3party·erp-multisig·
  general-contract·supersede·restart·health-watch·hardening-ratelimit) · `tsc --noEmit` 통과.

### 운영 — 수신 URL 변경 사고(2026-08-08) 후속

웹훅 DEAD 경보가 16시간 반복된 사고의 근본은 "이미 저장된 요청에 옛 주소가 박혀 있다"였다.
통지의 `targetUrl` 은 **요청 생성 시점 `callbackUrl` 의 사본**이라, 연동처가 경로를 고쳐도
그 전에 만들어진 요청은 만료·완료될 때마다 새 DEAD 를 만든다. 세 가지를 고쳤다.

#### 추가
- **`POST /v1/maintenance/callback-retarget`** — 저장된 요청의 `callbackUrl` 일괄 정정
  (`fromUrl` 부분일치 · `toUrl` · `statuses` 기본 CREATED·IN_PROGRESS · `limit`).
  **기본이 모의 실행(`dryRun`)** — 대상 수와 표본을 확인한 뒤 `dryRun:false` 로 적용한다.
  `toUrl` 은 요청 생성과 동일한 SSRF 검증을 거치고, 정정은 요청별 감사 스트림에
  `CALLBACK_RETARGETED`(옛 주소·새 주소·처리자)로 봉인된다.
  지원 API 가 없어 **운영 DB 에 직접 UPDATE** 를 날려야 했던 경로를 대체한다.
  응답의 `deliveries {pending, dead}` 로 옛 주소를 물고 있는 기존 통지 잔여를 함께 알린다
  (요청을 고쳐도 이미 만들어진 통지에는 따라가지 않는다 — 그쪽은 `webhook-redrive`).

#### 변경
- **웹훅 DEAD 경보 본문에 "대기 중 요청 수" 병기** — `수신처: …: DEAD 2건 · ⚠ 대기 중 요청 19건이
  같은 주소`. DEAD 건수만 알리면 재발송으로 적체가 0 이 되고 한 시간 뒤 같은 경보가 다시 온다.
  **반복의 원인을 첫 통에서 보이게** 하고, 조치 순서(①주소 정정 → ②재발송)를 본문에 적는다.
- **요청 생성 시 콜백 경고를 응답에 노출** — 실패 확정(DEAD) 이력이 있는 주소로 새 요청이 오면
  생성 응답에 `warnings[]` 를 싣고(호출자), 운영 알림으로도 밀어낸다(운영자·비차단 발송).
  종전에는 `log.warn` 뿐이라 아무도 보지 않았다. 생성 자체는 종전대로 **차단하지 않는다**
  (호출자가 넘긴 `callbackUrl` 을 임의로 바꾸지 않는다는 연동 계약 유지).

#### 검증
- `test/webhook-redrive.e2e.mjs` +12체크 — 모의 실행이 아무것도 바꾸지 않음·표본 노출·형식/권한 거부·
  적용·감사 봉인·재실행 멱등, 그리고 **정정 이후 발화된 통지가 새 주소로 도달**(DEAD 재생산 차단).
- `test/health-watch.e2e.mjs` +4체크 — DEAD 경보 **본문**에 대기 요청 수·근본 조치 안내·수신처 표기.
- 스펙 144 paths / 162 오퍼레이션, 스펙 게이트 그린.

## [1.29.0] — 2026-08-04 — 능동 탐지·알림(보안 트랙 S9)

증거 서비스에서 가장 위험한 것은 **조용한 실패**다 — 백업이 3주째 안 돌아간 것을
복구가 필요한 날 알게 되는 상황. 쌓이기만 하던 징후를 운영자에게 밀어낸다.

### 추가
- **`AlertService`**: 이메일 통지(`OPS_ALERT_TO`·기존 SMTP 재사용) + **폭주 억제**
  (`ALERT_THROTTLE_MIN` 기본 60분, 억제 횟수는 다음 발송 본문에 합산해 유실 없음).
  마지막 발송 시각을 스토어에 두어 **재기동해도 억제가 유지**된다. 수신자 미설정이면 로그 전용.
- **`HealthWatchService` — 점검 5종**: ①**백업 신선도**(하트비트 노후 `BACKUP_MAX_AGE_H`, 기본 26h)
  ②감사 체인 `chainValid` 붕괴 ③로그인 실패 폭주(창·임계 설정, 상위 출처 IP 병기)
  ④웹훅 DEAD ⑤ready(db·ca) 실패.
- **`POST /v1/maintenance/backup-heartbeat`**: 호스트 백업 크론의 성공 신호. 앱은 호스트 크론을
  볼 수 없으므로 **신호의 부재로 중단을 판단한다**(S7 의 짝 — 백업 스크립트에 `SIGN_API_KEY` 설정 시 전송).
- **`POST /v1/maintenance/health-watch`**: 주기와 별개로 즉시 점검(스케줄러는 `SCHEDULER_WATCH_MIN`, 기본 5분).

### 원칙
- **알림 실패가 본 기능을 막지 않는다** — 전송은 best-effort, 예외는 삼키고 로그만 남긴다.
- `raise()` 는 **탐지 여부**를 반환하고 전달 성패와 분리한다 — 수신자 미설정·SMTP 장애로 전달이
  실패해도 "탐지했다"는 사실은 참이어야 하고, 집계가 채널 구성에 좌우되면 안 된다.

### 미채택
- rate-limit 상습 IP 알림(계획서 S9 원안 ④) — 히트 카운터가 메모리 전용이라 재기동에 사라져
  오탐·누락이 크다. 멀티노드 정리(S8) 시 재검토.

### 검증
- `test/health-watch.e2e.mjs` 신설·e2e 체인 편입 — 임계 미만/초과·throttle·무인증 차단·비침습 확인.
- 스펙 143 paths / 161 오퍼레이션, 스펙 게이트 그린.

## [1.28.0] — 2026-08-04 — CSP 활성화(보안 S3, report-only 도입) + S7 백업 자동화 + CI 워크플로 보완

### 보안 — S3 CSP (`CSP_MODE`, 운영 기본 report-only)
- **`web/src/middleware.ts` 신설**: 콘솔·포털 HTML 에 응답별 nonce 기반 CSP —
  `script-src 'self' 'nonce-…' 'strict-dynamic'` + 전 리소스 `'self'`(외부 출처 0 실측),
  PDF 미리보기 `frame-src blob:`, 별도 API 도메인 구성 시 그 오리진 자동 허용.
  nonce 전제인 동적 렌더링은 `layout.tsx` 의 `headers()` 로 강제. `/admin/manual` 만
  nonce 없이 `'unsafe-inline'`(srcDoc 매뉴얼의 인라인 스크립트가 CSP 상속 — 내부 페이지라 수용).
- **모드 전환 = `CSP_MODE`**(compose 명시 나열): `report`(기본)→관찰 후 `enforce`, `off`=롤백.
- **위반 수집 `POST /v1/csp-report` 신설**(무인증·`application/csp-report` 파서 64kb 상한·
  rate-limit): `[csp-violation]` 구조적 로그. enforce 에서도 report-uri 유지(차단 관측).
- **UI E2E 는 항상 CSP enforce 로 실행**(playwright.config) — 운영이 report-only 인 동안에도
  CI 가 실차단 회귀를 잡는다. 전 스위트 그린 + 스펙 게이트(159 오퍼레이션)·카탈로그 갱신.

### 보안 — S7 백업 자동화 + 복구 리허설 (호스트 운영 변경·앱 무변경)
- `scripts/backup-sign-db.sh`: 일별 03:40 KST cron — 컨테이너 내 `pg_dump -Fc`+목차 검증 →
  sha256 → gpg AES256(평문 즉시 삭제) → 로컬 14세대 → 오프사이트(CI 러너 박스) 30세대.
- **초회 복구 리허설 실측 성공**: 복호·체크섬 → 스크래치 PG 복원 행수 완전 일치 → 복원 DB 위
  앱 기동 ready(db+ca — prod 마스터키 복호 왕복 포함) → **감사체인+TSA 앵커 verify 8/8 valid**.
- 런북 `docs/06-ops/backup-restore-runbook.md`(분기 리허설 절차·실제 복구·한계 RPO 24h).

### CI — 워크플로 전면 검토 보완 (런타임 무변경)
- **e2e 포트 충돌 해소**: CI 러너 상주 서비스가 3000~4200 라운드 포트를 점유(2026-08 실측,
  increment4 가 404 로 오염되며 실패) → increment4~7·integration-his 의 서버 포트를
  4211/4311/4411/4511/4611 로 이동 + 기동 대기 fail-fast(미기동 시 명확한 에러로 즉사 —
  포트 선점자의 404 가 테스트 결과에 섞이는 것 차단).
- **integration-his 계약 갱신·게이트 편입**: v1.22 중간 서명 웹훅(request.signer_completed)
  반영으로 기대값 현행화(completed 1회 + signer_completed 서명자당 1회), e2e 체인에 추가
  (기존엔 게이트 밖이라 계약 드리프트를 못 잡았음).
- **워크플로 하드닝(ci.yml·security.yml)**: `permissions: contents: read` 최소화 ·
  checkout/setup-node/upload-artifact v7 (Node20 deprecation 해소) · CI Node 20→22
  (런타임 이미지 node:22-alpine 과 동일 메이저, 20 은 2026-04 EOL) ·
  `persist-credentials: false` · semgrep/trivy 이미지 sha256 digest 고정 ·
  trivy push 스캔은 Dockerfile 변경 시에만(OS 레이어는 소스와 무관, 주간이 새 CVE 커버).
- 검증: actionlint(커스텀 러너 라벨 외 0건) · 이동 포트 5개 테스트 로컬 그린.

## [1.27.2] — 2026-08-04 — 공급망 CI 게이트(보안 트랙 S6) + GCM 태그 길이 하드닝

### 보안 — S6 공급망 CI 게이트 (`.github/workflows/security.yml`, 매 push·PR·주간 월 05:00 KST)
- **npm audit 게이트**: `scripts/audit-gate.mjs`(`npm run audit:gate`) — root+web 의 **prod 의존성**
  high/critical 어드바이저리를 GHSA 단위로 차단, dev 는 경고만. 예외는 `.audit-allowlist.json` 에
  사유(reason)·후속(followup)·등재일 필수로 명시 관리(현재 17건 — NestJS 11·Next 16 메이저
  업그레이드 대기, 각 항목에 미사용 기능·인증 뒤 표면 등 판단 근거 기재). audit 실패 시 fail-closed.
- **락파일 변조 검증**: `lockfile-lint` — https·registry.npmjs.org 외 소스 차단(root+web).
- **SAST**: Semgrep CE `p/default`, finding 있으면 실패. **CodeQL 은 프라이빗 저장소에서
  GHAS 없이 불가하여 대체**(계획서 S6 as-built 에 편차 기록).
- **컨테이너 스캔**: trivy 가 sign-core·sign-web 이미지의 **베이스 OS 패키지**(HIGH/CRITICAL·
  ignore-unfixed)를 게이트 — Node 의존성은 audit-gate 와 역할 분담. 예외 = `.trivyignore`.

### 보안 — Semgrep 도입 시점 검출 5건 코드 해소 (런타임 변경)
- **AES-256-GCM `authTagLength: 16` 명시** — `secret-box.ts`(4곳)·`soft-key-signer.ts`(2곳)·
  `scripts/pki-proof.mjs`(2곳): Node 는 미지정 시 4바이트까지 잘린 인증 태그도 수용(위조 확률
  2^-32) — 자사 봉인 태그는 항상 16바이트이므로 **기존 데이터 호환·동작 동일**, 방어층만 추가.
- `totp.ts` 코드 자릿수 검사를 비리터럴 RegExp → 길이+`/^\d+$/` 검사로(동작 동일).

### 검증
- 게이트 통과·차단 경로 양방향 실측, Semgrep 재검 0건, trivy node:22-alpine OS 0건(러너 실측),
  nest build · pki-proof(GCM 왕복) · mfa-2fa(TOTP) · portal-document(SecretBox) e2e 그린.

## [1.27.1] — 2026-07-29 — 전 소스 주석 보강·개발자 표기(문서 릴리즈, 런타임 무변경)

`src/`·`prisma/`·`web/src/` 의 **동작 변경 없음** — 주석·문서·버전 표기만의 릴리즈다.

### 문서·주석
- **전 소스 해석 가능 주석 보강**(45파일 +254줄): main.ts 부트스트랩 6단계의 순서 의미,
  app.module 포트↔어댑터 매핑 표, signature-request 생애주기·webhook 규약, signature.service
  CAdES-BES 구조와 canonicalJson 함정, dto.ts whitelist 경고 등 — "왜 이렇게 생겼는가"가 읽히도록.
  헤더가 전무했던 web/src 37개 파일 전부에 화면 책임·데이터 원천·플래그 조건 헤더.
- **개발자 표기**: 전 소스 238파일 최상단 `// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>` +
  헤더 JSDoc 블록 내부 `@author` 태그(225파일) + package.json `author` 필드.
  생성물(manualHtml.ts)은 제외(manual:build 가 덮어씀).
- v1.27.0 as-built 동기화 — README(위협 대조표 "운영자 자신의 위변조" 행·앵커 이중화 개념·
  배포 설정 절·보안 원칙 7번)·docs 인덱스·로드맵 v1.8.

### 검증
- 각 커밋마다 diff 필터로 주석 외 변경 0 확인 · tsc · nest build · next build ·
  스팟 e2e(anchor-dual·general-contract) · prisma 계약 통과.

## [1.27.0] — 2026-07-29 — 감사 앵커 이중화(보안 트랙 S1: 외부 TSA 교차 앵커 + 주기 스윕)

보안 계획서(T1)의 근본 갭 해소: 자체 TSA(SELF) 서명키가 sign 자신의 KeySigner 에 있어
**앵커가 운영자 독립 증거가 아니었다** — 운영자 권한이면 체인 재계산 + 자기 TSA 재앵커가 가능했다.
외부 RFC3161 TSA 토큰을 앵커에 병기해 운영자가 위조할 수 없는 제3자 증거를 만든다.

### 추가 (Added)
- **외부 RFC3161 교차 앵커** — `ANCHOR_TSA_URLS`(쉼표 구분) 설정 시 앵커마다 외부 TSA 토큰 병기.
  - RFC3161 코덱 자작(`src/infrastructure/tsa/rfc3161.ts`, node-forge): TimeStampReq 생성(sha256 imprint·nonce·certReq) + TimeStampResp 구조 파싱(status·imprint·genTime·nonce 대조 — 재생 응답 차단).
  - 토큰은 **DER 원문 보존**(base64) → 제3자가 `openssl ts -verify` 로 sign 과 무관하게 검증. **실 freeTSA 상호운용 실측: Verification: OK**(절차 = 운영 가이드 §1.3.1).
  - **best-effort**(4s 타임아웃·병렬) — 외부 TSA 장애가 서명 완료·체결·결재를 막지 않는다. 실패분은 스윕이 보충.
- **앵커 스윕**(`SCHEDULER_ANCHOR_MIN`, 기본 1440분) — 전 감사 스트림을 훑어 ①미앵커 ②head 전진 ③외부 토큰 누락이면 재앵커. **이벤트 앵커 경로가 없어 영영 미앵커였던 관리 스트림(`admin:auth`·`admin:users` 등) 갭을 동시에 해소**(기동 10초 후 catch-up 1회 포함, 실행당 상한 500).
- 검증 API 응답에 `externalAnchors[]`(tsaProvider·genTime·structureValid) 추가 — `valid` 판정은 종전과 동일(외부 미구성·장애가 기존 API 를 흔들지 않도록 부가 증거로만 병기).

### 저장 형식
- `StoredAnchor.externalTokens?`(추가 필드) — 기존 앵커 레코드와 하위호환(마이그레이션 불요).

### 테스트
- 신규 `test/anchor-dual.e2e.mjs` — mock RFC3161 서버(실 구조 TSTInfo+CMS)로 ①이벤트 앵커의 외부 토큰 병기·구조 검증 ②관리 스트림 스윕 앵커(종전 미앵커 갭) ③TSA 다운 시 비차단(자체 앵커 유지·외부 0건 정직 보고) ④복구 후 스윕 보충 재앵커.
- 게이트: 백엔드 e2e 0실패 · prisma 계약 · UI 69/69.

## [1.26.2] — 2026-07-29 — 라이브 배포 기록·로드맵 재정렬(문서 동기화)

**런타임 변경 없음** — `src/`·`prisma/`·`web/src/` 무변경. v1.26.1 배포 결과와 우선순위 결정을
문서에 반영하고 버전 표기를 라이브와 일치시키는 릴리즈다.

### 문서
- **v1.26.1 라이브 배포 기록** — migration 0009 실적용 완료(2026-07-29): 사전 점검(감사 체인 분기 0 · meta 중복 0 · `store_records` ~1,100행이라 `CONCURRENTLY` 불요) → `pg_dump` 백업 → rsync·재빌드 → 컨테이너 기동 시 `prisma migrate deploy`. 유니크 인덱스 2종 생성 확인, **행수 마이그레이션 전후 완전 동일(유실 0)**, 라이브 스모크 6/6, 완료 요청 감사체인 `valid`(anchorMatchesChain 포함). 라이브에 기존 첨부 0건이라 v1 dual-read 부담 없음(신규는 전부 v2 청크).
- **SaaS 멀티테넌시(트랙 E1) → 백로그 보류, 착수 조건 = 실서비스 이후**. 격리 모델(저장소 스키마·registrar 구조)은 1호 기관 실운영 데이터·부하·운영 패턴을 본 뒤 설계하는 편이 낫다는 판단. 논점 4항(기관 식별자 출처·시리얼 체계 분리·registrar 격리 범위·데이터 격리 경계)은 재개 시 이어 쓰도록 로드맵 E1 에 보존.
- 로드맵 v1.7 — **다음 축을 개발이 아니라 go-live cutover 로 재정렬**(B 트랙 외부 결정이 대부분 거기로 수렴: 본인확인 벤더·KMS/HSM·알림톡·admin IP). 남은 코드 트랙은 A6(i18n, 수요 확인)뿐.
- `docs/README.md` 현황·감사 후속 문서 링크 문구를 as-built 로 동기화.

### 미결(사람 작업)
- **edu 회신** — "멀티테넌트 발급 체계는 실서비스 이후 진행" 안내. 착수를 미루더라도 시점은 알려야 edu 가 2호 병원 온보딩 일정을 세울 수 있다.

## [1.26.1] — 2026-07-29 — v1.26.0 자체 감사 후속(JSONB 키순서·고아 청크·문서 동기화)

v1.26.0 을 자체 점검해 나온 누락분. **1.26.0 은 라이브에 배포되지 않았으므로 실사용 영향은 없다.**

### 수정 (Fixed)
- **계약 meta 롤백이 운영에서만 무력화되던 버그** — `updateMeta` 가 필터 캐시 동기화 실패 시 정본을 되돌릴지 판단하며 `JSON.stringify` 로 비교했다. **PostgreSQL JSONB 는 키 순서를 보존하지 않아** 재조회 값과 방금 쓴 값이 항상 불일치로 판정된다 → Prisma 드라이버에서 R1 롤백이 죽는다(인메모리·파일 어댑터는 키 순서를 보존해 테스트로도 안 잡힘). `canonicalJson` 비교로 교정 — 이 저장소가 감사 체인 때문에 이미 만들어 둔 함수이고, 그 주석에 같은 함정이 적혀 있었다.
- **첨부 고아 청크 회수 불가 경로** — `writeBlob` 이 중간에 실패하면 매니페스트가 없어 이미 기록된 청크를 되찾을 수단이 없었다(`deleteBlob` 은 매니페스트로 청크 수를 안다) → 실패 시 기록분을 직접 되감는다. `add()` 에서 목록 등재 CAS 가 **예외로** 끝나는 경로(경합 소진)도 blob 을 회수한다(종전엔 상한 초과 `!ok` 만 처리).
- `ops.service` 의 버전 폴백이 `1.25.0` 에 머물러 있던 것을 갱신(과거에도 같은 자리에서 범프가 누락된 이력이 있어 주석 추가).

### 문서
- `docs/05-handoff/api-catalog.md` 재생성(`npm run api:catalog`) — 1.26.0 릴리즈 때 누락돼 스펙 버전이 낡아 있었다.
- 설계서 §11 첨부 **보관** 항목을 as-built 로 — 종전 "단일 blob 슬롯 + KeyedMutex 직렬화" 서술을 청크 레이아웃(매니페스트·청크별 해시·dual-read·쓰기 순서·업로드 버퍼 한계)과 CAS 로 교체.
- `docs/README.md` 현황 — "잔여는 R9·R16 뿐" → R1~R16 전건 종결, migration 0009 배포 전 점검 경고, 다음 축(E1 SaaS 멀티테넌시) 추가.

### 테스트
- 백엔드 e2e 0실패 · prisma 계약 통과. (동시 실행 시 포트 충돌로 `fetch failed` 가 날 수 있어 게이트는 단독 실행할 것.)
- UI E2E `account-idle` 로케이터를 저장 확인 메시지로 좁힘 — 카드 설명과 함께 2개 요소에 걸려 CI 에서 간헐 strict mode 위반이었다(main `90169bf` CI 실패 원인).

## [1.26.0] — 2026-07-29 — 첨부 청크 스트리밍(R9)·저장소 수준 동시성(R16)

2026-07-28 감사에서 **전제가 바뀌면 착수**로 미뤄 뒀던 마지막 두 건. 두 전제 모두 기다릴 필요가 없다는
게 드러나 함께 닫았다 — R9 는 마이그레이션을 없애는 방식으로, R16 은 단일 노드에서도 무해한 방식으로.

### 변경 (Changed)
- **첨부 blob 청크 저장·스트리밍(R9)** — 종전에는 첨부 전체를 meta 슬롯 하나에 base64 로 넣고, 다운로드 때 파싱·디코드·복호·해시를 **파일 전체에 대해 한 번에** 수행한 뒤 응답 버퍼에 담았다. 10MB 첨부 10건짜리 계약의 교부 링크를 여럿이 동시에 열면 요청당 30MB+ 가 힙에 상주했다. 이제 256KB 청크 슬롯 + 매니페스트(v2)로 저장하고, 읽기는 청크마다 복호 → **SHA-256 검증 → 방출** 순서라 손상 바이트가 클라이언트로 나가지 않으며 피크 힙이 청크 하나로 고정된다. 콘솔·포털·교부 3경로 모두 `StreamableFile(stream)` + `Content-Length`.
  - **기존 첨부는 그대로 둔다** — v1(단일 슬롯)·v2(청크) **dual-read**. 데이터 마이그레이션 없음.
- **저장소 수준 동시성 보장(R16)** — `KeyedMutex`·`appendSerialized` 는 인프로세스라 수평 확장·롤링 배포에서 두 프로세스가 같은 배열 슬롯을 RMW 하거나 같은 `prevHash` 를 읽어 **감사 체인이 분기**할 수 있었다.
  - 메타 슬롯: `getMetaVersioned`/`saveMetaIfUnchanged`(버전=행 seq) 기반 **CAS** + `retryOnConflict`. 프리셋·주소록·서식·서식이력·첨부목록·계약 meta 6개 슬롯의 read-modify-write 를 전환.
  - 감사 체인: `(rkey, data->>'prevHash') WHERE kind='audit'` **유니크 인덱스**가 분기를 거부 → 재조회 후 재시도. 관례가 아니라 제약으로 단일 선형을 보장한다.
  - 인프로세스 뮤텍스는 **빠른 경로로 유지** — 같은 노드의 경합은 재시도 없이 흡수한다.
- 직렬화 없이 `lastAudit → next → appendAudit` 하던 **6곳을 `appendSerialized` 로 편입** — `admin:auth`·`admin:users`·`consumer:admin`·`ca:admin`·`docaccess:<id>`·`cert:<serial>`. 특히 감사이벤트 수집 EP 는 `prevHash` 조회와 append 사이에 **SSO 검증(네트워크)** 이 끼어 TOCTOU 창이 수백 ms 였다.
- `putOne` 이 meta 유니크 위반 시 재시도 — last-write-wins 시맨틱 유지(순서가 중요한 경로는 CAS 사용).

### 마이그레이션
- **0009** `store_records_meta_slot_uniq`(`(kind,rkey) WHERE kind='meta'`) · `store_records_audit_prevhash_uniq`.
  - meta 중복행은 **최신(seq 최대)만 남기고 자동 정리**(`getOne` 이 이미 그 행만 읽으므로 의미 변화 없음).
  - 감사 체인에 **기존 분기가 있으면 마이그레이션이 의도적으로 실패**한다(끊긴 체인 위에 제약을 얹어 "무결"로 오인시키지 않기 위함). 배포 전 점검 SQL 은 `docs/01-plan/backlog-roadmap.md` 트랙 D 참조.
  - 대용량 설치는 배포 전 `CONCURRENTLY` 수동 생성 권장(운영 가이드 §1.2 — Prisma 는 마이그레이션을 트랜잭션으로 감싼다).

### 테스트
- 신규 `test/attachment-stream.e2e.mjs` — 다중 청크 무결성·청크 경계(정확 배수/1청크 미만)·저장 레이아웃(청크 분리 확인)·경로 3종 동일성·동시 8건·**청크 1개 손상 시 온전한 바이트 차단**·**v1 dual-read**.
- 신규 `test/concurrency-store.e2e.mjs` — 공용 슬롯 동시 추가/삭제 유실 0·같은 이름 동시 upsert 1건 수렴·동시 다운로드 20건의 접근 감사 전건 기록 및 **prevHash 유일·체인 선형**·보관/복원 멱등(재시도 중복 감사 없음)·`admin:auth` 동시 append.
- `contract:prisma` 에 CAS·체인 분기 거부 계약 추가(FakePrisma 가 0009 의 부분 유니크 인덱스와 `seq` 조건을 모사).
- 게이트: 백엔드 e2e 0실패 · prisma 계약 통과 · UI **69/69**.

## [1.25.0] — 2026-07-29 — API 표면 정리(SaaS 연동 준비)·API 카탈로그

SaaS 구성을 앞두고 **연동 계약을 스펙 하나로 판단할 수 있게** 정리했다. 종전 스펙은 158개 오퍼레이션 전부가
태그·설명 없이 한 덩어리였고, 어떤 스코프가 필요한지·키가 필요하긴 한지가 코드를 봐야만 알 수 있었다.

### 추가 (Added)
- **API 카탈로그** [`docs/05-handoff/api-catalog.md`](docs/05-handoff/api-catalog.md) — 연동/SaaS 온보딩 기준 문서(인증 4경로·스코프별 부여 기준·오류 코드·멱등·webhook 계약·버전 정책·연동 대상이 아닌 것). 엔드포인트 표는 **스펙에서 자동 생성**한다(`npm run api:catalog`) — 손으로 적은 목록은 반드시 낡기 때문.
- 스펙에 **`x-required-scope`**(엔드포인트별 필요 스코프)와 **`x-auth`/`x-auth-note`**(무인증·포털/교부 토큰·콘솔 세션·STAFF SSO·운영 전용 키) 표기. `@RequireScope` 와 새 표시 데코레이터(`TokenAuth`/`PublicApi`/`SessionAuth`/`StaffSsoAuth`/`ProdApiKeyAuth`)가 가드와 **같은 출처**에서 스펙을 채우므로 어긋날 수 없다.
- 스코프 엔드포인트는 401·403 응답과 보안 스킴이 자동으로 스펙에 선언된다.
- `servers`(운영·로컬)·태그 11종 설명·스펙 상단 연동 계약 요약(인증·규약·webhook·버전 정책).
- 회귀 게이트 `test/openapi-spec.e2e.mjs` — 신규 오퍼레이션이 **그룹·설명·인증 표기 없이** 들어오면 실패한다.

### 변경 (Changed)
- 컨트롤러 21개 전부에 `@ApiTags` 부여 — 연동(인증서·서명요청·서명·포털·계약) / 공개 검증 / 감사 / 콘솔 전용이 그룹으로 분리된다.
- 설명이 비어 있던 오퍼레이션 40여 건에 JSDoc 추가 — **158/158 전건**이 설명을 갖는다(라인주석이 JSDoc 앞을 가려 설명이 누락되던 케이스 포함).
- 클래스 레벨 `@RequireScope` 만 있던 컨트롤러 5개는 메서드에도 스코프를 명시 — 클래스 레벨은 스펙에 반영되지 않아 실제로는 보호되는 엔드포인트가 "인증 불필요"처럼 보였다.
- 스펙 버전을 `package.json` 에서 읽는다 — `node dist/swagger-export.js` 직접 실행 시 `npm_package_version` 이 비어 **1.7.0** 이 박히던 문제.

### 테스트
- 게이트 백엔드 0실패(+OpenAPI 스펙 8체크) · prisma 계약 · UI 69/69.

## [1.24.0] — 2026-07-28 — Webhook DEAD 폐기(discard)

수신 시스템이 철수·폐지된 건은 재발송해도 영원히 실패한다. 그런데 DEAD 로 남겨두면
신규 요청 생성 시 "이 주소로 실패 이력 N건" 경고가 계속 뜨고, 적체 목록이 실제 조치 대상과 섞인다.
**레코드를 지우지 않고 상태만 바꿔** 적체·경고에서만 빼는 폐기 동작을 추가했다.

### 추가 (Added)
- **`POST /v1/maintenance/webhook-discard`** (`requests:write`) — DEAD 건을 `DISCARDED` 로 전환. 필터는 재발송과 동일(`requestId`·`targetUrl` 부분일치·`limit`), **`reason` 필수**(사후에 "왜 안 갔는지"를 설명할 수 있어야 하므로).
- 폐기 건은 **`WEBHOOK_DISCARDED`** 로 해당 요청의 감사 체인에 봉인 — 처리자·수신 주소·시도 횟수·사유.
- 콘솔 **시스템 → Webhook 현황 → [DEAD 폐기]** — 수신 주소·사유 입력 후 실행.

### 변경 (Changed)
- `WebhookDelivery.status` 에 `DISCARDED` 추가(+ `discardedAt`/`discardedBy`/`discardReason`). 폐기 건은 **재발송·자동 재시도·DEAD 적체 목록·수신처 경고 판정에서 제외**되고 이력만 남는다.
- 운영 현황 webhook 성공률 분모에서 폐기분 제외(운영 판단으로 닫은 건이 지표를 끌어내리지 않도록).
- 되돌리기는 제공하지 않는다 — 폐기 자체가 "이 수신처로는 보내지 않는다"는 판단이므로, 되살릴 상황이면 `newTargetUrl` 로 새로 발송하는 것이 맞다.

### 테스트
- `webhook-redrive.e2e.mjs` +9체크(사유 없는 폐기 400·적체 제외·재발송 대상 아님·DISCARDED 보존·감사 봉인·운영 집계·경고 감소). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.23.0] — 2026-07-28 — 프리셋 소유권 정책(D5 절충안)·프리셋 감사 스트림

감사 §3 D5 의 마지막 정책 항목. **수정은 기관 공용 유지, 삭제만 제한**하는 절충안을 채택했다
(수정은 다시 저장해 되돌릴 수 있지만 삭제는 복구 수단이 없다).

### 변경 (Changed)
- **프리셋 삭제는 생성자 또는 admin 만** — 타인이 만든 프리셋 삭제 시 **403**(생성자 안내 포함). 저장·수정은 종전대로 누구나(기관 공용 원칙 유지).
- 콘솔 세션의 역할을 삭제 판정에 사용한다. 역할을 알 수 없는 기계키(break-glass)는 종전 동작 유지.

### 추가 (Added)
- **프리셋 감사 스트림 `admin:contract-presets`** — 생성·수정·삭제를 해시체인에 봉인(`CONTRACT_PRESET_CREATED/UPDATED/DELETED`, 행위자·대상·생성자·서명자 수). 관리자 감사 조회(`GET /v1/admin/audit?stream=admin:contract-presets`)·스트림 목록·CSV 에 노출.

### 테스트
- 백엔드 e2e +4체크(타인 프리셋 저장은 허용·삭제는 403·본인 것은 삭제 가능·삭제 감사 봉인). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.22.1] — 2026-07-28 — 조판 경고 보고(`X-Sign-Warnings`)

### 추가 (Added)
- **조판 경고를 응답 헤더로 보고** — 요청은 성공했지만 **의도와 다르게 나간** 사항을 호출자가 알 수 있게 한다(글리프 대체 보고 R10 과 동일 취지·동일 인코딩). 첫 항목은 `bg` 색 형식 오류(기본 음영 폴백): `X-Sign-Warnings-Count`, `X-Sign-Warnings`(base64+JSON, `[{type:"invalid-bg", value, count}]`). 발행을 막지 않는 정책은 유지 — 색 오타로 발행이 멈추는 편이 더 나쁘다.

### 테스트
- 백엔드 e2e +2체크(잘못된 `bg` → 201 + 경고 헤더, 정상 `bg` → 경고 없음). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.22.0] — 2026-07-28 — 표 서식 3차 요청: 셀 단위 음영·헤더 행 반복·페이지 수 헤더

weRub 3차 요청(R12·R13 + 참고 항목) 반영.

### 추가 (Added)
- **[R12] 셀 단위 배경 음영** — 셀 객체에 `shaded: true` 또는 `bg: "#f6f8fc"` 허용. 종전에는 행 단위(`header`)로만 음영이 가능해 "라벨 칸만 음영, 값 칸은 흰색"인 국내 계약서·증명서 표준 서식을 낼 수 없었다(편집기 미리보기와 발송 PDF가 달라 보이던 마지막 잔여분). 미지정 시 현행 유지, `bg` 형식 오류는 기본 음영색으로 폴백(요청 거부하지 않음).
- **[R13] 페이지 넘김 시 헤더 행 반복** — 표가 다음 장으로 넘어가면 **선행 헤더 행 묶음을 새 페이지 상단에 다시 그린다**(급여 내역·경력 이력처럼 행이 많은 표에서 둘째 장이 열 제목 없이 값만 나열되던 문제). 페이지 여유 계산에 반복 헤더 높이를 포함한다.
- **`X-Sign-Pages`** — `POST /v1/contracts/compose` 응답에 조판 결과 페이지 수. 호출자가 PDF 바이트를 정규식으로 세지 않아도 된다.

### 테스트
- 백엔드 e2e +6체크(셀 음영 조판·헤더 반복을 pdf.js 로 페이지별 검증·`X-Sign-Pages` 실제 페이지 수 일치·잘못된 `bg` 폴백). 렌더 이미지로 라벨 칸만 음영·2페이지 헤더 반복 육안 확인. 게이트 백엔드 0실패(814체크) · prisma 계약 · UI 69/69.

## [1.21.2] — 2026-07-28 — 죽은 수신 주소 조기 인지(안전장치)

수신 경로가 바뀌었는데 호출자가 옛 `callbackUrl` 을 계속 보내면 통지가 조용히 쌓이다 DEAD 로 끝난다(edu 26건 사례).
**호출자 입력은 바꾸지 않고**(연동 계약 존중) 조기에 드러나게 한다.

### 추가 (Added)
- **요청 생성 시 경고** — 새 요청의 `callbackUrl` 로 이미 실패 확정(DEAD)된 통지가 있으면 WARN 로그(건수·주소·정정 후 재발송 안내). 생성은 그대로 허용한다.
- **운영 현황에 `webhooks.deadTargets`** — DEAD 가 몰린 수신 주소 상위 5개(주소·건수). 콘솔 시스템 화면의 Webhook 카드에 경고 박스로 표시하고, [DEAD 재발송] 시 **새 주소 입력 프롬프트**로 재지정할 수 있다.
- DEAD 집계는 60초 캐시(요청 생성마다 전량 스캔 방지), 재시도·재발송으로 적체가 바뀌면 즉시 무효화.

### 테스트
- 재발송 e2e +5체크(죽은 주소 요청도 통지 생성·차단 없음, 운영 현황 집계·형식, 경고 후에도 생성 허용). **ops-status 는 5초 캐시**라 검증 전 캐시 만료 대기 필요(테스트에 주석 고정). 게이트 백엔드 0실패 · UI 69/69.

## [1.21.1] — 2026-07-28 — 재시도 서명 시크릿 정정 · 수신 경로 재지정

edu 수신부 신설(경로 변경) 회신을 처리하며 발견한 결함 2건 + 필요한 운영 수단 1건.

### 수정 (Fixed)
- **[높음] 재시도·재발송이 항상 `HIS_WEBHOOK_SECRET` 으로 서명하던 결함** — 최초 전송만 소비자 시크릿을 쓰고, 재시도부터는 HIS 시크릿으로 재서명해 **ERP·edu 등 다른 소비자 대상 재전송이 서명 불일치로 거부**될 수 있었다. 전달 레코드에 시크릿 **환경변수 이름**(`secretEnv`, 값 아님)을 보관해 최초 전송과 동일한 시크릿으로 재서명하고, 구 레코드는 요청 출처(`createdBy`)로 `<소비자>_WEBHOOK_SECRET` 을 복원한다.
- **소비자별 시크릿 매핑 누락** — `erp` 만 매핑돼 있어 `edu` 는 HIS 시크릿으로 서명됐다 → `<소비자>_WEBHOOK_SECRET` 규칙으로 일반화(미설정 시 HIS 폴백). compose 에 `EDU_WEBHOOK_SECRET` passthrough 추가.

### 추가 (Added)
- **재발송 시 수신 경로 재지정** — `POST /v1/maintenance/webhook-redrive` 에 `newTargetUrl`(http(s) 절대 URL) 추가. 수신 측이 경로를 바꾸면 전달 레코드에 **저장된 옛 주소로는 영원히 실패**하므로, 재발송과 함께 주소를 갱신한다(변경 이력은 로그).

### 테스트
- 재발송 e2e +4체크(경로 변경 전 주소로 DEAD 적체 → `newTargetUrl` 재지정 후 새 주소 도달, 비 http(s) 400). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.21.0] — 2026-07-28 — Webhook DEAD 재발송(re-drive)

수신 시스템 장애·경로 오류로 재시도(8회)가 소진된 통지는 DEAD 로 남고 자동 배치에서 제외된다.
운영 사례(edu 수신 URL 404 로 완료 통지 26건 DEAD)를 되살릴 수단이 없어 추가.

### 추가 (Added)
- **`POST /v1/maintenance/webhook-redrive`**(`requests:write`) — DEAD 건을 재큐잉·재전송. 필터 `requestId`·`targetUrl`(부분일치)·`limit`(기본 100·최대 1000), 미지정 시 DEAD 전건. 시도 횟수를 0 으로 되돌리고 **현재 시크릿으로 HMAC 재계산**(시크릿 회전 후에도 유효), **`eventId` 는 보존**해 수신 측 멱등 처리가 그대로 동작한다. 응답: `matched`·`requeued`·`sent`·`failed`·`ids`.
- **`GET /v1/maintenance/webhook-dead`**(`requests:write`) — 재발송 전 대상 확인용 요약(요청·이벤트·수신 URL·시도 횟수·마지막 시도). 페이로드는 제외.
- 시스템 화면(`/admin/system`) Webhook 현황 카드에 **[DEAD 목록 보기]·[DEAD 재발송]** — DEAD 가 있을 때만 재발송 버튼 노출, 실행 전 확인 대화상자로 "수신 측 경로·장애 해소 후 실행" 안내.

### 테스트/문서
- 신규 e2e `test/webhook-redrive.e2e.mjs`(게이트 편입) — 수신기 다운 → 재시도 소진(DEAD) → **자동 배치는 DEAD 미전송 확인** → 수신기 기동 → 재발송 성공 → 적체 해소, HMAC 헤더·`eventId` 보존·필터 불일치 무동작·무키 401 포함 9체크.
- 운영 매뉴얼에 "Webhook DEAD 재발송" 절차 추가.

## [1.20.1] — 2026-07-28 — 다운로드 파일명 구분: 제목·구분·일자·식별자

### 변경 (Changed)
- **계약 관련 다운로드 파일명이 전부 고정값**(`contract-signed.pdf`·`audit-certificate.pdf`·`contract-document.pdf`)이라 여러 계약의 파일을 한 폴더에 받으면 구분·정렬이 불가능했다 → **`제목_구분_YYYYMMDD_식별자8.pdf`** 형식으로 변경(예: `용역 계약서_체결본_20260728_68db9227.pdf`, `용역 계약서_감사추적인증서_20260728_68db9227.pdf`). 구분은 체결본·감사추적인증서·검증본·문서·원본, 일자는 체결일(없으면 당일), 식별자는 requestId 앞 8자.
- 한글 제목을 담기 위해 문서 응답 헤더에 **RFC 5987 `filename*=UTF-8''`** 적용(ASCII 폴백 병기) — 종전에는 ASCII 파일명만 안전했다.
- 손글씨 서명 이미지 응답이 PDF 헤더(`Content-Type: application/pdf`)로 나가던 것을 실제 형식(PNG/JPEG)으로 정정하고, 파일명에도 계약 제목·참가자 식별자를 넣었다.
- `GET /v1/contracts/:id/status` 응답에 `title` 추가(파일명·목록 표시용, 개인정보 아님).

### 테스트
- 백엔드 e2e +3체크(교부 문서·인증서 파일명에 제목/구분 포함, 고정 파일명 미사용). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.20.0] — 2026-07-28 — 연동 요청 2차 R6~R8: participantId 노출·표 겹침 수정·마커 좌표 반환

### 수정 (Fixed)
- **[R7] 표 다음 블록이 표와 겹쳐 인쇄되던 조판 결함** — 조판기의 `y` 는 "다음 줄의 **베이스라인**"인데 표 뒤 여백이 6pt 뿐이라, 다음 문단 글자의 윗부분(≈0.75×글자크기)이 표 하단 테두리를 파고들었다(행 높이 누적은 정상이었다). 표 뒤 여백을 한 줄 높이로 교정 — 같은 입력에서 간격 24pt 확보. 실측 재현(pdftoppm 렌더 육안 확인) 후 수정하고, pdf.js 로 "표 마지막 줄과 다음 문단 baseline 간격 ≥ 16pt" 회귀 테스트 고정.

### 추가 (Added)
- **[R6] `GET /v1/contracts/:id/status` 에 `participantId`** — `signers[]`·`currentStep` 에 추가. 연동 시스템이 `contracts:read`(민감 스코프) 없이 status 만으로 수신처 정정 EP(R4)를 사용할 수 있다.
- **[R8] compose 응답에 본문 마커의 확정 좌표** — `X-Sign-Marks`(base64+JSON, HTTP 헤더는 latin1 만 허용하고 라벨에 한글이 들어가므로)·`X-Sign-Marks-Encoding`·`X-Sign-Marks-Count`. 흐름 조판이라 호출자가 알 수 없던 `[서명란#N]`·`[입력란#N:라벨]` 위치를 그대로 `createContract.signMarks` 로 사용할 수 있다(6KB 초과 시 좌표 헤더 생략).

### 테스트/문서
- 백엔드 e2e +9체크(participantId 노출·status 기반 수신처 정정, 표 겹침 간격, 좌표 헤더·인코딩·좌표계·create 연계). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.
- 연동 회신 문서 갱신: `docs/05-handoff/werub-integration-requests-2026-07-reply.md`(R1~R8).

## [1.19.0] — 2026-07-28 — 교부 링크 셀프 서비스: 기한 1회 연장·지정 이메일 전달

### 추가 (Added)
- **교부 링크 기한 1회 연장** — 수신자가 교부 화면에서 스스로 한 번 연장할 수 있다(`POST /v1/contracts/delivery/:token/extend`, 공개·토큰). 연장 폭은 기본 TTL(`CONTRACT_DELIVERY_TTL_HOURS`, 기본 72h), **재연장은 409**(발송자 재발급 안내). 만료 후에는 토큰이 폐기되므로 불가. `CONTRACT_DELIVERY_EXTENDED` 감사 봉인.
- **지정 이메일로 문서 전달** — 담당자·보관용 주소로 문서를 넘길 수 있다(`POST /v1/contracts/delivery/:token/forward`, 공개·토큰). 파일 첨부가 아니라 **새 교부 링크를 발급해 발송**하므로 다운로드가 접속기록에 남고 만료로 통제된다. **링크당 3회 상한**, 발송 실패 시 생성 토큰 폐기(미아 방지), 받는 주소는 마스킹해 응답·발송이력·감사(`CONTRACT_DELIVERY_FORWARDED`)에 기록.
- 교부 정보 응답에 `extendable`·`forwardRemaining` 추가 — 화면이 상태에 맞게 버튼을 비활성/숨김 처리.

### 테스트/문서
- 백엔드 e2e +7체크(연장 성공·재연장 409·이메일 형식 400·전달 마스킹/잔여 감소·감사 봉인·정보 갱신). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.
- 운영 매뉴얼에 "교부 링크 셀프 서비스" 안내 추가.

## [1.18.1] — 2026-07-28 — 교부 안내 개선: 두 파일의 역할·보관 방법 명시

### 변경 (Changed)
- **교부 화면·교부 메일 문구 보강** — 체결 완료 시 내려받는 두 파일의 역할을 명시했다: ①**완료 문서**(서명이 반영된 계약서 본문 — 각 장 QR 로 진위 확인) ②**감사추적인증서**(문서 해시·서명자·인증서·서명 이력 해시체인을 담은 증거 문서). 특히 **감사추적인증서는 파일 자체가 PAdES 로 봉인되어 있어 두 PDF 를 합치면 그 서명이 깨진다**는 점을 안내에 포함(합치지 말고 각각 보관). 링크 만료 시 재발급 요청 안내도 추가.
- 운영 매뉴얼에 "교부 파일이 2개인 이유" 안내 추가 — 계약서만 제3자에 제출하는 경우의 처리 포함.

## [1.18.0] — 2026-07-28 — weRub 연동 요청 R1~R5: 중간 서명 웹훅·완료 verifyToken·경량 상태·수신처 정정·계약 철회

연동팀 요청(weRub `sign-integration-requests-2026-07.md`) 5건 전건 반영. 회신 스펙: `docs/05-handoff/werub-integration-requests-2026-07-reply.md`.

### 추가 (Added)
- **[R1] `request.signer_completed` 웹훅** — 다자 서명에서 **한 명이 서명했으나 미완료**인 시점마다 발화. `completedSigners`·`requiredSigners`·`signer`·**`nextSigner`**(다음 차례 표시명·수신처) 포함, 기존 완료 웹훅과 동일한 HMAC(`X-Sign-Signature`)·재시도(8회)·`eventId` 멱등. 순차 계약에서 "1번 서명 완료 → 2번 차례"를 수신 측이 알 수 없어 진행이 멈추던 문제 해소.
- **[R3] `GET /v1/contracts/:id/status`** — 개인정보(이메일·기재값·문서) 없는 경량 상태 조회. **`contracts:write` 로 접근 가능**해 민감 스코프(`contracts:read`) 부여 없이 웹훅 유실 시 정합 복구 가능.
- **[R4] `PATCH /v1/contracts/:id/participants/:pid/email`** — 미서명 외부 서명자의 수신처 정정. 이미 서명한 참가자·내부 서명자·종결 계약은 거부하고, **정정 즉시 기존 포털 링크 무효화**(`403 CONTRACT_LINK_SUPERSEDED`, 토큰 `issuedAt` 기준 fail-closed) + `CONTRACT_PARTICIPANT_EMAIL_CHANGED` 감사 봉인. 철회·재발행 없이 오기재를 복구한다(이미 서명한 참가자 재서명 불요).
- **[R5] `POST /v1/contracts/:id/withdraw`** — 계약 API 단독 완결용 철회(`contracts:write`). 봉투 철회와 동일 동작 + `CONTRACT_WITHDRAWN` 감사 봉인 → 연동 소비자에 `requests:write` 부여 불요.

### 변경 (Changed)
- **[R2] 완료 웹훅에 `verifyToken`·`verifyUrl` 추가** — 체결 시 발급되는 공개 검증 토큰을 완료 통지에 동봉(접근암호 계약은 미발급이라 생략). 완료 웹훅 페이로드 보강기(`setCompletionEnricher`)로 계약 트랙만 주입(순환 의존 없음).
- **migration 0008** — 0007 부분 인덱스의 술어를 질의와 동일한 `(archived = false OR archived IS NULL)` 로 정정. 실측 결과 `IS NOT TRUE` 형태는 플래너가 함의를 증명하지 못해 인덱스가 선택되지 않았다(동일 형태로는 Index Scan 채택 확인).

### 테스트
- 백엔드 e2e +16체크(로컬 웹훅 수신 mock 으로 중간/완료 통지 페이로드·HMAC 헤더 검증, 상태 EP 개인정보 미노출, 수신처 정정 후 구링크 403·신규 링크 200·감사 봉인, 계약 철회 201·감사). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.17.1] — 2026-07-28 — 감사 미확인 가설 실측 반영: 검색 우회 차단·목록 인덱스·기재값 fail-closed

감사 취합 문서 §4(미확인 가설)를 **라이브 실측**으로 확인하고 결과를 반영.

### 수정 (Fixed)
- **[검색 필터 우회] Prisma `contains` 의 LIKE 메타문자 미이스케이프** — 실측 결과 `?q=%` 가 **전건 매칭**(라이브 77/77행), `?q=_` 도 임의 1글자와 매칭됐다. 저장소 계층에서 `%`·`_`·`\` 를 PostgreSQL 기본 escape(백슬래시)로 처리(실측 재확인: `%` → 0건, 한글 검색 결과 불변). 계약 검색(`q`)·라벨 필터·인증서 검색 3개 경로 모두 적용.
- **[기재값 fail-open] 복호·폰트 실패 시 빈 문서 생성** — 봉인된 기재값이 있는데 복호·무결성 검증이나 폰트 임베드가 실패하면 경고 로그만 남기고 **기재 항목이 빈 문서**가 교부·검증본으로 나갈 수 있었다. 두 경로 모두 오류로 중단(fail-closed). 포털 열람은 종전대로 원본 폴백(서명 대상 자체는 원본).

### 추가 (Added)
- **migration 0007** — 계약함 기본 조회(비보관·최신순)용 **부분 인덱스**(`kind, signMode, reqCreatedAt DESC WHERE archived IS NOT TRUE`). EXPLAIN 실측에서 기존 인덱스는 `kind+signMode` 까지만 Index Cond 로 쓰이고 보관 조건은 Filter·정렬은 별도 Sort 였다(현재 규모에선 무해하나 대량 시 전량 필터+정렬). 기존 인덱스는 보관함·분류 조회용으로 유지. 대용량 설치의 `CONCURRENTLY` 수동 생성 절차는 운영 가이드에 함께 기재.

### 문서
- `docs/05-handoff/edu-webhook-dead-notice.md` — **완료 webhook 26건 DEAD 통지**(edu 수신 URL 404 실측, 대조군 HIS 정상, 확인 요청 3건, 미수신분 복구 옵션 A/B/C, 수신 측 구현 참고).

### 테스트
- 백엔드 e2e +1체크(`%`·`_` 검색이 전건 매칭이 아님). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.17.0] — 2026-07-28 — 감사 정책 항목 종결: 공개 노출·권한 분리·보존 정책 (D2·D4·D6·D7)

감사 취합 문서 §3 의 정책 결정 항목을 권장안대로 반영. 이로써 감사 항목은 R9·R16(보류, 사유 명시)과 D5 의 프리셋 소유권 제한(기관 공용 원칙과 충돌)을 제외하고 종결.

### 변경 (Changed)
- **[D2] 공개 검증 링크의 기재 정보 노출 차단** — QR 공개 검증 페이지는 진위 확인 정보(서명 검증·해시·서명자)를 그대로 제공하되, **서명자가 기재한 구조화 개인정보(계좌번호·주소 등)가 봉인된 계약은 문서 열람을 403 으로 차단**한다. 응답에 `documentPublic` 플래그를 추가해 공개 페이지가 다운로드 버튼 대신 안내(교부 링크 이용)를 표시한다. 손글씨만 있는 기존 계약은 영향 없음.
- **[D4] 서식 쓰기 권한 분리** — `contracts:templates` 스코프 신설. 서식 생성·편집·복제·삭제·기본값 복원 EP 6종을 이 스코프로 전환하고, **admin 역할에만 부여**(연동 기계키에는 부여 불가 — `ASSIGNABLE_SCOPES` 제외). 서식 본문이 이후 모든 계약 문안을 좌우하므로 일반 계약 작성 권한과 분리했다. 콘솔 서식 화면도 권한 없는 역할에는 편집·삭제 버튼을 노출하지 않는다.
- **[D6] 프리셋 이메일 마스킹** — 프리셋 **목록**은 외부 상대방 이메일을 마스킹해 계약 목록·상세와 같은 정책으로 맞추고, 실제 적용(새 계약 폼 채움)은 신설 단건 EP `GET /v1/contracts/presets/:pid`(`contracts:write`)가 원문을 제공한다.

### 추가 (Added)
- **[D7] 첨부 보존·파기(옵트인)** — `CONTRACT_ATTACH_RETAIN_DAYS` 설정 시 **종결(체결·만료·철회) 계약**의 첨부를 보존연한 경과 후 자동 파기하고 `CONTRACT_ATTACHMENT_PURGED` 로 감사 봉인한다. **미설정이 기본이며 그때는 영구 보관**(계약 원본과 동일 정책) — 진행 중 계약은 어떤 경우에도 대상이 아니다. 실제 연한은 기관 보존정책(트랙 B6)에서 확정한다.

### 테스트/문서
- 백엔드 e2e +6체크(D2 요약 유지·문서 403, D4 기계키 403·admin 201, D6 목록 마스킹·단건 원문+`updatedBy`). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.
- 운영 매뉴얼에 서식 권한·공개 검증 노출 정책·첨부 보존 안내 추가, 감사 취합 문서 상태 갱신(D1~D7 반영 완료 표기).

## [1.16.0] — 2026-07-28 — 감사 후속 마무리: 순차 서명 열람 개선(D1)·조판/첨부 견고성(R10~R15)

감사 취합 문서(`docs/01-plan/audit-2026-07-28-followups.md`) 잔여 처리. 코드 항목은 R9·R16(보류, 사유 명시)을 제외하고 전량 완료.

### 변경 (Changed)
- **[D1] 순차 서명에서 뒤 서명자가 앞 서명자의 기재 내용을 보고 서명** — 포털 열람 문서를 원본 대신 **확정 기재값·손글씨가 반영된 표시본**으로 전환(`renderPortalView`). 원본(서명 대상·`documentHash`)은 그대로이며 화면의 해시 배지·안내 문구로 이를 명시한다. 합성 실패 시 원본으로 폴백해 열람 자체는 막지 않는다.
- **[D3] 기재값 조회 스코프 상향** — `GET /v1/contracts/:id/fill-values` 를 `contracts:read` → **`contracts:write`**. 계좌번호 등 구조화 PII 원문이 계약 이력 열람보다 낮은 등급이던 역전 해소.
- **[R10] 첨부 불변 정책의 경합 차단** — 첨부 추가·삭제의 상태 판정을 잠금 **안에서** 최신 meta 로 재수행하고, `send()` 는 메일 발송 **전에** `lastSentAt` 을 기록해 발송 도중 첨부가 바뀌지 않게 한다(최초 발송이 전량 실패하면 되돌림).

### 수정 (Fixed)
- **[R11] 조판 제목 이중 인쇄** — 리치 에디터가 첫 줄을 문서제목(h1)으로 승격하는데 상단 제목을 또 그려, 모든 서식에서 제목이 두 번 인쇄됐다 → `doc` 첫 블록이 h1 이면 별도 제목 렌더 생략.
- **[R12] 첨부 삭제 원자성** — 목록에서 먼저 지우고 blob 삭제가 실패하면 감사에는 REMOVED 인데 암호문이 남았다 → blob 선삭제로 순서 반전.
- **[R13] 조판 제어문자** — `doc` 런 텍스트의 `\n` 이 여러 줄로 그려지는데 y 는 한 줄만 내려가 다음 블록과 겹쳤다(API 직접 호출) → 제어문자를 공백으로 정규화.
- **[R14] 표 8열 상한** — 편집기에서 9열 이상 생성이 가능해 저장 시점에야 400 이 났다 → 8열에서 열 추가 비활성 + 오류 메시지에 **몇 번째 표 행**인지 표기.
- **[R15] 서식 `required` 왕복 유실** — 편집기가 `required` 를 전송하지 않아 선택 필드가 저장만 해도 필수로 뒤집혔다 → payload 에 포함.
- **[D5 부분] 프리셋 변경 추적** — 기관 공용 프리셋에 `updatedBy` 기록·삭제 시 행위자 로그 추가(소유권 제한은 "기관 공용" 원칙과 충돌해 별도 결정 대기).

### 문서
- **[R7]** 대용량 설치의 인덱스 추가 절차를 운영 가이드에 추가 — Prisma 마이그레이션은 트랜잭션 안에서 실행되어 `CONCURRENTLY` 를 쓸 수 없으므로, 수백만 행 규모에서는 배포 전 `CREATE INDEX CONCURRENTLY` 수동 적용(+`lock_timeout`).
- **[R9·R16] 보류 사유 명시** — 첨부 스트리밍은 저장 구조 변경+기존 blob 마이그레이션이 필요해 단독 과제로 분리, 인프로세스 잠금은 다중노드 전환 시점에 저장소 수준 잠금과 함께 결정.

### 테스트
- 백엔드 e2e +3체크(2차 서명자 포털 열람 문서에 1차 기재값 반영·원본 해시 불변·1차 기재 서명). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.15.3] — 2026-07-28 — 감사 후속 R1~R6: 메타·캐시 정합성, 목록 N+1·집계 상한 제거

감사 취합 문서(`docs/01-plan/audit-2026-07-28-followups.md`) §2 의 R1~R6 처리.

### 수정 (Fixed)
- **[높음·R1] meta 정본과 필터 캐시의 비원자 갱신** — `saveMeta` 성공 후 `syncFilterCols` 가 실패하면 정본은 보관인데 캐시는 비보관으로 남고, 재보관은 멱등 가드에 걸려 **복원 불가 유령 계약**이 됐다. 계약 단위 잠금 안에서 갱신하고 캐시 동기화 실패 시 **정본을 롤백**한다. 생성 시 동기화 실패는 1회 재시도 후 백필 플래그를 지워 다음 부팅에 치유.
- **[높음·R2] stale meta 스냅샷 write-back** — 발송·마크 재지정·알림 기록 등이 진입 시점 스냅샷을 통째로 저장해, 그 사이 완료된 보관·재분류를 되돌렸다(archive↔send 경합). `updateMeta()`(잠금 안에서 최신 meta 재조회 후 필드 단위 갱신)로 7개 지점 전환, 보관·복원의 멱등 판정도 잠금 안으로 이동.
- **[높음·R3] 계약 목록 N+1** — 행마다 ①발송이력 전체 스캔(`kind='notify'` 전 행을 읽어 JS 필터) ②암호화 원본 PDF 전체(JSONB) 로드로 존재 여부만 확인. 발송 시각은 `meta.lastSentAt` 우선(레거시만 폴백), 문서 존재는 `metaExists`(count) 로 확인, `notifyByRequest` 는 JSON 경로 조건으로 DB 푸시다운.
- **[높음·R4] CSV 조용한 절단** — 계약 CSV 가 단발 10k 조회로 초과분을 경고 없이 잘랐다(감사·보존 목적). 요청 트랙과 동일한 배치 페이징(500)으로 전량 출력.
- **[중간·R5] 통계 상한** — `stats`·`categorySummary` 가 10k 상한으로 부정확한 수치를 확정값처럼 반환했다 → 페이지 반복 집계(폭주 방지 상한 도달 시에만 경고).
- **[중간·R6] 자동 리마인더 대상 누락** — 미완료 최신 500건만 조회해 **가장 오래 방치된 계약**이 독촉·만료 경고에서 영구히 빠졌다 → 전량 페이지 반복.
- **[중간·R8] 부팅 백필** — 단발 10k 조회 후 무조건 완료 플래그를 기록해 초과분이 영구 미백필로 남았다 → 페이지 반복 + 완주 시에만 플래그, 스킵 판정을 "캐시 미보유"에서 **"정본과 값 불일치"**로 바꿔 어긋난 캐시도 자가 치유.

### 추가 (Added)
- `SignStore.metaExists(key)` — 대용량 슬롯(문서 블롭)을 값까지 읽지 않는 존재 확인 경로(Prisma=count, in-memory=조회).

### 테스트
- 백엔드 e2e +6체크(동시 보관+발송 경합 후 목록 양쪽 정합·동시 보관 멱등·복원 시 캐시 동반 복원·목록 lastSentAt·CSV 전량 행수 일치). 게이트 백엔드 0실패 · prisma 계약 · UI 69/69.

## [1.15.2] — 2026-07-28 — 감사 라운드 2차: 감사체인 직렬화·공개 경로·입력 검증 하드닝

### 수정 (Fixed)
- **[높음] 감사 해시체인 append 무직렬화** — `lastAudit → next → appendAudit` 이 잠금 없이 실행돼, 같은 스트림에 동시 기록이 몰리면(예: 교부 링크 첨부 다운로드 동시 다발) 같은 prevHash 로 중복 append 되어 **append-only 체인이 영구 파손**될 수 있었다. `AuditChainService.appendSerialized()`(싱글턴·스트림 단위 잠금)로 계약·첨부·서명요청·결재·인증서·설정 6개 경로를 직렬화(서비스가 달라도 같은 스트림이면 같은 잠금 공유).
- **[중간] 보관(archive) 계약이 교부 링크로 계속 열람** — 보관 시 공개 검증 토큰만 폐기하고 교부 토큰은 TTL(기본 72h) 동안 유효해 완료 PDF·감사추적인증서·첨부가 계속 다운로드됐다 → 교부 경로에도 보관 게이트(410).
- **[중간] raw 파서 전역 등록** — 인증(가드) 이전에 모든 경로가 최대 21MB 를 버퍼링해 무인증 대량 전송으로 힙을 소모시킬 수 있었다 → 문서 업로드·첨부 라우트로 스코프 축소.
- **[중간] 계약 목록 파라미터 무검증** — `limit=9999999`(전량 적재)·`limit=abc`(NaN take)·`offset=-1`·`from=2026-13-45`(Invalid Date 500) 이 그대로 통과했다 → 공용 `parsePage`/`parseDateRange` 적용(상한 200 클램프).
- **[중간] 계약 검색어 대소문자** — `searchText` 는 소문자로 저장되는데 계약 컨트롤러만 원문을 넘겨 대문자 검색이 항상 0건이었다(문서ID 붙여넣기 검색 실패) → 소문자 정규화.
- **[중간] 첨부 형식 판정이 Content-Type 헤더 신뢰** — PNG·JPEG 매직바이트를 검사하지 않아 임의 바이너리가 이미지로 저장·서빙됐다 → 시그니처 검증.
- **[중간] 콘솔 첨부 다운로드 감사 누락** — 내부자(`contracts:read`)의 첨부 열람이 이력에 남지 않았다 → `CONTRACT_ATTACHMENT_ACCESSED`(via=CONSOLE) 기록.
- **[낮음] `CONTRACT_ATTACH_MAX_MB` 오타 시 NaN** — 크기 상한 비교가 항상 false 가 되어 서비스 상한이 사라졌다 → 유한값 검사 후 기본값 폴백.

### 변경 (Changed)
- 계약 목록/보관 필터의 NULL 처리를 `OR [false, null]` 로 명시하고 카테고리 조건과 `AND` 합성 — Prisma `not` 이 NULL 행을 돌려주지 않는 의미론에 의존하지 않도록(백필 누락 시 계약이 목록에서 사라질 여지 제거).

### 테스트
- 백엔드 e2e +9체크(보관 교부 410·복원 재개·limit 클램프·비숫자/음수/잘못된 기간·대문자 검색·시그니처 400/201·콘솔 다운로드 감사), prisma 계약 테스트의 where 매처를 AND/OR 합성으로 확장. 게이트 백엔드 0실패 · UI 69/69.

## [1.15.1] — 2026-07-28 — 감사 라운드 1차 수정: 기재값·마크 무결성, 조판 견고성

다중 에이전트 코드 감사(v1.11~v1.15 신규 코드)에서 확인된 결함 중 국소적·저위험 항목 수정.

### 수정 (Fixed)
- **[높음] 배치 편집기 저장이 입력란(FIELD) 마크를 전량 삭제** — 계약 상세 '서명란 위치 지정'이 SIGN 마크만 PATCH 했고 모달 종료 경로가 저장뿐이라, 열었다 닫기만 해도 입력란이 사라져 미서명자는 기재 없이 서명하고 기재 완료분은 표시본에서 값이 사라졌다. SIGN·FIELD 전량 전송으로 수정.
- **[높음] 서명 후 기재값 덮어쓰기** — 발송·독촉으로 포털 토큰이 2개 살아 있으면 서명 완료 후 잔여 토큰으로 기재값을 다시 봉인해 교부본·QR 검증본 내용이 바뀔 수 있었다. 서명 완료자·기존 봉인 존재 시 409, 순차 계약은 차례가 아닌 참가자의 기재 봉인도 차단.
- **[높음] 봉인 후 입력란 구성 변경** — 봉인 키가 마크 인덱스 기반이라 마크 재구성 시 값이 사라지거나 다른 칸에 합성됐다. 봉인된 계약은 입력란 구성 변경 409 + 서명자 순번 범위 검증(400) + `CONTRACT_SIGN_MARKS_UPDATED` 감사 기록.
- **[높음] 서식 에디터 서명자 순번 불일치** — 빈 서명자 행까지 세어 배치한 마크가 실제 참가자와 어긋나 손글씨·기재값이 합성되지 않았다(경고 없음). 생성 시와 동일하게 지정된 행 기준으로 통일.
- **[높음] 표 조판** — 행 수가 많으면 `Math.max` 스프레드가 RangeError(500) → reduce. 한 페이지보다 높은 행이 조용히 잘려 본문이 소실되던 문제는 400으로 명시 거부.
- **[중간] 포털 미기재 오표시** — 필수 미기재(409)를 "이미 서명되었습니다"로 표시하고 입력값을 버리던 문제 → 기재 단계 복귀.
- **[중간] 보이지 않는 문자 기재** — 제로폭·BiDi 서식문자로 필수 입력란을 사실상 공란 체결할 수 있었다 → 제거 + NFC 정규화.
- **[중간] stamp EP** — 암호화·손상 PDF에서 500 → 400(원인 노출), 마크 0건이면 폰트 임베드·재직렬화 없이 원본 반환.
- **[낮음]** 감사 봉인 실패 시 남던 고아 기재 레코드 롤백, 미배정 라벨 오류 메시지 상위 5개 절단.

### 변경 (Changed)
- 입력 배열 상한 도입: `doc` 5000블록 · `runs` 200 · `fillValues` 50 · `labels` 20(각 40자, `|` 금지) · `signers` 20.
- a11y: 계약 상세(기재값 증적)·포털 기재 폼 스캔 케이스 추가, 무결성 배지 대비 미달(2.27:1) 수정.

### 테스트
- 백엔드 e2e +5체크(재기재 409·봉인값 불변·입력란 구성 고정·서명자 순번 400), UI 69/69(a11y 18 포함).

## [1.15.0] — 2026-07-28 — fill-at-signing 고도화: 입력 타입·박스 맞춤·기재값 증적 (설계 §5 확정)

### 추가 (Added)
- **입력란 타입**(`PlacedMark.fieldType` — `text`·`date`·`money`·`number`, 미지정=text 하위호환): 서버가 형식을 검증하고 **정규화된 값**을 봉인·합성한다(날짜 `YYYY-MM-DD` 실재 일자 검사, 금액 3자리 구분·선행 0 제거, 숫자 콤마 제거). 타입별 길이 상한(text 200·date 10·money/number 20). 배치 편집기 팔레트에 타입 선택, 포털·내부 서명 폼에 타입별 placeholder·`inputMode`·maxLength 반영.
- **기재값 증적 조회** `GET /v1/contracts/:id/fill-values`(`contracts:read`) — 서명자별 기재 원문·타입·봉인 SHA-256·기재 시각·경로(PORTAL/CONSOLE)·무결성 재검증(`integrityOk`). 계약 상세 서명자 탭에 표시하고, 진행 타임라인에 `CONTRACT_FILLED`(입력란 기재) 추가.
- 클라이언트 선검증(`web/src/lib/field-type.ts`) — 서버와 동일 규칙으로 제출 전에 차단(정본은 서버). 포털은 서버가 형식을 거부(400)해도 종료 화면 대신 **기재 단계로 되돌려** 수정할 수 있다.

### 변경 (Changed)
- **기재값 합성 박스 맞춤**: 한 줄 고정 축소 → **어절 단위 줄바꿈(초과 어절은 글자 단위) → 폰트 축소(11→6pt) → 최후에만 말줄임(…)+경고 로그**. 세로 중앙 정렬·줄 높이 1.25. 긴 주소·계좌명이 잘리지 않는다.
- 브랜드 표기 **"의료 전자서명" → "의료/IT 전자서명"**(콘솔·포털·매뉴얼·README·OpenAPI 타이틀 — 과거 릴리즈 기록은 원문 보존).

### 수정 (Fixed)
- 콘솔 내부 서명 폼의 **무라벨 입력란 라벨 폴백이 서버와 어긋나던 결함**(필터된 배열 인덱스 사용 → 서버는 전체 마크 인덱스) — 라벨 미지정 입력란에서 "필수 입력란 미기재" 409 를 유발할 수 있었다.

### 테스트/문서
- 백엔드 e2e +11체크(타입 위반 400 3종·정규화 값 조회·pdf.js 추출로 정규화 합성·줄바꿈 전량 표시·말줄임·조회 EP 무스코프 403), UI e2e +1(포털 타입 선검증→서명→상세 증적). OpenAPI **132 paths**. 설계서 `fill-at-signing.design.md` **v1.1**(§5 미결 3건 확정), 매뉴얼 §4.3·로드맵 갱신.

## [1.14.0] — 2026-07-28 — 리치 에디터 확장: 정렬·목록·표 (백로그 A5)

### 추가 (Added)
- **계약서 본문 에디터 확장**(TipTap 3.27): **정렬**(좌/중/우, TextAlign) · **불릿/번호 목록**(중첩 지원) · **표**(3×3 삽입·행/열 추가/삭제·헤더 행) — 편집 화면 표시와 PDF 조판 1:1 유지.
- **PDF 조판 확장**(`ComposeBlock` v2 — `listItem`·`tableRow` 타입, `align`): 정렬 오프셋(줄 단위 폭 계산), 목록 들여쓰기(깊이별)+접두(•/번호), **표 그리드**(균등 열폭·셀 줄바꿈·행 높이 자동·테두리·헤더 음영, 행 단위 페이지 분할). 줄바꿈 레이아웃을 `layoutRuns` 공용 헬퍼로 재구성(문단·셀 공용).
- doc h1 조판이 왼쪽 정렬이던 것을 **가운데 기본**으로 정정(에디터 표시와 일치 — 명시적 align 지정 시 우선).

### 수정 (Fixed)
- **에디터 툴바 활성 상태 stale**: TipTap v3의 `shouldRerenderOnTransaction` 기본 false 로 커서 이동·서식 토글 시 툴바 하이라이트가 갱신되지 않던 결함 수정(기존 제목/굵게 버튼 포함).

### 테스트/문서
- 백엔드 e2e +6체크(정렬·목록 접두·중첩 번호·표 셀 텍스트 pdf.js 추출·비정형 셀 400), UI e2e +1(툴바·목록/표 편집 반영). 표 셀 검증(1~8열·10k자)은 서비스 레벨(2차원 DTO 한계). 매뉴얼·로드맵 갱신.

## [1.13.0] — 2026-07-28 — fill-at-signing: 포털 서명자 입력란 직접 기재 (백로그 A4)

### 추가 (Added)
- **fill-at-signing**(설계 `fill-at-signing.design.md` 권장안 B): 배치 편집기의 입력란(FIELD) 마크가 서명자에게 배정되면, 외부(포털)·내부(콘솔) 서명자가 **서명 시 직접 기재**. 원본 해시 봉인은 불변 — 기재값은 손글씨 서명과 동형으로 **암호화 보관(`ctfill:*`) + SHA-256 감사 봉인(`CONTRACT_FILLED`)**, 문서 표시본·완료 교부본에 해당 좌표로 텍스트 합성(나눔고딕 전체 임베드).
- **fail-closed 규칙**: 배정 입력란 전량 기재 필수(누락 409·배정 외 라벨 400·값 200자 상한), 기재 봉인 실패 시 서명 미수행. 기재·서명은 한 트랜잭션(`fillValues`를 sign body에 동봉 — 별도 저장 EP 없음).
- **배정·합성 매핑**: 손글씨와 동일한 제출 순번 규칙(signOrder 정렬 위치) — 순차/동시 모두 지원. 계약 생성·서명란 재지정 시 FIELD 마크도 저장(기존 SIGN만 저장하던 것 확장).
- **UI**: 포털 정보에 `inputFields` 노출 → 기재 폼(필수 검증) 카드, 콘솔 내부 서명 Modal에 동일 폼.

### 테스트/문서
- 백엔드 e2e +8체크(배정 노출·미기재 409·배정 외 400·감사 봉인·합성 렌더 pdf.js 텍스트 추출·원본 불변), UI e2e +1(포털 기재 필수→서명). 매뉴얼 체결 흐름 갱신, 설계 문서 v1.0 as-built, 로드맵 A4 완료.

## [1.12.1] — 2026-07-27 — 계약 목록/통계 DB 푸시다운 (백로그 A3)

### 변경 (Changed)
- **계약함 목록 확장성**: 보관·분류·라벨 필터가 "상한 2000건 스캔 후 행별 meta 조회·서비스 필터"였던 것을 **봉투 필터 캐시(`StoredRequest.ct*`) + DB 푸시다운**으로 전환 — 상한 제거, 페이지·total 정확, 행별 부가 조회(N+1)는 페이지 크기에만 비례. 정본은 contract-meta 유지(보관/재분류 시 `syncFilterCols` 동기화).
- **stats·카테고리 집계**: 행별 meta 조회 제거(단일 스캔·캐시 필드 집계, 상한 10k·초과 경고).
- **마이그레이션 0006**(`archived`·`category`·`labelsText` 컬럼+인덱스, 기동 시 자동 적용) + **레거시 백필**(부팅 1회, `contract-filter-cols:v1` 플래그·best-effort — 3개 스토어 공통 앱 경로).

### 테스트
- prisma 계약 테스트 +7체크(보관 제외 시 레거시 null=비보관, '기타'=null 포함, 라벨 `|`구분 부분충돌 방지 등 3VL 정합). 기존 계약함 필터·보관·카테고리 e2e가 신규 경로로 회귀 검증.

## [1.12.0] — 2026-07-27 — 새 계약 프리셋·생성→발송 원플로우·진행 타임라인 (백로그 A2 = UI 기획 U5)

### 추가 (Added)
- **새 계약 프리셋**: 자주 쓰는 요청 구성(제목·서명자열·서명 방식·라벨·분류)을 저장/불러오기 — 문서 서식이 아닌 "요청 구성" 저장(기획 원칙 유지), **기관 공용**(주소록 동일 원칙), **접근암호 값 미저장**(사용 여부만). 동일 이름 upsert·최대 30개. `ContractPresetService` + `GET/POST/DELETE /v1/contracts/presets(/:pid)`. 새 계약 화면 프리셋 카드(선택 적용·현재 구성 저장·삭제).
- **생성→발송 원플로우**: 새 계약 '생성 후 바로 발송' 체크 → 생성·업로드 직후 외부 서명자 이메일 발송(1클릭, best-effort — 실패 시 상세에서 재발송).
- **진행 타임라인**: 계약 상세 서명자 탭에 감사 스트림 기반 시간순 타임라인(생성→발송→접근암호 확인→서명(단계)→교부→보관).

### 결정 (Decisions)
- 프리셋 저장 위치 = **기관 공용**(UI 기획 미결 3 해소). 리마인더 정책값 콘솔 수정 = **보류**(env 유지 — 권한·감사 설계 필요, 백로그 유지).

### 테스트/문서
- 백엔드 e2e +6체크(저장·upsert·암호 미저장·검증·삭제·스코프), UI e2e +1(저장→불러오기→바로 발송→타임라인). 매뉴얼 §4.3·UI 기획서(U5 완료)·로드맵(A2 완료) 갱신. OpenAPI 재생성.

## [1.11.0] — 2026-07-27 — 계약 첨부/다중문서 (백로그 A1)

### 추가 (Added)
- **계약 첨부 문서**(설계 §11): 계약에 열람용 부속 문서(견적서·사업자등록증 등) 첨부 — PDF·PNG·JPEG, 파일당 10MB(`CONTRACT_ATTACH_MAX_MB`)·계약당 10건. **서명 대상 아님**(주 문서 `documentHash` 단독 봉인), 각 첨부 SHA-256을 감사 체인에 봉인(`CONTRACT_ATTACHMENT_ADDED/REMOVED`)해 열람 무결성 증거 보존. SecretBox AES-256-GCM 암호화 영구 보관, 목록 RMW KeyedMutex 직렬화.
- **불변 정책**: 추가/삭제는 작성(CREATED·미발송) 상태에서만(발송 후 409 — 서명자 열람 정합). 발송 시 `meta.lastSentAt` 기록.
- **EP 6종**: `POST/GET/DELETE /v1/contracts/:id/attachments(/:aid)`(콘솔) · `GET /v1/portal/:token/attachments(/:aid)`(**unlock 게이트 적용**) · `GET /v1/contracts/delivery/:token/attachments(/:aid)`(교부). 포털·교부 다운로드는 `CONTRACT_ATTACHMENT_ACCESSED` 기록(best-effort). 비ASCII 파일명 RFC 5987 응답 헤더.
- **UI**: 계약 상세 '첨부' 탭(업로드·목록·열람·삭제, 발송 후 읽기전용) · 포털 첨부 문서 카드(unlock 후) · 교부 페이지 첨부 다운로드.

### 테스트/문서
- 백엔드 e2e +17체크(형식·크기·불변 409·포털 unlock 게이트·교부·감사 봉인·한글 파일명), UI e2e +1(업로드→포털 노출→삭제). 매뉴얼 §4.3 첨부 행 추가. OpenAPI paths 재생성.

## [1.10.2] — 2026-07-27 — 시리얼 카운터 영속화·edu P0 회신·문서 as-built 동기화

### 수정 (Fixed)
- **인증서 시리얼 접두 카운터 영속화**: `serialSeq`가 발급 시 영속되지 않아 재기동마다 `CERT-0001…`부터 리셋(유일성은 랜덤 접미가 보장, 접두만 중복 — 연동팀 "저장소 초기화" 오인 유발). 발급 시점 `persistBundle()` 영속으로 수정, 재기동 e2e에 시리얼 접두 연속성 체크 추가.

### 문서 (Docs)
- **edu P0 조사 회신**(`docs/05-handoff/edu-store-persistence-reply.md`): "인메모리 스토어로 registrar 인증서 소실" 요청 조사 — 스토어는 2026-06-15부터 PG/Prisma 영속(오진, typed 테이블은 미사용 분석 스키마), 실원인=edu 기계키 자신의 폐기(07-09 "테스트"·07-10 "시범 데이터 정리"). 복구 절차(신규 enroll·시리얼 교체·폐기 allow-list)·멱등 보장 확인 포함.
- **기획서·문서 as-built 동기화**: README(v1.10.1 기능 현황·contracts API·123 paths), 전자계약 설계서 v1.0 as-built(§5 보안 실구현·§10 구현 이력), UI 기획서 v0.3(후속 화면 9종·U1~U4 완료), 문서 인덱스 2종 갱신.

## [1.10.1] — 2026-07-27 — 전자계약 안정화(검토 잔여 보완)·매뉴얼 정정

2026-07 코드검토(4개 에이전트 감사)의 잔여 중간등급 3건 해소 + 이연된 매뉴얼 정정.

### 보안/수정 (Fixed)
- **접근암호 무차별 대입 잠금(⑪)**: 포털 unlock 연속 오류 5회 → 해당 계약 10분 잠금(429, 잠금 중 정상 암호도 차단). 계약 단위 직렬 판정으로 병렬 시도 우회 방지, `CONTRACT_UNLOCK_LOCKED` 감사 봉인, 성공 시 카운터 폐기. IP 레이트리밋(H4)·최소 4자(`@Length`)와 별개 계층.
- **커스텀 서식·주소록 lost update(⑫)**: 단일 meta(custom 배열·overrides/history 맵·주소록 배열)의 read-modify-write 를 인프로세스 KeyedMutex(`src/domain/keyed-mutex.ts`)로 직렬화 — 동시 편집·발송 자동학습 경합 시 갱신 유실 제거(단일 노드 전제, restore→update 재진입은 updateLocked 분리).
- **PARALLEL 동시완료 중복 처리(⑬)**: 동시 서명 완료 시 sign()/onPortalSigned() 양쪽이 COMPLETED 를 관측해 시점봉인(TSA)·검증토큰·자동 교부가 중복 실행되던 경합 → `handleCompletion()`(계약 단위 직렬 + `ctdone` 처리완료 플래그)으로 1회 보장(교부 메일 중복 발송 차단).

### 문서 (Docs)
- **운영 매뉴얼 정정**: v1.10.0 때 앵커 변경으로 잘못 삽입된 서식 편집 문단을 정위치로 이동·정정 — 계약 서식 행에 내장 직접 편집(오버라이드·기본값 복원)·버전 이력(최근 20건)·실시간 검증 반영("내장 16종 읽기전용" 낡은 문구 제거), 체결 흐름에 접근암호 잠금 안내 추가. CHANGELOG [1.10.0] 소급 기입.

### 테스트
- `general-contract.e2e.mjs` +10체크: 잠금(1~4회 403·5회 429·잠금 중 정상암호 429·감사 봉인), 주소록/서식 동시 뮤테이션 전원 영속, PARALLEL 외부 2인 병렬 서명 완료 후처리 1회(CONTRACT_DELIVERED 중복 없음).

## [1.10.0] — 2026-07-07 — 의료 계약서 20종 확대·서식 편집(내장·이력)·전자계약 보안 정합 보완

(릴리즈 시 누락된 항목 소급 기입 — 태그 v1.10.0·커밋 b463bef)

### 추가 (Added)
- **계약 서식 16→36종**: 의료기관 특화 10종(진료협력 협약·임상시험 수탁(CRO)·건강검진 위탁·전공의 위탁수련·의료정보시스템(EMR/OCS/PACS) 유지보수·의료기기 유지보수·방사선 안전관리·세탁물 위탁·보안경비·주차장 위탁운영) + 보건행정 10종(개설신고·개설허가신청·휴폐업신고·변경신고·방사선 설치신고·감염병 발생신고·비급여 보고·요양기관 현황신고·의료폐기물 배출자신고·범용 행정공문), 기존 16종 표준 일반조항(통지·권리불포기·완전합의·분리가능성) 보강.
- **계약 서식 편집 강화**: 내장 서식 직접 편집(기관 오버라이드 — 코드 원본 보존·기본값 복원)·버전 이력/되돌리기(서식당 20건)·편집기 {{키}} 실시간 검증·필드 자동추출·마커 삽입.

### 보안/수정 (Fixed)
- **전자계약 보안·정합 보완(검토 🔴2+🟡6+#6)**: 공개 QR 접근암호 계약 노출 차단, 손글씨 서명자 매핑 정합, baseUrl 검증(피싱 차단), 내부 알림 중복 방지, 보관 계약 검증토큰 폐기, 보건행정 고지문 분기, 목록 상한 관측성(truncated), 검증토큰 읽기 부작용 제거, 순차 서명 열람 게이팅(auto-advance 발송).

### 문서/기타
- OpenAPI 120→123 paths(서식 reset/history/restore EP). 백엔드 e2e 0실패 + UI 62/62.

## [1.9.0] — 2026-07-06 — 일반 전자계약(행정·일반 계약) 트랙 — 준비→발송→체결→관리

모두싸인 기능 벤치마크로 **원내용 일반 전자계약 트랙**을 신설(설계 `docs/02-design/features/general-contracts.design.md`, UI 기획 `docs/02-design/contract-management-ui-plan.md`). 환자 동의서 경로(HIS 연동·해시-only)는 무변경. **피처플래그 `GENERAL_CONTRACTS` 기본 OFF** — 미설정 시 전 EP 404·콘솔 메뉴 자동 숨김(기존 운영 무영향). OpenAPI 103 paths.

### 추가 (Added)
- **계약 코어(`/v1/contracts`, P1)**: 생성(멱등·서명자 인증서 자동발급 — 내부 STAFF·외부 WITNESS 임시)·PDF 업로드(SHA-256==documentHash 검증)·발송/독촉(외부 서명자 이메일+포털 링크)·내부 서명(콘솔 세션 지정자 바인딩·fail-closed)·목록/상세/CSV·관리자 문서 열람. 봉투=다자 순차서명(signMode=CONTRACT) 재사용 — 순서게이팅·PKI 실서명·TSA·verify 무상속. 스코프 `contracts:read/write`(admin·operator·ERP 기계키), 전용 감사 스트림 `contract:<id>`(생성·발송·독촉·접근암호·서명·교부, 체결 시 TSA 앵커).
- **포털 접근암호(unlock)**: 외부 서명자 본인확인 = 이메일 링크 소유 + 접근암호(scrypt 해시·rate-limit·실패 감사). unlock 전 열람·서명·정보 차단(제목만 노출). `POST /v1/portal/:token/unlock`.
- **계약 원본 영구 암호화 보관**: 계약 트랙 한정 AES-256-GCM 봉인 저장(persistent — sweep·TTL 미적용). 원내 구축형이라 외부 반출 아님(포털 미리보기 Option A 논거 확장).
- **SMTP 이메일 발송**: Notifier에 SMTP 드라이버(nodemailer, EMAIL 채널) — 원내 메일서버 직결(벤더 불요). 자격 = 연동 설정(smtpUrl/smtpFrom) > env(`SMTP_URL`/`SMTP_FROM`). 미설정/개발 = mock.
- **자동 리마인더(P3)**: 스케줄러 잡(`SCHEDULER_CONTRACT_MIN` 기본 60분) — 미서명 독촉(`CONTRACT_REMIND_AFTER_DAYS` 기본 3일, 0=끔) + 만료 임박(24h) 경고 계약당 1회. 수동 트리거 `POST /v1/contracts/maintenance/auto-remind`.
- **완료문서 자동 교부(P3)**: 체결 시 외부 서명자별 **만료형 다운로드 링크**(72h, `CONTRACT_DELIVERY_TTL_HOURS`) 이메일 자동 발송 + 수동 재발급(`POST :id/deliver`). 공개 교부 화면에서 완료 PDF·감사추적인증서 다운로드(전건 접속기록 F008). 링크 기준 = 마지막 발송 baseUrl > `CONTRACT_PORTAL_BASE_URL`.
- **콘솔 "전자계약" 섹션(P2·U1~U4)**: **계약 현황**(현황 카드·처리 필요 목록 — 내 서명 차례/발송 대기/만료 임박) · **계약함**(상태 탭·검색·라벨 칩 필터·기간 필터·현재 단계 컬럼·CSV) · **새 계약**(PDF 선택→SHA-256 자동 계산→원본 자동 업로드·내부/외부 서명자 다단·접근암호·라벨) · **알림·리마인더**(자동 독촉 정책·지금 실행·계약 발송이력) · 상세(서명자 진행·문서 뷰어·**이력 탭**(감사 스트림·무결성 배지·CSV)·검증 탭·발송/독촉/내부 서명/교부 재발급). 메뉴는 기능 비활성 시 **자동 숨김**(stats 프로브), 활성화 시 재배포 없이 등장. 메인 대시보드 "전자계약 진행" 위젯.
- **포털**: 계약 잠금 화면(접근암호 입력) → unlock → 기존 문서 뷰어·동의 게이트·서명 흐름 재사용. 공개 교부 페이지 `/contracts/delivery/<token>`.

### 테스트/문서
- 백엔드 e2e `test/general-contract.e2e.mjs`(57체크, 게이트·`e2e:contract` 편입) — 풀사이클·접근암호·권한·영구보관·교부·자동독촉·플래그 OFF. UI E2E `contracts.spec.ts`(6)+a11y 6화면 편입 → **Playwright 47/47+axe**. 백엔드 전체 회귀 0실패.
- 운영 매뉴얼은 기능 활성화 시점에 일괄 갱신(포털 문서·전자결재와 동일 정책).

### 운영 (Ops)
- 활성화: `.env.prod`에 `GENERAL_CONTRACTS=on` + `SMTP_URL`/`SMTP_FROM`(+선택 `CONTRACT_PORTAL_BASE_URL`·`CONTRACT_REMIND_AFTER_DAYS`·`CONTRACT_DELIVERY_TTL_HOURS`·`SCHEDULER_CONTRACT_MIN`). 미설정 시 기존 동작과 완전 동일.

## [1.8.1] — 2026-07-05 — 운영 매뉴얼 동기화(문서 인증 목록·감사·로그 필터·전자결재 정리)

### 문서 (Docs)
- **운영 매뉴얼 갱신**(`web/manual.source.html`): v1.8.0 기능 반영 — **문서 인증 목록**(`/admin/wsign-documents`) 화면 추가(외부 문서인증 어테스테이션 통합·문서 상세·무결성), 로그 개요에 문서 인증·감사·로그 필터(검색·기간·유형·시스템/상태) 반영. 숨긴 전자결재(결재함) 섹션은 "참고"로 축약(구현·플래그 보존, 콘솔 메뉴 숨김). OpenAPI 버전 1.8.1로 갱신.

## [1.8.0] — 2026-07-05 — 문서 인증 목록·감사·로그 필터 확장·전자결재 인증로그/MFA·UI 정리

v1.7.0 이후: 외부 문서인증(weRB) 어테스테이션을 통합한 **문서 인증 목록**, **감사·로그 전 화면 필터 확장**(기간·유형·시스템·상태), 전자결재 후속(인증서 자동발급·MFA step-up·통합 인증로그), 콘솔 정리(전자결재 UI 숨김·수동 상신 제거), UI 수정(모달 포커스·폼 정렬·대비). OpenAPI 명세 갱신(85 paths).

### 추가 (Added)
- **감사·로그 필터 확장(전 화면)**: 감사·로그 4개 화면 모두에 **기간(from/to 날짜)·이벤트 유형(드롭다운)·초기화** 필터 + 페이지별 추가 필터(**문서 인증 목록=시스템**, **문서·발급 로그=상태**) 추가(기존 텍스트 검색에 더해) — ①인증 행위 로그 ②문서 인증 목록 ③관리자 감사(로그인·계정) ④문서·발급 로그. 발급/봉인 목록이 커져도 좁혀 조회. 공용 `AuditFilterBar` 컴포넌트로 통일: 스트림 뷰는 백엔드 `parseAuditFilter`(eventType/from/to/q) 서버측 필터, 발급 로그(전체 로드형)는 클라측 기간 필터. 문서 인증 목록에 문서 상세(어테스테이션 이력·해시체인 무결성) 진입 추가.
- **문서 인증 목록**(`/admin/wsign-documents`, 감사·로그 섹션): 외부 문서인증 연동(예: `werb-docauth`)이 `POST /v1/audit-events`로 봉인한 문서 어테스테이션(`targetType=wsign_document`)을 **문서별 스트림에 흩어진 것을 하나의 목록으로 통합** — 제목·문서ID·문서해시·시각·시스템·해시체인 무결성 + 검색·CSV·행 확장. `GET /v1/admin/wsign-documents`(requests:write). 피처플래그 무관.
- **전자결재 통합 인증로그 관리 뷰**(`/admin/approval-audit`, 감사·로그 섹션): 모든 결재의 인증로그를 한곳에서 조회·검색·CSV(건별 상세 탭과 별개). `GET /v1/admin/approval-audit`(approval:act, 페이지·서버필터). 각 행에서 소속 결재 문서로 이동.
- **전자결재 결재자 인증서 자동발급**: 상신(`POST /v1/approvals`) 시 `line[].certSerial` 미지정 결재자는 sign이 STAFF 인증서를 자동발급(사전 발급 불요). 콘솔 상신 폼도 인증서 입력 선택화. 재상신(멱등) 시 중복 발급 방지.
- **전자결재 step-up MFA 재확인**: 고위험/최종 결재 시 콘솔 결재자는 PASS ci 대신 **인증앱 코드(TOTP/복구코드)로 본인확인**(`verifyTotpCode`, 인증로그 assurance=MFA_STEPUP). HIS SSO는 재인증 `acr`, MFA 미등록 계정은 PASS 폴백. 결재 모달이 MFA 등록 여부에 따라 코드/ci 입력 분기.

### 변경 (Changed)
- **전자결재(결재함·전자결재 인증로그) 메뉴 숨김**: 실서비스 결재 워크플로우는 외부 문서인증(weRB `werb-docauth`)이 담당하고 sign은 문서 인증(공증)만 하므로, sign 내부 결재 워크플로우 UI를 사이드바에서 숨김. 라우트·백엔드(`/v1/approvals`)·플래그(`ELECTRONIC_APPROVAL`)·테스트는 **보존**(결재자별 PKI 서명 보관이 필요해지면 메뉴만 복원). 문서 인증 목록은 유지.
- **전자결재 콘솔 수동 상신(새 상신) 제거**: 콘솔의 상신 폼·메뉴·버튼 제거 — 상신은 HIS/외부 시스템(API·기계키) 또는 SSO caller로 일원화, 콘솔은 **결재·조회 전용**. 백엔드 상신 EP(`POST /v1/approvals`)는 유지.

### 수정 (Fixed)
- **사용자 관리 생성 폼 정렬**: 비밀번호 필드의 힌트("8자 이상")로 인해 아이디·비밀번호·역할 입력칸이 세로로 어긋나던 문제(`align-items: flex-end` + 단일 힌트) 수정 — 라벨·입력 상단 정렬, 버튼은 숨김 라벨 스페이서로 입력칸 높이에 맞춤.
- **모달 포커스 버그**: 입력 있는 모달(소비자 등록·결재 승인 등)에서 타이핑마다 포커스가 닫기(✕) 버튼으로 튀던 문제 — 포커스 트랩 이펙트가 인라인 `onClose` 참조 변경에 재실행되던 것을 `[open]` 전환 1회로 분리. 초기 포커스도 ✕ 대신 첫 입력 필드로.
- **접근성 대비**: danger(위험) 색상 `--color-danger`를 `#ef4444`(흰 글씨 대비 3.76)→`#dc2626`(4.81:1, WCAG AA)로 상향 — 반려 버튼·에러/필수 텍스트 대비 개선. 전자결재 결재함·상신 폼·결재 상세를 axe 게이트에 편입(serious/critical 0).

### 문서 (Docs)
- **OpenAPI 명세 갱신**: `docs/openapi.json` 재생성(52→**85 paths**, v1.8.0) — 전자결재·문서 인증·소비자 등록/스코프·통합 인증로그 엔드포인트 포함. README·핸드오프 API 명세 링크·경로 수 갱신.

## [1.7.0] — 2026-07-05 — 전자결재(상신→결재)·통합 인증로그·소비자 등록 UI·포털 문서 미리보기

v1.6.0 이후 **전자결재 워크플로우**(관리자 프리뷰), **콘솔 소비자(기계 연동) 등록/스코프 관리**, **환자 포털 문서(PDF) 미리보기**, 로그/감사 뷰 강화, 자동 로그아웃 사용자 설정을 반영.

### 추가 (Added)
- **전자결재(상신→결재) + 통합 인증로그** — *피처플래그 `ELECTRONIC_APPROVAL` 기본 OFF(관리자 프리뷰, 보안검토 sign-off 후 활성)*. 기존 다자 순차서명 엔진 재사용(결재 = 실제 STAFF 전자서명, EMR F010). 결재 인증로그는 서명 체인과 분리된 전용 스트림 `approval:<id>`에 **본인확인 사실 + F008 접속기록**을 통합 봉인(해시체인+TSA 앵커, fail-closed). 지정 결재자 바인딩(타인 대리 결재 차단)·순차 게이팅·반려. **step-up**(고위험 문서 `SURGERY/ANESTHESIA/DNR/NARCOTIC/TRANSFUSION` 또는 최종 결재 단계 → 본인확인 재강제). 엔드포인트 `POST /v1/approvals`(상신)·`:id/act`(결재/반려)·`:id/act-staff`(HIS SSO Bearer 결재, acr step-up)·`:id/authlog`(+CSV·verify). 상신은 콘솔 세션 또는 기계키(`approval:write`), 결재는 콘솔 세션 또는 SSO. 콘솔 UI: 결재함(상신/진행중/완료)·상신 폼(문서 SHA-256 클라 계산, 원본 미전송)·결재선 뷰·결재/반려·통합 인증로그 뷰어. 스코프 `approval:write`/`approval:act`.
- **콘솔 소비자(기계 연동) 등록·스코프 관리 UI** (`/admin/consumers`, ca:admin) — env/코드 수정 없이 신규 consumer(API 키) 발급. 이름+스코프 지정 → **키 1회 반환**·**재기동 영속**(`consumer:dynamic` meta). 동적 소비자 스코프 편집·일시중지/재개, 시스템(env)/등록 구분 배지. **보안**: 부여 가능 스코프를 기계 권한(`requests:write`·`certificates:write`·`settings:write`·`approval:write`·`documents:read`)으로 제한 — 민감 스코프(`ca:admin`·`users:admin`) 부여 차단(권한상승 방지)·예약 이름·중복·시스템 소비자 편집 차단. `POST/PATCH /v1/admin/consumers`·`GET .../assignable-scopes`.
- **환자 포털 문서(PDF) 미리보기** — *피처플래그 `PORTAL_DOC_PREVIEW` 기본 OFF*. 서명창 한정 암호화 임시보관(Option A): 업로드 시 `SHA-256 == documentHash` 검증 후 AES-256-GCM 봉인(meta KV), 포털 네이티브 iframe 뷰어·해시 일치 배지·**동의 게이트**(문서 확인 전 서명 진행 비활성)·완료 후 sweep 파기. 업로드 `PUT /v1/requests/:id/document`·열람 `GET /v1/portal/:token/document`(inline·no-store)·관리자 `GET /v1/requests/:id/document`(RBAC documents:read). 크로스오리진 뷰어 프레이밍(XFO 해제+CSP frame-ancestors).
- **로그/감사 뷰 강화**: 행 확장 상세(`LogDetail` — 전체 `data`·`entryHash`/`prevHash`)·무결성 배지(체인+TSA 앵커 상시 표시)·**관리자 감사 스트림**(`admin:auth`·`admin:users` via `GET /v1/admin/audit`, users:admin 한정)·**서버측 검색**(`?q=`)·**전체 CSV**(서버 필터 일치분, UTF-8 BOM).
- **자동 로그아웃 사용자 설정**: *내 계정*에서 개인 비활동 로그아웃 시간 설정(세션별 `idleMs`, 정책 상한 클램프, 개발모드 최대 2h·실모드 비표시). `GET/POST /v1/auth/idle-timeout`.

### 변경 (Changed)
- **다크모드 토글** 상단바 우상단 이동, **사이드바 "전자결재"·"감사·로그" 섹션** 추가/분리.
- 기존 소비자(hospitalrun·pacs·erp·console)에 `approval:write` 스코프 부여(전자결재 상신 caller).

### 보안 (Security)
- 전자결재 자체 보안검토(STRIDE) → 하드닝: 결재 상태·인증로그 GET을 `approval:act` 한정(기계키·viewer의 actor·IP·의견 열람 차단), 결재자 바인딩 심층방어(무바인딩 단계 결재 차단), `documentHash` hex 형식 검증. sign-off 준비 문서 `docs/06-ops/electronic-approval-security-review.md`.

### 정리 (Maintenance)
- `signature_requests.documentUri` 죽은 슬롯 제거(migration `0005_drop_document_uri`).
- 회귀 게이트에 전자결재·P3.1 연동·소비자 등록·포털 문서 e2e 편입. 백엔드 e2e 0실패 · UI E2E 32/32 + axe 접근성 그린.

## [1.6.0] — 2026-06-30 — 테스트 자동화·CI 게이트·2차 인증·접근성·UI 개선

### 추가 (Added)
- **관리자 콘솔 2차 인증(2FA/TOTP)**: 인증앱(Google/Naver Authenticator 등) 기반 로그인 2단계 인증. 의존성 0(RFC6238 자체 구현), 시크릿은 **AES-256-GCM 봉인** 저장, **복구코드 8개**(1회용·sha256 해시). 로그인 흐름: 1차(ID/PW) 통과 시 2FA 활성 계정은 **단기 챌린지 토큰**(5분) 반환→세션 미발급, `POST /v1/auth/2fa/verify`(TOTP 또는 복구코드)로 세션 발급. 등록/해제는 *내 계정* 화면(QR + 수동키, 코드 확인 후 활성화·복구코드 표시). 엔드포인트 `2fa/{status,setup,enable,disable,verify}`. 감사(`MFA_ENABLED/VERIFIED/FAILED/DISABLED`). 기계 키(HIS/PACS/ERP) 경로 무관.
- **UI E2E 자동화(Playwright)**: 콘솔·포털 브라우저 E2E **24테스트** — 로그인·로그아웃·보호라우트·대시보드(검색·상태필터·CSV·일괄철회·실시간 SSE)·검증탭·2FA 등록/재로그인·포털 서명·비활동 자동로그아웃·RBAC 사용자관리·연동설정/인증서목록/감사로그. 백엔드(인메모리)+웹 두 서버 자동 기동(`npm run e2e:ui`).
- **접근성 자동검사(axe)**: WCAG 2.1 A/AA 5화면 스캔(로그인·대시보드·내계정·다크모드·환자포털), serious/critical 0 게이트.
- **3자 합동 mock 하니스**: HIS·PACS·ERP 동시 연동 종단 검증(독립 봉투·출처 귀속·webhook 교차 없음·시크릿 격리) `test/joint-3party.e2e.mjs`.
- **라이브 스모크**: 배포 후 읽기전용 검증 `scripts/smoke.mjs`(`npm run smoke:live [URL]`).
- **보안 헤더·재기동·마이그레이션 e2e**: `headers`(helmet·HSTS 게이트)·`restart`(파일저장소+proxy 재기동 영속)·`migrate`(실 PostgreSQL 인덱스 컬럼 푸시다운).
- **CI(GitHub Actions)**: PR·main push마다 `e2e:all`(백엔드 e2e + contract:prisma + UI/a11y) + PostgreSQL 잡(prisma-live·migrate) 자동 실행. 단일 게이트 `npm run e2e:all`.

### 변경 (Changed)
- **다크모드 토글**: 사이드바 푸터 → **상단바 우상단** 아이콘 버튼으로 이동.
- **사이드바 메뉴**: 과밀한 "시스템" 섹션에서 로그·감사 4종(문서·발급 로그·인증 행위 로그·발송 이력·감사·로그)을 별도 **"감사·로그"** 섹션으로 분리.

### 수정 (Fixed)
- **접근성 대비 위반**: axe가 발견한 실제 WCAG 대비/속성 위반 수정 — 다크모드 사용자명(대비 1.12), 사이드바 로고·브랜드 블루 소형 텍스트, 환자 포털 서명자 텍스트, Toast 컨테이너 `aria-label` role 등(라이트·다크·포털 전반 4.5:1 확보).
- **빌드**: 프로덕션 web 이미지 빌드 시 E2E devDep(Playwright)의 브라우저 다운로드 차단(`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`).

## [1.5.2] — 2026-06-29 — 서명 검증 탭 표시 수정

### 수정 (Fixed)
- **서명 검증 탭 — 미서명 요청 오표시**: 아직 서명이 0건인 요청(CREATED, 0/N)에서 백엔드 `overall=false`(서명 1건 이상 조건)를 UI가 "검증 실패 — 일부 서명에 문제"로 오표시하던 문제. 서명 0건이면 중립 안내("아직 서명된 항목이 없습니다 — 서명 대기 중")로 분기, 1건 이상일 때만 성공/실패 판정.

## [1.5.1] — 2026-06-29 — 실시간 SSE·대시보드 필터 확장·idle 백그라운드 수정

v1.5.0 이후 **실시간 콘솔 갱신(SSE)**·**대시보드 필터 조건 확장**(출처·서명모드·미완료·커스텀 기간)·**비활동 자동 로그아웃 백그라운드 탭 수정**을 반영.

### 추가 (Added)
- **실시간 콘솔 갱신(SSE)**: `GET /v1/events/stream`(SSE) — 서명요청 상태 변경(생성·서명·완료·철회·만료·개정)을 서버가 push. **대시보드·요청 상세가 수동 새로고침 없이 자동 갱신**. 인프로세스 이벤트 버스(`SignEventsService`), 헤더 인증(fetch 기반·자동 재연결·15초 heartbeat), `X-Accel-Buffering: no`로 nginx 버퍼링 무력화(설정 변경 불요). 미연결(프록시 버퍼링 등) 시 기존 수동 새로고침으로 무해 폴백. 대시보드는 선택(일괄작업) 중엔 자동 갱신 보류.

### 수정 (Fixed)
- **비활동 자동 로그아웃(F004) — 백그라운드 탭 미동작 수정**: 탭을 백그라운드로 두면 브라우저가 `setInterval`을 늦추거나 정지시키고, 복귀 시 `mousemove`가 먼저 발생해 idle 판정이 사라져 로그아웃이 동작하지 않던 문제. `visibilitychange`/`focus`로 **탭 복귀 즉시 idle 재검사**(mousemove 리셋 전)하도록 보정. 서버측 세션 레지스트리가 다음 요청 시 idle을 강제(401)하는 백스톱은 종전대로 유지.

### 추가 (Added)
- **서명요청 대시보드 필터 조건 확장**: 기존 검색·기간(프리셋)·상태에 더해 ① **출처**(createdBy: HIS/PACS/ERP/콘솔) ② **서명모드**(APP/PORTAL/MULTI) ③ **미완료(서명 대기)**(CREATED·IN_PROGRESS 다중상태) ④ **커스텀 기간**(시작~종료일 직접 지정, 프리셋 대체) 추가. 출처·서명모드는 `StoreRecord` 인덱스 컬럼(`createdBy`·`signMode`, migration `0004`·백필)로 **DB 푸시다운**, 미완료는 `status IN (CREATED,IN_PROGRESS)`. `GET /v1/requests`·`/export.csv`에 `?createdBy=&signMode=&incomplete=&from=&to=` 반영(CSV 내보내기도 동일 필터). `RequestDto.createdBy` 노출.

## [1.5.0] — 2026-06-29 — 인증서 목록 확장성·CSV 내보내기·UI/UX 확장(차트·일괄·접근성·다크모드)

v1.4.0 이후 **인증서 목록 DB 푸시다운**(확장성)·**목록 CSV 내보내기**(EMR/ISMS-P 심사)·**UI/UX 확장**(운영 추세 차트·일괄 작업·웹 접근성·다크모드·전역 에러 바운더리)을 반영. UI/UX 확장 계획서(`docs/02-design/ui-ux-extension-plan.md`)의 즉시 착수 가능 항목 일괄 소화.

### 추가 (Added)
- **UI/UX 확장(즉시 착수 가능 항목 일괄)** — 계획서 `docs/02-design/ui-ux-extension-plan.md` 기반:
  - **운영 추세 차트(P1-3)**: `GET /v1/admin/metrics` + 시스템 상태 "운영 추세" 카드(상태 분포·일자별 요청·Webhook 성공률, 의존성 없는 경량 SVG/CSS).
  - **일괄 작업(P1-2)**: 대시보드 다건 철회 + **인증서 목록 다건 폐기**(체크박스 선택·확인 모달·`Promise.allSettled` 병렬·부분 실패 리포트, viewer 제외, 각 건 감사 actor 귀속). 발송은 요청별 연락처 입력이 필요해 일괄 제외.
  - **접근성 강화(P1-1)**: Modal 포커스 트랩·본문 바로가기 스킵 링크·환자 포털 글씨 크기/고대비(고령자, KWCAG/WCAG).
  - **다크모드(P2-1)**: `[data-theme=dark]` 토큰 오버라이드 + 콘솔 토글(환자 포털은 Light 유지).
  - **전역 에러 바운더리(P2-7)**: `app/error.tsx` 친절한 폴백(흰화면 방지).
- **목록 CSV 내보내기(심사·보존)**: 대시보드(`GET /v1/requests/export.csv`, 검색·상태·기간 필터 반영)·인증서 목록(`/v1/certificates/export.csv`)·발송 이력(`/v1/admin/notifications/export.csv`)에 **내보내기** 버튼. UTF-8 BOM(한글 Excel)·`Content-Disposition: attachment`·배치 페이징 스트리밍(전체 메모리 비적재). 연락처는 마스킹값만·CI 미포함, `requests:write` 스코프(viewer 제외). EMR(F008 접속기록)·ISMS-P(2.9 로그) 심사 증빙·보존 대응.
- **인증서 목록 확장성**: 서명요청 대시보드와 동일 패턴으로 인증서 목록도 **DB 푸시다운** — `StoreRecord`에 인덱스 컬럼(`ownerType`·`notBefore`, `searchText` 재사용) 추가(migration `0003`, 기존 행 백필) + `SignStore.queryCerts()`(InMemory/File/Prisma) 신설. `GET /v1/certificates`가 검색(`?q=` 시리얼·주체·유형·면허)·CA 제외·정렬(notBefore 최신순)·페이지·카운트를 DB 레벨로 처리(종전 `allCerts` 전체 로드 제거). 인증서 상태(EXPIRED)는 만료 계산 표시값이라 페이지 항목에서 산출(서버 필터 아님), 유형 탭·초성은 콘솔 클라이언트 정제(기존 UX 유지).

## [1.4.0] — 2026-06-29 — 콘솔 세션 보안(F004·ISMS-P 2.6.3)·대시보드 확장성·ERP 다자 회신

v1.3.0 이후 **콘솔 세션 보안 강화**(비활동 자동 로그아웃·서버측 세션 레지스트리·동시세션 제한·세션 종료 일관 전환)와 **서명요청 대시보드 확장성**(DB 푸시다운·기간 필터), ERP e-sign #6 다자 봉투 회신을 반영. 보안 규정(EMR F004·ISMS-P 2.6.3·개인정보 안전성 확보조치) 대응. OpenAPI 영향 없음(목록 파라미터·세션 EP 추가).

### 추가 (Added)
- **서명요청 대시보드 확장성(데이터 누적 대비)**: 목록 검색·상태·기간·정렬(최신순)·페이지·카운트를 **DB 레벨로 푸시다운** — `StoreRecord`에 인덱스 컬럼(`status`·`reqCreatedAt`·`searchText`) 추가(migration `0002`, 기존 행 백필) + `SignStore.queryRequests()`(InMemory/File/Prisma) 신설. 종전 전체 메모리 로드→메모리 필터/정렬 제거. **기간 필터**: `GET /v1/requests?days=N` 또는 `?from=&to=`(ISO, `createdAt` 기준), 대시보드 기본 **최근 90일**로 working set 한정 + 콘솔 기간 선택·생성일 컬럼. `StoredRequest.createdAt` 추가. ops-status `status()` 5초 단기 캐싱(통계 전체로드 부하 완화).
- **콘솔 비활동 자동 로그아웃(EMR 보안성 F004 — 미사용 접속차단)**: 관리자 콘솔에서 일정 시간 입력(마우스·키보드·스크롤·터치)이 없으면 세션 종료. `SESSION_IDLE_TIMEOUT_MIN`(기본 30분, `0`=비활성, 절대 만료 `SESSION_TTL_MIN` 초과 시 TTL로 캡). 만료 1분 전 경고 모달(카운트다운)에서 ‘계속 사용’으로 연장, 자동 로그아웃 시 로그인 화면에 사유 안내. 로그인 응답에 `idleTimeoutMin`.
- **서버측 세션 레지스트리(보안 규정 보강)**: 무상태 토큰을 상태형으로 보강해 ① **idle 차단을 서버가 강제**(세션 레지스트리가 매 요청 `lastSeen` 점검 — 클라이언트 JS 의존 제거, 토큰 보관·복제해도 차단) ② **동일 사용자 동시 세션 수 제한**(`SESSION_MAX_CONCURRENT` 기본 3, `0`=무제한 — 초과 시 가장 오래된 세션 축출, ISMS-P 2.6.3) ③ **즉시 폐기**(로그아웃·비밀번호 변경 시 서버 세션 무효화). `/v1/admin/ops-status` `config.session`(ttl·idle·maxConcurrent·activeSessions·`enforcement=server`)·콘솔 *시스템 상태*에 노출. 세션 토큰에 `jti` 추가(레지스트리 매칭) — 배포 시 기존 세션 1회 재로그인.

- **ERP e-sign #6 다자 봉투 클로즈아웃 회신**(문서): `docs/05-handoff/sign-to-erp-esign6-answers.md` — signers[] 8개 질의 코드 확정 답변 + 잔여 4건. **PORTAL+STAFF 혼합 봉투 종단 e2e**(`test/erp-multisig-mixed.e2e.mjs`) 추가(순차 409·단일 completed·양채널 signatures[] echo·STAFF certSerial 바인딩·overall=true).

### 변경 (Changed)
- **세션 종료 시 로그인 화면 일관 전환**: 콘솔 API 호출이 세션 무효/만료/idle/축출/폐기로 401을 받으면(세션 모드 한정) 인증 정보를 비우고 로그인 화면(`?reason=expired`)으로 전환하는 전역 처리 추가. 비활동 idle뿐 아니라 **다른 기기 로그인에 의한 동시세션 축출·비밀번호 변경 폐기**도 즉시 로그인 화면으로 전환. 기계 api-key(break-glass)·공개 포털·로그인 요청 자체는 제외.
- **세션 정책 강화(보안 검토 권고 반영)**: 비활동 자동 로그아웃 기본값 30→**15분**(민감정보 위험도), 절대 세션 만료 기본값 720→**480분(8h)**. **운영 모드(하드닝/production)에서는 `SESSION_IDLE_TIMEOUT_MIN=0`(비활성)을 금지하고 15분 하한 강제**(F004 보장, 비운영에서만 비활성 가능). TTL·idle·동시세션 해석을 단일 정책(`session-policy.ts`)으로 통합(서비스 간 값 불일치 방지).

## [1.3.0] — 2026-06-28 — 다중관리자 RBAC·문서개정·서버검색·ERP 연동·보안 거버넌스 문서

v1.2.0 이후 enterprise enhancement(RBAC·검색·개정)·ERP 외부 거래처 계약 연동·보안 거버넌스 문서를 대거 반영. OpenAPI 52 paths. 코드측 완결·Critical 0.

### 추가 (Added)
- **C-4 다중관리자 RBAC**: 콘솔 로컬 관리자 계정(ID/PW scrypt) + 세션 토큰(HMAC·만료), 역할 admin/operator/viewer. `POST /v1/auth/login`·`/me`·`/password`, `/v1/admin/users`(users:admin) CRUD, last-admin 보호. 콘솔 `/admin/users`·`/admin/account`. 기계 키 경로 불변, `CONSOLE_API_KEY` break-glass.
- **C-2 문서 개정 재동의(supersede)**: `POST /v1/requests/:id/supersede`(+facade `supersedesRequestId`) — 원본 `SUPERSEDED`·새 버전(version/supersedes/supersededBy), 참가자 재사용, `request.superseded` webhook. 원본 서명·LTV·감사 보존.
- **서버측 검색**: `GET /v1/requests`·`/certificates` `?q=`(부분일치)·`?status=` — 전체 집합 검색 후 페이지 슬라이스. 콘솔 대시보드·인증서목록 서버 검색(디바운스).
- **ERP 외부 거래처 계약 연동(트랙 A)**: `erp` 소비자 + **소비자별 webhook 시크릿 격리**(`ERP_WEBHOOK_SECRET`). 단독 VENDOR(WITNESS·PORTAL·NONE) 라이브 + **다중봉투 순차 서명**(facade `signers[]`, 신규입사 의료진 자동 임시 인증서). sign-core `docker_default` 망 합류(inbound).
- **운영 문서**: `docs/06-ops/go-live-runbook.md`(실서비스 전환 단일 체크리스트)·`docs/02-design/signing-flows.md`(서명·연동 흐름 통합). 운영 매뉴얼 **§0 실서비스 개시(go-live)** + **§6 보안 종합**(인증·암호화·키수탁·하드닝·감사·위변조·시크릿·검토이력·ISMS-P/ISO27001·개인정보27701·클라우드27017/18·CSAP·**사고대응 절차서**).

### 변경 (Changed)
- **새 서명요청 UX**: 서명모드(병렬/순차)가 실제 게이팅(signOrder)을 결정하도록 정합 + 인증서 인라인 선택기.
- **포털 본인인증**: 실서비스 전(idv=mock) `identityDemo`로 PASS 생략 가능(실 사업자 설정 시 자동 차단).
- 인증 가드: `x-session-token`(세션) 우선 + Bearer는 검증 시 세션·아니면 `x-api-key` 폴백(기계 연동 무중단).

### 수정 (Fixed)
- 포털 web SPA가 레벨 NONE/APP_STEPUP을 `identity.method`로 잘못 전송하던 검증 오류(거래처 서명 실패) 수정.
- 운영 매뉴얼 srcDoc iframe 앵커 스크롤(scrollIntoView 보정)·목차↔섹션 정합(§7.5 누락 등).
- M1 SSRF: 동일서버 내부 수신부 예외(`WEBHOOK_INTERNAL_HOSTS`). DB 호스트 `sign-postgres` 고정(docker_default `postgres` 별칭 충돌 방지).

## [1.2.0] — 2026-06-16 — 연동 설정 콘솔·운영 매뉴얼·운영 자동화·보안 보완

v1.1.0 이후 운영자 콘솔·연동 설정·운영 자동화·보안 보완을 대거 반영. OpenAPI 44 paths.

### 추가 (Added)
- **런타임 연동 설정 스토어**: `GET/PUT /v1/admin/settings[/:type][/audit]`(`settings:write`) — 본인인증(PASS/명의)·발송(알림톡/SMS)·키수탁(KMS/HSM) provider·자격증명을 콘솔에서 입력. 시크릿은 **AES-256-GCM 봉인**(평문 미반환). 콘솔 `연동 설정`(스키마 동적 렌더). 어댑터가 런타임 해석(설정>env>mock), 벤더 REST는 계약 후 드롭인.
- **발송 이력**: `GET /v1/requests/:id/notifications`·`/v1/admin/notifications` — 연락처 마스킹(끝4자리·평문 미저장). 콘솔 `발송 이력` + 요청상세 탭.
- **운영 매뉴얼**: 콘솔 `운영 매뉴얼`(인증 게이트, `/admin/manual`) — 개요·화면별 안내(와이어프레임)·인증서/서명/연동/운영/EMR/트러블슈팅·API 레퍼런스 + 부록(등록 샘플 JSON·운영 절차 런북 5건·용어집 16항·FAQ). 편집 소스 `web/manual.source.html`→`npm run manual:build`.
- **인앱 스케줄러**: Webhook 재시도·만료 배치 **주기 자동 실행**(`SCHEDULER_ENABLED`·`*_MIN`, 기동 catch-up). 단독 배포 시 외부 크론 불요. ops-status `scheduler`.
- **API 키 회전 콘솔 UI**: `GET /v1/admin/consumers`(ca:admin 목록) + 콘솔 `API 키 회전`(rotate→grace→commit 무중단).
- **환자 포털 본인인증 단계 UX**: `requiredIdentityLevel`별(PASS/명의/대면) 단계 분기.
- **버전·제작사 표기**: 콘솔 사이드바·로그인·매뉴얼·ops-status에 `v1.2.0 · 제작 (주)위루비`.
- **EMR 인증 보안성 대응**: 12항목 대조표·증빙 가이드·라이브 시연 스크립트(`npm run emr:demo`)·HIS 분담 체크리스트(docs).

### 변경 (Changed)
- **go-live 보안 하드닝 라이브 활성화**: `SECURITY_HARDENING` ON(H3 PII 인증·H4 rate-limit·M1 SSRF·M2 헤더). rate-limit IP 트래커 정합(`trust proxy` + 서버↔서버 면제).
- **목록 서버 페이지네이션**: requests·certificates·notifications·audit-events `?limit=&offset=` + `page` 메타(data 배열 하위호환·max 200). 콘솔 페이지네이션 UI.
- 운영 매뉴얼을 공개 정적 파일에서 **인증 게이트**로 이전(공개 `/manual.html` 제거).

### 보안 (Security)
- **HIGH**: SecretBox(연동 시크릿 봉인)가 하드닝/운영에서 CRYPTO_MASTER_KEY 미설정 시 부팅 거부(proxy 모드 사각 제거).
- **MEDIUM**: 연동 endpoint 필드 SSRF 차단(https·사설망/메타데이터).
- **LOW**: 공개 매뉴얼 내부 토폴로지 노출 → 인증 게이트.
- 정상 확인: 시크릿 평문 미노출·`settings:write` 스코프 격리·감사 시크릿 미기록·연락처 마스킹·trust proxy 위조 방지.

## [1.1.0] — 2026-06-16 — 인증서 관리·인증 행위 로그·전체 보안 검토

v1.0.0(EXTERNAL 라이브) 이후 관리 기능·블록체인 인증 로그·콘솔 확장 + 전체 코드 보안 검토 반영. OpenAPI 38 paths.

### 추가 (Added)
- **인증서 라이프사이클 관리**: `GET /v1/certificates`(목록)·`POST /:serial/{suspend,resume}`(중단/재개·가역). 콘솔 `인증서 목록·관리`(의료진/환자/대리·증인 탭 + ㄱㄴㄷ 초성 인덱스), 발급 페이지 유형별 탭.
- **의료진 행위 블록체인 인증 로그**: `POST /v1/audit-events`(처방·판독승인·동의취득 등 → 해시체인+TSA 봉인, 인증 영수증). **SSO 본인인증 봉인**(staff-token aud=sign → 검증 신원 sub·면허 봉인, actor↔sub 바인딩). `GET /streams`·`?stream=`·`/verify`.
- **의료기록 별도 스트림**: `events:medical-records` 격리 봉인 + 콘솔 `인증 행위 로그`(스트림 탭·무결성 검증). 콘솔 `문서·발급 로그`(서명 활동+발급 이력).
- **API 키 무중단 회전**: `POST /v1/admin/consumers/:name/{rotate,commit}`(ca:admin) + **SignStore 영속화**(재기동 후 폐기키 부활 차단).
- **CA 운영 조회**: `GET /v1/ca/{history,audit}` + 콘솔 `감사·로그`.
- **운영 도구**: STAFF 일괄발급(`seed:staff`)·테스트 staff-token 민팅(`token:test`)·전면교체 런북·시드.
- **문서**: 위변조 방지 설계(인증서×블록체인 4중 방어)·HIS/PACS 통합 가이드·발급 일원화·발급 주체 정리.

### 변경 (Changed)
- facade(`/v1/sign-requests`)에 `callbackUrl` + 전역 `HIS_WEBHOOK_URL`(facade도 webhook 발화).
- webhook/verify에 `externalSignerRef`(직원/환자 미러 매핑)·`assuranceLevel`·`caKeyCustody` 추가.
- enroll 일원화: HIS/PACS 자체 발급 폐지, sign 단독(관리 UI도 sign 콘솔). 환자 자동발급 + standalone 지원.

### 수정 (Fixed)
- enroll `identity` 누락 시 500 → STAFF/WITNESS 기본값·PATIENT 명확한 400. WITNESS X.509 유효기간 1일.
- 콘솔 메뉴 동시활성 버그(대시보드·인증서 접두사 충돌). audit-log `ca:admin` 403(조회는 유효키).
- facade webhook 미발화(callbackUrl 부재) 갭.

### 보안 (Security) — 전체 코드 검토(code-analyzer) 반영
- **C1** 행위 로그 actor 위조 차단(SSO 시 actor↔검증 sub 바인딩).
- **H4** SSRF 강화(숫자IP·IPv4-mapped IPv6·대괄호·후행점). **M5** 하드닝 시 dev-secret webhook 금지.
- **H2** 키 회전 영속화(폐기키 부활 방지). **H3** 이중서명 가드+서명 count 재계산. **M3** audit-events 테넌트 격리.
- **L3** suspend/resume 409. 접근로그 actor·관리 행위자 감사·suspend OCSP 반영.

### 검증 (Verified)
- e2e increment3~22 + EXTERNAL 계약 + PKCS#11(SoftHSM2) + HIS + Prisma-live. 보안 보완 전건 라이브 검증.

---

## [1.0.0] — 2026-06-15 — EXTERNAL 라이브 릴리즈

의료 전자서명 트러스트 서비스 첫 정식 릴리즈. HIS/PACS와 EXTERNAL 양방향 연동 실가동, 단일 트러스트 루트(sign HSM-앵커 CA) 재기준 완료.

### 추가 (Added)
- **HSM 키 수탁 어댑터**: `AwsKmsKeySigner`(AWS KMS) + `Pkcs11KeySigner`(온프레 PKCS#11 — SoftHSM2 e2e 검증). 비추출, 최소화(CA 앵커 2키만, 말단·TSA는 SOFT → 서명 건당 HSM 비용 0).
- **attestation 필드**: enroll·webhook·verify 응답에 `keyCustody`·`caKeyCustody`·`caKeyCustodyProvider`·`assuranceLevel`(SOFTWARE↔HSM_ANCHORED). HIS/PACS "HSM 보호 트러스트" 봉인.
- **EXTERNAL 발급 일원화**: HIS/PACS 자체 발급 폐지 → sign 단독 발급. facade(`/v1/sign-requests`)에 `callbackUrl` + 전역 `HIS_WEBHOOK_URL`(facade도 webhook 발화).
- **webhook 직원/환자 식별자**: `signatures[].externalSignerRef`·`signerRole` — HIS `user.signCertSerial` 미러 매핑.
- **보안 하드닝(§6.1, prod-gated)**: PII GET 인증(H3)·rate-limit(H4)·webhook SSRF 방어(M1)·보안헤더(M2). `SECURITY_HARDENING` 게이트.
- **접근 로그 + 관리 행위자 감사**: HTTP 접근 로그 인터셉터(reqId·actor·구조적 JSON)·revoke/CA회전/키회전 행위자 봉인.
- **관리 기능**: CA 회전 이력(`/ca/history`)·CA 감사(`/ca/audit`)·**API 키 무중단 회전**(`/admin/consumers/:name/{rotate,commit}`).
- **관리자 콘솔**: 시스템 상태(키커스터디·HSM·하드닝)·감사·로그 페이지·PROXY 서명·Webhook 탭.
- **운영 도구**: 개발 시드(`seed:dev`, 운영 차단 가드)·테스트 staff-token 민팅(`token:test`)·전면교체 런북+스크립트(`clean-reset.sh`).

### 변경 (Changed)
- 버전 0.1.0 → **1.0.0**. OpenAPI 명세 32 paths(`docs/openapi.json`).
- 발급 모델: HIS 블록체인 인증서 = sign 발급분의 하위 미러(독립 발급자 아님).

### 보안 (Security)
- C1(무인증 서명 위조 차단)·M3(운영 시크릿 부팅 가드) 적용. JSONB 무결성(canonical-json).
- HSM은 sign 단독 연동, 내부 서비스 키 미보유. go-live 전 P8 시크릿 회전(무중단 EP 지원).

### 검증 (Verified)
- EXTERNAL 라운드트립 라이브: sign-requests → 서명 → webhook(HTTP 201, HMAC) → verify(overall·chainValid·auditChainValid·assuranceLevel).
- 전면교체(clean reset) 3팀: sign 신규 CA → HIS/PACS 재프로비저닝 → 라운드트립 PASS.
- e2e: increment3~22 + EXTERNAL 계약 + PKCS#11(SoftHSM2) + HIS 연동 + Prisma-live.

### 잔여 운영 (Pending — 빌드 외)
- KMS 조달 → cutover(→`HSM_ANCHORED`) · PASS/명의·알림톡 실 자격증명 · go-live P8 회전 · 하드닝 활성(`SECURITY_HARDENING`).

---

## [0.1.0] — 2026-06 — 초기 구현
- 2단 CA·실 X.509·CMS·PAdES-LTA·RFC3161 TSA·감사 해시체인·CRL/OCSP.
- HIS/PACS facade·Webhook·SSO·관리자 콘솔·환자 포털 SPA. Docker 배포·Prisma 영속.
