/*
  Unit tests for shared/service-demo.js — fixture integrity.
  Run: node tests/service-demo.test.js   — exits 1 on any failure.

  The demo rows go through the same screens as real rows, so they are held to
  the same rules: real column names, legal stages, consistent links, and a
  ticket ↔ part story the server's RMA sync would have produced.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var Demo = require(path.join(__dirname, '..', 'shared', 'service-demo.js'));
var S = require(path.join(__dirname, '..', 'shared', 'service-status.js'));
var C = require(path.join(__dirname, '..', 'shared', 'service-catalog.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var MIN = 60000, HOUR = 3600000, DAY = 86400000;
var NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();     // a working-day noon, local
var d = Demo.build(NOW);
function ms(v) { return new Date(v).getTime(); }
function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, label + ': ' + actual + ' vs ' + expected);
}
function byId(list) { var m = {}; list.forEach(function (r) { m[r.id] = r; }); return m; }
function jobBy(name) { return d.jobs.filter(function (j) { return j.customer_name === name; })[0]; }
function unitBy(brand, modelPart) {
  return d.units.filter(function (u) { return u.brand === brand && (!modelPart || u.model.indexOf(modelPart) !== -1); })[0];
}

// The real table columns (sql/service-v2.sql §2.4–§2.7 plus the v1 columns,
// plus sql/service-v2.1.sql's has_device_password).
var JOB_COLS = ['id', 'public_code', 'created_at', 'updated_at', 'job_kind', 'origin', 'stage', 'stage_since', 'received_at',
  'customer_name', 'customer_phone', 'customer_email', 'device_label', 'device_serial', 'reported_fault', 'has_customer_data',
  'build_ticket_id', 'intake', 'details', 'subject', 'diagnosis', 'work_done', 'assignee', 'assignee_email', 'promised_at',
  'waiting_party', 'next_chase_at', 'outcome', 'ready_at', 'closed_at', 'closed_by',
  'model_version', 'service_type', 'channel', 'category', 'priority', 'priority_reason', 'priority_set_by', 'fault_keys',
  'customer_id', 'created_by_email', 'created_by_name', 'suggested_tech_email', 'suggest_reason', 'assigned_via', 'assigned_at',
  'assign_reason', 'queued_at', 'needed_by', 'window_start', 'window_end', 'window_note', 'visit_start', 'visit_end', 'visit_count',
  'site_address', 'site_area', 'site_pincode', 'site_landmark', 'site_maps_url', 'site_lat', 'site_lng', 'site_contact',
  'remote_tool', 'remote_session_ref', 'remote_consent_at', 'converted_from', 'accessories', 'condition_note', 'powers_on',
  'data_consent', 'est_minutes', 'client_request_id', 'has_device_password'];
var ITEM_COLS = ['id', 'job_id', 'sort', 'is_primary', 'kind', 'label', 'serial', 'serial_norm', 'purchase_source', 'build_ticket_id',
  'invoice_no', 'purchase_date', 'condition_remarks', 'accessories', 'powers_on', 'returned_at', 'created_at', 'created_by'];
var INTAKE_COLS = ['id', 'source', 'service_job_id', 'sender_kind', 'sender_name', 'sender_phone', 'sender_customer_id',
  'inbound_courier', 'inbound_awb', 'received_at', 'return_method', 'return_address', 'notes', 'created_at', 'created_by_email',
  'created_by_name', 'client_request_id'];
var UNIT_COLS = ['id', 'public_code', 'intake_id', 'service_job_id', 'service_item_id', 'holds_ticket', 'kind', 'brand', 'model',
  'serial', 'serial_norm', 'fault', 'diagnosed_by', 'our_finding', 'owner_name', 'owner_phone', 'purchase_source', 'invoice_no',
  'purchase_date', 'build_ticket_id', 'vendor_id', 'vendor_rma_no', 'expected_back_at', 'vendor_result', 'vendor_reason',
  'replacement_serial', 'handling_fee', 'fee_status', 'fee_ref', 'fee_note', 'return_method', 'return_address', 'return_courier',
  'return_awb', 'advance_replacement', 'advance_serial', 'advance_at', 'stage', 'stage_since', 'disposition', 'handler_email',
  'handler_name', 'followup_job_id', 'created_at', 'updated_at', 'created_by_email', 'closed_at', 'closed_by',
  'data_handling' /* A11 */, 'replacement_serial_norm' /* A15, generated */, 'intake_seq' /* order in the create payload */];
var SHIPMENT_COLS = ['id', 'direction', 'vendor_id', 'courier', 'awb', 'cost', 'notes', 'dispatched_at', 'delivered_at',
  'created_at', 'created_by_email', 'mode' /* A9 */, 'carried_by' /* A9 */];
var SHIPMENT_ITEM_COLS = ['shipment_id', 'case_id'];
var VENDOR_COLS = ['id', 'name', 'public_name', 'kind', 'contact', 'address', 'portal_url', 'typical_tat_days', 'active', 'created_at'];
var SEV_COLS = ['id', 'job_id', 'at', 'client_at', 'kind', 'actor_kind', 'actor_email', 'actor_name', 'from_stage', 'to_stage',
  'body', 'customer_visible', 'meta'];
var REV_COLS = ['id', 'case_id', 'at', 'client_at', 'kind', 'actor_kind', 'actor_email', 'actor_name', 'from_stage', 'to_stage',
  'body', 'customer_visible', 'meta'];
var CUSTOMER_COLS = ['id', 'phone_norm', 'name', 'email', 'alt_phone', 'kind', 'address', 'area', 'pincode', 'landmark', 'maps_url',
  'lat', 'lng', 'notes', 'created_at', 'updated_at', 'created_by'];

var sevents = d.events.filter(function (e) { return 'job_id' in e; });
var revents = d.events.filter(function (e) { return 'case_id' in e; });
var JOBS = byId(d.jobs), UNITS = byId(d.units), INTAKES = byId(d.intakes), ITEMS = byId(d.items), VENDORS = byId(d.vendors);

// ═══ Shape ════════════════════════════════════════════════════════════════

test('build returns every table, media is empty, and it is deterministic', function () {
  ['jobs', 'items', 'units', 'intakes', 'vendors', 'events', 'staff', 'media', 'rma_events', 'techs', 'customers',
   'shipments', 'shipment_items'].forEach(function (k) {
    assert.ok(Array.isArray(d[k]), k);
  });
  assert.deepStrictEqual(d.media, []);
  assert.deepStrictEqual(Demo.build(NOW), d);
  assert.strictEqual(sevents.length + revents.length, d.events.length, 'every event belongs to a ticket or a part');
  assert.deepStrictEqual(d.rma_events.map(function (e) { return e.id; }).sort(), revents.map(function (e) { return e.id; }).sort());
  for (var i = 1; i < d.events.length; i++) assert.ok(d.events[i - 1].at <= d.events[i].at, 'events sorted by time');
});

