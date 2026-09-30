/*
  Neo QC — service ticketing status model.

  ONE copy of the rules, loaded by BOTH the Electron app and the website
  (sync-shared.js copies this into dashboard/shared/). That is not tidiness:
  the build side kept its urgency rule in two places, the app's copy was fixed
  so an overdue build stays urgent, and the website's copy still has the bug.
  Two copies of a rule diverge. One cannot.

  THE ONE STORED FACT is job.stage, set only by an explicit human action and
  never recomputed — unlike the build side, where status is re-derived from
  checkboxes on every save and on every dashboard render. Four service stages
  (quoted, parts_on_order, at_vendor, ready) have no observable sub-state
  anywhere in the system; nothing flips when a customer approves a quote over
  the phone, so there is nothing to derive from.

  EVERYTHING ELSE HERE IS DERIVED from that one fact, because a second stored
  column can disagree with the first. That constraint shaped the stage list:
  "awaiting parts" is deliberately two stages — parts_to_order (ours) and
  parts_on_order (the supplier's) — so every stage has exactly one unambiguous
  owner and no two columns can ever contradict each other.

  Plain browser global, no build step, same pattern as shared/matcher.js.

  Usage:
    const S = window.NeoQcService;
    S.ballOf('at_vendor')            // 'third_party'
    S.boardColumnOf(job)             // 'third'
    S.serviceRisk(job)               // 0 ok | 1 soon | 2 breached
    S.customerLabel(job)             // 'With the manufacturer under warranty'
    S.nextStages('warranty_rma', 'received')
*/
(function (global) {
  'use strict';

  var DAY = 86400000;

  // ── Who we are waiting on. The whole board is organised by this. ──────────
  var BALL = {
    SHOP: 'shop',
    CUSTOMER: 'customer',
    THIRD_PARTY: 'third_party',
    NOBODY: 'nobody'
  };

  // ── The stages. key -> definition. Order here is the canonical display order.
  //    customer: the wording the CUSTOMER sees. Deliberately different from the
  //    staff label — "Diagnosing" is jargon; "We're finding the fault" is not.
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
    // ready means THE SHOP IS FINISHED, whatever the outcome — repaired,
    // unrepairable, or quote declined. A declined repair still leaves a device
    // on a shelf, and that is the state every shop forgets. closed means it has
    // physically left the building.
    ready:            { staff: 'Ready for collection',          customer: 'Ready to collect',                  ball: BALL.CUSTOMER },
    closed:           { staff: 'Closed',                        customer: null /* composed from outcome */,    ball: BALL.NOBODY }
  };

  var STAGE_ORDER = Object.keys(STAGES);

  // ── Outcomes. Set when a job moves to `ready`; drive the customer's wording
  //    once it is closed, and the only honest basis for reporting.
  var OUTCOMES = {
    repaired:                 'Repaired and collected',
    unrepairable:             'Returned unrepaired',
    declined:                 'Quote declined, item returned',
    no_fault_found:           'No fault found, item returned',
    replaced_under_warranty:  'Replaced under warranty',
    cancelled:                'Cancelled'
  };

  var JOB_KINDS = {
    repair_own:      'Repair — PC we built',
    repair_outside:  'Repair — outside machine',
    warranty_rma:    'Warranty / RMA',
    upgrade:         'Upgrade / paid service'
  };

  // ── Legal moves per kind. The UI offers only these, so an impossible
  //    transition cannot be recorded. An RMA never passes through in_service
  //    unless the vendor rejects the claim, at which point it becomes a
  //    chargeable repair and picks up `quoted`.
  var STAGES_BY_KIND = {
    repair_own:     ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed'],
    repair_outside: ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed'],
    warranty_rma:   ['logged','received','diagnosing','rma_raised','at_vendor','back_from_vendor','quoted','verifying','ready','closed'],
    upgrade:        ['logged','received','quoted','approved','parts_to_order','parts_on_order','in_service','verifying','ready','closed']
  };

  // ── How long a job may sit in each stage before somebody should be asked.
  //    Two clocks, deliberately: idle days against THIS budget is what indicts
  //    someone; total age is what the customer feels. One overall clock cannot
  //    tell "40 days, 38 of them at a vendor" from "40 days on a shelf".
  var IDLE_BUDGET_DAYS = {
    logged: 1, received: 1, diagnosing: 2, quoted: 3, approved: 2,
    parts_to_order: 1, parts_on_order: 7, rma_raised: 1, at_vendor: 14,
    back_from_vendor: 1, in_service: 3, verifying: 1, ready: 3
    // closed: no budget — it is finished.
  };

  // The five board columns, keyed by ball. Intake is split out of SHOP because
  // "in the building, nobody has looked at it" is the three-week-rot state the
  // board exists to catch, and it must never be buried among active work.
  var COLUMNS = [
    { key: 'intake',   label: 'Intake',           hint: 'Should be empty' },
    { key: 'shop',     label: 'On us',            hint: 'Grouped by technician' },
    { key: 'customer', label: 'On the customer',  hint: 'The phone list' },
    { key: 'third',    label: 'On a third party', hint: 'The chase list' },
    { key: 'closed',   label: 'Closed today',     hint: 'Empties overnight' }
  ];

  function stageDef(stage) { return STAGES[stage] || null; }
  function isKnownStage(stage) { return !!STAGES[stage]; }

  function ballOf(stage) {
    var d = STAGES[stage];
    return d ? d.ball : BALL.SHOP;   // an unknown stage is our problem, not the customer's
  }

  function staffLabel(stage) {
    var d = STAGES[stage];
    return d ? d.staff : (stage || 'Unknown');
  }

  // The customer's wording. `closed` has none of its own — it is composed from
  // the outcome, so "Closed" never appears to a customer without saying what
  // actually happened to their machine.
  function customerLabel(job) {
    if (!job) return '';
    var d = STAGES[job.stage];
    if (!d) return 'In progress';
    if (job.stage === 'closed') return OUTCOMES[job.outcome] || 'Closed';
    return d.customer;
  }

  function nextStages(jobKind, stage) {
    var list = STAGES_BY_KIND[jobKind] || STAGES_BY_KIND.repair_outside;
    // Not a linear pipeline: service loops (diagnose -> quote -> bench ->
    // parts -> bench). Any other stage legal for this kind is offerable, which
    // is exactly why the board is not organised as a pipeline.
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

  // Days the job has sat in its CURRENT stage. Fractional, so a card can show
  // "0.4d" rather than rounding a fresh job to zero and looking untouched.
  function daysInStage(job, now) {
    var since = _ms(job && (job.stage_since || job.stageSince));
    if (since == null) return 0;
    return Math.max(0, ((now || Date.now()) - since) / DAY);
  }

  // Total age, which is what the customer feels.
  function ageDays(job, now) {
    var created = _ms(job && (job.created_at || job.createdAt));
    if (created == null) return 0;
    return Math.max(0, ((now || Date.now()) - created) / DAY);
  }

  // 0 ok | 1 soon | 2 breached. One monotonic ordinal so a caller can compare,
  // sort and pick a colour without re-deriving anything.
  //
  // A broken promise always outranks an idle budget: a date given to a customer
  // is a commitment, and the budget is only an internal expectation.
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

    // Promised within a day and not yet finished is worth a nudge even when the
    // current stage is comfortably inside its own budget.
    if (promised != null && promised - t <= DAY) return 1;
    return 0;
  }

  // A short, honest sentence for the top of the customer's status page. This is
  // the thing the owner asked for: not "which stage", but whose turn it is.
  function waitingSentence(job) {
    if (!job) return '';
    if (job.stage === 'closed') return OUTCOMES[job.outcome] || 'Closed';
    var ball = ballOf(job.stage);
    var who = job.waiting_party || job.waitingParty;
    var label = customerLabel(job) || '';
    // Some customer labels already open with "Waiting", so prefixing produces
    // "Waiting for you — waiting for your go-ahead". Use the label alone when it
    // already carries the wait.
    var selfCarrying = /^waiting\b/i.test(label);
    if (ball === BALL.CUSTOMER) {
      return selfCarrying ? label : 'Waiting for you — ' + label.toLowerCase();
    }
    if (ball === BALL.THIRD_PARTY) {
      var vendor = who || 'a supplier';
      return selfCarrying
        ? 'Waiting for ' + vendor
        : 'Waiting for ' + vendor + ' — ' + label.toLowerCase();
    }
    return 'With us — ' + label.toLowerCase();
  }

  var api = {
    BALL: BALL,
    STAGES: STAGES,
    STAGE_ORDER: STAGE_ORDER,
    OUTCOMES: OUTCOMES,
    JOB_KINDS: JOB_KINDS,
    STAGES_BY_KIND: STAGES_BY_KIND,
    IDLE_BUDGET_DAYS: IDLE_BUDGET_DAYS,
    COLUMNS: COLUMNS,
    stageDef: stageDef,
    isKnownStage: isKnownStage,
    ballOf: ballOf,
    staffLabel: staffLabel,
    customerLabel: customerLabel,
    nextStages: nextStages,
    boardColumnOf: boardColumnOf,
    daysInStage: daysInStage,
    ageDays: ageDays,
    serviceRisk: serviceRisk,
    waitingSentence: waitingSentence
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcService = api;
  }
})(typeof window !== 'undefined' ? window : this);
