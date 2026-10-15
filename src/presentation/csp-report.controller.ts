// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { PublicApi } from './api-auth.decorators';

/**
 * CSP 위반 리포트 수집(보안 트랙 S3) — 콘솔·포털의 Content-Security-Policy(report-uri)가
 * 보내는 위반 보고를 구조적 로그로 남긴다. enforce 전환 판단의 근거 데이터.
 *
 * 무인증인 이유: 브라우저가 자동 전송(자격증명 없음). 남용 방어는 전역 rate-limit +
 * 본문 상한(main.ts 의 라우트 스코프 파서 64kb) + 로그 필드 절단으로 한다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('운영 상태')
@Controller('v1/csp-report')
export class CspReportController {
  private readonly logger = new Logger('csp');

  /** CSP 위반 리포트 수신 — 브라우저 report-uri 전송용. 본문을 로그로만 남기고 204(무저장). */
  @Post()
  @PublicApi()
  @HttpCode(204)
  report(@Body() body: unknown): void {
    // report-uri 형식({"csp-report":{...}})·Reporting API 형식 모두 원문 그대로 기록(1KB 절단)
    const raw = JSON.stringify(body ?? {});
    this.logger.warn(`[csp-violation] ${raw.slice(0, 1024)}`);
  }
}
