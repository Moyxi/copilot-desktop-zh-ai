@echo off
setlocal
chcp 65001 >nul
title GitHub Copilot ZH Launcher
echo [copilot-zh] Starting GitHub Copilot with Chinese localization...
set "COPILOT_ZH_CACHE_DIR=%~dp0cache"
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --lang=zh-CN"
start "" "%~dp0..\github.exe"
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
) else (
  where node >nul 2>nul
  if %errorlevel%==0 (
    set "NODE_CMD=node"
  ) else (
    echo [copilot-zh] ERROR: Node.js not found. Please install Node.js: https://nodejs.org
    pause
    exit /b 1
  )
)
"%NODE_CMD%" "%~dp0inject.js"
echo [copilot-zh] Injector exited. The app may no longer be localized.
pause
