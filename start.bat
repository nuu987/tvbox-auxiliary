@echo off
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-node.ps1
if errorlevel 1 goto failed

echo.
echo   [2/2] Starting service...
echo.
node scripts\start.js
pause
goto end

:failed
pause

:end
