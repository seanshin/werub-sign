// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export interface SignEvent {
  type: string; // request.changed 등
  requestId?: string;
  status?: string;
  at: string; // ISO
}

/**
 * 인프로세스 이벤트 버스 — 서명요청 상태 변경을 SSE 스트림으로 push(실시간 콘솔 갱신).
 * 다중 구독(여러 콘솔 세션) 지원. 멀티노드 시 외부 pub/sub(Redis 등)로 교체 가능.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SignEventsService {
  private readonly subject = new Subject<SignEvent>();

  stream(): Observable<SignEvent> {
    return this.subject.asObservable();
  }

  emit(type: string, data: { requestId?: string; status?: string } = {}): void {
    this.subject.next({ type, requestId: data.requestId, status: data.status, at: new Date().toISOString() });
  }
}
