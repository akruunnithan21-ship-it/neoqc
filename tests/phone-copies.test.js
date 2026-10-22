/*
  The phone rule (SPEC-AMENDMENTS A1') has ONE JS source — shared/service-
  catalog.js (NeoQcCatalog.normPhone / phoneOk / isValidPhone) — and a few
  inline copies in the app and the website for a page that loads without it.
  Run: node tests/phone-copies.test.js   — exits 1 on any failure.

  For every file that has a copy, this lifts the phone functions out of the
  source (with the little helpers and constant lists they use), runs them in
  a sandbox, and checks two things:

    1. with window.NeoQcCatalog loaded, the public helpers (normPhone,
       phoneOk, isValidPhone, validPhone) answer from the catalogue;
    2. without it, the inline copy gives exactly the catalogue's answers.

  Nothing in the app is loaded or run; only those few functions are.
*/
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var C = require(path.join(__dirname, '..', 'shared', 'service-catalog.js'));

var ROOT = path.join(__dirname, '..');
var FILES = ['ops-ui.js', 'ops-data.js', 'rma.js', 'service-intake.js', 'service.js', 'modules.js', 'photo-tray.js',
             'shell.js', 'app.js', 'dashboard/app.js', 'dashboard/service.js', 'shared/service-demo.js',
             'shared/service-status.js'];

// raw → normalised
var NORM_NAMES = ['normPhone', 'normPhoneLocal', 'normPhoneInline', 'localNormPhone'];
// normalised → boolean
var OK_NAMES = ['phoneOk', 'phoneOkLocal', 'phoneOkInline', 'localPhoneOk'];
// as typed → boolean
var RAW_OK_NAMES = ['isValidPhone', 'validPhone', 'isValidPhoneLocal'];
// These must answer from NeoQcCatalog when it is loaded.
var PUBLIC = ['normPhone', 'phoneOk', 'isValidPhone', 'validPhone'];

var failures = 0, passed = 0, warnings = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

// ── lifting functions out of a file ─────────────────────────────────────────

// Index just past the body of the function whose `{` is at `open`: strings,
// template literals, comments and regex literals are skipped.
function bodyEnd(s, open) {
  var depth = 0, i = open, n = s.length, prevSig = '';
  while (i < n) {
    var c = s.charAt(i);
    if (c === '/' && s.charAt(i + 1) === '/') { i = s.indexOf('\n', i); if (i === -1) return -1; continue; }
    if (c === '/' && s.charAt(i + 1) === '*') { i = s.indexOf('*/', i + 2); if (i === -1) return -1; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      var q = c;
      i++;
      while (i < n && s.charAt(i) !== q) { if (s.charAt(i) === '\\') i++; i++; }
      i++;
      prevSig = q;
      continue;
    }
    if (c === '/' && (prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || /\breturn$/.test(s.slice(Math.max(0, i - 7), i).trim()))) {
      i++;
      var inClass = false;
      while (i < n) {
        var r = s.charAt(i);
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') return -1;
        i++;
      }
      i++;
      while (/[a-z]/i.test(s.charAt(i))) i++;
      prevSig = 'x';
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return -1;
}

// name → [{at, src}] for every function declaration, and every `var NAME =
// <constant>;`: a list of strings (optionally Object.freeze'd), a string, a
// number, or null / true / false (a lazy cache such as `var _C = null;`).
function index(src) {
  var fns = {}, consts = {}, m;
  var re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = re.exec(src)) !== null) {
    var open = src.indexOf('{', re.lastIndex);
    if (open === -1) continue;
    var end = bodyEnd(src, open);
    if (end === -1) continue;
    (fns[m[1]] = fns[m[1]] || []).push({ at: m.index, src: src.slice(m.index, end) });
  }
  var rc = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*((?:Object\.freeze\(\s*)?\[\s*'[^'\n]*'(?:\s*,\s*'[^'\n]*')*\s*\]\s*\)?|'[^'\n]*'|-?\d+(?:\.\d+)?|null|true|false)\s*;/g;
  while ((m = rc.exec(src)) !== null) (consts[m[1]] = consts[m[1]] || []).push({ at: m.index, src: 'var ' + m[1] + ' = ' + m[2] + ';' });
  return { fns: fns, consts: consts };
}
function nearest(list, at) {
  return list.slice().sort(function (a, b) { return Math.abs(a.at - at) - Math.abs(b.at - at); })[0];
}
var JS_WORDS = /^(var|function|return|if|else|typeof|null|undefined|true|false|new|try|catch|throw|for|while|in|of|this|window|String|Number|RegExp|Object|Array|Math|JSON|e)$/;
// The source of `decl` plus every helper / constant of the same file it uses.
function link(ix, decl) {
  var seen = {}, parts = [];
  (function add(d) {
    var ids = d.src.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").match(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g) || [];
    ids.forEach(function (raw) {
      var id = raw.replace(/^[^A-Za-z_$]/, '');
      if (JS_WORDS.test(id) || seen[id]) return;
      if (ix.fns[id]) { seen[id] = 1; var f = nearest(ix.fns[id], d.at); if (f !== d) { add(f); parts.push(f.src); } }
      else if (ix.consts[id]) { seen[id] = 1; parts.push(nearest(ix.consts[id], d.at).src); }
    });
  })(decl);
  parts.push(decl.src);
  return parts.join('\n');
}
function lift(ix, decl, name, win) {
  var ctx = vm.createContext({ window: win, global: win, self: win });
  vm.runInContext(link(ix, decl) + '\n;__fn = ' + name + ';', ctx, { timeout: 1000 });
  return ctx.__fn;
}

// ── inputs ──────────────────────────────────────────────────────────────────

