// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { SignStore } from '../../domain/ports/sign-store.port';
import {
  AuditEntry,
  Revocation,
  StoredAnchor,
  StoredCert,
  StoredIdentity,
  StoredRequest,
  StoredSignature,
  WebhookDelivery,
  NotifyRecord,
} from '../../domain/types/store.types';
import { PrismaService } from '../prisma/prisma.service';
import { RequestQuery, requestSearchText, INCOMPLETE_STATUSES } from '../../domain/request-query';
import { CertQuery, certSearchText } from '../../domain/cert-query';
import { StoreConflictError } from '../../domain/store-conflict.error';

/**
 * Prisma(PostgreSQL) SignStore 어댑터 — 운영 영속화 (FR-12 / design §3).
 * SIGN_STORE 포트 드롭인: STORE_DRIVER=prisma + DB_URL 설정 시 사용.
 * store_records 테이블에 lossless JSON으로 즉시 영속화(리치 관계형 모델은 분석/조회용).
 *
 * NOTE: 본 어댑터는 `prisma generate`로 컴파일 검증됨. 라이브 PostgreSQL 통합 테스트는
 * DB 환경에서 수행 필요(개발 환경 PG 부재). 마이그레이션: `prisma migrate dev`.
 */
/**
 * LIKE 메타문자 이스케이프 — Prisma 의 `contains` 는 값을 그대로 `%...%` 패턴에 넣어(escape 없음)
 * 사용자가 `%`·`_` 를 넣으면 **전건 매칭**이 된다(실측: `?q=%` → 전체 반환).
 * PostgreSQL LIKE 기본 escape 문자인 백슬래시로 escape 한다(실측 확인: `%` → 0건, 한글 검색 결과 불변).
 */
function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * PostgreSQL 유니크 위반(23505) 판별 — Prisma 는 `P2002` 로 감싸지만, 원시 드라이버 오류가
 * 그대로 올라오는 경로(raw·트랜잭션 내부)도 있어 두 형태를 모두 본다.
 */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err?.code === 'P2002' || err?.code === '23505' || err?.meta?.code === '23505';
}

@Injectable()
export class PrismaSignStore implements SignStore {
  constructor(private readonly prisma: PrismaService) {}

