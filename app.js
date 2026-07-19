const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

// Global safety net. An unhandled exception or promise rejection in the
// renderer can leave the UI wedged — and because this is a frameless window,
// a wedged renderer shows as an unresponsive WHITE screen with white window
// controls. Catch and log both (the main process mirrors renderer console to
// electron-log) so a single stray async failure never kills the session, and
// so we have a breadcrumb if it recurs.
window.addEventListener('error', (e) => {
  console.error('[GlobalError]', e.message, (e.filename || '') + ':' + (e.lineno || ''), e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error('[UnhandledRejection]', r && (r.stack || r.message || String(r)));
});

// Component Autocomplete Database
//
// Primary source: a local cache of Supabase's component_prices table (5,000+
// real, priced parts scraped from pcstudio.in), matched via shared/matcher.js
// (the same token-weighted scorer ppi_sync.py uses — far better than generic
// string distance for spec text like "RTX 4060 Ventus 2X 8GB").
//
// Fallback: the old hand-curated assets/component-data/*.json name lists +
// Fuse.js, used only until the first successful catalog sync (or if the app
// is fully offline with no cache yet) — never worse than the pre-existing
// behavior, only strictly better once the real catalog is available.
let componentDB = {
  cpu: [],
  gpu: [],
  motherboard: [],
  ram: [],
  storage: [],
  psu: [],
  case: [],
  cooler: []
};
let fuseInstances = {};
let catalogMatcher = null;   // NeoQcMatcher.Matcher instance over the cached real catalog, once loaded
let catalogSyncedAt = null;

function loadComponentDatabase() {
  const categories = ['cpu', 'gpu', 'motherboard', 'ram', 'storage', 'psu', 'case', 'cooler'];
  categories.forEach(cat => {
    const file = path.join(__dirname, 'assets', 'component-data', `${cat}.json`);
    try {
      if (fs.existsSync(file)) {
        componentDB[cat] = JSON.parse(fs.readFileSync(file, 'utf8'));
        fuseInstances[cat] = new Fuse(componentDB[cat], {
          threshold: 0.4,
          distance: 100
        });
      } else {
        console.warn(`Component database file not found: ${file}`);
      }
    } catch (e) {
      console.error(`Failed to load component data for ${cat}:`, e);
    }
  });
}

// Load whatever catalog cache is already on disk (instant, offline-capable —
// this is what most app launches will use, since the fresh sync below
// happens in the background and simply replaces this once it lands).
async function loadCatalogCacheFromDisk() {
  try {
    const cached = await ipcRenderer.invoke('catalog:read-cache');
    if (cached && Array.isArray(cached) && cached.length && window.NeoQcMatcher) {
      catalogMatcher = new window.NeoQcMatcher.Matcher(cached);
      console.log(`Catalog cache loaded from disk: ${cached.length} components.`);
    }
  } catch (e) {
    console.error('Failed to load catalog cache from disk:', e);
  }
}

// Pull the live component_prices table from Supabase and persist it locally.
// Runs in the background (not awaited at boot) so it never blocks the splash
// screen — the disk cache (or the assets/component-data fallback) covers the
// gap until this completes.
async function syncCatalogCache() {
  if (!supabaseClient) return;
  try {
    const all = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabaseClient
        .from('component_prices')
        .select('sku,name,category,price_inr')
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      all.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    if (!all.length) return;

    await ipcRenderer.invoke('catalog:write-cache', all);
    if (window.NeoQcMatcher) {
      catalogMatcher = new window.NeoQcMatcher.Matcher(all);
    }
    catalogSyncedAt = new Date().toISOString();
    console.log(`Catalog cache synced from Supabase: ${all.length} components.`);
  } catch (e) {
    console.error('Catalog cache sync failed (using disk cache / bundled fallback instead):', e);
  }
}

// Track the resolved sku/price behind whatever text is currently sitting in
// each spec input — nothing writes this into ticket.specs yet (that stays a
// plain string, unchanged), but it's available in-memory for later use
// (e.g. a future "Search Online" flow, or richer PPI wiring) without a
// second lookup once a real catalog suggestion has been picked.
const specFieldMatches = {};

// Track SKUs we've already tried to price this session so a quick pick →
// re-pick doesn't spam the retailer lookup for the same item.
const priceLookupTried = new Set();

// ── Awaiting Components v2 ──────────────────────────────────────────────
// In-memory list of parts the customer is still waiting for. Shape:
//   [{ category: 'gpu', note: 'Gigabyte RTX 4080 Super' | null }, ...]
// Persisted as the ticket's `missingComponents` field (JSON.stringify'd so
// the existing text column in Supabase carries it without a migration).
// Legacy ticket data (a plain string like "Gigabyte RTX 4080 Super") is
// normalised into a single {category:'other', note} entry on load.
const awaitingComponentsList = [];

// Component condition / damage report — [{ category, condition:'doa'|'damaged',
// note }]. Persisted on the ticket as `damagedComponents` and nested inside
// specs.__damaged so cross-machine Supabase sync carries it without a schema
// change (same trick as specs.__prices / specs.__detected).
const damagedComponentsList = [];
const DAMAGE_CATEGORY_LABEL = {
  cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'Storage', psu: 'PSU',
  motherboard: 'Motherboard', cooler: 'Cooler', case: 'Case', other: 'Other'
};

// True if this ticket currently has any DOA/damaged parts flagged.
function hasDamagedComponents(ticket) {
  var list = ticket && (ticket.damagedComponents || (ticket.specs && ticket.specs.__damaged));
  return Array.isArray(list) && list.length > 0;
}

function renderDamagedComponents() {
  var listEl = document.getElementById('damage-list');
  var badge = document.getElementById('damage-status-badge');
  if (!listEl) return;
  listEl.innerHTML = '';
  damagedComponentsList.forEach(function (entry, idx) {
    var row = document.createElement('div');
    row.className = 'damage-item';
    var tagClass = entry.condition === 'doa' ? 'tag-doa' : 'tag-damaged';
    var tagText = entry.condition === 'doa' ? 'DOA' : 'DAMAGED';
    row.innerHTML =
      '<span class="damage-tag ' + tagClass + '">' + tagText + '</span>' +
      '<span class="damage-part">' + (DAMAGE_CATEGORY_LABEL[entry.category] || entry.category) + '</span>' +
      '<span class="damage-desc">' + (entry.note ? escapeHtmlLite(entry.note) : '<em>no description</em>') + '</span>' +
      '<button type="button" class="damage-remove" data-idx="' + idx + '">Remove</button>';
    row.querySelector('.damage-remove').addEventListener('click', function () {
      damagedComponentsList.splice(idx, 1);
      renderDamagedComponents();
    });
    listEl.appendChild(row);
  });
  if (badge) badge.classList.toggle('hidden', damagedComponentsList.length === 0);
}

function escapeHtmlLite(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// Which target-build-spec input matches each awaiting category. "other" has
// no spec field — those chips are informational only.
const AWAITING_CATEGORY_TO_SPEC = {
  cpu: 'form-spec-cpu',
  gpu: 'form-spec-gpu',
  ram: 'form-spec-ram',
  storage: 'form-spec-storage',
  psu: 'form-spec-psu',
  motherboard: 'form-spec-mobo',
  cooler: 'form-spec-cooler-model',
  case: 'form-spec-case'
};

// Human-readable rendering of a ticket's missingComponents value — accepts
// the new JSON-array shape, a legacy plain string, or empty. Used in the
// dashboard card and anywhere else the awaiting list surfaces.
window.NeoQcFormatMissing = formatMissingComponentsHuman;
function formatMissingComponentsHuman(raw) {
  const list = parseAwaitingComponents(raw);
  if (!list.length) return 'Parts unspecified';
  return list.map(a => {
    const cat = a.category === 'other' ? '' : a.category.toUpperCase();
    if (cat && a.note) return `${cat} — ${a.note}`;
    return cat || a.note || '';
  }).filter(Boolean).join(', ');
}

function parseAwaitingComponents(raw) {
  // Accepts: array (new shape), JSON-string of an array, plain legacy string.
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(a => a && a.category).map(a => ({ category: a.category, note: a.note || null }));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(a => a && a.category);
      } catch (_) {}
    }
    // Legacy free-text: preserve as a single "other" entry so nothing is lost.
    return [{ category: 'other', note: trimmed }];
  }
  return [];
}

function markSpecFieldAwaiting(category, note) {
  const fid = AWAITING_CATEGORY_TO_SPEC[category];
  if (!fid) return;
  const input = document.getElementById(fid);
  if (!input) return;
  input.dataset.awaiting = '1';
  input.disabled = true;
  input.removeAttribute('required');
  // Prefill the note as the intended-model spec value if the field is blank —
  // when the part arrives, technician removes the chip and the model is
  // already there. The pink "⏳ Awaiting" label badge is the visual cue.
  if (note && !input.value) input.value = note;
  // Label badge: find the sibling label and append a small pill if not there.
  const container = input.closest('.form-group');
  if (container) {
    let badge = container.querySelector('.awaiting-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'awaiting-badge';
      badge.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 6px;background:rgba(231,1,78,0.15);color:var(--primary-pink);font-size:0.65rem;font-weight:700;letter-spacing:0.05em;border-radius:3px;text-transform:uppercase;';
      badge.textContent = '⏳ Awaiting';
      const label = container.querySelector('label');
      if (label) label.appendChild(badge);
    }
  }
}

function unmarkSpecFieldAwaiting(category) {
  const fid = AWAITING_CATEGORY_TO_SPEC[category];
  if (!fid) return;
  const input = document.getElementById(fid);
  if (!input) return;
  delete input.dataset.awaiting;
  input.disabled = false;
  // Re-add required on fields that were originally required (asterisked in HTML).
  const container = input.closest('.form-group');
  if (container) {
    const label = container.querySelector('label');
    if (label && label.textContent.includes('*')) input.setAttribute('required', 'required');
    const badge = container.querySelector('.awaiting-badge');
    if (badge) badge.remove();
  }
  // Do NOT auto-clear the prefilled note on removal — when the part arrives
  // the tech typically wants that value to become the actual spec. They can
  // clear it manually if they want to type something different.
}

function renderAwaitingChips() {
  const listEl = document.getElementById('awaiting-chips-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  // First reset every spec field so removals actually take effect
  Object.keys(AWAITING_CATEGORY_TO_SPEC).forEach(unmarkSpecFieldAwaiting);

  awaitingComponentsList.forEach((entry, idx) => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:3px 8px 3px 10px;background:rgba(231,1,78,0.12);color:var(--primary-pink);border-radius:12px;font-size:0.75rem;font-weight:600;';
    const label = entry.category.toUpperCase() + (entry.note ? ' — ' + entry.note : '');
    chip.textContent = label;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.style.cssText = 'border:none;background:transparent;color:var(--primary-pink);font-size:1rem;line-height:1;cursor:pointer;padding:0 2px;';
    rm.addEventListener('click', () => {
      awaitingComponentsList.splice(idx, 1);
      renderAwaitingChips();
    });
    chip.appendChild(rm);
    listEl.appendChild(chip);
    markSpecFieldAwaiting(entry.category, entry.note);
  });

  // Sync the hidden legacy input so any code path that still reads
  // #form-missing-components as a string sees a sensible summary.
  const legacyInput = document.getElementById('form-missing-components');
  if (legacyInput) {
    legacyInput.value = awaitingComponentsList
      .map(a => (a.category === 'other' && a.note) ? a.note : a.category.toUpperCase() + (a.note ? ' (' + a.note + ')' : ''))
      .join(', ');
  }
}

// Fire a background web lookup for a catalog entry that has price_inr = null,
// upsert the found price back into Supabase, and update the local matcher +
// specFieldMatches so the ticket ends up carrying a real price. Fire-and-
// forget: never blocks the UI, silent on failure (the ticket still saves
// fine with a null price — this just enriches when it works).
async function fillMissingPrice(catalogHit, field) {
  if (!catalogHit || !catalogHit.matchedName || catalogHit.priceInr != null) return;
  if (priceLookupTried.has(catalogHit.sku)) return;
  priceLookupTried.add(catalogHit.sku);
  if (!window.NeoQcWebLookup || !supabaseClient) return;
  try {
    const result = await window.NeoQcWebLookup.lookup(
      catalogHit.matchedName,
      catalogHit.category,
      (url) => ipcRenderer.invoke('catalog:fetch-url', { url }),
      supabaseClient
    );
    if (!result || !result.found || result.price_inr == null) return;
    const foundPrice = Number(result.price_inr);
    if (!isFinite(foundPrice) || foundPrice <= 0) return;
    // Update the ORIGINAL row (by its real sku) with the found price,
    // separately from the WEB-<slug> row consolidate_and_upsert wrote.
    supabaseClient.from('component_prices')
      .update({ price_inr: foundPrice, updated_at: new Date().toISOString() })
      .eq('sku', catalogHit.sku)
      .then(({ error }) => { if (error) console.warn('price-fill update failed:', error.message); });
    // Keep local matcher entry consistent
    if (catalogMatcher && catalogMatcher._entries) {
      const entry = catalogMatcher._entries.find(e => e.sku === catalogHit.sku);
      if (entry) entry.priceInr = foundPrice;
    }
    // If the field still holds this pick, upgrade its stored price so the
    // ticket save carries it into the report's cost breakdown.
    const match = specFieldMatches[field.inputId];
    if (match && match.sku === catalogHit.sku) match.priceInr = foundPrice;
    console.log(`Price filled for ${catalogHit.sku}: ₹${foundPrice}`);
  } catch (e) {
    console.warn('fillMissingPrice failed:', e.message);
  }
}

function setupSpecsAutocomplete() {
  loadComponentDatabase(); // fallback lists — see loadCatalogCacheFromDisk()/syncCatalogCache() for the primary source

  const fields = [
    { inputId: 'form-spec-mobo', listId: 'autocomplete-mobo', category: 'motherboard' },
    { inputId: 'form-spec-cpu', listId: 'autocomplete-cpu', category: 'cpu' },
    { inputId: 'form-spec-gpu', listId: 'autocomplete-gpu', category: 'gpu' },
    { inputId: 'form-spec-ram', listId: 'autocomplete-ram', category: 'ram' },
    { inputId: 'form-spec-storage', listId: 'autocomplete-storage', category: 'storage' },
    { inputId: 'form-spec-psu', listId: 'autocomplete-psu', category: 'psu' },
    { inputId: 'form-spec-case', listId: 'autocomplete-case', category: 'case' },
    { inputId: 'form-spec-cooler-model', listId: 'autocomplete-cooler', category: 'cooler' }
  ];

  fields.forEach(field => {
    const input = document.getElementById(field.inputId);
    const list = document.getElementById(field.listId);
    if (!input || !list) return;

    const renderItem = (label, sub, onPick) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      if (sub) {
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.gap = '10px';
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        const subEl = document.createElement('span');
        subEl.textContent = sub;
        subEl.style.opacity = '0.65';
        subEl.style.fontSize = '0.72em';
        subEl.style.whiteSpace = 'nowrap';
        item.appendChild(labelEl);
        item.appendChild(subEl);
      } else {
        item.textContent = label;
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onPick();
        list.classList.add('hidden');
      });
      list.appendChild(item);
    };

    // "Search Online" row — appended below whatever local suggestions exist
    // (or on its own if there are none) when nothing confident was found
    // locally. Manages the list's contents itself (loading -> result state)
    // rather than the pick-and-close behavior of renderItem, since a live
    // lookup takes several seconds.
    const renderSearchOnlineRow = (query) => {
      const row = document.createElement('div');
      row.className = 'autocomplete-item autocomplete-search-online';
      row.style.color = 'var(--primary-pink)';
      row.style.fontWeight = '600';
      row.textContent = `🔍 Search online for "${query}"`;
      row.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        row.textContent = 'Searching pcstudio.in-alternative retailers… (up to 30s)';
        row.style.pointerEvents = 'none';
        row.style.opacity = '0.7';
        try {
          // Pure-JS lookup (web-lookup.js): only the raw HTTP fetch goes
          // through the main process (catalog:fetch-url — renderer fetch is
          // CORS-bound, main-process net.fetch is not). No Python involved —
          // the old spawn-pcstudio_import.py path failed with ENOENT on every
          // packaged install (scripts inside app.asar, no Python on shop PCs).
          const result = await window.NeoQcWebLookup.lookup(
            query,
            field.category,
            (url) => ipcRenderer.invoke('catalog:fetch-url', { url }),
            supabaseClient
          );
          list.innerHTML = '';
          if (result && result.found) {
            const priceLabel = result.price_inr != null
              ? `₹${Math.round(result.price_inr).toLocaleString('en-IN')} (avg of ${result.price_sample_size} listing${result.price_sample_size === 1 ? '' : 's'})`
              : 'price unknown';
            const webDisplayName = window.NeoQcMatcher && window.NeoQcMatcher.cleanName
              ? window.NeoQcMatcher.cleanName(result.name) : result.name;
            renderItem(webDisplayName, priceLabel, () => {
              input.value = webDisplayName;
              specFieldMatches[field.inputId] = { sku: result.sku, priceInr: result.price_inr, category: result.category, confidence: 1, webLookup: true };
            });
            if (catalogMatcher) {
              catalogMatcher.addEntry({ sku: result.sku, name: result.name, category: result.category, price_inr: result.price_inr });
            }
            if (!result.upserted) {
              const warn = document.createElement('div');
              warn.className = 'dr-muted';
              warn.style.padding = '6px 12px';
              warn.style.fontSize = '0.72em';
              warn.textContent = `Found and usable now, but saving to the shared catalog failed (${result.upsert_error || 'unknown error'}) — it'll need re-adding for other technicians.`;
              list.appendChild(warn);
            }
            list.classList.remove('hidden');
          } else {
            list.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'autocomplete-item';
            msg.style.opacity = '0.7';
            msg.textContent = (result && result.message) || (result && result.error) || 'No listings found for that search.';
            list.appendChild(msg);
            list.classList.remove('hidden');
          }
        } catch (err) {
          list.innerHTML = '';
          const msg = document.createElement('div');
          msg.className = 'autocomplete-item';
          msg.textContent = `Search failed: ${err.message}`;
          list.appendChild(msg);
        }
      });
      list.appendChild(row);
    };

    // Always-available manual entry. Two things happen on click:
    //   1. Immediate: field is filled with the typed text, dropdown closes
    //      — the technician is never blocked, editing continues instantly.
    //   2. Background (fire-and-forget): the typed part is upserted to
    //      Supabase `component_prices` as MANUAL-<slug> with needs_review=true
    //      and added to the in-memory catalogMatcher so it's immediately
    //      searchable this session. Next technician on any machine sees the
    //      new part in autocomplete without needing to type it again.
    const renderManualRow = (query) => {
      const row = document.createElement('div');
      row.className = 'autocomplete-item autocomplete-manual-entry';
      row.style.opacity = '0.85';
      row.style.borderTop = '1px dashed rgba(15, 23, 42, 0.15)';
      row.textContent = `✏️ Use "${query}" — add to catalog for next time`;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = query;
        list.classList.add('hidden');
        list.innerHTML = '';
        const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        const manualSku = 'MANUAL-' + slug;
        specFieldMatches[field.inputId] = {
          sku: manualSku, priceInr: null, category: field.category,
          confidence: 1, manualEntry: true
        };
        // Immediately add to the local matcher so this session sees it
        if (catalogMatcher && catalogMatcher.addEntry) {
          catalogMatcher.addEntry({ sku: manualSku, name: query, category: field.category, price_inr: null });
        }
        // Background upsert — never blocks the UI. Failure is logged but
        // silent (technician's ticket is fine either way).
        if (supabaseClient) {
          const now = new Date().toISOString();
          supabaseClient.from('component_prices').upsert({
            sku: manualSku, name: query, category: field.category,
            price_inr: null, source: 'manual-entry', source_method: 'technician-typed',
            fetched_at: now, updated_at: now, needs_review: true
          }, { onConflict: 'sku' }).then(({ error }) => {
            if (error) console.warn('manual-entry upsert failed:', error.message);
          });
        }
      });
      list.appendChild(row);
    };

    const updateSuggestions = () => {
      const val = input.value.trim();
      list.innerHTML = '';
      if (!val) {
        list.classList.add('hidden');
        return;
      }
      const suggestThreshold = (window.NeoQcMatcher && window.NeoQcMatcher.SUGGEST_THRESHOLD) || 0.55;

      // Primary: the real, priced catalog (5,000+ pcstudio.in components),
      // matched with the same token-weighted scorer ppi_sync.py uses.
      if (catalogMatcher) {
        const results = catalogMatcher.suggest(val, field.category, 10);
        const bestConfidence = results.length ? results[0].confidence : 0;
        if (results.length > 0) {
          list.classList.remove('hidden');
          results.forEach(res => {
            // Display + store WITHOUT the manufacturer part code — nobody
            // wants "(100-100001277WOF)" on dropdowns, specs, or reports.
            // The SKU keeps the exact identity; matching handles clean names.
            const displayName = window.NeoQcMatcher && window.NeoQcMatcher.cleanName
              ? window.NeoQcMatcher.cleanName(res.matchedName) : res.matchedName;
            // ~780 catalog rows have price_inr = NULL (they were ₹0 / out of
            // stock at scrape time). Mark them clearly and trigger a
            // background web lookup when picked, so the ticket ends up with
            // a real price without the technician having to hit "Search
            // Online" manually.
            const priceLabel = res.priceInr != null
              ? `₹${Math.round(res.priceInr).toLocaleString('en-IN')}`
              : '🔎 price pending';
            renderItem(displayName, priceLabel, () => {
              input.value = displayName;
              specFieldMatches[field.inputId] = { sku: res.sku, priceInr: res.priceInr, category: res.category, confidence: res.confidence };
              if (res.priceInr == null) fillMissingPrice(res, field);
            });
          });
        }
        if (val.length >= 3 && bestConfidence < suggestThreshold) {
          list.classList.remove('hidden');
          renderSearchOnlineRow(val);
        }
        if (results.length > 0 || (val.length >= 3 && bestConfidence < suggestThreshold)) {
          if (val.length >= 3) renderManualRow(val);
          return;
        }
        // Catalog is loaded but genuinely has nothing close and the query is
        // too short to offer online search yet — fall through to the
        // bundled list rather than showing an empty dropdown.
      }

      // Fallback: bundled hand-curated list (used before the first catalog
      // sync completes, or if Supabase is unreachable).
      const fuse = fuseInstances[field.category];
      const fuseResults = fuse ? fuse.search(val).slice(0, 10) : [];
      if (fuseResults.length === 0 && !(val.length >= 3)) {
        list.classList.add('hidden');
        return;
      }
      list.classList.remove('hidden');
      fuseResults.forEach(res => {
        renderItem(res.item, '', () => {
          input.value = res.item;
          delete specFieldMatches[field.inputId];
        });
      });
      if (val.length >= 3 && fuseResults.length === 0) {
        renderSearchOnlineRow(val);
      }
      if (val.length >= 3) renderManualRow(val);
    };

    // Debounce keystrokes: scoring 8,000+ catalog entries on every character
    // (with re-render + DOM writes) made typing feel laggy. 120 ms is fast
    // enough that a natural pause after a word triggers results, and slow
    // enough that a burst of typing collapses to a single evaluation.
    let debounceTimer = null;
    const debounced = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(updateSuggestions, 120);
    };
    input.addEventListener('input', debounced);
    input.addEventListener('focus', () => {
      // Focus should re-open a list only when there's already text — otherwise
      // just landing in the field fires the matcher over the whole catalog.
      if (input.value.trim()) updateSuggestions();
    });
    input.addEventListener('blur', () => {
      // Clear as well as hide: an empty list is display:none via the
      // :empty rule, so a stale hidden list can never paint its border
      // over a sibling field's open dropdown again.
      setTimeout(() => {
        list.classList.add('hidden');
        list.innerHTML = '';
      }, 200);
    });
  });

  // Cooler-type radios → model input visibility. Until now ONLY the
  // edit-ticket load path toggled this field, so on a fresh ticket choosing
  // "Air Cooler" or "AIO Liquid Cooler" never revealed the model input at
  // all — there was literally no way to type the cooler model.
  document.querySelectorAll('input[name="form-spec-cooler-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const modelEl = document.getElementById('form-spec-cooler-model');
      if (!modelEl) return;
      if (radio.value === 'stock') {
        modelEl.classList.add('hidden');
        modelEl.removeAttribute('required');
        modelEl.value = '';
        delete specFieldMatches['form-spec-cooler-model'];
      } else {
        modelEl.classList.remove('hidden');
        modelEl.setAttribute('required', 'required');
        modelEl.placeholder = `Search or type ${radio.value === 'aio' ? 'AIO liquid' : 'air'} cooler model...`;
        modelEl.focus();
      }
    });
  });
}

// ==========================================================================
// INVOICE IMPORT — fill Target Build Spec fields from a matched invoice build
// (see invoice-import.js for the parse + catalog-match logic).
// ==========================================================================
const CATEGORY_TO_SPEC_FIELD = {
  cpu: 'form-spec-cpu', gpu: 'form-spec-gpu', ram: 'form-spec-ram',
  storage: 'form-spec-storage', psu: 'form-spec-psu', motherboard: 'form-spec-mobo',
  case: 'form-spec-case', cooler: 'form-spec-cooler-model'
};

// Fill one target spec field from an invoice match. Mirrors what an autocomplete
// pick does: sets input.value + specFieldMatches[fieldId]. Returns a status
// string ('filled' | 'skipped-awaiting' | 'no-field').
function fillTargetSpecFromInvoice(category, entry) {
  const fieldId = CATEGORY_TO_SPEC_FIELD[category];
  if (!fieldId) return 'no-field';
  const input = document.getElementById(fieldId);
  if (!input) return 'no-field';
  // Don't clobber a field the tech marked as "awaiting" (disabled) — the part
  // isn't in hand yet, even if it's on the invoice.
  if (input.disabled || input.getAttribute('data-awaiting') === '1') return 'skipped-awaiting';

  // Cooler: flip the type radio off "stock" so the model input is visible +
  // required before we fill it. AIO/liquid vs air inferred from the name.
  if (category === 'cooler') {
    const nm = (entry.matchedName || entry.rawLine || '');
    const isAio = /\b(aio|liquid|kraken|freezer|ml\d{3}|(240|280|360)\s*mm)\b/i.test(nm);
    const radio = document.querySelector(`input[name="form-spec-cooler-type"][value="${isAio ? 'aio' : 'air'}"]`);
    if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  }

  input.value = entry.displayName || entry.matchedName || entry.rawLine;
  if (entry.sku) {
    specFieldMatches[fieldId] = {
      sku: entry.sku, priceInr: entry.priceInr, category: category,
      confidence: entry.confidence, fromInvoice: true
    };
  } else {
    // No catalog hit — honest manual entry, no fabricated sku/price.
    specFieldMatches[fieldId] = {
      sku: null, priceInr: null, category: category, manualEntry: true, fromInvoice: true
    };
  }
  return 'filled';
}

