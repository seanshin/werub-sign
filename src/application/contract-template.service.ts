// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { KeyedMutex } from '../domain/keyed-mutex';
import { casUpdateMeta } from '../domain/meta-cas';

const CUSTOM_KEY = 'contract-templates:custom'; // 기관 커스텀 서식(추가·수정·삭제) 저장
const OVERRIDE_KEY = 'contract-templates:overrides'; // 내장 서식의 기관 편집본(오버라이드) — 원본은 코드에 보존
const HISTORY_KEY = 'contract-templates:history'; // 서식별 변경 이력(버전 스냅샷)
const HISTORY_CAP = 20; // 서식당 보관 버전 수
const TPL_LOCK = 'contract-templates'; // 뮤테이션 직렬화 키(custom·overrides·history 3개 meta 를 한 구간으로)
const FIELD_TYPES = ['text', 'date', 'money', 'textarea'] as const;

/** 서식 변경 이력 한 건(변경 직전 스냅샷). */
export interface TemplateVersion {
  version: number;
  savedAt: string; // ISO
  savedBy: string;
  action: 'edit' | 'reset' | 'restore';
  name: string;
  category: string;
  description: string;
  fields: TemplateField[];
  body: string;
}

/**
 * 계약 서식(샘플) + 한글 PDF 컴포저 — 전자계약 "서식으로 작성"(계약서 에디터).
 *  - 내장 샘플: 근로(정규/기간제)·용역·비밀유지(NDA)·물품구매 — {{필드}} 치환은 클라이언트(에디터)가 수행,
 *    서버는 최종 본문 텍스트를 A4 PDF 로 조판(나눔고딕 전체 임베드)만 담당.
 *    ※ subset:false 필수 — pdf-lib 의 한글 폰트 서브셋 결과를 pdf.js(배치 편집기 미리보기)가
 *      제대로 렌더하지 못해 글리프가 흩어짐. 전체 임베드로 정확성 확보(PDF ~1.6MB, 텍스트 계약서 허용범위).
 *  - 생성 PDF 는 저장하지 않음 — 클라이언트가 SHA-256 계산 후 기존 계약 생성·업로드 플로우로 진행.
 *  - 샘플은 참고용 표준 문안 — 기관 사정에 맞게 수정하고 필요 시 법률 검토를 권장(각 서식 하단 고지).
 */

import { TEMPLATES, ContractTemplate, TemplateField } from './contract-templates.data';

export type { ContractTemplate, TemplateField };

/** 리치 본문 블록 — 에디터(TipTap)가 직렬화한 문서제목/조항제목/문단/목록/표(+굵기 런·정렬, A5). */
export interface ComposeBlock {
  type: 'heading' | 'paragraph' | 'listItem' | 'tableRow';
  level?: number; // heading 1|2 · listItem 들여쓰기 깊이(1-base)
  align?: 'left' | 'center' | 'right'; // 미지정 기본: h1=center, 그 외 left
  ordered?: boolean; // listItem — true=번호 목록
  index?: number; // listItem 번호(ordered)
  header?: boolean; // tableRow — 헤더 행
  /**
   * tableRow — 셀별 런(연속 행이 한 표).
   * 셀은 런 배열(레거시) 또는 `{ runs, colspan, rowspan, align }` 객체(R11 병합) 둘 다 허용.
   */
  cells?: Array<ComposeCell>;
  /**
   * tableRow — 열 폭 비율(R9). 합이 1이 아니면 정규화, 길이가 열 수와 다르면 균등 분할로 폴백.
   * 표의 **첫 행 값**을 표 전체에 적용한다(행마다 다른 폭은 지원하지 않음).
   */
  widths?: number[];
  runs: Array<{ text: string; bold?: boolean }>;
}

/** 조판 경고 — 요청은 성공했지만 의도와 다르게 나간 사항(색 형식 오류 등) */
export interface ComposeWarning { type: string; value?: string; count: number }

/** R10 — 미지원 글리프 대체 내역(호출자 보고용) */
export interface GlyphReplacement { from: string; to: string; count: number }

/** 표 셀 — 레거시(런 배열) 또는 병합 지원 객체(R11) */
export type ComposeCell =
  | Array<{ text: string; bold?: boolean }>
  | {
      runs: Array<{ text: string; bold?: boolean }>;
      colspan?: number;
      rowspan?: number;
      align?: 'left' | 'center' | 'right';
      /** R12 — 셀 단위 음영(라벨 칸만 회색인 국내 계약서·증명서 표준 서식). 헤더 행 음영과 별개. */
      shaded?: boolean;
      /** R12 — 음영 색상 직접 지정(`#rrggbb`). 미지정·형식 오류면 기본 음영색. */
      bg?: string;
    };

/** 셀 정규화 — 레거시/객체 두 형태를 하나로 */
function normalizeCell(cell: ComposeCell | undefined): { runs: Array<{ text: string; bold?: boolean }>; colspan: number; rowspan: number; align?: 'left' | 'center' | 'right'; shaded?: boolean; bg?: string } {
  if (Array.isArray(cell)) return { runs: cell, colspan: 1, rowspan: 1 };
  if (cell && Array.isArray(cell.runs)) {
    return {
      runs: cell.runs,
      colspan: Math.max(1, Math.min(8, Math.trunc(cell.colspan ?? 1) || 1)),
      rowspan: Math.max(1, Math.min(50, Math.trunc(cell.rowspan ?? 1) || 1)),
      align: cell.align,
      shaded: cell.shaded,
      bg: cell.bg,
    };
  }
  return { runs: [{ text: '' }], colspan: 1, rowspan: 1 };
}

/**
 * R10 — 폰트 미지원 글리프 대체표.
 * 임베드 폰트(나눔고딕)에 없는 문자는 **조용히 사라진다**(fontkit이 글리프 없음 → 미출력).
 * 계약서에 흔한 원문자·기호를 의미가 보존되는 대체 표기로 바꾸고, 대체 건수를 호출자에게 보고한다.
 */
