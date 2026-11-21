/*
  Unit tests for dashboard/tracker/tracker-core.js (the customer tracker's logic).
  Run: node tests/tracker-core.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var T = require(path.join(__dirname, '..', 'dashboard', 'tracker', 'tracker-core.js'));
var S = require(path.join(__dirname, '..', 'shared', 'service-status.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var HOUR = 3600000, DAY = 86400000;
// 21 Nov 2026, 12:00 India time.
var NOW = Date.UTC(2026, 10, 21, 6, 30);
function iso(t) { return new Date(t).toISOString(); }

// ── Codes ───────────────────────────────────────────────────────────────────
test('formatCode: build codes are 6 upper-case characters', function () {
  assert.strictEqual(T.formatCode('7f3a2c'), '7F3A2C');
  assert.strictEqual(T.formatCode(' 7f 3a2c9 '), '7F3A2C');
});
test('formatCode: the dash waits until a service code is clear', function () {
  assert.strictEqual(T.formatCode('nt'), 'NT');
  assert.strictEqual(T.formatCode('nt4k7q'), 'NT4K7Q');          // could still be a build code
  assert.strictEqual(T.formatCode('nt4k7q2'), 'NT-4K7Q2');
  assert.strictEqual(T.formatCode('nt-4k'), 'NT-4K');            // a typed dash settles it
  assert.strictEqual(T.formatCode('NT 4K7Q2M9X'), 'NT-4K7Q2M9X');
  assert.strictEqual(T.formatCode('rm-7h2d4l9cEXTRA'), 'RM-7H2D4L9C');
});
test('kindOf', function () {
  assert.strictEqual(T.kindOf('7F3A2C'), 'build');
  assert.strictEqual(T.kindOf('NT4K7Q'), 'build');
  assert.strictEqual(T.kindOf('NT-4K7Q2M9X'), 'repair');
  assert.strictEqual(T.kindOf('RM-7H2D4L9C'), 'warranty');
  assert.strictEqual(T.kindOf('RM-8H2D5L1C'), null);             // 8, 5, 1 are never used
  assert.strictEqual(T.kindOf('7F3A2'), null);
});
test('codeProblem names look-alike characters', function () {
  assert.ok(/0, O/.test(T.codeProblem('NT-4K0Q2MOX')));
  assert.strictEqual(T.codeProblem('NT-4K7Q2M9X'), null);
  assert.ok(/8 characters/.test(T.codeProblem('NT-4K7')));
  assert.ok(/6 characters/.test(T.codeProblem('7F3')));
});
test('extractCode finds codes in pasted messages and links', function () {
  assert.strictEqual(T.extractCode('Hi Fathima, track your repair with code NT-4K7Q2M9X on our site'), 'NT-4K7Q2M9X');
  assert.strictEqual(T.extractCode('your code is rm 7h2d4l9c'), 'RM-7H2D4L9C');
  assert.strictEqual(T.extractCode('Build ticket 7F3A2C, total 142800, pincode 682024'), '7F3A2C');
  assert.strictEqual(T.extractCode('STATUS update for you'), null);
  assert.strictEqual(T.extractCode('https://neoqctracker.netlify.app/t/NT-4K7Q2M9X'), 'NT-4K7Q2M9X');
});
test('extractPhone4 takes the last 4 digits', function () {
  assert.strictEqual(T.extractPhone4('+91 98470 51234'), '1234');
  assert.strictEqual(T.extractPhone4('12'), null);
});

// ── Time (India) ────────────────────────────────────────────────────────────
test('dates read in India time with today / yesterday', function () {
  assert.strictEqual(T.fmtClock(NOW), '12:00 pm');
  assert.strictEqual(T.fmtWhen(NOW - 2 * HOUR, NOW), 'Today, 10:00 am');
  assert.strictEqual(T.fmtWhen(NOW - DAY, NOW), 'Yesterday, 12:00 pm');
  assert.strictEqual(T.fmtDay(NOW + 2 * DAY), 'Mon 23 Nov');
  assert.strictEqual(T.fmtSince(NOW - HOUR, NOW), 'today, 11:00 am');
});
test('visit ranges share the am/pm when they can', function () {
  var s = Date.UTC(2026, 10, 22, 8, 30), e = Date.UTC(2026, 10, 22, 10, 30);   // 2–4 pm IST
  assert.ok(/^Tomorrow, 2:00–4:00 pm/.test(T.fmtRange(iso(s), iso(e), NOW)));
});

// ── Builds ──────────────────────────────────────────────────────────────────
test('buildView: in testing, on track, newest event first', function () {
  var v = T.buildView({
    code: 'qz7k2p', full: true, status: 'qc_testing', type: 'build', first_name: 'Arjun', technician: 'Athul',
    created_at: iso(NOW - 3 * DAY), deadline: iso(NOW + 2 * DAY),
    steps: [{ at: iso(NOW - 5 * HOUR), step: 'qc_testing' }, { at: iso(NOW - DAY), step: 'building' }, { at: iso(NOW - 3 * DAY), step: 'created' }]
  }, NOW);
  assert.strictEqual(v.code, 'QZ7K2P');
  assert.strictEqual(v.sentence, 'Your PC is being stress-tested');
  assert.strictEqual(v.track.index, 3);
  assert.strictEqual(v.due.state, 'ok');
  assert.strictEqual(v.events[0].title, 'Testing started');
  assert.strictEqual(v.events.length, 3);
});
test('buildView: a missed deadline is owned, not hidden', function () {
  var v = T.buildView({ code: 'AAAAA1', status: 'building', deadline: iso(NOW - HOUR), created_at: iso(NOW - DAY) }, NOW);
  assert.strictEqual(v.due.state, 'late');
  assert.ok(/longer than we said/.test(v.due.note));
});
test('buildView: limited view never shows QC', function () {
  var v = T.buildView({ code: 'AAAAA1', full: false, status: 'completed', completed_at: iso(NOW), qc: { cpu_temp_max: 70 } }, NOW);
  assert.strictEqual(v.qc, null);
  assert.strictEqual(v.track.complete, true);
});
test('qcVerdict follows the shop rule', function () {
  assert.strictEqual(T.qcVerdict({ cpu_temp_max: 85, gpu_temp_max: 80, ram_stress: 'passed' }), true);
  assert.strictEqual(T.qcVerdict({ cpu_temp_max: 86 }), false);
  assert.strictEqual(T.qcVerdict({ ram_stress: 'failed' }), false);
  assert.strictEqual(T.qcVerdict({}), null);
});

// ── Repairs and parts (wording from shared/service-status.js) ───────────────
test('serviceView: quote waiting for the customer', function () {
  var v = T.serviceView({
    public_code: 'NT-4K7Q2M9X', stage: 'quoted', stage_since: iso(NOW - 20 * HOUR), customer_name: 'Fathima Rahman',
    device_label: 'ASUS TUF A15', service_type: 'in_store', handled_by: 'Vishnu', created_at: iso(NOW - 2 * DAY),
    events: [{ at: iso(NOW - 20 * HOUR), body: null, to_stage: 'quoted' }], rma_units: []
  }, S, NOW);
  assert.strictEqual(v.ball, 'customer');
  assert.strictEqual(v.holder.label, 'Needs you');
  assert.strictEqual(v.name, 'Fathima');
  assert.strictEqual(v.sentence, S.STAGES.quoted.customer);
  assert.strictEqual(v.events[0].title, S.STAGES.quoted.customer);
  assert.ok(/go ahead/.test(v.next));
});
test('serviceView: promised date passed is owned', function () {
  var v = T.serviceView({ public_code: 'NT-4K7Q2M9X', stage: 'in_service', stage_since: iso(NOW - DAY), promised_at: iso(NOW - DAY), service_type: 'in_store' }, S, NOW);
  assert.strictEqual(v.due.state, 'late');
});
test('serviceView: an on-site visit shows the booked window', function () {
  var v = T.serviceView({ public_code: 'NT-4K7Q2M9X', stage: 'scheduled', stage_since: iso(NOW - HOUR), service_type: 'on_site',
    visit_start: iso(NOW + DAY), visit_end: iso(NOW + DAY + 2 * HOUR) }, S, NOW);
  assert.strictEqual(v.due.label, 'Visit booked');
  assert.ok(/^Tomorrow, 12:00–2:00 pm/.test(v.due.value));
});
test('rmaView: with the manufacturer, expected back', function () {
  var v = T.rmaView({ public_code: 'RM-7H2D4L9C', label: 'Kingston Fury 32 GB DDR5', kind: 'ram', stage: 'with_vendor',
    stage_since: iso(NOW - 4 * DAY), waiting_party: 'Kingston', expected_back_at: iso(NOW + 9 * DAY), return_method: 'collect', events: [] }, S, NOW);
  assert.strictEqual(v.ball, 'third_party');
  assert.strictEqual(v.holder.label, 'With Kingston');
  assert.ok(/^Around /.test(v.due.value));
});

console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
