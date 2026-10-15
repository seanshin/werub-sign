// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * Notifier 포트 — 환자 발송(원외 비대면 안내). FR-10 / design DMZ.
 * mock(개발) ↔ 카카오 알림톡/SMS 사업자(운영) 교체축. 발송은 DMZ에서 수행.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const NOTIFIER = Symbol('NOTIFIER');

export type NotifyChannel = 'ALIMTALK' | 'SMS' | 'EMAIL';

export interface NotifyInput {
  channel: NotifyChannel;
  to: string; // 수신 번호(평문 저장 금지 — 로그 마스킹)
  title: string;
  url: string; // 서명 포털 링크
  templateId?: string;
}

export interface NotifyResult {
  channel: NotifyChannel;
  provider: string;
  providerMsgId?: string;
  result: 'SENT' | 'FAIL';
  sentAt: string;
}

export interface Notifier {
  send(input: NotifyInput): Promise<NotifyResult>;
}
