/*
  Neo Service 1.16: the bench side of QC after a service (server v2.13,
  docs/redesign-2026-11/QC-SERVICE.md). Main process only.

  The service desk sends a repaired PC to QC with the customer's goals
  ("Valorant at 450 fps", "Premiere exports without crashing"). On the bench the
  app runs ON THAT PC and checks, read-only:

    sys:qc-disks        every drive's Windows health, wear, temperature, errors
    sys:qc-idle-temps   CPU / GPU temperature at idle (LibreHardwareMonitor, 20 s)
    sys:qc-whea         hardware errors Windows logged (WHEA) since a time
    sys:qc-processes    the windowed apps running now, to pick the game or app
    sys:qc-fps-capture  PresentMon: average FPS and 1% low of one game
    sys:qc-app-crashes  Windows Error Reporting crashes / hangs of one app

  The stability run is sys:run-diagnostics with { serviceQc: true } (main.js).

  Nothing here writes to the customer's drives: no benchmark files, no SMART
  self-tests. Values passed to PowerShell go through environment variables,
  never into the command text.
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE_RE = /^[\w .()+&'-]{1,100}\.exe$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Run a PowerShell snippet that prints one JSON value. Resolves { ok, data } or
// { ok: false, error }.
function psJson(script, { env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let out = '', err = '';
    let ps;
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, env: Object.assign({}, process.env, env || {}) });
    } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) { /* gone */ } done({ ok: false, error: 'timeout' }); }, timeoutMs);
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.stderr.on('data', d => { err += d.toString(); });
    ps.on('error', e => done({ ok: false, error: e.message }));
    ps.on('close', () => {
      const s = out.trim();
      if (!s) { done({ ok: true, data: null, stderr: err.slice(-400) }); return; }
      try { done({ ok: true, data: JSON.parse(s) }); }
      catch (e) { done({ ok: false, error: 'parse_failed', raw: s.slice(-400), stderr: err.slice(-400) }); }
    });
  });
}
const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ── drives ──────────────────────────────────────────────────────────────────
const DISKS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-PhysicalDisk | Sort-Object DeviceId | ForEach-Object {
  $rc = $null; try { $rc = $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
  [PSCustomObject]@{
    model = $_.FriendlyName; mediaType = [string]$_.MediaType; busType = [string]$_.BusType
    health = [string]$_.HealthStatus; status = (@($_.OperationalStatus) -join ', ')
    sizeGB = [math]::Round($_.Size / 1GB, 0)
    wear = if ($rc -and $rc.Wear -ne $null) { [int]$rc.Wear } else { $null }
    tempC = if ($rc -and $rc.Temperature) { [int]$rc.Temperature } else { $null }
    readErrors = if ($rc -and $rc.ReadErrorsTotal -ne $null) { [int]$rc.ReadErrorsTotal } else { $null }
    writeErrors = if ($rc -and $rc.WriteErrorsTotal -ne $null) { [int]$rc.WriteErrorsTotal } else { $null }
    powerOnHours = if ($rc -and $rc.PowerOnHours) { [int]$rc.PowerOnHours } else { $null }
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

// A drive is a problem when Windows says so, it is worn out, or it has
// uncorrected read/write errors. Temperature over 70 °C at idle is a warning.
function judgeDisk(d) {
  const notes = [];
  let level = 'ok';
  const bump = (l) => { if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
  if (d.health && !/^healthy$/i.test(d.health)) { notes.push('Windows reports ' + d.health); bump(/warning/i.test(d.health) ? 'warn' : 'bad'); }
  if (d.wear != null && d.wear >= 90) { notes.push(d.wear + '% worn'); bump('bad'); }
  else if (d.wear != null && d.wear >= 70) { notes.push(d.wear + '% worn'); bump('warn'); }
  if ((d.readErrors || 0) + (d.writeErrors || 0) > 0) { notes.push(((d.readErrors || 0) + (d.writeErrors || 0)) + ' read/write errors'); bump('warn'); }
  if (d.tempC != null && d.tempC >= 70) { notes.push(d.tempC + ' °C'); bump('warn'); }
  return { level, notes };
}

async function disks() {
  const r = await psJson(DISKS_PS, { timeoutMs: 30000 });
  if (!r.ok) return { ok: false, error: r.error };
  const list = asList(r.data).map(d => Object.assign({}, d, judgeDisk(d)));
  return { ok: true, disks: list };
}

// ── idle temperatures ───────────────────────────────────────────────────────
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function idleTemps({ monitorScript, dllPath, seconds = 20 }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(monitorScript) || !fs.existsSync(dllPath)) {
      resolve({ ok: false, error: 'The sensor tools are missing (LibreHardwareMonitor).' });
      return;
    }
    const cpu = [], gpu = [];
    let source = null;
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch (e) { /* gone */ }
      // Same rule as the build test: an ACPI board thermal zone is not a CPU sensor.
      const cpuOk = source !== 'thermal-zone-perf-counter';
      const c = cpuOk ? median(cpu) : null;
      const g = median(gpu);
      resolve({ ok: true, cpuC: c == null ? null : Math.round(c), gpuC: g == null ? null : Math.round(g),
        samples: Math.max(cpu.length, gpu.length), cpuSource: cpuOk ? source : null });
    };
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', monitorScript,
      '-dllPath', dllPath, '-durationSec', String(seconds)], { windowsHide: true });
    const timer = setTimeout(finish, (seconds + 25) * 1000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const p = JSON.parse(t);
          if (p.cpuTemp != null && isFinite(+p.cpuTemp)) cpu.push(+p.cpuTemp);
          if (p.gpuTemp != null && isFinite(+p.gpuTemp)) gpu.push(+p.gpuTemp);
          if (p.tempSource && p.cpuTemp != null) source = p.tempSource;
        } catch (e) { /* partial line */ }
      }
    });
    proc.on('error', () => finish());
    proc.on('close', () => finish());
  });
}

