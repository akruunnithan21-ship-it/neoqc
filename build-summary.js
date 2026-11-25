/*
  Neo Service 1.16 — the build summary page (QC → New builds).

  Owner, 25 Nov 2026: "make the qc page redesign too with clicking on the
  ticket opens up a fullscreen summary with the edit button on the top right".
  A click on a build card opens this read-only page; Edit opens the full
  ticket form (app.js openTicketModal), where every change is made. Modelled
  on the Service / RMA summary (ticket-summary.js): header with Edit top
  right, the status band (steps, now, deadline), details on the left and
  status, flags and activity on the right.

  The steps come from the ticket's own fields, the same ones the board and
  the auto-complete in renderDashboard() read:
    Booked → Parts → Assembly → QC checks → Stress test → Done
  status 'awaiting' = Parts, 'building' = Assembly, 'waiting_qc' = QC checks,
  'qc_testing' = QC checks until all 11 are ticked, then Stress test until it
  is signed off, then Done; 'completed' = every step done.

  Reads appState.tickets only; writes nothing.
  window.NeoBuildSummary = { open(ticketId), close(), isOpen() }.
*/
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fn(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function allTickets() {
    try { return (typeof appState !== 'undefined' && appState && Array.isArray(appState.tickets)) ? appState.tickets : []; }
    catch (e) { return []; }
  }
  function findTicket(id) {
    var list = allTickets();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  // ── dates ───────────────────────────────────────────────────────────────
  // Real instants (created, events, completed) show in local time. The
  // deadline is a wall time stored as UTC (app.js saves the form value + 'Z'
  // and formatDateShort reads it back with UTC getters), so it is read the
  // same way here, or it would drift by the time zone.
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ms(v) { if (!v) return null; var t = Date.parse(v); return isNaN(t) ? null : t; }
  function hm(h, m) { return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' am' : ' pm'); }
  function fmtDate(v) {
    var t = ms(v); if (t == null) return '';
    var d = new Date(t);
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtWhen(v) {
    var t = ms(v); if (t == null) return '';
    var d = new Date(t);
    return d.getDate() + ' ' + MON[d.getMonth()] + ', ' + hm(d.getHours(), d.getMinutes());
  }
  function fmtDeadline(v) {
    var t = ms(v); if (t == null) return '';
    var d = new Date(t);
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ', ' + hm(d.getUTCHours(), d.getUTCMinutes());
  }
  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h) return h + ' h' + (m ? ' ' + m + ' min' : '');
    return Math.max(1, m) + ' min';
  }
  function num(v) { var n = Number(v); return isFinite(n) && n !== 0 ? n : null; }
  function int(v) { var n = num(v); return n == null ? '' : Math.round(n).toLocaleString('en-IN'); }
  function showPhone(p) {
    var n = String(p || '').replace(/\D/g, '');
    if (n.length === 12 && n.indexOf('91') === 0) return '+91 ' + n.slice(2, 7) + ' ' + n.slice(7);
    if (n.length === 10) return n.slice(0, 5) + ' ' + n.slice(5);
    return p || '';
  }
  function first(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }

  // ── the ticket's own numbers (same rules as app.js) ─────────────────────
  var BUILD_CHECKS = [
    ['cpuRamSsd', 'CPU, RAM and SSD seated'],
    ['moboCase', 'Motherboard in the case'],
    ['cooler', 'Cooler installed'],
    ['cables', 'Cable management'],
    ['posted', 'Posted to BIOS']
  ];
  var QC_GROUPS = [
    ['Physical', [['physCabinet', 'Cabinet scratch-free'], ['physMobo', 'Socket and pins OK'], ['physRam', 'RAM checked and clean'], ['physScrews', 'All screws secured']]],
    ['Software', [['softWindows', 'Windows activated'], ['softDrivers', 'Drivers installed'], ['softBios', 'BIOS up to date']]],
    ['Ports', [['portUsb', 'USB ports'], ['portVideo', 'HDMI and DP outputs'], ['portAudio', 'Audio in and out'], ['portWifi', 'Wi-Fi antenna']]]
  ];
  function countChecks(obj, keys) {
    var n = 0; obj = obj || {};
    keys.forEach(function (k) { if (obj[k]) n++; });
    return n;
  }
  var QC_KEYS = [];
  QC_GROUPS.forEach(function (g) { g[1].forEach(function (c) { QC_KEYS.push(c[0]); }); });
  var BUILD_KEYS = BUILD_CHECKS.map(function (c) { return c[0]; });

  function buildPct(t) { var f = fn('calculateBuildPercentage'); return f ? Math.round(f(t) || 0) : Math.round(countChecks(t.buildChecks, BUILD_KEYS) / 5 * 100); }
  function qcPct(t) { var f = fn('calculateQcPercentage'); return f ? Math.round(f(t) || 0) : Math.round(countChecks(t.qcChecks, QC_KEYS) / QC_KEYS.length * 100); }
  function statusLabel(s) { var f = fn('getStatusLabelText'); return f ? f(s) : s; }
  function risk(t) {
    if (!t || t.status === 'completed') return '';
    var f = fn('deadlineRisk'); return f ? f(t.deadline) : '';
  }
  function countdown(t) { var f = fn('deadlineCountdown'); return f ? f(t.deadline) : ''; }
  function techInfo(t) {
    var f = fn('buildTechInfo');
    if (f) { try { return f(t); } catch (e) { /* plain */ } }
    return t.technician ? { label: t.technician, tone: 'ok' } : { label: 'No technician yet', tone: 'warn' };
  }
  function isQueued(t) { var f = fn('isQueuedBuildTicket'); try { return f ? !!f(t) : false; } catch (e) { return false; } }
  function awaitingList(t) {
    var f = fn('parseAwaitingComponents');
    if (!t.missingComponentsToggle) return [];
    try { return f ? f(t.missingComponents) || [] : []; } catch (e) { return []; }
  }
  function damagedList(t) {
    var l = t.damagedComponents || (t.specs && t.specs.__damaged);
    return Array.isArray(l) ? l : [];
  }
  function queryCount(id) {
    try { return (typeof ticketQueryCounts !== 'undefined' && ticketQueryCounts && ticketQueryCounts[id]) || 0; } catch (e) { return 0; }
  }
  function code(t) {
    var f = fn('buildTrackCode');
    return f ? f(t) : String(t.id || '').slice(-6).toUpperCase();
  }

  // ── the steps ───────────────────────────────────────────────────────────
  var STEPS = [
    { key: 'booked', label: 'Booked' },
    { key: 'parts', label: 'Parts' },
    { key: 'assembly', label: 'Assembly' },
    { key: 'qc', label: 'QC checks' },
    { key: 'stress', label: 'Stress test' },
    { key: 'done', label: 'Done' }
  ];
  function stepsFor(t) {
    var qp = qcPct(t);
    var signed = !!t.stressSignedOff;
    var cur;
    if (t.status === 'completed') cur = STEPS.length;
    else if (t.status === 'awaiting') cur = 1;
    else if (t.status === 'building') cur = 2;
    else if (t.status === 'waiting_qc') cur = 3;
    else if (t.status === 'qc_testing') cur = qp < 100 ? 3 : (!signed ? 4 : 5);
    else cur = 0;
    var bN = countChecks(t.buildChecks, BUILD_KEYS), qN = countChecks(t.qcChecks, QC_KEYS);
    var runs = t.stressRuns || 0;
    var v = (t.specs && t.specs.__verify) || {};
    var aw = awaitingList(t);
    var subs = STEPS.map(function (st, i) {
      var state = i < cur ? 'done' : i === cur ? 'now' : 'todo';
      switch (st.key) {
        case 'booked': return fmtDate(t.createdAt);
        case 'parts':
          if (state === 'now') return aw.length ? 'Waiting on ' + aw.length + ' part' + (aw.length === 1 ? '' : 's') : 'Waiting on parts';
          return state === 'done' ? (t.missingComponentsToggle ? 'Some still due' : 'All in') : '';
        case 'assembly':
          if (state === 'done') return v.buildFinishedAt ? fmtDate(v.buildFinishedAt) : bN + ' of 5 checks';
          return state === 'now' || bN ? bN + ' of 5 checks' : '';
        case 'qc':
          if (state === 'now' && t.status === 'waiting_qc' && !qN) return 'Waiting for QC';
          return state !== 'todo' || qN ? qN + ' of ' + QC_KEYS.length : '';
        case 'stress':
          if (signed) return 'Signed off';
          return runs ? runs + ' run' + (runs === 1 ? '' : 's') : (state === 'now' ? 'Not run yet' : '');
        case 'done': return t.status === 'completed' ? fmtDate(t.completedAt) : '';
      }
      return '';
    });
    var states = STEPS.map(function (st, i) { return i < cur ? 'done' : i === cur ? 'now' : 'todo'; });
    return { cur: cur, states: states, subs: subs };
  }

  function nowSentence(t) {
    var qp = qcPct(t);
    var bN = countChecks(t.buildChecks, BUILD_KEYS), qN = countChecks(t.qcChecks, QC_KEYS);
    var tech = first(t.technician);
    var runs = t.stressRuns || 0;
    switch (t.status) {
      case 'completed': return { tone: 'ok', text: 'Passed QC and finished' + (t.completedAt ? ' on ' + fmtDate(t.completedAt) : '') };
      case 'awaiting': {
        var aw = awaitingList(t);
        var f = fn('formatMissingComponentsHuman');
        return { tone: 'wait', text: 'Waiting for parts' + (aw.length && f ? ': ' + f(t.missingComponents) : '') };
      }
      case 'building':
        if (isQueued(t)) return { tone: 'wait', text: 'In the build queue, waiting for a technician' };
        return { tone: 'shop', text: (tech ? 'Being assembled by ' + tech : 'Assembly, nobody assigned yet') + ' · ' + bN + ' of 5 build checks done' };
      case 'waiting_qc': return { tone: 'shop', text: 'Built' + (tech ? ' by ' + tech : '') + ', waiting for QC' };
      case 'qc_testing':
        if (qp < 100) return { tone: 'shop', text: 'QC checks in progress · ' + qN + ' of ' + QC_KEYS.length + ' done' + (runs ? ' · ' + runs + ' stress run' + (runs === 1 ? '' : 's') : '') };
        if (!t.stressSignedOff) return { tone: 'shop', text: runs ? 'Stress tested ' + runs + ' time' + (runs === 1 ? '' : 's') + ', waiting for the sign-off' : 'QC checks done, waiting for the stress test' };
        return { tone: 'ok', text: 'Every check done, ready to close' };
    }
    return { tone: 'shop', text: statusLabel(t.status) };
  }

  // ── building blocks ─────────────────────────────────────────────────────
  function stepBar(s) {
    return '<ol class="sv2-steps rma-steps bs-steps" aria-label="Where this build is">' + STEPS.map(function (st, i) {
      var state = s.states[i];
      var dot = state === 'done' ? '✓' : String(i + 1);
      var sub = s.subs[i] || '';
      return '<li class="sv2-step is-' + state + '"' + (state === 'now' ? ' aria-current="step"' : '') + '>' +
        '<span class="sv2-step-dot" aria-hidden="true">' + dot + '</span>' +
        '<span class="sv2-step-t"><span class="sv2-step-l">' + esc(st.label) + '</span>' +
        (sub ? '<span class="sv2-step-s">' + esc(sub) + '</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  function section(title, body, cls, extra) {
    return body ? '<section class="bs-sec' + (cls ? ' ' + cls : '') + '"><header class="bs-sec-h"><h3 class="bs-h">' + esc(title) + '</h3>' + (extra || '') + '</header>' + body + '</section>' : '';
  }
  function facts(rows) {
    var list = rows.filter(function (r) { return r && r[1] != null && String(r[1]).trim() !== ''; });
    if (!list.length) return '';
    return '<dl class="bs-facts">' + list.map(function (r) {
      return '<div class="bs-fact' + (r[2] ? ' ' + r[2] : '') + '"><dt>' + esc(r[0]) + '</dt><dd>' + (r[3] ? r[1] : esc(r[1])) + '</dd></div>';
    }).join('') + '</dl>';
  }
  function flagsHtml(list) {
    if (!list.length) return '<p class="bs-muted">Nothing to watch out for.</p>';
    return '<ul class="bs-flags">' + list.map(function (f) {
      return '<li class="bs-flag bs-flag-' + esc(f[0]) + '"><span class="bs-flag-dot" aria-hidden="true"></span><span>' +
        '<strong>' + esc(f[1]) + '</strong>' + (f[2] ? '<span class="bs-flag-s">' + esc(f[2]) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  var ICON = {
    cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3"/>',
    gpu: '<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="9" cy="11.5" r="3"/><path d="M15 9.5h3.5M15 13.5h3.5M5 17v2.5"/>',
    mobo: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><rect x="7" y="7" width="5" height="5" rx="1"/><path d="M15 7v10M18 7v10M7 15.5h5"/>',
    ram: '<rect x="2.5" y="7" width="19" height="9" rx="1.5"/><path d="M6 10v3M10 10v3M14 10v3M18 10v3M5 16v2.5M19 16v2.5"/>',
    storage: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="16.5" cy="12" r="1.2"/><path d="M6.5 9h6M6.5 12h6M6.5 15h4"/>',
    psu: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="10" cy="12" r="4"/><path d="M10 9.5V12M17 9h1.5M17 12h1.5M17 15h1.5"/>',
    cooler: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.6"/><path d="M12 10.4c0-3 1.2-5 3.4-5.4M13.6 12c3 0 5 1.2 5.4 3.4M12 13.6c0 3-1.2 5-3.4 5.4M10.4 12c-3 0-5-1.2-5.4-3.4"/>',
    case: '<rect x="6" y="2.5" width="12" height="19" rx="2"/><circle cx="12" cy="15.5" r="2.5"/><path d="M9 6h6M9 8.5h6"/>'
  };
  function svgIcon(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || '') + '</svg>'; }

  // ── the parts list ──────────────────────────────────────────────────────
  var PARTS = [
    // key, label, serials key, damage / awaiting category, icon
    ['cpu', 'Processor', 'cpu', 'cpu', 'cpu'],
    ['gpu', 'Graphics card', 'gpu', 'gpu', 'gpu'],
    ['mobo', 'Motherboard', 'motherboard', 'motherboard', 'mobo'],
    ['ram', 'Memory', 'ram', 'ram', 'ram'],
    ['storage', 'Storage', 'ssd', 'storage', 'storage'],
    ['psu', 'Power supply', 'psu', 'psu', 'psu'],
    ['cooler', 'Cooler', 'cooler', 'cooler', 'cooler'],
    ['case', 'Case', 'cabinet', 'case', 'case']
  ];
  var PART_NAME = { cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'Storage', psu: 'PSU', motherboard: 'Motherboard', cooler: 'Cooler', case: 'Case', other: 'Other' };
  var VERIFY_KEY = { cpu: 'cpu', gpu: 'gpu', mobo: 'motherboard', ram: 'ram', storage: 'storage', psu: 'psu', cooler: 'cooler', case: 'case' };
  function partsHtml(t) {
    var sp = t.specs || {};
    var ser = t.serials || {};
    var comps = (sp.__verify && sp.__verify.components) || {};
    var supplied = t.customerSupplied || sp.__customerSupplied || [];
    var dmg = damagedList(t), aw = awaitingList(t);
    var rows = PARTS.map(function (p) {
      var name = sp[p[0]] || '';
      if (p[0] === 'cooler') {
        var ct = sp.coolerType || '';
        name = ct === 'stock' || (!ct && !sp.coolerModel) ? (ct === 'stock' ? 'Stock cooler' : '') : [sp.coolerModel, ct === 'aio' ? 'AIO liquid' : ct === 'air' ? 'Air' : ''].filter(Boolean).join(' · ');
      }
      if (p[0] === 'ram' && sp.ramSticks && sp.ramStickGB && window.NeoRamSpec && typeof window.NeoRamSpec.text === 'function') {
        try { name = [name, window.NeoRamSpec.text(sp.ramSticks, sp.ramStickGB)].filter(Boolean).join(' · '); } catch (e) { /* name only */ }
      }
      var serial = ser[p[2]] || (comps[VERIFY_KEY[p[0]]] && comps[VERIFY_KEY[p[0]]].scan) || '';
      var d = dmg.filter(function (x) { return x && x.category === p[3]; });
      var a = aw.filter(function (x) { return x && x.category === p[3]; });
      if (!name && !serial && !d.length && !a.length) return '';
      var chips = '';
      if (d.length) chips += '<span class="bs-chip bs-chip-bad">' + (d[0].condition === 'doa' ? 'DOA' : 'Damaged') + '</span>';
      if (a.length) chips += '<span class="bs-chip bs-chip-warn">Awaiting</span>';
      if (supplied.indexOf && supplied.indexOf(p[0] === 'mobo' ? 'motherboard' : p[0]) !== -1) chips += '<span class="bs-chip">Customer’s own</span>';
      var note = d.length && d[0].note ? d[0].note : a.length && a[0].note ? a[0].note : '';
      return '<li class="bs-part' + (d.length ? ' is-bad' : a.length ? ' is-wait' : '') + '">' +
        '<span class="bs-part-ic">' + svgIcon(p[4]) + '</span>' +
        '<span class="bs-part-main"><span class="bs-part-k">' + esc(p[1]) + '</span>' +
          '<span class="bs-part-l">' + (name ? esc(name) : '<span class="bs-muted">Not set</span>') + '</span>' +
          (note ? '<span class="bs-part-note">' + esc(note) + '</span>' : '') + '</span>' +
        '<span class="bs-part-side">' + chips + (serial ? '<span class="bs-serial" title="Serial number">' + esc(serial) + '</span>' : '') + '</span>' +
      '</li>';
    }).join('');
    var other = aw.filter(function (x) { return x && x.category === 'other'; }).concat(dmg.filter(function (x) { return x && x.category === 'other'; }));
    if (other.length) {
      rows += other.map(function (x) {
        return '<li class="bs-part is-wait"><span class="bs-part-ic">' + svgIcon('case') + '</span><span class="bs-part-main"><span class="bs-part-k">Other</span>' +
          '<span class="bs-part-l">' + esc(x.note || 'Unspecified part') + '</span></span><span class="bs-part-side"><span class="bs-chip bs-chip-warn">' + (x.condition ? 'Damaged' : 'Awaiting') + '</span></span></li>';
      }).join('');
    }
    return rows ? '<ul class="bs-parts">' + rows + '</ul>' : '<p class="bs-muted">No parts on this ticket yet. Add them in Edit.</p>';
  }

  // ── the checks ──────────────────────────────────────────────────────────
  function checkList(obj, list) {
    obj = obj || {};
    return '<ul class="bs-checks">' + list.map(function (c) {
      var on = !!obj[c[0]];
      return '<li class="bs-check' + (on ? ' on' : '') + '"><span class="bs-check-m" aria-hidden="true">' + (on ? '✓' : '') + '</span>' +
        '<span>' + esc(c[1]) + '</span><span class="bs-vh">' + (on ? ' (done)' : ' (not done)') + '</span></li>';
    }).join('') + '</ul>';
  }
  function meter(label, n, of) {
    var pct = of ? Math.round(n / of * 100) : 0;
    return '<div class="bs-meter' + (pct >= 100 ? ' is-done' : '') + '"><div class="bs-meter-h"><span>' + esc(label) + '</span><b>' + n + ' / ' + of + '</b></div>' +
      '<div class="bs-track"><i style="width:' + pct + '%"></i></div></div>';
  }
  function checksHtml(t) {
    var bN = countChecks(t.buildChecks, BUILD_KEYS), qN = countChecks(t.qcChecks, QC_KEYS);
    var q = t.qcChecks || {};
    var wifi = [q.wifiSpeed != null ? q.wifiSpeed + ' Mbps' : '', q.wifiRange != null ? q.wifiRange + '% signal' : ''].filter(Boolean).join(' · ');
    var group = function (title, obj, list, n) {
      var done = countChecks(obj, list.map(function (c) { return c[0]; }));
      return '<div class="bs-check-col"><div class="bs-check-g"><span>' + esc(title) + '</span><b' + (done === list.length ? ' class="ok"' : '') + '>' + done + '/' + list.length + '</b></div>' +
        checkList(obj, list) + (n || '') + '</div>';
    };
    return '<div class="bs-meters">' + meter('Assembly', bN, BUILD_KEYS.length) + meter('QC', qN, QC_KEYS.length) + '</div>' +
      '<div class="bs-check-cols">' +
        group('Assembly', t.buildChecks, BUILD_CHECKS) +
        QC_GROUPS.map(function (g) {
          return group(g[0], t.qcChecks, g[1], g[0] === 'Ports' && wifi ? '<p class="bs-muted bs-wifi">Wi-Fi: ' + esc(wifi) + '</p>' : '');
        }).join('') +
      '</div>';
  }

  // ── the test results ────────────────────────────────────────────────────
  function tile(k, v, unit, sub, tone) {
    return '<div class="bs-tile' + (tone ? ' is-' + tone : '') + '"><span class="bs-tile-k">' + esc(k) + '</span>' +
      '<span class="bs-tile-v">' + (v === '' || v == null ? '<span class="bs-tile-none">—</span>' : esc(v) + (unit ? '<small>' + esc(unit) + '</small>' : '')) + '</span>' +
      (sub ? '<span class="bs-tile-s">' + esc(sub) + '</span>' : '') + '</div>';
  }
  function tempTone(v, hot) { var n = num(v); return n == null ? '' : n >= hot ? 'bad' : n >= hot - 10 ? 'warn' : 'ok'; }
  function resultsHtml(t) {
    var d = t.diagnostics || {};
    var tiles = [];
    var any = false;
    var cpuMax = num(d.cpuTempMax), gpuMax = num(d.gpuTempMax);
    if (cpuMax != null || num(d.cpuTempAvg) != null) {
      any = true;
      tiles.push(tile('CPU temperature', cpuMax != null ? Math.round(cpuMax) : '', '°C max', [num(d.cpuTempAvg) != null ? 'avg ' + Math.round(d.cpuTempAvg) + ' °C' : '', num(d.cpuTempMin) != null ? 'idle ' + Math.round(d.cpuTempMin) + ' °C' : ''].filter(Boolean).join(' · '), tempTone(cpuMax, 95)));
    }
    if (gpuMax != null || num(d.gpuTempAvg) != null) {
      any = true;
      tiles.push(tile('GPU temperature', gpuMax != null ? Math.round(gpuMax) : '', '°C max', [num(d.gpuTempAvg) != null ? 'avg ' + Math.round(d.gpuTempAvg) + ' °C' : '', num(d.gpuTempMin) != null ? 'idle ' + Math.round(d.gpuTempMin) + ' °C' : ''].filter(Boolean).join(' · '), tempTone(gpuMax, 90)));
    }
    if (num(d.cinebench) != null) { any = true; tiles.push(tile('Cinebench R23', int(d.cinebench), 'pts', d.cinebenchMode === 'single' ? 'Single core' : 'Multi core', '')); }
    if (num(d.furmark) != null) { any = true; tiles.push(tile('FurMark', int(d.furmark), 'pts', 'GPU stress score', '')); }
    if (num(d.ssdRead) != null || num(d.ssdWrite) != null) {
      any = true;
      tiles.push(tile('SSD speed', int(d.ssdRead) || '—', 'MB/s read', num(d.ssdWrite) != null ? int(d.ssdWrite) + ' MB/s write' : '', ''));
    }
    if (d.ramStress) {
      any = true;
      var rOk = String(d.ramStress).toLowerCase() === 'passed';
      tiles.push(tile('RAM test', rOk ? 'Passed' : 'Failed', '', d.ramDetail || '', rOk ? 'ok' : 'bad'));
    }
    var p = d.prime95;
    if (p && p.overallResult && p.overallResult !== 'not-run') {
      any = true;
      var errs = (p.workers || []).reduce(function (s, w) { return s + (w.errors || 0); }, 0);
      var pTone = p.overallResult === 'pass' ? 'ok' : p.overallResult === 'aborted' ? 'warn' : 'bad';
      tiles.push(tile('Prime95 Blend', p.overallResult === 'pass' ? 'Passed' : p.overallResult === 'aborted' ? 'Stopped' : 'Failed', '',
        [fmtDur(p.durationActualSec), (p.workerCount || (p.workers || []).length) ? (p.workerCount || p.workers.length) + ' workers' : '', errs + ' error' + (errs === 1 ? '' : 's')].filter(Boolean).join(' · '), pTone));
    }
    var h = d.ssdHealth;
    if (h && !h.error && (h.lifeRemaining != null || h.healthStatus)) {
      any = true;
      var hs = String(h.healthStatus || '').toLowerCase();
      var hTone = (hs.indexOf('unhealthy') !== -1 || hs.indexOf('fail') !== -1 || (h.lifeRemaining != null && h.lifeRemaining < 10)) ? 'bad'
        : (hs.indexOf('warn') !== -1 || (h.lifeRemaining != null && h.lifeRemaining < 30)) ? 'warn' : 'ok';
      tiles.push(tile('Drive health', h.lifeRemaining != null ? h.lifeRemaining : (h.healthStatus || ''), h.lifeRemaining != null ? '% life' : '', h.model || '', hTone));
    }
    var runs = t.stressRuns || 0;
    var stress = runs || t.stressSignedOff
      ? facts([
          ['Stress runs', runs + (t.stressTotalSec ? ' · ' + fmtDur(t.stressTotalSec) + ' under load' : '')],
          ['Sign-off', t.stressSignedOff ? 'Signed off' + (t.stressSignedOffAt ? ' · ' + fmtWhen(t.stressSignedOffAt) : '') : 'Not signed off yet', t.stressSignedOff ? 'bs-good' : ''],
          ['Windows', (t.specs && t.specs.windowsActivationState) || '']
        ])
      : facts([['Windows', (t.specs && t.specs.windowsActivationState) || '']]);
    if (!any && !stress) return '<p class="bs-muted">Not tested yet. Results appear here after the diagnostics run on the bench.</p>';
    return (any ? '<div class="bs-tiles">' + tiles.join('') + '</div>' : '<p class="bs-muted">No benchmark results yet.</p>') +
      (stress ? '<div class="bs-stress">' + stress + '</div>' : '');
  }

  // ── the activity (diagnostics.eventLog) ─────────────────────────────────
  function activityHtml(t) {
    var evs = (t.diagnostics && Array.isArray(t.diagnostics.eventLog)) ? t.diagnostics.eventLog.slice() : [];
    if (!evs.length) return '<p class="bs-muted">Nothing recorded yet. Changes made in Edit appear here.</p>';
    evs.sort(function (a, b) { return (ms(b && b.timestamp) || 0) - (ms(a && a.timestamp) || 0); });
    return '<ol class="bs-tl">' + evs.slice(0, 80).map(function (e, i) {
      return '<li class="bs-tl-i' + (i === 0 ? ' is-latest' : '') + '"><span class="bs-tl-body">' + esc((e && e.event) || '') + '</span>' +
        '<span class="bs-tl-meta">' + esc([(e && e.user) || 'System', fmtWhen(e && e.timestamp)].filter(Boolean).join(' · ')) + '</span></li>';
    }).join('') + '</ol>';
  }

  // ── the page ────────────────────────────────────────────────────────────
  var IMPORTANCE = { light: 'Light', medium: 'Medium', important: 'Important', high_value: 'High value', exceptional: 'Exceptional' };
  function page(t) {
    var s = stepsFor(t);
    var now = nowSentence(t);
    var r = risk(t);
    var tech = techInfo(t);
    var b = (t.specs && t.specs.__build) || {};
    var imp = b.importance && b.importance !== 'light' ? b.importance : '';
    var dmg = damagedList(t), aw = awaitingList(t);
    var qN = countChecks(t.qcChecks, QC_KEYS), bN = countChecks(t.buildChecks, BUILD_KEYS);
    var d = t.diagnostics || {};
    var qcount = queryCount(t.id);

    var chips = '<span class="bs-chip bs-stage s-' + esc(t.status || 'pending') + '">' + esc(statusLabel(t.status)) + '</span>' +
      (imp ? '<span class="bs-chip bs-imp">' + esc(IMPORTANCE[imp] || imp) + ' build</span>' : '');
    var sub = [
      t.customerPhone ? esc(showPhone(t.customerPhone)) : '',
      esc([(t.specs && t.specs.cpu) || '', (t.specs && t.specs.gpu) || ''].filter(Boolean).join(' · '))
    ].filter(Boolean).join('<span class="bs-dot" aria-hidden="true">·</span>');

    var head = '<header class="bs-head">' +
      '<div class="bs-head-main">' +
        '<div class="bs-kicker"><span class="bs-code">#' + esc(code(t)) + '</span><span>' + (t.type === 'build' || !t.type ? 'New build' : 'Repair') + '</span>' + chips + '</div>' +
        '<h2 id="bs-title" class="bs-title">' + esc(t.customerName || 'Customer') + '</h2>' +
        (sub ? '<div class="bs-sub">' + sub + '</div>' : '') +
      '</div>' +
      '<div class="bs-head-acts">' +
        '<button type="button" class="primary-pink-btn bs-edit" data-bs="edit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>Edit</button>' +
        '<button type="button" class="bs-x" data-bs="close" aria-label="Close" title="Close (Esc)">&times;</button>' +
      '</div>' +
    '</header>';

    var due = t.deadline && t.status !== 'completed'
      ? '<span class="bs-due' + (r === 'overdue' ? ' late' : r === 'soon' ? ' soon' : '') + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>' +
          '<span>Due ' + esc(fmtDeadline(t.deadline)) + '</span><b>' + esc(countdown(t) || '') + '</b></span>'
      : '';
    var band = '<div class="bs-status">' + stepBar(s) +
      '<div class="bs-now"><span class="bs-now-k">Now</span><span class="bs-now-t is-' + esc(now.tone) + '">' + esc(now.text) + '</span>' + due + '</div>' +
    '</div>';

    var main =
      section('The build', partsHtml(t), 'bs-sec-parts') +
      section('Test results', resultsHtml(t), 'bs-sec-results') +
      section('Checks', checksHtml(t), 'bs-sec-checks', '<span class="bs-sec-n">' + (bN + qN) + ' of ' + (BUILD_KEYS.length + QC_KEYS.length) + ' done</span>');

    // Flags, loudest first.
    var flags = [];
    if (r === 'overdue') flags.push(['red', 'Past the deadline', (countdown(t) || '') + ' · was due ' + fmtDeadline(t.deadline)]);
    else if (r === 'soon') flags.push(['amber', 'Due within 24 hours', fmtDeadline(t.deadline)]);
    if (dmg.length) flags.push(['red', dmg.length + ' damaged or DOA part' + (dmg.length === 1 ? '' : 's'), dmg.map(function (x) { return (PART_NAME[x.category] || String(x.category || 'Part')) + (x.note ? ': ' + x.note : ''); }).join(' · ')]);
    if (d.ramStress && String(d.ramStress).toLowerCase() !== 'passed') flags.push(['red', 'RAM test failed', d.ramDetail || '']);
    if (d.prime95 && d.prime95.overallResult === 'fail') flags.push(['red', 'Prime95 did not pass', '']);
    if (num(d.cpuTempMax) != null && d.cpuTempMax >= 95) flags.push(['red', 'CPU ran hot', Math.round(d.cpuTempMax) + ' °C under load']);
    if (num(d.gpuTempMax) != null && d.gpuTempMax >= 90) flags.push(['red', 'GPU ran hot', Math.round(d.gpuTempMax) + ' °C under load']);
    if (t.missingComponentsToggle) {
      var fm = fn('formatMissingComponentsHuman');
      flags.push(['amber', 'Waiting on parts', fm ? fm(t.missingComponents) : '']);
    }
    if (qcount) flags.push(['amber', qcount + ' sales quer' + (qcount === 1 ? 'y' : 'ies') + ' waiting for a reply', 'Reply in Edit']);
    if (t.status !== 'completed' && isQueued(t)) flags.push(['blue', 'In the build queue', 'Nobody has claimed it yet']);
    else if (t.status !== 'completed' && tech.tone === 'warn') flags.push(['amber', tech.label, '']);
    if (t.specs && t.specs.windowsActivationState === 'Not Activated') flags.push(['amber', 'Windows not activated', '']);
    if (t.status === 'qc_testing' && qcPct(t) >= 100 && !t.stressSignedOff) flags.push(['blue', 'Stress test sign-off pending', (t.stressRuns || 0) + ' run' + ((t.stressRuns || 0) === 1 ? '' : 's') + ' so far']);
    if (t.status === 'completed') flags.push(['green', 'QC passed', t.completedAt ? fmtWhen(t.completedAt) : '']);

    var status = facts([
      ['Step', t.status === 'completed' ? 'All ' + STEPS.length + ' done' : 'Step ' + (Math.min(s.cur, STEPS.length - 1) + 1) + ' of ' + STEPS.length + ': ' + (STEPS[Math.min(s.cur, STEPS.length - 1)] || {}).label],
      ['Technician', '<span class="tech-chip q-tone-' + esc(tech.tone || 'muted') + '"><span class="tech-chip-dot"></span>' + esc(tech.label) + '</span>', '', true],
      ['Deadline', t.deadline ? fmtDeadline(t.deadline) + (t.status !== 'completed' && countdown(t) ? ' · ' + countdown(t) : '') : 'Not set', r === 'overdue' ? 'bs-bad' : r === 'soon' ? 'bs-warn' : ''],
      ['Booked', fmtWhen(t.createdAt)],
      ['Sales', b.salesExec || ''],
      ['Priority', imp ? IMPORTANCE[imp] || imp : ''],
      ['Finished', t.status === 'completed' ? fmtWhen(t.completedAt) : '']
    ]);
    var rail =
      section('Status', status, 'bs-card') +
      section('Flags', flagsHtml(flags), 'bs-card bs-card-flags', flags.length ? '<span class="bs-sec-n">' + flags.length + '</span>' : '') +
      section('Activity', activityHtml(t), 'bs-card bs-card-tl');

    return head + band + '<div class="bs-grid"><div class="bs-main">' + main + '</div><aside class="bs-rail">' + rail + '</aside></div>';
  }

  // ── open / close ────────────────────────────────────────────────────────
  var root = null, curId = null, lastFocus = null, repaintTimer = 0;

  function otherDialogOpen() {
    return !!document.querySelector('.modal-overlay.active, .neo-confirm-overlay, .tk-overlay.open:not(#bs-summary), .ops-dialog[open]');
  }
  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'bs-summary';
    root.className = 'bs-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'bs-title');
    root.innerHTML = '<div class="bs-sheet" tabindex="-1"><div class="bs-page" id="bs-page"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', function (e) { if (e.target === root) root.dataset.downOut = '1'; else delete root.dataset.downOut; });
    root.addEventListener('mouseup', function (e) {
      if (e.target === root && root.dataset.downOut === '1') close();
      delete root.dataset.downOut;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      if (otherDialogOpen()) return;          // a dialog on top closes first
      e.preventDefault();
      close();
    });
    // The board re-renders whenever a ticket changes (save, realtime, sync):
    // repaint the open page from the same data.
    // (A timer, not requestAnimationFrame: that pauses while the window is hidden.)
    var grid = document.getElementById('tickets-grid');
    if (grid && typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        if (!isOpen() || repaintTimer) return;
        repaintTimer = setTimeout(function () { repaintTimer = 0; if (isOpen()) paint(false); }, 30);
      }).observe(grid, { childList: true });
    }
    return root;
  }
  function isOpen() { return !!(root && root.classList.contains('open')); }
  function paint(fresh) {
    var pg = root.querySelector('#bs-page');
    var t = curId ? findTicket(curId) : null;
    var sheet = root.querySelector('.bs-sheet');
    var keepScroll = fresh ? 0 : (sheet ? sheet.scrollTop : 0);
    if (!t) {
      pg.innerHTML = '<div class="bs-gone"><p>This build is no longer in the list.</p><button type="button" class="secondary-btn" data-bs="close">Close</button></div>';
      return;
    }
    pg.innerHTML = page(t);
    if (sheet) sheet.scrollTop = keepScroll;
  }
  function open(id) {
    if (!id) return;
    ensureRoot();
    if (!isOpen()) lastFocus = document.activeElement;
    curId = id;
    if (typeof window.closeTicketPeek === 'function') { try { window.closeTicketPeek(); } catch (e) { /* none open */ } }
    paint(true);
    root.classList.add('open');
    document.body.classList.add('bs-lock');
    // Every build opens at the top (scrollTop is ignored while it is hidden).
    var sh = root.querySelector('.bs-sheet');
    if (sh) sh.scrollTop = 0;
    // Focus the sheet itself: Esc and the arrow keys work at once, and Tab
    // goes to Edit first.
    try { root.querySelector('.bs-sheet').focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ }
  }
  function close() {
    if (!root) return;
    var id = curId;
    root.classList.remove('open');
    document.body.classList.remove('bs-lock');
    curId = null;
    // Back to the card that opened the page (the board may have re-rendered
    // it meanwhile: then the new card for the same build).
    var f = lastFocus; lastFocus = null;
    if (f && !document.contains(f) && id && window.CSS && CSS.escape) f = document.querySelector('#tickets-grid [data-ticket="' + CSS.escape(id) + '"]');
    if (f && document.contains(f) && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function onClick(e) {
    var a = e.target.closest('[data-bs]');
    if (!a) return;
    var act = a.getAttribute('data-bs');
    if (act === 'close') { close(); return; }
    if (act === 'edit') {
      var id = curId;
      lastFocus = null;
      close();
      if (id && typeof window.openTicketModal === 'function') window.openTicketModal(id);
    }
  }

  window.NeoBuildSummary = { open: open, close: close, isOpen: isOpen };
})();
