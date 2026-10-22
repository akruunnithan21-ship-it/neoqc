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
    field_day: 'Field day', missed_punch: 'Missed punch', leave: 'Leave'
  };
  var LEAVE_LABELS = { casual: 'Casual leave', sick: 'Sick leave', other: 'Other leave' };
  var REQUEST_STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    shiftsAfter: shiftsAfter
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
