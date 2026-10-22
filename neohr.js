/*
  Neo OS — NeoHR, the people side of Neo OS (window.NeoQcHr). New in 1.11.

  NeoHR is a module of Neo OS: the phone app every technician carries (their
  work queue, jobs on site, work logs and a simple dashboard) and this screen
  for heads and HR. One Neo OS account signs in to both.

  Four tabs, all READ-ONLY:
    Team today      who is at work: last seen, logs today, site visits, load
                    and what each person holds (work_team + today's
                    work_log_team + today's tech_activity; the tiles come from
                    neo_dashboard when the server has it).
    Work logs       everyone's (or one person's) logs for a date range
                    (work_log_team), newest first, grouped by day.
    Field activity  claims, hand-backs, site visits and their outcomes and
                    punches per person for the same range (tech_activity).
    NeoHR app       the latest NeoHR release on GitHub, its download link
                    (opened in the system browser) and how to install it.

  Who may open it: tier 3+ or a NeoHR lead (modules.js). The server decides
  what each read returns; a source this person may not read says so in a
  banner and the rest of the screen still works.

  RULES (as queue.js): every async load binds who is signed in first and
  drops an answer that lands after a sign-out or a change of person; every
  server string goes through esc() or textContent; nothing here writes, so
  demo mode needs no gate; sign-out (reset) stops the timer and clears
  everything. Days are shop days (India time), as the server counts them.

  Loaded after queue.js and before shell.js. Uses app.js globals only through
  typeof / appGlobal guards.
*/
(function () {
  'use strict';

  var DAY = 86400000;
  var IST_MS = 330 * 60000;          // India has no daylight saving: a fixed +05:30
  var TEAM_REFRESH_MS = 60000;       // Team today, while it is on show
  var DEBOUNCE_MS = 400;
  var MAX_SPAN_DAYS = 62;            // work_log_team's limit; Field activity uses the same range
  var PREF_KEY = 'neo_hr_prefs';
  var TABS = [['team', 'Team today'], ['logs', 'Work logs'], ['activity', 'Field activity'], ['app', 'NeoHR app']];
  var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days']];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function D() { return window.NeoQcData || null; }
  function UI() { return window.NeoQcUI || null; }
  function M() { return window.NeoQcModules || null; }
  function el(id) { return document.getElementById(id); }
  function appGlobal(read) { try { return read(); } catch (e) { return undefined; } }
  function profile() {
    return appGlobal(function () { return typeof currentProfile !== 'undefined' ? currentProfile : null; }) || null;
  }
  function whoKey() { var p = profile(); return p ? String(p.id || p.email || '') : ''; }
  function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function tsMs(v) { var n = v ? Date.parse(v) : NaN; return isFinite(n) ? n : NaN; }
  function pad2(n) { return String(n).padStart(2, '0'); }

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
    return null;
  }
  function errText(e) {
    var ui = UI();
    if (ui && typeof ui.errText === 'function') { try { return ui.errText(e); } catch (x) { /* plain below */ } }
    return (e && e.message) ? String(e.message).replace(/^NEO_[A-Z_]+:\s*/, '') : String(e);
  }
  function banner(text, kind) {
    var ui = UI();
    if (ui && typeof ui.banner === 'function') return ui.banner(text, kind);
    return '<div class="ops-banner ops-banner-' + (kind || 'info') + '">' + esc(text) + '</div>';
  }
  function isDemo() {
    var d = D();
    try { return !!(d && typeof d.isDemo === 'function' && d.isDemo()); } catch (e) { return false; }
  }
  function canOpen() {
    var m = M();
    if (!profile() || !m || typeof m.canOpen !== 'function') return false;
    try { return !!m.canOpen('neohr'); } catch (e) { return false; }
  }
  function active() { var s = el('neohr-screen'); return !!(s && s.classList.contains('active')); }

  // ── shop days and times (India time, as the server counts them) ───────────
  // The server's clock where we have it (the last work_queue / work_team
  // answer), so "today" flips at the shop's midnight even on a PC that is off.
  function nowMs() {
    var d = D(), off = 0;
    if (d && typeof d.workOffsetMs === 'function') { try { off = num(d.workOffsetMs(), 0); } catch (e) { off = 0; } }
    return Date.now() + off;
  }
  function istDay(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
  function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
  function spanDays(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY); }
  function validDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && isFinite(Date.parse(s + 'T00:00:00Z')); }
  function istHm(iso) {
    var t = tsMs(iso);
    if (!isFinite(t)) return '—';
    var d = new Date(t + IST_MS);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }
  function dayOf(iso) { var t = tsMs(iso); return isFinite(t) ? istDay(t) : ''; }
  function dayLabel(day, today) {
    if (!validDay(day)) return String(day || '');
    if (day === today) return 'Today';
    if (day === addDays(today, -1)) return 'Yesterday';
    var d = new Date(Date.parse(day + 'T00:00:00Z'));
    var s = WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    return day.slice(0, 4) === today.slice(0, 4) ? s : s + ' ' + day.slice(0, 4);
  }
  function shortDate(iso) {
    var t = tsMs(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t + IST_MS);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function fmtRel(iso) {
    var ui = UI();
    if (!iso) return '';
    return ui && typeof ui.fmtRelative === 'function' ? ui.fmtRelative(iso, nowMs()) : istHm(iso);
  }
  function fmtBytes(n) {
    n = num(n, 0);
    if (n <= 0) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' bytes';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  // ── state ─────────────────────────────────────────────────────────────────
  function freshSlots() {
    var s = {};
    ['team', 'dash', 'todayLogs', 'todayAct', 'logs', 'act', 'app'].forEach(function (k) {
      s[k] = { val: null, err: null, loading: false, seq: 0, key: null, at: 0 };
    });
    return s;
  }
  var st = {
    who: null,
    tab: 'team',
    preset: 'today', from: null, to: null,     // the range shared by Work logs and Field activity
    person: '',                                // '' = everyone; a lower-cased email otherwise
    search: '',
    expanded: {},                              // Field activity: email -> its days are open
    openLogs: {},                              // Work logs: id -> the full description is shown
    slots: freshSlots(),
    timer: null, debounce: null, dateTimer: null, workTimer: null,
    filterSig: null, peopleSig: null, kp: null
  };

  function readPrefs() {
    try {
      var o = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      if (o && typeof o === 'object') {
        if (TABS.some(function (t) { return t[0] === o.tab; })) st.tab = o.tab;
        if (PRESETS.some(function (p) { return p[0] === o.preset; })) st.preset = o.preset;
      }
    } catch (e) { /* storage blocked: defaults */ }
  }
  function writePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: st.tab, preset: st.preset === 'custom' ? 'today' : st.preset })); } catch (e) { /* not kept */ }
  }

  // A different person at this PC starts from nothing.
  function bindWho() {
    var k = whoKey();
    if (k === st.who) return;
    clearSession();
    st.who = k;
  }
  function clearSession() {
    st.slots = freshSlots();
    st.person = ''; st.search = ''; st.expanded = {}; st.openLogs = {};
    st.preset = 'today'; st.from = null; st.to = null;
    st.filterSig = null; st.peopleSig = null; st.kp = null;
    if (st.debounce) { clearTimeout(st.debounce); st.debounce = null; }
    if (st.dateTimer) { clearTimeout(st.dateTimer); st.dateTimer = null; }
    if (st.workTimer) { clearTimeout(st.workTimer); st.workTimer = null; }
    var root = el('hr-root'); if (root) root.textContent = '';
    var tb = el('hr-toolbar'); if (tb) { tb.textContent = ''; delete tb.dataset.sig; }
    var stat = el('hr-stat'); if (stat) stat.textContent = '—';
  }

  // ── the date range ────────────────────────────────────────────────────────
  function today() { return istDay(nowMs()); }
  function range() {
    var t = today();
    if (st.preset === 'today') return { from: t, to: t };
    if (st.preset === 'yesterday') { var y = addDays(t, -1); return { from: y, to: y }; }
    if (st.preset === '7d') return { from: addDays(t, -6), to: t };
    if (st.preset === '30d') return { from: addDays(t, -29), to: t };
    var f = validDay(st.from) ? st.from : t, to = validDay(st.to) ? st.to : f;
    return { from: f, to: to };
  }
  function rangeError(r) {
    if (r.to < r.from) return 'The end date is before the start date.';
    if (spanDays(r.from, r.to) > MAX_SPAN_DAYS - 1) return 'Ask for at most ' + MAX_SPAN_DAYS + ' days at a time.';
    return null;
  }
  function rangeLabel(r) {
    var t = today();
    if (r.from === r.to) return dayLabel(r.from, t);
    return dayLabel(r.from, t) + ' – ' + dayLabel(r.to, t);
  }

  // ── loading ───────────────────────────────────────────────────────────────
  // One slot per source. An answer is kept only if it is still for the same
  // person and the newest request of that slot.
  function run(name, key, fn) {
    var s = st.slots[name];
    var who = whoKey();
    var seq = ++s.seq;
    if (s.key !== key) { s.val = null; s.err = null; }
    s.key = key;
    s.loading = true;
    paint();
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) {
      if (s.seq !== seq || who !== whoKey() || st.slots[name] !== s) return null;
      // The data layer marks an answer meant for an earlier sign-in or demo
      // state: not ours, keep what we had.
      if (v && typeof v === 'object' && v.superseded === true) { s.loading = false; paint(); return null; }
      s.val = v; s.err = null; s.loading = false; s.at = Date.now();
      paint();
      return v;
    }, function (e) {
      if (s.seq !== seq || who !== whoKey() || st.slots[name] !== s) return null;
      s.err = e || new Error('Something went wrong.'); s.loading = false;
      paint();
      return null;
    });
  }
  function need(name) {
    var d = D();
    if (d && typeof d[name] === 'function') return d;
    throw new Error('This needs the Neo OS 1.11 data layer. Restart Neo OS after the update finishes.');
  }

  function loadTeamToday() {
    var t = today();
    var jobs = [
      run('team', 'team', function () { return need('workTeam').workTeam(); }),
      run('todayLogs', 'logs|' + t, function () { return need('workLogTeam').workLogTeam(t, t, null); }),
      run('todayAct', 'act|' + t, function () { return need('techActivity').techActivity(t, t); }),
      // The server's dashboard numbers, when it has them (neo_dashboard is
      // newer than work_team; without it the tiles are counted here).
      run('dash', 'dash', function () { return need('neoDashboard').neoDashboard(); }),
      // The app strip: cached for 15–30 minutes by the data layer, and never
      // forced from here (GitHub allows 60 reads an hour per network).
      loadApp(false)
    ];
    return Promise.all(jobs);
  }
  // The person picker names everyone the team view knows; asked once.
  function ensureTeamForPicker() {
    var s = st.slots.team;
    if (!s.val && !s.loading && !s.err) run('team', 'team', function () { return need('workTeam').workTeam(); });
  }
  function loadLogs() {
    var r = range();
    if (rangeError(r)) { paint(); return Promise.resolve(null); }
    var key = 'logs|' + r.from + '|' + r.to + '|' + st.person;
    var person = st.person;
    ensureTeamForPicker();
    return run('logs', key, function () { return need('workLogTeam').workLogTeam(r.from, r.to, person || null); });
  }
  function loadAct() {
    var r = range();
    if (rangeError(r)) { paint(); return Promise.resolve(null); }
    ensureTeamForPicker();
    return run('act', 'act|' + r.from + '|' + r.to, function () { return need('techActivity').techActivity(r.from, r.to); });
  }
  function loadApp(force) {
    return run('app', 'app', function () {
      var d = D();
      if (!d || typeof d.latestNeoHrRelease !== 'function') throw new Error('This needs the Neo OS 1.11 data layer. Restart Neo OS after the update finishes.');
      return d.latestNeoHrRelease({ force: !!force });
    });
  }
  function loadTab(force) {
    if (!profile()) return Promise.resolve(null);
    if (st.tab === 'team') return loadTeamToday();
    if (st.tab === 'logs') return loadLogs();
    if (st.tab === 'activity') return loadAct();
    return loadApp(force);
  }

  // ── the data, merged per person ───────────────────────────────────────────
  function teamPeople() {
    var v = st.slots.team.val;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    return (v && Array.isArray(v.people)) ? v.people.filter(function (p) { return p && (p.email || p.name); }) : [];
  }
  function teamAlerts() {
    var v = st.slots.team.val;
    return (v && Array.isArray(v.alerts)) ? v.alerts : [];
  }
  function rowsOf(name) {
    var v = st.slots[name].val;
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return Array.isArray(v.rows) ? v.rows : [];
  }

  // Names of everyone this screen has heard of: the team, the logs and the
  // activity it loaded, and (outside demo mode) the staff list. Worked out
  // once per paint (render() clears st.kp).
  function knownPeople() {
    if (st.kp) return st.kp;
    st.kp = buildKnownPeople();
    return st.kp;
  }
  function buildKnownPeople() {
    var map = {};
    function add(email, name) {
      var e = lower(email);
      if (!e) return;
      var n = String(name || '').trim();
      if (!map[e] || (n && map[e] === e)) map[e] = n || e;
    }
    teamPeople().forEach(function (p) { add(p.email, p.name); });
    ['todayLogs', 'logs'].forEach(function (k) { rowsOf(k).forEach(function (r) { add(r.employee_email, r.employee_name); }); });
    ['todayAct', 'act'].forEach(function (k) { rowsOf(k).forEach(function (r) { add(r.employee_email, r.employee_name); }); });
    var d = D();
    if (d && typeof d.staff === 'function' && !isDemo()) {
      try { (d.staff() || []).forEach(function (s) { if (s && s.active !== false) add(s.email, s.full_name); }); } catch (e) { /* the others still list */ }
    }
    if (st.person && !map[st.person]) map[st.person] = st.person;
    return Object.keys(map).map(function (e) { return { email: e, name: map[e] }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name) || a.email.localeCompare(b.email); });
  }
  function nameOf(email) {
    var e = lower(email);
    var list = knownPeople();
    for (var i = 0; i < list.length; i++) if (list[i].email === e) return list[i].name;
    return e;
  }

  // tech_activity also counts what a lead did to a person: a hand-back by a
  // lead, an assignment (a legacy service_assign, an accepted offer, which
  // the server writes as the lead's), or deactivation releasing their work.
  // Every claim / release / assign event lands in claims, releases,
  // released_by_lead or manager_assigns; every field-activity row (visits,
  // punches, and the notes and photos no key counts) is the person's own.
  // So a row is the person's own doing when an own key counts something, or
  // when nothing at all is counted; and its last_at is their own time only
  // when no lead's event is in the row.
  var ACT_OWN = ['claims', 'releases', 'visits_left', 'visits_arrived', 'visits_done', 'revisits', 'parts_needed',
                 'customer_absent', 'punch_ins', 'punch_outs'];
  var ACT_BY_LEAD = ['released_by_lead', 'manager_assigns'];
  function actCount(a, keys) { return keys.reduce(function (s, k) { return s + Math.max(0, num(a[k])); }, 0); }
  function actPresence(a) {
    if (!a) return { own: false, lastAt: NaN };
    var own = actCount(a, ACT_OWN), lead = actCount(a, ACT_BY_LEAD);
    var isOwn = own > 0 || lead === 0;
    return { own: isOwn, lastAt: isOwn && lead === 0 ? tsMs(a.last_at) : NaN };
  }

  function todayPeople() {
    var t = today();
    var map = {};
    function get(email, name) {
      var e = lower(email);
      if (!e) return null;
      if (!map[e]) map[e] = { email: e, name: '', team: null, logs: [], act: null };
      if (name && !map[e].name) map[e].name = String(name);
      return map[e];
    }
    teamPeople().forEach(function (p) { var x = get(p.email, p.name); if (x) x.team = p; });
    rowsOf('todayLogs').forEach(function (r) { var x = get(r.employee_email, r.employee_name); if (x) x.logs.push(r); });
    rowsOf('todayAct').forEach(function (r) {
      if (r.day && String(r.day).slice(0, 10) !== t) return;
      var x = get(r.employee_email, r.employee_name);
      if (x) x.act = r;
    });
    var list = Object.keys(map).map(function (k) {
      var x = map[k];
      x.logs.sort(function (a, b) { return tsMs(b.created_at) - tsMs(a.created_at); });
      // Only what the person did counts as being at work: a lead handing
      // their job back or assigning them one is in the same activity row.
      var ap = actPresence(x.act);
      var seen = [x.team && x.team.last_seen_at, x.logs[0] && x.logs[0].created_at].map(tsMs).concat([ap.lastAt]).filter(isFinite);
      x.lastSeen = seen.length ? Math.max.apply(null, seen) : NaN;
      x.activeToday = (isFinite(x.lastSeen) && istDay(x.lastSeen) === t) || x.logs.length > 0 || ap.own;
      x.logCount = st.slots.todayLogs.val ? x.logs.length : (x.team && x.team.logs_today != null ? num(x.team.logs_today) : null);
      if (!x.name) x.name = x.email;
      return x;
    });
    list.sort(function (a, b) {
      if (a.activeToday !== b.activeToday) return a.activeToday ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function paint() {
    if (!active()) return;
    if (st.debounce) return;
    // Several sources answer within a few ms of each other: one repaint.
    st.debounce = setTimeout(function () { st.debounce = null; render(); }, 16);
  }

  function setStat(text) { var s = el('hr-stat'); if (s) s.textContent = text; }

  function renderToolbar() {
    var tb = el('hr-toolbar');
    if (!tb) return;
    var busy = Object.keys(st.slots).some(function (k) { return st.slots[k].loading; });
    var sig = st.tab + '|' + (busy ? 1 : 0);
    if (tb.dataset.sig === sig) return;
    tb.dataset.sig = sig;
    tb.innerHTML =
      '<div class="hr-tabs" role="group" aria-label="Show">' +
        TABS.map(function (t) {
          var on = st.tab === t[0];
          return '<button type="button" class="hr-tab' + (on ? ' on' : '') + '" data-hr-tab="' + t[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(t[1]) + '</button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="secondary-btn hr-refresh" data-hr-tb="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Loading…' : '↻ Refresh') + '</button>';
  }

  // The filter bar (Work logs, Field activity) is built once per tab and
  // updated in place, so typing in it is never interrupted by a repaint.
  function renderFilters() {
    var host = el('hr-filters');
    if (!host) return;
    var show = st.tab === 'logs' || st.tab === 'activity';
    host.classList.toggle('hidden', !show);
    if (!show) { host.textContent = ''; st.filterSig = null; st.peopleSig = null; return; }
    var r = range();
    var rebuilt = false;
    // The bar itself only when the tab changes (static markup, no data in it).
    if (st.filterSig !== st.tab) {
      st.filterSig = st.tab;
      st.peopleSig = null;
      rebuilt = true;
      host.innerHTML =
        '<label class="hr-f"><span>Person</span><select id="hr-person"></select></label>' +
        '<div class="hr-presets" role="group" aria-label="Dates">' +
          PRESETS.map(function (p) { return '<button type="button" class="hr-chip" data-hr-preset="' + p[0] + '" aria-pressed="false">' + esc(p[1]) + '</button>'; }).join('') +
        '</div>' +
        '<label class="hr-f"><span>From</span><input type="date" id="hr-from"></label>' +
        '<label class="hr-f"><span>To</span><input type="date" id="hr-to"></label>' +
        (st.tab === 'logs' ? '<label class="hr-f hr-f-grow"><span>Search</span><input type="search" id="hr-search" maxlength="80" placeholder="Title, note, category, place…" autocomplete="off" spellcheck="false"></label>' : '') +
        '<div id="hr-range-err" class="hr-range-err" role="alert"></div>';
      var ui = UI();
      if (ui && typeof ui.guardEnter === 'function') { try { ui.guardEnter(host); } catch (e) { /* Enter just does nothing useful */ } }
    }
    // The people in the picker change as answers arrive; never while it is open.
    var sel = el('hr-person');
    var people = knownPeople();
    var psig = people.map(function (p) { return p.email + '=' + p.name; }).join(',');
    if (sel && st.peopleSig !== psig && document.activeElement !== sel) {
      st.peopleSig = psig;
      sel.textContent = '';
      var all = document.createElement('option');
      all.value = '';
      all.textContent = 'Everyone';
      sel.appendChild(all);
      people.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.email;
        o.textContent = p.name === p.email ? p.email : p.name;
        sel.appendChild(o);
      });
      rebuilt = true;
    }
    if (sel && (rebuilt || document.activeElement !== sel) && sel.value !== st.person) sel.value = st.person;
    var f = el('hr-from'), t = el('hr-to');
    var td = today();
    if (f && (rebuilt || document.activeElement !== f)) { f.value = r.from; f.max = td; }
    if (t && (rebuilt || document.activeElement !== t)) { t.value = r.to; t.max = td; }
    host.querySelectorAll('[data-hr-preset]').forEach(function (b) {
      var on = b.getAttribute('data-hr-preset') === st.preset;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var s = el('hr-search');
    if (s && document.activeElement !== s && s.value !== st.search) s.value = st.search;
    var err = el('hr-range-err');
    if (err) err.textContent = rangeError(r) || '';
  }

  function render() {
    var root = el('hr-root');
    if (!root) return;
    bindWho();
    st.kp = null;
    if (!profile()) { root.textContent = ''; setStat('—'); return; }
    if (!el('hr-body')) {
      root.innerHTML = '<div id="hr-filters" class="hr-filters hidden"></div><div id="hr-body" class="hr-body"></div>';
    }
    renderToolbar();
    renderFilters();
    var body = el('hr-body');
    if (!canOpen()) {
      body.innerHTML = banner('NeoHR is for heads (tier 3 and above) and NeoHR leads.', 'info');
      setStat('—');
      return;
    }
    var html;
    if (st.tab === 'logs') html = logsHtml();
    else if (st.tab === 'activity') html = activityHtml();
    else if (st.tab === 'app') html = appHtml();
    else html = teamHtml();
    body.innerHTML = html;
  }

  function slotBanner(name, what) {
    var s = st.slots[name];
    if (!s.err) return '';
    return banner((s.val ? 'Showing the last answer — ' : '') + what + ': ' + errText(s.err), s.val ? 'warn' : 'error');
  }
  function emptyBox(text) { return '<div class="hr-empty">' + esc(text) + '</div>'; }
  function loadingBox(text) { return '<div class="hr-empty hr-loading">' + esc(text) + '</div>'; }

  // ── Team today ────────────────────────────────────────────────────────────
  function tile(n, label, tone, title) {
    return '<div class="hr-tile' + (tone ? ' hr-t-' + tone : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<div class="hr-tile-n">' + esc(n == null ? '—' : n) + '</div><div class="hr-tile-l">' + esc(label) + '</div></div>';
  }

  function tilesHtml(people) {
    var inPool = people.filter(function (x) { return x.team && (x.team.build_pool || x.team.service_pool); });
    var busy = people.filter(function (x) { return x.team && num(x.team.jobs) > 0; }).length;
    var free = inPool.filter(function (x) { return num(x.team.jobs) === 0 && !(Array.isArray(x.team.offers) && x.team.offers.length); }).length;
    var cap = inPool.reduce(function (a, x) { return a + Math.max(0, num(x.team.capacity_points)); }, 0);
    var pts = inPool.reduce(function (a, x) { return a + Math.max(0, num(x.team.points)); }, 0);
    var t = {
      people: st.slots.team.val ? teamPeople().length : null,
      busy: st.slots.team.val ? busy : null,
      free: st.slots.team.val ? free : null,
      load: st.slots.team.val && cap ? Math.round(pts / cap * 100) : null,
      logs: st.slots.todayLogs.val ? rowsOf('todayLogs').length : null,
      visits: st.slots.todayAct.val ? rowsOf('todayAct').reduce(function (a, r) { return a + num(r.visits_arrived); }, 0) : null,
      alerts: st.slots.team.val ? teamAlerts().length : null
    };
    // The server's own counts win when it sends them (neo_dashboard.team).
    var dv = st.slots.dash.val, dt = dv && dv.team && typeof dv.team === 'object' ? dv.team : null;
    if (dt) {
      if (dt.people != null) t.people = num(dt.people);
      if (dt.busy != null) t.busy = num(dt.busy);
      if (dt.free != null) t.free = num(dt.free);
      if (dt.load_pct != null) t.load = Math.round(num(dt.load_pct));
      if (dt.logs_today != null) t.logs = num(dt.logs_today);
      if (dt.visits_today != null) t.visits = num(dt.visits_today);
      if (dt.alerts != null) t.alerts = num(dt.alerts);
    }
    // work_team sends only the alerts of the kinds the viewer leads, and
    // neo_dashboard sends no team section below tier 3. A NeoHR lead who
    // leads neither builds nor service reads no alerts at all: no tile, so
    // the screen never says "0 need a lead" when it simply cannot know.
    var m = M();
    var leadsBuilds = !!(m && typeof m.hasRole === 'function' && m.hasRole('qc', 'lead'));
    var leadsService = !!(m && typeof m.hasRole === 'function' && m.hasRole('service', 'lead'));
    var alertsAll = !!(dt && dt.alerts != null);
    var alertsTitle = 'Offers declined or not answered, and work nobody free can take' +
      (alertsAll || (leadsBuilds && leadsService) ? '' : leadsBuilds ? ' (builds only: the work you lead)' : ' (service only: the work you lead)');
    var atWork = people.filter(function (x) { return x.activeToday; }).length;
    return '<div class="hr-tiles">' +
      tile(atWork, 'at work today', 'ok', 'Did something themselves today: a log, a claim or hand-back, a site visit or a punch') +
      tile(t.people, 'in the team', null, 'In a work pool or holding work') +
      tile(t.busy, 'busy', 'busy', 'Holding at least one job or build') +
      tile(t.free, 'free', 'free', 'In a pool with nothing on their plate') +
      tile(t.load == null ? null : t.load + '%', 'team load', t.load != null && t.load >= 90 ? 'late' : null, 'Points held against everyone’s capacity') +
      tile(t.logs, 'logs today', null) +
      tile(t.visits, 'site visits today', null, 'Arrivals at a customer’s site') +
      (alertsAll || leadsBuilds || leadsService ? tile(t.alerts, 'need a lead', t.alerts ? 'late' : null, alertsTitle) : '') +
    '</div>';
  }

  function appStrip() {
    var s = st.slots.app;
    var a = s.val;
    var rel = a && a.release;
    var inner;
    if (rel) {
      inner = '<span class="hr-strip-ic" aria-hidden="true">📱</span><span><strong>NeoHR app ' + esc(rel.version) + '</strong> is the latest' +
        (rel.publishedAt ? ' (published ' + esc(shortDate(rel.publishedAt)) + ')' : '') + '. Technicians install it once; after that it updates itself.</span>';
    } else if (s.loading) {
      inner = '<span class="hr-strip-ic" aria-hidden="true">📱</span><span>Checking for the latest NeoHR app…</span>';
    } else {
      inner = '<span class="hr-strip-ic" aria-hidden="true">📱</span><span>The NeoHR phone app: how to install it and its latest version.</span>';
    }
    return '<div class="hr-strip">' + inner + '<button type="button" class="secondary-btn hr-btn" data-hr-act="tab" data-hr-to="app">How to install</button></div>';
  }

  function levelLabel(l) { return l === 'senior' ? 'Senior' : l === 'junior' ? 'Junior' : ''; }

  function personCard(x) {
    var p = x.team || {};
    var sub = [p.designation, levelLabel(p.build_level),
      [p.build_pool ? 'Builds' : '', p.service_pool ? 'Service' : ''].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
    var facts = [];
    // The badge already says "Not seen today"; a time is added only when there is one.
    // At work today with no own time today (their activity row also holds a
    // lead's later event, so its last time may not be theirs): just "today".
    if (isFinite(x.lastSeen) && (!x.activeToday || istDay(x.lastSeen) === today())) {
      facts.push('<span><b>Seen</b> ' + esc(fmtRel(new Date(x.lastSeen).toISOString())) + '</span>');
    } else if (x.activeToday) {
      facts.push('<span><b>Seen</b> today</span>');
    }
    if (x.logCount != null) facts.push('<span><b>Logs</b> ' + esc(x.logCount) + '</span>');
    var a = x.act;
    if (a) {
      var arrived = num(a.visits_arrived), done = num(a.visits_done);
      if (num(a.visits_left) || arrived || done) {
        facts.push('<span><b>Visits</b> ' + esc(arrived + (done ? ' (' + done + ' done)' : '')) + '</span>');
      }
      if (num(a.punch_ins) || num(a.punch_outs)) {
        facts.push('<span><b>Punched</b> ' + esc((num(a.punch_ins) ? 'in' : '') + (num(a.punch_ins) && num(a.punch_outs) ? ' · ' : '') + (num(a.punch_outs) ? 'out' : '')) + '</span>');
      }
      if (num(a.claims)) facts.push('<span><b>Claimed</b> ' + esc(num(a.claims)) + '</span>');
    }
    var load = '';
    if (x.team && (p.build_pool || p.service_pool || num(p.jobs) > 0)) {
      var cap = Math.max(0, num(p.capacity_points)), pts = Math.max(0, num(p.points));
      var pct = cap ? Math.min(100, Math.round(pts / cap * 100)) : 0;
      load = '<div class="hr-load-row"><div class="hr-load' + (cap && pts >= cap ? ' full' : '') + '" role="img" aria-label="' + esc(pts + ' of ' + cap + ' points') + '"><i style="width:' + pct + '%"></i></div>' +
        '<span class="hr-load-n">' + esc(pts + '/' + cap + ' pts · ' + num(p.jobs) + '/' + num(p.max_jobs) + ' jobs') + '</span></div>';
    }
    var tags = (Array.isArray(p.items) ? p.items : []).map(function (i) {
      return '<span class="hr-tag" title="' + esc(i.title || '') + '">' + esc((i.code || '') + (i.title ? ' · ' + i.title : '')) + '</span>';
    }).concat((Array.isArray(p.offers) ? p.offers : []).map(function (o) {
      return '<span class="hr-tag hr-tag-offer" title="Offered — waiting for an answer">' + esc((o.code || '') + ' · offered') + '</span>';
    })).join('');
    var last = x.logs[0];
    var lastHtml = last
      ? '<div class="hr-lastlog"><span class="hr-lastlog-t">' + esc(istHm(last.created_at)) + '</span> ' + esc(last.title || '') +
        (last.category ? ' <span class="hr-cat">' + esc(last.category) + '</span>' : '') + '</div>'
      : '';
    return '<div class="hr-person' + (x.activeToday ? ' is-on' : '') + '" data-hr-email="' + esc(x.email) + '">' +
      '<div class="hr-person-head">' +
        '<div class="hr-person-who"><div class="hr-person-name">' + esc(x.name) + '</div>' +
          (sub ? '<div class="hr-person-sub">' + esc(sub) + '</div>' : '') + '</div>' +
        '<span class="hr-state">' + esc(x.activeToday ? 'At work today' : 'Not seen today') + '</span>' +
      '</div>' +
      '<div class="hr-facts">' + facts.join('') + '</div>' +
      load +
      (tags ? '<div class="hr-tags">' + tags + '</div>' : '') +
      lastHtml +
      '<div class="hr-person-acts">' +
        '<button type="button" class="text-btn hr-btn" data-hr-act="person-logs" data-hr-email="' + esc(x.email) + '">Logs</button>' +
        '<button type="button" class="text-btn hr-btn" data-hr-act="person-act" data-hr-email="' + esc(x.email) + '">Field activity</button>' +
      '</div>' +
    '</div>';
  }

  function teamHtml() {
    var html = [];
    if (isDemo()) html.push(banner('Demo data is on: the cards below leave out service jobs, which are practice tickets on this PC. People, logs and field activity are real.', 'demo'));
    html.push(slotBanner('team', 'Team load could not be loaded'));
    html.push(slotBanner('todayLogs', 'Today’s logs could not be loaded'));
    html.push(slotBanner('todayAct', 'Today’s field activity could not be loaded'));
    var people = todayPeople();
    html.push(tilesHtml(people));
    html.push(appStrip());
    var anyLoading = st.slots.team.loading || st.slots.todayLogs.loading || st.slots.todayAct.loading;
    if (!people.length) {
      html.push(anyLoading ? loadingBox('Loading the team…') : emptyBox('Nobody is in a work pool, holding work or has logged anything today.'));
    } else {
      html.push('<div class="hr-people">' + people.map(personCard).join('') + '</div>');
    }
    var atWork = people.filter(function (x) { return x.activeToday; }).length;
    setStat(plural(people.length, 'person', 'people') + ' · ' + atWork + ' at work today' +
      (st.slots.todayLogs.val ? ' · ' + plural(rowsOf('todayLogs').length, 'log') + ' today' : ''));
    return html.join('');
  }

  // ── Work logs ─────────────────────────────────────────────────────────────
  function logMatches(r, q) {
    if (!q) return true;
    return [r.title, r.description, r.category, r.location_name, r.employee_name, r.employee_email]
      .some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
  }
  function mapLink(r) {
    var lat = Number(r.latitude), lng = Number(r.longitude);
    if (r.latitude == null || r.longitude == null || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
    return '<button type="button" class="text-btn hr-btn hr-map" data-hr-act="map" data-hr-lat="' + lat.toFixed(6) + '" data-hr-lng="' + lng.toFixed(6) + '">Map</button>';
  }
  function logRow(r) {
    var id = String(r.id || '');
    var desc = r.description ? String(r.description) : '';
    var long = desc.length > 220 || desc.split('\n').length > 3;
    var open = !!st.openLogs[id];
    var where = r.location_name ? String(r.location_name) : '';
    return '<div class="hr-log">' +
      '<time class="hr-log-t">' + esc(istHm(r.created_at)) + '</time>' +
      '<div class="hr-log-main">' +
        '<div class="hr-log-top"><span class="hr-log-who">' + esc(r.employee_name || r.employee_email || '') + '</span>' +
          (r.category ? '<span class="hr-cat">' + esc(r.category) + '</span>' : '') + '</div>' +
        '<div class="hr-log-title">' + esc(r.title || '') + '</div>' +
        (desc ? '<div class="hr-log-desc' + (long && !open ? ' clamp' : '') + '">' + esc(desc) + '</div>' +
          (long ? '<button type="button" class="text-btn hr-btn hr-more" data-hr-act="more" data-hr-id="' + esc(id) + '">' + (open ? 'Show less' : 'Show more') + '</button>' : '') : '') +
        (where || mapLink(r) ? '<div class="hr-log-loc">' + (where ? '<span>📍 ' + esc(where) + '</span>' : '') + mapLink(r) + '</div>' : '') +
      '</div>' +
    '</div>';
  }
  function logsHtml() {
    var html = [];
    var r = range();
    var re = rangeError(r);
    var s = st.slots.logs;
    if (re) { setStat('—'); return emptyBox('Fix the dates above to see the logs.'); }
    html.push(slotBanner('logs', 'The logs could not be loaded'));
    var v = s.val;
    if (!v) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the logs…') : (s.err ? '' : emptyBox('Pick a range to see the logs.')));
      return html.join('');
    }
    var q = lower(st.search);
    var rows = (Array.isArray(v.rows) ? v.rows : []).filter(function (x) { return x && logMatches(x, q); });
    rows.sort(function (a, b) { return tsMs(b.created_at) - tsMs(a.created_at); });
    var people = {};
    rows.forEach(function (x) { people[lower(x.employee_email)] = true; });
    var head = plural(rows.length, 'log') + (st.person ? ' by ' + nameOf(st.person) : ' · ' + plural(Object.keys(people).length, 'person', 'people')) +
      ' · ' + rangeLabel(r) + (q ? ' · matching “' + st.search.trim() + '”' : '');
    html.push('<div class="hr-summary">' + esc(head) + '</div>');
    if (v.more) html.push(banner('Showing the newest 2000 logs. Pick one person or fewer days to see the rest.', 'warn'));
    if (!rows.length) {
      html.push(emptyBox(q ? 'No logs match that search.' : (st.person ? nameOf(st.person) + ' logged nothing in this range.' : 'Nobody logged anything in this range.')));
      setStat(plural(0, 'log'));
      return html.join('');
    }
    var t = today();
    var groups = [], byDay = {};
    rows.forEach(function (x) {
      var d = (x.day && validDay(String(x.day).slice(0, 10))) ? String(x.day).slice(0, 10) : dayOf(x.created_at);
      if (!byDay[d]) { byDay[d] = []; groups.push(d); }
      byDay[d].push(x);
    });
    groups.forEach(function (d) {
      html.push('<section class="hr-day"><h4 class="hr-day-h">' + esc(dayLabel(d, t)) + '<span class="hr-day-n">' + esc(plural(byDay[d].length, 'log')) + '</span></h4>' +
        '<div class="hr-logs">' + byDay[d].map(logRow).join('') + '</div></section>');
    });
    setStat(plural(rows.length, 'log'));
    return html.join('');
  }

  // ── Field activity ────────────────────────────────────────────────────────
  var ACT_KEYS = ['claims', 'releases', 'released_by_lead', 'manager_assigns', 'visits_left', 'visits_arrived', 'visits_done',
                  'revisits', 'parts_needed', 'customer_absent', 'punch_ins', 'punch_outs'];
  function sumRows(rows) {
    var o = { days: 0, first_at: null, last_at: null };
    ACT_KEYS.forEach(function (k) { o[k] = 0; });
    rows.forEach(function (r) {
      o.days++;
      ACT_KEYS.forEach(function (k) { o[k] += Math.max(0, num(r[k])); });
      if (r.first_at && (!o.first_at || tsMs(r.first_at) < tsMs(o.first_at))) o.first_at = r.first_at;
      if (r.last_at && (!o.last_at || tsMs(r.last_at) > tsMs(o.last_at))) o.last_at = r.last_at;
    });
    return o;
  }
  function nz(n, text) { return n ? n + ' ' + text : ''; }
  function hoursOf(o) { return (o.first_at && o.last_at) ? istHm(o.first_at) + '–' + istHm(o.last_at) : '—'; }
  // last: the text of the "Days / hours" cell.
  function actCells(o, last) {
    var back = o.releases + (o.released_by_lead ? ' (+' + o.released_by_lead + ' by a lead)' : '');
    var visits = [nz(o.visits_left, 'left'), nz(o.visits_arrived, 'arrived'), nz(o.visits_done, 'done')].filter(Boolean).join(' · ') || '—';
    var outcomes = [nz(o.revisits, 'revisit'), nz(o.parts_needed, 'parts'), nz(o.customer_absent, 'absent')].filter(Boolean).join(' · ') || '—';
    var punch = [nz(o.punch_ins, 'in'), nz(o.punch_outs, 'out')].filter(Boolean).join(' · ') || '—';
    return '<td class="hr-n">' + esc(o.claims) + '</td>' +
      '<td class="hr-n">' + esc(o.manager_assigns) + '</td>' +
      '<td class="hr-n">' + esc(back) + '</td>' +
      '<td>' + esc(visits) + '</td>' +
      '<td>' + esc(outcomes) + '</td>' +
      '<td>' + esc(punch) + '</td>' +
      '<td class="hr-n">' + esc(last) + '</td>';
  }
  function activityHtml() {
    var html = [];
    var r = range();
    if (rangeError(r)) { setStat('—'); return emptyBox('Fix the dates above to see the field activity.'); }
    var s = st.slots.act;
    html.push(slotBanner('act', 'The field activity could not be loaded'));
    if (!s.val) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the field activity…') : '');
      return html.join('');
    }
    var rows = rowsOf('act').filter(function (x) { return x && x.employee_email && (!st.person || lower(x.employee_email) === st.person); });
    var by = {}, order = [];
    rows.forEach(function (x) {
      var e = lower(x.employee_email);
      if (!by[e]) { by[e] = []; order.push(e); }
      by[e].push(x);
    });
    order.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
    html.push('<div class="hr-summary">' + esc((st.person ? nameOf(st.person) : plural(order.length, 'person', 'people')) + ' · ' + rangeLabel(r)) + '</div>');
    html.push('<p class="hr-hint">Claimed and assigned count service jobs taken from the queue or given by a lead (or the app’s offer). Site visits come from NeoHR on the phone: left the shop, arrived, finished.</p>');
    if (!order.length) {
      html.push(emptyBox(st.person ? nameOf(st.person) + ' has no field activity in this range.' : 'No field activity in this range.'));
      setStat(plural(0, 'person', 'people'));
      return html.join('');
    }
    var t = today();
    var out = '<div class="hr-table-wrap"><table class="hr-table"><thead><tr>' +
      '<th scope="col">Person</th><th scope="col">Claimed</th><th scope="col">Assigned</th><th scope="col">Handed back</th>' +
      '<th scope="col">Site visits</th><th scope="col">Outcomes</th><th scope="col">Punches</th><th scope="col">Days / hours</th>' +
      '</tr></thead><tbody>';
    order.forEach(function (e) {
      var list = by[e].slice().sort(function (a, b) { return String(b.day || '').localeCompare(String(a.day || '')); });
      var o = sumRows(list);
      var open = !!st.expanded[e];
      var name = by[e][0].employee_name || nameOf(e);
      out += '<tr class="hr-arow">' +
        '<th scope="row"><button type="button" class="hr-expand" data-hr-act="expand" data-hr-email="' + esc(e) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span aria-hidden="true">' + (open ? '▾' : '▸') + '</span> ' + esc(name) + '</button></th>' +
        actCells(o, o.days === 1 ? hoursOf(o) : plural(o.days, 'day')) + '</tr>';
      if (open) {
        list.forEach(function (d) {
          var od = sumRows([d]);
          out += '<tr class="hr-drow"><th scope="row">' + esc(dayLabel(String(d.day || '').slice(0, 10), t)) + '</th>' + actCells(od, hoursOf(od)) + '</tr>';
        });
      }
    });
    if (order.length > 1) {
      out += '<tr class="hr-total"><th scope="row">Everyone</th>' + actCells(sumRows(rows), plural(order.length, 'person', 'people')) + '</tr>';
    }
    out += '</tbody></table></div>';
    html.push(out);
    setStat(plural(order.length, 'person', 'people'));
    return html.join('');
  }

  // ── NeoHR app ─────────────────────────────────────────────────────────────
  function appHtml() {
    var s = st.slots.app;
    var a = s.val || null;
    var rel = a && a.release;
    var html = [];
    if (s.err) html.push(banner('The latest version could not be checked: ' + errText(s.err), 'error'));
    if (a && a.error) html.push(banner((rel ? 'Showing what this PC last saw — ' : '') + a.error, rel ? 'warn' : 'error'));
    var head = '<div class="hr-app-head"><span class="hr-app-ic" aria-hidden="true">📱</span><div>' +
      '<h3 class="hr-app-title">NeoHR for Android' + (rel ? ' <span class="hr-ver">' + esc(rel.version) + '</span>' : '') + '</h3>' +
      '<p class="hr-app-sub">Part of Neo OS. Technicians and heads sign in with their Neo OS email and PIN — the same account as this app.</p>' +
      '</div></div>';
    var what = '<p class="hr-app-p">On the phone, NeoHR is the one app a technician needs away from a Neo OS PC: a simple dashboard, ' +
      'the work queue (claim, accept or decline offers, hand back), their service jobs and builds with the customer’s details for their own jobs, ' +
      'notes, photos and stage moves, site visits (left the shop, arrived, finished) and their daily work logs, which show up here.</p>';
    var dl = '';
    if (rel) {
      var meta = [rel.publishedAt ? 'Published ' + shortDate(rel.publishedAt) : '', rel.apk && rel.apk.size ? fmtBytes(rel.apk.size) : '',
                  'Android 10 or newer'].filter(Boolean).join(' · ');
      dl = '<div class="hr-app-dl">' +
        (rel.apk
          ? '<button type="button" class="primary-pink-btn hr-btn" data-hr-act="download">Download NeoHR ' + esc(rel.version) + '</button>' +
            '<button type="button" class="secondary-btn hr-btn" data-hr-act="copy">Copy download link</button>'
          : '<span class="hr-muted">This release has no app file attached yet.</span>') +
        '<button type="button" class="text-btn hr-btn" data-hr-act="page">Release page</button>' +
        '<span class="hr-app-meta">' + esc(meta) + '</span>' +
      '</div>';
    } else if (s.loading) {
      dl = loadingBox('Checking GitHub for the latest NeoHR…');
    } else if (s.err || (a && a.error)) {
      dl = emptyBox('The latest version is not known yet — Check again in a few minutes.');
    } else {
      dl = emptyBox('No NeoHR release has been published yet. When one is, it appears here.');
    }
    var steps = '<h4 class="hr-app-h">Installing it on a phone</h4><ol class="hr-steps">' +
      '<li>Send the download link to the phone (copy it here and WhatsApp it to them), or open the release page on the phone.</li>' +
      '<li>Download the NeoHR file on the phone and open it. If Android asks, allow <em>Install unknown apps</em> for the browser or Files app, then go back.</li>' +
      '<li>Tap <strong>Install</strong>. On a phone that already has NeoHR this updates it in place; the logs on it stay.</li>' +
      '<li>Open NeoHR and sign in with the person’s Neo OS email and PIN. Allow notifications, so work offered to them reaches the phone.</li>' +
      '<li>From then on NeoHR updates itself: it shows <em>Update available</em> on its Dashboard and in Settings → Check for updates.</li>' +
    '</ol>' +
    '<p class="hr-hint">A phone with an older <em>test</em> build of NeoHR keeps it as a separate app. Check that its logs show up under Work logs here before uninstalling it.</p>';
    var notes = rel && rel.notes ? '<h4 class="hr-app-h">What’s new in ' + esc(rel.version) + '</h4><div class="hr-notes">' + esc(rel.notes) + '</div>' : '';
    var foot = '<div class="hr-app-foot">' +
      (a && a.checkedAt ? '<span class="hr-muted">Checked ' + esc(fmtRel(a.checkedAt)) + ' on GitHub.</span>' : '') +
      '<button type="button" class="text-btn hr-btn" data-hr-act="recheck"' + (s.loading ? ' disabled' : '') + '>' + (s.loading ? 'Checking…' : 'Check again') + '</button>' +
    '</div>';
    html.push('<div class="hr-app">' + head + what + dl + steps + notes + foot + '</div>');
    setStat(rel ? 'NeoHR ' + rel.version : (s.loading ? '…' : '—'));
    return html.join('');
  }

  function release() { var a = st.slots.app.val; return a && a.release ? a.release : null; }

  function openUrl(url, what) {
    var ui = UI();
    var ok = false;
    if (ui && typeof ui.openExternal === 'function') { try { ok = !!ui.openExternal(url); } catch (e) { ok = false; } }
    if (!ok) toast('Could not open ' + (what || 'that link') + '.', 'error');
    return ok;
  }

  // ── events ────────────────────────────────────────────────────────────────
  function setTab(tab) {
    if (!TABS.some(function (t) { return t[0] === tab; })) return;
    st.tab = tab;
    writePrefs();
    st.filterSig = null;
    render();
    loadTab(false);
    syncTimer();
  }
  function showPerson(email, tab) {
    st.person = lower(email);
    if (tab === 'logs') { st.preset = 'today'; st.search = ''; }
    setTab(tab);
  }

  function onBodyClick(e) {
    var b = e.target.closest('[data-hr-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-hr-act');
    if (act === 'tab') { setTab(b.getAttribute('data-hr-to')); return; }
    if (act === 'person-logs') { showPerson(b.getAttribute('data-hr-email'), 'logs'); return; }
    if (act === 'person-act') { showPerson(b.getAttribute('data-hr-email'), 'activity'); return; }
    if (act === 'more') {
      var id = b.getAttribute('data-hr-id');
      if (st.openLogs[id]) delete st.openLogs[id]; else st.openLogs[id] = true;
      render();
      return;
    }
    if (act === 'expand') {
      var em = b.getAttribute('data-hr-email');
      if (st.expanded[em]) delete st.expanded[em]; else st.expanded[em] = true;
      render();
      return;
    }
    if (act === 'map') {
      var lat = Number(b.getAttribute('data-hr-lat')), lng = Number(b.getAttribute('data-hr-lng'));
      if (isFinite(lat) && isFinite(lng)) openUrl('https://www.google.com/maps?q=' + lat.toFixed(6) + ',' + lng.toFixed(6), 'the map');
      return;
    }
    var rel = release();
    if (act === 'download') { if (rel && rel.apk) openUrl(rel.apk.url, 'the download'); return; }
    if (act === 'page') { if (rel) openUrl(rel.pageUrl, 'the release page'); return; }
    if (act === 'copy') {
      if (!rel || !rel.apk) return;
      var ui = UI();
      var who = whoKey();
      var done = function (ok) {
        if (who !== whoKey()) return;
        toast(ok ? 'Download link copied — paste it into a WhatsApp message to the phone.' : 'Could not copy the link. Open the release page instead.', ok ? 'success' : 'error');
      };
      if (ui && typeof ui.copyText === 'function') Promise.resolve(ui.copyText(rel.apk.url)).then(done, function () { done(false); });
      else done(false);
      return;
    }
    if (act === 'recheck') { loadApp(true); return; }
  }

  function onToolbarClick(e) {
    var t = e.target.closest('[data-hr-tab]');
    if (t) { setTab(t.getAttribute('data-hr-tab')); return; }
    var r = e.target.closest('[data-hr-tb]');
    if (r && !r.disabled && r.getAttribute('data-hr-tb') === 'refresh') loadTab(true);
  }

  function reloadForFilters() {
    if (st.tab === 'logs') loadLogs();
    else if (st.tab === 'activity') loadAct();
    else render();
  }
  function onFiltersClick(e) {
    var p = e.target.closest('[data-hr-preset]');
    if (!p) return;
    st.preset = p.getAttribute('data-hr-preset');
    st.from = null; st.to = null;
    writePrefs();
    renderFilters();
    reloadForFilters();
  }
  function onFiltersChange(e) {
    var id = e.target && e.target.id;
    if (id === 'hr-person') {
      st.person = lower(e.target.value);
      // Logs ask the server for that one person; activity filters here.
      if (st.tab === 'logs') loadLogs(); else render();
      return;
    }
    if (id === 'hr-from' || id === 'hr-to') {
      var r = range();
      var f = el('hr-from'), t = el('hr-to');
      st.preset = 'custom';
      st.from = f && validDay(f.value) ? f.value : r.from;
      st.to = t && validDay(t.value) ? t.value : r.to;
      renderFilters();
      if (st.dateTimer) clearTimeout(st.dateTimer);
      st.dateTimer = setTimeout(function () { st.dateTimer = null; if (rangeError(range())) render(); else reloadForFilters(); }, 300);
    }
  }
  function onFiltersInput(e) {
    if (e.target && e.target.id === 'hr-search') {
      st.search = String(e.target.value || '');
      render();
    }
  }

  // ── timers ────────────────────────────────────────────────────────────────
  function syncTimer() {
    var want = active() && !!profile() && st.tab === 'team';
    if (want && !st.timer) {
      st.timer = setInterval(function () {
        if (!active() || !profile() || st.tab !== 'team') { syncTimer(); return; }
        loadTeamToday();
      }, TEAM_REFRESH_MS);
    } else if (!want && st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
  }

  var inited = false;
  function init() {
    if (inited) return;
    var root = el('hr-root');
    if (!root) return;
    inited = true;
    readPrefs();
    root.addEventListener('click', function (e) {
      if (e.target.closest('#hr-filters')) { onFiltersClick(e); return; }
      onBodyClick(e);
    });
    root.addEventListener('change', function (e) { if (e.target.closest('#hr-filters')) onFiltersChange(e); });
    root.addEventListener('input', function (e) { if (e.target.closest('#hr-filters')) onFiltersInput(e); });
    var tb = el('hr-toolbar');
    if (tb) tb.addEventListener('click', onToolbarClick);
  }

  // ── public ────────────────────────────────────────────────────────────────
  function ensureLoaded() {
    init();
    bindWho();
    render();
    syncTimer();
    return loadTab(false).then(function () { if (active()) render(); return true; });
  }

  // Sign-out: everything this module holds goes, and the timer stops.
  function reset() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    clearSession();
    st.who = null;
  }

  function boot() {
    var d = D();
    if (d && typeof d.on === 'function') {
      // A claim, offer or hand-back anywhere changes someone's load.
      try {
        d.on('work', function () {
          if (!active() || !profile() || st.tab !== 'team') return;
          if (st.workTimer) clearTimeout(st.workTimer);
          st.workTimer = setTimeout(function () {
            st.workTimer = null;
            if (active() && profile() && st.tab === 'team') run('team', 'team', function () { return need('workTeam').workTeam(); });
          }, 1000);
        });
      } catch (e) { console.warn('[neohr] cannot listen for work changes:', e && e.message); }
    }
    window.addEventListener('neo-modules-changed', function () {
      if (!profile()) { reset(); return; }
      bindWho();
      if (active()) render();
    });
    // The screen switches away without telling us: the observer stops the
    // Team today timer when #neohr-screen is no longer active.
    var scr = el('neohr-screen');
    if (scr && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { syncTimer(); }).observe(scr, { attributes: true, attributeFilter: ['class'] });
    }
  }

  window.NeoQcHr = {
    ensureLoaded: ensureLoaded,
    // Re-reads the current tab (the GitHub check stays cached; only the
    // NeoHR app tab's own buttons force it).
    refresh: function () { return loadTab(false); },
    render: render,
    reset: reset,
    setTab: setTab,
    showPerson: showPerson,
    isActive: active,
    _state: function () { return st; },
    _pure: { istDay: istDay, addDays: addDays, spanDays: spanDays, istHm: istHm, dayLabel: dayLabel, sumRows: sumRows }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
