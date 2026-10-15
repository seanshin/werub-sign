// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Logger } from '@nestjs/common';
import { Notifier, NotifyInput, NotifyResult } from '../../domain/ports/notifier.port';

/**
 * SMTP 이메일 발송 — 일반 전자계약 외부 서명자 안내(EMAIL 채널, design general-contracts §3.3).
 * 원내 메일서버(SMTP) 직결이라 벤더 계약 불요. 자격 = 설정 스토어(notifier.fields.smtpUrl/from) > env(SMTP_URL/SMTP_FROM).
 * nodemailer는 지연 로딩 — SMTP 미사용 배포(mock)에서 모듈 부하 없음.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export class SmtpNotifier implements Notifier {
  private readonly logger = new Logger('SmtpNotifier');

  constructor(
    private readonly smtpUrl?: string,
    private readonly from?: string,
  ) {}

  async send(input: NotifyInput): Promise<NotifyResult> {
    if (!this.smtpUrl || !this.from) {
      this.logger.warn('SMTP 미설정(smtpUrl/from) — 발송 실패 처리');
      return { channel: input.channel, provider: 'SMTP', result: 'FAIL', sentAt: new Date().toISOString() };
    }
    const { createTransport } = await import('nodemailer');
    const transporter = createTransport(this.smtpUrl);
    // templateId=contract-delivery → 체결 완료·문서 교부 안내(그 외 = 서명 요청)
    const delivery = input.templateId === 'contract-delivery';
    try {
      const info = await transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: delivery ? `[전자계약] ${input.title} — 체결 완료·문서 교부` : `[전자계약] ${input.title} — 서명 요청`,
        text: delivery
          ? `"${input.title}" 계약이 체결 완료되었습니다.\n\n아래 링크에서 두 개의 파일을 함께 내려받아 보관해 주세요(기간 한정).\n${input.url}\n\n① 완료 문서(PDF) — 서명이 반영된 계약서 본문입니다. 각 장의 QR 로 진위를 확인할 수 있습니다.\n② 감사추적인증서(PDF) — 문서 해시·서명자·서명 이력을 담은 증거 문서이며, 파일 자체가 전자서명으로 봉인되어 있습니다.\n   (두 파일을 하나로 합치면 ②의 전자서명이 깨지므로 각각 보관하세요.)\n\n본인이 서명한 계약이 아니라면 이 메일을 무시하세요.`
          : `"${input.title}" 문서에 대한 전자서명이 요청되었습니다.\n\n아래 링크에서 문서를 확인하고 서명해 주세요.\n${input.url}\n\n안내받은 접근암호가 있다면 링크 접속 후 입력이 필요합니다.\n본인이 요청받은 것이 아니라면 이 메일을 무시하세요.`,
      });
      return { channel: input.channel, provider: 'SMTP', providerMsgId: info.messageId, result: 'SENT', sentAt: new Date().toISOString() };
    } catch (e) {
      this.logger.warn(`SMTP 발송 실패: ${(e as Error).message}`);
      return { channel: input.channel, provider: 'SMTP', result: 'FAIL', sentAt: new Date().toISOString() };
    } finally {
      transporter.close();
    }
  }
}
