; Neo Service (1.13) — NSIS additions, included by electron-builder (nsis.include).
;
; The app was called "NeoQC" (and "Neo OS" inside) before 1.13. The installer
; now creates "Neo Service" shortcuts, so the old "NeoQC" ones are removed here
; — otherwise an upgraded PC would show two icons, one of them stale.
; Both shell contexts are cleaned (the old app may have been installed for all
; users or for one), then the context this installer uses is put back.
!macro customInstall
  SetShellVarContext all
  Delete "$DESKTOP\NeoQC.lnk"
  Delete "$SMPROGRAMS\NeoQC.lnk"
  SetShellVarContext current
  Delete "$DESKTOP\NeoQC.lnk"
  Delete "$SMPROGRAMS\NeoQC.lnk"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${else}
    SetShellVarContext current
  ${endif}
!macroend