// ── WHEA hardware errors ───────────────────────────────────────────────────
const WHEA_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$since = [datetime]::Parse($env:NEO_SINCE, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal).ToLocalTime()
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = $since } -ErrorAction SilentlyContinue)
$rows = @($ev | Select-Object -First 8 | ForEach-Object {
  [PSCustomObject]@{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; level = $_.Level
    text = (($_.Message -split "\`n")[0]).Trim() }
})
ConvertTo-Json -Compress -Depth 3 -InputObject ([PSCustomObject]@{
  total = $ev.Count
  errors = @($ev | Where-Object { $_.Level -le 2 }).Count
  warnings = @($ev | Where-Object { $_.Level -eq 3 }).Count
  latest = $rows
})
`;

async function whea(sinceIso) {
  if (!ISO_RE.test(String(sinceIso || ''))) return { ok: false, error: 'bad time' };
  const r = await psJson(WHEA_PS, { env: { NEO_SINCE: sinceIso }, timeoutMs: 30000 });
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return { ok: true, since: sinceIso, total: d.total || 0, errors: d.errors || 0, warnings: d.warnings || 0, latest: asList(d.latest) };
}

// ── running apps ───────────────────────────────────────────────────────────
const PROCS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 40 | ForEach-Object {
    [PSCustomObject]@{ exe = $_.ProcessName + '.exe'; pid = $_.Id; title = $_.MainWindowTitle; mb = [math]::Round($_.WorkingSet64 / 1MB, 0) }
  })
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;
const SKIP_PROCS = /^(explorer|neo service|electron|applicationframehost|systemsettings|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|taskmgr|powershell|windowsterminal|cmd|conhost)\.exe$/i;

async function processes() {
  const r = await psJson(PROCS_PS, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, error: r.error };
  const seen = new Set();
  const list = asList(r.data).filter(p => p && p.exe && !SKIP_PROCS.test(p.exe) && !seen.has(p.exe.toLowerCase()) && seen.add(p.exe.toLowerCase()));
  return { ok: true, processes: list };
}

// ── PresentMon ─────────────────────────────────────────────────────────────
// PresentMon 2.x writes FrameTime (ms between this app's presents) and
// DisplayedTime; 1.x metrics (--v1_metrics) write msBetweenPresents /
// msBetweenDisplayChange. Read either. When the game has several swap chains
// (launcher, overlay) keep the one with the most frames.
function splitCsv(line) { return line.split(',').map(s => s.trim()); }

function parsePresentMonCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { frames: 0 };
  const head = splitCsv(lines[0]).map(h => h.toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n.toLowerCase()); if (i !== -1) return i; } return -1; };
  const iApp = col('Application');
  const iPid = col('ProcessID');
  const iSwap = col('SwapChainAddress');
  const iFrame = col('FrameTime', 'msBetweenPresents', 'MsBetweenPresents');
  const iShown = col('DisplayedTime', 'msBetweenDisplayChange', 'MsBetweenDisplayChange');
  if (iFrame === -1) return { frames: 0, error: 'no frame-time column' };
  const groups = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsv(lines[i]);
    const ft = parseFloat(c[iFrame]);
    if (!isFinite(ft) || ft <= 0 || ft > 5000) continue;
    const key = (iPid !== -1 ? c[iPid] : '') + '|' + (iSwap !== -1 ? c[iSwap] : '');
    let g = groups.get(key);
    if (!g) { g = { app: iApp !== -1 ? c[iApp] : '', pid: iPid !== -1 ? Number(c[iPid]) : null, ft: [], shown: [] }; groups.set(key, g); }
    g.ft.push(ft);
    if (iShown !== -1) { const s = parseFloat(c[iShown]); if (isFinite(s) && s > 0 && s < 5000) g.shown.push(s); }
  }
  let best = null;
  for (const g of groups.values()) if (!best || g.ft.length > best.ft.length) best = g;
  if (!best || best.ft.length < 30) return { frames: best ? best.ft.length : 0 };
  const sumMs = best.ft.reduce((a, b) => a + b, 0);
  const slow = best.ft.slice().sort((a, b) => b - a);
  const n1 = Math.max(1, Math.floor(slow.length * 0.01));
  const slowAvg = slow.slice(0, n1).reduce((a, b) => a + b, 0) / n1;
  const shownSum = best.shown.reduce((a, b) => a + b, 0);
  const r1 = v => Math.round(v * 10) / 10;
  return {
    frames: best.ft.length,
    seconds: r1(sumMs / 1000),
    app: best.app || null,
    pid: best.pid,
    avgFps: r1(best.ft.length / (sumMs / 1000)),
    // 1% low: the average of the slowest 1% of frames, as FPS.
    low1Fps: r1(1000 / slowAvg),
    displayedFps: best.shown.length >= 30 && shownSum > 0 ? r1(best.shown.length / (shownSum / 1000)) : null
  };
}

function captureFps({ exe, processName, seconds = 60, delaySec = 10 }) {
  return new Promise((resolve) => {
    if (!exe || !fs.existsSync(exe)) { resolve({ ok: false, error: 'PresentMon is missing from this install.' }); return; }
    const name = String(processName || '').trim();
    if (!EXE_RE.test(name)) { resolve({ ok: false, error: 'Pick the game from the list, or type its .exe name.' }); return; }
    const sec = Math.max(10, Math.min(300, Math.round(Number(seconds) || 60)));
    const delay = Math.max(0, Math.min(60, Math.round(Number(delaySec) || 0)));
    const csv = path.join(os.tmpdir(), 'neo-qc-fps-' + Date.now() + '.csv');
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(csv); } catch (e) { /* none written */ }
      resolve(r);
    };
    let err = '';
    const pm = spawn(exe, ['--process_name', name, '--delay', String(delay), '--timed', String(sec), '--terminate_after_timed',
      '--output_file', csv, '--no_console_stats', '--session_name', 'NeoServiceQc', '--stop_existing_session'],
    { windowsHide: true });
    const timer = setTimeout(() => { try { pm.kill(); } catch (e) { /* gone */ } }, (delay + sec + 30) * 1000);
    pm.stderr.on('data', d => { err += d.toString(); });
    pm.stdout.on('data', d => { err += d.toString(); });
    pm.on('error', e => done({ ok: false, error: e.message }));
    pm.on('close', (code) => {
      let text = '';
      try { text = fs.readFileSync(csv, 'utf8'); } catch (e) { /* no file */ }
      const r = parsePresentMonCsv(text);
      if (!r.frames || r.frames < 30) {
        const denied = /access denied|elevated/i.test(err);
        done({ ok: false, error: denied
          ? 'PresentMon needs the app to run as administrator.'
          : 'No frames from ' + name + '. Is the game running, in a match or the range, and in front?', code });
        return;
      }
      done(Object.assign({ ok: true, processName: name, requestedSec: sec, tool: 'PresentMon 2.6.0' }, r));
    });
  });
}

// ── app crashes ────────────────────────────────────────────────────────────
// Application Error (1000) and Application Hang (1002), plus WER reports
// (1001) for the app. Matched on the exe name; empty name = any app.
const CRASH_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$since = [datetime]::Parse($env:NEO_SINCE, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal).ToLocalTime()
$exe = $env:NEO_EXE
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001, 1002; StartTime = $since } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in @('Application Error', 'Application Hang', 'Windows Error Reporting') })
if ($exe) { $ev = @($ev | Where-Object { $_.Message -like ('*' + $exe + '*') }) }
$ev = @($ev | Where-Object { $_.Id -ne 1001 -or $_.Message -match 'APPCRASH|AppHang|BEX' })
# One crash usually logs both 1000 (or 1002) and a WER 1001: count the first kind,
# and fall back to the WER reports only when Windows wrote nothing else.
$main = @($ev | Where-Object { $_.Id -ne 1001 })
$count = if ($main.Count) { $main.Count } else { $ev.Count }
$rows = @($ev | Select-Object -First 8 | ForEach-Object {
  $t = (($_.Message -split "\`n")[0]).Trim()
  if ($_.Id -eq 1001) {
    $n = ''; $a = ''
    if ($_.Message -match 'Event Name:\\s*(\\S+)') { $n = $matches[1] }
    if ($_.Message -match 'P1:\\s*(\\S+)') { $a = $matches[1] }
    $t = ('Windows Error Reporting: ' + $n + ' ' + $a).Trim()
  }
  [PSCustomObject]@{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; source = $_.ProviderName; text = $t }
})
ConvertTo-Json -Compress -Depth 3 -InputObject ([PSCustomObject]@{ total = $count; latest = $rows })
`;

