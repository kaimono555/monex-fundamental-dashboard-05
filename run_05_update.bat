@echo off
setlocal
cd /d "%~dp0"

set "SCRIPT=%~dp0scripts\update_all_05.ps1"

echo Starting 05 fundamentals update...
echo Script: %SCRIPT%
echo.

if not exist "%SCRIPT%" (
  echo ERROR: PowerShell script not found.
  echo %SCRIPT%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%SCRIPT%"
set "EXITCODE=%ERRORLEVEL%"

echo.
echo PowerShell exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
