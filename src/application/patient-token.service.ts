// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';

interface PatientToken {
  participantId: string;
  issuedAt?: string; // 발급 시각(ISO) — 수신처 정정 시 이전 링크 무효화 판정(R4)
  requestId: string;
  expiresAt: number; // epoch ms
  usedAt: string | null;
  unlockedAt?: string | null; // 일반 전자계약 접근암호 통과 시각(계약 트랙 전용, unlock 전 열람·서명 차단)
}

const PREFIX = 'ptoken:';
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * 환자 서명 액세스 토큰 — 원외/standalone fallback 흐름(design §2.5 태블릿/웹뷰 fallback).
 * 참가자별 일회용·만료 토큰으로 동의서 열람→본인확인→서명을 비로그인 환자에게 제공.
 * HIS 환자앱이 주 채널이며, 본 흐름은 fallback(앱 미사용·원외 비대면 링크).
 *
 * 보안: 토큰 단일사용 + 만료. (rate-limit·IP/기기 바인딩은 DMZ reverse-proxy 병행 — ops §2.2)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class PatientTokenService {
  constructor(@Inject(SIGN_STORE) private readonly store: SignStore) {}

  /** 요청의 미서명 참가자별 토큰 발급 (HIS가 발송용 링크 확보) */
  async issueForRequest(requestId: string, ttlMs = DEFAULT_TTL_MS): Promise<Array<{ participantId: string; signerRole: string; token: string; url: string }>> {
    const req = await this.store.getRequest(requestId);
    if (!req) throw new NotFoundException('request not found');
    const out = [];
    for (const p of req.participants) {
      if (p.status === 'SIGNED') continue;
      const { token, url } = await this.issueForParticipant(requestId, p.participantId, ttlMs);
      out.push({ participantId: p.participantId, signerRole: p.signerRole, token, url });
    }
    return out;
  }

  /** 단일 참가자 토큰 발급 (발송 대상 1인) */
  async issueForParticipant(requestId: string, participantId: string, ttlMs = DEFAULT_TTL_MS): Promise<{ token: string; url: string }> {
    const token = randomBytes(24).toString('base64url');
    const rec: PatientToken = { participantId, requestId, issuedAt: new Date().toISOString(), expiresAt: Date.now() + ttlMs, usedAt: null };
    await this.store.saveMeta(PREFIX + token, rec);
    return { token, url: `/portal/${token}` };
  }

  /** 토큰 검증(만료·사용 여부) → 바인딩 정보 반환 */
  async resolve(token: string): Promise<PatientToken> {
    const t = await this.store.getMeta<PatientToken>(PREFIX + token);
    if (!t) throw new NotFoundException('유효하지 않은 토큰');
    if (t.usedAt) throw new ForbiddenException('이미 사용된 토큰');
    if (Date.now() > t.expiresAt) throw new ForbiddenException('만료된 토큰');
    return t;
  }

  /** 접근암호 통과 표시(일반 전자계약) — 이후 동일 토큰의 열람·서명 허용 */
  async markUnlocked(token: string): Promise<void> {
    const t = await this.store.getMeta<PatientToken>(PREFIX + token);
    if (t) {
      t.unlockedAt = new Date().toISOString();
      await this.store.saveMeta(PREFIX + token, t);
    }
  }

  /** 서명 완료 시 소비(단일사용 보장) */
  async consume(token: string): Promise<void> {
    const t = await this.store.getMeta<PatientToken>(PREFIX + token);
    if (t) {
      t.usedAt = new Date().toISOString();
      await this.store.saveMeta(PREFIX + token, t);
    }
  }
}
