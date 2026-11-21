/*
  Sample tickets for the preview mode (open the site with ?demo). Loaded only
  then. Each record has the exact shape the database functions return
  (get_build_public, get_service_public, get_rma_public), so the preview runs
  the real rendering code. Every sample uses the phone digits 1234.
*/
(function () {
  'use strict';
  var NOW = Date.now(), MIN = 60000, HOUR = 3600000, DAY = 86400000;
  function ago(m) { return new Date(NOW - m * MIN).toISOString(); }
  function ahead(m) { return new Date(NOW + m * MIN).toISOString(); }
  // A shop-time (India) moment N days from today at h:mm.
  function atIST(days, h, mi) {
    var d = new Date(NOW + 330 * MIN);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, h, mi || 0) - 330 * MIN).toISOString();
  }
  var temps = [];
  var seed = 7;
  for (var i = 0; i < 60; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    temps.push(Math.round(Math.min(80, 42 + 37 * (1 - Math.exp(-i / 6)) + (seed / 233280 - 0.5) * 2.4) * 10) / 10);
  }
  temps[47] = 81;

  window.NEO_TRACKER_DEMO = {
    pin: '1234',
    chips: [
      { code: '7F3A2C', label: 'Build in testing' },
      { code: '9E1B4D', label: 'Build ready' },
      { code: 'NT-4K7Q2M9X', label: 'Repair needs your OK' },
      { code: 'NT-9RTW3HXD', label: 'Home visit booked' },
      { code: 'RM-7H2D4L9C', label: 'Warranty part' },
      { code: 'K4LGCY', label: 'Older build' }
    ],
    build: {
      '7F3A2C': {
        code: '7F3A2C', full: true, status: 'qc_testing', type: 'build', first_name: 'Arjun', technician: 'Athul',
        created_at: ago(3 * 1440 + 180), deadline: atIST(2, 18), completed_at: null,
        steps: [
          { at: ago(95), step: 'qc_testing' },
          { at: ago(160), step: 'waiting_qc' },
          { at: ago(1440 + 300), step: 'building' },
          { at: ago(2 * 1440 + 120), step: 'parts_in' },
          { at: ago(3 * 1440 + 180), step: 'created' }
        ],
        qc: {
          cpu: { model: 'AMD Ryzen 7 9700X', cores: 8, threads: 16, temp_max: 76 },
          ram: { total_gb: 32, gen: 'DDR5', errors: 0 },
          storage: { model: 'WD Black SN850X 1TB', size_gb: 1000, life_remaining: 100 },
          ports: { usb_controllers: 3, video_outputs: 4, audio_endpoints: 3 }
        }
      },
      '9E1B4D': {
        code: '9E1B4D', full: true, status: 'completed', type: 'build', first_name: 'Nikhil', technician: 'Sreeraj',
        created_at: ago(5 * 1440 + 100), deadline: ago(-1440), completed_at: ago(260),
        steps: [
          { at: ago(260), step: 'completed' },
          { at: ago(1440 + 60), step: 'qc_testing' },
          { at: ago(1440 + 240), step: 'waiting_qc' },
          { at: ago(2 * 1440 + 300), step: 'building' },
          { at: ago(4 * 1440), step: 'parts_in' },
          { at: ago(5 * 1440 + 100), step: 'created' }
        ],
        qc: {
          cpu_temp_max: 81, cpu_temp_avg: 74, gpu_temp_max: 72, cinebench: 42850, ram_stress: 'passed',
          cpu: { model: 'AMD Ryzen 9 9950X', cores: 16, threads: 32, temp_max: 81 },
          gpu: { model: 'NVIDIA GeForce RTX 5080', vram: '16 GB', temp_max: 72 },
          ram: { total_gb: 64, gen: 'DDR5', errors: 0 },
          storage: { model: 'Samsung 990 Pro 2TB', size_gb: 2000, life_remaining: 100 },
          prime95: { result: 'pass', minutes: 60, errors: 0 },
          ports: { usb_controllers: 4, video_outputs: 5, audio_endpoints: 3 },
          cpu_temps: temps
        }
      },
      'K4LGCY': {
        code: 'K4LGCY', full: false, status: 'building', type: 'build',
        created_at: ago(2 * 1440 + 30), deadline: atIST(1, 17), steps: [{ at: ago(600), step: 'building' }]
      }
    },
    service: {
      'NT-4K7Q2M9X': {
        public_code: 'NT-4K7Q2M9X', stage: 'quoted', stage_since: ago(1200), waiting_party: null,
        device_label: 'ASUS TUF A15 laptop', job_kind: 'repair_outside', customer_name: 'Fathima Rahman',
        promised_at: null, outcome: null, handled_by: 'Vishnu', created_at: ago(2 * 1440 + 160),
        received_at: ago(2 * 1440 + 150), ready_at: null, closed_at: null, service_type: 'in_store',
        visit_start: null, visit_end: null,
        events: [
          { at: ago(1200), body: 'Quote sent on WhatsApp: replace the charging port and its board connector, ₹2,450 with parts and labour.', to_stage: 'quoted' },
          { at: ago(1440 + 260), body: null, to_stage: 'diagnosing' },
          { at: ago(2 * 1440 + 150), body: 'Laptop received at the counter. You told us: not charging, and the battery light flickers.', to_stage: 'received' }
        ],
        rma_units: []
      },
      'NT-9RTW3HXD': {
        public_code: 'NT-9RTW3HXD', stage: 'scheduled', stage_since: ago(300), waiting_party: null,
        device_label: 'Office network and 3 desktops', job_kind: 'upgrade', customer_name: 'Meera Joseph',
        promised_at: null, outcome: null, handled_by: 'Rahul', created_at: ago(1440 + 30),
        received_at: null, ready_at: null, closed_at: null, service_type: 'on_site',
        visit_start: atIST(1, 11), visit_end: atIST(1, 13),
        events: [
          { at: ago(300), body: 'Visit booked for tomorrow, 11 am to 1 pm. Rahul will call before he leaves.', to_stage: 'scheduled' },
          { at: ago(1440 + 30), body: null, to_stage: 'logged' }
        ],
        rma_units: []
      }
    },
    rma: {
      'RM-7H2D4L9C': {
        public_code: 'RM-7H2D4L9C', label: 'Kingston Fury Beast 32 GB DDR5 kit', kind: 'ram', stage: 'with_vendor',
        stage_since: ago(4 * 1440 + 100), created_at: ago(8 * 1440 + 200), received_at: ago(6 * 1440 + 300),
        return_method: 'collect', disposition: null, vendor_result: null, waiting_party: 'Kingston',
        expected_back_at: atIST(9, 12), handled_by: 'Sreeraj', linked_job_code: null,
        events: [
          { at: ago(4 * 1440 + 100), body: "Sent to Kingston's service centre in Bengaluru with the claim form.", to_stage: 'with_vendor' },
          { at: ago(5 * 1440 + 200), body: null, to_stage: 'ready_to_ship' },
          { at: ago(6 * 1440 + 60), body: 'Tested: one of the two sticks fails our memory test.', to_stage: 'testing' },
          { at: ago(6 * 1440 + 300), body: 'Your part reached us by courier.', to_stage: 'received' },
          { at: ago(8 * 1440 + 200), body: null, to_stage: 'logged' }
        ]
      }
    }
  };
})();
