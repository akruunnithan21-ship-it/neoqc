/*
  Neo Tokyo Operations — the module registry (window.NeoQcModules).

  Loaded right after app.js, before every other office script, so the rail,
  the switchScreen gate and the first-screen-after-login decision all read
  ONE list. Before this file the office side was "tier 3 or nothing", spread
  over three places (switchScreen, routeByTier, the rail), and a new screen
  had to be added to each by hand — the way one of them gets forgotten.

  Two inputs decide what a person may open:
    - their tier (profiles.tier, 1–5). Tier 3+ are leads in every module,
      exactly as the server's module_role() says.
    - their module roles from the server (rpc my_modules()), e.g. a tier-1
      counter clerk with service 'desk'. Cached on this PC per user id so a
      network blip at sign-in never strands anyone on the login screen.
    - their work pools (v1.11, sql/work-queue.sql): my_modules() also says
      whether they are in the build pool / the service pool and their build
      level. pools() reads them. Tier 3+ is a lead everywhere but is NOT in a
      pool unless the People screen put them in one.

  NOTHING HERE IS A SECURITY BOUNDARY. The server's RLS (svc_reader /
  rma_reader) decides what rows anyone can read; this keeps the UI honest so
  nobody is shown a door that will only refuse them.
*/
(function () {
  'use strict';

  var CACHE_KEY = 'neo_modules';
  var CACHE_MAX_USERS = 12;          // a shared office PC sees a handful of people
  var REFRESH_TIMEOUT_MS = 4000;
  var MODULE_KEYS = ['service', 'rma', 'qc', 'neohr'];
  var ROLE_RANK = { desk: 1, tech: 2, lead: 3 };
  var LEVELS = ['junior', 'senior'];
  var OFFICE_MODES = ['overview', 'queue', 'staff', 'service', 'rma'];

  // Rail order. `needs` is read only by canOpen() below; the rail never
  // interprets it itself, so the rule lives in one function. Shapes:
  //   { any: true }                      anyone signed in (overview: see canOpen)
  //   { tier: n }                        tier n or above
  //   { module: m, role: r }             role r or above in module m
  //   { anyOf: [ {module, role} | {tier}, … ] }   any ONE of them
  var REGISTRY = [
    { id: 'overview', label: 'Overview', icon: '◎', screenId: 'overview-screen', mode: 'overview', needs: { any: true } },
    // The one work queue (builds + service). Shows customer first names and
    // areas, so never { any: true }: build desk or service desk and up.
    { id: 'queue',    label: 'Queue',    icon: '⏱', screenId: 'queue-screen',    mode: 'queue',
      needs: { anyOf: [{ module: 'qc', role: 'desk' }, { module: 'service', role: 'desk' }] } },
    { id: 'builds',   label: 'Builds',   icon: '🖥', screenId: 'staff-screen',    mode: 'staff',    needs: { module: 'qc', role: 'desk' } },
    { id: 'service',  label: 'Service',  icon: '🔧', screenId: 'service-screen',  mode: 'service',  needs: { module: 'service', role: 'desk' } },
    { id: 'rma',      label: 'RMA',      icon: '📦', screenId: 'rma-screen',      mode: 'rma',      needs: { module: 'rma', role: 'desk' } },
    // Placeholder so the id is reserved; nothing can open it yet.
    { id: 'neohr',    label: 'NeoHR',    icon: '👥', screenId: null, mode: null, hidden: true },
    // The gap above Bench / Settings. shell.js recognises { spacer: true }.
    { id: 'spacer',   spacer: true },
    { id: 'bench',    label: 'Bench',    icon: '⚗', action: 'bench',
      needs: { anyOf: [{ module: 'qc', role: 'tech' }, { tier: 2 }] }, group: 'end' },
    { id: 'settings', label: 'Settings', icon: '⚙', action: 'settings', needs: { any: true }, group: 'end' }
  ];
  REGISTRY.forEach(function (e) {
    if (e.needs && Array.isArray(e.needs.anyOf)) {
      e.needs.anyOf.forEach(function (x) { Object.freeze(x); });
      Object.freeze(e.needs.anyOf);
    }
    if (e.needs) Object.freeze(e.needs);
    if (!e.group && !e.spacer) e.group = 'main';
    Object.freeze(e);
  });
  Object.freeze(REGISTRY);

  // In-memory answer for whoever is signed in now. { uid, data, source, at }
  var mem = null;
  var inflight = null;               // { uid, promise } — one my_modules() at a time per user

  function profile() {
    try { return (typeof currentProfile !== 'undefined' && currentProfile) || null; } catch (e) { return null; }
  }
  function client() {
    try { return (typeof supabaseClient !== 'undefined' && supabaseClient) || null; } catch (e) { return null; }
  }
  function uidOf(p) { return p ? String(p.id || p.email || '') : ''; }
  function tierOf(p) { return p ? (Number(p.tier) || 0) : 0; }
  function roleRank(r) { return ROLE_RANK[r] || 0; }

  // Only the keys we know, only roles we know. A malformed answer must never
  // widen access: an unknown role string ranks 0, the same as no role, and a
  // pool is on only when the server said exactly `true`.
  function normalise(data) {
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
    if (Array.isArray(data)) data = data[0];
    if (!data || typeof data !== 'object') return null;
    var out = { tier: Number(data.tier) || 0 };
    MODULE_KEYS.forEach(function (k) {
      var r = data[k];
      out[k] = (typeof r === 'string' && ROLE_RANK[r]) ? r : null;
    });
    out.build_pool = data.build_pool === true;
    out.service_pool = data.service_pool === true;
    out.build_level = LEVELS.indexOf(data.build_level) !== -1 ? data.build_level : null;
    return out;
  }

  // ── the per-user cache on this PC ──────────────────────────────────────────
  // Keyed by user id: two people share the counter PC, and the second must
  // never boot with the first one's roles.
  function readAll() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }
  function readCache(uid) {
    if (!uid) return null;
    var o = readAll()[uid];
    return o && o.data ? normalise(o.data) : null;
  }
  function writeCache(uid, data) {
    if (!uid) return;
    try {
      var all = readAll();
      all[uid] = { at: new Date().toISOString(), data: data };
      var ids = Object.keys(all);
      if (ids.length > CACHE_MAX_USERS) {
        ids.sort(function (a, b) { return String(all[a].at || '').localeCompare(String(all[b].at || '')); });
        ids.slice(0, ids.length - CACHE_MAX_USERS).forEach(function (k) { delete all[k]; });
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* storage full or blocked: the in-memory answer still works */ }
  }

  // The best answer we have for this profile without asking the server.
  function accessFor(p) {
    var uid = uidOf(p);
    if (!uid) return null;
    if (mem && mem.uid === uid) return mem.data;
    return readCache(uid);
  }

  function announce(source) {
    try {
      window.NeoQcModulesAccess = mem ? mem.data : null;
      window.dispatchEvent(new CustomEvent('neo-modules-changed', {
        detail: { uid: mem ? mem.uid : null, access: mem ? mem.data : null, source: source }
      }));
    } catch (e) { /* CustomEvent unsupported: listeners just miss one refresh */ }
  }

  function withTimeout(thenable, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('my_modules() did not answer within ' + ms + ' ms'));
      }, ms);
      Promise.resolve(thenable).then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t); reject(e);
      });
    });
  }

  // Asks the server, with a 4 s ceiling. NEVER rejects: routeByTier awaits it
  // at sign-in, and a slow or broken RPC (or a database that has not had the
  // migration yet) must degrade to "what this PC remembers", then to tier only.
  function refreshAccess() {
    var p = profile();
    var uid = uidOf(p);
    if (!uid) { mem = null; announce('signed-out'); return Promise.resolve(null); }
    if (inflight && inflight.uid === uid) return inflight.promise;

    var promise = (async function () {
      var fresh = null;
      var c = client();
      if (c && typeof c.rpc === 'function') {
        try {
          var r = await withTimeout(c.rpc('my_modules'), REFRESH_TIMEOUT_MS);
          if (r && r.error) throw r.error;
          fresh = normalise(r ? r.data : null);
        } catch (e) {
          console.warn('[modules] my_modules() failed, using the cached roles:', e && e.message);
          fresh = null;
        }
      }
      // Someone else may have signed in while we waited; their answer is not ours.
      if (uidOf(profile()) !== uid) return accessFor(profile());
      if (fresh) {
        mem = { uid: uid, data: fresh, source: 'server', at: Date.now() };
        writeCache(uid, fresh);
      } else {
        var cached = readCache(uid);
        mem = { uid: uid, data: cached, source: cached ? 'cache' : 'none', at: Date.now() };
      }
      announce(mem.source);
      return mem.data;
    })();

    inflight = { uid: uid, promise: promise };
    promise.then(function () { if (inflight && inflight.promise === promise) inflight = null; },
                 function () { if (inflight && inflight.promise === promise) inflight = null; });
    return promise;
  }

  // 'desk' | 'tech' | 'lead' | null. Tier 3+ → 'lead' in every module, the
  // same rule as the server's module_role().
  function roleFor(module, prof) {
    var p = prof === undefined ? profile() : prof;
    if (!p || p.active === false) return null;
    if (tierOf(p) >= 3) return 'lead';
    var a = accessFor(p);
    var r = a ? a[module] : null;
    return ROLE_RANK[r] ? r : null;
  }

  function hasRole(module, min, prof) {
    return roleRank(roleFor(module, prof)) >= roleRank(min || 'desk');
  }

  // { build, service, level } from my_modules(). Being a lead (tier 3+) does
  // NOT put anyone in a pool: the CEO is a lead everywhere and builds nothing.
  // Nobody signed in, or inactive → all off.
  function pools(prof) {
    var p = prof === undefined ? profile() : prof;
    var none = { build: false, service: false, level: null };
    if (!p || p.active === false) return none;
    var a = accessFor(p);
    if (!a) return none;
    return {
      build: a.build_pool === true,
      service: a.service_pool === true,
      level: LEVELS.indexOf(a.build_level) !== -1 ? a.build_level : null
    };
  }

  // ── registry lookups ───────────────────────────────────────────────────────
  function list() { return REGISTRY.slice(); }

  function get(id) {
    for (var i = 0; i < REGISTRY.length; i++) {
      if (!REGISTRY[i].spacer && REGISTRY[i].id === id) return REGISTRY[i];
    }
    return null;
  }

  function byMode(mode) {
    if (!mode) return null;
    for (var i = 0; i < REGISTRY.length; i++) {
      if (!REGISTRY[i].spacer && REGISTRY[i].mode === mode) return REGISTRY[i];
    }
    return null;
  }

  // An id first ('builds', 'bench'), then a mode ('staff', 'rma').
  function find(idOrMode) { return get(idOrMode) || byMode(idOrMode); }

  function labelOf(idOrMode) {
    var e = find(idOrMode);
    return (e && e.label) || String(idOrMode || 'that screen');
  }

  // DEFAULT-DENY: unknown ids and modes, hidden placeholders and the spacer
  // can never be opened; neither can anything without a signed-in profile.
  function canOpen(idOrMode, prof) {
    var e = find(idOrMode);
    if (!e || e.hidden || e.spacer) return false;
    var p = prof === undefined ? profile() : prof;
    if (!p || p.active === false) return false;
    var t = tierOf(p);
    var n = e.needs || null;
    if (!n) return false;

    // Overview shows only what the person may see, so it is open to a lead
    // (tier 3+) or to anyone holding a role in a module that feeds it. The
    // registry entry says { any: true } because that is its shape on the
    // rail; this is the rule behind it (SPEC §4.1).
    if (e.id === 'overview') return t >= 3 || !!roleFor('service', p) || !!roleFor('rma', p);

    if (n.any === true) return true;
    // { anyOf: [...] } — any ONE of the listed needs (OR). An empty or
    // malformed list opens nothing. Combined with tier/module below (AND).
    if (n.anyOf != null) {
      if (!Array.isArray(n.anyOf) || !n.anyOf.some(function (x) { return meets(x, p, t); })) return false;
      if (n.tier == null && !n.module) return true;
    }
    if (n.tier != null && t < Number(n.tier)) return false;
    if (n.module && roleRank(roleFor(n.module, p)) < roleRank(n.role || 'desk')) return false;
    return n.tier != null || !!n.module;
  }
  // One alternative of an anyOf list: { tier } or { module, role }.
  function meets(x, p, t) {
    if (!x || typeof x !== 'object') return false;
    if (x.module) return MODULE_KEYS.indexOf(x.module) !== -1 && roleRank(roleFor(x.module, p)) >= roleRank(x.role || 'desk');
    if (x.tier != null) { var need = Number(x.tier); return isFinite(need) && t >= need; }
    return false;
  }

  // Where to land after sign-in. null = the tier notice ("use the web portal").
  // WQ-C13: a pool flag alone never picks the queue — only when the queue
  // also opens for them (a pool left on after the role was removed falls
  // through to their next screen instead of the tier notice).
  function firstHome(prof) {
    var p = prof === undefined ? profile() : prof;
    if (!p || p.active === false) return null;
    var t = tierOf(p);
    if (t >= 3) return 'overview';
    var pl = pools(p);
    if ((pl.build || pl.service) && canOpen('queue', p)) return 'queue';
    if (roleFor('service', p)) return 'service';
    if (roleFor('qc', p)) return 'staff';
    if (roleFor('rma', p)) return 'rma';
    if (t === 2) return 'client';
    return null;
  }

  function officeModes() { return OFFICE_MODES.slice(); }
  function isOfficeMode(mode) { return OFFICE_MODES.indexOf(mode) !== -1; }

  // The raw answer for whoever is signed in (or null), for the data layer.
  function access() { return accessFor(profile()); }
  function accessSource() { var p = profile(); return (mem && p && mem.uid === uidOf(p)) ? mem.source : 'cache'; }

  window.NeoQcModules = {
    list: list,
    get: get,
    byMode: byMode,
    labelOf: labelOf,
    canOpen: canOpen,
    roleFor: roleFor,
    hasRole: hasRole,
    pools: pools,
    roleRank: roleRank,
    refreshAccess: refreshAccess,
    firstHome: firstHome,
    officeModes: officeModes,
    isOfficeMode: isOfficeMode,
    access: access,
    accessSource: accessSource,
    ROLES: ['desk', 'tech', 'lead']
  };
})();
