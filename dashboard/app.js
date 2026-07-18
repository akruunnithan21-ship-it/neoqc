// ══════════════════════════════════════════════════════════
//  Neo Tokyo Kochi — Build Tracker Dashboard
//  Reads live from the same Supabase project as the Electron app.
// ══════════════════════════════════════════════════════════

// ── CONFIG — update these if credentials change ──────────
const SUPABASE_URL  = 'https://ggsxkhenzdhaachubrsc.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo';

// Change this PIN to whatever the staff password should be.
// Anyone who knows the URL + this PIN can view all tickets.
const SALES_PIN = '9374';
// ─────────────────────────────────────────────────────────

// Status ordering used for the customer stepper
const STATUS_STEPS = [
  { key: 'awaiting',   label: 'Awaiting\nParts',     icon: '📦' },
  { key: 'building',   label: 'In\nAssembly',         icon: '🔧' },
  { key: 'waiting_qc', label: 'Awaiting\nQC',         icon: '⏳' },
  { key: 'qc_testing', label: 'QC &\nTesting',        icon: '⚡' },
  { key: 'completed',  label: 'Ready for\nHandoff',   icon: '✓'  },
];

const STATUS_LABELS = {
  awaiting:   'Awaiting Components',
  building:   'In Assembly',
  waiting_qc: 'Awaiting QC',
  qc_testing: 'QC & Testing',
  completed:  'Completed',
};

// ── Init ──────────────────────────────────────────────────
let db = null;
let realtimeChannel = null;
let allTickets = [];

function initSupabase() {
  if (!window.supabase) return null;
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── Routing ───────────────────────────────────────────────
function getView() {
  return new URLSearchParams(location.search).get('view') || 'customer';
}

function activateView(name) {
  document.getElementById('view-customer').classList.toggle('hidden', name !== 'customer');
  document.getElementById('view-sales').classList.toggle('hidden', name !== 'sales');
  document.getElementById('nav-customer').classList.toggle('active', name === 'customer');
  document.getElementById('nav-sales').classList.toggle('active', name === 'sales');
}

// ═══════════════════════════════════════════════════════════
//  CUSTOMER VIEW
// ═══════════════════════════════════════════════════════════

function initCustomerView() {
  const input   = document.getElementById('ticket-code-input');
  const btnLook = document.getElementById('btn-lookup');

  btnLook.addEventListener('click', doLookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase();
    hideError();
  });
}

async function doLookup() {
  const raw  = document.getElementById('ticket-code-input').value.trim().toUpperCase();
  if (raw.length < 4) { showError('Please enter at least 4 characters of your ticket code.'); return; }

  showLoading(true);
  hideError();

  try {
    const { data, error } = await db
      .from('tickets')
      .select('id, customer_name, status, type, technician, created_at, deadline, completed_at, diagnostics')
      .filter('id', 'ilike', `%${raw.toLowerCase()}`)
      .limit(1);

    if (error) throw error;
    if (!data || data.length === 0) { showError('No ticket found for that code. Please double-check and try again.'); return; }

    renderStatusCard(data[0]);
    appendPpiSection(data[0].id);
    subscribeToTicket(data[0].id);
  } catch (err) {
    console.error('Lookup error:', err);
    showError('Could not connect to the server. Please try again in a moment.');
  } finally {
    showLoading(false);
  }
}

