/*
  Neo Service 1.16 — the QC screen's "After service" tab (owner's brief §10,
  decisions 25 Nov 2026: docs/redesign-2026-11/QC-SERVICE.md).

  Builds became QC: the screen keeps "New builds" (app.js, unchanged) and adds
  "After service": the service tickets whose customers asked for a QC test,
  in three columns — waiting for the bench, being tested, done (last 7 days).
  Each card shows the customer's goals, the stability length and the charge;
  a click opens the ticket's summary page. The card's button opens the bench
  test (qc-bench.js: health, stability, PresentMon for game FPS); a done card
  prints the one-page QC report.

  Reads NeoQcData.qcJobs() / job(); writes nothing here.
*/
(function () {
  'use strict';

  function D() { return window.NeoQcData || null; }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var DAY = 86400000;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ms(v) { var t = v ? Date.parse(v) : NaN; return isNaN(t) ? null : t; }
  function ago(v) {
    var t = ms(v);
    if (t == null) return '';
    var m = Math.max(0, (Date.now() - t) / 60000);
    if (m < 60) return Math.max(1, Math.round(m)) + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    var d = new Date(t);
    return d.getDate() + ' ' + MON[d.getMonth()];
  }
  function inr(n) { var v = Number(n); return isFinite(v) ? '₹' + v.toLocaleString('en-IN') : ''; }

  var tab = 'builds';
  try { if (sessionStorage.getItem('neo.qcTab') === 'service') tab = 'service'; } catch (e) { /* default */ }

  function goalLine(g) {
    if (!g) return '';
    if (g.kind === 'game') return g.name + (g.settings ? ' · ' + g.settings : '') + ' · ' + g.target_fps + ' fps';
    return g.app + ' · ' + g.task + (g.max_minutes ? ' · within ' + g.max_minutes + ' min' : '');
  }

  function card(q) {
    var d = D();
    var job = d && typeof d.job === 'function' ? d.job(q.job_id) : null;
    var goals = Array.isArray(q.goals) ? q.goals : [];
    var done = q.status === 'passed' || q.status === 'failed';
    var state = q.status === 'testing' ? 'Being tested' + (q.tested_by_name ? ' by ' + q.tested_by_name : '') + (q.started_at ? ' · ' + ago(q.started_at) : '')
      : q.status === 'queued' ? 'Sent ' + ago(q.requested_at) + (q.requested_by_name ? ' by ' + q.requested_by_name : '')
      : (q.status === 'passed' ? 'Passed' : 'Did not pass') + ' · ' + ago(q.finished_at);
    return '<article class="qcs-card is-' + esc(q.status) + '" data-job="' + esc(q.job_id) + '" role="button" tabindex="0">' +
      '<div class="qcs-card-h"><span class="qcs-who">' + esc(job ? job.customer_name : 'Ticket') + '</span>' +
        (done ? '<span class="qcs-verdict ' + (q.status === 'passed' ? 'ok' : 'bad') + '">' + (q.status === 'passed' ? '✓ Passed' : '✕ Not passed') + '</span>' : '') + '</div>' +
      '<div class="qcs-sub">' + esc([job && job.public_code, job && job.device_label].filter(Boolean).join(' · ')) + '</div>' +
      (goals.length ? '<ul class="qcs-goals">' + goals.map(function (g) {
        return '<li class="qcs-goal k-' + esc(g.kind) + '"><span class="qcs-goal-k">' + (g.kind === 'game' ? 'Game' : 'Work') + '</span>' + esc(goalLine(g)) + '</li>';
      }).join('') + '</ul>' : '<p class="qcs-none">Health and stability only</p>') +
      (q.customer_words ? '<p class="qcs-words">“' + esc(q.customer_words) + '”</p>' : '') +
      (done && q.summary ? '<p class="qcs-summary">' + esc(q.summary) + '</p>' : '') +
      '<div class="qcs-foot"><span class="qcs-chip">' + esc(q.stability_minutes || 15) + ' min stability</span>' +
        '<span class="qcs-chip ' + (q.charge === 'paid' ? 'paid' : '') + '">' + (q.charge === 'paid' ? 'Paid ' + esc(inr(q.amount)) : 'Free') + '</span>' +
        '<span class="qcs-state">' + esc(state) + '</span></div>' +
      // 1.16: the bench test runs on the customer's PC (qc-bench.js); done ones print the report.
      (window.NeoQcBench && (q.status === 'queued' || q.status === 'testing')
        ? '<button type="button" class="qcs-bench" data-bench="' + esc(q.id) + '">' + (q.status === 'testing' ? 'Open the bench test' : 'Start the bench test') + '</button>'
        : window.NeoQcBench && done && q.results && Object.keys(q.results).length
          ? '<button type="button" class="qcs-bench ghost" data-report="' + esc(q.id) + '">Print the QC report</button>' : '') +
    '</article>';
  }

  function render() {
    var root = el('qc-service-root');
    if (!root) return;
    var d = D();
    var all = d && typeof d.qcJobs === 'function' ? d.qcJobs() : [];
    var now = Date.now();
    var queued = all.filter(function (q) { return q.status === 'queued'; });
    var testing = all.filter(function (q) { return q.status === 'testing'; });
    var done = all.filter(function (q) { return (q.status === 'passed' || q.status === 'failed') && (now - (ms(q.finished_at) || 0)) < 7 * DAY; });
    var n = el('qc-service-n');
    if (n) n.textContent = (queued.length + testing.length) ? String(queued.length + testing.length) : '';
    var col = function (title, hint, list, cls) {
      return '<section class="qcs-col ' + cls + '"><header class="qcs-col-h"><h3>' + esc(title) + '</h3><span class="qcs-n">' + list.length + '</span></header>' +
        '<p class="qcs-col-s">' + esc(hint) + '</p>' +
        (list.length ? list.map(card).join('') : '<div class="qcs-empty">Nothing here</div>') + '</section>';
    };
    root.innerHTML =
      '<p class="qcs-lead">Service tickets whose customers asked for a QC test. The bench PC runs a short health check, the CPU + GPU stability test, then the customer’s own goals: a game at their settings (FPS measured with PresentMon) or the work that used to fail. No serial numbers and no build checks.</p>' +
      '<div class="qcs-board">' +
        col('Waiting for the bench', 'Sent from Service, at Testing', queued, 'c-queued') +
        col('Being tested', 'On the bench PC now', testing, 'c-testing') +
        col('Done', 'Last 7 days', done, 'c-done') +
      '</div>';
  }

  function setTab(t) {
    tab = t === 'service' ? 'service' : 'builds';
    try { sessionStorage.setItem('neo.qcTab', tab); } catch (e) { /* per-session nicety */ }
    var screen = el('staff-screen');
    if (screen) screen.classList.toggle('qc-show-service', tab === 'service');
    Array.prototype.forEach.call(document.querySelectorAll('.qc-tab'), function (b) {
      var on = b.getAttribute('data-qc-tab') === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (tab === 'service') {
      var d = D();
      if (d && typeof d.ensureLoaded === 'function') { try { d.ensureLoaded(); } catch (e) { /* render what is cached */ } }
      render();
    }
  }

  function init() {
    var tabs = document.querySelector('.qc-tabs');
    if (tabs && !tabs.dataset.bound) {
      tabs.dataset.bound = '1';
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('[data-qc-tab]');
        if (b) setTab(b.getAttribute('data-qc-tab'));
      });
    }
    var root = el('qc-service-root');
    if (root && !root.dataset.bound) {
      root.dataset.bound = '1';
      var open = function (c) {
        if (!c) return;
        var id = c.getAttribute('data-job');
        if (window.NeoTicketSummary) window.NeoTicketSummary.openJob(id);
        else if (window.NeoQcServiceUI) window.NeoQcServiceUI.openJob(id);
      };
      root.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bench]');
        if (b && window.NeoQcBench) { window.NeoQcBench.open(b.getAttribute('data-bench')); return; }
        var p = e.target.closest('[data-report]');
        if (p && window.NeoQcBench) { window.NeoQcBench.printReport(p.getAttribute('data-report'), 'print'); return; }
        open(e.target.closest('.qcs-card'));
      });
      root.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('button')) return;
        var c = e.target.closest('.qcs-card');
        if (c) { e.preventDefault(); open(c); }
      });
    }
    var d = D();
    if (d && typeof d.on === 'function' && !init.subscribed) {
      init.subscribed = true;
      d.on('*', function (evs) {
        var kinds = Array.isArray(evs) ? evs : [String(evs || '')];
        if (tab === 'service' && kinds.some(function (k) { return k === 'qc' || k === 'jobs'; })) render();
        else if (kinds.indexOf('qc') !== -1) {
          var n = el('qc-service-n');
          var all = d.qcJobs ? d.qcJobs() : [];
          var open = all.filter(function (q) { return q.status === 'queued' || q.status === 'testing'; }).length;
          if (n) n.textContent = open ? String(open) : '';
        }
      });
    }
    setTab(tab);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.NeoQcServiceQc = { render: render, setTab: setTab };
})();
