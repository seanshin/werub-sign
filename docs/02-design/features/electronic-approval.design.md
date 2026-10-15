# 전자결재(상신→결재) + 통합 인증로그 설계

> 상태: **설계 v0.5 · P1 백엔드 + P2 프론트 완료** · 결재모델 A + step-up 매트릭스 확정(§2·§5) · 잔여 P0=보안검토 sign-off · 규모 **L~XL** · 피처플래그 `ELECTRONIC_APPROVAL` 기본 OFF
>
> **P1 백엔드(완료)**: `ApprovalService`(src/application)·`ApprovalController`(src/presentation, `/v1/approvals`)·DTO·스코프(`approval:write`/`approval:act`)·플래그·e2e `test/electronic-approval.e2e.mjs`(27, 게이트 편입). 결재자=`signerType:'APPROVER'`(STAFF 아님 → submit 의 HIS SSO 게이트·`HIS_SSO_ALLOWED_ROLES` 디커플링, 바인딩은 `act()` 가 세션주체==지정 결재자로 강제). 인증로그 fail-closed(승인=로그 봉인→서명, 실패 시 `APPROVAL_SIGN_FAILED` 보정). 전체 백엔드 회귀 0실패.
>
> **P2 프론트(완료)**: `web/src/app/admin/approvals/`(page=결재함 목록·`new`=상신 폼·`[id]`=결재선+결재/반려 모달+통합 인증로그 뷰어)·`approvalsApi`(lib/api)·타입·NAV "전자결재" 섹션·상신 폼 파일 SHA-256 클라 계산(원본 미전송). 인증로그 뷰어는 `LogDetail`/`shortHash`/무결성 배지/CSV 재사용, 결재/반려는 `Modal`(포커스트랩)·step-up 필드 조건부. 역할 게이팅 `useState+useEffect getRole`(prerender 가드). UI E2E `web/tests/e2e/approval.spec.ts`(2, seedApproval 헬퍼). UI 31/31 + axe 그린, next build 0에러.
> 관련: [[medical-esign-platform]] 목표② 법적 무결성·목표③ 원내 다자 UX / EMR 보안성 F008(접속기록)·F010(전자서명)

## 0. 결론

- 전자결재(상신→다단계 결재)는 **새 로깅/서명 스택을 만들지 않는다.** 기존 다자 순차서명(`SignatureRequest`+`SignerParticipant.signOrder`)·PKI·TSA·감사 해시체인을 그대로 재사용한다.
- **결재선 = 순차 서명 참가자열**로 모델링(**Model A**, §2 권장). 각 결재 액션은 STAFF 인증서 기반 실제 전자서명이 되어 목표②(법적효력)를 자동 충족.
- **인증로그**는 서명 체인과 **분리된 전용 감사 스트림 `approval:<requestId>`** 로 남긴다. 한 엔트리에 **본인확인 사실(method·assurance·identityVerificationId) + F008 접속기록(계정·시각·IP·UA·행위)** 을 통합 봉인. `docaccess:<id>`가 서명 체인과 분리된 것과 동형.
- 호출은 **결재 서비스 내부 커밋 시점 1개 메서드**(`recordApprovalAudit`) — 내부는 기존 `AuditChainService.next()` + `SignStore.appendAudit()` 3줄. 인증 주체는 서버가 세션에서 도출(클라 불신), **fail-closed**(로그 못 남기면 결재 불성립).

## 1. 현재 상태 (구현 조사 결과)