const GLYPH_FALLBACKS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  // ①~⑳ → (1)~(20), ❶~❿·➊~➓ → (1)~(10)
  for (let i = 0; i < 20; i++) m[String.fromCodePoint(0x2460 + i)] = `(${i + 1})`;
  for (let i = 0; i < 10; i++) {
    m[String.fromCodePoint(0x2776 + i)] = `(${i + 1})`;
    m[String.fromCodePoint(0x2780 + i)] = `(${i + 1})`;
    m[String.fromCodePoint(0x278a + i)] = `(${i + 1})`;
  }
  // ㉠~㉭(원 한글), ㈀~㈎ 계열은 괄호 표기로
  for (let i = 0; i < 14; i++) m[String.fromCodePoint(0x3260 + i)] = `(${String.fromCodePoint(0x3131 + [0, 1, 3, 6, 7, 8, 16, 17, 18, 19, 20, 21, 22, 23][i])})`;
  // 도형·기호 — 지원되는 유사 글리프로
  Object.assign(m, {
    '⬤': '●', '⚫': '●', '⏺': '●', '◍': '○', '⭕': '○',
    '▪': '■', '▫': '□', '‧': '·', '∙': '·', '⋅': '·', '・': '·',
    '➤': '▶', '➔': '→', '⟶': '→', '✓': 'V', '✔': 'V', '☑': '[V]', '☐': '[ ]',
    '㎡': 'm2', '㎥': 'm3', '℃': '°C', '№': 'No.',
  });
  return m;
})();

/** 자유 배치 마크 — 배치 편집기(드래그)가 만든 페이지 상대좌표(0..1, y=상단 기준 좌상단 모서리). */
export interface PlacedMark {
  page: number; // 1-base
  x: number; // 0..1 (페이지 폭 기준)
  y: number; // 0..1 (페이지 높이 기준, 상단→하단)
  w: number; // 0..1
  h: number; // 0..1
  signer: number; // 서명자 순번(1-base)
  type: 'SIGN' | 'FIELD';
  label?: string; // FIELD 라벨
  fieldType?: FieldValueType; // FIELD 입력 타입(A4 고도화, 미지정=text — 기존 마크 하위호환)
}

/** 입력란(FIELD) 값 타입 — 서명자 기재값 검증·정규화 대상(설계 fill-at-signing §5 확정). */
export type FieldValueType = 'text' | 'date' | 'money' | 'number';
export const FIELD_VALUE_TYPES: FieldValueType[] = ['text', 'date', 'money', 'number'];

const A4: [number, number] = [595, 842];
const SHADE = rgb(0.94, 0.95, 0.97); // 표 음영 기본색(헤더 행·라벨 셀)

/** `#rrggbb` → pdf-lib rgb. 형식 오류면 null(기본 음영색 사용). */
function hexToRgb(hex: string): ReturnType<typeof rgb> | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
const MARGIN = 56;
const BODY_SIZE = 10;
const LINE_H = 16;

@Injectable()
export class ContractTemplateService {
  private readonly log = new Logger('ContractTemplate');
  private fontBytes: Buffer | null = null;
  private boldBytes: Buffer | null = null;

  constructor(private readonly config: ConfigService, @Inject(SIGN_STORE) private readonly store: SignStore) {}

  // 단일 meta(custom 배열·overrides/history 맵)의 read-modify-write 직렬화 — 동시 편집 lost update 방지.
  // 주의: 잠금 구간 안에서는 update() 대신 updateLocked() 사용(재진입 불가).
  private readonly mutex = new KeyedMutex();

  private loadFonts(): { regular: Buffer; bold: Buffer } {
    if (!this.fontBytes) this.fontBytes = readFileSync(join(process.cwd(), 'assets', 'fonts', 'NanumGothic-Regular.ttf'));
    if (!this.boldBytes) this.boldBytes = readFileSync(join(process.cwd(), 'assets', 'fonts', 'NanumGothic-Bold.ttf'));
    return { regular: this.fontBytes, bold: this.boldBytes };
  }

