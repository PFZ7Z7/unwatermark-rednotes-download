# stop.ps1 - Stop xhs-clone services (backend :3001, frontend :5173/:5174)

$ErrorActionPreference = 'Continue'

function Stop-PortListener {
    param(
        [int]$Port,
        [string]$Label = ''
    )

    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) {
        Write-Host "  [$Port] $Label - idle" -ForegroundColor DarkGray
        return
    }

    $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($procId in $procIds) {
        try {
            $proc = Get-Process -Id $procId -ErrorAction Stop
            Write-Host "  [$Port] $Label -> PID $procId ($($proc.ProcessName)) kill..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "  [$Port] OK" -ForegroundColor Green
        } catch {
            $msg = $_.Exception.Message
            Write-Host "  [$Port] FAIL: $msg" -ForegroundColor Red
        }
    }
}

Write-Host ''
Write-Host '=== Stop xhs-clone services ===' -ForegroundColor Cyan

Stop-PortListener -Port 3001 -Label 'backend'
Stop-PortListener -Port 5173 -Label 'frontend'
Stop-PortListener -Port 5174 -Label 'frontend-drift'

Write-Host '=== Done ===' -ForegroundColor Green
Write-Host ''
