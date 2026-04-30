# start.ps1 - Start xhs-clone services (backend :3001 + frontend :5173)
# Usage:
#   .\scripts\start.ps1          # fail if port already in use
#   .\scripts\start.ps1 -Clean   # auto stop old processes first

param(
    [switch]$Clean
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

function Test-PortInUse {
    param([int]$Port)
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return ($conns.Count -gt 0)
}

Write-Host ''
Write-Host '=== Start xhs-clone services ===' -ForegroundColor Cyan

if ($Clean) {
    Write-Host '  -Clean: cleaning old processes...' -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'stop.ps1')
    Start-Sleep -Milliseconds 500
}

$conflict = $false
foreach ($p in 3001, 5173) {
    if (Test-PortInUse -Port $p) {
        Write-Host "  [ERR] port $p already in use" -ForegroundColor Red
        $conflict = $true
    }
}
if ($conflict) {
    Write-Host ''
    Write-Host '  fix:' -ForegroundColor Yellow
    Write-Host '    npm run stop                 # stop old processes first' -ForegroundColor Gray
    Write-Host '    npm run start:clean          # or auto-clean then start' -ForegroundColor Gray
    Write-Host ''
    exit 1
}

# --- start backend in a new window ---
$backendPath = Join-Path $root 'backend'
Write-Host '  starting backend  -> http://localhost:3001' -ForegroundColor Cyan
$beCmd = "Set-Location '$backendPath'; `$Host.UI.RawUI.WindowTitle='[xhs-backend :3001]'; npm run dev"
Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $beCmd

Start-Sleep -Seconds 2

# --- start frontend in a new window ---
$frontendPath = Join-Path $root 'frontend'
Write-Host '  starting frontend -> http://localhost:5173' -ForegroundColor Cyan
$feCmd = "Set-Location '$frontendPath'; `$Host.UI.RawUI.WindowTitle='[xhs-frontend :5173]'; npm run dev"
Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $feCmd

Write-Host ''
Write-Host '=== Started ===' -ForegroundColor Green
Write-Host '  frontend: http://localhost:5173' -ForegroundColor Gray
Write-Host '  backend : http://localhost:3001' -ForegroundColor Gray
Write-Host ''
Write-Host '  stop   : close the two windows, or run: npm run stop' -ForegroundColor DarkGray
Write-Host '  restart: npm run restart' -ForegroundColor DarkGray
Write-Host ''