  enabled(): boolean {
    const v = (this.config.get<string>('GENERAL_CONTRACTS') ?? '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1';
  }
  private assertEnabled() {
    if (!this.enabled()) throw new NotFoundException('일반 전자계약 기능 비활성');
  }

  /** 내장(builtin, 오버라이드 반영) + 기관 커스텀 서식 목록. overridden=내장이 기관 편집본으로 대체됨. */
  async list(): Promise<Array<Omit<ContractTemplate, 'body' | 'fields'> & { builtin: boolean; overridden: boolean }>> {
    this.assertEnabled();
    const [custom, overrides] = await Promise.all([this.loadCustom(), this.loadOverrides()]);
    return [
      ...TEMPLATES.map((b) => {
        const t = overrides[b.id] ?? b;
        return { id: b.id, name: t.name, category: t.category, description: t.description, builtin: true, overridden: !!overrides[b.id] };
      }),
      ...custom.map(({ id, name, category, description }) => ({ id, name, category, description, builtin: false, overridden: false })),
    ];
  }

  /** 단일 서식(내장=오버라이드 우선, 없으면 커스텀). builtin·overridden 플래그 포함. */
  async get(id: string): Promise<ContractTemplate & { builtin: boolean; overridden: boolean }> {
    this.assertEnabled();
    const b = TEMPLATES.find((x) => x.id === id);
    if (b) {
      const ov = (await this.loadOverrides())[id];
      return ov ? { ...ov, id, builtin: true, overridden: true } : { ...b, builtin: true, overridden: false };
    }
    const c = (await this.loadCustom()).find((x) => x.id === id);
    if (c) return { ...c, builtin: false, overridden: false };
    throw new NotFoundException('서식 없음');
  }

  // ── 커스텀 서식 CRUD ────────────────────────────────────────────────────

  private async loadCustom(): Promise<ContractTemplate[]> {
    return (await this.store.getMeta<ContractTemplate[]>(CUSTOM_KEY)) ?? [];
  }
  private async loadOverrides(): Promise<Record<string, ContractTemplate>> {
    return (await this.store.getMeta<Record<string, ContractTemplate>>(OVERRIDE_KEY)) ?? {};
  }
  /**
   * 변경 직전 상태를 이력에 적재(서식당 최근 HISTORY_CAP건 유지).
   * 본문 슬롯과 **별개 슬롯**이라 한 트랜잭션으로 묶이지 않는다 — 그래서 본문 CAS 성공 뒤에 호출한다
   * (실패해도 서식 자체는 정합. 반대 순서면 쓰기 실패 시 유령 이력이 남는다).
   */
  private async pushHistory(id: string, snap: Omit<TemplateVersion, 'version'>): Promise<void> {
    await casUpdateMeta<Record<string, TemplateVersion[]>, void>(this.store, HISTORY_KEY, (cur) => {
      const all = { ...(cur ?? {}) };
      const list = all[id] ?? [];
      const version = (list[0]?.version ?? 0) + 1; // 재시도 시 최신 목록으로 다시 계산된다
      all[id] = [{ ...snap, version }, ...list].slice(0, HISTORY_CAP);
      return { write: all, result: undefined };
    });
  }
  private snapshot(t: { name: string; category: string; description: string; fields: TemplateField[]; body: string }, by: string, action: TemplateVersion['action']): Omit<TemplateVersion, 'version'> {
    return { savedAt: new Date().toISOString(), savedBy: by || '-', action, name: t.name, category: t.category, description: t.description, fields: t.fields, body: t.body };
  }
  private validate(input: { name?: string; category?: string; description?: string; fields?: TemplateField[]; body?: string }): { name: string; category: string; description: string; fields: TemplateField[]; body: string } {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('서식 이름은 필수');
    const body = (input.body ?? '').trim();
    if (body.length < 10) throw new BadRequestException('본문이 너무 짧습니다');
    const fields = (input.fields ?? []).map((f) => {
      const key = (f.key ?? '').trim();
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw new BadRequestException(`필드 key 형식 오류(영문 시작 영숫자): ${key}`);
      if (!FIELD_TYPES.includes(f.type)) throw new BadRequestException(`필드 type 오류: ${f.type}`);
      return { key, label: (f.label ?? key).trim(), type: f.type, placeholder: f.placeholder?.trim() || undefined, required: f.required !== false };
    });
    const keys = new Set(fields.map((f) => f.key));
    if (keys.size !== fields.length) throw new BadRequestException('필드 key 중복');
    // 본문의 {{key}} 가 모두 필드에 정의되어야 함(미해결 플레이스홀더 차단)
    const used = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((k) => !keys.has(k));
    if (missing.length) throw new BadRequestException(`본문의 플레이스홀더가 필드에 없음: ${missing.join(', ')}`);
    return { name, category: (input.category ?? '기타').trim() || '기타', description: (input.description ?? '').trim(), fields, body };
  }

  async createCustom(input: { name: string; category?: string; description?: string; fields?: TemplateField[]; body: string }): Promise<ContractTemplate> {
    this.assertEnabled();
    const v = this.validate(input);
    return this.mutex.run(TPL_LOCK, () =>
      casUpdateMeta<ContractTemplate[], ContractTemplate>(this.store, CUSTOM_KEY, (cur) => {
        const tpl: ContractTemplate = { id: `c-${randomUUID()}`, ...v };
        return { write: [tpl, ...(cur ?? [])], result: tpl };
      }),
    );
  }

  /**
   * 서식 수정 — 내장이면 기관 오버라이드로 저장(원본 보존·복원 가능), 커스텀이면 직접 수정.
   * 변경 직전 상태를 버전 이력에 적재. by=변경 주체(감사).
   */
  async update(id: string, input: { name?: string; category?: string; description?: string; fields?: TemplateField[]; body?: string }, by = ''): Promise<ContractTemplate & { builtin: boolean; overridden: boolean }> {
    this.assertEnabled();
    return this.mutex.run(TPL_LOCK, () => this.updateLocked(id, input, by));
  }

  /** update 본체 — TPL_LOCK 잠금 구간 내부에서만 호출(restore 재사용). */
  private async updateLocked(id: string, input: { name?: string; category?: string; description?: string; fields?: TemplateField[]; body?: string }, by = ''): Promise<ContractTemplate & { builtin: boolean; overridden: boolean }> {
    const mergeDefined = (base: ContractTemplate) => {
      const merged = { ...base };
      for (const k of ['name', 'category', 'description', 'fields', 'body'] as const) {
        if (input[k] !== undefined) (merged as Record<string, unknown>)[k] = input[k];
      }
      return merged;
    };
    const builtin = TEMPLATES.find((x) => x.id === id);
    if (builtin) {
      // 내장 → 오버라이드 저장(현재값=기존 오버라이드 또는 원본)
      const saved = await casUpdateMeta<Record<string, ContractTemplate>, { v: ContractTemplate; prev: ContractTemplate }>(
        this.store,
        OVERRIDE_KEY,
        (cur) => {
          const overrides = { ...(cur ?? {}) };
          const current = overrides[id] ?? builtin; // 재시도 시 최신 오버라이드 위에 다시 병합된다
          const v = { id, ...this.validate(mergeDefined(current)) };
          overrides[id] = v;
          return { write: overrides, result: { v, prev: current } };
        },
      );
      await this.pushHistory(id, this.snapshot(saved.prev, by, 'edit'));
      return { ...saved.v, builtin: true, overridden: true };
    }
    // 커스텀
    const saved = await casUpdateMeta<ContractTemplate[], { v: ContractTemplate; prev: ContractTemplate }>(this.store, CUSTOM_KEY, (cur) => {
      const list = [...(cur ?? [])];
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) throw new NotFoundException('서식 없음');
      const prev = list[idx];
      const v = { id, ...this.validate(mergeDefined(prev)) };
      list[idx] = v;
      return { write: list, result: { v, prev } };
    });
    await this.pushHistory(id, this.snapshot(saved.prev, by, 'edit'));
    return { ...saved.v, builtin: false, overridden: false };
  }

  /** 내장 서식을 코드 원본으로 되돌림(오버라이드 제거). 복원 직전 오버라이드를 이력에 적재. */
  async resetBuiltin(id: string, by = ''): Promise<ContractTemplate & { builtin: boolean; overridden: boolean }> {
    this.assertEnabled();
    const builtin = TEMPLATES.find((x) => x.id === id);
    if (!builtin) throw new BadRequestException('내장 서식만 기본값 복원이 가능합니다');
    const dropped = await this.mutex.run(TPL_LOCK, () =>
      casUpdateMeta<Record<string, ContractTemplate>, ContractTemplate | null>(this.store, OVERRIDE_KEY, (cur) => {
        const overrides = { ...(cur ?? {}) };
        const prev = overrides[id];
        if (!prev) return { result: null }; // 이미 원본 — 기록 없음(멱등)
        delete overrides[id];
        return { write: overrides, result: prev };
      }),
    );
    if (dropped) await this.pushHistory(id, this.snapshot(dropped, by, 'reset'));
    return { ...builtin, builtin: true, overridden: false };
  }

  /** 서식 변경 이력(최신순). */
  async history(id: string): Promise<TemplateVersion[]> {
    this.assertEnabled();
    return ((await this.store.getMeta<Record<string, TemplateVersion[]>>(HISTORY_KEY)) ?? {})[id] ?? [];
  }