| 요소 | 현황 | 위치 |
|---|---|---|
| 결재 도메인 | **없음** — 상신/결재선/전결/반려 개념 미존재 | (신규) |
| 다자 순차서명 | signOrder 게이팅(순서위반 409)·전원 완료 시 COMPLETED+TSA anchor **완성** | `src/application/signature-request.service.ts:285-334` |
| STAFF 서명 | HIS SSO(JWKS·aud=sign) 검증 → `submit({staff})`, 명의도용 방지(sub==externalSignerRef) | `src/presentation/staff-sign.controller.ts`, `signature-request.service.ts:258-269` |
| 본인확인 강결합 | `performIdentity()` → `IdentityProvider.verify()` → `IDENTITY_VERIFIED` 봉인 | `signature-request.service.ts:526-565` |
| 감사 해시체인 | `AuditChainService.next(prev,type,data,ts)` + `SignStore.appendAudit(key,entry)` | `src/infrastructure/audit/audit-chain.service.ts:28` |
| TSA 앵커 | `AuditAnchorService.anchor(key)` 체인 head 시점봉인 | `src/application/audit-anchor.service.ts:21` |
| F008 접속기록 예시 | `DOCUMENT_VIEWED` 전용 스트림 `docaccess:<id>`(계정·IP·via) | `src/application/portal-document.service.ts:104-107` |
| 콘솔 인증 주체 | `req.adminUser={username,role}`·`req.sessionId`(ApiKeyGuard 세션검증) / actor 관례 `user:<username>` | `src/presentation/guards/api-key.guard.ts:87`, `auth.controller.ts:196` |
| 감사 조회/검증 | `parseAuditFilter`/`filterAudit`/`auditToCsv`(BOM) + 체인 `verify` + 앵커 `verify` | `src/presentation/audit-filter.ts`, `admin-audit.controller.ts` |
| RBAC | 역할 admin/operator/viewer + 스코프(`requests:write` 등), 민감 스코프 별도 | `src/infrastructure/auth/rbac.ts:24` |

→ **서명·인증·감사 코어는 이미 결재선에 필요한 부품을 다 갖췄다.** 신규는 (a) 결재선 의미 부여 (b) 통합 인증로그 스트림 (c) 결재 파사드/EP.

## 2. 선행 결정: 결재 모델 A vs B

### Model A — 서명요청 특화(**권장**)
전자결재 = `SignatureRequest`(신규 `signMode=APPROVAL`), **결재선 = `SignerParticipant` 순차열**(signOrder=결재 순서, signerType=STAFF). 결재 액션 = staff 서명 경로 재사용.

- ✅ 순서 게이팅·전원완료·TSA anchor·PKI·`verify` **무상속** → 각 결재가 **실제 전자서명**(목표② 법적효력, F010).
- ✅ 신규 영속 엔티티 최소(봉투는 기존 `StoredRequest`). 마이그레이션 불요.
- ✅ STAFF SSO·명의도용 방지·본인확인 강결합 그대로 적용.
- ⚠️ "결재"에 매번 인증서 서명이 붙음(연산비용) — 원내 STAFF 인증서 재사용이므로 실무 부담 낮음.

### Model B — 독립 결재 도메인
별도 `ApprovalDraft`/`ApprovalLine` 상태머신, 결재 = 인증로그만(암호서명 없음). 최종 완료 시 필요하면 `SignatureRequest` 별도 발주.

- ✅ 가벼움(서명 연산 없음), 순수 결재 워크플로우.
- ❌ 상태머신·순서게이팅·검증을 **재구현**(서명서비스와 중복). ❌ 결재 자체의 법적 강도가 "로그"에 그침(암호 비가역성 없음) — 이 플랫폼의 존재이유(전자서명 무결성)와 어긋남.

**결정(확정 — 사용자 승인 2026-07-05)**: **Model A**. 근거 = 결재선의 순차·다자·검증 요구가 기존 다자서명과 **동형**이고, 결재를 실제 전자서명으로 승격해야 EMR F010·전자서명법 효력을 얻는다. B의 경량성은 `requiredIdentityLevel=NONE`+저비용 SOFT 서명으로도 근접 가능. → 이하 설계는 A 기준.

## 3. 아키텍처

