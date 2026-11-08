@echo off
rem Save the passphrase (IRODORI_API_KEY) as a Modal secret.
set /p KEY=Passphrase (letters and numbers only): 
uvx modal secret create irodori-tts IRODORI_API_KEY=%KEY% --force
pause
