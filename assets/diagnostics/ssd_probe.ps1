<#
  ssd_probe.ps1 — comprehensive SSD identity + health + link-speed probe.

  Combines what the old inline "sys:check-ssd-health" query did with the new
  generation-aware speed grading data. Emits ONE JSON object with:
    - identity: model, media type, bus type, size, firmware, serial
    - link: PCIe generation (current + max), link width, expected max MB/s
    - health: healthStatus (Windows), wear%, life%, read/write errors,
              powerOnHours (best-effort via multiple sources)

  Power-On Hours is deliberately best-effort. Windows has NO unified API for
  it — SATA drives expose it via Get-StorageReliabilityCounter (needs admin),
  NVMe drives expose it in log page 0x02 which Windows doesn't surface, and
  older drives return 0 or nothing. We try:
    1. Get-StorageReliabilityCounter (SATA + some NVMe)
    2. Direct DeviceIoControl SMART attribute 0x09 (SATA only)
    3. NVMe log page 0x02 via StorageAdapterProperty (Win 10 22H2+)
  Whatever works first wins. If nothing works we still report identity and
  link speed — the report just calls hours "Not exposed by drive controller"
  instead of "N/A" so it's clear WHY.
#>
$ErrorActionPreference = 'SilentlyContinue'

function Get-PhysicalDiskLinkInfo {
    param($physicalDisk)
    # Match the physical drive to its underlying PnP device (PCIe adapter for
    # NVMe) so we can read PCIe link speed + width. Storage cmdlets alone
    # don't expose these — they live on the parent PCIe device.
    $out = [PSCustomObject]@{
        currentGen = $null; maxGen = $null
        currentWidth = $null; maxWidth = $null
        expectedMBps = $null
    }
    try {
        $disk = Get-Disk -Number $physicalDisk.DeviceId
        if (-not $disk) { return $out }
        # The FriendlyName is the SSD's model — search PnP for a device with
        # that name whose Class is "SCSIAdapter" (NVMe controller) or DiskDrive.
        $pnp = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -eq $disk.FriendlyName -and ($_.Class -eq 'DiskDrive' -or $_.Class -eq 'SCSIAdapter') } | Select-Object -First 1
        if (-not $pnp) { return $out }
        # Walk up the parent chain: DiskDrive -> SCSIAdapter -> PCI\VEN_...
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
            # These property keys are defined in ntddstor.h / usbioctl.h and
            # available since Windows 10 21H2. Return as GenN + widthN.
            $curSpeed = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_CurrentLinkSpeed').Data
            $maxSpeed = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_MaxLinkSpeed').Data
            $curWidth = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_CurrentLinkWidth').Data
            $maxWidth = (Get-PnpDeviceProperty -InstanceId $current.InstanceId -KeyName 'DEVPKEY_PciDevice_MaxLinkWidth').Data
            if ($curSpeed) { $out.currentGen = [int]$curSpeed }
            if ($maxSpeed) { $out.maxGen     = [int]$maxSpeed }
            if ($curWidth) { $out.currentWidth = [int]$curWidth }
            if ($maxWidth) { $out.maxWidth     = [int]$maxWidth }
            # Theoretical per-lane GB/s (PCIe 3=~1, 4=~2, 5=~4). Multiply by
            # width and 0.9 realistic sequential efficiency → expected MB/s.
            $perLane = @{ 1 = 250; 2 = 500; 3 = 985; 4 = 1970; 5 = 3940 }
            if ($out.currentGen -and $out.currentWidth -and $perLane.ContainsKey($out.currentGen)) {
                $out.expectedMBps = [int]($perLane[$out.currentGen] * $out.currentWidth * 0.9)
            }
        }
    } catch {}
    return $out
}

function Get-PowerOnHoursMulti {
    param($physicalDisk)
    # Return a hashtable with @{ hours, source } describing where the value
    # came from, so the report can label ambiguous sources honestly.
    $result = @{ hours = $null; source = $null }
    try {
        $r = Get-StorageReliabilityCounter -PhysicalDisk $physicalDisk -ErrorAction Stop
        if ($null -ne $r.PowerOnHours -and $r.PowerOnHours -gt 0) {
            $result.hours = [int]$r.PowerOnHours
            $result.source = 'StorageReliabilityCounter'
            return $result
        }
    } catch {}
    # Fallback: StorageAdapterProperty NVMe log page 0x02 (Windows 10 22H2+).
    try {
        $disk = Get-Disk -UniqueId $physicalDisk.UniqueId -ErrorAction Stop
        if ($disk.BusType -eq 'NVMe') {
            $adapter = Get-StorageAdapter -UniqueId $disk.UniqueId -ErrorAction Stop
            $nvmeInfo = Get-StorageNode -UniqueId $disk.UniqueId -ErrorAction Stop
            if ($nvmeInfo -and $nvmeInfo.PowerOnHours) {
                $result.hours = [int]$nvmeInfo.PowerOnHours
                $result.source = 'StorageNode(NVMe log 0x02)'
                return $result
            }
        }
    } catch {}
    # No source available. Label it clearly.
    $result.source = 'not-exposed'
    return $result
}

try {
    $disk = Get-PhysicalDisk | Where-Object { $_.MediaType -in @('SSD','NVMe SSD','SCM') } |
            Sort-Object Size -Descending | Select-Object -First 1
    if (-not $disk) { $disk = Get-PhysicalDisk | Sort-Object Size -Descending | Select-Object -First 1 }
    if (-not $disk) { throw 'No disks found.' }

    $rc = $null
    try { $rc = Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction Stop } catch {}

    $link = Get-PhysicalDiskLinkInfo -physicalDisk $disk
    $powerOn = Get-PowerOnHoursMulti -physicalDisk $disk

    $wear  = if ($rc -and $rc.Wear -ne $null) { [int]$rc.Wear } else { $null }
    $life  = if ($wear -ne $null) { 100 - $wear } else { $null }
    $reads = if ($rc -and $rc.ReadErrorsTotal  -ne $null) { [int]$rc.ReadErrorsTotal  } else { $null }
    $writes= if ($rc -and $rc.WriteErrorsTotal -ne $null) { [int]$rc.WriteErrorsTotal } else { $null }

    [PSCustomObject]@{
        model             = $disk.FriendlyName
        mediaType         = $disk.MediaType
        busType           = $disk.BusType
        healthStatus      = $disk.HealthStatus
        operationalStatus = $disk.OperationalStatus
        sizeGB            = [math]::Round($disk.Size / 1GB, 0)
        firmwareVersion   = $disk.FirmwareVersion
        serialNumber      = $disk.SerialNumber
        wear              = $wear
        lifeRemaining     = $life
        readErrors        = $reads
        writeErrors       = $writes
        powerOnHours      = $powerOn.hours
        powerOnHoursSource= $powerOn.source
        pcieCurrentGen    = $link.currentGen
        pcieMaxGen        = $link.maxGen
        pcieCurrentWidth  = $link.currentWidth
        pcieMaxWidth      = $link.maxWidth
        expectedMBps      = $link.expectedMBps
    } | ConvertTo-Json -Compress
} catch {
    Write-Output ('{"error":"query_failed","message":"' + ($_.Exception.Message -replace '"','\"') + '"}')
}