// Background component-compatibility ("synergy") check. Reads the current target
// spec field values, runs the rules in compat-check.js, and renders any socket /
// RAM-generation disparities so the technician notices. Fully guarded — a fault
// here must never block the form.
function renderConfigSynergy() {
  try {
    const box = document.getElementById('config-synergy-warnings');
    if (!box || !window.NeoQcCompat) return;
    const get = (id) => { const el = document.getElementById(id); return el ? (el.value || '').trim() : ''; };
    const specs = {
      cpu: get('form-spec-cpu'),
      motherboard: get('form-spec-mobo'),
      ram: get('form-spec-ram')
    };
    const warnings = window.NeoQcCompat.check(specs) || [];
    if (!warnings.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML =
      '<div class="synergy-title">⚡ Compatibility check</div>' +
      warnings.map(function (w) {
        const cls = w.level === 'error' ? 'synergy-error' : 'synergy-warn';
        const icon = w.level === 'error' ? '⛔' : '⚠️';
        return '<div class="synergy-item ' + cls + '">' + icon + ' <span>' + escapeHtmlLite(w.msg) + '</span></div>';
      }).join('');
  } catch (e) { console.warn('synergy check failed (non-fatal):', e); }
}

// Apply a full invoice build result to the form, return a summary for the UI.
function applyInvoiceBuild(build) {
  const summary = { filled: [], review: [], manual: [], skipped: [] };
  Object.keys(build.results).forEach(category => {
    const entry = build.results[category];
    const outcome = fillTargetSpecFromInvoice(category, entry);
    if (outcome === 'skipped-awaiting') { summary.skipped.push(category); return; }
    if (outcome !== 'filled') return;
    if (entry.status === 'matched') summary.filled.push({ category, entry });
    else if (entry.status === 'review') summary.review.push({ category, entry });
    else summary.manual.push({ category, entry });
  });
  return summary;
}

// ==========================================================================
// PPI ENGINE — Use-Case Tuning (Settings). Lets staff edit the Price-
// Performance Index knobs (per-use-case component weights, min-recommended
// PassMark thresholds, single-thread emphasis, bottleneck ratio) with no code
// change. Persisted in appState.settings.ppiConfig and applied to the live
// window.NeoQcPpi tables — mutated IN PLACE so ppi.js's closures see them.
// ==========================================================================
const PPI_WEIGHT_KEYS = ['cpu', 'gpu', 'ram', 'storage', 'other'];
let PPI_ENGINE_DEFAULTS = null; // pristine snapshot, captured once before any override

// Read the engine's current tables into a plain editable config object.
function ppiConfigFromEngine() {
  const P = window.NeoQcPpi;
  const out = { version: 1, useCases: {}, bottleneckRatio: (P && P.TUNING && P.TUNING.bottleneckRatio) || 1.6 };
  if (!P) return out;
  Object.keys(P.USE_CASE_WEIGHTS).forEach(uc => {
    const w = P.USE_CASE_WEIGHTS[uc] || {};
    const m = P.MIN_RECOMMENDED[uc] || {};
    const st = P.CPU_ST_EMPHASIS ? P.CPU_ST_EMPHASIS[uc] : null;
    out.useCases[uc] = {
      cpu: +w.cpu || 0, gpu: +w.gpu || 0, ram: +w.ram || 0, storage: +w.storage || 0, other: +w.other || 0,
      minCpu: +m.cpu || 0, minGpu: +m.gpu || 0, st: st != null ? +st : 0.4
    };
  });
  return out;
}

// Write a config object back into the engine's live tables (in place).
function applyPpiConfig(cfg) {
  const P = window.NeoQcPpi;
  if (!P || !cfg || !cfg.useCases) return;
  const clear = (o) => { if (o) Object.keys(o).forEach(k => delete o[k]); };
  clear(P.USE_CASE_WEIGHTS); clear(P.MIN_RECOMMENDED); clear(P.CPU_ST_EMPHASIS);
  Object.keys(cfg.useCases).forEach(uc => {
    const r = cfg.useCases[uc];
    P.USE_CASE_WEIGHTS[uc] = { cpu: +r.cpu || 0, gpu: +r.gpu || 0, ram: +r.ram || 0, storage: +r.storage || 0, other: +r.other || 0 };
    P.MIN_RECOMMENDED[uc] = { cpu: +r.minCpu || 0, gpu: +r.minGpu || 0 };
    if (P.CPU_ST_EMPHASIS) P.CPU_ST_EMPHASIS[uc] = r.st != null ? +r.st : 0.4;
  });
  if (P.TUNING && cfg.bottleneckRatio) P.TUNING.bottleneckRatio = +cfg.bottleneckRatio || 1.6;
}

// Boot: capture pristine defaults, seed the saved config if absent, apply it.
function initPpiTuning() {
  if (!window.NeoQcPpi) return;
  if (!PPI_ENGINE_DEFAULTS) PPI_ENGINE_DEFAULTS = ppiConfigFromEngine();
  if (!appState.settings) appState.settings = {};
  if (!appState.settings.ppiConfig || !appState.settings.ppiConfig.useCases) {
    appState.settings.ppiConfig = JSON.parse(JSON.stringify(PPI_ENGINE_DEFAULTS));
  }
  applyPpiConfig(appState.settings.ppiConfig);
}

function ppiRowSum(r) { return PPI_WEIGHT_KEYS.reduce((s, k) => s + (+r[k] || 0), 0); }

// Pretty display label for a use-case key: "gaming-1080p" → "GAMING 1080P",
// "ai-ml" → "AI ML", "content-creation" → "CONTENT CREATION". The raw key
// (data-uc) stays canonical for the engine; this is display-only.
function ppiUseCaseLabel(uc) { return String(uc).replace(/-/g, ' ').toUpperCase(); }

function paintPpiSum(cell) {
  const sum = parseFloat(cell.textContent);
  const ok = Math.abs(sum - 1) < 0.001;
  cell.style.color = ok ? 'var(--status-completed, #10b981)' : 'var(--primary-pink)';
  cell.style.fontWeight = '700';
  cell.title = ok ? 'Weights sum to 1.00' : 'Weights should sum to 1.00';
}

function renderPpiConfigTable() {
  const body = document.getElementById('ppi-tuning-body');
  if (!body) return;
  if (!appState.settings.ppiConfig) initPpiTuning();
  const cfg = appState.settings.ppiConfig;
  body.innerHTML = '';
  Object.keys(cfg.useCases).forEach(uc => {
    const r = cfg.useCases[uc];
    const tr = document.createElement('tr');
    const cell = (field, val, step) => `<td><input type="number" step="${step}" class="ppi-cell-input" data-uc="${uc}" data-field="${field}" value="${val}"></td>`;
    tr.innerHTML =
      `<td class="ppi-usecase-name">${ppiUseCaseLabel(uc)}</td>` +
      cell('cpu', r.cpu, '0.05') + cell('gpu', r.gpu, '0.05') + cell('ram', r.ram, '0.05') +
      cell('storage', r.storage, '0.05') + cell('other', r.other, '0.05') +
      `<td class="ppi-sum-cell" data-uc="${uc}">${ppiRowSum(r).toFixed(2)}</td>` +
      cell('minCpu', r.minCpu, '500') + cell('minGpu', r.minGpu, '500') + cell('st', r.st, '0.05') +
      `<td><button class="text-btn text-crimson ppi-remove-uc" data-uc="${uc}">Remove</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('.ppi-sum-cell').forEach(c => paintPpiSum(c));
  const brInput = document.getElementById('ppi-bottleneck-ratio');
  if (brInput) brInput.value = cfg.bottleneckRatio != null ? cfg.bottleneckRatio : 1.6;

  body.querySelectorAll('.ppi-cell-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const uc = inp.getAttribute('data-uc');
      const field = inp.getAttribute('data-field');
      const v = parseFloat(inp.value);
      cfg.useCases[uc][field] = isNaN(v) ? 0 : v;
      if (PPI_WEIGHT_KEYS.includes(field)) {
        const sc = body.querySelector(`.ppi-sum-cell[data-uc="${uc}"]`);
        if (sc) { sc.textContent = ppiRowSum(cfg.useCases[uc]).toFixed(2); paintPpiSum(sc); }
      }
    });
  });
  body.querySelectorAll('.ppi-remove-uc').forEach(btn => {
    btn.addEventListener('click', () => {
      const uc = btn.getAttribute('data-uc');
      if (Object.keys(cfg.useCases).length <= 1) { alert('At least one use case must remain.'); return; }
      if (confirm(`Remove use case "${uc}"? PPI will no longer offer it.`)) {
        delete cfg.useCases[uc];
        renderPpiConfigTable();
      }
    });
  });
}

// Attached once (from setupEventListeners). The table itself is (re)rendered on
// each settings open via renderPpiConfigTable().
function setupPpiTuningHandlers() {
  const addBtn = document.getElementById('btn-ppi-add-usecase');
  if (addBtn) addBtn.addEventListener('click', () => {
    const input = document.getElementById('new-ppi-usecase');
    const name = (input.value || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    if (!appState.settings.ppiConfig) initPpiTuning();
    const cfg = appState.settings.ppiConfig;
    if (cfg.useCases[name]) { alert('That use case already exists.'); return; }
    cfg.useCases[name] = { cpu: 0.2, gpu: 0.4, ram: 0.1, storage: 0.1, other: 0.2, minCpu: 10000, minGpu: 8000, st: 0.4 };
    input.value = '';
    renderPpiConfigTable();
  });

  const saveBtn = document.getElementById('btn-ppi-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const cfg = appState.settings.ppiConfig;
    if (!cfg) return;
    const br = parseFloat(document.getElementById('ppi-bottleneck-ratio').value);
    cfg.bottleneckRatio = isNaN(br) ? 1.6 : br;
    const bad = Object.keys(cfg.useCases).filter(uc => Math.abs(ppiRowSum(cfg.useCases[uc]) - 1) >= 0.01);
    if (bad.length && !confirm(`These use cases don't sum to 1.00: ${bad.join(', ')}.\nSave anyway? (PPI normalises internally, but 1.00 keeps the weights meaningful.)`)) return;
    applyPpiConfig(cfg);
    await saveDatabase();
    const status = document.getElementById('ppi-tuning-status');
    if (status) { status.classList.remove('hidden'); status.style.color = 'var(--status-completed, #10b981)'; status.textContent = '✓ PPI tuning saved and applied to the engine.'; }
  });

  const resetBtn = document.getElementById('btn-ppi-reset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (!PPI_ENGINE_DEFAULTS) PPI_ENGINE_DEFAULTS = ppiConfigFromEngine();
    if (!confirm('Reset all PPI tuning back to the built-in engine defaults?')) return;
    appState.settings.ppiConfig = JSON.parse(JSON.stringify(PPI_ENGINE_DEFAULTS));
    applyPpiConfig(appState.settings.ppiConfig);
    await saveDatabase();
    renderPpiConfigTable();
    const status = document.getElementById('ppi-tuning-status');
    if (status) { status.classList.remove('hidden'); status.style.color = 'var(--text-muted)'; status.textContent = 'Reset to defaults.'; }
  });
}

// App Global State
let appState = {
  tickets: [],
  technicians: ["Adhil", "Amal", "Ananthakrishnan", "Athul"],
  settings: {
    supabaseUrl: "",
    supabaseAnonKey: "",
    pathHwInfo: "",
    pathCinebench: "",
    pathFurmark: "",
    pathPrime95: ""
  }
};

let currentMode = "selector"; // "selector", "staff", "client"
let editingTicketId = null;

// ==========================================================================
// INITIALIZATION
// ==========================================================================
function setSplashStatus(text) {
  const el = document.getElementById('splash-status-text');
  if (el) el.textContent = text;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Record when boot started so we can enforce a minimum splash display time
  const bootStart = Date.now();

  await loadDatabase();
  initPpiTuning(); // seed + apply saved PPI engine tuning before any PPI compute
  // Restore remembered dark/light choice (admin app only — persisted in settings).
  if (appState.settings && appState.settings.darkMode === true) {
    document.body.classList.add('dark-mode');
    document.body.classList.remove('light-mode');
  } else if (appState.settings && appState.settings.darkMode === false) {
    document.body.classList.add('light-mode');
    document.body.classList.remove('dark-mode');
  }
  setSplashStatus('Preparing workspace…');
  setupEventListeners();
  injectInlineIcons();
  setupSpecsAutocomplete();
  updateTimeDisplay();
  setInterval(updateTimeDisplay, 60000);

  // Navigate to initial screen based on app-config.json or settings
  let bootMode = 'selector';

  if (appState.settings) {
    if (appState.settings.lockAdminMode === true) {
      bootMode = 'staff';
    } else if (appState.settings.isMaster === false) {
      bootMode = 'client';
    }
  }

  try {
    const configPath = path.join(__dirname, 'app-config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.mode === 'admin') {
        bootMode = 'staff';
      } else if (cfg.mode === 'client') {
        bootMode = 'client';
      } else if (cfg.mode === 'selector') {
        bootMode = 'selector';
      }
    }
  } catch (e) {
    console.error("Error reading app-config.json:", e);
  }

  // Hold splash for at least 4200ms so the staged entrance animation plays
  // out fully. If boot took longer than that already, we switch immediately.
  const elapsed = Date.now() - bootStart;
  const minSplash = 4200;
  if (elapsed < minSplash) {
    await new Promise(resolve => setTimeout(resolve, minSplash - elapsed));
  }

  // Gentle fade-out before handing over to the landing screen
  const splashEl = document.getElementById('splash-screen');
  if (splashEl) {
    splashEl.classList.add('splash-fade-out');
    await new Promise(resolve => setTimeout(resolve, 450));
  }

  switchScreen(bootMode);
});

// Load DB from local Electron AppData Storage
async function loadDatabase() {
  setSplashStatus('Loading local database…');
  const dbData = await ipcRenderer.invoke('db:read');
  if (dbData) {
    appState = dbData;
  }

  // Securely initialize missing properties to prevent runtime script crashes
  if (!appState.tickets) appState.tickets = [];
  if (!appState.technicians) appState.technicians = ["Adhil", "Amal", "Ananthakrishnan", "Athul"];

  // Database migration & normalization for new build checks
  let databaseNeedsSaving = false;
  
  if (appState.tickets && appState.tickets.length > 0) {
    appState.tickets.forEach(t => {
      if (t.buildChecks && t.buildChecks.posted === undefined) {
        t.buildChecks.posted = (t.status !== 'building' && t.status !== 'awaiting');
        databaseNeedsSaving = true;
      }
      if (t.diagnostics && t.diagnostics.furmark === undefined) {
        t.diagnostics.furmark = null;
        databaseNeedsSaving = true;
      }
    });
  }

  if (databaseNeedsSaving) {
    await saveDatabase();
  }
  if (!appState.settings) {
    appState.settings = { 
      supabaseUrl: "https://ggsxkhenzdhaachubrsc.supabase.co", 
      supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo", 
      pathHwInfo: "", 
      pathCinebench: "",
      pathFurmark: "",
      pathPrime95: "",
      pathSsdUtility: "",
      isMaster: true,
      autoDetectHw: false,
      lockAdminMode: false,
      accentColor: "pink",
      cpuMaxTemp: 85,
      gpuMaxTemp: 80,
      minSsdSpeed: 3000,
      minSsdWrite: 2500,
      minCinebench: 10000,
      minFurmark: 5000,
      defaultTestDuration: "60",
      autoPdf: false,
      soundEnabled: true,
      disableQcLock: false,
      defaultTech: "",
      sortBy: "deadline",
      shopName: "Neo Tokyo Kochi",
      contactInfo: "kochi@neotokyo.in"
    };
  } else {
    if (!appState.settings.supabaseUrl) appState.settings.supabaseUrl = "https://ggsxkhenzdhaachubrsc.supabase.co";
    if (!appState.settings.supabaseAnonKey) appState.settings.supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo";
    if (!appState.settings.pathHwInfo) appState.settings.pathHwInfo = "";
    if (!appState.settings.pathCinebench) appState.settings.pathCinebench = "";
    if (!appState.settings.pathFurmark) appState.settings.pathFurmark = "";
    if (!appState.settings.pathPrime95) appState.settings.pathPrime95 = "";
    if (!appState.settings.pathSsdUtility) appState.settings.pathSsdUtility = "";
    if (appState.settings.isMaster === undefined) appState.settings.isMaster = true;
    if (appState.settings.autoDetectHw === undefined) appState.settings.autoDetectHw = false;
    if (appState.settings.lockAdminMode === undefined) appState.settings.lockAdminMode = false;
    if (!appState.settings.accentColor) appState.settings.accentColor = "pink";
    if (appState.settings.cpuMaxTemp === undefined) appState.settings.cpuMaxTemp = 85;
    if (appState.settings.gpuMaxTemp === undefined) appState.settings.gpuMaxTemp = 80;
    if (appState.settings.minSsdSpeed === undefined) appState.settings.minSsdSpeed = 3000;
    if (appState.settings.minSsdWrite === undefined) appState.settings.minSsdWrite = 2500;
    if (appState.settings.minCinebench === undefined) appState.settings.minCinebench = 10000;
    if (appState.settings.minFurmark === undefined) appState.settings.minFurmark = 5000;
    if (appState.settings.defaultTestDuration === undefined) appState.settings.defaultTestDuration = "60";
    if (appState.settings.autoPdf === undefined) appState.settings.autoPdf = false;
    if (appState.settings.soundEnabled === undefined) appState.settings.soundEnabled = true;
    if (appState.settings.disableQcLock === undefined) appState.settings.disableQcLock = false;
    if (appState.settings.defaultTech === undefined) appState.settings.defaultTech = "";
    if (appState.settings.sortBy === undefined) appState.settings.sortBy = "deadline";
    if (!appState.settings.shopName) appState.settings.shopName = "Neo Tokyo Kochi";
    if (!appState.settings.contactInfo) appState.settings.contactInfo = "kochi@neotokyo.in";
  }
  applyAccentColor(appState.settings.accentColor);

  setSplashStatus('Connecting to cloud sync…');
  initSupabase();

  setSplashStatus('Loading component catalog…');
  await loadCatalogCacheFromDisk();
  syncCatalogCache(); // background refresh — not awaited, never blocks boot

  // Seed beautiful mock tickets if db is empty to showcase the UI immediately!
  if (!appState.tickets || appState.tickets.length === 0) {
    seedMockTickets();
    await saveDatabase();
    if (supabaseClient) {
      for (const t of appState.tickets) {
        await syncTicketToCloud(t);
      }
    }
  }
  
  setSplashStatus('Syncing tickets…');
  await syncFromCloud();

  // Version check and Changelog Modal trigger
  const currentVersion = require('./package.json').version;
  if (appState.lastRunVersion !== currentVersion) {
    setTimeout(() => {
      const changelogModal = document.getElementById('changelog-modal');
      if (changelogModal) {
        changelogModal.classList.add('active');
      }
    }, 1000);
  }
}

// Save DB back to local storage
async function saveDatabase() {
  await ipcRenderer.invoke('db:write', appState);
}

// Switch between screens
function switchScreen(mode, selectedId = null) {
  currentMode = mode;
  
  // Programmatic scroll resets to prevent offsets
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;

  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });

  if (mode === 'staff') {
    document.getElementById('staff-screen').classList.add('active');
    populateTechnicianDropdowns();
    renderDashboard();
    
    // Hide or show exit button depending on lockAdminMode
    const staffExitBtn = document.getElementById('btn-staff-exit');
    if (staffExitBtn) {
      if (appState.settings.lockAdminMode) {
        staffExitBtn.classList.add('hidden');
      } else {
        staffExitBtn.classList.remove('hidden');
      }
    }
  } else if (mode === 'client') {
    document.getElementById('client-welcome-screen').classList.add('active');
    populateWelcomeTicketSelect();
    
    // Hide or show exit button depending on isMaster
    const welcomeExitBtn = document.getElementById('btn-welcome-exit');
    if (welcomeExitBtn) {
      if (appState.settings.isMaster) {
        welcomeExitBtn.classList.remove('hidden');
      } else {
        welcomeExitBtn.classList.add('hidden');
      }
    }
  } else if (mode === 'client-console') {
    document.getElementById('client-screen').classList.add('active');
    populateClientTicketSelect(selectedId);
    handleClientTicketSelect();
    
    // Hide or show exit button depending on isMaster
    const clientExitBtn = document.getElementById('btn-client-exit');
    if (clientExitBtn) {
      if (appState.settings.isMaster) {
        clientExitBtn.classList.remove('hidden');
      } else {
        clientExitBtn.classList.add('hidden');
      }
    }
  } else {
    document.getElementById('mode-selector-screen').classList.add('active');
    // Landing back on the mode selector is a natural pause point — re-check
    // for OTA updates (main process rate-limits to once per 10 min).
    ipcRenderer.send('update:check');
  }
}

function updateTimeDisplay() {
  const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const timeStr = new Date().toLocaleDateString('en-US', options);
  // Add a nice status line if elements exist
}

// ==========================================================================
// DROPDOWN POPULATORS & RENDERING
// ==========================================================================
function populateTechnicianDropdowns() {
  const staffFilter = document.getElementById('filter-tech');
  const formTech = document.getElementById('form-technician');

  // Preserve select elements
  if (staffFilter && formTech) {
    staffFilter.innerHTML = '<option value="all">All Technicians</option>';
    formTech.innerHTML = '';

    appState.technicians.forEach(tech => {
      const opt1 = document.createElement('option');
      opt1.value = tech;
      opt1.textContent = tech;
      staffFilter.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = tech;
      opt2.textContent = tech;
      formTech.appendChild(opt2);
    });
  }
  

}

function populateClientTicketSelect(selectedId = null) {
  const select = document.getElementById('client-ticket-select');
  if (select) {
    select.innerHTML = '<option value="">-- Choose Ticket --</option>';
    // Filter active builds/repairs only
    const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
    activeTickets.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `[${t.type.toUpperCase()}] ${t.customerName} - Deadline: ${formatDateShort(t.deadline)}`;
      if (selectedId && t.id === selectedId) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }
}