test('every row has exactly the table columns (snake_case)', function () {
  function cols(list, want, label) {
    list.forEach(function (r) {
      assert.deepStrictEqual(Object.keys(r).sort(), want.slice().sort(), label + ' ' + r.id);
      Object.keys(r).forEach(function (k) { assert.ok(/^[a-z0-9_]+$/.test(k), label + ' column ' + k); });
    });
  }
  cols(d.jobs, JOB_COLS, 'service_jobs');
  cols(d.items, ITEM_COLS, 'service_items');
  cols(d.intakes, INTAKE_COLS, 'rma_intakes');
  cols(d.units, UNIT_COLS, 'rma_cases');
  cols(d.vendors, VENDOR_COLS, 'rma_vendors');
  cols(sevents, SEV_COLS, 'service_events');
  cols(revents, REV_COLS, 'rma_events');
  cols(d.customers, CUSTOMER_COLS, 'customers');
  cols(d.shipments, SHIPMENT_COLS, 'rma_shipments');
  d.shipment_items.forEach(function (r) {
    assert.deepStrictEqual(Object.keys(r).sort(), SHIPMENT_ITEM_COLS.slice().sort(), 'rma_shipment_items');
  });
  d.staff.forEach(function (p) {
    assert.deepStrictEqual(Object.keys(p).sort(), ['active', 'designation', 'email', 'full_name', 'id', 'tier']);
  });
});

test('ids are unique and prefixed demo_; codes are unique and can never be a real code', function () {
  var all = [];
  ['jobs', 'items', 'units', 'intakes', 'vendors', 'events', 'customers', 'staff', 'shipments'].forEach(function (k) {
    d[k].forEach(function (r) {
      assert.ok(typeof r.id === 'string' && r.id.indexOf('demo_') === 0, k + ' id ' + r.id);
      all.push(r.id);
    });
  });
  assert.strictEqual(new Set(all).size, all.length, 'duplicate id');
  var codes = d.jobs.map(function (j) { return j.public_code; }).concat(d.units.map(function (u) { return u.public_code; }));
  assert.strictEqual(new Set(codes).size, codes.length, 'duplicate public code');
  d.jobs.forEach(function (j) { assert.ok(/^NT-DEMO[234679ACDEFGHJKLMNPQRTUVWXYZ]{4}$/.test(j.public_code), j.public_code); });
  d.units.forEach(function (u) { assert.ok(/^RM-DEMO[234679ACDEFGHJKLMNPQRTUVWXYZ]{4}$/.test(u.public_code), u.public_code); });
  assert.ok(Demo.isDemoId('demo_s_x') && !Demo.isDemoId('s_x') && !Demo.isDemoId(null));
});

test('everything is relative to nowMs', function () {
  var later = Demo.build(NOW + 5 * HOUR);
  d.jobs.forEach(function (j, i) {
    assert.strictEqual(ms(later.jobs[i].created_at) - ms(j.created_at), 5 * HOUR, j.id + ' created_at');
    assert.strictEqual(ms(later.jobs[i].stage_since) - ms(j.stage_since), 5 * HOUR, j.id + ' stage_since');
  });
  d.units.forEach(function (u, i) {
    if (u.stage === 'closed') return;   // "closed today" is pinned to the local day
    assert.strictEqual(ms(later.units[i].stage_since) - ms(u.stage_since), 5 * HOUR, u.id);
  });
  d.shipments.forEach(function (s, i) {
    assert.strictEqual(ms(later.shipments[i].dispatched_at) - ms(s.dispatched_at), 5 * HOUR, s.id);
    assert.ok(ms(s.dispatched_at) <= NOW, s.id);
  });
  d.events.forEach(function (e) { assert.ok(ms(e.at) <= NOW, e.id + ' is in the future'); });
  d.jobs.forEach(function (j) { assert.ok(ms(j.created_at) <= NOW && ms(j.stage_since) <= NOW, j.id); });
  assert.strictEqual(Demo.build('garbage').jobs.length, d.jobs.length, 'a bad clock falls back to now');
});

test('phones are obviously fake and A1-normalised, emails are example.com, staff are the roster', function () {
  var FAKE = /^91984700\d{4}$/;
  d.jobs.forEach(function (j) { assert.ok(FAKE.test(Demo.normPhone(j.customer_phone)), j.customer_phone); });
  d.customers.forEach(function (c) { assert.ok(FAKE.test(c.phone_norm), c.phone_norm); });
  d.customers.forEach(function (c) { assert.strictEqual(Demo.normPhone(c.phone_norm), c.phone_norm, 'phone_norm is already normal'); });
  d.units.forEach(function (u) { if (u.owner_phone) assert.ok(FAKE.test(Demo.normPhone(u.owner_phone))); });
  d.intakes.forEach(function (i) { if (i.sender_phone) assert.ok(FAKE.test(Demo.normPhone(i.sender_phone))); });
  d.jobs.forEach(function (j) { assert.ok(/^\+91984700\d{4}$/.test(j.customer_phone), 'stored as the v2 intake sends it: ' + j.customer_phone); });
  d.jobs.concat(d.customers).forEach(function (r) {
    var e = r.customer_email || r.email;
    if (e) assert.ok(/@([a-z]+\.)?example\.com$/.test(e), e);
  });
  assert.deepStrictEqual(d.staff.map(function (p) { return p.full_name; }).sort(),
    ['Adhil M', 'Amal C Abi', 'Anagha K C', 'Ancy Baby', 'Athul Sudheer', 'Vinayakan S']);
  assert.strictEqual(new Set(d.staff.map(function (p) { return p.email; })).size, 6);
});

// ═══ Service tickets ═════════════════════════════════════════════════════

