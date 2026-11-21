/* Applies a theme the customer chose before the page paints (no flash). Tiny on purpose. */
(function () {
  try {
    var t = localStorage.getItem('neo-tracker:theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the device */ }
})();
