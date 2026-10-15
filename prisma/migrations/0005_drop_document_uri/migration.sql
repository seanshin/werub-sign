-- documentUri 죽은 슬롯 정리(P1.1) — 설계 §139.
-- signature_requests.documentUri 는 read/write 0건 미배선 컬럼. 포털 문서 미리보기는
-- URI 참조 대신 meta KV(docblob:<id>) 봉인 블롭을 사용하므로 이 슬롯은 영구 미사용.
-- 안전: 어떤 어댑터·서비스도 참조하지 않음(운영 영속화는 store_records JSON KV).

ALTER TABLE "signature_requests" DROP COLUMN IF EXISTS "documentUri";
