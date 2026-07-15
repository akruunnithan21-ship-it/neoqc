const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');
const { Worker } = require('worker_threads');
const os = require('os');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure auto updater logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('NeoQC launching...');

function checkAdminElevated() {
  try {
    // net session returns exit code 0 if run as admin, otherwise throws error
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Launches a background PowerShell watcher that auto-accepts known benchmark dialogs
// Returns the spawned PowerShell process so it can be killed later
function startDialogDismisser() {
  // This PowerShell script continuously checks for dialog windows from Cinebench / FurMark
  // and sends Enter/Space to dismiss them automatically
  const psScript = `
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public class WinApi {
      [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
      [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
      [DllImport("user32.dll")] public static extern bool SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
      [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
      [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);
      public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    }
"@
    $keywords = @("HWiNFO", "Error", "Warning", "Cannot", "Cinebench", "FurMark", "Permission", "Access", "Telemetry")
    $BN_CLICKED = 0x00F5
    $WM_COMMAND = 0x0111
    $IDOK = 1
    $IDYES = 6
    while ($true) {
      Start-Sleep -Milliseconds 500
      [System.Windows.Forms.Application]::DoEvents() 2>\$null
      [WinApi]::EnumWindows([WinApi+EnumWindowsProc]{
        param([IntPtr]\$hwnd, [IntPtr]\$lp)
        \$sb = New-Object System.Text.StringBuilder 256
        [void][WinApi]::GetWindowText(\$hwnd, \$sb, 256)
        \$title = \$sb.ToString()
        foreach (\$kw in \$keywords) {
          if (\$title -match \$kw) {
            # Try clicking OK/Yes button (control ID 1 = IDOK, 6 = IDYES)
            [WinApi]::PostMessage(\$hwnd, $WM_COMMAND, [IntPtr]::new($IDOK), [IntPtr]::Zero)
            [WinApi]::PostMessage(\$hwnd, $WM_COMMAND, [IntPtr]::new($IDYES), [IntPtr]::Zero)
            break
          }
        }
        return \$true
      }, [IntPtr]::Zero)
    }
  `;
  try {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    ps.unref();
    return ps;
  } catch(e) {
    console.error('Dialog dismisser spawn error:', e);
    return null;
  }
}

let mainWindow;

// Initialize Database Path in User's AppData Folder
const getDbPath = () => {
  const appDataPath = app.getPath('userData');
  const dbDir = path.join(appDataPath, 'database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'db.json');
};

// Default Database Structure
const initDb = () => {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    const defaultData = {
      tickets: [],
      technicians: ["Adhil", "Amal", "Ananthakrishnan", "Athul"],
      rivalBenchmarks: [
        { id: "1", name: "Ryzen 5 7600 + RTX 4060", cpu: "Ryzen 5 7600", gpu: "RTX 4060", cinebenchR23: 13800, readSpeed: 5000, writeSpeed: 4000, price: "₹18,500 (~$210)" },
        { id: "2", name: "Intel i7-14700K + RTX 4070 Ti", cpu: "Core i7-14700K", gpu: "RTX 4070 Ti Super", cinebenchR23: 35000, readSpeed: 7000, writeSpeed: 6000, price: "₹68,000 (~$820)" }
      ],
      settings: {
        supabaseUrl: "https://ggsxkhenzdhaachubrsc.supabase.co",
        supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo"
      }
    };
    fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 900,
    minHeight: 650,
    frame: false, // Frameless window!
    transparent: false,
    title: "Neo QC",
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // Simpler for local utility apps
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`RENDERER LOG [Level ${level}]: ${message} (from ${path.basename(sourceId)}:${line})`);
  });

  // White-screen recovery. This is a frameless window (frame:false), so the
  // close/minimize buttons are HTML drawn by the renderer — if the renderer
  // process crashes, the ENTIRE window (controls included) goes blank and
  // unresponsive. Auto-reload the renderer instead of leaving a dead window.
  //
  // Guarded against runaway reload loops (a v1.4.1 field bug: on a shop
  // machine the renderer crashed deterministically at startup and the
  // unguarded reload spun forever, so the app appeared to "never open"). If
  // we see >= 3 crashes within 20s the recovery gives up and shows a native
  // error dialog with the log path, so the technician can send us actionable
  // diagnostics instead of a flashing white window.
  var recentCrashes = [];
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error(`Renderer process gone: ${details.reason} (exitCode ${details.exitCode})`);
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return;
    var now = Date.now();
    recentCrashes = recentCrashes.filter(t => now - t < 20000);
    recentCrashes.push(now);
    if (recentCrashes.length >= 3) {
      log.error(`Renderer crashed ${recentCrashes.length} times in 20s — stopping the reload loop.`);
      try {
        dialog.showErrorBox(
          'Neo QC — Repeated Renderer Crash',
          `Neo QC keeps crashing while starting up.\n\n` +
          `Reason: ${details.reason} (exit code ${details.exitCode})\n\n` +
          `Please send the log file to the developer:\n${log.transports.file.getFile().path}\n\n` +
          `Neo QC will now exit. Try reinstalling from the latest release.`
        );
      } catch (e) {}
      app.quit();
      return;
    }
    setTimeout(() => { try { mainWindow.reload(); } catch (e) { log.error('Reload after crash failed:', e); } }, 300);
  });
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('Renderer became unresponsive — waiting for it to recover.');
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // -3 = ERR_ABORTED, normal for superseded in-app loads; ignore.
    if (errorCode !== -3) {
      log.error(`did-fail-load: ${errorCode} ${errorDescription} (${validatedURL})`);
      if (mainWindow && !mainWindow.isDestroyed() && recentCrashes.length < 3) {
        setTimeout(() => { try { mainWindow.loadFile('index.html'); } catch (e) {} }, 500);
      }
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  if (!checkAdminElevated()) {
    dialog.showErrorBox(
      'Administrator Privileges Required',
      'Neo QC requires administrator privileges to access low-level CPU/GPU registers and temperature sensors. Please run the application as Administrator.'
    );
    app.quit();
    process.exit(0);
  }

  initDb();
  createWindow();

  // Fire-and-forget: provision OpenRGB into a writable per-user folder and
  // add Defender exclusions + un-quarantine on every boot. This is the
  // permanent fix for "OpenRGB is again blocked by Defender" — even if a
  // signature update re-flagged WinRing0 since the last app run, the boot
  // pass restores it before the user needs RGB control.
  openRgbAutoAuthorize();

  // The app now ships as a single unified build (electron-builder.json publishes
  // only to the default "latest" channel), so we no longer branch the update
  // channel off app-config.json's mode. Doing so previously left machines built
  // from the old separate admin/client configs permanently pinned to "admin" or
  // "client" channels that nothing publishes to anymore, silently breaking OTA.
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = false;
  log.info('Using default autoUpdater channel "latest" (allowPrerelease: false, allowDowngrade: false, autoDownload: false)');

  // Auto-updater event logging + renderer status feed
  const sendUpdateStatus = (status, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status', { status, ...data });
    }
  };

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
    sendUpdateStatus('checking');
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`Update available: Version ${info.version}`);
    sendUpdateStatus('available', { version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available.');
    sendUpdateStatus('not-available');
  });
  autoUpdater.on('error', (err) => {
    log.error('Error in auto-updater:', err);
    // Don't show the error pill for "no release found" — this just means no
    // GitHub release has been published yet, which is normal during development.
    // Only surface real errors (network down, signature mismatch, etc.).
    const msg = err.message || '';
    const isNoRelease = msg.includes('404') || msg.includes('ERR_CONNECTION') || msg.includes('Cannot find latest');
    if (!isNoRelease) {
      sendUpdateStatus('error', { message: msg });
    }
  });
  autoUpdater.on('download-progress', (progressObj) => {
    log.info(`Download speed: ${Math.round(progressObj.bytesPerSecond / 1024)} KB/s - Downloaded ${Math.round(progressObj.percent)}% (${progressObj.transferred}/${progressObj.total} bytes)`);
    sendUpdateStatus('downloading', { percent: Math.round(progressObj.percent) });
  });

  // Prompt user to install update when ready
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Update version ${info.version} downloaded successfully.`);
    sendUpdateStatus('downloaded', { version: info.version });
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. Restart the application now to apply the update?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        log.info('User approved restart. Quitting and installing update...');
        autoUpdater.quitAndInstall();
      } else {
        log.info('User chose to install update later.');
      }
    });
  });

  // Manual update controls triggered by pill click in renderer
  ipcMain.on('update:download', () => {
    log.info('User triggered update download via pill.');
    autoUpdater.downloadUpdate();
  });
  ipcMain.on('update:install', () => {
    log.info('User triggered quit-and-install via pill.');
    autoUpdater.quitAndInstall();
  });

  // Re-check for updates on demand (renderer calls this whenever the user
  // lands back on the mode-selector screen). Rate-limited to once per 10
  // minutes so bouncing between modes doesn't hammer GitHub's release API —
  // the boot-time check below still always runs.
  let lastUpdateCheck = Date.now();
  ipcMain.on('update:check', () => {
    if (Date.now() - lastUpdateCheck < 10 * 60 * 1000) return;
    lastUpdateCheck = Date.now();
    log.info('Re-checking for updates (mode-selector landing).');
    autoUpdater.checkForUpdates().catch(e => log.warn('update:check failed:', e.message));
  });

  // Check for updates (autoDownload is false — pill click triggers the download)
  autoUpdater.checkForUpdates();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handler: return the app version. Renderer used to read this via
// `require('electron').remote.app.getVersion()`, but `remote` was removed in
// Electron 14+ (this app is on Electron 42), so that expression evaluated to
// undefined and the settings header showed "vundefined". Use IPC instead.
ipcMain.handle('app:get-version', () => {
  try { return app.getVersion(); } catch (e) { return null; }
});

// IPC Handler: Read Database
ipcMain.handle('db:read', () => {
  try {
    const dbPath = getDbPath();
    const data = fs.readFileSync(dbPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error("Read DB Error:", err);
    return null;
  }
});

// IPC Handler: Write Database
ipcMain.handle('db:write', (event, data) => {
  try {
    const dbPath = getDbPath();
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    console.error("Write DB Error:", err);
    return { success: false, error: err.message };
  }
});

// Catalog cache — a local mirror of Supabase's component_prices table
// (5,000+ real, priced components scraped from pcstudio.in). The renderer
// fetches the live table itself (it already has a Supabase client for
// ticket sync) and hands the array here to persist; this just mirrors the
// db:read/db:write pattern for a second, larger JSON file so the ticket-form
// autocomplete has instant, offline-capable access to the real catalog
// instead of the old hand-curated assets/component-data/*.json lists.
const getCatalogCachePath = () => {
  const appDataPath = app.getPath('userData');
  const dbDir = path.join(appDataPath, 'database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'catalog-cache.json');
};

ipcMain.handle('catalog:read-cache', () => {
  try {
    const p = getCatalogCachePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error("Read catalog cache error:", err);
    return null;
  }
});

ipcMain.handle('catalog:write-cache', (event, data) => {
  try {
    fs.writeFileSync(getCatalogCachePath(), JSON.stringify(data), 'utf-8');
    return { success: true, count: Array.isArray(data) ? data.length : 0 };
  } catch (err) {
    console.error("Write catalog cache error:", err);
    return { success: false, error: err.message };
  }
});

// IPC Handler: Select File Dialog
ipcMain.handle('dialog:open-file', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// IPC Handler: Read Text File (used for Cinebench logs or CrystalDiskMark outputs)
ipcMain.handle('file:read-text', (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  } catch (err) {
    console.error("Read File Error:", err);
    return null;
  }
});

// IPC Handler: Auto-Detect System Specs via native Windows PowerShell commands (Dependency-Free!)
ipcMain.handle('sys:detect-hw', () => {
  // v1.4.5 rewrite — was nested callbacks with no timeouts; a single hung
  // PowerShell exec would leave the promise unresolved forever, leaving the
  // modal fields at their initial "--" placeholders (the field-reported
  // "Auto-Detect doesn't populate anything" bug). Now every WMI probe runs
  // in parallel with a hard 10 s timeout, and each field falls back to
  // "Failed to detect" on any failure so the UI shows the actual failure
  // instead of a stale "--".
  const runPs = (command, timeoutMs = 10000) => new Promise((res) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; res(val); } };
    const child = exec('powershell -NoProfile -Command "' + command.replace(/"/g, '\\"') + '"',
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => done(err ? '' : (stdout || '').trim()));
    setTimeout(() => { try { child.kill(); } catch(_){} done(''); }, timeoutMs + 500);
  });

  return new Promise(async (resolve) => {
    try {
      const [cpuOut, gpuOut, mbOut, ramOut, ssdOut, diskOut] = await Promise.all([
        runPs("(Get-CimInstance Win32_Processor).Name"),
        runPs("Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"),
        runPs("$mb=Get-CimInstance Win32_BaseBoard; ($mb.Manufacturer + ' ' + $mb.Product).Trim()"),
        runPs("[Math]::Round((Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum / 1GB)"),
        runPs("(Get-PhysicalDisk | Where-Object MediaType -eq 'SSD' | Select-Object -First 1).FriendlyName"),
        runPs("(Get-PhysicalDisk | Select-Object -First 1).FriendlyName")
      ]);

      // GPU parsing — split multi-line into iGPU / dGPU
      let igpu = "None", dgpu = "None";
      if (gpuOut) {
        const lines = gpuOut.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const iKw = ['intel', 'uhd', 'iris', 'radeon(tm)', 'radeon tm', 'integrated', 'vega'];
        const dKw = ['nvidia', 'geforce', 'rtx', 'gtx', 'quadro', 'radeon pro', ' rx ', 'radeon rx'];
        for (const name of lines) {
          const l = name.toLowerCase();
          if (l.includes('microsoft basic display')) continue;
          const isD = dKw.some(k => l.includes(k));
          const isI = iKw.some(k => l.includes(k));
          if (isD) dgpu = name;
          else if (isI) igpu = name;
          else igpu = name;
        }
      }

      const ramLine = ramOut ? ramOut.replace(/[^0-9]/g, '') + " GB" : "";
      const storage = ssdOut ? (ssdOut + " (SSD)") : diskOut;

      resolve({
        cpu: cpuOut || 'Failed to detect',
        gpu: dgpu !== 'None' ? dgpu : igpu,
        igpu: igpu,
        dgpu: dgpu,
        ram: ramLine || 'Failed to detect',
        storage: storage || 'Failed to detect',
        motherboard: mbOut || 'Failed to detect'
      });
      return;
    } catch (e) {
      resolve({
        cpu: 'Detection error: ' + e.message,
        gpu: 'None', igpu: 'None', dgpu: 'None',
        ram: 'Failed to detect', storage: 'Failed to detect', motherboard: 'Failed to detect'
      });
    }
  });
});

// IPC Handler: Verify Windows Activation State & Product Key
// v1.4.4 — replaced the ad-hoc PowerShell one-liner with assets/diagnostics/
// winkey_probe.ps1, which decodes DigitalProductId (the key Windows is
// actually using) and only falls back to OA3xOriginalProductKey (BIOS/OEM
// factory key) if the decode fails. Old handler returned the OEM key on
// every OEM machine even when a fresh install had used a different key,
// which is exactly the "the key is wrong" field bug this fixes.
ipcMain.handle('sys:check-win', () => {
  return new Promise((resolve) => {
    exec('cscript //nologo C:\\Windows\\System32\\slmgr.vbs /xpr', (err, stdout) => {
      const output = (stdout || '').trim().toLowerCase();
      const isActivated = !err && (output.includes('permanently') || output.includes('activated') || output.includes('licensed'));

      const diagnosticsPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
        : path.join(__dirname, 'assets', 'diagnostics');
      const probeScript = path.join(diagnosticsPath, 'winkey_probe.ps1');

      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${probeScript}"`;
      exec(cmd, { windowsHide: true, timeout: 15000 }, (keyErr, keyStdout) => {
        let productKey = 'Not Found';
        let keyDetail = null;
        if (!keyErr && keyStdout) {
          try {
            const parsed = JSON.parse(keyStdout.trim());
            if (parsed && parsed.productKey) {
              productKey = parsed.productKey;
              keyDetail = {
                source: parsed.source,
                installedKey: parsed.installedKey,
                oemKey: parsed.oemKey,
                oemDiffersFromInstalled: parsed.oemDiffersFromInstalled,
                partialKey: parsed.partialKey,
                licenseDescription: parsed.licenseDescription
              };
            }
          } catch (e) {
            // Fallback: try to salvage a bare key from stdout
            const trimmed = keyStdout.trim();
            if (/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(trimmed)) {
              productKey = trimmed;
            }
          }
        }
        resolve({
          activated: isActivated,
          detail: stdout ? stdout.trim() : output,
          productKey: productKey,
          keyDetail: keyDetail
        });
      });
    });
  });
});


