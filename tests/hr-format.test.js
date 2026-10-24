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

// ═══ v1.12.1: the checked punch (sql v2.4) ════════════════════════════════

test('punch request kinds: labelled, and the v2.3 kinds keep their words', function () {
  assert.deepStrictEqual(F.PUNCH_REQUEST_KINDS, ['punch_reason', 'away_punch']);
  assert.strictEqual(F.REQUEST_LABELS.punch_reason, 'Punch-in reason');
  assert.strictEqual(F.REQUEST_LABELS.away_punch, 'Away from shop');
  assert.strictEqual(F.REQUEST_LABELS.late_start, 'Late start');
  assert.strictEqual(F.REQUEST_LABELS.flexible_day, 'Flexible day (on-site / RMA)');
  assert.strictEqual(F.isPunchRequestKind('away_punch'), true);
  assert.strictEqual(F.isPunchRequestKind('punch_reason'), true);
  assert.strictEqual(F.isPunchRequestKind('late_start'), false);
  assert.strictEqual(F.isPunchRequestKind(null), false);
});

test('vocabularies: every server word has a label; an unknown one shows as itself', function () {
  ['late', 'on_site', 'rma', 'other'].forEach(function (k) { assert.ok(F.REASON_LABELS[k], k); });
  ['office', 'away', 'unknown', 'unset'].forEach(function (k) { assert.ok(F.PLACE_LABELS[k], k); });
  ['ok', 'weak_fix', 'no_fix', 'mock', 'old_app', 'restored', 'hr'].forEach(function (k) { assert.ok(F.VERIFY_LABELS[k], k); });
  ['sent_late', 'new_login', 'odd_client', 'no_ticket', 'ticket_not_mine', 'selfie_skip', 'selfie_late', 'selfie_time',
   'mock_route', 'emulator', 'request_failed'].forEach(function (k) {
    assert.ok(F.FLAG_LABELS[k] && F.FLAG_TIPS[k], k);
  });
  // the phone's words for the same flags (HrUi.flagLabel)
  assert.strictEqual(F.FLAG_LABELS.mock_route, 'Fake GPS on the route');
  assert.strictEqual(F.FLAG_LABELS.request_failed, 'Request not created — check this punch');
  ['camera_error', 'no_front_camera'].forEach(function (k) { assert.ok(F.SELFIE_SKIP_LABELS[k], k); });
  ['on_site', 'rma'].forEach(function (k) { assert.ok(F.TRIP_LABELS[k], k); });
  ['tapped', 'punch_out', 'cap', 'next_trip', 'hr'].forEach(function (k) { assert.ok(F.TRIP_END_LABELS[k], k); });
  ['late_excused', 'pending_reason', 'away_pending'].forEach(function (k) { assert.ok(F.MARK_LABELS[k], k); });
  assert.strictEqual(F.LIVE_TRIP_LABEL, 'On a trip');
  assert.strictEqual(F.words(F.FLAG_LABELS, 'brand_new_flag'), 'brand new flag');
  assert.strictEqual(F.words(F.FLAG_LABELS, 'sent_late'), 'Sent late');
  assert.strictEqual(F.words(F.FLAG_LABELS, null), '');
  assert.strictEqual(F.words(F.FLAG_LABELS, 'toString'), 'toString');   // never a prototype member
  // the live statuses are unchanged: a trip is a column, not a status
  assert.ok(F.LIVE_ORDER.indexOf('on_trip') === -1);
});

test('distText: metres to 10 m, then km with one decimal', function () {
  assert.strictEqual(F.distText(0), '0 m');
  assert.strictEqual(F.distText(7), '7 m');
  assert.strictEqual(F.distText(84), '80 m');
  assert.strictEqual(F.distText(85), '90 m');
  assert.strictEqual(F.distText(994), '990 m');
  assert.strictEqual(F.distText(996), '1.0 km');
  assert.strictEqual(F.distText(1234), '1.2 km');
  assert.strictEqual(F.distText('15460'), '15.5 km');
  assert.strictEqual(F.distText(123456), '123 km');
  assert.strictEqual(F.distText(null), '');
  assert.strictEqual(F.distText(-5), '');
  assert.strictEqual(F.distText('x'), '');
});

