# 일반 전자계약(행정·일반 계약) 트랙 설계

- 상태: **v1.2 (as-built — v1.9.0~v1.22.0 구현 완료분 반영, §10·§11 참조)**
- 작성: 2026-07-06 · 최종 갱신: 2026-07-28
- 배경: 모두싸인(https://modusign.co.kr/features) 기능 분석 결과, 원내에서 필요한 전자계약 기본 기능(준비→체결→관리)을 sign에 온프레미스로 구현하기로 결정(사용자 확정).

## 0. 결론

- sign에 **행정·일반 계약 전용 트랙**(`signMode=CONTRACT`) 신설: **준비**(PDF 업로드·서명자 구성) → **체결**(내부 콘솔/SSO 서명 + 외부 이메일 링크·접근암호 포털 서명) → **관리**(계약함·리마인더·완료문서 자동 교부·검증).
- **환자 동의서 경로는 무변경** — HIS 연동·해시-only 원칙 유지. 계약 트랙은 별도 signMode로 공존.
- 기존 자산 최대 재사용: SignatureRequest 다자순차서명·PKI/TSA·감사체인·포털 토큰·SecretBox 문서보관·expire 스케줄러·Notifier 추상화·감사추적인증서. **신규 핵심은 계약 메타·SMTP 발송·접근암호·계약함 UI·리마인더·완료 교부**.
- 피처플래그 `GENERAL_CONTRACTS` 기본 OFF.

## 1. 선행 결정 (사용자 확정 2026-07-06)

| # | 결정 | 내용 |
|---|---|---|
| D1 | 사용 범위 | **행정·일반 계약 전용**(근로·용역·협력업체 등). 환자 동의서는 기존 HIS 경로 유지 — 두 트랙 공존 |
| D2 | 파일 포맷 | **PDF 우선**(기존 해시·뷰어 인프라 재사용, 변환 의존성 0). DOCX(LibreOffice 변환)·HWP는 후속 |
| D3 | 외부 본인확인 | **이메일 소유 확인 + 접근암호**(모두싸인 기본 수준, 벤더 불요). 고중요 계약 PASS step-up은 후속(위험도 매트릭스 자리 확보) |
| D4 | 원본 보관 | 계약 트랙 한정 **영구 암호화 보관**(AES-256-GCM SecretBox). 원내 구축형이라 외부반출 아님 — 포털 미리보기 Option A 논거의 확장. 동의서 트랙은 해시-only 유지 |
| D5 | 발송 채널 | **원내 SMTP**(이메일). 알림톡·SMS는 벤더계약 후 Notifier 드라이버 추가 |

## 2. 모두싸인 기능 ↔ 구현 매핑

| 모두싸인 기능 | 채택 | 구현 방식 |
|---|---|---|
| 다자간 계약·서명 순서 | P1 | 기존 SignatureRequest+signOrder 그대로 |
| 이메일 발송 | P1 | Notifier SMTP 드라이버 신설 |
| 접근암호 인증 | P1 | 포털 unlock 게이트(scrypt 해시·rate-limit) |
| 서명 유효기간 | P1 | 기존 expire 재사용 |
| 문서 위변조 확인·감사추적인증서 | P1 | 기존 verify·감사체인·PDF (재사용, 무작업) |
| 계약함(검색·상태·대시보드) | P2 | 기존 대시보드·서버검색·CSV 패턴 복제 |
| 계약 리마인더 | P3 | 스케줄러 잡 + 수동 재발송 |
| 문서 자동 교부 | P3 | 완료 시 만료형 다운로드 링크 이메일 |
| 라벨 설정 | P3 | contract-meta 라벨 배열 |
| 작성란(사인·텍스트·체크박스·날짜) | P4 | pdf.js 오버레이 에디터 + pdf-lib 최종본 렌더 → 최종본 해시 서명 |
| 사인·도장 이미지(드로잉) | P4 | 서명 UI 확장 |
| 템플릿(요청 프리셋) | P4 | 계약 구성 저장·복제(문서 서식 아님) |
| 참조자(CC)·메모·첨부 | P4 | contract-meta 확장 |
| 내부결재(발송 전 승인) | P5 | **기존 전자결재(/v1/approvals) 부활 연동** — 숨겨둔 구현의 실사용처 |
| DOCX 변환·예약/대량 전송·주소록·브랜딩·다국어 | P5 | 후속(수요 확인 후) |
| 링크서명(불특정 다수)·법률 서식·문서 편집 | 제외 | 본인확인 원칙 충돌 / 문서 조립은 업무시스템 몫 |

## 3. 아키텍처

### 3.1 도메인·저장

- 봉투 = 기존 `StoredRequest` 재사용, `signMode: 'CONTRACT'`.
- 계약 메타 = `saveMeta('contract-meta:<id>')` KV(결재선 메타 `approval-meta:<id>` 동형): 제목·라벨[]·상대방[{name,email,role}]·유효기간·`accessCodeHash`(scrypt)·문서 blob 참조·retention 정책.
- 문서 원본 = 기존 `docblob:<id>`(SecretBox AES-256-GCM) 재사용 + **`persistent` 표시로 sweep 제외**(완료 후 보존은 §9 정책 확정 시 별도 잡).
- 외부 서명자 = `signerType: 'EXTERNAL_PARTY'`(신규) — 임시 인증서(ownerType EXTERNAL, 설계 H-3 외부입회인 패턴 재사용), `requiredIdentityLevel: 'EMAIL_CODE'`(신규). 내부 서명자 = 기존 STAFF(콘솔 세션 또는 SSO staff-sign).

### 3.2 신규 엔드포인트 (파사드 — 내부는 기존 서비스 재사용)

| EP | 역할 | 스코프 |
|---|---|---|
| `POST /v1/contracts` | 생성(메타+서명자 구성, 멱등) | contracts:write |
| `PUT /v1/contracts/:id/document` | PDF 업로드(SHA-256==documentHash 검증, 기존 패턴) | contracts:write |
| `POST /v1/contracts/:id/send` | 발송 = 포털 토큰 발급 + SMTP 이메일 | contracts:write |
| `GET /v1/contracts` (+`export.csv`) | 계약함 목록·검색·상태·라벨·기간 필터 | contracts:read |
| `GET /v1/contracts/:id` | 상세(진행·서명자·감사) | contracts:read |
| `POST /v1/contracts/:id/remind` | 수동 독촉 재발송 | contracts:write |
| `POST /v1/portal/:token/unlock` | 접근암호 검증(rate-limit·실패 감사) → 열람·서명 진행 | 공개(토큰) |

철회·만료·verify·감사추적인증서는 기존 EP 그대로. RBAC: admin·operator 쓰기, viewer 열람만. 플래그 OFF 시 404.

### 3.3 발송·알림

- Notifier 포트에 **SMTP 드라이버**(nodemailer, env `SMTP_URL`/`SMTP_FROM`, 연동설정 UI 노출). provider=smtp. 벤더계약 불요.
- 발송·재발송은 기존 발송이력에 기록.
- **리마인더 잡**(P3): 스케줄러에 미서명 N일(기본 3) 자동 재발송 + 만료 D-1 알림, 계약별 on/off.

### 3.4 완료 교부 (P3)

완료 시 전 서명자에게 이메일: 완료 안내 + **만료형 다운로드 토큰** 링크(완료 PDF + 감사추적인증서). 다운로드는 전건 감사(docaccess 패턴).

### 3.5 콘솔 UI (P2)

NAV "계약" 섹션: **계약함**(상태 탭·라벨·검색·CSV — 대시보드 패턴), **새 계약**(업로드→서명자 구성→발송), **상세**(진행 타임라인·문서 뷰어(기존 iframe)·검증 탭·감사로그·리마인드·철회).

## 4. 상태·전이

기존 CREATED → IN_PROGRESS → COMPLETED / EXPIRED / REVOKED 그대로. 순서 게이팅·멱등·409 규칙 무변경.

## 5. 보안 고려사항

- 접근암호: scrypt 해시 보관(최소 4자)·**3중 방어**(①IP 레이트리밋 H4 + unlock EP @Throttle 10/분 ②계약 단위 연속 오류 5회 → 10분 잠금(429, 병렬 시도 우회 방지 직렬 판정, `CONTRACT_UNLOCK_LOCKED` 감사 봉인) ③timingSafeEqual 비교)·실패 감사(F003 준용)·unlock 후 토큰 세션 바인딩.
- 공개 QR 검증: 접근암호 설정 계약은 검증토큰 미발급·공개 EP 403(본문·서명자 비노출). 보관(archive) 시 검증토큰 폐기.
- 발송 링크 baseUrl 검증: env 고정 시 클라이언트 값 무시, 아니면 http(s) 형식 검증(피싱 링크/QR 주입 차단).
- 정합성: 단일 meta(주소록·커스텀 서식·오버라이드·이력)의 read-modify-write 는 인프로세스 KeyedMutex 직렬화(lost update 방지, 단일 노드 전제). 체결 완료 후처리(TSA 시점봉인·검증토큰·자동 교부)는 동시완료 경합에도 1회 보장(`handleCompletion` — 직렬+처리완료 플래그).
- 순차 서명 열람 게이팅: SEQUENTIAL 발송은 현재 차례 외부 서명자에게만 포털 링크, 앞 순번 완료 시 auto-advance 발송(순번 前 열람 차단).
- 문서 접근 전건 감사(`docaccess:<id>` 체인 재사용) — 열람·다운로드 모두.
- 원본에 개인정보 포함 가능(근로계약 주민번호 등) → 암호화 보관 + RBAC + 감사, PHI 아니어도 동일 기준 적용. 목록·CSV엔 문서 내용 미노출(메타만).
- 외부 포털: 기존 토큰 만료·바인딩 유지. unlock 없이 문서 EP 접근 시 403.
- 플래그 `GENERAL_CONTRACTS` OFF 시 전 EP 404(PHI/개인정보 저장 방지 — PORTAL_DOC_PREVIEW 동형).

## 6. 수용 기준 (P1~P2)

1. 계약 생성→PDF 업로드→발송(mock SMTP 수신 확인)→외부 접근암호 통과→문서 열람→서명→내부 서명→COMPLETED→`verify` overall=true.
2. 접근암호 오류 rate-limit 차단·실패 감사 기록. 플래그 OFF 404. viewer 쓰기 403.
3. 백엔드 회귀 0실패 + UI e2e 그린 + (활성화 시) 운영 매뉴얼 갱신.

## 7. 테스트 계획

- 백엔드 `test/contracts.e2e.mjs`: 풀사이클·접근암호·rate-limit·플래그·RBAC·멱등 (mock SMTP 수신기 — joint-3party 하니스 패턴).
- UI `web/tests/e2e/contracts.spec.ts`: 계약함·새 계약·포털 unlock·서명 완료. a11y 스펙에 신규 화면 편입.

## 8. 단계·규모

| 단계 | 내용 | 규모 |
|---|---|---|
| **P1 계약 코어(백엔드)** | signMode·contract-meta·EP 7종·SMTP 드라이버·접근암호 unlock·e2e | 중 |
| **P2 콘솔+포털 UI** | 계약함·새 계약·상세·포털 unlock 화면·뷰어 재사용 | 중 |
| **P3 관리 고도화** | 리마인더 자동·완료문서 교부·라벨·대시보드 위젯 | 소~중 |
| **P4 준비 고도화** | 필드(작성란) 에디터·드로잉 사인·요청 템플릿·CC/첨부 | 대(별도 상세설계) |
| **P5 후속** | DOCX 변환·예약/대량 전송·주소록·내부결재 연동·PASS step-up·i18n | 수요 확인 후 |

> **구현 현황(2026-07-27)**: P1~P3 완료(v1.9.0). P4는 아래 형태로 대체 구현 — 계약 서식+리치 에디터+PDF 배치 편집기(§10 ③④), 드로잉 사인=손글씨 서명(§10 ⑤). P5 중 **주소록 구현 완료**, 나머지(DOCX·예약/대량·내부결재 연동·PASS step-up·i18n)는 미착수.

## 9. 미결·후속

- 완료 계약 보존기간(법정 보존연한 — 기관 정책 확인 필요, sweep 정책 연동). 손글씨 서명 이미지 보존·파기 정책 포함.
- ~~운영 SMTP 서버 실체~~ → **해결**: 라이브 Resend SMTP(smtps, SMTP_FROM=noreply@example.org, 3,000통/월).
- fill-at-signing(포털 서명자가 입력란 직접 기재)은 해시 봉인 구조와 상충 — 재조판·재해시 설계 필요(현재는 작성자 기입+위치 표시).
- 내부결재 연동 시점(기존 전자결재 부활 — 보안팀 sign-off 선행).
- 계약 첨부/다중문서.

## 10. 구현 반영(as-built) 이력 — v1.9.0(2026-07-06) ~ v1.22.0(2026-07-28)

설계 v0.1 이후 실제 구현·라이브 배포된 범위. 상세는 CHANGELOG [1.9.0]·[1.10.0]·[1.10.1].

| # | 구현분 | 요지 |
|---|---|---|
| ① | **P1~P3 코어**(v1.9.0) | `/v1/contracts` 준비→발송→체결→관리 풀사이클, unlock 게이트, SMTP 드라이버, 자동 리마인더, 완료문서 만료형 교부, 콘솔 "전자계약" 섹션(현황·계약함·새 계약·상세·알림), 플래그 OFF 시 메뉴 자동 숨김 |
| ② | **라이브 활성화** | GENERAL_CONTRACTS=on + Resend SMTP 실발송. operator 역할 메뉴 제한(전자계약+내 계정+매뉴얼) |
| ③ | **계약 서식 36종+편집** | 내장 16종→의료특화 10종·보건행정 10종 추가(총 36종, 12~22개조 실무 수준·관련 법령 인용). 기관 커스텀 등록·복제·삭제, **내장 직접 편집(오버라이드 — 코드 원본 보존·기본값 복원)**, 버전 이력(서식당 20건)·되돌리기, 편집기 {{필드}} 실시간 검증 |
| ④ | **에디터·조판** | 리치 에디터(TipTap, H1/H2/굵기 → PDF 블록 조판), 한글 PDF 컴포저(나눔고딕 전체 임베드 — pdf.js 호환 위해 subset 금지), `[서명란#N]`/`[입력란#N]` 마커, **PDF 배치 편집기**(클릭 배치·드래그·리사이즈, 업로드 PDF 스탬프 포함), 전체화면 배치 모달 |
| ⑤ | **손글씨 서명·검증** | SignaturePad(외부 필수·내부 선택, AES-256-GCM 암호화 보관·해시 감사 봉인 — PKI=법적 효력·손글씨=행위 증거), 서명란 좌표 합성 표시본(원본 해시 무결성 유지), **완료문서 검증 QR**(공개 진위 확인 페이지), 서명검증 상세 패널(CMS·체인·LTV·TSA) |
| ⑥ | **관리 확장** | 순차/동시(PARALLEL) 서명 방식, 카테고리 분류·집계, 보관(soft archive)·복원, 발송 주소록(자동 학습), 내부 서명자 이메일 알림(콘솔 계정 이메일·내 계정 self 설정) |
| ⑦ | **보안·정합 보완**(검토 4-에이전트 감사 전량 해소, v1.10.0~v1.10.1) | §5 갱신분 — 공개 QR 접근암호 계약 차단, 손글씨 서명자 매핑 정합, baseUrl 검증, 내부 알림 dedup, 보관 시 검증토큰 폐기, 보건행정 고지문 분기, 목록 truncated 관측성, 검증토큰 선발급(읽기 부작용 제거), 순차 열람 게이팅(auto-advance), **unlock 잠금(5회/10분)**, **meta 직렬화(KeyedMutex)**, **동시완료 1회 보장(handleCompletion)** |
| ⑨ | **첨부/다중문서**(v1.11.0, §11) | 열람용 부속 문서 — 서명 대상 아님·SHA-256 감사 봉인·작성(미발송) 상태만 편집·포털 unlock 게이트·교부 포함 |
| ⑩ | **프리셋·원플로우·타임라인**(v1.12.0, U5 완결) | 요청 구성 프리셋(기관 공용·암호값 미저장·upsert), 생성 후 바로 발송, 상세 진행 타임라인 |
| ⑪ | **목록/통계 DB 푸시다운**(v1.12.1) | 봉투 필터 캐시(ct*)+migration 0006+부팅 백필 — 상한 스캔·행별 meta N+1 제거 |
| ⑫ | **fill-at-signing**(v1.13.0, 별도 설계 v1.0) | 서명자 입력란(FIELD) 직접 기재 — 기재값 암호화+CONTRACT_FILLED 봉인(fail-closed)·표시본 합성·원본 해시 불변 |
| ⑬ | **에디터 확장**(v1.14.0) | 정렬·불릿/번호 목록·표(행/열 편집) + PDF 조판(정렬 오프셋·들여쓰기·표 그리드), 툴바 활성 상태 stale fix |
| ⑭ | **fill-at-signing 고도화**(v1.15.0) | 입력란 타입(text·date·money·number) 검증·**정규화 값 봉인**, 박스 맞춤(줄바꿈→축소→말줄임), 기재값 증적 조회 EP·상세 표시 |
| ⑮ | **코드 감사 대응**(v1.15.1~v1.17.1) | 4개 에이전트 병렬 감사 결과 반영 — 마크 삭제로 인한 기재값 소실·서명 후 재기재·감사체인 append 직렬화·보관 계약 교부 차단·raw 파서 스코프·목록 파라미터 검증·LIKE 이스케이프·부분 인덱스·fail-closed 합성. 정책: 공개 검증본 기재 PII 비공개·서식 쓰기 스코프 분리(`contracts:templates`)·프리셋 마스킹·첨부 보존(옵트인) |
| ⑯ | **순차 서명 열람·교부 UX**(v1.16.0~v1.20.1) | 뒤 서명자가 **앞 사람 기재값 반영 표시본** 열람(원본 해시 불변), 교부 문서 2종 안내 문구, **교부 링크 1회 연장·지정 이메일 전달**, 다운로드 파일명 `제목_구분_YYYYMMDD_식별자`(RFC 5987) |
| ⑰ | **연동 요청 반영**(v1.18.0~v1.22.0) | weRub·edu 요청 — `request.signer_completed` 중간 통지, 완료 통지 `verifyToken`, 경량 `status`(participantId 포함), 수신처 정정(구 링크 무효화), 계약 철회 EP, `compose` 응답 `X-Sign-Marks`·`X-Sign-Pages`, Webhook **DEAD 재발송·수신 경로 재지정**·소비자별 서명 시크릿, 표 조판(열 폭·병합·**셀 음영**·**헤더 반복**·글리프 대체 보고) |
| ⑧ | **PKI 운영 보완** | CMS 검증 재기동 견고성(인증서 CMS 내장 자체검증), 인증서 시리얼 접두 카운터 영속화(재기동 리셋 → 연동팀 "저장소 초기화" 오인 방지) |

관련 문서: UI 기획 `docs/02-design/contract-management-ui-plan.md`(v0.3) · 운영 매뉴얼 `web/manual.source.html` §4.3 · edu 연동 회신 `docs/05-handoff/edu-store-persistence-reply.md`.

## 11. 첨부/다중문서 (백로그 A1) — 설계 노트

**목적**: 계약 봉투에 부속 문서(견적서·사업자등록증·사양서 등)를 첨부해 서명자가 함께 열람.

**핵심 결정**:
- **첨부 = 열람용 참고 자료, 서명 대상 아님.** 서명·해시 봉인은 주 문서(`documentHash`) 단독 유지(다중 서명대상은 봉투 모델 변경이라 제외). 대신 각 첨부의 SHA-256을 추가 시점 감사 체인에 봉인(`CONTRACT_ATTACHMENT_ADDED`)해 "서명자가 열람한 첨부"의 무결성 증거를 남긴다.
- **불변 정책**: 추가/삭제는 **작성(CREATED·미발송) 상태에서만**(발송 후 409) — 서명자별 열람 내용 불일치 방지. 보관(archived) 계약 변경 차단.
- **형식·한도**: PDF·PNG·JPEG, 파일당 `CONTRACT_ATTACH_MAX_MB`(기본 10MB), 계약당 10건.
- **보관**: SecretBox AES-256-GCM 암호화(원본과 동형), meta KV `ctattach:<id>`(목록) + `ctattach:<id>:<aid>`(blob), 영구 보관(원본과 동일 — 보존·파기 정책 확정 시 함께 적용).
- **blob 레이아웃(v1.26.0, R9)** — 전량 메모리 적재를 없애기 위해 **청크 분할**:
  - `ctattach:<id>:<aid>` = 매니페스트 `{v:2, chunkBytes:262144, parts:[{sha256, bytes}]}`
  - `ctattach:<id>:<aid>:c<i>` = 청크별 `sealed`(평문 256KB 단위)
  - 읽기는 청크마다 **복호 → SHA-256 검증 → 방출** 순서라 손상 바이트가 클라이언트로 나가지 않고, 피크 힙이 파일 크기가 아니라 **청크 하나**로 고정된다.
  - **v1 레거시**(`{sealed}` 단일 슬롯)는 그대로 읽는다(**dual-read** — 데이터 마이그레이션 없음).
  - 쓰기는 청크 → 매니페스트 순서(반쪽 blob 미노출). 중간 실패 시 기록된 청크를 되감는다.
  - ⚠ 업로드 경로는 multipart 특성상 여전히 전량 버퍼(읽기 경로만 해소 — 쓰기 피크는 별건).
- **동시성(v1.26.0, R16)**: 목록 RMW 는 KeyedMutex(인프로세스 빠른 경로) + **버전 일치 CAS**(`saveMetaIfUnchanged`) — 다중 노드·롤링 배포에서도 목록이 통째로 덮어써지지 않는다.
- **열람 경로 3종**: 콘솔(contracts:read) · 포털(**unlock 게이트 적용**) · 완료 교부(만료형 토큰). 포털·교부 다운로드는 `CONTRACT_ATTACHMENT_ACCESSED` best-effort 기록.

**EP**: `POST /v1/contracts/:id/attachments?name=`(raw body·contracts:write) · `GET :id/attachments`(목록) · `GET :id/attachments/:aid`(다운로드) · `DELETE :id/attachments/:aid` · 포털 `GET /v1/portal/:token/attachments(/:aid)` · 교부 `GET /v1/contracts/delivery/:token/attachments(/:aid)`.
