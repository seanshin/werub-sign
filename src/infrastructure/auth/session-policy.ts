// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { isHardened } from '../security/hardening';

/**
 * 콘솔 세션 정책 — TTL·비활동(idle)·동시세션 한도를 단일 출처로 해석.
 * SessionTokenService 와 SessionRegistryService 가 같은 값을 보도록 공통화(과거 계산 불일치 방지).
 *
 * 보안 규정 반영:
 *  - 기본 idle 15분(민감정보 위험도 고려) · 절대 TTL 기본 8h(480분).
 *  - 운영(하드닝/production)에서는 idle 비활성(0) 금지 — 하한(IDLE_FLOOR_MIN)으로 강제(EMR F004).
 *  - idle 은 TTL 을 초과할 수 없음(상한 캡).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const IDLE_FLOOR_MIN = 15; // 운영 하한 — idle 비활성을 막는 최소값(F004 미사용 접속차단)
const DEFAULT_IDLE_MIN = 15;
const DEFAULT_TTL_MIN = 480; // 8h
const DEFAULT_MAX_CONCURRENT = 3;

export interface SessionPolicy {
  ttlMin: number;
  idleMin: number; // 유효 idle(분), 0 = 비활성(비운영 한정)
  idleMs: number;
  maxConcurrent: number; // 0 = 무제한
}

const logger = new Logger('SessionPolicy');

export function resolveSessionPolicy(config: ConfigService): SessionPolicy {
  const ttlMin = Math.max(1, Number(config.get<string>('SESSION_TTL_MIN') ?? DEFAULT_TTL_MIN));
  const rawIdle = Number(config.get<string>('SESSION_IDLE_TIMEOUT_MIN') ?? DEFAULT_IDLE_MIN);
  let idleMin = rawIdle > 0 ? Math.min(rawIdle, ttlMin) : 0;
  if (idleMin <= 0 && isHardened()) {
    idleMin = Math.min(IDLE_FLOOR_MIN, ttlMin); // 운영에서 비활성 금지 → 하한 강제
    logger.warn(`SESSION_IDLE_TIMEOUT_MIN=0(비활성)은 운영 모드에서 허용되지 않음 — ${idleMin}분으로 강제(EMR F004)`);
  }
  const maxConcurrent = Math.max(0, Math.floor(Number(config.get<string>('SESSION_MAX_CONCURRENT') ?? DEFAULT_MAX_CONCURRENT)));
  return { ttlMin, idleMin, idleMs: idleMin * 60_000, maxConcurrent };
}
