@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title BDO Meeting Room - dev server

set "REPO_URL=https://github.com/g0g0g0g0g9963-lgtm/jisu.git"
set "BRANCH=claude/setup-continuation-217xow"
set "CODE_CHANGED=0"

echo ============================================
echo   Starting the meeting room site (local).
echo   Keep the two small windows open.
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo   Install the LTS version from https://nodejs.org and run this again.
    pause
    exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed.
    echo   Install it from https://git-scm.com and run this again.
    pause
    exit /b 1
)

if not exist ".git" (
    echo Connecting this folder to the GitHub project...
    git init -q
    git remote add origin "%REPO_URL%"
    git fetch origin %BRANCH% -q
    if errorlevel 1 (
        echo [ERROR] Could not reach GitHub. Check your internet connection.
        pause
        exit /b 1
    )
    git checkout -B %BRANCH% -q
    git reset --hard origin/%BRANCH% -q
    git branch --set-upstream-to=origin/%BRANCH% -q
    set "CODE_CHANGED=1"
    echo Done. This folder now tracks the GitHub project.
) else (
    echo Checking GitHub for the latest code...
    git remote set-url origin "%REPO_URL%" >nul 2>nul
    git fetch origin %BRANCH% -q
    if errorlevel 1 (
        echo [WARNING] Could not reach GitHub. Using the code already on this PC.
    ) else (
        for /f %%h in ('git rev-parse HEAD') do set "LOCAL_REV=%%h"
        for /f %%h in ('git rev-parse origin/%BRANCH%') do set "REMOTE_REV=%%h"
        if not "!LOCAL_REV!"=="!REMOTE_REV!" (
            echo New code found on GitHub. Updating this PC...
            git stash push -u -m "start-dev.bat autosave" -q
            git checkout %BRANCH% -q
            git reset --hard origin/%BRANCH% -q
            set "CODE_CHANGED=1"
            echo Updated to the latest code.
            echo If you had local edits, they were saved safely - to see them, run: git stash list
        ) else (
            echo Already up to date.
        )
    )
)
echo.

if not exist node_modules (
    echo First run: installing packages. This can take a few minutes...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. See the messages above.
        pause
        exit /b 1
    )
) else if "%CODE_CHANGED%"=="1" (
    echo Code was updated: refreshing packages just in case...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. See the messages above.
        pause
        exit /b 1
    )
)

echo Stopping any server left over from before...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do taskkill /F /PID %%p >nul 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5173 .*LISTENING"') do taskkill /F /PID %%p >nul 2>nul

echo Building the latest code (this is what localhost:3000 serves)...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed. See the messages above.
    pause
    exit /b 1
)

echo Starting the booking server...
start "BDO API - do not close" /min cmd /c "npm run dev:api"

echo Starting the web server...
start "BDO WEB - do not close" /min cmd /c "npm run dev:web"

echo Waiting for the site to be ready...
set /a tries=0

:waitloop
set /a tries+=1
curl -s -o nul http://localhost:5173/
if %errorlevel%==0 goto ready
if %tries% geq 90 goto timedout
timeout /t 1 >nul
goto waitloop

:timedout
echo.
echo [WARNING] The site did not respond in time.
echo   Check the two minimized windows for error messages.
pause
exit /b 1

:ready
start "" "http://localhost:5173/"
echo.
echo Done. The site is open at http://localhost:5173/
echo To stop it, close the two minimized windows.
timeout /t 5 >nul
exit /b 0