function renderStatusCard(row) {
  const card = document.getElementById('status-card');
  card.classList.remove('hidden');

  const shortId    = row.id.slice(-6).toUpperCase();
  const statusIdx  = STATUS_STEPS.findIndex(s => s.key === row.status);
  const statusLabel = STATUS_LABELS[row.status] || row.status || 'Unknown';
  const isComplete  = row.status === 'completed';

  // QC result — look inside diagnostics JSONB
  const diag = row.diagnostics || {};
  const qcPassed = isComplete
    ? (diag.cinebench || diag.furmark || diag.ssdRead)
      ? (
          (diag.cpuTempMax == null || diag.cpuTempMax <= 85) &&
          (diag.gpuTempMax == null || diag.gpuTempMax <= 80)
        )
      : null
    : null;

  card.innerHTML = `
    <div class="sc-header">
      <div>
        <div class="sc-customer">${escHtml(row.customer_name)}</div>
        <div class="sc-id">Ticket #${shortId}</div>
      </div>
      <span class="status-badge ${row.status || 'unknown'}">${escHtml(statusLabel)}</span>
    </div>

    <div class="sc-meta">
      <div class="sc-meta-item">
        <div class="label">Technician</div>
        <div class="value">${escHtml(row.technician || 'Unassigned')}</div>
      </div>
      <div class="sc-meta-item">
        <div class="label">Build Type</div>
        <div class="value">${row.type === 'build' ? 'New PC Build' : row.type === 'repair' ? 'Service Repair' : escHtml(row.type || '--')}</div>
      </div>
      <div class="sc-meta-item">
        <div class="label">Received On</div>
        <div class="value">${fmtDate(row.created_at)}</div>
      </div>
      <div class="sc-meta-item">
        <div class="label">${isComplete ? 'Completed On' : 'Target Ready By'}</div>
        <div class="value">${fmtDate(isComplete ? row.completed_at : row.deadline)}</div>
      </div>
    </div>

    <div class="stepper">
      ${STATUS_STEPS.map((step, i) => {
        const allDone = row.status === 'completed';
        const cls = (allDone || i < statusIdx) ? 'done' : i === statusIdx ? 'active' : '';
        const circleContent = (allDone || i < statusIdx) ? '✓' : i + 1;
        return `<div class="step ${cls}">
          <div class="step-circle">${circleContent}</div>
          <div class="step-label">${step.label.replace('\n', '<br>')}</div>
        </div>`;
      }).join('')}
    </div>

    ${qcPassed === true ? `<div class="sc-qc pass">✓ &nbsp;Quality checks passed — this system is cleared for handoff.</div>` : ''}
    ${qcPassed === false ? `<div class="sc-qc fail">✗ &nbsp;Some quality checks failed — the technician is reviewing the system.</div>` : ''}
    ${renderDiagnosticsDetail(diag)}
  `;
}

// Rich diagnostics detail — same shared render functions the technician app
// uses, so the customer sees identical data (component passports, Prime95
// torture-test results). Renders nothing for tickets without the new fields.
function renderDiagnosticsDetail(diag) {
  const R = window.NeoQcDiagnosticsRender;
  if (!R || !diag) return '';
  let html = '';
  if (diag.componentPassport) {
    html += `<div class="sc-diag-section"><div class="sc-diag-title">Component Health Passport</div>${R.renderPassportGrid(diag.componentPassport)}</div>`;
  }
  if (diag.prime95 && diag.prime95.overallResult && diag.prime95.overallResult !== 'not-run') {
    html += `<div class="sc-diag-section"><div class="sc-diag-title">Stability Torture Test</div>${R.renderPrime95Panel(diag.prime95)}</div>`;
  }
  if (diag.portScan && (diag.portScan.usbControllers || diag.portScan.audioEndpoints)) {
    html += `<div class="sc-diag-section"><div class="sc-diag-title">System Ports &amp; Connectivity</div>${R.renderPortCheckPanel(diag.portScan)}</div>`;
  }
  if (diag.rgbSyncV2 && diag.rgbSyncV2.controllerFound) {
    html += `<div class="sc-diag-section"><div class="sc-diag-title">RGB Lighting</div>${R.renderRgbSyncPanel(diag.rgbSyncV2)}</div>`;
  }
  return html;
}

// Price-to-Performance — reads the precomputed ticket_ppi row (written by
// ppi_sync.py on the staff side) and appends it to the status card. Same
// shared renderPpiPanel the technician app uses, so both show identical data.
async function appendPpiSection(ticketId) {
  const R = window.NeoQcDiagnosticsRender;
  if (!R || !ticketId) return;
  try {
    const { data, error } = await db
      .from('ticket_ppi').select('*').eq('ticket_id', ticketId).maybeSingle();
    if (error || !data) return;
    const card = document.getElementById('status-card');
    if (!card) return;
    card.querySelectorAll('.sc-ppi-section').forEach(el => el.remove()); // no dupes on realtime refresh
    const div = document.createElement('div');
    div.className = 'sc-diag-section sc-ppi-section';
    div.innerHTML = `<div class="sc-diag-title">Price-to-Performance</div>` + R.renderPpiPanel(data);
    card.appendChild(div);
  } catch (e) {
    console.error('PPI section failed:', e);
  }
}

// Realtime — keep the customer's card up-to-date while they watch
function subscribeToTicket(ticketId) {
  if (realtimeChannel) { db.removeChannel(realtimeChannel); }
  realtimeChannel = db
    .channel(`ticket-${ticketId}`)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'tickets',
      filter: `id=eq.${ticketId}`,
    }, payload => {
      if (payload.new) {
        renderStatusCard(payload.new);
        appendPpiSection(payload.new.id); // re-attach after full card re-render
      }
    })
    .subscribe();
}

