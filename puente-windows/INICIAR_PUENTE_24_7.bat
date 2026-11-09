@echo off
title Puente 24/7 Buzon Autotec - Toyota Chiapas y Poniente
color 0A
echo ====================================================================
echo   PUENTE 24/7 BUZON AUTOTEC - TOYOTA CHIAPAS Y FARRERA PONIENTE
echo ====================================================================
echo.
cd /d "%~dp0"
:loop
node puente-autotec.js
echo.
echo [!] El puente se reiniciara automaticamente en 5 segundos...
timeout /t 5 /nobreak >nul
goto loop
