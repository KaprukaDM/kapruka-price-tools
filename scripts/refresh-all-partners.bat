@echo off
REM Runs the standalone partner-comparison refresh (src/tools/refresh-all-partners.js)
REM and appends output to logs\refresh-all-partners.log for troubleshooting.
REM Invoked daily by the "Kapruka Price Refresh" Windows Scheduled Task.
cd /d "%~dp0.."
if not exist logs mkdir logs
"C:\Users\fari\AppData\Local\Programs\nodejs\node.exe" src\tools\refresh-all-partners.js >> logs\refresh-all-partners.log 2>&1
