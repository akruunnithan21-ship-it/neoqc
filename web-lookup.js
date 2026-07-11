/*
  web-lookup.js — live retailer web lookup for components missing from the
  local catalog, running ENTIRELY in the renderer (no Python at runtime).

  This is the JS port of pcstudio_import.py's search_fallback_sites() +
  consolidate_and_upsert(). KEEP THE SITE CONFIGS IN LOCKSTEP with
  FALLBACK_SITES in pcstudio_import.py — the Python path remains the batch /
  CLI tool; this file is what the packaged Electron app actually executes
  (the old approach spawned pcstudio_import.py, which could never work in a
  packaged build: scripts live inside app.asar, cwd wasn't a real directory,
  and shop PCs don't have Python + pip deps — the "spawn python.exe ENOENT"
  bug).

  Electron-free by design: the caller injects fetchUrl (an IPC bridge to the
  main process, which does the actual request — main-process net.fetch is not
  subject to CORS) and the supabase client, so this file can be unit-tested
  in a plain browser or Node with stubs.

  Same honesty contract as the Python version: price_sample_size is the
  ACTUAL number of priced listings used — never padded to look like a
  "5-site average" when fewer matched.
*/
(function (global) {
  'use strict';

  // ─── Site configs (lockstep with pcstudio_import.py FALLBACK_SITES) ───
  var FALLBACK_SITES = [
    {
      // mdcomputers.in — OpenCart, custom "Ronixa" theme
      name: 'mdcomputers.in',
      searchUrl: 'https://mdcomputers.in/index.php?route=product/search&search={q}',
      resultSel: '.product-grid-item',
      nameSel: 'h3',
      priceSel: '.price .ins .amount, .price .amount',
      linkSel: 'a.product-image-link'
    },
    {
      // primeabgb.com — WooCommerce
      name: 'primeabgb.com',
      searchUrl: 'https://www.primeabgb.com/?s={q}&post_type=product',
      resultSel: '.type-product',
      nameSel: '.product-title a',
      priceSel: '.price ins .woocommerce-Price-amount, .price .woocommerce-Price-amount',
      linkSel: '.woocommerce-LoopProduct-link'
    },
    {
      // vedantcomputers.com — OpenCart (React-enhanced), www required
      name: 'vedantcomputers.com',
      searchUrl: 'https://www.vedantcomputers.com/index.php?route=product/search&search={q}',
      resultSel: '.product-thumb',
      nameSel: '.name a',
      priceSel: '.price-new, .price',
      linkSel: '.name a'
    },
    {
      // computechstore.in — custom Tailwind storefront, server-rendered search
      name: 'computechstore.in',
      searchUrl: 'https://computechstore.in/search/?q={q}',
      resultSel: 'div.group:has(h3)',
      nameSel: 'h3',
      priceSel: 'span.font-black:not(.line-through)',
      linkSel: "a[href*='/product/']"
    },
    {
      // vishalperipherals.com — Shopify predictive-search JSON endpoint
      name: 'vishalperipherals.com',
      type: 'shopify-suggest',
      searchUrl: 'https://vishalperipherals.com/search/suggest.json?q={q}&resources[type]=product&resources[limit]=10'
    }
  ];

  var PERCENT_RE = /(?:save\s*)?-?\d+(?:\.\d+)?\s*%/gi;
  var PRICE_RE = /\d[\d,]*(?:\.\d+)?/;

  function parsePrice(text) {
    if (!text) return null;
    var t = String(text).replace(PERCENT_RE, '').replace(/₹/g, '').replace(/,/g, '').trim();
    var m = t.match(PRICE_RE);
    if (!m) return null;
    var v = parseFloat(m[0]);
    return isFinite(v) && v > 0 ? v : null;
  }

  // select_one on a comma-joined "A, B" selector returns whichever matches
  // first in DOCUMENT order — try each part in declared priority order
  // instead (mirrors _select_one_priority in pcstudio_import.py).
  function selectOnePriority(card, commaSelector) {
    var parts = commaSelector.split(',');
    for (var i = 0; i < parts.length; i++) {
      var el = card.querySelector(parts[i].trim());
      if (el) return el;
    }
    return null;
  }

  function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  function absoluteUrl(href, baseUrl) {
    try { return new URL(href, baseUrl).toString(); } catch (e) { return href || ''; }
  }

  // ─── Search all fallback sites, return flat listings ──────────────────

  async function searchFallbackSites(query, category, fetchUrl) {
    var listings = [];
    for (var i = 0; i < FALLBACK_SITES.length; i++) {
      var site = FALLBACK_SITES[i];
      var url = site.searchUrl.replace('{q}', encodeURIComponent(query));
      var res;
      try {
        res = await fetchUrl(url);
      } catch (e) {
        continue;
      }
      if (!res || !res.ok || res.status !== 200 || !res.body) continue;

      if (site.type === 'shopify-suggest') {
        var products = [];
        try {
          var data = JSON.parse(res.body);
          products = ((data.resources || {}).results || {}).products || [];
        } catch (e) { continue; }
        for (var p = 0; p < products.length; p++) {
          var prod = products[p];
          var pname = (prod.title || '').trim();
          if (!pname) continue;
          var pprice = parseFloat(String(prod.price || '').replace(/,/g, ''));
          listings.push({
            name: pname,
            category: category,
            price_inr: isFinite(pprice) && pprice > 0 ? pprice : null,
            url: absoluteUrl(prod.url || '', url),
            source: site.name
          });
        }
        continue;
      }

      var doc;
      try {
        doc = new DOMParser().parseFromString(res.body, 'text/html');
      } catch (e) { continue; }
      var cards = Array.prototype.slice.call(doc.querySelectorAll(site.resultSel), 0, 10);
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        var nameEl = card.querySelector(site.nameSel);
        var priceEl = selectOnePriority(card, site.priceSel);
        var linkEl = card.querySelector(site.linkSel);
        var name = nameEl ? nameEl.textContent.trim() : '';
        if (!name) continue;
        listings.push({
          name: name,
          category: category,
          price_inr: priceEl ? parsePrice(priceEl.textContent) : null,
          url: linkEl ? absoluteUrl(linkEl.getAttribute('href') || '', res.url || url) : '',
          source: site.name
        });
      }
    }
    return listings;
  }

  // ─── Consolidate + upsert (mirrors consolidate_and_upsert()) ──────────

  async function lookup(query, category, fetchUrl, supabaseClient) {
    var M = global.NeoQcMatcher;
    if (!M || !M.score || !M.tokenize) {
      return { found: false, error: 'matcher.js not loaded' };
    }

    var listings = await searchFallbackSites(query, category, fetchUrl);
    if (!listings.length) {
      return { found: false, query: query, listings: [], message: 'No listings found on any fallback site.' };
    }

    // Cluster by name similarity against the query itself: keep only
    // listings that plausibly describe the product the technician typed.
    var qTokens = M.tokenize(query);
    var ranked = listings.map(function (l) {
      return [M.score(qTokens, new Set(M.tokenize(l.name))), l];
    });
    ranked.sort(function (a, b) { return b[0] - a[0]; });
    var cluster = ranked.filter(function (pair) { return pair[0] >= M.SUGGEST_THRESHOLD; })
                        .map(function (pair) { return pair[1]; });
    if (!cluster.length) {
      return {
        found: false, query: query, listings: listings,
        message: 'Found ' + listings.length + ' listing(s) but none matched the query confidently enough to trust.'
      };
    }

    var priced = cluster.filter(function (l) { return l.price_inr; });
    var sampleSize = priced.length;
    var avgPrice = sampleSize
      ? Math.round(priced.reduce(function (s, l) { return s + l.price_inr; }, 0) / sampleSize * 100) / 100
      : null;

    var best = cluster[0];
    var sku = 'WEB-' + slugify(best.name);
    var now = new Date().toISOString();

    var row = {
      sku: sku,
      name: best.name,
      category: category || best.category,
      price_inr: avgPrice,
      url: best.url,
      source: 'web-lookup',
      source_method: 'fallback-consolidated',
      fetched_at: now,
      updated_at: now,
      needs_review: true,
      price_sample_size: sampleSize,
      price_listings: cluster.map(function (l) {
        return { source: l.source, url: l.url, price_inr: l.price_inr, fetched_at: now };
      })
    };

    var upserted = false;
    var upsertError = null;
    if (supabaseClient) {
      try {
        var resp = await supabaseClient.from('component_prices').upsert(row, { onConflict: 'sku' });
        if (resp.error) upsertError = resp.error.message;
        else upserted = true;
      } catch (e) {
        upsertError = e.message;
      }
    } else {
      upsertError = 'Supabase not connected';
    }

    return {
      found: true,
      query: query,
      sku: sku,
      name: best.name,
      category: row.category,
      price_inr: avgPrice,
      price_sample_size: sampleSize,
      price_listings: row.price_listings,
      needs_review: true,
      upserted: upserted,
      upsert_error: upsertError
    };
  }

  var api = { lookup: lookup, searchFallbackSites: searchFallbackSites, parsePrice: parsePrice, FALLBACK_SITES: FALLBACK_SITES };
  // ALWAYS set the browser global when a window exists (Electron UMD gotcha
  // — see shared/matcher.js). Node require() still gets module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcWebLookup = api;
  }
})(typeof window !== 'undefined' ? window : this);
