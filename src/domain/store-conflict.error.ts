// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 저장소 수준 낙관적 잠금 충돌(R16) — 다른 노드/프로세스가 먼저 같은 슬롯·체인 위치를 차지했다.
 * 데이터 오류가 아니라 **경합 신호**이므로, 호출자는 최신 상태를 재조회해 RMW 를 재시도한다.
 * (재시도로도 수렴하지 않으면 그때 5xx 로 승격 — `retryOnConflict` 참조)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class StoreConflictError extends Error {
  constructor(readonly detail: string) {
    super(`store conflict: ${detail}`);
    this.name = 'StoreConflictError';
  }
}

export function isStoreConflict(e: unknown): e is StoreConflictError {
  return e instanceof StoreConflictError || (e as { name?: string })?.name === 'StoreConflictError';
}
