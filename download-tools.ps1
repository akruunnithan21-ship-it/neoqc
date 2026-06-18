$ErrorActionPreference = "Stop"

$diagnosticsDir = Join-Path $PSScriptRoot "assets\diagnostics"
if (!(Test-Path -Path $diagnosticsDir)) {
    New-Item -ItemType Directory -Path $diagnosticsDir | Out-Null
}

$tools = @(
    @{
        name = "LibreHardwareMonitor"
        url = "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip"
        destFolder = "LibreHardwareMonitor"
        checkFile = "LibreHardwareMonitorLib.dll"
    },
    @{
        name = "FurMark"
        url = "https://geeks3d.com/dl/get/830"
        destFolder = "FurMark"
        checkFile = "FurMark_win64\FurMark.exe"
    },
    @{
        name = "Cinebench"
        url = "https://installer.maxon.net/cinebench/CinebenchR23.zip"
        destFolder = "Cinebench"
        checkFile = "Cinebench.exe"
    }
)

foreach ($tool in $tools) {
    $outDir = Join-Path $diagnosticsDir $tool.destFolder
    $checkPath = Join-Path $outDir $tool.checkFile
    
    if (Test-Path -Path $checkPath) {
        Write-Host "$($tool.name) already exists. Skipping."
        continue
    }

    $zipPath = Join-Path $diagnosticsDir "$($tool.name).zip"
    
    Write-Host "Downloading $($tool.name) from $($tool.url) ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    
    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    
    try {
        $webClient.DownloadFile($tool.url, $zipPath)
        Write-Host "Downloaded. Extracting..."
        
        if (Test-Path -Path $outDir) {
            Remove-Item -Path $outDir -Recurse -Force
        }
        New-Item -ItemType Directory -Path $outDir | Out-Null
        
        # Extract archive natively
        Expand-Archive -Path $zipPath -DestinationPath $outDir -Force
        Write-Host "Extracted successfully."
    }
    catch {
        Write-Error "Failed to process $($tool.name): $_"
        if (Test-Path -Path $zipPath) { Remove-Item -Path $zipPath -Force }
        throw $_
    }
    finally {
        if (Test-Path -Path $zipPath) { Remove-Item -Path $zipPath -Force }
    }
}

Write-Host "All diagnostics tools ready in assets/diagnostics!"
