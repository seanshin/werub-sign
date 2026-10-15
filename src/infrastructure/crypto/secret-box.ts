// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isHardened } from '../security/hardening';

/**
 * 봉인 시크릿 — 평문 저장 금지(연동 자격증명 등). SoftKeySigner와 동일 AES-256-GCM.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface SealedSecret {
  iv: string; // base64
  enc: string; // base64
  tag: string; // base64
}

/**
 * SecretBox — 연동 설정의 벤더 자격증명(API키 등)을 CRYPTO_MASTER_KEY 로 AES-256-GCM 봉인.
 * 런타임 설정 스토어가 DB(SignStore meta)에 보관할 때 평문 금지를 강제한다.
 * 개발(마스터키 미설정)에서는 dev 폴백 키로 동작(운영은 production 부팅 가드가 마스터키 강제).
 */
export class SecretBox {
  private readonly master: Buffer;

  constructor(masterKeyBase64?: string) {
    const raw = masterKeyBase64 ? Buffer.from(masterKeyBase64, 'base64') : Buffer.alloc(0);
    if (raw.length !== 32) {
      // 운영/하드닝(KEY_SIGNER 드라이버 무관)에서는 약한 dev 폴백키로 벤더 시크릿을 봉인하지 않는다.
      // proxy 모드라도 설정 스토어 시크릿 봉인엔 CRYPTO_MASTER_KEY 가 필요(서명키 격리와 별개).
      if (isHardened()) {
        throw new Error('CRYPTO_MASTER_KEY 32바이트(base64) 필수 — 연동 설정 시크릿 봉인용(운영). dev 폴백키 사용 금지.');
      }
      this.master = Buffer.alloc(32, 7); // 개발 전용 폴백
    } else {
      this.master = raw;
    }
  }

  seal(plaintext: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    return { iv: iv.toString('base64'), enc: enc.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  open(sealed: SealedSecret): string {
    // authTagLength 명시 — 미지정 시 Node 가 4바이트까지 잘린 태그도 수용(위조 확률 2^-32)
    const d = createDecipheriv('aes-256-gcm', this.master, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(sealed.enc, 'base64')), d.final()]).toString('utf8');
  }

  /** 바이너리 봉인 — 포털 문서 PDF 등 원본 바이트(base64 문자열 왕복 없이 Buffer 직접). */
  sealBytes(plaintext: Buffer): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv: iv.toString('base64'), enc: enc.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  openBytes(sealed: SealedSecret): Buffer {
    // authTagLength 명시 — 미지정 시 Node 가 4바이트까지 잘린 태그도 수용(위조 확률 2^-32)
    const d = createDecipheriv('aes-256-gcm', this.master, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(sealed.enc, 'base64')), d.final()]);
  }
}
