# Запуск dirigo одной командой (Windows).
# Требуется bun (например, из scoop: scoop install bun)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    $shim = "$env:USERPROFILE\scoop\shims\bun.exe"
    if (Test-Path $shim) { $env:Path += ";$env:USERPROFILE\scoop\shims" }
    else { throw "bun не найден. Установи: scoop install bun" }
}

$env:PORT = if ($env:PORT) { $env:PORT } else { "7171" }
Write-Host "Dirigo: http://127.0.0.1:$env:PORT" -ForegroundColor Cyan
Start-Process "http://127.0.0.1:$env:PORT"
& bun run src/server.ts
