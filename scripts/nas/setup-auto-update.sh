#!/bin/sh
# ============================================================
#  회의실 예약 — 자동 업데이트 최초 설정 (한 번만 실행)
#
#  지금 폴더를 GitHub와 연결해서, 이후 auto-update.sh 가 새 코드를
#  받아올 수 있게 만든다.
#
#  예약 DB(data/)와 SSO 설정(.env)은 건드리지 않는다.
# ============================================================
set -eu

PROJECT_DIR="${PROJECT_DIR:-/volume1/sh-pf/docker/meeting-room}"
REPO_URL="${REPO_URL:-https://github.com/g0g0g0g0g9963-lgtm/jisu.git}"
BRANCH="${BRANCH:-claude/setup-continuation-217xow}"

echo "회의실 예약 자동 업데이트 설정"
echo "  폴더   : $PROJECT_DIR"
echo "  저장소 : $REPO_URL"
echo "  브랜치 : $BRANCH"
echo

cd "$PROJECT_DIR" || {
  echo "폴더를 찾을 수 없습니다: $PROJECT_DIR" >&2
  exit 1
}

if ! command -v git >/dev/null 2>&1; then
  echo "git이 없습니다. DSM 패키지 센터에서 Git Server를 설치한 뒤 다시 실행하세요." >&2
  exit 1
fi

# --- 지금 상태를 되돌릴 수 있게 백업 -------------------------------
BACKUP_DIR="${PROJECT_DIR}/../meeting-room-backup-$(date +%Y%m%d-%H%M%S)"
echo "[1/5] 되돌릴 수 있도록 백업합니다: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
[ -f .env ] && cp .env "$BACKUP_DIR/" || true
if [ -d data ]; then
  cp -a data "$BACKUP_DIR/"
  echo "      예약 DB(data/)와 .env를 복사했습니다."
fi

# --- GitHub 토큰 ---------------------------------------------------
echo
echo "[2/5] GitHub 읽기 전용 토큰이 필요합니다."
echo "      (만드는 방법은 scripts/nas/README.md 참고)"
printf "      토큰을 붙여넣고 Enter: "
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
echo
if [ -z "$TOKEN" ]; then
  echo "토큰이 비어 있습니다. 설정을 중단합니다." >&2
  exit 1
fi

# --- git 연결 ------------------------------------------------------
echo "[3/5] GitHub와 연결합니다."
[ -d .git ] || git init -q
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

# 토큰은 .git 안에 소유자만 읽을 수 있는 파일로 둔다.
# (.git은 저장소에 올라가지 않으므로 코드에 섞여 들어갈 일이 없다)
CRED_FILE="${PROJECT_DIR}/.git/deploy-credentials"
OLD_UMASK=$(umask)
umask 077
printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > "$CRED_FILE"
umask "$OLD_UMASK"
chmod 600 "$CRED_FILE"
git config credential.helper "store --file=${CRED_FILE}"
unset TOKEN

# --- 최신 코드 받기 -------------------------------------------------
echo "[4/5] 최신 코드를 받습니다."
if ! git fetch origin "$BRANCH"; then
  echo >&2
  echo "코드를 가져오지 못했습니다. 다음을 확인하세요:" >&2
  echo "  - NAS에서 github.com 접속이 되는지 (ping github.com)" >&2
  echo "  - 토큰이 이 저장소를 읽을 수 있는지" >&2
  exit 1
fi

git branch -f "$BRANCH" "origin/${BRANCH}"
git symbolic-ref HEAD "refs/heads/${BRANCH}"
# 추적 파일만 최신으로 맞춘다. data/와 .env는 추적 대상이 아니라 그대로 남는다.
git reset --hard --quiet "origin/${BRANCH}"
git branch --set-upstream-to="origin/${BRANCH}" "$BRANCH" >/dev/null 2>&1 || true

chmod +x scripts/nas/auto-update.sh 2>/dev/null || true

echo "      현재 버전: $(git log --oneline -1)"
[ -f .env ] && echo "      .env 유지됨" || echo "      (.env 없음 - 익명 모드로 동작합니다)"
[ -d data ] && echo "      예약 DB(data/) 유지됨"

# --- 안내 -----------------------------------------------------------
echo
echo "[5/5] 설정 완료. 이제 DSM 작업 스케줄러에 등록하세요."
echo
echo "  제어판 > 작업 스케줄러 > 생성 > 예약된 작업 > 사용자 정의 스크립트"
echo "    - 사용자     : root"
echo "    - 일정       : 매일 / 5분 간격 반복"
echo "    - 실행 명령  : sh ${PROJECT_DIR}/scripts/nas/auto-update.sh"
echo
echo "  등록 뒤 바로 한 번 실행해 보려면:"
echo "    sh ${PROJECT_DIR}/scripts/nas/auto-update.sh"
echo "    tail -f ${PROJECT_DIR}/auto-update.log"
echo
echo "  문제가 생기면 백업으로 되돌릴 수 있습니다: $BACKUP_DIR"
