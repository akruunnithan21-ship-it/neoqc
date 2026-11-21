/*
  modules.js access rules, run in a small fake window (no Electron, no
  network). Covers 1.14's phone-only technicians (server v2.10): a phone-only
  technician below tier 3 opens nothing and has no home screen; the same
  roles without the flag still land on Service; a lead (tier 3+) is never
  locked out by the flag; a malformed flag never blocks anyone.

  Run: node tests/modules-access.test.js
*/
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'modules.js'), 'utf8');

function load(answer) {
  var store = {};
  var ctx = {
    console: { warn: function () {}, log: function () {}, error: function () {} },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise,
    currentProfile: null,
    supabaseClient: { rpc: function (name) {
      assert.strictEqual(name, 'my_modules');
      return Promise.resolve({ data: answer, error: null });
    } }
  };
  ctx.window = ctx;
  ctx.dispatchEvent = function () {};
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'modules.js' });
  return ctx;
}

async function as(profile, answer) {
  var ctx = load(answer);
  ctx.currentProfile = profile;
  await ctx.NeoQcModules.refreshAccess();
  return ctx.NeoQcModules;
}

var JAGATH = { id: 'u-jagath', full_name: 'Jagath', tier: 2, active: true };
var TECH = { service: 'tech', rma: null, qc: null, neohr: null, tier: 2,
             build_pool: false, service_pool: true, build_level: 'junior' };
function withFlag(base, v) { var o = JSON.parse(JSON.stringify(base)); o.phone_only = v; return o; }

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('phone-only technician: nothing opens, no home screen', async function () {
  var M = await as(JAGATH, withFlag(TECH, true));
  assert.strictEqual(M.phoneOnly(), true);
  assert.strictEqual(M.firstHome(), null);
  ['overview', 'service', 'rma', 'builds', 'bench', 'settings', 'staff', 'client'].forEach(function (id) {
    assert.strictEqual(M.canOpen(id), false, id + ' should not open for a phone-only technician');
  });
  // The roles and pool are still there (the phone app and assigning use them).
  assert.strictEqual(M.roleFor('service'), 'tech');
  assert.strictEqual(M.pools().service, true);
});

test('same roles without the flag still land on Service', async function () {
  var M = await as(JAGATH, TECH);
  assert.strictEqual(M.phoneOnly(), false);
  assert.strictEqual(M.firstHome(), 'service');
  assert.strictEqual(M.canOpen('service'), true);
  assert.strictEqual(M.canOpen('overview'), true);
});

test('flag false behaves like no flag', async function () {
  var M = await as(JAGATH, withFlag(TECH, false));
  assert.strictEqual(M.phoneOnly(), false);
  assert.strictEqual(M.firstHome(), 'service');
});

test('a malformed flag never blocks anyone', async function () {
  var vals = ['true', 1, 'yes', {}, null];
  for (var i = 0; i < vals.length; i++) {
    var M = await as(JAGATH, withFlag(TECH, vals[i]));
    assert.strictEqual(M.phoneOnly(), false, JSON.stringify(vals[i]));
    assert.strictEqual(M.firstHome(), 'service', JSON.stringify(vals[i]));
  }
});

test('tier 3+ is never phone-only on the desktop', async function () {
  var lead = { id: 'u-lead', full_name: 'Lead', tier: 3, active: true };
  var M = await as(lead, withFlag(TECH, true));
  assert.strictEqual(M.phoneOnly(), false);
  assert.strictEqual(M.firstHome(), 'overview');
  assert.strictEqual(M.canOpen('service'), true);
});

test('the flag is remembered on this PC (cached answer)', async function () {
  var ctx = load(withFlag(TECH, true));
  ctx.currentProfile = JAGATH;
  await ctx.NeoQcModules.refreshAccess();
  // The server then fails: the cached answer must still say phone-only.
  ctx.supabaseClient.rpc = function () { return Promise.resolve({ data: null, error: { message: 'offline' } }); };
  await ctx.NeoQcModules.refreshAccess();
  assert.strictEqual(ctx.NeoQcModules.accessSource(), 'cache');
  assert.strictEqual(ctx.NeoQcModules.phoneOnly(), true);
  assert.strictEqual(ctx.NeoQcModules.firstHome(), null);
});

(async function () {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); console.log('  ok   ' + tests[i].name); }
    catch (e) { failed++; console.log('  FAIL ' + tests[i].name + '\n       ' + (e && e.message)); }
  }
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  if (failed) process.exit(1);
})();
