// ══════════════════════════════════════════════════════════
//  Neo Tokyo Kochi — Build Tracker Dashboard
//  Reads live from the same Supabase project as the Electron app.
// ══════════════════════════════════════════════════════════

// ── CONFIG — update these if credentials change ──────────
const SUPABASE_URL  = 'https://ggsxkhenzdhaachubrsc.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo';

// (Removed the old shared SALES_PIN gate — staff now sign in with their own
// Supabase account, and each PC keeps its own login. See webSignIn() below.)
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

// status goes into a CLASS ATTRIBUTE, and escHtml() below does not escape the
// single quote — so a status string is never interpolated raw. STATUS_LABELS is
// already the whitelist; anything outside it renders as the grey .unknown badge.
// This matters because renderStatusCard() is reachable by any member of the
// public via the ticket-code lookup, and RLS lets any signed-in staff account
// write the column.
function statusClass(s) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? s : 'unknown';
}

// ── Init ──────────────────────────────────────────────────
let db = null;
let realtimeChannel = null;   // customer view: one ticket
let staffChannel = null;      // staff view: every ticket (dashboard + board)
let allTickets = [];

function initSupabase() {
  if (!window.supabase) return null;
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── Routing ───────────────────────────────────────────────
function getView() {
  return new URLSearchParams(location.search).get('view') || 'customer';
}

// ── Auth + view routing + hamburger menu (v2.0.0 P3) ──────
let currentProfile = null;
// activateView() iterates this array to hide/show — a view missing from it is
// never un-hidden and renders as a blank page with no error. Always add here.
const VIEWS = ['customer', 'login', 'dashboard', 'profile', 'ticket-status', 'new-build', 'board', 'service'];

// Match a ticket's short technician name ("Athul") to a profile's full name
// ("Athul Sudheer") — same logic as the app's My Bench so a technician's web
// view lists exactly the builds assigned to them.
function technicianMatchesProfile(techName, profile) {
  if (!techName || !profile) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const a = norm(techName), b = norm(profile.full_name || '');
  if (!a.length || !b.length) return false;
  // Require EVERY word of the ticket's technician name to appear in the profile
  // (was .some, which matched on any single shared word). NOTE: names are not a
  // reliable identity key — real per-technician scoping is enforced server-side by
  // RLS on tickets (by profile uid). This client filter is UX only.
  return a.every(w => b.includes(w));
}

function activateView(name) {
  if (name === 'sales') name = currentProfile ? 'dashboard' : 'login';           // legacy deep-link
  if (['dashboard', 'profile', 'ticket-status', 'new-build', 'board'].includes(name) && !currentProfile) name = 'login';
  // Role guard: a technician (T2) never gets the full-floor Dashboard — even via
  // a ?view=dashboard deep-link — they're sent to their own My Builds list. (T1
  // sales and T3+ leads are unchanged.)
  if (name === 'dashboard' && currentProfile && Number(currentProfile.tier) === 2) name = 'ticket-status';
  // Quote building is a sales/lead activity — a technician (T2) is sent to My Builds.
  if (name === 'new-build' && currentProfile && Number(currentProfile.tier) === 2) name = 'ticket-status';
  // The sales pipeline is a sales/lead board — a technician (T2) gets My Builds.
  if (name === 'board' && currentProfile && Number(currentProfile.tier) === 2) name = 'ticket-status';
  // The service status page polls every 30s; navigating away must stop it.
  if (name !== 'service' && window.NeoQcServiceStatus) window.NeoQcServiceStatus.stopPolling();
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  closeMenu();
  if (name === 'dashboard') ensureDashboardLoaded();
  else if (name === 'ticket-status') ensureTicketStatusLoaded();
  else if (name === 'new-build') ensureQuoteBuilderLoaded();
  else if (name === 'board') ensureBoardLoaded();
  else if (name === 'service') { if (window.NeoQcServiceStatus) window.NeoQcServiceStatus.init(); }
  else if (name === 'profile') renderProfile();
  else if (name === 'login') setTimeout(() => { const e = document.getElementById('web-login-email'); if (e) e.focus(); }, 120);
}

function openMenu() {
  document.getElementById('side-menu').classList.add('open');
  document.getElementById('menu-overlay').classList.remove('hidden');
  document.getElementById('hamburger-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('side-menu').setAttribute('aria-hidden', 'false');
}
function closeMenu() {
  const sm = document.getElementById('side-menu'); if (!sm) return;
  sm.classList.remove('open');
  document.getElementById('menu-overlay').classList.add('hidden');
  document.getElementById('hamburger-btn').setAttribute('aria-expanded', 'false');
  sm.setAttribute('aria-hidden', 'true');
}
function initMenu() {
  document.getElementById('hamburger-btn').addEventListener('click', openMenu);
  document.getElementById('menu-close').addEventListener('click', closeMenu);
  document.getElementById('menu-overlay').addEventListener('click', closeMenu);
  const brand = document.getElementById('brand-home');
  if (brand) brand.addEventListener('click', e => { e.preventDefault(); activateView('customer'); });
  document.querySelectorAll('.menu-item[data-nav]').forEach(btn =>
    btn.addEventListener('click', () => activateView(btn.getAttribute('data-nav'))));
  const so = document.getElementById('menu-signout');
  if (so) so.addEventListener('click', webSignOut);
}

// Public vs staff menu; fill the user chip; Ticket Status only for T1.
function applyMenu() {
  const pub = document.getElementById('menu-public');
  const staff = document.getElementById('menu-staff');
  if (currentProfile) {
    pub.classList.add('hidden');
    staff.classList.remove('hidden');
    const first = (currentProfile.full_name || currentProfile.email || '?').trim();
    document.getElementById('menu-uname').textContent = first;
    // Show the designation only — the internal tier number is never shown to users.
    document.getElementById('menu-utier').textContent = currentProfile.designation || '';
    const av = document.getElementById('menu-avatar');
    if (currentProfile.avatar_url) { av.style.backgroundImage = `url("${currentProfile.avatar_url}")`; av.textContent = ''; }
    else { av.style.backgroundImage = ''; av.textContent = first.charAt(0).toUpperCase(); }
    // Role-based nav: technicians (T2) get "My Builds" (their own) and NOT the
    // full-floor Dashboard; T3+ keep the Dashboard; T1 keeps read-only Ticket Status.
    const tier = Number(currentProfile.tier);
    document.getElementById('menu-dashboard').classList.toggle('hidden', tier === 2);
    const tsBtn = document.getElementById('menu-ticketstatus');
    tsBtn.classList.toggle('hidden', !(tier === 1 || tier === 2));
    const tsLabel = document.getElementById('menu-ts-label');
    if (tsLabel) tsLabel.textContent = tier === 2 ? 'My Builds' : 'Ticket Status';
    // Quote builder: sales (T1) and leads/admin (T3+). Technicians build, not sell.
    const nbBtn = document.getElementById('menu-newbuild');
    if (nbBtn) nbBtn.classList.toggle('hidden', tier === 2);
    // Pipeline board: same audience as the quote builder — sales and leads.
    const bBtn = document.getElementById('menu-board');
    if (bBtn) bBtn.classList.toggle('hidden', tier === 2);
  } else {
    pub.classList.remove('hidden');
    staff.classList.add('hidden');
  }
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
    // Prefer the secure RPC (get_ticket_public), which works after the DB lockdown
    // where anon can no longer read the tickets table directly. Fall back to the
    // direct query when the RPC isn't deployed yet, so this page works BEFORE and
    // AFTER you run Part 2 of database-hardening.sql — deploy order no longer matters.
    let { data, error } = await db.rpc('get_ticket_public', { code: raw.toLowerCase() });
    if (error && (error.code === 'PGRST202' || /function|not exist|not found|schema cache/i.test(error.message || ''))) {
      ({ data, error } = await db
        .from('tickets')
        .select('id, customer_name, status, type, technician, created_at, deadline, completed_at, diagnostics')
        .filter('id', 'ilike', `%${raw.toLowerCase()}`)
        .limit(2));
    }

    if (error) throw error;
    if (!data || data.length === 0) { showError('No ticket found for that code. Please double-check and try again.'); return; }
    // A short suffix code can match more than one ticket id. Rather than silently
    // show an arbitrary one (limit(1) had no ordering → could be the WRONG build),
    // ask the customer for a few more characters.
    if (data.length > 1) { showError('That code matches more than one build. Please enter a few more characters of your ticket code.'); return; }

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

  // QC result — look inside diagnostics JSONB. Uses the SAME qcVerdict() helper as
  // the staff PASS/FAIL badge, so the customer can never be told "passed" while the
  // staff badge says fail (previously this ignored the RAM stress result).
  const diag = row.diagnostics || {};
  const qcPassed = isComplete ? qcVerdict(diag) : null;

  card.innerHTML = `
    <div class="sc-header">
      <div>
        <div class="sc-customer">${escHtml(row.customer_name)}</div>
        <div class="sc-id">Ticket #${shortId}</div>
      </div>
      <span class="status-badge ${statusClass(row.status)}">${escHtml(statusLabel)}</span>
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

// ═══════════════════════════════════════════════════════════
//  AUTH (v2.0.0 P3) — staff sign in with email + PIN (Supabase Auth).
//  Replaces the old shared SALES_PIN gate. The profile's tier decides which
//  menu items + views the person gets. Session persists across reloads.
// ═══════════════════════════════════════════════════════════
let dashboardLoaded = false;
let tsLoaded = false;

async function loadWebProfile() {
  try {
    const { data: u } = await db.auth.getUser();
    if (!u || !u.user) return false;
    const { data: p, error } = await db.from('profiles').select('*').eq('id', u.user.id).single();
    if (error || !p || p.active === false) return false;
    currentProfile = p;
    return true;
  } catch (e) { console.error('profile load failed', e); return false; }
}

async function webSignIn(email, pin) {
  const { data, error } = await db.auth.signInWithPassword({ email, password: pin });
  if (error || !data || !data.user) return { ok: false, msg: 'Incorrect email or PIN.' };
  const ok = await loadWebProfile();
  if (!ok) {
    try { await db.auth.signOut(); } catch (e) {}
    return { ok: false, msg: 'Your account isn’t set up yet or has been deactivated. Contact the admin.' };
  }
  return { ok: true };
}

async function webSignOut() {
  try { await db.auth.signOut(); } catch (e) {}
  currentProfile = null;
  dashboardLoaded = false; tsLoaded = false; boardLoaded = false;
  if (realtimeChannel) { try { db.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
  if (staffChannel)    { try { db.removeChannel(staffChannel);    } catch (e) {} staffChannel = null; }
  allTickets = [];
  applyMenu();
  activateView('customer');
}

function initLoginForm() {
  const form = document.getElementById('web-login-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (document.getElementById('web-login-email').value || '').trim().toLowerCase();
    const pin = (document.getElementById('web-login-pin').value || '').trim();
    const err = document.getElementById('web-login-error');
    const btn = document.getElementById('web-login-submit');
    err.classList.add('hidden');
    if (!email || !pin) { err.textContent = 'Enter your email and PIN.'; err.classList.remove('hidden'); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Signing in…';
    const res = await webSignIn(email, pin);
    btn.disabled = false; btn.textContent = old;
    if (!res.ok) { err.textContent = res.msg; err.classList.remove('hidden'); document.getElementById('web-login-pin').value = ''; return; }
    document.getElementById('web-login-pin').value = '';
    applyMenu();
    routeAfterWebLogin();
  });
}

function routeAfterWebLogin() {
  activateView(Number(currentProfile.tier) >= 3 ? 'dashboard' : 'ticket-status');
}

// ── Dashboard (all builds) — auth-gated (was unlockSales) ──────────────────
async function ensureDashboardLoaded() {
  if (!currentProfile) { activateView('login'); return; }
  if (!dashboardLoaded) {
    await loadAllTickets();
    loadQueryCounts();
    subscribeSales();
    dashboardLoaded = true;
  } else {
    renderTable();
  }
}

// ── Ticket Status (T1, read-only list) ─────────────────────────────────────
async function ensureTicketStatusLoaded() {
  if (!currentProfile) { activateView('login'); return; }
  if (!allTickets.length) await loadAllTickets();
  // My Builds was never live: this function fetched once and never subscribed,
  // so a technician's list went stale until they reloaded. subscribeSales() is
  // idempotent now, so calling it from every staff view is safe.
  subscribeSales();
  tsLoaded = true;
  const s = document.getElementById('ts-search');
  if (s && !s._wired) { s._wired = true; s.addEventListener('input', renderTicketStatus); }
  renderTicketStatus();
}
function renderTicketStatus() {
  const tier = currentProfile ? Number(currentProfile.tier) : 0;
  // Technicians (T2) see only builds assigned to them; T1 sees the whole list.
  let base = allTickets;
  if (tier === 2) base = base.filter(t => technicianMatchesProfile(t.technician, currentProfile));
  const titleEl = document.getElementById('ts-title');
  if (titleEl) titleEl.textContent = tier === 2 ? 'My Builds' : 'Ticket Status';
  const hintEl = document.getElementById('ts-hint');
  if (hintEl) hintEl.textContent = tier === 2
    ? 'The builds currently assigned to you.'
    : 'Live status of builds. (Raising new tickets from the web is coming soon.)';
  const q = (document.getElementById('ts-search').value || '').toLowerCase().trim();
  const rows = base.filter(t => !q
    || (t.customer_name || '').toLowerCase().includes(q)
    || (t.id || '').toLowerCase().includes(q));
  document.getElementById('ts-empty').classList.toggle('hidden', rows.length > 0);
  document.getElementById('ts-body').innerHTML = rows.map(t => `<tr>
    <td class="mono">#${escHtml((t.id || '').slice(-6))}</td>
    <td>${escHtml(t.customer_name || '')}</td>
    <td>${t.type === 'build' ? 'Build' : 'Repair'}</td>
    <td>${escHtml(STATUS_LABELS[t.status] || t.status || '')}</td>
    <td>${escHtml(t.technician || '—')}</td>
    <td>${t.deadline ? fmtDateTime(t.deadline) : '—'}</td>
  </tr>`).join('');
}

// ── Edit Profile (avatar / mobile / PIN; name+designation read-only) ───────
function renderProfile() {
  if (!currentProfile) { activateView('login'); return; }
  const p = currentProfile;
  document.getElementById('pf-name').textContent = p.full_name || '—';
  document.getElementById('pf-designation').textContent = p.designation || '—';
  document.getElementById('pf-email').textContent = p.email || '—';
  document.getElementById('pf-mobile').value = p.mobile || '';
  const av = document.getElementById('pf-avatar');
  if (p.avatar_url) { av.style.backgroundImage = `url("${p.avatar_url}")`; av.textContent = ''; }
  else { av.style.backgroundImage = ''; av.textContent = (p.full_name || p.email || '?').charAt(0).toUpperCase(); }
  const st = document.getElementById('pf-status'); if (st) { st.textContent = ''; st.className = 'pf-status'; }
}

function initProfileUI() {
  const mSave = document.getElementById('pf-mobile-save');
  if (mSave) mSave.addEventListener('click', async () => {
    const st = document.getElementById('pf-status');
    const mobile = (document.getElementById('pf-mobile').value || '').trim();
    try {
      const { error } = await db.from('profiles').update({ mobile, updated_at: new Date().toISOString() }).eq('id', currentProfile.id);
      if (error) throw error;
      currentProfile.mobile = mobile;
      st.textContent = 'Mobile number saved.'; st.className = 'pf-status ok';
    } catch (e) { st.textContent = 'Could not save: ' + e.message; st.className = 'pf-status err'; }
  });

  const pSave = document.getElementById('pf-pin-save');
  if (pSave) pSave.addEventListener('click', async () => {
    const st = document.getElementById('pf-status');
    const a = (document.getElementById('pf-new-pin').value || '').trim();
    const b = (document.getElementById('pf-confirm-pin').value || '').trim();
    const need = Number(currentProfile.tier) >= 4 ? 8 : 6;
    if (!/^\d+$/.test(a)) { st.textContent = 'PIN must be digits only.'; st.className = 'pf-status err'; return; }
    if (a.length !== need) { st.textContent = `Your tier needs a ${need}-digit PIN.`; st.className = 'pf-status err'; return; }
    if (a !== b) { st.textContent = 'PINs do not match.'; st.className = 'pf-status err'; return; }
    try {
      const { error } = await db.auth.updateUser({ password: a });
      if (error) throw error;
      document.getElementById('pf-new-pin').value = '';
      document.getElementById('pf-confirm-pin').value = '';
      st.textContent = 'PIN updated — use it next time you sign in.'; st.className = 'pf-status ok';
    } catch (e) { st.textContent = 'Could not update PIN: ' + e.message; st.className = 'pf-status err'; }
  });

  const avInput = document.getElementById('pf-avatar-input');
  if (avInput) avInput.addEventListener('change', async (e) => {
    const st = document.getElementById('pf-status');
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { st.textContent = 'Image too large (max 3 MB).'; st.className = 'pf-status err'; return; }
    st.textContent = 'Uploading photo…'; st.className = 'pf-status';
    try {
      const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
      const path = `${currentProfile.id}/dp.${ext}`;
      const { error: upErr } = await db.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = db.storage.from('avatars').getPublicUrl(path);
      const url = (pub && pub.publicUrl ? pub.publicUrl : '') + '?t=' + Date.now();
      const { error: updErr } = await db.from('profiles').update({ avatar_url: url, updated_at: new Date().toISOString() }).eq('id', currentProfile.id);
      if (updErr) throw updErr;
      currentProfile.avatar_url = url;
      renderProfile(); applyMenu();
      st.textContent = 'Photo updated.'; st.className = 'pf-status ok';
    } catch (err) { st.textContent = 'Upload failed: ' + err.message; st.className = 'pf-status err'; }
  });
}

async function loadAllTickets() {
  showLoading(true);
  try {
    const { data, error } = await db
      .from('tickets')
      // specs / build_checks / qc_checks are what let boardColumn() tell
      // Procurement from Assembly and QC from Stress — without them three of the
      // seven board columns are undecidable. They must also match the shape the
      // realtime handler writes (payload.new is the FULL row), or a card would
      // jump columns on its first update: an apparent transition nobody made.
      .select('id, customer_name, status, type, technician, created_at, deadline, completed_at, diagnostics, specs, build_checks, qc_checks, missing_components_toggle, handed_over_at, handed_over_by, updated_at')
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

// The staff feed and the customer's single-ticket feed are SEPARATE channels.
// They used to share realtimeChannel, so opening "Track a build" tore down the
// staff subscription and the dashboard silently stopped updating (the LIVE pill
// kept saying LIVE). Idempotent: the board and the dashboard both call this.
function subscribeSales() {
  if (staffChannel) return;
  staffChannel = db
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
      if (typeof renderBoard === 'function') renderBoard();
      // My Builds shares this feed now, so it has to redraw too or subscribing
      // for it would have been pointless.
      if (tsLoaded) { try { renderTicketStatus(); } catch (e) {} }
    })
    .subscribe(status => {
      updateLiveIndicator(status === 'SUBSCRIBED');
      const bl = document.getElementById('board-live');
      if (bl) bl.classList.toggle('offline', status !== 'SUBSCRIBED');
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
      <td class="cell-id">#${escHtml(shortId)}</td>
      <td class="cell-customer">${escHtml(t.customer_name || '—')}</td>
      <td class="cell-type">${t.type === 'build' ? 'Build' : t.type === 'repair' ? 'Repair' : escHtml(t.type || '—')}</td>
      <td><span class="status-badge ${statusClass(t.status)}">${escHtml(statusLabel)}</span></td>
      <td class="cell-tech">${escHtml(t.technician || 'Unassigned')}</td>
      <td class="cell-deadline ${deadlineCls}">${fmtDate(t.status === 'completed' ? t.completed_at : t.deadline)}</td>
      <td>${qcHtml}</td>
      <td class="cell-query">${queryBtnHtml(t, shortId)}</td>
    </tr>`;
  }).join('');
}

