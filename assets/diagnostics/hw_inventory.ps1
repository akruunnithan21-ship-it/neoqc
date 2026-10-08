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

# Consumer motherboards ship with the DMI/SMBIOS identity fields UNSET, and the
# board then reports the field's own name back as its value: an ASUS ROG STRIX
# returns "System Product Name" as the model, "System Serial Number" as the BIOS
# serial and the literal "MB-1234567890" as the baseboard serial. Those are not
# serials. Reporting them as if they were is what made serial detection look
# broken — the technician reads "MB-1234567890" on the ticket, checks the sticker
# on the board, and finds two different numbers.
#
# Returning $null here is the honest answer, and it tells the renderer to say
# "not set by the manufacturer" so the technician knows to scan the physical
# sticker instead of trusting the machine.
$PLACEHOLDER_EXACT = @(
  'to be filled by o.e.m.', 'to be filled by oem', 'filled by o.e.m.', 'filled by oem',
  'default string', 'default', 'none', 'not specified', 'not applicable', 'n/a', 'na',
  'null', 'invalid', 'o.e.m.', 'no enclosure', 'not available',
  # NOTE: 'unknown' is deliberately NOT here. Get-PhysicalDisk.HealthStatus returns
  # Healthy / Warning / Unhealthy / Unknown, and Unknown is a real state that the
  # report must be able to show. 'oem' is likewise omitted — it is a real
  # manufacturer string on some OEM-branded parts.
  'system product name', 'system serial number', 'system manufacturer', 'system version',
  'system name', 'system sku', 'system sku number', 'system model',
  'base board product name', 'base board serial number', 'base board version',
  'baseboard product name', 'baseboard serial number', 'baseboard version',
  'chassis serial number', 'chassis version', 'chassis manufacturer',
  'mb-1234567890', 'product name', 'serial number', 'manufacturer', 'version',
  'asset-1234567890', 'empty'
)

function S($v) {
  if ($null -eq $v) { return $null }
  $t = "$v".Trim()
  if ($t -eq '') { return $null }
  $l = $t.ToLower()
  if ($PLACEHOLDER_EXACT -contains $l) { return $null }
  # Repeated-character and counting dummies: 0000…, XXXX…, 1234567890, ....
  # The counting run is an explicit set, not a prefix pattern: an earlier
  # '^0?123456789\d*$' would have nulled a genuine serial that merely STARTS
  # 123456789, while still missing most real dummies.
  if ($l -match '^(.)\1{3,}$') { return $null }
  if ($l -match '^0+$' -or $l -match '^\.+$') { return $null }
  if ($l -eq '0123456789' -or $l -eq '1234567890' -or $l -eq '123456789' -or $l -eq '012345678901234567890') { return $null }
  return $t
}

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
        # ALL-OR-NOTHING on purpose. A partial decode cannot be validated: on a
        # BIWIN AP823 the identify blob is 3931_3430_3539_3633_50C6_8E07_3235_3136,
        # whose leading printable run decodes to "91405963" — but the drive's real
        # serial is 2516191405963, and "2516" lives in the DISCARDED tail. A
        # leading-run decode there is not truncated, it is reordered, and it
        # produces a plausible-looking serial that silently mismatches the sticker
        # during component verification. Raw hex is ugly but self-evidently not a
        # serial, which correctly sends the technician to the label.
        $sb = New-Object System.Text.StringBuilder
        for ($i = 0; $i -lt $hex.Length; $i += 2) {
            $b = [Convert]::ToInt32($hex.Substring($i, 2), 16)
            if ($b -lt 32 -or $b -gt 126) { return $s }   # any binary byte -> keep raw
            [void]$sb.Append([char]$b)
        }
        $out = $sb.ToString().Trim()
        if ($out.Length -ge 4) { return $out }
        return $s
    } catch { return $s }
}

# The authoritative serial. Windows puts the controller's own serial into the
# device instance path as &SN_<serial>, and it is the number printed on the
# label — verified against all five drives on the shop workstation:
#   Samsung 980 PRO  -> S5GXNS0X203576K   (identify blob was a WWN)
#   BIWIN AP823      -> 2516191405963     (identify blob decodes wrongly)
#   WDC SN550        -> 202547801983
#   XPG S70 BLADE x2 -> 7O4422195JWC / 2O042L1HN4DX
# Win32_DiskDrive.SerialNumber and Get-PhysicalDisk both return the raw identify
# blob for NVMe, so this is tried FIRST and the blob only as a fallback.
function DiskSerialFor($drive) {
    if ($drive.PNPDeviceID -and $drive.PNPDeviceID -match '&SN_([^&\\]+)') {
        $sn = S $matches[1]
        if ($sn) { return $sn }
    }
    return DecodeDiskSerial $drive.SerialNumber
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
    $vramSource = $null
    # AdapterRAM is a UInt32 and cannot exceed 4 GiB, so every card >= 4 GB reads as
    # ~4 GB. The driver writes the true size as a QWORD in its registry class key.
    #
    # Pair the registry key to the adapter by MatchingDeviceId, NOT by comparing
    # DriverDesc to the WMI Name: those two strings routinely differ (AMD ships
    # "... Series" in one and not the other), and an exact-equality match silently
    # fell through to the capped AdapterRAM — which is how an 8 GB RX 9050 was
    # recorded as a 4 GB card. MatchingDeviceId is 'pci\ven_xxxx&dev_yyyy' and
    # PNPDeviceID is that plus the subsys/rev tail, so a prefix test always pairs.
    try {
        $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
        $needle = if ($g.PNPDeviceID) { ([string]$g.PNPDeviceID).ToLower() } else { $null }
        foreach ($sub in (Get-ChildItem $key -ErrorAction SilentlyContinue)) {
            if ($sub.PSChildName -notmatch '^[0-9]{4}$') { continue }
            $p = Get-ItemProperty $sub.PSPath -ErrorAction SilentlyContinue
            if (-not $p) { continue }
            $mid  = if ($p.MatchingDeviceId) { ([string]$p.MatchingDeviceId).ToLower() } else { $null }
            $desc = $p.DriverDesc
            $hit = ($needle -and $mid -and $needle.StartsWith($mid)) -or ($desc -and $desc -eq $g.Name)
            if (-not $hit) { continue }
            $qw = $p.'HardwareInformation.qwMemorySize'
            if ($qw) { $vram = [math]::Round([int64]$qw / 1GB, 0); $vramSource = 'registry'; break }
        }
    } catch {}
    if (-not $vram -and $g.AdapterRAM -gt 0) {
        $vram = [math]::Round($g.AdapterRAM / 1GB, 0)
        $vramSource = 'wmi-adapterram'   # suspect at ~4 GB: may be a larger card
    }
    $gpus += [ordered]@{
        name           = S $g.Name
        manufacturer   = S $g.AdapterCompatibility
        vramGB         = if ($vram) { $vram } else { $null }   # 0 = integrated/shared → null, not "0 GB"
        vramSource     = $vramSource
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
        serial        = DiskSerialFor $d
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
        # Win32_NetworkAdapter.Speed is a link-down sentinel on some NICs
        # (e.g. 8796093022208). Only trust a plausible value (<= 100 Gbps).
        speedMbps    = if ($n.Speed -and $n.Speed -gt 0) { $mbps = [math]::Round($n.Speed / 1MB, 0); if ($mbps -gt 0 -and $mbps -le 100000) { $mbps } else { $null } } else { $null }
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
