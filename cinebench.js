/*
  cinebench.js — how Neo OS launches Cinebench R23 and reads its score.
  Used by main.js (sys:run-diagnostics) through run(). Node only, no Electron,
  so all of it is tested in tests/cinebench.test.js (run() with a fake Cinebench).

  Why this file exists (1.12.5). The score was blank on every run: main.js ran
      spawn('cmd.exe', ['/c', '"…\\Cinebench.exe" g_CinebenchCpuXTest=true > "…\\cb.log"'])
  and Node escapes the inner quotes for the C runtime (\"…\"), which cmd.exe does
  not understand. cmd answered "The filename, directory name, or volume label
  syntax is incorrect.", so Cinebench never started, cb.log was never written and
  the run logged "no parseable score". That stderr was never captured, so nobody
  saw why. (Reproduced on Node 24 and on the Electron 42 runtime.)

  The fix needs no shell. Cinebench.exe is started directly and writes its own
  console log with g_logFile=<path>. R23's own help (`Cinebench.exe help=all`)
  documents these parameters:
    g_cinebenchCpu1Test=true          single-core test
    g_cinebenchCpuXTest=true          multi-core test
    g_logFile=<path>                  "log all output to a file"
    g_consoleWaitOnEnd=false          don't wait in a console at exit
    g_cinebenchMinimumTestDuration=N  minimum seconds per test; 0 (the default)
                                      means R23's own 10-minute minimum, which
                                      is the standard R23 run. We leave it alone.
  Verified on R23.200 (build RBBenchmark330542). The log ends with the result
  line, e.g. "CB 4748.92 (0.00)". R23 does NOT reliably quit after that line
  (it printed the score at 682 s and was still open 3.7 min later in testing),
  so run() watches the log with resultSoFar() and closes Cinebench itself once
  the result is in. Once in four real launches it also stalled after graphics
  init and never started rendering, so a start-up that has not reached
  "Rendering" in startupSec is closed and launched once more.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Command-line arguments for one Cinebench R23 CPU run. */
function buildArgs(opts) {
  const o = opts || {};
  if (!o.logPath) throw new Error('buildArgs: logPath is required');
  return [
    o.singleCore ? 'g_cinebenchCpu1Test=true' : 'g_cinebenchCpuXTest=true',
    // One argument. Node puts quotes around it when the path has a space,
    // and Cinebench accepts quotes around the whole assignment.
    'g_logFile=' + o.logPath,
    'g_consoleWaitOnEnd=false',
  ];
}

/**
 * Turn the raw log bytes into text. Cinebench writes UTF-8. A UTF-16 file
 * (if a future build or a hand-saved log uses it) is decoded too, so a
 * different encoding can never show up as "no score".
 */