```
상신자(콘솔)                                          결재자 N (콘솔/HIS SSO)
   │ POST /v1/approvals (제목·문서해시·결재선[order1..N])       │
   ▼                                                          │
ApprovalFacade ── SignatureRequestService.create(signMode=APPROVAL) │
   │  participants = 결재선(STAFF, signOrder=결재순서)             │
   ▼                                                          ▼
   ●───────── (순차 게이팅) ────────────── POST /v1/approvals/:id/act {decision, opinion}
                                              │  1) 세션 actor 도출(req.adminUser)
                                              │  2) [고위험] step-up 본인확인
                                              │  3) submit() → IDENTITY_VERIFIED·SIGNED  (서명 체인: <requestId>)
                                              │  4) recordApprovalAudit()  ← 통합 인증로그 (approval:<requestId>)
                                              │  5) 반려면 REJECTED 봉인 + 결재 중단
                                              ▼
                                     전원 승인 → COMPLETED + TSA anchor(양 스트림)
```

두 감사 스트림을 **분리**한다:
- `<requestId>` — 암호 서명 라이프사이클(IDENTITY_VERIFIED/SIGNED/COMPLETED). **기존 그대로.**
- `approval:<requestId>` — **결재 인증로그(신규)**. F008 관점(누가·언제·어디서·무엇을) + 본인확인 사실 통합. 독립 조회·CSV·verify.

### 3.1 신규 엔드포인트 (파사드 — 내부는 기존 서비스 재사용)

| 메서드 | 경로 | 스코프 | 설명 |
|---|---|---|---|
| POST | `/v1/approvals` | `approval:write` | 상신 — 요청 생성 + 결재선(순차 STAFF 참가자). 멱등키 지원 |
| POST | `/v1/approvals/:id/act` | `approval:act` | 결재 액션 `{decision: APPROVE\|REJECT, opinion?}` → 서명+인증로그 봉인 |
| GET | `/v1/approvals/:id` | 읽기 | 결재 진행상태(결재선·현재 단계·이력) |
| GET | `/v1/approvals/:id/authlog` | 읽기 | **통합 인증로그** 조회(필터 `eventType/from/to/q`) |
| GET | `/v1/approvals/:id/authlog/export.csv` | 읽기 | 인증로그 CSV(UTF-8 BOM, PHI 미봉인·식별자/해시만) |
| GET | `/v1/approvals/:id/authlog/verify` | 읽기 | 체인 무결성 + TSA 앵커 검증 |

- 결재자 인증: STAFF는 기존 `POST /v1/sign/staff` 경로(SSO Bearer)로 수렴 가능 — `act`는 그 위의 결재 의미 파사드. 콘솔 관리자 결재는 세션(`req.adminUser`)으로 수행.
- RBAC: 신규 스코프 `approval:write`(상신)·`approval:act`(결재). 역할 매핑은 `rbac.ts:24 ROLE_SCOPES`에 추가(operator=상신, 결재는 지정 결재자만). viewer는 읽기만.

### 3.2 통합 인증로그 — 호출 규격 (핵심)

```ts
// ApprovalService(application) private — recordCertAudit/recordAudit 동일 컨벤션
private async recordApprovalAudit(
  requestId: string,
  eventType: 'APPROVAL_SUBMITTED' | 'APPROVAL_APPROVED' | 'APPROVAL_REJECTED',
  ctx: {
    // ── 본인확인 사실 ──
    actor: string;                    // 서버 도출: `user:${req.adminUser.username}` | `staff:${employeeNumber}`
    authMethod: string;               // SESSION_JWT | MFA_TOTP | STAFF_SSO | APP_STEPUP
    assuranceLevel?: string;          // SOFTWARE | acr(SSO)
    identityVerificationId?: string;  // 고위험 결재 step-up 시 IdentityVerification.id
    // ── F008 접속기록 ──
    ip?: string; userAgent?: string;  // req.ip / req.headers['user-agent']
    // ── 결재 부가 ──
    step: number;                     // 결재선 단계(signOrder)
    decision?: 'APPROVE' | 'REJECT';
    opinion?: string;                 // 결재 의견/반려 사유
  },
): Promise<void> {
  const key = `approval:${requestId}`;
  const prev = await this.store.lastAudit(key);
  const entry = this.audit.next(prev, eventType, ctx, new Date().toISOString());
  await this.store.appendAudit(key, entry); // 실패 시 throw → 결재 트랜잭션 롤백(fail-closed)
}
```

