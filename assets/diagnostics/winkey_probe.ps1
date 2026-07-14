# winkey_probe.ps1 — recover the Windows product key that this install is
# ACTUALLY using, not the OEM factory key baked into the BIOS.
#
# Old approach queried OA3xOriginalProductKey first, which returns the OEM key
# from the ACPI MSDM table. If a shop installs a fresh Windows with a retail
# or new OEM key, OA3x still returns the *original* factory key from the
# motherboard — so the reported key never matched what the tech actually
# entered. Registry's `BackupProductKeyDefault` was also unreliable (removed
# in modern Windows and often just a Digital License placeholder).
#
# This script:
#   1. Decodes DigitalProductId from HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion
#      — the key currently in use for activation.
#   2. Also reads OA3xOriginalProductKey (OEM factory key from BIOS).
#   3. Reports both, plus which one is currently active per softwareLicensingProduct.
#
# The renderer picks the "installed" key first (what the user typed) and
# falls back to the OEM key only if the DigitalProductId can't be decoded.

$ErrorActionPreference = 'SilentlyContinue'

function Decode-DigitalProductId {
    param([byte[]]$id)
    if ($null -eq $id -or $id.Length -lt 67) { return $null }
    # Windows 8+ format: bit 3 of byte 66 flags the newer 25-char base24 encoding.
    $isN = ($id[66] -shr 3) -band 1
    $id[66] = ($id[66] -band 0xF7)

    $chars = 'BCDFGHJKMPQRTVWXY2346789'
    $keyStart = 52
    $keyChars = New-Object System.Collections.Generic.List[char]
    for ($i = 24; $i -ge 0; $i--) {
        $current = 0
        for ($j = 14; $j -ge 0; $j--) {
            $current = ($current * 256) -bxor $id[$keyStart + $j]
            $id[$keyStart + $j] = [byte][Math]::Floor($current / 24)
            $current = $current % 24
        }
        $keyChars.Insert(0, $chars[$current])
    }
    $flat = -join $keyChars

    if ($isN -eq 1) {
        # For "N" (server/education) editions, insert 'N' at the first index found.
        # Standard ProduKey convention: strip first char, find its position, insert 'N' there.
        $first = $flat[0]
        $rest = $flat.Substring(1)
        $insertAt = $rest.IndexOf($first)
        if ($insertAt -ge 0) {
            $flat = $rest.Substring(0, $insertAt) + 'N' + $rest.Substring($insertAt)
        } else {
            $flat = 'N' + $rest
        }
    }

    if ($flat.Length -ne 25) { return $null }
    # Format as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
    return ($flat.Substring(0,5)+'-'+$flat.Substring(5,5)+'-'+$flat.Substring(10,5)+'-'+$flat.Substring(15,5)+'-'+$flat.Substring(20,5))
}

# 1. Installed key (what Windows is actually using).
$installedKey = $null
try {
    $reg = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DigitalProductId -ErrorAction Stop
    if ($reg.DigitalProductId) {
        $installedKey = Decode-DigitalProductId -id ([byte[]]$reg.DigitalProductId)
    }
} catch {}

# 2. OEM factory key (from BIOS MSDM table).
$oemKey = $null
try {
    $oem = (Get-CimInstance -ClassName SoftwareLicensingService -ErrorAction Stop).OA3xOriginalProductKey
    if ($oem -and $oem.Trim()) { $oemKey = $oem.Trim() }
} catch {}

# 3. Activation state + last-5-of-current-key from SLP (independent read).
$activated = $false
$partialKey = $null
$licenseDescription = $null
try {
    $slp = Get-CimInstance -Query "SELECT PartialProductKey, LicenseStatus, Description FROM SoftwareLicensingProduct WHERE ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -ErrorAction Stop
    if ($slp) {
        $activated = ($slp[0].LicenseStatus -eq 1)
        $partialKey = $slp[0].PartialProductKey
        $licenseDescription = $slp[0].Description
    }
} catch {}

# Sanity: if the DigitalProductId decoded a key, cross-check the last 5 chars
# against SLP's PartialProductKey. When they differ, prefer the SLP-verified
# partial (append the 20-char prefix from DigitalProductId).
if ($installedKey -and $partialKey) {
    $decodedLast5 = $installedKey.Substring($installedKey.Length - 5)
    if ($decodedLast5 -ne $partialKey) {
        $installedKey = $installedKey.Substring(0, $installedKey.Length - 5) + $partialKey
    }
}

# 4. Pick the "reportable" key: installed > oem.
$reportedKey = if ($installedKey) { $installedKey } elseif ($oemKey) { $oemKey } else { $null }
$source = if ($installedKey) { 'digital-product-id' } elseif ($oemKey) { 'bios-oa3x' } else { 'not-available' }

# 5. Detect key type mismatch for the diagnostics log.
$oemDiffers = ($oemKey -and $installedKey -and ($oemKey -ne $installedKey))

$result = [ordered]@{
    productKey = $reportedKey
    source = $source
    installedKey = $installedKey
    oemKey = $oemKey
    oemDiffersFromInstalled = $oemDiffers
    activated = $activated
    partialKey = $partialKey
    licenseDescription = $licenseDescription
}

$result | ConvertTo-Json -Compress