test('every ticket uses the vocabulary and sits on a legal stage for its type', function () {
  d.jobs.forEach(function (j) {
    assert.strictEqual(j.model_version, 2, j.id);
    assert.ok(S.TYPES[j.service_type], j.id + ' type');
    assert.ok(S.CHANNELS[j.channel], j.id + ' channel');
    assert.ok(S.CATEGORIES[j.category], j.id + ' category');
    assert.ok(S.PRIORITIES[j.priority], j.id + ' priority');
    assert.ok(S.JOB_KINDS[j.job_kind], j.id + ' job_kind');
    assert.ok(S.stageLegalFor(j.service_type, j.stage), j.id + ' stage ' + j.stage + ' on ' + j.service_type);
    assert.ok(Array.isArray(j.fault_keys) && j.fault_keys.length, j.id + ' faults');
    j.fault_keys.forEach(function (k) { assert.ok(C.fault(k), j.id + ' fault ' + k); });
    // The demo shows today's answers only (the shop never backs up data);
    // backup_ok / no_backup are valid old rows, never something to show off.
    if (j.data_consent) assert.ok(S.DATA_CONSENT_CHOICES.indexOf(j.data_consent) !== -1, j.id + ' consent ' + j.data_consent);
    if (j.data_consent) assert.strictEqual(j.has_customer_data, S.hasCustomerDataFor(j.data_consent), j.id + ' has_customer_data follows the answer');
    assert.strictEqual(typeof j.has_device_password, 'boolean', j.id + ' has_device_password');
    if (j.has_device_password) assert.ok(j.stage !== 'closed', j.id + ': a closed ticket never has a password on file');
    if (j.remote_tool) assert.ok(S.REMOTE_TOOLS[j.remote_tool], j.id + ' tool');
    if (j.converted_from) assert.ok(S.TYPES[j.converted_from] && j.converted_from !== j.service_type, j.id);
    if (j.service_type === 'on_site') assert.ok(j.site_address || j.site_area, j.id + ' on-site needs a site');
    if (j.stage === 'ready' || j.stage === 'closed') assert.ok(S.OUTCOMES[j.outcome], j.id + ' outcome');
    if (j.stage === 'ready') assert.ok(j.ready_at, j.id + ' ready_at');
    if (j.received_at) assert.ok(ms(j.received_at) >= ms(j.created_at), j.id);
    (j.accessories || []).forEach(function (a) { assert.ok(C.ACCESSORIES.indexOf(a) !== -1, j.id + ' accessory ' + a); });
  });
});

test('priority, reasons and typical time are what the catalogue computes', function () {
  var machines = { 'Kerala Freight Co.': 4 };
  var custById = byId(d.customers);
  d.jobs.forEach(function (j) {
    var ctx = { service_type: j.service_type, business: custById[j.customer_id].kind === 'business',
                machines: machines[j.customer_name] || 0, needed_by: j.needed_by, now: NOW };
    var r = C.computePriority(j.fault_keys, ctx);
    assert.strictEqual(j.priority, r.priority, j.customer_name + ' priority');
    assert.strictEqual(j.priority_reason, r.reasons.join(', '), j.customer_name + ' reason');
    assert.strictEqual(j.est_minutes, C.estMinutes(j.fault_keys), j.customer_name + ' est');
  });
});

test('assignment and queue columns agree', function () {
  var staff = {};
  d.staff.forEach(function (p) { staff[p.email] = p; });
  d.jobs.forEach(function (j) {
    if (j.assignee_email) {
      assert.ok(staff[j.assignee_email], j.id + ' assignee is staff');
      assert.strictEqual(j.assignee, staff[j.assignee_email].full_name, j.id);
      assert.ok(S.ASSIGNED_VIA[j.assigned_via] && j.assigned_at, j.id + ' assigned_via/at');
      assert.strictEqual(j.queued_at, null, j.id + ' claimed tickets are not queued');
    } else {
      assert.ok(j.queued_at && j.assignee === null && j.assigned_via === null, j.id + ' queue');
    }
    if (j.suggested_tech_email) assert.ok(staff[j.suggested_tech_email] && j.suggest_reason, j.id + ' suggestion');
    assert.ok(staff[j.created_by_email] && j.created_by_name === staff[j.created_by_email].full_name, j.id + ' creator');
  });
});

test('items: one primary per ticket, mirrored onto the ticket, serial_norm computed', function () {
  d.jobs.forEach(function (j) {
    var mine = d.items.filter(function (i) { return i.job_id === j.id; });
    assert.ok(mine.length >= 1, j.id + ' has items');
    var prim = mine.filter(function (i) { return i.is_primary; });
    assert.strictEqual(prim.length, 1, j.id + ' primary');
    assert.strictEqual(prim[0].sort, 0);
    assert.strictEqual(j.device_label, prim[0].label, j.id + ' device_label');
    assert.strictEqual(j.device_serial, prim[0].serial, j.id + ' device_serial');
  });
  d.items.forEach(function (i) {
    assert.ok(JOBS[i.job_id], i.id + ' job');
    assert.ok(S.ITEM_KINDS[i.kind], i.id + ' kind');
    assert.ok(S.PURCHASE_SOURCES[i.purchase_source], i.id + ' source');
    assert.strictEqual(i.serial_norm, String(i.serial || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), i.id);
    if (i.purchase_date) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(i.purchase_date), i.id + ' date column');
  });
  assert.ok(d.jobs.some(function (j) { return d.items.filter(function (i) { return i.job_id === j.id; }).length >= 2; }), 'a multi-item ticket');
});

