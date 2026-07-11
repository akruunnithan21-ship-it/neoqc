<#
  port_enumerate.ps1 — passive enumeration of what Windows recognises on this
  machine, for the NeoQC "Port Check" panel. No plug-in/verify dance: it simply
  reports the USB host controllers and their generations, connected USB devices,
  the GPU video outputs actually in use (HDMI/DisplayPort/DVI), and the audio
  endpoints. Emits a single JSON object on stdout.
#>
$ErrorActionPreference = 'SilentlyContinue'

function Get-UsbGen([string]$name) {
  $n = $name.ToLower()
  if ($n -match 'usb4|usb 4')                                   { return 'USB4 (40 Gbps)' }
  if ($n -match '3\.2 gen ?2x2')                                { return 'USB 3.2 Gen 2x2 (20 Gbps)' }
  if ($n -match '3\.2 gen ?2|3\.1 gen ?2|10 ?gbps')            { return 'USB 3.2 Gen 2 (10 Gbps)' }
  if ($n -match '3\.2 gen ?1|3\.1 gen ?1|3\.0|xhci|extensible|superspeed') { return 'USB 3.x (5 Gbps)' }
  if ($n -match '2\.0|ehci|enhanced')                          { return 'USB 2.0 (480 Mbps)' }
  if ($n -match '1\.1|ohci|uhci')                              { return 'USB 1.1 (12 Mbps)' }
  return 'USB (generation not reported)'
}

# ── USB host controllers ────────────────────────────────────────────────
$usbControllers = @()
foreach ($c in (Get-CimInstance Win32_USBController)) {
  $usbControllers += [PSCustomObject]@{
    name       = $c.Name
    generation = (Get-UsbGen $c.Name)
    status     = $c.Status
  }
}

# ── Connected USB peripherals (exclude hubs/roots/host controllers) ──────
$usbDevices = @()
foreach ($d in (Get-PnpDevice -PresentOnly -Class USB -Status OK)) {
  if ($d.FriendlyName -and $d.FriendlyName -notmatch 'Root Hub|Host Controller|Generic USB Hub|USB Composite') {
    $usbDevices += $d.FriendlyName
  }
}
$usbDevices = $usbDevices | Select-Object -Unique

# ── Video outputs (connected monitors + connection technology) ──────────
# VideoOutputTechnology enum (WmiMonitorConnectionParams):
$videoTech = @{
  0='Other'; 1='VGA (HD15)'; 2='S-Video'; 3='Composite'; 4='Component';
  5='DVI'; 6='HDMI'; 7='LVDS'; 8='D-Jpn'; 9='SDI';
  10='DisplayPort (external)'; 11='DisplayPort (embedded)';
  12='UDI (external)'; 13='UDI (embedded)'; 14='SDTV dongle'; 15='Miracast';
  2147483648='Internal'
}
$gpus = @()
foreach ($v in (Get-CimInstance Win32_VideoController)) {
  if ($v.Name -notmatch 'Basic Display|Remote|Meta|Parsec') {
    $gpus += [PSCustomObject]@{
      name         = $v.Name
      driver       = $v.DriverVersion
      vramMB       = if ($v.AdapterRAM) { [math]::Round($v.AdapterRAM / 1MB, 0) } else { $null }
      resolution   = if ($v.CurrentHorizontalResolution) { "$($v.CurrentHorizontalResolution)x$($v.CurrentVerticalResolution)" } else { $null }
    }
  }
}
$videoOutputs = @()
$conn = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams
$ids  = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID
for ($i = 0; $i -lt @($conn).Count; $i++) {
  $tech = $conn[$i].VideoOutputTechnology
  $techName = if ($videoTech.ContainsKey([int64]$tech)) { $videoTech[[int64]$tech] } else { "Type $tech" }
  $monName = ''
  if ($ids -and $ids[$i] -and $ids[$i].UserFriendlyName) {
    $monName = -join ($ids[$i].UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  }
  $videoOutputs += [PSCustomObject]@{ connection = $techName; monitor = $monName.Trim() }
}

# ── Audio ────────────────────────────────────────────────────────────────
$audioControllers = @()
foreach ($a in (Get-CimInstance Win32_SoundDevice)) {
  if ($a.Name) { $audioControllers += [PSCustomObject]@{ name = $a.Name; status = $a.Status } }
}
$audioEndpoints = @()
foreach ($e in (Get-PnpDevice -PresentOnly -Class AudioEndpoint -Status OK)) {
  if ($e.FriendlyName) { $audioEndpoints += $e.FriendlyName }
}
$audioEndpoints = $audioEndpoints | Select-Object -Unique

[PSCustomObject]@{
  usbControllers   = $usbControllers
  usbDeviceCount   = @($usbDevices).Count
  usbDevices       = @($usbDevices)
  gpus             = $gpus
  videoOutputs     = $videoOutputs
  audioControllers = $audioControllers
  audioEndpoints   = @($audioEndpoints)
} | ConvertTo-Json -Depth 5 -Compress
