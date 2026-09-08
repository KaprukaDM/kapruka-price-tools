@echo off
REM Runs the standalone partner-comparison refresh (src/tools/refresh-all-partners.js)
REM and appends output to logs\refresh-all-partners.log for troubleshooting.
REM Manual/optional wrapper only. The "Kapruka Price Refresh" Windows Scheduled
REM Task that used to call this was deleted on 2026-09-08 — the schedule now
REM lives inside the app (src/server.js JOBS registry) and is shown, with a
REM "Run now" button, on the Partner Overpriced dashboard. See SCRAPER-SETUP.md.
cd /d "%~dp0.."
if not exist logs mkdir logs
"C:\Users\fari\AppData\Local\Programs\nodejs\node.exe" src\tools\refresh-all-partners.js >> logs\refresh-all-partners.log 2>&1
