-- R16 — 다중 노드 동시성 가드(저장소 수준). 인프로세스 KeyedMutex 는 같은 노드만 직렬화하므로
-- 수평 확장·롤링 배포 시 ①meta 단일 슬롯 lost update ②감사 해시체인 분기가 재현된다.
-- 애플리케이션은 낙관적 잠금(CAS)+재시도로 대응하고, **최종 보장은 아래 두 유니크 인덱스**가 한다.
--
-- ※ 대용량 기존 설치는 배포 전에 CONCURRENTLY 로 수동 생성할 것(운영 가이드 §1.2 — Prisma 는
--   마이그레이션을 트랜잭션으로 감싸 CONCURRENTLY 를 쓸 수 없다). 수동 생성 후 이 마이그레이션은 no-op.

-- ── ① meta 슬롯 유일성 ────────────────────────────────────────────────────────
-- putOne 은 delete+create 를 한 트랜잭션으로 하므로 중복이 생길 구조는 아니지만, 유니크 제약이
-- 없으면 "최초 생성 CAS"(expectedVersion=null)의 경합을 막을 수단이 없다.
-- 중복이 있다면 **최신(seq 최대) 행만 남긴다** — getOne 이 이미 seq DESC 로 그 행만 읽으므로
-- 애플리케이션 관점에서 보이지 않던 행을 지우는 것이라 의미 변화가 없다.
DELETE FROM "store_records" a
  USING "store_records" b
  WHERE a."kind" = 'meta' AND b."kind" = 'meta' AND a."rkey" = b."rkey" AND a."seq" < b."seq";

CREATE UNIQUE INDEX IF NOT EXISTS "store_records_meta_slot_uniq"
  ON "store_records"("kind", "rkey")
  WHERE "kind" = 'meta';

-- ── ② 감사 해시체인 분기 차단 ─────────────────────────────────────────────────
-- 같은 스트림에서 같은 prevHash 를 두 번 쓰는 것은 곧 체인 분기다. append-only 라 중복을
-- 정리할 수 없으므로(감사 기록 삭제 금지), **중복이 있으면 배포를 멈추고 사람이 조사**한다.
-- 이미 끊긴 체인 위에 제약만 얹으면 "무결"로 오인될 수 있기 때문이다.
DO $$
DECLARE dup_streams text;
BEGIN
  SELECT string_agg(DISTINCT "rkey", ', ') INTO dup_streams
    FROM (
      SELECT "rkey" FROM "store_records"
        WHERE "kind" = 'audit'
        GROUP BY "rkey", ("data"->>'prevHash')
        HAVING count(*) > 1
    ) d;
  IF dup_streams IS NOT NULL THEN
    RAISE EXCEPTION
      '감사 체인 분기가 이미 존재합니다 — 유니크 인덱스를 만들기 전에 조사가 필요합니다. 해당 스트림: %',
      dup_streams;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "store_records_audit_prevhash_uniq"
  ON "store_records"("rkey", (("data"->>'prevHash')))
  WHERE "kind" = 'audit';
