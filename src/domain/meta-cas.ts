// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { SignStore } from './ports/sign-store.port';
import { StoreConflictError } from './store-conflict.error';
import { retryOnConflict } from './optimistic-retry';

type MetaStore = Pick<SignStore, 'getMetaVersioned' | 'saveMetaIfUnchanged'>;

/**
 * `mutate` 결과 — `write` 가 있으면 CAS 기록, 없으면 기록 없이 `result` 만 반환(멱등 no-op·검증 실패 경로).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export type MetaMutation<S, R> = { write: S; result: R } | { result: R };

/**
 * 메타 슬롯 read-modify-write 를 **낙관적 잠금**으로 수행(R16).
 *
 * 배열 한 칸에 목록 전체를 담는 슬롯(프리셋·주소록·서식·첨부 목록)은 `getMeta → 수정 → saveMeta` 사이에
 * 다른 프로세스가 끼어들면 통째로 덮어써져 lost update 가 난다. 인프로세스 뮤텍스는 같은 노드만 막으므로,
 * 여기서 **버전 일치 시에만 기록**하고 경합하면 최신 값으로 재조회해 다시 계산한다.
 *
 * `mutate` 는 재시도될 수 있으므로 **부수효과가 없어야 한다**(감사 기록·로그·알림은 반환 후에).
 * 업무 예외(400/403 등)는 그대로 전파된다 — 재시도 대상은 CAS 충돌뿐.
 */
export async function casUpdateMeta<S, R>(
  store: MetaStore,
  key: string,
  mutate: (current: S | null) => Promise<MetaMutation<S, R>> | MetaMutation<S, R>,
  opts?: { attempts?: number },
): Promise<R> {
  return retryOnConflict(async () => {
    const { value, version } = await store.getMetaVersioned<S>(key);
    const outcome = await mutate(value);
    if (!('write' in outcome)) return outcome.result;
    if (!(await store.saveMetaIfUnchanged(key, version, outcome.write))) {
      throw new StoreConflictError(`meta slot "${key}" changed by another process`);
    }
    return outcome.result;
  }, opts);
}
