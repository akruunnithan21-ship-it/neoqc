/*
  Neo Tokyo customer tracker — the page.

  Rules this file keeps (the same ones dashboard/service.js learned):
  1. It POLLS the curated get_*_public functions and never subscribes to
     realtime: a realtime payload is the raw row, and would walk around the
     privacy boundary those functions are.
  2. Everything from the server is escaped before it touches markup, and no
     attribute or class is ever built from a server string (classes come from
     fixed lists).
  3. One message for a wrong code and a wrong phone, so the page cannot be used
     to confirm that a code exists.
*/
(function () {
  'use strict';

  // Old bookmarks of the staff side (?view=dashboard, ?view=new-service, …)
  // now live under /staff/.
  var params = new URLSearchParams(location.search);
  var STAFF_VIEWS = ['login', 'dashboard', 'profile', 'ticket-status', 'new-build', 'board', 'new-service', 'new-rma', 'my-requests', 'sales'];
  if (STAFF_VIEWS.indexOf(params.get('view')) !== -1) { location.replace('/staff/' + location.search + location.hash); return; }

  var CFG = window.NEO_TRACKER_CONFIG || {};
  var SHOP = CFG.shop || {};
  var T = window.NeoTracker;
  var S = window.NeoQcService || null;
  var DEMO_MODE = params.has('demo');
  var D = null;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var reduced = function () { return matchMedia('(prefers-reduced-motion: reduce)').matches; };
  var wait = function (t) { return new Promise(function (r) { setTimeout(r, t); }); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var cap = function (s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };

  // ── Icons (1.5 stroke, as in the configurator) ─────────────────────────
  var ICON = {
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    wrench: '<path d="M14.7 6.3a4.2 4.2 0 0 0-5.6 5.3l-5.5 5.5a1.9 1.9 0 0 0 2.7 2.7l5.5-5.5a4.2 4.2 0 0 0 5.3-5.6l-2.6 2.6-2.3-.5-.5-2.3z"/>',
    shield: '<path d="M12 3l7.5 3v5.6c0 4.4-3.1 8.2-7.5 9.4-4.4-1.2-7.5-5-7.5-9.4V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>',
    phone: '<path d="M6.6 3.5h2.8l1.4 4.2-2 1.3a12 12 0 0 0 6.2 6.2l1.3-2 4.2 1.4v2.8a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
    arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
    alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    receipt: '<path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    gpu: '<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="9" cy="11.5" r="3"/><path d="M15 10h3.5M15 13h3.5M5 17v3"/>',
    memory: '<rect x="3" y="7" width="18" height="9" rx="1.5"/><path d="M7 10.5v2M11 10.5v2M15 10.5v2M6 16v3M10 16v3M14 16v3M18 16v3"/>',
    disk: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h6"/><circle cx="17" cy="12" r="1"/>',
    bolt: '<path d="M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
    gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    bookmark: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6"/>',
    factory: '<path d="M3 21V10l6 4v-4l6 4V5h6v16zM7 17h2M12 17h2M17 17h2"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    wifiOff: '<path d="M2 8.5a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 15.5a6 6 0 0 1 7 0M12 19h.01M3 3l18 18"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
  };
  function ic(name, cls) { return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[name] || '') + '</svg>'; }

  var KIND = {
    build: { label: 'PC build', icon: 'cpu', detect: 'PC build', cls: 'k-build' },
    repair: { label: 'Repair', icon: 'wrench', detect: 'Repair or visit', cls: 'k-repair' },
    warranty: { label: 'Warranty claim', icon: 'shield', detect: 'Warranty part', cls: 'k-warranty' }
  };
  var TONES = { shop: 'tone-shop', customer: 'tone-customer', third: 'tone-third', done: 'tone-done' };
  function tone(t) { return TONES[t] || 'tone-shop'; }

  // ── Contact links ──────────────────────────────────────────────────────
  function waLink(text) { return 'https://wa.me/' + String(SHOP.whatsapp || '').replace(/\D/g, '') + '?text=' + encodeURIComponent(text); }
  function telLink() { var d = String(SHOP.phone || '').replace(/[^\d+]/g, ''); return d ? 'tel:' + d : ''; }

  // ── Server ─────────────────────────────────────────────────────────────
  function rpc(fn, args, signal) {
    return fetch(CFG.supabaseUrl + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: CFG.supabaseKey, Authorization: 'Bearer ' + CFG.supabaseKey },
      body: JSON.stringify(args),
      signal: signal,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = null; }
        if (!res.ok) {
          var err = new Error((body && body.message) || ('HTTP ' + res.status));
          err.status = res.status; err.code = body && body.code;
          throw err;
        }
        return body;
      });
    });
  }
  function isMissingFn(e) { return !!e && (e.code === 'PGRST202' || e.status === 404); }

  async function fetchRecord(kind, code, pin, signal) {
    if (DEMO_MODE) {
      await wait(450);
      var src = kind === 'build' ? D.build : kind === 'repair' ? D.service : D.rma;
      var r = src && src[code];
      return r && pin === D.pin ? JSON.parse(JSON.stringify(r)) : null;
    }
    if (kind === 'repair') return rpc('get_service_public', { code: code, phone4: pin }, signal);
    if (kind === 'warranty') return rpc('get_rma_public', { code: code, phone4: pin }, signal);
    try {
      return await rpc('get_build_public', { code: code, phone4: pin }, signal);
    } catch (e) {
      if (!isMissingFn(e)) throw e;
      // Until sql/tracker-build-public.sql is applied: the old code-only
      // lookup, shown as the limited view (no name, no QC report).
      var rows = await rpc('get_ticket_public', { code: code.toLowerCase() }, signal);
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      var t = rows[0];
      return { code: code, full: false, status: t.status, type: t.type, created_at: t.created_at, deadline: t.deadline, completed_at: t.completed_at, steps: [] };
    }
  }
  function toView(kind, rec) {
    var now = Date.now();
    if (kind === 'build') return T.buildView(rec, now);
    if (!S) throw new Error('The status wording did not load.');
    return kind === 'repair' ? T.serviceView(rec, S, now) : T.rmaView(rec, S, now);
  }

  // ── Elements ───────────────────────────────────────────────────────────
  var home = $('#view-home'), resultView = $('#view-result'), out = $('#result');
  var form = $('#lookup'), codeIn = $('#code'), pinIn = $('#pin'), det = $('#detect');
  var errBox = $('#form-err'), submitBtn = $('#submit'), remember = $('#remember');
  var dock = $('#dock'), liveRegion = $('#live-region');

  // ── Toast ──────────────────────────────────────────────────────────────
  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  // ── Code entry ─────────────────────────────────────────────────────────
  function updateDetect() {
    var code = codeIn.value, k = T.kindOf(code), g = k || T.guessOf(code), problem = !k && code.length >= 6 ? T.codeProblem(code) : null;
    codeIn.removeAttribute('aria-invalid');
    if (!code) { det.hidden = true; return; }
    det.hidden = false;
    if (k) { det.dataset.state = 'ok'; det.innerHTML = ic(KIND[k].icon) + esc(KIND[k].detect) + ic('check'); }
    else if (!g || (problem && /never use/.test(problem))) { det.dataset.state = 'bad'; det.innerHTML = ic('alert') + 'Check this code'; }
    else { det.dataset.state = 'guess'; det.innerHTML = ic(KIND[g].icon) + esc(KIND[g].detect) + '…'; }
  }
  function clearErr() { errBox.hidden = true; errBox.textContent = ''; }
  function showErr(msg, opts) {
    opts = opts || {};
    errBox.innerHTML = ic('alert');
    var span = document.createElement('span');
    span.textContent = msg + ' ';
    if (opts.help) {
      var a = document.createElement('a');
      a.href = waLink('Hi, I need help finding my ticket. My name is ');
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'WhatsApp us your name and we will find it for you.';
      span.appendChild(document.createTextNode(opts.lead || 'Still stuck? '));
      span.appendChild(a);
    }
    errBox.appendChild(span);
    errBox.hidden = false;
    if (opts.field) opts.field.setAttribute('aria-invalid', 'true');
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }

  codeIn.addEventListener('input', function () {
    codeIn.value = T.formatCode(codeIn.value);
    clearErr(); updateDetect();
    if (T.kindOf(codeIn.value) && codeIn.value.length > 6 && !pinIn.value) pinIn.focus();
  });
  codeIn.addEventListener('paste', function (e) {
    var text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    var found = T.extractCode(text);
    if (!found) return;
    e.preventDefault();
    codeIn.value = found; clearErr(); updateDetect();
    if (text.trim().toUpperCase() !== found) toast('Found ' + found + ' in what you pasted');
    if (!pinIn.value) pinIn.focus();
  });
  pinIn.addEventListener('input', function () { pinIn.value = pinIn.value.replace(/\D/g, '').slice(0, 4); pinIn.removeAttribute('aria-invalid'); clearErr(); });
  pinIn.addEventListener('paste', function (e) {
    var p4 = T.extractPhone4((e.clipboardData && e.clipboardData.getData('text')) || '');
    var raw = ((e.clipboardData && e.clipboardData.getData('text')) || '').replace(/\D/g, '');
    if (p4 && raw.length > 4) { e.preventDefault(); pinIn.value = p4; clearErr(); toast('Used the last 4 digits of that number'); }
  });

  function setBusy(on) {
    submitBtn.disabled = on;
    form.setAttribute('aria-busy', String(on));
    submitBtn.innerHTML = on ? '<span class="btn-spin" aria-hidden="true"></span>Checking…' : 'Check status' + ic('arrowR');
  }

  var attempts = 0;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = T.formatCode(codeIn.value), pin = pinIn.value, kind = T.kindOf(code);
    codeIn.value = code;
    if (!kind) {
      showErr(code ? (T.codeProblem(code) || 'That code looks incomplete. Build codes have 6 characters; repair and warranty codes start with NT- or RM- and have 8 more.') : 'Enter the tracking code from your receipt or our message.', { field: codeIn });
      codeIn.focus(); return;
    }
    if (pin.length !== 4) {
      if (!pin && document.activeElement === codeIn) { pinIn.focus(); return; }
      showErr('Enter the last 4 digits of the phone number you gave us.', { field: pinIn });
      pinIn.focus(); return;
    }
    setBusy(true);
    var res = await lookup(kind, code, pin);
    setBusy(false);
    if (res.error) {
      attempts += res.error === 'notfound' ? 1 : 0;
      if (res.error === 'notfound') showErr("We couldn't find a ticket with that code and phone number. Check both against your receipt and try again.", { help: attempts >= 2 });
      else if (res.error === 'locked') showErr('Too many tries for this code. Wait 15 minutes, or', { help: true, lead: '' });
      else if (res.error === 'offline') showErr("You're offline. Connect to the internet and try again.");
      else showErr('We could not reach the tracker just now. Try again in a moment.');
      return;
    }
    attempts = 0; clearErr();
    if (remember.checked) saveTicket(kind, code, pin, res.view);
    showTicket(kind, code, pin, res.rec, res.view, { push: true });
  });

  // → {rec, view} or {error: 'notfound' | 'locked' | 'offline' | 'server'}
  async function lookup(kind, code, pin, signal) {
    if (!DEMO_MODE && navigator.onLine === false) return { error: 'offline' };
    try {
      var rec = await fetchRecord(kind, code, pin, signal);
      if (!rec) return { error: 'notfound' };
      if (rec.locked) return { error: 'locked' };
      return { rec: rec, view: toView(kind, rec) };
    } catch (e) {
      if (e && e.name === 'AbortError') return { error: 'aborted' };
      return { error: navigator.onLine === false ? 'offline' : 'server' };
    }
  }

  // ── Remembered tickets (this browser only) ─────────────────────────────
  var KEY = 'neo-tracker:saved:v1';
  var mem = null;
  function readSaved() {
    if (mem) return mem;
    var list = [];
    try { var raw = localStorage.getItem(KEY); if (raw) list = JSON.parse(raw); } catch (e) { list = []; }
    mem = Array.isArray(list) ? list.filter(function (s) { return s && T.kindOf(s.code) && /^\d{4}$/.test(s.pin); }) : [];
    return mem;
  }
  function writeSaved(list) { mem = list; try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage blocked: memory only */ } }
  function savedEntry(code) { return readSaved().filter(function (s) { return s.code === code; })[0] || null; }
  function saveTicket(kind, code, pin, view) {
    var e = { code: code, pin: pin, kind: kind, title: view.title, short: T.shortStatus(view), tone: view.holder.tone, seen: Date.now() };
    writeSaved([e].concat(readSaved().filter(function (s) { return s.code !== code; })).slice(0, 12));
  }
  function refreshSaved(code, view) {
    var list = readSaved(), changed = false;
    list.forEach(function (s) { if (s.code === code) { s.short = T.shortStatus(view); s.tone = view.holder.tone; s.title = view.title; s.seen = Date.now(); changed = true; } });
    if (changed) writeSaved(list);
  }
  function forget(code) { writeSaved(readSaved().filter(function (s) { return s.code !== code; })); }

  function savedRow(s) {
    var k = KIND[s.kind] || KIND.build;
    var toneLabel = { shop: "We're on it", customer: 'Needs you', third: 'Waiting on maker', done: 'Ready' }[s.tone] || '';
    return '<button type="button" class="srow-main" data-open="' + esc(s.code) + '" aria-label="Check ' + esc(s.code) + ', ' + esc(cap(s.title)) + '">' +
        '<span class="kind-ic ' + k.cls + '">' + ic(k.icon) + '</span>' +
        '<span class="srow-txt"><span class="srow-t">' + esc(cap(s.title || k.label)) + '</span>' +
        '<span class="srow-s"><span class="code">' + esc(s.code) + '</span> · ' + esc(s.short || '') + '</span></span>' +
        (toneLabel ? '<span class="pill ' + tone(s.tone) + '">' + esc(toneLabel) + '</span>' : '') +
        ic('chev', 'srow-chev') +
      '</button>' +
      '<button type="button" class="srow-x" data-forget="' + esc(s.code) + '" aria-label="Forget ' + esc(s.code) + ' on this phone">' + ic('x') + '</button>';
  }
  function renderSaved() {
    var list = readSaved();
    $('#saved').hidden = list.length === 0;
    $('#saved-list').innerHTML = list.map(function (s) { return '<li class="srow">' + savedRow(s) + '</li>'; }).join('');
    $('#install-row').hidden = !installPrompt || list.length === 0;
  }

  // ── Result rendering ───────────────────────────────────────────────────
  function hello(view) {
    if (view.kind === 'build') {
      return view.name ? 'Hi ' + esc(view.name) + '. Here\'s the latest on your <b>' + esc(view.title) + '</b>.' : 'Here\'s the latest on your <b>' + esc(view.title) + '</b>.';
    }
    return (view.name ? 'Hi ' + esc(view.name) + '. ' : '') + 'Here\'s the latest on your <b>' + esc(view.title) + '</b>.';
  }

  function factHtml(f) {
    if (!f) return '';
    var pill = f.state === 'ok' ? '<span class="pill ok">' + ic('check') + 'On track</span>'
      : f.state === 'late' ? '<span class="pill late">' + ic('clock') + 'Running late</span>' : '';
    return '<div class="fact"><span class="fact-k">' + esc(f.label) + '</span><span class="fact-v">' + esc(f.value) + '</span>' +
      (f.note ? '<span class="fact-n">' + esc(f.note) + '</span>' : '') + pill + '</div>';
  }

  function trackHtml(track) {
    var n = track.steps.length, idx = track.index, complete = track.complete;
    var p = complete ? 1 : idx / (n - 1);
    var steps = track.steps.map(function (s, i) {
      var st = complete || i < idx ? 'done' : i === idx ? 'now' : 'todo';
      return '<li class="step ' + st + '"' + (st === 'now' ? ' aria-current="step"' : '') + '><span class="dot" aria-hidden="true">' +
        (st === 'done' ? ic('check') : '') + '</span><span class="step-l">' + esc(s.label) + '</span></li>';
    }).join('');
    return '<ol class="track" style="--n:' + n + ';--p:' + p.toFixed(3) + '" aria-label="Progress: step ' + (idx + 1) + ' of ' + n + ', ' + esc(track.steps[idx].label) + '">' + steps + '</ol>';
  }

  // Repairs and parts loop (diagnose, quote, wait for a part, bench again), so
  // instead of a step bar that could jump backwards: who has it right now.
  function holdersHtml(view, rec) {
    var ball = view.ball || 'shop';
    var at = ball === 'customer' || ball === 'nobody' ? 'you' : ball === 'third_party' ? 'third' : 'shop';
    var youTone = ball === 'nobody' || (rec && (rec.stage === 'ready' || rec.stage === 'ready_to_return')) ? 'done' : 'customer';
    var thirdName = (rec && rec.waiting_party) || (view.kind === 'warranty' ? 'Manufacturer' : 'Supplier');
    var cells = [
      { key: 'you', icon: 'user', name: 'You', sub: at === 'you' ? (youTone === 'done' ? 'Over to you' : 'Your turn') : '', tone: youTone },
      { key: 'shop', icon: 'store', name: 'Neo Tokyo', sub: at === 'shop' ? "We're on it" : '', tone: 'shop' },
      { key: 'third', icon: 'factory', name: thirdName, sub: at === 'third' ? 'Waiting on them' : '', tone: 'third' }
    ];
    return '<div class="holders" role="img" aria-label="Who has it now: ' + esc(cells.filter(function (c) { return c.key === at; })[0].name) + '">' +
      cells.map(function (c) {
        return '<div class="holder' + (c.key === at ? ' on ' + tone(c.tone) : '') + '" aria-hidden="true">' + ic(c.icon) + '<b>' + esc(c.name) + '</b>' + (c.sub ? '<span>' + esc(c.sub) + '</span>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function summaryHtml(view, rec) {
    var k = KIND[view.kind];
    var since = view.since ? T.fmtSince(view.since, Date.now()) : '';
    var line = (since ? 'Since ' + esc(since) : '') + (view.stalled && view.kind !== 'build' ? ' (' + esc(view.stalled) + ')' : '') +
      (view.handler ? (since ? ' · ' : '') + esc(view.handler) + (view.track && view.track.complete ? ' built it' : ' is looking after it') : '');
    var facts = [factHtml(view.due), view.next ? '<div class="fact"><span class="fact-k">Next</span><span class="fact-v">' + esc(view.next) + '</span></div>' : ''].join('');
    return '<article class="card glass summary rise" style="--d:0" aria-labelledby="headline">' +
      '<div class="sum-top">' +
        '<span class="kind-chip ' + k.cls + '">' + ic(k.icon) + esc(k.label) + '</span>' +
        '<button type="button" class="ref" data-copy="' + esc(view.code) + '" aria-label="Copy reference ' + esc(view.code) + '">' + esc(view.code) + ic('copy') + '</button>' +
        '<span class="live" id="live" data-state="ok"><i aria-hidden="true"></i><span id="live-txt">Live · updated just now</span></span>' +
      '</div>' +
      '<div class="sum-head">' +
        '<p class="hello">' + hello(view) + '</p>' +
        '<h2 class="headline" id="headline">' + esc(view.sentence) + '</h2>' +
        '<div class="status-line"><span class="pill ' + tone(view.holder.tone) + '">' + esc(view.holder.label) + '</span>' +
          (line ? '<span class="since">' + ic('clock') + '<span>' + line + '</span></span>' : '') + '</div>' +
      '</div>' +
      (facts ? '<div class="facts">' + facts + '</div>' : '') +
      (view.track ? trackHtml(view.track) : holdersHtml(view, rec)) +
    '</article>';
  }

  function calloutHtml(cls, icon, title, body, buttons, d) {
    return '<section class="callout ' + cls + ' rise" style="--d:' + (d || 1) + '"><span class="callout-ic">' + ic(icon) + '</span>' +
      '<div class="callout-body"><h3>' + esc(title) + '</h3>' + (body ? '<p>' + esc(body) + '</p>' : '') +
      (buttons ? '<div class="btn-row">' + buttons + '</div>' : '') + '</div></section>';
  }
  function waBtn(text, label, primary) {
    return '<a class="btn ' + (primary ? 'btn-wa' : 'btn-ghost') + '" href="' + esc(waLink(text)) + '" target="_blank" rel="noopener">' + ic('chat') + esc(label) + '</a>';
  }
  function callBtn(label) {
    var t = telLink();
    return t ? '<a class="btn btn-ghost" href="' + esc(t) + '">' + ic('phone') + esc(label || 'Call the shop') + '</a>' : '';
  }
  function mapsBtn() {
    return '<a class="btn btn-primary" href="' + esc(SHOP.mapsUrl || 'https://www.google.com/maps/search/?api=1&query=Neo+Tokyo+Kochi') + '" target="_blank" rel="noopener">' + ic('pin') + 'Directions to the shop</a>';
  }

  function calloutsHtml(view, rec) {
    var code = view.code;
    if (view.kind === 'build') {
      if (!view.full) {
        return calloutHtml('info', 'info', 'Showing the basic status', 'This ticket has no phone number on file, so we only show its progress here. Message us and we\'ll add your number, then you\'ll see the full quality report.',
          waBtn('Hi, please add my phone number to build ticket ' + code + '.', 'Ask us to add it', false));
      }
      if (view.track.complete) {
        if (view.verdict === false) {
          return calloutHtml('warn', 'info', 'One more check before handover', 'Your technician is taking a second look at one of the test results before you collect it. We\'ll call you when it\'s ready.',
            waBtn('Hi, I have a question about my PC (' + code + ').', 'Ask us about it', false) + callBtn());
        }
        return calloutHtml('ok', 'check', 'Ready when you are', 'Your PC passed our checks. Collect it any time the shop is open, and bring this code or your receipt.',
          mapsBtn() + waBtn('Hi, I\'d like to collect my PC (' + code + '). When can I come?', 'Plan my pickup', false));
      }
      return '';
    }
    var stage = rec && rec.stage;
    if (view.ball === 'customer') {
      if (stage === 'quoted') {
        return calloutHtml('warn', 'info', 'We need your go-ahead', 'We\'ve sent you the repair quote. Reply on WhatsApp to approve it, or call us if you have questions first.',
          waBtn('Hi, I approve the repair quote for ' + code + '.', 'Approve on WhatsApp', true) + callBtn('Call to ask first'));
      }
      if (stage === 'ready' || stage === 'ready_to_return') {
        return calloutHtml('ok', 'check', 'Ready to collect', 'Collect it any time the shop is open. Quote ' + code + ' at the counter.',
          mapsBtn() + waBtn('Hi, I\'d like to collect ' + code + '. When can I come?', 'Plan my pickup', false));
      }
      if (stage === 'work_done' || stage === 'resolved') {
        return calloutHtml('info', 'info', 'Is everything working?', 'Use it for a day. If anything is still wrong, tell us and we\'ll pick it up again.',
          waBtn('Hi, about ' + code + ': ', 'Something is still wrong', false) + waBtn('Hi, ' + code + ' is working well now. Thank you!', 'All good', true));
      }
      return calloutHtml('warn', 'info', 'We need something from you', view.sentence + '. Message or call us and we\'ll take it from there.',
        waBtn('Hi, about ' + code + ': ', 'Message us', true) + callBtn());
    }
    return '';
  }

  function timelineHtml(view) {
    var now = Date.now();
    var items = view.events.length ? view.events.map(function (e, i) {
      return '<li' + (i === 0 ? ' class="latest"' : '') + '><span class="tl-dot" aria-hidden="true"></span>' +
        '<p class="tl-t">' + esc(e.title) + '</p>' + (e.note ? '<p class="tl-n">' + esc(e.note) + '</p>' : '') +
        '<p class="tl-time"><time datetime="' + esc(new Date(e.at).toISOString()) + '">' + esc(T.fmtWhen(e.at, now)) + '</time></p></li>';
    }).join('') : '';
    return '<section class="card rise" style="--d:2" aria-labelledby="tl-h"><h3 class="card-h" id="tl-h">What\'s happened so far</h3>' +
      (items ? '<ol class="tl">' + items + '</ol>' : '<p class="tl-empty">Nothing to report yet. This page updates as soon as anything changes.</p>') + '</section>';
  }

  function detailsHtml(view) {
    var note = view.kind === 'warranty' && view.ball === 'third_party' ? 'Manufacturers usually take 10 to 15 days to settle a claim.' : '';
    return '<section class="card rise" style="--d:3" aria-labelledby="det-h"><h3 class="card-h" id="det-h">Details</h3><dl class="dets">' +
      view.details.map(function (d) { return '<div><dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd></div>'; }).join('') +
      '<div><dt>Reference</dt><dd class="code">' + esc(view.code) + '</dd></div></dl>' +
      (note ? '<p class="note-line">' + ic('info') + '<span>' + esc(note) + '</span></p>' : '') +
      (view.linked ? '<p class="note-line">' + ic('wrench') + '<span>Part of repair <span class="code">' + esc(view.linked) + '</span>. <button type="button" class="link-btn" data-track="' + esc(view.linked) + '">Track the repair</button></span></p>' : '') +
      '</section>';
  }

  function partsHtml(view) {
    if (!view.parts || !view.parts.length) return '';
    return '<section class="card rise" style="--d:3" aria-labelledby="parts-h"><h3 class="card-h" id="parts-h">Parts under warranty claim</h3><ul class="parts">' +
      view.parts.map(function (p) {
        return '<li class="part"><div class="part-top"><span class="part-name">' + esc(p.label) + '</span>' + (p.code ? '<span class="part-code code">' + esc(p.code) + '</span>' : '') + '</div>' +
          '<span class="part-s">' + esc(cap(p.sentence)) + (p.stalled ? ' · for ' + esc(p.stalled) : '') + '</span>' +
          (p.code ? '<button type="button" class="btn-mini" data-track="' + esc(p.code) + '">Track this part</button>' : '') + '</li>';
      }).join('') + '</ul></section>';
  }

  // Quality checks while a build is in or near testing.
  function checksHtml(view) {
    if (!view.full || view.track.complete || view.track.index < 2) return '';
    var qc = view.qc || {};
    var testing = view.track.index === 3;
    var rows = [];
    function row(state, label, sub) { rows.push({ state: state, label: label, sub: sub }); }
    var parts = [qc.cpu && qc.cpu.model, qc.ram && qc.ram.total_gb != null ? qc.ram.total_gb + ' GB ' + (qc.ram.gen || 'memory') : null, qc.storage && qc.storage.model].filter(Boolean);
    row(parts.length ? 'pass' : 'todo', 'Every part recognised at full spec', parts.length ? parts.join(' · ') : 'Up next');
    if (qc.ports) {
      var p = qc.ports, bits = [];
      if (p.usb_controllers != null) bits.push(p.usb_controllers + ' USB controllers');
      if (p.video_outputs != null) bits.push(p.video_outputs + ' video outputs');
      if (p.audio_endpoints != null) bits.push(p.audio_endpoints + ' audio devices');
      row('pass', 'Ports and audio', bits.join(', ') || 'Checked');
    } else row('todo', 'Ports and audio', 'Up next');
    if (qc.prime95) row(qc.prime95.result === 'pass' ? 'pass' : 'warn', 'Stability test', (qc.prime95.minutes ? qc.prime95.minutes + ' minutes at full load, ' : '') + (qc.prime95.errors ? qc.prime95.errors + ' errors' : 'no errors'));
    else row(testing ? 'run' : 'todo', 'Stability test', testing ? 'Running now: up to an hour at full load' : 'Up next');
    if (qc.cpu_temp_max != null) row(qc.cpu_temp_max <= 85 ? 'pass' : 'warn', 'Temperatures under load', 'CPU peaked at ' + qc.cpu_temp_max + '°C' + (qc.gpu_temp_max != null ? ', graphics at ' + qc.gpu_temp_max + '°C' : ''));
    else row('todo', 'Temperatures under load', 'Measured during the stability test');
    row('todo', 'Final look-over and clean-up', 'Last step before we call you');
    return '<section class="card rise" style="--d:3" aria-labelledby="chk-h"><h3 class="card-h" id="chk-h">' + (testing ? 'Quality checks' : 'What we\'ll check') + '</h3><ul class="checks">' +
      rows.map(function (r) {
        var mark = r.state === 'pass' ? ic('check') : r.state === 'warn' ? ic('alert') : r.state === 'run' ? '<span class="btn-spin" style="border-color:var(--brand-tint);border-top-color:var(--primary);margin:2px" aria-hidden="true"></span>' : '<span class="ring" aria-hidden="true"></span>';
        return '<li class="chk ' + (r.state === 'run' ? 'todo' : r.state) + '">' + mark + '<div><p>' + esc(r.label) + '</p><span class="sub">' + esc(r.sub) + '</span></div></li>';
      }).join('') + '</ul></section>';
  }

  function reportHtml(view) {
    var qc = view.qc;
    if (!view.full || !view.track.complete || !qc) return '';
    var tiles = [];
    function tile(icon, k, model, big, v, ok) { tiles.push({ icon: icon, k: k, model: model, big: big, v: v, ok: ok }); }
    if (qc.cpu) tile('cpu', 'Processor', qc.cpu.model || 'CPU', qc.cpu.temp_max != null ? qc.cpu.temp_max + '°C' : (qc.cpu.cores ? qc.cpu.cores + ' cores' : ''), qc.cpu.temp_max != null ? 'peak under full load' : '', !(qc.cpu.throttled || qc.cpu.temp_max > 85));
    if (qc.gpu) tile('gpu', 'Graphics', qc.gpu.model || 'GPU', qc.gpu.temp_max != null ? qc.gpu.temp_max + '°C' : (qc.gpu.vram || ''), qc.gpu.temp_max != null ? 'peak under full load' : 'memory', !(qc.gpu.throttled || qc.gpu.temp_max > 80));
    if (qc.ram) tile('memory', 'Memory', (qc.ram.total_gb != null ? qc.ram.total_gb + ' GB ' : '') + (qc.ram.gen || ''), qc.ram.errors != null ? String(qc.ram.errors) : '', qc.ram.errors != null ? (qc.ram.errors === 1 ? 'error under stress' : 'errors under stress') : 'detected', !(qc.ram.errors > 0) && qc.ram_stress !== 'failed');
    if (qc.storage) tile('disk', 'Storage', qc.storage.model || (qc.storage.size_gb ? qc.storage.size_gb + ' GB' : 'Drive'), qc.storage.life_remaining != null ? qc.storage.life_remaining + '%' : '', qc.storage.life_remaining != null ? 'drive health' : 'detected', !(qc.storage.life_remaining < 30));
    if (qc.prime95) tile('bolt', 'Stability', qc.prime95.result === 'pass' ? 'Passed' : 'Needs a look', qc.prime95.minutes ? qc.prime95.minutes + ' min' : '', 'at full load, ' + (qc.prime95.errors ? qc.prime95.errors + ' errors' : 'no errors'), qc.prime95.result === 'pass');
    if (qc.cinebench != null) tile('gauge', 'Performance', 'Cinebench R23', Number(qc.cinebench).toLocaleString('en-IN'), 'points, multi-core', true);
    if (!tiles.length && qc.cpu_temp_max == null) return '';
    var verdict = view.verdict;
    var pill = verdict === true ? '<span class="pill tone-done">' + ic('check') + 'Passed all checks</span>' : verdict === false ? '<span class="pill tone-customer">' + ic('alert') + 'Under review</span>' : '';
    var temps = Array.isArray(qc.cpu_temps) ? qc.cpu_temps.filter(function (n) { return typeof n === 'number' && isFinite(n); }) : [];
    var ports = qc.ports ? [qc.ports.usb_controllers != null ? qc.ports.usb_controllers + ' USB controllers' : null, qc.ports.video_outputs != null ? qc.ports.video_outputs + ' video outputs' : null, qc.ports.audio_endpoints != null ? qc.ports.audio_endpoints + ' audio devices' : null].filter(Boolean).join(', ') : '';
    return '<section class="card report rise" style="--d:4" aria-labelledby="rep-h">' +
      '<div class="report-head"><div><h3 class="card-h" id="rep-h">Quality report</h3><p class="report-sub">Recorded by ' + esc(view.handler || 'your technician') + ' before handover</p></div>' + pill + '</div>' +
      (tiles.length ? '<div class="health" data-count="' + tiles.length + '">' + tiles.map(function (t) {
        return '<div class="tile"><span class="tile-ic">' + ic(t.icon) + '</span><p class="tile-k">' + esc(t.k) + '</p><p class="tile-m">' + esc(t.model) + '</p>' +
          '<p class="tile-v">' + (t.big ? '<b>' + esc(t.big) + '</b> ' : '') + esc(t.v) + '</p>' +
          '<span class="tile-ok ' + (t.ok ? 'pass' : 'warn') + '" role="img" aria-label="' + (t.ok ? 'Passed' : 'Needs a look') + '">' + ic(t.ok ? 'check' : 'alert') + '</span></div>';
      }).join('') + '</div>' : '') +
      (temps.length > 5 ? '<div class="stab"><div class="stab-head"><p class="stab-t">CPU temperature during the stability test</p><p class="stab-s">°C' + (qc.prime95 && qc.prime95.minutes ? ' over ' + qc.prime95.minutes + ' minutes' : '') + '</p></div>' + chart(temps, qc.prime95 && qc.prime95.minutes) + '</div>' : '') +
      (ports ? '<p class="ports">' + ic('plug') + '<span>Ports checked: ' + esc(ports) + '.</span></p>' : '') +
    '</section>';
  }

  // The temperature line, drawn to one scale.
  function chart(temps, minutes) {
    // Drawn at the width it will show at, so the labels stay at their real size.
    var W = Math.round(Math.min(760, Math.max(260, (out.clientWidth || window.innerWidth) - 84)));
    var H = 150, L = 34, R = 12, Tp = 18, B = 24;
    var max = Math.max.apply(null, temps), min = Math.min.apply(null, temps);
    var YMIN = Math.max(0, Math.floor((min - 8) / 10) * 10), YMAX = Math.max(YMIN + 30, Math.ceil((max + 6) / 10) * 10);
    var n = temps.length - 1;
    var x = function (i) { return L + (i / n) * (W - L - R); };
    var y = function (v) { return Tp + (1 - (v - YMIN) / (YMAX - YMIN)) * (H - Tp - B); };
    var pts = temps.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
    var area = 'M' + x(0) + ',' + y(YMIN) + ' L' + pts.join(' L') + ' L' + x(n) + ',' + y(YMIN) + ' Z';
    var grid = '';
    for (var g = YMIN + 10; g < YMAX; g += 10) {
      if (g % 20 !== 0 && YMAX - YMIN > 40) continue;
      grid += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/><text x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" text-anchor="end">' + g + '°</text>';
    }
    var pk = temps.indexOf(max);
    var anchor = x(pk) > W * 0.6 ? 'end' : 'start';
    var lx = anchor === 'end' ? x(pk) - 8 : x(pk) + 8;
    var end = minutes ? minutes + ' min' : 'End';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CPU temperature during the stability test: from ' + Math.round(temps[0]) + '°C, peaking at ' + max + '°C.">' +
      grid + '<path class="ar" d="' + area + '"/><polyline class="ln" points="' + pts.join(' ') + '"/>' +
      '<circle class="pk" cx="' + x(pk).toFixed(1) + '" cy="' + y(max).toFixed(1) + '" r="4"/>' +
      '<text class="pk-l" x="' + lx.toFixed(1) + '" y="' + Math.max(11, y(max) - 4).toFixed(1) + '" text-anchor="' + anchor + '">' + max + '°C peak</text>' +
      '<text x="' + L + '" y="' + (H - 6) + '" text-anchor="start">Start</text><text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(end) + '</text></svg>';
  }

  function contactHtml(view) {
    var num = SHOP.phone ? '<p class="contact-num">' + esc(SHOP.phone) + (SHOP.hours ? ' · ' + esc(SHOP.hours) : '') + '</p>' : (SHOP.hours ? '<p class="contact-num">' + esc(SHOP.hours) + '</p>' : '');
    return '<section class="card contact rise" style="--d:5" aria-labelledby="ct-h"><div><h3 class="card-h" id="ct-h">Questions about ' + esc(view.code) + '?</h3>' +
      '<p class="contact-p">Message or call the shop and mention this reference. We\'ll pull it up straight away.</p>' + num + '</div>' +
      '<div class="btn-row">' + waBtn('Hi, I have a question about ' + view.code + '.', 'WhatsApp us', true) + callBtn() + '</div></section>';
  }

  function notifyHtml() {
    if (!('Notification' in window) || Notification.permission === 'denied') return '';
    var on = state.notify && Notification.permission === 'granted';
    return '<button type="button" class="btn btn-ghost" id="notify-btn" aria-pressed="' + on + '">' + ic('bell') + (on ? 'Alerts on while this page is open' : 'Alert me when this changes') + '</button>';
  }

  function render(view, rec) {
    var side = view.kind === 'build' ? checksHtml(view) + detailsHtml(view) : partsHtml(view) + detailsHtml(view);
    return summaryHtml(view, rec) +
      calloutsHtml(view, rec) +
      '<div class="split">' + timelineHtml(view) + '<div class="side">' + side + '</div></div>' +
      (view.kind === 'build' ? reportHtml(view) : '') +
      contactHtml(view) +
      '<div class="fine"><p>This page checks for updates every ' + Math.round((CFG.pollMs || 30000) / 1000) + ' seconds while it\'s open.</p>' + notifyHtml() + '</div>';
  }

  var skeleton = '<div class="card glass summary skel" aria-busy="true" aria-label="Loading your ticket">' +
    '<div class="sk" style="width:40%"></div><div class="sk sk-lg" style="width:80%"></div><div class="sk" style="width:56%"></div>' +
    '<div class="sk-row"><div class="sk sk-box"></div><div class="sk sk-box"></div></div><div class="sk" style="height:8px"></div></div>';

  // ── Views and history ──────────────────────────────────────────────────
  var state = { kind: null, code: null, pin: null, view: null, rec: null, lastOk: 0, failing: false, notify: false, ctrl: null };
  var pollTimer = null, tickTimer = null;
  var baseTitle = document.title;

  // Animated view change for what the customer did (search, back); a plain
  // swap on start-up and when one view replaces its own placeholder.
  var booted = false, inTransition = false;
  function swap(fn) {
    if (!booted || inTransition || !document.startViewTransition || reduced() || document.hidden) { fn(); return; }
    inTransition = true;
    var vt;
    try { vt = document.startViewTransition(fn); } catch (e) { inTransition = false; fn(); return; }
    var done = function () { inTransition = false; };
    vt.finished.then(done, done);
    vt.ready.catch(function () { /* skipped: the update still ran */ });
    vt.updateCallbackDone.catch(function () { /* reported by the callback itself */ });
  }
  function ticketPath(code) { return '/t/' + encodeURIComponent(code) + (DEMO_MODE ? '?demo' : ''); }
  function homePath() { return '/' + (DEMO_MODE ? '?demo' : ''); }

  function enterResult(html) {
    home.hidden = true; resultView.hidden = false; out.innerHTML = html;
    dock.hidden = false; document.body.classList.add('has-dock');
    window.scrollTo(0, 0);
  }
  function paint(view, rec, quiet) {
    out.classList.toggle('no-rise', !!quiet);   // a background refresh must not replay the entrance
    out.innerHTML = render(view, rec);
    $('#dock-wa').href = waLink('Hi, I have a question about ' + view.code + '.');
    document.title = view.sentence + ' · ' + view.code + ' · Neo Tokyo';
    updateSaveBtn();
  }
  function showTicket(kind, code, pin, rec, view, opts) {
    opts = opts || {};
    state.kind = kind; state.code = code; state.pin = pin; state.rec = rec; state.view = view;
    state.lastOk = Date.now(); state.failing = false;
    if (opts.push && location.pathname !== '/t/' + code) history.pushState({ t: code }, '', ticketPath(code));
    if (opts.replace) history.replaceState({ t: code }, '', ticketPath(code));
    if (!resultView.hidden) { paint(view, rec); window.scrollTo(0, 0); }   // replacing the loading placeholder
    else swap(function () { enterResult(''); paint(view, rec); });
    liveRegion.textContent = view.sentence;
    startLive();
  }
  async function openSaved(code, opts) {
    var s = savedEntry(code);
    if (!s) return;
    stopLive();
    swap(function () { enterResult(skeleton); updateSaveBtn(code); });
    var res = await lookup(s.kind, s.code, s.pin);
    if (res.error) {
      showHome({ replace: true });
      if (res.error === 'notfound') { forget(code); renderSaved(); }
      codeIn.value = s.code; updateDetect();
      showErr(res.error === 'notfound' ? 'That saved ticket could not be opened any more. Enter the code and phone digits again.' :
              res.error === 'locked' ? 'Too many tries for this code. Wait 15 minutes, or' : res.error === 'offline' ? "You're offline. Connect to the internet and try again." : 'We could not reach the tracker just now. Try again in a moment.',
              { help: res.error === 'locked', lead: '' });
      return;
    }
    refreshSaved(code, res.view);
    showTicket(s.kind, s.code, s.pin, res.rec, res.view, opts || { push: true });
  }
  function showHome(opts) {
    opts = opts || {};
    stopLive();
    state.kind = state.code = state.pin = state.view = state.rec = null;
    document.title = baseTitle;
    if (opts.replace) history.replaceState(null, '', homePath());
    swap(function () {
      resultView.hidden = true; home.hidden = false;
      dock.hidden = true; document.body.classList.remove('has-dock');
      renderSaved(); window.scrollTo(0, 0);
    });
  }
  function goHome() {
    if (history.state && history.state.t) history.back();
    else showHome({ replace: true });
  }
  window.addEventListener('popstate', function () {
    var code = codeFromPath();
    if (code && savedEntry(code)) openSaved(code, {});
    else if (code && state.code === code && state.view) { /* already showing */ }
    else showHome();
  });

  function updateSaveBtn(code) {
    var c = code || state.code;
    var btn = $('#save-btn');
    var saved = !!c && !!savedEntry(c);
    btn.setAttribute('aria-pressed', String(saved));
    btn.innerHTML = saved ? ic('check') + 'Saved on this phone' : ic('bookmark') + 'Save on this phone';
  }
  $('#save-btn').addEventListener('click', function () {
    if (!state.code) return;
    if (savedEntry(state.code)) { forget(state.code); toast('Removed from this phone'); }
    else { saveTicket(state.kind, state.code, state.pin, state.view); toast('Saved. One tap to check it next time.'); }
    updateSaveBtn();
  });

  // ── Live refresh ───────────────────────────────────────────────────────
  function agoText(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 6) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : T.fmtClock(t);
  }
  function tick() {
    var txt = $('#live-txt'), live = $('#live');
    if (!txt || !state.lastOk) return;
    if (state.failing) { live.dataset.state = 'stale'; txt.textContent = "Can't refresh · showing " + T.fmtClock(state.lastOk); }
    else { live.dataset.state = 'ok'; txt.textContent = 'Live · updated ' + agoText(state.lastOk); }
  }
  async function refresh() {
    if (!state.code) return;
    if (state.ctrl) state.ctrl.abort();
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    state.ctrl = ctrl;
    var code = state.code;
    var res = await lookup(state.kind, code, state.pin, ctrl && ctrl.signal);
    if (state.code !== code || res.error === 'aborted') return;   // the customer moved on
    if (res.error) {
      if (res.error === 'notfound' || res.error === 'locked') { stopLive(); state.failing = true; tick(); return; }
      state.failing = true; tick(); return;
    }
    var before = state.view && state.view.sentence;
    state.rec = res.rec; state.view = res.view; state.lastOk = Date.now(); state.failing = false;
    var scrollY = window.scrollY, openDetails = $$('details[open]', out).length;
    paint(res.view, res.rec, true);
    if (!openDetails) window.scrollTo(0, scrollY);
    refreshSaved(code, res.view);
    if (before && before !== res.view.sentence) announceChange(res.view);
    tick();
  }
  function announceChange(view) {
    toast('Update: ' + view.sentence);
    liveRegion.textContent = 'Update: ' + view.sentence;
    if (document.hidden) document.title = '● ' + view.sentence + ' · ' + view.code;
    if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Neo Tokyo · ' + view.code, { body: view.sentence, icon: '/brand/icon-192.png', tag: view.code }); } catch (e) { /* some phones only allow it from a service worker */ }
    }
    if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) { /* ignore */ } }
  }
  function startLive() {
    stopLive();
    tickTimer = setInterval(tick, 1000);
    pollTimer = setInterval(function () {
      if (document.hidden && !state.notify) return;
      if (navigator.onLine === false && !DEMO_MODE) { state.failing = true; tick(); return; }
      refresh();
    }, CFG.pollMs || 30000);
  }
  function stopLive() {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = tickTimer = null;
    if (state.ctrl) { state.ctrl.abort(); state.ctrl = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !state.code) return;
    if (state.view) document.title = state.view.sentence + ' · ' + state.view.code + ' · Neo Tokyo';
    if (Date.now() - state.lastOk > 15000) refresh();
  });

  // ── Online / offline ───────────────────────────────────────────────────
  function setOffline(off) { $('#offline-bar').hidden = !off || DEMO_MODE; }
  window.addEventListener('offline', function () { setOffline(true); });
  window.addEventListener('online', function () { setOffline(false); if (state.code) refresh(); });

  // ── Clicks ─────────────────────────────────────────────────────────────
  function copy(text) {
    var p;
    try { p = navigator.clipboard.writeText(text); } catch (e) { p = Promise.reject(e); }
    p.then(function () { toast('Copied ' + text); }, function () { toast('Your reference is ' + text); });
  }
  async function trackLinked(code) {
    var kind = T.kindOf(code);
    if (!kind || !state.pin) return;
    var pin = state.pin;
    stopLive();
    swap(function () { enterResult(skeleton); });
    var res = await lookup(kind, code, pin);
    if (res.error) { toast('That one could not be opened with these phone digits.'); if (state.view) { enterResult(''); paint(state.view, state.rec); startLive(); } return; }
    if (savedEntry(state.code)) saveTicket(kind, code, pin, res.view);
    showTicket(kind, code, pin, res.rec, res.view, { push: true });
  }
  async function toggleNotify(btn) {
    if (!('Notification' in window)) return;
    if (state.notify) { state.notify = false; btn.setAttribute('aria-pressed', 'false'); btn.innerHTML = ic('bell') + 'Alert me when this changes'; toast('Alerts off'); return; }
    var perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
    if (perm !== 'granted') { toast('Alerts are blocked in this browser. The page still updates by itself.'); return; }
    state.notify = true;
    btn.setAttribute('aria-pressed', 'true'); btn.innerHTML = ic('bell') + 'Alerts on while this page is open';
    toast("We'll alert you when anything changes. Keep this page open.");
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-copy],[data-open],[data-forget],[data-forget-yes],[data-forget-no],[data-demo],[data-track],#notify-btn');
    if (!el) return;
    if (el.id === 'notify-btn') toggleNotify(el);
    else if (el.hasAttribute('data-copy')) copy(el.getAttribute('data-copy'));
    else if (el.hasAttribute('data-open')) openSaved(el.getAttribute('data-open'));
    else if (el.hasAttribute('data-track')) trackLinked(el.getAttribute('data-track'));
    else if (el.hasAttribute('data-demo')) runDemo(el.getAttribute('data-demo'));
    else if (el.hasAttribute('data-forget')) {
      var code = el.getAttribute('data-forget'), li = el.closest('.srow');
      li.innerHTML = '<div class="srow-confirm"><span>Forget <b class="code">' + esc(code) + '</b> on this phone? You can add it again any time.</span>' +
        '<button type="button" class="btn-mini danger" data-forget-yes="' + esc(code) + '">Forget</button>' +
        '<button type="button" class="btn-mini" data-forget-no="' + esc(code) + '">Keep</button></div>';
      li.querySelector('[data-forget-no]').focus();
    } else if (el.hasAttribute('data-forget-yes')) { forget(el.getAttribute('data-forget-yes')); renderSaved(); toast('Forgotten on this phone'); }
    else if (el.hasAttribute('data-forget-no')) renderSaved();
  });
  $('#back-btn').addEventListener('click', goHome);
  $('#brand').addEventListener('click', function (e) { if (!home.hidden) return; e.preventDefault(); goHome(); });

  // Pointer spotlight on the lookup card edge (mouse only).
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    form.addEventListener('pointermove', function (e) {
      var r = form.getBoundingClientRect();
      form.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      form.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  }

  // ── Theme: match device → light → dark ─────────────────────────────────
  var THEMES = ['system', 'light', 'dark'];
  var THEME_NAMES = { system: 'Match device', light: 'Light', dark: 'Dark' };
  var theme = 'system';
  try { theme = localStorage.getItem('neo-tracker:theme') || 'system'; } catch (e) { theme = 'system'; }
  if (THEMES.indexOf(theme) === -1) theme = 'system';
  function applyTheme() {
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    var b = $('#theme-btn');
    b.innerHTML = ic(theme === 'system' ? 'monitor' : theme === 'light' ? 'sun' : 'moon');
    b.setAttribute('aria-label', 'Theme: ' + THEME_NAMES[theme] + '. Change theme');
    b.title = 'Theme: ' + THEME_NAMES[theme];
  }
  $('#theme-btn').addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { if (theme === 'system') localStorage.removeItem('neo-tracker:theme'); else localStorage.setItem('neo-tracker:theme', theme); } catch (e) { /* not kept */ }
    applyTheme(); toast('Theme: ' + THEME_NAMES[theme]);
  });

  // ── Install to home screen ─────────────────────────────────────────────
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; renderSaved(); });
  $('#install-btn').addEventListener('click', async function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) { /* ignore */ }
    installPrompt = null; renderSaved();
  });
  // Live site only: on a local preview a cached shell would hide every edit.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* the page works without it */ }); });
  }

  // ── Demo mode ──────────────────────────────────────────────────────────
  function runDemo(code) {
    if (!home.hidden) { /* already home */ } else { showHome({ replace: true }); }
    codeIn.value = code; pinIn.value = D.pin;
    clearErr(); updateDetect(); window.scrollTo(0, 0);
    if (form.requestSubmit) form.requestSubmit(submitBtn); else submitBtn.click();
  }
  function loadDemo() {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/tracker/demo.js';
      s.onload = function () { D = window.NEO_TRACKER_DEMO; resolve(); };
      s.onerror = function () { DEMO_MODE = false; resolve(); };
      document.head.appendChild(s);
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────
  function codeFromPath() {
    var m = location.pathname.match(/^\/t\/([^/]+)\/?$/);
    if (!m) return null;
    var c = T.formatCode(decodeURIComponent(m[1]));
    return T.kindOf(c) ? c : null;
  }
  function fillShop() {
    if (SHOP.hours) { var h = $('#foot-hours'); h.textContent = SHOP.hours; h.hidden = false; }
    if (SHOP.mapsUrl) $('#foot-maps').href = SHOP.mapsUrl;
    $('#foot-wa').href = waLink('Hi Neo Tokyo, ');
    var t = telLink(), call = $('#dock-call');
    if (t) { call.href = t; call.hidden = false; }
  }

  async function start() {
    $$('[data-ic]').forEach(function (el) { el.outerHTML = ic(el.getAttribute('data-ic')); });
    applyTheme();
    fillShop();
    setOffline(navigator.onLine === false);
    if (DEMO_MODE) await loadDemo();
    if (DEMO_MODE && D) {
      $('#demo-strip').hidden = false;
      $('#demo-chips').innerHTML = D.chips.map(function (c) { return '<button type="button" class="demo-chip" data-demo="' + esc(c.code) + '">' + esc(c.label) + '</button>'; }).join('');
    }
    renderSaved();
    updateDetect();

    var code = codeFromPath() || (function () { var c = T.formatCode(params.get('code') || ''); return T.kindOf(c) ? c : null; })();
    if (code) {
      if (savedEntry(code)) { openSaved(code, { replace: true }); return; }
      history.replaceState(null, '', homePath());
      codeIn.value = code; updateDetect();
      pinIn.focus();
      toast('Enter the last 4 digits of your phone to see ' + code);
    } else if (location.pathname !== '/' && location.pathname !== '/index.html') {
      history.replaceState(null, '', homePath());
    }
  }
  // Animations start once the first view has painted.
  window.addEventListener('load', function () { setTimeout(function () { booted = true; }, 300); });
  start();
})();
