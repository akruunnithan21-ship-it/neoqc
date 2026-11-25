; Neo Service — NSIS additions, included by electron-builder (nsis.include).
;
; 1.16: the installer wears the Neo Glass theme (owner, 25 Nov 2026):
;   - build/installerSidebar.bmp (164x314, Night glass with the new Neo Tokyo
;     mark) on the welcome and finish pages, and the uninstaller's;
;   - build/installerHeader.bmp (150x57, light glass) on the inner pages;
;   - the app icon (assets/icon.ico) is the new mark.
; The "Installation Options" page (anyone / only me) is gone: electron-builder.json
; has nsis.perMachine = true, so Neo Service always installs for everyone on the
; PC, which the app needs anyway (it runs as administrator). An older "only for
; me" install is removed by electron-builder's installer before it installs.

; 1.16.1 (owner: "the installer looked sub par"): it was not DPI-aware, so on a
; 125–150 % display Windows stretched the whole window as a bitmap and every
; letter and image went soft. Now it draws at the screen's real resolution,
; and the sidebar / header bitmaps are 2x (328x628, 300x114), which MUI scales
; down to fit their controls (FitControl), so they stay sharp too.
ManifestDPIAware true

; The pages are Welcome → Installing → Finish (no folder page: electron-builder
; allowToChangeInstallationDirectory is off), and the finish page says it plainly.
!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TITLE "Neo Service is ready"
  !define MUI_FINISHPAGE_TEXT "Neo Service ${VERSION} is installed for everyone on this PC.$\r$\n$\r$\nSign in with your Neo Tokyo email and PIN."
  !define MUI_FINISHPAGE_RUN_TEXT "Open Neo Service now"
!endif

; A welcome page with the sidebar. Updates (--updated) skip it, like the
; directory page, so an auto-update shows only the progress.
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Neo Service"
  !define MUI_WELCOMEPAGE_TEXT "Neo Tokyo's service, RMA and QC desk.$\r$\n$\r$\nThis installs Neo Service ${VERSION} for everyone who uses this PC.$\r$\n$\r$\nClose Neo Service if it is open, then click Next."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; (1.13) The app was called "NeoQC" (and "Neo OS" inside) before 1.13. The
; installer creates "Neo Service" shortcuts, so the old "NeoQC" ones are removed
; here — otherwise an upgraded PC would show two icons, one of them stale.
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
