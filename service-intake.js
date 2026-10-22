/*
  Neo Tokyo Operations — service intake: the "+ New ticket" form.

  One scrolling form, not a wizard. Someone is standing at the counter (or on
  the phone, or in a WhatsApp chat) and the desk needs to see the whole ticket
  at once and fill it in whatever order the customer talks. Sections, in order:
    1 how it came in · 2 where the work is · 3 the customer (phone first)
    4 items received (in-store) or a device line (on-site / remote)
    5 the fault · 6 data and passwords (in-store) or the visit / session
    details · 7 who should take it

  Rules this file lives by:
    - The phone comes first because it is the one thing that identifies a
      returning customer. Lookups are debounced and every response is checked
      against the number that is in the box NOW — a slow reply for a number
      that was since corrected must never fill in somebody else's name.
    - A ticket is created exactly once. client_request_id is minted when the
      form opens and reused on every retry, so a retry after a network error
      returns the ticket the first attempt made instead of a second one.
    - Photos are taken before the ticket exists (photo-tray.js holds them),
      uploaded after it is created, one at a time, against the job id bound at
      creation. A failed photo stays listed with Retry; nothing is dropped
      silently.
    - Enter in a field never submits (a USB scanner types into the serial box
      and ends with Enter). Esc asks before throwing typed work away.
    - Writes go through NeoQcData only. Anything a customer or staff member
      typed is put on screen with textContent, or through esc() inside element
      content / double-quoted attributes — never raw innerHTML.
    - The shop never backs up customer data (sql/service-v2.1.sql). For a
      device in hand the desk must record what the customer did about it.
    - A device password, if the customer gives one, is never part of the
      create payload, a toast, a log or the console. It is saved with its own
      call (NeoQcData.setDevicePassword) once the ticket exists, before the
      photos; a failed save keeps it in memory with Retry, and closing the
      form asks first, so it is never lost silently.

  Renders into #sv-intake-root inside #sv-intake-modal (index.html).
  Global: window.NeoQcServiceIntake = { open({preset}), close({force}), presetFromRma(unit) }.
  close({force:true}) is the sign-out close: it asks nothing, and whatever the
  closed forms still have in flight finishes without a toast or a repaint.
*/
(function () {
  'use strict';

  var MAX_ITEMS = 20;                 // service_create accepts at most 20 items
  var DEMO_MSG = 'Demo data is read-only. Turn it off in Settings to work on real tickets.';
  var TRACK_URL = 'https://neoqctracker.netlify.app/?view=service&code=';
  var DAY = 86400000;

  // Labels used when shared/service-status.js is older than this file. The
  // shared module is the source of truth; these only keep the form usable.
  var FALLBACK = {
    CHANNELS: { walk_in: 'Walk-in', phone: 'Phone', whatsapp: 'WhatsApp', website: 'Website', courier: 'Courier', staff: 'Staff' },
    TYPES: { in_store: { label: 'In-store' }, on_site: { label: 'On-site' }, remote: { label: 'Remote' } },
    CATEGORIES: {
      repair: 'Repair', warranty_claim: 'Warranty claim', upgrade: 'Upgrade', installation: 'Installation',
      data_recovery: 'Data recovery', os_software: 'OS / software', networking: 'Networking',
      maintenance: 'Maintenance', diagnosis_only: 'Diagnosis only'
    },
    PRIORITIES: { low: { label: 'Low', rank: 0 }, normal: { label: 'Normal', rank: 1 }, high: { label: 'High', rank: 2 }, urgent: { label: 'Urgent', rank: 3 } },
    ITEM_KINDS: {
      pc: 'Desktop PC', laptop: 'Laptop', gpu: 'Graphics card', psu: 'Power supply', ram: 'RAM', ssd: 'SSD',
      hdd: 'Hard drive', motherboard: 'Motherboard', cpu: 'Processor', cooler: 'Cooler', monitor: 'Monitor',
      peripheral: 'Peripheral', other: 'Other'
    }
  };
  var CHANNEL_KEYS = ['walk_in', 'phone', 'whatsapp', 'website', 'courier', 'staff'];
  var TYPE_KEYS = ['in_store', 'on_site', 'remote'];
  var PRIO_KEYS = ['low', 'normal', 'high', 'urgent'];
  var PRIO_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
  var SOURCE_OPTS = [
    { value: 'neo_tokyo', label: 'Neo Tokyo build' },
    { value: 'elsewhere', label: 'Bought elsewhere' },
    { value: 'unknown', label: 'Not sure' }
  ];
  var POWER_OPTS = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
    { value: 'unknown', label: 'Didn\u2019t check' }
  ];
  var INHAND_OPTS = [
    { value: 'yes', label: 'Here now' },
    { value: 'no', label: 'Not yet \u2014 the customer will bring it' }
  ];
  // What the CUSTOMER did about their data: the shop never backs it up. The
  // labels are shared/service-status.js's DATA_CONSENTS; the 1.10.0-beta.1
  // answers (backup_ok / no_backup) stay valid there but are never offered.
  var CONSENT_OPTS = [
    { value: 'customer_backed_up', label: 'Customer backed up their data' },
    { value: 'no_important_data', label: 'No important data on it' },
    { value: 'customer_accepts_risk', label: 'Customer accepts the risk — no backup' }
  ];
  var NO_BACKUP_NOTICE = 'We don’t back up customer data. Ask the customer to back up their drives on their own disks before leaving the device. Neo Tokyo is not responsible for data on it.';
  var PW_HELP = 'Kept only for the technician working on it, hidden on screen, and deleted automatically when the ticket closes.';
  var PW_MAX = 500;                   // service_secrets.secret is 1–500 characters
  var TOOL_OPTS = [
    { value: 'anydesk', label: 'AnyDesk' },
    { value: 'teamviewer', label: 'TeamViewer' },
    { value: 'rustdesk', label: 'RustDesk' },
    { value: 'quick_assist', label: 'Quick Assist' },
    { value: 'chrome_remote', label: 'Chrome Remote Desktop' },
    { value: 'other', label: 'Other' }
  ];
  var FALLBACK_ACCESSORIES = ['Power cable', 'Charger', 'Bag', 'Box', 'Keyboard', 'Mouse', 'Wi-Fi antenna', 'HDMI / DP cable', 'Drive', 'Manual'];
  var FALLBACK_CONDITIONS = ['No visible damage', 'Scratches', 'Dents', 'Cracked panel', 'Missing screws', 'Broken clip', 'Liquid marks', 'Burn marks', 'Seal broken', 'Dusty'];
  var TRAY_OPTS = { roles: ['condition', 'damage', 'serial_label'], defaultRole: 'condition', minPhotos: 0, label: 'Condition photos' };

  var F = null;          // the open form; replaced wholesale by every open()
  var formSeq = 0;       // generation counter; async work compares F.token with the one it started under
  // Forms whose token is at or below this were closed by close({force:true})
  // (sign-out). Their session is stale: anything they still have in flight (a
  // create, the no-photo note, an upload, an "open the ticket") finishes
  // without a toast, so nothing of theirs lands on the login screen or in the
  // next person's session. Repaints are already impossible for them: F has
  // moved on, so every `F.token === token` check fails.
  var staleThrough = 0;
  var keysBound = false;

  // ── module lookups ─────────────────────────────────────────────────────────
  function S() { return window.NeoQcService || null; }
  function C() { return window.NeoQcCatalog || null; }
  function UI() { return window.NeoQcUI || null; }
  function D() { return window.NeoQcData || null; }
  function PT() { return window.NeoQcPhotoTray || null; }

  function mapOf(name) {
    var s = S();
    return (s && s[name]) || FALLBACK[name] || {};
  }
  function labelOf(map, key) {
    var v = map ? map[key] : null;
    if (typeof v === 'string') return v;
    if (v && v.label) return String(v.label);
    return key == null ? '' : String(key);
  }
  function typeLabel(t) { return labelOf(mapOf('TYPES'), t); }
  function channelLabel(c) { return labelOf(mapOf('CHANNELS'), c); }
  function categoryLabel(c) { return labelOf(mapOf('CATEGORIES'), c); }
  function prioLabel(p) { return labelOf(mapOf('PRIORITIES'), p); }
  function kindLabel(k) { return labelOf(mapOf('ITEM_KINDS'), k); }
  function stageLabel(st) {
    var s = S();
    return s && typeof s.staffLabel === 'function' ? s.staffLabel(st) : String(st || '');
  }
  function rmaStageLabel(st) {
    var s = S();
    return s && typeof s.rmaStaffLabel === 'function' ? s.rmaStaffLabel(st) : String(st || '');
  }

  // ── small helpers ──────────────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }

  // Escapes single quotes as well, so it is safe even where escapeHtmlLite is
  // not. Still only used in element content and double-quoted attributes.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isDemoErr(e) { return !!e && (e === 'DEMO_READONLY' || e.message === 'DEMO_READONLY'); }

  function errText(e) {
    var u = UI();
    if (u && typeof u.errText === 'function') {
      try { var t = u.errText(e); if (t) return String(t); } catch (x) { /* local copy below */ }
    }
    if (isDemoErr(e)) return DEMO_MSG;
    var m = (e && (e.message || e.error_description || e.details)) || (typeof e === 'string' ? e : '') || 'Something went wrong.';
    m = String(m);
    var neo = /^NEO_[A-Z_]+:\s*([\s\S]*)$/.exec(m);
    if (neo) return neo[1];
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(m)) {
      return 'Couldn\u2019t reach the server. Check the internet connection and try again.';
    }
    return m;
  }

  function toast(msg, type) { if (typeof showToast === 'function') showToast(msg, type || 'info'); }
  // For a toast that can come after an await, from the form with this token.
  // Silent once a sign-out has made that form's session stale (staleThrough).
  function isStale(token) { return !(Number(token) > staleThrough); }
  function lateToast(token, msg, type) { if (!isStale(token)) toast(msg, type); }

  function confirmBox(msg, opts) {
    if (typeof showConfirm === 'function') return showConfirm(msg, opts || {});
    // Only the dev harness could lack showConfirm; a blocking confirm there is fine.
    try { return Promise.resolve(window.confirm(msg)); } catch (e) { return Promise.resolve(false); }
  }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'cls') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function me() {
    var d = D();
    if (d && typeof d.me === 'function') { try { var p = d.me(); if (p) return p; } catch (e) { /* fall back */ } }
    return (typeof currentProfile !== 'undefined' && currentProfile) || null;
  }
  function myName() { var p = me(); return (p && (p.full_name || p.email)) || 'staff'; }
  function serviceRole() {
    var d = D();
    if (d && typeof d.role === 'function') { try { return d.role('service') || null; } catch (e) { return null; } }
    var p = me();
    return p && Number(p.tier) >= 3 ? 'lead' : null;
  }
  function isLead() { return serviceRole() === 'lead'; }
  // "I'll take it myself" is for service-pool members only (v1.11, WQ-A1/C3):
  // the server drops assign_self for anyone else, so the box is not offered
  // to them. Being a lead does not put anyone in the pool.
  function canTakeSelf() {
    var M = window.NeoQcModules;
    if (!M || typeof M.pools !== 'function') return false;
    try { return M.pools().service === true; } catch (e) { return false; }
  }
  function isDemo() {
    var d = D();
    try { return !!(d && typeof d.isDemo === 'function' && d.isDemo()); } catch (e) { return false; }
  }

  // The unified phone rule (SPEC-AMENDMENTS A1'), the same everywhere: SQL
  // norm_phone()/phone_ok(), the desktop and the website. Its one JS source is
  // shared/service-catalog.js (NeoQcCatalog.normPhone / phoneOk). The inline
  // copies below run only when the loaded catalog predates them, and must
  // stay identical to it.
  //   normPhone(raw): digits only; one leading '00' (the international
  //     dialling prefix) is dropped; then 10 digits -> 91 + d, 0 + 10 digits
  //     -> 91 + d, anything else stays its own digits. The country code is
  //     KEPT, so a Gulf or NRI customer's number survives, and 00971... is
  //     the same customer as +971....
  //   phoneOk(norm): 12 to 15 digits, or 11 digits for Kuwait (965), Oman
  //     (968), Bahrain (973) and Qatar (974), whose numbers are a 3-digit
  //     code plus 8 digits. Nothing else: an 11-digit Indian typo is refused.
  var PHONE_GULF_11 = ['965', '968', '973', '974'];
  function localNormPhone(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }
  function localPhoneOk(norm) {
    var n = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(n)) return false;
    if (n.length >= 12 && n.length <= 15) return true;
    return n.length === 11 && PHONE_GULF_11.indexOf(n.slice(0, 3)) !== -1;
  }
  function normPhone(raw) {
    var c = C();
    if (c && typeof c.normPhone === 'function') {
      try { return String(c.normPhone(raw) || ''); } catch (e) { /* inline copy */ }
    }
    return localNormPhone(raw);
  }
  // Takes a NORMALISED number (what normPhone returns), like NeoQcCatalog.phoneOk.
  function phoneOk(norm) {
    var c = C();
    if (c && typeof c.phoneOk === 'function') {
      try { return !!c.phoneOk(norm); } catch (e) { /* inline copy */ }
    }
    return localPhoneOk(norm);
  }
  function fmtPhone(norm) {
    var u = UI();
    if (u && typeof u.fmtPhone === 'function') { try { return String(u.fmtPhone(norm)); } catch (e) { /* local copy */ } }
    var n = String(norm || '');
    return n.length === 12 && n.indexOf('91') === 0 ? '+91 ' + n.slice(2, 7) + ' ' + n.slice(7) : (n ? '+' + n : '');
  }

  function uuid() {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); }
    catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hx = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return hx.slice(0, 8) + '-' + hx.slice(8, 12) + '-' + hx.slice(12, 16) + '-' + hx.slice(16, 20) + '-' + hx.slice(20);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayYmd() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function ymdOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }

  // Date-only fields mean the end of that working day, local time (same rule as dayToIso elsewhere).
  function dayToIso(day) {
    if (!day) return null;
    var u = UI();
    if (u && typeof u.dayToIso === 'function') { try { return u.dayToIso(day); } catch (e) { /* local copy */ } }
    var d = new Date(day + 'T18:00:00');
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // datetime-local values are LOCAL wall-clock time. new Date('YYYY-MM-DDTHH:mm')
  // parses as local, which is exactly what is wanted; never append a 'Z'.
  function fromLocalInput(v) {
    if (!v) return null;
    var u = UI();
    if (u && typeof u.fromLocalInput === 'function') { try { return u.fromLocalInput(v); } catch (e) { /* local copy */ } }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function fmtMinutes(m) {
    m = Math.round(Number(m) || 0);
    if (m <= 0) return '\u2014';
    if (m < 60) return m + ' min';
    var hh = Math.floor(m / 60), mm = m % 60;
    return hh + ' h' + (mm ? ' ' + mm + ' min' : '');
  }
  function fmtDay(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
    catch (e) { return ''; }
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

  // The modal actually in front (see photo-tray.js for the same rule).
  function topOverlay() {
    if (document.querySelector('.neo-confirm-overlay')) return 'blocked';
    var list = document.querySelectorAll('.modal-overlay.active');
    var best = null, bestZ = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var z = parseInt(window.getComputedStyle(list[i]).zIndex, 10);
      if (isNaN(z)) z = 0;
      if (z >= bestZ) { best = list[i]; bestZ = z; }
    }
    return best;
  }

  function openExternal(url) {
    if (!url || !/^https:\/\//i.test(String(url))) return false;
    try {
      var el = (typeof require === 'function') ? require('electron') : null;
      if (el && el.shell && typeof el.shell.openExternal === 'function') { el.shell.openExternal(String(url)); return true; }
    } catch (e) { /* not in Electron */ }
    try { window.open(String(url), '_blank', 'noopener'); return true; } catch (e) { return false; }
  }

  // ── pure text helpers (exposed for tests) ──────────────────────────────────
  // Condition chips edit the remarks TEXT rather than a hidden list, so what the
  // desk sees in the box is exactly what is saved. A chip is "on" when its label
  // is one of the comma-separated parts.
  function hasPart(text, label) {
    var want = String(label).trim().toLowerCase();
    return String(text || '').split(',').some(function (p) { return p.trim().toLowerCase() === want; });
  }
  function addPart(text, label) {
    var t = String(text || '').replace(/[\s,;]+$/, '');
    return t ? t + ', ' + label : String(label);
  }
  function removePart(text, label) {
    var want = String(label).trim().toLowerCase();
    var parts = String(text || '').split(',');
    var kept = parts.filter(function (p) { return p.trim().toLowerCase() !== want; });
    if (kept.length === parts.length) return String(text || '');
    return kept.join(',').replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
  }
  function isNoDamage(label) { return /^no visible damage$/i.test(String(label).trim()); }
  function toggleConditionText(text, label, allLabels) {
    if (hasPart(text, label)) return removePart(text, label);
    var out = String(text || '');
    // "No visible damage" and any damage are contradictory; picking one drops the other.
    (allLabels || []).forEach(function (l) {
      if (isNoDamage(label) ? !isNoDamage(l) : isNoDamage(l)) out = removePart(out, l);
    });
    return addPart(out, label);
  }

  // A Google Maps / WhatsApp location link -> {lat, lng} or null. The !3d!4d
  // pair is the dropped pin itself, so it is tried before the map centre (@).
  // Short links (maps.app.goo.gl) carry no coordinates at all.
  function parseMapsLink(s) {
    var raw = String(s || '').trim();
    if (!raw) return null;
    var dec = raw;
    try { dec = decodeURIComponent(raw); } catch (e) { dec = raw; }
    var num = '(-?\\d{1,3}(?:\\.\\d+)?)';
    var sep = ',[\\s+]*';
    var pats = [
      new RegExp('!3d' + num + '!4d' + num),
      new RegExp('@' + num + sep + num),
      new RegExp('[?&](?:q|query|ll|sll|destination|daddr|center|saddr)=(?:loc:)?' + num + sep + num),
      new RegExp('/(?:place|search|dir)/' + num + sep + num),
      new RegExp('^' + num + sep + num + '$')
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(dec);
      if (!m) continue;
      var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (lat === 0 && lng === 0) continue;
      return { lat: lat, lng: lng };
    }
    return null;
  }
  function isShortMapsLink(s) { return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(String(s || '').trim()); }
  function isHttpUrl(s) { return /^https?:\/\/[^\s]+$/i.test(String(s || '').trim()); }

  function guessKind(text) {
    var t = String(text || '').toLowerCase();
    if (/laptop|notebook|macbook|thinkpad|ideapad|vivobook|zenbook|inspiron|pavilion|aspire|rog strix g|tuf gaming f/.test(t)) return 'laptop';
    if (/\b(pc|desktop|computer|tower|cabinet|workstation)\b/.test(t)) return 'pc';
    if (/\b(monitor)\b/.test(t)) return 'monitor';
    if (/printer|router|modem|\bswitch\b|access point|keyboard|mouse/.test(t)) return 'peripheral';
    return 'other';
  }

  function defaultInHand(channel) {
    // A walk-in, a courier box on the desk or a staff hand-over means the device
    // is here. A phone call, a chat or a web request means it is not yet, and
    // calling it "received" would start the clock and tell the customer's
    // tracking page "your item is with us" before it is.
    return channel === 'walk_in' || channel === 'courier' || channel === 'staff';
  }

  // ── catalog access ─────────────────────────────────────────────────────────
  function faults() { var c = C(); return (c && Array.isArray(c.FAULTS)) ? c.FAULTS : []; }
  function faultByKey(k) {
    var list = faults();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === k) return list[i];
    return null;
  }
  function accessoryLabels() { var c = C(); return (c && Array.isArray(c.ACCESSORIES) && c.ACCESSORIES.length) ? c.ACCESSORIES.map(String) : FALLBACK_ACCESSORIES; }
  function conditionLabels() { var c = C(); return (c && Array.isArray(c.CONDITION_CHIPS) && c.CONDITION_CHIPS.length) ? c.CONDITION_CHIPS.map(String) : FALLBACK_CONDITIONS; }

  // ── chips (local, so the form controls exactly when "changed" happens) ─────
  // Same markup contract as NeoQcUI.chips (data-chip-group, data-value,
  // aria-pressed), styled by intake.css.
  function chipsHtml(group, options, selected, cfg) {
    cfg = cfg || {};
    var sel = Array.isArray(selected) ? selected : (selected == null ? [] : [selected]);
    return '<div class="svi-chips" role="group" data-group="' + esc(group) + '"' +
      (cfg.multi ? ' data-multi="1"' : '') + (cfg.optional ? ' data-optional="1"' : '') +
      (cfg.label ? ' aria-label="' + esc(cfg.label) + '"' : '') + '>' +
      options.map(function (o) {
        var on = sel.indexOf(o.value) !== -1;
        return '<button type="button" class="svi-chip' + (o.cls ? ' ' + esc(o.cls) : '') + '" data-chip-group="' + esc(group) +
          '" data-value="' + esc(o.value) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
          (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' + esc(o.label) + '</button>';
      }).join('') + '</div>';
  }
  function chipGroup(scope, group) {
    return scope ? scope.querySelector('.svi-chips[data-group="' + group + '"]') : null;
  }
  function readChips(scope, group) {
    var g = chipGroup(scope, group);
    var multi = !!g && g.getAttribute('data-multi') === '1';
    if (!g) return multi ? [] : null;
    var vals = [];
    g.querySelectorAll('.svi-chip[aria-pressed="true"]').forEach(function (b) { vals.push(b.getAttribute('data-value')); });
    return multi ? vals : (vals[0] || null);
  }
  function setChips(scope, group, values) {
    var g = chipGroup(scope, group);
    if (!g) return;
    var want = Array.isArray(values) ? values : (values == null ? [] : [values]);
    g.querySelectorAll('.svi-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', want.indexOf(b.getAttribute('data-value')) !== -1 ? 'true' : 'false');
    });
  }

  // ── icons (inline SVG, no fonts) ───────────────────────────────────────────
  var LOCAL_ICONS = {
    in_store: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.6-5h14.8L21 9"/><path d="M4 9v11h16V9"/><path d="M9.5 20v-5.5h5V20"/><path d="M3 9h18"/></svg>',
    on_site: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.2a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.6"/></svg>',
    remote: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M9 10l2 2 4-4"/></svg>'
  };
  function typeIcon(t) {
    var u = UI();
    if (u && typeof u.typeIcon === 'function') {
      try { var s = u.typeIcon(t); if (s && /^\s*<svg[\s>]/i.test(s)) return s; } catch (e) { /* local icon */ }
    }
    return LOCAL_ICONS[t] || '';
  }

  // ── markup ─────────────────────────────────────────────────────────────────
  function fieldHtml(label, inner, cfg) {
    cfg = cfg || {};
    return '<label class="svi-field' + (cfg.wide ? ' svi-span2' : '') + (cfg.cls ? ' ' + cfg.cls : '') + '"' +
      (cfg.id ? ' id="' + cfg.id + '"' : '') + '><span>' + esc(label) +
      (cfg.req ? ' <em>required</em>' : '') + (cfg.opt ? ' <em class="opt">' + esc(cfg.opt) + '</em>' : '') +
      '</span>' + inner + '</label>';
  }
  function inputHtml(id, cfg) {
    cfg = cfg || {};
    return '<input type="' + (cfg.type || 'text') + '"' + (id ? ' id="' + id + '"' : '') +
      (cfg.f ? ' data-f="' + cfg.f + '"' : '') +
      (cfg.value != null && cfg.value !== '' ? ' value="' + esc(cfg.value) + '"' : '') +
      (cfg.placeholder ? ' placeholder="' + esc(cfg.placeholder) + '"' : '') +
      (cfg.maxlength ? ' maxlength="' + cfg.maxlength + '"' : '') +
      (cfg.inputmode ? ' inputmode="' + cfg.inputmode + '"' : '') +
      (cfg.min != null ? ' min="' + esc(cfg.min) + '"' : '') +
      (cfg.max != null ? ' max="' + esc(cfg.max) + '"' : '') +
      (cfg.step ? ' step="' + cfg.step + '"' : '') +
      ' autocomplete="off" spellcheck="false">';
  }
  function secHead(n, title, id) {
    return '<h3 class="svi-h"' + (id ? ' id="' + id + '"' : '') + '><span class="svi-n" aria-hidden="true">' + n + '</span><span class="svi-h-t">' + esc(title) + '</span></h3>';
  }

  function shellHtml() {
    var chan = CHANNEL_KEYS.map(function (k) { return { value: k, label: channelLabel(k) }; });
    var typeDesc = {
      in_store: 'The device is at the shop, or will be brought in',
      on_site: 'A technician goes to the customer',
      remote: 'We connect to their PC over the internet'
    };
    var types = TYPE_KEYS.map(function (t) {
      return '<button type="button" class="svi-type" data-type="' + t + '" aria-pressed="false">' +
        '<span class="svi-type-ic">' + typeIcon(t) + '</span>' +
        '<span class="svi-type-t">' + esc(typeLabel(t)) + '</span>' +
        '<span class="svi-type-d">' + esc(typeDesc[t]) + '</span>' +
        '<span class="svi-type-sug">Suggested from the fault</span>' +
      '</button>';
    }).join('');
    var cats = mapOf('CATEGORIES');
    var catOpts = '<option value="">Auto \u2014 decided by the fault</option>' + Object.keys(cats).map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(categoryLabel(k)) + '</option>';
    }).join('');
    var prioOpts = '<option value="">Auto</option>' + PRIO_KEYS.map(function (k) {
      return '<option value="' + k + '">' + esc(prioLabel(k)) + '</option>';
    }).join('');
    var today = todayYmd();

    return '' +
    '<div class="svi-shell">' +
      '<div class="modal-header svi-head">' +
        '<div class="svi-head-text">' +
          '<h2 id="svi-title">New service ticket</h2>' +
          '<div id="svi-sub" class="svi-sub">Phone first \u2014 it tells us if they have been here before.</div>' +
        '</div>' +
        '<button type="button" id="svi-close" class="close-btn" aria-label="Close" title="Close">&times;</button>' +
      '</div>' +
      '<div class="modal-body svi-body" id="svi-body">' +
        '<div id="svi-demo"></div>' +
        '<fieldset class="svi-form" id="svi-form">' +

          // 1 — channel
          '<section class="svi-sec" data-sec="channel">' + secHead(1, 'How did it come in?') +
            chipsHtml('channel', chan, 'walk_in', { label: 'How did it come in?' }) +
            '<div id="svi-wa" class="svi-wa hidden">' +
              fieldHtml('Paste the chat', '<textarea id="svi-wa-text" rows="5" placeholder="Copy the messages from WhatsApp (or Export chat \u2192 Without media) and paste them here"></textarea>', { opt: 'optional' }) +
              '<div class="svi-row"><button type="button" id="svi-wa-fill" class="secondary-btn svi-btn-sm">Fill from chat</button>' +
              '<span id="svi-wa-msg" class="svi-note" role="status"></span></div>' +
            '</div>' +
          '</section>' +

          // 2 — type
          '<section class="svi-sec" data-sec="type">' + secHead(2, 'Where is the work?') +
            '<div class="svi-types" role="group" aria-label="Where is the work?">' + types + '</div>' +
            '<div id="svi-type-hint" class="svi-note" role="status"></div>' +
          '</section>' +

          // 3 — customer
          '<section class="svi-sec" data-sec="customer" id="svi-sec-customer">' + secHead(3, 'Customer') +
            '<div class="svi-grid">' +
              fieldHtml('Phone', inputHtml('svi-phone', { type: 'tel', inputmode: 'numeric', maxlength: 20, placeholder: 'Mobile, e.g. 98470 12345 (add +971… for abroad)' }), { req: true }) +
              fieldHtml('Name', inputHtml('svi-name', { maxlength: 120, placeholder: 'As the customer gives it' }), { req: true }) +
              fieldHtml('Email', inputHtml('svi-email', { type: 'email', maxlength: 160 }), { opt: 'optional' }) +
              '<label class="svi-check svi-check-tight"><input type="checkbox" id="svi-business"> Business customer</label>' +
            '</div>' +
            '<div class="svi-err" data-err="customer" role="alert"></div>' +
            '<div id="svi-lookup" class="svi-lookup" aria-live="polite"></div>' +
          '</section>' +

          // 4 — items (in-store)
          '<section class="svi-sec" data-sec="items" id="svi-sec-items">' + secHead(4, 'Items received') +
            '<div class="svi-q"><span class="svi-q-l">Is it here now?</span>' + chipsHtml('inhand', INHAND_OPTS, 'yes', { label: 'Is it here now?' }) + '</div>' +
            '<div id="svi-inhand-hint" class="svi-note hidden">Fill in what you know. Condition photos can wait until it arrives.</div>' +
            '<div id="svi-items" class="svi-items"></div>' +
            '<button type="button" id="svi-add-item" class="secondary-btn svi-btn-sm svi-add">+ Add item</button>' +
          '</section>' +

          // 4 — device line (on-site / remote)
          '<section class="svi-sec hidden" data-sec="device" id="svi-sec-device">' + secHead(4, 'Device') +
            fieldHtml('Device', inputHtml('svi-device', { maxlength: 160, placeholder: 'e.g. Office desktop, HP laptop, Wi-Fi router' }), { opt: 'optional' }) +
          '</section>' +

          // 5 — fault
          '<section class="svi-sec" data-sec="fault">' + secHead(5, 'Fault') +
            '<div id="svi-faults" class="svi-faults"></div>' +
            fieldHtml('In the customer\u2019s words', '<textarea id="svi-fault-text" rows="3" maxlength="2000" placeholder="What they say is wrong, in their words"></textarea>', { opt: 'needed unless you pick a fault above', wide: true }) +
            '<div class="svi-err" data-err="fault" role="alert"></div>' +
            '<div id="svi-summary" class="svi-summary" aria-live="polite"></div>' +
            '<div class="svi-grid">' +
              '<div id="svi-prio-lead" class="svi-prio-lead hidden">' +
                fieldHtml('Priority', '<select id="svi-prio" class="settings-select">' + prioOpts + '</select>', { opt: 'leads can change it' }) +
                fieldHtml('Why this priority?', inputHtml('svi-prio-reason', { maxlength: 200, placeholder: 'e.g. Customer travels tomorrow' }), { cls: 'hidden', id: 'svi-prio-reason-wrap' }) +
              '</div>' +
              '<p id="svi-prio-desk" class="svi-hint svi-span2">The priority is worked out from the fault and the customer. A lead can change it.</p>' +
              fieldHtml('Category', '<select id="svi-category" class="settings-select">' + catOpts + '</select>') +
              fieldHtml('Customer needs it by', inputHtml('svi-needed-by', { type: 'date', min: today }), { opt: 'optional' }) +
            '</div>' +
            '<div class="svi-err" data-err="needed" role="alert"></div>' +
          '</section>' +

          // 6 — type-specific
          '<section class="svi-sec" data-sec="ts">' + secHead(6, 'Data and passwords', 'svi-ts-title') +
            '<div id="svi-ts-in_store">' +
              '<div class="svi-notice" role="note">' + esc(NO_BACKUP_NOTICE) + '</div>' +
              '<div class="svi-q"><span class="svi-q-l">Customer data <em id="svi-consent-req">required</em></span>' +
                chipsHtml('data_consent', CONSENT_OPTS, null, { optional: true, label: 'Customer data' }) + '</div>' +
              '<div class="svi-err" data-err="data" role="alert"></div>' +
              // Not a <label> around the row: the Show button must not be
              // inside a label (a click on it would also focus the input).
              '<div class="svi-field svi-pw">' +
                '<label for="svi-pw" class="svi-pw-l">Device password / PIN <em class="opt">if any</em></label>' +
                '<div class="svi-pw-row">' +
                  '<input type="password" id="svi-pw" maxlength="' + PW_MAX + '" autocomplete="new-password" autocapitalize="off" spellcheck="false"' +
                    ' placeholder="Only if the customer uses one" aria-describedby="svi-pw-help">' +
                  '<button type="button" id="svi-pw-show" class="secondary-btn svi-btn-sm" aria-pressed="false" aria-controls="svi-pw">Show</button>' +
                '</div>' +
                '<p id="svi-pw-help" class="svi-hint">' + esc(PW_HELP) + '</p>' +
              '</div>' +
              '<div class="svi-err" data-err="pw" role="alert"></div>' +
            '</div>' +
            '<div id="svi-ts-on_site" class="hidden">' +
              '<div class="svi-grid">' +
                fieldHtml('Site address', '<textarea id="svi-site-address" rows="2" maxlength="400" placeholder="Building, street, locality"></textarea>', { wide: true }) +
                fieldHtml('Area', inputHtml('svi-site-area', { maxlength: 80, placeholder: 'e.g. Kakkanad' })) +
                fieldHtml('Pincode', inputHtml('svi-site-pincode', { inputmode: 'numeric', maxlength: 6 }), { opt: 'optional' }) +
                fieldHtml('Landmark', inputHtml('svi-site-landmark', { maxlength: 120 }), { opt: 'optional' }) +
                fieldHtml('Site contact', inputHtml('svi-site-contact', { maxlength: 120, placeholder: 'Who to ask for on site, if not the customer' }), { opt: 'optional' }) +
                fieldHtml('Google Maps link', inputHtml('svi-site-maps', { maxlength: 600, placeholder: 'Paste the location link from WhatsApp or Maps' }), { wide: true, opt: 'optional' }) +
                '<div id="svi-maps-msg" class="svi-note svi-span2" role="status"></div>' +
                fieldHtml('Machines to look at', inputHtml('svi-machines', { type: 'number', min: 1, max: 500, step: 1, value: '1', inputmode: 'numeric' })) +
              '</div>' +
              '<div class="svi-err" data-err="site" role="alert"></div>' +
            '</div>' +
            '<div id="svi-ts-remote" class="hidden">' +
              '<div class="svi-q"><span class="svi-q-l">Tool</span>' + chipsHtml('remote_tool', TOOL_OPTS, null, { optional: true, label: 'Remote tool' }) + '</div>' +
              '<div class="svi-grid">' +
                fieldHtml('Session ID', inputHtml('svi-rm-session', { maxlength: 80, placeholder: 'The ID the customer reads out' }), { opt: 'optional' }) +
              '</div>' +
              '<p class="svi-hint">Never write a password here \u2014 only the session ID. The customer types any password themselves during the session.</p>' +
              '<label class="svi-check"><input type="checkbox" id="svi-rm-consent"> Customer agreed to remote access</label>' +
              '<div class="svi-err" data-err="remote" role="alert"></div>' +
            '</div>' +
            '<div id="svi-window" class="svi-window hidden">' +
              '<div class="svi-sub-h">When is the customer available?</div>' +
              '<div class="svi-grid">' +
                fieldHtml('From', inputHtml('svi-win-from', { type: 'datetime-local' }), { opt: 'optional' }) +
                fieldHtml('Until', inputHtml('svi-win-to', { type: 'datetime-local' }), { opt: 'optional' }) +
                fieldHtml('Availability note', inputHtml('svi-win-note', { maxlength: 200, placeholder: 'e.g. weekdays after 5 pm' }), { wide: true, opt: 'optional' }) +
              '</div>' +
              '<div class="svi-err" data-err="window" role="alert"></div>' +
            '</div>' +
          '</section>' +

          // 7 — who
          '<section class="svi-sec" data-sec="who">' + secHead(7, 'Who should take it?') +
            '<div class="svi-grid">' +
              fieldHtml('Suggest a technician', '<select id="svi-tech" class="settings-select"></select>', { opt: 'optional \u2014 the ticket still goes to the queue' }) +
              fieldHtml('Why them?', inputHtml('svi-tech-reason', { maxlength: 200, placeholder: 'e.g. Served this customer before' }), { opt: 'optional' }) +
            '</div>' +
            '<label class="svi-check hidden" id="svi-self-wrap"><input type="checkbox" id="svi-self"> I\u2019ll take it myself</label>' +
            '<div id="svi-who-hint" class="svi-note">A technician claims it from the queue.</div>' +
          '</section>' +

        '</fieldset>' +
        '<div id="svi-result" class="svi-result hidden"></div>' +
      '</div>' +
      '<div class="modal-footer svi-foot">' +
        '<div id="svi-status" class="svi-status" role="status" aria-live="polite"></div>' +
        '<div id="svi-foot-form" class="svi-foot-btns">' +
          '<button type="button" id="svi-cancel" class="secondary-btn">Cancel</button>' +
          '<button type="button" id="svi-create-wa" class="secondary-btn">Create and message customer</button>' +
          '<button type="button" id="svi-create" class="primary-pink-btn">Create ticket</button>' +
        '</div>' +
        '<div id="svi-foot-done" class="svi-foot-btns hidden">' +
          '<button type="button" id="svi-done-close" class="secondary-btn">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function kindOptions(selected) {
    var kinds = mapOf('ITEM_KINDS');
    return Object.keys(kinds).map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === selected ? ' selected' : '') + '>' + esc(kindLabel(k)) + '</option>';
    }).join('');
  }

  function itemCardHtml(p, isFirst) {
    p = p || {};
    var kinds = mapOf('ITEM_KINDS');
    var kind = (p.kind && kinds[p.kind]) ? p.kind : (isFirst ? 'pc' : 'other');
    var src = (p.purchase_source === 'neo_tokyo' || p.purchase_source === 'elsewhere' || p.purchase_source === 'unknown') ? p.purchase_source : null;
    var pw = p.powers_on === true ? 'yes' : (p.powers_on === false ? 'no' : null);
    var accs = accessoryLabels();
    var accSel = Array.isArray(p.accessories) ? p.accessories.filter(function (a) { return accs.indexOf(a) !== -1; }) : [];
    var accOpts = accs.map(function (a) { return { value: a, label: a }; });
    var condOpts = conditionLabels().map(function (c) { return { value: c, label: c, cls: isNoDamage(c) ? 'svi-chip-ok' : '' }; });
    var today = todayYmd();
    return '' +
      '<div class="svi-item-head">' +
        '<span class="svi-item-n"></span>' +
        '<button type="button" class="svi-item-x" aria-label="Remove this item" title="Remove this item">&times;</button>' +
      '</div>' +
      '<div class="svi-grid">' +
        fieldHtml('What is it?', '<select class="settings-select" data-f="kind">' + kindOptions(kind) + '</select>') +
        fieldHtml('Make / model', inputHtml(null, { f: 'label', maxlength: 160, value: p.label || '', placeholder: 'e.g. ASUS TUF A15, or Gaming PC (white case)' }), { opt: 'optional' }) +
      '</div>' +
      '<div class="svi-q"><span class="svi-q-l">Where is it from? <em>required</em></span>' + chipsHtml('source', SOURCE_OPTS, src, { label: 'Where is it from?' }) + '</div>' +
      '<div class="svi-src-neo hidden">' +
        '<div class="svi-q"><span class="svi-q-l">Find the build <em class="opt">optional \u2014 links our records and warranty</em></span>' +
          '<div class="svi-find-row">' +
            inputHtml(null, { f: 'bfind', maxlength: 80, placeholder: 'Receipt code, customer name or a serial' }) +
            '<button type="button" class="secondary-btn svi-btn-sm" data-act="find-build">Find</button>' +
          '</div>' +
          '<div class="svi-build-results" data-role="build-results" aria-live="polite"></div>' +
        '</div>' +
        '<div class="svi-build-chip hidden" data-role="build-chip"></div>' +
        '<div class="svi-grid">' +
          fieldHtml('Build ticket id', inputHtml(null, { f: 'build', maxlength: 40, value: p.build_ticket_id || '', placeholder: 't_\u2026 (filled in by Find)' }), { opt: 'optional' }) +
        '</div>' +
      '</div>' +
      // SPEC-GAP: the spec asks for the invoice number only on Neo Tokyo items.
      // It is offered for "bought elsewhere" too: that is the invoice a later
      // warranty claim needs, and a part handed over from the RMA module
      // arrives with one that would otherwise be dropped.
      '<div class="svi-src-date svi-grid hidden">' +
        fieldHtml('Invoice number', inputHtml(null, { f: 'invoice', maxlength: 60, value: p.invoice_no || '' }), { opt: 'optional' }) +
        fieldHtml('Purchase date', inputHtml(null, { type: 'date', f: 'pdate', max: today, value: ymdOf(p.purchase_date) }), { opt: 'optional' }) +
      '</div>' +
      '<div class="svi-grid">' +
        fieldHtml('Serial (as printed on the label)', inputHtml(null, { f: 'serial', maxlength: 80, value: p.serial || '' }), { opt: 'optional' }) +
        '<div class="svi-q svi-q-inline"><span class="svi-q-l">Powers on?</span>' + chipsHtml('powers', POWER_OPTS, pw, { optional: true, label: 'Powers on?' }) + '</div>' +
      '</div>' +
      '<div class="svi-sug hidden" data-role="serial-sug" role="status"></div>' +
      '<div class="svi-q"><span class="svi-q-l">Came with</span>' + chipsHtml('acc', accOpts, accSel, { multi: true, label: 'Came with' }) + '</div>' +
      '<div class="svi-q"><span class="svi-q-l">Condition</span>' + chipsHtml('cond', condOpts, [], { multi: true, label: 'Condition' }) + '</div>' +
      fieldHtml('Condition remarks', '<textarea data-f="remarks" rows="2" maxlength="1000" placeholder="Existing scratches, dents, missing screws\u2026">' + esc(p.condition_remarks || '') + '</textarea>', { opt: 'the chips above add to this' }) +
      '<div class="svi-item-tray"></div>' +
      '<div class="svi-err" data-err="item" role="alert"></div>';
  }

  // ── open / close ───────────────────────────────────────────────────────────
  function rootEl() { return byId('sv-intake-root'); }

  function open(opts) {
    var modal = byId('sv-intake-modal');
    var root = rootEl();
    if (!modal || !root) { toast('The intake form isn\u2019t available on this screen.', 'error'); return false; }
    var preset = (opts && opts.preset) || null;
    if (F && modal.classList.contains('active')) {
      // Never wipe a half-taken intake because somebody clicked "+ New ticket" again.
      if (F.busy || F.uploading || (F.dirty && !F.created)) {
        toast('Finish or cancel the intake that is open first.', 'warning');
        return false;
      }
    }
    if (F) teardown();
    bindOnce(root);
    render(root, preset);
    modal.classList.add('active');
    var token = F.token;
    setTimeout(function () {
      if (!F || F.token !== token) return;
      var el = byId('svi-phone');
      if (el && !el.value) el.focus();
      else { var n = byId('svi-name'); if (n) n.focus(); }
    }, 120);
    return true;
  }

  // Resolves true when the form closed. Without {force} it asks first whenever
  // closing would lose something. {force} (sign-out) asks nothing and marks the
  // session stale: every form opened so far — this one, and one closed earlier
  // whose create is still out — finishes what it has in flight silently.
  async function close(opts) {
    if (opts && opts.force) {
      staleThrough = formSeq;
      closeNow();
      return true;
    }
    if (!F) { closeNow(); return true; }
    var q = closeQuestion();
    if (q) {
      var token = F.token;
      var ok = await confirmBox(q.msg, { title: q.title, okText: q.ok, cancelText: q.cancel, danger: true });
      if (!ok || !F || F.token !== token) return false;
    }
    closeNow();
    return true;
  }

  // Closes without asking and without silencing anything (the caller already
  // asked). Safe when nothing is open, and before the form was ever opened.
  function closeNow() {
    teardown();
    var modal = byId('sv-intake-modal');
    if (modal) modal.classList.remove('active');
  }

  function pendingPhotos() {
    if (!F) return [];
    var out = [];
    (F.uploadPlan || []).forEach(function (step) {
      if (!step.tray) return;
      var files = [];
      try { files = step.tray.files(); } catch (e) { files = []; }
      files.forEach(function (f) { out.push({ step: step, file: f }); });
    });
    return out;
  }

  function closeQuestion() {
    if (!F) return null;
    if (F.busy) {
      return { title: 'Still creating', msg: 'The ticket is still being created. Close anyway? Check the board before making it again.', ok: 'Close anyway', cancel: 'Wait' };
    }
    if (F.created) {
      // Asked before the photos: a photo can be added later from the ticket,
      // but nobody else has this password.
      if (F.pw && (F.pwState === 'queued' || F.pwState === 'saving')) {
        return { title: 'Password still saving', msg: 'The device password is still being saved. Close anyway? If it doesn’t save, set it from the ticket’s Details.', ok: 'Close anyway', cancel: 'Wait' };
      }
      if (F.pw && F.pwState === 'failed') {
        return { title: 'Password not saved', msg: 'The device password didn’t save. If you close now it is gone from this PC — retry first, or set it later from the ticket’s Details.', ok: 'Close without it', cancel: 'Stay' };
      }
      if (F.uploading || F.uploadQueued) {
        return { title: 'Photos still uploading', msg: 'Photos are still uploading. If you close now, the rest won\u2019t be saved \u2014 you can add them later from the ticket\u2019s Photos tab.', ok: 'Close anyway', cancel: 'Wait' };
      }
      var n = pendingPhotos().length;
      if (n) {
        return { title: 'Photos not uploaded', msg: (n === 1 ? '1 photo didn\u2019t upload.' : n + ' photos didn\u2019t upload.') + ' Close without them? You can add photos later from the ticket\u2019s Photos tab.', ok: 'Close without them', cancel: 'Stay' };
      }
      if (F.noteState === 'failed') {
        return { title: 'Note not saved', msg: 'The \u201cAccepted without photos\u201d note didn\u2019t save. Close anyway?', ok: 'Close anyway', cancel: 'Stay' };
      }
      return null;
    }
    if (F.dirty) {
      return { title: 'Discard this intake?', msg: 'What you\u2019ve typed will be lost.', ok: 'Discard', cancel: 'Keep editing' };
    }
    return null;
  }

  function teardown() {
    if (!F) return;
    var old = F;
    F = null;              // every in-flight callback now sees a different form, or none
    clearTimeout(old.lookup.timer);
    clearTimeout(old.mapsTimer);
    clearTimeout(old.pwShowTimer);
    old.pw = null;          // the closing question already covered an unsaved one
    var pwBox = byId('svi-pw');
    if (pwBox) pwBox.value = '';
    Object.keys(old.builds || {}).forEach(function (k) { clearBuildTimers(old.builds[k]); });
    // Trays go now: that stops any webcam and frees the photo previews.
    Object.keys(old.trays).forEach(function (k) {
      var t = old.trays[k];
      if (t) { try { t.destroy(); } catch (e) { /* already gone */ } }
    });
    // The rest of the markup goes after the modal's fade-out, unless a new form
    // has been rendered into the root by then (render() replaces it anyway).
    setTimeout(function () {
      if (F) return;
      var root = rootEl();
      if (root) root.textContent = '';
    }, 450);
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function render(root, preset) {
    F = {
      token: ++formSeq,
      crid: uuid(),                       // once per open form; reused by every retry
      preset: preset,
      dirty: false, deepDirty: false, itemsTouched: false,
      busy: false, created: null, uploading: false, uploadQueued: false,
      noteState: null, noteError: '', noteBy: '',
      // The device password after the create, until it is saved (memory only).
      pw: null, pwState: null, pwError: '', pwShown: false, pwShowTimer: null,
      upDone: 0, upTotal: 0, upOk: 0,
      channel: 'walk_in',
      type: 'in_store', typeTouched: false, typeAuto: false, suggestedType: null,
      inHand: true, inHandTouched: false,
      businessTouched: false,
      faults: [],
      computed: { priority: 'normal', reasons: [], est: null, checklist: [] },
      lookup: { phone: '', seq: 0, timer: null, result: null },
      trays: {}, itemSeq: 0, builds: {}, techFromLookup: null,
      uploadPlan: [], submitted: null,
      mapsTimer: null
    };
    root.innerHTML = shellHtml();

    if (isDemo()) {
      var banner = byId('svi-demo');
      if (banner) banner.appendChild(h('div', { cls: 'svi-banner', role: 'note', text: 'Demo data is on. You can fill in the form, but tickets can\u2019t be created until demo data is turned off in Settings.' }));
    }

    var p = preset || {};
    if (CHANNEL_KEYS.indexOf(p.channel) !== -1) F.channel = p.channel;
    if (TYPE_KEYS.indexOf(p.service_type) !== -1) { F.type = p.service_type; F.typeTouched = true; }
    if (typeof p.in_hand === 'boolean') { F.inHand = p.in_hand; F.inHandTouched = true; }
    else F.inHand = defaultInHand(F.channel);
    if (p.customer_phone) byId('svi-phone').value = String(p.customer_phone);
    if (p.customer_name) byId('svi-name').value = String(p.customer_name);
    if (p.customer_email) byId('svi-email').value = String(p.customer_email);
    if (p.reported_fault) byId('svi-fault-text').value = String(p.reported_fault);
    if (p.device_label) byId('svi-device').value = String(p.device_label);
    if (Array.isArray(p.fault_keys)) {
      F.faults = p.fault_keys.filter(function (k) { return !!faultByKey(k); });
    }
    if (p.category && mapOf('CATEGORIES')[p.category]) byId('svi-category').value = p.category;

    var items = Array.isArray(p.items) ? p.items.slice(0, MAX_ITEMS) : [];
    if (items.length) {
      // Items handed over by another module ARE the decision that this is in-store work.
      F.itemsTouched = true;
      items.forEach(function (it, i) { addItem(it, false, i === 0); });
    } else {
      addItem(null, false, true);
    }

    setChannel(F.channel, false);
    setType(F.type, false);
    syncInHand();
    renderTechs();
    syncSelfVisibility();
    syncPrioControls();
    renderFaults();
    onFaultsChanged();

    var norm = normPhone(byId('svi-phone').value);
    if (phoneOk(norm)) doLookup(norm);

    F.dirty = false;            // a preset is not the user's typing
    F.deepDirty = false;
  }

  // ── items ──────────────────────────────────────────────────────────────────
  function itemCards() {
    var list = byId('svi-items');
    return list ? Array.prototype.slice.call(list.querySelectorAll('.svi-item')) : [];
  }
  function cardField(card, f) {
    var el = card.querySelector('[data-f="' + f + '"]');
    return el ? String(el.value || '').trim() : '';
  }
  function cardData(card) {
    var pw = readChips(card, 'powers');
    return {
      key: card.getAttribute('data-item'),
      kind: cardField(card, 'kind') || 'other',
      label: cardField(card, 'label'),
      source: readChips(card, 'source'),
      build: cardField(card, 'build'),
      invoice: cardField(card, 'invoice'),
      pdate: cardField(card, 'pdate'),
      serial: cardField(card, 'serial'),
      powers: pw === 'yes' ? true : (pw === 'no' ? false : null),
      accessories: readChips(card, 'acc') || [],
      remarks: cardField(card, 'remarks')
    };
  }
  function primaryCardData() {
    var cards = itemCards();
    return cards.length ? cardData(cards[0]) : null;
  }

  function addItem(preset, byUser, isFirst) {
    if (!F) return;
    var list = byId('svi-items');
    if (!list) return;
    var n = itemCards().length;
    if (n >= MAX_ITEMS) { status('A ticket can hold up to ' + MAX_ITEMS + ' items.', 'err'); return; }
    var key = 'it' + (++F.itemSeq);
    var card = document.createElement('div');
    card.className = 'svi-item';
    card.setAttribute('data-item', key);
    card.innerHTML = itemCardHtml(preset, isFirst || n === 0);
    list.appendChild(card);

    var host = card.querySelector('.svi-item-tray');
    var tray = null;
    var P = PT();
    if (P && typeof P.create === 'function') {
      try {
        tray = P.create(host, TRAY_OPTS);
        tray.onChange(onTrayChange);
      } catch (e) {
        host.appendChild(h('div', { cls: 'svi-note err', text: 'Photos can\u2019t be added here: ' + errText(e) + ' Add them from the ticket after creating it.' }));
      }
    } else {
      host.appendChild(h('div', { cls: 'svi-note err', text: 'The photo tray isn\u2019t loaded. Add photos from the ticket after creating it.' }));
    }
    F.trays[key] = tray;
    syncSource(card);
    syncCondChips(card);
    renumber();
    if (byUser) {
      markDirty(card);
      F.itemsTouched = true;
      var sel = card.querySelector('[data-f="kind"]');
      if (sel) { sel.focus(); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      renderFaults();
      updateSummary();
    }
  }

  function cardHasWork(card) {
    var d = cardData(card);
    return !!(d.label || d.source || d.build || d.invoice || d.pdate || d.serial || d.powers !== null || d.accessories.length || d.remarks);
  }

  async function removeItem(card) {
    if (!F || !card) return;
    var token = F.token;
    var key = card.getAttribute('data-item');
    var tray = F.trays[key];
    var photos = tray ? tray.count() : 0;
    if (itemCards().length < 2) return;            // in-store work always has at least one item
    if (photos || cardHasWork(card)) {
      var msg = photos ? 'Remove this item and its ' + (photos === 1 ? 'photo' : photos + ' photos') + '?' : 'Remove this item and what you typed for it?';
      var ok = await confirmBox(msg, { title: 'Remove item', okText: 'Remove', cancelText: 'Keep it', danger: true });
      if (!ok || !F || F.token !== token || !card.isConnected) return;
    }
    if (tray) { try { tray.destroy(); } catch (e) { /* already gone */ } }
    delete F.trays[key];
    clearBuildTimers(F.builds[key]);
    delete F.builds[key];
    if (card.parentNode) card.parentNode.removeChild(card);
    F.dirty = true; F.deepDirty = true; F.itemsTouched = true;
    renumber();
    renderFaults();
    updateSummary();
  }

  function renumber() {
    var cards = itemCards();
    cards.forEach(function (c, i) {
      var n = c.querySelector('.svi-item-n');
      if (n) n.textContent = 'Item ' + (i + 1) + (i === 0 && cards.length > 1 ? ' \u00b7 main item' : '');
      var x = c.querySelector('.svi-item-x');
      if (x) x.classList.toggle('hidden', cards.length < 2);
    });
    var add = byId('svi-add-item');
    if (add) add.disabled = cards.length >= MAX_ITEMS;
  }

  function syncSource(card) {
    var src = readChips(card, 'source');
    var neo = card.querySelector('.svi-src-neo');
    var date = card.querySelector('.svi-src-date');
    if (neo) neo.classList.toggle('hidden', src !== 'neo_tokyo');
    if (date) date.classList.toggle('hidden', !(src === 'neo_tokyo' || src === 'elsewhere'));
  }

  function syncCondChips(card) {
    var ta = card.querySelector('[data-f="remarks"]');
    var text = ta ? ta.value : '';
    var g = chipGroup(card, 'cond');
    if (!g) return;
    g.querySelectorAll('.svi-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', hasPart(text, b.getAttribute('data-value')) ? 'true' : 'false');
    });
  }

  function toggleCondition(card, label) {
    var ta = card && card.querySelector('[data-f="remarks"]');
    if (!ta) return;
    ta.value = toggleConditionText(ta.value, label, conditionLabels());
    syncCondChips(card);
    F.itemsTouched = true;
  }

  function onTrayChange() {
    if (!F || F.created) return;
    var any = Object.keys(F.trays).some(function (k) { return F.trays[k] && F.trays[k].count() > 0; });
    if (any) { F.dirty = true; F.deepDirty = true; F.itemsTouched = true; }
  }

  // ── linking a past build (SPEC-AMENDMENTS A20) ─────────────────────────────
  // Build tickets carry no phone number, so the link is found by the receipt
  // code, the customer's name or a serial. A linked build tells the bench what
  // went into the machine and whether our workmanship warranty still covers it.
  function buildState(key) {
    if (!F.builds[key]) F.builds[key] = { seq: 0, timer: null, results: [], linked: null, serialSeq: 0, serialTimer: null, serialHit: null, dismissed: {} };
    return F.builds[key];
  }
  function clearBuildTimers(st) {
    if (!st) return;
    clearTimeout(st.timer);
    clearTimeout(st.serialTimer);
  }
  function warrantyMonths() {
    var c = C();
    var m = c ? Number(c.OUR_WARRANTY_MONTHS) : NaN;
    return m > 0 ? m : 6;
  }
  function addMonths(ms, n) {
    var d = new Date(ms);
    var day = d.getDate();
    d.setMonth(d.getMonth() + n);
    if (d.getDate() < day) d.setDate(0);      // 31 Aug + 6 months is 28/29 Feb, not 3 Mar
    return d.getTime();
  }
  // Our warranty runs from the hand-over, or from completion when the hand-over
  // was never recorded. null = the build has neither date.
  function buildWarrantyEnd(b) {
    var start = b && (b.handed_over_at || b.completed_at);
    var t = start ? new Date(start).getTime() : NaN;
    return isNaN(t) ? null : addMonths(t, warrantyMonths());
  }
  function fmtMonthYear(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  }
  function fmtLongDay(ms) {
    try { return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  }
  function buildLine(b) {
    var bits = ['#' + String(b.code || String(b.id || '').slice(-6).toUpperCase())];
    if (b.customer_name) bits.push(String(b.customer_name));
    var when = fmtMonthYear(b.handed_over_at || b.completed_at || b.created_at);
    if (when) bits.push(when);
    if (b.summary) bits.push(String(b.summary));
    return bits.join(' · ');
  }

  function scheduleBuildFind(card, now) {
    if (!F || !card) return;
    var st = buildState(card.getAttribute('data-item'));
    clearTimeout(st.timer);
    var q = cardField(card, 'bfind');
    var box = card.querySelector('[data-role="build-results"]');
    if (q.length < 2) {
      st.seq++;
      st.results = [];
      if (box) box.textContent = '';
      if (now && box) box.appendChild(h('div', { cls: 'svi-note', text: 'Type at least 2 characters: a receipt code, a name or a serial.' }));
      return;
    }
    var token = F.token;
    var run = function () { if (F && F.token === token && card.isConnected) findBuild(card, q); };
    if (now) run(); else st.timer = setTimeout(run, 450);
  }

  async function findBuild(card, q) {
    var token = F.token;                   // bound: the form, the card or the query may change meanwhile
    var st = buildState(card.getAttribute('data-item'));
    var box = card.querySelector('[data-role="build-results"]');
    var d = D();
    if (!box) return;
    if (!d || typeof d.findBuilds !== 'function') {
      box.textContent = '';
      box.appendChild(h('div', { cls: 'svi-note err', text: 'Build search isn’t available in this version. Type the build ticket id instead.' }));
      return;
    }
    var seq = ++st.seq;
    box.textContent = '';
    box.appendChild(h('div', { cls: 'svi-note', text: 'Searching builds…' }));
    var list = null, err = null;
    try { list = await d.findBuilds(q); } catch (e) { err = e; }
    if (!F || F.token !== token || !card.isConnected || st.seq !== seq || cardField(card, 'bfind') !== q) return;
    box.textContent = '';
    if (err) { box.appendChild(h('div', { cls: 'svi-note err', text: 'Couldn’t search builds: ' + errText(err) })); return; }
    st.results = Array.isArray(list) ? list.filter(function (b) { return b && b.id; }).slice(0, 10) : [];
    if (!st.results.length) { box.appendChild(h('div', { cls: 'svi-note', text: 'No builds match “' + q + '”.' })); return; }
    st.results.forEach(function (b, i) {
      var btn = h('button', { type: 'button', cls: 'svi-build-hit', 'data-act': 'pick-build' }, [
        h('span', { cls: 'svi-build-hit-t', text: buildLine(b) }),
        b.match ? h('span', { cls: 'svi-tag', text: b.match === 'serial' ? 'Serial match' : (b.match === 'code' ? 'Receipt code' : 'Name') }) : null
      ]);
      btn.setAttribute('data-i', String(i));
      box.appendChild(btn);
    });
  }

  function renderBuildChip(card) {
    var st = buildState(card.getAttribute('data-item'));
    var chip = card.querySelector('[data-role="build-chip"]');
    if (!chip) return;
    chip.textContent = '';
    var b = st.linked;
    chip.classList.toggle('hidden', !b);
    if (!b) return;
    var end = b.warrantyEnd;
    var w = null;
    if (end != null) {
      w = end >= Date.now()
        ? h('span', { cls: 'svi-warranty is-in', text: 'In our warranty until ' + fmtLongDay(end) })
        : h('span', { cls: 'svi-warranty is-out', text: 'Our warranty ended ' + fmtLongDay(end) });
    } else {
      w = h('span', { cls: 'svi-warranty', text: 'Hand-over date not recorded — warranty unknown' });
    }
    chip.appendChild(h('span', { cls: 'svi-build-chip-t', text: 'Linked build ' + buildLine(b) }));
    chip.appendChild(w);
    chip.appendChild(h('button', { type: 'button', cls: 'svi-linkbtn', 'data-act': 'unlink-build', text: 'Unlink' }));
  }

  function pickBuild(card, b) {
    if (!F || !card || !b || !b.id) return;
    var st = buildState(card.getAttribute('data-item'));
    if (readChips(card, 'source') !== 'neo_tokyo') { setChips(card, 'source', 'neo_tokyo'); syncSource(card); }
    st.linked = { id: String(b.id), code: b.code, customer_name: b.customer_name, summary: b.summary,
                  handed_over_at: b.handed_over_at, completed_at: b.completed_at, created_at: b.created_at,
                  warrantyEnd: buildWarrantyEnd(b) };
    var bid = card.querySelector('[data-f="build"]');
    if (bid) { bid.value = String(b.id); bid.removeAttribute('data-auto'); clearFieldError(bid); }
    var lab = card.querySelector('[data-f="label"]');
    if (lab && b.summary) autoFill(lab, 'Neo Tokyo build — ' + String(b.summary));
    var find = card.querySelector('[data-f="bfind"]');
    if (find) find.value = '';
    st.results = [];
    st.seq++;
    var box = card.querySelector('[data-role="build-results"]');
    if (box) box.textContent = '';
    var sug = card.querySelector('[data-role="serial-sug"]');
    if (sug) { sug.textContent = ''; sug.classList.add('hidden'); }
    renderBuildChip(card);
    F.itemsTouched = true;
    markDirty(card);
    updateSummary();
  }

  function unlinkBuild(card) {
    var st = buildState(card.getAttribute('data-item'));
    st.linked = null;
    var bid = card.querySelector('[data-f="build"]');
    if (bid) bid.value = '';
    var lab = card.querySelector('[data-f="label"]');
    if (lab) clearAuto(lab);
    renderBuildChip(card);
    markDirty(card);
    updateSummary();
  }

  // Typing over the id by hand means it may no longer be the build we linked.
  function onBuildIdTyped(card) {
    var st = buildState(card.getAttribute('data-item'));
    if (st.linked && cardField(card, 'build') !== st.linked.id) { st.linked = null; renderBuildChip(card); updateSummary(); }
  }

  // A quiet check (A20): a typed serial that belongs to one of our builds is
  // offered as a link. A suggestion only — never a step, never an error.
  function scheduleSerialCheck(card) {
    if (!F || !card) return;
    var st = buildState(card.getAttribute('data-item'));
    clearTimeout(st.serialTimer);
    st.serialSeq++;
    var sug = card.querySelector('[data-role="serial-sug"]');
    if (sug) { sug.textContent = ''; sug.classList.add('hidden'); }
    var serial = cardField(card, 'serial');
    var norm = serial.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm.length < 5 || st.dismissed[norm]) return;
    var d = D();
    if (!d || typeof d.findBuilds !== 'function') return;
    var token = F.token, seq = st.serialSeq;
    st.serialTimer = setTimeout(async function () {
      if (!F || F.token !== token || st.serialSeq !== seq || !card.isConnected) return;
      var list = null;
      try { list = await d.findBuilds(serial); } catch (e) { return; /* quiet by design: a suggestion, not a check */ }
      if (!F || F.token !== token || st.serialSeq !== seq || !card.isConnected || cardField(card, 'serial') !== serial) return;
      var hit = (Array.isArray(list) ? list : []).filter(function (b) { return b && b.id && b.match === 'serial'; })[0];
      if (!hit || (st.linked && st.linked.id === String(hit.id))) return;
      st.serialHit = hit;
      var box = card.querySelector('[data-role="serial-sug"]');
      if (!box) return;
      box.textContent = '';
      var when = fmtMonthYear(hit.handed_over_at || hit.completed_at || hit.created_at);
      box.appendChild(h('span', { text: 'This serial is in build #' + String(hit.code || '') +
        (hit.customer_name || when ? ' (' + [hit.customer_name, when].filter(Boolean).join(', ') + ')' : '') + ' — link it?' }));
      box.appendChild(h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'link-serial', text: 'Link it' }));
      box.appendChild(h('button', { type: 'button', cls: 'svi-linkbtn', 'data-act': 'dismiss-serial', text: 'Not this one' }));
      box.classList.remove('hidden');
    }, 700);
  }

  function totalPhotos() {
    if (!F) return 0;
    return itemCards().reduce(function (n, c) {
      var t = F.trays[c.getAttribute('data-item')];
      return n + (t ? t.count() : 0);
    }, 0);
  }

  // ── channel / type / in-hand ───────────────────────────────────────────────
  function setChannel(v, byUser) {
    if (CHANNEL_KEYS.indexOf(v) === -1) v = 'walk_in';
    F.channel = v;
    var root = rootEl();
    setChips(root, 'channel', v);
    var wa = byId('svi-wa');
    if (wa) wa.classList.toggle('hidden', v !== 'whatsapp');
    if (!F.inHandTouched) {
      F.inHand = defaultInHand(v);
      setChips(root, 'inhand', F.inHand ? 'yes' : 'no');
      syncInHand();
    }
    if (byUser && v === 'whatsapp') {
      var ta = byId('svi-wa-text');
      if (ta) setTimeout(function () { if (ta.isConnected) ta.focus(); }, 30);
    }
  }

  function syncInHand() {
    if (!F) return;
    setChips(rootEl(), 'inhand', F.inHand ? 'yes' : 'no');
    var hint = byId('svi-inhand-hint');
    if (hint) hint.classList.toggle('hidden', F.inHand);
    // The data question is required once the device is on the counter: that
    // is the moment the customer is about to leave it with us.
    var req = byId('svi-consent-req');
    if (req) {
      req.textContent = F.inHand ? 'required' : 'ask when it arrives';
      req.classList.toggle('opt', !F.inHand);
    }
    if (!F.inHand) {
      var g = chipGroup(rootEl(), 'data_consent');
      if (g && g.classList.contains('svi-invalid')) clearFieldError(g);
    }
  }

  // The password box's Show / Hide. Hidden is the resting state: every new
  // form, every type change and every successful create puts it back.
  function setPwVisible(on) {
    var el = byId('svi-pw'), btn = byId('svi-pw-show');
    if (el) el.type = on ? 'text' : 'password';
    if (btn) { btn.textContent = on ? 'Hide' : 'Show'; btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
  // As typed (a password with a space in it is still that password); blank
  // means none. Only an in-store ticket has the box on screen.
  function readPassword() {
    if (!F || F.type !== 'in_store') return '';
    var el = byId('svi-pw');
    var v = el ? String(el.value == null ? '' : el.value) : '';
    return v.trim() ? v : '';
  }
  function clearPasswordBox() {
    var el = byId('svi-pw');
    if (el) el.value = '';
    setPwVisible(false);
  }

  function setType(t, byUser) {
    if (!F || TYPE_KEYS.indexOf(t) === -1) return;
    var changed = F.type !== t;
    F.type = t;
    if (byUser) { F.typeTouched = true; F.typeAuto = false; }
    var root = rootEl();
    root.querySelectorAll('.svi-type').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-type') === t ? 'true' : 'false');
    });
    var show = function (id, on) { var el = byId(id); if (el) el.classList.toggle('hidden', !on); };
    show('svi-sec-items', t === 'in_store');
    show('svi-sec-device', t !== 'in_store');
    show('svi-ts-in_store', t === 'in_store');
    show('svi-ts-on_site', t === 'on_site');
    show('svi-ts-remote', t === 'remote');
    show('svi-window', t !== 'in_store');
    // The box is off screen for on-site / remote (and readPassword ignores
    // it): at least never leave it showing the password in clear.
    if (t !== 'in_store') setPwVisible(false);
    var title = byId('svi-ts-title');
    if (title) {
      var tt = title.querySelector('.svi-h-t');
      if (tt) tt.textContent = t === 'on_site' ? 'Visit details' : (t === 'remote' ? 'Remote session' : 'Data and passwords');
    }
    if (t === 'on_site') prefillSite();
    if (changed) { renderFaults(); updateSummary(); renderTechs(); }
    renderTypeHint();
  }

  function maybeSuggestType() {
    if (!F) return;
    var cat = C();
    var sug = null;
    if (F.faults.length && cat && typeof cat.suggestType === 'function') {
      try { sug = cat.suggestType(F.faults) || null; } catch (e) { sug = null; }
    }
    if (TYPE_KEYS.indexOf(sug) === -1) sug = null;
    F.suggestedType = sug;
    // Only while nobody has chosen: once the desk picks a type, or starts
    // describing an item at the counter, a fault chip must not yank the form
    // to a different layout under their hands.
    if (!F.typeTouched && !F.itemsTouched) {
      var target = sug || 'in_store';
      F.typeAuto = !!sug;
      if (target !== F.type) setType(target, false);
    }
    renderTypeHint();
  }

  function renderTypeHint() {
    if (!F) return;
    var hint = byId('svi-type-hint');
    var root = rootEl();
    // Almost every fault suggests In-store, the default; the badge only means
    // something when the fault actually moved the ticket to another type.
    var auto = F.typeAuto && F.suggestedType === F.type && F.type !== 'in_store';
    root.querySelectorAll('.svi-type').forEach(function (b) {
      b.classList.toggle('is-suggested', auto && b.getAttribute('data-type') === F.type);
    });
    if (!hint) return;
    hint.textContent = '';
    hint.className = 'svi-note';
    if (auto) {
      hint.textContent = 'Suggested from the fault. Pick another if it\u2019s wrong.';
    } else if (F.suggestedType && F.suggestedType !== F.type) {
      hint.appendChild(document.createTextNode('This fault usually suits ' + typeLabel(F.suggestedType) + '. '));
      var b = h('button', { type: 'button', cls: 'svi-linkbtn', 'data-act': 'switch-type', text: 'Switch to ' + typeLabel(F.suggestedType) });
      b.setAttribute('data-type-to', F.suggestedType);
      hint.appendChild(b);
    }
  }

  // ── customer lookup ────────────────────────────────────────────────────────
  // Fill a field only if it is empty or was itself filled by an earlier lookup
  // (data-auto). Never overwrite what a person typed.
  function autoFill(el, value) {
    if (!el || value == null || String(value).trim() === '') return false;
    if (String(el.value || '').trim() && el.getAttribute('data-auto') !== '1') return false;
    el.value = String(value);
    el.setAttribute('data-auto', '1');
    return true;
  }
  function clearAuto(el) {
    if (!el || el.getAttribute('data-auto') !== '1') return;
    el.value = '';
    el.removeAttribute('data-auto');
  }

  var AUTO_FIELDS = ['svi-name', 'svi-email', 'svi-site-address', 'svi-site-area', 'svi-site-pincode', 'svi-site-landmark', 'svi-site-maps'];

  // The number changed: everything shown or filled for the old number belongs
  // to somebody else and goes, before the new lookup (if any) runs.
  function resetLookup() {
    F.lookup.seq++;
    F.lookup.phone = '';
    F.lookup.result = null;
    clearTimeout(F.lookup.timer);
    AUTO_FIELDS.forEach(function (id) { clearAuto(byId(id)); });
    var b = byId('svi-business');
    if (b && b.getAttribute('data-auto') === '1') { b.checked = false; b.removeAttribute('data-auto'); }
    // "Served this customer before" is about the OLD customer: a technician
    // picked from that customer's history goes too, unless re-picked by hand.
    var sel = byId('svi-tech');
    if (sel && F.techFromLookup && sel.value === F.techFromLookup) sel.value = '';
    F.techFromLookup = null;
    clearAuto(byId('svi-tech-reason'));
    var lk = byId('svi-lookup');
    if (lk) lk.textContent = '';
    onMapsChanged();
    updateSummary();
  }

  function onPhoneInput() {
    var norm = normPhone(byId('svi-phone').value);
    if (F.lookup.phone && norm !== F.lookup.phone) resetLookup();
    clearTimeout(F.lookup.timer);
    if (phoneOk(norm) && norm !== F.lookup.phone) {
      var token = F.token;
      F.lookup.timer = setTimeout(function () {
        if (!F || F.token !== token) return;
        if (normPhone(byId('svi-phone').value) === norm) doLookup(norm);
      }, 300);
    }
  }

  async function doLookup(phone) {
    var token = F.token;                  // bound: the form can close or reset while this runs
    var d = D();
    if (!d || typeof d.lookupCustomer !== 'function') return;
    var seq = ++F.lookup.seq;
    F.lookup.phone = phone;
    var lk = byId('svi-lookup');
    if (lk) { lk.textContent = ''; lk.appendChild(h('div', { cls: 'svi-note', text: 'Looking up this number\u2026' })); }
    var res = null, err = null;
    try { res = await d.lookupCustomer(phone); } catch (e) { err = e; }
    // Ignore any reply for a number that is no longer the one in the box.
    if (!F || F.token !== token || seq !== F.lookup.seq) return;
    var box = byId('svi-phone');
    if (!box || normPhone(box.value) !== phone) return;
    lk = byId('svi-lookup');
    if (err) {
      if (lk) { lk.textContent = ''; lk.appendChild(h('div', { cls: 'svi-note err', text: 'Couldn\u2019t look up this number: ' + errText(err) + ' You can carry on.' })); }
      return;
    }
    F.lookup.result = res || null;
    applyLookup(res || null);
  }

  function applyLookup(res) {
    // A reduced reply (SPEC-AMENDMENTS A19, callers without service access)
    // carries only a shortened display name: never fill the form from it.
    var cust = res && !res.limited ? res.customer : null;
    if (cust) {
      autoFill(byId('svi-name'), cust.name);
      autoFill(byId('svi-email'), cust.email);
      var b = byId('svi-business');
      if (b && !b.checked && !F.businessTouched && (cust.kind === 'business' || cust.kind === 'trade_partner')) {
        b.checked = true;
        b.setAttribute('data-auto', '1');
      }
      if (F.type === 'on_site') prefillSite();
    }
    renderLookup(res);
    updateSummary();
  }

  function prefillSite() {
    var res = F && F.lookup.result;
    var cust = res && res.customer;
    if (!cust) return;
    var any = false;
    any = autoFill(byId('svi-site-address'), cust.address) || any;
    any = autoFill(byId('svi-site-area'), cust.area) || any;
    any = autoFill(byId('svi-site-pincode'), cust.pincode) || any;
    any = autoFill(byId('svi-site-landmark'), cust.landmark) || any;
    any = autoFill(byId('svi-site-maps'), cust.maps_url) || any;
    if (any) {
      onMapsChanged();
      var msg = byId('svi-maps-msg');
      if (msg && !msg.textContent) { msg.textContent = 'Address filled in from their last visit. Check it with the customer.'; msg.className = 'svi-note svi-span2'; }
    }
  }

  function repeatWithin30() {
    var res = F && F.lookup.result;
    if (!res || !Array.isArray(res.recent_jobs)) return false;
    var now = Date.now();
    return res.recent_jobs.some(function (j) {
      var t = j && j.closed_at ? new Date(j.closed_at).getTime() : NaN;
      return !isNaN(t) && now - t <= 30 * DAY && now - t >= 0;
    });
  }

  function techList() {
    var d = D();
    var list = [];
    try { list = (d && typeof d.techs === 'function' ? d.techs() : []) || []; } catch (e) { list = []; }
    return list.filter(function (t) { return t && t.email; }).map(function (t) {
      return {
        email: String(t.email),
        name: String(t.name || t.full_name || t.email),
        open: Number(t.open_count) || 0,
        visits: Number(t.visits_today) || 0
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function renderLookup(res) {
    var host = byId('svi-lookup');
    if (!host) return;
    host.textContent = '';
    if (!res) return;
    if (res.limited) {
      var oc = Number(res.open_count) || 0;
      host.appendChild(h('div', { cls: 'svi-lk-head' + (res.known ? ' is-found' : '') }, [
        h('strong', { text: res.known ? String(res.display_name || 'Known customer') : 'New customer' }),
        h('span', { cls: 'svi-lk-count', text: res.known
          ? (oc ? (oc === 1 ? '1 open ticket' : oc + ' open tickets') + ' — the help desk will link it.' : 'No open tickets.')
          : 'Nothing on file for this number.' })
      ]));
      return;
    }
    var cust = res.customer || null;
    var total = Number(res.jobs_total) || 0;
    var openJobs = Array.isArray(res.open_jobs) ? res.open_jobs : [];
    var openRma = Array.isArray(res.open_rma) ? res.open_rma : [];
    var past = Array.isArray(res.past_techs) ? res.past_techs : [];
    var recent = Array.isArray(res.recent_jobs) ? res.recent_jobs.slice(0, 3) : [];

    var countTxt = total ? (total === 1 ? '1 ticket before' : total + ' tickets before') : 'no tickets before';
    var head = h('div', { cls: 'svi-lk-head' + (cust ? ' is-found' : '') }, [
      h('strong', { text: cust ? (cust.name ? String(cust.name) : 'Returning customer') : (total ? 'Known number' : 'New customer') }),
      cust && cust.kind && cust.kind !== 'person' ? h('span', { cls: 'svi-tag', text: cust.kind === 'trade_partner' ? 'Trade partner' : 'Business' }) : null,
      h('span', { cls: 'svi-lk-count', text: cust || total ? countTxt : 'Nothing on file for this number.' })
    ]);
    host.appendChild(head);

    var nameEl = byId('svi-name');
    if (cust && cust.name && nameEl && nameEl.value.trim() && nameEl.getAttribute('data-auto') !== '1' &&
        nameEl.value.trim().toLowerCase() !== String(cust.name).trim().toLowerCase()) {
      var use = h('button', { type: 'button', cls: 'svi-linkbtn', 'data-act': 'use-name', text: 'Use this name' });
      host.appendChild(h('div', { cls: 'svi-note' }, ['On file as \u201c' + String(cust.name) + '\u201d. ', use]));
    }

    openJobs.forEach(function (j) {
      if (!j) return;
      var code = String(j.public_code || 'A ticket');
      var bits = [];
      if (j.service_type && j.service_type !== 'in_store') bits.push(typeLabel(j.service_type));
      if (j.device_label) bits.push(String(j.device_label));
      if (j.created_at) bits.push('since ' + fmtDay(j.created_at));
      bits.push(j.assignee ? 'with ' + String(j.assignee) : 'in the queue');
      var openBtn = h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'open-job', text: 'Open' });
      openBtn.setAttribute('data-id', String(j.id || ''));
      openBtn.setAttribute('data-code', code);
      host.appendChild(h('div', { cls: 'svi-warn', role: 'alert' }, [
        h('div', { cls: 'svi-warn-main' }, [
          h('div', null, [h('strong', { text: code + ' is open' }), ' \u2014 ' + stageLabel(j.stage) + '. Open it instead?']),
          h('div', { cls: 'svi-warn-sub', text: bits.join(' \u00b7 ') })
        ]),
        j.id ? openBtn : null
      ]));
    });

    openRma.forEach(function (u) {
      if (!u) return;
      var lbl = [kindLabel(u.kind), u.brand, u.model].filter(Boolean).join(' ');
      var ui = window.NeoQcRmaUI;
      var btn = null;
      if (u.id && ui && typeof ui.openUnit === 'function') {
        btn = h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'open-rma', text: 'Open' });
        btn.setAttribute('data-id', String(u.id));
      }
      host.appendChild(h('div', { cls: 'svi-info' }, [
        h('div', null, [h('strong', { text: String(u.public_code || 'RMA') + ' is open' }), ' \u2014 ' + rmaStageLabel(u.stage) + (lbl ? ' (' + lbl + ')' : '')]),
        btn
      ]));
    });

    if (past.length) {
      var techs = techList();
      var row = h('div', { cls: 'svi-lk-techs' });
      past.slice(0, 3).forEach(function (pt) {
        if (!pt || !pt.email) return;
        var name = String(pt.name || pt.email);
        var times = Number(pt.jobs) || 0;
        var line = h('div', { cls: 'svi-lk-tech' }, [
          h('span', { text: name + ' served them' + (times > 1 ? ' ' + times + '\u00d7' : '') + (pt.last_at ? ' \u00b7 last ' + fmtDay(pt.last_at) : '') })
        ]);
        if (techs.some(function (t) { return t.email.toLowerCase() === String(pt.email).toLowerCase(); })) {
          var chip = h('button', { type: 'button', cls: 'svi-chip svi-chip-sm', 'data-act': 'suggest-tech', text: 'Suggest ' + (firstName(name) || name) });
          chip.setAttribute('data-email', String(pt.email));
          line.appendChild(chip);
        }
        row.appendChild(line);
      });
      if (row.childNodes.length) host.appendChild(row);
    }

    if (recent.length) {
      host.appendChild(h('div', { cls: 'svi-lk-recent', text: 'Recent: ' + recent.map(function (j) {
        var o = S() && S().OUTCOMES ? S().OUTCOMES[j.outcome] : null;
        return [j.public_code, o || stageLabel(j.stage), fmtDay(j.closed_at || j.created_at)].filter(Boolean).join(' \u00b7 ');
      }).join('  |  ') }));
    }
  }

  async function openExisting(jobId, code) {
    if (!F || !jobId) return;
    var token = F.token;
    if (F.deepDirty) {
      var ok = await confirmBox('Leave this intake and open ' + (code || 'the existing ticket') + '? What you typed here will be lost.',
        { title: 'Open the existing ticket', okText: 'Open ticket', cancelText: 'Stay here' });
      if (!ok || !F || F.token !== token) return;
    }
    var ui = window.NeoQcServiceUI;
    if (!ui || typeof ui.openJob !== 'function') { toast('Couldn\u2019t open that ticket from here.', 'error'); return; }
    closeNow();                               // asked above; not a sign-out, so nothing is silenced
    // From here the form is gone: a sign-out meanwhile makes `token` stale.
    try { await ui.openJob(jobId); }
    catch (e) { lateToast(token, 'Couldn\u2019t open ' + (code || 'that ticket') + ': ' + errText(e), 'error'); return; }
    // The board may not have that ticket loaded on this PC; say so rather than
    // leave the person looking at a closed form and nothing else.
    setTimeout(function () {
      var m = byId('sv-job-modal');
      if (m && !m.classList.contains('active')) lateToast(token, 'Couldn\u2019t open ' + (code || 'that ticket') + ' here. Search for it on the board.', 'warning');
    }, 400);
  }

  function suggestTech(email) {
    if (!F || !email) return;
    var sel = byId('svi-tech');
    if (!sel) return;
    if (!sel.querySelector('option[value="' + cssAttr(email) + '"]')) renderTechs();
    sel.value = email;
    if (sel.value !== email) { toast('That technician isn\u2019t on the list right now.', 'warning'); return; }
    var self = byId('svi-self');
    if (self && self.checked) { self.checked = false; syncSelf(); }
    var reason = byId('svi-tech-reason');
    autoFill(reason, 'Served this customer before');
    F.techFromLookup = email;
    markDirty(sel);
  }
  function cssAttr(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  // ── WhatsApp chat ──────────────────────────────────────────────────────────
  function waMsg(text, kind) {
    var el = byId('svi-wa-msg');
    if (el) { el.textContent = text || ''; el.className = 'svi-note' + (kind ? ' ' + kind : ''); }
  }

  function fillFromChat() {
    if (!F) return;
    var ta = byId('svi-wa-text');
    var text = ta ? ta.value : '';
    if (!text.trim()) { waMsg('Paste the chat first.', 'err'); return; }
    var cat = C();
    if (!cat || typeof cat.parseWhatsAppChat !== 'function') { waMsg('The chat reader isn\u2019t loaded. Fill in the fields by hand.', 'err'); return; }
    var r;
    try { r = cat.parseWhatsAppChat(text); } catch (e) { waMsg('Couldn\u2019t read that chat: ' + errText(e), 'err'); return; }
    if (!r || ((!r.messages || !r.messages.length) && !r.phone && !r.name)) {
      waMsg('Couldn\u2019t find any messages in that text. In WhatsApp, select the messages and copy them, or use Export chat \u2192 Without media.', 'err');
      return;
    }
    var filled = [], kept = [];
    var phoneEl = byId('svi-phone'), nameEl = byId('svi-name'), faultEl = byId('svi-fault-text');
    var p = normPhone(r.phone || '');
    if (phoneOk(p) && phoneEl) {
      var cur = normPhone(phoneEl.value);
      if (!cur) {
        phoneEl.value = String(r.phone).trim();
        filled.push('phone');
        onPhoneInput();
        clearTimeout(F.lookup.timer);
        if (F.lookup.phone !== p) doLookup(p);
      } else if (cur !== p) {
        kept.push('phone (the chat has ' + fmtPhone(p) + ')');
      }
    }
    if (r.name && nameEl) {
      if (!nameEl.value.trim() || nameEl.getAttribute('data-auto') === '1') {
        nameEl.value = String(r.name);
        nameEl.removeAttribute('data-auto');      // from the chat, confirmed by staff: treat as typed
        filled.push('name');
      } else if (nameEl.value.trim().toLowerCase() !== String(r.name).trim().toLowerCase()) {
        kept.push('name');
      }
    }
    if (r.faultText && faultEl) {
      if (!faultEl.value.trim()) { faultEl.value = String(r.faultText); filled.push('the customer\u2019s words'); }
      else kept.push('fault text');
    }
    var added = 0;
    (Array.isArray(r.faultKeys) ? r.faultKeys : []).forEach(function (k) {
      if (faultByKey(k) && F.faults.indexOf(k) === -1) { F.faults.push(k); added++; }
    });
    if (added) { filled.push(added === 1 ? '1 fault' : added + ' faults'); renderFaults(); onFaultsChanged(); }
    F.dirty = true; F.deepDirty = true;
    if (!filled.length && !kept.length) { waMsg('Read the chat, but found nothing new to fill in.', ''); return; }
    var msg = filled.length ? 'Filled in ' + filled.join(', ') + '. Check them before creating.' : '';
    if (kept.length) msg += (msg ? ' ' : '') + 'Kept what you had already typed for ' + kept.join(', ') + '.';
    waMsg(msg, filled.length ? 'ok' : '');
  }

  // ── maps link ──────────────────────────────────────────────────────────────
  function scheduleMaps() {
    if (!F) return;
    clearTimeout(F.mapsTimer);
    var token = F.token;
    F.mapsTimer = setTimeout(function () { if (F && F.token === token) onMapsChanged(); }, 200);
  }
  function onMapsChanged() {
    var el = byId('svi-site-maps'), msg = byId('svi-maps-msg');
    if (!el || !msg) return;
    var v = el.value.trim();
    msg.className = 'svi-note svi-span2';
    if (!v) { msg.textContent = ''; return; }
    var ll = parseMapsLink(v);
    if (ll) { msg.textContent = 'Location found: ' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5); msg.className += ' ok'; return; }
    if (isShortMapsLink(v)) {
      msg.textContent = 'Couldn\u2019t read a location from that link \u2014 short links don\u2019t carry one. Open it in a browser and copy the full link, or leave it as it is; the link is still saved.';
    } else if (isHttpUrl(v)) {
      msg.textContent = 'Couldn\u2019t read a location from that link. The link is still saved.';
    } else {
      msg.textContent = 'Couldn\u2019t read a location from that link. Paste a link that starts with https://.';
    }
    msg.className += ' warn';
  }

  // ── faults & summary ───────────────────────────────────────────────────────
  function currentKinds() {
    if (!F || F.type !== 'in_store') return null;
    var set = {};
    itemCards().forEach(function (c) { set[cardField(c, 'kind') || 'other'] = true; });
    return set;
  }
  function faultApplies(f, kinds) {
    if (!kinds) return true;
    if (!Array.isArray(f.kinds) || !f.kinds.length) return true;
    if (kinds.other || kinds.peripheral) return true;     // unknown device: offer everything
    return f.kinds.some(function (k) { return !!kinds[k]; });
  }

  function renderFaults() {
    if (!F) return;
    var host = byId('svi-faults');
    if (!host) return;
    var list = faults();
    if (!list.length) {
      host.innerHTML = '<div class="svi-note">The fault list isn\u2019t loaded. Describe the fault in the customer\u2019s words below.</div>';
      return;
    }
    var kinds = currentKinds();
    // The catalog's own filter when it has one: it also hides faults a remote
    // session cannot fix. An unknown device ('other') means "offer everything".
    var applicable = null;
    var cat = C();
    if (cat && typeof cat.faultsFor === 'function') {
      var kindList = (!kinds || kinds.other || kinds.peripheral) ? [] : Object.keys(kinds);
      try {
        var ok = cat.faultsFor(kindList, F.type);
        if (Array.isArray(ok)) { applicable = {}; ok.forEach(function (f) { if (f && f.key) applicable[f.key] = true; }); }
      } catch (e) { applicable = null; }
    }
    // A fault already picked always stays visible, so nothing selected can hide.
    var shown = list.filter(function (f) {
      if (!f || !f.key) return false;
      if (F.faults.indexOf(f.key) !== -1) return true;
      return applicable ? !!applicable[f.key] : faultApplies(f, kinds);
    });
    var cats = mapOf('CATEGORIES');
    var order = Object.keys(cats);
    var groups = {};
    shown.forEach(function (f) {
      var c = f.category && cats[f.category] ? f.category : '_other';
      (groups[c] = groups[c] || []).push(f);
    });
    var keys = order.filter(function (k) { return groups[k]; });
    if (groups._other) keys.push('_other');
    host.innerHTML = keys.map(function (c) {
      var opts = groups[c].map(function (f) {
        return { value: f.key, label: f.label || f.key, title: f.est_minutes ? 'Usually ' + fmtMinutes(f.est_minutes) : '' };
      });
      return '<div class="svi-fgroup"><div class="svi-fgroup-h">' + esc(c === '_other' ? 'Other' : categoryLabel(c)) + '</div>' +
        chipsHtml('fault', opts, F.faults, { multi: true, label: c === '_other' ? 'Other faults' : categoryLabel(c) }) + '</div>';
    }).join('');
  }

  function toggleFault(chip) {
    var k = chip.getAttribute('data-value');
    var i = F.faults.indexOf(k);
    if (i === -1) F.faults.push(k); else F.faults.splice(i, 1);
    chip.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
    onFaultsChanged();
  }

  function onFaultsChanged() {
    if (!F) return;
    clearSectionErrors('fault');
    maybeSuggestType();
    syncCategoryAuto();
    updateSummary();
  }

  function derivedCategory() {
    var cats = mapOf('CATEGORIES');
    if (F.preset && F.preset.category && cats[F.preset.category]) return F.preset.category;
    var best = null, bestRank = -1;
    F.faults.forEach(function (k) {
      var f = faultByKey(k);
      if (!f || !f.category || !cats[f.category]) return;
      var r = PRIO_RANK[f.priority] != null ? PRIO_RANK[f.priority] : 1;
      if (r > bestRank) { best = f.category; bestRank = r; }
    });
    return best;
  }
  function syncCategoryAuto() {
    var sel = byId('svi-category');
    var opt = sel && sel.querySelector('option[value=""]');
    if (!opt) return;
    var d = derivedCategory();
    opt.textContent = d ? 'Auto \u2014 ' + categoryLabel(d) : 'Auto \u2014 decided by the fault';
  }
  function currentCategory() {
    var sel = byId('svi-category');
    var v = sel ? sel.value : '';
    return v || derivedCategory() || null;
  }

  function neededByIso() {
    var el = byId('svi-needed-by');
    return el && el.value ? dayToIso(el.value) : null;
  }
  function machinesVal() {
    var el = byId('svi-machines');
    var n = el ? parseInt(el.value, 10) : 1;
    return isNaN(n) || n < 1 ? 1 : n;
  }
  // Our workmanship warranty (SPEC-AMENDMENTS A20): OUR_WARRANTY_MONTHS from
  // the linked build's hand-over (or completion). SPEC-GAP: with no build
  // linked, the purchase date typed on the item starts the same clock; with
  // neither there is no evidence, so no boost.
  function inOurWarranty(card, d) {
    if (!card || !d || d.source !== 'neo_tokyo') return false;
    var st = F.builds[card.getAttribute('data-item')];
    if (st && st.linked && st.linked.warrantyEnd != null) return st.linked.warrantyEnd >= Date.now();
    if (!d.pdate) return false;
    var t = new Date(d.pdate + 'T00:00:00').getTime();
    if (isNaN(t) || t > Date.now()) return false;
    return addMonths(t, warrantyMonths()) >= Date.now();
  }

  function priorityCtx() {
    var cards = F.type === 'in_store' ? itemCards() : [];
    var p = cards.length ? cardData(cards[0]) : null;
    var biz = byId('svi-business');
    return {
      service_type: F.type,
      item_purchase_source: p ? (p.source || 'unknown') : null,
      built_by_us_in_warranty: !!p && inOurWarranty(cards[0], p),
      repeat_within_30d: repeatWithin30(),
      needed_by: neededByIso(),
      business: !!(biz && biz.checked),
      machines: F.type === 'on_site' ? machinesVal() : 1
    };
  }

  function updateSummary() {
    if (!F) return;
    var host = byId('svi-summary');
    if (!host) return;
    var cat = C();
    var keys = F.faults.slice();
    var pr = null;
    if (cat && typeof cat.computePriority === 'function') {
      try { pr = cat.computePriority(keys, priorityCtx()); } catch (e) { pr = null; }
    }
    if (!pr || PRIO_RANK[pr.priority] == null) pr = { priority: 'normal', reasons: (pr && pr.reasons) || [] };
    var est = null, checklist = [];
    if (keys.length && cat) {
      try { est = typeof cat.estMinutes === 'function' ? cat.estMinutes(keys) : null; } catch (e) { est = null; }
      try { checklist = typeof cat.mergeChecklists === 'function' ? (cat.mergeChecklists(keys) || []) : []; } catch (e) { checklist = []; }
    }
    F.computed = {
      priority: pr.priority,
      reasons: Array.isArray(pr.reasons) ? pr.reasons.map(String).filter(Boolean) : [],
      est: est,
      checklist: Array.isArray(checklist) ? checklist.map(String) : []
    };

    host.textContent = '';
    var prRow = h('div', { cls: 'svi-sum-row' }, [
      h('span', { cls: 'svi-sum-k', text: 'Priority' }),
      h('span', { cls: 'svi-prio prio-' + F.computed.priority, text: prioLabel(F.computed.priority) })
    ]);
    F.computed.reasons.forEach(function (r) { prRow.appendChild(h('span', { cls: 'svi-reason', text: r })); });
    var override = byId('svi-prio');
    if (override && override.value && isLead()) {
      prRow.appendChild(h('span', { cls: 'svi-reason is-override', text: 'Changed to ' + prioLabel(override.value) }));
    }
    host.appendChild(prRow);

    if (!keys.length) {
      host.appendChild(h('div', { cls: 'svi-sum-row svi-sum-muted', text: 'Pick a fault to see the typical time and the checklist.' }));
    } else {
      var timeRow = h('div', { cls: 'svi-sum-row' }, [
        h('span', { cls: 'svi-sum-k', text: 'Typical time' }),
        h('span', { cls: 'svi-sum-v', text: est ? fmtMinutes(est) : '\u2014' })
      ]);
      if (F.computed.checklist.length) {
        var det = h('details', { cls: 'svi-check-list' }, [
          h('summary', { text: 'Checklist: ' + F.computed.checklist.length + (F.computed.checklist.length === 1 ? ' step' : ' steps') })
        ]);
        var ol = h('ol');
        F.computed.checklist.forEach(function (s) { ol.appendChild(h('li', { text: s })); });
        det.appendChild(ol);
        timeRow.appendChild(det);
      }
      host.appendChild(timeRow);
    }
    var auto = override && override.querySelector('option[value=""]');
    if (auto) auto.textContent = 'Auto \u2014 ' + prioLabel(F.computed.priority);
  }

  function syncPrioControls() {
    var lead = isLead();
    var box = byId('svi-prio-lead'), desk = byId('svi-prio-desk');
    if (box) box.classList.toggle('hidden', !lead);
    if (desk) desk.classList.toggle('hidden', lead);
    var sel = byId('svi-prio'), wrap = byId('svi-prio-reason-wrap');
    if (wrap) wrap.classList.toggle('hidden', !(lead && sel && sel.value));
  }

  function currentPriority() {
    var sel = byId('svi-prio');
    if (isLead() && sel && sel.value && PRIO_RANK[sel.value] != null) {
      var why = String((byId('svi-prio-reason') || {}).value || '').trim();
      return { priority: sel.value, reason: why + ' (set by ' + myName() + ')' };
    }
    var c = (F && F.computed) || { priority: 'normal', reasons: [] };
    return { priority: c.priority, reason: c.reasons.join(', ') };
  }

  // ── technicians ────────────────────────────────────────────────────────────
  function renderTechs() {
    var sel = byId('svi-tech');
    if (!sel) return;
    var cur = sel.value;
    var techs = techList();
    sel.textContent = '';
    sel.appendChild(h('option', { value: '', text: techs.length ? 'No suggestion' : 'No technician list yet' }));
    techs.forEach(function (t) {
      var txt = t.name + ' \u2014 ' + t.open + ' open' +
        (F && F.type === 'on_site' ? ', ' + t.visits + (t.visits === 1 ? ' visit' : ' visits') + ' today' : '');
      sel.appendChild(h('option', { value: t.email, text: txt }));
    });
    if (cur && techs.some(function (t) { return t.email === cur; })) sel.value = cur;
  }

  function syncSelfVisibility() {
    var wrap = byId('svi-self-wrap');
    if (wrap) wrap.classList.toggle('hidden', !canTakeSelf());
    syncSelf();
  }
  function syncSelf() {
    var self = byId('svi-self');
    var on = !!(self && self.checked && canTakeSelf());
    var sel = byId('svi-tech'), reason = byId('svi-tech-reason'), hint = byId('svi-who-hint');
    if (sel) sel.disabled = on;
    if (reason) reason.disabled = on;
    if (hint) hint.textContent = on ? 'It will be assigned to you as soon as it\u2019s created.' : 'A technician claims it from the queue.';
  }

  // ── validation ─────────────────────────────────────────────────────────────
  function clearSectionErrors(sec) {
    var root = rootEl();
    if (!root) return;
    var s = root.querySelector('.svi-sec[data-sec="' + sec + '"]');
    if (!s) return;
    s.querySelectorAll('.svi-err').forEach(function (e) { if (!e.closest('.svi-item')) e.textContent = ''; });
  }
  // Clears the outline on the field being fixed, and the section's (or item's)
  // message once nothing else in it is still marked — so fixing the name does
  // not hide the message about a phone number that is still wrong.
  function clearFieldError(t) {
    if (!t || !t.classList) return;
    var grp = t.classList.contains('svi-chip') ? t.closest('.svi-chips') : null;
    [t, grp].forEach(function (el) {
      if (el) { el.classList.remove('svi-invalid'); el.removeAttribute('aria-invalid'); }
    });
    var card = t.closest('.svi-item');
    if (card) {
      if (!card.querySelector('.svi-invalid')) {
        var ce = card.querySelector('.svi-err[data-err="item"]');
        if (ce) ce.textContent = '';
        card.classList.remove('has-error');
      }
      return;
    }
    var sec = t.closest('.svi-sec');
    if (!sec) return;
    var stillBad = Array.prototype.some.call(sec.querySelectorAll('.svi-invalid'), function (el) { return !el.closest('.svi-item'); });
    if (!stillBad) clearSectionErrors(sec.getAttribute('data-sec'));
  }
  function clearAllErrors() {
    var root = rootEl();
    if (!root) return;
    root.querySelectorAll('.svi-err').forEach(function (e) { e.textContent = ''; });
    root.querySelectorAll('.svi-invalid').forEach(function (e) { e.classList.remove('svi-invalid'); e.removeAttribute('aria-invalid'); });
    root.querySelectorAll('.svi-item.has-error').forEach(function (c) { c.classList.remove('has-error'); });
  }

  function validate() {
    var root = rootEl();
    var errs = [];
    var add = function (key, msg, el, card) { errs.push({ key: key, msg: msg, el: el || null, card: card || null }); };
    var val = function (id) { var e = byId(id); return e ? String(e.value || '').trim() : ''; };

    var phone = normPhone(val('svi-phone'));
    if (!phoneOk(phone)) add('customer', 'Enter the customer’s mobile number — 10 digits, or with the country code for a number outside India.', byId('svi-phone'));
    if (!val('svi-name')) add('customer', 'Enter the customer\u2019s name.', byId('svi-name'));
    var email = val('svi-email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) add('customer', 'That email doesn\u2019t look right.', byId('svi-email'));

    if (F.type === 'in_store') {
      var today = todayYmd();
      itemCards().forEach(function (card) {
        var d = cardData(card);
        if (!d.source) add('item', 'Say where it\u2019s from \u2014 \u201cNot sure\u201d is fine.', chipGroup(card, 'source'), card);
        if (d.source === 'neo_tokyo' && d.build && !/^t_[a-z0-9]{4,}$/i.test(d.build)) {
          add('item', 'A build ticket id starts with t_ \u2014 copy it from the build, or leave it empty.', card.querySelector('[data-f="build"]'), card);
        }
        if ((d.source === 'neo_tokyo' || d.source === 'elsewhere') && d.pdate && d.pdate > today) {
          add('item', 'The purchase date is in the future.', card.querySelector('[data-f="pdate"]'), card);
        }
      });
    }

    if (!F.faults.length && !val('svi-fault-text')) add('fault', 'Pick a fault, or write what the customer says is wrong.', byId('svi-fault-text'));
    var nb = val('svi-needed-by');
    if (nb && nb < todayYmd()) add('needed', 'The \u201cneeds it by\u201d date has already passed.', byId('svi-needed-by'));
    if (isLead()) {
      var ps = byId('svi-prio');
      if (ps && ps.value && !val('svi-prio-reason')) add('needed', 'Say why you changed the priority.', byId('svi-prio-reason'));
    }

    if (F.type === 'in_store') {
      // The device is about to be left with us, and we never back it up.
      if (F.inHand && !readChips(root, 'data_consent')) {
        add('data', 'Ask the customer about the data on it and pick their answer — we don’t back it up.', chipGroup(root, 'data_consent'));
      }
      if (readPassword().length > PW_MAX) add('pw', 'That password is too long — keep it under ' + PW_MAX + ' characters.', byId('svi-pw'));
    }

    if (F.type === 'on_site') {
      if (!val('svi-site-address') && !val('svi-site-area')) add('site', 'Add the site address, or at least the area.', byId('svi-site-address'));
      var pin = val('svi-site-pincode');
      if (pin && !/^\d{6}$/.test(pin)) add('site', 'A pincode is 6 digits.', byId('svi-site-pincode'));
      var maps = val('svi-site-maps');
      if (maps && !isHttpUrl(maps) && !parseMapsLink(maps)) add('site', 'Paste a Maps link that starts with https://, or leave it empty.', byId('svi-site-maps'));
      var mEl = byId('svi-machines');
      var mRaw = mEl ? String(mEl.value || '').trim() : '1';
      if (mRaw && !/^\d+$/.test(mRaw)) add('site', 'Machines must be a whole number, 1 or more.', mEl);
      else if (mRaw && parseInt(mRaw, 10) < 1) add('site', 'Machines must be a whole number, 1 or more.', mEl);
    }
    if (F.type === 'remote') {
      var sess = val('svi-rm-session');
      if (/pass|pwd|pin\b|otp/i.test(sess)) add('remote', 'Only the session ID goes here \u2014 never a password.', byId('svi-rm-session'));
    }
    if (F.type !== 'in_store') {
      var wf = val('svi-win-from'), wt = val('svi-win-to');
      var wfi = fromLocalInput(wf), wti = fromLocalInput(wt);
      if (wf && !wfi) add('window', 'The \u201cfrom\u201d time isn\u2019t a valid date and time.', byId('svi-win-from'));
      if (wt && !wti) add('window', 'The \u201cuntil\u201d time isn\u2019t a valid date and time.', byId('svi-win-to'));
      if (wfi && wti && new Date(wti).getTime() <= new Date(wfi).getTime()) add('window', 'The \u201cuntil\u201d time must be after the \u201cfrom\u201d time.', byId('svi-win-to'));
    }

    if (!errs.length) return false;
    errs.forEach(function (e) {
      var box = e.card ? e.card.querySelector('.svi-err[data-err="item"]') : root.querySelector('.svi-err[data-err="' + e.key + '"]');
      if (box) box.textContent = box.textContent ? box.textContent + ' ' + e.msg : e.msg;
      if (e.card) e.card.classList.add('has-error');
      if (e.el && e.el.classList) { e.el.classList.add('svi-invalid'); e.el.setAttribute('aria-invalid', 'true'); }
    });
    status(errs.length === 1 ? errs[0].msg : 'Fix the ' + errs.length + ' highlighted fields.', 'err');
    var first = errs[0].el || errs[0].card;
    if (first) {
      try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { first.scrollIntoView(); }
      var focusable = first.matches && first.matches('input, select, textarea, button') ? first : (first.querySelector && first.querySelector('button, input, select, textarea'));
      if (focusable) { try { focusable.focus({ preventScroll: true }); } catch (e) { focusable.focus(); } }
    }
    return true;
  }

  // ── payload ────────────────────────────────────────────────────────────────
  function faultLabels(keys) {
    return keys.map(function (k) { var f = faultByKey(k); return f ? (f.label || k) : k; });
  }

  function buildPayload() {
    var val = function (id) { var e = byId(id); return e ? String(e.value || '').trim() : ''; };
    var type = F.type;
    var keys = F.faults.slice();
    var words = val('svi-fault-text');
    var reported = words || faultLabels(keys).join(', ');
    // SPEC-GAP: there is no column for "machines on site"; it drives priority,
    // and the technician needs to know it before leaving, so it rides on the
    // reported fault where the visit card shows it.
    if (type === 'on_site' && machinesVal() > 1) reported += (reported ? '\n' : '') + 'Machines on site: ' + machinesVal();
    var pr = currentPriority();
    var selfOn = canTakeSelf() && !!(byId('svi-self') || {}).checked;
    var tech = selfOn ? '' : val('svi-tech');
    var consent = type === 'in_store' ? readChips(rootEl(), 'data_consent') : null;

    var p = {
      client_request_id: F.crid,
      service_type: type,
      channel: F.channel,
      category: currentCategory(),
      priority: pr.priority,
      priority_reason: pr.reason || null,
      fault_keys: keys,
      reported_fault: reported,
      customer_name: val('svi-name'),
      // '+' and the normalised digits (A1': country code kept, a leading 00
      // dropped). The server normalises again; WhatsApp, the tracking page's
      // last-4 check and every lookup all use that same value.
      customer_phone: '+' + normPhone(val('svi-phone')),
      customer_email: val('svi-email') || null,
      // Records the customer as a business (server only ever raises 'person'
      // to 'business'), so the next intake's lookup ticks it on its own and
      // the business priority bump is not lost on later tickets.
      business: !!(byId('svi-business') || {}).checked,
      // Data on it unless the customer said there is nothing important; not
      // known (null) when the question was not asked. Never the password —
      // that has its own call once the ticket exists (savePassword).
      has_customer_data: consent ? consent !== 'no_important_data' : null,
      data_consent: consent || null,
      needed_by: neededByIso(),
      est_minutes: keys.length ? (F.computed.est || null) : null,
      in_hand: type === 'in_store' ? !!F.inHand : false,
      assign_self: selfOn,
      suggested_tech_email: tech || null,
      suggest_reason: tech ? (val('svi-tech-reason') || null) : null,
      items: [],
      accessories: [],
      condition_note: null,
      powers_on: null
    };

    if (type === 'in_store') {
      var accSet = [];
      itemCards().forEach(function (card) {
        var d = cardData(card);
        var bought = d.source === 'neo_tokyo' || d.source === 'elsewhere';
        p.items.push({
          kind: d.kind,
          label: d.label || null,
          serial: d.serial || null,
          purchase_source: d.source || 'unknown',
          build_ticket_id: d.source === 'neo_tokyo' && d.build ? d.build : null,
          invoice_no: bought && d.invoice ? d.invoice : null,
          purchase_date: bought && d.pdate ? d.pdate : null,
          condition_remarks: d.remarks || null,
          accessories: d.accessories.slice(),
          powers_on: d.powers
        });
        d.accessories.forEach(function (a) { if (accSet.indexOf(a) === -1) accSet.push(a); });
      });
      p.accessories = accSet;
      if (p.items[0]) {
        p.condition_note = p.items[0].condition_remarks;
        p.powers_on = p.items[0].powers_on;
      }
    } else {
      var dev = val('svi-device');
      if (dev) p.items.push({ kind: guessKind(dev), label: dev, purchase_source: 'unknown', accessories: [] });
      p.window_start = fromLocalInput(val('svi-win-from'));
      p.window_end = fromLocalInput(val('svi-win-to'));
      p.window_note = val('svi-win-note') || null;
    }

    if (type === 'on_site') {
      var maps = val('svi-site-maps');
      var ll = parseMapsLink(maps);
      p.site_address = val('svi-site-address') || null;
      p.site_area = val('svi-site-area') || null;
      p.site_pincode = val('svi-site-pincode') || null;
      p.site_landmark = val('svi-site-landmark') || null;
      p.site_contact = val('svi-site-contact') || null;
      p.site_maps_url = maps ? (isHttpUrl(maps) ? maps : (ll ? 'https://maps.google.com/?q=' + ll.lat + ',' + ll.lng : null)) : null;
      p.site_lat = ll ? ll.lat : null;
      p.site_lng = ll ? ll.lng : null;
    }
    if (type === 'remote') {
      p.remote_tool = readChips(rootEl(), 'remote_tool') || null;
      p.remote_session_ref = val('svi-rm-session') || null;
      p.remote_consent_at = (byId('svi-rm-consent') || {}).checked ? new Date().toISOString() : null;
    }
    return p;
  }

  // ── submit ─────────────────────────────────────────────────────────────────
  function status(msg, kind) {
    var el = byId('svi-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'svi-status' + (kind ? ' ' + kind : '');
  }

  function lockForm(on) {
    var fs = byId('svi-form');
    if (fs) fs.disabled = !!on;
    ['svi-create', 'svi-create-wa'].forEach(function (id) { var b = byId(id); if (b) b.disabled = !!on; });
    var c = byId('svi-create');
    if (c) c.textContent = on ? 'Creating\u2026' : 'Create ticket';
  }

  function friendlyCreateError(e) {
    var raw = String((e && (e.message || '')) + ' ' + (e && e.details ? e.details : ''));
    if (/foreign key/i.test(raw) && /build_ticket|tickets/i.test(raw)) {
      return 'One of the build ticket ids wasn\u2019t found. Check it, or leave it empty.';
    }
    return errText(e);
  }

  async function submit(withWa) {
    if (!F || F.busy || F.created) return;
    var token = F.token;
    F.busy = true;                            // covers the photo question too: no second submit meanwhile
    var created = false;
    try { created = await submitInner(token, withWa); }
    finally {
      if (F && F.token === token && !created) { F.busy = false; lockForm(false); }
    }
  }

  async function submitInner(token, withWa) {
    clearAllErrors();
    status('', '');
    if (validate()) return false;
    var d = D();
    if (!d || typeof d.createJob !== 'function') { status('The service data layer isn\u2019t loaded. Restart the app and try again.', 'err'); return false; }
    if (isDemo()) { toast(DEMO_MSG, 'warning'); status('Demo data is on, so the ticket wasn\u2019t created.', 'err'); return false; }

    var withoutPhotos = false;
    if (F.type === 'in_store' && F.inHand && totalPhotos() === 0) {
      var ok = await confirmBox('No condition photos. Accept without photos?',
        { title: 'No condition photos', okText: 'Accept without photos', cancelText: 'Add photos' });
      if (!F || F.token !== token) return false;
      if (!ok) { status('Add condition photos to the item, then create the ticket.', ''); return false; }
      withoutPhotos = true;
    }

    // Recompute now: a lookup reply (repeat visit) or a date may have changed
    // the priority since the summary was last painted.
    updateSummary();
    var payload = buildPayload();
    // Read now, held apart from the payload: it is never sent with the create.
    var pw = readPassword();
    var by = myName();
    lockForm(true);
    status('Creating the ticket\u2026', '');
    var res;
    try {
      res = await d.createJob(payload);
    } catch (e) {
      if (!F || F.token !== token) return false;
      if (isDemoErr(e)) { toast(DEMO_MSG, 'warning'); status('Demo data is on, so the ticket wasn\u2019t created.', 'err'); return false; }
      // The request id is kept, so trying again cannot make a second ticket.
      status('Couldn\u2019t create the ticket: ' + friendlyCreateError(e) + ' Your form is still here; trying again won\u2019t make a duplicate.', 'err');
      return false;
    }
    if (!F || F.token !== token) {
      // The form was closed while the request was out. The ticket exists; say
      // so — unless that was a sign-out (the next person must not see it).
      if (res && res.public_code) lateToast(token, 'Ticket ' + res.public_code + ' was created.', 'success');
      // Its password still goes on it (the desk confirmed closing a form that
      // was mid-create, not throwing the password away). A sign-out's session
      // is gone, so that case is left alone, as every other late write is.
      if (pw && res && res.id && !isStale(token)) savePasswordLate(token, res, pw);
      return false;
    }
    if (!res || !res.id) {
      status('The server didn\u2019t confirm the ticket. Check the board before trying again.', 'err');
      return false;
    }

    F.created = res;
    F.busy = false;
    F.dirty = false;
    F.submitted = payload;
    // From here the password lives only in F.pw (memory) until it is saved.
    F.pw = pw || null;
    F.pwState = pw ? 'queued' : null;
    clearPasswordBox();
    F.uploadPlan = buildUploadPlan(res, payload);
    // Queued, not failed: until runUploads starts, the panel must say "waiting
    // to upload", never "didn't upload".
    F.uploadQueued = F.uploadPlan.some(function (s) { return s.tray && s.tray.count() > 0; });
    showResult();
    toast('Ticket ' + (res.public_code || '') + (res.duplicate ? ' was already created.' : ' created.'), 'success');
    if (withWa) messageCustomer();

    var jobId = res.id;                       // bound: every later write lands on THIS ticket
    // The password first, before the photos: it is the one thing on this
    // screen that exists nowhere else.
    if (F.pw) await savePassword(token, jobId);
    if (!F || F.token !== token) return true;
    if (withoutPhotos) await writeNoPhotoNote(token, jobId, by);
    if (!F || F.token !== token) return true;
    await runUploads(token, jobId);
    return true;
  }

  // Saves F.pw on the ticket this form created. On success the copy in memory
  // is dropped; on failure it stays, the panel says so with Retry, and closing
  // the form asks first. The value is never put in a message.
  async function savePassword(token, jobId) {
    if (!F || F.token !== token || !F.pw || F.pwState === 'saving') return;
    var d = D();
    if (!d || typeof d.setDevicePassword !== 'function') {
      F.pwState = 'failed';
      F.pwError = 'This version of the app can’t store device passwords.';
      paintPassword();
      return;
    }
    F.pwState = 'saving';
    F.pwError = '';
    F.pwShown = false;
    paintPassword();
    try {
      await d.setDevicePassword(jobId, F.pw);
      if (!F || F.token !== token) return;
      F.pw = null;
      F.pwState = 'saved';
      paintPassword();
    } catch (e) {
      if (!F || F.token !== token) {
        lateToast(token, 'The device password for this ticket didn’t save. Set it from the ticket’s Details.', 'error');
        return;
      }
      F.pwState = 'failed';
      F.pwError = errText(e);
      paintPassword();
    }
  }
  // The form is gone (closed mid-create): save without a panel, and say only
  // whether it worked.
  function savePasswordLate(token, res, pw) {
    var d = D();
    var code = res.public_code || 'the new ticket';
    if (!d || typeof d.setDevicePassword !== 'function') {
      lateToast(token, 'The device password for ' + code + ' wasn’t saved. Set it from the ticket’s Details.', 'warning');
      return;
    }
    d.setDevicePassword(res.id, pw).then(function () {
      lateToast(token, 'The device password for ' + code + ' was saved.', 'success');
    }, function () {
      lateToast(token, 'The device password for ' + code + ' didn’t save. Set it from the ticket’s Details.', 'error');
    });
  }

  // Item photos go to the created items IN ORDER. The server returns the items
  // with their sort; a replayed (duplicate) create returns none, so the cache
  // is the fallback. SPEC-GAP: if the counts don't match, nothing is guessed —
  // the photos go on the job without an item rather than on the wrong item.
  function buildUploadPlan(res, payload) {
    var cards = itemCards();
    var ids = [];
    var byOrder = function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); };
    if (Array.isArray(res.items) && res.items.length) {
      ids = res.items.slice().sort(byOrder).map(function (x) { return x.id; });
    } else {
      var d = D();
      try {
        var cached = d && typeof d.itemsOf === 'function' ? (d.itemsOf(res.id) || []) : [];
        ids = cached.slice().sort(byOrder).map(function (x) { return x.id; });
      } catch (e) { ids = []; }
    }
    var mapped = payload.service_type === 'in_store' && ids.length === cards.length;
    return cards.map(function (card, i) {
      var label = cardField(card, 'label');
      return {
        tray: F.trays[card.getAttribute('data-item')] || null,
        // On-site / remote tickets send no items; photos taken under Items
        // before the type changed still belong to this job, so they go on it.
        itemId: mapped ? ids[i] : null,
        label: 'Item ' + (i + 1) + (label ? ' \u2014 ' + label : '')
      };
    }).filter(function (s) { return !!s.tray; });
  }

  async function writeNoPhotoNote(token, jobId, by) {
    var d = D();
    if (!F || F.token !== token) return;
    if (!d || typeof d.addNote !== 'function') { F.noteState = 'failed'; F.noteError = 'The data layer isn\u2019t loaded.'; F.noteBy = by; paintNote(); return; }
    F.noteState = 'saving';
    F.noteBy = by;
    paintNote();
    try {
      await d.addNote(jobId, 'Accepted without photos by ' + by, false);
      if (F && F.token === token) { F.noteState = 'saved'; paintNote(); }
    } catch (e) {
      if (!F || F.token !== token) { lateToast(token, 'The \u201cAccepted without photos\u201d note didn\u2019t save: ' + errText(e), 'error'); return; }
      F.noteState = 'failed';
      F.noteError = errText(e);
      paintNote();
    }
  }

  async function runUploads(token, jobId) {
    if (!F || F.token !== token || F.uploading) return;
    F.uploadQueued = false;
    var P = PT();
    var steps = (F.uploadPlan || []).filter(function (s) { return s.tray && s.tray.count() > 0; });
    var total = steps.reduce(function (n, s) { return n + s.tray.count(); }, 0);
    if (!total) { paintUploads(); return; }
    if (!P || typeof P.uploadAll !== 'function') { status('The photo uploader isn\u2019t loaded. Add the photos from the ticket.', 'err'); paintUploads(); return; }
    F.uploading = true;
    F.upDone = 0;
    F.upTotal = total;
    paintUploads();
    var base = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var n = s.tray.count();
      try {
        var r = await P.uploadAll(s.tray, { jobId: jobId, itemId: s.itemId }, function (done) {
          if (!F || F.token !== token) return;
          F.upDone = base + done;
          paintProgress();
        });
        if (F && F.token === token) F.upOk += r.ok;
      } catch (e) {
        // Refused before it started (already busy, no data layer). Every photo
        // of this step is still in its tray; mark them so the list says why.
        var why = errText(e);
        try {
          s.tray.retain(s.tray.files().map(function (f) { return { file: f.file, role: f.role, remark: f.remark, error: why }; }));
        } catch (x) { /* tray gone */ }
      }
      base += n;
      if (!F || F.token !== token) return;
    }
    F.uploading = false;
    paintUploads();
    var left = pendingPhotos().length;
    if (left) status(left === 1 ? '1 photo didn\u2019t upload. Retry it below.' : left + ' photos didn\u2019t upload. Retry them below.', 'err');
    else if (F.upOk) status(F.upOk === 1 ? '1 photo saved to the ticket.' : F.upOk + ' photos saved to the ticket.', 'ok');
  }

  // ── result panel ───────────────────────────────────────────────────────────
  function showResult() {
    var form = byId('svi-form'), box = byId('svi-result');
    if (form) form.classList.add('hidden');
    var ff = byId('svi-foot-form'), fd = byId('svi-foot-done');
    if (ff) ff.classList.add('hidden');
    if (fd) fd.classList.remove('hidden');
    var res = F.created;
    var title = byId('svi-title'), sub = byId('svi-sub');
    if (title) title.textContent = 'Ticket ' + (res.public_code || 'created');
    if (sub) sub.textContent = (F.submitted ? F.submitted.customer_name : '') + (res.stage ? ' \u00b7 ' + stageLabel(res.stage) : '');
    if (!box) return;
    box.classList.remove('hidden');
    box.textContent = '';

    var p = F.submitted || {};
    var head = h('div', { cls: 'svi-done-head' }, [
      h('div', { cls: 'svi-done-k', text: res.duplicate ? 'Already created' : 'Ticket created' }),
      h('div', { cls: 'svi-done-code', text: res.public_code || '\u2014' }),
      h('div', { cls: 'svi-done-sub', text: [typeLabel(p.service_type), res.stage ? stageLabel(res.stage) : '', p.assign_self ? 'assigned to you' : 'in the queue'].filter(Boolean).join(' \u00b7 ') }),
      h('p', { cls: 'svi-hint', text: 'Give the customer this code. They can track the ticket with it and the last 4 digits of their phone number.' })
    ]);
    box.appendChild(head);
    if (res.duplicate) {
      box.appendChild(h('div', { cls: 'svi-info', text: 'This ticket was already made by an earlier try that lost its connection. Nothing new was created \u2014 open it to check the details.' }));
    }
    var others = Array.isArray(res.open_same_phone) ? res.open_same_phone : [];
    if (others.length) {
      box.appendChild(h('div', { cls: 'svi-warn' }, [
        h('div', { cls: 'svi-warn-main', text: 'Also open for this number: ' + others.map(function (o) {
          return String(o.public_code || '') + ' (' + stageLabel(o.stage) + (o.service_type && o.service_type !== 'in_store' ? ', ' + typeLabel(o.service_type) : '') + ')';
        }).join(', ') })
      ]));
    }
    box.appendChild(h('div', { id: 'svi-done-pw' }));
    box.appendChild(h('div', { id: 'svi-done-note' }));
    box.appendChild(h('div', { id: 'svi-done-up' }));
    var actions = h('div', { cls: 'svi-done-actions' }, [
      h('button', { type: 'button', cls: 'secondary-btn', 'data-act': 'copy', text: 'Copy code' }),
      h('button', { type: 'button', cls: 'secondary-btn', 'data-act': 'wa', text: 'Message on WhatsApp' }),
      h('button', { type: 'button', cls: 'secondary-btn', 'data-act': 'open-created', text: 'Open ticket' }),
      h('button', { type: 'button', cls: 'primary-pink-btn', 'data-act': 'new', text: 'New intake' })
    ]);
    box.appendChild(actions);
    paintPassword();
    paintNote();
    paintUploads();
    var body = byId('svi-body');
    if (body) body.scrollTop = 0;
    status('', '');
  }

  function paintNote() {
    var box = byId('svi-done-note');
    if (!box || !F) return;
    box.textContent = '';
    if (F.noteState === 'saving') box.appendChild(h('div', { cls: 'svi-note', text: 'Saving the \u201cAccepted without photos\u201d note\u2026' }));
    else if (F.noteState === 'saved') box.appendChild(h('div', { cls: 'svi-note ok', text: 'Noted on the ticket: accepted without photos by ' + (F.noteBy || myName()) + '.' }));
    else if (F.noteState === 'failed') {
      box.appendChild(h('div', { cls: 'svi-warn' }, [
        h('div', { cls: 'svi-warn-main', text: 'The \u201cAccepted without photos\u201d note didn\u2019t save: ' + (F.noteError || 'unknown error') }),
        h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'retry-note', text: 'Retry' })
      ]));
    }
  }

  // The password's line in the result panel. The value itself reaches the
  // DOM only while "Show" is pressed, through textContent, and only in the
  // failed state (when the desk may need to read it out or write it down).
  function paintPassword() {
    var box = byId('svi-done-pw');
    if (!box || !F) return;
    box.textContent = '';
    var st = F.pwState;
    if (st === 'queued' || st === 'saving') {
      box.appendChild(h('div', { cls: 'svi-note', text: 'Saving the device password…' }));
    } else if (st === 'saved') {
      box.appendChild(h('div', { cls: 'svi-note ok', text: 'Device password saved. It stays hidden on the ticket and is deleted when the ticket closes.' }));
    } else if (st === 'failed') {
      var val = h('code', { cls: 'svi-pw-val', 'aria-live': 'polite' });
      if (F.pwShown && F.pw) val.textContent = F.pw;
      else val.hidden = true;
      box.appendChild(h('div', { cls: 'svi-warn svi-warn-col' }, [
        h('div', { cls: 'svi-warn-main', text: 'The device password didn’t save: ' + (F.pwError || 'unknown error') +
          ' It’s still here — retry, or set it later from the ticket’s Details.' }),
        val,
        h('div', { cls: 'svi-row' }, [
          h('button', { type: 'button', cls: 'primary-pink-btn svi-btn-sm', 'data-act': 'retry-pw', text: 'Retry' }),
          h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'show-pw', 'aria-pressed': F.pwShown ? 'true' : 'false',
                        text: F.pwShown ? 'Hide' : 'Show' })
        ])
      ]));
    }
  }

  // Shown for 30 seconds at most, like the ticket's own Show.
  function togglePwShown() {
    if (!F) return;
    clearTimeout(F.pwShowTimer);
    F.pwShown = !F.pwShown && !!F.pw;
    if (F.pwShown) {
      var token = F.token;
      F.pwShowTimer = setTimeout(function () {
        if (F && F.token === token && F.pwShown) { F.pwShown = false; paintPassword(); }
      }, 30000);
    }
    paintPassword();
  }

  function paintProgress() {
    var t = byId('svi-up-text'), bar = byId('svi-up-bar');
    if (!F) return;
    var done = Math.min(F.upDone, F.upTotal);
    if (t) t.textContent = 'Uploading photos \u2014 ' + Math.min(done + 1, F.upTotal) + ' of ' + F.upTotal + '\u2026';
    if (bar) bar.style.width = (F.upTotal ? Math.round(done / F.upTotal * 100) : 0) + '%';
  }

  function paintUploads() {
    var box = byId('svi-done-up');
    if (!box || !F) return;
    box.textContent = '';
    if (F.uploadQueued && !F.uploading) {
      var q = pendingPhotos().length;
      box.appendChild(h('div', { cls: 'svi-note', text: (q === 1 ? '1 photo' : q + ' photos') + ' waiting to upload…' }));
      return;
    }
    if (F.uploading) {
      box.appendChild(h('div', { cls: 'svi-up' }, [
        h('div', { id: 'svi-up-text', cls: 'svi-note' }),
        h('div', { cls: 'svi-up-track' }, [h('div', { id: 'svi-up-bar', cls: 'svi-up-bar' })])
      ]));
      paintProgress();
      setDoneButtons(true);
      return;
    }
    setDoneButtons(false);
    if (F.upOk) box.appendChild(h('div', { cls: 'svi-note ok', text: F.upOk === 1 ? '1 photo saved to the ticket.' : F.upOk + ' photos saved to the ticket.' }));
    var pend = pendingPhotos();
    if (!pend.length) return;
    var list = h('ul', { cls: 'svi-fail-list' });
    pend.forEach(function (x) {
      var f = x.file;
      var thumb = f.previewUrl ? h('img', { src: f.previewUrl, alt: '' }) : h('span', { cls: 'svi-fail-doc', text: /\.pdf$/i.test(f.file.name) ? 'PDF' : 'IMG' });
      list.appendChild(h('li', null, [
        thumb,
        h('div', null, [
          h('div', { cls: 'svi-fail-name', text: x.step.label + ' \u00b7 ' + ((PT() && PT().roleLabel) ? PT().roleLabel(f.role) : f.role) + ' \u00b7 ' + f.file.name }),
          h('div', { cls: 'svi-fail-err', text: f.error || 'Not uploaded yet.' })
        ])
      ]));
    });
    box.appendChild(h('div', { cls: 'svi-warn svi-warn-col' }, [
      h('div', { cls: 'svi-warn-main', text: (pend.length === 1 ? '1 photo didn\u2019t upload.' : pend.length + ' photos didn\u2019t upload.') + ' They\u2019re still here \u2014 retry, or add them later from the ticket\u2019s Photos tab.' }),
      list,
      h('div', { cls: 'svi-row' }, [h('button', { type: 'button', cls: 'primary-pink-btn svi-btn-sm', 'data-act': 'retry-uploads', text: 'Retry' })])
    ]));
  }

  function setDoneButtons(uploading) {
    var box = byId('svi-result');
    if (!box) return;
    box.querySelectorAll('[data-act="retry-uploads"]').forEach(function (b) { b.disabled = uploading; });
  }

  function copyText(text, token) {
    if (!text) return;
    var done = function () { lateToast(token, 'Code ' + text + ' copied.', 'success'); };
    var viaElectron = function () {
      try {
        var el = (typeof require === 'function') ? require('electron') : null;
        if (el && el.clipboard && typeof el.clipboard.writeText === 'function') { el.clipboard.writeText(text); done(); return true; }
      } catch (e) { /* not Electron */ }
      return false;
    };
    var fail = function () { if (!viaElectron()) lateToast(token, 'Couldn\u2019t copy. The code is ' + text + '.', 'warning'); };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  function createdJobView() {
    var res = F.created, p = F.submitted || {};
    var d = D(), cached = null;
    try { cached = d && typeof d.job === 'function' ? d.job(res.id) : null; } catch (e) { cached = null; }
    var base = {
      id: res.id,
      public_code: res.public_code,
      stage: res.stage || (p.service_type === 'in_store' && p.in_hand ? 'received' : 'logged'),
      service_type: p.service_type,
      channel: p.channel,
      customer_name: p.customer_name,
      customer_phone: p.customer_phone,
      device_label: p.items && p.items[0] ? p.items[0].label : null,
      reported_fault: p.reported_fault
    };
    return Object.assign(base, cached || {});
  }

  function fallbackCreatedText(j) {
    var code = String(j.public_code || '');
    var name = firstName(j.customer_name);
    return 'Hello' + (name ? ' ' + name : '') + ', this is Neo Tokyo. We have logged your service request ' + code + '.\n' +
      'Track it here: ' + TRACK_URL + encodeURIComponent(code) + '\n' +
      'Use the last 4 digits of this phone number to open it.';
  }

  function messageCustomer() {
    if (!F || !F.created) return;
    var j = createdJobView();
    var cat = C(), text = null;
    try { text = cat && cat.WA_TEMPLATES && typeof cat.WA_TEMPLATES.created === 'function' ? cat.WA_TEMPLATES.created(j) : null; }
    catch (e) { text = null; }
    if (!text) text = fallbackCreatedText(j);
    var phone = normPhone(j.customer_phone || (F.submitted && F.submitted.customer_phone) || '');
    var ui = UI(), ok;
    if (ui && typeof ui.waOpen === 'function') ok = ui.waOpen(phone, text);
    else ok = phoneOk(phone) ? openExternal('https://wa.me/' + phone + '?text=' + encodeURIComponent(text)) : false;
    if (ok === false) status('Couldn\u2019t open WhatsApp for this number. Check it is a mobile number with WhatsApp.', 'err');
    else status('WhatsApp is opening with the message. Check it, then press send.', 'ok');
  }

  async function openCreated() {
    if (!F || !F.created) return;
    var token = F.token;
    var id = F.created.id, code = F.created.public_code;
    var closed = await close();
    if (!closed) return;
    var ui = window.NeoQcServiceUI;
    if (!ui || typeof ui.openJob !== 'function') { lateToast(token, 'Couldn\u2019t open ' + code + ' from here. Find it on the board.', 'warning'); return; }
    try { await ui.openJob(id); }
    catch (e) { lateToast(token, 'Couldn\u2019t open ' + code + ': ' + errText(e), 'error'); }
  }

  async function newIntake() {
    if (!F) return;
    var token = F.token;
    var q = closeQuestion();
    if (q) {
      var ok = await confirmBox(q.msg, { title: q.title, okText: q.ok, cancelText: q.cancel, danger: true });
      if (!ok || !F || F.token !== token) return;
    }
    var root = rootEl();
    teardown();
    if (!root) return;
    render(root, null);
    var ph = byId('svi-phone');
    if (ph) ph.focus();
  }

  // ── event wiring (delegated on the persistent #sv-intake-root) ─────────────
  function markDirty(target) {
    if (!F || F.created) return;
    F.dirty = true;
    if (!target || !target.closest || !target.closest('#svi-sec-customer')) F.deepDirty = true;
    if (target && target.closest && target.closest('#svi-items')) F.itemsTouched = true;
  }

  function onChip(chip) {
    var grp = chip.closest('.svi-chips');
    if (!grp) return;
    var group = grp.getAttribute('data-group');
    var card = chip.closest('.svi-item');
    markDirty(chip);
    if (group === 'fault') { toggleFault(chip); return; }
    if (group === 'cond') { toggleCondition(card, chip.getAttribute('data-value')); clearFieldError(chip); return; }
    var multi = grp.getAttribute('data-multi') === '1';
    var optional = grp.getAttribute('data-optional') === '1';
    var pressed = chip.getAttribute('aria-pressed') === 'true';
    if (multi) {
      chip.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    } else if (pressed) {
      if (!optional) return;
      chip.setAttribute('aria-pressed', 'false');
    } else {
      grp.querySelectorAll('.svi-chip').forEach(function (b) { b.setAttribute('aria-pressed', b === chip ? 'true' : 'false'); });
    }
    clearFieldError(grp);
    if (group === 'channel') { setChannel(chip.getAttribute('data-value'), true); return; }
    if (group === 'inhand') { F.inHand = readChips(rootEl(), 'inhand') !== 'no'; F.inHandTouched = true; syncInHand(); return; }
    if (group === 'source' && card) { syncSource(card); updateSummary(); }
  }

  function onAct(el) {
    var act = el.getAttribute('data-act');
    if (act === 'open-job') { openExisting(el.getAttribute('data-id'), el.getAttribute('data-code')); return; }
    if (act === 'open-rma') {
      var ui = window.NeoQcRmaUI;
      var id = el.getAttribute('data-id');
      var tok = F.token;
      if (ui && typeof ui.openUnit === 'function' && id) {
        close().then(function (closed) { if (closed && !isStale(tok)) { try { ui.openUnit(id); } catch (e) { lateToast(tok, 'Couldn\u2019t open that RMA: ' + errText(e), 'error'); } } });
      }
      return;
    }
    if (act === 'suggest-tech') { suggestTech(el.getAttribute('data-email')); return; }
    var card = el.closest('.svi-item');
    if (card && !F.created) {
      var bst = buildState(card.getAttribute('data-item'));
      if (act === 'find-build') { scheduleBuildFind(card, true); return; }
      if (act === 'pick-build') { pickBuild(card, bst.results[Number(el.getAttribute('data-i'))]); return; }
      if (act === 'unlink-build') { unlinkBuild(card); return; }
      if (act === 'link-serial') { pickBuild(card, bst.serialHit); return; }
      if (act === 'dismiss-serial') {
        bst.dismissed[cardField(card, 'serial').toUpperCase().replace(/[^A-Z0-9]/g, '')] = true;
        var sb = card.querySelector('[data-role="serial-sug"]');
        if (sb) { sb.textContent = ''; sb.classList.add('hidden'); }
        return;
      }
    }
    if (act === 'use-name') {
      var cust = F.lookup.result && F.lookup.result.customer;
      var n = byId('svi-name');
      if (cust && cust.name && n) { n.value = String(cust.name); n.removeAttribute('data-auto'); markDirty(n); renderLookup(F.lookup.result); }
      return;
    }
    if (act === 'switch-type') { setType(el.getAttribute('data-type-to'), true); markDirty(el); return; }
    if (act === 'copy') { copyText(F.created && F.created.public_code, F.token); return; }
    if (act === 'wa') { messageCustomer(); return; }
    if (act === 'open-created') { openCreated(); return; }
    if (act === 'new') { newIntake(); return; }
    if (act === 'retry-pw') { if (F.created) savePassword(F.token, F.created.id); return; }
    if (act === 'show-pw') { togglePwShown(); return; }
    if (act === 'retry-uploads') { if (F.created) runUploads(F.token, F.created.id); return; }
    if (act === 'retry-note') { if (F.created) writeNoPhotoNote(F.token, F.created.id, F.noteBy || myName()); }
  }

  function onClick(e) {
    if (!F) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.svi-tray')) return;                 // the tray handles its own buttons
    if (t.closest('#svi-close') || t.closest('#svi-cancel') || t.closest('#svi-done-close')) { close(); return; }
    if (t.closest('#svi-create')) { submit(false); return; }
    if (t.closest('#svi-create-wa')) { submit(true); return; }
    if (t.closest('#svi-wa-fill')) { fillFromChat(); return; }
    if (t.closest('#svi-add-item')) { addItem(null, true, false); return; }
    if (t.closest('#svi-pw-show')) { var pwIn = byId('svi-pw'); setPwVisible(!!pwIn && pwIn.type === 'password'); return; }
    var typeBtn = t.closest('.svi-type');
    if (typeBtn) { markDirty(typeBtn); setType(typeBtn.getAttribute('data-type'), true); return; }
    var x = t.closest('.svi-item-x');
    if (x) { removeItem(x.closest('.svi-item')); return; }
    var act = t.closest('[data-act]');
    if (act) { onAct(act); return; }
    var chip = t.closest('.svi-chip');
    if (chip) onChip(chip);
  }

  function onInput(e) {
    if (!F || F.created) return;
    var t = e.target;
    if (!t || !t.closest || t.closest('.svi-tray')) return;
    markDirty(t);
    clearFieldError(t);
    if (t.getAttribute('data-auto') === '1') t.removeAttribute('data-auto');
    switch (t.id) {
      case 'svi-phone': onPhoneInput(); break;
      case 'svi-name': if (F.lookup.result) renderLookup(F.lookup.result); break;
      case 'svi-site-maps': scheduleMaps(); break;
      case 'svi-machines': case 'svi-needed-by': updateSummary(); break;
      case 'svi-fault-text': clearSectionErrors('fault'); break;
    }
    var card = t.closest('.svi-item');
    if (card) {
      F.itemsTouched = true;
      var f = t.getAttribute('data-f');
      if (f === 'remarks') syncCondChips(card);
      if (f === 'pdate') updateSummary();
      if (f === 'bfind') scheduleBuildFind(card, false);
      if (f === 'build') onBuildIdTyped(card);
      if (f === 'serial') scheduleSerialCheck(card);
    }
  }

  function onChange(e) {
    if (!F || F.created) return;
    var t = e.target;
    if (!t || !t.closest || t.closest('.svi-tray')) return;
    markDirty(t);
    clearFieldError(t);
    switch (t.id) {
      case 'svi-business': F.businessTouched = true; t.removeAttribute('data-auto'); updateSummary(); return;
      case 'svi-self': syncSelf(); return;
      case 'svi-tech': {
        // Picked by hand now: it is no longer "the one from their history".
        F.techFromLookup = null;
        var reason = byId('svi-tech-reason');
        if (reason && reason.getAttribute('data-auto') === '1') clearAuto(reason);
        return;
      }
      case 'svi-prio': syncPrioControls(); updateSummary(); return;
      case 'svi-needed-by': updateSummary(); return;
      case 'svi-site-maps': onMapsChanged(); return;
    }
    var card = t.closest('.svi-item');
    if (card) {
      F.itemsTouched = true;
      var f = t.getAttribute('data-f');
      if (f === 'kind') { renderFaults(); updateSummary(); }
      if (f === 'pdate') updateSummary();
    }
  }

  // Scanner rule: Enter in an input never submits or closes anything.
  // Textareas keep their newlines; a focused button still activates.
  function onKeydown(e) {
    if (e.key !== 'Enter') return;
    var tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
  }

  function onFocusIn(e) {
    if (!F) return;
    if (e.target && e.target.id === 'svi-tech' && techList().length && e.target.options.length <= 1) renderTechs();
  }

  // Esc asks before throwing typed work away — but only when this form is the
  // thing in front; a confirm box or dialog on top handles its own Esc.
  function onDocKey(e) {
    if (e.key !== 'Escape' || !F) return;
    var modal = byId('sv-intake-modal');
    if (!modal || !modal.classList.contains('active')) return;
    if (topOverlay() !== modal) return;
    e.preventDefault();
    close();
  }

  function bindOnce(root) {
    if (root.getAttribute('data-svi-bound') !== '1') {
      root.setAttribute('data-svi-bound', '1');
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('change', onChange);
      root.addEventListener('keydown', onKeydown);
      root.addEventListener('focusin', onFocusIn);
    }
    if (!keysBound) {
      keysBound = true;
      document.addEventListener('keydown', onDocKey);
    }
  }

  // ── preset from an RMA unit ────────────────────────────────────────────────
  // For "this part needs a paid repair": a ready preset for open({preset}).
  function presetFromRma(unit) {
    if (!unit) return null;
    var d = D(), intake = null;
    try { intake = unit.intake_id && d && typeof d.intake === 'function' ? d.intake(unit.intake_id) : null; } catch (e) { intake = null; }
    var s = S();
    var label = [unit.brand, unit.model].filter(Boolean).join(' ');
    if (!label && s && typeof s.itemLabel === 'function') { try { label = s.itemLabel(unit.kind, unit.brand, unit.model); } catch (e) { label = ''; } }
    return {
      customer_name: unit.owner_name || (intake && intake.sender_name) || '',
      customer_phone: unit.owner_phone || (intake && intake.sender_phone) || '',
      channel: 'staff',
      category: 'repair',
      service_type: 'in_store',
      in_hand: true,
      reported_fault: unit.fault || '',
      items: [{
        kind: unit.kind || 'other',
        label: label || null,
        serial: unit.serial || null,
        purchase_source: unit.purchase_source || null,
        invoice_no: unit.invoice_no || null,
        purchase_date: unit.purchase_date || null,
        build_ticket_id: unit.build_ticket_id || null
      }]
    };
  }

  window.NeoQcServiceIntake = {
    open: open,
    close: close,
    presetFromRma: presetFromRma,
    isOpen: function () { var m = byId('sv-intake-modal'); return !!(F && m && m.classList.contains('active')); },
    // exposed for tests
    _normPhone: normPhone,
    _phoneOk: phoneOk,
    _parseMapsLink: parseMapsLink,
    _toggleConditionText: toggleConditionText,
    _hasPart: hasPart,
    _guessKind: guessKind,
    _defaultInHand: defaultInHand
  };
})();
