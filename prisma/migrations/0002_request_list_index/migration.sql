-- 서명요청 대시보드 확장성 — store_records 에 목록 푸시다운용 인덱스 컬럼 추가.
-- kind='request' 행만 채움(그 외 null). 검색/정렬/기간필터/카운트를 DB 레벨로 내림.

ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "status" VARCHAR(30);
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "reqCreatedAt" TIMESTAMPTZ;
ALTER TABLE "store_records" ADD COLUMN IF NOT EXISTS "searchText" TEXT;

-- 기존 request 행 백필: 상태·생성시각(없으면 updatedAt 근사)·검색텍스트(제목·문서ID·요청ID·참가자명)
UPDATE "store_records" SET
  "status" = "data"->>'status',
  "reqCreatedAt" = COALESCE(NULLIF("data"->>'createdAt', '')::timestamptz, "updatedAt"),
  "searchText" = lower(
    concat_ws(' ',
      "data"->>'title',
      "data"->>'externalDocId',
      "rkey",
      (SELECT string_agg(p->>'displayName', ' ')
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof("data"->'participants') = 'array'
              THEN "data"->'participants' ELSE '[]'::jsonb END
       ) AS p)
    )
  )
WHERE "kind" = 'request';

CREATE INDEX IF NOT EXISTS "store_records_kind_status_reqCreatedAt_idx" ON "store_records"("kind", "status", "reqCreatedAt");
CREATE INDEX IF NOT EXISTS "store_records_kind_reqCreatedAt_idx" ON "store_records"("kind", "reqCreatedAt");
