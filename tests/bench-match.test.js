/*
  Unit tests for shared/bench-match.js (NeoBenchMatch): the Bench's
  "is this the right PC?" check before a stress test (Neo OS 1.12.4).
  Run: node tests/bench-match.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var B = require(path.join(__dirname, '..', 'shared', 'bench-match.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var AMD_PC = { cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', dgpu: 'NVIDIA GeForce RTX 4070 SUPER', igpu: 'AMD Radeon(TM) Graphics', gpu: 'NVIDIA GeForce RTX 4070 SUPER' };
var INTEL_PC = { cpu: 'Intel(R) Core(TM) i7-14700K', dgpu: 'None', igpu: 'Intel(R) UHD Graphics 770', gpu: 'Intel(R) UHD Graphics 770' };

test('model numbers: the first 3+ digit run of each word', function () {
  assert.deepStrictEqual(B.modelNumbers('Intel(R) Core(TM) i7-14700K'), ['14700']);
  assert.deepStrictEqual(B.modelNumbers('AMD Ryzen 7 7800X3D 8-Core Processor'), ['7800']);
  assert.deepStrictEqual(B.modelNumbers('RTX 4070 Super 12GB'), ['4070']);
  assert.deepStrictEqual(B.modelNumbers('Ryzen 5 7600 (6C/12T, 5.1GHz)'), ['7600']);
  assert.deepStrictEqual(B.modelNumbers('Intel Arc A770'), ['770']);
  assert.deepStrictEqual(B.modelNumbers('Specs not set'), []);
});

test('the right PC matches, however the spec is written', function () {
  assert.strictEqual(B.compare(AMD_PC, { cpu: 'Ryzen 7 7800X3D', gpu: 'RTX 4070 Super 12GB' }).match, true);
  assert.strictEqual(B.compare(INTEL_PC, { cpu: 'Core i7 14700KF', gpu: '' }).match, true, 'K vs KF is not a wrong PC');
  assert.strictEqual(B.compare(INTEL_PC, { cpu: 'i7-14700K', gpu: 'UHD 770 (integrated)' }).match, true, 'integrated graphics');
});

test('a different PC is a mismatch, with what was found and what was expected', function () {
  var r = B.compare(INTEL_PC, { cpu: 'Ryzen 9 9950X', gpu: 'RTX 5080' });
  assert.strictEqual(r.match, false);
  assert.deepStrictEqual(r.mismatches.map(function (m) { return m.part; }), ['Processor', 'Graphics']);
  assert.strictEqual(r.mismatches[0].here, 'Intel(R) Core(TM) i7-14700K');
  assert.strictEqual(r.mismatches[0].build, 'Ryzen 9 9950X');
  assert.strictEqual(r.mismatches[1].here, 'Intel(R) UHD Graphics 770');
});

test('only the graphics card differs', function () {
  var r = B.compare(AMD_PC, { cpu: 'Ryzen 7 7800X3D', gpu: 'RX 7900 XTX' });
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.mismatches.length, 1);
  assert.strictEqual(r.mismatches[0].part, 'Graphics');
});

test('a build with a graphics card on a PC with none found', function () {
  var r = B.compare({ cpu: 'Intel(R) Core(TM) i5-14400F', dgpu: 'None', igpu: 'None', gpu: 'None' }, { cpu: 'i5 14400F', gpu: 'RTX 4060' });
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.mismatches[0].here, 'no graphics card found');
});

test("can't tell: never a mismatch", function () {
  assert.strictEqual(B.compare(null, { cpu: 'Ryzen 7 7800X3D' }).match, null, 'nothing detected');
  assert.strictEqual(B.compare({ cpu: 'Failed to detect', gpu: 'None' }, { cpu: 'Ryzen 7 7800X3D' }).match, null, 'detection failed');
  assert.strictEqual(B.compare({ cpu: 'Detection error: timeout' }, { cpu: 'Ryzen 7 7800X3D' }).match, null);
  assert.strictEqual(B.compare(AMD_PC, {}).match, null, 'no specs on the build');
  assert.strictEqual(B.compare(AMD_PC, { cpu: 'Specs not set', gpu: '--' }).match, null, 'specs without model numbers');
});

console.log((failures ? 'FAILED' : 'OK') + ' bench-match: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
