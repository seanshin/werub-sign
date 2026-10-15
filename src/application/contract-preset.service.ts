// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { KeyedMutex } from '../domain/keyed-mutex';
import { casUpdateMeta } from '../domain/meta-cas';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { maskEmail } from '../domain/mask';

/**
 * 새 계약 프리셋(U5) — 자주 쓰는 "요청 구성"(제목·서명자열·서명방식·라벨·분류) 저장/불러오기.
 *  - 문서 서식이 아닌 요청 구성 저장(UI 기획 §3.3 설계 원칙). 기관 공용(주소록과 동일 원칙).
 *  - 접근암호 값은 저장하지 않음(useAccessCode 여부만) — 암호는 생성 시 매번 입력.
 * meta KV(`contract-presets`) 단일 배열 영속, RMW 는 KeyedMutex 직렬화.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const PRESET_KEY = 'contract-presets';
const MAX_PRESETS = 30;

export interface PresetSigner {
  kind: 'INTERNAL' | 'EXTERNAL';
  displayName: string;
  order: number;
  username?: string; // INTERNAL 콘솔 계정
  email?: string; // EXTERNAL 수신
}

export interface ContractPreset {
  presetId: string;
  name: string; // 프리셋 표시명
  title?: string; // 계약 제목 기본값
  category?: string;
  labels?: string[];
  signingMode?: 'SEQUENTIAL' | 'PARALLEL';
  useAccessCode?: boolean; // 접근암호 사용 여부만(값 미저장)
  signers: PresetSigner[];
  createdBy: string;
  updatedBy?: string; // 마지막 변경자(기관 공용이라 누가 바꿨는지 남긴다 — D5)
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ContractPresetService {
  private readonly log = new Logger(ContractPresetService.name);
  private readonly mutex = new KeyedMutex();

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly config: ConfigService,
    private readonly audit: AuditChainService,
  ) {}

  /** 프리셋 변경 감사(D5) — 기관 공용이라 "누가 바꿨/지웠나"를 관리자 감사 스트림에 남긴다. */
  private async record(eventType: string, data: Record<string, unknown>): Promise<void> {
    const key = 'admin:contract-presets';
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      await this.store.appendAudit(key, this.audit.next(prev, eventType, data, new Date().toISOString()));
    });
  }

  private assertEnabled() {
    const v = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    if (!(v === 'on' || v === 'true' || v === '1')) throw new NotFoundException('일반 전자계약 기능 비활성');
  }

  private async all(): Promise<ContractPreset[]> {
    return (await this.store.getMeta<ContractPreset[]>(PRESET_KEY)) ?? [];
  }

  /** 목록(최근 갱신순). */
  /**
   * 목록 — 외부 상대방 이메일은 **마스킹**(D6). 계약 목록·상세의 마스킹 정책과 동일 등급으로 맞춘다.
   * 실제 적용(새 계약 폼 자동 채움)은 `get()`(contracts:write)이 원문을 돌려준다.
   */
  async list(): Promise<ContractPreset[]> {
    this.assertEnabled();
    return [...(await this.all())]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => ({ ...p, signers: p.signers.map((s) => (s.email ? { ...s, email: maskEmail(s.email) } : s)) }));
  }

  /** 단건(적용용) — 원문 이메일 포함. 계약 생성 권한(contracts:write)에서만 호출한다. */
  async get(presetId: string): Promise<ContractPreset> {
    this.assertEnabled();
    const found = (await this.all()).find((p) => p.presetId === presetId);
    if (!found) throw new NotFoundException('프리셋 없음');
    return found;
  }

  /** 저장 — 이름 중복 시 갱신(upsert), 서명자 구성 검증. */
  async save(input: { name: string; title?: string; category?: string; labels?: string[]; signingMode?: 'SEQUENTIAL' | 'PARALLEL'; useAccessCode?: boolean; signers: PresetSigner[] }, actor: string): Promise<ContractPreset> {
    this.assertEnabled();
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('프리셋 이름은 필수');
    if (name.length > 60) throw new BadRequestException('프리셋 이름 최대 60자');
    const signers = (input.signers ?? []).map((s, i) => {
      if (s.kind !== 'INTERNAL' && s.kind !== 'EXTERNAL') throw new BadRequestException(`서명자 kind 오류(${i + 1}번)`);
      const displayName = (s.displayName ?? '').trim();
      if (!displayName) throw new BadRequestException(`서명자 표시명 필수(${i + 1}번)`);
      return { kind: s.kind, displayName, order: Number(s.order) || i + 1, username: s.username?.trim() || undefined, email: s.email?.trim().toLowerCase() || undefined };
    });
    if (!signers.length) throw new BadRequestException('서명자 구성은 1인 이상');
    // 뮤텍스=같은 노드 직렬화(빠른 경로), CAS=노드 간 lost update 차단(R16).
    const { preset, created } = await this.mutex.run(PRESET_KEY, () =>
      casUpdateMeta<ContractPreset[], { preset: ContractPreset; created: boolean }>(this.store, PRESET_KEY, (cur) => {
        const list = [...(cur ?? [])];
        const now = new Date().toISOString();
        const idx = list.findIndex((p) => p.name === name);
        const preset: ContractPreset = {
          presetId: idx >= 0 ? list[idx].presetId : randomUUID(),
          name,
          title: input.title?.trim() || undefined,
          category: input.category?.trim() || undefined,
          labels: (input.labels ?? []).map((l) => l.trim()).filter(Boolean),
          signingMode: input.signingMode === 'PARALLEL' ? 'PARALLEL' : 'SEQUENTIAL',
          useAccessCode: !!input.useAccessCode,
          signers,
          createdBy: idx >= 0 ? list[idx].createdBy : actor,
          updatedBy: actor,
          createdAt: idx >= 0 ? list[idx].createdAt : now,
          updatedAt: now,
        };
        if (idx >= 0) list[idx] = preset;
        else {
          if (list.length >= MAX_PRESETS) throw new BadRequestException(`프리셋 최대 ${MAX_PRESETS}개`);
          list.unshift(preset);
        }
        return { write: list, result: { preset, created: idx < 0 } };
      }),
    );
    // 감사는 CAS 성공 후 1회 — mutate 안에 두면 재시도마다 중복 기록된다
    await this.record(created ? 'CONTRACT_PRESET_CREATED' : 'CONTRACT_PRESET_UPDATED', {
      actor, presetId: preset.presetId, name: preset.name, createdBy: preset.createdBy, signers: preset.signers.length,
    }).catch(() => undefined);
    return preset;
  }

  /**
   * 삭제(멱등) — **D5 절충안**: 수정은 기관 공용으로 열어 두되, **삭제는 생성자 또는 admin 만**.
   * 수정은 되돌릴 수 있지만(다시 저장) 삭제는 복구 수단이 없어 손실이 비가역이기 때문.
   * 삭제자·대상은 로그와 감사에 남긴다.
   */
  async remove(presetId: string, actor = '-', actorRole?: string): Promise<{ removed: boolean }> {
    this.assertEnabled();
    const removed = await this.mutex.run(PRESET_KEY, () =>
      casUpdateMeta<ContractPreset[], ContractPreset | null>(this.store, PRESET_KEY, (cur) => {
        const list = cur ?? [];
        const target = list.find((p) => p.presetId === presetId);
        if (!target) return { result: null }; // 멱등 — 이미 없음(기록 없음)
        const isAdmin = actorRole === 'admin' || !actorRole; // role 미상(기계키 break-glass)은 서버 판단에 맡김
        if (!isAdmin && target.createdBy !== actor) {
          throw new ForbiddenException(`다른 사람이 만든 프리셋은 삭제할 수 없습니다(생성자: ${target.createdBy} · 관리자에게 요청하세요)`);
        }
        return { write: list.filter((p) => p.presetId !== presetId), result: target };
      }),
    );
    if (!removed) return { removed: false };
    this.log.log(`계약 프리셋 삭제 — "${removed.name}" by ${actor}${actorRole ? `(${actorRole})` : ''}`);
    await this.record('CONTRACT_PRESET_DELETED', { actor, actorRole, presetId, name: removed.name, createdBy: removed.createdBy })
      .catch(() => undefined); // 감사 실패로 삭제를 막지는 않음(이미 로그 기록)
    return { removed: true };
  }
}
