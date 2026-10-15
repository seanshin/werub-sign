// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { ForbiddenException, Injectable, NotFoundException, ConflictException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SignatureRequestService } from './signature-request.service';
import { EnrollCertificateService } from './enroll-certificate.service';
import { AdminUserService } from '../infrastructure/auth/admin-user.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { AuditAnchorService } from './audit-anchor.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { IDENTITY_PROVIDER, IdentityMethod, IdentityProvider } from '../domain/ports/identity-provider.port';
import { StoredIdentity, AuditEntry } from '../domain/types/store.types';

/**
 * 전자결재(상신→결재) + 통합 인증로그 — design docs/02-design/features/electronic-approval.design.md (v0.3, 모델 A).
 *
 * 결재선 = 다자 순차서명(SignatureRequest signMode=APPROVAL·SignerParticipant.signOrder) 재사용.
 * 결재 액션 = 실제 서명(submit) → 순서게이팅·TSA·verify 무상속. 결재자는 사전 발급된 인증서 보유.
 *
 * 인증로그는 서명 체인(<requestId>)과 분리된 전용 스트림 `approval:<requestId>`에 봉인 —
 * 본인확인 사실(actor·authMethod·assurance·identityVerificationId) + F008 접속기록(계정·시각·IP·UA·행위) 통합.
 * 원칙: actor 서버 도출(클라 불신)·fail-closed(봉인 실패 시 결재 커밋 안 함, docaccess best-effort와 대비).
 *
 * 피처플래그 `ELECTRONIC_APPROVAL` 기본 OFF(미설정 시 EP 404). 보안검토 sign-off 후 활성.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 결재 시점 인증 컨텍스트 — 서버(세션/SSO)가 도출, 요청 본문 신원 주장 불신. */
export interface ApprovalActor {
  actor: string; // `user:<username>` | `staff:<sub>` | `consumer:<name>` | `his:<submittedBy>`
  actorRole?: string;
  authMethod: string; // CONSOLE_SESSION | STAFF_SSO | MACHINE_KEY
  acr?: string; // STAFF_SSO 재인증 강도(step-up 근거) — HIS가 발급
  ip?: string;
  userAgent?: string;
}

export interface ApprovalLineItem {
  approverId: string; // 결재자 식별자(콘솔 username / SSO sub) — externalSignerRef 바인딩(지정 결재자만 결재)
  displayName: string;
  order: number; // 결재 순서(순차 게이팅)
  certSerial?: string; // 결재자 서명 인증서 — 미지정 시 서버 자동발급(STAFF)
  role?: string;
}

export interface CreateApprovalInput {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  docType?: string; // 위험 판정 근거(고위험 문서유형이면 step-up 강제)
  highRisk?: boolean; // 상신자 표기(서버가 docType 로도 판정 — OR)
  callbackUrl?: string;
  ttlDays?: number;
  line: ApprovalLineItem[];
  actor: ApprovalActor; // 상신자(서버 도출)
}

export interface ApprovalActInput {
  decision: 'APPROVE' | 'REJECT';
  opinion?: string;
  stepUp?: { mfaCode?: string; method?: string; ci?: string; phone?: string }; // 고위험/최종 결재 본인확인(MFA 우선)
  actor: ApprovalActor; // 결재자(서버 도출)
}

/** 고위험 문서유형 — 결재 시 step-up(본인확인 재강제). 위험도 매트릭스(§5) 재사용. */
const HIGH_RISK_DOC_TYPES = new Set(['SURGERY', 'ANESTHESIA', 'DNR', 'NARCOTIC', 'TRANSFUSION']);

const APPROVAL_SIGN_MODE = 'APPROVAL';
const APPROVER_SIGNER_TYPE = 'APPROVER';

@Injectable()
export class ApprovalService {
  constructor(
    private readonly signSvc: SignatureRequestService,
    private readonly enroll: EnrollCertificateService,
    private readonly users: AdminUserService,
    private readonly audit: AuditChainService,
    private readonly auditAnchor: AuditAnchorService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly config: ConfigService,
  ) {}