function populateWelcomeTicketSelect() {
  const select = document.getElementById('welcome-ticket-select');
  if (select) {
    select.innerHTML = '<option value="">-- Choose Active Ticket --</option>';
    const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
    activeTickets.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `[${t.type.toUpperCase()}] ${t.customerName} - Deadline: ${formatDateShort(t.deadline)}`;
      select.appendChild(opt);
    });
  }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  // Use UTC to prevent timezone shifting across different machines
  return `${d.getUTCDate()}/${d.getUTCMonth()+1} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Render Dashboard Grid & Completed List
function renderDashboard() {
  const grid = document.getElementById('tickets-grid');
  const archiveTable = document.getElementById('archive-table-body');
  
  if (!grid || !archiveTable) return;

  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const filterStatus = document.getElementById('filter-status').value;
  const filterTech = document.getElementById('filter-tech').value;

  grid.innerHTML = '';
  archiveTable.innerHTML = '';

  // v1.4.5 — LIVE recompute of ticket.status from its checks on every render.
  // v1.4.4's completion fix only ran inside handleTicketFormSubmit, so any
  // legacy ticket that already had status='qc_testing' stored stayed there
  // forever unless the tech re-opened + re-saved it. Now: if every QC + build
  // check is ticked, promote to 'completed' automatically here (and persist,
  // so the promotion sticks across restarts). Same logic as the submit path
  // but applied to every ticket in memory. Read-only for tickets whose checks
  // aren't all done — never demotes a ticket from completed.
  var _promotedTickets = [];
  appState.tickets.forEach(function (t) {
    if (!t || !t.buildChecks || !t.qcChecks) return;
    if (t.status === 'completed') return;
    var b = t.buildChecks, q = t.qcChecks;
    var buildAll = b.cpuRamSsd && b.moboCase && b.cooler && b.cables && b.posted;
    var qcAll = q.physCabinet && q.physMobo && q.physRam && q.physScrews &&
                q.softWindows && q.softDrivers && q.softBios &&
                q.portUsb && q.portVideo && q.portAudio && q.portWifi;
    if (buildAll && qcAll) {
      t.status = 'completed';
      if (!t.completedAt) t.completedAt = new Date().toISOString();
      t.updatedAt = new Date().toISOString();
      _promotedTickets.push(t);
    }
  });
  if (_promotedTickets.length) {
    // Persist promotions locally + push to cloud so they survive restart and
    // reach the customer dashboard immediately.
    saveDatabase().catch(function (e) { console.warn('Auto-complete local persist failed:', e); });
    _promotedTickets.forEach(function (t) {
      syncTicketToCloud(t).catch(function (e) { console.warn('Auto-complete cloud sync failed:', e); });
    });
  }

  const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
  const completedTickets = appState.tickets.filter(t => t.status === 'completed');

  // Filter Active Tickets
  const filteredActive = activeTickets.filter(t => {
    if (!t || !t.id || !t.customerName) return false;
    const matchesSearch = t.customerName.toLowerCase().includes(searchQuery) ||
                          t.id.toLowerCase().includes(searchQuery) ||
                          (t.technician && t.technician.toLowerCase().includes(searchQuery)) ||
                          (t.serials && Object.values(t.serials).some(v => v && v.toLowerCase().includes(searchQuery)));
    
    const matchesStatus = filterStatus === 'all' || t.status === filterStatus;
    const matchesTech = filterTech === 'all' || t.technician === filterTech;

    return matchesSearch && matchesStatus && matchesTech;
  });

  // Sort Active Tickets dynamically
  const sortBy = appState.settings.sortBy || 'deadline';
  filteredActive.sort((a, b) => {
    if (sortBy === 'deadline') {
      const dateA = a.deadline ? new Date(a.deadline) : new Date('9999-12-31');
      const dateB = b.deadline ? new Date(b.deadline) : new Date('9999-12-31');
      return dateA - dateB;
    } else if (sortBy === 'createdAt') {
      const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return dateB - dateA;
    } else if (sortBy === 'customerName') {
      return (a.customerName || '').localeCompare(b.customerName || '');
    } else if (sortBy === 'status') {
      const statusWeight = { 'awaiting': 1, 'building': 2, 'waiting_qc': 3, 'qc_testing': 4 };
      const weightA = statusWeight[a.status] || 99;
      const weightB = statusWeight[b.status] || 99;
      return weightA - weightB;
    }
    return 0;
  });

  // Render Active Cards
  if (filteredActive.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>No active builds matching filters.</p></div>`;
  } else {
    filteredActive.forEach(t => {
      // Calculate percentages
      const buildPct = calculateBuildPercentage(t);
      const qcPct = calculateQcPercentage(t);
      const isAwaitingParts = t.missingComponentsToggle;
      
      const isUrgent = checkIsUrgent(t.deadline);
      const statusText = getStatusLabelText(t.status);

      const damaged = hasDamagedComponents(t);
      const damagedCount = damaged ? (t.damagedComponents || (t.specs && t.specs.__damaged) || []).length : 0;

      const card = document.createElement('div');
      card.className = `glass-slab ticket-card ${t.status} ${isUrgent ? 'urgent' : ''} ${damaged ? 'has-damage' : ''}`;
      card.innerHTML = `
        <div class="ticket-card-header">
          <span class="card-id">#${t.id.slice(-6)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="card-status-label ${t.status}">${statusText}</span>
            <span class="card-status-dot ${t.status}"></span>
          </div>
        </div>
        ${damaged ? `<div class="card-damage-banner">⚠ DOA / Damaged Components (${damagedCount})</div>` : ''}
        ${ticketQueryCounts[t.id] ? `<div class="card-query-banner"><span>💬 ${ticketQueryCounts[t.id]} sales quer${ticketQueryCounts[t.id] > 1 ? 'ies' : 'y'} awaiting reply</span><span class="cqb-cta">Reply ›</span></div>` : ''}
        <h3 class="card-cust-name">${t.customerName}</h3>
        <div style="margin-bottom:14px;">
          <span class="tech-chip">
            <span class="tech-chip-dot"></span>
            ${t.technician || 'Unassigned'}
          </span>
        </div>
        
        <div class="card-progress-section">
          <div class="card-progress-label">
            <span>Assembly</span>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:800;">${buildPct}%</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill build" style="width: ${buildPct}%"></div>
          </div>
        </div>

        <div class="card-progress-section">
          <div class="card-progress-label">
            <span>QC Testing</span>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:800;">${qcPct}%</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill qc" style="width: ${qcPct}%"></div>
          </div>
        </div>

        ${isAwaitingParts ? `
          <div class="card-missing-parts">
            ⚠️ <strong>Awaiting:</strong> ${formatMissingComponentsHuman(t.missingComponents)}
          </div>
        ` : ''}

        <div class="card-meta-footer">
          <span class="card-type-badge">${t.type === 'build' ? '⚙️ Build' : '🔧 Repair'}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:var(--text-muted);">📅 ${formatDateShort(t.deadline)}</span>
        </div>
      `;

      card.addEventListener('click', () => openTicketModal(t.id));
      grid.appendChild(card);
    });
  }

  // Render Completed / Passed Archive
  const filteredCompleted = completedTickets.filter(t => {
    if (!t || !t.id || !t.customerName) return false;
    const matchesSearch = t.customerName.toLowerCase().includes(searchQuery) ||
                          t.id.toLowerCase().includes(searchQuery) ||
                          (t.technician && t.technician.toLowerCase().includes(searchQuery));
    const matchesTech = filterTech === 'all' || t.technician === filterTech;
    return matchesSearch && matchesTech;
  });

  if (filteredCompleted.length === 0) {
    archiveTable.innerHTML = `<tr><td colspan="7" class="text-center">No completed system logs found.</td></tr>`;
  } else {
    filteredCompleted.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="font-mono">#${t.id.slice(-6)}</td>
        <td><strong>${t.customerName}</strong></td>
        <td>${t.technician}</td>
        <td>${t.specs ? (window.NeoQcMatcher && window.NeoQcMatcher.cleanName ? window.NeoQcMatcher.cleanName(t.specs.cpu || 'System Build') : (t.specs.cpu || 'System Build')) : 'N/A'}</td>
        <td class="font-mono">${t.diagnostics ? (t.diagnostics.cinebench || 'Not Run') : 'N/A'} pts</td>
        <td>${t.completedAt ? new Date(t.completedAt).toLocaleDateString() : 'N/A'}</td>
        <td>
          <button class="text-btn print-row-btn">🖨️ Print</button>
          <button class="text-btn pdf-row-btn">💾 PDF</button>
          <button class="text-btn edit-row-btn">✏️ Edit</button>
        </td>
      `;

      row.querySelector('.print-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerPrintReport(t.id);
      });
      row.querySelector('.pdf-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerSavePdf(t.id);
      });
      row.querySelector('.edit-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openTicketModal(t.id);
      });

      archiveTable.appendChild(row);
    });
  }

  // Update counts
  document.getElementById('active-count').textContent = activeTickets.length;
  document.getElementById('completed-count').textContent = completedTickets.length;

  // Update premium stats pills
  const inQc = activeTickets.filter(t => t.status === 'qc_testing' || t.status === 'waiting_qc').length;
  const urgentCount = activeTickets.filter(t => checkIsUrgent(t.deadline)).length;
  const el = (id) => document.getElementById(id);
  if (el('stat-active')) el('stat-active').textContent = activeTickets.length;
  if (el('stat-completed')) el('stat-completed').textContent = completedTickets.length;
  if (el('stat-qc')) el('stat-qc').textContent = inQc;
  if (el('stat-urgent')) el('stat-urgent').textContent = urgentCount;
}

function calculateBuildPercentage(t) {
  if (!t || !t.buildChecks) return 0;
  let count = 0;
  if (t.buildChecks.cpuRamSsd) count++;
  if (t.buildChecks.moboCase) count++;
  if (t.buildChecks.cooler) count++;
  if (t.buildChecks.cables) count++;
  if (t.buildChecks.posted) count++;
  return Math.round((count / 5) * 100);
}

function calculateQcPercentage(t) {
  if (!t || !t.qcChecks) return 0;
  let count = 0;
  const qcKeys = [
    'physCabinet', 'physMobo', 'physRam', 'physScrews',
    'softWindows', 'softDrivers', 'softBios',
    'portUsb', 'portVideo', 'portAudio', 'portWifi'
  ];
  qcKeys.forEach(k => {
    if (t.qcChecks[k]) count++;
  });
  return Math.round((count / qcKeys.length) * 100);
}

function checkIsUrgent(deadlineStr) {
  if (!deadlineStr) return false;
  const diffMs = new Date(deadlineStr) - new Date();
  return diffMs > 0 && diffMs < 24 * 60 * 60 * 1000; // Less than 24 hours
}

function getStatusLabelText(status) {
  switch (status) {
    case 'awaiting': return 'Awaiting Components';
    case 'building': return 'Build Commenced';
    case 'waiting_qc': return 'Awaiting QC';
    case 'qc_testing': return 'QC Stress Testing';
    case 'completed': return 'QC Pass / Completed';
    default: return 'Pending';
  }
}

function isI514thGen(cpuStr) {
  if (!cpuStr) return false;
  const s = cpuStr.toLowerCase();
  return s.includes('i5') && (s.includes('14400') || s.includes('14500') || s.includes('14600') || s.includes('14th') || s.includes('14900') || s.includes('14700') || (s.includes('14') && s.includes('gen')));
}

// ==========================================================================
// TICKET FORM & MODAL ACTIONS (STAFF PORTAL)
// ==========================================================================


function openTicketModal(ticketId = null) {
  editingTicketId = ticketId;
  hideConflictBanner();
  const modal = document.getElementById('ticket-modal');
  const form = document.getElementById('ticket-form');
  form.reset();

  // Reset collapsible activity log to closed by default
  const eventLogSection = document.querySelector('.event-log-section');
  if (eventLogSection) {
    eventLogSection.classList.add('collapsed');
  }

  const coolerModelInput = document.getElementById('form-spec-cooler-model');
  if (coolerModelInput) {
    coolerModelInput.classList.add('hidden');
    coolerModelInput.removeAttribute('required');
  }

  // Reset the awaiting-components state so a stale chip list from a previous
  // ticket doesn't bleed into a fresh one.
  awaitingComponentsList.length = 0;
  const awaitingEditor = document.getElementById('awaiting-components-editor');
  if (awaitingEditor) awaitingEditor.classList.add('hidden');
  renderAwaitingChips();

  // Reset the damage report too (stale entries must not carry over).
  damagedComponentsList.length = 0;
  renderDamagedComponents();

  const printBtn = document.getElementById('btn-print-report');
  const deleteBtn = document.getElementById('btn-delete-ticket');
  const title = document.getElementById('modal-title');

  // Enable/Disable component locks initially
  updateFormLockStates(0);

  // Clear manual inputs for new ticket
  document.getElementById('form-spec-mobo').value = '';
  document.getElementById('form-spec-cpu').value = '';
  document.getElementById('form-spec-gpu').value = '';
  document.getElementById('form-spec-ram').value = '';
  document.getElementById('form-spec-storage').value = '';
  document.getElementById('form-spec-psu').value = '';
  document.getElementById('form-spec-case').value = '';
  document.getElementById('modal-spec-cpu').textContent = '--';
  document.getElementById('modal-spec-igpu').textContent = '--';
  document.getElementById('modal-spec-gpu').textContent = '--';
  document.getElementById('modal-spec-ram').textContent = '--';
  document.getElementById('modal-spec-storage').textContent = '--';

  if (ticketId) {
    title.textContent = "Edit Service Ticket";
    const ticket = appState.tickets.find(t => t.id === ticketId);
    if (ticket) {
      document.getElementById('form-ticket-id').value = ticket.id;
      document.getElementById('form-created-at').value = ticket.createdAt;
      document.getElementById('form-customer-name').value = ticket.customerName;
      document.getElementById('form-deadline').value = formatDateTimeLocal(ticket.deadline);
      document.getElementById('form-deadline').disabled = true;
      document.getElementById('btn-change-deadline').style.display = 'block';
      document.getElementById('form-technician').value = ticket.technician;
      document.getElementById('form-ticket-type').value = ticket.type;
      
      // Load target specs into manual inputs
      document.getElementById('form-spec-mobo').value = ticket.specs ? (ticket.specs.mobo || '') : '';
      document.getElementById('form-spec-cpu').value = ticket.specs ? (ticket.specs.cpu || '') : '';
      document.getElementById('form-spec-gpu').value = ticket.specs ? (ticket.specs.gpu || '') : '';
      document.getElementById('form-spec-ram').value = ticket.specs ? (ticket.specs.ram || '') : '';
      document.getElementById('form-spec-storage').value = ticket.specs ? (ticket.specs.storage || '') : '';
      document.getElementById('form-spec-psu').value = ticket.specs ? (ticket.specs.psu || '') : '';
      document.getElementById('form-spec-case').value = ticket.specs ? (ticket.specs.case || '') : '';
      
      const coolerType = ticket.specs ? (ticket.specs.coolerType || 'stock') : 'stock';
      const coolerRadio = document.querySelector(`input[name="form-spec-cooler-type"][value="${coolerType}"]`);
      if (coolerRadio) coolerRadio.checked = true;
      
      const coolerModelEl = document.getElementById('form-spec-cooler-model');
      if (coolerModelEl) {
        if (coolerType === 'stock') {
          coolerModelEl.classList.add('hidden');
          coolerModelEl.removeAttribute('required');
          coolerModelEl.value = '';
        } else {
          coolerModelEl.classList.remove('hidden');
          coolerModelEl.setAttribute('required', 'true');
          coolerModelEl.value = ticket.specs ? (ticket.specs.coolerModel || '') : '';
        }
      }

      // Load detected specs into readout
      document.getElementById('modal-spec-cpu').textContent = ticket.detectedSpecs ? (ticket.detectedSpecs.cpu || '--') : '--';
      document.getElementById('modal-spec-igpu').textContent = ticket.detectedSpecs ? (ticket.detectedSpecs.igpu || 'None') : 'None';
      document.getElementById('modal-spec-gpu').textContent = ticket.detectedSpecs ? (ticket.detectedSpecs.gpu || '--') : '--';
      document.getElementById('modal-spec-ram').textContent = ticket.detectedSpecs ? (ticket.detectedSpecs.ram || '--') : '--';
      document.getElementById('modal-spec-storage').textContent = ticket.detectedSpecs ? (ticket.detectedSpecs.storage || '--') : '--';
      
      // Reset rival pulled banner
      const rivalBanner = document.getElementById('modal-rival-pulled-banner');
      if (rivalBanner) {
        rivalBanner.classList.add('hidden');
        rivalBanner.innerHTML = '';
      }

      const partsToggle = document.getElementById('form-missing-components-toggle');
      partsToggle.checked = ticket.missingComponentsToggle;
      // Load the multi-part awaiting list (parses both new array shape and
      // legacy string). Repaints chips + syncs target spec fields.
      awaitingComponentsList.length = 0;
      const parsed = parseAwaitingComponents(ticket.missingComponents);
      parsed.forEach(entry => awaitingComponentsList.push(entry));
      const editor = document.getElementById('awaiting-components-editor');
      if (editor) editor.classList.toggle('hidden', !ticket.missingComponentsToggle);
      renderAwaitingChips();

      // Load the damage report for this ticket (damagedComponents field, or the
      // specs.__damaged mirror that cross-machine sync carries).
      damagedComponentsList.length = 0;
      const dmg = ticket.damagedComponents || (ticket.specs && ticket.specs.__damaged);
      if (Array.isArray(dmg)) dmg.forEach(e => damagedComponentsList.push(e));
      renderDamagedComponents();

      // Set physical checkboxes
      document.getElementById('check-cpu-ram-ssd').checked = ticket.buildChecks.cpuRamSsd;
      document.getElementById('check-mobo-case').checked = ticket.buildChecks.moboCase;
      document.getElementById('check-cooler').checked = ticket.buildChecks.cooler;
      document.getElementById('check-cables').checked = ticket.buildChecks.cables;
      document.getElementById('check-posted').checked = ticket.buildChecks.posted || false;

      // Lock triggers check
      const buildPct = calculateBuildPercentage(ticket);
      updateFormLockStates(buildPct);

      // Set QC Checks
      document.getElementById('qc-phys-cabinet').checked = ticket.qcChecks.physCabinet;
      document.getElementById('qc-phys-motherboard').checked = ticket.qcChecks.physMobo;
      document.getElementById('qc-phys-ram').checked = ticket.qcChecks.physRam;
      document.getElementById('qc-phys-screws').checked = ticket.qcChecks.physScrews;
      document.getElementById('qc-soft-windows').checked = ticket.qcChecks.softWindows;
      document.getElementById('qc-soft-drivers').checked = ticket.qcChecks.softDrivers;
      document.getElementById('qc-soft-bios').checked = ticket.qcChecks.softBios;
      document.getElementById('qc-port-usb').checked = ticket.qcChecks.portUsb;
      document.getElementById('qc-port-video').checked = ticket.qcChecks.portVideo;
      document.getElementById('qc-port-audio').checked = ticket.qcChecks.portAudio;
      document.getElementById('qc-port-wifi').checked = ticket.qcChecks.portWifi;
      


      // Diagnostics & Serials
      document.getElementById('form-cpu-temp-min').value = ticket.diagnostics.cpuTempMin || '';
      document.getElementById('form-cpu-temp-max').value = ticket.diagnostics.cpuTempMax || '';
      document.getElementById('form-cpu-temp-avg').value = ticket.diagnostics.cpuTempAvg || '';
      document.getElementById('form-gpu-temp-min').value = ticket.diagnostics.gpuTempMin || '';
      document.getElementById('form-gpu-temp-max').value = ticket.diagnostics.gpuTempMax || '';
      document.getElementById('form-gpu-temp-avg').value = ticket.diagnostics.gpuTempAvg || '';
      document.getElementById('form-cinebench-score').value = ticket.diagnostics.cinebench || '';
      document.getElementById('form-furmark-score').value = ticket.diagnostics.furmark || '';
      document.getElementById('form-ssd-read').value = ticket.diagnostics.ssdRead || '';
      document.getElementById('form-ssd-write').value = ticket.diagnostics.ssdWrite || '';
      document.getElementById('serial-motherboard').value = ticket.serials.motherboard || '';
      document.getElementById('serial-ram').value = ticket.serials.ram || '';
      document.getElementById('serial-gpu').value = ticket.serials.gpu || '';
      document.getElementById('serial-ssd').value = ticket.serials.ssd || '';
      document.getElementById('serial-cabinet').value = ticket.serials.cabinet || '';

      // Run duplicate check on load
      document.querySelectorAll('.serial-field').forEach(field => verifyFieldDuplicate(field));

      // Windows Activation tracker
      const winKey = ticket.specs ? (ticket.specs.windowsKey || '') : '';
      const winState = ticket.specs ? (ticket.specs.windowsActivationState || 'Unverified') : 'Unverified';
      document.getElementById('modal-activation-os').textContent = 'Windows';
      const statusBadge = document.getElementById('modal-activation-status');
      statusBadge.textContent = winState;
      statusBadge.className = `badge ${winState === 'Activated' ? 'green' : (winState === 'Not Activated' ? 'red' : '')}`;
      document.getElementById('modal-activation-key').textContent = winKey || '--';

      if (winState === 'Activated') {
        document.getElementById('qc-soft-windows').checked = true;
      }

      printBtn.classList.remove('hidden');
      document.getElementById('btn-save-pdf').classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      updateModalDiagnosticsStatus();

      // Populate Client Telemetry elements removed (redundant telemetry sections deleted in v1.0.9)

      // Render event log timeline
      renderEventLog(ticket);

      // Saved diagnostics panels (passport / Prime95) + precomputed PPI
      renderSavedDiagnosticsPanels(ticket);
      loadAndRenderPpi(ticket.id);
      loadTicketQueries(ticket.id);
    }
  } else {
    hideTicketQueriesSection();
    title.textContent = "Create Service Ticket";
    document.getElementById('form-ticket-id').value = '';
    document.getElementById('form-created-at').value = '';

    // Clear diagnostics panels from any previously opened ticket
    renderSavedDiagnosticsPanels(null);
    const ppiPanel = document.getElementById('modal-ppi-panel');
    if (ppiPanel && window.NeoQcDiagnosticsRender) ppiPanel.innerHTML = window.NeoQcDiagnosticsRender.renderPpiPanel(null);
    
    // Reset specs
    document.getElementById('modal-spec-cpu').textContent = '--';
    document.getElementById('modal-spec-gpu').textContent = '--';
    document.getElementById('modal-spec-ram').textContent = '--';
    document.getElementById('modal-spec-storage').textContent = '--';

    // Reset Client Telemetry elements removed (redundant telemetry sections deleted in v1.0.9)
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(18, 0, 0, 0);
    document.getElementById('form-deadline').value = formatDateTimeLocal(tomorrow.toISOString());
    document.getElementById('form-deadline').disabled = false;
    document.getElementById('btn-change-deadline').style.display = 'none';
    
    document.getElementById('modal-activation-os').textContent = 'Windows';
    const statusBadge = document.getElementById('modal-activation-status');
    statusBadge.textContent = 'Unverified';
    statusBadge.className = 'badge';
    document.getElementById('modal-activation-key').textContent = '--';

    printBtn.classList.add('hidden');
    document.getElementById('btn-save-pdf').classList.add('hidden');
    deleteBtn.classList.add('hidden');
    updateModalDiagnosticsStatus();

    // Set default technician
    populateTechnicianDropdowns();
    document.getElementById('form-technician').value = appState.settings.defaultTech || '';

    // Auto-detect system specs if option is enabled
    if (appState.settings.autoDetectHw) {
      setTimeout(() => {
        const btn = document.getElementById('btn-modal-detect-hw');
        if (btn) btn.click();
      }, 50);
    }
  }

  // Validate diagnostics thresholds to update input border styles (red/green)
  validateDiagnosticsThresholds();

  // Show any component-compatibility disparities for the loaded specs.
  renderConfigSynergy();

  modal.classList.add('active');
}

function updateFormLockStates(buildPct) {
  const badge = document.getElementById('build-status-badge');
  badge.textContent = `${buildPct}% Complete`;

  const qcSect = document.getElementById('qc-testing-section');
  const diagSect = document.getElementById('diagnostics-section');
  const serialsSect = document.getElementById('serials-section');

  const lockStrict = !appState.settings.disableQcLock;

  if (buildPct < 100 && lockStrict) {
    qcSect.classList.add('locked');
    diagSect.classList.add('locked');
    serialsSect.classList.add('locked');
  } else {
    qcSect.classList.remove('locked');
    diagSect.classList.remove('locked');
    serialsSect.classList.remove('locked');
  }
}

function validateDiagnosticsThresholds() {
  const cpuMax = parseInt(appState.settings.cpuMaxTemp) || 85;
  const gpuMax = parseInt(appState.settings.gpuMaxTemp) || 80;
  const ssdReadMin = parseInt(appState.settings.minSsdSpeed) || 3000;
  const ssdWriteMin = parseInt(appState.settings.minSsdWrite) || 2500;
  const cbMin = parseInt(appState.settings.minCinebench) || 10000;
  const fmMin = parseInt(appState.settings.minFurmark) || 5000;

  const validateField = (elementId, isGreaterOrEqual, thresholdVal) => {
    const el = document.getElementById(elementId);
    if (!el) return;
    const val = parseFloat(el.value);
    el.classList.remove('diag-pass', 'diag-fail');
    if (el.value.trim() === '') return;
    if (isNaN(val)) {
      el.classList.add('diag-fail');
      return;
    }
    const passes = isGreaterOrEqual ? (val >= thresholdVal) : (val <= thresholdVal);
    if (passes) {
      el.classList.add('diag-pass');
    } else {
      el.classList.add('diag-fail');
    }
  };

  validateField('form-cpu-temp-max', false, cpuMax);
  validateField('form-gpu-temp-max', false, gpuMax);
  validateField('form-cinebench-score', true, cbMin);
  validateField('form-furmark-score', true, fmMin);
  validateField('form-ssd-read', true, ssdReadMin);
  validateField('form-ssd-write', true, ssdWriteMin);

  validateField('c-cpu-temp-max', false, cpuMax);
  validateField('c-gpu-temp-max', false, gpuMax);
  validateField('c-cinebench-score', true, cbMin);
  validateField('c-furmark-score', true, fmMin);
  validateField('c-ssd-read', true, ssdReadMin);
  validateField('c-ssd-write', true, ssdWriteMin);
}

function updateModalDiagnosticsStatus() {
  const statusBox = document.getElementById('modal-diagnostics-status');
  if (!statusBox) return;

  const hasHw = appState.settings.pathHwInfo || appState.settings.pathHwInfo === 'mock';
  const hasCb = appState.settings.pathCinebench || appState.settings.pathCinebench === 'mock';
  const hasFm = appState.settings.pathFurmark || appState.settings.pathFurmark === 'mock';

  // Check values in modal inputs
  const cpuAvg = document.getElementById('form-cpu-temp-avg').value;
  const cbScore = document.getElementById('form-cinebench-score').value;

  let hwStatus = hasHw ? "Ready" : "Not Configured";
  let cbStatus = hasCb ? "Ready" : "Not Configured";
  let fmStatus = hasFm ? "Ready" : "Not Configured";

  if (cpuAvg) hwStatus = "Calculated";
  if (cbScore) cbStatus = `Completed (${cbScore} pts)`;
  if (cpuAvg) fmStatus = "Completed";

  statusBox.innerHTML = `
    HWiNFO64: <strong style="color: ${hwStatus === 'Calculated' ? 'var(--status-completed)' : 'inherit'}">${hwStatus}</strong> | 
    Cinebench R23: <strong style="color: ${cbStatus.startsWith('Completed') ? 'var(--status-completed)' : 'inherit'}">${cbStatus}</strong> | 
    FurMark: <strong style="color: ${fmStatus === 'Completed' ? 'var(--status-completed)' : 'inherit'}">${fmStatus}</strong>
  `;
}

function setupFormCalculations() {
  // Auto average temps
  const cpuMin = document.getElementById('form-cpu-temp-min');
  const cpuMax = document.getElementById('form-cpu-temp-max');
  const cpuAvg = document.getElementById('form-cpu-temp-avg');

  const calcCpuAvg = () => {
    const minVal = parseFloat(cpuMin.value);
    const maxVal = parseFloat(cpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      cpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      cpuAvg.value = '';
    }
    updateModalDiagnosticsStatus();
    validateDiagnosticsThresholds();
  };
  cpuMin.addEventListener('input', calcCpuAvg);
  cpuMax.addEventListener('input', calcCpuAvg);

  const gpuMin = document.getElementById('form-gpu-temp-min');
  const gpuMax = document.getElementById('form-gpu-temp-max');
  const gpuAvg = document.getElementById('form-gpu-temp-avg');

  const calcGpuAvg = () => {
    const minVal = parseFloat(gpuMin.value);
    const maxVal = parseFloat(gpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      gpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      gpuAvg.value = '';
    }
    updateModalDiagnosticsStatus();
    validateDiagnosticsThresholds();
  };
  gpuMin.addEventListener('input', calcGpuAvg);
  gpuMax.addEventListener('input', calcGpuAvg);
  
  // Cinebench input trigger
  document.getElementById('form-cinebench-score').addEventListener('input', () => {
    updateModalDiagnosticsStatus();
    validateDiagnosticsThresholds();
  });

  // Watch other diagnostics fields
  const diagFields = [
    'form-furmark-score',
    'form-ssd-read',
    'form-ssd-write'
  ];
  diagFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', validateDiagnosticsThresholds);
    }
  });
}

function handleClientTicketSelect() {
  const ticketId = document.getElementById('client-ticket-select').value;
  const submitBtn = document.getElementById('btn-client-submit');
  const detectHwBtn = document.getElementById('btn-client-detect-hw');
  const runDiagBtn = document.getElementById('btn-run-auto-diagnostics');
  const checkWinBtn = document.getElementById('btn-client-check-win');

  if (!ticketId) {
    if (submitBtn) submitBtn.disabled = true;
    if (detectHwBtn) detectHwBtn.disabled = true;
    if (runDiagBtn) runDiagBtn.disabled = true;
    if (checkWinBtn) checkWinBtn.disabled = true;
    
    // Clear UI target spec fields
    document.getElementById('c-target-mobo').textContent = '--';
    document.getElementById('c-target-cpu').textContent = '--';
    document.getElementById('c-target-gpu').textContent = '--';
    document.getElementById('c-target-ram').textContent = '--';
    document.getElementById('c-target-storage').textContent = '--';
    document.getElementById('c-target-cooler').textContent = '--';
    document.getElementById('c-target-psu').textContent = '--';
    document.getElementById('c-target-case').textContent = '--';
    
    // Clear detected fields
    document.getElementById('c-spec-mobo').textContent = 'Not detected';
    document.getElementById('c-spec-cpu').textContent = 'Not detected';
    document.getElementById('c-spec-gpu').textContent = 'Not detected';
    document.getElementById('c-spec-ram').textContent = 'Not detected';
    document.getElementById('c-spec-storage').textContent = 'Not detected';
    
    // Clear physical checklist
    document.getElementById('c-verify-cooler').checked = false;
    document.getElementById('c-verify-psu').checked = false;
    document.getElementById('c-verify-case').checked = false;
    
    detectedSpecs = null;
    const matchStatusEl = document.getElementById('specs-match-status');
    if (matchStatusEl) matchStatusEl.classList.add('hidden');
    return;
  }

  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  if (submitBtn) submitBtn.disabled = false;
  if (detectHwBtn) detectHwBtn.disabled = false;
  if (runDiagBtn) runDiagBtn.disabled = false;
  if (checkWinBtn) checkWinBtn.disabled = false;

  detectedSpecs = null;
  const matchStatusEl = document.getElementById('specs-match-status');
  if (matchStatusEl) matchStatusEl.classList.add('hidden');

  // Populate target specs (part codes stripped for display)
  const cleanSpec = (s) => (window.NeoQcMatcher && window.NeoQcMatcher.cleanName ? window.NeoQcMatcher.cleanName(s || '') : (s || '')) || '--';
  document.getElementById('c-target-mobo').textContent = cleanSpec(ticket.specs && ticket.specs.mobo);
  document.getElementById('c-target-cpu').textContent = cleanSpec(ticket.specs && ticket.specs.cpu);
  document.getElementById('c-target-gpu').textContent = cleanSpec(ticket.specs && ticket.specs.gpu);
  document.getElementById('c-target-ram').textContent = cleanSpec(ticket.specs && ticket.specs.ram);
  document.getElementById('c-target-storage').textContent = cleanSpec(ticket.specs && ticket.specs.storage);
  
  let coolerText = '';
  if (ticket.specs && ticket.specs.coolerType) {
    if (ticket.specs.coolerType === 'stock') {
      coolerText = 'Stock';
    } else {
      coolerText = `${ticket.specs.coolerType.toUpperCase()} (${ticket.specs.coolerModel || ''})`;
    }
  }
  document.getElementById('c-target-cooler').textContent = coolerText || '--';
  document.getElementById('c-target-psu').textContent = (ticket.specs && ticket.specs.psu) || '--';
  document.getElementById('c-target-case').textContent = (ticket.specs && ticket.specs.case) || '--';

  // Load detected specs if they exist on the ticket
  if (ticket.detectedSpecs) {
    detectedSpecs = ticket.detectedSpecs;
    document.getElementById('c-spec-mobo').textContent = detectedSpecs.motherboard || 'Not detected';
    document.getElementById('c-spec-cpu').textContent = detectedSpecs.cpu || 'Not detected';
    document.getElementById('c-spec-gpu').textContent = detectedSpecs.dgpu || detectedSpecs.gpu || 'Not detected';
    document.getElementById('c-spec-ram').textContent = detectedSpecs.ram || 'Not detected';
    document.getElementById('c-spec-storage').textContent = detectedSpecs.storage || 'Not detected';
    
    // Check if specs match and display status
    checkSpecsMatch();
  } else {
    // Clear detected fields
    document.getElementById('c-spec-mobo').textContent = 'Not detected';
    document.getElementById('c-spec-cpu').textContent = 'Not detected';
    document.getElementById('c-spec-gpu').textContent = 'Not detected';
    document.getElementById('c-spec-ram').textContent = 'Not detected';
    document.getElementById('c-spec-storage').textContent = 'Not detected';
  }

  // Load physical checklist state
  document.getElementById('c-verify-cooler').checked = !!(ticket.detectedSpecs && ticket.detectedSpecs.coolerVerified);
  document.getElementById('c-verify-psu').checked = !!(ticket.detectedSpecs && ticket.detectedSpecs.psuVerified);
  document.getElementById('c-verify-case').checked = !!(ticket.detectedSpecs && ticket.detectedSpecs.caseVerified);

  // Populate temps
  document.getElementById('c-cpu-temp-min').value = ticket.diagnostics.cpuTempMin || '';
  document.getElementById('c-cpu-temp-max').value = ticket.diagnostics.cpuTempMax || '';
  document.getElementById('c-cpu-temp-avg').value = ticket.diagnostics.cpuTempAvg || '';
  document.getElementById('c-gpu-temp-min').value = ticket.diagnostics.gpuTempMin || '';
  document.getElementById('c-gpu-temp-max').value = ticket.diagnostics.gpuTempMax || '';
  document.getElementById('c-gpu-temp-avg').value = ticket.diagnostics.gpuTempAvg || '';

  // Populate benchmarks
  document.getElementById('c-cinebench-score').value = ticket.diagnostics.cinebench || '';
  document.getElementById('c-furmark-score').value = ticket.diagnostics.furmark || '';
  document.getElementById('c-ssd-read').value = ticket.diagnostics.ssdRead || '';
  document.getElementById('c-ssd-write').value = ticket.diagnostics.ssdWrite || '';
  
  detectedWinKey = (ticket.specs && ticket.specs.windowsKey) ? ticket.specs.windowsKey : '';
  detectedWinStatus = (ticket.specs && ticket.specs.windowsActivationState) ? ticket.specs.windowsActivationState : '';
  
  const clientWinKeyContainer = document.getElementById('client-win-key-container');
  const clientWinKey = document.getElementById('client-win-key');
  const clientWinStatus = document.getElementById('client-win-status');
  if (clientWinStatus) {
    if (detectedWinStatus === "Activated") {
      clientWinStatus.innerHTML = `Activation Status: <span class="badge green">🛡️ Activated</span>`;
      clientWinStatus.dataset.activated = "true";
    } else if (detectedWinStatus === "Not Activated") {
      clientWinStatus.innerHTML = `Activation Status: <span class="badge red">⚠️ Not Activated</span>`;
      clientWinStatus.dataset.activated = "false";
    } else {
      clientWinStatus.innerHTML = `Activation Status: <span class="badge">Unverified</span>`;
      clientWinStatus.dataset.activated = "false";
    }
  }
  if (clientWinKeyContainer && clientWinKey) {
    if (detectedWinKey) {
      clientWinKey.textContent = detectedWinKey;
      clientWinKeyContainer.classList.remove('hidden');
    } else {
      clientWinKeyContainer.classList.add('hidden');
      clientWinKey.textContent = '--';
    }
  }

  // Load port checking states from ticket's qcChecks
  const portUsb = !!(ticket.qcChecks && ticket.qcChecks.portUsb);
  const portVideo = !!(ticket.qcChecks && ticket.qcChecks.portVideo);
  const portAudio = !!(ticket.qcChecks && ticket.qcChecks.portAudio);
  const portRgb = !!(ticket.qcChecks && ticket.qcChecks.portRgb);

  // Update badges
  const setBadgeState = (badgeId, passed) => {
    const el = document.getElementById(badgeId);
    if (el) {
      el.textContent = passed ? 'Passed' : 'Pending';
      el.className = `badge ${passed ? 'green' : 'red'}`;
    }
  };
  setBadgeState('badge-port-usb', portUsb);
  setBadgeState('badge-port-video', portVideo);
  setBadgeState('badge-port-audio', portAudio);
  setBadgeState('badge-port-rgb', portRgb);

  // Show/hide RGB control panel
  const openrgbPanel = document.getElementById('openrgb-control-panel');
  if (openrgbPanel) {
    if (portRgb) {
      openrgbPanel.classList.remove('hidden');
    } else {
      openrgbPanel.classList.add('hidden');
    }
  }

  // Load status display depending on existing data
  const hasTemps = ticket.diagnostics.cpuTempAvg !== null;
  const hasCb = ticket.diagnostics.cinebench !== null;
  document.getElementById('c-diagnostics-status').innerHTML = `
    HWiNFO64: <strong style="color: ${hasTemps ? 'var(--status-completed)' : 'inherit'}">${hasTemps ? 'Calculated' : '[Idle]'}</strong> | 
    Cinebench R23: <strong style="color: ${hasCb ? 'var(--status-completed)' : 'inherit'}">${hasCb ? 'Completed (' + ticket.diagnostics.cinebench + ' pts)' : '[Idle]'}</strong> | 
    FurMark: <strong style="color: ${hasTemps ? 'var(--status-completed)' : 'inherit'}">${hasTemps ? 'Completed' : '[Idle]'}</strong>
  `;
  validateDiagnosticsThresholds();
}

function setupClientFormCalculations() {
  const cpuMin = document.getElementById('c-cpu-temp-min');
  const cpuMax = document.getElementById('c-cpu-temp-max');
  const cpuAvg = document.getElementById('c-cpu-temp-avg');

  const calcCpuAvg = () => {
    const minVal = parseFloat(cpuMin.value);
    const maxVal = parseFloat(cpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      cpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      cpuAvg.value = '';
    }
    validateDiagnosticsThresholds();
  };
  cpuMin.addEventListener('input', calcCpuAvg);
  cpuMax.addEventListener('input', calcCpuAvg);

  const gpuMin = document.getElementById('c-gpu-temp-min');
  const gpuMax = document.getElementById('c-gpu-temp-max');
  const gpuAvg = document.getElementById('c-gpu-temp-avg');

  const calcGpuAvg = () => {
    const minVal = parseFloat(gpuMin.value);
    const maxVal = parseFloat(gpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      gpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      gpuAvg.value = '';
    }
    validateDiagnosticsThresholds();
  };
  gpuMin.addEventListener('input', calcGpuAvg);
  gpuMax.addEventListener('input', calcGpuAvg);

  // Watch other client diagnostics fields
  const clientDiagFields = [
    'c-cinebench-score',
    'c-furmark-score',
    'c-ssd-read',
    'c-ssd-write'
  ];
  clientDiagFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', validateDiagnosticsThresholds);
    }
  });
}

function setPortButtonState(btnId, isPassed) {
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.dataset.checked = isPassed ? "true" : "false";
    if (isPassed) {
      btn.classList.add('passed');
    } else {
      btn.classList.remove('passed');
    }
  }
}

function updateSyncBadge(elementId, passed) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = passed ? 'Passed' : 'Pending';
    el.className = `badge ${passed ? 'green' : 'red'}`;
  }
}

function updatePortDetailsDisplay(category, devices) {
  const container = document.getElementById('c-port-details-container');
  const list = document.getElementById('c-port-details-list');
  if (container && list) {
    container.classList.remove('hidden');
    list.innerHTML = `<div class="port-details-header">🔌 Detected Connection: ${category}</div>`;
    if (!devices || devices.length === 0) {
      list.innerHTML += `<div class="port-detail-line" style="color: var(--status-urgent)">No active devices detected. Check connection!</div>`;
    } else {
      devices.forEach(dev => {
        list.innerHTML += `
          <div class="port-detail-line">
            <span>• ${dev}</span>
            <span class="port-detail-val">Active</span>
          </div>
        `;
      });
    }
  }
}

// Replace every <span class="dr-inline-icon" data-icon="name"> placeholder with
// the shared SVG icon set (shared/icons.js) — static HTML can't call JS, so
// icons are injected once at startup.
function injectInlineIcons() {
  if (!window.NeoQcIcons) return;
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = window.NeoQcIcons.iconSvg(el.getAttribute('data-icon'));
  });
}

// Update a port-card status pill (dr-pill classes from shared/diagnostics-tokens.css)
function setPortPill(type, status, label) {
  const badge = document.getElementById(`badge-port-${type}`);
  if (!badge) return;
  badge.className = `dr-pill dr-status-${status}`;
  badge.textContent = label;
}

// Persist the passive port-enumeration result into the selected ticket.
// qcChecks are ticked when Windows recognises at least one device of each type
// (a USB controller, a video output, an audio endpoint) — i.e. the ports the
// board exposes are alive and enumerated.
async function savePortScanResult(data) {
  const ticketId = document.getElementById('client-ticket-select').value;
  if (!ticketId) return;
  const index = appState.tickets.findIndex(t => t.id === ticketId);
  if (index === -1) return;
  const ticket = appState.tickets[index];

  if (!ticket.diagnostics) ticket.diagnostics = {};
  ticket.diagnostics.portScan = { ...data, ranAt: new Date().toISOString() };

  if (!ticket.qcChecks) ticket.qcChecks = {};
  ticket.qcChecks.portUsb = (data.usbControllers || []).length > 0;
  ticket.qcChecks.portVideo = (data.videoOutputs || []).length > 0 || (data.gpus || []).length > 0;
  ticket.qcChecks.portAudio = (data.audioEndpoints || []).length > 0;

  ticket.updatedAt = new Date().toISOString();
  appState.tickets[index] = ticket;
  await saveDatabase();
  await syncTicketToCloud(ticket);
}

// Persist the rgbSyncV2 result into the selected ticket
async function saveRgbSyncResult(rgbResult) {
  const ticketId = document.getElementById('client-ticket-select').value;
  if (!ticketId) return;
  const index = appState.tickets.findIndex(t => t.id === ticketId);
  if (index === -1) return;
  const ticket = appState.tickets[index];

  if (!ticket.diagnostics) ticket.diagnostics = {};
  ticket.diagnostics.rgbSyncV2 = { ...rgbResult, ranAt: new Date().toISOString() };
  if (!ticket.qcChecks) ticket.qcChecks = {};
  ticket.qcChecks.portRgb = rgbResult.overallStatus === 'pass' || rgbResult.overallStatus === 'partial';

  ticket.updatedAt = new Date().toISOString();
  appState.tickets[index] = ticket;
  await saveDatabase();
  await syncTicketToCloud(ticket);
}

// Cached RGB device list (from the last Detect Devices run) for apply actions
let lastRgbDevices = [];

function renderRgbDeviceControls(detailed) {
  const container = document.getElementById('openrgb-device-list');
  if (!container) return;
  container.innerHTML = '';
  detailed.forEach(dev => {
    const zones = dev.zones && dev.zones.length ? dev.zones : ['(whole device)'];
    const devEl = document.createElement('div');
    devEl.className = 'dr-list';
    devEl.innerHTML = zones.map((zone, zi) => `
      <div class="dr-list-item">
        <span>${dev.name}${zones.length > 1 || zone !== '(whole device)' ? ' — ' + zone : ''}</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <input type="color" value="#e7014e" data-rgb-device="${dev.index}" data-rgb-zone="${dev.zones && dev.zones.length ? zi : ''}"
                 style="width:34px;height:22px;padding:0;border:none;border-radius:4px;cursor:pointer;">
          <button type="button" class="secondary-btn btn-rgb-zone-apply" data-rgb-device="${dev.index}" data-rgb-zone="${dev.zones && dev.zones.length ? zi : ''}"
                  style="padding:2px 8px;font-size:0.7rem;">Apply</button>
          <span class="rgb-zone-status dr-muted" data-rgb-status="${dev.index}-${zi}"></span>
        </span>
      </div>`).join('');
    container.appendChild(devEl);
  });

  container.querySelectorAll('.btn-rgb-zone-apply').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deviceIndex = btn.getAttribute('data-rgb-device');
      const zoneIndex = btn.getAttribute('data-rgb-zone');
      const picker = container.querySelector(`input[type="color"][data-rgb-device="${deviceIndex}"][data-rgb-zone="${zoneIndex}"]`);
      const color = picker ? picker.value : '#e7014e';
      const statusEl = container.querySelector(`[data-rgb-status="${deviceIndex}-${zoneIndex || 0}"]`);

      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Applying...';
      try {
        const result = await ipcRenderer.invoke('rgb:set-device-color', { deviceIndex, zoneIndex, mode: 'static', color });
        if (statusEl) statusEl.textContent = result.success
          ? (result.verified ? 'Applied ✦ controller OK' : 'Applied, unconfirmed')
          : `Failed: ${result.error || 'unknown'}`;
        // Record the zone-level result
        const dev = lastRgbDevices.find(d => String(d.index) === String(deviceIndex));
        if (dev) {
          const zoneName = (dev.zones && dev.zones.length) ? dev.zones[parseInt(zoneIndex)] : dev.name;
          await saveRgbSyncResult(buildRgbSyncResult(lastRgbDevices, { device: dev.name, zone: zoneName, color, verified: !!result.verified }));
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = `Error: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// Build the diagnostics.rgbSyncV2 shape from the detected device list, merging
// in the latest applied-color info (appliedInfo optional).
function buildRgbSyncResult(detailed, appliedInfo) {
  const existing = (() => {
    const ticketId = document.getElementById('client-ticket-select').value;
    const t = appState.tickets.find(t => t.id === ticketId);
    return (t && t.diagnostics && t.diagnostics.rgbSyncV2) || null;
  })();

  const devices = detailed.map(dev => {
    const zones = (dev.zones && dev.zones.length ? dev.zones : [dev.name]).map(zoneName => {
      const prior = existing && existing.devices
        ? (existing.devices.find(d => d.name === dev.name)?.zones || []).find(z => z.name === zoneName)
        : null;
      const isApplied = appliedInfo && appliedInfo.device === dev.name && appliedInfo.zone === zoneName;
      return {
        name: zoneName,
        colorApplied: isApplied ? appliedInfo.color : (prior ? prior.colorApplied : null),
        colorVerified: null, // CLI cannot read colors back — never claim it can
        verified: isApplied ? appliedInfo.verified : (prior ? prior.verified : false)
      };
    });
    return { name: dev.name, zones };
  });

  const anyVerified = devices.some(d => d.zones.some(z => z.verified));
  const allVerified = devices.length > 0 && devices.every(d => d.zones.every(z => z.verified));
  return {
    controllerFound: detailed.length > 0,
    devices,
    overallStatus: detailed.length === 0 ? 'not-detected' : allVerified ? 'pass' : anyVerified ? 'partial' : 'pass'
  };
}

function setupOpenRgbController() {
  const applyBtn = document.getElementById('btn-apply-openrgb');
  if (!applyBtn) return;

  applyBtn.addEventListener('click', async () => {
    const ticketId = document.getElementById('client-ticket-select').value;
    if (!ticketId) {
      alert("Please select a ticket first before applying RGB Sync!");
      return;
    }
    const ticket = appState.tickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const mode = document.getElementById('openrgb-mode').value;
    const color = document.getElementById('openrgb-color-picker').value;
    const statusEl = document.getElementById('openrgb-apply-status');

    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';

    try {
      appendConsoleLine('c-console-box', `[RGB CONTROLLER] Applying RGB effect '${mode.toUpperCase()}' to all devices...`);
      const result = await ipcRenderer.invoke('rgb:set-color', { mode, color, brightness: 100 });
      if (result && result.success) {
        const verifiedNote = result.verified ? 'controller re-enumerated OK' : 'controller did not re-confirm';
        appendConsoleLine('c-console-box', `[RGB CONTROLLER] Applied via OpenRGB (${verifiedNote}).`);
        if (statusEl) statusEl.textContent = result.verified ? `Applied — ${verifiedNote}` : 'Applied, unconfirmed';
        // Record apply across every detected device/zone
        if (lastRgbDevices.length) {
          const applied = { color: mode === 'off' ? '#000000' : color, verified: !!result.verified };
          let rgbResult = buildRgbSyncResult(lastRgbDevices, null);
          rgbResult.devices = rgbResult.devices.map(d => ({
            ...d,
            zones: d.zones.map(z => ({ ...z, colorApplied: applied.color, verified: applied.verified }))
          }));
          const anyV = applied.verified;
          rgbResult.overallStatus = rgbResult.controllerFound ? (anyV ? 'pass' : 'partial') : 'not-detected';
          await saveRgbSyncResult(rgbResult);
        }
      } else {
        appendConsoleLine('c-console-box', `[RGB CONTROLLER ERROR] Failed to sync: ${result ? result.error : 'Unknown error'}`);
        if (statusEl) statusEl.textContent = `Failed: ${result ? result.error : 'unknown'}`;
      }
    } catch (err) {
      console.error("OpenRGB apply error:", err);
      appendConsoleLine('c-console-box', `[RGB CONTROLLER ERROR] Exception: ${err.message}`);
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Lighting Effect';
    }
  });
}

// Port Checker v3 — passive enumeration.
// The shop just needs to know what Windows recognises: USB controllers and
// their generations (2.0 / 3.x / USB4 / Type-C), the video outputs actually in
// use (HDMI / DisplayPort / DVI), and the audio controllers + endpoints. One
// scan, no plug-in dance.
function setupPortsChecker() {
  function setBadge(type, status, label) {
    const badge = document.getElementById(`badge-port-${type}`);
    if (badge) { badge.className = `dr-pill dr-status-${status}`; badge.textContent = label; }
  }

  const esc = (s) => (window.NeoQcDiagnosticsRender ? window.NeoQcDiagnosticsRender.esc(s) : String(s == null ? '' : s));

  function renderPortEnum(data) {
    const section = (title, rows) =>
      `<div class="dr-muted" style="margin-top:8px;font-weight:600;">${esc(title)}</div>` +
      (rows.length ? `<div class="dr-list">${rows.join('')}</div>`
                   : `<div class="dr-list-item dr-muted">None detected.</div>`);
    const item = (a, b) =>
      `<div class="dr-list-item"><span>${esc(a)}</span>${b != null ? `<span class="dr-muted">${esc(b)}</span>` : ''}</div>`;

    const usb = (data.usbControllers || []).map(c => item(c.name, c.generation));
    const usbDev = (data.usbDevices || []).length
      ? `<div class="dr-list-item dr-muted">${data.usbDeviceCount} connected USB device(s): ${(data.usbDevices || []).slice(0, 6).map(esc).join(', ')}${(data.usbDevices || []).length > 6 ? '…' : ''}</div>`
      : `<div class="dr-list-item dr-muted">No external USB peripherals currently connected.</div>`;
    const gpus = (data.gpus || []).map(g => item(g.name, [g.vramMB ? g.vramMB + ' MB' : null, g.resolution].filter(Boolean).join(' · ')));
    const outs = (data.videoOutputs || []).map(o => item(o.connection, o.monitor || null));
    const aud = (data.audioControllers || []).map(a => item(a.name, a.status));
    const ep = (data.audioEndpoints || []).map(e => item(e, null));

    return section('USB Host Controllers', usb) + usbDev +
           section('Graphics Adapters', gpus) +
           section('Active Video Outputs', outs) +
           section('Audio Controllers', aud) +
           section('Audio Endpoints (jacks / devices)', ep);
  }

  const scanBtn = document.getElementById('btn-scan-ports');
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      const ticketId = document.getElementById('client-ticket-select').value;
      if (!ticketId) { alert('Please select a ticket first before scanning ports!'); return; }
      const resultsEl = document.getElementById('port-enum-results');
      scanBtn.disabled = true;
      setBadge('enum', 'unverified', 'Scanning…');
      if (resultsEl) resultsEl.innerHTML = '<div class="dr-muted" style="padding:6px 0;">Enumerating USB, video and audio…</div>';
      try {
        const res = await ipcRenderer.invoke('sys:enumerate-ports');
        if (!res.ok) {
          setBadge('enum', 'unverified', 'Scan failed');
          if (resultsEl) resultsEl.innerHTML = `<div class="dr-list-item" style="color:var(--dr-status-fail);">Could not enumerate ports — ${esc(res.error || 'unknown error')}.</div>`;
          appendConsoleLine('c-console-box', `[PORT] Enumeration failed: ${res.error || 'unknown'}.`);
          return;
        }
        const d = res.data || {};
        if (resultsEl) resultsEl.innerHTML = renderPortEnum(d);
        const usbGens = [...new Set((d.usbControllers || []).map(c => c.generation))];
        setBadge('enum', 'pass', `${(d.usbControllers || []).length} USB · ${(d.videoOutputs || []).length} video · ${(d.audioEndpoints || []).length} audio`);
        appendConsoleLine('c-console-box',
          `[PORT] Recognised: ${(d.usbControllers || []).length} USB controller(s) [${usbGens.join(', ')}], ` +
          `${(d.videoOutputs || []).length} video output(s), ${(d.audioEndpoints || []).length} audio endpoint(s).`);
        await savePortScanResult(d);
      } catch (e) {
        setBadge('enum', 'unverified', 'Scan error');
        if (resultsEl) resultsEl.innerHTML = `<div class="dr-list-item" style="color:var(--dr-status-fail);">Error: ${esc(e.message)}</div>`;
      } finally {
        scanBtn.disabled = false;
      }
    });
  }

  // RGB — detect controllable devices, expose per-device/zone controls
  const rgbBtn = document.getElementById('btn-scan-rgb');
  if (rgbBtn) {
    rgbBtn.addEventListener('click', async () => {
      const ticketId = document.getElementById('client-ticket-select').value;
      if (!ticketId) { alert("Please select a ticket first before detecting RGB devices!"); return; }
      rgbBtn.disabled = true;
      setBadge('rgb', 'unverified', 'Detecting…');
      const panel = document.getElementById('openrgb-control-panel');
      const listEl = document.getElementById('list-port-rgb');
      try {
        const res = await ipcRenderer.invoke('rgb:list-devices');
        const detailed = res.detailed || [];
        lastRgbDevices = detailed;
        if (detailed.length > 0) {
          setBadge('rgb', 'pass', `${detailed.length} device(s)`);
          renderRgbDeviceControls(detailed);
          if (panel) panel.classList.remove('hidden');
          if (listEl) listEl.classList.add('hidden');
          await saveRgbSyncResult(buildRgbSyncResult(detailed, null));
        } else {
          setBadge('rgb', 'unverified', 'None detected');
          if (panel) panel.classList.add('hidden');
          // If OpenRGB.exe isn't found, it was most likely quarantined by
          // Windows Defender (its SMBus driver trips RiskWare heuristics).
          // Offer a one-click authorize that adds a Defender exclusion and
          // un-quarantines it, then re-detects.
          const notFound = res.reason === 'not-found' || res.reason === 'launch-failed';
          if (listEl) {
            listEl.classList.remove('hidden');
            if (notFound) {
              listEl.innerHTML =
                `<div class="dr-list-item" style="flex-direction:column;align-items:flex-start;gap:6px;">` +
                `<span class="dr-muted">RGB engine (OpenRGB) isn't running — Windows Defender may have quarantined it (its low-level lighting driver is a common false positive).</span>` +
                `<button type="button" id="btn-rgb-authorize" class="primary-pink-btn" style="padding:5px 12px;font-size:0.75rem;">⚡ Enable RGB Control (authorize with Windows Defender)</button>` +
                `<span id="rgb-authorize-status" class="dr-muted"></span></div>`;
              const authBtn = document.getElementById('btn-rgb-authorize');
              const authStatus = document.getElementById('rgb-authorize-status');
              if (authBtn) authBtn.addEventListener('click', async () => {
                authBtn.disabled = true;
                if (authStatus) authStatus.textContent = 'Adding Defender exclusion and restoring OpenRGB…';
                const r = await ipcRenderer.invoke('rgb:authorize');
                if (authStatus) authStatus.textContent = r.success
                  ? 'Authorized ✓ — re-detecting devices…'
                  : `Could not authorize automatically (${r.error || 'unknown'}). You may need to allow OpenRGB in Windows Security manually.`;
                if (r.success) { authBtn.remove(); setTimeout(() => rgbBtn.click(), 800); }
                else authBtn.disabled = false;
              });
            } else {
              listEl.innerHTML = `<div class="dr-list-item"><span class="dr-muted">OpenRGB is running but found no controllable lighting on this board.</span></div>`;
            }
          }
        }
        appendConsoleLine('c-console-box', `[RGB] Detected ${detailed.length} controllable device(s)${detailed.length === 0 && res.reason ? ` (${res.reason})` : ''}.`);
      } catch (err) {
        setBadge('rgb', 'fail', 'Error');
        appendConsoleLine('c-console-box', `[RGB ERROR] ${err.message}`);
      } finally {
        rgbBtn.disabled = false;
      }
    });
  }

  setupOpenRgbController();
}

