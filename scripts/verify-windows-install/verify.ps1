# Uniterra Windows install-flow verification (runs on windows-latest).
#
# The Windows counterpart of scripts/verify-cli-container: replays what
# `uniterra setup` does on a user's Windows machine, against the checked-out
# source:
#   1. pnpm install --frozen-lockfile + workspace build on Windows.
#   2. The runtime dependencies the packaged Electron shell resolves are
#      present (dsh CLI, bundled skills, provider bundle).
#   3. The REAL CLI (`uniterra setup --source <checkout> --no-open`) packages
#      with electron-builder --win --dir, embeds the source under
#      resources/src, installs to %LOCALAPPDATA%\Programs\Uniterra, and writes
#      the Start Menu shortcut.
#   4. Boot smoke: the installed Uniterra.exe starts, dsh reaches readiness, and
#      http://127.0.0.1:3080 answers HTTP 2xx.
$ErrorActionPreference = 'Stop'

function Step([string]$Name) {
  Write-Host "`n==> $Name" -ForegroundColor Cyan
}
function Ok([string]$Message) {
  Write-Host "ok: $Message" -ForegroundColor Green
}
function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$env:CI = 'true'

# Defender real-time scanning locks freshly copied files and fails the
# installer's same-volume rename with EPERM. Best-effort exclusions (the
# runner is admin; a managed AV may still reject them).
try {
  Add-MpPreference -ExclusionPath $RepoRoot -ErrorAction Stop
  Add-MpPreference -ExclusionPath $env:TEMP -ErrorAction Stop
  Write-Host 'defender exclusions added for repo root and TEMP'
} catch {
  Write-Host 'defender exclusions skipped (not applicable): continuing'
}

Step '1/8 pnpm install --frozen-lockfile (Windows)'
# CI=true mirrors what the uniterra CLI passes (the app's updater has no TTY);
# it also stops pnpm 11's confirmModulesPurge prompt from aborting.
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed — the exact command the uniterra CLI runs on a user machine.' }
Ok 'install exited 0'

Step '2/8 workspace build'
pnpm run build
if ($LASTEXITCODE -ne 0) { Fail 'pnpm run build failed' }
Ok 'build exited 0'

Step '3/8 dsh CLI resolvable at the path main.ts uses'
$DshCli = Join-Path $RepoRoot 'packages\uniterra-desktop\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $DshCli)) { Fail "dsh CLI missing at $DshCli — the Electron shell (dshCliPath) cannot start." }
Ok "dsh bin present: $DshCli"

Step '4/8 bundled skills copied to dist'
$SkillsDir = Join-Path $RepoRoot 'packages\uniterra-skills\dist\skills'
if (-not (Test-Path $SkillsDir)) { Fail 'dist/skills missing' }
$SkillCount = (Get-ChildItem $SkillsDir -Directory).Count
if ($SkillCount -lt 6) { Fail "expected >=6 bundled skills, got $SkillCount" }
Ok "dist/skills has $SkillCount skills"

Step '5/8 workspace built-in bundle produced by the build'
# The workspace built-in's host entry is an esbuild artifact of the provider's
# own build; without it, the app copies a broken package into the dsh profile
# and boot dies with ERR_MODULE_NOT_FOUND (the v0.6.0 blank-app regression).
$ProviderBundle = Join-Path $RepoRoot 'packages\uniterra-provider\lib\index.js'
if (-not (Test-Path $ProviderBundle)) { Fail "provider bundle missing at $ProviderBundle" }
Ok 'provider bundle present'

Step '6/8 uniterra setup --source (real CLI: package, embed, install, shortcut)'
$CliEntry = Join-Path $RepoRoot 'packages\uniterra-cli\dist\cli.js'
node $CliEntry setup --source $RepoRoot --no-open
if ($LASTEXITCODE -ne 0) { Fail 'uniterra setup --source failed' }
Ok 'uniterra setup installed'

Step '7/8 installed layout: Uniterra.exe + embedded source + Start Menu shortcut'
$InstalledDir = Join-Path $env:LOCALAPPDATA 'Programs\Uniterra'
$InstalledExe = Join-Path $InstalledDir 'Uniterra.exe'
if (-not (Test-Path $InstalledExe)) { Fail "Uniterra.exe missing at $InstalledExe" }
$EmbeddedDsh = Join-Path $InstalledDir 'resources\src\packages\uniterra-desktop\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $EmbeddedDsh)) { Fail "embedded source missing dsh CLI at $EmbeddedDsh" }
# dshCliPath() on Windows resolves through the .pnpm store (robocopy
# materializes junctions, so the junction path can't resolve dsh's own deps).
$StoreDsh = Get-ChildItem (Join-Path $InstalledDir 'resources\src\node_modules\.pnpm') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '@deepseek-ai+dsh@*' } |
  ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js' } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $StoreDsh) { Fail 'embedded .pnpm store missing the dsh CLI (dshCliPath store resolution)' }
$Shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Uniterra.lnk'
if (-not (Test-Path $Shortcut)) { Fail "Start Menu shortcut missing at $Shortcut" }
Ok 'Uniterra.exe, embedded source (.pnpm store), and Start Menu shortcut present'

Step '8/8 boot smoke: installed app reaches readiness'
$BootHome = Join-Path $env:TEMP ('uniterra-boot-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $BootHome | Out-Null
$StdoutLog = Join-Path $BootHome 'uniterra.stdout.log'
$StderrLog = Join-Path $BootHome 'uniterra.stderr.log'
# The packaged app runs the dsh CLI against the DSH_HOME it inherits; a fresh
# home keeps the smoke test off the runner user's real ~/.dsh.
$env:DSH_HOME = $BootHome
# The startup update check must not fire (or prompt) during the smoke test.
$env:UNITERRA_UPDATE_DELAY_MS = '3600000'
$Process = Start-Process -FilePath $InstalledExe -PassThru `
  -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog
$Deadline = (Get-Date).AddMinutes(3)
$Ready = $false
try {
  while ((Get-Date) -lt $Deadline) {
    if ($Process.HasExited) { break }
    try {
      $Response = Invoke-WebRequest -Uri 'http://127.0.0.1:3080' -TimeoutSec 3 -UseBasicParsing
      if ($Response.StatusCode -eq 200) { $Ready = $true; break }
    } catch {
      # not ready yet — poll again
    }
    Start-Sleep -Seconds 3
  }
  if (-not $Ready) {
    Write-Host '--- app stdout ---'
    if (Test-Path $StdoutLog) { Get-Content $StdoutLog -Tail 40 }
    Write-Host '--- app stderr ---'
    if (Test-Path $StderrLog) { Get-Content $StderrLog -Tail 40 }
    Fail 'installed app did not reach readiness within 3 minutes'
  }
  Ok 'app booted and readiness URL answered HTTP 200'
} finally {
  if (-not $Process.HasExited) {
    # Terminate the whole tree: the dsh child must not hold the port.
    taskkill /PID $Process.Id /T /F | Out-Null
  }
  Remove-Item -Recurse -Force $BootHome -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'ALL WINDOWS INSTALL CHECKS PASSED' -ForegroundColor Green
