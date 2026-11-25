/*
  Neo Service 1.16.1: Neo Glass suggestion lists for <input list="…">.

  The browser's own datalist popup opened detached from its field (below the
  next field, in Chromium's dark style) with a white ▼ inside the input — the
  owner's screenshot of the New RMA form's Brand field. Every input with a
  `list` attribute, now or added later (dialogs are built on the fly), is
  turned into a combobox: the native list is switched off and a glass list
  opens under (or above) the field, filters as you type, and works with the
  keyboard (↑ ↓ Enter, Esc closes without closing the dialog).

  The <datalist> element stays where it is and is read live, so code that
  fills or changes it keeps working.
*/
(function () {
  'use strict';

  var pop = null, cur = null, items = [], idx = -1, blurTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function mark(text, q) {
    var t = String(text);
    if (!q) return esc(t);
    var i = t.toLowerCase().indexOf(q);
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<b>' + esc(t.slice(i, i + q.length)) + '</b>' + esc(t.slice(i + q.length));
  }

  function enhance(input) {
    if (!input || input.dataset.ntList || input.tagName !== 'INPUT') return;
    var id = input.getAttribute('list');
    if (!id) return;
    input.dataset.ntList = id;
    input.removeAttribute('list');            // no native popup, no native arrow
    input.classList.add('nt-combo-input');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches('input[list]')) enhance(root);
    if (root.querySelectorAll) Array.prototype.forEach.call(root.querySelectorAll('input[list]'), enhance);
  }

  function options(input) {
    var dl = document.getElementById(input.dataset.ntList);
    if (!dl || !dl.options) return [];
    var seen = {};
    var out = [];
    Array.prototype.forEach.call(dl.options, function (o) {
      var v = String(o.value || '').trim();
      if (!v || seen[v.toLowerCase()]) return;
      seen[v.toLowerCase()] = true;
      var label = o.label && o.label !== o.value ? String(o.label) : (o.textContent && o.textContent.trim() !== v ? o.textContent.trim() : '');
      out.push({ value: v, label: label });
    });
    return out;
  }

  function close() {
    if (pop) { pop.remove(); pop = null; }
    if (cur) cur.setAttribute('aria-expanded', 'false');
    cur = null; items = []; idx = -1;
  }

  function place() {
    if (!pop || !cur) return;
    if (!document.body.contains(cur)) { close(); return; }
    var r = cur.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { close(); return; }
    var full = Math.min(280, pop.scrollHeight);
    var below = window.innerHeight - r.bottom - 14;
    var above = r.top - 46;                      // stay clear of the titlebar
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
    pop.style.width = r.width + 'px';
    // Below the field when there is reasonable room (shrinking to fit);
    // above only when below is cramped and above has clearly more.
    if (below >= Math.min(full, 160) || below >= above) {
      pop.style.maxHeight = Math.max(120, Math.min(280, below)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
    } else {
      var h = Math.min(full, above);
      pop.style.maxHeight = h + 'px';
      pop.style.top = Math.max(40, r.top - h - 6) + 'px';
    }
  }

  function render(input) {
    var q = String(input.value || '').trim().toLowerCase();
    var all = options(input);
    var list = q ? all.filter(function (o) { return o.value.toLowerCase().indexOf(q) !== -1 || o.label.toLowerCase().indexOf(q) !== -1; }) : all;
    if (!list.length || (list.length === 1 && list[0].value.toLowerCase() === q)) { close(); return; }
    // Starts-with first, then the rest, each alphabetical as the list gave them.
    if (q) list.sort(function (a, b) { return (a.value.toLowerCase().indexOf(q) === 0 ? 0 : 1) - (b.value.toLowerCase().indexOf(q) === 0 ? 0 : 1); });
    list = list.slice(0, 200);
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'nt-combo-pop';
      pop.setAttribute('role', 'listbox');
      pop.addEventListener('mousedown', function (e) {
        e.preventDefault();                   // keep focus in the field
        var o = e.target.closest('.nt-combo-opt');
        if (o) pick(Number(o.getAttribute('data-i')));
      });
      document.body.appendChild(pop);
    }
    cur = input;
    items = list;
    idx = -1;
    input.setAttribute('aria-expanded', 'true');
    pop.innerHTML = list.map(function (o, i) {
      return '<div class="nt-combo-opt" role="option" data-i="' + i + '"><span>' + mark(o.value, q) + '</span>' +
        (o.label ? '<small>' + esc(o.label) + '</small>' : '') + '</div>';
    }).join('');
    place();
  }

  function pick(i) {
    var o = items[i];
    var input = cur;
    if (!o || !input) return;
    input.value = o.value;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function move(d) {
    if (!pop || !items.length) return;
    idx = (idx + d + items.length) % items.length;
    Array.prototype.forEach.call(pop.children, function (c, i) { c.classList.toggle('on', i === idx); });
    var on = pop.children[idx];
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function isCombo(t) { return t && t.tagName === 'INPUT' && !!t.dataset.ntList; }

  document.addEventListener('focusin', function (e) {
    if (isCombo(e.target)) { clearTimeout(blurTimer); render(e.target); }
  });
  document.addEventListener('focusout', function (e) {
    if (isCombo(e.target)) blurTimer = setTimeout(function () { if (cur === e.target) close(); }, 120);
  });
  document.addEventListener('input', function (e) {
    if (isCombo(e.target) && document.activeElement === e.target) render(e.target);
  });
  document.addEventListener('mousedown', function (e) {
    if (isCombo(e.target) && document.activeElement === e.target && !pop) render(e.target);
  });
  // Capture: Esc closes the list, not the dialog around it.
  window.addEventListener('keydown', function (e) {
    if (!isCombo(e.target)) return;
    if (e.key === 'ArrowDown') { if (!pop) render(e.target); else move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { if (pop) { move(-1); e.preventDefault(); } }
    else if (e.key === 'Enter') { if (pop && idx >= 0) { pick(idx); e.preventDefault(); e.stopPropagation(); } }
    else if (e.key === 'Escape') { if (pop) { close(); e.preventDefault(); e.stopPropagation(); } }
    else if (e.key === 'Tab') close();
  }, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  function start() {
    scan(document.body);
    try {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          Array.prototype.forEach.call(m.addedNodes || [], scan);
          if (m.type === 'attributes' && m.target && m.attributeName === 'list') scan(m.target);
        });
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['list'] });
    } catch (e) { /* old engine: inputs present at start are still enhanced */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.NeoCombo = { scan: scan, close: close };
})();
