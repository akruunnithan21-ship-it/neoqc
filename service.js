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
  //  Four tabs over one job: Details (editable), Notes, Photos, History.
  //  The v1 panel drove every stage change through window.prompt() chains —
  //  three modal prompts to send something to a vendor, no way to correct a
  //  typo, and a cancel halfway through left the job half-moved. All of it is
  //  real UI now, and every write is a column-scoped UPDATE.

  var staffCache = null;          // active profiles, for the assignee picker
  var jobTab = 'details';
  var mediaCache = {};            // jobId -> rows, so switching tabs is instant

  async function loadStaff() {
    if (staffCache) return staffCache;
    var c = db();
    if (!c) return [];
    try {
      // Everyone active, not a designation filter: the roster has service work
      // spread across Service Engineer, Senior System Integrator, Technical
      // Support Lead, the Service Department Head and the RMA Lead, and a
      // keyword match on job titles would quietly drop somebody.
      var r = await c.from('profiles').select('email, full_name, designation, active, tier')
                     .order('full_name');
      if (r.error) throw r.error;
      staffCache = (r.data || []).filter(function (p) { return p.active !== false && p.full_name; });
    } catch (e) { staffCache = []; }
    return staffCache;
  }

  function jobById(id) { return serviceJobs.find(function (j) { return j.id === id; }); }

  function fmtDateInput(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  async function openJob(jobId) {
    var job = jobById(jobId);
    if (!job) return;
    openJobId = jobId;
    jobTab = 'details';
    await loadStaff();
    paintJob();
    document.getElementById('sv-job-modal').classList.add('active');
    loadTimeline(jobId);
  }

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

  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t == null ? '' : t; }

  function field(label, id, value, opts) {
    opts = opts || {};
    var cls = opts.wide ? 'sv-field sv-span2' : 'sv-field';
    if (opts.textarea) {
      return '<label class="' + cls + '"><span>' + esc(label) + '</span>' +
             '<textarea id="' + id + '" rows="' + (opts.rows || 2) + '">' + esc(value || '') + '</textarea></label>';
    }
    return '<label class="' + cls + '"><span>' + esc(label) + '</span>' +
           '<input type="' + (opts.type || 'text') + '" id="' + id + '" value="' + esc(value || '') + '"' +
           (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
           ' autocomplete="off" spellcheck="false"></label>';
  }

  function detailsHtml(job, M) {
    var staff = staffCache || [];
    var assigneeOpts = '<option value="">— Unassigned —</option>' + staff.map(function (p) {
      var sel = (p.email === job.assignee_email) ? ' selected' : '';
      return '<option value="' + esc(p.email) + '"' + sel + '>' + esc(p.full_name) +
             (p.designation ? ' · ' + esc(p.designation) : '') + '</option>';
    }).join('');

    // Only legal moves for this kind, so an impossible transition cannot be
    // recorded in the first place.
    var moves = M.nextStages(job.job_kind, job.stage);
    var moveOpts = '<option value="">— Move to —</option>' +
      moves.map(function (s) { return '<option value="' + esc(s) + '">' + esc(M.staffLabel(s)) + '</option>'; }).join('');

    var linked = job.build_ticket_id
      ? '<div class="sv-linked">Built by us — ticket #' + esc(String(job.build_ticket_id).slice(-6).toUpperCase()) +
        ' <button type="button" class="sv-linkbtn" id="sv-open-build">Open the build</button></div>'
      : '';

    return '' +
      linked +
      '<div class="sv-grid">' +
        field('Customer name', 'sv-e-name', job.customer_name) +
        field('Phone', 'sv-e-phone', job.customer_phone) +
        field('Email', 'sv-e-email', job.customer_email) +
        field('Device', 'sv-e-device', job.device_label) +
        field('Serial / service tag', 'sv-e-serial', job.device_serial) +
        '<label class="sv-field"><span>Assigned to</span><select id="sv-e-assignee" class="settings-select">' + assigneeOpts + '</select></label>' +
        // A date is only given AFTER diagnosis — blank is a legitimate answer
        // early on, and the board says "No promise yet" rather than showing a hole.
        field('Promised date', 'sv-e-promised', fmtDateInput(job.promised_at), { type: 'date' }) +
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
        '<textarea id="sv-m-note" rows="2" placeholder="What happened? (shown to the customer)"></textarea>' +
        '<div id="sv-m-status" class="sv-status"></div>' +
      '</div>';
  }

  // Fields that only make sense for the stage being moved TO, asked for at the
  // moment they become true rather than buried in a form that is mostly blank.
  function moveExtras(job, toStage, M) {
    var out = '';
    if (toStage === 'at_vendor' || toStage === 'parts_on_order') {
      out += field(toStage === 'at_vendor' ? 'Which vendor?' : 'Which supplier?',
                   'sv-m-party', job.waiting_party, { wide: true, placeholder: 'e.g. ASUS, Prime ABGB' });
      out += field('Expected back (optional)', 'sv-m-expected', '', { type: 'date', wide: true });
    }
    if (toStage === 'ready') {
      var opts = Object.keys(M.OUTCOMES).map(function (k) {
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
        '<input type="file" id="sv-p-input" accept="image/*" multiple hidden>' +
        '<div class="sv-actions">' +
          '<button type="button" id="sv-p-pick" class="secondary-btn">Add photos</button>' +
          '<select id="sv-p-phase" class="settings-select">' +
            '<option value="intake">At intake</option>' +
            '<option value="during">During the work</option>' +
            '<option value="after">After the work</option>' +
          '</select>' +
          '<span id="sv-p-status" class="sv-status"></span>' +
        '</div>' +
        '<p class="sv-hint">Photographs are stored privately and are never public. Intake photos are what settle “it wasn’t scratched when I brought it in”.</p>' +
      '</div>' +
      '<div id="sv-p-grid" class="sv-pgrid"></div>';
  }

  // ── reads ──
  async function loadTimeline(jobId) {
    var host = document.getElementById('sv-job-timeline');
    var c = db();
    if (!c || !host) return;
    host.innerHTML = '<div class="sv-empty">Loading…</div>';
    try {
      var r = await c.from('service_events').select('*').eq('job_id', jobId)
                     .order('at', { ascending: false }).limit(200);
      if (r.error) throw r.error;
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
      host.innerHTML = '<div class="sv-empty">Could not load history.</div>';
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
      var rows = r.data || [];
      mediaCache[jobId] = rows;
      if (!rows.length) { grid.innerHTML = '<div class="sv-empty">No photos yet.</div>'; return; }
      // The bucket is private, so every thumbnail needs its own short-lived
      // signed URL. One hour is plenty for someone looking at a job.
      var signed = await c.storage.from('service-media')
                          .createSignedUrls(rows.map(function (x) { return x.path; }), 3600);
      var urls = {};
      (signed.data || []).forEach(function (s, i) { urls[rows[i].path] = s.signedUrl; });
      grid.innerHTML = rows.map(function (m) {
        var u = urls[m.path];
        return '<figure class="sv-ph' + (m.customer_visible ? ' shown' : '') + '" data-media="' + m.id + '">' +
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
      grid.innerHTML = '<div class="sv-empty">Could not load photos.</div>';
    }
  }

  // ── writes ──
  // Every one is a column-scoped UPDATE naming only what changed, plus an
  // append-only event. Nothing here ever reads-modifies-writes a jsonb column.
  async function logEvent(jobId, patch) {
    var c = db();
    if (!c) return;
    try {
      var r = await c.from('service_events').insert(Object.assign({
        job_id: jobId, actor_kind: 'staff',
        actor_email: (me() && me().email) || null,
        actor_name: (me() && me().full_name) || null,
        client_at: nowIso()
      }, patch));
      if (r.error) console.warn('service event insert failed:', r.error.message);
    } catch (e) { console.warn('service event insert threw:', e && e.message); }
  }

  async function saveDetails() {
    var job = jobById(openJobId);
    var c = db();
    var st = document.getElementById('sv-e-status');
    var set = function (m, k) { if (st) { st.textContent = m; st.className = 'sv-status' + (k ? ' ' + k : ''); } };
    if (!job || !c) return set('Not connected.', 'err');

    var v = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
    var name = v('sv-e-name'), phone = v('sv-e-phone');
    if (!name) return set('A job needs a customer name.', 'err');
    if (!/^[0-9+\-\s()]{7,}$/.test(phone)) return set('That phone number does not look right.', 'err');

    var assigneeEmail = v('sv-e-assignee');
    var who = (staffCache || []).find(function (p) { return p.email === assigneeEmail; });
    var promised = v('sv-e-promised');

    var patch = {
      customer_name: name,
      customer_phone: phone,
      customer_email: v('sv-e-email') || null,
      device_label: v('sv-e-device') || null,
      device_serial: v('sv-e-serial') || null,
      reported_fault: v('sv-e-fault') || null,
      diagnosis: v('sv-e-diagnosis') || null,
      work_done: v('sv-e-work') || null,
      assignee: who ? who.full_name : null,
      assignee_email: assigneeEmail || null,
      // A date typed as a bare day means end of that working day, not midnight
      // — otherwise a job promised "today" is already late by definition.
      promised_at: promised ? new Date(promised + 'T18:00:00').toISOString() : null,
      has_customer_data: !!(document.getElementById('sv-e-hasdata') || {}).checked,
      updated_at: nowIso()
    };

    // Snapshot BEFORE the await. The realtime subscription replaces the object
    // in serviceJobs when the server echoes this very update back, so anything
    // read from `job` afterwards may already be the NEW value — which would
    // make the history record "changed from X to X" and say nothing.
    var was = {
      assignee_email: job.assignee_email || '',
      promised_at: job.promised_at || null,
      diagnosis: job.diagnosis || '',
      work_done: job.work_done || ''
    };

    var btn = document.getElementById('sv-e-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    set('Saving…', '');
    try {
      var r = await c.from('service_jobs').update(patch).eq('id', openJobId);
      if (r.error) throw r.error;

      // Record what actually changed, so the history explains itself later.
      var changed = [];
      if (was.assignee_email !== (patch.assignee_email || '')) {
        changed.push(patch.assignee ? 'Assigned to ' + patch.assignee : 'Unassigned');
      }
      if (was.promised_at !== (patch.promised_at || null)) {
        changed.push(patch.promised_at
          ? 'Promised ' + new Date(patch.promised_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
          : 'Promised date cleared');
      }
      if (was.diagnosis !== (patch.diagnosis || '')) changed.push('Diagnosis recorded');
      if (was.work_done !== (patch.work_done || '')) changed.push('Work done updated');
      if (changed.length) {
        await logEvent(openJobId, { kind: 'edit', body: changed.join(' · '), customer_visible: false });
      }

      Object.assign(job, patch);
      renderServiceBoard();
      paintJob();
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
    var job = jobById(openJobId);
    var M = svc();
    var c = db();
    var st = document.getElementById('sv-m-status');
    var set = function (m, k) { if (st) { st.textContent = m; st.className = 'sv-status' + (k ? ' ' + k : ''); } };
    if (!job || !M || !c) return;

    var toStage = (document.getElementById('sv-m-stage') || {}).value;
    if (!toStage) return;
    var note = ((document.getElementById('sv-m-note') || {}).value || '').trim();
    var v = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };

    var patch = { stage: toStage, stage_since: nowIso(), updated_at: nowIso() };

    if (toStage === 'at_vendor' || toStage === 'parts_on_order') {
      var party = v('sv-m-party');
      if (!party) return set('Say who we are waiting on — that is the whole point of the chase list.', 'err');
      patch.waiting_party = party;
      var exp = v('sv-m-expected');
      if (exp) patch.next_chase_at = new Date(exp + 'T10:00:00').toISOString();
    } else {
      // Leaving a waiting stage clears the party, or the board keeps naming a
      // vendor who no longer has anything of ours.
      if (job.waiting_party) patch.waiting_party = null;
    }
    if (toStage === 'ready') {
      patch.outcome = v('sv-m-outcome') || 'repaired';
      patch.ready_at = nowIso();
    }
    if (toStage === 'closed') {
      patch.closed_at = nowIso();
      patch.closed_by = (me() && me().email) || null;
    }
    var pr = v('sv-m-promised');
    if (pr) patch.promised_at = new Date(pr + 'T18:00:00').toISOString();

    // Captured BEFORE the await for the same reason as saveDetails: realtime
    // can replace this object with the server echo mid-flight, and a move
    // logged as "at_vendor -> at_vendor" tells nobody anything.
    var fromStage = job.stage;

    var btn = document.getElementById('sv-m-go');
    if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
    set('Moving…', '');
    try {
      var r = await c.from('service_jobs').update(patch).eq('id', openJobId);
      if (r.error) throw r.error;
      await logEvent(openJobId, {
        kind: 'stage', from_stage: fromStage, to_stage: toStage,
        body: note || null,
        // A stage change is what the customer is asking about, so it is shown.
        // The note alongside it is shown too — write it for them.
        customer_visible: true
      });
      Object.assign(job, patch);
      renderServiceBoard();
      paintJob();
      toast('Moved to ' + M.staffLabel(toStage) + '.', 'success');
    } catch (e) {
      set('Could not move: ' + (e && e.message ? e.message : 'unknown error'), 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Move'; }
    }
  }

  async function addNote() {
    var c = db();
    var st = document.getElementById('sv-n-status');
    var set = function (m, k) { if (st) { st.textContent = m; st.className = 'sv-status' + (k ? ' ' + k : ''); } };
    var body = ((document.getElementById('sv-n-body') || {}).value || '').trim();
    if (!body) return set('Write something first.', 'err');
    if (!c) return set('Not connected.', 'err');
    var visible = !!(document.getElementById('sv-n-visible') || {}).checked;

    var btn = document.getElementById('sv-n-add');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await logEvent(openJobId, { kind: 'note', body: body, customer_visible: visible });
      var ta = document.getElementById('sv-n-body'); if (ta) ta.value = '';
      var cb = document.getElementById('sv-n-visible'); if (cb) cb.checked = false;
      set(visible ? 'Added — the customer will see this.' : 'Added as an internal note.', 'ok');
      loadTimeline(openJobId);
    } catch (e) {
      set('Could not add the note.', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add note'; }
    }
  }

  async function uploadPhotos(files) {
    var c = db();
    var st = document.getElementById('sv-p-status');
    var set = function (m, k) { if (st) { st.textContent = m; st.className = 'sv-status' + (k ? ' ' + k : ''); } };
    if (!c || !files || !files.length) return;
    var phase = (document.getElementById('sv-p-phase') || {}).value || 'intake';
    var okCount = 0, failed = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      set('Uploading ' + (i + 1) + ' of ' + files.length + '…', '');
      try {
        if (f.size > 15 * 1024 * 1024) { failed++; continue; }
        var ext = (f.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        var path = openJobId + '/' + Date.now().toString(36) + '-' +
                   Math.random().toString(36).slice(2, 8) + '.' + ext;
        var up = await c.storage.from('service-media').upload(path, f, { upsert: false, contentType: f.type });
        if (up.error) throw up.error;
        var ins = await c.from('service_media').insert({
          job_id: openJobId, path: path, phase: phase,
          uploaded_by: (me() && me().email) || null,
          uploaded_name: (me() && me().full_name) || null
        });
        if (ins.error) throw ins.error;
        okCount++;
      } catch (e) { failed++; }
    }
    if (okCount) {
      await logEvent(openJobId, {
        kind: 'media', body: okCount + ' photo' + (okCount === 1 ? '' : 's') + ' added (' + phase + ')',
        customer_visible: false
      });
    }
    set(okCount + ' added' + (failed ? ', ' + failed + ' failed' : '') + '.', failed ? 'err' : 'ok');
    loadMedia(openJobId);
  }

  async function setMediaVisible(mediaId, visible) {
    var c = db(); if (!c) return;
    try { await c.from('service_media').update({ customer_visible: visible }).eq('id', mediaId); }
    catch (e) { toast('Could not change that photo.', 'error'); }
  }

  async function deleteMedia(mediaId) {
    var c = db(); if (!c) return;
    var rows = mediaCache[openJobId] || [];
    var row = rows.find(function (r) { return String(r.id) === String(mediaId); });
    if (!row) return;
    if (!confirm('Delete this photo? Intake photos are evidence of the machine’s condition — this cannot be undone.')) return;
    try {
      await c.storage.from('service-media').remove([row.path]);
      await c.from('service_media').delete().eq('id', mediaId);
      loadMedia(openJobId);
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
          if (fig) { setMediaVisible(fig.dataset.media, t.checked); fig.classList.toggle('shown', t.checked); }
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
