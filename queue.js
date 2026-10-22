/*
  Neo OS — the Work Queue (window.NeoQcQueue). New in 1.11.

  ONE queue for new PC builds and service tickets (owner decision 2026-10-22).
  Technicians claim what suits them; anything not claimed in 4 hours is
  OFFERED by the app to the best free technician, who has 30 minutes to
  accept. Leads can offer work to someone themselves, and see what needs a
  lead (declined offers, offers nobody answered, items nobody free can take).

  The server is the source of truth: everything on this screen comes from
  NeoQcData.workQueue() (rpc work_queue), and every action goes through an
  RPC that re-checks it. Service actions go through NeoQcServiceUI.* (the
  visit dialog, contact privacy and the in-flight rules live there); build
  actions call NeoQcData.work* directly.

  Loaded after rma.js and before shell.js. Uses app.js globals (switchScreen,
  appState, currentProfile, showToast, getStatusLabelText,
  calculateBuildPercentage, calculateQcPercentage, formatDateShort,
  openTicketModal, refreshTicketFromCloud) only through typeof / appGlobal
  guards, so a missing piece degrades to a message instead of an exception.

  RULES (as service.js): every async handler binds its item key on its first
  line and re-checks who is signed in after each await; buttons are disabled
  while their item is in flight; every server string goes through esc() or
  textContent; demo data (the practice service tickets) is read-only, while
  builds stay real in demo mode; sign-out (reset) stops every timer and
  closes every dialog.
*/
(function () {
  'use strict';

  var CLAIM_HOURS = 4;
  var OFFER_MINUTES = 30;
  var REFETCH_MS = 30000;      // while the screen is on show
  var TICK_MS = 1000;          // countdown text, while the screen is on show
  var BG_MS = 60000;           // any screen: work_tick, then work_queue
  var BG_FIRST_MS = 2500;      // first background pass after sign-in
  var DEBOUNCE_MS = 400;
  var PREF_KEY = 'neo_q_prefs';
  var HOUR = 3600000;

  function W() { return window.NeoQcWork || null; }
  function D() { return window.NeoQcData || null; }
  function UI() { return window.NeoQcUI || null; }
  function M() { return window.NeoQcModules || null; }
  function SV() { return window.NeoQcServiceUI || null; }
  function SS() { return window.NeoQcService || null; }
  function el(id) { return document.getElementById(id); }

  // app.js's script-scope globals are read only through this, so this file
  // never throws at boot when app.js failed to load (same as shell.js).
  function appGlobal(read) { try { return read(); } catch (e) { return undefined; } }
  function profile() {
    return appGlobal(function () { return typeof currentProfile !== 'undefined' ? currentProfile : null; }) || null;
  }
  function tickets() {
    var s = appGlobal(function () { return typeof appState !== 'undefined' ? appState : null; });
    return (s && Array.isArray(s.tickets)) ? s.tickets : [];
  }
  function pendingSends() {
    var s = appGlobal(function () { return typeof appState !== 'undefined' ? appState : null; });
    return (s && Array.isArray(s.pendingQueueSends)) ? s.pendingQueueSends : [];
  }
  function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function myEmail() { var p = profile(); return p ? lower(p.email) : ''; }
  function whoKey() { var p = profile(); return p ? String(p.id || p.email || '') : ''; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function tsMs(v) { var n = Date.parse(v); return isFinite(n) ? n : NaN; }

  function esc(s) {
    var ui = UI();
    if (ui && typeof ui.esc === 'function') return ui.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type, ms) {
    var ui = UI();
    if (ui && typeof ui.toast === 'function') return ui.toast(msg, type || 'info', ms);
    if (typeof showToast === 'function') return showToast(msg, type || 'info', ms);
    console.warn('[queue] ' + msg);
    return function () {};
  }
  function toastErr(e, prefix) {
    var ui = UI();
    if (ui && typeof ui.toastError === 'function') return ui.toastError(e, prefix);
    return toast((prefix ? prefix + ' ' : '') + ((e && e.message) || String(e)), 'error', 8000);
  }
  function errText(e) {
    var ui = UI();
    if (ui && typeof ui.errText === 'function') { try { return ui.errText(e); } catch (x) { /* plain below */ } }
    return (e && e.message) ? e.message : String(e);
  }
  function banner(text, kind) {
    var ui = UI();
    if (ui && typeof ui.banner === 'function') return ui.banner(text, kind);
    return '<div class="ops-banner ops-banner-' + (kind || 'info') + '">' + esc(text) + '</div>';
  }

  // ── access ────────────────────────────────────────────────────────────────
  function roleRank(r) { return { desk: 1, tech: 2, lead: 3 }[r] || 0; }
  function roleFor(module) {
    var m = M();
    if (!profile() || !m || typeof m.roleFor !== 'function') return null;
    try { return m.roleFor(module) || null; } catch (e) { return null; }
  }
  function hasRole(module, min) { return roleRank(roleFor(module)) >= roleRank(min); }
  // Builds are the 'qc' module; service is 'service'.
  function moduleOf(kind) { return kind === 'build' ? 'qc' : 'service'; }
  function isLeadOf(kind) { return hasRole(moduleOf(kind), 'lead'); }
  function canReadKind(kind) { return hasRole(moduleOf(kind), 'desk'); }
  function isLeadAny() { return isLeadOf('build') || isLeadOf('service'); }
  function pools() {
    var m = M();
    if (m && typeof m.pools === 'function') {
      try {
        var p = m.pools();
        if (p) return { build: !!p.build, service: !!p.service, level: p.level || null };
      } catch (e) { /* none below */ }
    }
    return { build: false, service: false, level: null };
  }
  // The background loop and the rail dot run only for people who may open
  // the queue (C13); work_tick may run for anyone signed in.
  function canUseQueue() {
    var m = M();
    if (!profile() || !m || typeof m.canOpen !== 'function') return false;
    try { return !!m.canOpen('queue'); } catch (e) { return false; }
  }
  function canOpenBuilds() {
    var m = M();
    if (!m || typeof m.canOpen !== 'function') return false;
    try { return !!m.canOpen('staff'); } catch (e) { return false; }
  }
  function isDemo() {
    var d = D();
    try { return !!(d && typeof d.isDemo === 'function' && d.isDemo()); } catch (e) { return false; }
  }
  function active() { var s = el('queue-screen'); return !!(s && s.classList.contains('active')); }

  // ── the shared model (shared/work-queue.js), with local fallbacks ─────────
  function wcall(name, args, fallback) {
    var w = W();
    if (w && typeof w[name] === 'function') {
      try { return w[name].apply(w, args); } catch (e) { console.warn('[queue] NeoQcWork.' + name + ' failed:', e && e.message); }
    }
    return fallback.apply(null, args);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtLeftLocal(ms) {
    ms = Math.floor(num(ms));
    if (ms <= 0) return '0s';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
  }
  function fmtLeft(ms) { return wcall('fmtLeft', [ms], fmtLeftLocal); }
  function fmtOverdue(ms) {
    return wcall('fmtOverdue', [ms], function (x) { return 'overdue ' + fmtLeftLocal(Math.abs(num(x))); });
  }
  function claimDueMs(it) {
    return wcall('claimDueMs', [it], function (i) {
      var due = tsMs(i && i.claim_due);
      if (isFinite(due)) return due;
      var q = tsMs(i && i.queued_at);
      return isFinite(q) ? q + CLAIM_HOURS * HOUR : null;
    });
  }
  function claimRisk(it, now) {
    return wcall('claimRisk', [it, now], function (i, n) {
      var due = claimDueMs(i);
      if (due == null || !isFinite(due)) return 0;
      if (n >= due) return 2;
      if (n >= due - CLAIM_HOURS * HOUR * 0.25) return 1;
      return 0;
    });
  }
  function offerLeftMs(it, now) {
    return wcall('offerLeftMs', [it, now], function (i, n) {
      var exp = tsMs(i && i.offer && i.offer.expires_at);
      return isFinite(exp) ? exp - n : 0;
    });
  }
  function kindLabel(it) {
    return wcall('kindLabel', [it], function (i) {
      if (!i || i.kind === 'build') return 'Build';
      return ({ in_store: 'In-store', on_site: 'On-site', remote: 'Remote' })[i.service_type] || 'In-store';
    });
  }
  function sortItems(items, now) {
    return wcall('sortItems', [items, now], function (list) {
      var a = (list || []).slice();
      var grp = function (i) { return i.offered_to_me ? 0 : (i.mine ? 2 : 1); };
      var key = function (i) {
        var g = grp(i);
        var v = g === 0 ? tsMs(i.offer && i.offer.expires_at) : g === 1 ? claimDueMs(i) : tsMs(i.deadline);
        return (v == null || !isFinite(v)) ? Infinity : v;
      };
      a.sort(function (x, y) { return grp(x) - grp(y) || key(x) - key(y); });
      return a;
    });
  }
  var WHY = {
    not_staff: { self: "You don't have an active staff account.", other: "They don't have an active staff account." },
    no_role_build: { self: "You don't have the Builds technician role.", other: "They don't have the Builds technician role." },
    no_role_service: { self: "You don't have the Service technician role.", other: "They don't have the Service technician role." },
    no_pool_build: { self: "You aren't in the build pool.", other: "They aren't in the build pool." },
    no_pool_service: { self: "You aren't in the service pool.", other: "They aren't in the service pool." },
    senior: { self: 'This is a high-value build — only senior builders can take it.', other: 'This is a high-value build — only senior builders can take it.' }
  };
  function whySentence(code, kind, self) {
    return wcall('whySentence', [code, kind, self], function (c, k, s) {
      var e = WHY[c] || WHY[c + '_' + (k === 'build' ? 'build' : 'service')];
      return e ? (s ? e.self : e.other) : '';
    });
  }
  function whyNot(person, kind, tier) {
    return wcall('whyNot', [person, kind, tier], function (p, k, t) {
      if (!p || p.active === false || p.is_staff === false) return 'not_staff';
      var role = (num(p.tier) >= 3) ? 'lead' : (k === 'build' ? p.qc_role : p.service_role);
      if (roleRank(role) < 2) return 'no_role';
      if (k === 'build' ? !p.build_pool : !p.service_pool) return 'no_pool';
      if (k === 'build' && num(t, 1) >= 4 && p.build_level !== 'senior') return 'senior';
      return null;
    });
  }
  function buildTierOf(specs) {
    return wcall('buildTier', [specs], function (s) {
      var t = Math.round(num(s && s.__build && s.__build.tier, 1));
      return Math.min(5, Math.max(1, t || 1));
    });
  }
  function isQuoteBuild(t) {
    return wcall('isQuoteBuild', [t], function (x) {
      return !!x && !String(x.technician || '').trim() && !x.technicianEmail && !x.queuedAt && x.status !== 'completed';
    });
  }

  // ── clock: server-adjusted ─────────────────────────────────────────────────
  // Every countdown uses the server's clock (C11): a PC a few minutes behind
  // must not show minutes that do not exist.
  function computeOffset(feedNow, receivedAt) {
    var w = W();
    if (w && typeof w.serverOffsetMs === 'function') {
      try { var o = Number(w.serverOffsetMs(feedNow, receivedAt)); if (isFinite(o)) return o; } catch (e) { /* local below */ }
    }
    var s = tsMs(feedNow);
    return isFinite(s) ? s - receivedAt : 0;
  }
  function nowMs() { return Date.now() + (num(st.offsetMs) || 0); }
  function hhmm(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtWhen(iso, build) {
    if (!iso) return '';
    // Build deadlines are stored and shown the build-side way (app.js
    // formatDateShort); service times in local time.
    if (build && typeof formatDateShort === 'function') {
      try { return formatDateShort(iso); } catch (e) { /* below */ }
    }
    var ui = UI();
    return ui && typeof ui.fmtDateTime === 'function' ? ui.fmtDateTime(iso) : String(iso);
  }
  function fmtRel(iso) {
    var ui = UI();
    return ui && typeof ui.fmtRelative === 'function' ? ui.fmtRelative(iso, nowMs()) : '';
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var st = {
    who: null,
    feed: null, feedAt: 0, offsetMs: 0, error: null, loading: false, seq: 0,
    filter: 'all', mineOnly: false, showTeam: false,
    team: null, teamErr: null, teamLoading: false, teamSeq: 0,
    inflight: {},          // 'kind:id' (or 'alert:N') -> true
    seenOffers: {},        // 'kind:id:offered_at' -> true (toasted this session)
    toasts: {},            // same key -> dismiss()
    expiredSeen: {},       // countdown hit 0: refetch once
    bgTimer: null, bgFirst: null, refetchTimer: null, tickTimer: null, debounce: null,
    dot: false
  };

  function readPrefs() {
    try {
      var o = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      if (o && typeof o === 'object') {
        if (['all', 'build', 'in_store', 'on_site', 'remote'].indexOf(o.filter) !== -1) st.filter = o.filter;
        st.mineOnly = !!o.mineOnly;
      }
    } catch (e) { /* storage blocked: defaults */ }
  }
  function writePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ filter: st.filter, mineOnly: st.mineOnly })); } catch (e) { /* not kept */ }
  }

  // A different person on this PC starts from nothing: no last person's
  // feed, offers, toasts or team on screen.
  function bindWho() {
    var k = whoKey();
    if (k === st.who) return;
    clearSession();
    st.who = k;
  }

  function clearSession() {
    Object.keys(st.toasts).forEach(function (k) { try { st.toasts[k](); } catch (e) { /* gone */ } });
    st.toasts = {};
    st.seenOffers = {};
    st.expiredSeen = {};
    st.feed = null; st.feedAt = 0; st.offsetMs = 0; st.error = null; st.loading = false; st.seq++;
    st.team = null; st.teamErr = null; st.teamLoading = false; st.teamSeq++; st.showTeam = false;
    st.inflight = {};
    setDot(false);
    var root = el('q-root'); if (root) root.textContent = '';
    var stat = el('q-stat'); if (stat) stat.textContent = '—';
    var tb = el('q-toolbar'); if (tb) { tb.textContent = ''; delete tb.dataset.sig; }
  }

  function setDot(on) {
    on = !!on;
    st.dot = on;
    var sh = window.NeoQcShell;
    if (sh && typeof sh.setRailAlert === 'function') { try { sh.setRailAlert('queue', on); } catch (e) { /* rail is a nicety */ } }
  }

  // ── fetching ──────────────────────────────────────────────────────────────
  function normaliseFeed(res) {
    if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = null; } }
    if (res && res.data && !res.items && typeof res.data === 'object') res = res.data;
    res = (res && typeof res === 'object') ? res : {};
    return {
      now: res.now || null,
      claim_hours: num(res.claim_hours, CLAIM_HOURS) || CLAIM_HOURS,
      offer_minutes: num(res.offer_minutes, OFFER_MINUTES) || OFFER_MINUTES,
      me: (res.me && typeof res.me === 'object') ? res.me : {},
      items: Array.isArray(res.items) ? res.items.filter(function (i) { return i && i.id != null && (i.kind === 'build' || i.kind === 'service'); }) : [],
      alerts: Array.isArray(res.alerts) ? res.alerts.filter(function (a) { return a && a.id != null; }) : [],
      // Demo mode (ops-data demoFeedWithBuilds): practice service items plus
      // the real builds; builds_error says why the real part is missing.
      demo: res.demo === true,
      builds_error: res.builds_error ? String(res.builds_error) : null
    };
  }

  function fetchFeed() {
    var d = D();
    if (!profile() || !d || typeof d.workQueue !== 'function') {
      if (active()) render();
      return Promise.resolve(null);
    }
    bindWho();
    var who = whoKey();
    var seq = ++st.seq;
    st.loading = true;
    return Promise.resolve().then(function () { return d.workQueue(); }).then(function (res) {
      if (seq !== st.seq || who !== whoKey()) return null;
      // An answer the data layer marks as for a previous sign-in is not ours.
      if (res && res.superseded) { st.loading = false; return null; }
      var recv = Date.now();
      var feed = normaliseFeed(res);
      st.feed = feed; st.feedAt = recv; st.error = null; st.loading = false;
      st.offsetMs = computeOffset(feed.now, recv);
      afterFeed(feed);
      return feed;
    }, function (e) {
      if (seq !== st.seq || who !== whoKey()) return null;
      st.loading = false;
      st.error = e;
      if (active()) render();
      return null;
    });
  }

  function scheduleRefetch() {
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(function () {
      st.debounce = null;
      if (!profile()) return;
      if (active() || canUseQueue()) fetchFeed();
    }, DEBOUNCE_MS);
  }

  function offerLive(it, now) {
    return !!(it && it.offer && it.offer.expires_at && offerLeftMs(it, now == null ? nowMs() : now) > 0);
  }

  // Alerts a viewer can act on: the server already filters by kind (A7/C14);
  // the same rule is applied here so the dot never lights for an alert of a
  // kind this person does not lead.
  function myAlerts(feed) {
    var practice = practiceFeed(feed);
    return (feed && feed.alerts || []).filter(function (a) {
      if (practice && a.item_kind !== 'build') return false;
      return isLeadOf(a.item_kind === 'build' ? 'build' : 'service');
    });
  }

  // Demo mode: the service side of the feed is practice data, the builds are
  // real. Only real items may raise a "New work for you" toast or the rail dot.
  function practiceFeed(feed) { return !!((feed && feed.demo) || isDemo()); }
  function realItem(feed, it) { return !practiceFeed(feed) || (!!it && it.kind === 'build'); }

  function afterFeed(feed) {
    var now = nowMs();
    var offers = feed.items.filter(function (it) { return realItem(feed, it) && it.offered_to_me && offerLive(it, now); });
    setDot(canUseQueue() && (offers.length > 0 || myAlerts(feed).length > 0));
    processOffers(feed, now);
    if (active()) render();
  }

  // ── the "new work for you" toast ──────────────────────────────────────────
  function offerKey(it) { return it.kind + ':' + it.id + ':' + String((it.offer && it.offer.offered_at) || ''); }

  function processOffers(feed, now) {
    var live = {};
    feed.items.forEach(function (it) {
      if (!it.offered_to_me || !it.offer || !realItem(feed, it)) return;
      var k = offerKey(it);
      var left = offerLeftMs(it, now);
      if (left <= 0) return;
      live[k] = true;
      if (st.seenOffers[k]) return;
      st.seenOffers[k] = true;
      showOfferToast(it, k, left);
    });
    // An offer that was answered, withdrawn or ran out takes its toast with it.
    Object.keys(st.toasts).forEach(function (k) {
      if (live[k]) return;
      try { st.toasts[k](); } catch (e) { /* gone */ }
      delete st.toasts[k];
    });
  }

  function showOfferToast(it, k, left) {
    var exp = tsMs(it.offer && it.offer.expires_at);
    // Never "30 minutes" (C11): the poll can be late; say the time it ends.
    var msg = 'New work for you: ' + (it.title || it.code || 'an item') + ' — accept by ' + hhmm(exp) + ' (' + fmtLeft(left) + ' left)';
    var dismiss = toast(msg, 'warning', 0);
    if (typeof dismiss !== 'function') dismiss = function () {};
    st.toasts[k] = dismiss;
    // showToast returns only its dismiss(); the toast it just added is the
    // last one in the stack. Give it an Open button.
    try {
      var stack = el('neo-toast-stack');
      var node = stack && stack.lastElementChild;
      if (node && node.classList.contains('neo-toast') && !node.querySelector('.q-toast-open')) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-toast-open';
        b.textContent = 'Open';
        var kind = it.kind, id = String(it.id);
        b.addEventListener('click', function () {
          try { dismiss(); } catch (e) { /* gone */ }
          delete st.toasts[k];
          openQueueAt(kind, id);
        });
        var close = node.querySelector('.neo-toast-close');
        node.insertBefore(b, close || null);
      }
    } catch (e) { /* the toast still says what to do */ }
  }

  function openQueueAt(kind, id) {
    if (!canUseQueue()) return;
    if (typeof switchScreen === 'function' && !active()) switchScreen('queue');
    setTimeout(function () {
      var root = el('q-root');
      if (!root) return;
      var card = null;
      root.querySelectorAll('.q-card').forEach(function (c) {
        if (!card && c.getAttribute('data-q-kind') === kind && c.getAttribute('data-q-id') === id) card = c;
      });
      if (!card) return;
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* fine */ }
      card.classList.add('q-flash');
      setTimeout(function () { card.classList.remove('q-flash'); }, 1600);
    }, 350);
  }

  // ── timers ────────────────────────────────────────────────────────────────
  function startActiveTimers() {
    if (!st.refetchTimer) {
      st.refetchTimer = setInterval(function () {
        if (!active() || !profile()) { stopActiveTimers(); return; }
        fetchFeed();
      }, REFETCH_MS);
    }
    if (!st.tickTimer) {
      st.tickTimer = setInterval(function () {
        if (!active() || !profile()) { stopActiveTimers(); return; }
        tickCountdowns();
      }, TICK_MS);
    }
  }
  function stopActiveTimers() {
    if (st.refetchTimer) { clearInterval(st.refetchTimer); st.refetchTimer = null; }
    if (st.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = null; }
  }

  function startBackground() {
    if (!profile()) return;
    bindWho();
    if (st.bgTimer) return;
    st.bgTimer = setInterval(bgTick, BG_MS);
    if (st.bgFirst) clearTimeout(st.bgFirst);
    st.bgFirst = setTimeout(function () { st.bgFirst = null; bgTick(); }, BG_FIRST_MS);
  }
  function stopBackground() {
    if (st.bgTimer) { clearInterval(st.bgTimer); st.bgTimer = null; }
    if (st.bgFirst) { clearTimeout(st.bgFirst); st.bgFirst = null; }
  }

  // Any screen, signed in: work_tick (anyone signed in, not demo — it is what
  // expires offers and auto-offers when the database has no scheduler), then
  // work_queue for people who may open the queue. In demo mode the tick stays
  // off but the feed is still read: its builds are real, so a real build
  // offered to this person must still toast and light the dot (afterFeed
  // ignores the practice service items).
  function bgTick() {
    if (!profile()) { stopBackground(); return; }
    bindWho();
    var d = D();
    var who = whoKey();
    if (isDemo()) {
      if (!canUseQueue()) { setDot(false); return; }
      fetchFeed();
      return;
    }
    var tick = (d && typeof d.workTick === 'function')
      ? Promise.resolve().then(function () { return d.workTick(); }).then(null, function () { return null; })
      : Promise.resolve(null);
    tick.then(function () {
      if (who !== whoKey() || !profile()) return;
      if (!canUseQueue()) { setDot(false); return; }
      // On screen, the 30 s poll keeps it fresh; the tick may still have
      // changed things, so this pass refreshes either way.
      fetchFeed();
    });
  }

  // ── countdowns (1 s, text only) ───────────────────────────────────────────
  function claimText(it, now) {
    var due = claimDueMs(it);
    if (due == null || !isFinite(due)) return { text: 'In the queue', risk: 0 };
    var risk = claimRisk(it, now);
    if (risk >= 2) return { text: 'Overdue — the app is offering it', risk: 2 };
    return { text: 'Claim within ' + fmtLeft(due - now), risk: risk };
  }

  function tickCountdowns() {
    var root = el('q-root');
    if (!root) return;
    var now = nowMs();
    var refetch = false;
    root.querySelectorAll('[data-q-countdown]').forEach(function (n) {
      var kind = n.getAttribute('data-q-countdown');
      var at = Number(n.getAttribute('data-q-at'));
      if (!isFinite(at)) return;
      if (kind === 'claim') {
        var risk = now >= at ? 2 : (now >= at - CLAIM_HOURS * HOUR * 0.25 ? 1 : 0);
        var w = W();
        if (w && typeof w.claimRisk === 'function') {
          try { risk = w.claimRisk({ claim_due: new Date(at).toISOString() }, now); } catch (e) { /* local */ }
        }
        n.textContent = risk >= 2 ? 'Overdue — the app is offering it' : ('Claim within ' + fmtLeft(at - now));
        n.classList.toggle('q-risk-1', risk === 1);
        n.classList.toggle('q-risk-2', risk >= 2);
        if (risk >= 2 && !n.dataset.qDone) { n.dataset.qDone = '1'; refetch = true; }
      } else if (kind === 'offer-me') {
        var left = at - now;
        n.textContent = left > 0 ? ('Accept by ' + hhmm(at) + ' (' + fmtLeft(left) + ' left)') : 'Time is up — the app will offer it to someone else.';
        n.classList.toggle('q-risk-2', left <= 5 * 60000);
        if (left <= 0 && !n.dataset.qDone) { n.dataset.qDone = '1'; refetch = true; }
      } else if (kind === 'offer-other') {
        var l2 = at - now;
        var nm = n.getAttribute('data-q-name') || 'someone';
        n.textContent = l2 > 0 ? ('Offered to ' + nm + ' · ' + fmtLeft(l2) + ' left') : ('Offer to ' + nm + ' ran out');
        if (l2 <= 0 && !n.dataset.qDone) { n.dataset.qDone = '1'; refetch = true; }
      }
    });
    if (refetch) scheduleRefetch();
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  var FILTERS = [['all', 'All'], ['build', 'Builds'], ['in_store', 'In-store'], ['on_site', 'On-site'], ['remote', 'Remote']];

  function filterShown(key) {
    if (key === 'all') return true;
    if (key === 'build') return canReadKind('build');
    return canReadKind('service');
  }

  function renderToolbar() {
    var tb = el('q-toolbar');
    if (!tb) return;
    if (!filterShown(st.filter)) st.filter = 'all';
    var shown = FILTERS.filter(function (f) { return filterShown(f[0]); });
    var sig = shown.map(function (f) { return f[0]; }).join(',') + '|' + st.filter + '|' + (st.mineOnly ? 1 : 0) + '|' + (st.loading ? 1 : 0);
    if (tb.dataset.sig === sig) return;
    tb.dataset.sig = sig;
    tb.innerHTML =
      '<div class="q-chips" role="group" aria-label="Show">' +
        shown.map(function (f) {
          var on = st.filter === f[0];
          return '<button type="button" class="q-chip' + (on ? ' on' : '') + '" data-q-filter="' + f[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(f[1]) + '</button>';
        }).join('') +
      '</div>' +
      '<label class="q-mine"><input type="checkbox" id="q-mine"' + (st.mineOnly ? ' checked' : '') + '> Mine only</label>' +
      '<button type="button" class="secondary-btn q-refresh" data-q-tb="refresh"' + (st.loading ? ' disabled' : '') + '>' + (st.loading ? 'Refreshing…' : '↻ Refresh') + '</button>';
  }

  function matchesFilter(it) {
    if (st.filter === 'all') return true;
    if (st.filter === 'build') return it.kind === 'build';
    return it.kind === 'service' && (it.service_type || 'in_store') === st.filter;
  }

  function isAssigned(it) { return !!(it.assignee_email || String(it.assignee_name || '').trim()); }
  function kindClass(it) {
    var k = it.kind === 'build' ? 'build' : String(it.service_type || 'in_store');
    return /^[a-z_]+$/.test(k) ? k : 'in_store';
  }
  function busyKey(kind, id) { return kind + ':' + id; }
  function btn(act, it, label, cls, extra) {
    var busy = !!st.inflight[busyKey(it.kind, it.id)];
    return '<button type="button" class="' + (cls || 'secondary-btn') + ' q-btn" data-q-act="' + act + '" data-q-kind="' + esc(it.kind) +
      '" data-q-id="' + esc(it.id) + '"' + (busy ? ' disabled aria-busy="true"' : '') + (extra || '') + '>' + esc(busy ? 'Working…' : label) + '</button>';
  }

  function localTicket(id) {
    var list = tickets();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function stageLabel(it) {
    if (it.kind === 'build') {
      return (typeof getStatusLabelText === 'function') ? getStatusLabelText(it.stage) : String(it.stage || '');
    }
    var s = SS();
    return (s && typeof s.staffLabel === 'function') ? s.staffLabel(it.stage) : String(it.stage || '');
  }

  function progressHtml(it) {
    if (it.kind !== 'build') return '';
    var t = localTicket(it.id);
    if (!t) return '';
    var b = 0, q = 0;
    try { if (typeof calculateBuildPercentage === 'function') b = Math.round(num(calculateBuildPercentage(t))); } catch (e) { b = 0; }
    try { if (typeof calculateQcPercentage === 'function') q = Math.round(num(calculateQcPercentage(t))); } catch (e) { q = 0; }
    b = Math.max(0, Math.min(100, b)); q = Math.max(0, Math.min(100, q));
    return '<div class="q-progress">' +
      '<span>Build</span><div class="q-track"><i style="width:' + b + '%"></i></div><b>' + b + '%</b>' +
      '<span>QC</span><div class="q-track"><i class="qc" style="width:' + q + '%"></i></div><b>' + q + '%</b>' +
    '</div>';
  }

  function itemCard(it, ctx, now) {
    var key = busyKey(it.kind, it.id);
    var build = it.kind === 'build';
    var risk = ctx === 'open' ? claimRisk(it, now) : 0;
    var live = offerLive(it, now);
    var expMs = live ? tsMs(it.offer.expires_at) : NaN;
    var cls = 'q-card q-k-' + kindClass(it) + (risk ? ' q-risk-' + risk : '') + (ctx === 'offer' ? ' q-card-offer' : '') +
      (st.inflight[key] ? ' q-busy' : '');
    var top = '<div class="q-card-top">' +
      '<span class="q-kind q-kind-' + kindClass(it) + '">' + esc(kindLabel(it)) + '</span>' +
      ((it.priority === 'urgent' || it.priority === 'high') && UI() && typeof UI().priorityBadge === 'function' ? UI().priorityBadge(it.priority) : '') +
      (it.needs_senior ? '<span class="q-badge q-senior" title="Build tier 4–5">Senior builders only</span>' : '') +
      '<span class="q-code">' + esc(it.code || String(it.id).slice(-6).toUpperCase()) + '</span>' +
    '</div>';
    var meta = [];
    // A build's title IS its customer; say it once.
    if (it.customer && String(it.customer) !== String(it.title || '')) meta.push(esc(it.customer));
    if (it.area) meta.push(esc(it.area));
    if (it.deadline) meta.push('Due ' + esc(fmtWhen(it.deadline, build)));
    var body = '<div class="q-title">' + esc(it.title || (build ? 'Build' : 'Service ticket')) + '</div>' +
      (it.sub ? '<div class="q-sub">' + esc(it.sub) + '</div>' : '') +
      (meta.length ? '<div class="q-meta">' + meta.join(' · ') + '</div>' : '');

    var clock = '';
    if (ctx === 'offer') {
      clock = '<div class="q-clock q-clock-offer" data-q-countdown="offer-me" data-q-at="' + (isFinite(expMs) ? expMs : '') + '">' +
        esc('Accept by ' + hhmm(expMs) + ' (' + fmtLeft(expMs - now) + ' left)') + '</div>';
      var by = it.offer && it.offer.by_name;
      if (by || (it.offer && it.offer.reason)) {
        clock += '<div class="q-reason">' + esc((it.offer.kind === 'auto' ? 'Neo OS' : (by || 'A lead')) + ': ' + (it.offer.reason || '')) + '</div>';
      }
    } else if (ctx === 'open') {
      var c = claimText(it, now);
      var due = claimDueMs(it);
      clock = '<div class="q-clock' + (c.risk ? ' q-risk-' + c.risk : '') + '"' +
        (due != null && isFinite(due) ? ' data-q-countdown="claim" data-q-at="' + due + '"' : '') + '>' + esc(c.text) + '</div>';
    } else if (ctx === 'mine') {
      clock = '<div class="q-stage">' + esc(stageLabel(it)) + (it.assigned_at ? ' · yours since ' + esc(fmtRel(it.assigned_at)) : '') + '</div>' + progressHtml(it);
    } else if (ctx === 'reassign') {
      clock = '<div class="q-stage">With ' + esc(it.assignee_name || it.assignee_email || 'a technician') + ' · ' + esc(stageLabel(it)) + '</div>';
    }
    if (live && ctx !== 'offer') {
      var nm = (it.offer && (it.offer.to_name || it.offer.to_email)) || 'someone';
      clock += '<div class="q-offer-chip" data-q-countdown="offer-other" data-q-at="' + expMs + '" data-q-name="' + esc(nm) + '">' +
        esc('Offered to ' + nm + ' · ' + fmtLeft(expMs - now) + ' left') + '</div>';
    }

    var acts = [];
    var lead = isLeadOf(it.kind);
    if (ctx === 'offer') {
      acts.push(btn('accept', it, 'Accept', 'primary-pink-btn'));
      acts.push(btn('decline', it, 'Decline…'));
    } else if (ctx === 'open') {
      if (it.can_claim) acts.push(btn('claim', it, 'Claim', 'primary-pink-btn'));
      if (lead) {
        if (!build) acts.push(btn('offer', it, live ? 'Change offer…' : 'Offer to…'));
        else if (live) acts.push(btn('withdraw', it, 'Withdraw offer'));
        else acts.push(btn('offer', it, 'Offer to…'));
      }
      if (!build || canOpenBuilds()) acts.push(btn('open', it, 'Open', 'text-btn'));
    } else if (ctx === 'mine') {
      if (build) acts.push(btn('bench', it, 'Open bench', 'primary-pink-btn'));
      else acts.push(btn('open', it, 'Open', 'primary-pink-btn'));
      acts.push(btn('release', it, 'Hand back…'));
    } else if (ctx === 'reassign' && lead) {
      if (build) acts.push(btn('withdraw', it, 'Withdraw offer'));
      else acts.push(btn('offer', it, 'Change offer…'));
      if (!build || canOpenBuilds()) acts.push(btn('open', it, 'Open', 'text-btn'));
    }
    var why = (ctx === 'open' && !it.can_claim && it.why_not) ? '<span class="q-why">' + esc(it.why_not) + '</span>' : '';
    return '<div class="' + cls + '" data-q-kind="' + esc(it.kind) + '" data-q-id="' + esc(it.id) + '">' +
      top + body + clock +
      '<div class="q-actions">' + why + acts.join('') + '</div>' +
    '</div>';
  }

  function section(key, title, hint, count, inner, headExtra) {
    return '<section class="q-sec q-sec-' + key + '" data-q-sec="' + key + '">' +
      '<div class="q-sec-head"><h3 class="q-sec-title">' + esc(title) + '</h3>' +
        (count != null ? '<span class="q-sec-count">' + esc(count) + '</span>' : '') +
        (headExtra || '') + '</div>' +
      (hint ? '<p class="q-sec-hint">' + esc(hint) + '</p>' : '') +
      inner +
    '</section>';
  }
  function cards(list, ctx, now, empty) {
    if (!list.length) return '<div class="q-empty">' + esc(empty || 'Nothing here.') + '</div>';
    return '<div class="q-cards">' + list.map(function (it) { return itemCard(it, ctx, now); }).join('') + '</div>';
  }

  var ALERT_LABEL = { declined: 'Declined', expired: 'No answer', no_candidate: 'Nobody free' };
  function alertRow(a) {
    var kind = a.item_kind === 'build' ? 'build' : 'service';
    var akey = 'alert:' + a.id;
    var busy = !!st.inflight[akey];
    var it = { kind: kind, id: a.item_id };
    var acts = '';
    if (isLeadOf(kind) && a.item_id != null) acts += btn('offer', it, 'Offer to…');
    acts += '<button type="button" class="text-btn q-btn" data-q-act="dismiss" data-q-alert="' + esc(a.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Working…' : 'Dismiss') + '</button>';
    return '<div class="q-alert q-alert-' + (ALERT_LABEL[a.kind] ? a.kind : 'other') + '">' +
      '<div class="q-alert-top"><span class="q-kind q-kind-' + (kind === 'build' ? 'build' : 'service') + '">' + esc(kind === 'build' ? 'Build' : 'Service') + '</span>' +
        '<span class="q-alert-kind">' + esc(ALERT_LABEL[a.kind] || 'Alert') + '</span>' +
        (a.item_code ? '<span class="q-code">' + esc(a.item_code) + '</span>' : '') +
        (a.created_at ? '<span class="q-when">' + esc(fmtRel(a.created_at)) + '</span>' : '') + '</div>' +
      (a.title ? '<div class="q-title">' + esc(a.title) + '</div>' : '') +
      '<div class="q-alert-body">' + esc(a.body || '') + '</div>' +
      '<div class="q-actions">' + acts + '</div>' +
    '</div>';
  }

  function levelLabel(l) { return l === 'senior' ? 'Senior' : l === 'junior' ? 'Junior' : ''; }

  function teamRow(p) {
    var cap = Math.max(0, num(p.capacity_points)), pts = Math.max(0, num(p.points));
    var pct = cap ? Math.min(100, Math.round(pts / cap * 100)) : 0;
    var full = cap && pts >= cap;
    var poolsTxt = [p.build_pool ? 'Builds' : '', p.service_pool ? 'Service' : ''].filter(Boolean).join(' · ') || 'Not in a pool';
    var items = (Array.isArray(p.items) ? p.items : []).map(function (i) {
      return '<span class="q-tag" title="' + esc(i.title || '') + '">' + esc((i.code || '') + (i.title ? ' · ' + i.title : '')) + '</span>';
    }).join('');
    var now = nowMs();
    var offers = (Array.isArray(p.offers) ? p.offers : []).map(function (o) {
      var exp = tsMs(o.expires_at);
      return '<span class="q-tag q-tag-offer">' + esc((o.code || '') + ' · offered' + (isFinite(exp) ? ', ' + fmtLeft(exp - now) + ' left' : '')) + '</span>';
    }).join('');
    var seen = [];
    if (p.last_seen_at) seen.push('Seen ' + fmtRel(p.last_seen_at));
    if (p.logs_today != null) seen.push(num(p.logs_today) + ' log' + (num(p.logs_today) === 1 ? '' : 's') + ' today');
    return '<div class="q-person">' +
      '<div class="q-person-who"><div class="q-person-name">' + esc(p.name || p.email || '—') + '</div>' +
        '<div class="q-person-sub">' + esc([p.designation, levelLabel(p.build_level), poolsTxt].filter(Boolean).join(' · ')) + '</div>' +
        (seen.length ? '<div class="q-person-sub">' + esc(seen.join(' · ')) + '</div>' : '') + '</div>' +
      '<div class="q-person-load"><div class="q-load' + (full ? ' full' : '') + '" role="img" aria-label="' + esc(pts + ' of ' + cap + ' points') + '"><i style="width:' + pct + '%"></i></div>' +
        '<div class="q-person-nums">' + esc(pts + '/' + cap + ' pts · ' + num(p.jobs) + '/' + num(p.max_jobs) + ' jobs') + '</div></div>' +
      '<div class="q-person-items">' + (items || offers ? items + offers : '<span class="q-muted">Nothing on their plate</span>') + '</div>' +
    '</div>';
  }

  function teamHtml() {
    if (st.teamLoading && !st.team) return '<div class="q-empty">Loading the team…</div>';
    if (st.teamErr && !st.team) return banner('Could not load the team: ' + errText(st.teamErr), 'error');
    var people = (st.team && Array.isArray(st.team.people)) ? st.team.people : [];
    if (!people.length) return '<div class="q-empty">Nobody is in a pool or holding work yet.</div>';
    return '<div class="q-team">' + people.map(teamRow).join('') + '</div>';
  }

  function notSentList() {
    if (!canReadKind('build') || !(st.filter === 'all' || st.filter === 'build')) return [];
    var pend = pendingSends();
    return tickets().filter(function (t) {
      if (!t || t.type === 'repair') return false;
      if (!isQuoteBuild(t)) return false;
      // Only builds the server knows about, or ones this PC is sending:
      // local-only practice tickets never reach the floor.
      return !!t.cloudSynced || pend.indexOf(t.id) !== -1;
    }).sort(function (a, b) { return (tsMs(a.deadline) || Infinity) - (tsMs(b.deadline) || Infinity); });
  }

  function notSentRow(t) {
    var pend = pendingSends().indexOf(t.id) !== -1;
    var it = { kind: 'build', id: t.id };
    var busy = !!st.inflight[busyKey('build', t.id)];
    var specs = t.specs || {};
    var canSend = hasRole('qc', 'desk');
    return '<div class="q-card q-k-build q-card-quote" data-q-kind="build" data-q-id="' + esc(t.id) + '">' +
      '<div class="q-card-top"><span class="q-kind q-kind-build">Build</span><span class="q-code">' + esc(String(t.id || '').slice(-6).toUpperCase()) + '</span></div>' +
      '<div class="q-title">' + esc(t.customerName || 'Build') + '</div>' +
      '<div class="q-sub">' + esc([specs.cpu, specs.gpu].filter(Boolean).join(' · ') || 'Specs not set') + '</div>' +
      (t.deadline ? '<div class="q-meta">Due ' + esc(fmtWhen(t.deadline, true)) + '</div>' : '') +
      '<div class="q-actions">' +
        (pend && !busy ? '<span class="q-why">Sending to the build queue…</span>' : '') +
        (canSend ? btn('send', it, 'Send to build queue', 'primary-pink-btn') : '') +
        (canOpenBuilds() ? btn('open', it, 'Open', 'text-btn') : '') +
      '</div>' +
    '</div>';
  }

  function setStat(text, breach) {
    var s = el('q-stat');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('has-breach', !!breach);
  }

  function render() {
    var root = el('q-root');
    if (!root) return;
    bindWho();
    renderToolbar();
    var html = [];
    var d = D();
    // Demo mode only swaps the SERVICE side for practice tickets; builds in the
    // feed are real (ops-data demoFeedWithBuilds) and can be worked as usual.
    if (isDemo()) {
      html.push(banner(canReadKind('build')
        ? 'Demo data is on: service tickets here are practice data (read-only). Builds are real — claim and work on them as usual.'
        : 'Demo data is on: service tickets here are practice data (read-only). Turn it off in Settings to work on real tickets.', 'demo'));
      if (st.feed && st.feed.builds_error) html.push(banner('The real builds could not be loaded: ' + String(st.feed.builds_error), 'warn'));
    }
    if (!profile()) { root.textContent = ''; setStat('—'); return; }
    if (!d || typeof d.workQueue !== 'function') {
      html.push(banner('The work queue needs the Neo OS 1.11 data layer. Restart Neo OS after the update finishes.', 'error'));
      root.innerHTML = html.join('');
      setStat('—');
      return;
    }
    if (!st.feed) {
      if (st.error) {
        html.push(banner('Could not load the queue: ' + errText(st.error), 'error'));
        html.push('<div class="q-empty"><button type="button" class="secondary-btn" data-q-tb="refresh">Try again</button></div>');
      } else {
        html.push('<div class="q-empty">Loading the queue…</div>');
      }
      root.innerHTML = html.join('');
      setStat(st.error ? 'offline' : '…');
      return;
    }
    if (st.error) html.push(banner('Showing the last answer — the queue could not refresh: ' + errText(st.error), 'warn'));

    var now = nowMs();
    var all = sortItems(st.feed.items.filter(matchesFilter), now);
    var offered = [], open = [], mine = [], reassign = [];
    all.forEach(function (it) {
      var live = offerLive(it, now);
      if (it.offered_to_me && live) offered.push(it);
      else if (it.mine) mine.push(it);
      else if (!isAssigned(it)) open.push(it);
      else if (live) reassign.push(it);
    });
    var p = pools();
    var leadAny = isLeadAny();

    if (offered.length) {
      html.push(section('offered', 'Offered to you', 'Accept to make it yours, or decline and say why. When the time is up it goes to someone else.',
        offered.length, cards(offered, 'offer', now)));
    }
    if (!st.mineOnly) {
      var hint = (p.build || p.service)
        ? 'Claim what suits you. Anything not claimed within ' + st.feed.claim_hours + ' hours is offered to whoever has the most room.'
        : 'Technicians claim from here. Anything not claimed within ' + st.feed.claim_hours + ' hours is offered by the app.';
      html.push(section('open', 'Open queue', hint, open.length, cards(open, 'open', now, 'Nothing is waiting. New builds and service tickets appear here.')));
      if (leadAny && reassign.length) {
        html.push(section('reassign', 'Being reassigned', 'Offered to someone else while its technician still has it.', reassign.length, cards(reassign, 'reassign', now)));
      }
    }
    if (mine.length || p.build || p.service) {
      html.push(section('mine', 'My work', null, mine.length, cards(mine, 'mine', now, 'Nothing on your plate. Claim something from the open queue.')));
    }
    if (!st.mineOnly) {
      var ns = notSentList();
      if (ns.length) {
        html.push(section('notsent', 'Not sent to the floor', 'Builds saved as quotes (usually from the website). Send one to the build queue when it is going ahead.',
          ns.length, '<div class="q-cards">' + ns.map(notSentRow).join('') + '</div>'));
      }
    }
    if (leadAny) {
      var alerts = myAlerts(st.feed);
      var teamBtn = '<button type="button" class="secondary-btn q-team-toggle" data-q-act="team" aria-pressed="' + (st.showTeam ? 'true' : 'false') + '">' + (st.showTeam ? 'Hide team' : 'Show team') + '</button>';
      html.push(section('lead', 'Needs a lead', 'Offers that were declined or not answered, and work nobody free can take.', alerts.length,
        alerts.length ? '<div class="q-alerts">' + alerts.map(alertRow).join('') + '</div>' : '<div class="q-empty">Nothing needs a lead right now.</div>', teamBtn));
      if (st.showTeam) html.push(section('team', 'Team', 'Load is points (build tier, or 1 per service job, 2 on-site) against each person’s capacity.', null, teamHtml()));
    }

    root.innerHTML = html.join('');
    var late = open.filter(function (it) { return claimRisk(it, now) >= 2; }).length;
    setStat(open.length + ' open' + (offered.length ? ' · ' + offered.length + ' offered to you' : '') +
      (mine.length ? ' · ' + mine.length + ' yours' : '') + (late ? ' · ' + late + ' overdue' : ''), late > 0 || offered.length > 0);
  }

  // ── team ──────────────────────────────────────────────────────────────────
  function loadTeam() {
    var d = D();
    if (!d || typeof d.workTeam !== 'function') { st.teamErr = new Error('The team view needs the latest Neo OS data layer.'); render(); return Promise.resolve(null); }
    var who = whoKey();
    var seq = ++st.teamSeq;
    st.teamLoading = true;
    if (active()) render();
    return Promise.resolve().then(function () { return d.workTeam(); }).then(function (res) {
      if (seq !== st.teamSeq || who !== whoKey()) return null;
      st.team = normaliseTeam(res); st.teamErr = null; st.teamLoading = false;
      if (active()) render();
      return st.team;
    }, function (e) {
      if (seq !== st.teamSeq || who !== whoKey()) return null;
      st.teamErr = e; st.teamLoading = false;
      if (active()) render();
      return null;
    });
  }
  function normaliseTeam(res) {
    if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = null; } }
    if (res && res.data && !res.people) res = res.data;
    res = (res && typeof res === 'object') ? res : {};
    var people = Array.isArray(res.people) ? res.people.filter(function (p) { return p && (p.email || p.name); }) : [];
    return { now: res.now || null, people: people, alerts: Array.isArray(res.alerts) ? res.alerts : [] };
  }

  // ── dialogs ───────────────────────────────────────────────────────────────
  function field(labelText, control, hint) {
    var lab = document.createElement('label');
    lab.className = 'ops-field ops-span2';
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(sp);
    lab.appendChild(control);
    if (hint) {
      var h = document.createElement('p');
      h.className = 'ops-hint';
      h.textContent = hint;
      lab.appendChild(h);
    }
    return lab;
  }

  // A reason dialog whose OK runs the action. run(reason) resolves true
  // (done, close), a string (shown inline, stays open) or false.
  function reasonAction(opts, run) {
    var ui = UI();
    if (!ui || typeof ui.dialog !== 'function') { toast('Dialogs are not available — restart Neo OS.', 'error'); return Promise.resolve(false); }
    var body = document.createElement('div');
    body.className = 'q-dlg';
    if (opts.text) {
      var p = document.createElement('p');
      p.className = 'ops-dialog-msg';
      p.textContent = opts.text;
      body.appendChild(p);
    }
    var ta = document.createElement('textarea');
    ta.maxLength = 300;
    ta.rows = 3;
    ta.placeholder = opts.placeholder || '';
    ta.className = 'q-reason-input';
    body.appendChild(field(opts.label || 'Reason', ta, opts.hint || 'Up to 300 characters.'));
    return ui.dialog({
      title: opts.title, sub: opts.sub || '', body: body,
      okText: opts.okText || 'OK', busyText: opts.busyText || 'Working…', danger: !!opts.danger,
      onOk: function () {
        var reason = String(ta.value || '').trim();
        if (!reason) return opts.required || 'Say why.';
        if (reason.length > 300) return 'Keep the reason under 300 characters.';
        return run(reason);
      }
    });
  }

  // {ok:false, reason} answers → a sentence (C12 return shapes).
  function resultText(res) {
    if (!res || typeof res !== 'object') return 'Something went wrong. Refresh and try again.';
    var exp = tsMs(res.expires_at);
    switch (res.reason) {
      case 'offered': return 'Offered to ' + (res.to_name || 'someone') + (isFinite(exp) ? ' until ' + hhmm(exp) : '') + ' — only they can take it now.';
      case 'taken': return (res.by || 'Someone') + ' took it first.';
      case 'changed': return 'It changed meanwhile' + (res.by ? ' — ' + res.by + ' has it now' : '') + '. Look again before you offer it.';
      case 'not_queued': return 'It isn’t in the build queue any more.';
      case 'closed': return 'This one is finished.';
      case 'not_found': return 'That item no longer exists.';
      // Timed out, declined, or the app's own offer withdrawn: all 'expired'.
      case 'expired': return 'This offer has ended.';
      case 'not_offered': return 'It isn’t offered to you any more.';
      case 'not_eligible': return res.why || 'You can’t take this one.';
      case 'assigned': return 'It already has a technician.';
      default: return res.message || ('That did not work' + (res.reason ? ' (' + res.reason + ')' : '') + '. Refresh and try again.');
    }
  }

  function itemInfo(kind, id) {
    var it = null;
    (st.feed && st.feed.items || []).forEach(function (x) { if (!it && x.kind === kind && String(x.id) === String(id)) it = x; });
    var t = kind === 'build' ? localTicket(id) : null;
    var code = (it && it.code) || String(id || '').slice(-6).toUpperCase();
    var title = (it && it.title) || (t && t.customerName) || '';
    var tier = (it && it.build_tier) || (t ? buildTierOf(t.specs || {}) : 1);
    var expected = (it && it.assignee_email) || (t && t.technicianEmail) || '';
    var offer = null;
    if (it && it.offer && offerLive(it)) offer = { to_email: it.offer.to_email, to_name: it.offer.to_name, expires_at: it.offer.expires_at };
    else if (t && t.offer && isFinite(tsMs(t.offer.expiresAt)) && tsMs(t.offer.expiresAt) > nowMs()) {
      offer = { to_email: t.offer.toEmail, to_name: t.offer.toName, expires_at: t.offer.expiresAt };
    }
    var assigneeName = (it && it.assignee_name) || (t && t.technician) || '';
    return { item: it, ticket: t, code: code, title: title, tier: num(tier, 1) || 1, expected: lower(expected), offer: offer, assigneeName: assigneeName };
  }

  function setBusy(key, on) {
    if (on) st.inflight[key] = true; else delete st.inflight[key];
    if (active()) render();
  }

  // After any action: refresh the queue (coalesced) and the build's local copy.
  function afterAction(kind, id) {
    scheduleRefetch();
    if (kind === 'build' && typeof refreshTicketFromCloud === 'function') {
      Promise.resolve().then(function () { return refreshTicketFromCloud(id); }).then(null, function () { return null; });
    }
  }

  function needFn(d, name) {
    if (d && typeof d[name] === 'function') return true;
    toast('This needs the Neo OS 1.11 data layer. Restart Neo OS after the update.', 'error');
    return false;
  }

  // Offer dialog, shared by the queue and the ticket modal (app.js).
  // Service: service.js's own Offer dialog (C12). Build: ours, on work_team.
  function offerDialog(kind, id) {
    var key = busyKey(kind, id);
    if (kind === 'service') {
      var sv = SV();
      if (sv && typeof sv.offer === 'function') {
        return Promise.resolve().then(function () { return sv.offer(id); }).then(function (r) {
          afterAction('service', id);
          return r;
        }, function (e) { toastErr(e); return false; });
      }
      toast('Open the ticket in Service to offer it to someone.', 'info');
      return Promise.resolve(false);
    }
    return buildOfferDialog(id, key);
  }

  function personLabel(p, tier, info) {
    var cap = num(p.capacity_points), max = num(p.max_jobs);
    var pts = num(p.points), jobs = num(p.jobs);
    var cost = Math.min(5, Math.max(1, num(tier, 1)));
    var bits = [levelLabel(p.build_level), pts + '/' + cap + ' pts', jobs + '/' + max + ' jobs'].filter(Boolean);
    var label = (p.name || p.email) + ' — ' + bits.join(' · ');
    if (info.expected && lower(p.email) === info.expected) label += ' · has it now';
    else if ((cap && pts + cost > cap) || (max && jobs + 1 > max)) label += ' · full';
    return label;
  }

  async function buildOfferDialog(id, key) {
    key = key || busyKey('build', id);
    var who = whoKey();
    var d = D(), ui = UI();
    if (!isLeadOf('build')) { toast('Only a Builds lead can offer work to a technician.', 'warning'); return false; }
    if (!needFn(d, 'workTeam') || !needFn(d, 'workOffer')) return false;
    if (!ui || typeof ui.dialog !== 'function') { toast('Dialogs are not available — restart Neo OS.', 'error'); return false; }
    if (st.inflight[key]) return false;
    var info = itemInfo('build', id);
    setBusy(key, true);
    var team;
    try { team = normaliseTeam(await d.workTeam()); }
    catch (e) { setBusy(key, false); if (who === whoKey()) toastErr(e, 'Could not load the team:'); return false; }
    setBusy(key, false);
    if (who !== whoKey()) return false;
    if (team.now) st.offsetMs = computeOffset(team.now, Date.now());
    var people = team.people.map(function (p) {
      var probe = p;
      // A server without the role keys (pre-C12) must not grey everyone out:
      // the server re-checks every offer anyway.
      if (probe.qc_role === undefined) probe = Object.assign({}, p, { qc_role: num(p.tier) >= 3 ? 'lead' : 'tech' });
      var why = whyNot(probe, 'build', info.tier);
      return { p: p, why: why, room: num(p.capacity_points) - num(p.points) };
    });
    people.sort(function (a, b) {
      if (!!a.why !== !!b.why) return a.why ? 1 : -1;
      return b.room - a.room || String(a.p.name || '').localeCompare(String(b.p.name || ''));
    });

    var body = document.createElement('div');
    body.className = 'q-dlg ops-grid';
    var lead = document.createElement('p');
    lead.className = 'ops-dialog-msg ops-span2';
    lead.textContent = (info.assigneeName ? 'Now with ' + info.assigneeName + '. They keep it until the person you choose accepts. ' : '') +
      'The person you choose has until about ' + hhmm(nowMs() + OFFER_MINUTES * 60000) + ' to accept or decline.' +
      (info.tier >= 4 ? ' This is a high-value build: only senior builders can take it.' : '');
    body.appendChild(lead);
    if (info.offer) {
      var warn = document.createElement('div');
      warn.className = 'ops-banner ops-banner-warn ops-span2';
      warn.textContent = 'Offered to ' + (info.offer.to_name || info.offer.to_email || 'someone') + ' until ' + hhmm(tsMs(info.offer.expires_at)) +
        '. Offering it to someone else withdraws that offer first.';
      body.appendChild(warn);
    }
    var sel = document.createElement('select');
    sel.className = 'q-offer-person';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = people.length ? '— Choose a person —' : 'Nobody is in the build pool yet';
    sel.appendChild(ph);
    people.forEach(function (x) {
      var o = document.createElement('option');
      o.value = lower(x.p.email);
      var mine = info.expected && lower(x.p.email) === info.expected;
      o.textContent = personLabel(x.p, info.tier, info) + (x.why ? ' — ' + whySentence(x.why, 'build', false) : '');
      o.disabled = !!x.why || !!mine;
      sel.appendChild(o);
    });
    body.appendChild(field('Offer to', sel, 'Greyed-out people cannot take this build; the reason is on their line.'));
    var ta = document.createElement('textarea');
    ta.maxLength = 300;
    ta.rows = 3;
    ta.placeholder = 'Why them? They will see this.';
    body.appendChild(field('Reason', ta, 'Required. Up to 300 characters.'));

    var ok = await ui.dialog({
      title: 'Offer ' + info.code + ' to a technician',
      sub: info.title,
      body: body,
      okText: info.offer ? 'Withdraw and offer' : 'Offer',
      busyText: 'Offering…',
      onOk: async function () {
        var k = key;
        if (who !== whoKey()) return false;
        var email = sel.value;
        var reason = String(ta.value || '').trim();
        if (!email) return 'Choose who to offer it to.';
        if (!reason) return 'Say why you’re offering it to them.';
        if (reason.length > 300) return 'Keep the reason under 300 characters.';
        st.inflight[k] = true;
        try {
          if (info.offer && lower(info.offer.to_email) !== email) {
            var w = await d.workOffer('build', id, '', '', info.expected);
            if (who !== whoKey()) return false;
            if (w && w.ok === false) return resultText(w);
          }
          var res = await d.workOffer('build', id, email, reason, info.expected);
          if (who !== whoKey()) return false;
          if (res && res.ok === false) return resultText(res);
          var chosen = people.filter(function (x) { return lower(x.p.email) === email; })[0];
          var nm = chosen ? (chosen.p.name || chosen.p.email) : email;
          var exp = tsMs(res && res.item && res.item.offer && res.item.offer.expires_at);
          if (!isFinite(exp)) exp = nowMs() + OFFER_MINUTES * 60000;
          toast(res && res.unchanged ? nm + ' already has this build.' : 'Offered to ' + nm + ' — they have until ' + hhmm(exp) + ' to accept.', 'success');
          return true;
        } finally {
          delete st.inflight[k];
        }
      }
    });
    if (who === whoKey()) afterAction('build', id);
    return !!ok;
  }

  // ── build actions (the queue's cards and the ticket modal) ────────────────
  async function buildAction(act, id) {
    var key = busyKey('build', id);
    var who = whoKey();
    var d = D();
    if (!profile()) return false;
    if (st.inflight[key]) return false;
    var info = itemInfo('build', id);
    var done = false;
    try {
      if (act === 'offer') return buildOfferDialog(id, key);

      if (act === 'claim' || act === 'accept') {
        if (!needFn(d, act === 'claim' ? 'workClaim' : 'workRespond')) return false;
        setBusy(key, true);
        var res;
        try {
          res = act === 'claim'
            ? await d.workClaim('build', id, null, null)
            : await d.workRespond('build', id, true, null, null, null);
        } catch (e) { if (who === whoKey()) toastErr(e); return false; }
        finally { setBusy(key, false); }
        if (who !== whoKey()) return false;
        if (res && res.ok === false) { toast(resultText(res), 'warning', 8000); return false; }
        toast(res && res.already ? 'It’s already yours.' : (info.code + ' is yours — it’s on your bench now.'), 'success');
        done = true;
        return true;
      }

      if (act === 'decline') {
        if (!needFn(d, 'workRespond')) return false;
        done = await reasonAction({
          title: 'Decline ' + info.code, sub: info.title, label: 'Why can’t you take it?',
          placeholder: 'For example: already on two builds due today', okText: 'Decline', busyText: 'Declining…',
          required: 'Say why you can’t take it.'
        }, async function (reason) {
          if (who !== whoKey()) return false;
          var r = await d.workRespond('build', id, false, reason, null, null);
          if (who !== whoKey()) return false;
          if (r && r.ok === false) return resultText(r);
          toast('Declined. A lead has been told why.', 'info');
          return true;
        });
        return done;
      }

      if (act === 'release') {
        if (!needFn(d, 'workRelease')) return false;
        done = await reasonAction({
          title: 'Hand back ' + info.code, sub: info.title, label: 'Why are you handing it back?',
          text: 'It goes back to the build queue for someone else to claim.',
          okText: 'Hand back', busyText: 'Handing back…', danger: true,
          required: 'Say why you’re handing it back.'
        }, async function (reason) {
          if (who !== whoKey()) return false;
          var r = await d.workRelease('build', id, reason);
          if (who !== whoKey()) return false;
          if (r && r.ok === false) return resultText(r);
          toast(info.code + ' is back in the build queue.', 'info');
          return true;
        });
        return done;
      }

      if (act === 'withdraw') {
        if (!needFn(d, 'workOffer')) return false;
        var nm = info.offer ? (info.offer.to_name || info.offer.to_email) : '';
        var yes = UI() && typeof UI().confirm === 'function'
          ? await UI().confirm('Withdraw the offer of ' + info.code + (nm ? ' to ' + nm : '') + '?', { title: 'Withdraw offer', okText: 'Withdraw' })
          : true;
        if (!yes || who !== whoKey()) return false;
        setBusy(key, true);
        var w;
        try { w = await d.workOffer('build', id, '', '', info.expected); }
        catch (e) { if (who === whoKey()) toastErr(e); return false; }
        finally { setBusy(key, false); }
        if (who !== whoKey()) return false;
        if (w && w.ok === false) { toast(resultText(w), 'warning', 8000); return false; }
        toast(w && w.withdrawn === false ? 'There was no live offer to withdraw.' : 'Offer withdrawn.', 'info');
        done = true;
        return true;
      }

      if (act === 'send') {
        if (!needFn(d, 'buildQueueSend')) return false;
        setBusy(key, true);
        var s;
        try { s = await d.buildQueueSend(id); }
        catch (e) { if (who === whoKey()) toastErr(e); return false; }
        finally { setBusy(key, false); }
        if (who !== whoKey()) return false;
        if (s && s.ok === false) {
          if (s.reason === 'not_found') toast('The server doesn’t have this build yet. It is sent as soon as it uploads.', 'warning', 8000);
          else toast(resultText(s), 'warning', 8000);
          if (s.reason === 'assigned' || s.reason === 'closed') dropPending(id);
          return false;
        }
        dropPending(id);
        toast(s && s.already ? 'It was already in the build queue.' : info.code + ' is in the build queue — technicians can claim it now.', 'success');
        done = true;
        return true;
      }
      return false;
    } finally {
      if (done && who === whoKey()) afterAction('build', id);
    }
  }

  function dropPending(id) {
    if (typeof removePendingQueueSend === 'function') {
      try { removePendingQueueSend(id); } catch (e) { /* the drain will drop it */ }
    }
  }

  // Service actions all go through service.js (C12).
  function serviceAction(act, id) {
    var key = busyKey('service', id);
    var sv = SV();
    var map = { claim: 'claim', accept: 'respond', decline: 'respond', release: 'release', offer: 'offer', open: 'openJob' };
    var fn = map[act];
    if (!sv || !fn || typeof sv[fn] !== 'function') {
      toast('Open the ticket in Service to do that.', 'info');
      return Promise.resolve(false);
    }
    if (act === 'open') { try { sv.openJob(id); } catch (e) { toastErr(e); } return Promise.resolve(true); }
    if (st.inflight[key]) return Promise.resolve(false);
    var who = whoKey();
    setBusy(key, true);
    return Promise.resolve().then(function () {
      if (act === 'accept') return sv.respond(id, true);
      if (act === 'decline') return sv.respond(id, false);
      return sv[fn](id);
    }).then(function (r) {
      setBusy(key, false);
      if (who === whoKey()) afterAction('service', id);
      return r;
    }, function (e) {
      setBusy(key, false);
      if (who === whoKey()) toastErr(e);
      return false;
    });
  }

  async function dismissAlert(alertId) {
    var key = 'alert:' + alertId;
    var who = whoKey();
    var d = D();
    if (!needFn(d, 'workAlertResolve') || st.inflight[key]) return;
    setBusy(key, true);
    try {
      var r = await d.workAlertResolve(Number(alertId));
      if (who !== whoKey()) return;
      if (r && r.ok === false) toast(resultText(r), 'warning');
      else if (st.feed) st.feed.alerts = st.feed.alerts.filter(function (a) { return String(a.id) !== String(alertId); });
    } catch (e) {
      if (who === whoKey()) toastErr(e);
    } finally {
      setBusy(key, false);
      if (who === whoKey()) { if (st.feed) afterFeed(st.feed); scheduleRefetch(); }
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  function onRootClick(e) {
    var tb = e.target.closest('[data-q-tb]');
    if (tb && tb.getAttribute('data-q-tb') === 'refresh') { manualRefresh(); return; }
    var b = e.target.closest('[data-q-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-q-act');
    var kind = b.getAttribute('data-q-kind') || '';
    var id = b.getAttribute('data-q-id') || '';
    if (act === 'team') {
      st.showTeam = !st.showTeam;
      if (st.showTeam) loadTeam(); else render();
      return;
    }
    if (act === 'dismiss') { dismissAlert(b.getAttribute('data-q-alert')); return; }
    if (!id || (kind !== 'build' && kind !== 'service')) return;
    if (act === 'bench') {
      if (typeof switchScreen === 'function') {
        var sel = el('welcome-ticket-select');
        if (sel) sel.value = id;
        switchScreen('client-console', id);
      }
      return;
    }
    if (act === 'open' && kind === 'build') {
      if (typeof openTicketModal === 'function' && canOpenBuilds()) openTicketModal(id);
      else toast('Builds open from the Builds screen.', 'info');
      return;
    }
    if (kind === 'service') { serviceAction(act, id); return; }
    buildAction(act, id);
  }

  function manualRefresh() {
    st.loading = true;
    renderToolbar();
    var p = fetchFeed();
    if (st.showTeam) loadTeam();
    Promise.resolve(p).then(function () { st.loading = false; if (active()) render(); });
  }

  function onToolbarClick(e) {
    var f = e.target.closest('[data-q-filter]');
    if (f) {
      st.filter = f.getAttribute('data-q-filter') || 'all';
      writePrefs();
      render();
      return;
    }
    var r = e.target.closest('[data-q-tb]');
    if (r && r.getAttribute('data-q-tb') === 'refresh' && !r.disabled) manualRefresh();
  }
  function onToolbarChange(e) {
    if (e.target && e.target.id === 'q-mine') {
      st.mineOnly = !!e.target.checked;
      writePrefs();
      render();
    }
  }

  var inited = false;
  function init() {
    if (inited) return;
    var root = el('q-root');
    var tb = el('q-toolbar');
    if (!root) return;
    inited = true;
    readPrefs();
    root.addEventListener('click', onRootClick);
    if (tb) {
      tb.addEventListener('click', onToolbarClick);
      tb.addEventListener('change', onToolbarChange);
    }
  }

  // ── public ────────────────────────────────────────────────────────────────
  function ensureLoaded() {
    init();
    bindWho();
    render();
    startActiveTimers();
    startBackground();
    return fetchFeed().then(function () { if (active()) render(); return true; });
  }

  // Sign-out: everything this module holds goes, every timer stops. Dialogs
  // are NeoQcUI dialogs, which app.js closeSessionOverlays closes (closeAll).
  function reset() {
    stopActiveTimers();
    stopBackground();
    if (st.debounce) { clearTimeout(st.debounce); st.debounce = null; }
    clearSession();
    st.who = null;
  }

  var dataBound = false;
  function bindData() {
    var d = D();
    if (dataBound || !d || typeof d.on !== 'function') return;
    dataBound = true;
    try { d.on('work', function () { if (profile() && (active() || canUseQueue())) scheduleRefetch(); }); }
    catch (e) { console.warn('[queue] cannot listen for work changes:', e && e.message); }
    try { d.on('jobs', function () { if (active()) scheduleRefetch(); }); }
    catch (e) { console.warn('[queue] cannot listen for job changes:', e && e.message); }
  }

  function boot() {
    bindData();
    window.addEventListener('neo-builds-changed', function () {
      if (!active()) return;
      render();              // "Not sent to the floor" reads appState now
      scheduleRefetch();
    });
    // A sign-in (routeByTier refreshes the module roles) or a role change.
    window.addEventListener('neo-modules-changed', function () {
      if (!profile()) { reset(); return; }
      bindWho();
      startBackground();
      if (!canUseQueue()) setDot(false);
      else if (st.feed) afterFeed(st.feed);
    });
  }

  window.NeoQcQueue = {
    ensureLoaded: ensureLoaded,
    refresh: function () { return fetchFeed(); },
    render: render,
    offerDialog: offerDialog,
    buildAction: buildAction,
    resultText: resultText,
    startBackground: startBackground,
    stopBackground: stopBackground,
    reset: reset,
    nowMs: nowMs,
    isActive: active,
    // for the dev harness and the checks
    _state: function () { return st; },
    _tick: bgTick
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
