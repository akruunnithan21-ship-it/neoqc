/*
  Unit tests for shared/service-catalog.js.
  Run: node tests/service-catalog.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var C = require(path.join(__dirname, '..', 'shared', 'service-catalog.js'));
var S = require(path.join(__dirname, '..', 'shared', 'service-status.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var HOUR = 3600000;
var NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
function iso(ms) { return new Date(ms).toISOString(); }
function local(y, mo, d, h, mi, s) { return new Date(y, mo - 1, d, h, mi, s || 0).toISOString(); }

var REQUIRED = ['no_power', 'no_display', 'random_restart', 'bsod', 'overheating', 'noisy_fans', 'slow', 'boot_loop',
  'wont_boot_os', 'windows_activation', 'os_reinstall', 'virus_malware', 'driver_crash', 'game_crash', 'no_internet',
  'wifi_issue', 'network_setup', 'printer_setup', 'data_recovery', 'liquid_spill', 'physical_damage', 'upgrade_request',
  'cleaning_maintenance', 'new_installation', 'ram_fault', 'ssd_fault', 'gpu_artifacts', 'psu_fault', 'usb_ports',
  'audio_issue', 'monitor_issue', 'laptop_battery', 'laptop_keyboard', 'laptop_screen'];

// ═══ Catalogue shape ══════════════════════════════════════════════════════

test('the catalogue has every required fault, unique keys, at least 34', function () {
  assert.ok(C.FAULTS.length >= 34, 'only ' + C.FAULTS.length);
  var keys = C.FAULTS.map(function (f) { return f.key; });
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate keys');
  REQUIRED.forEach(function (k) { assert.ok(keys.indexOf(k) !== -1, 'missing ' + k); });
});

test('every fault has valid vocabulary, a realistic time and a 3–6 step checklist', function () {
  C.FAULTS.forEach(function (f) {
    var id = f.key;
    assert.ok(/^[a-z_]+$/.test(f.key), id);
    assert.ok(typeof f.label === 'string' && f.label.length > 2 && f.label.length <= 45, id + ' label');
    assert.ok(f.label.indexOf('!') === -1, id + ' label has !');
    assert.ok(S.CATEGORIES[f.category], id + ' category ' + f.category);
    assert.ok(S.PRIORITIES[f.priority], id + ' priority ' + f.priority);
    assert.ok(Number.isInteger(f.est_minutes) && f.est_minutes >= 10 && f.est_minutes <= 480, id + ' est');
    assert.ok(S.TYPES[f.suggest_type], id + ' suggest_type');
    assert.ok(Array.isArray(f.kinds), id + ' kinds');
    f.kinds.forEach(function (k) { assert.ok(S.ITEM_KINDS[k], id + ' kind ' + k); });
    assert.ok(Array.isArray(f.checklist) && f.checklist.length >= 3 && f.checklist.length <= 6, id + ' checklist size');
    f.checklist.forEach(function (c) { assert.ok(typeof c === 'string' && c.trim().length > 5, id + ' checklist step'); });
    assert.ok(Array.isArray(f.keywords) && f.keywords.length >= 1, id + ' keywords');
    f.keywords.forEach(function (k) {
      assert.ok(typeof k === 'string' && k === k.trim() && k.length >= 2, id + ' keyword ' + JSON.stringify(k));
    });
    assert.strictEqual(C.fault(f.key), f);
  });
  assert.strictEqual(C.fault('nonsense'), null);
  assert.strictEqual(C.fault('toString'), null);
});

test('suggest_type follows the spec rule for the required faults', function () {
  var remote = ['windows_activation', 'os_reinstall', 'virus_malware', 'driver_crash'];
  var onsite = ['network_setup', 'printer_setup', 'new_installation'];
  REQUIRED.forEach(function (k) {
    var want = remote.indexOf(k) !== -1 ? 'remote' : onsite.indexOf(k) !== -1 ? 'on_site' : 'in_store';
    assert.strictEqual(C.fault(k).suggest_type, want, k);
  });
});

test('no keyword is shared by two faults that would make the parser ambiguous by accident', function () {
  var owner = {};
  C.FAULTS.forEach(function (f) {
    f.keywords.forEach(function (k) {
      var n = k.toLowerCase();
      assert.ok(!owner[n] || owner[n] === f.key, 'keyword "' + k + '" in ' + owner[n] + ' and ' + f.key);
      owner[n] = f.key;
    });
  });
});

// ═══ Priority, type, time, checklist ══════════════════════════════════════

test('computePriority: base is the highest fault priority, default normal', function () {
  assert.deepStrictEqual(C.computePriority([], {}), { priority: 'normal', reasons: [] });
  assert.deepStrictEqual(C.computePriority(null), { priority: 'normal', reasons: [] });
  assert.deepStrictEqual(C.computePriority(['nonsense']), { priority: 'normal', reasons: [] });
  assert.strictEqual(C.computePriority(['slow']).priority, 'low');
  assert.strictEqual(C.computePriority(['slow', 'bsod']).priority, 'normal');
  var r = C.computePriority(['slow', 'no_display']);
  assert.strictEqual(r.priority, 'high');
  assert.deepStrictEqual(r.reasons, ['No display']);
  assert.strictEqual(C.computePriority(['liquid_spill']).priority, 'urgent');
});

test('computePriority: on-site business / 3+ machines, own build in warranty, repeat visit', function () {
  assert.strictEqual(C.computePriority(['bsod'], { service_type: 'on_site', business: true }).priority, 'high');
  assert.strictEqual(C.computePriority(['bsod'], { service_type: 'on_site', machines: 3 }).priority, 'high');
  assert.strictEqual(C.computePriority(['bsod'], { service_type: 'on_site', machines: 2 }).priority, 'normal');
  assert.strictEqual(C.computePriority(['bsod'], { service_type: 'in_store', business: true }).priority, 'normal', 'business only counts on site');
  assert.strictEqual(C.computePriority(['bsod'], { service_type: 'on_site', business: true, machines: 5 }).priority, 'high', 'one bump, not two');
  assert.strictEqual(C.computePriority(['bsod'], { built_by_us_in_warranty: true }).priority, 'high');
  var rep = C.computePriority(['bsod'], { repeat_within_30d: true });
  assert.strictEqual(rep.priority, 'high');
  assert.ok(rep.reasons.indexOf('Repeat visit within 30 days') !== -1);
  assert.strictEqual(C.computePriority(['slow'], { built_by_us_in_warranty: true, repeat_within_30d: true }).priority, 'high');
  var all = C.computePriority(['no_display'], { service_type: 'on_site', business: true, built_by_us_in_warranty: true, repeat_within_30d: true });
  assert.strictEqual(all.priority, 'urgent', 'capped at urgent');
  assert.ok(all.reasons.length >= 4);
});

test('computePriority: needed within 48 hours makes it urgent', function () {
  assert.strictEqual(C.computePriority(['slow'], { needed_by: iso(NOW + 47 * HOUR), now: NOW }).priority, 'urgent');
  assert.strictEqual(C.computePriority(['slow'], { needed_by: iso(NOW + 48 * HOUR), now: NOW }).priority, 'urgent');
  assert.strictEqual(C.computePriority(['slow'], { needed_by: iso(NOW + 49 * HOUR), now: NOW }).priority, 'low');
  var past = C.computePriority([], { needed_by: iso(NOW - HOUR), now: NOW });
  assert.strictEqual(past.priority, 'urgent');
  assert.ok(/passed/i.test(past.reasons[past.reasons.length - 1]));
  assert.strictEqual(C.computePriority([], { needed_by: 'garbage', now: NOW }).priority, 'normal');
  assert.ok(C.computePriority([], { needed_by: iso(NOW + HOUR), now: NOW }).reasons.indexOf('Needed within 48 hours') !== -1);
});

test('suggestType: most common, ties go to hands-on types', function () {
  assert.strictEqual(C.suggestType([]), 'in_store');
  assert.strictEqual(C.suggestType(['windows_activation']), 'remote');
  assert.strictEqual(C.suggestType(['windows_activation', 'driver_crash', 'no_power']), 'remote');
  assert.strictEqual(C.suggestType(['windows_activation', 'no_power']), 'in_store');
  assert.strictEqual(C.suggestType(['windows_activation', 'network_setup']), 'on_site');
  assert.strictEqual(C.suggestType(['network_setup', 'printer_setup', 'no_power']), 'on_site');
  assert.strictEqual(C.suggestType(['nonsense']), 'in_store');
});

test('estMinutes is the longest picked fault, 60 when none', function () {
  assert.strictEqual(C.estMinutes([]), 60);
  assert.strictEqual(C.estMinutes(['nonsense']), 60);
  assert.strictEqual(C.estMinutes(['windows_activation']), 20);
  assert.strictEqual(C.estMinutes(['windows_activation', 'data_recovery', 'bsod']), 180);
});

test('mergeChecklists keeps order and drops duplicates', function () {
  var one = C.mergeChecklists(['ram_fault']);
  assert.deepStrictEqual(one, C.fault('ram_fault').checklist);
  var two = C.mergeChecklists(['ssd_fault', 'data_recovery', 'ssd_fault']);
  assert.strictEqual(new Set(two.map(function (s) { return s.toLowerCase(); })).size, two.length);
  assert.strictEqual(two[0], C.fault('ssd_fault').checklist[0]);
  assert.deepStrictEqual(C.mergeChecklists([]), []);
  assert.deepStrictEqual(C.mergeChecklists(undefined), []);
});

test('faultsFor filters by item kinds and hides bench-only faults on remote tickets', function () {
  assert.strictEqual(C.faultsFor([], 'in_store').length, C.FAULTS.length);
  var laptop = C.faultsFor(['laptop'], 'in_store').map(function (f) { return f.key; });
  assert.ok(laptop.indexOf('laptop_battery') !== -1);
  assert.ok(laptop.indexOf('physical_damage') !== -1, 'kinds [] applies to anything');
  assert.strictEqual(laptop.indexOf('psu_fault'), -1);
  var remote = C.faultsFor([], 'remote').map(function (f) { return f.key; });
  assert.ok(remote.indexOf('windows_activation') !== -1);
  assert.strictEqual(remote.indexOf('liquid_spill'), -1);
  assert.strictEqual(remote.indexOf('no_power'), -1);
  assert.ok(C.faultsFor('gpu').some(function (f) { return f.key === 'gpu_artifacts'; }));
});

// ═══ Chips and fees ══════════════════════════════════════════════════════

test('chips and fees are the spec lists', function () {
  assert.deepStrictEqual(C.ACCESSORIES, ['Power cable', 'Charger', 'Bag', 'Box', 'Keyboard', 'Mouse', 'Wi-Fi antenna',
                                         'HDMI / DP cable', 'Drive', 'Manual']);
  assert.deepStrictEqual(C.CONDITION_CHIPS, ['No visible damage', 'Scratches', 'Dents', 'Cracked panel', 'Missing screws',
                                             'Broken clip', 'Liquid marks', 'Burn marks', 'Seal broken', 'Dusty']);
  assert.strictEqual(C.DEFAULT_HANDLING_FEE, 300);
  assert.deepStrictEqual(C.HANDLING_FEE_BY_KIND, { gpu: 500, motherboard: 400, psu: 300, ram: 200, ssd: 200, hdd: 200,
                                                    cpu: 400, monitor: 500, laptop: 500, other: 300 });
  assert.strictEqual(C.handlingFee('gpu'), 500);
  assert.strictEqual(C.handlingFee('cooler'), 300);
  assert.strictEqual(C.handlingFee(undefined), 300);
});

// ═══ WhatsApp templates ══════════════════════════════════════════════════

var LINK = 'https://neoqctracker.netlify.app/?view=service&code=';
var EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/u;

function checkMessage(name, text, code) {
  assert.strictEqual(typeof text, 'string', name);
  assert.ok(text.length > 0 && text.length < 600, name + ' length ' + text.length);
  assert.ok(text.indexOf(code) !== -1, name + ' has no code');
  assert.ok(text.indexOf(LINK + code) !== -1, name + ' has no tracking link');
  assert.ok(text.indexOf('Use the last 4 digits of this phone number to open it.') !== -1, name + ' has no phone line');
  assert.ok(text.indexOf('Neo Tokyo') !== -1, name + ' has no shop name');
  assert.ok(!EMOJI.test(text), name + ' has an emoji');
  assert.ok(text.indexOf('!') === -1, name + ' has an exclamation mark');
  assert.ok(!/\bplease\b/i.test(text), name + ' says please');
  assert.ok(!/successfully/i.test(text), name + ' says successfully');
  assert.ok(text.indexOf('undefined') === -1 && text.indexOf('null') === -1, name + ' leaks undefined/null');
}

test('every template exists and keeps the message rules', function () {
  var names = ['created', 'quote', 'ready', 'visit_booked', 'on_the_way', 'rma_received', 'rma_sent', 'rma_back', 'rma_ready', 'reminder_collect'];
  names.forEach(function (n) { assert.strictEqual(typeof C.WA_TEMPLATES[n], 'function', n); });
  var job = { public_code: 'NT-7KQ2M4XP', customer_name: 'Arjun R Kumar', device_label: 'Neo Tokyo build — Ryzen 5 5600',
              service_type: 'in_store', stage: 'received', ready_at: iso(NOW - 2 * 86400000),
              visit_start: local(2026, 10, 23, 14, 30), visit_end: local(2026, 10, 23, 16, 0) };
  var unit = { public_code: 'RM-7KQ2M4XP', owner_name: 'Vishnu P', kind: 'gpu', brand: 'ASUS', model: 'TUF RTX 4070 Ti',
               vendor_result: 'replaced', return_method: 'collect', serial: 'SECRET-SERIAL-1' };
  checkMessage('created', C.WA_TEMPLATES.created(job), job.public_code);
  checkMessage('quote', C.WA_TEMPLATES.quote(job, '₹8,400'), job.public_code);
  checkMessage('ready', C.WA_TEMPLATES.ready(job), job.public_code);
  checkMessage('visit_booked', C.WA_TEMPLATES.visit_booked(Object.assign({}, job, { service_type: 'on_site' })), job.public_code);
  checkMessage('on_the_way', C.WA_TEMPLATES.on_the_way(job, 'Athul'), job.public_code);
  checkMessage('reminder_collect', C.WA_TEMPLATES.reminder_collect(job), job.public_code);
  checkMessage('rma_received', C.WA_TEMPLATES.rma_received(unit), unit.public_code);
  checkMessage('rma_sent', C.WA_TEMPLATES.rma_sent(unit, 'ASUS'), unit.public_code);
  checkMessage('rma_back', C.WA_TEMPLATES.rma_back(unit), unit.public_code);
  checkMessage('rma_ready', C.WA_TEMPLATES.rma_ready(unit), unit.public_code);
  names.forEach(function (n) {
    var out = C.WA_TEMPLATES[n](n.indexOf('rma') === 0 ? unit : job, 'x');
    assert.strictEqual(out.indexOf('SECRET-SERIAL-1'), -1, n + ' leaks the serial');
  });
});

test('templates say the right thing per type and result', function () {
  var base = { public_code: 'NT-AAAA2222', customer_name: 'Dr. Nisha Varghese' };
  assert.ok(/^Hi Nisha,/.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'on_site' }, base))));
  assert.ok(/on-site/.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'on_site' }, base))));
  assert.ok(/remote/.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'remote' }, base))));
  assert.ok(/never ask for your passwords/.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'remote' }, base))));
  assert.ok(/Bring it/.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'in_store', stage: 'logged' }, base))));
  // v2.1: the shop never backs up data, and says so in writing for in-store work.
  var NOBACKUP = /We don’t back up data on devices — keep your own copy of anything important\./;
  assert.ok(NOBACKUP.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'in_store', stage: 'received' }, base))), 'in-store, received');
  assert.ok(NOBACKUP.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'in_store', stage: 'logged' }, base))), 'in-store, logged');
  assert.ok(NOBACKUP.test(C.WA_TEMPLATES.created(base)), 'no type means in-store');
  assert.ok(!NOBACKUP.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'on_site' }, base))), 'not for on-site');
  assert.ok(!NOBACKUP.test(C.WA_TEMPLATES.created(Object.assign({ service_type: 'remote' }, base))), 'not for remote');
  assert.ok(!/back up/i.test(C.WA_TEMPLATES.ready(Object.assign({ service_type: 'in_store' }, base))), 'only the created message says it');
  assert.ok(/^Hi Kerala Freight Co\.,/.test(C.WA_TEMPLATES.created({ public_code: 'NT-X', customer_name: 'Kerala Freight Co.' })));
  assert.ok(/^Hi Sreekumar Computers,/.test(C.WA_TEMPLATES.rma_received({ public_code: 'RM-X', sender_name: 'Sreekumar Computers, Thrissur' })));
  assert.ok(/^Hello,/.test(C.WA_TEMPLATES.ready({ public_code: 'NT-X' })));
  var visit = C.WA_TEMPLATES.visit_booked(Object.assign({ service_type: 'on_site', visit_start: local(2026, 10, 23, 14, 30),
                                                         visit_end: local(2026, 10, 23, 16, 0) }, base));
  assert.ok(/23 Oct/.test(visit) && /2:30\s?pm/i.test(visit) && /4:00\s?pm/i.test(visit), visit);
  assert.ok(/confirm the time/.test(C.WA_TEMPLATES.visit_booked(Object.assign({ service_type: 'remote' }, base))));
  assert.ok(/Athul from Neo Tokyo is on the way/.test(C.WA_TEMPLATES.on_the_way(base, 'Athul')));
  assert.ok(/₹8,400/.test(C.WA_TEMPLATES.quote(base, '₹8,400')));
  assert.ok(/part under warranty claim will follow/.test(C.WA_TEMPLATES.ready(Object.assign({ outcome: 'returned_rma_pending' }, base))));
  function back(r) { return C.WA_TEMPLATES.rma_back({ public_code: 'RM-X', kind: 'psu', brand: 'Antec', model: 'CSK650', vendor_result: r }); }
  assert.ok(/replaced it/.test(back('replaced')));
  assert.ok(/repaired it/.test(back('repaired')));
  assert.ok(/credit/.test(back('credit_note')));
  assert.ok(/declined/.test(back('rejected')));
  assert.ok(/could not return it/.test(back('lost')));
  assert.ok(/Antec CSK650 power supply/.test(back('replaced')));
  assert.ok(/couriered back/.test(C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', return_method: 'courier' })));
  assert.ok(/fitted back/.test(C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', return_method: 'with_device' })));
  assert.ok(/AWB 12345/.test(C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', stage: 'returning', return_courier: 'DTDC', return_awb: '12345' })));
  var dup = C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', kind: 'monitor', brand: 'LG', model: '24MP400 monitor' });
  assert.ok(/LG 24MP400 monitor/.test(dup) && !/monitor monitor/i.test(dup), 'the kind noun is not repeated: ' + dup);
  assert.ok(!/ASUS ASUS/.test(C.WA_TEMPLATES.rma_sent({ public_code: 'RM-X', kind: 'gpu', brand: 'ASUS', model: 'ASUS TUF RTX 4070' }, 'ASUS')));
  assert.ok(/LG 24MP400 monitor\b/.test(C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', kind: 'monitor', brand: 'LG', model: '24MP400' })));
});

test('templates stay under 600 characters whatever was typed, and survive empty input', function () {
  var huge = new Array(400).join('Very long name ');
  var job = { public_code: 'NT-AAAA2222', customer_name: huge, device_label: huge, site_area: huge, service_type: 'on_site',
              visit_start: local(2026, 10, 23, 14, 30), visit_end: local(2026, 10, 24, 16, 0) };
  var unit = { public_code: 'RM-AAAA2222', owner_name: huge, brand: huge, model: huge, kind: 'gpu', return_courier: huge,
               return_awb: huge, stage: 'returning', vendor_result: 'rejected' };
  Object.keys(C.WA_TEMPLATES).forEach(function (n) {
    var out = C.WA_TEMPLATES[n](n.indexOf('rma') === 0 ? unit : job, huge);
    assert.ok(out.length < 600, n + ' is ' + out.length + ' chars');
    var empty = C.WA_TEMPLATES[n]();
    assert.ok(typeof empty === 'string' && empty.indexOf('undefined') === -1, n + ' with no args');
  });
  // The longest "created": in-store, with the no-backup line (v2.1).
  ['received', 'logged'].forEach(function (st) {
    var store = C.WA_TEMPLATES.created(Object.assign({}, job, { service_type: 'in_store', stage: st }));
    assert.ok(store.length < 600, 'in-store created (' + st + ') is ' + store.length + ' chars');
    assert.ok(/keep your own copy/.test(store), 'the no-backup line survives a huge name');
  });
  assert.strictEqual(C.trackLink('NT-AB 12'), LINK + 'NT-AB%2012');
});

// ═══ Keyword matching ════════════════════════════════════════════════════

test('matchFaults: whole words, any case, curly apostrophes, first mention first', function () {
  assert.deepStrictEqual(C.matchFaults('My PC WON’T TURN ON since yesterday'), ['no_power']);
  assert.deepStrictEqual(C.matchFaults('Blue screen, then a black screen'), ['bsod', 'no_display']);
  assert.deepStrictEqual(C.matchFaults('black screen, then a blue screen'), ['no_display', 'bsod']);
  assert.deepStrictEqual(C.matchFaults('The industry standard'), [], '"dust" must not match inside "industry"');
  assert.deepStrictEqual(C.matchFaults('reinstalled the program'), [], 'no partial words');
  assert.deepStrictEqual(C.matchFaults('wi-fi keeps dropping'), ['wifi_issue']);
  assert.deepStrictEqual(C.matchFaults('I want to add more ram'), ['upgrade_request'], 'an upgrade is not a RAM fault');
  assert.deepStrictEqual(C.matchFaults('liquid cooler pump not working'), ['cooler_aio'], 'a liquid cooler is not a spill');
  assert.deepStrictEqual(C.matchFaults(''), []);
  assert.deepStrictEqual(C.matchFaults(null), []);
});

test('findPhone: Indian mobiles in every common shape, never part of a longer number', function () {
  assert.strictEqual(C.findPhone('+91 98470 12345'), '9847012345');
  assert.strictEqual(C.findPhone('call 98470-12345 now'), '9847012345');
  assert.strictEqual(C.findPhone('919847012345'), '9847012345');
  assert.strictEqual(C.findPhone('098470 12345'), '9847012345');
  assert.strictEqual(C.findPhone('+91-984-701-2345'), '9847012345');
  assert.strictEqual(C.findPhone('9123456789'), '9123456789');
  assert.strictEqual(C.findPhone('AWB 7712345678901'), null, 'part of a longer number');
  assert.strictEqual(C.findPhone('landline 0484 2345678'), null);
  assert.strictEqual(C.findPhone('12345'), null);
  assert.strictEqual(C.findPhone(null), null);
});

// A1': a Gulf / NRI number keeps its country code; an Indian one normalises to
// the same 91XXXXXXXXXX whichever shape is returned. Written out here from the
// rule's own words, independently of the catalogue, so the two can be compared.
function a1(raw) {
  var d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.slice(0, 2) === '00') d = d.slice(2);
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(d.length - 10);
  return d;
}
function a1ok(norm) {
  var d = String(norm == null ? '' : norm);
  if (!/^\d+$/.test(d)) return false;
  return (d.length >= 12 && d.length <= 15) ||
         (d.length === 11 && ['965', '968', '973', '974'].indexOf(d.slice(0, 3)) !== -1);
}

// ═══ The phone rule (A1') ═══════════════════════════════════════════════

test("normPhone (A1'): Indian shapes all become 91 + the 10 digits", function () {
  assert.strictEqual(C.normPhone('9847012345'), '919847012345', 'Indian 10-digit');
  assert.strictEqual(C.normPhone('98470 12345'), '919847012345', 'spaces');
  assert.strictEqual(C.normPhone('098470 12345'), '919847012345', '0-prefixed');
  assert.strictEqual(C.normPhone('09847012345'), '919847012345', '0-prefixed, no spaces');
  assert.strictEqual(C.normPhone('+91 98470 12345'), '919847012345', '+91');
  assert.strictEqual(C.normPhone('+91-984-701-2345'), '919847012345', '+91 with dashes');
  assert.strictEqual(C.normPhone('919847012345'), '919847012345', '91 without the +');
  assert.strictEqual(C.normPhone('0091 98470 12345'), '919847012345', '0091: the 00 is the dialling prefix');
  assert.strictEqual(C.normPhone('00919847012345'), '919847012345');
  assert.strictEqual(C.normPhone(C.normPhone('+91 98470 12345')), '919847012345', 'idempotent');
});

test("normPhone (A1'): international numbers keep their country code, with or without 00", function () {
  assert.strictEqual(C.normPhone('+971 50 123 4567'), '971501234567', 'UAE');
  assert.strictEqual(C.normPhone('00971501234567'), '971501234567', '00 is the same as +');
  assert.strictEqual(C.normPhone('00971 50 123 4567'), C.normPhone('+971 50 123 4567'), 'one customer, not two');
  assert.strictEqual(C.normPhone('+974 5512 3456'), '97455123456', 'Qatar: 11 digits stay as they are');
  assert.strictEqual(C.normPhone('00974 5512 3456'), '97455123456');
  assert.strictEqual(C.normPhone('+966 55 123 4567'), '966551234567', 'Saudi');
  assert.strictEqual(C.normPhone('+44 7700 900123'), '447700900123', 'UK');
  assert.strictEqual(C.normPhone('98470123456'), '98470123456', 'an 11-digit Indian typo is not rewritten');
  assert.strictEqual(C.normPhone('+1 (555) 123-4567'), '15551234567');
  assert.strictEqual(C.normPhone('12345'), '12345', 'short stays short');
  assert.strictEqual(C.normPhone('00'), '', 'only the dialling prefix');
  assert.strictEqual(C.normPhone('009847012345'), '919847012345', '00 then 10 digits: the 10-digit rule after the strip');
  assert.strictEqual(C.normPhone('0009847012345'), '919847012345', 'only ONE leading 00 is dropped, then the 0 rule');
  assert.strictEqual(C.normPhone(''), '');
  assert.strictEqual(C.normPhone(null), '');
  assert.strictEqual(C.normPhone(undefined), '');
  assert.strictEqual(C.normPhone(9847012345), '919847012345', 'a number, not a string');
});

test("phoneOk (A1'): 12-15 digits, or 11 for Kuwait / Oman / Bahrain / Qatar only", function () {
  assert.strictEqual(C.phoneOk('919847012345'), true);
  assert.strictEqual(C.phoneOk('971501234567'), true);
  assert.strictEqual(C.phoneOk('123456789012345'), true, '15 digits');
  assert.strictEqual(C.phoneOk('1234567890123456'), false, '16 digits is not a phone');
  ['965', '968', '973', '974'].forEach(function (cc) {
    assert.strictEqual(C.phoneOk(cc + '55123456'), true, cc + ' + 8 digits');
  });
  assert.strictEqual(C.phoneOk('98470123456'), false, 'an 11-digit Indian typo');
  assert.strictEqual(C.phoneOk('15551234567'), false, '11 digits outside the four codes');
  assert.strictEqual(C.phoneOk('97155123456'), false, 'UAE numbers are 12 digits, not 11');
  assert.strictEqual(C.phoneOk('9847012345'), false, '10 digits is not normalised');
  assert.strictEqual(C.phoneOk('9745512345'), false, '974 + 7 digits is too short');
  assert.strictEqual(C.phoneOk('+971501234567'), false, 'normalised means digits only');
  assert.strictEqual(C.phoneOk(''), false);
  assert.strictEqual(C.phoneOk(null), false);
  assert.deepStrictEqual(C.ELEVEN_DIGIT_CODES.slice(), ['965', '968', '973', '974']);
  assert.ok(Object.isFrozen(C.ELEVEN_DIGIT_CODES), 'the code list cannot be changed by a caller');
});

test("isValidPhone (A1'): the listed shapes as typed", function () {
  var yes = ['9847012345', '98470 12345', '098470 12345', '+91 98470 12345', '0091 98470 12345',
             '+971 50 123 4567', '00971501234567', '+974 5512 3456', '+965 5512 3456', '+968 9123 4567',
             '+973 3612 3456', '+966 55 123 4567', '+44 7700 900123'];
  var no = ['98470123456', '984701234', '+91 98470 1234', '+1 (555) 123-4567', '12345', '', null,
            '+971 50 123', '1234567890123456', '00'];
  yes.forEach(function (p) { assert.strictEqual(C.isValidPhone(p), true, JSON.stringify(p) + ' should be valid'); });
  no.forEach(function (p) { assert.strictEqual(C.isValidPhone(p), false, JSON.stringify(p) + ' should be refused'); });
});

test("normPhone / phoneOk match the rule as written, for every shape", function () {
  var bases = ['9847012345', '09847012345', '919847012345', '98470123456', '971501234567', '97455123456',
               '96551234567', '96891234567', '97336123456', '15551234567', '447700900123', '123456789012345',
               '1234567890123456', '12345', '0', '00', '000', '0000000000', '1234567890'];
  var shapes = [function (d) { return d; }, function (d) { return '+' + d; }, function (d) { return '00' + d; },
                function (d) { return '0' + d; }, function (d) { return d.replace(/(\d{3})(?=\d)/g, '$1 '); },
                function (d) { return '+' + d.replace(/(\d{2})(?=\d)/g, '$1-'); }];
  var n = 0;
  bases.forEach(function (b) {
    shapes.forEach(function (f) {
      var raw = f(b);
      assert.strictEqual(C.normPhone(raw), a1(raw), 'normPhone ' + JSON.stringify(raw));
      assert.strictEqual(C.isValidPhone(raw), a1ok(a1(raw)), 'isValidPhone ' + JSON.stringify(raw));
      assert.strictEqual(C.phoneOk(raw), a1ok(raw), 'phoneOk ' + JSON.stringify(raw));
      n++;
    });
  });
  assert.ok(n > 100);
});

test('findPhone (A1): international numbers keep their country code', function () {
  assert.strictEqual(C.findPhone('+971 50 123 4567'), '+971501234567');
  assert.strictEqual(C.findPhone('my number is +966-55-123-4567 thanks'), '+966551234567');
  assert.strictEqual(C.findPhone('00971501234567'), '+971501234567', '00 is the international prefix');
  assert.strictEqual(C.findPhone('+1 (555) 123 4567'), null, 'brackets are not part of the separators');
  assert.strictEqual(C.findPhone('+44 7700 900123'), '+447700900123');
  assert.strictEqual(C.findPhone('+971 50 123'), null, 'too short for a country code and a number');
  assert.strictEqual(C.findPhone('+9715012345678901234'), null, 'part of a longer number');
  assert.strictEqual(C.findPhone('+91 484 2345678'), null, 'an Indian landline is still refused');
  assert.strictEqual(C.findPhone('call +971501234567 or 98470 12345'), '+971501234567', 'first one wins');
  assert.strictEqual(C.findPhone('call 98470 12345 or +971501234567'), '9847012345');
  // Whatever shape comes back, the A1 normal form is right.
  assert.strictEqual(a1(C.findPhone('+91 98470 12345')), '919847012345');
  assert.strictEqual(a1(C.findPhone('098470 12345')), '919847012345');
  assert.strictEqual(a1(C.findPhone('+971 50 123 4567')), '971501234567');
});

test("findPhone (A1'): agrees with normPhone / isValidPhone", function () {
  assert.strictEqual(C.findPhone('+974 5512 3456'), '+97455123456', 'Qatar: 11 digits are a valid number');
  assert.strictEqual(C.findPhone('call me on 00974 5512 3456'), '+97455123456');
  assert.strictEqual(C.findPhone('+965 6123 4567 (Kuwait)'), '+96561234567');
  assert.strictEqual(C.findPhone('0091 98470 12345'), '9847012345', '0091 is +91');
  assert.strictEqual(C.findPhone('+9847012345'), '9847012345', 'a + in front of 10 digits is still an Indian mobile');
  assert.strictEqual(C.findPhone('98470123456'), null, 'an 11-digit Indian typo is not a phone');
  // An 11-digit number outside the four codes is refused, and its last ten
  // digits are never read as somebody's Indian mobile.
  assert.strictEqual(C.findPhone('+1 650 123 4567'), null);
  assert.strictEqual(C.findPhone('US: +1 650 123 4567, India: 98470 12345'), '9847012345');
  assert.strictEqual(C.findPhone('+1 650 123 4567 or +971 50 123 4567'), '+971501234567');
  // Every value it returns is valid, and normalises to the stored value.
  var samples = ['+91 98470 12345', '098470 12345', '0091 98470 12345', '+971 50 123 4567', '00971501234567',
                 '+974 5512 3456', '+44 7700 900123', '+966-55-123-4567', '+9847012345', 'ring 9123456789 pls'];
  samples.forEach(function (t) {
    var p = C.findPhone(t);
    assert.ok(p, JSON.stringify(t) + ' found nothing');
    assert.strictEqual(C.isValidPhone(p), true, JSON.stringify(t) + ' -> ' + p + ' is not valid');
    assert.strictEqual(C.normPhone(p), C.normPhone(t.replace(/^[^+\d]+|[^\d]+$/g, '')), JSON.stringify(t));
  });
});

test('a chat with a Gulf number keeps it', function () {
  var chat = ['21/10/2026, 22:14 - +971 50 123 4567: hi, my laptop is not charging',
              '21/10/2026, 22:15 - Neo Tokyo: Bring it in tomorrow'].join('\n');
  var r = C.parseWhatsAppChat(chat);
  assert.strictEqual(r.phone, '+971501234567');
  assert.strictEqual(a1(r.phone), '971501234567');
  assert.strictEqual(r.name, null);
  assert.deepStrictEqual(r.faultKeys, ['laptop_battery']);
  // A Qatar sender (11 digits) is a phone, not a name; a US sender is neither
  // a valid phone nor misread as an Indian one.
  var qa = C.parseWhatsAppChat('21/10/2026, 22:14 - +974 5512 3456: my laptop is not charging');
  assert.strictEqual(qa.phone, '+97455123456');
  assert.strictEqual(C.normPhone(qa.phone), '97455123456');
  assert.strictEqual(qa.name, null);
  var us = C.parseWhatsAppChat('21/10/2026, 22:14 - +1 650 123 4567: my laptop is not charging');
  assert.strictEqual(us.phone, null);
});

// ═══ Our workmanship warranty (A20) ═════════════════════════════════════

test('OUR_WARRANTY_MONTHS is 6 and ourWarrantyUntil counts from the hand-over, else completion', function () {
  assert.strictEqual(C.OUR_WARRANTY_MONTHS, 6);
  function day(iso1) { var d = new Date(iso1); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; }
  assert.deepStrictEqual(day(C.ourWarrantyUntil(local(2026, 3, 10, 15, 30), local(2026, 3, 1, 9, 0))), [2026, 9, 10, 15, 30], 'hand-over wins');
  assert.deepStrictEqual(day(C.ourWarrantyUntil(null, local(2026, 3, 1, 9, 0))), [2026, 9, 1, 9, 0], 'completion when never handed over');
  assert.deepStrictEqual(day(C.ourWarrantyUntil('', local(2026, 3, 1, 9, 0))), [2026, 9, 1, 9, 0]);
  assert.deepStrictEqual(day(C.ourWarrantyUntil('garbage', local(2026, 3, 1, 9, 0))), [2026, 9, 1, 9, 0], 'a bad date is no date');
  assert.deepStrictEqual(day(C.ourWarrantyUntil(new Date(2026, 0, 5, 12, 0).getTime(), null)), [2026, 7, 5, 12, 0], 'ms and Date accepted');
  assert.deepStrictEqual(day(C.ourWarrantyUntil(new Date(2026, 0, 5, 12, 0), null)), [2026, 7, 5, 12, 0]);
  assert.deepStrictEqual(day(C.ourWarrantyUntil(local(2025, 8, 31, 10, 0))), [2026, 2, 28, 10, 0], 'month end clamps');
  assert.deepStrictEqual(day(C.ourWarrantyUntil(local(2027, 8, 31, 10, 0))), [2028, 2, 29, 10, 0], 'leap year');
  assert.deepStrictEqual(day(C.ourWarrantyUntil(local(2026, 10, 15, 10, 0))), [2027, 4, 15, 10, 0], 'across the year end');
  assert.strictEqual(C.ourWarrantyUntil(null, null), null);
  assert.strictEqual(C.ourWarrantyUntil(), null);
  assert.ok(/Z$/.test(C.ourWarrantyUntil(local(2026, 3, 10, 15, 30))), 'an ISO string');
});

// ═══ A10 / A13 template wording ═════════════════════════════════════════

test('RMA templates name the brand (A13) and handle a vendor shipping straight to the customer (A10)', function () {
  var u = { public_code: 'RM-7KQ2M4XP', owner_name: 'Ramesh Iyer', kind: 'gpu', brand: 'Zotac', model: 'RTX 3060' };
  var sent = C.WA_TEMPLATES.rma_sent(u, 'Rashi Peripherals');
  assert.ok(/sent to Zotac under warranty/.test(sent), sent);
  assert.ok(sent.indexOf('Rashi') === -1, 'a distributor name never reaches the customer');
  assert.ok(/sent to ASUS under warranty/.test(C.WA_TEMPLATES.rma_sent({ public_code: 'RM-X' }, 'ASUS')), 'no brand: the given name');
  assert.ok(/sent to the manufacturer/.test(C.WA_TEMPLATES.rma_sent({ public_code: 'RM-X' })));
  assert.ok(/Zotac replaced it/.test(C.WA_TEMPLATES.rma_back(Object.assign({ vendor_result: 'replaced' }, u))));
  assert.ok(/The manufacturer replaced it/.test(C.WA_TEMPLATES.rma_back({ public_code: 'RM-X', vendor_result: 'replaced' })));

  var shipped = Object.assign({ vendor_result: 'shipped_to_customer' }, u);
  var back = C.WA_TEMPLATES.rma_back(shipped);
  checkMessage('rma_back shipped', back, u.public_code);
  assert.ok(/^Hi Ramesh,/.test(back));
  assert.ok(/An update on your Zotac RTX 3060 graphics card\. Zotac is sending it straight to you\. Tell us when it arrives/.test(back), back);
  assert.ok(!/is back from/.test(back), 'it never comes back to us');
  var withAwb = C.WA_TEMPLATES.rma_back(Object.assign({ return_courier: 'Blue Dart', return_awb: '7123' }, shipped));
  assert.ok(/sending it straight to you with Blue Dart, AWB 7123\./.test(withAwb), withAwb);

  var going = C.WA_TEMPLATES.rma_ready(Object.assign({ stage: 'returning' }, shipped));
  checkMessage('rma_ready shipped', going, u.public_code);
  assert.ok(/on its way back to you from Zotac\./.test(going), going);
  assert.ok(!/ready to collect/i.test(going), 'not waiting at the shop');
  assert.ok(/on its way back to you\./.test(C.WA_TEMPLATES.rma_ready({ public_code: 'RM-X', stage: 'returning', return_method: 'courier' })),
            'returning without an AWB yet');
});

// ═══ WhatsApp chat parser ════════════════════════════════════════════════

test('parses an Android 12-hour export with multi-line messages and system lines', function () {
  var chat = [
    '21/10/26, 10:14 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
    '21/10/26, 10:14 am - Arjun R Kumar: Hi, my PC shows no display after I moved it',
    'it also restarts by itself sometimes',
    '',
    'and the fans are loud',
    '21/10/26, 10:15 am - Neo Tokyo Service: Hi Arjun, what is your number? Ours is 9847099999',
    '21/10/26, 10:16 am - Arjun R Kumar: +91 98470 01001',
    '21/10/26, 10:17 am - Arjun R Kumar: <Media omitted>',
    '21/10/26, 12:05 pm - Arjun R Kumar: Can I bring it today?',
    '21/10/26, 12:30 am - Arjun R Kumar: sorry, late reply'
  ].join('\r\n');
  var r = C.parseWhatsAppChat(chat);
  assert.strictEqual(r.messages.length, 6);
  assert.strictEqual(r.messages[0].from, 'Arjun R Kumar');
  assert.strictEqual(r.messages[0].text, 'Hi, my PC shows no display after I moved it\nit also restarts by itself sometimes\n\nand the fans are loud');
  assert.strictEqual(r.messages[0].at, local(2026, 10, 21, 10, 14));
  assert.strictEqual(r.messages[4].at, local(2026, 10, 21, 12, 5), '12:05 pm is noon');
  assert.strictEqual(r.messages[5].at, local(2026, 10, 21, 0, 30), '12:30 am is just after midnight');
  assert.strictEqual(r.name, 'Arjun R Kumar');
  assert.strictEqual(r.phone, '9847001001', 'never the shop number');
  assert.ok(r.faultText.indexOf('no display') !== -1);
  assert.ok(r.faultText.indexOf('Can I bring it today?') !== -1, 'third meaningful message');
  assert.strictEqual(r.faultText.indexOf('Media omitted'), -1);
  assert.strictEqual(r.faultText.indexOf('98470 01001'), -1, 'a bare phone number is not a fault');
  assert.deepStrictEqual(r.faultKeys, ['no_display', 'random_restart', 'noisy_fans']);
});

test('parses an Android 24-hour export where the customer is an unsaved number', function () {
  var chat = [
    '21/10/2026, 22:14 - +91 98470 12345: Laptop not charging',
    'battery stays at 0%',
    '21/10/2026, 22:20 - Neo Tokyo: Bring it in tomorrow',
    '22/10/2026, 09:01 - +91 98470 12345: ok, also the keyboard not working'
  ].join('\n');
  var r = C.parseWhatsAppChat(chat);
  assert.strictEqual(r.messages.length, 3);
  assert.strictEqual(r.phone, '9847012345');
  assert.strictEqual(r.name, null, 'a phone number is not a name');
  assert.strictEqual(r.messages[0].at, local(2026, 10, 21, 22, 14));
  assert.strictEqual(r.messages[2].at, local(2026, 10, 22, 9, 1));
  assert.strictEqual(r.messages[0].text, 'Laptop not charging\nbattery stays at 0%');
  assert.deepStrictEqual(r.faultKeys, ['laptop_battery', 'laptop_keyboard']);
});

test('parses an iPhone export with seconds, brackets and invisible marks', function () {
  var chat = '﻿[21/10/26, 10:14:05 AM] Neo Tokyo: Hello, how can we help?\n' +
             '[21/10/26, 10:15:30 AM] Meera S: PC is completely dead\n' +
             'No lights at all\n' +
             '‎[21/10/26, 10:15:41 AM] Meera S: ‎image omitted\n' +
             '[21/10/26, 1:02:00 PM] Meera S: My number is 98470 01003\n' +
             '[21/10/26, 1:03:00 PM] Meera S: Also there is a burning smell';
  var r = C.parseWhatsAppChat(chat);
  assert.strictEqual(r.messages.length, 5);
  assert.strictEqual(r.messages[0].from, 'Neo Tokyo');
  assert.strictEqual(r.messages[1].at, local(2026, 10, 21, 10, 15, 30));
  assert.strictEqual(r.messages[3].at, local(2026, 10, 21, 13, 2, 0));
  assert.strictEqual(r.messages[1].text, 'PC is completely dead\nNo lights at all');
  assert.strictEqual(r.name, 'Meera S');
  assert.strictEqual(r.phone, '9847001003');
  assert.strictEqual(r.faultText.indexOf('image omitted'), -1);
  assert.deepStrictEqual(r.faultKeys, ['no_power', 'psu_fault']);
});

test('parses copied messages ([time, date]) and month-first dates', function () {
  var r = C.parseWhatsAppChat('[10:14 am, 21/10/2026] Sneha T: windows not activated\n[10:20 am, 21/10/2026] Sneha T: thanks');
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.messages[0].at, local(2026, 10, 21, 10, 14));
  assert.deepStrictEqual(r.faultKeys, ['windows_activation']);
  var us = C.parseWhatsAppChat('10/21/26, 9:05 PM - Joel: pump noise from the aio');
  assert.strictEqual(us.messages[0].at, local(2026, 10, 21, 21, 5), 'a second number over 12 means month first');
  var dots = C.parseWhatsAppChat('21.10.26, 09:05 - Joel: hello');
  assert.strictEqual(dots.messages[0].at, local(2026, 10, 21, 9, 5));
  var bad = C.parseWhatsAppChat('31/02/26, 09:05 - Joel: hello');
  assert.strictEqual(bad.messages[0].at, null, 'an impossible date is not invented');
});

test('falls back sensibly for pasted text that is not an export', function () {
  var r = C.parseWhatsAppChat('Customer says the laptop screen is cracked. Number 98470 01002');
  assert.deepStrictEqual(r.messages, []);
  assert.strictEqual(r.phone, '9847001002');
  assert.strictEqual(r.name, null);
  assert.ok(r.faultText.indexOf('cracked') !== -1);
  assert.ok(r.faultKeys.indexOf('physical_damage') !== -1);
  var empty = C.parseWhatsAppChat('');
  assert.deepStrictEqual(empty, { phone: null, name: null, messages: [], faultText: '', faultKeys: [] });
  assert.deepStrictEqual(C.parseWhatsAppChat(undefined).messages, []);
});

test('the shop side is never taken as the customer, even when it writes first', function () {
  var r = C.parseWhatsAppChat([
    '21/10/26, 9:00 am - NEO TOKYO KOCHI: Hi, this is Neo Tokyo. Call 9847099999 for anything.',
    '21/10/26, 9:01 am - Neo Tokyo: Please send your issue',
    '21/10/26, 9:05 am - ~ Rahul Menon: board has no display'
  ].join('\n'));
  assert.strictEqual(r.name, 'Rahul Menon', 'group-style "~ " prefix removed');
  assert.strictEqual(r.phone, null, 'the shop number is not the customer phone');
  assert.strictEqual(r.faultText, 'board has no display');
});

test('opts.shopNames keeps a staff-named shop phone off the customer side', function () {
  var chat = ['21/10/26, 9:00 am - Anagha K C: Hello, this is the service desk',
              '21/10/26, 9:02 am - Divya Nair: my hard disk makes a clicking sound',
              '21/10/26, 9:03 am - Divya Nair: 98470 01025'].join('\n');
  var without = C.parseWhatsAppChat(chat);
  assert.strictEqual(without.name, 'Anagha K C', 'without the hint the first sender is taken');
  var withNames = C.parseWhatsAppChat(chat, { shopNames: ['anagha k c', '', null] });
  assert.strictEqual(withNames.name, 'Divya Nair');
  assert.strictEqual(withNames.phone, '9847001025');
  assert.strictEqual(withNames.faultText, 'my hard disk makes a clicking sound');
  assert.deepStrictEqual(withNames.faultKeys, ['ssd_fault']);
  assert.strictEqual(withNames.messages.length, 3, 'shop messages are still in the transcript');
});

console.log((failures ? 'FAILED' : 'OK') + ' service-catalog: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
