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
#   -Mode snapshot
#   -Mode iotest -DriveLetter D [-SizeMB 48]

param(
    [ValidateSet('snapshot','iotest')]
    [string]$Mode = 'snapshot',
    [string]$DriveLetter,
    [int]$SizeMB = 48
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-UsbSnapshot {
    $devices = @()
    foreach ($d in (Get-PnpDevice -PresentOnly -Class USB -Status OK)) {
        $loc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_LocationInfo' -EA SilentlyContinue).Data
        # Skip host controllers — they are PCI devices, not sockets.
        if (-not $loc -or $loc -like 'PCI bus*') { continue }
        $parent = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_Parent' -EA SilentlyContinue).Data
        $busDesc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -EA SilentlyContinue).Data
        $devices += [ordered]@{
            instanceId  = $d.InstanceId
            name        = $d.FriendlyName
            busDesc     = $busDesc
            location    = $loc
            parent      = $parent
            # Socket fingerprint: the hub + port the device sits on. Two different
            # physical sockets always differ here.
            socketKey   = "$parent|$loc"
        }
    }

    # USB mass-storage → drive letter, so we can push real data through the port.
    $usbDisks = @()
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

    # Audio endpoints — a headphone/mic jack plug-in shows up as a new endpoint
    # (or an endpoint changing state) on drivers with jack-presence detection.
    $audio = @()
    foreach ($e in (Get-PnpDevice -PresentOnly -Class AudioEndpoint -Status OK)) {
        $audio += [ordered]@{ instanceId = $e.InstanceId; name = $e.FriendlyName }
    }

    return [ordered]@{
        takenAt     = (Get-Date).ToString('o')
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
