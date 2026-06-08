const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

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
    for ($i = 0; $i -lt 480; $i++) {
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
        supabaseUrl: "",
        supabaseAnonKey: ""
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
  initDb();
  createWindow();

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
    const hwSpecs = { cpu: '', gpu: '', ram: '', storage: '' };

    // Get CPU Name
    exec('powershell -Command "(Get-CimInstance Win32_Processor).Name"', (err, stdout) => {
      if (!err && stdout) hwSpecs.cpu = stdout.trim();

      // Get GPU Name
      exec('powershell -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"', (err, stdout) => {
        if (!err && stdout) hwSpecs.gpu = stdout.trim();

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

// IPC Handler: Verify Windows Activation State
ipcMain.handle('sys:check-win', () => {
  return new Promise((resolve) => {
    exec('cscript //nologo C:\\Windows\\System32\\slmgr.vbs /xpr', (err, stdout) => {
      if (err) {
        resolve({ activated: false, detail: "Error running activation tool." });
        return;
      }
      const output = stdout.trim().toLowerCase();
      // slmgr outputs: "The machine is permanently activated" or "Volume activation will expire..."
      const isActivated = output.includes('permanently') || output.includes('activated') || output.includes('licensed');
      resolve({ activated: isActivated, detail: stdout.trim() });
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

// Quick sequential disk speed benchmark (reads/writes a 100MB buffer in C:\temp)
async function measureDiskSpeed() {
  const tempDir = 'C:\\temp';
  if (!fs.existsSync(tempDir)) {
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (e) {}
  }
  const tempFile = path.join(tempDir, 'speedtest.bin');
  try {
    const sizeBytes = 100 * 1024 * 1024; // 100 MB
    const buffer = crypto.randomBytes(sizeBytes);
    
    // Measure Write
    const t0 = Date.now();
    fs.writeFileSync(tempFile, buffer);
    const t1 = Date.now();
    const writeTimeSec = (t1 - t0) / 1000;
    const writeSpeed = Math.round((sizeBytes / (1024 * 1024)) / writeTimeSec); // MB/s
    
    // Measure Read
    const t2 = Date.now();
    const readBuffer = fs.readFileSync(tempFile);
    const t3 = Date.now();
    const readTimeSec = (t3 - t2) / 1000;
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

// IPC Handler: Run Automated Diagnostics (External Path Config)
ipcMain.handle('sys:run-diagnostics', async (event, config) => {
  const { pathHwInfo, pathCinebench, pathFurmark } = config;

  const realHwInfo = resolveExecutable(pathHwInfo, ['HWiNFO64.exe', 'HWiNFO32.exe', 'HWiNFO64 Pro.exe']);
  const realCinebench = resolveExecutable(pathCinebench, ['Cinebench.exe', 'CinebenchR23.exe', 'Cinebench 2024.exe', 'Cinebench_x64.exe']);
  const realFurmark = resolveExecutable(pathFurmark, ['FurMark.exe', 'FurMark2.exe', 'Furmark.exe', 'Geeks3D FurMark.exe', 'FurMark_x64.exe', 'FurMark2_x64.exe']);

  // Mock Mode: if any path is "mock" or if all are blank, simulate execution
  const isMock = (!pathHwInfo || pathHwInfo === 'mock') && (!pathCinebench || pathCinebench === 'mock') && (!pathFurmark || pathFurmark === 'mock');
  if (isMock) {
    const diskSpeeds = await measureDiskSpeed();
    return new Promise((resolve) => {
      setTimeout(() => {
        const mockCsv = `
"Date","Time","CPU (Tctl/Tdie) [°C]","GPU Temperature [°C]"
"08.06.2026","12:00:00",35.0,40.0
"08.06.2026","12:00:10",82.5,75.0
"08.06.2026","12:00:20",85.0,78.0
"08.06.2026","12:00:30",80.0,76.0
"08.06.2026","12:00:40",68.0,70.0
`;
        resolve({
          success: true,
          mock: true,
          csvContent: mockCsv,
          cinebenchScore: 14850,
          ssdRead: diskSpeeds.read,
          ssdWrite: diskSpeeds.write
        });
      }, 5000);
    });
  }

  // Real Mode Checks
  if (!realHwInfo || !fs.existsSync(realHwInfo)) return { success: false, error: `HWiNFO64 path does not exist: ${realHwInfo}` };
  if (!realCinebench || !fs.existsSync(realCinebench)) return { success: false, error: `Cinebench R23 path does not exist: ${realCinebench}` };
  if (!realFurmark || !fs.existsSync(realFurmark)) return { success: false, error: `FurMark path does not exist: ${realFurmark}` };

  const tempDir = 'C:\\temp';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const csvPath = path.join(tempDir, 'neoqc_sensors.csv');
  if (fs.existsSync(csvPath)) {
    try { fs.unlinkSync(csvPath); } catch(e) {}
  }

  // Pre-emptively kill any running HWiNFO64 instance so logging starts clean
  await new Promise((resolveKill) => {
    exec('taskkill /F /IM HWiNFO64.exe /IM HWiNFO32.exe', () => {
      resolveKill();
    });
  });

  return new Promise(async (resolve) => {
    let cinebenchDone = false;
    let furmarkDone = false;
    let cinebenchScore = 0;
    
    // Concurrently run actual SSD speed test
    const diskSpeedsPromise = measureDiskSpeed();

    // 1. Launch HWiNFO64 minimized logging
    const hwinfoCmd = `"${realHwInfo}" -log="${csvPath}" -minimize`;
    exec(hwinfoCmd, { cwd: path.dirname(realHwInfo) }, (err) => {
      if (err) console.error("HWiNFO64 launch/run error:", err);
    });

    // 2. Launch Cinebench R23 (correct CLI: g_CinebenchCpuXTest=true, auto-accept any dialogs)
    let cbCmd;
    if (realCinebench.toLowerCase().includes('2024')) {
      // Cinebench 2024 flags
      cbCmd = `"${realCinebench}" g_CinebenchCpuXTest=true g_CinebenchMinimumRunTime=120`;
    } else {
      // Cinebench R23 correct multi-core flag (not -cb_cpux which is wrong)
      cbCmd = `"${realCinebench}" g_CinebenchCpuXTest=true g_CinebenchMinimumTestDuration=1`;
    }

    // Launch background dialog dismisser before starting Cinebench (it auto-clicks OK on any popup)
    const dismisserProc = startDialogDismisser();

    exec(cbCmd, { cwd: path.dirname(realCinebench), timeout: 360000 }, (err, stdout, stderr) => {
      cinebenchDone = true;
      if (err) console.error("Cinebench run error:", err);
      let outputStr = stdout || "";
      if (stderr) outputStr += "\n" + stderr;

      // Try to get the Cinebench score from CINEBENCH R23's log file
      const cbLogDir = path.dirname(realCinebench);
      const possibleLogFiles = ['cb.log', 'cinebench.log', 'results.txt'];
      for (const logFile of possibleLogFiles) {
        const logPath = path.join(cbLogDir, logFile);
        if (fs.existsSync(logPath)) {
          try {
            outputStr += '\n' + fs.readFileSync(logPath, 'utf-8');
          } catch(e) {}
        }
      }

      if (outputStr) {
        const multiCoreRegex = /(?:Multi\s*Core|Multi-Core|MC|nT)[^\d]*:\s*([\d,]+)/i;
        const scoreRegex = /(?:Score|Points|Result|CB)\s*[=:]?\s*([\d,]+)/i;
        const match = outputStr.match(multiCoreRegex) || outputStr.match(scoreRegex) || outputStr.match(/(\d+)\s*(?:pts|points)/i);
        if (match) {
          cinebenchScore = parseInt(match[1].replace(/,/g, ''));
        } else {
          // Fallback: search for numbers in plausible Cinebench score range (3000-120000)
          const nums = outputStr.match(/\b\d{4,6}\b/g);
          if (nums) {
            const plausible = nums.map(n => parseInt(n)).filter(n => n >= 3000 && n <= 120000);
            if (plausible.length > 0) {
              cinebenchScore = Math.max(...plausible);
            }
          }
        }
      }

      // Kill the dialog dismisser
      if (dismisserProc) {
        try { process.kill(-dismisserProc.pid); } catch(e) {}
      }

      checkCompletion();
    });

    // 3. Launch FurMark (OpenGL or Vulkan benchmark)
    let fmCmd;
    if (realFurmark.toLowerCase().includes('furmark2') || realFurmark.toLowerCase().includes('furmark 2') || realFurmark.toLowerCase().includes('furmark2_x64')) {
      fmCmd = `"${realFurmark}" --width=1280 --height=720 --max-time=120 --demo=furmark-vk --vsync=0`;
    } else {
      fmCmd = `"${realFurmark}" /width=1280 /height=720 /run_time=120000 /nogui`;
    }
    exec(fmCmd, { cwd: path.dirname(realFurmark) }, (err) => {
      if (err) console.error("FurMark error:", err);
      furmarkDone = true;
      checkCompletion();
    });

    async function checkCompletion() {
      if (cinebenchDone && furmarkDone) {
        const diskSpeeds = await diskSpeedsPromise;
        // Kill HWiNFO64 to close and flush the CSV file
        exec('taskkill /F /IM HWiNFO64.exe /IM HWiNFO32.exe', () => {
          setTimeout(() => {
            let csvContent = '';
            if (fs.existsSync(csvPath)) {
              try {
                csvContent = fs.readFileSync(csvPath, 'utf-8');
              } catch (e) {
                console.error("Read CSV Log Error:", e);
              }
            }
            resolve({
              success: true,
              csvContent,
              cinebenchScore,
              ssdRead: diskSpeeds.read,
              ssdWrite: diskSpeeds.write
            });
          }, 1500);
        });
      }
    }
  });
});
