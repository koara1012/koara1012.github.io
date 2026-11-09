@echo off
rem Upload voices to Modal. Put this folder in D:\Irodori-TTS-Server\modal
cd /d "%~dp0"
if exist "..\make-voices.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "..\make-voices.ps1"
uvx modal volume create irodori-voices 2>nul
uvx modal volume put irodori-voices "%~dp0..\voices" / --force
echo.
echo Done. New voices are used after the GPU sleeps (about 4 minutes without talking).
pause
