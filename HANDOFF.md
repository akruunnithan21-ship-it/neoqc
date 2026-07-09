# Neo QC — Session Handoff
**Project:** Neo QC v1.1.2 — Price-to-Performance & QC Report Overhaul  
**Shop:** Neo Tokyo Kochi service dept  
**Repo:** `C:\Users\Aladeen\Desktop\Aladeen\neoqc-main`  
**Python:** `C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe`  
**Supabase:** `https://ggsxkhenzdhaachubrsc.supabase.co` (anon key in main.js:111)  
**Last session date:** 2026-07-08

---

## What this project is

An Electron desktop app (main.js / app.js, Supabase backend, dashboard/) used by Neo Tokyo Kochi's service dept to track PC builds and QC. Currently v1.1.2. Building a **Price-to-Performance Index (PPI)** system and **two-page visual QC report** with:
- PPI for the built config vs. same-price alternatives
- Customer-fit / suitability analysis against stated use-case and budget
- Visual benchmark graphs (solid bars = measured, ghosted = reference)

---

## Architecture (5 layers)

| Layer | What | Status |
|---|---|---|
| 1 | Price index — `component_prices` + `price_history` in Supabase + local JSON | **DONE** |
| 2 | Performance reference — `component_performance` table + PassMark CSV | **DONE** |
| 3 | Matching layer — ticket free-text → catalog SKU | **DONE** |
| 4 | PPI engine — pure function, I/O-free | **DONE (v1)** — `ppi.py` |
| 5 | Report rendering — two-page visual QC report | **NOT STARTED** |

---

## Files built this session

| File | What it does |
|---|---|
| `pcstudio_import.py` | Scrapes pcstudio.in (our supplier) via sitemap+JSON-LD. 3-tier fallback. `--limit N` for smoke test, `--fallback "query"` to search other retailers. |
| `supabase_loader.py` | Loads `output/catalog.json` → Supabase. Upserts on SKU into `component_prices`, appends to `price_history` only when price changes. |
| `benchmark_import.py` | Fetches PassMark CPU Mark (2,834 CPUs) + G3D GPU (2,830 GPUs). Saves to `assets/benchmarks/`. `--load-supabase` to push into `component_performance`. |
| `matcher.py` | Token-set fuzzy matcher. Order-independent. Normalises wattage/GB/MHz. Three-band output: auto-accept ≥82%, suggest 55-82%, no-match <55%. CLI: `python matcher.py --text "RTX 4060" --category gpu` |
| `database.sql` | Extended with: `component_prices`, `price_history`, `component_performance`, `sku_aliases` tables (full RLS, indexes). Run in Supabase SQL Editor. |
| `assets/benchmarks/cpu_passmark.json` | 2,834 CPU PassMark scores (commercially free with attribution) |
| `assets/benchmarks/gpu_passmark.json` | 2,830 GPU G3D scores (commercially free with attribution) |

---

## Catalog import — PARTIAL (2,738 / ~8,003), resume available

