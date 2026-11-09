@echo off
rem Copy this PC Modal token to the secret "modal-billing" (for the usage display).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-billing-secret.ps1"
echo.
echo Next: run 4-deploy.bat again.
pause
