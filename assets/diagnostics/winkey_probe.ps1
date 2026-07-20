# winkey_probe.ps1 — recover the Windows product key that this install is
# ACTUALLY using, not the OEM factory key baked into the BIOS.
#
# v1.4.5 rewrite — the v1.4.4 decoder had a subtle bug in the Windows 8+
# format detection (`-shr 3` vs the community-verified `[Math]::Truncate($b / 6)`)
# AND used a non-standard N-edition insertion algorithm, so decoded keys were
# valid-looking but wrong for some Windows 10/11 installs. This version uses
# the algorithm that Magical Jelly Bean / NirSoft / etc. converged on, and
# probes multiple sources:
#
#   1. DigitalProductId4  (newer 8+ format, sometimes present when 1 isn't)
#   2. DigitalProductId   (classic base24 decode)
#   3. OA3xOriginalProductKey (BIOS OEM factory key — never changes)
#
# For each retrieved key we also cross-check against SLP's PartialProductKey
# and flag if the decoded key's last-5 doesn't match (that means the decode
# yielded a stale or wrong key vs what's actually activated).

$ErrorActionPreference = 'SilentlyContinue'

function Decode-DigitalProductId {
    param([byte[]]$id)
    if ($null -eq $id -or $id.Length -lt 67) { return $null }

    # Community-verified Windows 8+ format detection.
    $isWin8 = [Math]::Truncate($id[66] / 6) -band 1
    $id[66] = ($id[66] -band 0xF7) -bor (($isWin8 -band 2) * 4)

    $chars = 'BCDFGHJKMPQRTVWXY2346789'
    $keyOffset = 52
    $key = ''
    $last = 0

    for ($i = 24; $i -ge 0; $i--) {
        $current = 0
        for ($j = 14; $j -ge 0; $j--) {
            $current = $current * 256
            $current = $id[$j + $keyOffset] + $current
            $id[$j + $keyOffset] = [Math]::Truncate($current / 24)
            $current = $current % 24
        }
        $key = $chars.Substring($current, 1) + $key
        $last = $current
    }

    if ($isWin8 -eq 1) {
        $keyPart1 = $key.Substring(1, $last)
        $keyPart2 = $key.Substring(1, $key.Length - 1)
        $key = $keyPart1 + 'N' + $keyPart2.Substring($last, $keyPart2.Length - $last)
    }

    if ($key.Length -ne 25) { return $null }
    return ($key.Substring(0,5)+'-'+$key.Substring(5,5)+'-'+$key.Substring(10,5)+'-'+$key.Substring(15,5)+'-'+$key.Substring(20,5))
}

function Try-DecodeRegistry {
    param([string]$path, [string]$valueName)
    try {
        $reg = Get-ItemProperty -Path $path -Name $valueName -ErrorAction Stop
        $blob = $reg.$valueName
        if ($blob) { return (Decode-DigitalProductId -id ([byte[]]$blob)) }
    } catch {}
    return $null
}

# Well-known generic placeholder keys shipped by Microsoft for Digital
# License-activated installs. If the decoded key matches ANY of these, the
# real retail/OEM key isn't stored locally — it's on Microsoft's servers,
# tied to the Microsoft Account + hardware hash. Detecting the placeholder
# lets the UI say so honestly instead of printing a shared key as if it
# were the user's.
$genericKeys = @(
    'VK7JG-NPHTM-C97JM-9MPGT-3V66T',  # Pro (default install)
    'YTMG3-N6DKC-DKB77-7M9GH-8HVX7',  # Home
    'W269N-WFGWX-YVC9B-4J6C9-T83GX',  # Pro (retail generic)
    'NPPR9-FWDCX-D2C8J-H872K-2YT43',  # Enterprise
    'NW6C2-QMPVW-D7KKK-3GKT6-VCFB2',  # Education
    'MH37W-N47XK-V7XM9-C7227-GCQG9',  # Home N
    'MH37W-N47XK-V7XM9-C7227-GCQG9',  # Home Single Language
    'BT79Q-G7N6G-PGBYW-4YWX6-6F4BT',  # Pro N
    'DPH2V-TTNVB-4X9Q3-TJR4H-KHJW4',  # Education N
    'WGGHN-J84D6-QYCPR-T7PJ7-X766F'   # Enterprise N
)

# 1. Try DigitalProductId4 (Windows 8+ newer format).
$key_dpid4 = Try-DecodeRegistry -path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -valueName 'DigitalProductId4'

# 2. Try DigitalProductId (classic).
$key_dpid = Try-DecodeRegistry -path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -valueName 'DigitalProductId'

# 3. OEM factory key (never changes; separate from what's activated).
$oemKey = $null
try {
    $oem = (Get-CimInstance -ClassName SoftwareLicensingService -ErrorAction Stop).OA3xOriginalProductKey
    if ($oem -and $oem.Trim()) { $oemKey = $oem.Trim() }
} catch {}

# 4. SLP partial (last-5 of the currently activated key — authoritative for
#    what Windows is USING right now).
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

