// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP(RFC 6238) — 관리자 콘솔 2차 인증(인증앱). 의존성 0(node crypto).
 * 기본: HMAC-SHA1·30초 step·6자리. 시크릿은 base32(인증앱 호환).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = (str || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 20바이트(160bit) 랜덤 시크릿 → base32(인증앱 등록용). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secretB32: string, counter: number, digits = 6): string {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretB32: string, time = Date.now(), step = 30, digits = 6): string {
  return hotp(secretB32, Math.floor(time / 1000 / step), digits);
}

/** 코드 검증 — 시계 드리프트 허용(±window step). 상수시간 비교. */
export function verifyTotp(secretB32: string, code: string, window = 1, time = Date.now(), step = 30, digits = 6): boolean {
  const c = (code || '').replace(/\s/g, '');
  if (c.length !== digits || !/^\d+$/.test(c)) return false;
  const counter = Math.floor(time / 1000 / step);
  const cb = Buffer.from(c);
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secretB32, counter + w, digits));
    if (expected.length === cb.length && timingSafeEqual(expected, cb)) return true;
  }
  return false;
}

/** 인증앱에 표시되는 발급자(브랜드). MS/Google Authenticator 등에서 계정명으로 노출. */
export const TOTP_ISSUER = 'WeRUB.B Sign';

/** 인증앱 등록 URI(QR). 예: otpauth://totp/WeRUB.B%20Sign:admin?secret=…&issuer=WeRUB.B%20Sign
 *  공백·점이 포함된 issuer는 encodeURIComponent(%20)로 인코딩(일부 앱이 '+'를 오해석하는 것 방지).
 *  imageUrl: 비표준 image 파라미터 — Authy·2FAS 등 지원 앱에서 로고 표시(MS/Google은 무시·무해). */
export function otpauthUri(secretB32: string, account: string, issuer = TOTP_ISSUER, imageUrl?: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  let query = `secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  if (imageUrl) query += `&image=${encodeURIComponent(imageUrl)}`;
  return `otpauth://totp/${label}?${query}`;
}
