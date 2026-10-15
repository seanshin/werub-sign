// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

interface MinimalReq { method?: string; url?: string; headers: Record<string, unknown> }
interface MinimalRes { status(code: number): MinimalRes; json(body: unknown): unknown }

/**
 * 전역 에러 포맷 — conventions §6: { error: { code, message, requestId } }.
 * 민감정보·키·토큰은 메시지에 미포함(conventions §3/§5).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<MinimalRes>();
    const req = ctx.getRequest<MinimalReq>();
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = this.codeFor(status, exception);
    const message =
      exception instanceof HttpException
        ? this.extractMessage(exception)
        : '내부 오류가 발생했습니다'; // 내부 예외 메시지 비노출

    // 500은 진단 위해 스택 로그(응답엔 비노출). 4xx는 요약만.
    if (status >= 500) {
      const e = exception as Error;
      this.logger.error(`${code} ${req.method} ${req.url} (${requestId}) — ${e?.message ?? exception}`, e?.stack);
    }
    res.status(status).json({ error: { code, message, requestId } });
  }

  private codeFor(status: number, exception: unknown): string {
    const map: Record<number, string> = {
      400: 'INVALID_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      410: 'GONE',
      422: 'UNPROCESSABLE',
    };
    if (map[status]) return map[status];
    return status >= 500 ? 'INTERNAL' : 'ERROR';
  }

  private extractMessage(exception: HttpException): string {
    const r = exception.getResponse();
    if (typeof r === 'string') return r;
    const m = (r as { message?: string | string[] }).message;
    return Array.isArray(m) ? m.join('; ') : m ?? exception.message;
  }
}
