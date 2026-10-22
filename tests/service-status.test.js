/*
  Unit tests for shared/service-status.js (v2).
  Run: node tests/service-status.test.js   — exits 1 on any failure.

  The v1 rules are FROZEN below (copied from the v1.9.11 file) so "legacy
  behaviour unchanged" is checked against the real old code, not against a
  copy that sync-shared.js will later overwrite.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var S = require(path.join(__dirname, '..', 'shared', 'service-status.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var MIN = 60000, HOUR = 3600000, DAY = 86400000;
var NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();   // 21 Oct 2026, 12:00 local
function iso(ms) { return new Date(ms).toISOString(); }

// ── Frozen v1 (v1.9.11) model ──────────────────────────────────────────────
var V1 = (function () {
  var BALL = { SHOP: 'shop', CUSTOMER: 'customer', THIRD_PARTY: 'third_party', NOBODY: 'nobody' };
  var STAGES = {
    logged:           { staff: 'Logged — not in hand yet',      customer: 'We have your request',              ball: BALL.SHOP },
    received:         { staff: 'Received at counter',           customer: 'Your item is with us',              ball: BALL.SHOP },
    diagnosing:       { staff: 'Diagnosing',                    customer: "We're finding the fault",           ball: BALL.SHOP },
    quoted:           { staff: 'Quote sent — awaiting approval', customer: 'Waiting for your go-ahead on the quote', ball: BALL.CUSTOMER },
    approved:         { staff: 'Approved — queued for bench',   customer: 'Approved, queued for work',         ball: BALL.SHOP },
    parts_to_order:   { staff: 'Parts to order',                customer: "We're sourcing a part",             ball: BALL.SHOP },
    parts_on_order:   { staff: 'Parts on order',                customer: 'Waiting for a part to arrive',      ball: BALL.THIRD_PARTY },
    rma_raised:       { staff: 'RMA raised — not shipped yet',  customer: 'Warranty claim raised',             ball: BALL.SHOP },
    at_vendor:        { staff: 'At vendor',                     customer: 'With the manufacturer under warranty', ball: BALL.THIRD_PARTY },
    back_from_vendor: { staff: 'Back from vendor',              customer: 'The part is back with us',          ball: BALL.SHOP },
    in_service:       { staff: 'On the bench',                  customer: 'Being repaired',                    ball: BALL.SHOP },
    verifying:        { staff: 'Verifying / soak',              customer: 'Being tested before we return it',  ball: BALL.SHOP },
    ready:            { staff: 'Ready for collection',          customer: 'Ready to collect',                  ball: BALL.CUSTOMER },
    closed:           { staff: 'Closed',                        customer: null,                                ball: BALL.NOBODY }
  };
  var STAGE_ORDER = Object.keys(STAGES);
  var OUTCOMES = {
    repaired: 'Repaired and collected', unrepairable: 'Returned unrepaired', declined: 'Quote declined, item returned',
    no_fault_found: 'No fault found, item returned', replaced_under_warranty: 'Replaced under warranty', cancelled: 'Cancelled'
  };
  var JOB_KINDS = {
    repair_own: 'Repair — PC we built', repair_outside: 'Repair — outside machine',
    warranty_rma: 'Warranty / RMA', upgrade: 'Upgrade / paid service'
  };
  var STAGES_BY_KIND = {
    repair_own:     ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed'],
    repair_outside: ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed'],
    warranty_rma:   ['logged','received','diagnosing','rma_raised','at_vendor','back_from_vendor','quoted','verifying','ready','closed'],
    upgrade:        ['logged','received','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed']
  };
  var IDLE_BUDGET_DAYS = {
    logged: 1, received: 1, diagnosing: 2, quoted: 3, approved: 2, parts_to_order: 1, parts_on_order: 7,
    rma_raised: 1, at_vendor: 14, back_from_vendor: 1, in_service: 3, verifying: 1, ready: 3
  };
  var COLUMNS = [
    { key: 'intake',   label: 'Intake',           hint: 'Should be empty' },
    { key: 'shop',     label: 'On us',            hint: 'Grouped by technician' },
    { key: 'customer', label: 'On the customer',  hint: 'The phone list' },
    { key: 'third',    label: 'On a third party', hint: 'The chase list' },
    { key: 'closed',   label: 'Closed today',     hint: 'Empties overnight' }
  ];
  function stageDef(stage) { return STAGES[stage] || null; }
  function isKnownStage(stage) { return !!STAGES[stage]; }
  function ballOf(stage) { var d = STAGES[stage]; return d ? d.ball : BALL.SHOP; }
  function staffLabel(stage) { var d = STAGES[stage]; return d ? d.staff : (stage || 'Unknown'); }
  function customerLabel(job) {
    if (!job) return '';
    var d = STAGES[job.stage];
    if (!d) return 'In progress';
    if (job.stage === 'closed') return OUTCOMES[job.outcome] || 'Closed';
    return d.customer;
  }
  function nextStages(jobKind, stage) {
    var list = STAGES_BY_KIND[jobKind] || STAGES_BY_KIND.repair_outside;
    return list.filter(function (s) { return s !== stage; });
  }
  function boardColumnOf(job) {
    if (!job) return 'shop';
    var stage = job.stage;
    if (stage === 'closed') return 'closed';
    if (stage === 'logged' || stage === 'received') return 'intake';
    var ball = ballOf(stage);
    if (ball === BALL.CUSTOMER) return 'customer';
    if (ball === BALL.THIRD_PARTY) return 'third';
    return 'shop';
  }
  function _ms(v) {
    if (!v) return null;
    var t = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
    return isNaN(t) ? null : t;
  }
  function daysInStage(job, now) {
    var since = _ms(job && (job.stage_since || job.stageSince));
    if (since == null) return 0;
    return Math.max(0, ((now || Date.now()) - since) / DAY);
  }
  function ageDays(job, now) {
    var created = _ms(job && (job.created_at || job.createdAt));
    if (created == null) return 0;
    return Math.max(0, ((now || Date.now()) - created) / DAY);
  }
  function serviceRisk(job, now) {
    if (!job || job.stage === 'closed') return 0;
    var t = now || Date.now();
    var promised = _ms(job.promised_at || job.promisedAt);
    if (promised != null && promised <= t) return 2;
    var budget = IDLE_BUDGET_DAYS[job.stage];
    if (budget == null) return 0;
    var idle = daysInStage(job, t);
    if (idle >= budget) return 2;
    if (idle >= budget * 0.75) return 1;
    if (promised != null && promised - t <= DAY) return 1;
    return 0;
  }
  function waitingSentence(job) {
    if (!job) return '';
    if (job.stage === 'closed') return OUTCOMES[job.outcome] || 'Closed';
    var ball = ballOf(job.stage);
    var who = job.waiting_party || job.waitingParty;
    var label = customerLabel(job) || '';
    var selfCarrying = /^waiting\b/i.test(label);
    if (ball === BALL.CUSTOMER) return selfCarrying ? label : 'Waiting for you — ' + label.toLowerCase();
    if (ball === BALL.THIRD_PARTY) {
      var vendor = who || 'a supplier';
      return selfCarrying ? 'Waiting for ' + vendor : 'Waiting for ' + vendor + ' — ' + label.toLowerCase();
    }
    return 'With us — ' + label.toLowerCase();
  }
  return {
    BALL: BALL, STAGES: STAGES, STAGE_ORDER: STAGE_ORDER, OUTCOMES: OUTCOMES, JOB_KINDS: JOB_KINDS,
    STAGES_BY_KIND: STAGES_BY_KIND, IDLE_BUDGET_DAYS: IDLE_BUDGET_DAYS, COLUMNS: COLUMNS,
    stageDef: stageDef, isKnownStage: isKnownStage, ballOf: ballOf, staffLabel: staffLabel,
    customerLabel: customerLabel, nextStages: nextStages, boardColumnOf: boardColumnOf,
    daysInStage: daysInStage, ageDays: ageDays, serviceRisk: serviceRisk, waitingSentence: waitingSentence
  };
})();

var V1_STAGES = Object.keys(V1.STAGES);
var NEW_STAGES = ['scheduled', 'en_route', 'on_site', 'work_done', 'revisit_needed', 'session_booked', 'in_session', 'resolved'];
var ODD_STAGES = ['nonsense', '', undefined, null];

// ═══ 1. Legacy exports and behaviour ═══════════════════════════════════════

test('every v1 export still exists with the same type', function () {
  ['BALL', 'STAGES', 'STAGE_ORDER', 'OUTCOMES', 'JOB_KINDS', 'STAGES_BY_KIND', 'IDLE_BUDGET_DAYS', 'COLUMNS',
   'stageDef', 'isKnownStage', 'ballOf', 'staffLabel', 'customerLabel', 'nextStages', 'boardColumnOf',
   'daysInStage', 'ageDays', 'serviceRisk', 'waitingSentence'].forEach(function (k) {
    assert.ok(k in S, 'missing export ' + k);
    assert.strictEqual(typeof S[k], typeof V1[k], k + ' changed type');
  });
});

test('v1 constant tables are unchanged', function () {
  assert.deepStrictEqual(S.BALL, V1.BALL);
  assert.deepStrictEqual(S.JOB_KINDS, V1.JOB_KINDS);
  assert.deepStrictEqual(S.STAGES_BY_KIND, V1.STAGES_BY_KIND);
  assert.deepStrictEqual(S.IDLE_BUDGET_DAYS, V1.IDLE_BUDGET_DAYS);
  assert.deepStrictEqual(S.COLUMNS, V1.COLUMNS);
});

test('every v1 stage and outcome is unchanged; new ones are added', function () {
  V1_STAGES.forEach(function (k) { assert.deepStrictEqual(S.STAGES[k], V1.STAGES[k], 'stage ' + k); });
  Object.keys(V1.OUTCOMES).forEach(function (k) { assert.strictEqual(S.OUTCOMES[k], V1.OUTCOMES[k], 'outcome ' + k); });
  NEW_STAGES.forEach(function (k) { assert.ok(S.STAGES[k], 'new stage ' + k); });
  assert.strictEqual(S.OUTCOMES.resolved_on_site, 'Fixed during our visit');
  assert.strictEqual(S.OUTCOMES.resolved_remotely, 'Fixed remotely');
  assert.strictEqual(S.OUTCOMES.returned_rma_pending, 'Returned to you — your part is still under warranty claim');
  assert.strictEqual(Object.keys(S.STAGES).length, 22);
});

test('STAGE_ORDER keeps the v1 relative order, includes the new stages, ends with closed', function () {
  var filtered = S.STAGE_ORDER.filter(function (s) { return V1_STAGES.indexOf(s) !== -1; });
  assert.deepStrictEqual(filtered, V1.STAGE_ORDER);
  NEW_STAGES.forEach(function (s) { assert.ok(S.STAGE_ORDER.indexOf(s) !== -1, s); });
  assert.strictEqual(S.STAGE_ORDER[S.STAGE_ORDER.length - 1], 'closed');
  assert.deepStrictEqual(S.STAGE_ORDER, Object.keys(S.STAGES));
});

test('new stage labels and balls match the spec table', function () {
  var want = {
    scheduled:      ['Visit scheduled', 'Visit booked', 'shop'],
    en_route:       ['Technician en route', 'Our technician is on the way', 'shop'],
    on_site:        ['On site', 'Our technician is with you', 'shop'],
    work_done:      ['Work done — awaiting sign-off', 'Work done — tell us if anything is still wrong', 'customer'],
    revisit_needed: ['Revisit needed', 'A follow-up visit is needed', 'shop'],
    session_booked: ['Remote session booked', 'Remote session booked', 'shop'],
    in_session:     ['In remote session', 'Remote session in progress', 'shop'],
    resolved:       ['Resolved remotely — confirming', 'Fixed remotely — tell us if anything is still wrong', 'customer']
  };
  Object.keys(want).forEach(function (k) {
    assert.deepStrictEqual([S.STAGES[k].staff, S.STAGES[k].customer, S.STAGES[k].ball], want[k], k);
  });
});

test('stageDef / isKnownStage / ballOf / staffLabel identical for v1 and odd stages', function () {
  V1_STAGES.concat(ODD_STAGES).forEach(function (s) {
    assert.deepStrictEqual(S.stageDef(s), V1.stageDef(s), 'stageDef ' + s);
    assert.strictEqual(S.isKnownStage(s), V1.isKnownStage(s), 'isKnownStage ' + s);
    assert.strictEqual(S.ballOf(s), V1.ballOf(s), 'ballOf ' + s);
    assert.strictEqual(S.staffLabel(s), V1.staffLabel(s), 'staffLabel ' + s);
  });
  NEW_STAGES.forEach(function (s) { assert.strictEqual(S.isKnownStage(s), true, s); });
  assert.strictEqual(S.isKnownStage('toString'), false, 'prototype keys are not stages');
});

test('customerLabel identical for v1 stages and outcomes', function () {
  var outcomes = Object.keys(V1.OUTCOMES).concat([null, 'nonsense']);
  V1_STAGES.concat(ODD_STAGES).forEach(function (s) {
    outcomes.forEach(function (o) {
      var job = { stage: s, outcome: o };
      assert.strictEqual(S.customerLabel(job), V1.customerLabel(job), s + '/' + o);
    });
  });
  assert.strictEqual(S.customerLabel(null), V1.customerLabel(null));
  assert.strictEqual(S.customerLabel({ stage: 'closed', outcome: 'resolved_remotely' }), 'Fixed remotely');
});

test('nextStages identical for every kind and stage', function () {
  Object.keys(V1.JOB_KINDS).concat(['nonsense', undefined]).forEach(function (k) {
    V1_STAGES.concat(NEW_STAGES, ODD_STAGES).forEach(function (s) {
      assert.deepStrictEqual(S.nextStages(k, s), V1.nextStages(k, s), k + '/' + s);
    });
  });
});

test('boardColumnOf identical for v1 stages', function () {
  V1_STAGES.concat(ODD_STAGES).forEach(function (s) {
    assert.strictEqual(S.boardColumnOf({ stage: s }), V1.boardColumnOf({ stage: s }), s);
  });
  assert.strictEqual(S.boardColumnOf(null), V1.boardColumnOf(null));
  assert.strictEqual(S.boardColumnOf({ stage: 'work_done' }), 'customer');
  assert.strictEqual(S.boardColumnOf({ stage: 'en_route' }), 'shop');
});

test('daysInStage / ageDays identical (snake and camel case, bad dates)', function () {
  [iso(NOW - 3 * DAY), iso(NOW + DAY), 'garbage', null, new Date(NOW - 5 * HOUR)].forEach(function (v) {
    [{ stage_since: v, created_at: v }, { stageSince: v, createdAt: v }].forEach(function (job) {
      assert.strictEqual(S.daysInStage(job, NOW), V1.daysInStage(job, NOW));
      assert.strictEqual(S.ageDays(job, NOW), V1.ageDays(job, NOW));
    });
  });
  assert.strictEqual(S.daysInStage(null, NOW), V1.daysInStage(null, NOW));
});

test('serviceRisk on a job without service_type is exactly the v1 answer (full grid)', function () {
  var promises = [undefined, iso(NOW - HOUR), iso(NOW + 6 * HOUR), iso(NOW + 2 * DAY), iso(NOW), 'garbage'];
  var count = 0;
  V1_STAGES.concat(NEW_STAGES, ['nonsense']).forEach(function (s) {
    var b = V1.IDLE_BUDGET_DAYS[s] || 1;
    [0, 0.1, 0.5, 0.74, 0.75, 0.76, 0.999, 1, 1.5, 3].forEach(function (f) {
      promises.forEach(function (p) {
        var job = { stage: s, stage_since: iso(NOW - f * b * DAY), promised_at: p };
        assert.strictEqual(S.serviceRisk(job, NOW), V1.serviceRisk(job, NOW), JSON.stringify(job));
        var camel = { stage: s, stageSince: iso(NOW - f * b * DAY), promisedAt: p };
        assert.strictEqual(S.serviceRisk(camel, NOW), V1.serviceRisk(camel, NOW), JSON.stringify(camel));
        // model_version alone does not change a job without service_type.
        var mv = { stage: s, stage_since: job.stage_since, promised_at: p, model_version: 1 };
        assert.strictEqual(S.serviceRisk(mv, NOW), V1.serviceRisk(mv, NOW));
        count++;
      });
    });
  });
  assert.strictEqual(S.serviceRisk(null, NOW), 0);
  assert.ok(count > 1000);
});

test('waitingSentence identical for v1 stages', function () {
  V1_STAGES.concat(['nonsense']).forEach(function (s) {
    [null, 'ASUS'].forEach(function (w) {
      [null, 'repaired', 'nonsense'].forEach(function (o) {
        var job = { stage: s, waiting_party: w, outcome: o };
        assert.strictEqual(S.waitingSentence(job), V1.waitingSentence(job), JSON.stringify(job));
        var camel = { stage: s, waitingParty: w, outcome: o };
        assert.strictEqual(S.waitingSentence(camel), V1.waitingSentence(camel));
      });
    });
  });
  assert.strictEqual(S.waitingSentence(null), '');
});

test('waitingSentence reads naturally for the new stages', function () {
  assert.strictEqual(S.waitingSentence({ stage: 'en_route' }), 'Our technician is on the way');
  assert.strictEqual(S.waitingSentence({ stage: 'scheduled' }), 'Visit booked');
  assert.strictEqual(S.waitingSentence({ stage: 'work_done' }), 'Work done — tell us if anything is still wrong');
  assert.strictEqual(S.waitingSentence({ stage: 'resolved' }), 'Fixed remotely — tell us if anything is still wrong');
  assert.strictEqual(S.waitingSentence({ stage: 'closed', outcome: 'resolved_on_site' }), 'Fixed during our visit');
});

// ═══ 2. Vocabulary ════════════════════════════════════════════════════════

test('vocabulary keys and labels match the spec', function () {
  assert.deepStrictEqual(S.TYPES, {
    in_store: { label: 'In-store', icon: 'store' }, on_site: { label: 'On-site', icon: 'pin' }, remote: { label: 'Remote', icon: 'remote' }
  });
  assert.deepStrictEqual(S.CHANNELS, { walk_in: 'Walk-in', phone: 'Phone', whatsapp: 'WhatsApp', website: 'Website', courier: 'Courier', staff: 'Staff' });
  assert.deepStrictEqual(Object.keys(S.CATEGORIES), ['repair', 'warranty_claim', 'upgrade', 'installation', 'data_recovery',
    'os_software', 'networking', 'maintenance', 'diagnosis_only']);
  assert.deepStrictEqual(Object.keys(S.CATEGORIES).map(function (k) { return S.CATEGORIES[k]; }),
    ['Repair', 'Warranty claim', 'Upgrade', 'Installation', 'Data recovery', 'OS / software', 'Networking', 'Maintenance', 'Diagnosis only']);
  assert.deepStrictEqual(S.PRIORITIES, { low: { label: 'Low', rank: 0 }, normal: { label: 'Normal', rank: 1 },
    high: { label: 'High', rank: 2 }, urgent: { label: 'Urgent', rank: 3 } });
  assert.deepStrictEqual(Object.keys(S.ITEM_KINDS), ['pc', 'laptop', 'gpu', 'psu', 'ram', 'ssd', 'hdd', 'motherboard', 'cpu',
    'cooler', 'monitor', 'peripheral', 'other']);
  assert.deepStrictEqual(Object.keys(S.ITEM_KINDS).map(function (k) { return S.ITEM_KINDS[k]; }),
    ['Desktop PC', 'Laptop', 'Graphics card', 'Power supply', 'RAM', 'SSD', 'Hard drive', 'Motherboard', 'Processor', 'Cooler',
     'Monitor', 'Peripheral', 'Other']);
  assert.deepStrictEqual(S.PURCHASE_SOURCES, { neo_tokyo: 'Neo Tokyo', elsewhere: 'Bought elsewhere', unknown: 'Not sure' });
  assert.deepStrictEqual(S.MIRROR_STAGES, ['rma_raised', 'at_vendor', 'back_from_vendor']);
  assert.deepStrictEqual(S.PRIVATE_MEDIA_ROLES, ['invoice', 'serial_label', 'vendor_doc']);
});

// ═══ 3. Type tracks ══════════════════════════════════════════════════════

var SPEC_TRACKS = {
  in_store: ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','rma_raised','at_vendor',
             'back_from_vendor','in_service','verifying','ready','closed'],
  on_site:  ['logged','scheduled','en_route','on_site','work_done','revisit_needed','quoted','approved','parts_to_order',
             'parts_on_order','rma_raised','at_vendor','back_from_vendor','closed'],
  remote:   ['logged','session_booked','in_session','resolved','quoted','closed']
};
var SPEC_BUDGETS = {
  in_store: { logged: 1, received: 1, diagnosing: 2, quoted: 3, approved: 2, parts_to_order: 1, parts_on_order: 7, rma_raised: 1,
              at_vendor: 14, back_from_vendor: 1, in_service: 3, verifying: 1, ready: 3, closed: null },
  on_site:  { logged: 0.5, scheduled: null, en_route: null, on_site: 0.5, work_done: 2, revisit_needed: 1, quoted: 3, approved: 2,
              parts_to_order: 1, parts_on_order: 7, rma_raised: 1, at_vendor: 14, back_from_vendor: 1, closed: null },
  remote:   { logged: 0.1667, session_booked: null, in_session: 0.125, resolved: 1, quoted: 3, closed: null }
};

test('STAGES_BY_TYPE is exactly the spec, every stage known, closed last', function () {
  assert.deepStrictEqual(S.STAGES_BY_TYPE, SPEC_TRACKS);
  Object.keys(SPEC_TRACKS).forEach(function (t) {
    SPEC_TRACKS[t].forEach(function (s) { assert.ok(S.isKnownStage(s), t + '/' + s); });
    assert.strictEqual(SPEC_TRACKS[t][SPEC_TRACKS[t].length - 1], 'closed');
    assert.ok(S.stageLegalFor(t, 'logged'));
  });
  assert.strictEqual(S.stageLegalFor('remote', 'ready'), false);
  assert.strictEqual(S.stageLegalFor('on_site', 'ready'), false);
  assert.strictEqual(S.stageLegalFor('nonsense', 'logged'), false);
});

test('budgetDays matches the spec for every stage of every type', function () {
  Object.keys(SPEC_BUDGETS).forEach(function (t) {
    Object.keys(SPEC_BUDGETS[t]).forEach(function (s) {
      assert.strictEqual(S.budgetDays(t, s), SPEC_BUDGETS[t][s], t + '/' + s);
    });
  });
  assert.strictEqual(S.budgetDays('in_store', 'scheduled'), null, 'stage outside the type');
  assert.strictEqual(S.budgetDays('nonsense', 'quoted'), 3, 'unknown type reads as in-store');
  assert.strictEqual(S.budgetDays('remote', 'toString'), null);
});

test('nextStagesFor a v2 ticket: its track minus mirror stages minus current, for every stage', function () {
  Object.keys(SPEC_TRACKS).forEach(function (t) {
    SPEC_TRACKS[t].forEach(function (cur) {
      var list = S.nextStagesFor({ model_version: 2, service_type: t, stage: cur, job_kind: 'warranty_rma' });
      var want = SPEC_TRACKS[t].filter(function (s) { return s !== cur && S.MIRROR_STAGES.indexOf(s) === -1; });
      assert.deepStrictEqual(list, want, t + '/' + cur);
      S.MIRROR_STAGES.forEach(function (m) { assert.strictEqual(list.indexOf(m), -1, 'mirror ' + m + ' offered on ' + t); });
      list.forEach(function (s) { assert.ok(S.stageLegalFor(t, s)); });
    });
  });
  // A v2 ticket currently IN a mirror stage still cannot be moved into another one by hand.
  var m = S.nextStagesFor({ model_version: 2, service_type: 'in_store', stage: 'at_vendor' });
  assert.strictEqual(m.indexOf('rma_raised'), -1);
  assert.strictEqual(m.indexOf('back_from_vendor'), -1);
  assert.ok(m.indexOf('in_service') !== -1);
});

test('nextStagesFor a v1 ticket is the old per-kind list (mirror stages kept)', function () {
  Object.keys(V1.JOB_KINDS).forEach(function (k) {
    V1_STAGES.forEach(function (s) {
      [{ stage: s, job_kind: k }, { stage: s, job_kind: k, model_version: 1, service_type: 'in_store' }].forEach(function (job) {
        assert.deepStrictEqual(S.nextStagesFor(job), V1.nextStages(k, s), k + '/' + s);
      });
    });
  });
  assert.ok(S.nextStagesFor({ stage: 'diagnosing', job_kind: 'warranty_rma', model_version: 1 }).indexOf('rma_raised') !== -1);
  assert.deepStrictEqual(S.nextStagesFor(null), []);
});

test('typeOf / isV2 / isTerminal / isMirrorStage', function () {
  assert.strictEqual(S.typeOf({}), 'in_store');
  assert.strictEqual(S.typeOf(null), 'in_store');
  assert.strictEqual(S.typeOf({ service_type: 'remote' }), 'remote');
  assert.strictEqual(S.typeOf({ service_type: 'toString' }), 'in_store');
  assert.strictEqual(S.isV2({ model_version: 2 }), true);
  assert.strictEqual(S.isV2({ model_version: '2' }), true);
  assert.strictEqual(S.isV2({ model_version: 1 }), false);
  assert.strictEqual(S.isV2({}), false);
  assert.strictEqual(S.isV2(null), false);
  assert.strictEqual(S.isTerminal('ready'), true);
  assert.strictEqual(S.isTerminal('closed'), true);
  assert.strictEqual(S.isTerminal('work_done'), false);
  assert.strictEqual(S.isMirrorStage('at_vendor'), true);
  assert.strictEqual(S.isMirrorStage('parts_on_order'), false);
});

test('outcomesFor offers every outcome key and leads with the type-specific one', function () {
  assert.deepStrictEqual(S.outcomesFor({ stage: 'ready' }), Object.keys(S.OUTCOMES));
  assert.strictEqual(S.outcomesFor({ service_type: 'on_site' })[0], 'resolved_on_site');
  assert.strictEqual(S.outcomesFor({ service_type: 'remote' })[0], 'resolved_remotely');
  ['in_store', 'on_site', 'remote'].forEach(function (t) {
    S.outcomesFor({ service_type: t }).forEach(function (o) { assert.ok(S.OUTCOMES[o], t + '/' + o); });
  });
});

// ═══ 4. Risk: visit rule, typed budgets, promises ═════════════════════════

test('visit rule: before, during and after the booked time', function () {
  var start = NOW;
  function job(stage) { return { service_type: 'on_site', stage: stage, visit_start: iso(start) }; }
  assert.strictEqual(S.visitRisk(job('scheduled'), start - 2 * HOUR), 0, 'well before');
  assert.strictEqual(S.visitRisk(job('scheduled'), start - 61 * MIN), 0, 'just over an hour before');
  assert.strictEqual(S.visitRisk(job('scheduled'), start - 60 * MIN), 1, 'an hour before: should be leaving');
  assert.strictEqual(S.visitRisk(job('scheduled'), start - 10 * MIN), 1);
  assert.strictEqual(S.visitRisk(job('scheduled'), start + 30 * MIN), 1, 'exactly 30 min is not late yet');
  assert.strictEqual(S.visitRisk(job('scheduled'), start + 31 * MIN), 2, 'late');
  assert.strictEqual(S.visitRisk(job('en_route'), start - 30 * MIN), 0, 'already left: not a risk');
  assert.strictEqual(S.visitRisk(job('en_route'), start + 31 * MIN), 2, 'still on the road');
  assert.strictEqual(S.visitRisk(job('on_site'), start + 3 * HOUR), 0, 'arrived: the visit rule is done');
  var rem = { service_type: 'remote', stage: 'session_booked', visit_start: iso(start) };
  assert.strictEqual(S.visitRisk(rem, start - 30 * MIN), 0, 'remote has no should-be-leaving warning');
  assert.strictEqual(S.visitRisk(rem, start + 31 * MIN), 2);
  assert.strictEqual(S.visitRisk({ stage: 'scheduled' }, NOW), 0, 'no visit time');
  assert.strictEqual(S.visitRisk(null, NOW), 0);
});

test('serviceRisk uses the visit rule, and half a day when no time is booked', function () {
  var start = NOW + 3 * HOUR;
  var booked = { service_type: 'on_site', model_version: 2, stage: 'scheduled', stage_since: iso(NOW - 10 * DAY), visit_start: iso(start) };
  assert.strictEqual(S.serviceRisk(booked, NOW), 0, 'idle days do not count while a time is booked');
  assert.strictEqual(S.serviceRisk(booked, start - 30 * MIN), 1);
  assert.strictEqual(S.serviceRisk(booked, start + 45 * MIN), 2);
  function unbooked(idleDays) {
    return { service_type: 'on_site', stage: 'scheduled', stage_since: iso(NOW - idleDays * DAY) };
  }
  assert.strictEqual(S.serviceRisk(unbooked(0.1), NOW), 0);
  assert.strictEqual(S.serviceRisk(unbooked(0.4), NOW), 1);
  assert.strictEqual(S.serviceRisk(unbooked(0.6), NOW), 2);
  var sess = { service_type: 'remote', stage: 'session_booked', stage_since: iso(NOW - 0.6 * DAY) };
  assert.strictEqual(S.serviceRisk(sess, NOW), 2);
});

test('a broken promise outranks everything except a done stage', function () {
  var past = iso(NOW - HOUR);
  assert.strictEqual(S.serviceRisk({ service_type: 'on_site', stage: 'scheduled', visit_start: iso(NOW + 5 * HOUR),
                                     stage_since: iso(NOW), promised_at: past }, NOW), 2);
  assert.strictEqual(S.serviceRisk({ service_type: 'in_store', stage: 'diagnosing', stage_since: iso(NOW), promised_at: past }, NOW), 2);
  ['ready', 'work_done', 'resolved'].forEach(function (s) {
    var j = { service_type: s === 'resolved' ? 'remote' : (s === 'ready' ? 'in_store' : 'on_site'), stage: s,
              stage_since: iso(NOW - 0.1 * DAY), promised_at: past };
    assert.strictEqual(S.serviceRisk(j, NOW), 0, s + ': the shop is done, the promise no longer applies');
  });
  // ...while the v1 rule (no service_type) still flags a ready job with a passed promise.
  assert.strictEqual(S.serviceRisk({ stage: 'ready', stage_since: iso(NOW), promised_at: past }, NOW), 2);
  assert.strictEqual(S.serviceRisk({ service_type: 'in_store', stage: 'closed', promised_at: past }, NOW), 0);
});

test('typed idle budgets: on-site, remote, and the near-promise nudge', function () {
  function j(type, stage, idleHours, extra) {
    var o = { service_type: type, model_version: 2, stage: stage, stage_since: iso(NOW - idleHours * HOUR) };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  assert.strictEqual(S.serviceRisk(j('on_site', 'on_site', 8), NOW), 0);
  assert.strictEqual(S.serviceRisk(j('on_site', 'on_site', 9.5), NOW), 1);
  assert.strictEqual(S.serviceRisk(j('on_site', 'on_site', 12.5), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('on_site', 'work_done', 40), NOW), 1);
  assert.strictEqual(S.serviceRisk(j('on_site', 'work_done', 49), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('remote', 'logged', 2.9), NOW), 0);
  assert.strictEqual(S.serviceRisk(j('remote', 'logged', 3.1), NOW), 1);
  assert.strictEqual(S.serviceRisk(j('remote', 'logged', 4.1), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('remote', 'in_session', 1), NOW), 0);
  assert.strictEqual(S.serviceRisk(j('remote', 'in_session', 2.3), NOW), 1);
  assert.strictEqual(S.serviceRisk(j('remote', 'in_session', 3.1), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('in_store', 'at_vendor', 15 * 24), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('in_store', 'diagnosing', 2, { promised_at: iso(NOW + 20 * HOUR) }), NOW), 1);
  assert.strictEqual(S.serviceRisk(j('in_store', 'diagnosing', 2, { promised_at: iso(NOW + 30 * HOUR) }), NOW), 0);
  // A stage the type does not budget falls back to a table that does, instead of "never late".
  assert.strictEqual(S.serviceRisk(j('on_site', 'received', 30), NOW), 2);
  assert.strictEqual(S.serviceRisk(j('remote', 'nonsense', 1000), NOW), 0);
});

// ═══ 5. Queue ═════════════════════════════════════════════════════════════

test('inQueue: open and nobody has it', function () {
  assert.strictEqual(S.inQueue({ stage: 'logged', assignee_email: null }), true);
  assert.strictEqual(S.inQueue({ stage: 'logged', assignee_email: '' }), true);
  assert.strictEqual(S.inQueue({ stage: 'logged', assignee_email: 'a@b.c' }), false);
  assert.strictEqual(S.inQueue({ stage: 'closed', assignee_email: null }), false);
  assert.strictEqual(S.inQueue(null), false);
});

test('queueBudgetHours per priority and type', function () {
  function q(p, t) { return S.queueBudgetHours({ priority: p, service_type: t }); }
  ['in_store', 'on_site', 'remote'].forEach(function (t) {
    assert.strictEqual(q('urgent', t), 1);
    assert.strictEqual(q('high', t), 4);
    assert.strictEqual(q('low', t), 24);
  });
  assert.strictEqual(q('normal', 'in_store'), 4);
  assert.strictEqual(q('normal', 'on_site'), 8);
  assert.strictEqual(q('normal', 'remote'), 4);
  assert.strictEqual(q(undefined, 'on_site'), 8);
  assert.strictEqual(q('nonsense', 'remote'), 4);
  assert.strictEqual(S.queueBudgetHours(null), 4);
});

test('queueRisk: 75% soon, 100% late, queued_at falls back to created_at', function () {
  function q(hours, extra) {
    var o = { stage: 'logged', assignee_email: null, priority: 'normal', service_type: 'on_site', queued_at: iso(NOW - hours * HOUR) };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return S.queueRisk(o, NOW);
  }
  assert.strictEqual(q(5.9), 0);
  assert.strictEqual(q(6), 1);
  assert.strictEqual(q(7.9), 1);
  assert.strictEqual(q(8), 2);
  assert.strictEqual(q(0.8, { priority: 'urgent' }), 1);
  assert.strictEqual(q(1.2, { priority: 'urgent' }), 2);
  assert.strictEqual(q(30, { assignee_email: 'x@y.z' }), 0, 'claimed');
  assert.strictEqual(q(30, { stage: 'closed' }), 0, 'closed');
  assert.strictEqual(S.queueRisk({ stage: 'logged', priority: 'high', created_at: iso(NOW - 5 * HOUR) }, NOW), 2, 'created_at fallback');
  assert.strictEqual(S.queueRisk({ stage: 'logged' }, NOW), 0, 'no timestamps');
});

test('conversionTarget follows §2.9 and always lands on a legal stage', function () {
  assert.strictEqual(S.conversionTarget('remote', 'in_store'), 'logged');
  assert.strictEqual(S.conversionTarget('remote', 'on_site'), 'logged');
  assert.strictEqual(S.conversionTarget('on_site', 'in_store'), 'received');
  assert.strictEqual(S.conversionTarget('in_store', 'on_site'), 'logged');
  assert.strictEqual(S.conversionTarget('in_store', 'remote'), 'logged');
  assert.strictEqual(S.conversionTarget('on_site', 'remote'), 'logged');
  assert.strictEqual(S.conversionTarget('in_store', 'in_store'), null);
  assert.strictEqual(S.conversionTarget('in_store', 'nonsense'), null);
  assert.strictEqual(S.conversionTarget(undefined, 'remote'), null);
  ['in_store', 'on_site', 'remote'].forEach(function (a) {
    ['in_store', 'on_site', 'remote'].forEach(function (b) {
      if (a === b) return;
      assert.ok(S.stageLegalFor(b, S.conversionTarget(a, b)), a + '>' + b);
    });
  });
});

// ═══ 6. RMA model ═════════════════════════════════════════════════════════

// SPEC §1.4 plus the amendments: A8 (with_tech) and A10 (with_vendor → returning).
var SPEC_RMA = {
  logged:            ['received', 'closed'],
  with_tech:         ['received', 'ready_to_ship', 'closed'],
  received:          ['testing', 'awaiting_docs', 'ready_to_ship', 'customer_decision', 'ready_to_return'],
  testing:           ['awaiting_docs', 'ready_to_ship', 'customer_decision', 'ready_to_return'],
  awaiting_docs:     ['testing', 'ready_to_ship', 'customer_decision', 'ready_to_return'],
  ready_to_ship:     ['with_vendor', 'testing', 'awaiting_docs', 'ready_to_return'],
  with_vendor:       ['back_from_vendor', 'customer_decision', 'returning'],
  back_from_vendor:  ['testing', 'customer_decision', 'ready_to_return', 'closed'],
  customer_decision: ['ready_to_ship', 'ready_to_return', 'closed'],
  ready_to_return:   ['returning', 'closed'],
  returning:         ['closed'],
  closed:            []
};

test('RMA stages, order, labels and balls match the spec', function () {
  assert.deepStrictEqual(S.RMA_ORDER, Object.keys(SPEC_RMA));
  var want = {
    logged: ['Expected — not in hand', "We're expecting your part", 'customer'],
    with_tech: ['With our technician', 'Your part is with our technician', 'shop'],
    received: ['Received', 'Your part is with us', 'shop'],
    testing: ['Testing', "We're checking the part", 'shop'],
    awaiting_docs: ['Waiting on documents / approval', 'Waiting for you — we need a document or your approval', 'customer'],
    ready_to_ship: ['Ready to ship to vendor', 'Warranty claim being prepared', 'shop'],
    with_vendor: ['With vendor', 'With the manufacturer under warranty', 'third_party'],
    back_from_vendor: ['Back from vendor', 'Back from the manufacturer', 'shop'],
    customer_decision: ['Waiting on customer decision', 'Waiting for your decision', 'customer'],
    returning: ['Returning by courier', 'On its way back to you', 'third_party']
  };
  Object.keys(want).forEach(function (k) {
    var d = S.RMA_STAGES[k];
    assert.deepStrictEqual([d.staff, d.customer, d.ball], want[k], k);
    assert.strictEqual(S.rmaStaffLabel(k), want[k][0]);
    assert.strictEqual(S.rmaBallOf({ stage: k }), want[k][2]);
  });
  assert.strictEqual(S.rmaStaffLabel('ready_to_return'), 'Ready to return');
  assert.strictEqual(S.rmaBallOf({ stage: 'closed' }), 'nobody');
  assert.strictEqual(S.rmaStaffLabel('nonsense'), 'nonsense');
});

test('RMA_TRANSITIONS is exactly §1.4 and rmaTransitionOk mirrors it', function () {
  assert.deepStrictEqual(S.RMA_TRANSITIONS, SPEC_RMA);
  Object.keys(SPEC_RMA).forEach(function (from) {
    Object.keys(SPEC_RMA).forEach(function (to) {
      assert.strictEqual(S.rmaTransitionOk(from, to), SPEC_RMA[from].indexOf(to) !== -1, from + '>' + to);
    });
  });
  assert.strictEqual(S.rmaTransitionOk('nonsense', 'closed'), false);
});

test('rmaNextStages never offers with_vendor / back_from_vendor; rmaActions does', function () {
  Object.keys(SPEC_RMA).forEach(function (st) {
    var list = S.rmaNextStages({ stage: st });
    assert.strictEqual(list.indexOf('with_vendor'), -1, st);
    assert.strictEqual(list.indexOf('back_from_vendor'), -1, st);
    list.forEach(function (to) { assert.ok(S.rmaTransitionOk(st, to), st + '>' + to); });
  });
  assert.deepStrictEqual(S.rmaNextStages({ stage: 'with_vendor' }), [], 'lost goes through the vendor-result action');
  assert.deepStrictEqual(S.rmaNextStages({ stage: 'ready_to_ship' }), ['testing', 'awaiting_docs', 'ready_to_return']);
  assert.deepStrictEqual(S.rmaNextStages({ stage: 'logged' }), ['received', 'closed']);
  assert.deepStrictEqual(S.rmaNextStages({ stage: 'with_tech' }), ['received', 'ready_to_ship', 'closed'], 'A8');
  assert.deepStrictEqual(S.rmaNextStages('back_from_vendor'), ['testing', 'customer_decision', 'ready_to_return', 'closed']);
  assert.deepStrictEqual(S.rmaActions({ stage: 'with_tech' }), []);
  assert.deepStrictEqual(S.rmaActions({ stage: 'ready_to_ship' }), ['dispatch']);
  assert.deepStrictEqual(S.rmaActions({ stage: 'with_vendor' }), ['vendor_result']);
  assert.deepStrictEqual(S.rmaActions({ stage: 'testing' }), []);
  assert.deepStrictEqual(S.rmaNextStages(null), []);
});

test('ready_to_return ball, label and budget depend on return_method', function () {
  function u(m) { return { stage: 'ready_to_return', return_method: m }; }
  assert.strictEqual(S.rmaBallOf(u('collect')), 'customer');
  assert.strictEqual(S.rmaBallOf(u('courier')), 'shop');
  assert.strictEqual(S.rmaBallOf(u('with_device')), 'shop');
  assert.strictEqual(S.rmaBallOf(u(undefined)), 'customer', 'column default is collect');
  assert.strictEqual(S.rmaCustomerLabel(u('collect')), 'Ready to collect');
  assert.strictEqual(S.rmaCustomerLabel(u('courier')), 'Being packed for return');
  assert.strictEqual(S.rmaCustomerLabel(u('with_device')), 'Being fitted back in your device');
  assert.strictEqual(S.rmaBudgetDays(u('collect')), 5);
  assert.strictEqual(S.rmaBudgetDays(u('courier')), 1);
  assert.strictEqual(S.rmaBudgetDays(u('with_device')), 1);
  assert.strictEqual(S.rmaColumnOf(u('collect')), 'customer');
  assert.strictEqual(S.rmaColumnOf(u('courier')), 'shop');
});

test('rmaCustomerLabel for closed comes from the disposition', function () {
  Object.keys(S.RMA_DISPOSITIONS).forEach(function (d) {
    assert.strictEqual(S.rmaCustomerLabel({ stage: 'closed', disposition: d }), S.RMA_DISPOSITIONS[d]);
  });
  assert.strictEqual(S.rmaCustomerLabel({ stage: 'closed' }), 'Closed');
  assert.strictEqual(S.RMA_DISPOSITIONS.lost_compensated, 'Settled for a lost part');
  assert.strictEqual(S.RMA_DISPOSITIONS.refitted, 'Fitted back in your device');
  assert.strictEqual(Object.keys(S.RMA_DISPOSITIONS).length, 12);
  assert.strictEqual(S.rmaCustomerLabel({ stage: 'nonsense' }), 'In progress');
  assert.strictEqual(S.rmaCustomerLabel(null), '');
});

test('RMA vocab tables carry exactly the spec keys (plus A9, A10, A11)', function () {
  assert.deepStrictEqual(Object.keys(S.RMA_VENDOR_RESULTS), ['replaced', 'repaired', 'credit_note', 'rejected', 'lost', 'shipped_to_customer']);
  assert.deepStrictEqual(S.DATA_HANDLING, {
    wiped_by_us: 'We wiped it',
    customer_consents: 'Customer agreed to send it with data',
    unreadable_informed: 'Drive unreadable — customer informed'
  });
  assert.deepStrictEqual(S.DATA_HANDLING_KINDS, ['ssd', 'hdd']);
  assert.ok(S.needsDataHandling('ssd') && S.needsDataHandling('hdd') && !S.needsDataHandling('gpu') && !S.needsDataHandling(null));
  assert.deepStrictEqual(Object.keys(S.SHIPMENT_MODES), ['courier', 'hand_delivery', 'vendor_pickup', 'bus_parcel']);
  assert.deepStrictEqual(Object.keys(S.VENDOR_KINDS), ['brand', 'distributor', 'service_centre']);
  assert.deepStrictEqual(S.RMA_PRE_RETURN, ['with_tech', 'logged', 'received', 'testing', 'awaiting_docs', 'ready_to_ship', 'with_vendor'], 'A2');
  assert.deepStrictEqual(Object.keys(S.FEE_STATUSES), ['n_a', 'quoted', 'accepted', 'paid', 'waived']);
  assert.deepStrictEqual(Object.keys(S.RMA_SOURCES), ['from_ticket', 'walk_in', 'courier', 'field', 'stock', 'website']);
  assert.deepStrictEqual(Object.keys(S.SENDER_KINDS), ['customer', 'third_party_tech', 'our_tech', 'shop']);
  assert.deepStrictEqual(Object.keys(S.RETURN_METHODS), ['collect', 'courier', 'with_device']);
  assert.deepStrictEqual(Object.keys(S.DIAGNOSED_BY), ['us', 'third_party', 'customer']);
  assert.deepStrictEqual(S.RMA_COLUMNS.map(function (c) { return c.key; }), S.COLUMNS.map(function (c) { return c.key; }));
  assert.strictEqual(S.RMA_COLUMNS[0].label, 'Just in');
});

test('rmaColumnOf puts every stage in one of the five lanes', function () {
  var lanes = S.RMA_COLUMNS.map(function (c) { return c.key; });
  var want = { logged: 'intake', with_tech: 'intake', received: 'intake', testing: 'shop', awaiting_docs: 'customer', ready_to_ship: 'shop',
               with_vendor: 'third', back_from_vendor: 'shop', customer_decision: 'customer', returning: 'third', closed: 'closed' };
  Object.keys(want).forEach(function (st) {
    assert.strictEqual(S.rmaColumnOf({ stage: st }), want[st], st);
    assert.ok(lanes.indexOf(S.rmaColumnOf({ stage: st })) !== -1);
  });
});

test('rmaBudgetDays and rmaRisk (idle, vendor TAT, expected date)', function () {
  var budgets = { logged: 3, with_tech: 1, received: 1, testing: 2, awaiting_docs: 3, ready_to_ship: 3, back_from_vendor: 1,
                  customer_decision: 3, returning: 4 };
  Object.keys(budgets).forEach(function (st) { assert.strictEqual(S.rmaBudgetDays({ stage: st }), budgets[st], st); });
  assert.strictEqual(S.rmaBudgetDays({ stage: 'with_vendor' }), 14);
  assert.strictEqual(S.rmaBudgetDays({ stage: 'with_vendor' }, { typical_tat_days: 21 }), 21);
  assert.strictEqual(S.rmaBudgetDays({ stage: 'with_vendor' }, { typical_tat_days: 0 }), 14);
  assert.strictEqual(S.rmaBudgetDays({ stage: 'closed' }), null);

  function idle(st, days, extra) {
    var o = { stage: st, stage_since: iso(NOW - days * DAY) };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  assert.strictEqual(S.rmaRisk(idle('testing', 1), NOW), 0);
  assert.strictEqual(S.rmaRisk(idle('testing', 1.6), NOW), 1);
  assert.strictEqual(S.rmaRisk(idle('testing', 2), NOW), 2);
  assert.strictEqual(S.rmaRisk(idle('closed', 100), NOW), 0);
  // With a vendor and no expected date: the vendor's turnaround.
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 15), NOW), 2);
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 15), NOW, { typical_tat_days: 21 }), 0);
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 16), NOW, { typical_tat_days: 21 }), 1);
  // With an expected date: that date is the clock.
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 2, { expected_back_at: iso(NOW + 12 * DAY) }), NOW), 0);
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 11, { expected_back_at: iso(NOW + 3 * DAY) }), NOW), 1);
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 16, { expected_back_at: iso(NOW - 2 * DAY) }), NOW), 2);
  assert.strictEqual(S.rmaRisk(idle('with_vendor', 1, { expected_back_at: iso(NOW - 1) }), NOW), 2);
  assert.strictEqual(S.rmaRisk(null, NOW), 0);
});

test('rmaWaitingSentence names whose turn it is', function () {
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor', waiting_party: 'ASUS' }),
                     'Waiting for ASUS — with the manufacturer under warranty');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor' }, { public_name: 'Corsair' }),
                     'Waiting for Corsair — with the manufacturer under warranty');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor' }),
                     'Waiting for the manufacturer — with the manufacturer under warranty');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'awaiting_docs' }), 'Waiting for you — we need a document or your approval');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'customer_decision' }), 'Waiting for your decision');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'ready_to_return', return_method: 'collect' }), 'Waiting for you — ready to collect');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'ready_to_return', return_method: 'courier' }), 'With us — being packed for return');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'returning', return_courier: 'DTDC' }), 'Waiting for DTDC — on its way back to you');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'testing' }), "With us — we're checking the part");
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'closed', disposition: 'replaced' }), 'Replaced under warranty');
  assert.strictEqual(S.rmaWaitingSentence(null), '');
  // A8: the label already says who has it.
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_tech' }), 'Your part is with our technician');
  // A13: the part's brand, never a distributor's name.
  var dist = { name: 'Rashi Peripherals', public_name: 'Rashi Peripherals', kind: 'distributor' };
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor', brand: 'Zotac' }, dist),
                     'Waiting for Zotac — with the manufacturer under warranty');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor', brand: '  ' }, { public_name: 'ASUS' }),
                     'Waiting for ASUS — with the manufacturer under warranty', 'a blank brand falls back to the public name');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor' }, { name: 'Internal name only' }),
                     'Waiting for the manufacturer — with the manufacturer under warranty', 'vendor.name never reaches a customer');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'with_vendor', brand: 'Zotac', waiting_party: 'ZOTAC' }),
                     'Waiting for ZOTAC — with the manufacturer under warranty', "the server's waiting_party wins");
  assert.strictEqual(S.customerFacingMaker({ brand: 'Zotac' }, dist), 'Zotac');
  assert.strictEqual(S.customerFacingMaker({}, { public_name: 'Corsair', name: 'Corsair India' }), 'Corsair');
  assert.strictEqual(S.customerFacingMaker(null, null), '');
  // A10: shipped straight to the customer.
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'returning', vendor_result: 'shipped_to_customer', brand: 'ASUS' }),
                     'Waiting for ASUS — on its way back to you');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'returning', vendor_result: 'shipped_to_customer', brand: 'ASUS', return_courier: 'Blue Dart' }),
                     'Waiting for Blue Dart — on its way back to you');
  assert.strictEqual(S.rmaWaitingSentence({ stage: 'returning' }), 'Waiting for the courier — on its way back to you');
});

test('rmaGateProblems → ready_to_ship / with_vendor', function () {
  var bare = { stage: 'testing', purchase_source: 'unknown', fee_status: 'n_a' };
  var p = S.rmaGateProblems(bare, 'ready_to_ship', []);
  assert.strictEqual(p.length, 4, JSON.stringify(p));
  assert.ok(p.some(function (s) { return /serial number/i.test(s); }));
  assert.ok(p.some(function (s) { return /serial label/i.test(s); }));
  assert.ok(p.some(function (s) { return /where it was bought/i.test(s); }));
  assert.ok(p.some(function (s) { return /vendor/i.test(s); }));

  var ok = { stage: 'testing', serial: 'ABC123', purchase_source: 'neo_tokyo', vendor_id: 7, fee_status: 'n_a' };
  assert.deepStrictEqual(S.rmaGateProblems(ok, 'ready_to_ship', ['serial_label']), []);
  assert.deepStrictEqual(S.rmaGateProblems(ok, 'ready_to_ship', [{ role: 'serial_label' }]), [], 'media rows accepted');
  assert.deepStrictEqual(S.rmaGateProblems(ok, 'ready_to_ship', { serial_label: 2 }), [], 'role counts accepted');
  assert.deepStrictEqual(S.rmaGateProblems(ok, 'ready_to_ship', null), [], 'media not loaded: photo checks skipped');
  assert.strictEqual(S.rmaGateProblems(ok, 'ready_to_ship', []).length, 1, 'known empty media: photo missing');
  assert.strictEqual(S.rmaGateProblems({ stage: 'testing', serial: '   ', purchase_source: 'neo_tokyo', vendor_id: 7 },
                                       'ready_to_ship', ['serial_label']).length, 1, 'blank serial');

  var els = { stage: 'awaiting_docs', serial: 'X', purchase_source: 'elsewhere', vendor_id: 7, fee_status: 'quoted' };
  var pe = S.rmaGateProblems(els, 'ready_to_ship', ['serial_label']);
  assert.strictEqual(pe.length, 2, JSON.stringify(pe));
  assert.ok(pe.some(function (s) { return /invoice/i.test(s); }));
  assert.ok(pe.some(function (s) { return /not accepted/i.test(s); }));
  ['accepted', 'paid', 'waived'].forEach(function (f) {
    els.fee_status = f;
    assert.deepStrictEqual(S.rmaGateProblems(els, 'ready_to_ship', ['serial_label', 'invoice']), [], f);
  });
  els.fee_status = 'n_a';
  assert.ok(/quote the handling fee/i.test(S.rmaGateProblems(els, 'ready_to_ship', ['serial_label', 'invoice'])[0]));

  // Dispatch re-checks the same gates from ready_to_ship.
  var rts = { stage: 'ready_to_ship', serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 3 };
  assert.deepStrictEqual(S.rmaGateProblems(rts, 'with_vendor', ['serial_label']), []);
  assert.strictEqual(S.rmaGateProblems(rts, 'with_vendor', []).length, 1);
  assert.deepStrictEqual(S.rmaGateProblems(rts, 'ready_to_ship', ['serial_label']), [], 're-check in place');
  assert.strictEqual(S.rmaGateProblems({ stage: 'received', serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 3 },
                                       'with_vendor', ['serial_label']).length, 1, 'cannot dispatch from received');
});

test('A11: a drive ships only once its data handling is recorded', function () {
  ['ssd', 'hdd'].forEach(function (k) {
    var drive = { stage: 'testing', kind: k, serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 3 };
    var p = S.rmaGateProblems(drive, 'ready_to_ship', ['serial_label']);
    assert.strictEqual(p.length, 1, k);
    assert.ok(/data on the drive/i.test(p[0]), p[0]);
    Object.keys(S.DATA_HANDLING).forEach(function (dh) {
      assert.deepStrictEqual(S.rmaGateProblems(Object.assign({}, drive, { data_handling: dh }), 'ready_to_ship', ['serial_label']), [], k + ' ' + dh);
    });
    assert.strictEqual(S.rmaGateProblems(Object.assign({}, drive, { data_handling: 'nonsense' }), 'ready_to_ship', ['serial_label']).length, 1,
                       'an unknown value is not an answer');
    // Dispatch re-checks it.
    assert.strictEqual(S.rmaGateProblems(Object.assign({}, drive, { stage: 'ready_to_ship' }), 'with_vendor', ['serial_label']).length, 1);
  });
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'testing', kind: 'gpu', serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 3 },
                                           'ready_to_ship', ['serial_label']), [], 'not a drive');
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'testing', kind: 'ssd' }, 'awaiting_docs', []), [], 'only the shipping gate asks');
});

test('A12: a warranty-check screenshot counts as the invoice for a part bought elsewhere', function () {
  var els = { stage: 'awaiting_docs', kind: 'gpu', serial: 'X', purchase_source: 'elsewhere', vendor_id: 7, fee_status: 'accepted' };
  assert.deepStrictEqual(S.rmaGateProblems(els, 'ready_to_ship', ['serial_label', 'vendor_doc']), []);
  assert.deepStrictEqual(S.rmaGateProblems(els, 'ready_to_ship', ['serial_label', 'invoice']), []);
  var p = S.rmaGateProblems(els, 'ready_to_ship', ['serial_label']);
  assert.strictEqual(p.length, 1);
  assert.ok(/invoice \(or a warranty-check screenshot\)/.test(p[0]), p[0]);
  // The fee is still needed whatever the document.
  assert.strictEqual(S.rmaGateProblems(Object.assign({}, els, { fee_status: 'quoted' }), 'ready_to_ship',
                                       ['serial_label', 'vendor_doc']).length, 1);
});

test('A8 and A10 gates: with_tech moves, and the vendor shipping straight to the customer', function () {
  var wt = { stage: 'with_tech', kind: 'psu', serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 3 };
  assert.deepStrictEqual(S.rmaGateProblems(wt, 'received', []), [], 'bringing it in has no gate');
  assert.deepStrictEqual(S.rmaGateProblems(wt, 'ready_to_ship', ['serial_label']), [], 'hand delivery straight from the field');
  assert.strictEqual(S.rmaGateProblems(Object.assign({}, wt, { serial: '' }), 'ready_to_ship', ['serial_label']).length, 1,
                     'the shipping gates still apply');
  assert.deepStrictEqual(S.rmaGateProblems(Object.assign({}, wt, { disposition: 'withdrawn' }), 'closed'), []);
  assert.strictEqual(S.rmaGateProblems(Object.assign({}, wt, { disposition: 'replaced' }), 'closed').length, 1, 'withdrawn only');
  assert.ok(/cannot move/.test(S.rmaGateProblems(wt, 'testing')[0]));

  var shipped = { stage: 'with_vendor', vendor_result: 'shipped_to_customer' };
  assert.deepStrictEqual(S.rmaGateProblems(shipped, 'returning'), [], 'the vendor AWB is optional');
  assert.strictEqual(S.rmaGateProblems({ stage: 'with_vendor', vendor_result: 'replaced' }, 'returning').length, 1);
  assert.strictEqual(S.rmaGateProblems({ stage: 'with_vendor' }, 'returning').length, 1);
  assert.strictEqual(S.rmaGateProblems(shipped, 'back_from_vendor').length, 1, 'it does not come back to us');
  assert.strictEqual(S.rmaGateProblems({ stage: 'ready_to_return' }, 'returning').length, 1, 'our own return still needs the AWB');
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'returning', vendor_result: 'shipped_to_customer', disposition: 'replaced' }, 'closed'), []);
  assert.deepStrictEqual(S.rmaNextStages(shipped), [], 'the vendor result is an action, not a plain move');
});

test('rmaGateProblems → back_from_vendor / returning / closed, and illegal moves', function () {
  var wv = { stage: 'with_vendor' };
  assert.strictEqual(S.rmaGateProblems(wv, 'back_from_vendor').length, 1);
  assert.strictEqual(S.rmaGateProblems({ stage: 'with_vendor', vendor_result: 'replaced' }, 'back_from_vendor').length, 1);
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'with_vendor', vendor_result: 'replaced', replacement_serial: 'R1' }, 'back_from_vendor'), []);
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'with_vendor', vendor_result: 'rejected' }, 'back_from_vendor'), []);
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'with_vendor', vendor_result: 'lost' }, 'customer_decision'), []);

  assert.strictEqual(S.rmaGateProblems({ stage: 'ready_to_return' }, 'returning').length, 1);
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'ready_to_return', return_awb: 'AWB1' }, 'returning'), []);

  assert.strictEqual(S.rmaGateProblems({ stage: 'ready_to_return', fee_status: 'n_a' }, 'closed').length, 1, 'no disposition');
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'ready_to_return', fee_status: 'paid', disposition: 'replaced' }, 'closed'), []);
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'returning', disposition: 'repaired' }, 'closed'), [], 'fee defaults to n_a');
  ['quoted', 'accepted'].forEach(function (f) {
    var pr = S.rmaGateProblems({ stage: 'ready_to_return', fee_status: f, disposition: 'replaced' }, 'closed');
    assert.strictEqual(pr.length, 1, f);
    assert.ok(/fee/i.test(pr[0]));
  });
  assert.deepStrictEqual(S.rmaGateProblems({ stage: 'logged', disposition: 'withdrawn' }, 'closed'), []);
  assert.strictEqual(S.rmaGateProblems({ stage: 'logged', disposition: 'replaced' }, 'closed').length, 1);

  var bad = S.rmaGateProblems({ stage: 'received' }, 'closed');
  assert.strictEqual(bad.length, 1);
  assert.ok(/cannot move/i.test(bad[0]));
  assert.strictEqual(S.rmaGateProblems({ stage: 'closed' }, 'testing').length, 1);
  assert.strictEqual(S.rmaGateProblems(null, 'closed').length, 1);
});

test('rmaDispositionsFor leads with the likely ending and lists them all', function () {
  assert.deepStrictEqual(S.rmaDispositionsFor({ stage: 'logged' }), ['withdrawn']);
  assert.deepStrictEqual(S.rmaDispositionsFor({ stage: 'with_tech' }), ['withdrawn']);
  assert.deepStrictEqual(S.rmaDispositionsFor({ stage: 'returning', vendor_result: 'shipped_to_customer' }).slice(0, 2), ['replaced', 'repaired']);
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'ready_to_return', vendor_result: 'replaced', return_method: 'with_device' })[0], 'refitted');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'ready_to_return', vendor_result: 'replaced', return_method: 'collect' })[0], 'replaced');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'customer_decision', vendor_result: 'rejected' })[0], 'rejected_returned');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'customer_decision', vendor_result: 'lost' })[0], 'lost_compensated');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'with_vendor', advance_replacement: true })[0], 'restocked');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'ready_to_return' })[0], 'no_fault_found');
  assert.strictEqual(S.rmaDispositionsFor({ stage: 'ready_to_return' }).length, 12);
});

test('itemLabel never repeats the brand and falls back sensibly', function () {
  assert.strictEqual(S.itemLabel('gpu', 'ASUS', 'RTX 4070 Ti'), 'Graphics card — ASUS RTX 4070 Ti');
  assert.strictEqual(S.itemLabel('motherboard', 'ASUS', 'ASUS TUF B550'), 'Motherboard — ASUS TUF B550');
  assert.strictEqual(S.itemLabel('ram', '', ''), 'RAM');
  assert.strictEqual(S.itemLabel('nonsense', 'Kingston', 'Fury'), 'Kingston Fury');
  assert.strictEqual(S.itemLabel(null, null, null), 'Item');
  assert.strictEqual(S.unitLabel({ kind: 'ssd', brand: 'WD', model: 'SN570' }), 'SSD — WD SN570');
});

test('mediaRoleOf reads the v1 phase when no role is set', function () {
  assert.strictEqual(S.mediaRoleOf({ role: 'invoice', phase: 'intake' }), 'invoice');
  assert.strictEqual(S.mediaRoleOf({ phase: 'intake' }), 'condition');
  assert.strictEqual(S.mediaRoleOf({ phase: 'during' }), 'during');
  assert.strictEqual(S.mediaRoleOf({}), 'condition');
  assert.strictEqual(S.isPrivateMediaRole('serial_label'), true);
  assert.strictEqual(S.isPrivateMediaRole('condition'), false);
});

// ═══ 7. The ticket ↔ part link ═══════════════════════════════════════════

test('rmaSyncTarget follows §2.6 step 4', function () {
  var job = { id: 'J', stage: 'diagnosing', model_version: 2 };
  function u(stage, holds, extra) {
    var o = { id: 'u' + Math.random(), service_job_id: 'J', holds_ticket: holds !== false, stage: stage };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  assert.strictEqual(S.rmaSyncTarget(job, [u('received')]), 'rma_raised');
  assert.strictEqual(S.rmaSyncTarget(job, [u('logged')]), 'rma_raised');
  assert.strictEqual(S.rmaSyncTarget(job, [u('with_tech')]), 'rma_raised', 'A2: with_tech is pre-return');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'at_vendor' }, [u('with_vendor'), u('with_tech')]), 'rma_raised');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'at_vendor' }, [u('returning')]), 'back_from_vendor',
                     'A10: a part on its way to the customer no longer holds the ticket back');
  assert.strictEqual(S.rmaSyncTarget(job, [u('with_vendor')]), 'at_vendor');
  assert.strictEqual(S.rmaSyncTarget(job, [u('with_vendor'), u('awaiting_docs')]), 'rma_raised', 'shop-side work outranks the vendor');
  assert.strictEqual(S.rmaSyncTarget(job, [u('with_vendor'), u('customer_decision')]), 'at_vendor', 'post-return units do not count');
  assert.strictEqual(S.rmaSyncTarget(job, [u('received', false)]), null, 'non-holding units are ignored');
  assert.strictEqual(S.rmaSyncTarget(job, [u('received', true, { service_job_id: 'OTHER' })]), null);
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'at_vendor' }, [u('back_from_vendor')]), 'back_from_vendor');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'at_vendor' }, [u('closed')]), 'back_from_vendor', 'had holding units');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'at_vendor' }, []), null, 'never had any');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'diagnosing' }, [u('back_from_vendor')]), null, 'not in a mirror stage');
  ['ready', 'closed', 'work_done', 'resolved'].forEach(function (st) {
    assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: st }, [u('received')]), null, st);
  });
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'in_service' }, [u('received')]), null, 'outside the sync zone');
  assert.strictEqual(S.rmaSyncTarget({ id: 'J', stage: 'on_site' }, [u('received')]), 'rma_raised', 'on_site is in the zone');
  assert.strictEqual(S.rmaSyncTarget(null, []), null);
});

test('holdingUnitsOf and ticketColumnOf (A23: the most urgent holding part decides the lane)', function () {
  var job = { id: 'J', stage: 'at_vendor', model_version: 2, service_type: 'in_store' };
  var gpu = { id: 'g', service_job_id: 'J', holds_ticket: true, stage: 'with_vendor', stage_since: iso(NOW - 2 * DAY),
              expected_back_at: iso(NOW + 12 * DAY) };
  var psu = { id: 'p', service_job_id: 'J', holds_ticket: true, stage: 'awaiting_docs', stage_since: iso(NOW - 0.5 * DAY) };
  var done = { id: 'd', service_job_id: 'J', holds_ticket: true, stage: 'closed' };
  var loose = { id: 'l', service_job_id: 'J', holds_ticket: false, stage: 'testing' };
  assert.deepStrictEqual(S.holdingUnitsOf(job, [gpu, psu, done, loose]).map(function (x) { return x.id; }), ['g', 'p']);
  assert.deepStrictEqual(S.holdingUnitsOf('J', [gpu]).map(function (x) { return x.id; }), ['g']);
  assert.deepStrictEqual(S.holdingUnitsOf(job, null), []);
  assert.strictEqual(S.ticketColumnOf(job, [gpu], NOW), 'third');
  assert.strictEqual(S.ticketColumnOf(job, [gpu, psu], NOW), 'customer', 'the phone list wins');
  var lateGpu = Object.assign({}, gpu, { expected_back_at: iso(NOW - DAY) });
  assert.strictEqual(S.ticketColumnOf(job, [lateGpu, psu], NOW), 'customer', 'the ball comes before the risk (A23)');
  assert.strictEqual(S.ticketColumnOf(job, [], NOW), 'third', 'no holding parts: the stage lane');
  assert.strictEqual(S.ticketColumnOf({ id: 'J', stage: 'at_vendor', model_version: 1 }, [psu], NOW), 'customer',
                     'a v1 ticket holding a part reads the same way');
  assert.strictEqual(S.ticketColumnOf({ id: 'J', stage: 'diagnosing', model_version: 2 }, [psu], NOW), 'shop', 'not a mirror stage');
  for (var i = 0; i < 50; i++) {
    var jj = { id: 'J', stage: ['rma_raised', 'at_vendor', 'diagnosing', 'closed'][i % 4], model_version: 2 };
    assert.strictEqual(S.ticketColumnOf(jj, [gpu, psu, lateGpu], NOW), S.ticketWithUnits(jj, [gpu, psu, lateGpu], null, NOW).column);
  }
});

test('ticketWithUnits (A23): ball, lane, risk and sentence from the most urgent holding part', function () {
  var job = { id: 'J', stage: 'at_vendor', model_version: 2, service_type: 'in_store', stage_since: iso(NOW - 3 * DAY),
              waiting_party: 'ASUS' };
  var vendors = { 7: { id: 7, name: 'ASUS India', public_name: 'ASUS', typical_tat_days: 14 },
                  demo_v_x: { id: 'demo_v_x', name: 'Rashi Peripherals', public_name: 'Rashi Peripherals', typical_tat_days: 30 } };
  var gpu = { id: 'g', service_job_id: 'J', holds_ticket: true, kind: 'gpu', brand: 'ASUS', model: 'RTX 4070 Ti', vendor_id: 7,
              stage: 'with_vendor', stage_since: iso(NOW - 2 * DAY), expected_back_at: iso(NOW + 12 * DAY) };
  var psu = { id: 'p', service_job_id: 'J', holds_ticket: true, kind: 'psu', brand: 'Antec', model: 'CSK650',
              stage: 'awaiting_docs', stage_since: iso(NOW - 0.5 * DAY) };
  var ram = { id: 'r', service_job_id: 'J', holds_ticket: true, kind: 'ram', brand: 'Kingston', model: 'Fury',
              stage: 'testing', stage_since: iso(NOW - 1.8 * DAY) };
  var other = { id: 'o', service_job_id: 'OTHER', holds_ticket: true, kind: 'ssd', stage: 'awaiting_docs', stage_since: iso(NOW) };

  // Only the vendor part: the chase list, its own sentence and risk.
  var v = S.ticketWithUnits(job, [gpu, other], vendors, NOW);
  assert.deepStrictEqual(Object.keys(v).sort(), ['ball', 'column', 'risk', 'sentence', 'unit']);
  assert.strictEqual(v.ball, 'third_party');
  assert.strictEqual(v.column, 'third');
  assert.strictEqual(v.risk, 0);
  assert.strictEqual(v.sentence, 'Graphics card — ASUS RTX 4070 Ti: Waiting for ASUS — with the manufacturer under warranty');
  assert.strictEqual(v.unit, gpu);

  // Customer ball first, then shop, then a third party — whatever the risk.
  var lateGpu = Object.assign({}, gpu, { expected_back_at: iso(NOW - DAY) });
  v = S.ticketWithUnits(job, [lateGpu, ram, psu], vendors, NOW);
  assert.strictEqual(v.unit, psu);
  assert.strictEqual(v.ball, 'customer');
  assert.strictEqual(v.column, 'customer');
  assert.strictEqual(v.risk, 2, 'risk is the worst holding part (the late GPU)');
  assert.strictEqual(v.sentence, 'Power supply — Antec CSK650: Waiting for you — we need a document or your approval');
  v = S.ticketWithUnits(job, [lateGpu, ram], vendors, NOW);
  assert.strictEqual(v.unit, ram, 'shop before a third party');
  assert.strictEqual(v.column, 'shop');
  assert.strictEqual(v.risk, 2);
  assert.strictEqual(v.sentence, "RAM — Kingston Fury: With us — we're checking the part");

  // Same ball: the riskier, then the one that has waited longer.
  var ram2 = Object.assign({}, ram, { id: 'r2', stage_since: iso(NOW - 0.2 * DAY) });
  assert.strictEqual(S.ticketWithUnits(job, [ram2, ram], vendors, NOW).unit, ram, 'riskier (1.8 of 2 days)');
  var ram3 = Object.assign({}, ram, { id: 'r3', stage_since: iso(NOW - 0.3 * DAY) });
  assert.strictEqual(S.ticketWithUnits(job, [ram2, ram3], vendors, NOW).unit, ram3, 'equal risk: longer wait');

  // The vendor's turnaround is the clock when there is no expected date.
  var noDate = Object.assign({}, gpu, { vendor_id: 'demo_v_x', brand: '', expected_back_at: null, stage_since: iso(NOW - 23 * DAY) });
  assert.strictEqual(S.ticketWithUnits(job, [noDate], vendors, NOW).risk, 1, '23 of 30 days is past three quarters');
  assert.strictEqual(S.ticketWithUnits(job, [noDate], null, NOW).risk, 2, 'no vendor: the 14-day default');
  assert.strictEqual(S.ticketWithUnits(job, [noDate], [vendors.demo_v_x], NOW).risk, 1, 'an array of vendor rows');
  assert.strictEqual(S.ticketWithUnits(job, [noDate], function (id) { return vendors[id]; }, NOW).risk, 1, 'a lookup function');
  assert.ok(/Waiting for Rashi Peripherals/.test(S.ticketWithUnits(job, [noDate], vendors, NOW).sentence),
            'no brand: the public name');

  // Anything else reads as the ticket itself.
  function own(j) {
    return { ball: S.ballOf(j.stage), column: S.boardColumnOf(j), risk: S.serviceRisk(j, NOW), sentence: S.waitingSentence(j), unit: null };
  }
  assert.deepStrictEqual(S.ticketWithUnits(job, [], vendors, NOW), own(job), 'no holding parts');
  var loose = Object.assign({}, psu, { holds_ticket: false });
  assert.deepStrictEqual(S.ticketWithUnits(job, [loose], vendors, NOW), own(job), 'released parts do not count');
  var diag = { id: 'J', stage: 'diagnosing', model_version: 2, service_type: 'in_store', stage_since: iso(NOW - DAY) };
  assert.deepStrictEqual(S.ticketWithUnits(diag, [psu], vendors, NOW), own(diag), 'not a mirror stage');
  var closed = { id: 'J', stage: 'closed', outcome: 'repaired' };
  assert.deepStrictEqual(S.ticketWithUnits(closed, [psu], vendors, NOW), own(closed));
  var v1 = { id: 'J', stage: 'rma_raised', model_version: 1, stage_since: iso(NOW - DAY) };
  assert.strictEqual(S.ticketWithUnits(v1, [psu], vendors, NOW).unit, psu, 'a v1 ticket holding a part');
  assert.deepStrictEqual(S.ticketWithUnits(null, [psu], vendors, NOW), { ball: 'shop', column: 'shop', risk: 0, sentence: '', unit: null });
  assert.strictEqual(S.ticketWithUnits(job, 'garbage', 'garbage', NOW).column, 'third', 'bad inputs fall back to the ticket');
});

test("rma.js's amendment bridges switch themselves off against this model", function () {
  // The exact probes rma.js shims() runs (A8, A12, A11). Each bridge is ON
  // when its probe says the model lacks the amendment.
  var base = { stage: 'received', serial: 'X1234', vendor_id: 1, fee_status: 'paid' };
  var withTech = !(S.RMA_TRANSITIONS && S.RMA_TRANSITIONS.with_tech);
  var vendorDoc = S.rmaGateProblems(Object.assign({}, base, { kind: 'gpu', purchase_source: 'elsewhere' }),
                                    'ready_to_ship', ['serial_label', 'vendor_doc']).length > 0;
  var data = S.rmaGateProblems(Object.assign({}, base, { kind: 'ssd', purchase_source: 'neo_tokyo' }),
                               'ready_to_ship', ['serial_label']).length === 0;
  assert.deepStrictEqual({ withTech: withTech, vendorDoc: vendorDoc, data: data }, { withTech: false, vendorDoc: false, data: false });
  // and the labels rma.js would otherwise patch in
  assert.strictEqual(S.rmaStaffLabel('with_tech'), 'With our technician');
  assert.ok(S.RMA_STAGES.with_tech, 'rma.js uses the model sentence when the stage is known');
});

test('v2.1 data answers: the shop never backs up; old answers read as old', function () {
  assert.deepStrictEqual(S.DATA_CONSENT_CHOICES, ['customer_backed_up', 'no_important_data', 'customer_accepts_risk']);
  assert.strictEqual(S.dataConsentLabel('customer_backed_up'), 'Customer backed up their data');
  assert.strictEqual(S.dataConsentLabel('no_important_data'), 'No important data on it');
  assert.strictEqual(S.dataConsentLabel('customer_accepts_risk'), 'Customer accepts the risk — no backup');
  assert.strictEqual(S.dataConsentLabel('backup_ok'), 'Back up first (old option)');
  assert.strictEqual(S.dataConsentLabel('no_backup'), 'No backup needed (old option)');
  assert.strictEqual(S.dataConsentLabel(null), 'Not asked');
  S.DATA_CONSENT_CHOICES.forEach(function (k) {
    assert.ok(!/\bwe\b|\bour\b|back up first/i.test(S.DATA_CONSENTS[k]), k + ' never promises that the shop backs up');
  });
  assert.strictEqual(S.hasCustomerDataFor('no_important_data'), false);
  assert.strictEqual(S.hasCustomerDataFor('customer_accepts_risk'), true);
  assert.strictEqual(S.hasCustomerDataFor('customer_backed_up'), true);
  assert.strictEqual(S.hasCustomerDataFor(''), null);
  assert.strictEqual(S.hasCustomerDataFor('bogus'), null);
  assert.deepStrictEqual(S.dataConsentOptions(null), S.DATA_CONSENT_CHOICES);
  assert.deepStrictEqual(S.dataConsentOptions('no_backup'), S.DATA_CONSENT_CHOICES.concat(['no_backup']));
  assert.ok(S.dataConsentOptions() !== S.DATA_CONSENT_CHOICES, 'a copy, so a caller cannot change the model');
});

console.log((failures ? 'FAILED' : 'OK') + ' service-status: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
