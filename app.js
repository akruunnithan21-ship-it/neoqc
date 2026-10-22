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

// ── v2.0.0 — build ownership + priority tiers ──────────────────────────────
// Every build belongs to the sales executive who closed it; the build priority
// (5 levels) classifies the ticket. Priority auto-sets from the build value and
// maps to an internal tier (never shown to staff). Stored in specs.__build so
// cross-machine sync carries it with no schema change.
const BUILD_TIER_BY_IMPORTANCE = { light: 1, medium: 2, important: 3, high_value: 4, exceptional: 5 };
let salesExecsCache = null;
let buildImportanceManual = false;   // true once the coordinator overrides the auto value

// Amount → priority: <1.5L Light, 1.5–2L Medium (2L inclusive), >2L Important.
// High Value / Exceptional are manual-only (the coordinator sets them).
function importanceFromAmount(total) {
  if (!total || total <= 0) return null;
  if (total < 150000) return 'light';
  if (total <= 200000) return 'medium';
  return 'important';
}

function computeBuildTotal() {
  let t = 0;
  Object.keys(specFieldMatches).forEach(k => {
    const m = specFieldMatches[k];
    if (m && typeof m.priceInr === 'number' && m.priceInr > 0) t += m.priceInr;
  });
  // On edit, this session has no fresh picks — fall back to the ticket's stored prices.
  if (t === 0 && editingTicketId) {
    const et = appState.tickets.find(x => x.id === editingTicketId);
    const sp = et && (et.specPrices || (et.specs && et.specs.__prices));
    if (sp) Object.values(sp).forEach(v => { if (typeof v === 'number' && v > 0) t += v; });
  }
  return t;
}

async function populateSalesExecs(selected) {
  const sel = document.getElementById('form-sales-exec');
  if (!sel) return;
  try {
    // v1.11 — people who have left (active = false) are no longer offered.
    // The cache is per sign-in (cleared at sign-in and sign-out), so a new or
    // renamed sales executive shows up without restarting the app.
    if (!salesExecsCache && supabaseClient) {
      const { data } = await supabaseClient.from('profiles')
        .select('full_name,email,designation').ilike('designation', '%Sales Executive%').eq('active', true);
      salesExecsCache = (data || []).filter(p => p.full_name).sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
  } catch (e) { console.warn('sales execs load failed:', e && e.message); }
  const list = (salesExecsCache || []).slice();
  const cur = selected != null ? selected : sel.value;
  // The build's existing owner is always an option, even when they are not in
  // the list (left, re-designated, or stamped by the website's quote builder),
  // so it is shown and saving never silently changes it.
  if (cur && !list.some(p => String(p.email || '').toLowerCase() === String(cur).toLowerCase())) {
    list.push({ email: cur, full_name: cur + ' (not in the list)' });
  }
  sel.innerHTML = '<option value="">— Select who closed this sale —</option>' +
    list.map(p => `<option value="${escapeHtmlLite(p.email)}">${escapeHtmlLite(p.full_name)}</option>`).join('');
  if (cur) {
    const match = list.find(p => String(p.email || '').toLowerCase() === String(cur).toLowerCase());
    sel.value = match ? match.email : cur;
  }
}

// ══ COMPONENT VERIFICATION (v2.0.0 Chunk B) ═══════════════════════════════
// The first QC gate. For each component the technician scans the serial off the
// physical box; we compare it to the serial captured from that component's
// invoice line and record the box condition. Everything is stored in
// specs.__verify (JSONB) so cross-machine sync carries it with no schema change.
const CV_COMPONENTS = [
  { key: 'motherboard', label: 'Motherboard', specField: 'form-spec-mobo',         legacy: 'serial-motherboard' },
  { key: 'cpu',         label: 'Processor',   specField: 'form-spec-cpu',          legacy: null },
  { key: 'gpu',         label: 'Graphics Card', specField: 'form-spec-gpu',        legacy: 'serial-gpu' },
  { key: 'ram',         label: 'Memory (RAM)', specField: 'form-spec-ram',         legacy: 'serial-ram', multi: true },
  { key: 'storage',     label: 'Storage',     specField: 'form-spec-storage',      legacy: 'serial-ssd' },
  { key: 'psu',         label: 'Power Supply', specField: 'form-spec-psu',         legacy: null },
  { key: 'cooler',      label: 'Cooler',      specField: 'form-spec-cooler-model', legacy: null },
  { key: 'case',        label: 'Cabinet',     specField: 'form-spec-case',         legacy: 'serial-cabinet' }
];

// Every field a barcode scanner is ever pointed at, in document order:
// procurement (goods-in) first, then component verification (build time). Used by
// the ticket form's Enter guard to step from one scan box to the next. Keep this
// in sync if a new scan field is added, or Enter will simply stop advancing there.
const SCAN_FIELD_SEL = '.proc-partno, .proc-serial, .cv-scan, .cv-scan-extra';
let _lastScanAdvance = 0;   // debounces CR+LF scanners that send two Enters
let _lastScanEl = null;     // paired with the clock so CR+LF is told apart from a fast rescan

// The eleven QC checkboxes, in form order. This was a local array inside the
// "Check All" handler; the lock state and the new counter need the same list,
// and two copies would drift the moment a check is added.
const QC_CHECK_IDS = [
  'qc-phys-cabinet', 'qc-phys-motherboard', 'qc-phys-ram', 'qc-phys-screws',
  'qc-soft-windows', 'qc-soft-drivers', 'qc-soft-bios',
  'qc-port-usb', 'qc-port-video', 'qc-port-audio', 'qc-port-wifi'
];

// Live "N / 11" beside the QC heading. Assembly, Procurement and Component
// Verification all carried a count; QC — the longest list — carried none.
function refreshQcBadge() {
  const badge = document.getElementById('qc-status-badge');
  if (!badge) return;
  const done = QC_CHECK_IDS.filter(id => {
    const el = document.getElementById(id);
    return el && el.checked;
  }).length;
  badge.textContent = `${done} / ${QC_CHECK_IDS.length}`;
  badge.classList.toggle('green', done === QC_CHECK_IDS.length);
}

// Box condition on arrival — short labels, honest meanings.
const BOX_STATUSES = [
  { v: '',            t: '— Box condition —' },
  { v: 'sealed',      t: 'Sealed box' },
  { v: 'open',        t: 'Open box' },
  { v: 'box_damaged', t: 'Box damaged · component OK' },
  { v: 'minor_mark',  t: 'Minor mark · works fine' },
  { v: 'doa',         t: 'Damaged on arrival (DOA)' }
];

// Serials read off the invoice, per category: { cpu: 'ABC123', ... }
let invoiceSerials = {};
// Technician scans + box status: { cpu: { scan, box }, ... }
let cvState = {};

// Serials differ cosmetically between print and scan (spaces, dashes, case).
function normSerial(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function cvStatusFor(key) {
  const st = cvState[key] || {};
  const scan = normSerial(st.scan);
  const inv = normSerial(invoiceSerials[key]);
  if (!scan) return 'idle';
  if (!inv) return 'warn';           // nothing on the invoice to compare against
  return scan === inv ? 'ok' : 'bad';
}

// QoL (v1.9.5) — has this serial already been recorded on a DIFFERENT ticket?
// Catches double-entry (same part logged on two builds). Checks both the legacy
// serials map and the newer component-verification scans. Warns, never blocks —
// a re-scan of a moved part is legitimate; the tech decides.
function serialExistsOnOtherTicket(val) {
  const v = String(val || '').trim().toLowerCase();
  if (v.length < 4) return false;
  return (appState.tickets || []).some(t => {
    if (t.id === editingTicketId) return false;
    if (t.serials && Object.values(t.serials).some(s => s && String(s).trim().toLowerCase() === v)) return true;
    const comps = t.specs && t.specs.__verify && t.specs.__verify.components;
    if (comps && Object.values(comps).some(c => c && c.scan && String(c.scan).trim().toLowerCase() === v)) return true;
    return false;
  });
}

function renderComponentVerify() {
  const wrap = document.getElementById('cv-rows');
  if (!wrap) return;
  const supplied = (typeof customerSuppliedSet !== 'undefined' && customerSuppliedSet) ? customerSuppliedSet : new Set();
  const awaiting = new Set((awaitingComponentsList || []).map(a => a.category));

  let html = '', total = 0, done = 0;
  CV_COMPONENTS.forEach(c => {
    const specEl = document.getElementById(c.specField);
    const specName = specEl ? (specEl.value || '').trim() : '';
    if (!specName) return;                       // only show components on this build
    total++;
    const st = cvState[c.key] || {};
    const status = cvStatusFor(c.key);
    if (status === 'ok' || status === 'warn') done++;
    const isAwaiting = awaiting.has(c.key);
    const isSupplied = supplied.has(c.key);
    const inv = invoiceSerials[c.key];
    html += `
      <div class="cv-row ${status}${serialExistsOnOtherTicket(st.scan) ? ' dup-serial' : ''}" data-key="${c.key}">
        <div class="cv-main">
          <div class="cv-cat">${escapeHtmlLite(c.label)}
            ${isAwaiting ? '<span class="cv-chip await">⏳ Awaiting</span>' : ''}
            ${isSupplied ? '<span class="cv-chip cust">♻ Customer part</span>' : ''}
          </div>
          <div class="cv-name" title="${escapeHtmlLite(specName)}">${escapeHtmlLite(specName)}</div>
        </div>
        <div class="cv-serials">
          <div class="cv-invoice" title="Serial captured from the invoice">
            <span class="cv-slabel">Invoice</span>
            <span class="cv-sval">${inv ? escapeHtmlLite(inv) : '—'}</span>
          </div>
          <input type="text" class="cv-scan" data-key="${c.key}" value="${escapeHtmlLite(st.scan || '')}"
                 placeholder="${c.multi ? 'Stick 1 serial' : 'Scan / type serial'}" autocomplete="off" spellcheck="false">
          ${c.multi ? `
          <div class="cv-extra-serials">
            ${((st.extraScans) || []).map((val, i) => `
              <div class="cv-extra-serial">
                <input type="text" class="cv-scan-extra" data-key="${c.key}" data-idx="${i}" value="${escapeHtmlLite(val || '')}"
                       placeholder="Stick ${i + 2} serial" autocomplete="off" spellcheck="false">
                <button type="button" class="cv-serial-remove" data-key="${c.key}" data-idx="${i}" title="Remove this serial">✕</button>
              </div>`).join('')}
            <button type="button" class="cv-serial-add" data-key="${c.key}">+ Add another serial</button>
          </div>` : ''}
        </div>
        <select class="cv-box" data-key="${c.key}">
          ${BOX_STATUSES.map(b => `<option value="${b.v}"${(st.box || '') === b.v ? ' selected' : ''}>${b.t}</option>`).join('')}
        </select>
        <span class="cv-status-ic" title="${status}">${status === 'ok' ? '✓' : status === 'bad' ? '✕' : status === 'warn' ? '!' : '·'}</span>
      </div>`;
  });

  wrap.innerHTML = html || '<div class="cv-empty">Add the target build specs above — components to verify will appear here.</div>';
  const badge = document.getElementById('cv-summary-badge');
  if (badge) badge.textContent = `${done} / ${total} verified`;

  const mismatches = CV_COMPONENTS.filter(c => cvStatusFor(c.key) === 'bad');
  const doa = CV_COMPONENTS.filter(c => (cvState[c.key] || {}).box === 'doa');
  const dups = CV_COMPONENTS.filter(c => serialExistsOnOtherTicket((cvState[c.key] || {}).scan));
  const note = document.getElementById('cv-gate-note');
  if (note) {
    if (mismatches.length) {
      note.className = 'cv-gate-note bad';
      note.textContent = '✕ Serial mismatch on: ' + mismatches.map(c => c.label).join(', ') +
        ' — the part that arrived is not the one on the invoice. Flag this before building.';
    } else if (dups.length) {
      note.className = 'cv-gate-note bad';
      note.textContent = '⚠ Serial already recorded on another ticket: ' + dups.map(c => c.label).join(', ') +
        ' — check you haven\'t double-entered a part.';
    } else if (doa.length) {
      note.className = 'cv-gate-note bad';
      note.textContent = '✕ Damaged on arrival: ' + doa.map(c => c.label).join(', ') + ' — raise a replacement.';
    } else if (total && done === total) {
      note.className = 'cv-gate-note ok';
      note.textContent = '✓ All components verified against the invoice. Cleared to build.';
    } else {
      note.className = 'cv-gate-note';
      note.textContent = total ? `${total - done} component(s) still to scan.` : '';
    }
  }
}

// Mirror scans into the legacy hidden serial inputs so every existing
// save/load/report path keeps working untouched.
function syncLegacySerialFields() {
  CV_COMPONENTS.forEach(c => {
    if (!c.legacy) return;
    const el = document.getElementById(c.legacy);
    if (!el) return;
    const st = cvState[c.key] || {};
    // For multi-unit components (RAM), record every stick's serial on the report,
    // comma-joined, so both serials appear on the certificate and in the serials map.
    if (c.multi && Array.isArray(st.extraScans) && st.extraScans.length) {
      el.value = [st.scan].concat(st.extraScans).filter(Boolean).join(', ');
    } else {
      el.value = st.scan || '';
    }
  });
}

function setupComponentVerify() {
  const wrap = document.getElementById('cv-rows');
  if (!wrap) return;
  // Keep the verification list in step with the target specs (a component only
  // appears once it's on the build). Debounced so typing stays smooth.
  let cvSpecTimer = null;
  CV_COMPONENTS.forEach(c => {
    const el = document.getElementById(c.specField);
    if (!el) return;
    el.addEventListener('input', () => {
      clearTimeout(cvSpecTimer);
      cvSpecTimer = setTimeout(renderComponentVerify, 250);
    });
  });
  wrap.addEventListener('input', (e) => {
    const inp = e.target.closest('.cv-scan');
    if (inp) {
      const k = inp.dataset.key;
      cvState[k] = cvState[k] || {};
      cvState[k].scan = inp.value;
      syncLegacySerialFields();
      // Repaint just this row's state so typing isn't interrupted by a re-render.
      const row = inp.closest('.cv-row');
      if (row) {
        const s = cvStatusFor(k);
        const dup = serialExistsOnOtherTicket(inp.value);
        row.className = 'cv-row ' + s + (dup ? ' dup-serial' : '');
        inp.title = dup ? 'This serial is already recorded on another ticket' : '';
        const ic = row.querySelector('.cv-status-ic');
        if (ic) ic.textContent = s === 'ok' ? '✓' : s === 'bad' ? '✕' : s === 'warn' ? '!' : '·';
      }
      updateCvSummaryOnly();
      return;
    }
    // Extra serials for multi-unit components (e.g. two RAM sticks). Stored in
    // cvState[key].extraScans, which round-trips through the same verify save path.
    const extra = e.target.closest('.cv-scan-extra');
    if (extra) {
      const k = extra.dataset.key, idx = parseInt(extra.dataset.idx, 10);
      cvState[k] = cvState[k] || {};
      cvState[k].extraScans = cvState[k].extraScans || [];
      cvState[k].extraScans[idx] = extra.value;
      syncLegacySerialFields();
    }
  });
  // Add / remove extra serial fields (multi-unit components like a 2-stick RAM kit).
  wrap.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.cv-serial-add');
    if (addBtn) {
      const k = addBtn.dataset.key;
      cvState[k] = cvState[k] || {};
      cvState[k].extraScans = cvState[k].extraScans || [];
      cvState[k].extraScans.push('');
      renderComponentVerify();
      return;
    }
    const rmBtn = e.target.closest('.cv-serial-remove');
    if (rmBtn) {
      const k = rmBtn.dataset.key, idx = parseInt(rmBtn.dataset.idx, 10);
      if (cvState[k] && Array.isArray(cvState[k].extraScans)) {
        cvState[k].extraScans.splice(idx, 1);
        syncLegacySerialFields();
        renderComponentVerify();
      }
    }
  });
  wrap.addEventListener('change', (e) => {
    const sel = e.target.closest('.cv-box');
    if (!sel) return;
    const k = sel.dataset.key;
    cvState[k] = cvState[k] || {};
    cvState[k].box = sel.value;
    renderComponentVerify();
  });
}

function updateCvSummaryOnly() {
  let total = 0, done = 0;
  CV_COMPONENTS.forEach(c => {
    const el = document.getElementById(c.specField);
    if (!el || !(el.value || '').trim()) return;
    total++;
    const s = cvStatusFor(c.key);
    if (s === 'ok' || s === 'warn') done++;
  });
  const badge = document.getElementById('cv-summary-badge');
  if (badge) badge.textContent = `${done} / ${total} verified`;
}

// ══ PROCUREMENT (v1.9.7) — incoming parts check ═══════════════════════════
// Procurement records part numbers + serials when parts arrive (before the
// technician's build-time scan), plus a basic incoming-QC checklist. Stored in
// specs.__procurement so it syncs with no schema change, and kept SEPARATE from
// the technician's cvState scan so that later scan is a second verification.
let procState = { components: {}, received: false, undamaged: false, matches: false };

function renderProcurement() {
  const wrap = document.getElementById('procurement-rows');
  if (!wrap) return;
  let html = '', total = 0, done = 0;
  CV_COMPONENTS.forEach(c => {
    const specEl = document.getElementById(c.specField);
    const specName = specEl ? (specEl.value || '').trim() : '';
    if (!specName) return;                       // only components on this build
    total++;
    const st = procState.components[c.key] || {};
    if ((st.partNo || '').trim() || (st.serial || '').trim()) done++;
    html += `
      <div class="proc-row" data-key="${c.key}">
        <div class="proc-cat">
          <div class="proc-label">${escapeHtmlLite(c.label)}</div>
          <div class="proc-name" title="${escapeHtmlLite(specName)}">${escapeHtmlLite(specName)}</div>
        </div>
        <input type="text" class="proc-partno" data-key="${c.key}" value="${escapeHtmlLite(st.partNo || '')}" placeholder="Part number" autocomplete="off" spellcheck="false">
        <input type="text" class="proc-serial" data-key="${c.key}" value="${escapeHtmlLite(st.serial || '')}" placeholder="Serial number" autocomplete="off" spellcheck="false">
      </div>`;
  });
  wrap.innerHTML = html || '<div class="cv-empty">Add the target build specs above — components to record will appear here.</div>';
  const rec = document.getElementById('proc-check-received');
  const und = document.getElementById('proc-check-undamaged');
  const mat = document.getElementById('proc-check-matches');
  if (rec) rec.checked = !!procState.received;
  if (und) und.checked = !!procState.undamaged;
  if (mat) mat.checked = !!procState.matches;
  const badge = document.getElementById('procurement-summary-badge');
  if (badge) badge.textContent = total ? `${done}/${total} recorded` : 'Incoming QC';
}

function setupProcurement() {
  const wrap = document.getElementById('procurement-rows');
  if (!wrap) return;
  wrap.addEventListener('input', (e) => {
    const partEl = e.target.closest('.proc-partno');
    const serEl = e.target.closest('.proc-serial');
    const el = partEl || serEl;
    if (!el) return;
    const k = el.dataset.key;
    procState.components[k] = procState.components[k] || {};
    if (partEl) procState.components[k].partNo = partEl.value;
    if (serEl) procState.components[k].serial = serEl.value;
    const badge = document.getElementById('procurement-summary-badge');
    if (badge) {
      let total = 0, done = 0;
      CV_COMPONENTS.forEach(c => {
        const s = document.getElementById(c.specField);
        if (!s || !(s.value || '').trim()) return;
        total++;
        const st = procState.components[c.key] || {};
        if ((st.partNo || '').trim() || (st.serial || '').trim()) done++;
      });
      badge.textContent = total ? `${done}/${total} recorded` : 'Incoming QC';
    }
  });
  const bind = (id, key) => { const cb = document.getElementById(id); if (cb) cb.addEventListener('change', () => { procState[key] = cb.checked; }); };
  bind('proc-check-received', 'received');
  bind('proc-check-undamaged', 'undamaged');
  bind('proc-check-matches', 'matches');
  // Keep the procurement rows in step with the target specs (debounced), so a
  // component appears here as soon as it's added to the build.
  let procTimer = null;
  CV_COMPONENTS.forEach(c => {
    const el = document.getElementById(c.specField);
    if (!el) return;
    el.addEventListener('input', () => { clearTimeout(procTimer); procTimer = setTimeout(renderProcurement, 250); });
  });
}

// ══ BUILD TIMER (v2.0.0 Chunk B) ══════════════════════════════════════════
// Start when assembly begins, finish only once every assembly checkbox is
// ticked. Purely for data + the warm line on the QC report — never a stopwatch
// held over the technician.
let buildTimerState = { startedAt: null, finishedAt: null, pausedMs: 0, pausedAt: null };
let buildTimerTick = null;

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
}

// Net active build time = wall time between start and (finish or now), minus any
// paused ("on break") spans. Works while running, paused, and after finishing.
function buildTimerElapsed() {
  const { startedAt, finishedAt, pausedMs, pausedAt } = buildTimerState;
  if (!startedAt) return 0;
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  let paused = pausedMs || 0;
  if (pausedAt && !finishedAt) paused += Date.now() - new Date(pausedAt).getTime();
  return Math.max(0, end - new Date(startedAt).getTime() - paused);
}

function renderBuildTimer() {
  const disp = document.getElementById('build-timer-display');
  const btn = document.getElementById('btn-build-timer');
  const pauseBtn = document.getElementById('btn-build-pause');
  if (!disp || !btn) return;
  const { startedAt, finishedAt, pausedAt } = buildTimerState;
  const stopTick = () => { if (buildTimerTick) { clearInterval(buildTimerTick); buildTimerTick = null; } };
  if (finishedAt && startedAt) {
    disp.textContent = '⏱ ' + fmtDuration(buildTimerElapsed());
    disp.classList.add('done'); disp.classList.remove('paused');
    btn.textContent = '✓ Build Finished';
    btn.disabled = true;
    if (pauseBtn) pauseBtn.style.display = 'none';
    stopTick();
  } else if (startedAt && pausedAt) {
    // Paused — freeze the display, offer Resume.
    disp.textContent = '⏸ ' + fmtDuration(buildTimerElapsed());
    disp.classList.remove('done'); disp.classList.add('paused');
    btn.textContent = '■ Finish Build';
    btn.disabled = false;
    if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.textContent = '▶ Resume'; }
    stopTick();
  } else if (startedAt) {
    // Running.
    disp.textContent = '⏱ ' + fmtDuration(buildTimerElapsed());
    disp.classList.remove('done'); disp.classList.remove('paused');
    btn.textContent = '■ Finish Build';
    btn.disabled = false;
    if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.textContent = '⏸ Pause'; }
    if (!buildTimerTick) buildTimerTick = setInterval(renderBuildTimer, 1000);
  } else {
    // Not started.
    disp.textContent = '—';
    disp.classList.remove('done'); disp.classList.remove('paused');
    btn.textContent = '▶ Start Build';
    btn.disabled = false;
    if (pauseBtn) pauseBtn.style.display = 'none';
    stopTick();
  }
}

function assemblyAllChecked() {
  return ['check-cpu-ram-ssd', 'check-mobo-case', 'check-cooler', 'check-cables', 'check-posted']
    .every(id => { const el = document.getElementById(id); return el && el.checked; });
}

function setupBuildTimer() {
  const btn = document.getElementById('btn-build-timer');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!buildTimerState.startedAt) {
      buildTimerState.startedAt = new Date().toISOString();
      buildTimerState.pausedMs = 0;
      buildTimerState.pausedAt = null;
      showToast('Build started — the clock is running.', 'success');
    } else if (!buildTimerState.finishedAt) {
      if (!assemblyAllChecked()) {
        showToast('Tick every assembly step before finishing the build.', 'warning');
        return;
      }
      // If the timer is paused when finishing, bank the current break first so the
      // recorded total is active work time only.
      if (buildTimerState.pausedAt) {
        buildTimerState.pausedMs = (buildTimerState.pausedMs || 0) + (Date.now() - new Date(buildTimerState.pausedAt).getTime());
        buildTimerState.pausedAt = null;
      }
      buildTimerState.finishedAt = new Date().toISOString();
      showToast(`Build finished in ${fmtDuration(buildTimerElapsed())} of active work. Nice work.`, 'success', 7000);
    }
    renderBuildTimer();
  });

  // Pause / Resume — lets a technician stop the clock for a break without losing
  // the elapsed time. Paused spans are excluded from the recorded build duration.
  const pauseBtn = document.getElementById('btn-build-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      if (!buildTimerState.startedAt || buildTimerState.finishedAt) return;
      if (buildTimerState.pausedAt) {
        buildTimerState.pausedMs = (buildTimerState.pausedMs || 0) + (Date.now() - new Date(buildTimerState.pausedAt).getTime());
        buildTimerState.pausedAt = null;
        showToast('Timer resumed.', 'info');
      } else {
        buildTimerState.pausedAt = new Date().toISOString();
        showToast('Timer paused — take your break.', 'info');
      }
      renderBuildTimer();
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  WHO BUILDS IT — the work queue (v1.11)
//  The app no longer picks technicians. A new build goes to the build queue
//  (rpc build_queue_send) and a technician claims it; anything not claimed in
//  4 hours is offered by the server to whoever has the most room. A build's
//  technician, technician_email, assigned_*, queued_at, offer_* and
//  declined_emails are SERVER-OWNED: written only by the work_* RPCs, never by
//  syncTicketToCloud (the tickets guard ignores them from a plain upsert), and
//  carried unchanged through every local save. These helpers read them.
// ══════════════════════════════════════════════════════════════════════════
const SERVER_OWNED_TICKET_FIELDS = ['technician', 'technicianEmail', 'assignedVia', 'assignedAt', 'queuedAt', 'offer', 'declinedEmails'];

function queueNowMs() {
  const Q = window.NeoQcQueue;
  if (Q && typeof Q.nowMs === 'function') { try { const n = Number(Q.nowMs()); if (Number.isFinite(n)) return n; } catch (e) {} }
  return Date.now();
}

function workFmtLeft(ms) {
  const W = window.NeoQcWork;
  if (W && typeof W.fmtLeft === 'function') { try { return W.fmtLeft(ms); } catch (e) {} }
  ms = Math.floor(Number(ms) || 0);
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function ticketIsAssigned(t) {
  return !!(t && (t.technicianEmail || String(t.technician || '').trim()));
}

// In the build queue: nobody has it, it was sent to the floor, not finished.
function isQueuedBuildTicket(t) {
  const W = window.NeoQcWork;
  if (W && typeof W.isQueuedBuild === 'function') { try { return !!W.isQueuedBuild(t); } catch (e) {} }
  return !!t && !ticketIsAssigned(t) && !!t.queuedAt && t.status !== 'completed';
}

// A quote: nobody has it and it was never sent to the floor.
function isQuoteBuildTicket(t) {
  const W = window.NeoQcWork;
  if (W && typeof W.isQuoteBuild === 'function') { try { return !!W.isQuoteBuild(t); } catch (e) {} }
  return !!t && !ticketIsAssigned(t) && !t.queuedAt && t.status !== 'completed';
}

function ticketOfferLive(t, now) {
  if (!t || !t.offer || !t.offer.expiresAt) return false;
  const exp = Date.parse(t.offer.expiresAt);
  return Number.isFinite(exp) && exp > (now == null ? queueNowMs() : now);
}

// {label, tone} for the ticket modal, the Builds card chip, the hover peek
// and the Overview row. tone: 'ok' | 'warn' | 'late' | 'muted'.
function buildTechInfo(t) {
  if (!t) return { label: 'Not sent to the floor yet', tone: 'muted' };
  const now = queueNowMs();
  const W = window.NeoQcWork;
  if (W && typeof W.buildAssignText === 'function') {
    try {
      const r = W.buildAssignText(t, now);
      if (r && r.label) return { label: String(r.label), tone: ['ok', 'warn', 'late', 'muted'].includes(r.tone) ? r.tone : 'muted' };
    } catch (e) { console.warn('buildAssignText failed:', e && e.message); }
  }
  const first = (s) => String(s || '').trim().split(/\s+/)[0] || '';
  const name = first(t.technician);
  if (t.status === 'completed') return { label: name ? name : 'Finished', tone: 'muted' };
  if (ticketOfferLive(t, now)) {
    return { label: `Offered to ${first(t.offer.toName) || t.offer.toEmail || 'someone'} · ${workFmtLeft(Date.parse(t.offer.expiresAt) - now)} left`, tone: 'warn' };
  }
  if (ticketIsAssigned(t)) {
    if (t.assignedVia === 'legacy' || !t.technicianEmail) return { label: `${name || t.technician} (old assignment)`, tone: 'muted' };
    let ago = '';
    if (t.assignedAt && window.NeoQcUI && typeof window.NeoQcUI.fmtRelative === 'function') {
      try { ago = ' · ' + window.NeoQcUI.fmtRelative(t.assignedAt, now); } catch (e) { ago = ''; }
    }
    return { label: `Claimed by ${name || t.technicianEmail}${ago}`, tone: 'ok' };
  }
  if (t.queuedAt) {
    const q = Date.parse(t.queuedAt);
    const due = Number.isFinite(q) ? q + 4 * 3600000 : NaN;
    if (Number.isFinite(due) && now >= due) return { label: 'In the build queue · overdue — the app is offering it', tone: 'late' };
    if (Number.isFinite(due)) return { label: `In the build queue · claim within ${workFmtLeft(due - now)}`, tone: due - now <= 3600000 ? 'warn' : 'ok' };
    return { label: 'In the build queue', tone: 'ok' };
  }
  return { label: 'Not sent to the floor yet', tone: 'muted' };
}

function hasQcRole(min) {
  const M = window.NeoQcModules;
  if (!currentProfile) return false;
  if (M && typeof M.hasRole === 'function') { try { return !!M.hasRole('qc', min); } catch (e) { return false; } }
  return Number(currentProfile.tier) >= 3;   // no registry: the v1.9.6 rule, never wider
}

function myWorkPools() {
  const M = window.NeoQcModules;
  if (M && typeof M.pools === 'function') {
    try { const p = M.pools(); if (p) return { build: !!p.build, service: !!p.service, level: p.level || null }; } catch (e) {}
  }
  return { build: false, service: false, level: null };
}

// ══════════════════════════════════════════════════════════════════════════
//  FLAGS & NOTIFICATIONS (v2.0.0 Chunk C)
//  A flag is raised from any segment of a build. Because the build belongs to
//  the sales executive who closed it, every flag is routed to them (for_email)
//  as well as showing in the bell here. Backed by public.ticket_flags.
// ══════════════════════════════════════════════════════════════════════════
const FLAG_SEGMENT_LABELS = {
  components: 'Component Verification',
  assembly: 'Assembly',
  qc: 'Quality Control',
  stress: 'Stress & Benchmarks',
  general: 'General'
};
let openFlags = [];
let flagModalSegment = null;

function openFlagModal(segment) {
  if (!editingTicketId) {
    showToast('Open the ticket you want to flag first.', 'warning');
    return;
  }
  flagModalSegment = segment || 'general';
  const t = appState.tickets.find(x => x.id === editingTicketId);
  const ctx = document.getElementById('flag-modal-context');
  if (ctx) {
    const owner = (t && t.specs && t.specs.__build && t.specs.__build.salesExec) || '';
    ctx.textContent = `${FLAG_SEGMENT_LABELS[flagModalSegment] || flagModalSegment} · ${t ? t.customerName : ''}` +
      (owner ? ` — goes to ${owner}` : ' — no sales executive set on this build yet');
  }
  const msg = document.getElementById('flag-message');
  if (msg) msg.value = '';
  const st = document.getElementById('flag-modal-status');
  if (st) st.textContent = '';
  document.getElementById('flag-modal').classList.add('active');
  setTimeout(() => { try { msg.focus(); } catch (e) {} }, 100);
}

async function submitFlag() {
  const t = appState.tickets.find(x => x.id === editingTicketId);
  const st = document.getElementById('flag-modal-status');
  const message = (document.getElementById('flag-message').value || '').trim();
  const severity = document.getElementById('flag-severity').value || 'warn';
  if (!message) { if (st) { st.textContent = 'Describe the issue first.'; st.style.color = 'var(--status-urgent)'; } return; }
  if (!supabaseClient) { if (st) { st.textContent = 'No cloud connection — flags need to reach the team.'; st.style.color = 'var(--status-urgent)'; } return; }
  const btn = document.getElementById('btn-submit-flag');
  if (btn) { btn.disabled = true; btn.textContent = 'Raising…'; }
  try {
    const owner = (t && t.specs && t.specs.__build && t.specs.__build.salesExec) || null;
    const { error } = await supabaseClient.from('ticket_flags').insert({
      ticket_id: editingTicketId,
      segment: flagModalSegment,
      severity: severity,
      message: message,
      status: 'open',
      raised_by: currentProfile ? currentProfile.email : null,
      raised_by_name: currentProfile ? currentProfile.full_name : null,
      for_email: owner,
      customer_name: t ? t.customerName : null
    });
    if (error) throw error;
    if (t) {
      addEventLog(t, `⚑ Flag raised (${FLAG_SEGMENT_LABELS[flagModalSegment] || flagModalSegment}): ${message}`,
        currentProfile ? currentProfile.full_name : 'Staff');
      await saveDatabase();
      await syncTicketToCloud(t);
    }
    document.getElementById('flag-modal').classList.remove('active');
    showToast('Flag raised' + (owner ? ' — ' + owner + ' has been notified.' : '.'), 'success');
    loadOpenFlags();
  } catch (e) {
    if (st) {
      st.textContent = /relation .* does not exist/i.test(e.message || '')
        ? 'The flags table isn\'t set up yet — run the ticket_flags SQL in Supabase.'
        : 'Could not raise the flag: ' + e.message;
      st.style.color = 'var(--status-urgent)';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Raise flag'; }
  }
}

async function loadOpenFlags() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient.from('ticket_flags')
      .select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    openFlags = data || [];
  } catch (e) {
    // Table not created yet, or offline — the bell simply stays quiet.
    console.warn('flags unavailable:', e && e.message);
    openFlags = [];
  }
  renderNotifBell();
}

function renderNotifBell() {
  const badge = document.getElementById('notif-badge');
  const list = document.getElementById('notif-list');
  if (!badge || !list) return;
  const n = openFlags.length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n === 0);
  const bell = document.getElementById('btn-notif-bell');
  if (bell) bell.classList.toggle('has-critical', openFlags.some(f => f.severity === 'critical'));

  if (!n) { list.innerHTML = '<div class="notif-empty">Nothing needs attention right now.</div>'; return; }
  list.innerHTML = openFlags.map(f => {
    const when = f.created_at ? new Date(f.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="notif-item sev-${escapeHtmlLite(f.severity || 'warn')}" data-flag-id="${escapeHtmlLite(String(f.id))}" data-ticket="${escapeHtmlLite(f.ticket_id || '')}">
      <div class="notif-item-head">
        <span class="notif-seg">${escapeHtmlLite(FLAG_SEGMENT_LABELS[f.segment] || f.segment || 'General')}</span>
        <span class="notif-when">${escapeHtmlLite(when)}</span>
      </div>
      <div class="notif-cust">${escapeHtmlLite(f.customer_name || f.ticket_id || '')}</div>
      <div class="notif-msg">${escapeHtmlLite(f.message || '')}</div>
      <div class="notif-actions">
        <button type="button" class="text-btn notif-open" data-ticket="${escapeHtmlLite(f.ticket_id || '')}">Open ticket</button>
        <button type="button" class="text-btn notif-resolve" data-flag-id="${escapeHtmlLite(String(f.id))}">Mark resolved</button>
      </div>
    </div>`;
  }).join('');
}

async function resolveFlag(id) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.from('ticket_flags')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(),
                resolved_by: currentProfile ? currentProfile.email : null })
      .eq('id', id);
    if (error) throw error;
    openFlags = openFlags.filter(f => String(f.id) !== String(id));
    renderNotifBell();
    showToast('Flag resolved.', 'success');
  } catch (e) {
    showToast('Could not resolve the flag: ' + e.message, 'error');
  }
}

function setupFlagsAndBell() {
  // Flag buttons live in section headers throughout the ticket modal.
  document.addEventListener('click', (e) => {
    const fb = e.target.closest('.flag-btn');
    if (fb) { e.preventDefault(); openFlagModal(fb.getAttribute('data-flag-segment')); }
  });
  const closeFlag = () => document.getElementById('flag-modal').classList.remove('active');
  const cf = document.getElementById('btn-close-flag-modal');
  if (cf) cf.addEventListener('click', closeFlag);
  const cancel = document.getElementById('btn-cancel-flag');
  if (cancel) cancel.addEventListener('click', closeFlag);
  const submit = document.getElementById('btn-submit-flag');
  if (submit) submit.addEventListener('click', submitFlag);

  const bell = document.getElementById('btn-notif-bell');
  const panel = document.getElementById('notif-panel');
  if (bell && panel) {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) loadOpenFlags();
    });
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== bell) {
        panel.classList.add('hidden');
      }
    });
    panel.addEventListener('click', (e) => {
      const openBtn = e.target.closest('.notif-open');
      if (openBtn) {
        const tid = openBtn.getAttribute('data-ticket');
        panel.classList.add('hidden');
        if (tid) openTicketModal(tid);
        return;
      }
      const resBtn = e.target.closest('.notif-resolve');
      if (resBtn) resolveFlag(resBtn.getAttribute('data-flag-id'));
    });
  }
  const refresh = document.getElementById('btn-notif-refresh');
  if (refresh) refresh.addEventListener('click', loadOpenFlags);

  // Poll every 60s so a flag raised on another machine surfaces here too.
  loadOpenFlags();
  setInterval(loadOpenFlags, 60000);
}

function updateBuildPriorityAuto() {
  const sel = document.getElementById('form-build-importance');
  const hint = document.getElementById('build-priority-hint');
  if (!sel) return;
  const total = computeBuildTotal();
  if (!buildImportanceManual) {
    const imp = importanceFromAmount(total);
    if (imp) sel.value = imp;
  }
  const tier = BUILD_TIER_BY_IMPORTANCE[sel.value] || '';
  if (hint) {
    hint.textContent = total > 0
      ? `Build value ≈ ₹${total.toLocaleString('en-IN')} · internal tier T${tier} ${buildImportanceManual ? '(manual)' : '(auto)'}`
      : 'Auto-set from build value — change if needed.';
  }
}

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
      '<span class="damage-part">' + escapeHtmlLite(DAMAGE_CATEGORY_LABEL[entry.category] || entry.category) + '</span>' +
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

// ---- Toast notifications -----------------------------------------------------
// Non-blocking replacement for native alert(). alert() freezes the frameless
// window (its own close/min buttons are HTML the renderer draws, so a blocking
// dialog locks the whole chrome) and looks dated. showToast() slides a glass
// card into the top-right stack and auto-dismisses. Message is set via
// textContent, so user-supplied text can never inject HTML. duration=0 = sticky.
// Returns a dismiss() function so callers can close a sticky toast early.
function showToast(message, type = 'info', duration = 5000) {
  let stack = document.getElementById('neo-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'neo-toast-stack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'neo-toast neo-toast-' + type;
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };
  const icon = document.createElement('span');
  icon.className = 'neo-toast-icon';
  icon.textContent = icons[type] || icons.info;
  const msg = document.createElement('span');
  msg.className = 'neo-toast-msg';
  msg.textContent = String(message);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'neo-toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.innerHTML = '&times;';
  toast.append(icon, msg, closeBtn);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('neo-toast-in');
    toast.classList.add('neo-toast-out');
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  };
  closeBtn.addEventListener('click', dismiss);
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('neo-toast-in'));
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

// ---- Confirm modal ----------------------------------------------------------
// Promise-based replacement for native confirm(). Resolves true on confirm,
// false on cancel / Escape / backdrop click. ALWAYS `await` this — an un-awaited
// call returns a Promise, which is truthy, so a missed await would silently
// auto-confirm a destructive action. Message/labels set via textContent.
// Each confirm still waiting for an answer is held in pendingConfirms (as its
// close function), so sign-out can answer it (dismissAllConfirms).
const pendingConfirms = new Set();
function showConfirm(message, opts = {}) {
  const { title = 'Please confirm', okText = 'Confirm', cancelText = 'Cancel', danger = false } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'neo-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'neo-confirm-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3');
    h.className = 'neo-confirm-title';
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'neo-confirm-msg';
    p.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'neo-confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'neo-confirm-cancel';
    cancelBtn.textContent = cancelText;
    const okBtn = document.createElement('button');
    okBtn.className = 'neo-confirm-ok' + (danger ? ' danger' : '');
    okBtn.textContent = okText;
    actions.append(cancelBtn, okBtn);
    box.append(h, p, actions);
    overlay.appendChild(box);

    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    // now = remove the overlay at once, without the fade (sign-out).
    const close = (val, now) => {
      pendingConfirms.delete(close);
      document.removeEventListener('keydown', onKey);
      if (now) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } else {
        overlay.classList.remove('neo-confirm-in');
        overlay.classList.add('neo-confirm-out');
        setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 220);
      }
      resolve(val);
    };
    pendingConfirms.add(close);
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('neo-confirm-in'));
    okBtn.focus();
  });
}

// Answers every open confirm "Cancel" and takes it off the screen now. Used
// at sign-out: a question one person was asked (an ops form's "Accept without
// photos?") must not survive onto the login screen for the next person to
// answer, since the form that asked would then go on to save. Every caller
// already treats false as "do nothing", as it does for Escape. Overlays still
// fading out from an answered confirm go too, so none sits over the login form.
function dismissAllConfirms() {
  Array.from(pendingConfirms).forEach((close) => {
    try { close(false, true); }
    catch (e) { console.warn('A confirm did not close cleanly at sign-out:', e && e.message); }
  });
  pendingConfirms.clear();
  document.querySelectorAll('.neo-confirm-overlay').forEach((o) => {
    if (o.parentNode) o.parentNode.removeChild(o);
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
    // No catalog SKU (keyword-only, or a dropped wrong-brand match) — keep the
    // invoice price if we have one so the build cost still reflects the invoice,
    // but never fabricate a SKU.
    specFieldMatches[fieldId] = {
      sku: null, priceInr: (entry.priceInr != null ? entry.priceInr : null),
      category: category, manualEntry: true, fromInvoice: true
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

// v1.4.11 — grow the catalog FROM the invoice. Each imported component is
// upserted into component_prices; the invoice price + name win. We dedupe
// against what's already there (strong same-brand match) so re-importing or
// building the same rig twice updates the existing row instead of piling up
// duplicates. Fully background — never blocks the ticket.
async function upsertInvoiceComponentsToCatalog(build) {
  if (!supabaseClient || !build || !build.results) return;
  const now = new Date().toISOString();
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  const brandConflict = (window.NeoQcInvoiceImport && window.NeoQcInvoiceImport.brandConflict) || (() => false);

  for (const category of Object.keys(build.results)) {
    const e = build.results[category];
    const name = e.displayName;
    if (!name || name.length < 3) continue;
    try {
      // Dedupe: already in the catalog? (same category, strong match, same brand)
      let existing = null;
      if (catalogMatcher && typeof catalogMatcher.suggest === 'function') {
        const hits = catalogMatcher.suggest(name, category, 3) || [];
        existing = hits.find(h => h.confidence >= 0.8 && !brandConflict(name, h.matchedName)) || null;
      }
      let sku;
      if (existing && existing.sku) {
        // Update the existing row IN PLACE — invoice price wins, no duplicate.
        sku = existing.sku;
        if (e.priceInr != null) {
          await supabaseClient.from('component_prices')
            .update({ price_inr: e.priceInr, updated_at: now, source: 'invoice' })
            .eq('sku', sku);
          const mem = catalogMatcher._entries && catalogMatcher._entries.find(x => x.sku === sku);
          if (mem) mem.price_inr = e.priceInr;
        }
      } else {
        // New component — insert it so the catalog grows from real invoices.
        sku = 'INV-' + slug(name);
        await supabaseClient.from('component_prices').upsert({
          sku, name, category, price_inr: e.priceInr,
          source: 'invoice', source_method: 'invoice-import',
          fetched_at: now, updated_at: now, needs_review: false
        }, { onConflict: 'sku' });
        if (catalogMatcher && catalogMatcher.addEntry) {
          catalogMatcher.addEntry({ sku, name, category, price_inr: e.priceInr });
        }
      }
      // Attach the resolved SKU + invoice price to this ticket's spec match so
      // the report / PPI price the exact part the customer was invoiced for.
      const fieldId = CATEGORY_TO_SPEC_FIELD[category];
      if (fieldId && specFieldMatches[fieldId]) {
        specFieldMatches[fieldId].sku = sku;
        if (specFieldMatches[fieldId].priceInr == null) specFieldMatches[fieldId].priceInr = e.priceInr;
      }
    } catch (err) {
      console.warn('invoice→catalog upsert failed for', category, err && err.message);
    }
  }
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
    btn.addEventListener('click', async () => {
      const uc = btn.getAttribute('data-uc');
      if (Object.keys(cfg.useCases).length <= 1) { showToast('At least one use case must remain.', 'warning'); return; }
      if (await showConfirm(`Remove use case "${uc}"? PPI will no longer offer it.`, { title: 'Remove use case', okText: 'Remove', danger: true })) {
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
    if (cfg.useCases[name]) { showToast('That use case already exists.', 'warning'); return; }
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
    if (bad.length && !(await showConfirm(`These use cases don't sum to 1.00: ${bad.join(', ')}.\nSave anyway? (PPI normalises internally, but 1.00 keeps the weights meaningful.)`, { title: 'Weights don’t sum to 1.00', okText: 'Save anyway' }))) return;
    applyPpiConfig(cfg);
    await saveDatabase();
    const status = document.getElementById('ppi-tuning-status');
    if (status) { status.classList.remove('hidden'); status.style.color = 'var(--status-completed, #10b981)'; status.textContent = '✓ PPI tuning saved and applied to the engine.'; }
  });

  const resetBtn = document.getElementById('btn-ppi-reset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (!PPI_ENGINE_DEFAULTS) PPI_ENGINE_DEFAULTS = ppiConfigFromEngine();
    if (!(await showConfirm('Reset all PPI tuning back to the built-in engine defaults?', { title: 'Reset PPI tuning', okText: 'Reset', danger: true }))) return;
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
  pendingQueueSends: [],
  settings: {
    supabaseUrl: "",
    supabaseAnonKey: "",
    pathHwInfo: "",
    pathCinebench: "",
    pathFurmark: "",
    pathPrime95: ""
  }
};

let currentMode = null; // "overview", "staff", "service", "rma", "client", "client-console" — set by switchScreen
let editingTicketId = null;
// Raw result of the LAST in-modal 🔍 Auto-Detect run (admin side). The save
// path merges this per-field with the ticket's stored detectedSpecs — the
// display divs are display-only now, never the source of truth.
let adminDetectedSpecs = null;

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
  // Restore this PC's theme (Settings → Appearance; v1.10 adds "Match Windows").
  applyThemeChoice(themeChoiceFromSettings(appState.settings));
  setSplashStatus('Preparing workspace…');
  setupEventListeners();
  setupAuthListeners();
  setupFlagsAndBell();
  setupBenchBoard();
  injectInlineIcons();
  setupSpecsAutocomplete();
  updateTimeDisplay();
  setInterval(updateTimeDisplay, 60000);

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

  // v2.0.0 P1 — the exe now requires a staff sign-in. If a Supabase Auth session
  // is already stored (persisted across launches), we route straight in by tier;
  // otherwise the login screen is shown. (v1.10: the old app-config.json /
  // "Master mode" boot hints are gone — sign-in alone decides the first screen.)
  await routeAfterAuth();
});

