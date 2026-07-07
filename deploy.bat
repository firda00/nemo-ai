@echo off
REM Nemo AI — one-click backend deploy. Double-click this file.
cd /d "%~dp0"
title Nemo AI deploy
echo ================================================
echo   Nemo AI - deploying backend to Supabase...
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
echo ================================================
echo   Finished. Read the messages above.
echo   You can close this window.
echo ================================================
pause
