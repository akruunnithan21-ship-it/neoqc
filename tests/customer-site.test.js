/*
  Tests for the customer-website setting in shared/service-catalog.js:
  trackLink, canTrackByLink, checkCustomerSite, qrSvg (1.14.1).
  Run: node tests/customer-site.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');

var failures = 0, passed = 0, pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(function () { passed++; }, function (e) {
    failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e));
  }));
}
// A fresh copy of the module each time (it keeps the switch in a variable).
function fresh() {
  var p = path.join(__dirname, '..', 'shared', 'service-catalog.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}
function fakeFetch(answer) {
  return function () {
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ ok: answer.ok !== false, json: function () { return Promise.resolve(answer.body); } });
  };
}

test('before the switch: the old address, unchanged', function () {
  var C = fresh();
  assert.strictEqual(C.customerSiteLive(), false);
  assert.strictEqual(C.trackLink('NT-4K7Q2M9X'), 'https://neoqctracker.netlify.app/?view=service&code=NT-4K7Q2M9X');
  assert.strictEqual(C.trackLink(' RM-7H2D4L9C '), 'https://neoqctracker.netlify.app/?view=service&code=RM-7H2D4L9C');
});
test('before the switch: build codes cannot open by link, NT/RM can', function () {
  var C = fresh();
  assert.strictEqual(C.canTrackByLink('7F3A2C'), false);
  assert.strictEqual(C.canTrackByLink('NT-4K7Q2M9X'), true);
  assert.strictEqual(C.canTrackByLink('rm-7h2d4l9c'), true);
});
test('after the switch: /t/ links on service.neotokyo.in for every code', function () {
  var C = fresh();
  C.setCustomerSiteLive(true);
  assert.strictEqual(C.trackLink('7f3a2c'), 'https://service.neotokyo.in/t/7F3A2C');
  assert.strictEqual(C.trackLink('NT-4K7Q2M9X'), 'https://service.neotokyo.in/t/NT-4K7Q2M9X');
  assert.strictEqual(C.canTrackByLink('7F3A2C'), true);
});
test('the WhatsApp footer follows the setting', function () {
  var C = fresh();
  C.setCustomerSiteLive(true);
  var job = { public_code: 'NT-4K7Q2M9X', customer_name: 'Fathima Rahman', stage: 'received', device_label: 'Laptop' };
  var t = C.WA_TEMPLATES && Object.keys(C.WA_TEMPLATES)[0];
  if (t && typeof C.WA_TEMPLATES[t] === 'function') {
    var msg = String(C.WA_TEMPLATES[t](job) || '');
    if (msg.indexOf('Track it here') !== -1) assert.ok(msg.indexOf('https://service.neotokyo.in/t/NT-4K7Q2M9X') !== -1, msg);
  }
});
test('checkCustomerSite: the real answer switches links on', function () {
  var C = fresh();
  return C.checkCustomerSite(fakeFetch({ body: { site: 'neo-service' } })).then(function (live) {
    assert.strictEqual(live, true);
    assert.strictEqual(C.customerSiteLive(), true);
  });
});
test('checkCustomerSite: a different site, an error page or no network change nothing', function () {
  var C = fresh();
  return C.checkCustomerSite(fakeFetch({ body: { site: 'something-else' } }))
    .then(function (live) { assert.strictEqual(live, false); return C.checkCustomerSite(fakeFetch({ ok: false, body: null })); })
    .then(function (live) { assert.strictEqual(live, false); return C.checkCustomerSite(fakeFetch(new Error('offline'))); })
    .then(function (live) { assert.strictEqual(live, false); assert.strictEqual(C.customerSiteLive(), false); });
});
test('checkCustomerSite: once live, an outage does not flip links back', function () {
  var C = fresh();
  C.setCustomerSiteLive(true);
  return C.checkCustomerSite(fakeFetch(new Error('offline'))).then(function (live) { assert.strictEqual(live, true); });
});
test('qrSvg: empty without the QR library, so callers print the link alone', function () {
  var C = fresh();
  assert.strictEqual(C.qrSvg('https://service.neotokyo.in/t/7F3A2C'), '');
});
test('qrSvg: with vendor/qrcode-generator, a scalable SVG of the link', function () {
  // As in the app: the library is a page global the catalogue looks up.
  var hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  globalThis.window = globalThis;
  globalThis.qrcode = require(path.join(__dirname, '..', 'vendor', 'qrcode-generator', 'qrcode.js'));
  try {
    var C = fresh();
    var svg = C.qrSvg('https://service.neotokyo.in/t/7F3A2C');
    assert.ok(/^<svg[^>]*viewBox="0 0 \d+ \d+"/.test(svg), svg.slice(0, 120));
    assert.ok(!/ width="\d+px"/.test(svg.slice(0, 200)), 'scalable: no fixed size');
    assert.ok(/<path /.test(svg) || /<rect /.test(svg), 'has modules');
    if (process.env.QR_OUT) require('fs').writeFileSync(process.env.QR_OUT, svg);
  } finally {
    delete globalThis.qrcode;
    if (!hadWindow) delete globalThis.window;
  }
});

Promise.all(pending).then(function () {
  console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
});
