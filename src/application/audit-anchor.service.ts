// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { TSA_PROVIDER, TsaProvider } from '../domain/ports/tsa-provider.port';
import { TimestampToken } from '../domain/types/pki.types';
import { ExternalRfc3161Client } from '../infrastructure/tsa/external-rfc3161.provider';

export const ANCHOR_EXTERNAL_TSAS = Symbol('ANCHOR_EXTERNAL_TSAS');

/**
 * 감사 TSA 앵커링 — design §16 / FR-21 + 앵커 이중화(보안 트랙 S1).
 *
 * 체인 head 를 TSA 로 봉인하여, 내부자가 전체 체인을 재계산하는 위변조까지 탐지한다.
 * 자체 TSA 만으로는 **TSA 키도 운영자 수중**이라 재앵커 위조가 가능(T1) → 외부 RFC3161
 * TSA 토큰을 병기해 운영자 독립 증거를 만든다.
 *
 * 역할 분담:
 *  - 자체 TSA 토큰: 로컬 암호 검증(재기동 후에도 publicKey 로 즉시 검증).
 *  - 외부 TSA 토큰: 제3자 검증(openssl ts -verify — DER 원문 보존). 로컬은 구조 검증까지.
 * 외부 발급은 **best-effort** — 완료 경로(서명·체결·결재)를 외부 TSA 장애가 막으면 안 되므로
 * 짧은 타임아웃으로 시도하고, 실패분은 주기 스윕(sweep)이 보충한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class AuditAnchorService {
  private readonly log = new Logger('AuditAnchor');

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
    @Inject(TSA_PROVIDER) private readonly tsa: TsaProvider,
    @Optional() @Inject(ANCHOR_EXTERNAL_TSAS) private readonly externals: ExternalRfc3161Client[] = [],
  ) {}

  /** 현재 체인 head 를 자체 TSA + 외부 TSA(구성 시)로 앵커. 완료 시·스윕에서 호출. */
  async anchor(key: string): Promise<void> {
    const entries = await this.store.auditEntries(key);
    if (!entries.length) return;
    const head = entries[entries.length - 1].entryHash;
    const token = await this.tsa.stamp(head);
    const externalTokens = await this.stampExternals(key, head);
    await this.store.saveAnchor({
      key,
      headHash: head,
      entryCount: entries.length,
      tsToken: token,
      periodAt: token.genTime,
      ...(externalTokens.length ? { externalTokens } : {}),
    });
  }

  /** 외부 TSA 병렬 발급 — 실패는 warn 만(완료 경로 비차단). */
  private async stampExternals(key: string, head: string): Promise<TimestampToken[]> {
    if (!this.externals.length) return [];
    const results = await Promise.allSettled(this.externals.map((c) => c.stamp(head)));
    const tokens: TimestampToken[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') tokens.push(r.value);
      else this.log.warn(`외부 앵커 실패(${this.externals[i].url}, stream=${key}): ${(r.reason as Error)?.message}`);
    });
    return tokens;
  }

  /**
   * 주기 앵커 스윕(S1-2) — 전 감사 스트림을 훑어 다음 조건이면 재앵커한다:
   *  ① 앵커가 없다(관리 스트림 admin:auth 등은 이벤트 구동 앵커 경로가 없어 여기서만 앵커됨)
   *  ② head 가 앵커 이후 전진했다
   *  ③ 외부 TSA 가 구성돼 있는데 앵커에 외부 토큰이 없다(완료 시점 발급 실패분 보충)
   * 외부 TSA 호출량 보호를 위해 실행당 상한(maxPerRun)을 두고, 초과분은 로그로 알린다.
   */
  async sweep(maxPerRun = 500): Promise<{ scanned: number; anchored: number; skippedByCap: number }> {
    const keys = await this.store.auditKeys('');
    let anchored = 0;
    let skippedByCap = 0;
    for (const key of keys) {
      const entries = await this.store.auditEntries(key);
      if (!entries.length) continue;
      const head = entries[entries.length - 1].entryHash;
      const cur = await this.store.getLatestAnchor(key);
      const needsExternal = this.externals.length > 0 && !(cur?.externalTokens?.length);
      if (cur && cur.headHash === head && !needsExternal) continue;
      if (anchored >= maxPerRun) { skippedByCap++; continue; }
      await this.anchor(key);
      anchored++;
    }
    if (skippedByCap) this.log.warn(`앵커 스윕 상한 도달 — ${skippedByCap}개 스트림 이월(다음 주기 처리)`);
    return { scanned: keys.length, anchored, skippedByCap };
  }

  /** 체인 무결성 + 앵커 검증(자체 + 외부 구조 검증). */
  async verify(key: string): Promise<{
    chainValid: boolean;
    anchored: boolean;
    anchorTsValid: boolean;
    anchorMatchesChain: boolean;
    valid: boolean;
    currentHead: string | null;
    anchoredAt: string | null;
    /** 외부 앵커(S1) — 토큰별 로컬 구조 검증 결과. 완전 검증은 openssl ts(운영 가이드). */
    externalAnchors: Array<{ tsaProvider: string; genTime: string; structureValid: boolean }>;
  }> {
    const entries = await this.store.auditEntries(key);
    const chain = this.audit.verify(entries);
    const currentHead = entries.length ? entries[entries.length - 1].entryHash : null;
    const anchor = await this.store.getLatestAnchor(key);

    if (!anchor) {
      return { chainValid: chain.valid, anchored: false, anchorTsValid: false, anchorMatchesChain: false, valid: false, currentHead, anchoredAt: null, externalAnchors: [] };
    }
    // TSA 토큰이 앵커 headHash에 대한 유효 시점인지
    const anchorTsValid = this.tsa.verify(anchor.tsToken as TimestampToken, anchor.headHash);
    // 앵커된 지점의 엔트리 해시가 봉인된 head와 일치 (앵커 prefix 위변조 탐지)
    const anchoredEntry = entries[anchor.entryCount - 1];
    const anchorMatchesChain = !!anchoredEntry && anchoredEntry.entryHash === anchor.headHash;
    const externalAnchors = ((anchor.externalTokens as TimestampToken[] | undefined) ?? []).map((t) => ({
      tsaProvider: t.tsaProvider,
      genTime: t.genTime,
      structureValid: ExternalRfc3161Client.verifyStructure(t, anchor.headHash),
    }));

    return {
      chainValid: chain.valid,
      anchored: true,
      anchorTsValid,
      anchorMatchesChain,
      // valid 판정은 종전과 동일(체인+자체앵커+정합) — 외부 앵커는 부가 증거로 병기.
      // 외부 TSA 미구성/일시 장애가 기존 검증 API 의 valid 를 흔들면 안 되기 때문.
      valid: chain.valid && anchorTsValid && anchorMatchesChain,
      currentHead,
      anchoredAt: anchor.periodAt,
      externalAnchors,
    };
  }
}
