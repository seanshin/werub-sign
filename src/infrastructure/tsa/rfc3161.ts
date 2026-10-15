// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import forge from 'node-forge';
import { randomBytes } from 'node:crypto';

/**
 * RFC3161 최소 코덱 — 외부 공인/공개 TSA 와의 상호운용용(S1 앵커 이중화).
 *
 * 범위(의도적 제한):
 *  - 요청: TimeStampReq DER 생성(sha256 imprint · nonce · certReq).
 *  - 응답: TimeStampResp 에서 status·TSTInfo(messageImprint·genTime·nonce)를 **구조 파싱**.
 *
 * CMS 서명(signedAttrs) 전체 암호 검증은 여기서 하지 않는다 — 외부 앵커의 존재 이유가
 * "운영자와 무관한 제3자가 검증"이므로, 토큰 DER 원문을 그대로 보존해 `openssl ts -verify`
 * 등 표준 도구로 검증하게 한다(절차는 운영 가이드). 로컬 검증은 imprint 일치 + 구조 정합까지.
 * (자체 TSA 앵커가 로컬 암호 검증을 담당하는 이중 구조 — audit-anchor.service 참조)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';

const { asn1 } = forge;

/** TimeStampReq DER — version=1, sha256 imprint, nonce, certReq=TRUE(응답에 TSA 인증서 포함 요청). */
export function buildTimeStampReq(messageHashHex: string): { der: Buffer; nonceHex: string } {
  const nonceHex = randomBytes(8).toString('hex');
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, String.fromCharCode(1)), // version
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [ // MessageImprint
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_SHA256).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''), // openssl 관행과 동일(NULL params)
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hexToBinary(messageHashHex)),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, hexToBinary(positiveIntHex(nonceHex))), // nonce
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)), // certReq TRUE
  ]);
  return { der: Buffer.from(asn1.toDer(req).getBytes(), 'binary'), nonceHex };
}

export interface ParsedTimeStampResp {
  /** PKIStatus — 0(granted)·1(grantedWithMods)만 성공 */
  status: number;
  /** TimeStampToken(ContentInfo) DER — 제3자 검증(openssl ts)용 원문 */
  tokenDer: Buffer;
  /** TSTInfo.messageImprint 의 해시(hex) */
  messageImprintHex: string;
  /** TSTInfo.genTime → ISO8601 */
  genTime: string;
  /** TSTInfo.nonce(hex, 없으면 null) — 요청 nonce 와 대조해 재생 응답 차단 */
  nonceHex: string | null;
}

/** TimeStampResp DER 구조 파싱 — 형식 위반 시 throw(호출자가 앵커 실패로 처리). */
export function parseTimeStampResp(respDer: Buffer): ParsedTimeStampResp {
  const resp = asn1.fromDer(forge.util.createBuffer(respDer.toString('binary')));
  const parts = resp.value as forge.asn1.Asn1[];
  // PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }
  const statusInfo = parts[0].value as forge.asn1.Asn1[];
  const status = derIntToNumber(statusInfo[0]);
  if (!(status === 0 || status === 1)) {
    throw new Error(`TSA 거부(status=${status})`);
  }
  const token = parts[1];
  if (!token) throw new Error('TimeStampToken 없음(granted 인데 토큰 누락)');
  const tokenDer = Buffer.from(asn1.toDer(token).getBytes(), 'binary');

  // ContentInfo { OID signedData, [0] SignedData { version, digestAlgs, encapContentInfo { OID tstInfo, [0] OCTET STRING } ... } }
  const tokenParts = token.value as forge.asn1.Asn1[];
  const contentType = asn1.derToOid(forge.util.createBuffer(tokenParts[0].value as string));
  if (contentType !== OID_SIGNED_DATA) throw new Error(`토큰이 CMS SignedData 아님(${contentType})`);
  const signedData = (tokenParts[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const encap = signedData[2].value as forge.asn1.Asn1[];
  const eContentType = asn1.derToOid(forge.util.createBuffer(encap[0].value as string));
  if (eContentType !== OID_TST_INFO) throw new Error(`eContent 가 TSTInfo 아님(${eContentType})`);
  const eContentOctet = (encap[1].value as forge.asn1.Asn1[])[0];
  const tstInfoDer = eContentOctet.value as string; // OCTET STRING 내부 = TSTInfo DER

  // TSTInfo ::= SEQUENCE { version, policy OID, messageImprint, serialNumber, genTime, [accuracy] [ordering] [nonce] ... }
  const tst = asn1.fromDer(forge.util.createBuffer(tstInfoDer)).value as forge.asn1.Asn1[];
  const imprint = tst[2].value as forge.asn1.Asn1[];
  const messageImprintHex = Buffer.from(imprint[1].value as string, 'binary').toString('hex');
  let genTime = '';
  let nonceHex: string | null = null;
  for (let i = 4; i < tst.length; i++) {
    const node = tst[i];
    if (!genTime && node.type === asn1.Type.GENERALIZEDTIME) {
      genTime = generalizedTimeToIso(node.value as string);
    } else if (genTime && node.type === asn1.Type.INTEGER && node.tagClass === asn1.Class.UNIVERSAL) {
      // genTime 뒤의 첫 INTEGER = nonce(accuracy 는 SEQUENCE, ordering 은 BOOLEAN 이라 충돌 없음)
      nonceHex = Buffer.from(node.value as string, 'binary').toString('hex').replace(/^00/, '');
      break;
    }
  }
  if (!genTime) throw new Error('TSTInfo.genTime 없음');
  return { status, tokenDer, messageImprintHex, genTime, nonceHex };
}

/** GeneralizedTime("YYYYMMDDHHMMSS[.fff]Z") → ISO8601. */
function generalizedTimeToIso(gt: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(gt.trim());
  if (!m) throw new Error(`GeneralizedTime 형식 오류: ${gt}`);
  const frac = m[7] ? `.${m[7].slice(0, 3).padEnd(3, '0')}` : '.000';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}Z`;
}

function derIntToNumber(node: forge.asn1.Asn1): number {
  const bytes = node.value as string;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n = n * 256 + bytes.charCodeAt(i);
  return n;
}

function hexToBinary(hex: string): string {
  return Buffer.from(hex, 'hex').toString('binary');
}

/** DER INTEGER 는 최상위 비트가 1이면 음수 — 앞에 00 을 붙여 양수 보장. */
function positiveIntHex(hex: string): string {
  return parseInt(hex.slice(0, 2), 16) >= 0x80 ? '00' + hex : hex;
}