var RAW = ['9847012345', '98470 12345', '098470 12345', '+91 98470 12345', '919847012345', '0091 98470 12345',
  '+971 50 123 4567', '00971501234567', '+974 5512 3456', '00974 5512 3456', '+965 9999 8888', '+968 9123 4567',
  '+973 3612 3456', '+971 5012 3456', '98470123456', '+1 (555) 123-4567', '+44 7700 900123', '123456789012345',
  '1234567890123456', '12345', '', '0', '00', '000', '009847012345', '0009847012345', 'abc', null, undefined];
for (var i = 0; i < 200; i++) {
  var s = i % 3 === 0 ? '00' : i % 3 === 1 ? '0' : '';
  for (var k = 0, len = 1 + (i % 17); k < len; k++) s += String((i * 7 + k * 13) % 10);
  RAW.push(s);
}
// Normalised values a phoneOk sees (digits only, already normal).
var NORMS = RAW.map(function (r) { return C.normPhone(r); })
  .filter(function (n) { return C.normPhone(n) === n; })
  .concat(['97455123456', '96551234567', '96891234567', '97336123456', '97155123456', '98470123456', '15551234567',
           '919847012345', '123456789012345', '1234567890123456', ''])
  .filter(function (n, i, all) { return all.indexOf(n) === i; });
// Not normalised: phoneOk's answer is only defined on normalised digits, so a
// different answer here is a warning, not a failure.
var NOT_NORMAL = ['+971501234567', '+91 98470 12345', '919847-012345', ' 919847012345'];

var SPY = {
  NeoQcCatalog: {
    normPhone: function () { return 'from-catalog'; },
    phoneOk: function () { return true; },
    isValidPhone: function () { return true; }
  }
};
SPY.NeoQcUI = {       // a UI kit that forwards to the catalogue, as ops-ui.js does
  normPhone: function (p) { return SPY.NeoQcCatalog.normPhone(p); },
  phoneOk: function (p) { return SPY.NeoQcCatalog.phoneOk(p); },
  isValidPhone: function (p) { return SPY.NeoQcCatalog.isValidPhone(p); }
};

// ── the checks ──────────────────────────────────────────────────────────────

var checked = 0;
FILES.forEach(function (rel) {
  var file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return;
  var src = fs.readFileSync(file, 'utf8');
  var ix = index(src);
  var names = NORM_NAMES.concat(OK_NAMES, RAW_OK_NAMES).filter(function (n) { return ix.fns[n]; });

  // A normaliser under a name this does not know would go unchecked.
  Object.keys(ix.fns).forEach(function (n) {
    if (names.indexOf(n) !== -1) return;
    ix.fns[n].forEach(function (d) {
      if (/'91'\s*\+/.test(d.src) && /\\D|digits\(/.test(d.src)) warnings.push(rel + ': ' + n + '() looks like a phone normaliser this test does not check');
    });
  });
  if (!names.length) return;

  names.forEach(function (name) {
    ix.fns[name].forEach(function (decl, nth) {
      var label = rel + ' ' + name + '()' + (ix.fns[name].length > 1 ? ' #' + (nth + 1) : '');
      checked++;
      test(label + ' gives the catalogue\'s answers without the catalogue', function () {
        var f;
        try { f = lift(ix, decl, name, {}); }
        catch (e) { throw new Error('could not lift it out of the file: ' + e.message); }
        var bad = [];
        if (NORM_NAMES.indexOf(name) !== -1) {
          RAW.forEach(function (r) {
            var got = f(r), want = C.normPhone(r);
            if (got !== want) bad.push(JSON.stringify(r) + ' -> ' + JSON.stringify(got) + ', catalogue ' + JSON.stringify(want));
          });
        } else if (OK_NAMES.indexOf(name) !== -1) {
          NORMS.forEach(function (n) {
            var got = f(n), want = C.phoneOk(n);
            if (got !== want) bad.push(JSON.stringify(n) + ' -> ' + JSON.stringify(got) + ', catalogue ' + want);
          });
          var loose = NOT_NORMAL.filter(function (n) { return f(n) !== C.phoneOk(n); });
          if (loose.length) {
            warnings.push(label + ' (inline copy) accepts non-digit input the catalogue refuses: ' +
                          loose.map(function (n) { return JSON.stringify(n); }).join(', ') + ' (no digits-only guard)');
          }
        } else {
          RAW.forEach(function (r) {
            var got = f(r), want = C.isValidPhone(r);
            if (got !== want) bad.push(JSON.stringify(r) + ' -> ' + JSON.stringify(got) + ', catalogue ' + want);
          });
        }
        assert.ok(!bad.length, bad.length + ' different answer(s): ' + bad.slice(0, 8).join('; '));
      });
      if (PUBLIC.indexOf(name) === -1) return;
      test(label + ' answers from NeoQcCatalog when it is loaded', function () {
        var f;
        try { f = lift(ix, decl, name, { NeoQcCatalog: SPY.NeoQcCatalog, NeoQcUI: SPY.NeoQcUI }); }
        catch (e) { throw new Error('could not lift it out of the file: ' + e.message); }
        if (name === 'normPhone') assert.strictEqual(f('12345'), 'from-catalog', 'normPhone did not ask the catalogue');
        else assert.strictEqual(f('12345'), true, name + ' did not ask the catalogue');
      });
    });
  });
});

test('there are copies to check at all', function () {
  assert.ok(checked >= 6, 'only ' + checked + ' phone functions found across ' + FILES.length + ' files');
});

warnings.forEach(function (w) { console.warn('WARN ' + w); });
console.log((failures ? 'FAILED' : 'OK') + ' phone-copies: ' + passed + ' passed, ' + failures + ' failed' +
            (warnings.length ? ', ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') : '') +
            ' (' + checked + ' functions)');
process.exit(failures ? 1 : 0);
