/*
  shared/ram-spec.js — how many RAM sticks a build has, and how big each one is
  (Neo OS 1.12.5).

  A RAM product name usually states the size of the box, not the build: a
  "16GB DDR5" line bought twice is 2 × 16 GB, and "32GB (2x16GB)" is a kit of
  two. The ticket keeps the answer as specs.ramSticks and specs.ramStickGB,
  filled from the invoice (name + quantity) or typed by the technician, and the
  Bench compares it with the sticks Windows reports (Win32_PhysicalMemory).

  Usage (window.NeoRamSpec in the app; require() in tests):
    R.parseName('Corsair Vengeance 32GB (2x16GB) DDR5')  // { sticks: 2, perStickGB: 16, totalGB: 32 }
    R.expected('Kingston Fury 16GB DDR5', 2)             // { sticks: 2, perStickGB: 16 }
    R.compare({ sticks: 2, perStickGB: 16 }, [{ capacityGB: 16 }, { capacityGB: 16 }])
      // { state: 'match' | 'mismatch' | 'unknown', expectedText, foundText }
    R.text(2, 16)                                        // '2 × 16 GB'
*/
(function (global) {
  'use strict';

  var NONE = { sticks: null, perStickGB: null, totalGB: null };

  function kit(n, per) {
    if (!(n >= 1 && n <= 8 && per >= 1 && per <= 256)) return NONE;
    return { sticks: n, perStickGB: per, totalGB: n * per };
  }

  function parseName(name) {
    var s = String(name || '').toLowerCase();
    var m;
    // "2x16gb", "2 x 16 gb", "(2x16GB)", "2*16GB"
    if ((m = s.match(/\b(\d{1,2})\s*[x×*]\s*(\d{1,3})\s*gb\b/))) return kit(+m[1], +m[2]);
    // "16gb x 2", "8GBx2"
    if ((m = s.match(/\b(\d{1,3})\s*gb\s*[x×*]\s*(\d{1,2})\b/))) return kit(+m[2], +m[1]);
    // "32GB kit of 2", "2 sticks", "dual channel kit (2 modules)". Not "2 PCS":
    // that is how many boxes were bought, which expected() takes separately.
    var k = s.match(/\bkit\s*(?:of\s*)?\(?\s*(\d)\b/) || s.match(/\b(\d)\s*(?:sticks?|modules?|dimms?)\b/);
    var g = s.match(/\b(\d{1,3})\s*gb\b/);
    if (k && g && +g[1] % +k[1] === 0) return kit(+k[1], +g[1] / +k[1]);
    if (g && +g[1] >= 1 && +g[1] <= 256) return { sticks: null, perStickGB: +g[1], totalGB: null };
    return NONE;
  }

  // What the build should have: a kit name times the quantity bought, or a
  // single-stick name times the quantity. Quantity unknown → sticks only when
  // the name states a kit.
  function expected(name, qty) {
    var p = parseName(name);
    var q = Math.round(Number(qty));
    var hasQty = isFinite(q) && q >= 1 && q <= 8;
    if (p.sticks) return { sticks: Math.min(8, p.sticks * (hasQty ? q : 1)), perStickGB: p.perStickGB };
    if (p.perStickGB) return { sticks: hasQty ? q : null, perStickGB: p.perStickGB };
    return { sticks: null, perStickGB: null };
  }

  function text(sticks, perGB) {
    if (!sticks || !perGB) return '';
    return sticks + ' × ' + (Math.round(perGB * 10) / 10) + ' GB';
  }

  // Detected modules → "2 × 16 GB" or "1 × 16 GB + 1 × 8 GB".
  function foundText(modules) {
    var groups = {}, order = [];
    (modules || []).forEach(function (m) {
      var gb = Math.round(Number(m && m.capacityGB) || 0);
      if (!gb) return;
      if (!groups[gb]) { groups[gb] = 0; order.push(gb); }
      groups[gb]++;
    });
    order.sort(function (a, b) { return b - a; });
    return order.map(function (gb) { return groups[gb] + ' × ' + gb + ' GB'; }).join(' + ');
  }

  function compare(exp, modules) {
    var e = exp || {};
    var mods = (modules || []).filter(function (m) { return m && Number(m.capacityGB) > 0; });
    var res = { state: 'unknown', expectedText: text(e.sticks, e.perStickGB), foundText: foundText(mods) };
    if (!e.sticks || !e.perStickGB || !mods.length) return res;
    var sizesOk = mods.every(function (m) { return Math.abs(Number(m.capacityGB) - e.perStickGB) <= 0.6; });
    res.state = (mods.length === e.sticks && sizesOk) ? 'match' : 'mismatch';
    return res;
  }

  var api = { parseName: parseName, expected: expected, compare: compare, text: text, foundText: foundText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoRamSpec = api;
  }
})(typeof window !== 'undefined' ? window : this);
