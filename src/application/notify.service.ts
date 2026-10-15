// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 발송 유스케이스 — 서명요청 링크(포털 토큰)를 채널(알림톡/SMS/이메일 — Notifier 포트)로 보내고
 * 이력을 남긴다. 콘솔 "발송 이력" 화면의 데이터 원천.
 *
 * 원칙: 수신처(전화·이메일)는 **마스킹해서만 저장**한다(maskTo — 평문 저장 금지, conventions §3).
 * 발송 실패는 요청 상태를 바꾸지 않는다 — 링크 재발송은 언제든 가능하고, 서명 진행과 발송은 독립.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PatientTokenService } from './patient-token.service';
import { NOTIFIER, Notifier, NotifyChannel } from '../domain/ports/notifier.port';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { toCsv } from '../domain/csv';

/** 수신번호 마스킹 — 평문 저장 금지(끝 4자리만 노출). */
function maskTo(to: string): string {
  const s = (to ?? '').replace(/\s/g, '');
  if (s.length <= 4) return '****';
  return '*'.repeat(Math.max(3, s.length - 4)) + s.slice(-4);
}

export interface NotifyRecipient {
  participantId: string;
  to: string;
  channel?: NotifyChannel;
}

/**
 * 발송 오케스트레이션 — 참가자별 서명 포털 토큰 발급 + Notifier로 링크 전송(FR-10).
 * 원외 비대면 동의 안내. 수신 연락처는 HIS가 제공(sign 비저장), 발송은 DMZ Notifier.
 */
@Injectable()
export class NotifyService {
  constructor(
    private readonly tokens: PatientTokenService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  async notifyRequest(requestId: string, baseUrl: string, recipients: NotifyRecipient[]) {
    const req = await this.store.getRequest(requestId);
    if (!req) throw new NotFoundException('request not found');
    const out = [];
    for (const r of recipients) {
      const p = req.participants.find((x) => x.participantId === r.participantId);
      if (!p || p.status === 'SIGNED') {
        const reason = !p ? 'unknown' : 'already-signed';
        await this.record(requestId, r.participantId, r.channel ?? 'ALIMTALK', 'mock', 'SKIP', r.to, req.title, undefined, reason);
        out.push({ participantId: r.participantId, result: 'SKIP', reason });
        continue;
      }
      const { url } = await this.tokens.issueForParticipant(requestId, r.participantId);
      const link = baseUrl.replace(/\/$/, '') + url;
      const res = await this.notifier.send({ channel: r.channel ?? 'ALIMTALK', to: r.to, title: req.title, url: link });
      await this.record(requestId, r.participantId, res.channel, res.provider, res.result, r.to, req.title, res.providerMsgId);
      out.push({ participantId: r.participantId, channel: res.channel, result: res.result, providerMsgId: res.providerMsgId, url });
    }
    return out;
  }

  /**
   * 내부 서명자 알림 — 콘솔 계정(username) 서명자에게 이메일로 "콘솔 서명 요청" 안내.
   * 포털 토큰을 발급하지 않고 콘솔 계약 상세 링크를 전달(내부는 콘솔 로그인 후 서명). 발송 이력 기록.
   */
  async notifyInternalSigners(requestId: string, consoleBaseUrl: string, recipients: Array<{ participantId: string; to: string }>) {
    const req = await this.store.getRequest(requestId);
    if (!req) throw new NotFoundException('request not found');
    const out = [];
    for (const r of recipients) {
      const p = req.participants.find((x) => x.participantId === r.participantId);
      if (!p || p.status === 'SIGNED') {
        const reason = !p ? 'unknown' : 'already-signed';
        await this.record(requestId, r.participantId, 'EMAIL', 'mock', 'SKIP', r.to, req.title, undefined, reason);
        out.push({ participantId: r.participantId, result: 'SKIP', reason });
        continue;
      }
      const link = consoleBaseUrl.replace(/\/$/, '') + '/admin/contracts/' + requestId;
      const title = `[서명 요청] ${req.title}`;
      const res = await this.notifier.send({ channel: 'EMAIL', to: r.to, title, url: link });
      await this.record(requestId, r.participantId, res.channel, res.provider, res.result, r.to, title, res.providerMsgId);
      out.push({ participantId: r.participantId, channel: res.channel, result: res.result, providerMsgId: res.providerMsgId });
    }
    return out;
  }

  /** 발송 이력 영속(연락처 마스킹). */
  private async record(requestId: string, participantId: string, channel: string, provider: string, result: string, to: string, title?: string, providerMsgId?: string, reason?: string): Promise<void> {
    await this.store.saveNotify({
      id: randomUUID(),
      requestId,
      participantId,
      channel,
      provider,
      result,
      reason,
      providerMsgId,
      toMasked: maskTo(to),
      title,
      sentAt: new Date().toISOString(),
    });
  }

  async listForRequest(requestId: string) {
    return this.store.notifyByRequest(requestId);
  }
  async listAll() {
    return (await this.store.listNotify()).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  /** 발송 이력 CSV(심사·보존) — 수신번호는 마스킹값만(평문 미포함). */
  async exportCsv(): Promise<string> {
    const headers = ['발송시각', '요청ID', '참가자ID', '채널', '제공자', '결과', '수신(마스킹)', '제목', '사유'];
    const rows = (await this.listAll()).map((n) => [n.sentAt, n.requestId, n.participantId, n.channel, n.provider, n.result, n.toMasked, n.title ?? '', n.reason ?? '']);
    return toCsv(headers, rows);
  }
}
