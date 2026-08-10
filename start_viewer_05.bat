@echo off
REM 05 ローカルビューアサーバー起動（http://<このPCのIP>:8055/）
REM ログオン時のタスクスケジューラから起動される。手動でダブルクリックしても可（最小化ウィンドウで起動）。
if "%1"=="min" goto :run
start "" /min cmd /c "%~f0" min
exit /b

:run
cd /d "%~dp0"
node viewer\server.js