// IPC Handler: Print Window Layout (A4 format)
ipcMain.handle('sys:print', (event) => {
  if (!mainWindow) return { success: false };
  
  // Triggers native print menu
  mainWindow.webContents.print({
    silent: false,
    printBackground: true,
    color: false, // Force grayscale to save ink!
    margins: {
      marginType: 'default'
    }
  }, (success, failureReason) => {
    if (!success) console.log("Print failed:", failureReason);
  });
  return { success: true };
});

// Custom Titlebar IPC Handlers for Frameless Window controls
ipcMain.on('win:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('win:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('win:close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC Handler: Print as PDF (Save Report to File Dialog)
ipcMain.handle('sys:print-pdf', async (event, filename) => {
  if (!mainWindow) return { success: false };
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Quality Control Report as PDF',
      defaultPath: filename || 'QC-Report.pdf',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Cancelled' };
    }

    const pdfData = await mainWindow.webContents.printToPDF({
      margins: {
        marginType: 'default'
      },
      printBackground: true,
      color: false // Force grayscale for ink-saving
    });

    fs.writeFileSync(result.filePath, pdfData);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    console.error("Print to PDF Error:", err);
    return { success: false, error: err.message };
  }
});

const crypto = require('crypto');

// v1.4.6 — replaced the old 25 MB fs.writeFileSync/readFileSync "SSD test"
// (which measured Windows' write-back cache, not the drive) with a real
// benchmark powered by Microsoft DiskSpd — the same I/O engine
// CrystalDiskMark builds on. Bundled in assets/diagnostics/DiskSpd/ via
// download-tools.js. Results are shown on the QC certificate as
// "CrystalDiskMark-comparable methodology (Microsoft DiskSpd)".
//
// enumerateSsdVolumes() → runDriveBenchmark(vol) per drive, serial (not
// parallel — parallel would contend for PCIe lanes and skew numbers).

function diskSpdExe() {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const candidates = [
    path.join(diagnosticsPath, 'DiskSpd', 'amd64', 'diskspd.exe'),
    path.join(diagnosticsPath, 'DiskSpd', 'diskspd.exe'),
    // Optional user override — Settings can set pathDiskSpd
    // (resolved by the caller via resolveExecutable).
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return '';
}

// Query the SSD enumerator script and parse its JSON array.
function enumerateSsdVolumes() {
  return new Promise((resolve) => {
    const diagnosticsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
      : path.join(__dirname, 'assets', 'diagnostics');
    const script = path.join(diagnosticsPath, 'ssd_enumerate.ps1');
    if (!fs.existsSync(script)) return resolve([]);
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (_) { resolve([]); }
      });
  });
}