  /** 기능 활성 여부 — 기본 OFF(보안검토 전). `ELECTRONIC_APPROVAL=on|true` 로 활성. */
  enabled(): boolean {
    const v = (this.config.get<string>('ELECTRONIC_APPROVAL') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }
  private assertEnabled() {
    if (!this.enabled()) throw new NotFoundException('전자결재 기능 비활성');
  }

  private approvalKey(requestId: string): string {
    return `approval:${requestId}`;
  }
  private metaKey(requestId: string): string {
    return `approval-meta:${requestId}`;
  }

  /** 상신 — 결재선(순차 결재자열)로 결재 봉투 생성 + 상신 인증로그. 멱등(idempotencyKey). */
  async submitDraft(input: CreateApprovalInput) {
    this.assertEnabled();
    if (!input.line.length) throw new ConflictException('결재선(line)이 비어 있음');

    // 멱등 선차단 — 이미 존재하면 인증서 재발급/재기록 없이 반환(재상신 시 orphan cert 방지)
    const existingId = await this.store.getRequestIdByIdempotency(input.idempotencyKey);
    if (existingId) {
      const meta = await this.store.getMeta<ApprovalMeta>(this.metaKey(existingId));
      const dto = await this.signSvc.getRequest(existingId);
      return { ...dto, highRisk: meta?.highRisk ?? false, docType: meta?.docType ?? null };
    }

    // 결재선 구성 — certSerial 미지정 결재자는 서버가 STAFF 인증서 자동발급(사전 발급 불요)
    const sorted = [...input.line].sort((a, b) => a.order - b.order);
    const participants = [];
    for (const a of sorted) {
      let certSerial = a.certSerial;
      if (!certSerial) {
        const enrolled = await this.enroll.enroll({
          ownerType: 'STAFF',
          subjectDn: `CN=${a.displayName || a.approverId}`,
          ownerRef: a.approverId,
          licenseNumber: a.approverId,
        });
        certSerial = enrolled.serialNumber;
      }
      participants.push({
        signerRole: a.role ?? 'APPROVER',
        signerType: APPROVER_SIGNER_TYPE, // STAFF 아님 → submit 의 SSO 게이트 우회(콘솔 세션 결재), 바인딩은 act() 가 강제
        externalSignerRef: a.approverId,
        displayName: a.displayName,
        signOrder: a.order,
        certSerial,
        requiredIdentityLevel: 'INPERSON', // 기본 결재=콘솔 인증 근거(INPERSON). step-up 은 act() 가 별도 수행
      });
    }

    const dto = await this.signSvc.createRequest({
      idempotencyKey: input.idempotencyKey,
      externalDocId: input.externalDocId,
      title: input.title,
      documentHash: input.documentHash,
      signMode: APPROVAL_SIGN_MODE,
      callbackUrl: input.callbackUrl,
      createdBy: 'console',
      ttlDays: input.ttlDays,
      participants,
    });

    // 멱등 재상신(동일 키): createRequest 가 기존 봉투 반환 — meta 존재 시 재기록 금지
    const mk = this.metaKey(dto.requestId);
    const existing = await this.store.getMeta<ApprovalMeta>(mk);
    if (existing) return { ...dto, highRisk: existing.highRisk, docType: existing.docType };

    const highRisk = !!input.highRisk || HIGH_RISK_DOC_TYPES.has((input.docType ?? '').toUpperCase());
    const meta: ApprovalMeta = {
      highRisk,
      docType: input.docType ?? null,
      submittedBy: input.actor.actor,
      line: participants.map((p) => ({ approverId: p.externalSignerRef, order: p.signOrder })),
    };
    await this.store.saveMeta(mk, meta);
    await this.recordApprovalAudit(dto.requestId, 'APPROVAL_SUBMITTED', {
      ...input.actor,
      step: 0,
      assuranceLevel: 'SESSION',
    });
    return { ...dto, highRisk, docType: meta.docType };
  }

  /** 결재(승인/반려) — 지정 결재자 바인딩·step-up(고위험/최종)·서명·통합 인증로그(fail-closed). */
  async act(requestId: string, input: ApprovalActInput) {
    this.assertEnabled();
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== APPROVAL_SIGN_MODE) throw new NotFoundException('결재 문서 없음');
    if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') {
      throw new ConflictException(`결재 종결됨 (${request.status})`);
    }

