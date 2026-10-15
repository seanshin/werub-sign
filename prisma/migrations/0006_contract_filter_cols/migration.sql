-- 계약함 목록 확장성(A3) — 계약 트랙 필터(보관·분류·라벨)를 store_records 인덱스 컬럼으로 승격.
-- 정본은 contract-meta(meta 행)이며, 컬럼은 필터 캐시. 레거시 행 백필은 앱 부팅 시
-- ContractService 가 1회 수행(meta 'contract-filter-cols:v1' 플래그) — 3개 스토어(InMemory/File/Prisma) 공통 경로.

ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "archived" BOOLEAN;
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "category" VARCHAR(40);
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "labelsText" TEXT;

CREATE INDEX IF NOT EXISTS "store_records_kind_signMode_archived_reqCreatedAt_idx"
  ON "store_records"("kind", "signMode", "archived", "reqCreatedAt");
