-- 서명요청 대시보드 필터 확장 — store_records 에 출처(createdBy)·서명모드(signMode) 인덱스 컬럼 추가.
-- kind='request' 행만 채움. 출처·서명모드·미완료(다중상태) 필터를 DB 레벨로 처리.

ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "createdBy" VARCHAR(30);
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "signMode" VARCHAR(20);

UPDATE "store_records" SET
  "createdBy" = "data"->>'createdBy',
  "signMode" = "data"->>'signMode'
WHERE "kind" = 'request';

CREATE INDEX IF NOT EXISTS "store_records_kind_createdBy_reqCreatedAt_idx" ON "store_records"("kind", "createdBy", "reqCreatedAt");
