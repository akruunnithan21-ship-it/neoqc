/*
  shared/bench-match.js — "is this the right PC?" for the Bench (Neo OS 1.12.4)

  The stress tests and benchmarks measure the PC Neo OS is running on. Since
  1.12.4 a QC person can test any build, so before a run the Bench compares
  this PC's processor and graphics card (sys:detect-hw) with the build's specs
  and asks before saving results onto a build that looks like a different PC.

  It is a guard against the wrong PC, not a spec check: two parts match when
  they share a model number (the first run of 3+ digits in a word, so
  "i7-14700K" and "Core i7 14700KF" both read as 14700). Anything it can't read
  (no model number in the spec, detection failed) is "can't tell", never a
  mismatch.

  Usage (window.NeoBenchMatch in the app; require() in tests):
    B.compare({ cpu, gpu, igpu, dgpu }, { cpu, gpu })
      → { match: true | false | null, checked: ['cpu', 'gpu'], mismatches: [{ part, here, build }] }
*/
(function (global) {
  'use strict';

  function text(v) { return v == null ? '' : String(v).trim(); }

  // Real values only: detection placeholders and "None" read as nothing.
  function known(v) {
    var s = text(v);
    if (!s) return '';
    if (/^(none|n\/a|--|-)$/i.test(s) || /failed to detect|detection error/i.test(s)) return '';
    return s;
  }

  // "Intel(R) Core(TM) i7-14700K" → ['14700']; "RTX 4070 Super 12GB" → ['4070'].
  function modelNumbers(s) {
    var words = String(s || '').toLowerCase()
      .replace(/\((r|tm|c)\)/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ');
    var out = [];
    words.forEach(function (w) {
      var m = w.match(/\d{3,}/);
      if (m && out.indexOf(m[0]) === -1) out.push(m[0]);
    });
    return out;
  }

  function shares(a, b) {
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) return true;
    return false;
  }

  function compare(detected, specs) {
    var d = detected || {};
    var s = specs || {};
    var res = { match: null, checked: [], mismatches: [] };

    var hereCpu = known(d.cpu);
    var hereCpuNums = modelNumbers(hereCpu);
    // Detection failed or unreadable: can't tell, never block a run.
    if (!hereCpuNums.length) return res;

    var buildCpu = known(s.cpu);
    var buildCpuNums = modelNumbers(buildCpu);
    if (buildCpuNums.length) {
      res.checked.push('cpu');
      if (!shares(buildCpuNums, hereCpuNums)) {
        res.mismatches.push({ part: 'Processor', here: hereCpu, build: buildCpu });
      }
    }

    var buildGpu = known(s.gpu);
    var buildGpuNums = modelNumbers(buildGpu);
    if (buildGpuNums.length) {
      var hereGpus = [known(d.dgpu), known(d.igpu), known(d.gpu)].filter(Boolean);
      res.checked.push('gpu');
      if (!shares(buildGpuNums, modelNumbers(hereGpus.join(' ')))) {
        res.mismatches.push({ part: 'Graphics', here: hereGpus[0] || 'no graphics card found', build: buildGpu });
      }
    }

    if (res.mismatches.length) res.match = false;
    else if (res.checked.length) res.match = true;
    return res;
  }

  var api = { compare: compare, modelNumbers: modelNumbers };

  // ALWAYS set the browser global when a window exists (Electron renderers
  // define `module` too — see shared/matcher.js).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoBenchMatch = api;
  }
})(typeof window !== 'undefined' ? window : this);