function showError(msg) {
  const el = document.getElementById('lookup-error');
  document.getElementById('lookup-error-text').textContent = msg;
  el.classList.remove('hidden');
  document.getElementById('status-card').classList.add('hidden');
}
function hideError() {
  document.getElementById('lookup-error').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  SALES VIEW
// ═══════════════════════════════════════════════════════════

const SESSION_KEY = 'ntk_sales_unlocked';

function initSalesView() {
  document.getElementById('btn-pin-submit').addEventListener('click', tryPin);
  document.getElementById('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  document.getElementById('pin-input').addEventListener('input', () => {
    document.getElementById('pin-error').classList.add('hidden');
  });

  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('filter-status').addEventListener('change', renderTable);
  document.getElementById('filter-search').addEventListener('input', renderTable);
  initQueryUI();

  // Check if already unlocked this session
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    unlockSales();
  }
}

function tryPin() {
  const val = document.getElementById('pin-input').value;
  if (val === SALES_PIN) {
    sessionStorage.setItem(SESSION_KEY, '1');
    unlockSales();
  } else {
    document.getElementById('pin-error').classList.remove('hidden');
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-input').focus();
  }
}

async function unlockSales() {
  document.getElementById('pin-gate').classList.add('hidden');
  document.getElementById('sales-content').classList.remove('hidden');
  await loadAllTickets();
  loadQueryCounts();
  subscribeSales();
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  document.getElementById('sales-content').classList.add('hidden');
  document.getElementById('pin-gate').classList.remove('hidden');
  document.getElementById('pin-input').value = '';
  if (realtimeChannel) { db.removeChannel(realtimeChannel); realtimeChannel = null; }
  allTickets = [];
}

async function loadAllTickets() {
  showLoading(true);
  try {
    const { data, error } = await db
      .from('tickets')
      .select('id, customer_name, status, type, technician, created_at, deadline, completed_at, diagnostics, updated_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    allTickets = data || [];
    renderTable();
    updateLiveIndicator(true);
  } catch (err) {
    console.error('Sales load error:', err);
    updateLiveIndicator(false);
  } finally {
    showLoading(false);
  }
}

function subscribeSales() {
  if (realtimeChannel) { db.removeChannel(realtimeChannel); }
  realtimeChannel = db
    .channel('sales-all-tickets')
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'tickets',
    }, payload => {
      const { eventType, new: row, old } = payload;
      if (eventType === 'INSERT') {
        allTickets.unshift(row);
      } else if (eventType === 'UPDATE') {
        const idx = allTickets.findIndex(t => t.id === row.id);
        if (idx !== -1) allTickets[idx] = row; else allTickets.unshift(row);
      } else if (eventType === 'DELETE') {
        allTickets = allTickets.filter(t => t.id !== old.id);
      }
      renderTable();
    })
    .subscribe(status => {
      updateLiveIndicator(status === 'SUBSCRIBED');
    });
}