// Load DB from local Electron AppData Storage
async function loadDatabase() {
  setSplashStatus('Loading local database…');
  const dbData = await ipcRenderer.invoke('db:read');
  if (dbData) {
    appState = dbData;
  }

  // Surface local-DB health so a corrupt/lost file is never a silent blank slate.
  try {
    const health = await ipcRenderer.invoke('db:health');
    if (health && health.status === 'recovered') {
      showToast(health.message, 'warning', 14000);
    } else if (health && health.status === 'error') {
      showToast(health.message, 'error', 0); // sticky until dismissed
    }
  } catch (e) { /* older main process without db:health — ignore */ }

  // Securely initialize missing properties to prevent runtime script crashes
  if (!appState.tickets) appState.tickets = [];
  // v1.11 — builds this PC created whose build_queue_send has not landed yet
  // (WQ-C1). Kept OUTSIDE the ticket objects, so no merge or mapper can drop it.
  if (!Array.isArray(appState.pendingQueueSends)) appState.pendingQueueSends = [];
  // v1.11 — the per-PC technician list is gone (technicians claim from the
  // queue; people are managed in Settings → People). An old db.json may still
  // carry it; nothing reads it.

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

  // Seed mock tickets LOCALLY when the local db is empty, purely to showcase the UI
  // on a fresh/offline install. They are intentionally NOT pushed to Supabase — doing
  // so polluted the shared production database with "Test Build" rows on every fresh
  // install. syncFromCloud() below prunes local-only synced tickets, and these mocks
  // are never marked cloudSynced, so they simply stay local until real data loads.
  if (!appState.tickets || appState.tickets.length === 0) {
    seedMockTickets();
    await saveDatabase();
  }
  
  setSplashStatus('Syncing tickets…');
  await syncFromCloud();

  // Version check and Changelog Modal trigger
  const currentVersion = require('./package.json').version;
  stampAppVersion(currentVersion); // keep the changelog badge/button in sync with package.json — no more hand-editing
  if (appState.lastRunVersion !== currentVersion) {
    setTimeout(() => {
      const changelogModal = document.getElementById('changelog-modal');
      if (changelogModal) {
        changelogModal.classList.add('active');
      }
    }, 1000);
  }
}

// Stamp the running version into any element marked with data-app-version /
// data-app-version-label, from package.json. This is the single source of truth
// for the changelog badge, the "what's new in vX" sentence, and the
// "Launch Neo OS vX" button — the three spots the code review flagged as
// hand-maintained (and the exact fragility behind the v1.8.3 version-bump
// mojibake). The changelog bullet text stays a manual, per-release edit.
function stampAppVersion(version) {
  let v = version;
  if (!v) { try { v = require('./package.json').version; } catch (e) {} }
  if (!v) return;
  document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = 'v' + v; });
  document.querySelectorAll('[data-app-version-label]').forEach(el => { el.textContent = 'Launch Neo OS v' + v; });
}

// Save DB back to local storage. db:write is atomic and returns
// {success:false,error} on failure — surface that instead of silently
// pretending the save worked (a swallowed write error is how data quietly
// goes missing). Callers that wrap this in try/catch still work; it no
// longer throws for a write failure, it toasts and returns the result.
async function saveDatabase() {
  try {
    const res = await ipcRenderer.invoke('db:write', appState);
    if (res && res.success === false) {
      console.error('Local save failed:', res.error);
      showToast('Could not save to the local database: ' + (res.error || 'unknown error') +
        '. Your latest change may not survive a restart.', 'error', 10000);
    }
    return res;
  } catch (e) {
    console.error('saveDatabase invoke failed:', e);
    showToast('Could not save to the local database. Your latest change may not survive a restart.', 'error', 10000);
    return { success: false, error: e && e.message };
  }
}

// The only screens that are NOT office screens. Everything else switchScreen is
// asked to open must pass the module registry gate below.
const NON_OFFICE_MODES = ['client', 'client-console', 'selector'];

// Can the signed-in person open this office screen? Asks the module registry
// (modules.js), which decides from their tier AND their module roles. If the
// registry failed to load, fall back to the v1.9.6 rule (Overview, Builds and
// Service are tier 3+, nothing else opens) — never wider than before.
// SPEC-GAP: the spec assumes modules.js is always present; this is the
// conservative answer for when it is not.
function canOpenOfficeMode(mode) {
  if (!currentProfile) return false;
  const M = window.NeoQcModules;
  if (!M || typeof M.canOpen !== 'function') {
    return (mode === 'staff' || mode === 'service' || mode === 'overview') && Number(currentProfile.tier) >= 3;
  }
  try { return !!M.canOpen(mode, currentProfile); } catch (e) { console.warn('module gate failed:', e && e.message); return false; }
}

// Switch between screens
function switchScreen(mode, selectedId = null) {
  // SECURITY (v1.10) — every office screen (Overview, Builds, Service, RMA) is
  // gated by the module registry (modules.js): NeoQcModules.canOpen() decides
  // from the signed-in profile's tier and their module roles (my_modules()).
  // This replaced the v1.9.6 "tier 3+ only" check, and keeps its reason: the
  // mode selector's "Admin" button has no check of its own, so a technician
  // could bounce through "Switch Mode" → selector → Admin. Any such path still
  // lands here and is refused → redirected to their own screen.
  // Builds stays tier 3+. Service and RMA open for anyone holding a role in
  // that module (desk, tech or lead; tier 3+ are leads everywhere), because a
  // tier-1 counter clerk now takes service tickets in — but they show customer
  // phone numbers and fault histories, so nobody without a role gets them.
  // DEFAULT-DENY: any mode that is not one of the three known non-office
  // screens must be in the registry AND openable, so a future screen cannot
  // join the office side without someone registering who may open it.
  // The server enforces the same rules (RLS: svc_reader / rma_reader); this
  // gate is what keeps the UI honest. (currentProfile null = offline/boot:
  // left alone, as before.)
  // v1.10 — no mode selector any more: 'selector' means "go home".
  if (mode === 'selector') { goHome(); return; }
  if (currentProfile && NON_OFFICE_MODES.indexOf(mode) === -1 && !canOpenOfficeMode(mode)) {
    let label = 'that screen';
    try {
      const M = window.NeoQcModules;
      const entry = M && typeof M.byMode === 'function' ? M.byMode(mode) : null;
      if (entry && entry.label) label = entry.label;
    } catch (e) {}
    showToast(`You don't have access to ${label}.`, 'warning');
    routeByTier();
    return;
  }
  currentMode = mode;

  // Programmatic scroll resets to prevent offsets
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;

  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });

  // Keep the rail reflecting reality however this screen was reached — a deep
  // link, a tier redirect, or the mode selector — not only a rail click.
  if (window.NeoQcShell) { try { window.NeoQcShell.syncRail(mode); } catch (e) {} }

  if (mode === 'staff') {
    document.getElementById('staff-screen').classList.add('active');
    // v1.11 — no auto-assign drain any more: technicians claim builds from
    // the Queue, and the server offers what nobody claims.
    renderDashboard();

  } else if (mode === 'queue') {
    // v1.11 — the one work queue for builds and service. queue.js owns it;
    // the registry gate above has already decided this person may open it.
    document.getElementById('queue-screen').classList.add('active');
    if (window.NeoQcQueue && typeof window.NeoQcQueue.ensureLoaded === 'function') {
      Promise.resolve()
        .then(() => window.NeoQcQueue.ensureLoaded())
        .catch(e => console.warn('queue load failed:', e && e.message));
    }

  } else if (mode === 'neohr') {
    // v1.11 — NeoHR, the people side: Team today, Work logs, Field activity
    // and the NeoHR phone app. Read-only; neohr.js owns it, and the registry
    // gate above has already decided this person (tier 3+ or a NeoHR lead)
    // may open it.
    document.getElementById('neohr-screen').classList.add('active');
    if (window.NeoQcHr && typeof window.NeoQcHr.ensureLoaded === 'function') {
      Promise.resolve()
        .then(() => window.NeoQcHr.ensureLoaded())
        .catch(e => console.warn('neohr load failed:', e && e.message));
    }

  } else if (mode === 'overview') {
    // Builds and service in one list. Reads both caches; owns neither.
    document.getElementById('overview-screen').classList.add('active');
    if (window.NeoQcShell) {
      window.NeoQcShell.ensureOverviewLoaded()
        .catch(e => console.warn('overview load failed:', e && e.message));
    }
  } else if (mode === 'service') {
    // Service ticketing. Anyone with a service role (the registry gate at the
    // top of this function has already run), and it owns its own tables, so
    // nothing here touches the build sync paths.
    document.getElementById('service-screen').classList.add('active');
    if (window.NeoQcServiceUI) {
      window.NeoQcServiceUI.ensureServiceLoaded()
        .catch(e => console.warn('service load failed:', e && e.message));
    }
  } else if (mode === 'rma') {
    // RMA — parts on warranty claims. Anyone with an RMA role (the registry
    // gate above has run). Its own tables, its own module; no build sync path.
    document.getElementById('rma-screen').classList.add('active');
    if (window.NeoQcRmaUI) {
      Promise.resolve()
        .then(() => window.NeoQcRmaUI.ensureLoaded())
        .catch(e => {
          console.warn('rma load failed:', e && e.message);
          const msg = (window.NeoQcUI && typeof window.NeoQcUI.errText === 'function')
            ? window.NeoQcUI.errText(e) : ((e && e.message) || String(e));
          showToast('Could not load the RMA screen: ' + msg, 'error');
        });
    }
  } else if (mode === 'client') {
    document.getElementById('client-welcome-screen').classList.add('active');
    populateWelcomeTicketSelect();
    renderBenchBoard();

    // v1.10 — a bench technician who also works service tickets gets a door to
    // the queue from the bench (the rail then shows "Bench" to come back).
    // Shown for a service role of tech or lead only: claiming is what a
    // technician does there, and desk-only people never land on the bench.
    const welcomeServiceBtn = document.getElementById('btn-welcome-service');
    if (welcomeServiceBtn) {
      let svcRole = null;
      try { svcRole = window.NeoQcModules && typeof window.NeoQcModules.roleFor === 'function' ? window.NeoQcModules.roleFor('service') : null; } catch (e) { svcRole = null; }
      welcomeServiceBtn.classList.toggle('hidden', !((svcRole === 'tech' || svcRole === 'lead') && canOpenOfficeMode('service')));
    }

    // v1.10 — the old owner-only "Switch Mode" button is now "← <home>" (see
    // renderBenchBackButton). Where it leads is still decided by switchScreen's
    // module gate, so it can never open a screen the person may not see.
    renderBenchBackButton();
  } else if (mode === 'client-console') {
    document.getElementById('client-screen').classList.add('active');
    populateClientTicketSelect(selectedId);
    handleClientTicketSelect();
    // v1.10 — #btn-client-exit was the owner-only "Switch Mode"; it is now
    // "← My Bench" for everyone (back to the bench board, never past it).
  } else {
    // An unknown mode lands on the person's home screen — unless it IS their
    // home (a module with no screen yet), which would loop: show the notice.
    let home = null;
    try { home = currentProfile ? firstHomeMode(currentProfile) : null; } catch (e) { home = null; }
    if (home && home !== mode) goHome();
    else if (currentProfile) showTierNotice();
    else showLoginScreen();
  }
}

// v1.10 — the "Select Application Mode" page is gone. Anything that used to
// land on it (an old caller, the bench's back button) goes to the signed-in
// person's home screen instead — the same place sign-in sends them — and
// nobody signed in means the sign-in screen.
function goHome() {
  if (!currentProfile) { showLoginScreen(); return; }
  const home = firstHomeMode(currentProfile);
  if (!home || home === 'selector' || (NON_OFFICE_MODES.indexOf(home) === -1 && !canOpenOfficeMode(home))) {
    showTierNotice();
    return;
  }
  switchScreen(home);
  // Landing on your home screen is a natural pause point — re-check for OTA
  // updates (the main process rate-limits this to once per 10 minutes).
  try { ipcRenderer.send('update:check'); } catch (e) {}
}

// The bench's "← <home>" button: shown to people whose home is an office
// screen (they reached the bench from the rail), hidden for bench technicians
// — this board IS their home; they sign out from the name chip as before.
function renderBenchBackButton() {
  const btn = document.getElementById('btn-welcome-exit');
  if (!btn) return;
  let home = null;
  try { home = currentProfile ? firstHomeMode(currentProfile) : null; } catch (e) { home = null; }
  const show = !!home && NON_OFFICE_MODES.indexOf(home) === -1 && canOpenOfficeMode(home);
  btn.classList.toggle('hidden', !show);
  if (!show) return;
  let label = 'Home';
  try {
    const M = window.NeoQcModules;
    const entry = M && typeof M.byMode === 'function' ? M.byMode(home) : null;
    if (entry && entry.label) label = entry.label;
  } catch (e) {}
  btn.textContent = '← ' + label;
}

function updateTimeDisplay() {
  const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const timeStr = new Date().toLocaleDateString('en-US', options);
  // Add a nice status line if elements exist
}

// ==========================================================================
//  AUTHENTICATION & TIERS (v2.0.0 P1)
//  Staff sign in with email + PIN (Supabase Auth). Their profile row carries a
//  tier (1-5) that decides where they land and, later, what they can do. This
//  is ADDITIVE — it gates the exe but does not change how tickets are stored,
//  so machines still on 1.8.5 are unaffected until the 2.0.0 fleet cutover.
// ==========================================================================
let currentUser = null;      // Supabase auth user
let currentProfile = null;   // row from public.profiles (tier, name, designation…)


// Decide the initial screen: existing session → route by tier; else login.
async function routeAfterAuth() {
  try {
    if (supabaseClient && supabaseClient.auth) {
      const { data } = await supabaseClient.auth.getSession();
      if (data && data.session) {
        const ok = await loadCurrentProfile();
        if (ok) { routeByTier(); return; }
        // Session exists but no usable profile → sign out and fall through.
        // scope 'local': this PC only (see neoLogout).
        try { await supabaseClient.auth.signOut({ scope: 'local' }); } catch (e) {}
      }
    }
  } catch (e) {
    console.error('Auth session check failed:', e);
  }
  showLoginScreen();
}

// Load the signed-in user's profile row. Returns false if missing/deactivated.
// Falls back to a locally-cached copy when the network hiccups, so a tech who
// signed in earlier isn't locked out by an internet blip.
async function loadCurrentProfile() {
  try {
    if (!supabaseClient || !supabaseClient.auth) return loadCachedProfile();
    const { data: u } = await supabaseClient.auth.getUser();
    if (!u || !u.user) return loadCachedProfile();
    currentUser = u.user;
    const { data: p, error } = await supabaseClient
      .from('profiles').select('*').eq('id', u.user.id).single();
    if (error || !p) {
      console.error('Profile load failed, trying cache:', error && error.message);
      return loadCachedProfile(u.user.id);
    }
    if (p.active === false) return false; // explicitly deactivated → deny
    currentProfile = p;
    try { localStorage.setItem('neo_profile', JSON.stringify(p)); } catch (e) {}
    return true;
  } catch (e) {
    console.error('loadCurrentProfile error:', e);
    return loadCachedProfile();
  }
}

function loadCachedProfile(expectId) {
  try {
    const raw = localStorage.getItem('neo_profile');
    if (!raw) return false;
    const p = JSON.parse(raw);
    if (expectId && p.id !== expectId) return false;
    if (p.active === false) return false;
    currentProfile = p;
    return true;
  } catch (e) { return false; }
}

function showLoginScreen() {
  // Whatever brings the login screen up, nothing of the last session may stay
  // on top of it (closeSessionOverlays; a no-op when nothing is open).
  closeSessionOverlays();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const ls = document.getElementById('login-screen');
  if (ls) ls.classList.add('active');
  renderUserChip();
  const err = document.getElementById('login-error');
  if (err) { err.classList.add('hidden'); err.textContent = ''; }
  const pinEl = document.getElementById('login-pin');
  if (pinEl) pinEl.value = '';
  const emailEl = document.getElementById('login-email');
  if (emailEl) setTimeout(() => { try { emailEl.focus(); } catch (e) {} }, 120);
}

// Route by tier AND module role (v1.10). Where you land comes from the module
// registry, NeoQcModules.firstHome():
//   tier 3+                      → Overview (the first question anyone in the
//                                  office has is "what needs me today", across
//                                  every kind of work; the rest is on the rail)
//   tier 2 bench tech            → the Testing Client, as before — even with a
//                                  service tech role (the "Service queue"
//                                  button there is one click away)
//   a service / RMA role         → that module (a tier-1 counter clerk with a
//                                  desk role gets the app, not the notice)
//   a NeoHR lead with no work role → NeoHR (v1.11: HR below tier 3)
//   tier 1 with no role          → the friendly "use the web portal" notice.
// Module roles are asked for fresh at every sign-in (a grant takes effect at
// the next sign-in or restart), but that can never strand someone on the
// splash or login screen: after 4 s, or offline, the last answer this PC
// remembers is used, and the server's RLS still decides what they can read.
let routeSeq = 0;

function legacyHomeMode(profile) {
  const tier = profile ? Number(profile.tier) || 0 : 0;
  return tier >= 3 ? 'overview' : tier === 2 ? 'client' : null;
}

function firstHomeMode(profile) {
  const M = window.NeoQcModules;
  if (M && typeof M.firstHome === 'function') {
    try { return M.firstHome(profile) || null; }
    catch (e) { console.warn('firstHome failed, routing by tier:', e && e.message); }
  }
  // SPEC-GAP: no registry → the v1.9.6 routing (tier only), never wider.
  return legacyHomeMode(profile);
}

// Resolves when my_modules() has answered, failed, or taken longer than `ms`.
// Never rejects. A late answer still lands in the registry's cache, and the
// rail is rebuilt when it does, so the next screen change uses it.
function refreshModuleAccess(ms) {
  const M = window.NeoQcModules;
  if (!M || typeof M.refreshAccess !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => {
      console.warn(`my_modules() took longer than ${ms} ms — using the module access this PC remembers.`);
      finish(false);
    }, ms);
    Promise.resolve()
      .then(() => M.refreshAccess())
      .then(() => {
        if (settled && window.NeoQcShell && typeof window.NeoQcShell.refreshRail === 'function') {
          try { window.NeoQcShell.refreshRail(); } catch (e) {}
        }
        finish(true);
      }, (e) => {
        console.warn('my_modules() failed — using the module access this PC remembers:', e && e.message);
        finish(false);
      });
  });
}

async function routeByTier() {
  renderUserChip();
  const seq = ++routeSeq;
  const profile = currentProfile;
  try {
    if (profile) {
      let fresh = await refreshModuleAccess(4000);
      // Signed out, or a newer route started, while we waited: that one wins.
      if (seq !== routeSeq || currentProfile !== profile) return;
      // refreshAccess() never rejects — it falls back to this PC's cache by
      // itself — so ask it where the answer came from.
      try {
        const M = window.NeoQcModules;
        if (fresh && M && typeof M.accessSource === 'function' && M.accessSource() !== 'server') fresh = false;
      } catch (e) {}
      // Tier 3+ are leads everywhere whatever the server says, so only a
      // module-role user needs to know their roles may be out of date.
      if (!fresh && Number(profile.tier) < 3) {
        showToast('Couldn’t confirm your module access just now — using what this PC remembers.', 'warning', 7000);
      }
    }
    const home = firstHomeMode(profile);
    // A home the gate would refuse would bounce straight back here; the tier
    // notice is the safe end of that road.
    if (!home || (NON_OFFICE_MODES.indexOf(home) === -1 && !canOpenOfficeMode(home))) {
      showTierNotice();
      return;
    }
    switchScreen(home);
    // v1.11 — the work queue's background pass (work_tick every minute, and
    // "new work for you" offers on any screen). Idempotent; it stops itself at
    // sign-out.
    startWorkQueueBackground();
    // Landing on your home screen is a natural pause point — re-check for OTA
    // updates (main rate-limits to once per 10 min). Until v1.10 this ran when
    // the mode selector was shown.
    try { ipcRenderer.send('update:check'); } catch (e) {}
  } catch (e) {
    console.error('routeByTier failed, routing by tier:', e);
    if (seq !== routeSeq || currentProfile !== profile) return;
    const home = legacyHomeMode(profile);
    if (home && (NON_OFFICE_MODES.indexOf(home) !== -1 || canOpenOfficeMode(home))) switchScreen(home);
    else showTierNotice();
  }
}

function showTierNotice() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('tier-notice-screen');
  if (el) el.classList.add('active');
  const nameEl = document.getElementById('tier-notice-name');
  if (nameEl && currentProfile) nameEl.textContent = (currentProfile.full_name || 'staff').split(' ')[0];
}

// The titlebar chip: avatar + name + tier + one-click sign-out. Shown on every
// screen once signed in; hidden on the login screen itself.
function renderUserChip() {
  const chip = document.getElementById('titlebar-user');
  if (!chip) return;
  if (!currentProfile) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  const nameEl = document.getElementById('tbu-name');
  const avEl = document.getElementById('tbu-avatar');
  const first = (currentProfile.full_name || currentProfile.email || '?').trim();
  if (nameEl) nameEl.textContent = first.split(' ')[0];
  // Tier is an internal differentiator only — never shown to the user.
  if (avEl) {
    if (currentProfile.avatar_url) {
      avEl.style.backgroundImage = `url("${currentProfile.avatar_url}")`;
      avEl.textContent = '';
    } else {
      avEl.style.backgroundImage = '';
      avEl.textContent = first.charAt(0).toUpperCase();
    }
  }
}

async function neoLogout() {
  // First, not after signOut(): that can take seconds on a slow line, and an
  // open ticket (or a webcam) must not wait for it.
  closeSessionOverlays();
  resetSessionCaches();
  // v1.11 — scope 'local' ends THIS PC's session only. supabase-js@2's
  // signOut() defaults to 'global', which revokes every refresh token of the
  // account: the same person's NeoHR phone (which now signs in with this
  // login and is how work offers reach them), the website and other PCs would
  // all be signed out at their next refresh. A shared PC signs in and out all
  // day.
  try { if (supabaseClient && supabaseClient.auth) await supabaseClient.auth.signOut({ scope: 'local' }); }
  catch (e) { console.error('signOut failed:', e); }
  currentUser = null;
  currentProfile = null;
  showLoginScreen();
}

// v1.11 — per-person state that must not outlive a sign-in on a shared PC:
// the bench's "Show all" escape hatch and the sales-executive list.
function resetSessionCaches() {
  benchShowAll = false;
  salesExecsCache = null;
}

function startWorkQueueBackground() {
  const Q = window.NeoQcQueue;
  if (!currentProfile || !Q || typeof Q.startBackground !== 'function') return;
  try { Q.startBackground(); } catch (e) { console.warn('work queue background failed to start:', e && e.message); }
}

// ── Sign-out closes the session's overlays (v1.10) ────────────────────────────
// Swapping .screen elements is not enough. The titlebar chip sits above every
// overlay, so it can be pressed with a service ticket, an RMA part, an intake
// form, an ops dialog or the photo viewer open, each showing a customer's
// phone, address and photos. The counter PC is shared, and the next person to
// sit down may have no service role at all. So every overlay that holds one
// person's work is shut, without asking: the sign-out confirm has already said
// that unsaved work goes.
// Each ops module closes its own, which drops its state and destroys its photo
// trays, so a webcam goes off with them. An overlay a module could not close
// is hidden here anyway. A tray inside a hidden overlay turns its own camera
// off within a second (photo-tray.js), so the light never stays on.
// The build-side modals are closed too: the ticket form, God Mode and the flag
// form show a build, and Settings shows the staff list (Module access).
const BUILD_SESSION_MODAL_IDS = ['ticket-modal', 'godmode-modal', 'flag-modal', 'settings-modal'];

