// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 관리자 계정 저장소(C-4 다중관리자 RBAC) — 콘솔 로그인 계정의 생성·검증·역할·2FA(TOTP)를 담당.
 * 기계 소비자 키(ConsumerAppService)와는 **별개 축**이다: 이쪽은 사람, 저쪽은 시스템.
 *
 * 보안 취급:
 *  - 비밀번호: scrypt(salt 별도) + timingSafeEqual 비교 — 해시 유출 시에도 대량 역산이 비싸고,
 *    비교 시간으로 일치 여부가 새지 않는다.
 *  - TOTP 시크릿: SecretBox 봉인 저장(평문 DB 금지). 활성화 전에는 프로비저닝 상태로만 존재.
 *  - 부팅 시 env(SIGN_ADMIN_USER/PASSWORD)의 루트 계정을 upsert — 계정 전멸로 콘솔이 잠기는
 *    사고를 막는 복구 경로(비밀번호는 env 값으로 재설정됨을 의미하니 env 관리에 주의).
 * 계정 변경(생성·역할·비활성)은 admin:users 감사 스트림에 봉인된다(admin-users.controller).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';
import { AdminRole, isAdminRole } from './rbac';
import { SecretBox, SealedSecret } from '../crypto/secret-box';
import { generateTotpSecret, verifyTotp, otpauthUri } from './totp';

const USERS_META = 'rbac:users'; // 관리자 계정 영속(SignStore meta)

type UserStatus = 'active' | 'disabled';

interface StoredAdminUser {
  username: string;
  email?: string; // 내부 계정 이메일 — 계약 내부 서명자 알림·식별용(로그인 ID 아님)
  salt: string; // hex
  hash: string; // scrypt hex
  role: AdminRole;
  status: UserStatus;
  createdAt: string;
  createdBy: string;
  lastLoginAt?: string;
  // 2차 인증(TOTP) — 시크릿은 AES-256-GCM 봉인, 복구코드는 sha256 해시.
  totp?: { secret: SealedSecret; enabledAt: string };
  totpPending?: SealedSecret; // 등록 시작·미활성(코드 확인 전)
  recovery?: string[]; // 복구코드 sha256 hex(1회용)
  idleTimeoutMin?: number; // 사용자별 비활동 자동 로그아웃(분) — 정책 캡 이내. 미설정 시 전역 정책.
}

/** 콘솔/감사 노출용(비밀 제외) */
export interface AdminUserView {
  username: string;
  email?: string;
  role: AdminRole;
  status: UserStatus;
  createdAt: string;
  createdBy: string;
  lastLoginAt?: string;
}

/**
 * C-4 다중관리자 RBAC — 로컬 관리자 계정 레지스트리.
 * username/password(scrypt 해시·솔트) 를 SignStore meta(`rbac:users`)에 영속. 개인별 식별·역할 기반
 * 인가·감사 actor 귀속(=`user:<username>`)의 근거. 기계 키(HIS/PACS/console)와 독립.
 *
 * 부트스트랩: 계정이 0개이고 SIGN_ADMIN_PASSWORD 설정 시 최초 admin(SIGN_ADMIN_USER, 기본 admin) 생성.
 * 미설정 시 생성하지 않음(알려진 비밀번호 자동계정 금지) — break-glass=SIGN_ADMIN_API_KEY(users:admin) 로
 * 최초 사용자 생성 가능.
 */
@Injectable()
export class AdminUserService implements OnModuleInit {
  private readonly logger = new Logger('AdminUser');
  private users = new Map<string, StoredAdminUser>();
  private readonly box = new SecretBox(process.env.CRYPTO_MASTER_KEY);

  constructor(private readonly config: ConfigService, @Inject(SIGN_STORE) private readonly store: SignStore) {}

  async onModuleInit(): Promise<void> {
    const persisted = await this.store.getMeta<Record<string, StoredAdminUser>>(USERS_META);
    if (persisted) {
      for (const [k, v] of Object.entries(persisted)) this.users.set(k, v);
    }
    if (this.users.size > 0) {
      this.logger.log(`관리자 계정 복원: ${this.users.size}명`);
      return;
    }
    const pw = this.config.get<string>('SIGN_ADMIN_PASSWORD');
    const user = this.config.get<string>('SIGN_ADMIN_USER') || 'admin';
    if (pw) {
      await this.create(user, pw, 'admin', 'bootstrap');
      this.logger.log(`최초 admin 계정 부트스트랩: ${user}`);
    } else {
      this.logger.warn('관리자 계정 미부트스트랩 — SIGN_ADMIN_PASSWORD 설정 또는 SIGN_ADMIN_API_KEY(users:admin)로 생성하세요.');
    }
  }

