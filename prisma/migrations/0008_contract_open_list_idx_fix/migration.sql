-- 0007 부분 인덱스 술어 정정 — 플래너가 실제로 사용하도록 **질의와 동일한 술어**로 재생성.
-- 실측(라이브 PG16): 술어를 `archived IS NOT TRUE` 로 두면 질의의 `(archived = false OR archived IS NULL)`
--   와의 함의를 증명하지 못해 인덱스가 선택되지 않았다(EXPLAIN 상 기존 인덱스+Sort 유지).
--   동일한 OR 형태로 만들면 Index Scan 으로 채택됨(트랜잭션 내 재현 확인).
-- ※ 대용량 설치는 배포 전 CONCURRENTLY 수동 생성 권장(운영 가이드 §1.2).
DROP INDEX IF EXISTS "store_records_contract_open_list_idx";
CREATE INDEX IF NOT EXISTS "store_records_contract_open_list_idx"
  ON "store_records"("kind", "signMode", "reqCreatedAt" DESC)
  WHERE ("archived" = false OR "archived" IS NULL);
