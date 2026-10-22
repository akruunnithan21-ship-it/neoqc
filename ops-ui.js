/*
  Neo Tokyo Operations — the small UI kit every office module uses
  (window.NeoQcUI). Service, RMA, the intake form and the photo tray all build
  their screens from these pieces, so a date, an error, a chip or a dialog
  looks and behaves the same everywhere — and the safety rules (escaping, the
  scanner's Enter, local time) are implemented once instead of four times.

  Loaded after app.js and modules.js; uses escapeHtmlLite, showToast and
  showConfirm from app.js when they exist, and works without them (the dev
  harness, a unit test).

  RULES THIS FILE ENFORCES FOR ITS CALLERS
  - esc() is for element content and DOUBLE-quoted attributes. It escapes the
    single quote too, but callers still never put untrusted text in a
    single-quoted attribute or in inline JS (the CSP forbids inline handlers
    anyway).
  - Enter inside an <input> never submits or closes anything: a USB barcode
    scanner types like a keyboard and finishes with Enter.
  - datetime-local values are LOCAL time. They are parsed field by field, never
    handed to Date as a naive string that some engines read as UTC.
*/
(function () {
  'use strict';

  var DAY = 86400000;
  var DEMO_TEXT = 'Demo data is read-only. Turn it off in Settings to work on real tickets.';

  // ── text ───────────────────────────────────────────────────────────────────
  function esc(s) {
    var str = s == null ? '' : String(s);
    var out = (typeof escapeHtmlLite === 'function')
      ? escapeHtmlLite(str)
      : str.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    // escapeHtmlLite leaves ' alone. Escaping it costs nothing in element
    // content and closes the single-quoted-attribute mistake for good.
    return out.replace(/'/g, '&#39;');
  }

  // The message inside whatever was thrown: an Error, a PostgREST error
  // object, a storage error, a bare string.
  function rawMessage(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    if (e.error && typeof e.error === 'object' && e.error !== e) return rawMessage(e.error);
    var m = e.message || e.msg || e.error_description || (typeof e.error === 'string' ? e.error : '') || e.details || '';
    if (!m) { try { m = String(e); } catch (x) { m = ''; } }
    if (m === '[object Object]') m = '';
    return String(m);
  }

  // 'NEO_STALE', 'NEO_RMA_HOLD', 'DEMO_READONLY', a Postgres/PostgREST code
  // like '42501' or 'PGRST202', or ''. Lets a caller branch (e.g. offer
  // [Open RMA] on NEO_RMA_HOLD) without parsing sentences.
  function errCode(e) {
    var m = rawMessage(e);
    if (/\bDEMO_READONLY\b/.test(m)) return 'DEMO_READONLY';
    var mm = /\b(NEO_[A-Z_]+)\s*:/.exec(m);
    if (mm) return mm[1];
    if (e && typeof e === 'object') {
      if (e.code) return String(e.code);
      if (e.error && e.error.code) return String(e.error.code);
    }
    return '';
  }

  // A sentence a person at the counter can act on. Server rules raise
  // `NEO_<KIND>: <human sentence>`; that sentence is shown with the prefix
  // stripped. Everything else is translated from the transport's wording.
  function errText(e) {
    var m = rawMessage(e).trim();
    var code = (e && typeof e === 'object') ? String(e.code || (e.error && e.error.code) || '') : '';
    var status = (e && typeof e === 'object') ? Number(e.status || e.statusCode || 0) : 0;
    if (!m && !code) return 'Something went wrong. Try again.';
    if (/\bDEMO_READONLY\b/.test(m)) return DEMO_TEXT;

    var neo = /\bNEO_[A-Z_]+\s*:\s*([\s\S]*)$/.exec(m);
    if (neo) return neo[1].trim() || 'That was not allowed.';

    if (/failed to fetch|networkerror|network request failed|load failed|err_internet|err_network|enotfound|econnre|etimedout|fetch failed/i.test(m)) {
      return 'Could not reach the server. Check the internet connection and try again.';
    }
    if (code === 'PGRST301' || /jwt expired|invalid jwt|jwt.*(malformed|invalid)|refresh token/i.test(m)) {
      return 'Your sign-in has expired. Sign out and sign in again.';
    }
    if (code === 'PGRST202' || /could not find the function|function .* does not exist/i.test(m)) {
      return 'This needs the latest database update. Ask the admin to apply it, then try again.';
    }
    if (code === 'PGRST205' || code === '42P01' || /could not find the table|relation .* does not exist/i.test(m)) {
      return 'This needs the latest database update. Ask the admin to apply it, then try again.';
    }
    if (code === '42703' || /column .* does not exist/i.test(m)) {
      return 'This needs the latest database update. Ask the admin to apply it, then try again.';
    }
    if (code === '42501' || /row-level security|permission denied|not authori[sz]ed/i.test(m) || status === 401 || status === 403) {
      return "You don't have access to do that. Ask a lead if you think you should.";
    }
    if (/mime type .* (is )?not supported|invalid mime/i.test(m)) {
      return "The photo store doesn't accept this file type yet. Ask the admin to apply the latest database update.";
    }
    if (/payload too large|exceeded the maximum allowed size|entity too large/i.test(m) || status === 413) {
      return 'That file is over the 15 MB limit.';
    }
    if (code === '23505' || /duplicate key|already exists/i.test(m)) return 'That already exists.';
    if (code === '23503' || /violates foreign key/i.test(m)) {
      return 'That refers to something that no longer exists. Reopen it and try again.';
    }
    if (code === '23514' || /violates check constraint/i.test(m)) {
      return "One of the values isn't allowed. Check the form and try again.";
    }
    if (code === '23502' || /violates not-null/i.test(m)) return 'A required field is empty.';
    if (code === 'PGRST116') return 'That record could not be found. It may have been removed.';
    if (code === '57014' || /statement timeout|canceling statement/i.test(m)) {
      return 'The server took too long to answer. Try again in a moment.';
    }
    return m.replace(/^(Type)?Error:\s*/i, '') || 'Something went wrong. Try again.';
  }

  function toast(msg, type, ms) {
    if (typeof showToast === 'function') return showToast(msg, type || 'info', ms);
    console.warn('[ops] ' + msg);
    return function () {};
  }

  // The one way modules report a failed action. Demo mode is a warning (the
  // user did nothing wrong), anything else an error.
  function toastError(e, prefix) {
    if (errCode(e) === 'DEMO_READONLY') return toast(DEMO_TEXT, 'warning');
    return toast((prefix ? prefix + ' ' : '') + errText(e), 'error', 8000);
  }

  // ── dates and numbers (display: en-IN, local time) ─────────────────────────
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  var NAIVE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

  // Date | ms | ISO string | 'YYYY-MM-DD' (a calendar day, read as LOCAL — a
  // purchase date must not slide to the day before west of UTC).
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn; }
    var s = String(v).trim();
    var m = DATE_ONLY.exec(s);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function sameYear(d) { return d.getFullYear() === new Date().getFullYear(); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDays(d) {
    if (d == null || !isFinite(d)) return '—';
    if (d < 0) d = 0;
    if (d < 1) return Math.max(0, Math.round(d * 24)) + 'h';
    return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
  }

  function fmtDate(iso) {
    var d = toDate(iso);
    if (!d) return '—';
    try {
      return d.toLocaleDateString('en-IN', sameYear(d)
        ? { day: '2-digit', month: 'short' }
        : { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) { return '—'; }
  }

  function fmtTime(iso) {
    var d = toDate(iso);
    if (!d) return '—';
    try { return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }); }
    catch (e) { return '—'; }
  }

  function fmtDateTime(iso) {
    var d = toDate(iso);
    if (!d) return '—';
    return fmtDate(d) + ', ' + fmtTime(d);
  }

  function startOfDay(d) { var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; }

  // "just now", "12 min ago", "in 3 h", "yesterday", "tomorrow", "4 days ago";
  // past a week it is simply the date.
  function fmtRelative(iso, nowMs) {
    var d = toDate(iso);
    if (!d) return '—';
    var now = nowMs != null ? Number(nowMs) : Date.now();
    var diff = d.getTime() - now;
    var abs = Math.abs(diff);
    var future = diff > 0;
    if (abs < 45000) return 'just now';
    if (abs < 3600000) {
      var mins = Math.max(1, Math.round(abs / 60000));
      return future ? 'in ' + mins + ' min' : mins + ' min ago';
    }
    if (abs < DAY) {
      var hrs = Math.max(1, Math.round(abs / 3600000));
      return future ? 'in ' + hrs + ' h' : hrs + ' h ago';
    }
    var days = Math.round((startOfDay(d).getTime() - startOfDay(new Date(now)).getTime()) / DAY);
    if (days === -1) return 'yesterday';
    if (days === 1) return 'tomorrow';
    if (Math.abs(days) < 7) return days > 0 ? 'in ' + days + ' days' : Math.abs(days) + ' days ago';
    return fmtDate(d);
  }

  // ISO (UTC) → value for <input type="datetime-local"> (LOCAL wall time).
  function toLocalInput(iso) {
    var d = toDate(iso);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // <input type="datetime-local"> value (LOCAL) → ISO (UTC). Built from the
  // fields so the local reading is guaranteed; '' or garbage → null.
  function fromLocalInput(v) {
    if (v == null || v === '') return null;
    var m = NAIVE_LOCAL.exec(String(v).trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                     Number(m[4]), Number(m[5]), Number(m[6] || 0));
    if (isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) return null;   // 31 Feb etc.
    return d.toISOString();
  }

  // 'YYYY-MM-DD' (a promise or needed-by day) → 18:00 local that day, the end
  // of the working day, as ISO. Same rule as the v1.9.11 service.js.
  function dayToIso(day) {
    if (!day) return null;
    var m = DATE_ONLY.exec(String(day).trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 18, 0, 0);
    if (isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) return null;
    return d.toISOString();
  }

  // ISO → 'YYYY-MM-DD' of the LOCAL calendar day, for <input type="date">.
  // toISOString().slice(0,10) would roll an 18:00 IST promise back a day for
  // anyone west of the date line.
  function toDayInput(iso) {
    var d = toDate(iso);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtINR(n) {
    if (n == null || n === '') return '—';
    var num = typeof n === 'number' ? n : Number(String(n).replace(/[₹,\s]/g, ''));
    if (!isFinite(num)) return '—';
    var neg = num < 0;
    var a = Math.abs(num);
    var frac = Math.round(a * 100) % 100 !== 0;
    var s;
    try {
      s = a.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
    } catch (e) { s = frac ? a.toFixed(2) : String(Math.round(a)); }
    return (neg ? '-' : '') + '₹' + s;
  }

  // ── phones (SPEC-AMENDMENTS A1': keep the country code) ────────────────────
  // ONE rule everywhere, and its source of truth is shared/service-catalog.js
  // (NeoQcCatalog.normPhone / phoneOk / isValidPhone). These delegate to it
  // when it is loaded; the copy below is identical and only runs on a page
  // without it (a dev page, a unit test). SQL norm_phone()/phone_ok() and the
  // website implement the same rule.
  //   normPhone: digits only; a leading 00 (the international dialling
  //   prefix) is dropped; then 10 digits → 91 + d, 11 digits starting with 0
  //   → 91 + the last 10, anything else as it is (Gulf / NRI customers).
  //   phoneOk, on a NORMALISED value: 12–15 digits, or 11 digits for Kuwait
  //   (965), Oman (968), Bahrain (973) and Qatar (974), whose numbers are a
  //   3-digit code + 8 digits. An 11-digit Indian typo is still refused.
  var GULF_11 = ['965', '968', '973', '974'];
  function catalog() {
    var C = window.NeoQcCatalog;
    return (C && typeof C === 'object') ? C : null;
  }
  function normPhoneLocal(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }
  function phoneOkLocal(norm) {
    var n = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(n)) return false;
    if (n.length >= 12 && n.length <= 15) return true;
    return n.length === 11 && GULF_11.indexOf(n.slice(0, 3)) !== -1;
  }
  function normPhone(raw) {
    var C = catalog();
    if (C && typeof C.normPhone === 'function') { var v = C.normPhone(raw); return v == null ? '' : String(v); }
    return normPhoneLocal(raw);
  }
  function phoneOk(norm) {
    var C = catalog();
    if (C && typeof C.phoneOk === 'function') return !!C.phoneOk(norm);
    return phoneOkLocal(norm);
  }
  function isValidPhone(raw) {
    var C = catalog();
    if (C && typeof C.isValidPhone === 'function') return !!C.isValidPhone(raw);
    return phoneOk(normPhone(raw));
  }
  function phone4(raw) { var d = String(raw == null ? '' : raw).replace(/\D/g, ''); return d.slice(-4); }
  function fmtPhone(raw) {
    var n = normPhone(raw);
    if (!n) return '';
    if (n.length === 12 && n.slice(0, 2) === '91') return '+91 ' + n.slice(2, 7) + ' ' + n.slice(7);
    return n.length >= 11 ? '+' + n : n;
  }

  // ── outside the app ────────────────────────────────────────────────────────
  // https only. The main process already routes window.open to the system
  // browser and denies child windows; shell.openExternal is the direct path.
  function openExternal(url) {
    var u = String(url || '');
    if (!/^https:\/\//i.test(u)) return false;
    var fallback = function () { try { window.open(u, '_blank', 'noopener'); } catch (e) { /* nothing left to try */ } };
    try {
      if (typeof require === 'function') {
        var electron = require('electron');
        if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
          var pr = electron.shell.openExternal(u);
          if (pr && typeof pr.catch === 'function') pr.catch(fallback);
          return true;
        }
      }
    } catch (e) { /* not Electron (the dev harness): fall through */ }
    fallback();
    return true;
  }

  // WhatsApp click-to-chat. false when the number cannot be a real phone, so
  // the caller can say so instead of opening a chat with nobody.
  function waOpen(phone, text) {
    if (!isValidPhone(phone)) return false;
    var url = 'https://wa.me/' + normPhone(phone) + (text ? '?text=' + encodeURIComponent(String(text)) : '');
    return openExternal(url);
  }

  function copyText(text) {
    var s = String(text == null ? '' : text);
    var viaElectron = function () {
      try {
        if (typeof require === 'function') {
          var cb = require('electron').clipboard;
          if (cb && typeof cb.writeText === 'function') { cb.writeText(s); return true; }
        }
      } catch (e) { /* not Electron */ }
      return false;
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return viaElectron(); });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(viaElectron());
  }

  // ── scanner guard ──────────────────────────────────────────────────────────
  function isEnterSafeTarget(t) {
    var tag = t && t.tagName ? t.tagName.toUpperCase() : '';
    return tag === 'TEXTAREA' || tag === 'BUTTON';
  }
  // Bind once on a container whose contents are rebuilt freely.
  function guardEnter(root) {
    if (!root || root.__opsEnterGuard) return;
    root.__opsEnterGuard = true;
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (isEnterSafeTarget(e.target)) return;
      e.preventDefault();
    });
  }

  // ── chips ──────────────────────────────────────────────────────────────────
  // Toggle buttons with aria-pressed. One group = one wrapper with
  // data-chip-wrap; when the same group name appears more than once on a page
  // (one per item card), pass that card as `root` to readChips.
  function normOptions(options) {
    if (!options) return [];
    if (Array.isArray(options)) {
      return options.filter(function (o) { return o != null; }).map(function (o) {
        if (typeof o !== 'object') return { value: String(o), label: String(o) };
        return {
          value: String(o.value),
          label: o.label != null ? String(o.label) : String(o.value),
          title: o.title, disabled: !!o.disabled, icon: o.icon
        };
      });
    }
    // A { key: label } map, or { key: { label } } (e.g. NeoQcService.TYPES).
    return Object.keys(options).map(function (k) {
      var v = options[k];
      var label = (v && typeof v === 'object') ? (v.label != null ? v.label : k) : (v != null ? v : k);
      return { value: k, label: String(label) };
    });
  }

  function toList(v) {
    if (v == null || v === '') return [];
    return (Array.isArray(v) ? v : [v]).map(String);
  }

  // opts: { multi, allowNone (single mode: click again to clear), label
  // (aria-label for the group), className }. option.icon is TRUSTED markup
  // (e.g. typeIcon()); never pass user text there.
  function chips(name, options, selected, opts) {
    opts = opts || {};
    var multi = !!opts.multi;
    var sel = toList(selected);
    if (!multi && sel.length > 1) sel = sel.slice(0, 1);
    var html = '<div class="ops-chips' + (opts.className ? ' ' + esc(opts.className) : '') + '" role="group"' +
      ' data-chip-wrap="' + esc(name) + '" data-multi="' + (multi ? '1' : '0') + '"' +
      (opts.allowNone ? ' data-allow-none="1"' : '') +
      (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>';
    normOptions(options).forEach(function (o) {
      var on = sel.indexOf(o.value) !== -1;
      html += '<button type="button" class="ops-chip' + (on ? ' on' : '') + '"' +
        ' data-chip-group="' + esc(name) + '" data-value="' + esc(o.value) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (o.disabled ? ' disabled' : '') +
        (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' +
        (o.icon ? o.icon : '') + '<span>' + esc(o.label) + '</span></button>';
    });
    return html + '</div>';
  }

  function chipButtons(root, name) {
    var scope = root || document;
    var all = scope.querySelectorAll('.ops-chip[data-chip-group]');
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-chip-group') === String(name)) out.push(all[i]);
    return out;
  }
  function chipWrap(root, name) {
    var scope = root || document;
    if (scope.getAttribute && scope.getAttribute('data-chip-wrap') === String(name)) return scope;
    var all = scope.querySelectorAll('[data-chip-wrap]');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-chip-wrap') === String(name)) return all[i];
    return null;
  }
  function setPressed(b, on) {
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('on', !!on);
  }

  // Multi → array of values; single → the value or null.
  function readChips(root, name) {
    var wrap = chipWrap(root, name);
    var multi = !!(wrap && wrap.getAttribute('data-multi') === '1');
    var on = chipButtons(wrap || root, name)
      .filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; })
      .map(function (b) { return b.getAttribute('data-value'); });
    return multi ? on : (on.length ? on[0] : null);
  }

  // Programmatic selection (e.g. "Fill from chat"). Fires no event.
  function setChips(root, name, value) {
    var wrap = chipWrap(root, name);
    var multi = !!(wrap && wrap.getAttribute('data-multi') === '1');
    var want = toList(value);
    if (!multi && want.length > 1) want = want.slice(0, 1);
    chipButtons(wrap || root, name).forEach(function (b) { setPressed(b, want.indexOf(b.getAttribute('data-value')) !== -1); });
  }

  // One delegated listener per container. Nested containers that both call
  // bindChips must not toggle the same chip twice, so the first handler marks
  // the event and the outer one skips it. After a change an
  // `ops-chip-change` CustomEvent bubbles from the group wrapper with
  // detail { name, value, pressed, selection }.
  function bindChips(root) {
    if (!root || root.__opsChips) return;
    root.__opsChips = true;
    root.addEventListener('click', function (e) {
      if (e.__opsChipHandled) return;
      var b = e.target && e.target.closest ? e.target.closest('.ops-chip[data-chip-group]') : null;
      if (!b || !root.contains(b) || b.disabled) return;
      e.__opsChipHandled = true;
      var name = b.getAttribute('data-chip-group');
      var wrap = b.closest('[data-chip-wrap]');
      var multi = !!(wrap && wrap.getAttribute('data-multi') === '1');
      var pressed = b.getAttribute('aria-pressed') === 'true';
      if (multi) {
        setPressed(b, !pressed);
      } else if (pressed) {
        if (!(wrap && wrap.getAttribute('data-allow-none') === '1')) return;   // radio: stays chosen
        setPressed(b, false);
      } else {
        chipButtons(wrap || root, name).forEach(function (x) { setPressed(x, x === b); });
      }
      var detail = {
        name: name,
        value: b.getAttribute('data-value'),
        pressed: b.getAttribute('aria-pressed') === 'true',
        selection: readChips(wrap || root, name)
      };
      try { (wrap || b).dispatchEvent(new CustomEvent('ops-chip-change', { bubbles: true, detail: detail })); }
      catch (x) { /* CustomEvent unsupported: readChips still works */ }
    });
  }

  // ── small badges and banners (return HTML strings) ─────────────────────────
  var PRIORITY_FALLBACK = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  function priorityBadge(p) {
    var key = PRIORITY_FALLBACK[p] ? p : 'normal';
    var S = window.NeoQcService;
    var label = (S && S.PRIORITIES && S.PRIORITIES[key] && S.PRIORITIES[key].label) || PRIORITY_FALLBACK[key];
    return '<span class="ops-prio ops-prio-' + key + '" title="Priority: ' + esc(label) + '">' + esc(label) + '</span>';
  }

  function riskClass(r) { return r === 2 ? ' risk-breached' : r === 1 ? ' risk-soon' : ''; }

  // Colour is never the only signal: a late thing also says "late".
  function lateTag(r, words) {
    words = words || {};
    if (r === 2) return '<span class="ops-late">' + esc(words.late || 'late') + '</span>';
    if (r === 1) return '<span class="ops-soon">' + esc(words.soon || 'due soon') + '</span>';
    return '';
  }

  var BANNER_KINDS = { info: 1, warn: 1, error: 1, ok: 1, demo: 1 };
  function banner(text, kind) {
    var k = BANNER_KINDS[kind] ? kind : 'info';
    return '<div class="ops-banner ops-banner-' + k + '" role="' + (k === 'error' ? 'alert' : 'status') + '">' +
      esc(text) + '</div>';
  }
  function demoBanner() { return banner('Demo data: practice tickets, read-only. Turn it off in Settings to work on real tickets.', 'demo'); }

  // KPI strip shared by Service and RMA. items: [{ key, n, label, tone
  // (late|customer|vendor|ready|shop|queue|muted), active, sub, title }].
  // Rendered as buttons (they filter the board) unless opts.static.
  function kpis(items, opts) {
    opts = opts || {};
    var tag = opts.static ? 'div' : 'button';
    return '<div class="ops-kpis' + (opts.className ? ' ' + esc(opts.className) : '') + '">' +
      (items || []).map(function (it) {
        if (!it) return '';
        var tone = /^[a-z_]+$/.test(String(it.tone || '')) ? it.tone : 'muted';
        return '<' + tag + (opts.static ? '' : ' type="button"') +
          ' class="ops-kpi ops-kpi-' + tone + (it.active ? ' on' : '') + (Number(it.n) ? '' : ' zero') + '"' +
          ' data-kpi="' + esc(it.key) + '"' + (opts.static ? '' : ' aria-pressed="' + (it.active ? 'true' : 'false') + '"') +
          (it.title ? ' title="' + esc(it.title) + '"' : '') + '>' +
          '<span class="ops-kpi-n">' + esc(it.n == null ? '—' : it.n) + '</span>' +
          '<span class="ops-kpi-l">' + esc(it.label) + '</span>' +
          (it.sub ? '<span class="ops-kpi-sub">' + esc(it.sub) + '</span>' : '') +
        '</' + tag + '>';
      }).join('') + '</div>';
  }

  // ── icons: inline SVG, no emoji, no icon font ──────────────────────────────
  function svg(body, label, cls) {
    return '<svg class="ops-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="16" height="16"' +
      ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
      ' role="img" aria-label="' + esc(label) + '" focusable="false"><title>' + esc(label) + '</title>' + body + '</svg>';
  }

  var TYPE_ICONS = {
    in_store: ['In-store', '<path d="M3.5 9 5 4h14l1.5 5"/><path d="M3.5 9a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.8 0 2.8 2.8 0 0 0 5.6 0"/><path d="M5 11.5V20h14v-8.5"/><path d="M10 20v-5h4v5"/>'],
    on_site:  ['On-site', '<path d="M12 21s-6.5-5.8-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'],
    remote:   ['Remote', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M9 10.2a4.2 4.2 0 0 1 6 0"/><path d="M10.9 12.3a1.4 1.4 0 0 1 2.2 0"/>']
  };
  var CHANNEL_ICONS = {
    walk_in:  ['Walk-in', '<circle cx="13" cy="4.5" r="1.9"/><path d="M9.5 21l2.3-6.2 2.7 2.4V21"/><path d="M11.8 14.8 12.8 9l3 2.8 2.7.9"/><path d="M12.8 9 9.4 10.4 8 13.8"/>'],
    phone:    ['Phone', '<path d="M5.2 3.5h3.4l1.8 4.6-2.2 1.4a11.5 11.5 0 0 0 6.3 6.3l1.4-2.2 4.6 1.8v3.4a2 2 0 0 1-2.2 2A16.7 16.7 0 0 1 3.2 5.7a2 2 0 0 1 2-2.2z"/>'],
    whatsapp: ['WhatsApp', '<path d="M20.5 11.6a8.4 8.4 0 0 1-12.4 7.4L3.5 20.5l1.5-4.4a8.4 8.4 0 1 1 15.5-4.5z"/><path d="M9 9.2c.2 2.6 2.4 5 5.6 5.6"/>'],
    website:  ['Website', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18z"/>'],
    courier:  ['Courier', '<path d="M20.5 7.5 12 3 3.5 7.5v9L12 21l8.5-4.5z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5"/><path d="M12 12v9"/><path d="m7.8 5.3 8.5 4.5"/>'],
    staff:    ['Staff', '<rect x="4.5" y="3" width="15" height="18" rx="2"/><circle cx="12" cy="10" r="2.8"/><path d="M8.2 17.2a4 4 0 0 1 7.6 0"/>']
  };
  var ITEM_ICONS = {
    pc:          ['Desktop PC', '<rect x="7" y="2.5" width="10" height="19" rx="1.5"/><path d="M10 6h4"/><circle cx="12" cy="17" r="1.1"/>'],
    laptop:      ['Laptop', '<rect x="5" y="5" width="14" height="10" rx="1.2"/><path d="M2.5 19h19l-2-4h-15z"/>'],
    gpu:         ['Graphics card', '<rect x="2.5" y="7" width="19" height="10" rx="1.5"/><circle cx="8.5" cy="12" r="2.4"/><circle cx="15.5" cy="12" r="2.4"/><path d="M4.5 17v3"/>'],
    psu:         ['Power supply', '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M13 8l-3 4h4l-3 4"/>'],
    ram:         ['RAM', '<rect x="2.5" y="7" width="19" height="8" rx="1"/><path d="M6.5 10v2M10.5 10v2M14.5 10v2M18 10v2"/><path d="M5 15v3M9 15v3M15 15v3M19 15v3"/>'],
    ssd:         ['SSD', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 17h4"/>'],
    hdd:         ['Hard drive', '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="11" r="4"/><path d="m12 11 3 6"/>'],
    motherboard: ['Motherboard', '<rect x="3" y="3" width="18" height="18" rx="1.5"/><rect x="7" y="7" width="6" height="6"/><path d="M16.5 7v10M7 17h6"/>'],
    cpu:         ['Processor', '<rect x="6" y="6" width="12" height="12" rx="1"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>'],
    cooler:      ['Cooler', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.6"/><path d="M12 10.4c-.4-3.6 1.6-5.2 3.4-4.3s.3 3.6-3.4 4.3zM13.6 12c3.6-.4 5.2 1.6 4.3 3.4s-3.6.3-4.3-3.4zM12 13.6c.4 3.6-1.6 5.2-3.4 4.3s-.3-3.6 3.4-4.3zM10.4 12c-3.6.4-5.2-1.6-4.3-3.4s3.6-.3 4.3 3.4z"/>'],
    monitor:     ['Monitor', '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'],
    peripheral:  ['Peripheral', '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v4"/>'],
    other:       ['Other', '<path d="M20.5 7.5 12 3 3.5 7.5v9L12 21l8.5-4.5z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5"/><path d="M12 12v9"/>']
  };
  var UNKNOWN_ICON = '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>';

  function iconFrom(table, key, sharedLabel) {
    var hit = table[key];
    if (hit) return svg(hit[1], sharedLabel || hit[0], 'ops-ic-' + String(key).replace(/[^a-z_]/g, ''));
    return svg(UNKNOWN_ICON, sharedLabel || 'Unknown', 'ops-ic-unknown');
  }
  function sharedLabel(map, key) {
    var S = window.NeoQcService;
    var v = S && S[map] ? S[map][key] : null;
    return v ? (typeof v === 'object' ? v.label : v) : null;
  }
  function typeIcon(type) { return iconFrom(TYPE_ICONS, type || 'in_store', sharedLabel('TYPES', type || 'in_store')); }
  function channelIcon(channel) { return iconFrom(CHANNEL_ICONS, channel, sharedLabel('CHANNELS', channel)); }
  function itemIcon(kind) { return iconFrom(ITEM_ICONS, kind || 'other', sharedLabel('ITEM_KINDS', kind || 'other')); }

  // ── overlays: shared key handling ──────────────────────────────────────────
  // ONE capture-phase keydown listener on window for the dialog and the
  // lightbox. Capture runs before any module's document-level Escape handler,
  // so Esc closes the top-most layer only — not the dialog AND the job panel
  // underneath it. showConfirm (app.js) is the one layer above ours and owns
  // its keys while it is open.
  function confirmOpen() { return !!document.querySelector('.neo-confirm-overlay'); }

  var current = null;          // the top dialog's state
  var parked = [];             // dialogs underneath it (their DOM is detached, listeners intact)
  var lb = null;               // lightbox state
  var dialogSeq = 0;

  function focusables(rootEl) {
    var sel = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(rootEl.querySelectorAll(sel), function (n) {
      return n.offsetParent !== null || n === document.activeElement;
    });
  }
  function trapTab(e, rootEl) {
    var list = focusables(rootEl);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1];
    var inside = rootEl.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  }

  window.addEventListener('keydown', function (e) {
    if (confirmOpen()) return;
    if (lb) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepLightbox(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepLightbox(1); return; }
      if (e.key === 'Tab') { var lr = document.getElementById('ops-lightbox-root'); if (lr) trapTab(e, lr); return; }
      return;
    }
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (!current.busy) closeDialog(current, false);
      return;
    }
    if (e.key === 'Enter' && current.el && current.el.contains(e.target) && !isEnterSafeTarget(e.target)) {
      e.preventDefault();               // scanner rule: Enter never submits a dialog
      return;
    }
    if (e.key === 'Tab' && current.el) trapTab(e, current.el);
  }, true);

  // ── dialog ─────────────────────────────────────────────────────────────────
  // Renders into #ops-dialog-root inside #ops-dialog-modal (index.html), or
  // builds both if a page does not have them.
  function dialogHost() {
    var overlay = document.getElementById('ops-dialog-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ops-dialog-modal';
      overlay.className = 'modal-overlay';
      document.body.appendChild(overlay);
    }
    var root = document.getElementById('ops-dialog-root');
    if (!root) {
      var c = document.createElement('div');
      c.className = 'glass-slab modal-card';
      root = document.createElement('div');
      root.id = 'ops-dialog-root';
      c.appendChild(root);
      overlay.appendChild(c);
    }
    var card = root.parentElement === overlay ? root : (root.closest('.modal-card') || root.parentElement || root);
    if (card === root && !root.classList.contains('modal-card')) root.classList.add('glass-slab', 'modal-card');
    card.classList.add('ops-dialog-card');
    overlay.classList.add('ops-dialog-overlay');
    return { overlay: overlay, root: root, card: card };
  }

  function setDialogError(st, msg) {
    if (!st || !st.errEl) return;
    st.errEl.textContent = msg || '';
    st.errEl.classList.toggle('show', !!msg);
  }

  function setDialogBusy(st, busy) {
    st.busy = !!busy;
    if (st.okBtn) {
      st.okBtn.disabled = !!busy;
      st.okBtn.textContent = busy ? (st.opts.busyText || 'Working…') : st.okLabel;
      st.okBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (st.cancelBtn) st.cancelBtn.disabled = !!busy;
    if (st.closeBtn) st.closeBtn.disabled = !!busy;
    if (st.el) st.el.classList.toggle('busy', !!busy);
  }

  function closeDialog(st, value) {
    if (!st || st.closed) return;
    st.closed = true;
    var host = dialogHost();
    if (current === st) {
      current = null;
      if (parked.length) {
        var prev = parked.pop();
        host.root.textContent = '';
        host.root.appendChild(prev.frag);
        host.root.setAttribute('data-token', String(prev.token));
        prev.frag = null;
        current = prev;
        host.card.classList.toggle('ops-dialog-wide', !!prev.opts.wide);
        host.card.classList.toggle('ops-dialog-danger', !!prev.opts.danger);
      } else {
        host.overlay.classList.remove('active');
        // Leave the content in place for the fade-out unless a new dialog
        // has taken the slot by then.
        var token = st.token;
        setTimeout(function () {
          if (!current && host.root.getAttribute('data-token') === String(token)) host.root.textContent = '';
        }, 420);
      }
    } else {
      // Closing a parked dialog (should not happen: they cannot be reached).
      parked = parked.filter(function (p) { return p !== st; });
    }
    // Back to whatever opened it — for a nested dialog that is a button in the
    // dialog just restored underneath, which is in the document again.
    try {
      var back = st.prevFocus;
      if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
    } catch (e) { /* focus is a nicety */ }
    st.resolve(!!value);
  }

  // opts: { title, sub, body (HTML string — caller escapes — or a Node),
  // okText ('OK'; null hides it), cancelText ('Cancel'; null hides it),
  // danger, wide, busyText, onOpen(root), onOk: async (root) =>
  // true | false (stay open, caller showed its own message) | 'message'
  // (shown inline, stays open) }. A throw from onOk is shown inline too.
  // Resolves true when OK completed, false on Cancel / Esc / ×.
  function dialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var host = dialogHost();
      if (current) {
        // A dialog opened from inside another (e.g. "Add vendor" from the
        // dispatch dialog): park the lower one, keep its listeners.
        var frag = document.createDocumentFragment();
        while (host.root.firstChild) frag.appendChild(host.root.firstChild);
        current.frag = frag;
        parked.push(current);
      }
      var id = ++dialogSeq;
      var st = {
        token: id, opts: opts, resolve: resolve, busy: false, closed: false,
        prevFocus: document.activeElement,
        okLabel: opts.okText === undefined ? 'OK' : opts.okText
      };

      var el = document.createElement('div');
      el.className = 'ops-dialog';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'ops-dialog-title-' + id);

      var head = document.createElement('div');
      head.className = 'modal-header ops-dialog-head';
      var titles = document.createElement('div');
      titles.className = 'ops-dialog-titles';
      var h = document.createElement('h2');
      h.id = 'ops-dialog-title-' + id;
      h.className = 'ops-dialog-title';
      h.textContent = opts.title || '';
      titles.appendChild(h);
      if (opts.sub) {
        var sub = document.createElement('div');
        sub.className = 'ops-dialog-sub';
        sub.textContent = opts.sub;
        titles.appendChild(sub);
      }
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'close-btn ops-dialog-x';
      x.setAttribute('aria-label', 'Close');
      x.title = 'Close';
      x.textContent = '×';
      head.appendChild(titles);
      head.appendChild(x);

      var body = document.createElement('div');
      body.className = 'modal-body ops-dialog-body';
      if (opts.body && typeof opts.body === 'object' && opts.body.nodeType) body.appendChild(opts.body);
      else if (opts.body != null) body.innerHTML = String(opts.body);

      var err = document.createElement('div');
      err.className = 'ops-dialog-err';
      err.setAttribute('role', 'alert');
      err.setAttribute('aria-live', 'assertive');

      var foot = document.createElement('div');
      foot.className = 'modal-footer ops-dialog-foot';
      var cancel = null, ok = null;
      if (opts.cancelText !== null) {
        cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'secondary-btn ops-dialog-cancel';
        cancel.textContent = opts.cancelText || 'Cancel';
        foot.appendChild(cancel);
      }
      if (st.okLabel !== null) {
        ok = document.createElement('button');
        ok.type = 'button';
        ok.className = (opts.danger ? 'primary-pink-btn ops-btn-danger' : 'primary-pink-btn') + ' ops-dialog-ok';
        ok.textContent = st.okLabel;
        foot.appendChild(ok);
      }

      el.appendChild(head);
      el.appendChild(body);
      el.appendChild(err);
      el.appendChild(foot);
      st.el = el; st.body = body; st.errEl = err; st.okBtn = ok; st.cancelBtn = cancel; st.closeBtn = x;

      x.addEventListener('click', function () { if (!st.busy) closeDialog(st, false); });
      if (cancel) cancel.addEventListener('click', function () { if (!st.busy) closeDialog(st, false); });
      if (ok) ok.addEventListener('click', async function () {
        if (st.busy || st.closed) return;
        if (typeof opts.onOk !== 'function') { closeDialog(st, true); return; }
        setDialogError(st, '');
        setDialogBusy(st, true);
        var res;
        try { res = await opts.onOk(el); }
        catch (e2) { res = errText(e2); }
        if (st.closed) return;
        setDialogBusy(st, false);
        if (res === false) return;
        if (typeof res === 'string' && res) { setDialogError(st, res); return; }
        closeDialog(st, true);
      });
      bindChips(body);

      host.root.textContent = '';
      host.root.setAttribute('data-token', String(id));
      host.root.appendChild(el);
      host.card.classList.toggle('ops-dialog-wide', !!opts.wide);
      host.card.classList.toggle('ops-dialog-danger', !!opts.danger);
      current = st;
      host.overlay.classList.add('active');

      if (typeof opts.onOpen === 'function') {
        try { opts.onOpen(el); } catch (e3) { setDialogError(st, errText(e3)); }
      }
      setTimeout(function () {
        if (current !== st) return;
        var first = body.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
        try { (first || ok || cancel || x).focus(); } catch (e4) { /* nothing focusable */ }
      }, 60);
    });
  }

  // showConfirm when app.js is present; the dialog otherwise (dev harness).
  function confirm(message, opts) {
    opts = opts || {};
    if (typeof showConfirm === 'function') return showConfirm(message, opts);
    var p = document.createElement('p');
    p.className = 'ops-dialog-msg';
    p.textContent = message;
    return dialog({ title: opts.title || 'Confirm', body: p, okText: opts.okText || 'Confirm',
                    cancelText: opts.cancelText || 'Cancel', danger: !!opts.danger });
  }

  function isDialogOpen() { return !!current; }
  function isOverlayOpen() { return !!current || !!lb; }

  // ── lightbox ───────────────────────────────────────────────────────────────
  function lightboxHost() {
    var overlay = document.getElementById('ops-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ops-lightbox';
      overlay.className = 'modal-overlay';
      document.body.appendChild(overlay);
    }
    var root = document.getElementById('ops-lightbox-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ops-lightbox-root';
      overlay.appendChild(root);
    }
    overlay.classList.add('ops-lightbox-overlay');
    if (!overlay.__opsBound) {
      overlay.__opsBound = true;
      // A click on the dark backdrop (not the photo or a control) closes.
      overlay.addEventListener('click', function (e) {
        if (!lb) return;
        if (e.target === overlay || e.target === root || (e.target.classList && e.target.classList.contains('ops-lb-stage'))) closeLightbox();
      });
    }
    return { overlay: overlay, root: root };
  }

  function isPdfItem(it) {
    var probe = String(it.type || it.mime || '') + ' ' + String(it.path || '') + ' ' + String(it.url || '').split('?')[0];
    return it.kind === 'pdf' || it.is_pdf === true || /application\/pdf|\.pdf(\s|$)/i.test(probe);
  }
  function isHeicItem(it) {
    var probe = String(it.type || it.mime || '') + ' ' + String(it.path || '') + ' ' + String(it.url || '').split('?')[0];
    return it.is_heic === true || /image\/hei[cf]|\.hei[cf](\s|$)/i.test(probe);
  }

  function renderLightbox() {
    if (!lb) return;
    var host = lightboxHost();
    var it = lb.items[lb.i];
    host.root.textContent = '';

    var wrap = document.createElement('div');
    wrap.className = 'ops-lb';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Photo viewer');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ops-lb-btn ops-lb-close';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.textContent = '×';
    close.addEventListener('click', closeLightbox);

    var stage = document.createElement('div');
    stage.className = 'ops-lb-stage';

    if (isPdfItem(it) || isHeicItem(it)) {
      // Neither can be drawn here: a PDF, and an iPhone HEIC photo (stored as
      // is, never converted). Both open in the system viewer from the signed URL.
      var tile = document.createElement('div');
      tile.className = 'ops-lb-doc';
      var tl = document.createElement('div');
      tl.className = 'ops-lb-doc-title';
      tl.textContent = isPdfItem(it) ? 'PDF document' : 'iPhone photo (HEIC)';
      var hint = document.createElement('div');
      hint.className = 'ops-lb-doc-hint';
      hint.textContent = isPdfItem(it)
        ? 'Opens in your PDF viewer.'
        : 'This photo format cannot be previewed here. It opens in your photo viewer.';
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'primary-pink-btn';
      open.textContent = 'Open';
      open.addEventListener('click', function () {
        if (!openExternal(it.url)) toast('That link cannot be opened.', 'error');
      });
      tile.appendChild(tl); tile.appendChild(hint); tile.appendChild(open);
      stage.appendChild(tile);
    } else {
      var img = document.createElement('img');
      img.className = 'ops-lb-img';
      img.alt = it.title || 'Photo';
      img.addEventListener('error', function () {
        var miss = document.createElement('div');
        miss.className = 'ops-lb-doc';
        miss.textContent = 'This photo could not be loaded. The link may have expired: close the viewer and open the photos again.';
        if (img.parentNode) img.parentNode.replaceChild(miss, img);
      });
      img.src = it.url;                 // a property, never markup
      stage.appendChild(img);
    }

    var cap = document.createElement('div');
    cap.className = 'ops-lb-cap';
    var capText = document.createElement('div');
    capText.className = 'ops-lb-captext';
    if (it.title) { var t = document.createElement('div'); t.className = 'ops-lb-title'; t.textContent = it.title; capText.appendChild(t); }
    if (it.sub) { var s = document.createElement('div'); s.className = 'ops-lb-sub'; s.textContent = it.sub; capText.appendChild(s); }
    cap.appendChild(capText);
    if (lb.items.length > 1) {
      var n = document.createElement('span');
      n.className = 'ops-lb-count';
      n.textContent = (lb.i + 1) + ' of ' + lb.items.length;
      cap.appendChild(n);
    }

    wrap.appendChild(close);
    if (lb.items.length > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'ops-lb-btn ops-lb-prev';
      prev.setAttribute('aria-label', 'Previous photo');
      prev.title = 'Previous (←)';
      prev.textContent = '‹';
      prev.addEventListener('click', function () { stepLightbox(-1); });
      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'ops-lb-btn ops-lb-next';
      next.setAttribute('aria-label', 'Next photo');
      next.title = 'Next (→)';
      next.textContent = '›';
      next.addEventListener('click', function () { stepLightbox(1); });
      wrap.appendChild(prev);
      wrap.appendChild(next);
    }
    wrap.appendChild(stage);
    wrap.appendChild(cap);
    host.root.appendChild(wrap);
    try { close.focus(); } catch (e) { /* focus is a nicety */ }
  }

  function stepLightbox(d) {
    if (!lb || lb.items.length < 2) return;
    lb.i = (lb.i + d + lb.items.length) % lb.items.length;
    renderLightbox();
  }

  function closeLightbox() {
    if (!lb) return;
    var back = lb.prevFocus;
    lb = null;
    var host = lightboxHost();
    host.overlay.classList.remove('active');
    setTimeout(function () { if (!lb) host.root.textContent = ''; }, 420);
    try { if (back && document.contains(back) && typeof back.focus === 'function') back.focus(); } catch (e) { /* nicety */ }
  }

  // items: [{ url, title, sub, path?, type? }]. Items without a url (no
  // signed link) are skipped; startIndex counts in the ORIGINAL list.
  function lightbox(items, startIndex) {
    var src = Array.isArray(items) ? items : [];
    var start = Number(startIndex) || 0;
    var kept = [], at = 0;
    src.forEach(function (it, i) {
      if (!it || !it.url) return;
      if (i === start) at = kept.length;
      else if (i < start) at = kept.length + 1;
      kept.push(it);
    });
    if (!kept.length) { toast('No preview is available for this photo yet.', 'warning'); return; }
    lb = { items: kept, i: Math.min(at, kept.length - 1), prevFocus: lb ? lb.prevFocus : document.activeElement };
    renderLightbox();
    lightboxHost().overlay.classList.add('active');
  }

  // ── close everything (sign-out, the login screen) ──────────────────────────
  // Closes every ops dialog without asking — the top one and every one parked
  // under it, a busy one included — and the photo viewer. Each dialog's
  // promise resolves false, as a Cancel would. A busy dialog's onOk keeps
  // running, but whatever it returns later is ignored: its state is marked
  // closed, and the OK handler returns early on that. The content is cleared
  // at once rather than after the fade, so nothing of the last person's work
  // is left in the page. Never creates the overlay elements, so it is safe
  // at boot, and does nothing when nothing is open. Returns how many layers
  // it closed.
  function closeAll() {
    var n = 0;
    if (lb) {
      closeLightbox();
      var lr = document.getElementById('ops-lightbox-root');
      if (lr) lr.textContent = '';
      n++;
    }
    if (!current && !parked.length) return n;
    // Top first, so callers see their dialogs answer in the order a person
    // closing them one by one would have produced.
    var all = parked.slice();
    if (current) all.push(current);
    current = null;
    parked = [];
    var overlay = document.getElementById('ops-dialog-modal');
    if (overlay) overlay.classList.remove('active');
    var root = document.getElementById('ops-dialog-root');
    if (root) { root.textContent = ''; root.removeAttribute('data-token'); }
    for (var i = all.length - 1; i >= 0; i--) {
      var st = all[i];
      if (!st || st.closed) continue;
      st.closed = true;
      st.frag = null;
      n++;
      try { st.resolve(false); } catch (e) { /* a promise resolver does not throw */ }
    }
    return n;
  }

  window.NeoQcUI = {
    esc: esc,
    errText: errText,
    errCode: errCode,
    toast: toast,
    toastError: toastError,
    DEMO_TEXT: DEMO_TEXT,

    fmtDays: fmtDays,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    fmtTime: fmtTime,
    fmtRelative: fmtRelative,
    toLocalInput: toLocalInput,
    fromLocalInput: fromLocalInput,
    dayToIso: dayToIso,
    toDayInput: toDayInput,
    toDate: toDate,
    fmtINR: fmtINR,

    normPhone: normPhone,
    phoneOk: phoneOk,
    isValidPhone: isValidPhone,
    phone4: phone4,
    fmtPhone: fmtPhone,
    waOpen: waOpen,
    openExternal: openExternal,
    copyText: copyText,

    guardEnter: guardEnter,
    chips: chips,
    readChips: readChips,
    setChips: setChips,
    bindChips: bindChips,

    dialog: dialog,
    confirm: confirm,
    isDialogOpen: isDialogOpen,
    isOverlayOpen: isOverlayOpen,
    lightbox: lightbox,
    closeLightbox: closeLightbox,
    closeAll: closeAll,

    typeIcon: typeIcon,
    channelIcon: channelIcon,
    itemIcon: itemIcon,
    priorityBadge: priorityBadge,
    riskClass: riskClass,
    lateTag: lateTag,
    banner: banner,
    demoBanner: demoBanner,
    kpis: kpis
  };
})();
