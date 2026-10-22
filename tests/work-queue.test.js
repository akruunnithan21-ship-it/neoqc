/*
  Unit tests for shared/work-queue.js (NeoQcWork).
  Run: node tests/work-queue.test.js   — exits 1 on any failure.

  The rules are the owner's (2026-10-22): one queue, 4 hours to claim, 30
  minutes to accept an offer, high-value builds (tier 4–5) for senior builders
  only. The eligibility sentences are the exact §1 texts the server answers.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var W = require(path.join(__dirname, '..', 'shared', 'work-queue.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;
var NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();   // 22 Oct 2026, 12:00 local
function iso(ms) { return new Date(ms).toISOString(); }

// ═══ constants and the clock ══════════════════════════════════════════════

test('constants: 4 hours to claim, 30 minutes to accept', function () {
  assert.strictEqual(W.CLAIM_HOURS, 4);
  assert.strictEqual(W.OFFER_MINUTES, 30);
});

test('serverOffsetMs: server minus local arrival, 0 when unreadable', function () {
  assert.strictEqual(W.serverOffsetMs(iso(NOW + 90 * SEC), NOW), 90 * SEC, 'this PC is 90 s slow');
  assert.strictEqual(W.serverOffsetMs(iso(NOW - 5 * MIN), NOW), -5 * MIN, 'this PC is 5 min fast');
  assert.strictEqual(W.serverOffsetMs('2026-10-22T06:30:00.123456+00:00', Date.parse('2026-10-22T06:30:00.000Z')), 123, 'Postgres microseconds');
  assert.strictEqual(W.serverOffsetMs(null, NOW), 0);
  assert.strictEqual(W.serverOffsetMs('nonsense', NOW), 0);
  assert.strictEqual(W.serverOffsetMs(iso(NOW), null), 0);
  assert.strictEqual(W.serverOffsetMs(iso(NOW), 'x'), 0);
});

// ═══ formatting ═══════════════════════════════════════════════════════════

test('fmtLeft: hours+minutes, minutes, seconds; rounds down; never negative', function () {
  assert.strictEqual(W.fmtLeft(3 * HOUR + 12 * MIN + 59 * SEC), '3h 12m');
  assert.strictEqual(W.fmtLeft(3 * HOUR + 5 * MIN), '3h 05m');
  assert.strictEqual(W.fmtLeft(HOUR), '1h 00m');
  assert.strictEqual(W.fmtLeft(HOUR - 1), '59m');
  assert.strictEqual(W.fmtLeft(24 * MIN + 30 * SEC), '24m');
  assert.strictEqual(W.fmtLeft(MIN), '1m');
  assert.strictEqual(W.fmtLeft(MIN - 1), '59s');
  assert.strictEqual(W.fmtLeft(45 * SEC + 900), '45s');
  assert.strictEqual(W.fmtLeft(999), '0s', 'under a second rounds down');
  assert.strictEqual(W.fmtLeft(0), '0s');
  assert.strictEqual(W.fmtLeft(-5 * MIN), '0s');
  assert.strictEqual(W.fmtLeft(null), '0s');
  assert.strictEqual(W.fmtLeft(NaN), '0s');
  assert.strictEqual(W.fmtLeft(52 * HOUR + 7 * MIN), '52h 07m');
});

test('fmtOverdue / fmtAgo / fmtClock', function () {
  assert.strictEqual(W.fmtOverdue(HOUR + 5 * MIN), 'overdue 1h 05m');
  assert.strictEqual(W.fmtOverdue(-(HOUR + 5 * MIN)), 'overdue 1h 05m', 'sign ignored');
  assert.strictEqual(W.fmtOverdue(24 * MIN), 'overdue 24m');
  assert.strictEqual(W.fmtOverdue(null), 'overdue 0s');
  assert.strictEqual(W.fmtAgo(10 * SEC), 'just now');
  assert.strictEqual(W.fmtAgo(12 * MIN), '12m ago');
  assert.strictEqual(W.fmtAgo(2 * HOUR + 50 * MIN), '2h ago');
  assert.strictEqual(W.fmtAgo(3 * DAY), '3d ago');
  assert.strictEqual(W.fmtClock(new Date(2026, 9, 22, 9, 5, 0).getTime()), '09:05');
  assert.strictEqual(W.fmtClock(iso(new Date(2026, 9, 22, 14, 30, 0).getTime())), '14:30');
  assert.strictEqual(W.fmtClock(null), '');
  assert.strictEqual(W.fmtClock('junk'), '');
});

// ═══ builds: tier and cost ════════════════════════════════════════════════

// Mirrors sql/work-queue.sql _build_tier: __build must be an object; the tier
// text must match ^[0-9]{1,6}(\.[0-9]+)?$ (after trimming), floored, clamped 1–5.
test('buildTier: specs.__build.tier, clamped 1–5, default 1, never throws (= _build_tier)', function () {
  assert.strictEqual(W.buildTier({ __build: { tier: 4 } }), 4);
  assert.strictEqual(W.buildTier({ __build: { tier: '5' } }), 5);
  assert.strictEqual(W.buildTier({ __build: { tier: ' 3 ' } }), 3, 'trimmed');
  assert.strictEqual(W.buildTier({ __build: { tier: 4.9 } }), 4, 'floored');
  assert.strictEqual(W.buildTier({ __build: { tier: '2.5' } }), 2);
  assert.strictEqual(W.buildTier({ __build: { tier: 9 } }), 5);
  assert.strictEqual(W.buildTier({ __build: { tier: 0 } }), 1);
  assert.strictEqual(W.buildTier({ __build: { tier: 0.5 } }), 1);
  assert.strictEqual(W.buildTier({ __build: { tier: -3 } }), 1, 'no sign');
  assert.strictEqual(W.buildTier({ __build: { tier: '1234567' } }), 1, 'more than 6 digits is junk');
  assert.strictEqual(W.buildTier({ __build: { tier: 123456 } }), 5);
  assert.strictEqual(W.buildTier({ __build: { tier: '4e0' } }), 1, 'no exponent');
  assert.strictEqual(W.buildTier({ __build: { tier: 'high' } }), 1);
  assert.strictEqual(W.buildTier({ __build: { tier: true } }), 1);
  assert.strictEqual(W.buildTier({ __build: { tier: null } }), 1);
  assert.strictEqual(W.buildTier({ __build: {} }), 1);
  assert.strictEqual(W.buildTier({}), 1);
  assert.strictEqual(W.buildTier(null), 1);
  assert.strictEqual(W.buildTier([]), 1);
  assert.strictEqual(W.buildTier('{"__build":{"tier":3}}'), 3, 'JSON text');
  assert.strictEqual(W.buildTier('{broken'), 1);
  assert.strictEqual(W.buildTier({ __build: '{"tier":2}' }), 1, '__build must be an object, not text');
  assert.strictEqual(W.buildTier({ __build: [4] }), 1);
  assert.strictEqual(W.buildTier({ __build: { tier: [4] } }), 1);
});

test('costs: build = tier, on-site service = 2, other service = 1', function () {
  assert.strictEqual(W.buildCost({ __build: { tier: 3 } }), 3);
  assert.strictEqual(W.buildCost(null), 1);
  assert.strictEqual(W.serviceCost('on_site'), 2);
  assert.strictEqual(W.serviceCost('in_store'), 1);
  assert.strictEqual(W.serviceCost('remote'), 1);
  assert.strictEqual(W.serviceCost(null), 1);
});

// ═══ claim window ═════════════════════════════════════════════════════════

test('claimDueMs: claim_due first, else queued_at + 4 h (feed or ticket)', function () {
  assert.strictEqual(W.claimDueMs({ claim_due: iso(NOW + HOUR), queued_at: iso(NOW - 10 * HOUR) }), NOW + HOUR);
  assert.strictEqual(W.claimDueMs({ queued_at: iso(NOW) }), NOW + 4 * HOUR);
  assert.strictEqual(W.claimDueMs({ queuedAt: iso(NOW) }), NOW + 4 * HOUR);
  assert.strictEqual(W.claimDueMs({}), null);
  assert.strictEqual(W.claimDueMs(null), null);
});

test('claimRisk: 0 under 3 h, 1 from 3 h, 2 from 4 h; 0 when assigned or never queued', function () {
  function q(hours, extra) {
    var o = { kind: 'service', queued_at: iso(NOW - hours * HOUR), assignee_email: null };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return W.claimRisk(o, NOW);
  }
  assert.strictEqual(q(0), 0);
  assert.strictEqual(q(2.99), 0);
  assert.strictEqual(q(3), 1);
  assert.strictEqual(q(3.99), 1);
  assert.strictEqual(q(4), 2);
  assert.strictEqual(q(30), 2);
  assert.strictEqual(q(30, { assignee_email: 'x@y.z' }), 0, 'assigned');
  assert.strictEqual(q(30, { assignee_email: null, assignee_name: 'Jagath' }), 0, 'legacy name-only build counts as assigned');
  assert.strictEqual(W.claimRisk({ kind: 'build', claim_due: iso(NOW - MIN) }, NOW), 2, 'claim_due alone');
  assert.strictEqual(W.claimRisk({ kind: 'build' }, NOW), 0, 'never queued');
  assert.strictEqual(W.claimRisk({ queuedAt: iso(NOW - 3.5 * HOUR), technician: '', technicianEmail: null }, NOW), 1, 'desktop ticket');
  assert.strictEqual(W.claimRisk({ queuedAt: iso(NOW - 5 * HOUR), technician: 'Adhil' }, NOW), 0, 'desktop ticket with a technician');
});

// ═══ offers ═══════════════════════════════════════════════════════════════

test('offerOf reads the feed, the desktop ticket and a raw row; offerLeftMs / offerLive', function () {
  var feed = { offer: { to_email: 'amal@x', to_name: 'Amal C', kind: 'auto', by_name: 'Neo OS', reason: 'r', offered_at: iso(NOW - 12 * MIN), expires_at: iso(NOW + 18 * MIN) } };
  var o = W.offerOf(feed);
  assert.strictEqual(o.toName, 'Amal C');
  assert.strictEqual(o.kind, 'auto');
  assert.strictEqual(W.offerLeftMs(feed, NOW), 18 * MIN);
  assert.strictEqual(W.offerLive(feed, NOW), true);
  var ticket = { offer: { toEmail: 'amal@x', toName: 'Amal', expiresAt: iso(NOW - SEC) } };
  assert.strictEqual(W.offerLeftMs(ticket, NOW), -SEC);
  assert.strictEqual(W.offerLive(ticket, NOW), false, 'expired');
  var row = { offered_to_email: 'adhil@x', offered_to_name: 'Adhil M', offer_kind: 'manager', offer_expires_at: iso(NOW + 5 * MIN) };
  assert.strictEqual(W.offerOf(row).toEmail, 'adhil@x');
  assert.strictEqual(W.offerLeftMs(row, NOW), 5 * MIN);
  assert.strictEqual(W.offerOf({ offer: null }), null);
  assert.strictEqual(W.offerOf({ offer_expires_at: null }), null);
  assert.strictEqual(W.offerLeftMs({}, NOW), null);
  assert.strictEqual(W.offerLive(null, NOW), false);
});

test('kindLabel', function () {
  assert.strictEqual(W.kindLabel({ kind: 'build' }), 'Build');
  assert.strictEqual(W.kindLabel({ kind: 'service', service_type: 'in_store' }), 'In-store');
  assert.strictEqual(W.kindLabel({ kind: 'service', service_type: 'on_site' }), 'On-site');
  assert.strictEqual(W.kindLabel({ kind: 'service', service_type: 'remote' }), 'Remote');
  assert.strictEqual(W.kindLabel({ kind: 'service' }), 'In-store');
  assert.strictEqual(W.kindLabel(null), 'In-store');
});

test('sortItems: offered to me (expiry), open (claim due, nulls last), mine (deadline, nulls last), the rest', function () {
  var items = [
    { id: 'mine-late-deadline', mine: true, assignee_email: 'me@x', deadline: iso(NOW + 5 * DAY) },
    { id: 'open-no-due', assignee_email: null },
    { id: 'offer-me-later', offered_to_me: true, assignee_email: null, offer: { expires_at: iso(NOW + 20 * MIN) } },
    { id: 'open-due-soon', assignee_email: null, claim_due: iso(NOW + HOUR) },
    { id: 'lead-sees-offer', assignee_email: 'adhil@x', offer: { to_email: 'amal@x', expires_at: iso(NOW + 9 * MIN) } },
    { id: 'mine-no-deadline', mine: true, assignee_email: 'me@x', deadline: null },
    { id: 'offer-me-soon', offered_to_me: true, assignee_email: null, offer: { expires_at: iso(NOW + 2 * MIN) } },
    { id: 'open-due-later', assignee_email: null, queued_at: iso(NOW) },
    { id: 'mine-soon', mine: true, assignee_email: 'me@x', deadline: iso(NOW + DAY) }
  ];
  var copy = items.slice();
  var out = W.sortItems(items, NOW).map(function (x) { return x.id; });
  assert.deepStrictEqual(out, ['offer-me-soon', 'offer-me-later', 'open-due-soon', 'open-due-later', 'open-no-due',
                               'mine-soon', 'mine-late-deadline', 'mine-no-deadline', 'lead-sees-offer']);
  assert.deepStrictEqual(items, copy, 'the input is not reordered');
  assert.deepStrictEqual(W.sortItems(null, NOW), []);
});

// ═══ builds on the desktop ════════════════════════════════════════════════

test('isQueuedBuild / isQuoteBuild', function () {
  var q = { technician: '', technicianEmail: null, queuedAt: iso(NOW), status: 'awaiting' };
  assert.strictEqual(W.isQueuedBuild(q), true);
  assert.strictEqual(W.isQuoteBuild(q), false);
  var quote = { technician: null, technicianEmail: null, queuedAt: null, status: 'awaiting' };
  assert.strictEqual(W.isQueuedBuild(quote), false);
  assert.strictEqual(W.isQuoteBuild(quote), true);
  assert.strictEqual(W.isQueuedBuild({ technician: 'Adhil', queuedAt: iso(NOW) }), false, 'legacy name counts as assigned');
  assert.strictEqual(W.isQueuedBuild({ technician: '  ', technicianEmail: 'a@x', queuedAt: iso(NOW) }), false);
  assert.strictEqual(W.isQueuedBuild({ queuedAt: iso(NOW), status: 'completed' }), false);
  assert.strictEqual(W.isQuoteBuild({ status: 'completed' }), false);
  assert.strictEqual(W.isQuoteBuild({ technician: '   ' }), true, 'blank name is nobody');
  assert.strictEqual(W.isQueuedBuild({ technician_email: null, queued_at: iso(NOW), status: 'awaiting' }), true, 'server row (website)');
  assert.strictEqual(W.isQueuedBuild(null), false);
  assert.strictEqual(W.isQuoteBuild(null), false);
});

test('buildAssignText: every state, with its tone', function () {
  function txt(t) { return W.buildAssignText(t, NOW); }
  assert.deepStrictEqual(txt({ technician: 'Adhil', technicianEmail: 'adhil.m@x', assignedVia: 'claim', assignedAt: iso(NOW - 2 * HOUR - 5 * MIN) }),
    { label: 'Claimed by Adhil · 2h ago', tone: 'ok' });
  assert.deepStrictEqual(txt({ technician: 'Amal', technicianEmail: 'amal.c@x', assignedVia: 'manager', assignedAt: iso(NOW - 3 * MIN) }),
    { label: 'Assigned to Amal · 3m ago', tone: 'ok' });
  assert.deepStrictEqual(txt({ technician: 'Adhil', technicianEmail: null }), { label: 'Adhil (old assignment)', tone: 'muted' });
  assert.deepStrictEqual(txt({ technician: 'Adhil', technicianEmail: 'adhil.m@x', assignedVia: 'legacy' }), { label: 'Adhil (old assignment)', tone: 'muted' });
  assert.deepStrictEqual(txt({ technician: '', technicianEmail: null, queuedAt: iso(NOW - 10 * MIN), status: 'awaiting',
                               offer: { toEmail: 'amal.c@x', toName: 'Amal C Abi', expiresAt: iso(NOW + 12 * MIN + 30 * SEC) } }),
    { label: 'Offered to Amal · 12m left', tone: 'warn' });
  assert.deepStrictEqual(txt({ technician: '', queuedAt: iso(NOW - 50 * MIN), status: 'awaiting' }),
    { label: 'In the build queue · claim within 3h 10m', tone: 'ok' });
  assert.deepStrictEqual(txt({ queuedAt: iso(NOW - 3.5 * HOUR), status: 'awaiting' }),
    { label: 'In the build queue · claim within 30m', tone: 'warn' });
  assert.deepStrictEqual(txt({ queuedAt: iso(NOW - 5 * HOUR), status: 'awaiting' }),
    { label: 'In the build queue · overdue — the app is offering it', tone: 'late' });
  assert.deepStrictEqual(txt({ technician: null, queuedAt: null, status: 'awaiting' }), { label: 'Not sent to the floor yet', tone: 'muted' });
  // An expired offer reads as the queue again.
  assert.strictEqual(txt({ queuedAt: iso(NOW - HOUR), status: 'awaiting', offer: { toName: 'Amal', expiresAt: iso(NOW - MIN) } }).label,
    'In the build queue · claim within 3h 00m');
  // A lead's reassignment offer is shown next to who has it now.
  assert.strictEqual(txt({ technician: 'Adhil', technicianEmail: 'adhil.m@x', assignedVia: 'claim', assignedAt: iso(NOW - HOUR),
                           offer: { toEmail: 'amal.c@x', toName: 'Amal', expiresAt: iso(NOW + 20 * MIN) } }).label,
    'Claimed by Adhil · 1h ago · offered to Amal (20m left)');
  // The website's server-row shape.
  assert.deepStrictEqual(W.buildAssignText({ technician: null, technician_email: null, queued_at: iso(NOW), status: 'awaiting',
                                             offered_to_name: 'Athul Sudheer', offer_expires_at: iso(NOW + 29 * MIN) }, NOW),
    { label: 'Offered to Athul · 29m left', tone: 'warn' });
  assert.strictEqual(txt({ technician: null, technicianEmail: 'athul.sudheer@x', assignedVia: 'claim' }).label, 'Claimed by Athul');
  assert.deepStrictEqual(txt({ status: 'completed' }), { label: 'No technician recorded', tone: 'muted' });
  assert.ok(txt(null).label, 'null never throws');
});

// ═══ eligibility ══════════════════════════════════════════════════════════

test('whySentence: the exact §1 texts, they / you', function () {
  assert.strictEqual(W.whySentence('not_staff', 'build', false), "They don't have an active staff account.");
  assert.strictEqual(W.whySentence('not_staff', 'service', true), "You don't have an active staff account.");
  assert.strictEqual(W.whySentence('no_role', 'build', false), "They don't have the Builds technician role.");
  assert.strictEqual(W.whySentence('no_role', 'service', false), "They don't have the Service technician role.");
  assert.strictEqual(W.whySentence('no_role', 'build', true), "You don't have the Builds technician role.");
  assert.strictEqual(W.whySentence('no_role', 'service', true), "You don't have the Service technician role.");
  assert.strictEqual(W.whySentence('no_pool', 'build', false), "They aren't in the build pool.");
  assert.strictEqual(W.whySentence('no_pool', 'service', false), "They aren't in the service pool.");
  assert.strictEqual(W.whySentence('no_pool', 'build', true), "You aren't in the build pool.");
  assert.strictEqual(W.whySentence('no_pool', 'service', true), "You aren't in the service pool.");
  assert.strictEqual(W.whySentence('senior', 'build', false), 'This is a high-value build — only senior builders can take it.');
  assert.strictEqual(W.whySentence('senior', 'build', true), 'This is a high-value build — only senior builders can take it.');
  assert.strictEqual(W.whySentence(null, 'build', true), null);
  assert.strictEqual(W.whySentence('toString', 'build', true), null, 'no prototype keys');
});

test('whyNot mirrors _work_why_not: staff, role, pool, then seniority', function () {
  var junior = { email: 'a@x', tier: 2, qc_role: 'tech', service_role: 'tech', build_pool: true, service_pool: true, build_level: 'junior' };
  var senior = Object.assign({}, junior, { build_level: 'senior' });
  assert.strictEqual(W.whyNot(junior, 'build', 3), null);
  assert.strictEqual(W.whyNot(junior, 'build', 4), 'senior');
  assert.strictEqual(W.whyNot(junior, 'build', 5), 'senior');
  assert.strictEqual(W.whyNot(senior, 'build', 5), null);
  assert.strictEqual(W.whyNot(junior, 'build', { __build: { tier: 4 } }), 'senior', 'specs instead of a tier');
  assert.strictEqual(W.whyNot(junior, 'build', null), null, 'no tier → 1');
  assert.strictEqual(W.whyNot(junior, 'service', null), null);
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { level: null, build_level: null }), 'build', 4), 'senior', 'no level is not senior');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { service_pool: false }), 'service'), 'no_pool');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { build_pool: false }), 'build', 1), 'no_pool');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { build_pool: undefined }), 'build', 1), 'no_pool', 'missing pool = not in it');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { qc_role: 'desk' }), 'build', 1), 'no_role');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { qc_role: null }), 'build', 1), 'no_role');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { service_role: 'desk' }), 'service'), 'no_role');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { active: false }), 'service'), 'not_staff');
  assert.strictEqual(W.whyNot(Object.assign({}, junior, { is_staff: false }), 'build', 1), 'not_staff');
  assert.strictEqual(W.whyNot(null, 'build', 1), 'not_staff');
  // Role before pool, pool before seniority.
  assert.strictEqual(W.whyNot({ tier: 2, qc_role: null, build_pool: false }, 'build', 5), 'no_role');
  assert.strictEqual(W.whyNot({ tier: 2, qc_role: 'tech', build_pool: false }, 'build', 5), 'no_pool');
  // Tier 3+ leads every module but is NOT automatically in a pool.
  assert.strictEqual(W.whyNot({ tier: 4, build_pool: false, service_pool: false }, 'service'), 'no_pool');
  assert.strictEqual(W.whyNot({ tier: 3, qc_role: null, build_pool: true, build_level: 'senior' }, 'build', 5), null);
  // A service_tech_list row: `role` is the service role.
  assert.strictEqual(W.whyNot({ email: 't@x', role: 'tech', service_pool: true }, 'service'), null);
  assert.strictEqual(W.whyNot({ email: 't@x', role: 'desk', service_pool: true }, 'service'), 'no_role');
  assert.strictEqual(W.whyNot({ email: 't@x', role: 'lead', service_pool: true }, 'build', 1), 'no_role', 'a service role is not a builds role');
});

test('isAssigned: §1 for every shape', function () {
  assert.strictEqual(W.isAssigned({ assignee_email: 'a@x' }), true);
  assert.strictEqual(W.isAssigned({ assignee_email: null, assignee_name: 'Jagath' }), true);
  assert.strictEqual(W.isAssigned({ technician: 'Jagath', technicianEmail: null }), true);
  assert.strictEqual(W.isAssigned({ technician: ' ', technicianEmail: null }), false);
  assert.strictEqual(W.isAssigned({ technician_email: 'a@x' }), true);
  assert.strictEqual(W.isAssigned({}), false);
  assert.strictEqual(W.isAssigned(null), false);
});

test('UMD: exports every name the spec lists', function () {
  ['CLAIM_HOURS', 'OFFER_MINUTES', 'claimDueMs', 'claimRisk', 'offerLeftMs', 'fmtLeft', 'fmtOverdue', 'kindLabel',
   'sortItems', 'buildTier', 'buildCost', 'serviceCost', 'isQueuedBuild', 'isQuoteBuild', 'buildAssignText',
   'whySentence', 'whyNot', 'serverOffsetMs'].forEach(function (k) { assert.ok(k in W, k); });
});

console.log((failures ? 'FAILED' : 'OK') + ' work-queue: ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
