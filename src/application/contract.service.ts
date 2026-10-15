// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFIER, Notifier } from '../domain/ports/notifier.port';
import { SecretBox, SealedSecret } from '../infrastructure/crypto/secret-box';
import { SignatureRequestService } from './signature-request.service';
import { EnrollCertificateService } from './enroll-certificate.service';
import { NotifyService } from './notify.service';
import { AdminUserService } from '../infrastructure/auth/admin-user.service';
import { PatientTokenService } from './patient-token.service';
import { PortalDocumentService } from './portal-document.service';
import { IntegrationSettingsService } from './integration-settings.service';
import { ContractAddressbookService } from './contract-addressbook.service';
import { PlacedMark, FieldValueType } from './contract-template.service';
import { PDFDocument, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import * as QRCode from 'qrcode';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { AuditAnchorService } from './audit-anchor.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { StoredRequest } from '../domain/types/store.types';
import { maskEmail } from '../domain/mask';
import { KeyedMutex } from '../domain/keyed-mutex';
import { retryOnConflict } from '../domain/optimistic-retry';
import { canonicalJson } from '../domain/canonical-json';
import { StoreConflictError } from '../domain/store-conflict.error';

/**
 * 일반 전자계약(행정·일반 계약) 트랙 — design docs/02-design/features/general-contracts.design.md (v0.1).
 *
 * 준비(PDF 업로드)→발송(이메일+접근암호)→체결(내부 콘솔 서명 + 외부 포털 서명)→관리.
 * 봉투 = 다자 순차서명(SignatureRequest signMode=CONTRACT) 재사용 — 순서게이팅·TSA·verify 무상속.
 * 환자 동의서 경로(HIS 연동·해시-only)와 별개 트랙(D1). 원본은 계약 트랙 한정 영구 암호화 보관(D4).
 *
 * 감사 = 전용 스트림 `contract:<requestId>`(approval:<id> 동형) — 생성·발송·unlock 성공/실패·서명.
 * 피처플래그 `GENERAL_CONTRACTS` 기본 OFF(미설정 시 EP 404).
 */

/** 계약 행위 주체 — 서버(세션/기계키)가 도출, 요청 본문 신원 주장 불신(approval과 동일 원칙). */
export interface ContractActor {
  actor: string; // `user:<username>` | `consumer:<name>` | `his:<ref>`
  actorRole?: string;
  authMethod: string; // CONSOLE_SESSION | MACHINE_KEY
  ip?: string;
  userAgent?: string;
}

export interface ContractSignerInput {
  kind: 'INTERNAL' | 'EXTERNAL';
  displayName: string;
  order: number;
  signerRole?: string;
  username?: string; // INTERNAL — 콘솔 계정(서명 시 세션 주체와 바인딩)
  email?: string; // EXTERNAL — 발송 수신·바인딩 참조
  certSerial?: string;
}

export interface CreateContractInput {
  idempotencyKey: string;
  externalDocId: string;
  title: string;
  documentHash: string;
  callbackUrl?: string;
  ttlDays?: number;
  labels?: string[];
  category?: string; // 계약 분류(근로·용역·구매·임대차·보안·협약 등) — 완료 계약 카테고리별 관리
  accessCode?: string; // 외부 서명자 포털 접근암호(선택) — scrypt 해시만 보관
  signingMode?: 'SEQUENTIAL' | 'PARALLEL'; // 순차(기본, 순서 게이팅) | 동시(전원 병렬 — 봉투 order 전원 1)
  signMarks?: PlacedMark[]; // 서명란 좌표(서명자 순번별)
  signers: ContractSignerInput[];
  actor: ContractActor;
}

interface ContractMeta {
  labels: string[];
  category?: string; // 계약 분류(단일). 미지정 시 '기타'
  createdBy: string; // actor 문자열
  hasAccessCode: boolean;
  accessCode?: { salt: string; hash: string }; // scryptSync(code, salt, 64) hex
  parties: Array<{ email: string; displayName: string; order: number }>; // EXTERNAL 서명자(발송 대상)
  internalNotify?: Array<{ username: string; displayName: string; order: number; email?: string }>; // INTERNAL 서명자 알림 이메일(선택) — 미지정 시 계정 등록 이메일 fallback
  lastBaseUrl?: string; // 마지막 발송의 포털 링크 prefix — 자동 리마인더·완료 교부의 링크 기준(P3)
  lastSentAt?: string; // 최초/최근 발송 시각(ISO) — 첨부 불변 정책(발송 후 변경 차단, 설계 §11) 판정
  signingMode?: 'SEQUENTIAL' | 'PARALLEL'; // 동시(PARALLEL)=봉투 signOrder 전원 1(상호 비차단), 표시 순서는 parties/입력 순 유지
  archived?: boolean; // 보관 처리(계약함 목록 숨김) — 데이터·서명·감사는 보존, 제거 행위는 감사 스트림 기록
  archivedAt?: string; // ISO
  archivedBy?: string; // actor 문자열
  archiveReason?: string;
  signMarks?: PlacedMark[]; // 서명란 좌표(서명자 순번별) — 서명 완료 시 손글씨 이미지 합성 위치
  tokenInvalidBefore?: Record<string, string>; // 참가자별 링크 무효화 시점(R4 수신처 정정) — 이전 발급 토큰 거부
  verifyToken?: string; // 완료문서 검증 QR 토큰(영구) — 공개 검증 페이지 링크
  internalNotified?: string[]; // 콘솔 서명요청 이메일을 이미 보낸 내부 서명자 participantId(중복 알림 방지)
  externalNotified?: string[]; // 포털 링크를 이미 보낸 외부 서명자 participantId(순차 auto-advance 중복 방지)
}

/** 손글씨 서명 이미지 — 암호화 봉인(csign:<requestId>:<participantId>). PKI가 법적효력, 이미지는 행위 증거. */
interface StoredSignatureImage {
  sealed: SealedSecret; // AES-256-GCM(PNG/JPEG 바이트)
  contentType: string;
  sha256: string; // hex
  via: string; // PORTAL | CONSOLE
  drawnAt: string; // ISO
}

/** 완료문서 교부 토큰 — 만료형(기본 72h), 외부 서명자 이메일별 발급(ctdeliver:<token>). */
interface DeliveryToken {
  requestId: string;
  email: string;
  expiresAt: string; // ISO
  extendedAt?: string; // 수신자 자가 연장 시각 — **1회 한정**(재연장 409)
  forwardCount?: number; // 다른 주소로 전달한 횟수(상한 DELIVERY_FORWARD_MAX)
  forwardedFrom?: string; // 전달로 생성된 링크의 출처 토큰 접두(추적용)
}

const CONTRACT_SIGN_MODE = 'CONTRACT';
const DELIVERY_FORWARD_MAX = 3; // 교부 링크당 다른 주소로 전달 가능 횟수(남용 방지)
const UNLOCK_MAX_FAILS = 5; // 접근암호 연속 오류 허용 횟수 — 초과 시 계약 단위 잠금(무차별 대입 방지, IP 레이트리밋과 별개)
const UNLOCK_LOCK_MS = 10 * 60_000; // 잠금 시간(10분) — 만료 시 카운터 리셋
const INTERNAL_SIGNER_TYPE = 'INTERNAL'; // STAFF 아님 → submit 의 SSO 게이트 우회(콘솔 세션 서명), 바인딩은 sign() 이 강제
const EXTERNAL_SIGNER_TYPE = 'EXTERNAL_PARTY'; // 본인확인 = 이메일 링크 소유 + 접근암호(포털 unlock 게이트, D3)
/** 입력란(FIELD) 타입별 기재값 길이 상한 — 포털/내부 폼 maxLength 와 서버 검증의 단일 정의 */
const FILTER_BACKFILL_FLAG = 'contract-filter-cols:v1'; // 목록 필터 캐시 백필 완료 표시(부팅 1회)
const FIELD_MAX_LEN: Record<FieldValueType, number> = { text: 200, date: 10, money: 20, number: 20 };
const FIELD_MAX_SIZE = 11; // 기재값 합성 최대 폰트(pt)
const FIELD_MIN_SIZE = 6; // 최소 폰트 — 이보다 작아지느니 말줄임
const FIELD_LINE_RATIO = 1.25; // 줄 높이 배율


@Injectable()
export class ContractService implements OnModuleInit {
  private readonly log = new Logger('Contract');
  private readonly box = new SecretBox(process.env.CRYPTO_MASTER_KEY); // 손글씨 서명 이미지 암호화 저장
  // 계약별 경합 직렬화 — unlock 실패 카운터(무차별 대입 잠금)·완료 후처리(anchor/교부 1회 보장)
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly signSvc: SignatureRequestService,
    private readonly enroll: EnrollCertificateService,
    private readonly notify: NotifyService,
    private readonly tokens: PatientTokenService,
    private readonly docs: PortalDocumentService,
    private readonly audit: AuditChainService,
    private readonly auditAnchor: AuditAnchorService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    private readonly settings: IntegrationSettingsService,
    private readonly addressbook: ContractAddressbookService,
    private readonly adminUsers: AdminUserService,
    private readonly config: ConfigService,
  ) {}

  /** 기능 활성 여부 — 기본 OFF. `GENERAL_CONTRACTS=on|true` 로 활성. */
  enabled(): boolean {
    const v = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }
  private assertEnabled() {
    if (!this.enabled()) throw new NotFoundException('일반 전자계약 기능 비활성');
  }

  private contractKey(requestId: string): string {
    return `contract:${requestId}`;
  }
  private metaKey(requestId: string): string {
    return `contract-meta:${requestId}`;
  }

  /**
   * 목록 필터 캐시 동기화(A3) — 보관/분류/라벨을 봉투(StoredRequest.ct*)에 복사해 저장소가
   * DB 레벨로 필터·페이지·집계하도록. 정본은 contract-meta — 보관/재분류 시 반드시 함께 호출.
   * (봉투 재저장은 서명 경합과 이론상 겹칠 수 있으나 보관/분류는 운영 행위라 실충돌 희박 — 기존 saveRequest 패턴과 동일 수준.)
   */
  private async syncFilterCols(requestId: string, meta: ContractMeta): Promise<void> {
    const r = await this.store.getRequest(requestId);
    if (!r) return;
    r.ctArchived = !!meta.archived;
    r.ctCategory = meta.category ?? '기타';
    r.ctLabels = meta.labels ?? [];
    await this.store.saveRequest(r);
  }

  /** 봉투 필터 캐시가 meta(정본)와 일치하는지 — 백필 자가 치유 판정. */
  private filterColsInSync(r: { ctArchived?: boolean; ctCategory?: string; ctLabels?: string[] }, meta: ContractMeta): boolean {
    return (
      r.ctArchived === !!meta.archived &&
      r.ctCategory === (meta.category ?? '기타') &&
      JSON.stringify(r.ctLabels ?? []) === JSON.stringify(meta.labels ?? [])
    );
  }

  /**
   * 계약 meta 갱신 — 계약 단위 잠금 안에서 **최신 meta 를 재조회**한 뒤 필드 단위로 갱신한다(R2).
   * 진입 시점 스냅샷을 통째로 저장하면 그 사이 완료된 보관·재분류가 되돌아가, meta 는 비보관인데
   * 캐시는 보관인 "복원 불가 유령 계약"이 만들어진다.
   * 필터 캐시(ct*)도 같은 잠금 안에서 동기화하고, **실패 시 meta 를 되돌려** divergence 를 남기지 않는다(R1).
   *
   * 잠금은 인프로세스라 다중 노드에서는 두 프로세스가 같은 meta 를 읽을 수 있다 — 그래서 기록은
   * **버전 일치 CAS**로 하고, 경합하면 최신 meta 로 `mutate` 를 다시 돌린다(R16).
   * ⚠ `mutate` 는 재실행될 수 있다 — 바깥 변수를 쓰는 콜백은 진입 시 그 변수를 초기화할 것.
   */
  private async updateMeta(requestId: string, mutate: (meta: ContractMeta) => ContractMeta): Promise<ContractMeta> {
    const key = this.metaKey(requestId);
    return this.mutex.run(`meta:${requestId}`, () =>
      retryOnConflict(async () => {
        const { value: before, version } = await this.store.getMetaVersioned<ContractMeta>(key);
        if (!before) throw new NotFoundException('계약 없음');
        const next = mutate({ ...before });
        if (!(await this.store.saveMetaIfUnchanged(key, version, next))) {
          throw new StoreConflictError(`contract meta ${requestId}`);
        }
        try {
          await this.syncFilterCols(requestId, next);
        } catch (e) {
          // 정본 롤백 — 캐시와 어긋난 채 남기지 않는다(R1).
          // 단 **내가 쓴 값이 그대로일 때만** 되돌린다(그 사이 다른 노드가 갱신했다면 그쪽이 최신).
          // ⚠ 비교는 반드시 canonicalJson — PostgreSQL JSONB 는 키 순서를 보존하지 않아
          //    재조회한 값을 그냥 JSON.stringify 하면 **항상 불일치**로 판정돼 롤백이 죽는다
          //    (인메모리/파일 어댑터에서는 통과해 테스트로도 안 잡힌다).
          const cur = await this.store.getMetaVersioned<ContractMeta>(key);
          if (canonicalJson(cur.value) === canonicalJson(next)) {
            await this.store.saveMetaIfUnchanged(key, cur.version, before);
          }
          throw e;
        }
        return next;
      }),
    );
  }

  /** 레거시 계약 백필(A3, 부팅 1회) — 필터 캐시 미보유 봉투에 meta 값 동기화. best-effort. */
  async onModuleInit(): Promise<void> {
    // 완료 웹훅 보강(R2) — 계약 트랙 완료 통지에 공개 검증 토큰·링크를 함께 실어 보낸다.
    // (플래그와 무관하게 등록 — 등록만으로는 동작 변화 없음)
    this.signSvc.setCompletionEnricher(async (request) => {
      if (request.signMode !== CONTRACT_SIGN_MODE) return {};
      await this.ensureVerifyTokenAtCompletion(request.requestId); // 아직 미발급이면 여기서 발급(멱등)
      const meta = await this.store.getMeta<ContractMeta>(this.metaKey(request.requestId));
      if (!meta?.verifyToken) return {}; // 접근암호 계약 등 — 공개 검증 미발급
      const base = (meta.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL') ?? '').replace(/\/$/, '');
      return {
        verifyToken: meta.verifyToken,
        ...(base ? { verifyUrl: `${base}/contracts/verify/${meta.verifyToken}` } : {}),
      };
    });
    if (!this.enabled()) return;
    const FLAG = FILTER_BACKFILL_FLAG;
    try {
      if (await this.store.getMeta<{ at: string }>(FLAG)) return;
      // 페이지 반복 — 단발 상한(10k)으로 끊고 완료 플래그를 쓰면 초과분이 영구 미백필로 남는다(R8).
      const PAGE = 1000;
      const MAX_SCAN = 100_000; // 폭주 방지 상한 — 초과 시 플래그를 쓰지 않고 다음 부팅에 재개
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      let n = 0;
      let complete = true;
      while (offset < total) {
        const page = await this.store.queryRequests({ signMode: CONTRACT_SIGN_MODE, offset, limit: PAGE });
        total = page.total;
        if (!page.items.length) break;
        for (const r of page.items) {
          const meta = await this.store.getMeta<ContractMeta>(this.metaKey(r.requestId));
          if (!meta) continue;
          if (this.filterColsInSync(r, meta)) continue; // 값 비교 — 미보유(레거시)뿐 아니라 어긋난 캐시도 치유
          await this.syncFilterCols(r.requestId, meta);
          n++;
        }
        offset += page.items.length;
        if (offset >= MAX_SCAN) { complete = false; break; }
      }
      if (complete) await this.store.saveMeta(FLAG, { at: new Date().toISOString(), backfilled: n });
      else this.log.warn(`계약 필터 캐시 백필 미완주(${offset}/${total}) — 다음 부팅에 재개`);
      if (n) this.log.log(`계약 목록 필터 캐시 백필 — ${n}건 동기화(A3)`);
    } catch (e) {
      this.log.warn(`계약 필터 캐시 백필 실패(다음 부팅 재시도): ${(e as Error).message}`);
    }
  }

  /** 계약 생성 — 서명자열(내부/외부)로 계약 봉투 생성. 멱등(idempotencyKey). 발송은 send() 별도. */
  async create(input: CreateContractInput) {
    this.assertEnabled();
    if (!input.signers.length) throw new ConflictException('서명자(signers)가 비어 있음');
    for (const s of input.signers) {
      if (s.kind === 'INTERNAL' && !s.username) throw new ConflictException('내부 서명자는 username 필요');
      if (s.kind === 'EXTERNAL' && !s.email) throw new ConflictException('외부 서명자는 email 필요');
    }

    // 멱등 선차단 — 이미 존재하면 인증서 재발급/재기록 없이 반환
    const existingId = await this.store.getRequestIdByIdempotency(input.idempotencyKey);
    if (existingId) return this.get(existingId);

    // 서명자 구성 — certSerial 미지정 시 서버 자동발급(내부=STAFF, 외부=WITNESS 임시 인증서, H-3 패턴)
    const sorted = [...input.signers].sort((a, b) => a.order - b.order);
    const participants = [];
    for (const s of sorted) {
      let certSerial = s.certSerial;
      if (!certSerial) {
        const enrolled =
          s.kind === 'INTERNAL'
            ? await this.enroll.enroll({ ownerType: 'STAFF', subjectDn: `CN=${s.displayName || s.username}`, ownerRef: s.username, licenseNumber: s.username })
            : await this.enroll.enroll({ ownerType: 'WITNESS', subjectDn: `CN=${s.displayName}`, ownerRef: s.email });
        certSerial = enrolled.serialNumber;
      }
      participants.push({
        signerRole: s.signerRole ?? (s.kind === 'INTERNAL' ? 'INTERNAL' : 'PARTY'),
        signerType: s.kind === 'INTERNAL' ? INTERNAL_SIGNER_TYPE : EXTERNAL_SIGNER_TYPE,
        externalSignerRef: s.kind === 'INTERNAL' ? s.username : s.email,
        displayName: s.displayName,
        // 동시(PARALLEL) = 전원 signOrder 1 → 순서 게이팅 상호 비차단(엔진 무수정), 표시 순서는 meta 로 유지
        signOrder: input.signingMode === 'PARALLEL' ? 1 : s.order,
        certSerial,
        // 내부=콘솔 세션 인증 근거(INPERSON). 외부=이메일 링크+접근암호가 신원 게이트(NONE→INPERSON 기록, D3).
        requiredIdentityLevel: s.kind === 'INTERNAL' ? 'INPERSON' : 'NONE',
      });
    }

    const dto = await this.signSvc.createRequest({
      idempotencyKey: input.idempotencyKey,
      externalDocId: input.externalDocId,
      title: input.title,
      documentHash: input.documentHash,
      signMode: CONTRACT_SIGN_MODE,
      callbackUrl: input.callbackUrl,
      createdBy: 'console',
      ttlDays: input.ttlDays,
      participants,
    });

    // 멱등 재생성(동일 키): createRequest 가 기존 봉투 반환 — meta 존재 시 재기록 금지
    const mk = this.metaKey(dto.requestId);
    if (await this.store.getMeta<ContractMeta>(mk)) return this.get(dto.requestId);

    const meta: ContractMeta = {
      labels: input.labels ?? [],
      category: input.category?.trim() || '기타',
      createdBy: input.actor.actor,
      hasAccessCode: !!input.accessCode,
      signingMode: input.signingMode ?? 'SEQUENTIAL',
      parties: sorted.filter((s) => s.kind === 'EXTERNAL').map((s) => ({ email: s.email!, displayName: s.displayName, order: s.order })),
      internalNotify: sorted.filter((s) => s.kind === 'INTERNAL').map((s) => ({ username: s.username!, displayName: s.displayName, order: s.order, email: s.email?.trim().toLowerCase() || undefined })),
      // 서명란(SIGN)=손글씨 합성 위치, 입력란(FIELD)=fill-at-signing 기재 배정·합성 위치(A4)
      signMarks: (input.signMarks ?? []).filter((m) => m.type === 'SIGN' || m.type === 'FIELD'),
    };
    if (input.accessCode) {
      const salt = randomBytes(16).toString('hex');
      meta.accessCode = { salt, hash: scryptSync(input.accessCode, salt, 64).toString('hex') };
    }
    await this.store.saveMeta(mk, meta);
    // 목록 필터 캐시(A3) — 봉투 행에 보관/분류/라벨 동기화. 1회 재시도 후에도 실패하면 캐시는 NULL 로 남는데,
    // NULL 은 비보관·'기타' 로 해석되므로 목록에서 사라지지 않는다(부팅 백필이 값 비교로 치유).
    try {
      await this.syncFilterCols(dto.requestId, meta);
    } catch {
      await this.syncFilterCols(dto.requestId, meta).catch(async (e) => {
        this.log.warn(`필터 캐시 동기화 실패(${dto.requestId}) — 다음 부팅 백필에서 치유: ${(e as Error).message}`);
        // 완료 플래그를 지워 다음 부팅의 백필(값 비교 자가 치유)이 다시 돌게 한다
        await this.store.deleteMeta(FILTER_BACKFILL_FLAG).catch(() => undefined);
      });
    }
    await this.recordContractAudit(dto.requestId, 'CONTRACT_CREATED', {
      ...input.actor,
      signers: participants.map((p) => ({ order: p.signOrder, type: p.signerType })),
      hasAccessCode: meta.hasAccessCode,
    });
    return this.get(dto.requestId);
  }

  /** 발송/재발송(독촉) — 외부 미서명자에게 포털 토큰 발급 + 이메일(EMAIL 채널) 전송. */
  async send(requestId: string, baseUrl: string, actor: ContractActor, remind = false) {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') {
      throw new ConflictException(`종결된 계약(${request.status})은 발송할 수 없음`);
    }
    // baseUrl 검증·정규화 — 환경 고정 시 클라 입력 무시(피싱 링크/QR 주입 차단), 아니면 http(s) 형식 검증
    const safeBase = this.safeBaseUrl(baseUrl);
    if (baseUrl && !safeBase) throw new BadRequestException('발송 baseUrl 형식 오류(http/https 절대 URL)');
    // 순차(SEQUENTIAL)는 현재 차례 외부 서명자에게만 포털 링크 발급(순번 前 열람 차단). 동시(PARALLEL)는 전원.
    const dueExt = this.dueExternal(request.participants, (meta.signingMode ?? 'SEQUENTIAL') === 'PARALLEL');
    const recipients = dueExt.map((p) => {
      const party = meta.parties.find((x) => x.email === p.externalSignerRef);
      return { participantId: p.participantId, to: party?.email ?? p.externalSignerRef!, channel: 'EMAIL' as const };
    });
    const hasInternalUnsigned = request.participants.some((p) => p.signerType === INTERNAL_SIGNER_TYPE && p.status !== 'SIGNED');
    if (!recipients.length && !hasInternalUnsigned) throw new ConflictException('발송 대상(미서명자)이 없음');

    // 콘솔/포털 base 저장 — 내부 알림 콘솔 링크·자동 리마인더·교부·auto-advance 기준
    if (safeBase) meta.lastBaseUrl = safeBase;

    // 첨부 불변 정책의 기준점(lastSentAt)을 **메일 발송 전에** 먼저 기록 — 발송 중 첨부가 추가·삭제되면
    // 서명자가 받은 링크의 첨부 집합이 달라진다(R10). 전량 실패 시에는 아래에서 되돌린다.
    const sentAt = new Date().toISOString();
    const firstSend = !meta.lastSentAt;
    await this.updateMeta(requestId, (m) => ({ ...m, lastBaseUrl: meta.lastBaseUrl, lastSentAt: sentAt }));
    meta.lastSentAt = sentAt;

    let out: Awaited<ReturnType<NotifyService['notifyRequest']>> = [];
    if (recipients.length) {
      out = await this.notify.notifyRequest(requestId, meta.lastBaseUrl ?? '', recipients);
      meta.externalNotified = Array.from(new Set([...(meta.externalNotified ?? []), ...dueExt.map((p) => p.participantId)]));
      // 발송한 수신 이메일을 주소록에 자동 학습(best-effort, 최초 발송만)
      if (!remind) for (const p of dueExt) {
        const party = meta.parties.find((x) => x.email === p.externalSignerRef);
        if (party?.email) await this.addressbook.learn(party.email, party.displayName);
      }
    }
    // 최신 meta 재조회 후 필드 단위 갱신 — 발송 처리 중 완료된 보관·재분류를 되돌리지 않는다(R2)
    const notifiedNow = meta.externalNotified;
    const allFailed = recipients.length > 0 && out.every((o) => o.result !== 'SENT');
    await this.updateMeta(requestId, (m) => ({
      ...m,
      externalNotified: notifiedNow,
      // 최초 발송이 전량 실패면 첨부 잠금을 풀어 준다(발송된 적 없는 계약을 영구히 고정하지 않도록)
      ...(allFailed && firstSend ? { lastSentAt: undefined } : {}),
    }));
    if (allFailed && firstSend) meta.lastSentAt = undefined;
    await this.recordContractAudit(requestId, remind ? 'CONTRACT_REMINDED' : 'CONTRACT_SENT', { ...actor, recipients: out.length });
    // 현재 차례가 된 내부 서명자에게 콘솔 서명 요청 이메일(best-effort). 독촉(remind)은 강제 재발송.
    await this.notifyDueInternalSigners(requestId, remind);
    return out;
  }

  /** 현재 발송 대상 외부 서명자 — 순차=현재 pending 이 외부면 그 1명, 동시=미서명 외부 전원. */
  private dueExternal<T extends { participantId: string; signerType: string; status: string; signOrder: number; externalSignerRef?: string }>(participants: T[], parallel: boolean): T[] {
    const unsigned = participants.filter((p) => p.signerType === EXTERNAL_SIGNER_TYPE && p.status !== 'SIGNED');
    if (parallel) return unsigned;
    const pending = [...participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
    return pending && pending.signerType === EXTERNAL_SIGNER_TYPE ? [pending] : [];
  }

  /**
   * 순차 auto-advance — 앞 서명자 완료로 외부 서명자 차례가 되면 그 서명자에게 포털 링크 자동 발송(best-effort).
   * 이미 보낸 외부(externalNotified)는 재발송 안 함. 미발송 계약(base 없음)은 건너뜀(관리자 최초 발송 전).
   */
  private async notifyDueExternalSigners(requestId: string): Promise<void> {
    try {
      const { request, meta } = await this.assertContract(requestId);
      const base = meta.lastBaseUrl;
      if (!base) return;
      if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') return;
      const already = new Set(meta.externalNotified ?? []);
      const due = this.dueExternal(request.participants, (meta.signingMode ?? 'SEQUENTIAL') === 'PARALLEL').filter((p) => !already.has(p.participantId));
      if (!due.length) return;
      const recipients = due.map((p) => {
        const party = meta.parties.find((x) => x.email === p.externalSignerRef);
        return { participantId: p.participantId, to: party?.email ?? p.externalSignerRef!, channel: 'EMAIL' as const };
      });
      await this.notify.notifyRequest(requestId, base, recipients);
      const dueIds = due.map((p) => p.participantId);
      await this.updateMeta(requestId, (m) => ({ ...m, externalNotified: Array.from(new Set([...(m.externalNotified ?? []), ...dueIds])) }));
      await this.recordContractAudit(requestId, 'CONTRACT_SENT', { actor: 'system:auto-advance', recipients: recipients.length });
    } catch (e) {
      this.log.warn(`외부 서명자 auto-advance 발송 실패(무시): ${(e as Error).message}`);
    }
  }

  /** 발송/QR 링크용 base URL 정규화 — 환경 고정값 우선(클라 입력 무시), 없으면 http(s) 절대 URL 만 허용. */
  private safeBaseUrl(base?: string): string | undefined {
    const env = this.config.get<string>('CONTRACT_PORTAL_BASE_URL');
    if (env) return env.replace(/\/$/, ''); // 운영: 환경 고정 → 클라 baseUrl 주입 차단
    if (!base) return undefined;
    try {
      const u = new URL(base);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
      return base.replace(/\/$/, '');
    } catch { return undefined; }
  }

  /** 계약 현황(위젯·현황 화면) — 상태별 건수 + 만료 임박(7일 이내 미완료). */
  async stats() {
    this.assertEnabled();
    // A3: 보관 여부는 봉투 필터 캐시(ctArchived) — 행별 meta 조회 없이 단일 스캔 집계.
    // 스캔 상한 10k(초과 시 경고) — 상태별 count 쿼리 분리는 expiringSoon(만료 임박) 계산 때문에 보류.
    const horizon = Date.now() + 7 * 86_400_000;
    let total = 0, created = 0, inProgress = 0, completed = 0, expiringSoon = 0, archived = 0;
    // 페이지 반복 집계 — 단발 10k 상한은 초과 기관에서 **부정확한 수치를 확정값처럼** 반환했다(R5).
    for (const r of await this.scanAllContracts()) {
      if (r.ctArchived === true) { archived++; continue; }
      total++;
      if (r.status === 'CREATED') created++;
      else if (r.status === 'IN_PROGRESS') inProgress++;
      else if (r.status === 'COMPLETED') completed++;
      if ((r.status === 'CREATED' || r.status === 'IN_PROGRESS') && r.expiresAt && Date.parse(r.expiresAt) > Date.now() && Date.parse(r.expiresAt) <= horizon) expiringSoon++;
    }
    return { total, created, inProgress, completed, open: created + inProgress, expiringSoon, archived };
  }

  /** 리마인더·발송 정책 상태(알림·리마인더 화면) — 읽기 전용(변경은 env, U-후속에서 설정 스토어 검토). */
  async reminderStatus() {
    this.assertEnabled();
    const eff = await this.settings.effective('notifier').catch(() => null);
    const provider = (eff?.provider as string | undefined) ?? this.config.get<string>('NOTIFIER_PROVIDER') ?? 'mock';
    const smtpConfigured = !!(eff?.fields?.smtpUrl ?? this.config.get<string>('SMTP_URL'));
    return {
      remindAfterDays: Number(this.config.get<string>('CONTRACT_REMIND_AFTER_DAYS') ?? 3),
      expiryWarningHours: 24,
      deliveryTtlHours: Math.max(1, Number(this.config.get<string>('CONTRACT_DELIVERY_TTL_HOURS') ?? 72)),
      schedulerMin: Math.max(0.02, Number(this.config.get<string>('SCHEDULER_CONTRACT_MIN') ?? 60)),
      provider, // mock=실발송 없음(개발) / smtp=원내 메일서버
      smtpConfigured,
      portalBaseUrlSet: !!this.config.get<string>('CONTRACT_PORTAL_BASE_URL'),
    };
  }

  /** 계약 이력(contract:<id> 감사 스트림) — 생성·발송·독촉·만료경고·unlock·서명·교부. */
  async logEntries(requestId: string) {
    this.assertEnabled();
    await this.assertContract(requestId);
    return this.store.auditEntries(this.contractKey(requestId));
  }

  /** 계약 이력 무결성(체인·TSA 앵커). */
  async logVerify(requestId: string) {
    this.assertEnabled();
    await this.assertContract(requestId);
    return this.auditAnchor.verify(this.contractKey(requestId));
  }

  /**
   * 자동 리마인더(스케줄러) — 외부 서명 대기 계약의 미서명 독촉 + 만료 임박(24h) 경고(1회).
   *  - 독촉: 마지막 이메일 발송 후 CONTRACT_REMIND_AFTER_DAYS(기본 3, 0=끔) 경과 시 재발송.
   *  - 최초 발송 전(초안)은 제외. 링크 기준 = 마지막 발송 baseUrl > env CONTRACT_PORTAL_BASE_URL.
   */
  async autoRemind(): Promise<{ reminded: number; expiryWarned: number; skipped: number }> {
    if (!this.enabled()) return { reminded: 0, expiryWarned: 0, skipped: 0 };
    const afterDays = Number(this.config.get<string>('CONTRACT_REMIND_AFTER_DAYS') ?? 3);
    const sysActor: ContractActor = { actor: 'system:scheduler', authMethod: 'SCHEDULER' };
    // 미완료 전량 — 단발 500건(최신순)은 **가장 오래 방치된 계약**부터 독촉 대상에서 빠졌다(R6)
    const items = await this.scanAllContracts({ incomplete: true });
    let reminded = 0, expiryWarned = 0, skipped = 0;
    for (const r of items) {
      try {
        const pending = [...r.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
        if (!pending || pending.signerType !== EXTERNAL_SIGNER_TYPE) continue; // 내부 차례·완료는 대상 아님
        const meta = await this.store.getMeta<ContractMeta>(this.metaKey(r.requestId));
        const baseUrl = meta?.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL');
        const emails = (await this.store.notifyByRequest(r.requestId)).filter((n) => n.channel === 'EMAIL');
        if (!baseUrl || emails.length === 0) { skipped++; continue; } // 최초 발송 전 초안·링크 기준 부재
        // 만료 임박 경고 — 24h 이내, 계약당 1회
        const msLeft = r.expiresAt ? Date.parse(r.expiresAt) - Date.now() : Number.POSITIVE_INFINITY;
        if (msLeft > 0 && msLeft <= 24 * 3_600_000) {
          const entries = await this.store.auditEntries(this.contractKey(r.requestId));
          if (!entries.some((e) => e.eventType === 'CONTRACT_EXPIRY_WARNING')) {
            // 순번 게이팅 준수 — 아직 차례가 아닌 서명자에게 포털 토큰을 발급하면 순번 前 열람이 뚫린다(send·auto-advance 와 정합).
            const recipients = this.dueExternal(r.participants, (meta?.signingMode ?? 'SEQUENTIAL') === 'PARALLEL')
              .map((p) => ({ participantId: p.participantId, to: p.externalSignerRef!, channel: 'EMAIL' as const }));
            if (recipients.length === 0) continue; // 현재 차례가 외부 서명자가 아님 — 경고 대상 없음
            await this.notify.notifyRequest(r.requestId, baseUrl, recipients);
            await this.recordContractAudit(r.requestId, 'CONTRACT_EXPIRY_WARNING', { ...sysActor });
            expiryWarned++;
            continue; // 같은 주기 중복 발송 방지
          }
        }
        // 미서명 독촉 — 마지막 발송 후 N일 경과
        if (afterDays > 0) {
          const lastSent = Math.max(...emails.map((n) => Date.parse(n.sentAt)));
          if (Date.now() - lastSent >= afterDays * 86_400_000) {
            await this.send(r.requestId, baseUrl, sysActor, true);
            reminded++;
          }
        }
      } catch (e) {
        this.log.warn(`자동 리마인더 실패(${r.requestId}): ${(e as Error).message}`);
        skipped++;
      }
    }
    return { reminded, expiryWarned, skipped };
  }

  // ── 완료문서 교부(만료형 다운로드 링크) ─────────────────────────────────────

  private deliveryTtlMs(): number {
    return Math.max(1, Number(this.config.get<string>('CONTRACT_DELIVERY_TTL_HOURS') ?? 72)) * 3_600_000;
  }

  /** 교부 — 체결 완료 계약의 외부 서명자별 만료형 다운로드 링크 발급 + 이메일. 재호출 = 링크 재발급. */
  async deliver(requestId: string, actor: ContractActor): Promise<Array<{ email: string; url: string; expiresAt: string }>> {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    if (request.status !== 'COMPLETED') throw new ConflictException(`체결 완료(COMPLETED) 후 교부 가능 (현재 ${request.status})`);
    const baseUrl = meta.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL');
    if (!baseUrl) throw new ConflictException('교부 링크 기준 URL 없음 — 발송 이력 또는 CONTRACT_PORTAL_BASE_URL 필요');
    if (!meta.parties.length) throw new ConflictException('외부 서명자(교부 대상)가 없음');

    const links = [];
    for (const party of meta.parties) {
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + this.deliveryTtlMs()).toISOString();
      const rec: DeliveryToken = { requestId, email: party.email, expiresAt };
      await this.store.saveMeta('ctdeliver:' + token, rec);
      const url = baseUrl.replace(/\/$/, '') + '/contracts/delivery/' + token;
      const res = await this.notifier.send({ channel: 'EMAIL', to: party.email, title: request.title, url, templateId: 'contract-delivery' });
      const participant = request.participants.find((p) => p.externalSignerRef === party.email);
      await this.store.saveNotify({
        id: randomUUID(), requestId, participantId: participant?.participantId ?? party.email,
        channel: 'EMAIL', provider: res.provider, result: res.result, providerMsgId: res.providerMsgId,
        toMasked: maskEmail(party.email), title: `[교부] ${request.title}`, sentAt: new Date().toISOString(),
      });
      links.push({ email: maskEmail(party.email), url, expiresAt });
    }
    await this.recordContractAudit(requestId, 'CONTRACT_DELIVERED', { ...actor, count: links.length });
    return links;
  }

  /**
   * 체결(COMPLETED) 후처리 — 시점봉인(TSA)·검증토큰 선발급·자동 교부를 1회만 수행.
   * PARALLEL 동시 서명 완료 시 sign()/onPortalSigned() 양쪽이 COMPLETED 를 관측하는 경합 →
   * 계약 단위 직렬 구간 + 처리완료 플래그(ctdone)로 중복 anchor·중복 교부 메일 차단.
   */
  private async handleCompletion(requestId: string): Promise<void> {
    const doneKey = `ctdone:${requestId}`;
    await this.mutex.run(`complete:${requestId}`, async () => {
      if (await this.store.getMeta<{ handledAt: string }>(doneKey)) return; // 이미 처리(중복 완료 관측)
      await this.auditAnchor.anchor(this.contractKey(requestId)); // 체결 시점봉인(TSA)
      await this.ensureVerifyTokenAtCompletion(requestId); // 검증 토큰 선발급(읽기 부작용 제거)
      await this.store.saveMeta(doneKey, { handledAt: new Date().toISOString() });
      await this.autoDeliver(requestId); // 완료문서 자동 교부(P3, best-effort — 실패 시 수동 재발급)
    });
  }

  /** 체결 직후 자동 교부(best-effort) — 실패해도 체결은 유효(수동 재발급 EP 존재). */
  private async autoDeliver(requestId: string): Promise<void> {
    try {
      await this.deliver(requestId, { actor: 'system:auto-delivery', authMethod: 'SYSTEM' });
    } catch (e) {
      this.log.warn(`자동 교부 실패(${requestId}): ${(e as Error).message} — 콘솔에서 수동 재발급 가능`);
    }
  }

  /** 교부 토큰 검증 — 무효 404·만료 410(지연 파기). */
  async resolveDelivery(token: string): Promise<DeliveryToken> {
    this.assertEnabled();
    const rec = await this.store.getMeta<DeliveryToken>('ctdeliver:' + token);
    if (!rec) throw new NotFoundException('유효하지 않은 교부 링크');
    if (Date.parse(rec.expiresAt) <= Date.now()) {
      await this.store.deleteMeta('ctdeliver:' + token);
      throw new GoneException('교부 링크가 만료되었습니다');
    }
    // 보관(제거)·철회한 계약은 공개 링크 열람 차단 — 공개 검증(QR) 경로와 동일 정책
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(rec.requestId));
    if (meta?.archived) throw new GoneException('보관 처리된 계약입니다');
    return rec;
  }

  /**
   * 교부 링크 **1회 연장**(공개, 토큰) — 수신자가 기한 내에 스스로 한 번 연장할 수 있게 한다.
   * 만료 후에는 토큰이 폐기되므로 연장 불가(발송자에게 재발급 요청). 연장 폭 = 기본 TTL.
   */
  async extendDelivery(token: string): Promise<{ expiresAt: string }> {
    const rec = await this.resolveDelivery(token); // 만료·보관 계약이면 여기서 차단
    if (rec.extendedAt) throw new ConflictException('이미 한 번 연장한 링크입니다 — 추가 연장은 발송자에게 요청하세요');
    const expiresAt = new Date(Date.now() + this.deliveryTtlMs()).toISOString();
    await this.store.saveMeta('ctdeliver:' + token, { ...rec, expiresAt, extendedAt: new Date().toISOString() } satisfies DeliveryToken);
    await this.recordContractAudit(rec.requestId, 'CONTRACT_DELIVERY_EXTENDED', {
      actor: `delivery:${token.slice(0, 6)}…`, authMethod: 'DELIVERY_TOKEN', expiresAt,
    });
    return { expiresAt };
  }

  /**
   * 지정 이메일로 문서 전달(공개, 토큰) — 수신자가 담당자·보관 주소로 문서를 넘길 수 있게 한다.
   * 파일을 첨부하는 대신 **새 교부 링크**를 발급해 보낸다(다운로드가 접속기록에 남고, 만료로 통제 가능).
   * 남용 방지: 링크당 최대 `DELIVERY_FORWARD_MAX` 회, 전달 사실·수신처(마스킹)를 감사에 봉인.
   */
  async forwardDelivery(token: string, email: string): Promise<{ email: string; expiresAt: string; remaining: number }> {
    // 공개 토큰 EP — 토큰 단위 직렬화 + 잠금 안에서 카운트 재조회. 종전엔 check-then-act 라 동시 요청이
    // 모두 used=0 을 읽어 캡(DELIVERY_FORWARD_MAX)을 넘겨 발송할 수 있었다.
    return this.mutex.run(`fwd:${token}`, () => this.forwardDeliveryLocked(token, email));
  }

  private async forwardDeliveryLocked(token: string, email: string): Promise<{ email: string; expiresAt: string; remaining: number }> {
    const rec = await this.resolveDelivery(token);
    const to = (email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new BadRequestException('이메일 형식 오류');
    const used = rec.forwardCount ?? 0;
    if (used >= DELIVERY_FORWARD_MAX) throw new ConflictException(`전달은 링크당 최대 ${DELIVERY_FORWARD_MAX}회까지 가능합니다 — 발송자에게 요청하세요`);
    const { request, meta } = await this.assertContract(rec.requestId);
    const baseUrl = meta.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL');
    if (!baseUrl) throw new ConflictException('교부 링크 기준 URL 없음');

    const newToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.deliveryTtlMs()).toISOString();
    await this.store.saveMeta('ctdeliver:' + newToken, { requestId: rec.requestId, email: to, expiresAt, forwardedFrom: token.slice(0, 6) } satisfies DeliveryToken);
    const url = baseUrl.replace(/\/$/, '') + '/contracts/delivery/' + newToken;
    const res = await this.notifier.send({ channel: 'EMAIL', to, title: request.title, url, templateId: 'contract-delivery' });
    if (res.result !== 'SENT') {
      await this.store.deleteMeta('ctdeliver:' + newToken); // 발송 실패 → 미아 토큰 남기지 않는다
      throw new ConflictException('메일 발송에 실패했습니다 — 주소를 확인하거나 잠시 후 다시 시도하세요');
    }
    await this.store.saveMeta('ctdeliver:' + token, { ...rec, forwardCount: used + 1 } satisfies DeliveryToken);
    await this.store.saveNotify({
      id: randomUUID(), requestId: rec.requestId, participantId: `forward:${token.slice(0, 6)}`,
      channel: 'EMAIL', provider: res.provider, result: res.result, providerMsgId: res.providerMsgId,
      toMasked: maskEmail(to), title: `[교부-전달] ${request.title}`, sentAt: new Date().toISOString(),
    });
    await this.recordContractAudit(rec.requestId, 'CONTRACT_DELIVERY_FORWARDED', {
      actor: `delivery:${token.slice(0, 6)}…`, authMethod: 'DELIVERY_TOKEN', to: maskEmail(to), expiresAt,
    });
    return { email: maskEmail(to), expiresAt, remaining: DELIVERY_FORWARD_MAX - (used + 1) };
  }

  /** 교부 화면 정보(공개, 토큰) — 제목·만료·다운로드 가능 여부(내용 비노출). */
  async deliveryInfo(token: string) {
    const rec = await this.resolveDelivery(token);
    const request = await this.store.getRequest(rec.requestId);
    if (!request) throw new NotFoundException('계약 없음');
    return {
      title: request.title,
      status: request.status,
      expiresAt: rec.expiresAt,
      documentAvailable: await this.docs.has(rec.requestId),
      extendable: !rec.extendedAt, // 1회 연장 가능 여부
      forwardRemaining: Math.max(0, DELIVERY_FORWARD_MAX - (rec.forwardCount ?? 0)),
    };
  }

  /** 내부 서명 — 내부 서명자(세션 주체 바인딩)의 계약 서명. 순차=현재 단계만, 동시=본인 항목 언제든. fail-closed. */
  async sign(requestId: string, actor: ContractActor, signatureImage?: string, fillValues?: Array<{ label: string; value: string }>) {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') {
      throw new ConflictException(`계약 종결됨 (${request.status})`);
    }
    const actorId = actor.actor.replace(/^user:/, '');
    if (actor.authMethod !== 'CONSOLE_SESSION') throw new ForbiddenException('내부 서명은 콘솔 사람 계정만 가능(기계키 불가)');

    let target;
    if ((meta.signingMode ?? 'SEQUENTIAL') === 'PARALLEL') {
      // 동시 진행 — 본인(세션 주체)에게 배정된 미서명 내부 항목이면 순서 무관 서명 가능
      target = request.participants.find((p) => p.signerType === INTERNAL_SIGNER_TYPE && p.status !== 'SIGNED' && p.externalSignerRef === actorId);
      if (!target) throw new ForbiddenException('CONTRACT_SIGNER_MISMATCH: 본인에게 배정된 미서명 내부 항목이 없습니다');
    } else {
      const pending = [...request.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
      if (!pending) throw new ConflictException('서명할 단계 없음(전원 서명)');
      if (pending.signerType !== INTERNAL_SIGNER_TYPE) {
        throw new ConflictException(`현재 단계(order ${pending.signOrder})는 외부 서명자 차례 — 포털 링크로 서명`);
      }
      if (!pending.externalSignerRef || pending.externalSignerRef !== actorId) {
        throw new ForbiddenException(`CONTRACT_SIGNER_MISMATCH: order ${pending.signOrder} 지정 서명자만 서명 가능`);
      }
      target = pending;
    }

    // fill-at-signing(A4) — 배정 입력란 기재값 봉인(fail-closed: 누락·봉인 실패 시 서명 미수행)
    await this.saveFillBeforeSign(requestId, target.participantId, fillValues, 'CONSOLE');
    // 손글씨 서명 이미지(행위 증거) — 암호화 저장 후 해시를 감사에 봉인(있을 때만)
    const imgSha = signatureImage ? await this.saveSignatureImage(requestId, target.participantId, signatureImage, 'CONSOLE') : undefined;
    // fail-closed: 인증로그 먼저 봉인(실패 시 서명 미수행) → 서명(submit)
    await this.recordContractAudit(requestId, 'CONTRACT_SIGNED_INTERNAL', { ...actor, step: target.signOrder, signatureImageSha256: imgSha });
    try {
      await this.signSvc.submit(target.participantId); // signerType=INTERNAL → INPERSON 신원·순서게이팅, SSO 불요
    } catch (e) {
      await this.recordContractAudit(requestId, 'CONTRACT_SIGN_FAILED', { ...actor, step: target.signOrder, error: (e as Error).message });
      throw e;
    }
    const after = await this.store.getRequest(requestId);
    if (after?.status === 'COMPLETED') {
      await this.handleCompletion(requestId); // 시점봉인·검증토큰·교부 — 동시완료 경합에도 1회만
    } else {
      await this.notifyDueInternalSigners(requestId); // 다음 차례가 내부면 콘솔 서명 요청 이메일
      await this.notifyDueExternalSigners(requestId); // 다음 차례가 외부면 포털 링크 auto-advance
    }
    return { requestId, status: after?.status ?? request.status, step: target.signOrder };
  }

  /** 외부 포털 서명 후처리 훅(PortalController) — 계약 스트림 기록·체결 시 시점봉인. best-effort(주 체인은 봉투가 보증). */
  async onPortalSigned(requestId: string, participantId: string, ip?: string, signatureImage?: string): Promise<void> {
    try {
      const request = await this.store.getRequest(requestId);
      if (!request || request.signMode !== CONTRACT_SIGN_MODE) return;
      const p = request.participants.find((x) => x.participantId === participantId);
      const imgSha = signatureImage ? await this.saveSignatureImage(requestId, participantId, signatureImage, 'PORTAL').catch(() => undefined) : undefined;
      await this.recordContractAudit(requestId, 'CONTRACT_SIGNED_EXTERNAL', {
        actor: `party:${p?.externalSignerRef ?? participantId}`,
        authMethod: 'PORTAL_TOKEN',
        step: p?.signOrder,
        signatureImageSha256: imgSha,
        ip,
      });
      if (request.status === 'COMPLETED') {
        await this.handleCompletion(requestId); // 시점봉인·검증토큰·교부 — 동시완료 경합에도 1회만
      } else {
        await this.notifyDueInternalSigners(requestId); // 다음 차례가 내부면 콘솔 서명 요청 이메일
        await this.notifyDueExternalSigners(requestId); // 다음 차례가 외부면 포털 링크 auto-advance
      }
    } catch (e) {
      this.log.warn(`계약 포털 서명 기록 실패(${requestId}): ${(e as Error).message}`);
    }
  }

  /** 계약함 목록 — signMode=CONTRACT + 라벨·보관 필터 + 행 보강(현재 단계·발송·문서).
   *  보관(archived) 여부는 meta 라 DB 푸시다운 불가 → 상한 조회 후 서비스 필터·수동 페이지(원내 행정 계약 규모 전제).
   *  기본 archived=false(보관 제외). archived=true 면 보관함(제거된 계약)만. */
  async list(query: { limit?: number; offset?: number; status?: string; q?: string; from?: string; to?: string; label?: string; category?: string; archived?: boolean }) {
    this.assertEnabled();
    const { label, category, archived, limit, offset, ...rest } = query;
    // A3: 보관/분류/라벨은 봉투 필터 캐시(ct*)로 DB 푸시다운 — 상한 스캔·행별 meta 선필터 제거,
    // 페이지 행만 보강(행별 조회는 페이지 크기에 비례). 캐시 정본은 contract-meta(syncFilterCols).
    const { items, total } = await this.store.queryRequests({
      ...rest,
      offset: offset ?? 0,
      limit: limit ?? 20,
      signMode: CONTRACT_SIGN_MODE,
      archived: archived === true, // 기본: 보관 제외
      category,
      label,
    });
    const out = [];
    for (const r of items) {
      const meta = await this.store.getMeta<ContractMeta>(this.metaKey(r.requestId));
      const isArchived = !!meta?.archived;
      const labels = meta?.labels ?? [];
      const cat = meta?.category ?? '기타';
      const pending = [...r.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
      // 발송 시각은 meta.lastSentAt(발송·독촉마다 기록)을 우선 사용 — 행마다 발송이력을 조회하던 N+1 제거.
      // 레거시(lastSentAt 이전 생성분)만 발송이력으로 폴백한다(스토어에서 requestId 조건 푸시다운).
      let lastSentAt: string | null = meta?.lastSentAt ?? null;
      if (!lastSentAt) {
        const emails = (await this.store.notifyByRequest(r.requestId)).filter((n) => n.channel === 'EMAIL' && !(n.title ?? '').startsWith('[교부]'));
        lastSentAt = emails.length ? (emails.map((n) => n.sentAt).sort().at(-1) ?? null) : null;
      }
      out.push({
        requestId: r.requestId,
        title: r.title,
        externalDocId: r.externalDocId,
        status: r.status,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        requiredSigners: r.requiredSigners,
        completedSigners: r.completedSigners,
        labels,
        category: cat,
        hasAccessCode: meta?.hasAccessCode ?? false,
        signingMode: meta?.signingMode ?? 'SEQUENTIAL',
        hasDocument: await this.docs.exists(r.requestId), // 존재만 확인(계약 문서는 영구 보관) — 블롭 전량 로드 회피
        lastSentAt,
        archived: isArchived,
        archivedAt: meta?.archivedAt ?? null,
        archivedBy: meta?.archivedBy ?? null,
        archiveReason: meta?.archiveReason ?? null,
        // 현재 단계 — 내부는 지정 계정(username) 노출(콘솔 내부 식별자), 외부는 표시명만(이메일 비노출)
        currentStep: pending
          ? { order: pending.signOrder, kind: pending.signerType === INTERNAL_SIGNER_TYPE ? ('INTERNAL' as const) : ('EXTERNAL' as const), displayName: pending.displayName, username: pending.signerType === INTERNAL_SIGNER_TYPE ? pending.externalSignerRef : undefined }
          : null,
      });
    }
    return { items: out, total, truncated: false }; // truncated: DB 푸시다운으로 상한 제거(하위호환 필드)
  }

  /** 보관 처리(계약함 제거) — 목록 숨김, 데이터·서명·감사 보존. 제거 행위를 감사 스트림에 기록. */
  async archive(requestId: string, actor: ContractActor, reason?: string) {
    this.assertEnabled();
    await this.assertContract(requestId);
    // 멱등 판정·갱신을 한 잠금 안에서(진입 시 스냅샷으로 판정하면 동시 요청이 서로를 덮어쓴다)
    let already = false;
    let prevVerifyToken: string | undefined;
    const next = await this.updateMeta(requestId, (m) => {
      already = false; prevVerifyToken = undefined; // CAS 재시도로 재실행될 수 있다 — 진입 시 초기화
      if (m.archived) { already = true; return m; }
      prevVerifyToken = m.verifyToken;
      return { ...m, verifyToken: undefined, archived: true, archivedAt: new Date().toISOString(), archivedBy: actor.actor, archiveReason: reason?.trim() || undefined };
    });
    if (already) return { requestId, archived: true };
    // 공개 검증 토큰 폐기 — 보관(제거)·철회한 계약이 공개 QR/검증 링크로 계속 열람되지 않도록(교부 토큰 정책과 일관).
    if (prevVerifyToken) await this.store.deleteMeta('ctverify:' + prevVerifyToken);
    await this.recordContractAudit(requestId, 'CONTRACT_ARCHIVED', { ...actor, reason: next.archiveReason });
    return { requestId, archived: true };
  }

  /** 보관 복원 — 계약함 목록 재노출. 복원 행위도 감사 기록. */
  async unarchive(requestId: string, actor: ContractActor) {
    this.assertEnabled();
    await this.assertContract(requestId);
    let already = false;
    await this.updateMeta(requestId, (m) => {
      already = false; // CAS 재시도로 재실행될 수 있다 — 진입 시 초기화
      if (!m.archived) { already = true; return m; }
      return { ...m, archived: false, archivedAt: undefined, archivedBy: undefined, archiveReason: undefined };
    });
    if (already) return { requestId, archived: false }; // 멱등
    await this.recordContractAudit(requestId, 'CONTRACT_UNARCHIVED', { ...actor });
    return { requestId, archived: false };
  }

  /** 계약 상세 — 봉투 + 계약 메타(라벨·상대방 마스킹)·문서 보유·감사 건수. */
  async get(requestId: string) {
    this.assertEnabled();
    const { meta } = await this.assertContract(requestId);
    const dto = await this.signSvc.getRequest(requestId);
    const log = await this.store.auditEntries(this.contractKey(requestId));
    return {
      ...dto,
      labels: meta.labels,
      hasAccessCode: meta.hasAccessCode,
      signingMode: meta.signingMode ?? 'SEQUENTIAL',
      parties: meta.parties.map((p) => ({ displayName: p.displayName, email: maskEmail(p.email), order: p.order })),
      internalNotify: (meta.internalNotify ?? []).map((s) => ({ username: s.username, displayName: s.displayName, order: s.order, email: s.email ? maskEmail(s.email) : (this.adminUsers.getActive(s.username)?.email ? maskEmail(this.adminUsers.getActive(s.username)!.email!) : null) })),
      documentAvailable: await this.docs.has(requestId),
      auditCount: log.length,
      archived: !!meta.archived,
      archivedAt: meta.archivedAt ?? null,
      archivedBy: meta.archivedBy ?? null,
      archiveReason: meta.archiveReason ?? null,
      signMarks: meta.signMarks ?? [],
      verifyToken: meta.verifyToken ?? null, // 완료문서 QR 검증 링크 토큰(체결 후)
      category: meta.category ?? '기타',
      lastSentAt: meta.lastSentAt ?? null, // 발송됨 여부 — 첨부 편집 가능(작성·미발송) 판정(설계 §11)
    };
  }

  /** 카테고리별 집계(보관 제외) — 각 카테고리의 전체·체결완료 건수. 완료 계약 카테고리별 관리 화면용. */
  async categorySummary(): Promise<Array<{ category: string; total: number; completed: number }>> {
    this.assertEnabled();
    // A3: 분류·보관은 봉투 필터 캐시(ct*) — 행별 meta 조회 없이 단일 스캔 집계(보관 제외 푸시다운).
    const map = new Map<string, { total: number; completed: number }>();
    for (const r of await this.scanAllContracts({ archived: false })) {
      const cat = r.ctCategory ?? '기타';
      const e = map.get(cat) ?? { total: 0, completed: 0 };
      e.total++;
      if (r.status === 'COMPLETED') e.completed++;
      map.set(cat, e);
    }
    return [...map.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.completed - a.completed || b.total - a.total);
  }

  /** 계약 카테고리 변경(재분류) — 기존 계약도 카테고리별 관리에 편입. */
  async setCategory(requestId: string, category: string): Promise<{ category: string }> {
    this.assertEnabled();
    const { meta } = await this.assertContract(requestId);
    const cat = category?.trim() || '기타';
    await this.updateMeta(requestId, (m) => ({ ...m, category: cat }));
    await this.syncFilterCols(requestId, { ...meta, category: cat }); // 목록 필터 캐시(A3)
    await this.recordContractAudit(requestId, 'CONTRACT_CATEGORIZED', { category: cat });
    return { category: cat };
  }

  /** 계약함 CSV — 목록 필터 동일(내용 미포함·메타만). */
  async exportCsvRows(query: { status?: string; q?: string; from?: string; to?: string }) {
    // 배치 페이징 — 단발 10k 조회는 초과분을 **경고 없이 잘라** 감사·보존용 CSV 를 불완전하게 만들었다(R4).
    const BATCH = 500;
    const rows: string[][] = [];
    for (let offset = 0; ; offset += BATCH) {
      const { items, total } = await this.list({ ...query, offset, limit: BATCH });
      rows.push(...items.map((r) => [r.createdAt ?? '', r.requestId, r.title, r.status, String(r.completedSigners) + '/' + String(r.requiredSigners), r.labels.join('|'), r.expiresAt ?? '']));
      if (!items.length || rows.length >= total) break;
    }
    return rows;
  }

  // ── 포털 접근암호(unlock) 게이트 ────────────────────────────────────────────

  /** 접근암호 검증 — 성공 시 토큰에 unlock 표시, 실패는 감사 후 403. 대상 아님(비계약/암호미설정)은 즉시 통과. */
  async unlock(token: string, code: string, ip?: string) {
    this.assertEnabled();
    const tokenRec = await this.tokens.resolve(token); // 만료/사용 토큰 → 403
    const request = await this.store.getRequest(tokenRec.requestId);
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(tokenRec.requestId));
    if (!request || request.signMode !== CONTRACT_SIGN_MODE || !meta?.accessCode) return { unlocked: true };

    const accessCode = meta.accessCode;
    const requestId = tokenRec.requestId;
    const failKey = `ctunlock-fail:${requestId}`;
    // 실패 카운터·잠금 판정은 계약 단위 직렬 구간에서 — 병렬 시도로 카운터를 건너뛰는 우회 방지
    return this.mutex.run(`unlock:${requestId}`, async () => {
      const failRec = await this.store.getMeta<{ count: number; lockedUntil?: string }>(failKey);
      const fail = failRec ?? { count: 0 };
      if (fail.lockedUntil) {
        if (Date.parse(fail.lockedUntil) > Date.now()) {
          throw new HttpException('접근암호 오류가 누적되어 잠시 차단되었습니다 — 잠시 후 다시 시도하세요', 429);
        }
        fail.count = 0; // 잠금 만료 — 카운터 리셋 후 재시도 허용
        fail.lockedUntil = undefined;
      }
      const expected = Buffer.from(accessCode.hash, 'hex');
      const got = scryptSync(code, accessCode.salt, 64);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
        fail.count += 1;
        const locked = fail.count >= UNLOCK_MAX_FAILS;
        if (locked) fail.lockedUntil = new Date(Date.now() + UNLOCK_LOCK_MS).toISOString();
        await this.store.saveMeta(failKey, fail);
        await this.recordContractAudit(requestId, locked ? 'CONTRACT_UNLOCK_LOCKED' : 'CONTRACT_UNLOCK_FAILED', {
          actor: `party:${tokenRec.participantId}`,
          authMethod: 'PORTAL_TOKEN',
          failCount: fail.count,
          ip,
        }).catch(() => undefined);
        if (locked) throw new HttpException(`접근암호 ${UNLOCK_MAX_FAILS}회 오류 — ${UNLOCK_LOCK_MS / 60_000}분간 차단되었습니다`, 429);
        throw new ForbiddenException('접근암호가 일치하지 않습니다');
      }
      if (failRec) await this.store.deleteMeta(failKey).catch(() => undefined);
      await this.tokens.markUnlocked(token);
      await this.recordContractAudit(requestId, 'CONTRACT_UNLOCKED', {
        actor: `party:${tokenRec.participantId}`,
        authMethod: 'PORTAL_TOKEN',
        ip,
      }).catch(() => undefined);
      return { unlocked: true };
    });
  }

  /** 토큰의 잠금 상태 — 계약+접근암호 설정+미unlock 이면 true(열람·서명 차단). 비계약은 항상 false. */
  async isLocked(requestId: string, tokenRec: { unlockedAt?: string | null }): Promise<boolean> {
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) return false;
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    if (!meta?.accessCode) return false;
    return !tokenRec.unlockedAt;
  }

  /** 포털 열람·서명 진입 게이트 — 잠금 상태면 403(unlock 선행 요구). */
  async assertPortalUnlocked(requestId: string, tokenRec: { unlockedAt?: string | null; participantId?: string; issuedAt?: string }): Promise<void> {
    await this.assertTokenNotSuperseded(requestId, tokenRec);
    if (await this.isLocked(requestId, tokenRec)) {
      throw new ForbiddenException('CONTRACT_LOCKED: 접근암호 확인(unlock) 후 이용 가능합니다');
    }
  }

  /**
   * 수신처 정정(R4) 이전에 발급된 링크 차단 — 잘못된 수신자가 이미 받은 링크로 열람·서명하지 못하게 한다.
   * `issuedAt` 이 없는 구 토큰은 정정 시점이 있으면 **거부**(fail-closed).
   */
  async assertTokenNotSuperseded(requestId: string, tokenRec: { participantId?: string; issuedAt?: string }): Promise<void> {
    if (!tokenRec.participantId) return;
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    const cutoff = meta?.tokenInvalidBefore?.[tokenRec.participantId];
    if (!cutoff) return;
    if (!tokenRec.issuedAt || Date.parse(tokenRec.issuedAt) < Date.parse(cutoff)) {
      throw new ForbiddenException('CONTRACT_LINK_SUPERSEDED: 수신 정보가 정정되어 이 링크는 더 이상 사용할 수 없습니다(새 링크를 요청하세요)');
    }
  }

  // ── 손글씨 서명 이미지(행위 증거) ────────────────────────────────────────

  private signImageKey(requestId: string, participantId: string): string {
    return `csign:${requestId}:${participantId}`;
  }

  /** 손글씨 서명 이미지 저장 — data URL(PNG) 검증·암호화 봉인. 반환=이미지 SHA-256(감사 봉인용). */
  private async saveSignatureImage(requestId: string, participantId: string, dataUrl: string, via: string): Promise<string> {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || '').trim());
    if (!m) throw new BadRequestException('서명 이미지 형식 오류(data:image/png;base64,…)');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new BadRequestException('서명 이미지 크기 오류(0~2MB)');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const rec: StoredSignatureImage = { sealed: this.box.sealBytes(bytes), contentType: `image/${m[1]}`, sha256, via, drawnAt: new Date().toISOString() };
    await this.store.saveMeta(this.signImageKey(requestId, participantId), rec);
    return sha256;
  }

  /** 손글씨 서명 이미지 조회(복호화·해시 재검증). 미보유=null. */
  async getSignatureImage(requestId: string, participantId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    this.assertEnabled();
    await this.assertContract(requestId);
    const rec = await this.store.getMeta<StoredSignatureImage>(this.signImageKey(requestId, participantId));
    if (!rec) return null;
    const bytes = this.box.openBytes(rec.sealed);
    if (createHash('sha256').update(bytes).digest('hex') !== rec.sha256) throw new ConflictException('서명 이미지 무결성 검증 실패');
    return { bytes, contentType: rec.contentType };
  }

  // ── fill-at-signing(A4, 설계 fill-at-signing.design.md 권장안 B) ─────────────
  // 원본 해시 봉인 무변경 — 기재값은 행위 증거(암호화 보관+SHA-256 감사 봉인), 표시본에 합성. 손글씨(csign)와 동형.

  private fillKey(requestId: string, participantId: string): string {
    return `ctfill:${requestId}:${participantId}`;
  }

  /** 참가자에게 배정된 입력란(FIELD 마크) — 제출 순번(signOrder 정렬 위치 i+1) 기준(손글씨 매핑과 동일 규칙). */
  private assignedFieldMarks(request: { participants: Array<{ participantId: string; signOrder: number }> }, meta: ContractMeta, participantId: string): Array<{ index: number; label: string; fieldType: FieldValueType }> {
    const ordered = [...request.participants].sort((a, b) => a.signOrder - b.signOrder);
    const pos = ordered.findIndex((p) => p.participantId === participantId);
    if (pos < 0) return [];
    const signerNo = pos + 1;
    return (meta.signMarks ?? [])
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.type === 'FIELD' && m.signer === signerNo)
      .map(({ m, index }) => ({ index, label: (m.label ?? '').trim() || `입력란 ${index + 1}`, fieldType: m.fieldType ?? 'text' }));
  }

  /** 포털 안내용 — 이 참가자가 서명 시 기재해야 할 입력란(비계약/미배정=빈 배열). */
  async portalInputFields(requestId: string, participantId: string): Promise<Array<{ label: string; fieldType: FieldValueType; maxLength: number }>> {
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) return [];
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    if (!meta) return [];
    return this.assignedFieldMarks(request, meta, participantId).map((f) => ({ label: f.label, fieldType: f.fieldType, maxLength: FIELD_MAX_LEN[f.fieldType] }));
  }

  /**
   * 입력란 값 검증·정규화(A4 고도화, 설계 §5 확정) — 타입별 형식 강제 후 **정규화된 값**을 봉인·합성에 사용.
   * 실패는 400(BadRequest) — fail-closed 원칙상 서명 전에 차단된다.
   */
  private normalizeFieldValue(type: FieldValueType, label: string, raw: string): string {
    // 제어문자(줄바꿈·탭 포함) 제거 — 단일 라인 기재란
    // 제어문자 + 제로폭/BiDi 서식문자(U+200B~200F·U+202A~202E·U+2060~2064·U+FEFF) 제거 후 NFC 정규화 —
    // "보이지 않는 글자만 기재"로 필수 입력란을 사실상 공란 체결하거나 표시 순서를 뒤집는 것을 차단.
    const value = raw
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) throw new BadRequestException(`${label}: 값이 비었습니다`);
    if (value.length > FIELD_MAX_LEN[type]) throw new BadRequestException(`${label}: 최대 ${FIELD_MAX_LEN[type]}자`);
    if (type === 'date') {
      const m = /^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/.exec(value.replace(/\s/g, ''));
      if (!m) throw new BadRequestException(`${label}: 날짜 형식(YYYY-MM-DD)으로 입력해 주세요`);
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      // 실재 일자 검증(2026-02-30 등 롤오버 차단)
      if (y < 1900 || y > 2999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
        throw new BadRequestException(`${label}: 존재하지 않는 날짜입니다`);
      }
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (type === 'money') {
      const digits = value.replace(/[,\s원]/g, '');
      if (!/^\d+$/.test(digits)) throw new BadRequestException(`${label}: 금액은 숫자로 입력해 주세요(원 단위)`);
      if (digits.length > 15) throw new BadRequestException(`${label}: 금액 자릿수 초과`);
      return String(BigInt(digits)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); // 선행 0 제거 + 3자리 구분
    }
    if (type === 'number') {
      const n = value.replace(/[,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(n)) throw new BadRequestException(`${label}: 숫자만 입력해 주세요`);
      return n;
    }
    return value;
  }

  /**
   * 서명 직전 기재값 봉인(fail-closed) — 배정 입력란 전량 기재 필수(누락 409), 값은 암호화 보관,
   * SHA-256 을 감사 체인에 봉인(CONTRACT_FILLED). 봉인 실패 시 예외 → 서명 미수행. 비계약은 no-op.
   */
  async saveFillBeforeSign(requestId: string, participantId: string, values: Array<{ label: string; value: string }> | undefined, via: string): Promise<void> {
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) return; // 동의서 등 비계약 — 무시
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    if (!meta) return;
    // 서명 완료자·재기재 차단 — "서명 후 기재 수정 불가"(설계 §4-4). 토큰이 여러 개 살아 있어도 봉인값은 1회로 고정.
    const me = request.participants.find((p) => p.participantId === participantId);
    if (me?.status === 'SIGNED') throw new ConflictException('이미 서명이 완료되어 기재값을 변경할 수 없습니다');
    if (await this.store.getMeta(this.fillKey(requestId, participantId))) {
      throw new ConflictException('이미 기재값이 봉인되어 재기재할 수 없습니다');
    }
    const fields = this.assignedFieldMarks(request, meta, participantId);
    const supplied = (values ?? []).map((v) => ({ label: (v.label ?? '').trim(), value: (v.value ?? '').trim() }));
    if (fields.length === 0) {
      if (supplied.length) throw new BadRequestException('이 서명자에게 배정된 입력란이 없습니다');
      return;
    }
    // 순서 게이팅 — 자기 차례가 아닌 참가자의 기재 봉인·감사 누적 차단(순차 계약)
    if ((meta.signingMode ?? 'SEQUENTIAL') !== 'PARALLEL') {
      const due = [...request.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
      if (due && due.participantId !== participantId) throw new ConflictException('아직 서명 차례가 아닙니다');
    }
    const byLabel = new Map(supplied.map((v) => [v.label, v.value]));
    const missing = fields.filter((f) => !byLabel.get(f.label));
    if (missing.length) throw new ConflictException(`필수 입력란 미기재: ${missing.map((f) => f.label).join(', ')}`);
    const unknown = supplied.filter((v) => !fields.some((f) => f.label === v.label));
    if (unknown.length) {
      // 라벨 나열은 상위 5개까지만(대량 전송 시 응답 증폭 방지)
      const head = unknown.slice(0, 5).map((v) => v.label.slice(0, 40)).join(', ');
      throw new BadRequestException(`배정되지 않은 입력란: ${head}${unknown.length > 5 ? ` 외 ${unknown.length - 5}건` : ''}`);
    }
    // 타입별 검증·정규화(A4 고도화) — 봉인·합성 대상은 **정규화된 값**(날짜 YYYY-MM-DD·금액 3자리 구분)
    const normalized = new Map(fields.map((f) => [f.label, this.normalizeFieldValue(f.fieldType, f.label, byLabel.get(f.label) as string)]));
    // 마크 인덱스 순 canonical JSON — 해시 재현성(합성·증적 대조)
    const canonical = JSON.stringify(fields.map((f) => ({ index: f.index, label: f.label, value: normalized.get(f.label) })));
    const sha256 = createHash('sha256').update(canonical).digest('hex');
    await this.store.saveMeta(this.fillKey(requestId, participantId), {
      sealed: this.box.sealBytes(Buffer.from(canonical, 'utf8')),
      sha256,
      labels: fields.map((f) => f.label),
      fields: fields.map((f) => ({ label: f.label, fieldType: f.fieldType })), // 증적 — 기재 당시 입력 타입
      filledAt: new Date().toISOString(),
      via,
    });
    // fail-closed — 감사 봉인 실패 시 throw(서명 진행 차단). 손글씨(best-effort)보다 강한 보증: 기재값은 계약 내용의 일부.
    try {
      await this.recordContractAudit(requestId, 'CONTRACT_FILLED', { actor: `party:${participantId}`, via, sha256, labels: fields.map((f) => f.label) });
    } catch (e) {
      // 감사 없이 남은 봉인값은 증적으로 쓸 수 없다 — 되돌리고 실패 전파(재기재 차단 가드에 걸리지 않도록)
      await this.store.deleteMeta(this.fillKey(requestId, participantId)).catch(() => undefined);
      throw e;
    }
  }

  /**
   * 기재값 박스 맞춤 레이아웃(A4 고도화) — 어절 단위 줄바꿈으로 최대한 살리고, 안 맞으면 폰트 축소(11→6pt),
   * 최소 크기에서도 넘치면 마지막 줄만 말줄임(…). 어절 자체가 폭을 넘으면 글자 단위로 분할(한글 주소·계좌명 대응).
   */
  private layoutFieldValue(font: import('pdf-lib').PDFFont, value: string, maxW: number, maxH: number): { lines: string[]; size: number; truncated: boolean } {
    const maxSize = Math.max(FIELD_MIN_SIZE, Math.min(FIELD_MAX_SIZE, maxH / FIELD_LINE_RATIO));
    for (let size = maxSize; size >= FIELD_MIN_SIZE; size -= 0.5) {
      const maxLines = Math.max(1, Math.floor(maxH / (size * FIELD_LINE_RATIO)));
      const lines = this.wrapFieldText(font, value, size, maxW);
      if (lines.length <= maxLines) return { lines, size, truncated: false };
    }
    // 최소 크기에서도 초과 — 허용 줄 수까지만 그리고 말줄임
    const size = FIELD_MIN_SIZE;
    const maxLines = Math.max(1, Math.floor(maxH / (size * FIELD_LINE_RATIO)));
    const all = this.wrapFieldText(font, value, size, maxW);
    const lines = all.slice(0, maxLines);
    let last = lines[lines.length - 1] ?? '';
    while (last.length > 1 && font.widthOfTextAtSize(last + '…', size) > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
    return { lines, size, truncated: true };
  }

  /** 어절 단위 줄바꿈(초과 어절은 글자 단위 분할) — 최소 1줄 보장. */
  private wrapFieldText(font: import('pdf-lib').PDFFont, text: string, size: number, maxW: number): string[] {
    const lines: string[] = [];
    let cur = '';
    for (const word of text.split(' ').filter((w) => w.length)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(cand, size) <= maxW) { cur = cand; continue; }
      if (cur) { lines.push(cur); cur = ''; }
      if (font.widthOfTextAtSize(word, size) <= maxW) { cur = word; continue; }
      // 어절 하나가 폭 초과 → 글자 단위(한 줄 최소 1글자 — 무한 루프 방지)
      let chunk = '';
      for (const ch of word) {
        if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxW) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      cur = chunk;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /** 기재값 조회(복호화·해시 재검증) — 표시 합성·상세용. 미보유 null. */
  async getFillValues(requestId: string, participantId: string): Promise<Array<{ index: number; label: string; value: string }> | null> {
    const rec = await this.store.getMeta<{ sealed: SealedSecret; sha256: string }>(this.fillKey(requestId, participantId));
    if (!rec) return null;
    const bytes = this.box.openBytes(rec.sealed);
    if (createHash('sha256').update(bytes).digest('hex') !== rec.sha256) throw new ConflictException('기재값 무결성 검증 실패');
    return JSON.parse(bytes.toString('utf8'));
  }

  /**
   * 계약 전체 기재값 조회(A4 고도화) — 서명자별 기재 원문·봉인 해시·기재 시각·경로.
   * 복호화·SHA-256 재검증(무결성 실패 시 해당 서명자만 integrityOk=false, 값 비노출).
   * 콘솔 GET 공통 신뢰경계(contracts:read — 손글씨 이미지·이력 열람과 동일).
   */
  async fillValueSummary(requestId: string): Promise<Array<{ participantId: string; displayName: string; signerNo: number; sha256: string; filledAt?: string; via?: string; integrityOk: boolean; values: Array<{ index: number; label: string; fieldType: FieldValueType; value: string }> }>> {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    const ordered = [...request.participants].sort((a, b) => a.signOrder - b.signOrder);
    const out = [];
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const rec = await this.store.getMeta<{ sha256: string; filledAt?: string; via?: string; fields?: Array<{ label: string; fieldType: FieldValueType }> }>(this.fillKey(requestId, p.participantId));
      if (!rec) continue;
      const types = new Map((rec.fields ?? []).map((f) => [f.label, f.fieldType]));
      // 기재 당시 타입이 없으면(초기 계약) 현재 마크에서 보강 → 그래도 없으면 text
      const marks = this.assignedFieldMarks(request, meta, p.participantId);
      const decoded = await this.getFillValues(requestId, p.participantId).catch(() => null);
      out.push({
        participantId: p.participantId,
        displayName: p.displayName,
        signerNo: i + 1,
        sha256: rec.sha256,
        filledAt: rec.filledAt,
        via: rec.via,
        integrityOk: decoded !== null,
        values: (decoded ?? []).map((v) => ({ ...v, fieldType: types.get(v.label) ?? marks.find((m) => m.index === v.index)?.fieldType ?? 'text' })),
      });
    }
    return out;
  }

  /**
   * 계약 철회(R5) — 계약 소비자가 계약 API 만으로 완결하도록 하는 별칭.
   * 봉투 철회(요청 트랙)와 동일 동작 + 계약 감사 스트림 봉인. 체결 완료 계약은 철회 불가(409).
   */
  async withdraw(requestId: string, reason: string | undefined, actor: ContractActor) {
    this.assertEnabled();
    await this.assertContract(requestId); // 계약 트랙 봉투만
    const r = await this.signSvc.withdraw(requestId, reason);
    await this.recordContractAudit(requestId, 'CONTRACT_WITHDRAWN', { ...actor, reason: reason?.trim() || null });
    return r;
  }

  /**
   * 계약 진행 상태(경량, R3) — 연동 시스템이 웹훅 유실 시 정합을 되맞출 수 있는 **개인정보 없는** 조회 경로.
   * 이메일·기재값·문서는 노출하지 않는다(상세는 `GET /v1/contracts/:id`, contracts:read).
   */
  async statusOf(requestId: string) {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    const ordered = [...request.participants].sort((a, b) => a.signOrder - b.signOrder);
    const kindOf = (t: string) => (t === INTERNAL_SIGNER_TYPE ? ('INTERNAL' as const) : ('EXTERNAL' as const));
    const pending = ordered.find((p) => p.status !== 'SIGNED');
    const sigs = await this.store.signaturesByRequest(requestId);
    const times = sigs.map((x) => x.signedAt).filter(Boolean).sort();
    const base = (meta.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL') ?? '').replace(/\/$/, '');
    return {
      requestId,
      externalDocId: request.externalDocId,
      title: request.title, // 파일명·목록 표시용(개인정보 아님)
      status: request.status,
      signingMode: meta.signingMode ?? 'SEQUENTIAL',
      requiredSigners: request.requiredSigners,
      completedSigners: request.completedSigners,
      currentStep: pending ? { participantId: pending.participantId, order: pending.signOrder, kind: kindOf(pending.signerType), displayName: pending.displayName } : null,
      // participantId 포함(R6) — 수신처 정정 EP(`/participants/:pid/email`)를 쓰려면 호출자가 이 값을 알아야 한다.
      // 불투명 UUID 라 개인정보가 아니며, 이 EP 는 이미 계약 생성 권한(contracts:write) 보유자만 접근한다.
      signers: ordered.map((p) => ({ participantId: p.participantId, order: p.signOrder, kind: kindOf(p.signerType), displayName: p.displayName, status: p.status })),
      lastSentAt: meta.lastSentAt ?? null,
      completedAt: request.status === 'COMPLETED' ? (times[times.length - 1] ?? null) : null,
      archived: !!meta.archived,
      verifyToken: meta.verifyToken ?? null,
      verifyUrl: meta.verifyToken && base ? `${base}/contracts/verify/${meta.verifyToken}` : null,
    };
  }

  /**
   * 미서명 외부 서명자의 수신 이메일 정정(R4) — 발행 시점 오기재를 철회·재발행 없이 바로잡는다.
   * 규칙: ①종결 계약 불가 ②외부(EXTERNAL) 미서명 참가자만 ③기존 포털 링크는 **즉시 무효화**
   * (잘못된 수신자가 이미 링크를 받았을 수 있다) ④감사 봉인(이메일 마스킹 기록).
   * 정정 후에는 발송/독촉으로 새 링크를 보낸다(externalNotified 에서 제거 → auto-advance 대상).
   */
  async updateParticipantEmail(requestId: string, participantId: string, email: string, actor: ContractActor): Promise<{ participantId: string; email: string }> {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') throw new ConflictException(`종결된 계약(${request.status})은 수정할 수 없습니다`);
    const target = request.participants.find((p) => p.participantId === participantId);
    if (!target) throw new NotFoundException('참가자 없음');
    if (target.signerType !== EXTERNAL_SIGNER_TYPE) throw new BadRequestException('외부(이메일) 서명자만 수신처를 정정할 수 있습니다');
    if (target.status === 'SIGNED') throw new ConflictException('이미 서명한 참가자의 수신처는 변경할 수 없습니다');
    const next = (email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) throw new BadRequestException('이메일 형식 오류');
    const prev = target.externalSignerRef;
    if (prev === next) return { participantId, email: maskEmail(next) };

    target.externalSignerRef = next;
    await this.store.saveRequest(request);
    await this.updateMeta(requestId, (m) => ({
      ...m,
      parties: (m.parties ?? []).map((x) => (x.email === prev ? { ...x, email: next } : x)),
      tokenInvalidBefore: { ...(m.tokenInvalidBefore ?? {}), [participantId]: new Date().toISOString() },
      externalNotified: (m.externalNotified ?? []).filter((id) => id !== participantId),
    }));
    await this.recordContractAudit(requestId, 'CONTRACT_PARTICIPANT_EMAIL_CHANGED', {
      ...actor,
      participantId,
      from: prev ? maskEmail(prev) : null,
      to: maskEmail(next),
    });
    return { participantId, email: maskEmail(next) };
  }

  /**
   * 서명란 좌표 재지정 — 기존 계약(생성 시 미저장분 포함)의 서명란 위치를 다시 배치·저장(손글씨 합성 위치).
   * 가드: ①서명자 순번 범위 검증 ②**기재값이 이미 봉인된 계약은 입력란(FIELD) 구성 변경 금지**
   * (봉인 키가 마크 인덱스 기반이라 재색인 시 기재값이 표시본에서 사라지거나 다른 칸에 합성된다) ③감사 기록.
   */
  async updateSignMarks(requestId: string, marks: PlacedMark[], actor?: ContractActor): Promise<{ count: number }> {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    const signMarks = (marks ?? []).filter((m) => m.type === 'SIGN' || m.type === 'FIELD'); // FIELD=기재란(A4)
    const maxSigner = request.participants.length;
    const bad = signMarks.find((m) => !Number.isInteger(m.signer) || m.signer < 1 || m.signer > maxSigner);
    if (bad) throw new BadRequestException(`서명자 순번 오류(1~${maxSigner}): ${bad.signer}`);
    // 봉인된 기재값이 하나라도 있으면 FIELD 구성(순서·라벨·타입·배정)은 고정
    const sealed = await this.hasSealedFill(requestId, request);
    if (sealed) {
      const sig = (list: PlacedMark[]) =>
        JSON.stringify(list.map((m, index) => ({ index, t: m.type, ...(m.type === 'FIELD' ? { l: (m.label ?? '').trim(), f: m.fieldType ?? 'text', s: m.signer } : {}) })));
      if (sig(signMarks) !== sig(meta.signMarks ?? [])) {
        throw new ConflictException('기재값이 봉인된 계약입니다 — 입력란 구성(순서·라벨·타입·배정)은 변경할 수 없습니다');
      }
    }
    await this.updateMeta(requestId, (m) => ({ ...m, signMarks }));
    if (actor) await this.recordContractAudit(requestId, 'CONTRACT_SIGN_MARKS_UPDATED', { ...actor, count: signMarks.length });
    return { count: signMarks.length };
  }

  /** 이 계약에 봉인된 기재값이 하나라도 있는지(입력란 구성 변경 가드). */
  private async hasSealedFill(requestId: string, request: { participants: Array<{ participantId: string }> }): Promise<boolean> {
    for (const p of request.participants) {
      if (await this.store.getMeta(this.fillKey(requestId, p.participantId))) return true;
    }
    return false;
  }

  /**
   * 포털 열람용 표시본(D1) — 순차 서명에서 뒤 서명자가 **앞 서명자가 기재한 내용**을 보고 서명하도록,
   * 지금까지 확정된 기재값·손글씨가 합성된 PDF 를 돌려준다(원본 해시·서명 대상은 불변).
   * 계약 트랙이 아니거나 합성할 것이 없으면 null → 호출자가 원본을 그대로 제공한다.
   */
  async renderPortalView(requestId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    if (!this.enabled()) return null;
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) return null;
    return this.renderSignedDocument(requestId);
  }

  /**
   * 서명 반영 표시본 — 원본(서명란 박스 포함 PDF)에 서명 완료 참가자의 손글씨 이미지를
   * 서명란 좌표에 합성한 PDF. 원본(서명 대상·해시)은 무결성 유지, 이 표시본은 시각 표현용.
   * signMarks 없거나 이미지 없으면 원본 그대로 반환. 조회 시 온더플라이 생성(미저장).
   */
  async renderSignedDocument(requestId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    this.assertEnabled();
    const { request, meta } = await this.assertContract(requestId);
    const doc = await this.docs.fetch(requestId);
    if (!doc) return null;
    const marks = (meta.signMarks ?? []).filter((m) => m.type === 'SIGN');
    const fieldMarks = (meta.signMarks ?? []).filter((m) => m.type === 'FIELD'); // fill-at-signing 기재 합성(A4)
    const isCompleted = request.status === 'COMPLETED';
    // 손글씨·기재 합성도 QR도 없을 상황이면 원본 그대로(불필요한 재직렬화 회피)
    if (marks.length === 0 && fieldMarks.length === 0 && !isCompleted) return { bytes: doc.bytes, contentType: doc.contentType };

    let pdf: PDFDocument;
    let pages: PDFPage[];
    try {
      pdf = await PDFDocument.load(doc.bytes);
      pages = pdf.getPages();
      if (pages.length === 0) throw new Error('페이지 없음');
    } catch (e) {
      // 파싱 불가·페이지 없는 PDF(스캔·암호화·불완전) → 원본 그대로(합성/QR 생략)
      this.log.warn(`문서 합성 생략(원본 반환): ${(e as Error).message}`);
      return { bytes: doc.bytes, contentType: doc.contentType };
    }
    const ordered = [...request.participants].sort((a, b) => a.signOrder - b.signOrder);
    let composed = false;
    // signOrder 정렬 후 위치(i+1) = 제출 순번(1..N). 마크의 signer 는 제출 순번(new 폼의 필터된 서명자 order)과 동일.
    // ※ PARALLEL 은 signOrder 가 전원 1 로 축약되므로 signOrder 직접 매칭 불가 — 안정정렬 위치(i+1)로 제출 순번 복원.
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      if (p.status !== 'SIGNED') continue;
      const signerNo = i + 1;
      const mark = marks.find((m) => m.signer === signerNo);
      if (!mark) continue;
      const img = await this.getSignatureImage(requestId, p.participantId).catch(() => null);
      if (!img) continue;
      let png;
      try { png = img.contentType === 'image/jpeg' ? await pdf.embedJpg(img.bytes) : await pdf.embedPng(img.bytes); } catch { continue; }
      const page = pages[Math.min(Math.max(1, Math.round(mark.page)), pages.length) - 1];
      const { width: pw, height: ph } = page.getSize();
      const boxW = Math.max(0.02, Math.min(1, mark.w)) * pw;
      const boxH = Math.max(0.015, Math.min(1, mark.h)) * ph;
      const boxX = Math.min(Math.max(0, mark.x), 1 - Math.max(0.02, Math.min(1, mark.w))) * pw;
      const boxYTop = Math.min(Math.max(0, mark.y), 1 - Math.max(0.015, Math.min(1, mark.h))) * ph;
      // 박스 안에 이미지 aspect 유지로 맞춤(패딩 6pt), y=상단기준 → PDF 하단기준
      const pad = 6;
      const availW = Math.max(1, boxW - pad * 2);
      const availH = Math.max(1, boxH - pad * 2);
      const scale = Math.min(availW / png.width, availH / png.height);
      const dw = png.width * scale;
      const dh = png.height * scale;
      const dx = boxX + (boxW - dw) / 2;
      const dyTop = boxYTop + (boxH - dh) / 2;
      page.drawImage(png, { x: dx, y: ph - dyTop - dh, width: dw, height: dh });
      composed = true;
    }

    // fill-at-signing(A4) — 서명 완료 참가자의 기재값을 입력란(FIELD) 좌표에 텍스트 합성(한글 폰트 임베드)
    if (fieldMarks.length > 0) {
      let font: import('pdf-lib').PDFFont | null = null;
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        if (p.status !== 'SIGNED') continue;
        const signerNo = i + 1;
        const myFields = (meta.signMarks ?? []).map((m, index) => ({ m, index })).filter(({ m }) => m.type === 'FIELD' && m.signer === signerNo);
        if (!myFields.length) continue;
        // fail-closed(감사 §4-7) — 봉인 레코드가 있는데 복호·검증에 실패하면 **기재값이 빈 문서**가
        // 교부·검증본으로 나가는 것을 막고 오류로 중단한다(무결성 실패를 조용히 숨기지 않는다).
        let fills;
        try {
          fills = await this.getFillValues(requestId, p.participantId);
        } catch (e) {
          throw new ConflictException(`기재값 복호·무결성 검증 실패로 문서를 생성할 수 없습니다(${p.displayName}): ${(e as Error).message}`);
        }
        if (!fills?.length) continue;
        if (!font) {
          try {
            pdf.registerFontkit((await import('@pdf-lib/fontkit')).default);
            // subset 금지 — pdf.js(배치 편집기·검증 하니스)가 한글 서브셋을 못 읽는 기존 결함 회귀 방지
            font = await pdf.embedFont(readFileSync(join(process.cwd(), 'assets', 'fonts', 'NanumGothic-Regular.ttf')), { subset: false });
          } catch (e) {
            // 합성할 기재값이 있는데 폰트를 못 실으면 값이 빠진 문서가 만들어진다 → 중단(fail-closed)
            throw new ConflictException(`기재값 합성용 폰트를 불러오지 못했습니다: ${(e as Error).message}`);
          }
        }
        for (const { m, index } of myFields) {
          const value = fills.find((f) => f.index === index)?.value;
          if (!value) continue;
          const page = pages[Math.min(Math.max(1, Math.round(m.page)), pages.length) - 1];
          const { width: pw, height: ph } = page.getSize();
          const boxW = Math.max(0.02, Math.min(1, m.w)) * pw;
          const boxH = Math.max(0.015, Math.min(1, m.h)) * ph;
          const boxX = Math.min(Math.max(0, m.x), 1 - Math.max(0.02, Math.min(1, m.w))) * pw;
          const boxYTop = Math.min(Math.max(0, m.y), 1 - Math.max(0.015, Math.min(1, m.h))) * ph;
          const pad = 4;
          // 박스 맞춤(설계 §5 확정): 줄바꿈 → 축소(11→6pt) → 최후에만 말줄임
          const availW = Math.max(1, boxW - pad * 2);
          const availH = Math.max(1, boxH - pad * 2);
          const fnt = font;
          if (!fnt) break; // 폰트 임베드 실패 — 위에서 break 되므로 도달하지 않음(타입 좁힘)
          const laid = this.layoutFieldValue(fnt, value, availW, availH);
          if (laid.truncated) this.log.warn(`기재값 표시 잘림(${requestId} · ${(m.label ?? '').trim() || `입력란 ${index + 1}`}) — 입력란 박스가 작습니다`);
          const lineH = laid.size * FIELD_LINE_RATIO;
          const startTop = boxYTop + pad + Math.max(0, (availH - laid.lines.length * lineH) / 2);
          laid.lines.forEach((ln, li) => {
            page.drawText(ln, { x: boxX + pad, y: ph - (startTop + li * lineH) - laid.size, size: laid.size, font: fnt, color: rgb(0.1, 0.1, 0.25) });
          });
          composed = true;
        }
      }
    }

    // 체결(COMPLETED) 문서 — 각 페이지에 검증 QR 스탬프(스캔 시 공개 검증 페이지로 연결)
    if (isCompleted) {
      const stamped = await this.stampVerifyQr(pdf, pages, requestId, meta).catch((e) => {
        this.log.warn(`QR 스탬프 실패(무시): ${(e as Error).message}`);
        return false;
      });
      if (stamped) composed = true;
    }

    if (!composed) return { bytes: doc.bytes, contentType: doc.contentType };
    return { bytes: Buffer.from(await pdf.save({ useObjectStreams: false })), contentType: 'application/pdf' };
  }

  /** 완료문서 검증 토큰 — 계약당 1개(영구). 없으면 생성. 저장 직전 최신 메타 재확인으로 동시 조회 경합 축소. */
  private async ensureVerifyToken(requestId: string, meta: ContractMeta): Promise<string> {
    if (meta.verifyToken) return meta.verifyToken;
    // 읽기 경로 동시성 — 다른 요청/체결시점이 이미 발급했을 수 있으므로 최신 메타 재확인(중복 토큰·미아 방지)
    const fresh = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    if (fresh?.verifyToken) { meta.verifyToken = fresh.verifyToken; return fresh.verifyToken; }
    const token = randomBytes(18).toString('base64url');
    await this.store.saveMeta('ctverify:' + token, { requestId });
    await this.updateMeta(requestId, (m) => ({ ...m, verifyToken: token }));
    meta.verifyToken = token;
    return token;
  }

  /** 체결 시점 검증 토큰 선발급(공개 계약만) — 이후 문서 조회(GET)가 읽기 부작용 없이 기존 토큰만 사용. */
  private async ensureVerifyTokenAtCompletion(requestId: string): Promise<void> {
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(requestId));
    if (!meta || meta.hasAccessCode || meta.verifyToken) return; // 접근암호 계약은 미발급(공개 노출 방지)
    await this.ensureVerifyToken(requestId, meta).catch(() => undefined); // best-effort
  }

  /** 공개 검증(QR 스캔) — 토큰으로 계약 진위·서명 검증 요약 반환(인증 불요). 완료 계약만. */
  async verifyByToken(token: string): Promise<{
    title: string; status: string; completedAt: string | null; documentHash: string;
    signers: Array<{ displayName: string; type: string; signedAt: string | null }>;
    verified: boolean; signatureCount: number; auditChainValid: boolean;
    documentPublic: boolean; // D2 — 기재 정보가 있는 계약은 문서 비공개(요약 검증만)
  }> {
    this.assertEnabled();
    const rec = await this.store.getMeta<{ requestId: string }>('ctverify:' + token);
    if (!rec) throw new NotFoundException('유효하지 않은 검증 링크');
    const request = await this.store.getRequest(rec.requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) throw new NotFoundException('계약 없음');
    // 접근암호 보호·보관(제거) 계약은 공개 검증 제한(레거시 발급 토큰 방어) — 제목·서명자·해시 비노출
    const vmeta = await this.store.getMeta<ContractMeta>(this.metaKey(rec.requestId));
    if (vmeta?.hasAccessCode) throw new ForbiddenException('접근암호로 보호된 계약은 공개 검증이 제한됩니다');
    if (vmeta?.archived) throw new NotFoundException('보관 처리된 계약입니다');
    const v = await this.signSvc.verify(rec.requestId);
    const sigs = await this.store.signaturesByRequest(rec.requestId);
    const signedAtOf = (pid: string) => sigs.find((s) => s.participantId === pid)?.signedAt ?? null;
    const times = sigs.map((s) => s.signedAt).filter(Boolean).sort();
    return {
      title: request.title,
      status: request.status,
      completedAt: request.status === 'COMPLETED' ? (times[times.length - 1] ?? null) : null,
      documentHash: request.documentHash,
      signers: [...request.participants].sort((a, b) => a.signOrder - b.signOrder).map((p) => ({
        displayName: p.displayName,
        type: p.signerType === INTERNAL_SIGNER_TYPE ? 'INTERNAL' : 'EXTERNAL',
        signedAt: p.status === 'SIGNED' ? signedAtOf(p.participantId) : null,
      })),
      verified: v.overall,
      signatureCount: v.signatures.length,
      auditChainValid: v.auditChainValid,
      // 기재 정보가 봉인된 계약은 문서 비공개(D2) — 공개 페이지가 다운로드 대신 안내를 띄운다
      documentPublic: !(await this.hasSealedFill(rec.requestId, request)),
    };
  }

  /** 공개 검증용 문서(합성본, 인증 불요) — 토큰으로 해소. */
  async documentByVerifyToken(token: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    this.assertEnabled();
    const rec = await this.store.getMeta<{ requestId: string }>('ctverify:' + token);
    if (!rec) throw new NotFoundException('유효하지 않은 검증 링크');
    const meta = await this.store.getMeta<ContractMeta>(this.metaKey(rec.requestId));
    if (meta?.hasAccessCode) throw new ForbiddenException('접근암호로 보호된 계약은 공개 문서 열람이 제한됩니다');
    if (meta?.archived) throw new NotFoundException('보관 처리된 계약입니다');
    // D2 — 기재값(계좌번호·주소 등 구조화 PII)이 봉인된 계약은 **문서 자체를 공개하지 않는다**.
    // 진위 확인(요약·서명 검증)은 그대로 공개되며, 문서 사본은 만료형 교부 링크로만 제공한다.
    const request = await this.store.getRequest(rec.requestId);
    if (request && (await this.hasSealedFill(rec.requestId, request))) {
      throw new ForbiddenException('기재 정보가 포함된 계약은 공개 링크로 문서를 열람할 수 없습니다(교부 링크를 이용하세요)');
    }
    return this.renderSignedDocument(rec.requestId);
  }

  /** 검증 QR 스탬프 — 각 페이지 우하단에 공개 검증 링크 QR + 라벨. baseUrl 없으면 스킵. */
  private async stampVerifyQr(pdf: PDFDocument, pages: PDFPage[], requestId: string, meta: ContractMeta): Promise<boolean> {
    if (meta.hasAccessCode) return false; // 접근암호 보호 계약 → 공개 QR/검증토큰 미발급(본문·서명자 유출 방지)
    const base = meta.lastBaseUrl ?? this.config.get<string>('CONTRACT_PORTAL_BASE_URL');
    if (!base) return false; // 절대 URL 불가 → QR 생략
    const token = await this.ensureVerifyToken(requestId, meta);
    const link = base.replace(/\/$/, '') + '/contracts/verify/' + token;
    const qrBuf = await QRCode.toBuffer(link, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' });
    const qr = await pdf.embedPng(qrBuf);
    const font = await pdf.embedFont(StandardFonts.Helvetica); // ASCII 라벨(내장 폰트, 파일 불필요)
    const gray = rgb(0.35, 0.4, 0.48);
    const size = 46; // QR 한 변(pt)
    const pad = 18;
    for (const page of pages) {
      const { width: pw } = page.getSize();
      const x = pw - pad - size;
      page.drawImage(qr, { x, y: pad + 8, width: size, height: size });
      page.drawText('SCAN TO VERIFY', { x: x - 4, y: pad, size: 5.5, font, color: gray });
    }
    return true;
  }

  /** 참가자별 손글씨 서명 보유 여부(상세 뷰용). */
  async signatureImageParticipants(requestId: string): Promise<string[]> {
    this.assertEnabled();
    const { request } = await this.assertContract(requestId);
    const out: string[] = [];
    for (const p of request.participants) {
      if (await this.store.getMeta(this.signImageKey(requestId, p.participantId))) out.push(p.participantId);
    }
    return out;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private async assertContract(requestId: string) {
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) throw new NotFoundException('계약 없음');
    const meta = (await this.store.getMeta<ContractMeta>(this.metaKey(requestId))) ?? {
      labels: [],
      createdBy: '',
      hasAccessCode: false,
      parties: [],
    };
    return { request, meta };
  }

  /** 내부 서명자 알림 이메일 해소 — 계약 지정 이메일 우선, 없으면 콘솔 계정 등록 이메일. */
  private resolveInternalEmail(meta: ContractMeta, username: string): string | undefined {
    const notify = (meta.internalNotify ?? []).find((x) => x.username === username);
    if (notify?.email) return notify.email;
    return this.adminUsers.getActive(username)?.email;
  }

  /**
   * 현재 서명 차례가 된 내부 서명자에게 콘솔 서명 요청 이메일 발송(best-effort).
   * 순차=현재 pending 이 내부면 그 1명, 동시=미서명 내부 전원. 이메일 없으면 스킵(콘솔에서만 서명).
   */
  private async notifyDueInternalSigners(requestId: string, force = false): Promise<void> {
    try {
      const { request, meta } = await this.assertContract(requestId);
      const base = meta.lastBaseUrl;
      if (!base) return; // 발송 이력 없으면 콘솔 base 미상 — 스킵
      if (request.status !== 'CREATED' && request.status !== 'IN_PROGRESS') return;
      let due: typeof request.participants = [];
      if ((meta.signingMode ?? 'SEQUENTIAL') === 'PARALLEL') {
        due = request.participants.filter((p) => p.signerType === INTERNAL_SIGNER_TYPE && p.status !== 'SIGNED');
      } else {
        const pending = [...request.participants].sort((a, b) => a.signOrder - b.signOrder).find((p) => p.status !== 'SIGNED');
        if (pending && pending.signerType === INTERNAL_SIGNER_TYPE) due = [pending];
      }
      // 이미 알림한 참가자는 재발송 안 함(PARALLEL 에서 타 참가자 행동마다 전원 재발송되는 중복 방지). 독촉(force)은 예외.
      const already = new Set(meta.internalNotified ?? []);
      const recipients = due
        .filter((p) => force || !already.has(p.participantId))
        .map((p) => ({ participantId: p.participantId, to: this.resolveInternalEmail(meta, p.externalSignerRef ?? '') }))
        .filter((r): r is { participantId: string; to: string } => !!r.to);
      if (!recipients.length) return;
      await this.notify.notifyInternalSigners(requestId, base, recipients);
      const notified = Array.from(new Set([...(meta.internalNotified ?? []), ...recipients.map((r) => r.participantId)]));
      await this.updateMeta(requestId, (m) => ({ ...m, internalNotified: notified }));
      await this.recordContractAudit(requestId, 'CONTRACT_INTERNAL_NOTIFIED', { recipients: recipients.length });
    } catch (e) {
      this.log.warn(`내부 서명자 알림 실패(무시): ${(e as Error).message}`);
    }
  }

  /**
   * 계약 봉투 전량 스캔(페이지 반복) — 집계용. 단발 상한(10k)으로 끊으면 초과 기관에서
   * 조용히 부정확한 수치가 나온다. 폭주 방지 상한(SCAN_HARD_CAP)에 도달하면 경고를 남긴다.
   */
  private async scanAllContracts(filter: { archived?: boolean; incomplete?: boolean } = {}): Promise<StoredRequest[]> {
    const PAGE = 1000;
    const SCAN_HARD_CAP = 200_000;
    const out: StoredRequest[] = [];
    for (let offset = 0; offset < SCAN_HARD_CAP; offset += PAGE) {
      const { items, total } = await this.store.queryRequests({ signMode: CONTRACT_SIGN_MODE, offset, limit: PAGE, ...filter });
      out.push(...items);
      if (!items.length || out.length >= total) return out;
      if (offset + PAGE >= SCAN_HARD_CAP) this.log.warn(`계약 집계 스캔 상한(${SCAN_HARD_CAP}) 도달 — 수치 부정확 가능`);
    }
    return out;
  }

  /** 계약 감사 — 전용 해시체인 스트림 `contract:<id>` 봉인(approval 동형). */
  private async recordContractAudit(requestId: string, eventType: string, data: Record<string, unknown>): Promise<void> {
    const key = this.contractKey(requestId);
    // 첨부 서비스와 스트림을 공유 — AuditChainService(싱글턴)의 스트림 단위 잠금으로 직렬화
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { requestId, ...data }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}
