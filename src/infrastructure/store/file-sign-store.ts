// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemorySignStore } from './in-memory-store';

/**
 * 파일 기반 durable SignStore — 재기동 시 데이터 보존(InMemory의 휘발성 갭 해소).
 * 동일 SIGN_STORE 포트. 운영 권장은 PrismaSignStore(PostgreSQL); 본 어댑터는
 * DB 없이도 영속성을 보장하는 경량 대안(소규모/단일노드).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class FileSignStore extends InMemorySignStore {
  constructor(private readonly filePath: string) {
    super();
    if (existsSync(this.filePath)) {
      try {
        this.loadSnapshot(readFileSync(this.filePath, 'utf8'));
      } catch {
        /* 손상 파일 무시하고 빈 상태로 시작 */
      }
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
  }

  protected override async persist(): Promise<void> {
    writeFileSync(this.filePath, this.toSnapshot(), 'utf8');
  }
}
