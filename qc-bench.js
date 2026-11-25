/*
  Neo Service 1.16: the bench test for QC after a service (server v2.13;
  decisions in docs/redesign-2026-11/QC-SERVICE.md).

  Opened from a card on QC → After service. The app runs ON the customer's
  repaired PC and walks the tech through:

    1. Health check   every drive's health (read-only), idle CPU / GPU
                      temperatures, hardware errors Windows logged (7 days)
    2. Stability      Prime95 + FurMark together for 15 / 30 / 60 minutes,
                      with temperatures and hardware errors during the run
    3. The goals      a game: PresentMon measures average FPS and 1% low
                      against the customer's target; a piece of work: a timer
                      plus Windows' crash log for that app
    4. Finish         passed / not passed and the one line the customer reads
                      → service_qc_finish; then the one-page QC report

  Main-process side: service-qc-bench.js + sys:run-diagnostics { serviceQc }.
  In a browser (the dev harness) there is no bench: a practice adapter fills
  in made-up numbers, says so on screen, and nothing can be saved (demo data
  is read-only).

  window.NeoQcBench = { open(qcId), close(), isOpen(), printReport(qcId) }
*/
(function () {
  'use strict';

  function D() { return window.NeoQcData || null; }
  function U() { return window.NeoQcUI || null; }
  function CAT() { return window.NeoQcCatalog || null; }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    var u = U();
    if (u && typeof u.toast === 'function') u.toast(msg, type || 'info');
    else if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }
  function errText(e) {
    var u = U();
    if (u && typeof u.errText === 'function') return u.errText(e);
    return (e && e.message) || String(e);
  }
  function isDemoErr(e) { return /DEMO_READONLY/.test((e && e.message) || String(e || '')); }
  function inr(n) { var v = Number(n); return isFinite(v) ? '₹' + v.toLocaleString('en-IN') : ''; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function r0(v) { var n = num(v); return n == null ? null : Math.round(n); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtWhen(v) {
    var t = v ? Date.parse(v) : NaN;
    if (isNaN(t)) return '';
    var d = new Date(t);
    var h = d.getHours(), m = d.getMinutes();
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ', ' + ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' am' : ' pm');
  }
  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── the bench: Electron IPC, or the practice adapter ──────────────────────
  function realIpc() {
    try {
      if (typeof require !== 'function') return null;
      var e = require('electron');
      if (e && e.harness) return null; // the dev harness's stub: practice mode
      return (e && e.ipcRenderer && typeof e.ipcRenderer.invoke === 'function') ? e.ipcRenderer : null;
    } catch (x) { return null; }
  }
  var IPC = realIpc();
  var PRACTICE = !IPC;
  var listeners = { sensor: [], log: [] };
  function emitSensor(p) { listeners.sensor.forEach(function (f) { try { f(p); } catch (e) { /* one listener */ } }); }
  function emitLog(t) { listeners.log.forEach(function (f) { try { f(t); } catch (e) { /* one listener */ } }); }
  if (IPC && typeof IPC.on === 'function') {
    IPC.on('sys:sensor-update', function (ev, p) { emitSensor(p || {}); });
    IPC.on('sys:diag-log', function (ev, t) { emitLog(String(t || '')); });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Practice numbers: plausible, marked as practice on screen, never saved.
  var practice = {
    'sys:qc-disks': function () {
      return wait(900).then(function () {
        return { ok: true, disks: [
          { model: 'Samsung SSD 980 1TB', mediaType: 'SSD', busType: 'NVMe', health: 'Healthy', sizeGB: 932, wear: 4, tempC: 39, readErrors: 0, writeErrors: 0, level: 'ok', notes: [] },
          { model: 'Seagate ST2000DM008', mediaType: 'HDD', busType: 'SATA', health: 'Healthy', sizeGB: 1863, wear: null, tempC: 33, readErrors: 0, writeErrors: 0, level: 'ok', notes: [] }
        ] };
      });
    },
    'sys:qc-idle-temps': function () { return wait(1400).then(function () { return { ok: true, cpuC: 41, gpuC: 36, samples: 20 }; }); },
    'sys:qc-whea': function () { return wait(500).then(function () { return { ok: true, total: 0, errors: 0, warnings: 0, latest: [] }; }); },
    'sys:qc-processes': function () {
      return wait(400).then(function () {
        return { ok: true, processes: [
          { exe: 'VALORANT-Win64-Shipping.exe', pid: 8812, title: 'VALORANT', mb: 3120 },
          { exe: 'Adobe Premiere Pro.exe', pid: 5520, title: 'Adobe Premiere Pro 2026', mb: 2410 },
          { exe: 'ForzaHorizon5.exe', pid: 7710, title: 'Forza Horizon 5', mb: 6200 },
          { exe: 'chrome.exe', pid: 4410, title: 'Google Chrome', mb: 610 }
        ] };
      });
    },
    'sys:qc-fps-capture': function (a) {
      var sec = 6;
      return wait(sec * 1000).then(function () {
        var avg = /valorant/i.test(a.processName || '') ? 512.4 : 118.6;
        return { ok: true, processName: a.processName, frames: Math.round(avg * 60), seconds: 60, avgFps: avg, low1Fps: Math.round(avg * 0.58 * 10) / 10, displayedFps: null, tool: 'Practice' };
      });
    },
    'sys:qc-app-crashes': function () { return wait(500).then(function () { return { ok: true, total: 0, latest: [] }; }); },
    'sys:run-diagnostics': function (cfg) {
      // About 12 seconds of made-up sensor readings for the whole run.
      var ticks = 24, i = 0;
      var cpu = [], gpu = [];
      return new Promise(function (resolve) {
        emitLog('Service QC stability test: Prime95 + FurMark together for ' + Math.round(cfg.duration / 60) + ' minutes.');
        var t = setInterval(function () {
          i++;
          var c = Math.round(52 + 26 * Math.min(1, i / 8) + (i % 3)), g = Math.round(48 + 24 * Math.min(1, i / 6) + (i % 2));
          cpu.push(c); gpu.push(g);
          emitSensor({ cpuTemp: c, gpuTemp: g, cpuLoad: 100, gpuLoad: 99 });
          if (i >= ticks) {
            clearInterval(t);
            resolve({ success: true, serviceQc: true, runDurationSec: cfg.duration, durationRequestedSec: cfg.duration,
              cpuTempMax: Math.max.apply(null, cpu), cpuTempAvg: Math.round(cpu.reduce(function (a, b) { return a + b; }, 0) / cpu.length),
              gpuTempMax: Math.max.apply(null, gpu), gpuTempAvg: Math.round(gpu.reduce(function (a, b) { return a + b; }, 0) / gpu.length),
              cpuLoadAvg: 100, gpuLoadAvg: 98, furmarkScore: 9120,
              prime95: { overallResult: 'pass', durationActualSec: cfg.duration, workerCount: 16, errorSummary: [] } });
          }
        }, 500);
      });
    }
  };
  function bench(name, arg) {
    if (IPC) return IPC.invoke(name, arg);
    var f = practice[name];
    return f ? f(arg || {}) : Promise.resolve({ ok: false, error: 'Not available here.' });
  }

  // ── state, one per QC job, kept on this PC so a restart keeps finished steps ─
  var states = {};
  var KEY = 'neo.qcBench.';
  function load(id) {
    if (states[id]) return states[id];
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY + id) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    s.id = id;
    s.goals = Array.isArray(s.goals) ? s.goals : [];
    // A run that was going when the app closed did not finish.
    if (s.stability && s.stability.running) s.stability = null;
    s.goals.forEach(function (g) { if (g && g.running) { g.running = false; g.timerStart = null; } });
    states[id] = s;
    return s;
  }
  function save(s) {
    try {
      var copy = JSON.parse(JSON.stringify(s));
      localStorage.setItem(KEY + s.id, JSON.stringify(copy));
    } catch (e) { /* per-PC nicety; the server copy is what counts */ }
  }
  function forget(id) { try { localStorage.removeItem(KEY + id); } catch (e) { /* fine */ } }

  function qcRow(id) {
    var d = D();
    var all = d && typeof d.qcJobs === 'function' ? d.qcJobs() : [];
    for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
    return null;
  }
  function jobOf(q) {
    var d = D();
    return q && d && typeof d.job === 'function' ? d.job(q.job_id) : null;
  }

  // ── verdicts ──────────────────────────────────────────────────────────────
  var LIMITS = { idleCpu: 60, idleGpu: 60, cpuWarn: 95, cpuBad: 100, gpuWarn: 95, gpuBad: 105 };
  function healthVerdict(h) {
    if (!h) return null;
    var level = 'ok', notes = [];
    var bump = function (l, n) { notes.push(n); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
    (h.disks || []).forEach(function (d) {
      if (d.level === 'bad') bump('bad', d.model + ': ' + (d.notes || []).join(', '));
      else if (d.level === 'warn') bump('warn', d.model + ': ' + (d.notes || []).join(', '));
    });
    if (h.disksError) bump('warn', 'Could not read the drives');
    if (h.idle && h.idle.cpuC != null && h.idle.cpuC >= LIMITS.idleCpu) bump('warn', 'CPU ' + h.idle.cpuC + ' °C at idle');
    if (h.idle && h.idle.gpuC != null && h.idle.gpuC >= LIMITS.idleGpu) bump('warn', 'GPU ' + h.idle.gpuC + ' °C at idle');
    if (h.whea && h.whea.errors > 0) bump('warn', h.whea.errors + ' hardware error' + (h.whea.errors === 1 ? '' : 's') + ' in the last 7 days');
    return { level: level, notes: notes };
  }
  function stabilityVerdict(s) {
    if (!s || s.running || !s.done) return null;
    var level = 'ok', notes = [];
    var bump = function (l, n) { notes.push(n); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
    var p = s.prime95 || {};
    if (p.overallResult === 'fail') bump('bad', 'Prime95 found errors');
    else if (p.overallResult === 'aborted') bump('bad', 'Prime95 stopped early');
    if (s.whea && s.whea.errors > 0) bump('bad', s.whea.errors + ' hardware error' + (s.whea.errors === 1 ? '' : 's') + ' during the test');
    if (s.cpu_max_c != null && s.cpu_max_c >= LIMITS.cpuBad) bump('bad', 'CPU reached ' + s.cpu_max_c + ' °C');
    else if (s.cpu_max_c != null && s.cpu_max_c >= LIMITS.cpuWarn) bump('warn', 'CPU reached ' + s.cpu_max_c + ' °C');
    if (s.gpu_max_c != null && s.gpu_max_c >= LIMITS.gpuBad) bump('bad', 'GPU reached ' + s.gpu_max_c + ' °C');
    else if (s.gpu_max_c != null && s.gpu_max_c >= LIMITS.gpuWarn) bump('warn', 'GPU reached ' + s.gpu_max_c + ' °C');
    if (s.cpu_max_c == null) bump('warn', 'CPU temperature not measured');
    if (s.error) bump('bad', s.error);
    return { level: level, notes: notes };
  }
  function goalPassed(g, r) {
    if (!r || !r.done) return null;
    if (g.kind === 'game') return r.avg_fps != null && r.avg_fps >= Number(g.target_fps);
    if (r.finished !== true) return false;
    if ((r.crashes || 0) > 0) return false;
    if (g.max_minutes && r.minutes != null && r.minutes > Number(g.max_minutes)) return false;
    return true;
  }
  function overall(q, s) {
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var hv = healthVerdict(s.health), sv = stabilityVerdict(s.stability);
    var missing = [];
    if (!s.health) missing.push('the health check');
    if (!sv) missing.push('the stability test');
    goals.forEach(function (g, i) { if (goalPassed(g, s.goals[i]) == null) missing.push(goalName(g)); });
    var passed = (!hv || hv.level !== 'bad') && (!sv || sv.level !== 'bad') &&
      goals.every(function (g, i) { return goalPassed(g, s.goals[i]) !== false; });
    return { missing: missing, passed: passed, health: hv, stability: sv };
  }
  function goalName(g) { return g.kind === 'game' ? g.name : g.app; }

  // The line the customer reads on the tracking page, written from the results;
  // the tech can change it before saving.
  function summaryText(q, s, passed) {
    var parts = [];
    var goals = Array.isArray(q.goals) ? q.goals : [];
    goals.forEach(function (g, i) {
      var r = s.goals[i];
      if (!r || !r.done) return;
      if (g.kind === 'game') {
        parts.push(g.name + (g.settings ? ' (' + g.settings + ')' : '') + ' averaged ' + r0(r.avg_fps) + ' fps' +
          (r.low1_fps != null ? ', 1% low ' + r0(r.low1_fps) : '') + ', target ' + g.target_fps);
      } else {
        parts.push(g.app + ': ' + g.task + (r.finished ? ' finished' + (r.minutes != null ? ' in ' + r.minutes + ' min' : '') : ' did not finish') +
          ((r.crashes || 0) > 0 ? ', ' + r.crashes + ' crash' + (r.crashes === 1 ? '' : 'es') : ' with no crashes'));
      }
    });
    var st = s.stability;
    if (st && st.done) {
      var temps = [st.cpu_max_c != null ? 'CPU ' + st.cpu_max_c + ' °C' : '', st.gpu_max_c != null ? 'GPU ' + st.gpu_max_c + ' °C' : ''].filter(Boolean).join(', ');
      var sv = stabilityVerdict(st);
      parts.push((st.minutes || q.stability_minutes || 15) + '-minute CPU + GPU stability test ' +
        (sv && sv.level === 'bad' ? 'had problems: ' + sv.notes.join(', ') : 'with no errors') + (temps ? ' (' + temps + ')' : ''));
    }
    var t = (passed ? 'QC passed. ' : 'QC did not pass. ') + parts.join('. ') + (parts.length ? '.' : '');
    return t.length > 1000 ? t.slice(0, 997) + '…' : t;
  }

  function results(q, s) {
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var h = s.health || null;
    var st = s.stability && s.stability.done ? s.stability : null;
    var pc = null;
    try { if (typeof require === 'function') pc = require('os').hostname(); } catch (e) { pc = null; }
    return {
      version: 1,
      pc: pc,
      practice: PRACTICE || undefined,
      health: h ? {
        at: h.at,
        disks: (h.disks || []).map(function (d) {
          return { model: d.model, type: [d.busType, d.mediaType].filter(Boolean).join(' '), size_gb: d.sizeGB, health: d.health,
            wear: d.wear, temp_c: d.tempC, errors: (d.readErrors || 0) + (d.writeErrors || 0), level: d.level, notes: d.notes };
        }),
        idle_cpu_c: h.idle ? h.idle.cpuC : null,
        idle_gpu_c: h.idle ? h.idle.gpuC : null,
        whea_7d: h.whea ? h.whea.errors : null,
        level: (healthVerdict(h) || {}).level
      } : null,
      stability: st ? {
        at: st.at, minutes: st.minutes, cpu_max_c: st.cpu_max_c, cpu_avg_c: st.cpu_avg_c, gpu_max_c: st.gpu_max_c, gpu_avg_c: st.gpu_avg_c,
        prime95: (st.prime95 || {}).overallResult || null, furmark: st.furmark_ran === true, whea: st.whea ? st.whea.errors : null,
        level: (stabilityVerdict(st) || {}).level
      } : null,
      goals: goals.map(function (g, i) {
        var r = s.goals[i] || {};
        var p = goalPassed(g, r);
        if (g.kind === 'game') {
          return { kind: 'game', passed: p, avg_fps: r.avg_fps, low1_fps: r.low1_fps, frames: r.frames, seconds: r.seconds, process: r.process, at: r.at };
        }
        return { kind: 'work', passed: p, finished: r.finished, minutes: r.minutes, crashes: r.crashes, process: r.process || null, at: r.at };
      })
    };
  }

  // ── the overlay ───────────────────────────────────────────────────────────
  var root = null, openId = null;
  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'qcb-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'QC bench test');
    root.innerHTML = '<div class="qcb-sheet"><div class="qcb-page" id="qcb-page"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      var u = U();
      if (u && typeof u.isDialogOpen === 'function' && u.isDialogOpen()) return;
      close();
    });
    return root;
  }
  function isOpen() { return !!(root && root.classList.contains('open')); }
  function close() {
    if (!root) return;
    root.classList.remove('open');
    document.body.classList.remove('tk-lock');
    openId = null;
    if (window.NeoQcServiceQc) window.NeoQcServiceQc.render();
  }
  function open(id) {
    var q = qcRow(id);
    if (!q) { toast('That QC job is not loaded. Refresh and try again.', 'warning'); return; }
    if (q.status !== 'queued' && q.status !== 'testing') {
      toast('This QC test has finished. Its result is on the ticket.', 'info');
      if (window.NeoTicketSummary) window.NeoTicketSummary.openJob(q.job_id);
      return;
    }
    ensureRoot();
    openId = String(id);
    load(openId);
    paint();
    root.classList.add('open');
    document.body.classList.add('tk-lock');
    var x = root.querySelector('.qcb-x');
    if (x) try { x.focus({ preventScroll: true }); } catch (e) { /* fine */ }
  }

  function chip(level, text) {
    return '<span class="qcb-chip qcb-' + esc(level || 'todo') + '">' + esc(text) + '</span>';
  }
  function levelWord(l) { return l === 'bad' ? 'Problem' : l === 'warn' ? 'Check' : 'OK'; }

  function step(n, key, title, sub, state, body) {
    return '<section class="qcb-step is-' + esc(state.cls) + '" data-step="' + esc(key) + '">' +
      '<div class="qcb-n">' + (state.cls === 'done-ok' ? '✓' : state.cls === 'done-bad' ? '✕' : n) + '</div>' +
      '<div class="qcb-step-main"><header class="qcb-step-h"><div><h3>' + esc(title) + '</h3>' +
        (sub ? '<p class="qcb-step-s">' + esc(sub) + '</p>' : '') + '</div>' + (state.chip || '') + '</header>' +
        '<div class="qcb-step-b">' + body + '</div></div></section>';
  }

  function healthBody(s) {
    var h = s.health;
    if (s.healthRunning) return '<div class="qcb-busy"><span class="qcb-spin"></span>Reading the drives, the idle temperatures and Windows’ hardware log…</div>';
    if (!h) return '<p class="qcb-p">Every drive’s health (read-only, nothing is written), the CPU and GPU temperature at idle, and the hardware errors Windows logged in the last 7 days. About 30 seconds.</p>' +
      '<div class="qcb-acts"><button type="button" class="primary-pink-btn" data-qa="health">Run the health check</button></div>';
    var v = healthVerdict(h);
    var disks = (h.disks || []).map(function (d) {
      var bits = [d.health || 'Unknown', d.wear != null ? d.wear + '% worn' : '', d.tempC != null ? d.tempC + ' °C' : '',
        ((d.readErrors || 0) + (d.writeErrors || 0)) ? ((d.readErrors || 0) + (d.writeErrors || 0)) + ' errors' : ''].filter(Boolean).join(' · ');
      return '<tr><th>' + esc(d.model || 'Drive') + '<small>' + esc([d.busType, d.mediaType, d.sizeGB ? d.sizeGB + ' GB' : ''].filter(Boolean).join(' · ')) + '</small></th>' +
        '<td>' + esc(bits) + '</td><td class="qcb-r">' + chip(d.level, levelWord(d.level)) + '</td></tr>';
    }).join('');
    var idle = h.idle || {};
    var idleLevel = (idle.cpuC != null && idle.cpuC >= LIMITS.idleCpu) || (idle.gpuC != null && idle.gpuC >= LIMITS.idleGpu) ? 'warn' : 'ok';
    var whea = h.whea || {};
    return '<table class="qcb-table">' +
      (disks || '<tr><th>Drives</th><td>' + esc(h.disksError || 'No drives found') + '</td><td class="qcb-r">' + chip('warn', 'Check') + '</td></tr>') +
      '<tr><th>Idle temperature</th><td>' + esc([idle.cpuC != null ? 'CPU ' + idle.cpuC + ' °C' : 'CPU not measured', idle.gpuC != null ? 'GPU ' + idle.gpuC + ' °C' : 'GPU not measured'].join(' · ')) + '</td><td class="qcb-r">' + chip(idleLevel, levelWord(idleLevel)) + '</td></tr>' +
      '<tr><th>Hardware errors<small>Windows WHEA log, last 7 days</small></th><td>' + esc(whea.ok === false ? 'Could not read the log' : whea.errors ? whea.errors + ' error' + (whea.errors === 1 ? '' : 's') + (whea.latest && whea.latest[0] ? ' · latest: ' + whea.latest[0].text : '') : 'None') + '</td><td class="qcb-r">' + chip(whea.errors ? 'warn' : 'ok', whea.errors ? 'Check' : 'OK') + '</td></tr>' +
      '</table>' +
      (v.notes.length ? '<p class="qcb-note qcb-note-' + esc(v.level) + '">' + esc(v.notes.join(' · ')) + '</p>' : '') +
      '<div class="qcb-acts"><span class="qcb-when">' + esc(fmtWhen(h.at)) + '</span><button type="button" class="secondary-btn" data-qa="health">Run again</button></div>';
  }

  function runProgress(st, mins) {
    if (PRACTICE) return { pct: Math.min(100, Math.round((st.ticks || 0) / 24 * 100)), text: 'Practice run' };
    var sec = (Date.now() - Date.parse(st.at)) / 1000;
    return { pct: Math.min(100, Math.round(sec / (mins * 60) * 100)), text: mmss(Math.min(sec, mins * 60)) + ' of ' + mins + ':00' };
  }

  function stabilityBody(q, s) {
    var mins = q.stability_minutes || 15;
    var st = s.stability;
    if (st && st.running) {
      var p = runProgress(st, mins);
      return '<div class="qcb-run">' +
        '<div class="qcb-bar"><span id="qcb-run-bar" style="width:' + p.pct + '%"></span></div>' +
        '<div class="qcb-run-row"><span id="qcb-run-time">' + esc(p.text) + '</span>' +
          '<span class="qcb-live">CPU <b id="qcb-live-cpu">' + (st.live_cpu != null ? st.live_cpu + ' °C' : '–') + '</b> · GPU <b id="qcb-live-gpu">' + (st.live_gpu != null ? st.live_gpu + ' °C' : '–') + '</b></span></div>' +
        '<p class="qcb-log" id="qcb-live-log">' + esc(st.last_log || 'Starting Prime95 and FurMark…') + '</p>' +
        '<p class="qcb-hint">It stops by itself. Leave the PC alone: no games or browsing during the test.</p></div>';
    }
    if (!st || !st.done) {
      return '<p class="qcb-p">Prime95 (CPU and memory) and FurMark (graphics) together for ' + mins + ' minutes, watching the temperatures, then Windows’ hardware log for errors during the run. No benchmark files are written to the customer’s drives.</p>' +
        (st && st.error ? '<p class="qcb-note qcb-note-bad">' + esc(st.error) + '</p>' : '') +
        '<div class="qcb-acts"><span class="qcb-hint">Close the customer’s apps first.</span><button type="button" class="primary-pink-btn" data-qa="stability"' + (s.healthRunning ? ' disabled' : '') + '>Start the ' + mins + '-minute test</button></div>';
    }
    var v = stabilityVerdict(st);
    var p95 = st.prime95 || {};
    return '<table class="qcb-table">' +
      '<tr><th>CPU<small>Prime95, ' + esc(st.minutes) + ' min</small></th><td>' + esc([st.cpu_max_c != null ? 'Max ' + st.cpu_max_c + ' °C' : 'Temperature not measured', st.cpu_avg_c != null ? 'average ' + st.cpu_avg_c + ' °C' : '', p95.overallResult === 'pass' ? 'no errors' : p95.overallResult === 'fail' ? 'ERRORS' : p95.overallResult || ''].filter(Boolean).join(' · ')) + '</td>' +
        '<td class="qcb-r">' + chip(p95.overallResult === 'fail' || p95.overallResult === 'aborted' || (st.cpu_max_c != null && st.cpu_max_c >= LIMITS.cpuBad) ? 'bad' : (st.cpu_max_c == null || st.cpu_max_c >= LIMITS.cpuWarn) ? 'warn' : 'ok',
          p95.overallResult === 'fail' || p95.overallResult === 'aborted' || (st.cpu_max_c != null && st.cpu_max_c >= LIMITS.cpuBad) ? 'Problem' : (st.cpu_max_c == null || st.cpu_max_c >= LIMITS.cpuWarn) ? 'Check' : 'OK') + '</td></tr>' +
      '<tr><th>GPU<small>FurMark</small></th><td>' + esc([st.gpu_max_c != null ? 'Max ' + st.gpu_max_c + ' °C' : 'Temperature not measured', st.gpu_avg_c != null ? 'average ' + st.gpu_avg_c + ' °C' : '', st.furmark_ran ? 'ran the whole time' : ''].filter(Boolean).join(' · ')) + '</td>' +
        '<td class="qcb-r">' + chip(st.gpu_max_c != null && st.gpu_max_c >= LIMITS.gpuBad ? 'bad' : st.gpu_max_c != null && st.gpu_max_c >= LIMITS.gpuWarn ? 'warn' : 'ok',
          st.gpu_max_c != null && st.gpu_max_c >= LIMITS.gpuBad ? 'Problem' : st.gpu_max_c != null && st.gpu_max_c >= LIMITS.gpuWarn ? 'Check' : 'OK') + '</td></tr>' +
      '<tr><th>Hardware errors<small>during the test</small></th><td>' + esc(st.whea ? (st.whea.errors ? st.whea.errors + ' error' + (st.whea.errors === 1 ? '' : 's') : 'None') : 'Not checked') + '</td>' +
        '<td class="qcb-r">' + chip(st.whea && st.whea.errors ? 'bad' : 'ok', st.whea && st.whea.errors ? 'Problem' : 'OK') + '</td></tr>' +
      '</table>' +
      (v.notes.length ? '<p class="qcb-note qcb-note-' + esc(v.level) + '">' + esc(v.notes.join(' · ')) + '</p>' : '') +
      '<div class="qcb-acts"><span class="qcb-when">' + esc(fmtWhen(st.at)) + '</span><button type="button" class="secondary-btn" data-qa="stability">Run again</button></div>';
  }

  function procPicker(i, r, s) {
    var list = s.procs || [];
    var cur = (r && r.process) || '';
    var opts = '<option value="">' + (list.length ? '— Pick the running app —' : 'Press Refresh to list the running apps') + '</option>' +
      list.map(function (p) {
        return '<option value="' + esc(p.exe) + '"' + (p.exe === cur ? ' selected' : '') + '>' + esc(p.title ? p.title + ' — ' + p.exe : p.exe) + '</option>';
      }).join('');
    return '<div class="qcb-pick"><select class="settings-select" data-qg-proc="' + i + '">' + opts + '</select>' +
      '<button type="button" class="secondary-btn" data-qa="procs">Refresh</button>' +
      '<input type="text" class="qcb-exe" data-qg-exe="' + i + '" placeholder="or type the .exe" value="' + esc(cur && !list.some(function (p) { return p.exe === cur; }) ? cur : '') + '" spellcheck="false" autocomplete="off"></div>';
  }

  function gameBody(g, i, s) {
    var r = s.goals[i] || {};
    var p = goalPassed(g, r);
    var busy = r.running;
    var res = r.done ? '<div class="qcb-fps ' + (p ? 'ok' : 'bad') + '"><div class="qcb-fps-big">' + esc(r0(r.avg_fps)) + '<small> fps average</small></div>' +
      '<div class="qcb-fps-sub">' + esc([r.low1_fps != null ? '1% low ' + r0(r.low1_fps) + ' fps' : '', r.frames ? r.frames.toLocaleString('en-IN') + ' frames over ' + r0(r.seconds) + ' s' : '', r.process || ''].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="qcb-fps-verdict">' + (p ? '✓ Meets the ' + esc(g.target_fps) + ' fps target' : '✕ Below the ' + esc(g.target_fps) + ' fps target') + '</div></div>' : '';
    if (busy) {
      var left = r.ends_at ? Math.max(0, Math.round((r.ends_at - Date.now()) / 1000)) : null;
      var starts = r.starts_at ? Math.round((r.starts_at - Date.now()) / 1000) : null;
      return '<div class="qcb-busy"><span class="qcb-spin"></span><span id="qcb-cap-' + i + '">' +
        (starts != null && starts > 0 ? 'Switch to the game now: recording starts in ' + starts + ' s' : left != null ? 'Recording ' + esc(r.process) + '… ' + left + ' s left' : 'Recording…') +
        '</span></div>';
    }
    return '<ol class="qcb-ol"><li>Start <b>' + esc(g.name) + '</b> on this PC' + (g.settings ? ' at <b>' + esc(g.settings) + '</b>' : '') + '.</li>' +
      '<li>Get into real gameplay: a match, the range or a benchmark run, not a menu.</li>' +
      '<li>Pick the game below and press Measure. You have 10 seconds to switch back to the game; PresentMon then records 60 seconds.</li></ol>' +
      procPicker(i, r, s) + (r.error ? '<p class="qcb-note qcb-note-bad">' + esc(r.error) + '</p>' : '') + res +
      '<div class="qcb-acts"><span class="qcb-when">' + esc(r.done ? fmtWhen(r.at) : '') + '</span><button type="button" class="' + (r.done ? 'secondary-btn' : 'primary-pink-btn') + '" data-qa="fps" data-i="' + i + '"' + (anyBusy(s) ? ' disabled' : '') + '>' + (r.done ? 'Measure again' : 'Measure (60 s)') + '</button></div>';
  }

  function workBody(g, i, s) {
    var r = s.goals[i] || {};
    var p = goalPassed(g, r);
    if (r.running) {
      var sec = (Date.now() - r.timerStart) / 1000;
      return '<div class="qcb-timer"><span class="qcb-timer-n" id="qcb-timer-' + i + '">' + mmss(sec) + '</span>' +
        (g.max_minutes ? '<span class="qcb-hint">Target: within ' + esc(g.max_minutes) + ' min</span>' : '') + '</div>' +
        procPicker(i, r, s) +
        '<div class="qcb-acts"><button type="button" class="secondary-btn" data-qa="work-fail" data-i="' + i + '">It failed or crashed</button>' +
          '<button type="button" class="primary-pink-btn" data-qa="work-done" data-i="' + i + '">It finished</button></div>';
    }
    var res = r.done ? '<div class="qcb-fps ' + (p ? 'ok' : 'bad') + '"><div class="qcb-fps-big">' + (r.finished ? 'Finished' : 'Did not finish') +
      (r.minutes != null ? '<small> in ' + esc(r.minutes) + ' min</small>' : '') + '</div>' +
      '<div class="qcb-fps-sub">' + esc(r.crashes ? r.crashes + ' crash' + (r.crashes === 1 ? '' : 'es') + ' in Windows’ log' + (r.crash_text ? ': ' + r.crash_text : '') : 'No crashes in Windows’ log' + (r.process ? ' for ' + r.process : '')) + '</div>' +
      '<div class="qcb-fps-verdict">' + (p ? '✓ Works' : '✕ Not good enough') + '</div></div>' : '';
    return '<ol class="qcb-ol"><li>Open <b>' + esc(g.app) + '</b> on this PC.</li>' +
      '<li>Press Start the timer, then do: <b>' + esc(g.task) + '</b>' + (g.max_minutes ? ' (target: within ' + esc(g.max_minutes) + ' min)' : '') + '.</li>' +
      '<li>Pick the app below so Windows’ crash log is checked for it, and press It finished when it is done.</li></ol>' +
      procPicker(i, r, s) + res +
      '<div class="qcb-acts"><span class="qcb-when">' + esc(r.done ? fmtWhen(r.at) : '') + '</span><button type="button" class="' + (r.done ? 'secondary-btn' : 'primary-pink-btn') + '" data-qa="work-start" data-i="' + i + '"' + (anyBusy(s) ? ' disabled' : '') + '>' + (r.done ? 'Start again' : 'Start the timer') + '</button></div>';
  }

  function anyBusy(s) {
    return !!(s.healthRunning || (s.stability && s.stability.running) || s.goals.some(function (g) { return g && g.running; }));
  }

  function finishBody(q, s) {
    var o = overall(q, s);
    if (s.saved) {
      return '<p class="qcb-p"><b>' + (s.saved.demo ? 'Demo data: not saved.' : s.saved.passed ? 'Saved as passed.' : 'Saved as not passed.') + '</b> ' +
        (s.saved.demo ? 'The customer would see' : 'The customer sees') + ': “' + esc(s.saved.summary) + '”</p>' +
        '<div class="qcb-acts"><button type="button" class="secondary-btn" data-qa="report">Print the QC report</button>' +
        '<button type="button" class="secondary-btn" data-qa="report-pdf">Save as PDF</button>' +
        '<button type="button" class="primary-pink-btn" data-qa="close">Done</button></div>';
    }
    var pick = s.verdict != null ? s.verdict : (o.passed ? 'passed' : 'failed');
    var text = s.summaryEdited ? s.summary : summaryText(q, s, pick === 'passed');
    return (o.missing.length ? '<p class="qcb-note qcb-note-warn">Not done yet: ' + esc(o.missing.join(', ')) + '.</p>' : '') +
      '<div class="qcb-verdict">' +
        '<label class="qcb-radio' + (pick === 'passed' ? ' on' : '') + '"><input type="radio" name="qcb-v" value="passed"' + (pick === 'passed' ? ' checked' : '') + '> Passed</label>' +
        '<label class="qcb-radio bad' + (pick === 'failed' ? ' on' : '') + '"><input type="radio" name="qcb-v" value="failed"' + (pick === 'failed' ? ' checked' : '') + '> Did not pass</label>' +
        '<span class="qcb-hint">Suggested: ' + (o.passed ? 'passed' : 'did not pass') + '</span></div>' +
      '<label class="qcb-field"><span>What the customer reads on the tracking page</span>' +
        '<textarea id="qcb-summary" rows="3" maxlength="1000">' + esc(text) + '</textarea></label>' +
      '<div class="qcb-acts">' + (s.summaryEdited ? '<button type="button" class="secondary-btn" data-qa="rewrite">Write it again from the results</button>' : '') +
        '<button type="button" class="primary-pink-btn" data-qa="save"' + (anyBusy(s) || o.missing.length ? ' disabled' : '') + '>Save the QC result</button></div>';
  }

  function paint() {
    if (!root || !openId) return;
    var q = qcRow(openId);
    var page = el('qcb-page');
    if (!q || !page) return;
    var s = load(openId);
    var job = jobOf(q);
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var hv = healthVerdict(s.health), sv = stabilityVerdict(s.stability);
    var stateOf = function (v, running, done) {
      if (running) return { cls: 'now', chip: chip('now', 'Running') };
      if (!done) return { cls: 'todo', chip: '' };
      return { cls: v && v.level === 'bad' ? 'done-bad' : 'done-ok', chip: chip(v ? v.level : 'ok', v ? levelWord(v.level) : 'Done') };
    };
    var n = 1;
    var html = '<header class="qcb-head"><div class="qcb-head-main">' +
        '<div class="qcb-kicker">QC test<span class="qcb-code">' + esc(job ? job.public_code : '') + '</span></div>' +
        '<h2 class="qcb-title">' + esc(job ? job.customer_name : 'Service ticket') + '</h2>' +
        '<div class="qcb-sub">' + esc([job && job.device_label, (q.stability_minutes || 15) + ' min stability', q.charge === 'paid' ? 'Paid ' + inr(q.amount) : 'Free',
          q.status === 'testing' ? 'Being tested' + (q.tested_by_name ? ' by ' + q.tested_by_name : '') : 'Waiting for the bench'].filter(Boolean).join(' · ')) + '</div>' +
      '</div><button type="button" class="qcb-x" data-qa="close" aria-label="Close">×</button></header>' +
      (PRACTICE ? '<div class="qcb-banner">Practice: this window can’t run the bench tools, so the numbers below are made up and nothing is saved.</div>'
        : D() && D().isDemo && D().isDemo() ? '<div class="qcb-banner">Demo data is on: the tests run for real on this PC, but the result is not saved.</div>' : '') +
      (q.customer_words ? '<p class="qcb-words">“' + esc(q.customer_words) + '”</p>' : '') +
      '<div class="qcb-steps">' +
      step(n++, 'health', 'Health check', 'Drives, idle temperatures, hardware errors', stateOf(hv, s.healthRunning, !!s.health), healthBody(s)) +
      step(n++, 'stability', 'Stability test', (q.stability_minutes || 15) + ' minutes · Prime95 + FurMark', stateOf(sv, s.stability && s.stability.running, !!sv), stabilityBody(q, s)) +
      goals.map(function (g, i) {
        var r = s.goals[i] || {};
        var p = goalPassed(g, r);
        var stt = r.running ? { cls: 'now', chip: chip('now', g.kind === 'game' ? 'Measuring' : 'Timing') }
          : p == null ? { cls: 'todo', chip: '' } : { cls: p ? 'done-ok' : 'done-bad', chip: chip(p ? 'ok' : 'bad', p ? 'Passed' : 'Not passed') };
        return g.kind === 'game'
          ? step(n++, 'goal' + i, 'Game · ' + g.name, [g.settings, 'target ' + g.target_fps + ' fps average'].filter(Boolean).join(' · '), stt, gameBody(g, i, s))
          : step(n++, 'goal' + i, 'Work · ' + g.app, g.task + (g.max_minutes ? ' · within ' + g.max_minutes + ' min' : ''), stt, workBody(g, i, s));
      }).join('') +
      step(n++, 'finish', 'Finish', 'Passed or not, and the line the customer reads', s.saved ? { cls: s.saved.passed ? 'done-ok' : 'done-bad', chip: chip(s.saved.demo ? 'warn' : s.saved.passed ? 'ok' : 'bad', s.saved.demo ? 'Not saved (demo)' : 'Saved') } : { cls: 'todo', chip: '' }, finishBody(q, s)) +
      '</div>';
    var y = root.querySelector('.qcb-sheet') ? root.querySelector('.qcb-sheet').scrollTop : 0;
    page.innerHTML = html;
    if (root.querySelector('.qcb-sheet')) root.querySelector('.qcb-sheet').scrollTop = y;
  }

  // A light repaint for the timers and countdowns, once a second.
  setInterval(function () {
    if (!isOpen() || !openId) return;
    var s = states[openId];
    if (!s) return;
    if (s.stability && s.stability.running) {
      var q = qcRow(openId);
      var p = runProgress(s.stability, (q && q.stability_minutes) || s.stability.minutes || 15);
      var bar = el('qcb-run-bar'), tm = el('qcb-run-time');
      if (bar) bar.style.width = p.pct + '%';
      if (tm) tm.textContent = p.text;
    }
    s.goals.forEach(function (r, i) {
      if (!r || !r.running) return;
      var t = el('qcb-timer-' + i);
      if (t && r.timerStart) t.textContent = mmss((Date.now() - r.timerStart) / 1000);
      var c = el('qcb-cap-' + i);
      if (c && r.ends_at) {
        var starts = r.starts_at ? Math.round((r.starts_at - Date.now()) / 1000) : 0;
        var left = Math.max(0, Math.round((r.ends_at - Date.now()) / 1000));
        c.textContent = starts > 0 ? 'Switch to the game now: recording starts in ' + starts + ' s' : 'Recording ' + (r.process || '') + '… ' + left + ' s left';
      }
    });
  }, 1000);

  // ── actions ───────────────────────────────────────────────────────────────
  // The first test moves the QC job to "being tested" (service_qc_start).
  async function ensureStarted(q) {
    if (!q || q.status !== 'queued') return true;
    var d = D();
    if (!d || typeof d.startQc !== 'function') return true;
    try { await d.startQc(q.id); return true; }
    catch (e) {
      if (isDemoErr(e)) return true;
      toast('Could not mark the QC test as started: ' + errText(e), 'error');
      return false;
    }
  }

  async function runHealth(id) {
    var s = load(id), q = qcRow(id);
    if (anyBusy(s)) return;
    if (!(await ensureStarted(q))) return;
    s.healthRunning = true;
    paint();
    var since = new Date(Date.now() - 7 * 86400000).toISOString();
    var out = await Promise.all([
      bench('sys:qc-disks').catch(function (e) { return { ok: false, error: e.message }; }),
      bench('sys:qc-idle-temps', { seconds: 20 }).catch(function (e) { return { ok: false, error: e.message }; }),
      bench('sys:qc-whea', { since: since }).catch(function (e) { return { ok: false, error: e.message }; })
    ]);
    s.healthRunning = false;
    s.health = {
      at: new Date().toISOString(),
      disks: out[0] && out[0].ok ? out[0].disks : [],
      disksError: out[0] && out[0].ok ? null : 'Could not read the drives' + (out[0] && out[0].error ? ' (' + out[0].error + ')' : ''),
      idle: out[1] && out[1].ok ? { cpuC: out[1].cpuC, gpuC: out[1].gpuC } : { cpuC: null, gpuC: null, error: out[1] && out[1].error },
      whea: out[2] && out[2].ok ? { ok: true, errors: out[2].errors, warnings: out[2].warnings, latest: out[2].latest } : { ok: false, errors: 0 }
    };
    save(s);
    paint();
  }

  async function runStability(id) {
    var s = load(id), q = qcRow(id);
    if (anyBusy(s) || !q) return;
    if (!(await ensureStarted(q))) return;
    var mins = q.stability_minutes || 15;
    var startIso = new Date().toISOString();
    var st = s.stability = { running: true, at: startIso, minutes: mins, ticks: 0, live_cpu: null, live_gpu: null };
    var onSensor = function (p) {
      if (p.cpuTemp != null && isFinite(+p.cpuTemp)) st.live_cpu = Math.round(+p.cpuTemp);
      if (p.gpuTemp != null && isFinite(+p.gpuTemp)) st.live_gpu = Math.round(+p.gpuTemp);
      st.ticks++;
      var c = el('qcb-live-cpu'), g = el('qcb-live-gpu');
      if (c && st.live_cpu != null) c.textContent = st.live_cpu + ' °C';
      if (g && st.live_gpu != null) g.textContent = st.live_gpu + ' °C';
    };
    var onLog = function (t) { st.last_log = t; var l = el('qcb-live-log'); if (l) l.textContent = t; };
    listeners.sensor.push(onSensor);
    listeners.log.push(onLog);
    paint();
    var res = null;
    try { res = await bench('sys:run-diagnostics', { serviceQc: true, duration: mins * 60 }); }
    catch (e) { res = { success: false, error: errText(e) }; }
    listeners.sensor = listeners.sensor.filter(function (f) { return f !== onSensor; });
    listeners.log = listeners.log.filter(function (f) { return f !== onLog; });
    if (!res || res.success === false) {
      s.stability = { done: false, error: (res && res.error) || 'The stability test did not run.' };
      save(s);
      paint();
      return;
    }
    var whea = await bench('sys:qc-whea', { since: startIso }).catch(function () { return null; });
    s.stability = {
      done: true, at: startIso, minutes: mins,
      cpu_max_c: r0(res.cpuTempMax), cpu_avg_c: r0(res.cpuTempAvg), gpu_max_c: r0(res.gpuTempMax), gpu_avg_c: r0(res.gpuTempAvg),
      prime95: res.prime95 ? { overallResult: res.prime95.overallResult, durationActualSec: res.prime95.durationActualSec, errors: (res.prime95.errorSummary || []).slice(0, 3) } : null,
      furmark_ran: res.furmarkScore != null,
      whea: whea && whea.ok ? { errors: whea.errors, latest: whea.latest } : null,
      seconds: res.runDurationSec
    };
    save(s);
    if (openId === String(id)) paint();
    toast('The stability test has finished.', 'success');
  }

  async function loadProcs(id) {
    var s = load(id);
    var r = await bench('sys:qc-processes').catch(function (e) { return { ok: false, error: e.message }; });
    if (r && r.ok) s.procs = r.processes || [];
    else toast('Could not list the running apps' + (r && r.error ? ': ' + r.error : '.'), 'warning');
    paint();
  }

  function procFor(i) {
    var typed = root.querySelector('[data-qg-exe="' + i + '"]');
    var sel = root.querySelector('[data-qg-proc="' + i + '"]');
    var t = typed && typed.value.trim();
    if (t) return /\.exe$/i.test(t) ? t : t + '.exe';
    return sel ? sel.value : '';
  }

  async function measureFps(id, i) {
    var s = load(id), q = qcRow(id);
    if (anyBusy(s) || !q) return;
    var proc = procFor(i);
    if (!proc) { toast('Pick the game from the list, or type its .exe name.', 'warning'); return; }
    if (!(await ensureStarted(q))) return;
    var delay = PRACTICE ? 0 : 10, sec = 60;
    s.goals[i] = { running: true, process: proc, starts_at: Date.now() + delay * 1000, ends_at: Date.now() + (delay + (PRACTICE ? 6 : sec)) * 1000 };
    paint();
    var out = await bench('sys:qc-fps-capture', { processName: proc, seconds: sec, delaySec: delay }).catch(function (e) { return { ok: false, error: e.message }; });
    if (!out || !out.ok) {
      s.goals[i] = { done: false, process: proc, error: (out && out.error) || 'The capture failed.' };
    } else {
      s.goals[i] = { done: true, at: new Date().toISOString(), process: proc, avg_fps: out.avgFps, low1_fps: out.low1Fps,
        frames: out.frames, seconds: out.seconds, displayed_fps: out.displayedFps };
    }
    save(s);
    if (openId === String(id)) paint();
  }

  async function workStart(id, i) {
    var s = load(id), q = qcRow(id);
    if (anyBusy(s) || !q) return;
    if (!(await ensureStarted(q))) return;
    var prev = s.goals[i] || {};
    s.goals[i] = { running: true, timerStart: Date.now(), started_iso: new Date().toISOString(), process: prev.process || procFor(i) || '' };
    save(s);
    paint();
  }
  async function workStop(id, i, finished) {
    var s = load(id);
    var r = s.goals[i];
    if (!r || !r.running) return;
    var proc = procFor(i) || r.process || '';
    var minutes = Math.max(0, Math.round((Date.now() - r.timerStart) / 6000) / 10);
    var crash = await bench('sys:qc-app-crashes', { since: r.started_iso, exe: proc }).catch(function () { return null; });
    s.goals[i] = { done: true, at: new Date().toISOString(), finished: !!finished, minutes: minutes, process: proc || null,
      crashes: crash && crash.ok ? crash.total : null, crash_text: crash && crash.ok && crash.latest && crash.latest[0] ? crash.latest[0].text : null };
    save(s);
    paint();
  }

  async function saveResult(id) {
    var s = load(id), q = qcRow(id);
    var d = D();
    if (!q || !d || typeof d.finishQc !== 'function') return;
    var o = overall(q, s);
    if (o.missing.length) { toast('Finish ' + o.missing.join(', ') + ' first.', 'warning'); return; }
    var v = root.querySelector('input[name="qcb-v"]:checked');
    var passed = v ? v.value === 'passed' : o.passed;
    var ta = el('qcb-summary');
    var text = ta ? ta.value.trim() : '';
    if (!text) { toast('Write the line the customer reads.', 'warning'); return; }
    var btn = root.querySelector('[data-qa="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await d.finishQc(q.id, passed, results(q, s), text);
      s.saved = { passed: passed, summary: text, at: new Date().toISOString() };
      forget(id);
      states[id] = s;
      toast(passed ? 'QC passed. The ticket and the tracking page show it.' : 'Saved as not passed. The ticket shows the result.', passed ? 'success' : 'info');
    } catch (e) {
      if (isDemoErr(e)) {
        s.saved = { passed: passed, summary: text, at: new Date().toISOString(), demo: true };
        lastReport[String(id)] = { q: q, s: JSON.parse(JSON.stringify(s)), passed: passed, summary: text };
        toast('Demo data is read-only: the result was not saved.', 'info');
      } else {
        toast('Could not save the QC result: ' + errText(e), 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Save the QC result'; }
        return;
      }
    }
    if (!lastReport[String(id)]) lastReport[String(id)] = { q: q, s: JSON.parse(JSON.stringify(s)), passed: passed, summary: text };
    paint();
  }

  function onClick(e) {
    var b = e.target.closest('[data-qa]');
    if (!b || b.disabled || !openId) return;
    var a = b.getAttribute('data-qa');
    var i = Number(b.getAttribute('data-i'));
    var id = openId;
    if (a === 'close') close();
    else if (a === 'health') runHealth(id);
    else if (a === 'stability') runStability(id);
    else if (a === 'procs') loadProcs(id);
    else if (a === 'fps') measureFps(id, i);
    else if (a === 'work-start') workStart(id, i);
    else if (a === 'work-done') workStop(id, i, true);
    else if (a === 'work-fail') workStop(id, i, false);
    else if (a === 'save') saveResult(id);
    else if (a === 'rewrite') { var s = load(id); s.summaryEdited = false; s.summary = ''; paint(); }
    else if (a === 'report') printReport(id, 'print');
    else if (a === 'report-pdf') printReport(id, 'pdf');
  }
  function onChange(e) {
    if (!openId) return;
    var s = load(openId);
    if (e.target.name === 'qcb-v') { s.verdict = e.target.value; if (!s.summaryEdited) paint(); else paintRadios(); return; }
    if (e.target.id === 'qcb-summary') { s.summary = e.target.value; s.summaryEdited = true; save(s); return; }
    var pi = e.target.getAttribute('data-qg-proc');
    if (pi != null) { var r = s.goals[Number(pi)] || (s.goals[Number(pi)] = {}); r.process = e.target.value; save(s); }
  }
  function paintRadios() {
    Array.prototype.forEach.call(root.querySelectorAll('.qcb-radio'), function (l) {
      var inp = l.querySelector('input');
      l.classList.toggle('on', !!(inp && inp.checked));
    });
  }
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'qcb-summary' && openId) {
      var s = load(openId);
      s.summary = e.target.value;
      s.summaryEdited = true;
    }
  });

  // ── the one-page QC report ───────────────────────────────────────────────
  var lastReport = {};
  function shop() {
    var C = CAT();
    var base = (C && C.SHOP_DETAILS) || {};
    var name = base.name || 'Neo Tokyo Kochi';
    try { if (typeof appState !== 'undefined' && appState && appState.settings && appState.settings.shopName) name = String(appState.settings.shopName); } catch (e) { /* default */ }
    return { name: name, lines: Array.isArray(base.lines) ? base.lines.map(String).filter(Boolean) : [] };
  }
  function reportHtml(q, job, res, summary, passed, testedBy, finishedAt) {
    var sh = shop();
    var C = CAT();
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var gr = (res && Array.isArray(res.goals)) ? res.goals : [];
    var h = res && res.health, st = res && res.stability;
    var row = function (k, v, mark) { return '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td><td class="qr-m">' + esc(mark || '') + '</td></tr>'; };
    var mark = function (l) { return l === 'bad' ? '✕' : l === 'warn' ? '!' : '✓'; };
    var goalRows = goals.map(function (g, i) {
      var r = gr[i] || {};
      if (g.kind === 'game') {
        return row(g.name + (g.settings ? ' · ' + g.settings : ''), 'Target ' + g.target_fps + ' fps average → measured ' + (r.avg_fps != null ? r0(r.avg_fps) + ' fps' : '—') +
          (r.low1_fps != null ? ' (1% low ' + r0(r.low1_fps) + ')' : '') + (r.frames ? ' · ' + r.frames.toLocaleString('en-IN') + ' frames, PresentMon' : ''), r.passed == null ? '' : r.passed ? '✓' : '✕');
      }
      return row(g.app, g.task + (g.max_minutes ? ' (within ' + g.max_minutes + ' min)' : '') + ' → ' + (r.finished ? 'finished' : 'did not finish') +
        (r.minutes != null ? ' in ' + r.minutes + ' min' : '') + (r.crashes != null ? ', ' + (r.crashes ? r.crashes + ' crash(es)' : 'no crashes') : ''), r.passed == null ? '' : r.passed ? '✓' : '✕');
    }).join('');
    var diskRows = h && h.disks ? h.disks.map(function (d) {
      return row(d.model || 'Drive', [d.type, d.size_gb ? d.size_gb + ' GB' : '', d.health, d.wear != null ? d.wear + '% worn' : '', d.temp_c != null ? d.temp_c + ' °C' : '', d.errors ? d.errors + ' errors' : ''].filter(Boolean).join(' · '), mark(d.level));
    }).join('') : '';
    var code = job ? job.public_code : '';
    var track = C && typeof C.trackLink === 'function' && code ? C.trackLink(code) : '';
    return '<div class="qr">' +
      '<div class="qr-head"><div><div class="qr-shop">' + esc(sh.name) + '</div>' + sh.lines.map(function (x) { return '<div class="qr-shop-l">' + esc(x) + '</div>'; }).join('') + '</div>' +
        '<div class="qr-title"><div class="qr-t">Service QC report</div><div class="qr-code">' + esc(code) + '</div><div class="qr-date">' + esc(fmtWhen(finishedAt)) + '</div></div></div>' +
      (res && res.practice ? '<p class="qr-practice">PRACTICE REPORT: made-up numbers from the training screen. Not a real test of this PC.</p>' : '') +
      '<div class="qr-verdict ' + (passed ? 'ok' : 'bad') + '">' + (passed ? 'PASSED' : 'DID NOT PASS') + '</div>' +
      '<p class="qr-summary">' + esc(summary) + '</p>' +
      '<table class="qr-facts">' +
        row('Customer', job ? job.customer_name : '') +
        row('PC', [job && job.device_label, res && res.pc ? 'Windows name ' + res.pc : ''].filter(Boolean).join(' · ')) +
        (q.customer_words ? row('Asked for', '“' + q.customer_words + '”') : '') +
        row('Tested by', testedBy || '') +
      '</table>' +
      (goalRows ? '<h4>The customer’s goals</h4><table class="qr-tbl">' + goalRows + '</table>' : '') +
      '<h4>Stability test</h4><table class="qr-tbl">' +
        (st ? row(st.minutes + ' minutes · Prime95 + FurMark', [st.cpu_max_c != null ? 'CPU max ' + st.cpu_max_c + ' °C' : 'CPU temperature not measured', st.gpu_max_c != null ? 'GPU max ' + st.gpu_max_c + ' °C' : '', 'Prime95 ' + (st.prime95 === 'pass' ? 'no errors' : st.prime95 || '—'), st.whea != null ? (st.whea ? st.whea + ' hardware errors' : 'no hardware errors') : ''].filter(Boolean).join(' · '), mark(st.level)) : row('Not run', '')) +
      '</table>' +
      '<h4>Health check</h4><table class="qr-tbl">' +
        diskRows +
        (h ? row('Idle temperature', [h.idle_cpu_c != null ? 'CPU ' + h.idle_cpu_c + ' °C' : 'CPU not measured', h.idle_gpu_c != null ? 'GPU ' + h.idle_gpu_c + ' °C' : ''].filter(Boolean).join(' · ')) +
          row('Hardware errors (7 days)', h.whea_7d == null ? 'Not read' : h.whea_7d ? h.whea_7d + ' in Windows’ WHEA log' : 'None') : row('Not run', '')) +
      '</table>' +
      (q.charge === 'paid' ? '<p class="qr-small">QC test charge: ' + esc(inr(q.amount)) + '</p>' : '') +
      (track ? '<p class="qr-small">Track this ticket: ' + esc(track) + '</p>' : '') +
      '<p class="qr-small">Temperatures are the highest reading of the sensors Windows exposes. FPS is measured with Intel PresentMon over 60 seconds of gameplay on this PC; results depend on the game version, drivers and scene.</p>' +
    '</div>';
  }
  var printing = false, printAt = 0;
  function sheet() {
    var s = el('qcb-report-sheet');
    if (!s) {
      s = document.createElement('div');
      s.id = 'qcb-report-sheet';
      s.className = 'qcb-report-sheet';
      s.setAttribute('aria-hidden', 'true');
      document.body.appendChild(s);
      window.addEventListener('afterprint', endPrint);
      var settle = function () { if (printing && Date.now() - printAt > 1500) endPrint(); };
      document.addEventListener('pointerdown', settle, true);
      document.addEventListener('keydown', settle, true);
    }
    return s;
  }
  function endPrint() { printing = false; document.body.classList.remove('qcb-printing'); }

  // Report for a QC job: the saved server row (results, summary), or the
  // demo copy kept in memory when demo data blocked the save.
  function reportFor(id) {
    var q = qcRow(id);
    var mem = lastReport[String(id)];
    if (q && (q.status === 'passed' || q.status === 'failed') && q.results && Object.keys(q.results).length) {
      return { html: reportHtml(q, jobOf(q), q.results, q.summary || '', q.status === 'passed', q.tested_by_name, q.finished_at), q: q };
    }
    if (mem) {
      return { html: reportHtml(mem.q, jobOf(mem.q), results(mem.q, mem.s), mem.summary, mem.passed, (D() && D().me && D().me() && D().me().full_name) || '', mem.s.saved && mem.s.saved.at), q: mem.q };
    }
    return null;
  }
  async function printReport(id, mode) {
    var r = reportFor(id);
    if (!r) { toast('There is no saved QC result to print yet.', 'warning'); return; }
    sheet().innerHTML = r.html;
    document.body.classList.add('qcb-printing');
    printing = true;
    printAt = Date.now();
    if (!IPC) { window.print(); return; }
    var job = jobOf(r.q);
    try {
      if (mode === 'pdf') {
        var res = await IPC.invoke('sys:print-pdf', { filename: 'QC ' + ((job && job.public_code) || 'service') + '.pdf', title: 'Save the QC report as PDF' });
        endPrint();
        if (res && res.success) toast('QC report saved: ' + (res.filePath || 'PDF') + '. Send it to the customer on WhatsApp.', 'success');
        else if (res && res.error && res.error !== 'Cancelled') toast('Could not save the PDF: ' + res.error, 'error');
      } else {
        var p = await IPC.invoke('sys:print');
        if (p && p.success === false) { endPrint(); toast('Could not open the print dialog.', 'error'); }
      }
    } catch (e) {
      endPrint();
      toast('Could not print: ' + errText(e), 'error');
    }
  }

  // Repaint when the QC list changes (another PC started it, the save landed).
  function subscribe() {
    var d = D();
    if (!d || typeof d.on !== 'function' || subscribe.done) return;
    subscribe.done = true;
    d.on('*', function (evs) {
      var kinds = Array.isArray(evs) ? evs : [String(evs || '')];
      if (isOpen() && kinds.indexOf('qc') !== -1) paint();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', subscribe);
  else subscribe();

  window.NeoQcBench = {
    open: open, close: close, isOpen: isOpen, printReport: printReport,
    reportHtml: function (id) { var r = reportFor(id); return r ? r.html : ''; },
    _summaryText: summaryText, _overall: overall, _results: results
  };
})();
