# Neo QC — Session Handoff

**Project:** Neo QC — Electron QC/build-tracking app for Neo Tokyo Kochi service dept
**Repo:** `C:\Users\Aladeen\Desktop\Aladeen\neoqc-main`
**Python:** `C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe`
**Supabase:** `https://ggsxkhenzdhaachubrsc.supabase.co` (anon key hardcoded in `main.js`, `app.js`, `dashboard/app.js`, and every Python script that touches Supabase). **Security note (2026-07-22 review): the anon key ships inside the asar; the entire data-access security model therefore rests on Supabase Row Level Security being enabled and correctly scoped. Confirm RLS policies on `tickets` + `component_prices` — see the code review below.**
**GitHub:** `akruunnithan21-ship-it/neoqc` — releases are the OTA update mechanism (electron-updater)
**Shipped version:** **v1.8.4** (2026-07-22, OTA live + verified). Supersedes v1.8.3 (which shipped a UI-wide mojibake regression — see below). Per-version detail for v1.5.0 → v1.8.4 lives in the auto-memory file `project_neoqc_progress.md`; git log has the commit-level record.
**Last session date:** 2026-07-22

---

## ⭐ v1.8.5 (2026-08-03) — detection fixes + Phase-1 hardening (source pushed, commit 2b72fd0)

Three pre-Phase-2 fixes the user asked for, bundled with the 2026-07-25 Phase-1 hardening
below (both were in the working tree; shipped together as 1.8.5). Source is on `origin/main`;
OTA was cut after the user chose "build + publish now" (updates are opt-in — `autoDownload`
is false). **Not hardware-validated from the dev box** — the RAM fix needs a 64 GB machine
and the invoice fix needs real problem invoices; smoke-test on a shop PC.

