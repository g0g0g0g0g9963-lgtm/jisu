# BDO 서울오피스 회의실 예약 — NAS 배포판 v2

원본은 `bdomeetingroom.zip`(2026-08-12 최종본)이다. 원본은 ChatGPT Sites(Cloudflare Workers)용
프로젝트라 NAS에서 그대로 돌 수 없고, 예약 데이터도 **브라우저 메모리에만** 있어서
새로고침하면 사라지고 사용자끼리 공유되지 않았다. 이 배포판은 원본의 화면·로직·폴더
구조(`app/lib`, `app/config`)를 그대로 유지한 채 실행 구조만 바꿨다.

| 항목 | 원본 | NAS 배포판 |
| --- | --- | --- |
| 런타임 | Cloudflare Workers (vinext) | Node 24 + Express (Docker) |
| 예약 저장 | React state (휘발) | SQLite 파일 (`data/bookings.sqlite`) |
| 다중 사용자 | 불가 | 서버 공유 + 30초 주기·창 포커스 시 자동 동기화 |
| 중복 예약 방지 | 화면에서만 검사 | 화면 검사 + 서버 트랜잭션 재검사 (409 반환) |
| 예약 취소 | 화면에서만 삭제 | 서버 DB에서 삭제, 본인 확인(등록자 이름 일치) |

원본 대비 코드 변경은 최소로 유지했다:

- `app/lib/api.ts` **(새 파일)** — 서버 통신 함수 + 로그인 사용자 조회
- `server/auth.mjs` **(새 파일)** — Microsoft SSO (OIDC 인증 코드 + PKCE, 서버 세션)
- `app/page.tsx` — 시드 데이터 대신 서버에서 예약을 읽고, 등록·취소를 서버에 보내는 6곳 수정
- `app/globals.css` — 서버 통신 실패 배너 스타일 1블록 추가
- `standalone/index.html` — 파비콘 링크 1줄 추가 (원본 layout.tsx의 icons 설정과 동일)
- `server/` **(새 폴더)** — Express API. 회의실 목록·운영 시간·시드 데이터는
  프런트와 같은 `app/config/*.json`을 읽으므로 규칙의 원본은 한 곳이다.

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태 확인 (컨테이너 healthcheck에서 사용) |
| GET | `/api/bookings` | 전체 예약. `?from=YYYY-MM-DD&to=YYYY-MM-DD`로 기간 조회 |
| POST | `/api/bookings` | 예약 등록. 반복 예약은 `dates` 배열로 한 번에 (최대 60건, 하나라도 겹치면 전체 취소) |
| DELETE | `/api/bookings/:id` | 예약 취소. 본문의 `owner`가 등록자와 같아야 함 |

## 1. NAS 배포 절차

### 1-1. 포트 확인 (필수)

이미 여러 앱이 올라가 있으니 먼저 비어 있는 포트를 확인한다.

```bash
ssh jinkyu.kim@192.168.100.25 -p 3907 'docker ps --format "{{.Names}}\t{{.Ports}}"'
```

기본값은 `3500`이다. 이미 쓰고 있으면 `.env`의 `HOST_PORT`를 바꾼다.
(2026-08-12 기준 사용 중: 3000 B급 사후심리, 4000 XBRL 비교도구, 8080 SH Portal,
8501 Streamlit, 5555·5556 DSM, 3907 SSH. 새 앱을 올릴 때는 위 명령으로 다시 확인할 것.)

### 1-2. 소스 업로드

아래 경로에 소스를 올리고 압축을 푼다.

```
/volume1/sh-pf/docker/meeting-room/
```

- **DSM File Station으로 할 때**: `BDO_회의실예약_NAS배포v2_20260812.zip` 업로드 후 우클릭 → 압축 풀기
- **SSH로 할 때**: `BDO_회의실예약_NAS배포v2_20260812.tar.gz`를 올린 뒤

  ```bash
  mkdir -p /volume1/sh-pf/docker/meeting-room
  tar -xzf BDO_회의실예약_NAS배포v2_20260812.tar.gz -C /volume1/sh-pf/docker/meeting-room
  ```

  (zip은 Windows에서 만든 것이라 리눅스 `unzip`으로는 풀지 말 것)

### 1-3. 실행

```bash
ssh jinkyu.kim@192.168.100.25 -p 3907
cd /volume1/sh-pf/docker/meeting-room
cp .env.example .env        # HOST_PORT 확인, 첫 화면 확인용이면 SEED_DEMO=1
docker compose up -d --build
docker compose logs -f      # "회의실 예약 서버 실행 중" 확인 후 Ctrl+C
```

접속: `http://192.168.100.25:3500` (HOST_PORT를 바꿨으면 그 포트)

> NAS에서 `node:24-alpine` 이미지와 npm 패키지를 받아야 하므로 NAS에 인터넷 연결이 필요하다.
> 막혀 있으면 PC(Docker Desktop)에서 `docker build -t bdo-meeting-rooms:2.0.0 .` →
> `docker save bdo-meeting-rooms:2.0.0 -o bdo-meeting-rooms.tar` → NAS에서 `docker load -i` 후
> compose의 `build:` 줄을 지우고 `docker compose up -d`로 올린다. (기존 `nas-deploy/images/*.tar` 방식과 동일)

