/*
  Neo QC website — "Where is my PC?" service status page.

  TWO RULES THIS FILE EXISTS TO HONOUR, both learned the hard way:

  1. It POLLS get_service_public and never subscribes to postgres_changes.
     A realtime payload bypasses SECURITY DEFINER entirely and delivers the raw
     row to whoever subscribed — the phone number, the internal diagnosis, the
     staff email. The curated column list in that function is the privacy
     boundary, and a realtime subscription would walk straight around it.

  2. Customer- and staff-authored free text is written with textContent, never
     interpolated into markup. escHtml() in app.js escapes & < > and " but NOT
     the single quote, which is documented in that file and is exactly the gap
     that bites inside an attribute. Nothing here builds an attribute from data.

  The status wording itself comes from shared/service-status.js — the same module
  the Electron app uses — so what the customer reads can never drift from what
  the shop sees.
*/
(function () {
  'use strict';

  var POLL_MS = 30000;
  var pollTimer = null;
  var lastArgs = null;        // {code, phone4} for the refresh tick

  function S() { return window.NeoQcService || null; }
  function el(id) { return document.getElementById(id); }

  function setText(node, text) { if (node) node.textContent = text == null ? '' : String(text); }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' +
             new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
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

  function showPanel(which) {
    ['svc-form-wrap', 'svc-result', 'svc-error'].forEach(function (id) {
      var n = el(id); if (n) n.classList.add('hidden');
    });
    var keep = el(which); if (keep) keep.classList.remove('hidden');
    // The form stays visible alongside a result so a customer can look up a
    // second job without hunting for a back button.
    if (which === 'svc-result') { var f = el('svc-form-wrap'); if (f) f.classList.remove('hidden'); }
  }

  function renderStatus(job) {
    var M = S();
    if (!M) return;

    var ball = M.ballOf(job.stage);
    var sentence = M.waitingSentence(job);

    var sEl = el('svc-sentence');
    if (sEl) {
      sEl.className = 'svc-sentence svc-ball-' + ball;
      setText(sEl, sentence);                      // textContent: may name a vendor
    }

    var days = M.daysInStage(job, Date.now());
    setText(el('svc-since'), 'for ' + humanDuration(days));

    setText(el('svc-code'), job.public_code || '');
    setText(el('svc-device'), job.device_label || (M.JOB_KINDS[job.job_kind] || 'Your item'));
    setText(el('svc-name'), job.customer_name || '');

    // A date is only promised after diagnosis, so the absence of one is normal
    // early on and must read as a deliberate "not yet", never as missing data.
    var pr = el('svc-promise');
    if (pr) {
      pr.classList.remove('svc-late');
      var promisedMs = job.promised_at ? new Date(job.promised_at).getTime() : null;
      var late = promisedMs != null && promisedMs < Date.now() &&
                 job.stage !== 'ready' && job.stage !== 'closed';
      if (late) {
        // Never tell someone we "expect" their machine on a date that has
        // already passed — they can read a calendar, and pretending otherwise
        // is how a customer stops believing the whole page. Own it instead.
        pr.classList.remove('svc-muted');
        pr.classList.add('svc-late');
        setText(pr, 'We said ' + fmtDate(job.promised_at) + ' and we are running late. ' +
                    (M.ballOf(job.stage) === 'third_party'
                      ? 'It is still with ' + (job.waiting_party || 'the supplier') + '.'
                      : 'It is still with us.'));
      } else if (job.promised_at) {
        pr.classList.remove('svc-muted');
        setText(pr, 'We expect it ready by ' + fmtDate(job.promised_at));
      } else if (job.stage === 'closed') {
        pr.classList.add('svc-muted');
        setText(pr, '');
      } else {
        pr.classList.add('svc-muted');
        setText(pr, "We'll give you a date once we've finished diagnosing it.");
      }
    }

    var hb = el('svc-handler');
    if (hb) {
      if (job.handled_by && job.stage !== 'closed') {
        hb.classList.remove('hidden');
        setText(hb, job.handled_by + ' is looking after this');
      } else { hb.classList.add('hidden'); }
    }

    // Timeline. Deliberately NOT a stepper: a service job loops — diagnose,
    // quote, bench, wait for a part, bench again — and a stepper that jumps
    // backwards reads as a mistake and destroys trust.
    var tl = el('svc-timeline');
    if (tl) {
      tl.innerHTML = '';
      var events = Array.isArray(job.events) ? job.events : [];
      if (!events.length) {
        var none = document.createElement('div');
        none.className = 'svc-tl-empty';
        none.textContent = 'Nothing to report yet. This page updates as soon as anything changes.';
        tl.appendChild(none);
      } else {
        events.forEach(function (ev) {
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
          if (!text && ev.to_stage) {
            var d = M.STAGES[ev.to_stage];
            text = d ? (d.customer || d.staff) : '';
          }
          body.textContent = text || '';          // textContent: staff free text
          row.appendChild(body);

          tl.appendChild(row);
        });
      }
    }

    showPanel('svc-result');
  }

  function showError(msg) {
    var e = el('svc-error');
    if (e) setText(e, msg);
    showPanel('svc-error');
    var f = el('svc-form-wrap'); if (f) f.classList.remove('hidden');
  }

  async function lookup(opts) {
    var quiet = opts && opts.quiet;
    var codeEl = el('svc-code-input'), phoneEl = el('svc-phone-input');
    var code = ((codeEl && codeEl.value) || '').trim();
    var phone4 = ((phoneEl && phoneEl.value) || '').trim();

    if (!quiet) {
      if (!code) return showError('Enter the tracking code from your receipt.');
      if (!/^\d{4}$/.test(phone4)) return showError('Enter the last 4 digits of the phone number you gave us.');
    }
    if (!window.db && typeof db === 'undefined') return showError('Could not reach us just now. Please try again in a moment.');

    var client = (typeof db !== 'undefined' && db) || window.db;
    if (!client) return showError('Could not reach us just now. Please try again in a moment.');

    var btn = el('svc-lookup-btn');
    if (!quiet && btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      var res = await client.rpc('get_service_public', { code: code, phone4: phone4 });
      if (res.error) throw res.error;
      var job = res.data;
      if (!job) {
        stopPolling();
        // One message for both wrong-code and wrong-phone, so the page cannot
        // be used to confirm that a code exists.
        return showError('We could not find a job with that code and phone number. Please check both and try again.');
      }
      lastArgs = { code: code, phone4: phone4 };
      renderStatus(job);
      startPolling();
    } catch (e) {
      if (!quiet) showError('Something went wrong looking that up. Please try again in a moment.');
    } finally {
      if (!quiet && btn) { btn.disabled = false; btn.textContent = 'Check status'; }
    }
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
    // A deep link from an SMS: ?view=service&code=NT-XXXXXXXX
    try {
      var q = new URLSearchParams(location.search);
      var c = q.get('code');
      if (c && ci && !ci.value) ci.value = c.toUpperCase();
    } catch (e) {}
  }

  window.NeoQcServiceStatus = {
    init: initServiceStatus,
    lookup: lookup,
    stopPolling: stopPolling,
    // exposed for the harness
    _render: renderStatus,
    _human: humanDuration
  };
})();
