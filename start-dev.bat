@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title BDO Meeting Rooms - local development
where node >nul 2>nul
if errorlevel 1 goto missingnode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto missingnode
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING" /c:":5173 .*LISTENING"') do (
  echo [ERROR] Port 3000 or 5173 is already in use. Close your previous dev server first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
set NODE_ENV=development
set ALLOW_ANONYMOUS=1
set HOST=127.0.0.1
set PORT=3000
set SEED_DEMO=0
set DATA_DIR=./data-dev
echo Local demo mode. Use synthetic bookings only.
echo Production requires complete Microsoft SSO settings.
start "BDO API - local only" /min cmd /k "npm run dev:api"
start "BDO WEB - local only" /min cmd /k "npm run dev:web -- --strictPort"
echo Open http://127.0.0.1:5173 after both servers are ready.
echo Close both BDO server windows to stop local development.
pause
exit /b 0
:missingnode
echo [ERROR] Install Node.js 24 or later from https://nodejs.org.
pause
exit /b 1
