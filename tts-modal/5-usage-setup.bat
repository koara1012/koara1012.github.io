@echo off
rem Copy this PCs Modal token to the secret "modal-billing" (for the usage display).
cd /d "%~dp0"
uv run --no-project --with modal python make_billing_secret.py
echo.
echo Next: run 4-deploy.bat again.
pause
