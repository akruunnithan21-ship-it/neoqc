/*
  ppi-sync.js — pure-JS port of ppi_sync.py (bridges data → ppi() → Supabase).

  v1.4.4 — was Python (invoked over IPC), so shop PCs without Python
  couldn't compute PPI. Now runs entirely in the renderer:
    1. Uses the in-memory catalogMatcher (already synced from Supabase on boot)
       so we don't re-fetch component_prices for every PPI call.
    2. Loads PassMark reference JSON via fetch() from the shipped
       assets/benchmarks/*.json (bundled with the app; no schema drift).
    3. Bridges retail catalog names → PassMark reference names via short-side
       token coverage (the direction fix from v1.4.1 — matching a short PM
       name inside a long retail name).
    4. Calls window.NeoQcPpi.ppi() (pure function, ppi.js).
    5. Upserts result into Supabase's ticket_ppi table.

  Kept in LOCKSTEP with ppi_sync.py — the Python version is now optional
  fallback for the CLI / cron use cases. Both write the same ticket_ppi row
  shape so the customer dashboard is agnostic to which one wrote it.

  Same both/and export pattern as the other shared modules.
*/
(function (global) {
  'use strict';

  var passmarkCache = null; // { cpu: {name: {passmark_score, single_thread_score}}, gpu: {name: {g3d_score}} }

  // ─── PassMark data load ─────────────────────────────────────────────

  async function _loadPassmarks() {
    if (passmarkCache) return passmarkCache;
    async function fetchJson(rel) {
      // Prefer the shipped copy — works both in dev and in a packaged app,
      // since Electron file:// resolves inside asar/asar.unpacked transparently.
      var res = await fetch(rel);
      if (!res.ok) throw new Error(rel + ' → HTTP ' + res.status);
      return await res.json();
    }
    var cpu = await fetchJson('assets/benchmarks/cpu_passmark.json');
    var gpu = await fetchJson('assets/benchmarks/gpu_passmark.json');
    passmarkCache = { cpu: cpu, gpu: gpu };
    return passmarkCache;
  }

  // ─── PassMark ↔ retail-catalog bridge ───────────────────────────────
  // Direction: score how much of the SHORT reference name is covered by the
  // long retail name (v1.4.1 fix). Uses NeoQcMatcher.score() / tokenize().

  function _bridgeMatch(retailName, referenceEntries) {
    if (!window.NeoQcMatcher) return { name: null, score: 0 };
    var tokenize = window.NeoQcMatcher.tokenize;
    var score = window.NeoQcMatcher.score;
    var retailTokens = new Set(tokenize(retailName));
    if (!retailTokens.size) return { name: null, score: 0 };

    var bestName = null, bestScore = 0;
    for (var name in referenceEntries) {
      if (!Object.prototype.hasOwnProperty.call(referenceEntries, name)) continue;
      var pmTokens = tokenize(name);
      if (!pmTokens.length) continue;
      var s = score(pmTokens, retailTokens);
      if (s > bestScore) { bestScore = s; bestName = name; }
    }
    return { name: bestName, score: bestScore };
  }

  // Build the benchmark_scores dict for every cpu/gpu inside the build's
  // price bands (plus the build's own components).
  async function _benchmarkScoresForPool(componentPrices, buildSpecs, priceBandPct) {
    var pm = await _loadPassmarks();
    var scores = {};
    var categories = [['cpu', 'passmark-cpu', pm.cpu], ['gpu', 'passmark-g3d', pm.gpu]];

    for (var ci = 0; ci < categories.length; ci++) {
      var category = categories[ci][0];
      var benchKey = categories[ci][1];
      var refEntries = categories[ci][2];

      var ownSku = buildSpecs[category];
      var own = ownSku ? componentPrices[ownSku] : null;

      var candidates = [];
      if (own) {
        candidates.push([ownSku, own]);
        if (own.price_inr != null) {
          var lo = own.price_inr * (1 - priceBandPct);
          var hi = own.price_inr * (1 + priceBandPct);
          Object.keys(componentPrices).forEach(function (sku) {
            var e = componentPrices[sku];
            if (e && e.category === category && e.price_inr != null && e.price_inr >= lo && e.price_inr <= hi && sku !== ownSku) {
              candidates.push([sku, e]);
            }
          });
        }
      }

      for (var i = 0; i < candidates.length; i++) {
        var sku = candidates[i][0];
        var entry = candidates[i][1];
        if (scores[sku]) continue;
        var bridge = _bridgeMatch(entry.name || '', refEntries);
        if (bridge.name && bridge.score >= 0.55) {
          var refRow = refEntries[bridge.name];
          if (category === 'cpu') {
            scores[sku] = { 'passmark-cpu': Number(refRow.passmark_score) };
            if (refRow.single_thread_score != null) {
              scores[sku]['passmark-cpu-st'] = Number(refRow.single_thread_score);
            }
          } else {
            scores[sku] = { 'passmark-g3d': Number(refRow.g3d_score) };
          }
        }
      }
    }
    return scores;
  }

  // ─── Main entry point ───────────────────────────────────────────────
  // ticketSpecs example (matches what app.js stores in tickets.specs):
  //   { cpu: 'AMD Ryzen 7 7800X3D 8-Core Desktop Processor',
  //     gpu: 'Zotac RTX 5070 Ti AMP Extreme Infinity 16Gb Graphics Card',
  //     mobo, ram, storage, psu, case, coolerType, coolerModel, os, ... }
  //
  // catalogMatcher: an instance of NeoQcMatcher.Matcher already loaded with
  // the full component_prices catalog (that's what app.js's catalog cache
  // already provides for the autocomplete).
  //
  // useCase: canonical use-case key ('gaming-1440p', 'office', …) or a
  // legacy alias handled by USE_CASE_ALIASES.

  var FIELD_CATEGORY = {
    cpu: 'cpu', gpu: 'gpu', ram: 'ram', storage: 'storage', psu: 'psu',
    case: 'case', mobo: 'motherboard', motherboard: 'motherboard',
    cooler: 'cooler', coolerModel: 'cooler'
  };

  async function computePpi(opts) {
    var ticketSpecs = opts.ticketSpecs || {};
    var catalogMatcher = opts.catalogMatcher;
    var useCase = opts.useCase || null;
    var priceBandPct = opts.priceBandPct != null ? opts.priceBandPct : 0.15;
    // Per-ticket stored prices — fallback for catalog rows that were still
    // null-priced when the tech picked them. Without this, a component with
    // a real price on the tech's side would still trigger PPI's "no price
    // on file" flag because the catalog snapshot happened at a bad time.
    // Shape: { cpu: 42000, gpu: 78000, ram: 5500, ... }
    var ticketPrices = opts.ticketPrices || {};
    // v1.4.5 — the caller passes the IPC fetch bridge + supabaseClient so
    // we can do live retailer lookups for any null-priced pick. Without
    // these two, we still compute but skip the auto-lookup.
    var fetchUrl = opts.fetchUrl || null;
    var supabaseClient = opts.supabaseClient || null;

    if (!window.NeoQcPpi) throw new Error('ppi.js not loaded');
    if (!window.NeoQcMatcher) throw new Error('matcher.js not loaded');
    if (!catalogMatcher || !catalogMatcher._entries) {
      throw new Error('catalog matcher not ready (still syncing?)');
    }

    // Resolve use-case (alias-aware)
    var canonical = null;
    if (useCase) canonical = window.NeoQcPpi.USE_CASE_ALIASES[useCase] || useCase;
    if (!canonical || !window.NeoQcPpi.USE_CASE_WEIGHTS[canonical]) canonical = 'office';
    var useCases = [canonical];
    var flagsExtra = [];
    if (canonical === 'office' && (!useCase || useCase !== 'office')) {
      flagsExtra.push("Use-case not set for this ticket — scored against 'office' defaults");
    }

    // Snapshot the catalog into a {sku: entry} map for ppi()
    var componentPrices = {};
    catalogMatcher._entries.forEach(function (e) {
      if (e.sku) componentPrices[e.sku] = { name: e.name, category: e.category, price_inr: e.priceInr };
    });

    // Match every spec field to its canonical category → catalog SKU
    var buildSpecs = {};
    Object.keys(ticketSpecs).forEach(function (field) {
      var text = ticketSpecs[field];
      var category = FIELD_CATEGORY[field];
      if (!text || !category) return;
      var m = catalogMatcher.match(text, category);
      if (m.sku && m.confidence >= 0.55) {
        buildSpecs[category] = m.sku;
      } else {
        flagsExtra.push(field + ": '" + String(text).slice(0, 40) + "' not matched to catalog (best " + Math.round((m.confidence || 0) * 100) + '%)');
      }
    });

    // Backfill null catalog prices from ticketPrices — see the ticketPrices
    // comment above for why. Do this AFTER matching so we know which SKU
    // maps to which category.
    Object.keys(buildSpecs).forEach(function (category) {
      var sku = buildSpecs[category];
      var stored = ticketPrices[category];
      if (componentPrices[sku] && componentPrices[sku].price_inr == null && stored != null) {
        componentPrices[sku] = Object.assign({}, componentPrices[sku], { price_inr: Number(stored) });
      }
    });

    // v1.4.5 — for any build-spec SKU that STILL has no price after the
    // ticketPrices backfill, run a live web-lookup (mdcomputers, primeabgb,
    // vishalperipherals, computechstore, vedantcomputers) and average the
    // real market price. Removes the persistent "gpu: no price on file"
    // flag on the PPI panel when the catalog was scraped when the item
    // was out-of-stock (₹0 → NULL). Best-effort: if the network is down
    // or no site has the item, we simply skip and the flag stays.
    var lookupTasks = [];
    Object.keys(buildSpecs).forEach(function (category) {
      var sku = buildSpecs[category];
      var entry = componentPrices[sku];
      if (!entry || entry.price_inr != null) return;
      if (!window.NeoQcWebLookup || !window.NeoQcWebLookup.lookup) return;
      if (!fetchUrl) return; // need the IPC bridge — main process must be reachable
      lookupTasks.push(
        (async function () {
          try {
            var res = await window.NeoQcWebLookup.lookup(entry.name, category, fetchUrl, supabaseClient);
            if (res && res.found && res.price_inr != null) {
              var newPrice = Number(res.price_inr);
              componentPrices[sku] = Object.assign({}, entry, { price_inr: newPrice });
              // Also patch the live catalog matcher so subsequent PPI runs
              // in this session see the price without another lookup.
              if (catalogMatcher && catalogMatcher._entries) {
                var live = catalogMatcher._entries.find(function (e) { return e.sku === sku; });
                if (live) live.priceInr = newPrice;
              }
              flagsExtra.push(category + ': price filled from live retailer lookup — ' + (res.price_sample_size || 1) + ' listing(s), avg ₹' + Math.round(newPrice));
            }
          } catch (e) {
            console.warn('PPI web-lookup for ' + category + ' failed:', e.message);
          }
        })()
      );
    });
    if (lookupTasks.length) {
      await Promise.all(lookupTasks);
    }

    if (!Object.keys(buildSpecs).length) {
      return {
        success: false,
        error: 'No spec matched the catalog — cannot compute PPI.',
        flags: flagsExtra
      };
    }

    // Bridge PassMark scores for the whole price-band pool
    var benchmarkScores;
    try {
      benchmarkScores = await _benchmarkScoresForPool(componentPrices, buildSpecs, priceBandPct);
    } catch (e) {
      return { success: false, error: 'PassMark load failed: ' + e.message };
    }

    // Run the pure engine
    var result = window.NeoQcPpi.ppi(buildSpecs, componentPrices, benchmarkScores, useCases, priceBandPct);
    var allFlags = (result.flags || []).concat(flagsExtra);

    var payload = {
      use_cases: useCases,
      price_band_pct: priceBandPct,
      index: result.index,
      customer_fit_score: result.customer_fit_score,
      per_component_scores: result.per_component_scores,
      in_range_comparisons: result.in_range_comparisons,
      flags: allFlags,
      source_note: 'ppi.js v1.4.4 (pure-JS port, ratio-to-best, ST-blend, no-Python)'
    };

    return { success: true, payload: payload, buildSpecs: buildSpecs };
  }

  // Upsert the payload into ticket_ppi. Caller passes the same supabaseClient
  // already used elsewhere in app.js so we don't build a second connection.
  async function upsertTicketPpi(supabaseClient, ticketId, payload) {
    var row = Object.assign({ ticket_id: String(ticketId) }, payload);
    var res = await supabaseClient.from('ticket_ppi').upsert(row, { onConflict: 'ticket_id' }).select();
    if (res.error) throw new Error(res.error.message || 'Supabase upsert failed');
    return res.data;
  }

  var api = { computePpi: computePpi, upsertTicketPpi: upsertTicketPpi };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcPpiSync = api;
  }
})(typeof window !== 'undefined' ? window : this);
