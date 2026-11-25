/*
  Neo Service 1.16.1: Owner tools ("god mode"), owner only, password each time.

  Owner, 25 Nov 2026: "a manual edit secretly hidden in the settings for
  changing the value, outcome, even the component discovered and everything
  ... only with my permission and password".

  Where:  Settings → click the version number at the bottom of the sidebar
          five times (or Ctrl+Alt+W with a build open on the QC screen).
  Who:    tier 5 only (the owner). Everyone else sees nothing happen.
  Unlock: the owner re-types their own Neo Service login password; it is
          checked with Supabase (signInWithPassword for the signed-in email)
          and never stored. Unlocked for 15 minutes on this window.
  What:   any build: test values (the printed report's figures, kept as
          overrides over what was measured), the outcome (status, stress
          sign-off, finished date), the detected components, and every
          assembly / QC check.
  Record: each change is written to the build's internal event log as an
          "Owner correction" with the old and new value, and the overrides
          keep who and when — the shop always has the trail.

  Replaces the v1.8.0 God Mode (Ctrl+Alt+W), which had no gate at all.
  window.NeoOwnerTools = { open(ticketId?), unlock(), isUnlocked() }
*/
(function () {
  'use strict';

  var UNLOCK_MS = 15 * 60 * 1000;
  var unlockedUntil = 0;

  function prof() { try { return typeof currentProfile !== 'undefined' ? currentProfile : null; } catch (e) { return null; } }
  function sb() { try { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; } catch (e) { return null; } }
  function tickets() { try { return (typeof appState !== 'undefined' && appState && appState.tickets) || []; } catch (e) { return []; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m, t, d) { if (typeof showToast === 'function') showToast(m, t || 'info', d); }
  function isOwner() { var p = prof(); return !!(p && Number(p.tier) >= 5); }
  function isUnlocked() { return isOwner() && Date.now() < unlockedUntil; }

  // ── the password check ────────────────────────────────────────────────────
  function unlock() {
    return new Promise(function (resolve) {
      if (!isOwner()) { resolve(false); return; }
      if (isUnlocked()) { resolve(true); return; }
      var p = prof();
      var c = sb();
      if (!c || !c.auth || !p || !p.email) { toast('Owner tools need the cloud connection.', 'warning'); resolve(false); return; }
      var ov = document.createElement('div');
      ov.className = 'own-overlay';
      ov.innerHTML = '<form class="own-lock" autocomplete="off">' +
        '<div class="own-eyebrow">Owner tools</div><h2>Confirm it’s you</h2>' +
        '<p>Type your Neo Service password for <b>' + esc(p.email) + '</b>. It is checked with the server and not kept.</p>' +
        '<input type="password" class="own-pw" autocomplete="current-password" aria-label="Your password" required>' +
        '<div class="own-err" role="alert"></div>' +
        '<div class="own-acts"><button type="button" class="secondary-btn own-cancel">Cancel</button><button type="submit" class="primary-pink-btn own-go">Unlock</button></div>' +
        '</form>';
      document.body.appendChild(ov);
      var form = ov.querySelector('form'), pw = ov.querySelector('.own-pw'), err = ov.querySelector('.own-err'), go = ov.querySelector('.own-go');
      var done = function (ok) { ov.remove(); resolve(ok); };
      ov.querySelector('.own-cancel').addEventListener('click', function () { done(false); });
      ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var v = pw.value;
        if (!v) return;
        go.disabled = true; go.textContent = 'Checking…'; err.textContent = '';
        var r = null;
        try { r = await c.auth.signInWithPassword({ email: p.email, password: v }); } catch (x) { r = { error: x }; }
        pw.value = '';
        v = '';
        if (r && !r.error && r.data && r.data.user && String(r.data.user.email).toLowerCase() === String(p.email).toLowerCase()) {
          unlockedUntil = Date.now() + UNLOCK_MS;
          done(true);
        } else {
          go.disabled = false; go.textContent = 'Unlock';
          err.textContent = 'That password did not match.';
          pw.focus();
        }
      });
      setTimeout(function () { pw.focus(); }, 30);
    });
  }

  // ── the editor ────────────────────────────────────────────────────────────
  var RESULT_FIELDS = [
    ['cinebench', 'Cinebench score (pts)', 'number'], ['cinebenchMode', 'Cinebench mode', ['', 'multi', 'single']],
    ['furmark', 'FurMark score (pts)', 'number'], ['ssdRead', 'SSD read (MB/s)', 'number'], ['ssdWrite', 'SSD write (MB/s)', 'number'],
    ['cpuTempMin', 'CPU temp min (°C)', 'number'], ['cpuTempAvg', 'CPU temp avg (°C)', 'number'], ['cpuTempMax', 'CPU temp max (°C)', 'number'],
    ['gpuTempMin', 'GPU temp min (°C)', 'number'], ['gpuTempAvg', 'GPU temp avg (°C)', 'number'], ['gpuTempMax', 'GPU temp max (°C)', 'number'],
    ['cpuClockMax', 'CPU max clock (MHz)', 'number'], ['gpuClockMax', 'GPU max clock (MHz)', 'number'],
    ['ramStress', 'RAM / Prime95 result', ['', 'passed', 'failed']], ['ramDetail', 'RAM detail line', 'text']
  ];
  var DETECTED = [['cpu', 'CPU'], ['dgpu', 'Graphics card'], ['igpu', 'Integrated graphics'], ['ram', 'RAM'], ['storage', 'Storage'], ['motherboard', 'Motherboard']];
  var STATUS = [['awaiting', 'Awaiting parts'], ['building', 'Building'], ['waiting_qc', 'Waiting for QC'], ['qc_testing', 'QC testing'], ['completed', 'Finished (QC complete)']];
  var BUILD_CHECKS = [['cpuRamSsd', 'CPU, RAM and SSD seated'], ['moboCase', 'Motherboard in the case'], ['cooler', 'Cooler installed'], ['cables', 'Cable management'], ['posted', 'Posted to BIOS']];
  var QC_CHECKS = [['physCabinet', 'Cabinet scratch-free'], ['physMobo', 'Socket and pins OK'], ['physRam', 'RAM checked and clean'], ['physScrews', 'All screws secured'],
    ['softWindows', 'Windows activated'], ['softDrivers', 'Drivers installed'], ['softBios', 'BIOS updated'],
    ['portUsb', 'USB ports'], ['portVideo', 'Video ports'], ['portAudio', 'Audio'], ['portWifi', 'Wi-Fi']];

  function field(id, label, kind, value, placeholder) {
    var inner;
    if (Array.isArray(kind)) {
      inner = '<select class="settings-select" data-own="' + id + '">' + kind.map(function (o) {
        var lab = o === '' ? '(as measured' + (placeholder !== '' && placeholder != null ? ': ' + placeholder : '') + ')' : o;
        return '<option value="' + esc(o) + '"' + (String(value) === o ? ' selected' : '') + '>' + esc(lab) + '</option>';
      }).join('') + '</select>';
    } else {
      inner = '<input class="settings-input" data-own="' + id + '" type="' + (kind === 'number' ? 'number' : 'text') + '" value="' + esc(value) + '"' +
        (placeholder !== undefined ? ' placeholder="' + esc(placeholder === '' || placeholder == null ? 'as measured: —' : 'as measured: ' + placeholder) + '"' : '') + '>';
    }
    return '<label class="own-f"><span>' + esc(label) + '</span>' + inner + '</label>';
  }
  function check(id, label, on) {
    return '<label class="own-c"><input type="checkbox" data-own="' + id + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }

  var host = null, curId = null;
  function pickerHtml() {
    var list = tickets().slice().sort(function (a, b) { return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')); }).slice(0, 300);
    return '<div class="own-pick"><input class="settings-input own-q" type="search" placeholder="Find a build by customer or code"><div class="own-list">' +
      list.map(function (t) {
        return '<button type="button" class="own-row" data-id="' + esc(t.id) + '"><b>' + esc(t.customerName || 'Build') + '</b><span>#' + esc(String(t.id).slice(-6).toUpperCase()) +
          ' · ' + esc(t.status || '') + '</span></button>';
      }).join('') + '</div></div>';
  }
  function editorHtml(t) {
    var d = t.diagnostics || {}, ov = t.reportOverrides || {}, det = t.detectedSpecs || {};
    var b = t.buildChecks || {}, q = t.qcChecks || {};
    return '<div class="own-sec"><h3>Test results <small>Shown on the report. Blank keeps the measured value.</small></h3><div class="own-grid">' +
        RESULT_FIELDS.map(function (f) { return field('r.' + f[0], f[1], f[2], ov[f[0]] != null ? ov[f[0]] : '', d[f[0]] != null ? d[f[0]] : ''); }).join('') + '</div></div>' +
      '<div class="own-sec"><h3>Outcome</h3><div class="own-grid">' +
        field('o.status', 'Status', STATUS.map(function (s) { return s[0]; }), t.status || '', '').replace(/>(awaiting|building|waiting_qc|qc_testing|completed)</g, function (m, k) {
          var hit = STATUS.filter(function (s) { return s[0] === k; })[0]; return '>' + esc(hit ? hit[1] : k) + '<';
        }).replace('<option value="">(as measured)</option>', '') +
        field('o.stressRuns', 'Stress runs', 'number', t.stressRuns != null ? t.stressRuns : '') +
        field('o.completedAt', 'Finished on (YYYY-MM-DD HH:MM)', 'text', t.completedAt ? String(t.completedAt).slice(0, 16).replace('T', ' ') : '') +
        '</div>' + check('o.stressSignedOff', 'Stress testing signed off', !!t.stressSignedOff) + '</div>' +
      '<div class="own-sec"><h3>Detected components <small>What the bench found on the PC.</small></h3><div class="own-grid">' +
        DETECTED.map(function (f) { return field('d.' + f[0], f[1], 'text', det[f[0]] || ''); }).join('') + '</div></div>' +
      '<div class="own-sec"><h3>Checks</h3><div class="own-checks"><div><h4>Assembly</h4>' + BUILD_CHECKS.map(function (c) { return check('b.' + c[0], c[1], !!b[c[0]]); }).join('') +
        '</div><div><h4>QC</h4>' + QC_CHECKS.map(function (c) { return check('q.' + c[0], c[1], !!q[c[0]]); }).join('') + '</div></div></div>';
  }
  function paint() {
    if (!host) return;
    var body = host.querySelector('.own-body');
    var t = curId ? tickets().filter(function (x) { return x && x.id === curId; })[0] : null;
    host.querySelector('.own-title').textContent = t ? (t.customerName || 'Build') + ' · #' + String(t.id).slice(-6).toUpperCase() : 'Choose a build';
    host.querySelector('.own-save').classList.toggle('hidden', !t);
    host.querySelector('.own-back').classList.toggle('hidden', !t);
    body.innerHTML = t ? editorHtml(t) : pickerHtml();
    body.scrollTop = 0;
  }
  function close() { if (host) { host.remove(); host = null; } curId = null; }

  function val(el) {
    if (!el) return undefined;
    if (el.type === 'checkbox') return !!el.checked;
    return String(el.value || '').trim();
  }
  function save() {
    var t = tickets().filter(function (x) { return x && x.id === curId; })[0];
    if (!t || !isUnlocked()) { toast('Owner tools locked again. Unlock and try once more.', 'warning'); return; }
    var who = (prof() && (prof().full_name || prof().email)) || 'Owner';
    var changes = [];
    var note = function (what, from, to) { changes.push(what + ': ' + (from === '' || from == null ? '—' : from) + ' → ' + (to === '' || to == null ? '—' : to)); };
    var get = function (k) { return val(host.querySelector('[data-own="' + k + '"]')); };
    // results → report overrides (the measured values stay as they were)
    var oldOv = t.reportOverrides || {};
    var ov = {};
    RESULT_FIELDS.forEach(function (f) {
      var v = get('r.' + f[0]);
      if (v === undefined || v === '') return;
      ov[f[0]] = f[2] === 'number' ? parseFloat(v) : v;
    });
    RESULT_FIELDS.forEach(function (f) {
      var a = oldOv[f[0]] != null ? oldOv[f[0]] : '', b = ov[f[0]] != null ? ov[f[0]] : '';
      if (String(a) !== String(b)) note('Report ' + f[1], a, b);
    });
    if (Object.keys(ov).length) { ov.__editedAt = new Date().toISOString(); ov.__editedBy = who; t.reportOverrides = ov; }
    else delete t.reportOverrides;
    // outcome
    var st = get('o.status');
    if (st && st !== t.status) { note('Status', t.status, st); t.status = st; }
    var runs = get('o.stressRuns');
    if (runs !== '' && runs !== undefined && Number(runs) !== Number(t.stressRuns || 0)) { note('Stress runs', t.stressRuns || 0, Number(runs)); t.stressRuns = Math.max(0, Math.round(Number(runs) || 0)); }
    var so = get('o.stressSignedOff');
    if (so !== !!t.stressSignedOff) { note('Stress sign-off', t.stressSignedOff ? 'yes' : 'no', so ? 'yes' : 'no'); t.stressSignedOff = so; t.stressSignedOffAt = so ? (t.stressSignedOffAt || new Date().toISOString()) : null; }
    var fin = get('o.completedAt');
    var finIso = fin ? (function () { var dt = new Date(fin.replace(' ', 'T')); return isNaN(dt) ? null : dt.toISOString(); })() : null;
    if (t.status === 'completed') {
      var want = finIso || t.completedAt || new Date().toISOString();
      if (want !== t.completedAt) { note('Finished on', t.completedAt, want); t.completedAt = want; }
    } else if (t.completedAt && t.status !== 'completed') { note('Finished on', t.completedAt, ''); t.completedAt = null; }
    // detected components
    var det = Object.assign({}, t.detectedSpecs || {});
    var detChanged = false;
    DETECTED.forEach(function (f) {
      var v = get('d.' + f[0]);
      if (v === undefined) return;
      if (String(det[f[0]] || '') !== v) { note('Detected ' + f[1], det[f[0]] || '', v); det[f[0]] = v || null; detChanged = true; }
    });
    if (detChanged) {
      det.gpu = det.dgpu || det.igpu || det.gpu || null;
      det.__ownerEditedAt = new Date().toISOString();
      t.detectedSpecs = det;
    }
    // checks
    t.buildChecks = t.buildChecks || {}; t.qcChecks = t.qcChecks || {};
    BUILD_CHECKS.forEach(function (c) { var v = get('b.' + c[0]); if (v !== !!t.buildChecks[c[0]]) { note('Assembly ' + c[1], t.buildChecks[c[0]] ? 'ticked' : 'open', v ? 'ticked' : 'open'); t.buildChecks[c[0]] = v; } });
    QC_CHECKS.forEach(function (c) { var v = get('q.' + c[0]); if (v !== !!t.qcChecks[c[0]]) { note('QC ' + c[1], t.qcChecks[c[0]] ? 'ticked' : 'open', v ? 'ticked' : 'open'); t.qcChecks[c[0]] = v; } });
    if (!changes.length) { toast('Nothing changed.', 'info'); return; }
    try { if (typeof addEventLog === 'function') changes.forEach(function (c) { addEventLog(t, 'Owner correction · ' + c, who); }); } catch (e) { /* log is best effort */ }
    t.updatedAt = new Date().toISOString();
    var btn = host.querySelector('.own-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    Promise.resolve()
      .then(function () { return typeof saveDatabase === 'function' ? saveDatabase() : null; })
      .then(function () { return typeof syncTicketToCloud === 'function' ? syncTicketToCloud(t) : true; })
      .then(function (ok) {
        btn.disabled = false; btn.textContent = 'Save changes';
        toast(changes.length + ' change' + (changes.length === 1 ? '' : 's') + ' saved' + (ok === false ? ' on this PC (the cloud sync failed — it retries on the next save)' : ' and synced') + '.', ok === false ? 'warning' : 'success', 6000);
        try { if (typeof renderDashboard === 'function' && typeof currentMode !== 'undefined' && currentMode === 'staff') renderDashboard(); } catch (e) { /* not on the board */ }
        paint();
      });
  }

  function show(ticketId) {
    close();
    curId = ticketId || null;
    host = document.createElement('div');
    host.className = 'own-overlay';
    host.innerHTML = '<div class="own-sheet" role="dialog" aria-modal="true" aria-label="Owner tools">' +
      '<header class="own-head"><div><div class="own-eyebrow">Owner tools · unlocked</div><h2 class="own-title"></h2></div>' +
      '<div class="own-head-acts"><button type="button" class="secondary-btn own-back hidden">All builds</button>' +
      '<button type="button" class="primary-pink-btn own-save hidden">Save changes</button><button type="button" class="own-x" aria-label="Close">×</button></div></header>' +
      '<div class="own-body"></div>' +
      '<footer class="own-foot">Every change goes into the build’s internal event log as an owner correction. Report figures are kept as overrides; what was measured is not erased.</footer></div>';
    document.body.appendChild(host);
    host.addEventListener('click', function (e) {
      if (e.target === host || e.target.closest('.own-x')) { close(); return; }
      if (e.target.closest('.own-back')) { curId = null; paint(); return; }
      if (e.target.closest('.own-save')) { save(); return; }
      var row = e.target.closest('.own-row');
      if (row) { curId = row.getAttribute('data-id'); paint(); }
    });
    host.addEventListener('input', function (e) {
      if (!e.target.classList.contains('own-q')) return;
      var q = e.target.value.trim().toLowerCase();
      Array.prototype.forEach.call(host.querySelectorAll('.own-row'), function (r) { r.style.display = !q || r.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none'; });
    });
    host.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    paint();
  }

  async function open(ticketId) {
    if (!isOwner()) return false;                  // nothing happens for anyone else
    if (!(await unlock())) return false;
    show(ticketId);
    return true;
  }

  // The hidden way in: five quick clicks on the version at the bottom of the
  // Settings sidebar.
  var clicks = [];
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#settings-sidebar-ver')) return;
    var now = Date.now();
    clicks = clicks.filter(function (t) { return now - t < 2500; });
    clicks.push(now);
    if (clicks.length >= 5) {
      clicks = [];
      if (isOwner()) {
        var m = document.getElementById('settings-modal');
        if (m) m.classList.remove('active');
        open(null);
      }
    }
  });

  var css = document.createElement('style');
  css.textContent =
    '.own-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(10,10,15,.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:var(--nt-font)}' +
    '.own-lock{width:min(420px,100%);padding:24px 24px 20px;border-radius:20px;background:var(--nt-surface);border:1px solid var(--nt-hairline);box-shadow:var(--nt-e3);color:var(--text-dark)}' +
    '.own-lock h2{margin:4px 0 6px;font-size:1.3rem}.own-lock p{margin:0 0 14px;font-size:.86rem;color:var(--text-muted);line-height:1.45}' +
    '.own-pw{width:100%;box-sizing:border-box;padding:11px 14px;border-radius:12px;border:1px solid var(--nt-input-border);background:var(--nt-surface);color:var(--text-dark);font:inherit;font-size:1rem}' +
    '.own-err{min-height:18px;margin-top:6px;font-size:.8rem;color:var(--nt-danger-text,#B42318)}' +
    '.own-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}.own-acts button{padding:9px 16px;border-radius:12px}' +
    '.own-eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--nt-brand)}' +
    '.own-sheet{width:min(980px,100%);height:min(820px,calc(100vh - 60px));display:flex;flex-direction:column;border-radius:22px;background:var(--glass-bg);border:1px solid var(--glass-border);box-shadow:var(--nt-e3);backdrop-filter:blur(var(--nt-blur));-webkit-backdrop-filter:blur(var(--nt-blur));color:var(--text-dark);overflow:hidden}' +
    '.own-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid var(--nt-hairline)}' +
    '.own-head h2{margin:2px 0 0;font-size:1.25rem}.own-head-acts{display:flex;gap:8px;align-items:center}.own-head-acts button{padding:9px 16px;border-radius:12px}' +
    '.own-x{width:36px;height:36px;padding:0;display:inline-grid;place-items:center;border-radius:12px;border:1px solid var(--nt-hairline);background:var(--nt-sunken);color:var(--text-muted);font-size:1.3rem;cursor:pointer}' +
    '.own-body{flex:1;overflow:auto;padding:18px 22px}.own-foot{padding:12px 22px;border-top:1px solid var(--nt-hairline);font-size:.78rem;color:var(--text-muted)}' +
    '.own-sec{margin-bottom:16px;padding:16px 18px;border-radius:16px;background:var(--glass-bg);border:1px solid var(--glass-border)}' +
    '.own-sec h3{margin:0 0 12px;font-size:.98rem}.own-sec h3 small{font-weight:500;color:var(--text-muted);font-size:.78rem;margin-left:6px}.own-sec h4{margin:0 0 8px;font-size:.82rem;color:var(--text-muted)}' +
    '.own-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 14px}' +
    '.own-f{display:flex;flex-direction:column;gap:5px;font-size:.76rem;font-weight:600;color:var(--text-muted)}.own-f input,.own-f select{width:100%;box-sizing:border-box}' +
    '.own-c{display:flex;align-items:center;gap:8px;font-size:.86rem;padding:4px 0;cursor:pointer}.own-checks{display:grid;grid-template-columns:1fr 1fr;gap:18px}' +
    '.own-pick .own-q{width:100%;box-sizing:border-box;margin-bottom:12px}.own-list{display:flex;flex-direction:column;gap:6px}' +
    '.own-row{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:12px;border:1px solid var(--nt-hairline);background:var(--nt-surface);color:var(--text-dark);font:inherit;cursor:pointer;text-align:left}' +
    '.own-row:hover{border-color:var(--primary-pink);background:var(--nt-brand-tint)}.own-row span{color:var(--text-muted);font-size:.8rem}';
  document.head.appendChild(css);

  window.NeoOwnerTools = { open: open, unlock: unlock, isUnlocked: isUnlocked };
})();