  /** 특정 버전으로 되돌림 — 해당 스냅샷 내용으로 재저장(현재 상태는 이력에 적재됨). */
  async restore(id: string, version: number, by = ''): Promise<ContractTemplate & { builtin: boolean; overridden: boolean }> {
    this.assertEnabled();
    return this.mutex.run(TPL_LOCK, async () => {
      const snap = (((await this.store.getMeta<Record<string, TemplateVersion[]>>(HISTORY_KEY)) ?? {})[id] ?? []).find((h) => h.version === version);
      if (!snap) throw new NotFoundException('해당 버전 이력 없음');
      return this.updateLocked(id, { name: snap.name, category: snap.category, description: snap.description, fields: snap.fields, body: snap.body }, by);
    });
  }

  async removeCustom(id: string): Promise<{ removed: boolean }> {
    this.assertEnabled();
    if (TEMPLATES.some((x) => x.id === id)) throw new BadRequestException('내장 서식은 삭제할 수 없습니다(기본값 복원을 사용하세요)');
    return this.mutex.run(TPL_LOCK, () =>
      casUpdateMeta<ContractTemplate[], { removed: boolean }>(this.store, CUSTOM_KEY, (cur) => {
        const list = cur ?? [];
        const next = list.filter((x) => x.id !== id);
        if (next.length === list.length) return { result: { removed: false } };
        return { write: next, result: { removed: true } };
      }),
    );
  }

  /** 내장/커스텀 서식을 복제하여 편집용 커스텀 서식 생성. */
  async duplicate(id: string): Promise<ContractTemplate> {
    const src = await this.get(id);
    return this.createCustom({ name: `${src.name} (사본)`, category: src.category, description: src.description, fields: src.fields, body: src.body });
  }

  /**
   * 최종 본문 텍스트 → A4 한글 PDF 조판(나눔고딕 subset 임베드). 저장하지 않고 바이트 반환.
   *
   * 마커(단독 줄) — 에디터 툴바가 삽입, 서명자별 배치:
   *  - `[서명란#N]`        → N번째 서명자의 서명 위치 박스(라벨+표시명)
   *  - `[입력란#N:라벨]`   → N번째 서명자가 기재할 입력란(라벨+밑줄 박스)
   * signers[N-1].displayName 으로 라벨링(미전달 시 "N번 서명자").
   */
  /** 조판 + 본문 마커의 확정 좌표(R8) — 컨트롤러가 좌표를 응답 헤더로 실어 보낸다. */
  async composePdfWithMarks(title: string, body: string, signers: Array<{ order: number; displayName: string }> = [], marks: PlacedMark[] = [], doc?: ComposeBlock[]): Promise<{ bytes: Buffer; placedMarks: PlacedMark[]; glyphReplacements: GlyphReplacement[]; pages: number; warnings: ComposeWarning[] }> {
    return (await this.composePdf(title, body, signers, marks, doc, true)) as { bytes: Buffer; placedMarks: PlacedMark[]; glyphReplacements: GlyphReplacement[]; pages: number; warnings: ComposeWarning[] };
  }

  /** 폰트 지원 여부 판정기 — fontkit 미노출 환경에서는 대체표만 적용(안전 폴백) */
  private glyphChecker(fontBytes: Buffer): (ch: string) => boolean {
    try {
      const fk = (fontkit as unknown as { create(b: Buffer): { hasGlyphForCodePoint?(cp: number): boolean } }).create(fontBytes);
      if (typeof fk.hasGlyphForCodePoint !== 'function') return () => true;
      const cache = new Map<string, boolean>();
      return (ch: string) => {
        const hit = cache.get(ch);
        if (hit !== undefined) return hit;
        let ok = true;
        try { ok = !!fk.hasGlyphForCodePoint!(ch.codePointAt(0)!); } catch { ok = true; }
        cache.set(ch, ok);
        return ok;
      };
    } catch {
      return () => true;
    }
  }

  async composePdf(title: string, body: string, signers: Array<{ order: number; displayName: string }> = [], marks: PlacedMark[] = [], doc?: ComposeBlock[], withMarks = false): Promise<Buffer | { bytes: Buffer; placedMarks: PlacedMark[]; glyphReplacements: GlyphReplacement[]; pages: number; warnings: ComposeWarning[] }> {
    this.assertEnabled();
    const fonts = this.loadFonts();

    // R10 — 미지원 글리프 대체(조용한 삭제 방지). 본문·제목·표 셀 전 경로에 적용하고 대체 내역을 보고한다.
    const supported = this.glyphChecker(fonts.regular);
    const glyphCounts = new Map<string, { to: string; count: number }>();
    const sanitize = (text: string): string => {
      if (!text) return text;
      let out = '';
      for (const ch of text) {
        if (ch === '\n' || ch === '\t' || supported(ch)) { out += ch; continue; }
        const to = GLYPH_FALLBACKS[ch] ?? '?';
        const prev = glyphCounts.get(ch);
        glyphCounts.set(ch, { to, count: (prev?.count ?? 0) + 1 });
        out += to;
      }
      return out;
    };
    const sanitizeRuns = <T extends { text: string }>(runs: T[] | undefined): T[] | undefined =>
      runs?.map((r) => (typeof r?.text === 'string' ? { ...r, text: sanitize(r.text) } : r));

    title = sanitize(title);
    body = sanitize(body);
    if (doc) {
      doc = doc.map((b) => ({
        ...b,
        runs: (sanitizeRuns(b.runs) ?? []) as ComposeBlock['runs'],
        cells: b.cells?.map((cell) =>
          Array.isArray(cell)
            ? (sanitizeRuns(cell) as typeof cell)
            : ({ ...cell, runs: (sanitizeRuns(cell?.runs) ?? []) as ComposeBlock['runs'] } as typeof cell),
        ),
      }));
    }
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fonts.regular, { subset: false });
    const bold = await pdf.embedFont(fonts.bold, { subset: false });

    let page = pdf.addPage(A4);
    let y = A4[1] - MARGIN;
    const maxW = A4[0] - MARGIN * 2;

