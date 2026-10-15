// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { isStoreConflict } from './store-conflict.error';

/**
 * 낙관적 잠금 재시도(R16) — CAS 실패(`StoreConflictError`)만 재시도하고, 그 외 예외는 즉시 전파.
 *
 * 인프로세스 `KeyedMutex` 가 같은 노드의 경합을 이미 직렬화하므로, 여기까지 오는 충돌은
 * **다른 노드/프로세스와의 경합**뿐이다(수평 확장·롤링 배포). 따라서 시도 횟수는 크지 않아도 되고,
 * 지수 백오프에 지터를 섞어 두 노드가 같은 주기로 재충돌하는 라이브락을 피한다.
 *
 * 재시도가 소진되면 마지막 충돌을 그대로 던진다 — 호출자가 409/503 중 무엇으로 노출할지 결정한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export async function retryOnConflict<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseMs?: number }): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? 5);
  const baseMs = Math.max(1, opts?.baseMs ?? 12);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isStoreConflict(e)) throw e;
      last = e;
      if (i === attempts - 1) break;
      const backoff = baseMs * 2 ** i;
      await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * backoff)));
    }
  }
  throw last;
}
