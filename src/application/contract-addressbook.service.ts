// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { KeyedMutex } from '../domain/keyed-mutex';
import { casUpdateMeta } from '../domain/meta-cas';

/**
 * 전자계약 발송/수신 이메일 주소록 — 자주 발송하는 외부 상대방 연락처를 저장·재사용.
 * meta KV(`contract-addressbook`)에 단일 배열로 영속(원내 행정 규모 전제). 계약 트랙 전용.
 * 개인정보(이메일·이름)라 조회는 contracts:read, 편집은 contracts:write 로 제한.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const AB_KEY = 'contract-addressbook';

export interface AddressEntry {
  id: string;
  email: string;
  name: string; // 표시명(담당자/기관)
  org?: string; // 소속/회사
  memo?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ContractAddressbookService {
  constructor(@Inject(SIGN_STORE) private readonly store: SignStore, private readonly config: ConfigService) {}

  // 단일 배열 meta 의 read-modify-write 직렬화 — 동시 편집/자동학습 lost update 방지
  private readonly mutex = new KeyedMutex();

  enabled(): boolean {
    const v = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }
  private assertEnabled() {
    if (!this.enabled()) throw new NotFoundException('일반 전자계약 기능 비활성');
  }

  private async all(): Promise<AddressEntry[]> {
    return (await this.store.getMeta<AddressEntry[]>(AB_KEY)) ?? [];
  }
  private normEmail(e: string): string {
    const v = (e ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new BadRequestException('이메일 형식 오류');
    return v;
  }

  /** 목록(검색 q — 이메일·이름·소속). 최근 갱신순. */
  async list(q?: string): Promise<AddressEntry[]> {
    this.assertEnabled();
    let list = [...(await this.all())].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (q?.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((e) => e.email.includes(s) || e.name.toLowerCase().includes(s) || (e.org ?? '').toLowerCase().includes(s));
    }
    return list;
  }

  /** 추가 — 이메일 중복 금지(있으면 409). */
  async add(input: { email: string; name: string; org?: string; memo?: string }): Promise<AddressEntry> {
    this.assertEnabled();
    const email = this.normEmail(input.email);
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('표시명(name)은 필수');
    return this.mutex.run(AB_KEY, () =>
      casUpdateMeta<AddressEntry[], AddressEntry>(this.store, AB_KEY, (cur) => {
        const list = cur ?? [];
        if (list.some((e) => e.email === email)) throw new ConflictException('이미 등록된 이메일');
        const now = new Date().toISOString();
        const entry: AddressEntry = { id: randomUUID(), email, name, org: input.org?.trim() || undefined, memo: input.memo?.trim() || undefined, createdAt: now, updatedAt: now };
        return { write: [entry, ...list], result: entry };
      }),
    );
  }

  /** 수정 — 이메일 변경 시 중복 검사. */
  async update(id: string, patch: { email?: string; name?: string; org?: string; memo?: string }): Promise<AddressEntry> {
    this.assertEnabled();
    return this.mutex.run(AB_KEY, () =>
      casUpdateMeta<AddressEntry[], AddressEntry>(this.store, AB_KEY, (cur) => {
        const list = [...(cur ?? [])];
        const idx = list.findIndex((e) => e.id === id);
        if (idx < 0) throw new NotFoundException('주소록 항목 없음');
        const next = { ...list[idx] };
        if (patch.email !== undefined) {
          const email = this.normEmail(patch.email);
          if (list.some((e) => e.id !== id && e.email === email)) throw new ConflictException('이미 등록된 이메일');
          next.email = email;
        }
        if (patch.name !== undefined) { const n = patch.name.trim(); if (!n) throw new BadRequestException('표시명 필수'); next.name = n; }
        if (patch.org !== undefined) next.org = patch.org.trim() || undefined;
        if (patch.memo !== undefined) next.memo = patch.memo.trim() || undefined;
        next.updatedAt = new Date().toISOString();
        list[idx] = next;
        return { write: list, result: next };
      }),
    );
  }

  /** 삭제(멱등). */
  async remove(id: string): Promise<{ removed: boolean }> {
    this.assertEnabled();
    return this.mutex.run(AB_KEY, () =>
      casUpdateMeta<AddressEntry[], { removed: boolean }>(this.store, AB_KEY, (cur) => {
        const list = cur ?? [];
        const next = list.filter((e) => e.id !== id);
        if (next.length === list.length) return { result: { removed: false } }; // 멱등 — 기록 없음
        return { write: next, result: { removed: true } };
      }),
    );
  }

  /** 발송 완료 시 수신 이메일 자동 학습(upsert, best-effort) — 이름 미제공 시 이메일 로컬파트 사용. */
  async learn(email: string, name?: string, org?: string): Promise<void> {
    try {
      if (!this.enabled()) return;
      const e = this.normEmail(email);
      await this.mutex.run(AB_KEY, () =>
        casUpdateMeta<AddressEntry[], void>(this.store, AB_KEY, (cur) => {
          const list = cur ?? [];
          if (list.some((x) => x.email === e)) return { result: undefined }; // 이미 있음 — 갱신 생략
          const now = new Date().toISOString();
          const entry: AddressEntry = { id: randomUUID(), email: e, name: (name ?? e.split('@')[0]).trim(), org: org?.trim() || undefined, createdAt: now, updatedAt: now };
          return { write: [entry, ...list], result: undefined };
        }),
      );
    } catch {
      /* 학습 실패가 발송을 막지 않도록 무시 */
    }
  }
}
