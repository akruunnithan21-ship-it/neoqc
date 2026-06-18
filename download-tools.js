const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Use Electron's bundled extract-zip package
const extract = require('extract-zip');

const DIAGNOSTICS_DIR = path.join(__dirname, 'assets', 'diagnostics');

const TOOLS = [
  {
    name: 'LibreHardwareMonitor',
    url: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip',
    destFolder: 'LibreHardwareMonitor'
  },
  {
    name: 'FurMark',
    url: 'https://geeks3d.com/dl/get/830', // Direct 64bit zip mirror from Geeks3D (Scoop source)
    destFolder: 'FurMark'
  },
  {
    name: 'CinebenchR23',
    url: 'https://installer.maxon.net/cinebench/CinebenchR23.zip',
    destFolder: 'Cinebench'
  }
];

// Ensure directory exists
if (!fs.existsSync(DIAGNOSTICS_DIR)) {
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url} ...`);
    const protocol = url.startsWith('https') ? https : http;
    
    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`Redirecting to: ${response.headers.location}`);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Finished downloading to: ${destPath}`);
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}

async function extractZip(zipPath, outDir) {
  console.log(`Extracting: ${zipPath} to ${outDir} ...`);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  try {
    await extract(zipPath, { dir: outDir });
    console.log(`Finished extracting to: ${outDir}`);
  } catch (err) {
    console.error(`Extraction failed: ${err.message}`);
    throw err;
  }
}

async function start() {
  for (const tool of TOOLS) {
    const zipPath = path.join(DIAGNOSTICS_DIR, `${tool.name}.zip`);
    const outDir = path.join(DIAGNOSTICS_DIR, tool.destFolder);
    
    // Check if tool already exists
    const checkFile = tool.name === 'CinebenchR23' 
      ? path.join(outDir, 'Cinebench.exe')
      : (tool.name === 'FurMark' ? path.join(outDir, 'FurMark.exe') : path.join(outDir, 'LibreHardwareMonitorLib.dll'));
      
    if (fs.existsSync(checkFile)) {
      console.log(`${tool.name} already exists. Skipping download.`);
      continue;
    }

    try {
      await downloadFile(tool.url, zipPath);
      await extractZip(zipPath, outDir);
      
      // Clean up zip file
      fs.unlinkSync(zipPath);
      console.log(`Cleaned up zip: ${zipPath}`);
    } catch (err) {
      console.error(`Error processing ${tool.name}: ${err.message}`);
      // Try cleaning up
      if (fs.existsSync(zipPath)) {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      }
    }
  }
  console.log('All diagnostics downloads and extractions completed!');
}

start().catch(console.error);
