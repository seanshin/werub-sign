// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, Body, Controller, Get, Inject, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AdminUserService } from '../infrastructure/auth/admin-user.service';
import { SessionTokenService } from '../infrastructure/auth/session-token.service';
import { SessionRegistryService } from '../infrastructure/auth/session-registry.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard } from './guards/api-key.guard';
import { scopesForRole, AdminRole } from '../infrastructure/auth/rbac';
import { isHardened } from '../infrastructure/security/hardening';
import { ChangePasswordDto, LoginDto, Mfa2faVerifyDto, MfaCodeDto, SelfEmailDto } from './dto';
import { ApiTags } from '@nestjs/swagger';
import { SessionAuth } from './api-auth.decorators';

/**
 * C-4 RBAC — 관리자 인증(콘솔 로그인). 로컬 계정(username/password) → 세션 토큰 발급.
 * 기계 키(HIS/PACS) 인증과 별개 경로. 로그인/실패는 감사 스트림(admin:auth)에 봉인.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('테넌트 운영(콘솔)')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly users: AdminUserService,
    private readonly sessions: SessionTokenService,
    private readonly registry: SessionRegistryService,
    private readonly audit: AuditChainService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /** 로그인 — 1차(ID/PW) 검증. 2FA 활성 계정은 챌린지 반환(세션 미발급), 아니면 세션 발급. */
  @Post('login')
  @SessionAuth()
  async login(@Body() dto: LoginDto, @Req() req: { ip?: string }) {
    const user = await this.users.verifyCredentials(dto.username, dto.password);
    if (!user) {
      await this.record('LOGIN_FAILED', `user:${dto.username}`, { ip: req.ip });
      throw new UnauthorizedException('username 또는 비밀번호가 올바르지 않습니다');
    }
    if (this.users.hasTotp(user.username)) {
      // 2차 인증 필요 — 1차만으로 세션 미발급, 단기 챌린지 토큰 반환
      await this.record('LOGIN_1FA', `user:${user.username}`, { ip: req.ip });
      return { data: { mfaRequired: true, mfaToken: this.sessions.issueMfaChallenge(user.username) } };
    }
    return { data: await this.issueSession(user.username, user.role, req.ip) };
  }

  /** 2차 인증 검증 — 챌린지 토큰 + 인증코드(TOTP 또는 복구코드) → 세션 발급. */
  @Post('2fa/verify')
  @SessionAuth()
  async verify2fa(@Body() dto: Mfa2faVerifyDto, @Req() req: { ip?: string }) {
    const sub = this.sessions.verifyMfaChallenge(dto.mfaToken);
    if (!sub) throw new UnauthorizedException('2차 인증 세션이 만료되었습니다 — 다시 로그인하세요');
    const user = this.users.getActive(sub);
    if (!user) throw new UnauthorizedException('비활성 또는 삭제된 계정');
    if (!(await this.users.verifyTotpCode(sub, dto.code))) {
      await this.record('MFA_FAILED', `user:${sub}`, { ip: req.ip });
      throw new UnauthorizedException('인증 코드가 올바르지 않습니다');
    }
    await this.record('MFA_VERIFIED', `user:${sub}`, { ip: req.ip });
    return { data: await this.issueSession(user.username, user.role, req.ip) };
  }

  /** 세션 발급 + 레지스트리 등록 + 감사 — 1FA(미사용) 또는 2FA 통과 후 공통. */
  private async issueSession(username: string, role: AdminRole, ip?: string) {
    const { token, expiresAt, jti, iat, exp } = this.sessions.issue(username, role);
    const idleMin = this.effectiveIdleMin(username);
    await this.registry.register(jti, username, role, iat, exp, idleMin * 60_000);
    await this.record('LOGIN', `user:${username}`, { role, ip });
    return { token, username, role, scopes: scopesForRole(role), expiresAt, idleTimeoutMin: idleMin };
  }

  /** 개발모드 편의 idle 상한(분) — 실모드는 적용 안 함. */
  private static readonly DEV_IDLE_CAP_MIN = 120; // 2시간

  /**
   * 설정 가능한 idle 상한(분).
   *  - 실모드(하드닝/운영): 정책 상한 엄격(정책>0, 더 길게 불가 — F004).
   *  - 개발모드: 개발 편의로 최대 2시간(정책·DEV 캡 중 큰 값, 단 절대 TTL 이내).
   */
  private idleCapMin(): number {
    const ttl = this.sessions.ttlMinutes;
    const policyMax = this.sessions.idleTimeoutMinutes;
    if (isHardened()) return Math.min(policyMax > 0 ? policyMax : ttl, ttl);
    return Math.min(Math.max(policyMax, AuthController.DEV_IDLE_CAP_MIN), ttl);
  }

  /** 유효 idle(분) — 사용자 선호를 [1, 캡]으로 클램프(정책보다 길게 불가), 선호 없으면 정책값. */
  private effectiveIdleMin(username: string): number {
    const pref = this.users.getIdlePref(username);
    if (pref && pref > 0) return Math.min(Math.max(1, Math.floor(pref)), this.idleCapMin());
    return this.sessions.idleTimeoutMinutes;
  }

  /** 비활동 자동 로그아웃 설정 조회(세션) — 현재값·선호·정책 상한. */
  @Get('idle-timeout')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  idleTimeout(@Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요(기계 키 불가)');
    return {
      data: {
        idleTimeoutMin: this.effectiveIdleMin(req.adminUser.username),
        preference: this.users.getIdlePref(req.adminUser.username) ?? null,
        policyMaxMin: this.sessions.idleTimeoutMinutes, // 0=정책상 비활성(비운영)
        maxMin: this.idleCapMin(), // 설정 가능 상한
        minMin: 1,
        devMode: !isHardened(), // 개발모드 — 정책 초과(2시간 등) 옵션 노출. 실모드 false.
      },
    };
  }

  /** 비활동 자동 로그아웃 설정(세션) — minutes(>0) 저장(정책 캡으로 클램프), null=해제(정책 복귀). 즉시 반영. */
  @Post('idle-timeout')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async setIdleTimeout(@Body('minutes') minutes: number | null, @Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요(기계 키 불가)');
    let pref: number | null;
    if (minutes === null || minutes === undefined) {
      pref = null; // 해제 → 전역 정책 복귀
    } else {
      const m = Math.floor(Number(minutes));
      if (!Number.isFinite(m) || m < 1) throw new BadRequestException('자동 로그아웃 시간은 1분 이상이어야 합니다');
      pref = Math.min(m, this.idleCapMin()); // 정책보다 길게 설정 불가(F004) → 캡으로 클램프
    }
    await this.users.setIdlePref(req.adminUser.username, pref);
    const eff = this.effectiveIdleMin(req.adminUser.username);
    await this.registry.setIdleForUser(req.adminUser.username, eff * 60_000); // 활성 세션 즉시 반영
    await this.record('IDLE_TIMEOUT_CHANGED', `user:${req.adminUser.username}`, { preference: pref, effective: eff });
    return { data: { idleTimeoutMin: eff, preference: pref } };
  }

  /** 2차 인증 상태(세션) */
  @Get('2fa/status')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  status2fa(@Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요');
    return { data: this.users.totpStatus(req.adminUser.username) };
  }

  /** 2차 인증 등록 시작(세션) — 시크릿·등록 URI(QR) 반환. */
  @Post('2fa/setup')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async setup2fa(@Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요');
    return { data: await this.users.setupTotp(req.adminUser.username) };
  }

  /** 2차 인증 활성화(세션) — 코드 확인 → 복구코드 발급(평문 1회). */
  @Post('2fa/enable')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async enable2fa(@Body() dto: MfaCodeDto, @Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요');
    const r = await this.users.enableTotp(req.adminUser.username, dto.code);
    await this.record('MFA_ENABLED', `user:${req.adminUser.username}`, {});
    return { data: r };
  }

  /** 2차 인증 해제(세션) — 본인확인(현재 코드) 후 해제. */
  @Post('2fa/disable')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async disable2fa(@Body() dto: MfaCodeDto, @Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요');
    if (!(await this.users.verifyTotpCode(req.adminUser.username, dto.code))) {
      throw new UnauthorizedException('인증 코드가 올바르지 않습니다');
    }
    await this.users.disableTotp(req.adminUser.username);
    await this.record('MFA_DISABLED', `user:${req.adminUser.username}`, {});
    return { data: { ok: true } };
  }

  /** 현재 주체 정보 — 세션(사람) 또는 기계 키. 콘솔 부팅 시 역할·스코프 확인용. */
  @Get('me')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  me(@Req() req: { adminUser?: { username: string; role: string }; allowedScopes?: string[]; consumerApp?: { name: string; allowedScopes: string[] } }) {
    if (req.adminUser) {
      const email = this.users.getActive(req.adminUser.username)?.email ?? null;
      return { data: { username: req.adminUser.username, role: req.adminUser.role, email, scopes: req.allowedScopes ?? [], consumer: null } };
    }
    return { data: { username: null, role: null, email: null, scopes: req.consumerApp?.allowedScopes ?? [], consumer: req.consumerApp?.name ?? null } };
  }

  /** 본인 알림 이메일 설정/변경(세션 필요) — 계약 내부 서명자 알림 수신용. 빈 값=제거. */
  @Post('email')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async setOwnEmail(@Body() dto: SelfEmailDto, @Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요(기계 키 불가)');
    const v = await this.users.setEmail(req.adminUser.username, dto.email, `user:${req.adminUser.username}`);
    await this.record('USER_EMAIL_CHANGED', `user:${req.adminUser.username}`, {});
    return { data: { email: v.email ?? null } };
  }

  /** 본인 비밀번호 변경(세션 필요) — 변경 시 본인 전체 세션 폐기(강제 재로그인). */
  @Post('password')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: { adminUser?: { username: string } }) {
    if (!req.adminUser) throw new UnauthorizedException('관리자 세션 필요(기계 키 불가)');
    await this.users.changeOwnPassword(req.adminUser.username, dto.currentPassword, dto.newPassword);
    const revoked = await this.registry.revokeAllForUser(req.adminUser.username);
    await this.record('PASSWORD_CHANGED', `user:${req.adminUser.username}`, { sessionsRevoked: revoked });
    return { data: { ok: true } };
  }

  /** 로그아웃 — 서버측 세션을 즉시 폐기(절대 만료 전이라도 무효). 감사 봉인. */
  @Post('logout')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async logout(@Req() req: { adminUser?: { username: string }; sessionId?: string }) {
    if (req.adminUser) {
      await this.registry.revoke(req.sessionId);
      await this.record('LOGOUT', `user:${req.adminUser.username}`, {});
    }
    return { data: { ok: true } };
  }

  private async record(eventType: string, actor: string, extra: object): Promise<void> {
    const key = 'admin:auth';
    // 기관 전역 단일 스트림(로그인·MFA) — 동시 로그인이 몰리면 분기 위험이 가장 큰 축(R16)
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { actor, ...extra }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}
