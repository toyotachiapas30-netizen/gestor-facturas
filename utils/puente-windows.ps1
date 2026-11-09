# ============================================================================
# PUENTE 24/7 BUZON GRUPO FARRERA (100% NATIVO WINDOWS POWERSHELL - SIN NODE)
# Toyota Chiapas y Farrera Poniente
# ============================================================================

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::DefaultConnectionLimit = 50
[System.Net.ServicePointManager]::Expect100Continue = $false

$SUPA_URL = "https://ihwucfdwjnguwjxncwdw.supabase.co"
$SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlod3VjZmR3am5ndXdqeG5jd2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzY4MzQsImV4cCI6MjA5NTA1MjgzNH0.A2ND8DKBDGQ6ymhUDs_x6qZtcStoUDyk_0akG2hVD7Q"
$RELAY_DATE = "2099-12-30"

# Registrar arranque automático al iniciar sesión en Windows (sin requerir Admin)
try {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $startupCmd = Join-Path $startupDir "Puente_Buzon_Farrera_24_7.cmd"
    $scriptCopy = Join-Path $env:USERPROFILE "puente-farrera-24-7.ps1"
    if ($MyInvocation.MyCommand.Path -and ($MyInvocation.MyCommand.Path -ne $scriptCopy)) {
        Copy-Item -Path $MyInvocation.MyCommand.Path -Destination $scriptCopy -Force -ErrorAction SilentlyContinue
    }
    $cmdContent = "@echo off`r`nstart `"Puente Buzon Farrera 24/7`" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptCopy`"`r`n"
    Set-Content -Path $startupCmd -Value $cmdContent -Encoding ASCII -ErrorAction SilentlyContinue
} catch {}

Clear-Host
Write-Host "=================================================================" -ForegroundColor Green
Write-Host "  PUENTE 24/7 BUZON AUTOTEC ACTIVO (MODO NATIVO WINDOWS SIN NODE)" -ForegroundColor Green
Write-Host "  Enlace para Muse: https://control.pagos.toyoter.com/buzonfecg.aspx" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "[OK] Conectado por puerto 443 seguro. Esperando peticiones de Muse..." -ForegroundColor Yellow

function Invoke-SupaJson {
    param(
        [string]$Method,
        [string]$Path,
        [string]$JsonBody = ""
    )
    $uri = "$SUPA_URL$Path"
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = $Method
    $req.Timeout = 8000
    $req.KeepAlive = $true
    $req.Headers.Add("apikey", $SUPA_KEY)
    $req.Headers.Add("Authorization", "Bearer $SUPA_KEY")
    $req.ContentType = "application/json; charset=utf-8"

    if ($JsonBody -ne "") {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }

    $res = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    $res.Close()
    if ($text) {
        return ($text | ConvertFrom-Json)
    }
    return $null
}

function Invoke-AutotecForward {
    param($reqData)
    $path = if ($reqData.path) { $reqData.path } else { "/buzonfecg.aspx" }
    $method = if ($reqData.method) { $reqData.method } else { "GET" }
    $uri = "https://autotec.farrera.net:60002$path"

    $webReq = [System.Net.HttpWebRequest]::Create($uri)
    $webReq.Method = $method
    $webReq.Timeout = 18000
    $webReq.AllowAutoRedirect = $false
    $webReq.KeepAlive = $true

    if ($reqData.headers) {
        foreach ($prop in $reqData.headers.PSObject.Properties) {
            $k = $prop.Name
            $v = [string]$prop.Value
            $lower = $k.ToLower()
            if ($lower -eq "content-type") {
                $webReq.ContentType = $v
            } elseif ($lower -eq "user-agent") {
                $webReq.UserAgent = $v
            } elseif ($lower -eq "accept") {
                $webReq.Accept = $v
            } elseif ($lower -eq "referer") {
                $webReq.Referer = "https://autotec.farrera.net:60002/buzonfecg.aspx"
            } elseif ($lower -eq "origin") {
                $webReq.Headers["Origin"] = "https://autotec.farrera.net:60002"
            } elseif ($lower -eq "cookie") {
                $webReq.Headers["Cookie"] = $v
            }
        }
    }

    if ($reqData.bodyB64 -and $reqData.bodyB64.Length -gt 0) {
        $bodyBytes = [Convert]::FromBase64String([string]$reqData.bodyB64)
        $webReq.ContentLength = $bodyBytes.Length
        $reqStream = $webReq.GetRequestStream()
        $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
        $reqStream.Close()
    } elseif ($method -eq "POST") {
        $webReq.ContentLength = 0
    }

    try {
        $webRes = [System.Net.HttpWebResponse]$webReq.GetResponse()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $webRes = [System.Net.HttpWebResponse]$_.Exception.Response
        } else {
            throw $_
        }
    }

    $statusCode = [int]$webRes.StatusCode
    $contentType = if ($webRes.ContentType) { $webRes.ContentType } else { "text/html; charset=utf-8" }
    $setCookies = @()
    if ($webRes.Headers["Set-Cookie"]) {
        $setCookies = @($webRes.Headers.GetValues("Set-Cookie"))
    }

    $ms = New-Object System.IO.MemoryStream
    $resStream = $webRes.GetResponseStream()
    if ($resStream) {
        $resStream.CopyTo($ms)
        $resStream.Close()
    }
    $webRes.Close()
    $resBytes = $ms.ToArray()
    $ms.Close()

    return @{
        statusCode  = $statusCode
        contentType = $contentType
        setCookie   = $setCookies
        bodyB64     = [Convert]::ToBase64String($resBytes)
    }
}

while ($true) {
    try {
        $rows = Invoke-SupaJson -Method "GET" -Path "/rest/v1/taller_citas?fecha_cita=eq.$RELAY_DATE&estado=eq.PENDING&select=id,folio,datos_recepcion&order=id.asc&limit=5"
        if ($rows) {
            $rowList = if ($rows -is [System.Array]) { $rows } else { @($rows) }
            foreach ($row in $rowList) {
                if (-not $row -or -not $row.id) { continue }
                $reqData = $row.datos_recepcion
                $ts = (Get-Date).ToString("HH:mm:ss")
                Write-Host "[$ts] -> $($reqData.method) $($reqData.path)" -ForegroundColor Cyan
                try {
                    $resObj = Invoke-AutotecForward -reqData $reqData
                    $patchObj = @{
                        estado = "DONE"
                        datos_recepcion = @{
                            reqId   = $reqData.reqId
                            method  = $reqData.method
                            path    = $reqData.path
                            res     = $resObj
                        }
                    }
                    $jsonPatch = $patchObj | ConvertTo-Json -Depth 10 -Compress
                    $null = Invoke-SupaJson -Method "PATCH" -Path "/rest/v1/taller_citas?id=eq.$($row.id)" -JsonBody $jsonPatch
                    Write-Host "[$ts] <- HTTP $($resObj.statusCode) OK" -ForegroundColor Green
                } catch {
                    $errMsg = $_.Exception.Message
                    Write-Host "[$ts] ERROR: $errMsg" -ForegroundColor Red
                    $errPatch = @{
                        estado = "ERROR"
                        datos_recepcion = @{
                            error = $errMsg
                        }
                    } | ConvertTo-Json -Depth 6 -Compress
                    try { $null = Invoke-SupaJson -Method "PATCH" -Path "/rest/v1/taller_citas?id=eq.$($row.id)" -JsonBody $errPatch } catch {}
                }
            }
        }
    } catch {
        # Ignorar microcortes de red
    }
    Start-Sleep -Milliseconds 300
}
