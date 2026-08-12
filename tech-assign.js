/*
  tech-assign.js — v2.0.0 Chunk C
  Technician auto-assignment engine + waiting queue.

  WHY THIS EXISTS
  The coordinator should not have to think about who is free. The app picks the
  technician using an internal skill model, so work spreads by real capacity
  instead of habit. Tiers are INTERNAL ONLY — never shown to the technicians,
  who are all treated as equals in the UI.

  THE MODEL (first pass — tune the numbers, not the logic)
  Every in-flight build costs its technician "load points" equal to the build's
  tier (T1 light = 1 … T5 exceptional = 5). Each technician has a point budget
  and a cap on how many builds they can juggle at once. A technician can take a
  build when BOTH fit. Derived from the shop's real capability:

    skill 1 (Adhil, Amal) — 6 pts / 3 jobs → two T3 builds at once (3+3=6, full),
                            or three T2 builds (2+2+2=6).
    skill 2 (Ananthakrishnan) — 6 pts / 3 jobs → one T3 + one T2 + one T1 (3+2+1).
    skill 3 (Athul) — 3 pts / 2 jobs → two T1 builds (1+1), or one single build
                            up to T3 (3 pts fills the budget).

  High-value work (tier 4-5) is restricted to the more experienced technicians
  via maxBuildTier, so an exceptional build never lands on the least experienced
  person. When nobody has room, the ticket goes to the WAITING QUEUE and is
  assigned automatically as soon as a technician frees up.

  Pure module: no DOM, no Electron, no network — so it is unit-testable and
  identical in the app and in Node. Uses the both/and export pattern (v1.3.2
  rule: always set the window global AND module.exports).
*/
(function () {
  // Cost of one in-flight build, by build tier (1 light … 5 exceptional).
  var TIER_COST = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };

  // Skill profiles. capacity = point budget, maxConcurrent = simultaneous jobs,
  // maxBuildTier = the most demanding build this skill level may be given.
  var SKILL_PROFILES = {
    1: { capacity: 6, maxConcurrent: 3, maxBuildTier: 5 },
    2: { capacity: 6, maxConcurrent: 3, maxBuildTier: 5 },
    3: { capacity: 3, maxConcurrent: 2, maxBuildTier: 3 }
  };

  // The shop roster, keyed by the technician name stored on tickets.
  // Keep in step with appState.technicians.
  var ROSTER = {
    'Adhil':           { skill: 1, fullName: 'Adhil M' },
    'Amal':            { skill: 1, fullName: 'Amal C Abi' },
    'Ananthakrishnan': { skill: 2, fullName: 'Ananthakrishnan A R' },
    'Athul':           { skill: 3, fullName: 'Athul Sudheer' }
  };

  function tierCost(tier) {
    var t = Number(tier) || 1;
    return TIER_COST[t] || t;
  }

  function profileFor(name) {
    var r = ROSTER[name];
    if (!r) return null;
    return SKILL_PROFILES[r.skill] || SKILL_PROFILES[3];
  }

  // A ticket occupies its technician until it is delivered/completed. Tickets
  // sitting in the queue are unassigned and cost nobody anything.
  function isActive(ticket) {
    if (!ticket) return false;
    if (ticket.queued) return false;
    return ticket.status !== 'completed' && ticket.status !== 'cancelled';
  }

  function buildTierOf(ticket) {
    var b = (ticket && ticket.specs && ticket.specs.__build) || {};
    return Number(b.tier) || 1;
  }

  // Current load for every roster technician, from the live ticket list.
  function computeLoads(tickets, roster) {
    var names = Object.keys(roster || ROSTER);
    var loads = {};
    names.forEach(function (n) { loads[n] = { name: n, points: 0, jobs: 0 }; });
    (tickets || []).forEach(function (t) {
      if (!isActive(t)) return;
      var n = t.technician;
      if (!n || !loads[n]) return;
      loads[n].points += tierCost(buildTierOf(t));
      loads[n].jobs += 1;
    });
    return loads;
  }

  /*
    pickTechnician(buildTier, tickets, opts) -> { technician, reason } | { technician: null, reason }

    Chooses the best-fitting free technician for a build of the given tier.
    Preference order among those who CAN take it:
      1. most remaining points (spreads the work rather than stacking it)
      2. for demanding builds (tier >= 4), the more experienced technician
      3. name, so the result is deterministic and testable
  */
  function pickTechnician(buildTier, tickets, opts) {
    opts = opts || {};
    var roster = opts.roster || ROSTER;
    var tier = Number(buildTier) || 1;
    var cost = tierCost(tier);
    var loads = computeLoads(tickets, roster);

    var candidates = Object.keys(roster).map(function (name) {
      var r = roster[name];
      var prof = SKILL_PROFILES[r.skill] || SKILL_PROFILES[3];
      var load = loads[name] || { points: 0, jobs: 0 };
      return {
        name: name,
        skill: r.skill,
        prof: prof,
        points: load.points,
        jobs: load.jobs,
        remaining: prof.capacity - load.points,
        eligible: tier <= prof.maxBuildTier,
        hasRoom: (load.points + cost) <= prof.capacity && (load.jobs + 1) <= prof.maxConcurrent
      };
    });

    var usable = candidates.filter(function (c) { return c.eligible && c.hasRoom; });
    if (!usable.length) {
      var anyEligible = candidates.some(function (c) { return c.eligible; });
      return {
        technician: null,
        queued: true,
        reason: anyEligible
          ? 'All technicians are at capacity — queued until one frees up.'
          : 'No technician is cleared for a build at this level — queued for review.'
      };
    }

    usable.sort(function (a, b) {
      if (b.remaining !== a.remaining) return b.remaining - a.remaining;   // most free room
      if (tier >= 4 && a.skill !== b.skill) return a.skill - b.skill;       // experience for big builds
      return a.name.localeCompare(b.name);
    });

    var win = usable[0];
    return {
      technician: win.name,
      queued: false,
      reason: 'Assigned to ' + win.name + ' — ' + win.remaining + ' of ' +
              win.prof.capacity + ' capacity free (' + win.jobs + ' build(s) in hand).'
    };
  }

  /*
    nextFromQueue(tickets, opts) — after a build completes, pull the longest-
    waiting queued ticket that somebody can now take. Returns the assignment or
    null when nothing can move yet. Oldest-first keeps it fair.
  */
  function nextFromQueue(tickets, opts) {
    var queued = (tickets || []).filter(function (t) { return t && t.queued; })
      .sort(function (a, b) { return new Date(a.createdAt || 0) - new Date(b.createdAt || 0); });
    for (var i = 0; i < queued.length; i++) {
      var res = pickTechnician(buildTierOf(queued[i]), tickets, opts);
      if (res.technician) return { ticket: queued[i], technician: res.technician, reason: res.reason };
    }
    return null;
  }

  // Human-readable capacity snapshot for the admin dashboard.
  function workloadSummary(tickets, opts) {
    var roster = (opts && opts.roster) || ROSTER;
    var loads = computeLoads(tickets, roster);
    return Object.keys(roster).map(function (name) {
      var prof = SKILL_PROFILES[roster[name].skill] || SKILL_PROFILES[3];
      var l = loads[name] || { points: 0, jobs: 0 };
      return {
        name: name,
        jobs: l.jobs,
        points: l.points,
        capacity: prof.capacity,
        free: prof.capacity - l.points,
        full: l.points >= prof.capacity || l.jobs >= prof.maxConcurrent
      };
    });
  }

  var api = {
    pickTechnician: pickTechnician,
    nextFromQueue: nextFromQueue,
    workloadSummary: workloadSummary,
    computeLoads: computeLoads,
    buildTierOf: buildTierOf,
    tierCost: tierCost,
    ROSTER: ROSTER,
    SKILL_PROFILES: SKILL_PROFILES,
    TIER_COST: TIER_COST
  };

  if (typeof window !== 'undefined') window.NeoQcTechAssign = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
