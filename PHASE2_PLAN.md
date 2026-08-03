# Neo QC → **Neo OS** — Phase 2 Expansion Plan

**Author's note (for Ananthakrishnan):** This is the "take it to the next level" plan you
asked for. It turns Neo QC from a *QC-and-build-tracking* tool into the **operating system
for the whole shop** — connecting the customer, the stock on your racks, the work on the
bench, and the suppliers you buy from, into **one system on one database**. Read the "Big
Idea" first; it's the thing that makes all four requested features (call centre, inventory,
service, procurement) fit together instead of being four bolted-on modules.

---

## 0. The Big Idea — the Component Lifecycle Loop

Everything Neo QC already does is **component-centric**. Your `component_prices` catalogue
(5,693 priced SKUs + PassMark benchmarks) is the spine of the app. A *build* consumes
components; a *repair* replaces components; *stock* is components sitting on a rack;
*procurement* is buying components; a *quote* is a list of components.

So the whole of Phase 2 is one idea: **give every component a physical and financial life,
and let the app follow it around the shop.**

```
  ┌──────────────┐   quote     ┌─────────┐  reserve stock  ┌───────────────┐
  │  CALL CENTRE │ ──────────▶ │ TICKET  │ ───────────────▶│  INVENTORY /  │
  │  (enquiry,   │  (catalog   │ (build/ │                 │  RACK STOCK   │
  │   CRM, quote)│   + PPI)    │ service)│◀── pick/install ─│ (units, racks)│
  └──────────────┘             └────┬────┘                 └───────┬───────┘
        ▲                           │ QC (your existing flow)      │ short?
        │ warranty / repeat         ▼                              ▼
        │ customer            ┌───────────┐   RMA a bad part ┌─────────────┐
  ┌─────┴──────┐  deliver     │  SERVICE  │ ────────────────▶│ PROCUREMENT │
  │  CUSTOMER  │◀─────────────│  DESK     │                  │ (suppliers, │
  │  (history) │              │ (repair/  │◀── receive ──────│  POs, price │
  └────────────┘              │  RMA/warr)│    into rack     │  intel)     │
                              └───────────┘                  └─────────────┘
```

**Why this is "another level":** no off-the-shelf POS or repair-shop app understands the
*Indian PC-component market* the way yours already does — you have live multi-retailer price
lookup, price history, and a PassMark-backed value engine (PPI). Bolt that onto real stock
and purchasing and you have something you could eventually sell to *other* shops.

---

## 1. The four pillars

### Pillar A — Call Centre & CRM (the front door)

Capture every customer contact **before** a ticket exists, and remember every customer.

- **Customer profiles (CRM).** Today `customerName` is free text with no memory. Phase 2
  introduces a real `customers` table keyed on phone number. Every ticket, quote, build and
  repair links to it → one screen shows a customer's whole history with the shop.
- **Enquiries / leads.** A quick intake form: name, phone, channel (call / walk-in /
  WhatsApp / Instagram), what they want (build budget or repair fault), and status
  (new → quoted → converted → lost). Nothing walks out the door un-logged.
- **Call log + follow-ups.** One-tap logging during/after a call, with a follow-up reminder
  date that shows on a "call these people today" list.
- **Quotation builder.** From an enquiry, assemble a build using the catalogue autocomplete
  you already have, price it, run **PPI as a sales tool** ("here's the performance-per-rupee
  you're getting vs alternatives"), and export a branded quote PDF (reusing your print
  pipeline). Accepting a quote converts it straight into a build ticket.

**Reuses today:** catalogue autocomplete, PPI engine, print/PDF infrastructure, the
customer dashboard.

---

### Pillar B — Inventory & Rack Stock (the warehouse)

Track *physical units*, not just catalogue prices.

- **Stock items.** Each physical unit/lot ties to a catalogue SKU and carries
  `qty_on_hand`, `rack_location` (e.g. `A3 · shelf 2 · bin 4`), serial number(s), **cost
  price**, and condition (new / open-box / used / RMA-pending).
- **Visual rack map.** A grid view of your racks and shelves so any staff member can find or
  put away a part in seconds. Print QR/barcode labels for bins and serialized items (you
  already print reports — same infrastructure).
- **Stock movements (audit log).** Received · reserved · picked · installed · returned ·
  adjusted. Every build/repair that consumes a part auto-decrements stock, so counts stay
  honest.
- **Reservations wired to tickets.** When a build ticket is created, its components are
  *reserved* from stock. Your existing **"Awaiting Components"** chip becomes real: awaiting =
  not in stock → automatically raises a procurement need.
- **Low-stock alerts.** Reorder point per SKU → feeds Pillar D.

**Reuses today:** `component_prices` SKUs, the awaiting-components workflow, `serials` JSONB.

---

### Pillar C — Service Desk (repairs, warranty, RMA)

You already have `ticket.type = 'repair'`. Phase 2 turns it into a proper service workflow.

- **Service intake.** Device, reported fault, accessories received, condition photos,
  customer + warranty status.
- **Repair stages.** received → diagnosing → awaiting approval → awaiting parts (→ Pillar D) →
  repairing → **QC (your existing stress/benchmark flow)** → ready → delivered.
