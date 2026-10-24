/*
  Neo OS — NeoHR, the people side of Neo OS (window.NeoQcHr). New in 1.11;
  the HR module in 1.12 (HR-SPEC §4 + §9.11, sql/neohr-hr.sql v2.3).

  NeoHR is a module of Neo OS: the phone app every technician carries (punch
  in / out, breaks, site visits, the route for travel allowance, Tell HR,
  their work queue and logs) and this screen for heads and HR. One Neo OS
  account signs in to both.

  Tabs:
    Live              who is where right now (hr_board): status tiles that
                      filter, a search, one row per person; "Work load" is the
                      1.11 Team today view (work_team + today's logs/activity).
    Attendance        the register (hr_register): a day view and a month grid
                      per person with late / flex / half-day / absent / no
                      punch-out marks, CSV export, and the day panel with
                      Correct… (add, void or replace a punch, or remove an
                      accidental out–in pair; each one correction, with a
                      note).
    Requests          Tell HR requests, waiting first: approve / reject with a
                      note; an approved one can be cancelled with a note. A
                      missed punch that no longer fits the day opens Correct…
                      to be approved with the change it needs.
    Roster            the week, people × days: click a day to set the duty;
                      holidays.
    Routes            one person's day on an OpenStreetMap map (Leaflet,
                      vendored in vendor/leaflet/): the path, the stops and
                      the moving / gap segments, km and site visits. The
                      points are only drawn here: never exported or copied,
                      and cleared when the screen is left.
    Travel allowance  the month report (hr_ta_report): km, rate, amount;
                      approve per person (with the km shown), CSV; tier 4+
                      can take an approval back.
    Logs              the 1.11 Work logs and Field activity.
    NeoHR app         the latest NeoHR release on GitHub and how to install it.
    Settings          (tier 4+) office hours, grace, weekly off, half day,
                      tracking, retention, the longest shift, the TA rate and
                      the office point; per-person overrides.

  Who may open it: tier 3+ or a NeoHR lead (modules.js) — exactly the HR
  approvers (has_module('neohr','lead')). Nobody acts on their own records
  (HR-SPEC S19): Approve, Correct… and duty edits on the viewer's own row are
  disabled with that sentence as the title. Clock marks (⏱) are for
  approvers, never on the viewer's own records. The server decides every
  read and write; a source this person may not read says so in a banner.

  RULES (as queue.js): every async load binds who is signed in first and
  drops an answer that lands after a sign-out or a change of person; every
  server string goes through esc() or textContent; writes go through the data
  layer (DEMO_READONLY in demo mode — attendance is real people's data, so
  demo mode reads it but changes nothing); sign-out (reset) stops the timer,
  removes the map and clears everything. Days are shop days (India time).

  Loaded after queue.js and before shell.js, after shared/hr-format.js and
  vendor/leaflet/leaflet.js. Uses app.js globals only through typeof /
  appGlobal guards.

  1.12.1 (sql/neohr-hr-v2.4.sql, NeoHR 2.3; NEOHR-2.3 spec §7):
    - Field staff (hr_person.track_location, "Field staff" in Settings →
      People) are the only people with a route, km, trips and travel
      allowance. Everyone else's Location, Route, km and TA are hidden.
      Who is field comes from the server (a day record's field_staff, the
      board's field_staff, Settings → People); when nothing says (a v2.3
      server) the screen shows what 1.12 showed.
    - Every punch in / out is checked by the server: the place (at the shop,
      how far away, no location), how sure it is, its flags, the punch-in
      reason, and a photo. Requests gets the two punch kinds — Punch-in
      reason and Away from shop — through the pending_v4 / all_v4 lists,
      decided with hr_punch_request_decide (rejecting an away punch asks for
      the right time). Cards show the punch, the place, the reason, the
      photo and "Decide by 18:30" / "Past end of day"; the list refreshes
      every minute while it is open, and the badge turns red past the end
      of the day. Live → Today's punches shows every punch with its photo
      next to the person's previous one (hr_punch_checks). A full photo is
      fetched on a click (hr_selfie_get: the server logs the look), shown
      in the photo viewer from memory, and never stored.
    - Trips (on-site / RMA, field staff): a Trip column on Live, a Trips list
      in the day panel and on Routes (click one to see its part of the
      route), and travel allowance on trip km.
    - Settings: the office point on a map (click or drag the pin; the circle
      is the radius), and a banner while it is not set.
  Every new key is read leniently: a v2.3 server (or an older answer) just
  leaves the new bits out, it never breaks a tab.
*/
(function () {
  'use strict';

  var DAY = 86400000;
  var IST_MS = 330 * 60000;          // India has no daylight saving: a fixed +05:30
  var LIVE_REFRESH_MS = 60000;       // Live, while it is on show
  var MAX_SPAN_DAYS = 62;            // work_log_team's and hr_register's limit
  var PREF_KEY = 'neo_hr_prefs';
  var REQ_BACK_DAYS = 60, REQ_AHEAD_DAYS = 90;
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
  var OSM_ATTRIBUTION = '&copy; <a href="' + OSM_COPYRIGHT + '" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
  var LEAFLET_PREFIX = '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>';
  var TAB_DEFS = [
    { id: 'live', label: 'Live' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'requests', label: 'Requests' },
    { id: 'roster', label: 'Roster' },
    { id: 'routes', label: 'Routes' },
    { id: 'ta', label: 'Travel allowance' },
    { id: 'logs', label: 'Logs' },
    { id: 'app', label: 'NeoHR app' },
    { id: 'settings', label: 'Settings', tier: 4 }
  ];
  var LIVE_VIEWS = [['board', 'Attendance'], ['punches', 'Today’s punches'], ['load', 'Work load']];
  var LOG_VIEWS = [['logs', 'Work logs'], ['activity', 'Field activity']];
  var REG_VIEWS = [['day', 'Day'], ['month', 'Month']];
  var REQ_SCOPES = [['pending', 'Waiting'], ['today', 'Punch reasons today'], ['all', 'All requests']];
  // A v2.3 server answers the v2.4 list scopes with this sentence: it has no
  // punch kinds at all, so the old scopes are the whole list.
  var OLD_SCOPES = /scope is mine, pending or all/i;
  // An RPC this server does not have yet (PostgREST PGRST202).
  var NO_RPC = /PGRST202|could not find the function|schema cache/i;
  var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days']];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var NOT_APPROVER = 'Only a head or a NeoHR lead can do this.';
  var OWNER_ONLY = 'Only the owner can change a tier 4 or 5 account.';
  var DEMO_OFF = 'Demo data is on — changes are switched off.';

  function D() { return window.NeoQcData || null; }
  function UI() { return window.NeoQcUI || null; }
  function M() { return window.NeoQcModules || null; }
  function F() { return window.NeoQcHrFormat || null; }
  function el(id) { return document.getElementById(id); }
  function appGlobal(read) { try { return read(); } catch (e) { return undefined; } }
  function profile() {
    return appGlobal(function () { return typeof currentProfile !== 'undefined' ? currentProfile : null; }) || null;
  }
  function whoKey() { var p = profile(); return p ? String(p.id || p.email || '') : ''; }
  function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function num(v, d) { var n = Number(v); return (v != null && v !== '' && isFinite(n)) ? n : (d == null ? 0 : d); }
  function numOrNull(v) { if (v == null || v === '' || typeof v === 'boolean') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function tsMs(v) { var n = v ? Date.parse(v) : NaN; return isFinite(n) ? n : NaN; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function tierNow() { var p = profile(); return p ? (Number(p.tier) || 0) : 0; }
  function myEmail() { var p = profile(); return lower(p && p.email); }
  function isSelf(email) { var me = myEmail(); return !!me && lower(email) === me; }

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
  // The server does not have this RPC yet (an older HR database).
  function noRpc(e) { return !!e && (String(e.code || '') === 'PGRST202' || NO_RPC.test(String((e && e.message) || e || ''))); }
  function banner(text, kind) {
    var ui = UI();
    if (ui && typeof ui.banner === 'function') return ui.banner(text, kind);
    return '<div class="ops-banner ops-banner-' + (kind || 'info') + '">' + esc(text) + '</div>';
  }
  function money(v) {
    var ui = UI();
    if (v == null || v === '') return '—';
    if (ui && typeof ui.fmtINR === 'function') return ui.fmtINR(v);
    var n = Number(v);
    return isFinite(n) ? '₹' + n.toFixed(2) : '—';
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
  // An HR approver: has_module('neohr','lead') — tier 3+ is one automatically.
  function canApprove() {
    var m = M();
    if (!profile()) return false;
    if (tierNow() >= 3) return true;
    try { return !!(m && typeof m.roleFor === 'function' && m.roleFor('neohr') === 'lead'); } catch (e) { return false; }
  }
  function active() { var s = el('neohr-screen'); return !!(s && s.classList.contains('active')); }
  function selfSentence() { var f = F(); return f ? f.SELF_SENTENCE : 'Someone else has to approve or change your own attendance, duty or travel allowance.'; }

  // ── shop days and times (India time, as the server counts them) ───────────
  // The server's clock where we have it (the last work_queue / work_team / HR
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
  // A time on `day`'s row: HH:MM, with the day added when it is another one
  // (a session that ran past midnight belongs to its punch-in day).
  function hmOn(iso, day) {
    var t = tsMs(iso);
    if (!isFinite(t)) return '—';
    var d = istDay(t);
    return istHm(iso) + (day && d !== day ? ' (' + (d > day ? '+' : '') + spanDays(day, d) + 'd)' : '');
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
  function shortDay(day) {
    if (!validDay(day)) return String(day || '');
    var d = new Date(Date.parse(day + 'T00:00:00Z'));
    return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
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
  function fmtDur(min) { var f = F(); return f ? f.fmtDur(min) : (min == null ? '' : Math.round(num(min)) + 'm'); }
  function fmtKm(v) { var f = F(); return f ? f.fmtKm(v) : (v == null ? '' : num(v).toFixed(2)); }
  function monthStart(day) { return day.slice(0, 8) + '01'; }
  function monthEnd(day) { var f = F(); return f ? f.monthEnd(day) : addDays(monthStart(day), 27); }
  function addMonths(day, n) { var f = F(); return f ? f.addMonths(day, n) : monthStart(day); }
  function monthLabel(day) { var f = F(); return f ? f.monthLabel(day) : day.slice(0, 7); }
  function weekStart(day) { var f = F(); return f ? f.weekStart(day) : day; }
  function weekdayOf(day) { var f = F(); return f ? f.weekdayOf(day) : new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay(); }
  function label(map, key) { var f = F(); var m = f && f[map]; return (m && m[key]) || String(key || ''); }

  // ── state ─────────────────────────────────────────────────────────────────
  var SLOT_NAMES = ['team', 'dash', 'todayLogs', 'todayAct', 'logs', 'act', 'app',
                    'board', 'reg', 'reqPending', 'reqAll', 'reqToday', 'checks', 'roster', 'route', 'ta', 'settings'];
  function freshSlots() {
    var s = {};
    SLOT_NAMES.forEach(function (k) { s[k] = { val: null, err: null, loading: false, seq: 0, key: null, at: 0 }; });
    return s;
  }
  function freshView() {
    var t = istDay(nowMs());
    return {
      liveView: 'board', liveFilter: 'all', liveSearch: '',
      logsView: 'logs',
      regView: 'day', regDay: t, regMonth: monthStart(t), regPerson: '',
      reqScope: 'pending',
      rosterWeek: weekStart(t),
      routePerson: '', routeDay: t, routeTrip: '',
      taMonth: addMonths(t, -1), taOpen: {},
      checksDay: t
    };
  }
  var st = {
    who: null,
    tab: 'live',
    preset: 'today', from: null, to: null,     // the range shared by Work logs and Field activity
    person: '',                                // '' = everyone; a lower-cased email otherwise
    search: '',
    expanded: {},                              // Field activity: email -> its days are open
    openLogs: {},                              // Work logs: id -> the full description is shown
    v: freshView(),
    slots: freshSlots(),
    map: null, mapLayer: null, mapKey: null,
    timer: null, debounce: null, dateTimer: null, workTimer: null, hrTimer: null,
    filterSig: null, peopleSig: null, kp: null, bm: null,
    reqV3: false                               // the server has no v2.4 request scopes (a v2.3 server)
  };

  function readPrefs() {
    try {
      var o = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      if (o && typeof o === 'object') {
        // 1.11 tab names: Team today is Live → Work load; Field activity is under Logs.
        var tab = o.tab === 'team' ? 'live' : o.tab === 'activity' ? 'logs' : o.tab;
        if (TAB_DEFS.some(function (t) { return t.id === tab; })) st.tab = tab;
        if (o.tab === 'team') st.v.liveView = 'load';
        if (o.tab === 'activity') st.v.logsView = 'activity';
        if (LIVE_VIEWS.some(function (x) { return x[0] === o.liveView; })) st.v.liveView = o.liveView;
        if (LOG_VIEWS.some(function (x) { return x[0] === o.logsView; })) st.v.logsView = o.logsView;
        if (REG_VIEWS.some(function (x) { return x[0] === o.regView; })) st.v.regView = o.regView;
        if (PRESETS.some(function (p) { return p[0] === o.preset; })) st.preset = o.preset;
      }
    } catch (e) { /* storage blocked: defaults */ }
  }
  function writePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ tab: st.tab, preset: st.preset === 'custom' ? 'today' : st.preset,
        liveView: st.v.liveView, logsView: st.v.logsView, regView: st.v.regView }));
    } catch (e) { /* not kept */ }
  }

  // A different person at this PC starts from nothing.
  function bindWho() {
    var k = whoKey();
    if (k === st.who) return;
    clearSession();
    st.who = k;
  }
  function clearSession() {
    destroyMap();
    var keepViews = { liveView: st.v.liveView, logsView: st.v.logsView, regView: st.v.regView };
    st.slots = freshSlots();
    st.v = freshView();
    st.v.liveView = keepViews.liveView; st.v.logsView = keepViews.logsView; st.v.regView = keepViews.regView;
    st.person = ''; st.search = ''; st.expanded = {}; st.openLogs = {};
    st.preset = 'today'; st.from = null; st.to = null;
    st.filterSig = null; st.peopleSig = null; st.kp = null; st.bm = null; st.reqV3 = false;
    if (st.debounce) { clearTimeout(st.debounce); st.debounce = null; }
    if (st.dateTimer) { clearTimeout(st.dateTimer); st.dateTimer = null; }
    if (st.workTimer) { clearTimeout(st.workTimer); st.workTimer = null; }
    if (st.hrTimer) { clearTimeout(st.hrTimer); st.hrTimer = null; }
    var root = el('hr-root'); if (root) root.textContent = '';
    var tb = el('hr-toolbar'); if (tb) { tb.textContent = ''; delete tb.dataset.sig; }
    var stat = el('hr-stat'); if (stat) stat.textContent = '—';
  }
  // Route points live only while this screen shows them.
  function forgetRoute() {
    destroyMap();
    var s = st.slots.route;
    s.seq++; s.val = null; s.err = null; s.loading = false; s.key = null;
  }

  // ── the date range (Logs) ─────────────────────────────────────────────────
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
    throw new Error('This needs the Neo OS 1.12 data layer. Restart Neo OS after the update finishes.');
  }

  function loadTeamToday() {
    var t = today();
    var jobs = [
      run('team', 'team', function () { return need('workTeam').workTeam(); }),
      run('todayLogs', 'logs|' + t, function () { return need('workLogTeam').workLogTeam(t, t, null); }),
      run('todayAct', 'act|' + t, function () { return need('techActivity').techActivity(t, t); }),
      // The server's dashboard numbers, when it has them (neo_dashboard is
      // newer than work_team; without it the tiles are counted here).
      run('dash', 'dash', function () { return need('neoDashboard').neoDashboard(); })
    ];
    return Promise.all(jobs);
  }
  function loadBoard() { return run('board', 'board', function () { return need('hrBoard').hrBoard(); }); }
  function loadLive() {
    var jobs = [loadBoard(),
      // The app strip: cached for 15–30 minutes by the data layer, and never
      // forced from here (GitHub allows 60 reads an hour per network).
      loadApp(false),
      // The waiting list, for the badge: the board counts only the v2.3
      // kinds, and the punch kinds are the ones due today.
      loadPending()];
    if (st.v.liveView === 'load') jobs.push(loadTeamToday());
    if (st.v.liveView === 'punches') jobs.push(loadChecks());
    // The office point (the "not set" banner, the map's centre); read once.
    if (!st.slots.settings.val && !st.slots.settings.loading && !st.slots.settings.err) loadSettings();
    return Promise.all(jobs);
  }
  // Live → Today's punches (hr_punch_checks; approvers, v2.4).
  function loadChecks() {
    var d = validDay(st.v.checksDay) ? st.v.checksDay : today();
    return run('checks', 'checks|' + d, function () { return need('hrPunchChecks').hrPunchChecks(d); });
  }
  // The person pickers name everyone the board (or the team view) knows; asked once.
  function ensurePeople() {
    var b = st.slots.board;
    if (!b.val && !b.loading && !b.err) loadBoard();
    var s = st.slots.team;
    if (!s.val && !s.loading && !s.err && b.err) run('team', 'team', function () { return need('workTeam').workTeam(); });
  }
  function loadLogs() {
    var r = range();
    if (rangeError(r)) { paint(); return Promise.resolve(null); }
    var key = 'logs|' + r.from + '|' + r.to + '|' + st.person;
    var person = st.person;
    ensurePeople();
    return run('logs', key, function () { return need('workLogTeam').workLogTeam(r.from, r.to, person || null); });
  }
  function loadAct() {
    var r = range();
    if (rangeError(r)) { paint(); return Promise.resolve(null); }
    ensurePeople();
    return run('act', 'act|' + r.from + '|' + r.to, function () { return need('techActivity').techActivity(r.from, r.to); });
  }
  function loadApp(force) {
    return run('app', 'app', function () {
      var d = D();
      if (!d || typeof d.latestNeoHrRelease !== 'function') throw new Error('This needs the Neo OS 1.11 data layer. Restart Neo OS after the update finishes.');
      return d.latestNeoHrRelease({ force: !!force });
    });
  }
  function regRange() {
    if (st.v.regView === 'month') {
      var m = st.v.regMonth, t = today();
      var end = monthEnd(m);
      return { from: m, to: end > t && m <= t ? t : end };
    }
    return { from: st.v.regDay, to: st.v.regDay };
  }
  function loadReg() {
    var r = regRange();
    ensurePeople();
    if (r.to < r.from) { paint(); return Promise.resolve(null); }
    var person = st.v.regPerson;
    return run('reg', 'reg|' + r.from + '|' + r.to + '|' + person, function () { return need('hrRegister').hrRegister(r.from, r.to, person || null); });
  }
  // The request lists with the punch kinds (pending_v4 / all_v4). A v2.3
  // server has no such scopes (and no punch kinds): then the old ones, for
  // the rest of this sign-in.
  function listRequests(base, from, to) {
    var d = need('hrRequestsList');
    if (st.reqV3) return d.hrRequestsList(base, from, to);
    var who = whoKey();
    return d.hrRequestsList(base + '_v4', from, to).catch(function (e) {
      if (!OLD_SCOPES.test(String((e && e.message) || e || ''))) throw e;
      if (who === whoKey()) st.reqV3 = true;
      return d.hrRequestsList(base, from, to);
    });
  }
  function loadPending() {
    if (!canApprove()) return Promise.resolve(null);
    return run('reqPending', 'pending', function () { return listRequests('pending', null, null); });
  }
  function loadRequests() {
    var t = today();
    var jobs = [loadPending()];
    if (st.v.reqScope === 'all') {
      var f = addDays(t, -REQ_BACK_DAYS), to = addDays(t, REQ_AHEAD_DAYS);
      jobs.push(run('reqAll', 'all|' + f + '|' + to, function () { return listRequests('all', f, to); }));
    }
    if (st.v.reqScope === 'today' && !st.reqV3) {
      jobs.push(run('reqToday', 'today|' + t, function () { return listRequests('all', t, t); }));
    }
    return Promise.all(jobs);
  }
  function loadSettings() { return run('settings', 'settings', function () { return need('hrSettingsGet').hrSettingsGet(); }); }
  function loadRoster() {
    var w = st.v.rosterWeek, e = addDays(w, 6);
    ensurePeople();
    if (!st.slots.settings.val && !st.slots.settings.loading) loadSettings();
    return run('roster', 'roster|' + w, function () { return need('hrRosterGet').hrRosterGet(w, e, null); });
  }
  function loadRoute() {
    ensurePeople();
    var e = st.v.routePerson, d = st.v.routeDay;
    if (!e || !validDay(d)) { paint(); return Promise.resolve(null); }
    if (!st.slots.settings.val && !st.slots.settings.loading) loadSettings();
    return run('route', 'route|' + e + '|' + d, function () { return need('hrRoute').hrRoute(e, d); });
  }
  function loadTa() {
    var m = st.v.taMonth;
    return run('ta', 'ta|' + m, function () { return need('hrTaReport').hrTaReport(m); });
  }
  // hr_settings_get answers tier 4+ with everyone's overrides too (`people`).
  function loadSettingsTab() { return loadSettings(); }
  function loadTab(force) {
    if (!profile()) return Promise.resolve(null);
    if (st.tab === 'live') return loadLive();
    if (st.tab === 'attendance') return loadReg();
    if (st.tab === 'requests') return loadRequests();
    if (st.tab === 'roster') return loadRoster();
    if (st.tab === 'routes') return loadRoute();
    if (st.tab === 'ta') return loadTa();
    if (st.tab === 'settings') return loadSettingsTab();
    if (st.tab === 'logs') return st.v.logsView === 'activity' ? loadAct() : loadLogs();
    return loadApp(force);
  }

  // ── the data, normalised ──────────────────────────────────────────────────
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
  function objOf(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    return v && typeof v === 'object' ? v : null;
  }

  // hr_board → [{ email, name, designation, status, since, duty, shift, first_in,
  // worked_min, on_site, last_point_at, pending, stale, clock_marks, self, raw,
  // field_staff (true / false / null = not said), trip ({id, kind, ref_code,
  // started_at} | null), punch_check ({place, office_m, verify, flags,
  // selfie} of today's first punch-in | null) }]. The last three are v2.4.
  function objOrNull(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function boardRows() {
    var v = objOf(st.slots.board.val);
    if (!v) return [];
    var list = Array.isArray(v) ? v : (Array.isArray(v.people) ? v.people : (Array.isArray(v.rows) ? v.rows : []));
    return list.filter(function (r) { return r && (r.email || r.employee_email); }).map(function (r) {
      var email = lower(r.email || r.employee_email);
      var site = r.on_site && typeof r.on_site === 'object' ? r.on_site : (r.job && typeof r.job === 'object' ? r.job : null);
      return {
        raw: r, email: email, name: String(r.name || r.full_name || r.employee_name || email),
        designation: r.designation || '', status: String(r.status || r.live_status || ''), since: r.since || null,
        duty: r.duty || r.duty_today || null, holiday: r.holiday || null, shift: r.shift && typeof r.shift === 'object' ? r.shift : null,
        first_in: r.first_in || null, worked_min: r.worked_min, on_site: site,
        last_point_at: r.last_point_at || null, pending: Math.max(0, num(r.pending_requests)), stale: r.stale === true,
        clock_marks: Math.max(0, num(r.clock_marks)), self: r.self === true || isSelf(email), tier: numOrNull(r.tier),
        field_staff: typeof r.field_staff === 'boolean' ? r.field_staff : null,
        trip: objOrNull(r.trip), punch_check: objOrNull(r.punch_check),
        v4: Object.prototype.hasOwnProperty.call(r, 'field_staff') || Object.prototype.hasOwnProperty.call(r, 'trip')
      };
    });
  }
  // Worked out once per board answer.
  function boardByEmail() {
    var val = st.slots.board.val;
    if (st.bm && st.bm.val === val) return st.bm.map;
    var o = {};
    boardRows().forEach(function (r) { o[r.email] = r; });
    st.bm = { val: val, map: o };
    return o;
  }
  // Is this person field staff (route, km, trips, travel allowance)? true /
  // false when the server says so — a day record or register person
  // (rec.field_staff), the board, or Settings → People (track_location IS
  // the field switch) — and null when nothing says: the screen then shows
  // what 1.12 showed (a v2.3 server).
  function fieldOf(email, rec) {
    if (rec && typeof rec.field_staff === 'boolean') return rec.field_staff;
    var e = lower(email);
    var b = boardByEmail()[e];
    if (b && typeof b.field_staff === 'boolean') return b.field_staff;
    var p = settingsPeople().filter(function (x) { return lower(x.email) === e; })[0];
    if (p && typeof p.field_staff === 'boolean') return p.field_staff;
    if (p && typeof p.track_location === 'boolean') return p.track_location;
    return null;
  }
  // Route, km and trips are shown unless the person is known not to be field staff.
  function showsRoute(email, rec) { return fieldOf(email, rec) !== false; }

  // hr_register → flat day records { email, name, day, …record }
  function regRecords() {
    var v = objOf(st.slots.reg.val);
    if (!v) return [];
    var out = [];
    var push = function (r, base) {
      if (!r || typeof r !== 'object') return;
      var x = Object.assign({}, base || {}, r);
      var email = lower(x.email || x.employee_email);
      var day = String(x.day || x.date || '').slice(0, 10);
      if (!email || !validDay(day)) return;
      x.email = email; x.day = day;
      x.name = String(x.name || x.employee_name || x.full_name || nameOf(email));
      out.push(x);
    };
    (Array.isArray(v) ? v : (Array.isArray(v.rows) ? v.rows : [])).forEach(function (r) { push(r); });
    (Array.isArray(v.people) ? v.people : []).forEach(function (p) {
      if (!p) return;
      var base = { email: p.email || p.employee_email, name: p.name || p.full_name || p.employee_name, designation: p.designation, self: p.self === true };
      if (typeof p.field_staff === 'boolean') base.field_staff = p.field_staff;
      (Array.isArray(p.days) ? p.days : []).forEach(function (d) { push(d, base); });
    });
    return out;
  }

  function reqRows(name) {
    return rowsOf(name).filter(function (r) { return r && r.id; }).map(function (r) {
      var email = lower(r.employee_email || r.email);
      return Object.assign({}, r, { email: email, name: String(r.employee_name || r.name || nameOf(email)) });
    });
  }

  // hr_roster_get → { cells: {'email|day': {duty, source, note, source_request_id}},
  // holidays: {day: name}, people: [{email, name, self}] }. source says where
  // the duty comes from: 'roster' (set by someone), 'holiday', 'weekly_off' or
  // 'default' (shop). A plain rows list (roster rows only) is read too.
  function rosterData() {
    var v = objOf(st.slots.roster.val) || {};
    var cells = {}, people = [];
    (Array.isArray(v.people) ? v.people : []).forEach(function (p) {
      var e = p ? lower(p.email || p.employee_email) : '';
      if (!e) return;
      people.push({ email: e, name: String(p.name || p.full_name || e), self: p.self === true });
      (Array.isArray(p.days) ? p.days : []).forEach(function (d) {
        if (!d || !d.day) return;
        cells[e + '|' + String(d.day).slice(0, 10)] = { duty: d.duty || null, source: d.source || null, note: d.note || null,
          source_request_id: d.request_id || d.source_request_id || null };
      });
    });
    (Array.isArray(v.rows) ? v.rows : []).forEach(function (r) {
      if (!r || !(r.email || r.employee_email) || !r.day) return;
      cells[lower(r.email || r.employee_email) + '|' + String(r.day).slice(0, 10)] = { duty: r.duty || null, source: 'roster',
        note: r.note || null, source_request_id: r.source_request_id || r.request_id || null };
    });
    var hol = {};
    (Array.isArray(v.holidays) ? v.holidays : []).forEach(function (h) { if (h && h.day) hol[String(h.day).slice(0, 10)] = String(h.name || 'Holiday'); });
    return { cells: cells, holidays: hol, people: people };
  }

  function settingsData() {
    var v = objOf(st.slots.settings.val);
    if (!v) return null;
    return (v.settings && typeof v.settings === 'object') ? Object.assign({}, v.settings, { me: v.me }) : v;
  }
  function hhmm(v) { var s = String(v == null ? '' : v); return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5).padStart(5, '0') : ''; }
  // Only for a roster answer that does not say where a duty comes from.
  function weeklyOffOf(email, day) {
    var b = boardByEmail()[lower(email)];
    if (b && b.shift && Array.isArray(b.shift.weekly_off)) return b.shift.weekly_off;
    var ps = settingsData() ? personShiftOn(email, validDay(day) ? day : today()) : null;
    if (ps && Array.isArray(ps.weekly_off)) return ps.weekly_off;
    return [0];
  }

  // ── shift history (HR-SPEC §9.4.6) ───────────────────────────────────────
  // The shift for a day is the history row with the greatest effective_from
  // ≤ that day. hr_settings_get's own shift fields are a display copy of the
  // NEWEST default row, which may only start later (a change planned for
  // next week), so the screen reads `history` (the default rows) and uses
  // the top-level fields only when an answer has no row for the day.
  var SHIFT_FIELDS = ['shift_start', 'shift_end', 'grace_min', 'weekly_off', 'half_day_min'];
  function shiftOnRows(rows, day) {
    var f = F();
    return f && typeof f.shiftOn === 'function' ? f.shiftOn(rows, day) : null;
  }
  // The office default in force on day: {effective_from, shift_start, …}.
  function defaultShift(day) {
    var s = settingsData();
    if (!s) return null;
    var row = shiftOnRows(Array.isArray(s.history) ? s.history : [], validDay(day) ? day : today());
    var out = { effective_from: row && row.effective_from ? String(row.effective_from).slice(0, 10) : null };
    SHIFT_FIELDS.forEach(function (k) { out[k] = row && row[k] != null ? row[k] : (s[k] != null ? s[k] : null); });
    return out;
  }
  // Planned changes of the office default (rows from after today), earliest first.
  function defaultPlanned() {
    var s = settingsData(), f = F();
    if (!s || !f || typeof f.shiftsAfter !== 'function') return [];
    return f.shiftsAfter(Array.isArray(s.history) ? s.history : [], today());
  }
  // The shift a person works on day, as the server works it out: their own
  // row in force that day (people[].shift is the one in force today,
  // people[].upcoming the later ones), each empty field from the office
  // default in force that day.
  function personShiftOn(email, day) {
    var e = lower(email);
    var p = settingsPeople().filter(function (x) { return lower(x.email) === e; })[0];
    var rows = [];
    if (p && p.shift && typeof p.shift === 'object') rows.push(p.shift);
    if (p && Array.isArray(p.upcoming)) rows = rows.concat(p.upcoming);
    var d = validDay(day) ? day : today();
    var own = shiftOnRows(rows, d);
    var dflt = defaultShift(d) || {};
    var out = {};
    SHIFT_FIELDS.forEach(function (k) { out[k] = own && own[k] != null ? own[k] : (dflt[k] != null ? dflt[k] : null); });
    return out;
  }
  function hoursText(x) { return (hhmm(x && x.shift_start) || '—') + ' – ' + (hhmm(x && x.shift_end) || '—'); }
  // One planned default row, said against the row before it: the hours, and
  // whatever else changes.
  function plannedText(row, prev) {
    var parts = ['office hours ' + hoursText(row)];
    var f = F();
    if (row.grace_min != null && num(row.grace_min) !== num(prev && prev.grace_min)) parts.push('grace ' + num(row.grace_min) + ' min');
    if (Array.isArray(row.weekly_off) && !(prev && Array.isArray(prev.weekly_off) && row.weekly_off.slice().sort().join() === prev.weekly_off.slice().sort().join())) {
      parts.push('weekly off ' + (f ? f.weeklyOffText(row.weekly_off) : row.weekly_off.join(', ')));
    }
    if (row.half_day_min != null && num(row.half_day_min) !== num(prev && prev.half_day_min)) parts.push('half day under ' + fmtDur(row.half_day_min));
    return parts.join(' · ');
  }

  function taData() {
    var v = objOf(st.slots.ta.val);
    if (!v) return null;
    var list = Array.isArray(v) ? v : (Array.isArray(v.rows) ? v.rows : (Array.isArray(v.people) ? v.people : []));
    var rows = list.filter(function (r) { return r && (r.email || r.employee_email); }).map(function (r) {
      var email = lower(r.email || r.employee_email);
      var ap = r.approved && typeof r.approved === 'object' ? r.approved : null;
      return {
        raw: r, email: email, name: String(r.name || r.employee_name || nameOf(email)), self: r.self === true || isSelf(email),
        km: numOrNull(r.km), rate: numOrNull(r.rate), amount: numOrNull(r.amount),
        approved: ap ? { by: ap.by || ap.by_name || ap.approved_by_name || ap.approved_by_email || '', at: ap.at || ap.approved_at || null } : null,
        live_km: numOrNull(r.live_km), changed: r.changed === true,
        eligible: r.ta_eligible !== false && r.eligible !== false,
        can_approve: typeof r.can_approve === 'boolean' ? r.can_approve : null,
        days: Array.isArray(r.days) ? r.days : [],
        // v2.4: km is trip km (what TA pays); day_km is the whole day's route.
        day_km: numOrNull(r.day_km), field_staff: typeof r.field_staff === 'boolean' ? r.field_staff : null,
        v4: Object.prototype.hasOwnProperty.call(r, 'day_km')
      };
    }).filter(function (r) {
      // TA is for field staff only (the v2.4 server already sends only them,
      // plus anyone approved that month).
      return r.approved || fieldOf(r.email, r) !== false;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var rate = numOrNull(v.rate != null ? v.rate : v.ta_rate_per_km);
    if (rate == null) { var s = settingsData(); if (s) rate = numOrNull(s.ta_rate_per_km); }
    return { month: String(v.month || st.v.taMonth).slice(0, 10), rate: rate, rows: rows,
             closed: typeof v.closed === 'boolean' ? v.closed : null,
             trips: rows.some(function (r) { return r.v4; }) };
  }

  // Tier 4+: everyone's NeoHR settings from hr_settings_get().people —
  // [{email, name, tier, designation, self, can_edit, ta_eligible,
  // track_location, attendance_required, shift: {effective_from, shift_start,
  // shift_end, grace_min, weekly_off, half_day_min} | null, upcoming: [...]}]
  function settingsPeople() {
    var s = settingsData();
    return (s && Array.isArray(s.people) ? s.people : []).filter(function (p) { return p && p.email; });
  }
  function staffRows() {
    var list = settingsPeople().map(function (p) { return { email: p.email, full_name: p.name, tier: p.tier, designation: p.designation }; });
    if (!list.length) { var d = D(); if (d && typeof d.staff === 'function' && !isDemo()) { try { list = d.staff() || []; } catch (e) { list = []; } } }
    return list.filter(function (s) { return s && s.email && s.active !== false && s.is_staff !== false; });
  }
  // One person's overrides, flattened: {shift_start, shift_end, grace_min,
  // weekly_off, half_day_min (null = the default), ta_eligible,
  // track_location, attendance_required, upcoming, can_edit, self, tier}.
  function personRow(email) {
    var e = lower(email);
    var p = settingsPeople().filter(function (x) { return lower(x.email) === e; })[0];
    if (!p) return null;
    var sh = p.shift && typeof p.shift === 'object' ? p.shift : {};
    return {
      shift_start: sh.shift_start || null, shift_end: sh.shift_end || null, grace_min: numOrNull(sh.grace_min),
      weekly_off: Array.isArray(sh.weekly_off) ? sh.weekly_off : null, half_day_min: numOrNull(sh.half_day_min),
      ta_eligible: p.ta_eligible !== false, track_location: p.track_location !== false, attendance_required: p.attendance_required !== false,
      upcoming: Array.isArray(p.upcoming) ? p.upcoming : [], can_edit: typeof p.can_edit === 'boolean' ? p.can_edit : null,
      self: p.self === true, tier: numOrNull(p.tier)
    };
  }

  // Names of everyone this screen has heard of: the board, the team, the
  // logs and activity it loaded, and (outside demo mode) the staff list.
  // Worked out once per paint (render() clears st.kp).
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
    boardRows().forEach(function (p) { add(p.email, p.name); });
    teamPeople().forEach(function (p) { add(p.email, p.name); });
    ['todayLogs', 'logs'].forEach(function (k) { rowsOf(k).forEach(function (r) { add(r.employee_email, r.employee_name); }); });
    ['todayAct', 'act'].forEach(function (k) { rowsOf(k).forEach(function (r) { add(r.employee_email, r.employee_name); }); });
    staffRows().forEach(function (s) { add(s.email, s.full_name || s.name); });
    [st.person, st.v.regPerson, st.v.routePerson].forEach(function (e) { if (e && !map[e]) map[e] = e; });
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
  function visibleTabs() { var t = tierNow(); return TAB_DEFS.filter(function (d) { return !d.tier || t >= d.tier; }); }
  function fixTab() { if (!visibleTabs().some(function (d) { return d.id === st.tab; })) st.tab = 'live'; }
  function pendingList() { return reqRows('reqPending').filter(function (r) { return !r.status || r.status === 'pending'; }); }
  function pendingCount() {
    var p = st.slots.reqPending.val;
    if (p) return pendingList().length;
    if (st.slots.board.val) return boardRows().reduce(function (a, r) { return a + r.pending; }, 0);
    return null;
  }
  // Waiting requests already past the end of their day (punch kinds, v2.4).
  function pastEodCount() {
    var t = today(), now = nowMs(), f = F();
    if (!st.slots.reqPending.val || !f) return 0;
    return pendingList().filter(function (r) { var d = f.dueText(r, t, now); return !!(d && d.late); }).length;
  }

  function renderToolbar() {
    var tb = el('hr-toolbar');
    if (!tb) return;
    var busy = Object.keys(st.slots).some(function (k) { return st.slots[k].loading; });
    var pend = pendingCount();
    var late = pend ? pastEodCount() : 0;
    var tabs = visibleTabs();
    var sig = st.tab + '|' + (busy ? 1 : 0) + '|' + pend + '|' + late + '|' + tabs.length;
    if (tb.dataset.sig === sig) return;
    tb.dataset.sig = sig;
    tb.innerHTML =
      '<div class="hr-tabs" role="group" aria-label="Show">' +
        tabs.map(function (t) {
          var on = st.tab === t.id;
          var badge = t.id === 'requests' && pend
            ? ' <span class="hr-badge' + (late ? ' hr-badge-late' : '') + '" aria-label="' +
              esc(plural(pend, 'request') + ' waiting' + (late ? ', ' + late + ' past the end of the day' : '')) + '"' +
              (late ? ' title="' + esc(plural(late, 'request') + ' past the end of the day') + '"' : '') + '>' + esc(pend) + '</span>'
            : '';
          return '<button type="button" class="hr-tab' + (on ? ' on' : '') + '" data-hr-tab="' + t.id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(t.label) + badge + '</button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="secondary-btn hr-refresh" data-hr-tb="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Loading…' : '↻ Refresh') + '</button>';
  }

  function seg(list, cur, attr, aria) {
    return '<div class="hr-tabs hr-seg" role="group" aria-label="' + esc(aria) + '">' + list.map(function (x) {
      var on = x[0] === cur;
      return '<button type="button" class="hr-chip' + (on ? ' on' : '') + '" ' + attr + '="' + x[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';
  }
  function navBtns(prefix, todayText) {
    return '<div class="hr-nav" role="group">' +
      '<button type="button" class="hr-chip" data-hr-ctl="' + prefix + '-prev" aria-label="Earlier">‹</button>' +
      '<button type="button" class="hr-chip" data-hr-ctl="' + prefix + '-now">' + esc(todayText) + '</button>' +
      '<button type="button" class="hr-chip" data-hr-ctl="' + prefix + '-next" aria-label="Later">›</button></div>';
  }

  // The per-tab control bar is built once per tab (and view) and updated in
  // place, so typing or picking in it is never interrupted by a repaint.
  function controlsSig() {
    if (st.tab === 'live') return 'live|' + st.v.liveView;
    if (st.tab === 'attendance') return 'att|' + st.v.regView;
    if (st.tab === 'logs') return 'logs';
    if (st.tab === 'requests') return 'requests|' + (st.reqV3 ? 3 : 4);
    return st.tab;
  }
  // A v2.3 server has no punch reasons: no chip for them.
  function reqScopes() { return st.reqV3 ? REQ_SCOPES.filter(function (x) { return x[0] !== 'today'; }) : REQ_SCOPES; }
  function controlsHtml() {
    var v = st.v;
    if (st.tab === 'live') {
      return seg(LIVE_VIEWS, v.liveView, 'data-hr-live-view', 'View') +
        (v.liveView === 'board' ? '<label class="hr-f hr-f-grow"><span>Search</span><input type="search" id="hr-live-search" maxlength="60" placeholder="Name, designation, job…" autocomplete="off" spellcheck="false"></label>' : '') +
        (v.liveView === 'punches' ? '<label class="hr-f"><span>Day</span><input type="date" id="hr-checks-day"></label>' + navBtns('checks', 'Today') : '');
    }
    if (st.tab === 'attendance') {
      return seg(REG_VIEWS, v.regView, 'data-hr-reg-view', 'View') +
        (v.regView === 'month'
          ? '<label class="hr-f"><span>Month</span><input type="month" id="hr-reg-month"></label>' + navBtns('reg', 'This month')
          : '<label class="hr-f"><span>Day</span><input type="date" id="hr-reg-day"></label>' + navBtns('reg', 'Today')) +
        '<label class="hr-f"><span>Person</span><select id="hr-reg-person"></select></label>' +
        '<button type="button" class="secondary-btn hr-btn" data-hr-ctl="reg-csv">Export CSV</button>';
    }
    if (st.tab === 'requests') {
      return seg(reqScopes(), v.reqScope, 'data-hr-req-scope', 'Show') +
        '<span class="hr-muted" id="hr-req-note"></span>';
    }
    if (st.tab === 'roster') {
      return navBtns('roster', 'This week') + '<span class="hr-ctl-label" id="hr-roster-label"></span>' +
        '<button type="button" class="secondary-btn hr-btn" data-hr-ctl="holidays">Holidays…</button>';
    }
    if (st.tab === 'routes') {
      return '<label class="hr-f"><span>Person</span><select id="hr-route-person"></select></label>' +
        '<label class="hr-f"><span>Day</span><input type="date" id="hr-route-day"></label>' + navBtns('route', 'Today');
    }
    if (st.tab === 'ta') {
      return '<label class="hr-f"><span>Month</span><input type="month" id="hr-ta-month"></label>' + navBtns('ta', 'Last month') +
        '<button type="button" class="secondary-btn hr-btn" data-hr-ctl="ta-csv">Export CSV</button>';
    }
    if (st.tab === 'logs') return seg(LOG_VIEWS, v.logsView, 'data-hr-logs-view', 'Show');
    return '';
  }
  function fillPeopleSelect(sel, blank, cur, list) {
    if (!sel) return;
    var people = list || knownPeople();
    var sig = blank + '#' + people.map(function (p) { return p.email + '=' + p.name; }).join(',');
    if (sel.dataset.sig !== sig && document.activeElement !== sel) {
      sel.dataset.sig = sig;
      sel.textContent = '';
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = blank;
      sel.appendChild(o0);
      people.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.email;
        o.textContent = (p.name === p.email ? p.email : p.name) + (isSelf(p.email) ? ' (you)' : '');
        sel.appendChild(o);
      });
    }
    if (document.activeElement !== sel && sel.value !== cur) sel.value = cur;
  }
  function setVal(id, v) { var x = el(id); if (x && document.activeElement !== x && x.value !== v) x.value = v; }
  function renderControls() {
    var host = el('hr-controls');
    if (!host) return;
    var html = controlsHtml();
    host.classList.toggle('hidden', !html);
    if (!html) { host.textContent = ''; delete host.dataset.sig; return; }
    var sig = controlsSig();
    if (host.dataset.sig !== sig) {
      host.dataset.sig = sig;
      host.innerHTML = html;
      var ui = UI();
      if (ui && typeof ui.guardEnter === 'function') { try { ui.guardEnter(host); } catch (e) { /* Enter just does nothing */ } }
    }
    var v = st.v, t = today();
    if (st.tab === 'live') {
      setVal('hr-live-search', v.liveSearch);
      setVal('hr-checks-day', v.checksDay);
      var cd = el('hr-checks-day');
      if (cd) {
        cd.max = t;
        var cs = settingsData();
        cd.min = addDays(t, -Math.max(30, num(cs && cs.retention_days, 90)));
      }
    }
    if (st.tab === 'attendance') {
      setVal('hr-reg-day', v.regDay); setVal('hr-reg-month', v.regMonth.slice(0, 7));
      var d = el('hr-reg-day'); if (d) d.max = t;
      var mo = el('hr-reg-month'); if (mo) mo.max = t.slice(0, 7);
      fillPeopleSelect(el('hr-reg-person'), 'Everyone', v.regPerson);
    }
    if (st.tab === 'routes') {
      fillPeopleSelect(el('hr-route-person'), 'Choose a person…', v.routePerson, routePeople());
      setVal('hr-route-day', v.routeDay);
      var rd = el('hr-route-day');
      if (rd) {
        rd.max = t;
        var s = settingsData();
        rd.min = addDays(t, -Math.max(30, num(s && s.retention_days, 90)));
      }
    }
    if (st.tab === 'ta') { setVal('hr-ta-month', v.taMonth.slice(0, 7)); var tm = el('hr-ta-month'); if (tm) tm.max = t.slice(0, 7); }
    if (st.tab === 'roster') {
      var lab = el('hr-roster-label');
      if (lab) lab.textContent = shortDay(v.rosterWeek) + ' – ' + shortDay(addDays(v.rosterWeek, 6)) + ' ' + addDays(v.rosterWeek, 6).slice(0, 4);
      var hb = host.querySelector('[data-hr-ctl="holidays"]');
      if (hb) { var hw = holidaysWhyNot(); hb.disabled = !!hw; hb.title = hw || 'Add or remove a holiday'; }
    }
    if (st.tab === 'requests') {
      var note = el('hr-req-note');
      if (note) {
        note.textContent = v.reqScope === 'all' ? 'The last ' + REQ_BACK_DAYS + ' days and anything coming up.'
          : v.reqScope === 'today' ? 'Every punch-in reason and away punch of today, decided or not.' : '';
      }
    }
    host.querySelectorAll('.hr-seg [aria-pressed]').forEach(function (b) {
      var key = b.getAttribute('data-hr-live-view') || b.getAttribute('data-hr-reg-view') || b.getAttribute('data-hr-req-scope') || b.getAttribute('data-hr-logs-view');
      var cur = b.hasAttribute('data-hr-live-view') ? v.liveView : b.hasAttribute('data-hr-reg-view') ? v.regView
        : b.hasAttribute('data-hr-req-scope') ? v.reqScope : v.logsView;
      var on = key === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // The filter bar (Logs) is built once per view and updated in place, so
  // typing in it is never interrupted by a repaint.
  function renderFilters() {
    var host = el('hr-filters');
    if (!host) return;
    var show = st.tab === 'logs';
    host.classList.toggle('hidden', !show);
    if (!show) { host.textContent = ''; st.filterSig = null; st.peopleSig = null; return; }
    var r = range();
    var rebuilt = false;
    var view = st.v.logsView;
    // The bar itself only when the view changes (static markup, no data in it).
    if (st.filterSig !== view) {
      st.filterSig = view;
      st.peopleSig = null;
      rebuilt = true;
      host.innerHTML =
        '<label class="hr-f"><span>Person</span><select id="hr-person"></select></label>' +
        '<div class="hr-presets" role="group" aria-label="Dates">' +
          PRESETS.map(function (p) { return '<button type="button" class="hr-chip" data-hr-preset="' + p[0] + '" aria-pressed="false">' + esc(p[1]) + '</button>'; }).join('') +
        '</div>' +
        '<label class="hr-f"><span>From</span><input type="date" id="hr-from"></label>' +
        '<label class="hr-f"><span>To</span><input type="date" id="hr-to"></label>' +
        (view === 'logs' ? '<label class="hr-f hr-f-grow"><span>Search</span><input type="search" id="hr-search" maxlength="80" placeholder="Title, note, category, place…" autocomplete="off" spellcheck="false"></label>' : '') +
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
    if (!profile()) { destroyMap(); root.textContent = ''; setStat('—'); return; }
    if (!el('hr-body')) {
      root.innerHTML = '<div id="hr-controls" class="hr-filters hr-controls hidden"></div>' +
        '<div id="hr-filters" class="hr-filters hidden"></div><div id="hr-body" class="hr-body"></div>';
    }
    fixTab();
    renderToolbar();
    var body = el('hr-body');
    if (!canOpen()) {
      destroyMap();
      el('hr-controls').classList.add('hidden');
      el('hr-filters').classList.add('hidden');
      body.dataset.view = '';
      body.innerHTML = banner('NeoHR is for heads (tier 3 and above) and NeoHR leads.', 'info');
      setStat('—');
      return;
    }
    renderControls();
    renderFilters();
    if (!F() && st.tab !== 'logs' && st.tab !== 'app') {
      destroyMap();
      body.dataset.view = '';
      body.innerHTML = banner('This needs the Neo OS 1.12 files. Restart Neo OS after the update finishes.', 'error');
      return;
    }
    if (st.tab === 'routes') { renderRoutes(body); return; }
    destroyMap();
    var html;
    if (st.tab === 'attendance') html = attendanceHtml();
    else if (st.tab === 'requests') html = requestsHtml();
    else if (st.tab === 'roster') html = rosterHtml();
    else if (st.tab === 'ta') html = taHtml();
    else if (st.tab === 'settings') html = settingsHtml();
    else if (st.tab === 'logs') html = st.v.logsView === 'activity' ? activityHtml() : logsHtml();
    else if (st.tab === 'app') html = appHtml();
    else html = liveHtml();
    body.dataset.view = st.tab;
    body.innerHTML = html;
  }

  function slotBanner(name, what) {
    var s = st.slots[name];
    if (!s.err) return '';
    return banner((s.val ? 'Showing the last answer — ' : '') + what + ': ' + errText(s.err), s.val ? 'warn' : 'error');
  }
  function emptyBox(text) { return '<div class="hr-empty">' + esc(text) + '</div>'; }
  function loadingBox(text) { return '<div class="hr-empty hr-loading">' + esc(text) + '</div>'; }
  function demoWriteBanner() {
    return isDemo() ? banner('Demo data is on. Attendance is real, so it shows here, but changes are switched off until you turn demo data off in Settings.', 'demo') : '';
  }
  // A button that may be disabled with a reason (the reason is its title).
  function actBtn(cls, act, text, attrs, why) {
    return '<button type="button" class="' + cls + ' hr-btn" data-hr-act="' + act + '"' + (attrs || '') +
      (why ? ' disabled title="' + esc(why) + '"' : '') + '>' + esc(text) + '</button>';
  }
  // Why the viewer may not act on this person's records (null = they may).
  function whyNotAct(email) {
    if (!canApprove()) return NOT_APPROVER;
    if (isSelf(email)) return selfSentence();
    if (isDemo()) return DEMO_OFF;
    return null;
  }
  function chip(cls, text, title) {
    return '<span class="hr-ls ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  }
  function liveChip(status) { return chip('hr-ls-' + (/^[a-z_]+$/.test(status) ? status : 'x'), label('LIVE_LABELS', status) || '—'); }
  function dayChip(status) { return chip('hr-ds-' + (/^[a-z_]+$/.test(status) ? status : 'x'), label('DAY_LABELS', status) || '—'); }
  function tag(text, cls, title) { return '<span class="hr-mark' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  // ⏱ marks for an approver — never on the viewer's own records. One punch
  // (the day panel): the server's sentence when it sends one, else the same
  // rule here (shared/hr-format.js).
  function clockTag(ev, email) {
    var f = F();
    if (!ev || isSelf(email)) return '';
    var text = null, skew = false;
    if (Object.prototype.hasOwnProperty.call(ev, 'clock_mark')) { text = ev.clock_mark ? String(ev.clock_mark) : null; skew = /off by/.test(text || ''); }
    else if (f) { var m = f.clockMark(ev); if (m) { text = m.text; skew = m.kind === 'skew'; } }
    return text ? tag(text, 'hr-mark-clock', skew ? 'The phone’s clock was wrong; the server’s time is shown.' : 'The phone was offline and its clock could not be checked.') : '';
  }
  // A day or a board row: the server counts the punches with such a mark.
  function countClockTag(n, email) {
    n = Math.max(0, num(n));
    if (!n || isSelf(email)) return '';
    return tag('⏱ ' + n, 'hr-mark-clock', plural(n, 'punch', 'punches') + ' with a time that is not verified or a phone clock more than 5 minutes off — open the day to see which.');
  }
  function recClockTags(rec, email) { return countClockTag(rec.clock_marks, email); }

  // ── Live ──────────────────────────────────────────────────────────────────
  function tile(n, label2, tone, title) {
    return '<div class="hr-tile' + (tone ? ' hr-t-' + tone : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<div class="hr-tile-n">' + esc(n == null ? '—' : n) + '</div><div class="hr-tile-l">' + esc(label2) + '</div></div>';
  }
  function liveMatches(r, q) {
    if (!q) return true;
    var site = r.on_site || {};
    return [r.name, r.email, r.designation, site.code, site.title, label('LIVE_LABELS', r.status)]
      .some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
  }
  // The office point is not set: nobody's punch is checked against the shop.
  function officeUnset() {
    var s = settingsData();
    return !!s && (numOrNull(s.office_lat) == null || numOrNull(s.office_lng) == null);
  }
  function officeBanner() {
    if (!officeUnset()) return '';
    return banner('The office location is not set, so punches are not checked against the shop yet: nobody is asked why they are away. ' +
      (tierNow() >= 4 ? 'Set it in Settings → Edit… (pick it on the map).' : 'Someone at tier 4 or above sets it in Settings.'), 'warn');
  }
  // The server's check of today's first punch-in, as small tags (Live).
  function punchCheckTags(pc) {
    var f = F();
    if (!pc || !f) return '';
    var out = [];
    var place = f.placeText(pc);
    if (place) out.push(tag(place, 'hr-mark-' + f.placeTone(pc), 'Where the server puts today’s first punch-in'));
    var vt = f.verifyText(pc);
    if (vt) out.push(tag(vt, 'hr-mark-clock'));
    var flags = f.flagList(pc);
    if (flags.length) out.push(tag('⚑ ' + flags.length, 'hr-mark-warn', flags.map(function (x) { return x.text + (x.tip ? ' — ' + x.tip : ''); }).join('\n')));
    if (pc.selfie === false && !pc.selfie_skip) out.push(tag('No photo', 'hr-mark-warn', 'No photo came with the punch-in yet.'));
    return out.join('');
  }
  function liveHtml() {
    var html = [];
    if (st.v.liveView === 'load') {
      html.push(teamHtml());
      return html.join('');
    }
    if (st.v.liveView === 'punches') return checksHtml();
    html.push(slotBanner('board', 'The live board could not be loaded'));
    html.push(officeBanner());
    var s = st.slots.board;
    var rows = boardRows();
    var f = F();
    var order = f ? f.LIVE_ORDER : [];
    var counts = {};
    rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var pc = pendingCount();
    var pend = pc != null ? pc : rows.reduce(function (a, r) { return a + r.pending; }, 0);
    var late = pastEodCount();
    // v2.4: who is on a trip right now (field staff).
    var v4 = rows.some(function (r) { return r.v4; });
    var onTrip = rows.filter(function (r) { return !!r.trip; }).length;
    counts.trip = onTrip;
    var cur = st.v.liveFilter;
    if (cur !== 'all' && !counts[cur]) cur = st.v.liveFilter = 'all';
    var tiles = [['all', rows.length, 'Everyone']].concat(order.map(function (k) { return [k, counts[k] || 0, label('LIVE_LABELS', k)]; }));
    if (v4) tiles.push(['trip', onTrip, (f && f.LIVE_TRIP_LABEL) || 'On a trip']);
    html.push('<div class="hr-ltiles" role="group" aria-label="Filter by status">' + tiles.map(function (x) {
      var on = x[0] === cur;
      return '<button type="button" class="hr-ltile hr-lt-' + x[0] + (on ? ' on' : '') + (x[1] ? '' : ' zero') + '" data-hr-act="live-filter" data-hr-status="' + x[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (s.val ? '' : ' disabled') + '><span class="hr-ltile-n">' + esc(s.val ? x[1] : '—') + '</span><span class="hr-ltile-l">' + esc(x[2]) + '</span></button>';
    }).join('') +
      '<button type="button" class="hr-ltile hr-lt-pending' + (pend ? '' : ' zero') + (late ? ' hr-lt-late' : '') + '" data-hr-act="tab" data-hr-to="requests"' +
        (late ? ' title="' + esc(plural(late, 'request') + ' past the end of the day') + '"' : '') + '><span class="hr-ltile-n">' + esc(s.val ? pend : '—') + '</span>' +
        '<span class="hr-ltile-l">Waiting for approval' + (late ? ' · ' + esc(late) + ' past end of day' : '') + '</span></button>' +
    '</div>');
    if (!s.val) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading who is in…') : (s.err ? '' : emptyBox('Nothing yet.')));
      html.push(appStrip());
      return html.join('');
    }
    var q = lower(st.v.liveSearch);
    var shown = rows.filter(function (r) { return (cur === 'all' || (cur === 'trip' ? !!r.trip : r.status === cur)) && liveMatches(r, q); });
    var rank = {};
    order.forEach(function (k, i) { rank[k] = i; });
    shown.sort(function (a, b) { return ((rank[a.status] != null ? rank[a.status] : 99) - (rank[b.status] != null ? rank[b.status] : 99)) || a.name.localeCompare(b.name); });
    var t = today();
    // The waiting requests per person, punch kinds included (the board's
    // own count has the v2.3 kinds only).
    var waitBy = null;
    if (st.slots.reqPending.val) {
      waitBy = {};
      pendingList().forEach(function (q) { waitBy[q.email] = (waitBy[q.email] || 0) + 1; });
    }
    var tripCol = v4 && rows.some(function (r) { return r.field_staff !== false; });
    if (!shown.length) {
      html.push(emptyBox(rows.length ? 'Nobody matches.' : 'No staff on the board yet.'));
    } else {
      var out = '<div class="hr-table-wrap"><table class="hr-table hr-live"><thead><tr>' +
        '<th scope="col">Person</th><th scope="col">Now</th><th scope="col">Duty</th><th scope="col">Shift</th><th scope="col">In</th>' +
        '<th scope="col">Worked</th><th scope="col">On site</th>' + (tripCol ? '<th scope="col">Trip</th>' : '') +
        '<th scope="col">Location</th><th scope="col">Requests</th><th scope="col"><span class="hr-sr">Actions</span></th>' +
        '</tr></thead><tbody>';
      shown.forEach(function (r) {
        var onField = r.field_staff !== false;
        var site = r.on_site;
        var siteHtml = site ? '<span class="hr-site"><b>' + esc(site.code || '') + '</b> ' + esc(site.title || '') +
          ((site.since || site.arrived) ? ' <span class="hr-muted">since ' + esc(istHm(site.since || site.arrived)) + '</span>' : '') + '</span>' : '<span class="hr-muted">—</span>';
        var loc;
        var stale = r.stale && onField;
        if (!onField) {
          loc = '<span class="hr-muted" title="Not field staff: their phone records no route.">—</span>';
        } else if (stale) {
          var ref = r.last_point_at || r.since;
          loc = '<span class="hr-stale" title="Recording should send a point every few minutes while on duty.">⚠ ' +
            esc(r.last_point_at ? 'Last point ' + fmtRel(r.last_point_at) : 'No location yet' + (ref ? ' (in since ' + istHm(ref) + ')' : '')) + '</span>';
        } else {
          loc = r.last_point_at ? esc(fmtRel(r.last_point_at)) : '<span class="hr-muted">—</span>';
        }
        var tripHtml = '';
        if (tripCol) {
          tripHtml = r.trip
            ? '<td><span class="hr-site"><b>' + esc(f ? f.tripText(r.trip) : 'Trip') + '</b>' +
              (r.trip.started_at ? ' <span class="hr-muted">since ' + esc(istHm(r.trip.started_at)) + '</span>' : '') + '</span></td>'
            : '<td><span class="hr-muted">—</span></td>';
        }
        var since = r.since ? ' <span class="hr-muted">since ' + esc(hmOn(r.since, t)) + '</span>' : '';
        var marks = r.self ? '' : countClockTag(r.clock_marks, r.email);
        var waiting = waitBy ? (waitBy[r.email] || 0) : r.pending;
        out += '<tr class="' + (stale ? 'hr-row-stale' : '') + '">' +
          '<th scope="row"><div class="hr-who">' + esc(r.name) + (r.self ? ' <span class="hr-you">you</span>' : '') + '</div>' +
            (r.designation ? '<div class="hr-muted">' + esc(r.designation) + '</div>' : '') + '</th>' +
          '<td>' + liveChip(r.status) + since + '</td>' +
          '<td>' + esc(r.duty ? label('DUTY_LABELS', r.duty) : '—') + (r.holiday ? ' ' + tag(String(r.holiday), 'hr-mark-hol') : '') + '</td>' +
          '<td class="hr-n">' + esc((F() && F().shiftText(r.shift)) || '—') + '</td>' +
          '<td class="hr-n">' + esc(r.first_in ? hmOn(r.first_in, t) : '—') + marks + (r.first_in ? punchCheckTags(r.punch_check) : '') + '</td>' +
          '<td class="hr-n">' + esc(r.first_in || num(r.worked_min) > 0 ? fmtDur(r.worked_min) : '—') + '</td>' +
          '<td>' + siteHtml + '</td>' +
          tripHtml +
          '<td>' + loc + '</td>' +
          '<td>' + (waiting ? '<button type="button" class="text-btn hr-btn" data-hr-act="tab" data-hr-to="requests">' + esc(waiting + ' waiting') + '</button>' : '<span class="hr-muted">—</span>') + '</td>' +
          '<td class="hr-acts">' +
            '<button type="button" class="text-btn hr-btn" data-hr-act="open-day" data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(t) + '">Day</button>' +
            (onField ? '<button type="button" class="text-btn hr-btn" data-hr-act="open-route" data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(t) + '">Route</button>' : '') +
          '</td></tr>';
      });
      out += '</tbody></table></div>';
      html.push(out);
    }
    html.push('<p class="hr-hint">Live status comes from the punches on NeoHR. “Not in yet” turns into “Absent” after the shift start and grace (after the shift on a field or flexible day). ' +
      (v4 ? 'The tags beside In say where the server puts the first punch-in. Only field staff have a route and trips. ' : '') +
      'An amber row means a phone stopped sending its route while the person is on duty.</p>');
    html.push(appStrip());
    var inCount = (counts.on_duty || 0) + (counts.on_site || 0) + (counts.on_break || 0);
    setStat(plural(rows.length, 'person', 'people') + ' · ' + inCount + ' in now' + (pend ? ' · ' + pend + ' waiting' : ''));
    return html.join('');
  }

  // ── Live → Today's punches (hr_punch_checks, v2.4) ────────────────────────
  // [{event_id, email, name, kind, at, received_at, place, office_m, verify,
  //   flags, reason_kind, reason_text, reason_ref, selfie_skip, unverified?,
  //   request: {id, kind, status} | null,
  //   selfie: {thumb_b64, late, seen_by_me, seen_by_any} | null,
  //   prev: {thumb_b64, at, event_id?} | null}]   — the server's order kept.
  function checkRows() {
    var v = objOf(st.slots.checks.val);
    if (!v) return [];
    var list = Array.isArray(v) ? v : (Array.isArray(v.punches) ? v.punches : (Array.isArray(v.rows) ? v.rows : []));
    return list.filter(function (x) { return x && (x.email || x.employee_email); }).map(function (x) {
      var email = lower(x.email || x.employee_email);
      var prev = objOrNull(x.prev_selfie) || objOrNull(x.previous_selfie) ||
        (x.prev_thumb_b64 ? { thumb_b64: x.prev_thumb_b64, at: x.prev_at || null } : null);
      if (prev) prev = Object.assign({}, prev, { at: prev.at || prev.event_at || null });
      return Object.assign({}, x, { email: email, name: String(x.name || x.employee_name || nameOf(email)),
        event_id: x.event_id || x.id || null, selfie: objOrNull(x.selfie), prev: prev, request: objOrNull(x.request) });
    });
  }
  // Something for HR to look at: the server's own `unverified` when it says.
  function needsCheck(x) {
    if (typeof x.unverified === 'boolean') return x.unverified;
    var f = F();
    return !!((x.verify && x.verify !== 'ok' && x.verify !== 'hr') || (f && f.flagList(x).length) || !x.selfie ||
      x.selfie.late === true || x.place === 'unknown');
  }
  // A punch photo's thumbnail; a click opens the full photo (hr_selfie_get).
  function thumbHtml(b64, eventId, title, sub, small) {
    var f = F();
    var url = f ? f.jpegDataUrl(b64) : null;
    if (!url) return '<span class="hr-thumb hr-thumb-none' + (small ? ' sm' : '') + '">' + esc(small ? '—' : 'No photo') + '</span>';
    var img = '<img class="hr-thumb' + (small ? ' sm' : '') + '" src="' + esc(url) + '" alt="' + esc(title || 'Punch photo') + '">';
    if (!eventId) return img;
    return '<button type="button" class="hr-thumb-btn" data-hr-act="photo" data-hr-event="' + esc(eventId) + '" data-hr-title="' + esc(title || '') +
      '" data-hr-sub="' + esc(sub || '') + '" title="Open the full photo (each look is recorded)">' + img + '</button>';
  }
  // The checks of one punch as tags: place, how sure, flags.
  function checkTags(x) {
    var f = F();
    if (!f || !x) return '';
    var out = [];
    var place = f.placeText(x);
    if (place) out.push(tag(place, 'hr-mark-' + f.placeTone(x), 'Where the server puts this punch'));
    var vt = f.verifyText(x);
    if (vt) out.push(tag(vt, 'hr-mark-clock'));
    f.flagList(x).forEach(function (g) { out.push(tag(g.text, 'hr-mark-warn', g.tip)); });
    return out.join('');
  }
  function checkCard(x) {
    var f = F();
    var d = st.v.checksDay, t = today();
    var when = label('EVENT_LABELS', x.kind) + ' at ' + hmOn(x.at, d);
    var title = x.name + ' — ' + when;
    var sf = x.selfie;
    var sentLate = Array.isArray(x.flags) && x.flags.indexOf('sent_late') !== -1 && Math.abs(tsMs(x.received_at) - tsMs(x.at)) > 60000;
    var reason = f ? f.reasonText(x) : '';
    var rq = x.request;
    var seen = sf ? (sf.seen_by_me ? tag('Seen', 'hr-mark-info', 'You have opened this photo.') : (sf.seen_by_any === false ? tag('New photo', 'hr-mark-flex', 'Nobody has opened this photo yet.') : '')) : '';
    var prevAt = x.prev && x.prev.at ? shortDay(dayOf(x.prev.at)) + ' ' + istHm(x.prev.at) : '';
    // A photo whose thumbnail did not come (none sent, or not for this viewer):
    // the full photo is still a click away (the server says if it may be seen).
    var nowPic = sf && !sf.thumb_b64 && x.event_id
      ? '<button type="button" class="hr-thumb hr-thumb-none hr-thumb-btn" data-hr-act="photo" data-hr-event="' + esc(x.event_id) + '" data-hr-title="' + esc(title) +
        '" data-hr-sub="' + esc(dayLabel(d, t)) + '" title="Open the full photo (each look is recorded)">📷 Photo</button>'
      : thumbHtml(sf && sf.thumb_b64, x.event_id, title, dayLabel(d, t), false);
    return '<div class="hr-check' + (needsCheck(x) ? ' hr-check-flag' : '') + '">' +
      '<div class="hr-check-pics">' +
        '<figure>' + nowPic +
          '<figcaption>' + esc(sf ? (sf.late ? 'Sent late' : 'This punch') : (x.selfie_skip ? 'Camera failed' : 'No photo')) + '</figcaption></figure>' +
        (x.prev ? '<figure>' + thumbHtml(x.prev.thumb_b64, x.prev.event_id || null, x.name + ' — earlier photo', prevAt, true) +
          '<figcaption>' + esc('Before' + (prevAt ? ' · ' + prevAt : '')) + '</figcaption></figure>' : '') +
      '</div>' +
      '<div class="hr-check-main">' +
        '<div class="hr-who">' + esc(x.name) + (isSelf(x.email) ? ' <span class="hr-you">you</span>' : '') + '</div>' +
        '<div class="hr-check-when">' + esc(when) + (sentLate ? ' <span class="hr-muted">sent ' + esc(hmOn(x.received_at, d)) + '</span>' : '') + '</div>' +
        '<div class="hr-check-tags">' + checkTags(x) + seen + '</div>' +
        (reason ? '<div class="hr-req-reason">' + esc(reason) + '</div>' : '') +
        '<div class="hr-check-foot">' +
          (rq ? chip('hr-rs-' + (/^[a-z]+$/.test(String(rq.status)) ? rq.status : 'x'), label('REQUEST_LABELS', rq.kind) + ': ' + label('REQUEST_STATUS', rq.status)) : '') +
          '<span class="hr-req-acts">' +
            (rq && rq.status === 'pending' ? '<button type="button" class="text-btn hr-btn" data-hr-act="tab" data-hr-to="requests">Requests</button>' : '') +
            '<button type="button" class="text-btn hr-btn" data-hr-act="open-day" data-hr-email="' + esc(x.email) + '" data-hr-day="' + esc(d) + '">Day</button>' +
          '</span></div>' +
      '</div>' +
    '</div>';
  }
  function checksHtml() {
    var html = [];
    var s = st.slots.checks;
    var d = st.v.checksDay, t = today();
    if (s.err && !s.val && noRpc(s.err)) {
      setStat('—');
      return banner('Today’s punches need the HR database update (v2.4). Ask the admin to apply it, then refresh.', 'info');
    }
    html.push(slotBanner('checks', 'The punches could not be loaded'));
    html.push(officeBanner());
    if (!s.val) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the punches…') : '');
      return html.join('');
    }
    var rows = checkRows();
    var flagged = rows.filter(needsCheck), fine = rows.filter(function (x) { return !needsCheck(x); });
    var head = dayLabel(d, t) + ' · ' + plural(rows.length, 'punch', 'punches') + (flagged.length ? ' · ' + flagged.length + ' to check' : '');
    setStat(head);
    html.push('<div class="hr-summary">' + esc(head) + '</div>');
    if (!rows.length) {
      html.push(emptyBox('No punches in or out on this day.'));
      return html.join('');
    }
    if (flagged.length) html.push('<h4 class="hr-day-h">To check<span class="hr-day-n">' + esc(flagged.length) + '</span></h4><div class="hr-checks">' + flagged.map(checkCard).join('') + '</div>');
    if (fine.length) html.push('<h4 class="hr-day-h">Looks fine<span class="hr-day-n">' + esc(fine.length) + '</span></h4><div class="hr-checks">' + fine.map(checkCard).join('') + '</div>');
    var sd = settingsData();
    html.push('<p class="hr-hint">Every punch in and out, with the photo taken at the punch next to the same person’s previous one, so a different face stands out. ' +
      'Click a photo to see it full size: each look is recorded. Photos are deleted after ' + esc(num(sd && sd.retention_days, 90)) + ' days.</p>');
    return html.join('');
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

  // ── Attendance (the register) ─────────────────────────────────────────────
  function recMarks(r) {
    var out = [];
    if (r.flex) out.push(tag('Flex', 'hr-mark-flex', 'A field day or an approved late start, early leave, flexible or field day: no late or early marks.'));
    if (r.holiday) out.push(tag(String(r.holiday), 'hr-mark-hol', 'Holiday'));
    if (r.missed_out) out.push(tag('No punch-out', 'hr-mark-warn', 'The shift was closed automatically. Ask them to Tell HR when they left, or use Correct….'));
    if (r.irregular) out.push(tag('Irregular', 'hr-mark-warn', 'A punch that did not fit the order of the day was skipped.'));
    if (r.worked_on_duty) out.push(tag('Worked on ' + (r.worked_on_duty === 'leave' ? 'a leave day' : 'an off day'), 'hr-mark-info'));
    if (r.half_day_leave) out.push(tag('Half-day leave', 'hr-mark-info'));
    if (num(r.km_gaps) > 0 && showsRoute(r.email, r)) out.push(tag(plural(num(r.km_gaps), 'gap') + ' in the route', 'hr-mark-info', 'Stretches with no points (a tunnel, the phone off); the straight line still counts.'));
    // v2.4 marks
    if (r.late_excused) {
      out.push(tag(label('MARK_LABELS', 'late_excused') || 'Late excused', 'hr-mark-flex',
        (num(r.late_raw_min) > 0 ? 'Late by ' + fmtDur(r.late_raw_min) + ', but excused' : 'Excused') +
        ': an on-site or RMA trip started away from the shop, or a reason HR approved.'));
    }
    if (r.pending_reason) {
      out.push(tag(label('MARK_LABELS', 'pending_reason') || 'Reason waiting', 'hr-mark-clock',
        'A punch-in reason is waiting for HR. The late mark stays until it is approved.'));
    }
    if (r.away_pending) {
      out.push(tag((label('MARK_LABELS', 'away_pending') || 'Away — waiting for HR') + (num(r.pending_min) > 0 ? ' (' + fmtDur(r.pending_min) + ')' : ''), 'hr-mark-warn',
        'A punch away from the shop is waiting for HR. Its time is not counted until HR approves it.'));
    }
    return out.join('');
  }
  function attendanceHtml() {
    var html = [];
    html.push(demoWriteBanner());
    html.push(slotBanner('reg', 'The register could not be loaded'));
    var s = st.slots.reg;
    if (!s.val) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the register…') : (s.err ? '' : emptyBox('Pick a day.')));
      return html.join('');
    }
    var recs = regRecords();
    return st.v.regView === 'month' ? html.join('') + monthGridHtml(recs) : html.join('') + dayTableHtml(recs);
  }
  function dayTableHtml(recs) {
    var day = st.v.regDay, t = today();
    var rows = recs.filter(function (r) { return r.day === day; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var counts = {};
    rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var head = dayLabel(day, t) + ' · ' + plural(rows.length, 'person', 'people') +
      ['present', 'late', 'half_day', 'absent', 'leave'].filter(function (k) { return counts[k]; }).map(function (k) { return ' · ' + counts[k] + ' ' + label('DAY_LABELS', k).toLowerCase(); }).join('');
    setStat(head);
    if (!rows.length) return '<div class="hr-summary">' + esc(head) + '</div>' + emptyBox('No day records for this day.');
    // v2.4: trip km (what travel allowance pays) beside the day's km.
    var tripCol = recs.some(function (r) { return Object.prototype.hasOwnProperty.call(r, 'trip_km'); });
    var out = '<div class="hr-summary">' + esc(head) + '</div><div class="hr-table-wrap"><table class="hr-table hr-reg"><thead><tr>' +
      '<th scope="col">Person</th><th scope="col">Duty</th><th scope="col">Status</th><th scope="col">In</th><th scope="col">Out</th>' +
      '<th scope="col">Worked</th><th scope="col">Breaks</th><th scope="col">Late</th><th scope="col">Early</th><th scope="col">km</th>' +
      (tripCol ? '<th scope="col">Trip km</th>' : '') + '<th scope="col"><span class="hr-sr">Actions</span></th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var why = whyNotAct(r.email);
      var onField = showsRoute(r.email, r);
      out += '<tr><th scope="row"><div class="hr-who">' + esc(r.name) + (isSelf(r.email) ? ' <span class="hr-you">you</span>' : '') + '</div></th>' +
        '<td>' + esc(r.duty ? label('DUTY_LABELS', r.duty) : '—') + '</td>' +
        '<td>' + dayChip(r.status) + recMarks(r) + '</td>' +
        '<td class="hr-n">' + esc(r.first_in ? hmOn(r.first_in, r.day) : '—') + recClockTags(r, r.email) + '</td>' +
        '<td class="hr-n">' + esc(r.last_out ? hmOn(r.last_out, r.day) : (r.missed_out ? '?' : '—')) + '</td>' +
        '<td class="hr-n">' + esc(r.first_in || num(r.worked_min) > 0 ? fmtDur(r.worked_min) : '—') + '</td>' +
        '<td class="hr-n">' + esc(r.first_in && num(r.break_min) ? fmtDur(r.break_min) : '—') + '</td>' +
        '<td class="hr-n">' + (num(r.late_min) > 0 ? '<span class="hr-late">' + esc(fmtDur(r.late_min)) + '</span>' : '—') + '</td>' +
        '<td class="hr-n">' + (num(r.early_min) > 0 ? '<span class="hr-late">' + esc(fmtDur(r.early_min)) + '</span>' : '—') + '</td>' +
        '<td class="hr-n">' + esc(onField && r.km != null ? fmtKm(r.km) : '—') + '</td>' +
        (tripCol ? '<td class="hr-n">' + esc(onField && r.trip_km != null ? fmtKm(r.trip_km) : '—') + '</td>' : '') +
        '<td class="hr-acts">' +
          '<button type="button" class="text-btn hr-btn" data-hr-act="open-day" data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(r.day) + '">Day</button>' +
          actBtn('text-btn', 'correct', 'Correct…', ' data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(r.day) + '"', why) +
          (onField ? '<button type="button" class="text-btn hr-btn" data-hr-act="open-route" data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(r.day) + '">Route</button>' : '') +
        '</td></tr>';
    });
    out += '</tbody></table></div>';
    return out;
  }
  function monthGridHtml(recs) {
    var r = regRange(), t = today();
    var days = [];
    for (var d = st.v.regMonth; d <= monthEnd(st.v.regMonth); d = addDays(d, 1)) days.push(d);
    var by = {}, names = {};
    recs.forEach(function (x) { (by[x.email] = by[x.email] || {})[x.day] = x; names[x.email] = x.name; });
    var people = Object.keys(by).sort(function (a, b) { return names[a].localeCompare(names[b]); });
    var head = monthLabel(st.v.regMonth) + ' · ' + plural(people.length, 'person', 'people') + (r.to < monthEnd(st.v.regMonth) ? ' · up to today' : '');
    setStat(head);
    if (!people.length) return '<div class="hr-summary">' + esc(head) + '</div>' + emptyBox('No day records in this month.');
    var codes = (F() && F().DAY_CODES) || {};
    // v2.4: days whose away punch is waiting for HR, and trip km.
    var has = function (k) { return recs.some(function (x) { return Object.prototype.hasOwnProperty.call(x, k); }); };
    var waitCol = has('away_pending'), tripCol = has('trip_km');
    var out = '<div class="hr-summary">' + esc(head) + '</div><div class="hr-table-wrap hr-grid-wrap"><table class="hr-table hr-grid"><thead><tr><th scope="col" class="hr-grid-name">Person</th>' +
      days.map(function (d) {
        var w = weekdayOf(d);
        return '<th scope="col" class="hr-gd' + (w === 0 ? ' hr-gd-sun' : '') + (d === t ? ' hr-gd-today' : '') + '"><span>' + esc(WEEKDAYS[w].slice(0, 2)) + '</span><span>' + esc(Number(d.slice(8))) + '</span></th>';
      }).join('') +
      '<th scope="col">P</th><th scope="col">Late</th><th scope="col">Half</th><th scope="col">Absent</th><th scope="col">Leave</th>' +
      (waitCol ? '<th scope="col" title="Days with an away punch waiting for HR (not counted yet)">Waiting</th>' : '') +
      '<th scope="col">Worked</th><th scope="col">km</th>' + (tripCol ? '<th scope="col">Trip km</th>' : '') + '</tr></thead><tbody>';
    people.forEach(function (e) {
      var tot = { present: 0, late: 0, half_day: 0, absent: 0, leave: 0, worked: 0, km: 0, waiting: 0, trip_km: 0 };
      var onField = showsRoute(e, by[e][Object.keys(by[e])[0]]);
      var cells = days.map(function (d) {
        var x = by[e][d];
        if (!x) return '<td class="hr-gc hr-gc-none"></td>';
        var stt = String(x.status || '');
        // An away punch waiting for HR: the day counts once it is approved.
        if (x.away_pending) tot.waiting++;
        else if (stt === 'present' || stt === 'late' || stt === 'half_day' || stt === 'open') tot.present++;
        if (stt === 'late' && !x.away_pending) tot.late++;
        if (stt === 'half_day' && !x.away_pending) tot.half_day++;
        if (x.leave_units != null || x.absent_units != null) {
          // The server's units (S14: a half-day leave is 0.5 leave, plus 0.5 absent when not punched).
          tot.leave += Math.max(0, num(x.leave_units)); tot.absent += Math.max(0, num(x.absent_units));
        } else {
          if (stt === 'absent') tot.absent++;
          if (stt === 'leave') { if (x.half_day_leave) { tot.leave += 0.5; tot.absent += 0.5; } else tot.leave++; }
          if (stt === 'half_day' && x.half_day_leave) tot.leave += 0.5;
        }
        tot.worked += Math.max(0, num(x.worked_min));
        tot.km += Math.max(0, num(x.km));
        tot.trip_km += Math.max(0, num(x.trip_km));
        var tip = [shortDay(d), label('DAY_LABELS', stt),
          num(x.late_min) > 0 ? 'late ' + fmtDur(x.late_min) : '', x.late_excused ? 'late excused' : '',
          x.first_in ? 'in ' + istHm(x.first_in) : '',
          x.last_out ? 'out ' + istHm(x.last_out) : (x.missed_out ? 'no punch-out' : ''),
          x.worked_min != null && num(x.worked_min) ? fmtDur(x.worked_min) : '',
          onField && x.km != null && num(x.km) ? fmtKm(x.km) + ' km' : '', onField && x.trip_km != null && num(x.trip_km) ? fmtKm(x.trip_km) + ' trip km' : '',
          x.flex ? 'flex' : '', x.holiday ? String(x.holiday) : '',
          x.pending_reason ? 'reason waiting for HR' : '', x.away_pending ? 'away — waiting for HR' : ''].filter(Boolean).join(' · ');
        var flags = (x.missed_out ? '!' : '') + (x.flex ? '*' : '') + (x.away_pending || x.pending_reason ? '?' : '');
        return '<td class="hr-gc"><button type="button" class="hr-gcell hr-ds-' + (/^[a-z_]+$/.test(stt) ? stt : 'x') + '" data-hr-act="open-day" data-hr-email="' + esc(e) + '" data-hr-day="' + esc(d) + '" title="' + esc(tip) + '" aria-label="' + esc(names[e] + ': ' + tip) + '">' +
          esc((codes[stt] || '?') + flags) + '</button></td>';
      }).join('');
      out += '<tr><th scope="row" class="hr-grid-name">' + esc(names[e]) + (isSelf(e) ? ' <span class="hr-you">you</span>' : '') + '</th>' + cells +
        '<td class="hr-n">' + esc(tot.present) + '</td><td class="hr-n">' + esc(tot.late) + '</td><td class="hr-n">' + esc(tot.half_day) + '</td>' +
        '<td class="hr-n">' + esc(tot.absent) + '</td><td class="hr-n">' + esc(tot.leave) + '</td>' +
        (waitCol ? '<td class="hr-n">' + (tot.waiting ? '<span class="hr-late">' + esc(tot.waiting) + '</span>' : '0') + '</td>' : '') +
        '<td class="hr-n">' + esc(fmtDur(tot.worked)) + '</td>' +
        '<td class="hr-n">' + esc(onField ? fmtKm(Math.round(tot.km * 100) / 100) : '—') + '</td>' +
        (tripCol ? '<td class="hr-n">' + esc(onField ? fmtKm(Math.round(tot.trip_km * 100) / 100) : '—') + '</td>' : '') + '</tr>';
    });
    out += '</tbody></table></div>';
    out += '<p class="hr-hint hr-legend">' + ['present', 'late', 'half_day', 'absent', 'leave', 'off', 'open', 'not_in_yet', 'not_tracked'].map(function (k) {
      return '<span><span class="hr-gkey hr-ds-' + k + '">' + esc(codes[k] || '') + '</span> ' + esc(label('DAY_LABELS', k)) + '</span>';
    }).join('') + '<span><b>!</b> no punch-out</span><span><b>*</b> flex</span>' + (waitCol ? '<span><b>?</b> waiting for HR</span>' : '') + ' Click a day for its punches.</p>';
    return out;
  }

  // ── Requests ──────────────────────────────────────────────────────────────
  function isPunchKind(kind) { var f = F(); return !!(f && typeof f.isPunchRequestKind === 'function' && f.isPunchRequestKind(kind)); }
  function reqDates(r) {
    var t = today();
    if (r.kind === 'missed_punch' && r.missed_at) {
      return label('EVENT_LABELS', r.missed_kind) + ' at ' + istHm(r.missed_at) + ' on ' + dayLabel(dayOf(r.missed_at), t);
    }
    // A punch reason / away punch: the punch it came with.
    if (isPunchKind(r.kind) && r.punch_at) {
      return label('EVENT_LABELS', r.punch_kind || 'punch_in') + ' at ' + istHm(r.punch_at) + ' · ' + dayLabel(reqDay(r), t);
    }
    var f = String(r.date_from || '').slice(0, 10), to = String(r.date_to || '').slice(0, 10);
    if (!validDay(f)) return '';
    if (!validDay(to) || to === f) return dayLabel(f, t) + (r.half_day ? ' (half day)' : '');
    return dayLabel(f, t) + ' – ' + dayLabel(to, t) + ' (' + plural(spanDays(f, to) + 1, 'day') + ')';
  }
  function reqCard(r) {
    var status = String(r.status || 'pending');
    var kind = label('REQUEST_LABELS', r.kind) + (r.kind === 'leave' && r.leave_type ? ' · ' + label('LEAVE_LABELS', r.leave_type) : '');
    var why = whyNotAct(r.email);
    var meta = [];
    if (r.created_at) meta.push('Asked ' + fmtRel(r.created_at));
    if ((status === 'approved' || status === 'rejected') && (r.decided_by_name || r.decided_by_email)) {
      meta.push(label('REQUEST_STATUS', status) + ' by ' + (r.decided_by_name || r.decided_by_email) + (r.decided_at ? ' · ' + shortDate(r.decided_at) + ' ' + istHm(r.decided_at) : ''));
    }
    if (status === 'cancelled' && (r.cancelled_by_name || r.cancelled_by_email)) {
      meta.push('Cancelled by ' + (r.cancelled_by_name || r.cancelled_by_email) + (r.cancelled_at ? ' · ' + shortDate(r.cancelled_at) : ''));
    }
    var acts = '';
    var punch = isPunchKind(r.kind);
    // The server says what this viewer may do (can_decide / can_cancel); the
    // sentence says why not.
    if (status === 'pending') {
      var dw = why || (r.can_decide === false ? 'You can’t decide this one — the owner’s requests go to a tier 4 head. Refresh if it should be yours.' : null);
      acts = actBtn('primary-pink-btn', 'req-approve', 'Approve…', ' data-hr-id="' + esc(r.id) + '"', dw) +
        actBtn('secondary-btn', 'req-reject', 'Reject…', ' data-hr-id="' + esc(r.id) + '"', dw);
    } else if (status === 'approved') {
      var cw = r.kind === 'missed_punch' ? 'Fix an added punch with Correct… instead.'
        : r.kind === 'away_punch' ? 'HR decides an away punch. To change the day, use Correct… on it.'
        : (why || (r.can_cancel === false ? 'It can no longer be cancelled.' : null));
      acts = actBtn('text-btn', 'req-cancel', 'Cancel it…', ' data-hr-id="' + esc(r.id) + '"', cw);
    }
    if (punch && r.email && validDay(reqDay(r))) {
      acts = '<button type="button" class="text-btn hr-btn" data-hr-act="open-day" data-hr-email="' + esc(r.email) + '" data-hr-day="' + esc(reqDay(r)) + '">Day</button>' + acts;
    }
    var notes = [r.decision_note ? 'Note: ' + r.decision_note : '', r.cancel_note ? 'Cancelled: ' + r.cancel_note : ''].filter(Boolean);
    var f = F();
    var due = punch && f ? f.dueText(r, today(), nowMs()) : null;
    // A punch kind: where the punch was, its checks, the reason and the photo.
    var punchHtml = '';
    var reasonLine = r.reason ? String(r.reason) : '';
    if (punch && f) {
      var tags = checkTags(r);
      var rk = r.reason_kind ? label('REASON_LABELS', r.reason_kind) : '';
      reasonLine = (rk && rk !== reasonLine ? rk + (reasonLine ? ' — ' : '') : '') + reasonLine;
      var sf = objOrNull(r.selfie);
      var photo = '';
      if (sf && sf.thumb_b64) photo = thumbHtml(sf.thumb_b64, r.event_id, r.name + ' — ' + reqDates(r), label('REQUEST_LABELS', r.kind), false);
      else if ((r.selfie === true || sf) && r.event_id) {
        photo = '<button type="button" class="secondary-btn hr-btn" data-hr-act="photo" data-hr-event="' + esc(r.event_id) + '" data-hr-title="' + esc(r.name + ' — ' + reqDates(r)) +
          '" data-hr-sub="' + esc(label('REQUEST_LABELS', r.kind)) + '" title="Open the photo taken at the punch (each look is recorded)">📷 Photo</button>';
      } else if (Object.prototype.hasOwnProperty.call(r, 'selfie')) {
        photo = '<span class="hr-thumb hr-thumb-none">No photo</span>';
      }
      punchHtml = '<div class="hr-req-punch">' + (photo ? '<div class="hr-req-photo">' + photo + '</div>' : '') +
        '<div class="hr-req-checks">' + (tags || '<span class="hr-muted">No location details.</span>') + '</div></div>';
    }
    return '<div class="hr-req hr-req-' + (/^[a-z]+$/.test(status) ? status : 'x') + (due && due.late ? ' hr-req-eod' : '') + '">' +
      '<div class="hr-req-head"><div><div class="hr-who">' + esc(r.name) + (isSelf(r.email) ? ' <span class="hr-you">you</span>' : '') + '</div>' +
        '<div class="hr-req-kind">' + esc(kind) + '</div></div>' +
        '<div class="hr-req-chips">' + (due ? '<span class="hr-due' + (due.late ? ' late' : '') + '">' + esc(due.text) + '</span>' : '') +
        chip('hr-rs-' + (/^[a-z]+$/.test(status) ? status : 'x'), label('REQUEST_STATUS', status)) + '</div></div>' +
      '<div class="hr-req-when">' + esc(reqDates(r)) + (r.ref_code ? ' <span class="hr-tag">' + esc(r.ref_code) + '</span>' : '') + '</div>' +
      punchHtml +
      (reasonLine ? '<div class="hr-req-reason">' + esc(reasonLine) + '</div>' : '') +
      (notes.length ? '<div class="hr-req-note">' + esc(notes.join(' · ')) + '</div>' : '') +
      '<div class="hr-req-foot"><span class="hr-muted">' + esc(meta.join(' · ')) + '</span><span class="hr-req-acts">' + acts + '</span></div>' +
    '</div>';
  }
  // Waiting first: past the end of the day, then the oldest.
  function byUrgency(a, b) {
    var f = F(), t = today(), now = nowMs();
    var la = f ? !!(f.dueText(a, t, now) || {}).late : false, lb = f ? !!(f.dueText(b, t, now) || {}).late : false;
    if (la !== lb) return la ? -1 : 1;
    return tsMs(a.created_at) - tsMs(b.created_at);
  }
  function requestsHtml() {
    var html = [];
    html.push(demoWriteBanner());
    html.push(slotBanner('reqPending', 'Waiting requests could not be loaded'));
    if (st.reqV3 && st.v.reqScope === 'today') st.v.reqScope = 'pending';   // a v2.3 server: no punch reasons
    var p = st.slots.reqPending;
    var pending = pendingList().sort(byUrgency);
    var late = pastEodCount();
    if (st.v.reqScope === 'today') {
      html.push(reqTodayHtml());
      setStat(p.val ? plural(pending.length, 'request') + ' waiting' : '—');
      return html.join('');
    }
    html.push('<h4 class="hr-day-h">Waiting for a decision<span class="hr-day-n">' + esc(p.val ? pending.length : '…') + '</span>' +
      (late ? '<span class="hr-day-n hr-day-late">' + esc(late + ' past end of day') + '</span>' : '') + '</h4>');
    if (!p.val) html.push(p.loading ? loadingBox('Loading the requests…') : '');
    else if (!pending.length) html.push(emptyBox('Nothing is waiting. Requests people send with Tell HR on NeoHR, and punch-in reasons and away punches, show up here.'));
    else html.push('<div class="hr-reqs">' + pending.map(reqCard).join('') + '</div>');
    if (st.v.reqScope === 'all') {
      html.push(slotBanner('reqAll', 'The other requests could not be loaded'));
      var a = st.slots.reqAll;
      var rest = reqRows('reqAll').filter(function (r) { return r.status && r.status !== 'pending'; })
        .sort(function (x, y) { return tsMs(y.decided_at || y.cancelled_at || y.created_at) - tsMs(x.decided_at || x.cancelled_at || x.created_at); });
      html.push('<h4 class="hr-day-h">Decided and cancelled<span class="hr-day-n">' + esc(a.val ? rest.length : '…') + '</span></h4>');
      if (!a.val) html.push(a.loading ? loadingBox('Loading…') : '');
      else if (!rest.length) html.push(emptyBox('None in this range.'));
      else html.push('<div class="hr-reqs">' + rest.map(reqCard).join('') + '</div>');
    }
    html.push('<p class="hr-hint">Approving leave or a field day marks those days on the roster (weekly offs and holidays are skipped). Approving a missed punch adds it to the day. ' +
      (st.reqV3 ? 'Nobody approves their own request.'
        : 'A punch-in reason (late, or a reason they typed) and an away punch should be decided before the end of their day: an away punch counts only once it is approved. ' +
          'Nobody approves their own request, and the owner’s go to a tier 4 head.') +
      ' This list refreshes every minute.</p>');
    setStat(p.val ? plural(pending.length, 'request') + ' waiting' : '—');
    return html.join('');
  }
  // Requests → Punch reasons today: every punch reason and away punch of today.
  function reqTodayHtml() {
    var html = [];
    if (st.reqV3) return emptyBox('Punch-in reasons need the HR database update (v2.4).');
    html.push(slotBanner('reqToday', 'Today’s punch reasons could not be loaded'));
    var s = st.slots.reqToday, t = today();
    var rows = reqRows('reqToday').filter(function (r) { return isPunchKind(r.kind) && reqDay(r) === t; });
    var wait = rows.filter(function (r) { return !r.status || r.status === 'pending'; }).sort(byUrgency);
    var done = rows.filter(function (r) { return r.status && r.status !== 'pending'; })
      .sort(function (x, y) { return tsMs(y.decided_at || y.cancelled_at || y.created_at) - tsMs(x.decided_at || x.cancelled_at || x.created_at); });
    html.push('<h4 class="hr-day-h">Waiting today<span class="hr-day-n">' + esc(s.val ? wait.length : '…') + '</span></h4>');
    if (!s.val) html.push(s.loading ? loadingBox('Loading today’s punch reasons…') : '');
    else if (!wait.length) html.push(emptyBox('No punch-in reason or away punch is waiting today.'));
    else html.push('<div class="hr-reqs">' + wait.map(reqCard).join('') + '</div>');
    if (s.val && done.length) {
      html.push('<h4 class="hr-day-h">Decided today<span class="hr-day-n">' + esc(done.length) + '</span></h4><div class="hr-reqs">' + done.map(reqCard).join('') + '</div>');
    }
    html.push('<p class="hr-hint">Late, or a reason they typed, at punch-in goes to HR. On-site and RMA from away from the shop do not need approval. A punch away from the shop by shop staff counts only once HR approves it.</p>');
    return html.join('');
  }
  function findRequest(id) {
    var all = reqRows('reqPending').concat(reqRows('reqAll'), reqRows('reqToday'));
    for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
    return null;
  }

  // ── Roster ────────────────────────────────────────────────────────────────
  function rosterPeople() {
    var rd = rosterData();
    if (rd.people.length) return rd.people.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var map = {};
    boardRows().forEach(function (r) { map[r.email] = r.name; });
    if (!Object.keys(map).length) staffRows().forEach(function (s) { map[lower(s.email)] = String(s.full_name || s.name || s.email); });
    Object.keys(rd.cells).forEach(function (k) { var e = k.split('|')[0]; if (!map[e]) map[e] = nameOf(e); });
    return Object.keys(map).map(function (e) { return { email: e, name: map[e] }; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  // The duty of one roster cell: { duty, set (someone set it), why (where a
  // default comes from), cell }.
  function rosterDuty(rd, email, day) {
    var c = rd.cells[email + '|' + day];
    if (c && c.source === 'roster' && c.duty) return { duty: c.duty, set: true, why: null, cell: c };
    if (c && c.duty && c.source) {
      return { duty: c.duty, set: false, cell: c,
               why: c.source === 'holiday' ? 'holiday' : c.source === 'weekly_off' ? 'weekly off' : 'a working day' };
    }
    if (rd.holidays[day]) return { duty: 'off', set: false, why: 'holiday', cell: c || null };
    if (weeklyOffOf(email, day).indexOf(weekdayOf(day)) !== -1) return { duty: 'off', set: false, why: 'weekly off', cell: c || null };
    return { duty: 'shop', set: false, why: 'a working day', cell: c || null };
  }
  function rosterHtml() {
    var html = [];
    html.push(demoWriteBanner());
    html.push(slotBanner('roster', 'The roster could not be loaded'));
    var s = st.slots.roster;
    if (!s.val) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the roster…') : '');
      return html.join('');
    }
    var rd = rosterData();
    var w = st.v.rosterWeek, t = today();
    var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(w, i); });
    var people = rosterPeople();
    var out = '<div class="hr-table-wrap"><table class="hr-table hr-roster"><thead><tr><th scope="col">Person</th>' +
      days.map(function (d) {
        return '<th scope="col" class="' + (d === t ? 'hr-gd-today' : '') + '"><div>' + esc(shortDay(d)) + '</div>' +
          (rd.holidays[d] ? '<div class="hr-hol">🎉 ' + esc(rd.holidays[d]) + '</div>' : '') + '</th>';
      }).join('') + '</tr></thead><tbody>';
    if (!people.length) out += '<tr><td colspan="8">' + emptyBox('No staff to show yet.') + '</td></tr>';
    people.forEach(function (p) {
      var why = whyNotAct(p.email);
      out += '<tr><th scope="row"><div class="hr-who">' + esc(p.name) + (p.self || isSelf(p.email) ? ' <span class="hr-you">you</span>' : '') + '</div></th>' +
        days.map(function (d) {
          var x = rosterDuty(rd, p.email, d);
          var c = x.cell;
          var fromReq = !!(x.set && c && c.source_request_id);
          var title = x.set ? (fromReq ? 'From an approved request. ' : '') + (c && c.note ? String(c.note) : '')
            : (x.why === 'holiday' ? 'Holiday: ' + (rd.holidays[d] || '') : x.why === 'weekly off' ? 'Weekly off' : 'A working day (default)');
          var duty = /^[a-z]+$/.test(String(x.duty)) ? x.duty : 'shop';
          var text = label('DUTY_LABELS', duty) + (fromReq ? ' ↗' : '');
          return '<td><button type="button" class="hr-duty hr-duty-' + duty + (x.set ? '' : ' implied') + '" data-hr-act="roster-cell" data-hr-email="' + esc(p.email) + '" data-hr-day="' + esc(d) + '"' +
            (why ? ' disabled title="' + esc(why) + '"' : ' title="' + esc(title || 'Set the duty') + '"') + '>' + esc(text) + '</button></td>';
        }).join('') + '</tr>';
    });
    out += '</tbody></table></div>';
    html.push(out);
    html.push('<p class="hr-hint">Faded days are the defaults: shop on working days, off on weekly offs and holidays. Click a day to set field, off, leave or work from home. ↗ marks a day set by an approved request; changing it overrides the request for that day.</p>');
    setStat(shortDay(w) + ' – ' + shortDay(addDays(w, 6)) + ' · ' + plural(people.length, 'person', 'people'));
    return html.join('');
  }

  // ── Routes (Leaflet + OpenStreetMap) ──────────────────────────────────────
  function routeData() {
    var v = objOf(st.slots.route.val);
    if (!v) return null;
    var pts = (Array.isArray(v.points) ? v.points : []).map(function (p) {
      return p ? { at: p.at, lat: Number(p.lat), lng: Number(p.lng) } : null;
    }).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180; });
    var stops = (Array.isArray(v.stops) ? v.stops : []).filter(function (x) { return x && isFinite(Number(x.lat)) && isFinite(Number(x.lng)); });
    var segs = (Array.isArray(v.segments) ? v.segments : []).filter(Boolean);
    // v2.4: the on-site / RMA trips of the day (field staff).
    var trips = (Array.isArray(v.trips) ? v.trips : []).filter(function (x) { return x && x.id && isFinite(tsMs(x.started_at)); });
    return { points: pts, stops: stops, segments: segs, km: v.km, km_gaps: num(v.km_gaps), moving_min: v.moving_min,
             visits: Array.isArray(v.visits) ? v.visits : [], trips: trips, hasTrips: Array.isArray(v.trips) };
  }
  // The trip picked on the side panel (or from the day panel), if it is in this route.
  function pickedTrip(r) {
    var id = st.v.routeTrip;
    if (!id || !r) return null;
    return r.trips.filter(function (x) { return String(x.id) === String(id); })[0] || null;
  }
  // A trip's window: [start, effective end] (an open trip runs to now).
  function tripWindow(x) {
    var a = tsMs(x.started_at), b = tsMs(x.ended_at);
    return [a, isFinite(b) && x.open !== true ? b : nowMs()];
  }
  function renderRoutes(body) {
    if (body.dataset.view !== 'routes' || !el('hr-map')) {
      destroyMap();
      body.dataset.view = 'routes';
      body.innerHTML = '<div id="hr-route-banners"></div><div class="hr-route">' +
        '<div class="hr-map-wrap"><div id="hr-map" class="hr-map" role="region" aria-label="Route map"></div><div id="hr-map-msg" class="hr-map-msg hidden"></div></div>' +
        '<div id="hr-route-side" class="hr-route-side"></div></div>';
    }
    var s = st.slots.route;
    var e = st.v.routePerson, d = st.v.routeDay;
    var banners = [slotBanner('route', 'The route could not be loaded')];
    if (e && !isSelf(e)) banners.push(banner('Looking at someone else’s route is recorded — ' + nameOf(e) + ' can see that you looked, and when.', 'info'));
    el('hr-route-banners').innerHTML = banners.join('');
    var side = el('hr-route-side');
    var msg = el('hr-map-msg');
    var r = routeData();
    var map = ensureMap(el('hr-map'));
    if (!e) {
      side.innerHTML = emptyBox('Choose a person and a day. The route is recorded only between punch-in and punch-out, never during a break.');
      setMsg(msg, 'Choose a person to see their route.');
      clearMapLayer();
      setStat('—');
      return;
    }
    if (!r) {
      side.innerHTML = s.loading ? loadingBox('Loading the route…') : '';
      setMsg(msg, s.loading ? 'Loading…' : '');
      clearMapLayer();
      setStat(s.loading ? '…' : '—');
      return;
    }
    var key = s.key + '|' + s.at + '|' + (st.v.routeTrip || '');
    if (map && st.mapKey !== key) { drawRoute(map, r); st.mapKey = key; }
    setMsg(msg, r.points.length ? '' : (window.L ? 'No route was recorded on this day.' : ''));
    side.innerHTML = routeSideHtml(r, e, d);
    var tp = pickedTrip(r);
    setStat(nameOf(e) + ' · ' + dayLabel(d, today()) + ' · ' + fmtKm(r.km != null ? r.km : 0) + ' km' +
      (tp && F() ? ' · ' + F().tripText(tp) + (tp.km != null ? ' ' + fmtKm(tp.km) + ' km' : '') : ''));
  }
  function setMsg(msgEl, text) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('hidden', !text);
  }
  function routeSideHtml(r, email, day) {
    var t = today();
    var items = [];
    r.stops.forEach(function (x, i) { items.push({ at: tsMs(x.arrived), type: 'stop', x: x, n: i + 1 }); });
    r.segments.forEach(function (x) { items.push({ at: tsMs(x.from), type: 'seg', x: x }); });
    items.sort(function (a, b) { return (isFinite(a.at) ? a.at : 0) - (isFinite(b.at) ? b.at : 0); });
    var f = F();
    var tripKm = Math.round(r.trips.reduce(function (a, x) { return a + Math.max(0, num(x.km)); }, 0) * 100) / 100;
    var html = '<div class="hr-rtiles">' +
      tile(fmtKm(r.km != null ? r.km : 0), 'km travelled', 'ok', r.hasTrips ? 'The whole day’s route, the server’s figure' : 'The server’s figure, the one travel allowance uses') +
      (r.hasTrips ? tile(fmtKm(tripKm), 'trip km', 'busy', 'On-site and RMA trips only: what travel allowance pays') : '') +
      tile(r.moving_min != null ? fmtDur(r.moving_min) : '—', 'moving') +
      tile(r.stops.length, plural(r.stops.length, 'stop').replace(/^\d+ /, '')) +
      (r.km_gaps ? tile(r.km_gaps, r.km_gaps === 1 ? 'gap' : 'gaps', 'late','Stretches with no points (a tunnel, the phone off); the straight line between them still counts') : '') +
    '</div>';
    // v2.4: the trips; a click shows that part of the route on the map.
    if (r.trips.length) {
      var picked = pickedTrip(r);
      html += '<h4 class="hr-app-h">Trips</h4><ul class="hr-trips">' + r.trips.map(function (x) {
        var on = picked && String(picked.id) === String(x.id);
        var bits = [f ? f.tripSpan(x) : '', x.km != null ? fmtKm(x.km) + ' km' : '', x.moving_min != null ? fmtDur(x.moving_min) + ' moving' : '',
                    x.stops != null ? plural(num(x.stops), 'stop') : '', !x.open && x.end_reason ? label('TRIP_END_LABELS', x.end_reason) : ''].filter(Boolean).join(' · ');
        var flags = f ? f.flagList(x) : [];
        return '<li><button type="button" class="hr-trip' + (on ? ' on' : '') + '" data-hr-act="route-trip" data-hr-trip="' + esc(x.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
          ' title="' + esc(on ? 'Show the whole day again' : 'Show this trip on the map') + '">' +
          '<span class="hr-tl-t">' + esc(f ? f.tripText(x) : 'Trip') + (x.ref_title ? ' — ' + esc(x.ref_title) : '') + '</span>' +
          '<span class="hr-muted">' + esc(bits) + '</span>' +
          (flags.length ? '<span>' + flags.map(function (g) { return tag(g.text, 'hr-mark-warn', g.tip); }).join('') + '</span>' : '') +
        '</button></li>';
      }).join('') + '</ul>';
    } else if (r.hasTrips) {
      html += '<p class="hr-hint">No on-site or RMA trip was started on this day.</p>';
    }
    html += '<h4 class="hr-app-h">' + esc(dayLabel(day, t)) + '</h4>';
    if (!items.length) {
      html += emptyBox(r.points.length ? 'No stops or moving stretches long enough to list.' : 'No route was recorded on this day — they may not have punched in, worked from home, or they are not field staff.');
    } else {
      html += '<ol class="hr-tl">' + items.map(function (it) {
        var x = it.x;
        if (it.type === 'stop') {
          var place = x.place_hint ? String(x.place_hint) : 'Stop ' + it.n;
          return '<li class="hr-tl-stop"><span class="hr-tl-dot" aria-hidden="true">' + esc(it.n) + '</span><div><div class="hr-tl-t">' + esc(place) + '</div>' +
            '<div class="hr-muted">' + esc(istHm(x.arrived) + ' – ' + istHm(x.left) + (x.minutes != null ? ' · ' + fmtDur(x.minutes) : '')) + '</div></div></li>';
        }
        var gap = x.mode === 'gap';
        return '<li class="hr-tl-seg' + (gap ? ' gap' : '') + '"><span class="hr-tl-line" aria-hidden="true"></span><div class="hr-tl-t2">' +
          esc((gap ? 'No points for ' : 'Moving · ') + fmtKm(x.km) + ' km' + (x.minutes != null ? ' · ' + fmtDur(x.minutes) : '') +
          (isFinite(tsMs(x.from)) ? ' · ' + istHm(x.from) + '–' + istHm(x.to) : '')) + '</div></li>';
      }).join('') + '</ol>';
    }
    if (r.visits.length) {
      html += '<h4 class="hr-app-h">Site visits</h4><ul class="hr-visits">' + r.visits.map(function (v) {
        var when = (v.assumed_arrival ? 'arrival not recorded' : istHm(v.arrived)) + ' – ' + (v.open ? 'still there' : istHm(v.departed));
        var bits = [v.minutes != null ? fmtDur(v.minutes) + ' on site' : '', v.travel_min != null ? fmtDur(v.travel_min) + ' travel' : '',
                    v.outcome ? String(v.outcome).replace(/_/g, ' ') : ''].filter(Boolean).join(' · ');
        return '<li><b>' + esc(v.code || '') + '</b> ' + esc(v.title || '') + '<div class="hr-muted">' + esc(when + (bits ? ' · ' + bits : '')) + '</div></li>';
      }).join('') + '</ul>';
    }
    html += '<p class="hr-hint">The points stay on this screen: they are not exported or copied, and they are cleared when you leave NeoHR. Map © OpenStreetMap contributors.</p>';
    return html;
  }
  function destroyMap() {
    if (st.map) {
      try { st.map.remove(); } catch (e) { /* the container is already gone */ }
    }
    st.map = null; st.mapLayer = null; st.mapKey = null;
  }
  function clearMapLayer() { if (st.mapLayer) { try { st.mapLayer.clearLayers(); } catch (e) { /* nothing drawn */ } } st.mapKey = null; }
  function defaultCenter() {
    var s = settingsData();
    var lat = s ? numOrNull(s.office_lat) : null, lng = s ? numOrNull(s.office_lng) : null;
    if (lat != null && lng != null) return { c: [lat, lng], z: 14 };
    return { c: [20.6, 78.9], z: 4 };   // the whole country until an office point is set
  }
  function ensureMap(host) {
    var L = window.L;
    if (!host) return null;
    if (!L || typeof L.map !== 'function') {
      host.textContent = '';
      host.appendChild(document.createTextNode('The map could not load. Restart Neo OS after the update finishes.'));
      host.classList.add('hr-map-off');
      return null;
    }
    if (st.map && st.map.getContainer() === host) return st.map;
    destroyMap();
    var map = L.map(host, { zoomControl: true, attributionControl: true, minZoom: 3, maxZoom: 19, worldCopyJump: false });
    map.attributionControl.setPrefix(LEAFLET_PREFIX);
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    var c = defaultCenter();
    map.setView(c.c, c.z);
    st.map = map;
    st.mapLayer = L.layerGroup().addTo(map);
    // The attribution links open in the system browser, never in the app window.
    if (!host.__hrLinks) host.__hrLinks = true; else return finishMap(map);
    host.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^https:\/\/(www\.openstreetmap\.org|leafletjs\.com)(\/|$)/.test(href)) openUrl(href, 'that page');
    });
    return finishMap(map);
  }
  function finishMap(map) {
    setTimeout(function () { if (st.map === map) { try { map.invalidateSize(); } catch (e) { /* gone */ } } }, 0);
    return map;
  }
  // A tooltip's content as a node. Leaflet puts a STRING tooltip in with
  // innerHTML, and a stop's place_hint is free text (service_jobs.site_area),
  // so no tooltip is ever handed a string: the text goes in as textContent.
  function tipNode(text) {
    var s = document.createElement('span');
    s.textContent = String(text == null ? '' : text);
    return s;
  }
  // The path (dashed across a gap), a circle per stop, and the start and end.
  function drawRoute(map, r) {
    var L = window.L;
    clearMapLayer();
    var layer = st.mapLayer;
    if (!L || !layer) return;
    var gaps = r.segments.filter(function (x) { return x.mode === 'gap'; }).map(function (x) { return [tsMs(x.from), tsMs(x.to)]; });
    var inGap = function (a, b) {
      var ta = tsMs(a.at), tb = tsMs(b.at);
      return gaps.some(function (g) { return isFinite(g[0]) && isFinite(g[1]) && ta >= g[0] - 1000 && tb <= g[1] + 1000; });
    };
    var bounds = [];
    var line = [], lineGap = null;
    var flush = function () {
      if (line.length > 1) {
        L.polyline(line, lineGap ? { color: '#f59e0b', weight: 3, opacity: 0.9, dashArray: '6 8', className: 'hr-path-gap' }
                                 : { color: '#e11d74', weight: 4, opacity: 0.85, className: 'hr-path' }).addTo(layer);
      }
    };
    for (var i = 0; i < r.points.length; i++) {
      var p = r.points[i], ll = [p.lat, p.lng];
      bounds.push(ll);
      if (i === 0) { line = [ll]; continue; }
      var g = inGap(r.points[i - 1], p);
      if (lineGap === null) lineGap = g;
      if (g !== lineGap) { flush(); line = [line[line.length - 1], ll]; lineGap = g; }
      else line.push(ll);
    }
    flush();
    r.stops.forEach(function (x, n) {
      var ll = [Number(x.lat), Number(x.lng)];
      bounds.push(ll);
      L.circleMarker(ll, { radius: 9, color: '#7c3aed', weight: 2, fillColor: '#a78bfa', fillOpacity: 0.85, className: 'hr-stop' })
        .bindTooltip(tipNode(String(n + 1) + ' · ' + (x.place_hint ? String(x.place_hint) : 'Stop') + ' · ' + istHm(x.arrived) + '–' + istHm(x.left) +
          (x.minutes != null ? ' · ' + fmtDur(x.minutes) : '')), { direction: 'top' })
        .addTo(layer);
    });
    if (r.points.length) {
      var a = r.points[0], b = r.points[r.points.length - 1];
      L.circleMarker([a.lat, a.lng], { radius: 6, color: '#047857', weight: 2, fillColor: '#10b981', fillOpacity: 1, className: 'hr-start' })
        .bindTooltip(tipNode('Start · ' + istHm(a.at)), { direction: 'top' }).addTo(layer);
      L.circleMarker([b.lat, b.lng], { radius: 6, color: '#1f2937', weight: 2, fillColor: '#6b7280', fillOpacity: 1, className: 'hr-end' })
        .bindTooltip(tipNode('Last point · ' + istHm(b.at)), { direction: 'top' }).addTo(layer);
    }
    // v2.4: the picked trip's part of the route, on top, and the map on it.
    var tp = pickedTrip(r);
    if (tp) {
      var w = tripWindow(tp);
      var seg = r.points.filter(function (p) { var ta = tsMs(p.at); return isFinite(ta) && ta >= w[0] - 1000 && ta <= w[1] + 1000; })
        .map(function (p) { return [p.lat, p.lng]; });
      if (seg.length > 1) L.polyline(seg, { color: '#2563eb', weight: 6, opacity: 0.9, className: 'hr-path-trip' }).addTo(layer);
      var tname = F() ? F().tripText(tp) : 'Trip';
      if (seg.length) {
        L.circleMarker(seg[0], { radius: 7, color: '#1e3a8a', weight: 2, fillColor: '#3b82f6', fillOpacity: 1, className: 'hr-trip-start' })
          .bindTooltip(tipNode(tname + ' · started ' + istHm(tp.started_at)), { direction: 'top' }).addTo(layer);
        if (seg.length > 1 && !tp.open) {
          L.circleMarker(seg[seg.length - 1], { radius: 7, color: '#1e3a8a', weight: 2, fillColor: '#93c5fd', fillOpacity: 1, className: 'hr-trip-end' })
            .bindTooltip(tipNode(tname + ' · ended ' + istHm(tp.ended_at)), { direction: 'top' }).addTo(layer);
        }
        bounds = seg;
      }
    }
    try {
      map.invalidateSize(false);
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17, animate: false });
      else if (bounds.length === 1) map.setView(bounds[0], 16, { animate: false });
      else { var c = defaultCenter(); map.setView(c.c, c.z, { animate: false }); }
    } catch (e) { /* a hidden container: invalidateSize on show fixes it */ }
  }

  // ── Travel allowance ──────────────────────────────────────────────────────
  // The server's order (hr_ta_approve) and sentences; can_approve has the last word.
  function taWhyNot(r, data) {
    if (!canApprove()) return NOT_APPROVER;
    if (r.self) return selfSentence();
    if (isDemo()) return DEMO_OFF;
    if (data.closed === false || (data.closed == null && data.month >= monthStart(today()))) return 'Approve a month after it ends.';
    if (data.rate == null) return 'Set the travel allowance rate first.';
    if (!r.eligible) return r.name + " isn't eligible for travel allowance.";
    if (r.km == null || r.can_approve === false) return 'Refresh the report and try again.';
    return null;
  }
  function taHtml() {
    var html = [];
    html.push(demoWriteBanner());
    html.push(slotBanner('ta', 'The travel allowance report could not be loaded'));
    var s = st.slots.ta;
    var data = taData();
    if (!data) {
      setStat(s.loading ? '…' : '—');
      html.push(s.loading ? loadingBox('Loading the report…') : '');
      return html.join('');
    }
    var m = data.month;
    var ended = m < monthStart(today());
    html.push('<div class="hr-summary">' + esc(monthLabel(m) + ' · ' + (data.rate != null ? 'Rate ' + money(data.rate) + ' per km' : 'No rate set')) + '</div>');
    if (data.rate == null) html.push(banner('No travel allowance rate is set. ' + (tierNow() >= 4 ? 'Set it in the Settings tab.' : 'Someone at tier 4 or above sets it in Settings.'), 'warn'));
    if (!ended) html.push(banner('This month has not ended: the km can still grow. Approve it after it ends.', 'info'));
    if (!data.rows.length) { html.push(emptyBox(data.trips ? 'No field staff trips this month.' : 'Nobody travelled this month.')); setStat(monthLabel(m)); return html.join(''); }
    var tot = { km: 0, amount: 0, day_km: 0 };
    // v2.4: TA pays trip km (km); the whole day's route (day_km) is shown beside it.
    var trips = data.trips;
    var cols = trips ? 7 : 6;
    var out = '<div class="hr-table-wrap"><table class="hr-table hr-ta"><thead><tr><th scope="col">Person</th><th scope="col">' + (trips ? 'Trip km' : 'km') + '</th>' +
      (trips ? '<th scope="col" title="The whole day’s route, for comparison: not paid">All travel km</th>' : '') + '<th scope="col">Rate</th>' +
      '<th scope="col">Amount</th><th scope="col">Approval</th><th scope="col"><span class="hr-sr">Actions</span></th></tr></thead><tbody>';
    data.rows.forEach(function (r) {
      tot.km += Math.max(0, num(r.km)); tot.amount += Math.max(0, num(r.amount)); tot.day_km += Math.max(0, num(r.day_km));
      var open = !!st.v.taOpen[r.email];
      var appr;
      if (r.approved) {
        appr = chip('hr-rs-approved', 'Approved') + ' <span class="hr-muted">' + esc((r.approved.by ? 'by ' + r.approved.by : '') + (r.approved.at ? ' · ' + shortDate(r.approved.at) : '')) + '</span>' +
          (r.changed ? '<div class="hr-stale">⚠ ' + esc('The km changed since: now ' + fmtKm(r.live_km) + ' km') + '</div>' : '');
      } else {
        appr = r.eligible ? '<span class="hr-muted">Not approved</span>' : '<span class="hr-muted">Not eligible</span>';
      }
      var acts = '';
      if (!r.approved) acts = actBtn('primary-pink-btn', 'ta-approve', 'Approve…', ' data-hr-email="' + esc(r.email) + '"', taWhyNot(r, data));
      else if (tierNow() >= 4) acts = actBtn('text-btn', 'ta-unapprove', 'Take back…', ' data-hr-email="' + esc(r.email) + '"',
        r.self ? selfSentence() : (isDemo() ? DEMO_OFF : null));
      out += '<tr><th scope="row"><button type="button" class="hr-expand" data-hr-act="ta-expand" data-hr-email="' + esc(r.email) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span aria-hidden="true">' + (open ? '▾' : '▸') + '</span> ' + esc(r.name) + '</button>' + (isSelf(r.email) ? ' <span class="hr-you">you</span>' : '') + '</th>' +
        '<td class="hr-n">' + esc(r.km != null ? fmtKm(r.km) : '—') + '</td>' +
        (trips ? '<td class="hr-n hr-muted">' + esc(r.day_km != null ? fmtKm(r.day_km) : '—') + '</td>' : '') +
        '<td class="hr-n">' + esc(!r.eligible && !r.approved ? '—' : r.rate != null ? money(r.rate) : (data.rate != null ? money(data.rate) : '—')) + '</td>' +
        '<td class="hr-n">' + esc(!r.eligible && !r.approved ? '—' : r.amount != null ? money(r.amount) : '—') + '</td>' +
        '<td>' + appr + '</td><td class="hr-acts">' + acts + '</td></tr>';
      if (open) {
        var days = r.days.filter(function (x) { return x && x.day; }).sort(function (a, b) { return String(a.day).localeCompare(String(b.day)); });
        out += '<tr class="hr-drow"><td colspan="' + cols + '">' + (days.length
          ? '<div class="hr-kmdays">' + days.map(function (x) {
              return '<span><b>' + esc(shortDay(String(x.day).slice(0, 10))) + '</b> ' + esc(fmtKm(x.km)) + (trips ? ' trip km' : ' km') +
                (trips && x.day_km != null ? ' <span class="hr-muted">(' + esc(fmtKm(x.day_km)) + ' all)</span>' : '') + '</span>';
            }).join('') + '</div>'
          : '<span class="hr-muted">No km by day in this answer.</span>') + '</td></tr>';
      }
    });
    out += '<tr class="hr-total"><th scope="row">Everyone</th><td class="hr-n">' + esc(fmtKm(Math.round(tot.km * 100) / 100)) + '</td>' +
      (trips ? '<td class="hr-n hr-muted">' + esc(fmtKm(Math.round(tot.day_km * 100) / 100)) + '</td>' : '') + '<td></td><td class="hr-n">' +
      esc(money(Math.round(tot.amount * 100) / 100)) + '</td><td colspan="2"></td></tr>';
    out += '</tbody></table></div>';
    html.push(out);
    html.push(trips
      ? '<p class="hr-hint">Travel allowance is paid on trip km only: the on-site and RMA trips field staff start on NeoHR, from the server’s route. All travel km is the whole day’s route, shown for comparison. Approving keeps the trip km, rate and amount as they are now.</p>'
      : '<p class="hr-hint">km is the server’s figure from each day’s route (the phone’s live figure is only for show). Approving keeps the km, rate and amount as they are now.</p>');
    setStat(monthLabel(m) + ' · ' + fmtKm(Math.round(tot.km * 100) / 100) + ' km');
    return html.join('');
  }

  // ── Settings (tier 4+) ────────────────────────────────────────────────────
  function settingsHtml() {
    var html = [];
    if (tierNow() < 4) return banner('Settings are for tier 4 and above.', 'info');
    html.push(demoWriteBanner());
    html.push(slotBanner('settings', 'The HR settings could not be loaded'));
    var s = settingsData();
    var f = F();
    if (!s) {
      setStat(st.slots.settings.loading ? '…' : '—');
      html.push(st.slots.settings.loading ? loadingBox('Loading the settings…') : '');
      return html.join('');
    }
    // Today's default (not the newest row, which may start later) and then
    // each planned change with its date.
    var cur = defaultShift(today()) || {};
    var planned = defaultPlanned();
    var rows = [
      ['Office hours', hoursText(cur) + ' (India time)'],
      ['Grace', num(cur.grace_min) + ' min before a punch-in counts as late'],
      ['Weekly off', f.weeklyOffText(cur.weekly_off)],
      ['Half day', 'under ' + fmtDur(cur.half_day_min) + ' worked']
    ].concat(planned.map(function (h, i) {
      return ['From ' + dayLabel(String(h.effective_from).slice(0, 10), today()), plannedText(h, i ? planned[i - 1] : cur)];
    })).concat([
      ['Longest shift', (s.max_session_h != null ? num(s.max_session_h) : 16) + ' h — a shift with no punch-out is closed after this'],
      ['Route recording', 'a point every ' + num(s.track_interval_s) + ' s or ' + num(s.track_distance_m) + ' m while moving'],
      ['Route points kept', num(s.retention_days) + ' days (each day’s km is kept)'],
      ['Travel allowance', s.ta_rate_per_km != null ? money(s.ta_rate_per_km) + ' per km' : 'No rate set'],
      ['Office point', (s.office_lat != null && s.office_lng != null) ? Number(s.office_lat).toFixed(5) + ', ' + Number(s.office_lng).toFixed(5) + ' · within ' + num(s.office_radius_m) + ' m is “at the shop”' : 'Not set']
    ]);
    // v2.4: how full the punch photo store is (tier 4+).
    if (s.selfie_store_bytes != null) {
      var used = num(s.selfie_store_bytes, 0);
      rows.push(['Punch photos', (fmtBytes(used) || '0 bytes') + ' of 200 MB used' + (used > 160 * 1048576 ? ' — nearly full: tell the owner' : '') + ' (kept ' + num(s.retention_days, 90) + ' days)']);
    }
    html.push(officeBanner());
    html.push('<section class="hr-card"><div class="hr-card-head"><h3 class="hr-app-title">Office hours and tracking</h3>' +
      actBtn('primary-pink-btn', 'settings-edit', 'Edit…', '', isDemo() ? DEMO_OFF : null) + '</div>' +
      '<dl class="hr-dl">' + rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>' +
      '<p class="hr-hint">Shift changes apply from the date you pick (tomorrow by default), so past days keep the hours they had. Tracking changes reach a phone at its next punch-in or break end. ' +
      'Every punch in and out is checked against the office point: inside the radius counts as at the shop.</p></section>');
    // People (hr_settings_get's `people`, tier 4+)
    var people = settingsPeople().slice().sort(function (a, b) { return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
    var out = '<section class="hr-card"><div class="hr-card-head"><h3 class="hr-app-title">People</h3></div>';
    if (!people.length) out += emptyBox(Array.isArray(s.people) ? 'No staff to show.' : 'Per-person settings did not come with this answer. Refresh to try again.');
    else {
      out += '<div class="hr-table-wrap"><table class="hr-table"><thead><tr><th scope="col">Person</th><th scope="col">Hours</th><th scope="col">Weekly off</th>' +
        '<th scope="col">Field staff</th><th scope="col">Travel allowance</th><th scope="col">Attendance</th><th scope="col"><span class="hr-sr">Actions</span></th></tr></thead><tbody>';
      people.forEach(function (p) {
        var pr = personRow(p.email) || {};
        var custom = pr.shift_start || pr.shift_end;
        var why = personWhyNot(p);
        var next = (pr.upcoming || [])[0];
        // An empty field of theirs is the office default in force that day.
        var nextDay = next && next.effective_from ? String(next.effective_from).slice(0, 10) : '';
        var nd = nextDay ? (defaultShift(nextDay) || cur) : cur;
        out += '<tr><th scope="row"><div class="hr-who">' + esc(p.name || p.email) + (p.self || isSelf(p.email) ? ' <span class="hr-you">you</span>' : '') + '</div>' +
          '<div class="hr-muted">' + esc([p.designation, 'tier ' + num(p.tier)].filter(Boolean).join(' · ')) + '</div></th>' +
          '<td class="hr-n">' + esc(custom ? (hhmm(pr.shift_start) || hhmm(cur.shift_start)) + '–' + (hhmm(pr.shift_end) || hhmm(cur.shift_end)) : 'Default') +
            (nextDay ? '<div class="hr-muted">' + esc('From ' + shortDay(nextDay) + ': ' +
              ((hhmm(next.shift_start) || hhmm(nd.shift_start)) + '–' + (hhmm(next.shift_end) || hhmm(nd.shift_end)))) + '</div>' : '') + '</td>' +
          '<td>' + esc(Array.isArray(pr.weekly_off) ? f.weeklyOffText(pr.weekly_off) : 'Default') + '</td>' +
          '<td>' + (pr.track_location === false ? esc('No') : '<b>' + esc('Yes') + '</b>') + '</td>' +
          '<td>' + (pr.track_location === false ? '<span class="hr-muted" title="Only field staff get travel allowance">—</span>'
            : esc(pr.ta_eligible === false ? 'Not eligible' : 'Eligible')) + '</td>' +
          '<td>' + esc(pr.attendance_required === false ? 'Not tracked' : 'Required') + '</td>' +
          '<td class="hr-acts">' + actBtn('text-btn', 'person-edit', 'Edit…', ' data-hr-email="' + esc(lower(p.email)) + '"', why) + '</td></tr>';
      });
      out += '</tbody></table></div>';
    }
    out += '<p class="hr-hint">Field staff are the engineers who go out on site: only their phones record a route while they are on duty, and only they have trips, km and travel allowance. ' +
      'Everyone else is checked at the shop when they punch in and out. “Not tracked” people are never late or absent (for example the owner).</p></section>';
    html.push(out);
    setStat('Settings');
    return html.join('');
  }
  // p: a settings person. The staff hierarchy and S19, as hr_person_set
  // refuses them; the server's can_edit has the last word.
  function personWhyNot(p) {
    var me = tierNow();
    var self = p.self === true || isSelf(p.email);
    if (me < 4) return 'Settings are for tier 4 and above.';
    if (isDemo()) return DEMO_OFF;
    if (self && me < 5) return selfSentence();
    if (!self && me < 5 && num(p.tier) >= 4) return OWNER_ONLY;
    if (p.can_edit === false) return self ? selfSentence() : OWNER_ONLY;
    return null;
  }

  // ── Logs: Work logs ───────────────────────────────────────────────────────
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

  // ── Logs: Field activity ──────────────────────────────────────────────────
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
    html.push('<p class="hr-hint">Claimed and assigned count service jobs taken from the queue or given by a lead (or the app’s offer). Site visits come from NeoHR on the phone: left the shop, arrived, finished. Punches are the NeoHR punch-ins and punch-outs (the Attendance tab has the hours).</p>');
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
    var what = '<p class="hr-app-p">On the phone, NeoHR is the one app a technician needs away from a Neo OS PC: attendance (punch in and out, breaks, ' +
      'the time on each site, and Tell HR for a late start, leave or a missed punch), the route of the working day for travel allowance — recorded only ' +
      'between punch-in and punch-out, never on a break, and always with a notification — a simple dashboard, the work queue, their service jobs and ' +
      'builds, notes, photos, site visits and their daily work logs, which show up here.</p>';
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
      '<li>On the Attendance tab, allow location (<em>Allow all the time</em> keeps the route going when the phone is locked or restarts) and set NeoHR’s battery use to <em>Unrestricted</em> when it asks.</li>' +
      '<li>From then on NeoHR updates itself: it shows <em>Update available</em> on its Dashboard and in Settings → Check for updates.</li>' +
    '</ol>' +
    '<p class="hr-hint">A phone with an older <em>test</em> build of NeoHR keeps it as a separate app. Check that its logs show up under Logs here before uninstalling it.</p>';
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

  // ── CSV (a Blob download; HR-SPEC §9.8 columns and cells) ─────────────────
  function downloadCsv(filename, text) {
    try {
      var blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
      return true;
    } catch (e) {
      toast('Could not save the CSV: ' + errText(e), 'error');
      return false;
    }
  }
  function exportRegister() {
    var f = F();
    if (!f || !st.slots.reg.val) { toast('Load the register first.', 'info'); return; }
    var recs = regRecords().slice().sort(function (a, b) { return a.name.localeCompare(b.name) || a.day.localeCompare(b.day); });
    if (st.v.regView === 'day') recs = recs.filter(function (r) { return r.day === st.v.regDay; });
    if (!recs.length) { toast('Nothing to export for this choice.', 'info'); return; }
    var r = regRange();
    var name = 'neohr-attendance-' + r.from + (r.to !== r.from ? '-to-' + r.to : '') + '.csv';
    if (downloadCsv(name, f.registerCsv(recs))) toast('Saved ' + name + ' (' + plural(recs.length, 'row') + ').', 'success');
  }
  function exportTa() {
    var f = F();
    var data = taData();
    if (!f || !data) { toast('Load the report first.', 'info'); return; }
    if (!data.rows.length) { toast('Nothing to export for this month.', 'info'); return; }
    var name = 'neohr-travel-allowance-' + data.month.slice(0, 7) + '.csv';
    if (downloadCsv(name, f.taCsv(data.rows.map(function (r) {
      return { name: r.name, km: r.km, rate: r.rate != null ? r.rate : data.rate, amount: r.amount, approved: r.approved };
    }), data.month))) toast('Saved ' + name + '.', 'success');
  }

  // ── dialogs ───────────────────────────────────────────────────────────────
  function dialog(opts) {
    var ui = UI();
    if (!ui || typeof ui.dialog !== 'function') { toast('This needs the Neo OS 1.12 files. Restart Neo OS.', 'error'); return Promise.resolve(false); }
    return ui.dialog(opts);
  }
  function stillMe(who) { return who === whoKey(); }
  var GONE = 'You are no longer signed in as the same person — nothing was changed.';
  function field(lbl, inner, cls) { return '<label class="ops-field' + (cls ? ' ' + cls : '') + '"><span>' + esc(lbl) + '</span>' + inner + '</label>'; }
  function val(root, sel) { var x = root.querySelector(sel); return x ? String(x.value || '').trim() : ''; }
  function checked(root, sel) { var x = root.querySelector(sel); return !!(x && x.checked); }
  // After an HR write: re-read the tab on show. Not Routes — no HR write
  // changes a route, and every read of someone else's route is logged as a view.
  function refreshAfterWrite() {
    if (st.hrTimer) clearTimeout(st.hrTimer);
    st.hrTimer = setTimeout(function () { st.hrTimer = null; if (active() && profile() && st.tab !== 'routes') loadTab(false); }, 150);
  }

  // The day panel: the record, every punch (voided ones struck through) with
  // its source and clock mark, the site visits, and — for an approver on
  // someone else's day — Correct…. Each change has a note and is ONE
  // hr_correct, checked together on the server:
  //   add a punch · void one · replace one (void + add) · remove an
  //   accidental out–in pair (a punch-out and the punch-in right after it:
  //   two voids).
  // opts.request: a pending missed punch that hr_request_decide said no
  // longer fits the day. Every change here then carries its request_id, so
  // the request is approved together with the change it needs; opts.note is
  // the note typed in the approve dialog, offered again.
  function openDay(email, day, opts) {
    var e = lower(email);
    if (!e || !validDay(day)) return;
    opts = opts || {};
    var who = whoKey();
    var why = whyNotAct(e);
    var bodyEl = document.createElement('div');
    bodyEl.className = 'hr-dd';
    var rq = opts.request;
    var state = { data: null, err: null,
      req: (!why && rq && rq.id && rq.kind === 'missed_punch' && (!rq.status || rq.status === 'pending') && lower(rq.email) === e) ? rq : null };
    var preNote = state.req && opts.note ? String(opts.note).slice(0, 300) : '';
    function events() {
      var v = state.data;
      return (v && Array.isArray(v.events) ? v.events : []).slice().sort(function (a, b) { return tsMs(a.at) - tsMs(b.at); });
    }
    function eventById(id) {
      var list = events();
      for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
      return null;
    }
    // Accidental out–in pairs: a punch-out and the punch-in right after it
    // (voided punches left out), keyed by the punch-out's id.
    function pairs() {
      var live = events().filter(function (x) { return !x.voided_at && x.id; }), out = {};
      for (var i = 0; i + 1 < live.length; i++) {
        if (live[i].kind === 'punch_out' && live[i + 1].kind === 'punch_in') out[live[i].id] = { out: live[i], back: live[i + 1] };
      }
      return out;
    }
    function evText(x) { return label('EVENT_LABELS', x.kind) + ' at ' + hmOn(x.at, day); }
    // v2.4: the server's check of one punch in / out — where, how sure, its
    // flags, the reason, the request it opened, and the photo.
    function evChecks(ev) {
      var f = F();
      if (!f || !ev || (ev.kind !== 'punch_in' && ev.kind !== 'punch_out')) return '';
      var has = function (k) { return Object.prototype.hasOwnProperty.call(ev, k); };
      if (!has('place') && !has('verify') && !has('selfie')) return '';
      var out = ev.source === 'hr' ? '' : checkTags(ev);
      var reason = f.reasonText(ev);
      if (reason) out += '<span class="hr-ev-note hr-ev-reason">' + esc(reason) + '</span>';
      var rq = null;
      if (ev.request_id && state.data && Array.isArray(state.data.requests)) {
        rq = state.data.requests.filter(function (q) { return q && String(q.id) === String(ev.request_id); })[0] || null;
      }
      if (rq) out += chip('hr-rs-' + (/^[a-z]+$/.test(String(rq.status)) ? rq.status : 'x'), label('REQUEST_LABELS', rq.kind) + ': ' + label('REQUEST_STATUS', rq.status || 'pending'));
      else if (ev.request_id) out += tag('Sent to HR', 'hr-mark-clock');
      if (ev.selfie === true && ev.id) {
        if (ev.selfie_late) out += tag('Photo sent late', 'hr-mark-warn', 'The photo arrived more than 10 minutes after the punch.');
        out += '<button type="button" class="text-btn hr-btn" data-hr-act="photo" data-hr-event="' + esc(ev.id) + '" data-hr-title="' + esc(nameOf(e) + ' — ' + evText(ev)) +
          '" data-hr-sub="' + esc(dayLabel(day, today())) + '" title="Open the photo taken at this punch (each look is recorded)">📷 Photo</button>';
      } else if (has('selfie') && ev.source !== 'hr' && !ev.selfie_skip) {
        out += tag('No photo', 'hr-mark-warn', 'No photo came with this punch (yet).');
      }
      return out;
    }
    function reqText(r) { return label('EVENT_LABELS', r.missed_kind) + ' at ' + hmOn(r.missed_at, day); }
    function reqHint() {
      return state.req ? '<p class="ops-hint hr-dd-req">' + esc('Their missed punch (' + reqText(state.req) + ') is added too, and the request is approved with this change.') + '</p>' : '';
    }
    function kindSelect(attr, cur) {
      return field('Punch', '<select data-hr-f="' + attr + '">' + ((F() && F().EVENT_KINDS) || []).map(function (k) {
        return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(label('EVENT_LABELS', k)) + '</option>';
      }).join('') + '</select>');
    }
    function dateInput(attr, v) {
      return field('Date', '<input type="date" data-hr-f="' + attr + '" value="' + esc(v) + '" min="' + esc(day) + '" max="' + esc(addDays(day, 1)) + '">');
    }
    // The approve dialog's note is offered again only while approving.
    function noteInput(attr, tag2, hint) {
      var pre = state.req ? preNote : '';
      return tag2 === 'textarea'
        ? field('Note (required — why)', '<textarea data-hr-f="' + attr + '" maxlength="300" rows="3">' + esc(pre) + '</textarea>')
        : field('Note (required — why)', '<input type="text" data-hr-f="' + attr + '" maxlength="300" value="' + esc(pre) + '" placeholder="' + esc(hint || '') + '">', 'ops-span2');
    }
    // One hr_correct; a request being approved rides along. → true (done, or
    // the request was already decided: said in a toast) or a sentence.
    function correct(p, done) {
      var req = state.req;
      return need('hrCorrect').hrCorrect(e, req ? Object.assign({}, p, { request_id: req.id }) : p).then(function (res) {
        refreshAfterWrite();
        if (res && res.ok === false) {
          if (req && res.reason === 'decided') {
            state.req = null;
            load();
            toast('Nothing was changed: that missed punch was already ' + label('REQUEST_STATUS', res.status).toLowerCase() +
              (res.by ? ' by ' + res.by : '') + (res.at ? ' at ' + istHm(res.at) : '') + '.', 'warning', 8000);
            return true;
          }
          return res.message || 'That did not go through. Refresh and try again.';
        }
        if (req) state.req = null;
        load();
        toast(done + (req ? ' The missed punch is approved — ' + (req.name || nameOf(e)) + ' sees it on NeoHR.' : ''), 'success', req ? 7000 : undefined);
        return true;
      });
    }
    function voidPunch(id) {
      var x = eventById(id);
      dialog({
        title: 'Void this punch?', okText: state.req ? 'Void and approve' : 'Void it', danger: true, busyText: 'Voiding…',
        body: (x ? '<p class="ops-dialog-msg"><b>' + esc(evText(x)) + '</b></p>' : '') +
          '<p class="ops-dialog-msg">The punch stays in the history, struck through, with your note.</p>' + reqHint() +
          noteInput('vnote', 'textarea'),
        onOk: function (root) {
          if (!stillMe(who)) return GONE;
          var note = val(root, '[data-hr-f="vnote"]');
          if (!note) return 'Say why you are voiding it.';
          return correct({ op: 'void', id: id, note: note }, 'Punch voided.');
        }
      });
    }
    // Replace: void this punch and add the right one, checked together.
    function replacePunch(id) {
      var x = eventById(id);
      if (!x || x.voided_at) { toast('That punch has changed — look at the day again.', 'info'); return; }
      var xd = dayOf(x.at), last = addDays(day, 1);
      dialog({
        title: 'Replace this punch?', okText: state.req ? 'Replace and approve' : 'Replace it', busyText: 'Replacing…',
        body: '<p class="ops-dialog-msg"><b>' + esc(evText(x)) + '</b> is voided and the punch below is added in its place — checked together, as one correction.</p>' + reqHint() +
          '<div class="ops-grid">' + kindSelect('rkind', x.kind) + dateInput('rdate', xd < day ? day : (xd > last ? last : xd)) +
          field('Time (India)', '<input type="time" data-hr-f="rtime" required value="' + esc(istHm(x.at)) + '">') +
          noteInput('rnote', 'input', 'e.g. Punched out at 17:10 by mistake; left at 18:40') + '</div>',
        onOk: function (root) {
          if (!stillMe(who)) return GONE;
          var kind = val(root, '[data-hr-f="rkind"]'), date = val(root, '[data-hr-f="rdate"]'), time = val(root, '[data-hr-f="rtime"]'), note = val(root, '[data-hr-f="rnote"]');
          if (!time) return 'Choose the time of the punch.';
          if (!note) return 'Say why you are replacing it.';
          var at = F() ? F().istToIso(date, time) : null;
          if (!at) return 'Choose the date and time.';
          if (tsMs(at) > nowMs() + 60000) return 'That time is in the future.';
          if (kind === x.kind && Math.floor(tsMs(at) / 60000) === Math.floor(tsMs(x.at) / 60000)) return 'That is the same punch — change the time or the kind.';
          return correct({ ops: [{ op: 'void', id: x.id }, { op: 'add', kind: kind, at: at }], note: note },
            label('EVENT_LABELS', kind) + ' at ' + time + ' replaces ' + evText(x).replace(/^./, function (c) { return c.toLowerCase(); }) + '.');
        }
      });
    }
    // An accidental punch-out and back in: both voided, checked together.
    function removePair(outId) {
      var pr = pairs()[outId];
      if (!pr) { toast('Those punches have changed — look at the day again.', 'info'); return; }
      dialog({
        title: 'Remove this out–in pair?', okText: state.req ? 'Remove both and approve' : 'Remove both', danger: true, busyText: 'Removing…',
        body: '<p class="ops-dialog-msg">For a punch-out and punch-in made by mistake: both are voided together, as one correction, so the time between them counts as work.</p>' +
          '<ul class="hr-evs hr-pair">' + [pr.out, pr.back].map(function (x) {
            return '<li><span class="hr-ev-t">' + esc(hmOn(x.at, day)) + '</span><span class="hr-ev-k">' + esc(label('EVENT_LABELS', x.kind)) + '</span></li>';
          }).join('') + '</ul>' + reqHint() + noteInput('pnote', 'textarea'),
        onOk: function (root) {
          if (!stillMe(who)) return GONE;
          var note = val(root, '[data-hr-f="pnote"]');
          if (!note) return 'Say why you are removing them.';
          return correct({ ops: [{ op: 'void', id: pr.out.id }, { op: 'void', id: pr.back.id }], note: note },
            'Punch-out at ' + hmOn(pr.out.at, day) + ' and punch-in at ' + hmOn(pr.back.at, day) + ' removed.');
        }
      });
    }
    function paintDay() {
      if (!stillMe(who)) return;
      var html = [];
      if (why === selfSentence()) html.push(banner(why, 'info'));
      if (state.req) {
        html.push(banner('Approving ' + (state.req.name || nameOf(e)) + '’s missed punch: ' + reqText(state.req) +
          (state.req.reason ? ' (“' + state.req.reason + '”)' : '') + '. It does not fit the day as it is. Make the change it needs below — ' +
          'void, replace or remove a pair, or add a punch — and the request is approved with it, as one correction. Close to leave it waiting.', 'warn'));
      }
      if (state.err) html.push(banner('The day could not be loaded: ' + errText(state.err), 'error'));
      var v = state.data;
      if (!v && !state.err) html.push(loadingBox('Loading the day…'));
      if (v) {
        var rec = (v.record && typeof v.record === 'object') ? v.record : (v.day && typeof v.day === 'object' ? v.day : v);
        var onField = showsRoute(e, typeof v.field_staff === 'boolean' ? v : rec);
        var trips = Array.isArray(v.trips) ? v.trips.filter(function (x) { return x && typeof x === 'object'; }) : [];
        var facts = [
          ['Duty', rec.duty || v.duty ? label('DUTY_LABELS', rec.duty || v.duty) : '—'],
          ['Status', rec.status ? label('DAY_LABELS', rec.status) : '—'],
          ['Shift', (F() && F().shiftText(v.shift || rec.shift)) || '—'],
          ['In', rec.first_in ? hmOn(rec.first_in, day) : '—'],
          ['Out', rec.last_out ? hmOn(rec.last_out, day) : (rec.missed_out ? 'no punch-out' : '—')],
          ['Worked', rec.worked_min != null ? fmtDur(rec.worked_min) : '—'],
          ['Breaks', rec.break_min != null ? fmtDur(rec.break_min) : '—']
        ];
        if (onField) facts.push(['km', v.km != null ? fmtKm(v.km) : (rec.km != null ? fmtKm(rec.km) : '—')]);
        if (onField && (rec.trip_km != null || trips.length)) {
          facts.push(['Trip km', rec.trip_km != null ? fmtKm(rec.trip_km)
            : fmtKm(Math.round(trips.reduce(function (a, x) { return a + Math.max(0, num(x.km)); }, 0) * 100) / 100)]);
        }
        if (num(rec.pending_min) > 0) facts.push(['Waiting for HR', fmtDur(rec.pending_min)]);
        html.push('<div class="hr-dd-facts">' + facts.map(function (x) { return '<div><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>'; }).join('') + '</div>');
        var marks = recMarks(Object.assign({ email: e }, rec, { holiday: rec.holiday || v.holiday }));
        if (marks) html.push('<div class="hr-dd-marks">' + marks + '</div>');
        var reqs = (Array.isArray(v.requests) ? v.requests : []).filter(function (q) { return q && q.id; });
        var evs = events();
        var pr = why ? {} : pairs();
        // While approving a missed punch: where it would go, among the punches.
        var rows = evs.slice();
        if (state.req && isFinite(tsMs(state.req.missed_at))) {
          rows.push({ _req: true, kind: state.req.missed_kind, at: state.req.missed_at });
          rows.sort(function (a, b) { return tsMs(a.at) - tsMs(b.at); });
        }
        html.push('<h4 class="hr-app-h">Punches</h4>');
        if (!rows.length) html.push(emptyBox('No punches on this day.'));
        else {
          html.push('<ul class="hr-evs">' + rows.map(function (ev) {
            if (ev._req) {
              return '<li class="hr-ev-req"><span class="hr-ev-t">' + esc(hmOn(ev.at, day)) + '</span>' +
                '<span class="hr-ev-k">' + esc(label('EVENT_LABELS', ev.kind)) + '</span>' +
                tag('Missed punch — waiting', 'hr-mark-warn', 'Added when the request is approved with your change') + '</li>';
            }
            var voided = !!ev.voided_at;
            var src = ev.source === 'hr' || ev.time_source === 'hr' ? tag('Added by HR', 'hr-mark-info') : '';
            var acts = (!voided && !why && ev.id) ? '<span class="hr-ev-acts">' +
              '<button type="button" class="text-btn hr-btn" data-hr-replace="' + esc(ev.id) + '" title="Void it and add the right punch in its place, as one correction">Replace…</button>' +
              (pr[ev.id] ? '<button type="button" class="text-btn hr-btn" data-hr-pair="' + esc(ev.id) + '" title="' +
                esc('A punch-out and back in by mistake: void this punch-out and the punch-in at ' + hmOn(pr[ev.id].back.at, day) + ' together') + '">Remove out–in pair…</button>' : '') +
              '<button type="button" class="text-btn hr-btn" data-hr-void="' + esc(ev.id) + '">Void…</button></span>' : '';
            return '<li class="' + (voided ? 'voided' : '') + '"><span class="hr-ev-t">' + esc(hmOn(ev.at, day)) + '</span>' +
              '<span class="hr-ev-k">' + esc(label('EVENT_LABELS', ev.kind)) + '</span>' + src + (voided ? '' : clockTag(ev, e)) +
              (voided ? '' : evChecks(ev)) +
              (ev.note ? '<span class="hr-ev-note">' + esc(ev.note) + '</span>' : '') +
              (voided ? '<span class="hr-ev-note">Voided' + (ev.void_reason ? ': ' + esc(ev.void_reason) : '') + '</span>' : '') +
              acts +
            '</li>';
          }).join('') + '</ul>');
        }
        // v2.4: the requests of this day (punch reasons, away punches and
        // Tell HR), each with its decision; an approver decides from here.
        if (reqs.length) {
          html.push('<h4 class="hr-app-h">Requests</h4><ul class="hr-visits hr-dd-reqs">' + reqs.map(function (q) {
            var status = String(q.status || 'pending');
            var f = F();
            var due = isPunchKind(q.kind) && f ? f.dueText(q, today(), nowMs()) : null;
            var rk = q.reason_kind ? label('REASON_LABELS', q.reason_kind) : '';
            var reasonLine = (rk && rk !== q.reason ? rk + (q.reason ? ' — ' : '') : '') + (q.reason || '');
            var dw = why || (q.can_decide === false ? 'You can’t decide this one.' : null);
            var acts2 = status === 'pending' && !why
              ? '<span class="hr-ev-acts"><button type="button" class="text-btn hr-btn" data-hr-decide="' + esc(q.id) + '" data-hr-ok="1"' + (dw ? ' disabled title="' + esc(dw) + '"' : '') + '>Approve…</button>' +
                '<button type="button" class="text-btn hr-btn" data-hr-decide="' + esc(q.id) + '" data-hr-ok="0"' + (dw ? ' disabled title="' + esc(dw) + '"' : '') + '>Reject…</button></span>'
              : '';
            return '<li><div class="hr-dd-req-head"><b>' + esc(label('REQUEST_LABELS', q.kind)) + '</b> ' +
                chip('hr-rs-' + (/^[a-z]+$/.test(status) ? status : 'x'), label('REQUEST_STATUS', status)) +
                (due ? ' <span class="hr-due' + (due.late ? ' late' : '') + '">' + esc(due.text) + '</span>' : '') + acts2 + '</div>' +
              (reasonLine ? '<div class="hr-muted">' + esc(reasonLine) + (q.ref_code ? ' · ' + esc(q.ref_code) : '') + '</div>' : '') +
              (q.decision_note || q.decided_by_name ? '<div class="hr-muted">' + esc([q.decided_by_name ? label('REQUEST_STATUS', status) + ' by ' + q.decided_by_name : '', q.decision_note || ''].filter(Boolean).join(' · ')) + '</div>' : '') +
            '</li>';
          }).join('') + '</ul>');
        }
        // v2.4: trips (field staff).
        if (trips.length && onField) {
          html.push('<h4 class="hr-app-h">Trips</h4><ul class="hr-visits">' + trips.map(function (x) {
            var f = F();
            var bits = [f ? f.tripSpan(x) : '', x.moving_min != null ? fmtDur(x.moving_min) + ' moving' : '',
                        x.km != null ? fmtKm(x.km) + ' km' : '', x.stops != null ? plural(num(x.stops), 'stop') : '',
                        x.open ? '' : (x.end_reason ? label('TRIP_END_LABELS', x.end_reason) : '')].filter(Boolean).join(' · ');
            var flags = f ? f.flagList(x) : [];
            return '<li><b>' + esc(f ? f.tripText(x) : 'Trip') + '</b>' + (x.ref_title ? ' — ' + esc(x.ref_title) : '') +
              (x.id ? ' <button type="button" class="text-btn hr-btn" data-hr-trip="' + esc(x.id) + '" title="See this trip on the route map">Map</button>' : '') +
              flags.map(function (g) { return tag(g.text, 'hr-mark-warn', g.tip); }).join('') +
              '<div class="hr-muted">' + esc(bits) + '</div>' +
              (x.note && x.ref_code ? '<div class="hr-muted">' + esc(x.note) + '</div>' : '') + '</li>';
          }).join('') + '</ul>');
        }
        var visits = Array.isArray(v.visits) ? v.visits : [];
        if (visits.length) {
          html.push('<h4 class="hr-app-h">Site visits</h4><ul class="hr-visits">' + visits.map(function (x) {
            var bits = [x.minutes != null ? fmtDur(x.minutes) + ' on site' : '', x.travel_min != null ? fmtDur(x.travel_min) + ' travel' : '',
                        x.outcome ? String(x.outcome).replace(/_/g, ' ') : ''].filter(Boolean).join(' · ');
            return '<li><b>' + esc(x.code || '') + '</b> ' + esc(x.title || '') + '<div class="hr-muted">' +
              esc((x.assumed_arrival ? 'arrival not recorded' : istHm(x.arrived)) + ' – ' + (x.open ? 'still there' : istHm(x.departed)) + (bits ? ' · ' + bits : '')) + '</div></li>';
          }).join('') + '</ul>');
        }
      }
      if (!why) {
        html.push('<h4 class="hr-app-h">Add a punch</h4><div class="ops-grid hr-dd-add">' +
          kindSelect('kind', null) + dateInput('date', day) +
          field('Time (India)', '<input type="time" data-hr-f="time" required>') +
          noteInput('note', 'input', 'e.g. Forgot to punch out; left at 18:40 (told the manager)') +
        '</div><p class="ops-hint">The punch is added as HR’s, at the time you give; the order of the day must still make sense (in → break → back → out). ' +
          'A punch at the wrong time: Replace…. A punch-out and back in by mistake: Remove out–in pair…. Each is checked as one correction.</p>' + reqHint());
      }
      bodyEl.innerHTML = html.join('');
    }
    var loadSeq = 0;
    function load() {
      var mine = ++loadSeq;
      state.err = null;
      paintDay();
      Promise.resolve().then(function () { return need('hrMyDay').hrMyDay(day, e); }).then(function (v) {
        if (!stillMe(who) || mine !== loadSeq) return;
        state.data = v; paintDay();
      }, function (err) {
        if (!stillMe(who) || mine !== loadSeq) return;
        state.err = err; paintDay();
      });
    }
    bodyEl.addEventListener('click', function (ev) {
      // v2.4: a punch photo, a request of the day, a trip on the map.
      var ph = ev.target.closest('[data-hr-act="photo"]');
      if (ph && !ph.disabled) { openPhoto(ph); return; }
      var dq = ev.target.closest('[data-hr-decide]');
      if (dq && !dq.disabled && !why) {
        var qid = dq.getAttribute('data-hr-decide');
        var q = (state.data && Array.isArray(state.data.requests) ? state.data.requests : []).filter(function (x) { return x && String(x.id) === qid; })[0];
        if (q) decideRequest(Object.assign({}, q, { email: lower(q.email || q.employee_email || e), name: String(q.name || q.employee_name || nameOf(e)) }),
          dq.getAttribute('data-hr-ok') === '1', function () { load(); });
        return;
      }
      var tr = ev.target.closest('[data-hr-trip]');
      if (tr) {
        var tid = tr.getAttribute('data-hr-trip');
        var ui = UI();
        if (ui && typeof ui.closeAll === 'function') { try { ui.closeAll(); } catch (x) { /* the day panel stays */ } }
        showRoute(e, day, tid);
        return;
      }
      var b = ev.target.closest('[data-hr-void], [data-hr-replace], [data-hr-pair]');
      if (!b || b.disabled || why) return;
      if (b.hasAttribute('data-hr-void')) voidPunch(b.getAttribute('data-hr-void'));
      else if (b.hasAttribute('data-hr-replace')) replacePunch(b.getAttribute('data-hr-replace'));
      else removePair(b.getAttribute('data-hr-pair'));
    });
    var name = nameOf(e);
    return dialog({
      title: name + ' — ' + dayLabel(day, today()),
      sub: state.req ? 'Approve the missed punch with the change it needs.'
        : (opts.correct ? 'Correct the day: add, void or replace a punch, or remove an out–in pair.' : 'Punches, breaks and site visits'),
      body: bodyEl, wide: true, cancelText: 'Close', okText: why ? null : 'Add punch', busyText: 'Adding…',
      onOpen: function () { load(); },
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var kind = val(root, '[data-hr-f="kind"]'), date = val(root, '[data-hr-f="date"]'), time = val(root, '[data-hr-f="time"]'), note = val(root, '[data-hr-f="note"]');
        if (!time) return 'Choose the time of the punch.';
        if (!note) return 'Say why you are adding it.';
        var at = F() ? F().istToIso(date, time) : null;
        if (!at) return 'Choose the date and time.';
        if (tsMs(at) > nowMs() + 60000) return 'That time is in the future.';
        return correct({ op: 'add', kind: kind, at: at, note: note }, label('EVENT_LABELS', kind) + ' added at ' + time + '.').then(function (r) {
          return r === true ? false : r;   // stay open on the refreshed day
        });
      }
    });
  }

  // A punch photo, full size (hr_selfie_get): fetched on a click, shown in
  // the photo viewer from memory, and never kept anywhere. The server
  // records each look.
  var photoBusy = {};
  function openPhoto(btn) {
    var id = btn.getAttribute('data-hr-event');
    if (!id || photoBusy[id]) return;
    var title = btn.getAttribute('data-hr-title') || 'Punch photo';
    var sub = btn.getAttribute('data-hr-sub') || '';
    var who = whoKey();
    photoBusy[id] = true;
    Promise.resolve().then(function () { return need('hrSelfieGet').hrSelfieGet(id); }).then(function (res) {
      delete photoBusy[id];
      if (!stillMe(who)) return;
      var f = F();
      var url = f && res ? f.jpegDataUrl(res.jpeg_b64) : null;
      if (!url) { toast('There is no photo for this punch.', 'info'); return; }
      var ui = UI();
      if (!ui || typeof ui.lightbox !== 'function') { toast('The photo viewer could not open. Restart Neo OS.', 'error'); return; }
      var bits = [sub, res.taken_at ? 'taken at ' + istHm(res.taken_at) : '', res.late ? 'sent late' : ''].filter(Boolean).join(' · ');
      ui.lightbox([{ url: url, title: title, sub: bits, type: 'image/jpeg' }], 0);
    }, function (err) {
      delete photoBusy[id];
      if (!stillMe(who)) return;
      toast('The photo could not be opened: ' + errText(err), 'error');
    });
  }

  // hr_request_decide's answer when a missed punch no longer fits the day:
  // its punch would not be taken, or a later punch would become irregular.
  var NO_LONGER_FITS = /no longer fits the day/i;
  // The day a missed punch is fixed on: the request's day (India day of missed_at).
  function reqDay(r) { var d = String(r.date_from || '').slice(0, 10); return validDay(d) ? d : dayOf(r.missed_at || r.punch_at); }

  // id: a request id from the lists, or the request itself (the day panel).
  // onDone: called after a decision went through (the day panel reloads).
  function decideRequest(id, approve, onDone) {
    var r = id && typeof id === 'object' ? id : findRequest(id);
    if (!r) { toast('That request is no longer listed. Refresh and try again.', 'info'); return; }
    if (isPunchKind(r.kind)) { decidePunchRequest(r, approve, onDone); return; }
    var who = whoKey();
    var verb = approve ? 'Approve' : 'Reject';
    var effect = F() ? F().effectText(r.kind, approve, r) : '';
    var fix = null;
    dialog({
      title: verb + ' ' + label('REQUEST_LABELS', r.kind).toLowerCase() + ' for ' + r.name + '?',
      sub: reqDates(r),
      okText: verb, danger: !approve, busyText: approve ? 'Approving…' : 'Rejecting…',
      body: (r.reason ? '<p class="ops-dialog-msg">“' + esc(r.reason) + '”</p>' : '') +
        (effect ? '<p class="ops-hint">' + esc(effect) + '</p>' : '') +
        field(approve ? 'Note (optional)' : 'Note (required — they will read it)', '<textarea data-hr-f="note" maxlength="300" rows="3"></textarea>'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var note = val(root, '[data-hr-f="note"]');
        if (!approve && !note) return 'Say why you are rejecting it.';
        return need('hrRequestDecide').hrRequestDecide(r.id, approve, note || null).then(function (res) {
          refreshAfterWrite();
          if (res && res.ok === false) {
            if (res.reason === 'decided') {
              toast('Already ' + label('REQUEST_STATUS', res.status).toLowerCase() + (res.by ? ' by ' + res.by : '') + (res.at ? ' at ' + istHm(res.at) : '') + '.', 'warning', 8000);
              return true;
            }
            return res.message || 'That did not go through. Refresh and try again.';
          }
          toast((approve ? 'Approved' : 'Rejected') + ' — ' + r.name + ' sees it on NeoHR.', 'success');
          if (typeof onDone === 'function') onDone();
          return true;
        }, function (err) {
          // Nothing was changed and it stays pending: Correct… on that day
          // approves it together with the change it needs (hr_correct with
          // its request_id).
          if (approve && r.kind === 'missed_punch' && NO_LONGER_FITS.test(String((err && err.message) || err || ''))) {
            fix = { note: note };
            return true;
          }
          throw err;
        });
      }
    }).then(function (done) {
      if (!done || !fix || !stillMe(who)) return;
      toast('That punch no longer fits the day as it is — make the change it needs, and the request is approved with it.', 'info', 7000);
      openDay(r.email, reqDay(r), { correct: true, request: r, note: fix.note });
    });
  }
  // A punch reason or an away punch (v2.4): hr_punch_request_decide.
  // Rejecting an away punch removes it; HR may give the right time, and the
  // server adds HR's punch there when the day allows it. When it does not
  // (correct.ok false), Correct… opens on that day.
  function decidePunchRequest(r, approve, onDone) {
    var who = whoKey();
    var f = F();
    var verb = approve ? 'Approve' : 'Reject';
    var away = r.kind === 'away_punch';
    var day = reqDay(r);
    var effect = f ? f.effectText(r.kind, approve, r) : '';
    var place = f ? f.placeText(r) : '';
    var reason = f ? f.reasonText({ reason_kind: r.reason_kind, reason_text: r.reason, reason_ref: r.ref_code }) : String(r.reason || '');
    var askTime = away && !approve;
    var outcome = null;
    dialog({
      title: verb + ' ' + (away ? 'the away punch' : 'the ' + label('REQUEST_LABELS', r.kind).toLowerCase()) + ' for ' + r.name + '?',
      sub: reqDates(r),
      okText: verb, danger: !approve, busyText: approve ? 'Approving…' : 'Rejecting…',
      body: (place || reason ? '<p class="ops-dialog-msg">' + esc([place, reason].filter(Boolean).join(' · ')) + '</p>' : '') +
        (effect ? '<p class="ops-hint">' + esc(effect) + '</p>' : '') +
        (askTime ? '<div class="ops-grid">' +
            field('Date', '<input type="date" data-hr-f="cdate" value="' + esc(day) + '" min="' + esc(day) + '" max="' + esc(addDays(day, 1)) + '">') +
            field('The right time (India; empty = none)', '<input type="time" data-hr-f="ctime">') +
          '</div><p class="ops-hint">' + esc('Leave the time empty if they did not work then. You can also add it later with Correct… on the day.') + '</p>' : '') +
        field(approve ? 'Note (optional)' : 'Note (required — they will read it)', '<textarea data-hr-f="note" maxlength="300" rows="3"></textarea>'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var note = val(root, '[data-hr-f="note"]');
        if (!approve && !note) return 'Say why you are rejecting it.';
        var at = null;
        if (askTime) {
          var time = val(root, '[data-hr-f="ctime"]'), date = val(root, '[data-hr-f="cdate"]');
          if (time) {
            at = f ? f.istToIso(date, time) : null;
            if (!at) return 'Choose the date and time.';
            if (tsMs(at) > nowMs() + 60000) return 'That time is in the future.';
          }
        }
        return need('hrPunchRequestDecide').hrPunchRequestDecide(r.id, approve, note || null, at).then(function (res) {
          refreshAfterWrite();
          if (res && res.ok === false) {
            if (res.reason === 'decided') {
              toast('Already ' + label('REQUEST_STATUS', res.status).toLowerCase() + (res.by ? ' by ' + res.by : '') + (res.at ? ' at ' + istHm(res.at) : '') + '.', 'warning', 8000);
              return true;
            }
            return res.message || 'That did not go through. Refresh and try again.';
          }
          var c = res && res.correct && typeof res.correct === 'object' ? res.correct : null;
          outcome = { at: at, correct: c };
          if (approve) toast('Approved — ' + r.name + ' sees it on NeoHR.', 'success');
          else if (away && at && (!c || c.ok !== false)) toast('Rejected — the away punch is removed and HR’s punch at ' + istHm(at) + ' is added in its place.', 'success', 7000);
          else if (away && !at) toast('Rejected — the away punch is removed from ' + r.name + '’s day.', 'success', 7000);
          else if (!away) toast('Rejected — the late mark stays. ' + r.name + ' sees your note on NeoHR.', 'success');
          if (typeof onDone === 'function') onDone();
          return true;
        });
      }
    }).then(function (done) {
      if (!done || !outcome || !stillMe(who)) return;
      var c = outcome.correct;
      if (outcome.at && c && c.ok === false) {
        // Rejected, but the right time does not fit the day as it is.
        toast('The away punch is removed, but HR’s punch at ' + istHm(outcome.at) + ' could not be added' + (c.message ? ': ' + c.message : '.') + ' Add it with Correct….', 'warning', 9000);
        openDay(r.email, day, { correct: true });
      }
    });
  }
  function cancelRequest(id) {
    var r = findRequest(id);
    if (!r) { toast('That request is no longer listed. Refresh and try again.', 'info'); return; }
    var who = whoKey();
    var what = r.kind === 'punch_reason' ? 'The late mark for that day comes back.'
      : isPunchKind(r.kind) ? 'The day goes back to how it was before it was approved.'
      : 'Roster days set by this request go back to their defaults.';
    dialog({
      title: 'Cancel ' + r.name + '’s approved ' + label('REQUEST_LABELS', r.kind).toLowerCase() + '?', sub: reqDates(r),
      okText: 'Cancel it', cancelText: 'Keep it', danger: true, busyText: 'Cancelling…',
      body: '<p class="ops-dialog-msg">' + esc(what) + '</p>' +
        field('Note (required — they will read it)', '<textarea data-hr-f="note" maxlength="300" rows="3"></textarea>'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var note = val(root, '[data-hr-f="note"]');
        if (!note) return "Say why you're cancelling it.";
        return need('hrRequestCancel').hrRequestCancel(r.id, note).then(function (res) {
          refreshAfterWrite();
          if (res && res.ok === false && res.reason === 'decided') {
            toast('It was already ' + label('REQUEST_STATUS', res.status).toLowerCase() + (res.by ? ' by ' + res.by : '') + '.', 'warning', 8000);
            return true;
          }
          toast('Cancelled.', 'success');
          return true;
        });
      }
    });
  }

  function editRosterCell(email, day) {
    var e = lower(email);
    var who = whoKey();
    var rd = rosterData();
    var x = rosterDuty(rd, e, day);
    var c = x.set ? x.cell : null;
    var cur = c && c.duty ? c.duty : '';
    // What "Default" means here: the day without anyone's roster entry.
    var dflt = rd.holidays[day] ? 'off — holiday' : (!x.set && x.why === 'weekly off') ? 'off — weekly off'
      : (x.set ? 'shop, or off on a weekly off or holiday' : 'shop');
    var opts = [['', 'Default (' + dflt + ')']]
      .concat(((F() && F().DUTIES) || []).map(function (k) { return [k, label('DUTY_LABELS', k)]; }));
    dialog({
      title: nameOf(e) + ' — ' + dayLabel(day, today()), sub: 'Duty for the day', okText: 'Save', busyText: 'Saving…',
      body: '<div class="hr-radios" role="radiogroup" aria-label="Duty">' + opts.map(function (o) {
          return '<label class="ops-check"><input type="radio" name="hr-duty" value="' + o[0] + '"' + (o[0] === cur ? ' checked' : '') + '> ' + esc(o[1]) + '</label>';
        }).join('') + '</div>' +
        (c && c.source_request_id ? '<p class="ops-hint">This day was set by an approved request. Saving here overrides it for this day.</p>' : '') +
        field('Note (optional)', '<input type="text" data-hr-f="note" maxlength="200" value="' + esc(c && c.note && !c.source_request_id ? c.note : '') + '">'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var pick = root.querySelector('input[name="hr-duty"]:checked');
        var duty = pick ? pick.value : '';
        return need('hrRosterSet').hrRosterSet(e, day, duty || null, val(root, '[data-hr-f="note"]') || null).then(function () {
          toast('Duty saved.', 'success');
          refreshAfterWrite();
          return true;
        });
      }
    });
  }
  // Holidays are for approvers, and a write like every other: off in demo mode.
  function holidaysWhyNot() { return !canApprove() ? NOT_APPROVER : (isDemo() ? DEMO_OFF : null); }
  function editHolidays() {
    var why = holidaysWhyNot();
    if (why) { toast(why, 'warning'); return; }
    var who = whoKey();
    var rd = rosterData();
    var w = st.v.rosterWeek;
    var list = Object.keys(rd.holidays).sort().map(function (d) { return '<li><b>' + esc(shortDay(d)) + '</b> ' + esc(rd.holidays[d]) + '</li>'; }).join('');
    dialog({
      title: 'Holidays', sub: 'A holiday is an off day for everyone (leave over it is not counted).', okText: 'Save', busyText: 'Saving…',
      body: (list ? '<p class="ops-hint">This week:</p><ul class="hr-visits">' + list + '</ul>' : '<p class="ops-hint">No holidays this week.</p>') +
        '<div class="ops-grid">' + field('Date', '<input type="date" data-hr-f="day" value="' + esc(w) + '">') +
        field('Name (leave empty to remove the holiday on that date)', '<input type="text" data-hr-f="name" maxlength="80" placeholder="e.g. Diwali">') + '</div>',
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var day = val(root, '[data-hr-f="day"]'), name = val(root, '[data-hr-f="name"]');
        if (!validDay(day)) return 'Choose the date.';
        return need('hrHolidaySet').hrHolidaySet(day, name || null).then(function () {
          toast(name ? 'Holiday saved: ' + name + ', ' + shortDay(day) + '.' : 'Holiday removed on ' + shortDay(day) + '.', 'success');
          refreshAfterWrite();
          return true;
        });
      }
    });
  }

  function taApprove(email) {
    var data = taData();
    if (!data) return;
    var r = data.rows.filter(function (x) { return x.email === lower(email); })[0];
    if (!r) return;
    var who = whoKey();
    var rate = r.rate != null ? r.rate : data.rate;
    dialog({
      title: 'Approve travel allowance for ' + r.name + '?', sub: monthLabel(data.month), okText: 'Approve', busyText: 'Approving…',
      body: '<p class="ops-dialog-msg">' + esc(fmtKm(r.km) + (data.trips ? ' trip km' : ' km') + ' × ' + money(rate) + ' = ' + money(r.amount != null ? r.amount : Math.round(num(r.km) * num(rate) * 100) / 100)) + '</p>' +
        '<p class="ops-hint">The km, rate and amount are kept as they are now. If the km changed since you opened this, nothing is approved and the report refreshes.</p>' +
        field('Note (optional)', '<input type="text" data-hr-f="note" maxlength="300">'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        return need('hrTaApprove').hrTaApprove(r.email, data.month, val(root, '[data-hr-f="note"]') || null, r.km).then(function (res) {
          refreshAfterWrite();
          if (res && res.ok === false) {
            if (res.reason === 'changed') { toast('The km changed since you opened this — check and approve again.', 'warning', 9000); return true; }
            if (res.reason === 'approved') { toast('Already approved' + (res.by ? ' by ' + res.by : '') + (res.at ? ' on ' + shortDate(res.at) : '') + '.', 'warning', 8000); return true; }
            return res.message || 'That did not go through. Refresh and try again.';
          }
          toast('Approved: ' + r.name + ', ' + fmtKm(res && res.km != null ? res.km : r.km) + ' km, ' + money(res && res.amount != null ? res.amount : r.amount) + '.', 'success');
          return true;
        });
      }
    });
  }
  function taUnapprove(email) {
    var data = taData();
    if (!data) return;
    var r = data.rows.filter(function (x) { return x.email === lower(email); })[0];
    if (!r) return;
    var who = whoKey();
    dialog({
      title: 'Take back the approval for ' + r.name + '?', sub: monthLabel(data.month), okText: 'Take it back', danger: true, busyText: 'Working…',
      body: field('Note (required — why)', '<textarea data-hr-f="note" maxlength="300" rows="3"></textarea>'),
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var note = val(root, '[data-hr-f="note"]');
        if (!note) return "Say why you're taking the approval back.";
        return need('hrTaUnapprove').hrTaUnapprove(r.email, data.month, note).then(function () {
          toast('Approval taken back.', 'success');
          refreshAfterWrite();
          return true;
        });
      }
    });
  }

  function weeklyOffBoxes(cur, attr) {
    var days = (F() && F().WEEKDAYS_LONG) || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return '<div class="hr-wo">' + days.map(function (n, i) {
      return '<label class="hr-wo-d"><input type="checkbox" ' + attr + '="' + i + '"' + (Array.isArray(cur) && cur.indexOf(i) !== -1 ? ' checked' : '') + '> ' + esc(n.slice(0, 3)) + '</label>';
    }).join('') + '</div>';
  }
  function readWeeklyOff(root, attr) {
    var out = [];
    root.querySelectorAll('[' + attr + ']').forEach(function (x) { if (x.checked) out.push(Number(x.getAttribute(attr))); });
    return out.sort(function (a, b) { return a - b; });
  }
  function sameArr(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
  function intOrNull(s) { if (s === '') return null; var n = Number(s); return isFinite(n) ? n : NaN; }

  function editSettings() {
    var s = settingsData();
    if (!s) return;
    var who = whoKey();
    var tmw = addDays(today(), 1);
    var picker = null;                       // the office map (v1.12.1)
    // The shift fields start from today's default, not the newest row (which
    // may be a change planned for later: said in the banner).
    var cur = defaultShift(today()) || {};
    var planned = defaultPlanned();
    var wo = Array.isArray(cur.weekly_off) ? cur.weekly_off.slice().sort(function (a, b) { return a - b; }) : [0];
    var numIn = function (k, v, min, max, step) {
      return '<input type="number" data-hr-s="' + k + '" value="' + esc(v == null ? '' : v) + '"' + (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') + ' step="' + (step || 1) + '">';
    };
    dialog({
      title: 'Office hours and tracking', okText: 'Save', busyText: 'Saving…', wide: true,
      body: (planned.length ? banner('Already planned: ' + planned.map(function (h, i) {
          return 'from ' + dayLabel(String(h.effective_from).slice(0, 10), today()) + ', ' + plannedText(h, i ? planned[i - 1] : cur);
        }).join('; ') + '. A change you save from an earlier date lasts until then.', 'info') : '') +
        '<div class="ops-section-title">Shift (applies from the date below)</div><div class="ops-grid">' +
          field('Shift starts', '<input type="time" data-hr-s="shift_start" value="' + esc(hhmm(cur.shift_start)) + '">') +
          field('Shift ends', '<input type="time" data-hr-s="shift_end" value="' + esc(hhmm(cur.shift_end)) + '">') +
          field('Grace (minutes)', numIn('grace_min', cur.grace_min, 0, 120)) +
          field('Half-day threshold (minutes worked)', numIn('half_day_min', cur.half_day_min, 60, 600)) +
          field('Weekly off', weeklyOffBoxes(wo, 'data-hr-wo'), 'ops-span2') +
          field('Effective from', '<input type="date" data-hr-s="effective_from" value="' + esc(tmw) + '" min="' + esc(today()) + '">') +
        '</div><div class="ops-section-title">Tracking (from each phone’s next punch-in or break end)</div><div class="ops-grid">' +
          field('A point every (seconds)', numIn('track_interval_s', s.track_interval_s, 30, 600)) +
          field('…or every (metres)', numIn('track_distance_m', s.track_distance_m, 25, 1000)) +
          field('Keep route points (days)', numIn('retention_days', s.retention_days, 30, 365)) +
          field('Longest shift (hours)', numIn('max_session_h', s.max_session_h != null ? s.max_session_h : 16, 4, 24)) +
        '</div><div class="ops-section-title">Travel allowance and the office</div>' +
        // v1.12.1: the office point on a map, on top of the number fields.
        '<div class="hr-pick-wrap"><div class="hr-pick" data-hr-pick role="region" aria-label="Office location map"></div>' +
          '<p class="ops-hint">Click the map, or drag the pin, to the shop’s entrance. The circle is the radius: a punch inside it counts as at the shop. ' +
          'The fields below follow the pin, and the pin follows them.</p></div>' +
        '<div class="ops-grid">' +
          field('Rate per km (₹; empty = not set)', numIn('ta_rate_per_km', s.ta_rate_per_km, 0, null, '0.01')) +
          field('Office radius (metres)', numIn('office_radius_m', s.office_radius_m, 50, 2000)) +
          field('Office latitude', numIn('office_lat', s.office_lat, -90, 90, 'any')) +
          field('Office longitude', numIn('office_lng', s.office_lng, -180, 180, 'any')) +
        '</div>',
      onOpen: function (root) { picker = officePicker(root, s); },
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var p = {};
        var shiftChanged = false;
        ['shift_start', 'shift_end'].forEach(function (k) {
          var v = val(root, '[data-hr-s="' + k + '"]');
          if (v && v !== hhmm(cur[k])) { p[k] = v; shiftChanged = true; }
        });
        ['grace_min', 'half_day_min'].forEach(function (k) {
          var v = intOrNull(val(root, '[data-hr-s="' + k + '"]'));
          if (v != null && v !== numOrNull(cur[k])) { p[k] = v; shiftChanged = true; }
        });
        var w = readWeeklyOff(root, 'data-hr-wo');
        if (!sameArr(w, wo)) { p.weekly_off = w; shiftChanged = true; }
        ['track_interval_s', 'track_distance_m', 'retention_days', 'max_session_h', 'office_radius_m'].forEach(function (k) {
          var v = intOrNull(val(root, '[data-hr-s="' + k + '"]'));
          var old = numOrNull(s[k]);
          if (k === 'max_session_h' && old == null) old = 16;
          if (v != null && v !== old) p[k] = v;
        });
        ['ta_rate_per_km', 'office_lat', 'office_lng'].forEach(function (k) {
          var raw = val(root, '[data-hr-s="' + k + '"]');
          var v = intOrNull(raw);
          var old = numOrNull(s[k]);
          if (raw === '' && old != null) p[k] = null;
          else if (raw !== '' && v !== old) p[k] = v;
        });
        if (shiftChanged) {
          var eff = val(root, '[data-hr-s="effective_from"]');
          if (!validDay(eff)) return 'Choose the date the new hours apply from.';
          if (eff < today()) return 'Changes apply from today onwards.';
          p.effective_from = eff;
        }
        if (!Object.keys(p).length) return 'Nothing changed.';
        // The office point is one setting: the server reads both halves together.
        if ('office_lat' in p || 'office_lng' in p) {
          if (!('office_lat' in p)) p.office_lat = numOrNull(s.office_lat);
          if (!('office_lng' in p)) p.office_lng = numOrNull(s.office_lng);
          if ((p.office_lat == null) !== (p.office_lng == null)) return 'The office point needs both a latitude and a longitude.';
        }
        // The server merges the change into the default row in force on
        // effective_from and checks that: so does this.
        var base = defaultShift(p.effective_from || today()) || cur;
        var bad = F() ? F().checkSettings(p, { shift_start: hhmm(base.shift_start), shift_end: hhmm(base.shift_end) }) : null;
        if (bad) return bad;
        return need('hrSettingsSet').hrSettingsSet(p).then(function () {
          toast('HR settings saved' + (shiftChanged ? ' — the new hours apply from ' + shortDay(p.effective_from) + '.' : '.'), 'success');
          refreshAfterWrite();
          return true;
        });
      }
    }).then(function () { if (picker) picker.remove(); picker = null; }, function () { if (picker) picker.remove(); picker = null; });
  }

  // The office point picker (Leaflet + OSM, in the settings dialog): click
  // the map or drag the pin; the radius circle follows the radius field.
  // The number fields stay the source of truth for Save. → {remove} | null.
  function officePicker(root, s) {
    var host = root.querySelector('[data-hr-pick]');
    var L = window.L;
    if (!host) return null;
    if (!L || typeof L.map !== 'function') {
      host.classList.add('hr-map-off');
      host.textContent = 'The map could not load. Type the latitude and longitude below instead.';
      return null;
    }
    var latIn = root.querySelector('[data-hr-s="office_lat"]'), lngIn = root.querySelector('[data-hr-s="office_lng"]');
    var radIn = root.querySelector('[data-hr-s="office_radius_m"]');
    var lat0 = numOrNull(s.office_lat), lng0 = numOrNull(s.office_lng);
    var map = L.map(host, { zoomControl: true, attributionControl: true, minZoom: 3, maxZoom: 19 });
    map.attributionControl.setPrefix(LEAFLET_PREFIX);
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    var radius = function () { var r = numOrNull(radIn && radIn.value); return r != null && r >= 50 && r <= 2000 ? r : num(s.office_radius_m, 150); };
    var pin = null, ring = null;
    function place(lat, lng, pan) {
      var ll = [lat, lng];
      if (!pin) {
        pin = L.marker(ll, { draggable: true, keyboard: true, title: 'The office', alt: 'The office',
          icon: L.divIcon({ className: 'hr-pin', html: '', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
        ring = L.circle(ll, { radius: radius(), color: '#e11d74', weight: 2, fillColor: '#e11d74', fillOpacity: 0.12, interactive: false }).addTo(map);
        pin.on('drag', function () { var p = pin.getLatLng(); ring.setLatLng(p); });
        pin.on('dragend', function () { var p = pin.getLatLng(); write(p.lat, p.lng); });
      } else {
        pin.setLatLng(ll); ring.setLatLng(ll);
      }
      if (pan) map.setView(ll, Math.max(map.getZoom() || 0, 17), { animate: false });
    }
    function write(lat, lng) {
      if (latIn) latIn.value = lat.toFixed(6);
      if (lngIn) lngIn.value = lng.toFixed(6);
    }
    function readInputs(pan) {
      var la = numOrNull(latIn && latIn.value), ln = numOrNull(lngIn && lngIn.value);
      if (la == null || ln == null || Math.abs(la) > 90 || Math.abs(ln) > 180) return;
      place(la, ln, pan);
    }
    map.on('click', function (ev) { place(ev.latlng.lat, ev.latlng.lng, false); write(ev.latlng.lat, ev.latlng.lng); });
    if (latIn) latIn.addEventListener('change', function () { readInputs(true); });
    if (lngIn) lngIn.addEventListener('change', function () { readInputs(true); });
    if (radIn) radIn.addEventListener('input', function () { if (ring) ring.setRadius(radius()); });
    if (lat0 != null && lng0 != null) { map.setView([lat0, lng0], 17); place(lat0, lng0, false); }
    else { var c = defaultCenter(); map.setView(c.c, c.z); }
    // The attribution links open in the system browser, never in the app window.
    host.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^https:\/\/(www\.openstreetmap\.org|leafletjs\.com)(\/|$)/.test(href)) openUrl(href, 'that page');
    });
    // The dialog is still opening: size the map once it has its size, and
    // centre it again on the pin until the person moves the map themselves.
    var touched = false;
    ['mousedown', 'wheel', 'touchstart', 'keydown'].forEach(function (k) { host.addEventListener(k, function () { touched = true; }, { passive: true }); });
    [60, 320, 700].forEach(function (ms) {
      setTimeout(function () {
        try {
          map.invalidateSize(false);
          if (touched) return;
          if (pin) map.setView(pin.getLatLng(), map.getZoom(), { animate: false });
          else { var c2 = defaultCenter(); map.setView(c2.c, c2.z, { animate: false }); }
        } catch (e) { /* closed */ }
      }, ms);
    });
    return { remove: function () { try { map.remove(); } catch (e) { /* already gone */ } } };
  }

  function editPerson(email) {
    var e = lower(email);
    var p = staffRows().filter(function (x) { return lower(x.email) === e; })[0];
    if (!p) return;
    var s = defaultShift(today()) || {};       // the office default in force today
    var pr = personRow(e);
    var known = !!pr;
    pr = pr || {};
    var who = whoKey();
    var tmw = addDays(today(), 1);
    var customWo = Array.isArray(pr.weekly_off);
    var next = (pr.upcoming || [])[0];
    var sw = function (k, on, text) { return '<label class="ops-check"><input type="checkbox" data-hr-p="' + k + '"' + (on ? ' checked' : '') + '> ' + esc(text) + '</label>'; };
    dialog({
      title: (p.full_name || p.email), sub: 'Hours and NeoHR settings for this person', okText: 'Save', busyText: 'Saving…', wide: true,
      body: (known ? '' : banner('Their current settings could not be read; only what you change here is saved.', 'warn')) +
        (next && next.effective_from ? banner('A change of hours is already planned from ' + shortDay(String(next.effective_from).slice(0, 10)) +
          '. Saving hours for that same date replaces it.', 'info') : '') +
        '<div class="ops-section-title">Hours (empty = the office default ' + esc((hhmm(s.shift_start) || '—') + '–' + (hhmm(s.shift_end) || '—')) + ')</div><div class="ops-grid">' +
          field('Shift starts', '<input type="time" data-hr-p="shift_start" value="' + esc(hhmm(pr.shift_start)) + '">') +
          field('Shift ends', '<input type="time" data-hr-p="shift_end" value="' + esc(hhmm(pr.shift_end)) + '">') +
          field('Grace (minutes)', '<input type="number" data-hr-p="grace_min" min="0" max="120" value="' + esc(pr.grace_min == null ? '' : pr.grace_min) + '" placeholder="' + esc(s.grace_min == null ? '' : s.grace_min) + '">') +
          field('Half-day threshold (minutes)', '<input type="number" data-hr-p="half_day_min" min="60" max="600" value="' + esc(pr.half_day_min == null ? '' : pr.half_day_min) + '" placeholder="' + esc(s.half_day_min == null ? '' : s.half_day_min) + '">') +
          '<div class="ops-span2">' + sw('wo_custom', customWo, 'Their own weekly off (otherwise the office default: ' + ((F() && F().weeklyOffText(s.weekly_off)) || 'Sunday') + ')') +
            weeklyOffBoxes(customWo ? pr.weekly_off : (Array.isArray(s.weekly_off) ? s.weekly_off : [0]), 'data-hr-pwo') + '</div>' +
          field('Effective from', '<input type="date" data-hr-p="effective_from" value="' + esc(tmw) + '" min="' + esc(today()) + '">') +
        '</div><div class="ops-section-title">NeoHR</div>' +
        sw('attendance_required', pr.attendance_required !== false, 'Attendance required (off = never late or absent)') +
        sw('track_location', pr.track_location !== false, 'Field staff (route, trips and travel allowance)') +
        sw('ta_eligible', pr.ta_eligible !== false && pr.track_location !== false, 'Eligible for travel allowance (field staff only)') +
        '<p class="ops-hint">Field staff are the engineers who go out on site. Their phone records a route while they are on duty. Everyone else is checked at the shop when they punch in and out.</p>',
      onOpen: function (root) {
        // Field staff on → travel allowance on too (and off → off), as the
        // server does when only the field switch is sent.
        var fs = root.querySelector('[data-hr-p="track_location"]'), ta = root.querySelector('[data-hr-p="ta_eligible"]');
        var sync = function () { if (ta) { ta.checked = !!fs.checked; ta.disabled = !fs.checked; } };
        if (fs && ta) { ta.disabled = !fs.checked; fs.addEventListener('change', sync); }
      },
      onOk: function (root) {
        if (!stillMe(who)) return GONE;
        var out = {};
        var shiftChanged = false;
        ['shift_start', 'shift_end'].forEach(function (k) {
          var v = val(root, '[data-hr-p="' + k + '"]');
          var old = hhmm(pr[k]);
          if (v !== old) { out[k] = v || null; shiftChanged = true; }
        });
        ['grace_min', 'half_day_min'].forEach(function (k) {
          var v = intOrNull(val(root, '[data-hr-p="' + k + '"]'));
          var old = numOrNull(pr[k]);
          if (v !== old) { out[k] = v; shiftChanged = true; }
        });
        var custom = checked(root, '[data-hr-p="wo_custom"]');
        var wo = custom ? readWeeklyOff(root, 'data-hr-pwo') : null;
        if (custom !== customWo || (custom && !sameArr(wo, pr.weekly_off.slice().sort(function (a, b) { return a - b; })))) { out.weekly_off = wo; shiftChanged = true; }
        ['attendance_required', 'track_location', 'ta_eligible'].forEach(function (k) {
          var on = checked(root, '[data-hr-p="' + k + '"]');
          if (on !== (pr[k] !== false)) out[k] = on;
        });
        if (shiftChanged) {
          var eff = val(root, '[data-hr-p="effective_from"]');
          if (!validDay(eff)) return 'Choose the date the new hours apply from.';
          if (eff < today()) return 'Changes apply from today onwards.';
          out.effective_from = eff;
        }
        if (!Object.keys(out).length) return 'Nothing changed.';
        // As the server checks it: their row in force on effective_from, each
        // empty field (and a field cleared here) from the default that day.
        var effDay = out.effective_from || today();
        var pb = personShiftOn(e, effDay), db = defaultShift(effDay) || {};
        var chk = Object.assign({}, out);
        ['shift_start', 'shift_end'].forEach(function (k) { if (k in chk && chk[k] == null) chk[k] = hhmm(db[k]) || null; });
        var bad = F() ? F().checkSettings(chk, { shift_start: hhmm(pb.shift_start), shift_end: hhmm(pb.shift_end) }) : null;
        if (bad) return bad;
        return need('hrPersonSet').hrPersonSet(e, out).then(function () {
          toast('Saved for ' + (p.full_name || p.email) + '.', 'success');
          refreshAfterWrite();
          return true;
        });
      }
    });
  }

  // ── events ────────────────────────────────────────────────────────────────
  function setTab(tab) {
    if (tab === 'team') { st.v.liveView = 'load'; tab = 'live'; }
    if (tab === 'activity') { st.v.logsView = 'activity'; tab = 'logs'; }
    if (!visibleTabs().some(function (t) { return t.id === tab; })) return;
    st.tab = tab;
    writePrefs();
    st.filterSig = null;
    render();
    loadTab(false);
    syncTimer();
    if (tab === 'routes') setTimeout(function () { if (st.map) { try { st.map.invalidateSize(); } catch (e) { /* gone */ } } }, 0);
  }
  function showPerson(email, tab) {
    st.person = lower(email);
    if (tab === 'logs') { st.preset = 'today'; st.search = ''; st.v.logsView = 'logs'; }
    if (tab === 'activity') st.v.logsView = 'activity';
    setTab('logs');
  }
  // tripId (v1.12.1): show that trip's part of the route.
  function showRoute(email, day, tripId) {
    st.v.routePerson = lower(email);
    if (validDay(day)) st.v.routeDay = day;
    st.v.routeTrip = tripId ? String(tripId) : '';
    st.mapKey = null;
    setTab('routes');
  }
  function routePeople() {
    var cur = st.v.routePerson;
    return knownPeople().filter(function (p) { return p.email === cur || showsRoute(p.email); });
  }

  function onBodyClick(e) {
    var b = e.target.closest('[data-hr-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-hr-act');
    var em = b.getAttribute('data-hr-email');
    var day = b.getAttribute('data-hr-day');
    if (act === 'tab') { setTab(b.getAttribute('data-hr-to')); return; }
    if (act === 'person-logs') { showPerson(em, 'logs'); return; }
    if (act === 'person-act') { showPerson(em, 'activity'); return; }
    if (act === 'live-filter') { st.v.liveFilter = b.getAttribute('data-hr-status') || 'all'; render(); return; }
    if (act === 'open-day') { openDay(em, day); return; }
    if (act === 'correct') { openDay(em, day, { correct: true }); return; }
    if (act === 'open-route') { showRoute(em, day); return; }
    if (act === 'req-approve') { decideRequest(b.getAttribute('data-hr-id'), true); return; }
    if (act === 'req-reject') { decideRequest(b.getAttribute('data-hr-id'), false); return; }
    if (act === 'req-cancel') { cancelRequest(b.getAttribute('data-hr-id')); return; }
    if (act === 'photo') { openPhoto(b); return; }
    if (act === 'route-trip') {
      var tid = b.getAttribute('data-hr-trip') || '';
      st.v.routeTrip = st.v.routeTrip === tid ? '' : tid;
      render();
      return;
    }
    if (act === 'roster-cell') { editRosterCell(em, day); return; }
    if (act === 'ta-approve') { taApprove(em); return; }
    if (act === 'ta-unapprove') { taUnapprove(em); return; }
    if (act === 'ta-expand') { if (st.v.taOpen[em]) delete st.v.taOpen[em]; else st.v.taOpen[em] = true; render(); return; }
    if (act === 'settings-edit') { editSettings(); return; }
    if (act === 'person-edit') { editPerson(em); return; }
    if (act === 'more') {
      var id = b.getAttribute('data-hr-id');
      if (st.openLogs[id]) delete st.openLogs[id]; else st.openLogs[id] = true;
      render();
      return;
    }
    if (act === 'expand') {
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
    if (st.tab !== 'logs') { render(); return; }
    if (st.v.logsView === 'activity') loadAct(); else loadLogs();
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
      if (st.v.logsView === 'logs') loadLogs(); else render();
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

  // The per-tab control bar.
  function stepDay(day, n) { var t = today(), d = addDays(validDay(day) ? day : t, n); return d > t ? t : d; }
  function onControlsClick(e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    var v = st.v, t = today();
    if (b.hasAttribute('data-hr-live-view')) { v.liveView = b.getAttribute('data-hr-live-view'); writePrefs(); render(); loadLive(); syncTimer(); return; }
    if (b.hasAttribute('data-hr-reg-view')) { v.regView = b.getAttribute('data-hr-reg-view'); writePrefs(); render(); loadReg(); return; }
    if (b.hasAttribute('data-hr-req-scope')) { v.reqScope = b.getAttribute('data-hr-req-scope'); render(); loadRequests(); return; }
    if (b.hasAttribute('data-hr-logs-view')) { v.logsView = b.getAttribute('data-hr-logs-view'); writePrefs(); st.filterSig = null; render(); loadTab(false); return; }
    var c = b.getAttribute('data-hr-ctl');
    if (!c) return;
    if (c === 'reg-prev' || c === 'reg-next' || c === 'reg-now') {
      var dir = c === 'reg-prev' ? -1 : c === 'reg-next' ? 1 : 0;
      if (v.regView === 'month') {
        var m = dir ? addMonths(v.regMonth, dir) : monthStart(t);
        v.regMonth = m > monthStart(t) ? monthStart(t) : m;
      } else v.regDay = dir ? stepDay(v.regDay, dir) : t;
      render(); loadReg(); return;
    }
    if (c === 'reg-csv') { exportRegister(); return; }
    if (c === 'roster-prev' || c === 'roster-next' || c === 'roster-now') {
      v.rosterWeek = c === 'roster-now' ? weekStart(t) : addDays(v.rosterWeek, c === 'roster-prev' ? -7 : 7);
      render(); loadRoster(); return;
    }
    if (c === 'holidays') { editHolidays(); return; }
    if (c === 'route-prev' || c === 'route-next' || c === 'route-now') {
      v.routeDay = c === 'route-now' ? t : stepDay(v.routeDay, c === 'route-prev' ? -1 : 1);
      v.routeTrip = '';
      render(); loadRoute(); return;
    }
    if (c === 'checks-prev' || c === 'checks-next' || c === 'checks-now') {
      v.checksDay = c === 'checks-now' ? t : stepDay(v.checksDay, c === 'checks-prev' ? -1 : 1);
      render(); loadChecks(); return;
    }
    if (c === 'ta-prev' || c === 'ta-next' || c === 'ta-now') {
      var tm = c === 'ta-now' ? addMonths(t, -1) : addMonths(v.taMonth, c === 'ta-prev' ? -1 : 1);
      v.taMonth = tm > monthStart(t) ? monthStart(t) : tm;
      render(); loadTa(); return;
    }
    if (c === 'ta-csv') { exportTa(); return; }
  }
  function onControlsChange(e) {
    var x = e.target;
    if (!x || !x.id) return;
    var v = st.v, t = today();
    var mv = /^\d{4}-\d{2}$/.test(String(x.value || '')) ? x.value + '-01' : null;
    if (x.id === 'hr-reg-day' && validDay(x.value)) { v.regDay = x.value > t ? t : x.value; render(); loadReg(); return; }
    if (x.id === 'hr-reg-month' && mv) { v.regMonth = mv > monthStart(t) ? monthStart(t) : mv; render(); loadReg(); return; }
    if (x.id === 'hr-reg-person') { v.regPerson = lower(x.value); render(); loadReg(); return; }
    if (x.id === 'hr-route-person') { v.routePerson = lower(x.value); v.routeTrip = ''; render(); loadRoute(); return; }
    if (x.id === 'hr-route-day' && validDay(x.value)) { v.routeDay = x.value > t ? t : x.value; v.routeTrip = ''; render(); loadRoute(); return; }
    if (x.id === 'hr-checks-day' && validDay(x.value)) { v.checksDay = x.value > t ? t : x.value; render(); loadChecks(); return; }
    if (x.id === 'hr-ta-month' && mv) { v.taMonth = mv > monthStart(t) ? monthStart(t) : mv; render(); loadTa(); return; }
  }
  function onControlsInput(e) {
    if (e.target && e.target.id === 'hr-live-search') { st.v.liveSearch = String(e.target.value || ''); render(); }
  }

  // ── timers ────────────────────────────────────────────────────────────────
  // Live and Requests refresh every minute while they are on show (Requests
  // since 1.12.1: punch reasons are due the same day).
  function timedTab() { return st.tab === 'live' || st.tab === 'requests'; }
  function syncTimer() {
    var want = active() && !!profile() && timedTab();
    if (want && !st.timer) {
      st.timer = setInterval(function () {
        if (!active() || !profile() || !timedTab()) { syncTimer(); return; }
        if (st.tab === 'requests') { loadRequests(); return; }
        loadBoard();
        loadPending();
        if (st.v.liveView === 'load') loadTeamToday();
        // Today's punches: only today's list changes.
        if (st.v.liveView === 'punches' && st.v.checksDay === today()) loadChecks();
      }, LIVE_REFRESH_MS);
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
      if (e.target.closest('#hr-controls')) { onControlsClick(e); return; }
      if (e.target.closest('#hr-map')) return;
      onBodyClick(e);
    });
    root.addEventListener('change', function (e) {
      if (e.target.closest('#hr-filters')) onFiltersChange(e);
      else if (e.target.closest('#hr-controls')) onControlsChange(e);
    });
    root.addEventListener('input', function (e) {
      if (e.target.closest('#hr-filters')) onFiltersInput(e);
      else if (e.target.closest('#hr-controls')) onControlsInput(e);
    });
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

  // Sign-out: everything this module holds goes (the map and the route
  // points first), and the timer stops.
  function reset() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    clearSession();
    st.who = null;
  }

  var wasActive = false;
  function boot() {
    var d = D();
    if (d && typeof d.on === 'function') {
      // A claim, offer or hand-back anywhere changes someone's load.
      try {
        d.on('work', function () {
          if (!active() || !profile() || st.tab !== 'live' || st.v.liveView !== 'load') return;
          if (st.workTimer) clearTimeout(st.workTimer);
          st.workTimer = setTimeout(function () {
            st.workTimer = null;
            if (active() && profile() && st.tab === 'live') run('team', 'team', function () { return need('workTeam').workTeam(); });
          }, 1000);
        });
        // An HR write from anywhere (another dialog, the data layer): re-read the tab.
        d.on('hr', function () { if (active() && profile()) refreshAfterWrite(); });
      } catch (e) { console.warn('[neohr] cannot listen for changes:', e && e.message); }
    }
    window.addEventListener('neo-modules-changed', function () {
      if (!profile()) { reset(); return; }
      bindWho();
      if (active()) render();
    });
    // The screen switches away without telling us: the observer stops the
    // Live timer, and drops the map and the route points, when #neohr-screen
    // is no longer active.
    var scr = el('neohr-screen');
    if (scr && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        syncTimer();
        var now = active();
        if (wasActive && !now) {
          forgetRoute();
          var body = el('hr-body');
          if (body && body.dataset.view === 'routes') { body.textContent = ''; body.dataset.view = ''; }
        }
        if (now && st.tab === 'routes' && st.map) { try { st.map.invalidateSize(); } catch (e) { /* gone */ } }
        wasActive = now;
      }).observe(scr, { attributes: true, attributeFilter: ['class'] });
      wasActive = active();
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
    showRoute: showRoute,
    openDay: openDay,
    isActive: active,
    _state: function () { return st; },
    _pure: { istDay: istDay, addDays: addDays, spanDays: spanDays, istHm: istHm, dayLabel: dayLabel, sumRows: sumRows }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
