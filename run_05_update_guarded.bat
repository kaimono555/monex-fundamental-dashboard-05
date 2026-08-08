@echo off
setlocal
cd /d "%~dp0"

set "SCRIPT=%~dp0scripts\run_update_05_guarded.ps1"

echo Starting 05 fundamentals update (guarded)...
echo Script: %SCRIPT%
echo.

if not exist "%SCRIPT%" (
  echo ERROR: PowerShell script not found.
  echo %SCRIPT%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXITCODE=%ERRORLEVEL%"

echo.
echo PowerShell exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
