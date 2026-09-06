# Neo QC — Security Hardening & Production-Readiness Handover

**Date:** 2026-09-06 · **Baseline:** v1.9.6 · **Scope:** fixes applied from the full 82-finding audit.

This document records (A) everything already fixed in the code, (B) the steps only you
can run (live database, signing certificate, key rotation), (C) the one deferred item and
why, and (D) a verification checklist to run before you cut the production OTA.

> **Golden rule that drove every fix:** the app can only *ask* — the **database** decides.
> Security lives in Supabase RLS, never in client JavaScript.

---

## A. Fixed in code (already in your working tree)

### A1. Stored-XSS → remote-code-execution — CLOSED
Every unescaped `innerHTML` sink that received customer/cloud data now escapes it with the
existing helper. In a `nodeIntegration` renderer these were arbitrary-code-execution vectors.

| File | What was unescaped | Fix |
|------|--------------------|-----|
| `app.js` (event log `renderEventLog`) | `entry.event`, `entry.user` | wrapped in `escapeHtmlLite()` |
| `app.js` (damage report) | component `category` | wrapped in `escapeHtmlLite()` |
| `app.js` (God-Mode options) | measured `current` value + option text | wrapped in `escapeHtmlLite()` |
| `print-render.js` (inventory table) | joined WMI strings `r[1]` | `join()` now runs `esc()` on all data |
| `sales.html` (legacy) | customer name, specs, technician, missing-parts | added an `esc()` helper, escaped all |

`dashboard/app.js` and `customer.html` were checked and already escape correctly (`escHtml`).

### A2. Electron / website hardening — ADDED (low-risk layer, per your choice)
- **`index.html`** — added a `Content-Security-Policy` `<meta>`. Because the app has **no
  inline scripts or `on*=` handlers**, `script-src` omits `'unsafe-inline'`, so an injected
  inline handler/script cannot run even if an escape were ever missed. OCR (tesseract) runs
  in the main process, so no renderer WASM/worker rules were needed. **Rollback:** delete
  that one `<meta>` tag.
- **`main.js`** — added `will-navigate` + `setWindowOpenHandler` guards: the window can't be
  navigated to a remote/hostile URL, and no in-process child windows can be spawned (external
  links open in the system browser). Zero functional impact (the app never uses `window.open`).
- **`main.js`** — added a global `uncaughtException` / `unhandledRejection` net so a spawned
  diagnostic failing no longer crashes the whole app.
- **`netlify.toml`** — added CSP + `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` headers for the public website.
- **`main.js`** — the two legacy port handlers no longer interpolate the IPC `portType` into a
  shell string (sanitised to `[A-Za-z0-9_-]`); the `catalog:fetch-url` bridge now blocks
  loopback/private/link-local hosts (SSRF guard) while still allowing public price lookups.

### A3. Correctness / QC-integrity bugs — FIXED & unit-tested
- **`compat-check.js`** — Intel generation parse now handles 4-digit (gen 2–9) and 5-digit
  (gen 10+) model numbers, so 6th–9th-gen chips are no longer mislabelled LGA1851/DDR5. ✔ tested.
- **`ssd-grading.js`** — when the PCIe link probe fails, the drive is reported **"not graded"**
  instead of being silently graded against a Gen3 floor (which gave slow Gen4/5 drives a false
  PASS). ✔ tested.
- **`invoice-import.js`** — price extraction now has a high-precision fallback for invoices
  without thousands-separators (`Rs 1200`, `850.00`) while still ignoring RAM speeds, model
  numbers and HSN codes. ✔ tested.
- **`dashboard/app.js`** — the customer QC verdict and the staff PASS/FAIL badge now share one
  `qcVerdict()` helper, so the customer can never be told "passed" while RAM stress failed.
