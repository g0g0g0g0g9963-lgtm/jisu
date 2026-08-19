@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title BDO Meeting Room - dev server

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

if not exist node_modules (
    echo First run: installing packages. This can take a few minutes...
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
