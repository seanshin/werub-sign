// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SignRequestFacadeService } from '../application/sign-request-facade.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { SignRequestFacadeDto } from './dto';
import { ApiTags } from '@nestjs/swagger';

/**
 * HIS-친화 제출 facade — 단일 호출로 (필요 시 환자 인증서 발급 +) 서명요청 생성 + (PORTAL) 토큰.
 * 내부 /v1/requests + portal-tokens를 묶음. HIS submitSignRequest 계약 대응.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('서명요청(연동 API)')
@Controller('v1/sign-requests')
export class SignRequestsController {
  constructor(private readonly facade: SignRequestFacadeService) {}

  /** 간편 서명요청 생성(레거시 호환 경로) — 신규 연동은 `POST /v1/requests` 를 사용한다. */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  async create(@Body() dto: SignRequestFacadeDto, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.facade.submit({ ...dto, createdBy: req.consumerApp?.name }) };
  }
}
