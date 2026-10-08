@echo off
REM Watchdog: starts src\server.js (the trusted-geo scraper + dashboard) if it
REM isn't already listening on PORT (see .env, default 4555). Scheduled to run
REM every few minutes so the server comes back up after a crash, a reboot, or
REM this machine going to sleep -- Task Scheduler itself has no "restart if the
REM process died" trigger for a long-running process, so this periodic check
REM is the actual restart mechanism. Safe to run while the server is already
REM up: it just finds the port in use and exits without starting a duplicate.
cd /d "%~dp0.."
if not exist logs mkdir logs

netstat -ano | findstr ":4555" | findstr "LISTENING" >nul
if %ERRORLEVEL%==0 (
  exit /b 0
)

echo [%date% %time%] Server not listening on 4555 -- starting it >> logs\server-watchdog.log
start "PriceToolsServer" /min cmd /c "C:\Users\fari\AppData\Local\Programs\nodejs\node.exe" src\server.js ^>^> logs\server.log 2^>^&1
