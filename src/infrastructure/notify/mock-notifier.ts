// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Logger } from '@nestjs/common';
import { Notifier, NotifyInput, NotifyResult } from '../../domain/ports/notifier.port';

/**
 * Mock 발송 — 개발/PoC. 실제 전송 없이 SENT 반환(번호는 마스킹 로그).
 * 운영은 카카오 알림톡/SMS 사업자 어댑터로 교체(Notifier 포트).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class MockNotifier implements Notifier {
  private readonly logger = new Logger('MockNotifier');

  async send(input: NotifyInput): Promise<NotifyResult> {
    this.logger.log(`[MOCK ${input.channel}] → ${this.mask(input.to)} : ${input.title} ${input.url}`);
    return { channel: input.channel, provider: 'MOCK-NOTIFY', providerMsgId: `mock-${Date.now()}`, result: 'SENT', sentAt: new Date().toISOString() };
  }

  private mask(to: string): string {
    return to.length <= 4 ? '****' : to.slice(0, 3) + '****' + to.slice(-2);
  }
}
