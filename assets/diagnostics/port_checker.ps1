param (
    [string]$Type
)

if ($Type -eq "usb") {
    $devices = Get-PnpDevice -PresentOnly -Class USB | Where-Object { $_.FriendlyName -and $_.FriendlyName -notmatch 'Controller|Root Hub|Composite|Generic|Virtual|Intel|AMD' } | Select-Object -ExpandProperty FriendlyName
    if (-not $devices) {
        $devices = Get-PnpDevice -PresentOnly -Class USB | Where-Object { $_.FriendlyName } | Select-Object -First 3 -ExpandProperty FriendlyName
    }
    if ($devices) {
        $devices = $devices | Select-Object -Unique
        Write-Output ($devices -join ";")
    } else {
        Write-Output "No active USB devices found"
    }
} elseif ($Type -eq "video") {
    $displays = Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceClass -eq "MONITOR" | Select-Object -ExpandProperty DeviceName
    if (-not $displays) {
        $displays = Get-CimInstance Win32_DesktopMonitor | Select-Object -ExpandProperty Name
    }
    if ($displays) {
        $displays = $displays | Select-Object -Unique
        Write-Output ($displays -join ";")
    } else {
        Write-Output "Standard Display Monitor"
    }
} elseif ($Type -eq "audio") {
    $audio = Get-CimInstance Win32_SoundDevice | Select-Object -ExpandProperty Name
    if (-not $audio) {
        $audio = Get-PnpDevice -PresentOnly -Class Media | Where-Object { $_.FriendlyName -and $_.FriendlyName -match 'Audio|Sound' } | Select-Object -ExpandProperty FriendlyName
    }
    if ($audio) {
        $audio = $audio | Select-Object -Unique
        Write-Output ($audio -join ";")
    } else {
        Write-Output "High Definition Audio Device"
    }
}