### 1-4. 사내 주소로 서비스하려면

DSM → 제어판 → 로그인 포털 → 고급 → 역방향 프록시에서
`meeting.<사내도메인>` → `localhost:3500`으로 연결하면 포트 없이 접속할 수 있다.

## 2. 운영

**업데이트** — 새 tar.gz를 `/volume1/sh-pf/docker/`에 올린 뒤:

```bash
cd /volume1/sh-pf/docker/meeting-room
sudo tar -xzf /volume1/sh-pf/docker/<새파일>.tar.gz -C . --no-same-permissions --no-same-owner
sudo chown -R jinkyu.kim:users app server standalone public *.json *.yml *.ts *.mjs Dockerfile 2>/dev/null
chmod -R a+rX app server standalone public
sudo docker compose up -d --build
```

⚠️ **`data/` 폴더에는 chown/chmod를 하지 말 것.** 컨테이너(uid 1000)가 쓰는 폴더라
`chown -R jinkyu.kim` 같은 걸 폴더 전체에 돌리면 DB를 못 열어 컨테이너가 죽는다.
실수로 바꿨다면: `sudo chown -R 1000:1000 data && sudo docker compose restart`

**백업** — `data/bookings.sqlite` 파일만 복사하면 된다. (WAL 모드이므로 `-wal` 파일까지 함께)

```bash
cp /volume1/sh-pf/docker/meeting-room/data/bookings.sqlite* /volume1/sh-pf/backups/daily/
```

**회의실·운영시간 변경** — `app/config/rooms.json`, `app/config/site.json` 수정 후
`docker compose up -d --build`. 화면과 서버가 같은 파일을 읽으므로 한 번만 고치면 된다.

**예약 데이터 확인**

```bash
curl -s http://127.0.0.1:3500/api/health
curl -s "http://127.0.0.1:3500/api/bookings?from=2026-08-01&to=2026-08-31"
```

## 3. 로컬 개발

```bash
npm install
npm run build          # dist/ 생성
npm start              # http://localhost:3000 (빌드 결과 + API를 한 포트로)
```

프런트만 고치며 볼 때는 터미널 2개:

```bash
npm run dev:api        # 3000 포트 API
npm run dev:web        # 5173 포트, /api는 3000으로 프록시
```

## 4. Microsoft SSO (Entra ID)

v2.1부터 Microsoft 365 계정 로그인을 지원한다. `.env`의 `MS_TENANT_ID`, `MS_CLIENT_ID`,
`MS_CLIENT_SECRET`, `APP_BASE_URL` 4개를 모두 채우면 켜지고, 하나라도 비면 익명 모드다.

SSO가 켜지면:

- 모든 화면·API가 로그인 필수 (`/api/health` 제외)
- 예약자 이름은 입력받지 않고 **로그인 계정 이름으로 서버가 강제** — 남의 이름 예약 불가
- 취소는 **등록 계정(이메일)이 일치해야만** 가능 (동명이인도 안전)
- 세션 30일 유지, 헤더에 로그아웃 링크 표시

### 4-1. 사전 준비 (한 번만)

**Azure 앱 등록** — portal.azure.com → Microsoft Entra ID → App registrations → New registration:

- 이름: `BDO-MeetingRoom` (아무거나)
- 계정 유형: **이 조직 디렉터리의 계정만** (단일 테넌트)
- Redirect URI: **Web** + `https://<접속주소>/auth/callback`
- 등록 후 Overview에서 **Application (client) ID**, **Directory (tenant) ID** 복사
- Certificates & secrets → New client secret → **Value 즉시 복사** (다시 못 봄, 만료 24개월 권장)

**DSM 역방향 프록시** (https 필수 — MS가 http+IP redirect를 허용하지 않음):

- DSM → 제어판 → 로그인 포털 → 고급 → 역방향 프록시 → 생성
- 소스: HTTPS · 호스트 이름 `*` · 포트 `3501` / 대상: HTTP · `localhost` · `3500`
- 접속 주소는 `https://192.168.100.25:3501` (시놀로지 자체 인증서라 브라우저 경고 1회 허용 필요)

### 4-2. 적용

```bash
cd /volume1/sh-pf/docker/meeting-room
vi .env    # MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / APP_BASE_URL=https://192.168.100.25:3501
sudo docker compose up -d --build
sudo docker compose logs --tail 5    # "[auth] Microsoft SSO 사용" 확인
```

주의: `.env`에 비밀키가 들어가므로 파일 권한을 조여둔다: `chmod 600 .env`

## 5. 아직 남은 것

1. **예약 수정 기능이 없다.** 취소 후 다시 잡는 방식만 가능하다.
2. SSO 이전에 만들어진 예약(시드 포함)은 등록 이메일이 없어서, 취소 시 이름 일치로만 확인한다.
