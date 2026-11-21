/*
  Service worker for the customer tracker: the page shell opens offline and
  repeat visits are instant. Ticket data is NEVER cached here (it goes to the
  Supabase origin, which this worker does not touch), and the staff portal
  (/staff/) is left entirely to the network.
  Bump VERSION when the shell's files change so old copies are dropped.
*/
'use strict';

var VERSION = 'tracker-v1';
var SHELL = [
  '/',
  '/tracker/tracker.css',
  '/tracker/theme-boot.js',
  '/tracker/config.js',
  '/tracker/tracker-core.js',
  '/tracker/tracker.js',
  '/shared/service-status.js',
  '/fonts/outfit-latin-wght-normal.woff2',
  '/fonts/outfit-latin-ext-wght-normal.woff2',
  '/fonts/league-spartan-latin-ext-wght-normal.woff2',
  '/brand/favicon.svg',
  '/brand/icon-192.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // Supabase, fonts CDN: network only
  if (url.pathname.indexOf('/staff') === 0) return;           // the staff portal: network only

  // Pages (/, /t/CODE): network first so a new release shows at once; the
  // cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(function () { return caches.match('/'); }));
    return;
  }

  // Shell files: answer from the cache, refresh it in the background.
  e.respondWith(caches.open(VERSION).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
