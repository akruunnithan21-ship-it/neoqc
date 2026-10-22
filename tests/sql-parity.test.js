/*
  SQL ↔ JS parity: sql/service-v2.sql against shared/service-status.js and
  the demo fixtures in shared/service-demo.js.
  Run: node tests/sql-parity.test.js   — exits 1 on any failure.

  The server decides (svc_stage_legal, rma_transition_ok, the CHECKs, the
  _vocab lists, the label helpers); the shared model only decides which
  buttons to draw and what to say. Two copies of a rule diverge unless
  something compares them, so this reads the SQL text — no database — and
  compares every list the two sides share:

    - svc_stage_legal            ↔ STAGES_BY_TYPE
    - rma_transition_ok          ↔ RMA_TRANSITIONS
    - _vocab_list(...)           ↔ the vocab tables (TYPES, RMA_ORDER, …)
    - column CHECK (x in (...))  ↔ the same tables (last definition wins:
                                   a later ALTER replaces the CREATE's list)
    - _svc_stage_label & co.     ↔ the staff / customer labels
    - pre-return stage lists     ↔ RMA_PRE_RETURN (A2/A8)
    - _rma_gate_problems         ↔ the A11 / A12 gate rules
    - table columns              ↔ the demo rows (they claim to be `select *`)
    - norm_phone() / phone_ok()  ↔ NeoQcCatalog.normPhone / isValidPhone
                                   (A1': both RUN on the same inputs, via
                                   tests/sql-eval.js)

  The database is sql/service-v2.sql with every follow-up migration applied
  on top (sql/service-v2.1.sql, then sql/work-queue.sql = v2.2, …), so by
  default this reads them as ONE text, in version order: a later create or
  replace / ALTER wins, exactly as in the database (v2.1 widens
  _vocab_list('data_consent') and the column CHECK; v2.2 widens
  service_jobs.assigned_via and redefines my_modules / service_tech_list /
  service_claim / service_create; the last definition is the one compared).

  v2.2 (the work queue) adds its own invariants: the redefined v2 functions
  keep their signatures and every key; no new function reaches anon; every
  new table is select-only for clients; the eligibility sentences, costs and
  the 4 h / 30 min clock match shared/work-queue.js.

  NeoHR 2.1 (neo_dashboard, same file): the SQL port of the service status
  model — _svc_ball / _svc_budget_in / _svc_risk_ms / _rma_ball /
  _rma_budget_days / _rma_risk_ms — is RUN against ballOf / BUDGET_BY_TYPE /
  serviceRisk / rmaBallOf / rmaBudgetDays / rmaRisk on a grid of inputs
  (tests/sql-eval.js); the row-level composition (_svc_state ↔
  ticketWithUnits) runs on PGlite in the scratchpad's pgtest/dash22.mjs.

  Pass paths to check other copies: node tests/sql-parity.test.js v2.sql v2.1.sql
  (those files, in that order, nothing else appended).
*/
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var S = require(path.join(__dirname, '..', 'shared', 'service-status.js'));
var C = require(path.join(__dirname, '..', 'shared', 'service-catalog.js'));
var Demo = require(path.join(__dirname, '..', 'shared', 'service-demo.js'));

var SQL_PATH = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'sql', 'service-v2.sql');
// The follow-ups, oldest first: service-v2.1.sql, work-queue.sql (which is
// v2.2), service-v2.3.sql, … (never a .tests.sql or the optional
// work-queue-cron.sql). Versions sort as numbers, so 2.10 comes after 2.9.
var NAMED_FOLLOW_UPS = { 'work-queue.sql': 2 };
function followUps() {
  if (process.argv[2]) return [];
  var dir = path.dirname(SQL_PATH);
  return fs.readdirSync(dir)
    .map(function (f) {
      var m = /^service-v2\.(\d+)\.sql$/.exec(f);
      if (m) return { f: f, n: Number(m[1]) };
      return Object.prototype.hasOwnProperty.call(NAMED_FOLLOW_UPS, f) ? { f: f, n: NAMED_FOLLOW_UPS[f] } : null;
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.n - b.n || (a.f < b.f ? -1 : 1); })
    .map(function (x) { return path.join(dir, x.f); });
}
var SQL_PATHS = process.argv.length > 3
  ? process.argv.slice(2).map(function (p) { return path.resolve(p); })
  : [SQL_PATH].concat(followUps());
var RAW = SQL_PATHS.map(function (p) { return fs.readFileSync(p, 'utf8'); }).join('\n');

var failures = 0, passed = 0, warnings = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}
function warn(msg) { warnings.push(msg); }

// ── reading the SQL ─────────────────────────────────────────────────────────

// Comments out, strings and newlines kept (so positions still map to lines).
function stripComments(s) {
  var out = '', i = 0, n = s.length, inStr = false;
  while (i < n) {
    var c = s.charAt(i);
    if (inStr) {
      out += c;
      if (c === "'") {
        if (s.charAt(i + 1) === "'") { out += "'"; i += 2; continue; }
        inStr = false;
      }
      i++;
      continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && s.charAt(i + 1) === '-') {
      while (i < n && s.charAt(i) !== '\n') i++;
      continue;
    }
    if (c === '/' && s.charAt(i + 1) === '*') {
      var e = s.indexOf('*/', i + 2);
      var chunk = s.slice(i, e === -1 ? n : e + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = e === -1 ? n : e + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
var SQL = stripComments(RAW);

function lineAt(pos) { return SQL.slice(0, pos).split('\n').length; }

// The body of the LAST definition of a function (a later create or replace
// wins). `text` defaults to the whole (concatenated) SQL.
function fnBody(name, text) {
  var src = text == null ? SQL : text;
  var re = new RegExp('create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?' + name + '\\s*\\(', 'gi');
  var m, last = -1;
  while ((m = re.exec(src)) !== null) last = m.index;
  if (last === -1) return null;
  var a = src.indexOf('$$', last);
  if (a === -1) return null;
  var b = src.indexOf('$$', a + 2);
  if (b === -1) return null;
  return src.slice(a + 2, b);
}

function strings(seg) {
  var re = /'((?:[^']|'')*)'/g, m, out = [];
  while ((m = re.exec(seg)) !== null) out.push(m[1].replace(/''/g, "'"));
  return out;
}
function cutElse(seg) {
  var i = seg.search(/\belse\b/i);
  return i === -1 ? seg : seg.slice(0, i);
}

// Every arm `when 'key' then …` of a CASE on the function's argument, as
// { key → text up to the next such arm }. Inner CASEs on another column
// (`when p_return_method = 'collect' then …`) stay inside their arm.
function caseArms(body) {
  var out = {};
  if (body == null) return null;
  var re = /\bwhen\s+'([a-z0-9_]+)'\s+then\b/gi, m, hits = [];
  while ((m = re.exec(body)) !== null) hits.push({ key: m[1], start: m.index, end: re.lastIndex });
  hits.forEach(function (h, i) {
    out[h.key] = body.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : body.length);
  });
  return out;
}
function caseLists(name, text) {
  var arms = caseArms(fnBody(name, text));
  if (!arms) return null;
  var out = {};
  Object.keys(arms).forEach(function (k) { out[k] = strings(cutElse(arms[k])); });
  return out;
}
function caseLabels(name) {
  var arms = caseArms(fnBody(name));
  if (!arms) return null;
  var out = {};
  Object.keys(arms).forEach(function (k) { out[k] = strings(arms[k])[0]; });
  return out;
}