// Built when called: OPS_MODAL_IDS is declared further down this file.
function sessionOverlayIds() {
  return OPS_MODAL_IDS.concat(['ops-lightbox'], BUILD_SESSION_MODAL_IDS);
}

function sessionOverlayOpen() {
  const UI = window.NeoQcUI;
  if (UI && typeof UI.isOverlayOpen === 'function') {
    try { if (UI.isOverlayOpen()) return true; } catch (e) {}
  }
  return sessionOverlayIds().some(id => {
    const m = document.getElementById(id);
    return !!(m && m.classList.contains('active'));
  });
}

function closeSessionOverlays() {
  // One module failing to close must never stop the rest, or the sign-out.
  const run = (what, fn) => {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        r.then(null, (e) => console.warn(what + ' did not close cleanly at sign-out:', e && e.message));
      }
    } catch (e) { console.warn(what + ' did not close cleanly at sign-out:', e && e.message); }
  };

  // Top-most of all: a confirm still waiting for an answer is answered
  // "Cancel" (dismissAllConfirms), so the form that asked does not save.
  run('A confirm', () => dismissAllConfirms());

  // Then the ops dialogs and the photo viewer. closeAll() shuts
  // every dialog, parked ones and busy ones included, without asking.
  const UI = window.NeoQcUI;
  if (UI && typeof UI.closeAll === 'function') run('The ops dialog', () => UI.closeAll());
  // An ops-ui.js without closeAll(), or one whose closeAll() failed: the
  // dialog's own × closes it the way Cancel does. A nested dialog uncovers the
  // one under it, hence the loop; a busy one (× disabled) stops it. Without
  // this, ops-ui would go on trapping Tab inside a dialog nobody can see, on
  // the login form.
  const dialogOpen = () => {
    try { return !!(UI && typeof UI.isDialogOpen === 'function' && UI.isDialogOpen()); }
    catch (e) { return false; }
  };
  for (let i = 0; i < 10 && dialogOpen(); i++) {
    const x = document.querySelector('#ops-dialog-root .ops-dialog-x');
    if (!x || x.disabled) break;
    try { x.click(); }
    catch (e) { console.warn('The ops dialog did not close cleanly at sign-out:', e && e.message); break; }
  }
  if (UI && typeof UI.closeLightbox === 'function') run('The photo viewer', () => UI.closeLightbox());

  // The panels and forms underneath. With force, none of these asks anything,
  // and each is a no-op when it is not open.
  const SI = window.NeoQcServiceIntake;
  if (SI && typeof SI.close === 'function') run('The service intake form', () => SI.close({ force: true }));
  const SV = window.NeoQcServiceUI;
  if (SV && typeof SV.closePanelNow === 'function') run('The service ticket', () => SV.closePanelNow());
  const R = window.NeoQcRmaUI;
  if (R && typeof R.closeIntake === 'function') run('The RMA form', () => R.closeIntake(true));
  if (R && typeof R.closeUnit === 'function') run('The RMA part', () => R.closeUnit(true));
  // v1.11 — the work queue: its timers (the 1 s countdowns, the 30 s poll,
  // the 60 s background pass), its "new work for you" toasts and the last
  // person's feed all go. Its dialogs are ops dialogs, closed above.
  const Q = window.NeoQcQueue;
  if (Q && typeof Q.reset === 'function') run('The work queue', () => Q.reset());
  // v1.11 — NeoHR: everyone's logs and the team view go, and its refresh
  // timer stops.
  const HR = window.NeoQcHr;
  if (HR && typeof HR.reset === 'function') run('NeoHR', () => HR.reset());
  if (techAreaTimer) { clearInterval(techAreaTimer); techAreaTimer = null; }

  // The build ticket form, closed the way requestCloseTicketModal does after
  // "Discard".
  const tModal = document.getElementById('ticket-modal');
  if (tModal && tModal.classList.contains('active')) {
    editingTicketId = null;
    ticketFormDirty = false;
    try { hideConflictBanner(); } catch (e) {}
  }
  try { closeTicketPeek(); } catch (e) {}
  // A staff list still loading must not land in the closed Settings.
  opsSettingsSeq++;

  // Then hide whatever is still showing.
  sessionOverlayIds().forEach(id => {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
  });
}

function setupAuthListeners() {
  const form = document.getElementById('login-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailEl = document.getElementById('login-email');
      const pinEl = document.getElementById('login-pin');
      const errEl = document.getElementById('login-error');
      const btn = document.getElementById('login-submit');
      const email = (emailEl && emailEl.value || '').trim().toLowerCase();
      const pin = (pinEl && pinEl.value || '').trim();
      const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.classList.remove('hidden'); } };
      if (errEl) errEl.classList.add('hidden');
      if (!email || !pin) { showErr('Enter your email and PIN.'); return; }
      if (!supabaseClient || !supabaseClient.auth) { showErr('No cloud connection — check your internet and restart.'); return; }
      const old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pin });
        if (error || !data || !data.user) {
          showErr('Incorrect email or PIN.');
          if (btn) { btn.disabled = false; btn.textContent = old; }
          return;
        }
        const ok = await loadCurrentProfile();
        if (!ok) {
          showErr('Your account isn’t set up yet or has been deactivated. Contact the admin.');
          // scope 'local': this PC only (see neoLogout).
          try { await supabaseClient.auth.signOut({ scope: 'local' }); } catch (e) {}
          if (btn) { btn.disabled = false; btn.textContent = old; }
          return;
        }
        resetSessionCaches();
        if (pinEl) pinEl.value = '';
        if (btn) { btn.disabled = false; btn.textContent = old; }
        routeByTier();
      } catch (ex) {
        showErr('Sign-in failed: ' + (ex && ex.message ? ex.message : ex));
        if (btn) { btn.disabled = false; btn.textContent = old; }
      }
    });
  }
  const chip = document.getElementById('titlebar-user');
  if (chip) chip.addEventListener('click', async () => {
    // Sign-out closes whatever is open without saving it (closeSessionOverlays),
    // so when something is open, this is the one place that says so.
    const open = sessionOverlayOpen();
    const msg = open
      ? 'Sign out of Neo OS? The open ticket or form will be closed, and anything not saved in it will be lost.'
      : 'Sign out of Neo OS?';
    if (await showConfirm(msg, { title: 'Sign out', okText: 'Sign out', danger: open })) neoLogout();
  });
  const tierLogout = document.getElementById('btn-tier-logout');
  if (tierLogout) tierLogout.addEventListener('click', neoLogout);
}

// ==========================================================================
// DROPDOWN POPULATORS & RENDERING
// ==========================================================================
// v1.11 — the Builds technician filter is built from the tickets themselves
// (no per-PC technician list): every technician name on a build, plus the two
// unassigned states. Rebuilt only when the options change, and the current
// choice is kept.
const TECH_FILTER_QUEUE = '__queue__';
const TECH_FILTER_QUOTE = '__quote__';

function populateTechFilter() {
  const sel = document.getElementById('filter-tech');
  if (!sel) return;
  const names = Array.from(new Set((appState.tickets || [])
    .map(t => String((t && t.technician) || '').trim())
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
  const opts = [['all', 'All Technicians']].concat(names.map(n => [n, n]),
    [[TECH_FILTER_QUEUE, 'In the queue'], [TECH_FILTER_QUOTE, 'Not sent to the floor']]);
  const sig = opts.map(o => o[0]).join('\u0001');
  const cur = sel.value || 'all';
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.textContent = '';
    opts.forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    });
  }
  sel.value = opts.some(o => o[0] === cur) ? cur : 'all';
}

