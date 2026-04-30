# restart.ps1 - Restart xhs-clone services (= stop + start)

& (Join-Path $PSScriptRoot 'stop.ps1')
Start-Sleep -Seconds 1
& (Join-Path $PSScriptRoot 'start.ps1')
