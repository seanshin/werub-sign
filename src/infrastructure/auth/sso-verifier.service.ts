// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface StaffClaims {
  sub: string; // user.id (주 식별키)
  acr?: string; // 인증 강도 (step-up 여부)
  amr?: string[];
  licenseNumber?: string;
  employeeNumber?: string; // 사번 (보조 식별키)
  role?: string; // DOCTOR 등
  name?: string;
  signCertSerial?: string; // HIS가 알고 있는 판독의 인증서 serial
}

/**
 * STAFF SSO 신뢰경계 — design §19.2 / FR-23.
 * sign(독립서비스)이 Hospital RUN(HIS)이 발급한 **서명 전용** SSO 토큰을 JWKS로 검증.
 *
 * 신뢰 발급자(iss)=HIS. **audience(aud)=sign 강제** — 뷰어/OHIF용 SSO(aud=ohif/pacs)와
 * 명확히 분리(혼동·오용 방지). 로컬 JWKS(테스트) 또는 원격 JWKS URL 지원.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SsoVerifierService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
  private readonly issuer?: string;
  private readonly audience: string;

  constructor(config: ConfigService) {
    this.issuer = config.get<string>('HIS_SSO_ISSUER');
    this.audience = config.get<string>('HIS_SSO_AUDIENCE') ?? 'sign'; // 서명 토큰 audience
    const localJson = config.get<string>('HIS_SSO_JWKS_JSON'); // 테스트용 인라인 JWKS
    const remoteUrl = config.get<string>('HIS_SSO_JWKS_URL');
    if (localJson) {
      this.jwks = createLocalJWKSet(JSON.parse(localJson));
    } else if (remoteUrl) {
      this.jwks = createRemoteJWKSet(new URL(remoteUrl));
    } else {
      this.jwks = createLocalJWKSet({ keys: [] }); // 미설정 시 항상 실패
    }
  }

  async verify(bearer: string): Promise<StaffClaims> {
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('missing bearer token');
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        ...(this.issuer ? { issuer: this.issuer } : {}),
        audience: this.audience, // aud=sign 아니면 거부 (뷰어 토큰 차단)
      });
      const p = payload as JWTPayload & Record<string, unknown>;
      if (!p.sub) throw new Error('no sub');
      return {
        sub: p.sub,
        acr: p.acr as string | undefined,
        amr: p.amr as string[] | undefined,
        licenseNumber: (p.licenseNumber ?? p.license_number) as string | undefined,
        employeeNumber: (p.employee_number ?? p.employeeNumber) as string | undefined,
        role: p.role as string | undefined,
        name: p.name as string | undefined,
        signCertSerial: (p.sign_cert_serial ?? p.signCertSerial) as string | undefined,
      };
    } catch (e) {
      throw new UnauthorizedException(`SSO 검증 실패: ${(e as Error).message}`);
    }
  }
}