// Save ticket form data
async function handleTicketFormSubmit(e) {
  e.preventDefault();

  // The form is `novalidate` (native HTML5 required-field validation silently
  // refuses to submit when a required field isn't focusable — e.g. empty specs
  // you intend to fill when parts arrive — with no message, which read as
  // "new tickets can't be created"). We validate here instead, clearly, and
  // only block on the genuinely-essential customer name. Specs can be added
  // later over the ticket's lifecycle (that's the whole awaiting-parts flow).
  const _custName = (document.getElementById('form-customer-name').value || '').trim();
  if (!_custName) {
    alert('Please enter a customer name to create the ticket.');
    document.getElementById('form-customer-name').focus();
    return;
  }

  try {
  const id = document.getElementById('form-ticket-id').value || 't_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const createdAt = document.getElementById('form-created-at').value || new Date().toISOString();
  
  const ticketType = document.getElementById('form-ticket-type').value;
  const customerName = document.getElementById('form-customer-name').value;
  const deadlineVal = document.getElementById('form-deadline').value;
  // Ensure deadline is saved as a clean UTC ISO string - append Z if not present
  let deadline;
  if (deadlineVal) {
    const rawDate = new Date(deadlineVal + (deadlineVal.endsWith('Z') ? '' : ':00.000Z'));
    deadline = isNaN(rawDate.getTime()) ? new Date(deadlineVal).toISOString() : rawDate.toISOString();
  } else {
    deadline = new Date().toISOString();
  }
  const technician = document.getElementById('form-technician').value;

  const missingComponentsToggle = document.getElementById('form-missing-components-toggle').checked;
  // Serialize the multi-part array. Store as JSON string so the existing
  // TEXT column in Supabase carries it without a migration; loaders handle
  // both new (array/JSON) and legacy (plain string) shapes.
  const missingComponents = (missingComponentsToggle && awaitingComponentsList.length)
    ? JSON.stringify(awaitingComponentsList)
    : '';

  const existingTicket = editingTicketId ? appState.tickets.find(t => t.id === editingTicketId) : null;
  const oldQc = existingTicket ? (existingTicket.qcChecks || {}) : {};
  const oldDiag = existingTicket ? (existingTicket.diagnostics || {}) : {};

  const buildChecks = {
    cpuRamSsd: document.getElementById('check-cpu-ram-ssd').checked,
    moboCase: document.getElementById('check-mobo-case').checked,
    cooler: document.getElementById('check-cooler').checked,
    cables: document.getElementById('check-cables').checked,
    posted: document.getElementById('check-posted').checked
  };

  const qcChecks = {
    ...oldQc,
    physCabinet: document.getElementById('qc-phys-cabinet').checked,
    physMobo: document.getElementById('qc-phys-motherboard').checked,
    physRam: document.getElementById('qc-phys-ram').checked,
    physScrews: document.getElementById('qc-phys-screws').checked,
    softWindows: document.getElementById('qc-soft-windows').checked,
    softDrivers: document.getElementById('qc-soft-drivers').checked,
    softBios: document.getElementById('qc-soft-bios').checked,
    portUsb: document.getElementById('qc-port-usb').checked,
    portVideo: document.getElementById('qc-port-video').checked,
    portAudio: document.getElementById('qc-port-audio').checked,
    portWifi: document.getElementById('qc-port-wifi').checked
  };

  const diagnostics = {
    ...oldDiag,
    cpuTempMin: parseFloat(document.getElementById('form-cpu-temp-min').value) || null,
    cpuTempMax: parseFloat(document.getElementById('form-cpu-temp-max').value) || null,
    cpuTempAvg: parseFloat(document.getElementById('form-cpu-temp-avg').value) || null,
    gpuTempMin: parseFloat(document.getElementById('form-gpu-temp-min').value) || null,
    gpuTempMax: parseFloat(document.getElementById('form-gpu-temp-max').value) || null,
    gpuTempAvg: parseFloat(document.getElementById('form-gpu-temp-avg').value) || null,
    cinebench: parseFloat(document.getElementById('form-cinebench-score').value) || null,
    furmark: parseFloat(document.getElementById('form-furmark-score').value) || null,
    ssdRead: parseFloat(document.getElementById('form-ssd-read').value) || null,
    ssdWrite: parseFloat(document.getElementById('form-ssd-write').value) || null,
    rivalConfigId: ""
  };

  const serials = {
    motherboard: document.getElementById('serial-motherboard').value,
    ram: document.getElementById('serial-ram').value,
    gpu: document.getElementById('serial-gpu').value,
    ssd: document.getElementById('serial-ssd').value,
    cabinet: document.getElementById('serial-cabinet').value
  };

  // Determine current status
  let status = 'awaiting';
  const isBuildComplete = buildChecks.cpuRamSsd && buildChecks.moboCase && buildChecks.cooler && buildChecks.cables && buildChecks.posted;
  
  if (isBuildComplete) {
    status = 'waiting_qc';
    const isQcComplete = qcChecks.physCabinet && qcChecks.physMobo && qcChecks.physRam && qcChecks.physScrews &&
                         qcChecks.softWindows && qcChecks.softDrivers && qcChecks.softBios &&
                         qcChecks.portUsb && qcChecks.portVideo && qcChecks.portAudio && qcChecks.portWifi;

    // Completion gate: the tech signing off on every QC checkbox IS the
    // intent-of-user signal. Do not hold completion hostage to diagnostic
    // sampling — iGPU-only builds have no FurMark → gpuTempAvg stays null,
    // and AMD sensor names can defeat the temp regex on some boards. Diag
    // values are still saved when present; they just no longer gate the
    // completion status. Fixed 2026-07-14: field-reported tickets that
    // clearly said 100% + 100% weren't moving to the Completed column.
    if (isQcComplete) {
      status = 'completed';
    } else if (qcChecks.physCabinet || diagnostics.cpuTempAvg !== null) {
      status = 'qc_testing';
    }
  } else if (missingComponentsToggle) {
    status = 'awaiting';
  } else {
    status = 'building';
  }

  const updatedTicket = {
    id,
    createdAt,
    type: ticketType,
    customerName,
    deadline,
    technician,
    missingComponentsToggle,
    missingComponents,
    buildChecks,
    qcChecks,
    diagnostics,
    serials,
    status,
    completedAt: status === 'completed' ? new Date().toISOString() : null
  };

  const specMobo = document.getElementById('form-spec-mobo').value;
  const specCpu = document.getElementById('form-spec-cpu').value;
  const specGpu = document.getElementById('form-spec-gpu').value;
  const specRam = document.getElementById('form-spec-ram').value;
  const specStorage = document.getElementById('form-spec-storage').value;
  const specPsu = document.getElementById('form-spec-psu').value;
  const specCase = document.getElementById('form-spec-case').value;
  
  const coolerTypeRadio = document.querySelector('input[name="form-spec-cooler-type"]:checked');
  const specCoolerType = coolerTypeRadio ? coolerTypeRadio.value : 'stock';
  const specCoolerModel = specCoolerType !== 'stock' ? document.getElementById('form-spec-cooler-model').value : 'Stock Cooler';

  // Read specs directly from the modal UI fields
  const detectedCpuVal = document.getElementById('modal-spec-cpu').textContent;
  const detectedIgpuVal = document.getElementById('modal-spec-igpu').textContent;
  const detectedGpuVal = document.getElementById('modal-spec-gpu').textContent;
  const detectedRamVal = document.getElementById('modal-spec-ram').textContent;
  const detectedStorageVal = document.getElementById('modal-spec-storage').textContent;

  updatedTicket.specs = {
    mobo: specMobo,
    cpu: specCpu,
    gpu: specGpu,
    ram: specRam,
    storage: specStorage,
    coolerType: specCoolerType,
    coolerModel: specCoolerModel,
    psu: specPsu,
    case: specCase,
    os: 'Windows',
    windowsKey: document.getElementById('modal-activation-key').textContent === '--' ? (existingTicket && existingTicket.specs ? (existingTicket.specs.windowsKey || '') : '') : document.getElementById('modal-activation-key').textContent,
    windowsActivationState: document.getElementById('modal-activation-status').textContent === 'Unverified' ? (existingTicket && existingTicket.specs ? (existingTicket.specs.windowsActivationState || 'Unverified') : 'Unverified') : document.getElementById('modal-activation-status').textContent
  };

  // Persist per-category prices captured during autocomplete pick, so the
  // printed report's Build Cost Breakdown works without a second Supabase
  // round-trip. Structure mirrors the form field IDs → normalised category
  // keys used by the report. Preserves existing prices when an old ticket
  // is re-saved without re-picking (edit didn't touch that field).
  var fieldToCat = {
    'form-spec-cpu':'cpu', 'form-spec-gpu':'gpu', 'form-spec-ram':'ram',
    'form-spec-storage':'storage', 'form-spec-psu':'psu',
    'form-spec-mobo':'motherboard', 'form-spec-cooler-model':'cooler',
    'form-spec-case':'case'
  };
  var storedPrices = (existingTicket && existingTicket.specPrices) ? Object.assign({}, existingTicket.specPrices) : {};
  Object.keys(fieldToCat).forEach(function (fid) {
    var m = specFieldMatches[fid];
    if (m && m.priceInr != null) storedPrices[fieldToCat[fid]] = m.priceInr;
  });
  updatedTicket.specPrices = storedPrices;
  // Nested copy inside specs so cross-machine Supabase sync carries it too
  // without needing a new `spec_prices` column on the tickets table.
  updatedTicket.specs.__prices = storedPrices;

  // Component condition / damage report. Stored on the ticket AND mirrored into
  // specs.__damaged so the JSONB specs column carries it cross-machine (no
  // schema change). Empty array when nothing is flagged.
  updatedTicket.damagedComponents = damagedComponentsList.slice();
  updatedTicket.specs.__damaged = damagedComponentsList.slice();

  if (detectedCpuVal !== '--' && detectedCpuVal !== 'Not detected') {
    updatedTicket.detectedSpecs = {
      cpu: detectedCpuVal,
      igpu: (detectedIgpuVal === '--' || detectedIgpuVal === 'None') ? 'None' : detectedIgpuVal,
      gpu: (detectedGpuVal === '--' || detectedGpuVal === 'Not detected') ? '' : detectedGpuVal,
      ram: detectedRamVal,
      storage: detectedStorageVal,
      mobo: existingTicket && existingTicket.detectedSpecs ? (existingTicket.detectedSpecs.mobo || '') : '',
      coolerVerified: existingTicket && existingTicket.detectedSpecs ? !!existingTicket.detectedSpecs.coolerVerified : false,
      psuVerified: existingTicket && existingTicket.detectedSpecs ? !!existingTicket.detectedSpecs.psuVerified : false,
      caseVerified: existingTicket && existingTicket.detectedSpecs ? !!existingTicket.detectedSpecs.caseVerified : false
    };
  } else if (existingTicket && existingTicket.detectedSpecs) {
    updatedTicket.detectedSpecs = existingTicket.detectedSpecs;
  }

  // Sync checkbox with activation state
  if (updatedTicket.qcChecks.softWindows && updatedTicket.specs.windowsActivationState !== 'Activated') {
    updatedTicket.specs.windowsActivationState = 'Activated';
  } else if (!updatedTicket.qcChecks.softWindows && updatedTicket.specs.windowsActivationState === 'Activated') {
    updatedTicket.specs.windowsActivationState = 'Not Activated';
  }

  // Preserve existing event log from diagnostics
  if (existingTicket && existingTicket.diagnostics && existingTicket.diagnostics.eventLog) {
    updatedTicket.diagnostics.eventLog = existingTicket.diagnostics.eventLog;
  }

  // === EVENT LOG ENTRIES ===
  const techName = appState.settings.shopName || 'Admin';
  if (!editingTicketId) {
    // New ticket creation
    addEventLog(updatedTicket, `Ticket created for ${customerName} (${ticketType === 'build' ? 'New PC Build' : 'Service Repair'})`, techName);
  } else {
    // Detect changes vs existing ticket
    if (existingTicket) {
      if (existingTicket.status !== updatedTicket.status) {
        const oldLabel = getStatusLabelText(existingTicket.status);
        const newLabel = getStatusLabelText(updatedTicket.status);
        addEventLog(updatedTicket, `Status changed: "${oldLabel}" → "${newLabel}"`, techName);
      }
      if (existingTicket.technician !== updatedTicket.technician) {
        addEventLog(updatedTicket, `Technician reassigned: "${existingTicket.technician || 'Unassigned'}" → "${updatedTicket.technician}"`, techName);
      }
      if (existingTicket.deadline !== updatedTicket.deadline) {
        const oldDate = formatDateShort(existingTicket.deadline);
        const newDate = formatDateShort(updatedTicket.deadline);
        addEventLog(updatedTicket, `Deadline changed: ${oldDate} → ${newDate} UTC`, techName);
      }
      if (!existingTicket.missingComponentsToggle && updatedTicket.missingComponentsToggle && updatedTicket.missingComponents) {
        addEventLog(updatedTicket, `Awaiting parts: "${formatMissingComponentsHuman(updatedTicket.missingComponents)}"`, techName);
      } else if (existingTicket.missingComponentsToggle && !updatedTicket.missingComponentsToggle) {
        addEventLog(updatedTicket, `Parts constraint resolved — all components received`, techName);
      }
      // Log diagnostic completion if data newly added
      const oldDiagHasCb = existingTicket.diagnostics && existingTicket.diagnostics.cinebench;
      const newDiagHasCb = updatedTicket.diagnostics && updatedTicket.diagnostics.cinebench;
      if (!oldDiagHasCb && newDiagHasCb) {
        addEventLog(updatedTicket, `Benchmark recorded: Cinebench R23 = ${updatedTicket.diagnostics.cinebench} pts`, techName);
      }
    }
  }

  updatedTicket.updatedAt = new Date().toISOString();

  if (editingTicketId) {
    const index = appState.tickets.findIndex(t => t.id === editingTicketId);
    appState.tickets[index] = updatedTicket;
  } else {
    appState.tickets.push(updatedTicket);
  }

  await saveDatabase();
  await syncTicketToCloud(updatedTicket);
  document.getElementById('ticket-modal').classList.remove('active');
  editingTicketId = null;
  hideConflictBanner();
  renderDashboard();
  } catch (err) {
    // Never fail silently — surface the reason so a save problem is visible.
    console.error('Ticket save failed:', err);
    alert('Could not save the ticket: ' + (err && err.message ? err.message : err));
  }
}

