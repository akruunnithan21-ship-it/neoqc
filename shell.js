/*
  Neo OS — the app shell. (The app was Neo QC, then Neo Tokyo Operations;
  it is Neo OS from 1.10. Code identifiers keep the NeoQc prefix on purpose.)

  Loaded LAST (after app.js, modules.js, the data layer and every screen
  module), so it can use switchScreen, appState, currentProfile,
  escapeHtmlLite, NeoQcModules, NeoQcData and the screen modules.

  TWO JOBS:
    1. The rail. A persistent left nav across the office sections, so moving
       between Overview, Builds, Service and RMA is a click rather than a trip
       through the mode selector — and each section is left exactly where you
       were, scroll position included. The rail is built from the module
       registry (modules.js), so a section appears only for someone who can
       open it: a service desk user sees Overview and Service, not a locked
       Builds door.
    2. The Overview. Builds, service tickets and RMA parts in ONE list. The
       kinds of work are genuinely different — a build has a linear
       assembly/QC path, a service ticket loops and spends most of its life
       waiting on somebody else, an RMA part mostly sits with a vendor — so
       the row does not pretend they are the same shape. A coloured spine and
       a type chip say which is which, and each side's stage wording comes
       from its own vocabulary. Each kind appears only for people allowed to
       see it; the tiles count only what is shown.

  The rail and the Overview are conveniences. Who may open a screen is decided
  by the registry gate in app.js switchScreen, and who may read the rows is
  decided by RLS on the server; nothing here is a security boundary.
*/
(function () {
  'use strict';

  // Used only if modules.js failed to load. It is the v1.9.11 rail with the
  // v1.9.11 rule (office = tier 3+), so a broken registry can never open MORE
  // than before. SPEC-GAP: the spec assumes the registry is always present.
  var FALLBACK_REGISTRY = [
    { id: 'overview', label: 'Overview', icon: '◎', screenId: 'overview-screen', mode: 'overview', needs: { tier: 3 } },
    { id: 'builds',   label: 'QC',       icon: '🧪', screenId: 'staff-screen',    mode: 'staff',    needs: { tier: 3 } },
    { id: 'service',  label: 'Service',  icon: '🔧', screenId: 'service-screen',  mode: 'service',  needs: { tier: 3 } },
    { spacer: true },
    { id: 'bench',    label: 'Bench',    icon: '⚗', action: 'bench',    needs: { tier: 2 } },
    { id: 'settings', label: 'Settings', icon: '⚙', action: 'settings', needs: { any: true } }
  ];

  var scrollMemory = {};      // section -> scrollTop of its container
  var currentSection = null;
  var railSig = null;         // what the rail currently shows, so it is rebuilt only on change
  var lastProfileKey = null;  // a different person signing in starts with a clean rail
  var railAlerts = {};        // section id -> true: the "look here" dot (v1.11, the Queue)

  function S() { return window.NeoQcService || null; }
  function Mods() { return window.NeoQcModules || null; }
  function Data() { return window.NeoQcData || null; }
  function esc(s) { return (typeof escapeHtmlLite === 'function') ? escapeHtmlLite(s == null ? '' : s) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function el(id) { return document.getElementById(id); }
  // app.js's script-scope globals (currentProfile, appState — `let`s) are read
  // only through this, so the shell never throws at boot when app.js failed
  // to load. typeof covers "never declared"; the try covers a `let` that app.js
  // threw before reaching, which stays uninitialised — typeof on it throws.
  function appGlobal(read) { try { return read(); } catch (e) { return undefined; } }
  function profile() {
    return appGlobal(function () { return typeof currentProfile !== 'undefined' ? currentProfile : null; }) || null;
  }
  function builds() {
    var st = appGlobal(function () { return typeof appState !== 'undefined' ? appState : null; });
    return (st && Array.isArray(st.tickets)) ? st.tickets : [];
  }
  function tier() { var p = profile(); return p ? Number(p.tier) || 0 : 0; }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  function errText(e) {
    if (window.NeoQcUI && typeof window.NeoQcUI.errText === 'function') {
      try { return window.NeoQcUI.errText(e); } catch (x) { /* fall through to the plain message */ }
    }
    return (e && e.message) ? e.message : String(e);
  }

  // ── access (all through the registry; fallbacks never widen access) ────────
  function usingRegistry() {
    var m = Mods();
    return !!(m && typeof m.list === 'function' && typeof m.canOpen === 'function');
  }

  function registry() {
    if (usingRegistry()) {
      try {
        var l = Mods().list();
        if (Array.isArray(l)) return l;
      } catch (e) { console.warn('[shell] module registry unreadable:', e && e.message); }
    }
    return FALLBACK_REGISTRY;
  }

  function isSpacer(e) {
    return !!e && (e.spacer === true || e.id === 'spacer' || e.type === 'spacer' || e.kind === 'spacer');
  }

  function entryById(id) {
    var list = registry();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !isSpacer(list[i]) && list[i].id === id) return list[i];
    }
    return null;
  }

  // An entry (rail item) — by its id, so 'builds' and 'bench' resolve too.
  function canOpenEntry(entry) {
    var p = profile();
    if (!p || !entry || entry.hidden) return false;
    if (usingRegistry()) {
      try { return !!Mods().canOpen(entry.id, p); } catch (e) { return false; }
    }
    var n = entry.needs || {};
    if (n.any) return true;
    return tier() >= (Number(n.tier) || 3);
  }

  // A screen mode ('overview', 'staff', 'service', 'rma').
  function canOpenMode(mode) {
    var p = profile();
    if (!p || !mode) return false;
    if (usingRegistry()) {
      try { return !!Mods().canOpen(mode, p); } catch (e) { return false; }
    }
    return ['overview', 'staff', 'service'].indexOf(mode) !== -1 && tier() >= 3;
  }

  // 'desk' | 'tech' | 'lead' | null. Tier 3+ are leads everywhere (modules.js).
  function roleFor(module) {
    if (!profile()) return null;
    var m = Mods();
    if (m && typeof m.roleFor === 'function') {
      try { return m.roleFor(module) || null; } catch (e) { return null; }
    }
    return tier() >= 3 ? 'lead' : null;
  }

  // RAIL_SECTIONS, derived from the registry: section id -> its screen + mode.
  // Every registered screen is listed here whether or not this person can open
  // it — this is a map for scroll memory and syncRail, not a permission list.
  function railSections() {
    var out = {};
    registry().forEach(function (e) {
      if (!e || isSpacer(e) || e.hidden || !e.screenId || !e.mode) return;
      out[e.id] = { screen: e.screenId, mode: e.mode };
    });
    return out;
  }

  function officeModeList() {
    var m = Mods();
    if (m && typeof m.officeModes === 'function') {
      try {
        var l = m.officeModes();
        if (Array.isArray(l)) return l;
      } catch (e) { /* derive below */ }
    }
    var sections = railSections();
    return Object.keys(sections).map(function (k) { return sections[k].mode; });
  }

  function isOfficeMode(mode) { return officeModeList().indexOf(mode) !== -1; }

  function anyOfficeOpen() {
    return officeModeList().some(function (m) { return canOpenMode(m); });
  }

  // A different person on the same PC must not inherit the last person's
  // scroll positions or highlighted section.
  function noteProfile() {
    var p = profile();
    var key = p ? String(p.id || p.email || '') : '';
    if (key !== lastProfileKey) {
      lastProfileKey = key;
      scrollMemory = {};
      currentSection = null;
      railSig = null;
      railAlerts = {};
    }
  }

  // ── rail ───────────────────────────────────────────────────────────────────
  function scroller(screenId) {
    var s = el(screenId);
    return s ? s.querySelector('.dashboard-container') : null;
  }

  function rememberScroll() {
    if (!currentSection) return;
    var cfg = railSections()[currentSection];
    if (!cfg) return;
    var s = el(cfg.screen);
    // A hidden screen reads scrollTop 0; remembering that would erase the real
    // position (e.g. leaving for the bench and coming back).
    if (!s || !s.classList.contains('active')) return;
    var c = scroller(cfg.screen);
    if (c) scrollMemory[currentSection] = c.scrollTop;
  }

  function restoreScroll(section) {
    var cfg = railSections()[section];
    if (!cfg) return;
    var c = scroller(cfg.screen);
    if (!c) return;
    var y = scrollMemory[section] || 0;
    // After paint, or the screen has no layout yet and the assignment is lost.
    requestAnimationFrame(function () { requestAnimationFrame(function () { c.scrollTop = y; }); });
  }

  function setRailActive(section) {
    var activeBtn = null;
    document.querySelectorAll('#app-rail .rail-item').forEach(function (b) {
      var on = !!section && b.dataset.section === section;
      b.classList.toggle('active', on);
      if (on) { b.setAttribute('aria-current', 'page'); activeBtn = b; } else b.removeAttribute('aria-current');
    });
    placeRailIndicator(activeBtn);
  }

  // 1.16.1 — the sliding accent bar beside the active item (neo-theme.css
  // .rail-indicator), and the spotlight that follows the mouse down the rail.
  function placeRailIndicator(btn) {
    var rail = el('app-rail');
    if (!rail) return;
    if (!btn) { rail.style.setProperty('--rail-ind-o', '0'); return; }
    var y = btn.offsetTop + (btn.offsetHeight - 26) / 2;
    rail.style.setProperty('--rail-ind-y', y + 'px');
    rail.style.setProperty('--rail-ind-o', '1');
  }
  function bindRailMotion(rail) {
    if (!rail || rail.dataset.motion) return;
    rail.dataset.motion = '1';
    // 1.17.1: at most once per frame (mousemove can fire several times a frame).
    var lastY = 0, queued = false;
    rail.addEventListener('mousemove', function (e) {
      lastY = e.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        var r = rail.getBoundingClientRect();
        rail.style.setProperty('--rail-my', Math.round(lastY - r.top) + 'px');
      });
    }, { passive: true });
    window.addEventListener('resize', function () {
      placeRailIndicator(rail.querySelector('.rail-item.active'));
    });
  }

  // 1.16.1 — line icons for the rail (24 px, stroke = currentColor). An
  // entry without one keeps its emoji.
  var RAIL_ICONS = {
    overview: '<rect x="3.5" y="3.5" width="7" height="8.5" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="15.5" width="7" height="5" rx="2"/>',
    queue: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    builds: '<path d="M9 3.5h6"/><path d="M10 3.5v6L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-8.5v-6"/><path d="M7.4 15h9.2"/>',
    service: '<path d="M14.6 6.4a4 4 0 0 0-5.3 5.2l-5.6 5.6a1.9 1.9 0 0 0 2.7 2.7l5.6-5.6a4 4 0 0 0 5.2-5.3l-2.5 2.5-2.4-.4-.4-2.4z"/>',
    rma: '<path d="M20.5 7.8 12 3.2 3.5 7.8v8.4l8.5 4.6 8.5-4.6z"/><path d="M3.5 7.8 12 12.4l8.5-4.6"/><path d="M12 12.4v8.4"/><path d="m7.8 5.5 8.5 4.6"/>',
    neohr: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M15.6 4.8a3.4 3.4 0 0 1 0 6.4"/><path d="M17.8 14.3A6.2 6.2 0 0 1 21.2 20"/>',
    bench: '<path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0"/><path d="m12 13.5 3.8-3.8"/><circle cx="12" cy="13.5" r="1.4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.6"/>'
  };
  function railIcon(e) {
    var svg = RAIL_ICONS[e.id] || (e.id === 'bench' ? RAIL_ICONS.bench : null);
    return svg ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + svg + '</svg>' : esc(e.icon || '•');
  }

  function railTitle(e) {
    if (e.id === 'bench') return 'Open the Testing Client';
    return e.label || e.id;
  }

  // v1.11 — the red dot on a rail item ("look here": an offer waiting for
  // you on the Queue, or something that needs a lead). Kept in railAlerts and
  // re-applied after every renderRail() rebuild, so a rebuilt rail never
  // loses it. The title says it too: colour is never the only signal.
  function applyRailAlerts() {
    document.querySelectorAll('#app-rail .rail-item').forEach(function (b) {
      var id = b.dataset.section;
      var on = !!(id && railAlerts[id]);
      b.classList.toggle('has-alert', on);
      var e = entryById(id);
      var base = e ? railTitle(e) : (b.getAttribute('aria-label') || '');
      b.title = on ? base + ' — something needs you' : base;
    });
  }

  function setRailAlert(id, on) {
    if (!id) return;
    noteProfile();
    if (on) railAlerts[String(id)] = true;
    else delete railAlerts[String(id)];
    applyRailAlerts();
  }

  // Builds the rail from the registry. Only items this person can open are
  // drawn; hidden placeholders never are. (NeoHR was one until v1.11; it is
  // now a real screen, shown to tier 3+ and NeoHR leads.) The registry may mark the
  // gap above Bench/Settings with a spacer entry; if it does not, the spacer
  // goes before the first action item, which is where it has always been.
  function renderRail() {
    var rail = el('app-rail');
    if (!rail) return;
    var list = registry();
    var hasSpacer = list.some(isSpacer);
    var parts = [];
    var sig = [];
    var spacerDone = false;
    list.forEach(function (e) {
      if (!e) return;
      if (isSpacer(e)) {
        if (!spacerDone) { parts.push('<div class="rail-spacer"></div>'); sig.push('|'); spacerDone = true; }
        return;
      }
      if (e.hidden) return;
      if (!e.action && !(e.mode && e.screenId)) return;   // nothing it could open
      if (!hasSpacer && !spacerDone && e.action) {
        parts.push('<div class="rail-spacer"></div>'); sig.push('|'); spacerDone = true;
      }
      if (!canOpenEntry(e)) return;
      sig.push(e.id);
      parts.push(
        '<button type="button" class="rail-item" data-section="' + esc(e.id) + '" title="' + esc(railTitle(e)) +
          '" aria-label="' + esc(e.label || e.id) + '">' +
          '<span class="rail-ic" aria-hidden="true">' + railIcon(e) + '</span>' +
          '<span class="rail-label">' + esc(e.label || e.id) + '</span>' +
        '</button>'
      );
    });
    var s = sig.join(',');
    if (s === railSig) { applyRailAlerts(); return; }
    var first = railSig === null;
    railSig = s;
    rail.innerHTML = '<span class="rail-indicator" aria-hidden="true"></span>' + parts.join('');
    bindRailMotion(rail);
    if (first) {
      rail.classList.add('rail-enter');
      setTimeout(function () { rail.classList.remove('rail-enter'); }, 900);
    }
    setRailActive(currentSection);
    applyRailAlerts();
  }

  function activeScreenHasRail() {
    var s = document.querySelector('.screen.active');
    return !!(s && s.classList.contains('has-rail'));
  }

  // The rail is office-only, and only on screens that are inset to clear it.
  // Both conditions matter: someone who can open no office screen (a bench
  // technician without a service or RMA role) would only see locked doors;
  // and the splash, login, tier notice, mode selector and Testing Client have
  // no left inset, so a visible rail would sit on top of their content.
  // With a mode (from switchScreen, mid-switch) the mode decides; without one
  // (the screen watcher below) whichever screen is actually showing decides.
  function applyRailVisibility(mode) {
    var rail = el('app-rail');
    if (!rail) return;
    noteProfile();
    var office = (mode == null) ? activeScreenHasRail() : isOfficeMode(mode);
    var show = !!(office && profile() && anyOfficeOpen());
    if (show) renderRail();
    rail.classList.toggle('hidden', !show);
  }

  // Signing out, the tier notice and the login screen change screens WITHOUT
  // switchScreen, so syncRail never hears about them. Watching the screens'
  // class attribute keeps the rail honest however a screen was reached.
  var screensWatched = false;
  function watchScreens() {
    if (screensWatched || typeof MutationObserver === 'undefined') return;
    var screens = document.querySelectorAll('.screen');
    if (!screens.length) return;
    screensWatched = true;
    var obs = new MutationObserver(function () { applyRailVisibility(); });
    screens.forEach(function (s) { obs.observe(s, { attributes: true, attributeFilter: ['class'] }); });
  }

  function goSection(section) {
    var entry = entryById(section);
    var action = entry ? entry.action : ((section === 'settings' || section === 'bench') ? section : null);
    if (action === 'settings') {
      if (typeof openSettingsModal === 'function') openSettingsModal();
      return;
    }
    if (action === 'bench') {
      // A deliberate context switch, not a section: the Testing Client is a
      // bench tool and wants the whole screen.
      rememberScroll();
      if (typeof switchScreen === 'function') switchScreen('client');
      return;
    }
    var cfg = railSections()[section];
    if (!cfg) return;
    rememberScroll();
    if (typeof switchScreen === 'function') switchScreen(cfg.mode);
    // switchScreen calls syncRail, which sets currentSection to wherever we
    // actually landed. If the registry gate refused this section, we are not
    // here, and this section's scroll must not be applied to another screen.
    if (currentSection === section) {
      setRailActive(section);
      restoreScroll(section);
    }
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
    noteProfile();
    applyRailVisibility(mode);
    var sections = railSections();
    var section = Object.keys(sections).find(function (k) { return sections[k].mode === mode; });
    if (section) { currentSection = section; setRailActive(section); }
    else { setRailActive(null); }
  }

  // Access changed (a late my_modules() answer, a demo toggle, a new sign-in):
  // rebuild the rail from scratch for whoever is signed in now.
  function refreshRail() {
    railSig = null;
    applyRailVisibility();
    setRailActive(currentSection);
  }

  // ── overview ───────────────────────────────────────────────────────────────
  var DAY = 86400000;

  function fmtAge(ms) {
    var d = Math.max(0, ms) / DAY;
    if (d < 1) return Math.max(1, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }

  function msOf(iso, fallback) {
    var t = iso ? new Date(iso).getTime() : NaN;
    return isNaN(t) ? fallback : t;
  }

  // Which kinds of work this person may see on the Overview. Builds follow the
  // Builds screen; service and RMA follow the module role.
  function visibleKinds() {
    return {
      build: canOpenMode('staff'),
      service: !!roleFor('service'),
      rma: !!roleFor('rma')
    };
  }

  function serviceJobs() {
    var d = Data();
    if (d && typeof d.jobs === 'function') {
      try { return d.jobs() || []; } catch (e) { console.warn('[shell] service jobs unreadable:', e && e.message); }
    }
    var ui = window.NeoQcServiceUI;
    return (ui && typeof ui.jobs === 'function' && ui.jobs()) || [];
  }

  function rmaUnits() {
    var d = Data();
    if (d && typeof d.units === 'function') {
      try { return d.units() || []; } catch (e) { console.warn('[shell] RMA units unreadable:', e && e.message); }
    }
    return [];
  }

  function vendorsById() {
    var out = {};
    var d = Data();
    if (!d || typeof d.vendors !== 'function') return out;
    try { (d.vendors() || []).forEach(function (v) { if (v && v.id != null) out[String(v.id)] = v; }); }
    catch (e) { console.warn('[shell] vendors unreadable:', e && e.message); }
    return out;
  }

  function isMirrorStage(M, stage) {
    if (M && typeof M.isMirrorStage === 'function') {
      try { return !!M.isMirrorStage(stage); } catch (e) { return false; }
    }
    return !!(M && Array.isArray(M.MIRROR_STAGES) && M.MIRROR_STAGES.indexOf(stage) !== -1);
  }

  function holdsAPart(M, job, units) {
    if (M && typeof M.holdingUnitsOf === 'function') {
      try { return (M.holdingUnitsOf(job, units) || []).length > 0; } catch (e) { return false; }
    }
    return units.some(function (u) {
      return u && u.service_job_id === job.id && u.holds_ticket && u.stage !== 'closed';
    });
  }

  var BALL_KEYS = { shop: true, customer: true, third_party: true, nobody: true };

  // SPEC-AMENDMENTS A23: a ticket parked in a mirror stage (waiting on a part
  // under RMA) reads from its most urgent HOLDING part — whose turn it is, how
  // late it is and why — because that is where the next action is. A part
  // waiting on the customer's invoice puts the ticket on the customer's list,
  // not the supplier's. The rule itself lives in the shared model
  // (ticketWithUnits), so the board, its KPIs and this list cannot disagree.
  // Without that function, or for any other ticket, the ticket's own values
  // stand, exactly as before. null = use the ticket's own values.
  function ticketView(M, job, units, vendors, now) {
    if (!M || typeof M.ticketWithUnits !== 'function') return null;
    if (job.stage === 'closed' || !isMirrorStage(M, job.stage) || !holdsAPart(M, job, units)) return null;
    var v = null;
    try { v = M.ticketWithUnits(job, units, vendors, now); }
    catch (e) { console.warn('[shell] ticketWithUnits failed for a ticket:', e && e.message); return null; }
    if (!v || !BALL_KEYS[v.ball]) return null;
    return {
      ball: v.ball,
      risk: Number(v.risk) || 0,
      sentence: v.sentence ? String(v.sentence) : '',
      unit: (v.unit && typeof v.unit === 'object') ? v.unit : null
    };
  }

  // app.js buildTechInfo() (which uses NeoQcWork.buildAssignText), else
  // the stored name, as before.
  function buildTechText(t) {
    var info = appGlobal(function () { return typeof buildTechInfo === 'function' ? buildTechInfo(t) : null; });
    if (info && info.label) return String(info.label);
    var w = window.NeoQcWork;
    if (w && typeof w.buildAssignText === 'function') {
      try { var r = w.buildAssignText(t, Date.now()); if (r && r.label) return String(r.label); } catch (e) { /* the name below */ }
    }
    return t.technician || 'Unassigned';
  }

  // Builds, service tickets and RMA parts are normalised to ONE row shape
  // here, and nowhere else. Each side keeps its own stage vocabulary; what
  // they share is "who is this for", "what state", "whose turn", "how long".
  function buildRows() {
    var rows = [];
    var now = Date.now();
    var kinds = visibleKinds();
    var M = S();
    var d = Data();
    // Read once per paint: every service row's A23 view and every RMA row
    // need them, and the lists are copied on each call.
    var allUnits = (kinds.service || kinds.rma) ? rmaUnits() : [];
    var vendors = (kinds.service || kinds.rma) ? vendorsById() : {};

    if (kinds.build) {
      builds().forEach(function (t) {
        if (!t) return;
        var stage = (typeof getStatusLabelText === 'function') ? getStatusLabelText(t.status) : (t.status || '');
        var done = t.status === 'completed';
        // A build's clock is its deadline, which is the promise that was made.
        var late = !done && typeof isAtRisk === 'function' ? isAtRisk(t.deadline) : false;
        var overdue = !done && typeof deadlineRisk === 'function' && deadlineRisk(t.deadline) === 'overdue';
        var since = msOf(t.updatedAt || t.createdAt, now);
        rows.push({
          kind: 'build', id: t.id,
          who: t.customerName || '—',
          sub: [t.specs && t.specs.cpu, t.specs && t.specs.gpu].filter(Boolean).join(' · ') || 'Build',
          stage: stage,
          ball: done ? 'nobody' : 'shop',
          ballText: done ? 'Finished' : 'With us',
          // v1.11 — the work queue's wording (claimed / offered / in the
          // build queue / not sent to the floor), the same as the Builds card.
          tech: buildTechText(t),
          code: String(t.id || '').slice(-6).toUpperCase(),
          ageMs: now - since,
          late: !!(late || overdue),
          open: !done,
          waitingCustomer: false, waitingVendor: false,
          ready: done
        });
      });
    }

    if (kinds.service) {
      serviceJobs().forEach(function (j) {
        if (!j) return;
        var closed = j.stage === 'closed';
        var view = ticketView(M, j, allUnits, vendors, now);
        var ball = view ? view.ball : (M ? M.ballOf(j.stage) : 'shop');
        var risk = view ? view.risk : (M ? M.serviceRisk(j, now) : 0);
        var since = msOf(j.stage_since || j.created_at, now);
        var type = (M && typeof M.typeOf === 'function') ? M.typeOf(j) : (j.service_type || 'in_store');
        var typeLabel = (type && type !== 'in_store' && M && M.TYPES && M.TYPES[type]) ? M.TYPES[type].label : '';
        var queued = (M && typeof M.inQueue === 'function') ? !!M.inQueue(j) : (!closed && !j.assignee_email);
        var device = j.device_label || (M && M.JOB_KINDS && M.JOB_KINDS[j.job_kind]) || 'Service';
        // Who we wait on: the ticket's waiting_party (the server's RMA sync
        // keeps it to the brand), else the holding part's vendor.
        var part = view ? view.unit : null;
        var partVendor = part && part.vendor_id != null ? vendors[String(part.vendor_id)] : null;
        var waitingOn = j.waiting_party || (partVendor && (partVendor.public_name || partVendor.name)) || 'a supplier';
        rows.push({
          kind: 'service', id: j.id,
          who: j.customer_name || '—',
          sub: [typeLabel, device].filter(Boolean).join(' · '),
          stage: M ? M.staffLabel(j.stage) : j.stage,
          why: view ? view.sentence : '',
          ball: ball,
          ballText: ball === 'customer' ? 'Waiting on customer'
                  : ball === 'third_party' ? ((part && part.stage === 'returning') ? 'With the courier' : ('Waiting on ' + waitingOn))
                  : ball === 'nobody' ? 'Closed' : 'With us',
          tech: j.assignee || 'No technician yet',
          code: j.public_code || '',
          ageMs: now - since,
          late: risk === 2 && !closed,
          open: !closed,
          waitingCustomer: ball === 'customer' && !closed,
          waitingVendor: ball === 'third_party' && !closed,
          ready: j.stage === 'ready'
        });
      });
    }

    if (kinds.rma) {
      allUnits.forEach(function (u) {
        if (!u) return;
        var closed = u.stage === 'closed';
        var vendor = u.vendor_id != null ? (vendors[String(u.vendor_id)] || null) : null;
        if (!vendor && d && typeof d.vendor === 'function' && u.vendor_id != null) {
          try { vendor = d.vendor(u.vendor_id) || null; } catch (e) { vendor = null; }
        }
        var intake = null;
        if (d && typeof d.intake === 'function' && u.intake_id) {
          try { intake = d.intake(u.intake_id) || null; } catch (e) { intake = null; }
        }
        var ball = (M && typeof M.rmaBallOf === 'function') ? M.rmaBallOf(u) : (closed ? 'nobody' : 'shop');
        var risk = (M && typeof M.rmaRisk === 'function') ? M.rmaRisk(u, now, vendor) : 0;
        var since = msOf(u.stage_since || u.created_at, now);
        var label = (M && typeof M.itemLabel === 'function')
          ? M.itemLabel(u.kind, u.brand, u.model)
          : ([u.brand, u.model].filter(Boolean).join(' ') || 'Part');
        var sender = intake && intake.sender_name ? intake.sender_name : '';
        var who = u.owner_name || sender || '—';
        var via = (u.owner_name && sender && sender !== u.owner_name) ? ('via ' + sender) : '';
        var vendorName = vendor ? (vendor.public_name || vendor.name || '') : '';
        var ballText = ball === 'customer' ? 'Waiting on customer'
          : ball === 'third_party' ? (u.stage === 'with_vendor' ? ('Waiting on ' + (vendorName || 'the vendor'))
                                     : u.stage === 'returning' ? 'With the courier' : 'Waiting on a third party')
          : ball === 'nobody' ? 'Closed' : 'With us';
        rows.push({
          kind: 'rma', id: u.id,
          who: who,
          sub: [label || 'Part', via].filter(Boolean).join(' · '),
          stage: (M && typeof M.rmaStaffLabel === 'function') ? M.rmaStaffLabel(u.stage) : (u.stage || ''),
          ball: ball,
          ballText: ballText,
          tech: u.handler_name || 'Unassigned',
          code: u.public_code || '',
          ageMs: now - since,
          late: risk === 2 && !closed,
          open: !closed,
          waitingCustomer: ball === 'customer' && !closed,
          waitingVendor: u.stage === 'with_vendor',
          ready: u.stage === 'ready_to_return' && (u.return_method || 'collect') === 'collect'
        });
      });
    }

    return rows;
  }

  var ovFilter = 'open';
  var ovFilterSig = null;
  var ovDataReady = false;    // the data layer has answered at least once

  var KIND_CHIP = { build: 'Build', service: 'Service', rma: 'RMA' };

  // The filter list and the lead sentence follow what this person can see:
  // a service desk user is not offered "Builds only", and is not told about
  // builds at all.
  function syncOverviewChrome() {
    var kinds = visibleKinds();
    var shown = ['build', 'service', 'rma'].filter(function (k) { return kinds[k]; });

    var f = el('ov-filter');
    if (f) {
      var opts = [['attention', 'Needs attention'], ['open', 'Everything open']];
      if (shown.length > 1) {
        if (kinds.build) opts.push(['builds', 'Builds only']);
        if (kinds.service) opts.push(['service', 'Service only']);
        if (kinds.rma) opts.push(['rma', 'RMA only']);
      }
      opts.push(['all', 'Including finished']);
      var sig = opts.map(function (o) { return o[0]; }).join(',');
      if (opts.every(function (o) { return o[0] !== ovFilter; })) ovFilter = 'open';
      if (sig !== ovFilterSig) {
        ovFilterSig = sig;
        f.innerHTML = opts.map(function (o) {
          return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
        }).join('');
      }
      f.value = ovFilter;
    }

    var lead = document.querySelector('#overview-screen .sv-lead');
    if (lead) {
      var parts = [];
      if (kinds.build) parts.push('a <strong>Build</strong> is a machine we are making');
      if (kinds.service) parts.push('a <strong>Service</strong> ticket is one we are fixing');
      if (kinds.rma) parts.push('an <strong>RMA</strong> is a part on a warranty claim');
      var html = 'Everything open that you can see, late work first. ';
      if (parts.length) {
        var s = parts.join('; ');
        html += s.charAt(0).toUpperCase() + s.slice(1) + '. ';
      }
      html += 'The number on the right is how long it has sat in its current state.';
      // Static strings only — no data reaches this innerHTML.
      if (lead.dataset.sig !== html) { lead.dataset.sig = html; lead.innerHTML = html; }
    }
  }

  function renderOverview() {
    var host = el('ov-list');
    if (!host) return;
    var all = buildRows();
    var kinds = visibleKinds();

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
      // everything that exists. Counted over the visible kinds only.
      // 1.16: each card says one more thing under its number.
      var subs = tileSubs(all);
      tiles.innerHTML = [
        ['late',   't-late',   counts.late,   'Late or overdue'],
        ['cust',   't-cust',   counts.cust,   'Waiting on a customer'],
        ['vendor', 't-vendor', counts.vendor, 'Waiting on a supplier'],
        ['ready',  't-ready',  counts.ready,  'Ready to collect'],
        ['open',   't-open',   counts.open,   'Open altogether']
      ].map(function (t) {
        return '<div class="ov-tile ' + t[1] + (ovFilter === 'attention' && t[0] === 'late' ? ' sel' : '') +
               '" data-tile="' + t[0] + '" role="button" tabindex="0"><div class="ov-tile-l">' + esc(t[3]) + '</div>' +
               '<div class="ov-tile-n">' + t[2] + '</div>' +
               (subs[t[0]] ? '<div class="ov-tile-s">' + esc(subs[t[0]]) + '</div>' : '') + '</div>';
      }).join('');
    }
    renderHero(counts);
    renderPipes();
    renderDue();
    renderTeam(all);
    var lh = el('ov-list-h');
    if (lh) {
      var fsel = el('ov-filter');
      var flabel = fsel && fsel.selectedIndex >= 0 ? fsel.options[fsel.selectedIndex].text : 'Everything open';
      lh.textContent = flabel;
    }

    var qEl = el('ov-search');
    var q = ((qEl && qEl.value) || '').toLowerCase().trim();

    var rows = all.filter(function (r) {
      if (ovFilter === 'builds'  && r.kind !== 'build') return false;
      if (ovFilter === 'service' && r.kind !== 'service') return false;
      if (ovFilter === 'rma'     && r.kind !== 'rma') return false;
      if (ovFilter === 'attention' && !(r.open && (r.late || r.waitingCustomer))) return false;
      if (ovFilter !== 'all' && !r.open && ovFilter !== 'attention') return false;
      if (!q) return true;
      return (r.who + ' ' + r.sub + ' ' + r.tech + ' ' + r.code + ' ' + r.stage + ' ' + (r.why || '')).toLowerCase().indexOf(q) !== -1;
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

    if (!rows.length) {
      var waiting = !ovDataReady && (kinds.service || kinds.rma);
      host.innerHTML = '<div class="ov-empty">' +
        (waiting ? 'Loading…'
          : (!kinds.build && !kinds.service && !kinds.rma) ? 'There is nothing here you have access to.'
          : 'Nothing matches. Try a different filter.') + '</div>';
      return;
    }

    // Every value below is escaped and sits in element content or a
    // double-quoted attribute; kind and ball are our own fixed keys.
    host.innerHTML = rows.map(function (r) {
      return '<div class="ov-row k-' + r.kind + (r.late ? ' is-late' : '') +
             '" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '" role="button" tabindex="0">' +
        '<div class="ov-spine"></div>' +
        '<div><span class="ov-chip">' + esc(KIND_CHIP[r.kind] || r.kind) + '</span></div>' +
        '<div><div class="ov-who">' + esc(r.who) + '</div><div class="ov-sub">' + esc(r.sub) +
          (r.code ? ' · ' + esc(r.code) : '') + '</div></div>' +
        '<div class="ov-stage-cell"><div class="ov-stage">' + esc(r.stage) + '</div>' +
          '<span class="ov-ball ov-ball-' + esc(r.ball) + '">' + esc(r.ballText) + '</span>' +
          (r.why ? '<div class="ov-why">' + esc(r.why) + '</div>' : '') + '</div>' +
        '<div class="ov-tech">' + esc(r.tech) + '</div>' +
        // Colour is never the only signal: a late row also says "late".
        '<div class="ov-age">' + fmtAge(r.ageMs) + '<span class="ov-age-l">' + (r.late ? 'late' : 'in state') + '</span></div>' +
      '</div>';
    }).join('');
  }

  // ── 1.16: the Overview's new pieces (owner, 24 Nov 2026: "the overview looks
  //    bad, dull and boring") ────────────────────────────────────────────────
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function firstName() {
    var p = profile();
    var n = p ? String(p.full_name || p.email || '').trim() : '';
    return n ? n.split(/\s+/)[0] : '';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function renderHero(counts) {
    var host = el('ov-hero');
    if (!host) return;
    var now = new Date();
    var h = now.getHours();
    var hello = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (firstName() ? ', ' + firstName() : '');
    var day = DAYS[now.getDay()] + ', ' + now.getDate() + ' ' + MONTHS[now.getMonth()];
    var bits = [plural(counts.open, 'open job')];
    bits.push(counts.late ? plural(counts.late, 'late job') : 'nothing late');
    if (counts.cust) bits.push(counts.cust + ' waiting on customers');
    if (counts.ready) bits.push(counts.ready + ' ready to collect');
    var html = '<div class="ov2-hero-main">' +
        '<div class="ov2-eyebrow">NEO TOKYO // OVERVIEW</div>' +
        '<h2 class="ov2-hello">' + esc(hello) + '</h2>' +
        '<p class="ov2-hero-s"><span>' + esc(day) + '</span> · ' + esc(bits.join(' · ')) + '</p>' +
      '</div>' +
      '<div class="ov2-hanko" aria-hidden="true">ネオ東京</div>';
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
  }
  function tileSubs(all) {
    var out = {};
    var open = all.filter(function (r) { return r.open; });
    var oldest = function (list) { return list.reduce(function (m, r) { return Math.max(m, r.ageMs); }, 0); };
    var late = open.filter(function (r) { return r.late; });
    if (late.length) out.late = 'Oldest ' + fmtAge(oldest(late)) + ' at its step';
    else out.late = 'All on time';
    var cust = all.filter(function (r) { return r.waitingCustomer; });
    if (cust.length) out.cust = 'Longest ' + fmtAge(oldest(cust));
    var vend = all.filter(function (r) { return r.waitingVendor; });
    if (vend.length) out.vendor = 'At service centres and suppliers';
    var ready = all.filter(function (r) { return r.ready; });
    if (ready.length) out.ready = 'Call them to collect';
    var k = { build: 0, service: 0, rma: 0 };
    open.forEach(function (r) { k[r.kind] = (k[r.kind] || 0) + 1; });
    var parts = [];
    if (k.build) parts.push(plural(k.build, 'build'));
    if (k.service) parts.push(k.service + ' service');
    if (k.rma) parts.push(k.rma + ' RMA');
    out.open = parts.join(' · ');
    return out;
  }

  // Open work by step, for each board the person can see. The steps are the
  // boards' own (Service BOARD_ROWS, the 8 RMA steps, the build statuses).
  var BUILD_STEPS = [['pending', 'Pending'], ['awaiting', 'Awaiting parts'], ['building', 'Building'],
                     ['waiting_qc', 'Awaiting QC'], ['qc_testing', 'QC testing']];
  function pipeHtml(title, go, cols) {
    var total = cols.reduce(function (a, c) { return a + c.n; }, 0);
    var max = cols.reduce(function (a, c) { return Math.max(a, c.n); }, 1);
    var late = cols.reduce(function (a, c) { return a + c.late; }, 0);
    return '<div class="ov2-pipe" data-go="' + esc(go) + '" role="button" tabindex="0" aria-label="' + esc(title + ': ' + total + ' open') + '">' +
      '<div class="ov2-pipe-h"><span class="ov2-pipe-t">' + esc(title) + '</span>' +
        '<span class="ov2-pipe-n">' + total + ' open' + (late ? ' · <span class="ov2-late">' + late + ' late</span>' : '') + '</span></div>' +
      '<ol class="ov2-pipe-cols" style="--cols:' + cols.length + '">' + cols.map(function (c) {
        var pct = c.n ? Math.max(8, Math.round(c.n / max * 100)) : 0;
        return '<li class="ov2-pc' + (c.n ? '' : ' is-empty') + (c.late ? ' has-late' : '') + '" title="' + esc(c.label + ': ' + c.n + (c.late ? ', ' + c.late + ' late' : '')) + '">' +
          '<span class="ov2-pc-bar"><span class="ov2-pc-fill" style="height:' + pct + '%"></span>' +
            (c.late ? '<span class="ov2-pc-late" style="height:' + Math.round(c.late / max * 100) + '%"></span>' : '') + '</span>' +
          '<span class="ov2-pc-n">' + c.n + '</span>' +
          '<span class="ov2-pc-l">' + esc(c.label) + '</span></li>';
      }).join('') + '</ol></div>';
  }
  function renderPipes() {
    var host = el('ov-pipes');
    if (!host) return;
    var M = S();
    var kinds = visibleKinds();
    var now = Date.now();
    var out = [];
    if (kinds.service && M && Array.isArray(M.BOARD_ROWS)) {
      var jobs = serviceJobs().filter(function (j) { return j && j.stage !== 'closed'; });
      M.BOARD_ROWS.forEach(function (row) {
        var cols = row.cols.map(function (c) { return { label: c.label, n: 0, late: 0 }; });
        jobs.forEach(function (j) {
          var t = typeof M.typeOf === 'function' ? M.typeOf(j) : (j.service_type || 'in_store');
          if (row.types.indexOf(t) === -1) return;
          for (var i = 0; i < row.cols.length; i++) {
            if (row.cols[i].stages.indexOf(j.stage) !== -1) {
              cols[i].n++;
              if (typeof M.serviceRisk === 'function' && M.serviceRisk(j, now) === 2) cols[i].late++;
              break;
            }
          }
        });
        if (cols.some(function (c) { return c.n; }) || row.key === 'shop') out.push(pipeHtml('Service · ' + row.label, 'service', cols));
      });
    }
    if (kinds.rma && M && typeof M.rmaStepsFor === 'function' && Array.isArray(M.RMA_STEPS)) {
      var vend = vendorsById();
      var rc = M.RMA_STEPS.map(function (s) { return { label: s.label, n: 0, late: 0 }; });
      rmaUnits().forEach(function (u) {
        if (!u || u.stage === 'closed') return;
        var st = M.rmaStepsFor(u);
        var c = rc[st.current];
        if (!c) return;
        c.n++;
        var v = u.vendor_id != null ? vend[String(u.vendor_id)] : null;
        if (typeof M.rmaRisk === 'function' && M.rmaRisk(u, now, v) === 2) c.late++;
      });
      out.push(pipeHtml('RMA · warranty parts', 'rma', rc));
    }
    if (kinds.build) {
      var bc = BUILD_STEPS.map(function (s) { return { key: s[0], label: s[1], n: 0, late: 0 }; });
      builds().forEach(function (t) {
        if (!t || t.status === 'completed') return;
        var key = t.status || 'pending';
        var c = bc.filter(function (x) { return x.key === key; })[0] || bc[0];
        c.n++;
        if (typeof deadlineRisk === 'function' && deadlineRisk(t.deadline) === 'overdue') c.late++;
      });
      out.push(pipeHtml('Builds', 'staff', bc));
    }
    var html = out.join('') || '<p class="ov2-muted">Nothing open you can see.</p>';
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
  }

  // Promised, booked or to collect in the next 48 hours (or already past).
  function renderDue() {
    var host = el('ov-due');
    if (!host) return;
    var M = S();
    var kinds = visibleKinds();
    var now = Date.now();
    var horizon = now + 2 * DAY;
    var items = [];
    var when = function (t) {
      var d = new Date(t);
      var today = new Date(now); today.setHours(0, 0, 0, 0);
      var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / DAY);
      var hh = d.getHours(), mm = d.getMinutes();
      var time = (hh % 12 || 12) + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + (hh < 12 ? ' am' : ' pm');
      return diff === 0 ? 'Today ' + time : diff === 1 ? 'Tomorrow ' + time : diff === -1 ? 'Yesterday' : d.getDate() + ' ' + MON3[d.getMonth()];
    };
    if (kinds.service) {
      serviceJobs().forEach(function (j) {
        if (!j || j.stage === 'closed') return;
        var v = msOf(j.visit_start, null);
        if (v != null && v <= horizon && v >= now - DAY) items.push({ t: v, kind: 'service', id: j.id, what: (M && M.typeOf(j) === 'remote' ? 'Remote session' : 'Visit'), who: j.customer_name || '—' });
        var p = msOf(j.promised_at, null);
        if (p != null && p <= horizon && j.stage !== 'ready') items.push({ t: p, kind: 'service', id: j.id, what: 'Promised', who: j.customer_name || '—' });
      });
    }
    if (kinds.rma) {
      rmaUnits().forEach(function (u) {
        if (!u || u.stage !== 'with_vendor' || !u.vendor_ready_at || u.vendor_ready_via !== 'collect') return;
        var t = msOf(u.expected_back_at, null);
        if (t != null && t <= horizon) items.push({ t: t, kind: 'rma', id: u.id, what: 'Collect from the centre', who: (u.public_code || '') + ' · ' + ([u.brand, u.model].filter(Boolean).join(' ') || 'Part') });
      });
    }
    if (kinds.build) {
      builds().forEach(function (b) {
        if (!b || b.status === 'completed') return;
        var t = msOf(b.deadline, null);
        if (t != null && t <= horizon) items.push({ t: t, kind: 'build', id: b.id, what: 'Build due', who: b.customerName || '—' });
      });
    }
    items.sort(function (a, b) { return a.t - b.t; });
    var html = items.length ? '<ul class="ov2-due-list">' + items.slice(0, 8).map(function (it) {
      var past = it.t < now;
      return '<li><button type="button" class="ov2-due-i k-' + it.kind + (past ? ' is-past' : '') + '" data-kind="' + it.kind + '" data-id="' + esc(it.id) + '">' +
        '<span class="ov2-due-t">' + esc(past && it.what !== 'Visit' ? 'Overdue' : when(it.t)) + '</span>' +
        '<span class="ov2-due-w">' + esc(it.what) + '</span>' +
        '<span class="ov2-due-who">' + esc(it.who) + '</span></button></li>';
    }).join('') + '</ul>' + (items.length > 8 ? '<p class="ov2-muted">+' + (items.length - 8) + ' more</p>' : '')
      : '<p class="ov2-muted">Nothing due in the next two days.</p>';
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
  }

  // Open work per person, from the rows (builds, tickets, RMA parts).
  function renderTeam(all) {
    var host = el('ov-team');
    if (!host) return;
    var by = {};
    all.forEach(function (r) {
      if (!r.open) return;
      var name = String(r.tech || '').trim();
      if (!name || /^(no technician yet|unassigned|nobody yet)$/i.test(name)) name = 'Nobody yet';
      if (/queue|offered|not sent/i.test(name)) name = 'Nobody yet';
      var t = by[name] || (by[name] = { name: name, n: 0, late: 0, kinds: {} });
      t.n++;
      if (r.late) t.late++;
      t.kinds[r.kind] = (t.kinds[r.kind] || 0) + 1;
    });
    var list = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return (a.name === 'Nobody yet') - (b.name === 'Nobody yet') || b.n - a.n; });
    var max = list.reduce(function (a, t) { return Math.max(a, t.n); }, 1);
    var initials = function (n) {
      if (n === 'Nobody yet') return '?';
      var words = n.replace(/\(.*?\)/g, ' ').split(/\s+/).filter(function (w) { return /^[A-Za-z]/.test(w); });
      return (words.map(function (w) { return w.charAt(0); }).join('').slice(0, 2) || '?').toUpperCase();
    };
    var html = list.length ? '<ul class="ov2-team-list">' + list.slice(0, 10).map(function (t) {
      var what = [t.kinds.service ? t.kinds.service + ' service' : '', t.kinds.rma ? t.kinds.rma + ' RMA' : '', t.kinds.build ? plural(t.kinds.build, 'build') : '']
        .filter(Boolean).join(' · ');
      return '<li class="ov2-tm' + (t.name === 'Nobody yet' ? ' is-none' : '') + '">' +
        '<span class="ov2-av" aria-hidden="true">' + esc(initials(t.name)) + '</span>' +
        '<span class="ov2-tm-main"><span class="ov2-tm-n">' + esc(t.name) + '</span><span class="ov2-tm-s">' + esc(what) + '</span>' +
          '<span class="ov2-tm-bar"><span style="width:' + Math.round(t.n / max * 100) + '%"></span></span></span>' +
        '<span class="ov2-tm-c">' + t.n + (t.late ? '<span class="ov2-late">' + t.late + ' late</span>' : '') + '</span></li>';
    }).join('') + '</ul>' : '<p class="ov2-muted">No open work.</p>';
    if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
  }

  function openRow(row) {
    if (!row) return;
    var kind = row.dataset.kind;
    var id = row.dataset.id;
    // Open each kind in ITS OWN editor. One merged list is a way to SEE the
    // shop, not a reason to pretend a repair edits like a build.
    if (kind === 'build') {
      if (typeof openTicketModal === 'function') openTicketModal(id);
    } else if (kind === 'service') {
      goSection('service');
      // 1.16: the read-only summary first, as on the boards (ticket-summary.js).
      if (currentSection === 'service' && window.NeoTicketSummary) window.NeoTicketSummary.openJob(id);
      else if (currentSection === 'service' && window.NeoQcServiceUI && window.NeoQcServiceUI.openJob) {
        window.NeoQcServiceUI.openJob(id);
      }
    } else if (kind === 'rma') {
      goSection('rma');
      if (currentSection === 'rma' && window.NeoTicketSummary) window.NeoTicketSummary.openUnit(id);
      else if (currentSection === 'rma' && window.NeoQcRmaUI && window.NeoQcRmaUI.openUnit) {
        window.NeoQcRmaUI.openUnit(id);
      }
    }
  }

  function initOverview() {
    var pipes = el('ov-pipes');
    if (pipes && !pipes.dataset.bound) {
      pipes.dataset.bound = '1';
      var goPipe = function (p) { if (p) goSection(p.getAttribute('data-go')); };
      pipes.addEventListener('click', function (e) { goPipe(e.target.closest('.ov2-pipe')); });
      pipes.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var p = e.target.closest('.ov2-pipe');
        if (p) { e.preventDefault(); goPipe(p); }
      });
    }
    var due = el('ov-due');
    if (due && !due.dataset.bound) {
      due.dataset.bound = '1';
      due.addEventListener('click', function (e) {
        var b = e.target.closest('.ov2-due-i');
        if (b) openRow({ dataset: { kind: b.getAttribute('data-kind'), id: b.getAttribute('data-id') } });
      });
    }
    var host = el('ov-list');
    if (host && !host.dataset.bound) {
      host.dataset.bound = '1';
      host.addEventListener('click', function (e) {
        openRow(e.target.closest('.ov-row'));
      });
      host.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var row = e.target.closest('.ov-row');
        if (!row || row !== e.target) return;
        e.preventDefault();
        openRow(row);
      });
    }
    var f = el('ov-filter');
    if (f && !f.dataset.bound) {
      f.dataset.bound = '1';
      f.addEventListener('change', function () { ovFilter = f.value; renderOverview(); });
    }
    var s = el('ov-search');
    if (s && !s.dataset.bound) {
      s.dataset.bound = '1';
      s.addEventListener('input', renderOverview);
      // A scanner (or a habit) ends with Enter; it must never do anything here.
      s.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
    }
    var tiles = el('ov-tiles');
    if (tiles && !tiles.dataset.bound) {
      tiles.dataset.bound = '1';
      var pick = function (t) {
        if (!t) return;
        var map = { late: 'attention', cust: 'attention', vendor: 'open', ready: 'open', open: 'open' };
        ovFilter = map[t.dataset.tile] || 'open';
        if (f) f.value = ovFilter;
        renderOverview();
      };
      tiles.addEventListener('click', function (e) { pick(e.target.closest('.ov-tile')); });
      tiles.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var t = e.target.closest('.ov-tile');
        if (!t) return;
        e.preventDefault();
        pick(t);
      });
    }
  }

  function overviewActive() {
    var s = el('overview-screen');
    return !!(s && s.classList.contains('active'));
  }

  var renderPending = null;
  function scheduleOverviewRender() {
    if (!overviewActive() || renderPending) return;
    renderPending = setTimeout(function () {
      renderPending = null;
      if (overviewActive()) renderOverview();
    }, 80);
  }

  // Realtime and demo changes arrive through the data layer's events; the
  // Overview repaints only while it is on screen.
  var dataBound = false;
  function bindData() {
    var d = Data();
    if (dataBound || !d || typeof d.on !== 'function') return;
    dataBound = true;
    ['jobs', 'units', 'vendors'].forEach(function (ev) {
      try { d.on(ev, scheduleOverviewRender); } catch (e) { console.warn('[shell] cannot listen for ' + ev + ':', e && e.message); }
    });
    try { d.on('access', onAccessChanged); }
    catch (e) { console.warn('[shell] cannot listen for access changes:', e && e.message); }
  }

  // Ageing changes with the clock, not with events.
  var ageTimer = null;
  function startAgeTimer() {
    if (ageTimer) return;
    ageTimer = setInterval(function () { if (overviewActive()) renderOverview(); }, 60000);
  }

  async function ensureOverviewLoaded() {
    initRail();
    initOverview();
    bindData();
    syncOverviewChrome();
    // Builds are already in memory: paint them now, service/RMA when they land.
    renderOverview();
    startAgeTimer();

    var kinds = visibleKinds();
    if (kinds.service || kinds.rma) {
      var d = Data();
      try {
        if (d && typeof d.ensureLoaded === 'function') {
          await d.ensureLoaded();
        } else if (window.NeoQcServiceUI && window.NeoQcServiceUI.ensureServiceLoaded) {
          await window.NeoQcServiceUI.ensureServiceLoaded({ silent: true });
        }
      } catch (e) {
        toast('Could not load service and RMA work: ' + errText(e), 'error');
      }
    }
    ovDataReady = true;
    syncOverviewChrome();
    renderOverview();
  }

  // ── styles the Overview needs for the RMA kind ─────────────────────────────
  // The Build and Service row colours live in style.css, which this release
  // does not edit; the shell has no stylesheet of its own, so the one new kind
  // brings its rules with it, as does the A23 "why" line under a ticket that
  // waits on a part. The late rule is repeated with higher
  // specificity because this sheet loads after style.css and would otherwise
  // repaint a late RMA row's spine orange instead of red.
  function injectShellStyle() {
    if (el('neo-shell-style')) return;
    var st = document.createElement('style');
    st.id = 'neo-shell-style';
    st.textContent =
      '.ov-row.k-rma { --row-c: #f97316; }\n' +
      '.ov-row.k-rma.is-late { --row-c: var(--status-urgent); }\n' +
      '.k-rma .ov-chip { color: #fb923c; background: rgba(249,115,22,0.13); }\n' +
      '.ov-why { font-size: 0.7rem; color: var(--text-muted); margin-top: 3px; line-height: 1.35; overflow-wrap: anywhere; }\n' +
      '.ov-row:focus-visible, .ov-tile:focus-visible { outline: 2px solid var(--primary-pink); outline-offset: 2px; }\n';
    document.head.appendChild(st);
  }

  // modules.js announces every new my_modules() answer (or a fall-back to the
  // cache) on window. A role granted or removed redraws the rail and the
  // Overview's kinds without waiting for the next screen change.
  function onAccessChanged() {
    refreshRail();
    if (overviewActive()) { syncOverviewChrome(); scheduleOverviewRender(); }
  }

  function boot() {
    injectShellStyle();
    initRail();
    watchScreens();
    bindData();
    window.addEventListener('neo-modules-changed', onAccessChanged);
    // v1.11 — app.js says when the builds changed (realtime, the poll, a
    // claim); the Overview's build rows repaint without waiting a minute.
    window.addEventListener('neo-builds-changed', scheduleOverviewRender);
    applyRailVisibility();
  }

  // Published before boot runs, so a boot that fails still leaves app.js
  // switchScreen its syncRail.
  window.NeoQcShell = {
    initRail: initRail,
    syncRail: syncRail,
    goSection: goSection,
    ensureOverviewLoaded: ensureOverviewLoaded,
    renderOverview: renderOverview,
    applyRailVisibility: applyRailVisibility,
    refreshRail: refreshRail,
    setRailAlert: setRailAlert,
    // exposed for the dev harness and tests
    _railSections: railSections,
    _buildRows: buildRows
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
