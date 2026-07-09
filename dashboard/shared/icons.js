/*
  Neo QC — shared SVG icon set for the benchmarking/stress-test section.
  Extends the existing .stb-icon pattern (index.html Settings tab nav):
  20x20 viewBox, single <path>, fill="currentColor" so color is controlled
  entirely by the wrapping element's CSS (see dr-status-* classes in
  diagnostics-tokens.css).

  Plain browser global (no module system) so it can be loaded via a single
  <script src="shared/icons.js"> in both the Electron app and the dashboard.
*/
(function (global) {
  var ICONS = {
    cpu: 'M7 2a1 1 0 00-1 1v1H5a2 2 0 00-2 2v1H2a1 1 0 100 2h1v2H2a1 1 0 100 2h1v1a2 2 0 002 2h1v1a1 1 0 102 0v-1h2v1a1 1 0 102 0v-1h1a2 2 0 002-2v-1h1a1 1 0 100-2h-1V9h1a1 1 0 100-2h-1V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H8V3a1 1 0 00-1-1zM6 6h8v8H6V6z',
    gpu: 'M3 5a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm2 0v7h10V5H5zm1 9a1 1 0 000 2h2a1 1 0 100-2H6zm6 0a1 1 0 100 2h2a1 1 0 100-2h-2zM7 7h2v3H7V7zm4 0h2v3h-2V7z',
    ram: 'M3 4a1 1 0 011-1h12a1 1 0 011 1v2h1a1 1 0 110 2h-1v1h1a1 1 0 110 2h-1v1h1a1 1 0 110 2h-1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm3 2v9h2V6H6zm4 0v9h2V6h-2z',
    storage: 'M4 4a2 2 0 012-2h8a2 2 0 012 2v3a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 1v1h1V5H6zm0 8a2 2 0 012-2h4a2 2 0 012 2v3a2 2 0 01-2 2H8a2 2 0 01-2-2v-3zm2 1v1h1v-1H8z',
    thermometer: 'M10 2a2 2 0 00-2 2v7.17a3.5 3.5 0 102.5.03V4a.5.5 0 00-.5-.5.5.5 0 00-.5.5v7a1 1 0 11-1 0V4a2 2 0 012-2h.5a2 2 0 012 2v6.68a3.5 3.5 0 11-3 .02V4a2 2 0 00-2-2h1z',
    torture: 'M10 2c.3 2 .1 3.2-1 4.4C7.8 7.8 7 9.2 7 11a3 3 0 003 3c.2 0 .3 0 .5 0-1-.7-1.5-1.6-1.5-2.7 0-1.1.6-1.8 1.3-2.6.9-1 1.7-2 1.7-3.7 1.8 1.5 3 3.9 3 6.3a5 5 0 01-10 0c0-3.5 1.8-6.3 5-9.3z',
    port: 'M6 3a1 1 0 00-1 1v2H4a1 1 0 00-1 1v3a3 3 0 003 3v2a1 1 0 001 1h4a1 1 0 001-1v-2a3 3 0 003-3V7a1 1 0 00-1-1h-1V4a1 1 0 00-1-1H9a1 1 0 00-1 1v2H8V4a1 1 0 00-1-1H6z',
    rgb: 'M10 2a8 8 0 100 16 1.5 1.5 0 001.5-1.5c0-.4-.15-.75-.4-1.03-.25-.28-.4-.6-.4-.97 0-.83.67-1.5 1.5-1.5H13.5A4.5 4.5 0 0018 8.5C18 4.9 14.4 2 10 2zM6 9a1.25 1.25 0 110-2.5A1.25 1.25 0 016 9zm3-3.5A1.25 1.25 0 119 3a1.25 1.25 0 010 2.5zm5 3A1.25 1.25 0 1114 6a1.25 1.25 0 010 2.5zM7 13a1.25 1.25 0 110-2.5A1.25 1.25 0 017 13z',
    check: 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.7a1 1 0 00-1.4-1.4L9 10.17l-1.3-1.3a1 1 0 00-1.4 1.42l2 2a1 1 0 001.4 0l4-4z',
    warning: 'M8.26 3.1c.7-1.4 2.78-1.4 3.48 0l6.4 12.8c.63 1.27-.3 2.75-1.74 2.75H3.6c-1.44 0-2.37-1.48-1.74-2.75l6.4-12.8zM10 7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1zm0 8a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2z',
    fail: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.28a1 1 0 00-1.41 1.41L8.59 10l-1.72 1.72a1 1 0 101.41 1.41L10 11.41l1.72 1.72a1 1 0 001.41-1.41L11.41 10l1.72-1.72a1 1 0 00-1.41-1.41L10 8.59 8.28 7.28z',
    unverified: 'M10 18a8 8 0 100-16 8 8 0 000 16zm0-11.5a1.75 1.75 0 00-1.75 1.75 1 1 0 11-2 0A3.75 3.75 0 1110.9 11.6c-.4.24-.65.44-.65.9v.25a1 1 0 11-2 0V12.4c0-1.3.85-1.94 1.5-2.33.55-.33.9-.6.9-1.32A1.75 1.75 0 0010 6.5zM10 15.5a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2z',
    'price-tag': 'M4 4a1 1 0 011-1h5.17a2 2 0 011.42.59l6 6a2 2 0 010 2.82l-5.17 5.17a2 2 0 01-2.82 0l-6-6A2 2 0 013 10.17V5a1 1 0 011-1zm3 3a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
    bottleneck: 'M6 5a3 3 0 013-3h1a1 1 0 110 2H9a1 1 0 00-1 1v2h4V5a1 1 0 00-1-1h-1a1 1 0 110-2h1a3 3 0 013 3v2h1a1 1 0 110 2h-1v2a3 3 0 01-3 3h-1a1 1 0 110-2h1a1 1 0 001-1v-2H8v2a1 1 0 001 1h1a1 1 0 110 2H9a3 3 0 01-3-3v-2H5a1 1 0 110-2h1V5z',
    target: 'M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a5 5 0 100 10 5 5 0 000-10zm0 3a2 2 0 100 4 2 2 0 000-4z',
    'refresh': 'M4.5 8a5.5 5.5 0 019.7-3.5.75.75 0 01-1.15.96A4 4 0 106 10a.75.75 0 010 1.5A5.5 5.5 0 014.5 8zm10.6-1.5H12.5a.75.75 0 010-1.5h4a.75.75 0 01.75.75v4a.75.75 0 01-1.5 0V6.5z'
  };

  function iconSvg(name, extraClass) {
    var path = ICONS[name] || ICONS.unverified;
    var cls = 'dr-icon' + (extraClass ? ' ' + extraClass : '');
    return '<svg class="' + cls + '" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  var api = { ICONS: ICONS, iconSvg: iconSvg };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.NeoQcIcons = api;
  }
})(typeof window !== 'undefined' ? window : this);
