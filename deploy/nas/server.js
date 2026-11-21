/*
  Neo Tokyo customer tracker: the web server on the NAS.

  Serves ./site (a copy of dashboard/) the way Netlify serves it (netlify.toml):
    /t/<code>          → index.html (tracking links)
    /staff/assets/*    → /assets/* (shared/ppi-sync.js loads them by relative path)
    /folder            → 301 to /folder/ (relative, so it works behind the tunnel)
    /folder/           → /folder/index.html
  with the same security headers, ETags, gzip for text, and long caching only
  for fonts and logos.

  Cloudflare's tunnel connector on the NAS reaches it at 127.0.0.1:8097 and
  publishes it as https://service.neotokyo.in. It listens on the loopback address
  only, so nothing on the network can reach it directly.

  No dependencies (Node 18+). Settings come from the environment:
    PORT (8097), HOST (127.0.0.1), SITE_DIR (./site)
  Files are read from disk on every request: replacing ./site updates the site
  without a restart.
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(process.env.SITE_DIR || path.join(__dirname, 'site'));
const PORT = Number(process.env.PORT) || 8097;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;

// The same headers netlify.toml sets for the public site.
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self' https://ggsxkhenzdhaachubrsc.supabase.co wss://ggsxkhenzdhaachubrsc.supabase.co https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=31536000'
};

// Pages and scripts are re-checked on every visit (cheap: ETag → 304), so a
// new copy of ./site shows at once. Fonts never change; logos rarely.
function cacheControl(p) {
  if (p.startsWith('/fonts/')) return 'public, max-age=31536000, immutable';
  if (p.startsWith('/brand/') || p.startsWith('/assets/')) return 'public, max-age=604800';
  return 'no-cache';
}

const gzipped = new Map();   // file → { etag, buf }

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY, headers || {}));
  res.end(body);
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  const url = new URL(req.url, 'http://local');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
  if (p.indexOf('\0') !== -1) return send(res, 400, 'Bad request');
  // Hidden files and folders (.git, .env, …) are never served.
  if (p.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');

  if (/^\/t\/[^/]+\/?$/.test(p)) p = '/index.html';
  p = p.replace(/^\/staff\/assets\//, '/assets/');

  const file = path.join(ROOT, path.normalize(p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found');

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!url.pathname.endsWith('/')) return send(res, 301, '', { Location: url.pathname + '/' + url.search });
      return serveFile(req, res, path.join(file, 'index.html'), p.endsWith('/') ? p + 'index.html' : p);
    }
    if (err) return send(res, 404, 'Not found');
    serveFile(req, res, file, p, st);
  });
}

function serveFile(req, res, file, p, known) {
  const go = (st) => {
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = Object.assign({}, SECURITY, {
      'Content-Type': type,
      'Cache-Control': cacheControl(p),
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString()
    });
    const compressible = COMPRESSIBLE.test(type) && st.size > 1024;
    if (compressible) headers.Vary = 'Accept-Encoding';
    // Neo Service (a desktop app, so another origin) reads this to learn the
    // site is up and switch its tracking links over.
    if (p === '/ping.json') { headers['Access-Control-Allow-Origin'] = '*'; headers['Cache-Control'] = 'no-store'; }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

    const wantsGzip = compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!wantsGzip) {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    const hit = gzipped.get(file);
    const finish = (buf) => {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    if (hit && hit.etag === etag) return finish(hit.buf);
    fs.readFile(file, (err, raw) => {
      if (err) return send(res, 500, 'Server error');
      zlib.gzip(raw, { level: 9 }, (zerr, buf) => {
        if (zerr) return send(res, 500, 'Server error');
        gzipped.set(file, { etag, buf });
        finish(buf);
      });
    });
  };
  if (known) return go(known);
  fs.stat(file, (err, st) => (err || !st.isFile()) ? send(res, 404, 'Not found') : go(st));
}

const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); else res.destroy(); }
});
server.headersTimeout = 20000;
server.requestTimeout = 30000;

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('No index.html in ' + ROOT + ' (set SITE_DIR, or copy the site there).');
  process.exit(1);
}
server.listen(PORT, HOST, () => console.log('Neo Tokyo tracker: serving ' + ROOT + ' on http://' + HOST + ':' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
