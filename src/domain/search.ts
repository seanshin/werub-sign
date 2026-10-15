// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 서버측 목록 검색(필터) — 순수 유틸(레이어 무의존). C-3 페이지네이션과 결합해
 * 슬라이스 전에 적용한다(전체 집합 대상 검색 → 페이지를 가로지르는 일치까지 포함).
 *
 * 저장 모델이 JSON 블롭이라 어차피 kind 전체를 메모리로 읽으므로, 서비스 계층 필터가 자연스럽다.
 * (DB 인덱스 검색은 스키마 컬럼화가 필요 — 향후 과제. 현 규모에선 충분.)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface SearchOpts {
  q?: string; // 소문자 정규화된 부분일치 질의
  status?: string; // 상태 정확일치(예: COMPLETED·REVOKED)
}

export function applySearch<T>(
  items: T[],
  opts: SearchOpts | undefined,
  fields: (item: T) => Array<string | undefined | null>,
  statusOf?: (item: T) => string,
): T[] {
  if (!opts) return items;
  let out = items;
  if (opts.status && statusOf) out = out.filter((it) => statusOf(it) === opts.status);
  if (opts.q) {
    const q = opts.q;
    out = out.filter((it) => fields(it).some((f) => !!f && f.toLowerCase().includes(q)));
  }
  return out;
}
