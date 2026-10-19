@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if /i "%~1"=="--sync-loop" goto syncloop
title BDO Meeting Rooms - update and run

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or not in PATH.
  pause
  exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
echo Branch: %BRANCH%
echo Downloading the latest changes from GitHub...
git pull --ff-only origin %BRANCH%
if errorlevel 1 (
  echo.
  echo [ERROR] Update failed. Your local files may have unsaved changes.
  echo Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)

echo Starting auto update: checks GitHub every 30 seconds.
start "BDO SYNC - auto update" /min cmd /c ""%~f0" --sync-loop"

set "RUNNING="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING" /c:":5173 .*LISTENING"') do set "RUNNING=1"
if defined RUNNING (
  echo Servers are already running. Just refresh http://127.0.0.1:5173
  pause
  exit /b 0
)
call "%~dp0start-dev.bat"
exit /b 0

:syncloop
title BDO SYNC - auto update every 30 seconds
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
echo Auto update is running for branch %BRANCH%. Close this window to stop.
:syncagain
timeout /t 30 /nobreak >nul
git pull --ff-only --quiet origin %BRANCH% >nul 2>&1
if errorlevel 1 (
  echo [%time%] Update skipped. Run update-and-run.bat again if this repeats.
) else (
  echo [%time%] Up to date.
)
goto syncagain