test('the ten planned tickets are there as described', function () {
  var a = jobBy('Arjun R Kumar');
  assert.ok(a.service_type === 'in_store' && a.stage === 'diagnosing' && a.assignee_email);
  near(NOW - ms(a.stage_since), 9 * HOUR, MIN, 'Arjun 9 h');

  var an = jobBy('Anjali M');
  assert.ok(an.service_type === 'in_store' && an.stage === 'received' && !an.assignee_email);
  near(NOW - ms(an.stage_since), 1.6 * DAY, MIN, 'Anjali 1.6 d');

  var me = jobBy('Meera S');
  assert.ok(me.service_type === 'in_store' && me.stage === 'quoted');
  near(NOW - ms(me.stage_since), 4.1 * DAY, MIN, 'Meera 4.1 d');
  assert.ok(sevents.some(function (e) { return e.job_id === me.id && /₹8,400/.test(e.body || ''); }), 'Meera ₹8,400 note');

  var sa = jobBy('Sandeep V');
  assert.ok(sa.stage === 'ready' && sa.outcome === 'repaired');
  near(NOW - ms(sa.stage_since), 2.4 * DAY, MIN, 'Sandeep 2.4 d');

  var vi = jobBy('Vishnu P');
  assert.ok(vi.service_type === 'in_store' && vi.stage === 'at_vendor' && vi.waiting_party === 'ASUS');
  near(NOW - ms(vi.stage_since), 16 * DAY, MIN, 'Vishnu 16 d');

  var kf = jobBy('Kerala Freight Co.');
  assert.ok(kf.service_type === 'on_site' && kf.stage === 'on_site' && kf.assignee === 'Athul Sudheer' && kf.assigned_via === 'claim');
  near(NOW - ms(kf.stage_since), 2 * HOUR, MIN, 'Kerala Freight 2 h');
  assert.ok(kf.visit_count >= 1 && ms(kf.visit_start) < NOW);

  var ni = jobBy('Dr. Nisha Varghese');
  assert.ok(ni.service_type === 'on_site' && ni.stage === 'en_route' && ni.assignee_email);
  var vs = new Date(ni.visit_start);
  assert.ok(vs.getHours() === 14 && vs.getMinutes() === 30 && vs.toDateString() === new Date(NOW).toDateString(), 'visit today 14:30');

  var ra = jobBy('Ramesh Iyer');
  assert.ok(ra.service_type === 'on_site' && ra.stage === 'parts_on_order' && ra.waiting_party && ra.visit_count === 1);
  assert.ok(ra.assignee_email && !ra.visit_start, 'shows under "Claimed — no visit time"');

  var sn = jobBy('Sneha T');
  assert.ok(sn.service_type === 'remote' && sn.stage === 'logged' && !sn.assignee_email && sn.suggested_tech_email);
  near(NOW - ms(sn.created_at), 40 * MIN, MIN, 'Sneha 40 min');

  var fa = jobBy('Fahad K');
  assert.ok(fa.service_type === 'in_store' && fa.converted_from === 'remote' && fa.stage === 'received');
  near(NOW - ms(fa.stage_since), 5 * HOUR, MIN, 'Fahad 5 h');
  assert.ok(sevents.some(function (e) { return e.job_id === fa.id && /Converted from Remote to In-store/.test(e.body || ''); }));
});

test('the queue has the planned unclaimed tickets, one extra requested for a technician', function () {
  var q = d.jobs.filter(S.inQueue);
  assert.ok(q.length >= 5, 'queue ' + q.length);
  var planned = ['Anjali M', 'Sneha T'];
  var extra = q.filter(function (j) { return planned.indexOf(j.customer_name) === -1; });
  assert.ok(extra.length >= 3, 'three more unclaimed');
  assert.ok(extra.some(function (j) { return j.suggested_tech_email; }), 'one requested for a tech');
  var risks = q.map(function (j) { return S.queueRisk(j, NOW); });
  assert.ok(risks.indexOf(2) !== -1 && risks.indexOf(0) !== -1, 'the queue shows late and fresh tickets');
  assert.ok(d.jobs.some(function (j) { return S.serviceRisk(j, NOW) === 2; }), 'something is late on the board');
});

// ═══ RMA ═════════════════════════════════════════════════════════════════

test("every unit's intake, ticket, item and vendor exist and agree", function () {
  d.units.forEach(function (u) {
    var ik = INTAKES[u.intake_id];
    assert.ok(ik, u.id + ' intake');
    assert.strictEqual(u.service_job_id, ik.service_job_id, u.id + ' ticket matches its intake');
    if (u.service_job_id) assert.ok(JOBS[u.service_job_id], u.id + ' ticket exists');
    if (u.service_item_id) {
      assert.ok(ITEMS[u.service_item_id], u.id + ' item exists');
      assert.strictEqual(ITEMS[u.service_item_id].job_id, u.service_job_id, u.id + ' item is on the same ticket');
    }
    if (u.holds_ticket) assert.ok(u.service_job_id, u.id + ' only a linked unit can hold a ticket');
    if (u.vendor_id != null) assert.ok(VENDORS[u.vendor_id], u.id + ' vendor');
    if (u.followup_job_id) assert.ok(JOBS[u.followup_job_id]);
    assert.ok(S.RMA_STAGES[u.stage], u.id + ' stage');
    assert.ok(S.ITEM_KINDS[u.kind], u.id + ' kind');
    assert.ok(S.DIAGNOSED_BY[u.diagnosed_by], u.id + ' diagnosed_by');
    assert.ok(S.PURCHASE_SOURCES[u.purchase_source], u.id + ' purchase_source');
    assert.ok(S.FEE_STATUSES[u.fee_status], u.id + ' fee_status');
    assert.ok(S.RETURN_METHODS[u.return_method], u.id + ' return_method');
    if (u.vendor_result) assert.ok(S.RMA_VENDOR_RESULTS[u.vendor_result], u.id);
    if (u.disposition) assert.ok(S.RMA_DISPOSITIONS[u.disposition], u.id);
    assert.strictEqual(u.serial_norm, String(u.serial || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), u.id);
  });
  d.intakes.forEach(function (i) {
    assert.ok(S.RMA_SOURCES[i.source] && S.SENDER_KINDS[i.sender_kind] && S.RETURN_METHODS[i.return_method], i.id);
    assert.ok(d.units.some(function (u) { return u.intake_id === i.id; }), i.id + ' has at least one part');
    // A ticket's part comes from the counter (from_ticket) or off the site (field, A8).
    if (i.service_job_id) assert.ok(i.source === 'from_ticket' || i.source === 'field', i.id + ' ' + i.source);
  });
  d.units.forEach(function (u) {
    if (u.data_handling != null) assert.ok(S.DATA_HANDLING[u.data_handling], u.id + ' data_handling');
    assert.strictEqual(u.replacement_serial_norm, String(u.replacement_serial || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), u.id);
  });
  assert.ok(d.vendors.length >= 36, 'the full vendor seed');
  assert.strictEqual(VENDORS.demo_v_intel.typical_tat_days, 21);
  assert.strictEqual(VENDORS.demo_v_asus.typical_tat_days, 14);
  d.vendors.forEach(function (v) { assert.ok(v.public_name && v.kind === 'brand' && v.active === true, v.id); });
});

test('every part past testing really passed the shipping gates (photos aside)', function () {
  d.units.forEach(function (u) {
    if (['ready_to_ship', 'with_vendor', 'back_from_vendor'].indexOf(u.stage) !== -1 ||
        (u.vendor_result && u.stage !== 'logged')) {
      assert.deepStrictEqual(S.rmaGateProblems(u, u.stage === 'ready_to_ship' ? 'with_vendor' : 'ready_to_ship',
        null).filter(function (p) { return !/cannot move/.test(p); }), [], u.id);
    }
    if (u.stage === 'with_vendor') assert.ok(u.vendor_id && u.expected_back_at, u.id + ' dispatched with a date');
    if (u.vendor_result === 'replaced') assert.ok(u.replacement_serial, u.id + ' replacement serial');
    if (u.stage === 'closed') {
      assert.deepStrictEqual(S.rmaGateProblems(Object.assign({}, u, { stage: 'returning' }), 'closed'), [], u.id);
      assert.ok(u.closed_at && u.closed_by, u.id);
    }
    if (u.purchase_source === 'elsewhere') assert.ok(u.handling_fee > 0 && u.fee_status !== 'n_a', u.id + ' fee');
  });
});