async function appCrashes({ sinceIso, exeName }) {
  if (!ISO_RE.test(String(sinceIso || ''))) return { ok: false, error: 'bad time' };
  const exe = EXE_RE.test(String(exeName || '')) ? String(exeName) : '';
  const r = await psJson(CRASH_PS, { env: { NEO_SINCE: sinceIso, NEO_EXE: exe }, timeoutMs: 30000 });
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return { ok: true, since: sinceIso, exe: exe || null, total: d.total || 0, latest: asList(d.latest) };
}

function register(ipcMain, { diagnosticsPath, logger } = {}) {
  const log = logger || console;
  const dir = typeof diagnosticsPath === 'function' ? diagnosticsPath : () => diagnosticsPath;
  const wrap = (name, fn) => ipcMain.handle(name, async (event, arg) => {
    try { return await fn(arg || {}); }
    catch (e) { log.warn && log.warn(name + ' failed:', e && e.message); return { ok: false, error: (e && e.message) || String(e) }; }
  });
  wrap('sys:qc-disks', () => disks());
  wrap('sys:qc-idle-temps', (a) => idleTemps({
    monitorScript: path.join(dir(), 'monitor.ps1'),
    dllPath: path.join(dir(), 'LibreHardwareMonitor', 'LibreHardwareMonitorLib.dll'),
    seconds: Math.max(5, Math.min(60, Number(a.seconds) || 20))
  }));
  wrap('sys:qc-whea', (a) => whea(a.since));
  wrap('sys:qc-processes', () => processes());
  wrap('sys:qc-fps-capture', (a) => captureFps({
    exe: path.join(dir(), 'PresentMon', 'PresentMon-2.6.0-x64.exe'),
    processName: a.processName, seconds: a.seconds, delaySec: a.delaySec
  }));
  wrap('sys:qc-app-crashes', (a) => appCrashes({ sinceIso: a.since, exeName: a.exe }));
}

module.exports = { register, parsePresentMonCsv, judgeDisk, median, disks, whea, processes, appCrashes };
