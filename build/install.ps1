# Dirigo - one-command install (Windows, PowerShell).
#
#   irm https://dirigo.cortexally.ai/install.ps1 | iex
#
# ASCII ONLY, NO BOM. `irm | iex` keeps a UTF-8 BOM as a U+FEFF character in front of
# the first line, and the parser then reads the first comment as a command ("Missing
# argument in parameter list"). Without non-ASCII text the file also runs as a file in
# Windows PowerShell 5.1 (which reads BOM-less files as ANSI). Checked by
# scripts/install-security-review.ts and scripts/make-deploy.ts.
#
# What it does:
#   1. Checks/installs Bun.
#   2. Downloads dirigo-<ver>.tar.gz from BASE_URL.
#   3. Verifies SHA256.
#   4. Unpacks into %USERPROFILE%\.dirigo (or $env:DIRIGO_INSTALL_DIR).
#   5. Creates shortcuts "Dirigo" and "Stop Dirigo" (Start menu; "Dirigo" also on the
#      desktop; none with $env:DIRIGO_NO_SHORTCUTS=1).
#   6. Starts Dirigo -> http://127.0.0.1:7171 (first-run wizard).
#
# Later: start - "Dirigo" shortcut (or %USERPROFILE%\.dirigo\current\run.bat),
# stop - "Stop Dirigo" shortcut (stop.bat) or close the Dirigo window.
#
# Security: SHA256 check is mandatory (skip only with DIRIGO_SKIP_VERIFY=1, on purpose);
# the bundle is downloaded over https only; installs into the user profile only;
# writes nothing system-wide.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
# the progress bar in PS 5.1 slows Invoke-WebRequest down by an order of magnitude
$ProgressPreference = "SilentlyContinue"

# force TLS 1.2+: PowerShell 5.1 may offer TLS 1.0 by default
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13 } catch {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
}

# --- configuration ---
$BaseUrl = "https://dirigo.cortexally.ai"
if ($env:DIRIGO_BASE_URL) { $BaseUrl = $env:DIRIGO_BASE_URL }
$Version = "latest"
if ($env:DIRIGO_VERSION) { $Version = $env:DIRIGO_VERSION }
$InstallDir = Join-Path $env:USERPROFILE ".dirigo"
if ($env:DIRIGO_INSTALL_DIR) { $InstallDir = $env:DIRIGO_INSTALL_DIR }
$Port = "7171"
if ($env:PORT) { $Port = $env:PORT }

function Say($m, $ForegroundColor) { if ($ForegroundColor) { Write-Host $m -ForegroundColor $ForegroundColor } else { Write-Host $m } }
function Step($m) { Write-Host ("[>] " + $m) -ForegroundColor Cyan }
function Ok($m) { Write-Host ("[+] " + $m) -ForegroundColor Green }
function Die($m) { Write-Host ("[x] " + $m) -ForegroundColor Red; exit 1 }

# --- guard: https is required (except loopback, for local checks) ---
function Test-HttpsOrLoopback($url) {
    if ($url -like "https://*") { return $true }
    if ($url -like "http://127.0.0.1:*" -or $url -like "http://localhost:*" -or $url -like "http://[::1]:*") { return $true }
    return $false
}
if (-not (Test-HttpsOrLoopback $BaseUrl)) {
    Die ("DIRIGO_BASE_URL must be https:// (got: " + $BaseUrl + ") - otherwise the bundle can be swapped in transit")
}

# --- 1. Bun ---
function Ensure-Bun {
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if ($bun) {
        Ok ("bun found: " + (bun --version))
        return
    }
    Step "Bun not found - running the official installer"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path (Join-Path $bunDir "bun.exe")) {
        $env:Path = $env:Path + ";" + $bunDir
    } elseif (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Die "bun was not installed - check the network and try again"
    }
    Ok ("bun installed: " + (bun --version))
}

