// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { TimestampToken } from '../types/pki.types';

/**
 * TsaProvider 포트 — RFC3161 신뢰 시점.
 * 자체 TSA(SELF) ↔ 외부 공인 TSA 교체축.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const TSA_PROVIDER = Symbol('TSA_PROVIDER');

export interface TsaProvider {
  /** messageHash(hex)에 신뢰 시점 토큰 발급 */
  stamp(messageHashHex: string): Promise<TimestampToken>;

  /** 토큰이 expectedHash에 대한 유효한 시점인지 검증 */
  verify(token: TimestampToken, expectedHashHex: string): boolean;
}
