/*
  Neo Tokyo Operations — RMA: parts on warranty claims (#rma-screen).

  Loaded after app.js, modules.js, ops-ui.js, ops-data.js, photo-tray.js and
  service.js. Every read and write goes through NeoQcData (the one file that
  talks to Supabase for service and RMA); dialogs, chips, KPI tiles, icons and
  formatting come from NeoQcUI; photos from NeoQcPhotoTray; and EVERY RMA RULE
  — labels, whose turn it is, how late, what may follow what, what blocks a
  move — comes from window.NeoQcService. Nothing here re-derives a rule: the
  status model's own header explains why two copies of a rule always end up
  disagreeing. (The one exception is a short, feature-detected bridge for the
  SPEC-AMENDMENTS the shared model may not carry yet — see `shims()`.)

  THE SHAPE OF THE WORK. One rma_cases row per physical part. Parts that
  arrived together (a courier box from a third-party technician holding three
  parts for three of his customers) share one rma_intakes row, so the sender,
  the AWB and the return address are typed once — but each part gets its own
  RM code, its own owner, its own vendor and its own clock, because the three
  parts come back from three manufacturers on three different days.

  THE RULE THIS FILE LIVES BY (the same one service.js lives by): every async
  handler that acts on "the open unit" binds `var unitId = openUnitId;` on its
  first line and never reads openUnitId again except to ask "is the panel still
  showing that unit?" before repainting. The panel can be closed, or pointed at
  another customer's part, while a request is in flight; reading module state
  after an await is how one customer's part ends up with another's photos.
*/
(function () {
  'use strict';

  // ── the other modules, resolved lazily (load order is the shell's job) ────
  function data()    { return window.NeoQcData || null; }
  function ui()      { return window.NeoQcUI || null; }
  function model()   { return window.NeoQcService || null; }
  function catalog() { return window.NeoQcCatalog || null; }
  function trays()   { return window.NeoQcPhotoTray || null; }

  // What the screen cannot work without. When a piece is missing the screen
  // says which file is out of date instead of half-working.
  var MODEL_NEEDS = ['rmaColumnOf', 'rmaStaffLabel', 'rmaBallOf', 'rmaRisk', 'rmaWaitingSentence',
                     'rmaNextStages', 'rmaGateProblems', 'daysInStage'];
  var UI_NEEDS = ['esc', 'errText', 'dialog', 'chips', 'readChips', 'setChips', 'bindChips', 'kpis', 'waOpen'];
  function modelReady() {
    var m = model();
    return !!m && MODEL_NEEDS.every(function (k) { return typeof m[k] === 'function'; });
  }
  function uiReady() {
    var u = ui();
    return !!u && UI_NEEDS.every(function (k) { return typeof u[k] === 'function'; });
  }
  function missingPiece() {
    if (!data()) return 'The data layer (ops-data.js) is not loaded.';
    if (!uiReady()) return 'The screen kit (ops-ui.js) is not loaded or is out of date.';
    if (!modelReady()) return 'The RMA status model is not loaded — shared/service-status.js is out of date on this machine.';
    return '';
  }

  // ── small utilities ────────────────────────────────────────────────────────
  var DAY = 86400000;
  var DEMO_MSG = 'Demo data is read-only. Turn it off in Settings to work on real tickets.';
  var TRACK_URL = 'https://neoqctracker.netlify.app/?view=service&code=';

  function el(id) { return document.getElementById(id); }
  function setText(id, t) { var e = el(id); if (e) e.textContent = t == null ? '' : String(t); }

  // HTML built from strings goes through esc(), and only ever into element
  // content or DOUBLE-quoted attributes. Never untrusted text in a
  // single-quoted attribute or inline script.
  function esc(s) {
    var v = s == null ? '' : String(s);
    var u = ui();
    if (u && typeof u.esc === 'function') return u.esc(v);
    if (typeof escapeHtmlLite === 'function') return escapeHtmlLite(v).replace(/'/g, '&#39;');
    return v.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m, t, dur) { if (typeof showToast === 'function') showToast(m, t || 'info', dur); }

  // Whose session a piece of work belongs to. Signing out force-closes the
  // panel and the New RMA form (endSession, below the wiring). A save or an
  // upload still in flight then finishes on its own, but it belongs to the
  // person who left: its toast would land on the login screen or in the next
  // person's session, and a follow-up write would run as nobody — or as
  // whoever signed in next. So every async flow takes `var g = sessionGen;`
  // on its first lines, next to `var unitId = openUnitId;`, and once
  // isStale(g) it neither speaks, nor repaints, nor writes again.
  var sessionGen = 0;
  function isStale(g) { return g !== sessionGen; }

  function confirmBox(message, opts) {
    if (typeof showConfirm === 'function') return showConfirm(message, opts || {});
    var u = ui();
    if (u && typeof u.confirm === 'function') return u.confirm(message, opts || {});
    return Promise.resolve(false);
  }

  function isDemoErr(e) {
    var m = e && (e.message || (typeof e === 'string' ? e : ''));
    return typeof m === 'string' && /\bDEMO_READONLY\b/.test(m);
  }
  // Server errors carry a human sentence after a NEO_ prefix; show that, not
  // the code. A failed write never clears what the user typed.
  function errMsg(e) {
    if (isDemoErr(e)) return DEMO_MSG;
    var u = ui();
    if (u && typeof u.errText === 'function') {
      try { var t = u.errText(e); if (t) return String(t); } catch (x) { /* fall through */ }
    }
    var m = (e && (e.message || e.error_description || e.details)) || (typeof e === 'string' ? e : '') || 'Something went wrong.';
    var mm = /NEO_[A-Z_]+:\s*([\s\S]*)$/.exec(String(m));
    return mm ? mm[1].trim() : String(m);
  }
  // For dialogs and status lines: the sentence, plus the toast the spec asks
  // for when the reason is demo mode.
  function failText(e) {
    var m = errMsg(e);
    if (isDemoErr(e)) toast(m, 'warning');
    return m;
  }

  function uuid() {
    var d = data();
    if (d && typeof d.newRequestId === 'function') { try { return d.newRequestId(); } catch (e) { /* below */ } }
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* fall back below */ }
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // The phone rule (SPEC-AMENDMENTS A1'), one rule everywhere. Its one JS copy
  // is shared/service-catalog.js (SQL norm_phone() / phone_ok() are the same
  // rule); the lines below repeat it only for a machine whose catalog is older
  // than this file. Digits only, one leading 00 dropped; 10 digits → 91 + d,
  // 11 starting with 0 → 91 + the last 10; anything else keeps its digits, so
  // a Gulf or NRI number keeps its country code. Valid = 12 to 15 digits, or
  // 11 under a code whose numbers are 3 + 8 digits (Kuwait, Oman, Bahrain,
  // Qatar) — an Indian mobile typed with one digit too many is still refused.
  var PHONE_11_CODES = ['965', '968', '973', '974'];
  function normPhone(p) {
    var c = catalog();
    if (c && typeof c.normPhone === 'function') {
      try { return String(c.normPhone(p) || ''); } catch (e) { /* the copy below */ }
    }
    var d = String(p == null ? '' : p).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }
  // Takes a NORMALISED number (normPhone's output).
  function phoneOk(n) {
    var c = catalog();
    if (c && typeof c.phoneOk === 'function') {
      try { return !!c.phoneOk(n); } catch (e) { /* the copy below */ }
    }
    var d = String(n == null ? '' : n);
    if (!/^\d+$/.test(d)) return false;
    if (d.length >= 12 && d.length <= 15) return true;
    return d.length === 11 && PHONE_11_CODES.indexOf(d.slice(0, 3)) !== -1;
  }
  // As typed.
  function validPhone(p) {
    var c = catalog();
    if (c && typeof c.isValidPhone === 'function') {
      try { return !!c.isValidPhone(p); } catch (e) { /* the copy below */ }
    }
    return phoneOk(normPhone(p));
  }
  function showPhone(p) {
    var u = ui();
    if (u && typeof u.fmtPhone === 'function') { var f = u.fmtPhone(p); if (f) return f; }
    return String(p || '');
  }

  function ms(v) {
    if (!v) return null;
    var t = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
    return isNaN(t) ? null : t;
  }
  function midnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // Local calendar day for <input type="date">, never UTC.
  function isoToDay(iso) {
    var u = ui();
    if (u && typeof u.toDayInput === 'function') return u.toDayInput(iso);
    var t = ms(iso);
    if (t == null) return '';
    var d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDays(d) {
    var u = ui();
    if (u && typeof u.fmtDays === 'function') return u.fmtDays(d);
    d = Number(d) || 0;
    if (d < 1) return Math.max(0, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }
  function fmtDate(iso) {
    var u = ui();
    if (u && typeof u.fmtDate === 'function') return u.fmtDate(iso);
    var t = ms(iso);
    return t == null ? '—' : new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function fmtDateTime(iso) {
    var u = ui();
    if (u && typeof u.fmtDateTime === 'function') return u.fmtDateTime(iso);
    var t = ms(iso);
    return t == null ? '—' : new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtINR(n) {
    var u = ui();
    if (u && typeof u.fmtINR === 'function') return u.fmtINR(n);
    var v = Number(n);
    return isFinite(v) ? '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  }
  function riskClass(r) {
    var u = ui();
    if (u && typeof u.riskClass === 'function') return u.riskClass(r);
    return r === 2 ? ' risk-breached' : r === 1 ? ' risk-soon' : '';
  }
  // Late is red AND the word "late" — colour is never the only signal.
  function lateTag() {
    var u = ui();
    if (u && typeof u.lateTag === 'function') return u.lateTag(2);
    return '<span class="ops-late">late</span>';
  }
  function parseMoney(s) {
    var t = String(s == null ? '' : s).replace(/[₹,\s]/g, '');
    if (t === '') return null;
    var n = Number(t);
    return isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  function copyText(t, what) {
    var u = ui();
    var p = (u && typeof u.copyText === 'function') ? u.copyText(t) : Promise.resolve(false);
    Promise.resolve(p).then(function (ok) {
      toast(ok ? (what || 'Text') + ' copied.' : 'Could not copy to the clipboard.', ok ? 'success' : 'error', 2500);
    });
  }
  function myName() { var p = me(); return (p && (p.full_name || p.email)) || 'staff'; }

  // ── vocabulary ─────────────────────────────────────────────────────────────
  // Keys are the spec's; labels come from the shared model when it has them.
  // The local tables are UI wording or fallbacks, never rules.
  function lbl(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.label || v.staff || v.name || '';
  }
  function fromModel(mapName, key) {
    var m = model();
    return (m && m[mapName] && key != null) ? lbl(m[mapName][key]) : '';
  }

  var KIND_ORDER = ['gpu', 'motherboard', 'cpu', 'ram', 'ssd', 'hdd', 'psu', 'cooler', 'monitor', 'peripheral', 'laptop', 'pc', 'other'];
  var KIND_FALLBACK = { pc: 'Desktop PC', laptop: 'Laptop', gpu: 'Graphics card', psu: 'Power supply', ram: 'RAM',
    ssd: 'SSD', hdd: 'Hard drive', motherboard: 'Motherboard', cpu: 'Processor', cooler: 'Cooler',
    monitor: 'Monitor', peripheral: 'Peripheral', other: 'Other' };
  function kindLabel(k) { return fromModel('ITEM_KINDS', k) || KIND_FALLBACK[k] || k || 'Part'; }
  function kindIcon(k) {
    var u = ui();
    if (u && typeof u.itemIcon === 'function') { try { return u.itemIcon(k || 'other'); } catch (e) { /* text below */ } }
    return esc(kindLabel(k));
  }
  function isDrive(k) { return k === 'ssd' || k === 'hdd'; }

  var SOURCE_FALLBACK = { from_ticket: 'From a ticket', walk_in: 'Walk-in', courier: 'Courier', field: 'Pulled on site',
    stock: 'Shop stock', website: 'Website' };
  function sourceLabel(s) { return fromModel('RMA_SOURCES', s) || SOURCE_FALLBACK[s] || s || '—'; }

  var SENDER_FALLBACK = { customer: 'Customer', third_party_tech: 'Third-party technician', our_tech: 'Our technician', shop: 'Shop' };
  function senderKindLabel(k) { return fromModel('SENDER_KINDS', k) || SENDER_FALLBACK[k] || k || ''; }

  var DIAG_OPTIONS = [
    { value: 'us', label: 'Us' },
    { value: 'third_party', label: 'Third-party technician' },
    { value: 'customer', label: 'The customer' }
  ];

  var BUY_FALLBACK = { neo_tokyo: 'Neo Tokyo', elsewhere: 'Bought elsewhere', unknown: 'Not sure' };
  function buyLabel(k) { return fromModel('PURCHASE_SOURCES', k) || BUY_FALLBACK[k] || k || ''; }
  var BUY_KEYS = ['neo_tokyo', 'elsewhere', 'unknown'];

  var RETURN_LABELS = { collect: 'Collect in store', courier: 'Courier back', with_device: 'With the device' };

  // SPEC-AMENDMENTS A10 adds shipped_to_customer (the vendor sends it straight
  // to the customer).
  var RESULT_FALLBACK = { replaced: 'Replaced', repaired: 'Repaired', credit_note: 'Credit note', rejected: 'Rejected',
    lost: 'Lost', shipped_to_customer: 'Shipped straight to the customer' };
  var RESULT_KEYS = ['replaced', 'repaired', 'credit_note', 'rejected', 'lost', 'shipped_to_customer'];
  function resultLabel(k) { return fromModel('RMA_VENDOR_RESULTS', k) || RESULT_FALLBACK[k] || k || ''; }

  // SPEC-AMENDMENTS A9: how a parcel goes to the vendor.
  var SHIP_MODES = [
    { value: 'courier', label: 'Courier' },
    { value: 'hand_delivery', label: 'Hand delivered' },
    { value: 'vendor_pickup', label: 'Vendor picked it up' },
    { value: 'bus_parcel', label: 'Bus parcel' }
  ];

  // SPEC-AMENDMENTS A11: what happened to the data on a drive, in plain words.
  var DATA_HANDLING = [
    { value: 'wiped_by_us', label: 'We wiped it' },
    { value: 'customer_consents', label: 'Customer agreed to send it with data' },
    { value: 'unreadable_informed', label: 'Drive unreadable — customer informed' }
  ];
  function dataHandlingLabel(k) {
    var o = DATA_HANDLING.filter(function (x) { return x.value === k; })[0];
    return o ? o.label : (k || '');
  }

  var FEE_WORDS = { n_a: 'No fee', quoted: 'Quoted — not accepted yet', accepted: 'Accepted — to collect',
    paid: 'Paid', waived: 'Waived' };

  var DISP_FALLBACK = { refitted: 'Fitted back in your device', replaced: 'Replaced under warranty',
    repaired: 'Repaired under warranty', credit_note: 'Settled with the manufacturer by credit',
    rejected_returned: 'Warranty claim declined — part returned', no_fault_found: 'No fault found — part returned',
    out_of_warranty: 'Out of warranty — part returned', withdrawn: 'Claim withdrawn',
    converted_to_repair: 'Moved to a paid repair', restocked: 'Replaced from our stock',
    scrapped_with_consent: 'Disposed of with your consent', lost_compensated: 'Settled for a lost part' };
  function dispLabel(k) { return fromModel('RMA_DISPOSITIONS', k) || DISP_FALLBACK[k] || k || ''; }

  var VENDOR_KINDS = [
    { value: 'brand', label: 'Brand' },
    { value: 'distributor', label: 'Distributor' },
    { value: 'service_centre', label: 'Service centre' }
  ];
  function vendorKindLabel(k) {
    var o = VENDOR_KINDS.filter(function (x) { return x.value === k; })[0];
    return o ? o.label : (k || '');
  }

  var STAGE_FALLBACK = { with_tech: 'With our technician' };
  function staffStage(stage) {
    var l = '';
    try { l = model().rmaStaffLabel(stage); } catch (e) { l = ''; }
    if ((!l || l === stage || l === 'Unknown') && STAGE_FALLBACK[stage]) return STAGE_FALLBACK[stage];
    return l || stage || '';
  }

  var FEE_SETTLED = { n_a: 1, paid: 1, waived: 1 };
  function feeOwed(u) { return !!u && !FEE_SETTLED[u.fee_status || 'n_a']; }

  // ── bridging the amendments the shared model may not carry yet ─────────────
  // Feature-detected once against the loaded model, so this file does the
  // right thing with both the pre- and post-amendment versions of
  // shared/service-status.js — and stops bridging the moment it is updated.
  var shimCache = null;
  function shims() {
    if (shimCache) return shimCache;
    var m = model();
    var s = { withTech: false, vendorDoc: false, data: false };
    if (m && typeof m.rmaGateProblems === 'function') {
      // A8: the with_tech stage.
      s.withTech = !(m.RMA_TRANSITIONS && m.RMA_TRANSITIONS.with_tech);
      var base = { stage: 'received', serial: 'X1234', vendor_id: 1, fee_status: 'paid' };
      try {
        // A12: a vendor document (warranty-check screenshot) counts as the invoice.
        s.vendorDoc = m.rmaGateProblems(Object.assign({}, base, { kind: 'gpu', purchase_source: 'elsewhere' }),
                                        'ready_to_ship', ['serial_label', 'vendor_doc']).length > 0;
        // A11: a drive cannot ship until we say what happened to its data.
        s.data = m.rmaGateProblems(Object.assign({}, base, { kind: 'ssd', purchase_source: 'neo_tokyo' }),
                                   'ready_to_ship', ['serial_label']).length === 0;
      } catch (e) { /* leave the bridges off */ }
    }
    shimCache = s;
    return s;
  }
  var DATA_GATE_MSG = 'Say what happened to the data on the drive — wiped, customer agreed, or unreadable.';

  // ── access ─────────────────────────────────────────────────────────────────
  var RANK = { desk: 1, tech: 2, lead: 3 };
  function roleOf(mod) {
    var d = data();
    try { return (d && typeof d.role === 'function') ? d.role(mod) : null; } catch (e) { return null; }
  }
  function rank() { return RANK[roleOf('rma')] || 0; }
  function canDesk() { return rank() >= 1; }
  function canTech() { return rank() >= 2; }
  function isLead() { return rank() >= 3; }
  function canService() { return !!roleOf('service'); }
  function me() {
    var d = data();
    try { if (d && typeof d.me === 'function' && d.me()) return d.me(); } catch (e) { /* fall through */ }
    return (typeof currentProfile !== 'undefined' && currentProfile) || null;
  }
  function isDemo() {
    var d = data();
    try { return !!(d && typeof d.isDemo === 'function' && d.isDemo()); } catch (e) { return false; }
  }

  // ── reading the caches ─────────────────────────────────────────────────────
  function allUnits() {
    var d = data();
    try { return (d && typeof d.units === 'function' && d.units()) || []; } catch (e) { return []; }
  }
  function unitById(id) {
    if (!id) return null;
    var d = data();
    try { if (d && typeof d.unit === 'function') return d.unit(id) || null; } catch (e) { /* none */ }
    return null;
  }
  function intakeOf(u) {
    var d = data();
    if (!u || !u.intake_id || !d || typeof d.intake !== 'function') return null;
    try { return d.intake(u.intake_id) || null; } catch (e) { return null; }
  }
  function allVendors() {
    var d = data();
    try { return (d && typeof d.vendors === 'function' && d.vendors()) || []; } catch (e) { return []; }
  }
  function vendorById(id) {
    if (id == null || id === '') return null;
    var d = data();
    try { if (d && typeof d.vendor === 'function') return d.vendor(id) || null; } catch (e) { /* none */ }
    return null;
  }
  function vendorOf(u) { return u ? vendorById(u.vendor_id) : null; }
  function vendorName(v) { return v ? (v.name || v.public_name || 'Vendor') : ''; }
  function jobOf(u) {
    var d = data();
    if (!u || !u.service_job_id || !d || typeof d.job !== 'function') return null;
    try { return d.job(u.service_job_id) || null; } catch (e) { return null; }
  }
  function jobById(id) {
    var d = data();
    if (!id || !d || typeof d.job !== 'function') return null;
    try { return d.job(id) || null; } catch (e) { return null; }
  }
  function unitsOfJob(jobId) {
    var d = data();
    try { if (d && typeof d.unitsOfJob === 'function') return d.unitsOfJob(jobId) || []; } catch (e) { /* scan below */ }
    return allUnits().filter(function (u) { return u.service_job_id === jobId; });
  }
  // `source` lives on the intake (one per arrival), not on the part.
  function sourceOf(u) {
    var it = intakeOf(u);
    return (it && it.source) || (u && u.source) || (u && u.service_job_id ? 'from_ticket' : '');
  }
  // Tracking updates go to the end customer when we know who that is, else to
  // whoever sent the part. Same rule as get_rma_public's last-4 check.
  function trackingPhone(u) {
    var it = intakeOf(u);
    return (u && u.owner_phone) || (it && it.sender_phone) || '';
  }
  function brandModel(u) {
    var s = [u && u.brand, u && u.model].filter(function (x) { return x && String(x).trim(); }).join(' ');
    return s || kindLabel(u && u.kind);
  }
  // SPEC-AMENDMENTS A13: what the customer is told they are waiting on is the
  // part's brand, else the vendor's public name — never a distributor's name.
  function customerFacingVendor(u, v) {
    return (u && u.brand && String(u.brand).trim()) || (v && (v.public_name || v.name)) || '';
  }
  function augment(u) {
    var v = vendorOf(u);
    return Object.assign({}, u, { waiting_party: customerFacingVendor(u, v) || u.waiting_party || null });
  }
  // The unit as a WhatsApp template should see it: greeted by name of whoever
  // actually receives the message (the owner only when it goes to the owner).
  function msgUnit(u) {
    var it = intakeOf(u) || {};
    return Object.assign({}, u, {
      sender_name: it.sender_name || u.sender_name || '',
      owner_name: u.owner_phone ? u.owner_name : null
    });
  }
  function safeRisk(u, now, v) {
    try { return model().rmaRisk(u, now, v || vendorOf(u)) || 0; } catch (e) { return 0; }
  }

  // ── media roles (for the shipping gate) ────────────────────────────────────
  // The gate needs to know which kinds of photo a part has. Media is not in
  // the realtime caches, so roles are fetched per part, kept two minutes, and
  // dropped the moment this machine uploads or deletes. The server re-checks
  // every gate anyway.
  //
  // The server's gate (_rma_gate_problems) counts a serial-label, invoice or
  // vendor-document photo taken for the part OR for its ticket item
  // (service_media.service_item_id = the part's service_item_id — usually the
  // label photographed at the counter). NeoQcData.media({ caseId }) returns
  // both (the item's rows marked from_item), so the roles here are the same
  // set the server looks at, and the screen never asks for a photo the system
  // already has.
  var ROLES_TTL = 120000;
  var rolesCache = {};      // caseId -> { roles: [...] | null, at, err, skip, partial }
  var rolesInflight = {};   // caseId -> Promise

  function mediaRole(r) {
    if (!r) return 'other';
    if (r.display_role) return r.display_role;
    if (r.role) return r.role;
    return (!r.phase || r.phase === 'intake') ? 'condition' : r.phase;
  }
  function normMedia(res) { return Array.isArray(res) ? res : ((res && (res.rows || res.data)) || []); }
  // The query for one part's photos, its ticket item's included. The item is
  // named explicitly so it is found even for a part the caches dropped.
  function mediaQuery(id) {
    var q = { caseId: id };
    var u = unitById(id);
    if (u && u.service_item_id != null && u.service_item_id !== '') q.itemId = u.service_item_id;
    return q;
  }
  // A part linked to a ticket item, seen by someone without service access:
  // the item's own photos are not readable for them (service_media RLS), but
  // the server still counts them. What they see is then only part of what the
  // gate looks at, so a "missing" photo is not known to be missing — the
  // photo checks are left to the server (null = "not loaded" to the model),
  // as for roles that could not be read at all.
  function rolesFor(id) {
    var c = rolesCache[id];
    return (c && c.roles && !c.partial) ? c.roles : null;
  }
  function rolesPartial(id) { var c = rolesCache[id]; return !!(c && c.partial && c.roles); }
  function rolesSeen(id) { var c = rolesCache[id]; return (c && c.roles) || []; }
  // Known = there is an answer the gates can use: the roles, or "skip the
  // photo checks" (demo, below). Not known = still to be read, or unreadable.
  function rolesKnown(id) { var c = rolesCache[id]; return !!(c && (c.roles || c.skip)); }
  function rolesStale(id) { var c = rolesCache[id]; return !c || (Date.now() - c.at > ROLES_TTL); }
  function rolesErr(id) { var c = rolesCache[id]; return (c && c.err) || null; }
  // Demo parts may have no photo rows behind them (demo is read-only, so none
  // can be added), so an empty list there means "unknown", not "no photos".
  // Roles stay null — the gates then leave the photo checks out, as they do
  // for roles that could not be read — but the part counts as checked, so
  // nothing waits on it.
  function setRolesFromRows(id, rows) {
    if (!rows.length && isDemo()) { rolesCache[id] = { roles: null, at: Date.now(), err: null, skip: true }; return; }
    var u = unitById(id);
    var partial = !!(u && u.service_item_id != null && u.service_item_id !== '' && !canService());
    rolesCache[id] = { roles: rows.map(mediaRole), at: Date.now(), err: null, partial: partial };
  }
  function forgetRoles(id) { delete rolesCache[id]; }
  function loadRoles(id) {
    if (rolesInflight[id]) return rolesInflight[id];
    var d = data();
    if (!d || typeof d.media !== 'function') return Promise.resolve(null);
    // A sign-out (or a demo switch) between the ask and the answer makes the
    // answer belong to the previous session: ops-data then hands back an
    // empty list marked `superseded`. Storing that as "no photos" would show
    // the next person a false "Add a photo of the serial label" for two
    // minutes, so a stale answer is dropped and the part asks again later.
    var g = sessionGen;
    var p = Promise.resolve()
      .then(function () { return d.media(mediaQuery(id)); })
      .then(function (res) {
        if (isStale(g) || (res && res.superseded)) return null;
        setRolesFromRows(id, normMedia(res));
        return rolesCache[id].roles;
      }, function (e) {
        if (isStale(g)) return null;
        var prev = rolesCache[id];
        rolesCache[id] = { roles: (prev && prev.roles) || null, at: Date.now(), err: errMsg(e),
                           skip: !!(prev && prev.skip), partial: !!(prev && prev.partial) };
        return rolesCache[id].roles;
      })
      .then(function (r) { if (rolesInflight[id] === p) delete rolesInflight[id]; return r; });
    rolesInflight[id] = p;
    return p;
  }
  // Four at a time: the ship view can hold a few dozen parts and each check
  // also signs URLs, so a burst of forty parallel requests helps nobody.
  function loadRolesMany(ids, done) {
    var queue = ids.slice(), running = 0, finished = false;
    function next() {
      if (!queue.length && running === 0) {
        if (!finished) { finished = true; done(); }
        return;
      }
      while (running < 4 && queue.length) {
        running++;
        loadRoles(queue.shift()).then(function () { running--; next(); });
      }
    }
    next();
  }

  // Every gate check in this file goes through here. `roles` null means "not
  // loaded": the model then skips the photo checks rather than claim a photo
  // is missing (the server still catches it).
  function gateCheck(u, to, roles) {
    var m = model();
    if (!m || typeof m.rmaGateProblems !== 'function' || !u) return [];
    var s = shims();
    var probe = u;
    if (u.stage === 'with_tech' && s.withTech) {
      // A8 bridge: with_tech → received / ready_to_ship / closed(withdrawn),
      // with the same gates as received → ready_to_ship and logged → closed.
      if (to === 'received') return [];
      if (to !== 'ready_to_ship' && to !== 'closed') return ['A part with our technician can be received, sent straight to the vendor, or withdrawn.'];
      probe = Object.assign({}, u, { stage: to === 'closed' ? 'logged' : 'received' });
    }
    var r = roles;
    if (r && s.vendorDoc && r.indexOf('vendor_doc') !== -1 && r.indexOf('invoice') === -1) r = r.concat(['invoice']);
    var out = [];
    try {
      var p = m.rmaGateProblems(probe, to, r);
      out = Array.isArray(p) ? p.slice() : [];
    } catch (e) { out = []; }
    if ((to === 'ready_to_ship' || to === 'with_vendor') && s.data && isDrive(u.kind) && !u.data_handling) out.push(DATA_GATE_MSG);
    return out;
  }

  function nextStages(u) {
    var list = [];
    try { list = model().rmaNextStages(u) || []; } catch (e) { list = []; }
    if (!list.length && u && u.stage === 'with_tech' && shims().withTech) list = ['received', 'ready_to_ship', 'closed'];
    return list.filter(function (s) { return s !== 'with_vendor' && s !== 'back_from_vendor'; });
  }

  // ── chips (NeoQcUI's: one group per wrapper, scoped reads per card) ───────
  function chipsHtml(group, options, selected, opts) {
    return ui().chips(group, options, selected, opts || {});
  }
  function readChip(scope, group) { return scope ? ui().readChips(scope, group) : null; }
  function setChip(scope, group, value) { if (scope) ui().setChips(scope, group, value); }
  function chipWrapOf(scope, group) {
    if (!scope) return null;
    var all = scope.querySelectorAll('[data-chip-wrap]');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-chip-wrap') === group) return all[i];
    return null;
  }

  // ── form helpers (dialogs and the intake read values by data-f, no ids) ───
  function dfield(label, key, value, opts) {
    opts = opts || {};
    var cls = 'sv-field' + (opts.wide ? ' sv-span2' : '') + (opts.cls ? ' ' + opts.cls : '');
    var wrap = opts.wrapAttrs || '';            // constant markup only
    var attrs = ' data-f="' + esc(key) + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + (opts.attrs || '');
    if (opts.textarea) {
      return '<label class="' + cls + '"' + wrap + '><span>' + esc(label) + '</span><textarea rows="' + (opts.rows || 2) + '"' + attrs + '>' +
             esc(value || '') + '</textarea></label>';
    }
    return '<label class="' + cls + '"' + wrap + '><span>' + esc(label) + '</span><input type="' + (opts.type || 'text') + '" value="' +
           esc(value == null ? '' : value) + '"' + attrs + ' autocomplete="off" spellcheck="false"></label>';
  }
  function fval(scope, key) {
    var e = scope ? scope.querySelector('[data-f="' + key + '"]') : null;
    return e ? String(e.value || '').trim() : '';
  }
  function fel(scope, key) { return scope ? scope.querySelector('[data-f="' + key + '"]') : null; }
  function dlgBody(html) {
    var div = document.createElement('div');
    div.className = 'rma-dlg';
    div.innerHTML = html;
    return div;
  }
  function openDialog(opts) {
    var u = ui();
    if (!u || typeof u.dialog !== 'function') {
      toast('The dialog kit (ops-ui.js) is not loaded.', 'error');
      return Promise.resolve(false);
    }
    return u.dialog(opts);
  }
  // A status line under a form. `action` adds one button after the text
  // (built with textContent, so the sentence can carry any server wording).
  function statusIn(node, msg, kind, action) {
    if (!node) return;
    node.textContent = msg || '';
    node.classList.remove('ok', 'err');
    if (kind) node.classList.add(kind);
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rma-linkbtn';
      b.textContent = action.label;
      b.addEventListener('click', action.fn);
      node.appendChild(document.createTextNode(' '));
      node.appendChild(b);
    }
  }
  function setStatusId(id, msg, kind, action) { statusIn(el(id), msg, kind, action); }
  function show(node, on) { if (node) node.classList.toggle('hidden', !on); }
  function photoCount(tray) {
    if (!tray) return 0;
    try { return tray.count() || 0; } catch (e) { return 0; }
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  // The catalog owns the wording. The fallback only exists so a missing
  // catalog never strands the desk with a customer waiting for an update.
  function waText(name, unit, vendorLabel) {
    var c = catalog();
    var t = c && c.WA_TEMPLATES && c.WA_TEMPLATES[name];
    if (typeof t === 'function') {
      try { var s = t(unit, vendorLabel); if (s) return String(s); } catch (e) { /* fallback below */ }
    }
    var code = (unit && unit.public_code) || '';
    var what = brandModel(unit || {});
    var line = {
      rma_received: 'Neo Tokyo: we have your ' + what + ' for the warranty claim.',
      rma_sent: 'Neo Tokyo: your ' + what + ' has been sent to ' + (vendorLabel || 'the manufacturer') + ' under warranty.',
      rma_back: 'Neo Tokyo: your ' + what + ' is back from the manufacturer. We will update you shortly.',
      rma_ready: 'Neo Tokyo: your ' + what + ' is ready.'
    }[name] || ('Neo Tokyo: an update on your ' + what + '.');
    return line + '\nCode: ' + code + '\nTrack it here: ' + TRACK_URL + encodeURIComponent(code) +
           '\nUse the last 4 digits of this phone number to open it.';
  }
  function waSend(phone, text) {
    var u = ui();
    if (!u || typeof u.waOpen !== 'function') { toast('WhatsApp is not available here.', 'error'); return false; }
    if (u.waOpen(phone, text) === false) { toast('There is no valid mobile number for this part.', 'warning'); return false; }
    return true;
  }
  function templateForStage(stage) {
    if (stage === 'with_vendor') return 'rma_sent';
    if (stage === 'back_from_vendor' || stage === 'customer_decision') return 'rma_back';
    if (stage === 'ready_to_return' || stage === 'returning' || stage === 'closed') return 'rma_ready';
    return 'rma_received';
  }

  // ── "this serial is in one of our builds" (SPEC-AMENDMENTS A20) ───────────
  // A quiet suggestion, never a step: a failed lookup says nothing.
  function warrantyText(b) {
    var c = catalog();
    var months = (c && Number(c.OUR_WARRANTY_MONTHS)) || 6;
    var base = ms(b && (b.handed_over_at || b.completed_at));
    if (base == null) return '';
    var d = new Date(base);
    d.setMonth(d.getMonth() + months);
    return d.getTime() >= Date.now() ? 'In our warranty until ' + fmtDate(d.toISOString())
                                     : 'Our warranty ended ' + fmtDate(d.toISOString());
  }
  async function findSerialBuild(serial) {
    var d = data();
    var q = String(serial || '').trim();
    if (!d || typeof d.findBuilds !== 'function' || q.replace(/[^A-Za-z0-9]/g, '').length < 5) return null;
    try {
      var rows = await d.findBuilds(q);
      return (rows || []).filter(function (r) { return r && r.match === 'serial' && r.id; })[0] || null;
    } catch (e) { return null; }
  }
  function buildHintHtml(b) {
    var when = ms(b.completed_at || b.created_at);
    var monthYear = when == null ? '' : new Date(when).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    var who = [b.customer_name, monthYear].filter(Boolean).join(', ');
    var w = warrantyText(b);
    return '<div class="rma-build-hint">This serial is in build #' + esc(b.code || String(b.id).slice(-6).toUpperCase()) +
      (who ? ' (' + esc(who) + ')' : '') + ' — link it?' +
      (w ? ' <span class="rma-pill">' + esc(w) + '</span>' : '') +
      ' <button type="button" class="rma-linkbtn" data-link-build="' + esc(b.id) + '" data-build-code="' + esc(b.code || '') + '">Link it</button></div>';
  }

  // ── printing labels ────────────────────────────────────────────────────────
  // main.js 'sys:print' prints the WHOLE main window through the native dialog
  // (greyscale, A4). Child windows are denied, so there is no popup to print.
  // Instead: fill a print-only sheet, flag the body, and let rma.css hide the
  // rest of the app under @media print. The flag only matters to print, so it
  // costs nothing on screen — but it must be off before anyone prints a QC
  // report, so it is cleared on afterprint, on the next real interaction, and
  // on any beforeprint this module did not start.
  var printArmed = false, printArmedAt = 0;
  function printer() {
    try {
      if (typeof require !== 'function') return null;
      var e = require('electron');
      return (e && e.ipcRenderer && typeof e.ipcRenderer.invoke === 'function') ? e.ipcRenderer : null;
    } catch (x) { return null; }
  }
  function canPrint() { return !!printer(); }
  function printSheet() {
    var s = el('rma-print-sheet');
    if (!s) {
      s = document.createElement('div');
      s.id = 'rma-print-sheet';
      s.className = 'rma-print-sheet';
      s.setAttribute('aria-hidden', 'true');
      document.body.appendChild(s);
    }
    return s;
  }
  function labelHtml(x) {
    return '<div class="rma-label">' +
      '<div class="rma-label-brand">NEO TOKYO · RMA</div>' +
      '<div class="rma-label-code">' + esc(x.public_code || '') + '</div>' +
      '<div class="rma-label-kind">' + esc(kindLabel(x.kind)) + '</div>' +
      '<div class="rma-label-item">' + esc([x.brand, x.model].filter(Boolean).join(' ') || '—') + '</div>' +
      (x.sender_name ? '<div class="rma-label-row"><span>From</span> ' + esc(x.sender_name) + '</div>' : '') +
      (x.owner_name ? '<div class="rma-label-row"><span>For</span> ' + esc(x.owner_name) + '</div>' : '') +
      '<div class="rma-label-row"><span>Logged</span> ' + esc(fmtDate(x.created_at || new Date().toISOString())) + '</div>' +
    '</div>';
  }
  function endPrint() {
    printArmed = false;
    document.body.classList.remove('rma-printing');
  }
  function printLabels(list) {
    var ipc = printer();
    if (!ipc) { toast('Printing is not available on this machine.', 'warning'); return; }
    if (!list || !list.length) return;
    printSheet().innerHTML = '<div class="rma-labels">' + list.map(labelHtml).join('') + '</div>';
    document.body.classList.add('rma-printing');
    printArmed = true;
    printArmedAt = Date.now();
    Promise.resolve()
      .then(function () { return ipc.invoke('sys:print'); })
      .then(function (r) {
        if (r && r.success === false) { endPrint(); toast('Could not open the print dialog.', 'error'); }
      }, function (e) {
        endPrint();
        toast('Could not print: ' + errMsg(e), 'error');
      });
  }
  function labelFromUnit(u) {
    var it = intakeOf(u);
    return { public_code: u.public_code, kind: u.kind, brand: u.brand, model: u.model,
             sender_name: it && it.sender_name, owner_name: u.owner_name, created_at: u.created_at };
  }
  function initPrintGuards() {
    window.addEventListener('afterprint', endPrint);
    window.addEventListener('beforeprint', function () { if (!printArmed) document.body.classList.remove('rma-printing'); });
    var settle = function () { if (printArmed && Date.now() - printArmedAt > 1500) endPrint(); };
    document.addEventListener('pointerdown', settle, true);
    document.addEventListener('keydown', settle, true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  THE SCREEN — toolbar, KPIs, and three views
  // ══════════════════════════════════════════════════════════════════════════
  var view = 'board';             // board | ship | vendors
  var sourceFilter = 'all';
  var searchQ = '';
  var shipSel = {};               // caseId -> true, survives repaints
  var SOURCE_FILTERS = [
    ['all', 'All'], ['from_ticket', 'From tickets'], ['walk_in', 'Walk-in'], ['courier', 'Courier'], ['stock', 'Stock']
  ];

  function screenActive() { var s = el('rma-screen'); return !!(s && s.classList.contains('active')); }

  // SPEC-GAP: the five chips do not name every source. A part our technician
  // pulled on site ('field') belongs to a ticket, so it sits under "From
  // tickets"; a request logged on the website shows under "All" only.
  function matchSource(u, src) {
    if (src === 'all') return true;
    var s = sourceOf(u);
    if (src === 'from_ticket') return s === 'from_ticket' || s === 'field';
    return s === src;
  }
  function matchQuery(u, q) {
    if (!q) return true;
    var it = intakeOf(u) || {};
    var v = vendorOf(u);
    var job = jobOf(u);
    var hay = [u.public_code, u.owner_name, it.sender_name, u.brand, u.model, u.serial, u.replacement_serial,
               u.vendor_rma_no, it.inbound_awb, u.return_awb, v && v.name, v && v.public_name,
               job && job.public_code, kindLabel(u.kind)]
      .filter(Boolean).join(' ').toLowerCase();
    if (hay.indexOf(q) !== -1) return true;
    // A serial read off a label rarely matches character for character —
    // compare with spaces and dashes stripped, as serial_norm does (A15: the
    // replacement serial too).
    var qn = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (qn.length >= 4) {
      var sers = [u.serial_norm || u.serial, u.replacement_serial_norm || u.replacement_serial];
      if (sers.some(function (s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').indexOf(qn) !== -1; })) return true;
    }
    var qd = q.replace(/\D/g, '');
    if (qd.length >= 4 && qd.length === q.replace(/[\s+\-()]/g, '').length) {
      var phones = [u.owner_phone, it.sender_phone].map(function (p) { return String(p || '').replace(/\D/g, ''); });
      if (phones.some(function (p) { return p && p.indexOf(qd) !== -1; })) return true;
    }
    return false;
  }

  function renderToolbar() {
    var host = el('rma-toolbar');
    if (!host) return;
    if (!host.querySelector('.rma-tb')) {
      // Built ONCE. The search box lives here, and a repaint would take the
      // cursor out of it mid-word.
      host.innerHTML = '<div class="rma-tb">' +
        '<div class="rma-seg" role="group" aria-label="View">' +
          '<button type="button" class="rma-seg-btn" data-view="board" aria-pressed="false">Board</button>' +
          '<button type="button" class="rma-seg-btn" data-view="ship" aria-pressed="false">Ship to vendor <span class="rma-seg-n" id="rma-ship-n"></span></button>' +
          '<button type="button" class="rma-seg-btn" data-view="vendors" aria-pressed="false">Vendors</button>' +
        '</div>' +
        '<div class="rma-srcs" role="group" aria-label="Where the parts came from">' +
          SOURCE_FILTERS.map(function (s) {
            return '<button type="button" class="rma-src-chip" data-src="' + s[0] + '" aria-pressed="false">' + esc(s[1]) + '</button>';
          }).join('') +
        '</div>' +
        '<input type="text" id="rma-search" class="sv-search rma-search" placeholder="Code, customer, brand, model, serial, AWB…" autocomplete="off" spellcheck="false" aria-label="Search RMA parts">' +
        '<button type="button" id="rma-arrive" class="secondary-btn rma-tb-btn">Log courier arrival</button>' +
        '<button type="button" id="rma-new" class="primary-pink-btn rma-tb-btn">+ New RMA</button>' +
      '</div>';
    }
    Array.prototype.forEach.call(host.querySelectorAll('.rma-seg-btn'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
    Array.prototype.forEach.call(host.querySelectorAll('.rma-src-chip'), function (b) {
      var on = b.getAttribute('data-src') === sourceFilter;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
    var w = canDesk();
    show(el('rma-new'), w);
    show(el('rma-arrive'), w);
  }

  function render() {
    renderToolbar();
    renderView();
  }

  function renderView() {
    var root = el('rma-root');
    if (!root) return;
    var miss = missingPiece();
    if (miss) { root.innerHTML = '<div class="rma-error">' + esc(miss) + '</div>'; return; }
    var now = Date.now();
    var units = allUnits();
    var scoped = units.filter(function (u) { return matchSource(u, sourceFilter); });
    var shown = scoped.filter(function (u) { return matchQuery(u, searchQ); });

    var html = isDemo() ? ui().demoBanner() : '';
    var probs = loadProblems();
    if (probs.length) {
      html += '<div class="rma-loadfail">' + ui().banner(probs.join(' '), 'error') +
        '<button type="button" class="secondary-btn rma-small" data-act="retry-load">Try again</button></div>';
    }
    if (view === 'ship') html += shipHtml(shown);
    else if (view === 'vendors') html += vendorsHtml(units);
    else html += kpisHtml(scoped, now) + boardHtml(shown, now);
    root.innerHTML = html;

    updateStat(units, now);
    var n = el('rma-ship-n');
    if (n) {
      var c = units.filter(function (u) { return u.stage === 'ready_to_ship'; }).length;
      n.textContent = c ? String(c) : '';
    }
    if (view === 'ship') kickRoleChecks(shown);
  }

  // What the data layer could not load that this screen depends on. Ticket
  // and access errors are left to their own screens: an RMA-only desk cannot
  // read tickets, and saying so on every repaint would only be noise.
  var loadNote = '';
  var LOAD_KINDS = ['connection', 'load', 'demo', 'units', 'intakes', 'vendors'];
  function loadProblems() {
    var d = data();
    var errs = {};
    try { errs = (d && typeof d.errors === 'function' && d.errors()) || {}; } catch (e) { errs = {}; }
    var out = LOAD_KINDS.filter(function (k) { return !!errs[k]; }).map(function (k) { return String(errs[k]); });
    if (!out.length && loadNote) out.push(loadNote);
    return out;
  }

  function updateStat(units, now) {
    var stat = el('rma-stat');
    if (!stat) return;
    var open = units.filter(function (u) { return u.stage !== 'closed'; });
    var late = open.filter(function (u) { return safeRisk(u, now) === 2; }).length;
    stat.textContent = open.length + ' open · ' + late + ' late';
    stat.classList.toggle('has-breach', late > 0);
  }

  // ── KPIs ──
  // SPEC-GAP: the tiles follow the source chips (they answer "how is the
  // courier side doing" when Courier is picked) but ignore the search box,
  // which is for finding one part, not for counting.
  function kpisHtml(units, now) {
    var mid = midnight();
    var k = { test: 0, cust: 0, ship: 0, vendor: 0, vendorLate: 0, fees: 0, feeSum: 0, closed: 0 };
    units.forEach(function (u) {
      var s = u.stage;
      if (s === 'received' || s === 'testing') k.test++;
      if (s === 'awaiting_docs' || s === 'customer_decision' || (s === 'ready_to_return' && (u.return_method || 'collect') === 'collect')) k.cust++;
      if (s === 'ready_to_ship') k.ship++;
      if (s === 'with_vendor') {
        k.vendor++;
        var exp = ms(u.expected_back_at);
        if (exp != null && exp <= now) k.vendorLate++;
      }
      if (u.fee_status === 'accepted') { k.fees++; k.feeSum += Number(u.handling_fee) || 0; }
      if (s === 'closed' && (ms(u.closed_at) || 0) >= mid) k.closed++;
    });
    return ui().kpis([
      { key: 'test', n: k.test, label: 'To test', tone: 'shop' },
      { key: 'cust', n: k.cust, label: 'Waiting on customer', tone: 'customer' },
      { key: 'ship', n: k.ship, label: 'Ready to ship', tone: 'queue' },
      { key: 'vendor', n: k.vendor, label: 'At vendors', tone: k.vendorLate ? 'late' : 'vendor',
        sub: k.vendorLate ? k.vendorLate + ' late' : '', title: 'Parts with a manufacturer; late = past the expected-back date' },
      { key: 'fees', n: k.fees, label: 'Fees to collect', tone: 'customer', sub: k.fees ? fmtINR(k.feeSum) : '',
        title: 'Handling fees the customer accepted but has not paid yet' },
      { key: 'closed', n: k.closed, label: 'Closed today', tone: 'ready' }
    ], { static: true, className: 'rma-kpis' });
  }

  // ── board ──
  function boardHtml(units, now) {
    var m = model();
    var cols = (m.RMA_COLUMNS && m.RMA_COLUMNS.length) ? m.RMA_COLUMNS : [
      { key: 'intake', label: 'Just in', hint: '' }, { key: 'shop', label: 'On us', hint: '' },
      { key: 'customer', label: 'On the customer', hint: '' }, { key: 'third', label: 'On a third party', hint: '' },
      { key: 'closed', label: 'Closed today', hint: '' }
    ];
    var mid = midnight();
    var buckets = {};
    cols.forEach(function (c) { buckets[c.key] = []; });
    units.forEach(function (u) {
      var col;
      try { col = m.rmaColumnOf(u); } catch (e) { col = 'shop'; }
      // "Closed today" empties overnight, the same feedback loop as service.
      if (col === 'closed' || u.stage === 'closed') {
        if (!((ms(u.closed_at) || 0) >= mid)) return;
        if (buckets.closed) col = 'closed';
      }
      (buckets[col] || buckets.shop || buckets[cols[0].key]).push(u);
    });
    var risks = {};
    units.forEach(function (u) { risks[u.id] = safeRisk(u, now); });
    Object.keys(buckets).forEach(function (k) {
      if (k === 'closed') {
        buckets[k].sort(function (a, b) { return (ms(b.closed_at) || 0) - (ms(a.closed_at) || 0); });
      } else {
        // Most at risk first, then the one that has sat longest.
        buckets[k].sort(function (a, b) {
          var r = (risks[b.id] || 0) - (risks[a.id] || 0);
          return r || ((ms(a.stage_since) || 0) - (ms(b.stage_since) || 0));
        });
      }
    });
    return '<div class="sv-board rma-board">' + cols.map(function (c) {
      var list = buckets[c.key] || [];
      var breached = list.filter(function (u) { return risks[u.id] === 2; }).length;
      return '<div class="sv-col sv-col-' + esc(c.key) + ' rma-col">' +
        '<div class="sv-col-head"><span class="sv-col-name">' + esc(c.label) + '</span>' +
          '<span class="sv-col-count' + (breached ? ' has-breach' : '') + '">' + list.length + '</span></div>' +
        (c.hint ? '<div class="sv-col-hint">' + esc(c.hint) + '</div>' : '') +
        '<div class="sv-cards">' +
          (list.length ? list.map(function (u) { return cardHtml(u, now, risks[u.id] || 0); }).join('')
                       : '<div class="sv-empty">Nothing here</div>') +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function vendorDaysLine(u, v, now) {
    var tat = Number(v && v.typical_tat_days) || 14;
    var days = model().daysInStage(u, now);
    var exp = ms(u.expected_back_at);
    var late = exp != null ? exp <= now : days > tat;
    return esc(vendorName(v)) + ' · ' + esc(fmtDays(days)) + ' of ' + tat + 'd' + (late ? ' ' + lateTag() : '');
  }

  function feeChip(u) {
    var st = u.fee_status || 'n_a';
    if (st === 'n_a') return '';
    var amt = u.handling_fee != null ? fmtINR(u.handling_fee) : '';
    var txt = st === 'quoted' ? 'Fee ' + amt + ' · quoted'
            : st === 'accepted' ? 'Fee ' + amt + ' · to collect'
            : st === 'paid' ? 'Fee paid' : 'Fee waived';
    return '<span class="rma-pill rma-fee-' + esc(st) + '">' + esc(txt) + '</span>';
  }

  function ticketChip(u) {
    if (!u.service_job_id) return '';
    var job = jobOf(u);
    return '<span class="rma-pill rma-pill-ticket" title="Linked service ticket">' +
      esc(job && job.public_code ? job.public_code : 'Ticket') +
      (u.holds_ticket && u.stage !== 'closed' ? ' · <strong>holds ticket</strong>' : '') + '</span>';
  }

  function senderLine(u) {
    var it = intakeOf(u);
    var parts = [sourceLabel(sourceOf(u))];
    if (it && it.sender_name) parts.push(it.sender_name);
    return parts.join(' · ');
  }

  function cardHtml(u, now, risk) {
    var v = vendorOf(u);
    var idle = model().daysInStage(u, now);
    var lines = '';
    if (u.owner_name) lines += '<div class="rma-card-line"><span class="sv-k">For</span> ' + esc(u.owner_name) + '</div>';
    if (u.stage === 'with_vendor' && v) lines += '<div class="rma-card-line">' + vendorDaysLine(u, v, now) + '</div>';
    else if (v && u.stage !== 'closed') lines += '<div class="rma-card-line"><span class="sv-k">Vendor</span> ' + esc(vendorName(v)) + '</div>';
    var chips = ticketChip(u) + feeChip(u);
    var label = (u.public_code || '') + ' ' + kindLabel(u.kind) + ' ' + brandModel(u);
    return '<div class="rma-card' + riskClass(risk) + '" role="button" tabindex="0" data-unit="' + esc(u.id) + '" aria-label="' + esc(label) + '">' +
      '<div class="rma-card-top">' +
        '<span class="rma-kind" title="' + esc(kindLabel(u.kind)) + '">' + kindIcon(u.kind) + '</span>' +
        '<span class="rma-card-name">' + esc(brandModel(u)) + '</span>' +
        '<span class="rma-idle" title="Time in the current stage">' + esc(fmtDays(idle)) + '</span>' +
      '</div>' +
      '<div class="rma-card-who">' + esc(senderLine(u)) + '</div>' +
      '<div class="rma-card-stage">' + esc(staffStage(u.stage)) + (risk === 2 ? ' ' + lateTag() : '') + '</div>' +
      lines +
      (chips ? '<div class="rma-card-chips">' + chips + '</div>' : '') +
      '<div class="rma-card-foot"><span class="sv-code">' + esc(u.public_code || '') + '</span>' +
        '<span class="rma-handler">' + esc(u.handler_name || 'No handler') + '</span></div>' +
    '</div>';
  }

  // ── ship to vendor ──
  function shipProblems(u) {
    if (!rolesKnown(u.id)) return null;           // not checked yet
    return gateCheck(augment(u), 'ready_to_ship', rolesFor(u.id));
  }
  function kickRoleChecks(units) {
    var need = units.filter(function (u) {
      return u.stage === 'ready_to_ship' && rolesStale(u.id) && !rolesInflight[u.id];
    }).map(function (u) { return u.id; });
    if (!need.length) return;
    loadRolesMany(need, function () { if (view === 'ship' && screenActive()) renderView(); });
  }
  function vendorOptions(selectedId, placeholder) {
    var list = allVendors().filter(function (v) { return v.active !== false || String(v.id) === String(selectedId); })
      .slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    return '<option value="">' + esc(placeholder || 'Choose a vendor…') + '</option>' + list.map(function (v) {
      return '<option value="' + esc(v.id) + '"' + (String(v.id) === String(selectedId) ? ' selected' : '') + '>' +
             esc(v.name || v.public_name) + (v.active === false ? ' (inactive)' : '') + '</option>';
    }).join('');
  }

  function shipHtml(units) {
    var ready = units.filter(function (u) { return u.stage === 'ready_to_ship'; })
      .sort(function (a, b) { return (ms(a.stage_since) || 0) - (ms(b.stage_since) || 0); });
    // Forget ticks for parts that have left this list (dispatched, moved back).
    var live = {};
    ready.forEach(function (u) { live[u.id] = 1; });
    Object.keys(shipSel).forEach(function (id) { if (!live[id]) delete shipSel[id]; });

    var head = '<div class="rma-ship-head">' +
      '<p class="sv-lead">Parts ready to go to a manufacturer, grouped by vendor. Tick the ones going in the same parcel and dispatch them together — each part keeps its own tracking.</p>' +
      '<button type="button" class="secondary-btn rma-small" data-act="recheck">Recheck photos</button>' +
    '</div>';
    if (!ready.length) return head + '<div class="rma-empty-big">Nothing is ready to ship.</div>';

    var groups = {}, order = [], none = [];
    ready.forEach(function (u) {
      if (u.vendor_id == null || u.vendor_id === '' || !vendorById(u.vendor_id)) { none.push(u); return; }
      var k = String(u.vendor_id);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(u);
    });
    order.sort(function (a, b) { return vendorName(vendorById(a)).localeCompare(vendorName(vendorById(b))); });

    var html = head;
    if (none.length) {
      html += '<section class="rma-ship-group is-novendor">' +
        '<div class="rma-ship-ghead"><h3>Choose a vendor</h3><span class="rma-ship-gsub">' + none.length + ' part' + (none.length === 1 ? '' : 's') + ' with no vendor yet</span></div>' +
        none.map(function (u) { return shipRowHtml(u, true); }).join('') +
      '</section>';
    }
    order.forEach(function (k) {
      var v = vendorById(k), list = groups[k];
      var picked = list.filter(function (u) { return shipSel[u.id] && shipEligible(u); }).length;
      var elig = list.filter(shipEligible).length;
      html += '<section class="rma-ship-group" data-vendor="' + esc(k) + '">' +
        '<div class="rma-ship-ghead">' +
          '<label class="rma-ship-all"><input type="checkbox" class="rma-ship-allcb" data-vendor="' + esc(k) + '"' +
            (elig && picked === elig ? ' checked' : '') + (elig ? '' : ' disabled') + '> <span class="rma-sr">Select every ready part for this vendor</span></label>' +
          '<h3>' + esc(vendorName(v)) + '</h3>' +
          '<span class="rma-ship-gsub">' + list.length + ' part' + (list.length === 1 ? '' : 's') + ' · usually ' + esc(String(v.typical_tat_days || 14)) + ' days</span>' +
          (canDesk() ? '<button type="button" class="primary-pink-btn rma-dispatch-btn" data-vendor="' + esc(k) + '"' + (picked ? '' : ' disabled') + '>' +
            (picked ? 'Dispatch selected (' + picked + ')…' : 'Dispatch selected…') + '</button>' : '') +
        '</div>' +
        list.map(function (u) { return shipRowHtml(u, false); }).join('') +
      '</section>';
    });
    return html;
  }

  function shipEligible(u) {
    var p = shipProblems(u);
    return !!p && !p.length;
  }

  function shipRowHtml(u, needsVendor) {
    var p = shipProblems(u);
    var err = rolesErr(u.id);
    var checking = p == null;
    var blocked = needsVendor || checking || (p && p.length > 0);
    var probs = '';
    if (checking) {
      probs = err ? '<div class="rma-gate-note">Could not check the photos: ' + esc(err) + ' <button type="button" class="rma-linkbtn" data-act="recheck-one" data-unit="' + esc(u.id) + '">Try again</button></div>'
                  : '<div class="rma-gate-note">Checking photos…</div>';
    } else if (p.length) {
      probs = '<ul class="rma-gate-list">' + p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    }
    return '<div class="rma-ship-row' + (blocked ? ' is-blocked' : '') + '">' +
      (needsVendor ? '<span class="rma-ship-pick"></span>' :
        '<label class="rma-ship-pick"><input type="checkbox" class="rma-ship-cb" data-unit="' + esc(u.id) + '"' +
          (shipSel[u.id] && !blocked ? ' checked' : '') + (blocked ? ' disabled' : '') + '>' +
          '<span class="rma-sr">Select ' + esc(u.public_code || '') + '</span></label>') +
      '<div class="rma-ship-main">' +
        '<div class="rma-ship-title"><span class="sv-code">' + esc(u.public_code || '') + '</span> · ' +
          esc(kindLabel(u.kind)) + ' · <strong>' + esc(brandModel(u)) + '</strong></div>' +
        '<div class="rma-ship-sub">' + esc('Serial ' + (u.serial || 'not recorded') + ' · ' + senderLine(u) +
          (u.owner_name ? ' · for ' + u.owner_name : '') + ' · ready since ' + fmtDate(u.stage_since)) + '</div>' +
        probs +
      '</div>' +
      '<div class="rma-ship-side">' +
        (needsVendor && canDesk() ? '<select class="settings-select rma-ship-vendor" data-unit="' + esc(u.id) + '" aria-label="Vendor for ' + esc(u.public_code || '') + '">' +
          vendorOptions(null, 'Choose a vendor…') + '</select>' : '') +
        '<button type="button" class="secondary-btn rma-open-btn" data-open-unit="' + esc(u.id) + '">Open</button>' +
      '</div>' +
    '</div>';
  }

  function refreshDispatchButton(vendorKey) {
    var root = el('rma-root');
    if (!root) return;
    var secs = root.querySelectorAll('.rma-ship-group[data-vendor]');
    var sec = null;
    for (var i = 0; i < secs.length; i++) if (secs[i].getAttribute('data-vendor') === String(vendorKey)) sec = secs[i];
    if (!sec) return;
    var list = allUnits().filter(function (u) { return u.stage === 'ready_to_ship' && String(u.vendor_id) === String(vendorKey); });
    var picked = list.filter(function (u) { return shipSel[u.id] && shipEligible(u); }).length;
    var btn = sec.querySelector('.rma-dispatch-btn');
    if (btn) {
      btn.disabled = !picked;
      btn.textContent = picked ? 'Dispatch selected (' + picked + ')…' : 'Dispatch selected…';
    }
    var all = sec.querySelector('.rma-ship-allcb');
    if (all) {
      var elig = list.filter(shipEligible).length;
      all.checked = !!elig && picked === elig;
    }
  }

  async function setShipVendor(unitId, select) {
    var vid = select.value;
    if (!vid) return;
    var u = unitById(unitId);
    if (!u) return;
    var g = sessionGen;
    select.disabled = true;
    var err = null;
    try {
      // The id goes through as it is: the data layer turns it into the bigint
      // the column wants (demo vendors have text ids).
      await data().updateRma(unitId, { vendor_id: vid });
    } catch (e) {
      err = e;
    }
    select.disabled = false;
    if (isStale(g)) return;
    if (err) {
      toast('Could not set the vendor: ' + failText(err), 'error');
      select.value = '';
    } else {
      toast('Vendor set for ' + (u.public_code || 'the part') + '.', 'success', 2500);
    }
    if (screenActive()) renderView();
  }

  // ── vendors ──
  // SPEC-GAP: "average days back" — the caches only hold parts closed in the
  // last two days and carry no "came back on" timestamp, so this averages
  // intake-to-closed for recently closed parts that went to that vendor. The
  // column's tooltip says so; "—" when there are none.
  function vendorsHtml(units) {
    var q = searchQ;
    var list = allVendors().slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); })
      .filter(function (v) { return !q || (String(v.name || '') + ' ' + String(v.public_name || '')).toLowerCase().indexOf(q) !== -1; });
    var stats = {};
    units.forEach(function (u) {
      if (u.vendor_id == null) return;
      var k = String(u.vendor_id);
      var s = stats[k] || (stats[k] = { open: 0, atVendor: 0, sum: 0, n: 0 });
      if (u.stage !== 'closed') s.open++;
      if (u.stage === 'with_vendor') s.atVendor++;
      if (u.stage === 'closed' && u.vendor_result) {
        var a = ms(u.created_at), b = ms(u.closed_at);
        if (a != null && b != null && b >= a) { s.sum += (b - a) / DAY; s.n++; }
      }
    });
    return '<div class="rma-vendors">' +
      '<div class="rma-vendors-head"><h3>Vendors</h3>' +
        (canDesk() ? '<button type="button" class="primary-pink-btn" data-act="add-vendor">+ Add vendor</button>' : '') +
      '</div>' +
      (list.length ? '<div class="rma-table-wrap"><table class="rma-table">' +
        '<thead><tr><th scope="col">Name</th><th scope="col">Name customers see</th><th scope="col">Kind</th>' +
          '<th scope="col" class="num">Usual days</th><th scope="col" class="num">Open parts</th>' +
          '<th scope="col" class="num" title="Average days from intake until closed, for parts closed in the last two days">Avg days back</th></tr></thead>' +
        '<tbody>' + list.map(function (v) {
          var s = stats[String(v.id)] || { open: 0, atVendor: 0, sum: 0, n: 0 };
          return '<tr' + (v.active === false ? ' class="is-inactive"' : '') + '>' +
            '<td>' + esc(v.name || '') + (v.active === false ? ' <span class="rma-muted">(inactive)</span>' : '') + '</td>' +
            '<td>' + esc(v.public_name || v.name || '') + '</td>' +
            '<td>' + esc(vendorKindLabel(v.kind)) + '</td>' +
            '<td class="num">' + esc(String(v.typical_tat_days || 14)) + '</td>' +
            '<td class="num">' + s.open + (s.atVendor ? ' <span class="rma-muted">(' + s.atVendor + ' with them)</span>' : '') + '</td>' +
            '<td class="num">' + (s.n ? esc((s.sum / s.n).toFixed(1)) : '—') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="rma-empty-big">' + (q ? 'No vendor matches that search.' : 'No vendors yet.') + '</div>') +
    '</div>';
  }

  // ── screen wiring ──
  function bindScreen() {
    var tb = el('rma-toolbar');
    if (tb && !tb.dataset.rmaBound) {
      tb.dataset.rmaBound = '1';
      tb.addEventListener('click', function (e) {
        var t = e.target;
        var seg = t.closest('.rma-seg-btn');
        if (seg) { view = seg.getAttribute('data-view') || 'board'; render(); return; }
        var src = t.closest('.rma-src-chip');
        if (src) { sourceFilter = src.getAttribute('data-src') || 'all'; render(); return; }
        if (t.closest('#rma-new')) { openIntake(); return; }
        if (t.closest('#rma-arrive')) { dlgArrival(); return; }
      });
      tb.addEventListener('input', function (e) {
        if (e.target && e.target.id === 'rma-search') {
          searchQ = String(e.target.value || '').toLowerCase().trim();
          renderView();
        }
      });
      tb.addEventListener('keydown', enterGuard);
    }

    var root = el('rma-root');
    if (root && !root.dataset.rmaBound) {
      root.dataset.rmaBound = '1';
      root.addEventListener('click', function (e) {
        var t = e.target;
        var open = t.closest('[data-open-unit]');
        if (open) { openUnit(open.getAttribute('data-open-unit')); return; }
        var act = t.closest('[data-act]');
        if (act) {
          var a = act.getAttribute('data-act');
          if (a === 'add-vendor') { dlgAddVendor().then(function () { if (screenActive()) renderView(); }); return; }
          if (a === 'recheck') { Object.keys(rolesCache).forEach(forgetRoles); renderView(); return; }
          if (a === 'recheck-one') { forgetRoles(act.getAttribute('data-unit')); renderView(); return; }
          if (a === 'retry-load') { ensureLoaded(); return; }
        }
        var disp = t.closest('.rma-dispatch-btn');
        if (disp) {
          var vk = disp.getAttribute('data-vendor');
          var ids = allUnits().filter(function (u) {
            return u.stage === 'ready_to_ship' && String(u.vendor_id) === String(vk) && shipSel[u.id] && shipEligible(u);
          }).map(function (u) { return u.id; });
          if (ids.length) dlgDispatch(ids, vk);
          return;
        }
        var card = t.closest('.rma-card');
        if (card && card.getAttribute('data-unit')) openUnit(card.getAttribute('data-unit'));
      });
      root.addEventListener('change', function (e) {
        var t = e.target;
        if (t.classList.contains('rma-ship-cb')) {
          var id = t.getAttribute('data-unit');
          if (t.checked) shipSel[id] = true; else delete shipSel[id];
          var u = unitById(id);
          if (u) refreshDispatchButton(String(u.vendor_id));
          return;
        }
        if (t.classList.contains('rma-ship-allcb')) {
          var vk = t.getAttribute('data-vendor');
          var on = t.checked;
          var sec = t.closest('.rma-ship-group');
          allUnits().forEach(function (u) {
            if (u.stage !== 'ready_to_ship' || String(u.vendor_id) !== String(vk)) return;
            if (on && shipEligible(u)) shipSel[u.id] = true; else delete shipSel[u.id];
          });
          if (sec) Array.prototype.forEach.call(sec.querySelectorAll('.rma-ship-cb'), function (cb) {
            if (!cb.disabled) cb.checked = !!shipSel[cb.getAttribute('data-unit')];
          });
          refreshDispatchButton(vk);
          return;
        }
        if (t.classList.contains('rma-ship-vendor')) { setShipVendor(t.getAttribute('data-unit'), t); }
      });
      root.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('rma-card')) {
          e.preventDefault();
          openUnit(e.target.getAttribute('data-unit'));
          return;
        }
        enterGuard(e);
      });
    }
  }

  // A USB scanner types like a keyboard and ends with Enter. Enter in a field
  // must never submit, close or activate anything. Textareas keep newlines and
  // a focused button still works from the keyboard.
  function enterGuard(e) {
    if (e.key !== 'Enter') return;
    var tag = ((e.target && e.target.tagName) || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  THE UNIT PANEL (#rma-unit-modal)
  // ══════════════════════════════════════════════════════════════════════════
  var openUnitId = null;
  var openSeq = 0;
  var unitTab = 'details';
  var unitBase = null;          // the Details values the form was painted FROM
  var moveBoxStage = null;      // the stage the move box was built for
  var unitTray = null;          // the photo tray on the Photos tab
  var trayBusy = false;         // an upload is in flight (one at a time)
  var trayUploading = null;     // the tray that upload is reading from
  var retiredTrays = [];        // trays taken off screen mid-upload; destroyed after it
  var timelineSeq = 0, gallerySeq = 0, serialTimer = null, serialSeq = 0;

  function panelOpen() { var m = el('rma-unit-modal'); return !!(m && m.classList.contains('active')); }

  // Only the tray an upload is still reading from has to wait for it; any
  // other tray goes at once. Retired trays are a list, not one slot, so a
  // second retirement during the same upload cannot strand the first.
  function destroyUnitTray() {
    if (!unitTray) return;
    var t = unitTray;
    unitTray = null;
    if (trayBusy && t === trayUploading) { retiredTrays.push(t); return; }
    try { t.destroy(); } catch (e) { /* already gone */ }
  }
  function destroyRetiredTrays() {
    var list = retiredTrays;
    retiredTrays = [];
    list.forEach(function (t) { if (t !== unitTray) { try { t.destroy(); } catch (e) { /* already gone */ } } });
  }

  async function openUnit(id) {
    if (!id) return;
    var seq = ++openSeq;
    var d = data();
    var miss = missingPiece();
    if (miss) { toast(miss, 'error'); return; }
    if (openUnitId && openUnitId !== id && panelOpen() && panelDirty()) {
      var go = await confirmBox('You have unsaved changes on ' + ((unitById(openUnitId) || {}).public_code || 'the open part') +
        '. Open the other part and lose them?', { title: 'Unsaved changes', okText: 'Open the other part', danger: true });
      if (!go || seq !== openSeq) return;
    }
    try { await d.ensureLoaded(); } catch (e) { /* the caches may still hold it */ }
    if (seq !== openSeq) return;
    var u = unitById(id);
    if (!u && typeof d.fetchUnit === 'function') {
      // Outside the two-day window (an old closed part opened from a ticket):
      // fetched on purpose, and the data layer keeps it pinned.
      try { u = await d.fetchUnit(id); } catch (e) { u = null; }
      if (seq !== openSeq) return;
      u = unitById(id) || u;
    }
    if (!u || !unitById(id)) {
      toast('That RMA part could not be found. It may have been removed, or you may not have access to it.', 'warning');
      return;
    }
    var modal = el('rma-unit-modal');
    if (!modal || !el('rma-unit-root')) { toast('The RMA panel is missing from this build.', 'error'); return; }
    destroyUnitTray();
    openUnitId = id;
    unitTab = 'details';
    unitBase = null;
    moveBoxStage = null;
    paintUnit();
    modal.classList.add('active');
    setTimeout(function () { var c = el('rma-unit-close'); if (c && openUnitId === id) c.focus(); }, 80);
    // The shipping gate needs the photo roles; fetch them once the panel is up.
    loadRoles(id).then(function () { if (openUnitId === id) paintGates(); });
  }

  async function closeUnit(force) {
    var unitId = openUnitId;
    if (!unitId) { var m0 = el('rma-unit-modal'); if (m0) m0.classList.remove('active'); return true; }
    if (!force && panelDirty()) {
      var ok = await confirmBox('Close this part without saving? Unsaved edits, the move note and any photos not yet uploaded will be lost.',
        { title: 'Unsaved changes', okText: 'Close without saving', danger: true });
      if (!ok || openUnitId !== unitId) return false;
    }
    var m = el('rma-unit-modal');
    if (m) m.classList.remove('active');
    destroyUnitTray();
    clearTimeout(serialTimer);
    openUnitId = null;
    unitBase = null;
    moveBoxStage = null;
    return true;
  }

  function panelDirty() {
    if (!openUnitId) return false;
    if (photoCount(unitTray) > 0) return true;
    var note = el('rma-m-note'), hn = el('rma-h-body');
    if (note && String(note.value || '').trim()) return true;
    if (hn && String(hn.value || '').trim()) return true;
    var stg = el('rma-m-stage');
    if (stg && stg.value) return true;
    return detailsDirty();
  }

  function paintUnit() {
    var root = el('rma-unit-root');
    var u = unitById(openUnitId);
    if (!root || !u) return;
    root.innerHTML = '<div class="rma-u">' +
      '<div id="rma-u-head" class="rma-u-head"></div>' +
      '<div id="rma-u-gates"></div>' +
      '<div id="rma-u-actions" class="rma-u-actions"></div>' +
      '<div id="rma-u-tabs" class="sv-tabs" role="tablist"></div>' +
      '<div id="rma-u-body" class="rma-u-body"></div>' +
    '</div>';
    paintUnitHead();
    paintGates();
    paintActions();
    paintTabs();
    paintTab();
  }

  function paintUnitHead() {
    var u = unitById(openUnitId);
    var m = model();
    if (!u || !m) return;
    var now = Date.now();
    var v = vendorOf(u);
    var it = intakeOf(u);
    var job = jobOf(u);

    setText('rma-unit-title', (u.public_code || 'RMA') + ' · ' + kindLabel(u.kind) + ' · ' + brandModel(u));
    var sub = [sourceLabel(sourceOf(u))];
    if (it && it.sender_name) sub.push(it.sender_name + (it.sender_kind && it.sender_kind !== 'customer' ? ' (' + senderKindLabel(it.sender_kind).toLowerCase() + ')' : ''));
    if (u.service_job_id) sub.push((job && job.public_code ? job.public_code : 'Linked ticket') + (u.holds_ticket && u.stage !== 'closed' ? ' — holds the ticket' : ''));
    setText('rma-unit-sub', sub.join(' · '));

    var host = el('rma-u-head');
    if (!host) return;
    var ball = 'shop';
    try { ball = m.rmaBallOf(u) || 'shop'; } catch (e) { /* default */ }
    var sentence = '';
    try { sentence = m.rmaWaitingSentence(augment(u), v) || staffStage(u.stage); } catch (e) { sentence = staffStage(u.stage); }
    // A stage the loaded model does not know yet (A8's with_tech on an older
    // shared file) would read "With us — in progress"; its own label is better.
    if (m.RMA_STAGES && !m.RMA_STAGES[u.stage]) sentence = staffStage(u.stage);
    var risk = safeRisk(u, now, v);
    var idle = m.daysInStage(u, now);
    var meta = [];
    meta.push('<span><span class="sv-k">Stage</span> ' + esc(staffStage(u.stage)) + '</span>');
    meta.push('<span><span class="sv-k">Handler</span> ' + esc(u.handler_name || 'nobody yet') + '</span>');
    if (v) meta.push('<span><span class="sv-k">Vendor</span> ' + esc(vendorName(v)) + '</span>');
    if (u.stage === 'with_vendor') {
      var exp = ms(u.expected_back_at);
      meta.push('<span><span class="sv-k">Expected back</span> ' + esc(exp ? fmtDate(u.expected_back_at) : 'not set') +
                (exp != null && exp <= now ? ' ' + lateTag() : '') + '</span>');
    }
    meta.push('<span><span class="sv-k">Logged</span> ' + esc(fmtDate(u.created_at)) + '</span>');
    host.innerHTML =
      '<div class="sv-job-ball">' +
        '<span class="sv-ball sv-ball-' + esc(ball) + '">' + esc(sentence) + '</span>' +
        '<span class="sv-job-idle' + (risk === 2 ? ' breach' : risk === 1 ? ' soon' : '') + '">' +
          esc(fmtDays(idle)) + ' in this stage' + (risk === 2 ? ' · late' : '') + '</span>' +
      '</div>' +
      '<div class="rma-u-meta">' + meta.join('') + '</div>';
  }

  // The box above the tabs: what is stopping the next obvious step, said
  // plainly, before anyone presses a button and is refused by the server.
  var PRE_SHIP = { with_tech: 1, received: 1, testing: 1, awaiting_docs: 1, ready_to_ship: 1 };
  function paintGates() {
    var host = el('rma-u-gates');
    var u = unitById(openUnitId);
    if (!host || !u) return;
    var s = u.stage;
    var probs = [], title = '', note = '';
    if (PRE_SHIP[s]) {
      if (!rolesKnown(u.id)) {
        var err = rolesErr(u.id);
        host.innerHTML = err ? '<div class="rma-gates is-note">Could not check the photos: ' + esc(err) + '</div>' : '';
        return;
      }
      probs = gateCheck(augment(u), 'ready_to_ship', rolesFor(u.id));
      title = s === 'ready_to_ship' ? 'Before it can be dispatched' : 'Before it can ship to the vendor';
      if (rolesPartial(u.id)) {
        // Said, not enforced: the ticket's photos may well have it (rolesFor).
        var seen = rolesSeen(u.id), lack = [];
        if (seen.indexOf('serial_label') === -1) lack.push('a photo of the serial label');
        if (u.purchase_source === 'elsewhere' && seen.indexOf('invoice') === -1 && seen.indexOf('vendor_doc') === -1) {
          lack.push('the customer’s invoice (or a warranty-check screenshot)');
        }
        if (lack.length) {
          note = 'Not on this part yet: ' + lack.join(', ') + '. One taken on its ticket counts too — your access cannot see the ticket’s photos, so that is checked when the part moves.';
        }
      }
    } else if (s === 'back_from_vendor' || s === 'customer_decision' || s === 'ready_to_return' || s === 'returning') {
      if (feeOwed(u) && feeAmountZero(u)) {
        // ₹0 cannot be "paid" (rma_set_fee refuses it): only a waiver settles it.
        probs.push('The handling fee is ₹0 but still ' + (u.fee_status === 'accepted' ? 'marked accepted' : 'a quote') +
                   ' — a zero fee is a waiver, so a lead waives it, with a reason, before closing.');
      } else if (feeOwed(u)) {
        probs.push('The handling fee' + (u.handling_fee != null ? ' of ' + fmtINR(u.handling_fee) : '') +
                   ' is ' + (u.fee_status === 'accepted' ? 'accepted but not paid' : 'quoted but not accepted') +
                   ' — mark it paid, or have a lead waive it, before closing.');
      }
      title = 'Before it can be closed';
    }
    host.innerHTML = (probs.length
      ? '<div class="rma-gates" role="status"><div class="rma-gates-title">' + esc(title) + '</div><ul>' +
          probs.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>'
      : '') +
      (note ? '<div class="rma-gates is-note">' + esc(note) + '</div>' : '');
  }

  function isHolding(u) { return !!(u && u.holds_ticket && u.service_job_id && u.stage !== 'closed'); }
  function canReceive(u) { return !!u && (u.stage === 'logged' || u.stage === 'with_tech'); }

  function paintActions() {
    var host = el('rma-u-actions');
    var u = unitById(openUnitId);
    if (!host || !u) return;
    var m = model();
    var acts = [];
    try { acts = (typeof m.rmaActions === 'function' ? m.rmaActions(u) : []) || []; } catch (e) { acts = []; }
    var b = [];
    var w = canDesk();
    if (!u.handler_email && u.stage !== 'closed' && canTech()) b.push(['claim', 'Claim', 'secondary-btn']);
    if (w && canReceive(u)) b.push(['receive', 'Mark received…', 'primary-pink-btn']);
    if (w && (acts.indexOf('dispatch') !== -1 || u.stage === 'ready_to_ship')) b.push(['dispatch', 'Dispatch…', 'primary-pink-btn']);
    if (w && (acts.indexOf('vendor_result') !== -1 || u.stage === 'with_vendor')) b.push(['vendor-result', 'Record vendor result…', 'primary-pink-btn']);
    if (w && u.stage === 'customer_decision') b.push(['paid-repair', 'Open paid repair…', 'secondary-btn']);
    if (w && isHolding(u) && !u.advance_replacement) b.push(['stock-replace', 'Replaced from stock…', 'secondary-btn']);
    if (w && isHolding(u)) b.push(['release', 'Release from ticket…', 'secondary-btn']);
    if (trackingPhone(u)) b.push(['message', 'Message on WhatsApp…', 'secondary-btn']);
    b.push(['copy-link', 'Copy tracking link', 'secondary-btn']);
    if (canPrint()) b.push(['print-label', 'Print label', 'secondary-btn']);
    host.innerHTML = b.map(function (x) {
      return '<button type="button" class="' + x[2] + ' rma-act" data-act="' + x[0] + '">' + esc(x[1]) + '</button>';
    }).join('');
  }

  function paintTabs() {
    var host = el('rma-u-tabs');
    var u = unitById(openUnitId);
    if (!host || !u) return;
    var tabs = [['details', 'Details'], ['photos', 'Photos'], ['history', 'History']];
    if (u.service_job_id) tabs.push(['ticket', 'Ticket']);
    if (!tabs.some(function (t) { return t[0] === unitTab; })) unitTab = 'details';
    host.innerHTML = tabs.map(function (t) {
      var on = t[0] === unitTab;
      return '<button type="button" class="sv-tab' + (on ? ' active' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') +
             '" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('');
  }

  function paintTab() {
    var body = el('rma-u-body');
    var u = unitById(openUnitId);
    if (!body || !u) return;
    if (unitTab !== 'photos') destroyUnitTray();
    if (unitTab === 'photos') {
      body.innerHTML = photosHtml(u);
      mountUnitTray(u);
      loadGallery(u.id);
    } else if (unitTab === 'history') {
      body.innerHTML = historyHtml();
      loadTimeline(u.id);
    } else if (unitTab === 'ticket') {
      body.innerHTML = ticketHtml(u);
      fetchTicketOnce(u);
    } else {
      body.innerHTML = detailsHtml(u);
      paintFee();
      paintMoveBox();
    }
  }

  async function switchTab(tab) {
    var unitId = openUnitId;
    if (!unitId || tab === unitTab) return;
    if (unitTab === 'photos') {
      // Photos waiting in the tray are dropped on leaving — unless they are
      // the batch being uploaded right now, which finishes by itself.
      var n = photoCount(unitTray);
      if (n > 0 && !(trayBusy && unitTray === trayUploading)) {
        var ok = await confirmBox(n + ' photo' + (n === 1 ? ' is' : 's are') + ' not uploaded yet. Leave the Photos tab and drop ' + (n === 1 ? 'it' : 'them') + '?',
          { title: 'Photos not uploaded', okText: 'Drop them', danger: true });
        if (!ok || openUnitId !== unitId) return;
      }
    }
    if (unitTab === 'details' && detailsDirty()) {
      var ok2 = await confirmBox('The Details tab has unsaved changes. Leave it and lose them?',
        { title: 'Unsaved changes', okText: 'Leave without saving', danger: true });
      if (!ok2 || openUnitId !== unitId) return;
    }
    unitTab = tab;
    paintTabs();
    paintTab();
  }

  // ── Details ──
  // The editable part columns are exactly the ones the database grants UPDATE
  // on (+ A11's data_handling); kind, stage, fee and vendor result change only
  // through their own actions. The sender lives on the arrival (rma_intakes)
  // and is shared by every part that came with it.
  var U_FIELDS = ['brand', 'model', 'serial', 'fault', 'diagnosed_by', 'our_finding', 'owner_name', 'owner_phone',
                  'purchase_source', 'invoice_no', 'purchase_date', 'build_ticket_id', 'vendor_id', 'vendor_rma_no',
                  'expected_back_at', 'return_method', 'return_address', 'data_handling'];
  var I_FIELDS = ['sender_name', 'sender_phone', 'inbound_courier', 'inbound_awb', 'notes'];
  var FIELD_NAMES = { serial: 'serial', vendor_id: 'vendor', purchase_source: 'where bought', invoice_no: 'invoice no.',
    purchase_date: 'purchase date', owner_phone: 'end customer phone', owner_name: 'end customer',
    return_method: 'return method', return_address: 'return address', vendor_rma_no: 'vendor RMA no.',
    expected_back_at: 'expected back', our_finding: 'our finding', fault: 'fault', brand: 'brand',
    model: 'model', diagnosed_by: 'who found the fault', build_ticket_id: 'build link', data_handling: 'data on the drive',
    sender_name: 'sender name', sender_phone: 'sender phone', inbound_courier: 'inbound courier',
    inbound_awb: 'inbound AWB', notes: 'arrival notes' };

  function baseValue(row, col) {
    var v = row ? row[col] : null;
    if (col === 'expected_back_at') return isoToDay(v);
    if (col === 'purchase_date') return v ? String(v).slice(0, 10) : '';
    return v == null ? '' : String(v);
  }
  function fid(col) { return 'rma-u-f-' + col; }
  function iid(col) { return 'rma-u-i-' + col; }
  function inputValue(id) {
    var e = el(id);
    return e ? String(e.value || '').trim() : null;
  }
  function detailsDirty() {
    if (!unitBase || unitBase.id !== openUnitId || !el(fid('brand'))) return false;
    var a = U_FIELDS.some(function (c) {
      var v = inputValue(fid(c));
      return v != null && v !== (unitBase.u[c] || '');
    });
    if (a) return true;
    return !!unitBase.i && I_FIELDS.some(function (c) {
      var v = inputValue(iid(c));
      return v != null && v !== (unitBase.i[c] || '');
    });
  }

  function ufield(label, id, value, opts) {
    opts = opts || {};
    var cls = 'sv-field' + (opts.wide ? ' sv-span2' : '');
    var ph = opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '';
    if (opts.textarea) {
      return '<label class="' + cls + '"><span>' + esc(label) + '</span><textarea id="' + id + '" rows="' + (opts.rows || 2) + '"' + ph + '>' +
             esc(value || '') + '</textarea></label>';
    }
    return '<label class="' + cls + '"><span>' + esc(label) + '</span><input type="' + (opts.type || 'text') + '" id="' + id +
           '" value="' + esc(value || '') + '"' + ph + (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') +
           ' autocomplete="off" spellcheck="false"></label>';
  }
  // A stored value the options do not know (a newer vocabulary, say) is kept
  // as an option of its own, so it shows as selected and an unrelated save
  // never overwrites it — the same rule as service.js selectField.
  function uselect(label, id, value, options, opts) {
    opts = opts || {};
    var cur = value == null ? '' : String(value);
    var list = (cur && !options.some(function (o) { return String(o.value) === cur; }))
      ? options.concat([{ value: cur, label: cur }]) : options;
    return '<label class="sv-field' + (opts.wide ? ' sv-span2' : '') + '"><span>' + esc(label) + '</span>' +
      '<select id="' + id + '" class="settings-select">' +
      list.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select></label>';
  }
  function fact(k, v) {
    return '<div class="sv-f"><span class="sv-f-k">' + esc(k) + '</span><span class="sv-f-v">' + esc(v) + '</span></div>';
  }

  function detailsHtml(u) {
    var it = intakeOf(u);
    var job = jobOf(u);
    var ro = !canDesk() || u.stage === 'closed';
    unitBase = { id: u.id, intakeId: it ? it.id : null, u: {}, i: null };
    U_FIELDS.forEach(function (c) { unitBase.u[c] = baseValue(u, c); });
    if (it) {
      unitBase.i = {};
      I_FIELDS.forEach(function (c) { unitBase.i[c] = baseValue(it, c); });
    }
    var B = unitBase.u, IB = unitBase.i || {};

    var facts = [];
    facts.push(fact('Part', kindLabel(u.kind)));
    facts.push(fact('Came in as', sourceLabel(sourceOf(u)) + (it && it.sender_kind ? ' · ' + senderKindLabel(it.sender_kind) : '')));
    var tp = trackingPhone(u);
    facts.push(fact('Tracking updates go to', tp ? (u.owner_phone ? 'End customer · ' : 'Sender · ') + showPhone(tp) : 'Nobody — no phone on file'));
    if (u.service_job_id) facts.push(fact('Linked ticket', (job && job.public_code ? job.public_code : 'Not loaded here') + (u.holds_ticket ? ' · the ticket waits for this part' : ' · does not hold the ticket')));
    if (u.vendor_result) facts.push(fact('Vendor result', resultLabel(u.vendor_result) + (u.vendor_reason ? ' — ' + u.vendor_reason : '')));
    if (u.replacement_serial) facts.push(fact('Replacement serial', u.replacement_serial));
    if (u.advance_replacement) facts.push(fact('Replaced from our stock', (u.advance_serial || 'serial not recorded') + (u.advance_at ? ' · ' + fmtDate(u.advance_at) : '') + ' — this part now belongs to the shop'));
    if (u.return_awb || u.return_courier) facts.push(fact('Returned by', [u.return_courier, u.return_awb].filter(Boolean).join(' · ')));
    if (u.disposition) facts.push(fact('Outcome', dispLabel(u.disposition)));
    if (u.followup_job_id) {
      var fj = jobById(u.followup_job_id);
      facts.push(fact('Paid repair ticket', fj && fj.public_code ? fj.public_code : 'Created'));
    }
    if (u.closed_at) facts.push(fact('Closed', fmtDateTime(u.closed_at) + (u.closed_by ? ' · ' + u.closed_by : '')));

    var buyOpts = BUY_KEYS.map(function (k) { return { value: k, label: buyLabel(k) }; });
    var retOpts = [{ value: 'collect', label: RETURN_LABELS.collect }, { value: 'courier', label: RETURN_LABELS.courier }];
    if (u.service_job_id || u.return_method === 'with_device') retOpts.push({ value: 'with_device', label: RETURN_LABELS.with_device });
    var vOpts = [{ value: '', label: '— No vendor yet —' }].concat(allVendors()
      .filter(function (v) { return v.active !== false || String(v.id) === String(u.vendor_id); })
      .slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); })
      .map(function (v) { return { value: String(v.id), label: (v.name || v.public_name) + (v.active === false ? ' (inactive)' : '') }; }));
    // The stored vendor always stays an option, even when the vendor list did
    // not load: otherwise nothing is selected, the select reads '', the form
    // looks edited, and saving any other field would clear the vendor.
    if (B.vendor_id && !vOpts.some(function (o) { return o.value === B.vendor_id; })) {
      vOpts.push({ value: B.vendor_id, label: vendorName(vendorById(u.vendor_id)) || 'Vendor #' + B.vendor_id + ' (not loaded)' });
    }

    var linked = (u.followup_job_id && canService())
      ? '<div class="sv-linked">This part moved to a paid repair. <button type="button" class="sv-linkbtn" data-act="open-followup">Open the repair ticket</button></div>' : '';

    var driveBlock = (isDrive(u.kind) || B.data_handling)
      ? '<h4 class="rma-sec-title">Data on the drive</h4><div class="sv-grid">' +
          uselect('What happened to the data?', fid('data_handling'), B.data_handling,
                  [{ value: '', label: '— Not recorded yet —' }].concat(DATA_HANDLING), { wide: true }) +
        '</div>'
      : '';

    var senderBlock = it
      ? '<h4 class="rma-sec-title">Sent by <span class="rma-muted">(shared by every part that came with it)</span></h4>' +
        '<div class="sv-grid">' +
          ufield('Sender name', iid('sender_name'), IB.sender_name) +
          ufield('Sender phone', iid('sender_phone'), IB.sender_phone, { inputmode: 'tel' }) +
          ufield('Came in by courier', iid('inbound_courier'), IB.inbound_courier) +
          ufield('Inbound AWB', iid('inbound_awb'), IB.inbound_awb) +
          ufield('Arrival notes', iid('notes'), IB.notes, { textarea: true, wide: true }) +
        '</div>'
      : '';

    return linked +
      '<div class="sv-fields rma-facts">' + facts.join('') + '</div>' +
      '<fieldset class="rma-fs"' + (ro ? ' disabled' : '') + '>' +
      '<h4 class="rma-sec-title">The part</h4>' +
      '<div class="sv-grid">' +
        ufield('Brand', fid('brand'), B.brand, { placeholder: 'e.g. ASUS' }) +
        ufield('Model', fid('model'), B.model, { placeholder: 'e.g. TUF RTX 4070 Ti' }) +
        ufield('Serial (as printed on the label)', fid('serial'), B.serial, { wide: true, placeholder: 'Needed before it can ship' }) +
        '<div id="rma-u-buildhint" class="sv-span2 rma-hint-slot"></div>' +
        ufield('Fault', fid('fault'), B.fault, { textarea: true, wide: true }) +
        uselect('Who found the fault?', fid('diagnosed_by'), B.diagnosed_by || 'customer', DIAG_OPTIONS) +
        '<div></div>' +
        ufield('Our finding (internal)', fid('our_finding'), B.our_finding, { textarea: true, wide: true, placeholder: 'What our test showed. Stays internal.' }) +
      '</div>' +
      driveBlock +
      '<h4 class="rma-sec-title">Owner</h4>' +
      '<div class="sv-grid">' +
        ufield('End customer name', fid('owner_name'), B.owner_name, { placeholder: 'If different from the sender' }) +
        ufield('End customer phone', fid('owner_phone'), B.owner_phone, { inputmode: 'tel', placeholder: 'Tracking updates go here when set' }) +
      '</div>' +
      senderBlock +
      '<h4 class="rma-sec-title">Purchase</h4>' +
      '<div class="sv-grid">' +
        uselect('Where was it bought?', fid('purchase_source'), B.purchase_source || 'unknown', buyOpts) +
        ufield('Invoice no.', fid('invoice_no'), B.invoice_no) +
        ufield('Purchase date', fid('purchase_date'), B.purchase_date, { type: 'date' }) +
        ufield('Build ticket (if we built it)', fid('build_ticket_id'), B.build_ticket_id, { placeholder: 't_…' }) +
      '</div>' +
      '<h4 class="rma-sec-title">Vendor</h4>' +
      '<div class="sv-grid">' +
        '<div class="sv-field rma-vendor-field"><span>Vendor</span><div class="rma-inline">' +
          '<select id="' + fid('vendor_id') + '" class="settings-select" aria-label="Vendor">' +
            vOpts.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === B.vendor_id ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') +
          '</select>' +
          (ro ? '' : '<button type="button" class="secondary-btn rma-small" data-act="add-vendor-pick">Add vendor…</button>') +
        '</div></div>' +
        ufield('Vendor RMA no.', fid('vendor_rma_no'), B.vendor_rma_no) +
        ufield('Expected back', fid('expected_back_at'), B.expected_back_at, { type: 'date' }) +
      '</div>' +
      '<h4 class="rma-sec-title">Return</h4>' +
      '<div class="sv-grid">' +
        uselect('How does it go back?', fid('return_method'), B.return_method || 'collect', retOpts) +
        '<div></div>' +
        ufield('Return address (for courier)', fid('return_address'), B.return_address, { textarea: true, wide: true }) +
      '</div>' +
      '</fieldset>' +
      (ro ? (u.stage === 'closed' ? '<p class="sv-hint">This part is closed, so its details are locked.</p>' : '') :
        '<div class="sv-actions"><button type="button" id="rma-u-save" class="primary-pink-btn">Save changes</button>' +
        '<span id="rma-u-status" class="sv-status"></span></div>') +
      '<div id="rma-u-fee"></div>' +
      '<div id="rma-u-movebox"></div>';
  }

  // A quiet check as the serial is typed: is it one of our builds?
  function onDetailsSerialInput() {
    var unitId = openUnitId;
    clearTimeout(serialTimer);
    var host = el('rma-u-buildhint');
    if (host) host.innerHTML = '';
    var q = inputValue(fid('serial')) || '';
    if (!unitBase || unitBase.id !== unitId || q === (unitBase.u.serial || '')) return;
    var seq = ++serialSeq;
    serialTimer = setTimeout(function () {
      findSerialBuild(q).then(function (b) {
        if (!b || seq !== serialSeq || openUnitId !== unitId || inputValue(fid('serial')) !== q) return;
        var h = el('rma-u-buildhint');
        if (h) h.innerHTML = buildHintHtml(b);
      });
    }, 600);
  }

  async function saveDetails() {
    var unitId = openUnitId;                      // bound once; see the file header
    var g = sessionGen;
    var u = unitById(unitId);
    var base = unitBase;
    var set = function (msg, k) { if (openUnitId === unitId && !isStale(g)) setStatusId('rma-u-status', msg, k); };
    if (!u) return;
    if (!base || base.id !== unitId) return set('This panel is out of date — reopen the part.', 'err');

    var cur = {}, icur = {};
    U_FIELDS.forEach(function (c) { cur[c] = inputValue(fid(c)); });
    I_FIELDS.forEach(function (c) { icur[c] = inputValue(iid(c)); });
    var patch = {}, ipatch = {};
    U_FIELDS.forEach(function (c) {
      if (cur[c] == null || cur[c] === (base.u[c] || '')) return;
      var v = cur[c];
      if (c === 'owner_phone') patch[c] = v ? normPhone(v) : null;
      // expected_back_at goes as the calendar day: the data layer turns a
      // date-only value into that morning, local time.
      else patch[c] = v || null;
    });
    if (base.i && base.intakeId) {
      I_FIELDS.forEach(function (c) {
        if (icur[c] == null || icur[c] === (base.i[c] || '')) return;
        ipatch[c] = c === 'sender_phone' ? (icur[c] ? normPhone(icur[c]) : null) : (icur[c] || null);
      });
    }
    if (!Object.keys(patch).length && !Object.keys(ipatch).length) return set('Nothing to save.', '');

    // Check the edited result, not just the edited fields: a courier return
    // with no address is wrong whichever field made it so.
    var after = Object.assign({}, u, patch);
    if (!String(after.brand || '').trim() && !String(after.model || '').trim()) return set('Give the part a brand or a model.', 'err');
    if ('fault' in patch && !patch.fault) return set('Keep a fault description — even one line.', 'err');
    if ('owner_phone' in patch && patch.owner_phone && !validPhone(patch.owner_phone)) return set('The end customer phone should be a mobile number — 10 digits, or with the country code.', 'err');
    if (after.return_method === 'courier' && !String(after.return_address || '').trim()) return set('A courier return needs a return address.', 'err');
    if (after.return_method === 'with_device' && !after.service_job_id) return set('“With the device” only works for a part linked to a ticket.', 'err');
    if ('build_ticket_id' in patch && patch.build_ticket_id && !/^t_[A-Za-z0-9]+$/.test(patch.build_ticket_id)) return set('A build ticket id looks like t_… — copy it from the build, or use Link it.', 'err');
    if ('purchase_date' in patch && patch.purchase_date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.purchase_date)) return set('That purchase date does not look right.', 'err');
    if ('expected_back_at' in patch && patch.expected_back_at && !/^\d{4}-\d{2}-\d{2}$/.test(patch.expected_back_at)) return set('That expected-back date does not look right.', 'err');
    ['diagnosed_by', 'purchase_source', 'return_method'].forEach(function (k) { if (k in patch && !patch[k]) delete patch[k]; });
    if ('sender_name' in ipatch && !ipatch.sender_name) return set('Keep the sender’s name.', 'err');
    if ('sender_phone' in ipatch && ipatch.sender_phone && !validPhone(ipatch.sender_phone)) return set('The sender phone should be a mobile number — 10 digits, or with the country code.', 'err');

    var btn = el('rma-u-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    set('Saving…', '');
    var unitSaved = false, failed = null;
    try {
      if (Object.keys(patch).length) { await data().updateRma(unitId, patch); unitSaved = true; }
      if (Object.keys(ipatch).length) await data().updateIntake(base.intakeId, ipatch);
    } catch (e) {
      failed = e;
    }
    if (isStale(g)) return;                       // signed out meanwhile: nothing more for them
    var changed = Object.keys(unitSaved || !failed ? patch : {}).concat(failed ? [] : Object.keys(ipatch))
      .map(function (k) { return FIELD_NAMES[k] || k; });
    if (changed.length) {
      // A short internal history line, so "who changed the serial" has an answer.
      var noteErr = null;
      try { await data().rmaNote(unitId, 'Details updated: ' + changed.join(', ') + '.', false); }
      catch (e) { noteErr = e; }
      if (isStale(g)) return;
      if (noteErr && !isDemoErr(noteErr)) toast('Saved, but the history line did not record.', 'warning');
    }
    // Move the baseline forward for whatever DID save, so the next save does
    // not resend it and "unsaved changes" does not nag about it.
    if (base.id === unitId) {
      if (unitSaved || (!failed && Object.keys(patch).length)) {
        Object.keys(patch).forEach(function (k) {
          base.u[k] = k === 'owner_phone' ? (patch.owner_phone || '') : (cur[k] || '');
        });
      }
      if (!failed) Object.keys(ipatch).forEach(function (k) { base.i[k] = k === 'sender_phone' ? (ipatch.sender_phone || '') : (icur[k] || ''); });
      if (openUnitId === unitId) {
        if ('owner_phone' in patch && (unitSaved || !failed)) { var ph = el(fid('owner_phone')); if (ph) ph.value = base.u.owner_phone; }
        if ('sender_phone' in ipatch && !failed) { var sp = el(iid('sender_phone')); if (sp) sp.value = base.i.sender_phone; }
      }
    }
    forgetRoles(unitId);
    var b2 = el('rma-u-save');
    if (b2 && openUnitId === unitId) { b2.disabled = false; b2.textContent = 'Save changes'; }
    if (failed) {
      var msg = (unitSaved ? 'The part details saved, but the sender details did not: ' : 'Could not save: ') + failText(failed);
      if (openUnitId === unitId) set(msg, 'err'); else toast((u.public_code || 'Part') + ': ' + msg, 'error');
    } else {
      set('Saved.', 'ok');
      toast('RMA part updated.', 'success', 2500);
    }
    if (openUnitId === unitId) {
      paintUnitHead();
      paintActions();
      paintFee();
      loadRoles(unitId).then(function () { if (openUnitId === unitId) paintGates(); });
    }
  }

  // ── fee block (buttons only, so it is safe to repaint at any time) ──
  // A ₹0 fee "quoted", "accepted" or "paid" is a waiver by another name: it
  // would pass the ship and close gates with no lead and no reason, so
  // rma_set_fee refuses it (NEO_DENIED for the desk, NEO_GATE for a lead).
  // A part whose fee on record is ₹0 is therefore offered Waive… (a lead,
  // with a reason) — and, while it is only a quote, a real amount — never
  // "Customer accepted" or "Mark paid".
  function feeAmountZero(u) {
    if (!u || u.handling_fee == null || u.handling_fee === '') return false;
    var n = Number(u.handling_fee);
    return isFinite(n) && n <= 0;
  }
  var ZERO_FEE_DESK = 'A zero fee is a waiver — ask a lead to waive it.';
  var ZERO_FEE_LEAD = 'A zero fee is a waiver — use Waive… and say why.';
  function paintFee() {
    var host = el('rma-u-fee');
    var u = unitById(openUnitId);
    if (!host || !u) return;
    var st = u.fee_status || 'n_a';
    var w = canDesk() && u.stage !== 'closed';
    var amt = u.handling_fee != null ? fmtINR(u.handling_fee) : '—';
    var owed = st === 'quoted' || st === 'accepted';
    var zero = owed && feeAmountZero(u);
    var lines = '';
    if (u.fee_ref) lines += '<div class="rma-fee-line"><span class="sv-k">Bill no.</span> ' + esc(u.fee_ref) + '</div>';
    if (u.fee_note) lines += '<div class="rma-fee-line"><span class="sv-k">Note</span> ' + esc(u.fee_note) + '</div>';
    var hint = '';
    if (st === 'n_a' && u.purchase_source === 'elsewhere') {
      hint = '<p class="sv-hint">Bought elsewhere: this is a paid handling service, and it needs the customer’s invoice (or a warranty-check screenshot) before it ships. Add the fee.</p>';
    } else if (zero && w) {
      hint = '<p class="sv-hint">The fee on record is ₹0, and a zero fee is a waiver: ' +
        (isLead() ? 'waive it and say why' : 'a lead waives it, with a reason') +
        (st === 'quoted' ? ' — or change it to the real amount.' : '.') + '</p>';
    }
    var btns = [];
    if (w) {
      if (st === 'n_a') btns.push(['fee-quote', 'Add a handling fee…']);
      if (st === 'quoted') {
        if (!zero) btns.push(['fee-accept', 'Customer accepted…']);
        btns.push(['fee-quote', 'Change amount…']);
      }
      if (owed && !zero) btns.push(['fee-paid', 'Mark paid…']);
      if (owed && isLead()) btns.push(['fee-waive', 'Waive…']);
    }
    host.innerHTML = '<div class="rma-fee">' +
      '<div class="rma-fee-top"><span class="rma-fee-k">Handling fee</span>' +
        '<span class="rma-fee-amt">' + esc(st === 'n_a' ? 'None' : amt) + '</span>' +
        '<span class="rma-pill rma-fee-' + esc(st) + '">' + esc(FEE_WORDS[st] || st) + '</span></div>' +
      lines + hint +
      (btns.length ? '<div class="rma-fee-btns">' + btns.map(function (b) {
        return '<button type="button" class="secondary-btn rma-small" data-act="' + b[0] + '">' + esc(b[1]) + '</button>';
      }).join('') + '</div>' : '') +
      (owed && w && !isLead() && !zero ? '<p class="sv-hint">Only a lead can waive a fee.</p>' : '') +
    '</div>';
  }

  // ── move box ──
  function moveBoxPristine() {
    var s = el('rma-m-stage'), n = el('rma-m-note');
    return !(s && s.value) && !(n && String(n.value || '').trim());
  }
  function paintMoveBox() {
    var host = el('rma-u-movebox');
    var u = unitById(openUnitId);
    if (!host || !u) return;
    moveBoxStage = u.stage;
    if (!canDesk()) { host.innerHTML = ''; return; }
    if (u.stage === 'closed') {
      host.innerHTML = '<div class="sv-movebox"><div class="sv-moves-label">Closed</div><p class="sv-hint">' +
        esc(u.disposition ? dispLabel(u.disposition) + '.' : 'This part is closed.') + ' Nothing more to do.</p></div>';
      return;
    }
    var list = nextStages(u);
    var waiting = u.stage === 'with_vendor'
      ? '<p class="sv-hint">The part is with the vendor. When it comes back — or the vendor answers — use <strong>Record vendor result…</strong> above.</p>' : '';
    if (!list.length) {
      host.innerHTML = '<div class="sv-movebox"><div class="sv-moves-label">Move this part on</div>' + (waiting || '<p class="sv-hint">No manual move from here.</p>') + '</div>';
      return;
    }
    host.innerHTML = '<div class="sv-movebox">' +
      '<div class="sv-moves-label">Move this part on</div>' + waiting +
      '<div class="sv-move-row">' +
        '<select id="rma-m-stage" class="settings-select" aria-label="Move to">' +
          '<option value="">— Move to —</option>' +
          list.map(function (s) {
            var lab = staffStage(s) + (s === 'received' && canReceive(u) ? ' (it has arrived)' : '');
            return '<option value="' + esc(s) + '">' + esc(lab) + '</option>';
          }).join('') +
        '</select>' +
        '<button type="button" id="rma-m-go" class="secondary-btn" disabled>Move</button>' +
      '</div>' +
      '<div id="rma-m-extra" class="sv-m-extra"></div>' +
      '<textarea id="rma-m-note" rows="2" placeholder="What happened? Write it for the customer."></textarea>' +
      '<label class="sv-check"><input type="checkbox" id="rma-m-visible" checked> The customer can read this note</label>' +
      '<div id="rma-m-status" class="sv-status"></div>' +
    '</div>';
  }

  function dispositionOptions(u, forReturn) {
    if (u.stage === 'logged' || u.stage === 'with_tech') return ['withdrawn'];
    if (forReturn) return ['no_fault_found', 'out_of_warranty', 'withdrawn'];
    var m = model();
    var list = (m && typeof m.rmaDispositionsFor === 'function') ? (m.rmaDispositionsFor(u) || []).slice() : [];
    if (!list.length) list = Object.keys((m && m.RMA_DISPOSITIONS) || DISP_FALLBACK);
    // converted_to_repair has its own button: it creates a ticket, and that
    // must never happen as a side effect of picking from a list.
    return list.filter(function (k) { return k !== 'converted_to_repair'; });
  }
  function suggestDisposition(u) {
    if (u.stage === 'logged' || u.stage === 'with_tech') return 'withdrawn';
    if (u.disposition) return u.disposition;
    if (u.advance_replacement) return 'restocked';
    var wd = u.return_method === 'with_device';
    switch (u.vendor_result) {
      case 'replaced': return wd ? 'refitted' : 'replaced';
      case 'repaired': return wd ? 'refitted' : 'repaired';
      case 'shipped_to_customer': return 'replaced';
      case 'credit_note': return 'credit_note';
      case 'rejected': return 'rejected_returned';
      case 'lost': return 'lost_compensated';
      default: return '';
    }
  }
  function returnSentence(u) {
    var job = jobOf(u);
    if (u.return_method === 'courier') {
      return u.return_address ? 'Goes back by courier to: ' + u.return_address
                              : 'Goes back by courier — but there is no return address yet. Add one in the Return section and save.';
    }
    if (u.return_method === 'with_device') return 'Goes back inside the customer’s device' + (job && job.public_code ? ' on ' + job.public_code : '') + '.';
    return 'The customer collects it from the shop.';
  }
  function moveExtrasHtml(u, to) {
    var out = '';
    var selectOf = function (id, label, keys, chosen) {
      return '<label class="sv-field sv-span2"><span>' + esc(label) + '</span><select id="' + id + '" class="settings-select">' +
        '<option value="">Choose…</option>' +
        keys.map(function (k) { return '<option value="' + esc(k) + '"' + (k === chosen ? ' selected' : '') + '>' + esc(dispLabel(k)) + '</option>'; }).join('') +
        '</select></label>';
    };
    if (to === 'received') {
      out += '<p class="sv-hint sv-span2">Moving it to Received opens the arrival check: condition and photos first.</p>';
    } else if (to === 'closed') {
      out += selectOf('rma-m-disp', 'How did it end? (the customer sees this)', dispositionOptions(u, false), suggestDisposition(u));
      if (u.stage === 'ready_to_return' && (u.return_method || 'collect') === 'collect') {
        out += '<label class="sv-field sv-span2"><span>Collected by (optional)</span><input type="text" id="rma-m-collected" autocomplete="off" spellcheck="false" placeholder="Name of the person who collected it"></label>';
      }
      if (feeOwed(u)) out += '<p class="sv-hint sv-span2 rma-warn">The handling fee is not settled yet — closing will be refused until it is paid or waived.</p>';
    } else if (to === 'ready_to_return') {
      if (!u.vendor_result && !u.advance_replacement) {
        out += selectOf('rma-m-disp', 'Why is it going back without a claim?', dispositionOptions(u, true), u.disposition || '');
      }
      out += '<p class="sv-hint sv-span2">' + esc(returnSentence(u)) + '</p>';
    } else if (to === 'returning') {
      out += '<label class="sv-field"><span>Courier</span><input type="text" id="rma-m-rcourier" autocomplete="off" spellcheck="false" placeholder="e.g. DTDC"></label>';
      out += '<label class="sv-field"><span>AWB / tracking no.</span><input type="text" id="rma-m-rawb" autocomplete="off" spellcheck="false"></label>';
      out += '<p class="sv-hint sv-span2">' + esc(returnSentence(u)) + '</p>';
    } else if (to === 'awaiting_docs') {
      out += '<p class="sv-hint sv-span2">Say in the note what we need — an invoice, a photo, their go-ahead. The customer reads it on their tracking page.</p>';
    } else if (to === 'ready_to_ship') {
      out += '<p class="sv-hint sv-span2">It needs a serial, a photo of the serial label, where it was bought and a vendor' +
             (isDrive(u.kind) ? ', what happened to the data on the drive' : '') +
             ' — and, if bought elsewhere, the invoice (or a warranty-check screenshot) and an agreed fee.</p>';
    }
    if ((u.stage === 'received' || u.stage === 'testing') && to !== 'closed' && to !== 'received' && to !== 'testing') {
      out += '<label class="sv-field sv-span2"><span>Our finding (internal, optional)</span><textarea id="rma-m-finding" rows="2" placeholder="What the test showed">' +
             esc(u.our_finding || '') + '</textarea></label>';
    }
    return out ? '<div class="sv-grid">' + out + '</div>' : '';
  }

  async function doMove() {
    var unitId = openUnitId;                      // bound once
    var g = sessionGen;
    var u = unitById(unitId);
    var set = function (msg, k, action) { if (openUnitId === unitId && !isStale(g)) setStatusId('rma-m-status', msg, k, action); };
    if (!u) return;
    var to = (el('rma-m-stage') || {}).value;
    if (!to) return;
    var from = moveBoxStage || u.stage;
    var refresh = { label: 'Refresh', fn: function () { if (openUnitId === unitId) { paintUnitHead(); paintGates(); paintActions(); paintFee(); paintMoveBox(); } } };
    if (u.stage !== from) {
      return set('Someone moved this part to ' + staffStage(u.stage) + ' already.', 'err', refresh);
    }
    // SPEC-AMENDMENTS A21: an arrival goes through the custody check (photos,
    // condition), never a bare stage change.
    if (to === 'received' && canReceive(u)) { dlgReceive(); return; }

    var note = String((el('rma-m-note') || {}).value || '').trim();
    var visible = !!(el('rma-m-visible') || {}).checked;
    var v = function (id) { var e = el(id); return e ? String(e.value || '').trim() : ''; };
    var extra = {};

    if (to === 'closed') {
      var d1 = v('rma-m-disp');
      if (!d1) return set('Say how it ended — the customer sees this, and “Closed” on its own tells them nothing.', 'err');
      extra.disposition = d1;
      var cb = v('rma-m-collected');
      if (cb) extra.collected_by = cb;
    }
    if (to === 'ready_to_return') {
      if (!u.vendor_result && !u.advance_replacement) {
        var d2 = v('rma-m-disp');
        if (!d2) return set('Say why it is going back — no fault found, out of warranty, or withdrawn.', 'err');
        extra.disposition = d2;
      }
      if (u.return_method === 'courier' && !String(u.return_address || '').trim()) {
        return set('A courier return needs a return address. Add it in the Return section and save first.', 'err');
      }
    }
    if (to === 'returning') {
      var awb = v('rma-m-rawb');
      if (!awb) return set('Enter the AWB — it is what the customer tracks the parcel with.', 'err');
      extra.return_awb = awb;
      var rc = v('rma-m-rcourier');
      if (rc) extra.return_courier = rc;
    }
    var finding = el('rma-m-finding');
    if (finding) {
      var fv = String(finding.value || '').trim();
      if (fv && fv !== String(u.our_finding || '').trim()) extra.our_finding = fv;
    }

    // Check the gates here first, so the answer is a list of what to fix
    // rather than one refusal at a time from the server.
    if (to === 'ready_to_ship' && !rolesKnown(unitId)) {
      set('Checking photos…', '');
      await loadRoles(unitId);
      if (openUnitId !== unitId || isStale(g)) return;
      if (!rolesKnown(unitId)) return set('Could not check the photos: ' + (rolesErr(unitId) || 'unknown error'), 'err');
    }
    var probs = gateCheck(augment(Object.assign({}, u, extra)), to, rolesFor(unitId));
    if (probs.length) return set('Not yet: ' + probs.join(' · '), 'err');

    var btn = el('rma-m-go');
    if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
    set('Moving…', '');
    try {
      // The MOVE is always the customer's business; the note carries its own
      // tick, so a candid bench remark is never published by accident.
      await data().moveRma(unitId, from, to, note || null, note ? visible : true, extra);
    } catch (e) {
      if (isStale(g)) return;
      if (openUnitId === unitId) {
        var stale = /\bNEO_STALE\b/.test(String((e && e.message) || ''));
        set('Could not move: ' + failText(e), 'err', stale ? refresh : null);
        var b3 = el('rma-m-go');
        if (b3) { b3.disabled = false; b3.textContent = 'Move'; }
      } else {
        toast('Could not move ' + (u.public_code || 'the part') + ': ' + errMsg(e), 'error');
      }
      return;
    }
    if (isStale(g)) return;
    toast((u.public_code || 'Part') + ' moved to ' + staffStage(to) + '.', 'success');
    if (screenActive()) renderView();
    if (openUnitId !== unitId) return;
    paintUnitHead();
    paintGates();
    paintActions();
    paintTabs();
    paintFee();
    paintMoveBox();
    if (to === 'ready_to_return' || to === 'returning') {
      var live = unitById(unitId);
      if (live && trackingPhone(live)) {
        set('Moved. Tell the customer?', 'ok', { label: 'Message on WhatsApp', fn: function () { dlgMessage(unitId, 'rma_ready'); } });
      }
    }
  }

  // ── Photos ──
  var UNIT_ROLES = ['condition', 'serial_label', 'invoice', 'damage', 'packing', 'unboxing', 'vendor_doc', 'return_condition'];
  function defaultRoleFor(u) {
    if (u.stage === 'with_vendor') return 'vendor_doc';
    if (u.stage === 'back_from_vendor' || u.stage === 'ready_to_return' || u.stage === 'returning') return 'return_condition';
    return 'condition';
  }
  function photosHtml(u) {
    var w = canDesk();
    return (w ? '<div class="rma-ph-add">' +
        '<div id="rma-u-tray" class="rma-tray-host"></div>' +
        '<div class="sv-actions"><button type="button" id="rma-u-upload" class="primary-pink-btn">Upload</button>' +
        '<span id="rma-u-upstatus" class="sv-status"></span></div>' +
        '<p class="sv-hint">Photos are private. The serial label photo and, for parts bought elsewhere, the invoice (a PDF is fine) or a warranty-check screenshot are what let a part ship. Invoices, serial labels and vendor documents are never shown to the customer.</p>' +
      '</div>' : '') +
      '<div id="rma-u-gallery" class="rma-gallery"><div class="sv-empty">Loading…</div></div>' +
      // Always drawn (hidden until there are rows): the part may be linked to
      // a ticket item after the panel opened.
      '<div id="rma-u-itemgal-wrap" class="rma-itemgal hidden">' +
        '<h4 class="rma-sec-title">From the ticket</h4>' +
        '<p class="sv-hint">Photos of this item taken on the service ticket. They count for shipping too; change or delete them on the ticket.</p>' +
        '<div id="rma-u-itemgal" class="rma-gallery"></div></div>';
  }
  // A ticket-item photo (NeoQcData.media marks it from_item) — or any row that
  // is not this part's own — is the ticket's, never this panel's to edit.
  function isItemPhoto(r, unitId) {
    return !!r && (r.from_item === true || String(r.rma_case_id == null ? '' : r.rma_case_id) !== String(unitId));
  }
  function mountUnitTray(u) {
    var host = el('rma-u-tray');
    var T = trays();
    if (!host) return;
    if (!T || typeof T.create !== 'function') {
      host.innerHTML = '<div class="sv-empty">The photo tray (photo-tray.js) is not loaded.</div>';
      return;
    }
    try {
      unitTray = T.create(host, { roles: UNIT_ROLES, defaultRole: defaultRoleFor(u), allowPdf: true, minPhotos: 0,
                                  label: 'Add photos or documents for ' + (u.public_code || 'this part') });
    } catch (e) {
      unitTray = null;
      host.innerHTML = '<div class="sv-empty">Could not start the photo tray: ' + esc(errMsg(e)) + '</div>';
    }
  }
  function progressText(done, total) {
    if (done == null || total == null) return 'Uploading…';
    return 'Uploading ' + Math.min(total, Number(done) + 1) + ' of ' + total + '…';
  }
  async function uploadUnitPhotos() {
    var unitId = openUnitId;                      // bound once — the whole point
    var g = sessionGen;
    var tray = unitTray;
    var u = unitById(unitId);
    var T = trays();
    var set = function (msg, k) { if (!isStale(g) && openUnitId === unitId && unitTab === 'photos') setStatusId('rma-u-upstatus', msg, k); };
    if (!u || !tray || !T) return;
    if (trayBusy) { set('Still uploading the last batch.', ''); return; }
    if (!photoCount(tray)) return set('Add a photo or document first.', 'err');
    trayBusy = true;
    trayUploading = tray;
    var btn = el('rma-u-upload');
    if (btn) btn.disabled = true;
    set('Uploading…', '');
    var res = null, thrown = null;
    try {
      var target = { caseId: unitId };
      if (u.service_item_id) target.itemId = u.service_item_id;
      res = await T.uploadAll(tray, target, function (done, total, info) {
        set(info && info.done ? 'Finishing…' : progressText(done, total), '');
      });
    } catch (e) {
      thrown = e;
    } finally {
      // After a sign-out endSession has already let go of these, and by now
      // they may be the next person's upload: leave them alone.
      if (!isStale(g)) {
        trayBusy = false;
        trayUploading = null;
        destroyRetiredTrays();
      }
    }
    forgetRoles(unitId);
    if (isStale(g)) return;                       // no toast, no history line, no repaint
    var ok = res && typeof res.ok === 'number' ? res.ok : 0;
    var failed = (res && res.failed) || [];
    if (ok) {
      try { await data().rmaNote(unitId, ok + ' photo' + (ok === 1 ? '' : 's') + ' added.', false); }
      catch (e) { /* the photos are safe; the history line is not worth a failure */ }
      if (isStale(g)) return;
    }
    // Still the tray on screen? Then anything that failed is still in it;
    // otherwise it was retired and the failed files went with it.
    var kept = unitTray === tray && openUnitId === unitId && unitTab === 'photos';
    var msg;
    if (thrown) msg = 'Upload failed: ' + failText(thrown) + (kept || isDemoErr(thrown) ? '' : ' Open its Photos tab and add them again.');
    else if (failed.length) msg = ok + ' uploaded, ' + failed.length + ' failed' + (failed[0] && failed[0].error ? ' (' + failed[0].error + ')' : '') +
      (kept ? '. They are still in the tray — press Upload to try again.' : '. Open its Photos tab and add them again.');
    else msg = ok + ' uploaded.';
    if (openUnitId === unitId && unitTab === 'photos') {
      var b2 = el('rma-u-upload');
      if (b2) b2.disabled = false;
      loadGallery(unitId);
    }
    if (kept) set(msg, (thrown || failed.length) ? 'err' : 'ok');
    else toast((u.public_code || 'Part') + ': ' + msg, (thrown || failed.length) ? 'error' : 'success');
    loadRoles(unitId).then(function () { if (openUnitId === unitId) paintGates(); });
  }
  async function loadGallery(unitId) {
    var seq = ++gallerySeq;
    var T = trays();
    try {
      var rows = normMedia(await data().media(mediaQuery(unitId)));
      if (seq !== gallerySeq || openUnitId !== unitId || unitTab !== 'photos') return;
      // Every row counts for the gate; only the part's own are this panel's
      // to edit. The item's (from_item: taken on the ticket) are the
      // ticket's, so they are shown read-only under "From the ticket" — no
      // delete, no customer-visible tick: a delete here would remove the
      // ticket's evidence and log it on the part.
      setRolesFromRows(unitId, rows);
      paintGates();
      var own = rows.filter(function (r) { return r && !isItemPhoto(r, unitId); });
      var fromItem = rows.filter(function (r) { return isItemPhoto(r, unitId); });
      var host = el('rma-u-gallery');
      if (!host) return;
      if (!T || typeof T.gallery !== 'function') { host.innerHTML = '<div class="sv-empty">The photo gallery (photo-tray.js) is not loaded.</div>'; return; }
      // Remarks and the "show customer" tick go through the data layer by
      // default (the gallery reports its own errors). Delete is bound to the
      // part the gallery was drawn for, never to whatever the panel shows
      // when the click finally lands.
      T.gallery(host, own, {
        editable: canDesk(),
        markRma: false,
        emptyText: fromItem.length ? 'No photos on this part itself yet.' : 'No photos yet.',
        onDelete: async function (row) {
          var g = sessionGen;
          if (isItemPhoto(row, unitId)) throw new Error('This photo belongs to the ticket. Delete it there.');
          await data().deleteMedia(row);
          if (isStale(g)) return;
          try { await data().rmaNote(unitId, 'A photo was deleted (' + mediaRole(row) + ').', false); } catch (e2) { /* not worth a failure */ }
          forgetRoles(unitId);
          loadRoles(unitId).then(function () { if (openUnitId === unitId && !isStale(g)) paintGates(); });
        }
      });
      var wrap = el('rma-u-itemgal-wrap'), ih = el('rma-u-itemgal');
      if (wrap && ih) {
        show(wrap, fromItem.length > 0);
        if (fromItem.length) T.gallery(ih, fromItem, { editable: false, markRma: false, emptyText: '' });
        else ih.innerHTML = '';
      }
    } catch (e) {
      if (seq !== gallerySeq || openUnitId !== unitId) return;
      var h2 = el('rma-u-gallery');
      if (h2) h2.innerHTML = '<div class="sv-empty">Could not load photos: ' + esc(errMsg(e)) + '</div>';
    }
  }

  // ── History ──
  var EVENT_KIND = { stage: 'Stage', note: 'Note', edit: 'Edit', media: 'Photos', fee: 'Fee', link: 'Ticket', system: 'System' };
  function historyHtml() {
    return (canDesk() ? '<div class="sv-noteadd">' +
        '<textarea id="rma-h-body" rows="3" placeholder="What did you find? What did the vendor say?"></textarea>' +
        '<label class="sv-check"><input type="checkbox" id="rma-h-visible"> The customer can see this note</label>' +
        '<div class="sv-actions"><button type="button" id="rma-h-add" class="primary-pink-btn">Add note</button>' +
        '<span id="rma-h-status" class="sv-status"></span></div>' +
        '<p class="sv-hint">Notes are internal by default. Tick the box for anything the customer should read on their tracking page.</p>' +
      '</div>' : '') +
      '<div id="rma-h-timeline" class="sv-timeline rma-timeline"><div class="sv-empty">Loading…</div></div>';
  }
  async function loadTimeline(unitId) {
    var seq = ++timelineSeq;
    try {
      var rows = await data().rmaEvents(unitId);
      if (seq !== timelineSeq || openUnitId !== unitId || unitTab !== 'history') return;
      var host = el('rma-h-timeline');
      if (!host) return;
      var list = (Array.isArray(rows) ? rows : []).slice()
        .sort(function (a, b) { return (ms(b.at) || 0) - (ms(a.at) || 0); });
      host.innerHTML = list.length ? list.map(function (e) {
        var moved = e.from_stage || e.to_stage;
        return '<div class="sv-ev' + (e.customer_visible ? ' shown' : '') + '">' +
          '<div class="sv-ev-top"><span class="sv-ev-when">' + esc(fmtDateTime(e.at)) + '</span>' +
            '<span class="rma-ev-kind">' + esc(EVENT_KIND[e.kind] || e.kind || 'Note') + '</span>' +
            '<span class="sv-ev-who">' + esc(e.actor_name || e.actor_email || (e.actor_kind === 'system' ? 'System' : '—')) + '</span></div>' +
          (moved ? '<div class="sv-ev-move">' + esc((e.from_stage ? staffStage(e.from_stage) : '—') + ' → ' + (e.to_stage ? staffStage(e.to_stage) : '—')) + '</div>' : '') +
          (e.body ? '<div class="sv-ev-body">' + esc(e.body) + '</div>' : '') +
          '<div class="sv-ev-tag' + (e.customer_visible ? '' : ' is-internal') + '">' + (e.customer_visible ? 'Customer can see this' : 'Internal only') + '</div>' +
        '</div>';
      }).join('') : '<div class="sv-empty">No history yet.</div>';
    } catch (e) {
      if (seq !== timelineSeq || openUnitId !== unitId) return;
      var h2 = el('rma-h-timeline');
      if (h2) h2.innerHTML = '<div class="sv-empty">Could not load the history: ' + esc(errMsg(e)) + '</div>';
    }
  }
  async function addHistoryNote() {
    var unitId = openUnitId;                      // bound once
    var g = sessionGen;
    var set = function (msg, k) { if (openUnitId === unitId && !isStale(g)) setStatusId('rma-h-status', msg, k); };
    var ta = el('rma-h-body');
    var body = String((ta || {}).value || '').trim();
    if (!body) return set('Write something first.', 'err');
    var visible = !!(el('rma-h-visible') || {}).checked;
    var btn = el('rma-h-add');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await data().rmaNote(unitId, body, visible);
      // Cleared only AFTER it is known to have saved: a failed insert must not
      // destroy the only copy of what the technician wrote.
      if (openUnitId === unitId && !isStale(g)) {
        var t2 = el('rma-h-body'); if (t2) t2.value = '';
        var c2 = el('rma-h-visible'); if (c2) c2.checked = false;
        set(visible ? 'Added — the customer will see this.' : 'Added as an internal note.', 'ok');
        loadTimeline(unitId);
      }
    } catch (e) {
      set('Could not save that note — it is still here. ' + failText(e), 'err');
    } finally {
      var b2 = el('rma-h-add');
      if (b2 && openUnitId === unitId && !isStale(g)) { b2.disabled = false; b2.textContent = 'Add note'; }
    }
  }

  // ── Ticket ──
  function ticketHtml(u) {
    var m = model();
    var job = jobOf(u);
    if (!job) {
      return '<div class="rma-ticket"><p class="sv-hint">This part is linked to a service ticket that is not loaded on this machine' +
             (canService() ? ' (it may have closed more than two days ago).' : ' — you do not have access to the service module.') + '</p></div>';
    }
    var stageLabel = '', sentence = '';
    try { stageLabel = m.staffLabel(job.stage); } catch (e) { stageLabel = job.stage; }
    try { sentence = m.waitingSentence(job); } catch (e) { sentence = ''; }
    var others = unitsOfJob(job.id).filter(function (x) { return x.id !== u.id; });
    return '<div class="rma-ticket">' +
      '<div class="sv-fields">' +
        fact('Ticket', job.public_code || '—') +
        fact('Customer', job.customer_name || '—') +
        fact('Device', job.device_label || '—') +
        fact('Stage', stageLabel) +
        fact('Technician', job.assignee || 'In the queue') +
        fact('This part', !(u.holds_ticket && u.stage !== 'closed') ? 'Does not hold the ticket'
          : job.stage === 'closed' ? 'Still marked as holding it, but the ticket is closed — release it and the part goes on by itself'
          : 'Holds the ticket — it follows this part automatically') +
      '</div>' +
      (sentence ? '<p class="rma-ticket-sentence">' + esc(sentence) + '</p>' : '') +
      '<h4 class="rma-sec-title">Other parts on this ticket</h4>' +
      (others.length ? '<div class="rma-ticket-units">' + others.map(function (x) {
        return '<div class="rma-ticket-unit"><span class="sv-code">' + esc(x.public_code || '') + '</span>' +
          '<span>' + esc(kindLabel(x.kind) + ' · ' + brandModel(x)) + '</span>' +
          '<span class="rma-pill">' + esc(staffStage(x.stage)) + (x.holds_ticket && x.stage !== 'closed' ? ' · holds' : '') + '</span>' +
          '<button type="button" class="rma-linkbtn" data-open-unit="' + esc(x.id) + '">Open</button></div>';
      }).join('') + '</div>' : '<p class="sv-hint">None.</p>') +
      (canService() ? '<div class="sv-actions"><button type="button" class="primary-pink-btn" data-act="open-ticket">Open ticket</button></div>' : '') +
    '</div>';
  }

  // A linked ticket older than the caches' two-day window is fetched on
  // purpose (once per ticket per session), then the tab repaints if it is
  // still the one on screen.
  var ticketFetched = {};
  function fetchTicketOnce(u) {
    var unitId = u.id, jobId = u.service_job_id;
    var d = data();
    if (!jobId || jobById(jobId) || !canService() || !d || typeof d.fetchJob !== 'function' || ticketFetched[jobId]) return;
    ticketFetched[jobId] = true;
    Promise.resolve().then(function () { return d.fetchJob(jobId); }).then(function () {
      if (openUnitId === unitId && unitTab === 'ticket' && jobById(jobId)) { paintTab(); paintUnitHead(); }
    }, function () { /* the tab already says the ticket is not loaded here */ });
  }

  async function openTicket(jobId) {
    if (!jobId) return;
    var g = sessionGen;
    if (!canService()) { toast('You do not have access to the service module.', 'warning'); return; }
    var closed = await closeUnit(false);
    if (!closed || isStale(g)) return;
    var d = data();
    if (d && !jobById(jobId) && typeof d.fetchJob === 'function') {
      try { await d.fetchJob(jobId); } catch (e) { /* openJob reports a miss itself */ }
      if (isStale(g)) return;                     // never switch screens over the login form
    }
    if (window.NeoQcShell && typeof window.NeoQcShell.goSection === 'function') window.NeoQcShell.goSection('service');
    else if (typeof switchScreen === 'function') switchScreen('service');
    if (window.NeoQcServiceUI && typeof window.NeoQcServiceUI.openJob === 'function') {
      try { await window.NeoQcServiceUI.openJob(jobId); } catch (e) { toast('Could not open the ticket: ' + errMsg(e), 'error'); }
    }
  }

  // ── panel wiring ──
  function bindPanel() {
    var close = el('rma-unit-close');
    if (close && !close.dataset.rmaBound) {
      close.dataset.rmaBound = '1';
      close.addEventListener('click', function () { closeUnit(false); });
    }
    var root = el('rma-unit-root');
    if (!root || root.dataset.rmaBound) return;
    root.dataset.rmaBound = '1';
    root.addEventListener('click', function (e) {
      var t = e.target;
      var tab = t.closest('.sv-tab');
      if (tab && tab.getAttribute('data-tab')) { switchTab(tab.getAttribute('data-tab')); return; }
      if (t.closest('#rma-u-save')) { saveDetails(); return; }
      if (t.closest('#rma-m-go')) { doMove(); return; }
      if (t.closest('#rma-h-add')) { addHistoryNote(); return; }
      if (t.closest('#rma-u-upload')) { uploadUnitPhotos(); return; }
      var open = t.closest('[data-open-unit]');
      if (open) { openUnit(open.getAttribute('data-open-unit')); return; }
      var lb = t.closest('[data-link-build]');
      if (lb) {
        var bi = el(fid('build_ticket_id')), ps = el(fid('purchase_source'));
        if (bi) bi.value = lb.getAttribute('data-link-build');
        if (ps) ps.value = 'neo_tokyo';
        var hint = el('rma-u-buildhint');
        if (hint) hint.innerHTML = '<div class="rma-build-hint is-linked">Linked to build #' + esc(lb.getAttribute('data-build-code') || '') + ' — press Save changes to keep it.</div>';
        return;
      }
      var a = t.closest('[data-act]');
      if (!a) return;
      var act = a.getAttribute('data-act');
      var u = unitById(openUnitId);
      if (!u) return;
      switch (act) {
        case 'claim': claimUnit(); break;
        case 'receive': dlgReceive(); break;
        case 'dispatch': dlgDispatchOne(); break;
        case 'vendor-result': dlgVendorResult(); break;
        case 'paid-repair': dlgPaidRepair(); break;
        case 'stock-replace': dlgStockReplace(); break;
        case 'release': dlgRelease(); break;
        case 'message': dlgMessage(u.id, templateForStage(u.stage)); break;
        case 'copy-link': copyText(TRACK_URL + encodeURIComponent(u.public_code || ''), 'Tracking link'); break;
        case 'print-label': printLabels([labelFromUnit(u)]); break;
        case 'fee-quote': dlgFee('quote'); break;
        case 'fee-accept': dlgFee('accept'); break;
        case 'fee-paid': dlgFee('paid'); break;
        case 'fee-waive': dlgFee('waive'); break;
        case 'add-vendor-pick': addVendorIntoSelect(); break;
        case 'open-ticket': openTicket(u.service_job_id); break;
        case 'open-followup': openTicket(u.followup_job_id); break;
        default: break;
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'rma-m-stage') {
        var u = unitById(openUnitId);
        var extra = el('rma-m-extra');
        if (extra && u) extra.innerHTML = t.value ? moveExtrasHtml(u, t.value) : '';
        var go = el('rma-m-go');
        if (go) go.disabled = !t.value;
        setStatusId('rma-m-status', '', '');
      }
    });
    root.addEventListener('input', function (e) {
      if (e.target && e.target.id === fid('serial')) onDetailsSerialInput();
    });
    root.addEventListener('keydown', enterGuard);
  }

  async function addVendorIntoSelect() {
    var unitId = openUnitId;
    var id = await dlgAddVendor();
    if (id == null || openUnitId !== unitId) return;
    var sel = el(fid('vendor_id'));
    if (!sel) return;
    var v = vendorById(id);
    if (!Array.prototype.some.call(sel.options, function (o) { return o.value === String(id); })) {
      var o = document.createElement('option');
      o.value = String(id);
      o.textContent = vendorName(v) || 'New vendor';
      sel.appendChild(o);
    }
    sel.value = String(id);
    setStatusId('rma-u-status', 'Vendor added — press Save changes to set it on this part.', '');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ACTIONS AND DIALOGS
  //  Dialog titles are fixed wording; untrusted text (names, vendors) goes in
  //  the body through esc().
  // ══════════════════════════════════════════════════════════════════════════
  function repaintAfterWrite(unitId) {
    if (screenActive()) renderView();
    if (!unitId || openUnitId !== unitId) return;
    paintUnitHead();
    paintGates();
    paintActions();
    paintTabs();
    if (unitTab === 'details') {
      paintFee();
      if (moveBoxPristine()) paintMoveBox();
    } else if (unitTab === 'ticket') {
      paintTab();
    }
  }

  async function claimUnit() {
    var unitId = openUnitId;                      // bound once
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u) return;
    var btn = document.querySelector('#rma-u-actions [data-act="claim"]');
    if (btn) btn.disabled = true;
    var r = null, err = null;
    try { r = await data().claimRma(unitId); } catch (e) { err = e; }
    if (isStale(g)) return;
    if (err) toast('Could not claim it: ' + failText(err), 'error');
    else if (r && r.ok === false) toast('Already taken' + (r.by ? ' by ' + r.by : '') + '.', 'warning');
    else toast('You are handling ' + (u.public_code || 'this part') + ' now.', 'success', 2500);
    repaintAfterWrite(unitId);
  }

  // SPEC-AMENDMENTS A21: the custody check when a part we were expecting (or
  // that our technician was holding) reaches the shop — condition first,
  // photos, and an honest note when there are none.
  async function dlgReceive() {
    var unitId = openUnitId;
    var g = sessionGen;
    var who = myName();                           // the person at the counter now
    var u = unitById(unitId);
    if (!u || !canReceive(u)) return;
    var fromStage = u.stage;
    var c = catalog();
    var condOpts = ((c && c.CONDITION_CHIPS) || ['No visible damage', 'Scratches', 'Dents', 'Seal broken']).map(function (x) { return { value: x, label: x }; });
    var received = false, tray = null;
    var body = dlgBody(
      '<p>Mark <strong>' + esc(u.public_code || '') + '</strong> (' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) + ') as received at the shop.</p>' +
      '<div class="sv-field"><span>Condition on arrival</span>' + chipsHtml('cond', condOpts, [], { multi: true, label: 'Condition on arrival' }) + '</div>' +
      dfield('Note (optional)', 'note', '', { textarea: true, wide: true, placeholder: 'e.g. Box arrived sealed, part wrapped in bubble wrap' }) +
      '<div class="rma-dlg-tray"></div>');
    var ok = await openDialog({
      title: 'Mark received', body: body, okText: 'Mark received', wide: true,
      onOpen: function () {
        var host = body.querySelector('.rma-dlg-tray');
        var T = trays();
        if (host && T && typeof T.create === 'function') {
          try { tray = T.create(host, { roles: ['condition', 'damage', 'serial_label', 'unboxing', 'packing'], defaultRole: 'condition', allowPdf: false, minPhotos: 0, label: 'Photos of the part as it arrived' }); }
          catch (e) { tray = null; }
        }
      },
      onOk: async function () {
        if (!received) {
          var live = unitById(unitId);
          if (!live || live.stage !== fromStage) return 'This part has moved on since — close this and look again.';
          var noPhotos = !photoCount(tray);
          if (noPhotos) {
            var go = await confirmBox('No photos of the part. Photos are the proof of how it arrived. Accept without photos?',
                                      { title: 'No photos', okText: 'Accept without photos' });
            if (!go || isStale(g)) return false;
          }
          var note = fval(body, 'note') || null;
          // rma_receive takes both arrivals — logged (expected) and with_tech
          // (A8, our technician brought it back) — writes the customer's
          // standard "arrived / at our counter" line, and keeps this note
          // internal. rma_move would publish the note as the customer-visible
          // stage line instead, so it is never used for this step.
          try { await data().receiveRma([unitId], note); }
          catch (e) { return isStale(g) ? false : failText(e); }
          received = true;
          if (isStale(g)) return false;           // signed out meanwhile: no more writes
          var cond = readChip(body, 'cond') || [];
          var notes = [];
          if (cond.length) notes.push('Condition on arrival: ' + cond.join(', ') + '.');
          if (noPhotos) notes.push('Accepted without photos by ' + who + '.');
          if (notes.length) { try { await data().rmaNote(unitId, notes.join(' '), false); } catch (e) { /* the receive stands */ } }
          if (isStale(g)) return false;
        }
        if (photoCount(tray)) {
          var r;
          try { r = await trays().uploadAll(tray, { caseId: unitId }, function () {}); }
          catch (e) { return 'Received. The photos did not upload (' + failText(e) + ') — press Mark received to retry them, or Cancel to skip.'; }
          forgetRoles(unitId);
          if (r && r.failed && r.failed.length) {
            return 'Received. ' + r.failed.length + ' photo' + (r.failed.length === 1 ? '' : 's') + ' did not upload — press Mark received to retry, or Cancel to skip.';
          }
        }
        return true;
      }
    });
    if (tray) { try { tray.destroy(); } catch (e) { /* gone */ } }
    if (received && !isStale(g)) {
      toast((u.public_code || 'Part') + ' marked received.', ok ? 'success' : 'info');
      forgetRoles(unitId);
      repaintAfterWrite(unitId);
      if (openUnitId === unitId) loadRoles(unitId).then(function () { if (openUnitId === unitId) paintGates(); });
    }
  }

  function dlgDispatchOne() {
    var unitId = openUnitId;
    var u = unitById(unitId);
    if (!u) return;
    dlgDispatch([unitId], u.vendor_id != null ? String(u.vendor_id) : '');
  }

  // One dialog for the ship view (many parts, one vendor) and the panel (one
  // part, vendor choosable here if it has none yet).
  async function dlgDispatch(ids, vendorKey) {
    var units = ids.map(unitById).filter(Boolean);
    if (!units.length) return false;
    var panelUnitId = openUnitId;
    var g = sessionGen;
    // Fresh photo roles for every part going in the parcel.
    await Promise.all(units.map(function (u) { return rolesStale(u.id) ? loadRoles(u.id) : Promise.resolve(); }));
    if (isStale(g)) return false;                 // never a dialog on the login screen
    var problemsOf = function (u, vk) {
      return gateCheck(augment(Object.assign({}, u, vk ? { vendor_id: vk } : {})), 'ready_to_ship', rolesFor(u.id));
    };
    var v = vendorById(vendorKey);
    var body = dlgBody(
      (v ? '<p>Sending ' + units.length + ' part' + (units.length === 1 ? '' : 's') + ' to <strong>' + esc(vendorName(v)) + '</strong>. ' +
            'Their tracking pages will say the part is with the manufacturer.</p>'
         : '<p>Choose where this part is going.</p>' +
           '<label class="sv-field"><span>Vendor</span><select data-f="vendor" class="settings-select">' + vendorOptions(null, 'Choose a vendor…') + '</select></label>') +
      '<ul class="rma-dlg-list">' + units.map(function (u) {
        return '<li><span class="sv-code">' + esc(u.public_code || '') + '</span> ' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) +
               (u.serial ? ' · ' + esc(u.serial) : '') + '</li>';
      }).join('') + '</ul>' +
      '<div class="sv-field"><span>How is it going?</span>' + chipsHtml('mode', SHIP_MODES, 'courier', { label: 'How is it going' }) + '</div>' +
      '<div class="sv-grid">' +
        dfield('Courier', 'courier', '', { placeholder: 'e.g. DTDC, Blue Dart', wrapAttrs: ' data-modes="courier bus_parcel"' }) +
        dfield('AWB / tracking no.', 'awb', '', { wrapAttrs: ' data-modes="courier bus_parcel"' }) +
        dfield('Who carried it', 'carried', '', { placeholder: 'Name of the person', wrapAttrs: ' data-modes="hand_delivery vendor_pickup"' }) +
        dfield('Shipping cost (optional)', 'cost', '', { type: 'number', attrs: ' min="0" step="1" inputmode="decimal"' }) +
        dfield('Note (optional)', 'note', '', { textarea: true, wide: true }) +
      '</div>');
    var syncMode = function () {
      var mode = readChip(body, 'mode') || 'courier';
      Array.prototype.forEach.call(body.querySelectorAll('[data-modes]'), function (x) {
        show(x, x.getAttribute('data-modes').split(' ').indexOf(mode) !== -1);
      });
      var awbLab = (fel(body, 'awb') || {}).parentNode;
      if (awbLab && awbLab.firstChild) awbLab.firstChild.textContent = mode === 'bus_parcel' ? 'Parcel receipt no. (optional)' : 'AWB / tracking no.';
      var carLab = (fel(body, 'carried') || {}).parentNode;
      if (carLab && carLab.firstChild) carLab.firstChild.textContent = mode === 'vendor_pickup' ? 'Who collected it' : 'Who carried it';
    };
    body.addEventListener('ops-chip-change', syncMode);
    syncMode();
    var ok = await openDialog({ title: 'Dispatch to the vendor', body: body, okText: 'Dispatch', onOk: async function () {
      var vk = vendorKey;
      if (!v) {
        vk = fval(body, 'vendor');
        if (!vk) return 'Choose a vendor.';
      }
      var mode = readChip(body, 'mode') || 'courier';
      var courier = fval(body, 'courier'), awb = fval(body, 'awb'), carried = fval(body, 'carried'), note = fval(body, 'note');
      if (mode === 'courier' && !awb) return 'Enter the AWB from the courier slip.';
      if (mode === 'courier' && !courier) return 'Say which courier.';
      if (mode !== 'courier' && !carried && !note) return mode === 'bus_parcel' ? 'Add a note — which bus, or who sent it.' : 'Say who carried it, or add a note.';
      var cost = parseMoney(fval(body, 'cost'));
      if (cost !== null && (isNaN(cost) || cost < 0)) return 'The shipping cost should be a number, or leave it blank.';
      var stale = ids.map(unitById).filter(function (u) { return !u || u.stage !== 'ready_to_ship'; });
      if (stale.length) return 'Something changed: ' + stale.map(function (u) { return u ? u.public_code : 'a part'; }).join(', ') + ' is no longer ready to ship. Close this and check the list.';
      var blocked = ids.map(unitById).filter(function (u) { return problemsOf(u, vk).length; });
      if (blocked.length) return blocked[0].public_code + ': ' + problemsOf(blocked[0], vk).join(' · ');
      try {
        await data().dispatchRma(ids, {
          vendorId: vk, mode: mode,
          courier: (mode === 'courier' || mode === 'bus_parcel') ? (courier || null) : null,
          awb: (mode === 'courier' || mode === 'bus_parcel') ? (awb || null) : null,
          carriedBy: (mode === 'hand_delivery' || mode === 'vendor_pickup') ? (carried || null) : null,
          cost: cost, note: note || null
        });
      } catch (e) { return failText(e); }
      vendorKey = vk;
      return true;
    } });
    if (ok && !isStale(g)) {
      ids.forEach(function (id) { delete shipSel[id]; });
      toast('Sent ' + ids.length + ' part' + (ids.length === 1 ? '' : 's') + ' to ' + (vendorName(vendorById(vendorKey)) || 'the vendor') + '.', 'success');
      repaintAfterWrite(panelUnitId);
    }
    return ok;
  }

  async function dlgVendorResult() {
    var unitId = openUnitId;
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u) return;
    var v = vendorOf(u);
    var body = dlgBody(
      '<p><strong>' + esc(u.public_code || '') + '</strong> · ' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) +
        (v ? ' · with ' + esc(vendorName(v)) : '') + '</p>' +
      '<div class="sv-field"><span>What did the vendor do?</span>' +
        chipsHtml('result', RESULT_KEYS.map(function (k) { return { value: k, label: resultLabel(k) }; }), null, { label: 'Vendor result' }) + '</div>' +
      '<div class="sv-grid">' +
        dfield('Replacement serial', 'rserial', '', { wide: true, wrapAttrs: ' data-results="replaced shipped_to_customer"', placeholder: 'As printed on the new part’s label' }) +
        dfield('Vendor’s reason or remarks (optional)', 'reason', '', { textarea: true, wide: true }) +
        dfield('Return courier (optional)', 'courier', '', { wrapAttrs: ' data-results="replaced repaired credit_note rejected shipped_to_customer"' }) +
        dfield('Return AWB (optional)', 'awb', '', { wrapAttrs: ' data-results="replaced repaired credit_note rejected shipped_to_customer"' }) +
        dfield('Note (optional)', 'note', '', { textarea: true, wide: true }) +
      '</div>' +
      '<p class="sv-hint" data-results="lost">A lost part goes to “Waiting on customer decision” so we can agree a settlement with them.</p>' +
      '<p class="sv-hint" data-results="shipped_to_customer">It goes to “Returning” — close it once the customer confirms it arrived.</p>');
    var sync = function () {
      var r = readChip(body, 'result');
      Array.prototype.forEach.call(body.querySelectorAll('[data-results]'), function (x) {
        show(x, !!r && x.getAttribute('data-results').split(' ').indexOf(r) !== -1);
      });
      var lab = (fel(body, 'reason') || {}).parentNode;
      if (lab && lab.firstChild) lab.firstChild.textContent = (r === 'rejected' || r === 'lost') ? 'Vendor’s reason (required)' : 'Vendor’s reason or remarks (optional)';
      var rl = (fel(body, 'rserial') || {}).parentNode;
      if (rl && rl.firstChild) rl.firstChild.textContent = r === 'replaced' ? 'Replacement serial' : 'Replacement serial (if known)';
    };
    body.addEventListener('ops-chip-change', sync);
    sync();
    var ok = await openDialog({ title: 'Record the vendor result', body: body, okText: 'Record', onOk: async function () {
      var r = readChip(body, 'result');
      if (!r) return 'Pick what the vendor did.';
      var rs = fval(body, 'rserial'), reason = fval(body, 'reason');
      // SPEC-GAP: a rejection or a loss needs its reason on record — it is
      // what the customer reads and what a lead argues with the vendor over.
      if ((r === 'rejected' || r === 'lost') && !reason) return 'Write the vendor’s reason.';
      if (r === 'replaced' && !rs) return 'Enter the replacement part’s serial.';
      var live = unitById(unitId);
      if (!live || live.stage !== 'with_vendor') return 'This part is no longer with the vendor — someone already recorded it. Close this and look again.';
      var withSerial = r === 'replaced' || r === 'shipped_to_customer';
      try {
        await data().vendorResult(unitId, r, reason || null, withSerial ? (rs || null) : null,
          r === 'lost' ? null : (fval(body, 'courier') || null), r === 'lost' ? null : (fval(body, 'awb') || null),
          fval(body, 'note') || null);
      } catch (e) { return failText(e); }
      return true;
    } });
    if (ok && !isStale(g)) {
      toast((u.public_code || 'Part') + ': vendor result recorded.', 'success');
      repaintAfterWrite(unitId);
    }
  }

  async function dlgFee(mode) {
    var unitId = openUnitId;
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u) return;
    if (mode === 'waive' && !isLead()) { toast('Only a lead can waive a fee.', 'warning'); return; }
    // ₹0 on record: "accepted" or "paid" would send a zero fee, which the
    // server refuses (see feeAmountZero). The only way on is a lead's waiver.
    var zeroWaiver = false;
    if ((mode === 'accept' || mode === 'paid') && feeAmountZero(u)) {
      if (!isLead()) { toast(ZERO_FEE_DESK, 'warning'); return; }
      mode = 'waive';
      zeroWaiver = true;
    }
    var c = catalog();
    var dflt = u.handling_fee != null ? Number(u.handling_fee)
      : ((c && typeof c.handlingFee === 'function') ? c.handlingFee(u.kind) : ((c && c.DEFAULT_HANDLING_FEE) || 300));
    if (!isFinite(dflt) || dflt < 0) dflt = 0;
    var head = '<p><strong>' + esc(u.public_code || '') + '</strong> · ' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) + '</p>';
    var html, title, okText;
    if (mode === 'quote') {
      title = 'Handling fee'; okText = 'Save fee';
      html = head + '<div class="sv-grid">' +
        dfield('Amount (₹)', 'amount', dflt > 0 ? dflt : '', { type: 'number', attrs: ' min="1" step="1" inputmode="decimal"' }) +
        dfield('Note (optional)', 'note', '', { textarea: true, wide: true }) + '</div>' +
        '<p class="sv-hint">A paid handling service for a part bought elsewhere. The customer has to accept it before the part can ship.</p>';
    } else if (mode === 'accept') {
      title = 'Customer accepted the fee'; okText = 'Customer accepted';
      html = head + '<p>The customer agreed to pay ' + esc(fmtINR(dflt)) + ' for handling this claim.</p>' +
        dfield('How did they agree? (optional)', 'note', '', { textarea: true, wide: true, placeholder: 'e.g. On WhatsApp, 21 Oct' });
    } else if (mode === 'paid') {
      title = 'Mark the fee paid'; okText = 'Mark paid';
      html = head + '<div class="sv-grid">' +
        dfield('Amount paid (₹)', 'amount', dflt > 0 ? dflt : '', { type: 'number', attrs: ' min="1" step="1" inputmode="decimal"' }) +
        dfield('Bill no.', 'ref', '', { placeholder: 'The bill number from the counter' }) +
        dfield('Note (optional)', 'note', '', { textarea: true, wide: true }) + '</div>';
    } else {
      title = 'Waive the fee'; okText = 'Waive fee';
      html = head +
        (zeroWaiver ? '<p>The fee on record is ₹0. A zero fee is a waiver, so it is recorded as one — with your name and your reason.</p>'
                    : '<p>' + (dflt > 0 ? 'Waive the ' + esc(fmtINR(dflt)) + ' handling fee.' : 'Waive the handling fee.') + ' This is recorded with your name.</p>') +
        dfield('Why? (required)', 'note', '', { textarea: true, wide: true });
    }
    var body = dlgBody(html);
    var ok = await openDialog({ title: title, body: body, okText: okText, danger: mode === 'waive', onOk: async function () {
      var amount = dflt, ref = null, note = fval(body, 'note') || null, status;
      if (mode === 'quote' || mode === 'paid') {
        amount = parseMoney(fval(body, 'amount'));
        // ₹0 is a waiver, never a quote or a payment (rma_set_fee refuses it).
        if (amount === 0) {
          if ((u.fee_status || 'n_a') === 'n_a') return 'A zero fee means no fee — close this to leave it at none, or enter the amount in rupees.';
          return isLead() ? ZERO_FEE_LEAD : ZERO_FEE_DESK;
        }
        if (amount === null || isNaN(amount) || amount <= 0) return 'Enter the amount in rupees.';
      } else if (mode === 'accept' && !(amount > 0)) {
        return isLead() ? ZERO_FEE_LEAD : ZERO_FEE_DESK;
      }
      if (mode === 'quote') status = 'quoted';
      else if (mode === 'accept') status = 'accepted';
      else if (mode === 'paid') {
        status = 'paid';
        ref = fval(body, 'ref');
        if (!ref) return 'Enter the bill number — it is how the fee is traced to the counter.';
      } else {
        status = 'waived';
        if (!note) return 'Say why the fee is waived.';
      }
      try { await data().setFee(unitId, amount, status, ref, note); } catch (e) { return failText(e); }
      return true;
    } });
    if (ok && !isStale(g)) {
      toast({ quote: 'Fee saved.', accept: 'Fee accepted.', paid: 'Fee marked paid.', waive: 'Fee waived.' }[mode], 'success', 2500);
      repaintAfterWrite(unitId);
    }
  }

  // SPEC-AMENDMENTS A5: releasing moves the ticket on and says how the part
  // goes back later. Where the ticket may go follows rma_release_hold's own
  // rule: an in-store ticket (and every v1 ticket) goes to 'ready' (outcome
  // returned_rma_pending — the customer takes the machine) or back to the
  // bench ('in_service'); an on-site ticket goes to 'work_done' or
  // 'revisit_needed'.
  var RELEASE_IN_STORE = [
    { key: 'ready', to: 'ready', outcome: 'returned_rma_pending', label: 'Ready to collect — the customer takes the machine, the part follows later' },
    { key: 'bench', to: 'in_service', outcome: null, label: 'Back on the bench — we carry on with the machine' }
  ];
  var RELEASE_ON_SITE = [
    { key: 'work_done', to: 'work_done', outcome: null, label: 'Work done — the visit is finished, the part follows later' },
    { key: 'revisit', to: 'revisit_needed', outcome: null, label: 'Follow-up visit — we go back once the part is ready' }
  ];
  // A closed ticket: no ticket target (to: null), so only the part is let go
  // and the ticket stays closed (NeoQcData.releaseHold accepts null).
  var RELEASE_CLOSED = [
    { key: 'part_only', to: null, outcome: null, label: 'Release the part — it continues on its own' }
  ];
  // 'in_store' | 'on_site', or null when the ticket cannot be read here (an
  // RMA-only role cannot read service_jobs).
  function releaseType(job) {
    if (!job) return null;
    var m = model();
    var v2 = m && typeof m.isV2 === 'function' ? m.isV2(job) : Number(job.model_version) >= 2;
    return v2 && job.service_type === 'on_site' ? 'on_site' : 'in_store';
  }
  async function dlgRelease() {
    var unitId = openUnitId;
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u || !isHolding(u)) return;
    var job = jobOf(u);
    var d = data();
    if (!job && canService() && d && typeof d.fetchJob === 'function') {
      // Older than the caches' window: read it on purpose, then make sure the
      // panel still shows the same part before building anything from it.
      try { job = await d.fetchJob(u.service_job_id); } catch (e) { job = null; }
      if (openUnitId !== unitId || isStale(g)) return;
      u = unitById(unitId);
      if (!u || !isHolding(u)) return;
      job = jobOf(u) || job;
    }
    var type = releaseType(job);
    // A closed ticket stays closed. A6 closes a ticket while some held parts
    // stay open (lost, waiting on the customer, a fee to settle); releasing
    // one only lets the part go on by itself, so nothing about the machine is
    // asked and no ticket target is sent: the one choice is the part itself.
    var closedJob = !!(job && job.stage === 'closed');
    // Not readable: offer all four and let the server's NEO_GATE sentence
    // name the pair that fits, rather than guess and offer only moves that fail.
    var choices = closedJob ? RELEASE_CLOSED : type === 'on_site' ? RELEASE_ON_SITE : type === 'in_store' ? RELEASE_IN_STORE : RELEASE_IN_STORE.concat(RELEASE_ON_SITE);
    // Every other part the ticket is waiting on: the ticket cannot move on
    // while any of them still holds it, so they are offered (ticked) too. A
    // closed ticket is waiting on nothing, so only this part is released.
    var siblings = closedJob ? [] : unitsOfJob(u.service_job_id).filter(function (x) { return x.id !== u.id && isHolding(x); });
    var it = intakeOf(u) || {};
    var addr = u.return_address || it.return_address || '';
    var body = dlgBody(
      (closedJob
        ? '<p>The ticket ' + esc(job.public_code || '') + ' is closed — the customer has the machine. Release <strong>' + esc(u.public_code || '') +
          '</strong> and the part carries on by itself; the ticket stays closed.</p>' +
          '<div class="sv-field"><span>What happens now?</span>' +
            chipsHtml('jobto', choices.map(function (c) { return { value: c.key, label: c.label }; }), choices[0].key, { label: 'What happens now' }) +
          '</div>'
        : '<p>' + (job && job.public_code ? 'The ticket ' + esc(job.public_code) : 'Its ticket') + ' is waiting for <strong>' + esc(u.public_code || '') +
          '</strong>. Release it, and the part carries on by itself.</p>' +
          '<div class="sv-field"><span>What happens to the machine now?</span>' +
            chipsHtml('jobto', choices.map(function (c) { return { value: c.key, label: c.label }; }), type ? choices[0].key : null, { label: 'What happens to the machine' }) +
            (type ? '' : '<p class="sv-hint">The ticket could not be read here, so all four are shown: the first two are for a machine at the shop, the last two for an on-site visit. If the ticket is already closed, it stays closed whichever you pick.</p>') +
          '</div>') +
      (siblings.length ? '<div class="sv-field"><span>Other parts this ticket is waiting on</span>' +
        siblings.map(function (x) {
          return '<label class="sv-check"><input type="checkbox" data-sib="' + esc(x.id) + '" checked> ' +
                 esc((x.public_code || '') + ' · ' + kindLabel(x.kind) + ' · ' + brandModel(x) + ' · ' + staffStage(x.stage)) + '</label>';
        }).join('') +
        '<p class="sv-hint">The ticket can only move on once nothing still holds it.</p></div>' : '') +
      '<div class="sv-field"><span>How does the part go back when it is done?</span>' +
        chipsHtml('partret', [{ value: 'collect', label: 'Customer collects it' }, { value: 'courier', label: 'Courier it to them' }], 'collect', { label: 'How the part goes back' }) + '</div>' +
      dfield('Return address', 'addr', addr, { textarea: true, wide: true, wrapAttrs: ' data-ret="courier"' }) +
      dfield('Note (optional)', 'note', '', { textarea: true, wide: true }));
    var syncRet = function () { var r = readChip(body, 'partret'); Array.prototype.forEach.call(body.querySelectorAll('[data-ret]'), function (x) { show(x, r === 'courier'); }); };
    body.addEventListener('ops-chip-change', syncRet);
    syncRet();
    var ok = await openDialog({ title: closedJob ? 'Release the part' : 'Release the part from the ticket', body: body, okText: 'Release', wide: true, onOk: async function () {
      var c;
      if (closedJob) {
        // Reopened since this opened? Then the machine's next step matters
        // again — the target below must never move a live ticket.
        var liveJob = jobById(job.id) || job;
        if (liveJob.stage !== 'closed') return 'The ticket was reopened since — close this and look again.';
        // No ticket target at all: the part is released and the ticket is
        // left as it is.
        c = RELEASE_CLOSED[0];
      } else {
        var key = readChip(body, 'jobto');
        c = choices.filter(function (x) { return x.key === key; })[0];
        if (!c) return 'Pick what happens to the machine.';
      }
      var ret = readChip(body, 'partret') || 'collect';
      var a = fval(body, 'addr');
      if (ret === 'courier' && !a) return 'Enter the address to courier the part back to.';
      var ids = [unitId];
      Array.prototype.forEach.call(body.querySelectorAll('input[data-sib]'), function (cb) { if (cb.checked) ids.push(cb.getAttribute('data-sib')); });
      try {
        // 'collect' is the default the server applies; the optional A5
        // parameters are sent only when the part is to be couriered.
        await data().releaseHold(ids, c.to, c.outcome, fval(body, 'note') || null,
                                 ret === 'courier' ? 'courier' : null, ret === 'courier' ? a : null);
      } catch (e) { return failText(e); }
      return true;
    } });
    if (ok && !isStale(g)) {
      toast(closedJob ? 'Released. The ticket stays closed and the part carries on by itself.'
                      : 'Released. The ticket has moved on and the part carries on by itself.', 'success');
      repaintAfterWrite(unitId);
    }
  }

  async function dlgStockReplace() {
    var unitId = openUnitId;
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u || !isHolding(u)) return;
    var body = dlgBody(
      '<p>Fit a replacement from our stock so the customer’s machine can go back now. <strong>' + esc(u.public_code || '') +
        '</strong> (' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) + ') then belongs to the shop and carries on through the claim; when it closes it goes back into stock.</p>' +
      dfield('Serial of the part from stock', 'serial', '', { placeholder: 'As printed on the label' }) +
      dfield('Note (optional)', 'note', '', { textarea: true, wide: true }));
    var ok = await openDialog({ title: 'Replaced from stock', body: body, okText: 'Record replacement', onOk: async function () {
      var s = fval(body, 'serial');
      if (!s) return 'Enter the serial of the part fitted from stock.';
      try { await data().advanceReplace(unitId, s, fval(body, 'note') || null); } catch (e) { return failText(e); }
      return true;
    } });
    if (ok && !isStale(g)) { toast('Recorded. The customer’s machine no longer waits for this part.', 'success'); repaintAfterWrite(unitId); }
  }

  async function dlgPaidRepair() {
    var unitId = openUnitId;
    var g = sessionGen;
    var u = unitById(unitId);
    if (!u || u.stage !== 'customer_decision') return;
    var body = dlgBody(
      '<p>Close the warranty claim for <strong>' + esc(u.public_code || '') + '</strong> (' + esc(kindLabel(u.kind) + ' · ' + brandModel(u)) +
        ') and open a paid repair ticket for it. The new ticket starts at the counter with this part and this customer.</p>' +
      (feeOwed(u) ? '<p class="rma-warn">The handling fee is not settled. The claim cannot close until it is paid or waived.</p>' : '') +
      dfield('Note for the customer (optional)', 'note', '', { textarea: true, wide: true, placeholder: 'e.g. You chose a paid repair after the claim was declined.' }));
    var res = null;
    var ok = await openDialog({ title: 'Open a paid repair', body: body, okText: 'Open paid repair', onOk: async function () {
      var live = unitById(unitId);
      if (!live || live.stage !== 'customer_decision') return 'This part has moved on since — close this and look again.';
      if (feeOwed(live)) return 'Settle the handling fee first (mark it paid, or a lead waives it).';
      try {
        res = await data().moveRma(unitId, 'customer_decision', 'closed', fval(body, 'note') || 'Moved to a paid repair.', true,
                                   { disposition: 'converted_to_repair' });
      } catch (e) { return failText(e); }
      return true;
    } });
    if (!ok || isStale(g)) return;
    var after = unitById(unitId);
    var followup = (res && (res.followup_job_id || (res.unit && res.unit.followup_job_id))) || (after && after.followup_job_id) || null;
    if (!followup && data() && typeof data().fetchUnit === 'function') {
      try { var fresh = await data().fetchUnit(unitId); followup = fresh && fresh.followup_job_id; } catch (e) { /* reported below */ }
      if (isStale(g)) return;
    }
    toast('Claim closed and a paid repair ticket opened.', 'success');
    repaintAfterWrite(unitId);
    if (followup && canService()) openTicket(followup);
    else if (!followup) toast('The repair ticket was created, but this machine has not received it yet — find it on the service board.', 'warning', 8000);
  }

  async function dlgMessage(unitId, preset) {
    var u = unitById(unitId);
    if (!u) return;
    var phone = trackingPhone(u);
    if (!phone) { toast('There is no phone number for this part.', 'warning'); return; }
    var v = vendorOf(u);
    var vlabel = customerFacingVendor(u, v);
    var names = [['rma_received', 'Received'], ['rma_sent', 'Sent to the manufacturer'], ['rma_back', 'Back from the manufacturer'], ['rma_ready', 'Ready']];
    var textFor = function (k) { return waText(k, msgUnit(u), vlabel); };
    var start = preset || 'rma_received';
    var body = dlgBody(
      '<p>To ' + esc(showPhone(phone)) + (u.owner_phone ? ' (end customer)' : ' (sender)') + '</p>' +
      '<div class="sv-field"><span>Which update?</span>' + chipsHtml('tpl', names.map(function (n) { return { value: n[0], label: n[1] }; }), start, { label: 'Which update' }) + '</div>' +
      '<label class="sv-field"><span>Message (you can edit it)</span><textarea data-f="text" rows="8">' + esc(textFor(start)) + '</textarea></label>' +
      '<p class="sv-hint">Opens WhatsApp with this text. Nothing is sent until you press send there.</p>');
    body.addEventListener('ops-chip-change', function (e) {
      if (!e.detail || e.detail.name !== 'tpl') return;
      var ta = fel(body, 'text');
      if (ta) ta.value = textFor(readChip(body, 'tpl') || 'rma_received');
    });
    await openDialog({ title: 'Message on WhatsApp', body: body, okText: 'Open WhatsApp', onOk: async function () {
      var text = fval(body, 'text');
      if (!text) return 'The message is empty.';
      return waSend(phone, text) ? true : 'There is no valid mobile number for this part.';
    } });
  }

  // Returns the new vendor's id (or null). Used by the Vendors view and the
  // Details tab's "Add vendor…".
  async function dlgAddVendor() {
    if (!canDesk()) { toast('You do not have access to add vendors.', 'warning'); return null; }
    var g = sessionGen;
    var newId = null;
    var body = dlgBody('<div class="sv-grid">' +
      dfield('Name', 'name', '', { placeholder: 'e.g. ASUS' }) +
      dfield('Name customers see (optional)', 'pub', '', { placeholder: 'Defaults to the name' }) +
      '<label class="sv-field"><span>Kind</span><select data-f="kind" class="settings-select">' +
        VENDOR_KINDS.map(function (k) { return '<option value="' + k.value + '">' + esc(k.label) + '</option>'; }).join('') + '</select></label>' +
      dfield('Usual turnaround (days)', 'tat', '14', { type: 'number', attrs: ' min="1" max="365" step="1" inputmode="numeric"' }) +
      '</div><p class="sv-hint">The name customers see appears on their tracking page (“With ASUS under warranty”). Use the brand, never a distributor’s name.</p>');
    var ok = await openDialog({ title: 'Add a vendor', body: body, okText: 'Add vendor', onOk: async function () {
      var name = fval(body, 'name');
      if (!name) return 'Give the vendor a name.';
      var dup = allVendors().filter(function (v) { return String(v.name || '').toLowerCase() === name.toLowerCase(); })[0];
      if (dup) return 'There is already a vendor called ' + dup.name + '.';
      var tat = Number(fval(body, 'tat') || 14);
      if (!isFinite(tat) || tat < 1 || tat > 365 || Math.round(tat) !== tat) return 'Turnaround should be a whole number of days, 1 to 365.';
      var res;
      try { res = await data().addVendor(name, fval(body, 'pub') || name, tat, fval(body, 'kind') || 'brand'); } catch (e) { return failText(e); }
      newId = (res && res.id != null) ? res.id : null;
      if (newId == null) {
        var found = allVendors().filter(function (v) { return String(v.name || '').toLowerCase() === name.toLowerCase(); })[0];
        newId = found ? found.id : null;
      }
      return true;
    } });
    if (!ok || isStale(g)) return null;
    toast('Vendor added.', 'success', 2500);
    return newId;
  }

  // ── Log courier arrival ──
  async function dlgArrival() {
    if (!canDesk()) return;
    var g = sessionGen;
    var who = myName();                           // the person at the counter now
    var miss = missingPiece();
    if (miss) { toast(miss, 'error'); return; }
    var d = data();
    try { await d.ensureLoaded(); } catch (e) { /* use what is cached */ }
    if (isStale(g)) return;                       // never a dialog on the login screen
    var logged = function () { return allUnits().filter(function (u) { return u.stage === 'logged'; }); };
    var picked = {};
    var received = false, receivedIds = [];
    var tray = null;
    var body = dlgBody(
      '<label class="sv-field"><span>Find the expected part</span><input type="text" data-f="q" autocomplete="off" spellcheck="false" placeholder="RM code, phone, AWB or sender"></label>' +
      '<div class="rma-arrive-list" data-f="list" role="group" aria-label="Expected parts"></div>' +
      dfield('Note (optional)', 'note', '', { textarea: true, wide: true, placeholder: 'e.g. Box slightly crushed, parts intact' }) +
      '<div class="rma-dlg-tray"></div>' +
      '<p class="sv-hint">Photos of the box as it arrived protect us if something inside is damaged. They are attached to the first part you tick.</p>');
    var paint = function () {
      var list = fel(body, 'list');
      if (!list) return;
      var q = fval(body, 'q').toLowerCase();
      var all = logged();
      var rows = all.filter(function (u) { return matchQuery(u, q); });
      if (!all.length && !received) {
        list.innerHTML = '<div class="sv-empty">Nothing is expected right now. For a box nobody logged, use + New RMA → Courier box.</div>';
        return;
      }
      if (received) {
        list.innerHTML = '<div class="sv-empty">Marked received: ' + esc(receivedIds.map(function (id) { var u = unitById(id); return u ? u.public_code : ''; }).filter(Boolean).join(', ')) + '</div>';
        return;
      }
      if (!rows.length) { list.innerHTML = '<div class="sv-empty">Nothing expected matches that.</div>'; return; }
      var byIntake = {}, order = [];
      rows.slice(0, 60).forEach(function (u) {
        var k = u.intake_id || u.id;
        if (!byIntake[k]) { byIntake[k] = []; order.push(k); }
        byIntake[k].push(u);
      });
      list.innerHTML = order.map(function (k) {
        var us = byIntake[k];
        var it = intakeOf(us[0]) || {};
        return '<div class="rma-arrive-box">' +
          '<div class="rma-arrive-head">' + esc([it.sender_name || 'Unknown sender', it.inbound_courier, it.inbound_awb ? 'AWB ' + it.inbound_awb : '', 'logged ' + fmtDate(us[0].created_at)].filter(Boolean).join(' · ')) +
            (us.length > 1 ? ' <button type="button" class="rma-linkbtn" data-allbox="' + esc(k) + '">Tick all ' + us.length + '</button>' : '') + '</div>' +
          us.map(function (u) {
            return '<label class="sv-check"><input type="checkbox" data-pick="' + esc(u.id) + '"' + (picked[u.id] ? ' checked' : '') + '> ' +
              '<span class="sv-code">' + esc(u.public_code || '') + '</span> ' + esc(kindLabel(u.kind) + ' · ' + brandModel(u) + (u.owner_name ? ' · for ' + u.owner_name : '')) + '</label>';
          }).join('') +
        '</div>';
      }).join('') + (rows.length > 60 ? '<p class="sv-hint">Showing the first 60 — narrow the search.</p>' : '');
    };
    body.addEventListener('input', function (e) { if (e.target && e.target.getAttribute('data-f') === 'q') paint(); });
    body.addEventListener('change', function (e) {
      var id = e.target && e.target.getAttribute && e.target.getAttribute('data-pick');
      if (id) { if (e.target.checked) picked[id] = true; else delete picked[id]; }
    });
    body.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-allbox]');
      if (!b || received) return;
      var k = b.getAttribute('data-allbox');
      logged().forEach(function (u) { if ((u.intake_id || u.id) === k) picked[u.id] = true; });
      paint();
    });
    paint();
    var ok = await openDialog({
      title: 'Log a courier arrival', body: body, okText: 'Mark received', wide: true,
      onOpen: function () {
        var host = body.querySelector('.rma-dlg-tray');
        var T = trays();
        if (host && T && typeof T.create === 'function') {
          try { tray = T.create(host, { roles: ['unboxing', 'packing', 'damage', 'condition'], defaultRole: 'unboxing', allowPdf: false, minPhotos: 0, label: 'Photos of the box as it arrived' }); }
          catch (e) { tray = null; }
        }
      },
      onOk: async function () {
        if (!received) {
          var ids = Object.keys(picked).filter(function (id) { var u = unitById(id); return u && u.stage === 'logged'; });
          if (!ids.length) return 'Tick the part (or parts) that arrived.';
          // SPEC-AMENDMENTS A21: no photos is allowed, but said out loud and
          // written down.
          var noPhotos = !photoCount(tray);
          if (noPhotos) {
            var go = await confirmBox('No photos of the box. Photos are the proof of how it arrived. Accept without photos?',
                                      { title: 'No photos', okText: 'Accept without photos' });
            if (!go || isStale(g)) return false;
          }
          try { await data().receiveRma(ids, fval(body, 'note') || null); } catch (e) { return isStale(g) ? false : failText(e); }
          received = true;
          receivedIds = ids;
          if (isStale(g)) return false;           // signed out meanwhile: no more writes
          paint();
          if (noPhotos) {
            for (var i = 0; i < ids.length && !isStale(g); i++) {
              try { await data().rmaNote(ids[i], 'Accepted without photos by ' + who + '.', false); } catch (e) { /* the receive stands */ }
            }
          }
          if (isStale(g)) return false;
        }
        if (photoCount(tray)) {
          var r;
          try { r = await trays().uploadAll(tray, { caseId: receivedIds[0] }, function () {}); }
          catch (e) { return 'Marked received. The photos did not upload (' + failText(e) + ') — press Mark received again to retry them, or Cancel to skip.'; }
          forgetRoles(receivedIds[0]);
          if (r && r.failed && r.failed.length) {
            return 'Marked received. ' + r.failed.length + ' photo' + (r.failed.length === 1 ? '' : 's') + ' did not upload — press Mark received again to retry, or Cancel to skip.';
          }
        }
        return true;
      }
    });
    if (tray) { try { tray.destroy(); } catch (e) { /* gone */ } }
    if (received && !isStale(g)) {
      var codes = receivedIds.map(function (id) { var u = unitById(id); return u ? u.public_code : ''; }).filter(Boolean);
      toast('Marked received: ' + codes.join(', ') + '.', ok ? 'success' : 'info');
      if (screenActive()) renderView();
      if (openUnitId && receivedIds.indexOf(openUnitId) !== -1) repaintAfterWrite(openUnitId);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  NEW RMA (#rma-intake-modal)
  //  One scrolling form. Typed values live in the DOM until Create; the form
  //  object only tracks what the DOM cannot (trays, ids, touched flags). Part
  //  cards are appended and removed individually, so adding a part never wipes
  //  what was typed into the others, or their photo trays.
  // ══════════════════════════════════════════════════════════════════════════
  var form = null;
  var unitKeySeq = 0;
  var MAX_UNITS = 20;
  var SOURCE_CARDS = [
    ['walk_in', 'Walk-in part', 'Someone brought a part to the counter'],
    ['courier', 'Courier box', 'A box arrived, or is on its way'],
    ['stock', 'Shop stock', 'A faulty part from our own stock']
  ];
  var SENDER_OPTS = [
    { value: 'customer', label: 'Customer' },
    { value: 'third_party_tech', label: 'Third-party technician' },
    { value: 'our_tech', label: 'Our technician' }
  ];
  function diagDefault(senderKind) {
    if (senderKind === 'third_party_tech') return 'third_party';
    if (senderKind === 'customer') return 'customer';
    return 'us';
  }
  function feeFor(kind) {
    var c = catalog();
    if (c && typeof c.handlingFee === 'function') return c.handlingFee(kind);
    var by = (c && c.HANDLING_FEE_BY_KIND) || {};
    return by[kind] != null ? by[kind] : ((c && c.DEFAULT_HANDLING_FEE) || 300);
  }

  function intakeHtml(f) {
    return '<div class="rma-in">' +
      '<div class="modal-header"><div><h2>New RMA</h2><div class="sv-job-sub">Parts for a warranty claim</div></div>' +
        '<button type="button" class="close-btn" id="rma-in-close" aria-label="Close" title="Close">&times;</button></div>' +
      '<div class="modal-body rma-in-body" id="rma-in-body">' +
        '<section class="rma-in-sec"><h3 class="rma-in-h">What came in?</h3>' +
          '<div class="rma-src-cards" role="group" aria-label="What came in">' + SOURCE_CARDS.map(function (s) {
            var on = s[0] === f.source;
            return '<button type="button" class="rma-src-card' + (on ? ' on' : '') + '" data-source="' + s[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
                   '<span class="rma-src-card-t">' + esc(s[1]) + '</span><span class="rma-src-card-s">' + esc(s[2]) + '</span></button>';
          }).join('') + '</div>' +
        '</section>' +
        '<section class="rma-in-sec" id="rma-in-sender"><h3 class="rma-in-h">Who sent it?</h3>' +
          chipsHtml('sender', SENDER_OPTS, f.senderKind, { label: 'Who sent it' }) +
          '<div class="sv-grid rma-mt">' +
            '<label class="sv-field"><span>Phone</span><input type="text" id="rma-in-phone" inputmode="tel" autocomplete="off" spellcheck="false" maxlength="20" placeholder="10-digit mobile, or with the country code"></label>' +
            '<label class="sv-field"><span>Name</span><input type="text" id="rma-in-name" autocomplete="off" spellcheck="false" placeholder="Person or shop name"></label>' +
          '</div>' +
          '<div id="rma-in-lookup" class="rma-in-lookup" aria-live="polite"></div>' +
        '</section>' +
        '<section class="rma-in-sec" id="rma-in-courier"><h3 class="rma-in-h">The box</h3>' +
          chipsHtml('inhand', [{ value: 'now', label: 'Box arrived now' }, { value: 'expected', label: 'Expected — not here yet' }], f.inHand ? 'now' : 'expected', { label: 'Is the part in hand' }) +
          '<div class="sv-grid rma-mt">' +
            '<label class="sv-field"><span>Courier</span><input type="text" id="rma-in-courier-name" autocomplete="off" spellcheck="false" placeholder="e.g. DTDC"></label>' +
            '<label class="sv-field"><span>AWB / tracking no.</span><input type="text" id="rma-in-awb" autocomplete="off" spellcheck="false"></label>' +
          '</div>' +
          '<div id="rma-in-box" class="rma-in-box"><div class="rma-in-boxtray"></div></div>' +
        '</section>' +
        '<section class="rma-in-sec" id="rma-in-return"><h3 class="rma-in-h">How does it go back?</h3>' +
          chipsHtml('ret', [{ value: 'collect', label: 'Collect in store' }, { value: 'courier', label: 'Courier back' }], f.ret, { label: 'How it goes back' }) +
          '<label class="sv-field rma-mt" id="rma-in-addr-wrap"><span>Return address</span><textarea id="rma-in-addr" rows="2" placeholder="Name, address, pincode, phone"></textarea></label>' +
        '</section>' +
        '<section class="rma-in-sec"><div class="rma-in-hrow"><h3 class="rma-in-h">Parts</h3>' +
          '<button type="button" class="secondary-btn rma-small" id="rma-in-add">+ Add part</button></div>' +
          '<div id="rma-in-units"></div>' +
        '</section>' +
        '<section class="rma-in-sec"><label class="sv-field"><span>Notes for the shop (optional)</span>' +
          '<textarea id="rma-in-notes" rows="2" placeholder="Anything the next person should know"></textarea></label></section>' +
      '</div>' +
      '<div class="modal-footer rma-in-foot">' +
        '<span id="rma-in-status" class="sv-status rma-in-status" role="status"></span>' +
        '<div class="rma-in-btns"><button type="button" class="secondary-btn" id="rma-in-cancel">Cancel</button>' +
        '<button type="button" class="primary-pink-btn" id="rma-in-create">Create RMA</button></div>' +
      '</div>' +
    '</div>';
  }

  function unitCardHtml() {
    var kinds = KIND_ORDER.map(function (k) { return '<option value="' + k + '">' + esc(kindLabel(k)) + '</option>'; }).join('');
    return '<div class="rma-in-unit-head"><span class="rma-in-unit-n">Part</span>' +
        '<button type="button" class="rma-linkbtn" data-act="remove-unit">Remove</button></div>' +
      '<div class="sv-grid">' +
        '<label class="sv-field"><span>What is it?</span><select data-f="kind" class="settings-select"><option value="">Choose…</option>' + kinds + '</select></label>' +
        dfield('Brand', 'brand', '', { placeholder: 'e.g. ASUS' }) +
        dfield('Model', 'model', '', { placeholder: 'e.g. TUF RTX 4070 Ti' }) +
        dfield('Serial (as printed on the label)', 'serial', '', { placeholder: 'Optional now — needed before it ships' }) +
        '<div class="sv-span2 rma-hint-slot" data-slot="build"></div>' +
        '<input type="hidden" data-f="build_ticket_id" value="">' +
        dfield('Fault', 'fault', '', { textarea: true, wide: true, placeholder: 'What is wrong with it, in the sender’s words' }) +
        '<div class="sv-field sv-span2"><span>Who found the fault?</span>' + chipsHtml('diag', DIAG_OPTIONS, 'customer', { label: 'Who found the fault' }) + '</div>' +
        '<div class="sv-field sv-span2 rma-in-data hidden"><span>Data on the drive</span>' + chipsHtml('data', DATA_HANDLING, null, { label: 'Data on the drive', allowNone: true }) +
          '<p class="sv-hint">Needed before a drive can ship. Leave it for now if you have not asked yet.</p></div>' +
        '<div class="sv-span2 rma-in-owner"><div class="sv-grid">' +
          dfield('End customer name (optional)', 'owner_name', '', { placeholder: 'If the sender is not the owner' }) +
          dfield('End customer phone (optional)', 'owner_phone', '', { attrs: ' inputmode="tel" maxlength="20"', placeholder: '10-digit mobile' }) +
        '</div><p class="sv-hint rma-in-track"></p></div>' +
        '<div class="sv-field sv-span2 rma-in-buy"><span>Where was it bought?</span>' +
          chipsHtml('buy', BUY_KEYS.map(function (k) { return { value: k, label: k === 'neo_tokyo' ? 'Neo Tokyo' : buyLabel(k) }; }), null, { label: 'Where was it bought' }) + '</div>' +
        dfield('Invoice no.', 'invoice_no', '', { cls: 'rma-in-inv' }) +
        dfield('Purchase date', 'purchase_date', '', { type: 'date', cls: 'rma-in-inv' }) +
        '<div class="sv-span2 rma-in-fee hidden"><div class="sv-grid">' +
          dfield('Handling fee (₹)', 'fee', '', { type: 'number', attrs: ' min="1" step="1" inputmode="decimal"' }) +
          '<p class="sv-hint rma-in-feehint">Paid handling service — the customer’s invoice (or a warranty-check screenshot) is needed before it ships.</p>' +
        '</div></div>' +
        dfield('Condition / remarks (optional)', 'condition_remarks', '', { textarea: true, wide: true, placeholder: 'Scratches, bent pins, missing screws…' }) +
      '</div>' +
      '<div class="rma-in-tray"></div>';
  }

  function intakeRoot() { return el('rma-intake-root'); }
  function inStatus(msg, kind) { setStatusId('rma-in-status', msg, kind); }

  function openIntake(opts) {
    var miss = missingPiece();
    if (miss) { toast(miss, 'error'); return; }
    if (!canDesk()) { toast('You do not have access to log RMAs.', 'warning'); return; }
    var modal = el('rma-intake-modal'), root = intakeRoot();
    if (!modal || !root) { toast('The New RMA form is missing from this build.', 'error'); return; }
    // Already open with something typed: keep it. The counter is busy and a
    // stray click on "+ New RMA" must not throw away a half-logged box.
    if (form && !form.done && modal.classList.contains('active')) return;
    retireForm(form);
    var src = opts && opts.source;
    form = {
      crid: uuid(),                    // one per form: a retry after a network error cannot duplicate
      source: (src === 'courier' || src === 'stock') ? src : 'walk_in',
      senderKind: 'customer',
      inHand: true,
      ret: 'collect',
      units: [],
      boxTray: null,
      busy: false, done: false, retired: false,
      touched: false, noPhotos: false,
      lookupTimer: null, lookupSeq: 0, nameAuto: false, lookupPhone: '',
      doneUnits: [], failures: []
    };
    root.innerHTML = intakeHtml(form);
    addUnitCard(form);
    syncIntake(form);
    modal.classList.add('active');
    var f0 = form;
    setTimeout(function () {
      if (form !== f0) return;
      var p = el(f0.source === 'stock' ? 'rma-in-add' : 'rma-in-phone');
      if (p) p.focus();
    }, 120);
  }

  function destroyFormTrays(f) {
    if (!f) return;
    f.units.forEach(function (r) {
      if (r.tray) { try { r.tray.destroy(); } catch (e) { /* gone */ } r.tray = null; }
      clearTimeout(r.serialTimer);
    });
    if (f.boxTray) { try { f.boxTray.destroy(); } catch (e) { /* gone */ } f.boxTray = null; }
  }
  // A form being replaced or closed. Its trays are destroyed now — unless its
  // uploads are still running, in which case they are destroyed when done.
  function retireForm(f) {
    if (!f) return;
    clearTimeout(f.lookupTimer);
    f.retired = true;
    if (!f.busy) destroyFormTrays(f);
  }

  async function closeIntake(force) {
    var f = form;
    var modal = el('rma-intake-modal');
    if (!f) { if (modal) modal.classList.remove('active'); return true; }
    if (!force) {
      if (f.busy) {
        var go = await confirmBox('The RMA is being saved or its photos are uploading. Close anyway? The upload carries on in the background and you will see a message when it finishes.',
          { title: 'Still saving', okText: 'Close' });
        if (!go || form !== f) return false;
      } else if (!f.done && intakeDirty(f)) {
        var ok = await confirmBox('Discard this RMA? Nothing has been saved yet.', { title: 'Discard RMA', okText: 'Discard', danger: true });
        if (!ok || form !== f) return false;
      }
    }
    if (modal) modal.classList.remove('active');
    retireForm(f);
    form = null;
    return true;
  }

  function intakeDirty(f) {
    if (!f || f.done) return false;
    if (f.touched) return true;
    if (f.units.some(function (r) { return photoCount(r.tray) > 0; })) return true;
    return photoCount(f.boxTray) > 0;
  }

  function addUnitCard(f) {
    if (f.done || f.busy) return;
    var host = el('rma-in-units');
    if (!host) return;
    if (f.units.length >= MAX_UNITS) { inStatus('One RMA holds up to ' + MAX_UNITS + ' parts. Log the rest as a second RMA.', 'err'); return; }
    var key = 'u' + (++unitKeySeq);
    var card = document.createElement('div');
    card.className = 'rma-in-unit';
    card.setAttribute('data-ukey', key);
    card.innerHTML = unitCardHtml();
    host.appendChild(card);
    var rec = { key: key, el: card, tray: null, feeTouched: false, diagTouched: false, serialTimer: null, serialSeq: 0 };
    setChip(card, 'diag', diagDefault(f.senderKind));
    var T = trays();
    var th = card.querySelector('.rma-in-tray');
    if (T && typeof T.create === 'function' && th) {
      try {
        rec.tray = T.create(th, { roles: ['condition', 'serial_label', 'invoice'], defaultRole: 'condition', allowPdf: true, minPhotos: 0,
                                  label: 'Photos of this part — a photo of the serial label is needed before it ships' });
        if (rec.tray && typeof rec.tray.onChange === 'function') rec.tray.onChange(function () { if (form === f) f.touched = true; });
      } catch (e) {
        rec.tray = null;
        th.innerHTML = '<div class="sv-empty">Could not start the photo tray: ' + esc(errMsg(e)) + '</div>';
      }
    } else if (th) {
      th.innerHTML = '<div class="sv-empty">The photo tray (photo-tray.js) is not loaded — add photos from the part’s panel later.</div>';
    }
    f.units.push(rec);
    renumberUnits(f);
    syncIntake(f);
  }

  function recOfCard(f, card) { return card ? f.units.filter(function (r) { return r.el === card; })[0] || null : null; }

  async function removeUnitCard(f, key) {
    if (f.done || f.busy) return;
    var rec = f.units.filter(function (r) { return r.key === key; })[0];
    if (!rec) return;
    if (f.units.length === 1) { inStatus('An RMA needs at least one part.', 'err'); return; }
    var typed = Array.prototype.some.call(rec.el.querySelectorAll('input[data-f]:not([type="hidden"]), textarea[data-f]'), function (x) { return String(x.value || '').trim(); });
    if (typed || photoCount(rec.tray)) {
      var ok = await confirmBox('Remove this part and what you typed for it?', { title: 'Remove part', okText: 'Remove', danger: true });
      if (!ok || form !== f || f.busy || f.done) return;
    }
    if (rec.tray) { try { rec.tray.destroy(); } catch (e) { /* gone */ } }
    clearTimeout(rec.serialTimer);
    if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    f.units = f.units.filter(function (r) { return r !== rec; });
    renumberUnits(f);
    syncIntake(f);
  }

  function renumberUnits(f) {
    f.units.forEach(function (r, i) {
      var n = r.el.querySelector('.rma-in-unit-n');
      if (n) n.textContent = 'Part ' + (i + 1);
      var rm = r.el.querySelector('[data-act="remove-unit"]');
      if (rm) show(rm, f.units.length > 1);
    });
    var add = el('rma-in-add');
    if (add) add.disabled = f.units.length >= MAX_UNITS;
  }

  // Makes the form match its choices without rebuilding anything typed.
  function syncIntake(f) {
    if (!f || form !== f) return;
    var stock = f.source === 'stock';
    var courier = f.source === 'courier';
    var root = intakeRoot();
    Array.prototype.forEach.call(root.querySelectorAll('.rma-src-card'), function (b) {
      var on = b.getAttribute('data-source') === f.source;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    show(el('rma-in-sender'), !stock);
    show(el('rma-in-courier'), courier);
    show(el('rma-in-return'), !stock);
    show(el('rma-in-addr-wrap'), !stock && f.ret === 'courier');
    var boxOn = courier && f.inHand;
    show(el('rma-in-box'), boxOn);
    if (boxOn && !f.boxTray) {
      var bh = root.querySelector('.rma-in-boxtray');
      var T = trays();
      if (bh && T && typeof T.create === 'function') {
        try {
          f.boxTray = T.create(bh, { roles: ['unboxing', 'packing'], defaultRole: 'unboxing', allowPdf: false, minPhotos: 0,
                                     label: 'Unboxing photos — the box as it arrived, then each part as it came out' });
          if (f.boxTray && typeof f.boxTray.onChange === 'function') f.boxTray.onChange(function () { if (form === f) f.touched = true; });
        } catch (e) { f.boxTray = null; }
      }
    }
    var senderName = String((el('rma-in-name') || {}).value || '').trim();
    var senderPhone = String((el('rma-in-phone') || {}).value || '').trim();
    f.units.forEach(function (r) {
      var c = r.el;
      var kind = fval(c, 'kind');
      show(c.querySelector('.rma-in-owner'), !stock);
      show(c.querySelector('.rma-in-buy'), !stock);
      show(c.querySelector('.rma-in-data'), isDrive(kind));
      var buy = readChip(c, 'buy');
      Array.prototype.forEach.call(c.querySelectorAll('.rma-in-inv'), function (x) { show(x, stock || buy === 'neo_tokyo' || buy === 'elsewhere'); });
      var inv = c.querySelector('.rma-in-inv span');
      if (inv) inv.textContent = stock ? 'Our purchase invoice no.' : 'Invoice no.';
      var feeOn = !stock && buy === 'elsewhere';
      show(c.querySelector('.rma-in-fee'), feeOn);
      var feeIn = fel(c, 'fee');
      if (feeOn && feeIn && !r.feeTouched) feeIn.value = String(feeFor(kind || 'other'));
      var track = c.querySelector('.rma-in-track');
      if (track) {
        var op = fval(c, 'owner_phone');
        track.textContent = stock ? '' : 'Tracking updates go to: ' + (validPhone(op) ? 'the end customer (' + showPhone(op) + ')'
          : (validPhone(senderPhone) ? 'the sender' + (senderName ? ' — ' + senderName : '') + ' (' + showPhone(senderPhone) + ')' : 'nobody yet — add a phone number'));
      }
    });
    var create = el('rma-in-create');
    if (create && !f.busy && !f.done) create.textContent = (courier && !f.inHand) ? 'Log expected box' : 'Create RMA';
  }

  // A name the lookup filled in belongs to the number it was looked up for.
  // Once the number changes (a typo fixed, or no longer a valid number) that
  // name is cleared, as service-intake's resetLookup does — otherwise the new
  // number would be logged, greeted and saved to the customer book under the
  // previous person's name. A name typed by hand is never touched.
  function dropAutoName(f, n) {
    if (!f.nameAuto || n === f.lookupPhone) return;
    var name = el('rma-in-name');
    if (name) name.value = '';
    f.nameAuto = false;
    f.lookupPhone = '';
  }

  function onSenderPhone(f) {
    clearTimeout(f.lookupTimer);
    var box = el('rma-in-lookup');
    var raw = String((el('rma-in-phone') || {}).value || '');
    if (!validPhone(raw)) { f.lookupSeq++; dropAutoName(f, ''); if (box) box.innerHTML = ''; return; }
    var n = normPhone(raw);
    dropAutoName(f, n);
    f.lookupTimer = setTimeout(function () { runLookup(f, n); }, 300);
  }

  async function runLookup(f, n) {
    var seq = ++f.lookupSeq;
    var box = el('rma-in-lookup');
    var d = data();
    if (!d || typeof d.lookupCustomer !== 'function') return;
    if (box) box.innerHTML = '<span class="rma-muted">Looking up that number…</span>';
    var res;
    try { res = await d.lookupCustomer(n); }
    catch (e) {
      if (form === f && seq === f.lookupSeq && el('rma-in-lookup')) el('rma-in-lookup').innerHTML = '<span class="rma-muted">Could not look up that number: ' + esc(errMsg(e)) + '</span>';
      return;
    }
    // Answer for THIS number in THIS form only — the field may have changed.
    if (form !== f || seq !== f.lookupSeq || normPhone((el('rma-in-phone') || {}).value) !== n || f.done) return;
    box = el('rma-in-lookup');
    if (!box) return;
    var html = '';
    if (res && res.limited) {
      // SPEC-AMENDMENTS A19: a reduced answer for callers without access.
      html = res.known ? '<div class="rma-in-found">Known customer: <strong>' + esc(res.display_name || '') + '</strong>' +
                         (res.open_count ? ' · ' + esc(String(res.open_count)) + ' open' : '') + '</div>'
                       : '<div class="rma-muted">New number — nobody on file yet.</div>';
      box.innerHTML = html;
      syncIntake(f);
      return;
    }
    var cust = res && res.customer;
    var name = el('rma-in-name');
    if (cust && cust.name && name && (!String(name.value || '').trim() || f.nameAuto)) {
      name.value = cust.name;
      f.nameAuto = true;
      f.lookupPhone = n;
    }
    if (cust && cust.name) {
      html += '<div class="rma-in-found">Known ' + (cust.kind === 'business' || cust.kind === 'trade_partner' ? 'business' : 'customer') + ': <strong>' + esc(cust.name) + '</strong>' +
        (res.jobs_total ? ' · ' + esc(String(res.jobs_total)) + ' service ticket' + (res.jobs_total === 1 ? '' : 's') : '') + '</div>';
    } else {
      html += '<div class="rma-muted">New number — nobody on file yet.</div>';
    }
    var openR = (res && res.open_rma) || [];
    if (openR.length) {
      html += '<div class="rma-in-warn"><strong>Open RMA' + (openR.length === 1 ? '' : 's') + ' for this number:</strong>' +
        openR.slice(0, 5).map(function (r) {
          return '<div class="rma-in-warnrow"><span class="sv-code">' + esc(r.public_code || '') + '</span> ' +
            esc(kindLabel(r.kind) + ' · ' + [r.brand, r.model].filter(Boolean).join(' ') + ' — ' + staffStage(r.stage)) +
            (r.id ? ' <button type="button" class="rma-linkbtn" data-lookup-open="' + esc(r.id) + '">Open</button>' : '') + '</div>';
        }).join('') + '</div>';
    }
    var openJ = (res && res.open_jobs) || [];
    if (openJ.length) {
      html += '<div class="rma-in-warn is-info"><strong>Open service ticket' + (openJ.length === 1 ? '' : 's') + ':</strong>' +
        openJ.slice(0, 3).map(function (j) {
          var sl = '';
          try { sl = model().staffLabel(j.stage); } catch (e) { sl = j.stage; }
          return '<div class="rma-in-warnrow"><span class="sv-code">' + esc(j.public_code || '') + '</span> ' + esc((j.device_label || 'Device') + ' — ' + sl) + '</div>';
        }).join('') +
        '<p class="sv-hint">If this part came out of that machine, send it from the ticket’s Items tab instead — then the ticket follows the part.</p></div>';
    }
    box.innerHTML = html;
    syncIntake(f);
  }

  function onCardSerial(f, rec) {
    clearTimeout(rec.serialTimer);
    var slot = rec.el.querySelector('[data-slot="build"]');
    var hid = fel(rec.el, 'build_ticket_id');
    if (slot && !(hid && hid.value)) slot.innerHTML = '';
    var q = fval(rec.el, 'serial');
    var seq = ++rec.serialSeq;
    rec.serialTimer = setTimeout(function () {
      findSerialBuild(q).then(function (b) {
        if (!b || form !== f || f.done || seq !== rec.serialSeq || !rec.el.isConnected || fval(rec.el, 'serial') !== q) return;
        var h = fel(rec.el, 'build_ticket_id');
        if (h && h.value === String(b.id)) return;          // already linked to this one
        var s = rec.el.querySelector('[data-slot="build"]');
        if (s) s.innerHTML = buildHintHtml(b);
      });
    }, 600);
  }

  // Returns null when valid, else { msg, focus }.
  function validateIntake(f) {
    var stock = f.source === 'stock';
    var rawPhone = String((el('rma-in-phone') || {}).value || '').trim();
    var name = String((el('rma-in-name') || {}).value || '').trim();
    if (!stock) {
      if (!name) return { msg: 'Enter the sender’s name.', focus: el('rma-in-name') };
      if (f.senderKind !== 'our_tech' && !validPhone(rawPhone)) return { msg: 'Enter the sender’s mobile number (10 digits, or with the country code) — it is how they track the claim.', focus: el('rma-in-phone') };
      if (rawPhone && !validPhone(rawPhone)) return { msg: 'That phone number does not look like a mobile number.', focus: el('rma-in-phone') };
      if (f.ret === 'courier' && !String((el('rma-in-addr') || {}).value || '').trim()) return { msg: 'A courier return needs a return address.', focus: el('rma-in-addr') };
    }
    for (var i = 0; i < f.units.length; i++) {
      var c = f.units[i].el, n = 'Part ' + (i + 1) + ': ';
      if (!fval(c, 'kind')) return { msg: n + 'say what it is.', focus: fel(c, 'kind') };
      if (!fval(c, 'brand')) return { msg: n + 'enter the brand.', focus: fel(c, 'brand') };
      if (!fval(c, 'fault')) return { msg: n + 'describe the fault — even one line.', focus: fel(c, 'fault') };
      if (!readChip(c, 'diag')) return { msg: n + 'say who found the fault.', focus: chipWrapOf(c, 'diag') };
      if (!stock) {
        var op = fval(c, 'owner_phone');
        if (op && !validPhone(op)) return { msg: n + 'the end customer phone should be a mobile number.', focus: fel(c, 'owner_phone') };
        if (!readChip(c, 'buy')) return { msg: n + 'say where it was bought (“Not sure” is fine).', focus: chipWrapOf(c, 'buy') };
        if (readChip(c, 'buy') === 'elsewhere') {
          var fee = parseMoney(fval(c, 'fee'));
          // SPEC-GAP: a zero fee would still be "quoted" server-side and then
          // block closing; a fee nobody should pay is waived by a lead instead.
          if (fee !== null && (isNaN(fee) || fee <= 0)) return { msg: n + 'the handling fee should be more than ₹0 (a lead can waive it later).', focus: fel(c, 'fee') };
        }
        if (!validPhone(rawPhone) && !validPhone(op)) return { msg: n + 'add a phone — the sender’s or the end customer’s — so someone can track it.', focus: fel(c, 'owner_phone') };
      }
      var pd = fval(c, 'purchase_date');
      if (pd && !/^\d{4}-\d{2}-\d{2}$/.test(pd)) return { msg: n + 'the purchase date does not look right.', focus: fel(c, 'purchase_date') };
    }
    return null;
  }

  function buildPayload(f) {
    var stock = f.source === 'stock';
    var rawPhone = String((el('rma-in-phone') || {}).value || '').trim();
    var name = String((el('rma-in-name') || {}).value || '').trim();
    var courier = f.source === 'courier';
    return {
      client_request_id: f.crid,
      source: f.source,
      sender_kind: stock ? 'shop' : f.senderKind,
      // SPEC-GAP: shop stock has no outside sender; the intake still needs a
      // name for labels and history.
      sender_name: stock ? 'Neo Tokyo (shop stock)' : name,
      sender_phone: (!stock && validPhone(rawPhone)) ? normPhone(rawPhone) : null,
      inbound_courier: courier ? (String((el('rma-in-courier-name') || {}).value || '').trim() || null) : null,
      inbound_awb: courier ? (String((el('rma-in-awb') || {}).value || '').trim() || null) : null,
      return_method: stock ? 'collect' : f.ret,
      return_address: (!stock && f.ret === 'courier') ? String((el('rma-in-addr') || {}).value || '').trim() : null,
      notes: String((el('rma-in-notes') || {}).value || '').trim() || null,
      in_hand: courier ? !!f.inHand : true,
      units: f.units.map(function (r) {
        var c = r.el;
        // SPEC-GAP: shop stock was bought by us, so it is recorded as
        // 'neo_tokyo' — no handling fee, and the "where bought" gate is met.
        var buy = stock ? 'neo_tokyo' : readChip(c, 'buy');
        var op = fval(c, 'owner_phone');
        var fee = buy === 'elsewhere' ? parseMoney(fval(c, 'fee')) : null;
        var kind = fval(c, 'kind');
        var out = {
          kind: kind,
          brand: fval(c, 'brand'),
          model: fval(c, 'model') || null,
          serial: fval(c, 'serial') || null,
          fault: fval(c, 'fault'),
          diagnosed_by: readChip(c, 'diag') || diagDefault(f.senderKind),
          owner_name: stock ? null : (fval(c, 'owner_name') || null),
          owner_phone: (!stock && validPhone(op)) ? normPhone(op) : null,
          purchase_source: buy || 'unknown',
          invoice_no: fval(c, 'invoice_no') || null,
          purchase_date: fval(c, 'purchase_date') || null,
          build_ticket_id: fval(c, 'build_ticket_id') || null,
          handling_fee: (fee === null || isNaN(fee)) ? null : fee,
          condition_remarks: fval(c, 'condition_remarks') || null
        };
        var dh = isDrive(kind) ? readChip(c, 'data') : null;
        if (dh) out.data_handling = dh;
        return out;
      })
    };
  }

  async function submitIntake() {
    var f = form;                                 // bound once, like openUnitId
    var g = sessionGen;
    var who = myName();                           // the person at the counter now
    if (!f || f.busy || f.done) return;
    var bad = validateIntake(f);
    if (bad) {
      inStatus(bad.msg, 'err');
      if (bad.focus) {
        try {
          var target = bad.focus.matches && bad.focus.matches('[data-chip-wrap]') ? bad.focus.querySelector('button') : bad.focus;
          if (target) { target.focus(); target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        } catch (e) { /* focus is a nicety */ }
      }
      return;
    }
    var payload = buildPayload(f);
    var photos = f.units.reduce(function (s, r) { return s + photoCount(r.tray); }, 0) + photoCount(f.boxTray);
    f.noPhotos = false;
    if (payload.in_hand && !photos) {
      var go = await confirmBox('No photos of the parts. A photo of the serial label is needed before anything ships, and condition photos protect us if a part was already damaged. Accept without photos?',
        { title: 'No photos', okText: 'Accept without photos' });
      if (!go || form !== f || f.busy || f.done) return;
      f.noPhotos = true;
    }
    f.busy = true;
    var btn = el('rma-in-create'), cancel = el('rma-in-cancel');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    if (cancel) cancel.disabled = true;
    inStatus('Creating the RMA…', '');
    var res;
    try {
      res = await data().createRma(payload);
    } catch (e) {
      f.busy = false;
      if (isStale(g)) { destroyFormTrays(f); return; }
      if (f.retired || form !== f) { destroyFormTrays(f); toast('Could not create the RMA: ' + errMsg(e), 'error', 8000); return; }
      inStatus('Could not create the RMA: ' + failText(e) + ' Everything you typed is still here.', 'err');
      var b1 = el('rma-in-create'), c1 = el('rma-in-cancel');
      if (b1) b1.disabled = false;
      if (c1) c1.disabled = false;
      syncIntake(f);
      return;
    }
    f.done = true;
    // Signed out while it saved: the RMA exists (the board shows it), but
    // the follow-ups — the drive-data answer, the no-photos note, the photos
    // — would now be written as nobody, or as whoever signs in next.
    if (isStale(g)) { f.busy = false; destroyFormTrays(f); return; }
    var made = (res && res.units) || [];
    f.doneUnits = made.map(function (m, i) {
      var p = payload.units[i] || {};
      return { id: m.id, public_code: m.public_code, stage: m.stage || (payload.in_hand ? 'received' : 'logged'),
               kind: p.kind, brand: p.brand, model: p.model, owner_name: p.owner_name, owner_phone: p.owner_phone,
               data_handling: p.data_handling || null,
               sender_name: payload.sender_name, created_at: new Date().toISOString(),
               tracking_phone: p.owner_phone || payload.sender_phone || '' };
    });
    if (form === f) {
      Array.prototype.forEach.call(document.querySelectorAll('#rma-in-body input, #rma-in-body textarea, #rma-in-body select, #rma-in-body .ops-chip, #rma-in-body .rma-src-card, #rma-in-add'),
        function (x) { x.disabled = true; });
      f.units.forEach(function (r) { if (r.tray && typeof r.tray.lock === 'function') { try { r.tray.lock(true); } catch (e) { /* ignore */ } } });
      if (f.boxTray && typeof f.boxTray.lock === 'function') { try { f.boxTray.lock(true); } catch (e) { /* ignore */ } }
    }
    if (res && res.duplicate) toast('This RMA was already saved — showing it.', 'info');
    if (!f.doneUnits.length) {
      f.busy = false;
      if (form === f) {
        inStatus('The RMA was created, but the server did not return the RM codes. Find it on the board.', 'err');
        var c2 = el('rma-in-cancel'); if (c2) { c2.disabled = false; c2.textContent = 'Close'; }
      }
      destroyFormTrays(f);
      return;
    }

    // What the form recorded that the create call may not carry by itself:
    // the drive-data answer (A11) and the "no photos" note (A21).
    for (var di = 0; di < f.doneUnits.length && !isStale(g); di++) {
      var du = f.doneUnits[di];
      if (du.data_handling) {
        var live0 = unitById(du.id);
        if (!live0 || live0.data_handling !== du.data_handling) {
          try { await data().updateRma(du.id, { data_handling: du.data_handling }); }
          catch (e) { f.failures.push({ job: { label: 'the drive-data answer', unit: du, tray: null }, count: 0, error: errMsg(e) }); }
        }
      }
      if (f.noPhotos && !isStale(g)) { try { await data().rmaNote(du.id, 'Accepted without photos by ' + who + '.', false); } catch (e) { /* not worth a failure */ } }
    }

    // Photos, in part order; the unboxing photos go on the first part.
    var T = trays();
    var jobs = [];
    f.units.forEach(function (r, i) {
      var t = f.doneUnits[i];
      if (t && photoCount(r.tray)) jobs.push({ tray: r.tray, unit: t, label: 'part ' + (i + 1) });
    });
    if (photoCount(f.boxTray)) jobs.push({ tray: f.boxTray, unit: f.doneUnits[0], label: 'the box' });
    if (jobs.length && (!T || typeof T.uploadAll !== 'function')) {
      jobs.forEach(function (j) { f.failures.push({ job: j, count: photoCount(j.tray), error: 'The photo uploader is not loaded.' }); });
    } else {
      for (var k = 0; k < jobs.length && !isStale(g); k++) {
        var j = jobs[k];
        if (form === f) inStatus('Uploading photos for ' + j.label + ' (' + (k + 1) + ' of ' + jobs.length + ')…', '');
        var r2 = null, err = null;
        try {
          r2 = await T.uploadAll(j.tray, { caseId: j.unit.id }, (function (jj) {
            return function (done, total) { if (form === f) inStatus('Uploading photos for ' + jj.label + ' — ' + progressText(done, total), ''); };
          })(j));
        } catch (e) { err = e; }
        if (err) f.failures.push({ job: j, count: photoCount(j.tray), error: errMsg(err) });
        else if (r2 && r2.failed && r2.failed.length) f.failures.push({ job: j, count: r2.failed.length, error: (r2.failed[0] && r2.failed[0].error) || '' });
        forgetRoles(j.unit.id);
      }
    }
    f.busy = false;
    if (isStale(g)) { destroyFormTrays(f); return; }
    if (screenActive()) renderView();
    if (f.retired || form !== f) {
      var lost = f.failures.reduce(function (s, x) { return s + (x.count || 0); }, 0);
      toast('RMA logged: ' + f.doneUnits.map(function (u) { return u.public_code; }).join(', ') +
            (lost ? '. ' + lost + ' photo' + (lost === 1 ? '' : 's') + ' did not upload — add them from the part’s panel.' : '.'), lost ? 'warning' : 'success', 9000);
      destroyFormTrays(f);
      return;
    }
    paintIntakeDone(f);
  }

  function paintIntakeDone(f) {
    var body = el('rma-in-body');
    if (!body || form !== f) return;
    var many = f.doneUnits.length > 1;
    var failHtml = f.failures.length ? '<div class="rma-in-fails"><strong>Some things did not save.</strong>' +
      f.failures.map(function (x, i) {
        var what = x.job.tray ? ((x.count ? x.count + ' photo' + (x.count === 1 ? '' : 's') : 'Photos') + ' for ' + x.job.label) : x.job.label;
        return '<div class="rma-in-failrow">' + esc(what + ' (' + (x.job.unit.public_code || '') + ')' + (x.error ? ' — ' + x.error : '')) +
          (x.job.tray ? ' <button type="button" class="secondary-btn rma-small" data-retry="' + i + '">Retry</button>'
                      : ' <span class="rma-muted">Set it in the part’s Details tab.</span>') + '</div>';
      }).join('') + '</div>' : '';
    body.innerHTML = '<div class="rma-in-done">' +
      '<div class="rma-in-done-h">Logged ' + f.doneUnits.length + ' part' + (many ? 's' : '') + '</div>' +
      '<p class="sv-hint">Write the RM code on each part, or print the labels. The customer tracks each part with its own code.</p>' +
      f.doneUnits.map(function (u) {
        return '<div class="rma-in-done-row">' +
          '<div class="rma-in-done-code">' + esc(u.public_code || '') + '</div>' +
          '<div class="rma-in-done-what">' + esc(kindLabel(u.kind) + ' · ' + [u.brand, u.model].filter(Boolean).join(' ')) +
            '<div class="rma-muted">' + esc(staffStage(u.stage) + (u.tracking_phone ? ' · updates go to ' + showPhone(u.tracking_phone) : '')) + '</div></div>' +
          '<div class="rma-in-done-btns">' +
            '<button type="button" class="secondary-btn rma-small" data-done-copy="' + esc(u.public_code || '') + '">Copy code</button>' +
            (u.tracking_phone ? '<button type="button" class="secondary-btn rma-small" data-done-wa="' + esc(u.id) + '">Message on WhatsApp</button>' : '') +
            '<button type="button" class="secondary-btn rma-small" data-done-open="' + esc(u.id) + '">Open</button>' +
          '</div>' +
        '</div>';
      }).join('') +
      failHtml +
    '</div>';
    var foot = intakeRoot().querySelector('.rma-in-btns');
    if (foot) {
      foot.innerHTML = (canPrint() ? '<button type="button" class="secondary-btn" id="rma-in-print">Print label' + (many ? 's' : '') + '</button>' : '') +
        '<button type="button" class="secondary-btn" id="rma-in-another">New RMA</button>' +
        '<button type="button" class="primary-pink-btn" id="rma-in-done">Done</button>';
    }
    inStatus(f.failures.length ? 'Logged. Some things still need doing — see the list.' : 'Logged.', f.failures.length ? 'err' : 'ok');
    // Trays with nothing left to retry can go; a failed tray is kept for Retry.
    f.units.forEach(function (r) {
      var keep = f.failures.some(function (x) { return x.job.tray && x.job.tray === r.tray; });
      if (!keep && r.tray) { try { r.tray.destroy(); } catch (e) { /* gone */ } r.tray = null; }
    });
    if (f.boxTray && !f.failures.some(function (x) { return x.job.tray === f.boxTray; })) {
      try { f.boxTray.destroy(); } catch (e) { /* gone */ }
      f.boxTray = null;
    }
  }

  async function retryUpload(f, idx) {
    var g = sessionGen;
    var x = f.failures[idx];
    var T = trays();
    if (!x || !x.job.tray || f.busy || !T || typeof T.uploadAll !== 'function') return;
    f.busy = true;
    inStatus('Retrying photos for ' + x.job.label + '…', '');
    var r = null, err = null;
    try { r = await T.uploadAll(x.job.tray, { caseId: x.job.unit.id }, function () {}); } catch (e) { err = e; }
    f.busy = false;
    if (isStale(g)) { destroyFormTrays(f); return; }
    forgetRoles(x.job.unit.id);
    if (err) x.error = errMsg(err);
    else if (r && r.failed && r.failed.length) { x.count = r.failed.length; x.error = (r.failed[0] && r.failed[0].error) || ''; }
    else f.failures.splice(idx, 1);
    if (f.retired || form !== f) { destroyFormTrays(f); return; }
    paintIntakeDone(f);
  }

  function bindIntake() {
    var root = intakeRoot();
    if (!root || root.dataset.rmaBound) return;
    root.dataset.rmaBound = '1';
    if (ui() && typeof ui().bindChips === 'function') ui().bindChips(root);
    root.addEventListener('click', function (e) {
      var f = form;
      if (!f) return;
      var t = e.target;
      if (t.closest('#rma-in-close') || t.closest('#rma-in-cancel')) { closeIntake(false); return; }
      if (t.closest('#rma-in-done')) { closeIntake(true); return; }
      if (t.closest('#rma-in-another')) { closeIntake(true).then(function (ok) { if (ok) openIntake(); }); return; }
      if (t.closest('#rma-in-print')) { printLabels(f.doneUnits.slice()); return; }
      if (t.closest('#rma-in-create')) { submitIntake(); return; }
      if (t.closest('#rma-in-add')) { f.touched = true; addUnitCard(f); return; }
      var card = t.closest('.rma-src-card');
      if (card && !f.done && !f.busy) {
        f.source = card.getAttribute('data-source') || 'walk_in';
        if (f.source !== 'courier') f.inHand = true;
        else f.inHand = readChip(root, 'inhand') !== 'expected';
        f.touched = true;
        syncIntake(f);
        return;
      }
      var rm = t.closest('[data-act="remove-unit"]');
      if (rm) { var uc = rm.closest('.rma-in-unit'); if (uc) removeUnitCard(f, uc.getAttribute('data-ukey')); return; }
      var lb = t.closest('[data-link-build]');
      if (lb && !f.done) {
        var bc = lb.closest('.rma-in-unit');
        var rec = recOfCard(f, bc);
        if (rec) {
          var h = fel(rec.el, 'build_ticket_id');
          if (h) h.value = lb.getAttribute('data-link-build');
          setChip(rec.el, 'buy', 'neo_tokyo');
          var slot = rec.el.querySelector('[data-slot="build"]');
          if (slot) slot.innerHTML = '<div class="rma-build-hint is-linked">Linked to build #' + esc(lb.getAttribute('data-build-code') || '') + '.</div>';
          f.touched = true;
          syncIntake(f);
        }
        return;
      }
      var lo = t.closest('[data-lookup-open]');
      if (lo) {
        var uid = lo.getAttribute('data-lookup-open');
        closeIntake(false).then(function (ok) { if (ok) openUnit(uid); });
        return;
      }
      var cp = t.closest('[data-done-copy]');
      if (cp) { copyText(cp.getAttribute('data-done-copy'), 'RM code'); return; }
      var wa = t.closest('[data-done-wa]');
      if (wa) {
        var du = f.doneUnits.filter(function (u) { return u.id === wa.getAttribute('data-done-wa'); })[0];
        if (du) {
          var live = unitById(du.id);
          var mu = live ? msgUnit(live) : Object.assign({}, du, { owner_name: du.owner_phone ? du.owner_name : null });
          waSend(du.tracking_phone, waText('rma_received', mu, ''));
        }
        return;
      }
      var op = t.closest('[data-done-open]');
      if (op) {
        var oid = op.getAttribute('data-done-open');
        closeIntake(true).then(function (ok) { if (ok) openUnit(oid); });
        return;
      }
      var rt = t.closest('[data-retry]');
      if (rt) { retryUpload(f, Number(rt.getAttribute('data-retry'))); }
    });
    root.addEventListener('ops-chip-change', function (e) {
      var f = form;
      if (!f || f.done || !e.detail) return;
      f.touched = true;
      var g = e.detail.name;
      if (g === 'sender') {
        f.senderKind = readChip(root, 'sender') || 'customer';
        // Default each part's "who found the fault" from the sender — unless
        // someone already chose it for that part.
        f.units.forEach(function (r) { if (!r.diagTouched) setChip(r.el, 'diag', diagDefault(f.senderKind)); });
      } else if (g === 'inhand') {
        f.inHand = readChip(root, 'inhand') !== 'expected';
      } else if (g === 'ret') {
        f.ret = readChip(root, 'ret') || 'collect';
      } else if (g === 'diag') {
        var rec = recOfCard(f, e.target.closest && e.target.closest('.rma-in-unit'));
        if (rec) rec.diagTouched = true;
      }
      syncIntake(f);
    });
    root.addEventListener('input', function (e) {
      var f = form;
      if (!f || f.done) return;
      f.touched = true;
      var t = e.target;
      if (t.id === 'rma-in-phone') { onSenderPhone(f); syncIntake(f); return; }
      if (t.id === 'rma-in-name') { f.nameAuto = false; syncIntake(f); return; }
      var key = t.getAttribute && t.getAttribute('data-f');
      var rec = key ? recOfCard(f, t.closest('.rma-in-unit')) : null;
      if (key === 'fee') { if (rec) rec.feeTouched = true; return; }
      if (key === 'serial' && rec) { onCardSerial(f, rec); return; }
      if (key === 'owner_phone') syncIntake(f);
    });
    root.addEventListener('change', function (e) {
      var f = form;
      if (!f || f.done) return;
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-f') === 'kind') { f.touched = true; syncIntake(f); }
    });
    root.addEventListener('keydown', enterGuard);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ══════════════════════════════════════════════════════════════════════════
  var inited = false, subscribed = false, tickTimer = null;

  // The person is leaving (sign-out, or the login screen — also at boot, when
  // nothing is open). Called by the exported force-closes below, before the
  // panel and the form are closed. Touches no DOM and binds nothing, so it is
  // safe before init(). Work still in flight sees its generation go stale and
  // goes quiet (see sessionGen at the top). An upload reads its tray one file
  // at a time and skips the rest once the tray is destroyed (photo-tray's
  // uploadAll), so destroying the trays now stops each upload after the file
  // already on its way, instead of uploading on as nobody — or as the next
  // person.
  function endSession() {
    sessionGen++;
    openSeq++;                                    // a part still opening never pops up
    clearTimeout(serialTimer);
    serialSeq++;
    var stop = retiredTrays.slice();
    if (trayUploading && stop.indexOf(trayUploading) === -1) stop.push(trayUploading);
    retiredTrays = [];
    trayUploading = null;
    trayBusy = false;                             // the next person's first upload is not blocked
    // The tray still on screen goes with the panel (closeUnit → destroyUnitTray).
    stop.forEach(function (t) { if (t !== unitTray) { try { t.destroy(); } catch (e) { /* already gone */ } } });
    if (form && form.busy) destroyFormTrays(form);
    // What this session learnt about parts and what it had ticked was theirs.
    rolesCache = {};
    rolesInflight = {};                           // a stale ask must not block the next person's
    ticketFetched = {};
    shipSel = {};
  }

  function init() {
    if (!inited) {
      inited = true;
      initPrintGuards();
      // Capture phase on window. ops-ui's own capture listener (registered
      // first) closes a dialog or the lightbox on Esc and marks the event
      // handled; this one then stands down, so one Esc closes ONE layer —
      // not the dialog AND the panel underneath it.
      window.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.querySelector('.neo-confirm-overlay')) return;
        var u = ui();
        if (u && typeof u.isOverlayOpen === 'function' && u.isOverlayOpen()) return;
        var im = el('rma-intake-modal');
        if (im && im.classList.contains('active')) { e.preventDefault(); closeIntake(false); return; }
        if (panelOpen()) { e.preventDefault(); closeUnit(false); }
      }, true);
    }
    bindScreen();
    bindPanel();
    bindIntake();
  }

  function subscribe() {
    var d = data();
    if (subscribed || !d || typeof d.on !== 'function') return;
    subscribed = true;
    d.on('units', onUnitsChanged);
    d.on('intakes', onUnitsChanged);
    d.on('vendors', onUnitsChanged);
    d.on('jobs', onJobsChanged);
    d.on('access', function () {
      renderToolbar();
      if (screenActive()) renderView();
      if (openUnitId && panelOpen()) { paintActions(); if (unitTab === 'details') paintFee(); }
    });
  }

  // Realtime: repaint the board, and in the open panel only the parts that
  // hold no typed input — never the Details form or a half-written note.
  function onUnitsChanged() {
    if (screenActive()) renderView();
    if (!openUnitId || !panelOpen()) return;
    var u = unitById(openUnitId);
    if (!u) {
      var head = el('rma-u-head');
      if (head) head.innerHTML = '<div class="rma-gates is-note">This part is no longer on this machine’s board — demo data may have been switched, or it was removed. Close the panel to continue.</div>';
      return;
    }
    paintUnitHead();
    paintGates();
    paintActions();
    if (unitTab === 'details') {
      paintFee();
      if (moveBoxStage && u.stage !== moveBoxStage) {
        if (moveBoxPristine()) paintMoveBox();
        else setStatusId('rma-m-status', 'Someone moved this part to ' + staffStage(u.stage) + ' while you were here.', 'err',
          { label: 'Refresh', fn: function () { if (openUnitId === u.id) paintMoveBox(); } });
      }
    } else if (unitTab === 'ticket') {
      paintTab();
    }
  }
  function onJobsChanged() {
    if (screenActive() && view === 'board') renderView();
    if (openUnitId && panelOpen()) {
      paintUnitHead();
      if (unitTab === 'ticket') paintTab();
    }
  }

  async function ensureLoaded() {
    init();
    var d = data();
    var root = el('rma-root');
    renderToolbar();
    var miss = missingPiece();
    if (miss) { if (root) root.innerHTML = '<div class="rma-error">' + esc(miss) + '</div>'; return; }
    if (root && !root.querySelector('.rma-board, .rma-ship-head, .rma-vendors')) root.innerHTML = '<div class="sv-empty rma-loading">Loading RMA parts…</div>';
    // NeoQcData.ensureLoaded resolves with a status rather than rejecting;
    // whatever it reports is shown above the board (renderView), with a way
    // to try again, instead of a quietly empty screen.
    var st = null;
    try {
      st = await d.ensureLoaded();
      loadNote = (st && st.ok === false && st.errors && st.errors.auth) ? 'Could not load the RMA parts: ' + st.errors.auth : '';
    } catch (e) {
      loadNote = 'Could not load the RMA parts: ' + errMsg(e);
    }
    subscribe();
    if (!tickTimer) {
      // Ageing changes with the clock, not with events.
      tickTimer = setInterval(function () {
        if (screenActive() && view === 'board') renderView();
        if (openUnitId && panelOpen()) paintUnitHead();
      }, 60000);
    }
    render();
  }

  window.NeoQcRmaUI = {
    ensureLoaded: ensureLoaded,
    render: function () { init(); render(); },
    openUnit: function (id) { init(); return openUnit(id); },
    openIntake: function (opts) { init(); return openIntake(opts); },
    // The shell's sign-out and login-screen path (app.js closeSessionOverlays
    // calls both with true). force = the person is leaving: nothing is asked,
    // and whatever is still saving or uploading goes quiet (endSession) — no
    // toast on the login screen or in the next person's session. Without
    // force they ask first, as the panel's × does. Neither calls init(): with
    // nothing open they change nothing on screen, so they are safe at boot.
    // Both resolve true once closed (false only when an unforced close is
    // declined).
    closeUnit: function (force) {
      if (!force) return closeUnit(false);
      endSession();
      var p = closeUnit(true);                    // with force it closes before returning
      // Nothing of the last person's part is left in the page, hidden or not.
      var r = el('rma-unit-root');
      if (r) r.innerHTML = '';
      setText('rma-unit-title', '—');             // the markup's own placeholder
      setText('rma-unit-sub', '');
      return p;
    },
    closeIntake: function (force) {
      if (!force) return closeIntake(false);
      endSession();
      var p = closeIntake(true);
      var r = intakeRoot();
      if (r) r.innerHTML = '';
      return p;
    }
  };
})();
