# 회의실 예약 앱 보안·기능 수정본 — 2026-10-08

이 파일은 보안 수정본의 실행·이관 안내입니다. 이전 배포 문서와 충돌하면 이 안내를 우선합니다.
원본 ZIP과 실예약 DB는 변경하지 않았습니다. 운영 배포는 수행하지 않았습니다.

## 달라진 점

- Microsoft SSO 설정이 하나라도 빠지면 서버가 시작하지 않습니다. 운영에서는 익명 모드를 허용하지 않습니다.
- 로그인 오류 메시지를 안전하게 출력하고 상태값·만료를 검사합니다. 외부 주소로 돌아가는 리디렉션을 차단합니다.
- 새 예약 소유권은 Microsoft 계정의 Object ID로 확인합니다. 화면은 서버의 본인 여부를 사용합니다.
- 기존 이메일이 있는 예약은 이메일로 호환됩니다. 이메일과 계정 ID가 모두 없는 예약은 이름만으로 수정·삭제할 수 없습니다.
- 반복 생성에는 실제 seriesId가 부여됩니다. 과거 예약은 임의로 반복 묶음으로 합치지 않습니다.
- 과거 시각·12개월 초과 변경을 차단하고, 진행 중 예약의 유효한 조기 종료를 유지합니다.
- 통신 오류 후 처리 중 상태를 해제하고 재시도를 안내합니다. 저장 중 작성한 새 입력은 보존합니다.
- 반복 일부 날짜의 충돌, 빈 평일 구간, 주간 시간 미선택을 처리합니다.
- 모바일에서는 문서 자체가 화면 폭에 맞고, 넓은 예약표 내부만 가로 스크롤됩니다.
- Vite와 취약한 하위 의존성을 갱신했습니다. npm 잠금파일을 단일 설치 기준으로 사용합니다.

## 로컬 확인

Node.js 24 이상과 npm을 사용합니다. npm ci가 설치 파일을 다운로드할 수 있어야 합니다.

Windows에서는 start-dev.bat를 실행할 수 있습니다. 익명 개발 모드를 명시하고 127.0.0.1에만 바인딩합니다.
3000/5173 포트가 사용 중이면 다른 프로세스를 종료하지 않고 중단합니다. 별도 data-dev 폴더를 사용합니다.

수동 PowerShell 실행 예:

    npm ci
    $env:NODE_ENV="development"
    $env:ALLOW_ANONYMOUS="1"
    $env:HOST="127.0.0.1"
    $env:DATA_DIR="./data-dev"
    npm run dev:api

다른 터미널에서 npm run dev:web을 실행하고 http://127.0.0.1:5173 으로 접속합니다.
익명 개발 모드에서는 MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / APP_BASE_URL 네 값이 모두 비어 있어야 합니다.
일부만 있는 경우에는 개발 모드에서도 시작을 거부합니다.

## 운영 구성

1. 기존 소스·환경설정·DB를 백업하고, 기존 NAS를 덮어쓰기 전에 별도 검증 환경에서 확인합니다.
2. .env.example을 참고해 다음 네 값을 모두 설정합니다: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, APP_BASE_URL.
3. APP_BASE_URL은 신뢰할 수 있는 HTTPS origin이어야 합니다. 경로·쿼리·fragment는 넣지 않습니다.
4. Entra 앱의 Web Redirect URI는 APP_BASE_URL/auth/callback 입니다.
5. 제공 Dockerfile/compose는 NODE_ENV=production을 사용합니다. ALLOW_ANONYMOUS=1을 지정해도 운영 익명 실행은 거절됩니다.
6. npm start는 .env가 있으면 읽습니다. 직접 Node 실행에서도 NODE_ENV=production을 설정합니다.
7. 검증 계정 두 개로 로그인·로그아웃·본인/타인 수정·삭제·계정 이름 변경을 확인한 뒤 직원에게 공개합니다.

서버는 app/config/site.json의 timeZone(Asia/Seoul)을 기준으로 예약 제한을 계산합니다.
SQLite 스키마는 시작 시 owner_id와 series_id 열을 추가하며 기존 예약 내용은 유지합니다.
서버의 일반 기본 바인딩을 바꾸지 않은 경우에도 운영은 제공 compose의 HOST=127.0.0.1과 HTTPS 프록시 구성을 사용합니다.

## 기존 예약 소유권 연결

동봉된 원본 백업의 예약은 계정 정보가 비어 있었습니다. 이름으로 계정을 추측해 자동 연결하지 않았습니다.
전산담당자가 예약 ID·기존 표시 이름·실제 계정 Object ID·이메일을 확인해야 합니다.
연결 전에는 로그인 사용자에게 기존 예약의 수정·삭제 권한을 주지 않습니다. 조회는 가능합니다.

server/assign-legacy-owner.mjs는 명시한 예약 ID만 연결합니다. 기본은 읽기 전용 미리보기입니다.

mapping.json 형식(각 값은 담당자가 확인한 값으로 교체):

    [
      {
        "bookingId": "bk-실제예약ID",
        "expectedOwner": "DB에 저장된 기존 표시이름",
        "ownerId": "확인한 Entra Object ID GUID",
        "ownerEmail": "확인한 실제 계정 이메일"
      }
    ]

미리보기:

    node server/assign-legacy-owner.mjs --db "C:\예약데이터\bookings.sqlite" --mapping "C:\검증된매핑\mapping.json"

미리보기 결과를 검토하고 앱을 완전히 중지한 다음 적용:

    node server/assign-legacy-owner.mjs --db "C:\예약데이터\bookings.sqlite" --mapping "C:\검증된매핑\mapping.json" --apply --offline-confirmed

적용 직전에 일관된 SQLite 백업을 자동 생성하고, 트랜잭션으로 처리합니다.
이미 계정 ID가 있는 예약, 기존 이메일과 충돌하는 매핑, 표시이름 불일치, 중복 ID는 거부합니다.
현재 앱이 실제로 중지됐는지는 도구가 운영 서비스 전체를 감지할 수 없으므로 담당자가 확인해야 합니다.
실제 DB에는 이 도구를 실행하지 않았습니다.

## 재검증·배포 범위

GitHub 저장소 루트의 qa-api.mjs / qa-frontend.mjs는 가상 DB와 가상 Microsoft 응답으로 회귀 검증합니다.
저장소에서는 ZIP의 `01_사이트_최신본` 내용을 루트에 배치했습니다. `MANIFEST_SHA256.csv`는 원본 ZIP의 경로와 해시를 기록한 전달 당시 자료입니다.
실제 Microsoft 로그인을 대신하는 검증은 아닙니다. 테스트 결과와 수정 완료 보고서는 상위 evidence 폴더에 있습니다.
기존 매뉴얼 PDF는 화면 이용 참고용으로 유지했으며, 인증·운영 정책은 이 안내를 따릅니다.
압축파일에는 실제 DB, .env, 세션, node_modules, 가상 테스트 DB를 넣지 않습니다.