- **Parts used** are pulled from inventory (Pillar B) and costed; labour added; margin known.
- **Warranty tracking.** You already *print* a warranty grid — make it a queryable record
  (workmanship 6 mo, drivers 30 d, component warranty, RMA windows). Customer lookup shows
  live warranty status.
- **DOA / RMA loop.** Your `damagedComponents` / DOA feature feeds a supplier **RMA record**
  → hands back to procurement to claim the replacement.

**Reuses today:** the whole QC/stress/benchmark flow, `damagedComponents`, the printed
warranty grid, the customer tracking dashboard.

---

### Pillar D — Procurement (suppliers & purchasing)

Close the loop back to where components come from.

- **Suppliers.** Formalise what you already scrape (pcstudio.in + the 5 fallback retailers)
  into supplier records with contact, terms and lead time.
- **Purchase orders.** Auto-suggested from *low stock* + *awaiting components across all open
  tickets*. Create → send → track (ordered → shipped → received). **Receiving a PO increments
  rack stock** (Pillar B).
- **Price intelligence (your unfair advantage).** You already do live price lookup across 6
  retailers and keep `price_history`. Surface "cheapest supplier right now" + price-trend
  charts so you buy at the right moment. Nothing else on the market does this for Indian PC
  parts.
- **Margin reporting.** Cost (from PO/inventory) vs sell price (on the ticket) → per-build and
  shop-wide margin. Combined with PPI you can show a customer *value* while you track
  *profit*.

**Reuses today:** `pcstudio_import.py` scrapers + web-lookup, `price_history`,
`component_prices`.

---

## 2. Build these FIRST (foundations) — before any pillar

These are prerequisites, and two of them come straight out of the 2026-07-22 code review.
Adding four big feature areas on top of the current base without them will hurt.

1. **Real authentication + tightened RLS** *(review item #4 — now the top security debt).*
   Today the Supabase anon key ships inside every public installer and RLS is fully
   permissive → anyone who downloads NeoQC can read/edit/delete all customer data. Before you
   store supplier prices, margins and a full customer CRM, add real logins with roles
   (**sales / technician / manager**) and scope RLS to authenticated users. Then rotate the
   burned anon key. (Hardening SQL is stubbed in `database.sql`.)

2. **Split `app.js` (7,100+ lines) into modules by domain** *(review QoL).* Before it grows,
   break it into e.g. `tickets.js`, `catalog.js`, `crm.js`, `inventory.js`, `procurement.js`,
   `service.js`, `render.js`, `sync.js`. High blast-radius today; this pays for itself
   immediately in Phase 2.

3. **Schema design.** New tables (kept around the `component_prices` spine):
   `customers`, `enquiries`, `call_logs`, `quotes` + `quote_lines`, `suppliers`,
   `purchase_orders` + `po_lines`, `stock_items`, `stock_movements`, `rma`; extend `tickets`
   for the richer service workflow (or add `service_tickets`).

4. **Optimistic-concurrency on sync** *(review item #3).* Full-row last-write-wins is risky
   once sales, technicians and a manager all edit at once. Guard updates with
   `WHERE updated_at = <loaded_value>` and merge on conflict.

---

## 3. Suggested rollout (each step ships on its own)

| Step | Name | What lands | Headline value |
|---|---|---|---|
| **2.0** | Foundation | auth + roles, RLS lockdown, `app.js` split, `customers` table (migrate `customerName` → real records) | De-risks everything; unlocks CRM |
| **2.1** | Call Centre & CRM | enquiries, call log + follow-ups, customer history, quote builder (reuses PPI) | Immediate sales lift; nothing un-logged |
| **2.2** | Inventory & Rack | stock items, rack map, movements, ticket reservations, QR labels, low-stock alerts | Stop losing parts; real "awaiting" |
| **2.3** | Procurement | suppliers, POs (auto-suggested), receiving → stock, price-intel dashboard, margins | Buy smart; see profit |
| **2.4** | Service Desk | full repair/RMA/warranty workflow feeding existing QC | Repairs become first-class |
| **2.5** | Ops dashboard | the closed-loop view: pipeline, margins, low-stock, KPIs | Run the shop from one screen |

**Recommended first move:** Step **2.0** (foundation) → then **2.1 Call Centre + Quote
builder**, because it reuses the most of what already exists (catalogue + PPI + PDF) and pays
back fastest in real sales.

---

## 4. Phase-1 status (as of this session, 2026-07-25)

Phase 1 was tightened before starting Phase 2 — see `HANDOFF.md` for the detail. Summary:
window controls redesigned (glass); non-blocking toast + confirm system replaces all 46
native `alert()`/`confirm()`; atomic local DB writes + rotating backup + corruption recovery;
save-failures and corruption now surface to the user instead of failing silently; stored-XSS
render sites escaped; dashboard search debounced; version string auto-stamped; RLS hardening
documented. Remaining higher-severity items intentionally deferred to Phase 2 foundation:
full auth/RLS lockdown (#4), optimistic-concurrency sync (#3), and the `app.js` module split.
