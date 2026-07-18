/*
  compat-check.js — background component-compatibility ("synergy") checker.
  Given the target build specs (free-text component names), it extracts the key
  platform attributes and flags disparities a technician should notice:
    • CPU socket vs motherboard socket (AM5 vs AM4, LGA1700 vs LGA1200, …)
    • RAM generation vs motherboard / CPU platform (DDR4 in a DDR5 board, …)

  Heuristic + name-based (the specs are retail names, not structured fields), so
  it errs toward only flagging confident mismatches. Loaded via <script> in the
  renderer; browser-safe UMD (window.NeoQcCompat) + Node export for tests.
*/
(function () {
  // ---- CPU name → platform ------------------------------------------------
  function cpuPlatform(name) {
    var n = (name || '').toLowerCase();
    if (!n) return null;
    // AMD Ryzen: series digit drives the socket (7000/8000/9000 → AM5; 1000–5000 → AM4)
    if (/\bryzen\b/.test(n) || /\bthreadripper\b/.test(n)) {
      var mAmd = /\bryzen\s+\d\s+(\d)\d{3}/.exec(n) || /\bryzen\s+\d\s+(\d)\d{2}\b/.exec(n) || /\b(\d)\d{3}\s*(x3d|xt|x|g|ge|f)?\b/.exec(n);
      var series = mAmd ? parseInt(mAmd[1], 10) : null;
      if (series === 7 || series === 8 || series === 9) return { brand: 'amd', socket: 'AM5', ramGen: 'DDR5' };
      if (series >= 1 && series <= 5) return { brand: 'amd', socket: 'AM4', ramGen: 'DDR4' };
      return { brand: 'amd', socket: null, ramGen: null };
    }
    // Intel Core: generation from the model (i7-14700 → 14; i5-12400 → 12)
    if (/\bcore\s*(ultra\s*)?i[3579]\b/.test(n) || /\bintel\b/.test(n) || /\bcore\s*ultra\b/.test(n)) {
      var mi = /\bi[3579][- ]?(\d{2})\d{2,3}/.exec(n);
      var gen = mi ? parseInt(mi[1], 10) : null;
      if (/\bcore\s*ultra\b/.test(n)) return { brand: 'intel', socket: 'LGA1851', ramGen: 'DDR5' };
      if (gen === 12 || gen === 13 || gen === 14) return { brand: 'intel', socket: 'LGA1700', ramGen: null }; // DDR4 or DDR5
      if (gen === 10 || gen === 11) return { brand: 'intel', socket: 'LGA1200', ramGen: 'DDR4' };
      if (gen >= 15) return { brand: 'intel', socket: 'LGA1851', ramGen: 'DDR5' };
      return { brand: 'intel', socket: null, ramGen: null };
    }
    return null;
  }

  // ---- Motherboard name → platform ---------------------------------------
  function moboPlatform(name) {
    var n = (name || '').toLowerCase();
    if (!n) return null;
    // Chipset codes carry suffixes (B760M micro-ATX, X670E, B650E, Z790-A …),
    // so we match the code as a prefix (leading \b, no trailing \b).
    // AMD chipsets
    if (/\b(b650|x670|a620|b840|x870|b850)/.test(n)) return { socket: 'AM5', ramGen: 'DDR5' };
    if (/\b(b450|b550|x570|a520|x470|a320|b350|x370)/.test(n)) return { socket: 'AM4', ramGen: 'DDR4' };
    // Intel chipsets
    if (/\b(b860|z890|h810)/.test(n)) return { socket: 'LGA1851', ramGen: 'DDR5' };
    if (/\b(b660|b760|z690|z790|h610|h670|h770)/.test(n)) {
      var ram = /ddr5/.test(n) ? 'DDR5' : (/ddr4/.test(n) ? 'DDR4' : null);
      return { socket: 'LGA1700', ramGen: ram };
    }
    if (/\b(b460|b560|z490|z590|h510|h410|h470)/.test(n)) return { socket: 'LGA1200', ramGen: 'DDR4' };
    return null;
  }

  function ramGen(name) {
    var n = (name || '').toLowerCase();
    if (/\bddr5\b/.test(n)) return 'DDR5';
    if (/\bddr4\b/.test(n)) return 'DDR4';
    if (/\bddr3\b/.test(n)) return 'DDR3';
    return null;
  }

  // ---- Run all checks -----------------------------------------------------
  // specs: { cpu, gpu, mobo|motherboard, ram, ... } free-text names.
  // Returns [{ level:'error'|'warn', parts:[...], msg }]
  function check(specs) {
    specs = specs || {};
    var warnings = [];
    var cpu = cpuPlatform(specs.cpu);
    var mobo = moboPlatform(specs.mobo || specs.motherboard);
    var rg = ramGen(specs.ram);

    if (cpu && mobo && cpu.socket && mobo.socket && cpu.socket !== mobo.socket) {
      warnings.push({ level: 'error', parts: ['CPU', 'Motherboard'],
        msg: 'CPU socket ' + cpu.socket + ' does not match the ' + mobo.socket + ' motherboard.' });
    }
    if (rg && mobo && mobo.ramGen && rg !== mobo.ramGen) {
      warnings.push({ level: 'error', parts: ['RAM', 'Motherboard'],
        msg: rg + ' RAM will not fit a ' + mobo.ramGen + '-only motherboard.' });
    }
    // Only warn on CPU↔RAM if there is no board to be the authority (or board ram unknown).
    if (rg && cpu && cpu.ramGen && rg !== cpu.ramGen && !(mobo && mobo.ramGen)) {
      warnings.push({ level: 'warn', parts: ['RAM', 'CPU'],
        msg: 'The ' + cpu.socket + ' platform typically uses ' + cpu.ramGen + ', but the RAM is ' + rg + '.' });
    }
    return warnings;
  }

  var api = { check: check, cpuPlatform: cpuPlatform, moboPlatform: moboPlatform, ramGen: ramGen };
  if (typeof window !== 'undefined') window.NeoQcCompat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
