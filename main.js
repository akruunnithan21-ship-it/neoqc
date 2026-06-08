const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

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

// IPC Handler: Run Automated Diagnostics (External Path Config)
ipcMain.handle('sys:run-diagnostics', async (event, config) => {
  const { pathHwInfo, pathCinebench, pathFurmark } = config;

  // Mock Mode: if any path is "mock" or if all are blank, simulate execution
  const isMock = !pathHwInfo && !pathCinebench && !pathFurmark;
  if (isMock || pathHwInfo === 'mock' || pathCinebench === 'mock' || pathFurmark === 'mock') {
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
          cinebenchScore: 14850
        });
      }, 5000);
    });
  }

  // Real Mode
  if (!fs.existsSync(pathHwInfo)) return { success: false, error: `HWiNFO64 path does not exist: ${pathHwInfo}` };
  if (!fs.existsSync(pathCinebench)) return { success: false, error: `Cinebench R23 path does not exist: ${pathCinebench}` };
  if (!fs.existsSync(pathFurmark)) return { success: false, error: `FurMark path does not exist: ${pathFurmark}` };

  const tempDir = 'C:\\temp';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const csvPath = path.join(tempDir, 'neoqc_sensors.csv');
  if (fs.existsSync(csvPath)) {
    try { fs.unlinkSync(csvPath); } catch(e) {}
  }

  return new Promise((resolve) => {
    let cinebenchDone = false;
    let furmarkDone = false;
    let cinebenchScore = 0;

    // 1. Launch HWiNFO64 minimized logging
    const hwinfoCmd = `"${pathHwInfo}" -log="${csvPath}" -minimize`;
    exec(hwinfoCmd, (err) => {
      if (err) console.error("HWiNFO64 launch/run error:", err);
    });

    // 2. Launch Cinebench (Multi-Core test, 2-minute minimum run time)
    const cbCmd = `"${pathCinebench}" g_CinebenchCpuXTest=true g_CinebenchMinimumRunTime=120`;
    exec(cbCmd, (err, stdout) => {
      cinebenchDone = true;
      if (stdout) {
        const multiCoreRegex = /(?:Multi\s*Core|Multi-Core|MC)[^\d]*:\s*([\d,]+)/i;
        const scoreRegex = /(?:Score|Points|Result)\s*:\s*([\d,]+)/i;
        const match = stdout.match(multiCoreRegex) || stdout.match(scoreRegex) || stdout.match(/(\d+)\s*(?:pts|points)/i);
        if (match) {
          cinebenchScore = parseInt(match[1].replace(/,/g, ''));
        }
      }
      checkCompletion();
    });

    // 3. Launch FurMark (120 seconds duration benchmark in 720p windowed mode, no GUI)
    const fmCmd = `"${pathFurmark}" /width=1280 /height=720 /run_time=120000 /nogui`;
    exec(fmCmd, (err) => {
      if (err) console.error("FurMark error:", err);
      furmarkDone = true;
      checkCompletion();
    });

    function checkCompletion() {
      if (cinebenchDone && furmarkDone) {
        // Kill HWiNFO64 to close and flush the CSV file
        exec('taskkill /F /IM HWiNFO64.exe', () => {
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
              cinebenchScore
            });
          }, 1500);
        });
      }
    }
  });
});
