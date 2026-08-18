@echo off
REM Runs the International Gifting Price Checker refresh (src\uae-compare\cli-refresh.js)
REM and appends output to logs\refresh-uae-compare.log for troubleshooting.
REM Invoked every 3 hours by the "Kapruka UAE Compare Refresh" Windows Scheduled Task.
cd /d "%~dp0.."
if not exist logs mkdir logs
"C:\Users\fari\AppData\Local\Programs\nodejs\node.exe" src\uae-compare\cli-refresh.js UAE >> logs\refresh-uae-compare.log 2>&1
