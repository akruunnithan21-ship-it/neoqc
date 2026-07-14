/*
  ppi.js — pure-JS port of ppi.py (Layer 4 Price-to-Performance engine).

  Kept in LOCKSTEP with ppi.py — same weight tables, same ratio-to-best math,
  same ST-blend, same bottleneck rules. If you tune ppi.py, tune this too.

  v1.4.4 addition — was pure Python, invoked over IPC → shop PCs without
  Python printed "Python is not installed" for the "Compute Price-Performance"
  button. This module runs entirely in the renderer, alongside the shared
  matcher / diagnostics-render modules, so PPI works on every machine.

  Same both/and export pattern as the other shared modules (v1.3.2 UMD fix):
  ALWAYS set the window global when window exists, AND set module.exports
  for Node require() — the renderer's `module` global would otherwise steal
  the export in the packaged app.
*/
(function (global) {
  'use strict';

  // ─── Use-case taxonomy ──────────────────────────────────────────────
  // Rows must sum to 1.0. Kept identical to USE_CASE_WEIGHTS in ppi.py.
  var USE_CASE_WEIGHTS = {
    'gaming-1080p':      { cpu: 0.25, gpu: 0.40, ram: 0.10, storage: 0.10, other: 0.15 },
    'gaming-1440p':      { cpu: 0.20, gpu: 0.45, ram: 0.10, storage: 0.10, other: 0.15 },
    'gaming-4k':         { cpu: 0.15, gpu: 0.55, ram: 0.10, storage: 0.10, other: 0.10 },
    'streaming':         { cpu: 0.35, gpu: 0.30, ram: 0.15, storage: 0.10, other: 0.10 },
    'video-editing':     { cpu: 0.35, gpu: 0.25, ram: 0.20, storage: 0.10, other: 0.10 },
    'cad-3d':            { cpu: 0.45, gpu: 0.20, ram: 0.20, storage: 0.05, other: 0.10 },
    'office':            { cpu: 0.30, gpu: 0.05, ram: 0.20, storage: 0.20, other: 0.25 },
    'ai-ml':             { cpu: 0.15, gpu: 0.55, ram: 0.10, storage: 0.05, other: 0.15 },
    'content-creation':  { cpu: 0.25, gpu: 0.20, ram: 0.20, storage: 0.20, other: 0.15 }
  };

  var CATEGORY_TO_BUCKET = {
    cpu: 'cpu', gpu: 'gpu', ram: 'ram', storage: 'storage',
    psu: 'other', case: 'other', cooler: 'other', motherboard: 'other'
  };

  var BENCHMARK_KEY_BY_CATEGORY = {
    cpu: 'passmark-cpu',
    gpu: 'passmark-g3d'
  };
  var BENCHMARK_CPU_ST_KEY = 'passmark-cpu-st';

  var CPU_ST_EMPHASIS = {
    'gaming-1080p': 0.60, 'gaming-1440p': 0.50, 'gaming-4k': 0.40,
    'streaming': 0.30, 'video-editing': 0.25, 'cad-3d': 0.45,
    'office': 0.50, 'ai-ml': 0.20, 'content-creation': 0.30
  };

  var MIN_RECOMMENDED = {
    'gaming-1080p':     { cpu: 12000, gpu: 9000 },
    'gaming-1440p':     { cpu: 15000, gpu: 15000 },
    'gaming-4k':        { cpu: 18000, gpu: 24000 },
    'streaming':        { cpu: 20000, gpu: 12000 },
    'video-editing':    { cpu: 25000, gpu: 14000 },
    'cad-3d':           { cpu: 28000, gpu: 14000 },
    'office':           { cpu: 6000,  gpu: 2000 },
    'ai-ml':            { cpu: 15000, gpu: 20000 },
    'content-creation': { cpu: 10000, gpu: 6000 }
  };

  var BOTTLENECK_RATIO = 1.6;

  // Legacy UI aliases → canonical use-case keys (mirrors ppi_sync.py's map).
  var USE_CASE_ALIASES = {
    gaming: 'gaming-1440p',
    editing: 'video-editing',
    renders: 'cad-3d',
    general: 'office',
    studio: 'video-editing'
  };

  function _bucketWeights(useCases) {
    var rows = [];
    for (var i = 0; i < useCases.length; i++) {
      var w = USE_CASE_WEIGHTS[useCases[i]];
      if (w) rows.push(w);
    }
    if (!rows.length) rows.push(USE_CASE_WEIGHTS['office']);
    var bucketSet = {};
    rows.forEach(function (row) { Object.keys(row).forEach(function (k) { bucketSet[k] = 1; }); });
    var buckets = Object.keys(bucketSet);
    var out = {};
    var total = 0;
    buckets.forEach(function (b) {
      var sum = 0;
      rows.forEach(function (row) { sum += row[b] || 0; });
      out[b] = sum / rows.length;
      total += out[b];
    });
    if (total > 0) {
      Object.keys(out).forEach(function (b) { out[b] = out[b] / total; });
    }
    return out;
  }

  function _stEmphasis(useCases) {
    var vals = [];
    for (var i = 0; i < useCases.length; i++) {
      if (CPU_ST_EMPHASIS[useCases[i]] != null) vals.push(CPU_ST_EMPHASIS[useCases[i]]);
    }
    if (!vals.length) return CPU_ST_EMPHASIS['office'];
    var s = 0;
    for (var j = 0; j < vals.length; j++) s += vals[j];
    return s / vals.length;
  }

  function _effectiveScores(category, pool, stAlpha, flags) {
    var key = BENCHMARK_KEY_BY_CATEGORY[category];
    if (category !== 'cpu' || stAlpha <= 0) {
      var out = {};
      Object.keys(pool).forEach(function (sku) {
        if (pool[sku][key] != null) out[sku] = pool[sku][key];
      });
      return out;
    }
    var mt = {}, st = {}, usable = [];
    Object.keys(pool).forEach(function (sku) {
      mt[sku] = pool[sku][key];
      st[sku] = pool[sku][BENCHMARK_CPU_ST_KEY];
      if (mt[sku] != null) usable.push(sku);
    });
    var allHaveSt = usable.length > 0 && usable.every(function (sku) { return st[sku] != null && st[sku] > 0; });
    var blended = {};
    if (allHaveSt) {
      usable.forEach(function (sku) {
        blended[sku] = Math.pow(mt[sku], 1 - stAlpha) * Math.pow(st[sku], stAlpha);
      });
      return blended;
    }
    flags.push('cpu: single-thread scores incomplete for this price band — scored on multithread only (gaming-focused CPUs may rank low)');
    usable.forEach(function (sku) { blended[sku] = mt[sku]; });
    return blended;
  }

  function _priceBandPool(category, ownSku, ownPrice, componentPrices, priceBandPct) {
    var lo = ownPrice * (1 - priceBandPct);
    var hi = ownPrice * (1 + priceBandPct);
    var out = [];
    Object.keys(componentPrices).forEach(function (sku) {
      var e = componentPrices[sku];
      if (e && e.category === category && e.price_inr != null && e.price_inr >= lo && e.price_inr <= hi) {
        out.push([sku, e]);
      }
    });
    return out;
  }

  function ppi(buildSpecs, componentPrices, benchmarkScores, useCases, priceBandPct) {
    priceBandPct = priceBandPct == null ? 0.15 : priceBandPct;
    var weights = _bucketWeights(useCases);
    var stAlpha = _stEmphasis(useCases);
    var flags = [];
    var perComponentScores = {};
    var inRangeComparisons = {};
    var weightedSum = 0;
    var weightTotal = 0;
    var fitRatios = [];
    var rawScores = {};

    Object.keys(buildSpecs).forEach(function (category) {
      var sku = buildSpecs[category];
      var bucket = CATEGORY_TO_BUCKET[category];
      if (!bucket || weights[bucket] == null) return;

      var ownEntry = componentPrices[sku];
      if (!ownEntry) {
        flags.push(category + ': SKU ' + sku + ' not found in component_prices, skipped');
        return;
      }
      var ownPrice = ownEntry.price_inr;
      var benchmarkKey = BENCHMARK_KEY_BY_CATEGORY[category];
      var score = null;

      if (!benchmarkKey) {
        flags.push(category + ': no objective benchmark exists — shown unscored, not counted in the index');
      } else if (ownPrice == null) {
        flags.push(category + ': no price on file — cannot place in a price band, not counted in the index');
      } else {
        var ownScoreRaw = (benchmarkScores[sku] || {})[benchmarkKey];
        if (ownScoreRaw != null) rawScores[category] = ownScoreRaw;

        var poolEntries = _priceBandPool(category, sku, ownPrice, componentPrices, priceBandPct);
        // Ensure own component is included even if its price is exactly on a band edge / rounding
        var haveOwnInPool = poolEntries.some(function (p) { return p[0] === sku; });
        if (!haveOwnInPool) poolEntries.push([sku, ownEntry]);

        var poolBench = {};
        poolEntries.forEach(function (pair) {
          var b = benchmarkScores[pair[0]] || {};
          if (b[benchmarkKey] != null) poolBench[pair[0]] = b;
        });

        if (ownScoreRaw == null) {
          flags.push(category + ': no ' + benchmarkKey + ' score on file — not counted in the index');
        } else if (Object.keys(poolBench).length < 2) {
          flags.push(category + ': no same-price peers with benchmark data — not counted in the index');
        } else {
          var eff = _effectiveScores(category, poolBench, stAlpha, flags);
          var best = 0;
          Object.keys(eff).forEach(function (s) { if (eff[s] > best) best = eff[s]; });
          if (best > 0 && eff[sku] != null) {
            score = 100.0 * eff[sku] / best;
            var comparisons = [];
            var sortedSkus = Object.keys(eff).sort(function (a, b) { return eff[b] - eff[a]; });
            for (var i = 0; i < sortedSkus.length; i++) {
              var peerSku = sortedSkus[i];
              if (peerSku === sku) continue;
              var peerNorm = 100.0 * eff[peerSku] / best;
              var peerEntry = componentPrices[peerSku];
              comparisons.push({
                sku: peerSku,
                name: (peerEntry && peerEntry.name) || peerSku,
                price_inr: peerEntry ? peerEntry.price_inr : null,
                score: Math.round(peerNorm * 10) / 10,
                delta_vs_own: Math.round((peerNorm - score) * 10) / 10
              });
            }
            inRangeComparisons[category] = comparisons.slice(0, 3);
            if (score >= 100.0 - 1e-9) {
              flags.push(category + ': best performer in its price band ✓');
            }
          }
        }

        if (ownScoreRaw != null) {
          useCases.forEach(function (uc) {
            var mins = MIN_RECOMMENDED[uc] || {};
            var threshold = mins[category];
            if (threshold) fitRatios.push(Math.min(1.0, ownScoreRaw / threshold));
          });
        }
      }

      perComponentScores[category] = score != null ? Math.round(score * 10) / 10 : null;
      if (score != null) {
        var w = weights[bucket];
        weightedSum += score * w;
        weightTotal += w;
      }
    });

    var index = weightTotal ? Math.round((weightedSum / weightTotal) * 10) / 10 : 0.0;
    if (!weightTotal) {
      flags.push('No component could be scored against reference data — the 0 index is a data gap, not a verdict on this build');
    }
    var customerFitScore = fitRatios.length
      ? Math.round((fitRatios.reduce(function (a, b) { return a + b; }, 0) / fitRatios.length) * 1000) / 1000
      : 0.0;

    // Bottleneck detection on ABSOLUTE performance vs the use-case minimums.
    var cpuRaw = rawScores.cpu;
    var gpuRaw = rawScores.gpu;
    if (cpuRaw && gpuRaw) {
      var cpuFits = [], gpuFits = [];
      useCases.forEach(function (uc) {
        var mins = MIN_RECOMMENDED[uc] || {};
        if (mins.cpu) cpuFits.push(cpuRaw / mins.cpu);
        if (mins.gpu) gpuFits.push(gpuRaw / mins.gpu);
      });
      if (cpuFits.length && gpuFits.length) {
        var avg = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
        var cpuFit = avg(cpuFits);
        var gpuFit = avg(gpuFits);
        var weaker = Math.min(cpuFit, gpuFit);
        if (weaker < 1.5) {
          if (gpuFit / Math.max(cpuFit, 1e-6) < 1 / BOTTLENECK_RATIO) {
            flags.push('GPU is the limiting component for the selected use-case (CPU has headroom)');
          } else if (cpuFit / Math.max(gpuFit, 1e-6) < 1 / BOTTLENECK_RATIO) {
            flags.push('CPU is the limiting component for the selected use-case (GPU has headroom)');
          }
        }
      }
    }

    if (fitRatios.length && customerFitScore < 0.6) {
      flags.push('Build is underpowered for the selected use-case(s)');
    }

    return {
      index: index,
      per_component_scores: perComponentScores,
      in_range_comparisons: inRangeComparisons,
      customer_fit_score: customerFitScore,
      flags: flags
    };
  }

  var api = {
    ppi: ppi,
    USE_CASE_WEIGHTS: USE_CASE_WEIGHTS,
    USE_CASE_ALIASES: USE_CASE_ALIASES,
    MIN_RECOMMENDED: MIN_RECOMMENDED,
    CATEGORY_TO_BUCKET: CATEGORY_TO_BUCKET
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcPpi = api;
  }
})(typeof window !== 'undefined' ? window : this);