**호출 지점** = `act()`의 결재 커밋 시점, 서명(submit) 성공 **직후 같은 트랜잭션 경계** 안:

```ts
async act(requestId, dto, session /* req.adminUser·sessionId */, net /* req.ip·UA */) {
  // ... 권한·결재순서·현재 결재자 일치 검증 ...
  const identityId = highRisk ? await this.stepUp(session) : undefined; // 고위험만 step-up
  if (dto.decision === 'APPROVE') {
    await this.signSvc.submit(participantId, { staff: session.staff, identity: /* 세션근거 */ });
    await this.recordApprovalAudit(requestId, 'APPROVAL_APPROVED', {
      actor: `user:${session.username}`,
      authMethod: session.mfaVerified ? 'MFA_TOTP' : 'SESSION_JWT',
      assuranceLevel: 'SOFTWARE', identityVerificationId: identityId,
      ip: net.ip, userAgent: net.ua, step: participant.signOrder, decision: 'APPROVE', opinion: dto.opinion,
    });
    if (allApproved) await this.auditAnchor.anchor(`approval:${requestId}`); // 최종 결재 시점봉인
  } else {
    await this.recordApprovalAudit(requestId, 'APPROVAL_REJECTED', { /* 동일 ctx */ decision: 'REJECT' });
    // 반려 → 결재 중단(요청 상태 REJECTED). 재상신은 새 봉투.
  }
}
```

원칙:
- **인증 주체는 서버가 세션에서 도출**(`req.adminUser`), 요청 본문의 신원 주장 불신 — staff-sign이 `sub==externalSignerRef` 강제하는 것과 동일.
- **fail-closed**: `docaccess`(열람)는 best-effort지만 결재 인증로그는 결재와 원자적 — 봉인 실패 시 결재를 커밋하지 않는다.
- **상신도 로그**: `APPROVAL_SUBMITTED`를 상신 시점에 남겨 결재선 개시를 봉인(누가 언제 상신).

### 3.3 저장 계층

- **봉투/서명/결재상태**: 기존 `StoredRequest`+`StoredSignature`+참가자 상태 재사용(Model A) → **신규 테이블·마이그레이션 불요**. `signMode=APPROVAL`·참가자 상태(PENDING/SIGNED/DECLINED)가 곧 결재 진행.
- **결재선 메타(의견·반려사유·결재유형)**: 단일 슬롯 `saveMeta('approval-meta:<requestId>', {...})`(포털 문서 블롭과 동일 KV 패턴).
- **인증로그**: `appendAudit('approval:<requestId>', entry)` append-only(위 §3.2).
- 목록 대시보드(결재함: 상신함/결재대기/완료)가 필요하면 `queryRequests`에 `signMode` 필터 재사용(이미 인덱스 컬럼 존재, migration 0004). 추가 인덱스 불요.

## 4. 상태·전이

```
DRAFT ─(상신)→ SUBMITTED ─(order1 결재)→ IN_PROGRESS ─(orderN 결재)→ COMPLETED
                    │                          │
                    └────(반려 REJECT)─────────┴──→ REJECTED  (재상신=새 봉투)
                                    (만료 TTL)──────→ EXPIRED
```
- 순서 게이팅·전원완료·만료는 기존 상태머신 재사용. 결재선 특화 = "반려 시 즉시 종결" 규칙만 추가(서명흐름의 DECLINED→요청 REJECTED 매핑).

## 5. 보안 고려사항

