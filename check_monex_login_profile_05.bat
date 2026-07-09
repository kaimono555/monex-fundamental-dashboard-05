@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\check_monex_login_profile.ps1" -BCode 7203
pause
