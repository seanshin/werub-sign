// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';
import { AdminRole } from './rbac';
import { resolveSessionPolicy } from './session-policy';

const SESSIONS_META = 'rbac:sessions'; // 활성 세션 영속(SignStore meta)
const PERSIST_THROTTLE_MS = 15_000; // lastSeen 갱신 영속 throttle(쓰기 폭주 방지)

interface SessionRec {
  jti: string;
  sub: string; // username
  role: AdminRole;
  iat: number; // 발급(epoch ms)
  exp: number; // 절대 만료(epoch ms)
  lastSeen: number; // 마지막 활동(epoch ms) — 서버측 idle 강제 기준
  idleMs?: number; // 세션별 idle(사용자 설정, 정책 캡 이내). 미지정 시 전역 정책값.
}

/**
 * 서버측 세션 레지스트리 — 무상태 토큰을 상태형으로 보강(보안 규정 대응).
 *  - F-1: 비활동(idle) 차단을 서버가 강제(클라이언트 JS 의존 제거). 가드가 매 요청 lastSeen 점검.
 *  - F-2: 동일 사용자 동시 세션 수 제한(ISMS-P 2.6.3) — 초과 시 가장 오래된 세션 축출.
 *  - 즉시 폐기(revoke): 로그아웃·비밀번호 변경 시 서버에서 세션 무효화(절대 만료 전이라도).
 *
 * SignStore meta(`rbac:sessions`)에 영속(재기동 보존). 인메모리 Map 권위·동기 점검(가드 경량),
 * lastSeen 갱신은 throttle 영속. EMR 보안성 F004(미사용 접속차단)의 시스템측 강제.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SessionRegistryService implements OnModuleInit {
  private readonly logger = new Logger('SessionRegistry');
  private sessions = new Map<string, SessionRec>();
  private readonly idleMs: number;
  private readonly maxConcurrent: number; // 0 = 무제한
  private lastPersist = 0;
  private dirty = false;

  constructor(config: ConfigService, @Inject(SIGN_STORE) private readonly store: SignStore) {
    // TTL·idle·동시세션은 공통 세션 정책에서 해석(SessionTokenService 와 동일 값 보장).
    const policy = resolveSessionPolicy(config);
    this.idleMs = policy.idleMs;
    this.maxConcurrent = policy.maxConcurrent;
  }

  async onModuleInit(): Promise<void> {
    const persisted = await this.store.getMeta<Record<string, SessionRec>>(SESSIONS_META);
    const now = Date.now();
    if (persisted) {
      for (const [jti, rec] of Object.entries(persisted)) {
        if (rec && rec.exp > now) this.sessions.set(jti, rec); // 만료분은 복원 안 함
      }
    }
    if (this.sessions.size > 0) this.logger.log(`활성 세션 복원: ${this.sessions.size}건`);
  }

  get maxConcurrentSessions(): number {
    return this.maxConcurrent;
  }
  /** 전역 정책 idle(분) — 사용자 설정의 상한 캡. 0=정책상 비활성. */
  get policyIdleMin(): number {
    return Math.round(this.idleMs / 60_000);
  }

  /** 사용자 idle 변경 즉시 반영 — 해당 사용자 활성 세션의 idleMs 갱신(다음 요청부터 새 기준). */
  async setIdleForUser(sub: string, idleMs?: number): Promise<void> {
    let changed = false;
    for (const rec of this.sessions.values()) {
      if (rec.sub === sub) { rec.idleMs = idleMs && idleMs > 0 ? idleMs : undefined; changed = true; }
    }
    if (changed) await this.persist(true);
  }
  get activeCount(): number {
    const now = Date.now();
    return [...this.sessions.values()].filter((r) => this.isActive(r, now)).length;
  }

  /** 로그인 시 세션 등록 — 동시 세션 한도 강제(초과분=오래된 순 축출). */
  async register(jti: string, sub: string, role: AdminRole, iat: number, exp: number, idleMs?: number): Promise<void> {
    const now = Date.now();
    this.prune(now);
    if (this.maxConcurrent > 0) {
      const mine = [...this.sessions.values()]
        .filter((r) => r.sub === sub && this.isActive(r, now))
        .sort((a, b) => a.lastSeen - b.lastSeen); // 오래된 활동 순
      // 새 세션 추가 후 한도를 넘지 않도록 (maxConcurrent-1) 초과분 축출
      while (mine.length >= this.maxConcurrent) {
        const victim = mine.shift();
        if (victim) {
          this.sessions.delete(victim.jti);
          this.logger.log(`동시 세션 한도(${this.maxConcurrent}) 초과 — 축출: ${sub}/${victim.jti.slice(0, 8)}`);
        }
      }
    }
    this.sessions.set(jti, { jti, sub, role, iat, exp, lastSeen: now, idleMs: idleMs && idleMs > 0 ? idleMs : undefined });
    await this.persist(true);
  }

  /**
   * 가드 점검(동기) — 세션 유효 시 lastSeen 갱신 후 rec, 무효 시 사유 반환.
   * reason: 'unknown'(미등록/폐기) | 'expired'(절대 만료) | 'idle'(비활동 차단).
   */
  validate(jti: string | undefined, now: number = Date.now()): { ok: true; rec: SessionRec } | { ok: false; reason: 'unknown' | 'expired' | 'idle' } {
    if (!jti) return { ok: false, reason: 'unknown' };
    const rec = this.sessions.get(jti);
    if (!rec) return { ok: false, reason: 'unknown' };
    if (now >= rec.exp) {
      this.sessions.delete(jti);
      this.schedulePersist(true);
      return { ok: false, reason: 'expired' };
    }
    const eff = rec.idleMs ?? this.idleMs;
    if (eff > 0 && now - rec.lastSeen > eff) {
      this.sessions.delete(jti);
      this.schedulePersist(true);
      return { ok: false, reason: 'idle' };
    }
    rec.lastSeen = now;
    this.schedulePersist(false); // throttle 영속(매 요청 쓰기 방지)
    return { ok: true, rec };
  }

  /** 로그아웃 — 해당 세션 즉시 폐기. */
  async revoke(jti: string | undefined): Promise<void> {
    if (jti && this.sessions.delete(jti)) await this.persist(true);
  }

  /** 사용자 전체 세션 폐기(비밀번호 변경·계정 비활성 시 강제 재로그인). */
  async revokeAllForUser(sub: string): Promise<number> {
    let n = 0;
    for (const [jti, rec] of this.sessions) {
      if (rec.sub === sub) {
        this.sessions.delete(jti);
        n++;
      }
    }
    if (n > 0) await this.persist(true);
    return n;
  }

  // ── 내부 ──
  private isActive(r: SessionRec, now: number): boolean {
    const eff = r.idleMs ?? this.idleMs;
    return r.exp > now && (eff <= 0 || now - r.lastSeen <= eff);
  }
  private prune(now: number): void {
    for (const [jti, rec] of this.sessions) {
      if (!this.isActive(rec, now)) this.sessions.delete(jti);
    }
  }
  /** throttle 영속 — structural=true(등록/폐기)면 throttle 무시하고 즉시. */
  private schedulePersist(structural: boolean): void {
    this.dirty = true;
    const now = Date.now();
    if (structural || now - this.lastPersist >= PERSIST_THROTTLE_MS) {
      void this.persist(false).catch((e) => this.logger.warn(`세션 영속 실패: ${String(e)}`));
    }
  }
  private async persist(_force: boolean): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastPersist = Date.now();
    const map: Record<string, SessionRec> = {};
    for (const [jti, rec] of this.sessions) map[jti] = rec;
    await this.store.saveMeta(SESSIONS_META, map);
  }
}
