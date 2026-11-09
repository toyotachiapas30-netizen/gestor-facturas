@echo off
title Instalar Puente 24/7 en el Arranque de Windows
color 0B
echo ====================================================================
echo   INSTALADOR DE ARRANQUE AUTOMATICO 24/7 EN WINDOWS (SIN VENTANAS)
echo ====================================================================
echo.
set "SCRIPT_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_FILE=%STARTUP_DIR%\Puente_Autotec_Toyota_24_7.vbs"

(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.CurrentDirectory = "%SCRIPT_DIR:~0,-1%"
echo WshShell.Run "cmd /c INICIAR_PUENTE_24_7.bat", 0, False
) > "%VBS_FILE%"

echo [OK] Se configuro el Puente 24/7 para iniciar automaticamente cada vez
echo      que enciendas esta computadora Windows (en segundo plano).
echo.
echo Iniciando el puente ahora mismo...
wscript.exe "%VBS_FILE%"
echo.
echo ¡Listo! Ya puedes cerrar esta ventana.
pause
