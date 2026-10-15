// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ConflictException, GoneException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { SecretBox, SealedSecret } from '../infrastructure/crypto/secret-box';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';

/**
 * 서명창 한정 암호화 문서 블롭 — meta KV(`docblob:<requestId>`)에 봉인 저장(Option A, 설계 §3.2).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
interface StoredDocBlob {
  sealed: SealedSecret; // AES-256-GCM(원본 PDF 바이트)
  sha256: string; // hex, == request.documentHash
  contentType: string;
  sizeBytes: number;
  uploadedAt: string; // ISO
  expiresAt: string; // ISO — TTL 파기 시점
  persistent?: boolean; // 일반 전자계약(signMode=CONTRACT) 원본 영구 보관 — TTL·sweep 미적용(design general-contracts D4)
}

const BLOB_PREFIX = 'docblob:';
/** 문서 파기 대상 종료 상태 — 서명창 종료(IN_PROGRESS·CREATED는 미서명 참가자가 열람 필요이므로 유지). */
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'EXPIRED', 'REVOKED', 'WITHDRAWN', 'SUPERSEDED', 'FAILED']);

/**
 * 환자 포털 문서 미리보기 — 서명 대상 PDF의 암호화 임시보관·열람·파기 (설계 docs/02-design/features/portal-document-preview.design.md, Option A).
 *  - 업로드: caller PDF → SHA-256 == documentHash 검증 → AES-256-GCM 봉인 저장(서명창 한정).
 *  - 열람: 복호화 → 해시 재검증(WYSIWYS) → 바이트 반환 + DOCUMENT_VIEWED 접속기록(F008).
 *  - 파기: 종료 상태·TTL 경과 시 sweep 파기(영구 PHI 저장소 아님).
 * 기본 비활성(PORTAL_DOC_PREVIEW=off) — 보안검토 후 caller별 활성.
 */
