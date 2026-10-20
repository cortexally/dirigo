# Dirigo — УДАЛЁННАЯ УСТАНОВКА НА WINDOWS (V4-3).
# Вызывается демоном по ssh (powershell -Command "..."): src/deploy.ts выбирает
# скрипт по ОС удалёнки. Всё ставится без ручных шагов: Bun, движки, служба
# (Планировщик заданий при входе), токен доступа. Порт слушается на 127.0.0.1 —
# доступ через SSH-туннель или cloudflare tunnel.
#
# Переменные (передаёт deploy.ts):
#   DIRIGO_HOST_DIR   куда разложен код (C:\dirigo)
#   DIRIGO_PORT       порт демона (7271)
#   DIRIGO_PROXY      прокси для загрузок
#   DIRIGO_SERVICE_USER  пользователь службы (текущий)
#   DIRIGO_INSTALL_BUN   1 = ставить Bun
#   DIRIGO_ENGINES    "bin pkg" по строкам (пусто = дефолт)

$ErrorActionPreference = "Stop"

$HostDir = if ($env:DIRIGO_HOST_DIR) { $env:DIRIGO_HOST_DIR } else { "C:\dirigo" }
$Port = if ($env:DIRIGO_PORT) { $env:DIRIGO_PORT } else { "7271" }
$EnginesDir = if ($env:ENGINES_DIR) { $env:ENGINES_DIR } else { "$env:LOCALAPPDATA\dirigo-engines" }
$DataDir = if ($env:DIRIGO_DATA_DIR) { $env:DIRIGO_DATA_DIR } else { "$env:LOCALAPPDATA\dirigo" }
$ProjectsDir = "$env:USERPROFILE\dirigo-projects"
$EnvFile = "$HostDir\dirigo-server.env"
$TaskName = "DirigoServer"

function Step($m) { Write-Output "==> $m" }
function Fail($m) { Write-Output "ОШИБКА: $m"; exit 1 }

if (-not (Test-Path $HostDir)) { Fail "каталог $HostDir пуст — код не загружен (scp)." }

if ($env:DIRIGO_PROXY) {
  $env:http_proxy = $env:DIRIGO_PROXY; $env:https_proxy = $env:DIRIGO_PROXY
  $env:HTTP_PROXY = $env:DIRIGO_PROXY; $env:HTTPS_PROXY = $env:DIRIGO_PROXY
  $env:no_proxy = "127.0.0.1,localhost"; $env:NO_PROXY = "127.0.0.1,localhost"
  Step "Прокси: $($env:DIRIGO_PROXY.Split(':')[0])://***"
}

# --- Bun ---
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  if ($env:DIRIGO_INSTALL_BUN -ne "0") {
    Step "Bun"
    try { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install | iex" | Out-Null } catch { Fail "Bun не установился: $_" }
    $env:Path += ";$env:USERPROFILE\.bun\bin"
  }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail "Bun не найден — без него демон не запустится." }
Step "bun $((bun --version))"

# --- зависимости демона ---
Step "Зависимости демона (bun install)"
Push-Location $HostDir
if (-not (Test-Path "package.json")) { Pop-Location; Fail "рядом с кодом нет package.json." }
try { bun install --production 2>&1 | Out-Null } catch { Pop-Location; Fail "bun install: $_" }
Pop-Location

# --- движки ---
$EngineTimeout = 600
New-Item -ItemType Directory -Path $EnginesDir -Force | Out-Null
$env:npm_config_prefix = $EnginesDir
$env:Path = "$EnginesDir;$env:Path"

function Install-Engine($bin, $pkg) {
  if (Test-Path "$EnginesDir\$bin.cmd") { Write-Output "  $bin`: уже стоит"; return }
  if (Get-Command $bin -ErrorAction SilentlyContinue) { Write-Output "  $bin`: уже стоит (в PATH)"; return }
  try {
    npm install -g --no-audit --no-fund --loglevel=error --allow-scripts="$pkg" "$pkg" 2>&1 | Out-Null
  } catch { Write-Output "ВНИМАНИЕ: $pkg не встал — почти всегда это прокси." }
}

if (-not $env:DIRIGO_ENGINES) {
  $env:DIRIGO_ENGINES = "claude @anthropic-ai/claude-code`ncodex @openai/codex`ncopilot @github/copilot`ngemini @google/gemini-cli`nopencode opencode-ai`nkilo @kilocode/cli`nmcode @minimax-ai/code"
}
Step "Движки"
foreach ($line in ($env:DIRIGO_ENGINES -split "`n")) {
  $parts = $line.Trim() -split "\s+"
  if ($parts.Count -eq 2) { Install-Engine $parts[0] $parts[1] }
}
foreach ($bin in @("claude","codex","copilot","gemini","opencode","kilo","mcode")) {
  if (Get-Command $bin -ErrorAction SilentlyContinue) { Write-Output "  $bin`: есть" } else { Write-Output "  $bin`: НЕТ" }
}

# --- окружение ---
if (-not (Test-Path $EnvFile)) {
  $token = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) })
  @"
NODE_ENV=production
DIRIGO_SERVER_MODE=1
DIRIGO_PORT=$Port
# Только loopback: доступ через SSH-туннель или cloudflare.
DIRIGO_BIND_HOST=127.0.0.1
DIRIGO_DATA_DIR=$DataDir
DIRIGO_PROJECTS_DIR=$ProjectsDir
# Токен доступа (DIRIGO_TOKEN в UI/CLI).
DIRIGO_TOKEN=$token
"@ | Set-Content -Path $EnvFile -Encoding utf8
  Step "создан $EnvFile"
}
if ($env:DIRIGO_PROXY) {
  (Get-Content $EnvFile) -replace '^DIRIGO_PROXY=.*$', "DIRIGO_PROXY=$env:DIRIGO_PROXY" | Set-Content $EnvFile -Encoding utf8
}

# --- служба: Планировщик заданий (старт при входе пользователя) ---
Step "Служба (Планировщик заданий)"
$bunBin = (Get-Command bun).Source
$action = New-ScheduledTaskAction -Execute $bunBin -Argument "run src/server.ts" -WorkingDirectory $HostDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
} catch { Fail "не удалось зарегистрировать задачу: $_" }
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName

# --- пробer ---
Step "Проверка"
$health = $null
foreach ($i in 1..30) {
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 } catch { Start-Sleep -Seconds 1 }
  if ($health) { break }
}
if (-not $health) { Fail "служба не отвечает на /api/health — смотри логи задачи $TaskName." }
Write-Output ($health | ConvertTo-Json -Compress)
Write-Output "Каталог проектов на сервере: $ProjectsDir"
Write-Output "Наружу порт не открыт: доступ — SSH-туннелем (v2 machines) или cloudflare (v2 tunnel)."
Write-Output "DIRIGO_RESULT_PORT=$Port"
Write-Output "DIRIGO_RESULT_TOKEN=$((Get-Content $EnvFile) -match '^DIRIGO_TOKEN=(.+)$' | Out-Null; if ($matches) { $matches[1] } else { '' })"
