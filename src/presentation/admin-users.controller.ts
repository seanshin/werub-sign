// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminUserService } from '../infrastructure/auth/admin-user.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { CreateAdminUserDto, ResetPasswordDto, UpdateAdminUserDto } from './dto';
import { ApiTags } from '@nestjs/swagger';

type ActorReq = { adminUser?: { username: string }; consumerApp?: { name: string } };
const actorOf = (req: ActorReq): string => (req.adminUser ? `user:${req.adminUser.username}` : req.consumerApp?.name ?? 'system');

/**
 * C-4 RBAC — 관리자 계정 관리. users:admin 전용(admin 역할 또는 sign-admin break-glass 키).
 * 모든 변경은 감사 스트림(admin:users)에 행위자(actor)와 함께 봉인. 마지막 활성 admin 강등/비활성 차단.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('테넌트 운영(콘솔)')
@Controller('v1/admin/users')
@UseGuards(ApiKeyGuard)
@RequireScope('users:admin')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUserService,
    private readonly audit: AuditChainService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /** 콘솔 관리자 계정 목록(RBAC) — 역할·활성 여부. 비밀번호 해시는 반환하지 않는다. */
  @Get()
  @RequireScope('users:admin')
  list() {
    return { data: this.users.list() };
  }

  /** 콘솔 관리자 계정 생성 — 역할(admin·operator·viewer)로 스코프가 결정된다. */
  @Post()
  @RequireScope('users:admin')
  async create(@Body() dto: CreateAdminUserDto, @Req() req: ActorReq) {
    const actor = actorOf(req);
    const user = await this.users.create(dto.username, dto.password, dto.role, actor, dto.email);
    await this.record('USER_CREATED', user.username, actor, { role: user.role });
    return { data: user };
  }

  /** 콘솔 관리자 계정 수정(역할·활성 여부). */
  @Patch(':username')
  @RequireScope('users:admin')
  async update(@Param('username') username: string, @Body() dto: UpdateAdminUserDto, @Req() req: ActorReq) {
    const actor = actorOf(req);
    let user = this.users.getActive(username) ?? undefined;
    if (dto.role) {
      user = await this.users.setRole(username, dto.role, actor);
      await this.record('USER_ROLE_CHANGED', username, actor, { role: dto.role });
    }
    if (dto.status) {
      user = await this.users.setStatus(username, dto.status, actor);
      await this.record(dto.status === 'disabled' ? 'USER_DISABLED' : 'USER_ENABLED', username, actor, {});
    }
    if (dto.email !== undefined) {
      user = await this.users.setEmail(username, dto.email, actor);
      await this.record('USER_EMAIL_CHANGED', username, actor, {});
    }
    return { data: user ?? this.users.list().find((u) => u.username === username) ?? null };
  }

  /** 콘솔 관리자 비밀번호 초기화 — 관리자 감사(`admin:users`)에 봉인. */
  @Post(':username/reset-password')
  @RequireScope('users:admin')
  async resetPassword(@Param('username') username: string, @Body() dto: ResetPasswordDto, @Req() req: ActorReq) {
    const actor = actorOf(req);
    await this.users.resetPassword(username, dto.newPassword);
    await this.record('USER_PASSWORD_RESET', username, actor, {});
    return { data: { ok: true } };
  }

  private async record(eventType: string, target: string, actor: string, extra: object): Promise<void> {
    const key = 'admin:users';
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { target, actor, ...extra }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}
