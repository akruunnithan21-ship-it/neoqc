# ssd_enumerate.ps1 — list every SSD volume with the info needed for a
# per-drive DiskSpd benchmark.
#
# Emits a JSON array of {drive, model, busType, sizeGB, freeGB, pcieGen,
# pcieWidth, expectedMBps}. One entry per volume backed by an SSD physical
# disk. If a physical SSD has multiple partitions, we return ONE entry per
# volume (the tech is benchmarking real-world drive letters, not the
# underlying disk).
#
# Separate from ssd_probe.ps1 — that one returns a single "primary" SSD
# object for the deep-dive card. This one returns every writable SSD volume
# so the benchmarker can iterate.

$ErrorActionPreference = 'SilentlyContinue'

$perLane = @{ 1 = 250; 2 = 500; 3 = 985; 4 = 1970; 5 = 3940 }

function Get-PcieLinkForDisk {
    param($disk)
    $out = @{ currentGen = $null; currentWidth = $null; expectedMBps = $null }
    try {
        if ($disk.BusType -ne 'NVMe') {
            # SATA III theoretical peak ~600 MB/s, realistic ~550.
            if ($disk.BusType -eq 'SATA') { $out.expectedMBps = 550 }
            return $out
        }
        $pnp = Get-PnpDevice -PresentOnly | Where-Object {
            $_.FriendlyName -eq $disk.FriendlyName -and ($_.Class -eq 'DiskDrive' -or $_.Class -eq 'SCSIAdapter')
        } | Select-Object -First 1
        if (-not $pnp) { return $out }
        $current = $pnp
        for ($i = 0; $i -lt 6; $i++) {
            $parentId = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_Device_Parent').Data
            if (-not $parentId) { break }
            if ($parentId -like 'PCI\*') {
                $current = Get-PnpDevice -InstanceId $parentId
                break
            }
            $current = Get-PnpDevice -InstanceId $parentId
        }
        if ($current.InstanceId -like 'PCI\*') {
            $curSpeed = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_CurrentLinkSpeed').Data
            $curWidth = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_CurrentLinkWidth').Data
            if ($curSpeed) { $out.currentGen = [int]$curSpeed }
            if ($curWidth) { $out.currentWidth = [int]$curWidth }
            if ($out.currentGen -and $out.currentWidth -and $perLane.ContainsKey($out.currentGen)) {
                $out.expectedMBps = [int]($perLane[$out.currentGen] * $out.currentWidth * 0.9)
            }
        }
    } catch {}
    return $out
}

try {
    $rows = @()
    $ssds = Get-PhysicalDisk | Where-Object { $_.MediaType -in @('SSD','NVMe SSD','SCM') }
    foreach ($disk in $ssds) {
        $link = Get-PcieLinkForDisk -disk $disk
        # Every writable NTFS volume on this physical disk.
        $partitions = Get-Partition -DiskNumber $disk.DeviceId -ErrorAction SilentlyContinue |
                      Where-Object { $_.DriveLetter }
        foreach ($p in $partitions) {
            $vol = Get-Volume -DriveLetter $p.DriveLetter -ErrorAction SilentlyContinue
            if (-not $vol) { continue }
            if ($vol.FileSystemType -ne 'NTFS' -and $vol.FileSystemType -ne 'ReFS') { continue }
            $rows += [PSCustomObject]@{
                drive        = "$($p.DriveLetter):"
                model        = $disk.FriendlyName
                busType      = $disk.BusType
                mediaType    = $disk.MediaType
                sizeGB       = [math]::Round($disk.Size / 1GB, 0)
                freeGB       = [math]::Round($vol.SizeRemaining / 1GB, 1)
                volumeLabel  = $vol.FileSystemLabel
                pcieGen      = $link.currentGen
                pcieWidth    = $link.currentWidth
                expectedMBps = $link.expectedMBps
            }
        }
    }
    # PS 5.1's `ConvertTo-Json` flattens a 1-element array to a bare object,
    # AND wrapping with `,$rows` produces `{value: [], Count: N}`. Emit the
    # JSON array manually so the JS consumer can always .forEach().
    if ($rows.Count -eq 0) {
        Write-Output '[]'
    } else {
        Write-Output ('[' + (($rows | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']')
    }
} catch {
    Write-Output ('{"error":"enumerate_failed","message":"' + ($_.Exception.Message -replace '"','\"') + '"}')
}