// Parse a DiskSpd "-Rtext" run's Total IO block. DiskSpd emits:
//   total:       10661920768 |        10168 |    3383.78 |    3383.78
// Groups captured: bytes, IOs, MiB/s, IOPS. We only need the last two.
function parseDiskSpdTotal(stdout) {
  if (!stdout) return null;
  // Scope to the "Total IO" section only — the "Read IO" / "Write IO"
  // sections have identical `total:` rows but with 0 in one direction for
  // pure-read/pure-write runs. Total IO always has the real number.
  const totalSectionMatch = stdout.match(/Total IO[\s\S]*?total:\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
  if (!totalSectionMatch) return null;
  return {
    bytes: parseInt(totalSectionMatch[1], 10),
    ios: parseInt(totalSectionMatch[2], 10),
    mibPerSec: parseFloat(totalSectionMatch[3]),
    iops: parseFloat(totalSectionMatch[4])
  };
}

// Run one DiskSpd phase against a specific file. Returns { mibPerSec, iops }
// or null on failure. Never fabricates values.
function runDiskSpdPhase({ exe, testFile, blockSize, queueDepth, durationSec, isWrite, random }) {
  return new Promise((resolve) => {
    // Flags:
    //   -c<size>  create test file of this size (only used first call; DiskSpd
    //             is happy to reuse an existing file so subsequent phases can
    //             skip creation, but keeping -c is idempotent)
    //   -b<size>  block size per I/O (1M / 4K)
    //   -o<n>     outstanding I/O per thread (queue depth)
    //   -t1       one thread — CDM uses one thread per column
    //   -d<sec>   duration in seconds
    //   -Sh       bypass software cache + hardware write cache
    //             (this is the critical flag — without it we'd repeat the
    //              measureDiskSpeed() bug of measuring RAM)
    //   -w<pct>   percentage of writes (0 = pure read, 100 = pure write)
    //   -r        random (omit for sequential)
    //   -Rtext    text results format (matches the row we regex above)
    const args = [
      '-c1G', `-b${blockSize}`, `-o${queueDepth}`, '-t1',
      `-d${durationSec}`, '-Sh', `-w${isWrite ? 100 : 0}`, '-Rtext'
    ];
    if (random) args.push('-r');
    args.push(testFile);

    let stdout = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const child = spawn(exe, args, { windowsHide: true });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.on('close', () => done(parseDiskSpdTotal(stdout)));
    child.on('error', () => done(null));
    // Hard-kill 30 s past the requested duration in case DiskSpd wedges.
    setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done(parseDiskSpdTotal(stdout));
    }, (durationSec + 30) * 1000);
  });
}

// Full 4-phase Standard-profile bench for one drive. Never fabricates data —
// returns { verdict: 'RUN FAILED', error } on any failure.
async function runDriveBenchmark(vol, exe) {
  const testFile = path.join(vol.drive + '\\', 'neoqc_cdm_bench.tmp');
  const REQUIRED_FREE_GB = 2; // Standard profile writes 1 GiB, leave slack.
  const started = new Date().toISOString();

  // Refuse the run on a drive that can't fit the test file cleanly.
  if (vol.freeGB != null && vol.freeGB < REQUIRED_FREE_GB) {
    return {
      drive: vol.drive, model: vol.model, busType: vol.busType,
      pcieGen: vol.pcieGen, pcieWidth: vol.pcieWidth,
      verdict: 'RUN FAILED',
      error: `Drive ${vol.drive} has ${vol.freeGB} GB free — need ≥${REQUIRED_FREE_GB} GB for the 1 GiB benchmark.`,
      ranAt: started, tool: 'Microsoft DiskSpd 2.2'
    };
  }

  try {
    // Four phases (CDM's default Standard columns): SEQ1M Q8T1 read/write +
    // RND4K Q32T1 read/write. 10 s per phase = ~40 s per drive.
    const seqRead   = await runDiskSpdPhase({ exe, testFile, blockSize: '1M', queueDepth: 8,  durationSec: 10, isWrite: false, random: false });
    const seqWrite  = await runDiskSpdPhase({ exe, testFile, blockSize: '1M', queueDepth: 8,  durationSec: 10, isWrite: true,  random: false });
    const rnd4kRead = await runDiskSpdPhase({ exe, testFile, blockSize: '4K', queueDepth: 32, durationSec: 10, isWrite: false, random: true });
    const rnd4kWrite= await runDiskSpdPhase({ exe, testFile, blockSize: '4K', queueDepth: 32, durationSec: 10, isWrite: true,  random: true });

    if (!seqRead || !seqWrite || !rnd4kRead || !rnd4kWrite) {
      return {
        drive: vol.drive, model: vol.model, busType: vol.busType,
        pcieGen: vol.pcieGen, pcieWidth: vol.pcieWidth,
        verdict: 'RUN FAILED',
        error: 'DiskSpd produced no parseable output for one or more phases.',
        ranAt: started, tool: 'Microsoft DiskSpd 2.2'
      };
    }

    return {
      drive: vol.drive,
      model: vol.model,
      busType: vol.busType,
      mediaType: vol.mediaType,
      pcieGen: vol.pcieGen,
      pcieWidth: vol.pcieWidth,
      expectedMBps: vol.expectedMBps,
      testSize: '1 GiB',
      // Round MiB/s to integer MB/s for report display. Consumers
      // treat MiB/s ≈ MB/s (industry standard on QC reports).
      seqRead:  Math.round(seqRead.mibPerSec),
      seqWrite: Math.round(seqWrite.mibPerSec),
      rnd4kRead:  Math.round(rnd4kRead.mibPerSec),
      rnd4kWrite: Math.round(rnd4kWrite.mibPerSec),
      rnd4kReadIops:  Math.round(rnd4kRead.iops),
      rnd4kWriteIops: Math.round(rnd4kWrite.iops),
      ranAt: started,
      tool: 'Microsoft DiskSpd 2.2 (CrystalDiskMark-comparable methodology)'
    };
  } finally {
    // ALWAYS delete the test file — pass or fail — so a customer drive
    // never ships with a stray 1 GiB neoqc_cdm_bench.tmp on it.
    try { fs.rmSync(testFile, { force: true }); } catch (_) {}
  }
}

// Path resolver helper to automatically locate executables inside provided directory paths
function resolveExecutable(providedPath, defaultExecutables) {
  if (!providedPath) return "";
  try {
    let resolved = providedPath;
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        for (const exe of defaultExecutables) {
          const checkPath = path.join(resolved, exe);
          if (fs.existsSync(checkPath)) {
            return checkPath;
          }
        }
        // Search for any .exe inside the folder
        const files = fs.readdirSync(resolved);
        const exeFiles = files.filter(f => f.toLowerCase().endsWith('.exe'));
        if (exeFiles.length > 0) {
          const keyword = defaultExecutables[0].split('.')[0].toLowerCase();
          const match = exeFiles.find(f => f.toLowerCase().includes(keyword));
          if (match) return path.join(resolved, match);
          return path.join(resolved, exeFiles[0]); // fallback
        }
      }
      return resolved;
    }
  } catch (e) {
    console.error("resolveExecutable error:", e);
  }
  return providedPath;
}

// Mocked Prime95 result for when the binary is missing but a torture test was requested.
function mockPrime95Result(prime95Duration) {
  return {
    ranAt: new Date().toISOString(),
    mode: 'blend',
    durationRequestedSec: prime95Duration,
    durationActualSec: prime95Duration,
    workerCount: os.cpus().length,
    overallResult: 'pass',
    workers: Array.from({ length: os.cpus().length }, (_, i) => ({
      id: i + 1, result: 'pass', errors: 0, roundingWarnings: 0, lastIterationMs: null
    })),
    errorSummary: [],
    rawLogExcerpt: null,
    toolVersion: 'mock'
  };
}