# --- 2. Download ---
function Get-Bundle {
    # Release artifacts live in $BaseUrl/releases/; the site root is a fallback
    # for the old layout. DIRIGO_RELEASES_URL - explicit path.
    # CDN (Cloudflare) may serve a stale copy of a file republished under the same name:
    # the manifest and checksums are fetched with a unique query (bypasses the cache), and
    # the bundle URL carries its expected SHA256 - a new bundle is a new cache key, so the
    # bundle and SHA256SUMS can never come from different builds.
    $nocache = "?t=" + [DateTime]::UtcNow.Ticks
    $candidates = @(($BaseUrl + "/releases"), $BaseUrl)
    if ($env:DIRIGO_RELEASES_URL) { $candidates = @($env:DIRIGO_RELEASES_URL.TrimEnd("/")) }
    $script:RelUrl = $null
    $lastErr = $null
    foreach ($c in $candidates) {
        if (-not (Test-HttpsOrLoopback $c)) { Die ("release URL must be https:// (got: " + $c + ")") }
        try {
            $manifest = Invoke-RestMethod -Uri ($c + "/latest.json" + $nocache) -TimeoutSec 15 -UseBasicParsing
            $script:RelUrl = $c
            break
        } catch { $lastErr = $_ }
    }
    if (-not $script:RelUrl) { Die ("latest.json not found (" + ($candidates -join ", ") + "): " + $lastErr) }
    if ($script:Version -eq "latest") {
        if (-not $manifest.version) { Die ("latest.json has no version field: " + $script:RelUrl + "/latest.json") }
        $script:Version = [string]$manifest.version
    }
    $Version = $script:Version
    Ok ("version: " + $Version + " (" + $script:RelUrl + ")")
    $script:BundleUrl = $script:RelUrl + "/dirigo-" + $Version + ".tar.gz"
    $script:Tmp = Join-Path $env:TEMP ("dirigo-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
    $script:BundlePath = Join-Path $Tmp "bundle.tar.gz"

    # SHA256SUMS first (mandatory unless explicitly skipped): its value keys the download
    $sumsPath = Join-Path $Tmp "SHA256SUMS"
    $expected = $null
    try {
        Invoke-WebRequest -Uri ($script:RelUrl + "/SHA256SUMS" + $nocache) -OutFile $sumsPath -TimeoutSec 15 -UseBasicParsing
        $expected = Get-Content $sumsPath |
            Where-Object { $_ -match ("dirigo-" + $Version + "\.tar\.gz") } |
            ForEach-Object { ($_ -split "\s+")[0] } | Select-Object -First 1
        if (-not $expected) { Die "SHA256SUMS has no line for this bundle" }
    } catch {
        if ($env:DIRIGO_SKIP_VERIFY -eq "1") {
            Say "  ! DIRIGO_SKIP_VERIFY=1 - checksum skipped at your request (risk of tampering)"
        } else {
            Die ("checksum unavailable - install stopped. Try later, or DIRIGO_SKIP_VERIFY=1 (at your own risk): " + $_)
        }
    }
    $query = $nocache
    if ($expected) { $query = "?sha256=" + $expected.ToLower() }
    Step ("Downloading " + $BundleUrl)
    try {
        Invoke-WebRequest -Uri ($BundleUrl + $query) -OutFile $BundlePath -TimeoutSec 120 -UseBasicParsing
    } catch {
        Die ("bundle download failed: " + $_)
    }
    Ok ("downloaded: " + (Get-Item $BundlePath).Length + " bytes")

    if ($expected) {
        Step "Verifying SHA256 checksum"
        $actual = (Get-FileHash $BundlePath -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) {
            Die ("SHA256 mismatch - the bundle is damaged or tampered with. Install stopped. Expected: " + $expected + " Got: " + $actual)
        }
        Ok "checksum OK"
    }
}

# --- 2.5. Dirigo already running ---
# Updating over a running daemon: Windows will not rename a folder a process works in,
# and the new version would fail on a busy port. Stop only Dirigo (checked via
# /api/health), together with its agents.
function Stop-Running {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return }
    $isDirigo = $false
    try {
        $h = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/api/health") -TimeoutSec 3 -UseBasicParsing
        $isDirigo = [bool]$h.ok -and ($null -ne $h.agents)
    } catch { }
    if (-not $isDirigo) { Die ("port " + $Port + " is used by another program. Pick a free one: `$env:PORT=7272; irm " + $BaseUrl + "/install.ps1 | iex") }
    Step ("Stopping the running Dirigo (pid " + $c.OwningProcess + ") - update")
    & taskkill /PID $c.OwningProcess /T /F 2>&1 | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
}

# --- 3. Unpack ---
# User data (data: projects, sessions, keys, copies) lives in current\data.
# It moves into the new version; the old one is removed only after that.
function Unpack {
    Step ("Unpacking into " + $InstallDir)
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $unpack = Join-Path $InstallDir (".unpack-" + $PID)
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    New-Item -ItemType Directory -Path $unpack -Force | Out-Null
    # Windows built-in tar.exe (bsdtar), not the first one in PATH: GNU tar from Git for
    # Windows treats "C:" in a path as a remote host ("Cannot connect to C:").
    $tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
    if (-not (Test-Path $tarExe)) { $tarExe = "tar" }
    & $tarExe -xzf $script:BundlePath -C $unpack
    if ($LASTEXITCODE -ne 0) { Die "the archive did not unpack (tar returned an error)" }
    $src = Get-ChildItem $unpack -Directory | Select-Object -First 1
    if (-not $src) { Die "no folder inside the archive" }
    $old = Join-Path $InstallDir (".old-" + $PID)
    $current = Join-Path $InstallDir "current"
    if (Test-Path $current) {
        try { Move-Item $current $old -Force -ErrorAction Stop }
        catch { Die ("cannot replace " + $current + " - close programs that have this folder open (Explorer, editor, terminal) and try again. " + $_) }
    }
    Move-Item $src.FullName $current
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
    # the downloaded bundle is no longer needed
    if ($script:Tmp -and (Test-Path $script:Tmp)) { Remove-Item $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue }
    $keepOld = $false
    $oldData = Join-Path $old "data"
    if (Test-Path $oldData) {
        $newData = Join-Path $current "data"
        try {
            if (Test-Path $newData) { Remove-Item $newData -Recurse -Force -ErrorAction Stop }
            Move-Item $oldData $newData -ErrorAction Stop
            Ok "data kept: projects, sessions, keys"
        } catch {
            $keepOld = $true
            Say ("  ! data was not moved automatically: " + $_) -ForegroundColor Yellow
            Say ("  ! it is intact in " + $oldData + " - move the data folder into " + $current) -ForegroundColor Yellow
        }
    }
    if ((Test-Path $old) -and -not $keepOld) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    Ok ("installed: " + $current)
}

