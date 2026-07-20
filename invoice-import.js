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
    cooler: [/\bcooler\b/i, /\baio\b/i, /\bliquid\s*(cooler|freezer)\b/i, /\bair\s*cooler\b/i, /\bhyper\s*212\b/i, /\bak\d{3}\b/i, /\bnh[\s-]*[du]\d{2}\b/i, /\bpeerless\b/i, /\bkraken\b/i, /\bml\d{3}\b/i, /\b(240|280|360|420)\s*mm\b/i, /\b(le|lt|ls|as)\d{3}\b/i, /\bassassin\b/i, /\bgammaxx\b/i, /\bfrost\s*flow\b/i, /\bcastle\b/i, /\bgalahad\b/i]
  };

  var ALL_CATEGORIES = ['cpu', 'gpu', 'motherboard', 'ram', 'storage', 'psu', 'case', 'cooler'];

  // Brand guard — the catalog scorer matches on shared tokens (B850, Gaming,
  // WiFi6E, AM5, ATX…), so an "MSI B850M Gaming Pro" invoice line can score
  // 70%+ against a "Gigabyte B850 Gaming X" catalog row. That's a DIFFERENT
  // product. If both the invoice line and the catalog match name a recognized
  // brand and the brands disagree, we refuse to treat it as a confident match:
  // the invoice text becomes the spec name and the wrong catalog SKU is dropped.
  // ONLY manufacturer / board-partner brands — deliberately NOT chip vendors
  // (nvidia, geforce, radeon, amd, intel). A card is legitimately "Zotac
  // GeForce RTX 5080", so comparing chip vendors would false-flag a Zotac
  // invoice vs a bare-"GeForce" catalog hit. Multi-word aliases come first so
  // "cooler master" matches before a stray "master".
  var BRAND_ALIASES = [
    ['western digital', 'wd'], ['cooler master', 'coolermaster'], ['lian li', 'lianli'],
    ['g.skill', 'gskill'], ['g skill', 'gskill'], ['team group', 'teamgroup'],
    ['be quiet', 'bequiet'], ['silicon power', 'siliconpower'], ['sea gate', 'seagate'],
    ['msi', 'msi'], ['gigabyte', 'gigabyte'], ['asrock', 'asrock'], ['asus', 'asus'],
    ['zotac', 'zotac'], ['deepcool', 'deepcool'], ['corsair', 'corsair'], ['kingston', 'kingston'],
    ['samsung', 'samsung'], ['crucial', 'crucial'], ['seagate', 'seagate'],
    ['coolermaster', 'coolermaster'], ['nzxt', 'nzxt'], ['lianli', 'lianli'], ['evga', 'evga'],
    ['palit', 'palit'], ['galax', 'galax'], ['sapphire', 'sapphire'], ['powercolor', 'powercolor'],
    ['xfx', 'xfx'], ['pny', 'pny'], ['inno3d', 'inno3d'], ['gainward', 'gainward'],
    ['gskill', 'gskill'], ['adata', 'adata'], ['teamgroup', 'teamgroup'], ['tforce', 'teamgroup'],
    ['thermaltake', 'thermaltake'], ['bequiet', 'bequiet'], ['fractal', 'fractal'], ['antec', 'antec'],
    ['colorful', 'colorful'], ['biostar', 'biostar'], ['sandisk', 'sandisk'], ['kioxia', 'kioxia'],
    ['micron', 'micron'], ['patriot', 'patriot'], ['transcend', 'transcend'], ['wd', 'wd']
  ];
  function brandOf(str) {
    if (!str) return null;
    var s = ' ' + String(str).toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    for (var i = 0; i < BRAND_ALIASES.length; i++) {
      var token = BRAND_ALIASES[i][0];
      if (s.indexOf(' ' + token + ' ') !== -1) return BRAND_ALIASES[i][1];
    }
    return null;
  }
  // true only when BOTH names carry a recognized brand AND they differ.
  function brandConflict(a, b) {
    var ba = brandOf(a), bb = brandOf(b);
    return !!(ba && bb && ba !== bb);
  }

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

  // Clean the invoice line into a presentable SPEC NAME: strip the tabular
  // metadata that rides along when a PDF glues columns onto the description
  // (HSN codes, warranty, quantity, tax %). Preserves real spec tokens like
  // "16GB", "6000MHz", "2TB", "GDDR7" (those carry letters, HSN codes don't).
  function cleanInvoiceName(line) {
    var l = stripRowNoise(line);
    // Leading row index ("2 MSI …") — but never a spec unit ("16 GB …").
    l = l.replace(/^\s*\d{1,2}\s+(?!(?:gb|tb|mhz|ghz|w|watt|mm)\b)(?=[A-Za-z])/i, '');
    l = l.replace(/\bhsn\s*\/?\s*sac\b/ig, ' ');
    l = l.replace(/\(?\b\d{1,3}\s*%\)?/g, ' ');                 // tax "(18%)" / "18 %"
    l = l.replace(/\b\d{1,2}\s*(yrs?|years?|months?|mo)\b/ig, ' '); // warranty "3yr"
    l = l.replace(/\b\d{1,3}\s*(pcs?|nos?|units?|qty)\b/ig, ' ');   // qty "1 PCS"
    l = l.replace(/\b\d{6,9}\b/g, ' ');                          // bare HSN/SAC codes
    l = l.replace(/\s*[|/\\]\s*/g, ' ');                         // leftover column pipes
    l = l.replace(/\s{2,}/g, ' ').replace(/^[\s\-–,]+|[\s\-–,]+$/g, '').trim();
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

  // (Removed in v1.5.0: bestCatalogMatch. Invoice lines are no longer scored
  // against the catalog — the invoice IS the source of truth for what the part
  // is. The catalog is grown FROM invoices instead; see
  // upsertInvoiceComponentsToCatalog() in app.js.)

  // A line that begins a new invoice row: a leading serial index ("1 ", "2)")
  // or a price on the line. A digit glued to a unit ("16GB", "2TB") is NOT a
  // serial. Used to know where one item ends and the next begins.
  function startsNewRow(line, hasPrice) {
    if (hasPrice) return true;
    return /^\s*\d{1,3}[\s\).\-]/.test(line) && !/^\s*\d{1,3}\s*(gb|tb|mhz|ghz|w|mm)\b/i.test(line);
  }

  // Reconstruct full item rows from possibly-wrapped PDF lines. A description
  // that wraps ("MSI B850M Gaming Pro" / "WIFI6E M-ATX Motherboard") arrives as
  // two physical lines — the continuation has no price and no serial index, so
  // we fold it back into its row. THIS is what stops a wrapped board name from
  // being split and mis-filed under Storage.
  function reconstructRows(text) {
    var lines = normalizeLines(text).filter(isCandidate);
    var rows = [];
    var leading = [];   // continuation lines seen before the first real row
    lines.forEach(function (orig) {
      var pr = extractPrices(orig);
      var hasPrice = pr.rate != null;
      if (startsNewRow(orig, hasPrice)) {
        rows.push({ parts: [orig], rate: pr.rate, total: pr.total });
      } else if (rows.length) {
        // continuation of the current row
        var row = rows[rows.length - 1];
        row.parts.push(orig);
        if (row.rate == null && hasPrice) { row.rate = pr.rate; row.total = pr.total; }
      } else {
        leading.push(orig);
      }
    });
    if (leading.length && rows.length) rows[0].parts = leading.concat(rows[0].parts);
    // Materialize each row: cleaned display text + de-dup identical text.
    var seen = {}; var out = [];
    rows.forEach(function (row) {
      var joined = row.parts.join(' ');
      var text2 = cleanInvoiceName(joined);
      if (text2.length < 3) return;
      var k = text2.toLowerCase();
      if (seen[k]) return; seen[k] = 1;
      out.push({ text: text2, orig: joined, rate: row.rate, total: row.total });
    });
    return out;
  }

  /*
    buildFromInvoice(text, catalogMatcher, opts) → INVOICE-FIRST (v1.4.11)

    The invoice is the source of truth. We do NOT rewrite component names from
    the catalog — the spec name is the customer's actual invoice line, in full
    (brand + model + specs). The catalog is only grown FROM invoices later
    (app.js upserts each result into component_prices, invoice price wins).

    Category assignment is keyword-only (no catalog scoring), which removed the
    class of bug where a wrapped/partial line scored against an unrelated SKU
    and landed in the wrong field.

    results[category] = { rawLine, matchedName, displayName, priceInr,
      invoicePriceInr, invoiceLineTotal, priceSource:'invoice', confidence,
      status:'matched'|'review', category }
      status: 'matched' when a category keyword clearly fits, else 'review'.
  */
  function buildFromInvoice(text, catalogMatcher, opts) {
    opts = opts || {};
    var cleanName = (window.NeoQcMatcher && window.NeoQcMatcher.cleanName) || function (s) { return s; };

    var rows = reconstructRows(text);

    // Score every (row, category) pair on KEYWORD evidence only.
    var tuples = [];
    rows.forEach(function (row) {
      ALL_CATEGORIES.forEach(function (category) {
        var kw = keywordScore(row.text, category);
        if (kw <= 0) return;
        tuples.push({ category: category, row: row, kw: kw });
      });
    });
    // Strongest keyword evidence first; ties keep invoice order (stable-ish).
    tuples.sort(function (a, b) { return b.kw - a.kw; });

    var results = {};
    var usedRows = [];
    tuples.forEach(function (t) {
      if (results[t.category]) return;                 // category already filled
      if (usedRows.indexOf(t.row) !== -1) return;      // row already used
      var invoicePrice = t.row.rate != null ? t.row.rate : null;
      var invoiceName = cleanName(t.row.text);
      // 'matched' when the keyword fit is decisive (>=2 hints or a strong single
      // hint); otherwise 'review' so the tech eyeballs the categorization.
      var status = t.kw >= 2 ? 'matched' : 'review';
      results[t.category] = {
        rawLine: t.row.text,
        matchedName: invoiceName,
        displayName: invoiceName,
        catalogName: null,
        brandConflict: false,
        sku: null,                                     // set by the catalog upsert in app.js
        priceInr: invoicePrice,
        invoicePriceInr: invoicePrice,
        invoiceLineTotal: t.row.total,
        catalogPriceInr: null,
        priceSource: invoicePrice != null ? 'invoice' : 'none',
        confidence: Math.min(1, 0.6 + t.kw * 0.12),
        status: status,
        category: t.category
      };
      usedRows.push(t.row);
    });

    var filledCount = 0, reviewCount = 0;
    Object.keys(results).forEach(function (c) {
      filledCount++;
      if (results[c].status !== 'matched') reviewCount++;
    });

    return { results: results, filledCount: filledCount, reviewCount: reviewCount, candidateLines: rows };
  }

  var api = {
    buildFromInvoice: buildFromInvoice,
    normalizeLines: normalizeLines,
    reconstructRows: reconstructRows,
    brandConflict: brandConflict,
    brandOf: brandOf,
    // exposed for unit tests / debugging
    _isCandidate: isCandidate,
    _stripRowNoise: stripRowNoise,
    _cleanInvoiceName: cleanInvoiceName,
    _keywordScore: keywordScore,
    ALL_CATEGORIES: ALL_CATEGORIES
  };

  if (typeof window !== 'undefined') window.NeoQcInvoiceImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