test('the planned parts are there as described', function () {
  var box = d.intakes.filter(function (i) { return i.sender_name === 'Sreekumar Computers, Thrissur'; })[0];
  assert.ok(box && box.source === 'courier' && box.sender_kind === 'third_party_tech' && box.inbound_awb);
  var inBox = d.units.filter(function (u) { return u.intake_id === box.id; });
  assert.strictEqual(inBox.length, 3);
  assert.strictEqual(new Set(inBox.map(function (u) { return u.owner_name; })).size, 3, 'three end customers');
  assert.strictEqual(unitBy('Corsair', 'RM750').stage, 'testing');
  assert.strictEqual(unitBy('Kingston').stage, 'received');
  assert.strictEqual(unitBy('WD', 'SN570').stage, 'received');

  var b550 = unitBy('ASUS', 'B550');
  assert.ok(b550.stage === 'ready_to_ship' && INTAKES[b550.intake_id].source === 'walk_in');
  var z = unitBy('Zotac', 'RTX 3060');
  assert.ok(z.stage === 'ready_to_ship' && !z.holds_ticket && z.service_job_id === jobBy('Arjun R Kumar').id);
  var sg = unitBy('Seagate', '2TB');
  assert.ok(sg.stage === 'awaiting_docs' && sg.purchase_source === 'elsewhere' && sg.fee_status === 'quoted' && sg.handling_fee === 300);
  var h = unitBy('Corsair', 'H100i');
  assert.ok(h.stage === 'with_vendor');
  near(NOW - ms(h.stage_since), 2 * DAY, MIN, 'H100i 2 d');
  var s980 = unitBy('Samsung', '980');
  assert.ok(s980.stage === 'with_vendor' && INTAKES[s980.intake_id].source === 'stock');
  near(NOW - ms(s980.stage_since), 5 * DAY, MIN, 'Samsung 5 d');
  var msi = unitBy('MSI', '650') || unitBy('MSI');
  assert.ok(msi.stage === 'closed' && msi.vendor_result === 'replaced' && msi.disposition === 'replaced');
  assert.strictEqual(new Date(msi.closed_at).toDateString(), new Date(NOW).toDateString(), 'closed today');

  var vi = jobBy('Vishnu P');
  var gpu = unitBy('ASUS', 'RTX 4070 Ti');
  assert.ok(gpu.stage === 'with_vendor' && gpu.holds_ticket && gpu.service_job_id === vi.id && /A4471/.test(gpu.vendor_rma_no));
  near(NOW - ms(gpu.stage_since), 16 * DAY, MIN, 'GPU 16 d');
  var antec = unitBy('Antec');
  assert.ok(antec.purchase_source === 'elsewhere' && antec.vendor_result === 'rejected' && antec.stage === 'customer_decision' &&
            antec.service_job_id === vi.id);
  assert.ok(d.units.every(function (u) { return u.handling_fee == null || typeof u.handling_fee === 'number'; }));
});

test('A4: a part linked to the ticket\'s own primary item is a whole-device RMA and holds the ticket', function () {
  d.units.forEach(function (u) {
    if (!u.service_item_id) return;
    var it = ITEMS[u.service_item_id];
    if (it && it.is_primary) assert.ok(u.holds_ticket, u.id + ' links the primary item but does not hold');
  });
  // Parts taken out of a ticket's PC are not the PC.
  ['RTX 3060', 'RTX 4070 Ti'].forEach(function (m) {
    var u = d.units.filter(function (x) { return x.model.indexOf(m) !== -1; })[0];
    assert.strictEqual(u.service_item_id, null, m);
  });
});

test('A8: the field pull from Ramesh Iyer is with Athul, linked but not holding', function () {
  var ra = jobBy('Ramesh Iyer');
  var pulled = d.units.filter(function (u) { return u.stage === 'with_tech'; });
  assert.strictEqual(pulled.length, 1);
  var u = pulled[0];
  var ik = INTAKES[u.intake_id];
  assert.strictEqual(ik.source, 'field');
  assert.strictEqual(ik.sender_kind, 'our_tech');
  assert.strictEqual(ik.sender_name, 'Athul Sudheer');
  assert.strictEqual(u.handler_name, 'Athul Sudheer');
  assert.strictEqual(u.service_job_id, ra.id);
  assert.strictEqual(u.holds_ticket, false, 'non-holding: the ticket waits for the new PSU, not this one');
  assert.strictEqual(u.owner_name, 'Ramesh Iyer');
  assert.strictEqual(Demo.normPhone(u.owner_phone), Demo.normPhone(ra.customer_phone), 'Ramesh tracks it');
  assert.strictEqual(ik.received_at, null, 'not at the counter yet');
  // A field pull starts at with_tech, never at logged.
  var first = revents.filter(function (e) { return e.case_id === u.id && e.to_stage; })[0];
  assert.ok(first.from_stage === null && first.to_stage === 'with_tech', 'starts at with_tech');
  assert.ok(ms(first.at) <= NOW && ms(first.at) >= ms(ra.created_at), 'during the ticket');
  assert.strictEqual(S.rmaColumnOf(u), 'intake');
  assert.strictEqual(S.rmaBallOf(u), 'shop');
  assert.deepStrictEqual(S.rmaNextStages(u), ['received', 'ready_to_ship', 'closed']);
  assert.strictEqual(S.rmaSyncTarget(ra, d.units), null, 'it does not move the ticket');
  assert.ok(sevents.some(function (e) { return e.job_id === ra.id && e.kind === 'rma' && e.meta.rma_case_id === u.id; }),
            "on Ramesh's timeline");
  assert.strictEqual(Demo.lookupCustomer(d, ra.customer_phone).open_rma.length, 1, 'Ramesh finds it by his phone');
});

