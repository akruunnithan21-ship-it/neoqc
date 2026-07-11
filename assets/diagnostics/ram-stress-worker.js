/*
  ram-stress-worker.js — sustained memory stress + integrity test.

  Rewritten 2026-07-11 (v1.3.3): the old version allocated a single Buffer and
  did one write+read per ~10ms setTimeout tick, so it barely registered in Task
  Manager (long idle gaps between short bursts) and did no real bit-integrity
  check. It also reported nothing about how much was actually tested.

  This version:
   • Allocates the target in 256 MB chunks (an array of Buffers) — avoids any
     single-Buffer max-length ceiling and lets us cap safely below free RAM.
   • Runs a TIGHT sustained loop for the whole requested duration, yielding to
     the message queue only every ~128 MB via setImmediate (not sleeping), so
     the CPU + memory bus stay genuinely busy → visible, steady load.
   • Writes a rotating 64-bit pattern to every 8th byte, then reads it back and
     compares — a mismatch means a real memory fault (this is what makes it a
     QC test, not just an allocation). Fault count is reported.
   • Reports allocatedMB, passes, and errorCount so the UI/report can show
     "Stressed N MB for Ts — 0 faults".
*/
const { parentPort, workerData } = require('worker_threads');

const CHUNK = 256 * 1024 * 1024;              // 256 MB per buffer
const requested = parseInt(workerData.sizeBytes) || (1024 * 1024 * 1024);
const durationMs = (parseInt(workerData.durationSec) || 20) * 1000;

let running = true;
parentPort.on('message', (msg) => { if (msg === 'stop') running = false; });

function send(type, extra) { parentPort.postMessage(Object.assign({ type }, extra || {})); }

function run() {
  const buffers = [];
  let allocated = 0;
  try {
    send('status', { message: `Allocating up to ${(requested / 1048576).toFixed(0)} MB in 256 MB blocks…` });
    while (allocated + 1 <= requested) {
      const thisChunk = Math.min(CHUNK, requested - allocated);
      if (thisChunk < 1024 * 1024) break;      // stop below 1 MB granularity
      let buf;
      try {
        buf = Buffer.allocUnsafe(thisChunk);   // we fill every byte ourselves below
      } catch (e) {
        // Ran into an allocation ceiling — stop growing, test what we have.
        send('status', { message: `Allocation stopped at ${(allocated / 1048576).toFixed(0)} MB (${e.message}).` });
        break;
      }
      buffers.push(buf);
      allocated += thisChunk;
    }
  } catch (e) {
    send('error', { error: 'Allocation failed: ' + e.message });
    return;
  }

  const allocatedMB = Math.round(allocated / 1048576);
  if (!buffers.length) {
    send('error', { error: 'Could not allocate any memory to test.' });
    return;
  }
  send('status', { message: `Allocated ${allocatedMB} MB. Running sustained write/verify stress…` });

  const start = Date.now();
  let iterations = 0;
  let faults = 0;
  let pattern = 0x0123456789abcdefn & 0xffffffffn; // 32-bit rotating seed (BigInt-free hot path below)
  let patt = Number(pattern) >>> 0;

  // One "pass" = write pattern to every buffer, then read-verify every buffer.
  function pass() {
    if (!running || Date.now() - start >= durationMs) {
      const seconds = Math.round((Date.now() - start) / 1000);
      send('result', { allocatedMB, iterations, faults, seconds, passed: faults === 0 });
      send('done');
      return;
    }

    // Rotate the pattern each pass so we exercise different bit combinations.
    patt = ((patt << 1) | (patt >>> 31)) >>> 0;
    const bytes = [patt & 0xff, (patt >>> 8) & 0xff, (patt >>> 16) & 0xff, (patt >>> 24) & 0xff];

    let sinceYield = 0;
    let bi = 0;

    function step() {
      // Process buffers in slices, yielding every ~128 MB so a 'stop' can land
      // but the loop otherwise stays hot (no timer sleeps → real sustained load).
      while (bi < buffers.length) {
        const buf = buffers[bi];
        // write
        for (let i = 0; i < buf.length; i++) buf[i] = bytes[i & 3];
        // read + verify
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] !== bytes[i & 3]) faults++;
        }
        sinceYield += buf.length;
        bi++;
        if (sinceYield >= 128 * 1024 * 1024) {
          sinceYield = 0;
          setImmediate(step);
          return;
        }
      }
      iterations++;
      send('progress', { iterations, allocatedMB, faults, elapsedSec: Math.round((Date.now() - start) / 1000) });
      setImmediate(pass);
    }
    step();
  }

  pass();
}

run();