function ticketMatchesTechFilter(t, f) {
  if (!f || f === 'all') return true;
  if (f === TECH_FILTER_QUEUE) return isQueuedBuildTicket(t);
  if (f === TECH_FILTER_QUOTE) return isQuoteBuildTicket(t);
  return String((t && t.technician) || '').trim() === f;
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

// ══════════════════════════════════════════════════════════════════════════
//  THE BENCH (v2.0.0 Chunk E) — the Testing Client's own board.
//  A technician signs in and sees the builds that are actually theirs. Tickets
//  store a SHORT technician name ("Athul") while profiles carry the full name
//  ("Athul Sudheer"), so the two are matched on shared name tokens rather than
//  string equality. Service heads and above see everything — they supervise.
// ══════════════════════════════════════════════════════════════════════════
let benchShowAll = false;

function technicianMatchesProfile(techName, profile) {
  if (!techName || !profile) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const a = norm(techName), b = norm(profile.full_name || '');
  if (!a.length || !b.length) return false;
  return a.some(w => b.includes(w));
}

// v1.11 — a build is on someone's bench when its technician_email is theirs
// (set by the server when they claim it or accept an offer). Old builds that
// carry only a name fall back to the name match. Builds leads (tier 3+ are
// leads) see the whole floor; "Show all" is theirs alone.
function benchIsLead(profile) {
  if (!profile) return false;
  if (Number(profile.tier) >= 3) return true;
  return profile === currentProfile && hasQcRole('lead');
}

function benchTicketsFor(profile) {
  const active = (appState.tickets || []).filter(t => t && t.status !== 'completed');
  if (!profile) return active;
  const lead = benchIsLead(profile);
  if (lead) return active;   // leads see the floor (benchShowAll only ever widens a lead's view)
  const me = String(profile.email || '').trim().toLowerCase();
  return active.filter(t => {
    const e = String(t.technicianEmail || '').trim().toLowerCase();
    if (e) return !!me && e === me;
    return technicianMatchesProfile(t.technician, profile);
  });
}

function renderBenchBoard() {
  const grid = document.getElementById('bench-grid');
  const empty = document.getElementById('bench-empty');
  const countEl = document.getElementById('bench-count');
  const subEl = document.getElementById('bench-subtitle');
  if (!grid || !empty) return;

  const q = ((document.getElementById('bench-search') || {}).value || '').trim().toLowerCase();
  let list = benchTicketsFor(currentProfile);
  if (q) list = list.filter(t => {
    const sp = t.specs || {};
    return [t.customerName, t.id, t.technician, sp.cpu, sp.gpu]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
  });
  list = list.sort((a, b) => new Date(a.deadline || 0) - new Date(b.deadline || 0));
  if (countEl) countEl.textContent = String(list.length);
  const benchLead = benchIsLead(currentProfile);
  if (subEl) {
    subEl.textContent = (benchLead || !currentProfile)
      ? 'All active builds on the floor.'
      : `Builds ${(currentProfile.full_name || '').split(' ')[0] || 'you'} has claimed.`;
  }
  const showAllBtn = document.getElementById('btn-bench-showall');
  if (showAllBtn) showAllBtn.classList.toggle('hidden', !(benchLead && hasQcRole('lead')));

  empty.classList.toggle('hidden', list.length > 0);
  grid.innerHTML = list.map(t => {
    const b = (t.specs && t.specs.__build) || {};
    const specs = t.specs || {};
    const buildPct = Math.round(calculateBuildPercentage(t) || 0);
    const qcPct = Math.round(calculateQcPercentage(t) || 0);
    const urgent = checkIsUrgent(t.deadline);
    const dRisk = t.status === 'completed' ? '' : deadlineRisk(t.deadline);
    const stage = isQueuedBuildTicket(t) ? 'Queued'
      : buildPct < 100 ? 'Assembly'
      : qcPct < 100 ? 'QC & Testing' : 'Ready';
    return `<button type="button" class="bench-card ${urgent ? 'urgent' : ''}" data-ticket="${escapeHtmlLite(t.id)}">
      <div class="bench-card-top">
        <span class="bench-stage">${escapeHtmlLite(stage)}</span>
        <span class="bench-cid">#${escapeHtmlLite((t.id || '').slice(-6))}</span>
      </div>
      <div class="bench-cust">${escapeHtmlLite(t.customerName || '')}</div>
      <div class="bench-specline">${escapeHtmlLite([specs.cpu, specs.gpu].filter(Boolean).join('  ·  ') || 'Specs not set')}</div>
      <div class="bench-bars">
        <div class="bench-bar"><span>Build</span><div class="bench-track"><i style="width:${buildPct}%"></i></div><b>${buildPct}%</b></div>
        <div class="bench-bar"><span>QC</span><div class="bench-track"><i class="qc" style="width:${qcPct}%"></i></div><b>${qcPct}%</b></div>
      </div>
      <div class="bench-card-foot">
        <span class="bench-deadline ${urgent ? 'urgent' : ''}${dRisk ? ' risk-' + dRisk : ''}">📅 ${escapeHtmlLite(deadlineCountdown(t.deadline) || formatDateShort(t.deadline))}</span>
        <span class="bench-go">Open bench →</span>
      </div>
    </button>`;
  }).join('');
}

function setupBenchBoard() {
  const grid = document.getElementById('bench-grid');
  if (grid) grid.addEventListener('click', (e) => {
    const card = e.target.closest('.bench-card');
    if (!card) return;
    const id = card.getAttribute('data-ticket');
    if (!id) return;
    // Keep the legacy select in step, then open the console for that build.
    const sel = document.getElementById('welcome-ticket-select');
    if (sel) sel.value = id;
    switchScreen('client-console', id);
  });
  const refresh = document.getElementById('btn-bench-refresh');
  if (refresh) refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try { await syncFromCloud(); } catch (e) { console.warn('bench refresh failed:', e && e.message); }
    renderBenchBoard();
    refresh.disabled = false;
  });
  const showAll = document.getElementById('btn-bench-showall');
  if (showAll) showAll.addEventListener('click', () => {
    // Builds leads only (the button is hidden for everyone else); reset at sign-out.
    if (!hasQcRole('lead')) return;
    benchShowAll = true;
    renderBenchBoard();
  });
  const search = document.getElementById('bench-search');
  if (search) search.addEventListener('input', renderBenchBoard);
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
  populateTechFilter();
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
    // v1.9.8 — stress testing is a separate phase that ends with an explicit
    // technician sign-off. Auto-completing on the build + QC checkboxes ALONE
    // closed the ticket while stress testing was still pending, which pushed it
    // out of the active dashboard and made the remaining progress impossible to
    // track. A build is only finished once stress has been signed off too.
    if (buildAll && qcAll && t.stressSignedOff) {
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
    const matchesTech = ticketMatchesTechFilter(t, filterTech);

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
      // v1.8.2 — stress-test progress on the card (same curve as the panels):
      // asymptotic on run count, only the client sign-off reaches 100%.
      const stressRuns = t.stressRuns || 0;
      const stressPct = t.stressSignedOff ? 100 : (stressRuns <= 0 ? 0 : Math.min(90, Math.round(90 * (1 - Math.pow(0.5, stressRuns)))));
      const isAwaitingParts = t.missingComponentsToggle;
      
      const isUrgent = checkIsUrgent(t.deadline);
      const dRisk = t.status === 'completed' ? '' : deadlineRisk(t.deadline);
      const statusText = getStatusLabelText(t.status);

      const damaged = hasDamagedComponents(t);
      const damagedCount = damaged ? (t.damagedComponents || (t.specs && t.specs.__damaged) || []).length : 0;
      const techInfo = buildTechInfo(t);

      const card = document.createElement('div');
      card.className = `glass-slab ticket-card ${t.status} ${isUrgent ? "urgent" : ""} ${dRisk ? "risk-" + dRisk : ""} ${damaged ? "has-damage" : ""}`;
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
        <h3 class="card-cust-name">${escapeHtmlLite(t.customerName)}</h3>
        <div style="margin-bottom:14px;">
          <span class="tech-chip q-tone-${techInfo.tone}">
            <span class="tech-chip-dot"></span>
            ${escapeHtmlLite(techInfo.label)}
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

        <div class="card-progress-section">
          <div class="card-progress-label">
            <span>Stress ${t.stressSignedOff ? '✓' : ''}</span>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:800;">${stressPct}%</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill stress" style="width: ${stressPct}%; background: ${t.stressSignedOff ? 'linear-gradient(90deg,#10b981,#22c55e)' : 'linear-gradient(90deg,#f59e0b,#ef4444)'};"></div>
          </div>
        </div>

        ${isAwaitingParts ? `
          <div class="card-missing-parts">
            ⚠️ <strong>Awaiting:</strong> ${escapeHtmlLite(formatMissingComponentsHuman(t.missingComponents))}
          </div>
        ` : ''}

        <div class="card-meta-footer">
          <span class="card-type-badge">${t.type === 'build' ? '⚙️ Build' : '🔧 Repair'}</span>
          <span class="card-deadline ${isUrgent ? 'urgent' : ''}${dRisk ? ' risk-' + dRisk : ''}">📅 ${formatDateShort(t.deadline)} · <strong>${deadlineCountdown(t.deadline)}</strong></span>
        </div>
      `;

      card.addEventListener('click', () => openTicketModal(t.id));
      attachTicketPeek(card, t);
      grid.appendChild(card);
    });
  }

  // Render Completed / Passed Archive
  const filteredCompleted = completedTickets.filter(t => {
    if (!t || !t.id || !t.customerName) return false;
    const matchesSearch = t.customerName.toLowerCase().includes(searchQuery) ||
                          t.id.toLowerCase().includes(searchQuery) ||
                          (t.technician && t.technician.toLowerCase().includes(searchQuery));
    const matchesTech = ticketMatchesTechFilter(t, filterTech);
    return matchesSearch && matchesTech;
  });

  if (filteredCompleted.length === 0) {
    archiveTable.innerHTML = `<tr><td colspan="7" class="text-center">No completed system logs found.</td></tr>`;
  } else {
    filteredCompleted.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="font-mono">#${escapeHtmlLite(t.id.slice(-6))}</td>
        <td><strong>${escapeHtmlLite(t.customerName)}</strong></td>
        <td>${escapeHtmlLite(t.technician)}</td>
        <td>${escapeHtmlLite(t.specs ? (window.NeoQcMatcher && window.NeoQcMatcher.cleanName ? window.NeoQcMatcher.cleanName(t.specs.cpu || 'System Build') : (t.specs.cpu || 'System Build')) : 'N/A')}</td>
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
  const urgentCount = activeTickets.filter(t => isAtRisk(t.deadline)).length;   // includes overdue — see isAtRisk
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

// ══════════════════════════════════════════════════════════════════════════
//  HOVER-TO-PEEK (v2.0.0 Chunk D)
//  Rest on a ticket card and a summary rises into view — the Instagram
//  press-and-hold idea: you get a proper look WITHOUT entering the ticket.
//  Moving the pointer away dismisses it; clicking still opens the ticket.
//  TUNING: PEEK_DELAY_MS is the hold time before the preview appears.
// ══════════════════════════════════════════════════════════════════════════
const PEEK_DELAY_MS = 700;
let peekTimer = null;
let peekEl = null;

function closeTicketPeek() {
  if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
  if (peekEl) { peekEl.remove(); peekEl = null; }
}

function showTicketPeek(card, t) {
  closeTicketPeek();
  const b = (t.specs && t.specs.__build) || {};
  const v = (t.specs && t.specs.__verify) || {};
  const specs = t.specs || {};
  const pct = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));
  const buildPct = pct(calculateBuildPercentage(t));
  const qcPct = pct(calculateQcPercentage(t));
  const row = (label, value) => value
    ? `<div class="peek-row"><span>${escapeHtmlLite(label)}</span><strong>${escapeHtmlLite(value)}</strong></div>` : '';

  const el = document.createElement('div');
  el.className = 'ticket-peek';
  el.innerHTML =
    `<div class="peek-head">
       <span class="peek-name">${escapeHtmlLite(t.customerName || '')}</span>
       <span class="peek-id">#${escapeHtmlLite((t.id || '').slice(-6))}</span>
     </div>
     <div class="peek-bars">
       <div class="peek-bar"><span>Assembly</span><div class="peek-track"><i style="width:${buildPct}%"></i></div><b>${buildPct}%</b></div>
       <div class="peek-bar"><span>QC</span><div class="peek-track"><i class="qc" style="width:${qcPct}%"></i></div><b>${qcPct}%</b></div>
     </div>
     <div class="peek-specs">
       ${row('CPU', specs.cpu)}
       ${row('GPU', specs.gpu)}
       ${row('RAM', specs.ram)}
       ${row('Storage', specs.storage)}
     </div>
     <div class="peek-foot">
       ${row('Technician', buildTechInfo(t).label)}
       ${row('Sales', b.salesExec)}
       ${row('Deadline', formatDateShort(t.deadline) + ' · ' + deadlineCountdown(t.deadline))}
       ${v.summary && v.summary.scanned ? row('Serials verified', v.summary.matched + ' / ' + v.summary.scanned) : ''}
     </div>
     <div class="peek-hint">Click to open the full ticket</div>`;

  document.body.appendChild(el);
  peekEl = el;

  // Position beside the card, flipping/clamping so it never leaves the window.
  const r = card.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  let left = r.right + 12;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 12;
  if (left < 8) left = Math.max(8, (window.innerWidth - pw) / 2);
  let top = r.top;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  requestAnimationFrame(() => el.classList.add('show'));
}

function attachTicketPeek(card, t) {
  card.addEventListener('mouseenter', () => {
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showTicketPeek(card, t), PEEK_DELAY_MS);
  });
  card.addEventListener('mouseleave', closeTicketPeek);
  // Any click, scroll or key dismisses it — it must never linger or block work.
  card.addEventListener('click', closeTicketPeek);
}
document.addEventListener('scroll', closeTicketPeek, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTicketPeek(); });

// Short, human countdown for the prominent deadline pill on ticket cards.
function deadlineCountdown(deadlineStr) {
  if (!deadlineStr) return '';
  const d = new Date(deadlineStr);
  if (isNaN(d.getTime())) return '';
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days < 0) return `Overdue ${Math.abs(days)}d`;
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

function checkIsUrgent(deadlineStr) {
  if (!deadlineStr) return false;
  const diffMs = new Date(deadlineStr) - new Date();
  return diffMs > 0 && diffMs < 24 * 60 * 60 * 1000; // Less than 24 hours
}

// QoL (v1.9.5): deadline risk level for colour cues.
//   'overdue' → red (past due), 'soon' → amber (< 24h left), '' → normal.
// Call sites suppress it for completed builds (a shipped PC isn't "overdue").
function deadlineRisk(deadlineStr) {
  if (!deadlineStr) return '';
  const diffMs = new Date(deadlineStr) - new Date();
  if (isNaN(diffMs)) return '';
  if (diffMs <= 0) return 'overdue';
  if (diffMs < 24 * 60 * 60 * 1000) return 'soon';
  return '';
}

// "At risk" = due soon OR already blown. checkIsUrgent() above deliberately
// returns false for an overdue build (diffMs > 0), which is correct for its own
// callers but made the dashboard lie: a card's red tint switched OFF at the
// exact moment the deadline passed, and the Urgent pill counted DOWN as builds
// slipped — a floor with five overdue machines and nothing due in 24 hours read
// "Urgent: 0". Left checkIsUrgent alone; other call sites depend on its meaning.
function isAtRisk(deadlineStr) {
  const r = deadlineRisk(deadlineStr);
  return r === 'soon' || r === 'overdue';
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


// QoL (v1.9.5) — track unsaved edits so closing the ticket with unfinished
// work asks before discarding. Flipped true by any input/change inside the
// modal; reset on open (deferred past programmatic population) and on save.
let ticketFormDirty = false;
async function requestCloseTicketModal() {
  if (ticketFormDirty) {
    const ok = await showConfirm('You have unsaved changes on this ticket. Discard them and close?',
      { title: 'Unsaved changes', okText: 'Discard', danger: true });
    if (!ok) return;
  }
  document.getElementById('ticket-modal').classList.remove('active');
  editingTicketId = null;
  ticketFormDirty = false;
  hideConflictBanner();
}

function openTicketModal(ticketId = null) {
  editingTicketId = ticketId;
  // Reset AFTER this synchronous open (and any change events it dispatches
  // during programmatic population) so the modal never opens already "dirty".
  setTimeout(() => { ticketFormDirty = false; }, 0);
  adminDetectedSpecs = null;   // fresh modal — stale detect runs must not leak between tickets
  hideConflictBanner();
  const modal = document.getElementById('ticket-modal');
  const form = document.getElementById('ticket-form');
  form.reset();

  // v1.4.10 — clear session-scoped invoice/autocomplete state so a previous
  // ticket's invoice import (its auto-fill banner + matched SKUs/prices) never
  // bleeds into another ticket. specFieldMatches is a const object, so wipe its
  // keys in place rather than reassigning.
  Object.keys(specFieldMatches).forEach(k => delete specFieldMatches[k]);
  const invoiceStatusEl = document.getElementById('invoice-import-status');
  if (invoiceStatusEl) { invoiceStatusEl.classList.add('hidden'); invoiceStatusEl.innerHTML = ''; }
  const coolerModelReset = document.getElementById('form-spec-cooler-model');
  if (coolerModelReset) coolerModelReset.value = '';

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

  // v2.0.0 Chunk B — reset component verification + build timer for a fresh modal
  invoiceSerials = {};
  cvState = {};
  procState = { components: {}, received: false, undamaged: false, matches: false };
  buildTimerState = { startedAt: null, finishedAt: null, pausedMs: 0, pausedAt: null };
  if (buildTimerTick) { clearInterval(buildTimerTick); buildTimerTick = null; }
  syncLegacySerialFields();
  renderComponentVerify();
  renderProcurement();
  renderBuildTimer();

  // v2.0.0 — reset sales-exec ownership + build priority (auto until overridden)
  buildImportanceManual = false;
  const impSelReset = document.getElementById('form-build-importance');
  if (impSelReset) {
    impSelReset.value = 'light';
    if (!impSelReset._wired) {
      impSelReset._wired = true;
      impSelReset.addEventListener('change', () => { buildImportanceManual = true; updateBuildPriorityAuto(); });
    }
  }
  populateSalesExecs('');

  // v1.11 — who builds it is the work queue's business: the box shows where
  // the build stands and offers the actions this person may take on it.
  renderTicketTechArea(ticketId);
  loadTicketQueueHistory(ticketId);

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
      document.getElementById('form-ticket-type').value = ticket.type;

      // v2.0.0 — load saved sales-exec owner + build priority (keep the saved
      // value; don't let the auto-recalc override an intentional setting).
      const _b = (ticket.specs && ticket.specs.__build) || {};
      buildImportanceManual = true;
      const _impSel = document.getElementById('form-build-importance');
      if (_impSel) _impSel.value = _b.importance || 'light';
      populateSalesExecs(_b.salesExec || '');
      updateBuildPriorityAuto();

      // v2.0.0 Chunk B — restore component verification + build timer.
      // Fall back to the legacy flat serials so pre-2.0 tickets show their scans.
      const _v = (ticket.specs && ticket.specs.__verify) || {};
      invoiceSerials = _v.invoiceSerials || {};
      cvState = _v.components || {};
      if (!Object.keys(cvState).length && ticket.serials) {
        const legacyMap = { motherboard: 'motherboard', gpu: 'gpu', ram: 'ram', storage: 'ssd', case: 'cabinet' };
        Object.keys(legacyMap).forEach(k => {
          const val = ticket.serials[legacyMap[k]];
          if (val) cvState[k] = { scan: val, box: '' };
        });
      }
      buildTimerState = {
        startedAt: _v.buildStartedAt || null,
        finishedAt: _v.buildFinishedAt || null,
        pausedMs: _v.buildPausedMs || 0,
        pausedAt: _v.buildPausedAt || null
      };
      const _p = (ticket.specs && ticket.specs.__procurement) || {};
      procState = {
        components: _p.components || {},
        received: !!_p.received,
        undamaged: !!_p.undamaged,
        matches: !!_p.matches
      };


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
      // v1.9.8 — replay the stored diagnostics console so the admin sees exactly
      // what the technician's run printed, instead of the idle placeholder.
      renderStoredConsole('modal-console-box', ticket.diagnostics.consoleLog);
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
      // v1.8.2 — populate the HUD temperature cards from saved diagnostics so
      // the admin sees the peak temps the Testing Client recorded (previously
      // only the min/max/avg inputs loaded; the big HUD value stayed "--°C").
      if (typeof updateTempBar === 'function') {
        updateTempBar('modal-hud-cpu-temp-val', 'modal-hud-cpu-temp-bar', ticket.diagnostics.cpuTempMax);
        updateTempBar('modal-hud-gpu-temp-val', 'modal-hud-gpu-temp-bar', ticket.diagnostics.gpuTempMax);
      }
      restoreHudFromDiagnostics('modal-', ticket.diagnostics);
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
      // v1.11 — deleting a build is for Builds leads only (tier 3+ are leads).
      deleteBtn.classList.toggle('hidden', !hasQcRole('lead'));
      updateModalDiagnosticsStatus();

      // Populate Client Telemetry elements removed (redundant telemetry sections deleted in v1.0.9)

      // Render event log timeline
      renderEventLog(ticket);

      // Saved diagnostics panels (passport / Prime95) + precomputed PPI
      renderSavedDiagnosticsPanels(ticket);
      loadAndRenderPpi(ticket.id);
      loadTicketQueries(ticket.id);
      renderInventoryPanel(ticket);
      renderStressProgress(ticket);
      renderCustomerSupplied(ticket.customerSupplied || (ticket.specs && ticket.specs.__customerSupplied) || []);
      // Chunk B — paint verification rows + timer once specs/awaiting/supplied are loaded
      syncLegacySerialFields();
      renderComponentVerify();
      renderProcurement();
      renderBuildTimer();
    }
  } else {
    hideTicketQueriesSection();
    renderInventoryPanel(null);
    renderStressProgress(null);
    renderCustomerSupplied([]);
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

  // Header context + focused create-mode (must run after the branches above so
  // it reflects the values they just loaded).
  updateTicketModalChrome(ticketId);

  // AFTER the QC checkboxes have been populated. updateFormLockStates runs twice
  // during open (once at reset, once with the real build %), but both fire BEFORE
  // the boxes are filled in, and setting .checked in code raises no change event —
  // so the counter read 0 / 11 on every existing ticket until someone touched a box.
  refreshQcBadge();

  modal.classList.add('active');

  // Land on the stage the build is actually at, rather than the top of a
  // ~3,800px form. Runs after .active so the modal has layout to scroll.
  initJourneyNav();
  scrollModalToCurrentStage();
}

/*
  updateTicketModalChrome(ticketId)

  Two jobs:
  1. Fill the header strip — customer, priority, owner, deadline — and light up
     the build-journey stepper, so the ticket's context stays visible while you
     scroll a long form.
  2. Toggle focused CREATE mode. When there is no ticket yet, the workflow
     panels (verification, assembly, QC, diagnostics, inventory) are hidden
     entirely rather than shown locked — creating a build becomes a short,
     obvious task instead of a wall of greyed-out panels.
*/
function updateTicketModalChrome(ticketId) {
  const modal = document.getElementById('ticket-modal');
  if (!modal) return;
  const isNew = !ticketId;
  modal.classList.toggle('is-new-ticket', isNew);
  const hint = document.getElementById('new-ticket-hint');
  if (hint) hint.classList.toggle('hidden', !isNew);

  const t = ticketId ? appState.tickets.find(x => x.id === ticketId) : null;
  const set = (id, text, show) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !show);
  };

  set('tmh-customer', t ? (t.customerName || '') : 'New build', true);

  const b = (t && t.specs && t.specs.__build) || {};
  const IMP_LABEL = { light: 'Light', medium: 'Medium', important: 'Important',
                      high_value: 'High Value', exceptional: 'Exceptional' };
  const prEl = document.getElementById('tmh-priority');
  if (prEl) {
    const imp = b.importance;
    prEl.textContent = imp ? IMP_LABEL[imp] || imp : '';
    prEl.className = 'tmh-chip prio-' + (imp || 'light') + (imp ? '' : ' hidden');
  }
  set('tmh-owner', b.salesExec ? '👤 ' + b.salesExec : '', !!b.salesExec);
  set('tmh-deadline', t && t.deadline ? '📅 ' + deadlineCountdown(t.deadline) : '', !!(t && t.deadline));
  const dlEl = document.getElementById('tmh-deadline');
  if (dlEl) {
    const r = (t && t.deadline && t.status !== 'completed') ? deadlineRisk(t.deadline) : '';
    dlEl.classList.remove('risk-soon', 'risk-overdue');
    if (r) dlEl.classList.add('risk-' + r);
  }

  // Journey stepper: mark every stage up to the current one as reached.
  // v1.9.7 — added a Procurement stage between Parts and Assembly.
  const order = ['awaiting', 'procurement', 'building', 'qc', 'completed'];
  let reachedIdx = 0;
  if (t) {
    const buildPct = calculateBuildPercentage(t) || 0;
    const qcPct = calculateQcPercentage(t) || 0;
    const proc = (t.specs && t.specs.__procurement) || {};
    const procDone = !!(proc.received && proc.undamaged && proc.matches);
    if (t.status === 'completed') reachedIdx = 4;
    else if (qcPct > 0 || buildPct >= 100) reachedIdx = 3;
    else if (buildPct > 0 || t.status === 'building') reachedIdx = 2;
    else if (procDone) reachedIdx = 2;   // parts checked in → Assembly is up next
    else reachedIdx = 1;                  // ticket created → Procurement in progress
  }
  document.querySelectorAll('#tmh-journey .tmj-step').forEach((el, i) => {
    el.classList.toggle('done', !!t && i < reachedIdx);
    el.classList.toggle('current', !!t && i === reachedIdx);
    el.classList.toggle('idle', !t);
  });
  _tmjReachedIdx = reachedIdx;
}

// ══ The ticket's technician box (v1.11) ════════════════════════════════════
// Replaces the old "Assigned Technician" dropdown. It says where the build
// stands (claimed, offered, in the queue, not sent to the floor) and offers
// the actions this person may take. Every action is an RPC on the SAVED
// ticket (NeoQcQueue.buildAction → NeoQcData.work*), never part of Save, and
// the server re-checks it; the box refreshes from the server afterwards.
let techAreaTimer = null;
let techActionBusy = false;
let techHistorySeq = 0;
const TECH_BTN_ACT = {
  'btn-tech-claim': 'claim', 'btn-tech-offer': 'offer', 'btn-tech-withdraw': 'withdraw',
  'btn-tech-release': 'release', 'btn-tech-send': 'send'
};
const TECH_SAVE_FIRST = 'Save first — new builds go to the build queue automatically.';
// When this PC itself just changed a build through the queue, the realtime
// echo of that change is not "another device" (no conflict banner).
const ownQueueActionAt = {};
const WORK_WHY_SELF = {
  not_staff: "You don't have an active staff account.",
  no_role: "You don't have the Builds technician role.",
  no_pool: "You aren't in the build pool.",
  senior: 'This is a high-value build — only senior builders can take it.'
};

function workWhySentence(code, self) {
  const W = window.NeoQcWork;
  if (W && typeof W.whySentence === 'function') { try { const s = W.whySentence(code, 'build', self); if (s) return s; } catch (e) {} }
  return WORK_WHY_SELF[code] || '';
}

function buildTierOfTicket(t) {
  const W = window.NeoQcWork;
  if (W && typeof W.buildTier === 'function') { try { return Number(W.buildTier((t && t.specs) || {})) || 1; } catch (e) {} }
  const n = Math.round(Number(t && t.specs && t.specs.__build && t.specs.__build.tier) || 1);
  return Math.min(5, Math.max(1, n));
}

// The server's _work_why_not for the signed-in person (the server decides;
// this only greys the button out with the reason).
function myBuildWhyNot(tier) {
  if (!currentProfile) return 'not_staff';
  const M = window.NeoQcModules;
  let qcRole = null;
  try { qcRole = M && typeof M.roleFor === 'function' ? M.roleFor('qc') : null; } catch (e) { qcRole = null; }
  const pools = myWorkPools();
  const person = {
    email: currentProfile.email, name: currentProfile.full_name, tier: Number(currentProfile.tier) || 0,
    active: currentProfile.active !== false, is_staff: currentProfile.is_staff !== false,
    qc_role: qcRole, build_pool: pools.build, service_pool: pools.service, build_level: pools.level
  };
  const W = window.NeoQcWork;
  if (W && typeof W.whyNot === 'function') { try { return W.whyNot(person, 'build', tier) || null; } catch (e) {} }
  if (!person.active || !person.is_staff) return 'not_staff';
  if (!['tech', 'lead'].includes(person.tier >= 3 ? 'lead' : qcRole)) return 'no_role';
  if (!person.build_pool) return 'no_pool';
  if (tier >= 4 && person.build_level !== 'senior') return 'senior';
  return null;
}

function techBtn(id, show, opts) {
  const b = document.getElementById(id);
  if (!b) return;
  opts = opts || {};
  b.classList.toggle('hidden', !show);
  b.disabled = !!opts.disabled || techActionBusy;
  b.title = opts.title || '';
  if (opts.label) b.textContent = opts.label;
}

function techClock(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function renderTicketTechArea(ticketId) {
  const statusEl = document.getElementById('form-tech-status');
  if (!statusEl) return;
  const noteEl = document.getElementById('form-tech-note');
  const say = (text) => { if (noteEl) { noteEl.textContent = text || ''; noteEl.classList.toggle('hidden', !text); } };
  ensureTechAreaTimer();
  const t = ticketId ? (appState.tickets || []).find(x => x.id === ticketId) : null;
  const pools = myWorkPools();
  if (!t) {
    statusEl.textContent = ticketId ? 'This build is no longer on this PC.' : 'New build — it goes to the build queue when you save.';
    statusEl.dataset.tone = 'muted';
    Object.keys(TECH_BTN_ACT).forEach(id => techBtn(id, false));
    if (!ticketId) {
      techBtn('btn-tech-claim', pools.build, { label: 'Claim', disabled: true, title: TECH_SAVE_FIRST });
      techBtn('btn-tech-offer', hasQcRole('lead'), { label: 'Offer to…', disabled: true, title: TECH_SAVE_FIRST });
      say(TECH_SAVE_FIRST);
    } else {
      say('');
    }
    return;
  }
  const info = buildTechInfo(t);
  statusEl.textContent = info.label;
  statusEl.dataset.tone = info.tone;

  const now = queueNowMs();
  const me = String((currentProfile && currentProfile.email) || '').trim().toLowerCase();
  const done = t.status === 'completed';
  const live = ticketOfferLive(t, now);
  const toMe = live && String(t.offer.toEmail || '').trim().toLowerCase() === me;
  const queued = isQueuedBuildTicket(t);
  const quote = isQuoteBuildTicket(t);
  const assigned = ticketIsAssigned(t);
  const mine = !!t.technicianEmail && String(t.technicianEmail).trim().toLowerCase() === me;
  const lead = hasQcRole('lead');
  const desk = hasQcRole('desk');
  const why = myBuildWhyNot(buildTierOfTicket(t));
  const claimable = !done && queued && pools.build && (!live || toMe);

  techBtn('btn-tech-claim', claimable, {
    label: toMe ? 'Accept offer' : 'Claim', disabled: !!why, title: why ? workWhySentence(why, true) : ''
  });
  techBtn('btn-tech-offer', lead && !done && !live, { label: assigned ? 'Offer to someone else…' : 'Offer to…' });
  techBtn('btn-tech-withdraw', lead && !done && live, { label: 'Withdraw offer' });
  techBtn('btn-tech-release', !done && assigned && (mine || lead), { label: mine ? 'Hand back…' : 'Back to the queue…' });
  techBtn('btn-tech-send', desk && quote, { label: 'Send to build queue' });

  let note = '';
  if (toMe) note = `Offered to you — accept by ${techClock(t.offer.expiresAt)}, or decline it from the Queue.`;
  else if (claimable && why) note = workWhySentence(why, true);
  else if (quote && !desk) note = 'Someone on the Builds desk sends it to the build queue.';
  else if (live && t.offer.reason && lead) note = `Offer reason: ${t.offer.reason}`;
  say(note);
}

// While the ticket is open its countdown text stays current; the timer stops
// itself when the modal closes (and at sign-out).
function ensureTechAreaTimer() {
  if (techAreaTimer) return;
  techAreaTimer = setInterval(() => {
    const m = document.getElementById('ticket-modal');
    if (!m || !m.classList.contains('active') || !currentProfile) {
      clearInterval(techAreaTimer);
      techAreaTimer = null;
      return;
    }
    renderTicketTechArea(editingTicketId);
  }, 30000);
}

async function onTechButton(act) {
  const id = editingTicketId;            // the ticket this click is about — bound before any await
  if (!id) { showToast(TECH_SAVE_FIRST, 'info'); return; }
  if (techActionBusy) return;
  const Q = window.NeoQcQueue;
  if (!Q || typeof Q.buildAction !== 'function') {
    showToast('The work queue is not available on this PC — restart Neo OS.', 'error');
    return;
  }
  techActionBusy = true;
  Object.keys(TECH_BTN_ACT).forEach(bid => { const b = document.getElementById(bid); if (b) b.disabled = true; });
  ownQueueActionAt[id] = Date.now();
  let ok = false;
  try {
    ok = !!(await Q.buildAction(act, id));
  } catch (e) {
    showToast('That did not work: ' + opsErrText(e), 'error', 8000);
  }
  techActionBusy = false;
  if (ok) {
    ownQueueActionAt[id] = Date.now();
    try { await refreshTicketFromCloud(id); } catch (e) {}
  }
  if (editingTicketId !== id) return;    // another ticket (or none) is open now
  renderTicketTechArea(id);
  if (ok) loadTicketQueueHistory(id);
}

function setupTechAreaButtons() {
  Object.keys(TECH_BTN_ACT).forEach(bid => {
    const b = document.getElementById(bid);
    if (!b || b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', (e) => { e.preventDefault(); onTechButton(TECH_BTN_ACT[bid]); });
  });
}

// "Queue history" — the build's work_events, newest first. Builds desk+ only
// (the server's rule for work_events_for builds).
async function loadTicketQueueHistory(ticketId) {
  const box = document.getElementById('form-tech-history');
  const list = document.getElementById('form-tech-history-list');
  if (!box || !list) return;
  const seq = ++techHistorySeq;
  const id = ticketId;
  list.textContent = '';
  const D = window.NeoQcData;
  if (!id || !hasQcRole('desk') || !D || typeof D.workEvents !== 'function') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const line = (text) => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); };
  line('Loading…');
  let res;
  try {
    res = await D.workEvents('build', id);
  } catch (e) {
    if (seq !== techHistorySeq || editingTicketId !== id) return;
    list.textContent = '';
    line(e && e.message === 'DEMO_READONLY' ? 'Not shown while demo data is on.' : 'Could not load the queue history: ' + opsErrText(e));
    return;
  }
  if (seq !== techHistorySeq || editingTicketId !== id) return;
  const rows = Array.isArray(res) ? res
    : (res && Array.isArray(res.events)) ? res.events
    : (res && Array.isArray(res.rows)) ? res.rows : [];
  list.textContent = '';
  if (!rows.length) { line('Nothing yet.'); return; }
  const UI = window.NeoQcUI;
  rows.forEach(r => {
    if (!r) return;
    const li = document.createElement('li');
    const tm = document.createElement('time');
    tm.textContent = (UI && typeof UI.fmtDateTime === 'function') ? UI.fmtDateTime(r.at) : String(r.at || '');
    li.appendChild(tm);
    li.appendChild(document.createTextNode(String(r.body || r.kind || '')));
    list.appendChild(li);
  });
}

// The journey rail sits in the modal's non-scrolling header, so it is the one
// thing always in view — and it was five inert divs. The modal is ten panels
// totalling ~3,800px against an ~845px viewport, with no other navigation of any
// kind, so the technician scrolled the whole thing by hand every time.
let _tmjReachedIdx = 0;
function initJourneyNav() {
  const rail = document.getElementById('tmh-journey');
  if (!rail || rail.dataset.navBound) return;
  rail.dataset.navBound = '1';
  rail.addEventListener('click', (e) => {
    const step = e.target.closest('.tmj-step');
    if (!step || !step.dataset.target) return;
    const target = document.querySelector(step.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// On open, land on the stage the build is ACTUALLY at. The header already
// computes and displays "you are at Assembly" and then dropped the technician at
// Basic Details, ~1,900px away, on every open of every ticket. Skipped for a new
// ticket, where the top of the form is genuinely the right place to start.
function scrollModalToCurrentStage() {
  const modal = document.getElementById('ticket-modal');
  const body = modal && modal.querySelector('.modal-body');
  if (!body || modal.classList.contains('is-new-ticket')) return;
  const steps = document.querySelectorAll('#tmh-journey .tmj-step');
  const step = steps[_tmjReachedIdx];
  if (!step || !step.dataset.target) return;
  const target = document.querySelector(step.dataset.target);
  if (!target || target.offsetParent === null) return;
  // After paint, or the modal has no layout yet and scrollIntoView is a no-op.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => target.scrollIntoView({ behavior: 'auto', block: 'start' }));
  });
}

function updateFormLockStates(buildPct) {
  const badge = document.getElementById('build-status-badge');
  badge.textContent = `${buildPct}% Complete`;

  const qcSect = document.getElementById('qc-testing-section');
  const diagSect = document.getElementById('diagnostics-section');
  const serialsSect = document.getElementById('serials-section');

  const lockStrict = !appState.settings.disableQcLock;
  const isLocked = buildPct < 100 && lockStrict;

  // `pointer-events: none` (the CSS lock) stops the MOUSE and nothing else, so
  // all eleven QC checkboxes stayed in the tab order behind an 85%-opaque
  // overlay. A technician — or a barcode scanner emitting Tab and Enter — could
  // tick "BIOS Updated" before assembly reached 100% and never see what they
  // had ticked, silently defeating the exact gate this product exists to
  // enforce. `inert` removes the subtree from the tab order AND from hit
  // testing in one step, so the gate now holds against the keyboard too.
  [qcSect, diagSect, serialsSect].forEach(sect => {
    if (!sect) return;
    sect.classList.toggle('locked', isLocked);
    sect.toggleAttribute('inert', isLocked);
  });

  refreshQcBadge();
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
  if (runDiagBtn) {
    runDiagBtn.disabled = false;
    if (typeof clientStressMode !== 'undefined') runDiagBtn.textContent = clientStressMode === 'throttle' ? '▶ Run Throttle Test' : '▶ Run Stability Test';
  }
  if (checkWinBtn) checkWinBtn.disabled = false;
  if (typeof renderClientStressProgress === 'function') renderClientStressProgress();

  detectedSpecs = null;
  const matchStatusEl = document.getElementById('specs-match-status');
  if (matchStatusEl) matchStatusEl.classList.add('hidden');

  // Populate target specs (part codes stripped for display)
  const cleanSpec = (s) => (window.NeoQcMatcher && window.NeoQcMatcher.cleanName ? window.NeoQcMatcher.cleanName(s || '') : (s || '')) || '--';
  // Case-port certification list for THIS ticket (defaults on first open).
  casePorts = (ticket.diagnostics && Array.isArray(ticket.diagnostics.casePorts) && ticket.diagnostics.casePorts.length)
    ? ticket.diagnostics.casePorts
    : portCertDefaults();
  renderCasePorts();
  try { renderMoboPorts(ticket.diagnostics && ticket.diagnostics.portScan); } catch (_) {}

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
  // v1.8.2 — restore the client HUD temp cards from saved diagnostics too.
  if (typeof updateTempBar === 'function') {
    updateTempBar('c-hud-cpu-temp-val', 'c-hud-cpu-temp-bar', ticket.diagnostics.cpuTempMax);
    updateTempBar('c-hud-gpu-temp-val', 'c-hud-gpu-temp-bar', ticket.diagnostics.gpuTempMax);
  }
  restoreHudFromDiagnostics('c-', ticket.diagnostics);

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
  // Rear-I/O reference list sits beside the case-port certification so the two
  // are never mistaken for each other.
  try { renderMoboPorts(data); } catch (_) {}

  if (!ticket.qcChecks) ticket.qcChecks = {};
  ticket.qcChecks.portUsb = (data.usbControllers || []).length > 0;
  ticket.qcChecks.portVideo = (data.videoOutputs || []).length > 0 || (data.gpus || []).length > 0;
  ticket.qcChecks.portAudio = (data.audioEndpoints || []).length > 0;

  ticket.updatedAt = new Date().toISOString();
  appState.tickets[index] = ticket;
  await saveDatabase();
  await syncTicketToCloud(ticket);
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
      if (!ticketId) { showToast('Please select a ticket first before scanning ports.', 'warning'); return; }
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
    showToast('Please enter a customer name to create the ticket.', 'warning');
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
  // v1.11 — who builds it is SERVER-OWNED (the work queue). Saving the form
  // never changes it: technician and the queue/offer fields are carried from
  // the ticket as it stands (refreshed from the server), and a new build has
  // none yet — it goes to the build queue right after its first upload.
  const isNewTicket = !editingTicketId;

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
    missingComponentsToggle,
    missingComponents,
    buildChecks,
    qcChecks,
    diagnostics,
    serials,
    status,
    // v1.11 — a re-save of a finished build keeps its completion date (the
    // warranty runs from it); it used to be re-stamped on every save.
    completedAt: status === 'completed'
      ? ((existingTicket && existingTicket.status === 'completed' && existingTicket.completedAt) || new Date().toISOString())
      : null
  };
  // Server-owned (the work queue): carried as they stand, never set here.
  SERVER_OWNED_TICKET_FIELDS.forEach(k => {
    updatedTicket[k] = existingTicket && existingTicket[k] !== undefined ? existingTicket[k] : null;
  });
  if (!updatedTicket.technician) updatedTicket.technician = existingTicket ? (existingTicket.technician || '') : '';
  if (!Array.isArray(updatedTicket.declinedEmails)) updatedTicket.declinedEmails = [];
  if (existingTicket && existingTicket.cloudSynced) updatedTicket.cloudSynced = true;

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

  // v2.0.0 — sales-exec owner + build priority/tier. Nested in specs (JSONB) so
  // cross-machine sync carries it without a schema change. Tier is derived from
  // the priority level and is internal-only (never displayed to staff).
  {
    const seEl = document.getElementById('form-sales-exec');
    const impEl = document.getElementById('form-build-importance');
    const importance = (impEl && impEl.value) || 'light';
    updatedTicket.specs.__build = {
      salesExec: (seEl && seEl.value) || (existingTicket && existingTicket.specs && existingTicket.specs.__build && existingTicket.specs.__build.salesExec) || '',
      importance: importance,
      tier: BUILD_TIER_BY_IMPORTANCE[importance] || 1
    };
  }

  // v2.0.0 Chunk B — component verification (invoice serial vs scan + box
  // condition) and the assembly build timer. Nested in specs (JSONB) so
  // cross-machine sync carries it with no schema change.
  {
    const verify = {
      invoiceSerials: invoiceSerials || {},
      components: cvState || {},
      buildStartedAt: buildTimerState.startedAt,
      buildFinishedAt: buildTimerState.finishedAt,
      buildPausedMs: buildTimerState.pausedMs || 0,
      buildPausedAt: buildTimerState.pausedAt || null,
      buildDurationMs: (buildTimerState.startedAt && buildTimerState.finishedAt)
        ? buildTimerElapsed() : null
    };
    // Derived summary the report/dashboard can read without recomputing.
    let matched = 0, mismatched = 0, scanned = 0;
    Object.keys(verify.components).forEach(k => {
      const scan = normSerial(verify.components[k] && verify.components[k].scan);
      if (!scan) return;
      scanned++;
      const inv = normSerial(verify.invoiceSerials[k]);
      if (inv) { (scan === inv) ? matched++ : mismatched++; }
    });
    verify.summary = { scanned, matched, mismatched };
    updatedTicket.specs.__verify = verify;
    // v1.9.7 — procurement incoming-check record (part#/serial + checklist).
    updatedTicket.specs.__procurement = {
      components: procState.components || {},
      received: !!procState.received,
      undamaged: !!procState.undamaged,
      matches: !!procState.matches
    };
  }

  // v1.4.9 — detected specs are merged PER FIELD, never gated on CPU alone.
  // The old logic threw away the entire panel when the CPU probe failed
  // ("Failed to detect") even if GPU/RAM/storage detected fine — that's why
  // detected specs vanished after Update Ticket. Placeholder strings are
  // never saved as hardware, a fresh real reading wins, and an old reading
  // is kept when the new probe failed.
  const realDetVal = v => {
    const s = (v == null ? '' : String(v)).trim();
    return (s && s !== '--' && s !== 'Not detected' && s !== 'Failed to detect' && s !== 'None') ? s : '';
  };
  {
    const prev = (existingTicket && existingTicket.detectedSpecs) || {};
    const fresh = adminDetectedSpecs || {};
    const pick = (a, b) => realDetVal(a) || realDetVal(b) || '';
    // v1.9.8 DATA-LOSS FIX — start from the PREVIOUS object so every key this form
    // does NOT own survives an admin "Update Ticket". The old code rebuilt
    // detectedSpecs from a fixed key list, which silently destroyed `inventory`
    // (the full make / model / part-number / serial capture from hw_inventory.ps1)
    // and `capturedAt` on every save — that is why the "Hardware Inventory & Serial
    // Numbers" panel and the report's inventory section kept going empty.
    const merged = Object.assign({}, prev);
    merged.cpu     = pick(fresh.cpu, prev.cpu || detectedCpuVal);
    merged.igpu    = pick(fresh.igpu, prev.igpu || detectedIgpuVal) || 'None';
    merged.gpu     = pick(fresh.dgpu || fresh.gpu, prev.gpu || detectedGpuVal);
    merged.ram     = pick(fresh.ram, prev.ram || detectedRamVal);
    merged.storage = pick(fresh.storage, prev.storage || detectedStorageVal);
    // Keep BOTH spellings: `mobo` is what this form has always written, while the
    // detect probe and the inventory use `motherboard`. Mirroring them stops the
    // board name being lost when a ticket round-trips through either path.
    merged.motherboard = pick(fresh.motherboard, prev.motherboard || prev.mobo);
    merged.mobo    = merged.motherboard;
    merged.coolerVerified = !!prev.coolerVerified;
    merged.psuVerified = !!prev.psuVerified;
    merged.caseVerified = !!prev.caseVerified;
    if (fresh.inventory) merged.inventory = fresh.inventory;   // a fresh capture wins
    const hasAnything = merged.cpu || merged.gpu || merged.ram || merged.storage || merged.motherboard || merged.inventory || (merged.igpu && merged.igpu !== 'None');
    if (hasAnything) {
      updatedTicket.detectedSpecs = merged;
      // Mirror into specs.__detected so the JSONB specs column carries it
      // cross-machine even if this ticket reaches Supabase through a path
      // other than syncTicketToCloud (same pattern as __prices/__damaged).
      updatedTicket.specs.__detected = merged;
    } else if (existingTicket && existingTicket.detectedSpecs) {
      updatedTicket.detectedSpecs = existingTicket.detectedSpecs;
      updatedTicket.specs.__detected = existingTicket.detectedSpecs;
    }
  }

  // v1.8.2 — customer-supplied parts must ALWAYS persist, independent of
  // whether hardware detection ran (the previous code only saved them inside
  // the has-detected-specs branch, so ticking a part on a fresh ticket was
  // silently dropped on save).
  updatedTicket.customerSupplied = readCustomerSuppliedFromForm();
  updatedTicket.specs.__customerSupplied = updatedTicket.customerSupplied;

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
      // v1.11 — technician changes are the work queue's (its history is in
      // the ticket's "Queue history"); a save never changes the technician.
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

  // v1.9.8 DATA-LOSS FIX — carry stress-test state across an admin save. This
  // handler REPLACES the ticket object wholesale (appState.tickets[index] =
  // updatedTicket below) and the form owns none of these fields, so every
  // "Update Ticket" reset stress progress to zero and wiped the technician's
  // sign-off — which is why an opened ticket kept claiming stress testing was
  // still unsigned. existingTicket is the live appState object, so a sign-off or
  // run recorded during this modal session is picked up here.
  if (existingTicket) {
    updatedTicket.stressRuns = existingTicket.stressRuns || 0;
    updatedTicket.stressSignedOff = !!existingTicket.stressSignedOff;
    updatedTicket.stressSignedOffAt = existingTicket.stressSignedOffAt || null;
    // v1.11 — the rest of what the form does not own. Without these, the
    // upload's `else delete diagPayload.__reportOverrides` wiped God-Mode
    // report overrides on every admin save, and the stress time/log were
    // dropped until the next pull.
    updatedTicket.stressTotalSec = existingTicket.stressTotalSec || 0;
    updatedTicket.stressLog = Array.isArray(existingTicket.stressLog) ? existingTicket.stressLog : [];
    updatedTicket.reportOverrides = existingTicket.reportOverrides || null;
  }

  updatedTicket.updatedAt = new Date().toISOString();

  if (editingTicketId) {
    const index = appState.tickets.findIndex(t => t.id === editingTicketId);
    if (index === -1) appState.tickets.push(updatedTicket);
    else appState.tickets[index] = updatedTicket;
  } else {
    appState.tickets.push(updatedTicket);
    // WQ-C1 — queued for build_queue_send BEFORE its first upload, outside
    // the ticket object, so neither a failed upload nor the realtime echo of
    // our own insert can lose it. drainPendingQueueSends() retries it.
    if (!Array.isArray(appState.pendingQueueSends)) appState.pendingQueueSends = [];
    if (!appState.pendingQueueSends.includes(id)) appState.pendingQueueSends.push(id);
  }

  await saveDatabase();
  const uploaded = await syncTicketToCloud(updatedTicket);
  document.getElementById('ticket-modal').classList.remove('active');
  editingTicketId = null;
  ticketFormDirty = false;
  hideConflictBanner();
  renderDashboard();
  notifyBuildsChanged();

  if (isNewTicket) {
    showToast(uploaded
      ? '✓ Ticket created — it goes to the build queue for a technician to claim.'
      : '✓ Ticket created on this PC. It goes to the build queue once it reaches the cloud.', uploaded ? 'success' : 'warning', uploaded ? 5000 : 9000);
    drainPendingQueueSends().catch(e => console.warn('build queue send failed:', e && e.message));
  } else {
    showToast(uploaded ? '✓ Ticket saved.' : '✓ Saved on this PC, but it could not reach the cloud. Save it again once the connection is back.', uploaded ? 'success' : 'warning', uploaded ? 5000 : 9000);
  }
  } catch (err) {
    // Never fail silently — surface the reason so a save problem is visible.
    console.error('Ticket save failed:', err);
    showToast('Could not save the ticket: ' + (err && err.message ? err.message : err), 'error', 8000);
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
// Key the technician typed during Windows setup, verified against this PC's
// real activation record. Used when Windows itself no longer holds the key.
let winKeyEnteredByTech = '';

// v1.5.1 — Windows product key panel.
//
// Ground truth: SoftwareLicensingProduct.PartialProductKey (the last 5 chars)
// is ALWAYS this machine's real activating key. The full key is only present
// on disk when a DigitalProductId blob decodes to something whose last-5
// matches that. When a tech installs via "I don't have a product key", Windows
// stores a shared GENERIC key instead — the same on every PC — and typing a
// real key later does not always rewrite it. In that case the full key is
// simply not on the machine, so we ask the technician to record it and verify
// their entry against the last-5. That gives a real, auditable key→customer
// record instead of printing a placeholder.
function renderWinKeyPanel(kd, productKey) {
  const container = document.getElementById('client-win-key-container');
  const valEl = document.getElementById('client-win-key');
  if (!container || !valEl) return;
  container.classList.remove('hidden');

  const partial = kd.partialKey || '';
  let note = document.getElementById('client-win-key-note');
  if (!note && container.parentNode) {
    note = document.createElement('div');
    note.id = 'client-win-key-note';
    container.parentNode.appendChild(note);
  }

  if (kd.keyRecoverable && productKey) {
    valEl.textContent = productKey;
    valEl.style.color = '';
    if (note) {
      note.style.cssText = 'margin-top:6px;padding:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);border-radius:6px;font-size:0.72rem;color:#10b981;';
      note.textContent = '✓ Verified against this PC\'s activation record (ends ' + partial + '). This is the key that activated this installation.';
    }
    const entry = document.getElementById('winkey-entry-wrap');
    if (entry) entry.remove();
    return;
  }

  // Not recoverable — never present the decoded/generic key as the real one.
  valEl.textContent = partial ? ('•••••-•••••-•••••-•••••-' + partial) : 'Not recoverable';
  valEl.style.color = '#d97706';
  if (note) {
    note.style.cssText = 'margin-top:6px;padding:8px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:6px;font-size:0.72rem;color:#b45309;';
    note.textContent = 'Windows does not store the full key on this PC (installed with "I don\'t have a product key", so the registry holds a shared generic key). Only the last 5 characters are real: ' +
      (partial || 'unknown') + '. Type the key you used below — it will be checked against those last 5 and saved to the ticket.';
  }

  // Technician key entry + live verification against the real last-5.
  let wrap = document.getElementById('winkey-entry-wrap');
  if (!wrap && container.parentNode) {
    wrap = document.createElement('div');
    wrap.id = 'winkey-entry-wrap';
    wrap.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:6px;';
    wrap.innerHTML =
      '<label style="font-size:0.72rem;font-weight:700;color:var(--text-muted);">KEY USED TO ACTIVATE (record for this customer)</label>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<input id="winkey-entry" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" maxlength="29" autocomplete="off" ' +
      'style="flex:1 1 260px;min-width:0;font-family:\'JetBrains Mono\',monospace;text-transform:uppercase;letter-spacing:0.08em;padding:8px 10px;border-radius:6px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--text-dark);outline:none;">' +
      '</div><div id="winkey-entry-status" style="font-size:0.72rem;min-height:14px;"></div>';
    container.parentNode.appendChild(wrap);

    const input = wrap.querySelector('#winkey-entry');
    const status = wrap.querySelector('#winkey-entry-status');
    input.value = winKeyEnteredByTech || '';
    input.addEventListener('input', () => {
      let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 25);
      input.value = (v.match(/.{1,5}/g) || []).join('-');
      const clean = v;
      const realLast5 = (partial || '').toUpperCase();
      if (clean.length < 25) {
        status.textContent = clean.length ? 'Keep typing… (' + clean.length + '/25)' : '';
        status.style.color = 'var(--text-muted)';
        winKeyEnteredByTech = ''; detectedWinKey = '';
      } else if (!realLast5) {
        status.textContent = 'Saved (no activation record available to verify against).';
        status.style.color = '#d97706';
        winKeyEnteredByTech = input.value; detectedWinKey = input.value;
      } else if (clean.slice(-5) === realLast5) {
        status.textContent = '✓ Verified — matches this PC\'s activation record (' + realLast5 + ').';
        status.style.color = '#10b981';
        winKeyEnteredByTech = input.value; detectedWinKey = input.value;
      } else {
        status.textContent = '✗ Does not match this PC — Windows says the key ends in ' + realLast5 + '. Check you typed the right one.';
        status.style.color = '#ef4444';
        winKeyEnteredByTech = ''; detectedWinKey = '';
      }
      if (typeof checkClientFormReady === 'function') checkClientFormReady();
    });
  }
}
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
  // Physical-verification ticks re-evaluate the match rows live (v1.4.9)
  ['c-verify-cooler', 'c-verify-psu', 'c-verify-case'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.addEventListener('change', () => { checkSpecsMatch(); checkClientFormReady(); });
  });

  document.getElementById('btn-client-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-client-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      detectedSpecs = await ipcRenderer.invoke('sys:detect-hw');

      // v1.5.1 — full inventory (brand / model / part no. / SERIAL per part).
      // Attached to detectedSpecs so it rides the existing sync path
      // (specs.__detected) straight to the admin ticket and the QC report.
      try {
        btn.textContent = '🔍 Reading full hardware inventory…';
        const inv = await ipcRenderer.invoke('sys:hw-inventory');
        if (inv && inv.ok && inv.data) {
          detectedSpecs.inventory = inv.data;
        } else if (inv && inv.error) {
          console.warn('hw inventory unavailable:', inv.error);
        }
      } catch (e) { console.warn('hw inventory failed:', e && e.message); }
      
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
      showToast("Specs detection failed: " + err.message, 'error', 8000);
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
    
    // v1.5.1 — a key is only shown AS the customer's key when the probe
    // verified it against Windows' own activation record (last-5 ==
    // SoftwareLicensingProduct.PartialProductKey). Otherwise we say so and let
    // the technician record the key they actually typed, verified against that
    // same last-5. No generic/unverified key is ever presented as real.
    const kd = result.keyDetail || {};
    renderWinKeyPanel(kd, result.productKey);
    if (kd.keyRecoverable && result.productKey) {
      detectedWinKey = result.productKey;
    } else {
      detectedWinKey = winKeyEnteredByTech || '';
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
      // Full per-part inventory (serials / part numbers / brands). Kept on the
      // ticket so the admin panel and QC report can prove exactly which
      // physical hardware shipped.
      if (detectedSpecs.inventory) t.detectedSpecs.inventory = detectedSpecs.inventory;
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
    // v1.9.8 — do NOT close the ticket just because a Cinebench score landed.
    // Stress testing is a separate phase that ends with an explicit technician
    // sign-off; closing before that pulled the build out of the active dashboard
    // while work was still in progress, so its remaining progress could no longer
    // be tracked. It stays in 'qc_testing' until stress is signed off.
    if (isQcFull && t.diagnostics.cinebench && t.stressSignedOff) {
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
        // Back to the bench board (v1.10: there is no mode selector to return to).
        switchScreen('client');
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
    showToast('Report renderer failed to load (print-render.js) — cannot generate the QC report. Please report this to the developer.', 'error', 10000);
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
    showToast('Report generation failed: ' + e.message, 'error', 8000);
    return false;
  }
}

// v1.8.0 — the ticket as the REPORT sees it: God-Mode overrides (admin,
// Ctrl+Alt+W) merged over diagnostics. Overrides live on the ticket
// (diagnostics.__reportOverrides via sync) for the shop's own audit trail.
function reportEffectiveTicket(ticket) {
  const ov = ticket.reportOverrides;
  if (!ov || !Object.keys(ov).length) return ticket;
  const eff = JSON.parse(JSON.stringify(ticket));
  eff.diagnostics = Object.assign({}, eff.diagnostics || {}, ov);
  return eff;
}

// v1.8.0 — the customer should always see the value story. If PPI was never
// computed for this ticket, compute it now (JS engine, in-process) so the
// report's value section is populated instead of a placeholder.
async function ensurePpiForReport(ticket) {
  if (ppiCacheByTicket[ticket.id]) return;
  if (!(window.NeoQcPpiSync && window.NeoQcPpi && catalogMatcher && ticket.specs)) return;
  try {
    const useCase = (document.getElementById('modal-ppi-usecase') || {}).value || 'gaming-1440p';
    const ticketPrices = Object.assign({}, ticket.specPrices || (ticket.specs && ticket.specs.__prices) || {});
    const jsRes = await window.NeoQcPpiSync.computePpi({
      ticketSpecs: ticket.specs,
      catalogMatcher: catalogMatcher,
      useCase: useCase,
      ticketPrices: ticketPrices,
      fetchUrl: function (url) { return ipcRenderer.invoke('catalog:fetch-url', { url: url }); },
      supabaseClient: supabaseClient
    });
    if (jsRes && jsRes.success) {
      ppiCacheByTicket[ticket.id] = jsRes.payload;
      if (supabaseClient) {
        window.NeoQcPpiSync.upsertTicketPpi(supabaseClient, ticket.id, jsRes.payload).catch(() => {});
      }
    }
  } catch (e) { console.warn('report-time PPI compute skipped:', e && e.message); }
}

async function triggerPrintReport(ticketId, shouldPrint = true) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  await ensurePpiForReport(ticket);
  if (!populatePrintFields(reportEffectiveTicket(ticket))) return; // never print an unpopulated skeleton

  // Execute print in main Electron window
  if (shouldPrint) {
    ipcRenderer.invoke('sys:print');
  }
}

async function triggerSavePdf(ticketId) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  await ensurePpiForReport(ticket);
  if (!populatePrintFields(reportEffectiveTicket(ticket))) return; // never save an unpopulated skeleton

  // Save PDF filename
  const cleanName = ticket.customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const defaultFilename = `QC_Report_${cleanName}_${ticket.id.slice(-6)}.pdf`;

  const result = await ipcRenderer.invoke('sys:print-pdf', defaultFilename);
  if (result.success) {
    showToast(`PDF report saved to:\n${result.filePath}`, 'success', 7000);
  } else if (result.error !== 'Cancelled') {
    showToast(`Failed to save PDF: ${result.error}`, 'error', 8000);
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
    'btn-test-db-connection'
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
      'btn-test-db-connection'
    ];
    inputsToEnable.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.removeAttribute('disabled');
      }
    });
    showToast("Admin settings unlocked.", 'success');
  } else {
    showToast("Incorrect passcode. Access denied.", 'error');
  }
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  resetAdminLockState();
  // v1.11 — the per-PC "Technicians" list is gone: technicians claim builds
  // from the Queue, and people are managed in Settings → General → People.

  // Render PPI Engine use-case tuning table (replaces the old rival DB).
  renderPpiConfigTable();

  document.getElementById('settings-supabase-url').value = appState.settings.supabaseUrl || '';
  document.getElementById('settings-supabase-key').value = appState.settings.supabaseAnonKey || '';
  document.getElementById('settings-path-hwinfo').value = appState.settings.pathHwInfo || '';
  document.getElementById('settings-path-cinebench').value = appState.settings.pathCinebench || '';
  document.getElementById('settings-path-furmark').value = appState.settings.pathFurmark || '';
  document.getElementById('settings-path-prime95').value = appState.settings.pathPrime95 || '';
  document.getElementById('settings-path-ssd-utility').value = appState.settings.pathSsdUtility || '';
  document.getElementById('settings-auto-detect-hw').checked = !!appState.settings.autoDetectHw;

  // Populate new general settings
  document.getElementById('settings-shop-name').value = appState.settings.shopName || '';
  document.getElementById('settings-contact-info').value = appState.settings.contactInfo || '';
  renderAppearanceSettings();
  document.getElementById('settings-sound-enabled').checked = !!appState.settings.soundEnabled;
  document.getElementById('settings-disable-qc-lock').checked = !!appState.settings.disableQcLock;

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

  // v1.10 — Operations (demo data + module access). Its own function so a
  // failure there can never stop the rest of Settings from opening.
  try { renderOpsSettings(); } catch (e) { console.error('Operations settings failed to render:', e); }

  modal.classList.add('active');
}

// ── Settings → Operations (v1.10, People in v1.11) ────────────────────────────
// Three things live here, and all act straight away (not on Save):
//   (a) "Show demo service and RMA data" — a training aid for anyone who can
//       open Service or RMA. Demo data is read-only and never written to
//       Supabase (NeoQcData enforces that); this only flips the switch.
//   (b) "People" — tier 4+ only: everyone with a login, their designation,
//       tier, Active/Staff state, module roles (Service / RMA / Builds, and
//       NeoHR — set by hand only, presets never touch it), work
//       pools, build level and capacity. Writes go through NeoQcData → RPC
//       staff_update / staff_apply_preset, which check the same rules on the
//       server (tier 4 changes tier ≤ 3 accounts only; only tier 5 sets tiers;
//       nobody changes their own tier, Active, Staff or roles). A change
//       reaches that person at their next sign-in or app restart, because
//       roles are read once, at sign-in.
//   (c) "Designation presets" — tier 4+: what each designation gets.
// Every name below is staff-typed text, so the lists are built with
// textContent — never innerHTML with a value in it.
let opsSettingsSeq = 0;
const OPS_ROLE_OPTIONS = [['', '—'], ['desk', 'Desk'], ['tech', 'Tech'], ['lead', 'Lead']];
const OPS_MODULE_LABELS = { service: 'Service', rma: 'RMA', qc: 'Builds', neohr: 'NeoHR' };
// A person's roles, in the People list and its Edit dialog. NeoHR is set here
// by hand only: designation presets never touch it (sql/work-queue.sql).
const OPS_PERSON_MODULES = ['service', 'rma', 'qc', 'neohr'];
const OPS_MODAL_IDS = ['sv-job-modal', 'sv-intake-modal', 'rma-unit-modal', 'rma-intake-modal', 'ops-dialog-modal'];
const OPS_OWNER_ONLY = 'Only the owner can change a tier 4 or 5 account.';
const OPS_PEOPLE_HELP = "Create their login in Supabase → Authentication → Add user (auto-confirm; the PIN is the password). They then appear here as 'New — not staff yet'. Open them, set the designation and turn on Staff.";
let opsPeople = { rows: [], presets: [] };

function opsErrText(e) {
  if (e && e.message === 'DEMO_READONLY') return 'Demo data is on. Turn it off above to change this.';
  if (window.NeoQcUI && typeof window.NeoQcUI.errText === 'function') {
    try { return window.NeoQcUI.errText(e); } catch (x) {}
  }
  return (e && e.message) ? e.message : String(e);
}

function opsCanOpen(mode) {
  return canOpenOfficeMode(mode);
}

function renderOpsSettings() {
  const host = document.getElementById('settings-ops');
  if (!host) return;
  const seq = ++opsSettingsSeq;
  const D = window.NeoQcData;
  const tier = currentProfile ? Number(currentProfile.tier) || 0 : 0;
  const canDemo = !!(currentProfile && D && typeof D.setDemo === 'function' && typeof D.isDemo === 'function' &&
    (opsCanOpen('service') || opsCanOpen('rma')));
  const canAdmin = !!(currentProfile && D && tier >= 4 &&
    typeof D.staffList === 'function' && typeof D.staffUpdate === 'function');
  const canPresets = !!(canAdmin && typeof D.presetList === 'function');

  host.textContent = '';
  if (!canDemo && !canAdmin) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');

  // Static markup only; every person and preset is added with DOM calls below.
  host.innerHTML =
    '<div class="settings-section-title">Operations</div>' +
    '<p class="settings-section-desc">Service, RMA, builds and the work queue. These take effect straight away — no need to press Save.</p>' +
    (canDemo
      ? '<label class="settings-toggle-row">' +
          '<div class="settings-toggle-info">' +
            '<span class="settings-toggle-label">Show demo service and RMA data</span>' +
            '<span class="settings-toggle-desc">Fills the Service and RMA screens with practice tickets for training. Demo data is read-only, and your real tickets come back when you turn this off.</span>' +
          '</div>' +
          '<div class="toggle-switch">' +
            '<input type="checkbox" id="settings-ops-demo">' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
          '</div>' +
        '</label>'
      : '') +
    (canAdmin
      ? '<div class="settings-field" id="settings-ops-people" style="margin-top:14px;">' +
          '<div class="settings-label">People</div>' +
          '<p class="q-people-help">Who works here and what they can do. A person’s <strong>designation</strong> picks a preset of roles and pools; anything you set by hand for them wins. <strong>Desk</strong> takes work in and moves it on; <strong>Tech</strong> can also claim work; <strong>Lead</strong> can also offer work to people, set priority and waive fees. A <strong>NeoHR</strong> lead (for HR) sees everyone’s work logs and field activity. Tier 3 and above are leads everywhere automatically. The <strong>pools</strong> decide who claims builds and service jobs from the Queue. A change takes effect for that person at their next sign-in or app restart.</p>' +
          '<p class="q-people-help" id="settings-ops-people-add"><strong>Adding someone:</strong> </p>' +
          '<div class="q-people-bar">' +
            '<input type="text" id="settings-ops-people-search" class="settings-input" placeholder="Search people by name, email or designation…" autocomplete="off" spellcheck="false">' +
            '<button type="button" id="settings-ops-people-reload" class="secondary-btn">↻ Reload</button>' +
          '</div>' +
          '<div id="settings-ops-people-list" class="q-people-list"></div>' +
          '<div id="settings-ops-people-status" class="settings-field-note" role="status" aria-live="polite"></div>' +
        '</div>' +
        (canPresets
          ? '<div class="settings-field" id="settings-ops-presets" style="margin-top:14px;">' +
              '<div class="settings-label">Designation presets</div>' +
              '<p class="q-people-help">What each designation gets: its Service, RMA and Builds roles, the work pools, the build level and capacity. A preset is applied when you set or change someone’s designation, or press <strong>Apply preset</strong>; anything set by hand for a person wins. Removing a role in a preset removes it from people when the preset is applied. Presets never change anyone’s NeoHR role.</p>' +
              '<div class="q-people-bar"><button type="button" id="settings-ops-preset-add" class="secondary-btn">+ Add preset</button></div>' +
              '<div id="settings-ops-presets-list" class="q-people-list"></div>' +
            '</div>'
          : '')
      : '');

  const addHelp = document.getElementById('settings-ops-people-add');
  if (addHelp) addHelp.appendChild(document.createTextNode(OPS_PEOPLE_HELP));

  // Scanner rule: Enter in an input here must never do anything. The host
  // outlives each render, so the guard is bound once.
  if (!host.dataset.enterGuard) {
    host.dataset.enterGuard = '1';
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
      if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
    });
  }

  if (canDemo) bindOpsDemoToggle(D);
  if (canAdmin) {
    const reload = document.getElementById('settings-ops-people-reload');
    if (reload) reload.addEventListener('click', () => loadOpsPeople(opsSettingsSeq, D));
    const search = document.getElementById('settings-ops-people-search');
    if (search) search.addEventListener('input', () => filterOpsPeople());
    const addPreset = document.getElementById('settings-ops-preset-add');
    if (addPreset) addPreset.addEventListener('click', () => editOpsPreset(null, D));
    loadOpsPeople(seq, D);
  }
}

function bindOpsDemoToggle(D) {
  const demoEl = document.getElementById('settings-ops-demo');
  if (!demoEl) return;
  try { demoEl.checked = !!D.isDemo(); } catch (e) { demoEl.checked = false; }
  demoEl.addEventListener('change', async () => {
    const on = demoEl.checked;
    // Swapping every cache under an open ticket would leave that panel
    // editing a row that no longer exists in what it is showing.
    const openModal = OPS_MODAL_IDS.some(id => {
      const m = document.getElementById(id);
      return !!(m && m.classList.contains('active'));
    });
    if (openModal) {
      demoEl.checked = !on;
      showToast('Close the open ticket or form first, then switch demo data.', 'warning');
      return;
    }
    demoEl.disabled = true;
    try {
      await Promise.resolve(D.setDemo(on));
      rerenderOpsScreen();
      if (window.NeoQcShell && typeof window.NeoQcShell.refreshRail === 'function') window.NeoQcShell.refreshRail();
      showToast(on
        ? 'Showing demo service and RMA data. It is read-only.'
        : 'Demo data is off. You are working on real tickets.', on ? 'warning' : 'success');
    } catch (e) {
      try { demoEl.checked = !!D.isDemo(); } catch (x) { demoEl.checked = !on; }
      showToast('Could not switch demo data: ' + opsErrText(e), 'error');
    } finally {
      demoEl.disabled = false;
    }
  });
}

// Repaint whichever ops screen is behind the Settings modal, from the caches
// the demo switch just replaced.
function rerenderOpsScreen() {
  const warn = (what) => (e) => {
    console.warn(what + ' reload failed:', e && e.message);
    showToast('Could not refresh the ' + what + ' screen: ' + opsErrText(e), 'error');
  };
  if (currentMode === 'service' && window.NeoQcServiceUI && window.NeoQcServiceUI.ensureServiceLoaded) {
    Promise.resolve().then(() => window.NeoQcServiceUI.ensureServiceLoaded()).catch(warn('Service'));
  } else if (currentMode === 'rma' && window.NeoQcRmaUI && window.NeoQcRmaUI.ensureLoaded) {
    Promise.resolve().then(() => window.NeoQcRmaUI.ensureLoaded()).catch(warn('RMA'));
  } else if (currentMode === 'overview' && window.NeoQcShell && window.NeoQcShell.ensureOverviewLoaded) {
    Promise.resolve().then(() => window.NeoQcShell.ensureOverviewLoaded()).catch(warn('Overview'));
  } else if (currentMode === 'neohr' && window.NeoQcHr && window.NeoQcHr.refresh) {
    // Its team cards leave out service jobs while demo data is on.
    Promise.resolve().then(() => window.NeoQcHr.refresh()).catch(warn('NeoHR'));
  }
}

// ── People (tier 4+) ──────────────────────────────────────────────────────────
function opsNorm(res, key) {
  if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = null; } }
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res[key])) return res[key];
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

function opsSay(text, isError) {
  const status = document.getElementById('settings-ops-people-status');
  if (!status) return;
  status.textContent = text || '';
  status.style.color = isError ? 'var(--status-urgent)' : '';
}

function opsListMessage(listEl, text) {
  if (!listEl) return;
  listEl.textContent = '';
  const d = document.createElement('div');
  d.className = 'q-empty';
  d.textContent = text;
  listEl.appendChild(d);
}

function opsNode(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function opsTag(text, cls) { return opsNode('span', 'q-role' + (cls ? ' ' + cls : ''), text); }

function opsField(label, control, opts) {
  opts = opts || {};
  const lab = opsNode('label', 'ops-field' + (opts.wide ? ' ops-span2' : ''));
  lab.appendChild(opsNode('span', null, label));
  lab.appendChild(control);
  if (opts.hint) lab.appendChild(opsNode('p', 'ops-hint', opts.hint));
  return lab;
}

function opsInput(type, value, max) {
  const i = document.createElement('input');
  i.type = type;
  if (value != null) i.value = String(value);
  if (max && type === 'text') i.maxLength = max;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
}

function opsCheck(label, checked, disabled, title) {
  const lab = opsNode('label', 'ops-check');
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = !!checked;
  c.disabled = !!disabled;
  if (title) lab.title = title;
  lab.appendChild(c);
  lab.appendChild(opsNode('span', null, label));
  return { label: lab, input: c };
}

function opsSelect(options, value, disabled) {
  const s = document.createElement('select');
  options.forEach(([v, l]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    s.appendChild(o);
  });
  s.value = value == null ? '' : String(value);
  s.disabled = !!disabled;
  return s;
}

function opsViewerTier() { return currentProfile ? Number(currentProfile.tier) || 0 : 0; }
function opsIsSelf(r) {
  return !!currentProfile && String(r.email || '').trim().toLowerCase() === String(currentProfile.email || '').trim().toLowerCase();
}
// '' when this viewer may change this person; otherwise the reason (the
// server's own rule: a tier-4 caller changes tier ≤ 3 accounts only — new
// sign-ups included — and anyone may change their own few fields).
function opsChangeBlock(r) {
  const vt = opsViewerTier();
  if (vt < 4) return 'Only tier 4 and above can manage people.';
  if (opsIsSelf(r) || vt >= 5) return '';
  return Number(r.tier) >= 4 ? OPS_OWNER_ONLY : '';
}

function opsRoleLabel(role) {
  const o = OPS_ROLE_OPTIONS.find(x => x[0] === role);
  return o && role ? o[1] : '—';
}
function opsLevelLabel(l) { return l === 'senior' ? 'Senior' : l === 'junior' ? 'Junior' : ''; }

async function loadOpsPeople(seq, D) {
  const list = document.getElementById('settings-ops-people-list');
  if (!list) return;
  const presetsList = document.getElementById('settings-ops-presets-list');
  opsListMessage(list, 'Loading people…');
  if (presetsList) opsListMessage(presetsList, 'Loading presets…');
  let rows;
  try {
    rows = opsNorm(await D.staffList(), 'people');
  } catch (e) {
    if (seq !== opsSettingsSeq) return;   // Settings was reopened meanwhile
    opsListMessage(list, 'Could not load people: ' + opsErrText(e));
    if (presetsList) opsListMessage(presetsList, 'Could not load the presets either.');
    return;
  }
  if (seq !== opsSettingsSeq) return;
  let presets = null;
  if (typeof D.presetList === 'function') {
    try { presets = opsNorm(await D.presetList(), 'presets'); }
    catch (e) {
      if (seq !== opsSettingsSeq) return;
      if (presetsList) opsListMessage(presetsList, 'Could not load the presets: ' + opsErrText(e));
    }
  }
  if (seq !== opsSettingsSeq) return;
  opsPeople.rows = rows.filter(r => r && r.email).map(r => Object.assign({}, r));
  if (presets) opsPeople.presets = presets.filter(p => p && p.designation).map(p => Object.assign({}, p));
  renderOpsPeople(D);
  if (presets) renderOpsPresets(D);
}

function opsPeopleSorted() {
  // "New — not staff yet" first (they are waiting for someone to set them
  // up), then active people by name, then the ones who have left.
  const rank = r => (r.is_staff === false ? 0 : r.active === false ? 2 : 1);
  return opsPeople.rows.slice().sort((a, b) =>
    rank(a) - rank(b) || String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
}

function renderOpsPeople(D) {
  const list = document.getElementById('settings-ops-people-list');
  if (!list) return;
  list.textContent = '';
  const rows = opsPeopleSorted();
  if (!rows.length) { opsListMessage(list, 'Nobody has a login yet.'); return; }
  rows.forEach(r => list.appendChild(buildOpsPersonRow(r, D)));
  filterOpsPeople();
}

function filterOpsPeople() {
  const list = document.getElementById('settings-ops-people-list');
  const search = document.getElementById('settings-ops-people-search');
  if (!list) return;
  const q = search ? search.value.trim().toLowerCase() : '';
  list.querySelectorAll('[data-hay]').forEach(row => {
    row.classList.toggle('hidden', !!q && row.dataset.hay.indexOf(q) === -1);
  });
}

function buildOpsPersonRow(r, D) {
  const row = opsNode('div', 'q-prow' + (r.is_staff === false ? ' is-new' : '') + (r.active === false ? ' is-inactive' : ''));
  row.dataset.hay = [r.full_name, r.email, r.designation, r.department].filter(Boolean).join(' ').toLowerCase();
  const tier = Number(r.tier) || 1;
  const auto = tier >= 3 || !!r.auto_lead;

  const who = opsNode('div');
  who.appendChild(opsNode('div', 'q-prow-name', r.full_name || r.email));
  who.appendChild(opsNode('div', 'q-prow-sub', [r.email, r.designation, 'Tier ' + tier, r.department].filter(Boolean).join(' · ')));
  row.appendChild(who);

  const tags = opsNode('div', 'q-prow-tags');
  if (r.is_staff === false) tags.appendChild(opsTag('New — not staff yet', 'is-new'));
  else if (r.active === false) tags.appendChild(opsTag('Inactive', 'is-off'));
  OPS_PERSON_MODULES.forEach(m => {
    const role = auto ? 'Lead (auto)' : opsRoleLabel(r.roles && r.roles[m]);
    tags.appendChild(opsTag(OPS_MODULE_LABELS[m] + ': ' + role, auto ? 'is-auto' : ''));
  });
  if (r.build_pool) tags.appendChild(opsTag('Builds pool' + (opsLevelLabel(r.build_level) ? ' · ' + opsLevelLabel(r.build_level) : ''), 'is-pool'));
  if (r.service_pool) tags.appendChild(opsTag('Service pool', 'is-pool'));
  if (r.build_pool || r.service_pool) {
    tags.appendChild(opsTag((Number(r.capacity_points) || 0) + ' pts · ' + (Number(r.max_jobs) || 0) + ' jobs'));
  }
  if (Number(r.open_items) > 0) tags.appendChild(opsTag(Number(r.open_items) + ' open'));
  row.appendChild(tags);

  const acts = opsNode('div', 'q-prow-acts');
  const block = opsChangeBlock(r);
  const edit = opsNode('button', 'secondary-btn', 'Edit…');
  edit.type = 'button';
  edit.disabled = !!block;
  edit.title = block || ('Edit ' + (r.full_name || r.email));
  edit.addEventListener('click', () => editOpsPerson(r, D));
  acts.appendChild(edit);
  if (typeof D.staffApplyPreset === 'function') {
    const ap = opsNode('button', 'secondary-btn', 'Apply preset');
    ap.type = 'button';
    ap.disabled = !!block || !r.designation;
    ap.title = block || (r.designation ? 'Set roles and pools from the “' + r.designation + '” preset' : 'Set a designation first');
    ap.addEventListener('click', () => applyOpsPreset(r, D));
    acts.appendChild(ap);
  }
  row.appendChild(acts);
  return row;
}

async function editOpsPerson(r, D) {
  const email = r.email;                     // bound before any await
  const who = r.full_name || r.email;
  const seq = opsSettingsSeq;
  const UI = window.NeoQcUI;
  if (!UI || typeof UI.dialog !== 'function') { showToast('Dialogs are not available — restart Neo OS.', 'error'); return; }
  const block = opsChangeBlock(r);
  if (block) { showToast(block, 'warning'); return; }
  const self = opsIsSelf(r);
  const vt = opsViewerTier();
  const tier = Number(r.tier) || 1;
  const auto = tier >= 3 || !!r.auto_lead;
  const selfNote = 'You can’t change this on your own account.';

  const body = opsNode('div', 'q-dlg');
  const grid = opsNode('div', 'ops-grid');
  const inName = opsInput('text', r.full_name || '', 120);
  const inDesig = opsInput('text', r.designation || '', 120);
  const listId = 'q-desig-list-' + Date.now().toString(36);
  inDesig.setAttribute('list', listId);
  const dl = document.createElement('datalist');
  dl.id = listId;
  (opsPeople.presets || []).forEach(p => { const o = document.createElement('option'); o.value = p.designation; dl.appendChild(o); });
  const inDept = opsInput('text', r.department || '', 60);
  grid.appendChild(opsField('Full name', inName, { wide: true }));
  grid.appendChild(opsField('Designation', inDesig, { hint: 'Pick a preset’s designation to give them its roles and pools.' }));
  grid.appendChild(opsField('Department', inDept));
  let tierSel = null;
  if (vt >= 5) {
    const opts = [1, 2, 3, 4, 5].filter(n => n <= vt).map(n => [String(n), 'Tier ' + n + (n >= 3 ? ' — lead everywhere' : '')]);
    tierSel = opsSelect(opts, String(tier), self);
    if (self) tierSel.title = selfNote;
    grid.appendChild(opsField('Tier', tierSel, { hint: self ? selfNote : 'Tier 3 and above are leads in every module; tier 4 and above manage people.' }));
  } else {
    const ro = opsInput('text', 'Tier ' + tier);
    ro.readOnly = true;
    grid.appendChild(opsField('Tier', ro, { hint: 'Only the owner (tier 5) changes tiers.' }));
  }
  body.appendChild(grid);
  body.appendChild(dl);

  const chkActive = opsCheck('Active — can sign in', r.active !== false, self, self ? selfNote : '');
  const chkStaff = opsCheck('Staff — works in Neo OS (off for a new sign-up until set up)', !!r.is_staff, self, self ? selfNote : '');
  body.appendChild(chkActive.label);
  body.appendChild(chkStaff.label);

  body.appendChild(opsNode('div', 'ops-section-title', 'Roles'));
  const roleSel = {};
  const roles = opsNode('div', 'hr-roles-grid');
  OPS_PERSON_MODULES.forEach(m => {
    if (auto) {
      const ro = opsInput('text', 'Lead (automatic)');
      ro.readOnly = true;
      roles.appendChild(opsField(OPS_MODULE_LABELS[m], ro));
    } else {
      roleSel[m] = opsSelect(OPS_ROLE_OPTIONS, (r.roles && r.roles[m]) || '', self);
      if (self) roleSel[m].title = selfNote;
      roles.appendChild(opsField(OPS_MODULE_LABELS[m], roleSel[m]));
    }
  });
  body.appendChild(roles);
  if (auto) body.appendChild(opsNode('p', 'ops-hint', 'Tier 3 and above are leads in every module automatically.'));
  else if (self) body.appendChild(opsNode('p', 'ops-hint', 'Your own roles are changed by someone senior to you.'));
  body.appendChild(opsNode('p', 'ops-hint', 'NeoHR: Lead sees everyone’s work logs and field activity (the NeoHR screen here, and the Team view on the phone). Presets never change it.'));

  body.appendChild(opsNode('div', 'ops-section-title', 'Work queue'));
  const chkBP = opsCheck('Build pool — can claim builds from the Queue', !!r.build_pool);
  const chkSP = opsCheck('Service pool — can claim service jobs from the Queue', !!r.service_pool);
  body.appendChild(chkBP.label);
  body.appendChild(chkSP.label);
  const wq = opsNode('div', 'q-dlg-grid3');
  const selLevel = opsSelect([['', '—'], ['junior', 'Junior'], ['senior', 'Senior']], r.build_level || '');
  const inCap = opsInput('number', r.capacity_points != null ? r.capacity_points : '');
  inCap.min = '1'; inCap.max = '50'; inCap.step = '1';
  const inMax = opsInput('number', r.max_jobs != null ? r.max_jobs : '');
  inMax.min = '1'; inMax.max = '20'; inMax.step = '1';
  wq.appendChild(opsField('Build level', selLevel, { hint: 'High-value builds (tier 4–5) go to seniors only.' }));
  wq.appendChild(opsField('Capacity (points)', inCap, { hint: '1–50. A build costs its tier; a service job 1, on-site 2.' }));
  wq.appendChild(opsField('Most jobs at once', inMax, { hint: '1–20.' }));
  body.appendChild(wq);

  const chkPreset = opsCheck('Apply the designation preset (its roles, pools, level and capacity; anything you changed above wins)', true);
  chkPreset.label.classList.add('hidden');
  body.appendChild(chkPreset.label);
  const origDesig = String(r.designation || '').trim();
  inDesig.addEventListener('input', () => {
    const changed = inDesig.value.trim() !== origDesig;
    if (changed && chkPreset.label.classList.contains('hidden')) chkPreset.input.checked = true;
    chkPreset.label.classList.toggle('hidden', !changed);
  });
  body.appendChild(opsNode('p', 'ops-hint', 'Changes reach ' + who + ' at their next sign-in or app restart.'));

  await UI.dialog({
    title: 'Edit ' + who,
    sub: email,
    body,
    wide: true,
    okText: 'Save',
    busyText: 'Saving…',
    onOk: async () => {
      if (seq !== opsSettingsSeq) return false;
      const patch = {};
      const nm = inName.value.trim();
      if (!nm || nm.length > 120) return 'The name must be 1 to 120 characters.';
      if (nm !== String(r.full_name || '')) patch.full_name = nm;
      const dg = inDesig.value.trim();
      if (dg.length > 120) return 'Keep the designation under 120 characters.';
      if (dg !== origDesig) patch.designation = dg;
      const dp = inDept.value.trim();
      if (dp.length > 60) return 'Keep the department under 60 characters.';
      if (dp !== String(r.department || '')) patch.department = dp;
      if (tierSel && !self) {
        const tv = Number(tierSel.value);
        if (tv !== tier) patch.tier = tv;
      }
      if (!self) {
        if (chkActive.input.checked !== (r.active !== false)) patch.active = chkActive.input.checked;
        if (chkStaff.input.checked !== !!r.is_staff) patch.is_staff = chkStaff.input.checked;
        if (!auto) {
          const changedRoles = {};
          OPS_PERSON_MODULES.forEach(m => {
            const v = roleSel[m] ? (roleSel[m].value || null) : null;
            const was = (r.roles && r.roles[m]) || null;
            if (roleSel[m] && v !== was) changedRoles[m] = v;
          });
          if (Object.keys(changedRoles).length) patch.roles = changedRoles;
        }
      }
      if (chkBP.input.checked !== !!r.build_pool) patch.build_pool = chkBP.input.checked;
      if (chkSP.input.checked !== !!r.service_pool) patch.service_pool = chkSP.input.checked;
      const lv = selLevel.value || null;
      if (lv !== (r.build_level || null)) patch.build_level = lv;
      if (inCap.value !== '' || r.capacity_points != null) {
        const cp = parseInt(inCap.value, 10);
        if (!(cp >= 1 && cp <= 50)) return 'Capacity must be 1 to 50 points.';
        if (cp !== Number(r.capacity_points)) patch.capacity_points = cp;
      }
      if (inMax.value !== '' || r.max_jobs != null) {
        const mj = parseInt(inMax.value, 10);
        if (!(mj >= 1 && mj <= 20)) return 'Most jobs at once must be 1 to 20.';
        if (mj !== Number(r.max_jobs)) patch.max_jobs = mj;
      }
      if (patch.designation !== undefined && chkPreset.input.checked) patch.apply_preset = true;
      if (!Object.keys(patch).length) { opsSay('Nothing changed.'); return true; }
      if (patch.active === false || patch.is_staff === false) {
        const ok = await showConfirm('Turn off ' + who + '? Everything they hold goes back to the queue, and offers to them end.',
          { title: 'Turn off ' + who, okText: 'Turn off', danger: true });
        if (!ok) return false;
      }
      const res = await D.staffUpdate(email, patch);
      if (seq !== opsSettingsSeq) return true;
      const entry = (res && res.email) ? res : (res && res.person && res.person.email ? res.person : null);
      if (entry) {
        const i = opsPeople.rows.findIndex(x => String(x.email).toLowerCase() === String(email).toLowerCase());
        if (i !== -1) opsPeople.rows[i] = Object.assign({}, entry);
        renderOpsPeople(D);
      } else {
        loadOpsPeople(opsSettingsSeq, D);
      }
      opsSay('Saved. ' + (entry && entry.full_name || who) + ' gets the change at their next sign-in or app restart.');
      return true;
    }
  });
}

async function applyOpsPreset(r, D) {
  const email = r.email;                     // bound before any await
  const who = r.full_name || r.email;
  const seq = opsSettingsSeq;
  const block = opsChangeBlock(r);
  if (block) { showToast(block, 'warning'); return; }
  const ok = await showConfirm('Apply the “' + (r.designation || '') + '” preset to ' + who + '? Their Service, RMA and Builds roles, pools, build level and capacity are set from it. Their NeoHR role stays as it is.',
    { title: 'Apply preset', okText: 'Apply' });
  if (!ok || seq !== opsSettingsSeq) return;
  opsSay('Applying the preset…');
  try {
    const res = await D.staffApplyPreset(email);
    if (seq !== opsSettingsSeq) return;
    if (res && res.applied) opsSay('Applied. ' + who + ' gets it at their next sign-in or app restart.');
    else opsSay('No preset matches ' + who + '’s designation, so nothing changed.', true);
    loadOpsPeople(opsSettingsSeq, D);
  } catch (e) {
    if (seq !== opsSettingsSeq) return;
    opsSay('Not applied: ' + opsErrText(e), true);
  }
}

// ── Designation presets (tier 4+) ─────────────────────────────────────────────
function renderOpsPresets(D) {
  const list = document.getElementById('settings-ops-presets-list');
  if (!list) return;
  list.textContent = '';
  const rows = (opsPeople.presets || []).slice().sort((a, b) => String(a.designation).localeCompare(String(b.designation)));
  if (!rows.length) { opsListMessage(list, 'No presets yet. Add one for each designation.'); return; }
  rows.forEach(p => list.appendChild(buildOpsPresetRow(p, D)));
}

function buildOpsPresetRow(p, D) {
  const row = opsNode('div', 'q-prow');
  const who = opsNode('div');
  who.appendChild(opsNode('div', 'q-prow-name', p.designation));
  const n = (opsPeople.rows || []).filter(r => r.preset_key && r.preset_key === p.key).length;
  who.appendChild(opsNode('div', 'q-prow-sub', [n + (n === 1 ? ' person' : ' people'), p.note].filter(Boolean).join(' · ')));
  row.appendChild(who);
  const tags = opsNode('div', 'q-prow-tags');
  [['service', 'service_role'], ['rma', 'rma_role'], ['qc', 'qc_role']].forEach(([m, k]) => {
    tags.appendChild(opsTag(OPS_MODULE_LABELS[m] + ': ' + opsRoleLabel(p[k])));
  });
  if (p.build_pool) tags.appendChild(opsTag('Builds pool' + (opsLevelLabel(p.build_level) ? ' · ' + opsLevelLabel(p.build_level) : ''), 'is-pool'));
  if (p.service_pool) tags.appendChild(opsTag('Service pool', 'is-pool'));
  if (p.build_pool || p.service_pool) {
    tags.appendChild(opsTag((p.capacity_points != null ? p.capacity_points + ' pts' : 'level default pts') + ' · ' +
      (p.max_jobs != null ? p.max_jobs + ' jobs' : 'level default jobs')));
  }
  row.appendChild(tags);
  const acts = opsNode('div', 'q-prow-acts');
  const edit = opsNode('button', 'secondary-btn', 'Edit…');
  edit.type = 'button';
  edit.disabled = typeof D.presetUpsert !== 'function';
  edit.addEventListener('click', () => editOpsPreset(p, D));
  const del = opsNode('button', 'secondary-btn text-crimson', 'Delete');
  del.type = 'button';
  del.disabled = typeof D.presetDelete !== 'function';
  del.addEventListener('click', () => deleteOpsPreset(p, D));
  acts.append(edit, del);
  row.appendChild(acts);
  return row;
}

async function editOpsPreset(p, D) {
  const key = p ? p.key : null;              // bound before any await
  const seq = opsSettingsSeq;
  const UI = window.NeoQcUI;
  if (!UI || typeof UI.dialog !== 'function') { showToast('Dialogs are not available — restart Neo OS.', 'error'); return; }
  if (typeof D.presetUpsert !== 'function') { showToast('This needs the Neo OS 1.11 data layer.', 'error'); return; }
  const cur = p || {};
  const body = opsNode('div', 'q-dlg');
  const grid = opsNode('div', 'ops-grid');
  const inDesig = opsInput('text', cur.designation || '', 120);
  if (p) inDesig.readOnly = true;
  grid.appendChild(opsField('Designation', inDesig, {
    wide: true,
    hint: p ? 'To rename a designation, add a new preset and delete this one.' : 'Exactly as it is written on people’s profiles.'
  }));
  body.appendChild(grid);
  body.appendChild(opsNode('div', 'ops-section-title', 'Roles'));
  const roles = opsNode('div', 'q-dlg-grid3');
  const sel = {};
  [['service', 'service_role'], ['rma', 'rma_role'], ['qc', 'qc_role']].forEach(([m, k]) => {
    sel[k] = opsSelect(OPS_ROLE_OPTIONS, cur[k] || '');
    roles.appendChild(opsField(OPS_MODULE_LABELS[m], sel[k]));
  });
  body.appendChild(roles);
  body.appendChild(opsNode('p', 'ops-hint', '— means no role: applying the preset removes that module from the person. Tier 3 and above stay leads everywhere.'));
  body.appendChild(opsNode('div', 'ops-section-title', 'Work queue'));
  const chkBP = opsCheck('Build pool', !!cur.build_pool);
  const chkSP = opsCheck('Service pool', !!cur.service_pool);
  body.appendChild(chkBP.label);
  body.appendChild(chkSP.label);
  const wq = opsNode('div', 'q-dlg-grid3');
  const selLevel = opsSelect([['', '—'], ['junior', 'Junior'], ['senior', 'Senior']], cur.build_level || '');
  const inCap = opsInput('number', cur.capacity_points != null ? cur.capacity_points : '');
  inCap.min = '1'; inCap.max = '50'; inCap.placeholder = 'level default';
  const inMax = opsInput('number', cur.max_jobs != null ? cur.max_jobs : '');
  inMax.min = '1'; inMax.max = '20'; inMax.placeholder = 'level default';
  wq.appendChild(opsField('Build level', selLevel));
  wq.appendChild(opsField('Capacity (points)', inCap, { hint: 'Blank: senior 8, junior 5, otherwise 6.' }));
  wq.appendChild(opsField('Most jobs at once', inMax, { hint: 'Blank: senior 5, junior 3, otherwise 4.' }));
  body.appendChild(wq);
  const inNote = opsInput('text', cur.note || '', 300);
  body.appendChild(opsField('Note', inNote, { hint: 'Optional — for whoever edits presets next.' }));

  await UI.dialog({
    title: p ? 'Edit preset' : 'Add a designation preset',
    sub: p ? p.designation : '',
    body,
    wide: true,
    okText: 'Save preset',
    busyText: 'Saving…',
    onOk: async () => {
      if (seq !== opsSettingsSeq) return false;
      const designation = inDesig.value.trim();
      if (!designation) return 'Type the designation.';
      if (designation.length > 120) return 'Keep the designation under 120 characters.';
      const num = (el, lo, hi, what) => {
        if (el.value === '') return { v: null };
        const n = parseInt(el.value, 10);
        if (!(n >= lo && n <= hi)) return { err: what + ' must be ' + lo + ' to ' + hi + ', or blank.' };
        return { v: n };
      };
      const cap = num(inCap, 1, 50, 'Capacity');
      if (cap.err) return cap.err;
      const mx = num(inMax, 1, 20, 'Most jobs at once');
      if (mx.err) return mx.err;
      const payload = {
        designation,
        service_role: sel.service_role.value || null,
        rma_role: sel.rma_role.value || null,
        qc_role: sel.qc_role.value || null,
        build_pool: chkBP.input.checked,
        service_pool: chkSP.input.checked,
        build_level: selLevel.value || null,
        capacity_points: cap.v,
        max_jobs: mx.v,
        note: inNote.value.trim() || null
      };
      if (key) payload.key = key;
      await D.presetUpsert(payload);
      if (seq !== opsSettingsSeq) return true;
      opsSay('Preset saved. It is used the next time someone is given “' + designation + '”, or when you press Apply preset.');
      loadOpsPeople(opsSettingsSeq, D);
      return true;
    }
  });
}

async function deleteOpsPreset(p, D) {
  const key = p.key;                         // bound before any await
  const seq = opsSettingsSeq;
  if (typeof D.presetDelete !== 'function') return;
  const ok = await showConfirm('Delete the “' + p.designation + '” preset? People who have it keep their roles and pools; it just stops being applied.',
    { title: 'Delete preset', okText: 'Delete', danger: true });
  if (!ok || seq !== opsSettingsSeq) return;
  try {
    await D.presetDelete(key);
    if (seq !== opsSettingsSeq) return;
    opsSay('Preset deleted.');
    loadOpsPeople(opsSettingsSeq, D);
  } catch (e) {
    if (seq !== opsSettingsSeq) return;
    opsSay('Not deleted: ' + opsErrText(e), true);
    showToast('Could not delete the preset: ' + opsErrText(e), 'error');
  }
}

async function handleSaveSettings() {
  appState.settings.supabaseUrl = document.getElementById('settings-supabase-url').value.trim();
  appState.settings.supabaseAnonKey = document.getElementById('settings-supabase-key').value.trim();
  appState.settings.pathHwInfo = document.getElementById('settings-path-hwinfo').value.trim();
  appState.settings.pathCinebench = document.getElementById('settings-path-cinebench').value.trim();
  appState.settings.pathFurmark = document.getElementById('settings-path-furmark').value.trim();
  appState.settings.pathPrime95 = document.getElementById('settings-path-prime95').value.trim();
  appState.settings.pathSsdUtility = document.getElementById('settings-path-ssd-utility').value.trim();
  appState.settings.autoDetectHw = document.getElementById('settings-auto-detect-hw').checked;

  // Save new settings
  appState.settings.shopName = document.getElementById('settings-shop-name').value.trim();
  appState.settings.contactInfo = document.getElementById('settings-contact-info').value.trim();
  appState.settings.soundEnabled = document.getElementById('settings-sound-enabled').checked;
  appState.settings.disableQcLock = document.getElementById('settings-disable-qc-lock').checked;
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

  await saveDatabase();
  document.getElementById('settings-modal').classList.remove('active');
  
  if (currentMode === 'staff') {
    renderDashboard();
  } else if (currentMode === 'client' || currentMode === 'client-console') {
    handleClientTicketSelect();
  }

  // v1.10 — saving Settings keeps you on the screen you opened it from (it is
  // on the rail and on the bench). It used to route through the mode selector
  // or the per-PC "Master mode" switch; both are gone.
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
    // "← <home>" — back to the screen sign-in sends this person to.
    welcomeExit.addEventListener('click', () => {
      goHome();
    });
  }

  // v1.10 — bench → service queue. switchScreen's registry gate decides; the
  // button is only shown to service techs and leads (see the 'client' branch).
  const welcomeService = document.getElementById('btn-welcome-service');
  if (welcomeService) {
    welcomeService.addEventListener('click', () => {
      switchScreen('service');
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

  // Theme toggle on the Builds header: a quick light/dark flip. The full choice
  // (incl. "Match Windows") is Settings → Appearance; both write the same setting.
  document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    setThemeChoice(document.body.classList.contains('dark-mode') ? 'light' : 'dark');
  });
  setupAppearanceSettings();

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
    if (await showConfirm("This will overwrite your current tickets with mock demo data. Proceed?", { title: 'Reseed demo data', okText: 'Overwrite', danger: true })) {
      seedMockTickets();
      await saveDatabase();
      document.getElementById('settings-modal').classList.remove('active');
      renderDashboard();
      showToast("Mock database reseeded successfully.", 'success');
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
        showToast("Deadline unlocked. You can now modify the target date.", 'success');
      } else {
        showToast("Incorrect password. Deadline locked.", 'error');
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

  // v1.11 — the ticket's technician box (Claim / Offer / Withdraw / Hand back /
  // Send to build queue); the per-PC "Add technician" control is gone.
  setupTechAreaButtons();

  // PPI tuning panel handlers (add use-case / save / reset).
  setupPpiTuningHandlers();

  // Ticket create/edit actions
  document.getElementById('btn-new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('btn-close-ticket-modal').addEventListener('click', requestCloseTicketModal);
  document.getElementById('btn-cancel-ticket').addEventListener('click', requestCloseTicketModal);
  // QoL (v1.9.5) — any edit inside the ticket modal marks it dirty so the
  // close/cancel guard can warn before discarding unsaved work.
  const tModal = document.getElementById('ticket-modal');
  tModal.addEventListener('input', () => { ticketFormDirty = true; });
  tModal.addEventListener('change', () => { ticketFormDirty = true; });
  document.getElementById('btn-reload-conflict-form').addEventListener('click', () => {
    if (editingTicketId) openTicketModal(editingTicketId);
  });
  document.getElementById('btn-dismiss-conflict-banner').addEventListener('click', hideConflictBanner);
  document.getElementById('btn-delete-ticket').addEventListener('click', async () => {
    // v1.11 — Builds leads only (the button is hidden for everyone else).
    if (!hasQcRole('lead')) { showToast('Only a Builds lead can delete a build.', 'warning'); return; }
    if (editingTicketId && await showConfirm("Are you sure you want to delete this ticket?", { title: 'Delete ticket', okText: 'Delete', danger: true })) {
      const idToDelete = editingTicketId;
      appState.tickets = appState.tickets.filter(t => t.id !== idToDelete);
      removePendingQueueSend(idToDelete, true);   // a deleted build is never sent to the floor
      await saveDatabase();
      await deleteTicketFromCloud(idToDelete);
      document.getElementById('ticket-modal').classList.remove('active');
      renderDashboard();
    }
  });

  var _svcBtn = document.getElementById("btn-open-service");
  if (_svcBtn) _svcBtn.addEventListener("click", function () { switchScreen("service"); });

  const _ticketForm = document.getElementById('ticket-form');

  // ── The ticket saves ONLY when someone activates Save ────────────────────
  // v1.9.9 guarded Enter inside the scan fields, and it was still possible to
  // save by scanning: a USB scanner's terminator is configurable, and a Tab
  // suffix walks focus forward until it lands on #btn-save-ticket, where the
  // scanner's own Enter (or the next scan's terminator) activates it — a real
  // click, which no key handler can distinguish from a deliberate one.
  //
  // So the key handling below is now only about WHERE FOCUS GOES. Whether the
  // ticket is allowed to save is decided here, structurally: implicit
  // submission is refused outright, and only a genuine activation of the Save
  // button sets the intent flag. This holds for every scanner configuration,
  // every key, and every field — present and future.
  let _saveIntent = false;
  const _saveBtn = document.getElementById('btn-save-ticket');
  if (_saveBtn) {
    // 'click' covers mouse, touch, and keyboard activation of the button, and
    // always fires before 'submit'.
    _saveBtn.addEventListener('click', () => { _saveIntent = true; });
  }
  _ticketForm.addEventListener('submit', (e) => {
    if (!_saveIntent) {
      // Implicit submission — a stray Enter somewhere in the form. Never save.
      e.preventDefault();
      return;
    }
    _saveIntent = false;
    return handleTicketFormSubmit(e);
  });

  // ── Barcode scanners must not save the ticket ────────────────────────────
  // A scanner is a keyboard: it types the serial, then sends Enter. Enter inside
  // a field of a form that HAS a submit button (#btn-save-ticket, index.html:1478)
  // fires the browser's implicit submission — so every single scan was running
  // handleTicketFormSubmit, saving the ticket and closing the modal, throwing the
  // technician back to the dashboard mid-scan.
  //
  // Nothing in this form needs Enter: every field commits on 'input' (see the
  // .cv-scan handler and setupProcurement), and the two fields that DO use Enter
  // — the awaiting-parts note and the damage note — handle it on the element
  // itself, which runs before this delegated listener and already calls
  // preventDefault. Saving is the Save Ticket button, and only the Save Ticket
  // button. <button> and <textarea> are untouched, so the button still submits
  // when clicked or activated by keyboard.
  _ticketForm.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // IME confirming a candidate
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toUpperCase();
    if (tag !== 'INPUT' && tag !== 'SELECT') return;

    const inScanField = el.matches && el.matches(SCAN_FIELD_SEL);

    // A scanner's terminator is configurable and the shop's units are not all
    // set the same way. Enter and Tab are the two in use, so BOTH mean "that
    // one's done" inside a scan box. Shift+Tab is left alone — a technician
    // stepping back through the form by hand must still be able to.
    const isEnter = e.key === 'Enter';
    const isScanTab = e.key === 'Tab' && !e.shiftKey && inScanField;

    if (isEnter) {
      // Enter never submits, from any field in this form.
      e.preventDefault();
      if (!inScanField) return;
    } else if (!isScanTab) {
      return;
    }

    // Many wedge scanners terminate with CR+LF, i.e. TWO Enter keydowns a few ms
    // apart. Without this, the second one advances again and every remaining scan
    // lands in the wrong component — silently, and one part out of step.
    // Many wedge scanners terminate with CR+LF — TWO keydowns a few ms apart.
    // Unguarded, the second advances again and every remaining scan lands in the
    // wrong component: silently, and one part out of step.
    //
    // Neither a clock nor the element identity can tell the two apart. Focus
    // moves synchronously inside the first keydown, so the second is delivered
    // to the NEW box, which defeats element-keying; and a fast operator's real
    // second scan can fall inside any time window generous enough to catch a
    // CR+LF pair, which defeats a pure debounce.
    //
    // What does separate them is content. A real scan always types characters
    // before its terminator, so the box it fires from is non-empty. The second
    // half of a CR+LF pair fires from the box we just moved to, which is empty
    // by construction — the advance below only ever lands on an empty box.
    // Pressing Enter on an empty scan box therefore does nothing, which is also
    // the right behaviour for a technician tabbing through by hand.
    if (!String(el.value || '').trim()) {
      if (isScanTab) e.preventDefault();
      return;
    }
    // Belt and braces for a scanner that double-fires on the SAME box.
    const now = Date.now();
    if (el === _lastScanEl && now - _lastScanAdvance < 400) {
      if (isScanTab) e.preventDefault();
      return;
    }
    _lastScanAdvance = now;
    _lastScanEl = el;

    // Advance ONLY within the section being worked. Procurement (goods-in) and
    // component verification (build time) are deliberately independent captures —
    // "kept SEPARATE from the technician's cvState scan so that later scan is a
    // second verification" (see setupProcurement). Letting focus cross that
    // boundary would put a goods-in operator's scan into the technician's
    // verification field, forge a "matches invoice" tick, and collapse a
    // two-person double-check into one person scanning twice.
    const section = el.closest('#procurement-rows, #cv-rows') || _ticketForm;
    const fields = Array.from(section.querySelectorAll(SCAN_FIELD_SEL))
      // getClientRects() rather than offsetParent: the modal is positioned, which
      // makes offsetParent null for visible children and would filter out everything.
      .filter(f => !f.disabled && f.getClientRects().length > 0);

    // Skip boxes that already hold a serial. Focusing a filled box would either
    // overwrite a good value on the next scan or append to it; neither is what
    // anyone wants, and a re-scan is still one click away.
    const i = fields.indexOf(el);
    const next = i === -1 ? null : fields.slice(i + 1).find(f => !f.value.trim());
    if (next) {
      if (isScanTab) e.preventDefault();   // we are taking over the move
      next.focus();
      next.select();
    } else if (isEnter) {
      el.blur();   // nothing left to scan here — stop, don't wrap round
    }
    // Tab with nothing left to scan falls through to native behaviour, so the
    // next control in the row (the box-condition select) is still reachable by
    // keyboard. It cannot reach Save from here in one press, and even if it did,
    // the submit gate above refuses anything that is not a real Save activation.
  });

  // Staff Modal System Auto-Detect Local Specs click handler.
  // v1.9.7 — the button was removed from the admin ticket view (detection belongs to
  // the Testing Client). Guarded so the missing button never throws at setup; the
  // handler stays for any legacy build that still renders the button.
  const _modalDetectBtn = document.getElementById('btn-modal-detect-hw');
  if (_modalDetectBtn) _modalDetectBtn.addEventListener('click', async () => {
    const btn = document.getElementById('btn-modal-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      const detected = await ipcRenderer.invoke('sys:detect-hw');
      adminDetectedSpecs = detected;   // v1.4.9 — source of truth for the save path

      // Update modal spec elements (display only)
      document.getElementById('modal-spec-cpu').textContent = detected.cpu || "Failed to detect";
      document.getElementById('modal-spec-igpu').textContent = detected.igpu || "None";
      document.getElementById('modal-spec-gpu').textContent = detected.dgpu || "None";
      document.getElementById('modal-spec-ram').textContent = detected.ram || "Failed to detect";
      document.getElementById('modal-spec-storage').textContent = detected.storage || "Failed to detect";

      // Competitor auto-detect comparison and banner updates omitted
    } catch (err) {
      console.error("Hardware spec detection failed in modal:", err);
      showToast("Hardware specs detection failed: " + err.message, 'error', 8000);
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
        updateBuildPriorityAuto(); // re-suggest build priority from the imported total
        // Chunk B — capture each line's printed serial so the technician's scan
        // can be matched against the invoice in Component Verification.
        Object.keys(build.results).forEach(cat => {
          const s = build.results[cat] && build.results[cat].serial;
          if (s) invoiceSerials[cat] = s;
        });
        renderComponentVerify();
        renderProcurement();
        // Grow the catalog from this invoice (background — invoice price wins,
        // dedupes against existing rows). Resolves each field's SKU too.
        upsertInvoiceComponentsToCatalog(build).catch(err => console.warn('invoice catalog sync failed:', err && err.message));

        // Build a readable summary of what got filled and its invoice price.
        const rupee = (n) => (n != null ? '₹' + Math.round(n).toLocaleString('en-IN') : '—');
        let priceTotal = 0;
        const line = (icon, item) => {
          const e = item.entry;
          if (e.priceInr != null) priceTotal += e.priceInr;
          const priceStr = e.priceInr != null ? ` — <strong>${rupee(e.priceInr)}</strong>` : '';
          return `<div style="margin-top:4px;">${icon} <strong>${catLabel[item.category] || item.category}:</strong> ${escapeHtmlLite(e.displayName || e.matchedName)}${priceStr}</div>`;
        };
        let html = `<strong>✓ Auto-filled ${summary.filled.length + summary.review.length + summary.manual.length} field(s) from the invoice.</strong>`;
        summary.filled.forEach(it => { html += line('✅', it); });
        const needsLook = summary.review.concat(summary.manual);
        if (needsLook.length) {
          html += `<div style="margin-top:8px;"><strong>Double-check the category on these (unusual wording):</strong></div>`;
          needsLook.forEach(it => { html += line('🟡', it); });
        }
        html += `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed currentColor;"><strong>Components subtotal (from invoice): ${rupee(priceTotal)}</strong></div>`;
        if (summary.skipped.length) {
          html += `<div style="margin-top:8px; opacity:0.75;">Skipped (marked awaiting): ${summary.skipped.map(c => catLabel[c] || c).join(', ')}</div>`;
        }
        // v1.9.7 SAFETY NET — surface invoice line items that were NOT matched to a
        // build component, so a genuinely-missed part can never be silently dropped.
        // (Monitors, peripherals, labour etc. legitimately land here.) Wrapped in
        // try/catch so this display can never break the import itself.
        try {
          const mappedTexts = new Set(Object.values(build.results).map(r => r && r.rawLine).filter(Boolean));
          const noiseRe = /(sub\s*total|grand\s*total|\btotal\b|\bgst\b|\bcgst\b|\bsgst\b|\btax\b|bill\s*to|ship\s*to|\bbank\b|transfer|\bmobile\b|place\s*of\s*supply|proforma|\binvoice\b)/i;
          const unmatched = (build.candidateLines || []).filter(row => {
            if (!row || !row.text) return false;
            if (row.rate == null && row.total == null) return false;   // priced lines only
            if (mappedTexts.has(row.text)) return false;               // already used
            if (noiseRe.test(row.text)) return false;                  // header/tax/bank noise
            return /[a-z]{3,}/i.test(row.text);
          });
          if (unmatched.length) {
            html += `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed currentColor;"><strong>ⓘ ${unmatched.length} invoice line(s) not added as a build part — check nothing was missed:</strong></div>`;
            unmatched.forEach(row => {
              const pr = row.rate != null ? ' — ₹' + Math.round(row.rate).toLocaleString('en-IN') : '';
              html += `<div style="margin-top:3px; opacity:0.85; font-size:0.76rem;">• ${escapeHtmlLite(row.text.slice(0, 70))}${pr}</div>`;
            });
            html += `<div style="margin-top:4px; opacity:0.7; font-size:0.72rem;">Monitors, keyboards, labour etc. belong here. If a CPU / GPU / RAM / board / PSU / SSD / cooler / case is in this list, type it into the matching field above.</div>`;
          }
        } catch (e) { /* safety net must never break the import */ }
        html += `<div style="margin-top:8px; opacity:0.7; font-size:0.72rem;">Names and per-unit prices are taken straight from your invoice and added to the catalogue. Review each field before saving.</div>`;
        const kind = needsLook.length ? 'warn' : 'ok';
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
        showToast(`${category.toUpperCase()} is already listed as awaiting. Remove the existing entry first if you want to change it.`, 'warning');
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
    QC_CHECK_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = true;
    });
    refreshQcBadge();
  });

  // Keep the counter honest when boxes are ticked one at a time.
  QC_CHECK_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', refreshQcBadge);
  });

  // Testing console → back to the bench board (v1.10; was "Switch Mode").
  document.getElementById('btn-client-exit').addEventListener('click', () => {
    switchScreen('client');
  });

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
        showToast('Save the ticket first — PPI needs a stored ticket with specs.', 'warning');
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
              showToast('PPI compute failed: ' + jsRes.error, 'error', 8000);
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
            showToast('PPI compute failed: ' + ((res && res.error) || 'unknown error'), 'error', 8000);
          }
        }
      } catch (e) {
        showToast('PPI compute failed: ' + e.message, 'error', 8000);
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
      showToast("Failed to export backup: " + err.message, 'error', 8000);
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
            if (await showConfirm("Are you sure you want to restore this backup? This will overwrite your current local database data.", { title: 'Restore backup', okText: 'Restore', danger: true })) {
              // Ensure critical fields exist
              if (!parsed.tickets) parsed.tickets = [];
              if (!Array.isArray(parsed.pendingQueueSends)) parsed.pendingQueueSends = [];
              if (!parsed.settings) parsed.settings = appState.settings;

              appState = parsed;
              initPpiTuning(); // re-seed/apply PPI tuning from the restored settings
              await saveDatabase();
              renderDashboard();
              showToast("Database restored successfully.", 'success');
              openSettingsModal(); // Refresh modal
            }
          } else {
            showToast("Invalid backup file structure.", 'error');
          }
        } catch (err) {
          showToast("Error parsing backup JSON: " + err.message, 'error', 8000);
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
      if (await showConfirm("This will delete ALL tickets and settings on this PC. This cannot be undone. Are you absolutely sure?", { title: '🚨 Factory reset', okText: 'Delete everything', danger: true })) {
        appState = {
          tickets: [],
          pendingQueueSends: [],
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
            sortBy: "deadline",
            shopName: "Neo Tokyo Kochi",
            contactInfo: "kochi@neotokyo.in"
          }
        };
        initPpiTuning(); // seed default PPI tuning into the fresh settings
        await saveDatabase();
        renderDashboard();
        showToast("Database has been factory reset.", 'success');
        openSettingsModal();
      }
    });
  }

  // Filters and search fields triggers. Search is debounced (150 ms) — it used
  // to re-render every card on every keystroke, which got sluggish with a full
  // dashboard (the catalogue editor was already debounced; this matches it).
  let dashSearchTimer = null;
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(dashSearchTimer);
    dashSearchTimer = setTimeout(renderDashboard, 150);
  });
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
  setupComponentVerify();   // v2.0.0 Chunk B — serial scan + box condition rows
  setupProcurement();       // v1.9.7 — procurement incoming parts check
  setupBuildTimer();        // v2.0.0 Chunk B — assembly start/finish timer
  setupClientMode();

  // Secret technician shortcut to open settings (Ctrl + Alt + S)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
      openSettingsModal();
    }
    // Secret technician shortcut to jump to the staff portal (Ctrl + Alt + P).
    // v2.0.0: must be signed in as T3+ — it can no longer bypass the login gate.
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'p') {
      // v1.11 — the same gate as the rail: whoever may open Builds.
      if (currentProfile && canOpenOfficeMode('staff')) switchScreen('staff');
      else showToast('Sign in with Builds access to open the staff portal.', 'warning');
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
    // WQ-C1 — builds waiting for build_queue_send are retried on every tick,
    // including while the ticket modal is open (it touches no form state).
    drainPendingQueueSends().catch(e => console.warn('build queue send retry failed:', e && e.message));
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
        renderBenchBoard();
      }
    } catch (e) {
      console.error('Cloud poll failed:', e);
    }
  }, 15000);
}