    // 현재 결재 단계 = 미서명 참가자 중 최소 order
    const pending = [...request.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
    if (!pending) throw new ConflictException('결재할 단계 없음(전원 결재)');

    // 지정 결재자 바인딩 — 세션 주체가 이 단계 결재자와 일치해야 함(타인 대리 결재 차단).
    // 심층방어: 결재자 미지정(externalSignerRef 부재) 단계는 결재 불가(무바인딩 결재 차단).
    const actorId = input.actor.actor.replace(/^(user:|staff:)/, '');
    if (!pending.externalSignerRef || pending.externalSignerRef !== actorId) {
      throw new ForbiddenException(`APPROVER_MISMATCH: order ${pending.signOrder} 지정 결재자만 결재 가능`);
    }

    const meta = (await this.store.getMeta<ApprovalMeta>(this.metaKey(requestId))) ?? { highRisk: false };
    const isFinal = pending.signOrder >= request.requiredSigners; // 최종 결재 단계(전결/원장)
    const needStepUp = !!meta.highRisk || isFinal;

    // step-up(고위험/최종) — 세션만으로 부족, 본인확인 재강제. 실패 시 결재 차단(로그·서명 전).
    //  ① STAFF_SSO: HIS 재인증(acr)을 step-up 근거로 수용(sign은 HIS SSO 신뢰 — staff-sign과 동일 경계).
    //  ② 콘솔: MFA(TOTP/복구코드) 재확인 — 결재자 본인 세션 재증명(우선).
    //  ③ 폴백: IdentityProvider(PASS ci/phone) — MFA 미등록 계정 등.
    let identityVerificationId: string | undefined;
    let assurance = 'SESSION';
    if (needStepUp) {
      if (input.actor.authMethod === 'STAFF_SSO' && input.actor.acr) {
        assurance = `SSO_STEPUP:${input.actor.acr}`;
      } else if (input.actor.authMethod === 'CONSOLE_SESSION' && input.stepUp?.mfaCode) {
        const username = input.actor.actor.replace(/^user:/, '');
        if (!(await this.users.verifyTotpCode(username, input.stepUp.mfaCode.trim()))) {
          throw new ForbiddenException('STEP_UP_FAILED: 인증앱 코드(MFA) 불일치 또는 미등록');
        }
        assurance = 'MFA_STEPUP';
      } else {
        identityVerificationId = await this.stepUp(pending.displayName, pending.externalSignerRef, input.stepUp);
        assurance = 'STEP_UP';
      }
    }

    const ctx: ApprovalAuditCtx = {
      ...input.actor,
      step: pending.signOrder,
      opinion: input.opinion,
      assuranceLevel: assurance,
      identityVerificationId,
      decision: input.decision,
    };

    if (input.decision === 'REJECT') {
      // fail-closed: 인증로그 먼저 봉인(실패 시 반려 미확정) → 이후 봉투 종결
      await this.recordApprovalAudit(requestId, 'APPROVAL_REJECTED', ctx);
      await this.signSvc.withdraw(requestId, `반려(order ${pending.signOrder}): ${input.opinion ?? ''}`.trim());
      return { requestId, status: 'REJECTED', step: pending.signOrder, decision: 'REJECT' as const };
    }

    // 승인 — fail-closed: 인증로그 먼저 봉인(실패 시 서명 미수행) → 서명(submit)
    await this.recordApprovalAudit(requestId, 'APPROVAL_APPROVED', ctx);
    try {
      await this.signSvc.submit(pending.participantId); // signerType=APPROVER → INPERSON 신원·순서게이팅, SSO 불요
    } catch (e) {
      // 로그는 봉인됐으나 서명 실패(레이스 등) — 보정 엔트리로 체인에 사실 반영
      await this.recordApprovalAudit(requestId, 'APPROVAL_SIGN_FAILED', { ...ctx, opinion: (e as Error).message });
      throw e;
    }

    const after = await this.store.getRequest(requestId);
    if (after?.status === 'COMPLETED') await this.auditAnchor.anchor(this.approvalKey(requestId)); // 최종 결재 시점봉인(TSA)
    return { requestId, status: after?.status ?? request.status, step: pending.signOrder, decision: 'APPROVE' as const };
  }