# v1.5.1 — SELECT BY VALIDATION, not by blind source preference.
#
# The old order (DPID4 > DPID > OEM) reported whichever blob existed first.
# Measured on a real Retail machine: DigitalProductId4 decoded to
# JVF76-...-TCGTV while the authoritative PartialProductKey was 8FG6T, and
# DigitalProductId decoded to XN99X-...-8FG6T (correct). So the app printed a
# WRONG key while the right one sat in the other blob.
#
# Correct rule: whichever candidate's last-5 matches SoftwareLicensingProduct's
# PartialProductKey IS this machine's activating key. Only fall back to raw
# preference when there's no partial to validate against.
$keyCandidates = @()
if ($key_dpid4) { $keyCandidates += ,@('digital-product-id-4', $key_dpid4) }
if ($key_dpid)  { $keyCandidates += ,@('digital-product-id',   $key_dpid) }
if ($oemKey)    { $keyCandidates += ,@('bios-oa3x',            $oemKey) }

$installedKey = $null
$installedKeySource = $null
if ($partialKey) {
    foreach ($cand in $keyCandidates) {
        $ck = $cand[1]
        if ($ck -and $ck.Length -ge 5 -and $ck.Substring($ck.Length - 5) -eq $partialKey) {
            $installedKey = $ck; $installedKeySource = $cand[0]; break
        }
    }
}
if (-not $installedKey) {
    # Nothing validated — keep the old preference so we still report SOMETHING,
    # but keyRecoverable below will be false so the UI never presents it as
    # the customer's key.
    $installedKey = if ($key_dpid4) { $key_dpid4 } elseif ($key_dpid) { $key_dpid } else { $null }
    $installedKeySource = if ($key_dpid4) { 'digital-product-id-4' } elseif ($key_dpid) { 'digital-product-id' } else { $null }
}

# If we have a partial from SLP and the decoded key's last-5 doesn't match,
# the decoded key is stale — trust the partial and use the decode for the
# prefix. This happens on installs where the DigitalProductId still holds
# the original key but activation later moved to a Digital License.
$matchesPartial = $null
if ($installedKey -and $partialKey) {
    $decodedLast5 = $installedKey.Substring($installedKey.Length - 5)
    $matchesPartial = ($decodedLast5 -eq $partialKey)
}

# Detect generic placeholder keys — the real retail key isn't recoverable.
$isPlaceholder = $false
$whichSource = 'not-available'
$reportedKey = $null
if ($installedKey) {
    $isPlaceholder = $genericKeys -contains $installedKey
    $reportedKey = $installedKey
    $whichSource = $installedKeySource
    if ($isPlaceholder) {
        # Don't LIE — surface the placeholder AND the note that the real key
        # isn't on the machine.
        $whichSource = 'digital-license-placeholder'
    }
} elseif ($oemKey) {
    $reportedKey = $oemKey
    $whichSource = 'bios-oa3x'
}

$oemDiffers = ($oemKey -and $installedKey -and ($oemKey -ne $installedKey))

# v1.5.1 — THE decisive flag for the UI.
#
# A key is only "recoverable" (i.e. genuinely THIS machine's activating key)
# when all three hold:
#   1. we decoded something,
#   2. it is not one of Microsoft's shared generic install keys, and
#   3. its last-5 matches SoftwareLicensingProduct.PartialProductKey — the
#      authoritative, per-machine record of what actually activated Windows.
#
# When a tech installs with "I don't have a product key", Windows writes a
# GENERIC edition key into DigitalProductId. Activating later by typing a real
# key does NOT always rewrite that blob, so the decode keeps returning the same
# generic key on every machine. That is precisely the "same key everywhere"
# symptom. In that case the full key is NOT on the PC — Microsoft keeps only a
# hash + digital licence — and the only ground truth locally is the last-5.
# The UI must then ask the technician to record the key they typed, and verify
# it against that last-5 rather than printing a shared placeholder.
$keyRecoverable = [bool]($installedKey -and (-not $isPlaceholder) -and ($matchesPartial -eq $true))

$result = [ordered]@{
    productKey = $reportedKey
    keyRecoverable = $keyRecoverable
    source = $whichSource
    installedKey = $installedKey
    installedKeyDpid = $key_dpid
    installedKeyDpid4 = $key_dpid4
    oemKey = $oemKey
    oemDiffersFromInstalled = $oemDiffers
    activated = $activated
    partialKey = $partialKey
    licenseDescription = $licenseDescription
    decodedLast5MatchesPartial = $matchesPartial
    isDigitalLicensePlaceholder = $isPlaceholder
    placeholderNote = if ($isPlaceholder) { 'This is a shared Microsoft placeholder key used when Windows was activated via a Digital License (Microsoft Account) rather than a typed product key. The real retail/OEM key is stored on Microsoft servers, not on this machine. Get it from account.microsoft.com > Devices, or your install notes.' } else { $null }
}

$result | ConvertTo-Json -Compress
