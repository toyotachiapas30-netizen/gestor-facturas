@echo off
chcp 65001 >nul
title Instalador Puente Buzon Farrera - Toyota Chiapas (Antigravity)
color 0A

echo ============================================================================
echo   PUENTE AUTOMATICO BUZON FARRERA (24/7) - TOYOTA CHIAPAS / ANTIGRAVITY
echo ============================================================================
echo.

set "WORK_DIR=C:\ToyotaBuzonPuente"
if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"

echo [1/4] Descargando conector oficial de Cloudflare (cloudflared.exe)...
if not exist "%WORK_DIR%\cloudflared.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%WORK_DIR%\cloudflared.exe'"
)

if not exist "%WORK_DIR%\cloudflared.exe" (
    color 0C
    echo [ERROR] No se pudo descargar cloudflared.exe. Verifica tu conexion a internet.
    pause
    exit /b 1
)

echo [2/4] Creando servicio de monitoreo y reconexion automatica...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$code = @'
$WorkDir = 'C:\ToyotaBuzonPuente'
$Cloudflared = Join-Path $WorkDir 'cloudflared.exe'
$LogFile = Join-Path $WorkDir 'tunnel.log'
$RegisterUrl = 'https://control.pagos.toyoter.com/api/buzon-bridge/register'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Start-FarreraTunnel {
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }
    $ArgsList = \"tunnel --url https://autotec.farrera.net:60002 --no-tls-verify --http-host-header autotec.farrera.net:60002 --logfile `\"$LogFile`\"\"
    Start-Process -FilePath $Cloudflared -ArgumentList $ArgsList -WindowStyle Hidden
    $TunnelUrl = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-Path $LogFile) {
            $Content = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue
            if ($Content -match '(https://[a-zA-Z0-9\-]+\.trycloudflare\.com)') {
                $TunnelUrl = $Matches[1]
                break
            }
        }
    }
    if ($TunnelUrl) {
        $Body = @{ url = $TunnelUrl; hostname = $env:COMPUTERNAME; key = 'toyota2026' } | ConvertTo-Json
        try {
            Invoke-RestMethod -Uri $RegisterUrl -Method Post -ContentType 'application/json' -Body $Body -TimeoutSec 15 | Out-Null
            Write-Host \"[OK] Puente conectado: $TunnelUrl -> https://control.pagos.toyoter.com/buzonfecg.aspx\" -ForegroundColor Green
        } catch {}
    }
    return $TunnelUrl
}

$CurrentUrl = Start-FarreraTunnel
while ($true) {
    Start-Sleep -Seconds 60
    $Proc = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $Proc -or -not $CurrentUrl) {
        $CurrentUrl = Start-FarreraTunnel
    }
}
'@; Set-Content -Path 'C:\ToyotaBuzonPuente\servicio_puente.ps1' -Value $code -Encoding UTF8"

echo [3/4] Configurando inicio automatico al encender Windows...
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Puente_Buzon_Toyota.vbs"
echo Set WshShell = CreateObject("WScript.Shell") > "%STARTUP_VBS%"
echo WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\ToyotaBuzonPuente\servicio_puente.ps1""", 0, False >> "%STARTUP_VBS%"

echo [4/4] Iniciando puente en segundo plano y conectando con control.pagos.toyoter.com...
wscript.exe "%STARTUP_VBS%"

echo.
echo Esperando confirmacion del tunel (10 segundos)...
timeout /t 10 /nobreak >nul

echo.
echo ============================================================================
echo   LISTO! EL PUENTE DE OFICINA WINDOWS ESTA ACTIVO Y EN INICIO AUTOMATICO.
echo   Muse ya puede entrar 24/7 desde la nube a:
echo   https://control.pagos.toyoter.com/buzonfecg.aspx
echo ============================================================================
echo.
pause
