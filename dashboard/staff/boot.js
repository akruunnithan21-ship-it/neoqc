/*
  Staff portal entry (/staff/). The customer tracker now lives at the site root,
  so a visit to /staff/ with no ?view= opens the staff side instead of the old
  customer page: ?view=login shows the sign-in to a signed-out visitor, and
  app.js sends a signed-in one to their usual start page (routeAfterWebLogin).
  Runs before ../app.js, which reads ?view= once at start-up.
*/
(function () {
  'use strict';
  try {
    var p = new URLSearchParams(location.search);
    var v = p.get('view');
    if (!v || v === 'customer' || v === 'service') {
      // The customer pages moved to the root: send those there, keeping a code.
      if (v === 'customer' || v === 'service') {
        var code = p.get('code');
        location.replace('/' + (code ? '?code=' + encodeURIComponent(code) : ''));
        return;
      }
      p.set('view', 'login');
      history.replaceState(null, '', location.pathname + '?' + p.toString() + location.hash);
    }
  } catch (e) { /* old browser: app.js falls back to its own default */ }
})();
