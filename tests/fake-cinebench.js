/*
  A stand-in for Cinebench.exe, used by tests/cinebench.test.js to drive
  cinebench.js run() without a 10-minute benchmark.
  Usage: node fake-cinebench.js <logPath> <behaviour>
    score-then-stay  write a real-looking log with a result line, then stay open
                     (what R23.200 did in testing)
    score-then-exit  same, then exit 0
    crash            write the start of a log, then exit 1 with no result
    hang             write nothing and never exit
    stall            start up, then sit idle before "Rendering" (seen once with
                     real R23 on 2026-11-14)
    stall-once       stall on the first launch only, then behave like
                     score-then-stay (uses a marker file next to the log)
    slow-then-stay   like score-then-stay, but the render takes 5 s
*/
'use strict';
var fs = require('fs');
var path = require('path');
var logPath = process.argv[2];
var behaviour = process.argv[3];

function w(s) { fs.appendFileSync(logPath, s); }

if (behaviour === 'stall-once') {
  var marker = path.join(path.dirname(logPath), 'stall-once.marker');
  if (fs.existsSync(marker)) behaviour = 'score-then-stay';
  else { fs.writeFileSync(marker, '1'); behaviour = 'stall'; }
}

if (behaviour === 'hang') {
  setInterval(function () {}, 1000);
} else if (behaviour === 'stall') {
  w('CINEBENCH started\r\nDrawport API initialized\r\n    Driver version   : 1.2.3\r\n');
  setInterval(function () {}, 1000);
} else {
  w('Output logged to       : file:///' + logPath.replace(/\\/g, '/') + '\r\n');
  w('CINEBENCH started\r\nCINEBENCH AUTORUN\r\nRunning Multiple CPU Render Test...\r\nRendering...\r\n');
  if (behaviour === 'crash') {
    process.exit(1);
  } else {
    setTimeout(function () {
      w('Values: {8123.456} -> Avg/Deviation: 8123.456/0.000\r\nCB 8123.46 (0.00)\r\n \r\n');
      if (behaviour === 'score-then-exit') setTimeout(function () { process.exit(0); }, 50);
      else setInterval(function () {}, 1000);   // stays open, like R23
    }, behaviour === 'slow-then-stay' ? 5000 : 300);
  }
}
