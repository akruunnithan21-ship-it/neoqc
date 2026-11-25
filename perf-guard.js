/* 1.17.1 — smooth scrolling (owner, 25 Nov 2026: "scrolling through the app
   feels stuttery and sluggish").

   The aurora behind the glass (neo-theme.css .nt-aurora) drifts across the
   whole window, so while it moves every frame is a full-window redraw: the
   blurred titlebar, rail and navbar are blurred again each time. That is
   cheap on its own but competes with scrolling on laptop graphics.

   This pauses the drift while the user scrolls (it resumes 300 ms after the
   last scroll) and while the window is in the background. The drift is so
   slow (46–62 s per sweep) that the pause cannot be seen. Overlays pause it
   too, from CSS (neo-theme.css, the "Performance" block). */
(function () {
  'use strict';
  var aurora = null;
  var scrolling = false;
  var timer = 0;

  function el() {
    if (!aurora || !aurora.isConnected) aurora = document.querySelector('.nt-aurora');
    return aurora;
  }
  function set(cls, on) {
    var a = el();
    if (a) a.classList.toggle(cls, on);
  }
  function settle() {
    scrolling = false;
    set('nt-hold', false);
  }

  // One passive listener for every scroller (scroll does not bubble, capture does).
  document.addEventListener('scroll', function () {
    if (!scrolling) { scrolling = true; set('nt-hold', true); }
    clearTimeout(timer);
    timer = setTimeout(settle, 300);
  }, { capture: true, passive: true });

  // In the background (another window in front, or minimised): no drift.
  window.addEventListener('blur', function () { set('nt-away', true); });
  window.addEventListener('focus', function () { set('nt-away', false); });
  document.addEventListener('visibilitychange', function () { set('nt-away', document.hidden || !document.hasFocus()); });
  function initial() { if (!document.hasFocus()) set('nt-away', true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initial);
  else initial();
})();