    // R8 — 본문 마커([서명란#N]·[입력란#N:라벨])로 그린 박스의 **확정 좌표** 수집.
    // 호출자는 흐름 조판 결과의 지면 위치를 알 수 없으므로, compose 응답 헤더로 돌려주어
    // 그대로 createContract 의 signMarks 로 쓰게 한다(페이지 상대 0..1, y=상단 기준).
    const placed: PlacedMark[] = [];
    // 조판 경고(R12 후속) — 요청은 성공했지만 **의도와 다르게 나간** 사항을 호출자에게 알린다.
    // 글리프 대체(R10)와 같은 취지: 실패로 막기보다 "조용한 어긋남"을 드러낸다.
    const warnCount = new Map<string, number>();
    const warn = (type: string, value: string) => {
      const key = `${type}\u0000${value}`;
      warnCount.set(key, (warnCount.get(key) ?? 0) + 1);
    };
    let pageNo = 1;
    const markAt = (signer: number, type: 'SIGN' | 'FIELD', x: number, topY: number, w: number, h: number): PlacedMark => ({
      page: pageNo,
      x: +(x / A4[0]).toFixed(4),
      y: +((A4[1] - topY) / A4[1]).toFixed(4),
      w: +(w / A4[0]).toFixed(4),
      h: +(h / A4[1]).toFixed(4),
      signer,
      type,
    });
    const newPageIfNeeded = (need = LINE_H) => {
      if (y - need < MARGIN) {
        page = pdf.addPage(A4);
        pageNo++;
        y = A4[1] - MARGIN;
      }
    };
    const draw = (text: string, size = BODY_SIZE) => {
      newPageIfNeeded(size + 6);
      page.drawText(text, { x: MARGIN, y, size, font });
      y -= size + 6;
    };

    // 제목(중앙) — 본문 첫 줄과 별도로 상단 배치.
    // 단, 리치 에디터(doc)는 첫 줄을 문서제목(h1)으로 승격하므로 그대로 그리면 제목이 두 번 인쇄된다(R11).
    const docLeadsWithTitle = !!doc && doc.length > 0 && doc[0]?.type === 'heading' && (doc[0]?.level ?? 1) === 1;
    if (!docLeadsWithTitle) {
      const titleSize = 16;
      const tw = font.widthOfTextAtSize(title, titleSize);
      page.drawText(title, { x: Math.max(MARGIN, (A4[0] - tw) / 2), y, size: titleSize, font });
      y -= titleSize + 18;
    }

    const signerLabel = (n: number) => {
      const s = signers.find((x) => x.order === n) ?? signers[n - 1];
      return s?.displayName ? `${s.displayName} (${n}번 서명자)` : `${n}번 서명자`;
    };
    const gray = rgb(0.45, 0.5, 0.58);
    const border = rgb(0.55, 0.6, 0.68);

    // 서명란 박스 — 서명 위치 시각 표시(실제 서명은 PKI 봉투 봉인, 박스는 문서상 표기)
    const drawSignBox = (n: number) => {
      const h = 64;
      newPageIfNeeded(h + 10);
      placed.push(markAt(n, 'SIGN', MARGIN, y, 250, h));
      page.drawRectangle({ x: MARGIN, y: y - h, width: 250, height: h, borderColor: border, borderWidth: 1 });
      page.drawText(`서명란 — ${signerLabel(n)}`, { x: MARGIN + 10, y: y - 18, size: 9, font, color: gray });
      page.drawText('(전자서명으로 봉인됩니다)', { x: MARGIN + 10, y: y - h + 10, size: 8, font, color: gray });
      y -= h + 12;
    };
    // 입력란 박스 — 기재 위치 표시(라벨 + 밑줄)
    const drawFieldBox = (n: number, label: string) => {
      const h = 30;
      newPageIfNeeded(h + 8);
      page.drawText(`${label}:`, { x: MARGIN, y: y - 16, size: BODY_SIZE, font });
      const lx = MARGIN + font.widthOfTextAtSize(`${label}:`, BODY_SIZE) + 8;
      placed.push({ ...markAt(n, 'FIELD', lx, y - 6, Math.min(240, A4[0] - MARGIN - lx), 18), label });
      page.drawLine({ start: { x: lx, y: y - 20 }, end: { x: Math.min(lx + 240, A4[0] - MARGIN), y: y - 20 }, thickness: 0.8, color: border });
      page.drawText(`${signerLabel(n)} 기재`, { x: lx + 4, y: y - 15, size: 7.5, font, color: gray });
      y -= h;
    };

