# NAS 자동 업데이트

코드가 수정되면 NAS가 **스스로** 최신 코드를 받아 다시 빌드합니다.
아래 설정을 **한 번만** 해두면, 이후에는 손댈 일이 없습니다.

동작 방식은 이렇습니다.

```
코드 수정 → GitHub에 올림 → NAS가 5분마다 확인 → 새 코드가 있으면
자동으로 받아서 다시 빌드 → 브라우저 새로고침하면 반영
```

예약 데이터(`data/`)와 SSO 설정(`.env`)은 업데이트해도 **그대로 유지**됩니다.

---

## 1단계 — GitHub 읽기 전용 토큰 만들기

저장소가 비공개라서 NAS가 코드를 받으려면 토큰이 필요합니다.
**읽기 전용**이라 이 토큰으로는 코드를 바꿀 수 없습니다.

1. https://github.com/settings/personal-access-tokens/new 접속
2. 아래대로 설정합니다.

   | 항목 | 값 |
   | --- | --- |
   | Token name | `nas-meeting-room` |
   | Expiration | 원하는 기간 (예: 1년) |
   | Repository access | **Only select repositories** → `jisu` 선택 |
   | Permissions → Repository permissions → **Contents** | **Read-only** |

3. `Generate token`을 누르고 나온 값(`github_pat_...`)을 복사합니다.
   이 화면을 벗어나면 다시 볼 수 없으니 바로 다음 단계로 넘어가세요.

> 만료되면 자동 업데이트가 멈추고 `auto-update.log`에 실패가 기록됩니다.
> 그때는 토큰을 새로 만들어 2단계만 다시 실행하면 됩니다.

## 2단계 — NAS에서 설정 스크립트 실행

SSH로 NAS에 접속해서 아래를 실행합니다.

```sh
cd /volume1/sh-pf/docker/meeting-room
sh scripts/nas/setup-auto-update.sh
```

`scripts` 폴더가 아직 없다면, 이 저장소의 `scripts/nas/` 두 파일을 먼저
같은 경로에 올려두고 실행하세요.

스크립트가 하는 일:

1. `data/`와 `.env`를 백업합니다 (`../meeting-room-backup-<날짜>`)
2. 토큰을 물어봅니다 (화면에 표시되지 않습니다)
3. 폴더를 GitHub와 연결하고 최신 코드로 맞춥니다
4. 등록할 명령을 알려줍니다

## 3단계 — DSM 작업 스케줄러에 등록

**제어판 → 작업 스케줄러 → 생성 → 예약된 작업 → 사용자 정의 스크립트**

| 항목 | 값 |
| --- | --- |
| 작업 이름 | `회의실 예약 자동 업데이트` |
| 사용자 | `root` |
| 일정 | 매일 / **5분 간격으로 반복** |
| 사용자 정의 스크립트 | `sh /volume1/sh-pf/docker/meeting-room/scripts/nas/auto-update.sh` |

저장한 뒤 목록에서 해당 작업을 선택하고 **실행**을 눌러 한 번 확인해 보세요.

---

## 확인하는 방법

```sh
tail -f /volume1/sh-pf/docker/meeting-room/auto-update.log
```

- 새 코드가 없으면 **아무것도 기록하지 않습니다** (로그가 조용한 게 정상)
- 업데이트가 있으면 이렇게 남습니다.

```
2026-08-13 06:46:54  새 코드 발견: fd04229 -> ddee989
2026-08-13 06:46:54  적용할 변경: ddee989 회의실 정보 카드 여백 축소
2026-08-13 06:46:54  컨테이너를 다시 빌드합니다…
2026-08-13 06:48:10  [완료] ddee989 적용됨. 사이트 정상 응답.
```

## 안전장치

- **예약 데이터는 지워지지 않습니다.** `data/`와 `.env`는 Git이 추적하지 않아
  업데이트 대상에서 제외됩니다.
- **빌드가 실패하면 기존 사이트가 계속 돌아갑니다.** 새 컨테이너가 뜨지 못하면
  이전 컨테이너가 그대로 유지되고, 로그에 실패가 기록됩니다.
- **빌드 후 응답까지 확인합니다.** 사이트가 뜨지 않으면 로그에 경고를 남깁니다.
- **겹쳐 실행되지 않습니다.** 빌드가 5분을 넘겨도 다음 차례는 건너뜁니다.
- 토큰은 `.git/deploy-credentials`에 소유자만 읽을 수 있는 권한(600)으로 저장되고,
  저장소에는 올라가지 않습니다.

## 자동 업데이트를 멈추려면

작업 스케줄러에서 해당 작업의 체크를 해제하면 됩니다.

## 되돌리려면

설정할 때 만들어진 백업 폴더(`../meeting-room-backup-<날짜>`)에 이전 `data/`와
`.env`가 들어 있습니다. 특정 시점 코드로 돌아가려면:

```sh
cd /volume1/sh-pf/docker/meeting-room
git log --oneline          # 원하는 시점의 앞 7자리 확인
git reset --hard <그 값>
docker compose up -d --build
```
