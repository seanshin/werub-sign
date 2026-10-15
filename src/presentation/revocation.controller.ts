// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Param } from '@nestjs/common';
import { RevocationService } from '../application/revocation.service';
import { ApiTags } from '@nestjs/swagger';
import { PublicApi } from './api-auth.decorators';

/**
 * OCSP/CRL 폐기 조회 — design §11 / FR-19
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('공개 검증(무인증)')
@Controller('v1')
export class RevocationController {
  constructor(private readonly revocation: RevocationService) {}

  /** OCSP 유사 조회(무인증) — 시리얼 단위 폐기 여부 즉시 확인. */
  @Get('ocsp/:serial')
  @PublicApi()
  async ocsp(@Param('serial') serial: string) {
    return { data: await this.revocation.ocsp(serial) };
  }

  /** CRL(인증서폐기목록, 무인증) — 폐기 시리얼 전체 목록. 검증 측 캐시 대상. */
  @Get('crl')
  @PublicApi()
  async crl() {
    return { data: await this.revocation.crl() };
  }
}