test('placeText / verifyText / placeTone: the place matrix', function () {
  var cases = [
    [{ place: 'office', office_m: 40, verify: 'ok' }, 'At the shop', '', 'ok'],
    [{ place: 'office', office_m: 120, verify: 'weak_fix' }, 'At the shop (weak GPS)', '', 'away'],
    [{ place: 'away', office_m: 1234, verify: 'ok' }, '1.2 km from the shop', '', 'away'],
    [{ place: 'away', office_m: null, verify: 'ok' }, 'Away from the shop', '', 'away'],
    [{ place: 'unknown', office_m: 400, verify: 'weak_fix' }, 'Weak GPS (about 400 m away)', '', 'bad'],
    [{ place: 'unknown', office_m: null, verify: 'no_fix' }, 'No location', '', 'bad'],
    [{ place: 'unset', office_m: null, verify: 'ok' }, 'Office location not set', '', 'muted'],
    [{ place: 'unknown', verify: 'mock' }, 'Fake GPS', '', 'bad'],
    [{ place: 'office', office_m: 30, verify: 'old_app' }, 'At the shop', 'Not verified — old NeoHR', 'away'],
    [{ place: 'unknown', verify: 'old_app' }, 'No location', 'Not verified — old NeoHR', 'bad'],
    [{ place: 'away', office_m: 5100, verify: 'restored' }, '5.1 km from the shop', 'Restored from a backup', 'away'],
    [{ place: null, verify: 'hr' }, 'Added by HR', 'Added by HR', 'muted'],
    [{}, '', '', 'muted'],
    [{ place: 'moon', verify: 'ok' }, 'moon', '', 'muted']
  ];
  cases.forEach(function (c) {
    assert.strictEqual(F.placeText(c[0]), c[1], 'placeText ' + JSON.stringify(c[0]));
    assert.strictEqual(F.verifyText(c[0]), c[2], 'verifyText ' + JSON.stringify(c[0]));
    assert.strictEqual(F.placeTone(c[0]), c[3], 'placeTone ' + JSON.stringify(c[0]));
  });
  assert.strictEqual(F.placeText(null), '');
  assert.strictEqual(F.verifyText(null), '');
  assert.strictEqual(F.placeTone(null), 'muted');
});

test('flagList: the server flags in order, once each; a skipped photo says why', function () {
  var l = F.flagList({ flags: ['sent_late', 'new_login', 'sent_late', 'zz_new', 7, null] });
  assert.deepStrictEqual(l.map(function (f) { return f.key; }), ['sent_late', 'new_login', 'zz_new']);
  assert.strictEqual(l[0].text, 'Sent late');
  assert.ok(/10 minutes/.test(l[0].tip));
  assert.strictEqual(l[2].text, 'zz new');
  assert.strictEqual(l[2].tip, '');
  var s = F.flagList({ flags: ['selfie_skip'], selfie_skip: 'no_front_camera' });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].text, 'No photo (no front camera)');
  var s2 = F.flagList({ flags: [], selfie_skip: 'camera_error' });
  assert.deepStrictEqual(s2.map(function (f) { return f.text; }), ['No photo (the camera did not work)']);
  assert.deepStrictEqual(F.flagList({}), []);
  assert.deepStrictEqual(F.flagList({ flags: 'sent_late' }), []);
  assert.deepStrictEqual(F.flagList(null), []);
});

test('flagList: fake GPS on the route says how many points when the phone counted them', function () {
  var m = F.flagList({ flags: ['mock_route'], device_flags: { mock_route_points: 40, dev_options: true } });
  assert.strictEqual(m[0].text, 'Fake GPS on the route');
  assert.strictEqual(m[0].tip, 'The phone dropped 40 fake-GPS route points since the last punch.');
  assert.strictEqual(F.flagList({ flags: ['mock_route'], device_flags: { mock_route_points: 1 } })[0].tip,
    'The phone dropped 1 fake-GPS route point since the last punch.');
  // no count (or a junk one): the general sentence
  [undefined, null, {}, { mock_route_points: 'x' }, { mock_route_points: 0 }, { mock_route_points: 2.5 }, 'str'].forEach(function (df) {
    assert.strictEqual(F.flagList({ flags: ['mock_route'], device_flags: df })[0].tip, F.FLAG_TIPS.mock_route, JSON.stringify(df));
  });
  // the phone's own flags never become tags on their own (only the server's flags[] do)
  assert.deepStrictEqual(F.flagList({ flags: [], device_flags: { mock_route_points: 9 } }), []);
  assert.strictEqual(F.flagList({ flags: ['request_failed'] })[0].text, 'Request not created — check this punch');
});

