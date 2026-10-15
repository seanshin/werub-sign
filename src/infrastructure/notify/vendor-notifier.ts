// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Notifier, NotifyInput, NotifyResult } from '../../domain/ports/notifier.port';

/**
 * 실 발송 사업자 어댑터 자리표시(stub) — 설치 시점 자격증명으로 드롭인.
 *  - 카카오 알림톡: 비즈메시지 사업자(예: NHN/카카오 파트너) REST + 사전승인 템플릿.
 *  - SMS: 통신/문자 사업자 REST.
 * 개발(NOTIFIER_PROVIDER=mock)은 미사용. 키 미설정 시 명확한 드롭인 안내 오류.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
abstract class VendorNotifierBase implements Notifier {
  constructor(
    protected readonly apiKey?: string,
    protected readonly endpoint?: string,
    protected readonly senderKey?: string,
  ) {}

  protected abstract name(): string;

  async send(input: NotifyInput): Promise<NotifyResult> {
    if (!this.apiKey || !this.endpoint) {
      throw new Error(
        `Notifier ${this.name()} 자격증명/엔드포인트 미설정 — 사업자 계약 후 NOTIFY_API_KEY·NOTIFY_ENDPOINT 주입(개발은 NOTIFIER_PROVIDER=mock).`,
      );
    }
    // 설치 시 구현: 사업자 REST 호출 → 발송 결과 매핑.
    void input;
    throw new Error(`Notifier ${this.name()} send() 미구현 — 사업자 API 규격으로 연동 필요.`);
  }
}

export class KakaoAlimtalkNotifier extends VendorNotifierBase {
  protected name(): string {
    return 'KAKAO_ALIMTALK';
  }
}

export class SmsNotifier extends VendorNotifierBase {
  protected name(): string {
    return 'SMS';
  }
}
