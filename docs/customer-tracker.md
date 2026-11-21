# Customer tracker (neoqctracker.netlify.app)

The site root is now one tracker for every kind of code. The staff portal moved,
unchanged, to `/staff/`.

| Code | What it is | Looked up with |
|---|---|---|
| `7F3A2C` (6 characters, last 6 of the ticket id) | New PC build | `get_build_public(code, phone4)` |
| `NT-XXXXXXXX` | Repair, on-site visit, remote session | `get_service_public(code, phone4)` |
| `RM-XXXXXXXX` | One part under warranty claim | `get_rma_public(code, phone4)` |

Every lookup needs the last 4 digits of the customer's phone. Wrong code and wrong
digits give the same answer, so the page cannot confirm that a code exists.

## Files

```
dashboard/index.html              the tracker page (no inline scripts: CSP)
dashboard/tracker/config.js       shop contact details and the public Supabase key  ← edit here
dashboard/tracker/tracker-core.js code parsing, dates in India time, status → wording (no DOM; tested)
dashboard/tracker/tracker.js      the page: lookups, views, saved tickets, live refresh, theme
dashboard/tracker/tracker.css     styles (the configurator's design tokens)
dashboard/tracker/theme-boot.js   applies a chosen theme before paint
dashboard/tracker/demo.js         sample tickets, loaded only with ?demo
dashboard/brand/, dashboard/fonts/ logo files and Outfit/League Spartan (OFL) from the configurator
dashboard/sw.js, manifest.webmanifest  installable app, offline shell (never caches ticket data)
dashboard/staff/index.html        the old staff page, moved; scripts stay in dashboard/
dashboard/staff/boot.js           /staff/ opens the sign-in instead of the old customer page
sql/tracker-build-public.sql      + -rollback.sql, .tests.sql
tests/tracker-core.test.js        node tests/tracker-core.test.js
dev/serve-dashboard.js            local preview with Netlify's routing
```

Wording for repairs and warranty parts comes from `shared/service-status.js`, the
same module the desktop app uses. Builds use the five statuses the desktop app sets.

## Design rules kept

- **Polling, never realtime.** A realtime payload is the raw row and would bypass
  the curated `get_*_public` functions. The page re-asks every 30 s while open and
  when the customer returns to the tab.
- **Builds get a step bar; repairs and parts don't.** A build moves one way. A
  repair loops (diagnose, quote, wait for a part, bench again), so it shows who
  has it now (You / Neo Tokyo / the manufacturer) and a timeline instead.
- **Missed dates are owned**, never shown as a promise in the past.
- **Escaped output.** Server strings never become attributes or class names.

## Deploying

1. Run `sql/tracker-build-public.sql` in the Supabase SQL editor (adds
   `tickets.customer_phone`, `get_build_public`, a lookup throttle). Optionally run
   `sql/tracker-build-public.tests.sql`: it ends in ROLLBACK.
   **Done on 21 Nov 2026** on the NeoQC project (migrations `tracker_build_public`
   and `tracker_build_public_helpers_private`); the tests passed and left nothing behind.
2. Fill in `dashboard/tracker/config.js` → `shop.whatsapp`, `shop.phone`, `shop.hours`.
3. Merge and push: Netlify publishes `dashboard/` (see `netlify.toml`).
4. When the new page is live, revoke the old code-only lookup (last line of the SQL file).

Until step 1 runs, build lookups fall back to `get_ticket_public` and show the
limited view (status and dates, no name or QC report).

Builds made before step 1 have no phone on file: they show the limited view
whatever digits are typed, with a button to ask the shop to add the number. Both
the website's New Build form and Neo Service's build form (1.14.1) save the phone;
Neo Service requires it for a new build.

## Neo Service and the website (1.14.1)

- **One address setting.** `shared/service-catalog.js` builds every tracking
  link (`trackLink`) for Neo Service, the staff website and the WhatsApp
  templates. Until https://service.neotokyo.in answers `/ping.json` with
  `{"site":"neo-service"}`, links keep the old Netlify address (which opens NT-
  and RM- codes but not build codes). Neo Service asks at start and every hour
  (`checkCustomerSite`); once the site has answered, the switch is kept on that
  PC. The staff website switches when it is itself served from service.neotokyo.in.
- **Builds** (ticket window footer): 🔗 Tracking link, 💬 WhatsApp (to the
  customer's mobile, with the "ready to collect" wording once QC is complete) and
  👁️ Customer view. They appear once the site is live, since a build code can't
  open on the old address.
- **Customer view** (builds, repairs, warranty parts): `main.js`
  `customer-view:open` opens the customer page in a sandboxed window with its own
  in-memory session, fills the last 4 digits, and switches "Remember on this
  phone" off. Only the two customer-site addresses can load in it.
- **QC report and delivery receipt** print the tracking address, and a QR code
  when `vendor/qrcode-generator/qrcode.js` is loaded, only once the site is live:
  paper outlives a link.
- `customer_phone` is sent to the database only when Neo Service has one, so an
  empty field (or an older Neo Service) never wipes a saved number.

## Hosting on the NAS (service.neotokyo.in)

Like the planner: `deploy/nas/server.js` serves a copy of `dashboard/` on the NAS
at 127.0.0.1:8097 (systemd service `neo-tracker`), and the developers' Cloudflare
tunnel, whose connector already runs on the NAS, publishes it as
https://service.neotokyo.in. Build the folder to copy with
`deploy/nas/make-package.ps1`; install and update steps are in `deploy/nas/README.md`.

## Local preview

```
node dev/serve-dashboard.js
```

Then open http://localhost:8090/?demo for sample tickets (phone digits 1234), or
http://localhost:8090/ against the live database.

## Old links

- `/?view=service&code=NT-…` (links staff already sent) → the tracker, code filled in.
- `/?view=dashboard`, `/?view=new-service`, … → `/staff/?view=…`.
- `/t/<code>` → the tracker with that code; opens straight away if it is saved on that phone.
