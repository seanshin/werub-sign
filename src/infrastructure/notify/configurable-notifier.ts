// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Notifier, NotifyInput, NotifyResult } from '../../domain/ports/notifier.port';
import { MockNotifier } from './mock-notifier';
import { SmtpNotifier } from './smtp-notifier';
import { KakaoAlimtalkNotifier, SmsNotifier } from './vendor-notifier';
import { IntegrationSettingsService } from '../../application/integration-settings.service';

/**
 * 설정 기반 발송 어댑터 — 런타임 설정 스토어(settings:notifier)의 provider·자격증명을 매 발송 해석.
 *  - provider=mock(또는 미설정) → MockNotifier(개발·현행)
 *  - provider=kakao|sms → 벤더 어댑터(엔드포인트·API키·senderKey = 설정 스토어 > env). send() 벤더 REST 는 계약 후 구현(현재 stub throw).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class ConfigurableNotifier implements Notifier {
  private mockInstance?: MockNotifier;

  constructor(
    private readonly settings: IntegrationSettingsService,
    private readonly envProvider: string,
  ) {}

  async send(input: NotifyInput): Promise<NotifyResult> {
    const eff = await this.settings.effective('notifier');
    const provider = eff?.provider ?? this.envProvider ?? 'mock';

    // EMAIL 채널(일반 전자계약) — 카카오/SMS provider 설정과 독립적으로 SMTP 라우팅.
    // (알림톡 provider=mock 이어도 SMTP 설정만 있으면 이메일은 실발송, 미설정 시 mock 폴백)
    if (input.channel === 'EMAIL') {
      const smtpUrl = eff?.fields?.smtpUrl ?? process.env.SMTP_URL;
      const from = eff?.fields?.smtpFrom ?? process.env.SMTP_FROM;
      if (smtpUrl && from) return new SmtpNotifier(smtpUrl, from).send(input);
      return this.mock().send(input);
    }

    if (provider === 'mock') return this.mock().send(input);

    const endpoint = eff?.fields?.endpoint ?? process.env.NOTIFY_ENDPOINT;
    const templateId = eff?.fields?.templateId; // 발송 시 input.templateId 우선, 없으면 설정값
    const apiKey = eff?.secrets?.apiKey ?? process.env.NOTIFY_API_KEY;
    const senderKey = eff?.secrets?.senderKey ?? process.env.NOTIFY_SENDER_KEY;
    const payload = { ...input, templateId: input.templateId ?? templateId };
    const impl =
      provider === 'kakao'
        ? new KakaoAlimtalkNotifier(apiKey, endpoint, senderKey)
        : new SmsNotifier(apiKey, endpoint, senderKey);
    return impl.send(payload);
  }

  private mock(): MockNotifier {
    return (this.mockInstance ??= new MockNotifier());
  }
}
