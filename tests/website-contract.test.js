/*
  The contract between Neo Service and the customer website.

  The website never talks to the app: it reads the database through three
  lookups (get_build_public, get_service_public, get_rma_public) and words
  repairs with the shared service-status module. This test fails when a change
  to Neo Service, the SQL or the shared files would make the website silently
  show less or the wrong thing, for example:
    - the build activity-log wording the build timeline is read from;
    - the build status names and their labels;
    - the QC field names the build lookup reads;
    - the fields the website reads from each lookup's answer;
    - the service and warranty stages the website's buttons refer to;
    - dashboard/shared/ falling behind shared/ (npm run sync-shared).

  Run: node tests/website-contract.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var APP = read('app.js');
var MAIN = read('main.js');
var DIAG = fs.readdirSync(path.join(ROOT, 'assets', 'diagnostics'))
  .filter(function (f) { return /\.(ps1|js)$/.test(f); })
  .map(function (f) { return read(path.join('assets', 'diagnostics', f)); }).join('\n');
var PRODUCERS = APP + '\n' + MAIN + '\n' + DIAG;
var BUILD_SQL = read('sql/tracker-build-public.sql');
var CORE = read('dashboard/tracker/tracker-core.js');
var PAGE = read('dashboard/tracker/tracker.js');

// The newest definition of a SQL function across the migrations, in version
// order (service-v2.sql, service-v2.1.sql … service-v2.10.sql, then the rest).
function latestFunctionBody(fn) {
  var files = fs.readdirSync(path.join(ROOT, 'sql'))
    .filter(function (f) { return /\.sql$/.test(f) && !/rollback|tests/.test(f); })
    .map(function (f) {
      var m = f.match(/^service-v2(?:\.(\d+))?\.sql$/);
      return { f: f, order: m ? Number(m[1] || 0) : 1000 };
    })
    .sort(function (a, b) { return a.order - b.order || a.f.localeCompare(b.f); });
  var body = null;
  files.forEach(function (x) {
    var sql = read(path.join('sql', x.f));
    var re = new RegExp('create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.' + fn + '\\s*\\(', 'gi');
    var m;
    while ((m = re.exec(sql))) {
      var start = sql.indexOf('$$', m.index);
      var end = sql.indexOf('$$', start + 2);
      if (start !== -1 && end !== -1) body = sql.slice(start, end);
    }
  });
  return body;
}
function returnedKeys(body) {
  var keys = {};
  var re = /'([a-z0-9_]+)'\s*,/g, m;
  while ((m = re.exec(body))) keys[m[1]] = true;
  return keys;
}
function missing(keys, wanted) { return wanted.filter(function (k) { return !keys[k]; }); }

// ── Builds: the activity log the timeline is read from ──────────────────────
test('the app still writes "Ticket created for …" (the Order confirmed step)', function () {
  assert.ok(/`Ticket created for \$\{/.test(APP), 'app.js no longer logs `Ticket created for ${…}`; update get_build_public\'s step patterns');
  assert.ok(BUILD_SQL.indexOf("'Ticket created for %'") !== -1);
});
test('the app still writes Status changed: "old" → "new" (every progress step)', function () {
  assert.ok(APP.indexOf('`Status changed: "${oldLabel}" → "${newLabel}"`') !== -1,
    'app.js changed the "Status changed" log line; get_build_public reads the new label from → "…"');
  assert.ok(BUILD_SQL.indexOf("'Status changed:%'") !== -1 && BUILD_SQL.indexOf('→ "([^"]+)"') !== -1);
});
test('the app still writes "Parts constraint resolved…" (the All parts arrived step)', function () {
  assert.ok(/`Parts constraint resolved/.test(APP), 'app.js changed the parts-arrived log line');
  assert.ok(BUILD_SQL.indexOf("'Parts constraint resolved%'") !== -1);
});

// ── Builds: status names and labels ─────────────────────────────────────────
var LABELS = (function () {
  var m = APP.match(/function getStatusLabelText\(status\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'getStatusLabelText() not found in app.js');
  var out = {}, re = /case '([a-z_]+)':\s*return '([^']+)'/g, c;
  while ((c = re.exec(m[1]))) out[c[1]] = c[2];
  return out;
})();
var SQL_LABELS = (function () {
  var out = {}, re = /when '([^']+)'\s+then '([a-z_]+)'/g, c;
  while ((c = re.exec(BUILD_SQL))) out[c[1]] = c[2];
  return out;
})();
test('every build status label the app logs maps back to its status in the SQL', function () {
  Object.keys(LABELS).forEach(function (key) {
    var label = LABELS[key].toLowerCase();
    assert.strictEqual(SQL_LABELS[label], key,
      'app label "' + LABELS[key] + '" (' + key + ') is not mapped in _build_status_from_label (sql/tracker-build-public.sql)');
  });
});
test('the website knows every build status the app uses', function () {
  var steps = (CORE.match(/var BUILD_STEPS = \[([\s\S]*?)\];/) || [])[1] || '';
  Object.keys(LABELS).forEach(function (key) {
    assert.ok(steps.indexOf("key: '" + key + "'") !== -1, 'tracker-core.js BUILD_STEPS has no "' + key + '"');
    assert.ok(new RegExp('\\b' + key + ':\\s*"').test(CORE) || new RegExp('\\b' + key + ":\\s*'").test(CORE),
      'tracker-core.js has no customer sentence for "' + key + '"');
  });
});

// ── Builds: QC fields the build lookup reads ────────────────────────────────
test('every QC field get_build_public reads is still written by Neo Service', function () {
  var fields = {}, re = /(?:v_d|v_cp|v_p95|v_ports|e|w)\s*(?:->>?\s*'[a-zA-Z0-9]+'\s*)*->>?\s*'([a-zA-Z0-9]+)'/g, m;
  while ((m = re.exec(BUILD_SQL))) fields[m[1]] = true;
  ['cpu', 'gpu', 'ram', 'storage', 'timestamp', 'event', 'temp', 'value', 'c'].forEach(function (k) { delete fields[k]; });
  var gone = Object.keys(fields).filter(function (k) { return PRODUCERS.indexOf(k) === -1; });
  assert.deepStrictEqual(gone, [], 'no longer written by app.js / main.js / assets/diagnostics: ' + gone.join(', '));
  ['cpuTempMax', 'componentPassport', 'prime95', 'portScan', 'eventLog'].forEach(function (k) {
    assert.ok(fields[k], 'expected the test to see ' + k + ' in get_build_public');
  });
});

// ── What the website reads from each lookup ─────────────────────────────────
test('get_build_public returns every field the website reads', function () {
  var keys = returnedKeys(latestFunctionBody('get_build_public'));
  assert.deepStrictEqual(missing(keys, ['code', 'full', 'status', 'type', 'first_name', 'technician', 'created_at',
    'deadline', 'completed_at', 'parts_waiting', 'steps', 'qc', 'at', 'step', 'cpu_temp_max', 'gpu_temp_max',
    'ram_stress', 'cinebench', 'prime95', 'ports', 'cpu_temps', 'locked']), []);
});
test('get_service_public returns every field the website reads', function () {
  var body = latestFunctionBody('get_service_public');
  assert.ok(body, 'get_service_public not found in sql/');
  assert.deepStrictEqual(missing(returnedKeys(body), ['public_code', 'stage', 'stage_since', 'waiting_party', 'device_label',
    'job_kind', 'customer_name', 'promised_at', 'outcome', 'handled_by', 'created_at', 'received_at', 'service_type',
    'visit_start', 'visit_end', 'events', 'at', 'body', 'to_stage', 'rma_units', 'label', 'kind', 'return_method',
    'disposition', 'holds_ticket']), []);
});
test('get_rma_public returns every field the website reads', function () {
  var body = latestFunctionBody('get_rma_public');
  assert.ok(body, 'get_rma_public not found in sql/');
  assert.deepStrictEqual(missing(returnedKeys(body), ['public_code', 'label', 'kind', 'stage', 'stage_since', 'created_at',
    'received_at', 'return_method', 'disposition', 'vendor_result', 'waiting_party', 'expected_back_at', 'handled_by',
    'linked_job_code', 'events', 'at', 'body', 'to_stage']), []);
});

// ── Repairs and warranty parts: stages the website refers to by name ───────
test('every repair and warranty stage the website names still exists', function () {
  var S = require(path.join(ROOT, 'shared', 'service-status.js'));
  ['logged', 'received', 'quoted', 'ready', 'closed', 'work_done', 'resolved', 'scheduled', 'en_route',
    'session_booked', 'revisit_needed', 'approved', 'diagnosing', 'in_service', 'verifying'].forEach(function (k) {
    assert.ok(S.STAGES[k], 'shared/service-status.js has no repair stage "' + k + '"');
  });
  ['logged', 'with_vendor', 'ready_to_return', 'closed'].forEach(function (k) {
    assert.ok(S.RMA_STAGES[k], 'shared/service-status.js has no warranty stage "' + k + '"');
  });
  ['ballOf', 'waitingSentence', 'daysInStage', 'rmaBallOf', 'rmaCustomerLabel', 'rmaWaitingSentence', 'ticketWithUnits']
    .forEach(function (fn) { assert.strictEqual(typeof S[fn], 'function', 'shared/service-status.js lost ' + fn + '()'); });
  ['quoted', 'ready', 'ready_to_return', 'work_done', 'resolved'].forEach(function (k) {
    assert.ok(PAGE.indexOf("'" + k + "'") !== -1, 'tracker.js no longer handles "' + k + '"');
  });
});

// ── The website's copy of the shared files ──────────────────────────────────
test('dashboard/shared/ matches shared/ (run npm run sync-shared before pushing)', function () {
  var behind = fs.readdirSync(path.join(ROOT, 'shared')).filter(function (f) {
    var b = path.join(ROOT, 'dashboard', 'shared', f);
    return !fs.existsSync(b) || fs.readFileSync(b, 'utf8') !== read(path.join('shared', f));
  });
  assert.deepStrictEqual(behind, [], 'out of date in dashboard/shared: ' + behind.join(', '));
});

console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
