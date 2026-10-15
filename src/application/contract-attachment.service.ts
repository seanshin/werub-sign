// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { KeyedMutex } from '../domain/keyed-mutex';
import { casUpdateMeta } from '../domain/meta-cas';
import { SecretBox, SealedSecret } from '../infrastructure/crypto/secret-box';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';

/**
 * 계약 첨부 문서(백로그 A1) — 열람용 부속 문서(견적서·사업자등록증 등). 설계 §11.
 *  - 서명 대상 아님(주 문서 documentHash 단독 봉인). 첨부 SHA-256 은 추가 시 감사 봉인(열람 무결성 증거).
 *  - 추가/삭제는 작성(CREATED·미발송) 상태에서만 — 발송 후 불변(서명자 열람 정합).
 *  - SecretBox 암호화 영구 보관(원본과 동형), 목록 RMW 는 KeyedMutex 직렬화.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const CONTRACT_SIGN_MODE = 'CONTRACT';
const MAX_COUNT = 10; // 계약당 첨부 상한
const ALLOWED_TYPES: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

export interface AttachmentRec {
  attachId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * blob 저장 형식 — 슬롯 `ctattach:<req>:<aid>` 에 들어간다.
 *  - v1(레거시): 파일 전체를 단일 `sealed` 로. 읽을 때 **전량 메모리 적재**(R9 의 결함).
 *  - v2: 매니페스트만 두고 실제 바이트는 `…:c0`, `…:c1` … 청크 슬롯에 나눠 담는다.
 *    읽기는 청크 단위 복호·검증 후 즉시 방출 → 피크 힙이 파일 크기가 아니라 **청크 하나**로 고정된다.
 * 기존 데이터를 옮기지 않고 두 형식을 함께 읽는다(dual-read) — 마이그레이션 불필요.
 */
type AttachmentBlob = { sealed: SealedSecret } | AttachmentManifest;

interface AttachmentManifest {
  v: 2;
  chunkBytes: number; // 평문 기준 청크 크기(마지막 청크는 이보다 작을 수 있음)
  /** 청크별 평문 SHA-256 — 방출 **전에** 검증해 손상 바이트가 클라이언트로 나가지 않게 한다. */
  parts: Array<{ sha256: string; bytes: number }>;
}

interface AttachmentChunk {
  sealed: SealedSecret;
}

/** 청크 크기 — 피크 힙(평문+암호문+base64 ≈ 3배)과 행 수의 절충. 10MB 첨부 = 40행. */
const CHUNK_BYTES = 256 * 1024;

function isManifest(b: AttachmentBlob): b is AttachmentManifest {
  return (b as AttachmentManifest).v === 2;
}