- **주체 위조 방지**: actor는 서버 세션 도출. 콘솔=`req.adminUser`(ApiKeyGuard 검증), HIS SSO=JWKS 검증 sub. 본문 신원 무시.
- **권한**: `approval:act`는 해당 단계 지정 결재자 계정만(참가자 `externalSignerRef`==세션 주체). 타인 대리 결재 차단.
- **고위험 결재 step-up 매트릭스(확정 2026-07-05)**: 아래 둘 중 하나면 결재 직전 **본인확인 재강제** — ①콘솔 결재자: **MFA(TOTP/복구코드) 재확인**(`AdminUserService.verifyTotpCode`, assurance=MFA_STEPUP) ②HIS SSO: 재인증 `acr`(assurance=SSO_STEPUP) ③폴백: `IdentityProvider.verify()`(PASS, `identityVerificationId` 봉인). 그 외 단계는 로그인 세션이 본인확인 근거.

  | 조건 | step-up | 판정 근거 |
  |---|---|---|
  | 고위험 문서유형(SURGERY·ANESTHESIA·DNR·마약류 등) | **강제** | 봉투 `externalDocType`/위험태그(기존 위험도 매트릭스 재사용) |
  | 최종 결재 단계(전결/원장 = 결재선 마지막 order) | **강제** | `participant.signOrder == requiredSigners` |
  | 그 외(일반 문서·중간 단계) | 면제 | 세션(로그인+MFA)=본인확인 근거 |

  - 고위험 판정은 상신 시 `saveMeta('approval-meta:<id>', { highRisk, docType })`에 봉인(상신자 임의변경 방지, 서버 판정). `act()`에서 `highRisk || isFinalStep`로 step-up 여부 결정.
  - step-up 실패 → 결재 차단(ForbiddenException, `performIdentity` 실패 흐름과 동일).
- **무결성**: 인증로그는 해시체인+TSA 앵커 → 사후 위변조 탐지(F008·F009·목표②). CSV는 PHI 미봉인(식별자·해시만, `auditToCsv` 규칙 준수).
- **감사의 감사**: `approval:<id>/authlog/verify`로 체인·앵커 상시 검증. 관리자 횡단 뷰는 `auditKeys('approval:')`.
- **가용성**: fail-closed이므로 저장소 장애 시 결재 불가 — `store.ping()` readiness·재시도 정책 정의(§7).

## 6. 수용 기준

1. 상신 시 `APPROVAL_SUBMITTED`가 `approval:<id>`에 1건 봉인(actor·ip·ts).
2. order2 결재자가 order1보다 먼저 시도 → 409(순서 게이팅).
3. 결재 승인 시 (a) `<requestId>`에 SIGNED (b) `approval:<id>`에 `APPROVAL_APPROVED`가 본인확인+F008 필드 포함해 봉인.
4. 전원 승인 → COMPLETED + 양 스트림 TSA 앵커, `verify` overall=true.
5. 반려 → `APPROVAL_REJECTED` 봉인 + 요청 REJECTED, 이후 결재 시도 409.
6. 인증로그 봉인 실패를 주입하면 결재가 커밋되지 않음(fail-closed).
7. 타 계정이 지정 결재자 자리 결재 시도 → 403.
8. authlog 조회 `eventType/from/to/q` 필터·CSV(BOM)·verify 동작.
9. 피처플래그 OFF면 `/v1/approvals*` 404(미노출).

## 7. 테스트 계획

- `test/electronic-approval.e2e.mjs`: 상신→다단계 결재→완료 happy path, 순서게이팅 409, 반려 종결, fail-closed(저장소 오류 주입), 타인 결재 403, 인증로그 필터/CSV/verify, 플래그 OFF 404. 회귀 게이트(`e2e`→CI `e2e:all`) 편입.
- 인증로그 통합 필드 단위검증: 한 엔트리에 authMethod·assuranceLevel·ip·ua·step·decision 동봉.
- UI(추가 시): 결재함/결재선/인증로그 뷰 Playwright + axe([[test-automation]]).

## 8. 단계·규모

