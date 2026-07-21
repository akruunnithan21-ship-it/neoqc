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
# v1.8.0 — clock capture. CPU: prefer per-core clocks (report the FASTEST core
# each tick — that's the boost figure a customer cares about); GPU: core clock.
$gpuClockPriority = @('GPU Core', 'Core', 'GPU')

# v1.8.0 — last-resort CPU temp via ACPI thermal zone (root/wmi). Coarse (it's
# a board sensor near the socket, not Tctl) but REAL — used only when LHM sees
# no CPU temperature sensor at all (e.g. a CPU generation newer than the
# bundled LHM build understands). The JSON marks the source honestly.
$script:acpiThermalUsable = $true
function Get-AcpiCpuTemp {
    if (-not $script:acpiThermalUsable) { return $null }
    try {
        $tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
        if ($tz -and $tz.CurrentTemperature -gt 0) {
            $c = ($tz.CurrentTemperature / 10) - 273.15
            if ($c -gt 5 -and $c -lt 120) { return $c }
        }
    } catch { $script:acpiThermalUsable = $false }
    return $null
}

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
        $cpuClock = $null; $gpuClock = $null; $tempSource = 'lhm'
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
                # Fastest core clock this tick = the effective boost clock.
                foreach ($s in $hw.Sensors) {
                    if ($s.SensorType -eq 'Clock' -and $s.Name -notmatch 'Bus' -and $null -ne $s.Value) {
                        if ($null -eq $cpuClock -or $s.Value -gt $cpuClock) { $cpuClock = $s.Value }
                    }
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
                if ($null -eq $gpuClock) {
                    $s = Pick-Sensor $hw.Sensors $gpuClockPriority 'Clock'
                    if ($null -ne $s) { $gpuClock = $s.Value }
                }
            }
        }

        # Plausibility guards — LHM can report literal 0 for sensors it cannot
        # actually read (e.g. running without admin rights). A 0 °C CPU or a
        # 0 MHz clock is not a measurement; treat it as absent so it can never
        # drag the report's min values to zero.
        if ($null -ne $cpuTemp -and ($cpuTemp -le 5 -or $cpuTemp -gt 125)) { $cpuTemp = $null }
        if ($null -ne $gpuTemp -and ($gpuTemp -le 5 -or $gpuTemp -gt 125)) { $gpuTemp = $null }
        if ($null -ne $cpuClock -and $cpuClock -lt 100) { $cpuClock = $null }
        if ($null -ne $gpuClock -and $gpuClock -lt 50)  { $gpuClock = $null }

        # Honest fallback: if LHM has no CPU temp sensor on this silicon, use
        # the ACPI thermal zone rather than reporting nothing at all.
        if ($null -eq $cpuTemp) {
            $acpi = Get-AcpiCpuTemp
            if ($null -ne $acpi) { $cpuTemp = $acpi; $tempSource = 'acpi-thermal-zone' }
        }

        $output = [ordered]@{
            cpuTemp = if ($null -ne $cpuTemp) { [Math]::Round($cpuTemp, 1) } else { $null }
            gpuTemp = if ($null -ne $gpuTemp) { [Math]::Round($gpuTemp, 1) } else { $null }
            cpuLoad = if ($null -ne $cpuLoad) { [Math]::Round($cpuLoad, 1) } else { $null }
            gpuLoad = if ($null -ne $gpuLoad) { [Math]::Round($gpuLoad, 1) } else { $null }
            cpuClock = if ($null -ne $cpuClock) { [Math]::Round($cpuClock, 0) } else { $null }
            gpuClock = if ($null -ne $gpuClock) { [Math]::Round($gpuClock, 0) } else { $null }
            tempSource = $tempSource
        }
        Write-Output ($output | ConvertTo-Json -Compress)

        Start-Sleep -Milliseconds $intervalMs
    }
}
finally {
    $computer.Close()
}