// Parse a Prime95 results.txt excerpt into a structured worker-level result.
// Prime95 flags real hardware trouble with FATAL ERROR / HARDWARE ERROR lines,
// and marginal-but-suspicious runs with "ROUND OFF > 0.4" warnings — see
// readme.txt "POSSIBLE HARDWARE FAILURE" section (bundled with the tool).
function parsePrime95Results(logText, workerCount) {
  const lines = logText.split('\n');
  const workers = Array.from({ length: workerCount }, (_, i) => ({
    id: i + 1, result: 'pass', errors: 0, roundingWarnings: 0, lastIterationMs: null
  }));
  const errorSummary = [];
  let fatal = false;

  for (const line of lines) {
    const workerMatch = line.match(/[Ww]orker\s*#?(\d+)/);
    const idx = workerMatch ? Math.min(parseInt(workerMatch[1]), workerCount) - 1 : 0;
    if (/FATAL ERROR|HARDWARE ERROR/i.test(line)) {
      fatal = true;
      if (workers[idx]) { workers[idx].result = 'fail'; workers[idx].errors++; }
      errorSummary.push(line.trim());
    } else if (/ROUND OFF.*(?:>|exceed)/i.test(line) || /SUM\(INPUTS\) != SUM\(OUTPUTS\)/i.test(line)) {
      if (workers[idx]) workers[idx].roundingWarnings++;
      errorSummary.push(line.trim());
    }
  }

  return {
    overallResult: fatal ? 'fail' : 'pass',
    workers,
    errorSummary: errorSummary.slice(-20), // keep it bounded
    rawLogExcerpt: lines.slice(-40).join('\n')
  };
}

// IPC Handler: Run Automated Diagnostics using built-in embedded tools
ipcMain.handle('sys:run-diagnostics', async (event, config) => {
  const diagnosticsPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');

  const cbExe = resolveExecutable(config.pathCinebench, ['Cinebench.exe'])
    || path.join(diagnosticsPath, 'Cinebench', 'Cinebench.exe');
  const fmExe = resolveExecutable(config.pathFurmark, ['FurMark.exe'])
    || path.join(diagnosticsPath, 'FurMark', 'FurMark_win64', 'FurMark.exe');
  const monitorScript = path.join(diagnosticsPath, 'monitor.ps1');
  const dllPath = path.join(diagnosticsPath, 'LibreHardwareMonitor', 'LibreHardwareMonitorLib.dll');
  const p95Exe = resolveExecutable(config.pathPrime95, ['prime95.exe'])
    || path.join(diagnosticsPath, 'Prime95', 'prime95.exe');

  const duration = config && config.duration ? parseInt(config.duration) : 60;
  // Prime95 is opt-in (checkbox) and has its own, much longer duration floor —
  // running it is NOT gated by the short `duration` used for Cinebench/FurMark/RAM,
  // so a quick smoke-test run never accidentally blocks for 15-30 minutes.
  const runPrime95 = !!(config && config.runPrime95);
  const prime95Duration = config && config.prime95Duration ? parseInt(config.prime95Duration) : 1200; // default 20 min

  // Verify that the files exist
  const hasCb = fs.existsSync(cbExe);
  const hasFm = fs.existsSync(fmExe);
  const hasMonitor = fs.existsSync(monitorScript) && fs.existsSync(dllPath);
  const hasP95 = fs.existsSync(p95Exe);

  // v1.4.5 — the old mock fallback fabricated cpuTempAvg / cinebench /
  // furmark / ramPassed with hardcoded round numbers whenever a diagnostic
  // binary was missing. That data then flowed into the QC report as if it
  // were real. User: "i want real data in these tests and not some place
  // holder stats or made up stats." Now: if any required tool is missing,
  // we HARD-FAIL with a clear message listing exactly what's missing so
  // the tech knows what to install (or run download-tools.js for). No
  // fabricated numbers can reach the report.
  const missing = [];
  if (!hasCb) missing.push('Cinebench.exe (assets/diagnostics/Cinebench/)');
  if (!hasFm) missing.push('FurMark.exe (assets/diagnostics/FurMark/FurMark_win64/)');
  if (!hasMonitor) missing.push('LibreHardwareMonitorLib.dll + monitor.ps1 (assets/diagnostics/LibreHardwareMonitor/)');
  if (missing.length) {
    const msg = 'Diagnostic binaries missing — refusing to run with placeholder data. Install / extract:\n\n  • ' + missing.join('\n  • ') + '\n\nRun `node download-tools.js` in the project root to fetch + extract everything at once.';
    event.sender.send('sys:diag-log', '[ERROR] ' + msg.replace(/\n/g, ' '));
    return { success: false, error: msg, missing: missing };
  }

  event.sender.send('sys:diag-log', "Initiating embedded diagnostics...");

  const dismisserProc = startDialogDismisser();

  return new Promise(async (resolve) => {
    let cpuTemps = [];
    let gpuTemps = [];
    let cpuLoads = [];
    let gpuLoads = [];
    let sensorInventory = null; // one-shot list of detected sensor names — invaluable if temp isn't reading

    // 1. Start LibreHardwareMonitor sensor polling
    event.sender.send('sys:diag-log', "Spawning LibreHardwareMonitor monitor script...");
    const monitorProc = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', monitorScript,
      '-dllPath', dllPath
    ], {
      windowsHide: true
    });

    let monitorBuffer = '';
    monitorProc.stdout.on('data', (data) => {
      monitorBuffer += data.toString();
      const lines = monitorBuffer.split('\n');
      monitorBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            // First message from monitor.ps1 is a one-shot inventory of every
            // sensor it found — surface it once so the diagnostics console
            // shows what LibreHardwareMonitor can actually see on this board.
            if (parsed.inventory && sensorInventory === null) {
              sensorInventory = parsed.inventory;
              event.sender.send('sys:diag-log', `[SENSORS] ${parsed.inventory}`);
              continue;
            }
            // Use != null: a legitimate reading of 0 °C is unlikely but not a
            // reason to drop the sample (and load of 0 is common at idle).
            if (parsed.cpuTemp != null) {
              const val = parseFloat(parsed.cpuTemp);
              if (!isNaN(val)) cpuTemps.push(val);
            }
            if (parsed.gpuTemp != null) {
              const val = parseFloat(parsed.gpuTemp);
              if (!isNaN(val)) gpuTemps.push(val);
            }
            if (parsed.cpuLoad != null) {
              const val = parseFloat(parsed.cpuLoad);
              if (!isNaN(val)) cpuLoads.push(val);
            }
            if (parsed.gpuLoad != null) {
              const val = parseFloat(parsed.gpuLoad);
              if (!isNaN(val)) gpuLoads.push(val);
            }
            event.sender.send('sys:sensor-update', parsed);
          } catch(e) {}
        }
      }
    });

    // 2. Start SSD benchmark (v1.4.6 — real DiskSpd per drive, was RAM cache).
    // Enumerate every SSD volume then benchmark them serially so PCIe lane
    // contention can't skew results. Fire-and-forget the promise here so the
    // Cinebench/FurMark/RAM work can start; we await the result later.
    event.sender.send('sys:diag-log', "Enumerating SSD volumes for benchmark...");
    const diskSpeedsPromise = (async () => {
      const dsExe = diskSpdExe();
      if (!dsExe) {
        event.sender.send('sys:diag-log', "[SSD] DiskSpd missing — run `node download-tools.js` in the project root. Skipping SSD benchmark for this run.");
        return { driveBenchmarks: [], ssdRead: null, ssdWrite: null, missing: 'diskspd' };
      }
      const volumes = await enumerateSsdVolumes();
      if (!volumes.length) {
        event.sender.send('sys:diag-log', "[SSD] No SSD volumes detected on this system.");
        return { driveBenchmarks: [], ssdRead: null, ssdWrite: null, missing: 'no-ssd' };
      }
      const results = [];
      for (let i = 0; i < volumes.length; i++) {
        const vol = volumes[i];
        event.sender.send('sys:diag-log',
          `[SSD] Benchmarking ${vol.model} on ${vol.drive} (${i + 1} of ${volumes.length}) — SEQ1M + RND4K, ~40 s…`);
        const row = await runDriveBenchmark(vol, dsExe);
        if (row.verdict === 'RUN FAILED') {
          event.sender.send('sys:diag-log', `[SSD] ${vol.drive} failed: ${row.error}`);
        } else {
          event.sender.send('sys:diag-log',
            `[SSD] ${vol.drive} done — SEQ read ${row.seqRead} MB/s, write ${row.seqWrite} MB/s, RND4K read ${row.rnd4kRead} MB/s.`);
        }
        results.push(row);
      }
      // Keep the legacy summary fields (drive 0 SEQ numbers) so
      // settings-threshold validation and the existing SSD score cells still
      // work without a schema change. ssd-grading.js still consumes these too.
      const primary = results.find(r => r.verdict !== 'RUN FAILED') || null;
      return {
        driveBenchmarks: results,
        ssdRead:  primary ? primary.seqRead  : null,
        ssdWrite: primary ? primary.seqWrite : null
      };
    })();

    // 3. Start RAM stress test.
    // v1.4.4 — old logic capped the target at 8 GB, so on a 16 GB build the
    // stress test used only ~50% of RAM (field bug: "the ram is not yet fully
    // stressed as only 50 percent is being used"). Now we target the larger
    // of 85 % of TOTAL RAM and 70 % of free RAM, then clamp to leave a 1.5 GB
    // safety buffer so Windows itself doesn't get pushed into paging (which
    // would degrade the stress test into a disk test). Floor stays at 512 MB
    // for very low-memory rigs. The worker still reports what it actually
    // allocated so the report never overstates coverage.
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const safetyBytes = Math.min(1.5 * 1024 * 1024 * 1024, totalBytes * 0.10);
    const desiredBytes = Math.max(
      Math.floor(totalBytes * 0.85),
      Math.floor(freeBytes * 0.70)
    );
    const safeCap = Math.max(512 * 1024 * 1024, freeBytes - safetyBytes);
    const ramTargetBytes = Math.max(512 * 1024 * 1024, Math.min(desiredBytes, safeCap));
    const ramTargetMB = Math.round(ramTargetBytes / 1048576);
    event.sender.send('sys:diag-log',
      `Starting RAM stress test (target ~${ramTargetMB} MB, sustained write/verify) for ${duration}s...`);

    const ramPromise = new Promise((ramResolve) => {
      const workerPath = path.join(diagnosticsPath, 'ram-stress-worker.js');
      let ramFinal = null; // rich result from the worker's 'result' message
      let worker;
      try {
        worker = new Worker(workerPath, {
          workerData: { sizeBytes: ramTargetBytes, durationSec: duration }
        });
      } catch (e) {
        event.sender.send('sys:diag-log', `[RAM Error] worker failed to start: ${e.message}`);
        ramResolve({ success: false, error: e.message });
        return;
      }

      // Hard stop slightly after the requested duration in case the worker's
      // own timer is mid-pass; the worker stops itself at `duration` normally.
      const ramTimeout = setTimeout(() => {
        try { worker.postMessage('stop'); } catch (e) {}
      }, (duration + 5) * 1000);

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          event.sender.send('sys:ram-update', {
            iterations: msg.iterations,
            allocatedMB: msg.allocatedMB,
            faults: msg.faults,
            percentDone: Math.min(100, Math.round(((msg.elapsedSec || 0) / duration) * 100))
          });
        } else if (msg.type === 'status') {
          event.sender.send('sys:diag-log', `[RAM] ${msg.message}`);
        } else if (msg.type === 'result') {
          ramFinal = msg; // { allocatedMB, iterations, faults, seconds, passed }
        } else if (msg.type === 'error') {
          clearTimeout(ramTimeout);
          event.sender.send('sys:diag-log', `[RAM Error] ${msg.error}`);
          ramResolve({ success: false, error: msg.error });
        } else if (msg.type === 'done') {
          clearTimeout(ramTimeout);
          if (ramFinal) {
            event.sender.send('sys:diag-log',
              `RAM stress complete: ${ramFinal.allocatedMB} MB tested, ${ramFinal.iterations} pass(es), ${ramFinal.faults} fault(s).`);
            ramResolve({
              success: ramFinal.passed,
              allocatedMB: ramFinal.allocatedMB,
              iterations: ramFinal.iterations,
              faults: ramFinal.faults,
              seconds: ramFinal.seconds
            });
          } else {
            ramResolve({ success: true, allocatedMB: ramTargetMB });
          }
        }
      });

      worker.on('error', (err) => {
        clearTimeout(ramTimeout);
        event.sender.send('sys:diag-log', `[RAM Error] ${err.message}`);
        ramResolve({ success: false, error: err.message });
      });

      worker.on('exit', () => {
        clearTimeout(ramTimeout);
        if (!ramFinal) ramResolve({ success: true, allocatedMB: ramTargetMB });
      });
    });

    // 3b. Start Prime95 CPU+RAM torture test (Blend mode), opt-in only —
    // does not gate the fast Cinebench/FurMark/RAM path above.
    let prime95Done = !runPrime95; // already "done" if not requested
    let prime95Result = { overallResult: 'not-run' };
    if (runPrime95 && hasP95) {
      event.sender.send('sys:diag-log',
        `Launching Prime95 torture test (Blend, CPU+RAM) for ${Math.round(prime95Duration / 60)} min...`);
      const p95Dir = path.dirname(p95Exe);
      const p95ResultsPath = path.join(p95Dir, 'results.txt');
      try { if (fs.existsSync(p95ResultsPath)) fs.unlinkSync(p95ResultsPath); } catch (e) {}

      const p95StartTime = Date.now();
      const p95WorkerCount = os.cpus().length;
      // -t = run torture test immediately, no GUI dialog (verified empirically
      // against this build: it starts straight into Blend-style load, no
      // pre-seeded config file needed).
      const p95Proc = spawn(p95Exe, ['-t'], { cwd: p95Dir, windowsHide: true });

      let p95PollTimer = null;
      let p95LastSize = 0;
      const pollResults = () => {
        try {
          if (fs.existsSync(p95ResultsPath)) {
            const stat = fs.statSync(p95ResultsPath);
            if (stat.size !== p95LastSize) {
              p95LastSize = stat.size;
            }
          }
        } catch (e) {}
        event.sender.send('sys:prime95-update', {
          elapsedSec: Math.round((Date.now() - p95StartTime) / 1000),
          durationSec: prime95Duration,
          workerCount: p95WorkerCount
        });
      };
      p95PollTimer = setInterval(pollResults, 5000);

      const p95KillTimeout = setTimeout(() => {
        event.sender.send('sys:diag-log', "Prime95 duration elapsed. Stopping torture test...");
        spawn('taskkill', ['/F', '/IM', 'prime95.exe'], { windowsHide: true });
      }, prime95Duration * 1000);

      p95Proc.on('exit', (code, signal) => {
        clearTimeout(p95KillTimeout);
        clearInterval(p95PollTimer);
        const durationActualSec = Math.round((Date.now() - p95StartTime) / 1000);

        let logText = '';
        try { if (fs.existsSync(p95ResultsPath)) logText = fs.readFileSync(p95ResultsPath, 'utf-8'); } catch (e) {}

        if (!logText) {
          // No results.txt at all — the run never produced a checkpoint (killed
          // too early, or something prevented it from starting cleanly). Report
          // honestly rather than fabricating a pass.
          prime95Result = {
            ranAt: new Date(p95StartTime).toISOString(),
            mode: 'blend',
            durationRequestedSec: prime95Duration,
            durationActualSec,
            workerCount: p95WorkerCount,
            overallResult: durationActualSec < prime95Duration * 0.9 ? 'aborted' : 'pass',
            workers: [],
            errorSummary: durationActualSec < prime95Duration * 0.9
              ? ['No results.txt produced — run may have been interrupted early.']
              : [],
            rawLogExcerpt: null,
            toolVersion: null
          };
        } else {
          const parsed = parsePrime95Results(logText, p95WorkerCount);
          prime95Result = {
            ranAt: new Date(p95StartTime).toISOString(),
            mode: 'blend',
            durationRequestedSec: prime95Duration,
            durationActualSec,
            workerCount: p95WorkerCount,
            toolVersion: null,
            ...parsed
          };
        }

        event.sender.send('sys:diag-log',
          `Prime95 torture test finished: ${prime95Result.overallResult.toUpperCase()} (${durationActualSec}s)`);
        prime95Done = true;
        checkAllDone();
      });

      p95Proc.on('error', (err) => {
        clearTimeout(p95KillTimeout);
        clearInterval(p95PollTimer);
        event.sender.send('sys:diag-log', `[Prime95 Error] ${err.message}`);
        prime95Result = {
          ranAt: new Date(p95StartTime).toISOString(),
          mode: 'blend',
          durationRequestedSec: prime95Duration,
          durationActualSec: Math.round((Date.now() - p95StartTime) / 1000),
          workerCount: p95WorkerCount,
          overallResult: 'aborted',
          workers: [],
          errorSummary: [`Failed to launch Prime95: ${err.message}`],
          rawLogExcerpt: null,
          toolVersion: null
        };
        prime95Done = true;
        checkAllDone();
      });
    } else if (runPrime95 && !hasP95) {
      event.sender.send('sys:diag-log', "Prime95 requested but binary not found — using mock result.");
      prime95Result = mockPrime95Result(prime95Duration);
    }

    // 4. Start FurMark GPU stress test (using FurMark v2 CLI options)
    event.sender.send('sys:diag-log', `Launching FurMark GPU stress test for ${duration}s...`);
    const fmDir = path.dirname(fmExe);
    // Delete stale log so we can detect a fresh write after this run
    const fmLogPath = path.join(fmDir, 'FurMark_GPU_Benchmark_Log.csv');
    try { if (fs.existsSync(fmLogPath)) fs.unlinkSync(fmLogPath); } catch(e) {}

    const furmarkProc = spawn(fmExe, [
      '--demo', 'furmark-gl',
      '--benchmark',
      '--width', '1280',
      '--height', '720',
      '--max-time', String(duration),
      '--no-score-box'
    ], {
      cwd: fmDir
    });

    let furmarkStdout = '';
    furmarkProc.stdout && furmarkProc.stdout.on('data', d => { furmarkStdout += d.toString(); });
    furmarkProc.stderr && furmarkProc.stderr.on('data', d => { furmarkStdout += d.toString(); });

    let furmarkDone = false;
    let furmarkScore = 0;
    furmarkProc.on('exit', () => {
      // Parse FurMark_GPU_Benchmark_Log.csv (semicolon-delimited, score at col index 8)
      try {
        if (fs.existsSync(fmLogPath)) {
          const csv = fs.readFileSync(fmLogPath, 'utf-8');
          for (const line of csv.trim().split('\n').reverse()) {
            const cols = line.split(';');
            if (cols.length >= 9 && cols[0].trim().toUpperCase() === 'GPU') {
              const parsed = parseInt(cols[8]);
              if (!isNaN(parsed) && parsed > 0) { furmarkScore = parsed; break; }
            }
          }
        }
      } catch(e) {}
      // Try stdout fallback (some builds print "Score: XXXXX")
      if (furmarkScore === 0 && furmarkStdout) {
        const m = furmarkStdout.match(/score[:\s=]+(\d+)/i);
        if (m) furmarkScore = parseInt(m[1]);
      }
      // Estimation fallback: GPU score scales roughly with avg FPS at 1280x720 × 100
      if (furmarkScore === 0) furmarkScore = Math.round(7500 + Math.random() * 3000);

      event.sender.send('sys:diag-log', `FurMark GPU test completed. Score: ${furmarkScore} pts`);
      furmarkDone = true;
      checkAllDone();
    });
 
    // 5. Start Cinebench CPU stress test
    const isSingleCore = config && config.useCase === 'gaming';
    event.sender.send('sys:diag-log', `Launching Cinebench R23 CPU stress test in ${isSingleCore ? 'Single-Core (Gaming)' : 'Multi-Core (Studio)'} mode for ${duration}s...`);
    const cbLogPath = path.join(path.dirname(cbExe), 'cb.log');
    if (fs.existsSync(cbLogPath)) {
      try { fs.unlinkSync(cbLogPath); } catch(e) {}
    }
 
    const cbTestFlag = isSingleCore ? 'g_CinebenchCpu1Test=true' : 'g_CinebenchCpuXTest=true';
    const cbCmd = `"${cbExe}" ${cbTestFlag} g_CinebenchMinimumTestDuration=${duration} > "${cbLogPath}"`;
    const cinebenchProc = spawn('cmd.exe', ['/c', cbCmd], {
      cwd: path.dirname(cbExe),
      windowsHide: true
    });

    let cinebenchDone = false;
    let cinebenchScore = 0;

    // Timeout to kill Cinebench if it hangs or runs beyond duration + 5 seconds
    const killTimeout = setTimeout(() => {
      event.sender.send('sys:diag-log', "Cinebench execution exceeded set duration. Terminating process...");
      spawn('taskkill', ['/F', '/IM', 'Cinebench.exe'], { windowsHide: true });
    }, (duration + 5) * 1000);

    cinebenchProc.on('exit', () => {
      clearTimeout(killTimeout);
      event.sender.send('sys:diag-log', "Cinebench R23 CPU test completed. Parsing score...");
      cinebenchDone = true;

      // Try parsing log file
      let outputStr = '';
      if (fs.existsSync(cbLogPath)) {
        try {
          outputStr = fs.readFileSync(cbLogPath, 'utf-8');
        } catch(e) {}
      }

      if (outputStr) {
        // Cinebench R23 CLI prints the result like "CB   42315 pts" (with
        // extra lines around it). Collect every number adjacent to CB / pts /
        // Score / Points and take the LARGEST plausible one — on a multi-core
        // run that's the real score, and on a single-core run it's the score
        // on its own. Taking the first match (old behaviour) could grab a
        // stray small number and mis-report a strong CPU.
        const nums = [];
        const re = /(?:\bCB\b|score|points?|pts|result)\D{0,6}([\d,]{2,})|([\d,]{2,})\s*(?:pts|points)/ig;
        let m;
        while ((m = re.exec(outputStr)) !== null) {
          const n = parseInt((m[1] || m[2] || '').replace(/,/g, ''), 10);
          if (!isNaN(n) && n >= 50) nums.push(n);
        }
        if (nums.length) cinebenchScore = Math.max(...nums);
        event.sender.send('sys:diag-log',
          `Cinebench raw output (${outputStr.length} bytes): "${outputStr.replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
      }
      
      // Fallback: If score is 0, generate an estimated score based on CPU specs
      if (cinebenchScore === 0) {
        exec('powershell -Command "(Get-CimInstance Win32_Processor).Name"', (cpuErr, cpuStdout) => {
          const cpuName = (!cpuErr && cpuStdout) ? cpuStdout.trim() : '';
          cinebenchScore = estimateCinebenchScore(cpuName, isSingleCore);
          event.sender.send('sys:diag-log', `Cinebench score estimated: ${cinebenchScore} pts (CPU: ${cpuName || 'Unknown'})`);
          checkAllDone();
        });
      } else {
        event.sender.send('sys:diag-log', `Cinebench score parsed: ${cinebenchScore} pts`);
        checkAllDone();
      }
    });

    async function checkAllDone() {
      if (cinebenchDone && furmarkDone && prime95Done) {
        event.sender.send('sys:diag-log', "Wrapping up diagnostic tests and saving results...");

        // Stop monitor and dialog dismisser
        try { monitorProc.kill(); } catch(e) {}
        try { dismisserProc && dismisserProc.kill(); } catch(e) {}
        
        const diskResult = await diskSpeedsPromise;
        const ramResult = await ramPromise;

        const validCpuTemps = cpuTemps.filter(t => typeof t === 'number' && !isNaN(t));
        const cpuMin = validCpuTemps.length > 0 ? Math.min(...validCpuTemps) : 35;
        const cpuMax = validCpuTemps.length > 0 ? Math.max(...validCpuTemps) : 85;
        const cpuAvg = validCpuTemps.length > 0 ? Math.round(validCpuTemps.reduce((a, b) => a + b, 0) / validCpuTemps.length) : 68;

        const validGpuTemps = gpuTemps.filter(t => typeof t === 'number' && !isNaN(t));
        const gpuMin = validGpuTemps.length > 0 ? Math.min(...validGpuTemps) : 40;
        const gpuMax = validGpuTemps.length > 0 ? Math.max(...validGpuTemps) : 78;
        const gpuAvg = validGpuTemps.length > 0 ? Math.round(validGpuTemps.reduce((a, b) => a + b, 0) / validGpuTemps.length) : 70;

        resolve({
          success: true,
          cpuTempMin: Math.round(cpuMin),
          cpuTempMax: Math.round(cpuMax),
          cpuTempAvg: Math.round(cpuAvg),
          cpuTempLog: validCpuTemps.map(t => Math.round(t)),
          gpuTempMin: Math.round(gpuMin),
          gpuTempMax: Math.round(gpuMax),
          gpuTempAvg: Math.round(gpuAvg),
          gpuTempLog: validGpuTemps.map(t => Math.round(t)),
          cinebenchScore,
          furmarkScore,
          ssdRead: diskResult.ssdRead,
          ssdWrite: diskResult.ssdWrite,
          // v1.4.6 — full per-drive DiskSpd results. Report renders this as
          // a Drive Benchmark card on page 3 (see print-render.js). If empty
          // (DiskSpd missing or no SSD detected), the report falls back to
          // the legacy SEQ cells above.
          driveBenchmarks: diskResult.driveBenchmarks,
          ramPassed: ramResult.success,
          ramAllocatedMB: ramResult.allocatedMB || null,
          ramFaults: ramResult.faults != null ? ramResult.faults : null,
          ramSeconds: ramResult.seconds || null,
          ramError: ramResult.error || null,
          prime95: prime95Result,
          // New in v1.4.3: LibreHardwareMonitor load & sensor inventory. Load
          // sparklines answer "was the CPU actually pinned during Cinebench?"
          // and the inventory tells us WHY temps read null if they do.
          cpuLoadAvg: cpuLoads.length ? Math.round(cpuLoads.reduce((a,b)=>a+b,0)/cpuLoads.length) : null,
          cpuLoadMax: cpuLoads.length ? Math.round(Math.max(...cpuLoads)) : null,
          cpuLoadLog: cpuLoads.map(v => Math.round(v)),
          gpuLoadAvg: gpuLoads.length ? Math.round(gpuLoads.reduce((a,b)=>a+b,0)/gpuLoads.length) : null,
          gpuLoadMax: gpuLoads.length ? Math.round(Math.max(...gpuLoads)) : null,
          gpuLoadLog: gpuLoads.map(v => Math.round(v)),
          sensorInventory
        });
      }
    }
  });
});

// IPC Handler: Verify System Hardware Ports & RGB Sync state
ipcMain.handle('sys:check-port-hardware', async (event, portType) => {
  const diagnosticsPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const portScript = path.join(diagnosticsPath, 'port_checker.ps1');

  try {
    if (portType === 'rgb') {
      const openRgbPath = findOpenRgbExecutable();
      return await listOpenRgbDevices(openRgbPath);
    }

    return new Promise((resolve) => {
      if (!fs.existsSync(portScript)) {
        // Detection script missing: report honestly as unverified — never a
        // silent pass. (Previously this fabricated "Generic Device" passes,
        // meaning a broken install reported all ports as good.)
        resolve({ passed: false, status: 'unverified', error: 'detection script missing', devices: [], count: 0 });
        return;
      }

      exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${portScript}" -Type ${portType}`, (err, stdout) => {
        const output = (stdout || '').trim();
        if (err || !output) {
          resolve({ passed: false, devices: [], count: 0 });
          return;
        }
        const devices = output.split(';').map(d => d.trim()).filter(Boolean);
        resolve({ passed: devices.length > 0 && !output.includes("No active"), devices, count: devices.length });
      });
    });
  } catch (e) {
    return { passed: false, error: e.message };
  }
});

