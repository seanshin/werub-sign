// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 인프로세스 키별 뮤텍스 — 동일 키의 read-modify-write 구간을 프로미스 체인으로 직렬화.
 * meta KV(단일 배열/맵) 동시 갱신 lost update 방지용. 단일 노드 배포 전제(현 운영 토폴로지 — 다중 노드 전환 시 저장소 수준 잠금으로 대체 필요).
 * 재진입 불가 — 잠금 구간 안에서 같은 키로 run() 을 다시 호출하면 데드락(내부 unlocked 구현으로 분리할 것).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** fn 을 키 직렬 구간에서 실행 — 같은 키의 이전 작업이 끝난 뒤 시작(이전 작업 실패와 무관). */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
