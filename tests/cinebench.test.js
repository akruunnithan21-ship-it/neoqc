/*
  Unit tests for cinebench.js: how Neo OS launches Cinebench R23 and reads its
  score (Neo OS 1.12.5). Run: node tests/cinebench.test.js — exits 1 on any failure.

  fixtures/cinebench-r23-multi.log is a real R23.200 log written with
  g_logFile= (module-loading lines trimmed; computer name, OS identifier and
  user paths replaced). Its 1286 is low only because that dev laptop was busy
  compiling during the run. The format is what matters here.
*/
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var { spawnSync } = require('child_process');
var CB = require(path.join(__dirname, '..', 'cinebench.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

var REAL_LOG = fs.readFileSync(path.join(__dirname, 'fixtures', 'cinebench-r23-multi.log'));

test('the real R23 log gives its score', function () {
  var r = CB.parseLog(CB.decodeLog(REAL_LOG));
  assert.strictEqual(r.score, 1286);   // "CB 1286.90 (0.00)"
  assert.ok(/^CB\s/.test(r.line), 'result line should start with CB: ' + r.line);
  assert.strictEqual(r.reason, null);
});

test('the score is whole points, the way R23 shows it', function () {
  assert.strictEqual(CB.parseLog('CINEBENCH started\nRendering...\nCB 4748.92 (0.00)\n').score, 4748);
  assert.strictEqual(CB.parseLog('CB 15240 (0.00)').score, 15240);
  assert.strictEqual(CB.parseLog('   CB   1590.4 (0.00)').score, 1590);
});

test('a comma decimal is read as a decimal, not as thousands', function () {
  assert.strictEqual(CB.parseLog('CB 4748,92 (0,00)').score, 4748);
});

test('with two result lines (all tests), the last one wins', function () {
  var r = CB.parseLog('Running Multiple CPU Render Test...\nCB 16392.10 (0.00)\nRunning Single CPU Render Test...\nCB 1590.55 (0.00)\n');
  assert.strictEqual(r.score, 1590);
});

test('numbers elsewhere in the log are never taken as the score', function () {
  var noise = [
    'Loading file:///C:/Program Files/NeoQC/Cinebench/corelibs/cb64.xdl64 with module(s) net.maxon.cb',
    'CINEBENCH started',
    '    Driver version   : 23.19.24.12-260612a-202329C-Clevo',
    'Minimum test duration: 600000.0 ms seconds.',
    'Rendering...',
    'Score 99999 pts',          // not R23's result line
    'MCB 12345 (0.00)',         // CB must start the line
  ].join('\n');
  var r = CB.parseLog(noise);
  assert.strictEqual(r.score, null);
  assert.ok(/stopped before printing a result/.test(r.reason), r.reason);
});

test('an empty or missing log says Cinebench never wrote anything', function () {
  assert.ok(/wrote nothing/.test(CB.parseLog('').reason));
  assert.ok(/wrote nothing/.test(CB.parseLog(CB.decodeLog(null)).reason));
});

test('a log that stops while loading says it never finished starting', function () {
  var r = CB.parseLog('Loading file:///A:/x/corelibs/a.xdl64 with module(s) a\nSome warning\n');
  assert.ok(/did not finish starting/.test(r.reason), r.reason);
  assert.deepStrictEqual(r.tail, ['Some warning']);
});

test('UTF-16 logs (with or without a BOM) still parse', function () {
  var text = 'CINEBENCH started\r\nRendering...\r\nCB 8123.45 (0.00)\r\n';
  var le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.strictEqual(CB.parseLog(CB.decodeLog(le)).score, 8123);
  assert.strictEqual(CB.parseLog(CB.decodeLog(Buffer.from(text, 'utf16le'))).score, 8123);
  var be = Buffer.from(text, 'utf16le'); be.swap16();
  assert.strictEqual(CB.parseLog(CB.decodeLog(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).score, 8123);
  var bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  assert.strictEqual(CB.parseLog(CB.decodeLog(bom8)).score, 8123);
});

test('a log still being written: only finished lines count', function () {
  assert.strictEqual(CB.resultSoFar('CINEBENCH started\nRendering...\n'), null);
  assert.strictEqual(CB.resultSoFar('Rendering...\nCB 12'), null);          // half-written line
  assert.strictEqual(CB.resultSoFar('Rendering...\nCB 1286.90 (0.00)\r\n'), 1286);
  assert.strictEqual(CB.resultSoFar(''), null);
  assert.strictEqual(CB.resultSoFar(CB.decodeLog(REAL_LOG)), CB.parseLog(CB.decodeLog(REAL_LOG)).score);
});

test('arguments: one test flag, the log file, no wait at exit — and no shell', function () {
  var multi = CB.buildArgs({ logPath: 'C:\\Users\\A B\\AppData\\Roaming\\neo-qc\\logs\\cinebench-last.log' });
  assert.deepStrictEqual(multi, [
    'g_cinebenchCpuXTest=true',
    'g_logFile=C:\\Users\\A B\\AppData\\Roaming\\neo-qc\\logs\\cinebench-last.log',
    'g_consoleWaitOnEnd=false',
  ]);
  assert.strictEqual(CB.buildArgs({ singleCore: true, logPath: 'x.log' })[0], 'g_cinebenchCpu1Test=true');
  assert.ok(!multi.some(function (a) { return /[<>|&]/.test(a); }), 'no shell redirection in the arguments');
  assert.throws(function () { CB.buildArgs({}); }, /logPath/);
});

// The bug this release fixes: Node escapes the quotes in a cmd.exe /c command
// line, so `"exe" args > "log"` never ran. This pins that down, so nobody puts
// the shell back. Windows only.
test('regression: the old cmd.exe /c launch line is broken by Node quoting', function () {
  if (process.platform !== 'win32') return;
  var exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe');
  var out = path.join(require('os').tmpdir(), 'neoqc cb-regression.txt');
  try { fs.unlinkSync(out); } catch (e) {}
  var r = spawnSync('cmd.exe', ['/c', '"' + exe + '" > "' + out + '"'], { windowsHide: true, encoding: 'utf8' });
  assert.ok(!fs.existsSync(out), 'cmd.exe ran the quoted command; the old launch would have worked');
  assert.notStrictEqual(r.status, 0, 'expected cmd.exe to fail (English Windows says "syntax is incorrect"): ' + r.stderr);
});

// ── run(): the whole launch → watch → close → read flow, with a fake Cinebench ──
var os = require('os');
var FAKE = path.join(__dirname, 'fake-cinebench.js');
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neoqc cb-test-'));   // a space, like Program Files

function runFake(behaviour, extra) {
  var logPath = path.join(TMP, behaviour + '.log');
  var msgs = [];
  var opts = Object.assign({
    exe: process.execPath,
    args: [FAKE, logPath, behaviour],
    logPath: logPath,
    ceilingSec: 10, graceSec: 0.3, pollMs: 100,
    windowsHide: true,
    onLog: function (m) { msgs.push(m); },
  }, extra || {});
  return CB.run(opts).then(function (r) { r.msgs = msgs; return r; });
}

async function asyncTest(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

(async function () {
  await asyncTest('run: a Cinebench that stays open after its result is closed, and the score kept', async function () {
    var t0 = Date.now();
    var r = await runFake('score-then-stay');
    assert.strictEqual(r.score, 8123);
    assert.strictEqual(r.how, 'closed after its result');
    assert.ok(Date.now() - t0 < 8000, 'should not wait for the ceiling');
    assert.ok(r.msgs.some(function (m) { return /printed its result/.test(m); }), r.msgs.join('\n'));
  });

  await asyncTest('run: a Cinebench that exits by itself after its result', async function () {
    var r = await runFake('score-then-exit', { graceSec: 30 });
    assert.strictEqual(r.score, 8123);
  });

  await asyncTest('run: a crash before the result is NOT MEASURED, with the reason and the log tail', async function () {
    var r = await runFake('crash');
    assert.strictEqual(r.score, null);
    assert.strictEqual(r.how, 'exit code 1');
    assert.ok(/stopped before printing a result/.test(r.reason), r.reason);
    assert.ok(r.msgs.some(function (m) { return /last lines: .*Rendering/.test(m); }), r.msgs.join('\n'));
    assert.ok(r.msgs.some(function (m) { return m.indexOf(r.logPath) >= 0; }), 'should say where the full log is');
  });

  await asyncTest('run: a hang is killed at the ceiling and reported, not waited on forever', async function () {
    var t0 = Date.now();
    var r = await runFake('hang', { ceilingSec: 1 });
    assert.strictEqual(r.score, null);
    assert.strictEqual(r.how, 'ceiling reached');
    assert.ok(/wrote nothing/.test(r.reason), r.reason);
    assert.ok(Date.now() - t0 < 8000);
  });

  await asyncTest('run: stuck before rendering once → closed, started again, score kept', async function () {
    var r = await runFake('stall-once', { startupSec: 3, retries: 1 });
    assert.strictEqual(r.score, 8123);
    assert.strictEqual(r.attempts, 2);
    assert.ok(r.msgs.some(function (m) { return /starting it again \(attempt 2 of 2\)/.test(m); }), r.msgs.join('\n'));
  });

  await asyncTest('run: stuck every time → gives up after the retry, NOT MEASURED with the reason', async function () {
    var t0 = Date.now();
    var r = await runFake('stall', { startupSec: 3, retries: 1, ceilingSec: 60 });
    assert.strictEqual(r.score, null);
    assert.strictEqual(r.how, 'stuck starting up');
    assert.strictEqual(r.attempts, 2);
    assert.ok(/never ran the CPU test/.test(r.reason), r.reason);
    assert.ok(Date.now() - t0 < 30000, 'should not wait for the ceiling');
  });

  await asyncTest('run: a slow but healthy render is NOT restarted', async function () {
    // slow-then-stay prints "Rendering..." at once and its result 5 s later;
    // a startup limit shorter than the whole render must not cut it off.
    var r = await runFake('slow-then-stay', { startupSec: 3, retries: 1, ceilingSec: 60 });
    assert.strictEqual(r.score, 8123);
    assert.strictEqual(r.attempts, 1);
  });

  await asyncTest('run: a missing Cinebench.exe resolves (never hangs) as NOT MEASURED', async function () {
    var r = await CB.run({ exe: path.join(TMP, 'no-such', 'Cinebench.exe'), logPath: path.join(TMP, 'missing.log'), ceilingSec: 10 });
    assert.strictEqual(r.score, null);
    assert.strictEqual(r.how, 'not started');
    assert.ok(/failed to start/.test(r.reason), r.reason);
  });

  await asyncTest('run: an old log from an earlier run is never read as this run\'s score', async function () {
    var logPath = path.join(TMP, 'crash.log');
    fs.writeFileSync(logPath, 'CINEBENCH started\r\nRendering...\r\nCB 99999.00 (0.00)\r\n');
    var r = await runFake('crash');
    assert.strictEqual(r.score, null, 'read a stale score');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed  (cinebench)');
  if (failures) process.exit(1);
})();