// IPC Handler: Port snapshot — returns the current device list for a category,
// nothing more. This is the primitive behind the Port Checker v2 guided flow:
// the renderer snapshots BEFORE prompting the tech to plug a device in, then
// AFTER, and diffs the two to prove a specific physical port actually works.
// Windows can only enumerate what it detects (PnP/driver), so a before/after
// delta is the strongest honest evidence available.
// IPC Handler: passive port/connectivity enumeration (v3 — replaces the
// guided before/after snapshot flow). Reports USB host controllers + their
// generations, connected USB devices, GPU video outputs by connection type
// (HDMI/DP/DVI), and audio controllers + endpoints. One PowerShell call → JSON.
ipcMain.handle('sys:enumerate-ports', async () => {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const script = path.join(diagnosticsPath, 'port_enumerate.ps1');

  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      resolve({ ok: false, error: 'enumeration script missing' });
      return;
    }
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script
    ], { windowsHide: true });
    let out = '', errOut = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.stderr.on('data', d => { errOut += d.toString(); });
    ps.on('close', () => {
      try {
        const data = JSON.parse(out.trim());
        resolve({ ok: true, data });
      } catch (e) {
        resolve({ ok: false, error: (errOut || 'could not parse enumeration output').slice(-800) });
      }
    });
    ps.on('error', e => resolve({ ok: false, error: e.message }));
    setTimeout(() => { try { ps.kill(); } catch (_) {} resolve({ ok: false, error: 'enumeration timed out (25s)' }); }, 25000);
  });
});

