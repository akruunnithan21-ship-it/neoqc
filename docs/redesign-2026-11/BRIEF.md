# Owner's brief, 24 Nov 2026: RMA, Service, QC and the look

The owner's request, written down as a checklist so nothing is lost. Each line says
what the owner asked for. The open questions and the release plan are at the end.

## 1. RMA ticket: the steps (shown on top, like the service ticket)

Each step is a check gate. Failing a gate means the part is not eligible for
warranty, and the customer gets a clear reason and reply.

1. **Ticket created**
2. **Component checked**: confirm the customer's complaint is real. Parts wrongly
   diagnosed by the customer or a technician have cost us time and money.
3. **Bill and component cross-verified**: still under warranty (from the invoice
   date), no physical damage that voids it, acceptable for warranty. Whether an
   invoice is needed depends on the brand and type: Intel and WD need none, and some
   centres check the invoice and hand it back.
4. **Submitted at vendor / RMA initiated**: how this works depends on the centre (see §3).
5. **Warranty process / RMA ongoing** (name still to be chosen): this is where the
   delay happens.
   - At the start, record the RMA no. / job no. and the acknowledgement or receipt
     (model, make, details).
   - Ready stock means a quick replacement. Otherwise there is an estimate window of
     usually 7–14 days, often longer.
   - If the model is out of stock or discontinued: an upgrade or downgrade to an
     equal model, or a credit note.
   - Show all of this clearly to staff and the customer, and make status updates easy.
6. **Ready for collection / replacement received**: say whether it was replaced from
   stock, repaired, or is coming by courier.
   - We have **2 days** to collect after we're told it's ready. After that the delay
     is ours to answer for, even when the coordinator is away.
7. **Component collected / ready for collection**: it came in at the counter, by
   courier, from our stock, or from a service ticket's diagnosis.
8. **RMA completed / Dispatched**: the claim is over (delivery challan, receipt or
   mail from the centre). "Dispatched" means it was couriered back. A courier
   customer may still collect in store.
   - After completion, add photos of the delivery challan or receipts.

## 2. RMA from a service ticket (one ticket, no duplicates)

- During diagnosis a faulty part under warranty is found. We ask the customer, and
  if they want warranty help, the RMA is raised **from the service ticket**.
- It shows in both Service and RMA. The service ticket stays open after the RMA
  closes until the customer's fault is fixed.
- The returned part may show other faults: paid replacement if out of warranty,
  another RMA if in warranty.
- On the service ticket, record the **RMA submitted date and who submitted it**,
  plus photos of the component at submission.
- After submitting, attach the **PDF or a photo of the receipt / job sheet**, and
  the **RMA reference / job no.**

## 3. Service centres and brand portals (fields mostly manual; Anagha, RMA coordinator and QC, fills them in)

| Centre | Brands | How it works |
|---|---|---|
| **Acro** | XPG, ADATA, G.Skill, Deepcool, Ant Esports… | Submit at their place. They re-check before accepting. Invoice goes with the part. Mostly replacements. |
| **F1 Info Services** | MSI, Acer, ASUS | They check the invoice date and hand it back. Mostly repairs (motherboards, PSUs). **MSI** couriers it back to our office; **ASUS** must be collected. |
| **Gigabyte** (authorised centre) | Gigabyte (and ADATA?) | Checks the invoice and hands it back. We collect. |
| **Kaizen** | Mercury, Cooler Master, Corsair, Colorful, Creative, Zotac, Syrotech, Lexar, Crucial, Sapphire, Nextron, Galax, Inno3D… | Like F1. Replaces RAM, SSD, HDD, PSU, sometimes coolers. Repairs GPUs and motherboards; if the fault comes back, a replacement of the same or another model (they call before using a different model). |
| **Smart Core** | Intel processors | No bill needed. |
| **Rashi Peripherals (RP Tech)** | NVIDIA, SanDisk, others | (no details yet) |
| **Brand portals** | AMD, SanDisk, WD, Samsung (depends on the type) | Register the claim online. The brand checks the warranty and gives a deadline to submit at an authorised centre. Sometimes it's replaced on the spot if stock is there; otherwise they tell us when it arrives. |

## 4. New RMA form

- Like the service ticket, but for RMA: **name first, phone second**.
- "Who sent it?" becomes **"Who brought or sent it to Neo Tokyo?"** (3 choices),
  then name and phone.
- **"How does it go back?"** is optional at creation. It becomes required only when
  completing (ready for pick-up / parts received), never earlier.
- Photos of the component at submission.
- **Storage drives (SSD, HDD…)**: tell the customer at creation that the data will
  be lost and we are not responsible. The same goes for service tickets.

## 5. RMA history library

- Every RMA ticket is kept after completion. A repeat fault on the same part is
  found by its serial and makes the new ticket faster.