  // ── 단일 레코드 upsert (kind+rkey 유일) ──
  /**
   * delete+create 를 한 트랜잭션으로. kind='meta' 는 유니크 인덱스(0009)가 걸려 있어, 다른 노드가
   * 같은 슬롯을 동시에 갱신하면 create 가 23505 로 튕길 수 있다(이전에는 조용히 중복행이 생겼다).
   * 마지막 쓰기 승리(last-write-wins) 시맨틱을 유지하려면 **다시 시도**하는 것이 맞다 —
   * 순서를 지켜야 하는 read-modify-write 는 `saveMetaIfUnchanged`(CAS) 를 쓴다.
   */
  private async putOne(kind: string, rkey: string, data: unknown): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prisma.$transaction([
          this.prisma.storeRecord.deleteMany({ where: { kind, rkey } }),
          this.prisma.storeRecord.create({ data: { kind, rkey, data: data as object } }),
        ]);
        return;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 5 * 2 ** attempt));
      }
    }
  }
  private async getOne<T>(kind: string, rkey: string): Promise<T | null> {
    const row = await this.prisma.storeRecord.findFirst({ where: { kind, rkey }, orderBy: { seq: 'desc' } });
    return row ? (row.data as T) : null;
  }
  private async list<T>(kind: string): Promise<T[]> {
    const rows = await this.prisma.storeRecord.findMany({ where: { kind }, orderBy: { seq: 'asc' } });
    return rows.map((r) => r.data as T);
  }

  // 인증서 — 목록 푸시다운용 인덱스 컬럼(ownerType·notBefore·searchText)을 JSONB와 함께 유지.
  async saveCert(c: StoredCert): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.storeRecord.deleteMany({ where: { kind: 'cert', rkey: c.cert.tbs.serialNumber } }),
      this.prisma.storeRecord.create({
        data: {
          kind: 'cert',
          rkey: c.cert.tbs.serialNumber,
          data: c as object,
          ownerType: c.cert.tbs.ownerType,
          notBefore: c.cert.tbs.notBefore ? new Date(c.cert.tbs.notBefore) : null,
          searchText: certSearchText(c),
        },
      }),
    ]);
  }
  async getCertBySerial(serial: string): Promise<StoredCert | null> {
    return this.getOne<StoredCert>('cert', serial);
  }
  async hasCertSerial(serial: string): Promise<boolean> {
    return (await this.prisma.storeRecord.count({ where: { kind: 'cert', rkey: serial } })) > 0;
  }
  async allCerts(): Promise<StoredCert[]> {
    return this.list<StoredCert>('cert');
  }
  /** DB 레벨 검색(searchText LIKE)·CA 제외(ownerType)·정렬(notBefore desc)·페이지·count. */
  async queryCerts(q: CertQuery): Promise<{ items: StoredCert[]; total: number }> {
    const where: Record<string, unknown> = { kind: 'cert', NOT: { ownerType: 'CA' } };
    if (q.q) where.searchText = { contains: likeEscape(q.q) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.storeRecord.findMany({ where, orderBy: { notBefore: 'desc' }, skip: q.offset, take: q.limit }),
      this.prisma.storeRecord.count({ where }),
    ]);
    return { items: rows.map((r) => r.data as unknown as StoredCert), total };
  }

  // 서명요청 — 목록 푸시다운용 인덱스 컬럼(status·reqCreatedAt·searchText)을 JSONB와 함께 유지.
  async saveRequest(r: StoredRequest): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.storeRecord.deleteMany({ where: { kind: 'request', rkey: r.requestId } }),
      this.prisma.storeRecord.create({
        data: {
          kind: 'request',
          rkey: r.requestId,
          data: r as object,
          status: r.status,
          reqCreatedAt: r.createdAt ? new Date(r.createdAt) : null,
          createdBy: r.createdBy ?? null,
          signMode: r.signMode ?? null,
          searchText: requestSearchText(r),
          // 계약 필터 캐시(A3) — 비계약/미동기화 행은 null(비보관·'기타' 취급)
          archived: r.ctArchived ?? null,
          category: r.ctCategory ?? null,
          labelsText: r.ctLabels?.length ? `|${r.ctLabels.join('|')}|` : null,
        },
      }),
    ]);
    await this.putOne('idem', r.idempotencyKey, { requestId: r.requestId });
  }
  async getRequest(requestId: string): Promise<StoredRequest | null> {
    return this.getOne<StoredRequest>('request', requestId);
  }
  async getRequestIdByIdempotency(key: string): Promise<string | null> {
    const v = await this.getOne<{ requestId: string }>('idem', key);
    return v?.requestId ?? null;
  }
  async allRequests(): Promise<StoredRequest[]> {
    return this.list<StoredRequest>('request');
  }
  async getRequestByParticipant(participantId: string): Promise<StoredRequest | null> {
    // participants 배열에 해당 participantId 를 가진 원소가 있는 행을 DB 에서 직접 찾는다(jsonb @> 부분 포함).
    const row = await this.prisma.storeRecord.findFirst({
      where: { kind: 'request', data: { path: ['participants'], array_contains: [{ participantId }] } },
    });
    return row ? (row.data as unknown as StoredRequest) : null;
  }
  /** DB 레벨 필터(status·기간)·검색(searchText LIKE)·정렬(reqCreatedAt desc)·페이지(skip/take)·count. */
  async queryRequests(q: RequestQuery): Promise<{ items: StoredRequest[]; total: number }> {
    const where: Record<string, unknown> = { kind: 'request' };
    if (q.incomplete) where.status = { in: INCOMPLETE_STATUSES };
    else if (q.status) where.status = q.status;
    if (q.from || q.to) {
      where.reqCreatedAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    }
    if (q.createdBy) where.createdBy = q.createdBy;
    if (q.signMode) where.signMode = q.signMode;
    if (q.q) where.searchText = { contains: likeEscape(q.q) }; // q.q 는 소문자 정규화됨(searchText 도 소문자 저장)
    // 계약 필터(A3) — null(레거시/비동기화)은 비보관·'기타' 취급(requestMatches 와 동일 의미)
    // NULL(레거시·백필 전) 은 비보관·'기타' 취급 — Prisma `not` 은 NULL 행을 돌려주지 않으므로
    // OR 로 명시한다. 두 조건이 겹칠 수 있어 AND 로 합성(단일 where.OR 대입은 서로 덮어씀).
    const ands: Array<Record<string, unknown>> = [];
    if (q.archived === true) where.archived = true;
    else if (q.archived === false) ands.push({ OR: [{ archived: false }, { archived: null }] });
    if (q.category) {
      if (q.category === '기타') ands.push({ OR: [{ category: '기타' }, { category: null }] });
      else where.category = q.category;
    }
    if (ands.length) where.AND = ands;
    if (q.label) where.labelsText = { contains: `|${likeEscape(q.label)}|` };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.storeRecord.findMany({ where, orderBy: { reqCreatedAt: 'desc' }, skip: q.offset, take: q.limit }),
      this.prisma.storeRecord.count({ where }),
    ]);
    return { items: rows.map((r) => r.data as unknown as StoredRequest), total };
  }

  // 서명 (append)
  async saveSignature(s: StoredSignature): Promise<void> {
    await this.prisma.storeRecord.create({ data: { kind: 'signature', rkey: s.requestId, data: s as object } });
  }
  async signaturesByRequest(requestId: string): Promise<StoredSignature[]> {
    const rows = await this.prisma.storeRecord.findMany({ where: { kind: 'signature', rkey: requestId }, orderBy: { seq: 'asc' } });
    return rows.map((r) => r.data as unknown as StoredSignature);
  }

  // 본인확인
  async saveIdentity(i: StoredIdentity): Promise<void> {
    await this.putOne('identity', i.id, i);
  }
  async getIdentity(id: string): Promise<StoredIdentity | null> {
    return this.getOne<StoredIdentity>('identity', id);
  }

  // 감사 (append, seq 순서 보존)
  /**
   * 체인 append — 같은 스트림의 동일 `prevHash` 는 **유니크 인덱스(0009)** 가 거부한다(R16).
   * 인프로세스 직렬화만으로는 다중 노드에서 두 프로세스가 같은 prevHash 를 읽어 체인이 분기하는데,
   * 그 분기를 저장소가 구조적으로 막는다. 패자는 StoreConflictError → 재조회 후 재시도.
   */
  async appendAudit(key: string, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.storeRecord.create({ data: { kind: 'audit', rkey: key, data: entry as object } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreConflictError(`audit chain fork (stream=${key}, prevHash=${entry.prevHash})`);
      throw e;
    }
  }
  async lastAudit(key: string): Promise<AuditEntry | null> {
    const row = await this.prisma.storeRecord.findFirst({ where: { kind: 'audit', rkey: key }, orderBy: { seq: 'desc' } });
    return row ? (row.data as unknown as AuditEntry) : null;
  }
  async auditEntries(key: string): Promise<AuditEntry[]> {
    const rows = await this.prisma.storeRecord.findMany({ where: { kind: 'audit', rkey: key }, orderBy: { seq: 'asc' } });
    return rows.map((r) => r.data as unknown as AuditEntry);
  }
  async auditRecent(key: string, limit: number): Promise<AuditEntry[]> {
    // 최신 N개만 DB 에서 가져와(desc take) 시간 오름차순으로 되돌린다 — 전체 스트림 hydrate 회피.
    const take = Math.max(1, Math.min(5000, limit));
    const rows = await this.prisma.storeRecord.findMany({ where: { kind: 'audit', rkey: key }, orderBy: { seq: 'desc' }, take });
    return rows.reverse().map((r) => r.data as unknown as AuditEntry);
  }
  async auditKeys(prefix: string): Promise<string[]> {
    const rows = await this.prisma.storeRecord.findMany({ where: { kind: 'audit', rkey: { startsWith: prefix } }, distinct: ['rkey'], select: { rkey: true } });
    return rows.map((r) => r.rkey);
  }
  async auditKeysByRecency(limit: number): Promise<string[]> {
    // 스트림별 최대 seq 기준 내림차순 — distinct 의 순서 미정의 문제를 없애고 "실제 최근 N"을 보장.
    const take = Math.max(1, Math.min(1000, limit));
    const groups = await this.prisma.storeRecord.groupBy({
      by: ['rkey'],
      where: { kind: 'audit' },
      _max: { seq: true },
      orderBy: { _max: { seq: 'desc' } },
      take,
    });
    return groups.map((g) => g.rkey);
  }

  async saveAnchor(anchor: StoredAnchor): Promise<void> {
    await this.putOne('anchor', anchor.key, anchor);
  }
  async getLatestAnchor(key: string): Promise<StoredAnchor | null> {
    return this.getOne<StoredAnchor>('anchor', key);
  }

  // 폐기
  async saveRevocation(r: Revocation): Promise<void> {
    await this.putOne('revocation', r.serialNumber, r);
  }
  async getRevocation(serial: string): Promise<Revocation | null> {
    return this.getOne<Revocation>('revocation', serial);
  }
  async allRevocations(): Promise<Revocation[]> {
    return this.list<Revocation>('revocation');
  }
  async nextCrlNumber(): Promise<number> {
    const cur = (await this.getOne<{ n: number }>('meta', 'crl'))?.n ?? 0;
    const next = cur + 1;
    await this.putOne('meta', 'crl', { n: next });
    return next;
  }
  async currentCrlNumber(): Promise<number> {
    return (await this.getOne<{ n: number }>('meta', 'crl'))?.n ?? 0;
  }

  // Webhook
  async saveWebhook(d: WebhookDelivery): Promise<void> {
    await this.putOne('webhook', d.id, d);
  }
  async updateWebhook(d: WebhookDelivery): Promise<void> {
    await this.putOne('webhook', d.id, d);
  }
  async getWebhook(id: string): Promise<WebhookDelivery | null> {
    return this.getOne<WebhookDelivery>('webhook', id);
  }
  async listWebhooks(): Promise<WebhookDelivery[]> {
    return this.list<WebhookDelivery>('webhook');
  }
  async webhooksByStatus(statuses: string[]): Promise<WebhookDelivery[]> {
    if (!statuses.length) return [];
    // status 는 JSONB 안에만 있으므로 상태별로 JSON-path 조건을 OR 로 묶어 DB 에서 거른다(전량 스캔 회피).
    const rows = await this.prisma.storeRecord.findMany({
      where: { kind: 'webhook', OR: statuses.map((s) => ({ data: { path: ['status'], equals: s } })) },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => r.data as unknown as WebhookDelivery);
  }
  async webhooksByRequest(requestId: string): Promise<WebhookDelivery[]> {
    // JSON 경로 조건으로 DB 푸시다운 — 종전엔 kind='webhook' 전 행을 읽어 JS 필터했다(reconcile 조회마다 전량 스캔).
    const rows = await this.prisma.storeRecord.findMany({
      where: { kind: 'webhook', data: { path: ['requestId'], equals: requestId } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => r.data as unknown as WebhookDelivery);
  }

  async saveNotify(r: NotifyRecord): Promise<void> {
    await this.putOne('notify', r.id, r);
  }
  async listNotify(): Promise<NotifyRecord[]> {
    return this.list<NotifyRecord>('notify');
  }
  async notifyByRequest(requestId: string): Promise<NotifyRecord[]> {
    // JSON 경로 조건으로 DB 푸시다운 — 이전 구현은 kind='notify' 전 행을 읽어 JS 필터했다(목록 N+1 증폭).
    const rows = await this.prisma.storeRecord.findMany({
      where: { kind: 'notify', data: { path: ['requestId'], equals: requestId } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => r.data as unknown as NotifyRecord);
  }

  // 메타 KV (CA 번들 등). 'meta' kind 공유, rkey로 슬롯 구분.
  async saveMeta(key: string, value: unknown): Promise<void> {
    await this.putOne('meta', key, value);
  }
  async getMeta<T>(key: string): Promise<T | null> {
    return this.getOne<T>('meta', key);
  }
  async getMetaVersioned<T>(key: string): Promise<{ value: T | null; version: number | null }> {
    const row = await this.prisma.storeRecord.findFirst({ where: { kind: 'meta', rkey: key }, orderBy: { seq: 'desc' } });
    return row ? { value: row.data as T, version: row.seq } : { value: null, version: null };
  }
  /**
   * CAS 저장(R16) — 버전(=행 seq)이 기대값일 때만 교체한다.
   *  - 기존 슬롯 갱신: `deleteMany(seq=expected)` 의 count 로 판정. 다른 트랜잭션이 먼저 교체했다면
   *    (READ COMMITTED 에서 행 잠금 해제 후 재평가) count=0 → 아무것도 쓰지 않고 false.
   *  - 최초 생성(expected=null): 존재 확인 + create. 확인~생성 사이의 경합은 **부분 유니크 인덱스**
   *    (kind='meta' 의 (kind,rkey), 0009)가 거부하므로 여기서도 false 로 수렴한다.
   */
  async saveMetaIfUnchanged(key: string, expectedVersion: number | null, value: unknown): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (expectedVersion === null) {
          if ((await tx.storeRecord.count({ where: { kind: 'meta', rkey: key } })) > 0) return false;
        } else {
          const del = await tx.storeRecord.deleteMany({ where: { kind: 'meta', rkey: key, seq: expectedVersion } });
          if (del.count !== 1) return false;
        }
        await tx.storeRecord.create({ data: { kind: 'meta', rkey: key, data: value as object } });
        return true;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return false; // 최초 생성 경합 — 상대가 이겼다
      throw e;
    }
  }
  async metaExists(key: string): Promise<boolean> {
    // 값(JSONB)을 읽지 않는다 — 문서 블롭 같은 대용량 슬롯의 존재 확인이 목록 응답마다 발생하기 때문
    return (await this.prisma.storeRecord.count({ where: { kind: 'meta', rkey: key } })) > 0;
  }
  async deleteMeta(key: string): Promise<void> {
    await this.prisma.storeRecord.deleteMany({ where: { kind: 'meta', rkey: key } });
  }
  async ping(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
