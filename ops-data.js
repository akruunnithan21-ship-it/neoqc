/*
  Neo Tokyo Operations — the data layer for Service and RMA (window.NeoQcData).

  THE ONLY FILE THAT TALKS TO SUPABASE FOR SERVICE OR RMA. Screens read the
  caches here and write through the functions here, never through
  supabaseClient directly. That is what lets four modules (service board,
  intake, RMA, Overview) agree about what is open without each keeping its own
  copy, and what lets demo mode be read-only in exactly one place.

  Loaded after app.js, modules.js and ops-ui.js. Uses supabaseClient and
  currentProfile from app.js's script scope (they are `let` globals, so they
  are read through typeof guards, like service.js always has).

  HOW WRITES WORK
  - Every state change is an RPC (service_move, rma_dispatch, …) that changes
    the row and writes its event in ONE transaction. Plain column edits
    (updateJob, updateItem, updateRma) send only the columns that actually
    differ from what is cached — two people editing different fields of the
    same ticket must not overwrite each other — and never a jsonb column.
  - After a write the cache is updated from what the SERVER returned (or
    re-read when an RPC returns less than a row), never from what we sent.
  - In demo mode every write rejects with Error('DEMO_READONLY') before
    anything leaves the PC. Fixture data is never written to Supabase.
  - Failures reject with an Error whose message the UI turns into a sentence
    with NeoQcUI.errText(). Nothing here swallows a failed write.

  HOW READS STAY FRESH
  - One load of everything on first use (ensureLoaded), then realtime on
    service_jobs, service_items, rma_cases and rma_intakes — one channel per
    table, so a table missing on a not-yet-migrated database cannot take the
    others down with it.
  - A local write is protected for the length of any snapshot that was
    already in flight when it happened, so a slow reload cannot snap a ticket
    back to where it was before the user moved it.
*/
(function () {
  'use strict';

  var BUCKET = 'service-media';
  var DEMO_KEY = 'neo_demo_ops';
  var DAY = 86400000;
  var WINDOW_MS = 2 * DAY;            // closed rows stay in the caches this long
  var READ_MS = 20000;
  var WRITE_MS = 30000;
  var UPLOAD_MS = 180000;
  var GEO_MS = 3000;
  var MAX_FILE = 15 * 1024 * 1024;
  var MAX_SIDE = 2048;
  var JPEG_Q = 0.85;
  var CHUNK = 80;                     // ids per `in.(…)` filter; keeps URLs short
  var SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  var NAIVE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
  var ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  // ── vocab the writes check before calling (the server checks again) ───────
  var PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  var FIELD_KINDS = ['punch_in', 'punch_out', 'left_base', 'arrived', 'departed', 'note', 'photo'];
  var FIELD_OUTCOMES = ['done', 'revisit_needed', 'parts_needed', 'customer_absent'];
  var VENDOR_RESULTS = ['replaced', 'repaired', 'credit_note', 'rejected', 'lost', 'shipped_to_customer'];
  var FEE_STATUSES = ['n_a', 'quoted', 'accepted', 'paid', 'waived'];
  var SHIP_MODES = ['courier', 'hand_delivery', 'vendor_pickup', 'bus_parcel'];
  // Every stage rma_release_hold can send a ticket to. Which of them fits the
  // ticket's type (in-store: ready / in_service; on-site: revisit_needed /
  // work_done) is the server's check, so the two lists can't drift apart.
  var RELEASE_TARGETS = ['ready', 'in_service', 'revisit_needed', 'work_done'];
  var MEDIA_ROLES = ['condition', 'serial_label', 'invoice', 'damage', 'packing', 'unboxing',
                     'during', 'after', 'vendor_doc', 'return_condition', 'other'];
  var PDF_ROLES = ['invoice', 'vendor_doc'];
  var PRIVATE_ROLES = ['invoice', 'serial_label', 'vendor_doc'];
  var INTAKE_PHASE_ROLES = ['condition', 'serial_label', 'invoice', 'unboxing', 'damage', 'packing'];
  var MODULES = ['service', 'rma', 'qc', 'neohr'];
  var ROLES = ['desk', 'tech', 'lead'];

  // Columns that only an RPC may change (stage moves, assignment, priority,
  // identity, audit). updateJob refuses them so a screen cannot quietly
  // bypass the stale check, the events or the claim rules.
  var JOB_RPC_ONLY = {
    id: 1, public_code: 1, stage: 1, stage_since: 1, assignee: 1, assignee_email: 1, assigned_via: 1,
    assigned_at: 1, assign_reason: 1, queued_at: 1, priority: 1, priority_reason: 1, priority_set_by: 1,
    suggested_tech_email: 1, suggest_reason: 1, model_version: 1, client_request_id: 1, created_at: 1,
    created_by_email: 1, created_by_name: 1, closed_at: 1, closed_by: 1, ready_at: 1, outcome: 1,
    converted_from: 1, service_type: 1, customer_id: 1, visit_count: 1, job_kind: 1, updated_at: 1,
    // Follows service_secrets (sql/service-v2.1.sql); the server ignores a
    // direct write, so refusing it here just says so sooner.
    has_device_password: 1
  };
  // jsonb columns are written once, at creation. A read-modify-write of a
  // jsonb blob is how two machines erase each other's edits.
  var JSONB_COLS = { intake: 1, details: 1, subject: 1, meta: 1 };
  var ITEM_FIXED = { id: 1, job_id: 1, serial_norm: 1, created_at: 1, created_by: 1, is_primary: 1 };
  // Exactly the column grant on rma_cases (SPEC §2.6). data_handling is
  // SPEC-AMENDMENTS A11's new column. SPEC-GAP: A11 does not say how it is
  // written; it is a plain column edit here, and the server must grant it.
  var UNIT_EDITABLE = {
    brand: 1, model: 1, serial: 1, fault: 1, diagnosed_by: 1, our_finding: 1, owner_name: 1, owner_phone: 1,
    purchase_source: 1, invoice_no: 1, purchase_date: 1, build_ticket_id: 1, vendor_id: 1, vendor_rma_no: 1,
    expected_back_at: 1, return_method: 1, return_address: 1, data_handling: 1
  };
  var INTAKE_EDITABLE = {
    sender_name: 1, sender_phone: 1, inbound_courier: 1, inbound_awb: 1, return_method: 1, return_address: 1, notes: 1
  };
  // timestamptz columns: a date-only value means a working day (18:00 local),
  // a chase date the morning (10:00, as the v1.9.11 move box did), and a
  // naive datetime-local value is LOCAL wall time.
  var TS_COLS = {
    promised_at: 18, needed_by: 18, window_start: 18, window_end: 18, visit_start: 18, visit_end: 18,
    remote_consent_at: 18, received_at: 18, next_chase_at: 10, expected_back_at: 10, advance_at: 18
  };

  // ── state ──────────────────────────────────────────────────────────────────
  var jobsById = {}, jobsList = null;
  var itemById = {}, itemsByJob = {};
  var unitById = {}, unitsList = null;
  var intakeById = {};
  var vendorById = {}, vendorList = null;
  var staffList = [], techList = [];
  var accessData = null;
  var mediaById = {};
  var demoData = null;                 // { events, rma_events, media } while demo is on
  var writeStamp = {};                 // 'job:<id>' | 'item:<id>' | 'unit:<id>' → ms of our last write
  var pinnedJobs = {}, pinnedUnits = {};   // fetched on purpose from outside the 2-day window
  var lastSnapshot = { jobs: 0, units: 0 };
  var seq = { jobs: 0, units: 0, vendors: 0, staff: 0, techs: 0 };
  var generation = 0;                  // bumps on sign-in change / demo switch; late answers are dropped
  var loadedFor = null;                // who the caches belong to ('demo' or a user id)
  var loadPromise = null;
  var loaded = false;
  var errorsByKind = {};
  var lastErr = null;
  var channels = [];
  var catchTimer = null, deltaBusy = false;
  var demoFlag = readDemoFlag();

  var readyResolve = null;
  var ready = new Promise(function (r) { readyResolve = r; });
  function resolveReady(st) { if (readyResolve) { var r = readyResolve; readyResolve = null; r(st); } }

  // ── environment ────────────────────────────────────────────────────────────
  function client() {
    try { return (typeof supabaseClient !== 'undefined' && supabaseClient) || null; } catch (e) { return null; }
  }
  function profile() {
    try { return (typeof currentProfile !== 'undefined' && currentProfile) || null; } catch (e) { return null; }
  }
  function uidOf(p) { return p ? String(p.id || p.email || '') : ''; }
  function myEmail() { var p = profile(); return p && p.email ? String(p.email) : null; }
  function myName() { var p = profile(); return p && p.full_name ? String(p.full_name) : null; }
  function UI() { return window.NeoQcUI || null; }
  function errText(e) {
    var u = UI();
    if (u && typeof u.errText === 'function') { try { return u.errText(e); } catch (x) { /* fall through */ } }
    return (e && e.message) ? String(e.message) : String(e);
  }
  function readDemoFlag() { try { return localStorage.getItem(DEMO_KEY) === '1'; } catch (e) { return false; } }
  function who() { return demoFlag ? 'demo' : uidOf(profile()); }

  function asError(x) {
    if (x instanceof Error) return x;
    var e = new Error((x && (x.message || x.error_description || x.error)) || String(x));
    if (x && typeof x === 'object') {
      if (x.code) e.code = x.code;
      if (x.details) e.details = x.details;
      if (x.hint) e.hint = x.hint;
      if (x.status || x.statusCode) e.status = x.status || x.statusCode;
    }
    return e;
  }

  // supabase-js has no request timeout. A write that hangs forever leaves a
  // button saying "Saving…" for ever; this says so instead. (The request may
  // still land, which is why every create carries an idempotency key and every
  // move a stale check.)
  function timed(thenable, ms, msg) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error(msg || 'NEO_TIMEOUT: The server took too long to answer. Try again.');
        e.timeout = true;
        reject(e);
      }, ms);
      Promise.resolve(thenable).then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t); reject(e);
      });
    });
  }
  var WRITE_TIMEOUT_MSG = 'NEO_TIMEOUT: The server took too long to answer. Check whether the change went through before trying again.';

  async function rpc(name, params, ms) {
    var c = client();
    if (!c) throw new Error('NEO_OFFLINE: Not connected to the cloud. Try again once you are online.');
    // Only writes get the "check whether it went through" wording.
    var isWrite = !ms || ms === WRITE_MS;
    var r = await timed(c.rpc(name, params || {}), ms || WRITE_MS, isWrite ? WRITE_TIMEOUT_MSG : null);
    if (r && r.error) throw asError(r.error);
    return r ? r.data : null;
  }

  // Every write starts here.
  function writable() {
    if (demoFlag) throw new Error('DEMO_READONLY');
    var c = client();
    if (!c) throw new Error('NEO_OFFLINE: Not connected to the cloud. Try again once you are online.');
    if (!profile()) throw new Error('NEO_DENIED: Sign in first.');
    return c;
  }
  function readable() {
    var c = client();
    if (!c) throw new Error('NEO_OFFLINE: Not connected to the cloud. Try again once you are online.');
    return c;
  }

  function requireId(id, what) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      throw new Error('NEO_GATE: That ' + (what || 'record') + ' is not valid. Reopen it and try again.');
    }
    return id;
  }
  function idList(ids, what) {
    var list = (Array.isArray(ids) ? ids : [ids]).filter(function (x) { return x != null && x !== ''; });
    var seen = {}, out = [];
    list.forEach(function (x) { var s = String(x); if (!seen[s]) { seen[s] = true; out.push(requireId(s, what)); } });
    if (!out.length) throw new Error('NEO_GATE: Choose at least one ' + (what || 'record') + '.');
    return out;
  }
  function uniq(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (x) { if (x == null || x === '') return; var s = String(x); if (!seen[s]) { seen[s] = true; out.push(s); } });
    return out;
  }
  function clean(s) { if (s == null) return null; var t = String(s).trim(); return t ? t : null; }
  function need(s, msg) { var t = clean(s); if (!t) throw new Error('NEO_GATE: ' + msg); return t; }
  function toNum(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  function toInt(v) { var n = toNum(v); return n == null ? null : Math.trunc(n); }

  function uuid() {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch (e) { /* older engine */ }
    var b = new Uint8Array(16);
    try { (window.crypto || window.msCrypto).getRandomValues(b); }
    catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randToken(n) {
    var abc = '0123456789abcdefghijklmnopqrstuvwxyz', out = '';
    var b = new Uint8Array(n);
    try { window.crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); }
    for (var j = 0; j < n; j++) out += abc[b[j] % 36];
    return out;
  }

  // The one phone rule (SPEC-AMENDMENTS A1'), the same as the SQL
  // norm_phone()/phone_ok() and ops-ui.js. Its source of truth is
  // NeoQcCatalog (shared/service-catalog.js); the copy below is identical and
  // only runs where the catalog is not loaded.
  //   normPhone: digits only; a leading 00 is dropped; 10 digits → 91 + d,
  //   11 digits starting with 0 → 91 + the last 10, anything else as it is.
  //   phoneOk (normalised): 12–15 digits, or 11 digits for Kuwait 965, Oman
  //   968, Bahrain 973 and Qatar 974 (a 3-digit code + 8 digits).
  var GULF_11 = ['965', '968', '973', '974'];
  function catalog() {
    var C = window.NeoQcCatalog;
    return (C && typeof C === 'object') ? C : null;
  }
  function normPhone(raw) {
    var C = catalog();
    if (C && typeof C.normPhone === 'function') { var v = C.normPhone(raw); return v == null ? '' : String(v); }
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }
  function phoneOk(norm) {
    var C = catalog();
    if (C && typeof C.phoneOk === 'function') return !!C.phoneOk(norm);
    var n = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(n)) return false;
    if (n.length >= 12 && n.length <= 15) return true;
    return n.length === 11 && GULF_11.indexOf(n.slice(0, 3)) !== -1;
  }

  function normTs(key, v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    if (typeof v === 'number') { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn.toISOString(); }
    var s = String(v).trim();
    var dm = DATE_ONLY.exec(s);
    if (dm) {
      var dd = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), TS_COLS[key] || 18, 0, 0);
      return isNaN(dd.getTime()) ? null : dd.toISOString();
    }
    var lm = NAIVE_LOCAL.exec(s);
    if (lm) {
      var dl = new Date(Number(lm[1]), Number(lm[2]) - 1, Number(lm[3]), Number(lm[4]), Number(lm[5]), Number(lm[6] || 0));
      return isNaN(dl.getTime()) ? null : dl.toISOString();
    }
    return s;                        // already carries an offset / Z
  }
  function normTsFields(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) { out[k] = TS_COLS[k] ? normTs(k, obj[k]) : obj[k]; });
    return out;
  }

  // Do two values mean the same thing? Timestamps compare as instants (the
  // server answers +00:00, we send Z), '' equals null, arrays by content.
  function same(a, b) {
    if (a === b) return true;
    var an = (a == null || a === ''), bn = (b == null || b === '');
    if (Array.isArray(a) || Array.isArray(b)) {
      return JSON.stringify(Array.isArray(a) ? a : (an ? [] : [a])) === JSON.stringify(Array.isArray(b) ? b : (bn ? [] : [b]));
    }
    if (an || bn) return an && bn;
    if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    var sa = String(a), sb = String(b);
    if (ISO_LIKE.test(sa) && ISO_LIKE.test(sb)) {
      var ta = Date.parse(sa), tb = Date.parse(sb);
      if (!isNaN(ta) && !isNaN(tb)) return ta === tb;
    }
    return sa === sb;
  }

  function diffAgainst(base, patch) {
    var out = {};
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v === undefined) return;
      if (typeof v === 'string') { v = v.trim(); if (v === '') v = null; }
      if (!same(base ? base[k] : undefined, v)) out[k] = v;
    });
    return out;
  }

  // ── errors (for the screens to show) ───────────────────────────────────────
  var KIND_LABEL = {
    jobs: 'tickets', items: 'ticket items', units: 'RMA parts', intakes: 'RMA arrivals', vendors: 'vendors',
    staff: 'the staff list', techs: 'the technician list', access: 'module access', realtime: 'live updates',
    connection: 'data', demo: 'demo data', load: 'data'
  };
  function noteError(kind, e) {
    var msg = 'Could not load ' + (KIND_LABEL[kind] || kind) + ': ' + errText(e);
    errorsByKind[kind] = msg;
    lastErr = msg;
    console.warn('[ops-data] ' + msg);
  }
  function clearError(kind) {
    delete errorsByKind[kind];
    if (!Object.keys(errorsByKind).length) lastErr = null;
  }
  // A follow-up refresh after a SUCCESSFUL write failed. The write stands;
  // realtime will correct the cache; the screen does not need to alarm anyone.
  function quiet(kind) { return function (e) { console.warn('[ops-data] refresh of ' + kind + ' after a write failed:', e && e.message); }; }

  function status() {
    var errs = {};
    Object.keys(errorsByKind).forEach(function (k) { errs[k] = errorsByKind[k]; });
    return { ok: !Object.keys(errs).length, demo: demoFlag, errors: errs, lastError: lastErr };
  }

  // ── events ─────────────────────────────────────────────────────────────────
  var listeners = {};
  var pending = {};
  var emitTimer = null;
  var ALL_EVENTS = ['jobs', 'items', 'units', 'intakes', 'vendors', 'staff', 'techs', 'access'];

  function emit(ev) {
    pending[ev] = true;
    if (!emitTimer) emitTimer = setTimeout(flush, 50);
  }
  function emitAll() { ALL_EVENTS.forEach(emit); }
  function flush() {
    emitTimer = null;
    var evs = Object.keys(pending);
    pending = {};
    evs.forEach(function (ev) {
      (listeners[ev] || []).slice().forEach(function (fn) {
        try { fn(ev); } catch (e) { console.warn('[ops-data] a "' + ev + '" listener failed:', e); }
      });
    });
    // '*' hears one call per flush with every event that fired.
    if (evs.length) {
      (listeners['*'] || []).slice().forEach(function (fn) {
        try { fn(evs); } catch (e) { console.warn('[ops-data] a "*" listener failed:', e); }
      });
    }
  }
  function on(ev, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[ev] = listeners[ev] || []).push(fn);
    return function () { off(ev, fn); };
  }
  function off(ev, fn) {
    if (!listeners[ev]) return;
    listeners[ev] = listeners[ev].filter(function (f) { return f !== fn; });
  }
  function hasListeners() {
    return Object.keys(listeners).some(function (k) { return listeners[k].length > 0; });
  }

  // ── cache primitives ───────────────────────────────────────────────────────
  function inWindow(row, now) {
    if (!row) return false;
    if (row.stage !== 'closed') return true;
    var t = row.closed_at ? Date.parse(row.closed_at) : NaN;
    return !isNaN(t) && t >= (now || Date.now()) - WINDOW_MS;
  }

  function mergeJob(row, fromWrite) {
    if (!row || row.id == null) return;
    var id = String(row.id);
    // Merge rather than replace: a realtime UPDATE may omit unchanged large
    // values, and a missing key must not read as "cleared".
    jobsById[id] = jobsById[id] ? Object.assign({}, jobsById[id], row) : Object.assign({}, row);
    jobsList = null;
    if (fromWrite) writeStamp['job:' + id] = Date.now();
  }
  function dropJob(id) {
    if (!jobsById[id]) return false;
    delete jobsById[id];
    jobsList = null;
    Object.keys(itemById).forEach(function (iid) { if (itemById[iid].job_id === id) delete itemById[iid]; });
    delete itemsByJob[id];
    return true;
  }

  function sortItems(list) {
    return list.sort(function (a, b) {
      if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? -1 : 1;
      var s = (Number(a.sort) || 0) - (Number(b.sort) || 0);
      if (s) return s;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  }
  function rebuildItemsIndex() {
    var idx = {};
    Object.keys(itemById).forEach(function (iid) {
      var it = itemById[iid];
      var j = String(it.job_id);
      (idx[j] = idx[j] || []).push(it);
    });
    Object.keys(idx).forEach(function (j) { sortItems(idx[j]); });
    itemsByJob = idx;
  }
  function mergeItem(row, fromWrite) {
    if (!row || row.id == null) return;
    var id = String(row.id);
    itemById[id] = itemById[id] ? Object.assign({}, itemById[id], row) : Object.assign({}, row);
    if (fromWrite) writeStamp['item:' + id] = Date.now();
    rebuildItemsIndex();
  }
  // Replace the items of these jobs with a fresh read, keeping anything we
  // wrote after the read began.
  function replaceItemsFor(jobIds, rows, started, prune) {
    var set = {};
    jobIds.forEach(function (j) { set[String(j)] = true; });
    Object.keys(itemById).forEach(function (iid) {
      var it = itemById[iid];
      var mine = (writeStamp['item:' + iid] || 0) > started;
      if (set[String(it.job_id)] && !mine) delete itemById[iid];
      else if (prune && !jobsById[String(it.job_id)] && !mine) delete itemById[iid];
    });
    (rows || []).forEach(function (r) {
      if (!r || r.id == null) return;
      var id = String(r.id);
      if ((writeStamp['item:' + id] || 0) > started && itemById[id]) return;
      itemById[id] = r;
    });
    rebuildItemsIndex();
  }

  function mergeUnit(row, fromWrite) {
    if (!row || row.id == null) return;
    var id = String(row.id);
    unitById[id] = unitById[id] ? Object.assign({}, unitById[id], row) : Object.assign({}, row);
    unitsList = null;
    if (fromWrite) writeStamp['unit:' + id] = Date.now();
  }
  function mergeIntake(row) {
    if (!row || row.id == null) return;
    var id = String(row.id);
    intakeById[id] = intakeById[id] ? Object.assign({}, intakeById[id], row) : Object.assign({}, row);
  }
  function mergeVendor(row) {
    if (!row || row.id == null) return;
    var id = String(row.id);
    vendorById[id] = vendorById[id] ? Object.assign({}, vendorById[id], row) : Object.assign({}, row);
    vendorList = null;
  }

  // Snapshot replace for jobs / units: what the server says now, except rows
  // we wrote after this read began and rows fetched on purpose (a closed
  // ticket an RMA part points at).
  function applySnapshot(map, rows, started, kind, pinned) {
    var next = {};
    (rows || []).forEach(function (r) { if (r && r.id != null) next[String(r.id)] = r; });
    Object.keys(map).forEach(function (id) {
      var mine = (writeStamp[kind + ':' + id] || 0) > started;
      if (mine) next[id] = map[id];
      else if (!next[id] && pinned[id]) next[id] = map[id];
    });
    return next;
  }

  function resetCaches() {
    generation++;
    unsubscribe();
    jobsById = {}; jobsList = null;
    itemById = {}; itemsByJob = {};
    unitById = {}; unitsList = null;
    intakeById = {};
    vendorById = {}; vendorList = null;
    staffList = []; techList = [];
    mediaById = {};
    demoData = null;
    writeStamp = {};
    pinnedJobs = {}; pinnedUnits = {};
    lastSnapshot = { jobs: 0, units: 0 };
    errorsByKind = {};
    lastErr = null;
    loaded = false;
    loadPromise = null;
    loadSettled = false;
    loadedFor = null;
    emitAll();
  }

  // The caches belong to one person. A different person signing in on the
  // same PC must see nothing of the last one's customers, even for the
  // moment before their own load finishes.
  var revalidateQueued = false;
  function cacheValid() {
    if (demoFlag) return loadedFor === 'demo' || ensureSoon();
    var w = who();
    if (!w) return false;
    if (loadedFor === w) return true;
    return ensureSoon();
  }
  function ensureSoon() {
    if (!revalidateQueued && who()) {
      revalidateQueued = true;
      setTimeout(function () { revalidateQueued = false; ensureLoaded(); }, 0);
    }
    return false;
  }

  // ── reading from the server ────────────────────────────────────────────────
  async function fetchByIds(table, col, ids) {
    var c = readable();
    var list = uniq(ids);
    if (!list.length) return [];
    var chunks = [];
    for (var i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
    var results = await Promise.all(chunks.map(function (ch) {
      return timed(c.from(table).select('*').in(col, ch), READ_MS);
    }));
    var out = [];
    results.forEach(function (r) {
      if (r && r.error) throw asError(r.error);
      out = out.concat((r && r.data) || []);
    });
    return out;
  }

  // Open rows plus rows closed in the last two days, newest first, max 500.
  // If the combined filter is refused for any reason, fall back to the
  // v1.9.11 query and filter here, so the board never goes blank over a
  // filter-syntax disagreement.
  async function fetchWindow(table) {
    var c = readable();
    var since = new Date(Date.now() - WINDOW_MS).toISOString();
    var r = await timed(c.from(table).select('*')
      .or('stage.neq.closed,closed_at.gte."' + since + '"')
      .order('created_at', { ascending: false }).limit(500), READ_MS);
    if (r && !r.error) return r.data || [];
    var first = r && r.error;
    var r2 = await timed(c.from(table).select('*').order('created_at', { ascending: false }).limit(500), READ_MS);
    if (r2 && r2.error) throw asError(first || r2.error);
    var now = Date.now();
    return ((r2 && r2.data) || []).filter(function (row) { return inWindow(row, now); });
  }

  async function loadJobs(gen) {
    var my = ++seq.jobs;
    var started = Date.now();
    var rows = await fetchWindow('service_jobs');
    if (gen !== generation || my !== seq.jobs) return;
    jobsById = applySnapshot(jobsById, rows, started, 'job', pinnedJobs);
    jobsList = null;
    lastSnapshot.jobs = started;
    clearError('jobs');
    emit('jobs');
    try {
      var ids = Object.keys(jobsById);
      var items = await fetchByIds('service_items', 'job_id', ids);
      if (gen !== generation || my !== seq.jobs) return;
      replaceItemsFor(ids, items, started, true);
      clearError('items');
      emit('items');
    } catch (e) {
      if (gen === generation) noteError('items', e);
    }
  }

  async function loadUnits(gen) {
    var my = ++seq.units;
    var started = Date.now();
    var rows = await fetchWindow('rma_cases');
    if (gen !== generation || my !== seq.units) return;
    unitById = applySnapshot(unitById, rows, started, 'unit', pinnedUnits);
    unitsList = null;
    lastSnapshot.units = started;
    clearError('units');
    emit('units');
    try {
      var intakeIds = uniq(Object.keys(unitById).map(function (id) { return unitById[id].intake_id; }));
      var intakes = await fetchByIds('rma_intakes', 'id', intakeIds);
      if (gen !== generation) return;
      intakes.forEach(mergeIntake);
      clearError('intakes');
      emit('intakes');
      emit('units');
    } catch (e) {
      if (gen === generation) noteError('intakes', e);
    }
  }

  async function loadVendors(gen) {
    var my = ++seq.vendors;
    var c = readable();
    var r = await timed(c.from('rma_vendors').select('*').order('name'), READ_MS);
    if (r && r.error) throw asError(r.error);
    if (gen !== generation || my !== seq.vendors) return;
    vendorById = {};
    ((r && r.data) || []).forEach(mergeVendor);
    vendorList = null;
    emit('vendors');
  }

  async function loadStaff(gen) {
    var my = ++seq.staff;
    var c = readable();
    // Everyone, not a designation filter: service work is spread across
    // several job titles and a keyword match would quietly drop somebody.
    var r = await timed(c.from('profiles').select('email, full_name, designation, active, tier').order('full_name'), READ_MS);
    if (r && r.error) throw asError(r.error);
    if (gen !== generation || my !== seq.staff) return;
    staffList = ((r && r.data) || []).filter(function (p) { return p && p.full_name; });
    emit('staff');
  }

  async function loadTechs(gen) {
    var my = ++seq.techs;
    var data = await rpc('service_tech_list', {}, READ_MS);
    if (gen !== generation || my !== seq.techs) return;
    techList = Array.isArray(data) ? data : [];
    emit('techs');
  }

  async function loadAccess(gen) {
    var M = window.NeoQcModules;
    var a = null;
    if (M && typeof M.access === 'function') {
      a = M.access();
      if (!a && typeof M.refreshAccess === 'function') a = await M.refreshAccess();
    } else {
      a = await rpc('my_modules', {}, 4000);
    }
    if (gen !== generation) return;
    accessData = a || null;
    emit('access');
  }

  var LOADERS = { jobs: loadJobs, units: loadUnits, vendors: loadVendors, staff: loadStaff, techs: loadTechs, access: loadAccess };

  async function runKind(kind, gen) {
    try {
      await LOADERS[kind](gen);
      if (gen === generation) clearError(kind);
      return true;
    } catch (e) {
      if (gen === generation) noteError(kind, e);
      return false;
    }
  }

  async function loadAll(gen) {
    if (demoFlag) { loadDemo(); return Object.assign(status(), { anyOk: !!demoData }); }
    if (!client()) {
      noteError('connection', new Error('NEO_OFFLINE: Not connected to the cloud.'));
      return Object.assign(status(), { anyOk: false });
    }
    clearError('connection');
    var kinds = Object.keys(LOADERS);
    var res = await Promise.all(kinds.map(function (k) { return runKind(k, gen); }));
    if (gen !== generation) return Object.assign(status(), { anyOk: false, superseded: true });
    loaded = true;
    subscribe();
    startCatchUp();
    return Object.assign(status(), { anyOk: res.some(Boolean) });
  }

  // Kinds whose last read failed (items ride on jobs, arrivals on units).
  function failedKinds() {
    var out = Object.keys(LOADERS).filter(function (k) { return !!errorsByKind[k]; });
    if (errorsByKind.items && out.indexOf('jobs') === -1) out.push('jobs');
    if (errorsByKind.intakes && out.indexOf('units') === -1) out.push('units');
    return out;
  }
  // A network blip during the first load must not leave a screen empty until
  // the app restarts: opening the screen again (or the 90 s timer) retries
  // just what failed, at most every 15 s.
  var lastRetry = 0;
  async function retryFailed() {
    var kinds = failedKinds();
    if (!kinds.length || demoFlag || !client() || Date.now() - lastRetry < 15000) return status();
    lastRetry = Date.now();
    var gen = generation;
    await Promise.all(kinds.map(function (k) { return runKind(k, gen); }));
    return status();
  }

  // Idempotent. Resolves (never rejects) with { ok, demo, errors, lastError }.
  var loadSettled = false;
  function ensureLoaded() {
    var w = who();
    if (!w) {
      return Promise.resolve({ ok: false, demo: false, errors: { auth: 'Not signed in.' }, lastError: 'Not signed in.' });
    }
    if (loadedFor !== null && loadedFor !== w) resetCaches();
    if (loadPromise) return (loadSettled && failedKinds().length) ? retryFailed() : loadPromise;
    loadedFor = w;
    loadSettled = false;
    var gen = generation;
    var p = loadAll(gen).then(function (st) {
      if (gen === generation) loadSettled = true;
      resolveReady(st);
      // Nothing at all came back (offline, or every read failed): let the
      // next ensureLoaded() try again rather than caching the failure. Not in
      // demo: missing fixtures do not appear on a retry, and a screen that
      // calls ensureLoaded() from its change listener would spin.
      if (gen === generation && !demoFlag && !st.anyOk && !st.superseded && loadPromise === p) loadPromise = null;
      return st;
    }, function (e) {
      if (gen === generation) { noteError('load', e); loadSettled = true; }
      var st = status();
      resolveReady(st);
      if (gen === generation && loadPromise === p) loadPromise = null;
      return st;
    });
    loadPromise = p;
    return p;
  }

  // reload('jobs' | 'items' | 'units' | 'intakes' | 'vendors' | 'staff' |
  // 'techs' | 'access' | 'all'). Resolves with the status, never rejects.
  async function reload(kind) {
    if (!who()) return status();
    if (loadedFor !== who()) return ensureLoaded();
    var gen = generation;
    if (demoFlag) { loadDemo(); return status(); }
    if (!client()) { noteError('connection', new Error('NEO_OFFLINE: Not connected to the cloud.')); return status(); }
    var k = kind || 'all';
    if (k === 'items') k = 'jobs';
    if (k === 'intakes') k = 'units';
    if (k === 'all') {
      await Promise.all(Object.keys(LOADERS).map(function (x) { return runKind(x, gen); }));
    } else if (LOADERS[k]) {
      await runKind(k, gen);
    }
    return status();
  }

  // Re-read specific rows into the caches (also rows outside the window).
  async function fetchJobsInto(ids, fromWrite) {
    var list = uniq(ids);
    if (!list.length || !client()) return [];
    var gen = generation;
    var started = Date.now();
    var both = await Promise.all([fetchByIds('service_jobs', 'id', list), fetchByIds('service_items', 'job_id', list)]);
    if (gen !== generation) return both[0];
    var now = Date.now();
    both[0].forEach(function (r) {
      mergeJob(r, fromWrite);
      if (!inWindow(r, now)) pinnedJobs[String(r.id)] = true;
    });
    replaceItemsFor(list, both[1], started, false);
    emit('jobs');
    emit('items');
    return both[0];
  }

  async function refreshUnits(ids) {
    var list = uniq(ids);
    if (!list.length || !client()) return [];
    var gen = generation;
    var rows = await fetchByIds('rma_cases', 'id', list);
    if (gen !== generation) return rows;
    var now = Date.now();
    rows.forEach(function (r) {
      mergeUnit(r, true);
      if (!inWindow(r, now)) pinnedUnits[String(r.id)] = true;
    });
    emit('units');
    var intakeIds = uniq(rows.map(function (r) { return r.intake_id; }));
    if (intakeIds.length) {
      var ins = await fetchByIds('rma_intakes', 'id', intakeIds);
      if (gen !== generation) return rows;
      ins.forEach(mergeIntake);
      emit('intakes');
    }
    // A unit move can move its ticket (the RMA sync) or create one (a paid
    // repair), so the linked tickets are read back too.
    var jobIds = uniq(rows.map(function (r) { return r.service_job_id; })
      .concat(rows.map(function (r) { return r.followup_job_id; })));
    if (jobIds.length) await fetchJobsInto(jobIds, true);
    return rows;
  }

  // ── realtime ───────────────────────────────────────────────────────────────
  function onJobChange(payload) {
    if (payload.eventType === 'DELETE') {
      var oid = payload.old && payload.old.id;
      if (oid != null && dropJob(String(oid))) { emit('jobs'); emit('items'); }
      return;
    }
    if (!payload.new || payload.new.id == null) return;
    mergeJob(payload.new, false);
    emit('jobs');
  }
  function onItemChange(payload) {
    if (payload.eventType === 'DELETE') {
      var oid = payload.old && payload.old.id;
      if (oid != null && itemById[String(oid)]) { delete itemById[String(oid)]; rebuildItemsIndex(); emit('items'); }
      return;
    }
    if (!payload.new || payload.new.id == null) return;
    mergeItem(payload.new, false);
    emit('items');
  }
  var intakeFetchQueue = {};
  var intakeFetchTimer = null;
  function queueIntakeFetch(id) {
    if (!id || intakeById[id]) return;
    intakeFetchQueue[id] = true;
    if (intakeFetchTimer) return;
    intakeFetchTimer = setTimeout(function () {
      intakeFetchTimer = null;
      var ids = Object.keys(intakeFetchQueue);
      intakeFetchQueue = {};
      var gen = generation;
      fetchByIds('rma_intakes', 'id', ids).then(function (rows) {
        if (gen !== generation) return;
        rows.forEach(mergeIntake);
        emit('intakes'); emit('units');
      }, quiet('intakes'));
    }, 300);
  }
  function onUnitChange(payload) {
    if (payload.eventType === 'DELETE') {
      var oid = payload.old && payload.old.id;
      if (oid != null && unitById[String(oid)]) { delete unitById[String(oid)]; unitsList = null; emit('units'); }
      return;
    }
    if (!payload.new || payload.new.id == null) return;
    mergeUnit(payload.new, false);
    queueIntakeFetch(payload.new.intake_id);
    emit('units');
  }
  function onIntakeChange(payload) {
    if (payload.eventType === 'DELETE') {
      var oid = payload.old && payload.old.id;
      if (oid != null && intakeById[String(oid)]) { delete intakeById[String(oid)]; emit('intakes'); emit('units'); }
      return;
    }
    if (!payload.new || payload.new.id == null) return;
    mergeIntake(payload.new);
    emit('intakes');
    emit('units');
  }

  var REALTIME = [
    ['service_jobs', onJobChange],
    ['service_items', onItemChange],
    ['rma_cases', onUnitChange],
    ['rma_intakes', onIntakeChange]
  ];

  function subscribe() {
    var c = client();
    if (!c || demoFlag || channels.length || typeof c.channel !== 'function') return;
    var gen = generation;
    REALTIME.forEach(function (t) {
      try {
        var joins = 0;
        var ch = c.channel('ops-' + t[0] + '-' + gen)
          .on('postgres_changes', { event: '*', schema: 'public', table: t[0] }, function (payload) {
            if (gen !== generation || !payload) return;
            try { t[1](payload); } catch (e) { console.warn('[ops-data] realtime ' + t[0] + ' handler failed:', e); }
          })
          .subscribe(function (st, err) {
            if (gen !== generation) return;
            if (st === 'SUBSCRIBED') {
              joins++;
              // A re-join after a dropped socket: anything that changed while
              // we were away was never delivered, so catch up once.
              if (joins > 1) deltaSync();
            } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
              console.warn('[ops-data] live updates for ' + t[0] + ' are not available (' + st + ')' + (err && err.message ? ': ' + err.message : ''));
            }
          });
        channels.push(ch);
      } catch (e) {
        console.warn('[ops-data] could not subscribe to ' + t[0] + ':', e && e.message);
      }
    });
  }

  function unsubscribe() {
    var c = client();
    channels.forEach(function (ch) {
      try { if (c && typeof c.removeChannel === 'function') c.removeChannel(ch); else if (ch && ch.unsubscribe) ch.unsubscribe(); }
      catch (e) { /* already gone */ }
    });
    channels = [];
  }

  // SPEC-GAP: the spec relies on realtime alone. A table left out of the
  // realtime publication, or a socket that dropped without a re-join, would
  // leave the board silently stale, so every 90 s (only while the window is
  // visible and a screen is listening) rows UPDATED in the last ten minutes
  // are merged in. Small reads, never a full reload.
  function startCatchUp() {
    if (catchTimer) return;
    catchTimer = setInterval(function () {
      if (demoFlag || !loaded) return;
      try { if (document.visibilityState === 'hidden') return; } catch (e) { /* no document */ }
      if (!hasListeners()) return;
      if (failedKinds().length) retryFailed();
      deltaSync();
    }, 90000);
  }

  async function deltaSync() {
    if (deltaBusy || demoFlag || !loaded) return;
    var c = client();
    if (!c) return;
    deltaBusy = true;
    var gen = generation;
    try {
      var started = Date.now();
      var sinceJ = new Date((lastSnapshot.jobs || started) - 10 * 60000).toISOString();
      var sinceU = new Date((lastSnapshot.units || started) - 10 * 60000).toISOString();
      var rs = await Promise.all([
        timed(c.from('service_jobs').select('*').gte('updated_at', sinceJ).order('updated_at', { ascending: false }).limit(200), READ_MS),
        timed(c.from('rma_cases').select('*').gte('updated_at', sinceU).order('updated_at', { ascending: false }).limit(200), READ_MS)
      ]);
      if (gen !== generation) return;
      var rj = rs[0], ru = rs[1];
      if (rj && !rj.error) {
        var jobRows = (rj.data || []).filter(function (r) { return !((writeStamp['job:' + r.id] || 0) > started); });
        jobRows.forEach(function (r) { mergeJob(r, false); });
        lastSnapshot.jobs = started;
        if (jobRows.length) {
          emit('jobs');
          var jids = jobRows.map(function (r) { return String(r.id); });
          var its = await fetchByIds('service_items', 'job_id', jids);
          if (gen !== generation) return;
          replaceItemsFor(jids, its, started, false);
          emit('items');
        }
      }
      if (ru && !ru.error) {
        var unitRows = (ru.data || []).filter(function (r) { return !((writeStamp['unit:' + r.id] || 0) > started); });
        unitRows.forEach(function (r) { mergeUnit(r, false); queueIntakeFetch(r.intake_id); });
        lastSnapshot.units = started;
        if (unitRows.length) emit('units');
      }
    } catch (e) {
      console.warn('[ops-data] catch-up read failed:', e && e.message);
    } finally {
      deltaBusy = false;
    }
  }

  try { window.addEventListener('online', function () { deltaSync(); }); } catch (e) { /* no window events */ }
  try {
    window.addEventListener('neo-modules-changed', function (e) {
      if (e && e.detail) { accessData = e.detail.access || null; emit('access'); }
    });
  } catch (e) { /* no window events */ }

  // ── demo ───────────────────────────────────────────────────────────────────
  function asArray(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === 'object') return Object.keys(x).map(function (k) { return x[k]; });
    return [];
  }
  function indexBy(list) {
    var out = {};
    asArray(list).forEach(function (r) { if (r && r.id != null) out[String(r.id)] = r; });
    return out;
  }
  function sameLocalDay(iso, now) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return false;
    var n = new Date(now);
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function demoRoleOf(s) {
    var r = s.service_role || s.role || s.module_role || (s.modules && s.modules.service) || null;
    if (ROLES.indexOf(r) !== -1) return r;
    var t = Number(s.tier) || 0;
    return t >= 3 ? 'lead' : t === 2 ? 'tech' : null;
  }
  // Shape of service_tech_list(), computed from the fixtures.
  function demoTechs(staff, jobs, now) {
    return asArray(staff).filter(function (s) {
      return s && s.email && s.active !== false && ['tech', 'lead'].indexOf(demoRoleOf(s)) !== -1;
    }).map(function (s) {
      var email = s.email;
      var mine = jobs.filter(function (j) { return j.assignee_email === email && j.stage !== 'closed'; });
      return {
        email: email,
        name: s.full_name || s.name || email,
        designation: s.designation || '',
        role: demoRoleOf(s),
        open_count: mine.length,
        visits_today: mine.filter(function (j) { return sameLocalDay(j.visit_start, now); }).length,
        in_queue_requested: jobs.filter(function (j) {
          return !j.assignee_email && j.stage !== 'closed' && j.suggested_tech_email === email;
        }).length
      };
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  function loadDemo() {
    var D = window.NeoQcDemo;
    var gen = generation;
    if (!D || typeof D.build !== 'function') {
      noteError('demo', new Error('NEO_DEMO: Demo data is not part of this build.'));
      demoData = null;
      emitAll();
      return;
    }
    var d;
    try { d = D.build(Date.now()) || {}; }
    catch (e) { noteError('demo', e); demoData = null; emitAll(); return; }
    if (gen !== generation) return;
    var now = Date.now();
    jobsById = indexBy(d.jobs); jobsList = null;
    itemById = indexBy(d.items); rebuildItemsIndex();
    unitById = indexBy(d.units); unitsList = null;
    intakeById = indexBy(d.intakes);
    vendorById = indexBy(d.vendors); vendorList = null;
    staffList = asArray(d.staff).filter(function (s) { return s && (s.full_name || s.name); }).map(function (s) {
      return Object.assign({ full_name: s.name, active: true }, s);
    });
    var jobList = Object.keys(jobsById).map(function (k) { return jobsById[k]; });
    techList = Array.isArray(d.techs) ? d.techs : demoTechs(staffList, jobList, now);
    demoData = { events: asArray(d.events), rma_events: asArray(d.rma_events), media: asArray(d.media), customers: asArray(d.customers) };
    mediaById = {};
    loaded = true;
    errorsByKind = {};
    lastErr = null;
    emitAll();
  }

  // The fixtures' `events` already contains the RMA events that `rma_events`
  // lists again, so the two are merged without doubles.
  function demoEvents(match) {
    if (!demoData) return [];
    var seen = {}, out = [];
    demoData.events.concat(demoData.rma_events).forEach(function (e) {
      if (!e || !match(e)) return;
      var k = (e.case_id ? 'c:' + e.case_id : 'j:' + e.job_id) + ':' + e.id + ':' + e.at;
      if (seen[k]) return;
      seen[k] = true;
      out.push(e);
    });
    return out.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
  }

  function demoLookup(n) {
    var jobs = Object.keys(jobsById).map(function (k) { return jobsById[k]; })
      .filter(function (j) { return normPhone(j.customer_phone) === n; })
      .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    var open = jobs.filter(function (j) { return j.stage !== 'closed'; });
    var closed = jobs.filter(function (j) { return j.stage === 'closed'; })
      .sort(function (a, b) { return String(b.closed_at || '').localeCompare(String(a.closed_at || '')); });
    var techs = {};
    jobs.forEach(function (j) {
      if (!j.assignee_email) return;
      var t = techs[j.assignee_email] || (techs[j.assignee_email] = { email: j.assignee_email, name: j.assignee || j.assignee_email, jobs: 0, last_at: null });
      t.jobs++;
      var at = j.closed_at || j.updated_at || j.created_at;
      if (!t.last_at || String(at) > String(t.last_at)) t.last_at = at;
    });
    var units = Object.keys(unitById).map(function (k) { return unitById[k]; }).filter(function (u) {
      if (u.stage === 'closed') return false;
      var it = intakeById[String(u.intake_id)];
      return normPhone(u.owner_phone || (it && it.sender_phone)) === n;
    });
    var latest = jobs[0];
    var cust = demoData ? demoData.customers.find(function (x) { return x && normPhone(x.phone_norm) === n; }) : null;
    return {
      phone_norm: n,
      customer: cust ? {
        id: cust.id, name: cust.name || null, email: cust.email || null, kind: cust.kind || 'person',
        address: cust.address || null, area: cust.area || null, pincode: cust.pincode || null,
        landmark: cust.landmark || null, maps_url: cust.maps_url || null
      } : latest ? {
        id: latest.customer_id || null, name: latest.customer_name || null, email: latest.customer_email || null,
        kind: 'person', address: latest.site_address || null, area: latest.site_area || null,
        pincode: latest.site_pincode || null, landmark: latest.site_landmark || null, maps_url: latest.site_maps_url || null
      } : null,
      open_jobs: open.map(function (j) {
        return { id: j.id, public_code: j.public_code, service_type: j.service_type || 'in_store', stage: j.stage,
                 device_label: j.device_label, created_at: j.created_at, assignee: j.assignee || null };
      }),
      recent_jobs: closed.slice(0, 5).map(function (j) {
        return { public_code: j.public_code, service_type: j.service_type || 'in_store', stage: j.stage, outcome: j.outcome || null,
                 device_label: j.device_label, created_at: j.created_at, closed_at: j.closed_at || null, assignee: j.assignee || null };
      }),
      jobs_total: jobs.length,
      open_rma: units.map(function (u) { return { id: u.id, public_code: u.public_code, kind: u.kind, brand: u.brand, model: u.model, stage: u.stage }; }),
      past_techs: Object.keys(techs).map(function (k) { return techs[k]; })
        .sort(function (a, b) { return String(b.last_at || '').localeCompare(String(a.last_at || '')); }),
      limited: false
    };
  }

  function isDemo() { return demoFlag; }

  // Switching swaps every cache. Resolves with the new load's status.
  function setDemo(on) {
    on = !!on;
    try { if (on) localStorage.setItem(DEMO_KEY, '1'); else localStorage.removeItem(DEMO_KEY); }
    catch (e) { /* storage blocked: the switch still holds for this session */ }
    if (on === demoFlag && loadPromise) return loadPromise;
    demoFlag = on;
    resetCaches();
    return ensureLoaded();
  }

  // ── getters (synchronous, from the caches) ─────────────────────────────────
  function jobs() {
    if (!cacheValid()) return [];
    if (!jobsList) {
      jobsList = Object.keys(jobsById).map(function (k) { return jobsById[k]; })
        .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    }
    return jobsList.slice();
  }
  function job(id) { return (id != null && cacheValid() && jobsById[String(id)]) || null; }
  function itemsOf(jobId) { return (jobId != null && cacheValid() && itemsByJob[String(jobId)]) ? itemsByJob[String(jobId)].slice() : []; }
  function item(id) { return (id != null && cacheValid() && itemById[String(id)]) || null; }
  function units() {
    if (!cacheValid()) return [];
    if (!unitsList) {
      unitsList = Object.keys(unitById).map(function (k) { return unitById[k]; })
        .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    }
    return unitsList.slice();
  }
  function unit(id) { return (id != null && cacheValid() && unitById[String(id)]) || null; }
  function unitsOfJob(jobId) {
    if (jobId == null || !cacheValid()) return [];
    var j = String(jobId);
    return Object.keys(unitById).map(function (k) { return unitById[k]; })
      .filter(function (u) { return u.service_job_id === j; })
      .sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
  }
  function unitsOfIntake(intakeId) {
    if (intakeId == null || !cacheValid()) return [];
    var i = String(intakeId);
    return Object.keys(unitById).map(function (k) { return unitById[k]; })
      .filter(function (u) { return String(u.intake_id) === i; })
      .sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
  }
  function intake(id) { return (id != null && cacheValid() && intakeById[String(id)]) || null; }
  function vendors() {
    if (!cacheValid()) return [];
    if (!vendorList) {
      vendorList = Object.keys(vendorById).map(function (k) { return vendorById[k]; })
        .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    }
    return vendorList.slice();
  }
  function vendor(id) { return (id != null && id !== '' && cacheValid() && vendorById[String(id)]) || null; }
  function staff() { return cacheValid() ? staffList.slice() : []; }
  function techs() { return cacheValid() ? techList.slice() : []; }
  function me() { return profile(); }
  function nameOf(email) {
    if (!email) return '';
    var e = String(email).toLowerCase();
    var hit = staffList.find(function (s) { return String(s.email || '').toLowerCase() === e; }) ||
              techList.find(function (t) { return String(t.email || '').toLowerCase() === e; });
    return hit ? (hit.full_name || hit.name || String(email)) : String(email);
  }
  function role(module) {
    var M = window.NeoQcModules;
    if (M && typeof M.roleFor === 'function') return M.roleFor(module);
    var p = profile();
    if (!p) return null;
    if ((Number(p.tier) || 0) >= 3) return 'lead';
    var r = accessData ? accessData[module] : null;
    return ROLES.indexOf(r) !== -1 ? r : null;
  }
  function isLoaded() { return loaded && cacheValid(); }
  function errors() { return status().errors; }

  // ── reads (async) ──────────────────────────────────────────────────────────
  async function events(jobId) {
    requireId(jobId, 'ticket');
    if (demoFlag) return demoEvents(function (e) { return e && e.job_id === jobId && !e.case_id; });
    var c = readable();
    var r = await timed(c.from('service_events').select('*').eq('job_id', jobId)
      .order('at', { ascending: false }).limit(300), READ_MS);
    if (r && r.error) throw asError(r.error);
    return (r && r.data) || [];
  }

  async function rmaEvents(caseId) {
    requireId(caseId, 'RMA part');
    if (demoFlag) return demoEvents(function (e) { return e && e.case_id === caseId; });
    var c = readable();
    var r = await timed(c.from('rma_events').select('*').eq('case_id', caseId)
      .order('at', { ascending: false }).limit(300), READ_MS);
    if (r && r.error) throw asError(r.error);
    return (r && r.data) || [];
  }

  function displayRole(m) {
    if (m.role) return m.role;
    if (!m.phase || m.phase === 'intake') return 'condition';
    return m.phase;
  }
  function decorateMedia(m, url) {
    var p = String(m.path || '').toLowerCase();
    m.display_role = displayRole(m);
    m.is_pdf = /\.pdf$/.test(p);
    m.is_heic = /\.hei[cf]$/.test(p);
    m.is_rma = !!m.rma_case_id;
    m.url = url || m.url || null;
    if (m.id != null) mediaById[String(m.id)] = m;
    return m;
  }

  // The ticket item an RMA part's photos may also live on, or null.
  // q.itemId (explicit) wins; otherwise the cached part's service_item_id.
  // includeItem:false turns it off.
  function mediaItemFor(q) {
    if (q.includeItem === false) return null;
    var id = q.itemId != null && q.itemId !== '' ? q.itemId : null;
    if (id == null) { var u = unit(q.caseId); id = u && u.service_item_id != null ? u.service_item_id : null; }
    return (id != null && SAFE_ID.test(String(id))) ? String(id) : null;
  }
  // One row per id, order kept (newest first). A row of the part itself is
  // never from_item, even when it also carries the item id; a row that only
  // matched through the item is.
  function markCaseRows(rows, caseId, itemId) {
    var seen = {}, out = [];
    (rows || []).forEach(function (m) {
      if (!m) return;
      if (m.id != null) {
        var k = String(m.id);
        if (seen[k]) return;
        seen[k] = true;
      }
      m.from_item = !!itemId && String(m.rma_case_id == null ? '' : m.rma_case_id) !== String(caseId);
      out.push(m);
    });
    return out;
  }

  // What media() answers when the session that asked has gone.
  function staleMedia() {
    var none = [];
    none.urls = {};
    none.superseded = true;
    return none;
  }

  // media({ jobId }) → the ticket's media AND the media of RMA parts linked to
  // it (row.is_rma marks those); pass includeUnits:false for the ticket's own.
  // media({ caseId }) → one RMA part's media, PLUS the photos taken for its
  // ticket item (service_media.service_item_id = the part's service_item_id,
  // usually the serial label or invoice photographed at intake), each marked
  // `from_item: true`. The server's ship gate (_rma_gate_problems) counts
  // those, so the screen must see them too. On by default when the cached part
  // has a service_item_id; includeItem:false leaves them out, itemId names the
  // item when the part is not cached. Newest first, one row per id. Each row
  // carries `url` (a signed link valid 15 minutes, or null) and display_role;
  // the array also carries `.urls` (path → url). An answer that arrives after
  // sign-out, a change of user or a demo switch is dropped: nothing is cached
  // and an empty array marked `.superseded` comes back (staleMedia, above), so
  // no screen shows a photo the session that asked for it can no longer see.
  async function media(q) {
    q = q || {};
    // Sign-out alone does not bump the generation, so who asked is kept too.
    var gen = generation, asker = who();
    function gone() { return gen !== generation || who() !== asker; }
    var rows;
    var caseItem = q.caseId ? mediaItemFor(q) : null;
    if (demoFlag) {
      var all = demoData ? demoData.media : [];
      rows = all.filter(function (m) {
        if (!m) return false;
        if (q.caseId) return m.rma_case_id === q.caseId || (!!caseItem && m.service_item_id === caseItem);
        if (q.jobId) {
          if (m.job_id === q.jobId) return true;
          if (q.includeUnits === false) return false;
          var u = m.rma_case_id ? unitById[String(m.rma_case_id)] : null;
          return !!(u && u.service_job_id === q.jobId);
        }
        return false;
      }).map(function (m) { return decorateMedia(Object.assign({}, m), m.url); });
      if (q.caseId) rows = markCaseRows(rows, q.caseId, caseItem);
      rows.urls = {};
      rows.forEach(function (m) { if (m.path && m.url) rows.urls[m.path] = m.url; });
      return rows;
    }

    var c = readable();
    var query = c.from('service_media').select('*');
    if (q.caseId) {
      requireId(q.caseId, 'RMA part');
      // Both ids passed SAFE_ID, so neither can break out of the or() filter.
      query = caseItem
        ? query.or('rma_case_id.eq.' + q.caseId + ',service_item_id.eq.' + caseItem)
        : query.eq('rma_case_id', q.caseId);
    } else if (q.jobId) {
      requireId(q.jobId, 'ticket');
      var unitIds = q.includeUnits === false ? [] : unitsOfJob(q.jobId).map(function (u) { return u.id; })
        .filter(function (id) { return SAFE_ID.test(String(id)); });
      query = unitIds.length
        ? query.or('job_id.eq.' + q.jobId + ',rma_case_id.in.(' + unitIds.join(',') + ')')
        : query.eq('job_id', q.jobId);
    } else {
      throw new Error('NEO_GATE: Say which ticket or RMA part the photos belong to.');
    }
    var r = await timed(query.order('created_at', { ascending: false }).limit(500), READ_MS);
    if (gone()) return staleMedia();
    if (r && r.error) throw asError(r.error);
    rows = (r && r.data) || [];
    if (q.caseId) rows = markCaseRows(rows, q.caseId, caseItem);

    // The bucket is private: every thumbnail needs a signed URL. Pair them BY
    // PATH, never by position — the API does not promise to keep the order,
    // and a mismatch would show one customer's photo under another's caption
    // and "show customer" tick.
    var urls = {};
    var paths = uniq(rows.map(function (m) { return m.path; }));
    if (paths.length) {
      try {
        var signed = await timed(c.storage.from(BUCKET).createSignedUrls(paths, 900), READ_MS);
        var list = (signed && signed.data) || [];
        var anyPath = false;
        list.forEach(function (s) {
          if (s && s.path) {
            anyPath = true;
            var u = s.signedUrl || s.signedURL || null;
            if (u && !s.error) urls[s.path] = u;
          }
        });
        // Positional pairing only when the API returned no paths at all, and
        // only when the counts agree.
        if (!anyPath && list.length === paths.length) {
          list.forEach(function (s, i) {
            var u = s && (s.signedUrl || s.signedURL);
            if (u) urls[paths[i]] = u;
          });
        }
      } catch (e) {
        // Thumbnails are a nicety; the list still renders without them.
        console.warn('[ops-data] signing photo links failed:', e && e.message);
      }
      if (gone()) return staleMedia();
    }
    rows.forEach(function (m) { decorateMedia(m, urls[m.path]); });
    rows.urls = urls;
    return rows;
  }

  // Full shape for anyone with service/RMA access; a reduced one for the
  // others (SPEC-AMENDMENTS A19: { phone_norm, known, display_name,
  // open_count }), marked `limited: true`. A number the phone rule refuses
  // (phoneOk, A1') is not sent to the server.
  async function lookupCustomer(phone) {
    var n = normPhone(phone);
    var empty = { phone_norm: n, customer: null, open_jobs: [], recent_jobs: [], jobs_total: 0,
                  open_rma: [], past_techs: [], limited: false };
    if (!phoneOk(n)) return empty;
    if (demoFlag) return demoLookup(n);
    var res = await rpc('lookup_customer', { p_phone: n }, READ_MS);
    if (!res || typeof res !== 'object') return empty;
    var out = Object.assign({}, empty, res);
    ['open_jobs', 'recent_jobs', 'open_rma', 'past_techs'].forEach(function (k) { if (!Array.isArray(out[k])) out[k] = []; });
    out.limited = !('open_jobs' in res) && ('known' in res || 'open_count' in res);
    return out;
  }

  async function myModules() {
    var M = window.NeoQcModules;
    var a = (M && typeof M.refreshAccess === 'function') ? await M.refreshAccess() : await rpc('my_modules', {}, 4000);
    accessData = a || null;
    emit('access');
    return accessData;
  }

  // SPEC-AMENDMENTS A20: find a past build by receipt code, name or serial.
  async function findBuilds(query) {
    var q = clean(query);
    if (!q || q.length < 2) return [];
    if (demoFlag) return [];
    var res = await rpc('find_builds', { p_query: q }, READ_MS);
    return Array.isArray(res) ? res : [];
  }

  async function myRequests() {
    if (demoFlag) return { jobs: [], units: [] };
    return rpc('service_my_requests', {}, READ_MS);
  }

  async function fetchJob(id) {
    requireId(id, 'ticket');
    if (demoFlag) return job(id);
    var rows = await fetchJobsInto([id], false);
    return rows[0] || null;
  }
  async function fetchUnit(id) {
    requireId(id, 'RMA part');
    if (demoFlag) return unit(id);
    var rows = await refreshUnits([id]);
    return rows[0] || null;
  }

  // ── service writes ─────────────────────────────────────────────────────────
  function looksLikeJob(o) {
    return !!(o && typeof o === 'object' && o.id != null && ('stage' in o) && ('customer_name' in o || 'public_code' in o));
  }
  // RPC answers vary ({ok, job}, the row itself, a summary). Use a row when
  // there is one; otherwise read the ticket back.
  async function applyJobResult(jobId, res) {
    var row = null;
    if (res && typeof res === 'object') {
      if (looksLikeJob(res.job)) row = res.job;
      else if (looksLikeJob(res.row)) row = res.row;
      else if (looksLikeJob(res)) row = res;
    }
    if (row && String(row.id) === String(jobId) && (jobsById[String(jobId)] || ('created_at' in row && 'customer_name' in row))) {
      mergeJob(row, true);
      emit('jobs');
      return;
    }
    try { await fetchJobsInto([jobId], true); } catch (e) { quiet('jobs')(e); }
  }
  function refreshTechsQuietly() {
    if (demoFlag || !client()) return;
    runKind('techs', generation);
  }
  function openUnitIdsOf(jobId) {
    return Object.keys(unitById).map(function (k) { return unitById[k]; })
      .filter(function (u) { return u.service_job_id === jobId && u.stage !== 'closed'; })
      .map(function (u) { return u.id; });
  }

  // payload per SPEC §2.9 service_create. A client_request_id is added to the
  // CALLER'S object when missing, so a retry with the same object is the
  // same request and cannot create a second ticket.
  async function createJob(payload) {
    writable();
    if (!payload || typeof payload !== 'object') throw new Error('NEO_GATE: Nothing to create.');
    if (!payload.client_request_id) payload.client_request_id = uuid();
    var p = normTsFields(payload);
    var res = await rpc('service_create', { p: p });
    if (res && res.id) {
      try { await fetchJobsInto([String(res.id)], true); } catch (e) { quiet('jobs')(e); }
      refreshTechsQuietly();
    }
    return res;
  }

  // Column-diff UPDATE. Returns the row as the server now has it (or the
  // cached row when nothing differs, without a request).
  async function updateJob(jobId, patch) {
    var c = writable();
    requireId(jobId, 'ticket');
    if (!patch || typeof patch !== 'object') throw new Error('NEO_GATE: Nothing to save.');
    Object.keys(patch).forEach(function (k) {
      if (JSONB_COLS[k]) throw new Error('NEO_GATE: ' + k + ' is recorded when the ticket is created and cannot be edited.');
      if (JOB_RPC_ONLY[k]) throw new Error('NEO_GATE: ' + k + ' changes through its own action (move, claim, assign or priority), not a field edit.');
    });
    var base = jobsById[jobId] || null;
    var diff = diffAgainst(base, normTsFields(patch));
    if (!Object.keys(diff).length) return base;
    var r = await timed(c.from('service_jobs').update(diff).eq('id', jobId).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error("NEO_DENIED: That change was not saved — you may not have access to this ticket, or it no longer exists.");
    mergeJob(r.data, true);
    emit('jobs');
    return jobsById[jobId];
  }

  async function moveJob(jobId, from, to, note, visible, extra) {
    writable();
    requireId(jobId, 'ticket');
    var target = need(to, 'Choose where to move it.');
    var cached = jobsById[jobId];
    var fromStage = clean(from) || (cached && cached.stage) || null;
    var res = await rpc('service_move', {
      p_job_id: jobId,
      p_from: fromStage,
      p_to: target,
      p_note: clean(note),
      // A note is internal unless the caller says the customer may read it;
      // the move itself is always shown (the server decides that part).
      p_visible: visible === true,
      p_extra: normTsFields(extra && typeof extra === 'object' ? extra : {})
    });
    await applyJobResult(jobId, res);
    // Closing a ticket can close the parts that travelled with it.
    var unitIds = openUnitIdsOf(jobId);
    if (unitIds.length) { try { await refreshUnits(unitIds); } catch (e) { quiet('units')(e); } }
    return res;
  }

  async function claimJob(jobId, visitStart, visitEnd, reason) {
    writable();
    requireId(jobId, 'ticket');
    var res = await rpc('service_claim', {
      p_job_id: jobId,
      p_visit_start: normTs('visit_start', visitStart),
      p_visit_end: normTs('visit_end', visitEnd),
      p_reason: clean(reason)
    });
    // Taken by someone else is an answer, not an error: re-read so the board
    // shows who has it.
    await applyJobResult(jobId, res && res.ok !== false ? res : null);
    refreshTechsQuietly();
    return res;
  }

  async function releaseJob(jobId, reason) {
    writable();
    requireId(jobId, 'ticket');
    var why = need(reason, "Say why you're handing it back.");
    var res = await rpc('service_release', { p_job_id: jobId, p_reason: why });
    await applyJobResult(jobId, res);
    refreshTechsQuietly();
    return res;
  }

  // SPEC-AMENDMENTS A16: compare-and-set on the assignee the screen showed.
  // `expected` defaults to the cached assignee; pass it explicitly (null =
  // "it was unassigned") to override.
  async function assignJob(jobId, email, reason, expected) {
    writable();
    requireId(jobId, 'ticket');
    var why = need(reason, 'Give a reason for the assignment.');
    var cached = jobsById[jobId];
    var exp = arguments.length >= 4 ? (expected || null) : ((cached && cached.assignee_email) || null);
    var res = await rpc('service_assign', { p_job_id: jobId, p_email: clean(email), p_reason: why, p_expected: exp });
    await applyJobResult(jobId, res && res.ok !== false ? res : null);
    refreshTechsQuietly();
    return res;
  }

  async function suggestTech(jobId, email, reason) {
    writable();
    requireId(jobId, 'ticket');
    var res = await rpc('service_suggest', { p_job_id: jobId, p_email: clean(email), p_reason: clean(reason) });
    await applyJobResult(jobId, res);
    refreshTechsQuietly();
    return res;
  }

  async function setPriority(jobId, p, reason) {
    writable();
    requireId(jobId, 'ticket');
    if (PRIORITIES.indexOf(p) === -1) throw new Error('NEO_GATE: Choose a priority.');
    var why = need(reason, 'Say why the priority changes.');
    var res = await rpc('service_set_priority', { p_job_id: jobId, p_priority: p, p_reason: why });
    await applyJobResult(jobId, res);
    return res;
  }

  async function addItem(jobId, itemData) {
    writable();
    requireId(jobId, 'ticket');
    if (!itemData || typeof itemData !== 'object') throw new Error('NEO_GATE: Describe the item first.');
    var res = await rpc('service_add_item', { p_job_id: jobId, p_item: itemData });
    var row = res && typeof res === 'object' ? (res.item && res.item.id ? res.item : (res.id ? res : null)) : null;
    if (row && row.job_id) {
      mergeItem(row, true);
      emit('items');
      if (row.is_primary) { try { await fetchJobsInto([jobId], true); } catch (e) { quiet('jobs')(e); } }
    } else {
      try { await fetchJobsInto([jobId], true); } catch (e) { quiet('items')(e); }
    }
    return res;
  }

  async function updateItem(itemId, patch) {
    var c = writable();
    requireId(itemId, 'item');
    if (!patch || typeof patch !== 'object') throw new Error('NEO_GATE: Nothing to save.');
    Object.keys(patch).forEach(function (k) {
      if (ITEM_FIXED[k]) throw new Error('NEO_GATE: ' + k + " can't be changed on an item.");
    });
    var base = itemById[itemId] || null;
    var diff = diffAgainst(base, patch);
    if (!Object.keys(diff).length) return base;
    var r = await timed(c.from('service_items').update(diff).eq('id', itemId).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error("NEO_DENIED: That change was not saved — you may not have access to this item, or it no longer exists.");
    mergeItem(r.data, true);
    emit('items');
    // The primary item feeds the ticket's device line (a trigger copies it).
    if (r.data.is_primary && r.data.job_id) {
      try { await fetchJobsInto([String(r.data.job_id)], true); } catch (e) { quiet('jobs')(e); }
    }
    return itemById[itemId];
  }

  async function addNote(jobId, body, visible) {
    writable();
    requireId(jobId, 'ticket');
    var text = need(body, 'Write something first.');
    return rpc('service_add_note', { p_job_id: jobId, p_body: text, p_visible: visible === true });
  }

  // ── device password (sql/service-v2.1.sql) ────────────────────────────────
  // The value goes straight to the server and straight back to the one caller
  // that asked. It never enters a cache, an event, a log line or an error we
  // build: only has_device_password (a yes/no) is kept, on the cached job.
  var SECRET_MAX = 500;               // service_secrets.secret is 1–500 characters

  // Saves, changes or (with an empty / blank value) removes it. Stored
  // exactly as typed. Desk and up, open tickets only (the server checks).
  async function setDevicePassword(jobId, secret) {
    writable();
    requireId(jobId, 'ticket');
    var s = secret == null ? '' : String(secret);
    if (s.length > SECRET_MAX) throw new Error('NEO_GATE: That password is too long — keep it under ' + SECRET_MAX + ' characters.');
    var res = await rpc('service_set_password', { p_job_id: jobId, p_secret: s.trim() ? s : null });
    await applyJobResult(jobId, res);
    return { ok: !(res && res.ok === false), has_device_password: !!(res && res.has_device_password), unchanged: !!(res && res.unchanged) };
  }

  // Reads it. Every read the server answers with a password is written on the
  // ticket's internal timeline ("Device password viewed by …"). Demo mode has
  // no passwords: it answers a placeholder and sends nothing.
  async function getDevicePassword(jobId) {
    requireId(jobId, 'ticket');
    if (demoFlag) return { secret: '1234 (demo)', set_by_name: 'Demo', set_at: null };
    readable();
    if (!profile()) throw new Error('NEO_DENIED: Sign in first.');
    var res = await rpc('service_get_password', { p_job_id: jobId }, READ_MS);
    var r = res && typeof res === 'object' ? res : {};
    return {
      secret: r.secret == null ? null : String(r.secret),
      set_by_name: r.set_by_name == null ? null : String(r.set_by_name),
      set_at: r.set_at || null
    };
  }

  function getGeo(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      try {
        if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') return finish(null);
        setTimeout(function () { finish(null); }, ms);
        navigator.geolocation.getCurrentPosition(function (pos) {
          var c = pos && pos.coords;
          finish(c ? { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy } : null);
        }, function () { finish(null); }, { enableHighAccuracy: false, timeout: ms, maximumAge: 120000 });
      } catch (e) { finish(null); }
    });
  }

  // "Left shop / Checked in / Checked out". `at` is the moment of the press,
  // not when the location (best effort, at most 3 s) came back. Pass the
  // previous result's client_request_id to retry the same press safely.
  async function fieldActivity(jobId, kind, outcome, note, clientRequestId) {
    writable();
    requireId(jobId, 'ticket');
    if (FIELD_KINDS.indexOf(kind) === -1) throw new Error('NEO_GATE: Unknown field action.');
    var out = clean(outcome);
    if (out && FIELD_OUTCOMES.indexOf(out) === -1) throw new Error('NEO_GATE: Unknown visit outcome.');
    if (kind === 'departed' && !out) throw new Error('NEO_GATE: Say how the visit ended.');
    var at = new Date().toISOString();
    var crid = clientRequestId || uuid();
    var geo = await getGeo(GEO_MS);
    var p = {
      client_request_id: crid, module: 'service', ref_type: 'service_job', ref_id: jobId,
      kind: kind, outcome: out, at: at, note: clean(note), source: 'desktop'
    };
    if (geo && isFinite(geo.lat) && isFinite(geo.lng)) {
      p.lat = geo.lat; p.lng = geo.lng;
      if (isFinite(geo.accuracy)) p.accuracy_m = geo.accuracy;
    }
    var res = await rpc('record_field_activity', { p: p });
    try { await fetchJobsInto([jobId], true); } catch (e) { quiet('jobs')(e); }
    if (res && typeof res === 'object' && !res.client_request_id) res.client_request_id = crid;
    return res;
  }

  // ── RMA writes ─────────────────────────────────────────────────────────────
  function looksLikeUnit(o) {
    return !!(o && typeof o === 'object' && o.id != null && ('intake_id' in o) && ('stage' in o) && ('public_code' in o));
  }
  async function afterRmaWrite(res, ids) {
    var more = [];
    if (res && typeof res === 'object') {
      if (looksLikeUnit(res)) { mergeUnit(res, true); more.push(res.id); }
      if (looksLikeUnit(res.unit)) { mergeUnit(res.unit, true); more.push(res.unit.id); }
      asArray(res.units).forEach(function (u) {
        if (!u || u.id == null) return;
        if (looksLikeUnit(u)) mergeUnit(u, true);
        more.push(u.id);
      });
      if (res.followup_job_id) {
        try { await fetchJobsInto([String(res.followup_job_id)], true); } catch (e) { quiet('jobs')(e); }
      }
      emit('units');
    }
    try { await refreshUnits((ids || []).concat(more)); } catch (e) { quiet('units')(e); }
    return res;
  }

  // payload per SPEC §2.10 rma_create (+ A14 already_with_vendor). Like
  // createJob, a missing client_request_id is added to the caller's object.
  async function createRma(payload) {
    writable();
    if (!payload || typeof payload !== 'object') throw new Error('NEO_GATE: Nothing to create.');
    if (!Array.isArray(payload.units) || !payload.units.length) throw new Error('NEO_GATE: Add at least one part.');
    if (payload.units.length > 20) throw new Error('NEO_GATE: One arrival can hold at most 20 parts. Log the rest as a second arrival.');
    if (!payload.client_request_id) payload.client_request_id = uuid();
    var p = Object.assign({}, payload, {
      units: payload.units.map(function (u) { return normTsFields(u || {}); })
    });
    var res = await rpc('rma_create', { p: p });
    await afterRmaWrite(res, []);
    if (payload.service_job_id && SAFE_ID.test(String(payload.service_job_id))) {
      try { await fetchJobsInto([String(payload.service_job_id)], true); } catch (e) { quiet('jobs')(e); }
    }
    return res;
  }

  async function receiveRma(ids, note) {
    writable();
    var list = idList(ids, 'RMA part');
    var res = await rpc('rma_receive', { p_case_ids: list, p_note: clean(note) });
    return afterRmaWrite(res, list);
  }

  async function moveRma(id, from, to, note, visible, extra) {
    writable();
    requireId(id, 'RMA part');
    var target = need(to, 'Choose where to move it.');
    var cached = unitById[id];
    var res = await rpc('rma_move', {
      p_case_id: id,
      p_from: clean(from) || (cached && cached.stage) || null,
      p_to: target,
      p_note: clean(note),
      p_visible: visible === true,
      p_extra: normTsFields(extra && typeof extra === 'object' ? extra : {})
    });
    return afterRmaWrite(res, [id]);
  }

  // dispatchRma(ids, vendorId, courier, awb, cost, note[, mode, carriedBy])
  // or dispatchRma(ids, { vendorId, mode, courier, awb, cost, note, carriedBy }).
  // SPEC-AMENDMENTS A9: an AWB only for a courier; otherwise who carried it or
  // a note.
  async function dispatchRma(ids, vendorId, courier, awb, cost, note, mode, carriedBy) {
    writable();
    var list = idList(ids, 'RMA part');
    var o = (vendorId && typeof vendorId === 'object')
      ? vendorId
      : { vendorId: vendorId, courier: courier, awb: awb, cost: cost, note: note, mode: mode, carriedBy: carriedBy };
    var m = clean(o.mode) || 'courier';
    if (SHIP_MODES.indexOf(m) === -1) throw new Error('NEO_GATE: Choose how it is going to the vendor.');
    var vid = toInt(o.vendorId);
    if (vid == null) throw new Error('NEO_GATE: Choose the vendor.');
    var awbText = clean(o.awb);
    if (m === 'courier' && !awbText) throw new Error('NEO_GATE: Enter the AWB (tracking number) from the courier slip.');
    if (m !== 'courier' && !clean(o.carriedBy) && !clean(o.note)) throw new Error('NEO_GATE: Say who carried it, or add a note.');
    var res = await rpc('rma_dispatch', {
      p_case_ids: list, p_vendor_id: vid, p_mode: m, p_courier: clean(o.courier), p_awb: awbText,
      p_cost: toNum(o.cost), p_note: clean(o.note), p_carried_by: clean(o.carriedBy)
    });
    return afterRmaWrite(res, list);
  }

  async function vendorResult(id, result, reason, replacementSerial, courier, awb, note) {
    writable();
    requireId(id, 'RMA part');
    if (VENDOR_RESULTS.indexOf(result) === -1) throw new Error('NEO_GATE: Choose what the vendor did.');
    var serial = clean(replacementSerial);
    if (result === 'replaced' && !serial) throw new Error('NEO_GATE: Enter the serial of the replacement part.');
    var res = await rpc('rma_vendor_result', {
      p_case_id: id, p_result: result, p_reason: clean(reason), p_replacement_serial: serial,
      p_courier: clean(courier), p_awb: clean(awb), p_note: clean(note)
    });
    return afterRmaWrite(res, [id]);
  }

  async function setFee(id, amount, feeStatus, ref, note) {
    writable();
    requireId(id, 'RMA part');
    if (FEE_STATUSES.indexOf(feeStatus) === -1) throw new Error('NEO_GATE: Choose the fee status.');
    var amt = toNum(amount);
    if (amt != null && amt < 0) throw new Error("NEO_GATE: The fee can't be negative.");
    if (feeStatus === 'paid' && !clean(ref)) throw new Error('NEO_GATE: Enter the bill number for the payment.');
    if (feeStatus === 'waived' && !clean(note)) throw new Error('NEO_GATE: Say why the fee is waived.');
    var res = await rpc('rma_set_fee', { p_case_id: id, p_amount: amt, p_status: feeStatus, p_ref: clean(ref), p_note: clean(note) });
    return afterRmaWrite(res, [id]);
  }

  // SPEC-AMENDMENTS A5: an in-store ticket goes to 'ready' (outcome, normally
  // returned_rma_pending) or 'in_service'; an on-site one to 'revisit_needed'
  // or 'work_done'. The parts may go back by courier. No target (null or '')
  // only releases the parts: a closed ticket stays closed, and the server
  // decides whether an open one may stay where it is.
  async function releaseHold(ids, jobTo, outcome, note, returnMethod, returnAddress) {
    writable();
    var list = idList(ids, 'RMA part');
    var to = (jobTo == null || jobTo === '') ? null : jobTo;
    if (to !== null && RELEASE_TARGETS.indexOf(to) === -1) throw new Error('NEO_GATE: Choose what happens to the ticket now.');
    var params = {
      p_case_ids: list, p_job_to: to,
      // Only 'ready' records an outcome; the server ignores it for the rest.
      p_outcome: to === 'ready' ? (clean(outcome) || 'returned_rma_pending') : null,
      p_note: clean(note)
    };
    // Sent only when used, so this works against the signature with or
    // without A5's two optional parameters.
    var rm = clean(returnMethod);
    if (rm) {
      if (rm === 'courier' && !clean(returnAddress)) throw new Error('NEO_GATE: Enter the address to courier the part back to.');
      params.p_return_method = rm;
      params.p_return_address = clean(returnAddress);
    }
    var res = await rpc('rma_release_hold', params);
    var jobIds = uniq(list.map(function (id) { return unitById[id] && unitById[id].service_job_id; }));
    await afterRmaWrite(res, list);
    if (jobIds.length) { try { await fetchJobsInto(jobIds, true); } catch (e) { quiet('jobs')(e); } }
    return res;
  }

  async function advanceReplace(id, stockSerial, note) {
    writable();
    requireId(id, 'RMA part');
    var serial = need(stockSerial, 'Enter the serial of the part taken from stock.');
    var res = await rpc('rma_advance_replace', { p_case_id: id, p_stock_serial: serial, p_note: clean(note) });
    return afterRmaWrite(res, [id]);
  }

  async function claimRma(id) {
    writable();
    requireId(id, 'RMA part');
    var res = await rpc('rma_claim', { p_case_id: id });
    return afterRmaWrite(res, [id]);
  }

  async function rmaNote(id, body, visible) {
    writable();
    requireId(id, 'RMA part');
    var text = need(body, 'Write something first.');
    return rpc('rma_add_note', { p_case_id: id, p_body: text, p_visible: visible === true });
  }

  // Column-diff UPDATE, only the columns the server grants.
  async function updateRma(id, patch) {
    var c = writable();
    requireId(id, 'RMA part');
    if (!patch || typeof patch !== 'object') throw new Error('NEO_GATE: Nothing to save.');
    var clean2 = {};
    Object.keys(patch).forEach(function (k) {
      if (k === 'updated_at') return;            // the trigger stamps it
      if (!UNIT_EDITABLE[k]) throw new Error('NEO_GATE: ' + k + " can't be edited here.");
      clean2[k] = k === 'vendor_id' ? toInt(patch[k]) : patch[k];
    });
    var base = unitById[id] || null;
    var diff = diffAgainst(base, normTsFields(clean2));
    if (!Object.keys(diff).length) return base;
    var r = await timed(c.from('rma_cases').update(diff).eq('id', id).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error("NEO_DENIED: That change was not saved — you may not have access to this part, or it no longer exists.");
    mergeUnit(r.data, true);
    emit('units');
    // Vendor and expected date feed the linked ticket's "waiting on" line.
    if (r.data.service_job_id) { try { await fetchJobsInto([String(r.data.service_job_id)], true); } catch (e) { quiet('jobs')(e); } }
    return unitById[id];
  }

  // Not in SPEC §4.3 by name; the intake's column grant (§2.6) exists, and
  // this keeps the RMA screen from writing to it directly.
  async function updateIntake(id, patch) {
    var c = writable();
    requireId(id, 'RMA arrival');
    if (!patch || typeof patch !== 'object') throw new Error('NEO_GATE: Nothing to save.');
    Object.keys(patch).forEach(function (k) {
      if (!INTAKE_EDITABLE[k]) throw new Error('NEO_GATE: ' + k + " can't be edited here.");
    });
    var base = intakeById[id] || null;
    var diff = diffAgainst(base, patch);
    if (!Object.keys(diff).length) return base;
    var r = await timed(c.from('rma_intakes').update(diff).eq('id', id).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error("NEO_DENIED: That change was not saved — you may not have access to this arrival, or it no longer exists.");
    mergeIntake(r.data);
    emit('intakes');
    emit('units');
    return intakeById[id];
  }

  async function addVendor(name, publicName, tatDays, kind) {
    var c = writable();
    var n = need(name, 'Enter the vendor name.');
    var tat = tatDays == null || tatDays === '' ? 14 : toInt(tatDays);
    if (tat == null || tat < 1 || tat > 365) throw new Error('NEO_GATE: Typical turnaround must be between 1 and 365 days.');
    var k = clean(kind) || 'brand';
    if (['brand', 'distributor', 'service_centre'].indexOf(k) === -1) throw new Error('NEO_GATE: Choose the kind of vendor.');
    var r = await timed(c.from('rma_vendors').insert({
      name: n, public_name: clean(publicName) || n, typical_tat_days: tat, kind: k
    }).select().single(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) {
      var e = asError(r.error);
      if (String(e.code) === '23505') throw new Error('NEO_GATE: A vendor called ' + n + ' already exists.');
      throw e;
    }
    mergeVendor(r.data);
    emit('vendors');
    return vendorById[String(r.data.id)];
  }

  // ── media writes ───────────────────────────────────────────────────────────
  function fileInfo(file) {
    var t = String(file.type || '').toLowerCase();
    var n = String(file.name || '').toLowerCase();
    var ext = (n.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/pjpeg') return { kind: 'jpeg', mime: 'image/jpeg', ext: 'jpg', resize: true };
    if (t === 'image/png') return { kind: 'png', mime: 'image/png', ext: 'png', resize: true };
    if (t === 'image/webp') return { kind: 'webp', mime: 'image/webp', ext: 'webp', resize: true };
    if (t === 'image/heic' || t === 'image/heif') return { kind: 'heic', mime: t, ext: t === 'image/heif' ? 'heif' : 'heic', resize: false };
    if (t === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf', resize: false };
    // Windows often reports no type (HEIC) or a generic one: go by extension.
    if (!t || t === 'application/octet-stream') {
      if (ext === 'jpg' || ext === 'jpeg') return { kind: 'jpeg', mime: 'image/jpeg', ext: 'jpg', resize: true };
      if (ext === 'png') return { kind: 'png', mime: 'image/png', ext: 'png', resize: true };
      if (ext === 'webp') return { kind: 'webp', mime: 'image/webp', ext: 'webp', resize: true };
      if (ext === 'heic') return { kind: 'heic', mime: 'image/heic', ext: 'heic', resize: false };
      if (ext === 'heif') return { kind: 'heic', mime: 'image/heif', ext: 'heif', resize: false };
      if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf', resize: false };
    }
    return null;
  }

  function loadImageEl(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  // Longest side ≤ 2048 px, JPEG q 0.85. Re-encoding also drops EXIF (a
  // phone photo's GPS position). Any failure → null, and the original is
  // uploaded unchanged.
  async function shrinkImage(file) {
    var bmp = null, url = null;
    try {
      var src, w, h;
      if (typeof createImageBitmap === 'function') {
        try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) { bmp = await createImageBitmap(file); }
        src = bmp; w = bmp.width; h = bmp.height;
      } else {
        url = URL.createObjectURL(file);
        src = await loadImageEl(url); w = src.naturalWidth; h = src.naturalHeight;
      }
      if (!w || !h) return null;
      var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';                 // a transparent PNG must not turn black
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);
      var blob = await new Promise(function (resolve) {
        try { canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', JPEG_Q); } catch (e) { resolve(null); }
      });
      return blob && blob.size ? blob : null;
    } catch (e) {
      return null;
    } finally {
      try { if (bmp && typeof bmp.close === 'function') bmp.close(); } catch (e) { /* ignore */ }
      try { if (url) URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }
  }

  function phaseFor(r) {
    if (r === 'during' || r === 'after') return r;
    if (INTAKE_PHASE_ROLES.indexOf(r) !== -1) return 'intake';
    // SPEC-GAP: §4.3 names the phase only for the roles above. The legacy
    // column has only ever held intake / during / after (old clients filter on
    // it), so the remaining roles map onto those three.
    if (r === 'return_condition') return 'after';
    return 'during';                              // vendor_doc, other
  }

  // uploadMedia({ jobId?, caseId?, itemId?, role, remark, file }) → the new
  // media row. Path: <jobId>/<rand>.<ext>, or rma/<caseId>/<rand>.<ext> when
  // the photo belongs to an RMA part (the row then carries both ids if both
  // were given). The stored object is removed again if the row cannot be
  // written, so the bucket never fills with files nothing points at.
  async function uploadMedia(opts) {
    var c = writable();
    opts = opts || {};
    var jobId = opts.jobId ? requireId(String(opts.jobId), 'ticket') : null;
    var caseId = opts.caseId ? requireId(String(opts.caseId), 'RMA part') : null;
    var itemId = opts.itemId ? requireId(String(opts.itemId), 'item') : null;
    if (!jobId && !caseId) throw new Error('NEO_GATE: Say which ticket or RMA part the photo belongs to.');
    var r = opts.role || 'condition';
    if (MEDIA_ROLES.indexOf(r) === -1) throw new Error('NEO_GATE: Choose what the photo shows.');
    var file = opts.file;
    if (!file || typeof file.size !== 'number') throw new Error('NEO_GATE: Choose a file first.');
    if (!file.size) throw new Error('NEO_GATE: That file is empty.');
    var info = fileInfo(file);
    if (!info) throw new Error("NEO_GATE: That file type isn't supported. Use JPEG, PNG, WebP, HEIC or PDF.");
    if (info.kind === 'pdf' && PDF_ROLES.indexOf(r) === -1) {
      throw new Error('NEO_GATE: A PDF can only be added as an invoice or a vendor document.');
    }
    if (file.size > MAX_FILE) throw new Error('NEO_GATE: That file is over the 15 MB limit.');

    var body = file, mime = info.mime, ext = info.ext;
    if (info.resize) {
      var small = await shrinkImage(file);
      if (small && small.size <= MAX_FILE) { body = small; mime = 'image/jpeg'; ext = 'jpg'; }
    }

    var path = (caseId ? 'rma/' + caseId : jobId) + '/' + Date.now().toString(36) + '-' + randToken(8) + '.' + ext;
    var up = await timed(c.storage.from(BUCKET).upload(path, body, { upsert: false, contentType: mime, cacheControl: '3600' }),
      UPLOAD_MS, 'NEO_TIMEOUT: The upload took too long. Check the connection and try again.');
    if (up && up.error) throw asError(up.error);

    var now = new Date().toISOString();
    var remark = clean(opts.remark);
    var row = {
      job_id: jobId, rma_case_id: caseId, service_item_id: itemId,
      path: path, phase: phaseFor(r), role: r,
      remark: remark, remark_by: remark ? remarkBy() : null, remark_at: remark ? now : null,
      uploaded_by: myEmail(), uploaded_name: myName()
    };
    var ins;
    try {
      ins = await timed(c.from('service_media').insert(row).select().single(), WRITE_MS, WRITE_TIMEOUT_MSG);
    } catch (e) {
      // A timeout may still have written the row; removing the file then
      // would leave a row pointing at nothing. Keep the file.
      if (!e || !e.timeout) { try { await c.storage.from(BUCKET).remove([path]); } catch (e2) { /* orphan; costs storage only */ } }
      throw e;
    }
    if (ins && ins.error) {
      try { await c.storage.from(BUCKET).remove([path]); } catch (e3) { /* orphan; costs storage only */ }
      throw asError(ins.error);
    }
    return decorateMedia(ins.data, null);
  }

  // Who wrote a remark, as the gallery shows it ("Remark by …"): the name
  // when the profile has one. SPEC-GAP: the spec does not say name or email.
  function remarkBy() { return myName() || myEmail(); }

  // Only the remark columns — never a whole-row write.
  async function setMediaRemark(mediaId, remark) {
    var c = writable();
    if (mediaId == null || mediaId === '') throw new Error('NEO_GATE: That photo is not valid. Reopen the photos and try again.');
    var text = clean(remark);
    var patch = { remark: text, remark_by: remarkBy(), remark_at: new Date().toISOString() };
    var r = await timed(c.from('service_media').update(patch).eq('id', mediaId).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error('NEO_DENIED: That remark was not saved — the photo may have been removed.');
    var prev = mediaById[String(mediaId)];
    return decorateMedia(r.data, prev ? prev.url : null);
  }

  async function setMediaVisible(mediaId, visible) {
    var c = writable();
    if (mediaId == null || mediaId === '') throw new Error('NEO_GATE: That photo is not valid. Reopen the photos and try again.');
    var known = mediaById[String(mediaId)];
    if (visible && known && PRIVATE_ROLES.indexOf(displayRole(known)) !== -1) {
      throw new Error('NEO_GATE: Invoices, serial labels and vendor documents are never shown to the customer.');
    }
    var r = await timed(c.from('service_media').update({ customer_visible: !!visible }).eq('id', mediaId).select().maybeSingle(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    if (!r || !r.data) throw new Error('NEO_DENIED: That change was not saved — the photo may have been removed.');
    return decorateMedia(r.data, known ? known.url : null);
  }

  // Row first, then the file: a failed file removal leaves an unreferenced
  // object (storage cost only); the other order leaves a row pointing at
  // nothing, a broken tile forever.
  async function deleteMedia(rowOrId) {
    var c = writable();
    var row = (rowOrId && typeof rowOrId === 'object') ? rowOrId : mediaById[String(rowOrId)];
    var id = row ? row.id : rowOrId;
    if (id == null || id === '') throw new Error('NEO_GATE: That photo is not valid. Reopen the photos and try again.');
    var r = await timed(c.from('service_media').delete().eq('id', id).select(), WRITE_MS, WRITE_TIMEOUT_MSG);
    if (r && r.error) throw asError(r.error);
    var gone = (r && r.data) || [];
    if (!gone.length) throw new Error('NEO_DENIED: That photo was not deleted. Only a lead can delete photos, or it was already removed.');
    var path = (gone[0] && gone[0].path) || (row && row.path) || null;
    var objectRemoved = false;
    if (path) {
      try {
        var rm = await timed(c.storage.from(BUCKET).remove([path]), WRITE_MS);
        objectRemoved = !(rm && rm.error);
      } catch (e) { objectRemoved = false; }
    }
    delete mediaById[String(id)];
    return { ok: true, id: id, path: path, objectRemoved: objectRemoved };
  }

  // ── module access (Settings → Operations) ─────────────────────────────────
  async function moduleAccessList() {
    var res = await rpc('module_access_list', {}, READ_MS);
    return Array.isArray(res) ? res : [];
  }

  async function moduleAccessSet(email, module, roleKey) {
    writable();
    var e = need(email, 'Choose a person.');
    if (MODULES.indexOf(module) === -1) throw new Error('NEO_GATE: Choose a module.');
    var r = clean(roleKey);
    if (r && ROLES.indexOf(r) === -1) throw new Error('NEO_GATE: Choose Desk, Tech or Lead.');
    return rpc('module_access_set', { p_email: e, p_module: module, p_role: r });
  }

  var api = {
    // state
    isDemo: isDemo,
    setDemo: setDemo,
    ensureLoaded: ensureLoaded,
    reload: reload,
    isLoaded: isLoaded,
    errors: errors,
    on: on,
    off: off,
    ready: ready,

    // getters
    jobs: jobs,
    job: job,
    itemsOf: itemsOf,
    item: item,
    units: units,
    unit: unit,
    unitsOfJob: unitsOfJob,
    unitsOfIntake: unitsOfIntake,
    intake: intake,
    vendors: vendors,
    vendor: vendor,
    staff: staff,
    techs: techs,
    me: me,
    role: role,
    nameOf: nameOf,

    // reads
    events: events,
    rmaEvents: rmaEvents,
    media: media,
    lookupCustomer: lookupCustomer,
    myModules: myModules,
    findBuilds: findBuilds,
    myRequests: myRequests,
    fetchJob: fetchJob,
    fetchUnit: fetchUnit,

    // service writes
    createJob: createJob,
    updateJob: updateJob,
    moveJob: moveJob,
    claimJob: claimJob,
    releaseJob: releaseJob,
    assignJob: assignJob,
    suggestTech: suggestTech,
    setPriority: setPriority,
    addItem: addItem,
    updateItem: updateItem,
    addNote: addNote,
    setDevicePassword: setDevicePassword,
    getDevicePassword: getDevicePassword,
    fieldActivity: fieldActivity,

    // RMA writes
    createRma: createRma,
    receiveRma: receiveRma,
    moveRma: moveRma,
    dispatchRma: dispatchRma,
    vendorResult: vendorResult,
    setFee: setFee,
    releaseHold: releaseHold,
    advanceReplace: advanceReplace,
    claimRma: claimRma,
    rmaNote: rmaNote,
    updateRma: updateRma,
    updateIntake: updateIntake,
    addVendor: addVendor,

    // media
    uploadMedia: uploadMedia,
    setMediaRemark: setMediaRemark,
    setMediaVisible: setMediaVisible,
    deleteMedia: deleteMedia,

    // module access
    moduleAccessList: moduleAccessList,
    moduleAccessSet: moduleAccessSet,

    // helpers other modules may want
    newRequestId: uuid,
    normPhone: normPhone,
    phoneOk: phoneOk
  };
  // Read-only: the most recent load problem as a sentence, or null.
  Object.defineProperty(api, 'lastError', { enumerable: true, get: function () { return lastErr; } });

  window.NeoQcData = api;
})();
