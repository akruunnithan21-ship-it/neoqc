/*
  shared/case-ports.js — which front-panel ports a build's cabinet has
  (Neo OS 1.12.5, the Bench's Case Port Certification).

  Windows cannot list a cabinet's front ports until something is plugged in,
  so the expected list comes from the cabinet named on the build's quotation:

    1. history — the port list certified on the last build with the SAME
       cabinet model (every port tested). The shop's own record, so it is the
       most trustworthy and it learns every cabinet the shop sells.
    2. known   — a short list of cabinets whose front panel is NOT the usual
       2× USB-A + 1× USB-C (checked against the makers' spec sheets).
    3. name    — the quotation name says so ("Type-C only", "no Type-C").
    4. default — 2× USB-A + 1× USB-C + headphone, for the technician to adjust.

  The technician can always switch the layout (2A+C, 1A+C, USB-C only, 2A)
  or add/remove single ports.

  Usage (window.NeoCasePorts in the app; require() in tests):
    P.modelKey('LIAN LI Lancool 216 RGB Black Cabinet')   // 'lian li lancool 216'
    P.pick(caseName, tickets, currentTicketId)
      → { layout: '2a1c'|'1a1c'|'c'|'2a'|'custom', ports: [{type, label}], source, note, fromTicketId }
    P.layoutOf(ports)   // which preset a port list is, or 'custom'
*/
(function (global) {
  'use strict';

  var LAYOUTS = {
    '2a1c': { label: '2× USB-A + 1× USB-C', ports: [['usb-a', 'Front USB-A #1'], ['usb-a', 'Front USB-A #2'], ['usb-c', 'Front USB-C'], ['headphone', 'Front headphone jack']] },
    '1a1c': { label: '1× USB-A + 1× USB-C', ports: [['usb-a', 'Front USB-A'], ['usb-c', 'Front USB-C'], ['headphone', 'Front headphone jack']] },
    'c':    { label: 'USB-C only',          ports: [['usb-c', 'Front USB-C #1'], ['usb-c', 'Front USB-C #2'], ['headphone', 'Front headphone jack']] },
    '2a':   { label: '2× USB-A, no USB-C',  ports: [['usb-a', 'Front USB-A #1'], ['usb-a', 'Front USB-A #2'], ['headphone', 'Front headphone jack']] }
  };
  var DEFAULT_LAYOUT = '2a1c';

  // Cabinets whose front panel differs from the default. Each entry is a
  // regular expression on the lower-cased name (punctuation → spaces).
  var KNOWN = [
    { re: /\bcorsair\b.*\b4000[dx]\b|\b4000[dx]\b.*\bcorsair\b/, name: 'Corsair 4000D / 4000X', layout: '1a1c' },
    { re: /\bnzxt\b.*\bh510\b/,                                   name: 'NZXT H510',             layout: '1a1c' },
    { re: /\bnzxt\b.*\bh5\b/,                                     name: 'NZXT H5',               layout: '1a1c' }
  ];

  // Words that don't identify a cabinet model: kind, size, colour, lighting.
  var NOISE = ['cabinet', 'case', 'chassis', 'computer', 'gaming', 'pc', 'mid', 'full', 'mini', 'tower',
    'atx', 'eatx', 'matx', 'itx', 'micro', 'tempered', 'glass', 'tg', 'with', 'and', 'the', 'of',
    'black', 'white', 'grey', 'gray', 'pink', 'blue', 'red', 'green', 'silver', 'snow', 'rgb', 'argb',
    'fans', 'fan', 'preinstalled', 'pre', 'installed', 'x', 'e', 'm', 'mm', 'usb', 'type', 'c'];

  function words(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  }

  // The same cabinet named by a quotation, an invoice or a person reads the
  // same: brand + model words, without colour/size/lighting words, quantities
  // or HSN codes.
  function modelKey(name) {
    return words(name).filter(function (w) {
      if (NOISE.indexOf(w) !== -1) return false;
      if (/^\d{1,2}$/.test(w)) return false;                 // quantity "1", "2"
      if (/^\d{6,}$/.test(w)) return false;                  // HSN/SAC code
      if (/^(8471|8473|8504|8523|8528|8542|8544)$/.test(w)) return false; // 4-digit HSN heading
      return true;
    }).join(' ');
  }

  function presetPorts(layout) {
    return (LAYOUTS[layout] || LAYOUTS[DEFAULT_LAYOUT]).ports.map(function (p) { return { type: p[0], label: p[1] }; });
  }

  function countTypes(ports) {
    var c = {};
    (ports || []).forEach(function (p) { if (p && p.type) c[p.type] = (c[p.type] || 0) + 1; });
    return c;
  }

  function layoutOf(ports) {
    var have = countTypes(ports);
    var keys = Object.keys(LAYOUTS);
    for (var i = 0; i < keys.length; i++) {
      var want = countTypes(presetPorts(keys[i]));
      var all = Object.keys(want).concat(Object.keys(have));
      var same = all.every(function (t) { return (want[t] || 0) === (have[t] || 0); });
      if (same) return keys[i];
    }
    return 'custom';
  }

  function nameHint(name) {
    var s = ' ' + words(name).join(' ') + ' ';
    if (/ (type c|usb c|typec|usbc) only | only (type c|usb c|typec|usbc) /.test(s)) return 'c';
    if (/ (no|without) (type c|usb c|typec|usbc) /.test(s)) return '2a';
    return null;
  }

  function lastTested(ports) {
    var best = 0;
    (ports || []).forEach(function (p) {
      var t = p && p.testedAt ? Date.parse(p.testedAt) : NaN;
      if (isFinite(t) && t > best) best = t;
    });
    return best;
  }

  function pick(caseName, tickets, currentId) {
    var key = modelKey(caseName);
    var shown = String(caseName || '').trim();

    if (key) {
      var best = null, bestAt = 0;
      (tickets || []).forEach(function (t) {
        if (!t || t.id === currentId) return;
        if (modelKey(t.specs && t.specs.case) !== key) return;
        var ports = t.diagnostics && t.diagnostics.casePorts;
        if (!Array.isArray(ports) || !ports.length) return;
        if (!ports.every(function (p) { return p && p.status && p.status !== 'untested'; })) return;
        var at = lastTested(ports);
        if (at > bestAt) { best = t; bestAt = at; }
      });
      if (best) {
        var ports = best.diagnostics.casePorts.map(function (p) { return { type: p.type, label: p.label }; });
        return { layout: layoutOf(ports), ports: ports, source: 'history', fromTicketId: best.id,
                 note: 'Same as the last build with this cabinet (#' + String(best.id).slice(-6).toUpperCase() + ').' };
      }
    }

    var lower = ' ' + words(caseName).join(' ') + ' ';
    for (var i = 0; i < KNOWN.length; i++) {
      if (KNOWN[i].re.test(lower)) {
        return { layout: KNOWN[i].layout, ports: presetPorts(KNOWN[i].layout), source: 'known',
                 note: KNOWN[i].name + ': ' + LAYOUTS[KNOWN[i].layout].label + ' on the front.' };
      }
    }

    var hint = nameHint(caseName);
    if (hint) {
      return { layout: hint, ports: presetPorts(hint), source: 'name',
               note: 'From the cabinet name: ' + LAYOUTS[hint].label + '.' };
    }

    return { layout: DEFAULT_LAYOUT, ports: presetPorts(DEFAULT_LAYOUT), source: 'default',
             note: shown ? 'No record of this cabinet yet: check its front panel and pick the layout.'
                         : 'No cabinet on this build: check its front panel and pick the layout.' };
  }

  var api = {
    LAYOUTS: LAYOUTS,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    modelKey: modelKey,
    presetPorts: presetPorts,
    layoutOf: layoutOf,
    pick: pick
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoCasePorts = api;
  }
})(typeof window !== 'undefined' ? window : this);