test('A9: shipments have a mode; a courier has an AWB, a hand delivery says who carried it', function () {
  assert.ok(d.shipments.some(function (s) { return s.mode === 'hand_delivery'; }), 'one hand delivery');
  d.shipments.forEach(function (s) {
    assert.ok(S.SHIPMENT_MODES[s.mode], s.id + ' mode');
    assert.ok(['in_from_customer', 'out_to_vendor', 'in_from_vendor', 'out_to_customer'].indexOf(s.direction) !== -1, s.id);
    if (s.mode === 'courier') assert.ok(s.awb && s.courier, s.id + ' courier needs an AWB');
    else assert.ok(s.carried_by || s.notes, s.id + ' needs who carried it or a note');
    if (s.direction === 'out_to_vendor') assert.ok(VENDORS[s.vendor_id], s.id + ' vendor');
    assert.ok(d.shipment_items.some(function (x) { return x.shipment_id === s.id; }), s.id + ' carries something');
  });
  d.shipment_items.forEach(function (x) { assert.ok(UNITS[x.case_id], x.case_id); });
  // Every part that went to a vendor went in exactly one parcel, to its own vendor.
  d.units.forEach(function (u) {
    var went = revents.some(function (e) { return e.case_id === u.id && e.to_stage === 'with_vendor'; });
    var out = d.shipment_items.filter(function (x) {
      var s = d.shipments.filter(function (y) { return y.id === x.shipment_id; })[0];
      return x.case_id === u.id && s.direction === 'out_to_vendor';
    });
    assert.strictEqual(out.length, went ? 1 : 0, u.id + ' outbound parcels');
    if (went) {
      var s = d.shipments.filter(function (y) { return y.id === out[0].shipment_id; })[0];
      assert.strictEqual(s.vendor_id, u.vendor_id, u.id + ' shipped to its vendor');
    }
  });
});

test('A11: every drive that left the shop has its data handling recorded', function () {
  var drives = d.units.filter(function (u) { return S.needsDataHandling(u.kind); });
  assert.ok(drives.some(function (u) { return u.kind === 'ssd' && u.data_handling; }), 'an SSD with data_handling set');
  drives.forEach(function (u) {
    if (['ready_to_ship', 'with_vendor', 'back_from_vendor', 'returning'].indexOf(u.stage) !== -1) {
      assert.ok(S.DATA_HANDLING[u.data_handling], u.id);
    }
  });
  assert.ok(drives.some(function (u) { return !u.data_handling && u.stage !== 'closed'; }),
            'a drive still waiting for the answer, so the gate shows in the demo');
  var s980 = unitBy('Samsung', '980');
  assert.ok(revents.some(function (e) { return e.case_id === s980.id && !e.customer_visible && /Data on the drive: We wiped it/.test(e.body || ''); }),
            'recording it wrote an internal event');
});

test('A7: mirrored ticket events carry no RMA stage keys and are worded for their reader', function () {
  sevents.filter(function (e) { return e.kind === 'rma'; }).forEach(function (e) {
    assert.strictEqual(e.from_stage, null, e.id);
    assert.strictEqual(e.to_stage, null, e.id);
    assert.ok(e.meta && e.meta.rma_case_id && e.meta.rma_event_id && e.meta.rma_kind, e.id + ' meta');
    assert.ok(!/\b(with_vendor|ready_to_ship|awaiting_docs|with_tech|back_from_vendor)\b/.test(e.body), e.id + ' raw key in ' + e.body);
  });
});

test('every holding part keeps its ticket in the mirror stage the sync rule gives', function () {
  var holding = d.units.filter(S.isHolding);
  assert.ok(holding.length >= 1, 'the holding scenario exists');
  holding.forEach(function (u) {
    var job = JOBS[u.service_job_id];
    assert.ok(S.isMirrorStage(job.stage), job.id + ' is in a mirror stage');
    assert.strictEqual(S.rmaSyncTarget(job, d.units), job.stage, job.id + ' matches the sync rule');
  });
  d.jobs.forEach(function (j) {
    var t = S.rmaSyncTarget(j, d.units);
    assert.ok(t === null || t === j.stage, j.id + ' would be moved by the sync to ' + t);
    if (S.isMirrorStage(j.stage)) assert.ok(S.holdingUnitsOf(j, d.units).length, j.id + ' mirror stage without a holding part');
  });
  // The board puts Vishnu's ticket where its holding part is (the overdue GPU;
  // the Antec waiting on his decision does not hold the ticket).
  assert.strictEqual(S.ticketColumnOf(jobBy('Vishnu P'), d.units, NOW), 'third');
  assert.strictEqual(S.rmaRisk(unitBy('ASUS', 'RTX 4070 Ti'), NOW), 2, 'the GPU is overdue at ASUS');
  var vi = jobBy('Vishnu P');
  assert.strictEqual(vi.next_chase_at, unitBy('ASUS', 'RTX 4070 Ti').expected_back_at);
  var vendorsById = {};
  d.vendors.forEach(function (v) { vendorsById[v.id] = v; });
  var view = S.ticketWithUnits(vi, d.units, vendorsById, NOW);
  assert.deepStrictEqual([view.ball, view.column, view.risk], ['third_party', 'third', 2]);
  assert.strictEqual(view.sentence, 'Graphics card — ASUS TUF Gaming RTX 4070 Ti 12GB: Waiting for ASUS — with the manufacturer under warranty');
  assert.strictEqual(view.unit, unitBy('ASUS', 'RTX 4070 Ti'));
  // A13: the ticket's waiting_party is the brand the customer knows.
  assert.strictEqual(vi.waiting_party, S.customerFacingMaker(view.unit, vendorsById[view.unit.vendor_id]));
});

test('every board lane has something in the demo', function () {
  var serviceLanes = {};
  d.jobs.forEach(function (j) { serviceLanes[S.ticketColumnOf(j, d.units, NOW)] = true; });
  ['intake', 'shop', 'customer', 'third'].forEach(function (k) { assert.ok(serviceLanes[k], 'service lane ' + k); });
  var rmaLanes = {};
  d.units.forEach(function (u) { rmaLanes[S.rmaColumnOf(u)] = true; });
  ['intake', 'shop', 'customer', 'third', 'closed'].forEach(function (k) { assert.ok(rmaLanes[k], 'RMA lane ' + k); });
});

// ═══ Timelines ═══════════════════════════════════════════════════════════

