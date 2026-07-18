/*
  Neo QC — shared diagnostics rendering functions.

  Pure functions: given a slice of `ticket.diagnostics` (or a `ticket_ppi`
  Supabase row), return an HTML string. Used identically by the Electron
  admin modal, the technician "client extension" panel, the print/PDF
  report, and the customer dashboard — this is what makes those four
  surfaces show the same data instead of four independent re-implementations.

  Plain browser global (no build step, no module system) so it loads via a
  single <script src="shared/diagnostics-render.js"> tag. Depends on
  shared/icons.js (NeoQcIcons.iconSvg) being loaded first, and
  shared/diagnostics-tokens.css being linked for styling.

  Every function must degrade gracefully when its data argument is
  null/undefined/empty — most existing tickets predate these fields.
*/
(function (global) {
  var icon = (global.NeoQcIcons && global.NeoQcIcons.iconSvg) || function () { return ''; };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function statusPill(status, label) {
    var cls = 'dr-status-' + (status || 'unverified');
    var iconName = status === 'pass' ? 'check' : status === 'warn' ? 'warning' : status === 'fail' ? 'fail' : 'unverified';
    return '<span class="dr-pill ' + cls + '">' + icon(iconName) + '<span>' + esc(label || status || 'Unverified') + '</span></span>';
  }

  function emptyState(message) {
    return '<div class="dr-empty-state">' + esc(message) + '</div>';
  }

  // ─── Sparkline (lifted/generalized from app.js's buildSparkline) ──────

  function renderSparkline(data, threshold) {
    if (!data || data.length < 2) return '';
    var W = 300, H = 38, PAD = 4;
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
      '<line x1="' + PAD + '" y1="' + ty + '" x2="' + (W - PAD) + '" y2="' + ty + '" stroke="currentColor" stroke-opacity="0.35" stroke-width="0.8" stroke-dasharray="4,3"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ─── Prime95 panel ──────────────────────────────────────────────────

  function renderPrime95Panel(data) {
    if (!data || data.overallResult === 'not-run' || !data.overallResult) {
      return '<div class="dr-card">' +
        '<div class="dr-card-header">' + icon('torture') + '<span class="dr-card-title">Prime95 Torture Test (CPU + RAM)</span></div>' +
        emptyState('Not yet run for this build.') +
        '</div>';
    }
    var status = data.overallResult === 'pass' ? 'pass' : data.overallResult === 'aborted' ? 'warn' : 'fail';
    var workers = (data.workers || []).map(function (w) {
      var wStatus = w.result === 'pass' ? 'pass' : 'fail';
      return '<div class="dr-list-item">' +
        '<span>Worker #' + esc(w.id) + '</span>' +
        '<span class="dr-muted">' + esc(w.errors || 0) + ' error(s), ' + esc(w.roundingWarnings || 0) + ' warning(s)</span>' +
        statusPill(wStatus, w.result) +
        '</div>';
    }).join('');
    var errorLines = (data.errorSummary || []).map(function (line) {
      return '<div class="dr-list-item" style="color:var(--dr-status-fail);">' + esc(line) + '</div>';
    }).join('');
    var durationMin = data.durationActualSec ? Math.round(data.durationActualSec / 60) : null;

    return '<div class="dr-card">' +
      '<div class="dr-card-header">' + icon('torture') + '<span class="dr-card-title">Prime95 Torture Test (CPU + RAM, Blend mode)</span>' + statusPill(status, data.overallResult) + '</div>' +
      '<div class="dr-row"><span class="dr-row-label">Duration</span><span class="dr-row-value">' + (durationMin !== null ? durationMin + ' min' : '—') + '</span></div>' +
      '<div class="dr-row"><span class="dr-row-label">Workers</span><span class="dr-row-value">' + esc(data.workerCount || (data.workers || []).length || '—') + '</span></div>' +
      (workers ? '<div class="dr-list">' + workers + '</div>' : '') +
      (errorLines ? '<div class="dr-list">' + errorLines + '</div>' : '') +
      '</div>';
  }

  // ─── Component passport cards ───────────────────────────────────────

  var PASSPORT_META = {
    cpu: { icon: 'cpu', title: 'CPU' },
    gpu: { icon: 'gpu', title: 'GPU' },
    ram: { icon: 'ram', title: 'RAM' },
    storage: { icon: 'storage', title: 'Storage' }
  };

  function passportRows(type, data) {
    if (type === 'cpu') {
      return [
        ['Model', data.model],
        ['Cores / Threads', (data.cores != null && data.threads != null) ? (data.cores + ' / ' + data.threads) : null],
        ['Clock (base / boost)', (data.baseClockMHz || data.boostClockMHz) ? ((data.baseClockMHz || '—') + ' / ' + (data.boostClockMHz || '—') + ' MHz') : null],
        ['Max temp during test', data.tempMaxDuringTest != null ? data.tempMaxDuringTest + '°C' : null]
      ];
    }
    if (type === 'gpu') {
      return [
        ['Model', data.model],
        ['VRAM', data.vram],
        ['Driver', data.driverVersion],
        ['Max temp during test', data.tempMaxDuringTest != null ? data.tempMaxDuringTest + '°C' : null]
      ];
    }
    if (type === 'ram') {
      var modSummary = (data.modules || []).map(function (m) {
        return (m.capacityGB || '?') + 'GB @ ' + (m.speedMHz || '?') + 'MHz (' + (m.manufacturer || 'unknown') + ')';
      });
      return [
        ['Total capacity', data.totalGB != null ? data.totalGB + ' GB' : null],
        ['Generation', data.ddrGen],
        ['Modules', modSummary.length ? modSummary.join('; ') : null],
        ['Errors during Prime95', data.errorsDuringPrime95 != null ? data.errorsDuringPrime95 : null]
      ];
    }
    if (type === 'storage') {
      return [
        ['Model', data.model],
        ['Interface', data.interface || data.mediaType],
        ['Size', data.sizeGB != null ? data.sizeGB + ' GB' : null],
        ['Wear', data.wear != null ? data.wear + '%' : null],
        ['Life remaining', data.lifeRemaining != null ? data.lifeRemaining + '%' : null],
        ['Power-on hours (proxy for age)', data.powerOnHours != null ? data.powerOnHours + ' h' : null]
      ];
    }
    return [];
  }

  function passportStatus(type, data) {
    if (type === 'storage') {
      if (data.lifeRemaining != null && data.lifeRemaining < 10) return 'fail';
      if (data.lifeRemaining != null && data.lifeRemaining < 30) return 'warn';
      return data.healthStatus ? 'pass' : 'unverified';
    }
    if (type === 'ram') {
      if (data.errorsDuringPrime95 > 0) return 'fail';
      return data.errorsDuringPrime95 === 0 ? 'pass' : 'unverified';
    }
    if (type === 'cpu' || type === 'gpu') {
      if (data.throttled) return 'warn';
      return data.tempMaxDuringTest != null ? 'pass' : 'unverified';
    }
    return 'unverified';
  }

  function renderPassportCard(type, data) {
    var meta = PASSPORT_META[type] || { icon: 'unverified', title: type };
    if (!data) {
      return '<div class="dr-card">' +
        '<div class="dr-card-header">' + icon(meta.icon) + '<span class="dr-card-title">' + esc(meta.title) + '</span></div>' +
        emptyState('No data yet.') +
        '</div>';
    }
    var rows = passportRows(type, data).filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; });
    var status = passportStatus(type, data);
    var rowsHtml = rows.map(function (r) {
      return '<div class="dr-row"><span class="dr-row-label">' + esc(r[0]) + '</span><span class="dr-row-value">' + esc(r[1]) + '</span></div>';
    }).join('');
    var note = data.healthNote ? '<div class="dr-muted" style="margin-top:6px;">' + esc(data.healthNote) + '</div>' : '';

    return '<div class="dr-card">' +
      '<div class="dr-card-header">' + icon(meta.icon) + '<span class="dr-card-title">' + esc(meta.title) + '</span>' + statusPill(status) + '</div>' +
      (rowsHtml || emptyState('No details recorded.')) + note +
      '</div>';
  }

  function renderPassportGrid(componentPassport) {
    var cp = componentPassport || {};
    return '<div class="dr-grid">' +
      renderPassportCard('cpu', cp.cpu) +
      renderPassportCard('gpu', cp.gpu) +
      renderPassportCard('ram', cp.ram) +
      renderPassportCard('storage', cp.storage) +
      '</div>';
  }

  // ─── Port enumeration panel (v3 — passive) ──────────────────────────
  // Consumes ticket.diagnostics.portScan: { usbControllers, usbDevices,
  // usbDeviceCount, gpus, videoOutputs, audioControllers, audioEndpoints }.

  function portRow(a, b) {
    return '<div class="dr-list-item"><span>' + esc(a) + '</span>' +
      (b != null && b !== '' ? '<span class="dr-muted">' + esc(b) + '</span>' : '') + '</div>';
  }

  function portCard(title, rows) {
    return '<div class="dr-card">' +
      '<div class="dr-card-header">' + icon('port') + '<span class="dr-card-title">' + esc(title) + '</span></div>' +
      (rows.length ? '<div class="dr-list">' + rows.join('') + '</div>' : emptyState('None detected.')) +
      '</div>';
  }

  function renderPortCheckPanel(data) {
    if (!data) {
      return '<div class="dr-card"><div class="dr-card-header">' + icon('port') +
        '<span class="dr-card-title">System Ports</span></div>' + emptyState('Not yet scanned.') + '</div>';
    }
    var usb = (data.usbControllers || []).map(function (c) { return portRow(c.name, c.generation); });
    if (data.usbDeviceCount != null) {
      usb.push('<div class="dr-list-item dr-muted">' + data.usbDeviceCount + ' external USB device(s) connected</div>');
    }
    var video = (data.videoOutputs || []).map(function (o) { return portRow(o.connection, o.monitor); });
    (data.gpus || []).forEach(function (g) {
      video.unshift(portRow(g.name, [g.vramMB ? g.vramMB + ' MB' : null, g.resolution].filter(Boolean).join(' · ')));
    });
    var audio = (data.audioEndpoints || []).map(function (e) { return portRow(e, null); });
    return '<div class="dr-grid">' +
      portCard('USB Controllers & Generations', usb) +
      portCard('Video Outputs', video) +
      portCard('Audio Endpoints', audio) +
      '</div>';
  }

  // ─── RGB sync panel ─────────────────────────────────────────────────

  function renderRgbSyncPanel(data) {
    if (!data || !data.controllerFound) {
      return '<div class="dr-card">' +
        '<div class="dr-card-header">' + icon('rgb') + '<span class="dr-card-title">RGB Sync</span>' + statusPill('unverified', data ? 'Not detected' : 'Not checked') + '</div>' +
        emptyState('No RGB controller detected (OpenRGB).') +
        '</div>';
    }
    var devicesHtml = (data.devices || []).map(function (dev) {
      var zonesHtml = (dev.zones || []).map(function (z) {
        return '<div class="dr-list-item">' +
          '<span>' + esc(z.name) + '</span>' +
          '<span class="dr-row-value" style="display:flex;align-items:center;gap:6px;">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + esc(z.colorApplied || '#888') + ';border:1px solid var(--dr-border);"></span>' +
            statusPill(z.verified ? 'pass' : 'warn', z.verified ? 'Verified' : 'Applied, unconfirmed') +
          '</span>' +
          '</div>';
      }).join('');
      return '<div class="dr-card">' +
        '<div class="dr-card-header">' + icon('rgb') + '<span class="dr-card-title">' + esc(dev.name) + '</span></div>' +
        (zonesHtml ? '<div class="dr-list">' + zonesHtml + '</div>' : emptyState('No zones reported.')) +
        '</div>';
    }).join('');

    return '<div class="dr-grid">' + (devicesHtml || emptyState('No devices found.')) + '</div>';
  }

  // ─── PPI panel ──────────────────────────────────────────────────────

  function renderPpiPanel(row) {
    if (!row) {
      return '<div class="dr-card">' +
        '<div class="dr-card-header">' + icon('price-tag') + '<span class="dr-card-title">Price-to-Performance</span></div>' +
        emptyState('Not yet computed for this build.') +
        '</div>';
    }
    // Only CPU + GPU have objective (PassMark) benchmarks, so RAM/PSU/case/
    // motherboard/storage/cooler come back "unscored". That's expected, not an
    // error — collapse those into one calm note instead of a stack of ⚠ lines.
    // Positive notes ("best performer ✓") are dropped from the warning list.
    var benchUnscored = [];
    var realFlags = [];
    (row.flags || []).forEach(function (f) {
      var mm = /^([a-z]+): no objective benchmark exists/i.exec(f);
      if (mm) { benchUnscored.push(mm[1].toUpperCase()); return; }
      if (/best performer|best-in-band|✓/i.test(f)) return; // positive, not a warning
      realFlags.push(f);
    });
    var flags = realFlags.map(function (f) {
      var isBottleneck = /bottleneck|limiting/i.test(f);
      var isInfo = /price filled|filled from live retailer/i.test(f);
      var cls = isInfo ? ' dr-ppi-flag-info' : '';
      return '<div class="dr-ppi-flag' + cls + '">' + icon(isBottleneck ? 'bottleneck' : (isInfo ? 'price-tag' : 'warning')) + '<span>' + esc(f) + '</span></div>';
    }).join('');
    var benchNote = benchUnscored.length
      ? '<div class="dr-muted" style="margin-top:8px; font-size:0.72rem; line-height:1.5;">Index is scored on <strong>CPU + GPU</strong> (the components with objective benchmarks). ' + esc(benchUnscored.join(', ')) + ' have no performance benchmark, so they’re not counted — this is normal.</div>'
      : '';

    var comparisons = row.in_range_comparisons || row.inRangeComparisons || {};
    var stripCode = (typeof global !== 'undefined' && global.NeoQcMatcher && global.NeoQcMatcher.cleanName)
      ? global.NeoQcMatcher.cleanName : function (s) { return s; };
    var compHtml = Object.keys(comparisons).map(function (cat) {
      var entries = comparisons[cat] || [];
      if (!entries.length) return '';
      var rows = entries.map(function (e) {
        var deltaSign = (e.delta_vs_own || e.deltaVsOwn || 0) >= 0 ? '+' : '';
        return '<div class="dr-list-item"><span>' + esc(stripCode(e.name)) + '</span><span class="dr-muted">₹' + esc(e.price_inr || e.priceInr) + ' &middot; ' + deltaSign + esc(e.delta_vs_own || e.deltaVsOwn) + ' pts</span></div>';
      }).join('');
      return '<div class="dr-muted" style="margin-top:8px;">' + esc(cat.toUpperCase()) + ' alternatives at this price</div><div class="dr-list">' + rows + '</div>';
    }).join('');

    // NOTE: no `a || b` here — a fit score of exactly 0 is falsy, and the old
    // fallback chain turned it into undefined → "NaN%" on the panel.
    var fitRaw = row.customer_fit_score != null ? row.customer_fit_score : row.customerFitScore;
    var fitPct = fitRaw != null ? Math.round(fitRaw * 100) : null;

    return '<div class="dr-card">' +
      '<div class="dr-card-header">' + icon('price-tag') + '<span class="dr-card-title">Price-to-Performance Index</span></div>' +
      '<div class="dr-ppi-index">' + esc(row.index != null ? row.index : '—') + '<span class="dr-muted" style="font-size:0.4em;"> / 100</span></div>' +
      (fitPct !== null ? '<div class="dr-row"><span class="dr-row-label">' + icon('target') + ' Fit for selected use-case</span><span class="dr-row-value">' + fitPct + '%</span></div>' : '') +
      (row.use_cases || row.useCases ? '<div class="dr-row"><span class="dr-row-label">Use-case</span><span class="dr-row-value">' + esc((row.use_cases || row.useCases || []).map(function (u) { return String(u).replace(/-/g, ' ').toUpperCase(); }).join(', ')) + '</span></div>' : '') +
      (flags || '') +
      (benchNote || '') +
      (compHtml || '') +
      '</div>';
  }

  var api = {
    esc: esc,
    statusPill: statusPill,
    emptyState: emptyState,
    renderSparkline: renderSparkline,
    renderPrime95Panel: renderPrime95Panel,
    renderPassportCard: renderPassportCard,
    renderPassportGrid: renderPassportGrid,
    renderPortCheckPanel: renderPortCheckPanel,
    renderRgbSyncPanel: renderRgbSyncPanel,
    renderPpiPanel: renderPpiPanel
  };

  // ALWAYS set the browser global when a window exists (Electron UMD gotcha
  // — see shared/matcher.js). Node require() still gets module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcDiagnosticsRender = api;
  }
})(typeof window !== 'undefined' ? window : this);
