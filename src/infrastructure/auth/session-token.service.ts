// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AdminRole } from './rbac';
import { resolveSessionPolicy } from './session-policy';

export interface SessionClaims {
  sub: string; // username
  role: AdminRole;
  iat: number; // 발급(epoch ms)
  exp: number; // 만료(epoch ms)
  jti?: string; // 세션 식별자 — 서버측 세션 레지스트리 매칭(idle 강제·동시세션·폐기)
}

/**
 * 관리자 콘솔 세션 토큰 — 무상태 HMAC 서명 토큰(`<payload_b64>.<sig_b64>`).
 * 멀티노드 일관(서버 측 세션 저장 불필요), 만료(exp) 내장. 기계 키(x-api-key)와 별개 인증 경로.
 *
 * 비밀키: SESSION_SECRET > CRYPTO_MASTER_KEY(운영 필수) > 개발용 임시. 마스터키 파생이라 별도 시크릿
 * 주입 없이도 동작하되, 마스터키 회전 시 기존 세션은 무효(재로그인) — 의도된 안전 동작.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SessionTokenService {
  private readonly logger = new Logger('SessionToken');
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly idleMin: number;

  constructor(config: ConfigService) {
    const raw =
      config.get<string>('SESSION_SECRET') ||
      config.get<string>('CRYPTO_MASTER_KEY') ||
      (() => {
        if (config.get<string>('NODE_ENV') === 'production') {
          throw new Error('SESSION_SECRET 또는 CRYPTO_MASTER_KEY 필수 (production) — 세션 위조 방지');
        }
        const g = randomBytes(32).toString('base64');
        this.logger.warn('SESSION_SECRET/CRYPTO_MASTER_KEY 미설정 — 개발용 임시 세션키(운영 금지)');
        return g;
      })();
    // 토큰 서명 전용 키 분리(다른 용도 마스터키와 직접 동일 사용 회피)
    this.secret = createHmac('sha256', raw).update('sign-admin-session-v1').digest();
    // TTL·idle 은 공통 세션 정책에서 해석(SessionRegistryService 와 동일 값 보장).
    const policy = resolveSessionPolicy(config);
    this.ttlMs = policy.ttlMin * 60_000;
    this.idleMin = policy.idleMin;
  }

  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }

  /** 비활동 자동 로그아웃 허용 시간(분). 0 = 비활성(절대 만료만). 클라이언트(콘솔)가 idle 타이머에 사용. */
  get idleTimeoutMinutes(): number {
    return this.idleMin;
  }

  /** username·role 로 서명 토큰 발급. now 는 테스트 주입용(미지정 시 현재시각). */
  issue(sub: string, role: AdminRole, now: number = Date.now()): { token: string; expiresAt: string; jti: string; iat: number; exp: number } {
    const jti = randomBytes(16).toString('hex');
    const exp = now + this.ttlMs;
    const claims: SessionClaims = { sub, role, iat: now, exp, jti };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    return { token, expiresAt: new Date(exp).toISOString(), jti, iat: now, exp };
  }

  /** 2차 인증 챌린지 토큰 — 1차(ID/PW) 통과 후 단기(5분). 세션 아님(mfa=true). */
  issueMfaChallenge(sub: string, now: number = Date.now()): string {
    const exp = now + 5 * 60_000;
    const payload = Buffer.from(JSON.stringify({ sub, mfa: true, exp })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** 챌린지 토큰 검증 → sub. 실패 시 null. */
  verifyMfaChallenge(token: string | undefined, now: number = Date.now()): string | null {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    if (!this.safeEqual(token.slice(dot + 1), this.sign(payload))) return null;
    try {
      const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; mfa?: boolean; exp?: number };
      if (!c?.sub || c.mfa !== true || !c.exp || c.exp <= now) return null;
      return c.sub;
    } catch {
      return null;
    }
  }

  /** 토큰 검증 — 서명·만료 확인. 실패 시 null(무효/만료). */
  verify(token: string | undefined, now: number = Date.now()): SessionClaims | null {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(payload);
    if (!this.safeEqual(sig, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
      if (!claims?.sub || !claims.exp || claims.exp <= now) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
