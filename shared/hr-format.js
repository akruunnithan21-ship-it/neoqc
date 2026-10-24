/*
  Neo OS — NeoHR's display and export rules, as pure functions:
  window.NeoQcHrFormat (and module.exports for node tests). New in 1.12.

  No DOM, no network. The NeoHR screen (neohr.js) uses these for every
  label, time and CSV cell, and tests/hr-format.test.js pins them, so the
  rules HR-SPEC §9 sets down cannot drift quietly:

    - CSV (§9.8). The columns are fixed. Every cell is quoted, a " inside it
      is doubled, and a cell that starts with = + - @ TAB or CR gets a
      leading ' so a spreadsheet never runs it as a formula. A CSV never
      holds coordinates, notes, reasons or the leave type.
    - Clock marks (§9.3.3, approvers only): time_source 'device' → "⏱ time
      not verified"; 'server' with |device_at − at| > 300 s → "⏱ phone
      clock off by N min". The person's own screens never show them.
    - India time (§9.3.2). Days and clock times are IST (+05:30, no daylight
      saving). The weekday of a day is getUTCDay() of that IST date, so
      0 = Sunday, the same numbers as hr_settings.weekly_off.
    - Settings bounds (§9.4.6): the same ranges and sentences the server
      answers with, so a mistake is said before anything is sent.
    - Shift history (§9.4.6): the shift in force on a day is the history row
      with the greatest effective_from ≤ that day. hr_settings' own shift
      fields are a copy of the NEWEST default row, which may only start
      later, so the screen reads the history rows instead (shiftOn).

  The distance and day-record rules are NOT here: the server computes km,
  stops and every day record (§9.5), and the desktop only shows them.

  1.12.1 (sql/neohr-hr-v2.4.sql, NEOHR 2.3 spec §1/§7): the words for the
  checked punch — the place the server worked out (office / away / unknown
  / unset) and how far from the shop, how sure it is (verify), the server's
  flags, the punch-in reason, the photo — the two punch request kinds
  (punch_reason "Punch-in reason", away_punch "Away from shop") with what
  approving or rejecting each one does, trips, and the new day marks
  (late_excused, pending_reason, away_pending). Every vocabulary has a
  fallback: a word this file does not know is shown as itself, never
  dropped, so a newer server never breaks an older screen.
*/
(function (global) {
  'use strict';

  var MIN = 60000;
  var DAY = 86400000;
  var IST_MS = 330 * MIN;
  var SKEW_MS = 300 * 1000;                 // a phone clock more than 5 minutes off is marked

  var REGISTER_COLUMNS = ['name', 'date', 'duty', 'status', 'first_in', 'last_out', 'worked', 'break', 'late', 'early',
                          'flex', 'missed_out', 'km'];
  var TA_COLUMNS = ['name', 'month', 'km', 'rate', 'amount', 'approved_by', 'approved_at'];

  var SELF_SENTENCE = 'Someone else has to approve or change your own attendance, duty or travel allowance.';

  var LIVE_LABELS = {
    on_site: 'On site', on_duty: 'On duty', on_break: 'On break', not_in_yet: 'Not in yet', absent: 'Absent',
    on_leave: 'On leave', off_duty: 'Punched out', off: 'Off today', not_tracked: 'Not tracked'
  };
  var LIVE_ORDER = ['on_site', 'on_duty', 'on_break', 'not_in_yet', 'absent', 'on_leave', 'off_duty', 'off', 'not_tracked'];
  var DAY_LABELS = {
    present: 'Present', late: 'Late', half_day: 'Half day', absent: 'Absent', leave: 'Leave', off: 'Off',
    open: 'On duty', not_in_yet: 'Not in yet', not_tracked: 'Not tracked'
  };
  // One or two characters for the month grid (always beside a colour, never
  // instead of one). Off is a dash: an O reads as a zero in the grid's font.
  var DAY_CODES = {
    present: 'P', late: 'L', half_day: 'H', absent: 'A', leave: 'LV', off: '–', open: '•', not_in_yet: '…', not_tracked: 'NT'
  };
  var DUTY_LABELS = { shop: 'Shop', field: 'Field', off: 'Off', leave: 'Leave', wfh: 'Work from home' };
  var DUTIES = ['shop', 'field', 'off', 'leave', 'wfh'];
  var EVENT_LABELS = { punch_in: 'Punch in', punch_out: 'Punch out', break_start: 'Break start', break_end: 'Break end' };
  var EVENT_KINDS = ['punch_in', 'break_start', 'break_end', 'punch_out'];
  var REQUEST_LABELS = {
    late_start: 'Late start', early_leave: 'Early leave', flexible_day: 'Flexible day (on-site / RMA)',
    field_day: 'Field day', missed_punch: 'Missed punch', leave: 'Leave',
    punch_reason: 'Punch-in reason', away_punch: 'Away from shop'
  };
  // The kinds the server makes at punch time (v2.4). They are decided with
  // hr_punch_request_decide, never hr_request_decide.
  var PUNCH_REQUEST_KINDS = ['punch_reason', 'away_punch'];
  var LEAVE_LABELS = { casual: 'Casual leave', sick: 'Sick leave', other: 'Other leave' };
  var REQUEST_STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── v1.12.1: the checked punch (sql v2.4 §1.3) ────────────────────────────
  // The reason picked at punch-in (attendance_events.reason_kind).
  var REASON_LABELS = { late: 'Late', on_site: 'On-site', rma: 'RMA', other: 'Own reason' };
  // Where the SERVER puts the punch (its own distance from the office point).
  var PLACE_LABELS = { office: 'At the shop', away: 'Away from the shop', unknown: 'No location', unset: 'Office location not set' };
  // How sure the server is about that place.
  var VERIFY_LABELS = {
    ok: 'Verified', weak_fix: 'Weak GPS', no_fix: 'No location', mock: 'Fake GPS',
    old_app: 'Not verified — old NeoHR', restored: 'Restored from a backup', hr: 'Added by HR'
  };
  // The server's flags on a punch, short (a tag) and long (its title).
  var FLAG_LABELS = {
    sent_late: 'Sent late', new_login: 'New sign-in', odd_client: 'Not sent by NeoHR', no_ticket: 'No ticket',
    ticket_not_mine: 'Not their ticket', selfie_skip: 'No photo', selfie_late: 'Photo sent late', selfie_time: 'Photo time is off'
  };
  var FLAG_TIPS = {
    sent_late: 'The phone sent this punch more than 10 minutes after its time (it was offline, or the time was set back).',
    new_login: 'Sent from a sign-in that is new, or different from their usual phone. Check the photo.',
    odd_client: 'This punch did not come from the NeoHR app.',
    no_ticket: 'On-site or RMA was picked without a ticket.',
    ticket_not_mine: 'The ticket picked is not one of their service jobs or RMA parts.',
    selfie_skip: 'The phone could not take a photo.',
    selfie_late: 'The photo arrived more than 10 minutes after the punch.',
    selfie_time: 'The photo was taken well before or after the punch time.'
  };
  var SELFIE_SKIP_LABELS = { camera_error: 'the camera did not work', no_front_camera: 'no front camera' };
  // Trips (field staff, v2.4 §1.5).
  var TRIP_LABELS = { on_site: 'On-site trip', rma: 'RMA trip' };
  var TRIP_END_LABELS = {
    tapped: 'Ended on the phone', punch_out: 'Ended at punch-out', cap: 'Closed at the longest shift',
    next_trip: 'Next trip started', hr: 'Ended by HR'
  };
  var LIVE_TRIP_LABEL = 'On a trip';
  // The day record's new marks (v2.4 §1.4).
  var MARK_LABELS = { late_excused: 'Late excused', pending_reason: 'Reason waiting', away_pending: 'Away — waiting for HR' };

  // §9.4.6: label, key, range — the server's own sentences.
  var BOUNDS = [
    { key: 'grace_min', label: 'Grace', min: 0, max: 120 },
    { key: 'half_day_min', label: 'Half-day threshold', min: 60, max: 600 },
    { key: 'track_interval_s', label: 'Tracking interval', min: 30, max: 600 },
    { key: 'track_distance_m', label: 'Tracking distance', min: 25, max: 1000 },
    { key: 'retention_days', label: 'Retention', min: 30, max: 365 },
    { key: 'office_radius_m', label: 'Office radius', min: 50, max: 2000 },
    { key: 'max_session_h', label: 'Longest shift', min: 4, max: 24 }
  ];
  var SHIFT_KEYS = ['shift_start', 'shift_end', 'grace_min', 'weekly_off', 'half_day_min'];

  // ── small helpers ──────────────────────────────────────────────────────────
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function tsMs(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    var t = Date.parse(v);
    return isFinite(t) ? t : NaN;
  }
  function num(v) {
    if (v == null || v === '' || typeof v === 'boolean') return NaN;
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isFinite(Date.parse(s + 'T00:00:00Z')); }

  // ── India time ─────────────────────────────────────────────────────────────
  function istDay(ms) { var t = tsMs(ms); return isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : ''; }
  function istHm(v) {
    var t = tsMs(v);
    if (!isFinite(t)) return '';
    var d = new Date(t + IST_MS);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }
  function istDateTime(v) { var t = tsMs(v); return isFinite(t) ? istDay(t) + ' ' + istHm(t) : ''; }
  // An IST wall-clock day + 'HH:MM' → the instant (ISO).
  function istToIso(day, hm) {
    if (!isDay(day) || !/^\d{1,2}:\d{2}$/.test(String(hm || ''))) return null;
    var p = String(hm).split(':');
    var h = Number(p[0]), m = Number(p[1]);
    if (h > 23 || m > 59) return null;
    return new Date(Date.parse(day + 'T00:00:00Z') + (h * 60 + m) * MIN - IST_MS).toISOString();
  }
  function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
  function spanDays(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY); }
  // 0 = Sunday … 6 = Saturday, as extract(dow) and hr_settings.weekly_off.
  function weekdayOf(day) { return isDay(day) ? new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay() : -1; }
  // The Monday of the week holding day (the roster's week runs Monday–Sunday).
  function weekStart(day) { var w = weekdayOf(day); return w < 0 ? '' : addDays(day, -((w + 6) % 7)); }
  function monthStart(day) { return isDay(day) ? day.slice(0, 8) + '01' : ''; }
  function monthEnd(day) {
    if (!isDay(day)) return '';
    var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  function addMonths(day, n) {
    if (!isDay(day)) return '';
    var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1 + n;
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  function dayLabel(day, today) {
    if (!isDay(day)) return String(day || '');
    if (day === today) return 'Today';
    if (isDay(today) && day === addDays(today, -1)) return 'Yesterday';
    var d = new Date(Date.parse(day + 'T00:00:00Z'));
    var s = WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    return isDay(today) && day.slice(0, 4) === today.slice(0, 4) ? s : s + ' ' + day.slice(0, 4);
  }
  function monthLabel(day) {
    if (!isDay(day)) return '';
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
            'December'][Number(day.slice(5, 7)) - 1] + ' ' + day.slice(0, 4);
  }

  // ── numbers ────────────────────────────────────────────────────────────────
  // Minutes → 'H:MM' (the register and its CSV). Nothing / not a number → ''.
  function fmtHm(min) {
    var n = num(min);
    if (!isFinite(n)) return '';
    n = Math.max(0, Math.round(n));
    return Math.floor(n / 60) + ':' + pad2(n % 60);
  }
  // Minutes → '8h 05m' / '45m' (the screen).
  function fmtDur(min) {
    var n = num(min);
    if (!isFinite(n)) return '';
    n = Math.max(0, Math.round(n));
    if (n < 60) return n + 'm';
    return Math.floor(n / 60) + 'h ' + pad2(n % 60) + 'm';
  }
  // km is numeric(10,2) on the server; shown and exported with 2 decimals.
  function fmtKm(v) { var n = num(v); return isFinite(n) ? n.toFixed(2) : ''; }
  function fmtMoney(v) { var n = num(v); return isFinite(n) ? n.toFixed(2) : ''; }

  // ── clock marks (approvers only) ──────────────────────────────────────────
  // ev: { at, device_at, time_source }. → null | { kind, minutes, text }
  function clockMark(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var src = ev.time_source;
    if (src === 'device') return { kind: 'unverified', minutes: null, text: '⏱ time not verified' };
    if (src !== 'server') return null;
    var a = tsMs(ev.at), d = tsMs(ev.device_at);
    if (!isFinite(a) || !isFinite(d)) return null;
    var diff = Math.abs(d - a);
    if (diff <= SKEW_MS) return null;
    var n = Math.round(diff / MIN);
    return { kind: 'skew', minutes: n, text: '⏱ phone clock off by ' + n + ' min' };
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csvLine(cells) { return (cells || []).map(csvCell).join(','); }
  function toCsv(header, rows) {
    return [header].concat(rows || []).map(csvLine).join('\r\n') + '\r\n';
  }
  function yes(v) { return v === true ? 'yes' : ''; }
  // One register day → the fixed columns. rec: a day record with name/email
  // added (name falls back to the email). Statuses and duties as their labels.
  function registerRow(rec) {
    var r = rec || {};
    return [
      r.name || r.employee_name || r.email || r.employee_email || '',
      r.day || r.date || '',
      DUTY_LABELS[r.duty] || r.duty || '',
      DAY_LABELS[r.status] || r.status || '',
      r.first_in ? istDateTime(r.first_in) : '',
      r.last_out ? istDateTime(r.last_out) : '',
      fmtHm(r.worked_min),
      fmtHm(r.break_min),
      num(r.late_min) > 0 ? fmtHm(r.late_min) : '',
      num(r.early_min) > 0 ? fmtHm(r.early_min) : '',
      yes(r.flex),
      yes(r.missed_out),
      fmtKm(r.km)
    ];
  }
  function registerCsv(records) { return toCsv(REGISTER_COLUMNS, (records || []).map(registerRow)); }
  // One TA person for month (YYYY-MM-01) → the fixed columns.
  function taRow(rec, month) {
    var r = rec || {};
    var ap = r.approved && typeof r.approved === 'object' ? r.approved : null;
    return [
      r.name || r.employee_name || r.email || r.employee_email || '',
      String(month || r.month || '').slice(0, 7),
      fmtKm(r.km),
      fmtMoney(r.rate),
      fmtMoney(r.amount),
      ap ? (ap.by || ap.by_name || '') : '',
      ap && ap.at ? istDateTime(ap.at) : ''
    ];
  }
  function taCsv(records, month) { return toCsv(TA_COLUMNS, (records || []).map(function (r) { return taRow(r, month); })); }

  // ── settings checks (the server's sentences) ──────────────────────────────
  function hmMinutes(v) {
    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v == null ? '' : v).trim());
    if (!m) return NaN;
    var h = Number(m[1]), mm = Number(m[2]);
    return h <= 23 && mm <= 59 ? h * 60 + mm : NaN;
  }
  function weeklyOffOk(v) {
    if (!Array.isArray(v)) return false;
    var seen = {};
    for (var i = 0; i < v.length; i++) {
      var n = v[i];
      if (typeof n !== 'number' || n !== Math.floor(n) || n < 0 || n > 6 || seen[n]) return false;
      seen[n] = true;
    }
    return true;
  }
  // p: the keys being sent (a key left out is not checked; null = "use the
  // default" for a person). base: the values the shift check falls back on.
  // → the first problem as a sentence, or null.
  function checkSettings(p, base) {
    p = p || {}; base = base || {};
    for (var i = 0; i < BOUNDS.length; i++) {
      var b = BOUNDS[i];
      if (!Object.prototype.hasOwnProperty.call(p, b.key) || p[b.key] == null) continue;
      var n = num(p[b.key]);
      if (!isFinite(n) || n !== Math.floor(n) || n < b.min || n > b.max) return b.label + ' must be between ' + b.min + ' and ' + b.max + '.';
    }
    if (p.weekly_off != null && !weeklyOffOk(p.weekly_off)) return 'Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.';
    var s = p.shift_start != null ? p.shift_start : base.shift_start;
    var e = p.shift_end != null ? p.shift_end : base.shift_end;
    if (p.shift_start != null && !isFinite(hmMinutes(p.shift_start))) return 'Enter the shift start as HH:MM.';
    if (p.shift_end != null && !isFinite(hmMinutes(p.shift_end))) return 'Enter the shift end as HH:MM.';
    if ((p.shift_start != null || p.shift_end != null) && isFinite(hmMinutes(s)) && isFinite(hmMinutes(e)) && hmMinutes(e) <= hmMinutes(s)) {
      return 'The shift must end after it starts.';
    }
    if (p.ta_rate_per_km != null) {
      var r = num(p.ta_rate_per_km);
      if (!isFinite(r) || r < 0 || r > 1000) return 'Travel allowance rate must be between 0 and 1000.';
    }
    if ((p.office_lat != null && (!isFinite(num(p.office_lat)) || Math.abs(num(p.office_lat)) > 90)) ||
        (p.office_lng != null && (!isFinite(num(p.office_lng)) || Math.abs(num(p.office_lng)) > 180))) {
      return 'That office point is not on the map.';
    }
    return null;
  }
  function weeklyOffText(v) {
    if (!Array.isArray(v) || !v.length) return 'None';
    return v.slice().sort(function (a, b) { return a - b; }).map(function (n) { return WEEKDAYS_LONG[n] || String(n); }).join(', ');
  }
  function shiftText(s) {
    if (!s || typeof s !== 'object') return '';
    var a = String(s.start || s.shift_start || '').slice(0, 5), b = String(s.end || s.shift_end || '').slice(0, 5);
    return a && b ? a + '–' + b : '';
  }

  // ── shift history (§9.4.6) ────────────────────────────────────────────────
  // rows: shift-history rows {effective_from, shift_start, …}, in any order.
  function fromOf(r) { return r && r.effective_from != null ? String(r.effective_from).slice(0, 10) : ''; }
  // The row in force on day: the greatest effective_from ≤ day, or null.
  function shiftOn(rows, day) {
    if (!Array.isArray(rows) || !isDay(day)) return null;
    var best = null, bestFrom = '';
    for (var i = 0; i < rows.length; i++) {
      var f = fromOf(rows[i]);
      if (!isDay(f) || f > day) continue;
      if (!best || f > bestFrom) { best = rows[i]; bestFrom = f; }
    }
    return best;
  }
  // The rows that start after day (planned changes), earliest first.
  function shiftsAfter(rows, day) {
    if (!Array.isArray(rows) || !isDay(day)) return [];
    return rows.filter(function (r) { var f = fromOf(r); return isDay(f) && f > day; })
      .sort(function (a, b) { return fromOf(a).localeCompare(fromOf(b)); });
  }

  // ── v1.12.1: the checked punch, punch requests, trips ─────────────────────
  // A word from one of the vocabularies above; an unknown one as itself.
  function words(map, key) {
    if (key == null || key === '') return '';
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : String(key).replace(/_/g, ' ');
  }
  function isPunchRequestKind(kind) { return PUNCH_REQUEST_KINDS.indexOf(kind) !== -1; }
  // Metres from the shop → '80 m' / '1.2 km' / '14 km' ('' for nothing).
  function distText(m) {
    var n = num(m);
    if (!isFinite(n) || n < 0) return '';
    if (n < 10) return Math.round(n) + ' m';
    if (Math.round(n / 10) * 10 < 1000) return Math.round(n / 10) * 10 + ' m';
    if (n < 100000) return (Math.round(n / 100) / 10).toFixed(1) + ' km';
    return Math.round(n / 1000) + ' km';
  }
  // Where one punch was, as the server worked it out. x: {place, office_m,
  // verify}. A weak fix says so; 'away' says how far.
  function placeText(x) {
    if (!x || typeof x !== 'object') return '';
    var p = x.place, v = x.verify;
    var d = distText(x.office_m);
    if (v === 'mock') return VERIFY_LABELS.mock;
    if (p === 'office') return PLACE_LABELS.office + (v === 'weak_fix' ? ' (weak GPS)' : '');
    if (p === 'away') return d ? d + ' from the shop' : PLACE_LABELS.away;
    if (p === 'unknown') return v === 'weak_fix' ? 'Weak GPS' + (d ? ' (about ' + d + ' away)' : '') : PLACE_LABELS.unknown;
    if (p === 'unset') return PLACE_LABELS.unset;
    if (p) return words(PLACE_LABELS, p);
    return v && v !== 'ok' ? words(VERIFY_LABELS, v) : '';
  }
  // What placeText does not already say about how sure the server is:
  // an old NeoHR, a restored punch, HR's own punch ('' otherwise).
  function verifyText(x) {
    if (!x || typeof x !== 'object') return '';
    var v = x.verify;
    if (!v || v === 'ok' || v === 'weak_fix' || v === 'mock') return '';
    if (v === 'no_fix' && (x.place === 'unknown' || !x.place)) return '';
    return words(VERIFY_LABELS, v);
  }
  // The colour of the place tag: ok (green), away (amber), bad (red), muted.
  function placeTone(x) {
    if (!x || typeof x !== 'object') return 'muted';
    var v = x.verify, p = x.place;
    if (v === 'mock' || p === 'unknown') return 'bad';
    if (p === 'unset' || !p) return 'muted';
    if (p === 'away' || v === 'old_app' || v === 'restored' || v === 'weak_fix') return 'away';
    return p === 'office' ? 'ok' : 'muted';
  }
  // The server's flags on one punch (and a skipped photo) as
  // [{key, text, tip}], in the order the server sent them.
  function flagList(x) {
    if (!x || typeof x !== 'object') return [];
    var keys = Array.isArray(x.flags) ? x.flags.filter(function (f) { return typeof f === 'string' && f; }) : [];
    var out = [], seen = {};
    keys.forEach(function (k) {
      if (seen[k]) return;
      seen[k] = true;
      out.push({ key: k, text: words(FLAG_LABELS, k), tip: FLAG_TIPS[k] || '' });
    });
    if (x.selfie_skip && !seen.selfie_skip) {
      out.push({ key: 'selfie_skip', text: FLAG_LABELS.selfie_skip, tip: FLAG_TIPS.selfie_skip });
    }
    out.forEach(function (f) {
      if (f.key === 'selfie_skip' && x.selfie_skip) f.text = 'No photo (' + words(SELFIE_SKIP_LABELS, x.selfie_skip) + ')';
    });
    return out;
  }
  // The reason picked at punch-in in one line: 'Late — “Bus was late”',
  // 'On-site · NT-0412'. x: {reason_kind, reason_text, reason_ref}.
  function reasonText(x) {
    if (!x || typeof x !== 'object') return '';
    var k = x.reason_kind ? words(REASON_LABELS, x.reason_kind) : '';
    var t = x.reason_text != null ? String(x.reason_text).trim() : '';
    var ref = x.reason_ref != null ? String(x.reason_ref).trim() : '';
    var s = k;
    if (t && t !== k) s = (s ? s + ' — ' : '') + '“' + t + '”';
    if (ref) s = (s ? s + ' · ' : '') + ref;
    return s;
  }
  // When a waiting punch request should be decided: {text, late} or null.
  // past_eod is the server's; without it a due_at already gone (by nowMs,
  // the server's clock) counts as late too.
  function dueText(r, today, nowMs) {
    if (!r || typeof r !== 'object') return null;
    if (r.status && r.status !== 'pending') return null;
    var t = tsMs(r.due_at);
    if (r.past_eod === true || (r.past_eod == null && isFinite(t) && isFinite(num(nowMs)) && num(nowMs) > t)) {
      return { text: 'Past end of day', late: true };
    }
    if (!isFinite(t)) return null;
    var d = istDay(t);
    return { text: 'Decide by ' + istHm(t) + (isDay(today) && d !== today ? ' (' + dayLabel(d, today) + ')' : ''), late: false };
  }
  // What approving (or rejecting) a request does to the day, said before it
  // is done. '' when there is nothing more to say.
  function effectText(kind, approve, r) {
    r = r || {};
    if (kind === 'punch_reason') {
      return approve ? 'The late mark for that day goes. Nothing else on the day changes.'
                     : 'The late mark stays. They see your note on NeoHR.';
    }
    if (kind === 'away_punch') {
      return approve ? 'The punch counts, and the time it covers is added to their day.'
                     : 'The punch is removed from their day. If they did work, give the right time below and HR’s punch is added in its place.';
    }
    if (!approve) return '';
    if (kind === 'leave' && !r.half_day) return 'Those days are marked as leave on the roster (weekly offs and holidays skipped).';
    if (kind === 'field_day') return 'Those days are marked as field days on the roster.';
    if (kind === 'missed_punch') return 'The punch is added to the day as HR’s. If it no longer fits the day, Correct… opens on that day to approve it with the change it needs.';
    if (kind === 'late_start' || kind === 'early_leave' || kind === 'flexible_day' || kind === 'leave') return 'The day counts as flexible: no late or early marks.';
    return '';
  }
  // One trip in a few words: 'On-site trip · NT-0412' / 'RMA trip · Distributor run'.
  function tripText(t) {
    if (!t || typeof t !== 'object') return '';
    var k = t.kind ? words(TRIP_LABELS, t.kind) : 'Trip';
    var ref = t.ref_code ? String(t.ref_code) : (t.note ? String(t.note) : '');
    return k + (ref ? ' · ' + ref : '');
  }
  // A trip's times: '11:05–12:40' or '11:05 – still going'.
  function tripSpan(t) {
    if (!t || typeof t !== 'object') return '';
    var a = istHm(t.started_at);
    if (!a) return '';
    if (t.open === true || !t.ended_at) return a + ' – still going';
    return a + '–' + istHm(t.ended_at);
  }
  // A punch photo from the server (base64, line breaks allowed) as a data:
  // URL, or null when it is not a JPEG — nothing else is ever put in an img.
  var B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  function jpegDataUrl(b64) {
    if (typeof b64 !== 'string') return null;
    var s = b64.replace(/\s+/g, '');
    var m = /^data:image\/jpeg;base64,(.*)$/.exec(s);
    if (m) s = m[1];
    if (s.length < 16 || s.length % 4 !== 0 || !B64.test(s)) return null;
    if (s.slice(0, 4) !== '/9j/') return null;       // FF D8 FF, the JPEG start
    return 'data:image/jpeg;base64,' + s;
  }

  var api = {
    IST_MS: IST_MS,
    REGISTER_COLUMNS: REGISTER_COLUMNS,
    TA_COLUMNS: TA_COLUMNS,
    SELF_SENTENCE: SELF_SENTENCE,
    LIVE_LABELS: LIVE_LABELS,
    LIVE_ORDER: LIVE_ORDER,
    DAY_LABELS: DAY_LABELS,
    DAY_CODES: DAY_CODES,
    DUTY_LABELS: DUTY_LABELS,
    DUTIES: DUTIES,
    EVENT_LABELS: EVENT_LABELS,
    EVENT_KINDS: EVENT_KINDS,
    REQUEST_LABELS: REQUEST_LABELS,
    LEAVE_LABELS: LEAVE_LABELS,
    REQUEST_STATUS: REQUEST_STATUS,
    WEEKDAYS: WEEKDAYS,
    WEEKDAYS_LONG: WEEKDAYS_LONG,
    BOUNDS: BOUNDS,
    SHIFT_KEYS: SHIFT_KEYS,
    PUNCH_REQUEST_KINDS: PUNCH_REQUEST_KINDS,
    REASON_LABELS: REASON_LABELS,
    PLACE_LABELS: PLACE_LABELS,
    VERIFY_LABELS: VERIFY_LABELS,
    FLAG_LABELS: FLAG_LABELS,
    FLAG_TIPS: FLAG_TIPS,
    SELFIE_SKIP_LABELS: SELFIE_SKIP_LABELS,
    TRIP_LABELS: TRIP_LABELS,
    TRIP_END_LABELS: TRIP_END_LABELS,
    LIVE_TRIP_LABEL: LIVE_TRIP_LABEL,
    MARK_LABELS: MARK_LABELS,

    isDay: isDay,
    istDay: istDay,
    istHm: istHm,
    istDateTime: istDateTime,
    istToIso: istToIso,
    addDays: addDays,
    spanDays: spanDays,
    weekdayOf: weekdayOf,
    weekStart: weekStart,
    monthStart: monthStart,
    monthEnd: monthEnd,
    addMonths: addMonths,
    dayLabel: dayLabel,
    monthLabel: monthLabel,

    fmtHm: fmtHm,
    fmtDur: fmtDur,
    fmtKm: fmtKm,
    fmtMoney: fmtMoney,
    clockMark: clockMark,

    csvCell: csvCell,
    csvLine: csvLine,
    toCsv: toCsv,
    registerRow: registerRow,
    registerCsv: registerCsv,
    taRow: taRow,
    taCsv: taCsv,

    hmMinutes: hmMinutes,
    weeklyOffOk: weeklyOffOk,
    checkSettings: checkSettings,
    weeklyOffText: weeklyOffText,
    shiftText: shiftText,
    shiftOn: shiftOn,
    shiftsAfter: shiftsAfter,

    words: words,
    isPunchRequestKind: isPunchRequestKind,
    distText: distText,
    placeText: placeText,
    verifyText: verifyText,
    placeTone: placeTone,
    flagList: flagList,
    reasonText: reasonText,
    dueText: dueText,
    effectText: effectText,
    tripText: tripText,
    tripSpan: tripSpan,
    jpegDataUrl: jpegDataUrl
  };

  // ALWAYS set the browser global when a window exists (Electron renderers
  // define `module` too — see shared/matcher.js for the bug that taught us).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    global.NeoQcHrFormat = api;
  }
})(typeof window !== 'undefined' ? window : this);