function decodeLog(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf.replace(/\u0000/g, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  // UTF-16LE without a BOM: every other byte of plain ASCII text is 0.
  const sample = buf.subarray(start, Math.min(buf.length, start + 400));
  let zeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
  if (sample.length >= 8 && zeros > sample.length / 4) return buf.subarray(start).toString('utf16le');
  return buf.subarray(start).toString('utf8').replace(/\u0000/g, '');
}

// "CB 4748.92 (0.00)" — the result line R23 prints when a test finishes.
// Anchored to the start of a line so a path or module name can never match.
const RESULT_LINE = /^[ \t]*CB[ \t]+(\d{1,7}(?:[.,]\d+)?)\b/;

/**
 * Read the score out of a Cinebench log.
 * Returns { score, line, reason, tail }:
 *   score  – whole points (what R23's own window shows), or null
 *   line   – the result line it came from
 *   reason – why there is no score (null when there is one)
 *   tail   – the last few meaningful lines, for the diagnostics console
 */
function parseLog(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  const meaningful = lines.map(l => l.trim()).filter(l => l && !/^Loading file:/i.test(l));
  const tail = meaningful.slice(-6);

  let found = null;
  for (const l of lines) {
    const m = RESULT_LINE.exec(l);
    if (m) found = { raw: m[1], line: l.trim() };   // keep the LAST result line
  }
  if (found) {
    const value = parseFloat(found.raw.replace(',', '.'));
    if (isFinite(value) && value > 0) {
      return { score: Math.floor(value), line: found.line, reason: null, tail };
    }
  }

  let reason;
  if (!meaningful.length) {
    reason = 'Cinebench wrote nothing to its log (it did not start, or was closed while loading).';
  } else if (!lines.some(l => /CINEBENCH started/i.test(l))) {
    reason = 'Cinebench did not finish starting up.';
  } else if (lines.some(l => /Rendering/i.test(l))) {
    reason = 'Cinebench started the render but stopped before printing a result (closed, killed, or out of time).';
  } else {
    reason = 'Cinebench started but never ran the CPU test.';
  }
  return { score: null, line: null, reason, tail };
}

/**
 * The score in a log Cinebench is still writing, or null. Only lines that
 * already end in a newline count, so a half-written "CB 12" is never read
 * as a score of 12.
 */
function resultSoFar(text) {
  const s = String(text || '');
  const end = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'));
  if (end < 0) return null;
  return parseLog(s.slice(0, end + 1)).score;
}

/**
 * Run one Cinebench test and read its score. Never rejects, never fabricates.
 *
 * opts:
 *   exe          Cinebench.exe (required)
 *   logPath      where Cinebench writes its log (required); deleted before every
 *                launch so an old log can never be read as this run's score
 *   singleCore   single-core test instead of multi-core
 *   ceilingSec   hang guard per launch (default 1800; R23's own pass is ~10-11 min)
 *   startupSec   if the log has not reached "Rendering" by then, R23 is stuck
 *                starting up (seen once in four real launches on 2026-11-14: it
 *                sat idle after graphics init). It is closed and launched again.
 *                Default 240; R23 normally starts rendering within ~1 min.
 *   retries      how many relaunches a stuck start-up gets (default 1)
 *   graceSec     after the result line, how long Cinebench gets to close
 *                itself before it is closed (default 15)
 *   pollMs       how often the log is checked (default 2000)
 *   onLog(msg)   progress lines for the diagnostics console
 *   logger       { info, warn } for the app log (optional)
 *   args         override the arguments (tests only)
 *   windowsHide  default false: the technician sees Cinebench render
 *
 * Resolves { score, line, reason, tail, how, secs, logPath, attempts }.
 */
function run(opts) {
  const o = opts || {};
  const say = typeof o.onLog === 'function' ? o.onLog : () => {};
  const logger = o.logger || { info() {}, warn() {} };
  const ceilingSec = o.ceilingSec || 1800;
  const startupSec = o.startupSec || 240;
  const retries = o.retries != null ? o.retries : 1;
  const graceSec = o.graceSec != null ? o.graceSec : 15;
  const pollMs = o.pollMs || 2000;
  const t0 = Date.now();
  let logPath = o.logPath;

  return new Promise((resolve) => {
    let settled = false;
    let proc = null;
    let attempt = 0;
    let st = {};          // this launch: ceilingHit, stalled, restarting, rendering, resultSeen
    let ceilingTimer = null, startupTimer = null, graceTimer = null, watchTimer = null, lastResortTimer = null;

    const secsNow = () => Math.round((Date.now() - t0) / 1000);
    const stopTimers = () => {
      clearTimeout(ceilingTimer); clearTimeout(startupTimer); clearTimeout(graceTimer);
      clearTimeout(lastResortTimer); clearInterval(watchTimer);
    };
    const readLog = () => {
      try { return decodeLog(fs.readFileSync(logPath)); }
      catch (e) { if (e.code !== 'ENOENT') logger.warn('Cinebench log read failed:', e.message); return ''; }
    };
    const kill = () => {
      try { proc && proc.kill(); } catch (e) {}
      if (proc && proc.pid && process.platform === 'win32') {
        try { spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch (e) {}
      }
    };
    const done = (how, startError) => {
      if (settled) return;
      settled = true;
      stopTimers();
      const parsed = startError
        ? { score: null, line: null, reason: 'Cinebench failed to start: ' + startError, tail: [] }
        : parseLog(readLog());
      const result = Object.assign({}, parsed, { how, secs: secsNow(), logPath, attempts: attempt });
      // NO fabricated fallback (v1.8.1 rule). No result line = NOT MEASURED.
      if (result.score != null) {
        say(`Cinebench result: "${result.line}" after ${result.secs}s.`);
      } else {
        say(`[WARN] Cinebench gave no score (${how}, after ${result.secs}s): ${result.reason} Reporting NOT MEASURED.`);
        if (result.tail.length) say(`Cinebench log, last lines: ${result.tail.join(' | ').slice(0, 600)}`);
        say(`Full Cinebench log: ${logPath}`);
        logger.warn(`Cinebench gave no score (${how}): ${result.reason} Log: ${logPath}`);
      }
      resolve(result);
    };

    if (!o.exe || !logPath) { done('not started', 'exe and logPath are required'); return; }
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (e) {}

    const launch = () => {
      attempt++;
      st = { ceilingHit: false, stalled: false, restarting: false, rendering: false, resultSeen: false };
      try { fs.rmSync(logPath, { force: true }); }
      catch (e) {
        // Locked by a Cinebench left over from an earlier run: use a fresh name.
        logPath = o.logPath.replace(/(\.log)?$/i, `-${Date.now()}.log`);
      }
      const args = o.args || buildArgs({ singleCore: o.singleCore, logPath });

      ceilingTimer = setTimeout(() => {
        st.ceilingHit = true;
        say(`Cinebench exceeded its ${ceilingSec}s ceiling — terminating.`);
        kill();
        // A process that will not die must not hold up the whole diagnostics run.
        lastResortTimer = setTimeout(() => done('ceiling reached'), 5000);
      }, ceilingSec * 1000);

      startupTimer = setTimeout(() => {
        // Look at the log now, not at the watcher's last poll.
        if (!st.rendering && /^[ \t]*Rendering/m.test(readLog())) st.rendering = true;
        if (settled || st.rendering || st.resultSeen) return;
        if (attempt <= retries) {
          st.restarting = true;
          say(`Cinebench has not started rendering after ${startupSec}s, so it looks stuck. Closing it and starting it again (attempt ${attempt + 1} of ${retries + 1}).`);
          kill();
          lastResortTimer = setTimeout(() => done('stuck starting up'), 10000);
        } else {
          st.stalled = true;
          say(`Cinebench has not started rendering after ${startupSec}s again. Giving up on it for this run.`);
          kill();
          lastResortTimer = setTimeout(() => done('stuck starting up'), 5000);
        }
      }, startupSec * 1000);

      let me;
      try {
        me = proc = spawn(o.exe, args, {
          cwd: path.dirname(o.exe),
          windowsHide: !!o.windowsHide,
          stdio: 'ignore',
        });
      } catch (e) {
        done('not started', e.message);
        return;
      }
      logger.info(`Cinebench launched (attempt ${attempt}):`, o.exe, args.join(' '));

      me.on('error', (e) => { if (me === proc) done('not started', e.message); });
      me.on('exit', (code, signal) => {
        if (settled || me !== proc) return;
        stopTimers();
        if (st.restarting) { launch(); return; }
        const how = st.stalled ? 'stuck starting up'
          : st.ceilingHit ? 'ceiling reached'
          : st.resultSeen ? 'closed after its result'
          : `exit code ${code != null ? code : signal}`;
        say(st.resultSeen
          ? 'Cinebench closed after printing its result. Reading the score from its log...'
          : `Cinebench closed (${how}). Reading the score from its log...`);
        done(how);
      });

      watchTimer = setInterval(() => {
        if (settled || st.resultSeen) return;
        const text = readLog();
        if (!st.rendering && /^[ \t]*Rendering/m.test(text)) st.rendering = true;
        if (resultSoFar(text) == null) return;
        st.resultSeen = true;
        clearInterval(watchTimer);
        say(`Cinebench printed its result. Closing it in ${graceSec}s if it stays open.`);
        graceTimer = setTimeout(() => { if (!settled) kill(); }, graceSec * 1000);
      }, pollMs);
    };

    launch();
  });
}

const api = { buildArgs, decodeLog, parseLog, resultSoFar, run };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
