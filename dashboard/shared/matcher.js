/*
  Neo QC — shared token-set fuzzy matcher (JS port of matcher.py).

  Same strategy as matcher.py: order-independent token matching against a
  catalog of {name, sku, category, price_inr} entries, with model-number/spec
  tokens weighted higher than generic words and a category gate. Kept in
  lockstep with matcher.py's constants/algorithm intentionally — if you tune
  one, tune the other.

  Plain browser global (no build step, no module system), loaded via a
  single <script src="shared/matcher.js"> tag, same pattern as
  shared/diagnostics-render.js / shared/icons.js.

  Usage:
    const m = new NeoQcMatcher.Matcher(catalogArray); // [{name, sku, category, price_inr}, ...]
    const result = m.match("RTX 4060 Ventus 2X 8GB", "gpu");
    // result: { sku, matchedName, confidence, category, priceInr, autoAccepted, needsConfirm }
*/
(function (global) {
  var CONFIRM_THRESHOLD = 0.82; // auto-accept above this
  var SUGGEST_THRESHOLD = 0.55; // show as suggestion above this

  // Tokens that carry strong signal — model numbers, spec indicators.
  // Mirrors matcher.py's HIGH_WEIGHT_RE exactly (same alternation, JS regex).
  var HIGH_WEIGHT_RE = new RegExp(
    '^(' +
      'rtx|gtx|rx|arc|rdna|' +
      // Model numbers: pure 3-5 digit runs (4060) or digits + alnum tail
      // (9800x3d, 14700kf). Tail must START with a letter so long pure
      // part-number digit runs never qualify (see matcher.py).
      '[0-9]{3,5}[a-z][a-z0-9]*|[0-9]{3,5}|' +
      'x3d|xt|ti|super|oc|' +
      'ddr[45]?|cl[0-9]+|' +
      'nvme|sata|m2|pcie|' +
      'atx|itx|matx|eatx|' +
      '[0-9]+gb|[0-9]+tb|[0-9]+w|[0-9]+mhz|' +
      'amd|intel|nvidia|corsair|asus|msi|gigabyte|' +
      'ryzen|core|threadripper|xeon|' +
      'radeon|geforce' +
    ')$',
    'i'
  );

  // Words that add almost no signal — ignore them when matching.
  var NOISE_WORDS = {
    desktop: 1, gaming: 1, processor: 1, graphics: 1, card: 1, memory: 1,
    drive: 1, internal: 1, external: 1, solid: 1, state: 1, hard: 1, disk: 1,
    supply: 1, unit: 1, power: 1, cabinet: 1, case: 1, cooler: 1, fan: 1,
    motherboard: 1, mainboard: 1, black: 1, white: 1, grey: 1, silver: 1,
    with: 1, and: 1, the: 1, for: 1, rgb: 1, argb: 1, led: 1,
    generation: 1, gen: 1, series: 1
  };

  function tokenize(text) {
    var t = (text || '').toLowerCase();
    // Normalize wattage: "1000W"/"1000 Watts"/"1000w" -> "1000w"
    t = t.replace(/(\d+)\s*w(?:att)?s?\b/g, '$1w');
    // Normalize GB/TB/MB: "16 GB" -> "16gb"
    t = t.replace(/(\d+)\s*(gb|tb|mb)\b/g, '$1$2');
    // Normalize MHz: "6000 MHz" -> "6000mhz"
    t = t.replace(/(\d+)\s*mhz\b/g, '$1mhz');
    var raw = t.match(/[a-z0-9]+/g) || [];
    return raw.filter(function (tok) { return tok.length >= 2 && !NOISE_WORDS[tok]; });
  }

  function tokenWeight(token) {
    return HIGH_WEIGHT_RE.test(token) ? 2.0 : 1.0;
  }

  function hasDigit(token) {
    for (var i = 0; i < token.length; i++) {
      if (token[i] >= '0' && token[i] <= '9') return true;
    }
    return false;
  }

  // Weighted intersection score, mirrors matcher.py's _score() exactly,
  // including the gentle length penalty for verbose candidate names and the
  // substring-containment fallback for glued model-number tokens (e.g. a
  // technician types "1000m" but the catalog name tokenizes the whole run
  // as "pn1000m" with no separator — an exact-token match would score 0
  // even though it's plainly the right product).
  function score(queryTokens, candidateTokenSet) {
    if (!queryTokens.length) return 0.0;
    var totalWeight = 0, matchedWeight = 0;
    for (var i = 0; i < queryTokens.length; i++) {
      var t = queryTokens[i];
      var w = tokenWeight(t);
      totalWeight += w;
      if (candidateTokenSet.has(t)) {
        matchedWeight += w;
      } else if (t.length >= 4 && hasDigit(t)) {
        // >= 4, not >= 3: short digit runs shed by part numbers are
        // substrings of everything ("100" from "100-100000910WOF" once
        // matched "3100" and outranked the real 7800X3D) — see matcher.py.
        var iter = candidateTokenSet.values();
        var next;
        while (!(next = iter.next()).done) {
          var ct = next.value;
          if (ct.length >= 4 && (ct.indexOf(t) !== -1 || t.indexOf(ct) !== -1)) {
            matchedWeight += w * 0.75;
            break;
          }
        }
      }
    }
    var base = totalWeight ? matchedWeight / totalWeight : 0.0;
    var extra = Math.max(0, candidateTokenSet.size - queryTokens.length);
    var penalty = extra * 0.015;
    return Math.max(0.0, Math.min(1.0, base - penalty));
  }

  // Same field-name -> canonical-category map as matcher.py's match_build_specs().
  var FIELD_TO_CATEGORY = {
    cpu: 'cpu', processor: 'cpu',
    gpu: 'gpu', graphics: 'gpu',
    mobo: 'motherboard', motherboard: 'motherboard',
    ram: 'ram', memory: 'ram',
    storage: 'storage', ssd: 'storage', hdd: 'storage',
    psu: 'psu', power_supply: 'psu',
    case: 'case', cabinet: 'case',
    cooler: 'cooler', cpu_cooler: 'cooler'
  };

  function Matcher(catalog) {
    // catalog: array of {name, sku, category, price_inr}. sku may be
    // null/undefined for not-yet-confirmed entries; they still participate
    // in matching.
    this._entries = (catalog || []).map(function (entry) {
      var name = entry.name || '';
      return {
        sku: entry.sku != null ? entry.sku : null,
        name: name,
        category: entry.category || 'other',
        priceInr: entry.price_inr != null ? entry.price_inr : (entry.priceInr != null ? entry.priceInr : null),
        tokens: new Set(tokenize(name))
      };
    });
  }

  // Add one entry to the in-memory catalog without a full rebuild — used
  // right after a live web-lookup result lands, so the new component is
  // immediately searchable for the rest of the session without waiting for
  // the next full Supabase sync.
  Matcher.prototype.addEntry = function (entry) {
    var name = entry.name || '';
    this._entries.push({
      sku: entry.sku != null ? entry.sku : null,
      name: name,
      category: entry.category || 'other',
      priceInr: entry.price_inr != null ? entry.price_inr : (entry.priceInr != null ? entry.priceInr : null),
      tokens: new Set(tokenize(name))
    });
  };

  Matcher.prototype.match = function (query, category, topK) {
    topK = topK || 5;
    var qTokens = tokenize(query);
    if (!qTokens.length) {
      return { sku: null, matchedName: null, confidence: 0, category: category || null, priceInr: null, autoAccepted: false, needsConfirm: false };
    }

    var pool = this._entries;
    if (category) {
      var filtered = pool.filter(function (e) { return e.category === category; });
      if (filtered.length) pool = filtered;
    }

    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var s = score(qTokens, pool[i].tokens);
      if (s > 0) scored.push([s, pool[i]]);
    }
    scored.sort(function (a, b) { return b[0] - a[0]; });
    var top = scored.slice(0, topK);

    if (!top.length) {
      return { sku: null, matchedName: null, confidence: 0, category: category || null, priceInr: null, autoAccepted: false, needsConfirm: false };
    }

    var best = top[0];
    var bestScore = Math.round(best[0] * 10000) / 10000;
    var bestEntry = best[1];
    return {
      sku: bestEntry.sku,
      matchedName: bestEntry.name,
      confidence: bestScore,
      category: bestEntry.category,
      priceInr: bestEntry.priceInr,
      autoAccepted: bestScore >= CONFIRM_THRESHOLD,
      needsConfirm: bestScore >= SUGGEST_THRESHOLD && bestScore < CONFIRM_THRESHOLD
    };
  };

  // Return up to topK ranked candidates (for suggestion dropdowns), not just
  // the single best match — same pool/category-gate logic as match().
  Matcher.prototype.suggest = function (query, category, topK) {
    topK = topK || 10;
    var qTokens = tokenize(query);
    if (!qTokens.length) return [];

    var pool = this._entries;
    if (category) {
      var filtered = pool.filter(function (e) { return e.category === category; });
      if (filtered.length) pool = filtered;
    }

    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var s = score(qTokens, pool[i].tokens);
      if (s > 0) scored.push([s, pool[i]]);
    }
    scored.sort(function (a, b) { return b[0] - a[0]; });
    return scored.slice(0, topK).map(function (pair) {
      var s = Math.round(pair[0] * 10000) / 10000;
      var e = pair[1];
      return {
        sku: e.sku, matchedName: e.name, confidence: s, category: e.category, priceInr: e.priceInr,
        autoAccepted: s >= CONFIRM_THRESHOLD, needsConfirm: s >= SUGGEST_THRESHOLD && s < CONFIRM_THRESHOLD
      };
    });
  };

  var api = {
    Matcher: Matcher,
    tokenize: tokenize,
    score: score, // exposed for web-lookup.js's cross-site listing clustering (mirrors pcstudio_import.py importing matcher._score)
    CONFIRM_THRESHOLD: CONFIRM_THRESHOLD,
    SUGGEST_THRESHOLD: SUGGEST_THRESHOLD,
    FIELD_TO_CATEGORY: FIELD_TO_CATEGORY
  };

  // ALWAYS set the browser global when a window exists — in the Electron
  // renderer (nodeIntegration:true) `module` is defined even for <script>
  // tags, so the old either/or UMD took the CommonJS branch and
  // window.NeoQcMatcher was silently never set inside the packaged app:
  // the 8,000-item catalog autocomplete never engaged there and quietly
  // fell back to the tiny bundled Fuse list. Node require() still works.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcMatcher = api;
  }
})(typeof window !== 'undefined' ? window : this);
