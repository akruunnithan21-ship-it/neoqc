/*
  Neo QC — service fault catalogue, intake chips, handling fees, WhatsApp
  message templates and the WhatsApp chat parser.

  Why a catalogue at all: free-text faults ("not working", "problem") cannot
  set a priority, a typical time or a checklist, and they cannot be counted.
  A chip can. The free text stays — it is the customer's own words and goes on
  the ticket — but the chips are what the queue, the priority and the bench
  checklist are computed from.

  Loaded by BOTH the Electron app and the website (after
  shared/service-status.js), and required by the node unit tests. Everything
  here is a pure function of its arguments: no DOM, no network, no storage.

  Usage:
    const C = window.NeoQcCatalog;
    C.computePriority(['no_display'], { service_type: 'in_store' })
      // { priority: 'high', reasons: ['No display'] }
    C.parseWhatsAppChat(pastedExportText)
      // { phone, name, messages:[{at, from, text}], faultText, faultKeys }
    C.WA_TEMPLATES.ready(job)   // plain text, never HTML
    C.normPhone('+971 50 123 4567')   // '971501234567' (A1': the country code is kept)
    C.isValidPhone('98470 12345')      // true — the same answer as SQL phone_ok()
*/
(function (global) {
  'use strict';

  var HOUR = 3600000;
  var TRACK_BASE = 'https://neoqctracker.netlify.app/?view=service&code=';
  var PHONE_LINE = 'Use the last 4 digits of this phone number to open it.';
  var SHOP = 'Neo Tokyo';
  // The shop's data rule, in the customer's words. (No "please": the message
  // rules below hold for every template.)
  var NO_BACKUP_LINE = 'We don’t back up data on devices — keep your own copy of anything important.';

  // Deliberately independent of shared/service-status.js: the vocab keys used
  // here (categories, types, item kinds) are the same exact strings, and a
  // catalogue that loads on its own cannot break if the script order changes.

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function trim(v) { return v == null ? '' : String(v).trim(); }

  var PRIORITY_KEYS = ['low', 'normal', 'high', 'urgent'];
  function rankOf(p) { var i = PRIORITY_KEYS.indexOf(p); return i === -1 ? 1 : i; }

  // ── The fault catalogue ────────────────────────────────────────────────────
  // priority: what this fault alone deserves. est_minutes: typical bench /
  // visit time, used for planning only. kinds: the item kinds it applies to
  // ([] = any). keywords: phrases matched whole-word, case-insensitive, by the
  // chat parser and the free-text suggester — keep them specific; a keyword
  // that fires on ordinary chat ("ok", "work") is worse than none.
  var FAULTS = [
    { key: 'no_power', label: 'No power', category: 'repair', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'psu', 'motherboard'],
      checklist: ['Check the wall socket, power cable and the PSU switch', 'Test the PSU with a tester or a known-good unit',
                  'Short the power pins to rule out the front-panel switch', 'Strip to minimum: board, CPU, one RAM stick',
                  'Look for burn marks or swollen capacitors'],
      keywords: ['no power', 'not turning on', 'not switching on', "won't turn on", 'wont turn on', "doesn't turn on",
                 'does not turn on', 'not powering on', 'completely dead', 'pc dead', 'laptop dead', 'system dead',
                 'pc not starting', 'computer not starting', 'system not starting', 'no light'] },

    { key: 'no_display', label: 'No display', category: 'repair', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu', 'monitor', 'motherboard'],
      checklist: ['Confirm the cable is in the graphics card, not the motherboard', 'Try another cable and another monitor',
                  'Reseat the graphics card and RAM', 'Check beep codes or the board debug LEDs',
                  'Test with onboard graphics or a known-good card'],
      keywords: ['no display', 'no signal', 'black screen', 'blank screen', 'nothing on screen', 'nothing on the screen',
                 'display not coming', 'screen not coming', 'no picture', 'display not working'] },

    { key: 'random_restart', label: 'Restarts or shuts down by itself', category: 'repair', priority: 'normal', est_minutes: 120, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'psu', 'motherboard', 'cpu', 'ram'],
      checklist: ['Read Event Viewer for Kernel-Power 41 and WHEA errors', 'Log CPU and GPU temperatures under load',
                  'Stress test the CPU, then the GPU, for 30 minutes', 'Swap in a known-good PSU', 'Run a memory test'],
      keywords: ['restart', 'restarts', 'restarting', 'reboots', 'rebooting', 'shuts down', 'shutting down', 'shuts off',
                 'turns off', 'switches off', 'switching off', 'auto shutdown', 'automatically shut'] },

    { key: 'bsod', label: 'Blue screen (BSOD)', category: 'repair', priority: 'normal', est_minutes: 90, suggest_type: 'in_store',
      kinds: ['pc', 'laptop'],
      checklist: ['Note the stop code and any driver named on the blue screen', 'Read the minidump (WhoCrashed or WinDbg)',
                  'Update or roll back the named driver', 'Run a memory test and an SSD health check',
                  'Remove any overclock and turn XMP / EXPO off to retest'],
      keywords: ['blue screen', 'bsod', 'stop code', 'blue screen error', 'your pc ran into a problem'] },

    { key: 'overheating', label: 'Overheating', category: 'repair', priority: 'normal', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu', 'cpu', 'cooler'],
      checklist: ['Log idle and load temperatures', 'Clean dust from heatsinks, fans and filters',
                  'Check the cooler mount and the fan headers', 'Replace the thermal paste', 'Check the case airflow direction'],
      keywords: ['overheating', 'overheat', 'overheats', 'heating', 'heating up', 'too hot', 'very hot', 'temperature', 'thermal throttling'] },

    { key: 'noisy_fans', label: 'Noisy fans / grinding noise', category: 'maintenance', priority: 'low', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu', 'psu', 'cooler'],
      checklist: ['Find which fan is noisy (stop each one briefly)', 'Clean the fan and check for a cable touching the blades',
                  'Check the fan curve in BIOS or the vendor software', 'Replace the fan if the bearing grinds'],
      keywords: ['noise', 'noisy', 'loud', 'fan noise', 'grinding', 'rattling', 'buzzing', 'whining', 'coil whine', 'fan sound'] },

    { key: 'slow', label: 'Slow or hangs', category: 'repair', priority: 'low', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop'],
      checklist: ['Check startup apps and background usage in Task Manager', 'Check drive health (SMART) and free space',
                  'Scan for malware', 'Check temperatures for throttling', 'Suggest an SSD or RAM upgrade on an old system'],
      keywords: ['slow', 'very slow', 'lag', 'lagging', 'laggy', 'hang', 'hangs', 'hanging', 'freezes', 'freezing',
                 'not responding', 'sluggish'] },

    { key: 'boot_loop', label: 'Boot loop', category: 'repair', priority: 'high', est_minutes: 90, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard', 'ram', 'cpu'],
      checklist: ['Clear CMOS and load BIOS defaults', 'Turn XMP / EXPO off and retest', 'Test RAM one stick at a time',
                  'Check the CPU power cable and the 24-pin', 'Update the BIOS if the CPU is newer than the board'],
      keywords: ['boot loop', 'bootloop', 'keeps restarting', 'restart loop', 'restarting again and again',
                 'stuck on logo', 'stuck at logo', 'stuck on the logo'] },

    { key: 'wont_boot_os', label: "Won't boot into Windows", category: 'os_software', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'ssd', 'hdd'],
      checklist: ['Check the boot drive is detected in BIOS', 'Check the boot order and mode (UEFI / legacy)',
                  'Try Startup Repair from recovery media', 'Check the drive health before any repair',
                  'Check the data answer before a reinstall — we don’t back up'],
      keywords: ['not booting', "won't boot", 'wont boot', "doesn't boot", 'does not boot', 'no bootable device',
                 'boot device not found', 'automatic repair', 'windows not loading', 'windows not starting',
                 'stuck on windows logo'] },

    { key: 'windows_activation', label: 'Windows activation', category: 'os_software', priority: 'low', est_minutes: 20, suggest_type: 'remote',
      kinds: ['pc', 'laptop'],
      checklist: ['Check the installed edition against the licence bought', "Check the digital licence is linked to the customer's Microsoft account",
                  'Enter or re-enter the product key', 'Run the activation troubleshooter after a hardware change'],
      keywords: ['activation', 'activate windows', 'not activated', 'windows not activated', 'product key',
                 'license key', 'licence key', 'activate'] },

    { key: 'os_reinstall', label: 'Fresh Windows install', category: 'os_software', priority: 'normal', est_minutes: 90, suggest_type: 'remote',
      kinds: ['pc', 'laptop', 'ssd'],
      checklist: ['Check the customer backed up their data — we don’t back it up', 'Note the licences and software the customer needs',
                  'Install Windows and the latest updates', 'Install chipset, graphics and network drivers',
                  'Check the customer’s software and licences work'],
      keywords: ['format', 'formatting', 'reinstall', 're-install', 'fresh install', 'install windows',
                 'windows installation', 'os installation', 'reset pc', 'factory reset', 'reinstall windows', 'clean install'] },

    { key: 'virus_malware', label: 'Virus, malware or pop-ups', category: 'os_software', priority: 'normal', est_minutes: 60, suggest_type: 'remote',
      kinds: ['pc', 'laptop'],
      checklist: ['Disconnect shared drives before scanning', 'Full scan with Defender plus a second-opinion scanner',
                  'Remove unwanted extensions and startup entries', 'Reset the browsers and advise a password change',
                  'Check for ransomware notes before touching any files'],
      keywords: ['virus', 'viruses', 'malware', 'popup', 'popups', 'pop-up', 'pop-ups', 'pop up', 'pop ups', 'adware',
                 'hacked', 'ransomware', 'trojan', 'unwanted ads'] },

    { key: 'driver_crash', label: 'Driver problems', category: 'os_software', priority: 'normal', est_minutes: 45, suggest_type: 'remote',
      kinds: ['pc', 'laptop', 'gpu', 'peripheral'],
      checklist: ['Note the device and the error in Device Manager', 'Remove the old driver cleanly (DDU for graphics)',
                  "Install the vendor's current driver", 'Check Windows Update has not replaced it'],
      keywords: ['driver', 'drivers', 'driver error', 'driver crash', 'driver issue', 'device manager',
                 'display driver', 'driver not working'] },

    { key: 'game_crash', label: 'Games crash or stutter', category: 'repair', priority: 'normal', est_minutes: 90, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu'],
      checklist: ['Note which games crash and when (loading, menu, after some minutes)', 'Log GPU and CPU temperatures and clocks while gaming',
                  'Clean-install the graphics driver', 'Run a GPU stress test', 'Check PSU wattage and the card power cables'],
      keywords: ['game crash', 'games crash', 'game crashing', 'games crashing', 'crashing in games', 'crash in game',
                 'stutter', 'stuttering', 'fps drop', 'fps drops', 'low fps', 'game closes'] },

    { key: 'no_internet', label: 'No internet / LAN not working', category: 'networking', priority: 'normal', est_minutes: 30, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard'],
      checklist: ['Check the cable and the router lights', 'Check the adapter in Device Manager',
                  'Reinstall the network driver', 'Reset the network stack (Network reset)'],
      keywords: ['no internet', 'internet not working', 'lan not working', 'ethernet', 'network not working',
                 'no network', 'lan port', 'internet issue'] },

    { key: 'wifi_issue', label: 'Wi-Fi or Bluetooth not working', category: 'networking', priority: 'normal', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard', 'peripheral'],
      checklist: ['Check the antenna is fitted (desktops)', 'Check the adapter is enabled and the driver loaded',
                  'Test against a known-good network', 'Update the Wi-Fi / Bluetooth driver',
                  'Check airplane mode and the BIOS wireless setting'],
      keywords: ['wifi', 'wi-fi', 'wireless', 'bluetooth', 'wifi not working', 'wifi disconnecting', 'no wifi', 'weak signal'] },

    { key: 'network_setup', label: 'Network or router setup', category: 'networking', priority: 'normal', est_minutes: 90, suggest_type: 'on_site',
      kinds: [],
      checklist: ['Note the ISP, the router model and the rooms to cover', 'Set up the router: name, password, WPA2 / WPA3',
                  'Set up mesh or access points if needed', 'Test the speed in each room and note it',
                  'Leave the customer the Wi-Fi details in writing'],
      keywords: ['router', 'router setup', 'network setup', 'mesh', 'access point', 'lan cabling', 'office network',
                 'wifi setup', 'wi-fi setup', 'new connection'] },

    { key: 'printer_setup', label: 'Printer setup', category: 'installation', priority: 'low', est_minutes: 45, suggest_type: 'on_site',
      kinds: ['peripheral'],
      checklist: ['Note the printer model and how it connects (USB / Wi-Fi)', "Install the vendor's driver and software",
                  'Add the printer on each PC that needs it', 'Print a test page from each PC'],
      keywords: ['printer', 'printers', 'printing', 'printer setup', 'printer not working', 'print out', 'scanner setup'] },

    { key: 'data_recovery', label: 'Data recovery', category: 'data_recovery', priority: 'high', est_minutes: 180, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'ssd', 'hdd'],
      checklist: ['Stop using the drive: do not install or repair anything on it', 'Check the drive is detected and read its SMART health',
                  'Image the drive first if it is failing', 'Recover to a separate drive and check the files open',
                  'Agree with the customer what counts as success'],
      keywords: ['data recovery', 'recover data', 'recover files', 'recover my files', 'lost data', 'lost my data',
                 'deleted files', 'files missing', 'recover photos', 'corrupted drive', 'data lost'] },

    { key: 'liquid_spill', label: 'Liquid spill', category: 'repair', priority: 'urgent', est_minutes: 120, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'peripheral', 'monitor'],
      checklist: ['Do not power it on; disconnect the battery first', 'Open it up and photograph the affected area',
                  'Clean with isopropyl alcohol and dry it fully', 'Check the board and connectors for corrosion',
                  'Test only after it is completely dry'],
      keywords: ['spill', 'spilled', 'spilt', 'liquid spill', 'liquid damage', 'liquid fell', 'water fell', 'water spill',
                 'water damage', 'water inside', 'coffee', 'tea fell', 'wet', 'juice'] },

    { key: 'physical_damage', label: 'Physical damage', category: 'repair', priority: 'normal', est_minutes: 60, suggest_type: 'in_store',
      kinds: [],
      checklist: ['Photograph the damage before anything else', 'List what is broken (panel, port, hinge, case)',
                  'Check it still powers on and works', 'Quote parts and labour'],
      keywords: ['broken', 'broke', 'cracked', 'crack', 'damaged', 'fell down', 'dropped', 'bent', 'physical damage'] },

    { key: 'upgrade_request', label: 'Upgrade', category: 'upgrade', priority: 'low', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu', 'ram', 'ssd', 'cpu', 'psu', 'cooler', 'motherboard'],
      checklist: ['Note what the customer wants better (games, editing, storage)', 'Check compatibility: socket, board, PSU wattage, case size',
                  'Quote the parts and the labour', 'Back up first if the boot drive changes', 'Benchmark before and after'],
      keywords: ['upgrade', 'upgrading', 'add ram', 'more ram', 'increase ram', 'add ssd', 'add storage',
                 'new graphics card', 'better performance'] },

    { key: 'cleaning_maintenance', label: 'Cleaning / servicing', category: 'maintenance', priority: 'low', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu', 'cooler'],
      checklist: ['Photograph it before cleaning', 'Blow out dust from fans, filters and heatsinks',
                  'Replace the thermal paste if temperatures are high', 'Check every fan spins and the cables are tidy',
                  'Log temperatures before and after'],
      keywords: ['cleaning', 'clean my pc', 'clean the pc', 'dust', 'dusty', 'servicing', 'general service', 'maintenance', 'thermal paste'] },

    { key: 'new_installation', label: 'New PC installation at site', category: 'installation', priority: 'normal', est_minutes: 90, suggest_type: 'on_site',
      kinds: ['pc', 'monitor', 'peripheral'],
      checklist: ['Unbox and check for transit damage', 'Set up the PC, monitor and peripherals',
                  "Connect to the customer's network and sign in", "Install the customer's software and update Windows",
                  'Walk the customer through it and get sign-off'],
      keywords: ['installation at home', 'install at home', 'home installation', 'setup at home', 'set up at home',
                 'new pc setup', 'delivery and setup', 'on site installation', 'onsite installation', 'office installation'] },

    { key: 'ram_fault', label: 'RAM fault', category: 'repair', priority: 'normal', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'ram', 'motherboard'],
      checklist: ['Run MemTest86 for at least one full pass', 'Test each stick alone in a known-good slot',
                  'Retest at stock speed with XMP / EXPO off', 'Note the serial if the stick goes for RMA'],
      keywords: ['memory error', 'ram problem', 'ram issue', 'ram error', 'ram not detected', 'faulty ram', 'ram faulty',
                 'memtest', 'memory management'] },

    { key: 'ssd_fault', label: 'SSD or hard drive fault', category: 'repair', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'ssd', 'hdd'],
      checklist: ['Check the drive is detected in BIOS', 'Read SMART health and wear (CrystalDiskInfo)',
                  'Check the firmware and the cable or M.2 slot', 'Check the data answer before any test that writes to it',
                  'Note the serial if the drive goes for RMA'],
      keywords: ['ssd not detected', 'ssd problem', 'ssd issue', 'ssd failed', 'ssd dead', 'hard disk problem', 'hard disk issue',
                 'hard disk not detected', 'hdd not detected', 'hdd problem', 'drive not detected', 'disk not detected',
                 'disk error', 'disk 100%', 'clicking sound', 'storage not showing', 'bad sectors'] },

    { key: 'gpu_artifacts', label: 'Graphics card artifacts', category: 'repair', priority: 'high', est_minutes: 90, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'gpu'],
      checklist: ['Photograph or film the artifacts', 'Clean-install the driver and retest',
                  'Run a GPU stress test and watch the temperatures', 'Test the card in a known-good PC',
                  'Check the hotspot and memory junction temperatures'],
      keywords: ['artifacts', 'artifact', 'artefacts', 'artifacting', 'glitch', 'glitches', 'glitching', 'lines on screen',
                 'lines on the screen', 'colour lines', 'color lines', 'checkerboard', 'gpu problem', 'gpu issue',
                 'graphics card problem', 'graphics card issue', 'graphics problem'] },

    { key: 'psu_fault', label: 'Power supply fault', category: 'repair', priority: 'high', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['pc', 'psu'],
      checklist: ['Test with a PSU tester and under load', 'Check for a burnt smell, noise or swollen capacitors',
                  "Check every cable is the PSU's own (modular cables are not interchangeable)", 'Note the serial if it goes for RMA'],
      keywords: ['smps', 'burning smell', 'burnt smell', 'smoke', 'sparks', 'spark', 'psu problem', 'psu issue', 'psu dead',
                 'psu fault', 'psu not working', 'power supply problem', 'power supply issue', 'power supply dead'] },

    { key: 'usb_ports', label: 'USB ports not working', category: 'repair', priority: 'low', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard', 'peripheral'],
      checklist: ['Test each port with a known-good device', 'Check the front-panel USB headers are connected',
                  'Check USB drivers and power management settings', 'Look for bent pins or a loose port'],
      keywords: ['usb', 'usb port', 'usb ports', 'usb not working', 'port not working', 'pendrive', 'pen drive', 'type-c', 'type c'] },

    { key: 'audio_issue', label: 'No sound / audio problem', category: 'repair', priority: 'low', est_minutes: 30, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard', 'peripheral'],
      checklist: ['Check the output device selected in Windows', 'Test the front and rear audio jacks',
                  'Reinstall the audio driver', 'Check the front-panel audio header'],
      keywords: ['no sound', 'sound not working', 'audio', 'speaker not working', 'speakers not working', 'headphone',
                 'headphones', 'headset', 'mic not working', 'microphone'] },

    { key: 'monitor_issue', label: 'Monitor problem', category: 'repair', priority: 'normal', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['monitor', 'pc'],
      checklist: ['Test with another cable and another source', 'Check the refresh rate and resolution settings',
                  'Look for dead pixels, lines or backlight bleed and photograph them', "Check the monitor's own menu and power LED",
                  'Note the serial if it goes for RMA'],
      keywords: ['monitor not working', 'monitor problem', 'monitor issue', 'dead pixel', 'dead pixels', 'backlight',
                 'monitor flickering', 'lines on monitor', 'flickering'] },

    { key: 'laptop_battery', label: 'Laptop battery or charging', category: 'repair', priority: 'normal', est_minutes: 45, suggest_type: 'in_store',
      kinds: ['laptop'],
      checklist: ['Check battery health (powercfg /batteryreport)', 'Test with a known-good charger',
                  'Check the charging port and DC jack', 'Look for a swollen battery and do not charge it if swollen'],
      keywords: ['battery', 'not charging', 'charging issue', 'battery drain', 'battery draining', 'swollen battery',
                 'plugged in not charging', 'charger not working'] },

    { key: 'laptop_keyboard', label: 'Laptop keyboard or touchpad', category: 'repair', priority: 'normal', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['laptop'],
      checklist: ['Test every key with a keyboard tester', 'Check for liquid residue under the keys',
                  'Test with an external keyboard to rule out software', 'Quote a replacement keyboard if keys are dead'],
      keywords: ['keyboard not working', 'keyboard problem', 'keyboard issue', 'keys not working', 'key not working',
                 'touchpad', 'trackpad', 'touch pad'] },

    { key: 'laptop_screen', label: 'Laptop screen broken or flickering', category: 'repair', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['laptop'],
      checklist: ['Photograph the screen damage', 'Test with an external monitor to rule out the board',
                  'Check the display cable and the hinge', 'Quote the exact panel (model, resolution, refresh, connector)'],
      keywords: ['laptop screen', 'screen broken', 'broken screen', 'cracked screen', 'screen cracked', 'display broken',
                 'screen flickering', 'hinge', 'screen damaged'] },

    // Beyond the required list: common counter requests that otherwise fall
    // into "other" and lose their priority and checklist.
    { key: 'warranty_part', label: 'Part failed — warranty claim', category: 'warranty_claim', priority: 'normal', est_minutes: 30, suggest_type: 'in_store',
      kinds: ['gpu', 'psu', 'ram', 'ssd', 'hdd', 'motherboard', 'cpu', 'cooler', 'monitor', 'peripheral'],
      checklist: ['Confirm the fault on our test bench', 'Photograph the serial label and the part',
                  'Check where and when it was bought (invoice)', "Check the vendor's warranty terms"],
      keywords: ['warranty', 'under warranty', 'warranty claim', 'rma'] },

    { key: 'general_checkup', label: 'Check-up / not sure what is wrong', category: 'diagnosis_only', priority: 'low', est_minutes: 45, suggest_type: 'in_store',
      kinds: [],
      checklist: ["Write down the customer's exact symptoms and when they happen", 'Run a full hardware health check (drives, RAM, temperatures)',
                  'Check Event Viewer for errors', 'Report findings before doing any paid work'],
      keywords: ['check up', 'checkup', 'diagnosis', 'not sure what', 'some problem', 'full check'] },

    { key: 'data_transfer', label: 'Data backup or transfer', category: 'data_recovery', priority: 'normal', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'ssd', 'hdd'],
      checklist: ['Agree exactly what to copy (folders, mail, browser data)', 'Check the destination drive has room',
                  'Copy and verify file counts', 'Show the customer the copied data before wiping anything'],
      keywords: ['backup', 'back up', 'data transfer', 'transfer data', 'copy data', 'move data', 'clone', 'cloning'] },

    { key: 'software_install', label: 'Install software', category: 'os_software', priority: 'low', est_minutes: 30, suggest_type: 'remote',
      kinds: ['pc', 'laptop'],
      checklist: ['Confirm the customer owns a licence for the software', 'Download from the official vendor site only',
                  'Install and activate', 'Check it opens and works for the customer'],
      keywords: ['install software', 'software installation', 'install office', 'ms office', 'microsoft office', 'install app', 'tally'] },

    { key: 'bios_update', label: 'BIOS update or settings', category: 'maintenance', priority: 'low', est_minutes: 30, suggest_type: 'in_store',
      kinds: ['pc', 'laptop', 'motherboard'],
      checklist: ['Note the current BIOS version and the CPU', 'Check the update is for this exact board revision',
                  'Update on a stable power supply (UPS)', 'Re-apply XMP / EXPO and boot settings afterwards'],
      keywords: ['bios', 'bios update', 'uefi', 'xmp', 'expo', 'bios settings'] },

    { key: 'cooler_aio', label: 'Liquid cooler (AIO) problem', category: 'repair', priority: 'high', est_minutes: 60, suggest_type: 'in_store',
      kinds: ['pc', 'cooler'],
      checklist: ['Check for any leak before powering on', 'Check the pump runs (pump speed in BIOS)',
                  'Check the radiator fans and the tubing', 'Log CPU temperature at idle and under load',
                  'Note the serial if it goes for RMA'],
      keywords: ['aio', 'liquid cooler', 'water cooler', 'pump not working', 'pump noise', 'cooler leak', 'leaking'] }
  ];

  var FAULT_INDEX = {};
  FAULTS.forEach(function (f) { FAULT_INDEX[f.key] = f; });

  function fault(key) { return has(FAULT_INDEX, key) ? FAULT_INDEX[key] : null; }

  function _known(faultKeys) {
    if (!Array.isArray(faultKeys)) return [];
    var seen = {}, out = [];
    faultKeys.forEach(function (k) {
      if (has(FAULT_INDEX, k) && !seen[k]) { seen[k] = true; out.push(FAULT_INDEX[k]); }
    });
    return out;
  }

  // Remote work is only honest for problems a remote session can fix. Every
  // other fault is hidden from the chip list on a remote ticket (the free text
  // still takes anything).
  var REMOTE_OK = ['windows_activation', 'os_reinstall', 'virus_malware', 'driver_crash', 'slow', 'bsod',
                   'software_install', 'printer_setup', 'wifi_issue', 'game_crash', 'general_checkup'];

  // Chips to offer for the items and type on the form. kinds: item kinds on the
  // ticket ([] = show all). A fault with kinds [] applies to anything.
  function faultsFor(kinds, type) {
    var ks = Array.isArray(kinds) ? kinds.filter(Boolean) : (kinds ? [kinds] : []);
    return FAULTS.filter(function (f) {
      if (type === 'remote' && REMOTE_OK.indexOf(f.key) === -1) return false;
      if (!ks.length || !f.kinds.length) return true;
      return f.kinds.some(function (k) { return ks.indexOf(k) !== -1; });
    });
  }

  // ── Priority ───────────────────────────────────────────────────────────────
  // The rule is deliberately small and explainable: the counter sees every
  // reason, and a lead can override it with a reason of their own.
  function computePriority(faultKeys, ctx) {
    var c = ctx || {};
    var reasons = [];
    var picked = _known(faultKeys);
    var rank = 1; // normal
    if (picked.length) {
      rank = 0;
      picked.forEach(function (f) { rank = Math.max(rank, rankOf(f.priority)); });
      var top = picked.filter(function (f) { return rankOf(f.priority) === rank; });
      top.slice(0, 2).forEach(function (f) { reasons.push(f.label); });
    }

    var machines = Number(c.machines) || 0;
    if (c.service_type === 'on_site' && (c.business || machines >= 3)) {
      rank += 1;
      if (c.business && machines >= 3) reasons.push('Business site, ' + machines + ' machines');
      else if (c.business) reasons.push('Business site');
      else reasons.push(machines + ' machines on site');
    }
    if (c.built_by_us_in_warranty) { rank += 1; reasons.push('Our build, still in warranty'); }
    if (c.repeat_within_30d) { rank += 1; reasons.push('Repeat visit within 30 days'); }
    // SPEC-GAP: item_purchase_source is accepted in ctx but the rule does not
    // use it on its own — "built by us AND in warranty" is the signal, and the
    // caller works that out (it needs the build date).

    var needed = c.needed_by ? new Date(c.needed_by).getTime() : NaN;
    if (!isNaN(needed)) {
      var now = (c.now != null) ? Number(c.now) : Date.now();
      if (needed - now <= 48 * HOUR) {
        rank = 3;
        reasons.push(needed <= now ? 'Needed-by date has passed' : 'Needed within 48 hours');
      }
    }
    if (rank > 3) rank = 3;
    if (rank < 0) rank = 0;
    return { priority: PRIORITY_KEYS[rank], reasons: reasons };
  }

  // The type most of the picked faults point at. Ties go to the type that
  // puts hands on the machine (in-store, then on-site): a remote session
  // cannot fix a dead PSU, but a bench can fix a driver.
  function suggestType(faultKeys) {
    var picked = _known(faultKeys);
    if (!picked.length) return 'in_store';
    var count = { in_store: 0, on_site: 0, remote: 0 };
    picked.forEach(function (f) { if (has(count, f.suggest_type)) count[f.suggest_type]++; });
    var order = ['in_store', 'on_site', 'remote'];
    var best = 'in_store';
    order.forEach(function (t) { if (count[t] > count[best]) best = t; });
    return best;
  }

  function estMinutes(faultKeys) {
    var picked = _known(faultKeys);
    if (!picked.length) return 60;
    return picked.reduce(function (m, f) { return Math.max(m, Number(f.est_minutes) || 0); }, 0) || 60;
  }

  function mergeChecklists(faultKeys) {
    var seen = {}, out = [];
    _known(faultKeys).forEach(function (f) {
      f.checklist.forEach(function (step) {
        var k = trim(step).toLowerCase().replace(/\s+/g, ' ');
        if (k && !seen[k]) { seen[k] = true; out.push(trim(step)); }
      });
    });
    return out;
  }

  // ── Intake chips and fees ─────────────────────────────────────────────────
  var ACCESSORIES = ['Power cable', 'Charger', 'Bag', 'Box', 'Keyboard', 'Mouse', 'Wi-Fi antenna',
                     'HDMI / DP cable', 'Drive', 'Manual'];

  var CONDITION_CHIPS = ['No visible damage', 'Scratches', 'Dents', 'Cracked panel', 'Missing screws',
                         'Broken clip', 'Liquid marks', 'Burn marks', 'Seal broken', 'Dusty'];

  // Paid handling service for parts bought elsewhere. The server applies the
  // default when none is sent; the form proposes the per-kind amount.
  var DEFAULT_HANDLING_FEE = 300;
  var HANDLING_FEE_BY_KIND = {
    gpu: 500, motherboard: 400, psu: 300, ram: 200, ssd: 200, hdd: 200,
    cpu: 400, monitor: 500, laptop: 500, other: 300
  };
  function handlingFee(kind) {
    return has(HANDLING_FEE_BY_KIND, kind) ? HANDLING_FEE_BY_KIND[kind] : DEFAULT_HANDLING_FEE;
  }

  // ── Our workmanship warranty on a build (A20) ─────────────────────────────
  // Six months from the day the customer took the build home; from the day
  // it was completed when the hand-over was never recorded.
  var OUR_WARRANTY_MONTHS = 6;

  function _time(v) {
    if (v == null || v === '') return NaN;
    return (v instanceof Date) ? v.getTime() : new Date(v).getTime();
  }

  // The ISO end of our warranty, or null when the build has neither date.
  // Calendar months in local time; a day the target month lacks clamps to its
  // last day (31 Aug + 6 months is 28/29 Feb, not 3 Mar).
  function ourWarrantyUntil(handedOverAt, completedAt) {
    var t = _time(handedOverAt);
    if (isNaN(t)) t = _time(completedAt);
    if (isNaN(t)) return null;
    var d = new Date(t);
    var day = d.getDate();
    d.setMonth(d.getMonth() + OUR_WARRANTY_MONTHS);
    if (d.getDate() < day) d.setDate(0);
    return d.toISOString();
  }

  // ── WhatsApp message templates ─────────────────────────────────────────────
  // Plain text for wa.me (the caller URL-encodes it). No emoji, no
  // exclamation marks, no "please" — the same copy rules as the app. Every
  // message names the code, the tracking link and how to open it, because the
  // customer reads it days later with no other context. Free text is clipped
  // so no message can pass 600 characters whatever was typed into a name.

  function clip(v, n) {
    var s = trim(v).replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
  }
  function firstName(full) {
    var s = clip(full, 60).replace(/^(dr|mr|mrs|ms|miss)\.?\s+/i, '');
    var f = s.split(' ')[0] || '';
    return f;
  }
  // "Hi Kerala," would be wrong for a company, so a business-looking name is
  // greeted whole (up to its first comma: "Sreekumar Computers, Thrissur").
  var BUSINESS_RE = /(^|[^a-z])(co|company|corp|corporation|ltd|limited|pvt|llp|inc|computers|systems|technologies|infotech|solutions|services|traders|enterprises|agencies|associates|industries|clinic|hospital|cafe|café|restaurant|hotel|school|college|office|stores?|mart|studio|labs?)(?=$|[^a-z])/i;
  function hello(name) {
    var full = clip(name, 60);
    if (full && BUSINESS_RE.test(full)) {
      var biz = full.split(',')[0].replace(/[\s,]+$/, '');
      return 'Hi ' + biz + ',';
    }
    var f = firstName(full);
    return f ? 'Hi ' + f + ',' : 'Hello,';
  }

  function trackLink(code) { return TRACK_BASE + encodeURIComponent(trim(code)); }

  function footer(code) {
    var c = clip(code, 20);
    return 'Code: ' + c + '\nTrack it here: ' + trackLink(c) + '\n' + PHONE_LINE + '\n— ' + SHOP;
  }

  function deviceOf(job) {
    var d = clip(job && job.device_label, 70);
    return d || 'device';
  }

  // How a part reads inside a sentence: "your ASUS RTX 4070 Ti graphics card",
  // not "your Graphics card — ASUS RTX 4070 Ti". A label the caller already has
  // (the public RPC's) wins. Never the serial.
  var KIND_NOUN = {
    pc: 'PC', laptop: 'laptop', gpu: 'graphics card', psu: 'power supply', ram: 'RAM', ssd: 'SSD',
    hdd: 'hard drive', motherboard: 'motherboard', cpu: 'processor', cooler: 'cooler', monitor: 'monitor',
    peripheral: '', other: ''
  };
  function unitThing(unit) {
    var u = unit || {};
    var lab = trim(u.label);
    if (!lab) {
      var b = trim(u.brand), m = trim(u.model);
      if (b && m && m.toLowerCase().indexOf(b.toLowerCase() + ' ') === 0) b = '';
      var bm = [b, m].filter(Boolean).join(' ');
      var noun = has(KIND_NOUN, u.kind) ? KIND_NOUN[u.kind] : '';
      if (noun && bm.toLowerCase().slice(-noun.length) === noun.toLowerCase()) noun = '';
      lab = [bm, noun].filter(Boolean).join(' ');
    }
    return clip(lab || 'part', 70);
  }
  function unitName(unit) { return (unit && (unit.owner_name || unit.sender_name)) || ''; }
  // ", with DTDC, AWB 123" — or nothing when no AWB was recorded (a vendor
  // shipping straight to the customer does not always share one).
  function shippedBy(unit) {
    var u = unit || {};
    var awb = clip(u.return_awb, 30);
    if (!awb) return '';
    return ' with ' + (clip(u.return_courier, 30) || 'the courier') + ', AWB ' + awb;
  }

  function fmtDay(ms) {
    try { return new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (e) { return ''; }
  }
  function fmtClock(ms) {
    try { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }); }
    catch (e) { return ''; }
  }
  // "Thu, 23 Oct, 2:00 pm to 4:00 pm". Local time, as everywhere on screen.
  function visitText(startIso, endIso) {
    var s = startIso ? new Date(startIso).getTime() : NaN;
    if (isNaN(s)) return '';
    var e = endIso ? new Date(endIso).getTime() : NaN;
    var out = fmtDay(s) + ', ' + fmtClock(s);
    if (!isNaN(e) && e > s) {
      out += new Date(e).toDateString() === new Date(s).toDateString()
        ? ' to ' + fmtClock(e)
        : ' to ' + fmtDay(e) + ', ' + fmtClock(e);
    }
    return out;
  }

  function msg(lines) { return lines.filter(function (l) { return l != null && l !== ''; }).join('\n'); }

  var WA_TEMPLATES = {
    created: function (job) {
      var j = job || {};
      var t = j.service_type || 'in_store';
      var body;
      if (t === 'on_site') {
        body = 'We have logged your on-site service request' + (j.site_area ? ' for ' + clip(j.site_area, 40) : '') +
               '. We will call you to fix a visit time.';
      } else if (t === 'remote') {
        body = 'We have logged your remote support request. A technician will contact you to start the session. ' +
               'We never ask for your passwords.';
      } else if (j.stage === 'logged') {
        body = 'We have logged your service request for your ' + deviceOf(j) + '. Bring it to the shop whenever it suits you.';
      } else {
        body = 'We have received your ' + deviceOf(j) + ' for service. We will update you after we have checked it.';
      }
      // In-store only: the device is (or will be) in our hands, and the shop
      // never backs up what is on it (sql/service-v2.1.sql). Said in writing,
      // before the work starts.
      var dataLine = (t === 'on_site' || t === 'remote') ? '' : NO_BACKUP_LINE;
      return msg([hello(j.customer_name), 'Thank you for choosing ' + SHOP + '. ' + body, dataLine, footer(j.public_code)]);
    },

    quote: function (job, amountText) {
      var j = job || {};
      var amt = clip(amountText, 40);
      return msg([hello(j.customer_name),
        'We have checked your ' + deviceOf(j) + '. The repair will cost ' + (amt || 'the amount we discussed') + '.',
        'Reply YES to go ahead, or call us if you have any questions.',
        footer(j.public_code)]);
    },

    ready: function (job) {
      var j = job || {};
      var t = j.service_type || 'in_store';
      var body;
      if (t === 'on_site') body = 'The work on your service request is complete.';
      else if (t === 'remote') body = 'Your remote support request is complete.';
      else if (j.outcome === 'returned_rma_pending') {
        body = 'Your ' + deviceOf(j) + ' is ready to collect. The part under warranty claim will follow separately; we will message you when it is back.';
      } else body = 'Your ' + deviceOf(j) + ' is ready to collect from ' + SHOP + '.';
      return msg([hello(j.customer_name), body, footer(j.public_code)]);
    },

    visit_booked: function (job) {
      var j = job || {};
      var when = visitText(j.visit_start, j.visit_end);
      var body = (j.service_type === 'remote')
        ? (when ? 'Your remote session is booked for ' + when + '.' : 'Your remote session is booked. We will confirm the time shortly.')
        : (when ? 'Your visit is booked for ' + when + '. Our technician will message you before leaving.'
                : 'Your visit is booked. We will confirm the time shortly.');
      return msg([hello(j.customer_name), body, footer(j.public_code)]);
    },

    on_the_way: function (job, techFirstName) {
      var j = job || {};
      var who = clip(techFirstName, 30) || 'Our technician';
      var start = j.visit_start ? new Date(j.visit_start).getTime() : NaN;
      var body = who + ' from ' + SHOP + ' is on the way to you now' +
                 (!isNaN(start) ? ' for your ' + fmtClock(start) + ' visit.' : '.');
      return msg([hello(j.customer_name), body, footer(j.public_code)]);
    },

    rma_received: function (unit) {
      var u = unit || {};
      var body = 'We have received your ' + unitThing(u) + ' for the warranty claim. We will check it and keep you updated.';
      return msg([hello(unitName(u)), body, footer(u.public_code)]);
    },

    // A13: the customer hears the part's own brand when we know it — never a
    // distributor's name, which the caller may have passed as vendorName.
    rma_sent: function (unit, vendorName) {
      var u = unit || {};
      var v = clip(trim(u.brand) || vendorName, 40) || 'the manufacturer';
      return msg([hello(unitName(u)),
        'Your ' + unitThing(u) + ' has been sent to ' + v + ' under warranty. We will message you as soon as it is back.',
        footer(u.public_code)]);
    },

    rma_back: function (unit) {
      var u = unit || {};
      var r = u.vendor_result;
      var maker = clip(u.brand, 30);
      var who = maker || 'The manufacturer';
      var outcome = r === 'replaced' ? who + ' replaced it.'
        : r === 'repaired' ? who + ' repaired it.'
        : r === 'credit_note' ? who + ' settled the claim by credit. We will call you about the next step.'
        : r === 'rejected' ? who + ' declined the warranty claim. We will call you to explain the options.'
        : r === 'lost' ? who + ' could not return it. We will call you about the next step.'
        : r === 'shipped_to_customer' ? who + ' is sending it straight to you' + shippedBy(u) +
                                        '. Tell us when it arrives so we can close the claim.'
        : '';
      // A10: a part the vendor ships to the customer never comes back to us.
      var lead = (r === 'lost' || r === 'shipped_to_customer') ? 'An update on your ' + unitThing(u) + '.'
                                                               : 'Your ' + unitThing(u) + ' is back from the manufacturer.';
      return msg([hello(unitName(u)), lead + (outcome ? ' ' + outcome : ''), footer(u.public_code)]);
    },

    rma_ready: function (unit) {
      var u = unit || {};
      var thing = unitThing(u);
      var body;
      if (u.stage === 'returning') {
        var from = u.vendor_result === 'shipped_to_customer' ? ' from ' + (clip(u.brand, 30) || 'the manufacturer') : '';
        body = 'Your ' + thing + ' is on its way back to you' + from + shippedBy(u) + '.';
      } else if (u.return_method === 'courier') {
        body = 'Your ' + thing + ' is being packed and will be couriered back to you. We will send the AWB once it leaves.';
      } else if (u.return_method === 'with_device') {
        body = 'Your ' + thing + ' is being fitted back in your device.';
      } else {
        body = 'Your ' + thing + ' is ready to collect from ' + SHOP + '. Bring this message or the code below.';
      }
      return msg([hello(unitName(u)), body, footer(u.public_code)]);
    },

    reminder_collect: function (job) {
      var j = job || {};
      var since = j.ready_at ? new Date(j.ready_at).getTime() : NaN;
      var body = 'A reminder that your ' + deviceOf(j) + ' is ready to collect from ' + SHOP +
                 (!isNaN(since) ? ' since ' + fmtDay(since) : '') + '. Reply here if you would like us to keep it for a particular day.';
      return msg([hello(j.customer_name), body, footer(j.public_code)]);
    }
  };

  // ── Keyword matching ──────────────────────────────────────────────────────
  // Whole-word, case-insensitive. Text is normalised first so a curly
  // apostrophe from a phone keyboard matches "won't" and line breaks never
  // split a phrase.
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[‐-―]/g, '-')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var KEYWORD_RES = FAULTS.map(function (f) {
    return f.keywords.map(function (k) {
      // (^|non-word) keyword (non-word|$). No lookbehind: older Safari on the
      // website would refuse to parse the whole file.
      return new RegExp('(^|[^a-z0-9])' + escRe(normText(k)) + '(?=$|[^a-z0-9])');
    });
  });

  // Fault keys whose keywords appear in the text, ordered by where they first
  // appear (the customer's main complaint usually comes first).
  function matchFaults(text) {
    var t = normText(text);
    if (!t) return [];
    var hits = [];
    FAULTS.forEach(function (f, i) {
      var best = -1;
      KEYWORD_RES[i].forEach(function (re) {
        var m = re.exec(t);
        if (m) {
          var pos = m.index + m[1].length;
          if (best === -1 || pos < best) best = pos;
        }
      });
      if (best !== -1) hits.push({ key: f.key, pos: best, order: i });
    });
    hits.sort(function (a, b) { return a.pos - b.pos || a.order - b.order; });
    return hits.map(function (h) { return h.key; });
  }

  // ── Phones (SPEC-AMENDMENTS A1', the one rule everywhere) ───────────────────
  // This is the single JS copy: the app (NeoQcUI, the intake, the RMA desk),
  // the demo data and the website delegate here when it is loaded, and SQL
  // norm_phone() / phone_ok() implement the same rule. tests/sql-parity runs
  // the SQL and this on the same inputs; tests/phone-copies checks every
  // inline JS copy against this one. The country code is KEPT, so a Gulf or
  // NRI customer's number is never cut down to ten digits that belong to
  // someone in India.
  //
  // normPhone: digits only; a leading 00 (the international prefix) is
  // dropped; then 10 digits → 91 + d, and 11 digits starting with 0 → 91 + the
  // last 10. Anything else keeps its digits (already international, or short).
  //   '+91 98470 12345', '098470 12345', '0091 98470 12345' → '919847012345'
  //   '+971 50 123 4567', '00971501234567'                  → '971501234567'
  function normPhone(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }

  // Kuwait, Oman, Bahrain and Qatar numbers are a 3-digit country code plus 8
  // digits: 11 in all. They are the only 11-digit numbers accepted, so an
  // Indian mobile typed with one digit too many (98470123456) is still refused.
  var ELEVEN_DIGIT_CODES = Object.freeze(['965', '968', '973', '974']);

  // phoneOk takes a NORMALISED number (normPhone's output): 12 to 15 digits,
  // or 11 digits under one of the codes above. Nothing else.
  function phoneOk(norm) {
    var d = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(d)) return false;
    if (d.length >= 12 && d.length <= 15) return true;
    return d.length === 11 && ELEVEN_DIGIT_CODES.indexOf(d.slice(0, 3)) !== -1;
  }

  // As typed — the same answer as SQL phone_ok(raw).
  function isValidPhone(raw) { return phoneOk(normPhone(raw)); }

  // ── WhatsApp chat parser ──────────────────────────────────────────────────
  // Accepts an exported chat (or messages copied out of WhatsApp) and pulls
  // out the customer's phone, name and the first things they said. The staff
  // member confirms every field — this only saves typing.
  //
  // Formats recognised (one header per message; following lines continue it):
  //   Android 12 h   21/10/26, 10:14 am - Name: text
  //   Android 24 h   21/10/2026, 22:14 - +91 98470 12345: text
  //   iPhone         [21/10/26, 10:14:05 AM] Name: text
  //   copied         [10:14 am, 21/10/2026] Name: text
  //
  // opts.shopNames (optional): staff names the shop phone may be saved as,
  // e.g. ['Anagha K C'], so their messages are never read as the customer's.
  var DATE = '(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{2,4})';
  var TIME = '(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:\\s*([ap])\\.?\\s?m\\.?)?';
  var RE_ANDROID = new RegExp('^' + DATE + ',?\\s+' + TIME + '\\s*[-\\u2013\\u2014]\\s+(.*)$', 'i');
  var RE_IPHONE  = new RegExp('^\\[' + DATE + ',?\\s+' + TIME + '\\]\\s*(.*)$', 'i');
  var RE_COPIED  = new RegExp('^\\[' + TIME + ',\\s*' + DATE + '\\]\\s*(.*)$', 'i');

  var PLACEHOLDER_RE = /^(<media omitted>|<attached: .*>|(image|video|audio|sticker|gif|document) omitted|this message was deleted|you deleted this message|null|missed (voice|video) call|.*\.(jpg|jpeg|png|webp|opus|mp4|pdf) \(file attached\))$/i;

  function _toIso(d, mo, y, h, mi, s, ap) {
    var day = Number(d), mon = Number(mo), yr = Number(y);
    // India writes day first. A first number over 12 cannot be a month; a
    // second number over 12 means the phone was set to a month-first locale.
    if (mon > 12 && day <= 12) { var x = day; day = mon; mon = x; }
    if (yr < 100) yr += 2000;
    var hr = Number(h), min = Number(mi), sec = Number(s || 0);
    if (ap) {
      var pm = ap.toLowerCase() === 'p';
      if (hr === 12) hr = pm ? 12 : 0;
      else if (pm) hr += 12;
    }
    if (mon < 1 || mon > 12 || day < 1 || day > 31 || hr > 23 || min > 59 || sec > 59) return null;
    // Local wall-clock time, never UTC: a chat says "10:14 am" in Kochi.
    var dt = new Date(yr, mon - 1, day, hr, min, sec);
    if (isNaN(dt.getTime()) || dt.getDate() !== day) return null;
    return dt.toISOString();
  }

  function _header(line) {
    var m = RE_ANDROID.exec(line);
    if (m) return { at: _toIso(m[1], m[2], m[3], m[4], m[5], m[6], m[7]), rest: m[8] };
    m = RE_IPHONE.exec(line);
    if (m) return { at: _toIso(m[1], m[2], m[3], m[4], m[5], m[6], m[7]), rest: m[8] };
    m = RE_COPIED.exec(line);
    if (m) return { at: _toIso(m[5], m[6], m[7], m[1], m[2], m[3], m[4]), rest: m[8] };
    return null;
  }

  // "Name: text". A system line ("Messages and calls are end-to-end
  // encrypted…", "X joined using this group's invite link") has no sender.
  function _split(rest) {
    var m = /^([^:]{1,80}?):(?:\s(.*))?$/.exec(rest);
    if (!m) return null;
    var from = m[1].replace(/^~\s*/, '').trim();
    if (!from) return null;
    return { from: from, text: m[2] == null ? '' : m[2] };
  }

  // The shop side: anything named Neo Tokyo, the exporter shown as "You", or
  // (when the caller passes them) the staff names the shop phone may be saved as.
  function _isShop(sender, shopNames) {
    var s = trim(sender).toLowerCase();
    if (/neo\s*tokyo/.test(s) || s === 'you') return true;
    return shopNames.some(function (n) { return s === n; });
  }

  function _looksLikePhone(s) {
    var digits = String(s || '').replace(/\D/g, '');
    return digits.length >= 10 && /^[\s\d+()\-.]+$/.test(String(s || ''));
  }

  // First mobile number in the text. An Indian mobile comes back as its 10
  // digits (+91 / 91 / 0091 / 0 prefixes and spaces or dashes inside
  // accepted); an international number written with + or 00 — the Gulf and
  // NRI customers of amendment A1 — comes back as "+<country code><number>"
  // so the country code is never lost. Whatever comes back passes
  // isValidPhone, and normPhone turns it into the same value SQL norm_phone()
  // stores: 91XXXXXXXXXX, or the international digits. A digit right before
  // or after the match means it is part of a longer number (an AWB, an order
  // id) — skip it.
  function _phoneAt(s, re, pick) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      var start = m.index, end = start + m[0].length;
      var prev = start > 0 ? s.charAt(start - 1) : '';
      var next = s.charAt(end);
      var value = (/\d/.test(prev) || /\d/.test(next)) ? null : pick(m);
      if (value) return { at: start, value: value };
      re.lastIndex = start + 1;
    }
    return null;
  }
  var RE_IN_MOBILE = /(\+?91[\s-]*|0)?([6-9](?:[\s-]?\d){9})/g;
  var RE_INTL = /(?:\+|\b00)[\s-]?([1-9](?:[\s-]?\d){9,14})/g;

  // Every number written with + or 00 that is a country code plus a number:
  // where it sits and, when phoneOk accepts its digits, "+<digits>" (else
  // null). +91 is left to the Indian rule (which also refuses Indian
  // landlines), and so is a + in front of only 10 digits: normPhone reads 10
  // digits as an Indian mobile. A refused one (+1 650 123 4567 is 11 digits
  // outside the Gulf codes) still claims its place in the text, so its last
  // ten digits are never read as somebody's Indian mobile.
  function _intlNumbers(s) {
    var out = [], m;
    RE_INTL.lastIndex = 0;
    while ((m = RE_INTL.exec(s)) !== null) {
      var start = m.index, end = start + m[0].length;
      var d = m[1].replace(/\D/g, '');
      if (/\d/.test(start > 0 ? s.charAt(start - 1) : '') || /\d/.test(s.charAt(end)) ||
          d.indexOf('91') === 0 || d.length < 11) {
        RE_INTL.lastIndex = start + 1;
        continue;
      }
      out.push({ at: start, end: end, value: phoneOk(d) ? '+' + d : null });
    }
    return out;
  }

  function findPhone(text) {
    var s = String(text == null ? '' : text);
    var intls = _intlNumbers(s);
    var intl = intls.filter(function (x) { return x.value; })[0] || null;
    var indian = _phoneAt(s, RE_IN_MOBILE, function (m) {
      var a = m.index, b = a + m[0].length;
      if (intls.some(function (x) { return a < x.end && b > x.at; })) return null;
      return m[2].replace(/\D/g, '');
    });
    if (indian && intl) return intl.at < indian.at ? intl.value : indian.value;
    return indian ? indian.value : (intl ? intl.value : null);
  }

  var MAX_LINES = 20000;

  function parseWhatsAppChat(text, opts) {
    var shopNames = (opts && Array.isArray(opts.shopNames) ? opts.shopNames : [])
      .map(function (n) { return trim(n).toLowerCase(); }).filter(Boolean);
    var raw = String(text == null ? '' : text);
    var lines = raw.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MAX_LINES) lines = lines.slice(0, MAX_LINES);

    var messages = [];
    var last = null;
    var sawHeader = false;
    lines.forEach(function (line0) {
      // Invisible marks iPhone exports put before attachments, a BOM on the
      // first line, and the narrow no-break space newer Android puts before am/pm.
      var line = line0.replace(/[‎‏‪-‮﻿]/g, '').replace(/[  ]/g, ' ');
      var h = _header(line.trim());
      if (h) {
        sawHeader = true;
        var sp = _split(h.rest);
        if (!sp) { last = null; return; }            // system line: not a message, ends the previous one
        last = { at: h.at, from: sp.from, text: sp.text };
        messages.push(last);
        return;
      }
      if (last) last.text += '\n' + line;           // a multi-line message continues until the next header
    });
    messages.forEach(function (msg1) { msg1.text = msg1.text.replace(/\s+$/, ''); });

    if (!sawHeader) {
      // Not an export — somebody pasted a single message or typed notes.
      var plain = trim(raw);
      return { phone: findPhone(plain), name: null, messages: [], faultText: clip(plain, 1000),
               faultKeys: matchFaults(plain) };
    }

    var customer = messages.filter(function (mm) { return !_isShop(mm.from, shopNames); });

    // SPEC-GAP: the shop's own messages are never searched for the phone — a
    // shop message that quotes a number is usually the shop's own.
    var phone = null;
    for (var i = 0; i < customer.length && !phone; i++) {
      phone = findPhone(customer[i].from) || findPhone(customer[i].text);
    }

    var name = null;
    for (var j = 0; j < customer.length; j++) {
      if (!_looksLikePhone(customer[j].from)) { name = clip(customer[j].from, 80); break; }
    }

    // SPEC-GAP: "the customer's first 3 messages" skips attachments,
    // deleted-message placeholders and a message that is only a phone number:
    // none of them describe the fault.
    var said = customer.filter(function (mm) {
      var t = trim(mm.text);
      return t && !PLACEHOLDER_RE.test(t) && !_looksLikePhone(t);
    });
    var faultText = said.slice(0, 3).map(function (mm) { return trim(mm.text); }).join('\n');
    var faultKeys = matchFaults(faultText);
    if (!faultKeys.length && said.length > 3) {
      faultKeys = matchFaults(said.map(function (mm) { return mm.text; }).join('\n'));
    }

    return { phone: phone, name: name, messages: messages, faultText: faultText, faultKeys: faultKeys };
  }

  var api = {
    FAULTS: FAULTS,
    fault: fault,
    faultsFor: faultsFor,
    computePriority: computePriority,
    suggestType: suggestType,
    estMinutes: estMinutes,
    mergeChecklists: mergeChecklists,
    ACCESSORIES: ACCESSORIES,
    CONDITION_CHIPS: CONDITION_CHIPS,
    DEFAULT_HANDLING_FEE: DEFAULT_HANDLING_FEE,
    HANDLING_FEE_BY_KIND: HANDLING_FEE_BY_KIND,
    handlingFee: handlingFee,
    OUR_WARRANTY_MONTHS: OUR_WARRANTY_MONTHS,
    ourWarrantyUntil: ourWarrantyUntil,
    WA_TEMPLATES: WA_TEMPLATES,
    trackLink: trackLink,
    visitText: visitText,
    matchFaults: matchFaults,
    normPhone: normPhone,
    phoneOk: phoneOk,
    isValidPhone: isValidPhone,
    ELEVEN_DIGIT_CODES: ELEVEN_DIGIT_CODES,
    findPhone: findPhone,
    parseWhatsAppChat: parseWhatsAppChat
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcCatalog = api;
  }
})(typeof window !== 'undefined' ? window : this);