// Duplicate Serial checking
function verifyFieldDuplicate(field) {
  if (!field) return;
  const val = field.value.trim();
  field.classList.remove('duplicate-err');

  if (val.length < 3) return;

  const isDuplicate = appState.tickets.some(t => {
    if (t.id === editingTicketId) return false;
    return t.serials && Object.values(t.serials).some(s => s && s.trim() === val);
  });

  if (isDuplicate) {
    field.classList.add('duplicate-err');
  }
}

function setupSerialVerification() {
  const fields = document.querySelectorAll('.serial-field');
  fields.forEach(field => {
    field.addEventListener('input', (e) => {
      verifyFieldDuplicate(e.target);
    });
  });
}

// ==========================================================================
// TESTING CLIENT PORTAL LOGIC
// ==========================================================================
let detectedSpecs = null;
let detectedWinKey = '';
let detectedWinStatus = '';
let parsedTemps = null;
let parsedCinebench = null;
let parsedDiskSpeeds = null;

async function setupClientMode() {
  // Automated Stress Test Execution (Client Portal)
  document.getElementById('btn-run-auto-diagnostics').addEventListener('click', async () => {
    await executeDiagnosticsWorkflow(false);
  });

  // Trigger system specs detection
  document.getElementById('btn-client-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-client-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      detectedSpecs = await ipcRenderer.invoke('sys:detect-hw');
      
      document.getElementById('c-spec-mobo').textContent = detectedSpecs.motherboard || "Failed to detect";
      document.getElementById('c-spec-cpu').textContent = detectedSpecs.cpu || "Failed to detect";
      const igpuEl = document.getElementById('c-spec-igpu');
      if (igpuEl) igpuEl.textContent = detectedSpecs.igpu || "None";
      document.getElementById('c-spec-gpu').textContent = detectedSpecs.dgpu || "None";
      document.getElementById('c-spec-ram').textContent = detectedSpecs.ram || "Failed to detect";
      document.getElementById('c-spec-storage').textContent = detectedSpecs.storage || "Failed to detect";

      btn.textContent = "🔍 Hardware Specs Detected";
      btn.classList.add('secondary-btn');
      btn.classList.remove('primary-pink-btn');

      checkClientFormReady();
      checkSpecsMatch();
    } catch (err) {
      console.error("Client specs detection error:", err);
      alert("Specs detection failed: " + err.message);
    } finally {
      btn.disabled = false;
      if (btn.textContent === "🔍 Detecting hardware...") {
        btn.textContent = oldText;
      }
    }
  });

  // Windows Activation Check
  document.getElementById('btn-client-check-win').addEventListener('click', async () => {
    const winStatusBox = document.getElementById('client-win-status');
    const winKeyContainer = document.getElementById('client-win-key-container');
    const winKeyVal = document.getElementById('client-win-key');
    
    winStatusBox.innerHTML = `Activation Status: <span class="badge">Running check...</span>`;
    if (winKeyContainer) winKeyContainer.classList.add('hidden');

    const result = await ipcRenderer.invoke('sys:check-win');
    if (result.activated) {
      winStatusBox.innerHTML = `Activation Status: <span class="badge green">🛡️ Activated</span>`;
      winStatusBox.dataset.activated = "true";
      detectedWinStatus = "Activated";
    } else {
      winStatusBox.innerHTML = `Activation Status: <span class="badge red">⚠️ Not Activated</span>`;
      winStatusBox.dataset.activated = "false";
      detectedWinStatus = "Not Activated";
    }
    
    if (result.productKey) {
      detectedWinKey = result.productKey;
      if (winKeyVal) winKeyVal.textContent = result.productKey;
      if (winKeyContainer) winKeyContainer.classList.remove('hidden');
      // v1.4.5 — surface the "this is a Microsoft placeholder key" note when
      // the probe detects Digital License activation, so the tech doesn't
      // print a shared generic key on the QC report thinking it's the real
      // retail key. Also lets them know where to actually find it.
      if (result.keyDetail && result.keyDetail.isDigitalLicensePlaceholder) {
        var note = document.getElementById('client-win-key-note');
        if (!note && winKeyContainer && winKeyContainer.parentNode) {
          note = document.createElement('div');
          note.id = 'client-win-key-note';
          note.style.cssText = 'margin-top:6px;padding:8px;background:rgba(255,193,7,0.12);border:1px solid rgba(255,193,7,0.4);border-radius:6px;font-size:0.72rem;color:#b8860b;';
          winKeyContainer.parentNode.appendChild(note);
        }
        if (note) {
          note.textContent = '⚠ Digital License placeholder — this is a shared Microsoft key. The real retail/OEM key you entered isn\'t stored on this machine (activation is tied to your Microsoft Account server-side). Get it from account.microsoft.com › Devices, or your install notes.';
        }
      } else {
        var existingNote = document.getElementById('client-win-key-note');
        if (existingNote) existingNote.remove();
      }
    } else {
      detectedWinKey = '';
    }

    checkClientFormReady();
  });

  // Submit client results
  document.getElementById('btn-client-submit').addEventListener('click', async () => {
    const ticketId = document.getElementById('client-ticket-select').value;
    if (!ticketId) return;

    const index = appState.tickets.findIndex(t => t.id === ticketId);
    if (index === -1) return;

    const t = appState.tickets[index];

    // Ensure specs object exists
    if (!t.specs) {
      t.specs = {
        mobo: '',
        cpu: '',
        gpu: '',
        ram: '',
        storage: '',
        coolerType: 'stock',
        coolerModel: '',
        psu: '',
        case: ''
      };
    }

    // Populate detected specs in t.detectedSpecs (NOT t.specs)
    if (!t.detectedSpecs) {
      t.detectedSpecs = {};
    }
    if (detectedSpecs) {
      t.detectedSpecs.cpu = detectedSpecs.cpu;
      t.detectedSpecs.igpu = detectedSpecs.igpu || 'None';
      t.detectedSpecs.gpu = detectedSpecs.dgpu || 'None';
      t.detectedSpecs.ram = detectedSpecs.ram;
      t.detectedSpecs.storage = detectedSpecs.storage;
      t.detectedSpecs.motherboard = detectedSpecs.motherboard || '';
    }

    // Populate physical checks verified status
    t.detectedSpecs.coolerVerified = document.getElementById('c-verify-cooler').checked;
    t.detectedSpecs.psuVerified = document.getElementById('c-verify-psu').checked;
    t.detectedSpecs.caseVerified = document.getElementById('c-verify-case').checked;

    t.specs.os = 'Windows';
    t.specs.windowsKey = detectedWinKey || t.specs.windowsKey || '';
    t.specs.windowsActivationState = detectedWinStatus || t.specs.windowsActivationState || '';

    // Windows activation update
    const winStatusBox = document.getElementById('client-win-status');
    if (winStatusBox.dataset.activated === "true") {
      t.qcChecks.softWindows = true;
      t.specs.windowsActivationState = "Activated";
    } else {
      t.qcChecks.softWindows = false;
      if (detectedWinStatus === "Not Activated") {
        t.specs.windowsActivationState = "Not Activated";
      }
    }

    // Populate diagnostics from inputs
    t.diagnostics.cpuTempMin = parseFloat(document.getElementById('c-cpu-temp-min').value) || null;
    t.diagnostics.cpuTempMax = parseFloat(document.getElementById('c-cpu-temp-max').value) || null;
    t.diagnostics.cpuTempAvg = parseFloat(document.getElementById('c-cpu-temp-avg').value) || null;
    
    t.diagnostics.gpuTempMin = parseFloat(document.getElementById('c-gpu-temp-min').value) || null;
    t.diagnostics.gpuTempMax = parseFloat(document.getElementById('c-gpu-temp-max').value) || null;
    t.diagnostics.gpuTempAvg = parseFloat(document.getElementById('c-gpu-temp-avg').value) || null;

    t.diagnostics.cinebench = parseFloat(document.getElementById('c-cinebench-score').value) || null;
    t.diagnostics.furmark = parseFloat(document.getElementById('c-furmark-score').value) || null;
    t.diagnostics.ssdRead = parseFloat(document.getElementById('c-ssd-read').value) || null;
    t.diagnostics.ssdWrite = parseFloat(document.getElementById('c-ssd-write').value) || null;
    t.diagnostics.rivalConfigId = "";

    // Set QC check indicators
    if (t.diagnostics.cpuTempAvg !== null) {
      t.qcChecks.physCabinet = true; // Default auto physical checks pass on client submission to bypass manually typing
      t.qcChecks.softDrivers = true;
      t.qcChecks.softBios = true;
      t.qcChecks.portUsb = true;
      t.qcChecks.portVideo = true;
      t.qcChecks.portAudio = true;
      t.qcChecks.portWifi = true;
    }

    // Status transition
    t.status = 'qc_testing';
    const isQcFull = t.qcChecks.physCabinet && t.qcChecks.softWindows && t.qcChecks.softDrivers;
    if (isQcFull && t.diagnostics.cinebench) {
      t.status = 'completed';
      t.completedAt = new Date().toISOString();
    }

    // Add event log entry for client diagnostics submission
    if (t.diagnostics.cinebench) {
      addEventLog(t, `Client diagnostics submitted: Cinebench R23 = ${t.diagnostics.cinebench} pts, CPU Avg = ${t.diagnostics.cpuTempAvg}°C, GPU Avg = ${t.diagnostics.gpuTempAvg}°C`, 'Testing Client');
    }

    t.updatedAt = new Date().toISOString();
    appState.tickets[index] = t;
    await saveDatabase();

    // Show sync-in-progress state — block navigation until confirmed
    const submitBtn = document.getElementById('btn-client-submit');
    const syncStatus = document.getElementById('client-sync-status');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Syncing to cloud...'; }
    if (syncStatus) { syncStatus.textContent = '⏳ Uploading diagnostic data to cloud — please wait...'; syncStatus.className = 'client-sync-status syncing'; syncStatus.classList.remove('hidden'); }

    let syncOk = false;
    try {
      await syncTicketToCloud(t);
      syncOk = true;
    } catch(e) {
      syncOk = false;
    }

    if (syncOk) {
      if (syncStatus) { syncStatus.textContent = '✓ All data synced to cloud successfully. Safe to close or uninstall.'; syncStatus.className = 'client-sync-status success'; }
      if (submitBtn) { submitBtn.textContent = '✓ Synced'; }
      setTimeout(() => {
        if (appState.settings.isMaster) {
          switchScreen('selector');
        } else {
          switchScreen('client');
        }
      }, 1800);
    } else {
      if (syncStatus) { syncStatus.textContent = '✕ Cloud sync failed — data saved locally. Retry or check your network connection.'; syncStatus.className = 'client-sync-status error'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '🔄 Retry Sync'; }
    }
  });

  // Client comparison value sync event listeners removed (Rival comparison omitted)

  // Setup client temperature averaging calculations
  setupClientFormCalculations();
  setupPortsChecker();
}

function getHwInfoStats(content) {
  if (!content) return null;
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  // Auto-detect delimiter (, or ;)
  let delimiter = ',';
  let testLine = lines[0];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].includes(';') || lines[i].includes(',')) {
      testLine = lines[i];
      break;
    }
  }
  const commas = (testLine.match(/,/g) || []).length;
  const semicolons = (testLine.match(/;/g) || []).length;
  if (semicolons > commas) {
    delimiter = ';';
  }

  // Find the header row dynamically (skipping blank/metadata lines)
  let headerLineIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if ((line.includes('Date') || line.includes('Time')) && (lower.includes('cpu') || lower.includes('gpu'))) {
      headerLineIndex = i;
      break;
    }
  }

  const headers = lines[headerLineIndex].split(delimiter).map(h => h.replace(/"/g, '').trim());
  
  // Find indices for CPU and GPU Temperature columns (Case-Insensitive matching)
  let cpuIdx = headers.findIndex(h => {
    const lower = h.toLowerCase();
    return lower.includes('cpu (tctl/tdie)') || 
           lower.includes('cpu package') || 
           lower.includes('cpu [°c]') || 
           lower.includes('cpu die (average)') || 
           lower.includes('core max') || 
           lower.includes('cpu core') ||
           lower.includes('cpu temp') ||
           lower.includes('cpu temperature');
  });

  let gpuIdx = headers.findIndex(h => {
    const lower = h.toLowerCase();
    return lower.includes('gpu temperature') || 
           lower.includes('gpu core') || 
           lower.includes('gpu [°c]') || 
           lower.includes('gpu temp') ||
           lower.includes('gpu thermal diode');
  });

  // Fallbacks
  if (cpuIdx === -1) cpuIdx = headers.findIndex(h => h.toLowerCase().includes('cpu') && (h.includes('°C') || h.toLowerCase().includes('temp') || h.toLowerCase().includes('tctl')));
  if (gpuIdx === -1) gpuIdx = headers.findIndex(h => h.toLowerCase().includes('gpu') && (h.includes('°C') || h.toLowerCase().includes('temp') || h.toLowerCase().includes('core')));

  if (cpuIdx === -1 && gpuIdx === -1) return null;

  let cpuVals = [];
  let gpuVals = [];

  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split(delimiter);
    
    if (cpuIdx !== -1 && cols[cpuIdx]) {
      const v = parseFloat(cols[cpuIdx].replace(/"/g, '').trim());
      if (!isNaN(v)) cpuVals.push(v);
    }
    if (gpuIdx !== -1 && cols[gpuIdx]) {
      const v = parseFloat(cols[gpuIdx].replace(/"/g, '').trim());
      if (!isNaN(v)) gpuVals.push(v);
    }
  }

  const getStats = (arr) => {
    if (arr.length === 0) return { min: 0, max: 0, avg: 0 };
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / arr.length);
    return { min: Math.round(min), max: Math.round(max), avg };
  };

  return {
    cpu: getStats(cpuVals),
    gpu: getStats(gpuVals)
  };
}

function checkClientFormReady() {
  const ticketId = document.getElementById('client-ticket-select').value;
  const submitBtn = document.getElementById('btn-client-submit');
  const syncStatus = document.getElementById('client-sync-status');
  if (ticketId) {
    submitBtn.removeAttribute('disabled');
    submitBtn.textContent = '💾 Sync & Save';
    if (syncStatus) syncStatus.classList.add('hidden');
  } else {
    submitBtn.setAttribute('disabled', 'true');
  }
}

// ==========================================================================
// PRINTING REPORTS MAPPING (A4 Layout Integration)
// ==========================================================================
// The three-page report populate logic lives in print-render.js
// (NeoQcPrintRender) — deliberately Electron-free so the report layout can be
// developed and visually tested in a plain browser harness
// (report-harness.html). This wrapper just injects the app-side state.
function populatePrintFields(ticket) {
  // Returns true only when the report was actually populated — callers MUST
  // abort printing otherwise. v1.3.0 silently printed the empty "--" skeleton
  // when NeoQcPrintRender was missing (the Electron UMD gotcha); an unusable
  // report must never reach paper/PDF quietly again.
  if (!window.NeoQcPrintRender) {
    alert('Report renderer failed to load (print-render.js) — cannot generate the QC report. Please report this to the developer.');
    return false;
  }
  try {
    window.NeoQcPrintRender.populate(
      ticket,
      (appState && appState.settings) || {},
      ppiCacheByTicket[ticket.id]
    );
    return true;
  } catch (e) {
    console.error('Report populate failed:', e);
    alert('Report generation failed: ' + e.message);
    return false;
  }
}

function triggerPrintReport(ticketId, shouldPrint = true) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  if (!populatePrintFields(ticket)) return; // never print an unpopulated skeleton

  // Execute print in main Electron window
  if (shouldPrint) {
    ipcRenderer.invoke('sys:print');
  }
}

async function triggerSavePdf(ticketId) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  if (!populatePrintFields(ticket)) return; // never save an unpopulated skeleton

  // Save PDF filename
  const cleanName = ticket.customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const defaultFilename = `QC_Report_${cleanName}_${ticket.id.slice(-6)}.pdf`;

  const result = await ipcRenderer.invoke('sys:print-pdf', defaultFilename);
  if (result.success) {
    alert(`PDF Report successfully saved to:\n${result.filePath}`);
  } else if (result.error !== 'Cancelled') {
    alert(`Failed to save PDF: ${result.error}`);
  }
}

// ==========================================================================
// SETTINGS SCREEN ACTIONS
// ==========================================================================
let isAdminUnlocked = false;

function resetAdminLockState() {
  isAdminUnlocked = false;
  
  const lockBadge = document.getElementById('admin-lock-badge');
  const unlockPrompt = document.getElementById('admin-unlock-prompt');
  const sensitiveFields = document.getElementById('admin-sensitive-fields');
  
  if (lockBadge) {
    lockBadge.textContent = "🔒 Locked";
    lockBadge.className = "badge red";
  }
  if (unlockPrompt) unlockPrompt.classList.remove('hidden');
  if (sensitiveFields) sensitiveFields.classList.add('hidden');
  
  const inputsToDisable = [
    'settings-supabase-url',
    'settings-supabase-key',
    'btn-toggle-key-visibility',
    'btn-test-db-connection',
    'settings-is-master',
    'settings-lock-admin'
  ];
  inputsToDisable.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute('disabled', 'true');
    }
  });

  const keyInput = document.getElementById('settings-supabase-key');
  if (keyInput) keyInput.type = 'password';
  const toggleBtn = document.getElementById('btn-toggle-key-visibility');
  if (toggleBtn) toggleBtn.textContent = '👁️';
}

