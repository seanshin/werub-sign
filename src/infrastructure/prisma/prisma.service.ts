// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 연결 수명주기 — STORE_DRIVER=prisma일 때만 연결(DB 없는 개발환경 보호).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  private connected = false;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('STORE_DRIVER') !== 'prisma') return; // 미사용 시 연결 안 함
    await this.$connect();
    this.connected = true;
    this.logger.log('PostgreSQL 연결됨');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) await this.$disconnect();
  }
}
