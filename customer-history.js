/*
  Neo Service 1.17: the customer history page (owner's brief §6, server v2.14
  customer_history). One customer, everything we have done for them:

    · their record (name, phone, kind, address, notes) and a few numbers;
    · every service ticket — service history is never purged;
    · every RMA part they sent or own, including claims whose warranty has
      ended (those are hidden from the serial lookup, not from here);
    · the builds they bought from us.

  Newest first, filterable (All / Service / RMA / Builds). A click opens the
  ticket's own summary page on top (ticket-summary.js / build-summary.js);
  closing it comes back here.

  Opened from the ticket summary's "Customer history" button, the returning-
  customer card in service intake and the New RMA phone lookup.
  window.NeoCustomerHistory = { open(phone, nameHint), close() }
*/
(function () {
  'use strict';

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function D() { return window.NeoQcData || null; }
  function S() { return window.NeoQcService || null; }
  function U() { return window.NeoQcUI || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m, t) { var u = U(); if (u && u.toast) u.toast(m, t || 'info'); }
  function day(v) {
    if (!v) return '';
    var s = String(v);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
    if (isNaN(d)) return '';
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  function inr(n) { var v = Number(n); return isFinite(v) && v > 0 ? '₹' + Math.round(v).toLocaleString('en-IN') : ''; }
  function phoneFmt(p) {
    var u = U();
    if (u && typeof u.fmtPhone === 'function') { try { return u.fmtPhone(p); } catch (e) { /* plain */ } }
    return String(p || '');
  }
  function staffStage(st) {
    var s = S();
    try { if (s && typeof s.staffLabel === 'function') return s.staffLabel(st); } catch (e) { /* plain */ }
    return String(st || '').replace(/_/g, ' ');
  }
  function rmaStage(st) {
    var s = S();
    var d = s && s.RMA_STAGES && s.RMA_STAGES[st];
    return d ? (d.staff || st) : String(st || '').replace(/_/g, ' ');
  }
  function outcomeLabel(o) {
    var s = S();
    var d = s && s.OUTCOMES && s.OUTCOMES[o];
    return d ? (typeof d === 'string' ? d : (d.label || o)) : (o ? String(o).replace(/_/g, ' ') : '');
  }
  function kindLabel(k) {
    var s = S();
    var d = s && s.ITEM_KINDS && s.ITEM_KINDS[k];
    return d ? (typeof d === 'string' ? d : (d.label || k)) : (k || '');
  }
  function rmaResult(r) {
    var s = S();
    var res = r.vendor_result && s && s.RMA_VENDOR_RESULTS && s.RMA_VENDOR_RESULTS[r.vendor_result];
    var disp = r.disposition && s && s.RMA_DISPOSITIONS && s.RMA_DISPOSITIONS[r.disposition];
    return String((res && (res.label || res)) || (disp && (disp.label || disp)) || 'Closed');
  }

  var root = null, state = null;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'ch-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Customer history');
    root.innerHTML = '<div class="ch-sheet"><div class="ch-page" id="ch-page"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    root.addEventListener('click', onClick);
    // Capture phase: this runs before the summary's own Esc handler, so one Esc
    // closes the summary on top and leaves this page open.
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      if (window.NeoTicketSummary && window.NeoTicketSummary.isOpen && window.NeoTicketSummary.isOpen()) return;
      if (window.NeoBuildSummary && window.NeoBuildSummary.isOpen && window.NeoBuildSummary.isOpen()) return;
      var u = U();
      if (u && u.isDialogOpen && u.isDialogOpen()) return;
      close();
    }, true);
    return root;
  }
  function isOpen() { return !!(root && root.classList.contains('open')); }
  function close() {
    if (!root) return;
    root.classList.remove('open');
    document.body.classList.remove('ch-open');
    state = null;
  }

  async function open(phone, nameHint) {
    var d = D();
    if (!d || typeof d.customerHistory !== 'function') { toast('Customer history is not available here.', 'warning'); return; }
    ensureRoot();
    state = { phone: phone, name: nameHint || '', tab: 'all', data: null, loading: true, error: null };
    paint();
    root.classList.add('open');
    document.body.classList.add('ch-open');
    try { state.data = await d.customerHistory(phone); }
    catch (e) { state.error = (U() && U().errText) ? U().errText(e) : ((e && e.message) || String(e)); }
    if (!state) return;
    state.loading = false;
    paint();
  }

  function entries(data) {
    var out = [];
    (data.jobs || []).forEach(function (j) {
      out.push({ type: 'svc', id: j.id, at: j.created_at, code: j.public_code,
        title: j.device_label || 'Service ticket',
        sub: [j.reported_fault ? '“' + String(j.reported_fault).slice(0, 110) + '”' : '', j.assignee].filter(Boolean).join(' · '),
        status: j.stage === 'closed' ? (outcomeLabel(j.outcome) || 'Closed') : staffStage(j.stage),
        open: j.stage !== 'closed', money: inr(j.bill_total),
        when: j.stage === 'closed' && j.closed_at ? 'Closed ' + day(j.closed_at) : 'Booked ' + day(j.created_at) });
    });
    (data.rma || []).forEach(function (r) {
      out.push({ type: 'rma', id: r.id, at: r.created_at, code: r.public_code,
        title: [r.brand, r.model].filter(Boolean).join(' ') || kindLabel(r.kind),
        sub: [kindLabel(r.kind), r.serial ? 'S/N ' + r.serial : '', r.fault ? '“' + String(r.fault).slice(0, 90) + '”' : ''].filter(Boolean).join(' · '),
        status: r.stage === 'closed' ? rmaResult(r) : rmaStage(r.stage), open: r.stage !== 'closed',
        warrantyOver: !!r.warranty_over, warranty: r.warranty_until ? day(r.warranty_until) : '',
        when: r.stage === 'closed' && r.closed_at ? 'Closed ' + day(r.closed_at) : 'Claimed ' + day(r.created_at) });
    });
    (data.builds || []).forEach(function (b) {
      out.push({ type: 'bld', id: b.id, at: b.created_at, code: '#' + b.code, title: b.summary || 'Neo Tokyo build',
        sub: '', status: b.status === 'completed' ? 'Finished' : 'In progress', open: b.status !== 'completed',
        when: b.handed_over_at ? 'Handed over ' + day(b.handed_over_at) : b.completed_at ? 'Finished ' + day(b.completed_at) : 'Booked ' + day(b.created_at) });
    });
    out.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    return out;
  }

  function paint() {
    var page = document.getElementById('ch-page');
    if (!page || !state) return;
    var data = state.data || {};
    var c = data.customer || {};
    var name = c.name || state.name || 'Customer';
    var list = state.data ? entries(data) : [];
    var nSvc = (data.jobs || []).length, nRma = (data.rma || []).length, nBld = (data.builds || []).length;
    var openSvc = (data.jobs || []).filter(function (j) { return j.stage !== 'closed'; }).length;
    var openRma = (data.rma || []).filter(function (r) { return r.stage !== 'closed'; }).length;
    var billed = (data.jobs || []).reduce(function (t, j) { return t + (Number(j.bill_total) || 0); }, 0);
    var first = list.length ? list[list.length - 1].at : c.created_at;
    var initials = String(name).trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    var tabs = [['all', 'All', list.length], ['svc', 'Service', nSvc], ['rma', 'RMA', nRma], ['bld', 'Builds', nBld]];
    var shown = state.tab === 'all' ? list : list.filter(function (x) { return x.type === state.tab; });
    var tag = { svc: 'Service', rma: 'RMA', bld: 'Build' };
    var body;
    if (state.loading) body = '<div class="ch-empty"><span class="ch-spin"></span>Gathering everything for this customer…</div>';
    else if (state.error) body = '<div class="ch-empty ch-err">' + esc(state.error) + '</div>';
    else if (!shown.length) body = '<div class="ch-empty">Nothing here yet.</div>';
    else body = '<ol class="ch-list">' + shown.map(function (x) {
      return '<li><button type="button" class="ch-row t-' + x.type + (x.open ? ' is-open' : '') + '" data-ch-type="' + x.type + '" data-ch-id="' + esc(x.id) + '">' +
        '<span class="ch-tag">' + tag[x.type] + '</span>' +
        '<span class="ch-main"><span class="ch-title"><b>' + esc(x.code) + '</b> ' + esc(x.title) + '</span>' +
          (x.sub ? '<span class="ch-sub">' + esc(x.sub) + '</span>' : '') + '</span>' +
        '<span class="ch-side"><span class="ch-status' + (x.open ? ' open' : '') + '">' + esc(x.status) + '</span>' +
          (x.warrantyOver ? '<span class="ch-chip muted">Warranty ended ' + esc(x.warranty) + '</span>' : x.warranty ? '<span class="ch-chip">Warranty till ' + esc(x.warranty) + '</span>' : '') +
          '<span class="ch-when">' + esc(x.when) + (x.money ? ' · ' + esc(x.money) : '') + '</span></span>' +
      '</button></li>';
    }).join('') + '</ol>';
    page.innerHTML =
      '<header class="ch-head"><div class="ch-avatar" aria-hidden="true">' + esc(initials || '•') + '</div>' +
        '<div class="ch-head-main"><div class="ch-eyebrow">Customer history</div><h2 class="ch-name">' + esc(name) + '</h2>' +
        '<div class="ch-meta">' + esc([phoneFmt(data.phone_norm || state.phone), c.alt_phone ? 'also ' + phoneFmt(c.alt_phone) : '', c.email].filter(Boolean).join(' · ')) +
          (c.kind === 'business' ? ' <span class="ch-chip">Business</span>' : '') + '</div></div>' +
        '<button type="button" class="ch-x" data-ch-act="close" aria-label="Close">×</button></header>' +
      '<section class="ch-kpis">' +
        kpi(nSvc, 'Service tickets', openSvc ? openSvc + ' open' : 'none open') +
        kpi(nRma, 'RMA parts', openRma ? openRma + ' open' : 'none open') +
        kpi(nBld, 'Builds from us', nBld ? 'bought from Neo Tokyo' : '—') +
        kpi(billed ? inr(billed) : '—', 'Billed for service', 'all tickets') +
        kpi(first ? day(first) : '—', 'Customer since', 'first record') +
      '</section>' +
      ((c.address || c.area || c.notes) ? '<section class="ch-card">' +
        (c.address || c.area ? '<div class="ch-fact"><span>Address</span><b>' + esc([c.address, c.landmark, c.area, c.pincode].filter(Boolean).join(', ')) + '</b>' +
          (c.maps_url ? ' <a class="ch-link" href="#" data-ch-act="map">Map</a>' : '') + '</div>' : '') +
        (c.notes ? '<div class="ch-fact"><span>Notes</span><b>' + esc(c.notes) + '</b></div>' : '') + '</section>' : '') +
      '<nav class="ch-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button type="button" role="tab" class="ch-tab' + (state.tab === t[0] ? ' active' : '') + '" data-ch-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' +
          esc(t[1]) + ' <span>' + t[2] + '</span></button>';
      }).join('') + '</nav>' + body +
      '<p class="ch-foot">Service history is kept for good. RMA claims stay here after their warranty ends, even though the serial lookup stops suggesting them.</p>';
    function kpi(v, label, sub) {
      return '<div class="ch-kpi"><div class="ch-kpi-v">' + esc(v) + '</div><div class="ch-kpi-l">' + esc(label) + '</div><div class="ch-kpi-s">' + esc(sub) + '</div></div>';
    }
  }

  async function openEntry(type, id) {
    var d = D();
    try {
      if (type === 'svc') {
        if (d && typeof d.fetchJob === 'function' && !(d.job && d.job(id))) await d.fetchJob(id);
        if (window.NeoTicketSummary) window.NeoTicketSummary.openJob(id);
      } else if (type === 'rma') {
        if (d && typeof d.fetchUnit === 'function' && !(d.unit && d.unit(id))) await d.fetchUnit(id);
        if (window.NeoTicketSummary) window.NeoTicketSummary.openUnit(id);
      } else if (type === 'bld') {
        var local = (typeof appState !== 'undefined' && appState && appState.tickets || []).some(function (t) { return t && t.id === id; });
        if (local && window.NeoBuildSummary) window.NeoBuildSummary.open(id);
        else toast('That build is not on this PC yet. Open the QC screen once to load the builds.', 'info');
      }
    } catch (e) {
      toast('Could not open it: ' + ((U() && U().errText) ? U().errText(e) : (e && e.message)), 'error');
    }
  }

  function onClick(e) {
    var t = e.target.closest('[data-ch-tab]');
    if (t && state) { state.tab = t.getAttribute('data-ch-tab'); paint(); return; }
    var r = e.target.closest('[data-ch-type]');
    if (r) { openEntry(r.getAttribute('data-ch-type'), r.getAttribute('data-ch-id')); return; }
    var a = e.target.closest('[data-ch-act]');
    if (!a) return;
    var act = a.getAttribute('data-ch-act');
    if (act === 'close') close();
    else if (act === 'map' && state && state.data && state.data.customer && state.data.customer.maps_url) {
      e.preventDefault();
      var u = U();
      if (u && u.openExternal) u.openExternal(state.data.customer.maps_url);
    }
  }

  window.NeoCustomerHistory = { open: open, close: close, isOpen: isOpen };
})();