    // 런 줄바꿈 레이아웃 — 굵기 혼합 문자열을 폭 기준(공백 우선)으로 줄 분할. drawRuns·표 셀 공용(A5).
    type Flat = { ch: string; b: boolean };
    const layoutRuns = (runs: Array<{ text: string; bold?: boolean }>, size: number, width: number, forceBold = false): Array<{ chars: Flat[]; width: number }> => {
      const flat: Flat[] = [];
      // 제어문자(줄바꿈·탭)는 공백으로 치환 — 그대로 두면 drawText 가 여러 줄을 그리는데 y 는 한 줄만
      // 내려가 다음 블록과 겹친다(API 직접 호출 경로, R13). 에디터 경로는 블록 단위라 무영향.
      for (const r of runs) for (const ch of r.text.replace(/[\u0000-\u001f\u007f]/g, ' ')) flat.push({ ch, b: forceBold || !!r.bold });
      const lines: Array<{ chars: Flat[]; width: number }> = [];
      let i = 0;
      while (i < flat.length) {
        let w = 0, end = i, lastSpace = -1;
        while (end < flat.length) {
          const f = flat[end];
          const cw = (f.b ? bold : font).widthOfTextAtSize(f.ch, size);
          if (w + cw > width && end > i) break;
          if (f.ch === ' ') lastSpace = end;
          w += cw; end++;
        }
        let lineEnd = end, next = end;
        if (end < flat.length && lastSpace > i) { lineEnd = lastSpace; next = lastSpace + 1; }
        const chars = flat.slice(i, lineEnd);
        lines.push({ chars, width: chars.reduce((acc, f) => acc + (f.b ? bold : font).widthOfTextAtSize(f.ch, size), 0) });
        i = next;
      }
      return lines.length ? lines : [{ chars: [], width: 0 }];
    };
    // 한 줄(세그먼트 병합) 그리기 — 시작 x 지정(정렬 오프셋 반영)
    const drawLineChars = (chars: Flat[], size: number, x0: number, atY: number) => {
      let x = x0, segStart = 0;
      for (let j = 1; j <= chars.length; j++) {
        if (j === chars.length || chars[j].b !== chars[segStart].b) {
          const text = chars.slice(segStart, j).map((f) => f.ch).join('');
          const f = chars[segStart].b ? bold : font;
          page.drawText(text, { x, y: atY, size, font: f });
          x += f.widthOfTextAtSize(text, size);
          segStart = j;
        }
      }
    };
    // 스타일 런 조판 — 정렬(left/center/right)·들여쓰기(목록) 지원(A5)
    const drawRuns = (runs: Array<{ text: string; bold?: boolean }>, size: number, forceBold = false, opts: { align?: 'left' | 'center' | 'right'; indent?: number } = {}) => {
      const indent = opts.indent ?? 0;
      const avail = maxW - indent;
      for (const line of layoutRuns(runs, size, avail, forceBold)) {
        newPageIfNeeded(size + 6);
        const off = opts.align === 'center' ? (avail - line.width) / 2 : opts.align === 'right' ? avail - line.width : 0;
        drawLineChars(line.chars, size, MARGIN + indent + Math.max(0, off), y);
        y -= size + 6;
      }
    };
    // 표 조판(A5+R9+R11) — 연속 tableRow 블록을 한 표로.
    //   R9: widths(열 폭 비율) 지정 가능(미지정=균등) · R11: 셀 colspan/rowspan 병합
    //   행 높이=그 행에서 끝나는 셀의 최대 줄수, rowspan 셀은 걸친 행 높이 합에 맞춰 보정.
    //   페이지 분할은 **rowspan으로 묶인 행 그룹 단위**(그룹 내부는 쪼개지 않음).
    const drawTableRows = (rows: Array<{ header?: boolean; cells?: Array<ComposeCell>; widths?: number[] }>) => {
      const CSIZE = 9, CPAD = 5, LINE = CSIZE + 3;

      // ── 1) 그리드 배치 — rowspan 점유(carry)를 피해 열을 채운다
      type Placed = { r: number; c: number; colspan: number; rowspan: number; runs: Array<{ text: string; bold?: boolean }>; header: boolean; align?: 'left' | 'center' | 'right'; shaded?: boolean; bg?: string };
      const placedCells: Placed[] = [];
      const carry: number[] = []; // 열 index → 남은 rowspan 행 수
      let colCount = 1;
      rows.forEach((row, r) => {
        let c = 0;
        for (const raw of row.cells ?? []) {
          const cell = normalizeCell(raw);
          while (carry[c] > 0) { carry[c] -= 1; c += 1; }
          placedCells.push({ r, c, colspan: cell.colspan, rowspan: cell.rowspan, runs: cell.runs, header: !!row.header, align: cell.align, shaded: cell.shaded, bg: cell.bg });
          if (cell.rowspan > 1) for (let k = 0; k < cell.colspan; k++) carry[c + k] = cell.rowspan - 1;
          c += cell.colspan;
        }
        // 이 행에서 소비되지 않은 carry 감소(행 끝 잔여)
        for (let k = c; k < carry.length; k++) if (carry[k] > 0) carry[k] -= 1;
        colCount = Math.max(colCount, c);
      });
      if (colCount > 12) throw new BadRequestException('표 열이 너무 많습니다(최대 12열) — 표를 나눠 주세요');

      // ── 2) 열 폭(R9) — 첫 행의 widths를 표 전체에 적용. 합 1 정규화, 길이 불일치 시 균등
      const wSpec = rows.find((r) => Array.isArray(r.widths) && r.widths.length === colCount)?.widths;
      const sum = wSpec?.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0) ?? 0;
      const colW: number[] = wSpec && sum > 0
        ? wSpec.map((w) => (maxW * (Number(w) > 0 ? Number(w) : 0)) / sum)
        : Array.from({ length: colCount }, () => maxW / colCount);
      const colX = (c: number) => MARGIN + colW.slice(0, c).reduce((a, b) => a + b, 0);
      const spanW = (c: number, n: number) => colW.slice(c, c + n).reduce((a, b) => a + b, 0);

      // ── 3) 행 높이 — rowspan=1 셀로 기본 높이, 걸친 셀은 부족분을 마지막 행에 보탬
      const lineCache = new Map<Placed, Array<{ chars: Flat[]; width: number }>>();
      const linesOf = (p: Placed) => {
        let v = lineCache.get(p);
        if (!v) { v = layoutRuns(p.runs.length ? p.runs : [{ text: '' }], CSIZE, spanW(p.c, p.colspan) - CPAD * 2, p.header); lineCache.set(p, v); }
        return v;
      };
      const rowH = rows.map(() => LINE + CPAD * 2);
      for (const p of placedCells) {
        if (p.rowspan !== 1) continue;
        rowH[p.r] = Math.max(rowH[p.r], linesOf(p).length * LINE + CPAD * 2);
      }
      for (const p of placedCells) {
        if (p.rowspan === 1) continue;
        const need = linesOf(p).length * LINE + CPAD * 2;
        const last = Math.min(rows.length - 1, p.r + p.rowspan - 1);
        const have = rowH.slice(p.r, last + 1).reduce((a, b) => a + b, 0);
        if (need > have) rowH[last] += need - have;
      }

      // ── 4) 페이지 분할 단위 — rowspan으로 묶인 연속 행을 한 그룹으로
      const groupEnd = rows.map((_, r) => r);
      for (const p of placedCells) {
        if (p.rowspan <= 1) continue;
        const last = Math.min(rows.length - 1, p.r + p.rowspan - 1);
        for (let r = p.r; r <= last; r++) groupEnd[r] = Math.max(groupEnd[r], last);
      }
      const groups: Array<{ from: number; to: number }> = [];
      for (let r = 0; r < rows.length; ) {
        let to = groupEnd[r];
        for (let k = r; k <= to; k++) to = Math.max(to, groupEnd[k]);
        groups.push({ from: r, to });
        r = to + 1;
      }