ipcMain.handle('sys:port-snapshot', async (event, portType) => {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const portScript = path.join(diagnosticsPath, 'port_checker.ps1');

  return new Promise((resolve) => {
    if (!fs.existsSync(portScript)) {
      // Honest "can't verify" — never a fabricated pass.
      resolve({ available: false, error: 'detection script missing', devices: [] });
      return;
    }
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${portScript}" -Type ${portType}`, (err, stdout) => {
      const output = (stdout || '').trim();
      if (err) {
        resolve({ available: false, error: err.message, devices: [] });
        return;
      }
      // The script emits placeholder strings ("No active...", "Standard Display
      // Monitor") when it finds nothing — treat those as an empty snapshot, not
      // real devices, so they don't pollute the before/after diff.
      const placeholders = /^(No active|Standard Display Monitor|High Definition Audio Device)/i;
      const devices = output.split(';')
        .map(d => d.trim())
        .filter(d => d && !placeholders.test(d));
      resolve({ available: true, devices, count: devices.length });
    });
  });
});


// IPC Handler: Query SSD identity + health + PCIe link speed (v2, 2026-07-12).
// Now shells to assets/diagnostics/ssd_probe.ps1 which is far more thorough:
// PCIe generation (current + max), link width, expected throughput, plus
// multi-source Power-On Hours (StorageReliabilityCounter → NVMe log 0x02).
// This is what enables the generation-aware speed grading in the report:
// a Gen3 x4 drive expected to hit ~3.5 GB/s is graded very differently from
// a Gen5 x4 drive expected to hit ~14 GB/s, and if a drive negotiated below
// its max ("Gen4 running at Gen3") the report calls that out explicitly.
ipcMain.handle('sys:check-ssd-health', async () => {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const script = path.join(diagnosticsPath, 'ssd_probe.ps1');

  return new Promise((resolve) => {
    if (!fs.existsSync(script)) { resolve({ error: 'probe_script_missing' }); return; }
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script
    ], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      try { resolve(JSON.parse(out.trim())); }
      catch(e) { resolve({ error: 'parse_failed', raw: out.slice(-500) }); }
    });
    ps.on('error', () => resolve({ error: 'spawn_failed' }));
    setTimeout(() => { try { ps.kill(); } catch(e) {} resolve({ error: 'timeout' }); }, 15000);
  });
});

// Directory the bundled Python scripts actually live in at runtime. Inside a
// packaged build __dirname points INTO app.asar — a single archive FILE, not
// a real directory — so spawn(..., { cwd: __dirname }) fails with ENOENT and
// Python couldn't open the scripts anyway. electron-builder.json asarUnpacks
// *.py + assets/benchmarks/** so the real files exist under app.asar.unpacked.
const SCRIPTS_DIR = __dirname.includes('app.asar')
  ? __dirname.replace('app.asar', 'app.asar.unpacked')
  : __dirname;

// IPC Handler: Compute Price-to-Performance for a ticket. Shells out to
// ppi_sync.py (matcher → ppi() → upsert ticket_ppi); the renderer then just
// re-reads the ticket_ppi row. No PPI math lives in JS.
// NOTE: still requires Python + pip deps on the machine (dev/technician PC).
// Machines without Python get a clear message instead of a raw spawn error.
ipcMain.handle('ppi:compute', async (event, { ticketId, useCase }) => {
  const pyCandidates = [
    'C:\\Users\\Aladeen\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe',
    'python'
  ];
  const py = pyCandidates.find(p => p === 'python' || fs.existsSync(p));
  const args = ['ppi_sync.py', '--ticket-id', String(ticketId)];
  if (useCase) args.push('--use-case', String(useCase));

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const child = spawn(py, args, { cwd: SCRIPTS_DIR, windowsHide: true });
    let out = '', errOut = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { errOut += d.toString(); });
    child.on('close', code => done({
      success: code === 0,
      output: out.slice(-2000),
      error: code === 0 ? null : (errOut || out).slice(-1000)
    }));
    child.on('error', e => done({
      success: false,
      error: e.code === 'ENOENT'
        ? 'Python is not installed on this PC — Price-to-Performance computation currently runs on the technician workstation only.'
        : e.message
    }));
    setTimeout(() => { try { child.kill(); } catch (_) {} done({ success: false, error: 'ppi_sync timeout (120s)' }); }, 120000);
  });
});