function renderTable() {
  const statusFilter = document.getElementById('filter-status').value;
  const searchQuery  = document.getElementById('filter-search').value.toLowerCase().trim();

  let rows = allTickets.filter(t => {
    const matchStatus = statusFilter === 'all' || t.status === statusFilter;
    const matchSearch = !searchQuery
      || (t.customer_name || '').toLowerCase().includes(searchQuery)
      || (t.technician    || '').toLowerCase().includes(searchQuery)
      || t.id.includes(searchQuery.toLowerCase());
    return matchStatus && matchSearch;
  });

  // Stats
  const urgent = allTickets.filter(t => t.status !== 'completed' && isUrgent(t.deadline));
  const done   = allTickets.filter(t => t.status === 'completed');
  document.getElementById('stat-total').textContent  = `${allTickets.length} Ticket${allTickets.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-urgent').textContent = `${urgent.length} Urgent`;
  document.getElementById('stat-done').textContent   = `${done.length} Done`;

  const tbody = document.getElementById('sales-body');
  const noMsg = document.getElementById('no-tickets');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  tbody.innerHTML = rows.map(t => {
    const shortId     = t.id.slice(-6).toUpperCase();
    const statusLabel = STATUS_LABELS[t.status] || t.status || '—';
    const deadlineCls = isUrgent(t.deadline) ? 'urgent' : isPast(t.deadline) && t.status !== 'completed' ? 'past' : '';
    const qcHtml      = qcBadge(t);

    return `<tr>
      <td class="cell-id">#${shortId}</td>
      <td class="cell-customer">${escHtml(t.customer_name || '—')}</td>
      <td class="cell-type">${t.type === 'build' ? 'Build' : t.type === 'repair' ? 'Repair' : escHtml(t.type || '—')}</td>
      <td><span class="status-badge ${t.status || 'unknown'}">${escHtml(statusLabel)}</span></td>
      <td class="cell-tech">${escHtml(t.technician || 'Unassigned')}</td>
      <td class="cell-deadline ${deadlineCls}">${fmtDate(t.status === 'completed' ? t.completed_at : t.deadline)}</td>
      <td>${qcHtml}</td>
      <td class="cell-query">${queryBtnHtml(t, shortId)}</td>
    </tr>`;
  }).join('');
}

function qcBadge(t) {
  if (t.status !== 'completed') return '<span class="qc-badge na">—</span>';
  const d = t.diagnostics || {};
  const hasData = d.cpuTempMax != null || d.cinebench != null || d.furmark != null;
  if (!hasData) return '<span class="qc-badge na">Pending</span>';
  const pass =
    (d.cpuTempMax == null || d.cpuTempMax <= 85) &&
    (d.gpuTempMax == null || d.gpuTempMax <= 80) &&
    (d.ramStress == null  || d.ramStress === 'passed' || d.ramStress === true);
  return pass
    ? '<span class="qc-badge pass">✓ PASS</span>'
    : '<span class="qc-badge fail">✗ FAIL</span>';
}

function updateLiveIndicator(online) {
  const el = document.getElementById('live-indicator');
  if (!el) return;
  el.classList.toggle('offline', !online);
  el.innerHTML = online
    ? '<span class="live-dot"></span>LIVE'
    : '<span class="live-dot"></span>OFFLINE';
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

function isUrgent(deadline) {
  if (!deadline) return false;
  const diff = new Date(deadline) - new Date();
  return diff > 0 && diff < 2 * 24 * 60 * 60 * 1000; // within 48 hours
}

function isPast(deadline) {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  db = initSupabase();
  if (!db) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#e91e8c;">Supabase library failed to load. Check your internet connection.</div>';
    return;
  }

  const view = getView();
  activateView(view);

  initCustomerView();
  initSalesView();
});

// ═══════════════════════════════════════════════════════════
//  QUERY SYSTEM (v1.4.8) — sales posts, technician replies
//  Sales staff raise a question against a build here; it surfaces
//  inside the ticket in the admin app, where the technician replies.
// ═══════════════════════════════════════════════════════════

// Backed by the existing ticket_queries table:
//   { id, ticket_id, question, answer, status:'open'|'answered'|'resolved', created_at }
// Sales asks a question here; the technician fills in the answer from inside
// the ticket modal in the admin app.
let queryCounts = {};        // { ticket_id: { awaiting, answered, total } }
let qmTicketId  = null;
let qmChannel   = null;

function queryBtnHtml(t, shortId) {
  const c = queryCounts[t.id] || { awaiting: 0, answered: 0, total: 0 };
  const label = `#${shortId} · ${escHtml(t.customer_name || '')}`;
  let badge = '';
  if (c.awaiting > 0)      badge = `<span class="qm-badge open" title="Awaiting technician reply">${c.awaiting}</span>`;
  else if (c.answered > 0) badge = `<span class="qm-badge done" title="Answered">✓</span>`;
  return `<button class="qm-open-btn" data-tid="${escHtml(t.id)}" data-label="${label}" title="Open queries">💬${badge}</button>`;
}

// status/answer → is this query still awaiting a technician reply?
function qIsAwaiting(q) { return q.status !== 'resolved' && !q.answer; }
function qIsAnswered(q) { return q.status !== 'resolved' && !!q.answer; }

async function loadQueryCounts() {
  if (!db) return;
  try {
    const { data, error } = await db.from('ticket_queries').select('ticket_id, status, answer');
    if (error) throw error;
    const map = {};
    (data || []).forEach(q => {
      const m = map[q.ticket_id] || (map[q.ticket_id] = { awaiting: 0, answered: 0, total: 0 });
      m.total++;
      if (qIsAwaiting(q)) m.awaiting++;
      else if (qIsAnswered(q)) m.answered++;
    });
    queryCounts = map;
    renderTable();
  } catch (err) {
    console.warn('Query counts unavailable:', err.message);
  }
}

