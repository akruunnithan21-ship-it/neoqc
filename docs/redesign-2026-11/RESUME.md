# Where the redesign stands (paused 25 Nov 2026, owner asked to pause)

Say **continue** and work picks up at "Next, in order" below.

## Done and live
- **Neo Service 1.15.0 released:** main e7f5bf6, GitHub v1.15.0, update feed checked.
  It has the 8 RMA steps, Centres & brands, the new RMA form and the Jidoka orb.
- **Live database:** v2.11 (RMA steps, brands, routes, centres) and v2.12 (photos on
  notes), both applied with the owner's OK.

## Built for 1.16, NOT committed (branch rma-redesign-1.15)
- **Ticket summary page:** `ticket-summary.js/.css`. Board, Overview and QC cards open
  it; Edit opens the old panel.
- **Photos on notes:**
  - `ops-data.js` addNote/rmaNote take media ids;
  - `photo-tray.js` uploadAll returns rows;
  - the summary page's notes box has a tray.
- **Neo Glass theme:** `neo-theme.css` (loaded last), Outfit in `vendor/fonts/outfit`,
  Neo pink = #DA1A5D (app.js ACCENTS), Google now serves JetBrains Mono only.
- **New Overview:** `overview.css` plus shell.js renderHero, renderPipes, renderDue and
  renderTeam.
- **Service QC, round 1, part done:**
  - `sql/service-v2.13.sql` + rollback (service_qc table; send, cancel, start and
    finish RPCs). Dry-run passed on live and was rolled back. **NOT applied: needs the
    owner's OK.**
  - `ops-data.js`: qcJobs, qcOfJob, sendToQc, cancelQc, startQc, finishQc, and the
    'qc' event.
  - `service.js`: at Testing, Next step = Mark ready or **Send to QC…** (qcDialog:
    goals, stability 15/30/60, charge free/paid), plus Cancel QC.
  - Demo: Kiran Das (QC queued), Devika Menon (QC testing), and Sandeep (QC passed).
  - `qc-service.js` / `qc-service.css`: the "After service" tab. **Written, not wired
    into index.html or the harness yet.**
- **Docs:** `QC-SERVICE.md` holds the proposal and the owner's decisions (PresentMon
  auto FPS, 15 min, charge per ticket, two tabs).
- **Tests:** all 16 test files pass.

## Resumed 25 Nov 2026 (after "continue")

Steps 1–3 below are done:
- the QC tabs are wired in the app and the harness;
- Builds became QC (rail, nav title, Settings label);
- the summary page has a QC block and a QC flag.

Screenshots were sent. Waiting on the owner's OK for v2.13 and for the PresentMon
download (the latest is v2.6.0: PresentMon-2.6.0-x64.exe, 980,320 bytes, MIT).

**Owner said "Yes, both" (25 Nov 2026):**
- **v2.13 is LIVE** (migration service_v2_13_service_qc). Verified: the table has RLS
  on, authenticated has select only, the 4 RPCs are granted to authenticated, anon
  has none, and the helpers are locked.
- **PresentMon 2.6.0** is in `assets/diagnostics/PresentMon/`: the exe, the MIT
  LICENSE and a README. It is Intel-signed (signature valid), SHA-256 B2A706BC…F1AF.
  It is tracked in git like DiskSpd, so no release-copy step is needed.
- **The bench test is built** (step 5 below), and so is the report. The details are
  in QC-SERVICE.md, "Where it lives".
  - Files: `service-qc-bench.js` (main), `qc-bench.js/.css`; main.js runs
    run-diagnostics in `serviceQc` mode.
  - Buttons: on the board cards and on the summary's QC block.
  - Test: `tests/service-qc-bench.test.js`. All 17 test files pass.
- **Not yet checked on a real bench PC:**
  - a full stability run;
  - a live PresentMon capture in a game. It needs admin, which the installed app
    has; this dev shell does not.
- **Next:** release 1.16 (step 6).

## Next, in order
1. Wire the QC tabs into the staff screen, in index.html and in the harness:
   - add a `.qc-tabs` bar with "New builds" and "After service";
   - add `#qc-service-root`;
   - load `qc-service.js` and `qc-service.css`.
2. Rename **Builds → QC**:
   - the rail label and icon (modules.js and the shell.js fallback);
   - the staff nav title "NEO TOKYO // QC";
   - Settings → OPS_MODULE_LABELS.qc.
   Builds stay "builds" as items.
3. Add a QC section and flag to the summary page for tickets that have a QC job.
4. Take screenshots, then ask the owner to:
   - apply v2.13 live;
   - allow downloading PresentMon (PresentMon-2.3.1-x64.exe, GitHub GameTechDev/
     PresentMon releases, MIT licence).
5. Next round, the Testing Client's service QC mode:
   - health: SMART read-only, idle temperatures, WHEA errors;
   - stability: Prime95 + FurMark, 15 minutes by default;
   - game goal: a 60 s PresentMon capture giving the average and 1% low;
   - work goal: a timer plus an app-crash check;
   - a one-page Service QC report and a tracking-page line.
6. Release 1.16: summary page, note photos, theme, Overview and service QC. Build
   from a clean worktree (see memory release-build-clean-copy).

## Waiting on the owner
- **Sreeraj P G's login:** the owner creates it, then set him up like Vinayakan S.
- **Website changes:** the owner will describe them later.
- **Jidoka:** paused (docs/jidoka/LOCAL-PLAN.md).
