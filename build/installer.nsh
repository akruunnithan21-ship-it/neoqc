; NeoQC NSIS installer customisation.
; Proactively add a Windows Defender exclusion for the bundled OpenRGB folder
; so its low-level lighting driver (WinRing0 / inpout32) is never quarantined
; as RiskWare — the root cause of "RGB control stopped working". The installer
; already runs elevated (requestedExecutionLevel: requireAdministrator), so
; Add-MpPreference succeeds. Best-effort: silenced and non-fatal if Defender is
; policy-managed or a third-party AV is primary.
!macro customInstall
  ; v1.4.4 — broader install-time exclusion set. Covers the packaged folder,
  ; the process name, AND the specific driver files Defender flags as RiskWare
  ; (WinRing0*.sys). The app also re-runs Add-MpPreference on every boot, so
  ; this covers the first launch before the app has a chance to run.
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\resources\app.asar.unpacked\assets\diagnostics\OpenRGB\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess \"OpenRGB.exe\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath \"$INSTDIR\resources\app.asar.unpacked\assets\diagnostics\OpenRGB\WinRing0.sys\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath \"$INSTDIR\resources\app.asar.unpacked\assets\diagnostics\OpenRGB\WinRing0x64.sys\" -ErrorAction SilentlyContinue; Set-MpPreference -SubmitSamplesConsent 2 -ErrorAction SilentlyContinue; try { & \"$PROGRAMFILES\Windows Defender\MpCmdRun.exe\" -Restore -Name \"*OpenRGB*\" } catch {}; try { & \"$PROGRAMFILES\Windows Defender\MpCmdRun.exe\" -Restore -Name \"*WinRing*\" } catch {}"'
!macroend
