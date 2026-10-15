// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 목록 페이지네이션 헬퍼 (C-3) — 응답 크기 바운드 + total 메타.
 * 저장 모델이 JSON 블롭(kind/rkey/data)이라 정렬·필터가 서비스 계층에 있어 DB 레벨 정렬
 * 페이지네이션은 스키마 컬럼화가 필요(향후). 현재는 서비스가 정렬/필터한 배열을 슬라이스한다.
 *
 * 하위호환: limit 미지정 시 전체 반환(기존 클라 무영향). limit 지정 시 페이지 슬라이스.
 * 응답은 항상 `{ data: items, page: { total, limit, offset } }`(data는 배열 유지).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { SearchOpts } from '../domain/search';

const MAX_LIMIT = 200;

export interface PageOpts {
  limit?: number;
  offset: number;
}

/** 목록 검색 파라미터 파싱 — q(부분일치, 소문자정규화)·status(정확일치). 둘 다 없으면 undefined. */
export function parseSearch(query: { q?: string; status?: string }): SearchOpts | undefined {
  const q = typeof query?.q === 'string' ? query.q.trim().toLowerCase() : '';
  const status = typeof query?.status === 'string' ? query.status.trim() : '';
  if (!q && !status) return undefined;
  return { q: q || undefined, status: status || undefined };
}

/**
 * 기간 필터 파싱 — from/to(ISO) 우선, 없으면 days(최근 N일)→from 계산. 둘 다 없으면 빈 객체.
 * 잘못된 값은 무시(전체). 대시보드 기본 기간(working set 상한)·커스텀 범위 지원.
 */
export function parseDateRange(query: { from?: string; to?: string; days?: string }, now: number = Date.now()): { from?: string; to?: string } {
  const iso = (v?: string) => {
    if (!v || typeof v !== 'string') return undefined;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  };
  const from = iso(query?.from);
  const to = iso(query?.to);
  if (from || to) return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const days = query?.days !== undefined ? Number(query.days) : undefined;
  if (days !== undefined && Number.isFinite(days) && days > 0) {
    return { from: new Date(now - Math.floor(days) * 86_400_000).toISOString() };
  }
  return {};
}

export function parsePage(query: { limit?: string; offset?: string }): PageOpts {
  const rawLimit = query?.limit !== undefined ? Number(query.limit) : undefined;
  const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit))) : undefined;
  const rawOffset = query?.offset !== undefined ? Number(query.offset) : 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}

export function paginate<T>(items: T[], opts: PageOpts): { data: T[]; page: { total: number; limit: number; offset: number } } {
  const total = items.length;
  const offset = Math.min(opts.offset, total);
  const sliced = opts.limit !== undefined ? items.slice(offset, offset + opts.limit) : items.slice(offset);
  return { data: sliced, page: { total, limit: opts.limit ?? total, offset } };
}
