#!/usr/bin/env bash
# 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
#
# sign DB 일별 백업(보안 트랙 S7) — 증거 서비스는 백업이 곧 증거 보존이다.
#
# 파이프라인: pg_dump -Fc(컨테이너 내부에서 생성·목차 검증까지 마친 뒤 반출)
#   → sha256(평문 기준 — 복원 리허설 때 복호 후 대조) → gpg AES256 대칭 암호화
#   → 평문 즉시 삭제 → 로컬 보존 14세대 → 오프사이트(러너 박스) rsync·30세대.
#
# 전제(호스트 1회 설정 — 운영 런북 backup-restore-runbook.md 참조):
#   ~/.sign-backup-passphrase        gpg 대칭 암호(600) — 분실 시 백업 전체가 무용지물.
#                                    오프사이트 호스트와 비밀번호 관리자에 사본 필수.
#   ~/.ssh/sign-backup-offsite       오프사이트 push 모드에서만 필요한 전송 전용 ssh 키
#   SIGN_API_KEY (env, 선택)         설정 시 성공 하트비트를 앱에 전송 — S9 감시가 백업 중단을 탐지한다
#   SIGN_BACKUP_OFFSITE (env)        pull(기본) = 외부 호스트가 당겨간다(이 스크립트는 전송하지 않음)
#                                    push       = 아래 OFFSITE_* 로 rsync 전송(전용 키 필요)
#   OFFSITE_HOST/PORT/DIR/KEEP (env) push 모드의 대상 — 기본값은 as-built 런북 참조
#
# 실행: 라이브 호스트 cron(일별) — 실패는 exit!=0 로 크론 로그에 남는다(fail-loud).
set -euo pipefail

TS=$(date -u +%Y%m%d-%H%M%S)
DIR="$HOME/sign-backups"
PASS="$HOME/.sign-backup-passphrase"
KEEP_LOCAL=14
OFFSITE_MODE="${SIGN_BACKUP_OFFSITE:-pull}"   # pull=외부가 당겨감(기본) · push=여기서 rsync 전송
OFFSITE_HOST="${OFFSITE_HOST:-}"
OFFSITE_PORT="${OFFSITE_PORT:-22}"
OFFSITE_DIR="${OFFSITE_DIR:-sign-backups-offsite}"
OFFSITE_KEEP="${OFFSITE_KEEP:-30}"

[ -r "$PASS" ] || { echo "✗ 암호문 파일 없음: $PASS"; exit 1; }
mkdir -p "$DIR"
f="$DIR/sign-$TS.dump"

# 덤프는 컨테이너 안에서 생성하고 pg_restore --list 로 아카이브 목차까지 검증한 뒤 반출
# (호스트에 pg 클라이언트 불요 + 깨진 덤프를 백업으로 오인하는 것 차단)
docker exec sign-postgres sh -c \
  'pg_dump -U sign -d sign -Fc -f /tmp/sign-bk.dump && pg_restore --list /tmp/sign-bk.dump > /dev/null'
docker cp -q sign-postgres:/tmp/sign-bk.dump "$f"
docker exec sign-postgres rm -f /tmp/sign-bk.dump

sha256sum "$f" > "$f.sha256"
gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS" -o "$f.gpg" "$f"
rm -f "$f" # 평문은 디스크에 남기지 않는다

# 로컬 세대 관리
ls -1t "$DIR"/sign-*.dump.gpg 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | while read -r old; do
  rm -f "$old" "${old%.gpg}.sha256"
done

# 성공 하트비트(S9) — **로컬 암호화 산출물이 완성된 이 시점이 "백업 성공"이다.**
# 오프사이트(아래)는 별개 레이어라, 그 실패가 "백업 신호 없음" 경보로 둔갑하면 진짜 원인이 가려진다.
# 하트비트 실패가 백업을 실패로 만들지는 않는다(백업은 이미 끝났다) — 경고만 남긴다.
if [ -n "${SIGN_API_KEY:-}" ]; then
  curl -sS -m 10 -X POST "${SIGN_API:-http://127.0.0.1:4100}/v1/maintenance/backup-heartbeat" \
    -H "x-api-key: $SIGN_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"note\":\"$(basename "$f").gpg\"}" -o /dev/null \
    || echo "⚠ 백업 하트비트 전송 실패 — 백업 자체는 성공(감시 잡이 오탐 경보할 수 있음)"
fi

# 오프사이트 복제 — pull 모드에서는 외부 호스트(운영자 Mac 등)가 당겨가므로 여기서 전송하지 않는다.
# push 모드 실패는 exit!=0 로 크론 로그에 남는다(fail-loud) — 로컬 백업·하트비트는 이미 끝난 뒤다.
if [ "$OFFSITE_MODE" = "push" ]; then
  [ -n "$OFFSITE_HOST" ] || { echo "✗ push 모드인데 OFFSITE_HOST 미설정"; exit 1; }
  SSH_OPTS=(-p "$OFFSITE_PORT" -i "$HOME/.ssh/sign-backup-offsite" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$f.gpg" "$f.sha256" "$OFFSITE_HOST:$OFFSITE_DIR/"
  ssh "${SSH_OPTS[@]}" "$OFFSITE_HOST" \
    "cd $OFFSITE_DIR && ls -1t sign-*.dump.gpg 2>/dev/null | tail -n +$((OFFSITE_KEEP + 1)) | while read -r o; do rm -f \"\$o\" \"\${o%.gpg}.sha256\"; done"
  OFFSITE_NOTE="오프사이트 push OK"
else
  OFFSITE_NOTE="오프사이트=pull 대기(외부 puller 가 회수)"
fi

echo "✓ $(date -u +%FT%TZ) sign 백업 완료: $(basename "$f").gpg ($(du -h "$f.gpg" | cut -f1)) 로컬 $(ls -1 "$DIR"/sign-*.dump.gpg | wc -l)세대·$OFFSITE_NOTE"
