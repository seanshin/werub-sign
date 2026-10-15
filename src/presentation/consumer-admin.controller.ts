// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConsumerAppService } from '../infrastructure/auth/consumer-app.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { RotateKeyDto, CommitKeyDto, CreateConsumerDto, UpdateConsumerDto } from './dto';
import { ApiTags } from '@nestjs/swagger';

/**
 * Consumer API Key 무중단 회전 — ca:admin 전용(sign-admin 키). P8 시크릿 회전 운영.
 * 흐름: rotate(신규키 추가·구키 grace 유지) → 소비자(HIS/PACS) 신규키 전환 → commit(구키 폐기).
 * ⚠️ in-memory 회전 — 재기동 시 env(.env.prod)로 복귀. 영구화하려면 회전 후 .env.prod 키도 갱신.
 * 행위자(actor)는 감사체인에 봉인(키 값은 미기록).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('테넌트 운영(콘솔)')
@Controller('v1/admin/consumers')
export class ConsumerAdminController {
  constructor(
    private readonly consumers: ConsumerAppService,
    private readonly audit: AuditChainService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /** 소비자 목록(키 값 제외) — 콘솔 회전·등록 UI. ca:admin. */
  @Get()
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async list() {
    return { data: this.consumers.list() };
  }

  /** UI 부여 가능 스코프 목록(민감 스코프 제외). */
  @Get('assignable-scopes')
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async assignableScopes() {
    return { data: this.consumers.assignableScopes() };
  }

  /** 소비자 등록(UI) — 키 서버 생성·1회 반환. 민감 스코프 부여 차단(서비스 검증). */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async create(@Body() dto: CreateConsumerDto, @Req() req: { consumerApp?: { name: string }; adminUser?: { username: string } }) {
    const created = await this.consumers.createConsumer(dto.name, dto.scopes);
    await this.recordAudit('CONSUMER_CREATED', created.name, this.actorOf(req), { scopes: created.scopes });
    return { data: created }; // apiKey 1회 반환(캡처 필수)
  }

  /** 소비자 수정(UI) — 스코프 편집·상태(일시중지/재개). 동적 소비자만. */
  @Patch(':name')
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async update(@Param('name') name: string, @Body() dto: UpdateConsumerDto, @Req() req: { consumerApp?: { name: string }; adminUser?: { username: string } }) {
    const actor = this.actorOf(req);
    let app;
    if (dto.scopes) { app = await this.consumers.setScopes(name, dto.scopes); await this.recordAudit('CONSUMER_SCOPES_CHANGED', name, actor, { scopes: app.allowedScopes }); }
    if (dto.status) { app = await this.consumers.setStatus(name, dto.status); await this.recordAudit(dto.status === 'SUSPENDED' ? 'CONSUMER_SUSPENDED' : 'CONSUMER_REACTIVATED', name, actor, {}); }
    return { data: { name, scopes: app?.allowedScopes, status: app?.status } };
  }

  /** 신규 키 추가(grace) — 구키와 신규키 모두 허용되는 윈도우 시작 */
  @Post(':name/rotate')
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async rotate(@Param('name') name: string, @Body() dto: RotateKeyDto, @Req() req: { consumerApp?: { name: string } }) {
    const generated = !dto.newApiKey;
    const newApiKey = dto.newApiKey ?? `sk_${randomBytes(24).toString('base64url')}`;
    const app = await this.consumers.rotateKey(name, newApiKey);
    await this.recordAudit('CONSUMER_KEY_ROTATED', name, req.consumerApp?.name ?? 'system', { activeKeys: app.apiKeyHashes.size });
    return {
      data: {
        name,
        activeKeys: app.apiKeyHashes.size, // 보통 2(구+신) — grace 윈도우
        generated,
        newApiKey: generated ? newApiKey : undefined, // 생성한 경우만 1회 반환(캡처 필수)
        note: '소비자 신규키 전환 후 commit 호출. 영구화하려면 .env.prod 키도 갱신(재기동 대비).',
      },
    };
  }

  /** 회전 완료 — 지정 키만 남기고 구키 폐기 */
  @Post(':name/commit')
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async commit(@Param('name') name: string, @Body() dto: CommitKeyDto, @Req() req: { consumerApp?: { name: string } }) {
    const app = await this.consumers.retireOldKeys(name, dto.keepApiKey);
    await this.recordAudit('CONSUMER_KEY_COMMITTED', name, req.consumerApp?.name ?? 'system', { activeKeys: app.apiKeyHashes.size });
    return { data: { name, activeKeys: app.apiKeyHashes.size } };
  }

  private actorOf(req: { consumerApp?: { name: string }; adminUser?: { username: string } }): string {
    return req.adminUser ? `user:${req.adminUser.username}` : req.consumerApp?.name ?? 'system';
  }

  private async recordAudit(eventType: string, target: string, actor: string, extra: object): Promise<void> {
    const key = 'consumer:admin';
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { target, actor, ...extra }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}
