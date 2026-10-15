// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Logger } from '@nestjs/common';
import { TimestampToken } from '../../domain/types/pki.types';
import { buildTimeStampReq, parseTimeStampResp } from './rfc3161';

/**
 * 외부 RFC3161 TSA 클라이언트 — 감사 앵커 이중화(S1)용.
 *
 * 자체 TSA(SELF)는 서명키가 sign 자신의 KeySigner 에 있어 **운영자 독립 증거가 아니다**.
 * 외부 TSA 토큰은 운영자가 위조할 수 없으므로, 앵커에 이 토큰을 병기하면
 * "운영자(서버 장악자)가 체인 전체를 재계산+재앵커하는" T1 위협이 차단된다.
 *
 * 토큰은 표준 TimeStampToken DER 원문을 base64 로 보존한다(`tbs` 필드 재사용) —
 * 제3자가 `openssl ts -verify` 로 sign 과 무관하게 검증 가능(운영 가이드 §감사 앵커).
 * 로컬 verify 는 imprint 일치 + 구조 정합까지(근거는 rfc3161.ts 헤더 주석).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class ExternalRfc3161Client {
  private readonly log = new Logger('ExternalTSA');

  constructor(
    readonly url: string,
    private readonly timeoutMs = 4000, // 완료 경로에 best-effort 로 끼므로 짧게 — 실패 시 스윕이 재시도
  ) {}

  /** messageHash(hex)에 대한 외부 시점 토큰. 실패 시 throw — 호출자(anchor)가 best-effort 처리. */
  async stamp(messageHashHex: string): Promise<TimestampToken> {
    const { der, nonceHex } = buildTimeStampReq(messageHashHex);
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: new Uint8Array(der),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`외부 TSA HTTP ${res.status} (${this.url})`);
    const parsed = parseTimeStampResp(Buffer.from(await res.arrayBuffer()));
    if (parsed.messageImprintHex !== messageHashHex) throw new Error('외부 TSA 응답 imprint 불일치');
    if (parsed.nonceHex && parsed.nonceHex !== nonceHex.replace(/^0+/, '') && parsed.nonceHex !== nonceHex) {
      throw new Error('외부 TSA 응답 nonce 불일치(재생 응답 의심)');
    }
    return {
      tsaProvider: `RFC3161:${this.url}`,
      tbs: parsed.tokenDer.toString('base64'), // TimeStampToken DER 원문(제3자 검증용)
      sig: '', // 서명은 CMS(tbs) 내부에 포함 — 별도 필드 불사용
      genTime: parsed.genTime,
    };
  }

  /** 로컬 구조 검증 — DER 파싱 + imprint 일치. (완전 검증은 openssl ts — 클래스 주석) */
  static verifyStructure(token: TimestampToken, expectedHashHex: string): boolean {
    try {
      const parsed = parseTimeStampResp(wrapAsResp(Buffer.from(token.tbs, 'base64')));
      return parsed.messageImprintHex === expectedHashHex;
    } catch {
      return false;
    }
  }
}

/**
 * 저장된 토큰은 TimeStampToken(ContentInfo)만 — 파서는 TimeStampResp 를 기대하므로
 * 최소 status(granted) 헤더를 앞에 붙여 동일 파서를 재사용한다.
 */
function wrapAsResp(tokenDer: Buffer): Buffer {
  const statusInfo = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]); // SEQUENCE { INTEGER 0 }
  const body = Buffer.concat([statusInfo, tokenDer]);
  return Buffer.concat([derSeqHeader(body.length), body]);
}

function derSeqHeader(len: number): Buffer {
  if (len < 0x80) return Buffer.from([0x30, len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x30, 0x80 | bytes.length, ...bytes]);
}
