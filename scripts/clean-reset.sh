#!/usr/bin/env bash
# sign 전면교체(clean reset) — 개발/시드 전용. CA·DB·키 전량 삭제 후 신규 CA 부트스트랩.
# ⚠️ 두 볼륨(sign_pgdata=DB·CA메타, sign_keydata=개인키)을 함께 삭제한다(한쪽만 지우면 keyRef 불일치).
# 안전장치: CONFIRM=RESET 없으면 거부. 운영 실데이터엔 사용 금지(개발 시드 한정).
#
# 사용: CONFIRM=RESET bash scripts/clean-reset.sh
set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

if [ "${CONFIRM:-}" != "RESET" ]; then
  echo "🛑 거부 — 전면교체는 CA·DB·키를 전량 삭제합니다(되돌릴 수 없음)."
  echo "   개발/시드 데이터임을 확인했으면: CONFIRM=RESET bash scripts/clean-reset.sh"
  exit 2
fi

echo "── 리셋 전 현재 CA 시리얼 ──"
curl -s http://127.0.0.1:4100/v1/admin/ops-status -H "x-api-key: $(grep ^CONSOLE_API_KEY= .env.prod | cut -d= -f2-)" 2>/dev/null \
  | (node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d).data.ca;console.log('  issuing=',c.issuingSerial,'root=',c.rootSerial)}catch{console.log('  (조회 불가)')}})" 2>/dev/null || echo "  (조회 불가)")

echo "── 볼륨 삭제(down -v) + 재기동(신규 CA) ──"
$COMPOSE down -v
$COMPOSE up -d --build sign web

echo "── 신규 CA 부트스트랩 대기 ──"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4100/health/ready >/dev/null 2>&1; then break; fi
  sleep 2
done
docker logs sign-core 2>&1 | grep -E "CA 번들 신규|CA bootstrap" | tail -1 || true

echo "── 리셋 후 신규 CA 시리얼 ──"
curl -s http://127.0.0.1:4100/v1/admin/ops-status -H "x-api-key: $(grep ^CONSOLE_API_KEY= .env.prod | cut -d= -f2-)" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=JSON.parse(d).data.ca;console.log('  issuing=',c.issuingSerial,'root=',c.rootSerial)})"
echo "── readiness ──"; curl -s http://127.0.0.1:4100/health/ready; echo ""
echo "✅ sign 전면교체 완료 — 신규 CA. 이제 HIS/PACS 재프로비저닝(재enroll) 진행."
echo "   (선택) sign 시드: SEED_FORCE=1 SEED_API_KEY=<HIS_INBOUND_API_KEY> SEED_BASE_URL=http://127.0.0.1:4100 node scripts/seed-dev.mjs"
