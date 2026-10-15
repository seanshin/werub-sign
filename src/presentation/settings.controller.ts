// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { IntegrationSettingsService } from '../application/integration-settings.service';
import { UpdateSettingsDto } from './dto';
import { ApiTags } from '@nestjs/swagger';

/**
 * 연동 설정(런타임) — 본인확인(IDV)·발송(Notifier)·키수탁(HSM/KMS) provider·자격증명 관리.
 * settings:write 스코프(콘솔·sign-admin). 시크릿은 마스킹 반환(평문 미노출), 변경 감사.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('테넌트 운영(콘솔)')
@Controller('v1/admin/settings')
@UseGuards(ApiKeyGuard)
@RequireScope('settings:write')
export class SettingsController {
  constructor(private readonly settings: IntegrationSettingsService) {}

  /** 연동 설정 전체 조회(본인인증·발송·키수탁 provider) — 비밀값 제외. */
  @Get()
  @RequireScope('settings:write')
  async all() {
    return { data: await this.settings.all() };
  }

  /** 연동 설정 단건 조회(type=idv|notifier|hsm). */
  @Get(':type')
  @RequireScope('settings:write')
  async get(@Param('type') type: string) {
    return { data: await this.settings.masked(type) };
  }

  /** 연동 설정 변경 — 변경 전후를 감사에 봉인한다. 적용 시점은 설정 유형별로 다르다(HSM 은 cutover). */
  @Put(':type')
  @RequireScope('settings:write')
  async update(@Param('type') type: string, @Body() dto: UpdateSettingsDto, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.settings.update(type, dto, req.consumerApp?.name ?? 'console') };
  }

  /** 연동 설정 변경 이력. */
  @Get(':type/audit')
  @RequireScope('settings:write')
  async audit(@Param('type') type: string) {
    return { data: await this.settings.auditTrail(type) };
  }
}
