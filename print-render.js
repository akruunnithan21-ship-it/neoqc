/*
  print-render.js — populates the three-page QC / stress / info report
  (#print-report-container in index.html, styled by print-report.css).

  Deliberately Electron-free (no require/ipcRenderer/appState): everything it
  needs is passed in, so the exact same code runs in a plain-browser test
  harness. app.js's populatePrintFields() is now a thin wrapper around
  NeoQcPrintRender.populate(ticket, settings, ppiRow).

  Report philosophy (what makes this report different):
    • Every number is labelled by origin — measured on THIS unit, shop QC
      policy threshold, or public reference data. Nothing is implied.
    • Nothing is ever silently guessed: sections without real data say so
      ("not run", "not scored") instead of showing an optimistic default.
    • The integrity code lets anyone re-print the same ticket and confirm
      the two documents describe the same results.
*/
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function setAllByClass(cls, value) {
    var els = document.getElementsByClassName(cls);
    for (var i = 0; i < els.length; i++) els[i].textContent = value;
  }

  function show(id) { var el = $(id); if (el) el.classList.remove('hidden'); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    return v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '--';
  }

  function badge(pass) {
    return pass
      ? '<span class="print-pass-badge">&#x2713; PASS</span>'
      : '<span class="print-fail-badge">&#x2717; FAIL</span>';
  }

  // ─── Sparkline (unchanged from the old app.js implementation) ─────────

  function buildSparkline(data, threshold) {
    if (!data || data.length < 2) return '';
    var W = 300, H = 28, PAD = 4;
    var min = Math.min.apply(null, data) - 2;
    var max = Math.max.apply(null, data.concat([threshold])) + 2;
    var xStep = (W - PAD * 2) / (data.length - 1);
    var yScale = (H - PAD * 2) / (max - min);
    var pts = data.map(function (v, i) {
      var x = PAD + i * xStep;
      var y = H - PAD - (v - min) * yScale;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var ty = (H - PAD - (threshold - min) * yScale).toFixed(1);
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;">' +
      '<line x1="' + PAD + '" y1="' + ty + '" x2="' + (W - PAD) + '" y2="' + ty + '" stroke="#bbb" stroke-width="0.8" stroke-dasharray="4,3"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ─── Ghosted measured-vs-reference horizontal bar ─────────────────────

  // ghost = the reference (threshold) drawn as a hatched underlay; fill = the
  // measured value. Both scale against the larger of the two so a big beat
  // and a big miss are both visible at a glance.
  function barRow(label, measured, reference, unit, pass) {
    var maxV = Math.max(measured, reference) * 1.1 || 1;
    var ghostPct = Math.min(100, reference / maxV * 100);
    var fillPct = Math.min(100, measured / maxV * 100);
    return '<div class="print-bar-row">' +
      '<span class="print-bar-label">' + esc(label) + '</span>' +
      '<span class="print-bar-track">' +
        '<span class="print-bar-ghost" style="width:' + ghostPct.toFixed(1) + '%"></span>' +
        '<span class="print-bar-fill' + (pass ? ' accent' : '') + '" style="width:' + fillPct.toFixed(1) + '%;opacity:0.85;"></span>' +
      '</span>' +
      '<span class="print-bar-value">' + measured.toLocaleString() + ' / ' + reference.toLocaleString() + ' ' + esc(unit) + '</span>' +
      '</div>';
  }

  // ─── FNV-1a 32-bit — report integrity code ────────────────────────────

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ─── Checklist ────────────────────────────────────────────────────────

  function checklistItems(ticket) {
    var getBuildCheck = function (p) { return (ticket.buildChecks && ticket.buildChecks[p]) || false; };
    var getQcCheck = function (p) { return (ticket.qcChecks && ticket.qcChecks[p]) || false; };
    return [
      { checked: getQcCheck('physCabinet'), label: 'Physical Condition Clean & Checked' },
      { checked: getQcCheck('physMobo'), label: 'Motherboard Socket & CPU Pins Checked' },
      { checked: getQcCheck('physRam'), label: 'RAM Modules Correctly Installed' },
      { checked: getBuildCheck('cooler'), label: 'CPU Cooler / AIO Thermal Assembly Secured' },
      { checked: getBuildCheck('cables'), label: 'Structural Cables Organized & Zip-tied' },
      { checked: getBuildCheck('posted'), label: 'System Posted successfully to BIOS' },
      { checked: getQcCheck('softWindows'), label: 'Windows OS Installed & Fully Licensed' },
      { checked: getQcCheck('softDrivers'), label: 'System Hardware Drivers Updated' },
      { checked: getQcCheck('softBios'), label: 'Motherboard BIOS Updated' },
      { checked: getQcCheck('portUsb'), label: 'Front/Rear USB Ports Functional' },
      { checked: getQcCheck('portVideo'), label: 'HDMI & DisplayPort Output Verified' },
      { checked: getQcCheck('portAudio'), label: 'Audio Port Sound Jack Checked' },
      { checked: getQcCheck('portWifi'), label: 'Wi-Fi Antenna Mounted & Calibrated' }
    ];
  }

  function populateChecklist(ticket) {
    var qcContainer = $('print-checklist-container');
    var items = checklistItems(ticket);
    if (qcContainer) {
      qcContainer.innerHTML = items.map(function (item) {
        return '<div class="print-chk-item">' + (item.checked ? '✔️' : '❌') + ' ' + item.label + '</div>';
      }).join('');
    }
    return items;
  }

  // ─── Main populate ────────────────────────────────────────────────────

  function populate(ticket, settings, ppiRow) {
    settings = settings || {};
    var d = ticket.diagnostics || {};
    var specs = ticket.specs || {};
    var serials = ticket.serials || {};

    var checklist = populateChecklist(ticket);

    // ── Header ──
    var shortId = ticket.id.slice(-6).toUpperCase();
    setText('print-ticket-id', shortId);
    setAllByClass('print-ticket-id-echo', shortId);
    setText('print-build-type', ticket.buildType || ticket.jobType || 'PC Assembly');
    setText('print-date', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
    setText('print-tech', ticket.technician || '--');
    setText('print-shop-contact', settings.shopContact || '');

    // ── Customer & Job ──
    setText('print-customer-name', ticket.customerName || '--');
    setText('print-job-type', ticket.buildType || ticket.jobType || '--');
    setText('print-status', ticket.status || '--');
    setText('print-created-at', fmtDate(ticket.createdAt));
    setText('print-deadline', fmtDate(ticket.deadline));
    setText('print-completed-at', fmtDate(ticket.completedAt));

    // ── Windows ──
    setText('print-win-status', ticket.windowsActivation || d.windowsActivation || '--');
    setText('print-win-key', ticket.windowsKey || d.windowsKey || '--');

    // ── Hardware Specs ──
    setText('print-spec-cpu', specs.cpu || '--');
    setText('print-spec-igpu', specs.igpu || 'None / Integrated');
    setText('print-spec-gpu', specs.gpu || '--');
    setText('print-spec-ram', specs.ram || '--');
    setText('print-spec-storage', specs.storage || '--');
    setText('print-spec-mobo', specs.mobo || specs.motherboard || '--');
    setText('print-spec-cooler', specs.cooler || specs.coolerModel || '--');
    setText('print-spec-psu', specs.psu || '--');
    setText('print-spec-case', specs.case || specs.cabinet || '--');

    setText('print-serial-gpu', serials.gpu || '—');
    setText('print-serial-ram', serials.ram || '—');
    setText('print-serial-ssd', serials.ssd || '—');
    setText('print-serial-mobo', serials.mobo || serials.motherboard || '—');
    setText('print-serial-cabinet', serials.cabinet || '—');

    var missingParts = ticket.missingParts || ticket.pendingParts || '';
    if (missingParts && $('print-missing-parts')) {
      setText('print-missing-parts-text', missingParts);
      show('print-missing-parts');
    }

    // ── Thresholds (shop QC policy, from settings) ──
    var cpuThresh = settings.cpuMaxTemp || 85;
    var gpuThresh = settings.gpuMaxTemp || 80;
    var cbThresh = settings.minCinebench || 10000;
    var fmThresh = settings.minFurmark || 5000;
    var readThresh = settings.minSsdRead || 3000;
    var writeThresh = settings.minSsdWrite || 2500;

    // ── Thermals ──
    var cpuMin = d.cpuTempMin != null ? d.cpuTempMin : null;
    var cpuMax = d.cpuTempMax != null ? d.cpuTempMax : null;
    var cpuAvg = d.cpuTempAvg != null ? d.cpuTempAvg : null;
    var gpuMin = d.gpuTempMin != null ? d.gpuTempMin : null;
    var gpuMax = d.gpuTempMax != null ? d.gpuTempMax : null;
    var gpuAvg = d.gpuTempAvg != null ? d.gpuTempAvg : null;

    var cpuPass = cpuMax !== null ? cpuMax <= cpuThresh : null;
    var gpuPass = gpuMax !== null ? gpuMax <= gpuThresh : null;
    var ramPass = d.ramStress === 'passed' || d.ramStress === true;

    setText('print-cpu-min', cpuMin !== null ? cpuMin + ' °C' : '--');
    setText('print-cpu-avg', cpuAvg !== null ? cpuAvg + ' °C' : '--');
    setText('print-cpu-max', cpuMax !== null ? cpuMax + ' °C' : '--');
    setText('print-gpu-min', gpuMin !== null ? gpuMin + ' °C' : '--');
    setText('print-gpu-avg', gpuAvg !== null ? gpuAvg + ' °C' : '--');
    setText('print-gpu-max', gpuMax !== null ? gpuMax + ' °C' : '--');
    setText('print-cpu-thresh', '≤ ' + cpuThresh + ' °C');
    setText('print-gpu-thresh', '≤ ' + gpuThresh + ' °C');
    if ($('print-cpu-result')) $('print-cpu-result').innerHTML = cpuPass !== null ? badge(cpuPass) : '--';
    if ($('print-gpu-result')) $('print-gpu-result').innerHTML = gpuPass !== null ? badge(gpuPass) : '--';

    setText('print-ram-detail', d.ramDetail || (d.ramStress !== undefined ? String(d.ramStress) : '--'));
    if ($('print-ram-result')) $('print-ram-result').innerHTML = d.ramStress !== undefined ? badge(ramPass) : '--';

    // ── Sparklines ──
    var cpuLog = d.cpuTempLog || [];
    var gpuLog = d.gpuTempLog || [];
    if (cpuLog.length > 1 || gpuLog.length > 1) {
      show('print-sparklines');
      if ($('print-cpu-sparkline') && cpuLog.length > 1) $('print-cpu-sparkline').innerHTML = buildSparkline(cpuLog, cpuThresh);
      if ($('print-gpu-sparkline') && gpuLog.length > 1) $('print-gpu-sparkline').innerHTML = buildSparkline(gpuLog, gpuThresh);
    }

    // ── Benchmarks ──
    var cb = d.cinebench != null ? d.cinebench : (d.cinebenchScore != null ? d.cinebenchScore : null);
    var fm = d.furmark != null ? d.furmark : (d.furmarkScore != null ? d.furmarkScore : null);
    var ssdR = d.ssdRead != null ? d.ssdRead : null;
    var ssdW = d.ssdWrite != null ? d.ssdWrite : null;

    var cbPass = cb !== null ? cb >= cbThresh : null;
    var fmPass = fm !== null ? fm >= fmThresh : null;
    var readPass = ssdR !== null ? ssdR >= readThresh : null;
    var writePass = ssdW !== null ? ssdW >= writeThresh : null;

    setText('print-score-cb', cb !== null ? cb.toLocaleString() + ' pts' : '--');
    setText('print-score-fm', fm !== null ? fm.toLocaleString() + ' pts' : '--');
    setText('print-score-read', ssdR !== null ? ssdR.toLocaleString() + ' MB/s' : '--');
    setText('print-score-write', ssdW !== null ? ssdW.toLocaleString() + ' MB/s' : '--');
    setText('print-thresh-cb', '≥ ' + cbThresh.toLocaleString() + ' pts');
    setText('print-thresh-fm', '≥ ' + fmThresh.toLocaleString() + ' pts');
    setText('print-thresh-read', '≥ ' + readThresh.toLocaleString() + ' MB/s');
    setText('print-thresh-write', '≥ ' + writeThresh.toLocaleString() + ' MB/s');
    if ($('print-result-cb')) $('print-result-cb').innerHTML = cbPass !== null ? badge(cbPass) : '--';
    if ($('print-result-fm')) $('print-result-fm').innerHTML = fmPass !== null ? badge(fmPass) : '--';
    if ($('print-result-read')) $('print-result-read').innerHTML = readPass !== null ? badge(readPass) : '--';
    if ($('print-result-write')) $('print-result-write').innerHTML = writePass !== null ? badge(writePass) : '--';

    // ── Ghosted measured-vs-threshold bars ──
    var barsEl = $('print-bench-bars');
    if (barsEl) {
      var rows = [];
      if (cb !== null) rows.push(barRow('Cinebench R23 (measured vs QC minimum)', cb, cbThresh, 'pts', cbPass));
      if (fm !== null) rows.push(barRow('FurMark GPU (measured vs QC minimum)', fm, fmThresh, 'pts', fmPass));
      if (ssdR !== null) rows.push(barRow('SSD sequential read (measured vs QC minimum)', ssdR, readThresh, 'MB/s', readPass));
      if (ssdW !== null) rows.push(barRow('SSD sequential write (measured vs QC minimum)', ssdW, writeThresh, 'MB/s', writePass));
      if (rows.length) {
        barsEl.innerHTML = '<div class="print-bar-row"><span class="print-bar-label" style="color:#888;">Solid bar = measured on this unit · hatched = QC minimum</span></div>' + rows.join('');
        barsEl.classList.remove('hidden');
      }
    }

    // ── SSD health ──
    var ssdH = d.ssdHealth;
    if (ssdH && !ssdH.error) {
      show('print-ssd-health-section');
      setText('print-ssd-model', ssdH.model || '--');
      setText('print-ssd-type', ssdH.mediaType || '--');
      setText('print-ssd-health', ssdH.healthStatus || '--');
      setText('print-ssd-life', ssdH.lifeRemaining != null ? ssdH.lifeRemaining + '%' : 'N/A');
      setText('print-ssd-hours', ssdH.powerOnHours != null ? ssdH.powerOnHours + ' hrs' : 'N/A');
      setText('print-ssd-size', ssdH.size ? Math.round(ssdH.size / 1e9) + ' GB' : '--');
    }

    // ── Prime95 ──
    var p95 = d.prime95;
    var p95Pass = null;
    if (p95 && p95.overallResult && p95.overallResult !== 'not-run') {
      show('print-prime95-section');
      p95Pass = p95.overallResult === 'pass';
      if ($('print-p95-result')) $('print-p95-result').innerHTML = badge(p95Pass) + (p95.overallResult === 'aborted' ? ' (aborted early)' : '');
      setText('print-p95-duration', p95.durationActualSec ? Math.round(p95.durationActualSec / 60) + ' min (Blend)' : '--');
      setText('print-p95-workers', p95.workerCount || (p95.workers || []).length || '--');
      var errCount = (p95.workers || []).reduce(function (s, w) { return s + (w.errors || 0); }, 0);
      var warnCount = (p95.workers || []).reduce(function (s, w) { return s + (w.roundingWarnings || 0); }, 0);
      setText('print-p95-errors', errCount + ' error(s), ' + warnCount + ' warning(s)');
      if ($('print-p95-error-lines')) {
        $('print-p95-error-lines').innerHTML = (p95.errorSummary || []).slice(0, 5).map(function (l) { return '<div>• ' + esc(l) + '</div>'; }).join('');
      }
    }

    // ── Component passport ──
    var cp = d.componentPassport;
    if (cp && $('print-passport-body')) {
      show('print-passport-section');
      var prows = [];
      if (cp.cpu) prows.push(['CPU', (cp.cpu.model || '--') + ' — ' + (cp.cpu.cores || '?') + 'C/' + (cp.cpu.threads || '?') + 'T',
        cp.cpu.throttled ? 'THERMAL THROTTLE' : (cp.cpu.healthNote || (cp.cpu.tempMaxDuringTest != null ? 'OK, max ' + cp.cpu.tempMaxDuringTest + '°C under load' : 'Not tested'))]);
      if (cp.gpu) prows.push(['GPU', (cp.gpu.model || '--') + (cp.gpu.vram ? ' — ' + cp.gpu.vram : ''),
        cp.gpu.throttled ? 'THERMAL THROTTLE' : (cp.gpu.tempMaxDuringTest != null ? 'OK, max ' + cp.gpu.tempMaxDuringTest + '°C under load' : 'Not tested')]);
      if (cp.ram) prows.push(['RAM', (cp.ram.totalGB || '?') + ' GB ' + (cp.ram.ddrGen || '') + ' (' + (cp.ram.modules || []).length + ' module(s))',
        cp.ram.errorsDuringPrime95 > 0 ? cp.ram.errorsDuringPrime95 + ' ERROR(S) in torture test' : (cp.ram.healthNote || 'Not tested')]);
      if (cp.storage) prows.push(['Storage', (cp.storage.model || '--') + ' — ' + (cp.storage.interface || cp.storage.mediaType || '') + ' ' + (cp.storage.sizeGB || '?') + ' GB',
        cp.storage.lifeRemaining != null ? (cp.storage.healthStatus || 'OK') + ', ' + cp.storage.lifeRemaining + '% life' + (cp.storage.powerOnHours != null ? ', ' + cp.storage.powerOnHours + ' h powered on' : '') : (cp.storage.healthStatus || '--')]);
      $('print-passport-body').innerHTML = prows.map(function (r) {
        return '<tr><td><strong>' + r[0] + '</strong></td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
      }).join('');
    }

    // ── Port & connectivity verification ──
    var PORT_LABELS = { usb: 'USB Ports', video: 'Video Outputs (HDMI/DP)', audio: 'Audio Jacks', network: 'Network / Wi-Fi' };
    var pc = d.portCheckV2;
    if (pc && pc.categories && Object.keys(pc.categories).length && $('print-ports-body')) {
      show('print-ports-section');
      $('print-ports-body').innerHTML = Object.keys(pc.categories).map(function (k) {
        var c = pc.categories[k] || {};
        var devs = (c.newDevicesDetected && c.newDevicesDetected.length ? c.newDevicesDetected : (c.afterDevices || []))
          .map(function (dv) { return dv.name || dv; }).slice(0, 2).join(', ');
        var result = c.status === 'pass' ? '✔ Verified' : (c.status === 'fail' ? '✗ Failed' : '— Unverified');
        return '<tr><td>' + esc(PORT_LABELS[k] || k) + '</td><td>' + result + '</td><td>' + esc(devs || '—') + '</td></tr>';
      }).join('');
    }

    // ── PPI (page 3) ──
    if (ppiRow && ppiRow.index != null) {
      show('print-ppi-section');
      setText('print-ppi-index', String(ppiRow.index));
      setText('print-ppi-fit', ppiRow.customer_fit_score != null ? Math.round(ppiRow.customer_fit_score * 100) + '%' : '--');
      setText('print-ppi-usecases', (ppiRow.use_cases || []).join(', ') || '--');

      // per-component bars — scored categories get a ratio-to-best bar,
      // unscored ones are listed honestly instead of hidden
      var pcs = ppiRow.per_component_scores || {};
      var compBars = [];
      var unscored = [];
      Object.keys(pcs).forEach(function (cat) {
        var v = pcs[cat];
        if (v == null) { unscored.push(cat.toUpperCase()); return; }
        compBars.push(barRow(cat.toUpperCase() + ' — % of best at this price', v, 100, '', v >= 99.95));
      });
      var compEl = $('print-ppi-component-bars');
      if (compEl && compBars.length) {
        var un = unscored.length
          ? '<div class="print-bar-row"><span class="print-bar-label" style="color:#888;">Not scored (no objective benchmark): ' + esc(unscored.join(', ')) + '</span></div>'
          : '';
        compEl.innerHTML = compBars.join('') + un;
        compEl.classList.remove('hidden');
      }

      // same-price alternatives table
      var comps = ppiRow.in_range_comparisons || {};
      var altRows = [];
      Object.keys(comps).forEach(function (cat) {
        (comps[cat] || []).slice(0, 3).forEach(function (e) {
          var delta = e.delta_vs_own != null ? e.delta_vs_own : 0;
          altRows.push('<tr><td>' + esc(e.name) + '</td><td>' + esc(cat.toUpperCase()) + '</td><td>₹' +
            (e.price_inr != null ? Math.round(e.price_inr).toLocaleString('en-IN') : '--') + '</td><td>' +
            (delta >= 0 ? '+' : '') + delta + ' pts</td></tr>');
        });
      });
      if (altRows.length && $('print-ppi-alt-body')) {
        $('print-ppi-alt-body').innerHTML = altRows.join('');
        show('print-ppi-alternatives');
      }

      if ($('print-ppi-flags')) {
        $('print-ppi-flags').innerHTML = (ppiRow.flags || []).map(function (f) { return '<div>⚠ ' + esc(f) + '</div>'; }).join('');
      }
    }

    // ── Activity log ──
    var events = ticket.events || ticket.activityLog || [];
    if (events.length > 0 && $('print-event-log-body')) {
      show('print-event-log-section');
      var recent = events.slice(-10).reverse();
      $('print-event-log-body').innerHTML = recent.map(function (ev) {
        return '<tr><td>' + (ev.timestamp ? new Date(ev.timestamp).toLocaleString('en-IN') : '--') + '</td><td>' +
          esc(ev.message || ev.event || '--') + '</td><td>' + esc(ev.by || ev.user || ev.technician || '--') + '</td></tr>';
      }).join('');
    }

    // ── Overall verdict ──
    var knownPasses = [];
    if (cpuPass !== null) knownPasses.push(cpuPass);
    if (gpuPass !== null) knownPasses.push(gpuPass);
    if (d.ramStress !== undefined) knownPasses.push(ramPass);
    if (cbPass !== null) knownPasses.push(cbPass);
    if (fmPass !== null) knownPasses.push(fmPass);
    if (readPass !== null) knownPasses.push(readPass);
    if (writePass !== null) knownPasses.push(writePass);
    if (p95Pass !== null) knownPasses.push(p95Pass);
    var overallPass = knownPasses.length === 0 ? null : knownPasses.every(Boolean);

    var verdictBanner = $('print-verdict-banner');
    var verdictIcon = $('print-verdict-icon');
    var verdictText = $('print-verdict-text');
    var stampBox = $('print-stamp-box');

    if (overallPass === null) {
      if (verdictBanner) verdictBanner.className = 'print-verdict-banner print-verdict-neutral';
      if (verdictIcon) verdictIcon.textContent = '◎';
      if (verdictText) verdictText.textContent = 'DIAGNOSTICS PENDING — AWAITING TEST COMPLETION';
      if (stampBox) { stampBox.textContent = 'PENDING'; stampBox.className = 'stamp-box stamp-pending'; }
    } else if (overallPass) {
      if (verdictBanner) verdictBanner.className = 'print-verdict-banner print-verdict-pass';
      if (verdictIcon) verdictIcon.textContent = '✓';
      if (verdictText) verdictText.textContent = 'ALL QUALITY CHECKS PASSED — SYSTEM CLEARED FOR HANDOFF';
      if (stampBox) { stampBox.textContent = 'QC APPROVED'; stampBox.className = 'stamp-box stamp-pass'; }
    } else {
      if (verdictBanner) verdictBanner.className = 'print-verdict-banner print-verdict-fail';
      if (verdictIcon) verdictIcon.textContent = '✗';
      if (verdictText) verdictText.textContent = 'ONE OR MORE CHECKS FAILED — REVIEW REQUIRED BEFORE HANDOFF';
      if (stampBox) { stampBox.textContent = 'QC FAILED'; stampBox.className = 'stamp-box stamp-fail'; }
    }

    // ── Score strip (page 1, at-a-glance) ──
    var checked = checklist.filter(function (i) { return i.checked; }).length;
    setText('print-tile-qc', checked + ' / ' + checklist.length);

    if (p95 && p95.overallResult && p95.overallResult !== 'not-run') {
      setText('print-tile-stress', p95Pass ? 'PASS' : 'FAIL');
      setText('print-tile-stress-sub', 'Prime95 Blend, ' + (p95.durationActualSec ? Math.round(p95.durationActualSec / 60) + ' min' : '--'));
    } else {
      setText('print-tile-stress', '—');
      setText('print-tile-stress-sub', 'not run');
    }

    var headrooms = [];
    if (cpuMax !== null) headrooms.push(cpuThresh - cpuMax);
    if (gpuMax !== null) headrooms.push(gpuThresh - gpuMax);
    if (headrooms.length) {
      var minHead = Math.min.apply(null, headrooms);
      setText('print-tile-thermal', (minHead >= 0 ? '+' : '') + minHead + ' °C');
      setText('print-tile-thermal-sub', 'below QC limit under load');
    } else {
      setText('print-tile-thermal', '—');
      setText('print-tile-thermal-sub', 'not measured');
    }

    setText('print-tile-ppi', ppiRow && ppiRow.index != null ? String(ppiRow.index) : '—');
    setText('print-tile-fit', ppiRow && ppiRow.customer_fit_score != null ? Math.round(ppiRow.customer_fit_score * 100) + '%' : '—');
    setText('print-tile-fit-sub', ppiRow && ppiRow.use_cases ? (ppiRow.use_cases || []).join(', ') : '');

    // ── Provenance (page 3) ──
    var prov = [];
    var measured = [];
    if (cb !== null) measured.push('Cinebench R23');
    if (fm !== null) measured.push('FurMark');
    if (cpuMax !== null || gpuMax !== null) measured.push('load temperatures');
    if (ssdR !== null || ssdW !== null) measured.push('SSD speed');
    if (p95 && p95.overallResult && p95.overallResult !== 'not-run') measured.push('Prime95 torture test');
    if (ssdH && !ssdH.error) measured.push('S.M.A.R.T. drive health');
    if (pc && pc.categories && Object.keys(pc.categories).length) measured.push('guided port verification');
    prov.push('<strong>Measured on this exact unit</strong> by NeoQC diagnostics on ' +
      new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ': ' +
      (measured.length ? measured.join(', ') : 'no automated tests recorded') + '.');
    prov.push('<strong>Pass/fail thresholds</strong> are Neo Tokyo\'s own QC policy (configured in shop settings), not manufacturer marketing figures.');
    if (ppiRow && ppiRow.index != null) {
      prov.push('<strong>Price-to-performance</strong> compares your parts only against alternatives available at the same price (±' +
        Math.round((ppiRow.price_band_pct || 0.15) * 100) + '%): reference performance from PassMark® (passmark.com, attribution required), ' +
        'prices from pcstudio.in and live Indian retailer lookups. Components with no objective benchmark are left unscored — never guessed.');
    }
    prov.push('<strong>Nothing on this report is auto-passed.</strong> Tests that were not run say "not run"; ports that were not physically verified say "unverified".');
    if ($('print-provenance')) $('print-provenance').innerHTML = prov.map(function (p) { return '<div style="margin-bottom:3px;">' + p + '</div>'; }).join('');

    // ── Integrity code ──
    var canonical = JSON.stringify({
      id: ticket.id, cb: cb, fm: fm, ssdR: ssdR, ssdW: ssdW,
      cpuMax: cpuMax, gpuMax: gpuMax, ram: d.ramStress != null ? d.ramStress : null,
      p95: p95 ? p95.overallResult : null,
      ppi: ppiRow ? ppiRow.index : null,
      verdict: overallPass
    });
    var h = fnv1a(canonical);
    setText('print-integrity-code', 'NT-' + h.slice(0, 4).toUpperCase() + '-' + h.slice(4).toUpperCase());

    // ── Footer ──
    setText('print-footer-tech', ticket.technician || '--');
    setText('print-footer-contact', settings.shopContact || 'Neo Tokyo Kochi QA Lab');
  }

  var api = { populate: populate, buildSparkline: buildSparkline };
  // ALWAYS set the browser global when a window exists (Electron UMD gotcha
  // — see shared/matcher.js). The either/or version of this block is exactly
  // why installed v1.3.0 printed an all-dashes skeleton report: `module` is
  // defined in the Electron renderer, so window.NeoQcPrintRender was never
  // set and populatePrintFields() bailed out silently.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcPrintRender = api;
  }
})(typeof window !== 'undefined' ? window : this);