      // ── 5) 그리기
      const rowTop: number[] = new Array(rows.length).fill(0);
      // R13 — 표가 페이지를 넘기면 다음 장에 **헤더 행을 다시 그린다**(열 제목 없는 페이지 방지).
      // 선행 헤더 행 묶음(표 맨 위 연속 header 행)만 반복 대상으로 삼는다.
      const headerRows: number[] = [];
      for (let r = 0; r < rows.length && rows[r]?.header; r++) headerRows.push(r);
      const headerH = headerRows.reduce((a, r) => a + rowH[r], 0);
      const drawGroup = (from: number, to: number) => {
        let top = y;
        for (let r = from; r <= to; r++) { rowTop[r] = top; top -= rowH[r]; }
        for (const p of placedCells) {
          if (p.r < from || p.r > to) continue;
          const last = Math.min(to, p.r + p.rowspan - 1);
          const h = rowH.slice(p.r, last + 1).reduce((a, b) => a + b, 0);
          const x = colX(p.c), w = spanW(p.c, p.colspan);
          const cellTop = rowTop[p.r];
          // R12 — 헤더 행 음영 + **셀 단위 음영**(라벨 칸만 회색인 국내 표준 서식). bg 지정 시 그 색.
          const fill = p.bg ? hexToRgb(p.bg) : null;
          if (p.bg && !fill) warn('invalid-bg', String(p.bg).slice(0, 20)); // 색 형식 오류 → 기본 음영으로 폴백(발행은 계속)
          if (p.header || p.shaded || fill) page.drawRectangle({ x, y: cellTop - h, width: w, height: h, color: fill ?? SHADE });
          page.drawRectangle({ x, y: cellTop - h, width: w, height: h, borderColor: border, borderWidth: 0.7 });
          let ly = cellTop - CPAD - CSIZE;
          for (const line of linesOf(p)) {
            const avail = w - CPAD * 2;
            const off = p.align === 'center' ? (avail - line.width) / 2 : p.align === 'right' ? avail - line.width : 0;
            drawLineChars(line.chars, CSIZE, x + CPAD + Math.max(0, off), ly);
            ly -= LINE;
          }
        }
        y -= rowH.slice(from, to + 1).reduce((a, b) => a + b, 0);
      };