function unlockAdminSettings() {
  const passcode = prompt("Enter administrator password to edit database configurations:");
  if (passcode === 'neoadmin') {
    isAdminUnlocked = true;
    
    const lockBadge = document.getElementById('admin-lock-badge');
    const unlockPrompt = document.getElementById('admin-unlock-prompt');
    const sensitiveFields = document.getElementById('admin-sensitive-fields');
    
    if (lockBadge) {
      lockBadge.textContent = "🔓 Unlocked";
      lockBadge.className = "badge green";
    }
    if (unlockPrompt) unlockPrompt.classList.add('hidden');
    if (sensitiveFields) sensitiveFields.classList.remove('hidden');
    
    const inputsToEnable = [
      'settings-supabase-url',
      'settings-supabase-key',
      'btn-toggle-key-visibility',
      'btn-test-db-connection',
      'settings-is-master',
      'settings-lock-admin'
    ];
    inputsToEnable.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.removeAttribute('disabled');
      }
    });
    alert("Admin Settings Unlocked.");
  } else {
    alert("Incorrect passcode. Access Denied.");
  }
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  resetAdminLockState();
  
  // Render technicians
  const techList = document.getElementById('settings-tech-list');
  techList.innerHTML = '';
  appState.technicians.forEach(tech => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${tech}</span><button class="text-btn text-crimson remove-tech-btn">Remove</button>`;
    li.querySelector('.remove-tech-btn').addEventListener('click', () => {
      appState.technicians = appState.technicians.filter(t => t !== tech);
      openSettingsModal(); // Refresh
    });
    techList.appendChild(li);
  });

  // Render PPI Engine use-case tuning table (replaces the old rival DB).
  renderPpiConfigTable();

  document.getElementById('settings-supabase-url').value = appState.settings.supabaseUrl || '';
  document.getElementById('settings-supabase-key').value = appState.settings.supabaseAnonKey || '';
  document.getElementById('settings-path-hwinfo').value = appState.settings.pathHwInfo || '';
  document.getElementById('settings-path-cinebench').value = appState.settings.pathCinebench || '';
  document.getElementById('settings-path-furmark').value = appState.settings.pathFurmark || '';
  document.getElementById('settings-path-prime95').value = appState.settings.pathPrime95 || '';
  document.getElementById('settings-path-ssd-utility').value = appState.settings.pathSsdUtility || '';
  document.getElementById('settings-is-master').checked = !!appState.settings.isMaster;
  document.getElementById('settings-auto-detect-hw').checked = !!appState.settings.autoDetectHw;
  document.getElementById('settings-lock-admin').checked = !!appState.settings.lockAdminMode;

  // Populate new general settings
  document.getElementById('settings-shop-name').value = appState.settings.shopName || '';
  document.getElementById('settings-contact-info').value = appState.settings.contactInfo || '';
  document.getElementById('settings-accent-color').value = appState.settings.accentColor || 'pink';
  document.getElementById('settings-sound-enabled').checked = !!appState.settings.soundEnabled;
  document.getElementById('settings-disable-qc-lock').checked = !!appState.settings.disableQcLock;

  // Populate default technician select list inside settings
  const techSelect = document.getElementById('settings-default-tech');
  techSelect.innerHTML = '<option value="">-- None (Unassigned) --</option>';
  appState.technicians.forEach(tech => {
    const opt = document.createElement('option');
    opt.value = tech;
    opt.textContent = tech;
    techSelect.appendChild(opt);
  });
  techSelect.value = appState.settings.defaultTech || '';
  document.getElementById('settings-sort-by').value = appState.settings.sortBy || 'deadline';

  // Populate thresholds
  document.getElementById('settings-cpu-max-temp').value = appState.settings.cpuMaxTemp || 85;
  document.getElementById('settings-cpu-max-temp-val').textContent = (appState.settings.cpuMaxTemp || 85) + '°C';
  document.getElementById('settings-gpu-max-temp').value = appState.settings.gpuMaxTemp || 80;
  document.getElementById('settings-gpu-max-temp-val').textContent = (appState.settings.gpuMaxTemp || 80) + '°C';
  document.getElementById('settings-min-ssd-speed').value = appState.settings.minSsdSpeed || 3000;
  document.getElementById('settings-min-ssd-write').value = appState.settings.minSsdWrite || 2500;
  document.getElementById('settings-min-cinebench').value = appState.settings.minCinebench || 10000;
  document.getElementById('settings-min-furmark').value = appState.settings.minFurmark || 5000;
  document.getElementById('settings-default-test-duration').value = appState.settings.defaultTestDuration || '60';
  document.getElementById('settings-auto-pdf').checked = !!appState.settings.autoPdf;

  // Dashboard portal tab
  const pinEl = document.getElementById('settings-dashboard-pin');
  if (pinEl) { pinEl.value = appState.settings.dashboardPin || '9374'; pinEl.type = 'password'; }
  const urgentEl = document.getElementById('settings-urgent-hours');
  if (urgentEl) urgentEl.value = appState.settings.urgentHours || 48;

  // App version — header badge + sidebar label. The old code used
  // `require('electron').remote.app.getVersion()`, but `electron.remote` was
  // removed in Electron 14+ (this app is on Electron 42), so the expression
  // returned undefined and the badge showed "vundefined". Ask the main
  // process via IPC instead. Falls back to '—' if the call fails.
  const verEl = document.getElementById('settings-app-version');
  const sideVerEl = document.getElementById('settings-sidebar-ver');
  (async () => {
    try {
      const v = await ipcRenderer.invoke('app:get-version');
      const label = v ? 'v' + v : 'v—';
      if (verEl) verEl.textContent = label;
      if (sideVerEl) sideVerEl.textContent = label;
    } catch (_) {
      if (verEl) verEl.textContent = 'v—';
      if (sideVerEl) sideVerEl.textContent = 'v—';
    }
  })();

  // Reset active tab in settings modal
  document.querySelectorAll('.settings-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector('.settings-tab-btn[data-tab="tab-general"]').classList.add('active');
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById('tab-general').classList.remove('hidden');

  modal.classList.add('active');
}

async function handleSaveSettings() {
  appState.settings.supabaseUrl = document.getElementById('settings-supabase-url').value.trim();
  appState.settings.supabaseAnonKey = document.getElementById('settings-supabase-key').value.trim();
  appState.settings.pathHwInfo = document.getElementById('settings-path-hwinfo').value.trim();
  appState.settings.pathCinebench = document.getElementById('settings-path-cinebench').value.trim();
  appState.settings.pathFurmark = document.getElementById('settings-path-furmark').value.trim();
  appState.settings.pathPrime95 = document.getElementById('settings-path-prime95').value.trim();
  appState.settings.pathSsdUtility = document.getElementById('settings-path-ssd-utility').value.trim();
  appState.settings.isMaster = document.getElementById('settings-is-master').checked;
  appState.settings.autoDetectHw = document.getElementById('settings-auto-detect-hw').checked;
  appState.settings.lockAdminMode = document.getElementById('settings-lock-admin').checked;

  // Save new settings
  appState.settings.shopName = document.getElementById('settings-shop-name').value.trim();
  appState.settings.contactInfo = document.getElementById('settings-contact-info').value.trim();
  appState.settings.accentColor = document.getElementById('settings-accent-color').value;
  appState.settings.soundEnabled = document.getElementById('settings-sound-enabled').checked;
  appState.settings.disableQcLock = document.getElementById('settings-disable-qc-lock').checked;
  appState.settings.defaultTech = document.getElementById('settings-default-tech').value;
  appState.settings.sortBy = document.getElementById('settings-sort-by').value;

  appState.settings.cpuMaxTemp = parseInt(document.getElementById('settings-cpu-max-temp').value) || 85;
  appState.settings.gpuMaxTemp = parseInt(document.getElementById('settings-gpu-max-temp').value) || 80;
  appState.settings.minSsdSpeed = parseInt(document.getElementById('settings-min-ssd-speed').value) || 3000;
  appState.settings.minSsdWrite = parseInt(document.getElementById('settings-min-ssd-write').value) || 2500;
  appState.settings.minCinebench = parseInt(document.getElementById('settings-min-cinebench').value) || 10000;
  appState.settings.minFurmark = parseInt(document.getElementById('settings-min-furmark').value) || 5000;
  appState.settings.defaultTestDuration = document.getElementById('settings-default-test-duration').value;
  appState.settings.autoPdf = document.getElementById('settings-auto-pdf').checked;
  appState.settings.dashboardPin = (document.getElementById('settings-dashboard-pin')?.value || '').trim() || '9374';
  appState.settings.urgentHours  = parseInt(document.getElementById('settings-urgent-hours')?.value) || 48;

  applyAccentColor(appState.settings.accentColor);

  await saveDatabase();
  document.getElementById('settings-modal').classList.remove('active');
  
  if (currentMode === 'staff') {
    renderDashboard();
  } else if (currentMode === 'client' || currentMode === 'client-console') {
    handleClientTicketSelect();
  }

  if (!appState.settings.isMaster) {
    switchScreen('client');
  } else {
    if (currentMode === 'staff') {
      renderDashboard();
    } else {
      switchScreen('selector');
    }
  }
}

// ==========================================================================
// EVENT LISTENERS REGISTER
// ==========================================================================
function setupEventListeners() {
  // Collapsible event log toggle
  const eventLogHeader = document.getElementById('event-log-header');
  const eventLogSection = document.querySelector('.event-log-section');
  if (eventLogHeader && eventLogSection) {
    eventLogHeader.addEventListener('click', () => {
      eventLogSection.classList.toggle('collapsed');
    });
  }

  // Frameless custom window control button IPC signals
  document.getElementById('win-btn-minimize').addEventListener('click', () => ipcRenderer.send('win:minimize'));
  document.getElementById('win-btn-maximize').addEventListener('click', () => ipcRenderer.send('win:maximize'));
  document.getElementById('win-btn-close').addEventListener('click', () => ipcRenderer.send('win:close'));

  // Mode launch buttons
  document.getElementById('btn-launch-staff').addEventListener('click', () => switchScreen('staff'));
  document.getElementById('btn-launch-client').addEventListener('click', () => {
    switchScreen('client');
  });

  // Welcome Screen Listeners
  const welcomeSelect = document.getElementById('welcome-ticket-select');
  const welcomePreview = document.getElementById('welcome-spec-preview');
  const welcomeLaunch = document.getElementById('btn-welcome-launch');

  if (welcomeSelect) {
    welcomeSelect.addEventListener('change', () => {
      const ticketId = welcomeSelect.value;
      if (!ticketId) {
        welcomePreview.classList.add('hidden');
        welcomeLaunch.disabled = true;
        return;
      }
      const ticket = appState.tickets.find(t => t.id === ticketId);
      if (ticket) {
        document.getElementById('w-spec-cpu').textContent = ticket.specs ? (ticket.specs.cpu || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-igpu').textContent = ticket.specs ? (ticket.specs.igpu || 'None') : 'None';
        document.getElementById('w-spec-gpu').textContent = ticket.specs ? (ticket.specs.gpu || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-ram').textContent = ticket.specs ? (ticket.specs.ram || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-storage').textContent = ticket.specs ? (ticket.specs.storage || 'Not detected') : 'Not detected';
        
        welcomePreview.classList.remove('hidden');
        welcomeLaunch.disabled = false;
      }
    });
  }

  if (welcomeLaunch) {
    welcomeLaunch.addEventListener('click', () => {
      const ticketId = welcomeSelect.value;
      if (ticketId) {
        switchScreen('client-console', ticketId);
      }
    });
  }

  const welcomeExit = document.getElementById('btn-welcome-exit');
  if (welcomeExit) {
    welcomeExit.addEventListener('click', () => {
      switchScreen('selector');
    });
  }

  // Client input connection ID matching
  const clientTicketInput = document.getElementById('client-ticket-input');
  const clientTicketSelect = document.getElementById('client-ticket-select');
  if (clientTicketInput && clientTicketSelect) {
    clientTicketInput.addEventListener('input', () => {
      let rawVal = clientTicketInput.value.trim().toLowerCase();
      if (rawVal.startsWith('#')) rawVal = rawVal.substring(1);
      if (rawVal === '') {
        clientTicketSelect.value = '';
        handleClientTicketSelect();
        return;
      }
      const matched = appState.tickets.find(t => 
        t.id.toLowerCase() === rawVal || 
        t.id.toLowerCase().endsWith(rawVal)
      );
      if (matched) {
        clientTicketSelect.value = matched.id;
        handleClientTicketSelect();
      }
    });

    clientTicketSelect.addEventListener('change', () => {
      if (clientTicketSelect.value) {
        clientTicketInput.value = '#' + clientTicketSelect.value.slice(-6).toUpperCase();
      } else {
        clientTicketInput.value = '';
      }
    });
  }

  // Theme change toggle — remembers the choice (admin app only; persisted in
  // settings so it survives relaunches).
  document.getElementById('btn-toggle-theme').addEventListener('click', async () => {
    const isDark = document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode', !isDark);
    if (!appState.settings) appState.settings = {};
    appState.settings.darkMode = isDark;
    try { await saveDatabase(); } catch (e) {}
  });

  // Settings modals
  document.getElementById('btn-show-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('active');
  });
  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);

  // Admin password unlock listener
  const btnUnlockAdmin = document.getElementById('btn-unlock-admin');
  if (btnUnlockAdmin) {
    btnUnlockAdmin.addEventListener('click', unlockAdminSettings);
  }

  // Admin database key visibility toggle
  const btnToggleVisibility = document.getElementById('btn-toggle-key-visibility');
  if (btnToggleVisibility) {
    btnToggleVisibility.addEventListener('click', () => {
      const keyInput = document.getElementById('settings-supabase-key');
      if (keyInput) {
        if (keyInput.type === 'password') {
          keyInput.type = 'text';
          btnToggleVisibility.textContent = '🙈';
        } else {
          keyInput.type = 'password';
          btnToggleVisibility.textContent = '👁️';
        }
      }
    });
  }
  // Dashboard PIN — show/hide toggle
  const btnTogglePin = document.getElementById('btn-toggle-pin-visibility');
  if (btnTogglePin) {
    btnTogglePin.addEventListener('click', () => {
      const pinInput = document.getElementById('settings-dashboard-pin');
      if (!pinInput) return;
      const isHidden = pinInput.type === 'password';
      pinInput.type = isHidden ? 'text' : 'password';
      btnTogglePin.textContent = isHidden ? '🙈' : '👁';
    });
  }

  // Dashboard PIN — copy to clipboard
  const btnCopyPin = document.getElementById('btn-copy-dashboard-pin');
  if (btnCopyPin) {
    btnCopyPin.addEventListener('click', async () => {
      const pin = document.getElementById('settings-dashboard-pin')?.value;
      if (!pin) return;
      try {
        await navigator.clipboard.writeText(pin);
        const orig = btnCopyPin.textContent;
        btnCopyPin.textContent = 'Copied!';
        setTimeout(() => { btnCopyPin.textContent = orig; }, 1500);
      } catch (_) {}
    });
  }

  document.getElementById('btn-reseed-data').addEventListener('click', async () => {
    if (confirm("This will overwrite your current tickets with mock demo data. Proceed?")) {
      seedMockTickets();
      await saveDatabase();
      document.getElementById('settings-modal').classList.remove('active');
      renderDashboard();
      alert("Mock database reseeded successfully!");
    }
  });

  // Settings Tab switching
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = btn.getAttribute('data-tab');
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(tabId).classList.remove('hidden');
    });
  });

  // Settings Max Temp Sliders value updates
  const cpuSlider = document.getElementById('settings-cpu-max-temp');
  if (cpuSlider) {
    cpuSlider.addEventListener('input', () => {
      document.getElementById('settings-cpu-max-temp-val').textContent = cpuSlider.value + '°C';
    });
  }
  const gpuSlider = document.getElementById('settings-gpu-max-temp');
  if (gpuSlider) {
    gpuSlider.addEventListener('input', () => {
      document.getElementById('settings-gpu-max-temp-val').textContent = gpuSlider.value + '°C';
    });
  }

  // Password-protected ticket deadline unlock
  const btnChangeDeadline = document.getElementById('btn-change-deadline');
  if (btnChangeDeadline) {
    btnChangeDeadline.addEventListener('click', () => {
      const pw = prompt("Enter administrator password to edit deadline:");
      if (pw === 'neoadmin') {
        document.getElementById('form-deadline').disabled = false;
        alert("Deadline unlocked. You can now modify the target date.");
      } else {
        alert("Incorrect password. Deadline locked.");
      }
    });
  }

  // Changelog close button
  const btnCloseChangelog = document.getElementById('btn-close-changelog');
  if (btnCloseChangelog) {
    btnCloseChangelog.addEventListener('click', async () => {
      document.getElementById('changelog-modal').classList.remove('active');
      const currentVer = require('./package.json').version;
      appState.lastRunVersion = currentVer;
      await saveDatabase();
    });
  }

  // Add technician
  document.getElementById('btn-settings-add-tech').addEventListener('click', () => {
    const input = document.getElementById('settings-add-tech-name');
    const name = input.value.trim();
    if (name && !appState.technicians.includes(name)) {
      appState.technicians.push(name);
      input.value = '';
      openSettingsModal();
    }
  });

  // PPI tuning panel handlers (add use-case / save / reset).
  setupPpiTuningHandlers();

  // Ticket create/edit actions
  document.getElementById('btn-new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('btn-close-ticket-modal').addEventListener('click', () => {
    document.getElementById('ticket-modal').classList.remove('active');
    editingTicketId = null;
    hideConflictBanner();
  });
  document.getElementById('btn-cancel-ticket').addEventListener('click', () => {
    document.getElementById('ticket-modal').classList.remove('active');
    editingTicketId = null;
    hideConflictBanner();
  });
  document.getElementById('btn-reload-conflict-form').addEventListener('click', () => {
    if (editingTicketId) openTicketModal(editingTicketId);
  });
  document.getElementById('btn-dismiss-conflict-banner').addEventListener('click', hideConflictBanner);
  document.getElementById('btn-delete-ticket').addEventListener('click', async () => {
    if (editingTicketId && confirm("Are you sure you want to delete this ticket?")) {
      const idToDelete = editingTicketId;
      appState.tickets = appState.tickets.filter(t => t.id !== idToDelete);
      await saveDatabase();
      await deleteTicketFromCloud(idToDelete);
      document.getElementById('ticket-modal').classList.remove('active');
      renderDashboard();
    }
  });

  document.getElementById('ticket-form').addEventListener('submit', handleTicketFormSubmit);

  // Staff Modal System Auto-Detect Local Specs click handler
  document.getElementById('btn-modal-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-modal-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      const detected = await ipcRenderer.invoke('sys:detect-hw');
      
      // Update modal spec elements
      document.getElementById('modal-spec-cpu').textContent = detected.cpu || "Failed to detect";
      document.getElementById('modal-spec-igpu').textContent = detected.igpu || "None";
      document.getElementById('modal-spec-gpu').textContent = detected.dgpu || "None";
      document.getElementById('modal-spec-ram').textContent = detected.ram || "Failed to detect";
      document.getElementById('modal-spec-storage').textContent = detected.storage || "Failed to detect";

      // Competitor auto-detect comparison and banner updates omitted
    } catch (err) {
      console.error("Hardware spec detection failed in modal:", err);
      alert("Hardware specs detection failed: " + err.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  });

  // Invoice PDF → auto-fill Target Build Specs.
  const importInvoiceBtn = document.getElementById('btn-import-invoice');
  if (importInvoiceBtn) {
    const statusEl = document.getElementById('invoice-import-status');
    const setInvoiceStatus = (html, kind) => {
      if (!statusEl) return;
      statusEl.classList.remove('hidden');
      statusEl.innerHTML = html;
      const palette = {
        info:  ['rgba(59,130,246,0.10)', 'rgba(59,130,246,0.35)', '#1d4ed8'],
        ok:    ['rgba(16,185,129,0.10)', 'rgba(16,185,129,0.35)', '#047857'],
        warn:  ['rgba(245,158,11,0.12)', 'rgba(245,158,11,0.40)', '#b45309'],
        error: ['rgba(239,68,68,0.10)', 'rgba(239,68,68,0.40)', '#b91c1c']
      };
      const c = palette[kind] || palette.info;
      statusEl.style.background = c[0];
      statusEl.style.border = '1px solid ' + c[1];
      statusEl.style.color = c[2];
    };
    const catLabel = { cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'Storage', psu: 'PSU', motherboard: 'Motherboard', case: 'Case', cooler: 'Cooler' };

    importInvoiceBtn.addEventListener('click', async () => {
      const oldText = importInvoiceBtn.textContent;
      try {
        const filePath = await ipcRenderer.invoke('dialog:open-file', [{ name: 'PDF Invoice', extensions: ['pdf'] }]);
        if (!filePath) return;
        importInvoiceBtn.disabled = true;
        importInvoiceBtn.textContent = '⏳ Reading invoice…';
        setInvoiceStatus('Extracting text from the invoice…', 'info');

        if (!window.NeoQcInvoiceImport) {
          setInvoiceStatus('❌ Invoice import module not loaded.', 'error');
          return;
        }

        // Text-first: fast path for normal (text-based) PDFs. Many invoice
        // generators (including the NeoTokyo template) embed text as glyph-only
        // subset fonts with no Unicode mapping, so extraction yields nothing
        // usable — fall back to OCR, which reads the rendered page visually.
        let invoiceText = '';
        const parsed = await ipcRenderer.invoke('invoice:parse-pdf', filePath);
        if (parsed && parsed.ok) invoiceText = parsed.text || '';

        const usable = window.NeoQcInvoiceOcr
          ? window.NeoQcInvoiceOcr.textIsUsable(invoiceText)
          : (invoiceText.replace(/[^A-Za-z0-9]/g, '').length >= 40);

        if (!usable) {
          if (!window.NeoQcInvoiceOcr) {
            setInvoiceStatus('❌ This PDF has no readable text and the OCR module is not loaded.', 'error');
            return;
          }
          importInvoiceBtn.textContent = '⏳ Reading invoice (OCR)…';
          setInvoiceStatus('This invoice has no extractable text — reading it visually with OCR. This can take 10–30 seconds…', 'info');
          try {
            invoiceText = await window.NeoQcInvoiceOcr.extractTextByOcr(filePath, (status, progress) => {
              const pct = progress != null ? ` ${Math.round(progress * 100)}%` : '';
              setInvoiceStatus(`OCR: ${status}${pct}…`, 'info');
            });
          } catch (ocrErr) {
            console.error('OCR failed:', ocrErr);
            setInvoiceStatus('❌ OCR failed: ' + ocrErr.message, 'error');
            return;
          }
        }

        if (!invoiceText || !invoiceText.trim()) {
          setInvoiceStatus('⚠️ Could not read any text from this invoice, even with OCR. If it is a scanned photo, try a clearer scan.', 'warn');
          return;
        }

        const build = window.NeoQcInvoiceImport.buildFromInvoice(invoiceText, catalogMatcher, {});
        if (!Object.keys(build.results).length) {
          setInvoiceStatus('⚠️ No recognizable PC components were found in this invoice. You can still type them in manually. (Scanned/image-only PDFs have no extractable text.)', 'warn');
          return;
        }

        const summary = applyInvoiceBuild(build);
        renderConfigSynergy(); // surface any socket/RAM mismatch from the imported build

        // Build a readable summary of what got filled, its price, and what needs a look.
        const rupee = (n) => (n != null ? '₹' + Math.round(n).toLocaleString('en-IN') : '—');
        let priceTotal = 0;
        const line = (icon, item) => {
          const e = item.entry;
          if (e.priceInr != null) priceTotal += e.priceInr;
          const priceStr = e.priceInr != null
            ? ` — <strong>${rupee(e.priceInr)}</strong>${e.priceSource === 'catalog' ? ' <span style="opacity:0.6;">(catalog est.)</span>' : ''}`
            : '';
          const conf = e.confidence ? ` <span style="opacity:0.6;">(${Math.round(e.confidence * 100)}% match)</span>` : '';
          return `<div style="margin-top:4px;">${icon} <strong>${catLabel[item.category] || item.category}:</strong> ${e.displayName || e.matchedName}${priceStr}${conf}</div>`;
        };
        let html = `<strong>✓ Auto-filled ${summary.filled.length + summary.review.length + summary.manual.length} field(s) from the invoice.</strong>`;
        summary.filled.forEach(it => { html += line('✅', it); });
        if (summary.review.length) {
          html += `<div style="margin-top:8px;"><strong>Please verify these lower-confidence matches:</strong></div>`;
          summary.review.forEach(it => { html += line('🟡', it); });
        }
        if (summary.manual.length) {
          html += `<div style="margin-top:8px;"><strong>Not found in catalog — filled as typed on the invoice:</strong></div>`;
          summary.manual.forEach(it => { html += line('✏️', it); });
        }
        html += `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed currentColor;"><strong>Components subtotal (from invoice): ${rupee(priceTotal)}</strong></div>`;
        if (summary.skipped.length) {
          html += `<div style="margin-top:8px; opacity:0.75;">Skipped (marked awaiting): ${summary.skipped.map(c => catLabel[c] || c).join(', ')}</div>`;
        }
        html += `<div style="margin-top:8px; opacity:0.7; font-size:0.72rem;">Prices are the per-unit rate read off the invoice. Review every field before saving — invoice wording is matched to the catalog automatically, but always confirm it's the right part.</div>`;
        const kind = (summary.review.length || summary.manual.length) ? 'warn' : 'ok';
        setInvoiceStatus(html, kind);
      } catch (err) {
        console.error('Invoice import failed:', err);
        setInvoiceStatus('❌ Invoice import failed: ' + err.message, 'error');
      } finally {
        importInvoiceBtn.disabled = false;
        importInvoiceBtn.textContent = oldText;
      }
    });
  }

  // Awaiting Components v2 — multi-part chip UI linked to target spec fields.
  // Toggle: show/hide the editor. When unchecked all chips are dropped and
  // any target spec fields we had disabled are re-enabled.
  const componentsToggle = document.getElementById('form-missing-components-toggle');
  const awaitingEditor = document.getElementById('awaiting-components-editor');
  componentsToggle.addEventListener('change', () => {
    if (componentsToggle.checked) {
      awaitingEditor.classList.remove('hidden');
    } else {
      awaitingEditor.classList.add('hidden');
      awaitingComponentsList.length = 0;
      renderAwaitingChips();
    }
  });

  const addAwaitingBtn = document.getElementById('btn-add-awaiting');
  const awaitingCatSelect = document.getElementById('awaiting-category-select');
  const awaitingNoteInput = document.getElementById('awaiting-note-input');
  if (addAwaitingBtn) {
    addAwaitingBtn.addEventListener('click', () => {
      const category = awaitingCatSelect.value;
      const note = awaitingNoteInput.value.trim();
      // Prevent duplicate category chips — one awaiting entry per category.
      if (category !== 'other' && awaitingComponentsList.some(a => a.category === category)) {
        alert(`${category.toUpperCase()} is already listed as awaiting. Remove the existing entry first if you want to change it.`);
        return;
      }
      awaitingComponentsList.push({ category, note: note || null });
      awaitingNoteInput.value = '';
      renderAwaitingChips();
    });
  }
  // Enter in the note field triggers Add
  if (awaitingNoteInput) {
    awaitingNoteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addAwaitingBtn.click(); }
    });
  }

  // Component condition / damage report — add DOA/damaged part.
  const addDamageBtn = document.getElementById('btn-add-damage');
  const damageCatSelect = document.getElementById('damage-category-select');
  const damageCondSelect = document.getElementById('damage-condition-select');
  const damageNoteInput = document.getElementById('damage-note-input');
  if (addDamageBtn) {
    addDamageBtn.addEventListener('click', () => {
      const category = damageCatSelect.value;
      const condition = damageCondSelect.value;
      const note = damageNoteInput.value.trim();
      damagedComponentsList.push({ category, condition, note: note || null });
      damageNoteInput.value = '';
      renderDamagedComponents();
    });
  }
  if (damageNoteInput) {
    damageNoteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addDamageBtn.click(); }
    });
  }

  // Background compatibility check — re-run (debounced) whenever the CPU,
  // motherboard, or RAM field changes.
  let _synergyTimer = null;
  const _synergyDebounced = () => {
    if (_synergyTimer) clearTimeout(_synergyTimer);
    _synergyTimer = setTimeout(renderConfigSynergy, 250);
  };
  ['form-spec-cpu', 'form-spec-mobo', 'form-spec-ram'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _synergyDebounced);
  });

  // Lock transitions checker on physical build checkbox clicks
  const buildCheckboxes = ['check-cpu-ram-ssd', 'check-mobo-case', 'check-cooler', 'check-cables', 'check-posted'];
  buildCheckboxes.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      let count = 0;
      buildCheckboxes.forEach(cid => {
        if (document.getElementById(cid).checked) count++;
      });
      const pct = Math.round((count / 5) * 100);
      updateFormLockStates(pct);
    });
  });

  // Autocomplete standard checks button
  document.getElementById('btn-qc-check-all').addEventListener('click', () => {
    const qcIds = [
      'qc-phys-cabinet', 'qc-phys-motherboard', 'qc-phys-ram', 'qc-phys-screws',
      'qc-soft-windows', 'qc-soft-drivers', 'qc-soft-bios',
      'qc-port-usb', 'qc-port-video', 'qc-port-audio', 'qc-port-wifi'
    ];
    qcIds.forEach(id => {
      document.getElementById(id).checked = true;
    });
  });

  // Client exit (takes client back to selector screen)
  document.getElementById('btn-client-exit').addEventListener('click', () => {
    switchScreen('selector');
  });

  // Staff exit
  const staffExit = document.getElementById('btn-staff-exit');
  if (staffExit) {
    staffExit.addEventListener('click', () => {
      switchScreen('selector');
    });
  }

  document.getElementById('btn-client-refresh').addEventListener('click', () => {
    const currentId = document.getElementById('client-ticket-select').value;
    populateClientTicketSelect(currentId);
    handleClientTicketSelect();
  });
  document.getElementById('client-ticket-select').addEventListener('change', handleClientTicketSelect);

  // Print button directly in the modal footer
  document.getElementById('btn-print-report').addEventListener('click', () => {
    if (editingTicketId) {
      triggerPrintReport(editingTicketId);
    }
  });

  // Save as PDF button directly in the modal footer
  document.getElementById('btn-save-pdf').addEventListener('click', () => {
    if (editingTicketId) {
      triggerSavePdf(editingTicketId);
    }
  });

  // Admin Quality Control Checklist - Windows Activation License Auto-Detect
  const btnAdminDetect = document.getElementById('btn-admin-detect-license');
  if (btnAdminDetect) {
    btnAdminDetect.addEventListener('click', async () => {
      btnAdminDetect.textContent = 'Scanning...';
      btnAdminDetect.disabled = true;
      try {
        const result = await ipcRenderer.invoke('sys:check-win');
        const winState = result.activated ? 'Activated' : 'Not Activated';
        const winKey = result.productKey || '--';
        
        const statusBadge = document.getElementById('modal-activation-status');
        if (statusBadge) {
          statusBadge.textContent = winState;
          statusBadge.className = `badge ${result.activated ? 'green' : 'red'}`;
        }
        
        const keyBadge = document.getElementById('modal-activation-key');
        if (keyBadge) {
          keyBadge.textContent = winKey;
          // v1.4.5 — Digital License placeholder warning (see the
          // client-side handler for the same annotation). Prevents the
          // shared Microsoft placeholder key from being saved as if it
          // were the tech's real retail key.
          if (result.keyDetail && result.keyDetail.isDigitalLicensePlaceholder) {
            keyBadge.style.color = '#b8860b';
            keyBadge.title = 'Digital License placeholder — this is a shared Microsoft key, not your real retail key. Get the real one from account.microsoft.com › Devices or your install notes.';
            var container = keyBadge.parentElement;
            if (container && !container.querySelector('.win-key-placeholder-note')) {
              var note = document.createElement('div');
              note.className = 'win-key-placeholder-note';
              note.style.cssText = 'margin-top:4px;font-size:0.7rem;color:#b8860b;font-family:inherit;';
              note.textContent = '⚠ Placeholder key — real retail key on account.microsoft.com';
              container.appendChild(note);
            }
          } else {
            keyBadge.style.color = '';
            keyBadge.title = '';
            var existingNote = keyBadge.parentElement && keyBadge.parentElement.querySelector('.win-key-placeholder-note');
            if (existingNote) existingNote.remove();
          }
        }

        if (result.activated) {
          document.getElementById('qc-soft-windows').checked = true;
        }
      } catch (e) {
        console.error('Error auto-detecting Windows license:', e);
      } finally {
        btnAdminDetect.textContent = 'Auto-Detect';
        btnAdminDetect.disabled = false;
      }
    });
  }

  // Modal automated diagnostics run button
  document.getElementById('btn-modal-run-diagnostics').addEventListener('click', async () => {
    await executeDiagnosticsWorkflow(true);
  });

  // Compute Price-to-Performance. v1.4.4 — runs pure-JS via ppi-sync.js first
  // (no Python required, works on every build-room PC — the "no python
  // installed" field bug is fixed here). Falls back to the legacy Python
  // ppi:compute IPC only if the JS deps aren't loaded (defensive; the
  // packaged app always ships ppi.js + ppi-sync.js now).
  const ppiBtn = document.getElementById('btn-compute-ppi');
  if (ppiBtn) {
    ppiBtn.addEventListener('click', async () => {
      if (!editingTicketId) {
        alert('Save the ticket first — PPI needs a stored ticket with specs.');
        return;
      }
      const useCaseSel = document.getElementById('modal-ppi-usecase');
      const useCase = useCaseSel ? useCaseSel.value : 'gaming-1440p';
      ppiBtn.disabled = true;
      ppiBtn.textContent = 'Computing…';
      try {
        const ticket = appState.tickets.find(t => t.id === editingTicketId);
        var ok = false;
        if (window.NeoQcPpiSync && window.NeoQcPpi && catalogMatcher && ticket && ticket.specs) {
          try {
            var ticketPrices = Object.assign({}, ticket.specPrices || (ticket.specs && ticket.specs.__prices) || {});
            // Merge in live form picks (invoice auto-fill or manual selection),
            // so a real price the tech just set is used even before re-saving —
            // kills spurious "no price on file" flags on the PPI panel.
            var _fieldToCat = { 'form-spec-cpu': 'cpu', 'form-spec-gpu': 'gpu', 'form-spec-ram': 'ram', 'form-spec-storage': 'storage', 'form-spec-psu': 'psu', 'form-spec-mobo': 'motherboard', 'form-spec-cooler-model': 'cooler', 'form-spec-case': 'case' };
            Object.keys(_fieldToCat).forEach(function (fid) {
              var m = specFieldMatches[fid];
              if (m && m.priceInr != null) ticketPrices[_fieldToCat[fid]] = m.priceInr;
            });
            const jsRes = await window.NeoQcPpiSync.computePpi({
              ticketSpecs: ticket.specs,
              catalogMatcher: catalogMatcher,
              useCase: useCase,
              ticketPrices: ticketPrices,
              // v1.4.5 — pass the fetch bridge + supabase client so missing
              // prices get auto-filled from a live retailer scrape before
              // scoring. Kills the persistent "no price on file" flag when
              // the internet has the answer.
              fetchUrl: function (url) { return ipcRenderer.invoke('catalog:fetch-url', { url: url }); },
              supabaseClient: supabaseClient
            });
            if (jsRes && jsRes.success) {
              // Render straight from the computed payload — do NOT depend on a
              // Supabase round-trip to show the result. Previously we upserted
              // to ticket_ppi then re-read it via loadAndRenderPpi(); if that
              // write/read failed or lagged, the panel rendered null and it
              // looked like "PPI didn't compute / no prices". Now the panel
              // shows the fresh result immediately; Supabase is best-effort.
              ppiCacheByTicket[editingTicketId] = jsRes.payload;
              const ppiPanelEl = document.getElementById('modal-ppi-panel');
              if (ppiPanelEl && window.NeoQcDiagnosticsRender) {
                ppiPanelEl.innerHTML = window.NeoQcDiagnosticsRender.renderPpiPanel(jsRes.payload);
              }
              if (supabaseClient) {
                window.NeoQcPpiSync.upsertTicketPpi(supabaseClient, editingTicketId, jsRes.payload)
                  .catch(e => console.warn('ticket_ppi upsert failed (panel already shown):', e.message));
              }
              ok = true;
            } else if (jsRes && jsRes.error) {
              // Real error (e.g. no spec matched). Do NOT silently fall back
              // to Python — the user needs to see this so they can fix specs.
              alert('PPI compute failed: ' + jsRes.error);
              return;
            }
          } catch (e) {
            console.error('JS PPI failed, falling back to Python:', e);
          }
        }
        if (!ok) {
          const res = await ipcRenderer.invoke('ppi:compute', { ticketId: editingTicketId, useCase });
          if (res && res.success) {
            await loadAndRenderPpi(editingTicketId);
          } else {
            alert('PPI compute failed: ' + ((res && res.error) || 'unknown error'));
          }
        }
      } catch (e) {
        alert('PPI compute failed: ' + e.message);
      } finally {
        ppiBtn.disabled = false;
        ppiBtn.textContent = 'Compute Price-Performance';
      }
    });
  }

  // Settings executable path browsers
  const setupPathBrowser = (btnId, inputId) => {
    document.getElementById(btnId).addEventListener('click', async () => {
      const pathVal = await ipcRenderer.invoke('dialog:open-file', [{ name: 'Executables', extensions: ['exe'] }]);
      if (pathVal) {
        document.getElementById(inputId).value = pathVal;
      }
    });
  };
  setupPathBrowser('btn-select-path-hwinfo', 'settings-path-hwinfo');
  setupPathBrowser('btn-select-path-cinebench', 'settings-path-cinebench');
  setupPathBrowser('btn-select-path-furmark', 'settings-path-furmark');
  setupPathBrowser('btn-select-path-prime95', 'settings-path-prime95');
  setupPathBrowser('btn-select-path-ssd-utility', 'settings-path-ssd-utility');

  // Welcome, Client settings triggers
  document.getElementById('btn-client-show-settings').addEventListener('click', openSettingsModal);
  const welcomeShowSettings = document.getElementById('btn-welcome-show-settings');
  if (welcomeShowSettings) {
    welcomeShowSettings.addEventListener('click', openSettingsModal);
  }

  // Backup Database (JSON) export
  document.getElementById('btn-settings-backup').addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neoqc_backup_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to export backup: " + err.message);
    }
  });

  // Restore Database (JSON) upload reader
  const btnRestore = document.getElementById('btn-settings-restore');
  const restoreFileInput = document.getElementById('input-settings-restore-file');
  if (btnRestore && restoreFileInput) {
    btnRestore.addEventListener('click', () => {
      restoreFileInput.click();
    });
    restoreFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (parsed && typeof parsed === 'object') {
            if (confirm("Are you sure you want to restore this backup? This will overwrite your current local database data.")) {
              // Ensure critical fields exist
              if (!parsed.tickets) parsed.tickets = [];
              if (!parsed.technicians) parsed.technicians = ["Adhil", "Amal", "Ananthakrishnan", "Athul"];
              if (!parsed.settings) parsed.settings = appState.settings;

              appState = parsed;
              initPpiTuning(); // re-seed/apply PPI tuning from the restored settings
              await saveDatabase();
              renderDashboard();
              alert("Database restored successfully!");
              openSettingsModal(); // Refresh modal
            }
          } else {
            alert("Invalid backup file structure.");
          }
        } catch (err) {
          alert("Error parsing backup JSON: " + err.message);
        }
      };
      reader.readAsText(file);
      restoreFileInput.value = '';
    });
  }

  // Wipe Database reset
  const btnWipe = document.getElementById('btn-settings-wipe');
  if (btnWipe) {
    btnWipe.addEventListener('click', async () => {
      if (confirm("🚨 WARNING: This will delete ALL tickets, custom technicians, and settings. Are you absolutely sure?")) {
        appState = {
          tickets: [],
          technicians: ["Adhil", "Amal", "Ananthakrishnan", "Athul"],
          settings: {
            supabaseUrl: "https://ggsxkhenzdhaachubrsc.supabase.co", 
            supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo", 
            pathHwInfo: "", 
            pathCinebench: "",
            pathFurmark: "",
            pathPrime95: "",
            pathSsdUtility: "",
            isMaster: false,
            autoDetectHw: false,
            accentColor: "pink",
            cpuMaxTemp: 85,
            gpuMaxTemp: 80,
            minSsdSpeed: 3000,
            minSsdWrite: 2500,
            minCinebench: 10000,
            minFurmark: 5000,
            defaultTestDuration: "60",
            autoPdf: false,
            soundEnabled: true,
            disableQcLock: false,
            defaultTech: "",
            sortBy: "deadline",
            shopName: "Neo Tokyo Kochi",
            contactInfo: "kochi@neotokyo.in"
          }
        };
        initPpiTuning(); // seed default PPI tuning into the fresh settings
        await saveDatabase();
        renderDashboard();
        alert("Database has been factory reset.");
        openSettingsModal();
      }
    });
  }

  // Filters and search fields triggers
  document.getElementById('search-input').addEventListener('input', renderDashboard);
  document.getElementById('filter-status').addEventListener('change', renderDashboard);
  document.getElementById('filter-tech').addEventListener('change', renderDashboard);

  // Collapsible Completed / Passed Systems — gives active tickets more room when
  // there are many. Remembers the collapsed state in settings.
  const archiveToggle = document.getElementById('archive-toggle');
  if (archiveToggle) {
    const slab = archiveToggle.closest('.archive-slab');
    if (slab && appState.settings && appState.settings.archiveCollapsed) {
      slab.classList.add('collapsed');
      archiveToggle.setAttribute('aria-expanded', 'false');
    }
    archiveToggle.addEventListener('click', async () => {
      if (!slab) return;
      const collapsed = slab.classList.toggle('collapsed');
      archiveToggle.setAttribute('aria-expanded', String(!collapsed));
      if (!appState.settings) appState.settings = {};
      appState.settings.archiveCollapsed = collapsed;
      try { await saveDatabase(); } catch (e) {}
    });
  }

  setupFormCalculations();
  setupSerialVerification();
  setupClientMode();

  // Secret technician shortcut to open settings (Ctrl + Alt + S)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
      openSettingsModal();
    }
    // Secret technician shortcut to access staff portal directly (Ctrl + Alt + P)
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'p') {
      switchScreen('staff');
    }
  });
}

