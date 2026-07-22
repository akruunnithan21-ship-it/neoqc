const fs = require('fs');
const path = require('path');
const mode = process.argv[2] || 'client';

// v1.8.4 — BUILD-TIME ENCODING GUARD. In 1.8.3, a PowerShell round-trip
// (Get-Content | Set-Content -Encoding utf8) read index.html's emoji as ANSI and
// re-wrote them, double-encoding the whole file into mojibake that shipped to
// users. This preflight makes that class of accident impossible to package: any
// text asset that has been double-encoded (many 0xC3 lead bytes and NO genuine
// 4-byte emoji, the exact fingerprint of the corruption) aborts the build.
function assertNoMojibake(files) {
  const bad = [];
  for (const rel of files) {
    const fp = path.join(__dirname, rel);
    if (!fs.existsSync(fp)) continue;
    const buf = fs.readFileSync(fp);
    let c3 = 0, f0 = 0;
    for (const b of buf) { if (b === 0xC3) c3++; else if (b === 0xF0) f0++; }
    // Healthy files with emoji have real 4-byte sequences (0xF0) and few 0xC3.
    // Double-encoded UTF-8 turns every emoji lead byte into a 0xC3 run and
    // eliminates 0xF0 entirely.
    if (c3 > 20 && f0 === 0) bad.push(`${rel} (0xC3=${c3}, 0xF0=${f0})`);
  }
  if (bad.length) {
    console.error('\n  BUILD ABORTED — text encoding corruption (mojibake) detected in:');
    bad.forEach(b => console.error('    - ' + b));
    console.error('  These files are double-encoded UTF-8 and would render as gibberish.');
    console.error('  Restore them from a clean git revision before building.\n');
    process.exit(1);
  }
  console.log('Encoding guard passed — no mojibake in text assets.');
}
assertNoMojibake(['index.html', 'customer.html', 'sales.html', 'app.js', 'main.js', 'style.css', 'print-report.css', 'print-render.js']);

const configPath = path.join(__dirname, 'app-config.json');
fs.writeFileSync(configPath, JSON.stringify({ mode }, null, 2), 'utf-8');
console.log(`Successfully configured app-config.json for: ${mode} mode`);
