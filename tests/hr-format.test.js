/*
  Unit tests for shared/hr-format.js (NeoQcHrFormat) — NeoHR's display and
  export rules (HR-SPEC §9.3.2 IST, §9.3.3 clock marks, §9.4.6 settings
  sentences, §9.8 CSV).
  Run: node tests/hr-format.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var F = require(path.join(__dirname, '..', 'shared', 'hr-format.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

// ═══ CSV (§9.8) ═══════════════════════════════════════════════════════════

test('csvCell: every cell is quoted and " is doubled', function () {
  assert.strictEqual(F.csvCell('Anand'), '"Anand"');
  assert.strictEqual(F.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(F.csvCell('a,b'), '"a,b"');
  assert.strictEqual(F.csvCell('two\nlines'), '"two\nlines"');
  assert.strictEqual(F.csvCell(''), '""');
  assert.strictEqual(F.csvCell(null), '""');
  assert.strictEqual(F.csvCell(undefined), '""');
  assert.strictEqual(F.csvCell(12.5), '"12.5"');
  assert.strictEqual(F.csvCell(0), '"0"');
});

test('csvCell: the formula guard — = + - @ TAB CR get a leading quote', function () {
  assert.strictEqual(F.csvCell('=1+2'), '"\'=1+2"');
  assert.strictEqual(F.csvCell('+91 98470'), '"\'+91 98470"');
  assert.strictEqual(F.csvCell('-5'), '"\'-5"');
  assert.strictEqual(F.csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.strictEqual(F.csvCell('\tx'), '"\'\tx"');
  assert.strictEqual(F.csvCell('\rx'), '"\'\rx"');
  assert.strictEqual(F.csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  // only the FIRST character counts
  assert.strictEqual(F.csvCell('a=b'), '"a=b"');
  assert.strictEqual(F.csvCell(' =x'), '" =x"');
  assert.strictEqual(F.csvCell("'=x"), '"\'=x"');
});

test('toCsv: header first, CRLF line ends, trailing CRLF', function () {
  var s = F.toCsv(['a', 'b'], [['1', '2'], ['x"y', '=z']]);
  assert.strictEqual(s, '"a","b"\r\n"1","2"\r\n"x""y","\'=z"\r\n');
});

test('register CSV: the fixed columns, in order', function () {
  assert.deepStrictEqual(F.REGISTER_COLUMNS, ['name', 'date', 'duty', 'status', 'first_in', 'last_out', 'worked', 'break',
    'late', 'early', 'flex', 'missed_out', 'km']);
  var csv = F.registerCsv([]);
  assert.strictEqual(csv, '"name","date","duty","status","first_in","last_out","worked","break","late","early","flex","missed_out","km"\r\n');
});

test('register CSV: a day becomes labels, IST times, H:MM and 2-decimal km', function () {
  var row = F.registerRow({
    name: 'Check Tech', email: 'tech@check.invalid', day: '2026-10-21', duty: 'shop', status: 'late',
    first_in: '2026-10-21T04:22:00Z',          // 09:52 IST
    last_out: '2026-10-21T13:10:00Z',          // 18:40 IST
    worked_min: 470, break_min: 38, late_min: 12, early_min: 0, flex: false, missed_out: false, km: 12.3
  });
  assert.deepStrictEqual(row, ['Check Tech', '2026-10-21', 'Shop', 'Late', '2026-10-21 09:52', '2026-10-21 18:40', '7:50',
    '0:38', '0:12', '', '', '', '12.30']);
});

test('register CSV: never coordinates, notes, reasons or the leave type', function () {
  var csv = F.registerCsv([{ name: 'A', day: '2026-10-21', duty: 'leave', status: 'leave', km: null, flex: true, missed_out: true,
    lat: 10.01234, lng: 76.34567, note: 'SECRET-NOTE', reason: 'SECRET-REASON', leave_type: 'sick',
    events: [{ lat: 10.5, lng: 76.5, note: 'SECRET-EV' }] }]);
  ['10.01234', '76.34567', 'SECRET', 'sick', 'Sick'].forEach(function (s) { assert.ok(csv.indexOf(s) === -1, 'leaked ' + s); });
  assert.ok(/"Leave","Leave","","","","","","","yes","yes",""/.test(csv), csv);
});

test('register CSV: a formula in a name is neutralised', function () {
  var csv = F.registerCsv([{ name: '=cmd|"/c calc"!A1', day: '2026-10-21', status: 'present' }]);
  assert.ok(csv.split('\r\n')[1].indexOf('"\'=cmd|""/c calc""!A1"') === 0, csv);
});

test('TA CSV: the fixed columns; approved by / at in IST', function () {
  assert.deepStrictEqual(F.TA_COLUMNS, ['name', 'month', 'km', 'rate', 'amount', 'approved_by', 'approved_at']);
  var csv = F.taCsv([
    { name: 'Check Tech', km: 412.5, rate: 3.5, amount: 1443.75, approved: { by: 'Check Head', at: '2026-10-01T05:00:00Z' },
      days: [{ day: '2026-09-01', km: 10, lat: 9.9 }] },
    { name: 'Check Free', km: 0, rate: 3.5, amount: 0, approved: null }
  ], '2026-09-01');
  var lines = csv.split('\r\n');
  assert.strictEqual(lines[0], '"name","month","km","rate","amount","approved_by","approved_at"');
  assert.strictEqual(lines[1], '"Check Tech","2026-09","412.50","3.50","1443.75","Check Head","2026-10-01 10:30"');
  assert.strictEqual(lines[2], '"Check Free","2026-09","0.00","3.50","0.00","",""');
  assert.ok(csv.indexOf('9.9') === -1);
});

// ═══ clock marks (§9.3.3) ═════════════════════════════════════════════════

test('clockMark: device time is "not verified"', function () {
  var m = F.clockMark({ at: '2026-10-22T04:00:00Z', device_at: '2026-10-22T04:00:00Z', time_source: 'device' });
  assert.strictEqual(m.text, '⏱ time not verified');
  assert.strictEqual(m.kind, 'unverified');
});

test('clockMark: server time with the phone off by more than 300 s', function () {
  var at = Date.parse('2026-10-22T04:00:00Z');
  assert.strictEqual(F.clockMark({ at: new Date(at).toISOString(), device_at: new Date(at + 300000).toISOString(), time_source: 'server' }), null);
  assert.strictEqual(F.clockMark({ at: new Date(at).toISOString(), device_at: new Date(at - 300000).toISOString(), time_source: 'server' }), null);
  var m = F.clockMark({ at: new Date(at).toISOString(), device_at: new Date(at + 301000).toISOString(), time_source: 'server' });
  assert.strictEqual(m.text, '⏱ phone clock off by 5 min');
  var m2 = F.clockMark({ at: new Date(at).toISOString(), device_at: new Date(at - 47 * 60000).toISOString(), time_source: 'server' });
  assert.strictEqual(m2.text, '⏱ phone clock off by 47 min');
});

test('clockMark: HR time, no device time, or nothing → no mark', function () {
  assert.strictEqual(F.clockMark({ at: '2026-10-22T04:00:00Z', device_at: null, time_source: 'hr' }), null);
  assert.strictEqual(F.clockMark({ at: '2026-10-22T04:00:00Z', device_at: null, time_source: 'server' }), null);
  assert.strictEqual(F.clockMark(null), null);
  assert.strictEqual(F.clockMark({}), null);
});

// ═══ India time (§9.3.2) ══════════════════════════════════════════════════

test('istDay: the shop day flips at 18:30 UTC', function () {
  assert.strictEqual(F.istDay(Date.parse('2026-10-21T18:29:59Z')), '2026-10-21');
  assert.strictEqual(F.istDay(Date.parse('2026-10-21T18:30:00Z')), '2026-10-22');
  assert.strictEqual(F.istDay('2026-10-22T00:10:00+05:30'), '2026-10-22');
  assert.strictEqual(F.istDay('nope'), '');
});

test('istHm / istDateTime / istToIso round-trip', function () {
  assert.strictEqual(F.istHm('2026-10-22T04:01:00Z'), '09:31');
  assert.strictEqual(F.istDateTime('2026-10-22T18:45:00Z'), '2026-10-23 00:15');
  assert.strictEqual(F.istToIso('2026-10-22', '09:31'), '2026-10-22T04:01:00.000Z');
  assert.strictEqual(F.istToIso('2026-10-23', '00:15'), '2026-10-22T18:45:00.000Z');
  assert.strictEqual(F.istToIso('2026-10-22', '24:00'), null);
  assert.strictEqual(F.istToIso('2026-13-01', '09:00'), null);
});

test('weekdayOf: 0 = Sunday, as extract(dow) and weekly_off', function () {
  assert.strictEqual(F.weekdayOf('2026-10-25'), 0);   // Sunday
  assert.strictEqual(F.weekdayOf('2026-10-26'), 1);   // Monday
  assert.strictEqual(F.weekdayOf('2026-10-31'), 6);   // Saturday
  assert.strictEqual(F.weekdayOf('x'), -1);
});

test('weeks and months', function () {
  assert.strictEqual(F.weekStart('2026-10-22'), '2026-10-19');   // Thursday → Monday
  assert.strictEqual(F.weekStart('2026-10-25'), '2026-10-19');   // Sunday ends the week
  assert.strictEqual(F.weekStart('2026-10-26'), '2026-10-26');
  assert.strictEqual(F.monthStart('2026-10-22'), '2026-10-01');
  assert.strictEqual(F.monthEnd('2026-02-10'), '2026-02-28');
  assert.strictEqual(F.monthEnd('2028-02-10'), '2028-02-29');
  assert.strictEqual(F.addMonths('2026-01-15', -1), '2025-12-01');
  assert.strictEqual(F.addMonths('2026-12-01', 1), '2027-01-01');
  assert.strictEqual(F.spanDays('2026-10-01', '2026-10-31'), 30);
  assert.strictEqual(F.monthLabel('2026-10-01'), 'October 2026');
});

test('fmtHm / fmtDur / fmtKm', function () {
  assert.strictEqual(F.fmtHm(485), '8:05');
  assert.strictEqual(F.fmtHm(0), '0:00');
  assert.strictEqual(F.fmtHm(null), '');
  assert.strictEqual(F.fmtHm('x'), '');
  assert.strictEqual(F.fmtDur(45), '45m');
  assert.strictEqual(F.fmtDur(485), '8h 05m');
  assert.strictEqual(F.fmtKm('12.3'), '12.30');
  assert.strictEqual(F.fmtKm(0), '0.00');
  assert.strictEqual(F.fmtKm(null), '');
});

// ═══ settings sentences (§9.4.6) ══════════════════════════════════════════

test('checkSettings: every bound with the server sentence', function () {
  assert.strictEqual(F.checkSettings({ grace_min: 121 }), 'Grace must be between 0 and 120.');
  assert.strictEqual(F.checkSettings({ grace_min: -1 }), 'Grace must be between 0 and 120.');
  assert.strictEqual(F.checkSettings({ half_day_min: 59 }), 'Half-day threshold must be between 60 and 600.');
  assert.strictEqual(F.checkSettings({ track_interval_s: 601 }), 'Tracking interval must be between 30 and 600.');
  assert.strictEqual(F.checkSettings({ track_distance_m: 24 }), 'Tracking distance must be between 25 and 1000.');
  assert.strictEqual(F.checkSettings({ retention_days: 366 }), 'Retention must be between 30 and 365.');
  assert.strictEqual(F.checkSettings({ office_radius_m: 49 }), 'Office radius must be between 50 and 2000.');
  assert.strictEqual(F.checkSettings({ max_session_h: 25 }), 'Longest shift must be between 4 and 24.');
  assert.strictEqual(F.checkSettings({ max_session_h: 4.5 }), 'Longest shift must be between 4 and 24.');
  assert.strictEqual(F.checkSettings({ grace_min: 0, half_day_min: 600, max_session_h: 16 }), null);
  assert.strictEqual(F.checkSettings({ ta_rate_per_km: 1000.01 }), 'Travel allowance rate must be between 0 and 1000.');
  assert.strictEqual(F.checkSettings({ ta_rate_per_km: -1 }), 'Travel allowance rate must be between 0 and 1000.');
  assert.strictEqual(F.checkSettings({ ta_rate_per_km: 3.5 }), null);
  assert.strictEqual(F.checkSettings({ office_lat: 91, office_lng: 76 }), 'That office point is not on the map.');
  assert.strictEqual(F.checkSettings({ office_lat: 10.01, office_lng: 76.34 }), null);
});

test('checkSettings: the shift, weekly off, and null = use the default', function () {
  assert.strictEqual(F.checkSettings({ shift_start: '18:30', shift_end: '09:30' }), 'The shift must end after it starts.');
  assert.strictEqual(F.checkSettings({ shift_end: '09:00' }, { shift_start: '09:30', shift_end: '18:30' }), 'The shift must end after it starts.');
  assert.strictEqual(F.checkSettings({ shift_start: '09:30', shift_end: '18:30' }), null);
  assert.strictEqual(F.checkSettings({ weekly_off: [0, 0] }), 'Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.');
  assert.strictEqual(F.checkSettings({ weekly_off: [7] }), 'Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.');
  assert.strictEqual(F.checkSettings({ weekly_off: [] }), null);
  assert.strictEqual(F.checkSettings({ weekly_off: [0, 6] }), null);
  assert.strictEqual(F.checkSettings({ grace_min: null, shift_start: null, weekly_off: null }), null);
});

test('shiftOn / shiftsAfter: the row in force on a day, not the newest one', function () {
  // hr_settings_get().history: the default rows, newest first; the top-level
  // shift fields are a copy of the newest (here a change from next week).
  var hist = [
    { effective_from: '2026-10-27', shift_start: '14:00', shift_end: '22:00', grace_min: 10, weekly_off: [0], half_day_min: 240 },
    { effective_from: '2026-03-01', shift_start: '09:30', shift_end: '18:30', grace_min: 10, weekly_off: [0], half_day_min: 240 },
    { effective_from: '2020-01-01', shift_start: '09:00', shift_end: '18:00', grace_min: 15, weekly_off: [0], half_day_min: 240 }
  ];
  assert.strictEqual(F.shiftOn(hist, '2026-10-22').shift_start, '09:30');
  assert.strictEqual(F.shiftOn(hist, '2026-10-26').shift_end, '18:30');
  assert.strictEqual(F.shiftOn(hist, '2026-10-27').shift_start, '14:00');   // the change day itself
  assert.strictEqual(F.shiftOn(hist, '2026-02-28').shift_start, '09:00');
  assert.strictEqual(F.shiftOn(hist, '2019-12-31'), null);
  assert.strictEqual(F.shiftOn(hist.slice().reverse(), '2026-10-22').shift_start, '09:30');   // any order
  assert.strictEqual(F.shiftOn([{ effective_from: '2026-10-01T00:00:00' }, { effective_from: null }, null], '2026-10-22').effective_from, '2026-10-01T00:00:00');
  assert.strictEqual(F.shiftOn([], '2026-10-22'), null);
  assert.strictEqual(F.shiftOn(null, '2026-10-22'), null);
  assert.strictEqual(F.shiftOn(hist, 'today'), null);
  assert.deepStrictEqual(F.shiftsAfter(hist, '2026-10-22').map(function (r) { return r.effective_from; }), ['2026-10-27']);
  assert.deepStrictEqual(F.shiftsAfter(hist, '2026-01-01').map(function (r) { return r.effective_from; }), ['2026-03-01', '2026-10-27']);
  assert.deepStrictEqual(F.shiftsAfter(hist, '2026-10-27'), []);
  assert.deepStrictEqual(F.shiftsAfter(null, '2026-10-22'), []);
  // The review case: shift_end 13:00 from tomorrow is checked against the
  // shift in force tomorrow (09:30–18:30), as the server checks it, and not
  // against next week's 14:00 start.
  var base = F.shiftOn(hist, '2026-10-23');
  assert.strictEqual(F.checkSettings({ shift_end: '13:00', effective_from: '2026-10-23' }, { shift_start: base.shift_start, shift_end: base.shift_end }), null);
  var later = F.shiftOn(hist, '2026-10-28');
  assert.strictEqual(F.checkSettings({ shift_end: '13:00', effective_from: '2026-10-28' }, { shift_start: later.shift_start, shift_end: later.shift_end }),
    'The shift must end after it starts.');
});

test('labels: every live status, duty and request kind has one', function () {
  F.LIVE_ORDER.forEach(function (k) { assert.ok(F.LIVE_LABELS[k], k); });
  ['on_duty', 'on_break', 'on_site', 'off_duty', 'on_leave', 'absent', 'off', 'not_in_yet', 'not_tracked'].forEach(function (k) {
    assert.ok(F.LIVE_ORDER.indexOf(k) !== -1, k);
  });
  F.DUTIES.forEach(function (k) { assert.ok(F.DUTY_LABELS[k], k); });
  ['late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave'].forEach(function (k) { assert.ok(F.REQUEST_LABELS[k], k); });
  ['present', 'late', 'half_day', 'absent', 'leave', 'off', 'open', 'not_in_yet', 'not_tracked'].forEach(function (k) {
    assert.ok(F.DAY_LABELS[k] && F.DAY_CODES[k], k);
  });
  assert.strictEqual(F.SELF_SENTENCE, 'Someone else has to approve or change your own attendance, duty or travel allowance.');
  assert.strictEqual(F.weeklyOffText([6, 0]), 'Sunday, Saturday');
  assert.strictEqual(F.shiftText({ start: '09:30:00', end: '18:30:00' }), '09:30–18:30');
});

console.log((failures ? 'FAILED' : 'OK') + ' hr-format: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