  // ── 인증 ──────────────────────────────────────────────────────────────
  /** 자격증명 검증. 성공 시 사용자 반환·lastLoginAt 갱신, 실패 시 null. */
  async verifyCredentials(username: string, password: string): Promise<AdminUserView | null> {
    const u = this.users.get(username);
    if (!u || u.status !== 'active') return null;
    if (!this.passwordMatches(password, u)) return null;
    u.lastLoginAt = new Date().toISOString();
    await this.persist();
    return this.view(u);
  }

  /** 토큰 검증 후 현재 사용자 상태 조회(역할·비활성 반영). 없거나 비활성이면 null. */
  getActive(username: string): AdminUserView | null {
    const u = this.users.get(username);
    return u && u.status === 'active' ? this.view(u) : null;
  }

  // ── 관리(users:admin) ─────────────────────────────────────────────────
  list(): AdminUserView[] {
    return [...this.users.values()].map((u) => this.view(u)).sort((a, b) => a.username.localeCompare(b.username));
  }

  async create(username: string, password: string, role: AdminRole, createdBy: string, email?: string): Promise<AdminUserView> {
    const name = (username || '').trim();
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(name)) throw new BadRequestException('username 형식 오류(영숫자.-_ 3~40자)');
    if (!isAdminRole(role)) throw new BadRequestException('role 은 admin|operator|viewer');
    if (this.users.has(name)) throw new ConflictException('이미 존재하는 username');
    this.assertPasswordStrength(password);
    const salt = randomBytes(16).toString('hex');
    const u: StoredAdminUser = {
      username: name,
      email: this.normEmail(email),
      salt,
      hash: this.hash(password, salt),
      role,
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy,
    };
    this.users.set(name, u);
    await this.persist();
    return this.view(u);
  }

  /** 내부 계정 이메일 설정/변경 — 계약 내부 서명자 알림·식별용(로그인 ID 아님). */
  async setEmail(username: string, email: string | undefined, actor: string): Promise<AdminUserView> {
    const u = this.require(username);
    u.email = this.normEmail(email);
    await this.persist();
    this.logger.log(`이메일 변경: ${username} (by ${actor})`);
    return this.view(u);
  }

  private normEmail(email?: string): string | undefined {
    const v = (email ?? '').trim().toLowerCase();
    if (!v) return undefined;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new BadRequestException('이메일 형식 오류');
    return v;
  }

  async setRole(username: string, role: AdminRole, actor: string): Promise<AdminUserView> {
    if (!isAdminRole(role)) throw new BadRequestException('role 은 admin|operator|viewer');
    const u = this.require(username);
    if (u.role === 'admin' && role !== 'admin') this.assertNotLastAdmin(username);
    u.role = role;
    await this.persist();
    this.logger.log(`역할 변경: ${username} → ${role} (by ${actor})`);
    return this.view(u);
  }

  async setStatus(username: string, status: UserStatus, actor: string): Promise<AdminUserView> {
    if (status !== 'active' && status !== 'disabled') throw new BadRequestException('status 는 active|disabled');
    const u = this.require(username);
    if (status === 'disabled' && u.role === 'admin') this.assertNotLastAdmin(username);
    u.status = status;
    await this.persist();
    this.logger.log(`상태 변경: ${username} → ${status} (by ${actor})`);
    return this.view(u);
  }

  async resetPassword(username: string, newPassword: string): Promise<void> {
    const u = this.require(username);
    this.assertPasswordStrength(newPassword);
    u.salt = randomBytes(16).toString('hex');
    u.hash = this.hash(newPassword, u.salt);
    await this.persist();
  }

  /** 본인 비밀번호 변경 — 현재 비밀번호 확인. */
  async changeOwnPassword(username: string, current: string, next: string): Promise<void> {
    const u = this.require(username);
    if (!this.passwordMatches(current, u)) throw new BadRequestException('현재 비밀번호 불일치');
    this.assertPasswordStrength(next);
    u.salt = randomBytes(16).toString('hex');
    u.hash = this.hash(next, u.salt);
    await this.persist();
  }

  count(): number {
    return this.users.size;
  }

  // ── 비활동 자동 로그아웃(사용자 설정) ──────────────────────────────────
  /** 사용자별 idle 선호(분). 미설정 시 undefined(전역 정책 사용). */
  getIdlePref(username: string): number | undefined {
    return this.users.get(username)?.idleTimeoutMin;
  }
  /** idle 선호 설정 — minutes>0 저장, 0/null 이면 해제(전역 정책 복귀). 정합성 캡은 호출부. */
  async setIdlePref(username: string, minutes: number | null): Promise<void> {
    const u = this.require(username);
    if (minutes === null || minutes <= 0) delete u.idleTimeoutMin;
    else u.idleTimeoutMin = Math.floor(minutes);
    await this.persist();
  }

  // ── 2차 인증(TOTP) ─────────────────────────────────────────────────────
  hasTotp(username: string): boolean {
    return !!this.users.get(username)?.totp;
  }
  totpStatus(username: string): { enabled: boolean } {
    return { enabled: this.hasTotp(username) };
  }

  /** 등록 시작 — 시크릿 생성(미활성, 봉인 보관). 평문 시크릿·등록 URI 반환(QR용). */
  async setupTotp(username: string): Promise<{ secret: string; otpauthUri: string }> {
    const u = this.require(username);
    const secret = generateTotpSecret();
    u.totpPending = this.box.seal(secret);
    await this.persist();
    // 로고 URL(비표준 image 파라미터) — MFA_LOGO_URL 또는 PUBLIC_BASE_URL 기반(지원 앱만 표시)
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    const logo = this.config.get<string>('MFA_LOGO_URL') || (base ? `${base}/mfa-logo.png` : undefined);
    return { secret, otpauthUri: otpauthUri(secret, username, undefined, logo) };
  }

  /** 활성화 — 등록 중 시크릿으로 코드 검증 성공 시 enable + 복구코드 발급(평문 1회 반환). */
  async enableTotp(username: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const u = this.require(username);
    if (!u.totpPending) throw new BadRequestException('2차 인증 등록을 먼저 시작하세요(setup)');
    const secret = this.box.open(u.totpPending);
    if (!verifyTotp(secret, code)) throw new BadRequestException('인증 코드가 올바르지 않습니다');
    u.totp = { secret: u.totpPending, enabledAt: new Date().toISOString() };
    delete u.totpPending;
    const codes = Array.from({ length: 8 }, () => `${randomBytes(5).toString('hex')}`.replace(/(.{5})(.{5})/, '$1-$2'));
    u.recovery = codes.map((c) => this.hashRecovery(c));
    await this.persist();
    return { recoveryCodes: codes };
  }

  /** 비활성화 — 호출부에서 본인확인(TOTP 코드 또는 비밀번호) 선행 필수. */
  async disableTotp(username: string): Promise<void> {
    const u = this.require(username);
    delete u.totp;
    delete u.totpPending;
    delete u.recovery;
    await this.persist();
  }

  /** 로그인 2차 검증 — TOTP 코드 또는 복구코드(1회용·소모). */
  async verifyTotpCode(username: string, code: string): Promise<boolean> {
    const u = this.users.get(username);
    if (!u?.totp) return false;
    const secret = this.box.open(u.totp.secret);
    if (verifyTotp(secret, code)) return true;
    // 복구코드 경로(1회용)
    const h = this.hashRecovery(code);
    const idx = (u.recovery ?? []).indexOf(h);
    if (idx >= 0) {
      u.recovery!.splice(idx, 1);
      await this.persist();
      return true;
    }
    return false;
  }

  private hashRecovery(code: string): string {
    return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
  }

  // ── 내부 ──────────────────────────────────────────────────────────────
  private require(username: string): StoredAdminUser {
    const u = this.users.get(username);
    if (!u) throw new NotFoundException(`사용자 없음: ${username}`);
    return u;
  }
  private assertNotLastAdmin(username: string): void {
    const activeAdmins = [...this.users.values()].filter((x) => x.role === 'admin' && x.status === 'active');
    if (activeAdmins.length <= 1 && activeAdmins[0]?.username === username) {
      throw new ConflictException('마지막 활성 admin 은 강등/비활성화할 수 없습니다');
    }
  }
  private assertPasswordStrength(pw: string): void {
    if (!pw || pw.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다');
  }
  private passwordMatches(password: string, u: StoredAdminUser): boolean {
    const got = Buffer.from(this.hash(password, u.salt), 'hex');
    const exp = Buffer.from(u.hash, 'hex');
    return got.length === exp.length && timingSafeEqual(got, exp);
  }
  private hash(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString('hex');
  }
  private view(u: StoredAdminUser): AdminUserView {
    return { username: u.username, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt, createdBy: u.createdBy, lastLoginAt: u.lastLoginAt };
  }
  private async persist(): Promise<void> {
    const map: Record<string, StoredAdminUser> = {};
    for (const [k, v] of this.users) map[k] = v;
    await this.store.saveMeta(USERS_META, map);
  }
}