// Upload a single ticket to Supabase. Resolves true when the row reached the
// cloud, false otherwise (no client, an error, an exception) — never throws.
async function syncTicketToCloud(ticket) {
  if (!supabaseClient || !ticket) return false;
  try {
    // The tickets table has no detected_specs column, but specs is JSONB and
    // already syncs — so nest the client-detected hardware inside specs.__detected
    // (mirrors the specs.__prices pattern). This is what makes the admin's
    // "System Hardware Specs (Verification)" panel receive what the testing
    // client auto-detected. Without this, detectedSpecs never left the client.
    const specsPayload = Object.assign({}, ticket.specs || {});
    if (ticket.detectedSpecs) specsPayload.__detected = ticket.detectedSpecs;
    if (ticket.customerSupplied) specsPayload.__customerSupplied = ticket.customerSupplied;
    // v1.11 — the old client-side "waiting queue" flag is retired: the build
    // queue is server-side (tickets.queued_at, set by build_queue_send). Always
    // false, so the server's insert guard never reads a stale flag as a send.
    specsPayload.__queued = false;

    // Stress-test progress has no dedicated columns; diagnostics is JSONB and
    // already syncs, so carry it there (same pattern as specs.__detected).
    const diagPayload = Object.assign({}, ticket.diagnostics || {});
    if (ticket.stressRuns != null) diagPayload.__stressRuns = ticket.stressRuns;
    if (ticket.stressSignedOff != null) diagPayload.__stressSignedOff = ticket.stressSignedOff;
    if (ticket.stressSignedOffAt) diagPayload.__stressSignedOffAt = ticket.stressSignedOffAt;
    // v1.9.8 — carry the real time-under-load + per-run log cross-machine so the
    // progress bar and the report's "time under stress" survive a cloud round-trip.
    if (ticket.stressTotalSec != null) diagPayload.__stressTotalSec = ticket.stressTotalSec;
    if (Array.isArray(ticket.stressLog)) diagPayload.__stressLog = ticket.stressLog;
    if (ticket.reportOverrides) diagPayload.__reportOverrides = ticket.reportOverrides;
    else delete diagPayload.__reportOverrides;

    // v1.11 — `technician` is NOT sent (nor any queue/offer column): who builds
    // it is server-owned, written only by the work_* RPCs. Leaving it out of
    // the upsert means a stale copy on this PC can never undo a claim.
    const { error } = await supabaseClient
      .from('tickets')
      .upsert({
        id: ticket.id,
        created_at: ticket.createdAt,
        updated_at: ticket.updatedAt || new Date().toISOString(),
        type: ticket.type,
        customer_name: ticket.customerName,
        deadline: ticket.deadline,
        missing_components_toggle: ticket.missingComponentsToggle,
        missing_components: ticket.missingComponents,
        build_checks: ticket.buildChecks,
        qc_checks: ticket.qcChecks,
        diagnostics: diagPayload,
        serials: ticket.serials,
        specs: specsPayload,
        status: ticket.status,
        completed_at: ticket.completedAt
      });
    if (error) {
      console.error("Supabase upsert failed:", error.message);
      return false;
    }
    // Mark that this ticket has reached the cloud at least once. syncFromCloud()
    // uses this to tell "deleted remotely" (cloudSynced && absent from cloud →
    // prune) apart from "created locally, not yet uploaded" (never synced → keep),
    // so an offline-created ticket is never destroyed before it uploads.
    ticket.cloudSynced = true;
    console.log(`Synced ticket ${ticket.id} to cloud.`);
    return true;
  } catch (err) {
    console.error("Exception during ticket sync:", err);
    return false;
  }
}