// ==========================================================================
// SUPABASE SYNC SERVICE
// ==========================================================================
let supabaseClient = null;

function showConflictBanner() {
  const banner = document.getElementById('ticket-conflict-banner');
  if (banner) banner.classList.remove('hidden');
}

function hideConflictBanner() {
  const banner = document.getElementById('ticket-conflict-banner');
  if (banner) banner.classList.add('hidden');
}

function initSupabase() {
  if (window.supabase && appState.settings.supabaseUrl && appState.settings.supabaseAnonKey) {
    try {
      supabaseClient = window.supabase.createClient(
        appState.settings.supabaseUrl, 
        appState.settings.supabaseAnonKey
      );
      console.log("Supabase Client initialized successfully.");
      setupRealtimeListener();
      startCloudPolling();
      loadTicketQueryCounts();
    } catch (err) {
      console.error("Failed to initialize Supabase Client:", err);
      supabaseClient = null;
    }
  } else {
    console.log("Supabase cloud sync not active (no keys configured). Using local storage.");
    supabaseClient = null;
  }
}

// Polling fallback for cross-machine sync. The realtime listener above only
// fires if the Supabase `tickets` table is added to the `supabase_realtime`
// publication — which is OFF by default on many projects, so a test completed
// on the client PC would never reach the admin PC until an app restart. This
// timer re-pulls the cloud every 15s and refreshes whatever view is open, so
// completed diagnostics show up on the admin side within seconds regardless of
// the realtime replication setting. Cheap: one indexed SELECT on a small table.
let cloudPollTimer = null;
function startCloudPolling() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(async () => {
    if (!supabaseClient) return;
    // Don't clobber a technician mid-edit: skip the pull while the ticket
    // modal is open (the realtime path shows a conflict banner for that case).
    const modal = document.getElementById('ticket-modal');
    if (modal && modal.classList.contains('active')) return;
    try {
      await syncFromCloud();
      if (currentMode === 'staff') {
        renderDashboard();
      } else if (currentMode === 'client-console') {
        const sel = document.getElementById('client-ticket-select');
        const keep = sel ? sel.value : '';
        populateClientTicketSelect(keep);
      } else if (currentMode === 'client') {
        populateWelcomeTicketSelect();
      }
    } catch (e) {
      console.error('Cloud poll failed:', e);
    }
  }, 15000);
}

// Upload a single ticket to Supabase
async function syncTicketToCloud(ticket) {
  if (!supabaseClient) return;
  try {
    // The tickets table has no detected_specs column, but specs is JSONB and
    // already syncs — so nest the client-detected hardware inside specs.__detected
    // (mirrors the specs.__prices pattern). This is what makes the admin's
    // "System Hardware Specs (Verification)" panel receive what the testing
    // client auto-detected. Without this, detectedSpecs never left the client.
    const specsPayload = Object.assign({}, ticket.specs || {});
    if (ticket.detectedSpecs) specsPayload.__detected = ticket.detectedSpecs;

    const { error } = await supabaseClient
      .from('tickets')
      .upsert({
        id: ticket.id,
        created_at: ticket.createdAt,
        updated_at: ticket.updatedAt || new Date().toISOString(),
        type: ticket.type,
        customer_name: ticket.customerName,
        deadline: ticket.deadline,
        technician: ticket.technician,
        missing_components_toggle: ticket.missingComponentsToggle,
        missing_components: ticket.missingComponents,
        build_checks: ticket.buildChecks,
        qc_checks: ticket.qcChecks,
        diagnostics: ticket.diagnostics,
        serials: ticket.serials,
        specs: specsPayload,
        status: ticket.status,
        completed_at: ticket.completedAt
      });
    if (error) {
      console.error("Supabase upsert failed:", error.message);
    } else {
      console.log(`Synced ticket ${ticket.id} to cloud.`);
    }
  } catch (err) {
    console.error("Exception during ticket sync:", err);
  }
}

// Delete a single ticket from Supabase
async function deleteTicketFromCloud(ticketId) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from('tickets')
      .delete()
      .eq('id', ticketId);
    if (error) {
      console.error("Supabase delete failed:", error.message);
    } else {
      console.log(`Deleted ticket ${ticketId} from cloud.`);
    }
  } catch (err) {
    console.error("Exception during ticket deletion from cloud:", err);
  }
}

// Fetch all tickets from Supabase to sync local store
async function syncFromCloud() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('tickets')
      .select('*');
    
    if (error) {
      console.error("Failed to fetch cloud tickets:", error.message);
      return;
    }
    
    if (data) {
      const cloudIds = new Set(data.map(dbRow => dbRow.id));
      
      data.forEach(dbRow => {
        const ticket = {
          id: dbRow.id,
          createdAt: dbRow.created_at,
          updatedAt: dbRow.updated_at || dbRow.created_at,
          type: dbRow.type,
          customerName: dbRow.customer_name,
          deadline: dbRow.deadline,
          technician: dbRow.technician,
          missingComponentsToggle: dbRow.missing_components_toggle,
          missingComponents: dbRow.missing_components,
          buildChecks: dbRow.build_checks,
          qcChecks: dbRow.qc_checks,
          diagnostics: dbRow.diagnostics,
          serials: dbRow.serials,
          specs: dbRow.specs,
          specPrices: (dbRow.specs && dbRow.specs.__prices) || null,
          detectedSpecs: dbRow.detectedSpecs || (dbRow.specs && dbRow.specs.__detected) || null,
          damagedComponents: dbRow.damagedComponents || (dbRow.specs && dbRow.specs.__damaged) || null,
          status: dbRow.status,
          completedAt: dbRow.completed_at
        };

        const index = appState.tickets.findIndex(t => t.id === ticket.id);
        if (index === -1) {
          appState.tickets.push(ticket);
        } else {
          // Only overwrite local if cloud version is same age or newer
          const localTs = appState.tickets[index].updatedAt || appState.tickets[index].createdAt || '';
          const cloudTs = ticket.updatedAt || ticket.createdAt || '';
          if (cloudTs >= localTs) {
            appState.tickets[index] = ticket;
          }
        }
      });
      
      const oldLength = appState.tickets.length;
      // Filter out local tickets not present in cloud
      appState.tickets = appState.tickets.filter(t => cloudIds.has(t.id));
      
      await saveDatabase(); // Persist merged dataset locally
      console.log(`Pulled ${data.length} tickets, removed ${oldLength - appState.tickets.length} deleted tickets from Supabase cloud.`);
    }
  } catch (err) {
    console.error("Exception during database sync:", err);
  }
}

// Subscribe to Postgres changes on tickets table
function setupRealtimeListener() {
  if (!supabaseClient) return;
  try {
    supabaseClient
      .channel('public:tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, async payload => {
        console.log("Realtime event received:", payload);
        
        if (payload.eventType === 'DELETE') {
          const deletedId = payload.old.id;
          if (deletedId) {
            appState.tickets = appState.tickets.filter(t => t.id !== deletedId);
            await saveDatabase();
            if (currentMode === 'staff') {
              renderDashboard();
              if (editingTicketId === deletedId) {
                document.getElementById('ticket-modal').classList.remove('active');
                editingTicketId = null;
              }
            } else if (currentMode === 'client') {
              populateClientTicketSelect();
            }
          }
          return;
        }

        const dbRow = payload.new;
        if (dbRow) {
          const ticket = {
            id: dbRow.id,
            createdAt: dbRow.created_at,
            updatedAt: dbRow.updated_at || dbRow.created_at,
            type: dbRow.type,
            customerName: dbRow.customer_name,
            deadline: dbRow.deadline,
            technician: dbRow.technician,
            missingComponentsToggle: dbRow.missing_components_toggle,
            missingComponents: dbRow.missing_components,
            buildChecks: dbRow.build_checks,
            qcChecks: dbRow.qc_checks,
            diagnostics: dbRow.diagnostics,
            serials: dbRow.serials,
            specs: dbRow.specs,
            status: dbRow.status,
            completedAt: dbRow.completed_at
          };

          const index = appState.tickets.findIndex(t => t.id === ticket.id);
          if (index === -1) {
            appState.tickets.push(ticket);
          } else {
            appState.tickets[index] = ticket;
          }
          await saveDatabase();

          if (currentMode === 'staff') {
            renderDashboard();
            // If this ticket is currently open in the modal, show a banner instead of
            // clobbering whatever the technician is typing right now.
            if (editingTicketId === ticket.id && document.getElementById('ticket-modal').classList.contains('active')) {
              showConflictBanner();
            }
          } else if (currentMode === 'client') {
            populateWelcomeTicketSelect();
          } else if (currentMode === 'client-console') {
            populateClientTicketSelect(document.getElementById('client-ticket-select').value);
            const clientSelect = document.getElementById('client-ticket-select');
            if (clientSelect && clientSelect.value === ticket.id) {
              handleClientTicketSelect();
            }
          }
        }
      })
      .subscribe();
  } catch (err) {
    console.error("Failed to setup realtime listener:", err);
  }
}

// ==========================================================================
// ONLINE COMPETITOR & PRICE AUTO-PULL (PRICE-TO-PERFORMANCE ratio)
// ==========================================================================
function getCompetitorModel(detectedCpu) {
  const cpu = (detectedCpu || '').toLowerCase();
  if (cpu.includes('i9') || cpu.includes('14900') || cpu.includes('13900') || cpu.includes('7950') || cpu.includes('7900')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i9-14900K", desc: "Flagship Intel 24-Core CPU", cinebench: 39500 };
    } else {
      return { name: "AMD Ryzen 9 7950X", desc: "Flagship AMD 16-Core Processor", cinebench: 38000 };
    }
  }
  if (cpu.includes('i7') || cpu.includes('14700') || cpu.includes('13700') || cpu.includes('7800') || cpu.includes('7700') || cpu.includes('5800')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i7-14700K", desc: "Premium Intel 20-Core CPU", cinebench: 35000 };
    } else {
      return { name: "AMD Ryzen 7 7800X3D", desc: "Premium AMD 8-Core Gaming CPU", cinebench: 18500 };
    }
  }
  if (cpu.includes('i5') || cpu.includes('14400') || cpu.includes('14500') || cpu.includes('14600') || cpu.includes('13400') || cpu.includes('13500') || cpu.includes('13600') || cpu.includes('7600') || cpu.includes('7500') || cpu.includes('5600')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i5-14400", desc: "Mainstream Intel 10-Core CPU", cinebench: 14500 };
    } else {
      return { name: "AMD Ryzen 5 7600", desc: "Mainstream AMD 6-Core CPU", cinebench: 13800 };
    }
  }
  return { name: "AMD Ryzen 5 7600", desc: "Mainstream AMD 6-Core CPU", cinebench: 13800 };
}

async function getLiveCompetitorPrice(competitorName) {
  try {
    const query = `${competitorName} price in India INR`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Fetch failed");
    const html = await res.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const snippets = Array.from(doc.querySelectorAll('.result__snippet')).map(el => el.textContent);

    // Look for price patterns like ₹XX,XXX or Rs. XX,XXX or XX,XXX INR
    const priceRegex = /(?:₹|Rs\.?)\s?([0-9]{1,2},[0-9]{3})/i;
    for (const snippet of snippets) {
      const match = snippet.match(priceRegex);
      if (match) {
        return match[0].trim();
      }
    }

    // Fallback regex for USD if INR is not found
    const usdRegex = /\$\s?([0-9]{2,3})/i;
    for (const snippet of snippets) {
      const match = snippet.match(usdRegex);
      if (match) {
        const usdVal = parseInt(match[1].replace(/,/g, ''));
        const inrVal = Math.round(usdVal * 83);
        return `₹${inrVal.toLocaleString('en-IN')} (~$${usdVal})`;
      }
    }
  } catch (err) {
    console.error("Live competitor price search failed:", err);
  }
  return null;
}

function parsePriceNumeric(priceStr) {
  if (!priceStr) return 0;
  let clean = priceStr.split('(')[0];
  clean = clean.replace(/[^0-9]/g, '');
  return parseInt(clean) || 0;
}

// ==========================================================================
// SEED MOCK BUILD TICKETS
// ==========================================================================
function seedMockTickets() {
  const now = new Date();
  const getDeadline = (daysOffset) => {
    const d = new Date(now);
    d.setTime(d.getTime() + daysOffset * 24 * 60 * 60 * 1000);
    return d.toISOString();
  };

  appState.tickets = [
    {
      id: "t_mock1",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Ananthakrishnan (Test Build)",
      deadline: getDeadline(0.4), // Urgent (within 24 hrs!)
      technician: "Ananthakrishnan",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: false,
        cables: false,
        posted: false
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Ryzen 7 7800X3D", gpu: "RTX 4070 Ti Super", ram: "32 GB DDR5", storage: "2TB NVMe SSD" },
      status: "building",
      completedAt: null
    },
    {
      id: "t_mock2",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Adithya Nair",
      deadline: getDeadline(1.8),
      technician: "Adhil",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Core i9-14900K", gpu: "RTX 4090", ram: "64 GB DDR5", storage: "4TB Gen4 SSD" },
      status: "waiting_qc",
      completedAt: null
    },
    {
      id: "t_mock3",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Kochi VR Studio",
      deadline: getDeadline(3),
      technician: "Amal",
      missingComponentsToggle: true,
      missingComponents: "Gigabyte RTX 4080 Super",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: false,
        cooler: false,
        cables: false,
        posted: false
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Ryzen 9 7950X", gpu: "", ram: "64 GB DDR5", storage: "2TB Gen4 SSD" },
      status: "awaiting",
      completedAt: null
    },
    {
      id: "t_mock4",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Rahul Krishna",
      deadline: getDeadline(0.9),
      technician: "Athul",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: true,
        physMobo: true,
        physRam: true,
        physScrews: true,
        softWindows: true,
        softDrivers: false,
        softBios: true,
        portUsb: true,
        portVideo: true,
        portAudio: false,
        portWifi: true,
        wifiSpeed: 240,
        wifiRange: 90
      },
      diagnostics: {
        cpuTempMin: 35, cpuTempMax: 82, cpuTempAvg: 68,
        gpuTempMin: 40, gpuTempMax: 78, gpuTempAvg: 70,
        cinebench: 14200, furmark: 9400, ssdRead: 4900, ssdWrite: 3950, rivalConfigId: "1"
      },
      serials: { motherboard: "MB-84729104", ram: "RAM-984719", gpu: "GPU-7739102", ssd: "SSD-391023", cabinet: "CAB-99238" },
      specs: { cpu: "Ryzen 5 7600", gpu: "RTX 4060", ram: "16 GB DDR5", storage: "1TB SSD" },
      status: "qc_testing",
      completedAt: null
    },
    {
      id: "t_mock5",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Aswin Jose",
      deadline: getDeadline(-2), // Completed in the past
      technician: "Amal",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: true, physMobo: true, physRam: true, physScrews: true,
        softWindows: true, softDrivers: true, softBios: true,
        portUsb: true, portVideo: true, portAudio: true, portWifi: true,
        wifiSpeed: 450, wifiRange: 98
      },
      diagnostics: {
        cpuTempMin: 32, cpuTempMax: 70, cpuTempAvg: 55,
        gpuTempMin: 35, gpuTempMax: 68, gpuTempAvg: 60,
        cinebench: 12500, furmark: 8200, ssdRead: 3500, ssdWrite: 3000, rivalConfigId: "1"
      },
      serials: { motherboard: "MB-11239023", ram: "RAM-449231", gpu: "GPU-2239102", ssd: "SSD-449102", cabinet: "CAB-55102" },
      specs: { cpu: "Core i5-13400", gpu: "RTX 3060", ram: "16 GB DDR4", storage: "1TB SSD" },
      status: "completed",
      completedAt: new Date(Date.now() - 48*60*60*1000).toISOString()
    }
  ];
}

// ==========================================================================
// REAL-TIME DIAGNOSTICS LOGGING & TELEMETRY
// ==========================================================================

function appendConsoleLine(boxId, text) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'console-line';
  
  // Format line style based on contents
  if (text.includes('[RAM Error]') || text.includes('[Error]')) {
    line.style.color = 'var(--status-urgent)';
    line.style.fontWeight = 'bold';
  } else if (text.includes('[RAM]')) {
    line.style.color = 'var(--status-testing)';
  } else if (text.includes('completed') || text.includes('success') || text.includes('Passed') || text.includes('completed.')) {
    line.style.color = 'var(--status-completed)';
  } else if (text.includes('Launching') || text.includes('Spawning') || text.includes('Starting') || text.includes('Initiating')) {
    line.style.color = '#38bdf8'; // light blue
  }
  
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function updateTempBar(valId, barId, tempVal) {
  const valEl = document.getElementById(valId);
  const barEl = document.getElementById(barId);
  if (tempVal === undefined || tempVal === null) return;
  
  if (valEl) valEl.textContent = `${tempVal}°C`;
  if (barEl) {
    // Scale temp from 30 to 100
    const pct = Math.min(100, Math.max(0, ((tempVal - 30) / (100 - 30)) * 100));
    barEl.style.width = `${pct}%`;
    
    // Color thresholds
    barEl.style.background = 'var(--status-completed)'; // Cool (under 60)
    if (tempVal >= 80) {
      barEl.style.background = 'var(--status-urgent)'; // Hot
    } else if (tempVal >= 60) {
      barEl.style.background = 'var(--status-awaiting)'; // Warm
    }
  }
}

// OTA update status pill (driven by autoUpdater events forwarded from main.js)
ipcRenderer.on('update:status', (event, data) => {
  const pill = document.getElementById('update-status-pill');
  if (!pill) return;

  pill.classList.remove('is-available', 'is-downloading', 'is-ready', 'is-error');
  switch (data.status) {
    case 'checking':
      pill.style.display = 'inline-block';
      pill.textContent = 'Checking for updates…';
      break;
    case 'available':
      pill.style.display = 'inline-block';
      pill.classList.add('is-available');
      pill.textContent = `Update v${data.version} found`;
      break;
    case 'downloading':
      pill.style.display = 'inline-block';
      pill.classList.add('is-downloading');
      pill.textContent = `Downloading update… ${data.percent || 0}%`;
      break;
    case 'downloaded':
      pill.style.display = 'inline-block';
      pill.classList.add('is-ready');
      pill.textContent = `Update v${data.version} ready — restart to install`;
      break;
    case 'error':
      pill.style.display = 'inline-block';
      pill.classList.add('is-error');
      pill.textContent = 'Update check failed';
      break;
    case 'not-available':
    default:
      pill.style.display = 'none';
      break;
  }
});

// Pill click: download when update found, install when downloaded
document.addEventListener('click', (e) => {
  const pill = e.target.closest('#update-status-pill');
  if (!pill) return;
  if (pill.classList.contains('is-available')) {
    pill.textContent = 'Starting download…';
    ipcRenderer.send('update:download');
  } else if (pill.classList.contains('is-ready')) {
    ipcRenderer.send('update:install');
  }
});

// IPC Receivers for Real-time metrics
ipcRenderer.on('sys:diag-log', (event, text) => {
  let modifiedText = text;
  if (text.includes("SSD")) {
    modifiedText = `[PHASE: SSD SPEEDTEST] ` + text;
  } else if (text.includes("RAM")) {
    modifiedText = `[PHASE: RAM STRESSING] ` + text;
  } else if (text.includes("FurMark") || text.includes("GPU")) {
    modifiedText = `[PHASE: GPU STRESS] ` + text;
  } else if (text.includes("Cinebench") || text.includes("CPU")) {
    modifiedText = `[PHASE: CPU BENCHMARK] ` + text;
  } else if (text.includes("LibreHardwareMonitor")) {
    modifiedText = `[PHASE: SENSOR POLLING] ` + text;
  }
  appendConsoleLine('c-console-box', modifiedText);
  appendConsoleLine('modal-console-box', modifiedText);
});

ipcRenderer.on('sys:sensor-update', (event, data) => {
  if (data.cpuTemp) {
    updateTempBar('c-hud-cpu-temp-val', 'c-hud-cpu-temp-bar', data.cpuTemp);
    updateTempBar('modal-hud-cpu-temp-val', 'modal-hud-cpu-temp-bar', data.cpuTemp);
  }
  if (data.gpuTemp) {
    updateTempBar('c-hud-gpu-temp-val', 'c-hud-gpu-temp-bar', data.gpuTemp);
    updateTempBar('modal-hud-gpu-temp-val', 'modal-hud-gpu-temp-bar', data.gpuTemp);
  }
});

ipcRenderer.on('sys:ram-update', (event, data) => {
  const pct = data.percentDone || 0;
  const mb = data.allocatedMB || 0;
  const faults = data.faults || 0;
  const desc = `RAM: ${mb} MB under load${faults ? ` — ${faults} FAULT(S)` : ''}`;

  const cVal = document.getElementById('c-hud-ram-val');
  const cBar = document.getElementById('c-hud-ram-bar');
  const cDesc = document.getElementById('c-hud-ram-desc');
  if (cVal) cVal.textContent = `${pct}%`;
  if (cBar) cBar.style.width = `${pct}%`;
  if (cDesc) cDesc.textContent = desc;

  const mVal = document.getElementById('modal-hud-ram-val');
  const mBar = document.getElementById('modal-hud-ram-bar');
  const mDesc = document.getElementById('modal-hud-ram-desc');
  if (mVal) mVal.textContent = `${pct}%`;
  if (mBar) mBar.style.width = `${pct}%`;
  if (mDesc) mDesc.textContent = desc;
});

ipcRenderer.on('sys:prime95-update', (event, data) => {
  const elapsedMin = Math.floor((data.elapsedSec || 0) / 60);
  const totalMin = Math.round((data.durationSec || 0) / 60);
  const line = `[Prime95] Blend torture test running — ${elapsedMin}/${totalMin} min, ${data.workerCount || '?'} workers...`;
  ['c-prime95-panel', 'modal-prime95-panel'].forEach(id => {
    const panel = document.getElementById(id);
    if (panel && window.NeoQcDiagnosticsRender) {
      panel.innerHTML = window.NeoQcDiagnosticsRender.emptyState(line);
    }
  });
});