| 단계 | 내용 | 규모 |
|---|---|---|
| P0 | 본 설계 + ~~결재모델 A 확정~~✅ + ~~고위험 step-up 매트릭스 확정~~✅ + 보안검토 **준비 완료**(자체점검+하드닝 F1/F2/F5, `docs/06-ops/electronic-approval-security-review.md`) → **보안팀 sign-off 서명 잔여** | 결정 |
| P1 백엔드 | ~~ApprovalService(상신·act) · `recordApprovalAudit` · authlog EP(조회/CSV/verify) · 스코프 · 플래그 · e2e~~ ✅ **완료** | **L** |
| P2 프론트 | ~~결재함(상신/진행중/완료 탭) · 상신 폼 · 결재선 뷰 · 결재/반려 액션 · 인증로그 뷰어 · a11y · UI E2E~~ ✅ **완료** | **M~L** |
| P3 연동 | HIS 상신 소스 연동(외부 문서→상신) · 완료 webhook(결재 확정 통지) — **계약 문서화 완료**(`docs/05-handoff/approval-submission-contract.md`), 백엔드 델타(기계키 상신·SSO 결재)=P3.1 | M |

- 피처플래그 `ELECTRONIC_APPROVAL` 기본 **OFF**(미설정 시 EP 404) → 보안검토 후 활성. 운영매뉴얼 갱신은 활성화 시점([[keep-manual-in-sync]]).

## 9. 미결/후속

- ~~결재모델 A/B 확정(§2)~~ ✅ **A 확정**(2026-07-05).
- ~~고위험 결재 step-up 매트릭스 확정~~ ✅ **확정**(2026-07-05, §5): 고위험 문서 또는 최종 결재 단계 → step-up.
- 병렬 결재·합의(다수 동시)·전결(위임)·후결 — MVP는 **순차 결재선만**, 위 3종 후속.
- 재상신/회수(상신 취소) 정책 — MVP는 반려=새 봉투 재상신. 회수는 후속.
- 콘솔 세션 결재 vs HIS SSO 결재의 actor 통합 표기 규칙 최종화(`user:` vs `staff:`).
- 대량 결재(일괄 승인) — 기존 대시보드 일괄작업 패턴 재사용 여지.
- ~~**step-up 자격 형태**: 콘솔 PASS ci 대신 MFA(TOTP) 재확인 전환~~ ✅ **완료**: 콘솔 결재자 MFA(TOTP/복구코드) 재확인 우선(`verifyTotpCode`, assurance=MFA_STEPUP), SSO=acr, PASS=폴백. 프론트가 MFA 등록 시 인증앱 코드 입력·미등록 시 PASS ci 입력으로 분기.
- ~~**결재자 인증서 사전 발급**(P1은 상신 시 `certSerial` 필수): 결재자 미보유 시 자동발급~~ ✅ **완료**: `certSerial` 미지정 시 `EnrollCertificateService`로 STAFF 인증서 자동발급(멱등 선차단으로 재상신 orphan 방지).
- **fail-closed 원자성**: append-only 저장소 특성상 로그↔서명 완전 원자성은 없음(P1은 로그先·실패 시 서명 미수행 + 서명 실패 시 보정 엔트리). **결정(2026-07-05): 트랜잭셔널 아웃박스는 보류.** 근거 = SignStore 3드라이버(InMemory/File/Prisma) 공통 트랜잭션 추상화는 침습적 대공사인데, 현 fail-closed + `APPROVAL_SIGN_FAILED` 보정으로 감사추적이 남고 남는 갭은 "로그↔서명 사이 프로세스 크래시"의 희박한 창뿐 → ROI 낮음. 필요 시 재기동 reconciliation(미완결 결재 정합)으로 경량 보강(후속 여지).
- **운영매뉴얼**(`web/manual.source.html`) 갱신은 **활성화 시점으로 이연**(포털 문서 미리보기와 동일 — 플래그 OFF 미활성 기능을 사용자 매뉴얼에 선반영하지 않음). 보안검토 sign-off 후 활성과 함께 갱신([[keep-manual-in-sync]]).
- **a11y 스펙 확장**: 신규 결재 페이지는 axe-감사 완료 컴포넌트(AdminLayout/Card/Table/Modal/Field) 재사용이나, `a11y.spec.ts`에 `/admin/approvals` 케이스 추가는 후속(선택).
