# QC after a service: the proposal (25 Nov 2026)

The owner's brief (§10): rename **Builds → QC**. QC can be for a new build or after a
service. On a service ticket, offer a QC test only once the issue is resolved, and only
if the customer wants it. It moves to QC the way a part moves to RMA. A service PC is
not new: no serial numbers and no gates.

Owner, 25 Nov: service QC answers the **customer's own question**: "can I now play
Valorant at a 450 fps average?", "does the file that always crashed now render?". There
is no "before" test.

## The flow

1. **Repair done, at Testing.** The service ticket's Next step offers:
   - **Send to QC**, when the customer asked for it;
   - **Mark ready**, which is the normal close and does not change.
2. **Send to QC.** A short form records the customer's goals:
   - **Game goal:** game, resolution and quality, and the target average FPS
     (e.g. Valorant · 1080p low · 450 fps).
   - **Work goal:** the app and the file or task, and what counts as a pass
     ("renders without crashing", optionally "in under 10 minutes").
   - **The customer's own words** (optional).
   The ticket shows "In QC" and stays at Testing. The QC job appears on the QC
   screen's **After service** tab and on the bench PC.
3. **On the bench PC (Testing Client)**, the service QC runs:
   - **Health, about 2 minutes:**
     - idle temperatures;
     - SMART health of every drive, read only (no disk write test on a customer's
       drive);
     - Windows hardware errors (WHEA) in the last 7 days.
   - **Stability, 15 minutes by default:**
     - CPU and GPU together (Prime95 and FurMark), with live temperatures;
     - it passes with no crash, no new WHEA error, temperatures under the limits and
       no thermal throttling;
     - longer (30 or 60 minutes) when the fault was crashes or freezes;
     - a RAM test only if RAM was part of the repair.
   - **The customer's goals:**
     - **Game:** the tester plays the customer's game for 60 seconds at their
       settings. PresentMon (Intel, MIT licence, bundled like Prime95) records it,
       giving the average FPS and the 1% low, against the target.
     - **Work:** the tester runs the customer's file. The app times it and checks
       Windows for an app crash. It passes if it completes, inside the time target if
       one was given.
   - **Skipped for a customer's PC:** serials, the build checklists, the same-PC
     check, Cinebench and DiskSpd writes.
4. **The result.** A one-page **Service QC report** (print or PDF):
   - each goal with ✓ or ✗ and its numbers;
   - the stability summary (time, peak temperatures, errors);
   - drive health;
   - who tested it, and when.
   The customer's tracking page and WhatsApp line say "QC passed" (or what did not
   pass), and the ticket's Next step becomes **Mark ready**.

## Where it lives (as built for 1.16)

The proposal put QC jobs in `tickets`. It was built as its own table instead, so build
tickets stay untouched.

- **Server, v2.13 (live 25 Nov 2026):** the `service_qc` table, one row per QC test of
  a service ticket. The RPCs are `service_qc_send` / `_cancel` (service desk) and
  `service_qc_start` / `_finish` (QC desk). Sending and finishing write
  customer-visible history lines, which the tracking page shows as they are.
- **Desk side:** `service.js`. At Testing, Next step offers **Send to QC…** (goals,
  15 / 30 / 60 minutes, free or paid).
- **QC screen:** `qc-service.js`, the After service tab. Its cards open the summary
  page or the bench test.
- **The bench test:** `qc-bench.js` + `qc-bench.css`. The app runs on the customer's
  PC:
  1. **Health check** (read-only): every drive's Windows health, wear, temperature
     and errors; CPU / GPU idle temperature (20 s of LibreHardwareMonitor); and WHEA
     hardware errors from the last 7 days.
  2. **Stability:** `sys:run-diagnostics` with `{ serviceQc: true }` runs Prime95 +
     FurMark together for the chosen minutes, with no Cinebench, no DiskSpd (it would
     write to the customer's drive) and no RAM worker. WHEA errors are checked for
     the run.
  3. **Game goal:** PresentMon 2.6.0 (`assets/diagnostics/PresentMon`, MIT,
     Intel-signed) records 60 s after a 10 s delay. Average FPS = frames ÷ time;
     1% low = the average of the slowest 1% of frames.
  4. **Work goal:** a timer, plus Windows' crash log (Application Error / Hang /
     WER) for the chosen app since the timer started.
  5. **Finish:** a suggested verdict and summary that the tech can change, then
     `service_qc_finish`, then the one-page **Service QC report** (print or PDF).
- **Main process:** `service-qc-bench.js` (`sys:qc-disks`, `sys:qc-idle-temps`,
  `sys:qc-whea`, `sys:qc-processes`, `sys:qc-fps-capture`, `sys:qc-app-crashes`).
  Values reach PowerShell only through environment variables.
- **Limits it suggests (the tech decides):**
  - stability: CPU ≥ 95 °C = check and ≥ 100 °C = problem; GPU ≥ 95 °C = check
    and ≥ 105 °C = problem;
  - any Prime95 error or WHEA error during the run = problem;
  - idle CPU or GPU ≥ 60 °C = check.
- **In the dev harness** a practice adapter fills in made-up numbers. It says so on
  screen and on the printed report, and demo data cannot be saved.

## Decisions (owner, 25 Nov 2026)

- **FPS** is captured automatically with PresentMon: the tester plays 60 s, and the
  average and 1% low are compared with the target.
- **Stability** runs 15 minutes by default. Choose 30 or 60 minutes when the fault was
  crashes or freezes.
- **Charge:** the desk decides per ticket, paid or free, when it sends the ticket to
  QC.
- **QC screen:** two tabs, **New builds** (today's builds, unchanged) and **After
  service**.