The overnight full run (2026-07-08 → finished 2026-07-09 04:02) captured only
**2,738 of ~8,003 products**: the machine lost network/DNS partway (~product
#3,491) and never recovered, so ~5,265 URLs failed with `getaddrinfo failed`.
The captured 2,738 are valid, all 9 categories, in `output/catalog.json`.
**This is not the site or the scraper — it was a local connectivity drop.**

The scraper is now **hardened** (2026-07-09):
- `get()` retries transient network failures 3× with exponential backoff.
- `--resume` loads `output/catalog.json`, skips captured URLs, fetches only the
  ~5,265 still missing, and merges (de-duped by URL) — no full re-scrape needed.
- Checkpoints `catalog.json` every 100 products, so a future drop can't wipe progress.

### To finish the catalog (fill the missing ~5,265):
```powershell
$py = "C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe"
Set-Location "C:\Users\Aladeen\Desktop\Aladeen\neoqc-main"
& $py pcstudio_import.py --resume        # ~1 hr on a stable connection; safe to re-run if it drops again
```

### Then push to Supabase (needs live network + the new tables applied — already done):
```powershell
& $py -m pip install supabase           # if not already installed
& $py supabase_loader.py                 # push catalog → component_prices / price_history
& $py benchmark_import.py --load-supabase   # push PassMark scores → component_performance
```

---

## Database tables added (run database.sql in Supabase SQL Editor)

```
component_prices     — current price per SKU (upsert target)
price_history        — append-only price log (insert only when price changes)
component_performance — benchmark scores, source=measured|reference
sku_aliases          — free-text → SKU map, staff-confirmable
```

**Schema not yet applied to live Supabase** — the new tables need to be created by running the additions at the bottom of `database.sql` in the Supabase SQL Editor.

---

## pcstudio.in scraper — key facts

- **Tier that works:** Tier 2 (sitemap + JSON-LD). Site has 9 product sitemaps, 8,003 URLs total.
- **Smoke test result:** 50 products, 100% with price, 100% with SKU — perfect.
- **Category slugs confirmed working:**
  - `processor`, `graphics-card`, `motherboard`, `ram`, `storage`, `power-supply`, `cabinets`, `cpu-cooler`
- **Site is our supplier** — scraping is authorised. Still display "Prices from pcstudio.in" in any customer-facing output.
- **Price field:** `offers.price` in JSON-LD is a number (INR), no parsing needed.
- **Known categorisation quirk:** WooCommerce sometimes labels AMD Ryzen platform motherboards under a "processor" category. The importer now checks name keywords and URL slug as fallback, with `motherboard` keywords taking priority over `cpu` keywords.

---

## Matcher — how it works

`matcher.py` — `Matcher.from_catalog_json("output/catalog.json")`

- Tokenises both query and catalog entry, lowercased, noise-words removed
- Normalises: `1000W` = `1000 Watts` → `1000w`; `16GB` = `16 GB` → `16gb`; `6000MHz` = `6000 MHz` → `6000mhz`
- Scores by weighted token intersection (model numbers / spec tokens score 2×)
- `match(text, category=None)` → `MatchResult(sku, matched_name, confidence, auto_accepted, needs_confirm)`
- `match_build_specs(specs_dict)` → matches all fields at once (for ticket batch processing)

**Tested confidence scores (20-item smoke catalog):**
- "MSI B650M Gaming Plus WiFi" → motherboard → 96% AUTO-ACCEPT ✓
- "RTX 5080 Zotac Solid Core" → gpu → 92% AUTO-ACCEPT ✓  
- "Corsair RM1000x 1000W" → psu → 88% AUTO-ACCEPT ✓

---

## Fallback price sources (partial — needs HTML selector tuning)

`python pcstudio_import.py --fallback "component name"` searches:
- mdcomputers.in (OpenCart)
- primeabgb.com (WooCommerce)
- vedantcomputers.com (Shopify)

Infrastructure is in place but per-site HTML selectors need live testing against each site. Do this when you hit a real component that's missing from pcstudio's catalog.

---

## Benchmark licensing (read before showing scores to customers)

| Source | Benchmark | Licence for commercial use |
|---|---|---|
| PassMark / cpubenchmark.net | CPU Mark | **Free** — must display "PassMark® / passmark.com" attribution |
| PassMark / videocardbenchmark.net | G3D Mark | **Free** — same attribution requirement |
| Our own Cinebench / FurMark runs | Cinebench MT, FurMark score | **Ours** — no restriction |
| Our own CrystalDiskMark | CDM seq read/write | **Ours** — no restriction |

In the QC report: solid bars = our measured scores, ghosted/outlined bars = PassMark reference. Footnote: "Reference scores from PassMark® (passmark.com). Your results may vary."

---

## Layer 4 — PPI Engine (built this session)

`ppi.py` — pure function, no I/O, unit-tested manually with a synthetic catalog (see below):

```
ppi(
    build_specs: dict,         # category -> SKU, matched from build ticket
    component_prices: dict,    # SKU -> {name, category, price_inr} — full catalog, not just the build
    benchmark_scores: dict,    # SKU -> {benchmark_name: score}, e.g. {"passmark-cpu": 32000}
    use_cases: list[str],      # selected from USE_CASE_WEIGHTS keys
    price_band_pct: float = 0.15  # how wide a "same price range" is (±15%)
) → PPIResult(
    index: float,                 # 0–100 composite score
    per_component_scores: dict,   # category -> 0-100
    in_range_comparisons: dict,   # category -> top 3 ComparisonEntry alternatives
    customer_fit_score: float,    # 0–1, ratio of build's benchmark vs MIN_RECOMMENDED thresholds
    flags: list[str],             # e.g. "GPU bottlenecked relative to CPU for the selected use-case"
)
```

**How it works:**
- Only `cpu` and `gpu` have objective benchmark data (`passmark-cpu` / `passmark-g3d`) wired up. `ram`/`storage`/`psu`/`case`/`cooler`/`motherboard` currently score a neutral 100 with a flag noting no benchmark data exists yet for them — see Open Items #7 (measured scores loader) to eventually fix this for storage (CDM) at least.
- Per-component score = min-max normalize the build's own benchmark score against every catalog SKU of the same category within `±price_band_pct` of its own price.
- Composite `index` = weighted average of per-component scores, weights averaged across all selected `use_cases` from `USE_CASE_WEIGHTS` (in `ppi.py`).
- `customer_fit_score` compares the build's raw CPU/GPU benchmark numbers against `MIN_RECOMMENDED` thresholds per use-case — **these thresholds and the `gaming-1080p`/`gaming-4k`/`streaming`/`content-creation` weight rows are engineering-judgment placeholders, not reviewed by the boss yet** (same caveat as the original weights table — see Open Items #3/#4).
- Bottleneck flag fires when CPU/GPU normalized scores diverge by more than 1.6x for gaming/ai-ml use-cases.

**Not yet done:** wiring `ppi()` up to real Supabase data (needs the full catalog import + `component_prices`/`component_performance` tables live), and Layer 5 (report rendering) which will call `ppi()` and draw the two-page QC report.

### Use-case taxonomy & PPI weights — now live in `ppi.py`
`USE_CASE_WEIGHTS` and `MIN_RECOMMENDED` in `ppi.py` are the current source of truth (superseding the old draft tables that used to live here). `gaming-1440p`/`video-editing`/`cad-3d`/`office`/`ai-ml` weights match what the boss reviewed; `gaming-1080p`/`gaming-4k`/`streaming`/`content-creation` are engineering-judgment fill-ins pending sign-off (Open Items #3/#4).

---

## Open items (don't let these get lost)

1. **Apply database.sql to Supabase** — the new tables are NOT live yet. Paste the bottom half of `database.sql` into Supabase SQL Editor.
2. **Wait for full run to finish** then run `supabase_loader.py` and `benchmark_import.py --load-supabase`.
3. **Finalise use-case taxonomy** — the list above is a draft. Confirm with the boss which use cases Neo Tokyo Kochi actually sells.
4. **PPI weights** — the table above is a starting point. Needs review.
5. **Fallback site selectors** — debug when you have a real missing component to test.
6. **PassMark attribution** — wire into QC report UI before showing reference scores.
7. **`source=measured` scores** — need a loader for our own Cinebench/FurMark/CrystalDiskMark results (currently only `source=reference` from PassMark is implemented).

---

## Quick command reference

```powershell
$py = "C:\Users\Aladeen\AppData\Local\Python\pythoncore-3.14-64\python.exe"
Set-Location "C:\Users\Aladeen\Desktop\Aladeen\neoqc-main"

# Check full run progress
Get-Content output\full_run_stdout.txt | Select-Object -Last 5
(Get-Content output\full_run_stdout.txt | Select-String "Tier2-JSONLD").Count

# After full run finishes: load to Supabase
& $py supabase_loader.py
& $py benchmark_import.py --load-supabase

# Test the matcher
& $py matcher.py --text "RTX 4070 Super ASUS" --category gpu
& $py matcher.py --ticket-id <ticket-id>

# Search fallback retailers for missing component
& $py pcstudio_import.py --fallback "Ryzen 9 9950X"

# Re-run smoke test
& $py pcstudio_import.py --limit 50

# Fetch fresh benchmark scores
& $py benchmark_import.py
```
