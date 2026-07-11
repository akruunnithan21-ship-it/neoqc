; NeoQC NSIS installer customisation.
; Proactively add a Windows Defender exclusion for the bundled OpenRGB folder
; so its low-level lighting driver (WinRing0 / inpout32) is never quarantined
; as RiskWare — the root cause of "RGB control stopped working". The installer
; already runs elevated (requestedExecutionLevel: requireAdministrator), so
; Add-MpPreference succeeds. Best-effort: silenced and non-fatal if Defender is
; policy-managed or a third-party AV is primary.
!macro customInstall
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\resources\app.asar.unpacked\assets\diagnostics\OpenRGB\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess \"OpenRGB.exe\" -ErrorAction SilentlyContinue"'
!macroend