1. **RAM sometimes detected as only 32 GB** (`main.js` `sys:detect-hw`). `Win32_PhysicalMemory.
   Capacity` intermittently returns null for a module → the SMBIOS sum halves. Fixed:
   `Math.round(max(smbiosSumBytes, os.totalmem()) / 1GB)`. `os.totalmem()` alone under-reports
   (hardware-reserved memory — this dev laptop's 24 GB reads 23.34), and a complete SMBIOS sum
   is exact and always ≥ the OS figure, so `max()` is correct whether a module drops out or not.
2. **Invoice reader mis-filing parts** (`invoice-import.js`). Root cause: greedy `(row,
   category)` tuple assignment dumped a row displaced from its true category into whatever
   weaker category was still open on a stray model-token hit. Rewrote as weighted argmax-per-row:
   `STRONG_HINTS` (explicit nouns, ×3) + `CATEGORY_HINTS` (×1); each row takes its OWN best open
   category, a fallback only if that fallback itself has a strong noun (score ≥ 3), else the row
   is skipped/`review` rather than mis-filed. Guarded the `window.NeoQcMatcher` reference so it's
   Node-testable. 14/14 unit tests (board-with-DDR5 → motherboard, PSU without the word "PSU",
   wrapped-board fold, ambiguous line not over-filling).
3. **Full per-component detail on the report** (`hw_inventory.ps1`, `print-render.js`, `app.js`).
   The native WMI/CIM inventory already captures make/model/part-number/serial/speed for every
   component — this is the licence-clean answer (HWiNFO's free build is personal-use-only and
   can't ship in a shop tool; `hwinfoEnrich()` still enriches from a licensed local copy if
   present). Enriched the report + admin panel: RAM **rated-vs-configured speed** (surfaces
   XMP/EXPO left off), drive media/health, network adapters, OS build. Fixed two `ps1` cosmetic
   bugs (a link-down NIC reporting a sentinel speed of 8796093022208 → null; iGPU `vramGB` 0 →
   null). Added an inventory mock to `report-harness.html` for A4 verification.
   - **A4 note:** with a full inventory, report page 3 exceeds one A4 sheet, but the report is
     deliberately "flow, don't force" (`.print-section` + `.inv-print-table` are
     `page-break-inside: avoid`), so in real print the inventory moves as a unit to the next
     page — the harness fixed-sheet overflow is a preview artifact, not a clip. A future polish
     is to give the inventory its own page.

Double-checked: `node -c` on all 15 JS modules, 30 IPC handlers all unique, invoice test 14/14,
mojibake guard clean, `hw_inventory.ps1` run on real hardware, report harness renders every page.

---

## ⭐ SESSION 2026-07-25 — Phase-1 hardening + Phase-2 plan (shipped in v1.8.5)

Acted on the 2026-07-22 code review (§B below) + a request to make the window controls
glassy and to plan Phase 2. **All work is in the working tree, NOT yet built/shipped.** No
version bump yet — when ready, bump `package.json` (the changelog badge/button now auto-stamp
from it — see below) and follow the release checklist. Nothing here touches `shared/` so no
`node sync-shared.js` is needed. `node -c app.js / main.js / build-helper.js` all pass.

**What changed this session (all verified in the browser preview where visual):**

1. **Glass window controls** (index.html + style.css `.titlebar-btn`). Replaced the text
   glyphs (—/⬜/×) with crisp inline SVGs and restyled the three buttons as frosted glass
   "pills": gradient fill, glossy top sheen (`::before`), inner-highlight shadow, backdrop
   blur, hover lift, and colour-tinted glass hover states — amber (minimize), emerald
   (maximize), brand-pink→red glow (close). Theme-aware (`body.dark-mode` overrides).
   Verified light + dark + all three hover states via the browser pane.
2. **Non-blocking toast + confirm system** (new `showToast()` / `showConfirm()` in app.js;
   CSS in style.css). Replaced **all 46** native dialogs — 35 `alert()` → `showToast(msg,type)`
   and 11 `confirm()` → `await showConfirm(...)`. **Safety note:** `showConfirm` returns a
   Promise; every one of the 11 sites was made `async` + `await`ed (an un-awaited call is
   truthy and would auto-confirm destructive actions — verified none remain via grep). Toasts
   set text via `textContent` (no injection). Verified render in dark mode.
3. **Atomic local DB writes + recovery** (review #2 high + #6 medium, main.js `db:write`/
   `db:read`). `db:write` now writes `db.json.tmp` then `fs.renameSync` over the real file
   (atomic; a crash can only leave a stray `.tmp`), and keeps a rotating `.bak`. `db:read`
   recovers from `.bak` on corruption, preserves the corrupt file as `.corrupt-<ts>`, and
   records a `dbHealth` status exposed via a new `db:health` IPC. `loadDatabase()` reads it
   and shows a warning/sticky-error toast — a corrupt/lost DB is no longer a silent blank slate.
4. **Silent-save-failure fixed at the root** (review #5, app.js `saveDatabase()`). It ignored
   the `{success:false}` that `db:write` returns; now it checks and toasts on failure so a
   local write error can't quietly lose data. Also added `log.warn/debug` to the three
   diagnostics-parse catches (sensor line / FurMark CSV / Cinebench log) where a swallowed
   error hides a missing measurement — the exact class of the old RAM/temp bugs. The many
   `.kill()`/`unlink` best-effort catches were left silent on purpose (correct as-is).
5. **Stored-XSS render sites escaped** (review #1 high). `escapeHtmlLite()` now wraps
   `customerName`/`technician`/specs on the dashboard card and the completed-builds table, and
   the awaiting-parts note on the card. (The dashboard/`customer.html` static site was NOT
   swept this session — separate deploy, lower risk, note for later.)
6. **Dashboard search debounced** (review QoL, 150 ms) — matched the catalogue editor.
7. **Version auto-stamped** (review QoL). Added `data-app-version` / `data-app-version-label`
   markers to the changelog badge, sentence, and launch button; `stampAppVersion()` fills them
   from `package.json` at load. **The version number no longer needs hand-editing in HTML** —
   only the changelog bullet prose is manual per release. (Done at runtime, NOT by rewriting
   HTML at build time — deliberately, to avoid the v1.8.3 mojibake class of accident.)
8. **RLS hardening documented** (review #4). `database.sql` gained a prominent SECURITY DEBT
   block: RLS is enabled but fully permissive and the anon key ships in every public
   installer → anyone can read/delete customer data. Concrete tightening steps (drop anon
   DELETE, move to `authenticated` role, rotate the key) are stubbed as commented SQL. Live
   policies were NOT changed (can't test from here + would affect the shipped app).
9. **`PHASE2_PLAN.md`** (new, repo root) + a shareable artifact. The "next level" idea:
   **Neo QC → Neo OS**, a component-lifecycle loop tying the four requested areas into one
   system — **Call Centre/CRM**, **Inventory/Rack stock**, **Service desk**, **Procurement** —
   around the existing `component_prices` spine. Phased 2.0→2.5, foundations first.

**Intentionally deferred to the Phase-2 foundation (documented, not forgotten):**
- Review #3 (optimistic-concurrency sync — full-row last-write-wins can clobber concurrent
  edits). Architectural; belongs with multi-role auth.
- Full auth + RLS lockdown + anon-key rotation (review #4). The top security debt.
- The `app.js` 7,100-line module split (review QoL). Too high blast-radius to do blind right
  before a field test; scheduled as Phase-2 step 2.0.
- Full accessibility pass (only new UI + window controls got aria labels this session).

---

## ⭐ CURRENT STATE (2026-07-22) — READ THIS FIRST

Shipped **v1.8.4**, OTA live and verified (feed=1.8.4 Latest, installer HTTP 200, packaged `index.html` extracted from `app.asar` confirmed clean). Below: (A) a concise catch-up of v1.5.0 → v1.8.4, then (B) the full whole-app code review the user requested on 2026-07-22.

### A. Version catch-up v1.5.0 → v1.8.4 (concise — full detail in memory file `project_neoqc_progress.md` + git log)

- **v1.5.0** — invoice-first import (verbatim names, grows catalog, dedupe); full-detail target specs + digital match passes.
- **v1.8.0** (commit 9a94f85) — mode-aware Cinebench (no more false FAIL), CPU/GPU clocks + SSD IOPS captured into report, PPI auto-computes on report, God Mode report editor (Ctrl+Alt+W), wider client layout.
- **v1.8.1** (787d543) — Throttle/Stability test modes replace gaming/studio (client); spec-checker brand aliases (MSI = Micro-Star International, ASUS = ASUSTeK, chipset⊇full-model); honest scores (real Cinebench/FurMark or NOT MEASURED, no fabrication); catalogue editor in Settings; report beauty pass.
- **v1.8.2** (2ac0346, folded forward — never released standalone) — temps + stress progress sync to the admin ticket AND dashboard card; admin side no longer RUNS benchmarks (run controls removed, hidden stubs keep legacy JS null-safe); **customer-supplied parts now persist** (were only saved inside the has-detected-specs branch); Testing Client columns rebalanced (LEFT = Spec + Bench/Thermal, RIGHT = Port Cert + RGB); report gaps removed.
- **v1.8.3** (2470ab0) — the four "run the real tool, don't guess" fixes:
  1. **Cinebench never scored** = we passed `g_CinebenchMinimumTestDuration=<seconds>`; R23 only accepts preset values there, so an out-of-range value ABORTS ~3 s after launch (log stops at "CINEBENCH started", exit 0, no error). Client Throttle passed 900 → silent abort. Flag dropped; verified a full 679 s run → `CB 4748.92`, parser extracts 4748.
  2. **CPU temp blank while GPU fine** = LHM lists `Core (Tctl/Tdie)` but its Value is null without the WinRing0 driver, and the ACPI fallback throws "Access denied". Added a 3rd source: `Win32_PerfFormattedData_Counters_ThermalZoneInformation` (no driver, no elevation; verified live null → 79.9 °C, `tempSource:'thermal-zone-perf-counter'`).
  3. **RAM/SSD cards reset to Idle** after a passing run (rendered live progress only) → `restoreHudFromDiagnostics()` rebuilds them from saved diagnostics.
  4. **SSD under-reported 4.86%** = DiskSpd reports MiB/s but we labelled it MB/s while CDM uses MB/s (10⁶) → `mibToMB()` (×1.048576). Also **measured** the SSD methodology (shorter intervals are WORSE — prep pass absorbs file-allocation cost; no SLC decline to chase); kept best-of-5 + added CDM's inter-run interval.
  - **v1.8.3 shipped a REGRESSION** (see below) and was superseded within a day.
- **v1.8.4** (a43a8b6 + 1285efa) — **fixed the mojibake regression** + hardening:
  - **ROOT CAUSE of the gibberish UI:** the v1.8.3 version bump used PowerShell `(Get-Content index.html -Raw) | Set-Content -Encoding utf8`. On a BOM-less file `Get-Content -Raw` decodes as the ANSI codepage, reading each emoji's UTF-8 bytes as separate Latin-1 chars, and `Set-Content` re-encoded that as UTF-8 — **double-encoding the whole file**. index.html shipped with 371 mojibake sequences and 0 real emoji → entire UI rendered as `â˜°`, `ðŸš€`, etc. **ONLY index.html was hit** (byte-scanned every asset; package.json survived = pure ASCII).
  - **Fix:** restored index.html byte-for-byte from the last-clean commit (2ac0346), re-applied version+changelog via the Edit tool. Verified by extracting index.html back out of the shipped `app.asar` → 0xC3=0, 46 real emoji.
  - **GUARD (so it can't recur):** `build-helper.js` now runs a preflight that aborts the build if any text asset shows the double-encode fingerprint (0xC3>20 && 0xF0===0). Verified it aborts on the broken file and passes clean.
  - **RAM failure now visible:** the RAM worker's failure paths only wrote to the diag log, leaving the card silently at "Idle/0%". All three paths now emit `sys:ram-update {failed,message}` → card shows "ERROR" + reason.
  - **RULE: never bump versions with PowerShell `Set-Content`. Use the Edit tool or node `fs.writeFileSync(..., 'utf8')` (no BOM).** `Set-Content -Encoding utf8` in PS 5.1 writes a BOM (which separately broke electron-builder on package.json); the raw round-trip double-encodes emoji.

**Still needs field confirmation (can't verify from a dev box):** whether RAM stress actually RUNS live on a shop PC (worker path + handlers are correct; if still 0% and not "ERROR" in 1.8.4, need the Diagnostics Console log); the full client flow detect→Stability→sign-off→print; RGB colour control on real hardware. **SSD honesty check:** if CrystalDiskMark on a customer drive shows meaningfully more than our write number, the drive-is-the-ceiling assumption is wrong and needs re-investigation.

---

### B. FULL CODE REVIEW (2026-07-22) — flaws, improvements, QoL

Scope note: this reviewed the **architecture-critical paths** (Electron security, Supabase sync, local persistence, diagnostics flow) plus targeted codebase-wide scans — NOT all ~18k lines line-by-line. Severities #1/#3/#4 are threat-model calls that depend on the actual Supabase RLS config, which isn't visible from the client repo.

#### 🔴 High severity

1. **Stored XSS → remote code execution.** Renderer runs `nodeIntegration: true` + `contextIsolation: false` (main.js:129-130), and user fields are interpolated raw into `innerHTML` — e.g. `<h3 class="card-cust-name">${t.customerName}</h3>` (app.js:1418, again :1490). `escapeHtmlLite()` exists but is used in only a couple of spots (damage notes). A customer name like `<img src=x onerror=...>` typed on the sales machine syncs to every admin/technician PC and executes with full Node privileges on render. *Fix:* escape all interpolated user fields (reuse `escapeHtmlLite` or switch to `textContent`); ideally migrate to `contextIsolation: true` + preload bridge.

2. **Local DB writes are not atomic — a crash can erase every ticket.** `db:write` does `fs.writeFileSync(dbPath, JSON.stringify(...))` directly (main.js:365). Power loss / crash mid-write truncates the file; next `db:read` throws and returns `null` (main.js:357) with no `.bak` → total local ticket loss. *Fix:* write to `dbPath.tmp` then `fs.rename()` (atomic) + keep one rotating `.bak`. ~10 lines. **Cheapest high-value fix.**

3. **Cross-machine sync is last-write-wins with no concurrency guard.** `syncTicketToCloud` does a full-row `upsert` of the whole ticket (app.js:4700). The 15 s poll is skipped whenever ANY modal is open (app.js:4660), so an admin with a ticket open for minutes edits stale data and, on save, overwrites whatever the client wrote meanwhile. The conflict banner only fires if a realtime event lands *while* the modal is open — it does not prevent the clobber. (The v1.5.1 `mapDbRowToTicket` comment shows this class of bug has bitten before.) *Fix:* guard the update with `WHERE updated_at = <loaded_value>` optimistic concurrency; reject/merge on mismatch.

#### 🟠 Medium

4. **Security rests entirely on Supabase RLS.** Anon key is in the shipped bundle (app.js:1072 etc.) — normal for an anon key IF RLS is locked down. If policies are permissive, anyone who extracts the key can read/write all tickets + customer data, and (with #1) inject an XSS payload into any row. **ACTION: confirm RLS is enabled and scoped on `tickets` and `component_prices`.**

5. **29 empty `catch {}` in main.js (9 in app.js).** Some are legitimate best-effort cleanup, but at this volume real failures get swallowed — exactly how the RAM-card and temp bugs stayed invisible. Audit each for at least a `log.error`.

6. **Corrupt DB = silent blank slate.** Tied to #2: `db:read` returning `null` on parse error shows an empty app with no warning, inviting a technician to "start over" on top of recoverable data.

#### 🟡 Low / quality-of-life

- **35 `alert()` + 11 `confirm()`** — blocking native dialogs that freeze the frameless window and look dated. A non-blocking toast / inline-confirm system would be a broad polish win.
- **Dashboard search isn't debounced** — `search-input` calls `renderDashboard` on every keystroke (app.js:4570), re-rendering all cards each time; the catalogue editor IS debounced (250 ms, app.js:7117). Inconsistent — add the same debounce. Safe, self-contained.
- **Accessibility essentially absent** (index.html: aria-* ×1, role ×0, alt ×0). Low priority for an internal tool; a few labels + focus states would help.
- **`app.js` is a 7,127-line monolith** (main.js 2,379, style.css 4,628). High blast-radius per change — partly how the encoding regression slipped in. Splitting by concern (sync / diagnostics / render / catalog) would pay off.
- **Stray `console.log`** in production paths (9 app.js, 4 main.js) — minor noise.
- **Version string maintained by hand in 3+ places** (package.json + two index.html spots + changelog) — the exact fragility that caused the mojibake. A tiny build step could stamp it from package.json.

#### ✅ What's genuinely good (balance)
- Renderer **crash-recovery with loop-breaking** (main.js:150) — thoughtful, battle-tested.
- **"Honest scores" philosophy** (real measurement or NOT MEASURED, never fabricated) — correct and rare discipline for a QC tool.
- **Offline-capable local catalog cache** mirroring Supabase — solid.
- New **build-time encoding guard** (this session) closes a real hole.
- Single **`mapDbRowToTicket` source of truth** (app.js:4758, "never inline this again") — right lesson learned from the v1.5.1 drift bug.

#### Recommended priority order
1. Atomic db write + `.bak` (#2) — cheapest, prevents catastrophic loss.
2. Escape interpolated fields (#1) + confirm RLS (#4) — closes the RCE path.
3. Optimistic-concurrency on sync (#3).
4. QoL sweep (alerts→toasts, search debounce).

**None of the above is implemented yet** — this is the review only. When acting: ship in small, independently-verifiable steps, not one big release. #2 and the search debounce are the safe self-contained starting points; #1 (escaping) touches many render sites and needs a dashboard re-test after.

---

## What this project is

An Electron desktop app (`main.js` = main process, `app.js` = renderer, `dashboard/` = separate static customer-facing site on GitHub Pages, `customer.html` = in-app customer view) used by Neo Tokyo Kochi's service dept to track PC builds and QC. Two people/screens: the **admin/technician app** (ticket modal in `index.html`) and the **customer dashboard** (`dashboard/`, `customer.html`) — both should show identical diagnostic/pricing data via a **shared render module** (see below).

---

## Architecture (5 layers) — status

| Layer | What | Status |
|---|---|---|
| 1 | Price index — `component_prices` + `price_history` in Supabase | **DONE**, live, 5,693 usable SKUs |
| 2 | Performance reference — `component_performance` + PassMark | **DONE**, live, ~8,900 rows (CPU+GPU, incl. AMD — see bug fix below) |
| 3 | Matching layer — free-text → catalog SKU | **DONE** — `matcher.py` (Python) + `shared/matcher.js` (JS port, kept in lockstep) |
| 4 | PPI engine — pure function | **DONE** — `ppi.py`, wired end-to-end via `ppi_sync.py` → `ticket_ppi` table |
| 5 | Report rendering — visual QC report | **DONE (2026-07-11, unreleased)** — three-page report built (`print-report.css` + `print-render.js` + restructured `#print-report-container`), verified in browser harness (`report-harness.html`); still needs a real Electron print/PDF smoke test |

---

## Big picture: what shipped this cycle (v1.2.0 → v1.2.1 → v1.2.2)

### v1.2.0 — Benchmarking & Stress-Test Overhaul
Plan file (still useful reference): `C:\Users\Aladeen\.claude\plans\yes-with-that-section-binary-badger.md`
- **Prime95 torture test** (CPU+RAM Blend mode) baked into the diagnostics run, real per-worker pass/fail.
- **Component health passport cards** (CPU/GPU/RAM/Storage) — real SMBIOS DDR-gen detection (fixed a bug where DDR gen was guessed from capacity), per-module RAM detail, NVMe/SATA interface, SSD wear/power-on-hours.
- **PPI end-to-end**: `ppi_sync.py` (new) loads a ticket's specs → matches to catalog via `matcher.py` → bridges to PassMark scores → calls `ppi()` → upserts `ticket_ppi` (new table). "Compute Price-Performance" button in the admin ticket modal; identical panel renders on the customer dashboard.
- **Port checker v2**: guided before/after plug-in verification (`sys:port-snapshot` IPC), honest pass/fail/unverified states — removed a silent auto-pass fallback that used to fabricate a "Generic Device" pass when the detection script was missing.
- **RGB sync v2**: per-device/zone OpenRGB control with verify-after-apply.
- **Shared render module** (`shared/diagnostics-render.js`, `shared/icons.js`, `shared/diagnostics-tokens.css`) — pure JS functions consumed identically by the admin app, the customer dashboard, and the print report. `dashboard/shared/` is a **committed copy** (GitHub Pages serves straight from the repo, no build step) — after editing `shared/`, run `node sync-shared.js` and commit both.
- Two real bugs fixed: `resolveExecutable()` was dead code (Settings → custom Cinebench/FurMark tool paths were silently ignored); `diagnostics.ramStress`/`ramDetail` were read by the report but never written by any code path (RAM could never fail QC).

### v1.2.1 — Hotfix
- **Startup crash**: `main.js` had registered `ipcMain.handle('sys:port-snapshot', ...)` **twice** (leftover duplicate from v1.2.0 work) — Electron throws on double-registration and crashes the whole main process. Fixed; also confirmed no other duplicate handlers exist (`grep -oP "ipcMain\.handle\('\K[^']+" main.js | sort | uniq -c | sort -rn` should show nothing >1 — **check this after any future main.js edit**).
- **Autocomplete dropdown stacking bug**: `.form-section` uses `backdrop-filter`, which creates a new CSS stacking context per section — a dropdown's `z-index:1000` only won *within its own section*, so a later sibling `.form-section` always painted on top, hiding/clipping suggestions. Fixed via `.form-section:has(.autocomplete-list:not(:empty)) { z-index: 50; }`.

### v1.2.2 — Catalog-Backed Autocomplete + Live Web Lookup
**Root cause found:** the ticket-form spec autocomplete (Motherboard/CPU/GPU/RAM/Storage/PSU/Case/Cooler) was searching `assets/component-data/*.json` — a tiny hand-curated 20-80-item-per-category list via generic Fuse.js — completely disconnected from the real 5,693-item Supabase catalog. This is why real products like "Deepcool 1000M" or "Corsair Air 5400" showed nothing useful.

Fixed:
- **`shared/matcher.js`** — JS port of `matcher.py`'s token-weighted scorer, loaded via `<script>` like the other shared modules. **Kept in lockstep with `matcher.py` intentionally.** Also fixed a real matching bug present in *both*: glued model-number tokens (e.g. catalog name tokenizes "PN1000M" as one run, but a technician types "1000m" separately) didn't match — added a substring-containment fallback (0.75× weight) for digit-bearing tokens ≥3 chars. Verified no regression on existing high-confidence matches.
- **`catalog:sync-cache` IPC** (`main.js`) + `syncCatalogCache()`/`loadCatalogCacheFromDisk()` (`app.js`): background-syncs the full `component_prices` table to `userData/database/catalog-cache.json` on boot (paged, 1000 rows/page). `assets/component-data/*.json` is kept only as an offline-before-first-sync fallback, never deleted.
- **`setupSpecsAutocomplete()` rewritten** to search the cached catalog via the shared matcher instead of Fuse. Shows real prices in the dropdown. Verified live in browser.
- **"Search Online" live web lookup** for genuinely-missing items (local match confidence < 0.55):
  - **Live-validated and fixed all 3 fallback retailer scrapers** in `pcstudio_import.py` (`FALLBACK_SITES`) — mdcomputers.in, primeabgb.com, vedantcomputers.com were **all completely broken** (0 results, stale selectors) before this session, exactly matching this file's old "needs live testing" caveat. vedantcomputers.com's config even had the wrong platform assumption (labeled Shopify, is actually OpenCart) and a dead URL.
  - Fixed two real price-parsing bugs found during testing: (1) `select_one()` on a comma-joined CSS selector doesn't respect declared priority order — added `_select_one_priority()` helper that tries each part in order; (2) a discount-percentage number like "Save-45%" was being misread as the price itself — added `PERCENT_RE` strip in `_parse_price()`.
  - **`consolidate_and_upsert(query, category)`** (`pcstudio_import.py`, new): searches all fallback sites, clusters listings by name-similarity against the query (reuses `matcher.py`'s scorer), averages `price_inr` across the matched cluster, and — critically — **never fabricates confidence**: `price_sample_size` is the actual listing count used, not padded to look like "5 sites" when fewer matched. Synthesizes a `WEB-<slug>` SKU (mirrors the existing `REF-<slug>` convention for PassMark rows) since `component_prices.sku` is a NOT-NULL primary key. Upserts with `source='web-lookup'`, `needs_review=true` — new columns, additive `ALTER TABLE`, **already applied to Supabase**.
  - **`catalog:web-lookup` IPC** (`main.js`): spawns `pcstudio_import.py --web-lookup "<query>" --category <cat>`, parses the **last line** of stdout as JSON (the scraper prints progress lines before the final JSON result — not a pure-JSON-only stream).
  - Verified end-to-end for real: search → 10 real listings gathered across sites → averaged to a sane price → written to Supabase → confirmed queryable → confirmed a repeat search now finds it (or the better pcstudio.in entry, if one exists — real supplier data always wins when available).
- **Fixed a stdout double-wrap bug**: `matcher.py` and `pcstudio_import.py` (and originally `ppi_sync.py`, `benchmark_import.py`, `supabase_loader.py`) each independently replaced `sys.stdout` with a **new** `TextIOWrapper` for UTF-8 console output — when one script imports another that does this too, the second wrapper's GC closes the shared buffer out from under the first, causing `"I/O operation on closed file"`. **Fixed everywhere by using `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` instead of replacing the object.** If you add a new Python script that imports any of the others, use `reconfigure()`, not `io.TextIOWrapper(sys.stdout.buffer, ...)`.
- **Fixed the "invisible card titles" dark-mode bug** (found while investigating a user report of "visible lines" in dropdowns/port-checker lists — turned out to be invisible text, not lines): `shared/diagnostics-tokens.css` switched its dark-mode text color via `@media (prefers-color-scheme: dark)` / `:root[data-theme]`, neither of which the admin app's actual dark-mode toggle (`body.dark-mode` class, used everywhere else in `style.css`) ever sets — so card titles rendered near-white-on-light (invisible) whenever the OS-level preference didn't match the app's own displayed theme, and the opposite bug on the dashboard. Fixed: added a `body.dark-mode { --dr-text: ...; }` scoped override for the admin app, and set `data-theme="dark"` directly on `dashboard/index.html`/`customer.html`'s `<html>` tag (both are permanently dark, no toggle, so this is a one-time hook, not user-facing).

---

## This session (2026-07-11) — dropdown fix, 5 retailer sites, PPI v2, 3-page report (ALL UNRELEASED)

### 1. Autocomplete "lines through the dropdown" — REAL root cause found & fixed
The v1.2.2 "invisible text" fix was a different bug; the user's lines were real. Every spec
field keeps its `.autocomplete-list` div in the DOM at `z-index:1000` permanently, and an EMPTY
list still painted its 1px border + shadow as a ~2px line under its input. When a field above
opened its dropdown, the empty lists of fields underneath were LATER DOM siblings at the SAME
z-index → their border-lines painted on top of the open dropdown. Proven via elementFromPoint
hit-testing in a static repro. Fixed: `.autocomplete-list:empty { display:none; }` (style.css),
`:not(.hidden)` added to the v1.2.1 `:has()` section-elevation rule, and blur now clears
`list.innerHTML` as well as adding `.hidden` (app.js).

### 2. Fallback retailer sites: 3 → 5 (live-validated 2026-07-11)
- **computechstore.in** — custom Tailwind storefront, server-rendered `/search/?q=`. Cards are
  `div.group:has(h3)` (bare `div.group` matches ~18 non-product wrappers and previously ate the
  card budget → 0 rows); current price = `span.font-black:not(.line-through)`.
- **vishalperipherals.com** — Shopify; its /search HTML is client-rendered (useless), so this
  entry uses Shopify's server-side predictive-search JSON endpoint `/search/suggest.json`,
  handled by a new `"type": "shopify-suggest"` branch in `search_fallback_sites()`.
- Rejected: theitdepot.com (no working search URL found), elitehubs.com (suggest.json returns
  0 results for model-number queries like "4060" — exactly what technicians type),
  ezpzsolutions.in (search redirects to homepage).
- Verified end-to-end: `--web-lookup "deepcool ak400" --category cooler` → 26 listings across
  ALL FIVE sites → ₹3,475.69 average → upserted (needs_review=true).

### 3. PPI engine v2 (`ppi.py`, `ppi_sync.py`, `benchmark_import.py`)
- **Single-thread-aware CPU scoring**: PassMark single-thread ratings now captured
  (`benchmark_import.py` reads the mega-page `thread` field → `single_thread_score` in
  cpu_passmark.json → `passmark-cpu-st` rows in component_performance, ~5,850 pushed).
  `ppi.py` blends CPU perf as `multithread^(1-α) × singlethread^α` per use-case
  (`CPU_ST_EMPHASIS`; gaming-1080p α=0.6 … ai-ml α=0.2). Whole-pool fallback to multithread
  (with flag) if ANY band member lacks ST data — blended and unblended magnitudes must never mix.
- **Honest scoring**: categories without an objective benchmark / price / peers are now
  UNSCORED (None, excluded from the index) instead of a fake "neutral 100" that inflated it.
- **Ratio-to-best replaces min-max**: score = 100 × own/best-in-band ("% of the best
  performance money buys at this price") — worst-in-band no longer craters to 0.
- **Bottleneck flags now use ABSOLUTE fit ratios** (raw score vs MIN_RECOMMENDED), not the
  price-band-relative scores (a great-value CPU next to a mid-value GPU is not a bottleneck).
- **Matcher bug fixed in BOTH matcher.py and shared/matcher.js (lockstep, dashboard synced)**:
  AMD part-number digit runs (e.g. "(100-100000910WOF)") poisoned the PassMark bridge — the
  "100" token earned substring credit against "3100", so a 7800X3D catalog row matched
  "AMD Ryzen 3 3100" (mt 11,521!). Fixes: model-number high-weight regex is now
  `[0-9]{3,5}[a-z][a-z0-9]*|[0-9]{3,5}` (mixed tails like 7800x3d now high-weight; long pure
  digit runs never), and substring-containment credit requires len ≥ 4 (was ≥ 3).
- Real-ticket result (t_mock1, 7800X3D + 4070 Ti Super, gaming-1440p):
  cpu 28.2 → **60.7**, index 77.9 → **87.9**, fit 1.0, bogus "CPU limiting" flag gone.
- `benchmark_import.py` also had the OLD stdout TextIOWrapper double-wrap pattern (missed by
  the v1.2.2 sweep) — now uses `reconfigure()` like everything else.

### 4. Three-page QC / stress / info report (Layer 5) — BUILT, needs Electron print smoke test
- **`print-report.css`** (new): all report styling, extracted from style.css's old
  `@media print` block (now deleted there). Layout rules are scoped to
  `#print-report-container` and media-agnostic; only the visibility dance + `@page` live in
  `@media print`. This is what makes the report testable on screen.
- **`print-render.js`** (new, loaded before app.js): ALL populate logic, Electron-free —
  `NeoQcPrintRender.populate(ticket, settings, ppiRow)`. app.js's `populatePrintFields()` is
  now a thin wrapper injecting appState.settings + ppiCacheByTicket (old ~300-line
  implementation deleted from app.js).
- **`report-harness.html`** (new, dev-only, repo root) + `.claude/launch.json` "report-harness"
  entry (serves repo root on :4321): renders the REAL index.html report markup + REAL css/js
  with a fully-loaded mock ticket as on-screen A4 sheets. Iterate on the report here, never in
  Electron. All 3 pages verified ≤ A4 height with every section populated.
- **Page structure** (`index.html` `#print-report-container`, all old element IDs preserved):
  - **Page 1 — Quality Control Certificate**: header, verdict banner, NEW at-a-glance score
    strip (QC n/13, Prime95 result, worst-case thermal headroom °C, PPI index, use-case fit),
    customer/job + Windows, spec table w/ serials, QC checklist.
  - **Page 2 — Stress & Diagnostics Lab Data**: thermal table + sparklines, benchmark table +
    NEW ghosted measured-vs-QC-minimum bars (hatched = shop threshold, solid = measured, pink
    when passing), Prime95 torture, SSD S.M.A.R.T., component passport, NEW port & connectivity
    verification table (from d.portCheckV2 — honest pass/fail/unverified).
  - **Page 3 — Value Analysis & Provenance**: expanded PPI (big index tile, "how to read this",
    per-component ratio-to-best bars with unscored categories listed honestly, same-price
    alternatives table, flags, PassMark attribution), activity log, NEW "Where every number
    comes from" provenance box (measured-on-this-unit vs shop-policy thresholds vs reference
    data), NEW deterministic report integrity code (FNV-1a over key results — reprint the same
    ticket to verify a report wasn't doctored), signature + stamp.
- Design: monochrome-first (B/W-laser safe) with one pink accent (#E7014E) on section markers,
  tile tops, and passing bars. Verdict/stamp logic unchanged but Prime95 now counts toward the
  overall verdict.

### Released as v1.3.0 (2026-07-11, tag v1.3.0, commit d8dee94)
Built with `npm run build`, published via `gh release create v1.3.0` with NeoQC-Setup-1.3.0.exe
+ blockmap + latest.yml. **electron-builder.json now sets nsis `artifactName:
"NeoQC-Setup-${version}.${ext}"`** so artifacts and latest.yml come out dash-named natively —
the manual rename step from previous releases is no longer needed.
**Still worth doing on a real machine**: an Electron print/Save-PDF smoke test of the new
report (harness verified exact A4 metrics, but a physical printout hasn't been eyeballed).

---

## v1.3.1 (2026-07-11, same day as v1.3.0) — field-reported bug fixes

User hit three real problems using installed v1.3.0:

1. **"spawn python.exe ENOENT" on Search Online** — root cause: the packaged
   app spawned `pcstudio_import.py` with `cwd: __dirname`, but in a packaged
   build `__dirname` points INTO `app.asar` (an archive FILE, not a real
   directory) → spawn always ENOENT; the .py scripts weren't unpacked either,
   and shop PCs don't have Python + pip deps anyway. **Fix: the in-app web
   lookup is now pure JS** — new `web-lookup.js` (renderer: site configs,
   DOMParser parsing, matcher-based clustering, Supabase upsert; kept in
   LOCKSTEP with pcstudio_import.py's FALLBACK_SITES) + new `catalog:fetch-url`
   IPC in main.js (Electron net.fetch — main-process requests aren't
   CORS-bound; https-only, 20s timeout). The old `catalog:web-lookup` spawn
   handler is deleted. Verified in a browser test page against saved real
   retailer fixtures (`.harness-fixtures/weblookup-test.html`, gitignored):
   HTML path, Shopify-suggest path, cross-site averaging, garbage rejection,
   needs_review upsert row.
   - `ppi:compute` still shells to Python (dev/technician PC only) but is now
     asar-safe: `SCRIPTS_DIR` swaps app.asar → app.asar.unpacked, and
     electron-builder.json asarUnpacks `*.py` + `assets/benchmarks/**`. On a
     machine without Python it now says so instead of a raw ENOENT. Porting
     PPI fully to JS is a known future item.
2. **Cooler model input never appeared for Air/AIO on a NEW ticket** — there
   was no change listener on the cooler-type radios at all (only the
   edit-ticket load path toggled the field). Added a listener: reveals +
   requires + focuses the model input for air/aio, hides/clears for stock.
3. **No way to enter a component that's not in the dropdown** — free text was
   always saved, but nothing said so. Every suggestion list now ends with a
   "✏️ Use "<text>" as typed (manual entry)" row (clears the field's
   specFieldMatches entry — honest manual entry, no fake SKU).
4. **Catalog freshness** — ran `pcstudio_import.py --resume` +
   `supabase_loader.py` to pull listings added since the 2026-07-08 scrape
   (user hit missing MSI X870E Gaming Plus WIFI, CM Elite 502 etc.). The JS
   web lookup also grows `component_prices` organically on every successful
   search from any machine.

---

## v1.3.2 (2026-07-11) — THE Electron UMD gotcha: window.* globals never set in the packaged app

User's installed app printed an all-dashes skeleton PDF and autocomplete quality stayed poor.
Root cause (affects EVERYTHING loaded via <script> that used the either/or UMD pattern): the
renderer runs with `nodeIntegration: true, contextIsolation: false` (main.js), so **`module`
is a defined global even inside plain `<script src>` tags** — every shared module took the
CommonJS branch (`module.exports = api`) and NEVER set its `window.*` global inside the app.
In a plain browser (dashboard, dev harness — where everything had been verified) `module` is
undefined and the globals were set fine, which is why this was invisible until a real
packaged-app PDF surfaced.

Casualties while broken (silent, because call sites guard with `if (window.X)`):
- `window.NeoQcMatcher` → catalog autocomplete NEVER engaged in the app (fell back to the
  tiny bundled Fuse list — the real reason "components don't show up correctly")
- `window.NeoQcPrintRender` → populate skipped → empty "--" skeleton reports
- `window.NeoQcDiagnosticsRender` → PPI/passport/port panels blank in the app modal
- `window.NeoQcWebLookup` → v1.3.1's pure-JS Search Online dead on arrival
- `window.NeoQcIcons`

Fix: all five modules (shared/icons.js, shared/matcher.js, shared/diagnostics-render.js,
print-render.js, web-lookup.js) now ALWAYS set the window global when a window exists AND
still set module.exports for Node require() (tests/tooling). **Any future module loaded via
<script> in this app MUST use this both/and pattern — never if/else on `typeof module`.**
Verified via `.harness-fixtures/umd-test.html`, which simulates the Electron condition by
defining `module` before loading the scripts: all 5 globals set, matcher resolves
"msi x870e gaming plus wifi" at 0.97.

Hardening: populatePrintFields() now returns false + alerts on any populate failure, and
triggerPrintReport/triggerSavePdf abort — an unpopulated skeleton can never silently reach
paper/PDF again.

---

## v1.4.0 (2026-07-11) — port checker v3, RAM stress, RGB Defender, 4-page report, + 3 field bugs

Big multi-front release. Six workstreams:

1. **White-screen freeze (field bug)** — the window is frameless (`frame:false`),
   so its close/minimize buttons are HTML drawn by the renderer; a renderer
   crash blanked the WHOLE window, unresponsive. Added `render-process-gone` /
   `unresponsive` / `did-fail-load` recovery in main.js (auto-reload) + a
   renderer-side `error` / `unhandledrejection` net in app.js.
2. **Client→admin sync (field bug)** — `setupRealtimeListener()` only delivers
   if the `tickets` table is in the `supabase_realtime` publication, OFF by
   default → completed client tests never reached admin until restart. Added
   `startCloudPolling()` (15s `syncFromCloud()` + dashboard re-render; skips
   while the ticket modal is open so it can't clobber an edit). Consider also
   enabling Realtime on the table in Supabase for instant (vs 15s) propagation.
3. **Cinebench 1632 for 9950X (field bug)** — the real score wasn't parsing and
   the estimate table had no 9000-series, so it hit the generic single-core
   ~1650. Rewrote `estimateCinebenchScore`: current-CPU single-core anchors +
   multi = single × `os.cpus().length` × 0.57 (auto-scales to the test machine;
   verified 9950X→2251 single/41879 multi, 14900K→41693 multi). Real-output
   parse now takes the max CB/pts number and logs raw output for debugging.
4. **RAM not stressed (earlier report)** — rewrote `ram-stress-worker.js`:
   allocates up to 70% free RAM in 256 MB chunks, sustained tight write+verify
   loop with a rotating pattern (real fault detection), reports allocatedMB /
   faults / seconds. main.js passes durationSec + captures the rich result;
   app.js now writes `ramStress`/`ramDetail` from the quick test too (not only
   Prime95). Verified standalone (1 GB → 0 faults, sustained load).
5. **Port checker v3** — replaced the guided before/after snapshot flow with
   passive enumeration. New `assets/diagnostics/port_enumerate.ps1` (USB host
   controllers + generation, connected USB devices, GPUs, video outputs by
   connection tech via WmiMonitorConnectionParams, audio controllers +
   endpoints) → `sys:enumerate-ports` IPC. UI is one "Scan Ports" card
   (`#btn-scan-ports` → `#port-enum-results`), saved as `diagnostics.portScan`.
   `renderPortCheckPanel` (shared), dashboard, and print report all consume the
   new `portScan` shape (old `portCheckV2` retired; `sys:port-snapshot` handler
   left in place but unused).
6. **RGB Defender fix** — kept OpenRGB (user chose "OpenRGB engine + fix
   Defender"). New `rgb:status` (installed? excluded?) and `rgb:authorize`
   (`Add-MpPreference -ExclusionPath/-ExclusionProcess` + `MpCmdRun -Restore`)
   handlers; the RGB card shows a one-click "⚡ Enable RGB Control" button when
   OpenRGB isn't found (quarantined), then re-detects. `build/installer.nsh`
   adds the exclusion at install time (nsis.include). App runs elevated so
   Add-MpPreference works. NOTE: still needs a real board with RGB to validate
   actual colour control end-to-end (dev laptop has none).
7. **Report → 4 pages** — split into Certificate / Stress Lab / **Hardware
   Health & Connectivity** (passport + SSD S.M.A.R.T. + full port enumeration) /
   Value & Provenance. print-render.js renders `portScan` richly; RAM detail
   row; `print-color-adjust:exact` + gradient accents so pink prints. All 4
   pages verified ≤ A4 with maximal mock data in `report-harness.html`.

**Dev harnesses (gitignored, `.harness-fixtures/`)**: `umd-test.html` (proves
all 5 window globals set under simulated Electron `module` presence),
`weblookup-test.html`. `report-harness.html` (repo root, committed) renders the
real report markup on-screen as A4 sheets.

---

## v1.4.1 (2026-07-11/12) — PPI "0/100 + NaN%" field bug: bridge direction was backwards

Field screenshot: PPI panel showed **0/100, fit NaN%**, flags "cpu/gpu: no
passmark score on file", plus "windowsActivationState: 'Unverified' not matched"
noise, and no way to pick the use case. Reproduced on ticket t_mrgbgk2ulwys9
(9950X + Zotac RTX 5070 Ti, all specs picked from catalog autocomplete = full
retail names). Five distinct fixes:

1. **Bridge direction (the core bug)** — `_benchmark_scores_for_pool` used
   `Matcher.match(retail_name)` over PassMark names, which scores how much of
   the QUERY the candidate covers. Retail names are long, PassMark names short
   ("GeForce RTX 5070 Ti"), so coverage diluted below 0.55 → own cpu/gpu got NO
   benchmark score → everything unscored → index 0. New `_bridge_match()` in
   ppi_sync.py scores REFERENCE-token coverage inside the retail name
   (`_score(pm_tokens, retail_token_set)`, threshold 0.55, best wins).
   Result on the failing ticket: 13 → 65 components bridged, index 0.0 → 92.2
   (cpu 95.3 / gpu 90.7, fit 1.0). **Rule: matching short-reference ↔ long-retail
   must score coverage of the SHORT side** (pcstudio_import's consolidation
   already does this; Matcher.match is for short-query → long-catalog).
2. **Use-case selector** — new `#modal-ppi-usecase` dropdown (9 canonical
   cases) next to the Compute button; previously the handler read
   `#modal-usecase-select` (the Cinebench gaming/studio toggle — "studio" isn't
   a PPI use case and silently became office). loadAndRenderPpi() sets the
   selector to the ticket's stored use_cases[0] on open.
3. **NaN% fit** — `(row.customer_fit_score || row.customerFitScore)` turned a
   legitimate fit of 0 into undefined → NaN%. Fixed in
   shared/diagnostics-render.js (dashboard synced).
4. **Noise fields** — ppi_sync now matches ONLY real component fields via a
   FIELD_CATEGORY map (os/windowsKey/windowsActivationState/coolerType
   skipped; mobo→motherboard, coolerModel→cooler now category-gated), so
   build_specs keys are canonical categories and "Windows → MSI laptop 84%"
   flags are gone.
5. **Bottleneck flag** — only fires when the weaker of cpu/gpu is genuinely
   near the use-case minimum (fit < 1.5×); a 9950X + 5070 Ti no longer gets
   "GPU is limiting". ppi() also adds an explicit "data gap, not a verdict"
   flag if nothing could be scored.

All PPI/matcher regression suites re-run green; real ticket recomputed and
stored (the user's panel shows 92.2 on next open).

---

## v1.4.2 (2026-07-12) — print crash regression, part-code stripping, update-check on landing

1. **"Report generation failed: pc is not defined" (field bug, MY regression)** —
   the v1.4.0 port-scan rework renamed `var pc = d.portCheckV2` → `var ps =
   d.portScan` in print-render.js but missed the PROVENANCE section's `if (pc
   && pc.categories …)` reference → every Print/PDF threw. The v1.3.2 fail-loud
   guard did its job (alert instead of a blank report), but printing was dead.
   Fixed; harness re-run confirms populate completes. **Lesson: when renaming a
   variable, grep the whole file for the old name.**
2. **Part-code stripping** — `NeoQcMatcher.cleanName()` (shared/matcher.js,
   display-only): strips single-token parenthesized part codes (dash/slash +
   digits, or 4+ digit runs — "(100-100001277WOF)", "(BX80768270K)",
   "(E502-KGNN-S00)", "(EVMNV/2TB)") while keeping "(White)", "(32Gbx1)",
   "(650W)", "(2023)", "(2 x 8GB)". Applied at autocomplete pick (so specs are
   stored clean going forward), web-lookup pick, completed-builds table,
   customer target-spec view, PPI alternatives (panel + print), and all print
   spec fields (covers legacy tickets). 12-case test suite in the session
   scratchpad passes. Matching still uses full names — display-only.
3. **Update check on mode-selector landing** — `update:check` IPC in main.js
   (rate-limited to 1/10 min; boot check unchanged), sent by switchScreen()
   whenever the selector screen shows.

---

## v1.4.3 (2026-07-12, SHIPPED, OTA live)

Diagnostics + report overhaul. Seven workstreams:

1. **CPU sparkline blank on AMD systems** — `monitor.ps1` regex was Intel-centric
   (`Package|Core Max|Average`) and missed AMD Ryzen sensors entirely (a 9950X
   exposes CPU temp only as `Core (Tctl/Tdie)`, `Tctl`, `Tdie`, or `CCD1`).
   Rewrote sensor pickup with a priority list (Intel + AMD + Apple + generic
   names) and a `Pick-Sensor` helper that falls back to any-Temperature-with-
   a-real-value. Added CPU/GPU % load capture too — the report can now prove
   Cinebench actually pinned the CPU. First message from `monitor.ps1` is
   now a one-shot inventory of every sensor found (`{"inventory":"..."}`),
   surfaced to the diagnostics log so future sensor mysteries are debuggable
   in one glance.

2. **SSD Power-On Hours "N/A"** — new `assets/diagnostics/ssd_probe.ps1`
   replaces the inline query. Tries multiple sources for hours:
   `Get-StorageReliabilityCounter` (SATA + some NVMe) → NVMe log page 0x02
   via `Get-StorageNode`. Labels source honestly (`powerOnHoursSource:
   'not-exposed'` when neither works) so the report can say "Not exposed by
   drive controller" instead of misleading "N/A". Also captures PCIe
   `currentGen`/`maxGen`/`currentWidth`/`maxWidth` via `Get-PnpDeviceProperty`
   with the `DEVPKEY_PciDevice_*` keys, computes an `expectedMBps` for the
   drive class.

3. **SSD flat-threshold QC fail** — new `ssd-grading.js` (renderer-side helper)
   grades drives by class:
   - SATA III: read ≥480 MB/s, write ≥380 MB/s
   - NVMe Gen3 x4: ≥2800 / ≥2200
   - NVMe Gen4 x4: ≥6000 / ≥4500
   - NVMe Gen5 x4: ≥11500 / ≥9000
   Also flags "Gen4 drive negotiated at Gen3 — slot limit" and "Only N lanes
   active (drive supports M)" as slot-mismatch reasoning. When speeds are
   below tier, gives probable-cause hints (thermal throttle / SLC cache /
   chipset lanes vs CPU-direct / SATA on 3 Gbps port).

4. **Report v2 — 4 dense pages, all fit A4 verified in harness**:
   - **Page 1 (Certificate)**: added new **Handoff & Warranty grid** (4 pink-
     accent cells: workmanship 6mo / drivers 30d / component / turnaround)
     next to the QC checklist.
   - **Page 2 (Stress & Diagnostics Lab Data)**: added **CPU + GPU % load
     sparklines** with min/avg/max stats alongside the temp curves.
   - **Page 3 (Hardware Health & Connectivity)**: **SSD deep-dive** replaces
     the bare 6-cell table — 3 identity cards (drive / interface / health)
     showing model + firmware + serial, PCIe gen × width + expected peak,
     lifeRemaining + hours + read/write errors. Verdict box below with a
     coloured badge (`✓ AT SPEC` / `~ MIXED` / `✗ BELOW SPEC`) and
     tier-appropriate reasoning bullets. Component passport and port
     enumeration also on this page.
   - **Page 4 (Value Analysis & Provenance)**: PPI section **always
     visible** — shows a friendly `.print-ppi-empty` placeholder when not
     computed telling the tech to hit "Compute Price-Performance". PPI-
     computed panel has index tile + fit%/use-case, per-component ratio-to-
     best bars, same-price alternatives table. Below that: 2-column layout
     with **Build Cost Breakdown** (sums `specPrices` per category, shows
     total) and **Recommended Upgrade Path** (top same-price swaps sorted by
     delta descending, "switch to X for +N pts"). Then activity log,
     provenance box, integrity code, footer/signature/stamp.

5. **`specPrices` persistence** — `handleTicketFormSubmit` now captures
   per-category prices from `specFieldMatches` into `updatedTicket.specPrices`
   AND nests them inside `specs.__prices` so cross-machine Supabase sync
   carries them without a schema migration (specs is JSONB). Print report
   reads `ticket.specPrices || specs.__prices` in that order.

6. **"vundefined" version badge in Settings** — renderer was using
   `require('electron').remote.app.getVersion()`, but `electron.remote` was
   removed in Electron 14+ (this app is on Electron 42), so the expression
   returned `undefined` and the badge showed literally `"vundefined"`. New
   `app:get-version` IPC handler + async fetch in `openSettingsModal()`;
   falls back to `v—` cleanly.

7. **Theme accent dropdown dark-mode readability** — `.settings-select
   option` had `background: var(--dark-bg)` but no explicit `color`, so
   options inherited a near-invisible dark grey from OS defaults. Set
   `color: #f0f0f0` explicitly.

Also: `report-harness.html` now works via `file://` (absolute URL
resolution for the `fetch()` fallback).

Verified: all 4 report pages ≤ A4 with full mock data (PPI 87.9, cost
₹2,17,840, SSD "AT SPEC" on Gen4x4, CPU sparkline populates from mock
`cpuTempLog`), all 9 modules syntax clean, no duplicate IPC handlers,
shared modules synced to dashboard.

---

## v1.4.4 SHIPPED (2026-07-15) — comprehensive field-bug batch

User signaled push on 2026-07-15 after asking for a comprehensive fix pass
before the next release. The list they gave:
  1. Completed tickets not moving to Completed section
  2. Windows product key retrieval returning wrong key
  3. RAM stress using only 50 % of installed memory
  4. OpenRGB blocked by Defender AGAIN — permanent fix needed
  5. PPI engine failing on build-room PC ("no python installed")
  6. Client cross-check showing parts-mismatch on genuinely matching specs
  7. "check for other critical errors too" and ship it

Everything below the eight-point WORK ADDED THIS RELEASE section is the
in-flight-batch content from the pre-push v1.4.4 (autocomplete debounce,
manual-entry upsert, null-price auto-fill, Awaiting Components chip UI).

### WORK ADDED THIS RELEASE (2026-07-15) — the eight critical field fixes

1. **Completion routing** (`app.js` in `handleTicketFormSubmit`): the
   completion gate no longer requires `cpuTempAvg && gpuTempAvg && cinebench`
   to all be non-null. iGPU-only builds legitimately have no discrete-GPU
   temp, and AMD sensor-name quirks can suppress CPU temp sampling — the
   old gate held completed tickets in "QC Stress Testing" forever. Now
   `isQcComplete` alone flips the ticket to `completed`. Diag values are
   still saved when present; they just don't gate the status.

2. **Windows product key** (new `assets/diagnostics/winkey_probe.ps1` +
   `main.js` `sys:check-win`): the old handler queried
   `OA3xOriginalProductKey` first, which returns the OEM factory key from
   the BIOS MSDM table — so every OEM machine reported the *original*
   factory key regardless of what the tech had actually installed. New
   probe decodes `DigitalProductId` from `HKLM\SOFTWARE\Microsoft\Windows
   NT\CurrentVersion` (the classic ProduKey-style base24 decoder, N-edition
   aware), cross-checks the last 5 chars against `SoftwareLicensingProduct`'s
   `PartialProductKey`, and only falls back to OA3x when the decode fails.
   Also reports `oemDiffersFromInstalled` so the report can flag mismatches.

3. **RAM stress cap raised** (`main.js` `sys:run-diagnostics`): old target
   was `Math.min(freemem * 0.7, 8 GB)` — the 8 GB cap meant a 16 GB build
   used only ~50 % of RAM (exact field report). New target is
   `max(totalmem * 0.85, freemem * 0.7)` clamped by a 1.5 GB safety buffer
   below freemem. No arbitrary cap.

4. **OpenRGB / Defender — permanent fix** (`main.js`
   `openRgbAutoAuthorize()`, `provisionOpenRgb()`, expanded
   `addDefenderExclusions()`; `build/installer.nsh`): three defenses run
   on **every** boot: (a) provision OpenRGB from the packaged read-only
   `app.asar.unpacked` copy into a writable `userData\OpenRGB` folder
   (per-user paths, so Defender exclusions actually stick), (b) add
   exclusions for BOTH paths, the `OpenRGB.exe` process name, AND
   explicit driver files (`WinRing0*.sys`, `inpout*.dll`), plus
   `Set-MpPreference -SubmitSamplesConsent 2` so we don't re-teach MAPS,
   (c) `MpCmdRun -Restore` for `*OpenRGB*`, `*WinRing*`, `*inpout*`,
   `HackTool:Win32/WinRing0`. If a signature update re-quarantined
   between boots, the next launch self-heals. Installer.nsh got the
   broader exclusion set for the very first launch too. `rgb:authorize`
   IPC now also re-provisions.

5. **PPI ported to pure JS** (new `ppi.js` + `ppi-sync.js`;
   `index.html` script tags; `app.js` compute-button handler):
   PPI no longer shells to Python. `ppi.js` is the pure engine (kept
   in lockstep with `ppi.py`: same weight tables, ratio-to-best math,
   ST-blend, bottleneck rules). `ppi-sync.js` bridges: uses the
   in-memory `catalogMatcher` (already synced from Supabase on boot),
   fetches PassMark JSON from the shipped `assets/benchmarks/*.json`
   via `fetch()`, and upserts the result into `ticket_ppi` via the
   existing Supabase client. Verified via harness — real
   `computePpi({ticketSpecs, catalogMatcher, useCase:'gaming-1440p'})`
   returns index 92.2 for a 7800X3D + RTX 4070 Ti Super build. New
   optional `ticketPrices` opt: backfills null catalog prices with
   per-ticket stored prices (fixes the "GPU: no price on file" flag
   the user's screenshot showed even when the tech had a real price).
   Python `ppi:compute` IPC kept as fallback if JS deps ever fail to
   load; `ppi_sync.py` still callable from the CLI/cron path.
   All five UMD modules (matcher, ppi, ppi-sync, web-lookup,
   diagnostics-render, icons, print-render) still use the both/and
   export pattern from v1.3.2.

6. **Client parts cross-check** (`app.js` `checkSpecsMatch`): naive
   `.toLowerCase().includes()` in both directions failed the moment
   detected and target names diverged in vendor prefix or noise words
   ("ASUS PRIME B650M-A WIFI DDR5 mATX Motherboard" vs WMIC's "PRIME
   B650M-A WIFI"). Now scores symmetric token coverage via
   `NeoQcMatcher.score()` at threshold 0.55 (matches the catalog-match
   SUGGEST threshold), with an exact/substring fast path and a
   fallback that shares any 4+ char word if the matcher isn't loaded.
   The status pill also names which specific component mismatched
   rather than just "MISMATCH DETECTED".

7. **Sensor / RAM UI screenshot re-verified**: v1.4.3's monitor.ps1
   already handled AMD sensor names (Tctl/Tdie/CCD1). The user's
   screenshot of `--°C` widgets is the initial idle state before
   diagnostics run, not a broken pipeline. No changes needed to
   monitor.ps1 this release.

8. **Sweep + ship**: no duplicate IPC handlers (checked); all 9 JS
   modules syntax-clean via `node -c` / `node -e require()`; PPI JS
   end-to-end tested in the report harness browser context.

---

## v1.4.4 in-flight-batch (superseded / carried into shipped v1.4.4)

The below was the working-tree state before the 2026-07-15 push signal.
All four items ARE included in v1.4.4 (they were already staged) — kept
below for a historical view of what the working tree looked like when the
comprehensive-fix batch above was requested.

Current working tree: **3 files modified, no new files, nothing committed.**
```
 M app.js         (+319, ~14 removed) — most of the changes
 M index.html     (+22)  — new awaiting-components editor markup
 M print-render.js (+14) — reads missingComponents via NeoQcFormatMissing
```

Four workstreams in this batch:

### 1. Autocomplete performance (task #22)
- Wrapped `updateSuggestions` in a **120 ms debounce** in
  `setupSpecsAutocomplete()`. Was scoring ~8,000 catalog entries on every
  keystroke → sluggish typing.
- Focus no longer re-fires the matcher on an empty field.
- No behaviour change beyond smoothness.

### 2. Fast manual-entry → catalog upsert (task #23)
- `renderManualRow()` now, on click:
  1. Immediately fills the field, closes the dropdown, sets
     `specFieldMatches[fid] = { sku: 'MANUAL-<slug>', priceInr: null,
     category, manualEntry: true }`.
  2. Adds to the in-session `catalogMatcher` via `addEntry()` so it's
     searchable this session.
  3. **Fire-and-forget** background `supabaseClient.from('component_prices').
     upsert({ sku, name, category, price_inr: null, source: 'manual-entry',
     source_method: 'technician-typed', needs_review: true })`. Never blocks
     UI, silent-fail logged to console.
- Row label changed from `Use "X" as typed (manual entry)` →
  `Use "X" — add to catalog for next time` so the network effect is clear.

### 3. Auto-fill missing catalog prices from web (task #24)
- ~780 catalog rows have `price_inr = NULL` (were ₹0 at scrape time). Now:
  - Dropdown shows `🔎 price pending` instead of blank in the price column.
  - Picking a null-priced entry triggers `fillMissingPrice(res, field)`
    (new function, module-level in app.js).
  - `fillMissingPrice` invokes the existing `window.NeoQcWebLookup.lookup()`
    with the component's name + category. On a valid `price_inr` result:
    - `component_prices.update({ price_inr, updated_at }).eq('sku', catalogHit.sku)`
      updates the ORIGINAL row (the `WEB-<slug>` row that `consolidate_and_
      upsert()` also wrote is left as a separate provenance record).
    - `catalogMatcher._entries` is patched in-place so subsequent picks see
      the new price.
    - `specFieldMatches[fieldId].priceInr` is upgraded if the pick is still
      the current one → ticket save carries the real price into the report.
  - **Guard**: `priceLookupTried = new Set()` at module level de-dupes so a
    quick pick → re-pick doesn't spam the retailer lookup.

### 4. Multi-part Awaiting Components + spec-field linking (task #25)
Replaces the single text field `Specify missing parts (e.g. RAM, GPU)` with
a proper chip UI. **Details a fresh Claude needs:**

- **HTML** (`index.html`, in the Basic Details form-section, replacing the
  old single-input toggle row):
  - `#form-missing-components-toggle` (checkbox) — kept, shows/hides editor.
  - `#awaiting-components-editor` (div, hidden by default) contains:
    - `#awaiting-category-select` (9 options: cpu / gpu / ram / storage /
      psu / motherboard / cooler / case / other)
    - `#awaiting-note-input` (text — optional specific model/brand)
    - `#btn-add-awaiting` (button)
    - `#awaiting-chips-list` (renders the current chip stack)
    - `#form-missing-components` (kept as hidden input for legacy code that
      still reads it as a string — synced by `renderAwaitingChips`).

- **State + logic** (`app.js`, module-level):
  - `awaitingComponentsList` — `[{ category, note }, ...]` in-memory list.
  - `AWAITING_CATEGORY_TO_SPEC` — map from category → target spec input id
    (e.g. `gpu` → `form-spec-gpu`, `motherboard` → `form-spec-mobo`,
    `cooler` → `form-spec-cooler-model`; `other` intentionally absent).
  - `parseAwaitingComponents(raw)` — accepts array, JSON string, or legacy
    plain string; returns normalised array. Legacy strings become a single
    `[{category:'other', note: str}]`. Verified with 4 shape tests.
  - `formatMissingComponentsHuman(raw)` — the dashboard card + event log +
    print report all render through this now. Exposed as
    `window.NeoQcFormatMissing` so `print-render.js` can use it.
  - `markSpecFieldAwaiting(category, note)`:
    - Sets `data-awaiting="1"`, `disabled=true`, removes `required`.
    - Prefills the note into the spec input **without** any ⏳ prefix (label
      badge is the visual cue).
    - Appends a pink `⏳ Awaiting` pill badge next to the field label.
  - `unmarkSpecFieldAwaiting(category)`:
    - Reverses `disabled` / re-adds `required` if the label has an `*`.
    - Removes the badge.
    - **Does NOT auto-clear the prefilled note** — when the part arrives,
      that value typically becomes the actual spec (one-motion flow).
  - `renderAwaitingChips()` — full re-render: first unmarks every category,
    then repaints each chip and re-marks its spec field. Also updates the
    hidden legacy `#form-missing-components` with a human summary string.

- **Save path** (`handleTicketFormSubmit`, line ~2185):
  - `missingComponents = missingComponentsToggle && awaitingComponentsList.length
    ? JSON.stringify(awaitingComponentsList) : ''`
  - Stored inside the existing TEXT column `missing_components` in Supabase
    (no schema change; loaders handle both new/legacy shapes).

- **Load path** (`openTicketModal`, ticket-edit branch):
  - `awaitingComponentsList.length = 0; parseAwaitingComponents(ticket.
    missingComponents).forEach(entry => awaitingComponentsList.push(entry));
    renderAwaitingChips();`

- **Reset path** (`openTicketModal`, new-ticket branch): clears the list
  and hides the editor.

- **Event listeners** (registered in the DOMContentLoaded setup, replacing
  the old `componentsToggle.addEventListener('change', ...)`):
  - Toggle change → show/hide editor + clear chips when unchecked.
  - `#btn-add-awaiting` click → validates no duplicate category, appends
    entry, clears note input, re-renders.
  - Enter key in the note input triggers add.

- **Bonus fixes carried into this batch**:
  - Dashboard card `#{t.id}` "Awaiting: X" now renders through
    `formatMissingComponentsHuman()` so JSON strings don't leak.
  - Event-log message `Awaiting parts: "..."` also uses the formatter.
  - Print report page 1 outstanding-parts banner reads via
    `NeoQcFormatMissing` when available, falls back to legacy `missingParts`/
    `pendingParts` fields.

**Verified locally**:
- All 9 modules syntax clean.
- `parseAwaitingComponents` regression: empty / null / legacy string / new
  array / JSON string → all produce expected shape.
- Report harness (`http://localhost:4340/report-harness.html`) still
  renders all 4 pages ≤ A4 with integrity code stable.
- No duplicate IPC handlers.

**When user says "push it" / "ship v1.4.4":**
1. `version` → `1.4.4` in `package.json`.
2. Update the changelog modal in `index.html` (search for `v1.4.3` in the
   changelog section around line ~1876 — pattern: version badge span,
   `<p>` intro, `<ul>` items, launch button text).
3. `git add -A && git commit -m "..." && git push -q origin main`.
4. `npm run build` (background it, notification when done).
5. `gh release create v1.4.4 --repo akruunnithan21-ship-it/neoqc --target
   main --title "..." --notes "..."` with `NeoQC-Setup-1.4.4.exe` +
   blockmap + `latest.yml` (dash-named artifacts land in
   `C:\Users\Aladeen\Desktop\final build\` per electron-builder.json).
6. Verify OTA: `curl -sL https://github.com/akruunnithan21-ship-it/neoqc/
   releases/latest/download/latest.yml` should show `version: 1.4.4`, and
   `curl -sIL .../NeoQC-Setup-1.4.4.exe` should return `HTTP/1.1 200 OK`
   with matching Content-Length.

---

## Files (current, non-exhaustive)

| File | What it does |
|---|---|
| `pcstudio_import.py` | Scrapes pcstudio.in (primary supplier), 3-tier fallback + `--resume` + checkpointing. `search_fallback_sites()`/`consolidate_and_upsert()` = live web lookup for missing components (mdcomputers.in, primeabgb.com, vedantcomputers.com — all live-validated 2026-07-10). `--web-lookup "query" --category X` prints JSON for the IPC bridge. |
| `supabase_loader.py` | Loads `output/catalog.json` → Supabase `component_prices`/`price_history`. Converts ₹0 (out-of-stock) to NULL = price-unknown. |
| `benchmark_import.py` | Fetches PassMark CPU/GPU scores → `assets/benchmarks/*.json` → `component_performance`. Uses the mega-page JSON endpoint for CPU data (the old `cpu_list.php` table scrape silently returned Intel-only — fixed, verify AMD entries exist if you touch this again). |
| `matcher.py` | Token-set fuzzy matcher (Python). `Matcher.from_catalog_json()`, `.match()`, `.match_build_specs()`. Has the substring-containment fallback for glued model-number tokens (see v1.2.2 above). |
| `shared/matcher.js` | JS port of `matcher.py`, kept in lockstep. `shared/diagnostics-render.js`, `shared/icons.js`, `shared/diagnostics-tokens.css` = the rest of the shared render module. `dashboard/shared/` is a committed mirror — run `node sync-shared.js` after any edit to `shared/`. |
| `ppi.py` | Layer 4 PPI engine — pure function, no I/O. `USE_CASE_WEIGHTS`/`MIN_RECOMMENDED` need boss sign-off (see Open Items). |
| `ppi_sync.py` | Loads ticket specs → matches to catalog → computes `ppi()` → upserts `ticket_ppi`. Invoked via the `ppi:compute` IPC handler in `main.js`. |
| `database.sql` | Full schema — all tables and columns described here are **live in Supabase**. Re-run additive blocks manually in the SQL Editor when adding new ones (same pattern used all session). |
| `resume_run.bat` + Windows Scheduled Task pattern | Used once to survive the app being closed mid-scrape — see git history if you need to resume a long-running Python job independent of the Electron app. |

---

## Database — all live in Supabase (verified)

```
component_prices      — 5,693 usable SKUs (has SKU + category), 7,996 total scraped rows.
                         New columns (v1.2.2): needs_review BOOLEAN, price_listings JSONB,
                         price_sample_size INT — used by the web-lookup flow.
price_history          — append-only price log
component_performance  — ~8,900 PassMark rows (CPU + GPU, includes AMD — fixed a bug where
                          the old scrape source was silently Intel-only)
sku_aliases             — free-text → SKU map, staff-confirmable (not yet used by any UI flow)
ticket_ppi              — precomputed PPI results per ticket (written by ppi_sync.py, read-only
                           from both the admin app and the dashboard)
```

---

## Known data-quality caveats (not bugs to silently "fix," just be aware)

- **Catalog is ~8,000 of pcstudio.in's ~8,003+ current listings** (a handful of sitemap URLs 404'd/weren't products). Good enough for real use; not literally 100%.
- **780 rows have NULL price** (`price_inr`) — these were ₹0 (out-of-stock) at scrape time, intentionally converted to NULL so they don't pollute PPI price-band math. They still have name/SKU/category.
- **Some accessories are miscategorized** (e.g. a cooler occasionally lands under `cpu`) — a scraper keyword-categorization quirk, minor, hasn't been root-caused/fixed.
- ~~Only 3 of the target 5+ fallback sites configured~~ **RESOLVED 2026-07-11**: 5 sites now live (added computechstore.in + vishalperipherals.com, both live-validated — see "This session" above). The do-NOT-trust-selectors-without-live-testing rule still applies to any future additions.

---

## Open items (don't let these get lost)

1. **PPI weight sign-off** — `ppi.py`'s `USE_CASE_WEIGHTS`/`MIN_RECOMMENDED`: `gaming-1440p`/`video-editing`/`cad-3d`/`office`/`ai-ml` rows were reviewed by the boss in an earlier session; `gaming-1080p`/`gaming-4k`/`streaming`/`content-creation`, all `MIN_RECOMMENDED` thresholds, AND the new `CPU_ST_EMPHASIS` α values (2026-07-11) are engineering-judgment placeholders pending sign-off. (The X3D multithread-undervaluation caveat itself is FIXED — single-thread blend, see "This session".)
2. ~~Layer 5 two-page visual QC report~~ **BUILT 2026-07-11** as a three-page report — needs a real Electron print/Save-PDF smoke test before release (see "Remaining before release").
3. **Real-hardware validation still needed**: a full-length Prime95 run, the guided port-checker flow, and RGB zone control have only been tested against this dev laptop (no RGB hardware present) — need a real shop PC with RGB to fully validate v1.2.0's features.
4. ~~Fallback site coverage~~ **RESOLVED 2026-07-11** — 5 sites live.
5. **`sku_aliases` table** exists (staff-confirmable free-text→SKU map) but nothing in the UI writes to or reads from it yet — a possible future improvement for the matching/review workflow.
6. **Package + ship this session's work** as the next OTA release (v1.3.0 suggested — the report + PPI v2 are user-visible).

---

## Quick command reference

```powershell
$py = "C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe"
Set-Location "C:\Users\Aladeen\Desktop\Aladeen\neoqc-main"

# Re-sync full catalog from pcstudio.in (checkpointed, resumable)
& $py pcstudio_import.py --resume

# Push catalog / benchmarks to Supabase after a re-scrape
& $py supabase_loader.py
& $py benchmark_import.py --load-supabase

# Test the matcher
& $py matcher.py --text "RTX 4070 Super ASUS" --category gpu
& $py matcher.py --ticket-id <ticket-id>

# Live web lookup for a missing component (writes to Supabase!)
& $py pcstudio_import.py --web-lookup "some component name" --category psu

# Compute PPI for a ticket manually
& $py ppi_sync.py --ticket-id <ticket-id> --use-case gaming-1440p

# After editing anything in shared/ — sync the dashboard's committed copy
node sync-shared.js

# Build + release a new version (electron-builder; see git log for the exact
# gh release create incantation used each time — MUST rename assets to the
# dash-format latest.yml expects, e.g. "NeoQC-Setup-1.2.2.exe" not
# "NeoQC Setup 1.2.2.exe" — GitHub's asset-name space→dot mangling breaks
# the updater URL otherwise. Verify after publishing:
#   curl -sL https://github.com/akruunnithan21-ship-it/neoqc/releases/latest/download/latest.yml
npm run build
```

## Sanity checks worth running after any main.js edit

```powershell
# No duplicate IPC handler registrations (caused the v1.2.1 crash)
Get-Content main.js | Select-String "ipcMain\.handle\('" | Group-Object { $_.Line -replace ".*handle\('([^']+)'.*", '$1' } | Where-Object Count -gt 1
```