@Injectable()
export class PortalDocumentService {
  private readonly log = new Logger('PortalDocument');
  private readonly box = new SecretBox(process.env.CRYPTO_MASTER_KEY);

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
    private readonly config: ConfigService,
  ) {}

  /** 기능 활성 여부 — 기본 OFF(보안검토 전 PHI 저장 방지). PORTAL_DOC_PREVIEW=on|true 로 활성. */
  enabled(): boolean {
    const v = (this.config.get<string>('PORTAL_DOC_PREVIEW') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }

  /** 일반 전자계약 트랙 활성 여부 — 계약 문서는 이 플래그로 게이팅(동의서 미리보기와 독립). */
  contractsEnabled(): boolean {
    const v = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }

  private maxBytes(): number {
    return Math.max(1, Number(this.config.get<string>('PORTAL_DOC_MAX_MB') ?? 20)) * 1024 * 1024;
  }
  private ttlMs(): number {
    return Math.max(1, Number(this.config.get<string>('PORTAL_DOC_RETENTION_HOURS') ?? 48)) * 60 * 60 * 1000;
  }
  private key(requestId: string): string {
    return BLOB_PREFIX + requestId;
  }

  /** caller 업로드 — 해시·형식·크기 검증 후 봉인 저장. 표시 문서 == 서명 대상 보증. */
  async save(requestId: string, bytes: Buffer, contentType: string, uploadedAtIso: string): Promise<{ sha256: string; sizeBytes: number; expiresAt: string }> {
    const req = await this.store.getRequest(requestId);
    if (!req) throw new NotFoundException('request not found');
    // 계약 트랙(CONTRACT) 문서는 GENERAL_CONTRACTS, 동의서 미리보기는 PORTAL_DOC_PREVIEW 로 각각 게이팅.
    const isContract = req.signMode === 'CONTRACT';
    if (isContract ? !this.contractsEnabled() : !this.enabled()) throw new NotFoundException('문서 저장 기능 비활성');
    if (TERMINAL.has(req.status)) throw new ConflictException(`종료된 요청(${req.status})에는 문서를 업로드할 수 없습니다`);
    if (!bytes || bytes.length === 0) throw new BadRequestException('문서 바이트가 비어 있습니다');
    if (bytes.length > this.maxBytes()) throw new PayloadTooLargeException(`문서가 상한(${this.maxBytes()} bytes)을 초과합니다`);
    // %PDF 매직 — 스캔/이미지 PDF 포함 표준 PDF만. (암호걸린 PDF는 렌더 불가·별도 거부는 뷰어 단계.)
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new UnsupportedMediaTypeException('PDF(%PDF-) 형식만 허용됩니다');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256.toLowerCase() !== req.documentHash.toLowerCase()) {
      throw new UnprocessableEntityException('업로드 문서의 SHA-256 이 요청 documentHash 와 불일치 — 위변조/오문서 차단');
    }
    const expiresAt = new Date(new Date(uploadedAtIso).getTime() + this.ttlMs()).toISOString();
    const blob: StoredDocBlob = { sealed: this.box.sealBytes(bytes), sha256, contentType: 'application/pdf', sizeBytes: bytes.length, uploadedAt: uploadedAtIso, expiresAt, persistent: isContract };
    await this.store.saveMeta(this.key(requestId), blob);
    return { sha256, sizeBytes: bytes.length, expiresAt };
  }

  /** 저장 문서 조회 — 복호화·해시 재검증(방어심층). 미보유=null(→404), TTL 경과=Gone(→410, 지연 파기). */
  async fetch(requestId: string): Promise<{ bytes: Buffer; contentType: string; sha256: string } | null> {
    const blob = await this.store.getMeta<StoredDocBlob>(this.key(requestId));
    if (!blob) return null;
    if (!blob.persistent && Date.parse(blob.expiresAt) <= Date.now()) {
      await this.store.deleteMeta(this.key(requestId)); // 지연 파기
      throw new GoneException('문서 보존기간이 경과하여 파기되었습니다');
    }
    const bytes = this.box.openBytes(blob.sealed);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256.toLowerCase() !== blob.sha256.toLowerCase()) throw new UnprocessableEntityException('저장 문서 무결성 검증 실패');
    return { bytes, contentType: blob.contentType, sha256 };
  }

  /** 열람 가능 여부(뷰 투영용) — 저장·미만료. */
  async has(requestId: string): Promise<boolean> {
    const blob = await this.store.getMeta<StoredDocBlob>(this.key(requestId));
    return !!blob && (blob.persistent === true || Date.parse(blob.expiresAt) > Date.now());
  }

  /**
   * 보관 여부만 확인(만료 판정 없음) — 값(암호화 PDF 전체)을 읽지 않는 경량 경로.
   * 계약 트랙 문서는 영구 보관(persistent)이라 `has()` 와 동치이며, 목록처럼 행마다 확인하는 곳에서 쓴다.
   */
  async exists(requestId: string): Promise<boolean> {
    return this.store.metaExists(this.key(requestId));
  }

  /** 문서 파기(멱등). */
  async purge(requestId: string): Promise<void> {
    await this.store.deleteMeta(this.key(requestId));
  }

  /** 접속기록(F008) — 문서 열람을 전용 해시체인(docaccess:<requestId>)에 봉인. */
  async recordView(requestId: string, ctx: { participantId?: string; ip?: string; via: string }, occurredAtIso: string): Promise<void> {
    try {
      const key = 'docaccess:' + requestId;
      // 동시 열람이 잦은 스트림 — 직렬화+저장소 충돌 재시도(R16) 없이는 체인이 분기한다
      await this.audit.appendSerialized(key, async () => {
        const prev = await this.store.lastAudit(key);
        const entry = this.audit.next(prev, 'DOCUMENT_VIEWED', { requestId, participantId: ctx.participantId, ip: ctx.ip, via: ctx.via }, occurredAtIso);
        await this.store.appendAudit(key, entry);
      });
    } catch (e) {
      this.log.warn(`DOCUMENT_VIEWED 기록 실패(${requestId}): ${(e as Error).message}`); // 접속기록 실패가 열람을 막지 않도록
    }
  }

  /** 보존 sweep — 종료 상태 또는 TTL 경과 문서 파기. 스케줄러 주기 호출(설계 §3.3). */
  async sweep(): Promise<{ purged: number }> {
    let purged = 0;
    const now = Date.now();
    for (const req of await this.store.allRequests()) {
      const blob = await this.store.getMeta<StoredDocBlob>(this.key(req.requestId));
      if (!blob) continue;
      if (blob.persistent) continue; // 계약 원본 영구 보관 — 보존기간 정책 확정 시 별도 잡(설계 §9)
      if (TERMINAL.has(req.status) || Date.parse(blob.expiresAt) <= now) {
        await this.store.deleteMeta(this.key(req.requestId));
        purged++;
      }
    }
    return { purged };
  }
}
