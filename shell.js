/*
  Neo Tokyo Operations — the app shell.

  Loaded after app.js and service.js, so it can use switchScreen, appState,
  currentProfile, escapeHtmlLite and the service module.

  TWO JOBS:
    1. The rail. A persistent left nav across the office sections, so moving
       between Builds, Service and Overview is a click rather than a trip
       through the mode selector — and each section is left exactly where you
       were, scroll position included.
    2. The Overview. Builds and service jobs in ONE list. The two kinds of work
       are genuinely different — a build has a linear assembly/QC path, a
       service job loops and spends most of its life waiting on somebody else —
       so the row does not pretend they are the same shape. A coloured spine
       and a type chip say which is which, and each side's stage wording comes
       from its own vocabulary.
*/
(function () {
  'use strict';

  var RAIL_SECTIONS = {
    overview: { screen: 'overview-screen', mode: 'overview' },
    builds:   { screen: 'staff-screen',    mode: 'staff'    },
    service:  { screen: 'service-screen',  mode: 'service'  }
  };

  var scrollMemory = {};      // section -> scrollTop of its container
  var currentSection = null;

  function S() { return window.NeoQcService || null; }
  function esc(s) { return (typeof escapeHtmlLite === 'function') ? escapeHtmlLite(s == null ? '' : s) : String(s == null ? '' : s); }
  function el(id) { return document.getElementById(id); }
  function tier() { return (typeof currentProfile !== 'undefined' && currentProfile) ? Number(currentProfile.tier) || 0 : 0; }

  // ── rail ───────────────────────────────────────────────────────────────────
  function scroller(screenId) {
    var s = el(screenId);
    return s ? s.querySelector('.dashboard-container') : null;
  }

  function rememberScroll() {
    if (!currentSection) return;
    var cfg = RAIL_SECTIONS[currentSection];
    if (!cfg) return;
    var c = scroller(cfg.screen);
    if (c) scrollMemory[currentSection] = c.scrollTop;
  }

  function restoreScroll(section) {
    var cfg = RAIL_SECTIONS[section];
    if (!cfg) return;
    var c = scroller(cfg.screen);
    if (!c) return;
    var y = scrollMemory[section] || 0;
    // After paint, or the screen has no layout yet and the assignment is lost.
    requestAnimationFrame(function () { requestAnimationFrame(function () { c.scrollTop = y; }); });
  }

  function setRailActive(section) {
    document.querySelectorAll('#app-rail .rail-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.section === section);
    });
  }

  // The rail is office-only, and only on screens that are inset to clear it.
  // Both conditions matter: a technician (T2) never reaches these screens, so
  // showing the rail would advertise locked doors; and the splash, login, mode
  // selector and Testing Client have no left inset, so a visible rail would sit
  // on top of their content.
  function applyRailVisibility(mode) {
    var rail = el('app-rail');
    if (!rail) return;
    var officeMode = mode == null
      ? !!(currentSection && RAIL_SECTIONS[currentSection])
      : Object.keys(RAIL_SECTIONS).some(function (k) { return RAIL_SECTIONS[k].mode === mode; });
    rail.classList.toggle('hidden', !(tier() >= 3 && officeMode));
  }

  function goSection(section) {
    if (section === 'settings') {
      if (typeof openSettingsModal === 'function') openSettingsModal();
      return;
    }
    if (section === 'bench') {
      // A deliberate context switch, not a section: the Testing Client is a
      // bench tool and wants the whole screen.
      if (typeof switchScreen === 'function') switchScreen('client');
      return;
    }
    var cfg = RAIL_SECTIONS[section];
    if (!cfg) return;
    rememberScroll();
    if (typeof switchScreen === 'function') switchScreen(cfg.mode);
    currentSection = section;
    setRailActive(section);
    restoreScroll(section);
  }

  function initRail() {
    var rail = el('app-rail');
    if (!rail || rail.dataset.bound) return;
    rail.dataset.bound = '1';
    rail.addEventListener('click', function (e) {
      var b = e.target.closest('.rail-item');
      if (b && b.dataset.section) goSection(b.dataset.section);
    });
  }

  // Called by switchScreen so the rail stays in step however a screen was
  // reached — a deep link, a tier redirect, or the mode selector.
  function syncRail(mode) {
    applyRailVisibility(mode);
    var section = Object.keys(RAIL_SECTIONS).find(function (k) { return RAIL_SECTIONS[k].mode === mode; });
    if (section) { currentSection = section; setRailActive(section); }
    else { setRailActive(null); }
  }

  // ── overview ───────────────────────────────────────────────────────────────
  var DAY = 86400000;

  function fmtAge(ms) {
    var d = ms / DAY;
    if (d < 1) return Math.max(1, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }

  // Build tickets and service jobs are normalised to ONE row shape here, and
  // nowhere else. Each side keeps its own stage vocabulary; what they share is
  // "who is this for", "what state", "whose turn", "how long".
  function buildRows() {
    var rows = [];
    var now = Date.now();

    var tickets = (typeof appState !== 'undefined' && appState && appState.tickets) || [];
    tickets.forEach(function (t) {
      var stage = (typeof getStatusLabelText === 'function') ? getStatusLabelText(t.status) : (t.status || '');
      var done = t.status === 'completed';
      // A build's clock is its deadline, which is the promise that was made.
      var late = !done && typeof isAtRisk === 'function' ? isAtRisk(t.deadline) : false;
      var overdue = !done && typeof deadlineRisk === 'function' && deadlineRisk(t.deadline) === 'overdue';
      var since = new Date(t.updatedAt || t.createdAt || now).getTime();
      rows.push({
        kind: 'build', id: t.id,
        who: t.customerName || '—',
        sub: [t.specs && t.specs.cpu, t.specs && t.specs.gpu].filter(Boolean).join(' · ') || 'Build',
        stage: stage,
        ball: done ? 'nobody' : 'shop',
        ballText: done ? 'Finished' : 'With us',
        tech: t.technician || 'Unassigned',
        code: String(t.id || '').slice(-6).toUpperCase(),
        ageMs: now - since,
        late: !!(late || overdue),
        open: !done,
        waitingCustomer: false, waitingVendor: false,
        ready: done
      });
    });

    var M = S();
    var jobs = (window.NeoQcServiceUI && window.NeoQcServiceUI.jobs && window.NeoQcServiceUI.jobs()) || [];
    jobs.forEach(function (j) {
      var ball = M ? M.ballOf(j.stage) : 'shop';
      var risk = M ? M.serviceRisk(j, now) : 0;
      var since = new Date(j.stage_since || j.created_at || now).getTime();
      rows.push({
        kind: 'service', id: j.id,
        who: j.customer_name || '—',
        sub: j.device_label || (M && M.JOB_KINDS[j.job_kind]) || 'Service',
        stage: M ? M.staffLabel(j.stage) : j.stage,
        ball: ball,
        ballText: ball === 'customer' ? 'Waiting on customer'
                : ball === 'third_party' ? ('Waiting on ' + (j.waiting_party || 'a supplier'))
                : ball === 'nobody' ? 'Closed' : 'With us',
        tech: j.assignee || 'Unassigned',
        code: j.public_code || '',
        ageMs: now - since,
        late: risk === 2 && j.stage !== 'closed',
        open: j.stage !== 'closed',
        waitingCustomer: ball === 'customer' && j.stage !== 'closed',
        waitingVendor: ball === 'third_party',
        ready: j.stage === 'ready'
      });
    });

    return rows;
  }

  var ovFilter = 'open';

  function renderOverview() {
    var host = el('ov-list');
    if (!host) return;
    var all = buildRows();

    var counts = {
      late: all.filter(function (r) { return r.open && r.late; }).length,
      cust: all.filter(function (r) { return r.waitingCustomer; }).length,
      vendor: all.filter(function (r) { return r.waitingVendor; }).length,
      ready: all.filter(function (r) { return r.ready; }).length,
      open: all.filter(function (r) { return r.open; }).length
    };

    var tiles = el('ov-tiles');
    if (tiles) {
      // Deliberately the five questions a lead walks in asking — not a count of
      // everything that exists.
      tiles.innerHTML = [
        ['late',   't-late',   counts.late,   'Late or overdue'],
        ['cust',   't-cust',   counts.cust,   'Waiting on a customer'],
        ['vendor', 't-vendor', counts.vendor, 'Waiting on a supplier'],
        ['ready',  't-ready',  counts.ready,  'Ready to collect'],
        ['open',   't-open',   counts.open,   'Open altogether']
      ].map(function (t) {
        return '<div class="ov-tile ' + t[1] + (ovFilter === 'attention' && t[0] === 'late' ? ' sel' : '') +
               '" data-tile="' + t[0] + '"><div class="ov-tile-n">' + t[2] +
               '</div><div class="ov-tile-l">' + esc(t[3]) + '</div></div>';
      }).join('');
    }

    var qEl = el('ov-search');
    var q = ((qEl && qEl.value) || '').toLowerCase().trim();

    var rows = all.filter(function (r) {
      if (ovFilter === 'builds'  && r.kind !== 'build') return false;
      if (ovFilter === 'service' && r.kind !== 'service') return false;
      if (ovFilter === 'attention' && !(r.open && (r.late || r.waitingCustomer))) return false;
      if (ovFilter !== 'all' && !r.open && ovFilter !== 'attention') return false;
      if (!q) return true;
      return (r.who + ' ' + r.sub + ' ' + r.tech + ' ' + r.code + ' ' + r.stage).toLowerCase().indexOf(q) !== -1;
    });

    // Late first — the whole point of looking at this screen — then oldest.
    rows.sort(function (a, b) {
      if (a.late !== b.late) return a.late ? -1 : 1;
      return b.ageMs - a.ageMs;
    });

    var stat = el('ov-stat');
    if (stat) {
      stat.textContent = rows.length + ' shown · ' + counts.late + ' late';
      stat.classList.toggle('has-breach', counts.late > 0);
    }

    host.innerHTML = rows.length ? rows.map(function (r) {
      return '<div class="ov-row k-' + r.kind + (r.late ? ' is-late' : '') +
             '" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '">' +
        '<div class="ov-spine"></div>' +
        '<div><span class="ov-chip">' + (r.kind === 'build' ? 'Build' : 'Service') + '</span></div>' +
        '<div><div class="ov-who">' + esc(r.who) + '</div><div class="ov-sub">' + esc(r.sub) + '</div></div>' +
        '<div class="ov-stage-cell"><div class="ov-stage">' + esc(r.stage) + '</div>' +
          '<span class="ov-ball ov-ball-' + r.ball + '">' + esc(r.ballText) + '</span></div>' +
        '<div class="ov-tech">' + esc(r.tech) + '</div>' +
        '<div class="ov-age">' + fmtAge(r.ageMs) + '<span class="ov-age-l">in state</span></div>' +
      '</div>';
    }).join('') : '<div class="ov-empty">Nothing matches. Try a different filter.</div>';
  }

  function initOverview() {
    var host = el('ov-list');
    if (host && !host.dataset.bound) {
      host.dataset.bound = '1';
      host.addEventListener('click', function (e) {
        var row = e.target.closest('.ov-row');
        if (!row) return;
        // Open each kind in ITS OWN editor. One merged list is a way to SEE the
        // shop, not a reason to pretend a repair edits like a build.
        if (row.dataset.kind === 'build') {
          if (typeof openTicketModal === 'function') openTicketModal(row.dataset.id);
        } else if (window.NeoQcServiceUI && window.NeoQcServiceUI.openJob) {
          goSection('service');
          window.NeoQcServiceUI.openJob(row.dataset.id);
        }
      });
    }
    var f = el('ov-filter');
    if (f && !f.dataset.bound) {
      f.dataset.bound = '1';
      f.addEventListener('change', function () { ovFilter = f.value; renderOverview(); });
    }
    var s = el('ov-search');
    if (s && !s.dataset.bound) { s.dataset.bound = '1'; s.addEventListener('input', renderOverview); }
    var tiles = el('ov-tiles');
    if (tiles && !tiles.dataset.bound) {
      tiles.dataset.bound = '1';
      tiles.addEventListener('click', function (e) {
        var t = e.target.closest('.ov-tile');
        if (!t) return;
        var map = { late: 'attention', cust: 'attention', vendor: 'open', ready: 'open', open: 'open' };
        ovFilter = map[t.dataset.tile] || 'open';
        if (f) f.value = ovFilter;
        renderOverview();
      });
    }
  }

  async function ensureOverviewLoaded() {
    initRail();
    initOverview();
    // Service rows come from the service module's own cache, so make sure it
    // has loaded at least once before the first paint.
    if (window.NeoQcServiceUI && window.NeoQcServiceUI.ensureServiceLoaded) {
      try { await window.NeoQcServiceUI.ensureServiceLoaded({ silent: true }); } catch (e) {}
    }
    renderOverview();
  }

  window.NeoQcShell = {
    initRail: initRail,
    syncRail: syncRail,
    goSection: goSection,
    ensureOverviewLoaded: ensureOverviewLoaded,
    renderOverview: renderOverview,
    applyRailVisibility: applyRailVisibility
  };
})();
