/*
  Neo Tokyo Operations — Service v2: the board, the queue, the visits list and
  the job panel. Loaded after app.js, modules.js, ops-ui.js, ops-data.js,
  photo-tray.js and service-intake.js, so it can use showToast, showConfirm,
  escapeHtmlLite and openTicketModal from the shared script scope.

  WHAT CHANGED FROM v1.9.11
  This file no longer talks to Supabase. Every read and write goes through
  window.NeoQcData (ops-data.js), which owns the caches, the realtime channel
  and the RPCs. The reason is the same one that put the status rules in
  shared/service-status.js: two copies of "how a ticket moves" drift. v1.9.11
  wrote stage changes with a bare UPDATE and a separate event INSERT, so a
  failed second request left a move the customer never heard about; the server
  RPCs now do both in one transaction, check the stage has not moved under us,
  and refuse moves the RMA module owns.

  The ticket is no longer only a counter job. It has a type (in-store, on-site,
  remote), a queue (nobody owns it until a technician claims it or a lead
  assigns it), items (one row per thing the customer left with us) and RMA
  units (a part sent under warranty, which the ticket can wait on).

  THE RULES THIS FILE LIVES BY — all inherited from v1, all still load-bearing:

  1. Identity race. Every async handler that acts on "the open ticket" binds
     `var jobId = openJobId` on its FIRST line and never reads openJobId again
     except to ask "is the panel still showing this ticket?" before painting.
     The panel can be closed or pointed at another customer while a request is
     in flight; a v1 review found photos landing in another customer's job and
     one customer's stage change published on another customer's tracking page.

  2. Diff, don't blind-write. The Details form remembers what it was painted
     FROM (formBase) and saves only the columns the user changed, so two people
     editing different fields of one ticket do not undo each other. jsonb
     columns are never written from here.

  3. Header-only repaint. Realtime and our own writes repaint the header, the
     action row and the read-only parts of a tab. They never rebuild a form the
     user may be typing into — v1 once discarded a half-written move note.

  4. Scanner safety. A barcode scanner types like a keyboard and finishes with
     Enter. Enter inside an input never submits or closes anything here.

  5. Untrusted text (names, faults, notes, addresses) only reaches the DOM
     through esc() inside element content or double-quoted attributes, or
     through textContent. Never inside single-quoted attributes or inline JS.
*/
(function () {
  'use strict';

  var HOUR = 3600000, MIN = 60000;
  var TRACK_BASE = 'https://neoqctracker.netlify.app/?view=service&code=';
  var DEMO_MSG = 'Demo data is read-only. Turn it off in Settings to work on real tickets.';
  var RANK = { desk: 1, tech: 2, lead: 3 };
  var TYPE_KEYS = ['in_store', 'on_site', 'remote'];
  var CHANNEL_KEYS = ['walk_in', 'phone', 'whatsapp', 'website', 'courier', 'staff'];
  var PRI_KEYS = ['low', 'normal', 'high', 'urgent'];
  var BALLS = ['shop', 'customer', 'third_party', 'nobody'];
  // The stages where the RMA sync acts on a ticket (SPEC §2.6 step 3). A part
  // may only hold the ticket while it is in one of these (SPEC-AMENDMENTS A4).
  var SYNC_ZONE = ['logged', 'received', 'diagnosing', 'rma_raised', 'at_vendor', 'back_from_vendor', 'revisit_needed', 'on_site'];
  var EVENT_KINDS = {
    stage: 'Stage', note: 'Note', edit: 'Edit', media: 'Photos', claim: 'Claim',
    release: 'Release', assign: 'Assign', field: 'Field', rma: 'RMA',
    suggest: 'Suggest', priority: 'Priority', offer: 'Offer'
  };
  var VIA = { claim: 'took it from the queue', manager: 'assigned by a lead', auto: 'offered by the app', legacy: 'assigned', self: 'took it at intake' };
  var NO_POOLS = { build: false, service: false, level: null };
  // The release dialog's one choice on a closed ticket: the part goes on by
  // itself and the ticket stays closed. Never a stage key; sent as no target.
  var RELEASE_ONLY = 'release_only';
  var CHECKOUT = [
    { value: 'done', label: 'Done' },
    { value: 'revisit_needed', label: 'Revisit needed' },
    { value: 'parts_needed', label: 'Parts needed' },
    { value: 'customer_absent', label: 'Customer absent' }
  ];
  var WA_ITEMS = [
    { key: 'created',          label: 'Ticket created',      types: ['in_store', 'on_site', 'remote'] },
    { key: 'quote',            label: 'Send a quote…',       types: ['in_store', 'on_site', 'remote'] },
    { key: 'visit_booked',     label: 'Visit booked',        types: ['on_site', 'remote'], needsVisit: true },
    { key: 'on_the_way',       label: 'On the way',          types: ['on_site'] },
    { key: 'ready',            label: 'Ready to collect',    types: ['in_store'] },
    { key: 'reminder_collect', label: 'Reminder to collect', types: ['in_store'] }
  ];
  // Labels the status model owns. These copies are only used if it failed to
  // load, so the screen degrades to plain words rather than throwing.
  var FALLBACK = {
    TYPES: { in_store: { label: 'In-store' }, on_site: { label: 'On-site' }, remote: { label: 'Remote' } },
    CHANNELS: { walk_in: 'Walk-in', phone: 'Phone', whatsapp: 'WhatsApp', website: 'Website', courier: 'Courier', staff: 'Staff' },
    CATEGORIES: {
      repair: 'Repair', warranty_claim: 'Warranty claim', upgrade: 'Upgrade', installation: 'Installation',
      data_recovery: 'Data recovery', os_software: 'OS / software', networking: 'Networking',
      maintenance: 'Maintenance', diagnosis_only: 'Diagnosis only'
    },
    PRIORITIES: {
      low: { label: 'Low', rank: 0 }, normal: { label: 'Normal', rank: 1 },
      high: { label: 'High', rank: 2 }, urgent: { label: 'Urgent', rank: 3 }
    },
    ITEM_KINDS: {
      pc: 'Desktop PC', laptop: 'Laptop', gpu: 'Graphics card', psu: 'Power supply', ram: 'RAM', ssd: 'SSD',
      hdd: 'Hard drive', motherboard: 'Motherboard', cpu: 'Processor', cooler: 'Cooler', monitor: 'Monitor',
      peripheral: 'Peripheral', other: 'Other'
    },
    PURCHASE_SOURCES: { neo_tokyo: 'Neo Tokyo', elsewhere: 'Bought elsewhere', unknown: 'Not sure' },
    // The shop never backs up data (sql/service-v2.1.sql): the first three are
    // the answers offered, the last two the 1.10.0-beta.1 ones, still valid.
    DATA_CONSENTS: {
      customer_backed_up: 'Customer backed up their data', no_important_data: 'No important data on it',
      customer_accepts_risk: 'Customer accepts the risk — no backup',
      backup_ok: 'Back up first (old option)', no_backup: 'No backup needed (old option)'
    },
    DATA_CONSENT_CHOICES: ['customer_backed_up', 'no_important_data', 'customer_accepts_risk'],
    REMOTE_TOOLS: {
      anydesk: 'AnyDesk', teamviewer: 'TeamViewer', rustdesk: 'RustDesk',
      quick_assist: 'Quick Assist', chrome_remote: 'Chrome Remote Desktop', other: 'Other'
    },
    MIRROR_STAGES: ['rma_raised', 'at_vendor', 'back_from_vendor']
  };

  // ── state ──────────────────────────────────────────────────────────────────
  var view = readPref('neo_sv_view', 'board', ['board', 'queue', 'visits']);
  var typeFilter = readPref('neo_sv_type', 'all', ['all', 'in_store', 'on_site', 'remote']);
  var mineOnly = false;
  var query = '';
  var kpiFilter = null;           // 'late' | 'customer' | 'ready' | null
  var loadState = 'idle';         // idle | loading | ready | error
  var loadError = '';
  var refreshWarn = '';
  var subscribed = false;
  var boardTimer = null;
  var renderQueued = false;
  var searchTimer = null;

  var openJobId = null;
  var openSeq = 0;                // newest openJob call wins
  var closeEpoch = 0;             // bumped by a forced close (sign-out): late results stay quiet
  var jobTab = 'details';
  var formBase = null;            // what the Details form was painted FROM
  var visitBase = null;           // what the Visit tab's time inputs were painted FROM
  var itemEditId = null;          // the one item being edited inline
  var itemBase = null;
  var waMenuOpen = false;
  var moveBusy = false;
  var saveBusy = false;
  var fieldBusy = false;
  var noteBusy = false;
  var claiming = {};              // jobId -> true while a claim is in flight
  var responding = {};            // jobId -> true while an accept / decline / offer / withdraw is in flight
  var tickTimer = null;           // the 1 s offer countdown, only while a countdown is on screen
  var lastFieldFail = null;       // the last field press that failed, for a safe retry
  var photoTray = null, photoTrayJobId = null, uploadBusy = false;
  var retiredTrays = [];          // trays an upload still holds; destroyed after it
  var photoCounts = {};           // jobId -> { itemId: n }
  var tlSeq = 0, phSeq = 0, faSeq = 0;
  // The device password while it is on screen: { jobId, secret, timer }. The
  // ONLY place it is held, for 30 seconds at most; null the rest of the time.
  var pwShown = null;
  var pwBusy = false;
  var PW_SHOW_MS = 30000;
  var PW_MAX = 500;

  // ── small helpers ──────────────────────────────────────────────────────────
  function svc() { return (typeof window !== 'undefined' && window.NeoQcService) || null; }
  function D() { return window.NeoQcData || null; }
  function U() { return window.NeoQcUI || null; }
  function CAT() { return window.NeoQcCatalog || null; }
  function byId(id) { return document.getElementById(id); }

  function baseEsc(s) {
    var u = U();
    if (u && typeof u.esc === 'function') return String(u.esc(s));
    if (typeof escapeHtmlLite === 'function') return escapeHtmlLite(s);
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // escapeHtmlLite leaves single quotes alone. Nothing here puts text inside a
  // single-quoted attribute, but encoding them costs nothing and means a future
  // edit that does cannot become an injection.
  function esc(s) { return baseEsc(s == null ? '' : s).replace(/'/g, '&#39;'); }

  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  function readPref(k, d, allowed) {
    try { var v = localStorage.getItem(k); if (v && (!allowed || allowed.indexOf(v) !== -1)) return v; } catch (e) {}
    return d;
  }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function setText(id, t) { var e = byId(id); if (e) e.textContent = t == null ? '' : t; }
  function setStatus(id, msg, kind) {
    var n = byId(id);
    if (n) { n.textContent = msg || ''; n.className = 'sv-status' + (kind ? ' ' + kind : ''); }
  }
  function val(id) { var e = byId(id); return e ? String(e.value == null ? '' : e.value).trim() : ''; }
  function checked(id) { var e = byId(id); return !!(e && e.checked); }
  function nval(scope, sel) { var e = scope && scope.querySelector(sel); return e ? String(e.value == null ? '' : e.value).trim() : ''; }
  function nchecked(scope, sel) { var e = scope && scope.querySelector(sel); return !!(e && e.checked); }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  // A bare 'YYYY-MM-DD' (a purchase date) is a LOCAL calendar day; new Date()
  // would read it as UTC midnight and show the day before west of UTC.
  function ms(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    var t = dm ? new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).getTime() : new Date(v).getTime();
    return isNaN(t) ? null : t;
  }
  function nowIso() { return new Date().toISOString(); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  // SPEC-AMENDMENTS A1 (unified): the SQL norm_phone()/phone_ok() keep the
  // country code for Gulf and NRI customers. NeoQcCatalog owns the rule (the UI
  // kit delegates to it); the copy below is only for a partial load and must
  // stay identical to it:
  //   normalise — digits only; one leading '00' dropped; 10 digits → '91'+d;
  //               11 digits starting 0 → '91'+last 10; anything else as is.
  //   valid     — 12–15 digits, or 11 digits from Kuwait, Oman, Bahrain or
  //               Qatar (965/968/973/974: a 3-digit code plus 8 digits). An
  //               11-digit Indian typo is still refused.
  function normPhoneLocal(raw) {
    var d = digits(raw);
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(1);
    return d;
  }
  function phoneOkLocal(norm) {
    var n = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(n)) return false;
    if (n.length >= 12 && n.length <= 15) return true;
    return n.length === 11 && ['965', '968', '973', '974'].indexOf(n.slice(0, 3)) !== -1;
  }
  function validPhone(p) {
    var c = CAT();
    if (c && typeof c.isValidPhone === 'function') { try { return !!c.isValidPhone(p); } catch (e) {} }
    var u = U();
    if (u && typeof u.isValidPhone === 'function') { try { return !!u.isValidPhone(p); } catch (e) {} }
    return phoneOkLocal(normPhoneLocal(p));
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function uuid() {
    var d = D();
    if (d && typeof d.newRequestId === 'function') { try { var id = d.newRequestId(); if (id) return id; } catch (e) {} }
    var c = window.crypto || window.msCrypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  // Local midnight, offset by whole days. setDate rather than adding 24h so a
  // DST change cannot shift "today" by an hour on the machines that have one.
  function midnight(offsetDays) {
    var d = new Date(); d.setHours(0, 0, 0, 0);
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return d.getTime();
  }
  function lbl(map, key, fallback) {
    var v = map && key != null ? map[key] : null;
    if (v == null) return fallback != null ? fallback : (key || '');
    return typeof v === 'string' ? v : (v.label || v.staff || String(key));
  }
  function vocab(name) { var M = svc(); return (M && M[name]) || FALLBACK[name] || {}; }

  // ── errors ─────────────────────────────────────────────────────────────────
  function rawErr(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    return String(e.message || e.error_description || e.details || e.hint || '');
  }
  function isDemoErr(e) { return /DEMO_READONLY/.test(rawErr(e)); }
  function errCode(e) { var m = /(NEO_[A-Z_]+)\s*:/.exec(rawErr(e)); return m ? m[1] : ''; }
  // The server's NEO_ errors carry a human sentence after the colon; show that,
  // never the prefix and never a stack.
  function errMsg(e) {
    if (isDemoErr(e)) return DEMO_MSG;
    var u = U();
    if (u && typeof u.errText === 'function') {
      try { var t = u.errText(e); if (t) return String(t); } catch (x) {}
    }
    var raw = rawErr(e);
    var m = /NEO_[A-Z_]+\s*:\s*([\s\S]*)$/.exec(raw);
    if (m && m[1].trim()) return m[1].trim();
    return raw || 'Something went wrong. Try again.';
  }
  function demoToast(e) { if (isDemoErr(e)) toast(DEMO_MSG, 'warning'); }
  function isDemo() { var d = D(); try { return !!(d && typeof d.isDemo === 'function' && d.isDemo()); } catch (e) { return false; } }

  // ── formatting (local time, en-IN) ──────────────────────────────────────────
  function fmtDays(d) {
    var u = U();
    if (u && typeof u.fmtDays === 'function') { try { var s = u.fmtDays(d); if (s) return s; } catch (e) {} }
    if (d < 1) return Math.max(0, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }
  function fmtHours(h) {
    if (!(h > 0)) return '0m';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
    return fmtDays(h / 24);
  }
  function fmtMinutes(m) {
    m = Number(m);
    if (!m || m <= 0) return '';
    var h = Math.floor(m / 60), r = Math.round(m % 60);
    return h ? (h + 'h' + (r ? ' ' + r + 'm' : '')) : (r + 'm');
  }
  function fmtDate(iso) {
    var t = ms(iso);
    if (t == null) return '—';
    var d = new Date(t);
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-IN', opts);
  }
  function fmtTime(iso) {
    var t = ms(iso);
    if (t == null) return '';
    return new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtDateTime(iso) { return ms(iso) == null ? '—' : fmtDate(iso) + ', ' + fmtTime(iso); }
  function dayWord(iso) {
    var t = ms(iso);
    if (t == null) return '';
    if (t >= midnight(0) && t < midnight(1)) return 'today';
    if (t >= midnight(1) && t < midnight(2)) return 'tomorrow';
    if (t >= midnight(-1) && t < midnight(0)) return 'yesterday';
    return fmtDate(iso);
  }
  function whenShort(iso) { return ms(iso) == null ? '' : dayWord(iso) + ' ' + fmtTime(iso); }
  function fmtRange(s, e) {
    if (ms(s) == null) return e ? 'until ' + whenShort(e) : '';
    var out = whenShort(s);
    if (ms(e) != null) {
      var a = new Date(ms(s)), b = new Date(ms(e));
      out += (a.toDateString() === b.toDateString()) ? '–' + fmtTime(e) : ' – ' + whenShort(e);
    }
    return out;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  // Date-only inputs are LOCAL calendar days. toISOString() on an 18:00 IST
  // timestamp would roll back a day west of the date line and make every save
  // look like the promise moved.
  function dateInput(iso) {
    var t = ms(iso);
    if (t == null) return '';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayToIso(day) {
    if (!day) return null;
    var d = new Date(day + 'T18:00:00');          // end of the working day, local
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // datetime-local is LOCAL wall time with no offset. new Date('YYYY-MM-DDTHH:mm')
  // parses as local, which is exactly right; treating it as UTC would book
  // every visit five and a half hours late.
  function toLocalInput(iso) {
    var t = ms(iso);
    if (t == null) return '';
    var d = new Date(t);
    return dateInput(iso) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // ── access ─────────────────────────────────────────────────────────────────
  function role() {
    var d = D();
    if (!d || typeof d.role !== 'function') return null;
    try { return d.role('service') || null; } catch (e) { return null; }
  }
  function rmaRole() {
    var d = D();
    if (!d || typeof d.role !== 'function') return null;
    try { return d.role('rma') || null; } catch (e) { return null; }
  }
  function rank() { return RANK[role()] || 0; }
  function isLead() { return rank() >= 3; }
  function isTechPlus() { return rank() >= 2; }
  function isDeskPlus() { return rank() >= 1; }
  function me() {
    var d = D(), p = null;
    try { p = d && typeof d.me === 'function' ? d.me() : null; } catch (e) {}
    if (!p && typeof currentProfile !== 'undefined') p = currentProfile;
    return p || null;
  }
  function myEmail() { var p = me(); return lower(p && p.email); }
  function myName() { var p = me(); return (p && (p.full_name || p.email)) || ''; }
  function isMine(job) { var m = myEmail(); return !!(job && m && lower(job.assignee_email) === m); }
  function canOpenRma() {
    var m = window.NeoQcModules;
    if (m && typeof m.canOpen === 'function') { try { return !!m.canOpen('rma', me()); } catch (e) {} }
    return !!rmaRole();
  }
  function canOpenBuilds() {
    var m = window.NeoQcModules;
    if (m && typeof m.canOpen === 'function') { try { return !!m.canOpen('staff', me()); } catch (e) {} }
    var p = me();
    return !!(p && Number(p.tier) >= 3);
  }

  // ── the work queue (v1.11): pools and offers ───────────────────────────────
  // Claiming is for service-pool members (the server checks the same). Being a
  // lead does not put anyone in the pool; a lead offers work instead.
  function W() { return window.NeoQcWork || null; }
  function myPools() {
    var m = window.NeoQcModules;
    if (!m || typeof m.pools !== 'function') return NO_POOLS;
    try { return m.pools() || NO_POOLS; } catch (e) { return NO_POOLS; }
  }
  function inPool() { return myPools().service === true; }
  // The server's clock: every countdown runs on it (WQ-C11), from the offset
  // the data layer took from the last work_queue / work_team answer.
  function srvNow() {
    var d = D(), off = 0;
    try { off = (d && typeof d.workOffsetMs === 'function') ? (Number(d.workOffsetMs()) || 0) : 0; } catch (e) { off = 0; }
    return Date.now() + off;
  }
  function fmtLeft(msLeft) {
    var w = W();
    if (w && typeof w.fmtLeft === 'function') { try { return w.fmtLeft(msLeft); } catch (e) {} }
    var n = Number(msLeft);
    if (!(n > 0)) return '0s';
    if (n < MIN) return Math.floor(n / 1000) + 's';
    if (n < HOUR) return Math.floor(n / MIN) + 'm';
    var h = Math.floor(n / HOUR), m = Math.floor((n - h * HOUR) / MIN);
    return h + 'h ' + pad(m) + 'm';
  }
  // The live offer on a job (offered_to_email, 30 minutes to accept), or null
  // once it has run out — the server's tick then clears it.
  function liveOffer(job, now) {
    if (!job || !job.offered_to_email || job.stage === 'closed') return null;
    var exp = ms(job.offer_expires_at);
    if (exp == null || exp <= (now == null ? srvNow() : now)) return null;
    return {
      email: job.offered_to_email,
      name: job.offered_to_name || staffName(job.offered_to_email),
      kind: job.offer_kind || null,
      by: job.offer_by_name || null,
      reason: job.offer_reason || null,
      expires: job.offer_expires_at,
      expMs: exp
    };
  }
  function offeredToMe(job, now) {
    var o = liveOffer(job, now), m = myEmail();
    return !!(o && m && lower(o.email) === m);
  }
  function offerOther(job, now) {
    var o = liveOffer(job, now);
    return (o && !offeredToMe(job, now)) ? o : null;
  }
  function offerUntilText(o) {
    return 'Offered to ' + o.name + ' until ' + fmtTime(o.expires) + '.';
  }
  // Why the viewer cannot claim this queued job, or '' when they can. Desk
  // staff get the old "waiting" line from the callers instead.
  function noPoolText() {
    var w = W();
    var s = null;
    if (w && typeof w.whySentence === 'function') { try { s = w.whySentence('no_pool', 'service', true); } catch (e) { s = null; } }
    return s || "You aren't in the service pool.";
  }
  function claimWhy(job, now) {
    var o = offerOther(job, now);
    if (o) return offerUntilText(o);
    if (!isTechPlus()) return '';
    if (!inPool()) return noPoolText();
    return '';
  }
  function canClaim(job, now) {
    return !!job && inQueue(job) && isTechPlus() && inPool() && !offerOther(job, now) && !offeredToMe(job, now);
  }
  // "Offered to Amal · 18m left" — the minutes tick (1 s while on screen).
  function offerChipHtml(job, now) {
    var o = liveOffer(job, now);
    if (!o) return '';
    var mine = offeredToMe(job, now);
    var title = (o.kind === 'auto' ? 'Offered by the app' : o.by ? 'Offered by ' + o.by : 'Offered by a lead') +
      (o.reason ? ': ' + o.reason : '') + ' — until ' + fmtTime(o.expires);
    return '<span class="sv2-offer' + (mine ? ' mine' : '') + '" title="' + esc(title) + '">' +
      esc(mine ? 'Offered to you' : 'Offered to ' + o.name) + ' · <span class="sv2-offer-left" data-sv-countdown="' + esc(o.expires) + '">' +
      esc(fmtLeft(o.expMs - (now == null ? srvNow() : now))) + '</span> left</span>';
  }

  // ── data accessors (all reads come from NeoQcData's caches) ─────────────────
  function allJobs() {
    var d = D();
    if (!d || typeof d.jobs !== 'function') return [];
    try { return d.jobs() || []; } catch (e) { return []; }
  }
  function jobById(id) {
    if (!id) return null;
    var d = D();
    if (d && typeof d.job === 'function') { try { var j = d.job(id); if (j) return j; } catch (e) {} }
    var all = allJobs();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function itemsOf(jobId) {
    var d = D(), list = [];
    try { list = (d && typeof d.itemsOf === 'function' && d.itemsOf(jobId)) || []; } catch (e) {}
    return list.slice().sort(function (a, b) {
      if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? -1 : 1;
      return (Number(a.sort) || 0) - (Number(b.sort) || 0);
    });
  }
  function unitsOfJob(jobId) {
    var d = D(), list = [];
    try { list = (d && typeof d.unitsOfJob === 'function' && d.unitsOfJob(jobId)) || []; } catch (e) {}
    return list.slice();
  }
  function unitById(id) {
    var d = D();
    try { return (d && typeof d.unit === 'function' && d.unit(id)) || null; } catch (e) { return null; }
  }
  // Holding units: parts the ticket waits on. Only these move the ticket.
  function holdingUnits(jobId) {
    return unitsOfJob(jobId).filter(function (u) { return u.holds_ticket && u.stage !== 'closed'; });
  }
  function vendorOf(unit) {
    var d = D();
    if (!unit || unit.vendor_id == null || !d || typeof d.vendor !== 'function') return null;
    try { return d.vendor(unit.vendor_id) || null; } catch (e) { return null; }
  }
  function vendorName(unit) { var v = vendorOf(unit); return v ? (v.public_name || v.name || '') : ''; }
  function vendorsList() {
    var d = D(), list = [];
    try { list = (d && typeof d.vendors === 'function' && d.vendors()) || []; } catch (e) {}
    return list.filter(function (v) { return v && v.active !== false; })
               .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
  }
  function techList() {
    var d = D(), list = [];
    try { list = (d && typeof d.techs === 'function' && d.techs()) || []; } catch (e) {}
    return list.filter(function (t) { return t && t.email; });
  }
  function staffName(email) {
    if (!email) return '';
    var e = lower(email);
    var t = techList().find(function (x) { return lower(x.email) === e; });
    if (t && t.name) return t.name;
    var d = D(), staff = [];
    try { staff = (d && typeof d.staff === 'function' && d.staff()) || []; } catch (x) {}
    var p = staff.find(function (x) { return lower(x.email) === e; });
    if (p && p.full_name) return p.full_name;
    return String(email).split('@')[0];
  }

  // ── status-model wrappers (with plain fallbacks for a partial load) ─────────
  function typeOf(job) {
    var M = svc();
    if (M && typeof M.typeOf === 'function') { try { var t = M.typeOf(job); if (TYPE_KEYS.indexOf(t) !== -1) return t; } catch (e) {} }
    var s = job && job.service_type;
    return TYPE_KEYS.indexOf(s) !== -1 ? s : 'in_store';
  }
  function isV2(job) {
    var M = svc();
    if (M && typeof M.isV2 === 'function') { try { return !!M.isV2(job); } catch (e) {} }
    return Number(job && job.model_version) >= 2;
  }
  function inQueue(job) {
    var M = svc();
    if (M && typeof M.inQueue === 'function') { try { return !!M.inQueue(job); } catch (e) {} }
    return !!job && job.stage !== 'closed' && !job.assignee_email;
  }
  function isMirror(stage) {
    var M = svc();
    var list = (M && M.MIRROR_STAGES) || FALLBACK.MIRROR_STAGES;
    return list.indexOf(stage) !== -1;
  }
  function stageLabel(s) { var M = svc(); return M ? M.staffLabel(s) : (s || ''); }
  function riskOf(job, now) { var M = svc(); try { return M ? (M.serviceRisk(job, now) || 0) : 0; } catch (e) { return 0; } }
  function daysIn(obj, now) { var M = svc(); try { return M ? M.daysInStage(obj, now) : 0; } catch (e) { return 0; } }
  function ballCls(b) { return BALLS.indexOf(b) !== -1 ? b : 'shop'; }
  function ballOf(stage) { var M = svc(); return ballCls(M ? M.ballOf(stage) : 'shop'); }
  function queueAgeHours(job, now) {
    var t = ms(job && job.queued_at) || ms(job && job.created_at);
    return t == null ? 0 : Math.max(0, ((now || Date.now()) - t) / HOUR);
  }
  // Owner decision 2026-10-22: one 4-hour limit for every job (the status
  // model says so too; this is only the fallback for a partial load).
  function qBudget(job) {
    var M = svc();
    if (M && typeof M.queueBudgetHours === 'function') { try { var b = M.queueBudgetHours(job); if (b > 0) return b; } catch (e) {} }
    return 4;
  }
  function qRisk(job, now) {
    var M = svc();
    if (M && typeof M.queueRisk === 'function') { try { return M.queueRisk(job, now) || 0; } catch (e) {} }
    if (!inQueue(job)) return 0;
    var h = queueAgeHours(job, now), b = qBudget(job);
    return h >= b ? 2 : (h >= 0.75 * b ? 1 : 0);
  }
  function vRisk(job, now) {
    var M = svc();
    if (M && typeof M.visitRisk === 'function') { try { return M.visitRisk(job, now) || 0; } catch (e) {} }
    return 0;
  }
  function priKey(p) { return PRI_KEYS.indexOf(p) !== -1 ? p : 'normal'; }
  function priRank(p) {
    var v = vocab('PRIORITIES')[priKey(p)];
    return (v && typeof v.rank === 'number') ? v.rank : PRI_KEYS.indexOf(priKey(p));
  }
  function nextStagesFor(job) {
    var M = svc();
    if (!M) return [];
    if (typeof M.nextStagesFor === 'function') { try { return M.nextStagesFor(job) || []; } catch (e) {} }
    return M.nextStages(job.job_kind, job.stage) || [];
  }
  function convTarget(from, to) {
    var M = svc();
    if (M && typeof M.conversionTarget === 'function') {
      try { var s = M.conversionTarget(from, to); return s || null; } catch (e) {}
    }
    var T = { 'remote>in_store': 'logged', 'remote>on_site': 'logged', 'on_site>in_store': 'received', 'in_store>on_site': 'logged' };
    return T[from + '>' + to] || null;
  }
  function typeLabel(t) { return lbl(vocab('TYPES'), t, 'In-store'); }
  function channelLabel(c) { return lbl(vocab('CHANNELS'), c, ''); }
  function categoryLabel(c) { return c ? lbl(vocab('CATEGORIES'), c, c) : ''; }
  function kindLabel(k) { return lbl(vocab('ITEM_KINDS'), k, k || 'Item'); }
  function sourceLabel(s) { return lbl(vocab('PURCHASE_SOURCES'), s, 'Not sure'); }
  function rmaLabel(stage) {
    var M = svc();
    if (M && typeof M.rmaStaffLabel === 'function') { try { var s = M.rmaStaffLabel(stage); if (s) return s; } catch (e) {} }
    var def = M && M.RMA_STAGES && M.RMA_STAGES[stage];
    return (def && def.staff) || stage || '';
  }
  function rmaBall(unit) {
    var M = svc();
    if (M && typeof M.rmaBallOf === 'function') { try { return ballCls(M.rmaBallOf(unit)); } catch (e) {} }
    return 'shop';
  }
  function rmaLane(unit) {
    var M = svc();
    if (M && typeof M.rmaColumnOf === 'function') { try { return M.rmaColumnOf(unit) || null; } catch (e) {} }
    return null;
  }
  function rmaRiskOf(unit, now) {
    var M = svc();
    if (M && typeof M.rmaRisk === 'function') { try { return M.rmaRisk(unit, now, vendorOf(unit)) || 0; } catch (e) {} }
    return 0;
  }
  function unitLabel(u) {
    var M = svc();
    if (M && typeof M.itemLabel === 'function') { try { var s = M.itemLabel(u.kind, u.brand, u.model); if (s) return s; } catch (e) {} }
    return [kindLabel(u.kind), u.brand, u.model].filter(Boolean).join(' ');
  }
  function dispositionText(d) {
    var M = svc();
    var map = (M && M.RMA_DISPOSITIONS) || {};
    return lbl(map, d, d || 'Closed');
  }

  // ── ops-ui pieces (validated inputs only; outputs are our own markup) ───────
  function typeIcon(t) {
    var u = U();
    if (u && typeof u.typeIcon === 'function') {
      try { var h = u.typeIcon(TYPE_KEYS.indexOf(t) !== -1 ? t : 'in_store'); if (typeof h === 'string') return h; } catch (e) {}
    }
    return '';
  }
  function channelIcon(c) {
    var u = U();
    if (u && typeof u.channelIcon === 'function') {
      try { var h = u.channelIcon(CHANNEL_KEYS.indexOf(c) !== -1 ? c : 'walk_in'); if (typeof h === 'string') return h; } catch (e) {}
    }
    return '';
  }
  function priBadge(p) {
    var k = priKey(p);
    var u = U();
    if (u && typeof u.priorityBadge === 'function') {
      try { var h = u.priorityBadge(k); if (typeof h === 'string' && h) return h; } catch (e) {}
    }
    return '<span class="sv2-pri sv2-pri-' + k + '">' + esc(lbl(vocab('PRIORITIES'), k, 'Normal')) + '</span>';
  }
  function iconPair(job) {
    var t = typeOf(job), c = job.channel || 'walk_in';
    return '<span class="sv2-icons" title="' + esc(typeLabel(t) + (channelLabel(c) ? ' · ' + channelLabel(c) : '')) + '">' +
      typeIcon(t) + channelIcon(c) +
      '<span class="sv2-sr">' + esc(typeLabel(t)) + '</span></span>';
  }

  // ── form pieces ────────────────────────────────────────────────────────────
  function field(label, id, value, opts) {
    opts = opts || {};
    var cls = 'sv-field' + (opts.wide ? ' sv-span2' : '');
    var v = value == null ? '' : value;
    var attrs = ' id="' + id + '"' +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
      (opts.disabled ? ' disabled' : '') +
      (opts.maxlength ? ' maxlength="' + Number(opts.maxlength) + '"' : '');
    var inner = opts.textarea
      ? '<textarea' + attrs + ' rows="' + (opts.rows || 2) + '">' + esc(v) + '</textarea>'
      : '<input type="' + (opts.type || 'text') + '"' + attrs + ' value="' + esc(v) + '"' +
          (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') +
          (opts.min != null ? ' min="' + esc(opts.min) + '"' : '') +
          (opts.step ? ' step="' + esc(opts.step) + '"' : '') +
          ' autocomplete="off" spellcheck="false">';
    return '<label class="' + cls + '"' + (opts.showWhen ? ' data-show-when="' + opts.showWhen + '"' : '') + '>' +
      '<span>' + esc(label) + '</span>' + inner +
      (opts.hint ? '<small class="sv2-fhint">' + esc(opts.hint) + '</small>' : '') + '</label>';
  }
  // A stored value that is not in the option list is ADDED rather than dropped.
  // Otherwise the select shows its first option, the diff sees a change the user
  // never made, and the next save silently overwrites the column.
  function selectField(label, id, options, current, opts) {
    opts = opts || {};
    var cur = current == null ? '' : String(current);
    var list = options.slice();
    if (!list.some(function (o) { return o.value === cur; })) list.push({ value: cur, label: cur || '—' });
    return '<label class="sv-field' + (opts.wide ? ' sv-span2' : '') + '"' + (opts.showWhen ? ' data-show-when="' + opts.showWhen + '"' : '') + '>' +
      '<span>' + esc(label) + '</span>' +
      '<select id="' + id + '" class="settings-select">' +
        list.map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') +
      '</select>' + (opts.hint ? '<small class="sv2-fhint">' + esc(opts.hint) + '</small>' : '') + '</label>';
  }
  function checkField(id, label, on) {
    return '<label class="sv-check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }
  function roField(label, value, opts) {
    opts = opts || {};
    return '<div class="sv-f' + (opts.wide ? ' sv-span2' : '') + '"><span class="sv-f-k">' + esc(label) + '</span>' +
      '<span class="sv-f-v">' + (opts.html ? value : esc(value == null || value === '' ? '—' : value)) + '</span></div>';
  }
  function mapOptions(map, keys, blankLabel) {
    var out = blankLabel != null ? [{ value: '', label: blankLabel }] : [];
    (keys || Object.keys(map || {})).forEach(function (k) { out.push({ value: k, label: lbl(map, k, k) }); });
    return out;
  }

  // Toggle chips and choice cards. Our own small implementation, delegated, so
  // a chip inside a dialog and a chip inside the panel behave the same and no
  // element is ever bound twice (a double-bound toggle un-toggles itself).
  function chipsHtml(group, options, selected, opts) {
    opts = opts || {};
    var multi = !!opts.multi;
    var sel = multi ? (selected || []) : (selected == null ? '' : selected);
    return '<div class="sv2-chips" data-group="' + group + '"' + (multi ? ' data-multi="1"' : '') +
      (opts.optional ? ' data-optional="1"' : '') + ' role="group"' +
      (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>' +
      options.map(function (o) {
        var on = multi ? sel.indexOf(o.value) !== -1 : sel === o.value;
        return '<button type="button" class="sv2-chip' + (on ? ' on' : '') + '" data-value="' + esc(o.value) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(o.label) + '</button>';
      }).join('') + '</div>';
  }
  function choicesHtml(group, options, selected) {
    return '<div class="sv2-choices" data-group="' + group + '" role="radiogroup">' +
      options.map(function (o) {
        var on = selected === o.value;
        return '<button type="button" class="sv2-choice' + (on ? ' on' : '') + '" data-value="' + esc(o.value) + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '"' + (o.disabled ? ' disabled' : '') + '>' +
          '<span class="sv2-choice-t">' + esc(o.title) + '</span>' +
          (o.sub ? '<span class="sv2-choice-s">' + esc(o.sub) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
  }
  function markOpt(x, on) {
    x.classList.toggle('on', on);
    x.setAttribute(x.classList.contains('sv2-choice') ? 'aria-checked' : 'aria-pressed', on ? 'true' : 'false');
  }
  function handleChipClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('.sv2-chip, .sv2-choice') : null;
    if (!b) return false;
    var g = b.closest('[data-group]');
    if (!g || b.disabled) return true;
    if (g.getAttribute('data-multi')) {
      markOpt(b, !b.classList.contains('on'));
    } else if (b.classList.contains('on')) {
      if (g.getAttribute('data-optional')) markOpt(b, false);
    } else {
      Array.prototype.forEach.call(g.querySelectorAll('.sv2-chip, .sv2-choice'), function (x) { markOpt(x, false); });
      markOpt(b, true);
    }
    return true;
  }
  function readGroup(scope, group) {
    var g = scope && scope.querySelector('[data-group="' + group + '"]');
    if (!g) return undefined;
    var on = Array.prototype.map.call(g.querySelectorAll('.sv2-chip.on, .sv2-choice.on'), function (x) { return x.getAttribute('data-value'); });
    return g.getAttribute('data-multi') ? on : (on[0] || '');
  }
  // data-show-when="group:value1,value2" — shown only while that group holds
  // one of those values. One generic rule instead of a listener per dialog.
  function syncDeps(scope) {
    if (!scope || !scope.querySelectorAll) return;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-show-when]'), function (el) {
      var spec = el.getAttribute('data-show-when') || '';
      var i = spec.indexOf(':');
      if (i < 1) return;
      var vals = spec.slice(i + 1).split(',');
      var cur = readGroup(scope, spec.slice(0, i));
      var on = Array.isArray(cur) ? cur.some(function (v) { return vals.indexOf(v) !== -1; }) : vals.indexOf(cur) !== -1;
      el.hidden = !on;
    });
  }

  function enterGuard(e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    var tag = (t && t.tagName ? t.tagName : '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
  }

  // ── dialogs ────────────────────────────────────────────────────────────────
  function dlgNode(tag, html) {
    var n = document.createElement('div');
    n.className = 'sv2-dlg';
    n.setAttribute('data-dlg', tag);
    n.innerHTML = html;
    syncDeps(n);
    return n;
  }
  // The dialog root the UI kit hands back, or our own node if it did not.
  function scopeOf(root, node, tag) {
    var s = root && root.querySelector ? root.querySelector('.sv2-dlg[data-dlg="' + tag + '"]') : null;
    return s || node;
  }
  function openDialog(opts) {
    var u = U();
    if (!u || typeof u.dialog !== 'function') {
      toast('The dialog component did not load. Restart the app.', 'error');
      return Promise.resolve(false);
    }
    return u.dialog(opts);
  }
  function confirmBox(message, opts) {
    opts = opts || {};
    if (typeof showConfirm === 'function') {
      return showConfirm(message, {
        title: opts.title || 'Are you sure?', okText: opts.okText || 'Yes',
        cancelText: opts.cancelText || 'Cancel', danger: !!opts.danger
      });
    }
    return Promise.resolve(true);
  }

  // ── external links / clipboard ──────────────────────────────────────────────
  function electron() { try { return (typeof require === 'function') ? require('electron') : null; } catch (e) { return null; } }
  // https only: shell.openExternal with a file:// or custom-protocol URL is a
  // way to run something on this PC, and these URLs are typed by staff.
  function openExternal(url) {
    if (!/^https:\/\//i.test(String(url || ''))) return false;
    var el = electron();
    try {
      if (el && el.shell && typeof el.shell.openExternal === 'function') { el.shell.openExternal(url); return true; }
    } catch (e) {}
    try { window.open(url, '_blank', 'noopener'); return true; } catch (e) { return false; }
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    var el = electron();
    try { if (el && el.clipboard) { el.clipboard.writeText(text); return true; } } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function safeMapsHost(u) {
    try {
      var h = new URL(u).hostname.toLowerCase();
      return /(^|\.)google\.[a-z.]+$/.test(h) || h === 'goo.gl' || h === 'maps.app.goo.gl' || /(^|\.)openstreetmap\.org$/.test(h);
    } catch (e) { return false; }
  }
  function mapsUrlFor(job) {
    var u = String(job.site_maps_url || '').trim();
    if (/^https:\/\//i.test(u) && safeMapsHost(u)) return u;
    var lat = Number(job.site_lat), lng = Number(job.site_lng);
    if (job.site_lat != null && job.site_lng != null && isFinite(lat) && isFinite(lng)) {
      return 'https://www.google.com/maps?q=' + lat + ',' + lng;
    }
    var addr = [job.site_address, job.site_landmark, job.site_area, job.site_pincode].filter(Boolean).join(', ');
    return addr ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr) : '';
  }
  function parseLatLng(url) {
    var s = String(url || '');
    try { s = decodeURIComponent(s); } catch (e) {}
    var m = /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(s) ||
            /[?&](?:q|ll|query|center)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(s);
    if (!m) return null;
    var lat = Number(m[1]), lng = Number(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  // ── privacy ────────────────────────────────────────────────────────────────
  // A ticket in the queue is being offered around. A technician who has not
  // taken it sees the area and pincode — enough to decide — but not the phone
  // number or the address. Desk and leads see everything, and so does the
  // person who logged it (they took the call).
  // SPEC-GAP: the spec states this for the queue; the job panel applies the
  // same rule while the ticket is still in the queue, so opening the card from
  // the board does not undo it.
  function contactHidden(job) {
    if (!job || role() !== 'tech') return false;
    if (!inQueue(job)) return false;
    var m = myEmail();
    return !(m && lower(job.created_by_email) === m);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  THE SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  function rootEl() { return byId('sv-root') || byId('sv-board'); }
  function screenActive() { var s = byId('service-screen'); return !!(s && s.classList.contains('active')); }

  function segBtn(v, label, countId) {
    return '<button type="button" class="sv2-seg-btn" data-view="' + v + '" aria-pressed="false">' + esc(label) +
      (countId ? '<span class="sv2-count" id="' + countId + '"></span>' : '') + '</button>';
  }
  function typeChip(t, label) {
    return '<button type="button" class="sv2-type-chip" data-type="' + t + '" aria-pressed="false">' +
      (t !== 'all' ? typeIcon(t) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function toolbarHtml() {
    return '' +
      '<div class="sv2-seg" role="group" aria-label="View">' +
        segBtn('board', 'Board') + segBtn('queue', 'Queue', 'sv2-qcount') + segBtn('visits', 'Visits', 'sv2-vcount') +
      '</div>' +
      '<div class="sv2-types" role="group" aria-label="Type of work">' +
        typeChip('all', 'All') + typeChip('in_store', 'In-store') + typeChip('on_site', 'On-site') + typeChip('remote', 'Remote') +
      '</div>' +
      '<label class="sv-mine" title="Only tickets assigned to you"><input type="checkbox" id="sv-mine"> Mine only</label>' +
      '<input type="search" id="sv-search" class="sv-search" placeholder="Search name, phone, code or serial" autocomplete="off" spellcheck="false" aria-label="Search tickets">' +
      '<button type="button" id="sv-new" class="primary-pink-btn">+ New ticket</button>';
  }
  function syncToolbar() {
    var tb = byId('sv-toolbar');
    if (!tb) return;
    Array.prototype.forEach.call(tb.querySelectorAll('[data-view]'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-type]'), function (b) {
      var on = b.getAttribute('data-type') === typeFilter;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var mine = byId('sv-mine');
    if (mine && mine.checked !== mineOnly) mine.checked = mineOnly;
  }

  function initServiceUI() {
    var tb = byId('sv-toolbar');
    if (tb && !tb.dataset.sv2) {
      tb.dataset.sv2 = '1';
      tb.innerHTML = toolbarHtml();
      tb.addEventListener('click', function (e) {
        var v = e.target.closest('[data-view]');
        if (v) { setView(v.getAttribute('data-view')); return; }
        var t = e.target.closest('[data-type]');
        if (t) { setType(t.getAttribute('data-type')); return; }
        if (e.target.closest('#sv-new')) openIntake();
      });
      tb.addEventListener('input', function (e) {
        if (e.target.id !== 'sv-search') return;
        query = String(e.target.value || '').toLowerCase().trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderServiceBoard, 120);
      });
      tb.addEventListener('change', function (e) {
        if (e.target.id === 'sv-mine') { mineOnly = !!e.target.checked; kpiFilter = null; renderServiceBoard(); }
      });
      tb.addEventListener('keydown', enterGuard);
    }
    var root = rootEl();
    if (root && !root.dataset.sv2) {
      root.dataset.sv2 = '1';
      root.addEventListener('click', onRootClick);
      root.addEventListener('keydown', onRootKey);
    }
    initPanel();
    initGlobal();
  }

  var globalBound = false;
  function initGlobal() {
    if (globalBound) return;
    globalBound = true;
    // Chips and conditional fields inside our dialogs. Document-level so it works
    // however the UI kit inserts the dialog body.
    document.addEventListener('click', function (e) {
      var dlg = e.target && e.target.closest ? e.target.closest('.sv2-dlg') : null;
      if (dlg && handleChipClick(e)) { syncDeps(dlg); onDialogGroupChange(dlg); }
      if (dlg) {
        var pt = e.target.closest('[data-pw-toggle]');
        if (pt) togglePwInput(dlg, pt);
        var fb = e.target.closest('[data-find-build]');
        if (fb) findBuildDialog(fb.getAttribute('data-find-build'), dlg);
        var lb = e.target.closest('[data-link-build]');
        if (lb) linkBuild(dlg, lb.getAttribute('data-prefix'), lb.getAttribute('data-link-build'));
      }
      if (waMenuOpen && !e.svInsideActions && !(e.target.closest && e.target.closest('#sv-job-actions'))) { waMenuOpen = false; paintActions(); }
      var out = byId('sv2-out-menu');
      if (out && !out.hidden && !(e.target.closest && e.target.closest('.sv2-dd'))) out.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      var dlg = e.target && e.target.closest ? e.target.closest('.sv2-dlg') : null;
      if (dlg) enterGuard(e);
      if (e.key === 'Escape' && waMenuOpen) { waMenuOpen = false; paintActions(); }
    });
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'svd-fee') e.target.dataset.touched = '1';
    });
    // Back from the background: the offer countdowns stopped while hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') return;
      if (screenActive()) scheduleRender();
      if (openJobId && panelOpen()) paintActions();
    });
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'svd-a-serial' && e.target.closest('.sv2-dlg')) serialHint(e.target, 'svd-a');
      // The handling fee follows the part kind until someone types their own.
      if (e.target && e.target.id === 'svd-kind') {
        var dlg = e.target.closest('.sv2-dlg[data-dlg="rma"]');
        var fee = dlg && dlg.querySelector('#svd-fee');
        if (fee && !fee.dataset.touched) fee.value = String(feeFor(e.target.value));
        // Whole machine or a part from inside it: different hold rules.
        if (dlg && dlg.hasAttribute('data-primary-kind')) {
          var whole = dlg.getAttribute('data-primary-kind') === e.target.value;
          var wb = dlg.querySelector('#svd-hold-whole'), pb = dlg.querySelector('#svd-hold-part');
          if (wb) wb.hidden = !whole;
          if (pb) pb.hidden = whole;
          // The machine's brand, model, serial and vendor are not the part's.
          // Clear them while they still hold the machine's values; put them
          // back only into fields this cleared and nobody has typed in since.
          ['brand', 'model', 'serial', 'vendor'].forEach(function (f) {
            var inp = dlg.querySelector('#svd-' + f);
            var mv = dlg.getAttribute('data-m-' + f) || '';
            if (!inp || !mv) return;
            var cur = String(inp.value || '').trim();
            if (!whole && cur === mv) { inp.value = ''; inp.setAttribute('data-cleared', '1'); }
            else if (whole && !cur && inp.getAttribute('data-cleared') === '1') { inp.value = mv; inp.removeAttribute('data-cleared'); }
          });
        }
      }
    });
  }
  function onDialogGroupChange(dlg) {
    if (dlg.getAttribute('data-dlg') !== 'convert') return;
    var to = readGroup(dlg, 'to');
    var hint = dlg.querySelector('#svd-lands');
    var job = jobById(openJobId);
    if (hint && job) hint.textContent = to ? 'It will be at: ' + stageLabel(convTarget(typeOf(job), to)) + '.' : '';
  }

  function setView(v) {
    if (['board', 'queue', 'visits'].indexOf(v) === -1) return;
    view = v; kpiFilter = null;
    writePref('neo_sv_view', v);
    renderServiceBoard();
    var root = rootEl();
    var sc = root && root.closest('.dashboard-container');
    if (sc) sc.scrollTop = 0;
  }
  function setType(t) {
    if (['all', 'in_store', 'on_site', 'remote'].indexOf(t) === -1) return;
    typeFilter = t; kpiFilter = null;
    writePref('neo_sv_type', t);
    renderServiceBoard();
  }

  function onRootClick(e) {
    var t = e.target;
    var claim = t.closest('[data-claim]');
    if (claim) { e.stopPropagation(); if (!claim.disabled) claimFlow(claim.getAttribute('data-claim')); return; }
    var acc = t.closest('[data-accept]');
    if (acc) { e.stopPropagation(); if (!acc.disabled) acceptFlow(acc.getAttribute('data-accept')); return; }
    var dec = t.closest('[data-decline]');
    if (dec) { e.stopPropagation(); if (!dec.disabled) declineDialog(dec.getAttribute('data-decline')); return; }
    var wd = t.closest('[data-withdraw]');
    if (wd) { e.stopPropagation(); if (!wd.disabled) withdrawOffer(wd.getAttribute('data-withdraw')); return; }
    var asg = t.closest('[data-offer]') || t.closest('[data-assign]');
    if (asg) {
      e.stopPropagation();
      if (!asg.disabled) offerDialog(asg.getAttribute('data-offer') || asg.getAttribute('data-assign'));
      return;
    }
    var k = t.closest('[data-kpi]');
    if (k) { kpiClick(k.getAttribute('data-kpi')); return; }
    var ra = t.closest('[data-root-act]');
    if (ra) {
      var a = ra.getAttribute('data-root-act');
      if (a === 'retry') retryLoad();
      else if (a === 'settings' && typeof openSettingsModal === 'function') openSettingsModal();
      else if (a === 'clear-kpi') { kpiFilter = null; renderServiceBoard(); }
      return;
    }
    var oj = t.closest('[data-open-job]');
    if (oj) { e.stopPropagation(); openJob(oj.getAttribute('data-open-job'), { tab: oj.getAttribute('data-tab') || null }); return; }
    var card = t.closest('[data-job]');
    if (card) openJob(card.getAttribute('data-job'));
  }
  function onRootKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('role') !== 'button' || !t.getAttribute('data-job')) return;
    e.preventDefault();
    openJob(t.getAttribute('data-job'));
  }
  function kpiClick(key) {
    if (key === 'queue') { setView('queue'); return; }
    if (key === 'visits') { setView('visits'); return; }
    if (key === 'open') kpiFilter = null;
    else kpiFilter = (kpiFilter === key) ? null : key;
    renderServiceBoard();
  }

  // ── filtering ──────────────────────────────────────────────────────────────
  function typeMatch(job) { return typeFilter === 'all' || typeOf(job) === typeFilter; }
  function alnum(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function searchMatch(job) {
    if (!query) return true;
    var hidden = contactHidden(job);
    var hay = [job.customer_name, job.public_code, job.device_label, job.device_serial, job.assignee,
               job.site_area, job.site_pincode];
    itemsOf(job.id).forEach(function (it) { hay.push(it.label, it.serial); });
    unitsOfJob(job.id).forEach(function (u) { hay.push(u.public_code); });
    if (lower(hay.filter(Boolean).join(' \u0001 ')).indexOf(query) !== -1) return true;
    // Serials are compared letters-and-digits only, the way the database stores
    // serial_norm: "SN-1234 5" and "sn12345" are the same label.
    var qn = alnum(query);
    if (qn.length >= 3) {
      var serials = [job.device_serial].concat(itemsOf(job.id).map(function (it) { return it.serial; }));
      if (serials.some(function (s) { return s && alnum(s).indexOf(qn) !== -1; })) return true;
    }
    var qd = digits(query);
    if (!hidden && qd.length >= 3 && qd.length === query.replace(/[\s+\-()]/g, '').length) {
      if (digits(job.customer_phone).indexOf(qd) !== -1) return true;
    }
    return false;
  }

  // How a ticket reads on the board: its lane, its risk, whose turn it is and
  // the sentence for it. A ticket in a mirror stage (waiting on a part under
  // RMA) takes all four from its most urgent HOLDING part (SPEC-AMENDMENTS
  // A23) — a part waiting on the customer's invoice puts the ticket on the
  // customer's list, because that is where the next action is.
  var LANES = ['intake', 'shop', 'customer', 'third', 'closed'];
  var BALL_ORDER = { customer: 0, shop: 1, third_party: 2, nobody: 3 };
  var tviewCache = null;            // one render pass computes each ticket once
  function vendorMap() {
    var out = {};
    vendorsList().forEach(function (v) { out[v.id] = v; });
    return out;
  }
  function rmaSentence(u) {
    var M = svc();
    if (M && typeof M.rmaWaitingSentence === 'function') { try { return M.rmaWaitingSentence(u, vendorOf(u)) || ''; } catch (e) {} }
    return rmaLabel(u.stage);
  }
  // SPEC-AMENDMENTS A23: customer-ball parts first, then shop, then a third
  // party; within the same ball the riskier, then the longest waiting.
  function pickUnit(units, now) {
    var best = null, bestKey = null;
    units.forEach(function (u) {
      var key = [BALL_ORDER[rmaBall(u)] != null ? BALL_ORDER[rmaBall(u)] : 9, -rmaRiskOf(u, now), -daysIn(u, now)];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = u; bestKey = key;
      }
    });
    return best;
  }
  function tview(job, now) {
    if (tviewCache && tviewCache.now === now && tviewCache.map[job.id]) return tviewCache.map[job.id];
    var v = computeTview(job, now);
    if (tviewCache && tviewCache.now === now) tviewCache.map[job.id] = v;
    return v;
  }
  function computeTview(job, now) {
    var M = svc();
    var units = unitsOfJob(job.id);
    if (M && typeof M.ticketWithUnits === 'function') {
      try {
        var w = M.ticketWithUnits(job, units, vendorMap(), now);
        if (w && LANES.indexOf(w.column) !== -1) {
          return { column: w.column, risk: Number(w.risk) || 0, ball: ballCls(w.ball || ballOf(job.stage)),
                   sentence: w.sentence || (M.waitingSentence(job) || ''), unit: w.unit || null };
        }
      } catch (e) { /* fall through to the local rule */ }
    }
    var base = { column: M ? M.boardColumnOf(job) : 'shop', risk: riskOf(job, now), ball: ballOf(job.stage),
                 sentence: M ? M.waitingSentence(job) : '', unit: null };
    if (job.stage === 'closed' || !isMirror(job.stage)) return base;
    // SPEC-GAP: A23 does not limit this to v2 tickets; a v1 ticket that holds a
    // part is moved by the same RMA sync, so it reads the same way.
    var hold = units.filter(function (u) { return u.holds_ticket && u.stage !== 'closed'; });
    if (!hold.length) return base;
    var u = pickUnit(hold, now);
    var lane = rmaLane(u);
    if (!lane || lane === 'closed' || LANES.indexOf(lane) === -1) return base;
    var risk = 0;
    hold.forEach(function (x) { risk = Math.max(risk, rmaRiskOf(x, now)); });
    return { column: lane, risk: risk, ball: rmaBall(u), sentence: unitLabel(u) + ': ' + rmaSentence(u), unit: u };
  }
  function laneOf(job, now) { return tview(job, now).column; }
  function lateOf(job, now) { return job.stage === 'closed' ? 0 : tview(job, now).risk; }

  // ── render ─────────────────────────────────────────────────────────────────
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    var run = function () { renderQueued = false; renderServiceBoard(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
  }

  function problemHtml(msg, retry) {
    return '<div class="ops-banner ops-banner-error sv2-problem" role="alert"><p>' + esc(msg) + '</p>' +
      (retry ? '<button type="button" class="secondary-btn" data-root-act="retry">Try again</button>' : '') + '</div>';
  }
  function demoBannerHtml() {
    if (!isDemo()) return '';
    return '<div class="ops-banner ops-banner-demo sv2-demo" role="status"><strong>Demo data.</strong> Nothing here is real and nothing can be changed. ' +
      'Turn it off in Settings → Operations.' +
      (typeof openSettingsModal === 'function' ? ' <button type="button" class="sv-linkbtn" data-root-act="settings">Open Settings</button>' : '') +
      '</div>';
  }

  function renderServiceBoard() {
    var root = rootEl();
    syncToolbar();
    if (!root) return;
    var M = svc(), d = D();
    if (!M || !d) {
      root.innerHTML = problemHtml(!M ? 'The service status model did not load. Restart the app.' : 'The data layer did not load. Restart the app.', false);
      return;
    }
    var all = allJobs();
    // A demo switch or a sign-in change empties the caches while they refill;
    // say "loading" then, not "nothing here".
    var refilling = typeof d.isLoaded === 'function' && !d.isLoaded() && loadState !== 'error';
    if (!all.length && (loadState === 'loading' || loadState === 'idle' || refilling)) {
      root.innerHTML = demoBannerHtml() + '<div class="sv-empty sv2-loading">Loading tickets…</div>';
      return;
    }
    if (!all.length && loadState === 'error') {
      root.innerHTML = demoBannerHtml() + problemHtml('Could not load service tickets: ' + loadError, true);
      return;
    }

    var now = Date.now();
    tviewCache = { now: now, map: {} };
    var typed = all.filter(typeMatch);
    var mineRows = mineOnly ? typed.filter(isMine) : typed;
    var k = kpis(typed, mineRows, now);
    updateStat(k);
    updateCounts(k);

    var html = demoBannerHtml();
    if (refreshWarn) html += '<div class="ops-banner ops-banner-warn sv2-banner" role="status">' + esc(refreshWarn) + ' <button type="button" class="sv-linkbtn" data-root-act="retry">Try again</button></div>';
    if (view === 'queue') html += queueViewHtml(typed.filter(searchMatch), now);
    else if (view === 'visits') html += visitsViewHtml(mineRows.filter(searchMatch), now);
    else html += kpiHtml(k) + kpiNote() + boardHtml(applyKpi(mineRows.filter(searchMatch), now), now);

    // Keep the horizontal scroll of the board and keyboard focus across the
    // once-a-minute repaint; on a 1100 px office screen the board scrolls.
    var oldBoard = root.querySelector('.sv-board');
    var sx = oldBoard ? oldBoard.scrollLeft : 0;
    var focusJob = document.activeElement && root.contains(document.activeElement) && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-job') : null;
    tviewCache = null;
    root.innerHTML = html;
    var nb = root.querySelector('.sv-board');
    if (nb && sx) nb.scrollLeft = sx;
    if (focusJob) {
      var again = Array.prototype.find.call(root.querySelectorAll('[data-job][role="button"]'), function (x) { return x.getAttribute('data-job') === focusJob; });
      if (again) again.focus();
    }
    if (html.indexOf('data-sv-countdown') !== -1) ensureTick();
  }

  function kpis(typed, mineRows, now) {
    var m0 = midnight(0), m1 = midnight(1);
    var open = mineRows.filter(function (j) { return j.stage !== 'closed'; });
    return {
      open: open.length,
      late: open.filter(function (j) { return lateOf(j, now) === 2; }).length,
      // The queue is unclaimed by definition, so "mine only" cannot apply.
      queue: typed.filter(inQueue).length,
      customer: open.filter(function (j) { return laneOf(j, now) === 'customer'; }).length,
      visits: mineRows.filter(function (j) {
        var t = ms(j.visit_start);
        return typeOf(j) !== 'in_store' && t != null && t >= m0 && t < m1;
      }).length,
      ready: open.filter(function (j) { return j.stage === 'ready'; }).length
    };
  }
  function updateStat(k) {
    var stat = byId('sv-stat');
    if (!stat) return;
    stat.textContent = k.open + ' open · ' + k.late + ' late' + (k.queue ? ' · ' + k.queue + ' in the queue' : '');
    stat.classList.toggle('has-breach', k.late > 0);
  }
  function updateCounts(k) {
    setText('sv2-qcount', k.queue ? String(k.queue) : '');
    setText('sv2-vcount', k.visits ? String(k.visits) : '');
  }
  function kpiHtml(k) {
    var tiles = [
      ['open', 'Open', k.open, 't-open', 'shop', 'Show everything'],
      ['late', 'Late', k.late, 't-late', 'late', 'Show only late tickets'],
      ['queue', 'In the queue', k.queue, 't-queue', 'queue', 'Open the queue'],
      ['customer', 'Waiting on customer', k.customer, 't-cust', 'customer', 'Show only tickets waiting on the customer'],
      ['visits', 'Visits today', k.visits, 't-visits', 'vendor', 'Open today’s visits'],
      ['ready', 'Ready to collect', k.ready, 't-ready', 'ready', 'Show only tickets ready to collect']
    ];
    // The UI kit's strip, so Service and RMA read the same way.
    var u = U();
    if (u && typeof u.kpis === 'function') {
      try {
        var h = u.kpis(tiles.map(function (t) {
          return { key: t[0], n: t[2], label: t[1], tone: t[4], active: kpiFilter === t[0], title: t[5] };
        }), { className: 'sv2-kpis' });
        if (typeof h === 'string' && h) return h;
      } catch (e) { /* fall through to our own */ }
    }
    return '<div class="sv2-kpis" role="group" aria-label="Summary">' + tiles.map(function (t) {
      var on = kpiFilter === t[0];
      return '<button type="button" class="sv2-kpi ' + t[3] + (on ? ' on' : '') + (t[0] === 'late' && t[2] ? ' has-late' : '') +
        '" data-kpi="' + t[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="sv2-kpi-n">' + t[2] + '</span><span class="sv2-kpi-l">' + esc(t[1]) + '</span></button>';
    }).join('') + '</div>';
  }
  function kpiNote() {
    if (!kpiFilter) return '';
    var words = { late: 'late tickets', customer: 'tickets waiting on the customer', ready: 'tickets ready to collect' };
    return '<div class="sv2-filter-note">Showing ' + esc(words[kpiFilter] || 'a filter') + ' only. ' +
      '<button type="button" class="sv-linkbtn" data-root-act="clear-kpi">Show everything</button></div>';
  }
  function applyKpi(rows, now) {
    if (kpiFilter === 'late') return rows.filter(function (j) { return j.stage !== 'closed' && lateOf(j, now) === 2; });
    if (kpiFilter === 'customer') return rows.filter(function (j) { return j.stage !== 'closed' && laneOf(j, now) === 'customer'; });
    if (kpiFilter === 'ready') return rows.filter(function (j) { return j.stage === 'ready'; });
    return rows;
  }

  // ── board ──────────────────────────────────────────────────────────────────
  function boardHtml(rows, now) {
    var M = svc();
    var mid = midnight(0);
    var buckets = {};
    M.COLUMNS.forEach(function (c) { buckets[c.key] = []; });
    rows.forEach(function (j) {
      var lane = laneOf(j, now);
      if (!buckets[lane]) lane = 'shop';
      if (lane === 'closed') {
        // "Closed today" empties overnight — the only feedback loop that makes
        // people actually close tickets rather than leave them on the board.
        var ct = ms(j.closed_at);
        if (!(ct >= mid)) return;
      }
      buckets[lane].push(j);
    });

    var since = function (j) { return ms(j.stage_since) || ms(j.created_at) || 0; };
    var urgentFirst = function (a, b) {
      return (lateOf(b, now) - lateOf(a, now)) || (priRank(b.priority) - priRank(a.priority)) || (since(a) - since(b));
    };
    // The thing rotting longest is the thing to act on.
    buckets.intake.sort(urgentFirst);
    buckets.customer.sort(urgentFirst);
    buckets.third.sort(urgentFirst);
    // On us: grouped by technician, the queue first because nobody owns it.
    buckets.shop.sort(function (a, b) {
      var an = lower(a.assignee || (a.assignee_email ? staffName(a.assignee_email) : '')), bn = lower(b.assignee || (b.assignee_email ? staffName(b.assignee_email) : ''));
      if (an !== bn) { if (!an) return -1; if (!bn) return 1; return an < bn ? -1 : 1; }
      return urgentFirst(a, b);
    });
    buckets.closed.sort(function (a, b) { return (ms(b.closed_at) || 0) - (ms(a.closed_at) || 0); });

    return '<div class="sv-board sv2-board">' + M.COLUMNS.map(function (c) {
      var list = buckets[c.key] || [];
      var breached = list.filter(function (j) { return lateOf(j, now) === 2; }).length;
      var cards;
      if (!list.length) cards = '<div class="sv-empty">Nothing here</div>';
      else if (c.key === 'shop') {
        var lastKey = null;
        cards = list.map(function (j) {
          var name = j.assignee || (j.assignee_email ? staffName(j.assignee_email) : '');
          var key = lower(name);
          var head = '';
          if (key !== lastKey) {
            lastKey = key;
            var n = list.filter(function (x) { return lower(x.assignee || (x.assignee_email ? staffName(x.assignee_email) : '')) === key; }).length;
            head = '<div class="sv2-group">' + esc(name || 'In the queue') + ' <span class="sv2-group-n">' + n + '</span></div>';
          }
          return head + cardHtml(j, now);
        }).join('');
      } else cards = list.map(function (j) { return cardHtml(j, now); }).join('');
      return '<section class="sv-col sv-col-' + c.key + '" aria-label="' + esc(c.label) + '">' +
        '<div class="sv-col-head">' +
          '<span class="sv-col-name">' + esc(c.label) + '</span>' +
          '<span class="sv-col-count' + (breached ? ' has-breach' : '') + '" title="' + (breached ? breached + ' late' : '') + '">' + list.length + '</span>' +
        '</div>' +
        '<div class="sv-col-hint">' + esc(c.hint) + '</div>' +
        '<div class="sv-cards">' + cards + '</div>' +
      '</section>';
    }).join('') + '</div>';
  }

  function primaryLabel(job) {
    var items = itemsOf(job.id);
    var p = items[0];
    var label = (p && (p.label || kindLabel(p.kind))) || job.device_label || categoryLabel(job.category) ||
                lbl(svc() && svc().JOB_KINDS, job.job_kind, 'Service');
    return { label: label, extra: items.length > 1 ? items.length - 1 : 0 };
  }
  function rmaBadge(job) {
    var open = unitsOfJob(job.id).filter(function (u) { return u.stage !== 'closed'; });
    if (!open.length) return '';
    var atV = open.filter(function (u) { return u.stage === 'with_vendor'; });
    var text;
    if (atV.length && atV.length === open.length) {
      var names = [];
      atV.forEach(function (u) { var n = vendorName(u) || 'vendor'; if (names.indexOf(n) === -1) names.push(n); });
      text = 'RMA: ' + atV.length + ' at ' + (names.length === 1 ? names[0] : names.length + ' vendors');
    } else {
      text = 'RMA: ' + open.length + ' open' + (atV.length ? ' · ' + atV.length + ' at vendor' : '');
    }
    var holds = open.some(function (u) { return u.holds_ticket; });
    return '<span class="sv2-rma-badge' + (holds ? ' holds' : '') + '" title="' + (holds ? 'The ticket waits for this part' : 'The part follows separately') + '">' + esc(text) + '</span>';
  }
  function promiseOrVisit(job, now) {
    var t = typeOf(job);
    var vs = ms(job.visit_start);
    if (vs != null && (job.stage === 'scheduled' || job.stage === 'en_route' || job.stage === 'session_booked' || job.stage === 'logged' || job.stage === 'revisit_needed')) {
      return '<span class="sv2-when">' + esc((t === 'remote' ? 'Session ' : 'Visit ') + whenShort(job.visit_start)) + '</span>';
    }
    // A promised date is only given AFTER diagnosis, so a blank one is normal
    // early on and must not read as missing data.
    if (job.promised_at) return '<span class="sv-promise">Promised ' + esc(fmtDate(job.promised_at)) + '</span>';
    if (job.stage === 'closed') return '<span class="sv-promise">Closed ' + esc(fmtTime(job.closed_at)) + '</span>';
    var early = ['logged', 'received', 'diagnosing', 'scheduled', 'en_route', 'on_site', 'session_booked', 'in_session'];
    return '<span class="sv-nopromise">' + (early.indexOf(job.stage) !== -1 ? 'No promise yet' : 'No date given') + '</span>';
  }
  // Colour is never the only signal: a late thing also says "late".
  function lateTag(risk, words) {
    var u = U();
    if (u && typeof u.lateTag === 'function') {
      try { var h = u.lateTag(risk, words); if (typeof h === 'string') return h; } catch (e) {}
    }
    words = words || {};
    if (risk === 2) return '<span class="sv2-late">' + esc(words.late || 'late') + '</span>';
    if (risk === 1) return '<span class="sv2-soon">' + esc(words.soon || 'due soon') + '</span>';
    return '';
  }

  function cardHtml(job, now) {
    var M = svc();
    var tv = tview(job, now);
    var risk = lateOf(job, now);
    var riskCls = risk === 2 ? ' risk-breached' : risk === 1 ? ' risk-soon' : '';
    var pl = primaryLabel(job);
    var lines = '';
    lines += '<div class="sv-card-line"><span class="sv-k">Stage</span> ' + esc(stageLabel(job.stage)) + '</div>';
    if (job.stage === 'closed') {
      lines += '<div class="sv-card-line">' + esc(M.waitingSentence(job)) + '</div>';
    } else if (tv.unit) {
      // Waiting on a part: say which part and where it is, not just the stage.
      lines += '<div class="sv-card-line"><span class="sv-k">Part</span> ' + esc(tv.unit.public_code + ' · ' + rmaLabel(tv.unit.stage)) + '</div>';
    } else if (job.waiting_party && ballOf(job.stage) === 'third_party') {
      lines += '<div class="sv-card-line"><span class="sv-k">Waiting on</span> ' + esc(job.waiting_party) + '</div>';
    }
    var tech;
    if (job.assignee || job.assignee_email) {
      tech = '<span class="sv-k">Tech</span> ' + esc(job.assignee || staffName(job.assignee_email));
    } else if (job.stage !== 'closed') {
      var chip = offerChipHtml(job);
      tech = '<span class="sv2-inq">In the queue</span>' +
        (chip ? ' ' + chip
              : job.suggested_tech_email ? ' <span class="sv2-star" title="Requested technician">★ ' + esc(staffName(job.suggested_tech_email)) + '</span>' : '');
    } else tech = '<span class="sv-k">Tech</span> —';
    lines += '<div class="sv-card-line">' + tech + '</div>';

    return '' +
      '<div class="sv-card sv2-card sv2-p-' + priKey(job.priority) + riskCls + '" data-job="' + esc(job.id) + '" role="button" tabindex="0"' +
        ' aria-label="' + esc((job.customer_name || 'Ticket') + ', ' + stageLabel(job.stage) + (risk === 2 ? ', late' : '')) + '">' +
        '<div class="sv-card-top">' +
          '<span class="sv2-card-who">' + iconPair(job) + '<span class="sv-cust">' + esc(job.customer_name || '—') + '</span></span>' +
          '<span class="sv-idle" title="Time in the current stage">' + esc(fmtDays(daysIn(job, now))) + '</span>' +
        '</div>' +
        '<div class="sv-card-dev">' + esc(pl.label) + (pl.extra ? ' <span class="sv2-more">+' + pl.extra + ' item' + (pl.extra > 1 ? 's' : '') + '</span>' : '') + '</div>' +
        lines +
        '<div class="sv2-card-tags">' + (job.priority === 'urgent' || job.priority === 'high' ? priBadge(job.priority) : '') + rmaBadge(job) + lateTag(risk) + '</div>' +
        '<div class="sv-card-foot">' +
          '<span class="sv-code">' + esc(job.public_code || '') + '</span>' +
          promiseOrVisit(job, now) +
        '</div>' +
      '</div>';
  }

  // ── queue ──────────────────────────────────────────────────────────────────
  function queueSorter(now) {
    return function (a, b) {
      return (qRisk(b, now) - qRisk(a, now)) || (priRank(b.priority) - priRank(a.priority)) ||
             ((ms(a.queued_at) || ms(a.created_at) || 0) - (ms(b.queued_at) || ms(b.created_at) || 0));
    };
  }
  function areaText(job) {
    var t = typeOf(job);
    if (t === 'on_site') return [job.site_area, job.site_pincode].filter(Boolean).join(' · ') || 'Area not given';
    if (t === 'remote') return 'Remote';
    return 'At the shop';
  }
  function faultSummary(job) {
    var C = CAT();
    var keys = Array.isArray(job.fault_keys) ? job.fault_keys : [];
    var labels = [];
    if (C && Array.isArray(C.FAULTS)) {
      keys.forEach(function (k) { var f = C.FAULTS.find(function (x) { return x.key === k; }); if (f && f.label) labels.push(f.label); });
    }
    if (labels.length) return labels.join(', ');
    var s = String(job.reported_fault || '').split('\n')[0].trim();
    return s.length > 90 ? s.slice(0, 88) + '…' : s;
  }
  function queueViewHtml(rows, now) {
    var mine = myEmail();
    var q = rows.filter(inQueue);
    var sn = srvNow();
    // Offered to me (answer before it runs out — soonest first; a lead may be
    // offering me one somebody else still holds), then asked for me by name.
    var offered = rows.filter(function (j) { return j.stage !== 'closed' && offeredToMe(j, sn); })
                   .sort(function (a, b) { return (ms(a.offer_expires_at) || 0) - (ms(b.offer_expires_at) || 0); });
    var forMe = offered.concat(q.filter(function (j) {
      return !offeredToMe(j, sn) && mine && lower(j.suggested_tech_email) === mine;
    }).sort(queueSorter(now)));
    var rest = q.filter(function (j) { return forMe.indexOf(j) === -1; }).sort(queueSorter(now));
    var noTime = rows.filter(function (j) {
      return typeOf(j) === 'on_site' && j.assignee_email && ms(j.visit_start) == null &&
             j.stage !== 'closed' && j.stage !== 'work_done' && (!mineOnly || isMine(j));
    }).sort(function (a, b) {
      if (isMine(a) !== isMine(b)) return isMine(a) ? -1 : 1;
      return (ms(a.assigned_at) || 0) - (ms(b.assigned_at) || 0);
    });
    var html = '';
    if (!isTechPlus()) html += '<p class="sv-hint sv2-lead-line">Technicians take tickets from here. You can see who is waiting and for how long.</p>';
    else if (!inPool()) html += '<p class="sv-hint sv2-lead-line">' + esc(noPoolText()) +
      (isLead() ? ' Offer a ticket to a technician instead — they have a short time to accept it.' : ' Ask a lead to add you to it.') + '</p>';
    html += '<div class="sv2-queue">' +
      qcol('For you', 'Offered to you — answer before it runs out — or asked for you by name.', forMe, 'mine', now) +
      qcol('Open queue', 'Most urgent first, then the longest waiting. Not claimed in 4 hours, the app offers it to the best free technician.', rest, 'open', now) +
      qcol('Claimed — no visit time', 'On-site tickets that still need a time agreed with the customer.', noTime, 'notime', now) +
    '</div>';
    if (isLead()) {
      var needs = q.filter(function (j) { return qRisk(j, now) === 2; })
                   .sort(function (a, b) { return queueAgeHours(b, now) - queueAgeHours(a, now); });
      html += needsPanelHtml(needs, now);
    }
    return html;
  }
  function qcol(title, hint, list, key, now) {
    var empty = key === 'mine' ? 'Nothing offered or asked for you.' : key === 'open' ? 'The queue is empty.' : 'Every claimed on-site ticket has a time.';
    return '<section class="sv2-qcol sv2-qcol-' + key + '" aria-label="' + esc(title) + '">' +
      '<div class="sv2-qhead"><span class="sv2-qtitle">' + esc(title) + '</span><span class="sv-col-count">' + list.length + '</span></div>' +
      '<div class="sv2-qhint">' + esc(hint) + '</div>' +
      '<div class="sv2-qcards">' + (list.length ? list.map(function (j) { return qcardHtml(j, now, key); }).join('') : '<div class="sv-empty">' + esc(empty) + '</div>') + '</div>' +
    '</section>';
  }
  function qcardHtml(job, now, col) {
    var t = typeOf(job);
    var qr = qRisk(job, now);
    var win = (job.window_start || job.window_end) ? fmtRange(job.window_start, job.window_end) : '';
    var est = fmtMinutes(job.est_minutes);
    var fault = faultSummary(job);
    var lines = '';
    lines += '<div class="sv2-qline sv2-qwhere">' + esc(firstName(job.customer_name) || 'Customer') + ' · ' + esc(areaText(job)) + '</div>';
    lines += '<div class="sv2-qline sv2-qdev">' + esc(primaryLabel(job).label) + (fault ? ' — ' + esc(fault) : '') + '</div>';
    if (win || job.window_note) lines += '<div class="sv2-qline"><span class="sv-k">Customer free</span> ' + esc([win, job.window_note].filter(Boolean).join(' · ')) + '</div>';
    if (est) lines += '<div class="sv2-qline"><span class="sv-k">Typical time</span> ' + esc(est) + '</div>';
    var chip = col !== 'notime' ? offerChipHtml(job) : '';
    if (chip) lines += '<div class="sv2-qline">' + chip + '</div>';
    if (job.suggested_tech_email && col !== 'mine') {
      lines += '<div class="sv2-qline"><span class="sv2-star">★ ' + esc(staffName(job.suggested_tech_email)) + '</span>' +
        (job.suggest_reason ? ' <span class="sv2-muted">' + esc(job.suggest_reason) + '</span>' : '') + '</div>';
    } else if (col === 'mine' && job.suggest_reason) {
      lines += '<div class="sv2-qline sv2-muted">' + esc(job.suggest_reason) + '</div>';
    }
    var foot, ageTxt;
    if (col === 'notime') {
      ageTxt = '<span class="sv2-qage">' + esc((job.assignee || staffName(job.assignee_email)) + (ms(job.assigned_at) != null ? ' · took it ' + fmtHours((now - ms(job.assigned_at)) / HOUR) + ' ago' : '')) + '</span>';
      foot = (isMine(job) || isLead() || isDeskPlus())
        ? '<button type="button" class="secondary-btn sv2-small" data-open-job="' + esc(job.id) + '" data-tab="visit">Set the time</button>' : '';
    } else {
      ageTxt = '<span class="sv2-qage' + (qr === 2 ? ' late' : qr === 1 ? ' soon' : '') + '">' + esc(fmtHours(queueAgeHours(job, now))) + ' in the queue' +
        (qr === 2 ? ' — late' : qr === 1 ? ' — due soon' : '') + '</span>';
      foot = queueFootHtml(job);
    }
    return '<div class="sv2-qcard sv2-p-' + priKey(job.priority) + (qr === 2 && col !== 'notime' ? ' q-late' : '') + '" data-job="' + esc(job.id) + '" role="button" tabindex="0" aria-label="' + esc((job.public_code || 'Ticket') + ', ' + typeLabel(t)) + '">' +
      '<div class="sv2-qtop">' + iconPair(job) + priBadge(job.priority) + '<span class="sv-code">' + esc(job.public_code || '') + '</span></div>' +
      lines +
      '<div class="sv2-qfoot">' + ageTxt + foot + '</div>' +
    '</div>';
  }
  // The action at the foot of a queue card: answer an offer made to me, claim
  // it (service-pool members), offer it (leads who can't claim), or why not.
  function queueFootHtml(job) {
    var id = esc(job.id);
    var busy = !!responding[job.id];
    if (offeredToMe(job)) {
      return '<span class="sv2-offer-acts">' +
        '<button type="button" class="primary-pink-btn sv2-small" data-accept="' + id + '"' + (busy ? ' disabled' : '') + '>Accept</button>' +
        '<button type="button" class="secondary-btn sv2-small" data-decline="' + id + '"' + (busy ? ' disabled' : '') + '>Decline…</button></span>';
    }
    if (canClaim(job)) {
      return '<button type="button" class="primary-pink-btn sv2-claim" data-claim="' + id + '"' + (claiming[job.id] ? ' disabled' : '') + '>' + (claiming[job.id] ? 'Claiming…' : 'Claim') + '</button>';
    }
    if (isLead() && !offerOther(job)) {
      return '<button type="button" class="secondary-btn sv2-small" data-offer="' + id + '"' + (busy ? ' disabled' : '') + '>Offer to…</button>';
    }
    if (!isTechPlus()) return '<span class="sv2-waiting">Waiting for a technician</span>';
    return '<span class="sv2-waiting">' + esc(claimWhy(job) || 'Waiting for a technician') + '</span>';
  }
  function needsPanelHtml(list, now) {
    return '<section class="sv2-needs" aria-label="Needs assigning">' +
      '<div class="sv2-qhead"><span class="sv2-qtitle">Needs assigning</span><span class="sv-col-count' + (list.length ? ' has-breach' : '') + '">' + list.length + '</span></div>' +
      '<div class="sv2-qhint">Nobody claimed these in 4 hours. The app offers each to the best free technician; you can offer one yourself. Only leads see this.</div>' +
      (list.length ? '<div class="sv2-needs-list">' + list.map(function (j) {
        var o = liveOffer(j);
        return '<div class="sv2-needs-row" data-job="' + esc(j.id) + '" role="button" tabindex="0">' +
          iconPair(j) + '<span class="sv-code">' + esc(j.public_code || '') + '</span>' +
          '<span class="sv2-needs-who">' + esc(firstName(j.customer_name) + ' · ' + areaText(j)) + '</span>' +
          priBadge(j.priority) +
          '<span class="sv2-qage late">' + esc(fmtHours(queueAgeHours(j, now))) + ' waiting — late</span>' +
          (j.suggested_tech_email ? '<span class="sv2-star">★ ' + esc(staffName(j.suggested_tech_email)) + '</span>' : '') +
          offerChipHtml(j) +
          (o ? '<button type="button" class="secondary-btn sv2-small" data-withdraw="' + esc(j.id) + '"' + (responding[j.id] ? ' disabled' : '') + '>Withdraw offer</button>'
             : '<button type="button" class="secondary-btn sv2-small" data-offer="' + esc(j.id) + '"' + (responding[j.id] ? ' disabled' : '') + '>Offer to…</button>') +
        '</div>';
      }).join('') + '</div>' : '<div class="sv-empty">Nothing has waited too long.</div>') +
    '</section>';
  }

  // ── visits ─────────────────────────────────────────────────────────────────
  var LIVE_VISIT = ['scheduled', 'en_route', 'on_site', 'session_booked', 'in_session'];
  function visitsViewHtml(rows, now) {
    var d0 = midnight(0), d1 = midnight(1), d2 = midnight(2);
    var timed = rows.filter(function (j) { return typeOf(j) !== 'in_store' && ms(j.visit_start) != null; });
    // A visit from before today that never finished must not fall off the list
    // just because the date rolled over.
    var missed = timed.filter(function (j) { return ms(j.visit_start) < d0 && LIVE_VISIT.indexOf(j.stage) !== -1; });
    var today = timed.filter(function (j) { var t = ms(j.visit_start); return t >= d0 && t < d1; });
    var tomorrow = timed.filter(function (j) { var t = ms(j.visit_start); return t >= d1 && t < d2; });
    var noTime = rows.filter(function (j) {
      return typeOf(j) === 'on_site' && j.assignee_email && ms(j.visit_start) == null && j.stage !== 'closed' && j.stage !== 'work_done';
    });
    if (typeFilter === 'in_store') {
      return '<div class="sv-empty sv2-pad">In-store tickets have no visits. Pick All, On-site or Remote above.</div>';
    }
    var html = '<div class="sv2-visits">';
    if (missed.length) html += dayBlock('Earlier — still open', missed, now, true);
    html += dayBlock('Today', today, now) + dayBlock('Tomorrow', tomorrow, now);
    html += '<section class="sv2-day"><div class="sv2-day-head">No time set <span class="sv-col-count">' + noTime.length + '</span></div>' +
      (noTime.length ? noTime.map(function (j) { return visitRowHtml(j, now, true); }).join('') : '<div class="sv-empty">Every claimed on-site ticket has a time.</div>') +
      '</section>';
    return html + '</div>';
  }
  function dayBlock(title, list, now, warn) {
    var groups = {}, order = [];
    list.forEach(function (j) {
      var key = lower(j.assignee_email) || '';
      if (!groups[key]) { groups[key] = { name: j.assignee || (j.assignee_email ? staffName(j.assignee_email) : 'Not assigned yet'), rows: [] }; order.push(key); }
      groups[key].rows.push(j);
    });
    order.sort(function (a, b) {
      if (!a) return 1; if (!b) return -1;
      return lower(groups[a].name) < lower(groups[b].name) ? -1 : 1;
    });
    return '<section class="sv2-day' + (warn ? ' warn' : '') + '"><div class="sv2-day-head">' + esc(title) + ' <span class="sv-col-count">' + list.length + '</span></div>' +
      (list.length ? order.map(function (k) {
        var g = groups[k];
        g.rows.sort(function (a, b) { return ms(a.visit_start) - ms(b.visit_start); });
        return '<div class="sv2-vtech"><div class="sv2-vtech-name">' + esc(g.name) + ' <span class="sv2-group-n">' + g.rows.length + '</span></div>' +
          g.rows.map(function (j) { return visitRowHtml(j, now, false); }).join('') + '</div>';
      }).join('') : '<div class="sv-empty">No visits.</div>') +
    '</section>';
  }
  function visitRowHtml(job, now, noTime) {
    var vr = vRisk(job, now);
    var marker = lateTag(vr, { soon: 'time to leave' });
    var timeTxt = noTime ? 'No time' : (fmtTime(job.visit_start) + (ms(job.visit_end) != null ? '–' + fmtTime(job.visit_end) : ''));
    return '<div class="sv2-visit" data-job="' + esc(job.id) + '" role="button" tabindex="0">' +
      '<span class="sv2-vtime' + (vr === 2 ? ' late' : '') + '">' + esc(timeTxt) + '</span>' +
      iconPair(job) +
      '<span class="sv2-vwho"><span class="sv2-vname">' + esc(job.customer_name || '—') + '</span><span class="sv2-varea">' + esc(areaText(job)) + (noTime ? ' · ' + esc(job.assignee || staffName(job.assignee_email)) : '') + '</span></span>' +
      '<span class="sv2-stage-chip b-' + ballOf(job.stage) + '">' + esc(stageLabel(job.stage)) + '</span>' +
      marker +
      '<span class="sv-code">' + esc(job.public_code || '') + '</span>' +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  THE JOB PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function panelEl() { return byId('sv-job-modal'); }
  function panelOpen() { var p = panelEl(); return !!(p && p.classList.contains('active')); }

  function initPanel() {
    var close = byId('sv-job-close');
    if (close && !close.dataset.sv2) {
      close.dataset.sv2 = '1';
      close.addEventListener('click', function () { requestClosePanel(); });
    }
    var tabs = byId('sv-job-tabs');
    if (tabs && !tabs.dataset.sv2) {
      tabs.dataset.sv2 = '1';
      tabs.setAttribute('role', 'tablist');
      tabs.addEventListener('click', function (e) {
        var t = e.target.closest('[data-tab]');
        if (t) switchTab(t.getAttribute('data-tab'));
      });
    }
    var acts = byId('sv-job-actions');
    if (acts && !acts.dataset.sv2) {
      acts.dataset.sv2 = '1';
      acts.addEventListener('click', onActionsClick);
      acts.addEventListener('keydown', enterGuard);
    }
    var body = byId('sv-job-body');
    if (body && !body.dataset.sv2) {
      body.dataset.sv2 = '1';
      body.addEventListener('click', onBodyClick);
      body.addEventListener('change', onBodyChange);
      // A scanner is used on the serial fields here too, and its Enter must not
      // reach a button. Textareas keep their newlines.
      body.addEventListener('keydown', enterGuard);
    }
  }

  async function openJob(jobIdArg, opts) {
    var jobId = jobIdArg;                          // bound once
    var token = ++openSeq;
    initServiceUI();
    var d = D();
    if (!d) { toast('The data layer did not load. Restart the app.', 'error'); return; }
    // Opened from the RMA screen or the Overview before Service was ever shown:
    // the panel still needs live updates and the minute clock.
    subscribe();
    startTimer();
    var job = jobById(jobId);
    if (!job) {
      // Not in the board's window (closed more than two days ago, or opened
      // from an older link): read that one ticket in rather than refusing.
      var miss = '';
      try {
        await d.ensureLoaded();
        if (token !== openSeq) return;
        job = jobById(jobId);
        if (!job && typeof d.fetchJob === 'function') job = await d.fetchJob(jobId);
      } catch (e) { miss = errMsg(e); }
      if (token !== openSeq) return;
      if (!job) { toast(miss ? 'Could not open that ticket: ' + miss : 'That ticket could not be found. It may have been removed.', 'warning'); return; }
    }
    // Already showing this ticket: never repaint over what is being typed —
    // at most change tab, with the same "unsaved" question a tab click asks.
    if (openJobId === jobId && panelOpen()) {
      var want = opts && opts.tab;
      if (want && want !== jobTab) await switchTab(want);
      return;
    }
    if (openJobId && openJobId !== jobId && panelOpen() && unsavedReason()) {
      var ok = await confirmLeave();
      if (!ok || token !== openSeq) return;
    }
    disposeTray();
    openJobId = jobId;
    jobTab = (opts && opts.tab) || 'details';
    formBase = null; visitBase = null; itemEditId = null; itemBase = null; waMenuOpen = false;
    paintJob();
    var m = panelEl();
    if (m) m.classList.add('active');
  }

  function unsavedReason() {
    if (!openJobId || !panelOpen()) return '';
    if (jobTab === 'details') {
      if (formBase && formBase.id === openJobId && computeDiff(formBase).keys.length) return 'unsaved changes on Details';
      if (val('sv-m-note')) return 'a move note you have not used';
    }
    if (jobTab === 'items' && itemEditId && itemDirty()) return 'an item edit you have not saved';
    if (jobTab === 'notes' && val('sv-n-body')) return 'a note you have not added';
    if (jobTab === 'photos' && photoTray && trayCount(photoTray) > 0) return 'photos you have not uploaded';
    if (jobTab === 'visit' && visitDirty()) return 'a visit time you have not saved';
    return '';
  }
  function confirmLeave() {
    var r = unsavedReason();
    if (!r) return Promise.resolve(true);
    return confirmBox('You have ' + r + '. Leave without saving?', { title: 'Unsaved changes', okText: 'Leave', cancelText: 'Stay' });
  }
  async function requestClosePanel() {
    var jobId = openJobId;
    if (jobId && unsavedReason()) {
      var ok = await confirmLeave();
      if (!ok || openJobId !== jobId) return false;
    }
    closePanelNow();
    return true;
  }
  function closePanelNow() {
    hidePassword();
    var m = panelEl();
    if (m) m.classList.remove('active');
    openJobId = null; formBase = null; visitBase = null; itemEditId = null; itemBase = null; waMenuOpen = false;
    disposeTray();
  }
  // For app.js at sign-out and whenever the login screen shows (boot too):
  // close without asking — the sign-out confirm has already said unsaved work
  // goes. Safe before the Service screen ever loaded, and nothing visible
  // happens when the panel is closed. An openJob still loading is cancelled so
  // it cannot open the panel over the login form, a field press's retry id is
  // forgotten so the next person's press is never taken for this one's, and an
  // upload still running finishes without a toast naming the ticket.
  function forceClosePanel() {
    openSeq++;
    closeEpoch++;
    lastFieldFail = null;
    stopTick();                    // the offer countdown belongs to this session
    closePanelNow();
  }
  // A toast for work started before a forced close is dropped: it would land on
  // the login screen, or in the next person's session.
  function epochToast(epoch, m, t) {
    if (epoch === closeEpoch) toast(m, t);
    else if (typeof console !== 'undefined') console.warn('Service (after sign-out): ' + m);
  }
  async function switchTab(tab) {
    var jobId = openJobId;
    if (!jobId || tab === jobTab) return;
    if (unsavedReason()) {
      var ok = await confirmLeave();
      if (!ok || openJobId !== jobId) return;
    }
    jobTab = tab;
    paintJob();
  }

  function paintJob() {
    var job = jobById(openJobId);
    if (!job) return;
    if (jobTab === 'visit' && typeOf(job) === 'in_store') jobTab = 'details';
    paintJobHeader();
    paintBody(job);
  }

  function titleName(job) {
    return contactHidden(job) ? (firstName(job.customer_name) || 'Customer') : (job.customer_name || '—');
  }
  function subLine(job) {
    var M = svc();
    var parts = [typeLabel(typeOf(job))];
    if (job.channel) parts.push(channelLabel(job.channel));
    parts.push(categoryLabel(job.category) || lbl(M && M.JOB_KINDS, job.job_kind, ''));
    parts.push(job.public_code || '');
    if (isDemo()) parts.push('DEMO');
    return parts.filter(Boolean).join(' · ');
  }

  // Repaint only the header, the action row and the tab strip. Used after a
  // write and on realtime so the ball/idle line is current WITHOUT destroying
  // anything the user has typed and not yet saved.
  function paintJobHeader() {
    var jobId = openJobId;
    var job = jobById(jobId);
    var M = svc();
    var head = byId('sv-job-ball');
    if (!job) {
      if (head && jobId) head.innerHTML = '<div class="ops-banner ops-banner-warn sv2-banner">This ticket is no longer in the list — it may have been deleted, or the demo data was switched. Close the panel.</div>';
      var acts = byId('sv-job-actions');
      if (acts) acts.innerHTML = '';
      return;
    }
    if (!M) return;
    var now = Date.now();
    setText('sv-job-title', titleName(job));
    setText('sv-job-sub', subLine(job));
    if (head) head.innerHTML = ballHtml(job, now);
    paintActions();
    paintTabs(job);
    staleCheck(job);
  }
  function ballHtml(job, now) {
    var tv = tview(job, now);
    var risk = lateOf(job, now);
    var html = '<span class="sv-ball sv-ball-' + ballCls(tv.ball) + '">' + esc(tv.sentence) + '</span>';
    var meta = priBadge(job.priority) +
      '<span class="sv-job-idle' + (risk === 2 ? ' breach' : risk === 1 ? ' soon' : '') + '">' +
        esc(fmtDays(daysIn(job, now)) + ' in this stage' + (risk === 2 ? ' · late' : risk === 1 ? ' · due soon' : '')) + '</span>';
    if (ms(job.visit_start) != null && typeOf(job) !== 'in_store' && job.stage !== 'closed') {
      meta += '<span class="sv2-when">' + esc((typeOf(job) === 'remote' ? 'Session ' : 'Visit ') + fmtRange(job.visit_start, job.visit_end)) + '</span>';
    } else if (job.promised_at && job.stage !== 'closed') {
      meta += '<span class="sv2-when">Promised ' + esc(fmtDate(job.promised_at)) + '</span>';
    }
    html += '<span class="sv2-ball-meta">' + meta + '</span>';
    var hu = holdingUnits(job.id);
    if (hu.length) {
      html += '<div class="sv2-ball-units">' + hu.map(function (u) {
        return '<span class="sv2-unit-pill b-' + rmaBall(u) + '">' + esc(u.public_code + ' · ' + rmaLabel(u.stage)) + '</span>';
      }).join('') + '</div>';
    }
    return html;
  }

  function paintActions() {
    var host = byId('sv-job-actions');
    var job = jobById(openJobId);
    if (!host || !job) return;
    var now = Date.now();
    var closed = job.stage === 'closed';
    var who;
    if (job.assignee || job.assignee_email) {
      who = '<span class="sv2-who"><span class="sv2-who-k">Technician</span> ' + esc(job.assignee || staffName(job.assignee_email)) +
        (isMine(job) ? ' <span class="sv2-you">you</span>' : '') +
        (job.assigned_via && VIA[job.assigned_via] ? ' <span class="sv2-via">' + esc(VIA[job.assigned_via]) + '</span>' : '') + '</span>';
    } else if (!closed) {
      who = '<span class="sv2-who q"><span class="sv2-who-k">In the queue</span> ' + esc(fmtHours(queueAgeHours(job, now))) +
        (job.suggested_tech_email ? ' <span class="sv2-star" title="Requested technician">★ ' + esc(staffName(job.suggested_tech_email)) + '</span>' : '') + '</span>';
    } else {
      who = '<span class="sv2-who"><span class="sv2-who-k">Closed</span> ' + esc(fmtDateTime(job.closed_at)) + '</span>';
    }
    // A live offer: to me (answer it), or to someone else (a lead may also be
    // offering it away from whoever has it now — they keep it until then).
    var chip = closed ? '' : offerChipHtml(job);
    if (chip) who += ' ' + chip;
    var busy = !!responding[job.id];
    var b = '';
    if (!closed && offeredToMe(job)) {
      b += '<button type="button" class="primary-pink-btn sv2-small" data-act="accept"' + (busy ? ' disabled' : '') + '>Accept</button>' +
           '<button type="button" class="secondary-btn sv2-small" data-act="decline"' + (busy ? ' disabled' : '') + '>Decline…</button>';
    } else if (!closed && inQueue(job) && isTechPlus() && inPool()) {
      var other = offerOther(job);
      b += '<button type="button" class="primary-pink-btn sv2-small" data-act="claim"' +
        (claiming[job.id] || other ? ' disabled' : '') + (other ? ' title="' + esc(offerUntilText(other)) + '"' : '') + '>Claim</button>';
    }
    if (!closed && job.assignee_email && (isMine(job) || isLead())) {
      var onRoad = (job.stage === 'en_route' || job.stage === 'on_site') && !isLead();
      b += '<button type="button" class="secondary-btn sv2-small" data-act="release"' + (onRoad ? ' disabled title="You are on the way or on site — ask a lead to hand it back."' : '') + '>Release…</button>';
    }
    if (!closed && isLead()) {
      b += liveOffer(job)
        ? '<button type="button" class="secondary-btn sv2-small" data-act="withdraw"' + (busy ? ' disabled' : '') + '>Withdraw offer</button>'
        : '<button type="button" class="secondary-btn sv2-small" data-act="offer"' + (busy ? ' disabled' : '') + '>Offer to…</button>';
    }
    if (!contactHidden(job)) {
      b += '<button type="button" class="secondary-btn sv2-small" data-act="wa" aria-haspopup="menu" aria-expanded="' + (waMenuOpen ? 'true' : 'false') + '">Message ▾</button>';
    }
    if (job.public_code) b += '<button type="button" class="secondary-btn sv2-small" data-act="copy">Copy tracking link</button>';
    host.innerHTML = '<div class="sv2-act-who">' + who + '</div><div class="sv2-act-btns">' + b + '</div>' + (waMenuOpen ? waMenuHtml(job) : '');
    if (chip) ensureTick();
  }
  function waMenuHtml(job) {
    var t = typeOf(job);
    var items = WA_ITEMS.filter(function (w) {
      if (w.types.indexOf(t) === -1) return false;
      if (w.needsVisit && ms(job.visit_start) == null) return false;
      return true;
    });
    return '<div class="sv2-menu sv2-wa-menu" role="menu">' + items.map(function (w) {
      var label = (w.key === 'visit_booked' && t === 'remote') ? 'Session booked' : w.label;
      return '<button type="button" role="menuitem" data-act="wa-pick" data-tpl="' + w.key + '">' + esc(label) + '</button>';
    }).join('') + '<div class="sv2-menu-note">Opens WhatsApp with the message ready. You press send.</div></div>';
  }
  function onActionsClick(e) {
    // The row is repainted below, which detaches the clicked button; flag the
    // event so the document-level "click outside closes the menu" check does
    // not mistake this click for one outside the row.
    e.svInsideActions = true;
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act === 'claim') claimFlow(openJobId);
    else if (act === 'release') releaseDialog(openJobId);
    else if (act === 'offer' || act === 'assign') offerDialog(openJobId);
    else if (act === 'withdraw') withdrawOffer(openJobId);
    else if (act === 'accept') acceptFlow(openJobId);
    else if (act === 'decline') declineDialog(openJobId);
    else if (act === 'wa') { waMenuOpen = !waMenuOpen; paintActions(); }
    else if (act === 'wa-pick') { waMenuOpen = false; paintActions(); sendTemplate(b.getAttribute('data-tpl')); }
    else if (act === 'copy') copyLink();
  }

  function tabsFor(job) {
    var t = typeOf(job);
    var list = [['details', 'Details'], ['items', 'Items']];
    if (t !== 'in_store') list.push(['visit', t === 'remote' ? 'Session' : 'Visit']);
    list.push(['photos', 'Photos'], ['notes', 'Notes']);
    return list;
  }
  function paintTabs(job) {
    var host = byId('sv-job-tabs');
    if (!host) return;
    var n = itemsOf(job.id).length;
    var u = unitsOfJob(job.id).filter(function (x) { return x.stage !== 'closed'; }).length;
    host.innerHTML = tabsFor(job).map(function (t) {
      var on = t[0] === jobTab;
      var count = t[0] === 'items' && (n || u) ? ' <span class="sv2-tabn">' + n + (u ? ' · ' + u + ' RMA' : '') + '</span>' : '';
      return '<button type="button" class="sv-tab' + (on ? ' active' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-tab="' + t[0] + '">' + esc(t[1]) + count + '</button>';
    }).join('');
  }

  function paintBody(job) {
    var body = byId('sv-job-body');
    if (!body) return;
    hidePassword();                // a repaint never carries a shown password over
    disposeTray();
    formBase = null; visitBase = null; itemEditId = null; itemBase = null;
    if (jobTab === 'details') body.innerHTML = detailsHtml(job);
    else if (jobTab === 'items') { body.innerHTML = itemsTabHtml(job); loadItemPhotoCounts(job.id); }
    else if (jobTab === 'visit') { body.innerHTML = visitTabHtml(job); loadFieldActivity(job.id); }
    else if (jobTab === 'photos') { body.innerHTML = photosTabHtml(); mountTray(job); loadPhotos(job.id); }
    else { jobTab = 'notes'; body.innerHTML = notesTabHtml(); loadTimeline(job.id); }
  }

  // Someone else moved or converted the ticket while this form was open. Say
  // so, and let the user refresh just the move box — the fields above it are
  // safe because saving only sends what was changed.
  function staleCheck(job) {
    var host = byId('sv2-d-stale');
    if (!host || jobTab !== 'details' || !formBase || formBase.id !== job.id || moveBusy) return;
    if (formBase.type !== typeOf(job)) {
      host.hidden = false;
      host.innerHTML = 'This ticket is now ' + esc(typeLabel(typeOf(job))) + '. The form below was made for the old type. ' +
        '<button type="button" class="sv-linkbtn" data-mact="reload-form">Reload the form</button>';
    } else if (formBase.hidden !== contactHidden(job)) {
      host.hidden = false;
      host.innerHTML = (formBase.hidden ? 'This ticket has been taken from the queue. '
                                        : 'This ticket went back to the queue. ') +
        '<button type="button" class="sv-linkbtn" data-mact="reload-form">Reload the form</button>';
    } else if (formBase.stage !== job.stage) {
      host.hidden = false;
      host.innerHTML = 'This ticket is now at ' + esc(stageLabel(job.stage)) + '. The move list below is out of date. ' +
        '<button type="button" class="sv-linkbtn" data-mact="refresh-move">Refresh the move box</button>';
    } else {
      host.hidden = true;
      host.innerHTML = '';
    }
  }

  // ── Details ────────────────────────────────────────────────────────────────
  function F(col, id, kind) { return { col: col, id: id, kind: kind }; }
  function baseValueOf(job, f) {
    var v = job[f.col];
    if (f.kind === 'check') return !!v;
    if (f.kind === 'consent') return !!job.remote_consent_at;
    if (f.kind === 'day') return dateInput(v);
    if (f.kind === 'dtl') return toLocalInput(v);
    return String(v == null ? '' : v).trim();
  }
  function currentValueOf(f) {
    var el = byId(f.id);
    if (!el) return undefined;                      // not painted: never written
    if (f.kind === 'check' || f.kind === 'consent') return !!el.checked;
    return String(el.value == null ? '' : el.value).trim();
  }
  function patchValueOf(f, v) {
    if (f.kind === 'check') return !!v;
    if (f.kind === 'consent') return v ? nowIso() : null;
    if (f.kind === 'day') return dayToIso(v);
    if (f.kind === 'dtl') return fromLocalInput(v);
    return v === '' ? null : v;
  }
  function computeDiff(base) {
    var out = { patch: {}, now: {}, keys: [] };
    if (!base || !base.fields) return out;
    base.fields.forEach(function (f) {
      var cur = currentValueOf(f);
      if (cur === undefined) return;
      if (cur !== base.values[f.col]) {
        out.patch[f.col] = patchValueOf(f, cur);
        out.now[f.col] = cur;
        out.keys.push(f.col);
      }
    });
    return out;
  }

  function linkedBuildHtml(buildId) {
    var canOpen = canOpenBuilds() && typeof openTicketModal === 'function';
    return '<div class="sv-linked">Built by us — build ticket #' + esc(String(buildId).slice(-6).toUpperCase()) +
      (canOpen ? ' <button type="button" class="sv-linkbtn" data-dact="open-build" data-build="' + esc(buildId) + '">Open the build</button>' : '') + '</div>';
  }
  // v1.9.11 kept the counter's intake record in a jsonb column. The migration
  // copies the device into an item but not this; show it read-only so the
  // "it wasn't scratched when I brought it in" evidence does not disappear.
  function legacyIntakeHtml(job) {
    var it = job.intake;
    if (!it || typeof it !== 'object') return '';
    var parts = [];
    if (it.accessories) parts.push(['Came in with', String(it.accessories)]);
    if (it.condition) parts.push(['Condition on arrival', String(it.condition)]);
    if (parts.length && it.powers_on_at_counter != null) parts.push(['Powered on at the counter', it.powers_on_at_counter ? 'Yes' : 'No']);
    if (it.taken_by) parts.push(['Taken in by', String(it.taken_by) + (it.taken_at ? ' · ' + fmtDateTime(it.taken_at) : '')]);
    if (!parts.length) return '';
    return '<div class="sv2-sec sv2-legacy"><div class="sv2-sec-title">Intake record (older form)</div><div class="sv-fields">' +
      parts.map(function (p) { return roField(p[0], p[1]); }).join('') + '</div></div>';
  }
  // The data answers offered today (the shop never backs up), plus this
  // ticket's own old answer so the select shows what the row holds with its
  // "(old option)" label rather than a raw key.
  function consentOptions(current) {
    var M = svc();
    var map = vocab('DATA_CONSENTS');
    var keys = (M && typeof M.dataConsentOptions === 'function') ? M.dataConsentOptions(current)
                                                                  : vocab('DATA_CONSENT_CHOICES').slice();
    if (current && keys.indexOf(current) === -1 && map[current]) keys.push(current);
    return mapOptions(map, keys, 'Not asked yet');
  }
  // "Device password" (sql/service-v2.1.sql). Display-only, like the priority
  // row, so it is swapped in place without touching the form around it. The
  // HTML never holds the password: showPassword() puts it into #sv2-pw-val
  // with textContent, for 30 seconds. data-pw-state is what the row was
  // painted from, so a realtime update repaints it only when that changed.
  function pwRowState(job) {
    return (job.has_device_password ? 'on' : 'off') + ':' + (job.stage === 'closed' ? 'closed' : 'open') + ':' +
           (contactHidden(job) ? 'hidden' : 'shown');
  }
  function passwordRow(job) {
    var on = !!job.has_device_password;
    var closed = job.stage === 'closed';
    var hidden = contactHidden(job);
    var html = '<div class="sv-field sv2-pw-field" data-pw-state="' + esc(pwRowState(job)) + '"><span>Device password</span><div class="sv2-inline">';
    if (on) {
      html += '<span class="sv2-pw-on">On file</span>';
      if (hidden) {
        html += '<span class="sv2-muted">Shown once the ticket is yours</span>';
      } else {
        html += '<button type="button" class="sv-linkbtn" data-dact="pw-show" aria-pressed="false" aria-controls="sv2-pw-val">Show</button>' +
                '<code id="sv2-pw-val" class="sv2-pw-val" hidden></code>' +
                '<button type="button" class="sv-linkbtn" data-dact="pw-copy" hidden>Copy</button>';
      }
    } else {
      html += '<span class="sv2-muted">None</span>';
    }
    if (isDeskPlus() && !closed && !hidden) {
      html += '<button type="button" class="sv-linkbtn" data-dact="pw-set">' + (on ? 'Change…' : 'Set…') + '</button>' +
              (on ? '<button type="button" class="sv-linkbtn" data-dact="pw-remove">Remove</button>' : '');
    }
    html += '</div>';
    html += '<small class="sv2-fhint">' + (closed ? 'Passwords are deleted automatically when a ticket closes.'
                                                  : 'Hidden on screen. Every view is recorded on the ticket. Deleted when the ticket closes.') + '</small>';
    return html + '</div>';
  }
  function priorityRow(job) {
    return '<div class="sv-field"><span>Priority</span><div class="sv2-inline">' + priBadge(job.priority) +
      (job.priority_reason ? '<span class="sv2-muted">' + esc(job.priority_reason) + '</span>' : '') +
      // SPEC-GAP: the RPC also lets desk change priority while a ticket is
      // logged/received; the panel follows §4.6 and offers it to leads only.
      (isLead() && job.stage !== 'closed' ? '<button type="button" class="sv-linkbtn" data-dact="priority">Change…</button>' : '') +
      '</div></div>';
  }
  function suggestRow(job) {
    var name = job.suggested_tech_email ? staffName(job.suggested_tech_email) : '';
    var can = inQueue(job) && (isDeskPlus() || lower(job.created_by_email) === myEmail());
    return '<div class="sv-field"><span>Suggested technician</span><div class="sv2-inline">' +
      (name ? '<span class="sv2-star">★ ' + esc(name) + '</span>' + (job.suggest_reason ? '<span class="sv2-muted">' + esc(job.suggest_reason) + '</span>' : '')
            : '<span class="sv2-muted">None</span>') +
      (can ? '<button type="button" class="sv-linkbtn" data-dact="suggest">' + (name ? 'Change…' : 'Suggest…') + '</button>' : '') +
      '</div></div>';
  }
  function faultChipsRO(job) {
    var C = CAT();
    var keys = Array.isArray(job.fault_keys) ? job.fault_keys : [];
    if (!keys.length) return '';
    return '<div class="sv2-ro-chips sv-span2">' + keys.map(function (k) {
      var f = C && Array.isArray(C.FAULTS) ? C.FAULTS.find(function (x) { return x.key === k; }) : null;
      return '<span class="sv2-tag">' + esc((f && f.label) || k) + '</span>';
    }).join('') + '</div>';
  }

  function detailsHtml(job) {
    var t = typeOf(job);
    var hidden = contactHidden(job);
    var fields = [];
    var html = '<div id="sv2-d-stale" class="ops-banner ops-banner-warn sv2-banner" role="status" hidden></div>';
    if (job.build_ticket_id) html += linkedBuildHtml(job.build_ticket_id);
    html += legacyIntakeHtml(job);

    // Customer
    html += '<div class="sv2-sec"><div class="sv2-sec-title">Customer</div>';
    if (hidden) {
      html += '<p class="sv-hint">The phone number and address show once the ticket is yours. Claim it from the bar above.</p>' +
        '<div class="sv-fields">' + roField('Customer', firstName(job.customer_name)) +
        (t === 'on_site' ? roField('Area', [job.site_area, job.site_pincode].filter(Boolean).join(' · ')) : '') + '</div>';
    } else {
      html += '<div class="sv-grid">' +
        field('Customer name', 'sv-e-name', job.customer_name) +
        field('Phone', 'sv-e-phone', job.customer_phone, { inputmode: 'tel', placeholder: 'Mobile (+ country code if not Indian)' }) +
        field('Email', 'sv-e-email', job.customer_email, { wide: true }) +
      '</div>';
      fields.push(F('customer_name', 'sv-e-name', 'text'), F('customer_phone', 'sv-e-phone', 'text'), F('customer_email', 'sv-e-email', 'text'));
    }
    html += '</div>';

    // The job
    html += '<div class="sv2-sec"><div class="sv2-sec-title">The job</div><div class="sv-grid">' +
      selectField('Category', 'sv-e-category', mapOptions(vocab('CATEGORIES'), null, '— Not set —'), job.category || '') +
      priorityRow(job) +
      suggestRow(job) +
      selectField('Customer data', 'sv-e-consent', consentOptions(job.data_consent), job.data_consent || '',
                  { hint: 'We don’t back up customer data. The customer backs up their own drives, on their own disks.' }) +
      passwordRow(job) +
      field('Promised date', 'sv-e-promised', dateInput(job.promised_at), { type: 'date', hint: 'Give a date after diagnosis, not before.' }) +
      field('Customer needs it by', 'sv-e-needed', dateInput(job.needed_by), { type: 'date' }) +
      field('Reported fault', 'sv-e-fault', job.reported_fault, { textarea: true, wide: true, placeholder: "In the customer's words" }) +
      faultChipsRO(job) +
      field('Diagnosis (internal)', 'sv-e-diagnosis', job.diagnosis, { textarea: true, wide: true,
            placeholder: 'What is actually wrong. Stays internal unless you share it as a note.' }) +
      field('Work done', 'sv-e-work', job.work_done, { textarea: true, wide: true }) +
    '</div>' +
    checkField('sv-e-hasdata', 'Customer data on it — we don’t back it up, so handle the drives with care', job.has_customer_data) +
    '</div>';
    fields.push(F('category', 'sv-e-category', 'select'), F('data_consent', 'sv-e-consent', 'select'),
                F('promised_at', 'sv-e-promised', 'day'), F('needed_by', 'sv-e-needed', 'day'),
                F('reported_fault', 'sv-e-fault', 'text'), F('diagnosis', 'sv-e-diagnosis', 'text'),
                F('work_done', 'sv-e-work', 'text'), F('has_customer_data', 'sv-e-hasdata', 'check'));

    // Type-specific
    if (t === 'on_site') {
      html += '<div class="sv2-sec"><div class="sv2-sec-title">The site</div>';
      if (hidden) {
        html += '<div class="sv-fields">' + roField('Area', job.site_area) + roField('Pincode', job.site_pincode) + '</div>';
      } else {
        html += '<div class="sv-grid">' +
          field('Site address', 'sv-e-saddr', job.site_address, { textarea: true, wide: true }) +
          field('Area', 'sv-e-sarea', job.site_area) +
          field('Pincode', 'sv-e-spin', job.site_pincode, { inputmode: 'numeric', maxlength: 6 }) +
          field('Landmark', 'sv-e-sland', job.site_landmark) +
          field('Site contact', 'sv-e-scontact', job.site_contact, { placeholder: 'Who to ask for, if not the customer' }) +
          field('Google Maps link', 'sv-e-smaps', job.site_maps_url, { wide: true, placeholder: 'https://maps.app.goo.gl/…' }) +
        '</div>';
        fields.push(F('site_address', 'sv-e-saddr', 'text'), F('site_area', 'sv-e-sarea', 'text'),
                    F('site_pincode', 'sv-e-spin', 'text'), F('site_landmark', 'sv-e-sland', 'text'),
                    F('site_contact', 'sv-e-scontact', 'text'), F('site_maps_url', 'sv-e-smaps', 'text'));
      }
      html += '</div>';
    }
    if (t === 'remote') {
      html += '<div class="sv2-sec"><div class="sv2-sec-title">Remote session</div><div class="sv-grid">' +
        selectField('Tool', 'sv-e-rtool', mapOptions(vocab('REMOTE_TOOLS'), null, '— Not chosen —'), job.remote_tool || '') +
        (hidden ? roField('Session ID', 'Shown once the ticket is yours') :
          field('Session ID', 'sv-e-rref', job.remote_session_ref, { hint: 'The ID only — never a password.' })) +
      '</div>' + checkField('sv-e-rconsent', 'Customer agreed to remote access' + (job.remote_consent_at ? ' (' + fmtDateTime(job.remote_consent_at) + ')' : ''), !!job.remote_consent_at) + '</div>';
      fields.push(F('remote_tool', 'sv-e-rtool', 'select'), F('remote_consent_at', 'sv-e-rconsent', 'consent'));
      if (!hidden) fields.push(F('remote_session_ref', 'sv-e-rref', 'text'));
    }
    if (t !== 'in_store') {
      html += '<div class="sv2-sec"><div class="sv2-sec-title">When the customer is free</div><div class="sv-grid">' +
        field('From', 'sv-e-wstart', toLocalInput(job.window_start), { type: 'datetime-local' }) +
        field('To', 'sv-e-wend', toLocalInput(job.window_end), { type: 'datetime-local' }) +
        field('Note', 'sv-e-wnote', job.window_note, { wide: true, placeholder: 'e.g. weekdays after 5 pm' }) +
      '</div><p class="sv-hint">The booked ' + (t === 'remote' ? 'session' : 'visit') + ' time is on the ' + (t === 'remote' ? 'Session' : 'Visit') + ' tab.</p></div>';
      fields.push(F('window_start', 'sv-e-wstart', 'dtl'), F('window_end', 'sv-e-wend', 'dtl'), F('window_note', 'sv-e-wnote', 'text'));
    }

    html += '<div class="sv-actions">' +
      '<button type="button" id="sv-e-save" class="primary-pink-btn">Save changes</button>' +
      '<span id="sv-e-status" class="sv-status" role="status"></span></div>';
    html += '<div id="sv2-movebox">' + moveBoxHtml(job) + '</div>';

    // Snapshot exactly what the form is being painted from. saveDetails diffs
    // against this and sends ONLY what the user actually changed.
    formBase = { id: job.id, stage: job.stage, type: t, hidden: hidden, fields: fields, values: {} };
    fields.forEach(function (f) { formBase.values[f.col] = baseValueOf(job, f); });
    return html;
  }

  function validateDetails(job, patch) {
    var eff = function (k) { return (k in patch) ? patch[k] : job[k]; };
    if ('customer_name' in patch && !patch.customer_name) return 'A ticket needs a customer name.';
    if ('customer_phone' in patch && !validPhone(patch.customer_phone)) {
      return 'That phone number does not look right — use the 10-digit mobile, or the full number with its country code.';
    }
    if ('customer_email' in patch && patch.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.customer_email)) {
      return 'That email address does not look right.';
    }
    if (typeOf(job) === 'on_site' && ('site_address' in patch || 'site_area' in patch) && !eff('site_address') && !eff('site_area')) {
      return 'An on-site ticket needs the site address, or at least the area.';
    }
    if ('site_pincode' in patch && patch.site_pincode && !/^\d{6}$/.test(patch.site_pincode)) return 'A pincode is six digits.';
    if ('site_maps_url' in patch && patch.site_maps_url && !/^https?:\/\//i.test(patch.site_maps_url)) {
      return 'Paste the full Google Maps link, starting with https://';
    }
    if (('window_start' in patch || 'window_end' in patch)) {
      var a = ms(eff('window_start')), b = ms(eff('window_end'));
      if (a != null && b != null && b <= a) return 'The customer’s window ends before it starts.';
    }
    if ('promised_at' in patch && byId('sv-e-promised') && val('sv-e-promised') && !patch.promised_at) return 'That promised date is not valid.';
    if ('needed_by' in patch && byId('sv-e-needed') && val('sv-e-needed') && !patch.needed_by) return 'That date is not valid.';
    return '';
  }

  // The changes worth a line in the history. Internal: these are bench facts.
  // SPEC-GAP: NeoQcData has no "edit event" write, so the line goes in as an
  // internal note through addNote, the only event write the data layer offers.
  function changeSummary(patch) {
    var out = [];
    if ('promised_at' in patch) out.push(patch.promised_at ? 'Promised ' + fmtDate(patch.promised_at) : 'Promised date cleared');
    if ('needed_by' in patch) out.push(patch.needed_by ? 'Needed by ' + fmtDate(patch.needed_by) : 'Needed-by date cleared');
    if ('diagnosis' in patch) out.push('Diagnosis recorded');
    if ('work_done' in patch) out.push('Work done updated');
    if ('category' in patch) out.push('Category: ' + (categoryLabel(patch.category) || 'not set'));
    if ('data_consent' in patch) out.push(patch.data_consent ? 'Data: ' + lbl(vocab('DATA_CONSENTS'), patch.data_consent, patch.data_consent) : 'Data answer cleared');
    if ('has_customer_data' in patch) out.push(patch.has_customer_data ? 'Marked as having customer data on it' : 'Marked as no customer data on it');
    if ('site_address' in patch || 'site_area' in patch || 'site_pincode' in patch) out.push('Site address changed');
    if ('window_start' in patch || 'window_end' in patch) out.push('Customer window changed');
    if ('remote_consent_at' in patch) out.push(patch.remote_consent_at ? 'Customer agreed to remote access' : 'Remote access consent withdrawn');
    if ('customer_phone' in patch) out.push('Phone number changed');
    return out.join(' · ');
  }

  async function saveDetails() {
    var jobId = openJobId;                         // bound once; see the file header
    var job = jobById(jobId);
    var d = D();
    var base = formBase;
    if (!job || !d) return setStatus('sv-e-status', 'This ticket is not loaded.', 'err');
    if (!base || base.id !== jobId) return setStatus('sv-e-status', 'This panel is out of date — reopen the ticket.', 'err');
    if (saveBusy) return;
    var diff = computeDiff(base);
    if (!diff.keys.length) return setStatus('sv-e-status', 'Nothing to save.', '');
    var problem = validateDetails(job, diff.patch);
    if (problem) return setStatus('sv-e-status', problem, 'err');
    if ('site_maps_url' in diff.patch) {
      // Keep the stored coordinates in step with the link they came from.
      var ll = diff.patch.site_maps_url ? parseLatLng(diff.patch.site_maps_url) : null;
      diff.patch.site_lat = ll ? ll.lat : null;
      diff.patch.site_lng = ll ? ll.lng : null;
    }
    var code = job.public_code || 'the ticket';
    saveBusy = true;
    var btn = byId('sv-e-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setStatus('sv-e-status', 'Saving…', '');
    try {
      await d.updateJob(jobId, diff.patch);
      // The baseline moves forward ONLY for what was saved, so a later save
      // still sees anything typed since.
      diff.keys.forEach(function (k) { base.values[k] = diff.now[k]; });
      var summary = changeSummary(diff.patch);
      if (summary) {
        try { await d.addNote(jobId, summary, false); }
        catch (e) { toast('Saved, but the history line did not record: ' + errMsg(e), 'warning'); }
      }
      if (openJobId === jobId && formBase === base) {
        paintJobHeader();
        setStatus('sv-e-status', 'Saved.', 'ok');
      } else {
        toast('Saved ' + code + '.', 'success');
      }
    } catch (e) {
      demoToast(e);
      if (openJobId === jobId && formBase === base) setStatus('sv-e-status', 'Could not save: ' + errMsg(e), 'err');
      else toast('Could not save ' + code + ': ' + errMsg(e), 'error');
    } finally {
      saveBusy = false;
      var b2 = byId('sv-e-save');
      if (b2) { b2.disabled = false; b2.textContent = 'Save changes'; }
    }
  }

  // ── move box ───────────────────────────────────────────────────────────────
  function moveBoxHtml(job) {
    var t = typeOf(job);
    var moves = nextStagesFor(job) || [];
    var canConvert = job.stage !== 'closed' && job.stage !== 'ready' && !isMirror(job.stage) &&
                     TYPE_KEYS.some(function (k) { return k !== t && convTarget(t, k); });
    var opts = '<option value="">— Move to —</option>' + moves.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(stageLabel(s)) + '</option>';
    }).join('');
    return '<div class="sv-movebox">' +
      '<div class="sv2-move-head"><span class="sv-moves-label">Move this ticket on</span>' +
        (canConvert ? '<button type="button" class="sv-linkbtn" data-dact="convert">Convert type…</button>' : '') + '</div>' +
      (isMirror(job.stage) && holdingUnits(job.id).length
        ? '<p class="sv-hint">This ticket follows its RMA part and moves on by itself when the part does.</p>' : '') +
      (moves.length
        ? '<div class="sv-move-row"><select id="sv-m-stage" class="settings-select" aria-label="Move to">' + opts + '</select>' +
          '<button type="button" id="sv-m-go" class="secondary-btn" disabled>Move</button></div>'
        : '<p class="sv-hint">No other step is open from here.</p>') +
      '<div id="sv-m-extra" class="sv-m-extra"></div>' +
      '<textarea id="sv-m-note" rows="2" placeholder="What happened? Write it for the customer."></textarea>' +
      '<label class="sv-check"><input type="checkbox" id="sv-m-visible" checked> The customer can read this note</label>' +
      '<div id="sv-m-status" class="sv-status" role="status"></div>' +
      '<div id="sv2-m-help"></div>' +
    '</div>';
  }
  function outcomeOptions(job) {
    var M = svc();
    var t = typeOf(job);
    var hasUnits = unitsOfJob(job.id).length > 0;
    // The status model orders them most-likely-first for the ticket's type.
    var keys = (typeof M.outcomesFor === 'function') ? (M.outcomesFor(job) || []) : Object.keys(M.OUTCOMES);
    return keys.filter(function (k) {
      if (!Object.prototype.hasOwnProperty.call(M.OUTCOMES, k)) return false;
      if (k === 'resolved_on_site') return t === 'on_site';
      if (k === 'resolved_remotely') return t === 'remote';
      // "Returned — your part is still under warranty claim" only makes sense
      // when there is a part under claim.
      if (k === 'returned_rma_pending') return hasUnits;
      return true;
    }).map(function (k) { return { value: k, label: M.OUTCOMES[k] }; });
  }
  // The outcome a ticket at Ready already carries (a known key), else ''.
  function recordedOutcome(job) {
    var M = svc();
    var k = job && job.outcome;
    return k && M && M.OUTCOMES && Object.prototype.hasOwnProperty.call(M.OUTCOMES, k) ? String(k) : '';
  }
  function visitDefaults(job) {
    if (ms(job.visit_start) != null) return { start: toLocalInput(job.visit_start), end: toLocalInput(job.visit_end) };
    var p = visitPrefill(job);
    return { start: p.start, end: p.end };
  }
  function moveExtras(job, to) {
    var out = '';
    if (to === 'at_vendor' || to === 'parts_on_order') {
      out += field(to === 'at_vendor' ? 'Which vendor?' : 'Which supplier?', 'sv-m-party', job.waiting_party, { wide: true, placeholder: 'e.g. ASUS, Prime ABGB' });
      out += field('Expected back (optional)', 'sv-m-expected', '', { type: 'date', wide: true });
    }
    // closed as well as ready: a ticket can be closed straight from diagnosing
    // (customer declines, no fault found), and without an outcome the
    // customer's page would say the bare word "Closed".
    if (to === 'ready' || to === 'closed') {
      // Ready → closed keeps the outcome recorded at Ready (service_move does
      // the same when none is sent), so it starts selected.
      var keep = to === 'closed' && job.stage === 'ready' ? recordedOutcome(job) : '';
      var oopts = outcomeOptions(job);
      if (keep && !oopts.some(function (o) { return o.value === keep; })) oopts.unshift({ value: keep, label: svc().OUTCOMES[keep] });
      out += selectField('Outcome', 'sv-m-outcome', [{ value: '', label: '— What happened? —' }].concat(oopts), keep,
                         keep ? { wide: true, hint: 'Recorded when it went to Ready. Change it only if that was wrong.' } : { wide: true });
    }
    if ((to === 'quoted' || to === 'approved' || to === 'in_service') && !job.promised_at) {
      out += field('Promise a date now (optional)', 'sv-m-promised', '', { type: 'date', wide: true });
    }
    if (to === 'scheduled' || to === 'session_booked') {
      var v = visitDefaults(job);
      out += field(to === 'session_booked' ? 'Session starts' : 'Visit starts', 'sv-m-vstart', v.start, { type: 'datetime-local' });
      out += field('Ends', 'sv-m-vend', v.end, { type: 'datetime-local' });
    }
    return out ? '<div class="sv-grid">' + out + '</div>' : '';
  }
  // After one of OUR actions moved the ticket (claim, release, assign, a part
  // released), reset the move box — but only if nobody has started using it;
  // a half-written note is never thrown away. Otherwise the stale line says so.
  function refreshMoveIfIdle(jobId) {
    if (openJobId !== jobId || jobTab !== 'details' || moveBusy) return;
    if (val('sv-m-note') || val('sv-m-stage')) { var j = jobById(jobId); if (j) staleCheck(j); return; }
    paintMoveBox(jobId);
  }
  function paintMoveBox(jobId) {
    var host = byId('sv2-movebox');
    var job = jobById(jobId);
    if (!host || !job || openJobId !== jobId) return;
    host.innerHTML = moveBoxHtml(job);
    if (formBase && formBase.id === jobId) formBase.stage = job.stage;
    staleCheck(job);
  }

  async function doMove() {
    var jobId = openJobId;                         // bound once
    var job = jobById(jobId);
    var d = D();
    if (!job || !d || moveBusy) return;
    var to = val('sv-m-stage');
    if (!to) return;
    // The stage this move box was built for, not the live cache: realtime
    // keeps the cache current, so sending job.stage would let a move picked
    // from an out-of-date list through. service_move checks it as p_from.
    var from = (formBase && formBase.id === jobId && formBase.stage) || job.stage;
    var err = function (m) { setStatus('sv-m-status', m, 'err'); };
    if (job.stage !== from) {
      err('Someone moved this ticket to ' + stageLabel(job.stage) + ' while this box was open. Nothing was changed — check where it is now, then choose again.');
      showStaleHelp();
      return;
    }
    if (to === from) return err('This ticket is already at ' + stageLabel(to) + ' — someone else moved it.');
    var note = val('sv-m-note');
    var visible = checked('sv-m-visible');
    var extra = {};

    if (to === 'at_vendor' || to === 'parts_on_order') {
      var party = val('sv-m-party');
      if (!party) return err('Say who we are waiting on — that is the whole point of the chase list.');
      extra.waiting_party = party;
      var exp = val('sv-m-expected');
      if (exp) {
        var ed = new Date(exp + 'T10:00:00');
        if (isNaN(ed.getTime())) return err('That expected date is not valid.');
        extra.next_chase_at = ed.toISOString();
      }
    }
    if (to === 'ready' || to === 'closed') {
      var oc = val('sv-m-outcome');
      // Ready → closed with nothing picked: the server keeps the outcome
      // recorded at Ready.
      var kept = to === 'closed' && from === 'ready' && !!recordedOutcome(job);
      if (!oc && !kept) return err('Say what happened — the customer sees this, and “Closed” on its own tells them nothing.');
      if (oc) extra.outcome = oc;
    }
    var pr = val('sv-m-promised');
    if (pr) {
      var pIso = dayToIso(pr);
      if (!pIso) return err('That promised date is not valid.');
      if (ms(pIso) < midnight(0)) return err('The promised date is in the past.');
      extra.promised_at = pIso;
    }
    if (to === 'scheduled' || to === 'session_booked') {
      var vsRaw = val('sv-m-vstart'), veRaw = val('sv-m-vend');
      var vs = fromLocalInput(vsRaw), ve = fromLocalInput(veRaw);
      if (!vs) return err(to === 'scheduled' ? 'Pick the visit time.' : 'Pick the session time.');
      if (veRaw && !ve) return err('That end time is not valid.');
      if (ve && ms(ve) <= ms(vs)) return err('It ends before it starts.');
      extra.visit_start = vs;
      extra.visit_end = ve || null;
    }

    // SPEC-AMENDMENTS A21: a ticket raised before the machine arrived (sales,
    // phone, website) is photographed when the customer drops it off.
    if (from === 'logged' && to === 'received' && typeOf(job) === 'in_store' && isV2(job)) {
      custodyDialog(jobId, note, visible);
      return;
    }

    moveBusy = true;
    var btn = byId('sv-m-go');
    if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
    setStatus('sv-m-status', 'Moving…', '');
    var help = byId('sv2-m-help');
    if (help) help.innerHTML = '';
    var code = job.public_code || 'the ticket';
    try {
      // service_move checks the ticket is still at `from`, applies the patch
      // rules and writes the event in one transaction.
      await d.moveJob(jobId, from, to, note || null, visible, extra);
      moveBusy = false;
      toast('Moved ' + code + ' to ' + stageLabel(to) + '.', 'success');
      afterOwnMove(jobId, to, extra);
    } catch (e) {
      moveBusy = false;
      demoToast(e);
      var c = errCode(e), msg = errMsg(e);
      if (openJobId !== jobId) { toast('Could not move ' + code + ': ' + msg, 'error'); return; }
      setStatus('sv-m-status', msg, 'err');
      if (c === 'NEO_STALE') showStaleHelp();
      else if (c === 'NEO_RMA_HOLD') showHoldHelp(jobId, to);
      var b3 = byId('sv-m-go');
      if (b3) { b3.disabled = !val('sv-m-stage'); b3.textContent = 'Move'; }
    } finally {
      moveBusy = false;
    }
  }
  // The move box resets after our own move; the fields above keep their text.
  function afterOwnMove(jobId, to, extra) {
    if (openJobId !== jobId) return;
    // A promise set by the move updates the Details field only if the user had
    // not typed their own over it.
    if (extra && extra.promised_at && formBase && formBase.id === jobId) {
      var pin = byId('sv-e-promised');
      if (pin && val('sv-e-promised') === formBase.values.promised_at) {
        pin.value = dateInput(extra.promised_at);
        formBase.values.promised_at = pin.value;
      }
    }
    paintJobHeader();
    if (jobTab === 'details') paintMoveBox(jobId);
    if (formBase && formBase.id === jobId) formBase.stage = to;
    var live = jobById(jobId);
    if (live) staleCheck(live);
  }

  // Received at the counter after being logged elsewhere: condition photos,
  // condition chips, and — with no photos — an internal note saying so. The
  // move happens first (it is the one that can be refused); photos and notes
  // follow, and a photo that fails stays in the tray to retry with the same
  // button, which then skips the move it already made.
  async function custodyDialog(jobIdArg, note, visible) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    var T = window.NeoQcPhotoTray;
    var C = CAT();
    if (!d || !job) return;
    var code = job.public_code || 'the ticket';
    var primary = itemsOf(jobId)[0] || null;
    var chips = (C && Array.isArray(C.CONDITION_CHIPS)) ? C.CONDITION_CHIPS
      : ['No visible damage', 'Scratches', 'Dents', 'Cracked panel', 'Missing screws', 'Broken clip', 'Liquid marks', 'Burn marks', 'Seal broken', 'Dusty'];
    var html = '<p>The customer has dropped it off. Photograph its condition now — these photos settle “it was not scratched when I brought it in”.</p>' +
      '<div id="svd-custody-tray"></div>' +
      '<div class="sv-field sv-span2 sv2-mt"><span>Condition</span>' +
        chipsHtml('cond', chips.map(function (c) { return { value: c, label: c }; }), [], { multi: true, label: 'Condition' }) + '</div>' +
      field('Anything else about its condition (optional)', 'svd-cond', '', { textarea: true, wide: true, rows: 2 });
    var node = dlgNode('custody', html);
    var tray = null;
    var trayHost = node.querySelector('#svd-custody-tray');
    if (T && typeof T.create === 'function') {
      try { tray = T.create(trayHost, { roles: ['condition', 'damage', 'serial_label'], defaultRole: 'condition', allowPdf: false, minPhotos: 0, label: 'Condition photos' }); }
      catch (e) { tray = null; }
    }
    if (!tray && trayHost) trayHost.innerHTML = '<div class="sv-empty">The photo tray did not load. Add photos on the Photos tab afterwards.</div>';
    var moved = false, noPhotosOk = false, condDone = false;
    var epoch = closeEpoch;
    moveBusy = true;
    try {
      await openDialog({
        title: 'Receive ' + code, body: node, okText: 'Mark received', wide: true,
        onOk: async function (root) {
          var s = scopeOf(root, node, 'custody');
          var n = tray ? trayCount(tray) : 0;
          if (!moved && !n && !noPhotosOk) {
            var yes = await confirmBox('No condition photos. Accept without photos?', { title: 'No photos', okText: 'Accept without photos', cancelText: 'Add photos' });
            if (!yes) return false;
            noPhotosOk = true;
          }
          if (!moved) {
            try { await d.moveJob(jobId, 'logged', 'received', note || null, visible, {}); }
            catch (e) { demoToast(e); return errMsg(e); }
            moved = true;
            epochToast(epoch, 'Moved ' + code + ' to Received.', 'success');
          }
          if (!condDone) {
            condDone = true;
            var picked = readGroup(s, 'cond') || [];
            var more = nval(s, '#svd-cond');
            var text = picked.concat(more ? [more] : []).join(', ');
            if (text) {
              try {
                if (primary) {
                  var cur = String(primary.condition_remarks || '').trim();
                  await d.updateItem(primary.id, { condition_remarks: (cur ? cur + '\n' : '') + 'At drop-off: ' + text });
                } else {
                  var curJ = String((jobById(jobId) || job).condition_note || '').trim();
                  await d.updateJob(jobId, { condition_note: (curJ ? curJ + '\n' : '') + 'At drop-off: ' + text });
                }
              } catch (e) { epochToast(epoch, 'Received, but the condition notes did not save: ' + errMsg(e), 'warning'); }
            }
          }
          if (n) {
            var res;
            try { res = await T.uploadAll(tray, { jobId: jobId, itemId: primary ? primary.id : null }); }
            catch (e) { return 'Received. The photos did not upload: ' + errMsg(e) + ' Press the button again to retry them.'; }
            var failed = (res && Array.isArray(res.failed)) ? res.failed : [];
            if (failed.length) {
              return 'Received. ' + failed.length + ' photo' + (failed.length === 1 ? '' : 's') + ' did not upload' +
                     (failed[0].error ? ' (' + errMsg(failed[0].error) + ')' : '') + '. Press the button again to retry.';
            }
          } else if (noPhotosOk) {
            try { await d.addNote(jobId, 'Accepted without photos by ' + (myName() || 'staff'), false); }
            catch (e) { epochToast(epoch, 'Received, but the “no photos” note did not record: ' + errMsg(e), 'warning'); }
          }
          return true;
        }
      });
    } finally {
      moveBusy = false;
      var left = tray ? trayCount(tray) : 0;
      if (moved && left) epochToast(epoch, left + ' condition photo' + (left === 1 ? ' was' : 's were') + ' not uploaded for ' + code + '. Add them on its Photos tab.', 'warning');
      try { if (tray && typeof tray.destroy === 'function') tray.destroy(); } catch (e) {}
    }
    if (moved) afterOwnMove(jobId, 'received', {});
  }

  function showStaleHelp() {
    var help = byId('sv2-m-help');
    if (help) help.innerHTML = '<button type="button" class="secondary-btn sv2-small" data-mact="refresh-move">Show where it is now</button>';
  }
  function showHoldHelp(jobId, to) {
    var help = byId('sv2-m-help');
    if (!help) return;
    var job = jobById(jobId);
    var hu = holdingUnits(jobId);
    var html = '<div class="ops-banner ops-banner-info sv2-banner sv2-hold">';
    if (hu.length && canOpenRma()) {
      html += '<div class="sv2-banner-btns">' + hu.map(function (u) {
        return '<button type="button" class="sv-linkbtn" data-mact="open-rma" data-unit="' + esc(u.id) + '">Open ' + esc(u.public_code) + '</button>';
      }).join('') + '</div>';
    } else if (hu.length) {
      html += '<div>' + esc(hu.map(function (u) { return u.public_code + ' · ' + rmaLabel(u.stage); }).join(', ')) + '</div>';
    }
    // Whatever move the hold refused (ready, closed, work done, off a mirror
    // stage), the way on is the same: release the part or replace it from
    // stock. The release starts at the stage that was asked for, if it can.
    if (hu.length && job && canPartAct()) {
      var targets = releaseTargets(job);
      html += '<div class="sv2-banner-btns">' + holdButtonsHtml(job, targets.indexOf(to) !== -1 ? to : null) + '</div>' +
              (targets.length ? '' : '<div class="sv2-muted">' + esc(noReleaseText(job)) + '</div>');
    } else if (hu.length && job) {
      html += '<div class="sv2-muted">' + esc(noPartRoleText(job)) + '</div>';
    }
    help.innerHTML = html + '</div>';
  }
  async function refreshMove() {
    var jobId = openJobId;
    var d = D();
    if (!jobId || !d) return;
    var btns = document.querySelectorAll('[data-mact="refresh-move"]');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    var problem = '';
    try {
      if (typeof d.fetchJob === 'function') await d.fetchJob(jobId);
      else if (typeof d.reload === 'function') problem = statusProblem(await d.reload('jobs'));
    } catch (e) { problem = errMsg(e); }
    if (openJobId !== jobId || jobTab !== 'details') return;
    if (problem) {
      setStatus('sv-m-status', 'Could not refresh: ' + problem, 'err');
      Array.prototype.forEach.call(document.querySelectorAll('[data-mact="refresh-move"]'), function (b) { b.disabled = false; });
      return;
    }
    // The stage list is rebuilt; a half-written note is not thrown away.
    var noteEl = byId('sv-m-note'), visEl = byId('sv-m-visible');
    var keepNote = noteEl ? noteEl.value : '', keepVis = visEl ? visEl.checked : true;
    paintJobHeader();
    paintMoveBox(jobId);
    var n2 = byId('sv-m-note'), v2 = byId('sv-m-visible');
    if (n2 && keepNote) n2.value = keepNote;
    if (v2) v2.checked = keepVis;
  }

  // ── Items ──────────────────────────────────────────────────────────────────
  // What the intake recorded on the ticket itself rather than on an item
  // (a phone or website request has no items until the machine arrives).
  function jobIntakeHtml(job) {
    var bits = [];
    var acc = Array.isArray(job.accessories) ? job.accessories.filter(Boolean) : [];
    if (acc.length) bits.push(roField('Came in with', acc.join(', ')));
    if (job.powers_on === true || job.powers_on === false) bits.push(roField('At the counter', powersText(job.powers_on)));
    if (job.condition_note) bits.push(roField('Condition', job.condition_note, { wide: true }));
    if (!bits.length) return '';
    return '<div class="sv2-ticket-intake"><div class="sv-fields">' + bits.join('') + '</div></div>';
  }
  function itemsTabHtml(job) {
    return '<div class="sv2-sec"><div class="sv2-sec-head"><span class="sv2-sec-title">Items received</span>' +
        '<button type="button" class="secondary-btn sv2-small" data-iact="add">+ Add item</button></div>' +
        jobIntakeHtml(job) +
        '<div id="sv2-items">' + itemsListHtml(job) + '</div></div>' +
      '<div id="sv2-hold">' + holdBoxHtml(job) + '</div>' +
      '<div class="sv2-sec"><div class="sv2-sec-title">Parts under warranty claim</div>' +
        '<div id="sv2-units">' + unitsListHtml(job) + '</div></div>';
  }
  function itemsListHtml(job) {
    var items = itemsOf(job.id);
    if (!items.length) return '<div class="sv-empty">No items recorded on this ticket yet.</div>';
    return items.map(function (it) { return it.id === itemEditId ? itemEditHtml(it) : itemCardHtml(job, it); }).join('');
  }
  function powersText(v) { return v === true ? 'Powers on' : v === false ? 'Does not power on' : ''; }
  function itemCardHtml(job, it) {
    var src = ['neo_tokyo', 'elsewhere', 'unknown'].indexOf(it.purchase_source) !== -1 ? it.purchase_source : 'unknown';
    var units = unitsOfJob(job.id).filter(function (u) { return u.service_item_id === it.id; });
    var meta = [];
    meta.push(it.serial ? 'Serial ' + it.serial : 'No serial recorded');
    if (powersText(it.powers_on)) meta.push(powersText(it.powers_on));
    if (it.invoice_no) meta.push('Invoice ' + it.invoice_no);
    if (it.purchase_date) meta.push('Bought ' + fmtDate(it.purchase_date));
    if (it.build_ticket_id) meta.push('Build #' + String(it.build_ticket_id).slice(-6).toUpperCase());
    var acc = Array.isArray(it.accessories) ? it.accessories.filter(Boolean) : [];
    var counts = photoCounts[job.id];
    var pc = counts ? (counts[it.id] || 0) : null;
    var bInfo = it.build_ticket_id ? buildInfo[it.build_ticket_id] : null;
    var wText = bInfo && bInfo.state === 'ok' ? warrantyText(bInfo.row) : '';
    if (it.build_ticket_id && !bInfo) loadBuildInfo(it.build_ticket_id);
    return '<div class="sv2-item" data-item="' + esc(it.id) + '">' +
      '<div class="sv2-item-top"><span class="sv2-item-kind">' + esc(kindLabel(it.kind)) + '</span>' +
        '<span class="sv2-src sv2-src-' + src + '">' + esc(sourceLabel(src)) + '</span>' +
        (it.is_primary ? '<span class="sv2-tag">Main item</span>' : '') +
        '<span class="sv2-item-photos" data-item-photos="' + esc(it.id) + '">' + (pc == null ? '' : esc(pc + ' photo' + (pc === 1 ? '' : 's'))) + '</span>' +
      '</div>' +
      '<div class="sv2-item-label">' + esc(it.label || kindLabel(it.kind)) + '</div>' +
      '<div class="sv2-item-meta">' + esc(meta.join(' · ')) + '</div>' +
      (it.build_ticket_id ? '<div class="sv2-warranty' + (/^Our warranty ended/.test(wText) ? ' ended' : '') + '" data-build-warranty="' + esc(it.build_ticket_id) + '"' + (wText ? '' : ' hidden') + '>' + esc(wText) + '</div>' : '') +
      (acc.length ? '<div class="sv2-item-meta">Came with: ' + esc(acc.join(', ')) + '</div>' : '') +
      (it.condition_remarks ? '<div class="sv2-item-remarks">' + esc(it.condition_remarks) + '</div>' : '') +
      (units.length ? '<div class="sv2-item-rma">' + units.map(function (u) {
        return '<span class="sv2-unit-pill b-' + rmaBall(u) + '">' + esc(u.public_code + ' · ' + (u.stage === 'closed' ? 'Closed' : rmaLabel(u.stage))) + '</span>';
      }).join('') + '</div>' : '') +
      '<div class="sv2-item-actions">' +
        '<button type="button" class="secondary-btn sv2-small" data-iact="edit" data-item="' + esc(it.id) + '">Edit</button>' +
        (job.stage !== 'closed' ? '<button type="button" class="secondary-btn sv2-small" data-iact="rma" data-item="' + esc(it.id) + '">Send for RMA…</button>' : '') +
      '</div>' +
    '</div>';
  }
  function accessoryOptions(existing) {
    var C = CAT();
    var list = (C && Array.isArray(C.ACCESSORIES)) ? C.ACCESSORIES.slice() : ['Power cable', 'Charger', 'Bag', 'Box', 'Keyboard', 'Mouse', 'Wi-Fi antenna', 'HDMI / DP cable', 'Drive', 'Manual'];
    list = list.map(function (a) { return typeof a === 'string' ? a : (a && (a.label || a.value)) || ''; }).filter(Boolean);
    // Keep anything already recorded, even if it is not one of the chips —
    // dropping it would delete it on the next save.
    (existing || []).forEach(function (a) { if (a && list.indexOf(a) === -1) list.push(a); });
    return list.map(function (a) { return { value: a, label: a }; });
  }
  function powersKey(v) { return v === true ? 'yes' : v === false ? 'no' : 'unknown'; }
  function itemFormHtml(it, p) {
    var acc = Array.isArray(it.accessories) ? it.accessories.filter(Boolean) : [];
    return '<div class="sv-grid">' +
      selectField('What is it?', p + '-kind', mapOptions(vocab('ITEM_KINDS'), null, p === 'svd-a' ? '— Choose —' : null), it.kind || (p === 'svd-a' ? '' : 'other')) +
      field('Make / model', p + '-label', it.label, { placeholder: 'e.g. ASUS TUF RTX 4070 Ti' }) +
      field('Serial (as printed on the label)', p + '-serial', it.serial, { wide: true }) +
      '<div class="sv2-suggest sv-span2" id="' + p + '-serial-hint" role="status" hidden></div>' +
      '<div class="sv-field sv-span2"><span>Where is it from?</span>' +
        chipsHtml(p + '-src', [{ value: 'neo_tokyo', label: 'Neo Tokyo build' }, { value: 'elsewhere', label: 'Bought elsewhere' }, { value: 'unknown', label: 'Not sure' }],
                  it.purchase_source || '', { label: 'Where is it from?' }) + '</div>' +
      '<div class="sv-field"><span id="' + p + '-build-l">Build ticket (if we built it)</span><span class="sv2-inline">' +
        '<input type="text" id="' + p + '-build" value="' + esc(it.build_ticket_id || '') + '" placeholder="t_…" autocomplete="off" spellcheck="false" aria-labelledby="' + p + '-build-l">' +
        (canFindBuilds() ? '<button type="button" class="secondary-btn sv2-small" data-find-build="' + p + '">Find…</button>' : '') +
      '</span></div>' +
      field('Invoice number', p + '-invoice', it.invoice_no) +
      field('Purchase date', p + '-pdate', it.purchase_date ? String(it.purchase_date).slice(0, 10) : '', { type: 'date' }) +
      '<div class="sv-field"><span>Powers on?</span>' +
        chipsHtml(p + '-powers', [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: 'Not checked' }],
                  powersKey(it.powers_on), { label: 'Powers on?' }) + '</div>' +
      '<div class="sv-field sv-span2"><span>Came in with</span>' + chipsHtml(p + '-acc', accessoryOptions(acc), acc, { multi: true, label: 'Came in with' }) + '</div>' +
      field('Condition remarks', p + '-remarks', it.condition_remarks, { textarea: true, wide: true, placeholder: 'Scratches, dents, missing screws, liquid marks…' }) +
    '</div>';
  }
  // ── Finding the build an item came from (SPEC-AMENDMENTS A20) ──
  // Build tickets carry no phone number, so the link is found by receipt code,
  // customer name or a serial. A serial typed on an item is checked quietly; a
  // match is a suggestion, never a scan step.
  function canFindBuilds() { var d = D(); return !!(d && typeof d.findBuilds === 'function') && !isDemo(); }
  function warrantyMonths() { var C = CAT(); var n = C && Number(C.OUR_WARRANTY_MONTHS); return n > 0 ? n : 6; }
  function warrantyText(b) {
    var base = ms(b && (b.handed_over_at || b.completed_at));
    if (base == null) return '';
    var until = new Date(base);
    until.setMonth(until.getMonth() + warrantyMonths());
    var iso = until.toISOString();
    return until.getTime() > Date.now() ? 'In our warranty until ' + fmtDate(iso) : 'Our warranty ended ' + fmtDate(iso);
  }
  function buildLine(b) {
    var bits = ['#' + (b.code || String(b.id || '').slice(-6).toUpperCase())];
    if (b.customer_name) bits.push(b.customer_name);
    var when = b.handed_over_at || b.completed_at || b.created_at;
    if (when) bits.push(new Date(ms(when)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }));
    return bits.join(' · ');
  }
  var buildInfo = {};             // build ticket id -> { state: 'loading'|'ok'|'none', row }
  function loadBuildInfo(buildId) {
    var d = D();
    if (!buildId || buildInfo[buildId] || !canFindBuilds()) return;
    buildInfo[buildId] = { state: 'loading' };
    var code = String(buildId).slice(-6).toUpperCase();
    d.findBuilds(code).then(function (rows) {
      var hit = (rows || []).find(function (r) { return r && String(r.id) === String(buildId); });
      buildInfo[buildId] = hit ? { state: 'ok', row: hit } : { state: 'none' };
      paintWarranty(buildId);
    }, function () {
      // A warranty hint that cannot load is not worth an error; forget it so
      // the next open of the tab tries again.
      delete buildInfo[buildId];
    });
  }
  function paintWarranty(buildId) {
    var body = byId('sv-job-body');
    if (!body) return;
    var info = buildInfo[buildId];
    Array.prototype.forEach.call(body.querySelectorAll('[data-build-warranty]'), function (el) {
      if (el.getAttribute('data-build-warranty') !== String(buildId)) return;
      var t = info && info.state === 'ok' ? warrantyText(info.row) : '';
      el.textContent = t;
      el.hidden = !t;
      el.classList.toggle('ended', /^Our warranty ended/.test(t));
    });
  }
  async function serialHint(input, p) {
    var d = D();
    var hint = document.getElementById(p + '-serial-hint');
    var build = document.getElementById(p + '-build');
    if (!input || !hint || !canFindBuilds()) return;
    var serial = String(input.value || '').trim();
    hint.hidden = true; hint.innerHTML = '';
    if (alnum(serial).length < 5 || (build && build.value.trim())) return;
    var rows;
    try { rows = await d.findBuilds(serial); } catch (e) { return; /* a suggestion only */ }
    // The person may have typed on, or the form may be gone.
    if (!input.isConnected || String(input.value || '').trim() !== serial) return;
    var hit = (rows || []).find(function (r) { return r && r.match === 'serial'; });
    if (!hit || !/^t_[a-z0-9]+$/i.test(String(hit.id))) return;
    hint.innerHTML = 'This serial is in build ' + esc(buildLine(hit)) + '. ' +
      '<button type="button" class="sv-linkbtn" data-link-build="' + esc(hit.id) + '" data-prefix="' + p + '">Link it</button>';
    hint.hidden = false;
  }
  // Queried inside `scope`, never by document id: while "Find the build" is
  // open on top of the Add item dialog, that dialog is parked off-document.
  function linkBuild(scope, p, buildId) {
    if (!scope || !/^[a-z-]+$/.test(String(p || ''))) return;
    var input = scope.querySelector('#' + p + '-build');
    if (input) input.value = buildId;
    var g = scope.querySelector('[data-group="' + p + '-src"]');
    if (g) Array.prototype.forEach.call(g.querySelectorAll('.sv2-chip'), function (x) { markOpt(x, x.getAttribute('data-value') === 'neo_tokyo'); });
    var hint = scope.querySelector('#' + p + '-serial-hint');
    if (hint) { hint.hidden = true; hint.innerHTML = ''; }
  }
  async function findBuildDialog(p, scope) {
    var d = D();
    if (!canFindBuilds() || !scope || !/^[a-z-]+$/.test(String(p || ''))) return;
    var target = scope.querySelector('#' + p + '-build');
    if (!target) return;
    var node = dlgNode('findbuild',
      '<p class="sv-hint">Search by the 6-character receipt code, the customer’s name, or a serial number.</p>' +
      '<div class="sv2-inline"><input type="text" id="svd-fb-q" placeholder="e.g. 7KQ2PX, Arjun, or a serial" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="secondary-btn sv2-small" id="svd-fb-go">Search</button></div>' +
      '<div id="svd-fb-res" class="sv2-mt" role="status"></div>');
    var seq = 0;
    var run = async function () {
      var q = nval(node, '#svd-fb-q');
      var res = node.querySelector('#svd-fb-res');
      if (!res) return;
      if (q.length < 2) { res.innerHTML = '<p class="sv-hint">Type at least two characters.</p>'; return; }
      var my = ++seq;
      res.innerHTML = '<div class="sv-empty">Searching…</div>';
      var rows;
      try { rows = await d.findBuilds(q); }
      catch (e) { if (my === seq) res.innerHTML = '<div class="sv-empty">Could not search: ' + esc(errMsg(e)) + '</div>'; return; }
      if (my !== seq) return;
      rows = (rows || []).filter(function (r) { return r && /^t_[a-z0-9]+$/i.test(String(r.id)); });
      res.innerHTML = rows.length
        ? choicesHtml('fb', rows.map(function (r) {
            return { value: String(r.id), title: buildLine(r), sub: [r.summary, warrantyText(r)].filter(Boolean).join(' · ') };
          }), rows.length === 1 ? String(rows[0].id) : '')
        : '<div class="sv-empty">No build matches that.</div>';
    };
    var timer = null;
    node.addEventListener('click', function (e) { if (e.target.closest('#svd-fb-go')) run(); });
    node.addEventListener('input', function (e) {
      if (e.target.id !== 'svd-fb-q') return;
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    });
    await openDialog({
      title: 'Find the build', body: node, okText: 'Link this build',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'findbuild');
        var id = readGroup(s, 'fb');
        if (!id) return 'Search, then pick the build.';
        linkBuild(scope, p, id);
        return true;
      }
    });
    clearTimeout(timer);
  }

  function itemValues(it) {
    return {
      kind: it.kind || 'other', label: String(it.label || '').trim(), serial: String(it.serial || '').trim(),
      purchase_source: it.purchase_source || '', build_ticket_id: String(it.build_ticket_id || '').trim(),
      invoice_no: String(it.invoice_no || '').trim(), purchase_date: it.purchase_date ? String(it.purchase_date).slice(0, 10) : '',
      condition_remarks: String(it.condition_remarks || '').trim(),
      accessories: Array.isArray(it.accessories) ? it.accessories.filter(Boolean) : [],
      powers_on: it.powers_on === true ? true : it.powers_on === false ? false : null
    };
  }
  function readItemForm(scope, p) {
    var pw = readGroup(scope, p + '-powers');
    var acc = readGroup(scope, p + '-acc');
    return {
      kind: nval(scope, '#' + p + '-kind'), label: nval(scope, '#' + p + '-label'), serial: nval(scope, '#' + p + '-serial'),
      purchase_source: readGroup(scope, p + '-src') || '', build_ticket_id: nval(scope, '#' + p + '-build'),
      invoice_no: nval(scope, '#' + p + '-invoice'), purchase_date: nval(scope, '#' + p + '-pdate'),
      condition_remarks: nval(scope, '#' + p + '-remarks'),
      accessories: Array.isArray(acc) ? acc : [],
      powers_on: pw === 'yes' ? true : pw === 'no' ? false : null
    };
  }
  function validateItem(v) {
    if (!v.kind) return 'Say what the item is.';
    if (!v.purchase_source) return 'Say where it is from — “Not sure” is fine.';
    if (v.build_ticket_id && !/^t_[a-z0-9]+$/i.test(v.build_ticket_id)) return 'A build ticket id looks like t_… — copy it from the build.';
    if (v.purchase_date && isNaN(new Date(v.purchase_date + 'T12:00:00').getTime())) return 'That purchase date is not valid.';
    return '';
  }
  function diffItem(a, b) {
    var patch = {}, n = 0;
    Object.keys(a).forEach(function (k) {
      var x = a[k], y = b[k];
      var same = Array.isArray(x) ? (Array.isArray(y) && x.join('\u0001') === y.join('\u0001')) : x === y;
      if (!same) {
        n++;
        patch[k] = (typeof y === 'string' && y === '' && k !== 'purchase_source') ? null : y;
      }
    });
    return { patch: patch, n: n };
  }
  function itemEditHtml(it) {
    itemBase = { id: it.id, values: itemValues(it) };
    return '<div class="sv2-item editing" data-item="' + esc(it.id) + '">' +
      itemFormHtml(it, 'sv-i') +
      '<div class="sv-actions"><button type="button" class="primary-pink-btn sv2-small" data-iact="save">Save item</button>' +
      '<button type="button" class="secondary-btn sv2-small" data-iact="cancel">Cancel</button>' +
      '<span id="sv-i-status" class="sv-status" role="status"></span></div></div>';
  }
  function itemDirty() {
    if (!itemEditId || !itemBase || itemBase.id !== itemEditId) return false;
    var body = byId('sv-job-body');
    if (!body || !body.querySelector('#sv-i-kind')) return false;
    return diffItem(itemBase.values, readItemForm(body, 'sv-i')).n > 0;
  }
  function repaintItems(jobId) {
    var host = byId('sv2-items');
    var job = jobById(jobId);
    if (!host || !job || openJobId !== jobId) return;
    host.innerHTML = itemsListHtml(job);
  }
  async function startItemEdit(itemId) {
    var jobId = openJobId;
    if (itemEditId && itemEditId !== itemId && itemDirty()) {
      var ok = await confirmBox('Drop the changes to the other item?', { title: 'Unsaved item', okText: 'Drop them', cancelText: 'Keep editing' });
      if (!ok || openJobId !== jobId) return;
    }
    itemEditId = itemId;
    repaintItems(jobId);
  }
  function cancelItemEdit() {
    var jobId = openJobId;
    itemEditId = null; itemBase = null;
    repaintItems(jobId);
  }
  async function saveItem() {
    var jobId = openJobId;                         // bound once
    var itemId = itemEditId;
    var base = itemBase;
    var d = D();
    var body = byId('sv-job-body');
    if (!jobId || !itemId || !base || base.id !== itemId || !d || !body) return;
    var cur = readItemForm(body, 'sv-i');
    var problem = validateItem(cur);
    if (problem) return setStatus('sv-i-status', problem, 'err');
    var diff = diffItem(base.values, cur);
    if (!diff.n) return setStatus('sv-i-status', 'Nothing to save.', '');
    var btn = body.querySelector('[data-iact="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setStatus('sv-i-status', 'Saving…', '');
    try {
      await d.updateItem(itemId, diff.patch);
      if (openJobId !== jobId) { toast('Item saved.', 'success'); return; }
      if (itemEditId === itemId) { itemEditId = null; itemBase = null; }
      repaintItems(jobId);
      paintTabs(jobById(jobId));
      toast('Item saved.', 'success');
    } catch (e) {
      demoToast(e);
      if (openJobId === jobId && itemEditId === itemId) setStatus('sv-i-status', 'Could not save: ' + errMsg(e), 'err');
      else toast('Could not save the item: ' + errMsg(e), 'error');
      var b2 = byId('sv-job-body') && byId('sv-job-body').querySelector('[data-iact="save"]');
      if (b2) { b2.disabled = false; b2.textContent = 'Save item'; }
    }
  }
  async function addItemDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    var node = dlgNode('item', '<p class="sv-hint">Anything else the customer left with us — a charger, a second drive, the box.</p>' +
      itemFormHtml({ powers_on: null }, 'svd-a'));
    await openDialog({
      title: 'Add an item to ' + (job.public_code || 'this ticket'), body: node, okText: 'Add item', wide: true,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'item');
        var v = readItemForm(s, 'svd-a');
        var problem = validateItem(v);
        if (problem) return problem;
        var item = {
          kind: v.kind, label: v.label || null, serial: v.serial || null, purchase_source: v.purchase_source,
          build_ticket_id: v.build_ticket_id || null, invoice_no: v.invoice_no || null, purchase_date: v.purchase_date || null,
          condition_remarks: v.condition_remarks || null, accessories: v.accessories, powers_on: v.powers_on
        };
        try { await d.addItem(jobId, item); }
        catch (e) { demoToast(e); return errMsg(e); }
        toast('Item added to ' + (job.public_code || 'the ticket') + '.', 'success');
        if (openJobId === jobId && jobTab === 'items' && !itemEditId) repaintItems(jobId);
        return true;
      }
    });
  }

  // Release and Replaced-from-stock live on the ticket, so rma_release_hold and
  // rma_advance_replace accept the service desk as well as the RMA desk. Only
  // the "Open RM-…" links need the RMA module itself (canOpenRma).
  function canPartAct() { return isDeskPlus() || !!rmaRole(); }
  // A6 closes a ticket while some held parts stay open (lost, a decision or a
  // fee still pending). Such a ticket can only let the part go: rma_release_hold
  // never moves a closed ticket, and there is no machine left here to fit a
  // part from stock into (the RMA module still offers that on the part).
  function isClosedJob(job) { return !!job && job.stage === 'closed'; }
  function noPartRoleText(job) {
    return isClosedJob(job) ? 'Someone on the service or RMA desk can release it.'
                            : 'Someone on the service or RMA desk can release it or replace it from stock.';
  }
  // The buttons the hold box and the NEO_RMA_HOLD help offer. Replaced from
  // stock works for every open holding ticket: the server sends an in-store
  // ticket back to the bench and an on-site one to "Revisit needed".
  function holdButtonsHtml(job, preTo) {
    return (releaseTargets(job).length
              ? '<button type="button" class="secondary-btn sv2-small" data-mact="release-hold"' + (preTo ? ' data-to="' + esc(preTo) + '"' : '') + '>Release the part from this ticket…</button>' : '') +
           (isClosedJob(job) ? '' : '<button type="button" class="secondary-btn sv2-small" data-mact="advance">Replaced from stock…</button>');
  }
  function holdBoxHtml(job) {
    var hu = holdingUnits(job.id);
    if (!hu.length) return '';
    var codes = hu.map(function (u) { return u.public_code; }).join(', ');
    var one = hu.length === 1;
    if (isClosedJob(job)) {
      return '<div class="ops-banner ops-banner-info sv2-banner sv2-hold"><div><strong>This ticket is closed, but ' + esc(codes) + (one ? ' is' : ' are') + ' still tied to it.</strong> ' +
        'Release ' + (one ? 'the part — it continues' : 'the parts — they continue') + ' on ' + (one ? 'its' : 'their') + ' own in the RMA module. The ticket stays closed.</div>' +
        (!canPartAct() ? '<div class="sv2-muted">' + esc(noPartRoleText(job)) + '</div>'
                       : '<div class="sv2-banner-btns">' + holdButtonsHtml(job, null) + '</div>') +
      '</div>';
    }
    var canRelease = releaseTargets(job).length > 0;
    var onSite = typeOf(job) === 'on_site' && isV2(job);
    return '<div class="ops-banner ops-banner-info sv2-banner sv2-hold"><div><strong>This ticket waits for ' + esc(codes) + '.</strong> ' +
      'It moves on by itself as the part does.' +
      (canRelease ? (onSite ? ' If the job should finish without it, release the part.' : ' If the customer needs the machine back first, release the part.') : '') + '</div>' +
      (!canPartAct() ? '<div class="sv2-muted">' + esc(noPartRoleText(job)) + '</div>'
                     : '<div class="sv2-banner-btns">' + holdButtonsHtml(job, null) + '</div>' +
                       (canRelease ? '' : '<div class="sv2-muted">' + esc(noReleaseText(job)) + '</div>')) +
    '</div>';
  }
  function unitsListHtml(job) {
    var units = unitsOfJob(job.id);
    if (!units.length) return '<div class="sv-empty">No parts sent for RMA from this ticket.</div>';
    var now = Date.now();
    units.sort(function (a, b) {
      if ((a.stage === 'closed') !== (b.stage === 'closed')) return a.stage === 'closed' ? 1 : -1;
      return (ms(b.created_at) || 0) - (ms(a.created_at) || 0);
    });
    var canOpen = canOpenRma();
    var holdTag = isClosedJob(job) ? 'Not released yet' : 'Ticket waits for it';
    return units.map(function (u) {
      var vn = vendorName(u);
      var closed = u.stage === 'closed';
      var meta = [];
      if (vn) meta.push(vn);
      if (!closed) meta.push(fmtDays(daysIn(u, now)) + ' in this stage');
      if (u.stage === 'with_vendor' && u.expected_back_at) meta.push('expected back ' + fmtDate(u.expected_back_at));
      if (closed && u.closed_at) meta.push('closed ' + fmtDate(u.closed_at));
      var risk = closed ? 0 : rmaRiskOf(u, now);
      return '<div class="sv2-unit' + (closed ? ' closed' : '') + '">' +
        '<div class="sv2-unit-top"><span class="sv-code">' + esc(u.public_code || '') + '</span>' +
          '<span class="sv2-stage-chip b-' + (closed ? 'nobody' : rmaBall(u)) + '">' + esc(closed ? 'Closed — ' + dispositionText(u.disposition) : rmaLabel(u.stage)) + '</span>' +
          (u.holds_ticket && !closed ? '<span class="sv2-holds">' + holdTag + '</span>' : '') +
          lateTag(risk) +
        '</div>' +
        '<div class="sv2-unit-label">' + esc(unitLabel(u)) + '</div>' +
        (meta.length ? '<div class="sv2-unit-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        (canOpen ? '<button type="button" class="sv-linkbtn" data-mact="open-rma" data-unit="' + esc(u.id) + '">Open in RMA</button>' : '') +
      '</div>';
    }).join('');
  }
  function refreshItemsLive(jobId) {
    var job = jobById(jobId);
    if (!job || openJobId !== jobId || jobTab !== 'items') return;
    var u = byId('sv2-units'); if (u) u.innerHTML = unitsListHtml(job);
    var h = byId('sv2-hold'); if (h) h.innerHTML = holdBoxHtml(job);
    if (!itemEditId) repaintItems(jobId);
  }
  function normMedia(res) {
    var rows = Array.isArray(res) ? res : ((res && (res.rows || res.data)) || []);
    var urls = res && !Array.isArray(res) && res.urls;
    if (urls) rows.forEach(function (r) { if (!r.url && urls[r.path]) r.url = urls[r.path]; });
    return rows.slice();
  }
  async function loadItemPhotoCounts(jobId) {
    var d = D();
    if (!d || typeof d.media !== 'function') return;
    var rows;
    try { rows = normMedia(await d.media({ jobId: jobId, includeUnits: false })); }
    catch (e) { return; /* counts are a nicety; the item list stands without them */ }
    if (openJobId !== jobId) return;
    var counts = {};
    rows.forEach(function (r) { if (r.service_item_id && !r.rma_case_id) counts[r.service_item_id] = (counts[r.service_item_id] || 0) + 1; });
    photoCounts[jobId] = counts;
    if (jobTab !== 'items') return;
    var body = byId('sv-job-body');
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll('[data-item-photos]'), function (el) {
      var n = counts[el.getAttribute('data-item-photos')] || 0;
      el.textContent = n + ' photo' + (n === 1 ? '' : 's');
    });
  }

  // Splits "ASUS TUF RTX 4070 Ti" into brand and model when the first words
  // match a vendor we know, so the RMA starts with the vendor already picked.
  function splitBrand(label) {
    var s = String(label || '').trim();
    if (!s) return { brand: '', model: '', vendorId: null };
    var low = s.toLowerCase();
    var vs = vendorsList().slice().sort(function (a, b) { return String(b.name || '').length - String(a.name || '').length; });
    for (var i = 0; i < vs.length; i++) {
      var n = String(vs[i].name || '').toLowerCase();
      if (n && (low === n || low.indexOf(n + ' ') === 0)) {
        return { brand: vs[i].name, model: s.slice(n.length).trim(), vendorId: vs[i].id };
      }
    }
    return { brand: '', model: s, vendorId: null };
  }
  function feeFor(kind) {
    var C = CAT();
    if (C && typeof C.handlingFee === 'function') { try { var f = C.handlingFee(kind); if (f != null) return f; } catch (e) {} }
    var def = (C && C.DEFAULT_HANDLING_FEE) || 300;
    var m = (C && C.HANDLING_FEE_BY_KIND) || {};
    return m[kind] != null ? m[kind] : def;
  }
  async function sendRmaDialog(itemId) {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    var item = itemsOf(jobId).find(function (x) { return x.id === itemId; });
    if (!d || !job || !item) return;
    if (job.stage === 'closed') { toast('This ticket is closed. Log the part in the RMA module instead.', 'info'); return; }
    var t = typeOf(job);
    var holdType = t === 'in_store' || t === 'on_site';
    // SPEC-AMENDMENTS A4: a part may hold the ticket only while the ticket is
    // where the RMA sync acts. Sending the WHOLE device (the ticket's main item,
    // same kind) always holds it, so that is only possible from there too.
    var inZone = SYNC_ZONE.indexOf(job.stage) !== -1;
    var split = splitBrand(item.label);
    var kind = item.kind || 'other';
    var already = unitsOfJob(jobId).filter(function (u) { return u.service_item_id === itemId && u.stage !== 'closed'; });
    var vendors = vendorsList();
    var crid = uuid();                              // one per dialog: a retry cannot duplicate
    var vendorOpts = [{ value: '', label: 'Choose later' }].concat(vendors.map(function (v) { return { value: String(v.id), label: v.name }; }));
    // A14: a legacy ticket already at a vendor records the part where it is.
    var legacyAtVendor = job.stage === 'at_vendor';
    // Where the part is now decides where its RMA starts. An in-store ticket's
    // part is on our bench (received). A part our technician pulled on a site
    // visit is with them (source `field` → with_tech, SPEC-AMENDMENTS A8), and
    // the counter books it in with the custody check (A21). A remote customer
    // still has theirs, so it is expected (logged).
    var where = t === 'on_site' ? 'field' : t === 'remote' ? 'customer' : 'bench';
    var whereHint = legacyAtVendor ? ''
      : where === 'field' ? 'It starts as “With our technician”. It is booked in when it is handed in at the counter.'
      : where === 'customer' ? 'It is logged as expected. Book it in at the counter when the customer sends or brings it.' : '';
    var holdWords = t === 'on_site'
      ? [{ value: 'yes', title: 'Yes — the job waits', sub: 'We finish when the part is back.' },
         { value: 'no', title: 'No — we finish now', sub: 'The part follows separately.' }]
      : [{ value: 'yes', title: 'Yes — the PC stays', sub: 'It waits here until the part is back.' },
         { value: 'no', title: 'No — the customer takes the PC', sub: 'The part follows separately.' }];
    var stageWords = stageLabel(job.stage);
    var wholeBlock = !holdType
      ? '<div class="ops-banner ops-banner-warn sv2-banner">A remote ticket cannot send the whole device. Convert it to in-store first.</div>'
      : !inZone
        ? '<div class="ops-banner ops-banner-warn sv2-banner">The ticket is at ' + esc(stageWords) + '. The whole machine is going, so the ticket has to wait for it — move the ticket back to Diagnosing first.</div>'
        : '<p class="sv-hint">The whole machine goes, so the ticket waits for it and follows it automatically.</p>';
    var partBlock = (holdType && inZone)
      ? '<div class="sv-field sv-span2"><span>Does the ticket wait for this part?</span>' + choicesHtml('holds', holdWords, '') + '</div>'
      : '<p class="sv-hint">' + (holdType ? 'The ticket is at ' + esc(stageWords) + ', so the part follows separately.' : 'The part follows separately from this remote ticket.') + '</p>';
    var isWhole = function (k) { return !!item.is_primary && k === kind; };
    var html = '<p class="sv-hint">Raises a warranty claim in the RMA module. The customer sees it under this ticket on their tracking page.' +
        (whereHint ? ' ' + esc(whereHint) : '') + '</p>' +
      (already.length ? '<div class="ops-banner ops-banner-warn sv2-banner">Already open for this item: ' + esc(already.map(function (u) { return u.public_code + ' (' + rmaLabel(u.stage) + ')'; }).join(', ')) + '. Only send another if it is a different part.</div>' : '') +
      (item.is_primary ? '<p class="sv-hint">Sending one part from inside the machine rather than the whole thing? Change “Part” to what it is, for example Graphics card, then give that part’s own brand, model and serial.</p>' : '') +
      '<div class="sv-grid">' +
        selectField('Part', 'svd-kind', mapOptions(vocab('ITEM_KINDS')), kind) +
        field('Brand', 'svd-brand', split.brand, { placeholder: 'e.g. ASUS' }) +
        field('Model', 'svd-model', split.model, { wide: true }) +
        field('Serial (as printed on the label)', 'svd-serial', item.serial, { wide: true, hint: 'Needed before it can ship to the vendor.' }) +
        // Not prefilled from the ticket's diagnosis: that stays internal, and
        // this text goes on the customer's tracking page.
        field('What is wrong with it?', 'svd-fault', '', { textarea: true, wide: true, rows: 3, placeholder: 'e.g. No display output; artefacts under load',
              hint: 'The customer sees this on their tracking page, and the vendor gets it.' }) +
        '<div class="sv-field sv-span2"><span>Where was it bought?</span>' +
          chipsHtml('rsrc', [{ value: 'neo_tokyo', label: 'Neo Tokyo' }, { value: 'elsewhere', label: 'Bought elsewhere' }, { value: 'unknown', label: 'Not sure' }],
                    item.purchase_source || 'unknown') + '</div>' +
        field('Invoice number', 'svd-invoice', item.invoice_no) +
        field('Purchase date', 'svd-pdate', item.purchase_date ? String(item.purchase_date).slice(0, 10) : '', { type: 'date' }) +
        field('Handling fee (₹)', 'svd-fee', String(feeFor(kind)), { type: 'number', min: 0, step: '50', showWhen: 'rsrc:elsewhere',
              hint: 'Paid handling service — the customer’s invoice is needed before it ships.' }) +
        selectField('Vendor', 'svd-vendor', vendorOpts, split.vendorId != null ? String(split.vendorId) : '', { hint: 'Optional now. Needed before it ships.' }) +
      '</div>' +
      (legacyAtVendor
        ? '<div class="sv-field sv-span2 sv2-mt"><span>This ticket is already at a vendor</span>' +
            chipsHtml('already', [{ value: 'yes', label: 'This part is already with the vendor' }], '', { optional: true }) + '</div>' +
          '<div class="sv-grid" data-show-when="already:yes">' +
            field('Vendor RMA number', 'svd-vrma', '', { placeholder: 'If the vendor gave one' }) +
            field('Expected back', 'svd-vexp', job.next_chase_at ? dateInput(job.next_chase_at) : '', { type: 'date' }) +
          '</div>'
        : '') +
      '<div class="sv2-mt" id="svd-hold-whole"' + (isWhole(kind) ? '' : ' hidden') + '>' + wholeBlock + '</div>' +
      '<div class="sv2-mt" id="svd-hold-part"' + (isWhole(kind) ? ' hidden' : '') + '>' + partBlock + '</div>';
    var node = dlgNode('rma', html);
    // The hold question depends on whether the WHOLE main item is going; the
    // document-level change handler flips the two blocks when "Part" changes.
    // It also takes the machine's own brand, model, serial and vendor out of
    // the fields for a part from inside it (and puts them back for the whole).
    if (item.is_primary) {
      node.setAttribute('data-primary-kind', kind);
      node.setAttribute('data-m-brand', split.brand || '');
      node.setAttribute('data-m-model', split.model || '');
      node.setAttribute('data-m-serial', String(item.serial || '').trim());
      node.setAttribute('data-m-vendor', split.vendorId != null ? String(split.vendorId) : '');
    }
    await openDialog({
      title: 'Send for RMA — ' + (item.label || kindLabel(kind)), body: node, okText: 'Raise the RMA', wide: true,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'rma');
        var k = nval(s, '#svd-kind');
        var fault = nval(s, '#svd-fault');
        var src = readGroup(s, 'rsrc') || 'unknown';
        if (!k) return 'Say what the part is.';
        var whole = isWhole(k);
        var holds;
        if (whole) {
          if (!holdType) return 'A remote ticket cannot send the whole device. Convert it to in-store first.';
          if (!inZone) return 'The ticket is at ' + stageWords + '. Move it back to Diagnosing first, then send the machine.';
          holds = 'yes';
        } else {
          holds = (holdType && inZone) ? readGroup(s, 'holds') : 'no';
        }
        if (!nval(s, '#svd-brand') && !nval(s, '#svd-model')) return 'Give the brand or the model so the RMA desk knows what it is.';
        // A part from inside the machine must not go out under the machine's
        // serial or name: the vendor claim and the customer's page would be wrong.
        if (item.is_primary && !whole) {
          var mSerial = String(item.serial || '').trim().toLowerCase();
          if (mSerial && nval(s, '#svd-serial').toLowerCase() === mSerial) {
            return 'That serial is the machine’s. Enter the serial printed on the ' + kindLabel(k).toLowerCase() + ' itself, or leave it empty for now.';
          }
          if (split.model && nval(s, '#svd-model') === split.model) {
            return 'The model still says the machine’s name. Enter the ' + kindLabel(k).toLowerCase() + '’s own model, or leave it empty and give the brand.';
          }
        }
        if (!fault) return 'Say what is wrong with it — the vendor asks first.';
        if (!holds) return 'Say whether the ticket waits for this part.';
        var atVendor = legacyAtVendor && readGroup(s, 'already') === 'yes';
        var pdate = nval(s, '#svd-pdate');
        if (pdate && isNaN(new Date(pdate + 'T12:00:00').getTime())) return 'That purchase date is not valid.';
        var fee = null;
        if (src === 'elsewhere') {
          var fs = nval(s, '#svd-fee');
          fee = fs === '' ? null : Number(fs);
          if (fee != null && (!isFinite(fee) || fee < 0)) return 'The handling fee must be a number, 0 or more.';
        }
        var vendorId = nval(s, '#svd-vendor');
        var vexp = atVendor ? nval(s, '#svd-vexp') : '';
        if (atVendor && !vendorId) return 'Choose the vendor it is with.';
        if (vexp && isNaN(new Date(vexp + 'T12:00:00').getTime())) return 'That expected date is not valid.';
        // A part from INSIDE the main item is not the main item: linking it to
        // the item would make the server treat it as the whole machine (and a
        // replacement serial would overwrite the machine's serial).
        var linkItem = !item.is_primary || whole;
        var unit = {
          kind: k, brand: nval(s, '#svd-brand') || null, model: nval(s, '#svd-model') || null,
          serial: nval(s, '#svd-serial') || null, fault: fault, diagnosed_by: 'us',
          purchase_source: src, invoice_no: nval(s, '#svd-invoice') || null, purchase_date: pdate || null,
          build_ticket_id: item.build_ticket_id || null, service_item_id: linkItem ? item.id : null,
          handling_fee: fee, condition_remarks: linkItem ? (item.condition_remarks || null) : null
        };
        // The vendor goes in with the part: rma_create writes it in the same
        // transaction. A later updateRma needs the RMA desk (RLS), which a
        // service desk user does not have.
        if (vendorId) {
          var vid = Number(vendorId);
          if (!(vid > 0) || Math.floor(vid) !== vid) return 'Choose the vendor from the list.';
          unit.vendor_id = vid;
        }
        if (atVendor) {
          unit.already_with_vendor = true;
          unit.vendor_rma_no = nval(s, '#svd-vrma') || null;
          unit.expected_back_at = vexp || null;
        }
        var fromField = where === 'field' && !atVendor;
        var payload = {
          client_request_id: crid, source: fromField ? 'field' : 'from_ticket', service_job_id: jobId,
          holds_ticket: holds === 'yes',
          return_method: holds === 'yes' ? 'with_device' : 'collect',
          // Only an in-store ticket's part is at the counter now. A field part
          // starts with_tech whatever this says; a remote customer's is
          // expected. SPEC-GAP: a part already at the vendor is not in our
          // hands; the server creates it at with_vendor either way (A14).
          in_hand: where === 'bench' && !atVendor, units: [unit]
        };
        if (fromField) {
          // Pulled by our technician: the server makes the ticket's customer
          // the part's owner (tracking and WhatsApp) and names the caller if
          // nobody has the ticket.
          payload.sender_kind = 'our_tech';
          payload.sender_name = job.assignee || null;
        } else {
          payload.sender_kind = 'customer';
          payload.sender_name = job.customer_name || null;
          payload.sender_phone = job.customer_phone || null;
        }
        var res;
        try { res = await d.createRma(payload); }
        catch (e) { demoToast(e); return errMsg(e); }
        var made = res && Array.isArray(res.units) ? res.units[0] : null;
        toast(((made && made.public_code) || 'RMA') + ' raised. ' +
              (holds === 'yes' ? 'The ticket now follows the part.' : 'The ticket carries on without it.') +
              (fromField ? ' Hand it in at the counter to book it in.' : (where === 'customer' && !atVendor) ? ' Book it in at the counter when it arrives.' : ''), 'success');
        if (openJobId === jobId && jobTab === 'items') refreshItemsLive(jobId);
        return true;
      }
    });
  }

  async function releaseHoldDialog(preTo) {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    var hu = holdingUnits(jobId);
    if (!hu.length) { toast('Nothing is holding this ticket any more.', 'info'); return; }
    if (!canPartAct()) { toast('Releasing a part needs the service desk or the RMA desk.', 'warning'); return; }
    var targets = releaseTargets(job);
    if (!targets.length) { toast(noReleaseText(job), 'info'); return; }
    var onSite = typeOf(job) === 'on_site' && isV2(job);
    var closed = isClosedJob(job);
    var code = job.public_code || 'The ticket';
    var words = {
      ready: { value: 'ready', title: 'Ready to collect — the part follows later', sub: 'Outcome: returned to the customer, part still under warranty claim.' },
      in_service: { value: 'in_service', title: 'Back on the bench', sub: 'We carry on with the rest of the work.' },
      work_done: { value: 'work_done', title: 'Work done — the part follows later', sub: 'The visit work is finished. The customer gets the part back separately.' },
      revisit_needed: { value: 'revisit_needed', title: 'Another visit is needed', sub: 'The ticket goes back for a follow-up visit now. The part carries on separately.' }
    };
    words[RELEASE_ONLY] = { value: RELEASE_ONLY, title: 'Release the part — it continues on its own', sub: 'The ticket stays closed. Nothing on it changes.' };
    var pre = targets.length === 1 ? targets[0] : (preTo && targets.indexOf(preTo) !== -1 ? preTo : '');
    var partsText = esc(hu.map(function (u) { return u.public_code + ' (' + unitLabel(u) + ')'; }).join(', '));
    // Every holding part goes at once. Releasing one of two would leave the
    // ticket "ready" while the other part still holds it.
    var html = (closed
        ? '<p>' + esc(code) + ' is closed, but ' + partsText + (hu.length === 1 ? ' is' : ' are') + ' still tied to it. ' +
          'Released, the part carries on in the RMA module and goes back to the customer on its own.</p>'
        : '<p>Stops the ticket waiting for ' + partsText + '. ' +
          'The part carries on in the RMA module and goes back to the customer on its own.</p>') +
      '<div class="sv-field sv-span2"><span>' + (closed ? 'What happens now?' : onSite ? 'What happens to the job now?' : 'What happens to the machine now?') + '</span>' +
        choicesHtml('jobto', targets.map(function (k) { return words[k]; }), pre) + '</div>' +
      '<div class="sv-field sv-span2 sv2-mt"><span>How does the part get back to the customer?</span>' +
        chipsHtml('rm', [{ value: 'collect', label: 'They collect it from the shop' }, { value: 'courier', label: 'Courier it to them' }], 'collect') + '</div>' +
      field('Courier address', 'svd-raddr', job.site_address || '', { textarea: true, wide: true, rows: 2, showWhen: 'rm:courier' }) +
      field('Note (optional)', 'svd-note', '', { textarea: true, wide: true, rows: 2 });
    var node = dlgNode('release-hold', html);
    await openDialog({
      title: 'Release the part from ' + (job.public_code || 'this ticket'), body: node, okText: 'Release', wide: true,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'release-hold');
        var to = readGroup(s, 'jobto');
        if (!to) return closed ? 'Choose to release the part.' : onSite ? 'Say what happens to the job now.' : 'Say what happens to the machine now.';
        var rm = readGroup(s, 'rm') || 'collect';
        var addr = nval(s, '#svd-raddr');
        if (rm === 'courier' && !addr) return 'Enter the address to courier the part to.';
        // A closed ticket gets no target (null, which ops-data.releaseHold and
        // rma_release_hold both take): the server leaves it where it is.
        // Only `ready` carries an outcome; the bench and the on-site targets
        // have none (the server clears it).
        var jobTo = to === RELEASE_ONLY ? null : to;
        var outcome = jobTo === 'ready' ? 'returned_rma_pending' : null;
        try {
          await d.releaseHold(hu.map(function (u) { return u.id; }), jobTo, outcome, nval(s, '#svd-note') || null,
                              rm === 'courier' ? 'courier' : null, rm === 'courier' ? addr : null);
        } catch (e) { demoToast(e); return errMsg(e); }
        // Say where the ticket really is: the server ignores the target when
        // the ticket closed while this dialog was open.
        var live = jobById(jobId);
        var where = live ? live.stage : jobTo;
        toast(where === 'closed' ? 'Released. ' + code + ' stays closed; the part carries on by itself.'
              : where ? 'Released. ' + code + ' is now at ' + stageLabel(where) + '.'
              : 'Released. The part carries on by itself.', 'success');
        afterServerMove(jobId);
        return true;
      }
    });
  }
  // SPEC-AMENDMENTS A5: a released ticket goes to `ready` (outcome
  // returned_rma_pending) or `in_service`. SPEC-GAP: an on-site v2 ticket has
  // neither, so rma_release_hold takes `work_done` or `revisit_needed` for it
  // (no outcome). A v1 ticket counts as in-store, as it does on the server.
  // A closed ticket never moves (rma_release_hold ignores the target there),
  // so its only choice is to let the part go: RELEASE_ONLY, sent as no target.
  function releaseTargets(job) {
    if (isClosedJob(job)) return [RELEASE_ONLY];
    var M = svc();
    var t = isV2(job) ? typeOf(job) : 'in_store';
    var list = t === 'on_site' ? ['work_done', 'revisit_needed'] : ['ready', 'in_service'];
    return list.filter(function (s) {
      if (s === job.stage) return false;
      if (!isV2(job)) return true;
      if (M && typeof M.stageLegalFor === 'function') { try { return !!M.stageLegalFor(t, s); } catch (e) {} }
      return t === 'in_store' || t === 'on_site';
    });
  }
  // Only a ticket type that cannot hold a part (remote) has nowhere to go.
  function noReleaseText() {
    return 'This ticket cannot be released from its part from where it is now. Move the part on in the RMA module, or ask a lead.';
  }
  async function advanceDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    var hu = holdingUnits(jobId);
    if (!hu.length) { toast('Nothing is holding this ticket any more.', 'info'); return; }
    if (!canPartAct()) { toast('Replacing from stock needs the service desk or the RMA desk.', 'warning'); return; }
    if (isClosedJob(job)) { toast('This ticket is closed, so nothing is fitted on it now. Release the part instead — it carries on by itself.', 'info'); return; }
    // rma_advance_replace: an on-site ticket has no bench, so it goes to
    // "Revisit needed" (only when no other part still holds it).
    var onSite = typeOf(job) === 'on_site';
    var pick = hu.length > 1
      ? '<div class="sv-field sv-span2"><span>Which part?</span>' + choicesHtml('unit', hu.map(function (u) {
          return { value: u.id, title: u.public_code + ' · ' + unitLabel(u), sub: rmaLabel(u.stage) };
        }), '') + '</div>'
      : '<p><strong>' + esc(hu[0].public_code) + '</strong> · ' + esc(unitLabel(hu[0])) + '</p>';
    var html = pick +
      '<p class="sv-hint">The customer’s machine gets a part from our stock now. The faulty part carries on to the vendor as shop stock, and the ticket ' +
        (onSite ? 'goes to Revisit needed — book the visit to fit it, or move it on if it is already fitted.' : 'goes back on the bench.') + '</p>' +
      field('Serial of the replacement (as printed on the label)', 'svd-stock', '', { wide: true }) +
      field('Note (optional)', 'svd-note', '', { textarea: true, wide: true, rows: 2 });
    var node = dlgNode('advance', html);
    await openDialog({
      title: 'Replaced from stock', body: node, okText: 'Record the replacement', wide: true,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'advance');
        var caseId = hu.length > 1 ? readGroup(s, 'unit') : hu[0].id;
        var serial = nval(s, '#svd-stock');
        if (!caseId) return 'Pick which part was replaced.';
        if (!serial) return 'Enter the serial of the part from stock — it is what the customer now has.';
        try { await d.advanceReplace(caseId, serial, nval(s, '#svd-note') || null); }
        catch (e) { demoToast(e); return errMsg(e); }
        toast('Recorded. The customer’s machine has the stock part.', 'success');
        afterServerMove(jobId);
        return true;
      }
    });
  }
  // After a part write that moved the ticket server-side. The data layer has
  // already read the parts and their ticket back; repaint what shows them.
  function afterServerMove(jobId) {
    if (openJobId !== jobId) return;
    paintJobHeader();
    refreshMoveIfIdle(jobId);
    if (jobTab === 'items') refreshItemsLive(jobId);
    var help = byId('sv2-m-help'); if (help) help.innerHTML = '';
  }

  // ── Visit ──────────────────────────────────────────────────────────────────
  function bookTarget(job) {
    var t = typeOf(job), s = job.stage, target = null;
    if (t === 'on_site' && (s === 'logged' || s === 'revisit_needed')) target = 'scheduled';
    if (t === 'remote' && s === 'logged') target = 'session_booked';
    return target && nextStagesFor(job).indexOf(target) !== -1 ? target : null;
  }
  function visitSummaryHtml(job) {
    var t = typeOf(job);
    var hidden = contactHidden(job);
    var now = Date.now();
    var vr = vRisk(job, now);
    var rows = '';
    rows += roField('Stage', '<span class="sv2-stage-chip b-' + ballOf(job.stage) + '">' + esc(stageLabel(job.stage)) + '</span>', { html: true });
    rows += roField(t === 'remote' ? 'Session' : 'Visit', ms(job.visit_start) != null
      ? fmtRange(job.visit_start, job.visit_end) + (vr === 2 ? ' — late' : vr === 1 ? ' — time to leave' : '')
      : 'Not booked yet');
    if (t === 'on_site') rows += roField('Visits made', String(Number(job.visit_count) || 0));
    rows += roField('Customer is free', [fmtRange(job.window_start, job.window_end), job.window_note].filter(Boolean).join(' · ') || 'Not given');
    if (t === 'on_site') {
      rows += roField('Area', [job.site_area, job.site_pincode].filter(Boolean).join(' · '));
      if (!hidden) {
        rows += roField('Address', [job.site_address, job.site_landmark ? 'near ' + job.site_landmark : ''].filter(Boolean).join(', '), { wide: true });
        if (job.site_contact) rows += roField('Site contact', job.site_contact);
      }
    } else {
      rows += roField('Tool', job.remote_tool ? lbl(vocab('REMOTE_TOOLS'), job.remote_tool, job.remote_tool) : 'Not chosen');
      if (!hidden) rows += roField('Session ID', job.remote_session_ref);
      rows += roField('Consent', job.remote_consent_at ? 'Customer agreed ' + fmtDateTime(job.remote_consent_at) : 'Not recorded yet');
    }
    var maps = (t === 'on_site' && !hidden && mapsUrlFor(job))
      ? '<button type="button" class="secondary-btn sv2-small" data-vact="maps">Open in Google Maps</button>' : '';
    return '<div class="sv-fields">' + rows + '</div>' + maps;
  }
  function visitTabHtml(job) {
    var t = typeOf(job);
    var target = bookTarget(job);
    var canField = t === 'on_site' && (isMine(job) || isLead()) && job.stage !== 'closed';
    var start = toLocalInput(job.visit_start), end = toLocalInput(job.visit_end);
    var html = '<div class="sv2-sec"><div id="sv2-visit-summary">' + visitSummaryHtml(job) + '</div></div>';
    if (job.stage !== 'closed') {
      html += '<div class="sv2-sec"><div class="sv2-sec-title">' + (t === 'remote' ? 'Session time' : 'Visit time') + '</div>' +
        '<div class="sv-grid">' +
          field('Starts', 'sv-v-start', start, { type: 'datetime-local' }) +
          field('Ends', 'sv-v-end', end, { type: 'datetime-local' }) +
        '</div>' +
        (target ? '<p class="sv-hint">Booking moves the ticket to ' + esc(stageLabel(target)) + ' and the customer’s page shows the time.</p>'
                : '<p class="sv-hint">The customer’s page shows the new time. Moving it adds an internal line to the history.</p>') +
        '<div class="sv-actions"><button type="button" id="sv-v-save" class="secondary-btn">' + (target ? (t === 'remote' ? 'Book this session' : 'Book this visit') : 'Save the time') + '</button>' +
        '<span id="sv-v-status" class="sv-status" role="status"></span></div></div>';
    }
    if (canField) {
      html += '<div class="sv2-sec"><div class="sv2-sec-title">On the road</div>' +
        '<p class="sv-hint">Tap these as you go. The customer’s page follows: on the way, with you, done.</p>' +
        field('Note (optional)', 'sv-f-note', '', { wide: true, placeholder: 'e.g. Customer asked us to come after lunch' }) +
        '<div class="sv2-field-btns">' +
          '<button type="button" class="secondary-btn" data-field="left_base">Left shop</button>' +
          '<button type="button" class="secondary-btn" data-field="arrived">Checked in</button>' +
          '<span class="sv2-dd"><button type="button" class="secondary-btn" data-field="out-menu" aria-haspopup="menu" aria-expanded="false">Checked out ▾</button>' +
            '<div id="sv2-out-menu" class="sv2-menu" role="menu" hidden>' + CHECKOUT.map(function (o) {
              return '<button type="button" role="menuitem" data-out="' + o.value + '">' + esc(o.label) + '</button>';
            }).join('') + '</div></span>' +
        '</div><div id="sv-f-status" class="sv-status" role="status"></div></div>';
    } else if (t === 'on_site' && job.stage !== 'closed') {
      html += '<p class="sv-hint">The field buttons are for the technician on this ticket, or a lead.</p>';
    }
    html += '<div class="sv2-sec"><div class="sv2-sec-title">Field activity</div><div id="sv2-field-list" class="sv-timeline"><div class="sv-empty">Loading…</div></div></div>';
    visitBase = { id: job.id, start: start, end: end };
    return html;
  }
  function visitDirty() {
    if (!visitBase || visitBase.id !== openJobId || !byId('sv-v-start')) return false;
    return val('sv-v-start') !== visitBase.start || val('sv-v-end') !== visitBase.end;
  }
  async function saveVisit() {
    var jobId = openJobId;                         // bound once
    var job = jobById(jobId);
    var d = D();
    var base = visitBase;
    if (!job || !d || !base || base.id !== jobId) return;
    var sRaw = val('sv-v-start'), eRaw = val('sv-v-end');
    var s = fromLocalInput(sRaw), e = fromLocalInput(eRaw);
    var err = function (m) { setStatus('sv-v-status', m, 'err'); };
    if (sRaw && !s) return err('That start time is not valid.');
    if (eRaw && !e) return err('That end time is not valid.');
    if (!s && e) return err('Set a start time too.');
    if (s && e && ms(e) <= ms(s)) return err('It ends before it starts.');
    var target = bookTarget(job);
    var booked = ['scheduled', 'en_route', 'session_booked'].indexOf(job.stage) !== -1;
    if (!s && booked) return err('A booked visit needs a time. To cancel it, release the ticket or move it on.');
    if (!target && sRaw === base.start && eRaw === base.end) return setStatus('sv-v-status', 'Nothing to change.', '');
    if (target && !s) return err(typeOf(job) === 'remote' ? 'Pick the session time.' : 'Pick the visit time.');
    var btn = byId('sv-v-save');
    if (btn) btn.disabled = true;
    setStatus('sv-v-status', 'Saving…', '');
    var code = job.public_code || 'the ticket';
    try {
      if (target) {
        await d.moveJob(jobId, job.stage, target, null, true, { visit_start: s, visit_end: e || null });
      } else {
        await d.updateJob(jobId, { visit_start: s, visit_end: e });
        try { await d.addNote(jobId, s ? 'Visit moved to ' + fmtRange(s, e) : 'Visit time cleared', false); }
        catch (x) { toast('Saved, but the history line did not record: ' + errMsg(x), 'warning'); }
      }
      base.start = sRaw; base.end = eRaw;
      toast(target ? 'Booked for ' + whenShort(s) + '.' : 'Time saved for ' + code + '.', 'success');
      if (openJobId === jobId && visitBase === base) {
        setStatus('sv-v-status', 'Saved.', 'ok');
        paintJobHeader();
        // A booking changes the stage, so the button's wording and the summary
        // change too; nothing typed is lost because the inputs hold what we saved.
        if (target) { var job2 = jobById(jobId); if (job2) { var body = byId('sv-job-body'); if (body) body.innerHTML = visitTabHtml(job2); loadFieldActivity(jobId); } }
      }
    } catch (x) {
      demoToast(x);
      if (openJobId === jobId && visitBase === base) err('Could not save: ' + errMsg(x));
      else toast('Could not save the time for ' + code + ': ' + errMsg(x), 'error');
    } finally {
      var b2 = byId('sv-v-save');
      if (b2) b2.disabled = false;
    }
  }
  async function fieldTap(kind, outcome) {
    var jobId = openJobId;                         // bound once
    var job = jobById(jobId);
    var d = D();
    if (!job || !d || fieldBusy) return;
    if (typeof d.fieldActivity !== 'function') { setStatus('sv-f-status', 'The field buttons are not available in this build.', 'err'); return; }
    var note = val('sv-f-note');
    fieldBusy = true;
    var body = byId('sv-job-body');
    var btns = body ? body.querySelectorAll('[data-field], [data-out]') : [];
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    var menu = byId('sv2-out-menu'); if (menu) menu.hidden = true;
    setStatus('sv-f-status', 'Recording…', '');
    var code = job.public_code || 'the ticket';
    // A press that failed may still have reached the server (a timeout, a
    // dropped connection). Pressing the same button again soon after reuses
    // its request id, so the server records it once, never twice.
    var last = lastFieldFail;
    var crid = (last && last.jobId === jobId && last.kind === kind && last.outcome === (outcome || null) &&
                Date.now() - last.at < 10 * MIN) ? last.crid : uuid();
    try {
      var res = await d.fieldActivity(jobId, kind, outcome || null, note || null, crid);
      lastFieldFail = null;
      var msg;
      if (res && res.duplicate) msg = 'Already recorded.';
      else if (res && res.applied) {
        msg = 'Recorded. The ticket is now at ' + stageLabel(res.stage) + '.';
        // record_field_activity clears the missed visit's time (SPEC-GAP there).
        if (outcome === 'customer_absent') msg += ' The missed visit is cleared — call the customer to book another time.';
      }
      else msg = 'Recorded. ' + ((res && res.applied_note) || 'The ticket did not move.');
      if (openJobId !== jobId) { toast(code + ': ' + msg, 'success'); return; }
      var ni = byId('sv-f-note'); if (ni) ni.value = '';
      // A press that moved the ticket can change the booking form too: "Customer
      // absent" lands at Revisit needed with the missed visit's time cleared, so
      // the old time must not sit in the inputs under a "Book this visit"
      // button. Repainted only while nothing is typed there.
      var live = jobById(jobId);
      if (res && res.applied && live && jobTab === 'visit' && !visitDirty()) {
        var vb = byId('sv-job-body');
        if (vb) vb.innerHTML = visitTabHtml(live);
      }
      setStatus('sv-f-status', msg, res && res.applied ? 'ok' : '');
      loadFieldActivity(jobId);
      paintJobHeader();
    } catch (e) {
      if (!isDemoErr(e)) lastFieldFail = { jobId: jobId, kind: kind, outcome: outcome || null, crid: crid, at: Date.now() };
      demoToast(e);
      if (openJobId === jobId) setStatus('sv-f-status', 'Not recorded: ' + errMsg(e), 'err');
      else toast('Not recorded for ' + code + ': ' + errMsg(e), 'error');
    } finally {
      fieldBusy = false;
      var b2 = byId('sv-job-body');
      if (b2) Array.prototype.forEach.call(b2.querySelectorAll('[data-field], [data-out]'), function (b) { b.disabled = false; });
    }
  }
  async function loadFieldActivity(jobId) {
    var d = D();
    var host = byId('sv2-field-list');
    if (!d || !host) return;
    var seq = ++faSeq;
    try {
      var list = (await d.events(jobId)) || [];
      if (seq !== faSeq || openJobId !== jobId || jobTab !== 'visit') return;
      host = byId('sv2-field-list');
      if (!host) return;
      list = list.filter(function (e) { return e.kind === 'field' || e.kind === 'claim' || e.kind === 'release'; })
                 .sort(function (a, b) { return (ms(b.at) || 0) - (ms(a.at) || 0); });
      host.innerHTML = list.length ? timelineHtml(list) : '<div class="sv-empty">Nothing recorded on the road yet.</div>';
    } catch (e) {
      if (seq === faSeq && openJobId === jobId) { var h = byId('sv2-field-list'); if (h) h.innerHTML = '<div class="sv-empty">Could not load: ' + esc(errMsg(e)) + '</div>'; }
    }
  }
  function openMaps() {
    var jobId = openJobId;
    var job = jobById(jobId);
    if (!job || contactHidden(job)) return;
    var url = mapsUrlFor(job);
    if (!url) { toast('No location on this ticket yet.', 'info'); return; }
    if (!openExternal(url)) toast('Could not open the map.', 'error');
  }

  // ── Photos ─────────────────────────────────────────────────────────────────
  var PHOTO_ROLES = ['condition', 'damage', 'during', 'after', 'serial_label', 'invoice'];
  function defaultPhotoRole(job) {
    if (['logged', 'received', 'diagnosing', 'scheduled', 'en_route', 'session_booked'].indexOf(job.stage) !== -1) return 'condition';
    if (['ready', 'verifying', 'closed', 'work_done', 'resolved'].indexOf(job.stage) !== -1) return 'after';
    return 'during';
  }
  function photosTabHtml() {
    return '<div class="sv2-sec"><div class="sv2-sec-title">Add photos</div><div id="sv2-ph-tray"></div>' +
        '<div class="sv-actions"><button type="button" id="sv2-ph-upload" class="primary-pink-btn">Upload</button>' +
        '<span id="sv2-ph-status" class="sv-status" role="status"></span></div>' +
        '<p class="sv-hint">Stored privately. Invoices and serial labels never show on the customer’s page.</p></div>' +
      '<div class="sv2-sec"><div class="sv2-sec-title">On this ticket</div><div id="sv2-ph-gallery"><div class="sv-empty">Loading…</div></div></div>' +
      '<div id="sv2-ph-rma"></div>';
  }
  function trayCount(tray) {
    try { if (typeof tray.count === 'function') return tray.count(); if (typeof tray.files === 'function') return tray.files().length; } catch (e) {}
    return 0;
  }
  function mountTray(job) {
    var host = byId('sv2-ph-tray');
    var T = window.NeoQcPhotoTray;
    if (!host) return;
    if (!T || typeof T.create !== 'function') { host.innerHTML = '<div class="sv-empty">The photo tray did not load. Restart the app.</div>'; return; }
    try {
      photoTray = T.create(host, { roles: PHOTO_ROLES, defaultRole: defaultPhotoRole(job), allowPdf: true, minPhotos: 0, label: 'Photos for this ticket' });
      photoTrayJobId = job.id;
    } catch (e) {
      photoTray = null; photoTrayJobId = null;
      host.innerHTML = '<div class="sv-empty">The photo tray could not start: ' + esc(errMsg(e)) + '</div>';
    }
  }
  // A tray an upload is still using is retired, not destroyed; the upload
  // finishes against the ticket it was started for, then the tray goes.
  function disposeTray() {
    if (!photoTray) return;
    if (uploadBusy) retiredTrays.push(photoTray);
    else { try { if (typeof photoTray.destroy === 'function') photoTray.destroy(); } catch (e) {} }
    photoTray = null; photoTrayJobId = null;
  }
  function destroyRetired() {
    var list = retiredTrays; retiredTrays = [];
    list.forEach(function (t) { try { if (typeof t.destroy === 'function') t.destroy(); } catch (e) {} });
  }
  async function uploadPhotos() {
    var jobId = openJobId;                         // bound once — the whole point
    var tray = photoTray;
    var T = window.NeoQcPhotoTray;
    if (!jobId || !tray || photoTrayJobId !== jobId || !T || typeof T.uploadAll !== 'function') return;
    if (uploadBusy) { toast('Still uploading the last batch.', 'warning'); return; }
    if (!trayCount(tray)) { setStatus('sv2-ph-status', 'Add a photo first.', 'err'); return; }
    if (isDemo()) { toast(DEMO_MSG, 'warning'); setStatus('sv2-ph-status', DEMO_MSG, 'err'); return; }
    var code = (jobById(jobId) || {}).public_code || 'the ticket';
    var epoch = closeEpoch;
    uploadBusy = true;
    var btn = byId('sv2-ph-upload');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      var res = await T.uploadAll(tray, { jobId: jobId }, function (a, b) {
        var i = (a && typeof a === 'object') ? (a.done != null ? a.done : a.index) : a;
        var n = (a && typeof a === 'object') ? a.total : b;
        if (openJobId === jobId && photoTray === tray && i != null && n) setStatus('sv2-ph-status', 'Uploading ' + i + ' of ' + n + '…', '');
      });
      var ok = (res && res.ok) || 0;
      var failed = (res && Array.isArray(res.failed)) ? res.failed : [];
      var msg = ok + ' uploaded';
      if (failed.length) msg += ', ' + failed.length + ' failed' + (failed[0] && failed[0].error ? ' (' + errMsg(failed[0].error) + ')' : '') + ' — they are still in the tray, try again';
      if (openJobId === jobId && photoTray === tray) {
        setStatus('sv2-ph-status', msg + '.', failed.length ? 'err' : 'ok');
        loadPhotos(jobId);
      } else {
        epochToast(epoch, code + ': ' + msg + '.', failed.length ? 'warning' : 'success');
        if (failed.length) epochToast(epoch, 'The failed photos were for ' + code + '. Open its Photos tab and add them again.', 'warning');
      }
    } catch (e) {
      if (openJobId === jobId && photoTray === tray) setStatus('sv2-ph-status', 'Upload failed: ' + errMsg(e), 'err');
      else epochToast(epoch, 'Upload for ' + code + ' failed: ' + errMsg(e), 'error');
    } finally {
      uploadBusy = false;
      destroyRetired();
      var b2 = byId('sv2-ph-upload');
      if (b2) { b2.disabled = false; b2.textContent = 'Upload'; }
    }
  }
  async function loadPhotos(jobId) {
    var d = D();
    var host = byId('sv2-ph-gallery');
    if (!d || !host || typeof d.media !== 'function') return;
    var seq = ++phSeq;
    var rows;
    try { rows = normMedia(await d.media({ jobId: jobId })); }
    catch (e) {
      if (seq === phSeq && openJobId === jobId && jobTab === 'photos') {
        var h = byId('sv2-ph-gallery'); if (h) h.innerHTML = '<div class="sv-empty">Could not load photos: ' + esc(errMsg(e)) + '</div>';
      }
      return;
    }
    if (seq !== phSeq || openJobId !== jobId || jobTab !== 'photos') return;
    // media({jobId}) returns the ticket's photos AND those of the RMA parts
    // linked to it. Part photos belong to the part (the RMA module owns them),
    // but they are evidence about this customer's machine — show them, marked.
    var ticketRows = rows.filter(function (r) { return !r.rma_case_id; });
    var counts = {};
    ticketRows.forEach(function (r) { if (r.service_item_id) counts[r.service_item_id] = (counts[r.service_item_id] || 0) + 1; });
    photoCounts[jobId] = counts;
    renderGallery(byId('sv2-ph-gallery'), ticketRows, true);
    var rmaHost = byId('sv2-ph-rma');
    if (!rmaHost) return;
    var byCase = {}, order = [];
    rows.forEach(function (r) {
      if (!r.rma_case_id) return;
      var k = String(r.rma_case_id);
      if (!byCase[k]) { byCase[k] = []; order.push(k); }
      byCase[k].push(r);
    });
    rmaHost.innerHTML = order.map(function (k, i) {
      var u = unitById(k) || unitsOfJob(jobId).find(function (x) { return String(x.id) === k; });
      var title = u ? u.public_code + ' · ' + unitLabel(u) : 'RMA part';
      return '<div class="sv2-sec"><div class="sv2-sec-title"><span class="sv2-tag rma">RMA</span> ' + esc(title) + '</div>' +
        '<div class="sv2-ph-rma-g" data-rma-g="' + i + '"></div></div>';
    }).join('');
    order.forEach(function (k, i) {
      var g = rmaHost.querySelector('[data-rma-g="' + i + '"]');
      // Read-only here: the RMA module owns the part's evidence.
      if (g) renderGallery(g, byCase[k], false);
    });
  }
  // The gallery reverts a tick or a remark and says why when the promise we
  // hand back REJECTS — so these return the data layer's promise as it is.
  // It also asks "are you sure" itself before calling onDelete.
  function renderGallery(host, rows, editable) {
    var T = window.NeoQcPhotoTray;
    if (!host) return;
    if (!rows.length) { host.innerHTML = '<div class="sv-empty">No photos yet.</div>'; return; }
    if (!T || typeof T.gallery !== 'function') { host.innerHTML = '<div class="sv-empty">The photo viewer did not load. Restart the app.</div>'; return; }
    host.innerHTML = '';
    var d = D();
    var opts = { editable: !!editable, canDelete: !!editable && isLead(), markRma: false };
    if (editable) {
      opts.onRemark = function (row, remark) { return d.setMediaRemark(row.id, remark); };
      opts.onVisible = function (row, visible) { return d.setMediaVisible(row.id, !!visible); };
      opts.onDelete = function (row) { return d.deleteMedia(row); };
    }
    try { T.gallery(host, rows, opts); }
    catch (e) { host.innerHTML = '<div class="sv-empty">Could not show the photos: ' + esc(errMsg(e)) + '</div>'; }
  }

  // ── Notes & timeline ───────────────────────────────────────────────────────
  function notesTabHtml() {
    return '<div class="sv-noteadd">' +
        '<textarea id="sv-n-body" rows="3" placeholder="What did you find? What did you do?"></textarea>' +
        '<label class="sv-check"><input type="checkbox" id="sv-n-visible"> The customer can see this note</label>' +
        '<div class="sv-actions"><button type="button" id="sv-n-add" class="primary-pink-btn">Add note</button>' +
        '<span id="sv-n-status" class="sv-status" role="status"></span></div>' +
        '<p class="sv-hint">Notes are internal unless you tick the box. Tick it for anything the customer should read on their tracking page — findings, decisions, anything that explains a delay.</p>' +
      '</div>' +
      '<div id="sv-job-timeline" class="sv-timeline sv2-timeline"></div>';
  }
  function evStage(kind, s) { return kind === 'rma' ? rmaLabel(s) : stageLabel(s); }
  function timelineHtml(list) {
    return list.map(function (e) {
      var known = Object.prototype.hasOwnProperty.call(EVENT_KINDS, e.kind);
      var kcls = known ? e.kind : 'other';
      var move = '';
      if (e.from_stage && e.to_stage) move = evStage(e.kind, e.from_stage) + ' → ' + evStage(e.kind, e.to_stage);
      else if (e.to_stage) move = '→ ' + evStage(e.kind, e.to_stage);
      var who = e.actor_name || e.actor_email || (e.actor_kind === 'system' ? 'System' : e.actor_kind === 'customer' ? 'Customer' : 'Staff');
      return '<div class="sv-ev' + (e.customer_visible ? ' shown' : '') + '">' +
        '<div class="sv-ev-top"><span class="sv2-ev-kind k-' + kcls + '">' + esc(known ? EVENT_KINDS[e.kind] : (e.kind || 'Event')) + '</span>' +
          '<span class="sv-ev-when">' + esc(fmtDateTime(e.at)) + '</span>' +
          '<span class="sv-ev-who">' + esc(who) + '</span></div>' +
        (move ? '<div class="sv-ev-move">' + esc(move) + '</div>' : '') +
        (e.body ? '<div class="sv-ev-body">' + esc(e.body) + '</div>' : '') +
        '<div class="sv-ev-tag' + (e.customer_visible ? '' : ' internal') + '">' + (e.customer_visible ? 'Customer can see this' : 'Internal only') + '</div>' +
      '</div>';
    }).join('');
  }
  async function loadTimeline(jobId) {
    var d = D();
    var host = byId('sv-job-timeline');
    if (!d || !host) return;
    var seq = ++tlSeq;
    host.innerHTML = '<div class="sv-empty">Loading…</div>';
    try {
      var list = (await d.events(jobId)) || [];
      if (seq !== tlSeq || openJobId !== jobId || jobTab !== 'notes') return;
      host = byId('sv-job-timeline');
      if (!host) return;
      list = list.slice().sort(function (a, b) { return (ms(b.at) || 0) - (ms(a.at) || 0); });
      host.innerHTML = list.length ? timelineHtml(list) : '<div class="sv-empty">No history yet.</div>';
    } catch (e) {
      if (seq === tlSeq && openJobId === jobId) {
        var h = byId('sv-job-timeline');
        if (h) h.innerHTML = '<div class="sv-empty">Could not load history: ' + esc(errMsg(e)) + '</div>';
      }
    }
  }
  async function addNote() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var body = val('sv-n-body');
    if (!body) return setStatus('sv-n-status', 'Write something first.', 'err');
    if (!d || noteBusy) return;
    var visible = checked('sv-n-visible');
    var code = (jobById(jobId) || {}).public_code || 'the ticket';
    noteBusy = true;
    var btn = byId('sv-n-add');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await d.addNote(jobId, body, visible);
      // Only clear AFTER it is known to have saved: the typed paragraph is the
      // only copy until then.
      if (openJobId === jobId && jobTab === 'notes') {
        var ta = byId('sv-n-body'); if (ta) ta.value = '';
        var cb = byId('sv-n-visible'); if (cb) cb.checked = false;
        setStatus('sv-n-status', visible ? 'Added — the customer will see this.' : 'Added as an internal note.', 'ok');
        loadTimeline(jobId);
      } else {
        toast('Note added to ' + code + '.', 'success');
      }
    } catch (e) {
      demoToast(e);
      if (openJobId === jobId && jobTab === 'notes') setStatus('sv-n-status', 'Could not save that note — it is still here, try again. ' + errMsg(e), 'err');
      else toast('The note for ' + code + ' did not save: ' + errMsg(e), 'error');
    } finally {
      noteBusy = false;
      var b2 = byId('sv-n-add');
      if (b2) { b2.disabled = false; b2.textContent = 'Add note'; }
    }
  }

  // ── action-row flows ───────────────────────────────────────────────────────
  // The visit or session already booked on the ticket (a booked stage with a
  // time), as datetime-local values; null when none is booked. A revisit keeps
  // the old visit's time in visit_start, so the stage decides, not the column.
  function bookedVisit(job) {
    if (!job || ms(job.visit_start) == null || LIVE_VISIT.indexOf(job.stage) === -1) return null;
    return { start: toLocalInput(job.visit_start), end: toLocalInput(job.visit_end) };
  }
  // Two datetime-local values name the same minute (a browser may reformat).
  function sameLocalInput(a, b) {
    if (a === b) return true;
    var x = fromLocalInput(a), y = fromLocalInput(b);
    return !!x && x === y;
  }
  function visitPrefill(job) {
    var now = Date.now();
    // Next half hour, at least 15 minutes out, in LOCAL wall time.
    var d0 = new Date(now + 15 * MIN);
    d0.setSeconds(0, 0);
    var m = d0.getMinutes();
    if (m > 30) d0.setMinutes(60); else if (m > 0) d0.setMinutes(30);
    var start = d0.getTime();
    var ws = ms(job.window_start), we = ms(job.window_end);
    if (ws != null && ws > start) start = ws;
    if (we != null && start >= we) return { start: '', end: '', note: 'The customer’s window has passed — agree a new time with them.' };
    if (typeOf(job) === 'remote' && ws == null) return { start: '', end: '' };
    var end = start + (Number(job.est_minutes) > 0 ? Number(job.est_minutes) : 60) * MIN;
    if (we != null && end > we) end = we;
    return { start: toLocalInput(new Date(start).toISOString()), end: toLocalInput(new Date(end).toISOString()) };
  }
  function jobSummaryHtml(job) {
    return '<div class="sv2-dlg-sum">' + iconPair(job) + '<span class="sv-code">' + esc(job.public_code || '') + '</span>' +
      '<span>' + esc(firstName(job.customer_name) + ' · ' + areaText(job)) + '</span>' + priBadge(job.priority) + '</div>' +
      '<div class="sv2-dlg-sub">' + esc(primaryLabel(job).label + (faultSummary(job) ? ' — ' + faultSummary(job) : '')) + '</div>';
  }
  function markClaiming(jobId, on) {
    if (on) claiming[jobId] = true; else delete claiming[jobId];
    var root = rootEl();
    if (root) Array.prototype.forEach.call(root.querySelectorAll('[data-claim]'), function (b) {
      if (b.getAttribute('data-claim') === jobId) { b.disabled = !!on; b.textContent = on ? 'Claiming…' : 'Claim'; }
    });
    if (openJobId === jobId) paintActions();
  }
  // Accept / decline / offer / withdraw in flight: their buttons are painted
  // disabled while it is set.
  function markResponding(jobId, on) {
    if (on) responding[jobId] = true; else delete responding[jobId];
    scheduleRender();
    if (openJobId === jobId) paintActions();
  }
  // The server's {ok:false, reason} answers, as a sentence. They are answers,
  // not errors: somebody else was quicker, or the offer moved on.
  function answerText(code, res) {
    var r = res || {};
    switch (r.reason) {
      case 'taken': return code + ' was just taken by ' + (r.by || 'someone else') + '.';
      case 'offered':
        return code + ' is offered to ' + (r.to_name || r.by || 'someone else') + (r.expires_at ? ' until ' + fmtTime(r.expires_at) : '') +
          ' — only they can take it until then.';
      case 'not_eligible': return r.why ? String(r.why) : 'You can no longer take ' + code + '.';
      // 'expired' = the caller is on the item's skip list: the offer timed
      // out, was declined, or the app's own offer was withdrawn (no alert).
      case 'expired': return 'The offer of ' + code + ' has ended.';
      case 'not_offered': return code + ' is not offered to you any more.';
      case 'changed': return 'Someone else took or changed ' + code + ' just now' + (r.by ? ' (' + r.by + ')' : '') + ' — check and try again.';
      case 'closed': return code + ' is closed.';
      case 'not_found': return code + ' no longer exists.';
      case 'not_queued': return code + ' is not in the queue.';
      default: return code + ' was not changed — it moved on in the meantime. Check and try again.';
    }
  }
  // After an offer, a decline or a withdrawal: the board, and the open panel
  // if it shows this ticket (header only when something typed would be lost).
  function afterQueueWrite(jobId) {
    scheduleRender();
    if (openJobId !== jobId) return;
    if (!unsavedReason() && (jobTab === 'details' || jobTab === 'visit')) paintJob();
    else { paintJobHeader(); refreshMoveIfIdle(jobId); }
  }
  // "Taken" is an answer, not an error: someone was quicker. The data layer
  // has already re-read the ticket, so the board shows who has it.
  function afterClaim(jobId, res, visitStart) {
    var job = jobById(jobId);
    var code = (job && job.public_code) || 'The ticket';
    var ok = !(res && res.ok === false);
    if (!ok) {
      toast(answerText(code, res), 'warning');
    } else {
      toast(code + ' is yours' + (visitStart ? ' — ' + (typeOf(job) === 'remote' ? 'session' : 'visit') + ' booked for ' + whenShort(visitStart) : '') + '.', 'success');
    }
    scheduleRender();
    if (openJobId === jobId) {
      // A claimed ticket shows its contact details; repaint the tab if nothing
      // typed would be lost, otherwise the stale line offers the reload.
      var live = jobById(jobId);
      if (ok && live && !unsavedReason() && (jobTab === 'details' || jobTab === 'visit')) paintJob();
      else { paintJobHeader(); refreshMoveIfIdle(jobId); }
    }
    return ok;
  }
  // SPEC-AMENDMENTS A17: after booking a visit, offer to tell the customer.
  // SPEC-GAP: offered for a remote session too — the template words it.
  // `moved`: the claim re-timed a visit that was already booked (service_claim
  // has put "Visit moved to …" on the customer's timeline), so the message
  // says it moved rather than that it is booked.
  async function offerVisitMessage(jobId, moved) {
    var job = jobById(jobId);
    if (!job || contactHidden(job) || ms(job.visit_start) == null) return;
    var C = CAT();
    if (!C || !C.WA_TEMPLATES || typeof C.WA_TEMPLATES.visit_booked !== 'function') return;
    var word = typeOf(job) === 'remote' ? 'session' : 'visit';
    var who = firstName(job.customer_name) || 'the customer';
    var p = document.createElement('p');
    p.textContent = moved
      ? 'Tell ' + who + ' on WhatsApp that the ' + word + ' moved to ' + fmtRange(job.visit_start, job.visit_end) + '?'
      : 'Send ' + who + ' the ' + word + ' time (' + fmtRange(job.visit_start, job.visit_end) + ') on WhatsApp?';
    await openDialog({
      title: cap(word) + (moved ? ' moved' : ' booked'), body: p, okText: 'Message customer', cancelText: 'Not now',
      onOk: async function () { sendTemplateFor(jobId, moved ? 'visit_moved' : 'visit_booked'); return true; }
    });
  }
  // The visit part of the claim and accept dialogs (on-site / remote). A
  // visit the help desk already booked is shown and kept: nothing is sent
  // unless the technician changes it, so the server leaves the agreed
  // visit_start alone. A booking whose time has passed is not kept.
  // optional: the accept dialog — a time may always be left for later.
  function visitForm(job, optional) {
    var t = typeOf(job);
    var word = t === 'remote' ? 'session' : 'visit';
    var bk = bookedVisit(job);
    var bkPassed = !!bk && ms(job.visit_start) < Date.now() - HOUR;
    var keepable = !!bk && !bkPassed;
    var pre = keepable ? { start: bk.start, end: bk.end } : visitPrefill(job);
    var bookedNote = keepable
      ? 'Already booked for ' + fmtRange(job.visit_start, job.visit_end) + '. Keep that time, or change it only if you agreed another with the customer.'
      : bkPassed ? 'It was booked for ' + whenShort(job.visit_start) + ', which has passed — agree a new time.' : '';
    var win = [fmtRange(job.window_start, job.window_end), job.window_note].filter(Boolean).join(' · ');
    var html = (bookedNote ? '<div class="ops-banner ' + (keepable ? 'ops-banner-info' : 'ops-banner-warn') + ' sv2-banner">' + esc(bookedNote) + '</div>' : '') +
      '<p class="sv-hint">' + (win ? 'The customer is free: ' + esc(win) + (/[.!?]$/.test(win) ? '' : '.') : 'The customer did not give a time window.') +
      (pre.note ? ' ' + esc(pre.note) : '') + '</p>' +
      '<div class="sv-grid">' +
        field(t === 'remote' ? 'Session starts' : 'Visit starts', 'svd-vstart', pre.start, { type: 'datetime-local' }) +
        field('Ends', 'svd-vend', pre.end, { type: 'datetime-local' }) +
      '</div>' +
      (keepable ? ''
        : optional ? '<p class="sv-hint">Optional — set it now if you have agreed a time with the customer, or later on the ' + (t === 'remote' ? 'Session' : 'Visit') + ' tab.</p>'
        : t === 'on_site'
        ? checkField('svd-later', 'I will agree the time with the customer later', false)
        : '<p class="sv-hint">Optional for a remote session — set it when the customer agrees a time.</p>');
    function read(s) {
      var vs = null, ve = null, kept = false;
      var later = t === 'on_site' && !optional && !keepable && nchecked(s, '#svd-later');
      var a = nval(s, '#svd-vstart'), b = nval(s, '#svd-vend');
      if (keepable && sameLocalInput(a, pre.start) && sameLocalInput(b, pre.end)) {
        kept = true;                               // no time sent: the booking stands
      } else if (!later) {
        if (keepable && !a && !optional) return { error: 'The ' + word + ' is already booked. Keep that time, or pick a new one.' };
        if (t === 'on_site' && !a && !optional) return { error: 'Pick the visit time, or tick “agree the time later”.' };
        if (a) {
          vs = fromLocalInput(a);
          if (!vs) return { error: 'That start time is not valid.' };
          if (ms(vs) < Date.now() - HOUR) return { error: 'That start time is in the past.' };
        }
        if (b) {
          ve = fromLocalInput(b);
          if (!ve) return { error: 'That end time is not valid.' };
          if (!vs) return { error: 'Set a start time too.' };
          if (ms(ve) <= ms(vs)) return { error: 'It ends before it starts.' };
        }
      }
      return { vs: vs, ve: ve, kept: kept };
    }
    return { html: html, read: read };
  }
  async function claimFlow(jobIdArg) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!isTechPlus()) { toast('Only technicians can take tickets. A lead can offer it to one.', 'warning'); return; }
    if (!inQueue(job)) { toast(job.stage === 'closed' ? 'This ticket is closed.' : 'Someone already has this ticket.', 'info'); return; }
    // Offered to me: taking it is accepting the offer.
    if (offeredToMe(job)) { await acceptFlow(jobId); return; }
    var other = offerOther(job);
    if (other) { toast(offerUntilText(other) + ' Only they can take it until then.', 'info'); return; }
    if (!inPool()) { toast(noPoolText() + (isLead() ? ' Offer it to a technician instead.' : ' Ask a lead to add you to it.'), 'warning'); return; }
    if (claiming[jobId]) return;
    if (typeof d.workClaim !== 'function') { toast('The data layer did not load. Restart the app.', 'error'); return; }
    var t = typeOf(job);
    // SPEC-AMENDMENTS A17: claiming is friendly. No reason is asked for, even
    // when the ticket was requested for someone else — the server's claim
    // event tells them. An in-store ticket is one click.
    if (t === 'in_store') {
      markClaiming(jobId, true);
      try { afterClaim(jobId, await d.workClaim('service', jobId, null, null), null); }
      catch (e) { if (isDemoErr(e)) demoToast(e); else toast('Could not claim ' + (job.public_code || 'the ticket') + ': ' + errMsg(e), 'error'); }
      finally { markClaiming(jobId, false); }
      return;
    }
    var reqOther = !!job.suggested_tech_email && lower(job.suggested_tech_email) !== myEmail();
    var vf = visitForm(job, false);
    var html = jobSummaryHtml(job) + vf.html;
    if (reqOther) {
      html += '<p class="sv-hint">This was requested for ' + esc(staffName(job.suggested_tech_email)) + '. They will see that you took it.</p>';
    }
    var node = dlgNode('claim', html);
    var booked = false, moved = false;
    await openDialog({
      title: 'Take ' + (job.public_code || 'this ticket'), body: node, okText: 'Take it',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'claim');
        var v = vf.read(s);
        if (v.error) return v.error;
        // The booking as this screen last saw it, just before the claim: a new
        // start on it is a move, as service_claim judges it.
        var prior = jobById(jobId);
        var priorStart = bookedVisit(prior) ? ms(prior.visit_start) : null;
        markClaiming(jobId, true);
        var res;
        try { res = await d.workClaim('service', jobId, v.vs, v.ve); }
        catch (e) { demoToast(e); return errMsg(e); }
        finally { markClaiming(jobId, false); }
        // A kept booking is named in the toast as the server now has it. The
        // WhatsApp offer is for a time set by this claim: a kept one was
        // agreed with the customer when it was booked.
        var live = jobById(jobId);
        booked = afterClaim(jobId, res, v.vs || (v.kept && live ? live.visit_start : null)) && !!v.vs;
        moved = booked && priorStart != null && ms(v.vs) !== priorStart;
        return true;
      }
    });
    if (booked) offerVisitMessage(jobId, moved);
  }

  // ── offers: accept, decline (the offered person), offer, withdraw (leads) ──
  function offerFromText(o) {
    var who = o.kind === 'auto' ? 'The app' : (o.by || 'A lead');
    return who + ' offered it to you' + (o.reason ? ': “' + o.reason + '”' : '.');
  }
  // Accept the live offer made to me. In-store is one click; on-site and
  // remote ask for the visit time (optional, kept when already booked).
  async function acceptFlow(jobIdArg) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!offeredToMe(job)) { toast('This offer has ended — the queue shows where the ticket is now.', 'info'); scheduleRender(); return; }
    if (responding[jobId]) return;
    if (typeof d.workRespond !== 'function') { toast('The data layer did not load. Restart the app.', 'error'); return; }
    var code = job.public_code || 'the ticket';
    if (typeOf(job) === 'in_store') {
      markResponding(jobId, true);
      try { afterClaim(jobId, await d.workRespond('service', jobId, true, null, null, null), null); }
      catch (e) { if (isDemoErr(e)) demoToast(e); else toast('Could not accept ' + code + ': ' + errMsg(e), 'error'); }
      finally { markResponding(jobId, false); }
      return;
    }
    var o = liveOffer(job);
    var vf = visitForm(job, true);
    var html = jobSummaryHtml(job) +
      '<p class="sv-hint">' + esc(offerFromText(o) + ' Answer by ' + fmtTime(o.expires) + ' (' + fmtLeft(o.expMs - srvNow()) + ' left).') + '</p>' +
      vf.html;
    var node = dlgNode('accept', html);
    var booked = false, moved = false;
    await openDialog({
      title: 'Accept ' + code, body: node, okText: 'Accept',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'accept');
        var v = vf.read(s);
        if (v.error) return v.error;
        var prior = jobById(jobId);
        var priorStart = bookedVisit(prior) ? ms(prior.visit_start) : null;
        markResponding(jobId, true);
        var res;
        try { res = await d.workRespond('service', jobId, true, null, v.vs, v.ve); }
        catch (e) { demoToast(e); return errMsg(e); }
        finally { markResponding(jobId, false); }
        var live = jobById(jobId);
        booked = afterClaim(jobId, res, v.vs || (v.kept && live ? live.visit_start : null)) && !!v.vs;
        moved = booked && priorStart != null && ms(v.vs) !== priorStart;
        return true;
      }
    });
    if (booked) offerVisitMessage(jobId, moved);
  }
  async function declineDialog(jobIdArg) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!offeredToMe(job)) { toast('This offer has ended — the queue shows where the ticket is now.', 'info'); scheduleRender(); return; }
    if (responding[jobId]) return;
    if (typeof d.workRespond !== 'function') { toast('The data layer did not load. Restart the app.', 'error'); return; }
    var html = jobSummaryHtml(job) +
      '<p class="sv-hint">It goes back to the queue and you are skipped for it this time. The leads are told, with your reason.</p>' +
      field('Why can’t you take it?', 'svd-reason', '', { textarea: true, wide: true, rows: 3, placeholder: 'e.g. On a long job until this evening' });
    var node = dlgNode('decline', html);
    await openDialog({
      title: 'Decline ' + (job.public_code || 'this ticket'), body: node, okText: 'Decline',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'decline');
        var reason = nval(s, '#svd-reason');
        if (!reason) return 'Say why you can’t take it — the leads read it.';
        if (reason.length > 300) return 'Keep the reason under 300 characters.';
        markResponding(jobId, true);
        var res;
        try { res = await d.workRespond('service', jobId, false, reason, null, null); }
        catch (e) { demoToast(e); return errMsg(e); }
        finally { markResponding(jobId, false); }
        var code = job.public_code || 'The ticket';
        if (res && res.ok === false) toast(answerText(code, res), 'warning');
        else toast('You declined ' + code + '. The leads have been told.', 'success');
        afterQueueWrite(jobId);
        return true;
      }
    });
  }
  // Can this technician take the job? '' when yes, else the server's
  // third-person sentence. A technician list from a server without the pool
  // columns (before sql/work-queue.sql) lists technicians only: all yes.
  function techWhy(t) {
    if (!t || !Object.prototype.hasOwnProperty.call(t, 'service_pool')) return '';
    var w = W();
    if (!w || typeof w.whyNot !== 'function') return '';
    try {
      var code = w.whyNot(t, 'service', null);
      return code ? (w.whySentence(code, 'service', false) || '') : '';
    } catch (e) { return ''; }
  }
  function jobCost(job) {
    var w = W();
    if (w && typeof w.serviceCost === 'function') { try { return w.serviceCost(typeOf(job)); } catch (e) {} }
    return typeOf(job) === 'on_site' ? 2 : 1;
  }
  function offerOptLabel(t, job, cost) {
    var bits = [];
    var has = lower(t.email) === lower(job.assignee_email);
    var num = function (v) { return v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null; };
    var pts = num(t.points), cp = num(t.capacity_points), jb = num(t.jobs), mx = num(t.max_jobs);
    if (pts != null && cp != null) bits.push(pts + '/' + cp + ' points');
    if (jb != null && mx != null) bits.push(jb + '/' + mx + ' jobs');
    else if (t.open_count != null) bits.push(t.open_count + ' open');
    if (t.visits_today != null && typeOf(job) !== 'in_store') bits.push(t.visits_today + ' visit' + (Number(t.visits_today) === 1 ? '' : 's') + ' today');
    if (t.build_level === 'senior' || t.build_level === 'junior') bits.push(t.build_level);
    if (t.role === 'lead') bits.push('lead');
    if (!has && ((pts != null && cp != null && pts + cost > cp) || (jb != null && mx != null && jb + 1 > mx))) bits.push('full');
    if (lower(t.email) === lower(job.suggested_tech_email)) bits.push('requested');
    if (has) bits.push('has it now');
    if (lower(t.email) === lower(job.offered_to_email) && liveOffer(job)) bits.push('has the offer now');
    if (Array.isArray(job.declined_emails) && job.declined_emails.some(function (e) { return lower(e) === lower(t.email); })) bits.push('declined it');
    return (t.name || t.email) + (bits.length ? ' — ' + bits.join(' · ') : '');
  }
  // A lead offers the ticket to one technician, who has a short time to
  // accept. Anyone may be offered it — open or held by someone else (they
  // keep it until the other person accepts). No 75 % wait: an offer always
  // needs the technician's yes.
  async function offerDialog(jobIdArg) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!isLead()) { toast('Only a lead can offer work to a technician.', 'warning'); return; }
    if (job.stage === 'closed') { toast('This ticket is closed.', 'info'); return; }
    if (responding[jobId]) return;
    if (typeof d.workOffer !== 'function') { toast('The data layer did not load. Restart the app.', 'error'); return; }
    var cur = liveOffer(job);
    // WQ-C8: compare-and-set against the assignee this dialog showed, so an
    // offer never lands on a ticket somebody claimed while it was open.
    var expected = job.assignee_email || null;
    var cost = jobCost(job);
    var list = techList().slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    var pre = '';
    if (job.suggested_tech_email) {
      var sug = list.find(function (t) { return lower(t.email) === lower(job.suggested_tech_email); });
      if (sug && !techWhy(sug) && lower(sug.email) !== lower(expected) && !(cur && lower(cur.email) === lower(sug.email))) pre = sug.email;
    }
    var opts = '<option value="">— Choose a technician —</option>' + list.map(function (t) {
      var why = techWhy(t);
      var off = !!why || lower(t.email) === lower(expected);
      return '<option value="' + esc(t.email) + '"' + (off ? ' disabled' : '') + (t.email === pre ? ' selected' : '') + '>' +
        esc(offerOptLabel(t, job, cost) + (why ? ' — ' + why : '')) + '</option>';
    }).join('');
    var until = fmtTime(new Date(srvNow() + 30 * MIN).toISOString());
    var html = jobSummaryHtml(job) +
      (job.assignee_email ? '<p class="sv-hint">Now with ' + esc(job.assignee || staffName(job.assignee_email)) +
        '. They keep it until the person you choose accepts; both names go in the history.</p>' : '') +
      (cur ? '<div class="ops-banner ops-banner-warn sv2-banner">' + esc(offerUntilText(cur)) + ' Offering it to someone else withdraws that offer first.</div>' : '') +
      (list.length ? '' : '<div class="ops-banner ops-banner-warn sv2-banner">Nobody is in the service pool yet. Add technicians to it in Settings → People.</div>') +
      '<label class="sv-field sv-span2"><span>Technician</span><select id="svd-tech" class="settings-select">' + opts + '</select></label>' +
      '<p class="sv-hint">They have until about ' + esc(until) + ' to accept. If they decline or don’t answer, the leads are told and it goes back to the queue.</p>' +
      field('Why this person?', 'svd-reason', '', { textarea: true, wide: true, rows: 2, placeholder: 'e.g. Closest to the site, free this afternoon' });
    var node = dlgNode('offer', html);
    await openDialog({
      title: 'Offer ' + (job.public_code || 'this ticket'), body: node, okText: cur ? 'Withdraw and offer' : 'Offer',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'offer');
        var email = nval(s, '#svd-tech');
        if (!email) return 'Pick a technician.';
        if (lower(email) === lower(expected)) return 'They already have it.';
        if (cur && lower(email) === lower(cur.email)) return 'It is already offered to them.';
        var reason = nval(s, '#svd-reason');
        if (!reason) return 'Say why you’re offering it to them — it goes in the history.';
        if (reason.length > 300) return 'Keep the reason under 300 characters.';
        var res = null;
        markResponding(jobId, true);
        try {
          if (cur) {
            var w = await d.workOffer('service', jobId, null, null, expected);
            if (w && w.ok === false) res = w;
          }
          if (!res) res = await d.workOffer('service', jobId, email, reason, expected);
        } catch (e) { demoToast(e); return errMsg(e); }
        finally { markResponding(jobId, false); }
        var code = job.public_code || 'The ticket';
        if (res && res.ok === false) toast(answerText(code, res), 'warning');
        else if (res && res.unchanged) toast('They already have ' + code + '.', 'info');
        else {
          var exp = res && res.item && res.item.offer && res.item.offer.expires_at;
          toast(code + ' offered to ' + staffName(email) + (exp ? ' until ' + fmtTime(exp) : '') + '.', 'success');
        }
        afterQueueWrite(jobId);
        return true;
      }
    });
  }
  async function withdrawOffer(jobIdArg) {
    var jobId = jobIdArg;                          // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!isLead()) { toast('Only a lead can withdraw an offer.', 'warning'); return; }
    var o = liveOffer(job);
    if (!o) { toast('There is no live offer on this ticket.', 'info'); scheduleRender(); return; }
    if (responding[jobId] || typeof d.workOffer !== 'function') return;
    var code = job.public_code || 'The ticket';
    var expected = job.assignee_email || null;     // the assignee this screen showed
    var ok = await confirmBox('Withdraw the offer to ' + o.name + '? ' + code + ' stays where it is.',
                              { title: 'Withdraw offer', okText: 'Withdraw', cancelText: 'Keep it' });
    if (!ok) return;
    markResponding(jobId, true);
    try {
      var res = await d.workOffer('service', jobId, null, null, expected);
      if (res && res.ok === false) toast(answerText(code, res), 'warning');
      else if (res && res.withdrawn === false) toast('The offer had already ended.', 'info');
      else toast('Offer to ' + o.name + ' withdrawn.', 'success');
    } catch (e) {
      if (isDemoErr(e)) demoToast(e); else toast('Could not withdraw the offer: ' + errMsg(e), 'error');
    } finally { markResponding(jobId, false); }
    afterQueueWrite(jobId);
  }

  async function releaseDialog(jobIdArg) {
    var jobId = jobIdArg || openJobId;             // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job || !job.assignee_email) return;
    if (!(isMine(job) || isLead())) { toast('Only the technician on it or a lead can hand it back.', 'warning'); return; }
    var onRoad = job.stage === 'en_route' || job.stage === 'on_site';
    if (onRoad && !isLead()) { toast('You are on the way or on site — ask a lead to hand it back.', 'warning'); return; }
    if (typeof d.workRelease !== 'function') { toast('The data layer did not load. Restart the app.', 'error'); return; }
    var booked = job.stage === 'scheduled' || job.stage === 'session_booked';
    var word = typeOf(job) === 'remote' ? 'session' : 'visit';
    var html = '<p>' + (isMine(job) ? 'It goes back to the queue for someone else to take.'
                                    : 'Takes it off ' + esc(job.assignee || staffName(job.assignee_email)) + ' and puts it back in the queue.') + '</p>' +
      (booked ? '<div class="ops-banner ops-banner-warn sv2-banner">The booked ' + word + (ms(job.visit_start) != null ? ' (' + esc(whenShort(job.visit_start)) + ')' : '') +
                ' is cancelled and the customer’s page goes back to “We have your request”. Tell the customer.</div>' : '') +
      (onRoad ? '<div class="ops-banner ops-banner-warn sv2-banner">They are on the way or on site right now.</div>' : '') +
      field('Why are you handing it back?', 'svd-reason', '', { textarea: true, wide: true, rows: 3, placeholder: 'e.g. Needs a part I cannot get today' });
    var node = dlgNode('release', html);
    await openDialog({
      title: 'Hand back ' + (job.public_code || 'this ticket'), body: node, okText: 'Put it back in the queue', danger: booked || onRoad,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'release');
        var reason = nval(s, '#svd-reason');
        if (!reason) return 'Say why you are handing it back — the next technician reads it.';
        if (reason.length > 300) return 'Keep the reason under 300 characters.';
        var res;
        try { res = await d.workRelease('service', jobId, reason); }
        catch (e) { demoToast(e); return errMsg(e); }
        if (res && res.ok === false) toast(answerText(job.public_code || 'The ticket', res), 'warning');
        else toast((job.public_code || 'The ticket') + ' is back in the queue.', 'success');
        scheduleRender();
        if (openJobId === jobId) { paintJobHeader(); refreshMoveIfIdle(jobId); }
        return true;
      }
    });
  }
  function techOptLabel(t, job) {
    var bits = [];
    if (t.open_count != null) bits.push(t.open_count + ' open');
    if (t.visits_today != null) bits.push(t.visits_today + ' visit' + (Number(t.visits_today) === 1 ? '' : 's') + ' today');
    if (t.role === 'lead') bits.push('lead');
    if (lower(t.email) === lower(job.suggested_tech_email)) bits.push('requested');
    if (lower(t.email) === lower(job.assignee_email)) bits.push('has it now');
    return (t.name || t.email) + (bits.length ? ' — ' + bits.join(' · ') : '');
  }
  async function suggestDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    var list = techList().slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    var opts = [{ value: '', label: 'No suggestion' }].concat(list.map(function (t) { return { value: t.email, label: techOptLabel(t, job) }; }));
    var cur = job.suggested_tech_email || '';
    var html = '<p class="sv-hint">The ticket still goes to the queue. The person you name sees it under “For you” in the queue.</p>' +
      selectField('Technician', 'svd-tech', opts, cur, { wide: true }) +
      field('Why them? (optional)', 'svd-reason', job.suggest_reason || '', { wide: true, placeholder: 'e.g. Served this customer before' });
    var node = dlgNode('suggest', html);
    await openDialog({
      title: 'Suggest a technician', body: node, okText: 'Save',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'suggest');
        var email = nval(s, '#svd-tech') || null;
        var reason = nval(s, '#svd-reason') || null;
        if (lower(email) === lower(job.suggested_tech_email) && (reason || '') === (job.suggest_reason || '')) return true;
        try { await d.suggestTech(jobId, email, reason); }
        catch (e) { demoToast(e); return errMsg(e); }
        toast(email ? 'Suggested ' + staffName(email) + '.' : 'Suggestion cleared.', 'success');
        if (openJobId === jobId && jobTab === 'details') repaintDetailsRows(jobId);
        scheduleRender();
        return true;
      }
    });
  }
  async function priorityDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (!isLead()) { toast('Only a lead can change the priority.', 'warning'); return; }
    var P = vocab('PRIORITIES');
    var html = chipsHtml('pri', PRI_KEYS.map(function (k) { return { value: k, label: lbl(P, k, k) }; }), priKey(job.priority)) +
      field('Why?', 'svd-reason', '', { textarea: true, wide: true, rows: 2, placeholder: 'e.g. Business machine, the whole office is down' });
    var node = dlgNode('priority', html);
    await openDialog({
      title: 'Priority for ' + (job.public_code || 'this ticket'), body: node, okText: 'Save',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'priority');
        var p = readGroup(s, 'pri');
        var reason = nval(s, '#svd-reason');
        if (!p) return 'Pick a priority.';
        if (p === priKey(job.priority)) return 'It is already ' + lbl(P, p, p) + '.';
        if (!reason) return 'Say why — it shows next to the priority.';
        try { await d.setPriority(jobId, p, reason); }
        catch (e) { demoToast(e); return errMsg(e); }
        toast('Priority set to ' + lbl(P, p, p) + '.', 'success');
        if (openJobId === jobId) { paintJobHeader(); if (jobTab === 'details') repaintDetailsRows(jobId); }
        scheduleRender();
        return true;
      }
    });
  }
  // The priority and suggestion rows are display-only, so they can be swapped
  // in place without touching anything typed in the form around them.
  function repaintDetailsRows(jobId) {
    var job = jobById(jobId);
    var body = byId('sv-job-body');
    if (!job || !body || openJobId !== jobId) return;
    var rows = body.querySelectorAll('.sv-field');
    Array.prototype.forEach.call(rows, function (r) {
      var lab = r.querySelector(':scope > span');
      if (!lab || !r.querySelector('.sv2-inline')) return;
      var html = lab.textContent === 'Priority' ? priorityRow(job) : lab.textContent === 'Suggested technician' ? suggestRow(job) : null;
      if (html) { var tmp = document.createElement('div'); tmp.innerHTML = html; r.replaceWith(tmp.firstChild); }
    });
  }
  // ── device password (sql/service-v2.1.sql) ─────────────────────────────────
  // Rules: the password reaches the DOM only inside #sv2-pw-val while shown
  // (textContent, 30 s at most), lives in memory only in pwShown for that
  // long, and never appears in a toast, a log line or the history (the server
  // writes "Device password viewed by …" on every read).
  function pwButton(act) {
    var body = byId('sv-job-body');
    return body ? body.querySelector('.sv2-pw-field [data-dact="' + act + '"]') : null;
  }
  function hidePassword() {
    if (pwShown) { clearTimeout(pwShown.timer); pwShown = null; }
    var v = byId('sv2-pw-val');
    if (v) { v.textContent = ''; v.hidden = true; }
    var b = pwButton('pw-show');
    if (b) { b.textContent = 'Show'; b.setAttribute('aria-pressed', 'false'); }
    var c = pwButton('pw-copy');
    if (c) c.hidden = true;
  }
  async function showPassword() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job || pwBusy) return;
    if (pwShown && pwShown.jobId === jobId) { hidePassword(); return; }      // the button toggles
    if (typeof d.getDevicePassword !== 'function') { toast('This version of the app cannot show device passwords.', 'warning'); return; }
    var epoch = closeEpoch;
    var res = null, err = null;
    pwBusy = true;
    var b = pwButton('pw-show');
    if (b) b.disabled = true;
    try { res = await d.getDevicePassword(jobId); } catch (e) { err = e; }
    pwBusy = false;
    b = pwButton('pw-show');
    if (b) b.disabled = false;
    // Closed, signed out, or pointed at another customer or tab while the read
    // was out: the answer is dropped, never painted.
    if (epoch !== closeEpoch || openJobId !== jobId || jobTab !== 'details' || !panelOpen()) return;
    if (err) { toast('Could not show the password: ' + errMsg(err), 'error'); return; }
    var secret = res && res.secret != null ? String(res.secret) : '';
    if (!secret) { toast('There is no device password on file for this ticket any more.', 'info'); return; }
    var v = byId('sv2-pw-val');
    if (!v) return;
    hidePassword();
    v.textContent = secret;
    v.hidden = false;
    b = pwButton('pw-show');
    if (b) { b.textContent = 'Hide'; b.setAttribute('aria-pressed', 'true'); }
    var c = pwButton('pw-copy');
    if (c) c.hidden = false;
    pwShown = { jobId: jobId, secret: secret, timer: setTimeout(hidePassword, PW_SHOW_MS) };
  }
  async function copyPassword() {
    var jobId = openJobId;                         // bound once
    var s = pwShown && pwShown.jobId === jobId ? pwShown.secret : '';
    if (!s) return;
    var ok = await copyText(s);
    toast(ok ? 'Password copied.' : 'Could not copy it — read it from the screen.', ok ? 'success' : 'warning');
  }
  // Repaints the password row when what it shows changed (flag, closed,
  // hidden) — or always, with force, after our own write. A row that did not
  // change keeps a password that is on screen.
  function repaintPasswordRow(jobId, force) {
    var job = jobById(jobId);
    var body = byId('sv-job-body');
    if (!job || !body || openJobId !== jobId || jobTab !== 'details') return;
    var row = body.querySelector('.sv2-pw-field');
    if (!row) return;
    if (!force && row.getAttribute('data-pw-state') === pwRowState(job)) return;
    hidePassword();
    var tmp = document.createElement('div');
    tmp.innerHTML = passwordRow(job);
    row.replaceWith(tmp.firstChild);
  }
  function togglePwInput(scope, btn) {
    var inp = scope && scope.querySelector('#' + btn.getAttribute('data-pw-toggle'));
    if (!inp) return;
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  }
  async function passwordDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (job.stage === 'closed') { toast('This ticket is closed. Its device password was deleted when it closed.', 'info'); return; }
    if (typeof d.setDevicePassword !== 'function') { toast('This version of the app cannot store device passwords.', 'warning'); return; }
    var on = !!job.has_device_password;
    var html = '<p class="sv-hint">Kept only for the technician working on it, hidden on screen, and deleted automatically when the ticket closes.</p>' +
      '<div class="sv-field sv-span2"><span>' + (on ? 'New password / PIN' : 'Device password / PIN') + '</span>' +
        '<div class="sv2-pw-input">' +
          '<input type="password" id="svd-pw" maxlength="' + PW_MAX + '" autocomplete="new-password" autocapitalize="off" spellcheck="false" aria-label="Device password or PIN">' +
          '<button type="button" class="secondary-btn sv2-pw-toggle" data-pw-toggle="svd-pw" aria-pressed="false" aria-controls="svd-pw">Show</button>' +
        '</div></div>';
    var node = dlgNode('pw', html);
    var epoch = closeEpoch;
    await openDialog({
      title: (on ? 'Change' : 'Set') + ' the device password', sub: job.public_code || '', body: node, okText: 'Save',
      onOk: async function (root) {
        var s = scopeOf(root, node, 'pw');
        var el = s.querySelector('#svd-pw');
        var secret = el ? String(el.value == null ? '' : el.value) : '';
        if (!secret.trim()) return 'Type the password or PIN. To delete the one on file, use Remove.';
        if (secret.length > PW_MAX) return 'That password is too long — keep it under ' + PW_MAX + ' characters.';
        try { await d.setDevicePassword(jobId, secret); }
        catch (e) { demoToast(e); return errMsg(e); }
        epochToast(epoch, 'Device password saved.', 'success');
        if (openJobId === jobId) repaintPasswordRow(jobId, true);
        return true;
      }
    });
    // Saved or cancelled: nothing typed stays in the dialog's markup.
    var left = node.querySelector('#svd-pw');
    if (left) { left.value = ''; left.type = 'password'; }
  }
  async function removePassword() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job || typeof d.setDevicePassword !== 'function') return;
    var epoch = closeEpoch;
    var ok = await confirmBox('Remove the device password from ' + (job.public_code || 'this ticket') + '? Whoever works on it will have to ask the customer again.',
                              { title: 'Remove the device password', okText: 'Remove', danger: true });
    if (!ok || epoch !== closeEpoch) return;
    try { await d.setDevicePassword(jobId, ''); }
    catch (e) {
      if (isDemoErr(e)) demoToast(e);
      else epochToast(epoch, 'Could not remove the password: ' + errMsg(e), 'error');
      return;
    }
    epochToast(epoch, 'Device password removed.', 'success');
    if (openJobId === jobId) repaintPasswordRow(jobId, true);
  }

  async function convertDialog() {
    var jobId = openJobId;                         // bound once
    var d = D();
    var job = jobById(jobId);
    if (!d || !job) return;
    if (unsavedReason()) { toast('Save or undo your changes first — converting reloads the form.', 'warning'); return; }
    var from = typeOf(job);
    var fromStage = job.stage;
    var targets = TYPE_KEYS.filter(function (k) { return k !== from && convTarget(from, k); });
    if (!targets.length) { toast('This ticket cannot change type from here.', 'info'); return; }
    var hold = holdingUnits(jobId);
    var cards = targets.map(function (k) {
      return { value: k, title: typeLabel(k), sub: 'Lands at: ' + stageLabel(convTarget(from, k)),
               disabled: k === 'remote' && hold.length > 0 };
    });
    var html = '<p>Same ticket, same tracking code — the customer’s link keeps working.</p>' +
      choicesHtml('to', cards, '') +
      '<p class="sv-hint" id="svd-lands"></p>' +
      (hold.length ? '<p class="sv-hint">It waits for ' + esc(hold.map(function (u) { return u.public_code; }).join(', ')) + ', so it cannot become remote.</p>' : '') +
      '<div class="sv-grid" data-show-when="to:on_site">' +
        field('Site address', 'svd-saddr', job.site_address, { textarea: true, wide: true }) +
        field('Area', 'svd-sarea', job.site_area) +
        field('Pincode', 'svd-spin', job.site_pincode, { inputmode: 'numeric', maxlength: 6 }) +
        field('Landmark', 'svd-sland', job.site_landmark) +
        field('Google Maps link', 'svd-smaps', job.site_maps_url, { placeholder: 'https://maps.app.goo.gl/…' }) +
      '</div>' +
      field('Note for the customer (optional)', 'svd-note', '', { textarea: true, wide: true, rows: 2 });
    var node = dlgNode('convert', html);
    await openDialog({
      title: 'Convert ' + (job.public_code || 'this ticket'), body: node, okText: 'Convert', wide: true,
      onOk: async function (root) {
        var s = scopeOf(root, node, 'convert');
        var to = readGroup(s, 'to');
        if (!to) return 'Pick what it becomes.';
        if (to === 'remote' && hold.length) return 'A remote ticket cannot wait on a part — release the part first.';
        var stage = convTarget(from, to);
        if (!stage) return 'That conversion is not available.';
        var extra = { convert_to: to };
        if (to === 'on_site') {
          var addr = nval(s, '#svd-saddr'), area = nval(s, '#svd-sarea'), pin = nval(s, '#svd-spin'), mapsU = nval(s, '#svd-smaps');
          if (!addr && !area) return 'An on-site ticket needs the address, or at least the area.';
          if (pin && !/^\d{6}$/.test(pin)) return 'A pincode is six digits.';
          if (mapsU && !/^https?:\/\//i.test(mapsU)) return 'Paste the full Google Maps link, starting with https://';
          extra.site_address = addr || null; extra.site_area = area || null; extra.site_pincode = pin || null;
          extra.site_landmark = nval(s, '#svd-sland') || null; extra.site_maps_url = mapsU || null;
        }
        try { await d.moveJob(jobId, fromStage, stage, nval(s, '#svd-note') || null, true, extra); }
        catch (e) { demoToast(e); return errMsg(e); }
        toast('Converted to ' + typeLabel(to) + '. Same code, same link.', 'success');
        if (openJobId === jobId) { jobTab = 'details'; paintJob(); }
        scheduleRender();
        return true;
      }
    });
  }

  function sendTemplate(key) {
    var jobId = openJobId;                         // bound once
    return sendTemplateFor(jobId, key);
  }
  async function sendTemplateFor(jobIdArg, key) {
    var jobId = jobIdArg;                          // bound once
    var job = jobById(jobId);
    var C = CAT(), u = U();
    if (!job) return;
    if (contactHidden(job)) return;
    var T = C && C.WA_TEMPLATES;
    // visit_moved is built here from visit_booked until the catalogue has one.
    var tpl = (key === 'visit_moved' && T && typeof T.visit_moved !== 'function') ? 'visit_booked' : key;
    if (!T || typeof T[tpl] !== 'function') { toast('The message templates did not load.', 'error'); return; }
    if (!u || typeof u.waOpen !== 'function') { toast('WhatsApp cannot be opened from here.', 'error'); return; }
    var amount = null;
    if (key === 'quote') {
      var node = dlgNode('quote', field('Quoted amount', 'svd-amount', '', { wide: true, placeholder: 'e.g. ₹8,400 including parts' }));
      var got = await openDialog({
        title: 'Send a quote', body: node, okText: 'Open WhatsApp',
        onOk: async function (root) {
          var a = nval(scopeOf(root, node, 'quote'), '#svd-amount');
          if (!a) return 'Enter the amount the customer is being quoted.';
          amount = a;
          return true;
        }
      });
      if (!got || !amount) return;
      job = jobById(jobId) || job;
    }
    var text;
    try {
      if (key === 'quote') text = T.quote(job, amount);
      else if (key === 'on_the_way') text = T.on_the_way(job, firstName(job.assignee || myName()));
      else if (key === 'visit_moved') text = visitMovedText(T, job);
      else text = T[key](job);
    } catch (e) { toast('Could not build that message: ' + errMsg(e), 'error'); return; }
    var ok;
    try { ok = u.waOpen(job.customer_phone, text); } catch (e) { toast('Could not open WhatsApp: ' + errMsg(e), 'error'); return; }
    if (ok === false) toast('WhatsApp cannot open that phone number. Check it on the Details tab — a 10-digit mobile, or the full number with its country code.', 'warning');
  }
  // "Your visit has been moved to Thu, 23 Oct, 2:00 pm to 4:00 pm." SPEC-GAP:
  // the catalogue has no visit_moved template yet. Until it does, this line
  // takes the place of visit_booked's own, so the greeting, code, tracking
  // link and sign-off stay the house ones. If that line is not found, or the
  // time cannot be worded, visit_booked goes as it is — it names the new time.
  function visitMovedText(T, job) {
    if (typeof T.visit_moved === 'function') return T.visit_moved(job);
    var booked = String(T.visit_booked(job));
    var C = CAT();
    var when = (C && typeof C.visitText === 'function') ? C.visitText(job.visit_start, job.visit_end) : '';
    if (!when) return booked;
    var line = typeOf(job) === 'remote'
      ? 'Your remote session has been moved to ' + when + '.'
      : 'Your visit has been moved to ' + when + '. Our technician will message you before leaving.';
    var lines = booked.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (/^Your (visit|remote session) is booked\b/.test(lines[i])) { lines[i] = line; return lines.join('\n'); }
    }
    return booked;
  }
  function trackLink(code) {
    var C = CAT();
    if (C && typeof C.trackLink === 'function') { try { var l = C.trackLink(code); if (l) return String(l); } catch (e) {} }
    return TRACK_BASE + encodeURIComponent(code);
  }
  async function copyLink() {
    var job = jobById(openJobId);
    if (!job || !job.public_code) return;
    var u = U();
    var ok;
    try {
      ok = (u && typeof u.copyText === 'function') ? await u.copyText(trackLink(job.public_code)) : await copyText(trackLink(job.public_code));
    } catch (e) { ok = false; }
    toast(ok ? 'Tracking link copied. The customer opens it with the last 4 digits of their phone.' : 'Could not copy the link.', ok ? 'success' : 'error');
  }
  async function openRmaUnit(caseId) {
    if (!caseId) return;
    if (!canOpenRma()) { toast('You do not have access to the RMA module.', 'warning'); return; }
    var closed = await requestClosePanel();
    if (!closed) return;
    if (window.NeoQcShell && typeof window.NeoQcShell.goSection === 'function') window.NeoQcShell.goSection('rma');
    else if (typeof switchScreen === 'function') switchScreen('rma');
    if (window.NeoQcRmaUI && typeof window.NeoQcRmaUI.openUnit === 'function') window.NeoQcRmaUI.openUnit(caseId);
    else toast('The RMA module did not load.', 'error');
  }
  async function openBuild(buildId) {
    if (!buildId) return;
    if (!canOpenBuilds() || typeof openTicketModal !== 'function') { toast('Build tickets are open to service leads only.', 'info'); return; }
    var closed = await requestClosePanel();
    if (closed) openTicketModal(buildId);
  }

  // ── panel body delegation ──────────────────────────────────────────────────
  // One delegated listener for the whole body, because its contents are rebuilt
  // on every repaint and per-element bindings would be lost each time.
  function onBodyClick(e) {
    if (handleChipClick(e)) { var b0 = byId('sv-job-body'); if (b0) syncDeps(b0); return; }
    var t = e.target;
    if (t.closest('#sv-e-save')) { saveDetails(); return; }
    if (t.closest('#sv-m-go')) { doMove(); return; }
    if (t.closest('#sv-n-add')) { addNote(); return; }
    if (t.closest('#sv-v-save')) { saveVisit(); return; }
    if (t.closest('#sv2-ph-upload')) { uploadPhotos(); return; }
    var da = t.closest('[data-dact]');
    if (da) {
      var a = da.getAttribute('data-dact');
      if (a === 'priority') priorityDialog();
      else if (a === 'suggest') suggestDialog();
      else if (a === 'convert') convertDialog();
      else if (a === 'open-build') openBuild(da.getAttribute('data-build'));
      else if (a === 'pw-show') showPassword();
      else if (a === 'pw-copy') copyPassword();
      else if (a === 'pw-set') passwordDialog();
      else if (a === 'pw-remove') removePassword();
      return;
    }
    var ma = t.closest('[data-mact]');
    if (ma) {
      var m = ma.getAttribute('data-mact');
      if (m === 'refresh-move') refreshMove();
      else if (m === 'reload-form') { var j = jobById(openJobId); if (j) paintBody(j); }
      else if (m === 'open-rma') openRmaUnit(ma.getAttribute('data-unit'));
      else if (m === 'release-hold') releaseHoldDialog(ma.getAttribute('data-to'));
      else if (m === 'advance') advanceDialog();
      return;
    }
    var ia = t.closest('[data-iact]');
    if (ia) {
      var i = ia.getAttribute('data-iact');
      if (i === 'add') addItemDialog();
      else if (i === 'edit') startItemEdit(ia.getAttribute('data-item'));
      else if (i === 'save') saveItem();
      else if (i === 'cancel') cancelItemEdit();
      else if (i === 'rma') sendRmaDialog(ia.getAttribute('data-item'));
      return;
    }
    var fb = t.closest('[data-field]');
    if (fb && !fb.disabled) {
      var k = fb.getAttribute('data-field');
      if (k === 'out-menu') {
        var menu = byId('sv2-out-menu');
        if (menu) { menu.hidden = !menu.hidden; fb.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true'); }
      } else fieldTap(k, null);
      return;
    }
    var ob = t.closest('[data-out]');
    if (ob && !ob.disabled) { fieldTap('departed', ob.getAttribute('data-out')); return; }
    var fbb = t.closest('[data-find-build]');
    if (fbb) { findBuildDialog(fbb.getAttribute('data-find-build'), byId('sv-job-body')); return; }
    var lbb = t.closest('[data-link-build]');
    if (lbb) { linkBuild(byId('sv-job-body'), lbb.getAttribute('data-prefix'), lbb.getAttribute('data-link-build')); return; }
    if (t.closest('[data-vact="maps"]')) openMaps();
  }
  function onBodyChange(e) {
    var t = e.target;
    if (t.id === 'sv-i-serial') { serialHint(t, 'sv-i'); return; }
    if (t.id === 'sv-e-consent') {
      // Today's answers decide the "data on it" box (anything but "No
      // important data" means there is); an old answer leaves it alone. The
      // box is a form field like any other, so the save diff picks it up.
      var M = svc();
      var hd = byId('sv-e-hasdata');
      var choices = vocab('DATA_CONSENT_CHOICES');
      if (hd && M && typeof M.hasCustomerDataFor === 'function' && Array.isArray(choices) && choices.indexOf(t.value) !== -1) {
        hd.checked = !!M.hasCustomerDataFor(t.value);
      }
      return;
    }
    if (t.id === 'sv-m-stage') {
      // Ask for the fields that only make sense for the stage being moved TO,
      // at the moment they become true.
      var job = jobById(openJobId);
      var extra = byId('sv-m-extra');
      if (extra && job) extra.innerHTML = t.value ? moveExtras(job, t.value) : '';
      var go = byId('sv-m-go');
      if (go) go.disabled = !t.value;
      setStatus('sv-m-status', '', '');
      var help = byId('sv2-m-help'); if (help) help.innerHTML = '';
    }
  }

  // ── data events ────────────────────────────────────────────────────────────
  // One call per data-layer flush, with every kind that changed in it.
  function onDataChange(kinds) {
    var has = function (k) { return kinds.indexOf(k) !== -1; };
    if (screenActive()) scheduleRender();
    var jobId = openJobId;
    if (!jobId || !panelOpen()) return;
    paintJobHeader();
    var job = jobById(jobId);
    if (!job) return;
    if (jobTab === 'items' && (has('items') || has('units') || has('vendors') || has('jobs'))) refreshItemsLive(jobId);
    // Someone else set, removed or closed away the password: say so in place.
    if (jobTab === 'details' && has('jobs')) repaintPasswordRow(jobId, false);
    if (jobTab === 'visit' && has('jobs')) {
      var s = byId('sv2-visit-summary');
      if (s) s.innerHTML = visitSummaryHtml(job);
    }
  }
  function subscribe() {
    var d = D();
    if (subscribed || !d || typeof d.on !== 'function') return;
    subscribed = true;
    // '*' hears each flush once with the list of kinds, so a burst of realtime
    // rows repaints once instead of once per kind.
    try {
      d.on('*', function (evs) {
        var kinds = Array.isArray(evs) ? evs : [String(evs || '')];
        if (kinds.some(function (k) { return ['jobs', 'items', 'units', 'vendors', 'access', 'staff', 'techs'].indexOf(k) !== -1; })) onDataChange(kinds);
      });
    } catch (e) { subscribed = false; }
  }
  function startTimer() {
    if (boardTimer) return;
    // Ageing changes with the clock, not with events. A board that redraws only
    // on realtime would sit at "3 days" all afternoon and under-report every
    // breach.
    boardTimer = setInterval(function () {
      if (screenActive()) renderServiceBoard();
      if (openJobId && panelOpen()) paintJobHeader();
    }, 60000);
  }
  // Offer countdowns tick every second, but only while one is on screen: the
  // timer stops by itself when the screen and the panel are hidden, the window
  // is in the background, or no countdown is left. Text only — nothing typed
  // is ever repainted by it. When an offer runs out the row is repainted
  // without it (the server's tick then moves it on).
  function ensureTick() {
    if (tickTimer) return;
    tickTimer = setInterval(onTick, 1000);
  }
  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }
  function onTick() {
    var hidden = false;
    try { hidden = document.visibilityState === 'hidden'; } catch (e) { hidden = false; }
    var hosts = [];
    if (screenActive()) hosts.push(rootEl());
    if (openJobId && panelOpen()) hosts.push(byId('sv-job-actions'));
    if (hidden || !hosts.length) { stopTick(); return; }
    var now = srvNow(), any = false, ended = false;
    hosts.forEach(function (h) {
      if (!h || typeof h.querySelectorAll !== 'function') return;
      Array.prototype.forEach.call(h.querySelectorAll('[data-sv-countdown]'), function (el) {
        var t = ms(el.getAttribute('data-sv-countdown'));
        if (t == null) return;
        any = true;
        if (t - now <= 0) ended = true;
        var txt = fmtLeft(t - now);
        if (el.textContent !== txt) el.textContent = txt;
      });
    });
    if (!any) { stopTick(); return; }
    if (ended) {
      scheduleRender();
      if (openJobId && panelOpen()) paintActions();
    }
  }

  // The data layer's load status as one sentence, or '' when all is well.
  function statusProblem(st) {
    if (!st || st.ok) return '';
    if (st.lastError) return String(st.lastError);
    var errs = st.errors || {};
    var keys = Object.keys(errs);
    return keys.length ? String(errs[keys[0]]) : 'Could not load the service data.';
  }
  function applyStatus(st) {
    var problem = statusProblem(st);
    if (!problem) { loadState = 'ready'; loadError = ''; refreshWarn = ''; return; }
    // Something came back (or was already here): show it, and say what did not.
    if (allJobs().length || (st && st.anyOk)) { loadState = 'ready'; loadError = ''; refreshWarn = problem; }
    else { loadState = 'error'; loadError = problem; refreshWarn = ''; }
  }

  // Idempotent. NeoQcData.ensureLoaded() loads once, then on later calls only
  // retries whatever failed, and keeps itself fresh with realtime and its own
  // catch-up timer — so calling this every time the screen opens is cheap.
  async function ensureServiceLoaded(opts) {
    var silent = !!(opts && opts.silent);
    if (!silent) initServiceUI();
    var d = D();
    if (!d || typeof d.ensureLoaded !== 'function') {
      loadState = 'error'; loadError = 'The data layer did not load. Restart the app.';
      if (!silent) renderServiceBoard();
      return;
    }
    subscribe();
    startTimer();
    if (loadState !== 'ready') {
      loadState = 'loading';
      if (!silent) renderServiceBoard();
    }
    var st = null;
    try { st = await d.ensureLoaded(); }
    catch (e) { st = { ok: false, lastError: errMsg(e) }; }   // it resolves by contract; this is belt and braces
    applyStatus(st);
    if (!silent) {
      if (loadState === 'error') toast('Could not load service tickets: ' + loadError, 'error');
      renderServiceBoard();
    }
  }
  async function retryLoad() {
    var d = D();
    if (!d) return;
    refreshWarn = '';
    if (typeof d.reload === 'function' && loadState === 'ready') {
      var st = await d.reload('all');
      applyStatus(st);
      if (screenActive()) renderServiceBoard();
      return;
    }
    loadState = 'idle';
    await ensureServiceLoaded();
  }

  function openIntake(arg) {
    var I = window.NeoQcServiceIntake;
    if (!I || typeof I.open !== 'function') { toast('The intake form did not load. Restart the app.', 'error'); return; }
    var opts = {};
    // Ignore a click event handed over by a listener bound straight to this.
    var isEvent = arg && typeof arg === 'object' && (typeof Event !== 'undefined' && arg instanceof Event);
    if (arg && typeof arg === 'object' && !isEvent) opts = arg.preset ? arg : { preset: arg };
    try {
      var r = I.open(opts);
      if (r && typeof r.then === 'function') r.then(null, function (e) { toast('Could not open the intake form: ' + errMsg(e), 'error'); });
    } catch (e) { toast('Could not open the intake form: ' + errMsg(e), 'error'); }
  }

  // For the work queue screen (queue.js) and anything else outside this one
  // (WQ-C12): the same dialogs, visit times, contact rules and in-flight
  // guards as the service screen. Works from any screen: the ticket is read
  // in first when the caches do not have it.
  async function withJob(jobIdArg, fn) {
    var jobId = jobIdArg;                          // bound once
    if (typeof jobId !== 'string' || !jobId) return;
    initServiceUI();
    subscribe();
    startTimer();
    if (!jobById(jobId)) {
      var d = D(), miss = '';
      try {
        if (d && typeof d.ensureLoaded === 'function') await d.ensureLoaded();
        if (!jobById(jobId) && d && typeof d.fetchJob === 'function') await d.fetchJob(jobId);
      } catch (e) { miss = errMsg(e); }
      if (!jobById(jobId)) { toast(miss ? 'Could not open that ticket: ' + miss : 'That ticket could not be found. It may have been removed.', 'warning'); return; }
    }
    await fn(jobId);
  }

  window.NeoQcServiceUI = {
    ensureServiceLoaded: ensureServiceLoaded,
    // The work queue's service actions (all resolve, never reject).
    claim: function (jobId) { return withJob(jobId, claimFlow); },
    offer: function (jobId) { return withJob(jobId, offerDialog); },
    respond: function (jobId, accept) { return withJob(jobId, accept === true ? acceptFlow : declineDialog); },
    release: function (jobId) { return withJob(jobId, releaseDialog); },
    // The Overview reads the same cache rather than querying again, so the two
    // screens can never disagree about what is open.
    jobs: function () { return allJobs(); },
    openJob: openJob,
    closeJob: requestClosePanel,
    // Sign-out / login screen (app.js): closes without asking; a no-op when
    // nothing is open, and safe before this screen ever loaded.
    closePanelNow: forceClosePanel,
    renderServiceBoard: renderServiceBoard,
    openIntake: openIntake,
    setView: setView
  };
})();
