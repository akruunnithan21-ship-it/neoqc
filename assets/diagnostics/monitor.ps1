param(
    [string]$dllPath = "LibreHardwareMonitorLib.dll",
    [int]$intervalMs = 1000,
    [int]$durationSec = 0
)

# LibreHardwareMonitor sensor polling. Emits one compact JSON object per tick
# with cpuTemp / gpuTemp / cpuLoad / gpuLoad — the diagnostics UI + report
# consume this stream. Rewritten 2026-07-12: the old sensor-name regex was
# Intel-centric ("Package|Core Max|Average") and missed AMD Ryzen sensors
# entirely — a 9950X exposes CPU temp only as "Core (Tctl/Tdie)" or "CCD*", so
# the report's CPU sparkline stayed blank while the GPU one worked fine.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (!(Test-Path -Path $dllPath -PathType Leaf)) {
    Write-Error "Could not find LibreHardwareMonitorLib.dll at: $dllPath"
    Exit 1
}
Add-Type -LiteralPath $dllPath

$computer = New-Object LibreHardwareMonitor.Hardware.Computer
$computer.IsCpuEnabled = $true
$computer.IsGpuEnabled = $true
$computer.Open()

# Priority-ordered sensor-name patterns (first match wins). Covers Intel
# ("Package", "Core Max"), AMD Ryzen ("Core (Tctl/Tdie)", "Tctl", "Tdie",
# "CCD1"), Apple SoC ("CPU"), and generic naming. Case-insensitive by design.
$cpuTempPriority = @('Package', 'CPU Package', 'Core (Tctl/Tdie)', 'Tctl/Tdie', 'Tctl', 'Tdie', 'CCD1', 'Core Max', 'Core Average', 'Average', 'CPU Core', 'CPU')
$gpuTempPriority = @('GPU Hot Spot', 'Hot Spot', 'GPU Core', 'Core', 'GPU')
$cpuLoadPriority = @('CPU Total', 'Total', 'CPU Package', 'Core Max')
$gpuLoadPriority = @('GPU Core', 'Core', 'GPU')

function Pick-Sensor {
    param($sensors, [string[]]$priority, [string]$sensorType)
    foreach ($name in $priority) {
        foreach ($s in $sensors) {
            if ($s.SensorType -eq $sensorType -and $s.Name -like "*$name*" -and $null -ne $s.Value) {
                return $s
            }
        }
    }
    # Fallback: any sensor of the requested type with a real value.
    foreach ($s in $sensors) {
        if ($s.SensorType -eq $sensorType -and $null -ne $s.Value) { return $s }
    }
    return $null
}

# One-shot sensor inventory so the diagnostics log records exactly which
# sensors were seen on this machine — invaluable when temp isn't reading.
$inventory = @()
foreach ($hw in $computer.Hardware) {
    $hw.Update()
    foreach ($sub in $hw.SubHardware) { $sub.Update() }
    foreach ($s in $hw.Sensors) {
        $inventory += "$($hw.HardwareType)/$($s.SensorType)/$($s.Name)"
    }
}
Write-Output ('{"inventory":"' + ($inventory -join '|') + '"}')

$startTime = Get-Date
try {
    while ($true) {
        if ($durationSec -gt 0 -and ((Get-Date) - $startTime).TotalSeconds -ge $durationSec) { break }

        foreach ($hw in $computer.Hardware) {
            $hw.Update()
            foreach ($sub in $hw.SubHardware) { $sub.Update() }
        }

        $cpuTemp = $null; $gpuTemp = $null; $cpuLoad = $null; $gpuLoad = $null
        foreach ($hw in $computer.Hardware) {
            if ($hw.HardwareType -eq 'Cpu') {
                if ($null -eq $cpuTemp) {
                    $s = Pick-Sensor $hw.Sensors $cpuTempPriority 'Temperature'
                    if ($null -ne $s) { $cpuTemp = $s.Value }
                }
                if ($null -eq $cpuLoad) {
                    $s = Pick-Sensor $hw.Sensors $cpuLoadPriority 'Load'
                    if ($null -ne $s) { $cpuLoad = $s.Value }
                }
            }
            if ($hw.HardwareType -match 'Gpu') {
                if ($null -eq $gpuTemp) {
                    $s = Pick-Sensor $hw.Sensors $gpuTempPriority 'Temperature'
                    if ($null -ne $s) { $gpuTemp = $s.Value }
                }
                if ($null -eq $gpuLoad) {
                    $s = Pick-Sensor $hw.Sensors $gpuLoadPriority 'Load'
                    if ($null -ne $s) { $gpuLoad = $s.Value }
                }
            }
        }

        $output = [ordered]@{
            cpuTemp = if ($null -ne $cpuTemp) { [Math]::Round($cpuTemp, 1) } else { $null }
            gpuTemp = if ($null -ne $gpuTemp) { [Math]::Round($gpuTemp, 1) } else { $null }
            cpuLoad = if ($null -ne $cpuLoad) { [Math]::Round($cpuLoad, 1) } else { $null }
            gpuLoad = if ($null -ne $gpuLoad) { [Math]::Round($gpuLoad, 1) } else { $null }
        }
        Write-Output ($output | ConvertTo-Json -Compress)

        Start-Sleep -Milliseconds $intervalMs
    }
}
finally {
    $computer.Close()
}
