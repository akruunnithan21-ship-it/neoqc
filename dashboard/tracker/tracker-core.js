/*
  Neo Tokyo customer tracker — the logic with no DOM in it.

  Loaded by dashboard/index.html as a plain browser global (window.NeoTracker)
  and by tests/tracker-core.test.js through module.exports. No build step.

  Wording for repairs and warranty parts comes from shared/service-status.js
  (window.NeoQcService), the same module the shop's desktop app uses, so what
  the customer reads can never drift from what the shop sees. This file only
  decides WHICH of those sentences goes where on the page.

  Three kinds of code:
    build     6 characters, the last 6 of the ticket id (base 36, so 0-9 A-Z)
    repair    NT-XXXXXXXX
    warranty  RM-XXXXXXXX
  NT-/RM- codes use the alphabet in sql/service-v2.sql new_public_code(): the
  glyphs people misread (0 O 1 I 5 S 8 B) never appear in them.
*/
(function (global) {
  'use strict';

  var SERVICE_ALPHABET = '234679ACDEFGHJKLMNPQRTUVWXYZ';
  var RX = {
    build: /^[0-9A-Z]{6}$/,
    repair: new RegExp('^NT-[' + SERVICE_ALPHABET + ']{8}$'),
    warranty: new RegExp('^RM-[' + SERVICE_ALPHABET + ']{8}$')
  };

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return v == null ? '' : String(v); }

  // ── Codes ─────────────────────────────────────────────────────────────────

  // As the customer types: uppercase, no spaces, and the dash after NT/RM once
  // it is clearly a service code (a build code can begin with NT or RM too, so
  // the dash waits until a 7th character or a typed dash settles it).
  function formatCode(raw) {
    var up = str(raw).toUpperCase();
    var typedDash = /^\s*(NT|RM)\s*-/.test(up);
    var s = up.replace(/[^A-Z0-9]/g, '');
    if (/^(NT|RM)/.test(s) && (typedDash || s.length > 6)) return s.slice(0, 2) + '-' + s.slice(2, 10);
    return s.slice(0, /^(NT|RM)/.test(s) ? 10 : 6);
  }

  function kindOf(code) {
    var c = str(code);
    if (RX.build.test(c)) return 'build';
    if (RX.repair.test(c)) return 'repair';
    if (RX.warranty.test(c)) return 'warranty';
    return null;
  }

  // What the code looks like so far, for the hint beside the box.
  function guessOf(code) {
    var c = str(code);
    if (!c) return null;
    if (/^NT-/.test(c)) return 'repair';
    if (/^RM-/.test(c)) return 'warranty';
    if (/^(N|NT|R|RM)$/.test(c)) return /^N/.test(c) ? 'repair' : 'warranty';
    return /^[0-9A-Z]+$/.test(c) ? 'build' : null;
  }

  // A plain-words problem with a finished-looking code, or null.
  function codeProblem(code) {
    var c = str(code);
    var m = c.match(/^(NT|RM)-(.*)$/);
    if (m) {
      var bad = m[2].replace(new RegExp('[' + SERVICE_ALPHABET + ']', 'g'), '');
      if (bad) {
        var shown = bad.split('').filter(function (ch, i, a) { return a.indexOf(ch) === i; }).join(', ');
        return 'Our ' + m[1] + '- codes never use ' + shown + '. Check the code against your message: it may be a look-alike letter or number.';
      }
      if (m[2].length < 8) return m[1] + '- codes have 8 characters after the dash.';
      return null;
    }
    if (c && c.length < 6) return 'Build codes have 6 characters.';
    return null;
  }

  // Pull a code out of a pasted WhatsApp/SMS message or a tracking link.
  function extractCode(text) {
    var T = str(text).toUpperCase();
    var link = T.match(/\/T\/([A-Z0-9-]{6,11})\b/);
    if (link) { var f = formatCode(link[1]); if (kindOf(f)) return f; }
    var m = T.match(new RegExp('\\b(NT|RM)\\s*-?\\s*([' + SERVICE_ALPHABET + ']{8})\\b'));
    if (m) return m[1] + '-' + m[2];
    // A build code: 6 letters/digits with at least one of each, so words
    // ("STATUS") and numbers (a pincode, an amount) are not mistaken for one.
    var toks = T.match(/\b[0-9A-Z]{6}\b/g) || [];
    for (var i = 0; i < toks.length; i++) {
      if (/\d/.test(toks[i]) && /[A-Z]/.test(toks[i])) return toks[i];
    }
    return null;
  }

  // The last 4 digits of whatever was pasted ("+91 98470 51234" → "1234").
  function extractPhone4(text) {
    var d = str(text).replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : null;
  }

  // ── Time, always in shop time (India, UTC+5:30, no daylight saving) ──────
  // Built by hand rather than with toLocaleString so the wording does not
  // change with the phone's browser ("2:00 PM" vs "14:00").
  var IST_MS = 330 * 60000;
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function ms(v) {
    if (v == null || v === '') return NaN;
    var n = typeof v === 'number' ? v : Date.parse(v);
    return isFinite(n) ? n : NaN;
  }
  function ist(t) { return new Date(t + IST_MS); }
  function dayKey(d) { return d.getUTCFullYear() * 10000 + d.getUTCMonth() * 100 + d.getUTCDate(); }
  function dayDiff(t, now) {
    var a = ist(t), b = ist(now);
    var da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
    var db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    return Math.round((da - db) / 86400000);
  }
  function fmtClock(v) {
    var t = ms(v); if (isNaN(t)) return '';
    var d = ist(t), h = d.getUTCHours(), m = d.getUTCMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm');
  }
  function fmtDay(v) {
    var t = ms(v); if (isNaN(t)) return '';
    var d = ist(t);
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  // "Today", "Yesterday", "Tomorrow" or "Mon 23 Nov".
  function fmtDayWord(v, now) {
    var t = ms(v); if (isNaN(t)) return '';
    var diff = dayDiff(t, now == null ? Date.now() : now);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return fmtDay(t);
  }
  function fmtWhen(v, now) {
    var t = ms(v); if (isNaN(t)) return '';
    return fmtDayWord(t, now) + ', ' + fmtClock(t);
  }
  // Mid-sentence: "since today, 10:05 am".
  function fmtSince(v, now) {
    var w = fmtWhen(v, now);
    return /^(Today|Yesterday|Tomorrow)/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w;
  }
  function humanDuration(days) {
    if (!(days >= 0)) return '';
    if (days < 0.08) return 'a moment';
    if (days < 1) { var h = Math.max(1, Math.round(days * 24)); return h + (h === 1 ? ' hour' : ' hours'); }
    var d = Math.round(days); return d + (d === 1 ? ' day' : ' days');
  }
  function awayFromIndia(t) {
    try { return new Date(t).getTimezoneOffset() !== -330; } catch (e) { return false; }
  }
  // "Thu 23 Oct, 2:00–4:00 pm" for a visit window.
  function fmtRange(startIso, endIso, now) {
    var s = ms(startIso); if (isNaN(s)) return '';
    var e = ms(endIso); if (isNaN(e) || e <= s) e = NaN;
    var zone = awayFromIndia(s) ? ' (India time)' : '';
    var a = fmtClock(s);
    if (isNaN(e)) return fmtDayWord(s, now) + ', ' + a + zone;
    var b = fmtClock(e);
    if (dayKey(ist(s)) === dayKey(ist(e))) {
      var ap = a.slice(-2), bp = b.slice(-2);
      return fmtDayWord(s, now) + ', ' + (ap === bp ? a.slice(0, -3) : a) + '–' + b + zone;
    }
    return fmtDayWord(s, now) + ', ' + a + ' – ' + fmtDayWord(e, now) + ', ' + b + zone;
  }

  // ── Who has it: the shop's "ball" model, in customer words ────────────────
  var HOLDERS = {
    shop: { label: "We're on it", tone: 'shop' },
    customer: { label: 'Needs you', tone: 'customer' },
    third_party: { label: 'With the manufacturer', tone: 'third' },
    nobody: { label: 'Done', tone: 'done' },
    ready: { label: 'Ready for you', tone: 'done' }
  };
  function holder(ball, waitingParty) {
    var h = has(HOLDERS, ball) ? HOLDERS[ball] : HOLDERS.shop;
    if (ball === 'third_party' && waitingParty) return { label: 'With ' + waitingParty, tone: h.tone };
    return { label: h.label, tone: h.tone };
  }

  // ── Builds ────────────────────────────────────────────────────────────────
  // A build moves one way (parts → assembly → QC → done), so it gets a step bar.
  var BUILD_STEPS = [
    { key: 'awaiting', label: 'Parts' },
    { key: 'building', label: 'Assembly' },
    { key: 'waiting_qc', label: 'Waiting for QC' },
    { key: 'qc_testing', label: 'Testing' },
    { key: 'completed', label: 'Ready' }
  ];
  var BUILD_SENTENCES = {
    awaiting: "We're getting your parts together",
    building: 'Your PC is being assembled',
    waiting_qc: 'Assembled, and next in line for testing',
    qc_testing: 'Your PC is being stress-tested',
    completed: 'Your PC is ready to collect'
  };
  var BUILD_NEXT = {
    awaiting: 'Assembly starts as soon as every part is in',
    building: 'Quality checks and a stress test',
    waiting_qc: 'A full stress test and quality checks',
    qc_testing: "Final look-over, then we'll message you to collect",
    completed: 'Collect it from the shop with this code or your receipt'
  };
  var STEP_WORDS = {
    created: { title: 'Order confirmed', note: 'We created your build ticket.' },
    parts_in: { title: 'All parts arrived', note: 'Every part is in and checked against your order.' },
    awaiting: { title: 'Waiting for parts', note: 'Some parts are still on their way to us.' },
    building: { title: 'Assembly started', note: 'Your PC is being put together.' },
    waiting_qc: { title: 'Assembly finished', note: 'Your PC is built and waiting for testing.' },
    qc_testing: { title: 'Testing started', note: 'Quality checks and the stress test are under way.' },
    completed: { title: 'Ready to collect', note: 'It passed our checks and is ready for you.' }
  };

  // The shop's PASS rule (dashboard/app.js qcVerdict), so a customer can never
  // be told "passed" while the staff badge says otherwise.
  function qcVerdict(qc) {
    if (!qc) return null;
    var hasData = qc.cpu_temp_max != null || qc.cinebench != null || qc.ram_stress != null || qc.gpu_temp_max != null;
    if (!hasData) return null;
    return (qc.cpu_temp_max == null || qc.cpu_temp_max <= 85) &&
           (qc.gpu_temp_max == null || qc.gpu_temp_max <= 80) &&
           (qc.ram_stress == null || qc.ram_stress === 'passed');
  }

  function buildView(rec, now) {
    now = now == null ? Date.now() : now;
    var status = has(BUILD_SENTENCES, rec.status) ? rec.status : 'awaiting';
    var idx = 0;
    for (var i = 0; i < BUILD_STEPS.length; i++) if (BUILD_STEPS[i].key === status) idx = i;
    var complete = status === 'completed';

    var steps = Array.isArray(rec.steps) ? rec.steps.filter(function (s) { return s && has(STEP_WORDS, s.step) && !isNaN(ms(s.at)); }) : [];
    var events = steps.map(function (s) { return { at: s.at, title: STEP_WORDS[s.step].title, note: STEP_WORDS[s.step].note }; });
    if (!steps.some(function (s) { return s.step === 'created'; }) && !isNaN(ms(rec.created_at))) {
      events.push({ at: rec.created_at, title: STEP_WORDS.created.title, note: STEP_WORDS.created.note });
    }
    if (complete && !steps.some(function (s) { return s.step === 'completed'; }) && !isNaN(ms(rec.completed_at))) {
      events.unshift({ at: rec.completed_at, title: STEP_WORDS.completed.title, note: STEP_WORDS.completed.note });
    }
    events.sort(function (a, b) { return ms(b.at) - ms(a.at); });

    var sinceAt = events.length ? events[0].at : rec.created_at;
    var sentence = BUILD_SENTENCES[status];
    if (status === 'awaiting' && rec.parts_waiting === false) sentence = 'Your parts are in. Assembly starts soon';

    var due;
    if (complete) {
      due = { label: 'Finished', value: rec.completed_at ? fmtWhen(rec.completed_at, now) : 'Done', state: null };
    } else if (!isNaN(ms(rec.deadline))) {
      var late = ms(rec.deadline) < now;
      due = {
        label: 'Ready by',
        value: fmtDay(rec.deadline) + ', ' + fmtClock(rec.deadline),
        state: late ? 'late' : 'ok',
        note: late ? "It's taking longer than we said. We'll call you with a new time." : null
      };
    } else {
      due = { label: 'Ready by', value: "We'll confirm the date", state: null };
    }

    var verdict = complete ? qcVerdict(rec.qc) : null;
    return {
      kind: 'build',
      code: str(rec.code).toUpperCase(),
      full: rec.full !== false,
      name: rec.first_name || null,
      title: rec.type === 'repair' ? 'repair' : 'PC build',
      sentence: sentence,
      holder: complete ? holder('ready') : holder('shop'),
      since: sinceAt,
      handler: rec.technician || null,
      due: due,
      next: BUILD_NEXT[status],
      track: { steps: BUILD_STEPS, index: idx, complete: complete },
      events: events,
      qc: rec.full === false ? null : (rec.qc || null),
      verdict: verdict,
      details: [
        ['Build type', rec.type === 'repair' ? 'Service repair' : 'New PC build'],
        rec.technician ? ['Technician', rec.technician] : null,
        !isNaN(ms(rec.created_at)) ? ['Order date', fmtDay(rec.created_at)] : null,
        complete && !isNaN(ms(rec.completed_at)) ? ['Finished', fmtDay(rec.completed_at)] : null
      ].filter(Boolean)
    };
  }

  // ── Repairs, visits, remote sessions (NT-) ────────────────────────────────
  var TYPE_WORDS = { on_site: 'On-site visit', remote: 'Remote support', in_store: 'In-store repair' };
  var VISIT_WAITING = { scheduled: true, en_route: true, session_booked: true };
  var PROMISE_DONE = { ready: true, closed: true, work_done: true, resolved: true };
  var RETURN_WORDS = { collect: 'Collect from the shop', courier: 'Couriered back to you', with_device: 'Fitted back in your device' };
  var VENDOR_RESULT_WORDS = {
    replaced: 'The manufacturer replaced the part.',
    repaired: 'The manufacturer repaired the part.',
    credit_note: 'The manufacturer settled the claim by credit.',
    rejected: 'The manufacturer declined the warranty claim.'
  };
  var BALL_URGENCY = { customer: 0, shop: 1, third_party: 2, nobody: 3 };

  function safe(fn, fallback) {
    try { var v = fn(); return (v == null || v === '') ? fallback : v; } catch (e) { return fallback; }
  }
  function capFirst(s) { s = str(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  function stageText(S, stage) {
    var d = S && S.STAGES && S.STAGES[stage];
    return d ? (d.customer || d.staff || '') : '';
  }
  function rmaSentence(S, unit) {
    var s = S && typeof S.rmaWaitingSentence === 'function' ? safe(function () { return S.rmaWaitingSentence(unit); }, null) : null;
    if (s) return s;
    var l = S && typeof S.rmaCustomerLabel === 'function' ? safe(function () { return S.rmaCustomerLabel(unit); }, null) : null;
    if (l) return l;
    return unit.stage === 'closed' ? 'Closed' : 'In progress';
  }
  function rmaLabel(S, unit) {
    return S && typeof S.rmaCustomerLabel === 'function' ? safe(function () { return S.rmaCustomerLabel(unit); }, '') : '';
  }
  function rmaBall(S, unit) {
    if (S && typeof S.rmaBallOf === 'function') return safe(function () { return S.rmaBallOf(unit); }, 'shop');
    return unit.stage === 'closed' ? 'nobody' : 'shop';
  }
  function rmaStageText(S, stage, unit) {
    return rmaLabel(S, { stage: stage, return_method: unit.return_method, disposition: unit.disposition });
  }
  function partLabel(S, u) {
    if (u.label) return u.label;
    var l = S && typeof S.itemLabel === 'function' ? safe(function () { return S.itemLabel(u.kind, u.brand, u.model); }, '') : '';
    return l || 'Your part';
  }
  function daysIn(S, rec, now) {
    return S && typeof S.daysInStage === 'function' ? safe(function () { return S.daysInStage(rec, now); }, 0) : 0;
  }
  function mostUrgentUnit(S, units, now) {
    var best = null, bk = null;
    units.forEach(function (u) {
      var b = rmaBall(S, u);
      var k = [has(BALL_URGENCY, b) ? BALL_URGENCY[b] : 9, -daysIn(S, u, now)];
      if (!bk || k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) { best = u; bk = k; }
    });
    return best;
  }

  // The headline of a ticket, following its parts where they hold it
  // (same rules as dashboard/service.js ticketHeadline, SPEC-AMENDMENTS A23).
  function ticketHeadline(S, job, now) {
    var closed = job.stage === 'closed';
    var base = {
      text: closed ? safe(function () { return S.waitingSentence(job); }, 'Closed') : (stageText(S, job.stage) || safe(function () { return S.waitingSentence(job); }, 'In progress')),
      ball: safe(function () { return S.ballOf(job.stage); }, 'shop'),
      since: job
    };
    var units = (Array.isArray(job.rma_units) ? job.rma_units : []).filter(function (u) { return u && u.stage; });
    if (!units.length) return base;
    if (!closed) {
      if (typeof S.ticketWithUnits !== 'function') return base;
      var key = '__this_ticket';
      var view = safe(function () {
        return S.ticketWithUnits(Object.assign({}, job, { id: key }), units.map(function (u) {
          return Object.assign({}, u, { service_job_id: key, holds_ticket: u.holds_ticket == null ? true : !!u.holds_ticket });
        }), null, now);
      }, null);
      if (!view || !view.unit || !has(BALL_URGENCY, view.ball)) return base;
      return { text: partLabel(S, view.unit) + ': ' + rmaSentence(S, view.unit), ball: view.ball, since: view.unit, waiting: view.unit.waiting_party };
    }
    var open = units.filter(function (u) { return u.stage !== 'closed'; });
    if (open.length) {
      var best = mostUrgentUnit(S, open, now), ball = rmaBall(S, best);
      if (ball === 'customer') return { text: partLabel(S, best) + ': ' + rmaSentence(S, best), ball: 'customer', since: best };
      if (job.outcome === 'returned_rma_pending') return { text: base.text, ball: ball, since: base.since };
      return base;
    }
    if (job.outcome !== 'returned_rma_pending') return base;
    if (units.length === 1) {
      return { text: 'Returned to you, and the warranty claim is finished. ' + partLabel(S, units[0]) + ': ' + rmaSentence(S, units[0]), ball: 'nobody', since: units[0] };
    }
    var last = units.reduce(function (a, u) { return (ms(u.stage_since) || 0) > (ms(a.stage_since) || 0) ? u : a; }, units[0]);
    return { text: 'Returned to you, and the warranty claims for your ' + units.length + ' parts are finished.', ball: 'nobody', since: last };
  }

  function visitLine(job, now) {
    var type = job.service_type;
    if (type !== 'on_site' && type !== 'remote') return null;
    var noun = type === 'remote' ? 'remote session' : 'visit';
    var start = ms(job.visit_start);
    if (!isNaN(start)) {
      var when = fmtRange(job.visit_start, job.visit_end, now);
      if (VISIT_WAITING[job.stage]) {
        if (now > start + 30 * 60000) return { label: type === 'remote' ? 'Session' : 'Visit', value: when, state: 'late', note: "We're running late. We'll call you." };
        return { label: type === 'remote' ? 'Session booked' : 'Visit booked', value: when, state: 'ok' };
      }
      if (start > now && job.stage !== 'closed') return { label: type === 'remote' ? 'Session booked' : 'Visit booked', value: when, state: 'ok' };
    }
    if (job.stage === 'logged') return { label: capFirst(noun), value: "We'll call you to book a time", state: null };
    if (job.stage === 'revisit_needed') return { label: 'Follow-up visit', value: "We'll call you to book it", state: null };
    return null;
  }

  function promiseLine(S, job, now) {
    var t = ms(job.promised_at);
    if (job.stage === 'closed') {
      return { label: 'Closed', value: job.closed_at ? fmtWhen(job.closed_at, now) : (job.stage_since ? fmtWhen(job.stage_since, now) : 'Done'), state: null };
    }
    if (PROMISE_DONE[job.stage]) {
      return { label: job.stage === 'ready' ? 'Ready since' : 'Done', value: job.ready_at ? fmtWhen(job.ready_at, now) : fmtWhen(job.stage_since, now), state: null };
    }
    if (!isNaN(t) && t < now) {
      var third = safe(function () { return S.ballOf(job.stage); }, 'shop') === 'third_party';
      return { label: 'We said', value: fmtDay(job.promised_at), state: 'late',
               note: "It's taking longer than we said. " + (third ? 'It is still with ' + (job.waiting_party || 'the supplier') + '.' : 'It is still with us.') };
    }
    if (!isNaN(t)) return { label: 'Ready by', value: fmtDay(job.promised_at), state: 'ok' };
    if (job.service_type === 'on_site' || job.service_type === 'remote') return null;
    if (job.stage === 'quoted') return { label: 'Ready by', value: "We'll give a date once you approve", state: null };
    return { label: 'Ready by', value: "We'll give a date after diagnosis", state: null };
  }

  function nextLine(S, job, ball) {
    if (job.stage === 'closed') return 'Nothing more to do. Thank you';
    if (ball === 'customer') {
      if (job.stage === 'ready') return 'Collect it from the shop with this code';
      if (job.stage === 'quoted') return 'Tell us if we should go ahead with the quote';
      if (job.stage === 'work_done' || job.stage === 'resolved') return "Use it for a day and tell us if anything's still wrong";
      return 'We need something from you: message or call us';
    }
    if (ball === 'third_party') return "We're chasing them and will update this page";
    if (job.stage === 'scheduled') return (job.handled_by ? job.handled_by + ' comes' : 'We come') + ' at the booked time, and calls before setting off';
    if (job.stage === 'session_booked') return 'We call you at the booked time to connect';
    if (job.stage === 'en_route') return 'Keep your phone handy: we may call for directions';
    return "We'll update this page as soon as anything changes";
  }

  function serviceView(job, S, now) {
    now = now == null ? Date.now() : now;
    var head = ticketHeadline(S, job, now);
    var type = job.service_type || null;
    var visit = visitLine(job, now);
    var due = visit || promiseLine(S, job, now);
    var device = job.device_label || (type === 'on_site' ? 'On-site visit' : type === 'remote' ? 'Remote support' : '') ||
      (S && S.JOB_KINDS && S.JOB_KINDS[job.job_kind]) || 'Your item';
    var sinceRec = head.since || job;
    var events = (Array.isArray(job.events) ? job.events : []).map(function (ev) {
      var text = ev && (ev.body || (ev.to_stage ? stageText(S, ev.to_stage) : ''));
      return text && !isNaN(ms(ev.at)) ? { at: ev.at, title: capFirst(text) } : null;
    }).filter(Boolean);
    var units = (Array.isArray(job.rma_units) ? job.rma_units : []).filter(function (u) { return u && (u.public_code || u.label); });
    return {
      kind: 'repair',
      code: str(job.public_code),
      full: true,
      name: job.customer_name ? str(job.customer_name).split(/\s+/)[0] : null,
      title: device,
      sentence: capFirst(head.text),
      holder: holder(head.ball, head.waiting || job.waiting_party),
      ball: head.ball,
      since: sinceRec.stage_since || job.stage_since || job.created_at,
      stalled: sinceRec.stage !== 'closed' ? humanDuration(daysIn(S, sinceRec, now)) : null,
      handler: job.stage !== 'closed' ? (job.handled_by || null) : null,
      due: due,
      next: nextLine(S, job, head.ball),
      track: null,
      events: events,
      parts: units.map(function (u) {
        var b = rmaBall(S, u);
        return { code: u.public_code || null, label: partLabel(S, u), sentence: rmaSentence(S, u), holder: holder(b, u.waiting_party), ball: b,
                 stalled: u.stage !== 'closed' && u.stage_since ? humanDuration(daysIn(S, u, now)) : null };
      }),
      details: [
        TYPE_WORDS[type] ? ['Service', TYPE_WORDS[type]] : null,
        ['Item', device],
        job.handled_by && job.stage !== 'closed' ? ['Technician', job.handled_by] : null,
        !isNaN(ms(job.received_at)) ? ['Received', fmtWhen(job.received_at, now)] : (!isNaN(ms(job.created_at)) ? ['Logged', fmtWhen(job.created_at, now)] : null)
      ].filter(Boolean)
    };
  }

  // ── One warranty part (RM-) ───────────────────────────────────────────────
  function rmaView(unit, S, now) {
    now = now == null ? Date.now() : now;
    var ball = rmaBall(S, unit);
    var closed = unit.stage === 'closed';
    var due = null;
    if (unit.stage === 'logged') {
      due = { label: 'Next', value: "We'll update this page when your part reaches us", state: null };
    } else if (unit.stage === 'with_vendor' && unit.expected_back_at) {
      var t = ms(unit.expected_back_at);
      if (!isNaN(t) && t < now) {
        due = { label: 'Expected back', value: fmtDay(unit.expected_back_at), state: 'late',
                note: 'It is taking longer than ' + (unit.waiting_party || 'the manufacturer') + ' said, and we are chasing it.' };
      } else if (!isNaN(t)) {
        due = { label: 'Expected back', value: 'Around ' + fmtDay(unit.expected_back_at), state: 'ok' };
      }
    } else if (!closed && VENDOR_RESULT_WORDS[unit.vendor_result]) {
      due = { label: 'Result', value: VENDOR_RESULT_WORDS[unit.vendor_result].replace(/\.$/, ''), state: unit.vendor_result === 'rejected' ? 'late' : 'ok' };
    } else if (closed) {
      due = { label: 'Closed', value: unit.stage_since ? fmtWhen(unit.stage_since, now) : 'Done', state: null };
    }
    var events = (Array.isArray(unit.events) ? unit.events : []).map(function (ev) {
      var text = ev && (ev.body || (ev.to_stage ? rmaStageText(S, ev.to_stage, unit) : ''));
      return text && !isNaN(ms(ev.at)) ? { at: ev.at, title: capFirst(text) } : null;
    }).filter(Boolean);
    var next;
    if (closed) next = 'Nothing more to do. Thank you';
    else if (unit.stage === 'ready_to_return' && unit.return_method === 'collect') next = 'Collect it from the shop. Quote this code at the counter';
    else if (ball === 'customer') next = 'We need something from you: message or call us';
    else if (ball === 'third_party') next = "We'll message you the day it's back";
    else next = "We'll update this page as soon as anything changes";
    return {
      kind: 'warranty',
      code: str(unit.public_code),
      full: true,
      name: null,
      title: partLabel(S, unit),
      sentence: capFirst(rmaLabel(S, unit) || rmaSentence(S, unit)),
      holder: holder(ball, unit.waiting_party),
      ball: ball,
      since: unit.stage_since || unit.created_at,
      stalled: !closed ? humanDuration(daysIn(S, unit, now)) : null,
      handler: !closed ? (unit.handled_by || null) : null,
      due: due,
      next: next,
      track: null,
      events: events,
      linked: unit.linked_job_code || null,
      parts: [],
      details: [
        ['Part', partLabel(S, unit)],
        unit.waiting_party ? ['With', unit.waiting_party] : null,
        RETURN_WORDS[unit.return_method] ? ['Coming back', RETURN_WORDS[unit.return_method]] : null,
        unit.handled_by && !closed ? ['Handled by', unit.handled_by] : null,
        !isNaN(ms(unit.received_at)) ? ['Received', fmtWhen(unit.received_at, now)] : null
      ].filter(Boolean)
    };
  }

  // A short line for the saved-ticket list.
  function shortStatus(view) {
    var s = str(view.sentence);
    return s.length > 48 ? s.slice(0, 46).replace(/\s+\S*$/, '') + '…' : s;
  }

  var api = {
    SERVICE_ALPHABET: SERVICE_ALPHABET,
    BUILD_STEPS: BUILD_STEPS,
    formatCode: formatCode,
    kindOf: kindOf,
    guessOf: guessOf,
    codeProblem: codeProblem,
    extractCode: extractCode,
    extractPhone4: extractPhone4,
    fmtClock: fmtClock,
    fmtDay: fmtDay,
    fmtDayWord: fmtDayWord,
    fmtWhen: fmtWhen,
    fmtSince: fmtSince,
    fmtRange: fmtRange,
    humanDuration: humanDuration,
    holder: holder,
    qcVerdict: qcVerdict,
    buildView: buildView,
    serviceView: serviceView,
    rmaView: rmaView,
    shortStatus: shortStatus
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NeoTracker = api;
})(typeof window !== 'undefined' ? window : this);
