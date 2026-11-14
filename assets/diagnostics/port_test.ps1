# port_test.ps1 — prove a PHYSICAL port actually works.
#
# Windows cannot tell you "this socket is on the case front panel" — nothing in
# WMI/PnP records physical placement. What it DOES expose is
# DEVPKEY_Device_LocationInfo ("Port_#0004.Hub_#0001"), a stable fingerprint of
# the socket a device is plugged into. So the only truthful way to certify a
# case port is a guided test:
#
#   1. snapshot   → what is connected right now
#   2. technician plugs the pendrive into the NAMED port
#   3. snapshot   → diff reveals the new device AND the socket fingerprint
#   4. iotest     → write + read back real data through that device
#
# A port only passes if a device actually appeared AND data round-tripped
# through it intact. No appearance = fail. That is the honest answer.
#
# Modes:
#   -Mode snapshot [-Parts devices,disks,audio]   (1.12.5: only the parts asked
#                   for — polling for a plugged-in device needs just 'devices')
#   -Mode iotest -DriveLetter D [-SizeMB 48]

param(
    [ValidateSet('snapshot','iotest')]
    [string]$Mode = 'snapshot',
    [string]$DriveLetter,
    [int]$SizeMB = 48,
    [string]$Parts = 'devices,disks,audio'
)
$Want = @($Parts -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Panel names for the _PLD "Panel" field (ACPI 6, bits 67-69 = byte 8, bits 3-5).
$PanelNames = @('top', 'bottom', 'left', 'right', 'front', 'back', 'unknown', 'unknown')

function Get-UsbSnapshot {
    # 1.12.5 — every USB device node, whatever its class (a fast USB-C stick or
    # SSD using UAS registers as SCSIAdapter, not USB) and whatever its state
    # (a device that fails to start on a loose front-panel header is exactly
    # what we want to see). Properties are read per device through the CIM
    # method on Win32_PnPEntity: ~2 s for a dozen devices. (Get-PnpDeviceProperty
    # took ~2 s PER CALL, ~40 s a snapshot; its batched form mislabels devices.)
    $keys = @('DEVPKEY_Device_LocationInfo', 'DEVPKEY_Device_Parent',
              'DEVPKEY_Device_BusReportedDeviceDesc', 'DEVPKEY_Device_PhysicalDeviceLocation')
    $devices = @()
    if ($Want -contains 'devices') {
    foreach ($e in @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\%'")) {
        $r = Invoke-CimMethod -InputObject $e -MethodName GetDeviceProperties -Arguments @{ devicePropertyKeys = $keys } -EA SilentlyContinue
        $h = @{}
        foreach ($p in @($r.deviceProperties)) { if ($p) { $h[$p.KeyName] = $p.Data } }
        $loc = [string]$h['DEVPKEY_Device_LocationInfo']
        # Only the node sitting directly on a hub port ("Port_#0004.Hub_#0001"):
        # not host controllers, root hubs, or a composite device's interfaces.
        if ($loc -notlike 'Port_#*') { continue }
        $parent = [string]$h['DEVPKEY_Device_Parent']
        # Where the firmware says this socket is (ACPI _PLD). Often right on
        # laptops and good boards, sometimes missing or wrong on desktop front
        # headers, so it is shown as a hint, never used to pass or fail a port.
        $panel = $null; $visible = $null
        $pld = $h['DEVPKEY_Device_PhysicalDeviceLocation']
        if ($pld -is [byte[]] -and $pld.Length -ge 9) {
            $visible = [bool]($pld[8] -band 1)
            $panel = $PanelNames[($pld[8] -shr 3) -band 7]
        }
        $code = [int]$e.ConfigManagerErrorCode
        $devices += [ordered]@{
            instanceId  = $e.PNPDeviceID
            name        = $e.Name
            class       = $e.PNPClass
            # 'OK', or the Device Manager problem code (10 = could not start, 43 = descriptor failed …)
            status      = if ($code -eq 0) { 'OK' } else { "Error $code" }
            busDesc     = $h['DEVPKEY_Device_BusReportedDeviceDesc']
            location    = $loc
            parent      = $parent
            # Socket fingerprint: the hub + port the device sits on. Two different
            # physical sockets always differ here.
            socketKey   = "$parent|$loc"
            panel       = $panel
            userVisible = $visible
        }
    }
    }

    # USB mass-storage → drive letter, so we can push real data through the port.
    $usbDisks = @()
    if ($Want -contains 'disks') {
    foreach ($disk in (Get-Disk | Where-Object { $_.BusType -eq 'USB' })) {
        $letters = @()
        foreach ($p in (Get-Partition -DiskNumber $disk.Number -EA SilentlyContinue)) {
            if ($p.DriveLetter) { $letters += [string]$p.DriveLetter }
        }
        $usbDisks += [ordered]@{
            number       = $disk.Number
            friendlyName = $disk.FriendlyName
            serial       = $disk.SerialNumber
            sizeGB       = if ($disk.Size) { [math]::Round($disk.Size / 1GB, 1) } else { $null }
            driveLetters = $letters
        }
    }
    }

    # Audio endpoints — a headphone/mic jack plug-in shows up as a new endpoint
    # (or an endpoint changing state) on drivers with jack-presence detection.
    $audio = @()
    if ($Want -contains 'audio') {
    foreach ($e in (Get-PnpDevice -PresentOnly -Class AudioEndpoint -Status OK)) {
        $audio += [ordered]@{ instanceId = $e.InstanceId; name = $e.FriendlyName }
    }
    }

    return [ordered]@{
        takenAt     = (Get-Date).ToString('o')
        parts       = @($Want)
        usbDevices  = @($devices)
        usbDisks    = @($usbDisks)
        audioEndpoints = @($audio)
    }
}

function Invoke-IoTest {
    param([string]$Letter, [int]$Mb)
    if (-not $Letter) { return [ordered]@{ ok = $false; error = 'no drive letter supplied' } }
    $root = ($Letter.TrimEnd(':')) + ':\'
    if (-not (Test-Path $root)) { return [ordered]@{ ok = $false; error = "drive $root not accessible" } }

    $file = Join-Path $root ('neoqc_port_test_' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.bin')
    try {
        # Random (incompressible) payload so a controller cannot fake speed.
        $bytes = New-Object byte[] (1MB)
        (New-Object Random).NextBytes($bytes)
        $hash = [System.Security.Cryptography.SHA256]::Create()

        $swW = [Diagnostics.Stopwatch]::StartNew()
        $fs = [System.IO.File]::Open($file, 'Create', 'Write', 'None')
        for ($i = 0; $i -lt $Mb; $i++) { $fs.Write($bytes, 0, $bytes.Length) }
        $fs.Flush($true)   # force to the device, not the OS cache
        $fs.Close()
        $swW.Stop()

        # Read back UNBUFFERED (FILE_FLAG_NO_BUFFERING = 0x20000000). Without
        # this, Windows serves the data straight from RAM cache and reports
        # impossible speeds (measured 2531 MB/s over a USB port) — which would
        # make the report a lie. Buffer is 1 MB, so it satisfies the sector
        # alignment unbuffered I/O requires. Falls back to buffered, clearly
        # flagged, if the filesystem refuses.
        $readCached = $false
        $swR = [Diagnostics.Stopwatch]::StartNew()
        $readBuf = New-Object byte[] (1MB)
        $mismatch = $false
        try {
            $noBuf = [System.IO.FileOptions]0x20000000
            $fsr = New-Object System.IO.FileStream($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None, 1MB, $noBuf)
        } catch {
            $readCached = $true
            $fsr = [System.IO.File]::Open($file, 'Open', 'Read', 'None')
        }
        for ($i = 0; $i -lt $Mb; $i++) {
            $n = $fsr.Read($readBuf, 0, $readBuf.Length)
            if ($n -ne $bytes.Length) { $mismatch = $true; break }
        }
        $fsr.Close()
        $swR.Stop()

        # Integrity: compare a hash of the source block against the last block read.
        $srcHash = [BitConverter]::ToString($hash.ComputeHash($bytes))
        $dstHash = [BitConverter]::ToString($hash.ComputeHash($readBuf))
        if ($srcHash -ne $dstHash) { $mismatch = $true }

        $wSec = [math]::Max($swW.Elapsed.TotalSeconds, 0.001)
        $rSec = [math]::Max($swR.Elapsed.TotalSeconds, 0.001)
        return [ordered]@{
            ok            = (-not $mismatch)
            dataIntact    = (-not $mismatch)
            writeMBps     = [math]::Round($Mb / $wSec, 1)
            readMBps      = [math]::Round($Mb / $rSec, 1)
            readCached    = $readCached
            testedMB      = $Mb
            drive         = $root
        }
    } catch {
        return [ordered]@{ ok = $false; error = $_.Exception.Message }
    } finally {
        try { Remove-Item $file -Force -EA SilentlyContinue } catch {}
    }
}

if ($Mode -eq 'snapshot') {
    Get-UsbSnapshot | ConvertTo-Json -Depth 6 -Compress
} else {
    Invoke-IoTest -Letter $DriveLetter -Mb $SizeMB | ConvertTo-Json -Depth 4 -Compress
}