async function executeDiagnosticsWorkflow(isModal) {
  const prefix = isModal ? 'form-' : 'c-';
  const hudPrefix = isModal ? 'modal-' : 'c-';
  const btnId = isModal ? 'btn-modal-run-diagnostics' : 'btn-run-auto-diagnostics';
  const statusId = isModal ? 'modal-diagnostics-status' : 'c-diagnostics-status';
  const pulseId = isModal ? 'modal-console-pulse' : 'c-console-pulse';
  const boxId = isModal ? 'modal-console-box' : 'c-console-box';

  const btn = document.getElementById(btnId);
  const statusBox = document.getElementById(statusId);
  const pulseDot = document.getElementById(pulseId);
  const box = document.getElementById(boxId);

  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "⚡ Stress Testing...";

  if (pulseDot) {
    pulseDot.classList.remove('idle');
    pulseDot.classList.add('testing');
  }

  // Clear previous console outputs and set default starting log
  if (box) {
    box.innerHTML = '';
    appendConsoleLine(boxId, "[SYS] Initializing embedded diagnostics engine...");
    appendConsoleLine(boxId, "[SYS] Checking Administrator permissions... OK");
  }

  // Reset progress indicators
  updateTempBar(hudPrefix + 'hud-cpu-temp-val', hudPrefix + 'hud-cpu-temp-bar', 35);
  updateTempBar(hudPrefix + 'hud-gpu-temp-val', hudPrefix + 'hud-gpu-temp-bar', 38);
  
  const ramVal = document.getElementById(hudPrefix + 'hud-ram-val');
  const ramBar = document.getElementById(hudPrefix + 'hud-ram-bar');
  const ramDesc = document.getElementById(hudPrefix + 'hud-ram-desc');
  if (ramVal) ramVal.textContent = '0%';
  if (ramBar) ramBar.style.width = '0%';
  if (ramDesc) ramDesc.textContent = 'Initializing RAM worker...';

  const ssdVal = document.getElementById(hudPrefix + 'hud-ssd-val');
  const ssdBar = document.getElementById(hudPrefix + 'hud-ssd-bar');
  if (ssdVal) ssdVal.textContent = 'Testing...';
  if (ssdBar) ssdBar.style.width = '20%';

  // Hide SSD health card from any previous run
  const healthCardId = isModal ? 'modal-ssd-health-card' : 'c-ssd-health-card';
  const prevHealthCard = document.getElementById(healthCardId);
  if (prevHealthCard) prevHealthCard.classList.add('hidden');

  const durationSelectId = isModal ? 'modal-duration-select' : 'client-duration-select';
  const durationSelectEl = document.getElementById(durationSelectId);
  const duration = durationSelectEl ? parseInt(durationSelectEl.value) : 60;

  let timeRemaining = duration;
  if (statusBox) {
    statusBox.innerHTML = `Cinebench R23: <strong style="color: var(--status-testing)">Testing...</strong> | FurMark: <strong style="color: var(--status-testing)">Testing...</strong> | RAM: <strong style="color: var(--status-testing)">Testing...</strong> | ⏳ Time Remaining: <strong style="color: var(--primary-pink)">~${timeRemaining}s</strong>`;
  }

  const timerInterval = setInterval(() => {
    timeRemaining--;
    if (timeRemaining < 0) timeRemaining = 0;
    if (statusBox) {
      statusBox.innerHTML = `Cinebench R23: <strong style="color: var(--status-testing)">Testing...</strong> | FurMark: <strong style="color: var(--status-testing)">Testing...</strong> | RAM: <strong style="color: var(--status-testing)">Testing...</strong> | ⏳ Time Remaining: <strong style="color: var(--primary-pink)">~${timeRemaining}s</strong>`;
    }
  }, 1000);

  // Retrieve Cinebench useCase parameter from corresponding selector
  const useCaseSelectId = isModal ? 'modal-usecase-select' : 'client-usecase-select';
  const useCaseSelectEl = document.getElementById(useCaseSelectId);
  const useCase = useCaseSelectEl ? useCaseSelectEl.value : 'gaming';

  // Prime95 is opt-in with its own duration (15-30+ min), separate from the
  // fast Cinebench/FurMark/RAM duration above.
  const p95Prefix = isModal ? 'modal-' : 'c-';
  const runPrime95 = !!document.getElementById(p95Prefix + 'prime95-enable')?.checked;
  const prime95DurationEl = document.getElementById(p95Prefix + 'prime95-duration-select');
  const prime95Duration = prime95DurationEl ? parseInt(prime95DurationEl.value) : 1200;
  const prime95PanelId = p95Prefix + 'prime95-panel';
  const prime95Panel = document.getElementById(prime95PanelId);
  if (runPrime95 && prime95Panel && window.NeoQcDiagnosticsRender) {
    prime95Panel.innerHTML = window.NeoQcDiagnosticsRender.emptyState(
      `Prime95 running (Blend, CPU + RAM) — target ${Math.round(prime95Duration / 60)} min...`);
  }

  // Run diagnostics!
  const res = await ipcRenderer.invoke('sys:run-diagnostics', {
    ...appState.settings,
    useCase: useCase,
    duration: duration,
    runPrime95: runPrime95,
    prime95Duration: prime95Duration
  });

  clearInterval(timerInterval);

  btn.disabled = false;
  btn.textContent = "Run Stress Test & Auto-Fill";

  if (pulseDot) {
    pulseDot.classList.remove('testing');
    pulseDot.classList.add('idle');
  }

  if (!res.success) {
    if (statusBox) statusBox.innerHTML = `<span style="color: var(--status-urgent)">Error: ${res.error}</span>`;
    appendConsoleLine(boxId, `[SYS ERROR] Diagnostics failed: ${res.error}`);
    return;
  }

  // Populate actual inputs
  document.getElementById(prefix + 'cpu-temp-min').value = res.cpuTempMin || '';
  document.getElementById(prefix + 'cpu-temp-max').value = res.cpuTempMax || '';
  document.getElementById(prefix + 'cpu-temp-avg').value = res.cpuTempAvg || '';

  document.getElementById(prefix + 'gpu-temp-min').value = res.gpuTempMin || '';
  document.getElementById(prefix + 'gpu-temp-max').value = res.gpuTempMax || '';
  document.getElementById(prefix + 'gpu-temp-avg').value = res.gpuTempAvg || '';

  document.getElementById(prefix + 'cinebench-score').value = res.cinebenchScore || '';
  document.getElementById(prefix + 'furmark-score').value = res.furmarkScore || '';
  document.getElementById(prefix + 'ssd-read').value = res.ssdRead || '';
  document.getElementById(prefix + 'ssd-write').value = res.ssdWrite || '';

  // Apply visual flash success highlight on the updated inputs
  const inputsToFlash = ['cpu-temp-min', 'cpu-temp-max', 'cpu-temp-avg', 'gpu-temp-min', 'gpu-temp-max', 'gpu-temp-avg', 'cinebench-score', 'furmark-score', 'ssd-read', 'ssd-write'];
  inputsToFlash.forEach(suffix => {
    const el = document.getElementById(prefix + suffix);
    if (el) {
      el.classList.add('flash-success');
      setTimeout(() => el.classList.remove('flash-success'), 1500);
    }
  });

  // Update HUD
  updateTempBar(hudPrefix + 'hud-cpu-temp-val', hudPrefix + 'hud-cpu-temp-bar', res.cpuTempAvg);
  updateTempBar(hudPrefix + 'hud-gpu-temp-val', hudPrefix + 'hud-gpu-temp-bar', res.gpuTempAvg);

  const ramSummary = res.ramError
    ? `RAM test could not run: ${res.ramError}`
    : (res.ramAllocatedMB != null
        ? `${res.ramAllocatedMB} MB stressed, ${res.ramFaults || 0} fault(s) — ${res.ramPassed ? 'passed' : 'FAILED'}`
        : (res.ramPassed ? 'RAM test passed successfully.' : 'RAM test failed!'));
  if (ramVal) ramVal.textContent = '100%';
  if (ramBar) ramBar.style.width = '100%';
  if (ramDesc) ramDesc.textContent = ramSummary;

  if (ssdVal) ssdVal.textContent = `${res.ssdRead} R / ${res.ssdWrite} W MB/s`;
  if (ssdBar) ssdBar.style.width = '100%';

  if (statusBox) {
    statusBox.innerHTML = `
      Cinebench R23: <strong style="color: var(--status-completed)">Completed (${res.cinebenchScore} pts)</strong> | 
      FurMark: <strong style="color: var(--status-completed)">Completed</strong> | 
      RAM: <strong style="color: ${res.ramPassed ? 'var(--status-completed)' : 'var(--status-urgent)'}">${res.ramPassed ? 'Passed' : 'Failed'}</strong>
    `;
  }

  appendConsoleLine(boxId, `[SYS] All stress tests completed successfully.`);
  appendConsoleLine(boxId, `[SYS] CPU avg ${res.cpuTempAvg}°C (min ${res.cpuTempMin}°C / max ${res.cpuTempMax}°C) over ${(res.cpuTempLog || []).length} samples.`);
  appendConsoleLine(boxId, `[SYS] GPU avg ${res.gpuTempAvg}°C (min ${res.gpuTempMin}°C / max ${res.gpuTempMax}°C) over ${(res.gpuTempLog || []).length} samples.`);
  appendConsoleLine(boxId, `[SYS] Cinebench R23: ${res.cinebenchScore} pts | FurMark: ${res.furmarkScore} pts.`);
  appendConsoleLine(boxId, `[SYS] SSD — Read: ${res.ssdRead} MB/s, Write: ${res.ssdWrite} MB/s.`);
  appendConsoleLine(boxId, `[SYS] RAM stress test: ${res.ramPassed ? "PASSED ✓" : "FAILED ✗"}${res.ramAllocatedMB != null ? ` (${res.ramAllocatedMB} MB, ${res.ramFaults || 0} faults)` : ''}.`);

  // Query SSD health
  appendConsoleLine(boxId, `[SYS] Querying SSD health via SMART data...`);
  let ssdHealth = null;
  try {
    ssdHealth = await ipcRenderer.invoke('sys:check-ssd-health');
    if (ssdHealth && !ssdHealth.error) {
      renderSsdHealthCard(isModal ? 'modal' : 'c', ssdHealth);
      const lifeStr = ssdHealth.lifeRemaining != null ? `${ssdHealth.lifeRemaining}% life remaining` : 'life data N/A';
      appendConsoleLine(boxId, `[SYS] SSD: ${ssdHealth.model || 'Unknown'} — ${ssdHealth.healthStatus || 'Unknown'} — ${lifeStr}.`);
    } else {
      appendConsoleLine(boxId, `[SYS] SSD health query returned no SMART data (drive may not support it).`);
    }
  } catch(e) {
    appendConsoleLine(boxId, `[SYS] SSD health query failed: ${e.message}`);
  }

  // Build the component passport (identity + health per component)
  appendConsoleLine(boxId, `[SYS] Building component passport (CPU / GPU / RAM / storage identity)...`);
  let componentPassport = null;
  try {
    const hwId = await ipcRenderer.invoke('sys:component-passport');
    if (hwId && !hwId.error) {
      componentPassport = buildComponentPassport(hwId, res, ssdHealth);
      const gridId = (isModal ? 'modal' : 'c') + '-passport-grid';
      const gridEl = document.getElementById(gridId);
      if (gridEl && window.NeoQcDiagnosticsRender) {
        gridEl.innerHTML = window.NeoQcDiagnosticsRender.renderPassportGrid(componentPassport);
      }
      appendConsoleLine(boxId, `[SYS] Passport: ${componentPassport.cpu.model} | ${componentPassport.ram.totalGB}GB ${componentPassport.ram.ddrGen || 'RAM'} | ${componentPassport.storage.model || 'storage'}.`);
    } else {
      appendConsoleLine(boxId, `[SYS] Component passport query failed (${(hwId && hwId.error) || 'unknown'}).`);
    }
  } catch(e) {
    appendConsoleLine(boxId, `[SYS] Component passport failed: ${e.message}`);
  }

  // Auto-Save Diagnostics back into the loaded ticket
  const ticketId = isModal
    ? (document.getElementById('form-ticket-id').value || editingTicketId)
    : document.getElementById('client-ticket-select').value;

  if (ticketId) {
    const ticketIndex = appState.tickets.findIndex(t => t.id === ticketId);
    if (ticketIndex !== -1) {
      const ticket = appState.tickets[ticketIndex];
      ticket.diagnostics.cpuTempMin = res.cpuTempMin || null;
      ticket.diagnostics.cpuTempMax = res.cpuTempMax || null;
      ticket.diagnostics.cpuTempAvg = res.cpuTempAvg || null;
      ticket.diagnostics.cpuTempLog = res.cpuTempLog || null;
      ticket.diagnostics.gpuTempMin = res.gpuTempMin || null;
      ticket.diagnostics.gpuTempMax = res.gpuTempMax || null;
      ticket.diagnostics.gpuTempAvg = res.gpuTempAvg || null;
      ticket.diagnostics.gpuTempLog = res.gpuTempLog || null;
      ticket.diagnostics.cinebench = res.cinebenchScore || null;
      ticket.diagnostics.furmark = res.furmarkScore || null;
      ticket.diagnostics.ssdRead = res.ssdRead || null;
      ticket.diagnostics.ssdWrite = res.ssdWrite || null;
      if (ssdHealth && !ssdHealth.error) ticket.diagnostics.ssdHealth = ssdHealth;

      // RAM verdict + detail come from the quick sustained stress test that
      // ALWAYS runs. Previously these were only written when the opt-in Prime95
      // torture test ran, so a normal diagnostics pass left the report's RAM
      // row blank even though the RAM test had executed.
      if (res.ramError) {
        ticket.diagnostics.ramStress = 'failed';
        ticket.diagnostics.ramDetail = `RAM stress could not run: ${res.ramError}`;
      } else if (res.ramAllocatedMB != null) {
        ticket.diagnostics.ramStress = res.ramPassed ? 'passed' : 'failed';
        ticket.diagnostics.ramDetail =
          `${res.ramAllocatedMB} MB stressed for ${res.ramSeconds || 0}s — ${res.ramFaults || 0} fault(s)`;
      }

      // Prime95 (opt-in) is the deeper CPU+RAM torture test. When it runs it
      // OVERRIDES the quick RAM verdict with its longer, stronger result.
      if (res.prime95) {
        ticket.diagnostics.prime95 = res.prime95;
        if (res.prime95.overallResult && res.prime95.overallResult !== 'not-run') {
          ticket.diagnostics.ramStress = res.prime95.overallResult === 'pass' ? 'passed' : 'failed';
          const errorCount = (res.prime95.workers || []).reduce((sum, w) => sum + (w.errors || 0), 0);
          ticket.diagnostics.ramDetail = `Prime95 Blend, ${res.prime95.durationActualSec || 0}s, ${errorCount} error(s) across ${res.prime95.workerCount || 0} workers`;
        }
      }
      if (prime95Panel && window.NeoQcDiagnosticsRender) {
        prime95Panel.innerHTML = window.NeoQcDiagnosticsRender.renderPrime95Panel(res.prime95);
      }
      if (componentPassport) {
        ticket.diagnostics.componentPassport = componentPassport;
      }

      if (!isModal) {
        if (res.ramPassed) {
          ticket.qcChecks.physCabinet = true;
          ticket.qcChecks.softDrivers = true;
          ticket.qcChecks.softBios = true;
          ticket.qcChecks.portUsb = true;
          ticket.qcChecks.portVideo = true;
          ticket.qcChecks.portAudio = true;
          ticket.qcChecks.portWifi = true;
        }
      }

      ticket.updatedAt = new Date().toISOString();
      appState.tickets[ticketIndex] = ticket;
      await saveDatabase();
      await syncTicketToCloud(ticket);
    }
  }

  if (isModal) {
    updateModalDiagnosticsStatus();
  } else {
    checkClientFormReady();
  }
}

// Render a ticket's SAVED diagnostics (passport / Prime95) into the modal
// panels when the ticket is opened — same shared renderers used everywhere.
function renderSavedDiagnosticsPanels(ticket) {
  const R = window.NeoQcDiagnosticsRender;
  if (!R) return;
  const d = (ticket && ticket.diagnostics) || {};
  const pp = document.getElementById('modal-passport-grid');
  if (pp) pp.innerHTML = d.componentPassport ? R.renderPassportGrid(d.componentPassport) : '';
  const p95 = document.getElementById('modal-prime95-panel');
  if (p95) p95.innerHTML = (d.prime95 && d.prime95.overallResult) ? R.renderPrime95Panel(d.prime95) : '';
}

// Fetch the precomputed PPI row for a ticket and render it (read-only; the
// math lives in ppi.py, invoked via the Compute button → ppi:compute IPC).
// Rows are cached here so the print report can include PPI without another
// network round-trip (and without polluting the persisted ticket object).
const ppiCacheByTicket = {};

async function loadAndRenderPpi(ticketId) {
  const panel = document.getElementById('modal-ppi-panel');
  const R = window.NeoQcDiagnosticsRender;
  if (!panel || !R) return;
  // Prefer an in-session computed result so a Supabase hiccup can't blank a
  // PPI that was just calculated. Falls through to the empty state otherwise.
  panel.innerHTML = R.renderPpiPanel(ppiCacheByTicket[ticketId] || null);
  if (!supabaseClient || !ticketId) return;
  try {
    const { data, error } = await supabaseClient
      .from('ticket_ppi').select('*').eq('ticket_id', ticketId).maybeSingle();
    if (!error && data) {
      ppiCacheByTicket[ticketId] = data;
      panel.innerHTML = R.renderPpiPanel(data);
      // Reflect the stored use case in the selector so recompute defaults to
      // what this ticket was last evaluated for.
      const sel = document.getElementById('modal-ppi-usecase');
      if (sel && data.use_cases && data.use_cases.length && [...sel.options].some(o => o.value === data.use_cases[0])) {
        sel.value = data.use_cases[0];
      }
    }
  } catch (e) {
    console.error('PPI load failed:', e);
  }
}

// SMBIOSMemoryType -> DDR generation (DMTF SMBIOS Memory Device type codes)
const SMBIOS_DDR_GEN = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' };

// Combine raw hardware identity (sys:component-passport) with this run's
// thermal/Prime95/SSD-health results into the diagnostics.componentPassport shape.
function buildComponentPassport(hwId, res, ssdHealth) {
  const settings = appState.settings || {};
  const cpuThrottleTemp = 95; // conservative thermal-throttle proxy, °C
  const gpuThrottleTemp = 90;

  const p95 = res && res.prime95 && res.prime95.overallResult !== 'not-run' ? res.prime95 : null;
  const p95Errors = p95 ? (p95.workers || []).reduce((s, w) => s + (w.errors || 0), 0) : null;

  const modules = ((hwId.ram && hwId.ram.modules) || []).map(m => ({
    manufacturer: m.manufacturer, partNumber: m.partNumber,
    capacityGB: m.capacityGB, speedMHz: m.speedMHz, slot: m.slot
  }));
  const smbiosTypes = ((hwId.ram && hwId.ram.modules) || []).map(m => m.smbiosType).filter(Boolean);
  const ddrGen = smbiosTypes.length ? (SMBIOS_DDR_GEN[smbiosTypes[0]] || `SMBIOS type ${smbiosTypes[0]}`) : null;

  const vramMB = hwId.gpu && hwId.gpu.vramMB;
  const vram = vramMB != null ? (vramMB >= 1024 ? `${Math.round(vramMB / 1024)} GB` : `${vramMB} MB`) : null;

  return {
    cpu: {
      model: hwId.cpu && hwId.cpu.model,
      cores: hwId.cpu && hwId.cpu.cores,
      threads: hwId.cpu && hwId.cpu.threads,
      baseClockMHz: hwId.cpu && hwId.cpu.baseClockMHz,
      boostClockMHz: null, // WMI MaxClockSpeed is base; boost is not reliably exposed
      tempMaxDuringTest: res ? res.cpuTempMax : null,
      throttled: res && res.cpuTempMax != null ? res.cpuTempMax >= cpuThrottleTemp : false,
      healthNote: p95 ? `Prime95 ${p95.overallResult.toUpperCase()} (${Math.round((p95.durationActualSec || 0) / 60)} min Blend)` : null
    },
    gpu: {
      model: hwId.gpu && hwId.gpu.model,
      vram: vram,
      driverVersion: hwId.gpu && hwId.gpu.driverVersion,
      tempMaxDuringTest: res ? res.gpuTempMax : null,
      throttled: res && res.gpuTempMax != null ? res.gpuTempMax >= gpuThrottleTemp : false,
      healthNote: null
    },
    ram: {
      modules: modules,
      totalGB: hwId.ram && hwId.ram.totalGB,
      ddrGen: ddrGen,
      errorsDuringPrime95: p95Errors,
      healthNote: p95
        ? (p95Errors > 0 ? `${p95Errors} error(s) during Prime95 Blend — investigate before handoff` : 'No errors during Prime95 Blend torture test')
        : 'Prime95 torture test not run'
    },
    storage: {
      model: (ssdHealth && ssdHealth.model) || (hwId.storage && hwId.storage.model),
      mediaType: (ssdHealth && ssdHealth.mediaType) || (hwId.storage && hwId.storage.mediaType),
      interface: hwId.storage && hwId.storage.busType,
      sizeGB: (ssdHealth && ssdHealth.sizeGB) || (hwId.storage && hwId.storage.sizeGB),
      wear: ssdHealth ? ssdHealth.wear : null,
      lifeRemaining: ssdHealth ? ssdHealth.lifeRemaining : null,
      powerOnHours: ssdHealth ? ssdHealth.powerOnHours : null,
      healthStatus: ssdHealth ? ssdHealth.healthStatus : null,
      readErrors: ssdHealth ? ssdHealth.readErrors : null,
      writeErrors: ssdHealth ? ssdHealth.writeErrors : null
    }
  };
}

function renderSsdHealthCard(prefix, h) {
  const card  = document.getElementById(prefix + '-ssd-health-card');
  const badge = document.getElementById(prefix + '-ssd-health-badge');
  const model = document.getElementById(prefix + '-ssd-health-model');
  const type  = document.getElementById(prefix + '-ssd-health-type');
  const life  = document.getElementById(prefix + '-ssd-health-life');
  const hours = document.getElementById(prefix + '-ssd-health-hours');
  const bar   = document.getElementById(prefix + '-ssd-health-bar');
  if (!card) return;

  card.classList.remove('hidden');

  const healthStatus = (h.healthStatus || 'Unknown').toLowerCase();
  const lifeRemaining = h.lifeRemaining;

  let tier = 'healthy';
  if (healthStatus.includes('warning') || (lifeRemaining != null && lifeRemaining < 30)) tier = 'warning';
  if (healthStatus.includes('unhealthy') || healthStatus.includes('failed') || (lifeRemaining != null && lifeRemaining < 10)) tier = 'critical';

  const badgeLabels = { healthy: '✓ Healthy', warning: '⚠ Warning', critical: '✕ Critical' };
  if (badge) { badge.textContent = badgeLabels[tier]; badge.className = `ssd-health-badge ${tier}`; }
  if (model) model.textContent = h.model || 'Unknown Drive';
  if (type)  type.textContent  = h.mediaType || 'SSD';
  if (life)  life.textContent  = lifeRemaining != null ? `${lifeRemaining}%` : 'N/A (no SMART)';
  // Distinguish "0 hours" (drive says so) from "not exposed by this controller"
  // — the v1.4.3 SSD probe labels the source so we can tell the difference.
  if (hours) {
    if (h.powerOnHours != null && h.powerOnHours > 0) {
      hours.textContent = `${h.powerOnHours.toLocaleString()} hrs`;
    } else if (h.powerOnHoursSource === 'not-exposed') {
      hours.textContent = 'Not reported by drive';
    } else {
      hours.textContent = 'N/A';
    }
  }

  const barPct = lifeRemaining != null ? Math.max(0, Math.min(100, lifeRemaining)) : 0;
  if (bar) {
    bar.style.width = `${barPct}%`;
    bar.className = `ssd-health-bar-fill${tier !== 'healthy' ? ' ' + tier : ''}`;
  }
}

// Accent Color Theme Applier
function applyAccentColor(color) {
  const root = document.documentElement;
  let primary = '#e7014e';
  let primaryRgb = '231, 1, 78';
  
  switch (color) {
    case 'red':
      primary = '#ef4444';
      primaryRgb = '239, 68, 68';
      break;
    case 'purple':
      primary = '#8b5cf6';
      primaryRgb = '139, 92, 246';
      break;
    case 'cyan':
      primary = '#06b6d4';
      primaryRgb = '6, 182, 212';
      break;
    case 'gold':
      primary = '#f59e0b';
      primaryRgb = '245, 158, 11';
      break;
    case 'green':
      primary = '#10b981';
      primaryRgb = '16, 185, 129';
      break;
    case 'pink':
    default:
      primary = '#e7014e';
      primaryRgb = '231, 1, 78';
      break;
  }
  root.style.setProperty('--primary-pink', primary);
  root.style.setProperty('--primary-pink-rgb', primaryRgb);
  
  const logoGrad = document.getElementById('logo-grad');
  if (logoGrad) {
    logoGrad.innerHTML = `
      <stop offset="0%" stop-color="${color === 'red' ? '#f87171' : color === 'purple' ? '#a78bfa' : color === 'cyan' ? '#22d3ee' : color === 'gold' ? '#fbbf24' : color === 'green' ? '#34d399' : '#ff1a75'}" />
      <stop offset="50%" stop-color="${primary}" />
      <stop offset="100%" stop-color="${color === 'red' ? '#b91c1c' : color === 'purple' ? '#6d28d9' : color === 'cyan' ? '#0891b2' : color === 'gold' ? '#d97706' : color === 'green' ? '#059669' : '#b3003b'}" />
    `;
  }
}

// Format Date to YYYY-MM-DDTHH:MM (UTC-based to prevent timezone shifting)
function formatDateTimeLocal(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    // Use UTC methods to avoid local timezone offset shifting the date when displayed
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  } catch (e) {
    return '';
  }
}

// ==========================================================================
// EVENT LOG SYSTEM
// ==========================================================================
// Creates a log entry object for the ticket event history
function createEventLogEntry(event, user) {
  return {
    timestamp: new Date().toISOString(),
    event,
    user: user || 'System'
  };
}

// Safely appends an event to a ticket's diagnostics.eventLog array
function addEventLog(ticket, event, user) {
  if (!ticket) return;
  if (!ticket.diagnostics) ticket.diagnostics = {};
  if (!ticket.diagnostics.eventLog || !Array.isArray(ticket.diagnostics.eventLog)) {
    ticket.diagnostics.eventLog = [];
  }
  ticket.diagnostics.eventLog.push(createEventLogEntry(event, user));
}

// Renders the event log timeline in the admin modal
function renderEventLog(ticket) {
  const container = document.getElementById('modal-event-log-timeline');
  if (!container) return;

  const events = (ticket && ticket.diagnostics && Array.isArray(ticket.diagnostics.eventLog))
    ? ticket.diagnostics.eventLog
    : [];

  if (events.length === 0) {
    container.innerHTML = `<div class="event-log-empty">No events recorded yet. Activity will appear here when the ticket is updated.</div>`;
    return;
  }

  // Render in reverse chronological order (newest first)
  const sorted = [...events].reverse();
  container.innerHTML = sorted.map((entry, i) => {
    const d = new Date(entry.timestamp);
    const timeStr = `${d.getUTCDate()}/${d.getUTCMonth()+1} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    const isRecent = i === 0;
    return `
      <div class="event-log-item${isRecent ? ' event-log-recent' : ''}">
        <div class="event-log-dot"></div>
        <div class="event-log-content">
          <div class="event-log-event">${entry.event}</div>
          <div class="event-log-meta">
            <span class="event-log-user">${entry.user || 'System'}</span>
            <span class="event-log-time">${timeStr} UTC</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function checkSpecsMatch() {
  const ticketId = document.getElementById('client-ticket-select').value;
  if (!ticketId) return;
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket || !detectedSpecs) return;

  // v1.4.4 fix — cross-check via token-set scoring instead of naive substring.
  // Retail names ("ASUS PRIME B650M-A WIFI DDR5 mATX Motherboard") and WMIC
  // detections ("PRIME B650M-A WIFI") share the model tokens but neither is a
  // strict substring of the other, so `.includes()` reported MISMATCH on
  // genuinely-matching builds. NeoQcMatcher.score() ignores vendor / noise
  // words, weights model numbers, and returns a 0–1 similarity we can gate on.
  var scoreFn = (window.NeoQcMatcher && window.NeoQcMatcher.score) || null;
  var tokenize = (window.NeoQcMatcher && window.NeoQcMatcher.tokenize) || null;

  function tokenMatch(target, detected) {
    if (!target) return true; // no target set → nothing to mismatch
    if (!detected) return false;
    var a = String(target).toLowerCase().trim();
    var b = String(detected).toLowerCase().trim();
    if (!a || !b) return !a;
    // Fast path: exact / substring hit (handles perfectly-typed specs).
    if (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
    if (!scoreFn || !tokenize) {
      // Fallback: any shared 4+ char word wins (still better than the old logic).
      var aw = a.split(/\W+/).filter(function (w) { return w.length >= 4; });
      for (var i = 0; i < aw.length; i++) if (b.indexOf(aw[i]) !== -1) return true;
      return false;
    }
    // Symmetric coverage: score how much of the SHORTER side is covered by
    // the LONGER side. Retail names are long and WMIC names are short, so
    // matching in one direction alone is unreliable (see v1.4.1 note about
    // matcher direction). 0.55 mirrors the catalog-match SUGGEST threshold.
    var at = tokenize(a), bt = tokenize(b);
    if (!at.length || !bt.length) return false;
    var sAB = scoreFn(at, new Set(bt));
    var sBA = scoreFn(bt, new Set(at));
    return Math.max(sAB, sBA) >= 0.55;
  }

  const targetMobo = ticket.specs && ticket.specs.mobo || '';
  const targetCpu = ticket.specs && ticket.specs.cpu || '';
  const targetGpu = ticket.specs && ticket.specs.gpu || '';
  const targetRam = ticket.specs && ticket.specs.ram || '';
  const targetStorage = ticket.specs && ticket.specs.storage || '';

  const detMobo = detectedSpecs.motherboard || '';
  const detCpu = detectedSpecs.cpu || '';
  const detGpu = detectedSpecs.dgpu || detectedSpecs.gpu || '';
  const detRam = detectedSpecs.ram || '';
  const detStorage = detectedSpecs.storage || '';

  const moboMatch = tokenMatch(targetMobo, detMobo);
  const cpuMatch = tokenMatch(targetCpu, detCpu);
  const gpuMatch = tokenMatch(targetGpu, detGpu);
  const ramMatch = tokenMatch(targetRam, detRam);
  const storageMatch = tokenMatch(targetStorage, detStorage);

  var mismatches = [];
  if (!moboMatch) mismatches.push('motherboard');
  if (!cpuMatch) mismatches.push('CPU');
  if (!gpuMatch) mismatches.push('GPU');
  if (!ramMatch) mismatches.push('RAM');
  if (!storageMatch) mismatches.push('storage');

  const matchStatusEl = document.getElementById('specs-match-status');
  if (matchStatusEl) {
    matchStatusEl.classList.remove('hidden');
    if (!mismatches.length) {
      matchStatusEl.textContent = '✅ Specs Verification: MATCH SUCCESS';
      matchStatusEl.style.background = 'rgba(16, 185, 129, 0.15)';
      matchStatusEl.style.color = '#10b981';
      matchStatusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } else {
      matchStatusEl.textContent = '⚠️ Specs Verification: MISMATCH DETECTED — ' + mismatches.join(', ');
      matchStatusEl.style.background = 'rgba(239, 68, 68, 0.15)';
      matchStatusEl.style.color = '#ef4444';
      matchStatusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  SALES QUERIES (v1.4.8) — technician side
//  Sales raise questions from the dashboard Staff View (writes to the
//  ticket_queries table: { id, ticket_id, question, answer, status }).
//  The concerning technician answers them here, inside the ticket.
// ═══════════════════════════════════════════════════════════

let ticketQueryCounts = {};   // { ticket_id: awaitingCount } — for card badges

function hideTicketQueriesSection() {
  const sec = document.getElementById('modal-queries-section');
  if (sec) sec.style.display = 'none';
}

async function loadTicketQueries(ticketId) {
  const sec  = document.getElementById('modal-queries-section');
  const list = document.getElementById('modal-queries-list');
  if (!sec || !list) return;
  if (!supabaseClient) { hideTicketQueriesSection(); return; }
  try {
    const { data, error } = await supabaseClient
      .from('ticket_queries')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!data || data.length === 0) { hideTicketQueriesSection(); return; }
    sec.style.display = '';
    renderTicketQueries(data);
  } catch (err) {
    // Table missing or unreachable — stay quiet, just hide the section.
    console.warn('Ticket queries unavailable:', err.message);
    hideTicketQueriesSection();
  }
}

function renderTicketQueries(rows) {
  const list = document.getElementById('modal-queries-list');
  const countEl = document.getElementById('modal-queries-count');
  const awaiting = rows.filter(q => q.status !== 'resolved' && !q.answer).length;
  if (countEl) {
    countEl.textContent = awaiting > 0 ? `${awaiting} awaiting reply` : 'all answered';
    countEl.className = 'tq-count ' + (awaiting > 0 ? 'awaiting' : 'done');
  }
  list.innerHTML = rows.map(q => {
    const resolved = q.status === 'resolved';
    const when = fmtQueryTime(q.created_at);
    const answerArea = q.answer
      ? `<div class="tq-answer"><span class="tq-ans-label">🔧 Your reply</span><div class="tq-ans-text">${escapeHtmlLite(q.answer)}</div>
           <button class="tq-link" data-edit="${q.id}">Edit reply</button></div>`
      : `<div class="tq-reply-box" data-box="${q.id}">
           <textarea class="tq-reply-input" data-input="${q.id}" rows="2" placeholder="Type your reply to sales…"></textarea>
           <button class="tq-send-btn" data-send="${q.id}">Send reply →</button>
         </div>`;
    return `<div class="tq-item ${resolved ? 'resolved' : ''} ${!q.answer && !resolved ? 'open' : ''}">
      <div class="tq-q">
        <span class="tq-q-label">🛍️ ${q.asked_by ? escapeHtmlLite(q.asked_by) + ' (sales) asked' : 'Sales asked'}</span>
        <span class="tq-time">${when}</span>
        <div class="tq-q-text">${escapeHtmlLite(q.question)}</div>
      </div>
      ${answerArea}
      <div class="tq-foot">
        ${resolved ? '<span class="tq-resolved">✓ Resolved</span>'
                   : `<button class="tq-link tq-resolve" data-resolve="${q.id}">Mark resolved</button>`}
        ${resolved ? `<button class="tq-link" data-reopen="${q.id}">Reopen</button>` : ''}
      </div>
    </div>`;
  }).join('');

  // Wire controls
  list.querySelectorAll('[data-send]').forEach(b =>
    b.addEventListener('click', () => submitTechAnswer(b.dataset.send)));
  list.querySelectorAll('[data-resolve]').forEach(b =>
    b.addEventListener('click', () => setQueryStatus(b.dataset.resolve, 'resolved')));
  list.querySelectorAll('[data-reopen]').forEach(b =>
    b.addEventListener('click', () => setQueryStatus(b.dataset.reopen, 'open')));
  list.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => beginEditReply(b.dataset.edit)));
}

async function submitTechAnswer(id) {
  const input = document.querySelector(`[data-input="${id}"]`);
  if (!input) return;
  const answer = input.value.trim();
  if (!answer) { input.focus(); return; }
  if (!supabaseClient) return;
  const btn = document.querySelector(`[data-send="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const { error } = await supabaseClient
      .from('ticket_queries')
      .update({ answer, status: 'answered' })
      .eq('id', id);
    if (error) throw error;
    if (editingTicketId) loadTicketQueries(editingTicketId);
    loadTicketQueryCounts();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send reply →'; }
    alert('Could not send reply: ' + err.message);
  }
}

async function setQueryStatus(id, status) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.from('ticket_queries').update({ status }).eq('id', id);
    if (error) throw error;
    if (editingTicketId) loadTicketQueries(editingTicketId);
    loadTicketQueryCounts();
  } catch (err) {
    alert('Could not update query: ' + err.message);
  }
}

// Turn an answered query back into an editable reply box.
function beginEditReply(id) {
  const item = document.querySelector(`[data-edit="${id}"]`);
  if (!item) return;
  const wrap = item.closest('.tq-item');
  const answerDiv = wrap.querySelector('.tq-answer');
  const current = wrap.querySelector('.tq-ans-text')?.textContent || '';
  answerDiv.outerHTML = `<div class="tq-reply-box" data-box="${id}">
      <textarea class="tq-reply-input" data-input="${id}" rows="2">${escapeHtmlLite(current)}</textarea>
      <button class="tq-send-btn" data-send="${id}">Update reply →</button>
    </div>`;
  const box = wrap.querySelector(`[data-send="${id}"]`);
  if (box) box.addEventListener('click', () => submitTechAnswer(id));
  wrap.querySelector(`[data-input="${id}"]`)?.focus();
}

function fmtQueryTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// Fetch open-query counts for all tickets → drives the card badges.
async function loadTicketQueryCounts() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('ticket_queries').select('ticket_id, status, answer');
    if (error) throw error;
    const map = {};
    (data || []).forEach(q => {
      if (q.status !== 'resolved' && !q.answer) map[q.ticket_id] = (map[q.ticket_id] || 0) + 1;
    });
    ticketQueryCounts = map;
    if (typeof renderDashboard === 'function') renderDashboard();
  } catch (err) {
    // table missing / offline — leave badges off
  }
}
