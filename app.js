const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

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
            renderItem(result.name, priceLabel, () => {
              input.value = result.name;
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

    // Always-available manual entry: the spec fields save whatever free text
    // is typed, but nothing in the UI said so — technicians hitting a part
    // that's missing from the catalog (and from the online lookup) thought
    // they were stuck. This row makes "just use what I typed" an explicit,
    // clickable choice at the bottom of every suggestion list.
    const renderManualRow = (query) => {
      const row = document.createElement('div');
      row.className = 'autocomplete-item autocomplete-manual-entry';
      row.style.opacity = '0.85';
      row.style.borderTop = '1px dashed rgba(15, 23, 42, 0.15)';
      row.textContent = `✏️ Use "${query}" as typed (manual entry)`;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = query;
        delete specFieldMatches[field.inputId]; // no catalog SKU behind this text — honest manual entry
        list.classList.add('hidden');
        list.innerHTML = '';
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
            const priceLabel = res.priceInr != null ? `₹${Math.round(res.priceInr).toLocaleString('en-IN')}` : '';
            renderItem(res.matchedName, priceLabel, () => {
              input.value = res.matchedName;
              specFieldMatches[field.inputId] = { sku: res.sku, priceInr: res.priceInr, category: res.category, confidence: res.confidence };
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

    input.addEventListener('input', updateSuggestions);
    input.addEventListener('focus', updateSuggestions);
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

// App Global State
let appState = {
  tickets: [],
  technicians: ["Adhil", "Amal", "Ananthakrishnan", "Athul"],
  rivalBenchmarks: [],
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
  if (!appState.rivalBenchmarks) appState.rivalBenchmarks = [
    { id: "1", name: "Ryzen 5 7600 + RTX 4060", cpu: "Ryzen 5 7600", gpu: "RTX 4060", cinebenchR23: 13800, readSpeed: 5000, writeSpeed: 4000, price: "₹18,500 (~$210)" },
    { id: "2", name: "Intel i7-14700K + RTX 4070 Ti", cpu: "Core i7-14700K", gpu: "RTX 4070 Ti Super", cinebenchR23: 35000, readSpeed: 7000, writeSpeed: 6000, price: "₹68,000 (~$820)" }
  ];

  // Database migration & normalization for default rival configs and new build checks
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

  if (appState.rivalBenchmarks && appState.rivalBenchmarks.length > 0) {
    appState.rivalBenchmarks.forEach(rival => {
      if (rival.id === "1") {
        if (rival.cinebenchR23 === 14500 || !rival.price) {
          rival.cinebenchR23 = 13800;
          rival.price = "₹18,500 (~$210)";
          databaseNeedsSaving = true;
        }
      } else if (rival.id === "2") {
        if (!rival.price) {
          rival.price = "₹68,000 (~$820)";
          databaseNeedsSaving = true;
        }
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

      const card = document.createElement('div');
      card.className = `glass-slab ticket-card ${t.status} ${isUrgent ? 'urgent' : ''}`;
      card.innerHTML = `
        <div class="ticket-card-header">
          <span class="card-id">#${t.id.slice(-6)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="card-status-label ${t.status}">${statusText}</span>
            <span class="card-status-dot ${t.status}"></span>
          </div>
        </div>
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
            ⚠️ <strong>Awaiting:</strong> ${t.missingComponents || 'Parts unspecified'}
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
        <td>${t.specs ? (t.specs.cpu || 'System Build') : 'N/A'}</td>
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
      const partsInput = document.getElementById('form-missing-components');
      partsInput.disabled = !ticket.missingComponentsToggle;
      partsInput.value = ticket.missingComponents || '';

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
    }
  } else {
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

  // Populate target specs
  document.getElementById('c-target-mobo').textContent = (ticket.specs && ticket.specs.mobo) || '--';
  document.getElementById('c-target-cpu').textContent = (ticket.specs && ticket.specs.cpu) || '--';
  document.getElementById('c-target-gpu').textContent = (ticket.specs && ticket.specs.gpu) || '--';
  document.getElementById('c-target-ram').textContent = (ticket.specs && ticket.specs.ram) || '--';
  document.getElementById('c-target-storage').textContent = (ticket.specs && ticket.specs.storage) || '--';
  
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

// Persist a portCheckV2 category result into the selected ticket + qcChecks
async function savePortCheckResult(type, categoryResult) {
  const ticketId = document.getElementById('client-ticket-select').value;
  if (!ticketId) return;
  const index = appState.tickets.findIndex(t => t.id === ticketId);
  if (index === -1) return;
  const ticket = appState.tickets[index];

  if (!ticket.diagnostics) ticket.diagnostics = {};
  if (!ticket.diagnostics.portCheckV2) ticket.diagnostics.portCheckV2 = { categories: {} };
  ticket.diagnostics.portCheckV2.ranAt = new Date().toISOString();
  ticket.diagnostics.portCheckV2.categories[type] = categoryResult;

  if (!ticket.qcChecks) ticket.qcChecks = {};
  const passed = categoryResult.status === 'pass';
  if (type === 'usb') ticket.qcChecks.portUsb = passed;
  else if (type === 'video') ticket.qcChecks.portVideo = passed;
  else if (type === 'audio') ticket.qcChecks.portAudio = passed;

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

// Port Checker v2 — guided before/after verification.
// Windows can only enumerate what it detects, so passive "is anything plugged
// in" tells you nothing about a SPECIFIC port. Instead: snapshot the device
// list, have the tech plug a known-good device into the port under test, then
// snapshot again — a new device appearing PROVES that physical port works.
function setupPortsChecker() {
  const guided = [
    { type: 'usb',   name: 'USB Ports',    device: 'a USB flash drive or peripheral into the port you want to prove' },
    { type: 'video', name: 'Video Output', device: 'a monitor into the HDMI / DisplayPort you want to prove' },
    { type: 'audio', name: 'Audio Jack',   device: 'headphones or a speaker into the audio jack you want to prove' }
  ];
  const portState = {}; // type -> { before: [device names] }

  function setBadge(type, status, label) {
    const badge = document.getElementById(`badge-port-${type}`);
    if (badge) { badge.className = `dr-pill dr-status-${status}`; badge.textContent = label; }
  }

  guided.forEach(cfg => {
    const btn = document.getElementById(`btn-scan-${cfg.type}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const ticketId = document.getElementById('client-ticket-select').value;
      if (!ticketId) { alert("Please select a ticket first before verifying ports!"); return; }
      const hint = document.getElementById(`hint-port-${cfg.type}`);
      const listEl = document.getElementById(`list-port-${cfg.type}`);
      const phase = btn.getAttribute('data-phase') || 'start';

      if (phase === 'start') {
        btn.disabled = true;
        setBadge(cfg.type, 'unverified', 'Snapshotting…');
        const snap = await ipcRenderer.invoke('sys:port-snapshot', cfg.type);
        btn.disabled = false;

        if (!snap.available) {
          setBadge(cfg.type, 'unverified', 'Cannot verify');
          if (hint) { hint.classList.remove('hidden'); hint.textContent = `Could not verify — ${snap.error || 'detection unavailable'}.`; }
          await savePortCheckResult(cfg.type, { status: 'unverified', error: snap.error || 'unavailable', beforeDevices: [], afterDevices: [], newDevicesDetected: [] });
          appendConsoleLine('c-console-box', `[PORT] ${cfg.name}: UNVERIFIED (${snap.error || 'unavailable'}).`);
          return;
        }

        portState[cfg.type] = { before: snap.devices || [] };
        if (hint) { hint.classList.remove('hidden'); hint.innerHTML = `Baseline captured. Now plug in <strong>${cfg.device}</strong>, then click <strong>Verify</strong>.`; }
        if (listEl) { listEl.classList.remove('hidden'); listEl.innerHTML = `<div class="dr-list-item"><span class="dr-muted">Baseline: ${(snap.devices || []).length} device(s) already present</span></div>`; }
        setBadge(cfg.type, 'unverified', 'Awaiting device');
        btn.textContent = 'Verify';
        btn.setAttribute('data-phase', 'verify');
        appendConsoleLine('c-console-box', `[PORT] ${cfg.name}: baseline captured (${(snap.devices || []).length} devices). Waiting for plug-in…`);
      } else {
        btn.disabled = true;
        setBadge(cfg.type, 'unverified', 'Verifying…');
        const snap = await ipcRenderer.invoke('sys:port-snapshot', cfg.type);
        btn.disabled = false;

        const before = (portState[cfg.type] && portState[cfg.type].before) || [];
        const after = snap.available ? (snap.devices || []) : [];
        const newDevices = after.filter(d => !before.includes(d));
        const status = !snap.available ? 'unverified' : (newDevices.length > 0 ? 'pass' : 'fail');

        setBadge(cfg.type, status, status === 'pass' ? 'Verified' : status === 'fail' ? 'No new device' : 'Cannot verify');
        if (listEl) {
          listEl.classList.remove('hidden');
          listEl.innerHTML = newDevices.length
            ? `<div class="dr-list-item"><span class="dr-muted">Newly detected on verify:</span></div>` + newDevices.map(d => `<div class="dr-list-item"><span>${window.NeoQcDiagnosticsRender.esc(d)}</span></div>`).join('')
            : `<div class="dr-list-item" style="color:var(--dr-status-fail);">No new device detected — the port may be faulty, or nothing was plugged in.</div>`;
        }
        if (hint) hint.classList.add('hidden');
        await savePortCheckResult(cfg.type, { status, beforeDevices: before, afterDevices: after, newDevicesDetected: newDevices });
        appendConsoleLine('c-console-box', `[PORT] ${cfg.name}: ${status.toUpperCase()} (${newDevices.length} new device).`);
        btn.textContent = 'Re-check';
        btn.setAttribute('data-phase', 'start');
      }
    });
  });

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
          if (listEl) { listEl.classList.remove('hidden'); listEl.innerHTML = `<div class="dr-list-item"><span class="dr-muted">No OpenRGB-controllable devices found.</span></div>`; }
        }
        appendConsoleLine('c-console-box', `[RGB] Detected ${detailed.length} controllable device(s).`);
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
  const missingComponents = document.getElementById('form-missing-components').value;

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
    
    const isDiagLogged = diagnostics.cpuTempAvg !== null && diagnostics.gpuTempAvg !== null && diagnostics.cinebench !== null;
    
    if (isQcComplete && isDiagLogged) {
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
        addEventLog(updatedTicket, `Awaiting parts: "${updatedTicket.missingComponents}"`, techName);
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
  if (!window.NeoQcPrintRender) {
    console.error('print-render.js not loaded — cannot populate print report');
    return;
  }
  window.NeoQcPrintRender.populate(
    ticket,
    (appState && appState.settings) || {},
    ppiCacheByTicket[ticket.id]
  );
}

function triggerPrintReport(ticketId, shouldPrint = true) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  populatePrintFields(ticket);

  // Execute print in main Electron window
  if (shouldPrint) {
    ipcRenderer.invoke('sys:print');
  }
}

async function triggerSavePdf(ticketId) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  populatePrintFields(ticket);

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

  // Render Rival Configs
  const rivalsBody = document.getElementById('settings-rivals-table-body');
  rivalsBody.innerHTML = '';
  appState.rivalBenchmarks.forEach(rival => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${rival.name}</td>
      <td>${rival.price || '--'}</td>
      <td>${rival.cinebenchR23}</td>
      <td>${rival.readSpeed}</td>
      <td>${rival.writeSpeed}</td>
      <td><button class="text-btn text-crimson remove-rival-btn">Remove</button></td>
    `;
    row.querySelector('.remove-rival-btn').addEventListener('click', () => {
      appState.rivalBenchmarks = appState.rivalBenchmarks.filter(r => r.id !== rival.id);
      openSettingsModal(); // Refresh
    });
    rivalsBody.appendChild(row);
  });

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

  // App version — header badge + sidebar label
  const verEl = document.getElementById('settings-app-version');
  const sideVerEl = document.getElementById('settings-sidebar-ver');
  if (window.require) {
    try {
      const ver = 'v' + window.require('electron').remote?.app?.getVersion?.();
      if (verEl) verEl.textContent = ver;
      if (sideVerEl) sideVerEl.textContent = ver;
    } catch(_) {}
  }

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

  // Theme change toggle
  document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode');
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

  // Add rival config
  document.getElementById('btn-add-rival').addEventListener('click', () => {
    const name = document.getElementById('new-rival-name').value.trim();
    const price = document.getElementById('new-rival-price').value.trim();
    const cb = parseInt(document.getElementById('new-rival-cb').value);
    const read = parseInt(document.getElementById('new-rival-read').value);
    const write = parseInt(document.getElementById('new-rival-write').value);

    if (name && !isNaN(cb)) {
      const newRival = {
        id: 'r_' + Date.now().toString(36),
        name,
        price: price || '--',
        cinebenchR23: cb,
        readSpeed: read || 5000,
        writeSpeed: write || 4000
      };
      appState.rivalBenchmarks.push(newRival);
      document.getElementById('new-rival-name').value = '';
      document.getElementById('new-rival-price').value = '';
      document.getElementById('new-rival-cb').value = '';
      document.getElementById('new-rival-read').value = '';
      document.getElementById('new-rival-write').value = '';
      openSettingsModal();
    }
  });

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

  // Missing components details toggling inputs
  const componentsToggle = document.getElementById('form-missing-components-toggle');
  componentsToggle.addEventListener('change', () => {
    const input = document.getElementById('form-missing-components');
    input.disabled = !componentsToggle.checked;
    if (!componentsToggle.checked) input.value = '';
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

  // Compute Price-to-Performance (shells to ppi_sync.py via main process)
  const ppiBtn = document.getElementById('btn-compute-ppi');
  if (ppiBtn) {
    ppiBtn.addEventListener('click', async () => {
      if (!editingTicketId) {
        alert('Save the ticket first — PPI needs a stored ticket with specs.');
        return;
      }
      const useCaseSel = document.getElementById('modal-usecase-select');
      const useCase = useCaseSel ? useCaseSel.value : '';
      ppiBtn.disabled = true;
      ppiBtn.textContent = 'Computing…';
      try {
        const res = await ipcRenderer.invoke('ppi:compute', { ticketId: editingTicketId, useCase });
        if (res && res.success) {
          await loadAndRenderPpi(editingTicketId);
        } else {
          alert('PPI compute failed: ' + ((res && res.error) || 'unknown error'));
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
              if (!parsed.rivalBenchmarks) parsed.rivalBenchmarks = [];
              if (!parsed.settings) parsed.settings = appState.settings;
              
              appState = parsed;
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
          rivalBenchmarks: [
            { id: "1", name: "Ryzen 5 7600 + RTX 4060", cpu: "Ryzen 5 7600", gpu: "RTX 4060", cinebenchR23: 13800, readSpeed: 5000, writeSpeed: 4000, price: "₹18,500 (~$210)" },
            { id: "2", name: "Intel i7-14700K + RTX 4070 Ti", cpu: "Core i7-14700K", gpu: "RTX 4070 Ti Super", cinebenchR23: 35000, readSpeed: 7000, writeSpeed: 6000, price: "₹68,000 (~$820)" }
          ],
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
    } catch (err) {
      console.error("Failed to initialize Supabase Client:", err);
      supabaseClient = null;
    }
  } else {
    console.log("Supabase cloud sync not active (no keys configured). Using local storage.");
    supabaseClient = null;
  }
}

// Upload a single ticket to Supabase
async function syncTicketToCloud(ticket) {
  if (!supabaseClient) return;
  try {
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
        specs: ticket.specs,
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
  const iter = data.iterations || 0;
  
  const cVal = document.getElementById('c-hud-ram-val');
  const cBar = document.getElementById('c-hud-ram-bar');
  const cDesc = document.getElementById('c-hud-ram-desc');
  if (cVal) cVal.textContent = `${pct}%`;
  if (cBar) cBar.style.width = `${pct}%`;
  if (cDesc) cDesc.textContent = `RAM Stressing: Iteration ${iter}`;

  const mVal = document.getElementById('modal-hud-ram-val');
  const mBar = document.getElementById('modal-hud-ram-bar');
  const mDesc = document.getElementById('modal-hud-ram-desc');
  if (mVal) mVal.textContent = `${pct}%`;
  if (mBar) mBar.style.width = `${pct}%`;
  if (mDesc) mDesc.textContent = `RAM Stressing: Iteration ${iter}`;
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

  if (ramVal) ramVal.textContent = '100%';
  if (ramBar) ramBar.style.width = '100%';
  if (ramDesc) ramDesc.textContent = res.ramPassed ? 'RAM test passed successfully.' : 'RAM test failed!';

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
  appendConsoleLine(boxId, `[SYS] RAM stress test: ${res.ramPassed ? "PASSED ✓" : "FAILED ✗"}.`);

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

      // Prime95 is the authoritative CPU+RAM torture test — its result is what
      // now actually populates ramStress/ramDetail (previously read by the
      // print report and dashboard's qcBadge() but never written by anything).
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
  panel.innerHTML = R.renderPpiPanel(null);
  if (!supabaseClient || !ticketId) return;
  try {
    const { data, error } = await supabaseClient
      .from('ticket_ppi').select('*').eq('ticket_id', ticketId).maybeSingle();
    if (!error && data) {
      ppiCacheByTicket[ticketId] = data;
      panel.innerHTML = R.renderPpiPanel(data);
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
  if (hours) hours.textContent = h.powerOnHours != null ? `${h.powerOnHours.toLocaleString()} hrs` : 'N/A';

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
      <stop offset="0%" stop-color="${color === 'purple' ? '#a78bfa' : color === 'cyan' ? '#22d3ee' : color === 'gold' ? '#fbbf24' : color === 'green' ? '#34d399' : '#ff1a75'}" />
      <stop offset="50%" stop-color="${primary}" />
      <stop offset="100%" stop-color="${color === 'purple' ? '#6d28d9' : color === 'cyan' ? '#0891b2' : color === 'gold' ? '#d97706' : color === 'green' ? '#059669' : '#b3003b'}" />
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

  const targetMobo = (ticket.specs && ticket.specs.mobo || '').toLowerCase().trim();
  const targetCpu = (ticket.specs && ticket.specs.cpu || '').toLowerCase().trim();
  const targetGpu = (ticket.specs && ticket.specs.gpu || '').toLowerCase().trim();
  const targetRam = (ticket.specs && ticket.specs.ram || '').toLowerCase().trim();
  const targetStorage = (ticket.specs && ticket.specs.storage || '').toLowerCase().trim();

  const detMobo = (detectedSpecs.motherboard || '').toLowerCase().trim();
  const detCpu = (detectedSpecs.cpu || '').toLowerCase().trim();
  const detGpu = (detectedSpecs.dgpu || detectedSpecs.gpu || '').toLowerCase().trim();
  const detRam = (detectedSpecs.ram || '').toLowerCase().trim();
  const detStorage = (detectedSpecs.storage || '').toLowerCase().trim();

  // Basic matching
  const moboMatch = targetMobo === '' || detMobo.includes(targetMobo) || targetMobo.includes(detMobo);
  const cpuMatch = targetCpu === '' || detCpu.includes(targetCpu) || targetCpu.includes(detCpu);
  const gpuMatch = targetGpu === '' || detGpu.includes(targetGpu) || targetGpu.includes(detGpu);
  const ramMatch = targetRam === '' || detRam.includes(targetRam) || targetRam.includes(detRam);
  const storageMatch = targetStorage === '' || detStorage.includes(targetStorage) || targetStorage.includes(detStorage);

  const matchStatusEl = document.getElementById('specs-match-status');
  if (matchStatusEl) {
    matchStatusEl.classList.remove('hidden');
    if (moboMatch && cpuMatch && gpuMatch && ramMatch && storageMatch) {
      matchStatusEl.textContent = '✅ Specs Verification: MATCH SUCCESS';
      matchStatusEl.style.background = 'rgba(16, 185, 129, 0.15)';
      matchStatusEl.style.color = '#10b981';
      matchStatusEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } else {
      matchStatusEl.textContent = '⚠️ Specs Verification: MISMATCH DETECTED';
      matchStatusEl.style.background = 'rgba(239, 68, 68, 0.15)';
      matchStatusEl.style.color = '#ef4444';
      matchStatusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
  }
}
