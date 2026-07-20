# hw_inventory.ps1 — FULL hardware inventory for the QC ticket + report.
#
# Goal: everything that identifies a physical part — brand, model, part number
# and SERIAL — for every component in the build, so a ticket can prove exactly
# which hardware left the shop.
#
# Source: WMI/CIM. Deliberately NOT HWiNFO: HWiNFO is free for personal use
# only and requires a paid licence for commercial/business use, so it cannot be
# bundled with a shop tool. Everything below is available from Windows itself
# with no licence restriction. If a licensed HWiNFO IS installed, main.js
# enriches this data from its report export (see hwinfoEnrich).
#
# Emits a single JSON object on stdout. Never throws — missing data is null.

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function S($v) { if ($null -eq $v) { return $null }; $t = "$v".Trim(); if ($t -eq '' -or $t -eq 'To Be Filled By O.E.M.' -or $t -eq 'Default string' -or $t -eq 'None' -or $t -eq 'Not Specified' -or $t -eq 'Not Applicable') { return $null }; return $t }

# Win32_DiskDrive often hands back the NVMe serial as hex-encoded ASCII in
# 4-char groups ("3931_3430_3539_3633..."), which is unreadable on a report.
# Decode it back to the string printed on the drive label when it round-trips
# to sane printable ASCII; otherwise keep the raw value.
function DecodeDiskSerial($raw) {
    $s = S $raw
    if (-not $s) { return $null }
    if ($s -notmatch '^[0-9A-Fa-f_ .]+$' -or $s -notmatch '_') { return $s }
    $hex = ($s -replace '[^0-9A-Fa-f]', '')
    if ($hex.Length -lt 8 -or ($hex.Length % 2) -ne 0) { return $s }
    try {
        $sb = New-Object System.Text.StringBuilder
        for ($i = 0; $i -lt $hex.Length; $i += 2) {
            $b = [Convert]::ToInt32($hex.Substring($i, 2), 16)
            if ($b -lt 32 -or $b -gt 126) { return $s }   # not printable → keep raw
            [void]$sb.Append([char]$b)
        }
        $out = $sb.ToString().Trim()
        if ($out.Length -ge 4) { return $out }
        return $s
    } catch { return $s }
}

# ── System / chassis ───────────────────────────────────────────────────────
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$board= Get-CimInstance Win32_BaseBoard
$encl = Get-CimInstance Win32_SystemEnclosure

$system = [ordered]@{
    manufacturer = S $cs.Manufacturer
    model        = S $cs.Model
    systemSku    = S $cs.SystemSKUNumber
    serial       = S $bios.SerialNumber
    uuid         = S (Get-CimInstance Win32_ComputerSystemProduct).UUID
    chassisType  = S ($encl.ChassisTypes -join ',')
    totalRamGB   = if ($cs.TotalPhysicalMemory) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 2) } else { $null }
}

$biosInfo = [ordered]@{
    vendor      = S $bios.Manufacturer
    version     = S $bios.SMBIOSBIOSVersion
    releaseDate = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null }
    serial      = S $bios.SerialNumber
}

# ── Motherboard ────────────────────────────────────────────────────────────
$motherboard = [ordered]@{
    manufacturer = S $board.Manufacturer
    model        = S $board.Product
    version      = S $board.Version
    serial       = S $board.SerialNumber
}

# ── CPU ────────────────────────────────────────────────────────────────────
$cpus = @()
foreach ($p in (Get-CimInstance Win32_Processor)) {
    $cpus += [ordered]@{
        name           = S $p.Name
        manufacturer   = S $p.Manufacturer
        processorId    = S $p.ProcessorId          # closest thing to a CPU serial
        socket         = S $p.SocketDesignation
        cores          = $p.NumberOfCores
        threads        = $p.NumberOfLogicalProcessors
        maxClockMHz    = $p.MaxClockSpeed
        l2CacheKB      = $p.L2CacheSize
        l3CacheKB      = $p.L3CacheSize
        family         = S $p.Description
        partNumber     = S $p.PartNumber
        serialNumber   = S $p.SerialNumber
    }
}

