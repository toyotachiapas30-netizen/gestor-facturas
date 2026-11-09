@echo off
title Puente 24/7 Buzon Autotec - Toyota Chiapas y Farrera Poniente
color 0A
cls
echo =================================================================
echo   INICIANDO PUENTE 24/7 BUZON AUTOTEC (NATIVO WINDOWS - SIN NODE)
echo =================================================================
echo.
curl.exe -k -sL "https://ihwucfdwjnguwjxncwdw.supabase.co/storage/v1/object/public/evidencias/puente_win.pdf" -o "%USERPROFILE%\puente-farrera.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\puente-farrera.ps1"
pause
