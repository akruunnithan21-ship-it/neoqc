/*
  Neo QC — demo data for the Service and RMA screens.

  Why it exists: the owner wants to see a busy shop — a late quote, a GPU
  overdue at ASUS, a technician on site, a queue nobody has picked up — on a
  machine where the real tables are empty, and the staff need somewhere to
  learn the screens without touching a real customer. So this builds a whole
  shop's worth of rows, relative to the clock you give it, in EXACTLY the
  column names of sql/service-v2.sql (snake_case), so the screens read demo
  rows through the same code paths as real ones.

  Rules it keeps:
  - Read-only. Nothing here is ever written to Supabase; the data layer
    refuses every write while demo mode is on.
  - Every id starts with "demo_", and every public code contains "DEMO".
    The real code alphabet has no "O", so a demo code can never equal a real
    ticket's code even if one were typed into the public tracker.
  - Phones follow the obviously fake 98470 0XXXX pattern, normalised the A1
    way (919847001001); emails use example.com. Staff are the real roster
    names, so "Mine only" and "Requested for you" behave for the person
    looking.
  - The ticket ↔ part story is consistent with the server's RMA sync rule:
    every ticket that waits on a part sits in the mirror stage the sync would
    have put it in (tests/service-demo.test.js checks this).
  - media is empty: there are no photo files behind demo rows.

  Usage:
    const D = window.NeoQcDemo.build(Date.now());
    // { jobs, items, units, intakes, vendors, events, staff, media: [],
    //   rma_events, techs, customers, shipments, shipment_items }
    // events holds service_events rows (job_id) AND rma_events rows (case_id);
    // rma_events is the RMA subset on its own.
    window.NeoQcDemo.lookupCustomer(D, '98470 01001')   // lookup_customer() shape
*/
(function (global) {
  'use strict';

  var MIN = 60000;
  var H = 3600000;
  var D = 86400000;

  // shared/service-status.js is loaded before this file in the app; under node
  // the tests require it next to this file.
  var _S = null;
  function S() {
    if (_S) return _S;
    if (typeof window !== 'undefined' && window.NeoQcService) { _S = window.NeoQcService; return _S; }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { _S = require('./service-status.js'); } catch (e) { _S = null; }
    }
    return _S;
  }

  function extend(target, src) {
    if (src) Object.keys(src).forEach(function (k) { target[k] = src[k]; });
    return target;
  }
  function pad(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function serialNorm(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

  // The phone rule (SPEC-AMENDMENTS A1') lives in shared/service-catalog.js
  // (NeoQcCatalog.normPhone / phoneOk), loaded before this file in the app;
  // under node the tests require it next to this file. The copies below are
  // the same rule, for a page that loads this file without the catalogue.
  var _C = null;
  function C() {
    if (_C) return _C;
    if (typeof window !== 'undefined' && window.NeoQcCatalog) { _C = window.NeoQcCatalog; return _C; }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { _C = require('./service-catalog.js'); } catch (e) { _C = null; }
    }
    return _C;
  }

  // The country code is kept, so a Gulf customer's number is never cut down
  // to ten digits that belong to somebody in India.
  function normPhone(p) {
    var c = C();
    if (c && typeof c.normPhone === 'function') return c.normPhone(p);
    var d = String(p == null ? '' : p).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }

  // A normalised number we can track and message: 12-15 digits, or 11 under
  // Kuwait / Oman / Bahrain / Qatar (965 968 973 974: 3 + 8 digits).
  function phoneOk(n) {
    var c = C();
    if (c && typeof c.phoneOk === 'function') return c.phoneOk(n);
    var d = String(n == null ? '' : n);
    if (!/^\d+$/.test(d)) return false;
    if (d.length >= 12 && d.length <= 15) return true;
    return d.length === 11 && ['965', '968', '973', '974'].indexOf(d.slice(0, 3)) !== -1;
  }

  var STAFF = {
    athul:   { id: 'demo_p_athul',   email: 'athul.sudheer@neotokyo.in', full_name: 'Athul Sudheer', designation: 'Field technician', active: true, tier: 2, role: 'tech' },
    adhil:   { id: 'demo_p_adhil',   email: 'adhil.m@neotokyo.in',       full_name: 'Adhil M',       designation: 'Technician',       active: true, tier: 2, role: 'tech' },
    amal:    { id: 'demo_p_amal',    email: 'amal.c@neotokyo.in',        full_name: 'Amal C Abi',    designation: 'Technician',       active: true, tier: 2, role: 'tech' },
    vinayak: { id: 'demo_p_vinayak', email: 'vinayak.s@neotokyo.in',     full_name: 'Vinayakan S',   designation: 'Field technician', active: true, tier: 2, role: 'tech' },
    anagha:  { id: 'demo_p_anagha',  email: 'anagha.kc@neotokyo.in',     full_name: 'Anagha K C',    designation: 'Service desk',     active: true, tier: 1, role: 'desk' },
    ancy:    { id: 'demo_p_ancy',    email: 'ancybaby@neotokyo.in',      full_name: 'Ancy Baby',     designation: 'Service desk',     active: true, tier: 1, role: 'desk' }
  };
  var STAFF_ORDER = ['athul', 'adhil', 'amal', 'vinayak', 'anagha', 'ancy'];

  // The real seed list (sql/service-v2.sql §2.6): brand, 14 days unless noted.
  var VENDOR_SEED = [
    'ASUS', 'MSI', 'Gigabyte', 'Zotac', 'Sapphire', 'PowerColor', 'Inno3D', 'Galax', 'Palit', 'Corsair',
    'Cooler Master', 'Deepcool', 'Lian Li', 'NZXT', 'Antec', 'Seasonic', 'Thermaltake', 'Ant Esports',
    'Kingston', 'Crucial', 'G.Skill', 'XPG / ADATA', 'TeamGroup', 'Samsung', 'Western Digital', 'Seagate',
    'Intel', 'AMD', 'Lenovo', 'HP', 'Dell', 'Acer', 'LG', 'BenQ', 'Logitech', 'TP-Link'
  ];
  var VENDOR_TAT = { Intel: 21, AMD: 21 };
  function vendorId(name) { return 'demo_v_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  function build(nowMs) {
    var now = Number(nowMs);
    if (!isFinite(now) || now <= 0) now = Date.now();
    var St = S();

    function iso(ms) { return new Date(ms).toISOString(); }
    function ago(ms) { return iso(now - ms); }
    function ahead(ms) { return iso(now + ms); }
    // A local wall-clock time `offsetDays` from today ("today 14:30").
    function dayAt(offsetDays, h, m) {
      var d = new Date(now);
      d.setDate(d.getDate() + offsetDays);
      d.setHours(h, m || 0, 0, 0);
      return d.toISOString();
    }
    // A local calendar date (YYYY-MM-DD) for date columns such as purchase_date.
    function dateAgo(days) {
      var d = new Date(now - days * D);
      var mo = d.getMonth() + 1, dd = d.getDate();
      return d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (dd < 10 ? '0' : '') + dd;
    }
    function by(key) {
      var p = STAFF[key];
      return p ? { actor_email: p.email, actor_name: p.full_name } : { actor_email: null, actor_name: null };
    }
    function kindLabel(kind) { return (St && St.ITEM_KINDS && St.ITEM_KINDS[kind]) || kind; }
    function stageStaff(stage) { return St ? St.staffLabel(stage) : stage; }
    function rmaStaff(stage) { return St ? St.rmaStaffLabel(stage) : stage; }
    function rmaCustomer(stage, method) { return St ? St.rmaCustomerLabel({ stage: stage, return_method: method }) : stage; }
    function rmaDisposition(d) { return (St && St.RMA_DISPOSITIONS && St.RMA_DISPOSITIONS[d]) || 'Closed'; }

    var jobs = [], items = [], units = [], intakes = [], events = [], rmaEvents = [], customers = [];
    var shipments = [], shipmentItems = [];
    var J = {}, U = {}, I = {}, CU = {};

    // ── vendors ─────────────────────────────────────────────────────────────
    var vendors = VENDOR_SEED.map(function (name) {
      return {
        id: vendorId(name), name: name, public_name: name, kind: 'brand',
        contact: null, address: null, portal_url: null,
        typical_tat_days: VENDOR_TAT[name] || 14, active: true, created_at: ago(120 * D)
      };
    });
    var V = {};
    vendors.forEach(function (v) { V[v.name] = v; });

    // ── customers ───────────────────────────────────────────────────────────
    function customer(key, o) {
      var row = extend({
        id: 'demo_cu_' + key, phone_norm: null, name: null, email: null, alt_phone: null, kind: 'person',
        address: null, area: null, pincode: null, landmark: null, maps_url: null, lat: null, lng: null,
        notes: null, created_at: null, updated_at: null, created_by: STAFF.anagha.email
      }, o);
      row.phone_norm = normPhone(row.phone_norm);
      if (!row.created_at) row.created_at = ago(30 * D);
      if (!row.updated_at) row.updated_at = row.created_at;
      CU[key] = row;
      customers.push(row);
      return row;
    }

    // ── service tickets ─────────────────────────────────────────────────────
    // Every column of service_jobs (v1 columns + the §2.4 additions), so a demo
    // row has the same shape as `select *` on the real table.
    function job(key, o) {
      var row = extend({
        id: 'demo_s_' + key, public_code: null, created_at: null, updated_at: null,
        job_kind: 'repair_outside', origin: 'counter',
        stage: 'logged', stage_since: null, received_at: null,
        customer_name: null, customer_phone: null, customer_email: null,
        device_label: null, device_serial: null, reported_fault: null, has_customer_data: false,
        build_ticket_id: null, intake: {}, details: {}, subject: {},
        diagnosis: null, work_done: null, assignee: null, assignee_email: null,
        promised_at: null, waiting_party: null, next_chase_at: null, outcome: null,
        ready_at: null, closed_at: null, closed_by: null,
        model_version: 2, service_type: 'in_store', channel: 'walk_in', category: 'repair',
        priority: 'normal', priority_reason: null, priority_set_by: null, fault_keys: [],
        customer_id: null, created_by_email: null, created_by_name: null,
        suggested_tech_email: null, suggest_reason: null,
        assigned_via: null, assigned_at: null, assign_reason: null, queued_at: null, needed_by: null,
        window_start: null, window_end: null, window_note: null,
        visit_start: null, visit_end: null, visit_count: 0,
        site_address: null, site_area: null, site_pincode: null, site_landmark: null, site_maps_url: null,
        site_lat: null, site_lng: null, site_contact: null,
        remote_tool: null, remote_session_ref: null, remote_consent_at: null, converted_from: null,
        accessories: [], condition_note: null, powers_on: null, data_consent: null, est_minutes: null,
        client_request_id: null,
        // sql/service-v2.1.sql: only whether a device password is on file. The
        // password itself never reaches the demo (or any cache); in demo mode
        // NeoQcData.getDevicePassword answers a placeholder.
        has_device_password: false
      }, o);
      if (!row.updated_at) row.updated_at = row.stage_since || row.created_at;
      // The queue is "open and nobody has it"; queued_at is when it entered it.
      if (!row.assignee_email && row.stage !== 'closed' && !row.queued_at) row.queued_at = row.created_at;
      J[key] = row;
      jobs.push(row);
      return row;
    }
    function assign(row, staffKey, atIso, via) {
      var p = STAFF[staffKey];
      row.assignee = p.full_name;
      row.assignee_email = p.email;
      row.assigned_via = via || 'claim';
      row.assigned_at = atIso;
      row.queued_at = null;
    }
    function creator(row, staffKey) {
      row.created_by_email = STAFF[staffKey].email;
      row.created_by_name = STAFF[staffKey].full_name;
    }

    var itemSeq = {};
    function item(jobKey, o) {
      var j = J[jobKey];
      itemSeq[jobKey] = (itemSeq[jobKey] || 0) + 1;
      var n = itemSeq[jobKey];
      var row = extend({
        id: 'demo_si_' + jobKey + '_' + n, job_id: j.id, sort: n - 1, is_primary: n === 1,
        kind: 'other', label: null, serial: null, serial_norm: '', purchase_source: 'unknown',
        build_ticket_id: null, invoice_no: null, purchase_date: null, condition_remarks: null,
        accessories: [], powers_on: null, returned_at: null, created_at: j.created_at,
        created_by: j.created_by_email
      }, o);
      row.serial_norm = serialNorm(row.serial);      // generated column in the database
      if (row.is_primary) {
        // The primary item is mirrored onto the ticket for v1 readers (§2.5 trigger).
        j.device_label = row.label;
        j.device_serial = row.serial;
      }
      items.push(row);
      return row;
    }

    var evSeq = 0;
    function sev(jobKey, msAgo, kind, o) {
      evSeq++;
      var row = extend({
        id: 'demo_ev_' + pad(evSeq), job_id: J[jobKey] ? J[jobKey].id : jobKey,
        at: ago(msAgo), client_at: ago(msAgo), kind: kind,
        actor_kind: 'staff', actor_email: null, actor_name: null,
        from_stage: null, to_stage: null, body: null, customer_visible: false, meta: {}
      }, o);
      events.push(row);
      return row;
    }
    // A stage move on a ticket, with the stage labels the server would write.
    function move(jobKey, msAgo, from, to, staffKey, body, visible) {
      return sev(jobKey, msAgo, 'stage', extend(by(staffKey), {
        from_stage: from, to_stage: to,
        body: body || null,
        customer_visible: visible !== false
      }));
    }
    // A stage move the RMA sync made (§2.6 step 5): system actor, "RMA link".
    function syncMove(jobKey, msAgo, from, to, body) {
      return sev(jobKey, msAgo, 'stage', {
        actor_kind: 'system', actor_email: null, actor_name: 'RMA link',
        from_stage: from, to_stage: to, body: body, customer_visible: true
      });
    }

    // ── RMA ─────────────────────────────────────────────────────────────────
    function intake(key, o) {
      var row = extend({
        id: 'demo_ri_' + key, source: 'walk_in', service_job_id: null,
        sender_kind: 'customer', sender_name: null, sender_phone: null, sender_customer_id: null,
        inbound_courier: null, inbound_awb: null, received_at: null,
        return_method: 'collect', return_address: null, notes: null,
        created_at: null, created_by_email: null, created_by_name: null, client_request_id: null
      }, o);
      I[key] = row;
      intakes.push(row);
      return row;
    }
    var intakeSeq = {};
    function unit(key, intakeKey, o) {
      var ik = I[intakeKey];
      // Position in the create payload; rma_create returns units in this order.
      intakeSeq[intakeKey] = (intakeSeq[intakeKey] == null) ? 0 : intakeSeq[intakeKey] + 1;
      var row = extend({
        id: 'demo_rc_' + key, public_code: null, intake_id: ik.id, intake_seq: intakeSeq[intakeKey],
        service_job_id: ik.service_job_id, service_item_id: null, holds_ticket: false,
        kind: 'other', brand: null, model: null, serial: null, serial_norm: '',
        fault: null, diagnosed_by: 'customer', our_finding: null,
        owner_name: null, owner_phone: null,
        purchase_source: 'unknown', invoice_no: null, purchase_date: null, build_ticket_id: null,
        vendor_id: null, vendor_rma_no: null, expected_back_at: null,
        vendor_result: null, vendor_reason: null, replacement_serial: null, replacement_serial_norm: '',
        handling_fee: null, fee_status: 'n_a', fee_ref: null, fee_note: null,
        return_method: ik.return_method, return_address: ik.return_address, return_courier: null, return_awb: null,
        advance_replacement: false, advance_serial: null, advance_at: null,
        stage: 'received', stage_since: null, disposition: null, data_handling: null,
        handler_email: null, handler_name: null, followup_job_id: null,
        created_at: ik.created_at, updated_at: null, created_by_email: ik.created_by_email,
        closed_at: null, closed_by: null
      }, o);
      // Generated columns in the database (A15 adds the replacement's).
      row.serial_norm = serialNorm(row.serial);
      row.replacement_serial_norm = serialNorm(row.replacement_serial);
      if (!row.updated_at) row.updated_at = row.stage_since || row.created_at;
      U[key] = row;
      units.push(row);
      return row;
    }
    function handler(row, staffKey) {
      row.handler_email = STAFF[staffKey].email;
      row.handler_name = STAFF[staffKey].full_name;
    }

    // rma_shipments + rma_shipment_items. A9: every parcel has a mode; only a
    // courier has an AWB, the other modes say who carried it or add a note.
    var shipSeq = 0;
    function ship(caseKeys, o) {
      shipSeq++;
      var row = extend({
        id: 'demo_sh_' + pad(shipSeq), direction: 'out_to_vendor', vendor_id: null, courier: null, awb: null,
        cost: null, notes: null, dispatched_at: null, delivered_at: null, created_at: null, created_by_email: null,
        mode: 'courier', carried_by: null
      }, o);
      if (!row.created_at) row.created_at = row.dispatched_at;
      shipments.push(row);
      caseKeys.forEach(function (k) { shipmentItems.push({ shipment_id: row.id, case_id: U[k].id }); });
      return row;
    }

    var revSeq = 0;
    // An rma_events row, and — exactly like the server's mirror trigger
    // (tg_rma_events_mirror) — a service_events row of kind 'rma' on the
    // linked ticket, so a ticket's timeline shows what happened to its parts.
    // A7: the mirror carries no stage keys (they live in meta) and its body is
    // already worded: the customer's wording when they can see it.
    function rev(unitKey, msAgo, kind, o) {
      var u = U[unitKey];
      revSeq++;
      var row = extend({
        id: 'demo_rev_' + pad(revSeq), case_id: u.id, at: ago(msAgo), client_at: ago(msAgo), kind: kind,
        actor_kind: 'staff', actor_email: null, actor_name: null,
        from_stage: null, to_stage: null, body: null, customer_visible: false, meta: {}
      }, o);
      rmaEvents.push(row);
      if (u.service_job_id) {
        var jk = null;
        Object.keys(J).forEach(function (k) { if (J[k].id === u.service_job_id) jk = k; });
        var said = row.body ||
          (row.to_stage === 'closed' ? rmaDisposition(u.disposition)
            : row.customer_visible ? rmaCustomer(row.to_stage, u.return_method) : rmaStaff(row.to_stage)) || '';
        sev(jk, msAgo, 'rma', {
          at: row.at, client_at: row.client_at,
          actor_kind: row.actor_kind, actor_email: row.actor_email, actor_name: row.actor_name,
          body: kindLabel(u.kind) + ' (' + u.public_code + '): ' + said,
          customer_visible: row.customer_visible,
          meta: { rma_case_id: u.id, rma_event_id: row.id, rma_kind: row.kind,
                  from_stage: row.from_stage, to_stage: row.to_stage }
        });
      }
      return row;
    }
    function rmove(unitKey, msAgo, from, to, staffKey, body, visible) {
      return rev(unitKey, msAgo, 'stage', extend(by(staffKey), {
        from_stage: from, to_stage: to, body: body || null, customer_visible: visible !== false
      }));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Customers
    customer('arjun',    { phone_norm: '9847001001', name: 'Arjun R Kumar', email: 'arjun.rk@example.com', area: 'Edappally', pincode: '682024' });
    customer('anjali',   { phone_norm: '9847001002', name: 'Anjali M', area: 'Vyttila' });
    customer('meera',    { phone_norm: '9847001003', name: 'Meera S', email: 'meera.s@example.com' });
    customer('sandeep',  { phone_norm: '9847001004', name: 'Sandeep V', area: 'Palarivattom' });
    customer('vishnu',   { phone_norm: '9847001005', name: 'Vishnu P', email: 'vishnu.p@example.com', area: 'Aluva' });
    customer('kfreight', { phone_norm: '9847001006', name: 'Kerala Freight Co.', kind: 'business', email: 'office@keralafreight.example.com',
                           address: '2nd floor, Bristow Road, Willingdon Island, Kochi', area: 'Willingdon Island', pincode: '682003',
                           landmark: 'Opposite the Port Trust office', maps_url: 'https://www.google.com/maps?q=9.9658,76.2706',
                           lat: 9.9658, lng: 76.2706 });
    customer('nisha',    { phone_norm: '9847001007', name: 'Dr. Nisha Varghese',
                           address: 'Varghese Family Clinic, ground floor, Kaloor-Kadavanthra Road, Kaloor', area: 'Kaloor', pincode: '682017',
                           landmark: 'Near Kaloor bus stand', maps_url: 'https://www.google.com/maps/@10.0004,76.2995,17z',
                           lat: 10.0004, lng: 76.2995 });
    customer('ramesh',   { phone_norm: '9847001008', name: 'Ramesh Iyer', address: '14/220, Temple Road, Thrippunithura',
                           area: 'Thrippunithura', pincode: '682301', landmark: 'Behind the Poornathrayeesa temple' });
    customer('sneha',    { phone_norm: '9847001009', name: 'Sneha T', email: 'sneha.t@example.com' });
    customer('fahad',    { phone_norm: '9847001010', name: 'Fahad K' });
    customer('thomas',   { phone_norm: '9847001011', name: 'Thomas Kurian', address: 'Villa 12, Green Meadows, Kakkanad',
                           area: 'Kakkanad', pincode: '682030', landmark: 'Near the Infopark phase 1 gate',
                           maps_url: 'https://www.google.com/maps?q=10.0159,76.3419', lat: 10.0159, lng: 76.3419 });
    customer('lakshmi',  { phone_norm: '9847001012', name: 'Lakshmi Pillai' });
    customer('malabar',  { phone_norm: '9847001013', name: 'Café Malabar', kind: 'business', address: 'Café Malabar, Broadway, Ernakulam',
                           area: 'Broadway', pincode: '682031', landmark: 'Opposite the Marine Drive walkway entrance',
                           lat: 9.9816, lng: 76.2788 });
    customer('sreekumar',{ phone_norm: '9847001020', name: 'Sreekumar Computers, Thrissur', kind: 'trade_partner',
                           address: 'Round South, Thrissur', area: 'Thrissur', pincode: '680001' });
    customer('biju',     { phone_norm: '9847001021', name: 'Biju Antony' });
    customer('shafeeq',  { phone_norm: '9847001022', name: 'Shafeeq M' });
    customer('reshma',   { phone_norm: '9847001023', name: 'Reshma K' });
    customer('rahul',    { phone_norm: '9847001024', name: 'Rahul Menon' });
    customer('divya',    { phone_norm: '9847001025', name: 'Divya Nair' });
    customer('joel',     { phone_norm: '9847001026', name: 'Joel Thomas' });
    customer('nikhil',   { phone_norm: '9847001027', name: 'Nikhil Raj' });
    customer('aswin',    { phone_norm: '9847001028', name: 'Aswin Jose', address: 'Thekkady Road, Kumily, Idukki', pincode: '685509' });
    customer('febin',    { phone_norm: '9847001029', name: 'Febin George' });

    // customer_phone as the v2 intake stores it: '+' and the A1 number.
    function cust(key) {
      var c = CU[key];
      return { customer_id: c.id, customer_name: c.name, customer_phone: '+' + c.phone_norm, customer_email: c.email };
    }

    // ═════════════════════════════════════════════════════════════════════
    // 1. Arjun R Kumar — in-store, diagnosing 9 h. His RTX 3060 has gone to
    //    RMA on its own (non-holding): the PC stays for the restart fault.
    var t;
    t = job('arjun', extend(cust('arjun'), {
      public_code: 'NT-DEMO2A7K', created_at: ago(22 * H), received_at: ago(22 * H),
      job_kind: 'repair_own', stage: 'diagnosing', stage_since: ago(9 * H),
      category: 'repair', priority: 'high', priority_reason: 'Graphics card artifacts',
      fault_keys: ['gpu_artifacts', 'random_restart'], est_minutes: 120,
      reported_fault: 'Lines on the screen in games, and it restarts by itself a few times a day.',
      has_customer_data: true, data_consent: 'customer_backed_up', accessories: ['Power cable'], powers_on: true,
      condition_note: 'Scratches on the top panel.', has_device_password: true
    }));
    creator(t, 'anagha'); assign(t, 'amal', ago(21 * H));
    item('arjun', { kind: 'pc', label: 'Neo Tokyo build — Ryzen 5 5600, RTX 3060', serial: 'NTB-2408-0412',
                    purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/24-25/1187', purchase_date: dateAgo(430),
                    condition_remarks: 'Scratches on the top panel.', accessories: ['Power cable'], powers_on: true });
    move('arjun', 22 * H, null, 'received', 'anagha',
         'Received at counter. Reported fault: Lines on the screen in games, and it restarts by itself a few times a day.');
    sev('arjun', 21 * H, 'claim', extend(by('amal'), { body: 'Taken by Amal C Abi' }));
    move('arjun', 9 * H, 'received', 'diagnosing', 'amal');
    sev('arjun', 7 * H, 'note', extend(by('amal'), {
      body: 'Artifacts in FurMark within 2 minutes, same card in a second PC. The restarts look like a separate fault — testing RAM and PSU next.'
    }));
    sev('arjun', 5.5 * H, 'note', extend(by('amal'), {
      body: "Fitted the customer's spare GTX 1650 so we can keep testing the restarts. The 3060 goes to Zotac on its own.",
      customer_visible: true
    }));

    // 2. Anjali M — in-store, received 1.6 days ago, still nobody has it.
    t = job('anjali', extend(cust('anjali'), {
      public_code: 'NT-DEMO3F9C', created_at: ago(1.6 * D), received_at: ago(1.6 * D),
      stage: 'received', stage_since: ago(1.6 * D),
      category: 'repair', priority: 'high', priority_reason: 'Laptop screen broken or flickering',
      fault_keys: ['laptop_screen', 'physical_damage'], est_minutes: 60,
      reported_fault: 'Laptop fell off the table. The screen has lines and a crack in the corner.',
      has_customer_data: true, data_consent: 'customer_accepts_risk', accessories: ['Charger', 'Bag'], powers_on: true,
      has_device_password: true,
      condition_note: 'Crack at the bottom-left of the panel; hinge stiff.'
    }));
    creator(t, 'ancy');
    item('anjali', { kind: 'laptop', label: 'HP Pavilion 15 (2022)', serial: '5CD2341K7Q', purchase_source: 'elsewhere',
                     purchase_date: dateAgo(700), condition_remarks: 'Crack at the bottom-left of the panel; hinge stiff.',
                     accessories: ['Charger', 'Bag'], powers_on: true });
    move('anjali', 1.6 * D, null, 'received', 'ancy',
         'Received at counter. Reported fault: Laptop fell off the table. The screen has lines and a crack in the corner.');

    // 3. Meera S — in-store, quote of ₹8,400 sent 4.1 days ago, no answer yet.
    t = job('meera', extend(cust('meera'), {
      public_code: 'NT-DEMO4H6M', created_at: ago(6 * D), received_at: ago(6 * D),
      stage: 'quoted', stage_since: ago(4.1 * D),
      category: 'repair', priority: 'high', priority_reason: 'No power',
      fault_keys: ['no_power'], est_minutes: 60,
      reported_fault: 'PC does not turn on at all. No lights, no fans.',
      diagnosis: 'Board does not power on with a known-good PSU. VRM area is shorted to ground. Needs a new B660 board.',
      has_customer_data: false, data_consent: 'no_important_data', accessories: ['Power cable'], powers_on: false
    }));
    creator(t, 'anagha'); assign(t, 'vinayak', ago(5.9 * D));
    item('meera', { kind: 'pc', label: 'Desktop — Intel i5-12400, MSI B660', serial: 'MSB660-7D45-021',
                    purchase_source: 'elsewhere', purchase_date: dateAgo(900), accessories: ['Power cable'], powers_on: false,
                    condition_remarks: 'No visible damage. Dusty.' });
    move('meera', 6 * D, null, 'received', 'anagha', 'Received at counter. Reported fault: PC does not turn on at all. No lights, no fans.');
    sev('meera', 5.9 * D, 'claim', extend(by('vinayak'), { body: 'Taken by Vinayakan S' }));
    move('meera', 5.5 * D, 'received', 'diagnosing', 'vinayak');
    sev('meera', 4.2 * D, 'note', extend(by('vinayak'), {
      body: 'Quote ₹8,400: MSI PRO B660M-A board ₹7,600 plus ₹800 labour. Sent on WhatsApp.'
    }));
    move('meera', 4.1 * D, 'diagnosing', 'quoted', 'vinayak', 'Quote sent: ₹8,400 for a replacement motherboard, fitted and tested.');
    sev('meera', 2 * D, 'note', extend(by('anagha'), { body: 'Called. She will confirm after talking to her husband.' }));

    // 4. Sandeep V — ready to collect for 2.4 days.
    t = job('sandeep', extend(cust('sandeep'), {
      public_code: 'NT-DEMO6K2P', created_at: ago(4.5 * D), received_at: ago(4.5 * D),
      job_kind: 'repair_own', stage: 'ready', stage_since: ago(2.4 * D), ready_at: ago(2.4 * D), outcome: 'repaired',
      promised_at: ago(2.5 * D),
      category: 'maintenance', priority: 'normal', priority_reason: 'Overheating',
      fault_keys: ['overheating', 'cleaning_maintenance'], est_minutes: 60,
      reported_fault: 'Gets very hot and loud in games, then the games stutter.',
      work_done: 'Cleaned the dust, replaced the CPU thermal paste and the rear exhaust fan. Load temperature down from 94 °C to 71 °C.',
      data_consent: 'no_important_data', accessories: ['Power cable'], powers_on: true
    }));
    creator(t, 'ancy'); assign(t, 'adhil', ago(4.4 * D));
    item('sandeep', { kind: 'pc', label: 'Neo Tokyo build — Ryzen 7 5800X, RX 6700 XT', serial: 'NTB-2311-0198',
                      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/23-24/0877', purchase_date: dateAgo(700),
                      accessories: ['Power cable'], powers_on: true, condition_remarks: 'Very dusty inside.' });
    item('sandeep', { kind: 'cooler', label: "Customer's spare 120 mm fan", purchase_source: 'unknown',
                      condition_remarks: 'New in box.' });
    move('sandeep', 4.5 * D, null, 'received', 'ancy', 'Received at counter. Reported fault: Gets very hot and loud in games, then the games stutter.');
    sev('sandeep', 4.4 * D, 'claim', extend(by('adhil'), { body: 'Taken by Adhil M' }));
    move('sandeep', 4.3 * D, 'received', 'diagnosing', 'adhil');
    sev('sandeep', 4.25 * D, 'edit', extend(by('adhil'), { body: 'Promised ' + new Date(now - 2.5 * D).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }));
    move('sandeep', 3.6 * D, 'diagnosing', 'in_service', 'adhil');
    move('sandeep', 2.9 * D, 'in_service', 'verifying', 'adhil');
    move('sandeep', 2.4 * D, 'verifying', 'ready', 'adhil',
         'Ready to collect. Cleaned and repasted; temperatures under load down from 94 °C to 71 °C.');
    sev('sandeep', 1 * D, 'note', extend(by('ancy'), { body: 'Reminder sent on WhatsApp.' }));

    // 5. Vishnu P — in-store, waiting 16 days on ASUS for the RTX 4070 Ti
    //    (holding: the PC waits for it). His Antec PSU went separately
    //    (non-holding), came back rejected and now needs his decision.
    t = job('vishnu', extend(cust('vishnu'), {
      public_code: 'NT-DEMO7Q4R', created_at: ago(18 * D), received_at: ago(18 * D),
      job_kind: 'warranty_rma', stage: 'at_vendor', stage_since: ago(16 * D),
      waiting_party: 'ASUS', next_chase_at: ago(2 * D), promised_at: ahead(3 * D),
      category: 'warranty_claim', priority: 'high', priority_reason: 'No display, Power supply fault',
      fault_keys: ['no_display', 'psu_fault'], est_minutes: 60,
      reported_fault: 'Burning smell, then no display. The fans still spin.',
      diagnosis: 'Antec PSU failed (burnt smell). RTX 4070 Ti gives no output on a known-good bench. Both raised for RMA.',
      has_customer_data: true, data_consent: 'customer_backed_up', accessories: ['Power cable', 'Wi-Fi antenna'], powers_on: false
    }));
    creator(t, 'ancy'); assign(t, 'athul', ago(17.9 * D));
    item('vishnu', { kind: 'pc', label: 'Neo Tokyo build — i7-13700F, RTX 4070 Ti', serial: 'NTB-2501-0077',
                     purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/24-25/2210', purchase_date: dateAgo(270),
                     accessories: ['Power cable', 'Wi-Fi antenna'], powers_on: false, condition_remarks: 'No visible damage.' });
    move('vishnu', 18 * D, null, 'received', 'ancy', 'Received at counter. Reported fault: Burning smell, then no display. The fans still spin.');
    sev('vishnu', 17.9 * D, 'claim', extend(by('athul'), { body: 'Taken by Athul Sudheer' }));
    move('vishnu', 17.8 * D, 'received', 'diagnosing', 'athul');

    // 6. Kerala Freight Co. — on-site, technician on site for 2 hours.
    t = job('kfreight', extend(cust('kfreight'), {
      public_code: 'NT-DEMO9T3V', created_at: ago(20 * H), service_type: 'on_site', channel: 'phone',
      stage: 'on_site', stage_since: ago(2 * H),
      category: 'networking', priority: 'high',
      priority_reason: 'No internet / LAN not working, Network or router setup, Business site, 4 machines',
      fault_keys: ['no_internet', 'network_setup'], est_minutes: 90,
      reported_fault: 'Since the power cut on Monday none of the 4 office PCs get internet. The router keeps restarting.',
      window_start: ago(4 * H), window_end: ahead(4 * H), window_note: 'Office hours. Ask for Joseph at reception.',
      visit_start: ago(2 * H + 20 * MIN), visit_end: ahead(40 * MIN), visit_count: 1,
      site_address: '2nd floor, Bristow Road, Willingdon Island, Kochi', site_area: 'Willingdon Island', site_pincode: '682003',
      site_landmark: 'Opposite the Port Trust office', site_maps_url: 'https://www.google.com/maps?q=9.9658,76.2706',
      site_lat: 9.9658, site_lng: 76.2706, site_contact: 'Joseph, office manager — 98470 01014'
    }));
    creator(t, 'anagha'); assign(t, 'athul', ago(19.5 * H));
    item('kfreight', { kind: 'other', label: 'Office network — router and 4 PCs' });
    move('kfreight', 20 * H, null, 'logged', 'anagha', 'Request logged by Anagha K C (Phone).');
    sev('kfreight', 19.5 * H, 'claim', extend(by('athul'), { body: 'Taken by Athul Sudheer — visit ' + fmtWhen(now - 2 * H - 20 * MIN) }));
    move('kfreight', 19.5 * H - MIN, 'logged', 'scheduled', 'athul', 'Visit booked for ' + fmtWhen(now - 2 * H - 20 * MIN) + '.');
    sev('kfreight', 2 * H + 50 * MIN, 'field', extend(by('athul'), {
      from_stage: 'scheduled', to_stage: 'en_route', body: 'Left the shop.', customer_visible: true,
      meta: { field_activity_id: 'demo_fa_001', lat: null, lng: null }
    }));
    sev('kfreight', 2 * H, 'field', extend(by('athul'), {
      from_stage: 'en_route', to_stage: 'on_site', body: 'Checked in on site.', customer_visible: true,
      meta: { field_activity_id: 'demo_fa_002', lat: 9.9658, lng: 76.2706 }
    }));
    sev('kfreight', 1 * H, 'note', extend(by('athul'), {
      body: 'Router PSU is failing (restarts when the switch is loaded). Running the office off a spare router while the ISP sends a replacement.'
    }));

    // 7. Dr. Nisha Varghese — on-site, technician en route for today's 14:30 visit.
    t = job('nisha', extend(cust('nisha'), {
      public_code: 'NT-DEMOA6W2', created_at: ago(26 * H), service_type: 'on_site', channel: 'whatsapp',
      stage: 'en_route', stage_since: ago(25 * MIN),
      category: 'os_software', priority: 'high', priority_reason: "Won't boot into Windows",
      fault_keys: ['wont_boot_os'], est_minutes: 60,
      reported_fault: 'Reception PC is stuck on "Preparing Automatic Repair". Our billing software is on it.',
      has_customer_data: true, data_consent: 'customer_backed_up',
      window_start: dayAt(0, 14, 0), window_end: dayAt(0, 17, 0), window_note: 'The clinic is closed from 1 to 2 pm for lunch.',
      visit_start: dayAt(0, 14, 30), visit_end: dayAt(0, 16, 0), visit_count: 0,
      site_address: 'Varghese Family Clinic, ground floor, Kaloor-Kadavanthra Road, Kaloor', site_area: 'Kaloor',
      site_pincode: '682017', site_landmark: 'Near Kaloor bus stand',
      site_maps_url: 'https://www.google.com/maps/@10.0004,76.2995,17z', site_lat: 10.0004, site_lng: 76.2995,
      site_contact: 'Reception — 98470 01015'
    }));
    creator(t, 'ancy'); assign(t, 'vinayak', ago(24 * H));
    item('nisha', { kind: 'pc', label: 'Clinic reception PC — HP ProDesk 400' });
    move('nisha', 26 * H, null, 'logged', 'ancy', 'Request logged by Ancy Baby (WhatsApp).');
    sev('nisha', 24 * H, 'claim', extend(by('vinayak'), { body: 'Taken by Vinayakan S — visit ' + fmtWhen(new Date(dayAt(0, 14, 30)).getTime()) }));
    move('nisha', 24 * H - MIN, 'logged', 'scheduled', 'vinayak', 'Visit booked for ' + fmtWhen(new Date(dayAt(0, 14, 30)).getTime()) + '.');
    sev('nisha', 25 * MIN, 'field', extend(by('vinayak'), {
      from_stage: 'scheduled', to_stage: 'en_route', body: 'Left the shop.', customer_visible: true,
      meta: { field_activity_id: 'demo_fa_003', lat: null, lng: null }
    }));

    // 8. Ramesh Iyer — on-site; the first visit found a dead PSU, the part is
    //    on order and a revisit will be booked when it lands.
    //    visit_start is cleared on purpose so the ticket shows under
    //    "Claimed — no visit time" until the revisit is booked.
    t = job('ramesh', extend(cust('ramesh'), {
      public_code: 'NT-DEMOC7X3', created_at: ago(5 * D), service_type: 'on_site', channel: 'phone',
      stage: 'parts_on_order', stage_since: ago(3 * D),
      waiting_party: 'Rashi Peripherals', next_chase_at: ahead(1 * D), promised_at: ahead(2 * D),
      category: 'repair', priority: 'high', priority_reason: 'No power, Power supply fault',
      fault_keys: ['no_power', 'psu_fault'], est_minutes: 60,
      reported_fault: 'Home PC is completely dead since the storm.',
      diagnosis: 'PSU dead (no 12 V on the 24-pin). Board and CPU are fine on our tester PSU.',
      visit_count: 1,
      site_address: '14/220, Temple Road, Thrippunithura', site_area: 'Thrippunithura', site_pincode: '682301',
      site_landmark: 'Behind the Poornathrayeesa temple'
    }));
    creator(t, 'anagha'); assign(t, 'athul', ago(4.9 * D));
    item('ramesh', { kind: 'pc', label: 'Home PC — Ryzen 5 3600, Corsair CV550', purchase_source: 'elsewhere' });
    move('ramesh', 5 * D, null, 'logged', 'anagha', 'Request logged by Anagha K C (Phone).');
    sev('ramesh', 4.9 * D, 'claim', extend(by('athul'), { body: 'Taken by Athul Sudheer — visit ' + fmtWhen(now - 4 * D) }));
    move('ramesh', 4.9 * D - MIN, 'logged', 'scheduled', 'athul', 'Visit booked for ' + fmtWhen(now - 4 * D) + '.');
    sev('ramesh', 4 * D + 40 * MIN, 'field', extend(by('athul'), {
      from_stage: 'scheduled', to_stage: 'en_route', body: 'Left the shop.', customer_visible: true,
      meta: { field_activity_id: 'demo_fa_004', lat: null, lng: null }
    }));
    sev('ramesh', 4 * D, 'field', extend(by('athul'), {
      from_stage: 'en_route', to_stage: 'on_site', body: 'Checked in on site.', customer_visible: true,
      meta: { field_activity_id: 'demo_fa_005', lat: 9.9439, lng: 76.3456 }
    }));
    sev('ramesh', 4 * D - 90 * MIN, 'field', extend(by('athul'), {
      from_stage: 'on_site', to_stage: 'parts_to_order', body: 'Checked out: parts needed. PSU is dead; board and CPU are fine.',
      customer_visible: false, meta: { field_activity_id: 'demo_fa_006', lat: 9.9439, lng: 76.3456 }
    }));
    move('ramesh', 3 * D, 'parts_to_order', 'parts_on_order', 'athul',
         'Ordered a Corsair CV650 from Rashi Peripherals. We will book the second visit as soon as it arrives.');

    // 9. Sneha T — remote, logged 40 minutes ago, nobody has it, Adhil suggested.
    t = job('sneha', extend(cust('sneha'), {
      public_code: 'NT-DEMOD9Y4', created_at: ago(40 * MIN), service_type: 'remote', channel: 'whatsapp',
      stage: 'logged', stage_since: ago(40 * MIN),
      category: 'os_software', priority: 'normal', priority_reason: 'Driver problems',
      fault_keys: ['windows_activation', 'driver_crash'], est_minutes: 45,
      reported_fault: 'Windows says it is not activated after the board was replaced. The touchpad driver also stopped working.',
      suggested_tech_email: STAFF.adhil.email, suggest_reason: 'Served this customer before',
      remote_tool: 'anydesk',
      window_start: ahead(1 * H), window_end: ahead(4 * H), window_note: 'Free after college, any time this evening.'
    }));
    creator(t, 'ancy');
    item('sneha', { kind: 'laptop', label: 'ASUS VivoBook 15' });
    move('sneha', 40 * MIN, null, 'logged', 'ancy', 'Request logged by Ancy Baby (WhatsApp).');
    sev('sneha', 39 * MIN, 'assign', extend(by('ancy'), { body: 'Suggested Adhil M — Served this customer before' }));

    // 10. Fahad K — started as a remote session, converted to in-store when the
    //     drive turned out to be failing; the laptop arrived 5 hours ago.
    t = job('fahad', extend(cust('fahad'), {
      public_code: 'NT-DEMOE2Z6', created_at: ago(30 * H), received_at: ago(5 * H),
      service_type: 'in_store', converted_from: 'remote', channel: 'phone',
      stage: 'received', stage_since: ago(5 * H),
      category: 'os_software', priority: 'normal', priority_reason: 'Virus, malware or pop-ups',
      fault_keys: ['virus_malware', 'slow'], est_minutes: 60,
      reported_fault: 'Pop-ups everywhere and the laptop is very slow.',
      diagnosis: 'Malware reinstalls itself from a scheduled task, and the drive shows 1,100 reallocated sectors.',
      has_customer_data: true, data_consent: 'customer_accepts_risk',
      remote_tool: 'anydesk', remote_session_ref: '1 482 630 917', remote_consent_at: ago(24 * H),
      accessories: ['Charger'], powers_on: true, condition_note: 'No visible damage.'
    }));
    creator(t, 'anagha'); assign(t, 'adhil', ago(29 * H));
    item('fahad', { kind: 'laptop', label: 'Lenovo IdeaPad Slim 3', serial: 'PF3K2L9X', purchase_source: 'elsewhere',
                    purchase_date: dateAgo(500), accessories: ['Charger'], powers_on: true, condition_remarks: 'No visible damage.' });
    move('fahad', 30 * H, null, 'logged', 'anagha', 'Request logged by Anagha K C (Phone).');
    sev('fahad', 29 * H, 'claim', extend(by('adhil'), { body: 'Taken by Adhil M — session ' + fmtWhen(now - 24 * H) }));
    move('fahad', 29 * H - MIN, 'logged', 'session_booked', 'adhil', 'Remote session booked for ' + fmtWhen(now - 24 * H) + '.');
    move('fahad', 24 * H, 'session_booked', 'in_session', 'adhil');
    sev('fahad', 23.5 * H, 'note', extend(by('adhil'), {
      body: 'Malware reinstalls itself from a scheduled task, and the drive shows 1,100 reallocated sectors. This needs the bench.'
    }));
    move('fahad', 23 * H, 'in_session', 'logged', 'adhil', 'Converted from Remote to In-store');
    move('fahad', 5 * H, 'logged', 'received', 'anagha', 'Received at counter. Reported fault: Pop-ups everywhere and the laptop is very slow.');

    // 11–13. Three more nobody has taken yet; Café Malabar asked for Athul.
    t = job('thomas', extend(cust('thomas'), {
      public_code: 'NT-DEMOF3G7', created_at: ago(3 * H), service_type: 'on_site', channel: 'phone',
      stage: 'logged', stage_since: ago(3 * H),
      category: 'networking', priority: 'normal', priority_reason: 'Network or router setup',
      fault_keys: ['network_setup'], est_minutes: 90, needed_by: ahead(4 * D),
      reported_fault: 'New fibre connection. Wants Wi-Fi to reach all three floors before he starts working from home.',
      window_start: dayAt(1, 10, 0), window_end: dayAt(1, 13, 0), window_note: 'Weekend mornings are also fine.',
      site_address: 'Villa 12, Green Meadows, Kakkanad', site_area: 'Kakkanad', site_pincode: '682030',
      site_landmark: 'Near the Infopark phase 1 gate', site_maps_url: 'https://www.google.com/maps?q=10.0159,76.3419',
      site_lat: 10.0159, site_lng: 76.3419
    }));
    creator(t, 'anagha');
    item('thomas', { kind: 'other', label: 'Home Wi-Fi — 3 floors, new fibre connection' });
    move('thomas', 3 * H, null, 'logged', 'anagha', 'Request logged by Anagha K C (Phone).');

    t = job('lakshmi', extend(cust('lakshmi'), {
      public_code: 'NT-DEMOG4H9', created_at: ago(3.2 * H), received_at: ago(3.2 * H),
      stage: 'received', stage_since: ago(3.2 * H),
      category: 'repair', priority: 'high', priority_reason: 'No power',
      fault_keys: ['no_power'], est_minutes: 60,
      reported_fault: 'Desktop does not turn on since yesterday. Brought the monitor too, to test with.',
      data_consent: 'no_important_data', accessories: ['Power cable', 'HDMI / DP cable'], powers_on: false
    }));
    creator(t, 'ancy');
    item('lakshmi', { kind: 'pc', label: 'Dell Vostro 3910 desktop', serial: 'DL3910-8HX2K', purchase_source: 'elsewhere',
                      purchase_date: dateAgo(800), accessories: ['Power cable'], powers_on: false,
                      condition_remarks: 'No visible damage.' });
    item('lakshmi', { kind: 'monitor', label: 'Dell 22 inch monitor (E2222H)', purchase_source: 'elsewhere',
                      accessories: ['HDMI / DP cable'], powers_on: true, condition_remarks: 'Scratches on the stand.' });
    move('lakshmi', 3.2 * H, null, 'received', 'ancy',
         'Received at counter. Reported fault: Desktop does not turn on since yesterday. Brought the monitor too, to test with.');

    t = job('malabar', extend(cust('malabar'), {
      public_code: 'NT-DEMOH6J2', created_at: ago(1.5 * H), service_type: 'on_site', channel: 'whatsapp',
      stage: 'logged', stage_since: ago(1.5 * H),
      category: 'installation', priority: 'high', priority_reason: 'Wi-Fi or Bluetooth not working, Business site',
      fault_keys: ['printer_setup', 'wifi_issue'], est_minutes: 45,
      reported_fault: 'Billing printer stopped printing after the Wi-Fi router was changed.',
      suggested_tech_email: STAFF.athul.email, suggest_reason: 'Set up their network last month',
      window_start: dayAt(1, 15, 0), window_end: dayAt(1, 18, 0), window_note: 'Between the lunch and dinner rush.',
      site_address: 'Café Malabar, Broadway, Ernakulam', site_area: 'Broadway', site_pincode: '682031',
      site_landmark: 'Opposite the Marine Drive walkway entrance', site_lat: 9.9816, site_lng: 76.2788,
      site_contact: 'Manager on duty'
    }));
    creator(t, 'ancy');
    item('malabar', { kind: 'peripheral', label: 'Epson TM-T82 receipt printer and café Wi-Fi' });
    move('malabar', 1.5 * H, null, 'logged', 'ancy', 'Request logged by Ancy Baby (WhatsApp).');
    sev('malabar', 1.5 * H - MIN, 'assign', extend(by('ancy'), { body: 'Suggested Athul Sudheer — Set up their network last month' }));

    // ═════════════════════════════════════════════════════════════════════
    // RMA
    // A. Courier box from a trade partner: three parts for three end customers.
    intake('sreekumar', {
      source: 'courier', sender_kind: 'third_party_tech', sender_name: CU.sreekumar.name,
      sender_phone: CU.sreekumar.phone_norm, sender_customer_id: CU.sreekumar.id,
      inbound_courier: 'DTDC', inbound_awb: 'D45127788310', received_at: ago(6 * H),
      return_method: 'courier', return_address: 'Sreekumar Computers, Round South, Thrissur 680001',
      notes: "One box, three parts, each bagged and labelled with the end customer's name.",
      created_at: ago(6 * H), created_by_email: STAFF.anagha.email, created_by_name: STAFF.anagha.full_name
    });
    t = unit('rm750', 'sreekumar', {
      public_code: 'RM-DEMO2C4E', kind: 'psu', brand: 'Corsair', model: 'RM750', serial: '231476120007218',
      fault: 'Shuts down under gaming load. Tested with another PSU and the PC is fine.', diagnosed_by: 'third_party',
      owner_name: CU.biju.name, owner_phone: CU.biju.phone_norm,
      purchase_source: 'neo_tokyo', invoice_no: 'NT/TR/25-26/0331', purchase_date: dateAgo(210),
      vendor_id: V.Corsair.id, stage: 'testing', stage_since: ago(2 * H)
    });
    handler(t, 'amal');
    t = unit('kingston', 'sreekumar', {
      public_code: 'RM-DEMO3D6F', kind: 'ram', brand: 'Kingston', model: 'Fury Beast 16GB DDR4 3200', serial: 'K9TRF2-MIEFBR',
      fault: 'MemTest errors in slots A2 and B2.', diagnosed_by: 'third_party',
      owner_name: CU.shafeeq.name, owner_phone: CU.shafeeq.phone_norm,
      purchase_source: 'unknown', stage: 'received', stage_since: ago(6 * H)
    });
    t = unit('sn570', 'sreekumar', {
      public_code: 'RM-DEMO4E7G', kind: 'ssd', brand: 'WD', model: 'Blue SN570 1TB', serial: '22145H801234',
      fault: 'Not detected in BIOS after a week of use.', diagnosed_by: 'third_party',
      owner_name: CU.reshma.name, owner_phone: CU.reshma.phone_norm,
      purchase_source: 'neo_tokyo', invoice_no: 'NT/TR/25-26/0402', purchase_date: dateAgo(95),
      vendor_id: V['Western Digital'].id, stage: 'received', stage_since: ago(6 * H)
    });

    // B. Walk-in motherboard, tested and ready to ship to ASUS.
    intake('rahul', {
      source: 'walk_in', sender_kind: 'customer', sender_name: CU.rahul.name, sender_phone: CU.rahul.phone_norm,
      sender_customer_id: CU.rahul.id, received_at: ago(1.5 * D), return_method: 'collect',
      created_at: ago(1.5 * D), created_by_email: STAFF.ancy.email, created_by_name: STAFF.ancy.full_name
    });
    t = unit('b550', 'rahul', {
      public_code: 'RM-DEMO6F9H', kind: 'motherboard', brand: 'ASUS', model: 'TUF Gaming B550-Plus', serial: 'M9M0KC012345',
      fault: 'No display. The DRAM light stays on.', diagnosed_by: 'customer',
      our_finding: 'No POST with a known-good CPU and RAM. DRAM LED stays on. Board fault confirmed.',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/25-26/0918', purchase_date: dateAgo(240),
      vendor_id: V.ASUS.id, stage: 'ready_to_ship', stage_since: ago(1 * D)
    });
    handler(t, 'amal');

    // C. From Arjun's ticket: the RTX 3060 goes on its own (does not hold the ticket).
    //    A part taken OUT of the ticket's PC is not the ticket's item, so
    //    service_item_id stays null: linking the PC itself would make it a
    //    whole-device RMA, which always holds the ticket (A4), and a
    //    replacement serial would overwrite the PC's serial (A15).
    intake('arjun', {
      source: 'from_ticket', service_job_id: J.arjun.id, sender_kind: 'customer', sender_name: CU.arjun.name,
      sender_phone: CU.arjun.phone_norm, sender_customer_id: CU.arjun.id, received_at: ago(5 * H),
      return_method: 'collect', created_at: ago(5 * H),
      created_by_email: STAFF.amal.email, created_by_name: STAFF.amal.full_name
    });
    t = unit('rtx3060', 'arjun', {
      public_code: 'RM-DEMO7G2J', service_item_id: null, holds_ticket: false,
      kind: 'gpu', brand: 'Zotac', model: 'Gaming RTX 3060 Twin Edge 12GB', serial: 'N210400012345',
      fault: 'Artifacts within 2 minutes of FurMark; same in a second PC.', diagnosed_by: 'us',
      our_finding: 'Artifacts reproduced on two PCs at stock clocks. Memory fault on the card.',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/24-25/1187', purchase_date: dateAgo(430),
      vendor_id: V.Zotac.id, stage: 'ready_to_ship', stage_since: ago(2 * H)
    });
    handler(t, 'amal');

    // D. Walk-in hard drive bought elsewhere: waiting on the invoice and the fee.
    intake('divya', {
      source: 'walk_in', sender_kind: 'customer', sender_name: CU.divya.name, sender_phone: CU.divya.phone_norm,
      sender_customer_id: CU.divya.id, received_at: ago(2 * D), return_method: 'collect',
      created_at: ago(2 * D), created_by_email: STAFF.anagha.email, created_by_name: STAFF.anagha.full_name
    });
    t = unit('seagate', 'divya', {
      public_code: 'RM-DEMO9H3K', kind: 'hdd', brand: 'Seagate', model: 'Barracuda 2TB (ST2000DM008)', serial: 'ZFL1A7KD',
      fault: 'Clicking noise; the PC freezes when copying files.', diagnosed_by: 'customer',
      our_finding: 'SMART shows 1,240 reallocated sectors. Clicking confirmed.',
      purchase_source: 'elsewhere', handling_fee: 300, fee_status: 'quoted',
      vendor_id: V.Seagate.id, stage: 'awaiting_docs', stage_since: ago(1.2 * D)
    });
    handler(t, 'adhil');

    // E. Walk-in AIO cooler, with Corsair for 2 days.
    intake('joel', {
      source: 'walk_in', sender_kind: 'customer', sender_name: CU.joel.name, sender_phone: CU.joel.phone_norm,
      sender_customer_id: CU.joel.id, received_at: ago(5 * D), return_method: 'collect',
      created_at: ago(5 * D), created_by_email: STAFF.ancy.email, created_by_name: STAFF.ancy.full_name
    });
    t = unit('h100i', 'joel', {
      public_code: 'RM-DEMOA4LM', kind: 'cooler', brand: 'Corsair', model: 'iCUE H100i Elite', serial: '224522010042',
      fault: 'Pump makes a grinding noise; CPU reaches 95 °C.', diagnosed_by: 'customer',
      our_finding: 'Pump speed reads 0 rpm in BIOS. Grinding confirmed.',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/25-26/0144', purchase_date: dateAgo(330),
      vendor_id: V.Corsair.id, vendor_rma_no: 'CS-RMA-882134', expected_back_at: ahead(12 * D),
      stage: 'with_vendor', stage_since: ago(2 * D)
    });
    handler(t, 'adhil');

    // F. Our own stock: an SSD that failed the pre-build burn-in.
    intake('stock', {
      source: 'stock', sender_kind: 'shop', sender_name: 'Neo Tokyo stock', received_at: ago(6 * D),
      return_method: 'collect', notes: 'Failed the pre-build test on bench 2.',
      created_at: ago(6 * D), created_by_email: STAFF.amal.email, created_by_name: STAFF.amal.full_name
    });
    //    A drive, so it shipped only once its data was dealt with (A11); it
    //    went by hand to the Samsung service centre, not by courier (A9).
    t = unit('ssd980', 'stock', {
      public_code: 'RM-DEMOC6NP', kind: 'ssd', brand: 'Samsung', model: '980 1TB (MZ-V8V1T0)', serial: 'S649NJ0R123456A',
      fault: 'Drops off the bus under sustained writes during burn-in.', diagnosed_by: 'us',
      our_finding: 'Fails a 30-minute sustained write test every time.',
      purchase_source: 'neo_tokyo', vendor_id: V.Samsung.id, expected_back_at: ahead(9 * D),
      data_handling: 'wiped_by_us',
      stage: 'with_vendor', stage_since: ago(5 * D)
    });
    handler(t, 'amal');

    // G. Walk-in PSU replaced by MSI and collected today.
    intake('nikhil', {
      source: 'walk_in', sender_kind: 'customer', sender_name: CU.nikhil.name, sender_phone: CU.nikhil.phone_norm,
      sender_customer_id: CU.nikhil.id, received_at: ago(20 * D), return_method: 'collect',
      created_at: ago(20 * D), created_by_email: STAFF.anagha.email, created_by_name: STAFF.anagha.full_name
    });
    // "Closed today" must stay today whatever the time of day the demo opens.
    var midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    var closedAgo = (now - 3 * H >= midnight.getTime()) ? 3 * H : Math.max(1 * MIN, (now - midnight.getTime()) / 2);
    t = unit('msi650', 'nikhil', {
      public_code: 'RM-DEMOD7QR', kind: 'psu', brand: 'MSI', model: 'MAG A650BN (650 W)', serial: '6022B0123456',
      fault: 'Clicks and shuts off as soon as it is powered on.', diagnosed_by: 'customer',
      our_finding: 'Fails on the PSU tester. 12 V rail collapses under load.',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/25-26/0067', purchase_date: dateAgo(400),
      vendor_id: V.MSI.id, vendor_rma_no: 'MSI-RMA-41190', expected_back_at: ago(5 * D),
      vendor_result: 'replaced', replacement_serial: '6022B0654321',
      stage: 'closed', stage_since: ago(closedAgo), disposition: 'replaced',
      closed_at: ago(closedAgo), closed_by: STAFF.anagha.email
    });
    handler(t, 'vinayak');

    // H. From Vishnu's ticket, raised together: the GPU holds the ticket; the
    //    PSU (bought elsewhere) follows on its own.
    intake('vishnu', {
      source: 'from_ticket', service_job_id: J.vishnu.id, sender_kind: 'customer', sender_name: CU.vishnu.name,
      sender_phone: CU.vishnu.phone_norm, sender_customer_id: CU.vishnu.id, received_at: ago(17 * D),
      return_method: 'with_device', created_at: ago(17 * D),
      created_by_email: STAFF.athul.email, created_by_name: STAFF.athul.full_name
    });
    t = unit('rtx4070ti', 'vishnu', {
      public_code: 'RM-DEMOE9TU', service_item_id: null, holds_ticket: true,
      kind: 'gpu', brand: 'ASUS', model: 'TUF Gaming RTX 4070 Ti 12GB', serial: 'N3NRKS012345',
      fault: 'No output on a known-good bench after the PSU failure.', diagnosed_by: 'us',
      our_finding: 'No output on two known-good boards. Fans spin, no POST code from the card.',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/24-25/2210', purchase_date: dateAgo(270),
      vendor_id: V.ASUS.id, vendor_rma_no: 'A4471', expected_back_at: ago(2 * D),
      return_method: 'with_device', stage: 'with_vendor', stage_since: ago(16 * D)
    });
    handler(t, 'athul');
    t = unit('antec650', 'vishnu', {
      public_code: 'RM-DEMOF2VW', service_item_id: null, holds_ticket: false,
      kind: 'psu', brand: 'Antec', model: 'CSK650 (650 W)', serial: 'AQ2208000412',
      fault: 'Burning smell, then the PC would not power on.', diagnosed_by: 'us',
      our_finding: 'Dead on the tester. Burnt smell from the primary side.',
      purchase_source: 'elsewhere', invoice_no: 'AMZ-407-1234567', purchase_date: dateAgo(300),
      handling_fee: 300, fee_status: 'accepted', fee_note: 'Customer agreed on WhatsApp.',
      vendor_id: V.Antec.id, expected_back_at: ago(0.5 * D),
      vendor_result: 'rejected', vendor_reason: 'Burnt component on the PCB; physical damage is not covered.',
      return_method: 'collect', return_address: null,
      stage: 'customer_decision', stage_since: ago(1 * D)
    });
    handler(t, 'athul');

    // I. Logged from the website: a courier is on the way, nothing in hand yet.
    intake('aswin', {
      source: 'website', sender_kind: 'customer', sender_name: CU.aswin.name, sender_phone: CU.aswin.phone_norm,
      sender_customer_id: CU.aswin.id, inbound_courier: 'Professional Couriers', inbound_awb: 'PCKCH20871234',
      return_method: 'courier', return_address: 'Aswin Jose, Thekkady Road, Kumily, Idukki 685509',
      created_at: ago(1 * D), created_by_email: STAFF.ancy.email, created_by_name: STAFF.ancy.full_name
    });
    t = unit('rx6600', 'aswin', {
      public_code: 'RM-DEMOG3XY', kind: 'gpu', brand: 'Gigabyte', model: 'Radeon RX 6600 Eagle 8G',
      fault: 'Black screen under load; fans go to full speed.', diagnosed_by: 'customer',
      purchase_source: 'neo_tokyo', invoice_no: 'NT/WEB/25-26/0221', purchase_date: dateAgo(150),
      stage: 'logged', stage_since: ago(1 * D)
    });

    // J. Walk-in monitor: no fault found, waiting for the customer to collect.
    intake('febin', {
      source: 'walk_in', sender_kind: 'customer', sender_name: CU.febin.name, sender_phone: CU.febin.phone_norm,
      sender_customer_id: CU.febin.id, received_at: ago(4 * D), return_method: 'collect',
      created_at: ago(4 * D), created_by_email: STAFF.ancy.email, created_by_name: STAFF.ancy.full_name
    });
    t = unit('lg24', 'febin', {
      public_code: 'RM-DEMOH4Z2', kind: 'monitor', brand: 'LG', model: '24MP400 24 inch', serial: '305NTAB12345',
      fault: 'Screen flickers and goes black every few minutes.', diagnosed_by: 'customer',
      our_finding: "No fault in a 48-hour soak test on our bench. The flicker followed the customer's HDMI cable.",
      purchase_source: 'neo_tokyo', invoice_no: 'NT/INV/25-26/0510', purchase_date: dateAgo(120),
      vendor_id: V.LG.id, stage: 'ready_to_return', stage_since: ago(1.2 * D)
    });
    handler(t, 'vinayak');

    // K. Pulled on site (A8): Athul took Ramesh Iyer's dead PSU out at the
    //    visit and has not brought it in yet. It does NOT hold the ticket —
    //    Ramesh bought a new PSU, which is what the revisit waits for.
    var pulledAgo = 4 * D - 90 * MIN;                // when Athul checked out of the visit
    intake('ramesh', {
      source: 'field', service_job_id: J.ramesh.id, sender_kind: 'our_tech',
      sender_name: STAFF.athul.full_name, sender_phone: null, return_method: 'collect',
      notes: 'Pulled at the first visit. Back to the customer on the revisit.',
      created_at: ago(pulledAgo), created_by_email: STAFF.athul.email, created_by_name: STAFF.athul.full_name
    });
    t = unit('cv550', 'ramesh', {
      public_code: 'RM-DEMOJ7K9', holds_ticket: false,
      kind: 'psu', brand: 'Corsair', model: 'CV550 (550 W)', serial: '2219B5507731',
      fault: 'Dead since the storm: no 12 V on the 24-pin.', diagnosed_by: 'us',
      our_finding: 'No output on the tester at the site. Board and CPU fine on our PSU.',
      owner_name: CU.ramesh.name, owner_phone: CU.ramesh.phone_norm,
      purchase_source: 'unknown', vendor_id: V.Corsair.id,
      stage: 'with_tech', stage_since: ago(pulledAgo)
    });
    handler(t, 'athul');

    // ── RMA histories (and their mirrors on the linked tickets) ────────────
    rmove('rm750', 6 * H, null, 'received', 'anagha', 'Received (Courier). Fault: Shuts down under gaming load.');
    rmove('kingston', 6 * H, null, 'received', 'anagha', 'Received (Courier). Fault: MemTest errors in slots A2 and B2.');
    rmove('sn570', 6 * H, null, 'received', 'anagha', 'Received (Courier). Fault: Not detected in BIOS after a week of use.');
    rev('rm750', 2 * H + 5 * MIN, 'system', extend(by('amal'), { body: 'Taken by Amal C Abi' }));
    rmove('rm750', 2 * H, 'received', 'testing', 'amal');

    rmove('b550', 1.5 * D, null, 'received', 'ancy', 'Received (Walk-in). Fault: No display. The DRAM light stays on.');
    rmove('b550', 1.4 * D, 'received', 'testing', 'amal');
    rmove('b550', 1 * D, 'testing', 'ready_to_ship', 'amal', 'Fault confirmed. Warranty claim being prepared.');

    rmove('rtx3060', 5 * H, null, 'received', 'amal', 'Received (From a ticket). Fault: Artifacts within 2 minutes of FurMark.');
    rmove('rtx3060', 4.5 * H, 'received', 'testing', 'amal');
    rmove('rtx3060', 2 * H, 'testing', 'ready_to_ship', 'amal', 'Fault confirmed on two PCs. Warranty claim being prepared.');

    rmove('seagate', 2 * D, null, 'received', 'anagha', 'Received (Walk-in). Fault: Clicking noise; the PC freezes when copying files.');
    rmove('seagate', 1.8 * D, 'received', 'testing', 'adhil');
    rev('seagate', 1.25 * D, 'fee', extend(by('adhil'), {
      body: 'Handling fee quoted: ₹300 (bought elsewhere).', meta: { amount: 300, status: 'quoted' }
    }));
    rmove('seagate', 1.2 * D, 'testing', 'awaiting_docs', 'adhil',
          'We need your purchase invoice and your go-ahead on the ₹300 handling fee before we send it to Seagate.');

    rmove('h100i', 5 * D, null, 'received', 'ancy', 'Received (Walk-in). Fault: Pump makes a grinding noise.');
    rmove('h100i', 4.8 * D, 'received', 'testing', 'adhil');
    rmove('h100i', 3 * D, 'testing', 'ready_to_ship', 'adhil');
    rmove('h100i', 2 * D, 'ready_to_ship', 'with_vendor', 'adhil', 'Sent to Corsair (Blue Dart 71234598765)');

    rmove('ssd980', 6 * D, null, 'received', 'amal', 'Received (Shop stock). Fault: Drops off the bus under sustained writes.', false);
    rev('ssd980', 5.6 * D, 'edit', extend(by('amal'), {
      body: 'Data on the drive: ' + ((St && St.DATA_HANDLING && St.DATA_HANDLING.wiped_by_us) || 'We wiped it') + '.',
      meta: { field: 'data_handling', value: 'wiped_by_us' }
    }));
    rmove('ssd980', 5.5 * D, 'received', 'ready_to_ship', 'amal', null, false);
    rmove('ssd980', 5 * D, 'ready_to_ship', 'with_vendor', 'amal', 'Sent to Samsung (hand delivered by Vinayakan S)', false);

    rmove('msi650', 20 * D, null, 'received', 'anagha', 'Received (Walk-in). Fault: Clicks and shuts off as soon as it is powered on.');
    rmove('msi650', 19.9 * D, 'received', 'testing', 'vinayak');
    rmove('msi650', 19.5 * D, 'testing', 'ready_to_ship', 'vinayak');
    rmove('msi650', 19 * D, 'ready_to_ship', 'with_vendor', 'vinayak', 'Sent to MSI (DTDC D45118876501)');
    rmove('msi650', 2 * D, 'with_vendor', 'back_from_vendor', 'vinayak', 'Back from MSI: replaced');
    rmove('msi650', 2 * D - 1 * H, 'back_from_vendor', 'ready_to_return', 'vinayak', 'Replacement tested. Ready to collect.');
    rmove('msi650', closedAgo, 'ready_to_return', 'closed', 'anagha', 'Collected by Nikhil Raj. Replaced under warranty.');

    rmove('rtx4070ti', 17 * D, null, 'received', 'athul', 'Received (From a ticket). Fault: No output on a known-good bench.');
    rmove('antec650', 17 * D, null, 'received', 'athul', 'Received (From a ticket). Fault: Burning smell, then the PC would not power on.');
    // Holding unit received → the sync moves the ticket to rma_raised.
    // Same moment as the part event: the server syncs inside that transaction.
    // Bodies worded as rma_sync_ticket words them.
    syncMove('vishnu', 17 * D, 'diagnosing', 'rma_raised', 'Warranty claim raised: Graphics card (RM-DEMOE9TU).');
    rmove('rtx4070ti', 16.9 * D, 'received', 'testing', 'athul');
    rmove('antec650', 16.9 * D, 'received', 'testing', 'athul');
    rev('antec650', 16.85 * D, 'fee', extend(by('athul'), {
      body: 'Handling fee quoted: ₹300 (bought elsewhere).', meta: { amount: 300, status: 'quoted' }
    }));
    rmove('antec650', 16.8 * D, 'testing', 'awaiting_docs', 'athul',
          'We need your purchase invoice and your go-ahead on the ₹300 handling fee before we send it to Antec.');
    rmove('rtx4070ti', 16.5 * D, 'testing', 'ready_to_ship', 'athul');
    rmove('rtx4070ti', 16 * D, 'ready_to_ship', 'with_vendor', 'athul', 'Sent to ASUS (Blue Dart 71234511223)');
    syncMove('vishnu', 16 * D, 'rma_raised', 'at_vendor', 'Waiting on ASUS — Graphics card (RM-DEMOE9TU) sent under warranty.');
    rev('antec650', 14.2 * D, 'fee', extend(by('anagha'), {
      body: 'Customer accepted the ₹300 handling fee on WhatsApp.', meta: { amount: 300, status: 'accepted' }
    }));
    rmove('antec650', 14 * D, 'awaiting_docs', 'ready_to_ship', 'athul', 'Invoice received. Warranty claim being prepared.');
    rmove('antec650', 13.5 * D, 'ready_to_ship', 'with_vendor', 'athul', 'Sent to Antec (DTDC D45119023344)');
    rmove('antec650', 1.5 * D, 'with_vendor', 'back_from_vendor', 'athul',
          'Antec declined the claim: burnt component on the PCB; physical damage is not covered.');
    rmove('antec650', 1 * D, 'back_from_vendor', 'customer_decision', 'athul',
          'Your options: we return the PSU as it is, we dispose of it, or we fit a new one as a paid repair.');
    sev('vishnu', 1 * D - 30 * MIN, 'note', extend(by('athul'), {
      body: 'Chased the ASUS service centre: overdue against their 14 days. Escalated, reference A4471.'
    }));

    rmove('rx6600', 1 * D, null, 'logged', 'ancy', 'Expected — Website. Courier: Professional Couriers PCKCH20871234.');

    rmove('lg24', 4 * D, null, 'received', 'ancy', 'Received (Walk-in). Fault: Screen flickers and goes black every few minutes.');
    rmove('lg24', 3.9 * D, 'received', 'testing', 'vinayak');
    rmove('lg24', 1.2 * D, 'testing', 'ready_to_return', 'vinayak',
          'No fault found after 48 hours of testing. The flicker followed your HDMI cable. Ready to collect.');

    // rma_create's wording for a field pull.
    rmove('cv550', pulledAgo, null, 'with_tech', 'athul',
          'With our technician — collected on site. Fault: Dead since the storm: no 12 V on the 24-pin.');

    // ── shipments (rma_shipments + rma_shipment_items) ─────────────────────
    ship(['rm750', 'kingston', 'sn570'], {
      direction: 'in_from_customer', courier: 'DTDC', awb: 'D45127788310',
      dispatched_at: ago(6 * H), delivered_at: ago(6 * H), created_by_email: STAFF.anagha.email
    });
    ship(['rx6600'], {
      direction: 'in_from_customer', courier: 'Professional Couriers', awb: 'PCKCH20871234',
      dispatched_at: ago(1 * D), created_by_email: STAFF.ancy.email
    });
    ship(['msi650'], {
      vendor_id: V.MSI.id, courier: 'DTDC', awb: 'D45118876501', cost: 120,
      dispatched_at: ago(19 * D), created_by_email: STAFF.vinayak.email
    });
    ship(['rtx4070ti'], {
      vendor_id: V.ASUS.id, courier: 'Blue Dart', awb: '71234511223', cost: 220,
      dispatched_at: ago(16 * D), created_by_email: STAFF.athul.email
    });
    ship(['antec650'], {
      vendor_id: V.Antec.id, courier: 'DTDC', awb: 'D45119023344', cost: 120,
      dispatched_at: ago(13.5 * D), created_by_email: STAFF.athul.email
    });
    ship(['ssd980'], {
      vendor_id: V.Samsung.id, mode: 'hand_delivery', carried_by: STAFF.vinayak.full_name,
      notes: 'Dropped at the Samsung service centre, Palarivattom, on the way to a visit.',
      dispatched_at: ago(5 * D), created_by_email: STAFF.amal.email
    });
    ship(['h100i'], {
      vendor_id: V.Corsair.id, courier: 'Blue Dart', awb: '71234598765', cost: 180,
      dispatched_at: ago(2 * D), created_by_email: STAFF.adhil.email
    });

    events.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    rmaEvents.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });

    // updated_at follows the latest thing that happened to the row.
    events.forEach(function (e) {
      if (!e.job_id) return;
      jobs.forEach(function (j) { if (j.id === e.job_id && e.at > j.updated_at) j.updated_at = e.at; });
    });
    rmaEvents.forEach(function (e) {
      units.forEach(function (u) { if (u.id === e.case_id && e.at > u.updated_at) u.updated_at = e.at; });
    });

    // ── staff, as profiles and as service_tech_list() rows ─────────────────
    var staff = STAFF_ORDER.map(function (k) {
      var p = STAFF[k];
      return { id: p.id, email: p.email, full_name: p.full_name, designation: p.designation, active: p.active, tier: p.tier };
    });
    var todayStr = new Date(now).toDateString();
    var techs = STAFF_ORDER.filter(function (k) { return STAFF[k].role === 'tech'; }).map(function (k) {
      var p = STAFF[k];
      var mine = jobs.filter(function (j) { return j.assignee_email === p.email && j.stage !== 'closed'; });
      return {
        email: p.email, name: p.full_name, designation: p.designation, role: p.role,
        open_count: mine.length,
        visits_today: mine.filter(function (j) { return j.visit_start && new Date(j.visit_start).toDateString() === todayStr; }).length,
        in_queue_requested: jobs.filter(function (j) {
          return j.suggested_tech_email === p.email && !j.assignee_email && j.stage !== 'closed';
        }).length
      };
    }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

    return {
      jobs: jobs,
      items: items,
      units: units,
      intakes: intakes,
      vendors: vendors,
      events: events.concat(rmaEvents).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; }),
      staff: staff,
      media: [],
      rma_events: rmaEvents,
      techs: techs,
      customers: customers,
      shipments: shipments,
      shipment_items: shipmentItems
    };

    // "Thu, 23 Oct, 2:30 pm" in local time, for event bodies.
    function fmtWhen(ms) {
      try {
        var d = new Date(ms);
        return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' +
               d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
      } catch (e) { return new Date(ms).toISOString(); }
    }
  }

  // The lookup_customer() RPC (§2.3) answered from a built demo set, so the
  // intake's phone-first lookup works in demo mode without the server.
  function lookupCustomer(data, phone) {
    var d = data || {};
    var p = normPhone(phone);
    var empty = { phone_norm: p, customer: null, open_jobs: [], recent_jobs: [], jobs_total: 0, open_rma: [], past_techs: [] };
    if (!phoneOk(p)) return empty;            // A1': the same test as SQL phone_ok()
    var c = (d.customers || []).filter(function (x) { return x.phone_norm === p; })[0] || null;
    var mine = (d.jobs || []).filter(function (j) { return normPhone(j.customer_phone) === p; })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    var intakeById = {};
    (d.intakes || []).forEach(function (i) { intakeById[i.id] = i; });
    var rma = (d.units || []).filter(function (u) {
      if (u.stage === 'closed') return false;
      var tracking = u.owner_phone || (intakeById[u.intake_id] && intakeById[u.intake_id].sender_phone);
      return normPhone(tracking) === p;
    });
    var techs = {};
    mine.forEach(function (j) {
      if (!j.assignee_email) return;
      var k = j.assignee_email;
      if (!techs[k]) techs[k] = { email: k, name: j.assignee, jobs: 0, last_at: j.created_at };
      techs[k].jobs++;
      if (j.created_at > techs[k].last_at) techs[k].last_at = j.created_at;
    });
    return {
      phone_norm: p,
      customer: c ? { id: c.id, name: c.name, email: c.email, kind: c.kind, address: c.address, area: c.area,
                      pincode: c.pincode, landmark: c.landmark, maps_url: c.maps_url } : null,
      open_jobs: mine.filter(function (j) { return j.stage !== 'closed'; }).map(function (j) {
        return { id: j.id, public_code: j.public_code, service_type: j.service_type, stage: j.stage,
                 device_label: j.device_label, created_at: j.created_at, assignee: j.assignee };
      }),
      recent_jobs: mine.filter(function (j) { return j.stage === 'closed'; }).slice(0, 5).map(function (j) {
        return { public_code: j.public_code, service_type: j.service_type, stage: j.stage, outcome: j.outcome,
                 device_label: j.device_label, created_at: j.created_at, closed_at: j.closed_at, assignee: j.assignee };
      }),
      jobs_total: mine.length,
      open_rma: rma.map(function (u) {
        return { id: u.id, public_code: u.public_code, kind: u.kind, brand: u.brand, model: u.model, stage: u.stage };
      }),
      past_techs: Object.keys(techs).map(function (k) { return techs[k]; })
        .sort(function (a, b) { return a.last_at < b.last_at ? 1 : -1; })
    };
  }

  var api = {
    build: build,
    lookupCustomer: lookupCustomer,
    normPhone: normPhone,
    phoneOk: phoneOk,
    isDemoId: function (id) { return typeof id === 'string' && id.indexOf('demo_') === 0; }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcDemo = api;
  }
})(typeof window !== 'undefined' ? window : this);
