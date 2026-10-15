// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';

/**
 * 운영 알림(보안 트랙 S9) — 임계 이벤트를 운영자에게 **즉시** 밀어낸다.
 *
 * 존재 이유: 지금까지 침해·고장의 징후는 로그와 감사 스트림에 쌓이기만 했다. 쌓인다는 것은
 * 누군가 보러 갈 때까지 아무 일도 일어나지 않는다는 뜻이고, 증거 서비스에서 가장 위험한 것은
 * **조용한 실패**다(백업이 3주째 안 돌아간 것을 복구가 필요한 날 알게 되는 것).
 *
 * 설계 원칙:
 *  - **알림 실패가 본 기능을 막지 않는다** — 전송은 best-effort, 예외는 삼키고 로그만 남긴다.
 *  - **폭주 억제**: 같은 alertKey 는 `ALERT_THROTTLE_MIN`(기본 60분) 안에 1회만 발송한다.
 *    억제된 동안의 발생 횟수는 다음 발송 본문에 합산해 알린다(사라지지 않게).
 *  - **미설정이면 로그 전용**: `OPS_ALERT_TO` 없으면 조용히 로그만 — 개발·테스트에서 무해.
 *  - 마지막 발송 시각은 스토어 meta 에 두어 **재기동해도 폭주 억제가 유지**된다.
 *
 * 설정: `OPS_ALERT_TO`(쉼표 구분 수신자) · `SMTP_URL`/`SMTP_FROM`(발송 경로) ·
 *      `ALERT_THROTTLE_MIN`(기본 60).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
type AlertState = { lastSentAt: string; suppressed: number };

@Injectable()
export class AlertService {
  private readonly log = new Logger('alert');

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private cfg(k: string): string | undefined {
    return this.config?.get<string>(k) ?? process.env[k];
  }

  private key(alertKey: string): string {
    return `alert:${alertKey}`;
  }

  /**
   * 알림 발생. 같은 alertKey 의 재발생은 throttle 창 안에서 억제되고 횟수만 누적된다.
   * @returns **알림이 발생했는지**(억제되면 false). 메일 전달 성패와는 무관하다 —
   *          수신자 미설정·SMTP 장애로 전달이 실패해도 "탐지했다"는 사실은 참이어야 하고,
   *          호출자의 집계가 전달 채널 구성에 좌우되면 안 된다(로그에는 항상 남는다).
   */
  async raise(alertKey: string, subject: string, body: string): Promise<boolean> {
    const throttleMin = Math.max(0, Number(this.cfg('ALERT_THROTTLE_MIN') ?? 60));
    const now = Date.now();
    let suppressedSince = 0;
    try {
      // **발송 전에 발송 슬롯을 CAS 로 선점**한다(버전 일치 조건부 쓰기). 종전엔 send 후에 lastSentAt 을
      // 저장해, 같은 키의 동시 raise 가 전부 throttle 통과 → N 통 발송되는 창이 있었다.
      const { value: prev, version } = await this.store.getMetaVersioned<AlertState>(this.key(alertKey));
      if (prev && now - Date.parse(prev.lastSentAt) < throttleMin * 60_000) {
        // throttle 창 안 — 억제 횟수만 누적(경합 실패 시 다른 raise 가 이미 누적했으므로 무시).
        await this.store.saveMetaIfUnchanged(this.key(alertKey), version, { lastSentAt: prev.lastSentAt, suppressed: (prev.suppressed ?? 0) + 1 });
        return false;
      }
      const claimed = await this.store.saveMetaIfUnchanged(this.key(alertKey), version, { lastSentAt: new Date(now).toISOString(), suppressed: 0 });
      if (!claimed) return false; // 동시 raise 가 슬롯을 먼저 선점 — 그쪽이 보낸다(중복 발송 방지)
      suppressedSince = prev?.suppressed ?? 0;
    } catch (e) {
      this.log.warn(`알림 상태 조회 실패(계속 진행): ${(e as Error).message}`);
    }

    const full = suppressedSince ? `${body}\n\n(직전 발송 이후 같은 알림 ${suppressedSince}건이 억제되었습니다.)` : body;
    // 발송 성패와 무관하게 로그는 항상 남긴다 — 메일이 막혀도 흔적은 남아야 한다(슬롯은 위에서 이미 선점됨)
    this.log.warn(`[ops-alert] ${subject} — ${full.replace(/\n+/g, ' ').slice(0, 500)}`);
    await this.send(subject, full); // best-effort — 실패해도 탐지 사실은 유지
    return true;
  }

  private async send(subject: string, body: string): Promise<boolean> {
    const to = (this.cfg('OPS_ALERT_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const smtpUrl = this.cfg('SMTP_URL');
    const from = this.cfg('SMTP_FROM');
    if (!to.length || !smtpUrl || !from) return false; // 미설정 = 로그 전용
    try {
      const { createTransport } = await import('nodemailer');
      const transporter = createTransport(smtpUrl);
      try {
        await transporter.sendMail({ from, to: to.join(','), subject: `[sign 운영알림] ${subject}`, text: body });
        return true;
      } finally {
        transporter.close();
      }
    } catch (e) {
      this.log.error(`운영 알림 발송 실패: ${(e as Error).message}`);
      return false; // 알림 실패가 호출자를 막지 않는다
    }
  }
}
