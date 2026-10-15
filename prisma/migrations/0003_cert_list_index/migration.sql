-- 인증서 목록 확장성 — store_records 에 cert 목록 푸시다운용 인덱스 컬럼 추가.
-- kind='cert' 행만 채움(그 외 null). 검색/정렬(notBefore)/CA 제외/카운트를 DB 레벨로 내림.

ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "ownerType" VARCHAR(10);
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "notBefore" TIMESTAMPTZ;

-- 기존 cert 행 백필: ownerType·notBefore(cert.tbs)·검색텍스트(시리얼·주체DN·유형·면허)
UPDATE "store_records" SET
  "ownerType" = "data"->'cert'->'tbs'->>'ownerType',
  "notBefore" = NULLIF("data"->'cert'->'tbs'->>'notBefore', '')::timestamptz,
  "searchText" = lower(
    concat_ws(' ',
      "data"->'cert'->'tbs'->>'serialNumber',
      "data"->'cert'->'tbs'->>'subjectDn',
      "data"->'cert'->'tbs'->>'ownerType',
      "data"->'cert'->'tbs'->>'licenseNumber'
    )
  )
WHERE "kind" = 'cert';

CREATE INDEX IF NOT EXISTS "store_records_kind_ownerType_notBefore_idx" ON "store_records"("kind", "ownerType", "notBefore");
