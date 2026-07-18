/*
  invoice-import.js — parse an invoice's extracted text and map its line items
  onto the eight Target Build Spec categories, matching each to the real
  component catalog so wording differences between the invoice and the catalog
  (or between the invoice and what the machine auto-detected) don't cause a
  mismatch.

  Loaded via <script> in index.html (renderer). Kept browser-safe with the
  both/and UMD pattern (v1.3.2) — window.NeoQcInvoiceImport is always set when a
  window exists, and module.exports still works for Node tests.

  The heavy lifting is delegated to the SAME token-weighted scorer the
  autocomplete uses (shared/matcher.js). Because every catalog SKU carries its
  true category, scoring a line against each category's catalog subset and
  taking the best-scoring category is a naturally correct classifier whenever
  the catalog contains the item — no brittle per-invoice-format rules needed.
  Keyword hints only break ties and cover the offline / not-in-catalog case.
*/
(function () {
  // Secondary signal only — the catalog match is primary. Patterns are
  // deliberately broad; overlaps (e.g. "rog strix" is both a board and a card
  // line) are resolved by the catalog scorer, not these.
  var CATEGORY_HINTS = {
    cpu: [/\bryzen\b/i, /\bcore\s*i[3579]\b/i, /\bintel\s+core\b/i, /\bprocessor\b/i, /\bthreadripper\b/i, /\d{3,5}x3d\b/i, /\b\d{4,5}(k|kf|f|x|xt|g|ge)?\b\s*(processor|cpu)?/i, /\bpentium\b/i, /\bceleron\b/i, /\bathlon\b/i],
    gpu: [/\brtx\b/i, /\bgtx\b/i, /\bradeon\b/i, /\brx\s*\d{3,4}\b/i, /\bgeforce\b/i, /\bgraphics?\s*card\b/i, /\bventus\b/i, /\bwindforce\b/i, /\beagle\b/i, /\bgaming\s*oc\b/i, /\barc\s*a\d{3}\b/i, /\bgpu\b/i],
    motherboard: [/\bmotherboard\b/i, /\bmainboard\b/i, /\bmobo\b/i, /\b[abxzh]\d{3}[a-z]?\b/i, /\btuf\s*gaming\b/i, /\bmag\b/i, /\bmortar\b/i, /\btomahawk\b/i, /\baorus\b/i, /\bsteel\s*legend\b/i, /\bgaming\s*plus\b/i, /\bprime\s+[abxzh]\d/i],
    ram: [/\bddr[45]\b/i, /\bmemory\b/i, /\bdimm\b/i, /\bvengeance\b/i, /\bripjaws\b/i, /\btrident\b/i, /\bfury\b/i, /\b\d{1,3}\s*gb\b.*\b\d{4,5}\s*mhz\b/i, /\b(2\s*x\s*\d{1,2}gb|\d{1,2}gb\s*x\s*2)\b/i, /\bram\b/i],
    storage: [/\bssd\b/i, /\bnvme\b/i, /\bhdd\b/i, /\bm\.?2\b/i, /\bhard\s*(disk|drive)\b/i, /\bsata\s*ssd\b/i, /\b\d+\s*(gb|tb)\b.*\b(ssd|nvme|hdd|drive)\b/i, /\b(970|980|990)\s*(evo|pro)?\b/i, /\bsn\d{3}\b/i, /\bwd\s*(blue|black|green)\b/i],
    psu: [/\bpsu\b/i, /\bpower\s*supply\b/i, /\bsmps\b/i, /\b\d{3,4}\s*w(att)?\b/i, /\b80\s*\+?\s*plus\b/i, /\b(gold|bronze|platinum|titanium)\b/i, /\bmodular\b/i, /\brm\d{3,4}\b/i, /\bcv\d{3}\b/i, /\bmwe\b/i],
    case: [/\bcabinet\b/i, /\bchassis\b/i, /\btower\b/i, /\batx\s*case\b/i, /\bmid[\s-]*tower\b/i, /\blian\s*li\b/i, /\bnzxt\b/i, /\bmeshify\b/i, /\blancool\b/i, /\bcase\b/i],
    cooler: [/\bcooler\b/i, /\baio\b/i, /\bliquid\s*(cooler|freezer)\b/i, /\bair\s*cooler\b/i, /\bhyper\s*212\b/i, /\bak\d{3}\b/i, /\bnh[\s-]*[du]\d{2}\b/i, /\bpeerless\b/i, /\bkraken\b/i, /\bml\d{3}\b/i, /\b(240|280|360)\s*mm\b/i]
  };

  var ALL_CATEGORIES = ['cpu', 'gpu', 'motherboard', 'ram', 'storage', 'psu', 'case', 'cooler'];

  // Lines we never treat as a component: totals, taxes, addresses, headers.
  var NOISE_LINE = /(sub\s*total|grand\s*total|\btotal\b|\bgst\b|\bcgst\b|\bsgst\b|\bigst\b|\btax\b|invoice\s*(no|date|number)|\bhsn\b|\bqty\b|quantity|\bamount\b|\bdiscount\b|\bround\s*off\b|bill\s*to|ship\s*to|\bgstin\b|\bpan\b|terms\s*&|thank\s*you|authori[sz]ed|signature|\bemail\b|\bphone\b|\bmobile\b|www\.|@|payment|balance\s*due)/i;

  function normalizeLines(text) {
    if (!text) return [];
    // PDFs frequently glue columns with runs of spaces or split a row across
    // lines. Split on newlines first, then also on 3+ space runs which usually
    // separate description | qty | rate | amount columns.
    var rawLines = String(text).split(/\r?\n/);
    var out = [];
    rawLines.forEach(function (ln) {
      ln = ln.replace(/\t/g, ' ').replace(/\s{3,}/g, '  ').trim();
      if (!ln) return;
      out.push(ln);
    });
    return out;
  }

  function isCandidate(line) {
    if (!line) return false;
    var l = line.trim();
    if (l.length < 5 || l.length > 160) return false;
    if (NOISE_LINE.test(l)) return false;
    // Must contain at least one letter (product names have letters). Pure
    // number/price rows are skipped.
    if (!/[a-z]/i.test(l)) return false;
    // Strip leading serial numbers / bullets ("1.", "1)", "- ") so the matcher
    // sees the product text, not the row index.
    return true;
  }

  function stripRowNoise(line) {
    var l = line;
    l = l.replace(/^\s*\d{1,3}[\).\-]\s+/, '');          // leading "1. " / "1) "
    l = l.replace(/^[-*•]\s+/, '');                       // bullets
    l = l.replace(/\bhsn[:\s]*\d+/ig, ' ');               // HSN codes
    // Currency tokens ONLY as standalone words — \b so we don't eat the "rs"
    // inside "Corsair" or the "inr" inside a product name.
    l = l.replace(/₹/g, ' ');
    l = l.replace(/\b(?:rs|inr)\b\.?/ig, ' ');
    l = l.replace(/\b\d{1,3}(,\d{2,3})+(\.\d{1,2})?\b/g, ' '); // 1,23,456.00 amounts
    l = l.replace(/\s{2,}/g, ' ').trim();
    return l;
  }

  // Pull the money figures off an ORIGINAL invoice line (before stripRowNoise
  // removes them). We require Indian comma-grouping (e.g. 35,425 / 6,351.3 /
  // 1,52,499.78) so we never mistake an HSN code (84733010), a quantity (1), a
  // discount (140), a percentage (18), or a spec like "5.6Ghz" for a price.
  // Returns { rate, total }: on a "... Rate Disc Tax Total" row the first
  // comma-number is the unit rate and the last is the line total.
  function extractPrices(originalLine) {
    var line = originalLine.replace(/\([^)]*%\)/g, ' '); // drop "(0.4%)" / "(18%)"
    var matches = line.match(/\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?/g) || [];
    var nums = matches.map(function (s) { return parseFloat(s.replace(/,/g, '')); })
                      .filter(function (n) { return !isNaN(n) && n > 0; });
    if (!nums.length) return { rate: null, total: null };
    return { rate: nums[0], total: nums[nums.length - 1] };
  }

  function keywordScore(line, category) {
    var pats = CATEGORY_HINTS[category] || [];
    var hits = 0;
    for (var i = 0; i < pats.length; i++) if (pats[i].test(line)) hits++;
    return hits;
  }

  // Best catalog match for one line within one category.
  function bestCatalogMatch(matcher, line, category) {
    if (!matcher || typeof matcher.suggest !== 'function') return null;
    var res = matcher.suggest(line, category, 1);
    return (res && res.length) ? res[0] : null;
  }

  /*
    buildFromInvoice(text, catalogMatcher, opts) →
    {
      results: { <category>: {
        rawLine, matchedName, displayName, sku, priceInr, confidence, status
      } },   // status: 'matched' | 'review' | 'manual'
      filledCount, reviewCount, candidateLines
    }
    status:
      matched — catalog confidence >= SUGGEST_THRESHOLD (safe auto-fill)
      review  — filled from a weaker catalog hit; tech should eyeball it
      manual  — no catalog hit; filled with the cleaned raw invoice line
  */
  function buildFromInvoice(text, catalogMatcher, opts) {
    opts = opts || {};
    var SUGGEST = (window.NeoQcMatcher && window.NeoQcMatcher.SUGGEST_THRESHOLD) || 0.55;
    var REVIEW_FLOOR = opts.reviewFloor != null ? opts.reviewFloor : 0.30;
    var cleanName = (window.NeoQcMatcher && window.NeoQcMatcher.cleanName) || function (s) { return s; };

    // Keep the original line (for price extraction) alongside the stripped line
    // (for name matching). De-dup on the stripped text, preserve order.
    var seen = {}; var candidates = [];
    normalizeLines(text).filter(isCandidate).forEach(function (orig) {
      var stripped = stripRowNoise(orig);
      if (stripped.length < 5) return;
      var k = stripped.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      var pr = extractPrices(orig);
      candidates.push({ text: stripped, orig: orig, rate: pr.rate, total: pr.total });
    });

    // Score every (candidate, category) pair.
    var tuples = []; // {category, cand, entry, catConf, kw, score}
    candidates.forEach(function (cand) {
      ALL_CATEGORIES.forEach(function (category) {
        var entry = bestCatalogMatch(catalogMatcher, cand.text, category);
        var catConf = entry ? entry.confidence : 0;
        var kw = keywordScore(cand.text, category);
        if (catConf <= 0 && kw <= 0) return;
        // Combined ranking score: catalog confidence dominates; keyword adds a
        // small nudge so a strong keyword line still ranks when the catalog is
        // thin/offline.
        var s = catConf + Math.min(kw, 3) * 0.05;
        tuples.push({ category: category, cand: cand, entry: entry, catConf: catConf, kw: kw, score: s });
      });
    });

    tuples.sort(function (a, b) { return b.score - a.score; });

    // Greedy assignment: each category filled once, each invoice line used once.
    var results = {};
    var usedLines = {};
    tuples.forEach(function (t) {
      if (results[t.category]) return;              // category already filled
      var lineKey = t.cand.text.toLowerCase();
      if (usedLines[lineKey]) return;               // line already used elsewhere
      // Require SOME evidence: a catalog hit above the review floor, or a
      // keyword hint for this category (offline / not-in-catalog case).
      var hasCatalog = t.entry && t.catConf >= REVIEW_FLOOR;
      var hasKeyword = t.kw > 0;
      if (!hasCatalog && !hasKeyword) return;

      var status, matchedName, sku, catalogPrice, confidence;
      if (t.entry && t.catConf >= SUGGEST) {
        status = 'matched';
        matchedName = t.entry.matchedName; sku = t.entry.sku;
        catalogPrice = t.entry.priceInr; confidence = t.catConf;
      } else if (t.entry && t.catConf >= REVIEW_FLOOR) {
        status = 'review';
        matchedName = t.entry.matchedName; sku = t.entry.sku;
        catalogPrice = t.entry.priceInr; confidence = t.catConf;
      } else {
        // keyword-only: fill the cleaned raw invoice line as manual entry.
        status = 'manual';
        matchedName = t.cand.text; sku = null; catalogPrice = null; confidence = t.catConf || 0;
      }

      // The invoice price is what the customer actually paid — prefer it over the
      // catalog's reference price for this specific build. Fall back to catalog.
      var invoicePrice = t.cand.rate != null ? t.cand.rate : null;
      var priceInr = invoicePrice != null ? invoicePrice : catalogPrice;

      results[t.category] = {
        rawLine: t.cand.text,
        matchedName: matchedName,
        displayName: cleanName(matchedName),
        sku: sku,
        priceInr: priceInr,
        invoicePriceInr: invoicePrice,
        invoiceLineTotal: t.cand.total,
        catalogPriceInr: catalogPrice,
        priceSource: invoicePrice != null ? 'invoice' : (catalogPrice != null ? 'catalog' : 'none'),
        confidence: confidence,
        status: status
      };
      usedLines[lineKey] = 1;
    });

    var filledCount = 0, reviewCount = 0;
    Object.keys(results).forEach(function (c) {
      filledCount++;
      if (results[c].status !== 'matched') reviewCount++;
    });

    return { results: results, filledCount: filledCount, reviewCount: reviewCount, candidateLines: candidates };
  }

  var api = {
    buildFromInvoice: buildFromInvoice,
    normalizeLines: normalizeLines,
    // exposed for unit tests / debugging
    _isCandidate: isCandidate,
    _stripRowNoise: stripRowNoise,
    _keywordScore: keywordScore,
    ALL_CATEGORIES: ALL_CATEGORIES
  };

  if (typeof window !== 'undefined') window.NeoQcInvoiceImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
