// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { CaService } from '../infrastructure/pki/ca.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ApiTags } from '@nestjs/swagger';
import { SessionAuth } from './api-auth.decorators';

/**
 * CA 운영(admin) — Issuing CA 키 회전 + 이력 조회. 트러스트 앵커 작업이라 ca:admin 스코프 분리.
 * 회전 후에도 구 Issuing으로 발급된 기존 인증서는 이력으로 계속 검증된다(design §13).
 * 회전은 관리 행위자(actor)를 감사체인에 봉인(책임추적).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('CA 운영(콘솔)')
@Controller('v1/ca')
export class CaAdminController {
  constructor(
    private readonly ca: CaService,
    private readonly audit: AuditChainService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /** Issuing CA 키 회전 — 새 발급 CA 로 교체. 기존 인증서는 그대로 유효하며 신규 발급분만 새 CA 로 서명된다. */
  @Post('rotate-issuing')
  @UseGuards(ApiKeyGuard)
  @RequireScope('ca:admin')
  async rotateIssuing(@Req() req: { consumerApp?: { name: string } }) {
    const cert = await this.ca.rotateIssuing();
    const actor = req.consumerApp?.name ?? 'system';
    const key = 'ca:admin';
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, 'CA_ROTATED', { issuingSerial: cert.tbs.serialNumber, actor }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
    return { data: { issuingSerial: cert.tbs.serialNumber, notAfter: cert.tbs.notAfter, actor } };
  }

  /** CA 회전 이력 — 구 Issuing 포함(검증·감사용). 읽기는 유효 키면 허용(콘솔 조회), 회전(쓰기)만 ca:admin */
  @Get('history')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async history() {
    return { data: this.ca.issuingHistorySummary() };
  }

  /** CA 관리 감사 이벤트 — CA_ROTATED(행위자·시각). 책임추적. 읽기 전용(유효 키) */
  @Get('audit')
  @SessionAuth()
  @UseGuards(ApiKeyGuard)
  async caAudit() {
    return { data: await this.store.auditEntries('ca:admin') };
  }
}