test('reasonText: the reason kind, the typed text and the ticket', function () {
  assert.strictEqual(F.reasonText({ reason_kind: 'late', reason_text: null }), 'Late');
  assert.strictEqual(F.reasonText({ reason_kind: 'late', reason_text: 'Bus was late' }), 'Late — “Bus was late”');
  assert.strictEqual(F.reasonText({ reason_kind: 'other', reason_text: 'Bank visit' }), 'Own reason — “Bank visit”');
  assert.strictEqual(F.reasonText({ reason_kind: 'on_site', reason_ref: 'NT-0412' }), 'On-site · NT-0412');
  assert.strictEqual(F.reasonText({ reason_kind: 'rma', reason_text: '  ', reason_ref: 'RM-0031' }), 'RMA · RM-0031');
  assert.strictEqual(F.reasonText({ reason_text: 'No reason sent (NeoHR 2.2)' }), '“No reason sent (NeoHR 2.2)”');
  assert.strictEqual(F.reasonText({}), '');
  assert.strictEqual(F.reasonText(null), '');
  // the server's placeholders already name the kind: said once, as they are
  assert.strictEqual(F.reasonText({ reason_kind: 'late', reason_text: 'Late — no reason typed' }), 'Late — no reason typed');
  assert.strictEqual(F.reasonText({ reason_kind: 'on_site', reason_text: 'On-site visit', reason_ref: 'NT-0412' }), 'On-site visit · NT-0412');
  assert.strictEqual(F.reasonText({ reason_kind: 'rma', reason_text: 'RMA trip' }), 'RMA trip');
  assert.strictEqual(F.reasonText({ reason_kind: 'other', reason_text: 'No reason typed' }), 'Own reason — “No reason typed”');
  // a word that only starts with the label is typed text, not a placeholder
  assert.strictEqual(F.reasonText({ reason_kind: 'late', reason_text: 'Lateness of the bus' }), 'Late — “Lateness of the bus”');
});

test('reasonLine: the reason-kind label in front of a request reason, once', function () {
  assert.strictEqual(F.reasonLine('Late', 'Bus broke down'), 'Late — Bus broke down');
  assert.strictEqual(F.reasonLine('Late', 'Late — no reason typed'), 'Late — no reason typed');
  assert.strictEqual(F.reasonLine('On-site', 'On-site visit'), 'On-site visit');
  assert.strictEqual(F.reasonLine('RMA', 'RMA trip'), 'RMA trip');
  assert.strictEqual(F.reasonLine('RMA', 'rma trip'), 'rma trip');
  assert.strictEqual(F.reasonLine('Late', 'Lateness'), 'Late — Lateness');
  assert.strictEqual(F.reasonLine('Late', ''), 'Late');
  assert.strictEqual(F.reasonLine('Late', null), 'Late');
  assert.strictEqual(F.reasonLine('', 'No reason sent (NeoHR 2.2)'), 'No reason sent (NeoHR 2.2)');
  assert.strictEqual(F.reasonLine(null, null), '');
});

test('dueText: decide by the end of the day, or past it', function () {
  var due = '2026-10-24T13:00:00Z';                      // 18:30 IST
  assert.deepStrictEqual(F.dueText({ status: 'pending', due_at: due, past_eod: false }, '2026-10-24'), { text: 'Decide by 18:30', late: false });
  assert.deepStrictEqual(F.dueText({ status: 'pending', due_at: due, past_eod: true }, '2026-10-24'), { text: 'Past end of day', late: true });
  assert.deepStrictEqual(F.dueText({ status: 'pending', due_at: due }, '2026-10-25'), { text: 'Decide by 18:30 (Yesterday)', late: false });
  // no past_eod from the server: the server clock decides
  assert.deepStrictEqual(F.dueText({ status: 'pending', due_at: due }, '2026-10-24', Date.parse(due) + 1000), { text: 'Past end of day', late: true });
  assert.deepStrictEqual(F.dueText({ status: 'pending', due_at: due, past_eod: false }, '2026-10-24', Date.parse(due) + 1000), { text: 'Decide by 18:30', late: false });
  assert.strictEqual(F.dueText({ status: 'approved', due_at: due, past_eod: true }, '2026-10-24'), null);
  assert.strictEqual(F.dueText({ status: 'pending' }, '2026-10-24'), null);
  assert.strictEqual(F.dueText(null, '2026-10-24'), null);
});

