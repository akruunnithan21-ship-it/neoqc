/*
  Serves dashboard/ locally the way Netlify does (netlify.toml): /t/* opens the
  tracker, /staff/assets/* reads /assets/*, folders serve their index.html.
  No dependencies.

    node dev/serve-dashboard.js            → http://localhost:8090
    node dev/serve-dashboard.js 9000       → another port

  Sample tickets without the database: http://localhost:8090/?demo
*/
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'dashboard');
var PORT = Number(process.argv[2]) || 8090;
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function send(res, file) {
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(function (req, res) {
  var p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (/^\/t\//.test(p)) p = '/index.html';
  p = p.replace(/^\/staff\/assets\//, '/assets/');
  var file = path.normalize(path.join(ROOT, p));
  if (file.indexOf(ROOT) !== 0) { res.writeHead(403); res.end(); return; }
  fs.stat(file, function (err, st) {
    if (!err && st.isDirectory()) {
      if (!/\/$/.test(p)) { res.writeHead(301, { Location: p + '/' }); res.end(); return; }
      file = path.join(file, 'index.html');
    }
    send(res, file);
  });
}).listen(PORT, function () { console.log('dashboard on http://localhost:' + PORT + '  (sample tickets: /?demo)'); });
