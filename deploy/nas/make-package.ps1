<#
  Builds the folder to copy to the NAS: server.js, the service file, the README
  and site\ (dashboard\ exactly as committed on the current branch, so nothing
  half-edited is shipped).

    powershell -ExecutionPolicy Bypass -File deploy\nas\make-package.ps1
    powershell -ExecutionPolicy Bypass -File deploy\nas\make-package.ps1 -Out D:\somewhere\nas-tracker
#>
param(
  [string]$Out = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'nas-tracker')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force (Join-Path $Out 'site') | Out-Null

Copy-Item (Join-Path $PSScriptRoot 'server.js') $Out
Copy-Item (Join-Path $PSScriptRoot 'neo-tracker.service') $Out
Copy-Item (Join-Path $PSScriptRoot 'README.md') $Out

$tar = Join-Path $env:TEMP ('neo-tracker-' + [guid]::NewGuid().ToString('N') + '.tar')
git -C $repo archive --format=tar -o $tar HEAD dashboard
tar -xf $tar -C $Out
Remove-Item $tar
Move-Item (Join-Path $Out 'dashboard\*') (Join-Path $Out 'site')
Remove-Item (Join-Path $Out 'dashboard')

$sha = git -C $repo rev-parse --short HEAD
Set-Content -Encoding utf8 (Join-Path $Out 'site\VERSION.txt') ("tracker " + $sha + " built " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
Write-Host ("Package ready: " + $Out + " (commit " + $sha + ")")