// Single source of truth for the QC pass/fail verdict, shared by the staff badge
// and the customer status card so the two can never disagree. Returns true (pass),
// false (fail), or null (not enough data yet). Any completed check that failed —
// an over-temp CPU/GPU or a failed RAM stress — makes the whole verdict fail.
function qcVerdict(d) {
  d = d || {};
  const hasData = d.cpuTempMax != null || d.cinebench != null || d.furmark != null || d.ramStress != null;
  if (!hasData) return null;
  return (
    (d.cpuTempMax == null || d.cpuTempMax <= 85) &&
    (d.gpuTempMax == null || d.gpuTempMax <= 80) &&
    (d.ramStress == null  || d.ramStress === 'passed' || d.ramStress === true)
  );
}

function qcBadge(t) {
  if (t.status !== 'completed') return '<span class="qc-badge na">—</span>';
  const v = qcVerdict(t.diagnostics);
  if (v === null) return '<span class="qc-badge na">Pending</span>';
  return v
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

document.addEventListener('DOMContentLoaded', async () => {
  db = initSupabase();
  if (!db) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#e91e8c;">Supabase library failed to load. Check your internet connection.</div>';
    return;
  }

  initMenu();
  initLoginForm();
  initProfileUI();
  initCustomerView();
  initQueryUI();
  document.getElementById('filter-status').addEventListener('change', renderTable);
  document.getElementById('filter-search').addEventListener('input', renderTable);

  // Restore any existing staff session (Supabase persists it across reloads).
  await loadWebProfile();
  applyMenu();

  // Routing: honour ?view= deep-links (legacy 'sales' → dashboard).
  let requested = getView();
  if (requested === 'sales') requested = 'dashboard';
  if (currentProfile) {
    // 'new-build' was missing here, so ?view=new-build silently fell through to
    // the tier default instead of deep-linking. Fixed alongside adding 'board'.
    if (['dashboard', 'profile', 'ticket-status', 'new-build', 'board'].includes(requested)) activateView(requested);
    else routeAfterWebLogin();
  } else {
    activateView((requested === 'login' || requested === 'service') ? requested : 'customer');
  }
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
  const nameEl = document.getElementById('qm-name');
  nameEl.value = localStorage.getItem('neoqc-sales-name') || '';
  nameEl.addEventListener('change', () => localStorage.setItem('neoqc-sales-name', nameEl.value.trim()));
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
          <span class="qm-who">🛍️ ${q.asked_by ? escHtml(q.asked_by) + ' (sales) asked' : 'Sales asked'}</span>
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
  const nameEl = document.getElementById('qm-name');
  const status = document.getElementById('qm-status');
  const question = msgEl.value.trim();
  const askedBy  = nameEl.value.trim();
  if (!question) { status.textContent = 'Type a question first.'; return; }
  localStorage.setItem('neoqc-sales-name', askedBy);
  status.textContent = 'Sending…';
  try {
    let { error } = await db.from('ticket_queries').insert({
      ticket_id: qmTicketId, question, status: 'open',
      ...(askedBy ? { asked_by: askedBy } : {})
    });
    // Graceful fallback: asked_by column not added to Supabase yet
    if (error && /asked_by/.test(error.message)) {
      ({ error } = await db.from('ticket_queries').insert({
        ticket_id: qmTicketId, question, status: 'open'
      }));
      if (!error) console.warn('ticket_queries.asked_by column missing — name not stored. Run: ALTER TABLE public.ticket_queries ADD COLUMN IF NOT EXISTS asked_by TEXT;');
    }
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

// ═══════════════════════════════════════════════════════════
//  QUOTE BUILDER — "New Build" (v1.9.9, Phase 1)
//  Sales executives assemble a quotation from the live price catalogue.
//  Every picked part keeps its product URL so the exec can open the real
//  product page and verify it with the customer on the spot.
//
//  Phase 2 adds the interactive price-to-performance comparison (shared/ppi.js
//  and the PassMark JSONs are already published alongside this site); Phase 3
//  turns a finished quote into a real build ticket.
// ═══════════════════════════════════════════════════════════

const QB_CATEGORIES = [
  { key: 'cpu',         label: 'Processor (CPU)', icon: '🧠' },
  { key: 'motherboard', label: 'Motherboard',     icon: '🔌' },
  { key: 'ram',         label: 'Memory (RAM)',    icon: '🧮' },
  { key: 'gpu',         label: 'Graphics Card',   icon: '🎮' },
  { key: 'storage',     label: 'Storage',         icon: '💾' },
  { key: 'psu',         label: 'Power Supply',    icon: '⚡' },
  { key: 'cooler',      label: 'Cooler',          icon: '❄' },
  { key: 'case',        label: 'Cabinet',         icon: '🗄' }
];

const QB_DRAFT_KEY = 'neoqc-quote-draft';
let qbState = { customer: {}, items: {} };
let qbLoaded = false;
let qbSearchTimers = {};

function qbMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '₹' + Math.round(Number(n)).toLocaleString('en-IN');
}

function ensureQuoteBuilderLoaded() {
  if (qbLoaded) { qbRenderAll(); return; }
  qbLoaded = true;
  qbLoadDraft();
  qbBuildRows();
  qbBindCustomerFields();
  qbInitPdfImport();
  // Click anywhere outside a picker closes the open dropdown.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.qb-pick')) qbCloseResults(null);
  });
  const clearBtn = document.getElementById('qb-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!confirm('Clear this quotation and start over?')) return;
    qbResetDraft();
    qbCreating = false;
    const cb = document.getElementById('qb-create');
    if (cb) { cb.disabled = false; cb.textContent = 'Create build ticket →'; }
    qbCreateStatus('', '');
  });
  const createBtn = document.getElementById('qb-create');
  if (createBtn) createBtn.addEventListener('click', qbCreateTicket);
  qbRenderAll();
}

