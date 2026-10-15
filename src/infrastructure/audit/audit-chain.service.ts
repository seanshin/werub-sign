// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditEntry } from '../../domain/types/store.types';
import { canonicalJson } from '../../domain/canonical-json';
import { KeyedMutex } from '../../domain/keyed-mutex';
import { retryOnConflict } from '../../domain/optimistic-retry';

export { AuditEntry };

/**
 * 감사추적 해시체인 — append-only, prevHash→entryHash (위변조 탐지).
 * conventions.md §4: AuditTrail은 이 단일 경로로만 기록. UPDATE/DELETE 금지.
 *
 * 본 클래스는 체인 계산 로직(순수). 영속화는 SignStore 어댑터가 담당.
 * 주기적으로 head를 TSA로 앵커링(AuditAnchor)하여 내부자 전체 재계산도 탐지.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const ZERO = '0'.repeat(64);

@Injectable()
export class AuditChainService {
  static entryHash(prevHash: string, eventType: string, data: unknown, occurredAt: string): string {
    return createHash('sha256')
      // canonical(키정렬) — JSONB 등 키순서 미보존 저장소에서도 감사 해시체인이 안정.
      .update(prevHash + canonicalJson(data) + occurredAt + eventType)
      .digest('hex');
  }

  // 스트림 단위 append 직렬화 — 싱글턴이므로 서비스가 달라도 같은 스트림이면 같은 잠금을 공유한다.
  // 인프로세스 **빠른 경로**: 같은 노드의 경합은 재시도 없이 흡수한다(R16 이후에도 유지하는 이유).
  private readonly appendMutex = new KeyedMutex();

  /**
   * `lastAudit → next → appendAudit` 구간 직렬화 + **저장소 충돌 재시도**.
   *
   * 직렬화하지 않으면 동시 요청이 같은 prevHash 를 읽어 **append-only 체인이 영구히 끊긴다**
   * (예: 교부 링크 첨부 다운로드 동시 다발 → CONTRACT_ATTACHMENT_ACCESSED 중복 append).
   *
   * 뮤텍스는 인프로세스라 다중 노드·롤링 배포에서는 두 프로세스가 같은 prevHash 를 읽을 수 있다(R16).
   * 그 분기는 저장소가 유니크 제약으로 거부(`StoreConflictError`)하므로, 여기서 **재조회 후 재시도**해
   * 노드 수와 무관하게 체인이 단일 선형으로 수렴한다. `run` 은 lastAudit 재조회를 포함해야 한다
   * (재시도 시 stale prevHash 로 다시 실패하지 않도록) — 호출부 규약.
   */
  async appendSerialized<T>(streamKey: string, run: () => Promise<T>): Promise<T> {
    return this.appendMutex.run(`audit:${streamKey}`, () => retryOnConflict(run, { attempts: 6 }));
  }

  /** 다음 엔트리 생성 (prevHash = 직전 entryHash, 없으면 ZERO) */
  next(prevEntry: AuditEntry | null, eventType: string, data: unknown, occurredAt: string): AuditEntry {
    const prevHash = prevEntry ? prevEntry.entryHash : ZERO;
    return { eventType, data, occurredAt, prevHash, entryHash: AuditChainService.entryHash(prevHash, eventType, data, occurredAt) };
  }

  /** 체인 무결성 검증 */
  verify(entries: AuditEntry[]): { valid: boolean; brokenAt?: number; reason?: string } {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const prev = i ? entries[i - 1].entryHash : ZERO;
      if (e.prevHash !== prev) return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
      if (AuditChainService.entryHash(e.prevHash, e.eventType, e.data, e.occurredAt) !== e.entryHash) {
        return { valid: false, brokenAt: i, reason: 'entryHash mismatch' };
      }
    }
    return { valid: true };
  }
}
