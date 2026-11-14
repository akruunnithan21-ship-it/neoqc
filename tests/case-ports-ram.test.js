/*
  Unit tests for shared/case-ports.js (NeoCasePorts) and shared/ram-spec.js
  (NeoRamSpec) — Neo OS 1.12.5: the cabinet's front-panel layout and the RAM
  stick count / size per stick.
  Run: node tests/case-ports-ram.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var P = require(path.join(__dirname, '..', 'shared', 'case-ports.js'));
var R = require(path.join(__dirname, '..', 'shared', 'ram-spec.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}
function types(ports) { return ports.map(function (p) { return p.type; }).join(','); }

// ═══ cabinet → front ports ═══════════════════════════════════════════════

test('modelKey: quotation, invoice and typed names of one cabinet agree', function () {
  var k = P.modelKey('Lian Li Lancool 216 RGB Black');
  assert.strictEqual(k, 'lian li lancool 216');
  assert.strictEqual(P.modelKey('LIAN LI LANCOOL 216 RGB BLACK CABINET 8473 1'), k);
  assert.strictEqual(P.modelKey('Lian-Li Lancool 216 (White) Mid Tower ATX Case'), k);
  assert.strictEqual(P.modelKey(''), '');
});

test('layouts: the four presets and layoutOf', function () {
  assert.strictEqual(types(P.presetPorts('2a1c')), 'usb-a,usb-a,usb-c,headphone');
  assert.strictEqual(types(P.presetPorts('1a1c')), 'usb-a,usb-c,headphone');
  assert.strictEqual(types(P.presetPorts('c')), 'usb-c,usb-c,headphone');
  assert.strictEqual(types(P.presetPorts('2a')), 'usb-a,usb-a,headphone');
  assert.strictEqual(P.layoutOf(P.presetPorts('1a1c')), '1a1c');
  assert.strictEqual(P.layoutOf([{ type: 'usb-c' }, { type: 'usb-a' }, { type: 'headphone' }]), '1a1c', 'order does not matter');
  assert.strictEqual(P.layoutOf([{ type: 'usb-c' }, { type: 'headphone' }]), 'custom');
});

test('known cabinets with one USB-A and one USB-C', function () {
  ['Corsair 4000D Airflow Tempered Glass Mid-Tower ATX Case Black', 'CORSAIR 4000X RGB', 'NZXT H5 Flow White', 'NZXT H510 Elite']
    .forEach(function (n) {
      var r = P.pick(n, [], 't1');
      assert.strictEqual(r.source, 'known', n);
      assert.strictEqual(r.layout, '1a1c', n);
    });
  assert.strictEqual(P.pick('NZXT H7 Flow', [], 't1').source, 'default', 'H7 is not H5');
});

test('the quotation name can say USB-C only, or no USB-C', function () {
  var c = P.pick('Generic ITX Case (Type-C only front panel)', [], 't1');
  assert.strictEqual(c.layout, 'c');
  assert.strictEqual(c.source, 'name');
  assert.strictEqual(P.pick('Budget Cabinet without Type-C', [], 't1').layout, '2a');
});

test('default: 2× USB-A + 1× USB-C, with a note to check', function () {
  var r = P.pick('Ant Esports ICE-100', [], 't1');
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.layout, '2a1c');
  assert.ok(/check its front panel/.test(r.note));
  assert.ok(/No cabinet on this build/.test(P.pick('', [], 't1').note));
});

test('history: the last fully tested build with the same cabinet wins', function () {
  var older = { id: 't_old_aaaaaa', specs: { case: 'Lian Li Lancool 216 Black' }, diagnostics: { casePorts: [
    { type: 'usb-a', label: 'A', status: 'pass', testedAt: '2026-11-01T10:00:00Z' },
    { type: 'usb-a', label: 'B', status: 'pass', testedAt: '2026-11-01T10:01:00Z' },
    { type: 'usb-c', label: 'C', status: 'fail', testedAt: '2026-11-01T10:02:00Z' }] } };
  var newer = { id: 't_new_bbbbbb', specs: { case: 'LIAN LI LANCOOL 216 RGB WHITE' }, diagnostics: { casePorts: [
    { type: 'usb-c', label: 'Front C', status: 'pass', testedAt: '2026-11-10T10:00:00Z' },
    { type: 'usb-a', label: 'Front A', status: 'pass', testedAt: '2026-11-10T10:01:00Z' },
    { type: 'headphone', label: 'Jack', status: 'pass', testedAt: '2026-11-10T10:02:00Z' }] } };
  var unfinished = { id: 't_unf_cccccc', specs: { case: 'Lian Li Lancool 216' }, diagnostics: { casePorts: [
    { type: 'usb-c', label: 'X', status: 'untested' }] } };
  var r = P.pick('Lian Li Lancool 216 RGB Black', [older, newer, unfinished], 't_current');
  assert.strictEqual(r.source, 'history');
  assert.strictEqual(r.fromTicketId, 't_new_bbbbbb');
  assert.strictEqual(r.layout, '1a1c');
  assert.deepStrictEqual(r.ports.map(function (p) { return p.label; }), ['Front C', 'Front A', 'Jack']);
  assert.ok(/#BBBBBB/.test(r.note));
  // The build being tested never counts as its own history.
  assert.strictEqual(P.pick('Lian Li Lancool 216', [newer], 't_new_bbbbbb').source, 'default');
});

// ═══ RAM sticks ══════════════════════════════════════════════════════════

test('parseName: kits and single sticks', function () {
  assert.deepStrictEqual(R.parseName('Corsair Vengeance RGB 32GB (2x16GB) DDR5 6000MHz'), { sticks: 2, perStickGB: 16, totalGB: 32 });
  assert.deepStrictEqual(R.parseName('G.Skill Trident Z5 64GB (2 x 32GB)'), { sticks: 2, perStickGB: 32, totalGB: 64 });
  assert.deepStrictEqual(R.parseName('XPG 8GBx2 DDR4'), { sticks: 2, perStickGB: 8, totalGB: 16 });
  assert.deepStrictEqual(R.parseName('Kingston Fury Beast 32GB Kit of 2 DDR5'), { sticks: 2, perStickGB: 16, totalGB: 32 });
  assert.deepStrictEqual(R.parseName('Corsair Vengeance LPX 16GB (1 x 16GB) DDR4 3200'), { sticks: 1, perStickGB: 16, totalGB: 16 });
  assert.deepStrictEqual(R.parseName('Kingston Fury 16GB DDR5 5600MHz'), { sticks: null, perStickGB: 16, totalGB: null });
  assert.deepStrictEqual(R.parseName('DDR5 RAM'), { sticks: null, perStickGB: null, totalGB: null });
});

test('expected: name times the quantity bought', function () {
  assert.deepStrictEqual(R.expected('Kingston Fury 16GB DDR5', 2), { sticks: 2, perStickGB: 16 });
  assert.deepStrictEqual(R.expected('Corsair 32GB (2x16GB) DDR5', 1), { sticks: 2, perStickGB: 16 });
  assert.deepStrictEqual(R.expected('Corsair 32GB (2x16GB) DDR5', 2), { sticks: 4, perStickGB: 16 }, 'two kits');
  assert.deepStrictEqual(R.expected('Kingston Fury 16GB DDR5', null), { sticks: null, perStickGB: 16 }, 'count unknown');
  assert.deepStrictEqual(R.expected('Corsair 32GB (2x16GB)', null), { sticks: 2, perStickGB: 16 });
});

test('compare: count and size per stick against what Windows reports', function () {
  var two16 = [{ capacityGB: 16 }, { capacityGB: 16 }];
  assert.strictEqual(R.compare({ sticks: 2, perStickGB: 16 }, two16).state, 'match');
  var r = R.compare({ sticks: 2, perStickGB: 16 }, [{ capacityGB: 32 }]);
  assert.strictEqual(r.state, 'mismatch');
  assert.strictEqual(r.expectedText, '2 × 16 GB');
  assert.strictEqual(r.foundText, '1 × 32 GB');
  assert.strictEqual(R.compare({ sticks: 2, perStickGB: 16 }, [{ capacityGB: 16 }]).state, 'mismatch', 'one stick missing');
  assert.strictEqual(R.compare({ sticks: 2, perStickGB: 16 }, [{ capacityGB: 16 }, { capacityGB: 8 }]).foundText, '1 × 16 GB + 1 × 8 GB');
  assert.strictEqual(R.compare({ sticks: null, perStickGB: 16 }, two16).state, 'unknown');
  assert.strictEqual(R.compare({ sticks: 2, perStickGB: 16 }, []).state, 'unknown');
  assert.strictEqual(R.text(4, 8), '4 × 8 GB');
});

console.log((failures ? 'FAILED' : 'OK') + ' case-ports-ram: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