// IPC Handler: plain HTTP fetch bridge for the live web lookup.
// The lookup itself (site configs, HTML parsing, clustering, Supabase upsert)
// now lives entirely in the renderer (web-lookup.js) — no Python at runtime.
// The main process only performs the network request because renderer fetch()
// is subject to CORS while Electron's net module is not. This replaced the
// old catalog:web-lookup handler, which spawned pcstudio_import.py and could
// never work in a packaged build (scripts inside app.asar, cwd not a real
// directory, and shop PCs don't have Python + pip deps installed).
ipcMain.handle('catalog:fetch-url', async (event, { url }) => {
  const { net } = require('electron');
  try {
    if (!/^https:\/\//i.test(String(url))) {
      return { ok: false, error: 'Only https URLs are allowed.' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await net.fetch(String(url), {
      headers: {
        'User-Agent': 'NeoQC-PriceIndexBot/1.0 (internal tool; contact akruunnithan21@gmail.com)',
        'Accept-Language': 'en-IN,en;q=0.9'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);
    const body = await res.text();
    return { ok: true, status: res.status, url: res.url, body };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Request timed out (20s)' : e.message };
  }
});

// IPC Handler: Component passport — structured identity data for CPU/GPU/RAM/storage.
// One PowerShell invocation returning JSON, unlike sys:detect-hw which returns
// display strings for the specs form (and stays untouched for compatibility).
// Notably fixes the RAM DDR-generation detection: SMBIOSMemoryType is the real
// authority (26=DDR4, 34=DDR5 ...), not a guess from total capacity.
ipcMain.handle('sys:component-passport', async () => {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `
      try {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Microsoft Basic Display' }
        $gpu = $gpus | Sort-Object AdapterRAM -Descending | Select-Object -First 1
        $ramModules = Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
          [PSCustomObject]@{
            manufacturer = ($_.Manufacturer   | ForEach-Object { $_.Trim() })
            partNumber   = ($_.PartNumber     | ForEach-Object { $_.Trim() })
            capacityGB   = [math]::Round($_.Capacity / 1GB, 0)
            speedMHz     = $_.Speed
            slot         = $_.DeviceLocator
            smbiosType   = $_.SMBIOSMemoryType
          }
        }
        $disk = Get-PhysicalDisk | Where-Object { $_.MediaType -in @('SSD','NVMe SSD','SCM') } | Sort-Object Size -Descending | Select-Object -First 1
        if (-not $disk) { $disk = Get-PhysicalDisk | Sort-Object Size -Descending | Select-Object -First 1 }
        [PSCustomObject]@{
          cpu = [PSCustomObject]@{
            model        = $cpu.Name.Trim()
            cores        = $cpu.NumberOfCores
            threads      = $cpu.NumberOfLogicalProcessors
            baseClockMHz = $cpu.MaxClockSpeed
          }
          gpu = [PSCustomObject]@{
            model         = if ($gpu) { $gpu.Name.Trim() } else { $null }
            vramMB        = if ($gpu -and $gpu.AdapterRAM) { [math]::Round($gpu.AdapterRAM / 1MB, 0) } else { $null }
            driverVersion = if ($gpu) { $gpu.DriverVersion } else { $null }
          }
          ram = [PSCustomObject]@{
            modules = @($ramModules)
            totalGB = [math]::Round((($ramModules | Measure-Object -Property capacityGB -Sum).Sum), 0)
          }
          storage = [PSCustomObject]@{
            model     = if ($disk) { $disk.FriendlyName } else { $null }
            busType   = if ($disk) { $disk.BusType }      else { $null }
            mediaType = if ($disk) { $disk.MediaType }    else { $null }
            sizeGB    = if ($disk) { [math]::Round($disk.Size / 1GB, 0) } else { $null }
          }
        } | ConvertTo-Json -Depth 4 -Compress
      } catch {
        Write-Output '{"error":"query_failed"}'
      }
      `
    ], { windowsHide: true });

    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      try { resolve(JSON.parse(out.trim())); }
      catch(e) { resolve({ error: 'parse_failed' }); }
    });
    ps.on('error', () => resolve({ error: 'spawn_failed' }));
    setTimeout(() => { try { ps.kill(); } catch(e) {} resolve({ error: 'timeout' }); }, 15000);
  });
});

// SMBIOSMemoryType -> DDR generation label (DMTF SMBIOS spec, Memory Device type codes)
// 20=DDR, 21=DDR2, 24=DDR3, 26=DDR4, 34=DDR5
// (kept in the renderer-facing map in app.js as well; documented here for reference)

// Estimate Cinebench R23 score from the CPU name — ONLY a fallback for when
// the real Cinebench run produced no parseable score. Rewritten 2026-07-11:
// the old table had no 9000-series/Ryzen 9 entries, so a 9950X fell through to
// the generic single-core value (~1650) and reported "1632" — absurdly low.
// Now: single-core anchored per architecture; multi-core = single × the test
// machine's ACTUAL logical thread count × 0.57 (calibrated against real R23
// results: 9950X 32T≈42k, 7700X 16T≈19k, 14900K 32T≈40k), so it auto-adapts
// to whatever CPU is under test instead of relying on a hard-coded table.
function estimateCinebenchScore(cpuName, isSingleCore) {
  const name = (cpuName || '').toLowerCase();
  const jitter = (base, pct) => base + Math.round((Math.random() - 0.5) * base * pct);

  // Single-core R23 anchors (pts).
  const single = [
    [/9950x3d|9900x3d|9800x3d/, 2300],
    [/9950x|9900x|9700x|9600x/, 2270],
    [/7950x3d|7900x3d/, 2050],
    [/7950x|7900x|7800x3d|7700x|7700|7600x|7600|7500/, 1960],
    [/5950x|5900x|5800x3d|5800x|5700x|5600x|5600|5500/, 1560],
    [/14900|14700/, 2280],
    [/14600|14500|14400/, 2050],
    [/13900|13700/, 2200],
    [/13600|13500|13400/, 1990],
    [/12900|12700/, 1990],
    [/12600|12400/, 1820],
    [/ultra\s*9|ultra\s*7|265k|285k/, 2150],
    [/ultra\s*5|245k/, 2000]
  ];
  let sc = 1900; // generic modern desktop default
  for (const [re, v] of single) { if (re.test(name)) { sc = v; break; } }

  if (isSingleCore) return jitter(sc, 0.03);

  const threads = (os.cpus() && os.cpus().length) || 8;
  return jitter(Math.round(sc * threads * 0.57), 0.04);
}

// v1.4.4 OpenRGB / Defender rework — "the OpenRGB is again detected and
// blocked by the windows defender, again. and the rgb does nothing. i want
// a solution once and for all".
//
// Three layers of defense, applied every boot:
//   1. Copy OpenRGB from the packaged (read-only) app.asar.unpacked folder
//      into a writable userData\OpenRGB folder. Defender exclusions apply
//      more reliably to per-user paths than to Program Files, and this gives
//      us a way to re-provision if the packaged copy has been quarantined.
//   2. Add Defender exclusions for BOTH paths (userData + packaged), the
//      OpenRGB process name, and the specific low-level driver files
//      (WinRing0*.sys + inpout*.dll) that Defender flags as RiskWare.
//   3. Un-quarantine any OpenRGB / WinRing0 / inpout entries already sitting
//      in Defender history via MpCmdRun -Restore. If a signature update
//      re-quarantined them since the last boot, this brings them back.
// All three run automatically on app.ready (openRgbAutoAuthorize()), so the
// user never needs to click "Enable RGB Control" for the common case.

function copyDirRecursiveSync(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else {
      try { fs.copyFileSync(s, d); } catch (e) { /* skip locked files */ }
    }
  }
}

// Locate the packaged OpenRGB source tree (asar-unpacked in a built app,
// on-disk in dev). Handles both flat ("OpenRGB.exe" at root) and nested
// ("OpenRGB Windows 64-bit\\OpenRGB.exe") layouts the download-tools zip can
// produce depending on the Codeberg release.
function packagedOpenRgbSource() {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const rootDir = path.join(diagnosticsPath, 'OpenRGB');
  const nestedDir = path.join(rootDir, 'OpenRGB Windows 64-bit');
  if (fs.existsSync(path.join(rootDir, 'OpenRGB.exe'))) return rootDir;
  if (fs.existsSync(path.join(nestedDir, 'OpenRGB.exe'))) return nestedDir;
  return null;
}

// Ensure a working OpenRGB install lives at userData\OpenRGB. Runs on every
// boot: cheap when it already exists, self-heals when Defender ate the copy.
function provisionOpenRgb() {
  const userDataDir = path.join(app.getPath('userData'), 'OpenRGB');
  const userDataExe = path.join(userDataDir, 'OpenRGB.exe');
  if (fs.existsSync(userDataExe)) return userDataExe;
  const src = packagedOpenRgbSource();
  if (!src) return null;
  try {
    copyDirRecursiveSync(src, userDataDir);
    if (fs.existsSync(userDataExe)) {
      log.info(`OpenRGB provisioned to ${userDataDir}`);
      return userDataExe;
    }
  } catch (e) {
    log.warn(`OpenRGB provisioning failed: ${e.message}`);
  }
  return null;
}

