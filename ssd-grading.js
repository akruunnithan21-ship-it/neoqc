/*
  ssd-grading.js — generation-aware SSD verdict + diagnostics.

  The old QC report failed any SSD that didn't hit a single flat threshold
  (3000 MB/s read / 2500 MB/s write). A SATA SSD topping out at ~550 MB/s
  looked like a catastrophic failure; a Gen5 drive doing 7000 MB/s looked
  fine when it should really be 12000+. This module fixes both:

    • Detects the drive class (SATA, NVMe Gen3/4/5 × width) from ssdHealth's
      new fields (busType + pcieCurrentGen + pcieCurrentWidth + expectedMBps).
    • Grades measured read/write against class-appropriate tiers.
    • Explains WHY performance may be lower than expected: the drive
      negotiated a lower PCIe generation than it supports, the M.2 slot is
      wired at fewer lanes, thermal throttle during the run, SLC-cache
      exhaustion (workload longer than the drive's fast-write pool).

  Pure function. No DOM, no IPC. Consumed by print-render.js (report),
  diagnostics-render.js (in-app card) and dashboard/app.js.
*/
(function (global) {
  'use strict';

  // Practical sequential-read tiers by drive class. Numbers are conservative
  // "healthy floor" values based on real-world reviews and datasheet minima —
  // a drive above this tier is considered "at spec" for its generation.
  var TIERS = {
    sata:    { name: 'SATA III',              readOK: 480,  writeOK: 380  },
    nvme3x2: { name: 'NVMe PCIe 3.0 x2',      readOK: 1500, writeOK: 900  },
    nvme3x4: { name: 'NVMe PCIe 3.0 x4',      readOK: 2800, writeOK: 2200 },
    nvme4x2: { name: 'NVMe PCIe 4.0 x2',      readOK: 3200, writeOK: 2500 },
    nvme4x4: { name: 'NVMe PCIe 4.0 x4',      readOK: 6000, writeOK: 4500 },
    nvme5x2: { name: 'NVMe PCIe 5.0 x2',      readOK: 6000, writeOK: 4500 },
    nvme5x4: { name: 'NVMe PCIe 5.0 x4',      readOK: 11500, writeOK: 9000 }
  };

  function classify(health) {
    if (!health) return { key: null, label: 'Unknown', tier: null };
    var bus = (health.busType || health.bus_type || '').toString().toLowerCase();
    if (bus === 'sata' || bus === 'ata' || health.mediaType === 'SSD' && !bus.includes('nvme') && !health.pcieCurrentGen) {
      return { key: 'sata', label: TIERS.sata.name, tier: TIERS.sata };
    }
    if (bus === 'nvme' || bus === 'pcie' || health.mediaType === 'NVMe SSD') {
      var gen = health.pcieCurrentGen || health.pcieMaxGen || 3;
      var width = health.pcieCurrentWidth || health.pcieMaxWidth || 4;
      var key = 'nvme' + gen + 'x' + (width >= 4 ? 4 : 2);
      var t = TIERS[key] || TIERS.nvme4x4;
      return { key: key, label: t.name, tier: t };
    }
    return { key: null, label: (health.mediaType || 'Unknown'), tier: null };
  }

  // Verdict + human explanation. Returns { readVerdict, writeVerdict,
  // classLabel, expectedMBps, reasons: [] }.
  function grade(health, ssdRead, ssdWrite) {
    var cls = classify(health);
    var tier = cls.tier;
    var reasons = [];

    // Sub-generation negotiation ("Gen4 drive running at Gen3"): worth
    // highlighting even if speeds land OK, because a customer with a Gen4
    // drive in a Gen3 slot is losing peak throughput they paid for.
    if (health && health.pcieCurrentGen && health.pcieMaxGen && health.pcieCurrentGen < health.pcieMaxGen) {
      reasons.push('Drive is Gen' + health.pcieMaxGen + '-capable but negotiated at Gen' + health.pcieCurrentGen +
                   ' — likely a slot / motherboard limit. Peak throughput is halved per generation drop.');
    }
    if (health && health.pcieCurrentWidth && health.pcieMaxWidth && health.pcieCurrentWidth < health.pcieMaxWidth) {
      reasons.push('Only ' + health.pcieCurrentWidth + ' PCIe lanes active (drive supports ' + health.pcieMaxWidth +
                   '). Common when the slot shares lanes with a second M.2 or GPU.');
    }

    if (!tier || ssdRead == null || ssdWrite == null) {
      return {
        readVerdict: null, writeVerdict: null,
        classLabel: cls.label, expectedMBps: (health && health.expectedMBps) || null,
        reasons: reasons
      };
    }

    var readVerdict = ssdRead >= tier.readOK ? 'pass' : 'below';
    var writeVerdict = ssdWrite >= tier.writeOK ? 'pass' : 'below';

    // If either is below the class floor, add likely-cause hints so the shop
    // knows where to look next (thermal, cache, cable, firmware).
    if (readVerdict === 'below' || writeVerdict === 'below') {
      if (cls.key && cls.key.indexOf('nvme') === 0) {
        reasons.push('NVMe below-tier read/write is usually one of: (a) thermal throttle (add a heatsink), (b) writing beyond the drive’s SLC cache on a sustained test, (c) drive firmware out of date, (d) M.2 slot wired to chipset instead of CPU-direct lanes.');
      } else if (cls.key === 'sata') {
        reasons.push('SATA below-tier speeds: check the SATA cable/port (AHCI vs RAID mode), verify the drive is on a 6 Gbps port not a 3 Gbps one, and confirm no drive-power-saving policy is throttling it.');
      }
    }

    if (reasons.length === 0) reasons.push('Speeds are within the healthy range for a ' + cls.label + ' drive.');

    return {
      readVerdict: readVerdict, writeVerdict: writeVerdict,
      classLabel: cls.label, expectedMBps: (health && health.expectedMBps) || null,
      readOK: tier.readOK, writeOK: tier.writeOK,
      reasons: reasons
    };
  }

  var api = { grade: grade, classify: classify, TIERS: TIERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') global.NeoQcSsdGrade = api;
})(typeof window !== 'undefined' ? window : this);
