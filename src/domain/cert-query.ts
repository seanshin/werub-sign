// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { StoredCert } from './types/store.types';

/**
 * 인증서 목록 질의 — 검색·페이지(상태는 서버 필터가 아니라 표시값, 유형 탭·초성은 콘솔 클라이언트 정제).
 * DB 푸시다운(Prisma)·인메모리(InMemory/File) 어댑터가 동일 의미로 구현. CA 앵커는 항상 제외(말단만).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface CertQuery {
  limit?: number;
  offset: number;
  q?: string; // 소문자 정규화 부분일치(시리얼·주체DN·유형·면허번호)
}

/** 검색 대상 텍스트(소문자) — 시리얼·주체DN·ownerType·면허번호. 저장소 검색/인덱싱 단일 출처. */
export function certSearchText(c: StoredCert): string {
  const t = c.cert.tbs;
  const parts: Array<string | undefined> = [t.serialNumber, t.subjectDn, t.ownerType, t.licenseNumber];
  return parts.filter((s): s is string => !!s).join(' ').toLowerCase();
}

/** 인메모리 필터(CA 제외 + 검색) — InMemory/File 공용(Prisma는 동일 의미를 SQL로 푸시다운). */
export function certMatches(c: StoredCert, q: CertQuery): boolean {
  if (c.cert.tbs.ownerType === 'CA') return false; // CA 앵커 제외(말단만)
  if (q.q && !certSearchText(c).includes(q.q)) return false;
  return true;
}

/** notBefore 내림차순(최신 발급 우선). 동률·부재 시 시리얼 보조 비교(안정 정렬). */
export function byNotBeforeDesc(a: StoredCert, b: StoredCert): number {
  const an = a.cert.tbs.notBefore ?? '';
  const bn = b.cert.tbs.notBefore ?? '';
  if (an !== bn) return an < bn ? 1 : -1;
  const as = a.cert.tbs.serialNumber ?? '';
  const bs = b.cert.tbs.serialNumber ?? '';
  return as < bs ? 1 : as > bs ? -1 : 0;
}
