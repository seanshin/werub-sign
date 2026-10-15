// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { SsoVerifierService } from '../infrastructure/auth/sso-verifier.service';
import { SignatureRequestService } from '../application/signature-request.service';
import { StaffSignDto } from './dto';
import { ApiTags } from '@nestjs/swagger';
import { StaffSsoAuth } from './api-auth.decorators';

/**
 * STAFF 서명 진입 — HIS SSO 토큰(JWKS 검증) 경유 — design §19.2 / FR-23.
 * 환자 토큰 모델(§12)과 분리. 원내 PC→sign-core 직접.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('서명 수행')
@Controller('v1/sign')
export class StaffSignController {
  constructor(
    private readonly sso: SsoVerifierService,
    private readonly svc: SignatureRequestService,
  ) {}

  /** 의료진(STAFF) 서명 — HIS SSO Bearer 토큰으로 본인확인을 대체한다(별도 인증서 발급 불요, aud=sign). */
  @Post('staff')
  @StaffSsoAuth()
  async signAsStaff(@Headers('authorization') auth: string | undefined, @Body() dto: StaffSignDto, @Req() req: { staffActor?: string }) {
    if (!auth) throw new UnauthorizedException('Authorization Bearer 필요');
    const claims = await this.sso.verify(auth); // HIS SSO 토큰 JWKS 검증(aud=sign 강제)
    req.staffActor = claims.sub; // 접근 로그 actor 귀속(staff:sub)
    const result = await this.svc.submit(dto.participantId, {
      staff: {
        sub: claims.sub,
        role: claims.role,
        employeeNumber: claims.employeeNumber,
        acr: claims.acr,
        name: claims.name,
      },
    });
    return { data: { ...result, staffSub: claims.sub, role: claims.role, acr: claims.acr } };
  }
}
