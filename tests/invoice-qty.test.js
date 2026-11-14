/*
  Unit tests for the quantity handling in shared/invoice-import.js
  (Neo OS 1.12.5): how many of an item an invoice line sells, so RAM gets the
  right number of sticks, and names without stray quantity / HSN columns.
  Run: node tests/invoice-qty.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var I = require(path.join(__dirname, '..', 'shared', 'invoice-import.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}
function row(line) { return I.reconstructRows(line)[0]; }

test('"2 PCS" is the quantity, not part of the name', function () {
  var r = row('Corsair Vengeance 16GB DDR5 5600MHz 2 PCS 5,500.00 11,000.00');
  assert.strictEqual(r.text, 'Corsair Vengeance 16GB DDR5 5600MHz');
  assert.strictEqual(r.qty, 2);
});

test('a bare quantity column after the noun', function () {
  var r = row('Kingston Fury Beast 16GB DDR5 RAM 2 5,500.00 11,000.00');
  assert.strictEqual(r.text, 'Kingston Fury Beast 16GB DDR5 RAM');
  assert.strictEqual(r.qty, 2);
});

test('a leading "2 x" is the quantity', function () {
  var r = row('2 x Corsair Vengeance 16GB DDR5 5,500.00 11,000.00');
  assert.strictEqual(r.text, 'Corsair Vengeance 16GB DDR5');
  assert.strictEqual(r.qty, 2);
});

test('total ÷ rate, with or without 18% GST', function () {
  assert.strictEqual(I._extractQty('RAM', 5500, 11000), 2);
  assert.strictEqual(I._extractQty('RAM', 5500, 12980), 2, '2 × 5,500 + 18% GST');
  assert.strictEqual(I._extractQty('RAM', 12999, 15338.82), 1, 'one item with GST is not two');
  assert.strictEqual(I._extractQty('RAM', 5500, 5500), 1);
});

test('a 4-digit HSN heading and a quantity of 1 leave the cabinet name', function () {
  var r = row('Lian Li Lancool 216 Cabinet 8473 1 6,299.00 6,299.00');
  assert.strictEqual(r.text, 'Lian Li Lancool 216 Cabinet');
  assert.strictEqual(r.qty, 1);
});

test('the same RAM stick billed on two lines adds up', function () {
  var text = '1 Corsair Vengeance 16GB DDR5 5600MHz 5,500.00 5,500.00\n' +
             '2 Corsair Vengeance 16GB DDR5 5600MHz 5,500.00 5,500.00\n' +
             '3 AMD Ryzen 7 7800X3D Processor 32,000.00 32,000.00';
  var b = I.buildFromInvoice(text, null);
  assert.ok(b.results.ram, 'RAM found');
  assert.strictEqual(b.results.ram.quantity, 2);
  assert.strictEqual(b.results.cpu.quantity, 1);
});

test('a kit name keeps its own size; quantity stays 1', function () {
  var r = row('G.Skill Trident Z5 32GB (2x16GB) DDR5 RAM 12,999.00 15,338.82');
  assert.strictEqual(r.qty, 1);
  assert.ok(/32GB \(2x16GB\)/.test(r.text));
});

console.log((failures ? 'FAILED' : 'OK') + ' invoice-qty: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
