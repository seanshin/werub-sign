// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Logger } from '@nestjs/common';
import { IdentityProvider, IdentityResult, IdentityVerifyInput } from '../../domain/ports/identity-provider.port';
import { MockIdentityProvider } from './mock-identity-provider';
import { PassIdentityProvider, MobileNameIdentityProvider } from './vendor-identity-provider';
import { IntegrationSettingsService } from '../../application/integration-settings.service';

/**
 * 설정 기반 본인확인 어댑터 — 런타임 설정 스토어(settings:idv)의 provider·자격증명을 매 요청 해석.
 *  - provider=mock(또는 미설정) → MockIdentityProvider(개발·현행)
 *  - provider=pass|mobile-name → 벤더 어댑터(엔드포인트·API키 = 설정 스토어 > env). verify() 벤더 REST 는 계약 후 구현(현재 stub throw).
 * 시크릿은 설정 스토어에 봉인 보관 → UI 입력만으로 무재배포 전환(프록시 형태 유지).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class ConfigurableIdentityProvider implements IdentityProvider {
  private readonly log = new Logger('IDV');
  private mockInstance?: MockIdentityProvider;

  constructor(
    private readonly settings: IntegrationSettingsService,
    private readonly pepper: string,
    private readonly envProvider: string,
  ) {}

  async verify(input: IdentityVerifyInput): Promise<IdentityResult> {
    const eff = await this.settings.effective('idv');
    const provider = eff?.provider ?? this.envProvider ?? 'mock';
    if (provider === 'mock') return this.mock().verify(input);

    const endpoint = eff?.fields?.endpoint ?? process.env.IDV_ENDPOINT;
    const apiKey = eff?.secrets?.apiKey ?? process.env.IDV_API_KEY;
    const impl =
      provider === 'pass'
        ? new PassIdentityProvider(this.pepper, apiKey, endpoint)
        : new MobileNameIdentityProvider(this.pepper, apiKey, endpoint);
    return impl.verify(input);
  }

  private mock(): MockIdentityProvider {
    return (this.mockInstance ??= new MockIdentityProvider(this.pepper));
  }
}
