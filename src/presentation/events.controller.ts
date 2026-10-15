// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { SignEventsService } from '../application/events.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { ApiTags } from '@nestjs/swagger';

// express 타입 의존 없이 사용하는 부분만 구조적 정의(SSE 응답/요청).
interface SseResponse {
  set(headers: Record<string, string>): void;
  flushHeaders?(): void;
  write(chunk: string): void;
  on(event: string, cb: () => void): void;
}
interface SseRequest {
  on(event: string, cb: () => void): void;
}

/**
 * 실시간 이벤트 스트림(SSE) — 콘솔이 서명요청 상태 변경을 즉시 수신(수동 새로고침 불요).
 * 수동 SSE(@Res)로 헤더 제어: X-Accel-Buffering=no 로 nginx 버퍼링 무력화(설정 변경 불요).
 * 인증=ApiKeyGuard(x-session-token 헤더, fetch 기반 클라이언트). 15초 heartbeat로 연결 유지.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('운영 상태')
@Controller()
export class EventsController {
  constructor(private readonly events: SignEventsService) {}

  /** 실시간 이벤트 스트림(SSE) — 콘솔 화면 갱신용. 연동 통지는 webhook 을 쓴다. */
  @Get('v1/events/stream')
  @UseGuards(ApiKeyGuard)
  @RequireScope('requests:write')
  stream(@Req() req: SseRequest, @Res() res: SseResponse): void {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 프록시 버퍼링 비활성(스트리밍)
    });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n'); // 재연결 권장 간격
    res.write(`event: ready\ndata: {"at":"${new Date().toISOString()}"}\n\n`);

    const sub = this.events.stream().subscribe((e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const hb = setInterval(() => res.write(': ping\n\n'), 15_000); // 주석 프레임 heartbeat

    const close = () => { clearInterval(hb); sub.unsubscribe(); };
    req.on('close', close);
    res.on('close', close);
  }
}
