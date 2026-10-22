/*
  Neo OS — the one work queue (builds + service), as pure rules: window.NeoQcWork.

  ONE copy, loaded by the Electron app and (through sync-shared.js) the
  website. No DOM, no network: every function takes plain objects and a clock
  and answers the same way everywhere, so the queue screen, the ticket modal,
  the service chips and the website can never disagree about how long is left.

  The server (sql/work-queue.sql, v2.2) is the authority. These mirror it for
  display only:
    - CLAIM_HOURS / OFFER_MINUTES  — owner decision 2026-10-22: every queued item
      has 4 hours to be claimed; an offer must be accepted within 30 minutes.
    - whyNot()                     — mirrors _work_why_not (the offer dialogs grey
      out people who cannot take an item, with the same sentence the server
      would answer).
    - buildTier / buildCost / serviceCost — mirror _build_tier and the
      _work_cost_* helpers (load points).

  CLOCKS. A PC or phone a few minutes slow would show minutes that do not
  exist (WQ-C11). Every countdown uses
      nowMs = Date.now() + serverOffsetMs(feed.now, receivedAtMs)
  from the last work_queue / work_team answer. fmtLeft() rounds DOWN, so a
  countdown never promises a second the person does not have.

  Two shapes are read:
    - a work_queue ITEM (snake_case: kind, id, code, queued_at, claim_due,
      assignee_email, assignee_name, offer {to_email, to_name, expires_at…},
      offered_to_me, mine, deadline, …);
    - a desktop build ticket (camelCase: technician, technicianEmail,
      assignedVia, assignedAt, queuedAt, offer {toEmail, toName, expiresAt…},
      status) — and, for the website, the same ticket as a server row
      (technician_email, queued_at, offered_to_name, offer_expires_at…).

  Usage:
    var W = window.NeoQcWork;
    W.claimRisk(item, now)            // 0 fine | 1 ≥ 3 h waiting | 2 past 4 h
    W.fmtLeft(W.offerLeftMs(item, now))   // "18m"
    W.buildAssignText(ticket, now)    // { label: 'In the build queue · claim within 3h 10m', tone: 'ok' }
    W.whyNot(person, 'build', 4)      // 'senior'
    W.whySentence('no_pool', 'service', true)  // "You aren't in the service pool."
*/
(function (global) {
  'use strict';

  var SEC = 1000;
  var MIN = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;

  var CLAIM_HOURS = 4;
  var OFFER_MINUTES = 30;
  var CLAIM_MS = CLAIM_HOURS * HOUR;
  var RISK_AT = 0.75;                       // 3 of the 4 hours gone → "at risk"
  var ROLE_RANK = { desk: 1, tech: 2, lead: 3 };
  var TYPE_LABEL = { in_store: 'In-store', on_site: 'On-site', remote: 'Remote' };

  // ── small helpers ──────────────────────────────────────────────────────────
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function trim(v) { return v == null ? '' : String(v).trim(); }
  function lower(v) { return trim(v).toLowerCase(); }
  function first(o, keys) {
    if (!o) return null;
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v != null && v !== '') return v;
    }
    return null;
  }
  // A timestamp (ISO string, Date or epoch ms) as epoch ms, or null.
  function toMs(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) { var d = v.getTime(); return isFinite(d) ? d : null; }
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var t = Date.parse(String(v));
    return isFinite(t) ? t : null;
  }
  function nowOf(nowMs) { var n = Number(nowMs); return isFinite(n) && nowMs != null ? n : Date.now(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ── the server clock ───────────────────────────────────────────────────────
  // How far this device's clock is behind (+) or ahead (−) of the server, from
  // the `now` a work_queue / work_team answer carried and the local time the
  // answer arrived. 0 when either is unreadable.
  function serverOffsetMs(feedNow, receivedAtMs) {
    var t = toMs(feedNow);
    var r = Number(receivedAtMs);
    if (t == null || !isFinite(r) || receivedAtMs == null) return 0;
    return t - r;
  }

  // ── durations ──────────────────────────────────────────────────────────────
  // "3h 12m" / "24m" / "45s"; 0 or less → "0s". Always rounds DOWN.
  function fmtLeft(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '0s';
    if (n < MIN) return Math.floor(n / SEC) + 's';
    if (n < HOUR) return Math.floor(n / MIN) + 'm';
    var h = Math.floor(n / HOUR);
    var m = Math.floor((n - h * HOUR) / MIN);
    return h + 'h ' + pad2(m) + 'm';
  }
  // "overdue 1h 05m" for an amount of time past a limit (the sign is ignored).
  function fmtOverdue(ms) {
    var n = Math.abs(Number(ms));
    if (!isFinite(n)) n = 0;
    return 'overdue ' + fmtLeft(n);
  }
  // "just now" / "12m ago" / "2h ago" / "3d ago".
  function fmtAgo(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < MIN) return 'just now';
    if (n < HOUR) return Math.floor(n / MIN) + 'm ago';
    if (n < 2 * DAY) return Math.floor(n / HOUR) + 'h ago';
    return Math.floor(n / DAY) + 'd ago';
  }
  // Local wall-clock "HH:MM" (24 h), e.g. for "accept by 14:30". '' when unreadable.
  function fmtClock(v) {
    var t = toMs(v);
    if (t == null) return '';
    var d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ── builds: tier and load points ───────────────────────────────────────────
  // specs.__build.tier, 1–5, default 1. Never throws on junk. Mirrors
  // _build_tier exactly: __build must be an object; the tier's text must be
  // 1–6 digits with an optional fraction (so no sign, no exponent), floored
  // and clamped. specs may be the object or its JSON text.
  function clampTier(v) {
    var t = (typeof v === 'number') ? (isFinite(v) ? String(v) : '') : (typeof v === 'string' ? v.trim() : '');
    if (!/^[0-9]{1,6}(\.[0-9]+)?$/.test(t)) return 1;
    var n = Math.floor(Number(t));
    return n < 1 ? 1 : n > 5 ? 5 : n;
  }
  function buildTier(specs) {
    var s = specs;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 1;
    var b = s.__build;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 1;
    return clampTier(b.tier);
  }
  // An item's tier as a number (work_queue's build_tier, or a caller's), 1 when unreadable.
  function tierNumber(v) {
    if (v && typeof v === 'object') return buildTier(v);
    var n = Number(v);
    return (v == null || v === '' || !isFinite(n)) ? 1 : Math.floor(n);
  }
  function buildCost(specs) { return buildTier(specs); }
  // An on-site visit takes a technician out of the shop: it counts double.
  function serviceCost(serviceType) { return serviceType === 'on_site' ? 2 : 1; }

  // ── shapes ─────────────────────────────────────────────────────────────────
  // §1: build → technician_email or a non-blank technician (a legacy
  // name-only assignment counts); service → assignee_email.
  function isAssigned(x) {
    if (!x || typeof x !== 'object') return false;
    if (trim(first(x, ['assignee_email', 'technicianEmail', 'technician_email']))) return true;
    if (trim(x.assignee_name)) return true;           // feed item: a legacy name-only build
    if (trim(x.technician)) return true;              // desktop ticket / server row
    return false;
  }

  // The offer on an item, normalised: { toEmail, toName, kind, byName, byEmail,
  // reason, offeredAt, expiresAt } or null. Reads the feed's offer object, the
  // desktop ticket's offer object and a service_jobs / tickets row's columns.
  function offerOf(x) {
    if (!x || typeof x !== 'object') return null;
    var o = x.offer;
    if (o && typeof o === 'object') {
      var exp = first(o, ['expires_at', 'expiresAt']);
      if (exp == null) return null;
      return {
        toEmail: first(o, ['to_email', 'toEmail']),
        toName: first(o, ['to_name', 'toName']),
        kind: first(o, ['kind']),
        byName: first(o, ['by_name', 'byName']),
        byEmail: first(o, ['by_email', 'byEmail']),
        reason: first(o, ['reason']),
        offeredAt: first(o, ['offered_at', 'offeredAt']),
        expiresAt: exp
      };
    }
    if (x.offer_expires_at == null || x.offer_expires_at === '') return null;
    return {
      toEmail: x.offered_to_email || null,
      toName: x.offered_to_name || null,
      kind: x.offer_kind || null,
      byName: x.offer_by_name || null,
      byEmail: x.offer_by_email || null,
      reason: x.offer_reason || null,
      offeredAt: x.offered_at || null,
      expiresAt: x.offer_expires_at
    };
  }
  // ms until the offer runs out (≤ 0 once it has), or null when there is none.
  function offerLeftMs(item, nowMs) {
    var o = offerOf(item);
    var t = o ? toMs(o.expiresAt) : null;
    return t == null ? null : t - nowOf(nowMs);
  }
  function offerLive(item, nowMs) {
    var left = offerLeftMs(item, nowMs);
    return left != null && left > 0;
  }

  // When the 4-hour claim window ends: claim_due, else queued_at + 4 h.
  function claimDueMs(item) {
    if (!item || typeof item !== 'object') return null;
    var due = toMs(first(item, ['claim_due', 'claimDue']));
    if (due != null) return due;
    var q = toMs(first(item, ['queued_at', 'queuedAt']));
    return q == null ? null : q + CLAIM_MS;
  }
  // 0 under 75 % of the window, 1 from 3 h, 2 from 4 h. 0 for anything assigned
  // or never queued.
  function claimRisk(item, nowMs) {
    if (!item || isAssigned(item)) return 0;
    var due = claimDueMs(item);
    if (due == null) return 0;
    var waited = nowOf(nowMs) - (due - CLAIM_MS);
    if (waited >= CLAIM_MS) return 2;
    if (waited >= CLAIM_MS * RISK_AT) return 1;
    return 0;
  }

  function kindLabel(item) {
    if (!item) return 'In-store';
    if (item.kind === 'build') return 'Build';
    return TYPE_LABEL[item.service_type] || 'In-store';
  }

  // The §2.7.1 order: offered to me (soonest expiry first), then the open
  // queue (soonest claim deadline first, no deadline last), then my work
  // (soonest deadline first, none last), then anything else a lead sees (live
  // offers on items someone holds). A new array; the input is not touched.
  function sortItems(items, nowMs) {
    var list = Array.isArray(items) ? items.slice() : [];
    function group(it) {
      if (it && it.offered_to_me) return 0;
      if (it && !isAssigned(it)) return 1;
      if (it && it.mine) return 2;
      return 3;
    }
    function key(it, g) {
      var v = null;
      if (g === 0 || g === 3) v = toMs((offerOf(it) || {}).expiresAt);
      else if (g === 1) v = claimDueMs(it);
      else v = toMs(it && it.deadline);
      if (v == null && g === 3) v = toMs(it && it.deadline);
      return v;
    }
    var decorated = list.map(function (it, i) { var g = group(it); return { it: it, g: g, k: key(it, g), i: i }; });
    decorated.sort(function (a, b) {
      if (a.g !== b.g) return a.g - b.g;
      if (a.k == null && b.k != null) return 1;
      if (b.k == null && a.k != null) return -1;
      if (a.k != null && b.k != null && a.k !== b.k) return a.k - b.k;
      return a.i - b.i;
    });
    return decorated.map(function (d) { return d.it; });
  }

  // ── builds on the desktop / website ────────────────────────────────────────
  function buildFields(t) {
    var o = t || {};
    return {
      technician: trim(o.technician),
      email: trim(first(o, ['technicianEmail', 'technician_email'])),
      via: first(o, ['assignedVia', 'assigned_via']),
      at: first(o, ['assignedAt', 'assigned_at']),
      queuedAt: first(o, ['queuedAt', 'queued_at']),
      status: o.status
    };
  }
  // Queued: nobody has it, it was sent to the floor, and it is not finished.
  function isQueuedBuild(t) {
    if (!t) return false;
    var b = buildFields(t);
    return !b.technician && !b.email && b.queuedAt != null && b.status !== 'completed';
  }
  // A quote: nobody has it and it was never sent to the floor.
  function isQuoteBuild(t) {
    if (!t) return false;
    var b = buildFields(t);
    return !b.technician && !b.email && b.queuedAt == null && b.status !== 'completed';
  }
  function shortName(name, email) {
    var n = trim(name);
    if (n) return n.split(/\s+/)[0];
    var e = trim(email);
    if (!e) return '';
    var local = e.split('@')[0].split(/[._-]/)[0];
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : e;
  }

  // One line for a build's assignment, for the ticket modal and the cards.
  // tone: 'ok' | 'warn' | 'late' | 'muted'.
  function buildAssignText(t, nowMs) {
    var now = nowOf(nowMs);
    var b = buildFields(t);
    var offer = offerOf(t);
    var left = offer ? toMs(offer.expiresAt) - now : null;
    var live = left != null && left > 0;
    var offerTo = live ? (shortName(offer.toName, offer.toEmail) || 'someone') : '';

    if (b.technician || b.email) {
      var who = b.technician || shortName('', b.email);
      var label, tone = 'ok';
      if (b.via === 'legacy' || !b.email) { label = who + ' (old assignment)'; tone = 'muted'; }
      else {
        var at = toMs(b.at);
        label = (b.via === 'claim' ? 'Claimed by ' : 'Assigned to ') + who + (at != null ? ' · ' + fmtAgo(now - at) : '');
      }
      // A lead's reassignment offer: the current technician keeps it until the
      // other person accepts.
      if (live && lower(offer.toEmail) !== lower(b.email)) label += ' · offered to ' + offerTo + ' (' + fmtLeft(left) + ' left)';
      return { label: label, tone: tone };
    }
    if (b.status === 'completed') return { label: 'No technician recorded', tone: 'muted' };
    if (live) return { label: 'Offered to ' + offerTo + ' · ' + fmtLeft(left) + ' left', tone: 'warn' };
    if (isQueuedBuild(t)) {
      var risk = claimRisk(t, now);
      if (risk === 2) return { label: 'In the build queue · overdue — the app is offering it', tone: 'late' };
      var due = claimDueMs(t);
      return { label: 'In the build queue · claim within ' + fmtLeft(due - now), tone: risk === 1 ? 'warn' : 'ok' };
    }
    return { label: 'Not sent to the floor yet', tone: 'muted' };
  }

  // ── eligibility (mirrors _work_why_not / _work_why_text) ──────────────────
  var WHY = {
    not_staff: { they: "They don't have an active staff account.", you: "You don't have an active staff account." },
    no_role: {
      build:   { they: "They don't have the Builds technician role.", you: "You don't have the Builds technician role." },
      service: { they: "They don't have the Service technician role.", you: "You don't have the Service technician role." }
    },
    no_pool: {
      build:   { they: "They aren't in the build pool.", you: "You aren't in the build pool." },
      service: { they: "They aren't in the service pool.", you: "You aren't in the service pool." }
    },
    senior: { they: 'This is a high-value build — only senior builders can take it.',
              you: 'This is a high-value build — only senior builders can take it.' }
  };
  function whySentence(code, kind, self) {
    var w = has(WHY, code) ? WHY[code] : null;
    if (!w) return null;
    var k = kind === 'build' ? 'build' : 'service';
    var pick = has(w, k) ? w[k] : w;
    return self ? pick.you : pick.they;
  }

  // null when the person may take the item, else 'not_staff' | 'no_role' |
  // 'no_pool' | 'senior'. person: a work_team person ({tier, qc_role,
  // service_role, build_pool, service_pool, build_level, active?}) or a
  // service_tech_list row ({role = their service role, service_pool, …}).
  // buildTier: the build's tier (a number) or its specs.
  function whyNot(person, kind, tier) {
    var p = person;
    if (!p || typeof p !== 'object' || p.active === false || p.is_staff === false) return 'not_staff';
    var k = kind === 'build' ? 'build' : 'service';
    var role = k === 'build' ? p.qc_role : (has(p, 'service_role') ? p.service_role : p.role);
    if ((Number(p.tier) || 0) >= 3) role = 'lead';     // tier 3+ leads every module
    if ((ROLE_RANK[role] || 0) < 2) return 'no_role';
    if ((k === 'build' ? p.build_pool : p.service_pool) !== true) return 'no_pool';
    if (k === 'build' && tierNumber(tier) >= 4 && p.build_level !== 'senior') return 'senior';
    return null;
  }

  var api = {
    CLAIM_HOURS: CLAIM_HOURS,
    OFFER_MINUTES: OFFER_MINUTES,
    serverOffsetMs: serverOffsetMs,
    claimDueMs: claimDueMs,
    claimRisk: claimRisk,
    offerOf: offerOf,
    offerLeftMs: offerLeftMs,
    offerLive: offerLive,
    fmtLeft: fmtLeft,
    fmtOverdue: fmtOverdue,
    fmtAgo: fmtAgo,
    fmtClock: fmtClock,
    toMs: toMs,
    kindLabel: kindLabel,
    sortItems: sortItems,
    isAssigned: isAssigned,
    buildTier: buildTier,
    buildCost: buildCost,
    serviceCost: serviceCost,
    isQueuedBuild: isQueuedBuild,
    isQuoteBuild: isQuoteBuild,
    buildAssignText: buildAssignText,
    whyNot: whyNot,
    whySentence: whySentence
  };

  // ALWAYS set the browser global when a window exists (Electron renderers
  // define `module` too — see shared/matcher.js for the bug that taught us).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcWork = api;
  }
})(typeof window !== 'undefined' ? window : this);
