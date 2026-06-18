param(
    [string]$dllPath = "LibreHardwareMonitorLib.dll",
    [int]$intervalMs = 1000,
    [int]$durationSec = 0
)

# Configure TLS security and load LibreHardwareMonitor assembly
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (!(Test-Path -Path $dllPath -PathType Leaf)) {
    Write-Error "Could not find LibreHardwareMonitorLib.dll at: $dllPath"
    Exit 1
}

Add-Type -LiteralPath $dllPath

# Initialize and open connection to hardware sensors
$computer = New-Object LibreHardwareMonitor.Hardware.Computer
$computer.IsCpuEnabled = $true
$computer.IsGpuEnabled = $true
$computer.Open()

$startTime = Get-Date

try {
    while ($true) {
        if ($durationSec -gt 0 -and ((Get-Date) - $startTime).TotalSeconds -ge $durationSec) {
            break
        }

        # Query and update all sensors
        foreach ($hw in $computer.Hardware) {
            $hw.Update()
            foreach ($sub in $hw.SubHardware) {
                $sub.Update()
            }
        }

        $cpuTemp = $null
        $gpuTemp = $null

        # Traverse hardware structure to find CPU and GPU temperatures
        foreach ($hw in $computer.Hardware) {
            if ($hw.HardwareType -eq 'Cpu') {
                foreach ($sensor in $hw.Sensors) {
                    # Favor Core package, Core Max, or Average CPU temp
                    if ($sensor.SensorType -eq 'Temperature' -and ($sensor.Name -match 'Package' -or $sensor.Name -match 'Core Max' -or $sensor.Name -match 'Average')) {
                        $cpuTemp = $sensor.Value
                    }
                }
            }
            if ($hw.HardwareType -match 'Gpu') {
                foreach ($sensor in $hw.Sensors) {
                    if ($sensor.SensorType -eq 'Temperature' -and $sensor.Name -match 'Core') {
                        $gpuTemp = $sensor.Value
                    }
                }
            }
        }

        # Fallback to generic CPU sensor if package temp is unavailable
        if ($null -eq $cpuTemp) {
            foreach ($hw in $computer.Hardware) {
                if ($hw.HardwareType -eq 'Cpu') {
                    foreach ($sensor in $hw.Sensors) {
                        if ($sensor.SensorType -eq 'Temperature') {
                            $cpuTemp = $sensor.Value
                            break
                        }
                    }
                }
            }
        }

        # Fallback to generic GPU sensor if GPU core is unavailable
        if ($null -eq $gpuTemp) {
            foreach ($hw in $computer.Hardware) {
                if ($hw.HardwareType -match 'Gpu') {
                    foreach ($sensor in $hw.Sensors) {
                        if ($sensor.SensorType -eq 'Temperature') {
                            $gpuTemp = $sensor.Value
                            break
                        }
                    }
                }
            }
        }

        # Package current readings as a compact JSON object and print
        $output = @{
            cpuTemp = if ($null -ne $cpuTemp) { [Math]::Round($cpuTemp, 1) } else { $null }
            gpuTemp = if ($null -ne $gpuTemp) { [Math]::Round($gpuTemp, 1) } else { $null }
        }
        Write-Output ($output | ConvertTo-Json -Compress)

        Start-Sleep -Milliseconds $intervalMs
    }
}
finally {
    $computer.Close()
}
