/*
  Unit tests for service-qc-bench.js (1.16, QC after a service): the PresentMon
  CSV reader and the drive rules. The PowerShell probes need Windows and are
  checked by hand on the bench PC.
  Run: node tests/service-qc-bench.test.js   — exits 1 on any failure.
*/
'use strict';

var assert = require('assert');
var path = require('path');
var B = require(path.join(__dirname, '..', 'service-qc-bench.js'));

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + (e && e.message ? e.message : e)); }
}

// PresentMon 2.x default columns (CsvOutput.cpp, v2.6.0).
var V2 = 'Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,CPUStartTime,FrameTime,CPUBusy,CPUWait,GPULatency,GPUTime,GPUBusy,GPUWait,DisplayLatency,DisplayedTime';
function v2Row(app, pid, swap, ft, shown) {
  return [app, pid, swap, 'DXGI', 0, 0, 1, 'Hardware: Independent Flip', 0, ft, 1, 1, 1, 1, 1, 0, 5, shown].join(',');
}

test('v2: average FPS and 1% low from FrameTime', function () {
  var rows = [V2];
  for (var i = 0; i < 1000; i++) rows.push(v2Row('Game.exe', 10, '0x1', i % 100 === 0 ? 10 : 2, 2));
  var r = B.parsePresentMonCsv(rows.join('\n'));
  assert.strictEqual(r.frames, 1000);
  // 990 frames of 2 ms + 10 of 10 ms = 2.08 s → 480.8 fps
  assert.strictEqual(r.avgFps, 480.8);
  // the slowest 1% (10 frames) are all 10 ms → 100 fps
  assert.strictEqual(r.low1Fps, 100);
  assert.strictEqual(r.app, 'Game.exe');
  assert.strictEqual(r.pid, 10);
});

test('v2: keeps the swap chain with the most frames (overlay ignored)', function () {
  var rows = [V2];
  for (var i = 0; i < 300; i++) rows.push(v2Row('Game.exe', 10, '0x1', 4, 4));
  for (var j = 0; j < 60; j++) rows.push(v2Row('Overlay.exe', 22, '0x9', 16.6, 16.6));
  var r = B.parsePresentMonCsv(rows.join('\r\n'));
  assert.strictEqual(r.app, 'Game.exe');
  assert.strictEqual(r.avgFps, 250);
});

test('v1 metrics: msBetweenPresents / msBetweenDisplayChange', function () {
  var h = 'Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,Dropped,TimeInSeconds,msInPresentAPI,msBetweenPresents,AllowsTearing,PresentMode,msUntilRenderComplete,msUntilDisplayed,msBetweenDisplayChange';
  var rows = [h];
  for (var i = 0; i < 200; i++) rows.push(['g.exe', 5, '0x2', 'DXGI', 0, 0, 0, i, 0.1, 10, 1, 'x', 1, 1, 10].join(','));
  var r = B.parsePresentMonCsv(rows.join('\n'));
  assert.strictEqual(r.avgFps, 100);
  assert.strictEqual(r.displayedFps, 100);
});

test('too few frames, empty file, missing column → no result', function () {
  var rows = [V2];
  for (var i = 0; i < 10; i++) rows.push(v2Row('Game.exe', 1, '0x1', 5, 5));
  assert.ok(B.parsePresentMonCsv(rows.join('\n')).frames < 30);
  assert.strictEqual(B.parsePresentMonCsv('').frames, 0);
  assert.strictEqual(B.parsePresentMonCsv('Application,ProcessID\nx,1').frames, 0);
});

test('bad frame times are skipped', function () {
  var rows = [V2];
  for (var i = 0; i < 100; i++) rows.push(v2Row('Game.exe', 1, '0x1', 5, 5));
  rows.push(v2Row('Game.exe', 1, '0x1', 'NA', 5));
  rows.push(v2Row('Game.exe', 1, '0x1', -3, 5));
  rows.push(v2Row('Game.exe', 1, '0x1', 99999, 5));
  var r = B.parsePresentMonCsv(rows.join('\n'));
  assert.strictEqual(r.frames, 100);
  assert.strictEqual(r.avgFps, 200);
});

test('drives: healthy, worn, warning, errors, hot', function () {
  assert.deepStrictEqual(B.judgeDisk({ health: 'Healthy', wear: 3, tempC: 40, readErrors: 0, writeErrors: 0 }), { level: 'ok', notes: [] });
  assert.strictEqual(B.judgeDisk({ health: 'Healthy', wear: 75 }).level, 'warn');
  assert.strictEqual(B.judgeDisk({ health: 'Healthy', wear: 95 }).level, 'bad');
  assert.strictEqual(B.judgeDisk({ health: 'Warning' }).level, 'warn');
  assert.strictEqual(B.judgeDisk({ health: 'Unhealthy' }).level, 'bad');
  assert.strictEqual(B.judgeDisk({ health: 'Healthy', readErrors: 2 }).level, 'warn');
  assert.strictEqual(B.judgeDisk({ health: 'Healthy', tempC: 72 }).level, 'warn');
  assert.strictEqual(B.judgeDisk({ health: 'Healthy' }).level, 'ok');
});

test('median', function () {
  assert.strictEqual(B.median([3, 1, 2]), 2);
  assert.strictEqual(B.median([4, 1, 2, 3]), 2.5);
  assert.strictEqual(B.median([]), null);
});

// Bad inputs are refused before PowerShell starts.
Promise.all([
  B.whea('2026-11-25; Remove-Item C:\\'),
  B.appCrashes({ sinceIso: 'yesterday', exeName: 'x.exe' })
]).then(function (r) {
  test('bad times never reach PowerShell', function () {
    assert.strictEqual(r[0].ok, false);
    assert.strictEqual(r[1].ok, false);
  });
  console.log('service-qc-bench: ' + passed + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
});
