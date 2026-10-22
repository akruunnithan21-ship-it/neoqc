/*
  Neo QC — service ticketing status model (v2: service types + the RMA model).

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

  The one exception is the three MIRROR stages (rma_raised, at_vendor,
  back_from_vendor) on a v2 ticket: those are written only by the server's
  RMA sync, from the stage of the part the ticket is waiting on. Still one
  writer per fact — the part's stage is the fact, the ticket's mirror stage
  is its projection, and nothing in this file writes either.

  EVERYTHING ELSE HERE IS DERIVED from stored facts, because a second stored
  column can disagree with the first. That constraint shaped the stage list:
  "awaiting parts" is deliberately two stages — parts_to_order (ours) and
  parts_on_order (the supplier's) — so every stage has exactly one unambiguous
  owner and no two columns can ever contradict each other.

  BACKWARD COMPATIBILITY: every v1 export keeps its exact behaviour for v1
  callers (the website build that is live today, and v1.9.11 desktops reading
  the same rows). In particular serviceRisk() on a job WITHOUT service_type
  runs the original code path untouched. The SQL in sql/service-v2.sql mirrors
  STAGES_BY_TYPE, RMA_TRANSITIONS, the vocab lists, the labels and the gates —
  change them together. tests/sql-parity.test.js reads the SQL and fails when
  the two copies disagree.

  Plain browser global, no build step, same pattern as shared/matcher.js.

  Usage:
    const S = window.NeoQcService;
    S.ballOf('at_vendor')            // 'third_party'
    S.boardColumnOf(job)             // 'third'
    S.serviceRisk(job)               // 0 ok | 1 soon | 2 breached
    S.customerLabel(job)             // 'With the manufacturer under warranty'
    S.nextStages('warranty_rma', 'received')
    S.nextStagesFor(job)             // v2-aware move list (no mirror stages)
    S.queueRisk(job)                 // how long nobody has taken it
    S.rmaNextStages(unit)            // RMA moves offered by the plain Move box
    S.rmaGateProblems(unit, 'ready_to_ship', ['serial_label'])
    S.ticketWithUnits(job, units, vendorsById, now)   // {ball, column, risk, sentence, unit}
*/
(function (global) {
  'use strict';

  var MIN = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function trim(v) { return v == null ? '' : String(v).trim(); }
  // Own-property lookup: a stray key such as "toString" from a bad row must
  // read as unknown, never as Object.prototype's function.
  function own(o, k) { return has(o, k) ? o[k] : undefined; }

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
  //    The eight field / remote stages sit before `ready` so `closed` stays
  //    last; the v1 keys keep their original relative order.
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
    // On-site visits. work_done is the customer's turn on purpose: the job is
    // only finished when they have used the machine and nothing is still wrong.
    scheduled:        { staff: 'Visit scheduled',               customer: 'Visit booked',                      ball: BALL.SHOP },
    en_route:         { staff: 'Technician en route',           customer: 'Our technician is on the way',      ball: BALL.SHOP },
    on_site:          { staff: 'On site',                       customer: 'Our technician is with you',        ball: BALL.SHOP },
    work_done:        { staff: 'Work done — awaiting sign-off', customer: 'Work done — tell us if anything is still wrong', ball: BALL.CUSTOMER },
    revisit_needed:   { staff: 'Revisit needed',                customer: 'A follow-up visit is needed',       ball: BALL.SHOP },
    // Remote sessions.
    session_booked:   { staff: 'Remote session booked',         customer: 'Remote session booked',             ball: BALL.SHOP },
    in_session:       { staff: 'In remote session',             customer: 'Remote session in progress',        ball: BALL.SHOP },
    resolved:         { staff: 'Resolved remotely — confirming', customer: 'Fixed remotely — tell us if anything is still wrong', ball: BALL.CUSTOMER },
    // ready means THE SHOP IS FINISHED, whatever the outcome — repaired,
    // unrepairable, or quote declined. A declined repair still leaves a device
    // on a shelf, and that is the state every shop forgets. closed means it has
    // physically left the building.
    ready:            { staff: 'Ready for collection',          customer: 'Ready to collect',                  ball: BALL.CUSTOMER },
    closed:           { staff: 'Closed',                        customer: null /* composed from outcome */,    ball: BALL.NOBODY }
  };

  var STAGE_ORDER = Object.keys(STAGES);

  // ── Outcomes. Set when a job moves to `ready` or `closed`; drive the
  //    customer's wording once it is closed, and the only honest basis for
  //    reporting.
  var OUTCOMES = {
    repaired:                 'Repaired and collected',
    unrepairable:             'Returned unrepaired',
    declined:                 'Quote declined, item returned',
    no_fault_found:           'No fault found, item returned',
    replaced_under_warranty:  'Replaced under warranty',
    cancelled:                'Cancelled',
    resolved_on_site:         'Fixed during our visit',
    resolved_remotely:        'Fixed remotely',
    // The PC goes home while its part is still at the vendor. Without this the
    // only honest choices were "repaired" (untrue) or leaving the PC on a shelf
    // for three weeks.
    returned_rma_pending:     'Returned to you — your part is still under warranty claim'
  };

  var JOB_KINDS = {
    repair_own:      'Repair — PC we built',
    repair_outside:  'Repair — outside machine',
    warranty_rma:    'Warranty / RMA',
    upgrade:         'Upgrade / paid service'
  };

  // ── Legal moves per kind (v1 tickets). The UI offers only these, so an
  //    impossible transition cannot be recorded. An RMA never passes through
  //    in_service unless the vendor rejects the claim, at which point it
  //    becomes a chargeable repair and picks up `quoted`.
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
  //    This is the v1 (in-store) table and stays exactly as it was.
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

  // ═══ v2 vocabulary (exact keys shared with the SQL and the website) ═══════

  var TYPES = {
    in_store: { label: 'In-store', icon: 'store' },
    on_site:  { label: 'On-site',  icon: 'pin' },
    remote:   { label: 'Remote',   icon: 'remote' }
  };

  var CHANNELS = {
    walk_in: 'Walk-in', phone: 'Phone', whatsapp: 'WhatsApp',
    website: 'Website', courier: 'Courier', staff: 'Staff'
  };

  var CATEGORIES = {
    repair:          'Repair',
    warranty_claim:  'Warranty claim',
    upgrade:         'Upgrade',
    installation:    'Installation',
    data_recovery:   'Data recovery',
    os_software:     'OS / software',
    networking:      'Networking',
    maintenance:     'Maintenance',
    diagnosis_only:  'Diagnosis only'
  };

  var PRIORITIES = {
    low:    { label: 'Low',    rank: 0 },
    normal: { label: 'Normal', rank: 1 },
    high:   { label: 'High',   rank: 2 },
    urgent: { label: 'Urgent', rank: 3 }
  };

  var ITEM_KINDS = {
    pc:          'Desktop PC',
    laptop:      'Laptop',
    gpu:         'Graphics card',
    psu:         'Power supply',
    ram:         'RAM',
    ssd:         'SSD',
    hdd:         'Hard drive',
    motherboard: 'Motherboard',
    cpu:         'Processor',
    cooler:      'Cooler',
    monitor:     'Monitor',
    peripheral:  'Peripheral',
    other:       'Other'
  };

  // "unknown" is a normal answer, not an error: the counter often does not
  // know, and a forced guess is worse than an honest "not sure".
  var PURCHASE_SOURCES = {
    neo_tokyo: 'Neo Tokyo',
    elsewhere: 'Bought elsewhere',
    unknown:   'Not sure'
  };

  // Labels for the remaining vocab, so every surface words them the same way.
  // The data answer (sql/service-v2.1.sql): the shop never backs up customer
  // data and is not responsible for it, so the desk records what the CUSTOMER
  // did. DATA_CONSENT_CHOICES are the only answers offered anywhere.
  // backup_ok / no_backup are the 1.10.0-beta.1 answers ("we back it up"):
  // still valid in the database for old rows and that build, never offered,
  // labelled so nobody reads them as a promise we make today.
  var DATA_CONSENTS = {
    customer_backed_up:    'Customer backed up their data',
    no_important_data:     'No important data on it',
    customer_accepts_risk: 'Customer accepts the risk — no backup',
    backup_ok:             'Back up first (old option)',
    no_backup:             'No backup needed (old option)'
  };
  var DATA_CONSENT_CHOICES = ['customer_backed_up', 'no_important_data', 'customer_accepts_risk'];
  var DATA_CONSENT_LEGACY = ['backup_ok', 'no_backup'];

  var REMOTE_TOOLS = {
    anydesk:       'AnyDesk',
    teamviewer:    'TeamViewer',
    rustdesk:      'RustDesk',
    quick_assist:  'Quick Assist',
    chrome_remote: 'Chrome Remote Desktop',
    other:         'Other'
  };

  var ASSIGNED_VIA = {
    claim: 'Claimed', manager: 'Assigned by a lead', legacy: 'Assigned', self: 'Took it at intake'
  };

  // Photo / document roles on service_media (and RMA media). The three private
  // roles can never be shown to a customer — the database refuses it too.
  var MEDIA_ROLES = {
    condition:        'Condition',
    serial_label:     'Serial label',
    invoice:          'Invoice',
    damage:           'Damage',
    packing:          'Packing',
    unboxing:         'Unboxing',
    during:           'During the work',
    after:            'After the work',
    vendor_doc:       'Vendor document',
    return_condition: 'Condition at return',
    other:            'Other'
  };
  var PRIVATE_MEDIA_ROLES = ['invoice', 'serial_label', 'vendor_doc'];

  // ── Legal stages per service type (v2 tickets). Mirrors SQL svc_stage_legal.
  var STAGES_BY_TYPE = {
    in_store: ['logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','rma_raised',
               'at_vendor','back_from_vendor','in_service','verifying','ready','closed'],
    on_site:  ['logged','scheduled','en_route','on_site','work_done','revisit_needed','quoted','approved',
               'parts_to_order','parts_on_order','rma_raised','at_vendor','back_from_vendor','closed'],
    remote:   ['logged','session_booked','in_session','resolved','quoted','closed']
  };

  // Written only by the RMA sync on a v2 ticket, so never offered by hand.
  var MIRROR_STAGES = ['rma_raised', 'at_vendor', 'back_from_vendor'];
  var MIRROR = { rma_raised: true, at_vendor: true, back_from_vendor: true };

  // Stages whose clock is the booked visit / session time, not idle days.
  var VISIT_STAGES = { scheduled: true, en_route: true, session_booked: true };

  // The shop has finished its part: a promised date no longer applies.
  var DONE_STAGES = { ready: true, closed: true, work_done: true, resolved: true };

  // A person is on the way to / working with the customer. The sentence for
  // these is the stage's own customer wording (see waitingSentence).
  var FIELD_STAGES = { scheduled: true, en_route: true, on_site: true, revisit_needed: true,
                       session_booked: true, in_session: true };

  // Idle budgets per type (days). null = the visit rule is the clock instead.
  var BUDGET_BY_TYPE = {
    in_store: {
      logged: 1, received: 1, diagnosing: 2, quoted: 3, approved: 2, parts_to_order: 1, parts_on_order: 7,
      rma_raised: 1, at_vendor: 14, back_from_vendor: 1, in_service: 3, verifying: 1, ready: 3
    },
    on_site: {
      logged: 0.5, scheduled: null, en_route: null, on_site: 0.5, work_done: 2, revisit_needed: 1,
      quoted: 3, approved: 2, parts_to_order: 1, parts_on_order: 7, rma_raised: 1, at_vendor: 14,
      back_from_vendor: 1
    },
    remote: {
      logged: 0.1667, session_booked: null, in_session: 0.125, resolved: 1, quoted: 3
    }
  };

  // Type conversion keeps the ticket and its tracking code; only the type and
  // the stage change. These are the stages the UI proposes (spec §2.9).
  var CONVERSION_TARGETS = {
    'remote>in_store': 'logged',
    'remote>on_site':  'logged',
    'on_site>in_store': 'received',
    'in_store>on_site': 'logged',
    // SPEC-GAP: the spec lists four conversions. The two into remote are not
    // listed; 'logged' is legal in every type and claims nothing about where
    // the machine is, so it is the safe landing stage.
    'in_store>remote': 'logged',
    'on_site>remote':  'logged'
  };

  // ═══ v1 functions (behaviour unchanged) ═══════════════════════════════════

  function stageDef(stage) { return own(STAGES, stage) || null; }
  function isKnownStage(stage) { return has(STAGES, stage); }

  function ballOf(stage) {
    var d = own(STAGES, stage);
    return d ? d.ball : BALL.SHOP;   // an unknown stage is our problem, not the customer's
  }

  function staffLabel(stage) {
    var d = own(STAGES, stage);
    return d ? d.staff : (stage || 'Unknown');
  }

  // The customer's wording. `closed` has none of its own — it is composed from
  // the outcome, so "Closed" never appears to a customer without saying what
  // actually happened to their machine.
  function customerLabel(job) {
    if (!job) return '';
    var d = own(STAGES, job.stage);
    if (!d) return 'In progress';
    if (job.stage === 'closed') return own(OUTCOMES, job.outcome) || 'Closed';
    return d.customer;
  }

  function nextStages(jobKind, stage) {
    var list = own(STAGES_BY_KIND, jobKind) || STAGES_BY_KIND.repair_outside;
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
  // Works for RMA units too (same stage_since column).
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

  // The v1 risk rule, verbatim. Kept as its own function so a job without
  // service_type (a cache filled before the migration, or the live website
  // reading an old row shape) gets exactly the answer it got before.
  function legacyServiceRisk(job, t) {
    var promised = _ms(job.promised_at || job.promisedAt);
    if (promised != null && promised <= t) return 2;

    var budget = own(IDLE_BUDGET_DAYS, job.stage);
    if (budget == null) return 0;
    var idle = daysInStage(job, t);
    if (idle >= budget) return 2;
    if (idle >= budget * 0.75) return 1;

    // Promised within a day and not yet finished is worth a nudge even when the
    // current stage is comfortably inside its own budget.
    if (promised != null && promised - t <= DAY) return 1;
    return 0;
  }

  // 0 ok | 1 soon | 2 breached. One monotonic ordinal so a caller can compare,
  // sort and pick a colour without re-deriving anything.
  //
  // A broken promise always outranks an idle budget: a date given to a customer
  // is a commitment, and the budget is only an internal expectation. A booked
  // visit is the same kind of commitment, so it comes next.
  function serviceRisk(job, now) {
    if (!job || job.stage === 'closed') return 0;
    var t = now || Date.now();
    if (job.service_type == null || job.service_type === '') return legacyServiceRisk(job, t);

    var stage = job.stage;
    var done = has(DONE_STAGES, stage);
    var promised = _ms(job.promised_at || job.promisedAt);
    if (promised != null && promised <= t && !done) return 2;

    var budget;
    if (has(VISIT_STAGES, stage)) {
      if (_ms(job.visit_start) != null) {
        var v = visitRisk(job, t);
        if (v) return v;
        budget = null;            // the booked time is the clock here, not idle days
      } else {
        budget = 0.5;             // nobody booked a time: half a day is already too long
      }
    } else {
      budget = _budgetFor(typeOf(job), stage);
    }

    if (budget != null) {
      var idle = daysInStage(job, t);
      if (idle >= budget) return 2;
      if (idle >= budget * 0.75) return 1;
    }

    // SPEC-GAP: the v1 rule nudged on a near promise in any stage. For a typed
    // job the shop is finished in a done stage, so a near promise is no longer
    // a risk there — same exclusion as the broken-promise rule above.
    if (promised != null && !done && promised - t <= DAY) return 1;
    return 0;
  }

  // A short, honest sentence for the top of the customer's status page. This is
  // the thing the owner asked for: not "which stage", but whose turn it is.
  function waitingSentence(job) {
    if (!job) return '';
    if (job.stage === 'closed') return own(OUTCOMES, job.outcome) || 'Closed';
    var ball = ballOf(job.stage);
    var who = job.waiting_party || job.waitingParty;
    var label = customerLabel(job) || '';
    // Field and remote stages describe a person coming to the customer, not an
    // item sitting with us, so "With us — our technician is on the way" would
    // be wrong. Their own wording already says whose turn it is.
    if (has(FIELD_STAGES, job.stage)) return label;
    // Some customer labels already open with "Waiting", so prefixing produces
    // "Waiting for you — waiting for your go-ahead". Use the label alone when it
    // already carries the wait. A label that already carries its own clause
    // ("Work done — tell us if…") reads badly with a second dash.
    var selfCarrying = /^waiting\b/i.test(label);
    if (ball === BALL.CUSTOMER) {
      if (!selfCarrying && label.indexOf(' — ') !== -1) return label;
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
  // ═══ v2 service functions ═════════════════════════════════════════════════

  function typeOf(job) {
    var t = job && job.service_type;
    return has(TYPES, t) ? t : 'in_store';
  }

  function isV2(job) { return !!job && Number(job.model_version) >= 2; }

  function isMirrorStage(stage) { return has(MIRROR, stage); }

  function isVisitStage(stage) { return has(VISIT_STAGES, stage); }

  // ready and closed are the two stages that need an outcome, and the fields
  // they set (outcome, ready_at, closed_at, closed_by) are cleared on reopen.
  function isTerminal(stage) { return stage === 'ready' || stage === 'closed'; }

  // Mirrors SQL svc_stage_legal(type, stage).
  function stageLegalFor(type, stage) {
    var list = own(STAGES_BY_TYPE, type);
    return !!list && list.indexOf(stage) !== -1;
  }

  // The idle budget for a stage of a type, in days, or null when the stage has
  // no idle budget (closed, a visit stage, or a stage that type never uses).
  function budgetDays(type, stage) {
    var table = own(BUDGET_BY_TYPE, type) || BUDGET_BY_TYPE.in_store;
    return has(table, stage) ? table[stage] : null;
  }

  // SPEC-GAP: a v1 row may sit in any known stage whatever its type (old
  // clients write stage freely), and a converted ticket can carry a stage the
  // new type's table lacks. Rather than calling such a job "never late", use
  // the first table that does budget that stage.
  function _budgetFor(type, stage) {
    var mine = own(BUDGET_BY_TYPE, type) || BUDGET_BY_TYPE.in_store;
    if (has(mine, stage)) return mine[stage];
    var order = ['in_store', 'on_site', 'remote'];
    for (var i = 0; i < order.length; i++) {
      var tb = BUDGET_BY_TYPE[order[i]];
      if (has(tb, stage) && tb[stage] != null) return tb[stage];
    }
    return null;
  }

  // The visit rule: a booked on-site visit or remote session is a promise with
  // a clock time. Late once we are 30 minutes past the start and still have not
  // arrived / started; "soon" from an hour before the start while nobody has
  // left the shop yet.
  function visitRisk(job, now) {
    if (!job) return 0;
    var start = _ms(job.visit_start);
    if (start == null) return 0;
    var t = now || Date.now();
    var st = job.stage;
    if (has(VISIT_STAGES, st) && t > start + 30 * MIN) return 2;
    if (st === 'scheduled' && t >= start - 60 * MIN) return 1;
    return 0;
  }

  // What the Move box offers. A v2 ticket gets its type's stages minus the
  // mirror stages (the RMA module drives those); a v1 ticket keeps the old
  // per-kind list exactly.
  function nextStagesFor(job) {
    if (!job) return [];
    if (isV2(job)) {
      var list = STAGES_BY_TYPE[typeOf(job)];
      return list.filter(function (s) { return s !== job.stage && !has(MIRROR, s); });
    }
    return nextStages(job.job_kind, job.stage);
  }

  // Outcomes worth offering for this ticket, most likely first. Any key of
  // OUTCOMES is accepted by the server; this only orders the select.
  function outcomesFor(job) {
    if (!job || !job.service_type) return Object.keys(OUTCOMES);
    var t = typeOf(job);
    if (t === 'on_site') {
      return ['resolved_on_site', 'repaired', 'no_fault_found', 'declined', 'unrepairable',
              'replaced_under_warranty', 'returned_rma_pending', 'cancelled'];
    }
    if (t === 'remote') {
      return ['resolved_remotely', 'no_fault_found', 'declined', 'unrepairable', 'cancelled'];
    }
    return ['repaired', 'unrepairable', 'declined', 'no_fault_found', 'replaced_under_warranty',
            'returned_rma_pending', 'cancelled'];
  }

  // ── The queue: open and nobody has taken it. Derived, never stored.
  function inQueue(job) {
    return !!job && job.stage !== 'closed' && !job.assignee_email;
  }

  // How many hours a ticket may wait for somebody to take it.
  function queueBudgetHours(job) {
    var p = job && job.priority;
    if (p === 'urgent') return 1;
    if (p === 'high') return 4;
    if (p === 'low') return 24;
    // normal (and anything unrecognised): an on-site request needs a visit
    // planned, not an immediate pair of hands, so it gets a working day.
    return typeOf(job) === 'on_site' ? 8 : 4;
  }

  function queueRisk(job, now) {
    if (!inQueue(job)) return 0;
    var since = _ms(job.queued_at);
    if (since == null) since = _ms(job.created_at || job.createdAt);
    if (since == null) return 0;
    var hours = Math.max(0, ((now || Date.now()) - since) / HOUR);
    var budget = queueBudgetHours(job);
    if (hours >= budget) return 2;
    if (hours >= budget * 0.75) return 1;
    return 0;
  }

  // The stage a type conversion lands on, or null when it is not a conversion.
  function conversionTarget(fromType, toType) {
    if (!has(TYPES, fromType) || !has(TYPES, toType) || fromType === toType) return null;
    return own(CONVERSION_TARGETS, fromType + '>' + toType) || null;
  }

  function typeLabel(type) { return has(TYPES, type) ? TYPES[type].label : (type || ''); }
  function channelLabel(ch) { return has(CHANNELS, ch) ? CHANNELS[ch] : (ch || ''); }
  function categoryLabel(c) { return has(CATEGORIES, c) ? CATEGORIES[c] : (c || ''); }
  function priorityRank(p) { return has(PRIORITIES, p) ? PRIORITIES[p].rank : PRIORITIES.normal.rank; }
  function itemKindLabel(k) { return has(ITEM_KINDS, k) ? ITEM_KINDS[k] : (k ? String(k) : 'Item'); }
  function dataConsentLabel(c) { return has(DATA_CONSENTS, c) ? DATA_CONSENTS[c] : (c ? String(c) : 'Not asked'); }
  // The answer → has_customer_data. Everything but "No important data on it"
  // means there is data on the device (backed up or not, it is the
  // customer's); null when the question was not asked, so a missing answer is
  // never recorded as "no data".
  function hasCustomerDataFor(c) {
    if (!c || !has(DATA_CONSENTS, c)) return null;
    return c !== 'no_important_data';
  }
  // The options a form offers: the three choices, plus the job's own legacy
  // answer (so a select painted from an old row shows what it holds instead of
  // silently changing it on the next save).
  function dataConsentOptions(current) {
    var out = DATA_CONSENT_CHOICES.slice();
    if (current && DATA_CONSENT_LEGACY.indexOf(current) !== -1) out.push(current);
    return out;
  }

  // Displayed role of a media row: the role if set, else the v1 phase
  // ('intake' photos were condition photos).
  function mediaRoleOf(row) {
    if (!row) return 'other';
    if (row.role) return row.role;
    if (!row.phase || row.phase === 'intake') return 'condition';
    return row.phase;
  }
  function isPrivateMediaRole(role) { return PRIVATE_MEDIA_ROLES.indexOf(role) !== -1; }

  // ═══ RMA model (one row per physical part = rma_cases) ═══════════════════

  var RMA_STAGES = {
    logged:            { staff: 'Expected — not in hand',          customer: "We're expecting your part",                          ball: BALL.CUSTOMER },
    // A part our technician pulled on a site visit (source 'field'). It is
    // ours, but not at the counter yet: bringing it in is our job (A8).
    with_tech:         { staff: 'With our technician',             customer: 'Your part is with our technician',                   ball: BALL.SHOP },
    received:          { staff: 'Received',                        customer: 'Your part is with us',                               ball: BALL.SHOP },
    testing:           { staff: 'Testing',                         customer: "We're checking the part",                            ball: BALL.SHOP },
    awaiting_docs:     { staff: 'Waiting on documents / approval', customer: 'Waiting for you — we need a document or your approval', ball: BALL.CUSTOMER },
    ready_to_ship:     { staff: 'Ready to ship to vendor',         customer: 'Warranty claim being prepared',                      ball: BALL.SHOP },
    with_vendor:       { staff: 'With vendor',                     customer: 'With the manufacturer under warranty',               ball: BALL.THIRD_PARTY },
    back_from_vendor:  { staff: 'Back from vendor',                customer: 'Back from the manufacturer',                         ball: BALL.SHOP },
    customer_decision: { staff: 'Waiting on customer decision',    customer: 'Waiting for your decision',                          ball: BALL.CUSTOMER },
    // ball and wording depend on return_method — see rmaBallOf / rmaCustomerLabel.
    // These defaults are the 'collect' case (the column default).
    ready_to_return:   { staff: 'Ready to return',                 customer: 'Ready to collect',                                   ball: BALL.CUSTOMER },
    returning:         { staff: 'Returning by courier',            customer: 'On its way back to you',                             ball: BALL.THIRD_PARTY },
    closed:            { staff: 'Closed',                          customer: null /* composed from disposition */,                 ball: BALL.NOBODY }
  };

  var RMA_ORDER = Object.keys(RMA_STAGES);

  // Mirrors SQL rma_transition_ok(from, to). with_vendor is entered only by the
  // dispatch action and left only by the vendor-result action; see rmaActions.
  // with_tech (A8): the technician brings it in, hands it straight to the
  // vendor, or the claim is withdrawn. with_vendor → returning (A10) is the
  // vendor shipping straight to the customer.
  var RMA_TRANSITIONS = {
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

  // Stages reached only through a dedicated action, never the plain Move box.
  var RMA_ACTION_ONLY = { with_vendor: true, back_from_vendor: true };

  // A holding unit in one of these keeps its ticket waiting (spec §2.6, A2).
  var RMA_PRE_RETURN = ['with_tech', 'logged', 'received', 'testing', 'awaiting_docs', 'ready_to_ship', 'with_vendor'];

  // Customer wording for each way an RMA can end.
  var RMA_DISPOSITIONS = {
    refitted:              'Fitted back in your device',
    replaced:              'Replaced under warranty',
    repaired:              'Repaired under warranty',
    credit_note:           'Settled with the manufacturer by credit',
    rejected_returned:     'Warranty claim declined — part returned',
    no_fault_found:        'No fault found — part returned',
    out_of_warranty:       'Out of warranty — part returned',
    withdrawn:             'Claim withdrawn',
    converted_to_repair:   'Moved to a paid repair',
    restocked:             'Replaced from our stock',
    scrapped_with_consent: 'Disposed of with your consent',
    lost_compensated:      'Settled for a lost part'
  };

  var RMA_VENDOR_RESULTS = {
    replaced:            'Replaced',
    repaired:            'Repaired',
    credit_note:         'Credit note',
    rejected:            'Rejected',
    lost:                'Lost',
    // A10: the vendor sends the part (usually a replacement) straight to the
    // customer, so it never comes back through the shop.
    shipped_to_customer: 'Shipped straight to the customer'
  };

  // A11: a drive can carry the customer's data, so it does not leave the shop
  // until somebody has said, in plain words, what happened to that data.
  var DATA_HANDLING = {
    wiped_by_us:         'We wiped it',
    customer_consents:   'Customer agreed to send it with data',
    unreadable_informed: 'Drive unreadable — customer informed'
  };
  var DATA_HANDLING_KINDS = ['ssd', 'hdd'];

  // A9: how a parcel goes to the vendor. Only a courier has an AWB.
  var SHIPMENT_MODES = {
    courier:       'Courier',
    hand_delivery: 'Hand delivered',
    vendor_pickup: 'Vendor picked it up',
    bus_parcel:    'Bus parcel'
  };

  var VENDOR_KINDS = {
    brand:          'Brand',
    distributor:    'Distributor',
    service_centre: 'Service centre'
  };

  var FEE_STATUSES = {
    n_a:      'No fee',
    quoted:   'Quoted',
    accepted: 'Accepted — not paid',
    paid:     'Paid',
    waived:   'Waived'
  };

  var RMA_SOURCES = {
    from_ticket: 'From a ticket',
    walk_in:     'Walk-in',
    courier:     'Courier',
    field:       'Pulled on site',
    stock:       'Shop stock',
    website:     'Website'
  };

  var SENDER_KINDS = {
    customer:         'Customer',
    third_party_tech: 'Third-party technician',
    our_tech:         'Our technician',
    shop:             'Shop'
  };

  var DIAGNOSED_BY = {
    us:          'Us',
    third_party: 'Third-party technician',
    customer:    'Customer'
  };

  var RETURN_METHODS = {
    collect:     'Collect in store',
    courier:     'Courier back',
    with_device: 'With the device'
  };

  var RMA_COLUMNS = [
    { key: 'intake',   label: 'Just in',          hint: 'Expected or just received' },
    { key: 'shop',     label: 'On us',            hint: 'Testing, shipping, returning' },
    { key: 'customer', label: 'On the customer',  hint: 'Documents, decisions, collection' },
    { key: 'third',    label: 'On a third party', hint: 'Vendors and couriers' },
    { key: 'closed',   label: 'Closed today',     hint: 'Empties overnight' }
  ];

  var RMA_BUDGET_DAYS = {
    logged: 3, with_tech: 1, received: 1, testing: 2, awaiting_docs: 3, ready_to_ship: 3,
    with_vendor: 14 /* default; the vendor's typical_tat_days wins */,
    back_from_vendor: 1, customer_decision: 3,
    ready_to_return: 5 /* collect; courier and with_device are 1 */,
    returning: 4
  };
  var RMA_RETURN_BUDGET = { collect: 5, courier: 1, with_device: 1 };

  function _unit(u) { return (typeof u === 'string') ? { stage: u } : (u || null); }
  function _method(u) { return has(RETURN_METHODS, u && u.return_method) ? u.return_method : 'collect'; }

  function rmaStageDef(stage) { return own(RMA_STAGES, stage) || null; }

  function rmaStaffLabel(stage) {
    var d = own(RMA_STAGES, stage);
    return d ? d.staff : (stage || 'Unknown');
  }

  // Ready to return is the customer's turn only when they have to come in; a
  // courier return or a refit into their PC is still our work.
  function rmaBallOf(unit) {
    var u = _unit(unit);
    if (!u) return BALL.SHOP;
    if (u.stage === 'ready_to_return') {
      return _method(u) === 'collect' ? BALL.CUSTOMER : BALL.SHOP;
    }
    var d = own(RMA_STAGES, u.stage);
    return d ? d.ball : BALL.SHOP;
  }

  function rmaCustomerLabel(unit) {
    var u = _unit(unit);
    if (!u) return '';
    var d = own(RMA_STAGES, u.stage);
    if (!d) return 'In progress';
    if (u.stage === 'closed') return own(RMA_DISPOSITIONS, u.disposition) || 'Closed';
    if (u.stage === 'ready_to_return') {
      var m = _method(u);
      if (m === 'courier') return 'Being packed for return';
      // SPEC-GAP: the spec words collect and courier only. A part going back
      // inside the customer's own PC is being refitted, not waiting for them.
      if (m === 'with_device') return 'Being fitted back in your device';
      return 'Ready to collect';
    }
    return d.customer;
  }

  function rmaTransitionOk(from, to) {
    var list = own(RMA_TRANSITIONS, from);
    return !!list && list.indexOf(to) !== -1;
  }

  // What the plain Move box offers. with_vendor / back_from_vendor (and the
  // lost-in-transit jump to customer_decision) come only from rmaActions.
  function rmaNextStages(unit) {
    var u = _unit(unit);
    if (!u) return [];
    if (u.stage === 'with_vendor') return [];
    var list = own(RMA_TRANSITIONS, u.stage) || [];
    return list.filter(function (s) { return !has(RMA_ACTION_ONLY, s); });
  }

  function rmaActions(unit) {
    var u = _unit(unit);
    if (!u) return [];
    if (u.stage === 'ready_to_ship') return ['dispatch'];
    if (u.stage === 'with_vendor') return ['vendor_result'];
    return [];
  }

  function rmaBudgetDays(unit, vendor) {
    var u = _unit(unit);
    if (!u) return null;
    var st = u.stage;
    if (st === 'with_vendor') {
      var tat = vendor ? Number(vendor.typical_tat_days) : NaN;
      return (tat > 0) ? tat : RMA_BUDGET_DAYS.with_vendor;
    }
    if (st === 'ready_to_return') return RMA_RETURN_BUDGET[_method(u)];
    return has(RMA_BUDGET_DAYS, st) ? RMA_BUDGET_DAYS[st] : null;
  }

  // 0 ok | 1 soon | 2 breached, same ordinal as serviceRisk.
  function rmaRisk(unit, now, vendor) {
    var u = _unit(unit);
    if (!u || u.stage === 'closed') return 0;
    var t = now || Date.now();
    // At a vendor the date we expect it back is the real clock: the dispatch
    // set it from the vendor's own turnaround, and a chase is due when it
    // passes, however long the part has been there.
    if (u.stage === 'with_vendor') {
      var exp = _ms(u.expected_back_at);
      if (exp != null) {
        if (t >= exp) return 2;
        var since = _ms(u.stage_since);
        var span = since != null ? exp - since : null;
        // SPEC-GAP: "soon" is the last quarter of the expected wait, the same
        // 0.75 proportion every other budget uses.
        if (span != null && span > 0 && (exp - t) <= span * 0.25) return 1;
        return 0;
      }
    }
    var budget = rmaBudgetDays(u, vendor);
    if (budget == null) return 0;
    var idle = daysInStage(u, t);
    if (idle >= budget) return 2;
    if (idle >= budget * 0.75) return 1;
    return 0;
  }

  // "Just in" is everything still to be booked in at the counter: expected
  // from the customer, on its way in with our technician, or just received.
  function rmaColumnOf(unit) {
    var u = _unit(unit);
    if (!u) return 'shop';
    if (u.stage === 'closed') return 'closed';
    if (u.stage === 'logged' || u.stage === 'with_tech' || u.stage === 'received') return 'intake';
    var ball = rmaBallOf(u);
    if (ball === BALL.CUSTOMER) return 'customer';
    if (ball === BALL.THIRD_PARTY) return 'third';
    return 'shop';
  }

  // A13: the maker the CUSTOMER is told about — the part's own brand when it
  // is known, else the vendor's public name. Never vendor.name: that is our
  // internal name and may be a distributor's, which means nothing to them.
  function customerFacingMaker(unit, vendor) {
    var u = unit || {};
    return trim(u.brand) || trim(vendor && vendor.public_name) || trim(u.vendor_public_name) || '';
  }

  // Same discipline as waitingSentence. Who we wait on at a vendor: the
  // public RPC already returns it as waiting_party (A13 applied server-side);
  // staff screens pass the vendor row and the unit's brand decides.
  function rmaWaitingSentence(unit, vendor) {
    var u = _unit(unit);
    if (!u) return '';
    if (u.stage === 'closed') return own(RMA_DISPOSITIONS, u.disposition) || 'Closed';
    var ball = rmaBallOf(u);
    var label = rmaCustomerLabel(u) || '';
    // "With us — your part is with our technician" says it twice.
    if (u.stage === 'with_tech') return label;
    var selfCarrying = /^waiting\b/i.test(label);
    if (ball === BALL.CUSTOMER) {
      return selfCarrying ? label : 'Waiting for you — ' + label.toLowerCase();
    }
    if (ball === BALL.THIRD_PARTY) {
      var who;
      if (u.stage === 'returning') {
        // A10: a vendor shipping straight to the customer is who we wait on
        // when nobody typed the courier's name.
        who = trim(u.return_courier) ||
              (u.vendor_result === 'shipped_to_customer' ? customerFacingMaker(u, vendor) : '') ||
              'the courier';
      } else {
        who = trim(u.waiting_party) || customerFacingMaker(u, vendor) || 'the manufacturer';
      }
      return 'Waiting for ' + who + ' — ' + label.toLowerCase();
    }
    return 'With us — ' + label.toLowerCase();
  }

  // Normalise whatever the caller has about the unit's media into a role set:
  // ['serial_label', …], media rows, or {role: count}.
  function _roleSet(mediaRoles) {
    var set = {};
    if (!mediaRoles) return set;
    if (Array.isArray(mediaRoles)) {
      mediaRoles.forEach(function (r) {
        var k = (r && typeof r === 'object') ? mediaRoleOf(r) : r;
        if (k) set[k] = true;
      });
    } else if (typeof mediaRoles === 'object') {
      Object.keys(mediaRoles).forEach(function (k) { if (mediaRoles[k]) set[k] = true; });
    }
    return set;
  }

  function needsDataHandling(kind) { return DATA_HANDLING_KINDS.indexOf(kind) !== -1; }
  var DATA_GATE_MSG = 'Say what happened to the data on the drive — wiped, customer agreed, or unreadable.';

  // Human reasons a move would be refused, mirroring the SQL gates (§1.4).
  // Empty array = ok. Pass the unit MERGED with the values about to be sent
  // (vendor_result, replacement_serial, return_awb, disposition), so the check
  // sees what the server will see.
  //
  // mediaRoles: pass [] when you know the unit has no media. null/undefined
  // means "not loaded" and skips the photo checks — a false "add a photo"
  // would block a part that is fine, while a missed one is still caught by the
  // server with a readable NEO_GATE message.
  function rmaGateProblems(unit, toStage, mediaRoles) {
    var u = _unit(unit);
    if (!u) return ['This part could not be found. Reopen it and try again.'];
    var out = [];
    var from = u.stage;
    if (toStage !== from && !rmaTransitionOk(from, toStage)) {
      out.push('A part at "' + rmaStaffLabel(from) + '" cannot move to "' + rmaStaffLabel(toStage) + '".');
      return out;
    }
    var mediaKnown = mediaRoles != null;
    var roles = _roleSet(mediaRoles);
    var fee = u.fee_status || 'n_a';

    if (toStage === 'ready_to_ship' || toStage === 'with_vendor') {
      if (!trim(u.serial)) out.push('Add the serial number (as printed on the label).');
      if (mediaKnown && !roles.serial_label) out.push('Add a photo of the serial label.');
      if (!u.purchase_source || u.purchase_source === 'unknown') {
        out.push('Say where it was bought: Neo Tokyo or elsewhere.');
      }
      if (u.vendor_id == null || u.vendor_id === '') out.push('Choose the vendor.');
      // A11: a drive leaves only once we have said what happened to its data.
      if (needsDataHandling(u.kind) && !has(DATA_HANDLING, u.data_handling)) out.push(DATA_GATE_MSG);
      if (u.purchase_source === 'elsewhere') {
        // A12: a screenshot of the brand's warranty-check page proves the
        // warranty as well as the invoice does.
        if (mediaKnown && !roles.invoice && !roles.vendor_doc) {
          out.push("Add the customer's invoice (or a warranty-check screenshot).");
        }
        if (fee !== 'accepted' && fee !== 'paid' && fee !== 'waived') {
          out.push(fee === 'quoted'
            ? 'The customer has not accepted the handling fee yet.'
            : "Quote the handling fee and get the customer's go-ahead.");
        }
      }
    }

    if (toStage === 'back_from_vendor') {
      if (!u.vendor_result) out.push("Record the vendor's result.");
      else if (u.vendor_result === 'shipped_to_customer') {
        out.push('The vendor sent it straight to the customer, so it goes to "' +
                 rmaStaffLabel('returning') + '", not back to us.');
      } else if (u.vendor_result === 'replaced' && !trim(u.replacement_serial)) {
        out.push('Add the serial of the replacement part.');
      }
    }

    if (toStage === 'returning') {
      if (from === 'with_vendor') {
        // A10: only the vendor's own shipment goes this way, and its AWB is
        // optional (the brand does not always share one).
        if (u.vendor_result !== 'shipped_to_customer') {
          out.push('Only a part the vendor shipped straight to the customer goes from the vendor to "' +
                   rmaStaffLabel('returning') + '".');
        }
      } else if (!trim(u.return_awb)) {
        out.push('Add the courier AWB for the return.');
      }
    }

    if (toStage === 'closed') {
      if (!u.disposition) out.push('Choose how it ended.');
      else if ((from === 'logged' || from === 'with_tech') && u.disposition !== 'withdrawn') {
        // A part that never reached the counter can only be withdrawn (§1.4:
        // logged → closed(withdrawn); A8: the same for with_tech).
        out.push('A part that never reached us can only close as withdrawn.');
      }
      if (fee !== 'n_a' && fee !== 'paid' && fee !== 'waived') {
        out.push('The handling fee is still ' + (own(FEE_STATUSES, fee) || fee).toLowerCase() +
                 '. Mark it paid or waived first.');
      }
    }
    return out;
  }

  // Dispositions that make sense for this unit right now, most likely first.
  // Any key is accepted by the server; this only orders the choice.
  function rmaDispositionsFor(unit) {
    var u = _unit(unit) || {};
    if (u.stage === 'logged' || u.stage === 'with_tech') return ['withdrawn'];
    var list;
    if (u.advance_replacement) list = ['restocked'];
    else if (u.vendor_result === 'shipped_to_customer') list = ['replaced', 'repaired'];   // A10
    else if (u.vendor_result === 'replaced') list = u.return_method === 'with_device' ? ['refitted', 'replaced'] : ['replaced', 'refitted'];
    else if (u.vendor_result === 'repaired') list = u.return_method === 'with_device' ? ['refitted', 'repaired'] : ['repaired', 'refitted'];
    else if (u.vendor_result === 'credit_note') list = ['credit_note', 'restocked'];
    else if (u.vendor_result === 'rejected') list = ['rejected_returned', 'converted_to_repair', 'scrapped_with_consent'];
    else if (u.vendor_result === 'lost') list = ['lost_compensated', 'restocked'];
    else list = ['no_fault_found', 'out_of_warranty', 'withdrawn', 'refitted'];
    Object.keys(RMA_DISPOSITIONS).forEach(function (k) { if (list.indexOf(k) === -1) list.push(k); });
    return list;
  }

  // "Graphics card — ASUS RTX 4070 Ti". Never includes the serial: this label
  // is used on public pages and in WhatsApp messages.
  function itemLabel(kind, brand, model) {
    var k = has(ITEM_KINDS, kind) ? ITEM_KINDS[kind] : '';
    var b = trim(brand), m = trim(model);
    // "ASUS" + "ASUS TUF B550" should not read "ASUS ASUS TUF B550".
    if (b && m && m.toLowerCase().indexOf(b.toLowerCase() + ' ') === 0) b = '';
    var bm = [b, m].filter(Boolean).join(' ');
    if (k && bm) return k + ' — ' + bm;
    return bm || k || 'Item';
  }

  function unitLabel(unit) {
    var u = unit || {};
    return itemLabel(u.kind, u.brand, u.model);
  }

  // ── The ticket ↔ part link ──────────────────────────────────────────────
  function isHolding(unit) {
    return !!unit && !!unit.holds_ticket && unit.stage !== 'closed';
  }

  // Open holding units of a ticket (spec §2.6: service_job_id = J, holds_ticket,
  // stage <> closed).
  function holdingUnitsOf(job, units) {
    var id = (job && typeof job === 'object') ? job.id : job;
    if (!id || !Array.isArray(units)) return [];
    return units.filter(function (u) { return u && u.service_job_id === id && isHolding(u); });
  }

  // The stage the server's rma_sync_ticket would move this ticket to, or null
  // when it would leave it alone. For display and tests only — the server is
  // the only writer.
  // SPEC-GAP: "has (or had) linked holding units" — a released unit no longer
  // says it held the ticket, so "had" is read as any linked unit still marked
  // holds_ticket, closed or not.
  function rmaSyncTarget(job, units) {
    if (!job) return null;
    var st = job.stage;
    if (st === 'ready' || st === 'closed' || st === 'work_done' || st === 'resolved') return null;
    var zone = ['logged', 'received', 'diagnosing', 'rma_raised', 'at_vendor', 'back_from_vendor',
                'revisit_needed', 'on_site'];
    if (zone.indexOf(st) === -1) return null;
    var linked = Array.isArray(units) ? units.filter(function (u) {
      return u && u.service_job_id === job.id && u.holds_ticket;
    }) : [];
    var pre = linked.filter(function (u) { return u.stage !== 'closed' && RMA_PRE_RETURN.indexOf(u.stage) !== -1; });
    if (pre.some(function (u) { return u.stage !== 'with_vendor'; })) return 'rma_raised';
    if (pre.length) return 'at_vendor';
    if (has(MIRROR, st) && linked.length) return 'back_from_vendor';
    return null;
  }

  // ── How a ticket reads while it waits on parts (A23) ────────────────────
  // A ticket in a mirror stage takes whose turn it is, its lane, how late it
  // is and its sentence from its most urgent HOLDING part: a part waiting on
  // the customer's invoice puts the ticket on the phone list, not the chase
  // list, because that is where the next action is. Urgency is the ball
  // first (customer, then shop, then a third party), then the part's risk,
  // then how long it has sat. The ticket's risk is the worst of its holding
  // parts. Any other ticket reads exactly as boardColumnOf / serviceRisk /
  // waitingSentence say. Board cards, the KPI strip and the Overview all
  // read through here, so they cannot disagree.
  // SPEC-GAP: A23 does not limit this to v2 tickets; a v1 ticket holding a
  // part is moved by the same RMA sync, so it reads the same way.
  var BALL_URGENCY = { customer: 0, shop: 1, third_party: 2, nobody: 3 };

  // vendorsById: { id: vendorRow } (ids as object keys, so bigint and demo
  // text ids both work), or an array of vendor rows, or a lookup function.
  function _vendorFor(unit, vendorsById) {
    if (!unit || unit.vendor_id == null || unit.vendor_id === '' || !vendorsById) return null;
    var id = String(unit.vendor_id);
    if (typeof vendorsById === 'function') {
      try { return vendorsById(unit.vendor_id) || null; } catch (e) { return null; }
    }
    if (Array.isArray(vendorsById)) {
      for (var i = 0; i < vendorsById.length; i++) {
        if (vendorsById[i] && String(vendorsById[i].id) === id) return vendorsById[i];
      }
      return null;
    }
    return own(vendorsById, id) || null;
  }

  function ticketWithUnits(job, units, vendorsById, now) {
    if (!job) return { ball: BALL.SHOP, column: 'shop', risk: 0, sentence: '', unit: null };
    var t = now || Date.now();
    var base = { ball: ballOf(job.stage), column: boardColumnOf(job), risk: serviceRisk(job, t),
                 sentence: waitingSentence(job), unit: null };
    if (job.stage === 'closed' || !has(MIRROR, job.stage)) return base;
    var hold = holdingUnitsOf(job, units);
    if (!hold.length) return base;

    var best = null, bestKey = null, worst = 0;
    hold.forEach(function (u) {
      var v = _vendorFor(u, vendorsById);
      var r = rmaRisk(u, t, v);
      if (r > worst) worst = r;
      var b = rmaBallOf(u);
      var key = [has(BALL_URGENCY, b) ? BALL_URGENCY[b] : 9, -r, -daysInStage(u, t)];
      if (!bestKey || key[0] < bestKey[0] ||
          (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = u; bestKey = key;
      }
    });
    var lane = rmaColumnOf(best);
    if (lane === 'closed') return base;
    return {
      ball: rmaBallOf(best),
      column: lane,
      risk: worst,
      sentence: unitLabel(best) + ': ' + rmaWaitingSentence(best, _vendorFor(best, vendorsById)),
      unit: best
    };
  }

  // Board lane for a ticket, given the units in cache. Kept for callers that
  // only need the lane; it is ticketWithUnits' column, so the two never differ.
  function ticketColumnOf(job, units, now) {
    return ticketWithUnits(job, units, null, now).column;
  }

  var api = {
    // v1 (unchanged behaviour)
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
    waitingSentence: waitingSentence,

    // v2 service vocabulary and rules
    TYPES: TYPES,
    CHANNELS: CHANNELS,
    CATEGORIES: CATEGORIES,
    PRIORITIES: PRIORITIES,
    ITEM_KINDS: ITEM_KINDS,
    PURCHASE_SOURCES: PURCHASE_SOURCES,
    DATA_CONSENTS: DATA_CONSENTS,
    DATA_CONSENT_CHOICES: DATA_CONSENT_CHOICES,
    DATA_CONSENT_LEGACY: DATA_CONSENT_LEGACY,
    REMOTE_TOOLS: REMOTE_TOOLS,
    ASSIGNED_VIA: ASSIGNED_VIA,
    MEDIA_ROLES: MEDIA_ROLES,
    PRIVATE_MEDIA_ROLES: PRIVATE_MEDIA_ROLES,
    STAGES_BY_TYPE: STAGES_BY_TYPE,
    MIRROR_STAGES: MIRROR_STAGES,
    BUDGET_BY_TYPE: BUDGET_BY_TYPE,
    budgetDays: budgetDays,
    visitRisk: visitRisk,
    typeOf: typeOf,
    isV2: isV2,
    isMirrorStage: isMirrorStage,
    isVisitStage: isVisitStage,
    isTerminal: isTerminal,
    stageLegalFor: stageLegalFor,
    nextStagesFor: nextStagesFor,
    outcomesFor: outcomesFor,
    inQueue: inQueue,
    queueBudgetHours: queueBudgetHours,
    queueRisk: queueRisk,
    conversionTarget: conversionTarget,
    typeLabel: typeLabel,
    channelLabel: channelLabel,
    categoryLabel: categoryLabel,
    priorityRank: priorityRank,
    itemKindLabel: itemKindLabel,
    dataConsentLabel: dataConsentLabel,
    hasCustomerDataFor: hasCustomerDataFor,
    dataConsentOptions: dataConsentOptions,
    mediaRoleOf: mediaRoleOf,
    isPrivateMediaRole: isPrivateMediaRole,

    // RMA model
    RMA_STAGES: RMA_STAGES,
    RMA_ORDER: RMA_ORDER,
    RMA_TRANSITIONS: RMA_TRANSITIONS,
    RMA_PRE_RETURN: RMA_PRE_RETURN,
    RMA_DISPOSITIONS: RMA_DISPOSITIONS,
    RMA_VENDOR_RESULTS: RMA_VENDOR_RESULTS,
    FEE_STATUSES: FEE_STATUSES,
    RMA_SOURCES: RMA_SOURCES,
    SENDER_KINDS: SENDER_KINDS,
    DIAGNOSED_BY: DIAGNOSED_BY,
    RETURN_METHODS: RETURN_METHODS,
    DATA_HANDLING: DATA_HANDLING,
    DATA_HANDLING_KINDS: DATA_HANDLING_KINDS,
    SHIPMENT_MODES: SHIPMENT_MODES,
    VENDOR_KINDS: VENDOR_KINDS,
    RMA_COLUMNS: RMA_COLUMNS,
    RMA_BUDGET_DAYS: RMA_BUDGET_DAYS,
    needsDataHandling: needsDataHandling,
    customerFacingMaker: customerFacingMaker,
    rmaStageDef: rmaStageDef,
    rmaBallOf: rmaBallOf,
    rmaStaffLabel: rmaStaffLabel,
    rmaCustomerLabel: rmaCustomerLabel,
    rmaTransitionOk: rmaTransitionOk,
    rmaNextStages: rmaNextStages,
    rmaActions: rmaActions,
    rmaBudgetDays: rmaBudgetDays,
    rmaRisk: rmaRisk,
    rmaColumnOf: rmaColumnOf,
    rmaWaitingSentence: rmaWaitingSentence,
    rmaGateProblems: rmaGateProblems,
    rmaDispositionsFor: rmaDispositionsFor,
    itemLabel: itemLabel,
    unitLabel: unitLabel,

    // ticket ↔ part link
    isHolding: isHolding,
    holdingUnitsOf: holdingUnitsOf,
    rmaSyncTarget: rmaSyncTarget,
    ticketWithUnits: ticketWithUnits,
    ticketColumnOf: ticketColumnOf
  };

  // ALWAYS set the browser global when a window exists (Electron renderers
  // define `module` too — see shared/matcher.js for the bug that taught us).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcService = api;
  }
})(typeof window !== 'undefined' ? window : this);