// ── Draft persistence (survives a refresh; per-browser only) ──
function qbLoadDraft() {
  try {
    const raw = localStorage.getItem(QB_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') qbState = { customer: d.customer || {}, items: d.items || {} };
    }
  } catch (e) { /* a corrupt draft must never block the page */ }
}

function qbSaveDraft() {
  try { localStorage.setItem(QB_DRAFT_KEY, JSON.stringify(qbState)); } catch (e) {}
  const note = document.getElementById('qb-draft-note');
  if (note) {
    note.textContent = 'Draft saved';
    clearTimeout(qbSearchTimers.__note);
    qbSearchTimers.__note = setTimeout(() => { note.textContent = ''; }, 1600);
  }
}

function qbBindCustomerFields() {
  const map = {
    'qb-cust-name': 'name', 'qb-cust-phone': 'phone', 'qb-deadline': 'deadline',
    'qb-type': 'type', 'qb-usecase': 'useCase'
  };
  Object.keys(map).forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.qbBound) return;
    el.dataset.qbBound = '1';
    if (qbState.customer[map[id]] != null) el.value = qbState.customer[map[id]];
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { qbState.customer[map[id]] = el.value; qbSaveDraft(); if (map[id] === 'useCase') qbSchedulePpi(); });
  });
}

