const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

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
  },
  {
    // Prime95 / mprime — GIMPS project, freeware, redistributable per the
    // license.txt bundled in the zip. Used for the CPU+RAM Blend torture test.
    name: 'Prime95',
    url: 'https://download.mersenne.ca/gimps/v30/30.19/p95v3019b20.win64.zip',
    destFolder: 'Prime95'
  },
  {
    // Microsoft DiskSpd — MIT-licensed, ~1 MB, the same I/O engine
    // CrystalDiskMark builds on. Replaces the old in-JS 25 MB
    // fs.writeFileSync/readFileSync "SSD test" that only measured Windows'
    // write-back cache. Now bench numbers actually reflect the drive.
    // We report the results on the QC certificate as
    // "CrystalDiskMark-comparable methodology (Microsoft DiskSpd)".
    name: 'DiskSpd',
    url: 'https://github.com/microsoft/diskspd/releases/download/v2.2/DiskSpd.zip',
    destFolder: 'DiskSpd'
  }
];

// --- Supply-chain integrity -------------------------------------------------
// These archives are extracted and BUNDLED into an Administrator-privileged app,
// so a compromised mirror = admin-level code on every shop PC. Pin the SHA-256 of
// each archive here after downloading it once from a trusted network and checking
// it (PowerShell: Get-FileHash -Algorithm SHA256 <file>). With a hash set, a
// mismatch ABORTS; left null, the download proceeds but is flagged UNVERIFIED so
// the gap stays visible. FurMark's 'get latest' mirror in particular should be
// swapped for a pinned versioned URL before you pin its hash.
const EXPECTED_SHA256 = {
  LibreHardwareMonitor: null,
  FurMark: null,
  CinebenchR23: null,
  Prime95: null,
  DiskSpd: null
};

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Ensure directory exists
if (!fs.existsSync(DIAGNOSTICS_DIR)) {
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
}

function downloadFile(url, destPath, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    // HTTPS-only: these binaries get bundled into an Administrator-privileged app,
    // so we never fetch (or follow a redirect) over plaintext http, which could be
    // MITM'd to swap the payload.
    if (!/^https:\/\//i.test(url)) { reject(new Error(`Refusing non-https download URL: ${url}`)); return; }
    if (depth > 5) { reject(new Error('Too many redirects')); return; }
    console.log(`Downloading: ${url} ...`);

    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    }, (response) => {
      // Handle redirects — but only to another https URL (never downgrade to http).
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const next = new URL(response.headers.location, url).toString();
        if (!/^https:\/\//i.test(next)) { reject(new Error(`Refusing http redirect: ${next}`)); return; }
        console.log(`Redirecting to: ${next}`);
        return downloadFile(next, destPath, depth + 1).then(resolve).catch(reject);
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
    let checkFile = '';
    if (tool.name === 'CinebenchR23') {
      checkFile = path.join(outDir, 'Cinebench.exe');
    } else if (tool.name === 'FurMark') {
      checkFile = path.join(outDir, 'FurMark_win64', 'furmark.exe');
    } else if (tool.name === 'Prime95') {
      checkFile = path.join(outDir, 'prime95.exe');
    } else if (tool.name === 'DiskSpd') {
      // DiskSpd.zip extracts to amd64/diskspd.exe (also x86/, ARM64/).
      // main.js's runDriveBenchmark() checks both amd64/ and root for the exe.
      checkFile = path.join(outDir, 'amd64', 'diskspd.exe');
    } else {
      checkFile = path.join(outDir, 'LibreHardwareMonitorLib.dll');
    }
      
    if (fs.existsSync(checkFile)) {
      console.log(`${tool.name} already exists. Skipping download.`);
      continue;
    }

    try {
      await downloadFile(tool.url, zipPath);

      // Verify archive integrity before extracting/bundling it.
      const actual = sha256(zipPath);
      const expected = EXPECTED_SHA256[tool.name];
      if (expected) {
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          fs.unlinkSync(zipPath);
          throw new Error(`SHA-256 mismatch for ${tool.name}: expected ${expected}, got ${actual}. Refusing to bundle a possibly-tampered binary.`);
        }
        console.log(`Verified ${tool.name} SHA-256 OK.`);
      } else {
        console.warn(`WARNING  ${tool.name}: UNVERIFIED download (no pinned SHA-256). Computed ${actual} — pin this in EXPECTED_SHA256 after confirming it from a trusted source.`);
      }

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
