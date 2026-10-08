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
    var st = document.getElementById('sv-in-status');
    if (st) { st.textContent = ''; st.className = 'sv-status'; }
    // The counter takes in one customer after another. The create button is left
    // disabled after a success so a double-click cannot make a duplicate — which
    // meant exactly ONE job could be created per app session, because nothing
    // ever re-enabled it. Reset it every time the form is opened.
    var cb = document.getElementById('sv-in-create');
    if (cb) { cb.disabled = false; cb.textContent = 'Create job'; }
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
  //  Four tabs over one job: Details (editable), Notes, Photos, History.
  //
  //  THE RULE THIS FILE LIVES BY: every async handler binds `var jobId =
  //  openJobId` on its FIRST line and never touches openJobId again. The panel
  //  can be closed or pointed at a different customer while a request is in
  //  flight, and a review found three separate ways that lost or misfiled data
  //  — photos landing in another customer's job, and one customer's stage change
  //  published on another customer's public tracking page. Reading module state
  //  after an await is how that happens.

  var openJobId = null;
  var staffCache = null;          // active profiles + whoever is currently assigned
  var jobTab = 'details';
  var mediaCache = {};            // jobId -> rows
  var formBase = null;            // the values the Details form was painted FROM
  var uploadBusy = false;

  async function loadStaff() {
    if (staffCache) return staffCache;
    var c = db();
    if (!c) return [];
    try {
      // Everyone active, not a designation filter: this roster spreads service
      // work across Service Engineer, Senior System Integrator, Technical
      // Support Lead, the Service Department Head and the RMA Lead, and a
      // keyword match on job titles would quietly drop somebody.
      var r = await c.from('profiles').select('email, full_name, designation, active, tier')
                     .order('full_name');
      if (r.error) throw r.error;
      staffCache = (r.data || []).filter(function (p) { return p.full_name; });
    } catch (e) { staffCache = []; }
    return staffCache;
  }

  function jobById(id) { return serviceJobs.find(function (j) { return j.id === id; }); }

  function fmtDateInput(iso) {
    if (!iso) return '';
    try {
      // Local calendar day, not UTC: toISOString() on an 18:00 IST timestamp
      // rolls back a day for anyone west of the date line and makes every save
      // look like the promise moved.
      var d = new Date(iso);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
             '-' + String(d.getDate()).padStart(2, '0');
    } catch (e) { return ''; }
  }
  function dayToIso(day) {
    if (!day) return null;
    var d = new Date(day + 'T18:00:00');     // end of the working day, local
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  async function openJob(jobId) {
    var job = jobById(jobId);
    if (!job) return;
    openJobId = jobId;
    jobTab = 'details';                       // a new job always opens on Details
    await loadStaff();
    if (openJobId !== jobId) return;          // they moved on while staff loaded
    paintJob();
    document.getElementById('sv-job-modal').classList.add('active');
  }

  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t == null ? '' : t; }

  function paintJob() {
    var job = jobById(openJobId);
    var M = svc();
    if (!job || !M) return;
    var now = Date.now();

    setText('sv-job-title', job.customer_name || '—');
    setText('sv-job-sub', (M.JOB_KINDS[job.job_kind] || job.job_kind) + ' · ' + (job.public_code || ''));

    var risk = M.serviceRisk(job, now);
    var ball = M.ballOf(job.stage);
    var head = document.getElementById('sv-job-ball');
    if (head) {
      head.innerHTML =
        '<span class="sv-ball sv-ball-' + ball + '">' + esc(M.waitingSentence(job)) + '</span>' +
        '<span class="sv-job-idle' + (risk === 2 ? ' breach' : risk === 1 ? ' soon' : '') + '">' +
          fmtDays(M.daysInStage(job, now)) + ' in this stage</span>';
    }

    document.querySelectorAll('#sv-job-tabs .sv-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === jobTab);
    });

    var body = document.getElementById('sv-job-body');
    if (!body) return;
    if (jobTab === 'details') body.innerHTML = detailsHtml(job, M);
    else if (jobTab === 'notes') { body.innerHTML = notesHtml(); loadTimeline(openJobId); }
    else if (jobTab === 'photos') { body.innerHTML = photosHtml(); loadMedia(openJobId); }
    else { body.innerHTML = '<div id="sv-job-timeline" class="sv-timeline"></div>'; loadTimeline(openJobId); }
  }

  // Repaint only the header. Used after a write so the ball/idle line is current
  // WITHOUT destroying anything the user has typed and not yet saved — a full
  // repaint used to discard a half-written move note and unsaved field edits.
  function paintJobHeader() {
    var job = jobById(openJobId), M = svc();
    if (!job || !M) return;
    var now = Date.now();
    var ball = M.ballOf(job.stage);
    var risk = M.serviceRisk(job, now);
    var head = document.getElementById('sv-job-ball');
    if (head) {
      head.innerHTML =
        '<span class="sv-ball sv-ball-' + ball + '">' + esc(M.waitingSentence(job)) + '</span>' +
        '<span class="sv-job-idle' + (risk === 2 ? ' breach' : risk === 1 ? ' soon' : '') + '">' +
          fmtDays(M.daysInStage(job, now)) + ' in this stage</span>';
    }
    setText('sv-job-title', job.customer_name || '—');
    setText('sv-job-sub', (M.JOB_KINDS[job.job_kind] || job.job_kind) + ' · ' + (job.public_code || ''));
  }

  function field(label, id, value, opts) {
    opts = opts || {};
    var cls = opts.wide ? 'sv-field sv-span2' : 'sv-field';
    if (opts.textarea) {
      return '<label class="' + cls + '"><span>' + esc(label) + '</span>' +
             '<textarea id="' + id + '" rows="' + (opts.rows || 2) + '"' +
             (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>' +
             esc(value || '') + '</textarea></label>';
    }
    return '<label class="' + cls + '"><span>' + esc(label) + '</span>' +
           '<input type="' + (opts.type || 'text') + '" id="' + id + '" value="' + esc(value || '') + '"' +
           (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
           ' autocomplete="off" spellcheck="false"></label>';
  }

  // The eleven editable columns, in one place, so the form, the baseline and the
  // diff cannot drift apart.
  var EDIT_FIELDS = [
    ['customer_name',  'sv-e-name'],
    ['customer_phone', 'sv-e-phone'],
    ['customer_email', 'sv-e-email'],
    ['device_label',   'sv-e-device'],
    ['device_serial',  'sv-e-serial'],
    ['reported_fault', 'sv-e-fault'],
    ['diagnosis',      'sv-e-diagnosis'],
    ['work_done',      'sv-e-work']
  ];

  function detailsHtml(job, M) {
    var staff = (staffCache || []).slice();
    // Keep whoever is currently assigned in the list even if they have since
    // been deactivated. Otherwise the select has nothing to select, falls back
    // to "Unassigned", and the next save silently unassigns a live job.
    var active = staff.filter(function (p) { return p.active !== false; });
    if (job.assignee_email && !active.some(function (p) { return p.email === job.assignee_email; })) {
      var gone = staff.find(function (p) { return p.email === job.assignee_email; });
      active.unshift({ email: job.assignee_email,
                       full_name: (gone && gone.full_name) || job.assignee || job.assignee_email,
                       designation: 'no longer active' });
    }
    var assigneeOpts = '<option value="">— Unassigned —</option>' + active.map(function (p) {
      var sel = (p.email === job.assignee_email) ? ' selected' : '';
      return '<option value="' + esc(p.email) + '"' + sel + '>' + esc(p.full_name) +
             (p.designation ? ' · ' + esc(p.designation) : '') + '</option>';
    }).join('');

    var moves = M.nextStages(job.job_kind, job.stage);
    var moveOpts = '<option value="">— Move to —</option>' +
      moves.map(function (s) { return '<option value="' + esc(s) + '">' + esc(M.staffLabel(s)) + '</option>'; }).join('');

    var linked = job.build_ticket_id
      ? '<div class="sv-linked">Built by us — ticket #' + esc(String(job.build_ticket_id).slice(-6).toUpperCase()) +
        ' <button type="button" class="sv-linkbtn" id="sv-open-build">Open the build</button></div>'
      : '';

    // Snapshot exactly what the form is being painted from. saveDetails diffs
    // against this and sends ONLY what the user actually changed, so two people
    // editing different fields of the same job no longer overwrite each other.
    formBase = { id: job.id };
    EDIT_FIELDS.forEach(function (f) { formBase[f[0]] = job[f[0]] || ''; });
    formBase.assignee_email = job.assignee_email || '';
    formBase.promised_day = fmtDateInput(job.promised_at);
    formBase.has_customer_data = !!job.has_customer_data;

    return '' +
      linked +
      '<div class="sv-grid">' +
        field('Customer name', 'sv-e-name', job.customer_name) +
        field('Phone', 'sv-e-phone', job.customer_phone) +
        field('Email', 'sv-e-email', job.customer_email) +
        field('Device', 'sv-e-device', job.device_label) +
        field('Serial / service tag', 'sv-e-serial', job.device_serial) +
        '<label class="sv-field"><span>Assigned to</span><select id="sv-e-assignee" class="settings-select">' + assigneeOpts + '</select></label>' +
        field('Promised date', 'sv-e-promised', formBase.promised_day, { type: 'date' }) +
        field('Reported fault', 'sv-e-fault', job.reported_fault, { textarea: true, wide: true }) +
        field('Diagnosis (internal)', 'sv-e-diagnosis', job.diagnosis, { textarea: true, wide: true,
              placeholder: 'What is actually wrong. Stays internal unless you share it as a note.' }) +
        field('Work done', 'sv-e-work', job.work_done, { textarea: true, wide: true }) +
      '</div>' +
      '<label class="sv-check"><input type="checkbox" id="sv-e-hasdata"' + (job.has_customer_data ? ' checked' : '') +
        '> Customer data on board — back up before working</label>' +
      '<div class="sv-actions">' +
        '<button type="button" id="sv-e-save" class="primary-pink-btn">Save changes</button>' +
        '<span id="sv-e-status" class="sv-status"></span>' +
      '</div>' +
      '<div class="sv-movebox">' +
        '<div class="sv-moves-label">Move this job on</div>' +
        '<div class="sv-move-row">' +
          '<select id="sv-m-stage" class="settings-select">' + moveOpts + '</select>' +
          '<button type="button" id="sv-m-go" class="secondary-btn" disabled>Move</button>' +
        '</div>' +
        '<div id="sv-m-extra" class="sv-m-extra"></div>' +
        '<textarea id="sv-m-note" rows="2" placeholder="What happened? Write it for the customer."></textarea>' +
        '<label class="sv-check"><input type="checkbox" id="sv-m-visible" checked> The customer can read this note</label>' +
        '<div id="sv-m-status" class="sv-status"></div>' +
      '</div>';
  }

  function moveExtras(job, toStage, M) {
    var out = '';
    if (toStage === 'at_vendor' || toStage === 'parts_on_order') {
      out += field(toStage === 'at_vendor' ? 'Which vendor?' : 'Which supplier?',
                   'sv-m-party', job.waiting_party, { wide: true, placeholder: 'e.g. ASUS, Prime ABGB' });
      out += field('Expected back (optional)', 'sv-m-expected', '', { type: 'date', wide: true });
    }
    // closed as well as ready: a job can legitimately be closed straight from
    // diagnosing (customer declines, no fault found), and without an outcome the
    // customer's page renders the bare word "Closed", which the status model
    // explicitly says must never happen.
    if (toStage === 'ready' || toStage === 'closed') {
      var opts = '<option value="">— What happened? —</option>' + Object.keys(M.OUTCOMES).map(function (k) {
        return '<option value="' + k + '">' + esc(M.OUTCOMES[k]) + '</option>';
      }).join('');
      out += '<label class="sv-field sv-span2"><span>Outcome</span>' +
             '<select id="sv-m-outcome" class="settings-select">' + opts + '</select></label>';
    }
    if ((toStage === 'quoted' || toStage === 'approved' || toStage === 'in_service') && !job.promised_at) {
      out += field('Promise a date now (optional)', 'sv-m-promised', '', { type: 'date', wide: true });
    }
    return out ? '<div class="sv-grid">' + out + '</div>' : '';
  }

  function notesHtml() {
    return '' +
      '<div class="sv-noteadd">' +
        '<textarea id="sv-n-body" rows="3" placeholder="What did you find? What did you do?"></textarea>' +
        '<label class="sv-check"><input type="checkbox" id="sv-n-visible"> The customer can see this note</label>' +
        '<div class="sv-actions">' +
          '<button type="button" id="sv-n-add" class="primary-pink-btn">Add note</button>' +
          '<span id="sv-n-status" class="sv-status"></span>' +
        '</div>' +
        '<p class="sv-hint">Notes are internal by default. Tick the box for anything the customer should read on their tracking page — findings, decisions, anything that explains a delay.</p>' +
      '</div>' +
      '<div id="sv-job-timeline" class="sv-timeline"></div>';
  }

  function photosHtml() {
    return '' +
      '<div class="sv-photoadd">' +
        '<input type="file" id="sv-p-input" accept="image/jpeg,image/png,image/webp,image/heic" multiple hidden>' +
        '<div class="sv-actions">' +
          '<button type="button" id="sv-p-pick" class="secondary-btn">Add photos</button>' +
          '<select id="sv-p-phase" class="settings-select">' +
            '<option value="intake">At intake</option>' +
            '<option value="during">During the work</option>' +
            '<option value="after">After the work</option>' +
          '</select>' +
          '<span id="sv-p-status" class="sv-status"></span>' +
        '</div>' +
        '<p class="sv-hint">JPEG, PNG, WebP or HEIC, up to 15 MB each. Stored privately, never public. Intake photos are what settle “it wasn’t scratched when I brought it in”.</p>' +
      '</div>' +
      '<div id="sv-p-grid" class="sv-pgrid"></div>';
  }

  // ── reads ──
  // Both take the job id they were called for and refuse to paint if the panel
  // has since moved on, so a slow response never writes job A's data into the
  // panel showing job B.
  async function loadTimeline(jobId) {
    var host = document.getElementById('sv-job-timeline');
    var c = db();
    if (!c || !host) return;
    host.innerHTML = '<div class="sv-empty">Loading…</div>';
    try {
      var r = await c.from('service_events').select('*').eq('job_id', jobId)
                     .order('at', { ascending: false }).limit(200);
      if (r.error) throw r.error;
      if (openJobId !== jobId) return;
      host = document.getElementById('sv-job-timeline');
      if (!host) return;
      var list = r.data || [];
      host.innerHTML = list.length ? list.map(function (e) {
        var when = new Date(e.at).toLocaleString('en-IN',
          { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        var moved = e.from_stage && e.to_stage;
        return '<div class="sv-ev' + (e.customer_visible ? ' shown' : '') + '">' +
          '<div class="sv-ev-top"><span class="sv-ev-when">' + esc(when) + '</span>' +
          '<span class="sv-ev-who">' + esc(e.actor_name || e.actor_email || 'system') + '</span></div>' +
          (moved ? '<div class="sv-ev-move">' + esc(e.from_stage) + ' → ' + esc(e.to_stage) + '</div>' : '') +
          (e.body ? '<div class="sv-ev-body">' + esc(e.body) + '</div>' : '') +
          '<div class="sv-ev-tag">' + (e.customer_visible ? 'Customer can see this' : 'Internal only') + '</div>' +
        '</div>';
      }).join('') : '<div class="sv-empty">No history yet.</div>';
    } catch (e) {
      if (openJobId === jobId && host) host.innerHTML = '<div class="sv-empty">Could not load history.</div>';
    }
  }

  async function loadMedia(jobId) {
    var grid = document.getElementById('sv-p-grid');
    var c = db();
    if (!c || !grid) return;
    grid.innerHTML = '<div class="sv-empty">Loading…</div>';
    try {
      var r = await c.from('service_media').select('*').eq('job_id', jobId)
                     .order('created_at', { ascending: false });
      if (r.error) throw r.error;
      if (openJobId !== jobId) return;
      var rows = r.data || [];
      mediaCache[jobId] = rows;
      grid = document.getElementById('sv-p-grid');
      if (!grid) return;
      if (!rows.length) { grid.innerHTML = '<div class="sv-empty">No photos yet.</div>'; return; }

      // The bucket is private, so each thumbnail needs a signed URL. Pair them
      // BY PATH, not by array index: the API is not contracted to preserve
      // order, and an index mismatch would show every photo under somebody
      // else's caption and visibility checkbox.
      var urls = {};
      try {
        var signed = await c.storage.from('service-media')
                            .createSignedUrls(rows.map(function (x) { return x.path; }), 900);
        if (openJobId !== jobId) return;
        (signed.data || []).forEach(function (s) {
          var p = s && (s.path || s.signedURL || s.signedUrl);
          if (s && s.path) urls[s.path] = s.signedUrl || s.signedURL;
        });
        // Fall back to positional pairing only if the API returned no paths.
        if (!Object.keys(urls).length) {
          (signed.data || []).forEach(function (s, i) {
            if (rows[i]) urls[rows[i].path] = s.signedUrl || s.signedURL;
          });
        }
      } catch (e) { /* thumbnails are a nicety; the list still renders */ }

      grid = document.getElementById('sv-p-grid');
      if (!grid || openJobId !== jobId) return;
      grid.innerHTML = rows.map(function (m) {
        var u = urls[m.path];
        return '<figure class="sv-ph' + (m.customer_visible ? ' shown' : '') + '" data-media="' + esc(m.id) + '">' +
          (u ? '<img src="' + esc(u) + '" alt="" loading="lazy">' : '<div class="sv-ph-miss">no preview</div>') +
          '<figcaption>' +
            '<span class="sv-ph-phase">' + esc(m.phase) + '</span>' +
            '<label class="sv-ph-vis"><input type="checkbox" class="sv-ph-cv"' +
              (m.customer_visible ? ' checked' : '') + '> show customer</label>' +
            '<button type="button" class="sv-ph-del" title="Delete">✕</button>' +
          '</figcaption>' +
        '</figure>';
      }).join('');
    } catch (e) {
      if (openJobId === jobId) {
        var g2 = document.getElementById('sv-p-grid');
        if (g2) g2.innerHTML = '<div class="sv-empty">Could not load photos.</div>';
      }
    }
  }

  // ── writes ──
  // logEvent THROWS on failure. It used to swallow the error and only warn to a
  // console nobody has open in a packaged build — so addNote cleared the
  // technician's typed paragraph and told them it had saved.
  async function logEvent(jobId, patch) {
    var c = db();
    if (!c) throw new Error('not connected');
    var r = await c.from('service_events').insert(Object.assign({
      job_id: jobId, actor_kind: 'staff',
      actor_email: (me() && me().email) || null,
      actor_name: (me() && me().full_name) || null,
      client_at: nowIso()
    }, patch));
    if (r.error) throw r.error;
  }

  async function saveDetails() {
    var jobId = openJobId;                       // bound once; see the file header
    var job = jobById(jobId);
    var c = db();
    var base = formBase;
    var st = document.getElementById('sv-e-status');
    var set = function (m, k) {
      var n = document.getElementById('sv-e-status');   // may have been repainted
      if (n) { n.textContent = m; n.className = 'sv-status' + (k ? ' ' + k : ''); }
    };
    if (!job || !c) return set('Not connected.', 'err');
    if (!base || base.id !== jobId) return set('This panel is out of date — reopen the job.', 'err');

    var v = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
    var name = v('sv-e-name'), phone = v('sv-e-phone');
    if (!name) return set('A job needs a customer name.', 'err');
    if (!/^[0-9+\-\s()]{7,}$/.test(phone)) return set('That phone number does not look right.', 'err');

    // DIFF, don't blind-write. Sending all eleven columns on every save meant a
    // one-field edit silently reverted whatever a second technician had changed
    // in the meantime — including the "customer data on board" backup flag.
    var patch = {};
    EDIT_FIELDS.forEach(function (f) {
      var now = v(f[1]);
      if (now !== (base[f[0]] || '')) patch[f[0]] = now || null;
    });
    var assigneeEmail = v('sv-e-assignee');
    if (assigneeEmail !== (base.assignee_email || '')) {
      var who = (staffCache || []).find(function (p) { return p.email === assigneeEmail; });
      patch.assignee_email = assigneeEmail || null;
      patch.assignee = who ? who.full_name : (assigneeEmail ? job.assignee : null);
    }
    var day = v('sv-e-promised');
    if (day !== (base.promised_day || '')) patch.promised_at = dayToIso(day);
    var hasData = !!(document.getElementById('sv-e-hasdata') || {}).checked;
    if (hasData !== !!base.has_customer_data) patch.has_customer_data = hasData;

    if (!Object.keys(patch).length) return set('Nothing to save.', '');
    patch.updated_at = nowIso();

    var btn = document.getElementById('sv-e-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    set('Saving…', '');
    try {
      var r = await c.from('service_jobs').update(patch).eq('id', jobId);
      if (r.error) throw r.error;

      var changed = [];
      if ('assignee_email' in patch) changed.push(patch.assignee ? 'Assigned to ' + patch.assignee : 'Unassigned');
      if ('promised_at' in patch) {
        changed.push(patch.promised_at
          ? 'Promised ' + new Date(patch.promised_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
          : 'Promised date cleared');
      }
      if ('diagnosis' in patch) changed.push('Diagnosis recorded');
      if ('work_done' in patch) changed.push('Work done updated');
      if (changed.length) {
        try { await logEvent(jobId, { kind: 'edit', body: changed.join(' · '), customer_visible: false }); }
        catch (e) { toast('Saved, but the history entry did not record.', 'warning'); }
      }

      var live = jobById(jobId);
      if (live) Object.assign(live, patch);
      if (base.id === jobId) Object.assign(base, {
        assignee_email: patch.assignee_email !== undefined ? (patch.assignee_email || '') : base.assignee_email,
        promised_day: 'promised_at' in patch ? fmtDateInput(patch.promised_at) : base.promised_day,
        has_customer_data: 'has_customer_data' in patch ? patch.has_customer_data : base.has_customer_data
      });
      EDIT_FIELDS.forEach(function (f) { if (f[0] in patch) base[f[0]] = patch[f[0]] || ''; });

      renderServiceBoard();
      if (openJobId === jobId) paintJobHeader();   // header only: keep typed text
      set('Saved.', 'ok');
      toast('Job updated.', 'success');
    } catch (e) {
      set('Could not save: ' + (e && e.message ? e.message : 'unknown error'), 'err');
    } finally {
      var b2 = document.getElementById('sv-e-save');
      if (b2) { b2.disabled = false; b2.textContent = 'Save changes'; }
    }
  }

  async function doMove() {
    var jobId = openJobId;                       // bound once
    var job = jobById(jobId);
    var M = svc();
    var c = db();
    var set = function (m, k) {
      var n = document.getElementById('sv-m-status');
      if (n) { n.textContent = m; n.className = 'sv-status' + (k ? ' ' + k : ''); }
    };
    if (!job || !M || !c) return;

    var toStage = (document.getElementById('sv-m-stage') || {}).value;
    if (!toStage) return;
    var fromStage = job.stage;
    if (toStage === fromStage) {
      return set('This job is already at ' + M.staffLabel(toStage) + ' — somebody else moved it. Reopen it to see where it is.', 'err');
    }
    var note = ((document.getElementById('sv-m-note') || {}).value || '').trim();
    var noteVisible = !!(document.getElementById('sv-m-visible') || {}).checked;
    var v = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };

    var patch = { stage: toStage, stage_since: nowIso(), updated_at: nowIso() };

    if (toStage === 'at_vendor' || toStage === 'parts_on_order') {
      var party = v('sv-m-party');
      if (!party) return set('Say who we are waiting on — that is the whole point of the chase list.', 'err');
      patch.waiting_party = party;
      var exp = v('sv-m-expected');
      patch.next_chase_at = exp ? new Date(exp + 'T10:00:00').toISOString() : null;
    } else if (job.waiting_party || job.next_chase_at) {
      // Leaving a waiting stage: stop naming a supplier who no longer holds
      // anything of ours, and drop the chase date with it.
      patch.waiting_party = null;
      patch.next_chase_at = null;
    }

    if (toStage === 'ready' || toStage === 'closed') {
      var outcome = v('sv-m-outcome');
      if (!outcome) return set('Say what happened — the customer sees this, and “Closed” on its own tells them nothing.', 'err');
      patch.outcome = outcome;
      if (toStage === 'ready') patch.ready_at = nowIso();
    }
    if (toStage === 'closed') {
      patch.closed_at = nowIso();
      patch.closed_by = (me() && me().email) || null;
    }
    // Reopening a job must clear the terminal columns, or it reads as finished
    // and in progress at the same time.
    if (toStage !== 'ready' && toStage !== 'closed') {
      if (job.outcome) patch.outcome = null;
      if (job.ready_at) patch.ready_at = null;
    }
    if (toStage !== 'closed' && (job.closed_at || job.closed_by)) {
      patch.closed_at = null;
      patch.closed_by = null;
    }
    var pr = v('sv-m-promised');
    if (pr) patch.promised_at = dayToIso(pr);

    var btn = document.getElementById('sv-m-go');
    if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
    set('Moving…', '');
    try {
      var r = await c.from('service_jobs').update(patch).eq('id', jobId);
      if (r.error) throw r.error;
      try {
        await logEvent(jobId, {
          kind: 'stage', from_stage: fromStage, to_stage: toStage,
          body: note || null,
          // The MOVE is always the customer's business. The note attached to it
          // is not necessarily — a candid bench remark would otherwise be
          // published verbatim — so it carries its own tick, defaulted on.
          customer_visible: note ? noteVisible : true
        });
      } catch (e) {
        toast('Moved, but the history entry did not save — the customer will not see this change.', 'warning');
      }
      var live = jobById(jobId);
      if (live) Object.assign(live, patch);
      renderServiceBoard();
      if (openJobId === jobId) paintJob();        // the move box must reset
      toast('Moved to ' + M.staffLabel(toStage) + '.', 'success');
    } catch (e) {
      set('Could not move: ' + (e && e.message ? e.message : 'unknown error'), 'err');
      var b3 = document.getElementById('sv-m-go');
      if (b3) { b3.disabled = false; b3.textContent = 'Move'; }
    }
  }

  async function addNote() {
    var jobId = openJobId;                       // bound once
    var set = function (m, k) {
      var n = document.getElementById('sv-n-status');
      if (n) { n.textContent = m; n.className = 'sv-status' + (k ? ' ' + k : ''); }
    };
    var ta = document.getElementById('sv-n-body');
    var body = ((ta || {}).value || '').trim();
    if (!body) return set('Write something first.', 'err');
    if (!db()) return set('Not connected.', 'err');
    var visible = !!(document.getElementById('sv-n-visible') || {}).checked;

    var btn = document.getElementById('sv-n-add');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await logEvent(jobId, { kind: 'note', body: body, customer_visible: visible });
      // Only clear AFTER it is known to have saved. The previous version cleared
      // first and reported success unconditionally, so a failed insert destroyed
      // the only copy of what the technician had written.
      if (openJobId === jobId) {
        var ta2 = document.getElementById('sv-n-body'); if (ta2) ta2.value = '';
        var cb = document.getElementById('sv-n-visible'); if (cb) cb.checked = false;
        set(visible ? 'Added — the customer will see this.' : 'Added as an internal note.', 'ok');
        loadTimeline(jobId);
      }
    } catch (e) {
      set('Could not save that note — it is still here, try again.', 'err');
    } finally {
      var b2 = document.getElementById('sv-n-add');
      if (b2) { b2.disabled = false; b2.textContent = 'Add note'; }
    }
  }

  async function uploadPhotos(files) {
    var jobId = openJobId;                       // bound once — the whole point
    if (!jobId) return;
    if (uploadBusy) { toast('Still uploading the last batch.', 'warning'); return; }
    var c = db();
    var set = function (m, k) {
      var n = document.getElementById('sv-p-status');
      if (n) { n.textContent = m; n.className = 'sv-status' + (k ? ' ' + k : ''); }
    };
    if (!c || !files || !files.length) return;
    var phase = (document.getElementById('sv-p-phase') || {}).value || 'intake';
    var okCount = 0, tooBig = 0, failed = 0;

    uploadBusy = true;
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        set('Uploading ' + (i + 1) + ' of ' + files.length + '…', '');
        try {
          if (f.size > 15 * 1024 * 1024) { tooBig++; continue; }
          var ext = (f.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
          var path = jobId + '/' + Date.now().toString(36) + '-' +
                     Math.random().toString(36).slice(2, 8) + '.' + ext;
          var up = await c.storage.from('service-media').upload(path, f, { upsert: false, contentType: f.type });
          if (up.error) throw up.error;
          var ins = await c.from('service_media').insert({
            job_id: jobId, path: path, phase: phase,
            uploaded_by: (me() && me().email) || null,
            uploaded_name: (me() && me().full_name) || null
          });
          if (ins.error) {
            // Don't leave an orphan in the bucket that no row points at.
            try { await c.storage.from('service-media').remove([path]); } catch (e2) {}
            throw ins.error;
          }
          okCount++;
        } catch (e) { failed++; }
      }
      if (okCount) {
        try {
          await logEvent(jobId, {
            kind: 'media', body: okCount + ' photo' + (okCount === 1 ? '' : 's') + ' added (' + phase + ')',
            customer_visible: false
          });
        } catch (e) { /* the photos are safe; the history line is not worth a failure */ }
      }
      var msg = okCount + ' added';
      if (tooBig) msg += ', ' + tooBig + ' over the 15 MB limit';
      if (failed) msg += ', ' + failed + ' failed';
      set(msg + '.', (tooBig || failed) ? 'err' : 'ok');
      if (openJobId === jobId) loadMedia(jobId);
    } finally {
      uploadBusy = false;
    }
  }

  async function setMediaVisible(mediaId, visible, figure) {
    var c = db(); if (!c) return;
    try {
      var r = await c.from('service_media').update({ customer_visible: visible }).eq('id', mediaId);
      if (r.error) throw r.error;
    } catch (e) {
      // Put the tick back: a checkbox that silently fails is worse than one
      // that refuses, because the operator believes the photo is shared.
      if (figure) {
        var cb = figure.querySelector('.sv-ph-cv');
        if (cb) cb.checked = !visible;
        figure.classList.toggle('shown', !visible);
      }
      toast('Could not change that photo.', 'error');
    }
  }

  async function deleteMedia(mediaId) {
    var jobId = openJobId;
    var c = db(); if (!c) return;
    var rows = mediaCache[jobId] || [];
    var row = rows.find(function (r) { return String(r.id) === String(mediaId); });
    if (!row) return;
    var okToGo = (typeof showConfirm === 'function')
      ? await showConfirm('Delete this photo? Intake photos are the evidence of what condition the machine arrived in — this cannot be undone.',
                          { title: 'Delete photo', okText: 'Delete', danger: true })
      : true;
    if (!okToGo) return;
    try {
      // Row first, then the object. If the object removal fails we are left with
      // an unreferenced file, which costs storage; the other order leaves a row
      // pointing at nothing, which renders as a broken tile forever.
      var del = await c.from('service_media').delete().eq('id', mediaId);
      if (del.error) throw del.error;
      try { await c.storage.from('service-media').remove([row.path]); } catch (e) {}
      try {
        await logEvent(jobId, { kind: 'media', body: 'A photo was deleted (' + (row.phase || 'intake') + ')', customer_visible: false });
      } catch (e) {}
      if (openJobId === jobId) loadMedia(jobId);
    } catch (e) { toast('Could not delete that photo.', 'error'); }
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

    // Tabs.
    var tabs = document.getElementById('sv-job-tabs');
    if (tabs && !tabs.dataset.bound) {
      tabs.dataset.bound = '1';
      tabs.addEventListener('click', function (e) {
        var t = e.target.closest('.sv-tab');
        if (!t || !t.dataset.tab) return;
        jobTab = t.dataset.tab;
        paintJob();
      });
    }

    // One delegated listener for the whole panel body, because its contents are
    // rebuilt on every repaint and per-element bindings would be lost each time.
    var body = document.getElementById('sv-job-body');
    if (body && !body.dataset.bound) {
      body.dataset.bound = '1';

      body.addEventListener('click', function (e) {
        var t = e.target;
        if (t.closest('#sv-e-save')) return saveDetails();
        if (t.closest('#sv-m-go')) return doMove();
        if (t.closest('#sv-n-add')) return addNote();
        if (t.closest('#sv-p-pick')) { var inp = document.getElementById('sv-p-input'); if (inp) inp.click(); return; }
        if (t.closest('#sv-open-build')) {
          var job = jobById(openJobId);
          if (job && job.build_ticket_id && typeof openTicketModal === 'function') {
            document.getElementById('sv-job-modal').classList.remove('active');
            openTicketModal(job.build_ticket_id);
          }
          return;
        }
        var del = t.closest('.sv-ph-del');
        if (del) { var fg = del.closest('.sv-ph'); if (fg) deleteMedia(fg.dataset.media); return; }
      });

      body.addEventListener('change', function (e) {
        var t = e.target;
        if (t.id === 'sv-m-stage') {
          // Ask for the fields that only make sense for the stage being moved
          // TO, at the moment they become true.
          var job = jobById(openJobId), M = svc();
          var extra = document.getElementById('sv-m-extra');
          if (extra && job && M) extra.innerHTML = t.value ? moveExtras(job, t.value, M) : '';
          var go = document.getElementById('sv-m-go');
          if (go) go.disabled = !t.value;
          return;
        }
        if (t.classList.contains('sv-ph-cv')) {
          var fig = t.closest('.sv-ph');
          if (fig) { fig.classList.toggle('shown', t.checked); setMediaVisible(fig.dataset.media, t.checked, fig); }
          return;
        }
        if (t.id === 'sv-p-input' && t.files && t.files.length) {
          var files = Array.prototype.slice.call(t.files);
          t.value = '';                       // allow re-picking the same file
          uploadPhotos(files);
        }
      });

      // A scanner is used on the serial field here too, and its Enter must not
      // reach a button. Textareas keep their newlines.
      body.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var tag = (e.target.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
        e.preventDefault();
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