# --- 3.5. Dependencies ---
# node-pty (agent terminal) is optional, with prebuilt binaries for Windows.
# Without it Dirigo works; only the Terminal mode is unavailable.
function Install-Deps {
    $current = Join-Path $InstallDir "current"
    if (-not (Test-Path (Join-Path $current "package.json"))) { return }
    Step "Installing dependencies (agent terminal)"
    Push-Location $current
    try {
        & bun install --production --silent 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "dependencies ready" }
        else { Say "  ! node-pty did not install - Dirigo works; Terminal mode turns on after: bun install in $current" -ForegroundColor Yellow }
    } finally { Pop-Location }
}

# --- 4. Shortcuts ---
# The user must find start and stop without this console: shortcuts point to
# current\run.bat / stop.bat - the path survives updates. User profile only
# (Start menu and desktop), no admin rights. Names are ASCII: WScript.Shell cannot
# save a shortcut with Cyrillic in its name.
function New-Shortcut($Path, $Target, $Description) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.WorkingDirectory = Split-Path -Parent $Target
    $lnk.Description = $Description
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
    $lnk.Save()
}
function Add-Shortcuts {
    if ($env:DIRIGO_NO_SHORTCUTS -eq "1") { return }
    $current = Join-Path $InstallDir "current"
    try {
        # DIRIGO_SHORTCUT_DIR - one folder for all shortcuts (tests: keep the user's Start menu intact)
        $menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Dirigo"
        $desk = [Environment]::GetFolderPath("Desktop")
        if ($env:DIRIGO_SHORTCUT_DIR) { $menu = $env:DIRIGO_SHORTCUT_DIR; $desk = $env:DIRIGO_SHORTCUT_DIR }
        New-Item -ItemType Directory -Path $menu -Force | Out-Null
        New-Shortcut (Join-Path $menu "Dirigo.lnk") (Join-Path $current "run.bat") "Start Dirigo (control panel for AI coding agents)"
        New-Shortcut (Join-Path $menu "Stop Dirigo.lnk") (Join-Path $current "stop.bat") "Stop Dirigo and its agent sessions"
        New-Shortcut (Join-Path $desk "Dirigo.lnk") (Join-Path $current "run.bat") "Start Dirigo (control panel for AI coding agents)"
        Ok "shortcuts: Start menu -> Dirigo (Dirigo, Stop Dirigo), desktop -> Dirigo"
    } catch { Say ("  ! shortcuts not created: " + $_.Exception.Message + " - start with: " + (Join-Path $current "run.bat")) -ForegroundColor Yellow }
}

# --- 5. Start ---
# Through run.bat - the same path as the shortcut: log in data\dirigo.log, pid for
# stop.bat, the browser opens once Dirigo answers.
function Launch {
    $current = Join-Path $InstallDir "current"
    Say ""
    Say ("Dirigo v" + $Version + " installed.") -ForegroundColor Green
    Say ("  Open:         http://127.0.0.1:" + $Port)
    Say ("  Installed in: " + $current + "   (data: " + (Join-Path $current "data") + ")")
    Say  "  Start:        ""Dirigo"" shortcut (Start menu / desktop) or run.bat in that folder"
    Say  "  Stop:         ""Stop Dirigo"" shortcut (stop.bat) or close the Dirigo window"
    Say ("  Update:       irm " + $BaseUrl + "/install.ps1 | iex   (data is kept)")
    Say ""
    $env:DIRIGO_PORT = $Port
    # DIRIGO_NO_BROWSER=1 - no browser (server, CI, scheduled update)
    if ($env:DIRIGO_NO_BROWSER -eq "1") { $env:DIRIGO_NO_OPEN = "1" }
    & cmd /c (Join-Path $current "run.bat")
}

# --- main ---
Say "Dirigo - Windows installer" -ForegroundColor Cyan
Ensure-Bun
Get-Bundle
Stop-Running
Unpack
Install-Deps
Add-Shortcuts
Launch