@Injectable()
export class ContractAttachmentService {
  private readonly box = new SecretBox(process.env.CRYPTO_MASTER_KEY);
  private readonly mutex = new KeyedMutex();

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
    private readonly config: ConfigService,
  ) {}

  private listKey(requestId: string): string {
    return `ctattach:${requestId}`;
  }
  private blobKey(requestId: string, attachId: string): string {
    return `ctattach:${requestId}:${attachId}`;
  }
  private chunkKey(requestId: string, attachId: string, i: number): string {
    return `${this.blobKey(requestId, attachId)}:c${i}`;
  }

  /**
   * 청크 분할 저장(R9) — 청크 먼저, 매니페스트는 마지막(반쪽 blob 이 읽히지 않도록).
   * 중간 실패 시 매니페스트가 없어 **고아 청크를 되찾을 방법이 없으므로**, 여기서 직접 되감는다.
   */
  private async writeBlob(requestId: string, attachId: string, bytes: Buffer): Promise<void> {
    const parts: AttachmentManifest['parts'] = [];
    let written = 0;
    try {
      for (let off = 0, i = 0; off < bytes.length; off += CHUNK_BYTES, i++) {
        const chunk = bytes.subarray(off, Math.min(off + CHUNK_BYTES, bytes.length));
        await this.store.saveMeta(this.chunkKey(requestId, attachId, i), { sealed: this.box.sealBytes(chunk) } satisfies AttachmentChunk);
        written = i + 1;
        parts.push({ sha256: createHash('sha256').update(chunk).digest('hex'), bytes: chunk.length });
      }
      await this.store.saveMeta(this.blobKey(requestId, attachId), { v: 2, chunkBytes: CHUNK_BYTES, parts } satisfies AttachmentManifest);
    } catch (e) {
      for (let i = 0; i < written; i++) await this.store.deleteMeta(this.chunkKey(requestId, attachId, i)).catch(() => undefined);
      await this.store.deleteMeta(this.blobKey(requestId, attachId)).catch(() => undefined);
      throw e;
    }
  }

  /** 매니페스트+청크 전량 파기 — 매니페스트 먼저(참조를 끊고 나서 본문). v1 은 슬롯 하나뿐. */
  private async deleteBlob(requestId: string, attachId: string): Promise<void> {
    const blob = await this.store.getMeta<AttachmentBlob>(this.blobKey(requestId, attachId));
    await this.store.deleteMeta(this.blobKey(requestId, attachId));
    if (blob && isManifest(blob)) {
      for (let i = 0; i < blob.parts.length; i++) await this.store.deleteMeta(this.chunkKey(requestId, attachId, i));
    }
  }

  /**
   * 복호 스트림(R9) — 청크를 하나씩 읽어 복호·해시 검증한 뒤 방출한다.
   * 검증을 방출 **전에** 하므로 손상된 바이트는 나가지 않고, 그 지점에서 스트림이 error 로 끊긴다
   * (클라이언트는 불완전 응답으로 감지). 피크 힙 = 청크 1개.
   */
  private blobStream(requestId: string, attachId: string, blob: AttachmentBlob, rec: AttachmentRec): Readable {
    if (!isManifest(blob)) {
      // v1 레거시 — 단일 슬롯. 전량 적재는 불가피하나 전체 해시를 방출 전에 검증한다(기존 동작 유지).
      const bytes = this.box.openBytes(blob.sealed);
      if (createHash('sha256').update(bytes).digest('hex') !== rec.sha256) {
        return Readable.from(
          (async function* () {
            throw new ConflictException('첨부 무결성 오류(해시 불일치)');
          })(),
        );
      }
      return Readable.from([bytes]);
    }
    const self = this;
    return Readable.from(
      (async function* () {
        for (let i = 0; i < blob.parts.length; i++) {
          const c = await self.store.getMeta<AttachmentChunk>(self.chunkKey(requestId, attachId, i));
          if (!c) throw new ConflictException(`첨부 무결성 오류(청크 ${i} 누락)`);
          const plain = self.box.openBytes(c.sealed);
          if (createHash('sha256').update(plain).digest('hex') !== blob.parts[i].sha256) {
            throw new ConflictException(`첨부 무결성 오류(청크 ${i} 해시 불일치)`);
          }
          yield plain;
        }
      })(),
    );
  }
  private maxBytes(): number {
    // 오타·비정상 env 로 NaN 이 되면 상한 비교가 항상 false 가 되어 크기 제한이 사라진다 → 기본값 폴백
    const raw = Number(this.config.get<string>('CONTRACT_ATTACH_MAX_MB') ?? 10);
    return Math.max(1, Number.isFinite(raw) ? raw : 10) * 1024 * 1024;
  }

  /** 계약 확인 — 기능 비활성/계약 트랙 봉투가 아니면 404. 반환=요청·계약 meta(정책 판정용). */
  private async assertContract(requestId: string) {
    const flag = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    if (!(flag === 'on' || flag === 'true' || flag === '1')) throw new NotFoundException('일반 전자계약 기능 비활성');
    const request = await this.store.getRequest(requestId);
    if (!request || request.signMode !== CONTRACT_SIGN_MODE) throw new NotFoundException('계약 없음');
    const meta = await this.store.getMeta<{ lastSentAt?: string; archived?: boolean }>(`contract-meta:${requestId}`);
    return { request, meta };
  }

  /** 변경(추가/삭제) 가능 상태 — 작성(CREATED)·미발송·미보관만. */
  private assertMutable(request: { status: string }, meta: { lastSentAt?: string; archived?: boolean } | null) {
    if (meta?.archived) throw new ConflictException('보관된 계약은 첨부를 변경할 수 없습니다');
    if (request.status !== 'CREATED' || meta?.lastSentAt) {
      throw new ConflictException('첨부는 작성(미발송) 상태에서만 추가/삭제 가능합니다(서명자 열람 정합)');
    }
  }

  private sanitizeName(raw: string, contentType: string): string {
    // eslint-disable-next-line no-control-regex
    const base = (raw ?? '').normalize('NFC').replace(/[\x00-\x1f/\\]/g, '').trim().slice(0, 120);
    if (base) return base;
    return `attachment${ALLOWED_TYPES[contentType]}`;
  }

  private async recordAudit(requestId: string, eventType: string, data: Record<string, unknown>): Promise<void> {
    const key = `contract:${requestId}`;
    // ContractService 와 **같은 스트림**을 쓰므로 공용 직렬화 필수(교부·포털 동시 다운로드 시 체인 파손 방지)
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { requestId, ...data }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }

  /** 첨부 추가 — 작성 상태 한정, 형식·크기·건수 검증, SHA-256 감사 봉인. */
  async add(requestId: string, bytes: Buffer, contentType: string, name: string, actor: string): Promise<AttachmentRec> {
    await this.assertContract(requestId); // 존재 확인 — 불변 정책 판정은 잠금 안에서 최신 meta 로(R10)
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES[type]) throw new BadRequestException('허용 형식: PDF·PNG·JPEG');
    if (!bytes?.length) throw new BadRequestException('빈 파일');
    if (bytes.length > this.maxBytes()) throw new BadRequestException(`첨부 최대 ${Math.floor(this.maxBytes() / 1024 / 1024)}MB`);
    // 매직바이트 검증 — Content-Type 헤더만 믿으면 임의 바이너리가 '이미지'로 저장·서빙된다
    if (!this.magicOk(type, bytes)) throw new BadRequestException(`${type} 형식 오류(파일 시그니처 불일치)`);

    const rec = await this.mutex.run(this.listKey(requestId), async () => {
      const { request, meta } = await this.assertContract(requestId);
      this.assertMutable(request, meta); // 발송(lastSentAt)과의 경합 — 잠금 안에서 재판정
      const rec: AttachmentRec = {
        attachId: randomUUID(),
        name: this.sanitizeName(name, type),
        contentType: type,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uploadedAt: new Date().toISOString(),
        uploadedBy: actor,
      };
      // blob 먼저 — 목록에 등재됐는데 본문이 없는 상태(깨진 링크)보다, 잠깐 고아 blob 이 낫다
      await this.writeBlob(requestId, rec.attachId, bytes);
      // 목록 등재는 CAS — 다른 노드가 동시에 첨부를 추가/삭제해도 통째로 덮어쓰지 않는다(R16).
      // 등재에 실패하면(상한 초과·경합 소진 등 어느 경로든) 방금 쓴 blob 을 반드시 회수한다.
      let ok = false;
      try {
        ok = await casUpdateMeta<AttachmentRec[], boolean>(this.store, this.listKey(requestId), (cur) => {
          const list = cur ?? [];
          if (list.length >= MAX_COUNT) return { result: false };
          return { write: [...list, rec], result: true };
        });
      } catch (e) {
        await this.deleteBlob(requestId, rec.attachId).catch(() => undefined);
        throw e;
      }
      if (!ok) {
        await this.deleteBlob(requestId, rec.attachId).catch(() => undefined); // 등재 실패분 회수
        throw new BadRequestException(`계약당 첨부 최대 ${MAX_COUNT}건`);
      }
      return rec;
    });
    await this.recordAudit(requestId, 'CONTRACT_ATTACHMENT_ADDED', { actor, attachId: rec.attachId, name: rec.name, sha256: rec.sha256, sizeBytes: rec.sizeBytes });
    return rec;
  }

  /**
   * 보존 sweep(D7) — **기본은 영구 보관**(계약 원본과 동일 정책). 기관 보존연한이 정해진 경우에만
   * `CONTRACT_ATTACH_RETAIN_DAYS` 로 활성화하며, **종결(COMPLETED·EXPIRED·WITHDRAWN)된 계약**의
   * 첨부만 대상으로 한다(진행 중 계약은 절대 파기하지 않는다). 파기는 감사에 봉인한다.
   * 반환: 파기 건수.
   */
  async sweep(): Promise<{ purged: number }> {
    const days = Number(this.config.get<string>('CONTRACT_ATTACH_RETAIN_DAYS') ?? '');
    if (!Number.isFinite(days) || days <= 0) return { purged: 0 }; // 미설정 = 영구 보관(기본)
    const cutoff = Date.now() - days * 86_400_000;
    const TERMINAL = new Set(['COMPLETED', 'EXPIRED', 'WITHDRAWN']);
    let purged = 0;
    const { items } = await this.store.queryRequests({ signMode: CONTRACT_SIGN_MODE, offset: 0, limit: 1000 });
    for (const r of items) {
      if (!TERMINAL.has(r.status)) continue;
      const list = (await this.store.getMeta<AttachmentRec[]>(this.listKey(r.requestId))) ?? [];
      if (!list.length) continue;
      const expired = list.filter((a) => Date.parse(a.uploadedAt) <= cutoff);
      if (!expired.length) continue;
      const dropped = await this.mutex.run(this.listKey(r.requestId), async () => {
        const cur = (await this.store.getMeta<AttachmentRec[]>(this.listKey(r.requestId))) ?? [];
        const expiredNow = cur.filter((a) => Date.parse(a.uploadedAt) <= cutoff);
        // 파기(blob) 먼저, 목록 제거는 CAS — 추가 순서·근거는 remove() 와 동일(R12·R16)
        for (const a of expiredNow) await this.deleteBlob(r.requestId, a.attachId);
        const purgedIds = new Set(expiredNow.map((a) => a.attachId));
        await casUpdateMeta<AttachmentRec[], void>(this.store, this.listKey(r.requestId), (list) => ({
          write: (list ?? []).filter((a) => !purgedIds.has(a.attachId)),
          result: undefined,
        }));
        return expiredNow;
      });
      for (const a of dropped) {
        await this.recordAudit(r.requestId, 'CONTRACT_ATTACHMENT_PURGED', { actor: 'system:retention', attachId: a.attachId, name: a.name, sha256: a.sha256, retainDays: days }).catch(() => undefined);
        purged++;
      }
    }
    return { purged };
  }

  /** 형식별 파일 시그니처 검증(PDF·PNG·JPEG). */
  private magicOk(type: string, b: Buffer): boolean {
    if (type === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
    if (type === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    return false;
  }

  /** 첨부 목록(메타만 — blob 미포함). */
  async list(requestId: string): Promise<AttachmentRec[]> {
    await this.assertContract(requestId);
    return (await this.store.getMeta<AttachmentRec[]>(this.listKey(requestId))) ?? [];
  }

  /**
   * 첨부 다운로드(복호화·해시 재검증) — **스트림 반환**(R9).
   * 예전에는 파일 전체를 복호·해시·버퍼링한 뒤 응답했다: 10MB×10건 교부 링크를 동시 열람하면
   * 요청당 30MB+ 가 힙에 동시 상주했다. 이제 청크 단위로 검증·방출해 피크가 청크 하나로 고정된다.
   * via=CONSOLE|PORTAL|DELIVERY — 포털/교부는 접근 감사(best-effort).
   */
  async fetch(requestId: string, attachId: string, ctx?: { via: string; actor?: string; ip?: string }): Promise<{ stream: Readable; rec: AttachmentRec }> {
    await this.assertContract(requestId);
    const rec = ((await this.store.getMeta<AttachmentRec[]>(this.listKey(requestId))) ?? []).find((a) => a.attachId === attachId);
    if (!rec) throw new NotFoundException('첨부 없음');
    const blob = await this.store.getMeta<AttachmentBlob>(this.blobKey(requestId, attachId));
    if (!blob) throw new NotFoundException('첨부 데이터 없음');
    // 콘솔(내부자) 다운로드도 기록 — 첨부는 사업자등록증 등 민감정보라 내부 열람 추적이 필요
    if (ctx) {
      await this.recordAudit(requestId, 'CONTRACT_ATTACHMENT_ACCESSED', { actor: ctx.actor ?? 'anonymous', via: ctx.via, attachId, name: rec.name, ip: ctx.ip }).catch(() => undefined);
    }
    return { stream: this.blobStream(requestId, attachId, blob, rec), rec };
  }

  /** 첨부 삭제 — 작성 상태 한정(멱등). */
  async remove(requestId: string, attachId: string, actor: string): Promise<{ removed: boolean }> {
    await this.assertContract(requestId); // 존재 확인만 — 상태 판정은 잠금 안에서 최신 meta 로(R10)
    const rec = await this.mutex.run(this.listKey(requestId), async () => {
      const { request, meta } = await this.assertContract(requestId);
      this.assertMutable(request, meta); // 발송 직후 경합 방지 — 잠금 안에서 재판정
      const list = (await this.store.getMeta<AttachmentRec[]>(this.listKey(requestId))) ?? [];
      const found = list.find((a) => a.attachId === attachId);
      if (!found) return null; // 멱등 — 이미 없음
      // blob 먼저 파기 — 목록만 지우고 blob 삭제가 실패하면 감사에는 REMOVED 인데 암호문이 남는다(R12)
      await this.deleteBlob(requestId, attachId);
      // 목록 제거는 CAS — 동시 추가와 겹쳐도 상대의 추가분을 되돌리지 않는다(R16)
      await casUpdateMeta<AttachmentRec[], void>(this.store, this.listKey(requestId), (cur) => ({
        write: (cur ?? []).filter((a) => a.attachId !== attachId),
        result: undefined,
      }));
      return found;
    });
    if (!rec) return { removed: false };
    await this.recordAudit(requestId, 'CONTRACT_ATTACHMENT_REMOVED', { actor, attachId, name: rec.name, sha256: rec.sha256 });
    return { removed: true };
  }
}
