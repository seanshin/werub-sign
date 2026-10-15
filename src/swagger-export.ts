import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

/**
 * OpenAPI 명세를 docs/openapi.json 으로 export (UI 미서빙 — 통합팀 배포용).
 * 실행: npm run swagger:export
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = buildOpenApiDocument(app);
  writeFileSync('docs/openapi.json', JSON.stringify(doc, null, 2));
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`docs/openapi.json 생성 — ${Object.keys(doc.paths).length} paths`);
  process.exit(0);
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