- **`dashboard/app.js`** — customer lookup no longer returns an arbitrary ticket on a code
  collision; if a short code matches >1 build it asks for more characters (was `limit(1)` with
  no ordering → could show the WRONG customer's build).
- **`dashboard/app.js`** — `technicianMatchesProfile` tightened (all words must match; real
  scoping is Phase 4 RLS).

### A4. Data-integrity — FIXED
- **`app.js`** — mock "Test Build" tickets are no longer pushed to the shared cloud on a fresh
  install (they polluted the production DB). They stay local and are pruned once real data loads.
- **`app.js`** — `syncFromCloud()` no longer deletes local-only tickets that never uploaded
  (offline-created tickets were being destroyed). It now prunes only tickets known to have
  reached the cloud (`cloudSynced`) that are since gone remotely.

### A5. Supply chain & build hygiene — FIXED
- **`download-tools.js`** — HTTPS-only downloads, no http-downgrade redirects, redirect cap,
  and **SHA-256 verification** (aborts on mismatch when a hash is pinned; prints the computed
  hash and warns when unpinned). **Action for you:** run it once from a trusted network, copy
  each printed hash into `EXPECTED_SHA256`, and replace FurMark's `get latest` mirror with a
  pinned versioned URL.
- **`electron-builder.json`** — output dir changed from a hardcoded `C:/Users/Aladeen/...`
  path to `dist` (builds now work on any machine / CI).
- **`package.json`** — removed the dead, drifted `"build"` block (the real config is
  `electron-builder.json`).
- Deleted **`electron-builder-admin.json`** and **`electron-builder-client.json`** — orphaned
  configs that would silently break OTA if ever run.
- **`build-helper.js`** — default mode is now `selector` (the shipped mode), not `client`.

---

## B. You must do these (I cannot reach your live DB / buy your certificate)

### B1. Lock down the database — `database-hardening.sql`  ← the #1 critical fix
Run it **phase by phase** in the Supabase SQL editor, testing between phases. See the file's
header for the full plan. In short:
- **Phase 0 (do now, safe):** drops anonymous `DELETE` on `tickets` + `component_prices` —
  removes the "anyone can wipe the whole database" capability immediately.
- **Phase 1:** adds `authenticated` policies alongside anon (no behaviour change yet).
- **Phase 2:** removes anon read/write of customer data; adds `get_ticket_public()` for the
  customer lookup. **Before Phase 2** confirm every app mode (incl. Testing Client) signs in,
  and switch the Python importers to a **service-role key kept off the shop PCs**.
- **Phase 3:** rotate the anon key (it's burned — it's in git history + every build).
- **Phase 4 (follow-up):** true per-technician RLS via a `technician_uid` column.

**Paired app change for Phase 2** — the customer "Track your build" lookup must call the RPC
instead of selecting the table. In `dashboard/app.js` `doLookup()` (and the same pattern in
`customer.html`), replace the `.from('tickets').select(...).filter('id','ilike',...).limit(2)`
query with:
```js
const { data, error } = await db.rpc('get_ticket_public', { code: raw.toLowerCase() });
```
The rest of the ambiguity handling (`data.length > 1` → ask for more characters) already works
as written. Deploy this **together with** Phase 2 (the RPC must exist first).

### B2. Code-sign the app + verify updates
The OTA installs as Administrator with no publisher/signature check — anyone who can publish a
GitHub release could push arbitrary admin-level code to every shop PC. After you obtain an
Authenticode (EV or OV) certificate, add to `electron-builder.json` under `"win"`:
```json
"certificateFile": "path/to/cert.pfx",
"certificatePassword": "…", // better: set CSC_LINK / CSC_KEY_PASSWORD env vars instead
"signingHashAlgorithms": ["sha256"]
```
and set `"nsis": { "publisherName": "Neo Tokyo Kochi" }`. Then electron-updater will refuse
any update whose publisher doesn't match. Until you have a cert, **restrict who can publish
GitHub releases** (2FA, no long-lived tokens).

### B3. Importers → service-role key
`pcstudio_import.py`, `ppi_sync.py`, `benchmark_import.py`, `supabase_loader.py` currently write
with the anon key. Give them the **service-role key** (via an env var, never committed, run only
on your workstation). service_role bypasses RLS, so they keep working after Phase 2 with no
write policy needed. Remove the hardcoded anon key from these files.

---

## C. Deferred (with reason) — PDF library upgrade
You chose "upgrade now", but on inspection this is **not a version bump — it's an ESM
migration**: pdfjs v4+ removed the CommonJS `legacy/build/pdf.js` that `main.js` and
`invoice-ocr.js` both `require()`, and the renderer OCR path depends on a bundled
`assets/ocr/pdf.worker.js` that isn't in this repo and can't be tested here. Shipping it blind
risks breaking invoice import (a core feature) in production.

**The known CVE (CVE-2024-4367) is already neutralised in your code** — `isEvalSupported:false`
is set at both call sites — so there is **no live exposure** today. Recommended: do the upgrade
as a dedicated, tested change:
1. `npm i pdfjs-dist@^4.10.38` (patched, most stable) or `@latest` for 5.x/6.x.
2. `main.js`: `const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');` (handler is async).
3. `invoice-ocr.js` (renderer): `await import(require('url').pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)` and update the bundled worker to `pdf.worker.mjs`.
4. Test **both** paths with a real text PDF **and** a scanned/image invoice before shipping.

---

## D. Lower-priority items still open (non-blocking)
- `main.js` — the detached "dialog auto-clicker" PowerShell can outlive the app; the diagnostic
  spawns (`monitorProc`/`furmarkProc`/`cinebenchProc`) still lack their own `error` handlers
  (the global net now stops the crash, but the diagnostics promise can still hang). `taskkill`
  kills by image name (can hit unrelated instances) — track and kill by PID.
- Accessibility: icon-only controls/modals lack ARIA labels.
- Docs: `README.md` still cites an old path and `dist/`; `HANDOFF.md` header still says v1.8.4.

---

## E. Verification checklist — run before the production OTA
I unit-tested the pure-logic fixes (compat-check, ssd-grading, invoice prices). The rest needs
a smoke test on a real shop PC because they depend on Electron/hardware/live Supabase:

- [ ] **App launches** and the main window renders (confirms the CSP `<meta>` didn't block a
      needed resource — watch DevTools console for CSP violations).
- [ ] **Supabase sync** works: create/edit/complete a ticket, see it on another machine + the website.
- [ ] **Invoice import**: import a real invoice (both a comma-grouped and a no-separator one) —
      prices fill in; no line mis-priced.
- [ ] **Auto-detect + diagnostics**: run a full QC pass; report prints; inventory shows correctly.
- [ ] **Customer website**: "Track your build" finds a ticket; a completed build with a failed RAM
      stress shows "checks failed" (not passed).
- [ ] **Fonts + Supabase CDN** load on both the app and the website (CSP allowlist correct).
- [ ] After **Phase 2 SQL**: an anonymous REST call to `/rest/v1/tickets` returns nothing;
      `get_ticket_public` still returns a single ticket.
- [ ] After **key rotation**: rebuild, OTA, confirm every machine reconnects with the new key.

**If the app CSP blocks something:** delete the `<meta http-equiv="Content-Security-Policy">`
tag in `index.html`, rebuild, and re-add it later with the missing origin allowlisted.