// ── Builds waiting for build_queue_send (WQ-C1) ─────────────────────────────
// appState.pendingQueueSends holds ticket ids, outside the ticket objects
// (persisted with the local db; no mapper or merge touches it). Drained right
// after a new build's first upload and on every 15 s poll tick. Never toasts:
// it is a background retry. Drop on ok / already / assigned / closed; keep on
// not_found, NEO_DENIED or any error (the next tick tries again).
// A build MISSING from this PC is not proof that it was deleted (a signed-out
// poll, or one tick's drain running before its own sync, can leave it out for
// a while), so it is still sent; only the server's not_found for a build this
// PC no longer has drops it (gone on both sides). Deleting a build here drops
// its id at once.
let pendingQueueDrain = null;
function drainPendingQueueSends() {
  if (pendingQueueDrain) return pendingQueueDrain;   // one drain at a time
  const run = runPendingQueueDrain();
  pendingQueueDrain = run;
  // Cleared when THIS run settles — never from inside it: a run with nothing
  // to do finishes synchronously, before the assignment above.
  const done = () => { if (pendingQueueDrain === run) pendingQueueDrain = null; };
  run.then(done, done);
  return run;
}

async function runPendingQueueDrain() {
  const list = Array.isArray(appState.pendingQueueSends) ? appState.pendingQueueSends.slice() : [];
  if (!list.length || !supabaseClient || !currentProfile) return;
  const D = window.NeoQcData;
  let changed = false;
  const localTicket = (id) => (appState.tickets || []).find(x => x && x.id === id) || null;
  for (const id of list) {
    const t = localTicket(id);
    if (t && !t.cloudSynced) {
      const up = await syncTicketToCloud(t);
      if (!up) continue;
      changed = true;
    }
    if (!D || typeof D.buildQueueSend !== 'function') continue;
    let res = null;
    try { res = await D.buildQueueSend(id); }
    catch (e) { console.warn('build_queue_send for ' + id + ' will be retried:', e && e.message); continue; }
    const settled = !!res && (res.ok === true || (res.ok === false && (
      res.reason === 'assigned' || res.reason === 'closed' ||
      // not on the server and not on this PC → it was deleted
      (res.reason === 'not_found' && !localTicket(id)))));
    if (settled) changed = removePendingQueueSend(id, true) || changed;
  }
  if (changed) {
    await saveDatabase();
    notifyBuildsChanged();
  }
}

// Returns true when the id was in the list. `quiet` = the caller saves.
function removePendingQueueSend(id, quiet) {
  const list = appState.pendingQueueSends;
  if (!Array.isArray(list)) return false;
  const i = list.indexOf(id);
  if (i === -1) return false;
  list.splice(i, 1);
  if (!quiet) saveDatabase().catch(() => {});
  return true;
}

function notifyBuildsChanged() {
  try { window.dispatchEvent(new CustomEvent('neo-builds-changed')); } catch (e) {}
}

