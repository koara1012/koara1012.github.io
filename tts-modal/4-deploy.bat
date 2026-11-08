@echo off
rem Deploy (or update) the voice server on Modal.
cd /d "%~dp0"
uvx modal deploy irodori_modal.py
echo.
echo Copy the https://....modal.run address shown above.
pause