- Record **warranty valid till**, worked out from the invoice date. After that date
  the history may be purged, since only paid repair is possible then.
- Customers sometimes run the claim themselves; we only assist. This covers parts,
  PCs and equipment whether or not they were bought from us.

## 6. Customers database

- A customer record for faster support on repeat visits. Later the ERP link pulls
  their bills, for RMAs.
- The service history shows a customer's completed warranty tickets too.
- Service ticket history is **never** purged.

## 7. Opening a ticket (Service and RMA)

- A click opens a **detailed summary**, not the edit form. It's a neat full (or
  almost full) page, with statuses, notes and important flags **on the right**.
- A separate **Edit** button.
- A **Notes** section in both, and notes can have **images**.
- Research the clearest, most fool-proof way to show the steps and current status,
  for both modules.

## 8. Look and feel

- The Overview looks dull. Overhaul the UI with the **Neo Configurator** theme (the
  owner's, not Rony's).

## 9. Access

- Technicians and service engineers no longer use the desktop app. They report to
  the ticket coordinator, the RMA lead or the service team lead.

## 10. QC module (was Builds)

- Rename **Builds → QC**: QC can be for new builds or after a service.
- On a service ticket, offer a **QC test** only after the issue is resolved. The
  ticket moves to QC the way it moves to RMA. If the customer doesn't want QC, close
  normally.
- A service PC isn't new: no serial numbers and no gates. Use the minimum, best set
  of stress tests and benchmarks to show it holds under load and the repair or
  upgrade helped.

## 11. Website

- Changes will come after this work.

## Decisions so far (24 Nov 2026)

- **Who keeps the desktop app:** Sreeraj P G (Service Team Lead, new; login to be
  created by the owner), Anagha K C, Vinayakan S, Ancy Baby, Adhil M. The leads keep
  it as always (owner, Ajay, Rony).
  - Everyone else who works service is phone-only (Jagath today; Sreehari and
    Anuranch when their logins exist).
- **RMA history after the warranty ends:** hidden from RMA lookups and repeat-claim
  suggestions, but kept in the customer's history. Nothing is deleted.
- **RMA steps:** the owner wants the full list explained so they can put the steps
  in workflow order and name step 5. See "RMA steps, explained" below.
- **Already in place:**
  - customers table and phone lookup;
  - RMA raised from a service ticket ("Send for RMA…") that holds the ticket;
  - QC tests (Cinebench R23, FurMark, Prime95, DiskSpd, RAM stress, sensors, SMART)
    for builds only.
- **Theme source:** configurator-landing-v2 frontend tokens (Outfit font, #DA1A5D
  pink, glass tiers, 12/16 px radii, stepper). The 10 Nov design-language PDF is
  out of date.

## Decisions, 25 Nov 2026

- **RMA steps:** the owner kept the explained order below, 1 to 8. Step 5 is named
  **"RMA Accepted"**.
  1. Ticket created
  2. Component checked (gate: no fault found)
  3. Bill and component cross-verified (gates: out of warranty, physical damage,
     sticker or serial tampered, invoice missing)
  4. Submitted at vendor / RMA initiated (submitted date and by whom, receipt or
     job sheet, RMA or job no., photos at submission)
  5. RMA Accepted (in repair / waiting for stock / model change offered / credit
     note; expected date and chase reminders)
  6. Ready for collection / replacement received (we collect: a 2-day clock; or
     it comes by courier)
  7. Component collected, back with us (new serial if replaced; "How does it go
     back?" required from here)
  8. RMA completed / Dispatched (DC, receipts or mails attached)
- **Centres are routed by brand + part type (+ model), not by brand alone.** Some
  ADATA SSD models go to Gigabyte's centre, while Acro takes ADATA RAM. The list in
  §3 is only the common centres: staff must be able to **add brands, models and
  warranty support centres**, and **save a brand (for a part type or model) with its
  centre**, so the right centre is suggested next time.
- **Service QC has no "before" test.** Service QC answers the customer's own
  question: "can I now play Valorant at a 450 fps average?", "does the file that
  always crashed now render?". It runs the customer's game or workload and reports
  against the target they gave, plus a short stability check. It is not the
  new-build gate list.
- **Server v2.11 is live (25 Nov 2026, owner's OK).** The RMA steps (rma_step), brands,
  routes and centres, and the return method decided later. The app side ships in 1.15.
  Until then, 1.14 cannot submit a part to a centre, because the server now requires the
  check and the warranty verification first.
- **Jidoka:** the owner's AI brain. It is researched and planned in its own session,
  "Jidoka". This release only adds the green orb beside the signed-in chip, with the
  hover banner "She is being created.", and the changelog line "Jidoka has been
  summoned, and she is being carefully crafted." The GitHub release notes say the
  same.
