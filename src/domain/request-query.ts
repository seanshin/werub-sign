// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { StoredRequest } from './types/store.types';

/**
 * 서명요청 목록 질의 — 상태·기간·검색·페이지를 한 번에 표현(C-3 확장).
 * DB 푸시다운(Prisma)·인메모리(InMemory/File) 어댑터가 동일 의미로 구현하도록 공용 정의.
 * limit 미지정 = 전체(하위호환). from/to = createdAt ISO 경계(포함).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
/** 미완료(서명 대기) 상태 집합. */
export const INCOMPLETE_STATUSES = ['CREATED', 'IN_PROGRESS'];

export interface RequestQuery {
  limit?: number;
  offset: number;
  status?: string; // 정확일치
  q?: string; // 소문자 정규화 부분일치(제목·문서ID·요청ID·참가자명)
  from?: string; // ISO — createdAt >= from
  to?: string; // ISO — createdAt <= to
  createdBy?: string; // 출처 소비자(hospitalrun·pacs·erp·console) 정확일치
  signMode?: string; // 서명모드(APP·PORTAL·MULTI…) 정확일치
  incomplete?: boolean; // 미완료(CREATED·IN_PROGRESS)만 — status 와 배타(미완료 우선)
  // 계약 트랙 필터(A3) — StoredRequest.ct* 캐시 기준(정본 contract-meta 와 ContractService 가 동기화)
  archived?: boolean; // true=보관만 / false=보관 제외(미설정 레거시 행은 비보관 취급)
  category?: string; // 분류 정확일치(미설정 행은 '기타')
  label?: string; // 라벨 포함
}

/** 검색 대상 텍스트(소문자) — 제목·문서ID·요청ID·참가자명. 저장소 검색/인덱싱 일관성 단일 출처. */
export function requestSearchText(r: StoredRequest): string {
  const parts: Array<string | undefined> = [r.title, r.externalDocId, r.requestId, ...(r.participants ?? []).map((p) => p.displayName)];
  return parts.filter((s): s is string => !!s).join(' ').toLowerCase();
}

/** 인메모리 필터(상태·기간·검색) — InMemory/File 스토어 공용(Prisma는 동일 의미를 SQL로 푸시다운). */
export function requestMatches(r: StoredRequest, q: RequestQuery): boolean {
  if (q.incomplete) { if (!INCOMPLETE_STATUSES.includes(r.status)) return false; }
  else if (q.status && r.status !== q.status) return false;
  const created = r.createdAt ?? '';
  if (q.from && created < q.from) return false;
  if (q.to && created > q.to) return false;
  if (q.createdBy && r.createdBy !== q.createdBy) return false;
  if (q.signMode && r.signMode !== q.signMode) return false;
  if (q.q && !requestSearchText(r).includes(q.q)) return false;
  if (q.archived !== undefined && (r.ctArchived === true) !== q.archived) return false;
  if (q.category && (r.ctCategory ?? '기타') !== q.category) return false;
  if (q.label && !(r.ctLabels ?? []).includes(q.label)) return false;
  return true;
}

/** createdAt 내림차순(최신 우선). 동률·부재 시 requestId 보조 비교(안정 정렬). */
export function byCreatedDesc(a: StoredRequest, b: StoredRequest): number {
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  if (ac !== bc) return ac < bc ? 1 : -1;
  return a.requestId < b.requestId ? 1 : a.requestId > b.requestId ? -1 : 0;
}