test('effectText: what each decision does; the v2.3 sentences are unchanged', function () {
  assert.ok(/late mark for that day goes/.test(F.effectText('punch_reason', true)));
  // they may not have been late at all (a field engineer away, or with no location)
  assert.strictEqual(F.effectText('punch_reason', false), 'Nothing on the day changes (a late mark, if any, stays). They see your note on NeoHR.');
  assert.strictEqual(F.PUNCH_REASON_REJECT, F.effectText('punch_reason', false));
  assert.ok(/punch counts/.test(F.effectText('away_punch', true)));
  assert.ok(/punch is removed/.test(F.effectText('away_punch', false)));
  assert.strictEqual(F.effectText('leave', true, { half_day: false }), 'Those days are marked as leave on the roster (weekly offs and holidays skipped).');
  assert.strictEqual(F.effectText('field_day', true), 'Those days are marked as field days on the roster.');
  assert.ok(/^The punch is added to the day as HR’s\./.test(F.effectText('missed_punch', true)));
  assert.strictEqual(F.effectText('late_start', true), 'The day counts as flexible: no late or early marks.');
  assert.strictEqual(F.effectText('leave', true, { half_day: true }), 'The day counts as flexible: no late or early marks.');
  assert.strictEqual(F.effectText('late_start', false), '');
  // a kind this screen does not know never claims an effect
  assert.strictEqual(F.effectText('something_new', true), '');
});

test('tripText / tripSpan', function () {
  assert.strictEqual(F.tripText({ kind: 'on_site', ref_code: 'NT-0412' }), 'On-site trip · NT-0412');
  assert.strictEqual(F.tripText({ kind: 'rma', ref_code: null, note: 'Distributor run' }), 'RMA trip · Distributor run');
  assert.strictEqual(F.tripText({ kind: 'boat' }), 'boat');
  assert.strictEqual(F.tripText({}), 'Trip');
  assert.strictEqual(F.tripText(null), '');
  assert.strictEqual(F.tripSpan({ started_at: '2026-10-24T05:35:00Z', ended_at: '2026-10-24T07:10:00Z', open: false }), '11:05–12:40');
  assert.strictEqual(F.tripSpan({ started_at: '2026-10-24T05:35:00Z', ended_at: '2026-10-24T07:10:00Z', open: true }), '11:05 – still going');
  assert.strictEqual(F.tripSpan({ started_at: '2026-10-24T05:35:00Z' }), '11:05 – still going');
  assert.strictEqual(F.tripSpan({}), '');
});

test('jpegDataUrl: only a real JPEG becomes an image; line breaks are fine', function () {
  var jpg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U';
  assert.strictEqual(F.jpegDataUrl(jpg), 'data:image/jpeg;base64,' + jpg);
  assert.strictEqual(F.jpegDataUrl(jpg.slice(0, 32) + '\n' + jpg.slice(32)), 'data:image/jpeg;base64,' + jpg);
  assert.strictEqual(F.jpegDataUrl('data:image/jpeg;base64,' + jpg), 'data:image/jpeg;base64,' + jpg);
  assert.strictEqual(F.jpegDataUrl('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'), null);          // a PNG
  assert.strictEqual(F.jpegDataUrl('/9j/" onerror="alert(1)'), null);
  assert.strictEqual(F.jpegDataUrl('/9j/abc'), null);                                   // too short
  assert.strictEqual(F.jpegDataUrl('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8'), null);   // not a multiple of 4
  assert.strictEqual(F.jpegDataUrl('data:text/html;base64,' + jpg), null);
  assert.strictEqual(F.jpegDataUrl(null), null);
  assert.strictEqual(F.jpegDataUrl(42), null);
});

console.log((failures ? 'FAILED' : 'OK') + ' hr-format: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
