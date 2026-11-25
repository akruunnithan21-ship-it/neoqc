# PresentMon (bundled)

Intel's frame-time capture tool, used by the Testing Client's **service QC** mode to
measure a game's average FPS and 1% low against the customer's target.

- Version: 2.6.0, console build `PresentMon-2.6.0-x64.exe`
- Source: https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0
- Licence: MIT (see `LICENSE.txt`)
- Signed by Intel Corporation (Authenticode, Sectigo Public Code Signing CA R36)
- SHA-256: `B2A706BC6AD475749E3B7E3409263AA1E6906D45BDCF993F6DBC0F660188F1AF`

How the app runs it (see `main.js`, `sys:qc-fps-capture`):

    PresentMon-2.6.0-x64.exe --process_name <game.exe> --timed 60 --terminate_after_timed
                             --output_file <temp.csv> --no_console_stats --stop_existing_session

It needs admin rights for ETW tracing; the app already runs elevated.
