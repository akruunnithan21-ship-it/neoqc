/*
  Neo QC website — "Where is my PC?" service status page.
  Tracks two kinds of code:
    NT-XXXXXXXX  a service ticket (in-store repair, on-site visit or remote session)
    RM-XXXXXXXX  one part under warranty claim (RMA), including couriered parts

  TWO RULES THIS FILE EXISTS TO HONOUR, both learned the hard way:

  1. It POLLS get_service_public / get_rma_public and never subscribes to
     postgres_changes. A realtime payload bypasses SECURITY DEFINER entirely and
     delivers the raw row to whoever subscribed — the phone number, the internal
     diagnosis, the staff email, an RMA's serial and fee. The curated column list
     in those functions is the privacy boundary, and a realtime subscription
     would walk straight around it.

  2. Customer- and staff-authored free text is written with textContent, never
     interpolated into markup. escHtml() in app.js escapes & < > and " but NOT
     the single quote, which is documented in that file and is exactly the gap
     that bites inside an attribute. Nothing here builds an attribute from data
     (class names come from fixed whitelists, never from a server string).

  The status wording itself comes from shared/service-status.js — the same module
  the Electron app uses — so what the customer reads can never drift from what
  the shop sees. That includes the RMA model (rmaCustomerLabel,
  rmaWaitingSentence, the disposition wording).
*/
(function () {
  'use strict';

  var POLL_MS = 30000;
  var pollTimer = null;
  var lastArgs = null;        // {code, phone4, kind} of the result on screen, for the refresh tick
  var userBusy = false;       // a lookup the customer asked for is in flight
  var linkedCode = null;      // the NT- code a part belongs to, for "Track the repair"

  // Ball → colour class. A whitelist, so a class attribute can never carry a
  // server string.
  var BALLS = { shop: true, customer: true, third_party: true, nobody: true };
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var RETURN_WORDS = {
    collect: 'Collect from the shop',
    courier: 'Couriered back to you',
    with_device: 'Fitted back in your device'
  };
  var VENDOR_RESULT_WORDS = {
    replaced: 'The manufacturer replaced the part.',
    repaired: 'The manufacturer repaired the part.',
    credit_note: 'The manufacturer settled the claim by credit.',
    rejected: 'The manufacturer declined the warranty claim.'
  };
  // A visit booked for these stages is still ahead of us.
  var VISIT_WAITING = { scheduled: true, en_route: true, session_booked: true };
  // Stages after which a promised date can no longer be "late": the shop's
  // part is done (ready / closed) or it is waiting on the customer's sign-off.
  var PROMISE_DONE = { ready: true, closed: true, work_done: true, resolved: true };

  function S() { return window.NeoQcService || null; }
  function el(id) { return document.getElementById(id); }

  function setText(node, text) { if (node) node.textContent = text == null ? '' : String(text); }
  function showEl(node, on) { if (node) node.classList.toggle('hidden', !on); }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' +
             d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  // "3 days" reads better than "3.2d" to someone who is worried about their PC.
  function humanDuration(days) {
    if (days < 0.08) return 'just now';
    if (days < 1) {
      var h = Math.max(1, Math.round(days * 24));
      return h + (h === 1 ? ' hour' : ' hours');
    }
    var d = Math.round(days);
    return d + (d === 1 ? ' day' : ' days');
  }

  // ── visit wording: "Thu 23 Oct, 2:00–4:00 pm" ─────────────────────────────
  // Built by hand rather than with toLocaleTimeString so the wording does not
  // change with the phone's browser (some render "2:00 PM", some "14:00").
  //
  // Always in SHOP time (India, UTC+5:30, no daylight saving): the visit
  // happens in India, and the timeline's "Visit booked for …" line is written
  // by the server in Asia/Kolkata. A relative in Dubai must read the same
  // 2:30 pm in both places, so the browser's own zone is never used, and
  // "(India time)" is added when the browser is somewhere else.
  var IST_MS = 330 * 60000;
  // A Date whose UTC fields ARE the India wall-clock fields of `ms`.
  function istParts(ms) { return new Date(ms + IST_MS); }
  function sameDay(a, b) {
    return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  }
  function clock(d) {
    var h = d.getUTCHours(), m = d.getUTCMinutes();
    return { t: (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m, ap: h < 12 ? 'am' : 'pm' };
  }
  function dayWord(d) {
    var base = DAY_NAMES[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()];
    var now = istParts(Date.now());
    var tomorrow = istParts(Date.now() + 86400000);
    if (sameDay(d, now)) return base + ' (today)';
    if (sameDay(d, tomorrow)) return base + ' (tomorrow)';
    return base;
  }
  // The browser is not on India time at that moment (getTimezoneOffset is
  // minutes BEHIND UTC, so India is -330).
  function awayFromIndia(ms) {
    try { return new Date(ms).getTimezoneOffset() !== -330; } catch (e) { return false; }
  }
  function fmtVisitRange(startIso, endIso) {
    var sMs = new Date(startIso).getTime();
    if (isNaN(sMs)) return '';
    var eMs = endIso ? new Date(endIso).getTime() : NaN;
    if (isNaN(eMs) || eMs <= sMs) eMs = NaN;
    var zone = awayFromIndia(sMs) ? ' (India time)' : '';
    var s = istParts(sMs);
    var a = clock(s);
    if (isNaN(eMs)) return dayWord(s) + ', ' + a.t + ' ' + a.ap + zone;
    var e = istParts(eMs);
    var b = clock(e);
    if (sameDay(s, e)) {
      return dayWord(s) + ', ' + (a.ap === b.ap ? a.t + '–' + b.t + ' ' + b.ap : a.t + ' ' + a.ap + '–' + b.t + ' ' + b.ap) + zone;
    }
    return dayWord(s) + ', ' + a.t + ' ' + a.ap + ' – ' + dayWord(e) + ', ' + b.t + ' ' + b.ap + zone;
  }

  // The visit / remote-session line for an on-site or remote ticket, or null.
  function visitLine(job) {
    var type = job.service_type;
    if (type !== 'on_site' && type !== 'remote') return null;
    var noun = type === 'remote' ? 'remote session' : 'visit';
    var start = job.visit_start ? new Date(job.visit_start).getTime() : NaN;
    var now = Date.now();
    if (isFinite(start)) {
      var when = fmtVisitRange(job.visit_start, job.visit_end);
      if (VISIT_WAITING[job.stage]) {
        // Thirty minutes past the booked start and we still have not arrived:
        // say so, the same way a missed promise date is owned below.
        if (now > start + 30 * 60000) {
          return { text: 'Your ' + noun + ' was booked for ' + when + ' and we are running late. We will call you.', late: true };
        }
        return { text: (type === 'remote' ? 'Remote session booked: ' : 'Visit booked: ') + when };
      }
      // A follow-up booked ahead of time while the ticket sits at another stage.
      if (start > now && job.stage !== 'closed') {
        return { text: (type === 'remote' ? 'Remote session booked: ' : 'Visit booked: ') + when };
      }
    }
    if (job.stage === 'logged') return { text: "We'll call you to book a time for the " + noun + '.', muted: true };
    if (job.stage === 'revisit_needed') return { text: "We'll call you to book the follow-up visit.", muted: true };
    return null;
  }

  function showPanel(which) {
    ['svc-form-wrap', 'svc-result', 'svc-error'].forEach(function (id) {
      var n = el(id); if (n) n.classList.add('hidden');
    });
    var keep = el(which); if (keep) keep.classList.remove('hidden');
    // The form stays visible alongside a result so a customer can look up a
    // second job without hunting for a back button.
    if (which === 'svc-result') { var f = el('svc-form-wrap'); if (f) f.classList.remove('hidden'); }
  }

  function setSentence(text, ball) {
    var sEl = el('svc-sentence');
    if (!sEl) return;
    sEl.className = 'svc-sentence svc-ball-' + (BALLS[ball] ? ball : 'shop');
    setText(sEl, text);                          // textContent: may name a vendor
  }

  function setSince(rec, M) {
    if (rec.stage === 'closed') {
      setText(el('svc-since'), rec.stage_since ? 'on ' + fmtDate(rec.stage_since) : '');
      return;
    }
    setText(el('svc-since'), 'for ' + humanDuration(M.daysInStage(rec, Date.now())));
  }

  function setPromise(text, mode) {
    var pr = el('svc-promise');
    if (!pr) return;
    pr.classList.remove('svc-late', 'svc-muted');
    if (mode === 'late') pr.classList.add('svc-late');
    else if (mode === 'muted') pr.classList.add('svc-muted');
    setText(pr, text || '');
  }

  function setHandler(name, closed) {
    var hb = el('svc-handler');
    if (!hb) return;
    if (name && !closed) {
      hb.classList.remove('hidden');
      setText(hb, name + ' is looking after this');
    } else { hb.classList.add('hidden'); }
  }

  // Timeline. Deliberately NOT a stepper: a service job loops — diagnose,
  // quote, bench, wait for a part, bench again — and a stepper that jumps
  // backwards reads as a mistake and destroys trust. An RMA loops too (test,
  // documents, test again).
  function renderTimeline(events, fallbackFor) {
    var tl = el('svc-timeline');
    if (!tl) return;
    tl.innerHTML = '';
    var list = Array.isArray(events) ? events : [];
    if (!list.length) {
      var none = document.createElement('div');
      none.className = 'svc-tl-empty';
      none.textContent = 'Nothing to report yet. This page updates as soon as anything changes.';
      tl.appendChild(none);
      return;
    }
    list.forEach(function (ev) {
      if (!ev) return;
      var row = document.createElement('div');
      row.className = 'svc-tl-item';

      var when = document.createElement('div');
      when.className = 'svc-tl-when';
      when.textContent = fmtDateTime(ev.at);
      row.appendChild(when);

      var body = document.createElement('div');
      body.className = 'svc-tl-body';
      // Prefer what a human wrote; fall back to the customer wording for the
      // stage, never the raw internal key.
      var text = ev.body;
      if (!text && ev.to_stage) text = fallbackFor(ev.to_stage) || '';
      body.textContent = text || '';             // textContent: staff free text
      row.appendChild(body);

      tl.appendChild(row);
    });
  }

  // The meta strip is shared by both kinds; each render sets every label it
  // uses, so a part never shows "In the name of" left over from a repair.
  function setMeta(m) {
    setText(el('svc-device-label'), m.deviceLabel);
    setText(el('svc-device'), m.device);
    showEl(el('svc-type-item'), !!m.type);
    setText(el('svc-type'), m.type || '');
    showEl(el('svc-name-item'), !!m.nameValue);
    setText(el('svc-name-label'), m.nameLabel || '');
    setText(el('svc-name'), m.nameValue || '');
    linkedCode = m.linked || null;
    showEl(el('svc-linked-item'), !!linkedCode);
    setText(el('svc-linked'), linkedCode || '');
    setText(el('svc-code'), m.code || '');
  }

  function safeCall(fn, fallback) {
    try { var v = fn(); return (v == null || v === '') ? fallback : v; } catch (e) { return fallback; }
  }
  function rmaSentence(M, unit) {
    if (typeof M.rmaWaitingSentence === 'function') {
      var s = safeCall(function () { return M.rmaWaitingSentence(unit); }, null);
      if (s) return s;
    }
    if (typeof M.rmaCustomerLabel === 'function') {
      var l = safeCall(function () { return M.rmaCustomerLabel(unit); }, null);
      if (l) return l;
    }
    if (unit.stage === 'closed' && M.RMA_DISPOSITIONS && unit.disposition && M.RMA_DISPOSITIONS[unit.disposition]) {
      var d = M.RMA_DISPOSITIONS[unit.disposition];
      return typeof d === 'string' ? d : (d.customer || d.label || 'Closed');
    }
    return unit.stage === 'closed' ? 'Closed' : 'In progress';
  }
  function rmaBall(M, unit) {
    if (typeof M.rmaBallOf === 'function') return safeCall(function () { return M.rmaBallOf(unit); }, 'shop');
    return unit.stage === 'closed' ? 'nobody' : 'shop';
  }
  function rmaStageText(M, stage, unit) {
    if (typeof M.rmaCustomerLabel === 'function') {
      return safeCall(function () {
        return M.rmaCustomerLabel({ stage: stage, return_method: unit.return_method, disposition: unit.disposition });
      }, '');
    }
    var d = M.RMA_STAGES && M.RMA_STAGES[stage];
    return d ? (d.customer || d.staff || '') : '';
  }
  function partLabel(M, u) {
    if (u.label) return u.label;
    if (typeof M.itemLabel === 'function') {
      var l = safeCall(function () { return M.itemLabel(u.kind, u.brand, u.model); }, '');
      if (l) return l;
    }
    return 'Your part';
  }
  function typeWords(t) {
    if (t === 'on_site') return 'On-site visit';
    if (t === 'remote') return 'Remote support';
    if (t === 'in_store') return 'In-store repair';
    return '';
  }

  // ── the headline of a ticket that has parts under claim ───────────────────
  // The job's own stage cannot say everything once parts are involved:
  //  - A ticket waiting on its parts (a mirror stage) reads from its most
  //    urgent part, exactly as the shop's board does (SPEC-AMENDMENTS A23,
  //    NeoQcService.ticketWithUnits): a rejected part waiting for the
  //    customer's decision is THEIR turn, not "With us".
  //  - A closed ticket with a part that now needs the customer (ready to
  //    collect, a decision) says so: that is the next thing they must do.
  //  - "Returned to you — your part is still under warranty claim" stops being
  //    true once every part has come back; the parts' own endings say what
  //    happened instead.
  // → {text, ball, since} where since is the record whose clock applies.
  var BALL_URGENCY = { customer: 0, shop: 1, third_party: 2, nobody: 3 };
  function mostUrgentUnit(M, units) {
    var best = null, bestKey = null, now = Date.now();
    units.forEach(function (u) {
      var b = rmaBall(M, u);
      var key = [has(BALL_URGENCY, b) ? BALL_URGENCY[b] : 9,
                 -(M.daysInStage ? safeCall(function () { return M.daysInStage(u, now); }, 0) : 0)];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = u; bestKey = key; }
    });
    return best;
  }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function unitHeadline(M, u) { return partLabel(M, u) + ': ' + rmaSentence(M, u); }
  function ticketHeadline(M, job) {
    var base = { text: M.waitingSentence(job), ball: M.ballOf(job.stage), since: job };
    var units = (Array.isArray(job.rma_units) ? job.rma_units : []).filter(function (u) { return u && u.stage; });
    if (!units.length) return base;

    if (job.stage !== 'closed') {
      if (typeof M.ticketWithUnits !== 'function') return base;
      // The public payload has no ids: every part listed here belongs to this
      // ticket, so each gets the ticket's local id. get_service_public sends
      // holds_ticket per part (A23), and only the parts that hold the ticket
      // drive its headline; a released part goes on under its own RM- code.
      // An older server that leaves the flag out is read as "holding", the
      // behaviour before the flag existed.
      var key = '__this_ticket';
      var view = safeCall(function () {
        return M.ticketWithUnits(Object.assign({}, job, { id: key }), units.map(function (u) {
          return Object.assign({}, u, { service_job_id: key, holds_ticket: u.holds_ticket == null ? true : !!u.holds_ticket });
        }), null, Date.now());
      }, null);
      if (!view || !view.unit || !BALLS[view.ball]) return base;
      return { text: unitHeadline(M, view.unit), ball: view.ball, since: view.unit };
    }

    var open = units.filter(function (u) { return u.stage !== 'closed'; });
    if (open.length) {
      var best = mostUrgentUnit(M, open);
      var ball = rmaBall(M, best);
      if (ball === 'customer') return { text: unitHeadline(M, best), ball: 'customer', since: best };
      // Still true ("…still under warranty claim"), coloured by whose turn it is.
      if (job.outcome === 'returned_rma_pending' && BALLS[ball]) return { text: base.text, ball: ball, since: base.since };
      return base;
    }
    if (job.outcome !== 'returned_rma_pending') return base;
    if (units.length === 1) {
      return { text: 'Returned to you — the warranty claim is finished. ' + unitHeadline(M, units[0]), ball: 'nobody', since: units[0] };
    }
    // "on <date>": when the last of them finished.
    var last = units.reduce(function (a, u) {
      return (Date.parse(u.stage_since || '') || 0) > (Date.parse(a.stage_since || '') || 0) ? u : a;
    }, units[0]);
    return { text: 'Returned to you — the warranty claims for your ' + units.length +
                   ' parts are finished. Each part below shows how it ended.', ball: 'nobody', since: last };
  }

  // ── a service ticket (NT-) ────────────────────────────────────────────────
  function renderStatus(job) {
    var M = S();
    if (!M) return;

    var head = ticketHeadline(M, job);
    setSentence(head.text, head.ball);
    setSince(head.since, M);

    var vl = visitLine(job);
    var vEl = el('svc-visit');
    if (vEl) {
      vEl.classList.remove('svc-late', 'svc-muted');
      if (vl) {
        if (vl.late) vEl.classList.add('svc-late');
        if (vl.muted) vEl.classList.add('svc-muted');
        setText(vEl, vl.text);
      } else { setText(vEl, ''); }
      showEl(vEl, !!vl);
    }

    var type = job.service_type || null;
    var visitType = type === 'on_site' || type === 'remote';
    setMeta({
      deviceLabel: 'Item',
      device: job.device_label ||
        (type === 'on_site' ? 'On-site visit' : type === 'remote' ? 'Remote support' : '') ||
        (M.JOB_KINDS && M.JOB_KINDS[job.job_kind]) || 'Your item',
      type: typeWords(type),
      nameLabel: 'In the name of',
      nameValue: job.customer_name || '',
      linked: null,
      code: job.public_code || ''
    });

    // A date is only promised after diagnosis, so the absence of one is normal
    // early on and must read as a deliberate "not yet", never as missing data.
    var promisedMs = job.promised_at ? new Date(job.promised_at).getTime() : null;
    var late = promisedMs != null && isFinite(promisedMs) && promisedMs < Date.now() && !PROMISE_DONE[job.stage];
    if (late) {
      // Never tell someone we "expect" their machine on a date that has
      // already passed — they can read a calendar, and pretending otherwise
      // is how a customer stops believing the whole page. Own it instead.
      setPromise('We said ' + fmtDate(job.promised_at) + ' and we are running late. ' +
                 (M.ballOf(job.stage) === 'third_party'
                   ? 'It is still with ' + (job.waiting_party || 'the supplier') + '.'
                   : 'It is still with us.'), 'late');
    } else if (job.promised_at && !PROMISE_DONE[job.stage]) {
      setPromise('We expect it ready by ' + fmtDate(job.promised_at), '');
    } else if (job.stage === 'closed' || PROMISE_DONE[job.stage]) {
      setPromise('', 'muted');
    } else if (visitType) {
      // A visit or a remote session has no "ready by" date; the visit line
      // above carries the time that matters.
      setPromise('', 'muted');
    } else {
      setPromise("We'll give you a date once we've finished diagnosing it.", 'muted');
    }

    setHandler(job.handled_by, job.stage === 'closed');
    renderParts(Array.isArray(job.rma_units) ? job.rma_units : []);
    renderTimeline(job.events, function (stage) {
      var d = M.STAGES && M.STAGES[stage];
      return d ? (d.customer || d.staff) : '';
    });

    showPanel('svc-result');
  }

  // "Parts under warranty claim": the RM- units linked to this ticket. Each can
  // be opened on its own with the same phone digits (it was sent in the same
  // customer's name).
  function renderParts(units) {
    var card = el('svc-parts'), host = el('svc-parts-list');
    if (!card || !host) return;
    host.innerHTML = '';
    var M = S() || {};
    var list = units.filter(function (u) { return u && (u.public_code || u.label); });
    showEl(card, list.length > 0);
    list.forEach(function (u) {
      var ball = rmaBall(M, u);
      var row = document.createElement('div');
      row.className = 'svc-part svc-pball-' + (BALLS[ball] ? ball : 'shop');

      var top = document.createElement('div');
      top.className = 'svc-part-top';
      var name = document.createElement('span');
      name.className = 'svc-part-name';
      name.textContent = partLabel(M, u);
      top.appendChild(name);
      if (u.public_code) {
        var code = document.createElement('span');
        code.className = 'svc-part-code mono';
        code.textContent = u.public_code;
        top.appendChild(code);
      }
      row.appendChild(top);

      var st = document.createElement('div');
      st.className = 'svc-part-status';
      var since = (u.stage !== 'closed' && u.stage_since && M.daysInStage)
        ? ' · for ' + humanDuration(M.daysInStage(u, Date.now())) : '';
      st.textContent = rmaSentence(M, u) + since;
      row.appendChild(st);

      if (u.public_code) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'svc-mini-btn';
        btn.textContent = 'Track this part';
        btn.addEventListener('click', function () { trackCode(u.public_code); });
        row.appendChild(btn);
      }
      host.appendChild(row);
    });
  }

  // ── one RMA part (RM-) ────────────────────────────────────────────────────
  function renderRma(unit) {
    var M = S();
    if (!M) return;

    setSentence(rmaSentence(M, unit), rmaBall(M, unit));
    setSince(unit, M);
    var vEl = el('svc-visit');
    if (vEl) { setText(vEl, ''); showEl(vEl, false); }

    setMeta({
      deviceLabel: 'Part',
      device: partLabel(M, unit),
      type: '',
      nameLabel: 'Goes back',
      nameValue: RETURN_WORDS[unit.return_method] || '',
      linked: unit.linked_job_code || null,
      code: unit.public_code || ''
    });

    var closed = unit.stage === 'closed';
    if (unit.stage === 'logged') {
      setPromise("We'll update this page as soon as the part reaches us.", 'muted');
    } else if (unit.stage === 'with_vendor' && unit.expected_back_at) {
      var due = new Date(unit.expected_back_at).getTime();
      if (isFinite(due) && due < Date.now()) {
        // Same honesty rule as a missed promise date on a repair.
        setPromise('We expected an answer from ' + (unit.waiting_party || 'the manufacturer') + ' by ' +
                   fmtDate(unit.expected_back_at) + '. It is taking longer, and we are chasing it.', 'late');
      } else {
        setPromise((unit.waiting_party || 'The manufacturer') + ' usually answers by ' + fmtDate(unit.expected_back_at) + '.', '');
      }
    } else if (!closed && VENDOR_RESULT_WORDS[unit.vendor_result]) {
      setPromise(VENDOR_RESULT_WORDS[unit.vendor_result], '');
    } else if (unit.stage === 'ready_to_return' && unit.return_method === 'collect') {
      setPromise('Quote your reference when you come to collect it.', '');
    } else {
      setPromise('', 'muted');
    }

    setHandler(unit.handled_by, closed);
    renderParts([]);
    renderTimeline(unit.events, function (stage) { return rmaStageText(M, stage, unit); });

    showPanel('svc-result');
  }

  function showError(msg) {
    var e = el('svc-error');
    if (e) setText(e, msg);
    showPanel('svc-error');
    var f = el('svc-form-wrap'); if (f) f.classList.remove('hidden');
  }

  // Codes are printed "NT-7KQ2ABCD"; people type "nt7kq2abcd" or add a space.
  function normCode(raw) {
    var s = String(raw || '').toUpperCase().replace(/\s+/g, '');
    var m = s.match(/^(NT|RM)-?([0-9A-Z]{8})$/);
    return m ? m[1] + '-' + m[2] : s;
  }
  function kindOf(code) { return /^RM-/.test(code) ? 'rma' : 'service'; }

  function dbClient() {
    return (typeof db !== 'undefined' && db) || window.db || null;
  }

  function setUpdated() {
    var u = el('svc-updated');
    if (!u) return;
    try {
      u.textContent = ' (last checked ' + new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) + ')';
    } catch (e) { u.textContent = ''; }
  }

  async function lookup(opts) {
    var quiet = !!(opts && opts.quiet);
    var args;
    if (quiet) {
      // The refresh tick re-asks for what is ON SCREEN, never for whatever is
      // half-typed in the boxes right now.
      if (!lastArgs || userBusy) return;
      args = lastArgs;
    } else {
      if (userBusy) return;
      var codeEl = el('svc-code-input'), phoneEl = el('svc-phone-input');
      var code = normCode(codeEl && codeEl.value);
      var phone4 = ((phoneEl && phoneEl.value) || '').trim();
      if (!code) return showError('Enter the tracking code from your receipt or our message.');
      if (!/^\d{4}$/.test(phone4)) return showError('Enter the last 4 digits of the phone number you gave us.');
      if (codeEl && codeEl.value !== code) codeEl.value = code;
      args = { code: code, phone4: phone4, kind: kindOf(code) };
    }

    var client = dbClient();
    if (!client) { if (!quiet) showError('Could not reach us just now. Try again in a moment.'); return; }

    var btn = el('svc-lookup-btn');
    if (!quiet) {
      userBusy = true;
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    }

    try {
      var res = args.kind === 'rma'
        ? await client.rpc('get_rma_public', { code: args.code, phone4: args.phone4 })
        : await client.rpc('get_service_public', { code: args.code, phone4: args.phone4 });
      if (res.error) throw res.error;
      // A tick that resolves after the customer asked for something else
      // must not paint the old record back over the new one.
      if (quiet && (userBusy || lastArgs !== args)) return;
      var rec = res.data;
      if (!rec) {
        stopPolling();
        lastArgs = null;
        // One message for both wrong-code and wrong-phone, so the page cannot
        // be used to confirm that a code exists.
        return showError('We could not find anything with that code and phone number. Check both and try again.');
      }
      lastArgs = args;
      if (args.kind === 'rma') renderRma(rec); else renderStatus(rec);
      setUpdated();
      startPolling();
    } catch (e) {
      if (!quiet) showError('Something went wrong looking that up. Try again in a moment.');
    } finally {
      if (!quiet) {
        userBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Check status'; }
      }
    }
  }

  // "Track this part" / "Track the repair": same phone digits, another code.
  function trackCode(code) {
    var ci = el('svc-code-input');
    if (!ci || !code) return;
    ci.value = normCode(code);
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    lookup();
  }

  // Poll, do not subscribe — see the note at the top of this file. Also keeps
  // the elapsed-time line honest, which an event-driven page would not: it
  // would sit at "3 days" all afternoon.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!lastArgs) return stopPolling();
      if (document.hidden) return;                 // no point polling a hidden tab
      var r = el('svc-result');
      if (!r || r.classList.contains('hidden')) return stopPolling();
      lookup({ quiet: true });
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function initServiceStatus() {
    var form = el('svc-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', function (e) { e.preventDefault(); lookup(); });
    }
    var btn = el('svc-lookup-btn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function (e) { e.preventDefault(); lookup(); });
    }
    var lb = el('svc-linked-btn');
    if (lb && !lb.dataset.bound) {
      lb.dataset.bound = '1';
      lb.addEventListener('click', function () { if (linkedCode) trackCode(linkedCode); });
    }
    // Uppercase as they type: the codes are printed uppercase, and the lookup is
    // case-insensitive anyway, so this is purely so it looks like the receipt.
    var ci = el('svc-code-input');
    if (ci && !ci.dataset.bound) {
      ci.dataset.bound = '1';
      ci.addEventListener('input', function () {
        var p = ci.selectionStart;
        ci.value = ci.value.toUpperCase();
        try { ci.setSelectionRange(p, p); } catch (err) {}
      });
    }
    // A deep link from a message: ?view=service&code=NT-XXXXXXXX (or RM-…).
    try {
      var q = new URLSearchParams(location.search);
      var c = q.get('code');
      if (c && ci && !ci.value) ci.value = normCode(c).slice(0, 11);
    } catch (e) {}
  }

  window.NeoQcServiceStatus = {
    init: initServiceStatus,
    lookup: lookup,
    stopPolling: stopPolling,
    // exposed for the harness
    _render: renderStatus,
    _renderRma: renderRma,
    _human: humanDuration,
    _normCode: normCode,
    _visitLine: visitLine,
    _fmtVisitRange: fmtVisitRange
  };
})();