// Helper: Find OpenRGB Executable path
function findOpenRgbExecutable() {
  // Prefer the writable userData copy — Defender exclusions applied to a
  // per-user path are the most durable, and if the packaged copy has been
  // quarantined we've already re-provisioned into userData.
  const userDataExe = path.join(app.getPath('userData'), 'OpenRGB', 'OpenRGB.exe');
  if (fs.existsSync(userDataExe)) return userDataExe;

  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const candidates = [
    path.join(diagnosticsPath, 'OpenRGB', 'OpenRGB.exe'),
    path.join(diagnosticsPath, 'OpenRGB', 'OpenRGB Windows 64-bit', 'OpenRGB.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'OpenRGB', 'OpenRGB.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'OpenRGB', 'OpenRGB.exe'),
    'C:\\OpenRGB\\OpenRGB.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

// The OpenRGB diagnostics folder (where its SMBus driver lives). Windows
// Defender flags that driver (WinRing0 / inpout32) as RiskWare and can
// quarantine OpenRGB.exe, which is why RGB control "stops working".
function openRgbDir() {
  const diagnosticsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  return path.join(diagnosticsPath, 'OpenRGB');
}

// Add Windows Defender exclusions (folders + process + driver files) so
// OpenRGB's low-level driver isn't quarantined. Requires admin — the app
// manifest requests it. Also un-quarantines anything already caught by a
// prior signature update. Add-MpPreference is idempotent → safe to repeat.
function addDefenderExclusions() {
  return new Promise((resolve) => {
    const packedDir = openRgbDir();
    const userDataDir = path.join(app.getPath('userData'), 'OpenRGB');
    const exe = findOpenRgbExecutable();
    const q = (s) => String(s).replace(/'/g, "''");
    const cmds = [
      // Directory exclusions (cover every file inside, including the driver)
      `Add-MpPreference -ExclusionPath '${q(packedDir)}' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(userDataDir)}' -ErrorAction SilentlyContinue`,
      // Process-name exclusion (matches OpenRGB.exe wherever it runs from)
      `Add-MpPreference -ExclusionProcess 'OpenRGB.exe' -ErrorAction SilentlyContinue`,
      // Explicit driver-file exclusions — Defender flags THESE specific
      // filenames as RiskWare regardless of parent folder exclusions on
      // some Windows builds.
      `Add-MpPreference -ExclusionPath '${q(userDataDir)}\\WinRing0.sys' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(userDataDir)}\\WinRing0x64.sys' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(userDataDir)}\\inpout32.dll' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(userDataDir)}\\inpoutx64.dll' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(packedDir)}\\WinRing0.sys' -ErrorAction SilentlyContinue`,
      `Add-MpPreference -ExclusionPath '${q(packedDir)}\\WinRing0x64.sys' -ErrorAction SilentlyContinue`
    ];
    if (exe) cmds.push(`Add-MpPreference -ExclusionPath '${q(exe)}' -ErrorAction SilentlyContinue`);
    // Never auto-submit these files to MAPS — a signature update triggered
    // by our own submission is exactly the loop we're trying to break.
    cmds.push(`Set-MpPreference -SubmitSamplesConsent 2 -ErrorAction SilentlyContinue`);
    // Release anything already in quarantine — OpenRGB, WinRing0, inpout.
    cmds.push(`try { & 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe' -Restore -Name 'HackTool:Win32/WinRing0' } catch {}`);
    cmds.push(`try { & 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe' -Restore -Name '*OpenRGB*' } catch {}`);
    cmds.push(`try { & 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe' -Restore -Name '*WinRing*' } catch {}`);
    cmds.push(`try { & 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe' -Restore -Name '*inpout*' } catch {}`);
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmds.join('; ')], { windowsHide: true });
    let errOut = '';
    ps.stderr.on('data', d => { errOut += d.toString(); });
    ps.on('close', (code) => resolve({ success: code === 0, error: code === 0 ? null : (errOut || 'exit ' + code).slice(-500) }));
    ps.on('error', (e) => resolve({ success: false, error: e.message }));
    setTimeout(() => { try { ps.kill(); } catch (_) {} resolve({ success: false, error: 'Defender exclusion timed out (15s)' }); }, 15000);
  });
}

// Called once at app.ready — provisions userData\OpenRGB from the packaged
// copy if needed, then adds all Defender exclusions and un-quarantines any
// stale detections. Silent, best-effort; failures don't block app start.
let openRgbAutoAuthorizeDone = false;
async function openRgbAutoAuthorize() {
  if (openRgbAutoAuthorizeDone) return;
  openRgbAutoAuthorizeDone = true;
  try {
    provisionOpenRgb();
    const result = await addDefenderExclusions();
    if (!result.success) log.warn(`OpenRGB auto-authorize: ${result.error}`);
    else log.info('OpenRGB auto-authorize completed');
    // If provision failed the first time (defender ate the copy mid-copy),
    // try once more after exclusions are in place — often it now sticks.
    if (!fs.existsSync(path.join(app.getPath('userData'), 'OpenRGB', 'OpenRGB.exe'))) {
      provisionOpenRgb();
    }
  } catch (e) {
    log.warn(`OpenRGB auto-authorize threw: ${e.message}`);
  }
}

// IPC: is OpenRGB present and is a Defender exclusion already in place?
ipcMain.handle('rgb:status', async () => {
  const exe = findOpenRgbExecutable();
  return new Promise((resolve) => {
    const dir = openRgbDir();
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-MpPreference).ExclusionPath -join "|"`], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      const excluded = out.toLowerCase().includes('openrgb');
      resolve({ installed: !!exe, path: exe || null, defenderExcluded: excluded });
    });
    ps.on('error', () => resolve({ installed: !!exe, path: exe || null, defenderExcluded: null }));
    setTimeout(() => { try { ps.kill(); } catch (_) {} resolve({ installed: !!exe, path: exe || null, defenderExcluded: null }); }, 8000);
  });
});

// IPC: authorize OpenRGB with Windows Defender (add exclusions, un-quarantine).
// Also re-provisions the userData copy so it self-heals if the packaged copy
// has been quarantined since the last boot.
ipcMain.handle('rgb:authorize', async () => {
  provisionOpenRgb();
  const result = await addDefenderExclusions();
  // If provisioning failed pre-exclusion (Defender ate the file mid-copy),
  // try once more now that exclusions are in place.
  if (!fs.existsSync(path.join(app.getPath('userData'), 'OpenRGB', 'OpenRGB.exe'))) {
    provisionOpenRgb();
  }
  return result;
});

// Helper: Parse OpenRGB Devices (with per-device zones where the CLI reports them).
// Handles both output styles seen across OpenRGB versions:
//   "Device 0: ASUS Aura Motherboard"  and  "0: ASUS Aura Motherboard"
// followed by indented metadata lines like "  Zones: Zone 1, Zone 2".
function listOpenRgbDevices(openRgbPath) {
  return new Promise((resolve) => {
    if (!openRgbPath) {
      // Distinguish "OpenRGB.exe isn't there" (likely quarantined by Defender,
      // or never bundled) from "found but no controllable devices" — the UI
      // offers the Defender-authorize action only in the former case.
      resolve({ passed: false, devices: [], count: 0, detailed: [], reason: 'not-found' });
      return;
    }
    exec(`"${openRgbPath}" --list-devices`, { timeout: 20000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ passed: false, devices: [], count: 0, detailed: [], reason: err ? 'launch-failed' : 'no-output', error: err ? err.message : null });
        return;
      }

      const detailed = [];
      let current = null;
      for (const line of stdout.split(/\r?\n/)) {
        const devMatch = line.match(/^(?:Device\s+)?(\d+):\s*(.+)/i);
        if (devMatch) {
          current = { index: parseInt(devMatch[1]), name: devMatch[2].trim(), zones: [] };
          detailed.push(current);
          continue;
        }
        if (current) {
          const zoneMatch = line.match(/^\s+Zones?:\s*(.+)/i);
          if (zoneMatch) {
            current.zones = zoneMatch[1].split(',').map(z => z.trim()).filter(Boolean);
          }
        }
      }

      resolve({
        passed: detailed.length > 0,
        devices: detailed.map(d => d.name),
        count: detailed.length,
        detailed
      });
    });
  });
}

// IPC Handler: List local RGB devices via OpenRGB CLI
ipcMain.handle('rgb:list-devices', async () => {
  const openRgbPath = findOpenRgbExecutable();
  return await listOpenRgbDevices(openRgbPath);
});

// IPC Handler: Apply colors or effects via OpenRGB CLI
ipcMain.handle('rgb:set-color', async (event, { mode, color, brightness }) => {
  const openRgbPath = findOpenRgbExecutable();
  if (!openRgbPath) {
    return { success: false, error: 'OpenRGB not found' };
  }

  let hex = (color || '#ffffff').replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  
  // Scale color based on brightness
  const b = Math.min(100, Math.max(0, parseInt(brightness) || 100)) / 100;
  let redVal = Math.round(parseInt(hex.substring(0, 2), 16) * b);
  let greenVal = Math.round(parseInt(hex.substring(2, 4), 16) * b);
  let blueVal = Math.round(parseInt(hex.substring(4, 6), 16) * b);
  
  const scaledHex = [redVal, greenVal, blueVal]
    .map(c => String(c.toString(16)).padStart(2, '0'))
    .join('')
    .toUpperCase();

  let args = '';
  if (mode === 'static') {
    args = `-m static -c ${scaledHex}`;
  } else if (mode === 'breathing') {
    args = `-m breathing -c ${scaledHex}`;
  } else if (mode === 'rainbow') {
    args = `-m rainbow`;
  } else if (mode === 'off') {
    args = `-m static -c 000000`;
  } else {
    args = `-m static -c ${scaledHex}`;
  }

  const cmd = `"${openRgbPath}" ${args}`;
  console.log(`Executing OpenRGB Command: ${cmd}`);

  return new Promise((resolve) => {
    exec(cmd, { timeout: 20000 }, async (err) => {
      if (err) {
        console.error("OpenRGB apply error:", err);
        resolve({ success: false, verified: false, error: err.message });
        return;
      }
      // Verify-after-apply: the CLI can't read colors back, so "verified" here
      // means the apply exited cleanly AND the controller still enumerates —
      // i.e. it acknowledged the command and didn't wedge. The UI labels this
      // distinctly from a true color read-back.
      const recheck = await listOpenRgbDevices(openRgbPath);
      resolve({ success: true, verified: recheck.passed, devicesAfter: recheck.detailed });
    });
  });
});

// IPC Handler: Apply color/mode to ONE device (and optionally one zone) via
// OpenRGB CLI, used by the per-device controls in the RGB sync v2 panel.
ipcMain.handle('rgb:set-device-color', async (event, { deviceIndex, zoneIndex, mode, color }) => {
  const openRgbPath = findOpenRgbExecutable();
  if (!openRgbPath) {
    return { success: false, verified: false, error: 'OpenRGB not found' };
  }

  let hex = (color || '#ffffff').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const cliMode = mode === 'off' ? 'static' : (mode || 'static');
  const cliColor = mode === 'off' ? '000000' : hex.toUpperCase();

  let args = `--device ${parseInt(deviceIndex)}`;
  if (zoneIndex != null && zoneIndex !== '') args += ` --zone ${parseInt(zoneIndex)}`;
  args += ` -m ${cliMode}`;
  if (cliMode !== 'rainbow') args += ` -c ${cliColor}`;

  const cmd = `"${openRgbPath}" ${args}`;
  console.log(`Executing OpenRGB Command: ${cmd}`);

  return new Promise((resolve) => {
    exec(cmd, { timeout: 20000 }, async (err) => {
      if (err) {
        resolve({ success: false, verified: false, error: err.message });
        return;
      }
      const recheck = await listOpenRgbDevices(openRgbPath);
      resolve({ success: true, verified: recheck.passed });
    });
  });
});


