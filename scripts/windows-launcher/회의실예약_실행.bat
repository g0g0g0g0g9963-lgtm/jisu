@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "REPO_URL=https://github.com/g0g0g0g0g9963-lgtm/jisu.git"
set "BRANCH=claude/setup-continuation-217xow"
set "PROJECT_DIR=%~dp0app"
set "PORT=3000"

title BDO 회의실 예약 - 준비 중

echo ============================================
echo   BDO 회의실 예약 사이트를 준비하고 있습니다.
echo   이 창은 사이트가 열리면 그냥 두거나 최소화해도 됩니다.
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [오류] Git이 설치되어 있지 않습니다.
    echo   https://git-scm.com/download/win 에서 설치한 뒤 다시 실행해 주세요.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo pnpm을 준비하는 중입니다...
    call corepack enable >nul 2>nul
    call corepack prepare pnpm@latest --activate >nul 2>nul
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [오류] pnpm을 준비하지 못했습니다.
    echo   명령 프롬프트를 열어 아래 명령을 직접 실행한 뒤 다시 시도해 주세요:
    echo     npm install -g pnpm
    pause
    exit /b 1
)

if not exist "%PROJECT_DIR%\.git" (
    echo 처음 실행이라 코드를 내려받습니다. 잠시 기다려 주세요...
    git clone --branch "%BRANCH%" "%REPO_URL%" "%PROJECT_DIR%"
    if errorlevel 1 (
        echo [오류] 코드를 내려받지 못했습니다. GitHub 로그인/접근 권한을 확인해 주세요.
        echo   ^(처음 다운로드할 때 브라우저로 GitHub 로그인 창이 뜰 수 있어요. 로그인해 주세요.^)
        pause
        exit /b 1
    )
) else (
    echo 최신 코드로 업데이트하는 중입니다...
    pushd "%PROJECT_DIR%"
    git fetch origin "%BRANCH%"
    git checkout "%BRANCH%" >nul 2>nul
    git reset --hard "origin/%BRANCH%"
    if errorlevel 1 (
        echo [경고] 코드 업데이트에 실패했습니다. 인터넷 연결이나 GitHub 로그인을 확인해 주세요.
        echo         일단 기존에 받아둔 코드로 계속 실행합니다.
    )
    popd
)

pushd "%PROJECT_DIR%"
echo 필요한 패키지를 설치^/갱신하는 중입니다 ^(처음 실행할 때는 몇 분 걸릴 수 있어요^)...
call pnpm install
popd

echo 이전에 실행 중이던 사이트가 있으면 종료합니다...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    taskkill /F /PID %%p >nul 2>nul
)

echo 사이트를 실행하는 중입니다...
pushd "%PROJECT_DIR%"
start "BDO 회의실 예약 서버 (닫지 마세요)" /min cmd /c "pnpm run dev"
popd

echo 사이트가 열릴 때까지 기다리는 중입니다...
set /a tries=0

:waitloop
set /a tries+=1
curl -s -o nul http://localhost:%PORT%/
if %errorlevel%==0 goto ready
if %tries% geq 60 goto ready
timeout /t 1 >nul
goto waitloop

:ready
start "" "http://localhost:%PORT%/"

echo.
echo 브라우저에서 사이트가 열렸습니다. 이 창은 닫아도 되고, 그냥 두어도 됩니다.
echo ^(사이트를 완전히 끄려면 최소화된 "BDO 회의실 예약 서버" 창을 닫아 주세요.^)
timeout /t 5 >nul

endlocal
exit /b 0
