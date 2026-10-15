-- 계약함 목록 인덱스 정합(감사 §4-2 EXPLAIN 실측 후속)
-- 실측(라이브 1,001행): 기존 4열 인덱스는 kind+signMode 까지만 Index Cond 로 쓰이고
--   (NOT archived OR archived IS NULL) 은 Filter, reqCreatedAt DESC 는 별도 Sort 로 처리됐다.
--   행이 커지면 "계약함 기본 조회(비보관·최신순)"가 전량 필터+정렬로 떨어진다.
-- 대응: 해당 술어를 그대로 담은 **부분 인덱스**(정렬 포함) 추가. 기존 인덱스는 보관함(archived=true)·
--   분류 조회에 계속 쓰이므로 유지한다.
--
-- ※ 대용량 기존 설치는 배포 전에 아래를 CONCURRENTLY 로 수동 생성할 것(운영 가이드 §1.2 — Prisma 는
--   마이그레이션을 트랜잭션으로 감싸 CONCURRENTLY 를 쓸 수 없다). 수동 생성 후 이 마이그레이션은 no-op.
CREATE INDEX IF NOT EXISTS "store_records_contract_open_list_idx"
  ON "store_records"("kind", "signMode", "reqCreatedAt" DESC)
  WHERE "archived" IS NOT TRUE;
