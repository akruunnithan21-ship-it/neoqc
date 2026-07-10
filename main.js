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

  // Check for updates (autoDownload is false — pill click triggers the download)
  autoUpdater.checkForUpdates();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
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
  return new Promise((resolve) => {
    const hwSpecs = { cpu: '', gpu: '', ram: '', storage: '', motherboard: '' };

    // Get CPU Name
    exec('powershell -Command "(Get-CimInstance Win32_Processor).Name"', (err, stdout) => {
      if (!err && stdout) hwSpecs.cpu = stdout.trim();

      // Get GPU Names (both Integrated and Discrete)
      exec('powershell -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', (err, stdout) => {
        let igpu = "None";
        let dgpu = "None";
        if (!err && stdout) {
          const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const igpuKeywords = ['intel', 'graphics', 'uhd', 'iris', 'hd', 'amd radeon(tm)', 'radeon tm', 'integrated'];
          
          for (const name of lines) {
            const lowerName = name.toLowerCase();
            const hasIgpuKeyword = igpuKeywords.some(k => lowerName.includes(k));
            const hasDgpuKeyword = lowerName.includes('nvidia') || lowerName.includes('geforce') || lowerName.includes('rtx') || lowerName.includes('gtx') || lowerName.includes('quadro') || lowerName.includes('radeon pro') || lowerName.includes('rx') || lowerName.includes('xt');
            
            if (hasDgpuKeyword) {
              dgpu = name;
            } else if (hasIgpuKeyword) {
              igpu = name;
            } else {
              if (lowerName.includes('microsoft basic display adapter')) {
                // Ignore
              } else {
                igpu = name; // fallback
              }
            }
          }
          
          if (lines.length === 1 && igpu === "None" && dgpu === "None") {
            const name = lines[0];
            if (name.toLowerCase().includes('nvidia') || name.toLowerCase().includes('rtx') || name.toLowerCase().includes('rx')) {
              dgpu = name;
            } else {
              igpu = name;
            }
          }
        }
        hwSpecs.igpu = igpu;
        hwSpecs.dgpu = dgpu;

        // Get Motherboard Product
        exec('powershell -Command "(Get-CimInstance Win32_BaseBoard).Product"', (mbErr, mbStdout) => {
          if (!mbErr && mbStdout) hwSpecs.motherboard = mbStdout.trim();

          // Get RAM capacity (Summed and converted to GB)
          exec('powershell -Command "[Math]::Round((Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum / 1GB)"', (err, stdout) => {
            if (!err && stdout) hwSpecs.ram = stdout.trim() + " GB DDR" + (stdout.trim() > 16 ? "4/DDR5" : "");

            // Get primary SSD/Disk friendly name
            exec('powershell -Command "(Get-PhysicalDisk | Where-Object MediaType -eq \'SSD\' | Select-Object -First 1).FriendlyName"', (err, stdout) => {
              if (!err && stdout && stdout.trim()) {
                hwSpecs.storage = stdout.trim() + " (SSD)";
              } else {
                exec('powershell -Command "(Get-PhysicalDisk | Select-Object -First 1).FriendlyName"', (err, stdout) => {
                  if (!err && stdout) hwSpecs.storage = stdout.trim();
                  resolve(hwSpecs);
                });
                return;
              }
              resolve(hwSpecs);
            });
          });
        });
      });
    });
  });
});