// ── Rows ──
function qbBuildRows() {
  const wrap = document.getElementById('qb-rows');
  if (!wrap) return;
  wrap.innerHTML = QB_CATEGORIES.map(c =>
    '<div class="qb-row" data-cat="' + c.key + '">' +
      '<div class="qb-cat"><span class="qb-cat-ic">' + c.icon + '</span><span>' + escHtml(c.label) + '</span></div>' +
      '<div class="qb-pick">' +
        '<input class="qb-search filter-input" data-cat="' + c.key + '" placeholder="Search catalogue…" autocomplete="off" spellcheck="false">' +
        '<div class="qb-results hidden" data-cat="' + c.key + '"></div>' +
        '<div class="qb-selected hidden" data-cat="' + c.key + '"></div>' +
      '</div>' +
    '</div>').join('');

  wrap.querySelectorAll('.qb-search').forEach(inp => {
    inp.addEventListener('input', () => qbOnSearch(inp.dataset.cat, inp.value));
    inp.addEventListener('focus', () => { if (inp.value.trim().length >= 2) qbOnSearch(inp.dataset.cat, inp.value); });
  });
  wrap.addEventListener('click', qbOnClick);
  wrap.addEventListener('input', (e) => {
    const pe = e.target.closest('.qb-qprice');
    if (!pe) return;
    const it = qbState.items[pe.dataset.cat];
    if (!it) return;
    const v = parseFloat(pe.value);
    it.quotedPrice = isNaN(v) ? null : v;
    qbSaveDraft();
    qbRenderSummary();
    qbSchedulePpi();
  });
}

// ── Catalogue search (debounced) ──
// Only ever one open dropdown. Without this, searching CPU then clicking into GPU
// left both result lists open, stacking over the rows beneath them.
function qbCloseResults(exceptCat) {
  document.querySelectorAll('.qb-results').forEach(b => {
    if (exceptCat && b.dataset.cat === exceptCat) return;
    b.classList.add('hidden');
    b.innerHTML = '';
  });
}

function qbOnSearch(cat, q) {
  clearTimeout(qbSearchTimers[cat]);
  const box = document.querySelector('.qb-results[data-cat="' + cat + '"]');
  if (!box) return;
  const term = (q || '').trim();
  qbCloseResults(cat);
  if (term.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  qbSearchTimers[cat] = setTimeout(() => qbRunSearch(cat, term, box), 260);
}

async function qbRunSearch(cat, term, box) {
  if (!db) { box.classList.remove('hidden'); box.innerHTML = '<div class="qb-res-empty">Not connected.</div>'; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="qb-res-empty">Searching…</div>';
  try {
    // NOTE: only columns that exist today are selected. Once an image_url column
    // is added to component_prices, add it here and the thumbnail lights up with
    // no other change (qbRenderRow already handles it.image_url).
    const { data, error } = await db
      .from('component_prices')
      .select('sku,name,price_inr,url,category')
      .eq('category', cat)
      .ilike('name', '%' + term + '%')
      .order('price_inr', { ascending: true })
      .limit(40);
    if (error) throw error;
    if (!data || !data.length) {
      box.innerHTML = '<div class="qb-res-empty">No catalogue match. ' +
        '<button type="button" class="qb-manual-btn" data-cat="' + cat + '">Enter manually</button></div>';
      return;
    }
    // Relevance ranking. The catalogue appends the part code into the name, so a
    // plain price sort surfaced accessories whose CODE happens to contain the term
    // (a Bykski water block for "ryzen", a Lian Li cable for "rtx") above the real
    // component. Prefer the term appearing early, and as a whole word, in the name.
    const tl = term.toLowerCase();
    const esc = tl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRe = new RegExp('\\b' + esc);
    const rows = (data || []).map(r => {
      const n = (r.name || '').toLowerCase();
      const idx = n.indexOf(tl);
      // Some catalogue rows are accessories filed under a component category (a
      // vertical BRACKET kit and an NVLink BRIDGE sit under 'gpu'). They match the
      // search term legitimately but are never what a sales exec is quoting, so
      // sink them below real parts instead of hiding them outright.
      if (/\b(bracket|cable|extension|bridge|riser|adapter|adaptor|waterblock|water block|mount|stand|screw|paste|sleeve|splitter|converter|holder|clip)\b/.test(n)) {
        return { r: r, score: 0, price: r.price_inr == null ? Infinity : Number(r.price_inr) };
      }
      let score = 1;
      if (idx === 0) score = 4;
      else if (idx > -1 && idx <= 24) score = 3;
      else if (wordRe.test(n)) score = 2;
      return { r: r, score: score, price: r.price_inr == null ? Infinity : Number(r.price_inr) };
    }).sort((a, b) => (b.score - a.score) || (a.price - b.price)).slice(0, 20).map(x => x.r);

    box.innerHTML = rows.map(r =>
      '<button type="button" class="qb-res" data-cat="' + cat + '"' +
        ' data-sku="' + escHtml(r.sku) + '"' +
        ' data-name="' + escHtml(r.name) + '"' +
        ' data-price="' + (r.price_inr == null ? '' : r.price_inr) + '"' +
        ' data-url="' + escHtml(r.url || '') + '">' +
        '<span class="qb-res-name">' + escHtml(r.name) + '</span>' +
        '<span class="qb-res-price mono">' + qbMoney(r.price_inr) + '</span>' +
      '</button>').join('') +
      '<div class="qb-res-foot"><button type="button" class="qb-manual-btn" data-cat="' + cat + '">Not listed — enter manually</button></div>';
  } catch (e) {
    box.innerHTML = '<div class="qb-res-empty">Search failed: ' + escHtml(e.message || 'unknown error') + '</div>';
  }
}

function qbOnClick(e) {
  const pick = e.target.closest('.qb-res');
  if (pick) {
    const cat = pick.dataset.cat;
    const price = pick.dataset.price === '' ? null : parseFloat(pick.dataset.price);
    qbState.items[cat] = {
      sku: pick.dataset.sku,
      name: pick.dataset.name,
      url: pick.dataset.url || '',
      catalogPrice: price,
      quotedPrice: price,
      manual: false
    };
    qbAfterPick(cat);
    return;
  }
  const manual = e.target.closest('.qb-manual-btn');
  if (manual) {
    const cat = manual.dataset.cat;
    const inp = document.querySelector('.qb-search[data-cat="' + cat + '"]');
    const name = (inp && inp.value.trim()) || '';
    if (!name) return;
    qbState.items[cat] = { sku: null, name: name, url: '', catalogPrice: null, quotedPrice: null, manual: true };
    qbAfterPick(cat);
    return;
  }
  const rm = e.target.closest('.qb-remove');
  if (rm) {
    delete qbState.items[rm.dataset.cat];
    qbSaveDraft();
    qbRenderRow(rm.dataset.cat);
    qbRenderSummary();
  }
}

function qbAfterPick(cat) {
  const box = document.querySelector('.qb-results[data-cat="' + cat + '"]');
  const inp = document.querySelector('.qb-search[data-cat="' + cat + '"]');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  if (inp) inp.value = '';
  qbSaveDraft();
  qbRenderRow(cat);
  qbRenderSummary();
  qbSchedulePpi();
}

function qbRenderRow(cat) {
  const sel = document.querySelector('.qb-selected[data-cat="' + cat + '"]');
  const inp = document.querySelector('.qb-search[data-cat="' + cat + '"]');
  if (!sel) return;
  const it = qbState.items[cat];
  if (!it) {
    sel.classList.add('hidden');
    sel.innerHTML = '';
    if (inp) inp.classList.remove('hidden');
    return;
  }
  if (inp) inp.classList.add('hidden');
  sel.classList.remove('hidden');
  // it.image_url stays undefined until an image column exists, so the thumbnail
  // falls back to the category glyph — adding photos later needs no UI change.
  const cfg = QB_CATEGORIES.find(c => c.key === cat) || { icon: '📦' };
  const thumb = it.image_url
    ? '<img class="qb-thumb-img" src="' + escHtml(it.image_url) + '" alt="">'
    : '<span class="qb-thumb-ph">' + cfg.icon + '</span>';
  // escHtml() neutralises quotes but NOT a javascript: scheme, and this URL comes
  // from a catalogue row anyone with a staff login can edit. Whitelist the scheme.
  const safeUrl = /^https?:\/\//i.test(it.url || '') ? it.url : '';
  const link = safeUrl
    ? '<a class="qb-link" href="' + escHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer">View product ↗</a>'
    : '<span class="qb-link qb-link-none">' + (it.manual ? 'Manual entry' : 'No product link') + '</span>';
  sel.innerHTML =
    '<div class="qb-sel-card">' +
      '<div class="qb-thumb">' + thumb + '</div>' +
      '<div class="qb-sel-main">' +
        '<div class="qb-sel-name" title="' + escHtml(it.name) + '">' + escHtml(it.name) + '</div>' +
        '<div class="qb-sel-meta">' + link +
          (it.catalogPrice != null ? '<span class="qb-cat-price">Catalogue ' + qbMoney(it.catalogPrice) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="qb-sel-price">' +
        '<label class="qb-qprice-label">Quoted</label>' +
        '<input type="number" class="qb-qprice" data-cat="' + cat + '" value="' +
          (it.quotedPrice == null ? '' : it.quotedPrice) + '" placeholder="0" min="0" step="1">' +
      '</div>' +
      '<button type="button" class="qb-remove" data-cat="' + cat + '" title="Remove">✕</button>' +
    '</div>';
}

function qbRenderSummary() {
  const linesEl = document.getElementById('qb-lines');
  const countEl = document.getElementById('qb-count');
  const subEl = document.getElementById('qb-subtotal');
  if (!linesEl) return;
  const chosen = QB_CATEGORIES.filter(c => qbState.items[c.key]);
  if (!chosen.length) {
    linesEl.innerHTML = '<div class="qb-lines-empty">No components picked yet.</div>';
  } else {
    linesEl.innerHTML = chosen.map(c => {
      const it = qbState.items[c.key];
      return '<div class="qb-line">' +
        '<span class="qb-line-cat">' + c.icon + ' ' + escHtml(c.label) + '</span>' +
        '<span class="qb-line-name" title="' + escHtml(it.name) + '">' + escHtml(it.name) + '</span>' +
        '<span class="qb-line-price mono">' + qbMoney(it.quotedPrice) + '</span>' +
      '</div>';
    }).join('');
  }
  const total = chosen.reduce((s, c) => {
    const v = qbState.items[c.key].quotedPrice;
    return s + (v == null || isNaN(v) ? 0 : Number(v));
  }, 0);
  if (countEl) countEl.textContent = String(chosen.length);
  if (subEl) subEl.textContent = qbMoney(total);
}

function qbRenderAll() {
  QB_CATEGORIES.forEach(c => qbRenderRow(c.key));
  qbRenderSummary();
  qbSchedulePpi();
}

// ═══════════════════════════════════════════════════════════
//  INVOICE PDF IMPORT (website) — same parser as the desktop app
//  The categoriser is shared/invoice-import.js, the very module the Electron
//  app uses, so the v1.9.8 fixes (chipset = strong motherboard signal, DDR5 no
//  longer a decisive RAM signal, accessory de-prioritisation) apply here too.
//  Text extraction mirrors main.js's invoice:parse-pdf exactly: group text
//  items into rows by Y (2px tolerance), order left-to-right by X, so a tabular
//  "Description … Rate … Total" row survives as ONE line — which is what the
//  parser depends on.
// ═══════════════════════════════════════════════════════════

const QB_PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

async function qbExtractPdfText(file) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('PDF engine failed to load (check your connection).');
  try { lib.GlobalWorkerOptions.workerSrc = QB_PDFJS_WORKER; } catch (e) {}
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data: buf, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = [];
    content.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const y = Math.round(it.transform[5]);
      const x = it.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) <= 2);
      if (!row) { row = { y: y, items: [] }; rows.push(row); }
      row.items.push({ x: x, str: it.str });
    });
    rows.sort((a, b) => b.y - a.y);            // PDF origin is bottom-left
    pages.push(rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      return r.items.map(i => i.str).join(' ').replace(/\s{2,}/g, ' ').trim();
    }).join('\n'));
  }
  return pages.join('\n');
}

