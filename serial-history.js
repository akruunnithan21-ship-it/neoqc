/*
  Neo Service 1.17: the serial lookup (owner's brief §5, server v2.14
  serial_history). Type a serial on a new RMA part or a service item and,
  after a short pause, a panel under the field shows what we already know
  about that part:

    · earlier RMA claims for it (as the claimed part or a replacement we got
      back) — a repeat fault — with the centre, the result and the warranty.
      On a new RMA, "Use these details" copies the type, brand, model, where
      it was bought, the invoice and the build link into the part card, so
      the repeat claim takes seconds;
    · service tickets it came in on;
    · Neo Tokyo builds it went into.

  Claims whose warranty has ended are not listed (owner's rule): the panel
  only says how many there were. They stay in the customer's history.

  Attaches itself (delegated) to:
    #rma-intake-root  [data-f="serial"]   the New RMA part cards
    #svi-items        [data-f="serial"]   the service intake items
  window.NeoSerialHistory = { check(input) }
*/
(function () {
  'use strict';

  var SELECTOR = '#rma-intake-root [data-f="serial"], #svi-items [data-f="serial"]';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function D() { return window.NeoQcData || null; }
  function S() { return window.NeoQcService || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function day(v) {
    if (!v) return '';
    var s = String(v);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
    if (isNaN(d)) return '';
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  function kindLabel(k) {
    var s = S();
    var map = s && s.ITEM_KINDS;
    if (map && map[k]) return typeof map[k] === 'string' ? map[k] : (map[k].label || k);
    return k ? String(k).replace(/_/g, ' ') : '';
  }
  function rmaResult(r) {
    var s = S();
    var res = r.vendor_result && s && s.RMA_VENDOR_RESULTS && s.RMA_VENDOR_RESULTS[r.vendor_result];
    var disp = r.disposition && s && s.RMA_DISPOSITIONS && s.RMA_DISPOSITIONS[r.disposition];
    var lab = (res && (res.label || res)) || (disp && (disp.label || disp)) || '';
    if (r.stage !== 'closed') {
      var st = s && s.RMA_STAGES && s.RMA_STAGES[r.stage];
      return 'Open · ' + (st ? (typeof st === 'string' ? st : (st.staff || st.label || r.stage)) : String(r.stage || '').replace(/_/g, ' '));
    }
    return lab ? String(lab) : 'Closed';
  }

  function slotFor(input) {
    var item = input.closest('.svi-item');
    var after = item ? item.querySelector('[data-role="serial-sug"]') : input.closest('.sv-field');
    if (!after) after = input.parentElement;
    var next = after.nextElementSibling;
    if (next && next.classList.contains('nt-sh')) return next;
    var box = document.createElement('div');
    box.className = 'nt-sh sv-span2 hidden';
    box.setAttribute('role', 'status');
    after.parentNode.insertBefore(box, after.nextSibling);
    return box;
  }

  var timers = new WeakMap();
  var seqs = new WeakMap();

  function schedule(input) {
    clearTimeout(timers.get(input));
    var box = slotFor(input);
    var sn = norm(input.value);
    if (sn.length < 5) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    timers.set(input, setTimeout(function () { check(input); }, 650));
  }

  async function check(input) {
    var d = D();
    if (!d || typeof d.serialHistory !== 'function') return;
    var sn = norm(input.value);
    var box = slotFor(input);
    if (sn.length < 5) { box.classList.add('hidden'); return; }
    var seq = (seqs.get(input) || 0) + 1;
    seqs.set(input, seq);
    var res;
    try { res = await d.serialHistory(input.value); }
    catch (e) { return; /* a help, never a blocker */ }
    if (seqs.get(input) !== seq || norm(input.value) !== sn || !input.isConnected) return;
    render(input, box, res || {});
  }

  function render(input, box, res) {
    var rma = Array.isArray(res.rma) ? res.rma : [];
    var jobs = Array.isArray(res.jobs) ? res.jobs : [];
    var builds = Array.isArray(res.builds) ? res.builds : [];
    var hidden = Number(res.hidden_rma) || 0;
    var inRma = !!input.closest('#rma-intake-root');
    if (!rma.length && !jobs.length && !builds.length && !hidden) {
      box.innerHTML = '<div class="nt-sh-none">New serial — nothing on record for it.</div>';
      box.classList.remove('hidden');
      return;
    }
    var rows = [];
    rma.forEach(function (r, i) {
      var part = [r.brand, r.model].filter(Boolean).join(' ') || kindLabel(r.kind);
      var bits = [rmaResult(r), r.vendor_name, 'claimed ' + day(r.created_at)];
      if (r.warranty_until) bits.push('warranty till ' + day(r.warranty_until));
      if (r.matched === 'replacement') bits.push('this was the replacement we got back');
      rows.push('<li class="nt-sh-row"><span class="nt-sh-tag rma">RMA</span><div class="nt-sh-main"><b>' + esc(r.public_code) + '</b> · ' + esc(part) +
        '<small>' + esc(bits.filter(Boolean).join(' · ')) + (r.fault ? ' — “' + esc(String(r.fault).slice(0, 90)) + '”' : '') + '</small></div>' +
        (inRma ? '<button type="button" class="secondary-btn nt-sh-use" data-sh-use="' + i + '">Use these details</button>' : '') + '</li>');
    });
    jobs.forEach(function (j) {
      rows.push('<li class="nt-sh-row"><span class="nt-sh-tag svc">Service</span><div class="nt-sh-main"><b>' + esc(j.public_code) + '</b> · ' + esc(j.customer_name || '') +
        '<small>' + esc([j.item_label || j.device_label, j.stage === 'closed' ? 'closed ' + day(j.closed_at) : 'open', 'booked ' + day(j.created_at)].filter(Boolean).join(' · ')) + '</small></div></li>');
    });
    builds.forEach(function (b) {
      rows.push('<li class="nt-sh-row"><span class="nt-sh-tag bld">Build</span><div class="nt-sh-main"><b>#' + esc(b.code) + '</b> · ' + esc(b.customer_name || '') +
        '<small>' + esc([b.summary, 'built by Neo Tokyo', day(b.handed_over_at || b.completed_at || b.created_at)].filter(Boolean).join(' · ')) + '</small></div></li>');
    });
    var head = rma.length ? (rma.length === 1 ? 'This part has been claimed before' : 'This part has been claimed ' + rma.length + ' times')
      : jobs.length ? 'This serial has been in for service' : builds.length ? 'This part went into a Neo Tokyo build' : 'Older claims only';
    box.innerHTML = '<div class="nt-sh-head"><span class="nt-sh-dot" aria-hidden="true"></span>' + esc(head) + '</div>' +
      (rows.length ? '<ul class="nt-sh-list">' + rows.join('') + '</ul>' : '') +
      (hidden ? '<div class="nt-sh-foot">' + hidden + ' older claim' + (hidden === 1 ? ' is' : 's are') + ' past the warranty and not shown here (still in the customer’s history).</div>' : '');
    box.classList.remove('hidden');
    box._sh = { rma: rma, input: input };
  }

  // "Use these details": copy the earlier claim into this part card.
  function useDetails(box, i) {
    var st = box._sh;
    if (!st || !st.rma[i]) return;
    var r = st.rma[i];
    var card = st.input.closest('.rma-in-unit') || st.input.closest('.rma-in-unit-card') || box.parentElement.closest('[data-unit]') || box.parentElement;
    var set = function (f, v) {
      if (v == null || v === '') return;
      var el = card.querySelector('[data-f="' + f + '"]');
      if (!el) return;
      el.value = f === 'purchase_date' ? String(v).slice(0, 10) : String(v).slice(0, 200);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('kind', r.kind);
    set('brand', r.brand);
    set('model', r.model);
    set('invoice_no', r.invoice_no);
    set('purchase_date', r.purchase_date ? String(r.purchase_date).slice(0, 10) : '');
    set('build_ticket_id', r.build_ticket_id);
    if (r.purchase_source) {
      var chip = Array.prototype.filter.call(card.querySelectorAll('.rma-in-buy [data-value]'), function (b) { return b.getAttribute('data-value') === r.purchase_source; })[0];
      if (chip && chip.getAttribute('aria-pressed') !== 'true') chip.click();
    }
    var U = window.NeoQcUI;
    if (U && typeof U.toast === 'function') U.toast('Copied from ' + r.public_code + '. Check the fault and the condition for this claim.', 'success');
  }

  document.addEventListener('input', function (e) {
    if (e.target && e.target.matches && e.target.matches(SELECTOR)) schedule(e.target);
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-sh-use]');
    if (!b) return;
    e.preventDefault();
    useDetails(b.closest('.nt-sh'), Number(b.getAttribute('data-sh-use')));
  });

  var css = document.createElement('style');
  css.textContent =
    '.nt-sh{margin:2px 0 4px;padding:12px 14px;border-radius:14px;background:var(--nt-brand-tint);border:1px solid rgba(var(--primary-pink-rgb),.25);font-family:var(--nt-font);animation:nt-pop-in .18s cubic-bezier(.16,1,.3,1)}' +
    '.nt-sh.hidden{display:none}' +
    '.nt-sh-head{display:flex;align-items:center;gap:8px;font-size:.84rem;font-weight:700;color:var(--nt-brand)}' +
    '.nt-sh-dot{width:8px;height:8px;border-radius:50%;background:var(--primary-pink);box-shadow:0 0 0 4px rgba(var(--primary-pink-rgb),.18)}' +
    '.nt-sh-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}' +
    '.nt-sh-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:11px;background:var(--nt-surface);border:1px solid var(--nt-hairline)}' +
    '.nt-sh-main{flex:1;min-width:0;font-size:.86rem;line-height:1.35;color:var(--text-dark)}.nt-sh-main small{display:block;color:var(--text-muted);font-size:.76rem;margin-top:2px}' +
    '.nt-sh-tag{flex:none;margin-top:1px;padding:2px 8px;border-radius:7px;font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}' +
    '.nt-sh-tag.rma{background:rgba(var(--primary-pink-rgb),.14);color:var(--nt-brand)}.nt-sh-tag.svc{background:var(--nt-info-tint,#E6EEF9);color:var(--nt-info-text,#24508F)}.nt-sh-tag.bld{background:var(--nt-success-tint,#DCF5E3);color:var(--nt-success-text,#146C34)}' +
    '.nt-sh-use{flex:none;padding:6px 12px !important;border-radius:10px !important;font-size:.78rem !important;white-space:nowrap;min-height:0 !important}' +
    '.nt-sh-foot{margin-top:8px;font-size:.76rem;color:var(--text-muted)}.nt-sh-none{font-size:.8rem;color:var(--text-muted)}' +
    '.nt-sh:has(.nt-sh-none){background:transparent;border-style:dashed;border-color:var(--nt-hairline);padding:8px 12px}';
  document.head.appendChild(css);

  window.NeoSerialHistory = { check: check };
})();
