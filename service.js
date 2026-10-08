/*
  Neo QC — service ticketing (phase 1): intake, the ball-with board, and the
  job panel. Loaded AFTER app.js, so it can use supabaseClient, currentProfile,
  showToast, showConfirm and escapeHtmlLite from the shared script scope.

  Deliberately a separate file and separate tables. Every consumer of `tickets`
  is build-shaped and type-blind, and three of them would destroy a service row:
  handleTicketFormSubmit recomputes status from the build checkboxes with no
  branch on type, it rebuilds specs as a fresh literal keeping only seven known
  keys, and the ticket-type select has a single option so reading a service row
  back and saving it blanks its own type. tech-assign.js would also count a
  six-week RMA against a technician's bench budget. Nothing here touches any of
  that; no existing sync path names these tables.

  All status rules live in shared/service-status.js, which the website loads
  too — so the two surfaces cannot drift the way the build side's urgency rule
  did.
*/
(function () {
  'use strict';

  var S = null;                 // shared/service-status.js, resolved lazily
  var serviceJobs = [];         // the open board, newest first
  var serviceLoaded = false;
  var serviceChannel = null;
  var boardTimer = null;        // ageing changes with the clock, not with events
  var openJobId = null;

  function svc() {
    if (!S) S = (typeof window !== 'undefined' && window.NeoQcService) || null;
    return S;
  }
  function db() { return (typeof supabaseClient !== 'undefined') ? supabaseClient : null; }
  function esc(s) { return (typeof escapeHtmlLite === 'function') ? escapeHtmlLite(s == null ? '' : s) : String(s == null ? '' : s); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  function me() { return (typeof currentProfile !== 'undefined' && currentProfile) || null; }
  function myTier() { var p = me(); return p ? Number(p.tier) || 0 : 0; }

  // ── ids ────────────────────────────────────────────────────────────────────
  // Same shape as the build side's t_<base36> so the two read as siblings.
  function newJobId() {
    return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  // The customer-facing code. Deliberately NOT the tail of the id: a service job
  // carries more personal data than a build, and the build side's 6-char scheme
  // is derived from a guessable timestamp prefix. 8 random base32 characters
  // from a crypto source, ambiguous glyphs removed so it survives being read
  // aloud over the phone.
  var CODE_ALPHABET = '234679ACDEFGHJKLMNPQRTUVWXYZ';
  function newPublicCode() {
    var out = 'NT-';
    var bytes = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }

  function nowIso() { return new Date().toISOString(); }

  // ── data ───────────────────────────────────────────────────────────────────
  // Every read is wrapped: if the migration has not been run on this machine's
  // project yet, the section stays empty rather than throwing. Same discipline
  // as loadTicketQueries on the build side.
  async function loadServiceJobs() {
    var c = db();
    if (!c) return;
    try {
      var res = await c.from('service_jobs').select('*').order('created_at', { ascending: false }).limit(500);
      if (res.error) throw res.error;
      serviceJobs = res.data || [];
    } catch (e) {
      console.warn('service jobs load failed:', e && e.message);
      serviceJobs = [];
    }
  }

  function subscribeService() {
    var c = db();
    if (!c || serviceChannel) return;      // idempotent: every view may call it
    try {
      serviceChannel = c.channel('service-jobs-all')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_jobs' }, function (payload) {
          var row = payload.new, old = payload.old;
          if (payload.eventType === 'DELETE') {
            serviceJobs = serviceJobs.filter(function (j) { return j.id !== (old && old.id); });
          } else if (row) {
            var i = serviceJobs.findIndex(function (j) { return j.id === row.id; });
            if (i === -1) serviceJobs.unshift(row); else serviceJobs[i] = row;
          }
          renderServiceBoard();
        })
        .subscribe();
    } catch (e) { console.warn('service realtime failed:', e && e.message); }
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function fmtDays(d) {
    if (d < 1) return Math.max(0, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }
    catch (e) { return '—'; }
  }

  function jobCard(job, now) {
    var M = svc();
    var risk = M ? M.serviceRisk(job, now) : 0;
    var idle = M ? M.daysInStage(job, now) : 0;
    var riskCls = risk === 2 ? ' risk-breached' : risk === 1 ? ' risk-soon' : '';
    var kind = (M && M.JOB_KINDS[job.job_kind]) || job.job_kind || 'Service';

    // A promised date is only given AFTER diagnosis, so a blank one is normal
    // early on and must not read as missing data.
    var promise = job.promised_at
      ? 'Promised ' + esc(fmtDate(job.promised_at))
      : (job.stage === 'logged' || job.stage === 'received' || job.stage === 'diagnosing'
          ? '<span class="sv-nopromise">No promise yet</span>'
          : '<span class="sv-nopromise">No date given</span>');

    var waitingFor = (job.waiting_party && (job.stage === 'at_vendor' || job.stage === 'parts_on_order'))
      ? '<div class="sv-card-line"><span class="sv-k">Waiting on</span> ' + esc(job.waiting_party) + '</div>' : '';

    return '' +
      '<div class="sv-card' + riskCls + '" data-job="' + esc(job.id) + '">' +
        '<div class="sv-card-top">' +
          '<span class="sv-cust">' + esc(job.customer_name || '—') + '</span>' +
          '<span class="sv-idle" title="Days in the current stage">' + fmtDays(idle) + '</span>' +
        '</div>' +
        '<div class="sv-card-dev">' + esc(job.device_label || kind) + '</div>' +
        '<div class="sv-card-line"><span class="sv-k">Stage</span> ' + esc(M ? M.staffLabel(job.stage) : job.stage) + '</div>' +
        waitingFor +
        '<div class="sv-card-line"><span class="sv-k">Tech</span> ' + esc(job.assignee || 'Unassigned') + '</div>' +
        '<div class="sv-card-foot">' +
          '<span class="sv-code">' + esc(job.public_code || '') + '</span>' +
          '<span class="sv-promise">' + promise + '</span>' +
        '</div>' +
      '</div>';
  }

  function renderServiceBoard() {
    var host = document.getElementById('sv-board');
    if (!host) return;
    var M = svc();
    if (!M) { host.innerHTML = '<div class="sv-empty">Status model not loaded.</div>'; return; }

    var now = Date.now();
    var qEl = document.getElementById('sv-search');
    var q = ((qEl && qEl.value) || '').toLowerCase().trim();
    var mineEl = document.getElementById('sv-mine');
    var mineOnly = !!(mineEl && mineEl.checked);
    var myEmail = (me() && me().email || '').toLowerCase();

    var rows = serviceJobs.filter(function (j) {
      if (mineOnly && String(j.assignee_email || '').toLowerCase() !== myEmail) return false;
      if (!q) return true;
      return (j.customer_name || '').toLowerCase().indexOf(q) !== -1
          || (j.device_label || '').toLowerCase().indexOf(q) !== -1
          || (j.public_code || '').toLowerCase().indexOf(q) !== -1
          || (j.customer_phone || '').indexOf(q) !== -1
          || (j.assignee || '').toLowerCase().indexOf(q) !== -1;
    });

    // "Closed today" empties overnight — the only feedback loop that makes
    // people actually close jobs rather than leaving them on the board.
    var midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    var mid = midnight.getTime();

    var buckets = {};
    M.COLUMNS.forEach(function (c) { buckets[c.key] = []; });
    rows.forEach(function (j) {
      var col = M.boardColumnOf(j);
      if (col === 'closed') {
        var ct = j.closed_at ? new Date(j.closed_at).getTime() : 0;
        if (!(ct >= mid)) return;            // closed before today — off the board
      }
      buckets[col].push(j);
    });

    // Intake oldest first (the thing rotting longest is the thing to act on);
    // the chase list by days out descending; everything else newest first.
    buckets.intake.sort(function (a, b) { return new Date(a.stage_since) - new Date(b.stage_since); });
    buckets.third.sort(function (a, b) { return new Date(a.stage_since) - new Date(b.stage_since); });

    host.innerHTML = M.COLUMNS.map(function (c) {
      var list = buckets[c.key];
      var breached = list.filter(function (j) { return M.serviceRisk(j, now) === 2; }).length;
      return '<div class="sv-col sv-col-' + c.key + '">' +
        '<div class="sv-col-head">' +
          '<span class="sv-col-name">' + esc(c.label) + '</span>' +
          '<span class="sv-col-count' + (breached ? ' has-breach' : '') + '">' + list.length + '</span>' +
        '</div>' +
        '<div class="sv-col-hint">' + esc(c.hint) + '</div>' +
        '<div class="sv-cards">' +
          (list.length ? list.map(function (j) { return jobCard(j, now); }).join('')
                       : '<div class="sv-empty">Nothing here</div>') +
        '</div>' +
      '</div>';
    }).join('');

    var stat = document.getElementById('sv-stat');
    if (stat) {
      var open = rows.filter(function (j) { return j.stage !== 'closed'; });
      var atRisk = open.filter(function (j) { return M.serviceRisk(j, now) === 2; }).length;
      stat.textContent = open.length + ' open · ' + atRisk + ' overdue';
      stat.classList.toggle('has-breach', atRisk > 0);
    }
  }

  // ── intake ─────────────────────────────────────────────────────────────────
  function openIntake() {
    var M = svc();
    var sel = document.getElementById('sv-in-kind');
    if (sel && !sel.dataset.filled) {
      sel.dataset.filled = '1';
      sel.innerHTML = Object.keys(M.JOB_KINDS).map(function (k) {
        return '<option value="' + k + '">' + esc(M.JOB_KINDS[k]) + '</option>';
      }).join('');
      sel.value = 'repair_outside';
    }
    ['sv-in-name','sv-in-phone','sv-in-email','sv-in-device','sv-in-serial','sv-in-fault','sv-in-accessories','sv-in-condition']
      .forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
    ['sv-in-powers','sv-in-hasdata'].forEach(function (id) { var el = document.getElementById(id); if (el) el.checked = false; });
    var link = document.getElementById('sv-in-build');
    if (link) link.value = '';
    syncIntakeKind();
    var st = document.getElementById('sv-in-status'); if (st) { st.textContent = ''; st.className = 'sv-status'; }
    document.getElementById('sv-intake-modal').classList.add('active');
    setTimeout(function () { var n = document.getElementById('sv-in-name'); if (n) n.focus(); }, 120);
  }

  // An outside machine needs a real intake record — it is the shop's protection
  // against "it wasn't scratched when I brought it in". A PC we built does not:
  // its serials, specs and QC baseline are already on file.
  function syncIntakeKind() {
    var kind = (document.getElementById('sv-in-kind') || {}).value || 'repair_outside';
    var outside = document.getElementById('sv-in-outside');
    var buildRow = document.getElementById('sv-in-buildrow');
    if (outside) outside.classList.toggle('hidden', kind === 'repair_own');
    if (buildRow) buildRow.classList.toggle('hidden', kind !== 'repair_own');
  }

  async function createServiceJob() {
    var btn = document.getElementById('sv-in-create');
    var st = document.getElementById('sv-in-status');
    var setStatus = function (msg, cls) { if (st) { st.textContent = msg; st.className = 'sv-status' + (cls ? ' ' + cls : ''); } };

    var v = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    var ck = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };

    var name = v('sv-in-name'), phone = v('sv-in-phone'), fault = v('sv-in-fault');
    var kind = v('sv-in-kind') || 'repair_outside';

    // Three required fields and no more. Someone is standing at the counter
    // with a broken machine; everything else can be filled in later.
    if (!name) return setStatus('Enter the customer’s name.', 'err');
    if (!/^[0-9+\-\s()]{7,}$/.test(phone)) return setStatus('Enter a contact phone number.', 'err');
    if (!fault) return setStatus('Describe the reported fault — even one line.', 'err');

    var c = db();
    if (!c) return setStatus('Not connected to the cloud. Try again once you are online.', 'err');

    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    setStatus('Creating the job…', '');

    try {
      var code = newPublicCode();
      var id = newJobId();
      var iso = nowIso();
      var buildId = kind === 'repair_own' ? (v('sv-in-build') || null) : null;

      var row = {
        id: id,
        public_code: code,
        created_at: iso,
        updated_at: iso,
        job_kind: kind,
        origin: 'counter',
        // Logged at the counter means it IS in hand, so the honest starting
        // stage is `received`. `logged` is for a request raised on the website
        // before the machine arrives (phase 3).
        stage: 'received',
        stage_since: iso,
        received_at: iso,
        customer_name: name,
        customer_phone: phone,
        customer_email: v('sv-in-email') || null,
        device_label: v('sv-in-device') || null,
        device_serial: v('sv-in-serial') || null,
        reported_fault: fault,
        has_customer_data: ck('sv-in-hasdata'),
        build_ticket_id: buildId,
        // promised_at is deliberately NOT set here. A date is only given after
        // diagnosis, so the board shows "No promise yet" rather than a blank.
        intake: kind === 'repair_own' ? {} : {
          accessories: v('sv-in-accessories') || '',
          condition: v('sv-in-condition') || '',
          powers_on_at_counter: ck('sv-in-powers'),
          taken_by: (me() && me().full_name) || '',
          taken_at: iso
        },
        details: {},
        subject: {}
      };

      var ins = await c.from('service_jobs').insert(row);
      if (ins.error) throw ins.error;

      // History is append-only, so two machines offline at once merge as a
      // union instead of one overwriting the other.
      await c.from('service_events').insert({
        job_id: id, kind: 'stage', actor_kind: 'staff',
        actor_email: (me() && me().email) || null,
        actor_name: (me() && me().full_name) || null,
        to_stage: 'received', body: 'Received at counter. Reported fault: ' + fault,
        customer_visible: true, client_at: iso
      }).then(function (r) { if (r.error) console.warn('service event insert failed:', r.error.message); });

      if (!serviceJobs.some(function (j) { return j.id === id; })) serviceJobs.unshift(row);
      renderServiceBoard();

      setStatus('Job created. Customer tracking code: ' + code, 'ok');
      if (btn) btn.textContent = 'Created ' + code;
      toast('Service job ' + code + ' created.', 'success');
      // Left disabled: a second click would create a duplicate job.
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Create job'; }
      setStatus('Could not create the job: ' + (e && e.message ? e.message : 'unknown error'), 'err');
    }
  }

  // ── job panel ──────────────────────────────────────────────────────────────
  async function openJob(jobId) {
    var job = serviceJobs.find(function (j) { return j.id === jobId; });
    if (!job) return;
    openJobId = jobId;
    var M = svc();
    var now = Date.now();

    document.getElementById('sv-job-title').textContent = job.customer_name || '—';
    document.getElementById('sv-job-sub').textContent =
      (M.JOB_KINDS[job.job_kind] || job.job_kind) + ' · ' + (job.public_code || '');

    var risk = M.serviceRisk(job, now);
    var ball = M.ballOf(job.stage);
    document.getElementById('sv-job-ball').innerHTML =
      '<span class="sv-ball sv-ball-' + ball + '">' + esc(M.waitingSentence(job)) + '</span>' +
      '<span class="sv-job-idle' + (risk === 2 ? ' breach' : risk === 1 ? ' soon' : '') + '">' +
        fmtDays(M.daysInStage(job, now)) + ' in this stage</span>';

    var rows = [
      ['Phone', job.customer_phone],
      ['Email', job.customer_email],
      ['Device', job.device_label],
      ['Serial', job.device_serial],
      ['Reported fault', job.reported_fault],
      ['Diagnosis', job.diagnosis],
      ['Promised', job.promised_at ? fmtDate(job.promised_at) : 'Not given yet — set it when diagnosis is done'],
      ['Technician', job.assignee]
    ];
    if (job.build_ticket_id) rows.push(['Built by us', 'Ticket #' + String(job.build_ticket_id).slice(-6).toUpperCase()]);
    var ik = job.intake || {};
    if (ik.accessories) rows.push(['Came in with', ik.accessories]);
    if (ik.condition) rows.push(['Condition at intake', ik.condition]);
    if (ik.taken_by) rows.push(['Taken in by', ik.taken_by]);
    if (job.has_customer_data) rows.push(['Customer data', 'Yes — back up before working']);

    document.getElementById('sv-job-fields').innerHTML = rows.map(function (r) {
      return '<div class="sv-f"><span class="sv-f-k">' + esc(r[0]) + '</span><span class="sv-f-v">' + esc(r[1] || '—') + '</span></div>';
    }).join('');

    // Only legal moves for this job kind, so an impossible transition cannot be
    // recorded in the first place.
    var next = M.nextStages(job.job_kind, job.stage);
    document.getElementById('sv-job-moves').innerHTML =
      '<div class="sv-moves-label">Move to</div>' +
      next.map(function (s) {
        return '<button type="button" class="sv-move" data-stage="' + esc(s) + '">' + esc(M.staffLabel(s)) + '</button>';
      }).join('');

    document.getElementById('sv-job-timeline').innerHTML = '<div class="sv-empty">Loading history…</div>';
    document.getElementById('sv-job-modal').classList.add('active');
    loadTimeline(jobId);
  }

  async function loadTimeline(jobId) {
    var host = document.getElementById('sv-job-timeline');
    var c = db();
    if (!c || !host) return;
    try {
      var r = await c.from('service_events').select('*').eq('job_id', jobId).order('at', { ascending: false }).limit(100);
      if (r.error) throw r.error;
      var list = r.data || [];
      host.innerHTML = list.length ? list.map(function (e) {
        var when = new Date(e.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return '<div class="sv-ev' + (e.customer_visible ? ' shown' : '') + '">' +
          '<div class="sv-ev-top"><span class="sv-ev-when">' + esc(when) + '</span>' +
          '<span class="sv-ev-who">' + esc(e.actor_name || e.actor_email || 'system') + '</span></div>' +
          '<div class="sv-ev-body">' + esc(e.body || (e.to_stage ? 'Moved to ' + e.to_stage : '')) + '</div>' +
          (e.customer_visible ? '<div class="sv-ev-tag">Customer can see this</div>' : '') +
        '</div>';
      }).join('') : '<div class="sv-empty">No history yet.</div>';
    } catch (e) {
      host.innerHTML = '<div class="sv-empty">Could not load history.</div>';
    }
  }

  async function moveStage(jobId, toStage) {
    var job = serviceJobs.find(function (j) { return j.id === jobId; });
    var M = svc();
    if (!job || !M) return;
    var c = db();
    if (!c) return toast('Not connected — cannot change stage while offline.', 'warning');

    var note = window.prompt('Add a note for this change (optional).\n\nMoving to: ' + M.staffLabel(toStage), '');
    if (note === null) return;                       // cancelled

    var extra = {};
    // A vendor or supplier name is the whole point of the chase list, so ask
    // for it exactly when it becomes true rather than burying it in a form.
    if (toStage === 'at_vendor' || toStage === 'parts_on_order') {
      var who = window.prompt('Who are we waiting on? (vendor or supplier name)', job.waiting_party || '');
      if (who === null) return;
      extra.waiting_party = who.trim() || null;
    }
    // A promised date is only meaningful once we know what is wrong.
    if (toStage === 'quoted' || toStage === 'approved' || toStage === 'in_service') {
      if (!job.promised_at) {
        var d = window.prompt('Promised date for the customer (YYYY-MM-DD), or leave blank if still unknown.', '');
        if (d === null) return;
        if (d.trim()) {
          var parsed = new Date(d.trim() + 'T18:00:00');
          if (!isNaN(parsed.getTime())) extra.promised_at = parsed.toISOString();
        }
      }
    }
    if (toStage === 'ready') {
      var outcome = window.prompt(
        'Outcome? Type one of:\n' + Object.keys(M.OUTCOMES).join(', '), 'repaired');
      if (outcome === null) return;
      outcome = (outcome || '').trim();
      if (!M.OUTCOMES[outcome]) return toast('Unknown outcome — nothing changed.', 'warning');
      extra.outcome = outcome;
      extra.ready_at = nowIso();
    }
    if (toStage === 'closed') {
      extra.closed_at = nowIso();
      extra.closed_by = (me() && me().email) || null;
    }

    var iso = nowIso();
    var patch = Object.assign({ stage: toStage, stage_since: iso, updated_at: iso }, extra);

    try {
      var up = await c.from('service_jobs').update(patch).eq('id', jobId);
      if (up.error) throw up.error;

      await c.from('service_events').insert({
        job_id: jobId, kind: 'stage', actor_kind: 'staff',
        actor_email: (me() && me().email) || null,
        actor_name: (me() && me().full_name) || null,
        from_stage: job.stage, to_stage: toStage,
        body: note.trim() || null,
        // Staff notes are internal unless someone ticks the box. A stage change
        // itself is safe to show — it is what the customer is asking about.
        customer_visible: true, client_at: iso
      }).then(function (r) { if (r.error) console.warn('service event insert failed:', r.error.message); });

      Object.assign(job, patch);
      renderServiceBoard();
      openJob(jobId);
      toast('Moved to ' + M.staffLabel(toStage) + '.', 'success');
    } catch (e) {
      toast('Could not change stage: ' + (e && e.message ? e.message : 'unknown error'), 'error');
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  function initServiceUI() {
    var board = document.getElementById('sv-board');
    if (board && !board.dataset.bound) {
      board.dataset.bound = '1';
      board.addEventListener('click', function (e) {
        var card = e.target.closest('.sv-card');
        if (card && card.dataset.job) openJob(card.dataset.job);
      });
    }
    var bind = function (id, ev, fn) {
      var el = document.getElementById(id);
      if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener(ev, fn); }
    };
    bind('sv-search', 'input', renderServiceBoard);
    bind('sv-mine', 'change', renderServiceBoard);
    bind('sv-new', 'click', openIntake);
    bind('sv-in-kind', 'change', syncIntakeKind);
    bind('sv-in-create', 'click', createServiceJob);
    bind('sv-in-close', 'click', function () { document.getElementById('sv-intake-modal').classList.remove('active'); });
    bind('sv-in-cancel', 'click', function () { document.getElementById('sv-intake-modal').classList.remove('active'); });
    bind('sv-job-close', 'click', function () { document.getElementById('sv-job-modal').classList.remove('active'); openJobId = null; });
    bind('sv-exit', 'click', function () { if (typeof switchScreen === 'function') switchScreen('staff'); });

    var moves = document.getElementById('sv-job-moves');
    if (moves && !moves.dataset.bound) {
      moves.dataset.bound = '1';
      moves.addEventListener('click', function (e) {
        var b = e.target.closest('.sv-move');
        if (b && openJobId) moveStage(openJobId, b.dataset.stage);
      });
    }

    // The intake form must never be savable by a barcode scanner either: the
    // serial field is exactly where a scanner gets used, and its Enter would
    // otherwise activate the default button.
    var intake = document.getElementById('sv-intake-form');
    if (intake && !intake.dataset.bound) {
      intake.dataset.bound = '1';
      intake.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var t = e.target;
        if (!t || !t.tagName) return;
        var tag = t.tagName.toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
        e.preventDefault();
      });
    }
  }

  async function ensureServiceLoaded(opts) {
    var silent = opts && opts.silent;
    if (!silent) initServiceUI();
    if (!serviceLoaded) {
      serviceLoaded = true;
      await loadServiceJobs();
      subscribeService();
      // Ageing changes with the clock, not with events. A board that redraws
      // only on realtime would sit at "3 days" all afternoon and under-report
      // every breach.
      clearInterval(boardTimer);
      boardTimer = setInterval(function () {
        if (document.getElementById('service-screen').classList.contains('active')) renderServiceBoard();
      }, 60000);
    } else {
      await loadServiceJobs();
    }
    if (!silent) renderServiceBoard();
  }

  window.NeoQcServiceUI = {
    ensureServiceLoaded: ensureServiceLoaded,
    // The Overview reads the same cache rather than querying again, so the two
    // screens can never disagree about what is open.
    jobs: function () { return serviceJobs; },
    openJob: openJob,
    renderServiceBoard: renderServiceBoard,
    openIntake: openIntake,
    // exposed for tests
    _newPublicCode: newPublicCode
  };
})();