// Invoice is the source of truth for the part NAME and PRICE. The catalogue is
// consulted only to attach a product URL (and its list price for comparison), so
// the exec can open the real product page and verify it with the customer.
async function qbResolveFromCatalogue(cat, name) {
  if (!db || !name) return null;
  const words = String(name).replace(/[^\w\s.-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const tries = [words.slice(0, 3).join(' '), words.slice(0, 2).join(' '), words[0] || ''];

  // Collect candidates across the attempts, then pick the BEST by name similarity.
  // Taking the first row back matched a different KIOXIA drive (Rs 25,847 against a
  // Rs 15,294 invoice line) and a different B850 board — which would hand the
  // customer a link to the WRONG product. Below the confidence floor we attach no
  // link at all: no link is far better than a confidently wrong one.
  const seen = new Set();
  const candidates = [];
  for (const t of tries) {
    if (!t) continue;
    try {
      const { data, error } = await db
        .from('component_prices')
        .select('sku,name,price_inr,url')
        .eq('category', cat)
        .ilike('name', '%' + t + '%')
        .limit(10);
      if (error || !data) continue;
      data.forEach(r => { if (r && r.sku && !seen.has(r.sku)) { seen.add(r.sku); candidates.push(r); } });
      if (candidates.length >= 10) break;
    } catch (e) { /* try the next, shorter term */ }
  }
  if (!candidates.length) return null;

  const M = window.NeoQcMatcher;
  if (!M || !M.tokenize || !M.score) return null;   // no scorer → no guessing
  const q = M.tokenize(M.cleanName ? M.cleanName(name) : name);
  let best = null, bestScore = 0;
  candidates.forEach(r => {
    const s = M.score(q, new Set(M.tokenize(M.cleanName ? M.cleanName(r.name) : r.name)));
    if (s > bestScore) { bestScore = s; best = r; }
  });
  return bestScore >= 0.45 ? best : null;
}

function qbImportStatus(html, kind) {
  const el = document.getElementById('qb-import-status');
  if (!el) return;
  el.className = 'qb-import-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

async function qbImportPdf(file) {
  const btn = document.getElementById('qb-pdf-btn');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    qbImportStatus('Reading the invoice…', '');
    const text = await qbExtractPdfText(file);
    if (!text || text.replace(/[^A-Za-z0-9]/g, '').length < 40) {
      qbImportStatus('No readable text in this PDF. It is probably a scan or image — enter the parts by hand.', 'warn');
      return;
    }
    const II = window.NeoQcInvoiceImport;
    if (!II) throw new Error('Invoice parser not loaded.');
    const build = II.buildFromInvoice(text, null, {});
    const cats = Object.keys(build.results || {});
    if (!cats.length) {
      qbImportStatus('No recognisable PC components were found in this invoice. You can still enter them by hand.', 'warn');
      return;
    }

    qbImportStatus('Matching ' + cats.length + ' component(s) to the catalogue…', '');
    let filled = 0;
    for (const cat of cats) {
      if (!QB_CATEGORIES.some(c => c.key === cat)) continue;
      const r = build.results[cat];
      const invName = r.displayName || r.matchedName || r.rawLine;
      const invPrice = r.priceInr != null ? r.priceInr : null;
      const hit = await qbResolveFromCatalogue(cat, invName);
      qbState.items[cat] = {
        sku: hit ? hit.sku : null,
        name: invName,                                   // invoice wins on naming
        url: hit ? (hit.url || '') : '',                 // catalogue supplies the link
        catalogPrice: hit && hit.price_inr != null ? Number(hit.price_inr) : null,
        quotedPrice: invPrice,                           // invoice wins on price
        manual: false,
        fromInvoice: true,
        needsReview: r.status !== 'matched'
      };
      filled++;
    }
    qbSaveDraft();
    qbRenderAll();

    // Safety net — mirror of the app's: show every priced invoice line that was
    // NOT mapped to a build component, so a real part can never be silently lost.
    let extra = '';
    try {
      const mapped = new Set(cats.map(c => build.results[c] && build.results[c].rawLine).filter(Boolean));
      const noise = /(sub\s*total|grand\s*total|\btotal\b|\bgst\b|\bcgst\b|\bsgst\b|\btax\b|bill\s*to|ship\s*to|\bbank\b|transfer|\bmobile\b|place\s*of\s*supply|proforma|\binvoice\b)/i;
      const unmatched = (build.candidateLines || []).filter(row =>
        row && row.text && (row.rate != null || row.total != null) &&
        !mapped.has(row.text) && !noise.test(row.text) && /[a-z]{3,}/i.test(row.text));
      if (unmatched.length) {
        extra = '<div class="qb-unmatched"><strong>' + unmatched.length +
          ' invoice line(s) not added as a build part — check nothing was missed:</strong>' +
          unmatched.map(row => '<div>• ' + escHtml(row.text.slice(0, 78)) +
            (row.rate != null ? ' — ' + qbMoney(row.rate) : '') + '</div>').join('') +
          '<div class="qb-unmatched-note">Monitors, keyboards and labour belong here. If a core component is listed, add it by hand above.</div></div>';
      }
    } catch (e) { /* the safety net must never break the import */ }

    const review = QB_CATEGORIES.filter(c => qbState.items[c.key] && qbState.items[c.key].needsReview).length;
    qbImportStatus(
      '<strong>Imported ' + filled + ' component(s) from the invoice.</strong>' +
      (review ? ' <span class="qb-review-flag">' + review + ' need a quick check (unusual wording).</span>' : '') +
      '<div class="qb-unmatched-note">Names and prices come from the invoice; product links are matched from the catalogue.</div>' +
      extra, review ? 'warn' : 'ok');
  } catch (e) {
    qbImportStatus('Import failed: ' + escHtml(e.message || 'unknown error'), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

function qbInitPdfImport() {
  const btn = document.getElementById('qb-pdf-btn');
  const input = document.getElementById('qb-pdf-input');
  if (!btn || !input || btn.dataset.qbBound) return;
  btn.dataset.qbBound = '1';
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';                       // allow re-picking the same file
    if (f) qbImportPdf(f);
  });
}

// ═══════════════════════════════════════════════════════════
//  LIVE PRICE-TO-PERFORMANCE (Phase 2)
//  Runs the SAME engine the technician app uses — shared/ppi.js driven by
//  shared/ppi-sync.js — entirely in the browser, so a sales exec sees the score
//  while building the quote instead of waiting for the workstation to compute it.
//  The result is drawn with the same shared renderPpiPanel() the customer page
//  already uses, so staff and customer see identical figures.
// ═══════════════════════════════════════════════════════════

let qbCatalogMatcher = null;
let qbCatalogLoading = null;
let qbPpiTimer = null;
let qbPpiSeq = 0;

// The engine scores each part against SAME-PRICE-BAND PEERS, so it needs the
// catalogue pool — not just the chosen parts. Loaded once per session and cached.
async function qbEnsureCatalogue() {
  if (qbCatalogMatcher) return qbCatalogMatcher;
  if (qbCatalogLoading) return qbCatalogLoading;
  if (!db) throw new Error('not connected');
  if (!window.NeoQcMatcher || !window.NeoQcMatcher.Matcher) throw new Error('matcher not loaded');

  qbCatalogLoading = (async () => {
    const cats = QB_CATEGORIES.map(c => c.key);
    const PAGE = 1000;

    // Supabase caps a response at 1000 rows and each round trip costs ~1.6s, so
    // fetching ~6 pages one after another left the exec staring at "Scoring…" for
    // ten seconds. Ask for the row count first, then pull every page in parallel.
    const head = await db
      .from('component_prices')
      .select('sku', { count: 'exact', head: true })
      .in('category', cats);
    if (head.error) throw head.error;
    const total = head.count || 0;
    const pages = Math.max(1, Math.ceil(total / PAGE));

    const results = await Promise.all(
      Array.from({ length: pages }, (_, i) =>
        db.from('component_prices')
          .select('sku,name,category,price_inr')
          .in('category', cats)
          .range(i * PAGE, i * PAGE + PAGE - 1)
      )
    );
    const rows = [];
    results.forEach(r => { if (!r.error && r.data) rows.push.apply(rows, r.data); });

    qbCatalogMatcher = new window.NeoQcMatcher.Matcher(rows);
    qbCatalogMatcher.__rowCount = rows.length;
    return qbCatalogMatcher;
  })();

  try {
    return await qbCatalogLoading;
  } catch (e) {
    qbCatalogLoading = null;   // allow a retry on the next change
    throw e;
  }
}

function qbPpiMessage(html) {
  const panel = document.getElementById('qb-ppi');
  if (panel) panel.innerHTML = '<div class="qb-ppi-empty">' + html + '</div>';
}

async function qbComputePpi() {
  const panel = document.getElementById('qb-ppi');
  if (!panel) return;
  const chosen = QB_CATEGORIES.filter(c => qbState.items[c.key]);
  if (chosen.length < 2) {
    qbPpiMessage('Pick at least two components to score this build.');
    return;
  }
  if (!window.NeoQcPpiSync || !window.NeoQcPpiSync.computePpi) {
    qbPpiMessage('Scoring engine not loaded.');
    return;
  }

  const seq = ++qbPpiSeq;                  // ignore results from superseded runs
  qbPpiMessage('Scoring this build…');
  try {
    const matcher = await qbEnsureCatalogue();
    if (seq !== qbPpiSeq) return;

    const ticketSpecs = {}, ticketPrices = {};
    chosen.forEach(c => {
      const it = qbState.items[c.key];
      ticketSpecs[c.key] = it.name;
      if (it.quotedPrice != null && !isNaN(it.quotedPrice)) ticketPrices[c.key] = Number(it.quotedPrice);
    });

    const res = await window.NeoQcPpiSync.computePpi({
      ticketSpecs: ticketSpecs,
      catalogMatcher: matcher,
      useCase: qbState.customer.useCase || 'gaming-1440p',
      ticketPrices: ticketPrices,
      priceBandPct: 0.15
      // fetchUrl / supabaseClient intentionally omitted: the live retailer
      // lookup is an app-side concern; here we score on what we already know.
    });
    if (seq !== qbPpiSeq) return;
    if (!res || !res.success) throw new Error((res && res.error) || 'could not score this build');

    const R = window.NeoQcDiagnosticsRender;
    panel.innerHTML = (R && R.renderPpiPanel)
      ? R.renderPpiPanel(res.payload)
      : '<div class="qb-ppi-empty">Score: ' + (res.payload.index != null ? Math.round(res.payload.index) : '—') + '</div>';
  } catch (e) {
    if (seq !== qbPpiSeq) return;
    qbPpiMessage('Could not score this build: ' + escHtml(e.message || 'unknown error'));
  }
}

// Debounced so typing a price does not fire a scoring run per keystroke.
function qbSchedulePpi() {
  clearTimeout(qbPpiTimer);
  qbPpiTimer = setTimeout(qbComputePpi, 600);
}

// ═══════════════════════════════════════════════════════════
//  PIPELINE BOARD (Phase 3) — Quote → Procurement → Assembly → QC →
//  Stress → Ready → Handed over.
//
//  The DB has FIVE status values and the board shows SEVEN columns, so a
//  column is DERIVED from state the shop floor already maintains — never
//  stored. That is not a shortcut, it is the only safe option: the app
//  recomputes `status` from the build/QC checkboxes on every technician save
//  (app.js:3998) AND re-derives it on every dashboard render with no
//  technician action at all (app.js:2531), so any stage value the website
//  wrote into `status` would be silently reverted, usually within seconds.
//
//  The ONE thing the board owns is the sales handover, and it lives in two
//  dedicated columns (handed_over_at / handed_over_by) that the app's upsert
//  never names — so no app version, installed or future, can clobber it.
// ═══════════════════════════════════════════════════════════

let boardLoaded = false;
let boardShowUnowned = false;      // "show the unowned builds too" escape hatch
let salesNameByEmail = {};         // email → full_name, so cards show people not addresses

const BOARD_COLS = [
  { key: 'quote',       label: 'Quote' },
  { key: 'procurement', label: 'Procurement' },
  { key: 'assembly',    label: 'Assembly' },
  { key: 'qc',          label: 'QC' },
  { key: 'stress',      label: 'Stress' },
  { key: 'ready',       label: 'Ready' },
  { key: 'handed',      label: 'Handed over' },
];

const BUILD_KEYS = ['cpuRamSsd', 'moboCase', 'cooler', 'cables', 'posted'];
const QC_KEYS = ['physCabinet', 'physMobo', 'physRam', 'physScrews',
  'softWindows', 'softDrivers', 'softBios',
  'portUsb', 'portVideo', 'portAudio', 'portWifi'];

// Pure. No writes, no side effects. First match wins, most-advanced signal first.
function boardColumn(t) {
  const specs = t.specs || {};
  const diag = t.diagnostics || {};
  const proc = specs.__procurement || {};
  const ver = specs.__verify || {};
  const b = t.build_checks || {};
  const q = t.qc_checks || {};

  const buildAny = BUILD_KEYS.some(k => !!b[k]);
  const buildAll = BUILD_KEYS.every(k => !!b[k]);
  const qcAny = QC_KEYS.some(k => !!q[k]);
  const qcAll = QC_KEYS.every(k => !!q[k]);

  // `in`, not truthiness: a legacy ticket that predates stress tracking has no
  // stress keys at all and must not be stranded in Stress forever.
  const stressKnown = ('__stressSignedOff' in diag) || ('__stressTotalSec' in diag) || ('__stressRuns' in diag);
  const stressDone = !!diag.__stressSignedOff;
  const stressStarted = Number(diag.__stressTotalSec || 0) > 0 || Number(diag.__stressRuns || 0) > 0;

  const procAny = !!(proc.received || proc.undamaged || proc.matches ||
    Object.keys(proc.components || {}).length);

  // 1. The sales close — the only signal that outranks the technician's own state.
  if (t.handed_over_at) return 'handed';

  // 2. Stress BEFORE Ready, deliberately. The admin form marks a ticket
  //    'completed' on the QC boxes alone (app.js:4009) without requiring stress
  //    sign-off, so 'completed' can hide pending torture-testing. "Ready" on this
  //    board has to mean safe to call the customer.
  if (buildAll && qcAll && stressKnown && !stressDone) return 'stress';
  if (buildAll && stressStarted && !stressDone) return 'stress';

  // 3. Technically finished, physically still in the shop.
  if (t.status === 'completed' || t.completed_at) return 'ready';

  // 4. QC proper.
  if (buildAll || t.status === 'waiting_qc' || t.status === 'qc_testing' || qcAny) return 'qc';

  // 5. Assembly has actually begun — a box ticked or the build timer started.
  if (buildAny || t.status === 'building' || ver.buildStartedAt) return 'assembly';

  // 6. The floor has accepted it: parts being checked in, or a technician
  //    assigned. The app assigns one by workload on create (app.js:3930); a
  //    website quote has none. missing_components_toggle is deliberately NOT a
  //    signal — the create payload sets it true, and using it here would empty
  //    the Quote column entirely.
  if (procAny || (t.technician && String(t.technician).trim())) return 'procurement';

  // 7. Still a quote on the sales desk.
  return 'quote';
}

// Ownership. specs.__build.salesExec is an EMAIL (the app's dropdown option value
// is p.email, app.js:167), it survives every technician save via the explicit
// fallback at app.js:4113, and it is already how ticket_flags routes notifications.
// Deliberately NOT technicianMatchesProfile(): that is fuzzy name-token matching
// whose own comment disowns it, and the two surfaces implement it with opposite
// quantifiers (.every here, .some in the app), so the same person gets different
// answers on the two screens.
function ownedBySalesExec(t, profile) {
  const e = ((t.specs && t.specs.__build && t.specs.__build.salesExec) || '').trim().toLowerCase();
  return !!e && !!profile && e === String(profile.email || '').trim().toLowerCase();
}

function salesOwnerEmail(t) {
  return ((t.specs && t.specs.__build && t.specs.__build.salesExec) || '').trim();
}

function salesOwnerName(email) {
  if (!email) return '';
  return salesNameByEmail[email.toLowerCase()] || email;
}

// Every authenticated user can already read every profiles row, so one fetch
// turns every email on the board into a human name.
async function loadSalesNames() {
  try {
    const { data, error } = await db.from('profiles').select('email, full_name');
    if (error || !data) return;
    const map = {};
    data.forEach(p => { if (p.email) map[String(p.email).toLowerCase()] = p.full_name || p.email; });
    salesNameByEmail = map;
  } catch (e) { /* names are a nicety; the board works with raw emails */ }
}

async function ensureBoardLoaded() {
  if (!currentProfile) { activateView('login'); return; }
  if (!boardLoaded) {
    boardLoaded = true;
    // A lead's own closed-sales list is usually empty, so only sales (T1)
    // defaults to their own builds.
    const mine = document.getElementById('board-mine');
    if (mine) mine.checked = Number(currentProfile.tier) === 1;
    if (!allTickets.length) await loadAllTickets();
    await loadSalesNames();
    subscribeSales();          // idempotent — safe to call from every view
    initBoardUI();
  }
  renderBoard();
}

function initBoardUI() {
  const mine = document.getElementById('board-mine');
  if (mine && !mine.dataset.bound) {
    mine.dataset.bound = '1';
    mine.addEventListener('change', () => { boardShowUnowned = false; renderBoard(); });
  }
  const search = document.getElementById('board-search');
  if (search && !search.dataset.bound) {
    search.dataset.bound = '1';
    search.addEventListener('input', renderBoard);
  }
  // Delegated: initQueryUI binds only to #sales-body, so board cards would
  // otherwise get no clicks at all.
  const cols = document.getElementById('board-cols');
  if (cols && !cols.dataset.bound) {
    cols.dataset.bound = '1';
    cols.addEventListener('click', onBoardClick);
  }
}

function renderBoard() {
  const host = document.getElementById('board-cols');
  if (!host || !boardLoaded) return;

  const mineOnly = !!(document.getElementById('board-mine') || {}).checked;
  const qEl = document.getElementById('board-search');
  const query = ((qEl && qEl.value) || '').toLowerCase().trim();

  let rows = allTickets.slice();
  if (query) {
    rows = rows.filter(t =>
      (t.customer_name || '').toLowerCase().includes(query) ||
      (t.technician || '').toLowerCase().includes(query) ||
      String(t.id || '').toLowerCase().includes(query) ||
      String(t.id || '').slice(-6).toLowerCase().includes(query.replace(/^#/, '')));
  }

  // Owner filter. Tickets with NO sales owner are never silently dropped —
  // every ticket predating the v2.0.0 owner dropdown has salesExec '' and would
  // otherwise become invisible work — so they are counted and offered instead.
  let unownedHidden = 0;
  if (mineOnly) {
    rows = rows.filter(t => {
      if (ownedBySalesExec(t, currentProfile)) return true;
      if (!salesOwnerEmail(t)) { unownedHidden++; return boardShowUnowned; }
      return false;
    });
  }

  const buckets = {};
  BOARD_COLS.forEach(c => { buckets[c.key] = []; });
  rows.forEach(t => {
    const col = boardColumn(t);
    (buckets[col] || buckets.quote).push(t);
  });

  const banner = (mineOnly && unownedHidden && !boardShowUnowned)
    ? '<div class="board-empty" style="flex:0 0 100%;margin-bottom:10px;">' +
        (unownedHidden === 1 ? '1 build has' : unownedHidden + ' builds have') +
        ' no sales owner recorded. ' +
        '<button type="button" class="bc-btn" data-act="show-unowned">Show them</button></div>'
    : '';

  host.innerHTML = banner + BOARD_COLS.map(c => {
    const list = buckets[c.key];
    return '<div class="board-col col-' + c.key + '">' +
      '<div class="board-col-head">' +
        '<span class="board-col-name">' + escHtml(c.label) + '</span>' +
        '<span class="board-col-count">' + list.length + '</span>' +
      '</div>' +
      '<div class="board-cards">' +
        (list.length ? list.map(t => boardCard(t, c.key)).join('') : '<div class="board-empty">Nothing here</div>') +
      '</div>' +
    '</div>';
  }).join('');
}

function boardCard(t, col) {
  const shortId = String(t.id || '').slice(-6).toUpperCase();

  // Risk is suppressed ONLY once handed over. Unlike the staff table, a
  // Ready-but-overdue machine is NOT suppressed — a machine sitting built and
  // late is exactly what a sales board exists to surface.
  const risk = t.handed_over_at ? '' : (isPast(t.deadline) ? 'past' : isUrgent(t.deadline) ? 'urgent' : '');

  const ownerEmail = salesOwnerEmail(t);
  const owner = ownerEmail
    ? escHtml(salesOwnerName(ownerEmail))
    : '<span class="bc-k">Unassigned</span>';

  let actions = '';
  if (col === 'ready' && Number(currentProfile && currentProfile.tier) !== 2) {
    actions = '<div class="bc-actions"><button type="button" class="bc-btn bc-handover" ' +
      'data-act="handover" data-id="' + escHtml(t.id) + '">Handed over →</button></div>';
  } else if (col === 'handed') {
    actions = '<div class="bc-actions"><button type="button" class="bc-btn" ' +
      'data-act="undo-handover" data-id="' + escHtml(t.id) + '">Undo</button></div>';
  }

  const dateLine = col === 'handed'
    ? '<div class="bc-deadline">Handed over ' + escHtml(fmtDate(t.handed_over_at)) +
      (t.handed_over_by ? ' · ' + escHtml(salesOwnerName(t.handed_over_by)) : '') + '</div>'
    : (t.deadline
      ? '<div class="bc-deadline ' + risk + '">Due ' + escHtml(fmtDate(t.deadline)) +
        (risk === 'past' ? ' · overdue' : risk === 'urgent' ? ' · within 48h' : '') + '</div>'
      : '');

  // Class names come from the fixed 7-member BOARD_COLS set and the 3-member
  // risk set, never from a DB string. Every interpolated value is escaped and
  // every attribute is double-quoted (escHtml does not escape the single quote).
  return '<div class="board-card ' + (risk ? 'risk-' + risk : '') + (col === 'handed' ? ' is-handed' : '') + '">' +
    '<div class="bc-top">' +
      '<span class="bc-cust">' + escHtml(t.customer_name || '—') + '</span>' +
      '<span class="bc-code">#' + escHtml(shortId) + '</span>' +
    '</div>' +
    '<div class="bc-line"><span class="bc-k">Tech</span> ' + escHtml(t.technician || 'Unassigned') + '</div>' +
    '<div class="bc-line"><span class="bc-k">Sales</span> ' + owner + '</div>' +
    dateLine +
    actions +
  '</div>';
}

async function onBoardClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');

  if (act === 'show-unowned') { boardShowUnowned = true; renderBoard(); return; }

  const id = btn.getAttribute('data-id');
  if (!id) return;

  if (act === 'handover') {
    const t = allTickets.find(x => x.id === id);
    const who = t ? (t.customer_name || id) : id;
    if (!confirm('Mark this build as handed over to ' + who + '?\n\nThis records that the machine has physically left with the customer.')) return;
    await setHandover(btn, id, true);
  } else if (act === 'undo-handover') {
    if (!confirm('Undo the handover? The build goes back to Ready.')) return;
    await setHandover(btn, id, false);
  }
}

// The website's ONLY update to an existing ticket. Exactly three columns:
// two the Electron app's upsert never names (so it cannot clobber them, in any
// version, installed or future) and updated_at, which is only a merge gate.
// NOTHING else may ever be added to this object — no status, no specs, no
// completed_at — or the website starts racing the technician's local copy.
async function setHandover(btn, id, on) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = on ? 'Saving…' : 'Undoing…';
  try {
    const nowIso = new Date().toISOString();
    const patch = on
      ? { handed_over_at: nowIso, handed_over_by: currentProfile.email, updated_at: nowIso }
      : { handed_over_at: null, handed_over_by: null, updated_at: nowIso };
    const { error } = await db.from('tickets').update(patch).eq('id', id);
    if (error) throw error;
    // Apply locally too: realtime will also deliver this, but the card should
    // move the instant the exec clicks, not a round-trip later.
    const idx = allTickets.findIndex(x => x.id === id);
    if (idx !== -1) allTickets[idx] = Object.assign({}, allTickets[idx], patch);
    renderBoard();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = old;
    alert('Could not save that: ' + (err.message || 'unknown error'));
  }
}

// ═══════════════════════════════════════════════════════════
//  CREATE A BUILD TICKET FROM THE QUOTE (Phase 3)
//  The website's only INSERT. A brand-new client-minted id means there is no
//  existing row and therefore no conflict with anything a technician is doing.
//  specs is written HERE and never again: every one of the app's ~10 sync paths
//  uploads the WHOLE specs object from that machine's local copy, so last write
//  wins at object granularity, not key granularity. A later website write into
//  specs would race a stale technician copy — which is exactly why the handover
//  uses dedicated columns instead.
// ═══════════════════════════════════════════════════════════

let qbCreating = false;

function qbCreateStatus(msg, kind) {
  const el = document.getElementById('qb-create-status');
  if (!el) return;
  el.className = 'qb-note' + (kind ? ' ' + kind : '');
  el.innerHTML = msg;
}

// Lifted out of the #qb-clear handler so the two reset paths cannot drift.
function qbResetDraft() {
  qbState = { customer: {}, items: {} };
  try { localStorage.removeItem(QB_DRAFT_KEY); } catch (e) {}
  ['qb-cust-name', 'qb-cust-phone', 'qb-deadline'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  qbRenderAll();
}

// The app treats a naive datetime-local value as ALREADY UTC (app.js:3925).
// Matching that exactly matters: parsing it as local time instead would offset
// every website-created deadline from every app-created one by the IST offset.
function qbDeadlineToIso(v) {
  if (!v) return null;
  let s = String(v);
  if (s.length === 16) s += ':00.000Z';
  else if (s.length === 19) s += '.000Z';
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  const fallback = new Date(v);
  return isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

async function qbCreateTicket() {
  if (qbCreating) return;
  const btn = document.getElementById('qb-create');

  // Read the DOM, NOT qbState.customer: both selects ship pre-selected in the
  // markup, so an exec who accepts the visible defaults fires no change event
  // and leaves qbState.customer.type / .useCase undefined.
  const name = (document.getElementById('qb-cust-name').value || '').trim();
  const phone = (document.getElementById('qb-cust-phone').value || '').trim();
  const type = document.getElementById('qb-type').value;
  const deadlineRaw = document.getElementById('qb-deadline').value;
  const picked = QB_CATEGORIES.filter(c => qbState.items[c.key]);

  if (!name) return qbCreateStatus('Enter the customer’s name first.', 'err');
  if (!picked.length) return qbCreateStatus('Add at least one component to the quotation.', 'err');
  if (!deadlineRaw) return qbCreateStatus('Set a target deadline so the floor can schedule it.', 'err');
  const deadline = qbDeadlineToIso(deadlineRaw);
  if (!deadline) return qbCreateStatus('That deadline isn’t a valid date.', 'err');
  // The app's ticket-type select has only a "build" option (index.html:887), so
  // assigning 'repair' leaves it at value '' and the technician's first save
  // silently blanks the type. Build tickets only until that select gains the option.
  if (type === 'repair') {
    return qbCreateStatus('Service / repair jobs still have to be raised in the workshop app — the website can only open new builds for now.', 'err');
  }

  qbCreating = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  qbCreateStatus('Creating the ticket…', '');

  try {
    const nameOf = (k) => (qbState.items[k] && qbState.items[k].name) || '';
    const priceOf = (k) => {
      const it = qbState.items[k];
      const p = it && it.quotedPrice != null ? Number(it.quotedPrice) : null;
      return (p != null && !isNaN(p)) ? p : null;
    };

    // __prices keeps the QUOTE-BUILDER key names verbatim (motherboard, cooler),
    // because that is exactly the app's fieldToCat map (app.js:4084) which feeds
    // the printed report's Build Cost Breakdown. The spec STRINGS use the app's
    // other vocabulary (mobo, coolerModel). Getting these two backwards shows the
    // technician blanks, so they are deliberately built separately.
    const prices = {};
    QB_CATEGORIES.forEach(c => { const p = priceOf(c.key); if (p != null) prices[c.key] = p; });

    const coolerName = nameOf('cooler');
    const coolerType = coolerName
      ? (/aio|liquid|240|280|360/i.test(coolerName) ? 'aio' : 'air')
      : 'stock';

    const id = 't_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const nowIso = new Date().toISOString();

    const row = {
      id: id,
      created_at: nowIso,
      updated_at: nowIso,
      type: 'build',
      customer_name: name,
      deadline: deadline,
      technician: null,               // the floor assigns; null keeps it in Quote
      // 'awaiting' + toggle true is the ONE combination the app recomputes to
      // itself (app.js:4020), so the technician's first save produces no
      // spurious "Status changed" line in the ticket's event log.
      status: 'awaiting',
      missing_components_toggle: true,
      missing_components: '',
      // These four MUST be objects, never null. openTicketModal dereferences all
      // four with no null guard and no try/catch in the call path (app.js:3126,
      // 3137, 3154, 3173), so a null column means the technician clicks the card
      // and nothing happens at all — no toast, no error, a permanently dead card.
      build_checks: { cpuRamSsd: false, moboCase: false, cooler: false, cables: false, posted: false },
      qc_checks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false
      },
      diagnostics: {},
      serials: { motherboard: '', ram: '', gpu: '', ssd: '', cabinet: '' },
      specs: {
        mobo: nameOf('motherboard'),
        cpu: nameOf('cpu'),
        gpu: nameOf('gpu'),
        ram: nameOf('ram'),
        storage: nameOf('storage'),
        psu: nameOf('psu'),
        case: nameOf('case'),
        coolerType: coolerType,
        coolerModel: coolerName || 'Stock Cooler',
        os: 'Windows',
        windowsKey: '',
        windowsActivationState: 'Unverified',
        __prices: prices,
        // Exactly these three keys. app.js:4112 rebuilds __build as a fresh
        // three-key literal, so a fourth key would be destroyed on first save.
        __build: { salesExec: (currentProfile && currentProfile.email) || '', importance: 'light', tier: 1 },
        __procurement: { components: {}, received: false, undamaged: false, matches: false }
      }
    };

    const { error } = await db.from('tickets').insert(row);
    if (error) throw error;

    // Optimistic: the realtime INSERT will also arrive, and both paths dedupe by id.
    if (!allTickets.some(t => t.id === id)) allTickets.unshift(row);
    if (typeof renderBoard === 'function') renderBoard();
    if (typeof renderTable === 'function' && document.getElementById('sales-body')) {
      try { renderTable(); } catch (e) {}
    }

    // Breadcrumb before the reset: if anything downstream goes wrong the exec can
    // still see what was quoted against which ticket.
    try {
      localStorage.setItem(QB_DRAFT_KEY + ':last', JSON.stringify({
        ticketId: id, at: nowIso, customer: name, phone: phone, quote: qbState.items
      }));
    } catch (e) {}

    const code = id.slice(-6).toUpperCase();
    qbResetDraft();
    qbCreateStatus('<strong>Ticket created.</strong> Customer receipt code <strong>' + escHtml(code) +
      '</strong> — they can track it on this site. It is now in the Pipeline under <strong>Quote</strong>, ' +
      'and moves to Procurement as soon as the floor assigns a technician.', 'ok');
    // Stays disabled: a second click would create a duplicate ticket.
    if (btn) btn.textContent = 'Ticket ' + code + ' created';
  } catch (err) {
    // The draft is left completely untouched so nothing typed is lost.
    qbCreating = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Create build ticket →'; }
    qbCreateStatus('Could not create the ticket: ' + escHtml(err.message || 'unknown error') +
      '<br>Your quotation has been kept — nothing was lost.', 'err');
  }
}