  /** 결재 진행 상태 조회(결재선·현재단계·인증로그 건수). */
  async get(requestId: string) {
    this.assertEnabled();
    const dto = await this.signSvc.getRequest(requestId); // 404 throw
    if (dto.signMode !== APPROVAL_SIGN_MODE) throw new NotFoundException('결재 문서 아님');
    const meta = (await this.store.getMeta<ApprovalMeta>(this.metaKey(requestId))) ?? { highRisk: false };
    const log = await this.store.auditEntries(this.approvalKey(requestId));
    const current = [...dto.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
    return {
      ...dto,
      highRisk: !!meta.highRisk,
      docType: meta.docType ?? null,
      currentStep: current?.signOrder ?? null,
      currentApprover: current?.signerRole ?? null,
      authLogCount: log.length,
    };
  }

  /** (건별) 통합 인증로그 원본 엔트리 — 필터·CSV 는 컨트롤러(프레젠테이션)가 처리(admin-audit 패턴). */
  async authLogEntries(requestId: string): Promise<AuditEntry[]> {
    this.assertEnabled();
    await this.assertApproval(requestId);
    return this.store.auditEntries(this.approvalKey(requestId));
  }

  /**
   * (통합) 전체 결재 인증로그 — 모든 `approval:<id>` 스트림 병합, 최신순. requestId·title 부착.
   * 관리자 통합 감사 뷰용(건별 조회와 별개). 필터·페이지·CSV 는 컨트롤러가 처리.
   */
  async allAuthLogEntries(): Promise<Array<AuditEntry & { requestId: string; title: string | null }>> {
    this.assertEnabled();
    const keys = await this.store.auditKeys('approval:'); // approval:<id> 감사 스트림만(approval-meta 는 meta KV)
    const titles = new Map<string, string | null>();
    const out: Array<AuditEntry & { requestId: string; title: string | null }> = [];
    for (const key of keys) {
      const requestId = key.slice('approval:'.length);
      if (!titles.has(requestId)) titles.set(requestId, (await this.store.getRequest(requestId))?.title ?? null);
      const title = titles.get(requestId) ?? null;
      for (const e of await this.store.auditEntries(key)) out.push({ ...e, requestId, title });
    }
    out.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))); // 최신순
    return out;
  }

  /** 인증로그 무결성 검증(해시체인 + TSA 앵커). */
  async authLogVerify(requestId: string) {
    this.assertEnabled();
    await this.assertApproval(requestId);
    return this.auditAnchor.verify(this.approvalKey(requestId));
  }

  // ── 내부 ──

  private async assertApproval(requestId: string) {
    const r = await this.store.getRequest(requestId);
    if (!r || r.signMode !== APPROVAL_SIGN_MODE) throw new NotFoundException('결재 문서 없음');
  }

  /** step-up 본인확인 — IdentityProvider 로 재검증 후 신원 봉인. 실패/정보부족 시 403. */
  private async stepUp(name: string, subjectRef: string | undefined, cred?: ApprovalActInput['stepUp']): Promise<string> {
    const method = (cred?.method ?? 'PASS') as IdentityMethod;
    // 비대면 method 는 ci/phone 필요(대면 INPERSON 은 step-up 의미 없음 — 거부)
    if (method === 'INPERSON' || method === 'STAFF_SSO') {
      throw new ForbiddenException('STEP_UP_REQUIRED: 고위험/최종 결재는 비대면 본인확인(PASS 등) 필요');
    }
    if (!cred?.ci && !cred?.phone) {
      throw new ForbiddenException('STEP_UP_REQUIRED: 고위험/최종 결재 본인확인 정보(ci/phone) 필요');
    }
    const r = await this.identity.verify({ method, ci: cred.ci, phone: cred.phone, name, subjectRef });
    if (r.result !== 'SUCCESS') throw new ForbiddenException('STEP_UP_FAILED: 본인확인 실패');
    const record: StoredIdentity = {
      id: randomUUID(),
      subjectRef,
      method: r.method,
      provider: r.provider,
      providerTxId: r.providerTxId,
      verifiedName: r.verifiedName ?? name,
      ciHash: r.ciHash,
      phoneHash: r.phoneHash,
      result: 'SUCCESS',
      verifiedAt: r.verifiedAt,
    };
    await this.store.saveIdentity(record);
    return record.id;
  }

  /**
   * 통합 인증로그 봉인 — 본인확인 사실 + F008 접속기록을 한 엔트리에.
   * 실패 시 throw(fail-closed) — 결재는 이 봉인 성공을 전제로만 커밋된다.
   * data 형상은 auditToCsv(actor·actorRole·targetType·targetRef·system·ip·auth.method) 컬럼과 정합.
   */
  private async recordApprovalAudit(requestId: string, eventType: string, ctx: ApprovalAuditCtx): Promise<void> {
    const key = this.approvalKey(requestId);
    const data = {
      actor: ctx.actor,
      actorRole: ctx.actorRole,
      targetType: 'APPROVAL',
      targetRef: requestId,
      system: 'console',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      auth: { method: ctx.authMethod, assurance: ctx.assuranceLevel, identityVerificationId: ctx.identityVerificationId },
      step: ctx.step,
      decision: ctx.decision,
      opinion: ctx.opinion,
    };
    // 스트림 단위 직렬화 — 동시 결재 행위로 prevHash 가 겹쳐 체인이 끊기는 것 방지
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, data, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}

interface ApprovalMeta {
  highRisk: boolean;
  docType?: string | null;
  submittedBy?: string;
  line?: Array<{ approverId?: string; order: number }>;
}

interface ApprovalAuditCtx extends ApprovalActor {
  step: number;
  opinion?: string;
  assuranceLevel?: string;
  identityVerificationId?: string;
  decision?: 'APPROVE' | 'REJECT';
}