function closeParen(s, open) {
  var depth = 0, inStr = false;
  for (var i = open; i < s.length; i++) {
    var c = s.charAt(i);
    if (inStr) {
      if (c === "'") { if (s.charAt(i + 1) === "'") { i++; continue; } inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function stmtEnd(s, from) {
  var inStr = false;
  for (var i = from; i < s.length; i++) {
    var c = s.charAt(i);
    if (inStr) {
      if (c === "'") { if (s.charAt(i + 1) === "'") { i++; continue; } inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === ';') return i;
  }
  return s.length;
}
function splitTop(s) {
  var out = [], depth = 0, inStr = false, cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (inStr) {
      cur += c;
      if (c === "'") { if (s.charAt(i + 1) === "'") { cur += "'"; i++; continue; } inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Regions of the file that belong to one table: CREATE TABLE bodies and
// ALTER TABLE statements, in file order.
var REGIONS = [];
(function () {
  var re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi, m;
  while ((m = re.exec(SQL)) !== null) {
    var open = re.lastIndex - 1;
    var close = closeParen(SQL, open);
    if (close !== -1) REGIONS.push({ table: m[1].toLowerCase(), start: open, end: close, kind: 'create', body: SQL.slice(open + 1, close) });
  }
  re = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\b/gi;
  while ((m = re.exec(SQL)) !== null) {
    var end = stmtEnd(SQL, re.lastIndex);
    REGIONS.push({ table: m[1].toLowerCase(), start: m.index, end: end, kind: 'alter', body: SQL.slice(re.lastIndex, end) });
  }
  REGIONS.sort(function (a, b) { return a.start - b.start; });
})();

// table.column → { list, line } from `check (… column in ('a','b') …)`.
// The last definition in the file wins, like the database's final state.
var CHECKS = {};
REGIONS.forEach(function (r) {
  var re = /\bcheck\s*\(/gi, m;
  while ((m = re.exec(r.body)) !== null) {
    var open = re.lastIndex - 1;
    var close = closeParen(r.body, open);
    if (close === -1) continue;
    var expr = r.body.slice(open + 1, close);
    var inRe = /\(?\b([a-z_][a-z0-9_]*)\)?(?:::[a-z ]+)?\s+in\s*\(([^()]*)\)/gi, x;
    while ((x = inRe.exec(expr)) !== null) {
      var col = x[1].toLowerCase();
      if (col === 'not') continue;              // `… not in (…)` is a different rule
      var before = expr.slice(0, x.index);
      if (/\bnot\s*$/i.test(before)) continue;
      CHECKS[r.table + '.' + col] = { list: strings(x[2]), line: lineAt(r.start), pos: r.start };
    }
  }
});

// The v1 tables' enumeration CHECKs are built at migration time from a
// values list — ('service_jobs', 'stage', true, array['logged', …]) — folded
// with whatever the live table had (never narrower). The v2 list is the
// contract, so that list is what the JS must match.
(function () {
  var re = /\(\s*'([a-z_][a-z0-9_]*)'\s*,\s*'([a-z_][a-z0-9_]*)'\s*,\s*(?:true|false)\s*,\s*array\s*\[([^\]]*)\]\s*\)/gi, m;
  var found = [];
  while ((m = re.exec(SQL)) !== null) found.push({ key: m[1].toLowerCase() + '.' + m[2].toLowerCase(), list: strings(m[3]), pos: m.index });
  found.forEach(function (f) {
    var prev = CHECKS[f.key];
    // Only when nothing later in the file says otherwise.
    if (!prev || prev.pos < f.pos) CHECKS[f.key] = { list: f.list, line: lineAt(f.pos), pos: f.pos };
  });
})();

// table → [columns] for the tables this file creates, with later ADD/DROP COLUMN.
var NOT_COLUMNS = { constraint: 1, primary: 1, unique: 1, check: 1, foreign: 1, exclude: 1, like: 1 };
var COLUMNS = {}, ADDED = {};
REGIONS.forEach(function (r) {
  if (r.kind === 'create') {
    var cols = [];
    splitTop(r.body).forEach(function (item) {
      var w = /^\s*"?([a-z_][a-z0-9_]*)"?/i.exec(item);
      if (w && !NOT_COLUMNS[w[1].toLowerCase()]) cols.push(w[1].toLowerCase());
    });
    if (!COLUMNS[r.table]) COLUMNS[r.table] = cols;
    else cols.forEach(function (c) { if (COLUMNS[r.table].indexOf(c) === -1) COLUMNS[r.table].push(c); });
  } else {
    var re = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi, m;
    while ((m = re.exec(r.body)) !== null) {
      var c = m[1].toLowerCase();
      (ADDED[r.table] = ADDED[r.table] || []).push(c);
      if (COLUMNS[r.table] && COLUMNS[r.table].indexOf(c) === -1) COLUMNS[r.table].push(c);
    }
    re = /\bdrop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
    while ((m = re.exec(r.body)) !== null) {
      var dc = m[1].toLowerCase();
      if (COLUMNS[r.table]) COLUMNS[r.table] = COLUMNS[r.table].filter(function (x) { return x !== dc; });
    }
  }
});

// ── comparing ───────────────────────────────────────────────────────────────

function keysOf(v) { return Array.isArray(v) ? v.slice() : Object.keys(v); }
function sameSet(sqlList, jsList, label) {
  var a = sqlList.slice().sort(), b = jsList.slice().sort();
  var onlySql = a.filter(function (x) { return b.indexOf(x) === -1; });
  var onlyJs = b.filter(function (x) { return a.indexOf(x) === -1; });
  var dupes = sqlList.filter(function (x, i) { return sqlList.indexOf(x) !== i; });
  assert.ok(!onlySql.length && !onlyJs.length && !dupes.length,
    label + ':' + (onlySql.length ? ' only in SQL [' + onlySql.join(', ') + ']' : '') +
    (onlyJs.length ? ' only in JS [' + onlyJs.join(', ') + ']' : '') +
    (dupes.length ? ' repeated in SQL [' + dupes.join(', ') + ']' : ''));
}

// ═══ Rules ═══════════════════════════════════════════════════════════════

test('svc_stage_legal ↔ STAGES_BY_TYPE', function () {
  var sql = caseLists('svc_stage_legal');
  assert.ok(sql, 'svc_stage_legal not found in ' + SQL_PATH);
  sameSet(Object.keys(sql), Object.keys(S.STAGES_BY_TYPE), 'service types');
  Object.keys(S.STAGES_BY_TYPE).forEach(function (t) { sameSet(sql[t] || [], S.STAGES_BY_TYPE[t], 'svc_stage_legal ' + t); });
});

test('rma_transition_ok ↔ RMA_TRANSITIONS (A8 with_tech, A10 with_vendor → returning)', function () {
  var sql = caseLists('rma_transition_ok');
  assert.ok(sql, 'rma_transition_ok not found');
  Object.keys(sql).forEach(function (from) { assert.ok(S.RMA_TRANSITIONS[from], 'SQL has moves from "' + from + '", JS does not'); });
  Object.keys(S.RMA_TRANSITIONS).forEach(function (from) {
    sameSet(sql[from] || [], S.RMA_TRANSITIONS[from], 'rma_transition_ok from ' + from);
  });
});

// _vocab_list name → the JS table it mirrors. The aliases cover names the
// amendments did not fix (A9's mode list, A11's data list).
var VOCAB = {
  service_type: S.TYPES, channel: S.CHANNELS, category: S.CATEGORIES, priority: S.PRIORITIES,
  data_consent: S.DATA_CONSENTS, remote_tool: S.REMOTE_TOOLS, item_kind: S.ITEM_KINDS,
  purchase_source: S.PURCHASE_SOURCES, outcome: S.OUTCOMES, svc_stage: S.STAGE_ORDER,
  rma_source: S.RMA_SOURCES, sender_kind: S.SENDER_KINDS, diagnosed_by: S.DIAGNOSED_BY,
  return_method: S.RETURN_METHODS, vendor_result: S.RMA_VENDOR_RESULTS, fee_status: S.FEE_STATUSES,
  disposition: S.RMA_DISPOSITIONS, rma_stage: S.RMA_ORDER, media_role: S.MEDIA_ROLES, vendor_kind: S.VENDOR_KINDS
};
var VOCAB_OPTIONAL = {
  data_handling: S.DATA_HANDLING, rma_data_handling: S.DATA_HANDLING,
  ship_mode: S.SHIPMENT_MODES, shipment_mode: S.SHIPMENT_MODES, dispatch_mode: S.SHIPMENT_MODES,
  rma_ship_mode: S.SHIPMENT_MODES, rma_shipment_mode: S.SHIPMENT_MODES
};
// Lists the SQL keeps that no shared JS table mirrors (module roles, NeoHR field vocab).
var VOCAB_SERVER_ONLY = ['module', 'module_role', 'field_kind', 'field_outcome', 'field_source', 'field_module', 'field_ref_type',
                         'ship_direction', 'shipment_direction', 'customer_kind'];

test('_vocab_list ↔ the shared vocab tables', function () {
  var sql = caseLists('_vocab_list');
  assert.ok(sql, '_vocab_list not found');
  Object.keys(VOCAB).forEach(function (name) {
    assert.ok(sql[name], '_vocab_list has no "' + name + '" list');
    sameSet(sql[name], keysOf(VOCAB[name]), "_vocab_list('" + name + "')");
  });
  Object.keys(sql).forEach(function (name) {
    if (VOCAB[name]) return;
    if (VOCAB_OPTIONAL[name]) { sameSet(sql[name], keysOf(VOCAB_OPTIONAL[name]), "_vocab_list('" + name + "')"); return; }
    if (VOCAB_SERVER_ONLY.indexOf(name) === -1) warn("_vocab_list('" + name + "') has no JS mirror: [" + sql[name].join(', ') + ']');
  });
  assert.ok(Object.keys(sql).some(function (n) { return VOCAB_OPTIONAL[n] === S.DATA_HANDLING; }) ||
            CHECKS['rma_cases.data_handling'], 'A11: no data_handling list anywhere');
});

// table.column CHECK → the JS table it mirrors.
var CHECK_MAP = {
  'service_jobs.stage': S.STAGE_ORDER, 'service_jobs.outcome': S.OUTCOMES, 'service_jobs.service_type': S.TYPES,
  'service_jobs.channel': S.CHANNELS, 'service_jobs.category': S.CATEGORIES, 'service_jobs.priority': S.PRIORITIES,
  'service_jobs.assigned_via': S.ASSIGNED_VIA, 'service_jobs.remote_tool': S.REMOTE_TOOLS,
  'service_jobs.converted_from': S.TYPES, 'service_jobs.data_consent': S.DATA_CONSENTS,
  'service_items.kind': S.ITEM_KINDS, 'service_items.purchase_source': S.PURCHASE_SOURCES,
  'rma_vendors.kind': S.VENDOR_KINDS,
  'rma_intakes.source': S.RMA_SOURCES, 'rma_intakes.sender_kind': S.SENDER_KINDS, 'rma_intakes.return_method': S.RETURN_METHODS,
  'rma_cases.kind': S.ITEM_KINDS, 'rma_cases.diagnosed_by': S.DIAGNOSED_BY, 'rma_cases.purchase_source': S.PURCHASE_SOURCES,
  'rma_cases.vendor_result': S.RMA_VENDOR_RESULTS, 'rma_cases.fee_status': S.FEE_STATUSES,
  'rma_cases.return_method': S.RETURN_METHODS, 'rma_cases.stage': S.RMA_ORDER, 'rma_cases.disposition': S.RMA_DISPOSITIONS,
  'rma_cases.data_handling': S.DATA_HANDLING,
  'rma_shipments.mode': S.SHIPMENT_MODES,
  'service_media.role': S.MEDIA_ROLES
};

// v2.1: the shop never backs up data. Three answers are offered, the two
// 1.10.0-beta.1 answers stay valid, and the follow-up's copy of _vocab_list is
// v2's with only that one list changed.
test('v2.1 data answers: three offered, two legacy, all five valid on both sides', function () {
  assert.deepStrictEqual(S.DATA_CONSENT_CHOICES, ['customer_backed_up', 'no_important_data', 'customer_accepts_risk']);
  assert.deepStrictEqual(S.DATA_CONSENT_LEGACY, ['backup_ok', 'no_backup']);
  sameSet(S.DATA_CONSENT_CHOICES.concat(S.DATA_CONSENT_LEGACY), Object.keys(S.DATA_CONSENTS), 'DATA_CONSENTS = choices + legacy');
  S.DATA_CONSENT_LEGACY.forEach(function (k) { assert.ok(/\(old option\)$/.test(S.DATA_CONSENTS[k]), k + ' is labelled as an old option'); });
  assert.strictEqual(S.hasCustomerDataFor('no_important_data'), false);
  assert.strictEqual(S.hasCustomerDataFor('customer_backed_up'), true);
  assert.strictEqual(S.hasCustomerDataFor('customer_accepts_risk'), true);
  assert.strictEqual(S.hasCustomerDataFor(null), null);
  assert.deepStrictEqual(S.dataConsentOptions('backup_ok'), S.DATA_CONSENT_CHOICES.concat(['backup_ok']));
  assert.deepStrictEqual(S.dataConsentOptions('no_important_data'), S.DATA_CONSENT_CHOICES);
  if (SQL_PATHS.length < 2) return;            // checking one file on its own
  var first = caseLists('_vocab_list', stripComments(fs.readFileSync(SQL_PATH, 'utf8')));
  var last = caseLists('_vocab_list');
  assert.ok(first && last, '_vocab_list not found');
  sameSet(Object.keys(last), Object.keys(first), 'the follow-up _vocab_list has the same lists as v2');
  Object.keys(first).forEach(function (k) {
    if (k === 'data_consent') return;
    assert.deepStrictEqual(last[k], first[k], "the follow-up changed _vocab_list('" + k + "') — copy v2's body, change one line");
  });
  sameSet(last.data_consent, Object.keys(S.DATA_CONSENTS), "_vocab_list('data_consent') after the follow-ups");
});

test('v2.1 device password: no grants, no realtime, no public exposure', function () {
  if (SQL_PATHS.length < 2) return;
  assert.ok(COLUMNS.service_secrets, 'create table service_secrets not found');
  sameSet(COLUMNS.service_secrets, ['job_id', 'secret', 'set_by_email', 'set_by_name', 'set_at'], 'service_secrets columns');
  assert.ok((ADDED.service_jobs || []).indexOf('has_device_password') !== -1, 'service_jobs.has_device_password is added');
  assert.ok(/revoke\s+all\s+on\s+table\s+public\.service_secrets\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i.test(SQL),
            'service_secrets is revoked from anon, authenticated and public');
  assert.ok(!/grant\s+[^;]*\s+on\s+(?:table\s+)?public\.service_secrets\b/i.test(SQL), 'nothing grants service_secrets');
  assert.ok(!/create\s+policy\s+\w+\s+on\s+public\.service_secrets\b/i.test(SQL), 'service_secrets has no policy');
  assert.ok(!/add\s+table\s+[^;]*service_secrets/i.test(SQL), 'service_secrets is never added to a publication');
  var pub = fnBody('get_service_public');
  assert.ok(pub && !/service_secrets|has_device_password|password/i.test(pub), 'get_service_public knows nothing of passwords');
  ['service_set_password', 'service_get_password'].forEach(function (f) {
    var b = fnBody(f);
    assert.ok(b, f + ' not found');
    assert.ok(/has_module\(\s*'service'\s*,\s*'desk'\s*\)/.test(b), f + ' checks the service desk role');
    assert.ok(/_svc_ev\(/.test(b), f + ' writes a timeline line');
  });
  assert.ok(/'Device password viewed by '/.test(fnBody('service_get_password')), 'every read is logged as a view');
  var purge = fnBody('tg_service_jobs_zz_secret_purge');
  assert.ok(purge && /delete\s+from\s+public\.service_secrets/i.test(purge) && /'closed'/.test(purge), 'the close trigger deletes the password');
  assert.ok('trg_service_jobs_zz_secret_purge' > 'trg_service_jobs_guard', 'the purge trigger sorts after the guard');
});

test('column CHECKs ↔ the shared vocab tables (A9 mode, A10 result, A11 data, A8 stage)', function () {
  Object.keys(CHECK_MAP).forEach(function (key) {
    var c = CHECKS[key];
    assert.ok(c, 'no CHECK (… in (…)) found for ' + key);
    sameSet(c.list, keysOf(CHECK_MAP[key]), key + ' CHECK (line ' + c.line + ')');
  });
});

// ═══ Words ═══════════════════════════════════════════════════════════════

function labelsMatch(fn, want, opts) {
  var sql = caseLabels(fn);
  assert.ok(sql, fn + ' not found');
  Object.keys(want).forEach(function (k) {
    if (opts && opts.onlyListed && !(k in sql)) return;
    assert.ok(k in sql, fn + " has no case for '" + k + "'");
    assert.strictEqual(sql[k], want[k], fn + "('" + k + "')");
  });
}
function mapOf(keys, fn) { var o = {}; keys.forEach(function (k) { o[k] = fn(k); }); return o; }

test('service labels: stages, outcomes, types, channels, item kinds', function () {
  labelsMatch('_svc_stage_label', mapOf(S.STAGE_ORDER, function (k) { return S.STAGES[k].staff; }));
  labelsMatch('_svc_outcome_label', S.OUTCOMES);
  labelsMatch('_svc_type_label', mapOf(Object.keys(S.TYPES), function (k) { return S.TYPES[k].label; }));
  labelsMatch('_svc_channel_label', S.CHANNELS);
  // 'other' falls to the SQL's else ('Part'); every named kind must agree.
  labelsMatch('_item_kind_label', S.ITEM_KINDS, { onlyListed: true });
});

test('RMA labels: staff stage, customer stage (A8 with_tech), dispositions', function () {
  labelsMatch('_rma_stage_label', mapOf(S.RMA_ORDER, function (k) { return S.RMA_STAGES[k].staff; }));
  labelsMatch('_rma_disposition_label', S.RMA_DISPOSITIONS);

  var arms = caseArms(fnBody('_rma_stage_customer'));
  assert.ok(arms, '_rma_stage_customer not found');
  S.RMA_ORDER.forEach(function (k) {
    if (k === 'closed') return;                  // composed from the disposition on both sides
    assert.ok(k in arms, "_rma_stage_customer has no case for '" + k + "'");
    if (k !== 'ready_to_return') {
      assert.strictEqual(strings(arms[k])[0], S.RMA_STAGES[k].customer, "_rma_stage_customer('" + k + "')");
      return;
    }
    // ready_to_return depends on return_method.
    var seg = arms[k], byMethod = {}, m;
    var re = /when\s+p_return_method\s*=\s*'([a-z_]+)'\s+then\s+'((?:[^']|'')*)'/gi;
    while ((m = re.exec(seg)) !== null) byMethod[m[1]] = m[2].replace(/''/g, "'");
    var el = /\belse\s+'((?:[^']|'')*)'/i.exec(seg);
    var fallback = el ? el[1].replace(/''/g, "'") : null;
    Object.keys(S.RETURN_METHODS).forEach(function (rm) {
      var sqlSays = rm in byMethod ? byMethod[rm] : fallback;
      var jsSays = S.rmaCustomerLabel({ stage: 'ready_to_return', return_method: rm });
      if (rm === 'with_device' && sqlSays !== jsSays) {
        // Not a rule, only wording, and the event bodies that use it are
        // internal for a refit; reported, not failed.
        warn("_rma_stage_customer('ready_to_return', 'with_device') says \"" + sqlSays + '" — the JS model says "' + jsSays + '"');
        return;
      }
      assert.strictEqual(sqlSays, jsSays, "_rma_stage_customer('ready_to_return', '" + rm + "')");
    });
  });
});

// ═══ Lists inside function bodies ═══════════════════════════════════════

test('every pre-return stage list in the SQL includes with_tech (A2, A8)', function () {
  // A list that has the five shop-side pre-return stages and nothing after
  // the vendor is a pre-return list, wherever it is (sync, guard, release).
  var PRE = ['logged', 'received', 'testing', 'awaiting_docs', 'ready_to_ship'];
  var POST = ['back_from_vendor', 'customer_decision', 'ready_to_return', 'returning', 'closed'];
  var re = /(?:\bin\s*\(|\barray\s*\[)\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)\s*[\])]/gi, m, seen = 0, bad = [];
  while ((m = re.exec(SQL)) !== null) {
    var list = strings(m[1]);
    if (!PRE.every(function (s) { return list.indexOf(s) !== -1; })) continue;
    if (POST.some(function (s) { return list.indexOf(s) !== -1; })) continue;
    seen++;
    if (list.indexOf('with_tech') === -1) bad.push('line ' + lineAt(m.index) + ': (' + list.join(', ') + ')');
    var extra = list.filter(function (s) { return S.RMA_PRE_RETURN.indexOf(s) === -1; });
    if (extra.length) bad.push('line ' + lineAt(m.index) + ': not pre-return [' + extra.join(', ') + ']');
  }
  assert.ok(seen > 0, 'no pre-return list found at all (rma_sync_ticket should have one)');
  assert.ok(!bad.length, 'pre-return lists without with_tech: ' + bad.join('; '));
});

test('_rma_gate_problems carries the A11 drive-data and A12 vendor_doc rules', function () {
  var body = fnBody('_rma_gate_problems');
  assert.ok(body, '_rma_gate_problems not found');
  assert.ok(/'vendor_doc'/.test(body), 'A12: a vendor_doc photo does not satisfy the "bought elsewhere" gate in SQL');
  assert.ok(/data_handling/.test(body) && /'ssd'/.test(body) && /'hdd'/.test(body), 'A11: no ssd/hdd data_handling gate in SQL');
  // The JS side, for the same two rules.
  var drive = { stage: 'testing', kind: 'ssd', serial: 'X', purchase_source: 'neo_tokyo', vendor_id: 1 };
  assert.strictEqual(S.rmaGateProblems(drive, 'ready_to_ship', ['serial_label']).length, 1);
  var els = { stage: 'testing', kind: 'gpu', serial: 'X', purchase_source: 'elsewhere', vendor_id: 1, fee_status: 'paid' };
  assert.deepStrictEqual(S.rmaGateProblems(els, 'ready_to_ship', ['serial_label', 'vendor_doc']), []);
});

// ═══ The phone rule (A1'): norm_phone() / phone_ok() run, not just read ═══
// tests/sql-eval.js evaluates the two pure helpers from the SQL text itself,
// so the same inputs go through the server's rule and NeoQcCatalog's.

var PHONE_INPUTS = (function () {
  var out = ['9847012345', '98470 12345', '098470 12345', '09847012345', '+91 98470 12345', '+91-984-701-2345',
    '919847012345', '0091 98470 12345', '00919847012345', '+971 50 123 4567', '00971501234567', '00971 50 123 4567',
    '+974 5512 3456', '00974 5512 3456', '+965 9999 8888', '+968 9123 4567', '+973 3612 3456', '+971 5012 3456',
    '+966 5012 3456', '+966 55 123 4567', '+44 7700 900123', '98470123456', '91847012345', '+1 (555) 123-4567',
    '123456789012345', '1234567890123456', '12345', '', '0', '00', '000', '0000', '009847012345', '0009847012345',
    '0098470 12345', 'abc', ' +91 98470 12345 ', null];
  var bases = ['9847012345', '971501234567', '97455123456', '96551234567', '15551234567', '98470123456',
               '447700900123', '123456789012345', '1234567890', '12345678901', '0123456789'];
  bases.forEach(function (b) {
    out.push('+' + b, '00' + b, '0' + b, '000' + b, b.replace(/(\d{3})(?=\d)/g, '$1 '), '+' + b.replace(/(\d{2})(?=\d)/g, '$1-'));
  });
  for (var i = 0; i < 300; i++) {              // digit strings of every length 1-17, some with 0 / 00 in front
    var s = i % 4 === 0 ? '00' : i % 4 === 1 ? '0' : '';
    for (var k = 0, len = 1 + (i % 17); k < len; k++) s += String((i * 7 + k * 13 + (i >> 3)) % 10);
    out.push(s);
  }
  return out;
})();

var SQLFN = null, SQLFN_ERR = null;
try { SQLFN = require(path.join(__dirname, 'sql-eval.js')).compile(SQL); }
catch (e) { SQLFN_ERR = e; }

test("norm_phone() and phone_ok() ↔ NeoQcCatalog.normPhone / isValidPhone, on " + PHONE_INPUTS.length + ' inputs', function () {
  assert.ok(SQLFN, 'tests/sql-eval.js could not read the SQL: ' + (SQLFN_ERR && SQLFN_ERR.message));
  assert.ok(SQLFN.has('norm_phone'), 'norm_phone() not found');
  assert.ok(SQLFN.has('phone_ok'), 'phone_ok() not found');
  var bad = [];
  PHONE_INPUTS.forEach(function (raw) {
    var sn, so;
    try { sn = SQLFN('norm_phone', [raw]); so = SQLFN('phone_ok', [raw]); }
    catch (e) { throw new Error('could not evaluate the SQL phone helpers on ' + JSON.stringify(raw) + ': ' + e.message); }
    var jn = C.normPhone(raw), jo = C.isValidPhone(raw);
    if (sn !== jn) bad.push('norm_phone(' + JSON.stringify(raw) + ') SQL ' + JSON.stringify(sn) + ' JS ' + JSON.stringify(jn));
    // phone_ok must be TRUE or FALSE: a NULL passes `if not phone_ok(x)` guards.
    if (so !== jo) bad.push('phone_ok(' + JSON.stringify(raw) + ') SQL ' + JSON.stringify(so) + ' JS ' + JSON.stringify(jo));
  });
  assert.ok(!bad.length, bad.length + ' disagreement(s): ' + bad.slice(0, 12).join('; '));
});

test("the SQL test file's own phone expectations hold for NeoQcCatalog (A1')", function () {
  var tpath = SQL_PATH.replace(/\.sql$/i, '.tests.sql');
  if (!fs.existsSync(tpath)) { warn('no ' + path.basename(tpath) + ' next to the SQL; phone expectations not cross-checked'); return; }
  var T = stripComments(fs.readFileSync(tpath, 'utf8'));
  var lit = "('(?:[^']|'')*'|null)";
  function val(s) { return s.toLowerCase() === 'null' ? null : s.slice(1, -1).replace(/''/g, "'"); }
  var seen = 0, bad = [];
  var re = /perform\s+neo_test\.assert\s*\(/gi, m;
  while ((m = re.exec(T)) !== null) {
    var close = closeParen(T, re.lastIndex - 1);
    if (close === -1) continue;
    var body = T.slice(re.lastIndex, close);
    if (!/norm_phone|phone_ok/.test(body) || /\bor\b/i.test(body)) continue;   // conjunctions only: each term must hold
    var x, rn = new RegExp('norm_phone\\s*\\(\\s*' + lit + '\\s*\\)\\s*=\\s*' + lit, 'gi');
    while ((x = rn.exec(body)) !== null) {
      seen++;
      var got = C.normPhone(val(x[1])), want = val(x[2]);
      if (got !== want) bad.push('norm_phone(' + x[1] + ') = ' + x[2] + ' but JS gives ' + JSON.stringify(got));
    }
    var ro = new RegExp('(\\bnot\\s+)?(?:public\\.)?phone_ok\\s*\\(\\s*' + lit + '\\s*\\)', 'gi');
    while ((x = ro.exec(body)) !== null) {
      seen++;
      var ok = C.isValidPhone(val(x[2]));
      if (ok !== !x[1]) bad.push((x[1] ? 'not ' : '') + 'phone_ok(' + x[2] + ') but JS isValidPhone gives ' + ok);
    }
  }
  assert.ok(seen >= 10, 'expected the SQL tests to pin down the phone rule; found ' + seen + ' expectations');
  assert.ok(!bad.length, bad.join('; '));
});

test('the SQL evaluator itself: reads a plpgsql copy of the rule and catches a wrong one', function () {
  var E = require(path.join(__dirname, 'sql-eval.js'));
  var good = [
    "create or replace function public.norm_phone(p text) returns text language plpgsql immutable as $$",
    "declare d text := regexp_replace(coalesce(p, ''), '\\D', '', 'g');",
    "begin",
    "  if d like '00%' then d := substring(d from 3); end if;",
    "  if length(d) = 10 then return '91' || d;",
    "  elsif length(d) = 11 and starts_with(d, '0') then return '91' || right(d, 10);",
    "  end if;",
    "  return d;",
    "end;",
    "$$;",
    "create or replace function public.phone_ok(p text) returns boolean language sql immutable as $$",
    "  select n ~ '^[0-9]{12,15}$' or n ~ '^(965|968|973|974)[0-9]{8}$' from (select public.norm_phone(p) n) s",
    "$$;"].join('\n');
  var g = E.compile(good);
  PHONE_INPUTS.forEach(function (raw) {
    assert.strictEqual(g('norm_phone', [raw]), C.normPhone(raw), 'plpgsql norm_phone ' + JSON.stringify(raw));
    assert.strictEqual(g('phone_ok', [raw]), C.isValidPhone(raw), 'plpgsql phone_ok ' + JSON.stringify(raw));
  });
  // The pre-A1' rule (no 00 strip, 12-15 only) must be told apart.
  var old = E.compile([
    "create function norm_phone(p text) returns text language sql as $$",
    "  select case when length(d) = 10 then '91' || d when length(d) = 11 and left(d, 1) = '0' then '91' || right(d, 10)",
    "              else d end from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s $$;",
    "create function phone_ok(p text) returns boolean language sql as $$ select length(public.norm_phone(p)) between 12 and 15 $$;"
  ].join('\n'));
  assert.notStrictEqual(old('norm_phone', ['00971501234567']), C.normPhone('00971501234567'));
  assert.notStrictEqual(old('phone_ok', ['+974 5512 3456']), C.isValidPhone('+974 5512 3456'));
  // Three-valued logic: a phone_ok that can return NULL is caught too.
  var nully = E.compile("create function phone_ok(p text) returns boolean language sql as $$ select length(p) between 12 and 15 $$;");
  assert.strictEqual(nully('phone_ok', [null]), null);
  // A shape it cannot read fails loudly instead of passing.
  var odd = E.compile("create function norm_phone(p text) returns text language sql as $$ select p from t $$;");
  assert.throws(function () { odd('norm_phone', ['1']); }, /sql-eval/);
});

// ═══ v2.2 — the work queue (sql/work-queue.sql) ═══════════════════════════

var WQ_PATH = SQL_PATHS.filter(function (p) { return path.basename(p) === 'work-queue.sql'; })[0] || null;
var WQ = WQ_PATH ? stripComments(fs.readFileSync(WQ_PATH, 'utf8')) : null;
var V2 = stripComments(fs.readFileSync(SQL_PATH, 'utf8'));
var WQJS = null;
try { WQJS = require(path.join(__dirname, '..', 'shared', 'work-queue.js')); } catch (e) { WQJS = null; }
function wqTest(name, fn) {
  test(name, function () {
    if (!WQ) { warn('sql/work-queue.sql is not among the files read; "' + name + '" skipped'); return; }
    fn();
  });
}

// The top-level keys of the first jsonb_build_object( … ) in a body.
function objKeys(body) {
  if (body == null) return null;
  var i = body.search(/jsonb_build_object\s*\(/i);
  if (i === -1) return null;
  var open = body.indexOf('(', i);
  var close = closeParen(body, open);
  if (close === -1) return null;
  return splitTop(body.slice(open + 1, close)).filter(function (x, k) { return k % 2 === 0; })
    .map(function (x) { var m = /^\s*'([^']*)'\s*$/.exec(x); return m ? m[1] : null; }).filter(Boolean);
}
// The parameter list of the LAST definition of a function, normalised.
function fnParams(name, text) {
  var src = text == null ? SQL : text;
  var re = new RegExp('create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?' + name + '\\s*\\(', 'gi');
  var m, last = -1, lastEnd = -1;
  while ((m = re.exec(src)) !== null) { last = m.index; lastEnd = re.lastIndex - 1; }
  if (last === -1) return null;
  var close = closeParen(src, lastEnd);
  var head = src.slice(close + 1, src.indexOf('$$', close));
  return { params: src.slice(lastEnd + 1, close).replace(/\s+/g, ' ').trim().toLowerCase(),
           returns: (/\breturns\s+([a-z_.]+)/i.exec(head) || [])[1], head: head.replace(/\s+/g, ' ').toLowerCase() };
}
// Every function a text creates.
function createdFunctions(text) {
  var re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi, m, out = [];
  while ((m = re.exec(text)) !== null) if (out.indexOf(m[1].toLowerCase()) === -1) out.push(m[1].toLowerCase());
  return out;
}
// A text[] literal assigned in a DO block: v_name text[] := array[ … ];
function arrayVar(text, name) {
  var m = new RegExp('\\b' + name + '\\s+text\\[\\]\\s*:=\\s*array\\s*\\[([^\\]]*)\\]', 'i').exec(text);
  return m ? strings(m[1]) : null;
}
var WQ_API = ['work_queue', 'work_claim', 'work_offer', 'work_respond', 'work_release', 'build_queue_send', 'work_team',
              'work_events_for', 'work_tick', 'work_alert_resolve', 'my_work_profile', 'my_modules', 'service_tech_list',
              'service_claim', 'service_create', 'staff_list', 'staff_update', 'staff_apply_preset', 'preset_list',
              'preset_upsert', 'preset_delete', 'work_log_push', 'work_log_pull', 'work_log_team',
              // NeoHR 2.1
              'neo_dashboard'];
var WQ_TABLES =['staff_work', 'designation_presets', 'work_alerts', 'work_events', 'work_logs'];

wqTest('v2.2: my_modules keeps every v2 key and adds build_pool / service_pool / build_level', function () {
  var old = objKeys(fnBody('my_modules', V2)), now = objKeys(fnBody('my_modules'));
  assert.ok(old && old.length >= 5 && now, 'my_modules keys not found');
  old.forEach(function (k) { assert.ok(now.indexOf(k) !== -1, "my_modules lost v2's key '" + k + "'"); });
  ['build_pool', 'service_pool', 'build_level'].forEach(function (k) { assert.ok(now.indexOf(k) !== -1, 'my_modules lacks ' + k); });
  assert.ok(/p\.active\s+and\s+coalesce\(\s*p\.is_staff\s*,\s*false\s*\)/i.test(fnBody('my_modules')),
            'A14: my_modules reports pools only for active staff');
});

wqTest('v2.2: service_tech_list keeps every v2 key and adds pools, level, load and capacity', function () {
  var old = objKeys(fnBody('service_tech_list', V2)), now = objKeys(fnBody('service_tech_list'));
  assert.ok(old && old.length >= 7 && now, 'service_tech_list keys not found');
  old.forEach(function (k) { assert.ok(now.indexOf(k) !== -1, "service_tech_list lost v2's key '" + k + "'"); });
  ['service_pool', 'build_pool', 'build_level', 'points', 'jobs', 'capacity_points', 'max_jobs'].forEach(function (k) {
    assert.ok(now.indexOf(k) !== -1, 'service_tech_list lacks ' + k);
  });
  assert.ok(/\bservice_pool\b/.test(fnBody('service_tech_list').split(/\bwhere\b/i).slice(-1)[0]),
            '§2.7.13: membership is the service pool');
});

wqTest('v2.2: the redefined v2 functions keep their exact signatures (A14)', function () {
  ['my_modules', 'service_tech_list', 'service_claim', 'service_create'].forEach(function (f) {
    var a = fnParams(f, V2), b = fnParams(f);
    assert.ok(a && b, f + ' not found');
    assert.strictEqual(b.params, a.params, f + ' parameters changed');
    assert.strictEqual(b.returns, a.returns, f + ' return type changed');
    assert.ok(/security definer/.test(b.head) && /set search_path = public/.test(b.head), f + ' is still security definer');
  });
  assert.ok(!/drop\s+function[^;]*\b(my_modules|service_tech_list|service_claim|service_create)\b/i.test(WQ), 'v2.2 never drops them');
});

wqTest('v2.2: function privileges — nothing for anon, the API for authenticated, internals for nobody', function () {
  var all = arrayVar(WQ, 'v_all'), auth = arrayVar(WQ, 'v_authenticated');
  assert.ok(all && auth, 'the v_all / v_authenticated lists of the grant block were not found');
  assert.ok(!arrayVar(WQ, 'v_anon'), 'v2.2 has no anon list');
  assert.ok(!/grant\s+[^;]*\bto\s+[^;]*\banon\b/i.test(WQ), 'no grant to anon anywhere in work-queue.sql');
  assert.ok(/revoke\s+all\s+on\s+function\s+%s\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i.test(WQ),
            'every listed function is revoked from public, anon and authenticated');
  createdFunctions(WQ).forEach(function (f) { assert.ok(all.indexOf(f) !== -1, f + ' is created but missing from the grant block'); });
  auth.forEach(function (f) {
    assert.ok(all.indexOf(f) !== -1, f + ' is granted but not revoked first');
    assert.ok(!/^(_|tg_)/.test(f), 'internal ' + f + ' must not be granted to authenticated');
  });
  sameSet(auth, WQ_API, 'the functions authenticated may execute');
});

wqTest('v2.2: every API RPC is security definer, starts from _neo_me(); triggers are definer and ungranted', function () {
  WQ_API.forEach(function (f) {
    var p = fnParams(f), body = fnBody(f);
    assert.ok(p && body, f + ' not found');
    assert.ok(/security definer/.test(p.head) && /set search_path = public/.test(p.head), f + ' is security definer, search_path = public');
    if (f === 'my_modules') return;                              // sql, reads auth.uid() like v2's
    if (f === 'work_tick') {
      assert.ok(/if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then\s+perform\s+public\._neo_me\(\)/i.test(body), 'work_tick: _neo_me when a JWT is present');
      assert.ok(/pg_try_advisory_xact_lock\(\s*hashtext\(\s*'neo_work_tick'\s*\)\s*\)/i.test(body), 'work_tick: one at a time');
      assert.ok((body.match(/for\s+update\s+skip\s+locked/gi) || []).length === 4, 'work_tick: 4 batches, each FOR UPDATE SKIP LOCKED');
      return;
    }
    assert.ok(/v_me\s+public\.profiles\s*:=\s*public\._neo_me\(\)/i.test(body), f + ' starts with v_me := public._neo_me()');
  });
  var auth = arrayVar(WQ, 'v_authenticated');
  var re = /create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)\s*\(\s*\)\s*returns\s+trigger\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*public/gi;
  var defs = [], m;
  while ((m = re.exec(WQ)) !== null) defs.push(m[1]);
  var triggers = (WQ.match(/\breturns\s+trigger\b/gi) || []).length;
  assert.ok(triggers >= 6 && defs.length === triggers, 'every v2.2 trigger function is security definer with search_path = public');
  defs.forEach(function (f) { assert.ok(auth.indexOf(f) === -1, 'trigger ' + f + ' has no authenticated grant'); });
  assert.ok(/pg_advisory_xact_lock\(\s*hashtext\(\s*'neo_work_pick'\s*\)\s*\)/i.test(fnBody('_work_auto_offer')),
            '9.1: _work_auto_offer takes the pick lock');
  ['staff_update', 'staff_apply_preset'].forEach(function (f) {
    assert.ok(/pg_advisory_xact_lock\(\s*hashtext\(\s*'neo_staff_admin'\s*\)\s*\)/i.test(fnBody(f)), f + ' takes the staff-admin lock');
  });
});

wqTest('v2.2: every new table is select-only for clients, RLS on, never anon (A7)', function () {
  WQ_TABLES.forEach(function (t) {
    assert.ok(COLUMNS[t], 'create table ' + t + ' not found');
    var esc = t.replace(/_/g, '_');
    assert.ok(new RegExp('alter\\s+table\\s+public\\.' + esc + '\\s+enable\\s+row\\s+level\\s+security', 'i').test(WQ), t + ': RLS on');
    assert.ok(new RegExp('revoke\\s+all\\s+on\\s+table\\s+public\\.' + esc + '\\s+from\\s+anon\\s*,\\s*authenticated', 'i').test(WQ),
              t + ': revoked from anon and authenticated');
    var g = new RegExp('grant\\s+([^;]*?)\\s+on\\s+(?:table\\s+)?public\\.' + esc + '\\b([^;]*);', 'gi'), x, grants = [];
    while ((x = g.exec(WQ)) !== null) grants.push(x[1].trim().toLowerCase() + ' →' + x[2].trim().toLowerCase());
    assert.deepStrictEqual(grants, ['select →to authenticated'], t + ': the only grant is select to authenticated (' + grants.join('; ') + ')');
    var p = new RegExp('create\\s+policy\\s+\\w+\\s+on\\s+public\\.' + esc + '\\s+for\\s+(\\w+)', 'gi'), y, n = 0;
    while ((y = p.exec(WQ)) !== null) { n++; assert.strictEqual(y[1].toLowerCase(), 'select', t + ': policies are select only'); }
    assert.ok(n >= 1, t + ': has a select policy');
  });
  assert.ok(/add\s+table\s+public\.%I',\s*'work_alerts'/i.test(WQ), 'work_alerts is published to realtime');
  assert.ok(!/add\s+table[^;]*work_logs/i.test(WQ) && !/'work_logs'\s*\)/.test(WQ.split(/supabase_realtime/i).slice(1).join('')),
            'work_logs is never published');
  // per-kind read rules (A7 / C14)
  var we = /create\s+policy\s+we_select[^;]*;/i.exec(WQ)[0], wa = /create\s+policy\s+wa_select[^;]*;/i.exec(WQ)[0];
  assert.ok(/item_kind\s*=\s*'build'[^;]*has_module\('qc',\s*'desk'\)/i.test(we) && /item_kind\s*=\s*'service'[^;]*has_module\('service',\s*'desk'\)/i.test(we),
            'work_events: build rows need qc desk, service rows service desk');
  assert.ok(/item_kind\s*=\s*'build'[^;]*has_module\('qc',\s*'lead'\)/i.test(wa) && /item_kind\s*=\s*'service'[^;]*has_module\('service',\s*'lead'\)/i.test(wa)
            && /my_tier\(\)\)\s*>=\s*3/i.test(wa), 'work_alerts: tier 3+, or the lead of that kind');
  assert.ok(/on\s+delete\s+set\s+null/i.test(/create\s+table\s+if\s+not\s+exists\s+public\.work_logs\s*\(([\s\S]*?)\);/i.exec(WQ)[1]),
            'A9: work_logs.profile_id is on delete set null');
});

wqTest('v2.2: the tickets guard keeps every server-owned column on a non-RPC update', function () {
  var g = fnBody('tg_tickets_work_guard');
  assert.ok(g, 'tg_tickets_work_guard not found');
  ['technician', 'technician_email', 'assigned_via', 'assigned_at', 'assign_reason', 'queued_at', 'offered_to_email',
   'offered_to_name', 'offer_kind', 'offer_by_email', 'offer_by_name', 'offer_reason', 'offered_at', 'offer_expires_at',
   'declined_emails', 'auto_tried_at'].forEach(function (c) {
    assert.ok(new RegExp('new\\.' + c + '\\s*:=\\s*old\\.' + c + '\\s*;', 'i').test(g), 'the guard keeps OLD.' + c);
  });
  assert.ok(/now\(\)\s*\+\s*interval\s*'2 minutes'/i.test(g) && /'-infinity'::timestamptz\)\s*\+\s*interval\s*'1 millisecond'/i.test(g),
            '9.1: updated_at clamped to now() + 2 min and never backwards');
  var z = fnBody('tg_service_jobs_zy_offer_guard');
  ['offered_to_email', 'offer_expires_at', 'declined_emails', 'auto_tried_at'].forEach(function (c) {
    assert.ok(new RegExp('new\\.' + c + '\\s*:=\\s*old\\.' + c + '\\s*;', 'i').test(z), 'the service offer guard keeps OLD.' + c);
  });
  assert.ok('trg_service_jobs_guard' < 'trg_service_jobs_zy_offer_guard' && 'trg_service_jobs_zy_offer_guard' < 'trg_service_jobs_zz_secret_purge',
            'the offer guard sorts between v2\'s guard and v2.1\'s purge');
  assert.ok(/'NEO_GATE: Neo OS needs at least one active tier-5 account\.'/.test(fnBody('staff_update')),
            'staff_update keeps the last tier-5 guard');
  assert.ok(/'NEO_DENIED: Only the owner can change a tier 4 or 5 account\.'/.test(fnBody('staff_update'))
            && /'NEO_DENIED: Only the owner can change a tier 4 or 5 account\.'/.test(fnBody('staff_apply_preset')),
            'C4: the tier-4 hierarchy sentence');
});

wqTest('v2.2: CHECKs — assigned_via gains auto (both tables), offers, the service_events kind fold', function () {
  sameSet(CHECKS['service_jobs.assigned_via'].list, ['claim', 'manager', 'legacy', 'self', 'auto'], 'service_jobs.assigned_via');
  sameSet(CHECKS['tickets.assigned_via'].list, ['claim', 'manager', 'auto', 'legacy'], 'tickets.assigned_via');
  sameSet(CHECKS['tickets.offer_kind'].list, ['manager', 'auto'], 'tickets.offer_kind');
  sameSet(CHECKS['service_jobs.offer_kind'].list, ['manager', 'auto'], 'service_jobs.offer_kind');
  assert.ok(CHECKS['service_events.kind'].list.indexOf('offer') !== -1, "service_events kind fold includes 'offer'");
  sameSet(CHECKS['work_events.kind'].list, ['queued', 'claim', 'offer', 'offer_withdrawn', 'accept', 'decline', 'offer_expired',
                                             'auto_offer', 'release', 'reassigned', 'legacy', 'no_candidate'], 'work_events.kind');
  sameSet(CHECKS['work_alerts.kind'].list, ['declined', 'expired', 'no_candidate'], 'work_alerts.kind');
  ['tickets', 'service_jobs'].forEach(function (t) {
    ['offered_to_email', 'offered_to_name', 'offer_kind', 'offer_by_email', 'offer_by_name', 'offer_reason', 'offered_at',
     'offer_expires_at', 'declined_emails', 'auto_tried_at'].concat(t === 'tickets'
       ? ['technician_email', 'assigned_via', 'assigned_at', 'assign_reason', 'queued_at'] : []).forEach(function (c) {
      assert.ok((ADDED[t] || []).indexOf(c) !== -1, t + '.' + c + ' is added');
    });
  });
});

wqTest('v2.2: the presets seed holds the 16 live designations, each once', function () {
  var m = /insert\s+into\s+public\.designation_presets[\s\S]*?\(values([\s\S]*?)\)\s*as\s+v\s*\(/i.exec(WQ);
  assert.ok(m, 'the presets seed was not found');
  var rows = m[1].split(/\)\s*,\s*\(/).map(function (r) { return strings(r)[0]; });
  assert.strictEqual(rows.length, 16, 'presets seeded');
  var keys = rows.map(function (d) { return d.toLowerCase().replace(/\s+/g, ' ').trim(); });
  keys.forEach(function (k, i) { assert.strictEqual(keys.indexOf(k), i, 'preset "' + rows[i] + '" twice'); });
  assert.ok(/on\s+conflict\s*\(\s*key\s*\)\s*do\s+nothing/i.test(WQ.slice(m.index, m.index + m[0].length + 200)), 'seed: on conflict do nothing');
});

wqTest('v2.2: a re-run changes nothing People edited (seed, backfill, People rows)', function () {
  // One marker decides the first install: staff_work is empty until the first backfill.
  assert.ok(/v_first\s+boolean\s*:=\s*not\s+exists\s*\(\s*select\s+1\s+from\s+public\.staff_work\s*\)/i.test(WQ),
            'the backfill computes v_first from an empty staff_work');
  var seed = WQ.search(/insert\s+into\s+public\.designation_presets\s*\(\s*key\b/i);
  assert.ok(seed !== -1 && /if\s+v_first\s+then\s*$/i.test(WQ.slice(Math.max(0, seed - 80), seed).trimEnd()),
            'the presets are seeded only on the first install (a deleted / renamed preset stays so)');
  assert.ok(/if\s+v_first\s+or\s+not\s+exists\s*\(\s*select\s+1\s+from\s+public\.module_access\s+ma\s+where\s+ma\.profile_id\s*=\s*r\.profile_id\s+and\s+ma\.module\s+in\s*\(\s*'service'\s*,\s*'rma'\s*,\s*'qc'\s*\)\s*\)\s+then\s+perform\s+public\._preset_apply\(/i.test(WQ),
            'a re-run applies a preset only to someone with no service / rma / qc role');
  ['staff_update', 'staff_apply_preset'].forEach(function (f) {
    assert.ok(/insert\s+into\s+public\.staff_work\s*\(\s*profile_id\s*,\s*updated_by\s*\)\s*values\s*\(\s*v_t\.id\s*,\s*lower\(\s*v_me\.email\s*\)\s*\)\s*on\s+conflict\s*\(\s*profile_id\s*\)\s*do\s+nothing/i.test(fnBody(f)),
              f + ' always leaves a staff_work row');
  });
  // A lead's withdrawal: the app's own pick is skipped, and the tick waits 10 minutes.
  var w = fnBody('work_offer');
  var i = w.search(/_work_offer_clear\(\s*v_kind\s*,\s*p_id\s*,\s*case\s+when\s+v_okind\s*=\s*'auto'\s+then\s+v_to\s+end\s*\)/i);
  assert.ok(i !== -1, 'work_offer: withdrawing an auto offer puts that person in declined_emails');
  var after = w.slice(i, i + 700);
  assert.ok(/update\s+public\.tickets\s+set\s+auto_tried_at\s*=\s*now\(\)/i.test(after)
            && /update\s+public\.service_jobs\s+set\s+auto_tried_at\s*=\s*now\(\)/i.test(after),
            'work_offer: a withdrawal stamps auto_tried_at on both kinds');
});

wqTest('v2.2 ↔ shared/work-queue.js: eligibility sentences, costs, the 4 h / 30 min clock', function () {
  assert.ok(WQJS, 'shared/work-queue.js could not be loaded');
  assert.ok(SQLFN && SQLFN.has('_work_why_text'), '_work_why_text not found');
  ['not_staff', 'no_role', 'no_pool', 'senior'].forEach(function (code) {
    ['build', 'service'].forEach(function (kind) {
      [true, false].forEach(function (self) {
        var sql = SQLFN('_work_why_text', [kind, code, self]);
        assert.strictEqual(WQJS.whySentence(code, kind, self), sql,
                           'whySentence(' + code + ', ' + kind + ', ' + self + ') — SQL says ' + JSON.stringify(sql));
      });
    });
  });
  assert.strictEqual(SQLFN('_work_why_text', ['build', 'bogus', true]), null, '_work_why_text: an unknown code is null');
  [['on_site', 2], ['in_store', 1], ['remote', 1]].forEach(function (c) {
    assert.strictEqual(SQLFN('_work_cost_service', [c[0]]), c[1], '_work_cost_service(' + c[0] + ')');
    assert.strictEqual(WQJS.serviceCost(c[0]), c[1], 'NeoQcWork.serviceCost(' + c[0] + ')');
  });
  var q = fnBody('work_queue');
  assert.strictEqual(Number((/'claim_hours'\s*,\s*(\d+)/.exec(q) || [])[1]), WQJS.CLAIM_HOURS, 'claim_hours = CLAIM_HOURS');
  assert.strictEqual(Number((/'offer_minutes'\s*,\s*(\d+)/.exec(q) || [])[1]), WQJS.OFFER_MINUTES, 'offer_minutes = OFFER_MINUTES');
  assert.ok(new RegExp("interval\\s+'" + WQJS.OFFER_MINUTES + " minutes'").test(fnBody('_work_offer_set')), 'offers last OFFER_MINUTES');
  assert.ok(new RegExp("interval\\s+'" + WQJS.CLAIM_HOURS + " hours'").test(fnBody('work_tick')), 'the tick uses CLAIM_HOURS');
  labelsMatch('_svc_category_label', S.CATEGORIES);
});

// ═══ NeoHR 2.1 — neo_dashboard's service status model (work-queue.sql §9b) ═══
// The dashboard's "late" and whose-turn counts are serviceRisk() and
// ticketWithUnits() of shared/service-status.js, ported to SQL. The pure
// helpers take plain milliseconds, so the SQL is RUN here (tests/sql-eval.js)
// on the same inputs as the JS and every answer must agree. The composition
// over real rows (_svc_state, parts and vendors) runs on PGlite in
// scratchpad pgtest/dash22.mjs; its shape is checked statically below.

var DASH_NOW = Date.UTC(2026, 9, 22, 6, 30, 0, 123);
var MIN_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

// Idle times around every budget either side uses (days), with the exact
// boundary where it is a whole number of milliseconds both sides agree on.
function idleGrid(budgets) {
  var out = [0, 1, 59 * MIN_MS, 90 * DAY_MS];
  budgets.forEach(function (b) {
    var exact = [0.75, 1].every(function (f) { var v = b * f * DAY_MS; return v === Math.round(v) && (v / DAY_MS) === b * f; });
    [0.5, 0.74, 0.76, 0.99, 1.01, 1.5].concat(exact ? [0.75, 1] : []).forEach(function (f) { out.push(Math.round(b * f * DAY_MS)); });
    if (exact) { out.push(b * 0.75 * DAY_MS - 1, b * DAY_MS - 1); }
  });
  return out.filter(function (v, i, a) { return v >= 0 && a.indexOf(v) === i; });
}
function svcRiskGrid(call) {
  var budgets = [];
  Object.keys(S.BUDGET_BY_TYPE).forEach(function (t) {
    Object.keys(S.BUDGET_BY_TYPE[t]).forEach(function (st) {
      var b = S.BUDGET_BY_TYPE[t][st];
      if (b != null && budgets.indexOf(b) === -1) budgets.push(b);
    });
  });
  budgets.push(0.5);                                  // a visit stage with no time booked
  var idles = idleGrid(budgets);
  var promises = [null, -1, 0, 1, DAY_MS - 1, DAY_MS, DAY_MS + 1, 3 * DAY_MS];
  var visits = [null, -30 * MIN_MS - 1, -30 * MIN_MS, -29 * MIN_MS, 0, 60 * MIN_MS, 60 * MIN_MS + 1, 5 * HOUR_MS];
  var bad = [], n = 0;
  Object.keys(S.TYPES).forEach(function (type) {
    S.STAGE_ORDER.concat(['bogus_stage']).forEach(function (stage) {
      var vs = S.isVisitStage(stage) ? visits : [null, 0];
      idles.forEach(function (idle) {
        promises.forEach(function (p) {
          vs.forEach(function (v) {
            n++;
            var job = { service_type: type, stage: stage, stage_since: iso(DASH_NOW - idle),
                        promised_at: iso(p == null ? null : DASH_NOW + p), visit_start: iso(v == null ? null : DASH_NOW + v) };
            var js = S.serviceRisk(job, DASH_NOW);
            var sql = call('_svc_risk_ms', [type, stage, idle, p, v]);
            if (sql !== js && bad.length < 5) bad.push(type + '/' + stage + ' idle ' + idle + ' promise ' + p + ' visit ' + v + ': SQL ' + sql + ', JS ' + js);
          });
        });
      });
    });
  });
  return { n: n, bad: bad };
}
function rmaRiskGrid(call) {
  var idles = idleGrid([1, 2, 3, 4, 5, 7, 14, 21]);
  var bad = [], n = 0;
  S.RMA_ORDER.concat(['bogus_stage']).forEach(function (stage) {
    ['collect', 'courier', 'with_device', null].forEach(function (method) {
      [null, 7, 21].forEach(function (tat) {
        idles.forEach(function (idle) {
          var backs = [null, -1, 0, 1, 2 * HOUR_MS, 30 * DAY_MS];
          if (idle % 3 === 0) backs.push(idle / 3, idle / 3 + 1);    // the last quarter of the expected wait, exactly
          backs.forEach(function (back) {
            n++;
            var unit = { stage: stage, return_method: method, stage_since: iso(DASH_NOW - idle),
                         expected_back_at: iso(back == null ? null : DASH_NOW + back) };
            var js = S.rmaRisk(unit, DASH_NOW, tat == null ? null : { typical_tat_days: tat });
            var sql = call('_rma_risk_ms', [stage, method, idle, back, back == null ? null : back + idle, tat]);
            if (sql !== js && bad.length < 5) bad.push(stage + '/' + method + '/tat ' + tat + ' idle ' + idle + ' back ' + back + ': SQL ' + sql + ', JS ' + js);
          });
        });
      });
    });
  });
  return { n: n, bad: bad };
}

wqTest('NeoHR 2.1: _svc_ball ↔ ballOf, _svc_budget_in ↔ BUDGET_BY_TYPE, _rma_ball / _rma_budget_days ↔ the RMA model', function () {
  assert.ok(SQLFN, 'tests/sql-eval.js could not read the SQL: ' + (SQLFN_ERR && SQLFN_ERR.message));
  ['_svc_ball', '_svc_budget_in', '_svc_budget_days', '_svc_risk_ms', '_rma_ball', '_rma_budget_days', '_rma_risk_ms', '_svc_state']
    .forEach(function (f) { assert.ok(SQLFN.has(f), f + '() not found'); });
  S.STAGE_ORDER.concat(['bogus_stage', null]).forEach(function (st) {
    assert.strictEqual(SQLFN('_svc_ball', [st]), S.ballOf(st), '_svc_ball(' + st + ')');
  });
  Object.keys(S.TYPES).concat(['bogus_type']).forEach(function (t) {
    var table = Object.prototype.hasOwnProperty.call(S.BUDGET_BY_TYPE, t) ? S.BUDGET_BY_TYPE[t] : {};
    S.STAGE_ORDER.forEach(function (st) {
      var want = Object.prototype.hasOwnProperty.call(table, st) ? table[st] : null;
      assert.strictEqual(SQLFN('_svc_budget_in', [t, st]), want, '_svc_budget_in(' + t + ', ' + st + ')');
    });
  });
  S.RMA_ORDER.concat(['bogus_stage']).forEach(function (st) {
    ['collect', 'courier', 'with_device', null, 'bogus'].forEach(function (m) {
      assert.strictEqual(SQLFN('_rma_ball', [st, m]), S.rmaBallOf({ stage: st, return_method: m }), '_rma_ball(' + st + ', ' + m + ')');
      [null, 0, 9, 30].forEach(function (tat) {
        var v = tat == null ? null : { typical_tat_days: tat };
        assert.strictEqual(SQLFN('_rma_budget_days', [st, m, tat]), S.rmaBudgetDays({ stage: st, return_method: m }, v),
                           '_rma_budget_days(' + st + ', ' + m + ', ' + tat + ')');
      });
    });
  });
  sameSet(strings((/p_job\.stage\s+in\s*\(([^)]*)\)/i.exec(fnBody('_svc_state')) || [])[1] || ''), S.MIRROR_STAGES,
          '_svc_state reads held parts for exactly the mirror stages');
});

wqTest('NeoHR 2.1: _svc_risk_ms ↔ serviceRisk() and _rma_risk_ms ↔ rmaRisk(), run on a grid of inputs', function () {
  assert.ok(SQLFN, 'tests/sql-eval.js could not read the SQL: ' + (SQLFN_ERR && SQLFN_ERR.message));
  var a = svcRiskGrid(SQLFN);
  assert.ok(a.n > 20000, 'the service grid is too small (' + a.n + ')');
  assert.ok(!a.bad.length, 'serviceRisk differs on ' + a.bad.join(' | '));
  var b = rmaRiskGrid(SQLFN);
  assert.ok(b.n > 5000, 'the RMA grid is too small (' + b.n + ')');
  assert.ok(!b.bad.length, 'rmaRisk differs on ' + b.bad.join(' | '));
  // The grid catches a wrong rule (a mutated copy of the SQL must disagree).
  var E = require(path.join(__dirname, 'sql-eval.js'));
  [["p_visit_ms < -1800000", "p_visit_ms < -3600000", svcRiskGrid],
   ["p_promise_ms <= 86400000", "p_promise_ms < 86400000", svcRiskGrid],
   ["when 'parts_on_order' then 7", "when 'parts_on_order' then 8", svcRiskGrid],
   ["p_back_in_ms <= p_span_ms * 0.25", "p_back_in_ms < p_span_ms * 0.25", rmaRiskGrid]].forEach(function (m) {
    assert.ok(SQL.indexOf(m[0]) !== -1, 'self-check: "' + m[0] + '" not found in the SQL');
    var wrong = E.compile(SQL.split(m[0]).join(m[1]));
    assert.ok(m[2](wrong).bad.length, 'the grid does not notice "' + m[0] + '" → "' + m[1] + '"');
  });
});

wqTest('NeoHR 2.1: neo_dashboard — sections by permission, the status model, India days', function () {
  var b = fnBody('neo_dashboard');
  assert.ok(b, 'neo_dashboard not found');
  // Each section behind the read rule of what it counts (omitted, never zeros).
  [['queue', /if\s+v_db\s+or\s+v_ds\s+then[\s\S]*?jsonb_build_object\(\s*'queue'/i],
   ['service', /if\s+v_ds\s+then[\s\S]*?jsonb_build_object\(\s*'service'/i],
   ['builds', /if\s+v_db\s+then[\s\S]*?jsonb_build_object\(\s*'builds'/i],
   ['rma', /if\s+v_dr\s+then[\s\S]*?jsonb_build_object\(\s*'rma'/i],
   ['team', /if\s+v_head\s+then[\s\S]*?jsonb_build_object\(\s*'team'/i]].forEach(function (x) {
    assert.ok(x[1].test(b), 'neo_dashboard: the ' + x[0] + ' section sits behind its read rule');
  });
  assert.ok(/v_db\s+boolean\s*:=\s*public\.has_module\('qc',\s*'desk'\)/i.test(b) && /v_ds\s+boolean\s*:=\s*public\.has_module\('service',\s*'desk'\)/i.test(b)
            && /v_dr\s+boolean\s*:=\s*public\.has_module\('rma',\s*'desk'\)/i.test(b) && /v_head\s+boolean\s*:=\s*public\.my_tier\(\)\s*>=\s*3/i.test(b),
            'neo_dashboard: Builds / Service / RMA desk+, team for tier 3+');
  assert.ok(/'late',\s*count\(\*\)\s*filter\s*\(where\s+st\.risk\s*=\s*2\)/i.test(b) && /_svc_state\(s,\s*v_now\)/i.test(b),
            'neo_dashboard: late = ticketWithUnits risk 2 (through _svc_state)');
  ['shop', 'customer', 'third_party'].forEach(function (ball) {
    assert.ok(new RegExp("filter\\s*\\(where\\s+st\\.ball\\s*=\\s*'" + ball + "'\\)").test(b), 'neo_dashboard counts the ' + ball + ' ball');
  });
  assert.ok(/\(\(now\(\)\s+at\s+time\s+zone\s+'Asia\/Kolkata'\)::date\)::timestamp\s+at\s+time\s+zone\s+'Asia\/Kolkata'/i.test(b),
            'A11: India day bounds');
  assert.ok(new RegExp("interval\\s+'" + WQJS.CLAIM_HOURS + " hours'").test(b), 'the queue section uses CLAIM_HOURS');
  assert.ok(/limit\s+6\b/i.test(b), 'attention: at most 6 items');
  var st = fnBody('_svc_state');
  assert.ok(/bool_or\(x\.b\s*=\s*'customer'\)\s*then\s*'customer'\s*when\s+bool_or\(x\.b\s*=\s*'shop'\)\s*then\s*'shop'\s*when\s+bool_or\(x\.b\s*=\s*'third_party'\)/i.test(st)
            && /max\(x\.r\)/i.test(st) && /c\.holds_ticket\s+and\s+c\.stage\s*<>\s*'closed'/i.test(st),
            '_svc_state: the most urgent held part\'s ball (customer, shop, third party — BALL_URGENCY) and the worst risk');
});

// ═══ The demo rows are `select *` rows ═══════════════════════════════════

test('demo rows have exactly the columns of the tables this file creates', function () {
  var d = Demo.build(new Date(2026, 9, 21, 12, 0, 0).getTime());
  var TABLES = {
    customers: d.customers, service_items: d.items, rma_vendors: d.vendors, rma_intakes: d.intakes,
    rma_cases: d.units, rma_events: d.rma_events, rma_shipments: d.shipments, rma_shipment_items: d.shipment_items
  };
  Object.keys(TABLES).forEach(function (t) {
    assert.ok(COLUMNS[t], 'create table ' + t + ' not found');
    var rows = TABLES[t] || [];
    assert.ok(rows.length, 'no demo rows for ' + t);
    rows.forEach(function (r) { sameSet(COLUMNS[t], Object.keys(r), 'demo ' + t + ' row ' + (r.id || r.case_id)); });
  });
  // service_jobs and service_events are v1 tables: every column this file
  // adds must be on the demo rows.
  var sev = d.events.filter(function (e) { return 'job_id' in e; });
  [['service_jobs', d.jobs], ['service_events', sev]].forEach(function (p) {
    (ADDED[p[0]] || []).forEach(function (c) {
      p[1].forEach(function (r) { assert.ok(c in r, 'demo ' + p[0] + ' row ' + r.id + ' lacks ' + c); });
    });
  });
});

test('the demo only uses values the SQL accepts', function () {
  var d = Demo.build(new Date(2026, 9, 21, 12, 0, 0).getTime());
  function ok(key, v, id) {
    if (v == null) return;
    var c = CHECKS[key];
    if (c) assert.ok(c.list.indexOf(v) !== -1, id + ': ' + key + ' "' + v + '" is refused by the CHECK');
  }
  d.units.forEach(function (u) {
    ['kind', 'diagnosed_by', 'purchase_source', 'vendor_result', 'fee_status', 'return_method', 'stage', 'disposition',
     'data_handling'].forEach(function (c) { ok('rma_cases.' + c, u[c], u.id); });
  });
  d.intakes.forEach(function (i) { ['source', 'sender_kind', 'return_method'].forEach(function (c) { ok('rma_intakes.' + c, i[c], i.id); }); });
  d.shipments.forEach(function (s) { ['mode', 'direction'].forEach(function (c) { ok('rma_shipments.' + c, s[c], s.id); }); });
  d.items.forEach(function (it) { ['kind', 'purchase_source'].forEach(function (c) { ok('service_items.' + c, it[c], it.id); }); });
  d.jobs.forEach(function (j) {
    ['stage', 'service_type', 'channel', 'category', 'priority', 'assigned_via', 'remote_tool', 'converted_from',
     'data_consent', 'outcome'].forEach(function (c) { ok('service_jobs.' + c, j[c], j.id); });
    assert.ok(caseLists('svc_stage_legal')[j.service_type].indexOf(j.stage) !== -1, j.id + ' stage legal in SQL');
  });
  d.events.filter(function (e) { return 'job_id' in e; }).forEach(function (e) {
    ok('service_events.kind', e.kind, e.id);
    ok('service_events.actor_kind', e.actor_kind, e.id);
  });
  assert.ok(CHECKS['service_events.kind'], 'the service_events kind list (folded at migration time) was not found');
  var tr = caseLists('rma_transition_ok');
  d.rma_events.forEach(function (e) {
    if (e.from_stage && e.to_stage) assert.ok((tr[e.from_stage] || []).indexOf(e.to_stage) !== -1, e.id + ' ' + e.from_stage + '>' + e.to_stage);
  });
});

warnings.forEach(function (w) { console.warn('WARN ' + w); });
console.log((failures ? 'FAILED' : 'OK') + ' sql-parity: ' + passed + ' passed, ' + failures + ' failed' +
            (warnings.length ? ', ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') : '') +
            ' (' + SQL_PATHS.map(function (p) { return path.basename(p); }).join(' + ') + ')');
process.exit(failures ? 1 : 0);
