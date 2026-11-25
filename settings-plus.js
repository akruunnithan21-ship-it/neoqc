/*
  Neo Service 1.16.1: the Settings options that apply at once (owner, 25 Nov
  2026: "revamp the settings menu and make and create settings to make it
  functional and useful").

    Appearance   aurora (off / subtle / normal / vivid), backdrop dots, glass
                 blur (soft / normal / strong), interface size (90–125 %),
                 reduce motion. Themes and accent stay in app.js.
    General      start screen (app.js preferredHome reads startScreen)
    QC & Testing the bench's FPS recording length and switch-over time
                 (qc-bench.js reads qcFpsSeconds / qcFpsDelay)
    Updates      check for updates now, what's new, about this copy, the log
                 folder, restart

  Everything is kept with the rest of this PC's settings (appState.settings,
  saved by app.js saveDatabase) and applied at start-up (app.js calls
  NeoPrefs.apply() right after the theme).

  window.NeoPrefs = { apply, onOpen, get, set }
*/
(function () {
  'use strict';

  var DEFAULTS = {
    aurora: 'normal', dots: true, glass: 'normal', zoom: '1', reduceMotion: false,
    startScreen: 'auto', qcFpsSeconds: '60', qcFpsDelay: '10'
  };
  var CHOICES = {
    aurora: ['off', 'subtle', 'normal', 'vivid'],
    glass: ['soft', 'normal', 'strong'],
    zoom: ['0.9', '1', '1.1', '1.25'],
    startScreen: ['auto', 'overview', 'service', 'rma', 'staff'],
    qcFpsSeconds: ['30', '60', '120'],
    qcFpsDelay: ['5', '10', '15']
  };

  function settings() {
    try { if (typeof appState !== 'undefined' && appState) { if (!appState.settings) appState.settings = {}; return appState.settings; } }
    catch (e) { /* app.js not loaded (harness) */ }
    window.__ntSettings = window.__ntSettings || {};
    return window.__ntSettings;
  }
  function get(k) {
    var v = settings()[k];
    if (v === undefined || v === null) return DEFAULTS[k];
    if (CHOICES[k]) return CHOICES[k].indexOf(String(v)) !== -1 ? String(v) : DEFAULTS[k];
    return v;
  }
  function ipc() {
    try {
      if (typeof require !== 'function') return null;
      var e = require('electron');
      if (e && e.harness) return null;
      return e && e.ipcRenderer && typeof e.ipcRenderer.invoke === 'function' ? e.ipcRenderer : null;
    } catch (x) { return null; }
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else if (window.NeoQcUI && typeof window.NeoQcUI.toast === 'function') window.NeoQcUI.toast(msg, type || 'info');
  }

  function apply() {
    var b = document.body;
    if (!b) return;
    var aurora = get('aurora');
    ['off', 'subtle', 'vivid'].forEach(function (a) { b.classList.toggle('aurora-' + a, aurora === a); });
    b.classList.toggle('dots-off', get('dots') === false);
    var glass = get('glass');
    b.classList.toggle('glass-soft', glass === 'soft');
    b.classList.toggle('glass-strong', glass === 'strong');
    b.classList.toggle('motion-reduced', get('reduceMotion') === true);
    var z = Number(get('zoom')) || 1;
    try {
      var e = typeof require === 'function' ? require('electron') : null;
      if (e && e.webFrame && typeof e.webFrame.setZoomFactor === 'function') e.webFrame.setZoomFactor(z);
      else document.documentElement.style.zoom = z === 1 ? '' : String(z);
    } catch (x) { document.documentElement.style.zoom = z === 1 ? '' : String(z); }
  }

  async function set(k, v) {
    settings()[k] = v;
    apply();
    mark();
    try { if (typeof saveDatabase === 'function') await saveDatabase(); }
    catch (e) { console.warn('saving ' + k + ' failed:', e && e.message); }
  }

  // Mark the saved choices on the controls.
  function mark() {
    Array.prototype.forEach.call(document.querySelectorAll('.nt-seg[data-pref]'), function (seg) {
      var v = String(get(seg.getAttribute('data-pref')));
      Array.prototype.forEach.call(seg.querySelectorAll('button[data-v]'), function (btn) {
        var on = btn.getAttribute('data-v') === v;
        btn.classList.toggle('active', on);
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[type="checkbox"][data-pref]'), function (cb) {
      cb.checked = get(cb.getAttribute('data-pref')) === true;
    });
  }

  // ── Updates & about ───────────────────────────────────────────────────────
  function setUpdate(state, sub) {
    var a = document.getElementById('nt-update-state'), b = document.getElementById('nt-update-sub');
    if (a) a.textContent = state;
    if (b) b.textContent = sub || '';
  }
  async function fillAbout() {
    var dl = document.getElementById('nt-about');
    if (!dl) return;
    var i = ipc();
    var info = null;
    try { info = i ? await i.invoke('app:about') : null; } catch (e) { info = null; }
    if (!info) {
      info = { version: '(this window)', electron: '', chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '', node: '', os: navigator.platform };
    }
    var rows = [['Neo Service', info.version ? 'v' + info.version : ''], ['Electron', info.electron], ['Chromium', info.chrome],
      ['Node.js', info.node], ['Windows', info.os], ['This PC', info.computer], ['Data folder', info.dataFolder]];
    dl.textContent = '';
    rows.forEach(function (r) {
      if (!r[1]) return;
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
    setUpdate('Neo Service ' + (info.version ? 'v' + info.version : ''), info.packaged === false ? 'Development copy: updates are off.' : 'Press "Check for updates" to look for a newer version now.');
  }
  async function checkNow() {
    var i = ipc();
    var btn = document.getElementById('nt-btn-check-update');
    if (!i) { setUpdate('Not available here', 'Updates are checked in the installed app.'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    setUpdate('Checking for updates…', '');
    var r = null;
    try { r = await i.invoke('update:check-now'); } catch (e) { r = { ok: false, error: e.message }; }
    if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
    if (!r || !r.ok) { setUpdate('Could not check', (r && r.error) || 'Try again in a minute.'); return; }
    if (r.available) {
      setUpdate('Version ' + r.latest + ' is available', 'Click the update pill at the top of the window to download it, then restart.');
      toast('Neo Service ' + r.latest + ' is available. Use the pill at the top to download it.', 'info');
    } else {
      setUpdate('Neo Service is up to date', 'You have v' + (r.current || '') + ', the latest release.');
    }
  }

  function onOpen() {
    mark();
    fillAbout();
    var ops = document.getElementById('settings-ops'), none = document.getElementById('settings-ops-none');
    if (ops && none) none.classList.toggle('hidden', !ops.classList.contains('hidden'));
  }

  function bind() {
    var modal = document.getElementById('settings-modal');
    if (!modal || modal.dataset.ntPrefs) return;
    modal.dataset.ntPrefs = '1';
    modal.addEventListener('click', function (e) {
      var b = e.target.closest('.nt-seg[data-pref] button[data-v]');
      if (b) {
        var k = b.closest('.nt-seg').getAttribute('data-pref');
        set(k, b.getAttribute('data-v'));
        if (k === 'startScreen') toast('Start screen saved for this PC.', 'success');
        return;
      }
      var id = e.target.closest('button') ? e.target.closest('button').id : '';
      var i = ipc();
      if (id === 'nt-btn-check-update') checkNow();
      else if (id === 'nt-btn-whats-new') {
        modal.classList.remove('active');
        var cl = document.getElementById('changelog-modal');
        if (cl) cl.classList.add('active');
      } else if (id === 'nt-btn-open-logs') {
        if (i) i.invoke('app:open-logs').then(function (r) { if (r && !r.ok) toast('Could not open the log folder: ' + (r.error || ''), 'error'); });
        else toast('Not available here.', 'info');
      } else if (id === 'nt-btn-relaunch') {
        if (i) i.invoke('app:relaunch'); else location.reload();
      }
    });
    modal.addEventListener('change', function (e) {
      var cb = e.target;
      if (cb && cb.matches && cb.matches('input[type="checkbox"][data-pref]')) set(cb.getAttribute('data-pref'), !!cb.checked);
    });
    mark();
  }

  // Follow Windows' own "Animation effects" switch too.
  try {
    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    var follow = function () { if (document.body) document.body.classList.toggle('os-reduced-motion', mq.matches); };
    if (mq.addEventListener) mq.addEventListener('change', follow);
  } catch (e) { /* no matchMedia */ }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { bind(); apply(); });
  else { bind(); apply(); }

  window.NeoPrefs = { apply: apply, onOpen: onOpen, get: get, set: set };
})();
