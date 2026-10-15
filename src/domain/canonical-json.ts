// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Canonical JSON 직렬화 — 키를 재귀적으로 정렬해 저장소 무관 안정 해시/서명을 보장.
 *
 * 왜 필요한가: SignStore 어댑터별 JSON 보존 특성이 다르다.
 *  - InMemory/File: JS 객체 키 삽입순서 보존
 *  - PostgreSQL JSONB(Prisma): **키 순서 미보존**(재정렬), 저장→재로딩 시 키 순서가 바뀐다.
 * 따라서 저장된 객체를 다시 `JSON.stringify`로 해시/서명 검증하면 JSONB에서만 불일치가 발생한다.
 * 해시/서명 대상 직렬화는 반드시 이 canonical 경로를 사용한다(라이브 PG e2e로 회귀 확인).
 *
 * 규칙: 객체 키는 사전순 정렬, 배열 순서는 보존, undefined 값은 JSON.stringify와 동일하게 제외.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function canonicalBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(src[k]);
        return acc;
      }, {});
  }
  return v;
}