# ── RAM — per physical module (this is where serials really matter) ────────
$memType = @{ 20='DDR'; 21='DDR2'; 24='DDR3'; 26='DDR4'; 34='DDR5' }
$ramModules = @()
foreach ($m in (Get-CimInstance Win32_PhysicalMemory)) {
    $gen = $null
    if ($m.SMBIOSMemoryType -and $memType.ContainsKey([int]$m.SMBIOSMemoryType)) { $gen = $memType[[int]$m.SMBIOSMemoryType] }
    $ramModules += [ordered]@{
        manufacturer   = S $m.Manufacturer
        partNumber     = S $m.PartNumber
        serial         = S $m.SerialNumber
        capacityGB     = if ($m.Capacity) { [math]::Round($m.Capacity / 1GB, 0) } else { $null }
        speedMHz       = $m.Speed
        configuredMHz  = $m.ConfiguredClockSpeed
        slot           = S $m.DeviceLocator
        bank           = S $m.BankLabel
        ddrGen         = $gen
        formFactor     = $m.FormFactor
        voltage        = $m.ConfiguredVoltage
    }
}

# ── GPU ────────────────────────────────────────────────────────────────────
$gpus = @()
foreach ($g in (Get-CimInstance Win32_VideoController)) {
    $vram = $null
    # AdapterRAM is unreliable/negative >4GB; prefer the registry qword.
    try {
        $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
        foreach ($sub in (Get-ChildItem $key -ErrorAction SilentlyContinue)) {
            $desc = (Get-ItemProperty $sub.PSPath -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc
            if ($desc -and $desc -eq $g.Name) {
                $qw = (Get-ItemProperty $sub.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
                if ($qw) { $vram = [math]::Round($qw / 1GB, 0) }
            }
        }
    } catch {}
    if (-not $vram -and $g.AdapterRAM -gt 0) { $vram = [math]::Round($g.AdapterRAM / 1GB, 0) }
    $gpus += [ordered]@{
        name           = S $g.Name
        manufacturer   = S $g.AdapterCompatibility
        vramGB         = $vram
        driverVersion  = S $g.DriverVersion
        driverDate     = if ($g.DriverDate) { $g.DriverDate.ToString('yyyy-MM-dd') } else { $null }
        videoProcessor = S $g.VideoProcessor
        pnpDeviceId    = S $g.PNPDeviceID
        resolution     = if ($g.CurrentHorizontalResolution) { "$($g.CurrentHorizontalResolution)x$($g.CurrentVerticalResolution)" } else { $null }
    }
}

# ── Storage — model + SERIAL + firmware per physical disk ──────────────────
$disks = @()
$physMap = @{}
foreach ($pd in (Get-PhysicalDisk)) { $physMap[[string]$pd.DeviceId] = $pd }
foreach ($d in (Get-CimInstance Win32_DiskDrive)) {
    $pd = $physMap[[string]$d.Index]
    $disks += [ordered]@{
        model         = S $d.Model
        serial        = DecodeDiskSerial $d.SerialNumber
        serialRaw     = S $d.SerialNumber
        firmware      = S $d.FirmwareRevision
        sizeGB        = if ($d.Size) { [math]::Round($d.Size / 1GB, 0) } else { $null }
        interfaceType = S $d.InterfaceType
        busType       = if ($pd) { S $pd.BusType } else { $null }
        mediaType     = if ($pd) { S $pd.MediaType } else { $null }
        spindleSpeed  = if ($pd) { $pd.SpindleSpeed } else { $null }
        healthStatus  = if ($pd) { S $pd.HealthStatus } else { $null }
        partitions    = $d.Partitions
        pnpDeviceId   = S $d.PNPDeviceID
    }
}

# ── Network adapters (MAC = a real per-unit identifier) ────────────────────
$nics = @()
foreach ($n in (Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True")) {
    $nics += [ordered]@{
        name         = S $n.Name
        manufacturer = S $n.Manufacturer
        macAddress   = S $n.MACAddress
        adapterType  = S $n.AdapterType
        speedMbps    = if ($n.Speed) { [math]::Round($n.Speed / 1MB, 0) } else { $null }
    }
}

# ── OS ─────────────────────────────────────────────────────────────────────
$os = Get-CimInstance Win32_OperatingSystem
$osInfo = [ordered]@{
    caption      = S $os.Caption
    version      = S $os.Version
    buildNumber  = S $os.BuildNumber
    architecture = S $os.OSArchitecture
    installDate  = if ($os.InstallDate) { $os.InstallDate.ToString('yyyy-MM-dd HH:mm') } else { $null }
    serial       = S $os.SerialNumber
}

[ordered]@{
    capturedAt  = (Get-Date).ToString('o')
    source      = 'wmi-cim'
    system      = $system
    bios        = $biosInfo
    motherboard = $motherboard
    cpus        = $cpus
    ramModules  = $ramModules
    gpus        = $gpus
    disks       = $disks
    nics        = $nics
    os          = $osInfo
} | ConvertTo-Json -Depth 6 -Compress
