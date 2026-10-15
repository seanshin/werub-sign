// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, BadRequestException, NotFoundException, ConflictException, ForbiddenException, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SignatureService } from './signature.service';
import { RevocationService } from './revocation.service';
import { AuditAnchorService } from './audit-anchor.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { WebhookOutboxService } from '../infrastructure/webhook/webhook-outbox.service';
import { PadesSignerService } from '../infrastructure/pades/pades-signer.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { RequestQuery, INCOMPLETE_STATUSES } from '../domain/request-query';
import { AlertService } from './alert.service';
import { toCsv } from '../domain/csv';
import { IDENTITY_PROVIDER, IdentityMethod, IdentityProvider, IdentityVerifyInput } from '../domain/ports/identity-provider.port';
import { StoredRequest, StoredParticipant, StoredIdentity } from '../domain/types/store.types';
import { validateCallbackUrl, isHardened, redactUrl } from '../infrastructure/security/hardening';
import { CaService } from '../infrastructure/pki/ca.service';
import { SignEventsService } from './events.service';
import { KeyedMutex } from '../domain/keyed-mutex';

interface IdentityPayload { method?: string; ci?: string; phone?: string; name?: string }
interface StaffSubmitClaims { sub: string; role?: string; employeeNumber?: string; acr?: string; name?: string }
type SubmitOpts = { staff?: StaffSubmitClaims; identity?: IdentityPayload };

export interface CreateRequestInput {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  signMode: string;
  callbackUrl?: string;
  createdBy?: string; // 생성 소비자명(가드에서 주입) — 소비자별 webhook 시크릿 분리
  ttlDays?: number; // 미서명 만료 기한(기본 30일)
  participants: Array<{
    signerRole: string;
    signerType: string;
    externalSignerRef?: string;
    displayName: string;
    signOrder: number;
    certSerial: string;
    requiredIdentityLevel?: string;
    relationship?: string; // PROXY
    onBehalfOf?: string; // PROXY
  }>;
}

/** C-2 문서 개정 재동의 입력 — 원본을 대체하는 새 버전. participants 미지정 시 원본 재사용. */
export interface SupersedeInput {
  idempotencyKey: string;
  documentHash: string; // 개정 문서 해시(필수)
  title?: string;
  externalDocId?: string;
  signMode?: string;
  callbackUrl?: string;
  createdBy?: string;
  ttlDays?: number;
  reason?: string;
  participants?: CreateRequestInput['participants'];
}

/**
 * 저장된 요청의 콜백 주소 재지정 입력(운영) — 연동처 수신 경로 변경 시 옛 주소를 일괄 정정.
 * `fromUrl` 은 부분일치(호스트+경로 조각), `dryRun` 미지정은 모의 실행.
 */
export interface CallbackRetargetInput {
  fromUrl: string;
  toUrl: string;
  statuses?: string[];
  dryRun?: boolean;
  limit?: number;
  actor?: string;
}

