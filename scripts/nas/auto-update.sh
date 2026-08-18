#!/bin/sh
# ============================================================
#  회의실 예약 — NAS 자동 업데이트
#
#  GitHub에 새 코드가 올라오면 받아서 컨테이너를 다시 빌드한다.
#  DSM 작업 스케줄러에 5분마다 실행으로 등록해 두고 쓴다.
#  (최초 설정은 setup-auto-update.sh 를 한 번 실행)
#
#  새 코드가 없으면 아무것도 하지 않고 바로 끝난다.
# ============================================================
set -eu

PROJECT_DIR="${PROJECT_DIR:-/volume1/sh-pf/docker/meeting-room}"
BRANCH="${BRANCH:-claude/setup-continuation-217xow}"
LOG_FILE="${PROJECT_DIR}/auto-update.log"
LOCK_DIR="${PROJECT_DIR}/.auto-update.lock"
LOG_MAX_BYTES=1000000

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

cd "$PROJECT_DIR" || {
  echo "프로젝트 폴더를 찾을 수 없습니다: $PROJECT_DIR" >&2
  exit 1
}

# 빌드가 실행 간격보다 오래 걸릴 수 있어, 겹쳐 실행되지 않게 잠근다.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "이전 실행이 아직 진행 중이라 이번 차례는 건너뜁니다."
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

# 로그가 무한정 커지지 않도록 정리한다.
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt "$LOG_MAX_BYTES" ]; then
  tail -n 500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "[실패] GitHub에서 코드를 가져오지 못했습니다. 인터넷 연결이나 토큰 만료를 확인하세요."
  exit 1
fi

LOCAL_REV=$(git rev-parse HEAD)
REMOTE_REV=$(git rev-parse "origin/${BRANCH}")

if [ "$LOCAL_REV" = "$REMOTE_REV" ]; then
  # 바뀐 게 없으면 조용히 끝낸다. (로그를 남기지 않는다)
  exit 0
fi

log "새 코드 발견: $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/${BRANCH}")"

# 추적 중인 소스 파일만 교체된다.
# data/(예약 DB)와 .env(SSO 설정)는 .gitignore에 있어 그대로 남는다.
git reset --hard --quiet "origin/${BRANCH}"
log "적용할 변경: $(git log --oneline -1)"

log "컨테이너를 다시 빌드합니다…"
if ! compose up -d --build >> "$LOG_FILE" 2>&1; then
  log "[실패] 빌드 중 오류가 났습니다. 위 로그를 확인하세요."
  log "        기존 컨테이너는 계속 동작하므로 사이트는 멈추지 않습니다."
  exit 1
fi

# 실제로 응답하는지까지 확인한다. (.env의 HOST_PORT를 읽고, 없으면 3500)
HOST_PORT=$(sed -n 's/^[[:space:]]*HOST_PORT=\([0-9][0-9]*\).*/\1/p' .env 2>/dev/null | tail -n 1)
HOST_PORT="${HOST_PORT:-3500}"

i=0
while [ "$i" -lt 12 ]; do
  if curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null; then
    log "[완료] $(git rev-parse --short HEAD) 적용됨. 사이트 정상 응답."
    exit 0
  fi
  i=$((i + 1))
  sleep 5
done

log "[경고] 빌드는 끝났지만 사이트가 응답하지 않습니다. 'docker compose logs' 를 확인하세요."
exit 1