// ── One merge rule for a server row (WQ-C2 / §9.1) ──────────────────────────
// Used by realtime and syncFromCloud. When the server copy is newer or equal
// (Date.parse, never string compare: the server writes '+00:00', this PC 'Z')
// it replaces the local one. Otherwise local unsynced edits win — but the
// SERVER-OWNED fields (who builds it, the queue, the offer) always come from
// the server, because nothing on this PC may set them.
function tsMs(v) {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function mergeServerTicket(local, row) {
  const server = mapDbRowToTicket(row);
  if (!local) return server;
  if (tsMs(server.updatedAt) >= tsMs(local.updatedAt)) return server;
  SERVER_OWNED_TICKET_FIELDS.forEach(k => { local[k] = server[k]; });
  local.cloudSynced = true;
  return local;
}

// What a merge is judged by: did anything a screen shows change?
function ticketSyncSig(t) {
  if (!t) return '';
  const owned = {};
  SERVER_OWNED_TICKET_FIELDS.forEach(k => { owned[k] = t[k] === undefined ? null : t[k]; });
  return [t.updatedAt || '', t.status || '', JSON.stringify(owned)].join('|');
}

// Pull ONE build from the server and merge it (after a queue action, so the
// modal, the bench and the Builds card show the claim at once).
async function refreshTicketFromCloud(id) {
  if (!supabaseClient || !id) return false;
  try {
    const { data, error } = await supabaseClient.from('tickets').select('*').eq('id', id).maybeSingle();
    if (error || !data) return false;
    const index = appState.tickets.findIndex(t => t.id === id);
    const before = index === -1 ? null : ticketSyncSig(appState.tickets[index]);
    const merged = mergeServerTicket(index === -1 ? null : appState.tickets[index], data);
    if (index === -1) appState.tickets.push(merged);
    else appState.tickets[index] = merged;
    if (before !== ticketSyncSig(merged)) {
      await saveDatabase();
      notifyBuildsChanged();
      rerenderBuildViews(id);
    }
    return true;
  } catch (e) {
    console.warn('ticket refresh failed:', e && e.message);
    return false;
  }
}

function rerenderBuildViews(ticketId) {
  try {
    if (currentMode === 'staff') renderDashboard();
    else if (currentMode === 'client') { populateWelcomeTicketSelect(); renderBenchBoard(); }
  } catch (e) { console.warn('build views refresh failed:', e && e.message); }
  const modal = document.getElementById('ticket-modal');
  if (ticketId && editingTicketId === ticketId && modal && modal.classList.contains('active')) {
    renderTicketTechArea(ticketId);
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
// SINGLE source of truth for Supabase row → ticket mapping.
//
// v1.5.1 — this exists because syncFromCloud() and the realtime listener each
// had their OWN copy of this mapping, and they drifted: the realtime copy was
// missing detectedSpecs / specPrices / damagedComponents. Since the realtime
// handler does `appState.tickets[index] = ticket`, every realtime update
// WIPED the client's auto-detected hardware off the ticket — which is why the
// admin's "System Hardware Specs (Verification)" panel kept showing "--" no
// matter what the testing client detected. Never inline this mapping again.
function mapDbRowToTicket(dbRow) {
  const specs = dbRow.specs || {};
  const diag = dbRow.diagnostics || {};
  return {
    stressRuns: diag.__stressRuns || 0,
    stressSignedOff: !!diag.__stressSignedOff,
    stressSignedOffAt: diag.__stressSignedOffAt || null,
    stressTotalSec: diag.__stressTotalSec || 0,
    stressLog: Array.isArray(diag.__stressLog) ? diag.__stressLog : [],
    reportOverrides: diag.__reportOverrides || null,
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
    specPrices: specs.__prices || null,
    detectedSpecs: dbRow.detectedSpecs || specs.__detected || null,
    customerSupplied: specs.__customerSupplied || [],
    damagedComponents: dbRow.damagedComponents || specs.__damaged || null,
    // v1.11 — the work queue (server-owned; null on a server without v2.2).
    technicianEmail: dbRow.technician_email || null,
    assignedVia: dbRow.assigned_via || null,
    assignedAt: dbRow.assigned_at || null,
    queuedAt: dbRow.queued_at || null,
    offer: (dbRow.offered_to_email || dbRow.offer_expires_at) ? {
      toEmail: dbRow.offered_to_email || null,
      toName: dbRow.offered_to_name || null,
      kind: dbRow.offer_kind || null,
      byName: dbRow.offer_by_name || null,
      reason: dbRow.offer_reason || null,
      offeredAt: dbRow.offered_at || null,
      expiresAt: dbRow.offer_expires_at || null
    } : null,
    declinedEmails: Array.isArray(dbRow.declined_emails) ? dbRow.declined_emails : [],
    status: dbRow.status,
    completedAt: dbRow.completed_at,
    cloudSynced: true // came from the cloud, so it is known-synced (see prune in syncFromCloud)
  };
}

// Who a tickets SELECT runs as: the signed-in user's id, or null when nobody
// is signed in on this PC (no profile, or no Supabase session).
async function ticketReaderId() {
  if (!currentProfile || !supabaseClient || !supabaseClient.auth || typeof supabaseClient.auth.getSession !== 'function') return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    const u = data && data.session && data.session.user;
    return (u && u.id) || null;
  } catch (e) {
    return null;
  }
}

async function syncFromCloud() {
  if (!supabaseClient) return;
  try {
    // v1.11 — the 15 s poll also runs while nobody is signed in, and tickets
    // RLS answers an anon SELECT with [] (not an error). A build missing from
    // the answer is proof of a remote delete only when the SAME person was
    // signed in for the whole request; otherwise this pull merges but never
    // prunes (a signed-out PC used to wipe its whole local cache here).
    const profileAtStart = currentProfile;
    const readerAtStart = await ticketReaderId();
    const { data, error } = await supabaseClient
      .from('tickets')
      .select('*');

    if (error) {
      console.error("Failed to fetch cloud tickets:", error.message);
      return;
    }

    if (data) {
      const cloudIds = new Set(data.map(dbRow => dbRow.id));
      let changed = false;

      data.forEach(dbRow => {
        if (!dbRow || !dbRow.id) return;
        const index = appState.tickets.findIndex(t => t.id === dbRow.id);
        if (index === -1) {
          appState.tickets.push(mapDbRowToTicket(dbRow));
          changed = true;
        } else {
          // v1.11 — one merge rule (mergeServerTicket): the server copy wins
          // when newer or equal by Date.parse; otherwise local edits stay but
          // the server-owned queue fields are always taken.
          const before = ticketSyncSig(appState.tickets[index]);
          appState.tickets[index] = mergeServerTicket(appState.tickets[index], dbRow);
          if (before !== ticketSyncSig(appState.tickets[index])) changed = true;
        }
      });

      const oldLength = appState.tickets.length;
      // Remove tickets that were DELETED remotely — but ONLY ones we know reached the
      // cloud before (cloudSynced). A ticket created locally while offline has no
      // cloudSynced flag and must be KEPT, or we would permanently destroy it before
      // it ever uploaded. (Previously this pruned every local-only ticket.)
      // And only when signed in throughout (see above).
      const readerAtEnd = await ticketReaderId();
      const mayPrune = !!readerAtStart && readerAtEnd === readerAtStart &&
        !!currentProfile && currentProfile === profileAtStart;
      if (mayPrune) appState.tickets = appState.tickets.filter(t => cloudIds.has(t.id) || !t.cloudSynced);
      if (appState.tickets.length !== oldLength) changed = true;

      await saveDatabase(); // Persist merged dataset locally
      console.log(`Pulled ${data.length} tickets, removed ${oldLength - appState.tickets.length} remotely-deleted tickets from Supabase cloud.`);
      if (changed) notifyBuildsChanged();
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
        // Log the event type + id only — the full payload carries customer data.
        console.log(`Realtime event: ${payload.eventType} ${(payload.new && payload.new.id) || (payload.old && payload.old.id) || ''}`);

        if (payload.eventType === 'DELETE') {
          const deletedId = payload.old && payload.old.id;
          if (deletedId) {
            appState.tickets = appState.tickets.filter(t => t.id !== deletedId);
            removePendingQueueSend(deletedId, true);   // deleted on the server: nothing to send
            await saveDatabase();
            // The open ticket is gone, whichever screen it was opened from.
            if (editingTicketId === deletedId) {
              document.getElementById('ticket-modal').classList.remove('active');
              editingTicketId = null;
            }
            if (currentMode === 'staff') {
              renderDashboard();
            } else if (currentMode === 'client') {
              populateWelcomeTicketSelect();
              renderBenchBoard();
            } else if (currentMode === 'client-console') {
              populateClientTicketSelect(document.getElementById('client-ticket-select').value);
            }
            notifyBuildsChanged();
          }
          return;
        }

        const dbRow = payload.new;
        if (dbRow && dbRow.id) {
          // Use the SHARED mapper (inside mergeServerTicket) — an inline copy
          // here is what silently dropped detectedSpecs/specPrices/
          // damagedComponents on every realtime update (see mapDbRowToTicket).
          // v1.11 — and the one merge rule: the server row replaces the local
          // ticket only when newer or equal (local unsynced edits win
          // otherwise), but the server-owned queue fields are always taken.
          const index = appState.tickets.findIndex(t => t.id === dbRow.id);
          const before = index === -1 ? null : ticketSyncSig(appState.tickets[index]);
          const replaced = index !== -1 && tsMs(dbRow.updated_at || dbRow.created_at) >= tsMs(appState.tickets[index].updatedAt);
          const ticket = mergeServerTicket(index === -1 ? null : appState.tickets[index], dbRow);
          if (index === -1) appState.tickets.push(ticket);
          else appState.tickets[index] = ticket;
          await saveDatabase();
          if (before !== ticketSyncSig(ticket)) notifyBuildsChanged();

          const modalOpen = editingTicketId === ticket.id && document.getElementById('ticket-modal').classList.contains('active');
          if (modalOpen) renderTicketTechArea(ticket.id);
          if (currentMode === 'staff') {
            renderDashboard();
            // If this ticket is currently open in the modal, show a banner instead of
            // clobbering whatever the technician is typing right now — unless
            // this PC itself just changed it through the queue (its own echo).
            const own = ownQueueActionAt[ticket.id] && (Date.now() - ownQueueActionAt[ticket.id] < 15000);
            if (modalOpen && replaced && !own) {
              showConflictBanner();
            }
          } else if (currentMode === 'client') {
            populateWelcomeTicketSelect();
            renderBenchBoard();
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
      customerName: "Demo customer (Test Build)",
      deadline: getDeadline(0.4), // Urgent (within 24 hrs!)
      technician: "",
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
      technician: "",
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
      technician: "",
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
      technician: "",
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
      technician: "",
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

// v1.9.8 — the diagnostics console used to be a pure DOM sink: lines were appended
// to a div and never stored anywhere, so the whole run log died when the modal
// closed and an admin on another PC only ever saw the "[SYS] idle" placeholder.
// Every line now also lands in this buffer, which is saved onto the ticket as
// diagnostics.consoleLog[] (the same pattern as diagnostics.eventLog, so it syncs
// inside the diagnostics JSONB with no schema change) and replayed into the modal.
let diagConsoleBuffer = [];
const DIAG_CONSOLE_MAX = 2000;   // keep the synced JSONB payload bounded

function logDiagLine(text) {
  const t = String(text == null ? '' : text);
  diagConsoleBuffer.push({ t: new Date().toISOString(), line: t });
  if (diagConsoleBuffer.length > DIAG_CONSOLE_MAX) {
    diagConsoleBuffer.splice(0, diagConsoleBuffer.length - DIAG_CONSOLE_MAX);
  }
  appendConsoleLine('c-console-box', t);
  appendConsoleLine('modal-console-box', t);
}

// Replay a stored console log into a box (used when an admin opens a ticket).
function renderStoredConsole(boxId, entries) {
  const box = document.getElementById(boxId);
  if (!box) return;
  if (!Array.isArray(entries) || !entries.length) return;
  box.innerHTML = '';
  entries.forEach(e => appendConsoleLine(boxId, (e && e.line != null) ? e.line : String(e)));
}

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
  logDiagLine(modifiedText);
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

// v1.8.3 — the RAM and SSD HUD cards only ever showed LIVE progress, so after a
// run finished (or the ticket was reopened) they fell back to "0% / Idle" even
// though the test had passed and the result was saved. Rebuild them from the
// stored diagnostics, the same way the temperature cards are restored.
function restoreHudFromDiagnostics(prefix, diag) {
  if (!diag) return;
  const ramVal  = document.getElementById(prefix + 'hud-ram-val');
  const ramBar  = document.getElementById(prefix + 'hud-ram-bar');
  const ramDesc = document.getElementById(prefix + 'hud-ram-desc');
  if (ramVal && diag.ramStress) {
    const passed = String(diag.ramStress).toLowerCase() === 'passed';
    ramVal.textContent = passed ? '100%' : 'FAIL';
    if (ramBar) ramBar.style.width = '100%';
    if (ramDesc) ramDesc.textContent = diag.ramDetail || (passed ? 'Completed — no errors.' : 'Errors detected.');
  }
  const ssdVal = document.getElementById(prefix + 'hud-ssd-val');
  const ssdBar = document.getElementById(prefix + 'hud-ssd-bar');
  if (ssdVal && (diag.ssdRead || diag.ssdWrite)) {
    ssdVal.textContent = `${diag.ssdRead || '--'} / ${diag.ssdWrite || '--'} MB/s`;
    if (ssdBar) ssdBar.style.width = '100%';
  }
}

ipcRenderer.on('sys:ram-update', (event, data) => {
  // v1.8.4 — a worker that failed to start/run now says so on the card instead
  // of sitting silently at "Idle / 0%".
  if (data && data.failed) {
    ['c-', 'modal-'].forEach(pfx => {
      const v = document.getElementById(pfx + 'hud-ram-val');
      const d = document.getElementById(pfx + 'hud-ram-desc');
      if (v) v.textContent = 'ERROR';
      if (d) d.textContent = data.message || 'RAM test failed to run.';
    });
    return;
  }
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

  // v1.9.8 — start a fresh console capture for this run. The buffer is written
  // onto the ticket when the run finishes, so the admin can replay exactly what
  // the technician's machine printed.
  diagConsoleBuffer = [];

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

  // v1.8.1 — the Testing Client uses Throttle/Stability modes; the admin modal
  // keeps its legacy dropdowns. Derive the run parameters accordingly.
  let duration, useCase, runPrime95, prime95Duration;
  if (!isModal) {
    const cfg = getClientStressConfig();
    duration = cfg.duration;
    useCase = cfg.useCase;
    runPrime95 = cfg.runPrime95;
    prime95Duration = cfg.prime95Duration;
  } else {
    const durationSelectEl = document.getElementById('modal-duration-select');
    duration = durationSelectEl ? parseInt(durationSelectEl.value) : 60;
    const ucEl = document.getElementById('modal-usecase-select');
    useCase = ucEl ? ucEl.value : 'studio';
    runPrime95 = !!document.getElementById('modal-prime95-enable')?.checked;
    const p95El = document.getElementById('modal-prime95-duration-select');
    prime95Duration = p95El ? parseInt(p95El.value) : 1200;
  }

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

  const prime95PanelId = (isModal ? 'modal-' : 'c-') + 'prime95-panel';
  const prime95Panel = document.getElementById(prime95PanelId);
  if (runPrime95 && prime95Panel && window.NeoQcDiagnosticsRender) {
    prime95Panel.innerHTML = window.NeoQcDiagnosticsRender.emptyState(
      `Prime95 running (Blend, CPU + RAM) — target ${Math.round(prime95Duration / 60)} min...`);
  }

  // Run diagnostics!
  const res = await ipcRenderer.invoke('sys:run-diagnostics', {
    ...appState.settings,
    // v1.9.8 — tell main.js WHICH mode is running so it can echo it back on the
    // result; the ticket then records what kind of run each entry was.
    mode: isModal ? 'admin' : clientStressMode,
    useCase: useCase,
    duration: duration,
    runPrime95: runPrime95,
    prime95Duration: prime95Duration
  });

  clearInterval(timerInterval);

  btn.disabled = false;
  btn.textContent = isModal ? "Run Stress Test & Auto-Fill"
    : (clientStressMode === 'throttle' ? '▶ Run Throttle Test' : '▶ Run Stability Test');

  if (pulseDot) {
    pulseDot.classList.remove('testing');
    pulseDot.classList.add('idle');
  }

  if (!res.success) {
    if (statusBox) statusBox.innerHTML = `<span style="color: var(--status-urgent)">Error: ${res.error}</span>`;
    appendConsoleLine(boxId, `[SYS ERROR] Diagnostics failed: ${res.error}`);
    return;
  }

  // A completed run counts toward stress-test progress (never to 100% —
  // only the technician's sign-off does that). Admin modal → the open ticket;
  // Testing Client → the selected build.
  const stressTicketId = isModal ? editingTicketId : (typeof clientActiveTicketId === 'function' ? clientActiveTicketId() : null);
  // v1.9.8 — pass the full result so the run's real duration + mode are recorded.
  if (stressTicketId) recordStressRun(stressTicketId, res);

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
  appendConsoleLine(boxId, res.cpuTempAvg != null
    ? `[SYS] CPU avg ${res.cpuTempAvg}°C (min ${res.cpuTempMin}°C / max ${res.cpuTempMax}°C) over ${(res.cpuTempLog || []).length} samples — full run, start to finish.`
    : `[SYS] CPU temperature: no sensor samples captured (check [SENSORS] inventory above).`);
  appendConsoleLine(boxId, res.gpuTempAvg != null
    ? `[SYS] GPU avg ${res.gpuTempAvg}°C (min ${res.gpuTempMin}°C / max ${res.gpuTempMax}°C) over ${(res.gpuTempLog || []).length} samples.`
    : `[SYS] GPU temperature: no sensor samples captured (iGPU-only build or sensor not exposed).`);
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
      // v1.9.8 — persist the run's console so it survives the modal closing and is
      // visible to the admin on another machine (rides in the diagnostics JSONB).
      ticket.diagnostics.consoleLog = diagConsoleBuffer.slice();
      ticket.diagnostics.gpuTempMin = res.gpuTempMin || null;
      ticket.diagnostics.gpuTempMax = res.gpuTempMax || null;
      ticket.diagnostics.gpuTempAvg = res.gpuTempAvg || null;
      ticket.diagnostics.gpuTempLog = res.gpuTempLog || null;
      ticket.diagnostics.cinebench = res.cinebenchScore || null;
      ticket.diagnostics.cinebenchMode = res.cinebenchMode || 'multi';
      ticket.diagnostics.furmark = res.furmarkScore || null;
      ticket.diagnostics.ssdRead = res.ssdRead || null;
      ticket.diagnostics.ssdWrite = res.ssdWrite || null;
      // v1.8.0 — clock telemetry + temp source
      ticket.diagnostics.cpuClockMin = res.cpuClockMin || null;
      ticket.diagnostics.cpuClockAvg = res.cpuClockAvg || null;
      ticket.diagnostics.cpuClockMax = res.cpuClockMax || null;
      ticket.diagnostics.cpuClockLog = res.cpuClockLog || null;
      ticket.diagnostics.gpuClockMin = res.gpuClockMin || null;
      ticket.diagnostics.gpuClockAvg = res.gpuClockAvg || null;
      ticket.diagnostics.gpuClockMax = res.gpuClockMax || null;
      ticket.diagnostics.gpuClockLog = res.gpuClockLog || null;
      ticket.diagnostics.cpuTempSource = res.cpuTempSource || null;
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
  // A figure that still came from Win32_VideoController.AdapterRAM is clamped to a
  // UInt32, so anything landing at ~4 GB from that source is very likely a larger
  // card being under-reported. Say so on the report rather than printing a number
  // we don't trust — an 8 GB card was signed off as 4 GB this way.
  const vramCapped = (hwId.gpu && hwId.gpu.vramSource === 'wmi-adapterram') && vramMB != null && vramMB >= 4000 && vramMB <= 4096;
  const vram = vramMB != null
    ? (vramMB >= 1024 ? `${Math.round(vramMB / 1024)} GB` : `${vramMB} MB`) + (vramCapped ? ' (driver did not report — verify)' : '')
    : null;

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
// ==========================================================================
// APPEARANCE (v1.10) — theme (light / dark / match Windows) + accent colour.
// Settings → Appearance applies a choice the moment it is clicked and keeps
// it in this PC's local database (appState.settings). darkMode is still
// written alongside, so a PC rolled back to 1.9.x keeps the same look.
// ==========================================================================
const THEME_CHOICES = ['light', 'dark', 'system'];

// main colour, its rgb channels (for rgba(var(--primary-pink-rgb), a)), the
// hover shade, and the light/dark ends of the logo gradient.
const ACCENTS = {
  pink:   { primary: '#e7014e', rgb: '231, 1, 78',   hover: '#c4003f', light: '#ff1a75', dark: '#b3003b' },
  red:    { primary: '#ef4444', rgb: '239, 68, 68',  hover: '#dc2626', light: '#f87171', dark: '#b91c1c' },
  purple: { primary: '#8b5cf6', rgb: '139, 92, 246', hover: '#7c3aed', light: '#a78bfa', dark: '#6d28d9' },
  blue:   { primary: '#3b82f6', rgb: '59, 130, 246', hover: '#2563eb', light: '#60a5fa', dark: '#1d4ed8' },
  cyan:   { primary: '#06b6d4', rgb: '6, 182, 212',  hover: '#0891b2', light: '#22d3ee', dark: '#0e7490' },
  green:  { primary: '#10b981', rgb: '16, 185, 129', hover: '#059669', light: '#34d399', dark: '#047857' },
  gold:   { primary: '#f59e0b', rgb: '245, 158, 11', hover: '#d97706', light: '#fbbf24', dark: '#b45309' }
};

let systemThemeQuery = null;

// The saved choice. PCs from before v1.10 only have darkMode (true / false /
// never set — the light look).
function themeChoiceFromSettings(s) {
  if (s && THEME_CHOICES.indexOf(s.theme) !== -1) return s.theme;
  if (s && s.darkMode === true) return 'dark';
  return 'light';
}

function resolvedTheme(choice) {
  if (choice === 'system') {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  return choice === 'dark' ? 'dark' : 'light';
}

function applyThemeChoice(choice) {
  const dark = resolvedTheme(choice) === 'dark';
  document.body.classList.toggle('dark-mode', dark);
  document.body.classList.toggle('light-mode', !dark);
  // "Match Windows" follows a Windows theme change live, without a restart.
  if (!systemThemeQuery) {
    try {
      systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const follow = () => {
        if (themeChoiceFromSettings(appState.settings) === 'system') applyThemeChoice('system');
      };
      if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener('change', follow);
      else if (systemThemeQuery.addListener) systemThemeQuery.addListener(follow);
    } catch (e) { /* no matchMedia: light / dark still work */ }
  }
}

async function setThemeChoice(choice) {
  if (THEME_CHOICES.indexOf(choice) === -1) return;
  if (!appState.settings) appState.settings = {};
  appState.settings.theme = choice;
  appState.settings.darkMode = resolvedTheme(choice) === 'dark';
  applyThemeChoice(choice);
  renderAppearanceSettings();
  try { await saveDatabase(); } catch (e) { console.warn('saving the theme failed:', e && e.message); }
}

async function setAccentChoice(color) {
  if (!Object.prototype.hasOwnProperty.call(ACCENTS, color)) return;
  if (!appState.settings) appState.settings = {};
  appState.settings.accentColor = color;
  applyAccentColor(color);
  renderAppearanceSettings();
  try { await saveDatabase(); } catch (e) { console.warn('saving the accent colour failed:', e && e.message); }
}

// Mark the current theme and accent in Settings → Appearance.
function renderAppearanceSettings() {
  const choice = themeChoiceFromSettings(appState.settings);
  document.querySelectorAll('[data-theme-choice]').forEach(b => {
    const on = b.getAttribute('data-theme-choice') === choice;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const saved = appState.settings && appState.settings.accentColor;
  const accent = Object.prototype.hasOwnProperty.call(ACCENTS, saved) ? saved : 'pink';
  document.querySelectorAll('[data-accent]').forEach(b => {
    const on = b.getAttribute('data-accent') === accent;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function setupAppearanceSettings() {
  document.querySelectorAll('[data-theme-choice]').forEach(b => {
    b.addEventListener('click', () => setThemeChoice(b.getAttribute('data-theme-choice')));
  });
  document.querySelectorAll('[data-accent]').forEach(b => {
    b.addEventListener('click', () => setAccentChoice(b.getAttribute('data-accent')));
  });
  renderAppearanceSettings();
}

function applyAccentColor(color) {
  const a = Object.prototype.hasOwnProperty.call(ACCENTS, color) ? ACCENTS[color] : ACCENTS.pink;
  const root = document.documentElement;
  root.style.setProperty('--primary-pink', a.primary);
  root.style.setProperty('--primary-pink-rgb', a.rgb);
  root.style.setProperty('--primary-pink-hover', a.hover);
  // The Neo Tokyo mark on the splash and sign-in screens follows the accent.
  ['splash-logo-grad', 'login-logo-grad'].forEach(id => {
    const grad = document.getElementById(id);
    if (!grad) return;
    const stops = grad.querySelectorAll('stop');
    if (stops.length < 3) return;
    stops[0].setAttribute('stop-color', a.light);
    stops[1].setAttribute('stop-color', a.primary);
    stops[2].setAttribute('stop-color', a.dark);
  });
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
          <div class="event-log-event">${escapeHtmlLite(entry.event)}</div>
          <div class="event-log-meta">
            <span class="event-log-user">${escapeHtmlLite(entry.user || 'System')}</span>
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
  if (!ticket) return;
  // NOTE: no early return on !detectedSpecs — the per-row chips render
  // meaningful pre-detection states ("awaiting detect", physical ticks).

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
    // Canonicalise brand synonyms first (Micro-Star International → msi) so the
    // trade name on the target matches the legal name WMI reports.
    var a = brandNorm(String(target).toLowerCase()).trim();
    var b = brandNorm(String(detected).toLowerCase()).trim();
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

  // ── v1.4.9 category-aware fallbacks ────────────────────────────────
  // Detection tools often can't see brand/model (RAM SPD hidden, generic
  // NVMe strings, …). When the NAME doesn't match, fall back to what the
  // hardware can honestly tell us: capacity for RAM/SSD (+ DDR-gen guard),
  // shared model numbers for GPU/mobo. CPU strings are always complete →
  // CPU stays name-match only.

  function capacityGB(s) {
    if (!s) return null;
    var str = String(s).toLowerCase();
    // Kit notation → total capacity. "2 x 16GB", "16GB x 2", or a bare "16x2"
    // (module count is the small side). This makes a 2x16 = 32 GB kit compare
    // correctly against a detected ~31.8 GB.
    var m = str.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*gb/) || str.match(/(\d+(?:\.\d+)?)\s*gb\s*x\s*(\d+)/);
    if (m) return parseFloat(m[1]) * parseFloat(m[2]);
    var k = str.match(/(\d+)\s*x\s*(\d+)/);
    if (k) {
      var a = parseInt(k[1], 10), b = parseInt(k[2], 10);
      var lo = Math.min(a, b), hi = Math.max(a, b);
      if (lo >= 1 && lo <= 8 && hi >= 4) return lo * hi;           // plausible RAM kit
    }
    var best = null, re = /(\d+(?:\.\d+)?)\s*(tb|gb)/g, mm;
    while ((mm = re.exec(str))) {
      var v = parseFloat(mm[1]) * (mm[2] === 'tb' ? 1000 : 1);
      if (best === null || v > best) best = v;                     // biggest figure = the capacity
    }
    return best;
  }
  function capacityMatches(target, detected) {
    var t = capacityGB(target), d = capacityGB(detected);
    if (t == null || d == null) return false;
    // Real drives/RAM report short of the label (GiB vs GB, reserved space):
    // 2TB → 1863 GB, 32GB → 31.8 GB. Accept detected in [0.82, 1.15] × target.
    var r = d / t;
    return r >= 0.82 && r <= 1.15;
  }
  function ddrGenConflict(target, detected) {
    var t = /ddr\s*(\d)/i.exec(target || ''), d = /ddr\s*(\d)/i.exec(detected || '');
    return !!(t && d && t[1] !== d[1]);
  }
  function modelNumsMatch(target, detected) {
    if (!target || !detected) return false;
    // Digit-led (4070, 7800x3d) AND letter-led (b650m, x870e, z790) model
    // tokens. Also match a shorter chipset token inside a longer board model:
    // target "b850m" ⊇ detected "b850" (WMI drops the form-factor suffix).
    var re = /\b[a-z]?\d{3,5}[a-z0-9]*\b/g;
    var t = String(target).toLowerCase().match(re) || [];
    var d = String(detected).toLowerCase().match(re) || [];
    var dSet = new Set(d);
    for (var i = 0; i < t.length; i++) {
      if (dSet.has(t[i])) return true;
      // prefix/suffix containment for chipset-vs-board (len ≥ 4 to stay strict)
      if (t[i].length >= 4) {
        for (var j = 0; j < d.length; j++) {
          if (d[j].length >= 4 && (t[i].indexOf(d[j]) === 0 || d[j].indexOf(t[i]) === 0)) return true;
        }
      }
    }
    return false;
  }

  // v1.8.1 — brand-alias canonicaliser. WMI reports full legal names
  // ("Micro-Star International Co., Ltd.") while the invoice/target uses the
  // trade name ("MSI"). Without this, a correct board reads as a mismatch.
  var BRAND_ALIASES_MATCH = [
    [/micro[-\s]?star(\s+international)?(\s+co\.?,?\s*ltd\.?)?/gi, 'msi'],
    [/asustek(\s+computer(\s+inc\.?)?)?/gi, 'asus'],
    [/giga[-\s]?byte(\s+technology(\s+co\.?,?\s*ltd\.?)?)?/gi, 'gigabyte'],
    [/advanced\s+micro\s+devices(,?\s*inc\.?)?/gi, 'amd'],
    [/nvidia\s+corporation/gi, 'nvidia'],
    [/intel\s+corporation/gi, 'intel'],
    [/asrock(\s+incorporation)?/gi, 'asrock'],
    [/sapphire\s+technology/gi, 'sapphire'],
    [/zotac(\s+international)?/gi, 'zotac'],
    [/palit\s+microsystems/gi, 'palit'],
    [/power\s?color|tul\s+corporation/gi, 'powercolor'],
    [/kingston\s+technology/gi, 'kingston'],
    [/team\s?group/gi, 'teamgroup'],
    [/g\.?\s?skill(\s+international)?/gi, 'gskill'],
    [/corsair(\s+memory)?/gi, 'corsair'],
    [/samsung\s+electronics/gi, 'samsung'],
    [/western\s+digital/gi, 'wd'],
    [/seagate(\s+technology)?/gi, 'seagate'],
    [/micron\s+technology/gi, 'micron'],
    [/(cooler\s?master|coolermaster)/gi, 'coolermaster'],
    [/deep\s?cool/gi, 'deepcool']
  ];
  function brandNorm(s) {
    if (!s) return s;
    var out = String(s);
    for (var i = 0; i < BRAND_ALIASES_MATCH.length; i++) {
      out = out.replace(BRAND_ALIASES_MATCH[i][0], BRAND_ALIASES_MATCH[i][1]);
    }
    return out.replace(/\bco\.?,?\s*ltd\.?\b/gi, ' ').replace(/\binc\.?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  var specs = ticket.specs || {};
  // Merge the full inventory (v1.6.0) into the detected values so the checker
  // uses the richest string available — the older sys:detect-hw field could be
  // blank while the inventory has the real board name.
  var inv = (detectedSpecs && detectedSpecs.inventory) || null;
  var det = detectedSpecs || {};
  if (inv) {
    var imb = inv.motherboard || {};
    if (!det.motherboard && (imb.manufacturer || imb.model)) det = Object.assign({}, det, { motherboard: [imb.manufacturer, imb.model].filter(Boolean).join(' ') });
    if (inv.cpus && inv.cpus[0] && !det.cpu) det = Object.assign({}, det, { cpu: inv.cpus[0].name });
    if (inv.gpus && inv.gpus[0] && !det.gpu && !det.dgpu) det = Object.assign({}, det, { gpu: inv.gpus[0].name });
    if (inv.disks && inv.disks[0] && !det.storage) det = Object.assign({}, det, { storage: [inv.disks[0].model, inv.disks[0].sizeGB ? inv.disks[0].sizeGB + ' GB' : ''].filter(Boolean).join(' ') });
  }
  var detectionRan = !!detectedSpecs;

  var autoCats = [
    { cat: 'mobo',    label: 'motherboard', target: specs.mobo,    detected: det.motherboard,          fallback: 'model' },
    { cat: 'cpu',     label: 'CPU',         target: specs.cpu,     detected: det.cpu,                  fallback: null },
    { cat: 'gpu',     label: 'GPU',         target: specs.gpu,     detected: det.dgpu || det.gpu,      fallback: 'model' },
    { cat: 'ram',     label: 'RAM',         target: specs.ram,     detected: det.ram,                  fallback: 'capacity', genGuard: true },
    { cat: 'storage', label: 'storage',     target: specs.storage, detected: det.storage,              fallback: 'capacity' }
  ];

  function setChip(cat, cls, text) {
    var el = document.getElementById('sv-status-' + cat);
    if (el) { el.className = 'sv-chip ' + cls; el.textContent = text; }
  }

  var mismatches = [], awaiting = [], notDetected = [];

  autoCats.forEach(function (c) {
    var target = (c.target || '').trim();
    var detected = (c.detected || '').trim();
    // Manual technician override (Ctrl+Alt+G) — force-passes this component.
    if (specOverrides.has(c.cat)) { setChip(c.cat, 'physical', '✓ overridden'); return; }
    // Customer-supplied / transferred part: not bought on this invoice, so a
    // difference from the target spec is expected, not a fault.
    if (isCustomerSupplied(c.cat)) { setChip(c.cat, 'size', '♻ customer part'); return; }
    if (!target)            { setChip(c.cat, '', '—'); return; }                        // nothing to verify
    if (!detectionRan)      { setChip(c.cat, 'pending', 'awaiting detect'); awaiting.push(c.label); return; }
    if (!detected)          { setChip(c.cat, 'unknown', 'not detected');  notDetected.push(c.label); return; }
    if (tokenMatch(target, detected)) { setChip(c.cat, 'match', '✓ match'); return; }
    if (c.genGuard && ddrGenConflict(target, detected)) { setChip(c.cat, 'mismatch', '✗ DDR gen'); mismatches.push(c.label + ' (DDR generation)'); return; }
    if (c.fallback === 'capacity' && capacityMatches(target, detected)) { setChip(c.cat, 'size', '✓ size ' + Math.round(capacityGB(target)) + ' GB'); return; }
    if (c.fallback === 'model' && modelNumsMatch(target, detected))     { setChip(c.cat, 'size', '✓ model'); return; }
    setChip(c.cat, 'mismatch', '✗ mismatch');
    mismatches.push(c.label);
  });

  // Physical components — the technician eyeballs these; a ticked box IS the
  // verification and counts as a pass.
  var physicalPending = [];
  [['cooler', 'c-verify-cooler'], ['psu', 'c-verify-psu'], ['case', 'c-verify-case']].forEach(function (p) {
    var box = document.getElementById(p[1]);
    if (box && box.checked) setChip(p[0], 'physical', '✓ verified');
    else { setChip(p[0], 'pending', 'tick when checked'); physicalPending.push(p[0]); }
  });

  const matchStatusEl = document.getElementById('specs-match-status');
  if (matchStatusEl) {
    matchStatusEl.classList.remove('hidden');
    if (mismatches.length) {
      matchStatusEl.textContent = '⚠️ Specs Verification: MISMATCH — ' + mismatches.join(', ');
      matchStatusEl.style.background = 'rgba(239, 68, 68, 0.15)';
      matchStatusEl.style.color = '#ef4444';
      matchStatusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    } else if (!detectionRan || physicalPending.length) {
      var todo = [];
      if (!detectionRan) todo.push('run Auto-Detect');
      if (physicalPending.length) todo.push('tick ' + physicalPending.join('/'));
      matchStatusEl.textContent = '⏳ Verification in progress — ' + todo.join(' · ');
      matchStatusEl.style.background = 'rgba(245, 158, 11, 0.12)';
      matchStatusEl.style.color = '#d97706';
      matchStatusEl.style.borderColor = 'rgba(245, 158, 11, 0.3)';
    } else {
      var note = notDetected.length ? ' (' + notDetected.join(', ') + ' not exposed by hardware — verified by size/technician)' : '';
      matchStatusEl.textContent = '✅ Specs Verification: MATCH SUCCESS' + note;
      matchStatusEl.style.background = 'rgba(16, 185, 129, 0.15)';
      matchStatusEl.style.color = '#10b981';
      matchStatusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
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
           <button type="button" class="tq-link" data-edit="${q.id}">Edit reply</button></div>`
      : `<div class="tq-reply-box" data-box="${q.id}">
           <textarea class="tq-reply-input" data-input="${q.id}" rows="2" placeholder="Type your reply to sales…"></textarea>
           <button type="button" class="tq-send-btn" data-send="${q.id}">Send reply →</button>
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
                   : `<button type="button" class="tq-link tq-resolve" data-resolve="${q.id}">Mark resolved</button>`}
        ${resolved ? `<button type="button" class="tq-link" data-reopen="${q.id}">Reopen</button>` : ''}
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
    showToast('Could not send reply: ' + err.message, 'error', 8000);
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
    showToast('Could not update query: ' + err.message, 'error', 8000);
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
      <button type="button" class="tq-send-btn" data-send="${id}">Update reply →</button>
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

// ═══════════════════════════════════════════════════════════
//  HARDWARE INVENTORY (v1.5.1) — admin ticket panel
//  Renders the full per-part inventory captured by hw_inventory.ps1:
//  brand, model, part number and SERIAL for every component, so a ticket
//  proves exactly which physical hardware left the shop.
// ═══════════════════════════════════════════════════════════
function renderInventoryPanel(ticket) {
  const sec = document.getElementById('modal-inventory-section');
  const body = document.getElementById('modal-inventory-body');
  if (!sec || !body) return;
  const inv = ticket && ticket.detectedSpecs && ticket.detectedSpecs.inventory;
  if (!inv) { sec.style.display = 'none'; body.innerHTML = ''; return; }
  sec.style.display = '';

  const esc = (s) => escapeHtmlLite(s == null || s === '' ? '—' : String(s));
  const row = (label, value, serial) =>
    `<tr><td class="inv-lbl">${esc(label)}</td><td class="inv-val">${esc(value)}</td><td class="inv-ser">${esc(serial)}</td></tr>`;

  let rows = '';
  const mb = inv.motherboard || {};
  if (mb.model || mb.manufacturer) {
    rows += row('Motherboard', [mb.manufacturer, mb.model, mb.version].filter(Boolean).join(' '), mb.serial);
  }
  (inv.cpus || []).forEach(c => {
    rows += row('CPU', [c.name, c.socket ? '(' + c.socket + ')' : '', c.cores ? c.cores + 'C/' + c.threads + 'T' : ''].filter(Boolean).join(' '), c.processorId);
  });
  (inv.gpus || []).forEach(g => {
    rows += row('GPU', [g.name, g.vramGB ? g.vramGB + ' GB' : '', g.driverVersion ? 'drv ' + g.driverVersion : ''].filter(Boolean).join(' · '), g.pnpDeviceId ? String(g.pnpDeviceId).split(String.fromCharCode(92)).pop() : null);
  });
  (inv.ramModules || []).forEach(m => {
    let spd = '';
    if (m.configuredMHz && m.speedMHz && m.speedMHz !== m.configuredMHz) spd = m.configuredMHz + ' MHz (rated ' + m.speedMHz + ')';
    else if (m.configuredMHz || m.speedMHz) spd = (m.configuredMHz || m.speedMHz) + ' MHz';
    rows += row('RAM · ' + (m.slot || 'DIMM'),
      [m.manufacturer, m.partNumber, m.capacityGB ? m.capacityGB + ' GB' : '', m.ddrGen, spd].filter(Boolean).join(' · '),
      m.serial);
  });
  (inv.disks || []).forEach(d => {
    rows += row('Storage', [d.model, d.sizeGB ? d.sizeGB + ' GB' : '', d.busType || d.interfaceType, d.mediaType, d.healthStatus, d.firmware ? 'fw ' + d.firmware : ''].filter(Boolean).join(' · '), d.serial);
  });
  const sys = inv.system || {};
  if (sys.serial) rows += row('System / chassis', [sys.manufacturer, sys.model].filter(Boolean).join(' '), sys.serial);
  const bios = inv.bios || {};
  if (bios.version) rows += row('BIOS', [bios.vendor, bios.version, bios.releaseDate].filter(Boolean).join(' · '), null);
  (inv.nics || []).forEach(n => { rows += row('Network', n.name, n.macAddress); });

  const when = inv.capturedAt ? new Date(inv.capturedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  body.innerHTML =
    `<table class="inv-table"><thead><tr><th>Component</th><th>Brand / model / part</th><th>Serial</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="inv-foot">Captured ${escapeHtmlLite(when)} · source: ${escapeHtmlLite(inv.source || 'wmi-cim')}` +
    (inv.hwinfo && inv.hwinfo.available ? ' · enriched by locally-installed HWiNFO' : '') + '</div>';
}

// ═══════════════════════════════════════════════════════════
//  STRESS-TEST PROGRESS (v1.5.1)
//  The bar reflects how much torture the machine has taken, but it can NEVER
//  reach 100% from run count alone — a rig is only "done" when the technician
//  says so. Each completed diagnostics run adds progress with diminishing
//  returns and hard-caps at 90%; the sign-off button is the only path to 100%.
// ═══════════════════════════════════════════════════════════
const STRESS_CAP_BEFORE_SIGNOFF = 90;

// v1.9.8 — the bar now measures REAL WORK, not button presses. Progress is the
// total time the machine actually spent under load, against a target of
// STRESS_TARGET_SEC. So a 15-min Throttle fills half the bar and a second one
// completes it, while a 30-min Stability fills it in a single run — and a 24-hour
// Extreme soak can never count the same as a 15-minute Throttle, which is exactly
// what the old count-based curve got wrong. Sign-off remains the ONLY way to reach
// 100%. Tickets created before this change recorded no duration, so they fall back
// to the historical run-count curve rather than suddenly reading 0%.
const STRESS_TARGET_SEC = 1800;   // 30 minutes of real load = a full bar

function stressProgressPercent(ticket) {
  if (!ticket) return 0;
  if (ticket.stressSignedOff) return 100;
  const secs = ticket.stressTotalSec || 0;
  if (secs > 0) {
    const pct = STRESS_CAP_BEFORE_SIGNOFF * (secs / STRESS_TARGET_SEC);
    return Math.min(STRESS_CAP_BEFORE_SIGNOFF, Math.round(pct));
  }
  const runs = ticket.stressRuns || 0;
  if (runs <= 0) return 0;
  // Legacy ticket (no recorded duration): old asymptotic run-count curve.
  const pct = STRESS_CAP_BEFORE_SIGNOFF * (1 - Math.pow(0.5, runs));
  return Math.min(STRESS_CAP_BEFORE_SIGNOFF, Math.round(pct));
}

function renderStressProgress(ticket) {
  const wrap = document.getElementById('modal-stress-progress-wrap');
  const bar = document.getElementById('modal-stress-bar');
  const pctEl = document.getElementById('modal-stress-pct');
  const meta = document.getElementById('modal-stress-meta');
  // v1.8.1 — the admin bar is READ-ONLY now (button moved to the client), so
  // it no longer requires the button to render.
  const btn = document.getElementById('btn-tortured-enough');
  if (!wrap || !bar || !pctEl || !meta) return;

  const pct = stressProgressPercent(ticket);
  const runs = (ticket && ticket.stressRuns) || 0;
  const done = !!(ticket && ticket.stressSignedOff);

  bar.style.width = pct + '%';
  bar.classList.toggle('complete', done);
  pctEl.textContent = pct + '%';
  pctEl.classList.toggle('complete', done);

  if (done) {
    meta.textContent = `Signed off by the technician after ${runs} stress run${runs === 1 ? '' : 's'}` +
      (ticket.stressSignedOffAt ? ' · ' + new Date(ticket.stressSignedOffAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  } else {
    // v1.9.8 — the zero-run case used to read "Signed off in the Testing Client.",
    // which made an untouched ticket look already signed off. State the truth, and
    // show the real time under load once runs exist.
    const totalSec0 = (ticket && ticket.stressTotalSec) || 0;
    const totalTxt0 = totalSec0 ? ` · ${fmtDuration(totalSec0 * 1000)} under load` : '';
    meta.textContent = runs === 0
      ? 'No stress runs recorded yet — the technician signs off in the Testing Client.'
      : `${runs} stress run${runs === 1 ? '' : 's'} completed${totalTxt0} — awaiting sign-off in the Testing Client.`;
  }
}

// Called whenever a diagnostics/stress run finishes for a ticket (admin OR client).
function recordStressRun(ticketId, runInfo) {
  const t = appState.tickets.find(x => x.id === ticketId);
  if (!t) return;
  t.stressRuns = (t.stressRuns || 0) + 1;
  // v1.9.8 — accumulate the ACTUAL time under load and keep a per-run log, so the
  // progress bar reflects real work and the report can state how long the machine
  // was tortured. runInfo is the diagnostics result straight from main.js.
  const secs = (runInfo && runInfo.runDurationSec) ? Math.max(0, Math.round(runInfo.runDurationSec)) : 0;
  if (secs > 0) t.stressTotalSec = (t.stressTotalSec || 0) + secs;
  if (!Array.isArray(t.stressLog)) t.stressLog = [];
  t.stressLog.push({
    mode: (runInfo && runInfo.stressMode) || null,
    startedAt: (runInfo && runInfo.runStartedAt) || null,
    finishedAt: (runInfo && runInfo.runFinishedAt) || new Date().toISOString(),
    durationSec: secs,
    prime95Sec: (runInfo && runInfo.prime95RequestedSec) || 0
  });
  if (t.stressLog.length > 50) t.stressLog.splice(0, t.stressLog.length - 50);
  t.updatedAt = new Date().toISOString();
  saveDatabase();
  syncTicketToCloud(t);
  if (editingTicketId === ticketId) renderStressProgress(t);
  if (typeof renderClientStressProgress === 'function' && clientActiveTicketId() === ticketId) renderClientStressProgress();
  if (currentMode === 'staff') renderDashboard();
}

// Sign-off button — the ONLY way stress testing reaches 100%.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-tortured-enough');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!editingTicketId) return;
    const t = appState.tickets.find(x => x.id === editingTicketId);
    if (!t) return;
    if (!(t.stressRuns > 0)) { showToast('Run the stress test at least once before signing off.', 'warning'); return; }
    if (!(await showConfirm(`Sign off stress testing for ${t.customerName}?\n\n${t.stressRuns} run(s) completed. This marks stress testing 100% complete.`, { title: 'Sign off stress testing', okText: 'Sign off' }))) return;
    t.stressSignedOff = true;
    t.stressSignedOffAt = new Date().toISOString();
    t.updatedAt = new Date().toISOString();
    saveDatabase();
    syncTicketToCloud(t);
    renderStressProgress(t);
    renderDashboard();
  });
});

// ═══════════════════════════════════════════════════════════
//  CUSTOMER-SUPPLIED PARTS (v1.5.1)
//  Components the customer brought / transferred from an old PC. They are not
//  on the invoice, so they must not be priced into the build and must never be
//  reported as a spec "mismatch" during verification.
// ═══════════════════════════════════════════════════════════
const customerSuppliedSet = new Set();

function readCustomerSuppliedFromForm() {
  customerSuppliedSet.clear();
  document.querySelectorAll('#cust-supplied-grid input[data-cs]').forEach(cb => {
    if (cb.checked) customerSuppliedSet.add(cb.dataset.cs);
  });
  const badge = document.getElementById('cust-supplied-badge');
  if (badge) badge.classList.toggle('hidden', customerSuppliedSet.size === 0);
  return Array.from(customerSuppliedSet);
}

function renderCustomerSupplied(list) {
  customerSuppliedSet.clear();
  (Array.isArray(list) ? list : []).forEach(c => customerSuppliedSet.add(c));
  document.querySelectorAll('#cust-supplied-grid input[data-cs]').forEach(cb => {
    cb.checked = customerSuppliedSet.has(cb.dataset.cs);
  });
  const badge = document.getElementById('cust-supplied-badge');
  if (badge) badge.classList.toggle('hidden', customerSuppliedSet.size === 0);
}

function isCustomerSupplied(category) {
  // 'mobo' is the spec-field name; 'motherboard' is the canonical category.
  if (category === 'mobo') category = 'motherboard';
  return customerSuppliedSet.has(category);
}

document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('cust-supplied-grid');
  if (!grid) return;
  grid.addEventListener('change', () => {
    readCustomerSuppliedFromForm();
    if (typeof checkSpecsMatch === 'function') { try { checkSpecsMatch(); } catch (_) {} }
  });
});

// ═══════════════════════════════════════════════════════════
//  SPEC VERIFICATION OVERRIDE — secret keybind Ctrl+Alt+G (v1.5.1)
//  Now that the full HWiNFO-grade inventory gives real brand/model/serial
//  data, verification is strict. When the technician KNOWS a flagged part is
//  correct (odd vendor string, OEM rebadge, etc.) this force-passes it.
//  Every override is recorded on the ticket and printed on the QC report —
//  it is an audited manual sign-off, not a silent bypass.
// ═══════════════════════════════════════════════════════════
const specOverrides = new Set();

function applySpecOverrideAll() {
  ['mobo', 'cpu', 'gpu', 'ram', 'storage'].forEach(c => specOverrides.add(c));
  if (typeof checkSpecsMatch === 'function') { try { checkSpecsMatch(); } catch (_) {} }
  const el = document.getElementById('specs-match-status');
  if (el) {
    el.classList.remove('hidden');
    el.textContent = '🔓 Verification manually overridden by technician (Ctrl+Alt+G) — recorded on the QC report.';
    el.style.background = 'rgba(124,92,255,0.15)';
    el.style.color = '#7c5cff';
    el.style.borderColor = 'rgba(124,92,255,0.4)';
  }
}

document.addEventListener('keydown', async (e) => {
  if (e.ctrlKey && e.altKey && (e.code === 'KeyG' || e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    if (specOverrides.size) {
      specOverrides.clear();
      if (typeof checkSpecsMatch === 'function') { try { checkSpecsMatch(); } catch (_) {} }
    } else {
      if (!(await showConfirm('Override spec verification for this build?\n\nAll component checks will be force-passed and the override will be recorded on the QC report.', { title: 'Override spec verification', okText: 'Override', danger: true }))) return;
      applySpecOverrideAll();
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  CASE PORT CERTIFICATION (v1.7.0)
//
//  The question this answers: "does the USB port on the front of the case
//  actually work?" Windows cannot answer it — nothing in WMI/PnP records
//  whether a socket is on the case or the rear I/O panel. What Windows DOES
//  expose is a socket fingerprint (parent hub + Port_#/Hub_#).
//
//  So the flow is physical and honest:
//    1. baseline snapshot of everything currently connected
//    2. technician plugs the drive into ONE named port
//    3. poll until a NEW device appears — that device's socket fingerprint IS
//       the port being tested, which also proves the socket is live
//    4. write + read back real data through it (unbuffered, so no cache lies)
//
//  No new device => the port is dead. Data corruption => the port is faulty.
//  Nothing is ever assumed to pass.
// ═══════════════════════════════════════════════════════════
const PORTCERT_TYPES = {
  'usb-a':      { icon: '🔌', name: 'USB-A',          dataCapable: true },
  'usb-c':      { icon: '⚡', name: 'USB-C',          dataCapable: true },
  'headphone':  { icon: '🎧', name: 'Headphone jack', dataCapable: false },
  'mic':        { icon: '🎙️', name: 'Microphone jack', dataCapable: false },
  'cardreader': { icon: '💾', name: 'Card reader',    dataCapable: true }
};

let casePorts = [];        // [{ id, type, label, status, detail, socketKey, speed... }]
let portCertRunner = null; // active guided test state

function portCertSave() {
  if (!editingClientTicketId()) return;
  const t = appState.tickets.find(x => x.id === editingClientTicketId());
  if (!t) return;
  t.diagnostics = t.diagnostics || {};
  t.diagnostics.casePorts = casePorts;
  t.updatedAt = new Date().toISOString();
  saveDatabase();
  syncTicketToCloud(t);
}

function editingClientTicketId() {
  const sel = document.getElementById('client-ticket-select');
  return sel ? sel.value : null;
}

function portCertDefaults() {
  return [
    { id: 'p1', type: 'usb-a', label: 'Front USB-A #1', status: 'untested' },
    { id: 'p2', type: 'usb-a', label: 'Front USB-A #2', status: 'untested' },
    { id: 'p3', type: 'usb-c', label: 'Front USB-C',    status: 'untested' },
    { id: 'p4', type: 'headphone', label: 'Front headphone jack', status: 'untested' }
  ];
}

function renderCasePorts() {
  const list = document.getElementById('portcert-case-list');
  const summary = document.getElementById('portcert-summary');
  if (!list) return;
  if (!casePorts.length) {
    list.innerHTML = '<div class="portcert-empty">No case ports added yet. Add each port on the case you want certified.</div>';
  } else {
    list.innerHTML = casePorts.map(p => {
      const meta = PORTCERT_TYPES[p.type] || { icon: '🔌', name: p.type };
      const cls = p.status === 'pass' ? 'pass' : p.status === 'fail' ? 'fail' : 'untested';
      const chip = p.status === 'pass' ? '✓ WORKING' : p.status === 'fail' ? '✗ FAILED' : 'NOT TESTED';
      return `<div class="portcert-row ${cls}">
        <span class="portcert-icon">${meta.icon}</span>
        <div class="portcert-info">
          <div class="portcert-label">${escapeHtmlLite(p.label)}</div>
          <div class="portcert-detail">${escapeHtmlLite(p.detail || meta.name + ' — awaiting physical test')}</div>
        </div>
        <span class="portcert-chip ${cls}">${chip}</span>
        <button type="button" class="portcert-test-btn" data-test-port="${p.id}">Test</button>
        <button type="button" class="portcert-del" data-del-port="${p.id}" title="Remove">✕</button>
      </div>`;
    }).join('');
  }
  const passed = casePorts.filter(p => p.status === 'pass').length;
  if (summary) {
    summary.textContent = `${passed} / ${casePorts.length} certified`;
    summary.className = 'portcert-summary' + (casePorts.length && passed === casePorts.length ? ' all-good' : '');
  }
}

// Rear I/O, listed purely as context so the two are never confused.
function renderMoboPorts(portScan) {
  const el = document.getElementById('portcert-mobo-list');
  if (!el) return;
  const ctrls = (portScan && portScan.usbControllers) || [];
  if (!ctrls.length) { el.innerHTML = '<div class="portcert-empty">Run “Scan Ports” above to list motherboard controllers.</div>'; return; }
  el.innerHTML = ctrls.map(c =>
    `<div class="portcert-mobo-row"><span class="portcert-icon">🖥️</span><div class="portcert-info">
      <div class="portcert-label">${escapeHtmlLite(c.name || 'USB controller')}</div>
      <div class="portcert-detail">${escapeHtmlLite(c.generation || 'USB')} · ${escapeHtmlLite(c.status || 'OK')}</div>
    </div></div>`).join('');
}

// ── Guided test engine ─────────────────────────────────────
function portStep(msg, pct) {
  const s = document.getElementById('portcert-step');
  const f = document.getElementById('portcert-runner-fill');
  if (s) s.innerHTML = msg;
  if (f) f.style.width = (pct || 0) + '%';
}

function snapshotKeys(snap) {
  const set = new Set();
  ((snap && snap.usbDevices) || []).forEach(d => set.add(d.instanceId));
  return set;
}

async function portTakeSnapshot() {
  const r = await ipcRenderer.invoke('sys:port-snapshot2');
  return (r && r.ok) ? r.data : null;
}

async function startPortTest(portId) {
  const port = casePorts.find(p => p.id === portId);
  if (!port) return;
  const meta = PORTCERT_TYPES[port.type] || {};
  const runner = document.getElementById('portcert-runner');
  const nextBtn = document.getElementById('btn-portcert-next');
  if (runner) runner.classList.remove('hidden');

  portCertRunner = { portId, phase: 'baseline', cancelled: false };

  if (meta.dataCapable) {
    portStep(`<strong>Step 1 — unplug the test drive.</strong><br>Make sure your test pendrive/SSD is <em>not</em> connected anywhere, then press Continue.`, 10);
  } else {
    portStep(`<strong>Step 1 — unplug your headphones.</strong><br>Make sure nothing is in <em>${escapeHtmlLite(port.label)}</em>, then press Continue.`, 10);
  }
  if (nextBtn) nextBtn.textContent = 'Continue';
  portCertRunner.onNext = async () => {
    portStep('Taking a baseline snapshot of connected devices…', 25);
    const base = await portTakeSnapshot();
    if (!base) { finishPortTest(port, false, 'Could not read device list from Windows.'); return; }
    portCertRunner.baseline = base;
    portCertRunner.baseKeys = snapshotKeys(base);
    portCertRunner.baseAudio = new Set((base.audioEndpoints || []).map(a => a.instanceId));

    if (meta.dataCapable) {
      portStep(`<strong>Step 2 — plug the drive into “${escapeHtmlLite(port.label)}” now.</strong><br>Use that exact socket. Detecting…`, 45);
    } else {
      portStep(`<strong>Step 2 — plug headphones into “${escapeHtmlLite(port.label)}” now.</strong><br>Detecting…`, 45);
    }
    if (nextBtn) nextBtn.disabled = true;
    await pollForPortDevice(port, meta);
    if (nextBtn) nextBtn.disabled = false;
  };
}

async function pollForPortDevice(port, meta) {
  const DEADLINE = 30000, INTERVAL = 1200;
  const started = Date.now();
  while (Date.now() - started < DEADLINE) {
    if (portCertRunner && portCertRunner.cancelled) return;
    await new Promise(r => setTimeout(r, INTERVAL));
    const snap = await portTakeSnapshot();
    if (!snap) continue;

    if (meta.dataCapable) {
      const fresh = (snap.usbDevices || []).filter(d => !portCertRunner.baseKeys.has(d.instanceId));
      if (fresh.length) {
        const dev = fresh[0];
        // Which drive letter did it bring? That's what we push data through.
        const disks = snap.usbDisks || [];
        const baseLetters = new Set();
        (portCertRunner.baseline.usbDisks || []).forEach(d => (d.driveLetters || []).forEach(l => baseLetters.add(l)));
        let letter = null;
        disks.forEach(d => (d.driveLetters || []).forEach(l => { if (!baseLetters.has(l)) letter = l; }));

        port.socketKey = dev.socketKey;
        port.deviceName = dev.busDesc || dev.name;

        if (!letter) {
          finishPortTest(port, false,
            `Device detected on socket ${dev.location || '?'} but Windows gave it no drive letter — the port powers the device but data isn’t usable.`);
          return;
        }
        portStep(`Detected on socket <code>${escapeHtmlLite(dev.location || '?')}</code> (${escapeHtmlLite(letter)}:). Writing and reading back real data…`, 75);
        const io = await ipcRenderer.invoke('sys:port-iotest', letter, 48);
        if (!io || !io.ok || !io.data || !io.data.ok) {
          const err = (io && io.data && io.data.error) || (io && io.error) || 'I/O test failed';
          finishPortTest(port, false, `Device appeared but data transfer failed: ${err}`);
          return;
        }
        const d = io.data;
        port.writeMBps = d.writeMBps; port.readMBps = d.readMBps;
        finishPortTest(port, true,
          `Verified on socket ${dev.location || '?'} — wrote & read back ${d.testedMB} MB intact · ${d.writeMBps} MB/s write, ${d.readMBps} MB/s read`);
        return;
      }
    } else {
      const freshAudio = (snap.audioEndpoints || []).filter(a => !portCertRunner.baseAudio.has(a.instanceId));
      if (freshAudio.length) {
        port.deviceName = freshAudio[0].name;
        finishPortTest(port, true, `Jack detected the plug — Windows registered “${freshAudio[0].name}”.`);
        return;
      }
    }
  }
  finishPortTest(port, false, meta.dataCapable
    ? 'Nothing appeared within 30 s. This port is not delivering a working connection (check the internal header cable).'
    : 'No jack-detection event within 30 s. Either the jack is not wired, or this audio driver does not report jack presence.');
}

function finishPortTest(port, passed, detail) {
  port.status = passed ? 'pass' : 'fail';
  port.detail = detail;
  port.testedAt = new Date().toISOString();
  renderCasePorts();
  portCertSave();
  portStep(passed ? `✅ <strong>${escapeHtmlLite(port.label)} works.</strong> ${escapeHtmlLite(detail)}`
                  : `❌ <strong>${escapeHtmlLite(port.label)} failed.</strong> ${escapeHtmlLite(detail)}`, 100);
  const nextBtn = document.getElementById('btn-portcert-next');
  if (nextBtn) { nextBtn.textContent = 'Done'; nextBtn.disabled = false; }
  portCertRunner = { done: true, onNext: () => {
    const r = document.getElementById('portcert-runner');
    if (r) r.classList.add('hidden');
    portCertRunner = null;
  }};
}

document.addEventListener('DOMContentLoaded', () => {
  const caseList = document.getElementById('portcert-case-list');
  if (caseList) {
    caseList.addEventListener('click', (e) => {
      const t = e.target.closest('[data-test-port]');
      if (t) { startPortTest(t.dataset.testPort); return; }
      const d = e.target.closest('[data-del-port]');
      if (d) {
        casePorts = casePorts.filter(p => p.id !== d.dataset.delPort);
        renderCasePorts(); portCertSave();
      }
    });
  }
  const addBtn = document.getElementById('btn-portcert-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    const type = document.getElementById('portcert-add-type').value;
    const labelEl = document.getElementById('portcert-add-label');
    const meta = PORTCERT_TYPES[type] || {};
    const label = (labelEl.value || '').trim() || (meta.name + ' #' + (casePorts.length + 1));
    casePorts.push({ id: 'p' + Date.now().toString(36), type, label, status: 'untested' });
    labelEl.value = '';
    renderCasePorts(); portCertSave();
  });
  const nextBtn = document.getElementById('btn-portcert-next');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (portCertRunner && typeof portCertRunner.onNext === 'function') portCertRunner.onNext();
  });
  const cancelBtn = document.getElementById('btn-portcert-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    if (portCertRunner) portCertRunner.cancelled = true;
    portCertRunner = null;
    const r = document.getElementById('portcert-runner');
    if (r) r.classList.add('hidden');
  });
});

// ═══════════════════════════════════════════════════════════
//  GOD MODE (v1.8.0) — admin-only report override, Ctrl+Alt+W
//  Staff app only, with a ticket open. Fields left blank keep the measured
//  value; filled fields replace it ON THE PRINTED REPORT for this ticket.
//  Overrides persist on the ticket (diagnostics.__reportOverrides in cloud
//  sync) so the shop retains an internal record of every change.
// ═══════════════════════════════════════════════════════════
const GODMODE_FIELDS = [
  ['cinebench',    'Cinebench score (pts)',        'number'],
  ['cinebenchMode','Cinebench mode',               'select', ['', 'multi', 'single']],
  ['furmark',      'FurMark score (pts)',          'number'],
  ['ssdRead',      'SSD seq. read (MB/s)',         'number'],
  ['ssdWrite',     'SSD seq. write (MB/s)',        'number'],
  ['cpuTempMin',   'CPU temp min (°C)',            'number'],
  ['cpuTempAvg',   'CPU temp avg (°C)',            'number'],
  ['cpuTempMax',   'CPU temp max (°C)',            'number'],
  ['gpuTempMin',   'GPU temp min (°C)',            'number'],
  ['gpuTempAvg',   'GPU temp avg (°C)',            'number'],
  ['gpuTempMax',   'GPU temp max (°C)',            'number'],
  ['cpuClockMax',  'CPU max clock (MHz)',          'number'],
  ['gpuClockMax',  'GPU max clock (MHz)',          'number'],
  ['ramStress',    'RAM stress result',            'select', ['', 'passed', 'failed']],
  ['ramDetail',    'RAM detail line',              'text']
];

function openGodMode() {
  if (currentMode !== 'staff') return;
  if (!editingTicketId) {
    showToast('God Mode edits a specific report.\n\nOpen the ticket you want to edit, then press Ctrl+Alt+W.', 'info', 7000);
    return;
  }
  const ticket = appState.tickets.find(t => t.id === editingTicketId);
  if (!ticket) return;
  const grid = document.getElementById('godmode-grid');
  const d = ticket.diagnostics || {};
  const ov = ticket.reportOverrides || {};
  grid.innerHTML = GODMODE_FIELDS.map(function (f) {
    const key = f[0], label = f[1], kind = f[2];
    const current = d[key] != null ? d[key] : '';
    const overridden = ov[key] != null ? ov[key] : '';
    let input;
    if (kind === 'select') {
      input = '<select id="gm-' + key + '" class="settings-select" style="width:100%;">' +
        f[3].map(function (o) {
          const sel = String(overridden) === o ? ' selected' : '';
          return '<option value="' + escapeHtmlLite(o) + '"' + sel + '>' + (o === '' ? '(measured: ' + escapeHtmlLite(current === '' ? '—' : current) + ')' : escapeHtmlLite(o)) + '</option>';
        }).join('') + '</select>';
    } else {
      input = '<input id="gm-' + key + '" type="' + (kind === 'number' ? 'number' : 'text') + '" value="' + escapeHtmlLite(overridden) + '"' +
        ' placeholder="measured: ' + escapeHtmlLite(current === '' ? '—' : current) + '"' +
        ' style="width:100%; padding:7px 10px; border-radius:7px; border:1px solid var(--glass-border); background:var(--glass-bg); color:var(--text-dark); outline:none;">';
    }
    return '<label style="display:flex; flex-direction:column; gap:4px; font-size:0.7rem; font-weight:700; color:var(--text-muted); margin:0;">' + label + input + '</label>';
  }).join('');
  document.getElementById('godmode-modal').classList.add('active');
}

function saveGodMode(clearAll) {
  const ticket = appState.tickets.find(t => t.id === editingTicketId);
  if (!ticket) return;
  if (clearAll) {
    delete ticket.reportOverrides;
  } else {
    const ov = {};
    GODMODE_FIELDS.forEach(function (f) {
      const el = document.getElementById('gm-' + f[0]);
      if (!el) return;
      const v = (el.value || '').trim();
      if (v === '') return;
      ov[f[0]] = f[2] === 'number' ? parseFloat(v) : v;
    });
    if (Object.keys(ov).length) { ov.__editedAt = new Date().toISOString(); ticket.reportOverrides = ov; }
    else delete ticket.reportOverrides;
  }
  ticket.updatedAt = new Date().toISOString();
  saveDatabase();
  syncTicketToCloud(ticket);
  document.getElementById('godmode-modal').classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  // e.code is layout-independent — with Alt held, e.key can mutate on some
  // keyboard layouts, which is why the keybind seemed dead. KeyW always works.
  if (e.ctrlKey && e.altKey && (e.code === 'KeyW' || e.key === 'w' || e.key === 'W')) {
    e.preventDefault();
    e.stopPropagation();
    openGodMode();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const close = document.getElementById('btn-godmode-close');
  const save = document.getElementById('btn-godmode-save');
  const clear = document.getElementById('btn-godmode-clear');
  if (close) close.addEventListener('click', () => document.getElementById('godmode-modal').classList.remove('active'));
  if (save) save.addEventListener('click', () => saveGodMode(false));
  if (clear) clear.addEventListener('click', () => saveGodMode(true));
});

// ═══════════════════════════════════════════════════════════
//  TESTING CLIENT STRESS MODES (v1.8.1) — Throttle vs Stability
//  Replaces the old gaming/studio use-case dropdown. Both modes run
//  MULTI-CORE Cinebench (real performance). Stability always bundles Prime95
//  and is the default; Throttle is a shorter thermal check with no Prime95.
//  Ctrl+Alt+T unlocks a 15-minute quick-Stability option.
// ═══════════════════════════════════════════════════════════
let clientStressMode = 'stability';
let stabilityQuickUnlocked = false;

function stressModeLabel(mode) {
  return mode === 'throttle' ? '▶ Run Throttle Test'
    : mode === 'extreme' ? '▶ Run Extreme Test (1–2 days)'
    : '▶ Run Stability Test';
}

function getClientStressConfig() {
  if (clientStressMode === 'throttle') {
    const d = document.getElementById('c-throttle-duration');
    return { mode: 'throttle', useCase: 'studio', duration: d ? parseInt(d.value) : 900, runPrime95: false, prime95Duration: 0 };
  }
  if (clientStressMode === 'extreme') {
    // Extreme = a 1–2 day Prime95 torture soak (default 24h). Cinebench/FurMark/RAM
    // still run a capped slice up front; Prime95 then runs for the full soak.
    const d = document.getElementById('c-extreme-duration');
    const secs = d ? parseInt(d.value) : 86400;
    return { mode: 'extreme', useCase: 'studio', duration: Math.min(600, secs), runPrime95: true, prime95Duration: secs, extreme: true };
  }
  // stability
  const d = document.getElementById('c-stability-duration');
  const secs = d ? parseInt(d.value) : 1800;
  // The chosen duration IS the Prime95 torture length; Cinebench/FurMark/RAM
  // run for a capped slice so the whole pass isn't gated on them.
  return { mode: 'stability', useCase: 'studio', duration: Math.min(600, secs), runPrime95: true, prime95Duration: secs };
}

function setClientStressMode(mode) {
  clientStressMode = mode;
  document.querySelectorAll('#c-stress-mode-tabs .stress-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  const tCfg = document.getElementById('c-throttle-config');
  const sCfg = document.getElementById('c-stability-config');
  const eCfg = document.getElementById('c-extreme-config');
  if (tCfg) tCfg.style.display = mode === 'throttle' ? '' : 'none';
  if (sCfg) sCfg.style.display = mode === 'stability' ? '' : 'none';
  if (eCfg) eCfg.style.display = mode === 'extreme' ? '' : 'none';
  const btn = document.getElementById('btn-run-auto-diagnostics');
  const label = stressModeLabel(mode);
  if (btn && !btn.disabled) btn.textContent = label;
  else if (btn) btn.dataset.label = label;
}

// ── Client-side stress progress + torture sign-off (moved from admin) ──
function clientActiveTicketId() {
  const sel = document.getElementById('client-ticket-select');
  return sel ? sel.value : null;
}
function renderClientStressProgress() {
  const id = clientActiveTicketId();
  const t = id ? appState.tickets.find(x => x.id === id) : null;
  const bar = document.getElementById('c-stress-bar');
  const pctEl = document.getElementById('c-stress-pct');
  const meta = document.getElementById('c-stress-meta');
  const btn = document.getElementById('c-btn-tortured-enough');
  const badge = document.getElementById('c-stress-run-badge');
  if (!bar || !pctEl || !meta || !btn) return;
  const runs = (t && t.stressRuns) || 0;
  const done = !!(t && t.stressSignedOff);
  const pct = done ? 100 : (runs <= 0 ? 0 : Math.min(90, Math.round(90 * (1 - Math.pow(0.5, runs)))));
  bar.style.width = pct + '%';
  bar.classList.toggle('complete', done);
  pctEl.textContent = pct + '%';
  pctEl.classList.toggle('complete', done);
  if (badge) badge.textContent = runs + (runs === 1 ? ' run' : ' runs');
  if (done) {
    meta.textContent = `Signed off after ${runs} run${runs === 1 ? '' : 's'}.`;
    btn.textContent = '✓ Signed off';
    btn.disabled = true;
  } else {
    meta.textContent = runs === 0 ? 'No stress runs recorded yet.' : `${runs} run${runs === 1 ? '' : 's'} completed. Keep going or sign off.`;
    btn.textContent = '😈 I have tortured this PC enough';
    btn.disabled = !t || runs === 0;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Mode tabs
  const tabs = document.getElementById('c-stress-mode-tabs');
  if (tabs) tabs.addEventListener('click', e => {
    const t = e.target.closest('.stress-mode-tab');
    if (t) setClientStressMode(t.dataset.mode);
  });
  setClientStressMode('stability');
  // Update run-button label as modes switch even while disabled
  const runBtn = document.getElementById('btn-run-auto-diagnostics');
  if (runBtn && runBtn.dataset.label && !runBtn.disabled) runBtn.textContent = runBtn.dataset.label;

  // Client torture sign-off
  const tort = document.getElementById('c-btn-tortured-enough');
  if (tort) tort.addEventListener('click', async () => {
    const id = clientActiveTicketId();
    const t = id ? appState.tickets.find(x => x.id === id) : null;
    if (!t) { showToast('Select a build first.', 'warning'); return; }
    if (!(t.stressRuns > 0)) { showToast('Run at least one stress test before signing off.', 'warning'); return; }
    if (!(await showConfirm(`Mark stress testing complete for ${t.customerName}?\n\n${t.stressRuns} run(s) done.`, { title: 'Complete stress testing', okText: 'Mark complete' }))) return;
    t.stressSignedOff = true; t.stressSignedOffAt = new Date().toISOString(); t.updatedAt = new Date().toISOString();
    saveDatabase(); syncTicketToCloud(t); renderClientStressProgress();
  });
});

// Ctrl+Alt+T — reveal the 15-minute quick-Stability option (select users only)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    stabilityQuickUnlocked = true;
    const opt = document.getElementById('c-stability-quick-opt');
    if (opt) {
      opt.style.display = '';
      const sel = document.getElementById('c-stability-duration');
      if (sel) sel.value = '900';
      setClientStressMode('stability');
      showToast('Quick 15-minute Stability test unlocked for this session.', 'success');
    }
  }
});

// v1.8.2 — REBALANCE the Testing Client columns so left and right hold a
// similar amount. Done in JS (keeps all IDs/handlers). Result:
//   LEFT  = Spec Verification + Benchmark & Thermal
//   RIGHT = Case Port Certification + RGB Sync
// Previously the right column carried bench + port + rgb and ran far longer.
document.addEventListener('DOMContentLoaded', () => {
  const grid = document.querySelector('#client-screen .client-grid-row');
  const right = document.getElementById('client-panel-right');
  if (!grid || !right) return;
  const left = grid.querySelector('.client-panel');            // first panel = left
  const portrgb = document.querySelector('#client-screen .port-checker-section')
    || document.querySelector('.port-checker-section');
  if (!left || !right || left === right || !portrgb) return;
  // Move the Benchmark & Thermal content (all of the right panel) into the left.
  while (right.firstChild) left.appendChild(right.firstChild);
  // Move Case Port Certification + RGB into the now-empty right panel.
  right.appendChild(portrgb);
  portrgb.style.marginTop = '0';
});

// ═══════════════════════════════════════════════════════════
//  CATALOGUE EDITOR (v1.8.1) — admin settings
//  Search / edit / add / remove component_prices rows. Writes to Supabase and
//  keeps the in-memory catalogMatcher + local cache in sync.
// ═══════════════════════════════════════════════════════════
const CAT_EDITOR_CATEGORIES = ['cpu', 'gpu', 'ram', 'storage', 'psu', 'motherboard', 'cooler', 'case', 'other'];
let catEditorTimer = null;

function catEditorStatus(msg, isErr) {
  const el = document.getElementById('cat-editor-status');
  if (el) { el.textContent = msg || ''; el.style.color = isErr ? '#ef4444' : 'var(--text-muted)'; }
}

async function catEditorSearch(q) {
  const box = document.getElementById('cat-editor-results');
  if (!box) return;
  if (!supabaseClient) { box.innerHTML = '<div class="cat-editor-empty">Cloud catalogue not connected.</div>'; return; }
  q = (q || '').trim();
  if (q.length < 2) { box.innerHTML = '<div class="cat-editor-empty">Type at least 2 characters to search.</div>'; return; }
  catEditorStatus('Searching…');
  try {
    const { data, error } = await supabaseClient
      .from('component_prices')
      .select('sku, name, category, price_inr, source')
      .ilike('name', '%' + q + '%')
      .limit(40);
    if (error) throw error;
    catEditorStatus((data || []).length + ' result(s).');
    renderCatEditorRows(data || []);
  } catch (e) { catEditorStatus('Search failed: ' + e.message, true); }
}

function renderCatEditorRows(rows) {
  const box = document.getElementById('cat-editor-results');
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="cat-editor-empty">No matches.</div>'; return; }
  box.innerHTML = rows.map(r => {
    const opts = CAT_EDITOR_CATEGORIES.map(c => `<option value="${c}"${c === r.category ? ' selected' : ''}>${c}</option>`).join('');
    return `<div class="cat-editor-row" data-sku="${escapeHtmlLite(r.sku)}">
      <input class="cat-e-name" value="${escapeHtmlLite(r.name || '')}" placeholder="Name">
      <select class="cat-e-cat">${opts}</select>
      <input class="cat-e-price" type="number" value="${r.price_inr != null ? r.price_inr : ''}" placeholder="₹ price" style="width:96px;">
      <button type="button" class="cat-e-save" title="Save">💾</button>
      <button type="button" class="cat-e-del" title="Delete">🗑️</button>
    </div>`;
  }).join('');
}

async function catEditorSave(sku, row) {
  if (!supabaseClient) return;
  const name = row.querySelector('.cat-e-name').value.trim();
  const category = row.querySelector('.cat-e-cat').value;
  const priceRaw = row.querySelector('.cat-e-price').value.trim();
  const price_inr = priceRaw === '' ? null : parseFloat(priceRaw);
  if (!name) { catEditorStatus('Name cannot be empty.', true); return; }
  catEditorStatus('Saving…');
  try {
    const { error } = await supabaseClient.from('component_prices')
      .update({ name, category, price_inr, updated_at: new Date().toISOString(), needs_review: false })
      .eq('sku', sku);
    if (error) throw error;
    // keep the in-memory matcher current
    if (catalogMatcher && catalogMatcher._entries) {
      const m = catalogMatcher._entries.find(e => e.sku === sku);
      if (m) { m.name = name; m.category = category; m.price_inr = price_inr; }
    }
    catEditorStatus('Saved “' + name + '”.');
  } catch (e) { catEditorStatus('Save failed: ' + e.message, true); }
}

async function catEditorDelete(sku, row) {
  if (!supabaseClient) return;
  if (!(await showConfirm('Delete this component from the catalogue?', { title: 'Delete component', okText: 'Delete', danger: true }))) return;
  try {
    const { error } = await supabaseClient.from('component_prices').delete().eq('sku', sku);
    if (error) throw error;
    if (catalogMatcher && catalogMatcher._entries) {
      const i = catalogMatcher._entries.findIndex(e => e.sku === sku);
      if (i !== -1) catalogMatcher._entries.splice(i, 1);
    }
    row.remove();
    catEditorStatus('Deleted.');
  } catch (e) { catEditorStatus('Delete failed: ' + e.message, true); }
}

async function catEditorAdd() {
  if (!supabaseClient) { catEditorStatus('Cloud catalogue not connected.', true); return; }
  const name = prompt('New component name (e.g. "MSI B850M Gaming Pro WiFi"):');
  if (!name || !name.trim()) return;
  const category = (prompt('Category (cpu/gpu/ram/storage/psu/motherboard/cooler/case/other):', 'other') || 'other').trim().toLowerCase();
  const priceRaw = prompt('Price ₹ (blank if unknown):', '');
  const price_inr = priceRaw && priceRaw.trim() !== '' ? parseFloat(priceRaw) : null;
  const sku = 'MANUAL-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  catEditorStatus('Adding…');
  try {
    const now = new Date().toISOString();
    const { error } = await supabaseClient.from('component_prices').upsert({
      sku, name: name.trim(), category: CAT_EDITOR_CATEGORIES.indexOf(category) >= 0 ? category : 'other',
      price_inr, source: 'admin-edit', source_method: 'catalogue-editor', fetched_at: now, updated_at: now, needs_review: false
    }, { onConflict: 'sku' });
    if (error) throw error;
    if (catalogMatcher && catalogMatcher.addEntry) catalogMatcher.addEntry({ sku, name: name.trim(), category, price_inr });
    catEditorStatus('Added “' + name.trim() + '”.');
    catEditorSearch(name.trim());
  } catch (e) { catEditorStatus('Add failed: ' + e.message, true); }
}

document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('cat-editor-search');
  const addBtn = document.getElementById('cat-editor-add');
  const box = document.getElementById('cat-editor-results');
  if (search) search.addEventListener('input', () => {
    clearTimeout(catEditorTimer);
    catEditorTimer = setTimeout(() => catEditorSearch(search.value), 250);
  });
  if (addBtn) addBtn.addEventListener('click', catEditorAdd);
  if (box) box.addEventListener('click', e => {
    const row = e.target.closest('.cat-editor-row');
    if (!row) return;
    const sku = row.dataset.sku;
    if (e.target.classList.contains('cat-e-save')) catEditorSave(sku, row);
    else if (e.target.classList.contains('cat-e-del')) catEditorDelete(sku, row);
  });
});