/**
 * 서명요청 유스케이스의 중심 — 생성·제출·검증·만료·개정이 전부 이 서비스를 지난다.
 * (design §4/§5/§14/§19.6)
 *
 * 한 요청의 생애주기:
 *   createRequest(멱등키) ─▶ CREATED
 *     └ submit(참가자별, 순서 강제) ─▶ IN_PROGRESS ─▶ 마지막 서명 시 COMPLETED
 *         ├ 본인확인(performIdentity) — requiredIdentityLevel 에 따라 PASS/step-up/SSO, 실패 시 서명 자체가 거부
 *         ├ CMS 서명 검증(SignatureService) — 서명 대상 = `documentHash|signerRole`(역할 바인딩,
 *         │   cmsContent 참조: 같은 서명값을 다른 역할로 재사용하는 치환 공격 차단)
 *         ├ 서명 시점 폐기 확인(RevocationService) — "지금 유효"가 아니라 "그때 유효"를 기록
 *         └ 감사 봉인(recordAudit) + 중간/완료 webhook + SSE
 *     ├ withdraw / supersede(C-2 개정 재동의 — 원본을 SUPERSEDED 로 대체) / expireOverdue(스케줄러)
 *     └ verify — 저장된 서명 전건을 공개키로 재검증 + 체인·앵커 확인(외부 공개 EP 의 실체)
 *
 * 완료 webhook 규약(연동 팀이 자주 묻는 것):
 *  - 완료 통지는 submit 처리 **도중** 발화된다 → 동기 발급 흐름에선 호출자가 requestId 를 저장하기 전에
 *    도착할 수 있으므로 상관키는 externalDocId 를 권장(README §7).
 *  - 시크릿은 소비자별 분리(webhookSecretFor) — createdBy(생성 소비자)에 따라 다른 HMAC 키.
 *  - setCompletionEnricher: 계약 트랙(ContractService)이 완료 payload 에 verifyToken 등을 덧붙이는 훅.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SignatureRequestService {
  private readonly log = new Logger(SignatureRequestService.name);
  // 요청 봉투(request)는 store 가 last-write-wins(deleteMany+create)라, 여러 await 를 가로지르는
  // 읽고-고쳐-쓰기(submit·withdraw·expire)가 겹치면 서명 유실·이중 완료 웹훅·EXPIRED 가 COMPLETED 를
  // 덮는 사고가 난다. 요청 단위로 직렬화해 임계구역 진입 후 항상 최신 상태를 다시 읽는다(단일 노드 전제).
  private readonly reqMutex = new KeyedMutex();
  constructor(
    private readonly sig: SignatureService,
    private readonly audit: AuditChainService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly revocation: RevocationService,
    private readonly webhook: WebhookOutboxService,
    private readonly config: ConfigService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly pades: PadesSignerService,
    private readonly auditAnchor: AuditAnchorService,
    private readonly ca: CaService,
    private readonly events: SignEventsService,
    private readonly alert: AlertService,
  ) {}

  /** CMS 서명 대상 콘텐츠 (문서해시 + 역할 바인딩) */
  private cmsContent(documentHash: string, signerRole: string): Buffer {
    return Buffer.from(`${documentHash}|${signerRole}`);
  }

  async createRequest(input: CreateRequestInput) {
    // 멱등 (conventions §6)
    const existingId = await this.store.getRequestIdByIdempotency(input.idempotencyKey);
    if (existingId) {
      const existing = await this.store.getRequest(existingId);
      if (existing) return this.toDto(existing);
    }

    // callbackUrl: 요청별 지정 없으면 전역 기본(HIS_WEBHOOK_URL) — facade 경로도 webhook 발화
    const callbackUrl = input.callbackUrl ?? this.config.get<string>('HIS_WEBHOOK_URL');
    // M1: callbackUrl SSRF 방어(운영 시 https+사설망 차단+allowlist)
    try {
      validateCallbackUrl(callbackUrl);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    // 안전장치 — 이 수신 주소로 이미 통지가 사망(DEAD)한 이력이 있으면 경고.
    // 호출자가 넘긴 callbackUrl 을 임의로 바꾸지는 않는다(연동 계약 존중) — 조기에 **인지시키는 것**이 목적이다.
    // 종전엔 log.warn 뿐이라 아무도 보지 않았다 → ①응답 warnings 로 호출자에게 ②운영 알림으로 운영자에게 밀어낸다.
    const warnings: string[] = [];
    const deadForTarget = await this.webhook.deadCountFor(callbackUrl).catch(() => 0);
    if (deadForTarget > 0) {
      // 로그·알림·호출자 응답에는 자격증명(userinfo·쿼리 토큰)을 뺀 주소만 싣는다. 판정·저장·재지정은 원본 사용.
      const safeUrl = redactUrl(callbackUrl);
      const head = `콜백 URL 주의 — 이 주소로 이미 실패 확정(DEAD)된 통지 ${deadForTarget}건: ${safeUrl}`;
      this.log.warn(`${head}. 수신 경로가 유효한지 확인하세요(정정 후 /v1/maintenance/webhook-redrive 로 재발송 가능).`);
      warnings.push(
        `${head}. 수신 경로가 유효한지 확인하세요 — 주소가 바뀌었다면 저장된 요청까지 정정해야 합니다` +
          '(POST /v1/maintenance/callback-retarget), 이미 사망한 통지는 POST /v1/maintenance/webhook-redrive 로 재발송합니다.',
      );
      // 알림은 **비차단** — SMTP 지연이 서명요청 생성 응답을 붙잡으면 안 된다(알림 실패가 본 기능을 막지 않는다는 S9 원칙).
      void this.alert
        .raise(
          `webhook-target-dead:${safeUrl}`,
          `실패 이력이 있는 콜백 주소로 신규 요청 생성 — ${safeUrl}`,
          `이 주소로는 이미 통지 ${deadForTarget}건이 재시도를 소진(DEAD)했는데 같은 주소로 새 요청이 생성되었습니다.\n` +
            `요청: ${input.externalDocId} (생성자: ${input.createdBy ?? '-'})\n\n` +
            '수신 경로가 바뀐 것이라면 두 가지를 모두 해야 합니다:\n' +
            '  ① 저장된 요청의 주소 정정 — POST /v1/maintenance/callback-retarget {fromUrl, toUrl, dryRun:true} 로 대상 확인 후 dryRun:false\n' +
            '  ② 이미 사망한 통지 재발송 — POST /v1/maintenance/webhook-redrive {targetUrl, newTargetUrl}\n\n' +
            '②만 하면 남은 요청이 만료·완료될 때마다 DEAD 가 다시 태어납니다.',
        )
        .catch(() => undefined);
    }

    // 참가자 인증서 존재 검증
    for (const p of input.participants) {
      if (!(await this.store.hasCertSerial(p.certSerial))) {
        throw new BadRequestException(`unknown certSerial: ${p.certSerial}`);
      }
    }

    const requestId = randomUUID();
    const participants: StoredParticipant[] = input.participants
      .map((p) => ({
        participantId: randomUUID(),
        status: 'PENDING' as const,
        ...p,
        requiredIdentityLevel: p.requiredIdentityLevel ?? (p.signerType === 'STAFF' ? 'STAFF_SSO' : 'INPERSON'),
      }))
      .sort((a, b) => a.signOrder - b.signOrder);

    const request: StoredRequest = {
      requestId,
      idempotencyKey: input.idempotencyKey,
      externalDocId: input.externalDocId,
      title: input.title,
      documentHash: input.documentHash,
      signMode: input.signMode,
      callbackUrl,
      createdBy: input.createdBy,
      status: 'CREATED',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (input.ttlDays ?? 30) * 86_400_000).toISOString(),
      requiredSigners: participants.length,
      completedSigners: 0,
      participants,
    };
    await this.store.saveRequest(request);
    await this.recordAudit(requestId, 'CREATED', 'SYSTEM', { externalDocId: input.externalDocId, signers: participants.length });
    this.events.emit('request.changed', { requestId, status: 'CREATED' });
    // warnings 는 있을 때만 실어 보낸다(빈 배열로 계약을 흐리지 않는다) — 생성 자체는 성공이다
    return warnings.length ? { ...this.toDto(request), warnings } : this.toDto(request);
  }

  /** 동의 철회 — 완료 전 요청 무효화(FR-13). 이후 서명·토큰 차단, Webhook 통지. */
  async withdraw(requestId: string, reason?: string) {
    // 요청 단위 직렬화 — 동시 철회의 이중 웹훅/감사, 그리고 진행 중 submit 이 철회를 되돌려 덮는 것을 막는다.
    return this.reqMutex.run(requestId, async () => {
      const request = await this.store.getRequest(requestId);
      if (!request) throw new NotFoundException('request not found');
      if (request.status === 'COMPLETED') throw new ConflictException('completed request cannot be withdrawn');
      if (request.status !== 'WITHDRAWN') {
        request.status = 'WITHDRAWN';
        await this.store.saveRequest(request);
        await this.recordAudit(requestId, 'WITHDRAWN', 'SYSTEM', { reason: reason ?? null });
        await this.fireStatusWebhook(request, 'request.withdrawn');
        this.events.emit('request.changed', { requestId, status: 'WITHDRAWN' });
      }
      return { requestId, status: request.status };
    });
  }

  /**
   * C-2 문서 개정 재동의(supersede) — 동의서 내용 변경 시 원본을 새 버전으로 대체.
   * 원본: status=SUPERSEDED·supersededBy=신규(현행 아님, 기존 서명·LTV·감사는 보존). 신규: supersedes=원본·version+1.
   * 참가자 미지정 시 원본 재사용(certSerial 유효성은 createRequest가 재검증). request.superseded webhook 으로 HIS 미러.
   */
  async supersede(originalId: string, input: SupersedeInput) {
    // 원본 단위 직렬화 — 서로 다른 idempotencyKey 로 동시 개정 시 이중 개정본(하나는 고아)이 생기는 것을 막는다.
    return this.reqMutex.run(originalId, () => this.supersedeLocked(originalId, input));
  }

  private async supersedeLocked(originalId: string, input: SupersedeInput) {
    const original = await this.store.getRequest(originalId);
    if (!original) throw new NotFoundException('원본 요청 없음');
    if (original.supersededBy) {
      // 멱등: 동일 idempotencyKey 재시도면 기존 개정본 반환, 다른 키면 이미 개정됨(최신본을 개정)
      const existing = await this.store.getRequestIdByIdempotency(input.idempotencyKey);
      const head = await this.store.getRequest(original.supersededBy);
      if (existing && existing === original.supersededBy && head) return this.toDto(head);
      throw new ConflictException(`이미 개정됨 — 최신본(${original.supersededBy})을 개정하세요`);
    }
    if (original.status === 'WITHDRAWN') throw new ConflictException('철회된 요청은 개정할 수 없습니다');

    const participants = input.participants ?? original.participants.map((p) => ({
      signerRole: p.signerRole, signerType: p.signerType, externalSignerRef: p.externalSignerRef,
      displayName: p.displayName, signOrder: p.signOrder, certSerial: p.certSerial,
      requiredIdentityLevel: p.requiredIdentityLevel, relationship: p.relationship, onBehalfOf: p.onBehalfOf,
    }));

    const created = await this.createRequest({
      idempotencyKey: input.idempotencyKey,
      externalDocId: input.externalDocId ?? original.externalDocId,
      title: input.title ?? original.title,
      documentHash: input.documentHash,
      signMode: input.signMode ?? original.signMode,
      callbackUrl: input.callbackUrl ?? original.callbackUrl,
      createdBy: input.createdBy ?? original.createdBy,
      ttlDays: input.ttlDays,
      participants,
    });

    // 멱등 재호출 시 createRequest 가 기존 요청을 반환 — 이미 링크됐으면 그대로 반환
    if (created.requestId === original.supersededBy) return created;

    const newReq = await this.store.getRequest(created.requestId);
    if (newReq && !newReq.supersedes) {
      newReq.supersedes = originalId;
      newReq.version = (original.version ?? 1) + 1;
      await this.store.saveRequest(newReq);
      await this.recordAudit(created.requestId, 'CREATED_AS_REVISION', 'SYSTEM', { supersedes: originalId, version: newReq.version });
    }

    original.supersededBy = created.requestId;
    original.status = 'SUPERSEDED'; // 현행 아님(기존 서명/LTV/감사 무결성은 verify 로 계속 검증 가능)
    await this.store.saveRequest(original);
    await this.recordAudit(originalId, 'SUPERSEDED', 'SYSTEM', { supersededBy: created.requestId, reason: input.reason ?? null });
    await this.fireStatusWebhook(original, 'request.superseded', { supersededBy: created.requestId });
    this.events.emit('request.changed', { requestId: originalId, status: 'SUPERSEDED' });

    return this.toDto(newReq ?? original);
  }

  /** 만료 배치 — 기한 경과 미완료 요청을 EXPIRED 처리(FR-13). 크론/HIS 스케줄러가 주기 호출. */
  async expireOverdue(now = Date.now()): Promise<{ expired: number; requestIds: string[] }> {
    const all = await this.store.allRequests();
    const requestIds: string[] = [];
    for (const cand of all) {
      if (!((cand.status === 'CREATED' || cand.status === 'IN_PROGRESS') && cand.expiresAt && now > Date.parse(cand.expiresAt))) continue;
      // 후보는 스냅샷 기준이다. 실제 만료 기록은 요청 단위 직렬화 후 **최신 상태를 다시 읽어** 판정한다 —
      // 그 사이 서명 완료/철회된 요청을 EXPIRED 로 덮거나, 겹친 만료 실행이 이중 통지하는 것을 막는다.
      const done = await this.reqMutex.run(cand.requestId, async () => {
        const r = await this.store.getRequest(cand.requestId);
        if (!r) return false;
        if (!((r.status === 'CREATED' || r.status === 'IN_PROGRESS') && r.expiresAt && now > Date.parse(r.expiresAt))) return false;
        r.status = 'EXPIRED';
        await this.store.saveRequest(r);
        await this.recordAudit(r.requestId, 'EXPIRED', 'SYSTEM', { reason: 'batch', expiresAt: r.expiresAt });
        await this.fireStatusWebhook(r, 'request.expired');
        this.events.emit('request.changed', { requestId: r.requestId, status: 'EXPIRED' });
        return true;
      });
      if (done) requestIds.push(cand.requestId);
    }
    return { expired: requestIds.length, requestIds };
  }

  /**
   * 저장된 요청의 `callbackUrl` 재지정 — 연동처가 수신 경로를 바꿨을 때 **아직 발화하지 않은 통지**를 구제한다.
   *
   * 왜 필요한가(2026-08-08 사고): 웹훅의 `targetUrl` 은 **요청 생성 시점의 callbackUrl 사본**이다.
   * 연동처가 수신 경로를 고쳐도 그 이전에 만들어진 요청에는 옛 주소가 그대로 박혀 있어서,
   * 그 요청이 완료·만료될 때마다 새 DEAD 가 하나씩 태어난다. DEAD 재발송(webhook-redrive)은
   * **이미 태어난 것**만 되살리므로 근본은 여기서 끊어야 한다 — 두 조치는 짝이다.
   * (지원 API 가 없어 운영 DB 에 직접 UPDATE 를 날려야 했던 경로를 대체한다.)
   *
   * 안전장치:
   *  - `dryRun` 이 **기본값** — 대상을 세어 본 뒤 `dryRun:false` 로 실행한다(대량 변경이므로).
   *  - `toUrl` 은 생성 때와 동일한 SSRF 검증을 통과해야 한다(DB 직접 수정에는 없던 방어).
   *  - 대상 상태 기본값은 CREATED·IN_PROGRESS — 종결 요청은 통지가 이미 끝나 고칠 이유가 없다.
   *  - 요청별 감사 스트림에 `CALLBACK_RETARGETED`(옛 주소·새 주소·처리자) 봉인.
   *
   * 이미 만들어진 통지 레코드는 건드리지 않는다 — 응답의 `deliveries` 로 잔여를 알리고,
   * 그쪽은 `webhook-redrive`(DEAD) / `webhook-retry`(PENDING·FAILED) 가 담당한다.
   */
  async retargetCallbacks(input: CallbackRetargetInput) {
    const { fromUrl, toUrl } = input;
    if (fromUrl === toUrl) throw new BadRequestException('fromUrl 과 toUrl 이 같습니다');
    try {
      validateCallbackUrl(toUrl);
    } catch (e) {
      throw new BadRequestException(`toUrl 검증 실패: ${(e as Error).message}`);
    }

    const dryRun = input.dryRun !== false; // 미지정 = 모의 실행(안전 기본값)
    const statuses = [...new Set(input.statuses?.length ? input.statuses : INCOMPLETE_STATUSES)];
    const limit = Math.max(1, Math.min(5000, input.limit ?? 500));
    const actor = input.actor ?? '-';
    const samples: Array<{ requestId: string; status: string; title: string; callbackUrl: string }> = [];
    const BATCH = 500;
    let matched = 0;
    let updated = 0;

    for (const status of statuses) {
      let offset = 0;
      for (;;) {
        // 상태로 푸시다운 후 주소만 메모리 판정 — callbackUrl 은 질의 조건이 아니므로 갱신해도 페이지가 밀리지 않는다
        const { items, total } = await this.store.queryRequests({ status, limit: BATCH, offset });
        for (const r of items) {
          const current = r.callbackUrl;
          if (!current || !current.includes(fromUrl)) continue;
          matched++;
          if (samples.length < 20) samples.push({ requestId: r.requestId, status: r.status, title: r.title, callbackUrl: current });
          if (dryRun || updated >= limit) continue;
          r.callbackUrl = toUrl;
          await this.store.saveRequest(r);
          await this.recordAudit(r.requestId, 'CALLBACK_RETARGETED', 'OPERATOR', { actor, from: current, to: toUrl });
          updated++;
        }
        offset += items.length;
        if (items.length < BATCH || offset >= total) break;
      }
    }

    const deliveries = await this.webhook.openCountsFor(fromUrl); // 옛 주소를 물고 있는 기존 통지(별도 조치 대상)
    this.log.log(
      `callbackUrl 재지정${dryRun ? '(모의)' : ''} — 대상 ${matched}건 / 적용 ${updated}건 · ${fromUrl} → ${toUrl} · 처리자=${actor}`,
    );
    return {
      dryRun,
      statuses,
      matched,
      updated,
      limit,
      truncated: !dryRun && matched > updated, // 상한에 걸려 남은 대상 — 같은 호출을 반복하면 이어서 처리된다
      fromUrl,
      toUrl,
      deliveries, // { pending, dead } — 이미 생성된 통지는 redrive/retry 로 별도 처리
      samples,
    };
  }

  /** 상태 변경 Webhook (철회/만료 등) */
  private async fireStatusWebhook(request: StoredRequest, eventType: string, extra?: Record<string, unknown>): Promise<void> {
    if (!request.callbackUrl) return;
    const secret = this.webhookSecretFor(request);
    if (!secret) return; // 운영 시크릿 미설정 — 약한 dev-secret 서명 차단
    await this.webhook.enqueueAndDeliver({
      requestId: request.requestId,
      eventType,
      targetUrl: request.callbackUrl,
      secret,
      secretEnv: this.webhookSecretEnvFor(request),
      payload: { requestId: request.requestId, signatureRequestId: request.requestId, externalDocId: request.externalDocId, status: request.status, auditCertUri: this.auditCertUri(request.requestId), occurredAt: new Date().toISOString(), ...(extra ?? {}) },
    });
  }

  /** 서명 제출 — signOrder 채널무관 전역 게이팅(§19.6) + 본인확인 강결합(§15) */
  async submit(participantId: string, opts?: SubmitOpts) {
    const found = await this.findParticipant(participantId);
    if (!found) throw new NotFoundException('participant not found');
    // 요청 단위 직렬화 — 병렬 서명(같은/다른 참가자)이 봉투를 서로 덮어 서명 유실·이중 완료되는 것을 막는다.
    // 임계구역 진입 후 봉투를 다시 읽어 최신 상태 위에서 판정·기록한다(스냅샷 clobber 방지).
    return this.reqMutex.run(found.request.requestId, () => this.submitLocked(participantId, opts));
  }

  private async submitLocked(participantId: string, opts?: SubmitOpts) {
    const found = await this.findParticipant(participantId);
    if (!found) throw new NotFoundException('participant not found');
    const { request, participant } = found;

    if (participant.status === 'SIGNED') throw new ConflictException('ALREADY_SIGNED');
    if (request.status === 'COMPLETED' || request.status === 'EXPIRED' || request.status === 'WITHDRAWN' || request.status === 'SUPERSEDED') {
      throw new ConflictException(`request closed (${request.status})`);
    }
    // 만료 기한 경과 시 지연 만료 처리 후 차단 — 배치 만료와 동일하게 통지(webhook·SSE)해야
    // 연동(HIS/ERP)이 EXPIRED 를 인지한다. 종전엔 통지 없이 상태만 바꿔 "무통지 전이"였다(배치는 EXPIRED 를 건너뜀).
    if (request.expiresAt && Date.now() > Date.parse(request.expiresAt)) {
      request.status = 'EXPIRED';
      await this.store.saveRequest(request);
      await this.recordAudit(request.requestId, 'EXPIRED', 'SYSTEM', { reason: 'ttl', expiresAt: request.expiresAt });
      await this.fireStatusWebhook(request, 'request.expired');
      this.events.emit('request.changed', { requestId: request.requestId, status: 'EXPIRED' });
      throw new ConflictException('request expired');
    }

    // STAFF 참가자는 SSO 검증(staff-token) 경유만 허용 (§19.2)
    if (participant.signerType === 'STAFF') {
      const staff = opts?.staff;
      if (!staff?.sub) throw new ConflictException('STAFF must sign via /v1/sign/staff (SSO)');
      // 명의도용 방지: 토큰 주체(sub)가 지정 서명자(externalSignerRef)와 일치해야 함
      if (participant.externalSignerRef && participant.externalSignerRef !== staff.sub) {
        throw new ForbiddenException('STAFF_BINDING_MISMATCH: 토큰 주체가 지정 서명자와 불일치');
      }
      // 권한(role) allow-list — HIS_SSO_ALLOWED_ROLES 설정 시 강제(예: DOCTOR)
      const allowed = this.config.get<string>('HIS_SSO_ALLOWED_ROLES');
      if (allowed && (!staff.role || !allowed.split(',').map((r) => r.trim()).includes(staff.role))) {
        throw new ForbiddenException(`STAFF_ROLE_DENIED: ${staff.role ?? 'none'}`);
      }
    }

    // 폐기/중단 인증서로 신규 서명 차단 (FR-19) + 서명시점 OCSP 상태(LTV 봉인용)
    const ocsp = await this.revocation.ocsp(participant.certSerial);
    if (ocsp.status === 'REVOKED') throw new ConflictException('signer certificate is REVOKED');
    if (ocsp.status === 'SUSPENDED') throw new ConflictException('signer certificate is SUSPENDED');

    // 순서 게이팅: 앞 순번 미서명 시 거부
    const blocking = request.participants.find((p) => p.signOrder < participant.signOrder && p.status !== 'SIGNED');
    if (blocking) throw new ConflictException(`out-of-order: waiting for ${blocking.signerRole}(order ${blocking.signOrder})`);

    const stored = await this.store.getCertBySerial(participant.certSerial);
    if (!stored) throw new BadRequestException('signer cert missing');

    // 본인확인 수행·강결합 (§15) — 서명 직전, 실패 시 차단
    const identityId = await this.performIdentity(request.requestId, participant, opts);

    const result = await this.sig.sign({
      documentHash: request.documentHash,
      signerRole: participant.signerRole,
      cert: stored.cert,
      ocspStatus: ocsp.status,
    });

    // 동시성 가드(H3) — 직전 인터리빙으로 이미 서명된 경우 중복 서명 차단(레이스 좁힘)
    const existing = await this.store.signaturesByRequest(request.requestId);
    if (existing.some((s) => s.participantId === participantId)) throw new ConflictException('ALREADY_SIGNED');

    const signatureId = randomUUID();
    const signedAt = new Date().toISOString();
    const identityRecord = await this.store.getIdentity(identityId);
    // 실 CMS(CAdES-BES) detached 서명 — 표준화 (X.509 + PKCS#7)
    const cmsSignature = stored.x509Serial
      ? this.pades.signCms(stored.x509Serial, this.cmsContent(request.documentHash, participant.signerRole)) ?? undefined
      : undefined;
    await this.store.saveSignature({
      signatureId,
      requestId: request.requestId,
      participantId,
      certSerial: participant.certSerial,
      signerRole: participant.signerRole,
      result,
      cmsSignature,
      x509Serial: stored.x509Serial,
      identityVerificationId: identityId,
      identityMethod: identityRecord?.method ?? 'UNKNOWN',
      signerType: participant.signerType,
      relationship: participant.relationship,
      onBehalfOf: participant.onBehalfOf,
      signedAt,
    });
    participant.status = 'SIGNED';
    // 실제 서명된 참가자 수로 재계산(H3) — 중복 증가/조기 COMPLETED 방지(멱등)
    request.completedSigners = request.participants.filter((p) => p.status === 'SIGNED').length;
    await this.recordAudit(request.requestId, 'SIGNED', participant.signerType, {
      role: participant.signerRole,
      cert: participant.certSerial,
      relationship: participant.relationship, // PROXY 대리 관계 봉인(해시체인+TSA앵커)
      onBehalfOf: participant.onBehalfOf,
    });

    if (request.completedSigners >= request.requiredSigners) {
      request.status = 'COMPLETED';
      await this.recordAudit(request.requestId, 'COMPLETED', 'SYSTEM', { signers: request.completedSigners });
      await this.auditAnchor.anchor(request.requestId); // 감사 체인 head TSA 봉인(§16)
    } else if (request.status === 'CREATED') {
      request.status = 'IN_PROGRESS';
    }
    await this.store.saveRequest(request);

    if (request.status === 'COMPLETED') await this.fireCompletedWebhook(request);
    else await this.fireSignerCompletedWebhook(request, participant, signedAt).catch((e) => this.log.warn(`signer_completed 웹훅 실패(무시): ${(e as Error).message}`));
    this.events.emit('request.changed', { requestId: request.requestId, status: request.status });
    return { signatureId, signedAt, requestStatus: request.status, timestamp: result.timestamp.genTime };
  }

  /**
   * 소비자별 outbound webhook 서명 시크릿 — 소비자 간 시크릿 격리(ERP가 HIS 시크릿 미공유).
   * 매핑: erp→ERP_WEBHOOK_SECRET, 그 외(hospitalrun·console·pacs…)→HIS_WEBHOOK_SECRET.
   * 전용 시크릿 미설정 시 HIS_WEBHOOK_SECRET 폴백(하위호환). 운영(하드닝) 미설정이면 dev-secret 서명 차단.
   */
  /**
   * 소비자별 webhook 서명 시크릿의 **환경변수 이름** — `<소비자>_WEBHOOK_SECRET` 규칙(erp→ERP_, edu→EDU_ …).
   * 수신 측이 자기 시크릿으로 HMAC 를 검증하므로 소비자마다 분리돼야 한다(미설정 시 HIS 폴백).
   */
  private webhookSecretEnvFor(request: StoredRequest): string {
    const key = (request.createdBy ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const envName = key ? `${key}_WEBHOOK_SECRET` : 'HIS_WEBHOOK_SECRET';
    if (this.config.get<string>(envName)) return envName;
    // 공개판: HIS 시크릿 폴백은 HIS 계열(hospitalrun · console · pacs)만 — 다른 소비자는 자기 시크릿이 있어야 서명한다
    return ['', 'HOSPITALRUN', 'CONSOLE', 'PACS'].includes(key) ? 'HIS_WEBHOOK_SECRET' : envName;
  }

  private webhookSecretFor(request: StoredRequest): string | null {
    const secret = this.config.get<string>(this.webhookSecretEnvFor(request));
    return secret ?? (isHardened() ? null : 'dev-secret');
  }

  /**
   * 완료 웹훅 페이로드 보강기(R2) — 계약 트랙이 `verifyToken`·`verifyUrl` 등을 주입한다.
   * ContractService 가 SignatureRequestService 를 의존하므로 역방향 주입 대신 setter 로 등록(순환 회피).
   */
  private completionEnricher?: (request: StoredRequest) => Promise<Record<string, unknown>>;
  setCompletionEnricher(fn: (request: StoredRequest) => Promise<Record<string, unknown>>): void {
    this.completionEnricher = fn;
  }

  /**
   * 중간 서명 통지(R1) — 다자 서명에서 **한 명이 서명했지만 아직 미완료**일 때 발화.
   * 수신 측이 "다음 차례" 를 알 수 있어야 진행 표시·독촉·알림이 가능하다(순차 계약에서 특히 필요).
   */
  private async fireSignerCompletedWebhook(request: StoredRequest, signed: { participantId: string; signOrder: number; signerType: string; certSerial: string }, signedAt: string): Promise<void> {
    if (!request.callbackUrl) return;
    const secret = this.webhookSecretFor(request);
    if (!secret) return;
    const ordered = [...request.participants].sort((a, b) => a.signOrder - b.signOrder);
    const next = ordered.find((p) => p.status !== 'SIGNED');
    await this.webhook.enqueueAndDeliver({
      requestId: request.requestId,
      eventType: 'request.signer_completed',
      targetUrl: request.callbackUrl,
      secret,
      secretEnv: this.webhookSecretEnvFor(request),
      payload: {
        requestId: request.requestId,
        signatureRequestId: request.requestId,
        externalDocId: request.externalDocId,
        status: request.status, // IN_PROGRESS
        completedSigners: request.completedSigners,
        requiredSigners: request.requiredSigners,
        signer: {
          participantId: signed.participantId,
          order: signed.signOrder,
          signerType: signed.signerType,
          certSerial: signed.certSerial,
          signedAt,
        },
        nextSigner: next
          ? {
              participantId: next.participantId,
              order: next.signOrder,
              signerType: next.signerType,
              displayName: next.displayName,
              externalSignerRef: next.externalSignerRef, // 계약=이메일, 직원=토큰 sub
            }
          : null,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  /** 완료 시 Hospital RUN으로 Webhook (FR-08) */
  private async fireCompletedWebhook(request: StoredRequest): Promise<void> {
    if (!request.callbackUrl) return;
    const secret = this.webhookSecretFor(request);
    if (!secret) return; // 운영 시크릿 미설정 — 약한 dev-secret 서명 차단
    // A2/A3: 서명별 키 수탁(custody)·attestation·TSA 토큰 동봉 — HIS가 "HSM 보호 서명" 봉인 기록(additive)
    const sigs = await this.store.signaturesByRequest(request.requestId);
    const signatures = await Promise.all(
      sigs.map(async (s) => {
        const c = await this.store.getCertBySerial(s.certSerial);
        const keyCustody = c?.cert.keyRef?.startsWith('hsm:') ? 'HSM' : 'SOFT';
        // 직원/환자 식별자 — HIS가 user.signCertSerial(직원)·consentForm.signCertSerial 미러 매핑용
        const p = request.participants.find((pp) => pp.certSerial === s.certSerial);
        return {
          certSerial: s.certSerial,
          signerType: s.signerType,
          signerRole: p?.signerRole ?? s.signerRole,
          externalSignerRef: p?.externalSignerRef, // STAFF=토큰 sub / 환자=HIS ref (직원·환자 매핑 키)
          keyCustody,
          signAttestationRef: keyCustody === 'HSM' ? c?.cert.keyRef : undefined,
          signedAt: s.signedAt,
          tsaProvider: s.result.timestamp.tsaProvider,
          tsaGenTime: s.result.timestamp.genTime,
          tsaToken: s.result.timestamp.token, // RFC3161-유사 시점 토큰(증거 봉인용)
        };
      }),
    );
    const custodies = [...new Set(signatures.map((a) => a.keyCustody))];
    const keyCustody = custodies.length === 1 ? custodies[0] : 'MIXED';
    // 트랙별 보강(R2) — 실패해도 완료 통지 자체는 보낸다(best-effort)
    let extra: Record<string, unknown> = {};
    if (this.completionEnricher) {
      extra = await this.completionEnricher(request).catch((e) => {
        this.log.warn(`완료 웹훅 보강 실패(무시): ${(e as Error).message}`);
        return {};
      });
    }
    await this.webhook.enqueueAndDeliver({
      requestId: request.requestId,
      eventType: 'request.completed',
      targetUrl: request.callbackUrl,
      secret,
      secretEnv: this.webhookSecretEnvFor(request),
      payload: {
        requestId: request.requestId,
        signatureRequestId: request.requestId, // HIS 계약 키 별칭
        externalDocId: request.externalDocId,
        status: 'COMPLETED',
        verifiedHash: request.documentHash,
        signCertSerial: request.participants[0]?.certSerial,
        signCertSerials: request.participants.map((p) => p.certSerial),
        auditCertUri: this.auditCertUri(request.requestId),
        keyCustody, // 말단(서명)키 수탁 (SOFT|HSM|MIXED)
        ...this.ca.attestation(), // caKeyCustody·caKeyCustodyProvider·assuranceLevel — HSM 보호 트러스트 근거
        signatures, // 서명별 custody·tsaToken (A2/A3)
        ...extra, // 계약 트랙 보강(R2) — verifyToken·verifyUrl 등
        occurredAt: new Date().toISOString(),
      },
    });
  }

  private publicBase(): string {
    return (this.config.get<string>('PUBLIC_BASE_URL') ?? 'https://sign.example.org').replace(/\/$/, '');
  }
  private auditCertUri(requestId: string): string {
    return `${this.publicBase()}/v1/requests/${requestId}/audit-certificate`;
  }

  /** 검증 — 공개키 실제 서명 + TSA + 체인 + 만료 + 폐기(서명시점) (§5.2/§11) */
  async verify(requestId: string) {
    const request = await this.store.getRequest(requestId);
    if (!request) throw new NotFoundException('request not found');

    const sigs = await this.store.signaturesByRequest(requestId);
    const results = await Promise.all(
      sigs.map(async (s) => {
        const stored = await this.store.getCertBySerial(s.certSerial);
        const sigInput = { documentHash: request.documentHash, signerRole: s.signerRole, cert: stored!.cert };
        const keyCustody = stored?.cert.keyRef?.startsWith('hsm:') ? 'HSM' : 'SOFT';
        const v = this.sig.verify(sigInput, s.result);
        const notRevoked = await this.revocation.notRevokedAt(s.certSerial, s.result.timestamp.genTime);
        const ltv = this.sig.verifyLtv(sigInput, s.result); // 만료 무관 장기검증 (§10)
        // 실 CMS(CAdES-BES) 검증 — 표준 서명코어
        const cms = s.cmsSignature && s.x509Serial
          ? this.pades.verifyCms(s.cmsSignature, this.cmsContent(request.documentHash, s.signerRole), s.x509Serial)
          : null;
        const valid = v.cryptoOk && v.timestampValid && v.chainValid && v.notExpired && notRevoked;
        return {
          signerRole: s.signerRole,
          signerType: s.signerType,
          relationship: s.relationship, // PROXY 대리 서명 관계
          onBehalfOf: s.onBehalfOf,
          certSerial: s.certSerial,
          identityMethod: s.identityMethod,
          keyCustody, // 말단(서명)키 수탁: SOFT|HSM
          cryptoVerify: v.cryptoOk,
          timestampValid: v.timestampValid,
          chainValid: v.chainValid,
          notExpired: v.notExpired,
          notRevoked,
          ltvValid: ltv.ltvValid,
          cmsValid: cms?.valid ?? false,
          format: cms ? 'CAdES-BES (PKCS#7)' : s.result.ltv?.format,
          valid,
        };
      }),
    );

    const chain = this.audit.verify(await this.store.auditEntries(requestId));
    return {
      requestId,
      status: request.status,
      documentIntegrity: 'VALID',
      auditChainValid: chain.valid,
      ...this.ca.attestation(), // caKeyCustody·caKeyCustodyProvider·assuranceLevel — HSM 보호 트러스트 근거
      signatures: results,
      overall: results.length > 0 && results.every((r) => r.valid) && chain.valid,
    };
  }

  async getRequest(requestId: string) {
    const r = await this.store.getRequest(requestId);
    if (!r) throw new NotFoundException('request not found');
    return this.toDto(r);
  }

  /** Webhook 전송 현황(reconcile 조회) */
  async webhooksOf(requestId: string) {
    return this.store.webhooksByRequest(requestId);
  }

  /**
   * 관리자 콘솔용 요청 목록 페이지 — 검색(제목·문서ID·요청ID·참가자명)·상태·기간 필터 + 최신순 + 페이지.
   * 저장소(queryRequests)가 DB 레벨로 필터/정렬/페이지/카운트를 처리(대시보드 확장성). total=필터 후 전체 수.
   */
  async listRequestsPage(query: RequestQuery) {
    const { items, total } = await this.store.queryRequests(query);
    const offset = Math.min(query.offset, total);
    return { data: items.map((r) => this.toDto(r)), page: { total, limit: query.limit ?? total, offset } };
  }

  /** 요청 목록 CSV(심사·보존) — 동일 필터 전체, 배치 페이징(전체 메모리 비적재). CI·연락처 미포함. */
  async exportRequestsCsv(filter: Omit<RequestQuery, 'limit' | 'offset'>): Promise<string> {
    const headers = ['요청ID', '상태', '제목', '문서ID', '서명모드', '생성일', '만료일', '필요서명자', '완료서명자', '참가자'];
    const rows: Array<Array<unknown>> = [];
    const BATCH = 500;
    let offset = 0;
    for (;;) {
      const { items, total } = await this.store.queryRequests({ ...filter, limit: BATCH, offset });
      for (const r of items) {
        const d = this.toDto(r);
        rows.push([d.requestId, d.status, d.title, d.externalDocId, d.signMode, d.createdAt ?? '', d.expiresAt ?? '', d.requiredSigners, d.completedSigners, d.participants.map((p) => `${p.displayName ?? ''}(${p.signerRole})`).join('; ')]);
      }
      offset += items.length;
      if (items.length < BATCH || offset >= total) break;
    }
    return toCsv(headers, rows);
  }

  async auditTrail(requestId: string) {
    return this.store.auditEntries(requestId);
  }

  /** 감사 무결성 검증 (해시체인 + TSA 앵커) — FR-21 */
  async auditVerify(requestId: string) {
    return this.auditAnchor.verify(requestId);
  }

  // ── 내부 ──
  private async findParticipant(participantId: string) {
    // participants 배열 JSON 조건으로 소속 요청만 DB 에서 직접 조회 — 종전엔 서명 제출마다 전량 스캔했다(F1).
    const request = await this.store.getRequestByParticipant(participantId);
    if (!request) return null;
    const participant = request.participants.find((p) => p.participantId === participantId);
    return participant ? { request, participant } : null;
  }

  /** 본인확인 수행·기록 (§15) — 실패 시 IDENTITY_FAILED 감사 후 차단 */
  private async performIdentity(
    requestId: string,
    participant: StoredParticipant,
    opts?: SubmitOpts,
  ): Promise<string> {
    const input = this.resolveIdentityInput(participant, opts);
    const r = await this.identity.verify(input);

    if (r.result === 'FAIL') {
      await this.recordAudit(requestId, 'IDENTITY_FAILED', participant.signerType, {
        role: participant.signerRole,
        method: input.method,
      });
      throw new ForbiddenException(`IDENTITY_REQUIRED: 본인확인 실패(${input.method})`);
    }

    const staff = opts?.staff;
    const record: StoredIdentity = {
      id: randomUUID(),
      subjectRef: input.subjectRef,
      method: r.method,
      provider: r.provider,
      providerTxId: r.providerTxId,
      verifiedName: r.verifiedName ?? staff?.name,
      ciHash: r.ciHash,
      phoneHash: r.phoneHash,
      result: 'SUCCESS',
      verifiedAt: r.verifiedAt,
      role: staff?.role,
      employeeNumber: staff?.employeeNumber,
      acr: staff?.acr,
    };
    await this.store.saveIdentity(record);
    await this.recordAudit(requestId, 'IDENTITY_VERIFIED', participant.signerType, {
      role: participant.signerRole,
      method: r.method,
      staffRole: staff?.role,
      employeeNumber: staff?.employeeNumber,
      acr: staff?.acr,
    });
    return record.id;
  }

  private resolveIdentityInput(
    participant: StoredParticipant,
    opts?: SubmitOpts,
  ): IdentityVerifyInput {
    if (participant.signerType === 'STAFF') {
      return { method: 'STAFF_SSO', subjectRef: opts?.staff?.sub, name: opts?.staff?.name ?? participant.displayName };
    }
    const level = participant.requiredIdentityLevel;
    if (level === 'INPERSON' || level === 'NONE') {
      return { method: 'INPERSON', name: participant.displayName, subjectRef: participant.externalSignerRef };
    }
    // 비대면: MOBILE_NAME / PASS / APP_STEPUP — 본인확인 정보 필요
    const payload = opts?.identity;
    if (!payload || (!payload.ci && !payload.phone)) {
      throw new ForbiddenException(`IDENTITY_REQUIRED: ${level} 비대면 본인확인 정보(ci/phone) 필요`);
    }
    const method = (level === 'APP_STEPUP' ? payload.method ?? 'PASS' : level) as IdentityMethod;
    return {
      method,
      ci: payload.ci,
      phone: payload.phone,
      name: payload.name ?? participant.displayName,
      subjectRef: participant.externalSignerRef,
    };
  }

  private async recordAudit(requestId: string, eventType: string, actorType: string, data: unknown) {
    // 동시 서명(PARALLEL)·webhook 재시도 등 동시 append 직렬화
    await this.audit.appendSerialized(requestId, async () => {
      const prev = await this.store.lastAudit(requestId);
      const entry = this.audit.next(prev, eventType, { actorType, ...((data as object) ?? {}) }, new Date().toISOString());
      await this.store.appendAudit(requestId, entry);
    });
  }

  private toDto(r: StoredRequest) {
    return {
      requestId: r.requestId,
      status: r.status,
      title: r.title,
      externalDocId: r.externalDocId,
      signMode: r.signMode,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      version: r.version ?? 1,
      supersedes: r.supersedes,
      supersededBy: r.supersededBy,
      requiredSigners: r.requiredSigners,
      completedSigners: r.completedSigners,
      participants: r.participants.map((p) => ({
        participantId: p.participantId,
        signerRole: p.signerRole,
        signerType: p.signerType,
        displayName: p.displayName,
        requiredIdentityLevel: p.requiredIdentityLevel,
        certSerial: p.certSerial,
        signOrder: p.signOrder,
        status: p.status,
      })),
    };
  }
}