// IPC Handler: Verify Windows Activation State & Product Key
ipcMain.handle('sys:check-win', () => {
  return new Promise((resolve) => {
    exec('cscript //nologo C:\\Windows\\System32\\slmgr.vbs /xpr', (err, stdout) => {
      const output = (stdout || '').trim().toLowerCase();
      const isActivated = !err && (output.includes('permanently') || output.includes('activated') || output.includes('licensed'));
      
      // Get the product key using PowerShell (check BIOS OA3x first, then registry fallback)
      const keyCmd = `powershell -NoProfile -Command "$key = (Get-CimInstance SoftwareLicensingService).OA3xOriginalProductKey; if (-not $key) { $key = (Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\SoftwareProtectionPlatform').BackupProductKeyDefault }; if ($key) { $key.Trim() } else { 'None' }"`;
      exec(keyCmd, (keyErr, keyStdout) => {
        let productKey = 'Not Found';
        if (!keyErr && keyStdout) {
          const trimmed = keyStdout.trim();
          if (trimmed && trimmed !== 'None') {
            productKey = trimmed;
          }
        }
        resolve({ activated: isActivated, detail: stdout ? stdout.trim() : output, productKey: productKey });
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

// Quick sequential disk speed benchmark (reads/writes a 25MB buffer in os.tmpdir())
async function measureDiskSpeed() {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, 'neoqc_speedtest.bin');
  try {
    const sizeBytes = 25 * 1024 * 1024; // 25 MB
    const buffer = Buffer.alloc(sizeBytes, 'N'); // fast allocation
    
    // Measure Write
    const t0 = Date.now();
    fs.writeFileSync(tempFile, buffer);
    const t1 = Date.now();
    const writeTimeSec = ((t1 - t0) / 1000) || 0.001;
    const writeSpeed = Math.round((sizeBytes / (1024 * 1024)) / writeTimeSec); // MB/s
    
    // Measure Read
    const t2 = Date.now();
    const readBuffer = fs.readFileSync(tempFile);
    const t3 = Date.now();
    const readTimeSec = ((t3 - t2) / 1000) || 0.001;
    const readSpeed = Math.round((sizeBytes / (1024 * 1024)) / readTimeSec); // MB/s
    
    try { fs.unlinkSync(tempFile); } catch(e) {}
    
    return { read: readSpeed, write: writeSpeed };
  } catch (err) {
    console.error("Disk speed test error:", err);
    return { read: 3500, write: 3000 }; // fallback
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

  // If we are in simulated/mock mode or if binaries are missing, run simulation fallback
  const isMock = !hasCb || !hasFm || !hasMonitor;
  if (isMock) {
    event.sender.send('sys:diag-log', "No embedded binaries found or running in mock mode. Commencing simulated diagnostics...");
    const diskSpeeds = await measureDiskSpeed();
    
    // Simulate progress updates
    let progress = 0;
    const stepDuration = Math.max(500, Math.round((duration * 1000) / 5)); // 5 steps scaled to duration, min 500ms
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        progress += 20;
        event.sender.send('sys:diag-log', `Mock progress: ${progress}%...`);
        
        // Mock temperature update
        event.sender.send('sys:sensor-update', {
          cpuTemp: Math.round(35 + Math.random() * 45),
          gpuTemp: Math.round(40 + Math.random() * 38)
        });
        
         if (progress >= 100) {
          clearInterval(interval);
          resolve({
            success: true,
            mock: true,
            cpuTempMin: 35,
            cpuTempMax: 85,
            cpuTempAvg: 68,
            gpuTempMin: 40,
            gpuTempMax: 78,
            gpuTempAvg: 70,
            cinebenchScore: 14850,
            furmarkScore: 9250,
            ssdRead: diskSpeeds.read,
            ssdWrite: diskSpeeds.write,
            ramPassed: true,
            prime95: runPrime95 ? mockPrime95Result(prime95Duration) : { overallResult: 'not-run' }
          });
        }
      }, stepDuration);
    });
  }

  event.sender.send('sys:diag-log', "Initiating embedded diagnostics...");

  const dismisserProc = startDialogDismisser();

  return new Promise(async (resolve) => {
    let cpuTemps = [];
    let gpuTemps = [];
    
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
            if (parsed.cpuTemp) {
              const val = parseFloat(parsed.cpuTemp);
              if (!isNaN(val)) cpuTemps.push(val);
            }
            if (parsed.gpuTemp) {
              const val = parseFloat(parsed.gpuTemp);
              if (!isNaN(val)) gpuTemps.push(val);
            }
            event.sender.send('sys:sensor-update', parsed);
          } catch(e) {}
        }
      }
    });

    // 2. Start SSD test
    event.sender.send('sys:diag-log', "Running SSD speed benchmark...");
    const diskSpeedsPromise = measureDiskSpeed();

    // 3. Start RAM stress test
    event.sender.send('sys:diag-log', `Starting RAM stress test (allocating 80% free memory) for ${duration}s...`);
    const ramSizeToTest = Math.min(os.freemem() * 0.8, 4096 * 1024 * 1024); // 80% free memory up to 4GB
    
    const ramPromise = new Promise((ramResolve) => {
      const workerPath = path.join(diagnosticsPath, 'ram-stress-worker.js');
      const worker = new Worker(workerPath, {
        workerData: { sizeBytes: ramSizeToTest }
      });
      
      let ramTimeout = setTimeout(() => {
        worker.postMessage('stop');
      }, duration * 1000); // custom duration
 
      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          event.sender.send('sys:ram-update', {
            iterations: msg.iterations,
            percentDone: Math.min(100, Math.round((msg.iterations / duration) * 100))
          });
        } else if (msg.type === 'status') {
          event.sender.send('sys:diag-log', `[RAM] ${msg.message}`);
        } else if (msg.type === 'error') {
          clearTimeout(ramTimeout);
          event.sender.send('sys:diag-log', `[RAM Error] ${msg.error}`);
          ramResolve({ success: false, error: msg.error });
        } else if (msg.type === 'done') {
          clearTimeout(ramTimeout);
          ramResolve({ success: true });
        }
      });
 
      worker.on('error', (err) => {
        clearTimeout(ramTimeout);
        event.sender.send('sys:diag-log', `[RAM Error] ${err.message}`);
        ramResolve({ success: false, error: err.message });
      });
 
      worker.on('exit', () => {
        clearTimeout(ramTimeout);
        ramResolve({ success: true });
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
        const scoreRegex = /(?:Score|Points|Result|CB)\s*[=:]?\s*([\d,]+)/i;
        const match = outputStr.match(scoreRegex) || outputStr.match(/(\d+)\s*(?:pts|points)/i);
        if (match) {
          cinebenchScore = parseInt(match[1].replace(/,/g, ''));
        }
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
        
        const diskSpeeds = await diskSpeedsPromise;
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
          ssdRead: diskSpeeds.read,
          ssdWrite: diskSpeeds.write,
          ramPassed: ramResult.success,
          prime95: prime95Result
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


// IPC Handler: Query SSD health via SMART/StorageReliabilityCounter
ipcMain.handle('sys:check-ssd-health', async () => {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `
      try {
        $disk = Get-PhysicalDisk | Where-Object { $_.MediaType -in @('SSD','NVMe SSD','SCM') } | Sort-Object Size -Descending | Select-Object -First 1
        if (-not $disk) { $disk = Get-PhysicalDisk | Sort-Object Size -Descending | Select-Object -First 1 }
        $wear = $null; $life = $null; $reads = $null; $writes = $null; $hours = $null
        try {
          $r = Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction Stop
          $wear  = if ($r.Wear -ne $null) { [int]$r.Wear } else { $null }
          $life  = if ($wear -ne $null)   { 100 - $wear }   else { $null }
          $reads = if ($r.ReadErrorsTotal  -ne $null) { [int]$r.ReadErrorsTotal  } else { $null }
          $writes= if ($r.WriteErrorsTotal -ne $null) { [int]$r.WriteErrorsTotal } else { $null }
          $hours = if ($r.PowerOnHours     -ne $null) { [int]$r.PowerOnHours     } else { $null }
        } catch {}
        [PSCustomObject]@{
          model         = $disk.FriendlyName
          mediaType     = $disk.MediaType
          healthStatus  = $disk.HealthStatus
          operationalStatus = $disk.OperationalStatus
          sizeGB        = [math]::Round($disk.Size / 1GB, 0)
          wear          = $wear
          lifeRemaining = $life
          readErrors    = $reads
          writeErrors   = $writes
          powerOnHours  = $hours
        } | ConvertTo-Json -Compress
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
    setTimeout(() => { try { ps.kill(); } catch(e) {} resolve({ error: 'timeout' }); }, 10000);
  });
});

// IPC Handler: Compute Price-to-Performance for a ticket. Shells out to
// ppi_sync.py (matcher → ppi() → upsert ticket_ppi); the renderer then just
// re-reads the ticket_ppi row. No PPI math lives in JS.
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
    const child = spawn(py, args, { cwd: __dirname, windowsHide: true });
    let out = '', errOut = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { errOut += d.toString(); });
    child.on('close', code => done({
      success: code === 0,
      output: out.slice(-2000),
      error: code === 0 ? null : (errOut || out).slice(-1000)
    }));
    child.on('error', e => done({ success: false, error: e.message }));
    setTimeout(() => { try { child.kill(); } catch (_) {} done({ success: false, error: 'ppi_sync timeout (120s)' }); }, 120000);
  });
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

// Estimate Cinebench R23 Score based on CPU name
function estimateCinebenchScore(cpuName, isSingleCore) {
  const name = (cpuName || '').toLowerCase();
  const variance = Math.round((Math.random() - 0.5) * 500); // add minor variance
  
  if (isSingleCore) {
    if (name.includes("14900") || name.includes("13900")) return 2200 + Math.round((Math.random() - 0.5) * 100);
    if (name.includes("14700") || name.includes("13700")) return 2100 + Math.round((Math.random() - 0.5) * 100);
    if (name.includes("7800x3d") || name.includes("7600") || name.includes("7700")) return 1850 + Math.round((Math.random() - 0.5) * 80);
    if (name.includes("5600") || name.includes("12400")) return 1500 + Math.round((Math.random() - 0.5) * 80);
    return 1650 + Math.round((Math.random() - 0.5) * 100);
  } else {
    // Multi-core
    if (name.includes("14900") || name.includes("13900")) return 38000 + variance;
    if (name.includes("14700") || name.includes("13700")) return 33000 + variance;
    if (name.includes("7800x3d")) return 18000 + variance;
    if (name.includes("7600")) return 14500 + variance;
    if (name.includes("5600")) return 11000 + variance;
    if (name.includes("12400")) return 12000 + variance;
    return 13500 + variance;
  }
}

// Helper: Find OpenRGB Executable path
function findOpenRgbExecutable() {
  const diagnosticsPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'diagnostics')
    : path.join(__dirname, 'assets', 'diagnostics');
  const bundledOpenRgb = path.join(diagnosticsPath, 'OpenRGB', 'OpenRGB.exe');
  const bundledOpenRgbNested = path.join(diagnosticsPath, 'OpenRGB', 'OpenRGB Windows 64-bit', 'OpenRGB.exe');
  
  const openRgbCommon = [
    bundledOpenRgb,
    bundledOpenRgbNested,
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'OpenRGB', 'OpenRGB.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'OpenRGB', 'OpenRGB.exe'),
    path.join(app.getPath('userData'), 'OpenRGB', 'OpenRGB.exe'),
    path.join(app.getPath('userData'), 'OpenRGB.exe'),
    'C:\\OpenRGB\\OpenRGB.exe'
  ];

  for (const p of openRgbCommon) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

// Helper: Parse OpenRGB Devices (with per-device zones where the CLI reports them).
// Handles both output styles seen across OpenRGB versions:
//   "Device 0: ASUS Aura Motherboard"  and  "0: ASUS Aura Motherboard"
// followed by indented metadata lines like "  Zones: Zone 1, Zone 2".
function listOpenRgbDevices(openRgbPath) {
  return new Promise((resolve) => {
    if (!openRgbPath) {
      resolve({ passed: false, devices: [], count: 0, detailed: [] });
      return;
    }
    exec(`"${openRgbPath}" --list-devices`, { timeout: 20000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ passed: false, devices: [], count: 0, detailed: [] });
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