test('events point at real rows and use the known kinds', function () {
  var sKinds = ['stage', 'note', 'edit', 'media', 'claim', 'release', 'assign', 'field', 'rma'];
  var rKinds = ['stage', 'note', 'edit', 'media', 'fee', 'link', 'system'];
  sevents.forEach(function (e) {
    assert.ok(JOBS[e.job_id], e.id + ' job');
    assert.ok(sKinds.indexOf(e.kind) !== -1, e.id + ' kind ' + e.kind);
    assert.ok(['staff', 'system', 'customer'].indexOf(e.actor_kind) !== -1, e.id);
    assert.strictEqual(typeof e.customer_visible, 'boolean');
    if (e.to_stage) assert.ok(S.isKnownStage(e.to_stage), e.id + ' to ' + e.to_stage);
  });
  revents.forEach(function (e) {
    assert.ok(UNITS[e.case_id], e.id + ' case');
    assert.ok(rKinds.indexOf(e.kind) !== -1, e.id + ' kind ' + e.kind);
    if (e.from_stage && e.to_stage) assert.ok(S.rmaTransitionOk(e.from_stage, e.to_stage), e.id + ' ' + e.from_stage + '>' + e.to_stage);
  });
});

test("each ticket's and part's last stage event is its current stage, at stage_since", function () {
  d.jobs.forEach(function (j) {
    var moves = sevents.filter(function (e) { return e.job_id === j.id && e.to_stage; });
    assert.ok(moves.length, j.id + ' has a stage history');
    var last = moves[moves.length - 1];
    assert.strictEqual(last.to_stage, j.stage, j.id + ' last move');
    assert.strictEqual(last.at, j.stage_since, j.id + ' stage_since');
    assert.ok(moves[0].from_stage === null, j.id + ' first event creates it');
    for (var i = 1; i < moves.length; i++) {
      assert.strictEqual(moves[i].from_stage, moves[i - 1].to_stage, j.id + ' unbroken chain at ' + moves[i].id);
    }
    assert.ok(j.updated_at >= j.stage_since, j.id + ' updated_at');
  });
  d.units.forEach(function (u) {
    var moves = revents.filter(function (e) { return e.case_id === u.id && e.to_stage; });
    assert.ok(moves.length, u.id + ' has a stage history');
    var last = moves[moves.length - 1];
    assert.strictEqual(last.to_stage, u.stage, u.id + ' last move');
    assert.strictEqual(last.at, u.stage_since, u.id + ' stage_since');
    for (var i = 1; i < moves.length; i++) assert.strictEqual(moves[i].from_stage, moves[i - 1].to_stage, u.id + ' chain');
  });
});

test('every event of a linked part is mirrored onto its ticket', function () {
  revents.forEach(function (e) {
    var u = UNITS[e.case_id];
    var mirrors = sevents.filter(function (s) { return s.kind === 'rma' && s.meta && s.meta.rma_event_id === e.id; });
    if (!u.service_job_id) { assert.strictEqual(mirrors.length, 0, e.id); return; }
    assert.strictEqual(mirrors.length, 1, e.id + ' mirrored once');
    var m = mirrors[0];
    assert.strictEqual(m.job_id, u.service_job_id);
    assert.strictEqual(m.customer_visible, e.customer_visible);
    assert.strictEqual(m.meta.rma_case_id, u.id);
    assert.ok(m.body.indexOf(u.public_code) !== -1);
  });
  var vi = jobBy('Vishnu P');
  assert.ok(sevents.some(function (e) { return e.job_id === vi.id && e.actor_name === 'RMA link' && e.to_stage === 'at_vendor'; }),
            'the sync move to at_vendor is on the timeline');
});

test('field events on on-site tickets carry the field-activity meta', function () {
  sevents.filter(function (e) { return e.kind === 'field'; }).forEach(function (e) {
    assert.strictEqual(JOBS[e.job_id].service_type, 'on_site', e.id);
    assert.ok(e.meta && e.meta.field_activity_id, e.id);
    assert.ok(e.from_stage && e.to_stage, e.id);
  });
  assert.ok(sevents.some(function (e) { return e.kind === 'claim'; }) && sevents.some(function (e) { return e.kind === 'field'; }));
});

test('"closed today" stays today at any hour, and the build never throws', function () {
  [[0, 30], [1, 0], [2, 59], [3, 1], [9, 0], [23, 50]].forEach(function (hm) {
    var t = new Date(2026, 9, 21, hm[0], hm[1], 0).getTime();
    var b = Demo.build(t);
    var msi = b.units.filter(function (u) { return u.brand === 'MSI'; })[0];
    assert.strictEqual(new Date(msi.closed_at).toDateString(), new Date(t).toDateString(), hm.join(':'));
    assert.ok(ms(msi.closed_at) <= t);
    var last = b.events.filter(function (e) { return e.case_id === msi.id && e.to_stage; }).pop();
    assert.strictEqual(last.at, msi.stage_since, 'closing event at stage_since');
  });
});

// ═══ Staff, technicians, customer lookup ════════════════════════════════

test('techs mirror service_tech_list() and count from the jobs', function () {
  assert.deepStrictEqual(d.techs.map(function (t) { return t.name; }), ['Adhil M', 'Amal C Abi', 'Athul Sudheer', 'Vinayakan S']);
  d.techs.forEach(function (t) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['designation', 'email', 'in_queue_requested', 'name', 'open_count', 'role', 'visits_today']);
    assert.strictEqual(t.open_count, d.jobs.filter(function (j) { return j.assignee_email === t.email && j.stage !== 'closed'; }).length);
  });
  var athul = d.techs.filter(function (t) { return t.name === 'Athul Sudheer'; })[0];
  assert.strictEqual(athul.in_queue_requested, 1);
  var vin = d.techs.filter(function (t) { return t.name === 'Vinayakan S'; })[0];
  assert.strictEqual(vin.visits_today, 1, "Nisha's visit today");
});