      for (const g of groups) {
        const gH = rowH.slice(g.from, g.to + 1).reduce((a, b) => a + b, 0);
        // 그룹 내부는 쪼개지 않으므로 한 페이지를 넘으면 내용이 소실된다 → 명시 거부
        if (gH + 2 > A4[1] - MARGIN * 2) throw new BadRequestException('표의 한 행(또는 병합 구간)이 한 페이지를 넘습니다 — 셀 내용을 줄이거나 병합을 나눠 주세요');
        const isHeaderGroup = headerRows.includes(g.from);
        const pageBefore = pageNo;
        // 헤더를 반복해야 하므로 다음 장 진입 시 헤더 높이까지 여유를 본다
        newPageIfNeeded(gH + 2 + (isHeaderGroup || !headerRows.length ? 0 : headerH));
        if (pageNo !== pageBefore && headerRows.length && !isHeaderGroup) {
          drawGroup(headerRows[0], headerRows[headerRows.length - 1]); // 새 페이지 상단에 열 제목 재출력
        }
        drawGroup(g.from, g.to);
      }
      // y 는 "다음 줄의 베이스라인" 이라, 6pt 만 띄우면 다음 문단의 글자 윗부분(≈0.75×글자크기)이
      // 표 하단 테두리를 파고든다(R7 실측: 표 아래 문단이 테두리와 겹쳐 인쇄). 한 줄 높이만큼 띄운다.
      y -= LINE_H;
    };

    const handleMarkerLine = (text: string): boolean => {
      const sign = text.trim().match(/^\[서명란#(\d+)\]$/);
      if (sign) { drawSignBox(Number(sign[1])); return true; }
      const field = text.trim().match(/^\[입력란#(\d+):(.+)\]$/);
      if (field) { drawFieldBox(Number(field[1]), field[2].trim()); return true; }
      return false;
    };

    // 표 셀 검증(A5) — cells 는 2차원 구조라 DTO 중첩 검증 한계 → 여기서 형식·상한 강제(비정형 400)
    // 오류에 **몇 번째 표 행**인지 포함 — 위치를 모르면 긴 문서에서 수정 지점을 찾을 수 없다(R14)
    let tableRowNo = 0;
    for (const b of doc ?? []) {
      if (b.type !== 'tableRow') continue;
      tableRowNo++;
      const at = `표 ${tableRowNo}번째 행`;
      if (!Array.isArray(b.cells) || b.cells.length === 0 || b.cells.length > 12) throw new BadRequestException(`${at}: 형식 오류(셀 1~12개)`);
      for (const cell of b.cells) {
        // R11 — 셀은 런 배열(레거시) 또는 { runs, colspan, rowspan } 객체
        const runs = Array.isArray(cell) ? cell : (cell as { runs?: unknown })?.runs;
        if (!Array.isArray(runs)) throw new BadRequestException(`${at}: 셀 형식 오류(런 배열 또는 { runs, colspan, rowspan })`);
        if (!Array.isArray(cell)) {
          const { colspan, rowspan } = cell as { colspan?: unknown; rowspan?: unknown };
          if (colspan !== undefined && (!Number.isFinite(colspan) || (colspan as number) < 1 || (colspan as number) > 12)) throw new BadRequestException(`${at}: colspan 범위 오류(1~12)`);
          if (rowspan !== undefined && (!Number.isFinite(rowspan) || (rowspan as number) < 1 || (rowspan as number) > 50)) throw new BadRequestException(`${at}: rowspan 범위 오류(1~50)`);
        }
        for (const r of runs as Array<{ text?: unknown }>) {
          if (typeof r?.text !== 'string' || r.text.length > 10_000) throw new BadRequestException(`${at}: 셀 텍스트 형식 오류(최대 10,000자)`);
        }
      }
      // R9 — 열 폭 비율(선택)
      if (b.widths !== undefined) {
        if (!Array.isArray(b.widths) || b.widths.length > 12) throw new BadRequestException(`${at}: widths 형식 오류(최대 12개)`);
        for (const w of b.widths) if (!Number.isFinite(w) || (w as number) <= 0) throw new BadRequestException(`${at}: widths 값 오류(0보다 큰 수)`);
      }
    }

    if (doc && doc.length > 0) {
      // 리치 블록 경로 — 문서제목(h1)/조항제목(h2)=굵게·큰 글씨, 문단=런 단위 굵기
      let tableBuf: ComposeBlock[] = []; // 연속 tableRow 를 한 표로 묶기(A5)
      const flushTable = () => { if (tableBuf.length) { drawTableRows(tableBuf); tableBuf = []; } };
      for (const block of doc) {
        if (block.type === 'tableRow') { tableBuf.push(block); continue; }
        flushTable();
        if (block.type === 'listItem') {
          // 목록(A5) — 들여쓰기(깊이별)+접두(불릿/번호)
          const depth = Math.max(1, Math.min(4, block.level ?? 1));
          const prefix = block.ordered ? `${block.index ?? 1}. ` : '• ';
          drawRuns([{ text: prefix }, ...block.runs], BODY_SIZE, false, { indent: 14 * depth });
          continue;
        }
        const plain = block.runs.map((r) => r.text).join('');
        if (!plain.trim()) { y -= LINE_H / 2; newPageIfNeeded(); continue; }
        if (handleMarkerLine(plain)) continue;
        if (block.type === 'heading') {
          const lvl = block.level === 1 ? 1 : 2;
          y -= lvl === 1 ? 6 : 4; // 블록 위 여백
          // 정렬(A5) — h1 기본 가운데(기존 시각 관례), 그 외 기본 왼쪽
          drawRuns(block.runs, lvl === 1 ? 14 : 11.5, true, { align: block.align ?? (lvl === 1 ? 'center' : 'left') });
          y -= 2;
        } else {
          drawRuns(block.runs, BODY_SIZE, false, { align: block.align });
          y -= 3; // 문단 간격
        }
      }
      flushTable(); // 문서 끝이 표인 경우
    } else {
      for (const rawLine of body.split('\n')) {
        const lineText = rawLine.replace(/\s+$/, '');
        if (!lineText) { y -= LINE_H / 2; newPageIfNeeded(); continue; }
        if (handleMarkerLine(lineText)) continue;
        for (const wrapped of this.wrap(lineText, font, BODY_SIZE, maxW)) draw(wrapped);
      }
    }

    // 자유 배치 마크(배치 편집기 좌표) — 본문 조판 후 절대좌표로 렌더. 페이지 초과분은 마지막 페이지로 클램프.
    this.drawPlacedMarks(pdf, font, marks, signers);

    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    // R10 — 대체된 글리프 내역(문자·대체표기·건수). 호출자는 응답 헤더로 확인해 발행 전 교정할 수 있다.
    const glyphReplacements: GlyphReplacement[] = [...glyphCounts.entries()].map(([from, v]) => ({ from, to: v.to, count: v.count }));
    if (glyphReplacements.length) {
      this.log.warn(`미지원 글리프 대체 ${glyphReplacements.reduce((a, g) => a + g.count, 0)}건: ${glyphReplacements.map((g) => `${g.from}→${g.to}(${g.count})`).join(', ')}`);
    }
    // pages — 호출자가 PDF 바이트를 정규식으로 세지 않도록 조판 결과 페이지 수를 함께 반환
    const warnings = [...warnCount].map(([k, count]) => { const [type, value] = k.split('\u0000'); return { type, value, count }; });
    if (warnings.length) this.log.warn(`조판 경고: ${warnings.map((w) => `${w.type}(${w.value})×${w.count}`).join(', ')}`);
    return withMarks ? { bytes, placedMarks: placed, glyphReplacements, pages: pdf.getPageCount(), warnings } : bytes;
  }

  /** 업로드/조판 PDF에 자유 배치 마크 스탬프 — 배치 편집기 좌표(0..1)를 각 페이지 절대좌표로 렌더. */
  async stampPdf(pdfBytes: Buffer, marks: PlacedMark[], signers: Array<{ order: number; displayName: string }> = []): Promise<Buffer> {
    this.assertEnabled();
    if (!marks.length) return pdfBytes; // 폰트 임베드(약 1.6MB)·재직렬화로 해시만 바뀌는 것 방지
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(pdfBytes);
    } catch (e) {
      // 암호화·손상 PDF — 500(내부 오류) 대신 원인이 드러나는 400
      throw new BadRequestException(`배치할 수 없는 PDF입니다(암호화·손상): ${(e as Error).message}`);
    }
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(this.loadFonts().regular, { subset: false });
    this.drawPlacedMarks(pdf, font, marks, signers);
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }

  /** 마크 렌더 공용 — y 는 상단 기준(UI 좌표계) → PDF 하단 기준으로 변환. */
  private drawPlacedMarks(pdf: PDFDocument, font: PDFFont, marks: PlacedMark[], signers: Array<{ order: number; displayName: string }>): void {
    if (!marks.length) return;
    const pages = pdf.getPages();
    const gray = rgb(0.45, 0.5, 0.58);
    const border = rgb(0.55, 0.6, 0.68);
    const name = (n: number) => {
      const s = signers.find((x) => x.order === n) ?? signers[n - 1];
      return s?.displayName ? `${s.displayName} (${n}번 서명자)` : `${n}번 서명자`;
    };
    const fit = (text: string, size: number, maxW: number) => {
      let t = text;
      while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
      return t === text ? text : t.slice(0, -1) + '…';
    };
    for (const m of marks) {
      const page = pages[Math.min(Math.max(1, Math.round(m.page)), pages.length) - 1];
      const { width: pw, height: ph } = page.getSize();
      const wn = Math.max(0.02, Math.min(1, m.w));
      const hn = Math.max(0.015, Math.min(1, m.h));
      const w = wn * pw;
      const h = hn * ph;
      const x = Math.min(Math.max(0, m.x), 1 - wn) * pw;
      const yTop = Math.min(Math.max(0, m.y), 1 - hn) * ph;
      const yPdf = ph - yTop - h; // 상단 기준 → PDF 하단 기준
      page.drawRectangle({ x, y: yPdf, width: w, height: h, borderColor: border, borderWidth: 1 });
      if (m.type === 'SIGN') {
        page.drawText(fit(`서명란 — ${name(m.signer)}`, 9, w - 16), { x: x + 8, y: yPdf + h - 14, size: 9, font, color: gray });
        if (h >= 34) page.drawText('(전자서명으로 봉인됩니다)', { x: x + 8, y: yPdf + 8, size: 7.5, font, color: gray });
      } else {
        page.drawText(fit(`${m.label?.trim() || '기재란'} — ${name(m.signer)} 기재`, 8.5, w - 16), { x: x + 8, y: yPdf + h - 13, size: 8.5, font, color: gray });
        page.drawLine({ start: { x: x + 8, y: yPdf + 7 }, end: { x: x + w - 8, y: yPdf + 7 }, thickness: 0.8, color: border });
      }
    }
  }

  /** 한글 폭 기준 줄바꿈 — 공백 우선, 초과 시 문자 단위 분할. */
  private wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    if (font.widthOfTextAtSize(text, size) <= maxW) return [text];
    const out: string[] = [];
    let cur = '';
    for (const ch of text) {
      const next = cur + ch;
      if (font.widthOfTextAtSize(next, size) > maxW) {
        // 마지막 공백에서 끊기(있으면) — 어절 유지
        const sp = cur.lastIndexOf(' ');
        if (sp > 0) {
          out.push(cur.slice(0, sp));
          cur = cur.slice(sp + 1) + ch;
        } else {
          out.push(cur);
          cur = ch;
        }
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
    return out;
  }
}
