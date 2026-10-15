// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { SignStore } from '../../domain/ports/sign-store.port';
import { RequestQuery, requestMatches, byCreatedDesc } from '../../domain/request-query';
import { CertQuery, certMatches, byNotBeforeDesc } from '../../domain/cert-query';
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
import { StoreConflictError } from '../../domain/store-conflict.error';

/**
 * In-memory SignStore 어댑터 (개발/PoC). 운영은 PrismaSignStore로 교체(SIGN_STORE 포트).
 * 단일 프로세스 PoC: CA 키가 SoftKeySigner 인메모리에 있으므로 정합.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class InMemorySignStore implements SignStore {
  protected readonly certsBySerial = new Map<string, StoredCert>();
  protected readonly requests = new Map<string, StoredRequest>();
  protected readonly requestsByIdem = new Map<string, string>();
  protected readonly signatures = new Map<string, StoredSignature>();
  protected readonly identities = new Map<string, StoredIdentity>();
  protected readonly auditByKey = new Map<string, AuditEntry[]>();
  /** 스트림별 사용된 prevHash — 체인 분기 거부용 인덱스(Prisma 유니크 인덱스와 동형, 스냅샷에서 재구성). */
  protected readonly auditPrevHashes = new Map<string, Set<string>>();
  protected readonly anchors = new Map<string, StoredAnchor>();
  protected readonly revocations = new Map<string, Revocation>();
  protected readonly webhooks = new Map<string, WebhookDelivery>();
  protected readonly notifies = new Map<string, NotifyRecord>();
  protected readonly metaKv = new Map<string, unknown>();
  /** 메타 슬롯 버전(CAS 용) — Prisma 의 행 seq 대응. 프로세스 로컬이면 충분(재기동 시 in-flight CAS 도 함께 소멸). */
  protected readonly metaVersions = new Map<string, number>();
  protected metaVersionSeq = 0;
  protected crlNumber = 0;

  /** 영속 어댑터용 훅 (FileSignStore가 override) */
  protected async persist(): Promise<void> {}

  protected toSnapshot(): string {
    return JSON.stringify({
      certs: [...this.certsBySerial],
      requests: [...this.requests],
      requestsByIdem: [...this.requestsByIdem],
      signatures: [...this.signatures],
      identities: [...this.identities],
      audit: [...this.auditByKey],
      anchors: [...this.anchors],
      revocations: [...this.revocations],
      webhooks: [...this.webhooks],
      notifies: [...this.notifies],
      meta: [...this.metaKv],
      crlNumber: this.crlNumber,
    });
  }

  protected loadSnapshot(json: string): void {
    const s = JSON.parse(json);
    this.certsBySerial.clear(); for (const [k, v] of s.certs ?? []) this.certsBySerial.set(k, v);
    this.requests.clear(); for (const [k, v] of s.requests ?? []) this.requests.set(k, v);
    this.requestsByIdem.clear(); for (const [k, v] of s.requestsByIdem ?? []) this.requestsByIdem.set(k, v);
    this.signatures.clear(); for (const [k, v] of s.signatures ?? []) this.signatures.set(k, v);
    this.identities.clear(); for (const [k, v] of s.identities ?? []) this.identities.set(k, v);
    this.auditByKey.clear(); this.auditPrevHashes.clear();
    for (const [k, v] of s.audit ?? []) { this.auditByKey.set(k, v); this.auditPrevHashes.set(k, new Set((v as AuditEntry[]).map((e) => e.prevHash))); }
    this.anchors.clear(); for (const [k, v] of s.anchors ?? []) this.anchors.set(k, v);
    this.revocations.clear(); for (const [k, v] of s.revocations ?? []) this.revocations.set(k, v);
    this.webhooks.clear(); for (const [k, v] of s.webhooks ?? []) this.webhooks.set(k, v);
    this.notifies.clear(); for (const [k, v] of s.notifies ?? []) this.notifies.set(k, v);
    this.metaKv.clear(); for (const [k, v] of s.meta ?? []) this.metaKv.set(k, v);
    this.crlNumber = s.crlNumber ?? 0;
  }

  async saveCert(c: StoredCert): Promise<void> {
    this.certsBySerial.set(c.cert.tbs.serialNumber, c);
    await this.persist();
  }
  async getCertBySerial(serial: string): Promise<StoredCert | null> {
    return this.certsBySerial.get(serial) ?? null;
  }
  async hasCertSerial(serial: string): Promise<boolean> {
    return this.certsBySerial.has(serial);
  }
  async allCerts(): Promise<StoredCert[]> {
    return [...this.certsBySerial.values()];
  }
  async queryCerts(q: CertQuery): Promise<{ items: StoredCert[]; total: number }> {
    const filtered = [...this.certsBySerial.values()].filter((c) => certMatches(c, q)).sort(byNotBeforeDesc);
    const total = filtered.length;
    const offset = Math.min(q.offset, total);
    const items = q.limit !== undefined ? filtered.slice(offset, offset + q.limit) : filtered.slice(offset);
    return { items, total };
  }

  async saveRequest(r: StoredRequest): Promise<void> {
    this.requests.set(r.requestId, r);
    this.requestsByIdem.set(r.idempotencyKey, r.requestId);
    await this.persist();
  }
  async getRequest(requestId: string): Promise<StoredRequest | null> {
    return this.requests.get(requestId) ?? null;
  }
  async getRequestIdByIdempotency(key: string): Promise<string | null> {
    return this.requestsByIdem.get(key) ?? null;
  }
  async allRequests(): Promise<StoredRequest[]> {
    return [...this.requests.values()];
  }
  async getRequestByParticipant(participantId: string): Promise<StoredRequest | null> {
    for (const r of this.requests.values()) {
      if (r.participants.some((p) => p.participantId === participantId)) return r;
    }
    return null;
  }
  async queryRequests(q: RequestQuery): Promise<{ items: StoredRequest[]; total: number }> {
    const filtered = [...this.requests.values()].filter((r) => requestMatches(r, q)).sort(byCreatedDesc);
    const total = filtered.length;
    const offset = Math.min(q.offset, total);
    const items = q.limit !== undefined ? filtered.slice(offset, offset + q.limit) : filtered.slice(offset);
    return { items, total };
  }

  async saveSignature(s: StoredSignature): Promise<void> {
    this.signatures.set(s.signatureId, s);
    await this.persist();
  }
  async signaturesByRequest(requestId: string): Promise<StoredSignature[]> {
    return [...this.signatures.values()].filter((s) => s.requestId === requestId);
  }

  async saveIdentity(i: StoredIdentity): Promise<void> {
    this.identities.set(i.id, i);
    await this.persist();
  }
  async getIdentity(id: string): Promise<StoredIdentity | null> {
    return this.identities.get(id) ?? null;
  }

  /** Prisma 어댑터의 유니크 인덱스(0009)와 동형 — 같은 prevHash 재사용은 체인 분기이므로 거부(R16). */
  async appendAudit(key: string, entry: AuditEntry): Promise<void> {
    const seen = this.auditPrevHashes.get(key) ?? new Set<string>();
    if (seen.has(entry.prevHash)) {
      throw new StoreConflictError(`audit chain fork (stream=${key}, prevHash=${entry.prevHash})`);
    }
    const list = this.auditByKey.get(key) ?? [];
    list.push(entry);
    this.auditByKey.set(key, list);
    seen.add(entry.prevHash);
    this.auditPrevHashes.set(key, seen);
    await this.persist();
  }
  async lastAudit(key: string): Promise<AuditEntry | null> {
    const list = this.auditByKey.get(key);
    return list && list.length ? list[list.length - 1] : null;
  }
  async auditEntries(key: string): Promise<AuditEntry[]> {
    return this.auditByKey.get(key) ?? [];
  }
  async auditRecent(key: string, limit: number): Promise<AuditEntry[]> {
    const list = this.auditByKey.get(key) ?? [];
    return limit >= list.length ? list : list.slice(list.length - limit);
  }
  async auditKeys(prefix: string): Promise<string[]> {
    return [...this.auditByKey.keys()].filter((k) => k.startsWith(prefix));
  }
  async auditKeysByRecency(limit: number): Promise<string[]> {
    // 삽입 순서상 각 스트림의 마지막 엔트리가 가장 최근 — 스트림별 최신 엔트리 기준 정렬(occurredAt desc)로 근사.
    return [...this.auditByKey.entries()]
      .map(([k, list]) => [k, list.length ? Date.parse(list[list.length - 1].occurredAt) || 0 : 0] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k);
  }

  async saveAnchor(anchor: StoredAnchor): Promise<void> {
    this.anchors.set(anchor.key, anchor);
    await this.persist();
  }
  async getLatestAnchor(key: string): Promise<StoredAnchor | null> {
    return this.anchors.get(key) ?? null;
  }

  async saveRevocation(r: Revocation): Promise<void> {
    this.revocations.set(r.serialNumber, r);
    await this.persist();
  }
  async getRevocation(serial: string): Promise<Revocation | null> {
    return this.revocations.get(serial) ?? null;
  }
  async allRevocations(): Promise<Revocation[]> {
    return [...this.revocations.values()];
  }
  async nextCrlNumber(): Promise<number> {
    this.crlNumber += 1;
    await this.persist();
    return this.crlNumber;
  }
  async currentCrlNumber(): Promise<number> {
    return this.crlNumber;
  }

  async saveWebhook(d: WebhookDelivery): Promise<void> {
    this.webhooks.set(d.id, d);
    await this.persist();
  }
  async updateWebhook(d: WebhookDelivery): Promise<void> {
    this.webhooks.set(d.id, d);
    await this.persist();
  }
  async getWebhook(id: string): Promise<WebhookDelivery | null> {
    return this.webhooks.get(id) ?? null;
  }
  async listWebhooks(): Promise<WebhookDelivery[]> {
    return [...this.webhooks.values()];
  }
  async webhooksByStatus(statuses: string[]): Promise<WebhookDelivery[]> {
    const set = new Set(statuses);
    return [...this.webhooks.values()].filter((w) => set.has(w.status));
  }
  async webhooksByRequest(requestId: string): Promise<WebhookDelivery[]> {
    return [...this.webhooks.values()].filter((w) => w.requestId === requestId);
  }

  async saveNotify(r: NotifyRecord): Promise<void> {
    this.notifies.set(r.id, r);
    await this.persist();
  }
  async listNotify(): Promise<NotifyRecord[]> {
    return [...this.notifies.values()];
  }
  async notifyByRequest(requestId: string): Promise<NotifyRecord[]> {
    return [...this.notifies.values()].filter((n) => n.requestId === requestId);
  }

  async metaExists(key: string): Promise<boolean> {
    return (await this.getMeta(key)) !== null;
  }

  async saveMeta(key: string, value: unknown): Promise<void> {
    this.metaKv.set(key, value);
    this.metaVersions.set(key, ++this.metaVersionSeq);
    await this.persist();
  }
  async getMeta<T>(key: string): Promise<T | null> {
    return (this.metaKv.get(key) as T) ?? null;
  }
  async getMetaVersioned<T>(key: string): Promise<{ value: T | null; version: number | null }> {
    if (!this.metaKv.has(key)) return { value: null, version: null };
    // 재기동 전 기록에는 버전이 없다(스냅샷 미보존) — 최초 조회 시 부여하면 이후 CAS 가 정상 동작한다.
    let v = this.metaVersions.get(key);
    if (v === undefined) { v = ++this.metaVersionSeq; this.metaVersions.set(key, v); }
    return { value: this.metaKv.get(key) as T, version: v };
  }
  async saveMetaIfUnchanged(key: string, expectedVersion: number | null, value: unknown): Promise<boolean> {
    // -1 = "슬롯은 있는데 버전 미부여"(재기동 직후) — 어떤 expectedVersion 과도 일치하지 않아야 한다
    const cur = this.metaKv.has(key) ? (this.metaVersions.get(key) ?? -1) : null;
    if (cur !== expectedVersion) return false;
    await this.saveMeta(key, value);
    return true;
  }
  async deleteMeta(key: string): Promise<void> {
    this.metaVersions.delete(key);
    if (this.metaKv.delete(key)) await this.persist();
  }
  async ping(): Promise<boolean> {
    return true; // 인메모리/파일 — 항상 도달 가능
  }
}
