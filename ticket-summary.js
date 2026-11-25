/*
  Neo Service — the ticket summary page (owner's brief §7, 24 Nov 2026).

  A click on a Service ticket or an RMA part opens this read-only page first:
  nearly full screen, the details on the left, and the status, the flags and
  the notes on the right. A separate Edit button opens the full panel, where
  every change is made.

  How the status is shown (the same three lines on every ticket, in this order):
    1. the step bar: where it is, with done / now / later steps;
    2. one plain sentence saying whose turn it is and what we are waiting for,
       with how long it has been there and whether that is late;
    3. the next step: the one thing to do now (done in the full panel).

  Reads only from NeoQcData and NeoQcService. Writes only notes (addNote /
  rmaNote), with their photos (server v2.12: a note carries the ids of the
  photos uploaded for it). window.NeoTicketSummary = { openJob, openUnit,
  close, isOpen }.
*/
(function () {
  'use strict';

  function D() { return window.NeoQcData || null; }
  function M() { return window.NeoQcService || null; }
  function C() { return window.NeoQcCatalog || null; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ms(v) { if (!v) return null; var t = Date.parse(v); return isNaN(t) ? null : t; }
  function fmtDate(v) {
    var t = ms(v);
    if (t == null) return '';
    var d = new Date(t);
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' am' : ' pm');
  }
  function fmtDateTime(v) {
    var t = ms(v);
    if (t == null) return '';
    var d = new Date(t);
    return d.getDate() + ' ' + MON[d.getMonth()] + ', ' + fmtTime(d);
  }
  function fmtDays(days) {
    if (days == null || isNaN(days)) return '';
    if (days < 1 / 24) return 'under an hour';
    if (days < 1) { var h = Math.round(days * 24); return h + ' hour' + (h === 1 ? '' : 's'); }
    var n = Math.floor(days);
    return n + ' day' + (n === 1 ? '' : 's');
  }
  function showPhone(p) {
    var n = String(p || '').replace(/\D/g, '');
    if (n.length === 12 && n.indexOf('91') === 0) return '+91 ' + n.slice(2, 7) + ' ' + n.slice(7);
    if (n.length === 10) return n.slice(0, 5) + ' ' + n.slice(5);
    return p || '';
  }
  function lbl(map, k) { return (map && k != null && map[k]) || ''; }
  function inr(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }

  // ── the page ────────────────────────────────────────────────────────────
  var root = null;
  var cur = null;          // { kind: 'job' | 'unit', id }
  var seq = 0;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'tk-summary';
    root.className = 'tk-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tk-title');
    root.innerHTML = '<div class="tk-sheet"><div class="tk-page" id="tk-page"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', function (e) { if (e.target === root) root.dataset.downOut = '1'; else delete root.dataset.downOut; });
    root.addEventListener('mouseup', function (e) {
      if (e.target === root && root.dataset.downOut === '1' && !noteDirty()) close();
      delete root.dataset.downOut;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      // A dialog opened on top of the page closes first.
      // (ops-ui dialogs and the photo lightbox are .modal-overlay.active)
      if (document.querySelector('.modal-overlay.active')) return;
      if (noteDirty()) return;
      close();
    });
    var d = D();
    if (d && typeof d.on === 'function') {
      var again = function () { if (isOpen()) paint(false); };
      d.on('jobs', again);
      d.on('units', again);
    }
    return root;
  }
  function isOpen() { return !!(root && root.classList.contains('open')); }
  function close() {
    if (!root) return;
    dropTray();
    root.classList.remove('open');
    document.body.classList.remove('tk-lock');
    cur = null;
  }
  function noteDirty() {
    var t = root && root.querySelector('#tk-note');
    return !!(t && String(t.value || '').trim()) || trayCount() > 0;
  }

  // The note's photo tray lives as long as the page shows the same ticket:
  // a repaint moves its host into the new page instead of dropping the files.
  var noteTray = null, noteTrayFor = null, pendingIds = null;
  function trayCount() { try { return noteTray ? noteTray.count() || 0 : 0; } catch (e) { return 0; } }
  function dropTray() {
    if (noteTray) { try { noteTray.destroy(); } catch (e) { /* gone */ } }
    noteTray = null; noteTrayFor = null; pendingIds = null;
  }
  function mountTray() {
    var host = root.querySelector('.tk-note-tray');
    var T = window.NeoQcPhotoTray;
    if (!host || !T || typeof T.create !== 'function') return;
    try {
      noteTray = T.create(host, { roles: ['note'], defaultRole: 'note', allowPdf: false, minPhotos: 0, label: 'Photos for this note (optional)' });
      noteTrayFor = cur ? cur.kind + ':' + cur.id : null;
    } catch (e) { noteTray = null; }
  }

  function openJob(id) {
    ensureRoot();
    dropTray();
    cur = { kind: 'job', id: id };
    paint(true);
    root.classList.add('open');
    document.body.classList.add('tk-lock');
    var sheet = root.querySelector('.tk-sheet');
    if (sheet) sheet.scrollTop = 0;
  }
  function openUnit(id) {
    ensureRoot();
    dropTray();
    cur = { kind: 'unit', id: id };
    paint(true);
    root.classList.add('open');
    document.body.classList.add('tk-lock');
    var sheet = root.querySelector('.tk-sheet');
    if (sheet) sheet.scrollTop = 0;
  }

  // Repaint keeps a note being typed (realtime updates arrive while writing).
  function paint(fresh) {
    if (!cur) return;
    var page = root.querySelector('#tk-page');
    var keep = fresh ? '' : String((root.querySelector('#tk-note') || {}).value || '');
    var keepVis = fresh ? false : !!(root.querySelector('#tk-note-visible') || {}).checked;
    var html = cur.kind === 'job' ? jobPage(cur.id) : unitPage(cur.id);
    if (!html) {
      page.innerHTML = '<div class="tk-gone"><p>This ticket is no longer in the list.</p><button type="button" class="secondary-btn" data-tk="close">Close</button></div>';
      return;
    }
    var oldHost = !fresh && noteTray ? root.querySelector('.tk-note-tray') : null;
    page.innerHTML = html;
    if (oldHost) {
      var newHost = root.querySelector('.tk-note-tray');
      if (newHost) newHost.parentNode.replaceChild(oldHost, newHost);
    } else {
      mountTray();
    }
    var note = root.querySelector('#tk-note');
    if (note && keep) note.value = keep;
    var vis = root.querySelector('#tk-note-visible');
    if (vis) vis.checked = keepVis;
    loadAsync(++seq);
  }

  // ── shared pieces ───────────────────────────────────────────────────────
  function stepBar(steps, states, subs, aria) {
    return '<ol class="sv2-steps rma-steps tk-steps" aria-label="' + esc(aria) + '">' + steps.map(function (st, i) {
      var state = states[i];
      var dot = state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'skipped' ? '–' : String(i + 1);
      var sub = subs[i] || '';
      return '<li class="sv2-step is-' + state + '"' + (state === 'now' ? ' aria-current="step"' : '') +
        (st.full ? ' title="' + esc(st.full) + '"' : '') + '>' +
        '<span class="sv2-step-dot" aria-hidden="true">' + dot + '</span>' +
        '<span class="sv2-step-t"><span class="sv2-step-l">' + esc(st.label) + '</span>' +
        (sub ? '<span class="sv2-step-s">' + esc(sub) + '</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  var BALL_CLS = { customer: 'customer', shop: 'shop', third_party: 'third', nobody: 'nobody' };
  function nowRow(ball, sentence, days, risk, extra) {
    return '<div class="tk-now">' +
      '<span class="tk-now-k">Now</span>' +
      '<span class="sv-ball sv-ball-' + esc(BALL_CLS[ball] || 'shop') + '">' + esc(sentence) + '</span>' +
      (days != null ? '<span class="tk-now-days' + (risk === 2 ? ' late' : risk === 1 ? ' soon' : '') + '">' +
        esc(fmtDays(days)) + ' at this step' + (risk === 2 ? ' · late' : risk === 1 ? ' · due soon' : '') + '</span>' : '') +
      (extra || '') +
    '</div>';
  }
  function section(title, body, cls) {
    return body ? '<section class="tk-sec' + (cls ? ' ' + cls : '') + '"><h3 class="tk-h">' + esc(title) + '</h3>' + body + '</section>' : '';
  }
  function facts(rows) {
    var list = rows.filter(function (r) { return r && r[1] != null && String(r[1]).trim() !== ''; });
    if (!list.length) return '';
    return '<dl class="tk-facts">' + list.map(function (r) {
      return '<div class="tk-fact' + (r[2] ? ' ' + r[2] : '') + '"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }
  function flagsHtml(list) {
    if (!list.length) return '<p class="tk-muted">Nothing to watch out for.</p>';
    return '<ul class="tk-flags">' + list.map(function (f) {
      return '<li class="tk-flag tk-flag-' + esc(f[0]) + '"><span class="tk-flag-dot" aria-hidden="true"></span><span>' +
        '<strong>' + esc(f[1]) + '</strong>' + (f[2] ? '<span class="tk-flag-s">' + esc(f[2]) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function notesBox() {
    return '<div class="tk-note-add">' +
      '<label class="tk-vh" for="tk-note">Add a note</label>' +
      '<textarea id="tk-note" rows="3" placeholder="Add a note for the team…"></textarea>' +
      '<div class="tk-note-row">' +
        '<label class="sv-check"><input type="checkbox" id="tk-note-visible"> The customer can read it</label>' +
        '<button type="button" class="primary-pink-btn tk-small" data-tk="add-note">Add note</button>' +
      '</div>' +
      '<div class="tk-note-tray"></div>' +
      '<p class="tk-muted tk-note-hint">Photos go with the note: whoever can read the note sees them.</p>' +
      '<div id="tk-note-status" class="sv-status"></div>' +
    '</div>' +
    '<div id="tk-notes" class="tk-notes"><p class="tk-muted">Loading notes…</p></div>';
  }
  function head(code, kicker, title, sub, chips) {
    return '<header class="tk-head">' +
      '<div class="tk-head-main">' +
        '<div class="tk-kicker"><span class="tk-code">' + esc(code) + '</span>' + (kicker ? ' · ' + esc(kicker) : '') + (chips || '') + '</div>' +
        '<h2 id="tk-title" class="tk-title">' + esc(title) + '</h2>' +
        (sub ? '<div class="tk-sub">' + sub + '</div>' : '') +
      '</div>' +
      '<div class="tk-head-acts">' +
        '<button type="button" class="primary-pink-btn" data-tk="edit">Edit</button>' +
        '<button type="button" class="secondary-btn" data-tk="copy-link">Copy tracking link</button>' +
        '<button type="button" class="tk-x" data-tk="close" aria-label="Close" title="Close">&times;</button>' +
      '</div>' +
    '</header>';
  }

  // ── a Service ticket ────────────────────────────────────────────────────
  function jobPage(id) {
    var d = D(), m = M();
    var job = d && d.job ? d.job(id) : null;
    if (!job || !m) return '';
    var now = Date.now();
    var units = d.unitsOfJob ? d.unitsOfJob(job.id) || [] : [];
    var vById = {};
    (d.vendors ? d.vendors() : []).forEach(function (v) { vById[String(v.id)] = v; });
    var tv = { ball: m.ballOf(job.stage), risk: m.serviceRisk(job, now), sentence: m.waitingSentence(job) };
    try { if (typeof m.ticketWithUnits === 'function') tv = m.ticketWithUnits(job, units, vById, now); } catch (e) { /* plain view */ }
    var s = m.stepsFor(job);
    var closed = job.stage === 'closed';
    var states = s.steps.map(function (st, i) { return closed || i < s.current ? 'done' : i === s.current ? 'now' : 'todo'; });
    var subs = s.steps.map(function (st, i) {
      if (i === s.current && !closed && st.stages.length > 1) return m.staffLabel(job.stage);
      return '';
    });
    var items = d.itemsOf ? d.itemsOf(job.id) || [] : [];
    var type = m.typeOf ? m.typeOf(job) : (job.service_type || 'in_store');
    var cat = job.category === 'other' && job.category_other ? job.category_other : m.categoryLabel(job.category);
    var pri = job.priority && job.priority !== 'normal' ? '<span class="tk-chip tk-pri-' + esc(job.priority) + '">' + esc(lbl(m.PRIORITIES && (function () {
      var o = {}; Object.keys(m.PRIORITIES).forEach(function (k) { o[k] = m.PRIORITIES[k].label; }); return o; })(), job.priority)) + ' priority</span>' : '';
    var sub = [job.customer_phone ? esc(showPhone(job.customer_phone)) : '', esc(job.device_label || '')].filter(Boolean).join(' · ');

    // Main column
    var problem = facts([
      ['The customer said', job.reported_fault],
      ['Our diagnosis', job.diagnosis, 'tk-strong'],
      ['Work done', job.work_done, 'tk-strong'],
      ['Outcome', closed && m.OUTCOMES ? lbl(m.OUTCOMES, job.outcome) : '']
    ]);
    var itemRows = items.map(function (it) {
      var bits = [it.serial ? 'Serial ' + it.serial : '', it.condition_remarks || '', (it.accessories || []).length ? 'Came with ' + it.accessories.join(', ') : '',
                  it.purchase_source ? lbl(m.PURCHASE_SOURCES, it.purchase_source) : ''].filter(Boolean);
      return '<li class="tk-item"><span class="tk-item-k">' + esc(m.itemKindLabel(it.kind)) + (it.is_primary ? ' · main' : '') + '</span>' +
        '<span class="tk-item-l">' + esc(it.label || '') + '</span>' +
        (bits.length ? '<span class="tk-item-s">' + esc(bits.join(' · ')) + '</span>' : '') + '</li>';
    }).join('');
    var unitRows = units.map(function (u) {
      var rs = typeof m.rmaStepsFor === 'function' ? m.rmaStepsFor(u) : null;
      var step = rs ? 'Step ' + (rs.current + 1) + ' of ' + rs.steps.length + ': ' + rs.steps[rs.current].label + (rs.sub ? ' · ' + rs.sub : '') : m.RMA_STAGES[u.stage] ? m.RMA_STAGES[u.stage].staff : u.stage;
      return '<li class="tk-unit"><button type="button" class="tk-unit-btn" data-tk-unit="' + esc(u.id) + '">' +
        '<span class="tk-code">' + esc(u.public_code || '') + '</span>' +
        '<span class="tk-unit-l">' + esc([m.itemKindLabel(u.kind), [u.brand, u.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')) + '</span>' +
        '<span class="tk-unit-s' + (rs && rs.failed >= 0 ? ' bad' : '') + '">' + esc(rs && rs.failed >= 0 ? rs.why + ' · ' + step : step) + '</span>' +
        (u.holds_ticket && u.stage !== 'closed' ? '<span class="tk-chip">Holds this ticket</span>' : '') +
        '</button></li>';
    }).join('');
    var q = d.cachedQuotes ? d.cachedQuotes(job.id)[0] : null;
    var pays = d.cachedPayments ? d.cachedPayments(job.id) : [];
    var paid = pays.reduce(function (a, p) { return a + (Number(p.amount) || 0); }, 0);
    var money = facts([
      ['Quote', q ? (lbl(m.QUOTE_STATUSES, q.status) || q.status) + (q.total != null ? ' · ' + inr(q.total) : '') : ''],
      ['Bill', job.bill_total != null ? inr(job.bill_total) : ''],
      ['Paid', pays.length ? inr(paid) + ' (' + pays.length + ' payment' + (pays.length === 1 ? '' : 's') + ')' : '']
    ]);
    // 1.16 (v2.13): the ticket's QC test, when the customer asked for one.
    var qc = typeof d.qcOfJob === 'function' ? d.qcOfJob(job.id) : null;
    var main = section('The problem', problem) +
      (qc ? section('QC test', qcHtml(qc), 'tk-qc') : '') +
      section(items.length === 1 ? 'The device' : 'Devices and parts', items.length ? '<ul class="tk-items">' + itemRows + '</ul>' : '') +
      section('Warranty parts (RMA)', units.length ? '<ul class="tk-units">' + unitRows + '</ul>' : '') +
      section('Quote and payment', money) +
      section('History', '<div id="tk-history" class="tk-history"><p class="tk-muted">Loading the history…</p></div>');

    // Right rail
    var flags = [];
    if (job.priority === 'urgent' || job.priority === 'high') flags.push(['red', (job.priority === 'urgent' ? 'Urgent' : 'High priority'), job.priority_reason || '']);
    if (tv.risk === 2) flags.push(['red', 'Late at this step', 'Over the time this step should take']);
    if (job.promised_at && !closed && job.stage !== 'ready') flags.push([ms(job.promised_at) < now ? 'red' : 'amber', 'Promised for ' + fmtDate(job.promised_at), '']);
    var held = units.filter(function (u) { return u.holds_ticket && u.stage !== 'closed'; });
    if (held.length) flags.push(['blue', 'Waiting on ' + held.length + ' warranty part' + (held.length === 1 ? '' : 's'), held.map(function (u) { return u.public_code; }).join(', ')]);
    if (job.has_customer_data || job.data_consent) flags.push(['amber', 'Customer data', m.dataConsentLabel(job.data_consent)]);
    if (job.has_device_password) flags.push(['blue', 'Device password on file', 'Shown in Edit, to those allowed']);
    if (job.powers_on === false) flags.push(['amber', 'Does not power on', '']);
    if (qc && (qc.status === 'queued' || qc.status === 'testing')) flags.push(['blue', 'In QC', qc.status === 'testing' ? 'Being tested on the bench' : 'Waiting for the bench']);
    if (qc && qc.status === 'passed') flags.push(['green', 'QC passed', fmtDate(qc.finished_at)]);
    if (qc && qc.status === 'failed') flags.push(['red', 'QC did not pass', fmtDate(qc.finished_at)]);
    if (q && q.status === 'sent') flags.push(['amber', 'Quote waiting for the customer', '']);
    if (job.bill_total != null && paid < Number(job.bill_total) && job.stage === 'ready') flags.push(['amber', 'Not fully paid', inr(Number(job.bill_total) - paid) + ' due']);
    var status = facts([
      ['Step', m.staffLabel(job.stage)],
      ['Technician', job.assignee || (closed ? '' : 'Nobody yet')],
      ['Type', [m.typeLabel(type), cat].filter(Boolean).join(' · ')],
      ['Came in', [fmtDate(job.received_at || job.created_at), job.created_by_name ? 'by ' + job.created_by_name : ''].filter(Boolean).join(' ')],
      ['Closed', closed ? fmtDateTime(job.closed_at) : '']
    ]);
    var rail = section('Status', status, 'tk-card') + section('Flags', flagsHtml(flags), 'tk-card') + section('Notes', notesBox(), 'tk-card');

    return head(job.public_code || '', [m.typeLabel(type), cat].filter(Boolean).join(' · '), job.customer_name || 'Customer', sub, pri) +
      '<div class="tk-status">' + stepBar(s.steps, states, subs, 'Where this ticket is') +
        nowRow(tv.ball, tv.sentence, m.daysInStage(job, now), tv.risk, '') + '</div>' +
      '<div class="tk-grid"><div class="tk-main">' + main + '</div><aside class="tk-rail">' + rail + '</aside></div>';
  }

  // The QC test block: where it stands, the customer's goals with what the
  // bench measured, the stability run, the charge.
  var QC_STATE = { queued: 'Waiting for the bench', testing: 'Being tested', passed: 'Passed', failed: 'Did not pass', cancelled: 'Cancelled' };
  function qcHtml(q) {
    var res = q.results || {};
    var gres = Array.isArray(res.goals) ? res.goals : [];
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var stab = res.stability || null;
    var tone = q.status === 'passed' ? 'ok' : q.status === 'failed' ? 'bad' : q.status === 'cancelled' ? 'muted' : 'wait';
    var who = q.status === 'testing' && q.tested_by_name ? ' · ' + q.tested_by_name
      : (q.status === 'passed' || q.status === 'failed') && q.tested_by_name ? ' · ' + q.tested_by_name + ', ' + fmtDateTime(q.finished_at) : '';
    var rows = goals.map(function (g, i) {
      var r = gres[i] || null;
      var what = g.kind === 'game'
        ? g.name + (g.settings ? ' · ' + g.settings : '') + ' — target ' + g.target_fps + ' fps'
        : g.app + ' · ' + g.task + (g.max_minutes ? ' — within ' + g.max_minutes + ' min' : '');
      var got = !r ? '' : g.kind === 'game'
        ? (r.avg_fps != null ? r.avg_fps + ' fps average' + (r.low1_fps != null ? ', 1% low ' + r.low1_fps : '') : '')
        : (r.minutes != null ? 'finished in ' + r.minutes + ' min' : (r.passed ? 'finished' : 'failed'));
      return '<li class="tk-qc-goal' + (r ? (r.passed ? ' ok' : ' bad') : '') + '">' +
        '<span class="tk-qc-mark" aria-hidden="true">' + (r ? (r.passed ? '✓' : '✕') : '•') + '</span>' +
        '<span><span class="tk-qc-k">' + (g.kind === 'game' ? 'Game' : 'Work') + '</span> ' + esc(what) +
        (got ? '<span class="tk-qc-got">' + esc(got) + '</span>' : '') + '</span></li>';
    }).join('');
    return '<div class="tk-qc-state tk-qc-' + tone + '">' + esc(QC_STATE[q.status] || q.status) + esc(who) + '</div>' +
      (q.summary ? '<p class="tk-qc-summary">' + esc(q.summary) + '</p>' : '') +
      (rows ? '<ul class="tk-qc-goals">' + rows + '</ul>' : '<p class="tk-muted">No goals: health and stability only.</p>') +
      facts([
        ['Stability test', (q.stability_minutes || 15) + ' minutes' + (stab ? ' · CPU ' + stab.cpu_max_c + ' °C, GPU ' + stab.gpu_max_c + ' °C' + (stab.whea ? ', ' + stab.whea + ' hardware errors' : ', no hardware errors') : '')],
        ['In the customer’s words', q.customer_words || ''],
        ['Charge', q.charge === 'paid' ? 'Paid · ' + inr(q.amount) : 'Free'],
        ['Sent', fmtDateTime(q.requested_at) + (q.requested_by_name ? ' by ' + q.requested_by_name : '')],
        ['Cancelled', q.status === 'cancelled' ? (q.cancel_reason || 'Yes') : '']
      ]) +
      // 1.16: the bench test (qc-bench.js) for an open QC job; the report for a finished one.
      (!window.NeoQcBench ? ''
        : (q.status === 'queued' || q.status === 'testing')
          ? '<div class="tk-qc-acts"><button type="button" class="secondary-btn" data-tk="qc-bench" data-qc="' + esc(q.id) + '">' + (q.status === 'testing' ? 'Open the bench test' : 'Start the bench test') + '</button></div>'
          : (q.status === 'passed' || q.status === 'failed') && res && Object.keys(res).length
            ? '<div class="tk-qc-acts"><button type="button" class="secondary-btn" data-tk="qc-report" data-qc="' + esc(q.id) + '">Print the QC report</button></div>' : '');
  }

  // ── an RMA part ─────────────────────────────────────────────────────────
  function unitPage(id) {
    var d = D(), m = M();
    var u = d && d.unit ? d.unit(id) : null;
    if (!u || !m) return '';
    var now = Date.now();
    var v = d.vendor ? d.vendor(u.vendor_id) : null;
    var it = d.intake ? d.intake(u.intake_id) : null;
    var job = u.service_job_id && d.job ? d.job(u.service_job_id) : null;
    var rs = m.rmaStepsFor(u);
    var subs = rs.steps.map(function (st, i) {
      var state = rs.states[i];
      if (state === 'failed') return rs.why;
      if (state === 'now') return rs.sub;
      if (state !== 'done') return '';
      switch (i) {
        case 0: return fmtDate(u.created_at);
        case 1: return fmtDate(u.checked_at);
        case 2: return u.warranty_until ? 'Valid till ' + fmtDate(u.warranty_until) : fmtDate(u.verified_at);
        case 3: return fmtDate(u.submitted_at);
        case 4: return u.vendor_rma_no ? 'No. ' + u.vendor_rma_no : fmtDate(u.vendor_accepted_at);
        case 5: return fmtDate(u.vendor_ready_at);
        case 6: return u.vendor_result ? lbl(m.RMA_VENDOR_RESULTS, u.vendor_result) : '';
        case 7: return fmtDate(u.closed_at);
      }
      return '';
    });
    var party = (u.brand && String(u.brand).trim()) || (v && (v.public_name || v.name)) || '';
    var sentence = m.rmaWaitingSentence(Object.assign({}, u, { waiting_party: party || null }), v) || m.rmaStaffLabel(u.stage);
    var risk = m.rmaRisk(u, now, v);
    var owner = u.owner_phone ? (u.owner_name || 'End customer') : (it && it.sender_name) || 'Customer';
    var phone = u.owner_phone || (it && it.sender_phone) || '';
    var title = [m.itemKindLabel(u.kind), [u.brand, u.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    var sub = [esc(owner), phone ? esc(showPhone(phone)) : '', job ? 'from ticket <button type="button" class="tk-link" data-tk-job="' + esc(job.id) + '">' + esc(job.public_code || '') + '</button>' : ''].filter(Boolean).join(' · ');

    var part = facts([
      ['Serial', u.serial],
      ['The complaint', u.fault],
      ['Our check', u.check_result ? lbl(m.RMA_CHECK_RESULTS, u.check_result) + (u.checked_by ? ' · ' + u.checked_by : '') + (u.checked_at ? ', ' + fmtDate(u.checked_at) : '') : ''],
      ['What we found', u.our_finding, 'tk-strong'],
      ['Data on the drive', u.data_handling ? lbl(m.DATA_HANDLING, u.data_handling) : (u.kind === 'ssd' || u.kind === 'hdd') ? 'Not recorded yet' : '']
    ]);
    var warranty = facts([
      ['Bought', lbl(m.PURCHASE_SOURCES, u.purchase_source) + (u.invoice_no ? ' · invoice ' + u.invoice_no : '') + (u.purchase_date ? ' · ' + fmtDate(u.purchase_date) : '')],
      ['Warranty valid till', u.warranty_until ? fmtDate(u.warranty_until) : ''],
      ['Verified', u.verified_at ? (u.verify_problem ? lbl(m.RMA_VERIFY_PROBLEMS, u.verify_problem) : 'Eligible') + (u.verified_by ? ' · ' + u.verified_by : '') + ', ' + fmtDate(u.verified_at) : '']
    ]);
    var centre = facts([
      ['Service centre', v ? (v.name || v.public_name) : ''],
      ['Submitted', u.submitted_at ? fmtDate(u.submitted_at) + (u.submitted_by ? ' by ' + u.submitted_by : '') : ''],
      ['RMA / job no.', u.vendor_rma_no],
      ['Accepted', u.vendor_accepted_at ? fmtDate(u.vendor_accepted_at) + (u.vendor_progress ? ' · ' + lbl(m.RMA_VENDOR_PROGRESS, u.vendor_progress) : '') : ''],
      ['Expected back', u.expected_back_at && u.stage === 'with_vendor' ? fmtDate(u.expected_back_at) : ''],
      ['Ready at the centre', u.vendor_ready_at ? fmtDate(u.vendor_ready_at) + ' · ' + lbl(m.RMA_READY_VIA, u.vendor_ready_via) : ''],
      ['Result', u.vendor_result ? lbl(m.RMA_VENDOR_RESULTS, u.vendor_result) + (u.vendor_reason ? ' — ' + u.vendor_reason : '') : '', u.vendor_result === 'rejected' ? 'tk-bad' : ''],
      ['Replacement serial', u.replacement_serial]
    ]);
    var back = facts([
      ['How it goes back', u.return_confirmed === false ? 'Not decided yet' : lbl(m.RETURN_METHODS, u.return_method)],
      ['Return address', u.return_method === 'courier' ? u.return_address : ''],
      ['Returned by', [u.return_courier, u.return_awb].filter(Boolean).join(' · ')],
      ['Outcome', u.stage === 'closed' ? lbl(m.RMA_DISPOSITIONS, u.disposition) : '']
    ]);
    var main = section('The part', part) + section('Warranty', warranty) + section('At the service centre', centre) +
      section('Back to the customer', back) +
      section('Photos and documents', '<div id="tk-photos" class="tk-photos"><p class="tk-muted">Loading…</p></div>') +
      section('History', '<div id="tk-history" class="tk-history"><p class="tk-muted">Loading the history…</p></div>');

    var flags = [];
    if (rs.failed >= 0) flags.push(['red', rs.why, 'The claim stopped at “' + rs.steps[rs.failed].label + '”']);
    if (risk === 2) flags.push(['red', 'Late at this step', u.stage === 'with_vendor' && u.vendor_ready_at && u.vendor_ready_via === 'collect' ? 'Not collected within ' + (m.RMA_COLLECT_DAYS || 2) + ' days' : '']);
    if (u.holds_ticket && u.stage !== 'closed') flags.push(['blue', 'The service ticket waits for this part', job ? job.public_code : '']);
    var feeOpen = u.fee_status && ['n_a', 'paid', 'waived'].indexOf(u.fee_status) === -1;
    if (feeOpen) flags.push(['amber', 'Handling fee ' + (lbl(m.FEE_STATUSES, u.fee_status) || u.fee_status).toLowerCase(), u.handling_fee != null ? inr(u.handling_fee) : '']);
    if ((u.kind === 'ssd' || u.kind === 'hdd') && !u.data_handling) flags.push(['amber', 'Drive data not recorded', 'Needed before it goes to the centre']);
    if (u.return_confirmed === false && u.stage !== 'closed') flags.push(['blue', 'Return method not decided', 'Asked when the part is back']);
    if (u.purchase_source === 'elsewhere') flags.push(['blue', 'Bought elsewhere', 'Invoice and handling fee needed']);
    var status = facts([
      ['Step', 'Step ' + (rs.current + 1) + ' of ' + rs.steps.length + ': ' + rs.steps[rs.current].full],
      ['Stage', m.rmaStaffLabel(u.stage)],
      ['Handled by', u.handler_name || 'Nobody yet'],
      ['Came in', [fmtDate(it && it.received_at || u.created_at), it && it.created_by_name ? 'by ' + it.created_by_name : ''].filter(Boolean).join(' ')]
    ]);
    var rail = section('Status', status, 'tk-card') + section('Flags', flagsHtml(flags), 'tk-card') + section('Notes', notesBox(), 'tk-card');

    // At the centre the stage stays "with vendor" across steps 4-6: count the
    // days from when the current step began, not from the stage.
    var since = u.stage === 'with_vendor' ? (ms(u.vendor_ready_at) || ms(u.vendor_accepted_at) || ms(u.submitted_at) || ms(u.stage_since)) : null;
    var days = since != null ? Math.max(0, (now - since) / 86400000) : m.daysInStage(u, now);
    return head(u.public_code || '', 'Warranty claim', title, sub, '') +
      '<div class="tk-status">' + stepBar(rs.steps, rs.states, subs, 'Where this RMA is') +
        nowRow(m.rmaBallOf(u), sentence, days, risk, '') + '</div>' +
      '<div class="tk-grid"><div class="tk-main">' + main + '</div><aside class="tk-rail">' + rail + '</aside></div>';
  }

  // ── history, notes and photos (read when the page opens) ────────────────
  async function loadAsync(mySeq) {
    var d = D();
    if (!d || !cur) return;
    var at = cur;
    var evs = [];
    try { evs = at.kind === 'job' ? await d.events(at.id) : await d.rmaEvents(at.id); } catch (e) { evs = null; }
    if (mySeq !== seq || cur !== at) return;
    var hist = root.querySelector('#tk-history');
    var notes = root.querySelector('#tk-notes');
    if (evs === null) {
      if (hist) hist.innerHTML = '<p class="tk-muted">Could not load the history.</p>';
      if (notes) notes.innerHTML = '<p class="tk-muted">Could not load the notes.</p>';
    } else {
      evs = evs.slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
      var noteRows = evs.filter(function (e) { return e.kind === 'note'; });
      var wantPhotos = noteRows.some(function (e) { return e.meta && Array.isArray(e.meta.media_ids) && e.meta.media_ids.length; });
      var byId = {};
      if (wantPhotos) {
        var mrows = [];
        try { mrows = await d.media(at.kind === 'job' ? { jobId: at.id, includeUnits: false } : { caseId: at.id }); } catch (e) { mrows = []; }
        if (mySeq !== seq || cur !== at) return;
        (mrows || []).forEach(function (r) { if (r && r.id != null) byId[String(r.id)] = r; });
      }
      noteShots = {};
      if (notes) {
        notes.innerHTML = noteRows.length ? noteRows.map(function (e) {
          var ids = (e.meta && Array.isArray(e.meta.media_ids)) ? e.meta.media_ids : [];
          var shots = ids.map(function (id) { return byId[String(id)]; }).filter(Boolean);
          noteShots[String(e.id)] = shots;
          return '<article class="tk-note' + (e.customer_visible ? ' is-public' : '') + '">' +
            '<div class="tk-note-meta"><strong>' + esc(e.actor_name || 'Staff') + '</strong> · ' + esc(fmtDateTime(e.at)) +
              (e.customer_visible ? ' <span class="tk-chip tk-chip-public">Customer sees this</span>' : '') + '</div>' +
            '<div class="tk-note-body">' + esc(e.body || '') + '</div>' +
            (shots.length ? '<div class="tk-note-photos">' + shots.map(function (r, i) {
              return r.url && !r.is_heic
                ? '<button type="button" class="tk-note-shot" data-tk-shot="' + esc(String(e.id)) + ':' + i + '" aria-label="Open photo ' + (i + 1) + '"><img src="' + esc(r.url) + '" alt="" loading="lazy"></button>'
                : '<span class="tk-note-shot tk-note-shot-x">Photo</span>';
            }).join('') + '</div>' : (ids.length ? '<p class="tk-muted">' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + ' (not loaded)</p>' : '')) +
          '</article>';
        }).join('') : '<p class="tk-muted">No notes yet.</p>';
      }
      if (hist) {
        var rows = evs.filter(function (e) { return e.kind !== 'note'; }).slice(0, 60);
        hist.innerHTML = rows.length ? '<ol class="tk-tl">' + rows.map(function (e) {
          var body = e.body || (e.to_stage ? (at.kind === 'job' ? M().staffLabel(e.to_stage) : M().rmaStaffLabel(e.to_stage)) : e.kind);
          return '<li class="tk-tl-i' + (e.customer_visible ? ' is-public' : '') + '"><span class="tk-tl-when">' + esc(fmtDateTime(e.at)) + '</span>' +
            '<span class="tk-tl-body">' + esc(body) + '</span>' +
            '<span class="tk-tl-who">' + esc(e.actor_name || '') + (e.customer_visible ? ' · customer sees this' : '') + '</span></li>';
        }).join('') + '</ol>' : '<p class="tk-muted">Nothing recorded yet.</p>';
      }
    }
    var ph = root.querySelector('#tk-photos');
    if (ph && at.kind === 'unit') {
      var rowsM = [];
      try { rowsM = await d.media({ caseId: at.id }); } catch (e) { rowsM = null; }
      if (mySeq !== seq || cur !== at) return;
      if (rowsM === null) { ph.innerHTML = '<p class="tk-muted">Could not load the photos.</p>'; return; }
      var M2 = M();
      ph.innerHTML = rowsM.length ? rowsM.map(function (r) {
        var role = lbl(M2.MEDIA_ROLES, r.display_role || r.role) || 'Photo';
        return '<figure class="tk-photo">' + (r.url && !r.is_pdf && !r.is_heic ? '<img src="' + esc(r.url) + '" alt="' + esc(role) + '" loading="lazy">' :
          '<div class="tk-photo-doc">' + (r.is_pdf ? 'PDF' : 'File') + '</div>') +
          '<figcaption>' + esc(role) + '</figcaption></figure>';
      }).join('') : '<p class="tk-muted">No photos or documents yet. Add them in Edit → Photos.</p>';
    }
  }

  function errText(e) {
    var msg = String((e && e.message) || e).replace(/^NEO_[A-Z]+:\s*/, '');
    return /DEMO_READONLY/.test(msg) ? 'Demo data is read-only.' : msg;
  }
  // Photos first (each upload returns its row), then the note with their ids.
  // A failed note keeps the uploaded ids, so pressing again does not upload
  // the same photos twice.
  async function addNote() {
    var d = D();
    var at = cur;
    var ta = root.querySelector('#tk-note');
    var body = String((ta || {}).value || '').trim();
    var vis = !!(root.querySelector('#tk-note-visible') || {}).checked;
    var st = root.querySelector('#tk-note-status');
    var say = function (m, k) { if (st && cur === at) { st.textContent = m; st.className = 'sv-status' + (k ? ' ' + k : ''); } };
    if (!body) { say('Write the note first.', 'err'); return; }
    var btn = root.querySelector('[data-tk="add-note"]');
    if (btn) btn.disabled = true;
    try {
      var ids = (pendingIds && noteTrayFor === at.kind + ':' + at.id) ? pendingIds.slice() : [];
      if (trayCount() > 0) {
        say('Uploading the photos…', '');
        var r = await window.NeoQcPhotoTray.uploadAll(noteTray, at.kind === 'job' ? { jobId: at.id } : { caseId: at.id }, function () {});
        (r && r.rows || []).forEach(function (row) { if (row && row.id != null) ids.push(row.id); });
        pendingIds = ids.slice();
        if (r && r.failed && r.failed.length) {
          say(r.failed.length + ' photo' + (r.failed.length === 1 ? '' : 's') + ' did not upload (' + r.failed[0].error + '). Press Add note to try again.', 'err');
          return;
        }
      }
      if (at.kind === 'job') await d.addNote(at.id, body, vis, ids);
      else await d.rmaNote(at.id, body, vis, ids);
      pendingIds = null;
      if (cur !== at) return;
      if (ta) ta.value = '';
      say('Note added.' + (ids.length ? ' With ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + '.' : ''), 'ok');
      loadAsync(++seq);
    } catch (e) {
      say('Could not add the note: ' + errText(e), 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  var noteShots = {};
  function onClick(e) {
    var t = e.target;
    var sh = t.closest('[data-tk-shot]');
    if (sh) {
      var key = String(sh.getAttribute('data-tk-shot')).split(':');
      var list = noteShots[key[0]] || [];
      var U = window.NeoQcUI;
      if (U && typeof U.lightbox === 'function') {
        U.lightbox(list.map(function (r) { return { url: r.url, title: 'With a note', sub: r.uploaded_name || '' }; }), Number(key[1]) || 0);
      }
      return;
    }
    var u = t.closest('[data-tk-unit]');
    if (u) { openUnit(u.getAttribute('data-tk-unit')); return; }
    var j = t.closest('[data-tk-job]');
    if (j) { openJob(j.getAttribute('data-tk-job')); return; }
    var a = t.closest('[data-tk]');
    if (!a) return;
    var act = a.getAttribute('data-tk');
    if (act === 'close') { close(); return; }
    if (act === 'qc-report' || act === 'qc-bench') {
      var qid = a.getAttribute('data-qc');
      if (window.NeoQcBench && qid) {
        if (act === 'qc-report') window.NeoQcBench.printReport(qid, 'print');
        else { close(); window.NeoQcBench.open(qid); }
      }
      return;
    }
    if (act === 'add-note') { addNote(); return; }
    if (act === 'edit') {
      var at = cur;
      close();
      if (at && at.kind === 'job' && window.NeoQcServiceUI) window.NeoQcServiceUI.openJob(at.id);
      if (at && at.kind === 'unit' && window.NeoQcRmaUI) window.NeoQcRmaUI.openUnit(at.id);
      return;
    }
    if (act === 'copy-link') {
      var d = D();
      var row = cur && (cur.kind === 'job' ? d.job(cur.id) : d.unit(cur.id));
      var code = row && row.public_code;
      var c = C();
      var link = code ? ((c && typeof c.trackLink === 'function') ? c.trackLink(code) : code) : '';
      if (!link) return;
      try { navigator.clipboard.writeText(link).then(function () { toast('Tracking link copied.', 'success'); }, function () { toast(link, 'info'); }); }
      catch (err) { toast(link, 'info'); }
    }
  }

  window.NeoTicketSummary = { openJob: openJob, openUnit: openUnit, close: close, isOpen: isOpen };
})();
