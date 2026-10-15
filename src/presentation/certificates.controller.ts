// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { EnrollCertificateService } from '../application/enroll-certificate.service';
import { parsePage, parseSearch } from './pagination';
import { RevocationService } from '../application/revocation.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ProdApiKeyAuth } from './guards/prod-api-key.guard';
import { EnrollDto, RevokeDto } from './dto';
import { ApiTags } from '@nestjs/swagger';
import { PublicApi } from './api-auth.decorators';

/**
 * 인증서 발급·폐기 — FR-18/19 / design §11/§19.1
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('인증서(연동 API)')
@Controller('v1/certificates')
export class CertificatesController {
  constructor(
    private readonly enroll: EnrollCertificateService,
    private readonly revocation: RevocationService,
  ) {}

  /**
   * 인증서 발급(enroll) — 서명 주체(환자·의료진·기관)의 말단 인증서를 Issuing CA 로 발급한다.
   * 본인확인(identity) 결과를 함께 봉인하며, 발급 시리얼(`serialNumber`)이 이후 서명요청 참가자와 연결된다.
   */
  @Post('enroll')
  @UseGuards(ApiKeyGuard)
  @RequireScope('certificates:write')
  async enrollCert(@Body() dto: EnrollDto) {
    return { data: await this.enroll.enroll(dto) };
  }

  /** 발급 인증서 목록 — 소유자 유형·상태 필터, 페이지네이션. 콘솔 인증서 화면·연동 조회용(운영에서는 x-api-key 필요). */
  @Get()
  @ProdApiKeyAuth()
  async list(@Query() q: { limit?: string; offset?: string; q?: string }) {
    const page = parsePage(q);
    const search = parseSearch(q);
    // 저장소가 DB 레벨로 검색·CA 제외·정렬·페이지·카운트(인증서 목록 확장성). { data, page }
    return this.enroll.listPage({ limit: page.limit, offset: page.offset, q: search?.q });
  }

  /** 인증서 목록 CSV 내보내기(심사·보존) — 동일 검색 전체. `:serial` 라우트보다 먼저 정의. */
  @Get('export.csv')
  @ProdApiKeyAuth()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="certificates.csv"')
  async exportCerts(@Query() q: { q?: string }) {
    const search = parseSearch(q);
    return this.enroll.exportCsv({ q: search?.q });
  }

  /** 인증서 폐기(revoke) — 되돌릴 수 없다. 일시 중지가 목적이면 `suspend` 를 쓴다. CRL·OCSP 에 즉시 반영. */
  @Post(':serial/revoke')
  @UseGuards(ApiKeyGuard)
  @RequireScope('certificates:write')
  async revoke(@Param('serial') serial: string, @Body() dto: RevokeDto, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.revocation.revoke(serial, dto.reason, req.consumerApp?.name ?? 'system') };
  }

  /** 인증서 중단(일시정지·가역) */
  @Post(':serial/suspend')
  @UseGuards(ApiKeyGuard)
  @RequireScope('certificates:write')
  async suspend(@Param('serial') serial: string, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.revocation.suspend(serial, req.consumerApp?.name ?? 'system') };
  }

  /** 인증서 중단 해제 */
  @Post(':serial/resume')
  @UseGuards(ApiKeyGuard)
  @RequireScope('certificates:write')
  async resume(@Param('serial') serial: string, @Req() req: { consumerApp?: { name: string } }) {
    return { data: await this.revocation.resume(serial, req.consumerApp?.name ?? 'system') };
  }

  /** 인증서 감사 이력 — 발급·정지·재개·폐기 등 상태 변화의 해시체인 기록. */
  @Get(':serial/audit')
  @PublicApi()
  async certAudit(@Param('serial') serial: string) {
    return { data: await this.enroll.certAudit(serial) };
  }

  /** 실 X.509 인증서(PEM) 조회 — 표준 (공개) */
  @Get(':serial/x509')
  @PublicApi()
  async x509(@Param('serial') serial: string) {
    return { data: await this.enroll.x509(serial) };
  }
}