test('lookupCustomer answers in the lookup_customer() shape', function () {
  var r = Demo.lookupCustomer(d, '+91 98470 01005');
  assert.deepStrictEqual(Object.keys(r).sort(), ['customer', 'jobs_total', 'open_jobs', 'open_rma', 'past_techs', 'phone_norm', 'recent_jobs']);
  assert.strictEqual(r.phone_norm, '919847001005');
  assert.deepStrictEqual(Demo.lookupCustomer(d, '9847001005'), r, 'every shape of the number finds the same customer');
  assert.deepStrictEqual(Demo.lookupCustomer(d, '09847001005'), r);
  assert.strictEqual(r.customer.name, 'Vishnu P');
  assert.strictEqual(r.open_jobs.length, 1);
  assert.strictEqual(r.open_jobs[0].stage, 'at_vendor');
  assert.strictEqual(r.jobs_total, 1);
  assert.strictEqual(r.open_rma.length, 2);
  assert.strictEqual(r.past_techs[0].name, 'Athul Sudheer');
  assert.ok(!('serial' in r.open_rma[0]), 'no serials in the lookup');
  var owner = Demo.lookupCustomer(d, '9847001021');
  assert.strictEqual(owner.open_rma.length, 1, 'an end customer finds their part by their own phone');
  var sender = Demo.lookupCustomer(d, '9847001020');
  assert.strictEqual(sender.open_rma.length, 0, 'tracking phone is the owner when one is set');
  var none = Demo.lookupCustomer(d, '9999999999');
  assert.strictEqual(none.customer, null);
  assert.strictEqual(none.jobs_total, 0);
  var short = Demo.lookupCustomer(d, '98470');
  assert.deepStrictEqual(short, { phone_norm: '98470', customer: null, open_jobs: [], recent_jobs: [], jobs_total: 0, open_rma: [], past_techs: [] });
  assert.strictEqual(Demo.lookupCustomer(d, '98470012').customer, null, 'below 12 normalised digits is not looked up');
  // A1, exactly as SPEC-AMENDMENTS words it.
  assert.strictEqual(Demo.normPhone('9847001001'), '919847001001', '10 digits');
  assert.strictEqual(Demo.normPhone('09847001001'), '919847001001', '11 digits with a 0');
  assert.strictEqual(Demo.normPhone('919847001001'), '919847001001', '12 digits with 91');
  assert.strictEqual(Demo.normPhone('+91 98470 01001'), '919847001001');
  assert.strictEqual(Demo.normPhone('+971 50 123 4567'), '971501234567', 'a Gulf number keeps its country code');
  assert.strictEqual(Demo.normPhone('+966 55 123 4567'), '966551234567');
  assert.strictEqual(Demo.normPhone('+1 (555) 123-4567'), '15551234567', '11 digits, not starting with 0');
  assert.strictEqual(Demo.normPhone('12345'), '12345', 'short stays short');
  assert.strictEqual(Demo.normPhone(null), '');
  // A1': a leading 00 is the dialling prefix.
  assert.strictEqual(Demo.normPhone('0091 98470 01001'), '919847001001', '0091');
  assert.strictEqual(Demo.normPhone('00971501234567'), '971501234567', '00971');
  assert.deepStrictEqual(Demo.lookupCustomer(d, '0091 98470 01005'), r, '0091 finds the same customer');
});

test("lookupCustomer looks up exactly what phone_ok() accepts (A1')", function () {
  function data(phoneNorm) {
    return { customers: [{ id: 'demo_cu_x', phone_norm: phoneNorm, name: 'X' }], jobs: [], units: [], intakes: [] };
  }
  assert.strictEqual(Demo.lookupCustomer(data('97455123456'), '+974 5512 3456').customer.name, 'X',
    'an 11-digit Qatar number is looked up');
  assert.strictEqual(Demo.lookupCustomer(data('97455123456'), '00974 5512 3456').customer.name, 'X');
  assert.strictEqual(Demo.lookupCustomer(data('971501234567'), '00971501234567').customer.name, 'X',
    '00971 is the same customer as +971');
  var typo = Demo.lookupCustomer(data('98470123456'), '98470123456');
  assert.strictEqual(typo.customer, null, 'an 11-digit Indian typo is never looked up');
  assert.strictEqual(typo.phone_norm, '98470123456');
  assert.strictEqual(Demo.lookupCustomer(data('15551234567'), '+1 555 123 4567').customer, null,
    '11 digits outside Kuwait / Oman / Bahrain / Qatar');
});

test("the demo's phone rule is the catalogue's, and its own copy is identical", function () {
  var fs = require('fs');
  var vm = require('vm');
  var src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'service-demo.js'), 'utf8');
  function load(win) {
    var ctx = vm.createContext(win);
    win.window = win;
    vm.runInContext(src, ctx, { filename: 'service-demo.js' });
    return win.NeoQcDemo;
  }
  // In a page with the catalogue loaded, the demo asks the catalogue.
  var spy = load({ NeoQcCatalog: { normPhone: function () { return 'from-catalog'; }, phoneOk: function () { return 'ok-from-catalog'; } } });
  assert.strictEqual(spy.normPhone('9847001001'), 'from-catalog');
  assert.strictEqual(spy.phoneOk('919847001001'), 'ok-from-catalog');
  // Without it (no window.NeoQcCatalog, no require), the inline copy runs and
  // must give the catalogue's answers.
  var bare = load({});
  var inputs = ['9847012345', '098470 12345', '+91 98470 12345', '0091 98470 12345', '919847012345', '+971 50 123 4567',
                '00971501234567', '+974 5512 3456', '00974 5512 3456', '+965 5512 3456', '+968 9123 4567', '+973 3612 3456',
                '98470123456', '+1 (555) 123-4567', '+44 7700 900123', '123456789012345', '1234567890123456', '12345',
                '00', '000', '0009847012345', '009847012345', '', null, undefined, 9847012345];
  for (var i = 0; i < 400; i++) {             // and a spread of digit strings of every length
    var len = 1 + (i % 17), s = (i % 3 === 0 ? '00' : i % 3 === 1 ? '0' : '');
    for (var k = 0; k < len; k++) s += String((i * 7 + k * 13) % 10);
    inputs.push(s);
  }
  inputs.forEach(function (p) {
    assert.strictEqual(bare.normPhone(p), C.normPhone(p), 'normPhone ' + JSON.stringify(p));
    assert.strictEqual(bare.phoneOk(bare.normPhone(p)), C.isValidPhone(p), 'phoneOk(normPhone ' + JSON.stringify(p) + ')');
    assert.strictEqual(bare.phoneOk(p), C.phoneOk(p), 'phoneOk ' + JSON.stringify(p));
  });
  // Under node (this file's own require), the catalogue answers.
  assert.strictEqual(Demo.normPhone('0091 98470 01001'), C.normPhone('0091 98470 01001'));
  assert.strictEqual(Demo.phoneOk('97455123456'), true);
  assert.strictEqual(Demo.phoneOk('98470123456'), false);
});

test('v2.1: the demo shows a password on file, and only the flag', function () {
  var on = d.jobs.filter(function (j) { return j.has_device_password; });
  assert.ok(on.length >= 1, 'at least one open demo ticket has a password on file, so the Details row can be tried');
  // The flag only: nothing in the fixtures may look like a stored password.
  assert.ok(!/"secret"\s*:|"password"\s*:/i.test(JSON.stringify(d)), 'no password value in the demo data');
});

console.log((failures ? 'FAILED' : 'OK') + ' service-demo: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
