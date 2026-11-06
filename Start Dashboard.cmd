@echo off
title MV7+ Control
rem Starts the local server for the dashboard, then opens the browser.
rem Close this window to stop the server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 (
  echo.
  echo Could not start the local server. You can also open index.html directly
  echo in Chrome or Edge.
  pause
)
