/*
  Unit tests for NeoQcPrintRender.reportSerials (print-render.js) — Neo OS
  1.12.5: every serial the ticket holds reaches the QC report's spec table.
  Before this, the report read only the flat ticket.serials map (five parts) and
  had no serial cell for the CPU, cooler or PSU.
  Run: node tests/print-serials.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var R = require(path.join(__dirname, '..', 'print-render.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var ROWS = ['cpu', 'gpu', 'ram', 'ssd', 'mobo', 'cooler', 'psu', 'cabinet'];

test('every row is present and empty for a bare ticket', function () {
  var s = R.reportSerials({});
  assert.deepStrictEqual(Object.keys(s).sort(), ROWS.slice().sort());
  ROWS.forEach(function (r) { assert.deepStrictEqual(s[r], []); });
});

test('CPU, cooler and PSU scans from Component Verification reach the report', function () {
  var s = R.reportSerials({
    serials: { motherboard: '', ram: '', gpu: '', ssd: '', cabinet: '' },
    specs: { __verify: { components: {
      cpu: { scan: 'CPU-1' }, psu: { scan: 'PSU-1' }, cooler: { scan: 'CLR-1' }
    } } }
  });
  assert.deepStrictEqual(s.cpu, ['CPU-1']);
  assert.deepStrictEqual(s.psu, ['PSU-1']);
  assert.deepStrictEqual(s.cooler, ['CLR-1']);
});

test('every RAM stick prints, from the scan rows and from the flat map', function () {
  var s = R.reportSerials({
    serials: { ram: 'R1, R2, R3' },
    specs: { __verify: { components: { ram: { scan: 'R1', extraScans: ['R2', '', 'R3'] } } } }
  });
  assert.deepStrictEqual(s.ram, ['R1', 'R2', 'R3']);
});

test('a flat-map serial the scan rows lack is still printed', function () {
  var s = R.reportSerials({
    serials: { gpu: 'GPU-OLD', ram: 'R1, R2' },
    specs: { __verify: { components: { ram: { scan: 'R1' } } } }
  });
  assert.deepStrictEqual(s.gpu, ['GPU-OLD']);
  assert.deepStrictEqual(s.ram, ['R1', 'R2']);
});

test('the same serial in two places, different case or dashes, prints once', function () {
  var s = R.reportSerials({
    serials: { motherboard: 'mb 77-61' },
    specs: { __verify: { components: { motherboard: { scan: 'MB-7761' } } } }
  });
  assert.deepStrictEqual(s.mobo, ['MB-7761']);
});

test('legacy key spellings: mobo, ssd, cabinet', function () {
  var s = R.reportSerials({ serials: { mobo: 'M1', ssd: 'S1', cabinet: 'C1' } });
  assert.deepStrictEqual(s.mobo, ['M1']);
  assert.deepStrictEqual(s.ssd, ['S1']);
  assert.deepStrictEqual(s.cabinet, ['C1']);
});

test('storage and cabinet scans map to the ssd and cabinet rows', function () {
  var s = R.reportSerials({ specs: { __verify: { components: {
    storage: { scan: 'SSD-9' }, case: { scan: 'CASE-9' }
  } } } });
  assert.deepStrictEqual(s.ssd, ['SSD-9']);
  assert.deepStrictEqual(s.cabinet, ['CASE-9']);
});

test('goods-in serial is the fallback when nothing else was recorded', function () {
  var s = R.reportSerials({ specs: { __procurement: { components: {
    psu: { partNo: 'P', serial: 'PSU-GOODSIN' }, gpu: { serial: 'GPU-GOODSIN' }
  } }, __verify: { components: { gpu: { scan: 'GPU-SCAN' } } } } });
  assert.deepStrictEqual(s.psu, ['PSU-GOODSIN']);
  assert.deepStrictEqual(s.gpu, ['GPU-SCAN'], 'a build-time scan wins over goods-in');
});

test('box condition alone (no scan) does not produce a serial', function () {
  var s = R.reportSerials({ specs: { __verify: { components: { cpu: { box: 'sealed' } } } } });
  assert.deepStrictEqual(s.cpu, []);
});

console.log(passed + ' passed, ' + failures + ' failed');
if (failures) process.exit(1);
