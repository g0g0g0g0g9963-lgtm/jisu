@echo off
setlocal EnableExtensions

set "REPO_URL=https://github.com/g0g0g0g0g9963-lgtm/jisu.git"
set "BRANCH=claude/setup-continuation-217xow"
set "PROJECT_DIR=%~dp0app"
set "PORT=3000"

title BDO Meeting Room Booking - starting

echo ============================================
echo   Starting the BDO meeting room booking site.
echo   You can ignore or minimize this window once the site opens.
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed.
    echo   Install it from https://git-scm.com/download/win and run this again.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo   Install the LTS version from https://nodejs.org and run this again.
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo Setting up pnpm...
    call corepack enable >nul 2>nul
    call corepack prepare pnpm@latest --activate >nul 2>nul
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Could not set up pnpm.
    echo   Open Command Prompt and run: npm install -g pnpm
    echo   Then run this file again.
    pause
    exit /b 1
)

if not exist "%PROJECT_DIR%\.git" (
    echo First run: downloading the site code...
    git clone --branch "%BRANCH%" "%REPO_URL%" "%PROJECT_DIR%"
    if errorlevel 1 (
        echo [ERROR] Could not download the code.
        echo   Check your internet connection and GitHub access.
        echo   A browser window may pop up asking you to sign in to GitHub - please sign in.
        pause
        exit /b 1
    )
) else (
    echo Updating to the latest code...
    pushd "%PROJECT_DIR%"
    git fetch origin "%BRANCH%"
    git checkout "%BRANCH%" >nul 2>nul
    git reset --hard "origin/%BRANCH%"
    if errorlevel 1 (
        echo [WARNING] Could not update the code. Check your internet/GitHub access.
        echo           Continuing with the code already downloaded.
    )
    popd
)

pushd "%PROJECT_DIR%"
echo Installing/updating packages (first run can take a few minutes)...
call pnpm install
popd

echo Stopping any previously running copy of the site...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    taskkill /F /PID %%p >nul 2>nul
)

echo Starting the site...
pushd "%PROJECT_DIR%"
start "BDO Meeting Room Server - do not close" /min cmd /c "pnpm run dev"
popd

echo Waiting for the site to be ready...
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
echo The site has opened in your browser. You can close this window.
echo (To fully stop the site, close the minimized "BDO Meeting Room Server" window.)
timeout /t 5 >nul

endlocal
exit /b 0
