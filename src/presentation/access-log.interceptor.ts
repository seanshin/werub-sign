// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'node:crypto';

/**
 * HTTP 접근 로그 — EMR 보안성/접근기록(누가·언제·무엇을). 구조적(JSON) 1줄/요청.
 * requestId 상관관계 + actor 귀속(user:<관리자> / consumerApp / staff:sub) + 상태·지연·IP.
 * 민감정보 비기록: api-key·바디·쿼리스트링 미로깅, /portal/<token> 마스킹.
 * ACCESS_LOG=false 로 비활성. ApiKeyGuard가 req.consumerApp 설정 후 인터셉터 실행(actor 가용).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('access');
  private readonly enabled = process.env.ACCESS_LOG !== 'false';

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled || context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const res = http.getResponse<any>();
    const start = Date.now();
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = requestId;
    res.setHeader?.('x-request-id', requestId);
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress;

    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode, start, requestId, ip),
        error: (err) => this.write(req, err?.status ?? 500, start, requestId, ip),
      }),
    );
  }

  private write(req: any, status: number, start: number, requestId: string, ip?: string): void {
    const actor = req.adminUser?.username
      ? `user:${req.adminUser.username}`
      : req.consumerApp?.name ?? (req.staffActor ? `staff:${req.staffActor}` : 'anonymous');
    this.logger.log(
      JSON.stringify({
        t: new Date().toISOString(),
        reqId: requestId,
        method: req.method,
        path: this.maskPath((req.originalUrl || req.url || '').split('?')[0]),
        status,
        ms: Date.now() - start,
        ip,
        actor,
      }),
    );
  }

  /** 포털 토큰 등 비밀 경로 세그먼트 마스킹 */
  private maskPath(path: string): string {
    return path.replace(/\/portal\/[^/]+/g, '/portal/***');
  }
}