function initQueryUI() {
  // Row buttons (event delegation — rows are re-rendered constantly)
  document.getElementById('sales-body').addEventListener('click', e => {
    const btn = e.target.closest('.qm-open-btn');
    if (btn) openQueryModal(btn.dataset.tid, btn.dataset.label);
  });
  document.getElementById('qm-close').addEventListener('click', closeQueryModal);
  document.getElementById('query-modal').addEventListener('click', e => {
    if (e.target.id === 'query-modal') closeQueryModal();
  });
  document.getElementById('qm-send').addEventListener('click', sendQuery);
  document.getElementById('qm-message').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendQuery();
  });
}

async function openQueryModal(ticketId, label) {
  qmTicketId = ticketId;
  document.getElementById('qm-ticket-label').textContent = label || ticketId;
  document.getElementById('qm-status').textContent = '';
  document.getElementById('query-modal').classList.remove('hidden');
  document.getElementById('qm-message').focus();
  await loadThread();
  // Live updates while the modal is open (needs realtime enabled on the table;
  // harmless no-op otherwise — a refresh on close still reconciles counts).
  if (qmChannel) db.removeChannel(qmChannel);
  qmChannel = db.channel('tq-' + ticketId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_queries', filter: `ticket_id=eq.${ticketId}` },
        () => { loadThread(); })
    .subscribe();
}

function closeQueryModal() {
  document.getElementById('query-modal').classList.add('hidden');
  qmTicketId = null;
  if (qmChannel) { db.removeChannel(qmChannel); qmChannel = null; }
  loadQueryCounts();
}

async function loadThread() {
  const thread = document.getElementById('qm-thread');
  try {
    const { data, error } = await db.from('ticket_queries')
      .select('*').eq('ticket_id', qmTicketId).order('created_at', { ascending: true });
    if (error) throw error;
    renderThread(data || []);
  } catch (err) {
    thread.innerHTML = `<div class="qm-empty">Couldn't load queries. ${escHtml(err.message)}</div>`;
  }
}

function renderThread(rows) {
  const thread = document.getElementById('qm-thread');
  if (!rows.length) {
    thread.innerHTML = '<div class="qm-empty">No queries yet. Ask the technician anything about this build.</div>';
    return;
  }
  thread.innerHTML = rows.map(q => {
    const resolved = q.status === 'resolved';
    const answerBlock = q.answer
      ? `<div class="qm-msg tech">
           <div class="qm-msg-head"><span class="qm-who">🔧 Technician replied</span></div>
           <div class="qm-body">${escHtml(q.answer)}</div>
         </div>`
      : `<div class="qm-awaiting">⏳ Awaiting technician reply…</div>`;
    return `<div class="qm-item ${resolved ? 'resolved' : ''}">
      <div class="qm-msg sales">
        <div class="qm-msg-head">
          <span class="qm-who">🛍️ Sales asked</span>
          <span class="qm-time">${fmtDateTime(q.created_at)}</span>
        </div>
        <div class="qm-body">${escHtml(q.question)}</div>
      </div>
      ${answerBlock}
      <div class="qm-item-foot">
        ${resolved ? '<span class="qm-resolved-tag">✓ Resolved</span>' : ''}
        <button class="qm-resolve" data-id="${q.id}" data-val="${resolved ? 'open' : 'resolved'}">${resolved ? '↩ Reopen' : '✓ Mark resolved'}</button>
      </div>
    </div>`;
  }).join('');
  thread.querySelectorAll('.qm-resolve').forEach(b =>
    b.addEventListener('click', () => setStatus(b.dataset.id, b.dataset.val)));
  thread.scrollTop = thread.scrollHeight;
}

async function sendQuery() {
  const msgEl  = document.getElementById('qm-message');
  const status = document.getElementById('qm-status');
  const question = msgEl.value.trim();
  if (!question) { status.textContent = 'Type a question first.'; return; }
  status.textContent = 'Sending…';
  try {
    const { error } = await db.from('ticket_queries').insert({
      ticket_id: qmTicketId, question, status: 'open'
    });
    if (error) throw error;
    msgEl.value = '';
    status.textContent = 'Sent — the technician will see it inside the ticket.';
    await loadThread();
  } catch (err) {
    status.textContent = 'Could not send: ' + err.message;
  }
}

async function setStatus(id, newStatus) {
  try {
    const { error } = await db.from('ticket_queries').update({ status: newStatus }).eq('id', id);
    if (error) throw error;
    await loadThread();
  } catch (err) {
    document.getElementById('qm-status').textContent = 'Update failed: ' + err.message;
  }
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
