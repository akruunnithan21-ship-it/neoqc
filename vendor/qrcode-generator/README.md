# qrcode-generator 1.4.4

QR code generator by Kazuhiko Arase, MIT licence (see the header of `qrcode.js`).

- Source: npm `qrcode-generator@1.4.4`, `qrcode.js` copied unchanged.
- Package integrity (matches the npm registry):
  `sha512-HM7yY8O2ilqhmULxGMpcHSF1EhJJ9yBj8gvDEuZ6M+KGJ0YY2hKpnXvRD+hZPLrDVck3ExIGhmPtSdcjC+guuw==`
- Added 21 Nov 2026 with the owner's approval.

Loaded by `index.html` as a plain script (it defines the global `qrcode`). Used by
`shared/service-catalog.js` `qrSvg()` for the tracking QR on the QC report and
the delivery receipt. It runs offline; nothing is fetched at run time.
