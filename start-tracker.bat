@echo off
REM Starts the IT Asset Tracker. Keep this window open while people use the tracker.
cd /d "%~dp0"
title IT Asset Tracker - keep this window open
node server.js
echo.
echo The tracker has stopped. Press any key to close this window.
pause >nul
