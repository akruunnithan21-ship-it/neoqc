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
const VIEWS = ['customer', 'login', 'dashboard', 'profile', 'ticket-status', 'new-build', 'board', 'service',
               'new-service', 'new-rma', 'my-requests'];
// Staff-only views. ONE list, used by the sign-in guard in activateView() and
// by the boot deep-link allow-list, so the two can no longer drift apart (the
// boot copy was once missing 'new-build').
const STAFF_VIEWS = ['dashboard', 'profile', 'ticket-status', 'new-build', 'board',
                     'new-service', 'new-rma', 'my-requests'];
// The service/RMA request views are bookmarked on phones. A signed-out visit
// remembers where it was going so signing in lands there, not on the default.
const RETURN_AFTER_LOGIN = ['new-service', 'new-rma', 'my-requests'];
let viewAfterLogin = null;

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
  if (STAFF_VIEWS.includes(name) && !currentProfile) {
    if (RETURN_AFTER_LOGIN.includes(name)) viewAfterLogin = name;
    name = 'login';
  }
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
  // My requests polls every 60s; same rule.
  if (name !== 'my-requests' && window.NeoQcWebOps) window.NeoQcWebOps.stopPolling();
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
  else if (name === 'new-service') { if (window.NeoQcWebOps) window.NeoQcWebOps.showNewService(); }
  else if (name === 'new-rma') { if (window.NeoQcWebOps) window.NeoQcWebOps.showNewRma(); }
  else if (name === 'my-requests') { if (window.NeoQcWebOps) window.NeoQcWebOps.showMyRequests(); }
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

// Everything the signed-in person had loaded, including the request forms
// (a customer's name, phone and address): on a shared counter PC the next
// person to sign in must not find any of it.
function clearStaffState() {
  dashboardLoaded = false; tsLoaded = false; boardLoaded = false;
  if (realtimeChannel) { try { db.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
  if (staffChannel)    { try { db.removeChannel(staffChannel);    } catch (e) {} staffChannel = null; }
  allTickets = [];
  viewAfterLogin = null;
  if (window.NeoQcWebOps) { try { window.NeoQcWebOps.reset(); } catch (e) { console.warn('request forms reset failed', e); } }
}

async function webSignOut() {
  // Sign out wipes the request forms, so say so before losing someone's work.
  if (window.NeoQcWebOps && typeof window.NeoQcWebOps.hasUnsent === 'function' && window.NeoQcWebOps.hasUnsent() &&
      !confirm('A request you started has not been sent yet. Signing out clears it from this page. Sign out anyway?')) return;
  try { await db.auth.signOut(); } catch (e) {}
  currentProfile = null;
  clearStaffState();
  showReauthNote(false);
  applyMenu();
  activateView('customer');
}

// A lapsed session while a request form is open (SPEC §0.8: never lose what
// was typed). Sign out would wipe both forms, so this goes straight to the
// sign-in screen, keeps the forms (and their request ids) in memory, and
// comes back to `view` after signing in. Someone ELSE signing in gets clean
// forms: see initLoginForm.
function webReauth(view) {
  viewAfterLogin = RETURN_AFTER_LOGIN.includes(view) ? view : null;
  const em = document.getElementById('web-login-email');
  if (em && currentProfile && currentProfile.email) em.value = currentProfile.email;
  showReauthNote(true);
  activateView('login');
  setTimeout(() => {
    const pin = document.getElementById('web-login-pin');
    if (pin && em && em.value) pin.focus();
  }, 160);
}
function showReauthNote(on) {
  const n = document.getElementById('web-login-reauth');
  if (n) n.classList.toggle('hidden', !on);
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
    // Set only when signing in again over a lapsed session (webReauth).
    const prevEmail = currentProfile ? String(currentProfile.email || '').toLowerCase() : '';
    const res = await webSignIn(email, pin);
    btn.disabled = false; btn.textContent = old;
    if (!res.ok) { err.textContent = res.msg; err.classList.remove('hidden'); document.getElementById('web-login-pin').value = ''; return; }
    document.getElementById('web-login-pin').value = '';
    // Someone else signed in on a page that still holds the previous person's
    // forms and lists: nothing of theirs may remain.
    const nowEmail = String((currentProfile && currentProfile.email) || '').toLowerCase();
    if (prevEmail && prevEmail !== nowEmail) clearStaffState();
    showReauthNote(false);
    applyMenu();
    routeAfterWebLogin();
  });
}

function routeAfterWebLogin() {
  const back = viewAfterLogin;
  viewAfterLogin = null;
  if (back && RETURN_AFTER_LOGIN.includes(back)) { activateView(back); return; }
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
    // 'service' too: the tracking link a salesperson copies from a new request
    // must open the tracking page in their own (signed-in) browser as well.
    if (STAFF_VIEWS.includes(requested) || requested === 'service') activateView(requested);
    else routeAfterWebLogin();
  } else if (RETURN_AFTER_LOGIN.includes(requested)) {
    activateView(requested);              // → login, remembering where to come back to
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

// ═══════════════════════════════════════════════════════════
//  SERVICE + RMA REQUESTS (v1.10.0) — "New service request", "New RMA",
//  "My requests". For every signed-in staff member; sales on phones most of all.
//
//  RULES THIS SECTION KEEPS (each one is a bug somebody already paid for):
//  1. Writes go ONLY through the SECURITY DEFINER RPCs service_create and
//     rma_create. Sales have no table access to service or RMA rows and never
//     need any; the RPC re-validates every field, so nothing typed here is
//     trusted by the server.
//  2. One client_request_id per form, minted when the form opens and REUSED on
//     every retry. A retry after a lost response returns the same ticket
//     (duplicate:true) instead of creating a second one. A new id is minted
//     only by "New request" / "Start over".
//  3. Typed text is rendered through textContent and DOM properties only. No
//     innerHTML with data anywhere in this section, so escHtml()'s single-quote
//     gap cannot apply.
//  4. Enter never submits: there is no <form>, and a keydown guard swallows
//     Enter in inputs. A phone keyboard's "Go" key or a scanner must not create
//     a ticket.
//  5. datetime-local values are LOCAL time and are converted with the local
//     Date constructor. (qbDeadlineToIso's naive-as-UTC rule is a build-ticket
//     compatibility quirk and does not apply here.)
//  6. Errors are shown, never swallowed, and a failed create leaves every
//     typed value in place.
// ═══════════════════════════════════════════════════════════
(function () {
  'use strict';

  var TRACK_BASE = 'https://neoqctracker.netlify.app/?view=service&code=';
  var MY_POLL_MS = 60000;
  var LOOKUP_DELAY_MS = 300;
  var TECHS_MAX_AGE_MS = 5 * 60000;
  var DRAFT_MAX_AGE_MS = 12 * 3600000;
  var MAX_UNITS = 20;
  var DAY_MS = 86400000;

  // ── tiny DOM kit ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function client() { return (typeof db !== 'undefined' && db) ? db : null; }
  function me() { return (typeof currentProfile !== 'undefined' && currentProfile) ? currentProfile : null; }
  function val(id) { var n = $(id); return n ? String(n.value == null ? '' : n.value).trim() : ''; }
  function setVal(id, v) { var n = $(id); if (n) n.value = v == null ? '' : v; }
  function checked(id) { var n = $(id); return !!(n && n.checked); }
  function show(n, on) { if (n) n.classList.toggle('hidden', !on); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  // createElement with properties. Attributes go through setAttribute and text
  // through textContent, so no value is ever parsed as markup.
  function h(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'text') n.textContent = String(v);
        else if (k === 'className') n.className = v;
        else if (k === 'value') n.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') n[k] = true;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
        else if (k === 'href') n.href = v;
        else if (typeof v === 'function') n.addEventListener(k.replace(/^on/, ''), v);
        else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    appendKids(n, kids);
    return n;
  }
  function appendKids(n, kids) {
    if (kids == null) return;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (c) {
      if (c == null || c === false || c === '') return;
      n.appendChild((typeof c === 'string' || typeof c === 'number') ? document.createTextNode(String(c)) : c);
    });
  }
  function setStatus(id, text, kind) {
    var n = $(id);
    if (!n) return;
    n.className = 'wo-status' + (kind ? ' wo-' + kind : '');
    n.textContent = text || '';
  }

  // ── vocabularies ─────────────────────────────────────────────────────────
  function S() { return window.NeoQcService || {}; }
  function CAT() { return window.NeoQcCatalog || null; }

  // Fallbacks used ONLY when this site's shared/service-status.js predates the
  // database (a deploy that skipped `node sync-shared.js`). Keys are the SQL
  // check-constraint values from SPEC §1, so a fallback can never invent a
  // value the server accepts; it only keeps the form usable.
  var FB_TYPES = [
    { value: 'in_store', label: 'In-store' },
    { value: 'on_site', label: 'On-site' },
    { value: 'remote', label: 'Remote' }
  ];
  var FB_CATEGORIES = [
    { value: 'repair', label: 'Repair' }, { value: 'warranty_claim', label: 'Warranty claim' },
    { value: 'upgrade', label: 'Upgrade' }, { value: 'installation', label: 'Installation' },
    { value: 'data_recovery', label: 'Data recovery' }, { value: 'os_software', label: 'OS / software' },
    { value: 'networking', label: 'Networking' }, { value: 'maintenance', label: 'Maintenance' },
    { value: 'diagnosis_only', label: 'Diagnosis only' }
  ];
  var FB_ITEM_KINDS = [
    { value: 'pc', label: 'Desktop PC' }, { value: 'laptop', label: 'Laptop' },
    { value: 'gpu', label: 'Graphics card' }, { value: 'psu', label: 'Power supply' },
    { value: 'ram', label: 'RAM' }, { value: 'ssd', label: 'SSD' }, { value: 'hdd', label: 'Hard drive' },
    { value: 'motherboard', label: 'Motherboard' }, { value: 'cpu', label: 'Processor' },
    { value: 'cooler', label: 'Cooler' }, { value: 'monitor', label: 'Monitor' },
    { value: 'peripheral', label: 'Peripheral' }, { value: 'other', label: 'Other' }
  ];
  var FB_SOURCES = [
    { value: 'neo_tokyo', label: 'Neo Tokyo' },
    { value: 'elsewhere', label: 'Bought elsewhere' },
    { value: 'unknown', label: 'Not sure' }
  ];
  var FB_PRIORITIES = [
    { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }
  ];
  var FB_REMOTE_TOOLS = [
    { value: 'anydesk', label: 'AnyDesk' }, { value: 'teamviewer', label: 'TeamViewer' },
    { value: 'rustdesk', label: 'RustDesk' }, { value: 'quick_assist', label: 'Quick Assist' },
    { value: 'chrome_remote', label: 'Chrome Remote Desktop' }, { value: 'other', label: 'Other' }
  ];

  // The website's channel chips are a fixed subset (SPEC §5): a request raised
  // here is never a courier arrival or a staff-internal job.
  var WEB_CHANNELS = [
    { value: 'phone', label: 'Phone call' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'walk_in', label: 'Walk-in expected' },
    { value: 'website', label: 'Website' }
  ];
  var TYPE_HELP = {
    in_store: 'They bring it to the shop',
    on_site: 'We go to them',
    remote: 'We connect to their computer'
  };
  // SPEC-GAP: §5 says "sender kind" without listing values. our_tech and shop
  // are workshop-internal flows (a part pulled on site, our own defective stock)
  // that the desk logs in the app, so the website offers the two outside senders.
  var WEB_SENDERS = [
    { value: 'customer', label: 'The customer' },
    { value: 'third_party_tech', label: 'Another shop or technician' }
  ];
  // SPEC-GAP: §5 does not name the rma_create `source` for a website request.
  // 'walk_in' / 'courier' (how the part will physically reach us) is what the
  // desk's "Log courier arrival" search and the RMA source filter work on; the
  // creator is recorded anyway (created_by_email), so provenance is not lost.
  var ARRIVALS = [
    { value: 'walk_in', label: 'They bring it in' },
    { value: 'courier', label: 'By courier' }
  ];
  var RETURNS = [
    { value: 'collect', label: 'Collect from the shop' },
    { value: 'courier', label: 'Courier it back' }
  ];
  var DIAG_BY = [
    { value: 'customer', label: 'What the customer says' },
    { value: 'third_party', label: "Their technician's finding" },
    { value: 'us', label: 'We checked it' }
  ];
  var DIAG_DEFAULT = { customer: 'customer', third_party_tech: 'third_party' };

  function labelOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.label || v.staff || v.customer || '';
  }
  // A shared map ({key: 'Label'} or {key: {label}}) as [{value, label}], or the
  // fallback when the shared module does not have it yet.
  function vocabList(name, fallback) {
    var m = S()[name];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      var keys = Object.keys(m);
      if (keys.length) return keys.map(function (k) { return { value: k, label: labelOf(m[k]) || k.replace(/_/g, ' ') }; });
    }
    return fallback;
  }
  function vocabLabel(name, fallback, key) {
    if (!key) return '';
    var list = vocabList(name, fallback);
    for (var i = 0; i < list.length; i++) if (list[i].value === key) return list[i].label;
    return String(key).replace(/_/g, ' ');
  }
  function typeLabel(t) { return vocabLabel('TYPES', FB_TYPES, t || 'in_store'); }
  function kindLabel(k) { return vocabLabel('ITEM_KINDS', FB_ITEM_KINDS, k); }
  function staffStage(stage) {
    var M = S();
    return typeof M.staffLabel === 'function' ? M.staffLabel(stage) : String(stage || '').replace(/_/g, ' ');
  }
  function rmaStage(stage) {
    var M = S();
    return typeof M.rmaStaffLabel === 'function' ? M.rmaStaffLabel(stage) : String(stage || '').replace(/_/g, ' ');
  }
  function partLabel(kind, brand, model) {
    var M = S();
    if (typeof M.itemLabel === 'function') {
      try { var l = M.itemLabel(kind, brand, model); if (l) return String(l); } catch (e) { console.warn('itemLabel failed', e); }
    }
    return [kindLabel(kind), brand, model].filter(function (x) { return x; }).join(' ') || 'Part';
  }
  function faultList() {
    var C = CAT();
    return (C && Array.isArray(C.FAULTS)) ? C.FAULTS : [];
  }
  function faultLabel(key) {
    var f = faultList().filter(function (x) { return x.key === key; })[0];
    return f ? f.label : String(key || '').replace(/_/g, ' ');
  }

  // ── phones, ids, dates ───────────────────────────────────────────────────
  // The unified phone rule (SPEC-AMENDMENTS A1'), the same everywhere: SQL
  // norm_phone()/phone_ok(), the desktop and this site. Its one JS source is
  // shared/service-catalog.js (NeoQcCatalog.normPhone / phoneOk /
  // isValidPhone, copied to dashboard/shared by `node sync-shared.js` at
  // deploy). The inline copies below run only when this site's catalog
  // predates them, and must stay identical to it.
  //   normPhone(raw): digits only; one leading '00' (the international
  //     dialling prefix) is dropped; then 10 digits → 91 + d, 0 + 10 digits →
  //     91 + d, anything else stays its own digits. The country code is KEPT,
  //     so a Gulf or NRI number (+971 50 123 4567) stays 971501234567 instead
  //     of being cut down to someone else's Indian mobile, and 00971… is the
  //     same customer as +971….
  //   phoneOk(norm): 12 to 15 digits, or 11 digits for Kuwait (965), Oman
  //     (968), Bahrain (973) and Qatar (974), whose numbers are a 3-digit
  //     code plus 8 digits. Nothing else: an 11-digit Indian typo is refused.
  //   isValidPhone(raw) = phoneOk(normPhone(raw)).
  var PHONE_GULF_11 = ['965', '968', '973', '974'];
  function normPhoneInline(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.length === 10) return '91' + d;
    if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(-10);
    return d;
  }
  function phoneOkInline(norm) {
    var n = String(norm == null ? '' : norm);
    if (!/^\d+$/.test(n)) return false;
    if (n.length >= 12 && n.length <= 15) return true;
    return n.length === 11 && PHONE_GULF_11.indexOf(n.slice(0, 3)) !== -1;
  }
  function normPhone(raw) {
    var C = CAT();
    if (C && typeof C.normPhone === 'function') return String(C.normPhone(raw) || '');
    return normPhoneInline(raw);
  }
  // Takes a NORMALISED number, like NeoQcCatalog.phoneOk. Form input goes
  // through isValidPhone.
  function phoneOk(norm) {
    var C = CAT();
    if (C && typeof C.phoneOk === 'function') return !!C.phoneOk(norm);
    return phoneOkInline(norm);
  }
  // A phone we can track and message, from what was typed.
  function isValidPhone(raw) {
    var C = CAT();
    if (C && typeof C.isValidPhone === 'function') return !!C.isValidPhone(raw);
    return phoneOk(normPhone(raw));
  }
  // What goes to the server: '+' and the normalised digits, exactly as the
  // desktop intake sends it. The server normalises again either way.
  function phoneOut(p) { return '+' + normPhone(p); }
  function fmtPhone(p) {
    var n = normPhone(p);
    if (!n) return '';
    if (n.length === 12 && n.indexOf('91') === 0) return '+91 ' + n.slice(2, 7) + ' ' + n.slice(7);
    return n.length >= 11 ? '+' + n : n;
  }
  var PHONE_HELP = 'a 10-digit mobile number, or the full number with the country code';

  function newRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* insecure context or an old browser: build a v4 by hand */ }
    var b = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var x = Array.prototype.map.call(b, function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toLocalInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function localDay(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  // Parsed by hand into the LOCAL constructor: some older mobile Safari builds
  // read "2026-10-21T14:30" as UTC, which would shift a customer's window by
  // 5.5 hours.
  function parseLocalInput(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }
  // A date-only answer means "by the end of that working day": 18:00 local,
  // the same rule as the app's dayToIso.
  function dayToIso(day) {
    var m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], 18, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDayTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); }
  function fmtMinutes(m) {
    m = Math.round(Number(m) || 0);
    if (m <= 0) return '';
    if (m < 60) return m + ' min';
    var hrs = Math.floor(m / 60), rest = m % 60;
    return hrs + ' h' + (rest ? ' ' + rest + ' min' : '');
  }
  function firstName(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(function (w) { return w; });
    while (parts.length > 1 && /^(dr|mr|mrs|ms|miss|prof|sri|smt)\.?$/i.test(parts[0])) parts.shift();
    return parts[0] || '';
  }
  // "Hi Arjun," for a person; a shop or company is greeted whole up to its
  // first comma ("Hi Sreekumar Computers,"), never "Hi Sreekumar,".
  var BUSINESS_NAME_RE = /(^|[^a-z])(co|company|corp|ltd|limited|pvt|llp|inc|computers|systems|technologies|infotech|solutions|services|traders|enterprises|agencies|industries|clinic|hospital|hotel|school|college|office|stores?|mart|studio)(?=$|[^a-z])/i;
  function greeting(name) {
    var full = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (full && BUSINESS_NAME_RE.test(full)) return 'Hi ' + full.split(',')[0].trim() + ',';
    var f = firstName(full);
    return f ? 'Hi ' + f + ',' : 'Hello,';
  }
  function trackUrl(code) { return TRACK_BASE + encodeURIComponent(code || ''); }

  // ── errors ───────────────────────────────────────────────────────────────
  // Server errors prefixed NEO_ carry a human sentence after the colon (SPEC
  // §0.8): show the sentence. Everything else is mapped to something a
  // salesperson can act on, keeping the raw text when nothing fits.
  function errText(e) {
    if (!e) return 'Something went wrong.';
    var msg = String(e.message || e.error_description || e.msg || (typeof e === 'string' ? e : '') || '');
    var all = msg + ' ' + String(e.details || '') + ' ' + String(e.hint || '');
    var m = all.match(/NEO_[A-Z_]+:\s*([^\n]+)/);
    if (m) return m[1].trim();
    if (e.code === 'PGRST202' || /could not find the function|schema cache/i.test(msg)) {
      return "This isn't switched on yet: the database update for service and RMA requests hasn't been applied. Tell the admin.";
    }
    // No "sign out and back in" advice here: Sign out wipes both forms. The
    // callers add a [Sign in again] button (signInAgain) when authLapsed(e).
    if (e.code === '42501' || /permission denied/i.test(msg)) {
      return "Your account can't do this, or your sign-in has expired.";
    }
    if (/^PGRST30\d$/.test(String(e.code || '')) || (/jwt|token/i.test(msg) && /expired|invalid/i.test(msg))) {
      return 'Your sign-in has expired.';
    }
    if (/failed to fetch|networkerror|network request failed|load failed|timed? ?out/i.test(msg)) {
      return "Couldn't reach the server. Check the connection and try again.";
    }
    return msg || 'Something went wrong.';
  }
  // The session behind the page has lapsed (expired or missing JWT), as
  // opposed to the server refusing on purpose (NEO_DENIED). 42501 is both
  // "not allowed" and "signed out" (an anonymous caller has no EXECUTE), so it
  // counts: signing in again is harmless when it was a real refusal.
  function authLapsed(e) {
    if (!e) return false;
    var msg = String(e.message || e.error_description || e.msg || (typeof e === 'string' ? e : '') || '');
    if (/NEO_[A-Z_]+:/.test(msg + ' ' + String(e.details || ''))) return false;
    if (/^PGRST30\d$/.test(String(e.code || ''))) return true;
    if (e.code === '42501' || /permission denied/i.test(msg)) return true;
    return /jwt|token/i.test(msg) && /expired|invalid/i.test(msg);
  }
  // Whether a failed create may still have been committed: only an answer
  // FROM the database (a Postgres / PostgREST code, or a NEO_ sentence) proves
  // the transaction rolled back. A dropped connection or a timeout proves
  // nothing — the ticket may exist even though the answer never came back.
  function outcomeUnknown(e) {
    if (!e) return true;
    var all = String(e.message || '') + ' ' + String(e.details || '');
    if (/NEO_[A-Z_]+:/.test(all)) return false;
    return !/^[0-9A-Z]{5}$|^PGRST\d+$/.test(String(e.code || ''));
  }
  // [Sign in again] keeps the forms: it goes straight to the sign-in screen
  // (webReauth, top of this file) and comes back to `view`, instead of the
  // Sign out that would wipe both forms (SPEC §0.8: never lose what was typed).
  function signInAgainBtn(view) {
    var b = h('button', { type: 'button', className: 'wo-mini', text: 'Sign in again' });
    b.addEventListener('click', function () {
      flushDrafts();
      if (typeof webReauth === 'function') webReauth(view);
    });
    return b;
  }
  // A status line that ends in a [Sign in again] button when the session has
  // lapsed, else plain text.
  function setStatusErr(id, e, tail, view) {
    if (!authLapsed(e)) { setStatus(id, errText(e) + (tail ? ' ' + tail : ''), 'err'); return; }
    setStatus(id, errText(e) + ' Sign in again here — nothing you typed is lost. ', 'err');
    var n = $(id);
    if (n) n.appendChild(signInAgainBtn(view));
  }

  // ── copy + WhatsApp ──────────────────────────────────────────────────────
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed — select it by hand';
      clearTimeout(btn._woT);
      btn._woT = setTimeout(function () { btn.textContent = btn.dataset.label; }, 1800);
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
        return;
      }
    } catch (e) { /* fall through to the textarea trick */ }
    done(legacyCopy(text));
  }
  function copyBtn(label, text) {
    var b = h('button', { type: 'button', className: 'wo-mini', text: label });
    b.addEventListener('click', function () { copyText(text, b); });
    return b;
  }

  // Opens wa.me in a new tab (SPEC §5: window.open). The tab is opened blank
  // first and cut loose from this page (opener = null) BEFORE it navigates, so
  // the other site never gets a handle on this one. A popup blocker can still
  // swallow window.open (it returns null), so the caller gets a link to tap
  // instead of a button that silently does nothing.
  // wa.me takes the full international number without '+' (A1): no country
  // code is ever guessed here, so a Gulf customer's chat opens with them.
  function waUrl(phone, text) {
    if (!isValidPhone(phone)) return null;
    return 'https://wa.me/' + normPhone(phone) + '?text=' + encodeURIComponent(text || '');
  }
  function waButton(label, phone, textFn, fallbackHost) {
    var b = h('button', { type: 'button', className: 'btn-primary wo-wa-btn', text: label });
    b.addEventListener('click', function () {
      var url = waUrl(phone, textFn());
      if (!url) {
        b.disabled = true;
        b.textContent = "No usable mobile number, so WhatsApp can't open";
        return;
      }
      var w = null;
      try { w = window.open('', '_blank'); } catch (e) { w = null; }
      if (w) {
        try { w.opener = null; } catch (e) { /* already detached */ }
        try { w.location.href = url; return; } catch (e) { try { w.close(); } catch (e2) { /* gone */ } }
      }
      if (fallbackHost) {
        clear(fallbackHost);
        fallbackHost.appendChild(h('span', { text: 'The browser blocked the new tab. ' }));
        fallbackHost.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Tap here to open WhatsApp' }));
        show(fallbackHost, true);
      }
    });
    return b;
  }
  // Under 600 characters, no emoji, always the code + link + phone-digits line
  // (the same contract as NeoQcCatalog.WA_TEMPLATES).
  function capText(t) { t = String(t || ''); return t.length > 600 ? t.slice(0, 597) + '...' : t; }

  // ── sessionStorage drafts ────────────────────────────────────────────────
  // A phone browser discards a background tab while the salesperson switches to
  // WhatsApp to read the customer's message, and the reload would wipe the form.
  // sessionStorage survives that reload but not closing the tab, so customer
  // details do not linger on the device. The client_request_id travels with the
  // draft: a create whose response was lost in the reload is still idempotent.
  function draftKey(form) { return 'neo-web-draft:' + form; }
  function saveDraft(form, state, noteId) {
    try {
      sessionStorage.setItem(draftKey(form), JSON.stringify({
        v: 1, owner: (me() && me().email) || '', at: Date.now(), state: state
      }));
    } catch (e) { return; }
    var note = $(noteId);
    if (note) {
      note.textContent = 'Draft kept on this tab';
      clearTimeout(note._woT);
      note._woT = setTimeout(function () { note.textContent = ''; }, 1600);
    }
  }
  function loadDraft(form) {
    try {
      var raw = sessionStorage.getItem(draftKey(form));
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || !d.state || typeof d.state !== 'object') return null;
      if (!(Date.now() - Number(d.at) < DRAFT_MAX_AGE_MS)) return null;
      if (d.owner !== ((me() && me().email) || '')) return null;
      return d.state;
    } catch (e) { return null; }
  }
  function dropDraft(form) { try { sessionStorage.removeItem(draftKey(form)); } catch (e) { /* private mode */ } }

  // ── chips + type cards ───────────────────────────────────────────────────
  // Toggle buttons. State is synced in place (classes + aria-pressed) instead
  // of re-rendering, so a keyboard user's focus stays on the chip they pressed.
  function chipGroup(host, options, cfg) {
    cfg = cfg || {};
    var multi = !!cfg.multi;
    var sel = multi ? (cfg.value || []).slice() : (cfg.value == null ? null : cfg.value);
    var opts = options || [];
    function isOn(v) { return multi ? sel.indexOf(v) !== -1 : sel === v; }
    function sync() {
      Array.prototype.forEach.call(host.querySelectorAll('.wo-chip'), function (b) {
        var on = isOn(b.dataset.value);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    function render() {
      clear(host);
      opts.forEach(function (o) {
        host.appendChild(h('button', {
          type: 'button', className: 'wo-chip', 'aria-pressed': 'false',
          dataset: { value: o.value }, title: o.title || null, text: o.label
        }));
      });
      sync();
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.wo-chip') : null;
      if (!b || !host.contains(b)) return;
      var v = b.dataset.value;
      if (multi) {
        var i = sel.indexOf(v);
        if (i === -1) sel.push(v); else sel.splice(i, 1);
      } else if (sel === v) {
        if (!cfg.allowNone) return;
        sel = null;
      } else {
        sel = v;
      }
      sync();
      if (cfg.onChange) cfg.onChange(api.get());
    });
    var api = {
      get: function () { return multi ? sel.slice() : sel; },
      set: function (v) {
        if (multi) sel = Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : [];
        else sel = (v == null || v === '') ? null : String(v);
        sync();
      },
      setOptions: function (o) { opts = o || []; render(); },
      el: host
    };
    render();
    return api;
  }

  function svgIcon(kind) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '24'); s.setAttribute('height', '24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    var paths = {
      in_store: ['M3 10l9-6 9 6', 'M5 9.5V20h14V9.5', 'M10 20v-5h4v5'],
      on_site: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'M12 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
      remote: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4']
    };
    (paths[kind] || []).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  // Three big cards for service_type (SPEC §5 "type cards").
  function typeCards(host, initial, onChange) {
    var cur = initial;
    var types = vocabList('TYPES', FB_TYPES).filter(function (t) { return !!TYPE_HELP[t.value]; });
    if (!types.length) types = FB_TYPES;
    function sync() {
      Array.prototype.forEach.call(host.querySelectorAll('.wo-type-card'), function (b) {
        var on = b.dataset.value === cur;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }
    clear(host);
    types.forEach(function (t) {
      host.appendChild(h('button', {
        type: 'button', role: 'radio', 'aria-checked': 'false', className: 'wo-type-card', dataset: { value: t.value }
      }, [
        h('span', { className: 'wo-type-icon' }, svgIcon(t.value)),
        h('span', { className: 'wo-type-name', text: t.label }),
        h('span', { className: 'wo-type-help', text: TYPE_HELP[t.value] || '' })
      ]));
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.wo-type-card') : null;
      if (!b || !host.contains(b)) return;
      if (b.dataset.value === cur) return;
      cur = b.dataset.value;
      sync();
      onChange(cur, true);
    });
    // Arrow keys move between the cards, the way a radio group should.
    host.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
      var cards = Array.prototype.slice.call(host.querySelectorAll('.wo-type-card'));
      var i = cards.map(function (c) { return c.dataset.value; }).indexOf(cur);
      var step = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      var next = cards[(i + step + cards.length) % cards.length];
      if (!next) return;
      e.preventDefault();
      cur = next.dataset.value;
      sync();
      next.focus();
      onChange(cur, true);
    });
    sync();
    return {
      get: function () { return cur; },
      set: function (v) { if (TYPE_HELP[v]) { cur = v; sync(); } }
    };
  }

  function fillSelect(sel, options, placeholder) {
    var keep = sel.value;
    clear(sel);
    if (placeholder != null) sel.appendChild(h('option', { value: '', text: placeholder }));
    options.forEach(function (o) { sel.appendChild(h('option', { value: o.value, text: o.label })); });
    if (keep && options.some(function (o) { return o.value === keep; })) sel.value = keep;
  }

  // Enter inside an input never submits or closes anything (SPEC §0.9).
  function enterGuard(root) {
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A')) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) e.preventDefault();
    });
  }

  // Inline validation: mark the fields, say the first problem, focus it.
  function markErrors(root, errors, statusId) {
    Array.prototype.forEach.call(root.querySelectorAll('.wo-invalid'), function (n) {
      n.classList.remove('wo-invalid');
      n.removeAttribute('aria-invalid');
    });
    if (!errors.length) return;
    errors.forEach(function (er) {
      var n = $(er.id);
      if (n) { n.classList.add('wo-invalid'); n.setAttribute('aria-invalid', 'true'); }
    });
    setStatus(statusId, errors[0].msg + (errors.length > 1 ? ' (' + (errors.length - 1) + ' more to fix below it.)' : ''), 'err');
    var first = $(errors[0].id);
    if (first) {
      try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { first.scrollIntoView(); }
      try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
    }
  }
  function unmarkOnInput(root) {
    root.addEventListener('input', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('wo-invalid')) {
        e.target.classList.remove('wo-invalid');
        e.target.removeAttribute('aria-invalid');
      }
    });
  }

  // Keyboard and screen-reader users land on the result, not on a button
  // that just disappeared with the form.
  function focusDone(host) {
    var t = host.querySelector('.wo-done-title');
    if (!t) return;
    try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
  }

  // Drop empty optional values so the payload says only what was typed; the
  // RPC applies its own defaults to anything absent.
  function compact(o) {
    var out = {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v == null) return;
      if (typeof v === 'string' && v.trim() === '') return;
      out[k] = v;
    });
    return out;
  }

  // ── Google Maps links ────────────────────────────────────────────────────
  function latLngFromUrl(u) {
    var s = String(u || '');
    try { s = decodeURIComponent(s); } catch (e) { /* keep the raw text */ }
    var m = s.match(/@(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/) ||
            s.match(/[?&](?:q|query|ll|sll|destination|daddr|center)=(?:loc:)?\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i) ||
            s.match(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }
  // → {ok, url, latlng, msg}. Only http(s) links are kept: the desktop renders
  // site_maps_url as a link, and a javascript: URL must never get that far.
  function readMapLink(v) {
    var s = String(v || '').trim();
    if (!s) return { ok: true, url: null, latlng: null, msg: '' };
    var c = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (c) {
      var lat = parseFloat(c[1]), lng = parseFloat(c[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return {
          ok: true, url: 'https://www.google.com/maps?q=' + lat + ',' + lng, latlng: { lat: lat, lng: lng },
          msg: 'Location found (' + lat.toFixed(5) + ', ' + lng.toFixed(5) + ').'
        };
      }
    }
    if (!/^https?:\/\//i.test(s)) {
      return { ok: false, url: null, latlng: null, msg: "That isn't a map link. Paste the link from Google Maps, or leave it empty." };
    }
    var ll = latLngFromUrl(s);
    if (ll) return { ok: true, url: s, latlng: ll, msg: 'Location found (' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) + ').' };
    return { ok: true, url: s, latlng: null, msg: "Couldn't read a location from that link. It is saved, and the technician can still open it." };
  }

  // ── customer lookup (phone first) ────────────────────────────────────────
  // One controller per phone field. The stale-response guard is the point: a
  // slow answer for 98470 12345 must never paint over the customer for the
  // number typed after it.
  function makeLookup(input, panel, cfg) {
    var st = { seq: 0, timer: null, data: null, norm: '', pending: false };

    function paintBusy() {
      clear(panel);
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-muted', text: 'Checking this number…' }));
      show(panel, true);
    }
    function paintError(e) {
      clear(panel);
      var retry = h('button', { type: 'button', className: 'wo-mini', text: 'Try again' });
      retry.addEventListener('click', function () { st.norm = ''; onInput(); });
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-warn-text' }, [
        "Couldn't check this number: " + errText(e) + ' You can carry on without it. ',
        authLapsed(e) ? signInAgainBtn(cfg.view) : retry
      ]));
      show(panel, true);
    }
    // onResult(data, norm, failed): data is null for "not a valid number" and
    // for a failed lookup (failed = true); norm says which number it was for.
    function onInput() {
      var norm = normPhone(input.value);
      if (norm === st.norm && (st.data || st.pending)) return;     // same number: keep what we have
      clearTimeout(st.timer);
      st.seq++;                                                     // anything in flight is now stale
      st.norm = norm; st.data = null; st.pending = false;
      if (!phoneOk(norm)) {
        clear(panel); show(panel, false);
        cfg.onResult(null, norm, false);
        return;
      }
      st.pending = true;
      paintBusy();
      st.timer = setTimeout(function () { run(norm); }, LOOKUP_DELAY_MS);
    }
    async function run(norm) {
      var seq = ++st.seq;
      var c = client();
      try {
        if (!c) throw new Error('Not connected.');
        var res = await c.rpc('lookup_customer', { p_phone: norm });
        if (res.error) throw res.error;
        if (seq !== st.seq || normPhone(input.value) !== norm) return;   // the number changed meanwhile
        st.pending = false;
        st.data = res.data || { phone_norm: norm };
        cfg.paint(panel, st.data);
        cfg.onResult(st.data, norm, false);
      } catch (e) {
        if (seq !== st.seq || normPhone(input.value) !== norm) return;
        st.pending = false;
        st.data = null;
        paintError(e);
        cfg.onResult(null, norm, true);
      }
    }
    input.addEventListener('input', onInput);
    return {
      refresh: onInput,
      data: function () { return st.data; },
      reset: function () {
        clearTimeout(st.timer);
        st.seq++; st.data = null; st.norm = ''; st.pending = false;
        clear(panel); show(panel, false);
      }
    };
  }

  // Shared rendering of a lookup_customer answer. opts.pastTechs adds the
  // "served before" suggestions (service form only).
  function paintLookup(panel, d, opts) {
    opts = opts || {};
    clear(panel);
    if (isLimitedLookup(d)) { paintLimited(panel, d); return; }
    var cust = d && d.customer;
    var openJobs = (d && Array.isArray(d.open_jobs)) ? d.open_jobs : [];
    var openRma = (d && Array.isArray(d.open_rma)) ? d.open_rma : [];
    var recent = (d && Array.isArray(d.recent_jobs)) ? d.recent_jobs : [];
    var total = d && d.jobs_total ? Number(d.jobs_total) : 0;

    var ticketsWord = total === 1 ? ' earlier ticket' : ' earlier tickets';
    if (cust) {
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-ok-text' }, [
        h('strong', { text: 'Returning customer: ' + (cust.name || fmtPhone(d.phone_norm || '')) }),
        total ? ' · ' + total + ticketsWord : ''
      ]));
    } else if (total) {
      panel.appendChild(h('div', { className: 'wo-lookup-line', text: 'This number has ' + total + ticketsWord + '.' }));
    } else if (!openJobs.length && !openRma.length) {
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-muted', text: 'New customer: no tickets with this number yet.' }));
    }

    if (openJobs.length) {
      var box = h('div', { className: 'wo-dup' }, [
        h('div', { className: 'wo-dup-title', text: openJobs.length === 1 ? 'Already open for this number' : openJobs.length + ' already open for this number' })
      ]);
      openJobs.slice(0, 6).forEach(function (j) {
        box.appendChild(h('div', { className: 'wo-dup-row' }, [
          h('span', { className: 'mono', text: j.public_code || '—' }),
          ' ' + [staffStage(j.stage), typeLabel(j.service_type), j.device_label, j.assignee ? 'with ' + j.assignee : 'in the queue']
            .filter(function (x) { return x; }).join(' · ')
        ]));
      });
      box.appendChild(h('div', { className: 'wo-dup-note', text: "Check it isn't the same problem before raising another. If it is, ask the shop to update that ticket instead." }));
      panel.appendChild(box);
    }
    if (openRma.length) {
      var rbox = h('div', { className: 'wo-dup wo-dup-soft' }, [h('div', { className: 'wo-dup-title', text: 'Open RMA parts for this number' })]);
      openRma.slice(0, 6).forEach(function (u) {
        rbox.appendChild(h('div', { className: 'wo-dup-row' }, [
          h('span', { className: 'mono', text: u.public_code || '—' }),
          ' ' + [partLabel(u.kind, u.brand, u.model), rmaStage(u.stage)].filter(function (x) { return x; }).join(' · ')
        ]));
      });
      panel.appendChild(rbox);
    }
    if (recent.length && opts.showRecent) {
      var last = recent[0];
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-muted', text:
        'Last closed: ' + (last.public_code || '') + (last.closed_at ? ' on ' + fmtDay(last.closed_at) : '') +
        (last.device_label ? ' (' + last.device_label + ')' : '') }));
    }
    var past = (d && Array.isArray(d.past_techs)) ? d.past_techs : [];
    if (opts.pastTechs && past.length) {
      var row = h('div', { className: 'wo-past' }, [h('span', { className: 'wo-past-label', text: 'Served before by' })]);
      past.slice(0, 4).forEach(function (t) {
        if (!t || !t.email) return;
        var nm = t.name || t.email;
        var b = h('button', { type: 'button', className: 'wo-chip wo-chip-sm', title: 'Suggest ' + nm + ' for this request' },
          [nm + (t.jobs ? ' · ' + t.jobs + '×' : '') + ' — suggest']);
        b.addEventListener('click', function () { opts.onSuggest(t.email, nm); });
        row.appendChild(b);
      });
      panel.appendChild(row);
    }
    show(panel, true);
  }
  // SPEC-AMENDMENTS A19: a caller without service or RMA access (sales, tier
  // 1 — most people on these forms) gets only {phone_norm, known,
  // display_name, open_count, limited}. No customer row, codes or tickets, so
  // the full rendering above would always read "New customer".
  function isLimitedLookup(d) {
    if (!d || typeof d !== 'object') return false;
    if (d.limited) return true;
    return Object.prototype.hasOwnProperty.call(d, 'known') && !Object.prototype.hasOwnProperty.call(d, 'customer');
  }
  function paintLimited(panel, d) {
    var name = d.display_name ? String(d.display_name).trim() : '';
    var openN = Math.max(0, Math.floor(Number(d.open_count) || 0));
    if (d.known && openN > 0) {
      var box = h('div', { className: 'wo-dup' }, [
        h('div', { className: 'wo-dup-title', text: 'This customer already has ' + openN +
          (openN === 1 ? ' open ticket' : ' open tickets') + ' — the help desk will link it.' })
      ]);
      if (name) box.appendChild(h('div', { className: 'wo-dup-row', text: 'Returning customer: ' + name }));
      box.appendChild(h('div', { className: 'wo-dup-note', text: "If it is the same problem, there is no need to raise another: tell the help desk instead." }));
      panel.appendChild(box);
    } else if (d.known) {
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-ok-text' }, [
        h('strong', { text: 'Returning customer' + (name ? ': ' + name : '') }),
        ' · no open tickets'
      ]));
    } else {
      panel.appendChild(h('div', { className: 'wo-lookup-line wo-muted', text: 'New customer: no tickets with this number yet.' }));
    }
    show(panel, true);
  }
  function repeatWithin30(d) {
    var arr = (d && Array.isArray(d.recent_jobs)) ? d.recent_jobs : [];
    var cutoff = Date.now() - 30 * DAY_MS;
    return arr.some(function (j) {
      var t = Date.parse((j && (j.closed_at || j.created_at)) || '');
      return isFinite(t) && t >= cutoff;
    });
  }

  // ═════════════════════════════ NEW SERVICE REQUEST ═════════════════════════
  var ns = {
    bound: false, rid: null, busy: false, done: null,
    typeTouched: false, typeAuto: false, categoryTouched: false,
    // What the customer lookup wrote, and for which number (see withdrawAuto).
    auto: {}, autoFor: null, autoBusiness: false,
    // Payloads sent under ns.rid whose answer never came back (see settleReplay).
    unsure: [],
    lk: null, chips: {}, type: null,
    techs: null, techsAt: 0, techsLoading: null, pendingTech: null,
    draftTimer: null
  };
  var NS_FIELDS = ['ns-phone', 'ns-name', 'ns-email', 'ns-kind', 'ns-device', 'ns-fault-text', 'ns-category',
    'ns-needed', 'ns-address', 'ns-area', 'ns-pincode', 'ns-landmark', 'ns-maps', 'ns-contact', 'ns-machines',
    'ns-win-from', 'ns-win-to', 'ns-win-note', 'ns-session', 'ns-tech', 'ns-tech-reason'];
  var NS_CHECKS = ['ns-business', 'ns-consent'];
  var NS_KEEP_FOR_SAME_CUSTOMER = ['ns-phone', 'ns-name', 'ns-email', 'ns-address', 'ns-area', 'ns-pincode',
    'ns-landmark', 'ns-maps', 'ns-contact'];
  var NS_AUTO_FIELDS = ['ns-name', 'ns-email', 'ns-address', 'ns-area', 'ns-pincode', 'ns-landmark', 'ns-maps'];

  // ── lookup prefill that belongs to its phone number ─────────────────────
  // A lookup fills only empty fields, and records what it wrote. Those values
  // belong to THAT number: when the number changes (another customer, nobody,
  // or no longer a valid number), every field still showing exactly what the
  // lookup wrote is taken back before the new answer is applied, so customer
  // X's address can never ride along onto customer Y's ticket. A value the
  // salesperson typed or edited is theirs and stays.
  function withdrawAuto(auto) {
    Object.keys(auto || {}).forEach(function (id) {
      if (val(id) === auto[id]) setVal(id, '');
    });
    return {};
  }
  function fillAuto(auto, id, value) {
    var v = value == null ? '' : String(value).trim();
    if (!v || val(id)) return;
    setVal(id, v);
    auto[id] = val(id);
  }
  // A lookup that FAILED for the number the values were filled for says
  // nothing new about them, so they stay.
  function lookupKeeps(failed, norm, autoFor) { return !!failed && norm === autoFor; }
  // Draft-restore guard: only known field ids with string values.
  function cleanAuto(o, allowed) {
    var out = {};
    if (!o || typeof o !== 'object') return out;
    allowed.forEach(function (id) { if (typeof o[id] === 'string' && o[id]) out[id] = o[id]; });
    return out;
  }

  // ── a replayed create (SPEC §0.8 idempotency) ───────────────────────────
  // When a try's answer is lost, the form stays editable under the SAME
  // client_request_id. If that try did reach the server, the next press gets
  // its ticket back (duplicate:true) and any edit made since is NOT in it, so
  // the done panel and the WhatsApp message must come from what was SENT, and
  // must say plainly that the edits were not saved.
  // priority/priority_reason follow the lookup, and the consent time is stamped
  // on every press, so they are not edits.
  var REPLAY_IGNORE = { remote_consent_at: true, priority: true, priority_reason: true };
  function payloadKey(p) {
    var o = {};
    Object.keys(p || {}).sort().forEach(function (k) { if (!REPLAY_IGNORE[k]) o[k] = p[k]; });
    if (o.customer_phone) o.customer_phone = normPhone(o.customer_phone);
    if (o.sender_phone) o.sender_phone = normPhone(o.sender_phone);
    return JSON.stringify(o);
  }
  function rememberUnsure(list, payload) {
    var k = payloadKey(payload);
    if (!list.some(function (p) { return payloadKey(p) === k; })) list.push(payload);
    while (list.length > 5) list.splice(1, 1);      // keep the first try; it is the likeliest to have landed
  }
  // → {payload: what the existing ticket holds, edited: the form differs from
  // it, unsure: earlier tries differed, so which one landed is unknown}.
  function settleReplay(unsure, current, phoneKey) {
    var sent = unsure.length ? unsure[0] : current;
    var k = payloadKey(sent);
    var differ = unsure.some(function (p) { return payloadKey(p) !== k; });
    var phones = {};
    unsure.forEach(function (p) {
      if (phoneKey(p)) phones[phoneKey(p)] = true;
    });
    return {
      payload: sent,
      edited: payloadKey(current) !== k,
      unsureWhich: differ,
      phoneUnsure: Object.keys(phones).length > 1
    };
  }
  // A NEO_ refusal other than NEO_DENIED is raised inside the create, AFTER
  // its client_request_id check: had an earlier try landed, this one would
  // have got that ticket back instead. So none did.
  function provesNoneLanded(e) {
    var all = String((e && e.message) || '') + ' ' + String((e && e.details) || '');
    return /NEO_(?!DENIED)[A-Z_]+:/.test(all);
  }
  function cleanUnsure(list) {
    return Array.isArray(list)
      ? list.filter(function (p) { return p && typeof p === 'object' && !Array.isArray(p); }).slice(0, 5)
      : [];
  }
  function replayNote(r) {
    if (!r || (!r.edited && !r.unsureWhich)) return null;
    var lines = [];
    if (r.edited) lines.push('Your changes were not saved — the first request had already gone through. Ask the desk to correct it.');
    if (r.unsureWhich) lines.push('It was sent more than once with different details, so check this request with the desk before relying on it.');
    if (r.phoneUnsure) lines.push("We can't tell which phone number it was saved with, so WhatsApp is not offered here.");
    return h('div', { className: 'wo-dup' }, lines.map(function (t) { return h('div', { className: 'wo-dup-row', text: t }); }));
  }

  function nsBind() {
    if (ns.bound) return true;
    var root = $('ns-form');
    if (!root) return false;
    ns.bound = true;

    ns.chips.channel = chipGroup($('ns-channel'), WEB_CHANNELS, { value: 'phone', onChange: nsChanged });
    ns.type = typeCards($('ns-type'), 'in_store', function () {
      ns.typeTouched = true; ns.typeAuto = false;
      nsTypeChanged();
      nsRefreshFaults();
      nsChanged();
    });
    fillSelect($('ns-kind'), vocabList('ITEM_KINDS', FB_ITEM_KINDS), 'Not sure yet');
    ns.chips.source = chipGroup($('ns-source'), vocabList('PURCHASE_SOURCES', FB_SOURCES), {
      value: null, allowNone: true, onChange: nsChanged
    });
    ns.chips.faults = chipGroup($('ns-faults'), [], { multi: true, onChange: nsFaultsChanged });
    fillSelect($('ns-category'), vocabList('CATEGORIES', FB_CATEGORIES), null);
    $('ns-category').value = 'repair';
    ns.chips.tool = chipGroup($('ns-tool'), vocabList('REMOTE_TOOLS', FB_REMOTE_TOOLS), {
      value: null, allowNone: true, onChange: nsChanged
    });
    fillSelect($('ns-tech'), [], 'No suggestion: whoever is free');

    ns.lk = makeLookup($('ns-phone'), $('ns-lookup'), {
      view: 'new-service',
      paint: function (panel, d) {
        paintLookup(panel, d, { pastTechs: true, showRecent: true, onSuggest: nsSuggestTech });
      },
      onResult: nsApplyLookup
    });

    enterGuard(root);
    unmarkOnInput(root);
    root.addEventListener('input', nsChanged);
    root.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'ns-category') ns.categoryTouched = true;
      if (e.target && e.target.id === 'ns-business') ns.autoBusiness = false;     // theirs now, not the lookup's
      if (e.target && e.target.id === 'ns-kind') nsRefreshFaults();
      nsChanged();
    });
    $('ns-maps').addEventListener('input', nsMapsStatus);
    var moreBtn = $('ns-faults-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { ns.faultsAll = !ns.faultsAll; nsRefreshFaults(); });
    $('ns-submit').addEventListener('click', nsSubmit);
    $('ns-clear').addEventListener('click', function () {
      // Mid-create, the answer is still coming: clearing now would orphan the
      // ticket it creates. Make them wait the second or two.
      if (ns.busy) { setStatus('ns-status', 'Wait for this request to finish first.', 'busy'); return; }
      if (!ns.done && nsDirty() && !confirm('Clear this request and start again? Nothing has been sent yet.')) return;
      nsReset(false);
    });

    // Read the draft BEFORE the reset below: nsReset() drops the stored draft,
    // so reading it afterwards would always find nothing.
    var draft = loadDraft('ns');
    nsRefreshFaults();
    nsReset(false, true);
    if (draft) nsRestore(draft);
    return true;
  }

  function showNewService() {
    if (!nsBind()) return;
    nsSetMins();
    loadTechs(false);
    if (ns.done) { show($('ns-form'), false); show($('ns-done'), true); }
  }

  // Past dates are refused, so the pickers should not offer them.
  function nsSetMins() {
    var now = new Date();
    var minDt = toLocalInput(now);
    ['ns-win-from', 'ns-win-to'].forEach(function (id) { var n = $(id); if (n) n.min = minDt; });
    var nd = $('ns-needed'); if (nd) nd.min = localDay(now);
  }

  function nsChanged() {
    if (!ns.bound || ns.done) return;
    nsSummary();
    clearTimeout(ns.draftTimer);
    ns.draftTimer = setTimeout(function () {
      if (ns.done) return;
      if (nsDirty()) saveDraft('ns', nsState(), 'ns-draft-note');
      else dropDraft('ns');
    }, 400);
  }

  function nsDirty() {
    if (!ns.bound) return false;
    for (var i = 0; i < NS_FIELDS.length; i++) {
      var id = NS_FIELDS[i];
      if (id === 'ns-category') continue;          // always has a value
      if (val(id)) return true;
    }
    if (ns.chips.faults && ns.chips.faults.get().length) return true;
    return NS_CHECKS.some(checked);
  }

  function nsState() {
    var fields = {}, checks = {};
    NS_FIELDS.forEach(function (id) { fields[id] = val(id); });
    // Until the technician list arrives the select is empty; keep the
    // restored choice rather than saving that emptiness over it.
    if (ns.pendingTech != null) fields['ns-tech'] = ns.pendingTech;
    NS_CHECKS.forEach(function (id) { checks[id] = checked(id); });
    return {
      rid: ns.rid, fields: fields, checks: checks,
      channel: ns.chips.channel.get(), type: ns.type.get(),
      typeTouched: ns.typeTouched, typeAuto: ns.typeAuto, categoryTouched: ns.categoryTouched,
      source: ns.chips.source.get(), faults: ns.chips.faults.get(), tool: ns.chips.tool.get(),
      auto: ns.auto, autoFor: ns.autoFor, autoBusiness: ns.autoBusiness, unsure: ns.unsure
    };
  }

  function nsRestore(st) {
    if (/^[0-9a-f-]{36}$/i.test(String(st.rid || ''))) {
      ns.rid = st.rid;
      ns.unsure = cleanUnsure(st.unsure);           // only meaningful under the same request id
    }
    ns.auto = cleanAuto(st.auto, NS_AUTO_FIELDS);
    ns.autoFor = typeof st.autoFor === 'string' ? st.autoFor : null;
    ns.autoBusiness = !!st.autoBusiness;
    var f = st.fields || {};
    NS_FIELDS.forEach(function (id) {
      if (id === 'ns-tech') return;                       // options are not loaded yet
      if (typeof f[id] === 'string') setVal(id, f[id]);
    });
    if (!$('ns-category').value) $('ns-category').value = 'repair';
    ns.pendingTech = typeof f['ns-tech'] === 'string' ? f['ns-tech'] : null;
    var c = st.checks || {};
    NS_CHECKS.forEach(function (id) { var n = $(id); if (n) n.checked = !!c[id]; });
    if (st.channel) ns.chips.channel.set(st.channel);
    if (st.type) ns.type.set(st.type);
    ns.typeTouched = !!st.typeTouched; ns.typeAuto = !!st.typeAuto; ns.categoryTouched = !!st.categoryTouched;
    ns.chips.source.set(st.source || null);
    ns.chips.faults.set(Array.isArray(st.faults) ? st.faults : []);
    ns.chips.tool.set(st.tool || null);
    nsRefreshFaults();
    nsTypeChanged();
    nsMapsStatus();
    nsSummary();
    ns.lk.refresh();
    saveDraft('ns', nsState(), null);        // the reset before this dropped it; keep it for a second reload
    setStatus('ns-status', 'Your unsent request was kept from before the page reloaded.', 'info');
  }

  function nsReset(keepCustomer, silent) {
    clearTimeout(ns.draftTimer);
    ns.rid = newRequestId();
    ns.unsure = [];
    ns.done = null;
    ns.busy = false;
    var keep = {};
    if (keepCustomer) NS_KEEP_FOR_SAME_CUSTOMER.forEach(function (id) { keep[id] = val(id); });
    var keepBusiness = keepCustomer && checked('ns-business');
    var keepChannel = keepCustomer ? ns.chips.channel.get() : null;
    NS_FIELDS.forEach(function (id) { setVal(id, keep[id] || ''); });
    NS_CHECKS.forEach(function (id) { var n = $(id); if (n) n.checked = false; });
    if (keepBusiness) $('ns-business').checked = true;
    $('ns-category').value = 'repair';
    ns.chips.channel.set(keepChannel || 'phone');
    ns.type.set('in_store');
    ns.typeTouched = false; ns.typeAuto = false; ns.categoryTouched = false;
    ns.chips.source.set(null);
    ns.chips.faults.set([]);
    ns.chips.tool.set(null);
    ns.pendingTech = null;
    // Same customer: the kept values still belong to the kept number, so the
    // record of what the lookup filled is kept with them.
    if (!keepCustomer) { ns.auto = {}; ns.autoFor = null; ns.autoBusiness = false; if (ns.lk) ns.lk.reset(); }
    markErrors($('ns-form'), [], 'ns-status');
    setStatus('ns-status', '', '');
    var btn = $('ns-submit');
    btn.disabled = false; btn.textContent = 'Create service request';
    show($('ns-type-hint'), false);
    clear($('ns-done')); show($('ns-done'), false);
    show($('ns-form'), true);
    nsRefreshFaults();
    nsTypeChanged();
    nsMapsStatus();
    nsSummary();
    dropDraft('ns');
    if (!silent) {
      nsSetMins();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      var focusId = keepCustomer ? 'ns-device' : 'ns-phone';
      setTimeout(function () { var n = $(focusId); if (n) n.focus(); }, 60);
    }
  }

  // Every lookup outcome lands here: a customer, nobody, a limited (A19)
  // answer, a failure, or the number no longer being valid.
  function nsApplyLookup(d, norm, failed) {
    if (lookupKeeps(failed, norm, ns.autoFor)) { nsSummary(); return; }
    ns.auto = withdrawAuto(ns.auto);
    if (ns.autoBusiness) { var bx = $('ns-business'); if (bx) bx.checked = false; ns.autoBusiness = false; }
    ns.autoFor = norm || null;
    var cust = (d && d.customer) || null;
    if (cust) {
      fillAuto(ns.auto, 'ns-name', cust.name);
      fillAuto(ns.auto, 'ns-email', cust.email);
      fillAuto(ns.auto, 'ns-address', cust.address);
      fillAuto(ns.auto, 'ns-area', cust.area);
      fillAuto(ns.auto, 'ns-pincode', cust.pincode);
      fillAuto(ns.auto, 'ns-landmark', cust.landmark);
      fillAuto(ns.auto, 'ns-maps', cust.maps_url);
      if (cust.kind === 'business' || cust.kind === 'trade_partner') {
        var b = $('ns-business');
        if (b && !b.checked) { b.checked = true; ns.autoBusiness = true; }
      }
    }
    nsMapsStatus();
    nsSummary();
    nsChanged();
  }

  function nsSuggestTech(email, name) {
    nsEnsureTechOption(email, name);
    $('ns-tech').value = email;
    if (!val('ns-tech-reason')) setVal('ns-tech-reason', 'Served this customer before');
    nsChanged();
    var sel = $('ns-tech');
    try { sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* old browser */ }
  }
  function nsEnsureTechOption(email, name) {
    var sel = $('ns-tech');
    var exists = Array.prototype.some.call(sel.options, function (o) { return o.value === email; });
    if (!exists) sel.appendChild(h('option', { value: email, text: name || email }));
  }

  async function loadTechs(force) {
    if (ns.techsLoading) return ns.techsLoading;
    if (!force && ns.techs && Date.now() - ns.techsAt < TECHS_MAX_AGE_MS) { nsRenderTechs(); return ns.techs; }
    var c = client();
    if (!c) return null;
    var stEl = $('ns-tech-status');
    ns.techsLoading = (async function () {
      try {
        var res = await c.rpc('service_tech_list');
        if (res.error) throw res.error;
        ns.techs = Array.isArray(res.data) ? res.data : [];
        ns.techsAt = Date.now();
        clear(stEl);
        nsRenderTechs();
      } catch (e) {
        // A suggestion restored from a draft must not vanish just because the
        // list failed: keep it as its own option (the server re-checks it).
        if (ns.pendingTech) {
          nsEnsureTechOption(ns.pendingTech, ns.pendingTech);
          $('ns-tech').value = ns.pendingTech;
          ns.pendingTech = null;
        }
        clear(stEl);
        var retry = h('button', { type: 'button', className: 'wo-mini', text: 'Try again' });
        retry.addEventListener('click', function () { loadTechs(true); });
        appendKids(stEl, ["Couldn't load the technicians: " + errText(e) + ' The request can still go to the queue. ',
          authLapsed(e) ? signInAgainBtn('new-service') : retry]);
      } finally {
        ns.techsLoading = null;
      }
    })();
    return ns.techsLoading;
  }

  function nsRenderTechs() {
    var sel = $('ns-tech');
    var want = ns.pendingTech != null ? ns.pendingTech : sel.value;
    var extra = [];
    if (want) {
      var known = (ns.techs || []).some(function (t) { return t.email === want; });
      var opt = Array.prototype.filter.call(sel.options, function (o) { return o.value === want; })[0];
      if (!known && opt) extra.push({ value: want, label: opt.textContent });
    }
    clear(sel);
    sel.appendChild(h('option', { value: '', text: 'No suggestion: whoever is free' }));
    (ns.techs || []).forEach(function (t) {
      if (!t || !t.email) return;
      var bits = [t.name || t.email];
      if (t.open_count != null) bits.push(t.open_count + ' open');
      if (t.visits_today) bits.push(t.visits_today + (Number(t.visits_today) === 1 ? ' visit today' : ' visits today'));
      sel.appendChild(h('option', { value: t.email, text: bits.join(' · ') }));
    });
    extra.forEach(function (o) { sel.appendChild(h('option', { value: o.value, text: o.label })); });
    sel.value = want && Array.prototype.some.call(sel.options, function (o) { return o.value === want; }) ? want : '';
    ns.pendingTech = null;
  }

  // Chips for the chosen device and type, through the catalogue's own
  // faultsFor() so the website offers exactly what the desktop intake offers.
  // The type filters only once the salesperson CHOSE it: a type the fault
  // suggested must not hide the other chips they may still want to tick.
  function nsFaultOptions() {
    var C = CAT();
    var kind = $('ns-kind') ? $('ns-kind').value : '';
    var type = (ns.type && ns.typeTouched) ? ns.type.get() : null;
    var picked = ns.chips.faults ? ns.chips.faults.get() : [];
    var offered = null;
    if (C && typeof C.faultsFor === 'function') {
      try { offered = C.faultsFor(kind ? [kind] : [], type); } catch (e) { console.warn('faultsFor failed', e); offered = null; }
    }
    var allow = {};
    (offered || faultList().filter(function (f) {
      return !kind || !Array.isArray(f.kinds) || !f.kinds.length || f.kinds.indexOf(kind) !== -1;
    })).forEach(function (f) { if (f && f.key) allow[f.key] = true; });
    return faultList().filter(function (f) {
      // A picked fault never disappears, whatever the filters say now.
      return f && f.key && (allow[f.key] || picked.indexOf(f.key) !== -1);
    }).map(function (f) { return { value: f.key, label: f.label || f.key }; });
  }
  // Forty chips are a long scroll on a phone, so the list opens with the
  // first few (the catalogue lists the common faults first) and a toggle;
  // a fault already picked always stays on screen.
  var FAULTS_SHORT = 12;
  function nsRefreshFaults() {
    if (!ns.chips.faults) return;
    var opts = nsFaultOptions();
    var wrap = $('ns-faults').parentNode;
    var more = $('ns-faults-more');
    if (!faultList().length) {
      // The catalogue did not load: the free text carries the fault on its own.
      show(wrap, false);
      return;
    }
    show(wrap, true);
    var picked = ns.chips.faults.get();
    var shown = opts;
    var long = opts.length > FAULTS_SHORT + 2;
    if (long && !ns.faultsAll) {
      shown = opts.filter(function (o, i) { return i < FAULTS_SHORT || picked.indexOf(o.value) !== -1; });
    }
    ns.chips.faults.setOptions(shown);
    if (more) {
      show(more, long);
      more.textContent = ns.faultsAll ? 'Show fewer' : 'Show all ' + opts.length + ' faults';
      more.setAttribute('aria-expanded', ns.faultsAll ? 'true' : 'false');
    }
  }

  function nsFaultsChanged(keys) {
    var C = CAT();
    if (!ns.categoryTouched) {
      var f = faultList().filter(function (x) { return keys.indexOf(x.key) !== -1 && x.category; })[0];
      var cat = f ? f.category : 'repair';
      if (Array.prototype.some.call($('ns-category').options, function (o) { return o.value === cat; })) $('ns-category').value = cat;
    }
    var hint = $('ns-type-hint');
    if (!ns.typeTouched) {
      var sug = null;
      if (keys.length && C && typeof C.suggestType === 'function') {
        try { sug = C.suggestType(keys); } catch (e) { console.warn('suggestType failed', e); sug = null; }
      }
      if (sug && TYPE_HELP[sug]) {
        if (sug !== ns.type.get()) { ns.type.set(sug); nsTypeChanged(); }
        ns.typeAuto = sug !== 'in_store';
        hint.textContent = sug === 'in_store' ? '' : 'Suggested from the fault: ' + typeLabel(sug) + '. Change it if that is wrong.';
        show(hint, sug !== 'in_store');
      } else if (ns.typeAuto) {
        ns.type.set('in_store'); ns.typeAuto = false; nsTypeChanged();
        show(hint, false);
      }
    }
    nsChanged();
  }

  function nsTypeChanged() {
    var t = ns.type ? ns.type.get() : 'in_store';
    show($('ns-instore-note'), t === 'in_store');
    show($('ns-onsite'), t === 'on_site');
    show($('ns-remote'), t === 'remote');
    show($('ns-when'), t === 'on_site' || t === 'remote');
    if (ns.typeTouched) show($('ns-type-hint'), false);
    var dev = $('ns-device');
    if (dev) dev.placeholder = t === 'in_store' ? 'e.g. ASUS TUF A15' : 'e.g. office printer, Dell laptop';
  }

  function nsMapsStatus() {
    var st = $('ns-maps-status');
    if (!st) return;
    var r = readMapLink(val('ns-maps'));
    st.className = 'wo-hint' + (!r.msg ? '' : (!r.ok ? ' wo-warn-text' : (r.latlng ? ' wo-ok-text' : '')));
    st.textContent = r.msg;
  }

  function nsPriority(faults, type) {
    var C = CAT();
    var lk = ns.lk ? ns.lk.data() : null;
    var machines = parseInt(val('ns-machines'), 10);
    var ctx = {
      service_type: type,
      item_purchase_source: ns.chips.source.get() || 'unknown',
      // SPEC-GAP: the website cannot see a build's warranty dates, so this
      // bump is left to the desk (a lead can raise the priority afterwards).
      built_by_us_in_warranty: false,
      repeat_within_30d: repeatWithin30(lk),
      needed_by: dayToIso(val('ns-needed')),
      business: checked('ns-business') || !!(lk && lk.customer && (lk.customer.kind === 'business' || lk.customer.kind === 'trade_partner')),
      machines: isFinite(machines) ? machines : 0
    };
    if (C && typeof C.computePriority === 'function') {
      try {
        var r = C.computePriority(faults, ctx) || {};
        var p = vocabList('PRIORITIES', FB_PRIORITIES).some(function (x) { return x.value === r.priority; }) ? r.priority : 'normal';
        return { priority: p, reasons: Array.isArray(r.reasons) ? r.reasons.filter(function (x) { return typeof x === 'string' && x; }) : [] };
      } catch (e) { console.warn('computePriority failed', e); }
    }
    return { priority: 'normal', reasons: [] };
  }

  function nsSummary() {
    var host = $('ns-summary');
    if (!host || !ns.chips.faults) return;
    clear(host);
    var C = CAT();
    var faults = ns.chips.faults.get();
    var type = ns.type.get();
    if (!faults.length) {
      if (faultList().length) host.appendChild(h('div', { className: 'wo-muted', text: 'Pick the fault to see the priority and how long it usually takes.' }));
      return;
    }
    var pr = nsPriority(faults, type);
    var pClass = ['low', 'normal', 'high', 'urgent'].indexOf(pr.priority) !== -1 ? pr.priority : 'normal';
    host.appendChild(h('div', { className: 'wo-sum-row' }, [
      h('span', { className: 'wo-sum-k', text: 'Priority' }),
      h('span', { className: 'wo-prio wo-prio-' + pClass, text: vocabLabel('PRIORITIES', FB_PRIORITIES, pr.priority) }),
      pr.reasons.length ? h('span', { className: 'wo-sum-why', text: pr.reasons.join(' · ') }) : null
    ]));
    var est = 0, checks = [];
    if (C) {
      try { est = typeof C.estMinutes === 'function' ? C.estMinutes(faults) : 0; } catch (e) { est = 0; }
      try { checks = typeof C.mergeChecklists === 'function' ? (C.mergeChecklists(faults) || []) : []; } catch (e) { checks = []; }
    }
    var bits = [];
    if (fmtMinutes(est)) bits.push('Usually about ' + fmtMinutes(est));
    if (checks.length) bits.push(checks.length + (checks.length === 1 ? ' check' : ' checks') + ' for the technician');
    if (bits.length) host.appendChild(h('div', { className: 'wo-sum-row wo-muted', text: bits.join(' · ') }));
    host.appendChild(h('div', { className: 'wo-sum-note', text: 'Set from the fault. A lead can change the priority after it is created.' }));
  }

  // Reads the form → {payload, errors}. Only fields that belong to the chosen
  // type are sent, so switching On-site → Remote does not leak an address into
  // a remote ticket.
  function nsCollect() {
    var errors = [];
    function err(id, msg) { errors.push({ id: id, msg: msg }); }

    var phoneRaw = val('ns-phone');
    var phone = phoneOut(phoneRaw);
    if (!isValidPhone(phoneRaw)) err('ns-phone', 'Enter ' + PHONE_HELP + '.');
    var name = val('ns-name');
    if (!name) err('ns-name', "Enter the customer's name.");
    var email = val('ns-email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err('ns-email', "That email doesn't look right. Fix it or leave it empty.");

    var type = ns.type.get();
    var channel = ns.chips.channel.get() || 'phone';
    var faults = ns.chips.faults.get();
    var faultText = val('ns-fault-text');
    if (!faults.length && !faultText) {
      err('ns-fault-text', faultList().length ? 'Pick a fault, or write what the customer said.' : 'Write what the customer said is wrong.');
    }
    var category = $('ns-category').value || 'repair';

    var neededIso = null;
    var nd = val('ns-needed');
    if (nd) {
      neededIso = dayToIso(nd);
      if (!neededIso) err('ns-needed', "That date isn't valid.");
      else if (Date.parse(neededIso) < Date.now()) err('ns-needed', 'The "needs it by" date has already passed.');
    }

    var kind = $('ns-kind').value;
    var label = val('ns-device');
    var source = ns.chips.source.get();
    var item = (kind || label || source)
      ? compact({ kind: kind || 'other', label: label, purchase_source: source || 'unknown' })
      : null;

    var p = {
      client_request_id: ns.rid,
      service_type: type,
      channel: channel,
      category: category,
      fault_keys: faults,
      // Old (v1.9.11) desktop clients read only reported_fault, so a request
      // made from chips alone still has to say the fault in words.
      reported_fault: faultText || faults.map(faultLabel).join(', '),
      customer_name: name,
      customer_phone: phone,
      customer_email: email,
      needed_by: neededIso,
      in_hand: false,
      items: item ? [item] : []
    };

    if (type === 'on_site') {
      var addr = val('ns-address'), area = val('ns-area'), pin = val('ns-pincode');
      if (!addr && !area) err('ns-address', 'Enter the address, or at least the area, so the technician knows where to go.');
      if (pin && !/^\d{6}$/.test(pin)) err('ns-pincode', 'A pincode is 6 digits.');
      var map = readMapLink(val('ns-maps'));
      if (!map.ok) err('ns-maps', map.msg);
      var machines = val('ns-machines');
      if (machines && !(/^\d+$/.test(machines) && +machines >= 1 && +machines <= 500)) err('ns-machines', 'Machines should be a number from 1 to 500.');
      p.site_address = addr;
      p.site_area = area;
      p.site_pincode = pin;
      p.site_landmark = val('ns-landmark');
      p.site_maps_url = map.ok ? map.url : null;
      if (map.ok && map.latlng) { p.site_lat = map.latlng.lat; p.site_lng = map.latlng.lng; }
      p.site_contact = val('ns-contact');
      // The box only shows on an on-site request. The server records the
      // customer as a business (it only ever raises 'person'), so the next
      // lookup ticks it on its own and the priority bump is not lost.
      if (checked('ns-business')) p.business = true;
    }
    if (type === 'remote') {
      p.remote_tool = ns.chips.tool.get();
      p.remote_session_ref = val('ns-session');
      if (checked('ns-consent')) p.remote_consent_at = new Date().toISOString();
    }
    if (type === 'on_site' || type === 'remote') {
      var fromV = val('ns-win-from'), toV = val('ns-win-to');
      var from = fromV ? parseLocalInput(fromV) : null, to = toV ? parseLocalInput(toV) : null;
      if (fromV && !from) err('ns-win-from', "That start time isn't valid.");
      if (toV && !to) err('ns-win-to', "That end time isn't valid.");
      if (from && to && to.getTime() <= from.getTime()) err('ns-win-to', 'The window has to end after it starts.');
      if (to && to.getTime() < Date.now()) err('ns-win-to', 'That window has already passed.');
      else if (!to && from && from.getTime() < Date.now() - 30 * 60000) err('ns-win-from', 'That start time has already passed.');
      p.window_start = from ? from.toISOString() : null;
      p.window_end = to ? to.toISOString() : null;
      p.window_note = val('ns-win-note');
    }

    var tech = $('ns-tech').value;
    if (tech) {
      p.suggested_tech_email = tech;
      p.suggest_reason = val('ns-tech-reason');
    }

    var pr = nsPriority(faults, type);
    p.priority = pr.priority;
    p.priority_reason = pr.reasons.join('; ');
    var C = CAT();
    if (faults.length && C && typeof C.estMinutes === 'function') {
      try { var est = Math.round(Number(C.estMinutes(faults))); if (est > 0) p.est_minutes = est; } catch (e) { /* optional */ }
    }
    return { payload: compact(p), errors: errors };
  }

  async function nsSubmit() {
    if (ns.busy || ns.done) return;
    var root = $('ns-form');
    var c = nsCollect();
    markErrors(root, c.errors, 'ns-status');
    if (c.errors.length) return;
    var cli = client();
    if (!cli) { setStatus('ns-status', "Couldn't reach the server. Reload the page and try again.", 'err'); return; }

    // Bind the request id on the first line: a "Start over" pressed while this
    // is in flight mints a new one, and this answer belongs to the old one.
    var rid = c.payload.client_request_id;
    var btn = $('ns-submit');
    ns.busy = true;
    btn.disabled = true;
    btn.textContent = 'Creating…';
    setStatus('ns-status', 'Creating the request…', 'busy');
    try {
      var res = await cli.rpc('service_create', { p: c.payload });
      if (res.error) throw res.error;
      if (ns.rid !== rid) return;                     // the form was reset meanwhile
      var data = res.data || {};
      if (!data.public_code) throw new Error('The server did not send back a tracking code. Check My requests before trying again.');
      // A replay returns the ticket an earlier try made, holding what THAT
      // try sent; a fresh create holds exactly this payload.
      var replay = data.duplicate ? settleReplay(ns.unsure, c.payload, function (p) { return normPhone(p.customer_phone); }) : null;
      ns.done = { res: data, payload: replay ? replay.payload : c.payload, replay: replay };
      ns.unsure = [];
      clearTimeout(ns.draftTimer);
      dropDraft('ns');
      nsRenderDone();
    } catch (e) {
      if (ns.rid !== rid) return;
      if (outcomeUnknown(e)) rememberUnsure(ns.unsure, c.payload);
      else if (provesNoneLanded(e)) ns.unsure = [];
      saveDraft('ns', nsState(), null);              // keep the request id (and the unsure tries) over a reload
      setStatusErr('ns-status', e, 'Nothing you typed was lost; press Create again when ready — it never makes a second request.', 'new-service');
    } finally {
      if (ns.rid === rid) {
        ns.busy = false;
        if (!ns.done) { btn.disabled = false; btn.textContent = 'Create service request'; }
      }
    }
  }

  function nsWaText(p, code) {
    var job = {
      public_code: code, customer_name: p.customer_name, customer_phone: p.customer_phone,
      service_type: p.service_type, channel: p.channel, category: p.category, stage: 'logged',
      device_label: (p.items && p.items[0] && p.items[0].label) || null,
      site_area: p.site_area || null,
      window_start: p.window_start || null, window_end: p.window_end || null, window_note: p.window_note || null
    };
    var C = CAT();
    if (C && C.WA_TEMPLATES && typeof C.WA_TEMPLATES.created === 'function') {
      try { var t = C.WA_TEMPLATES.created(job); if (t) return capText(t); } catch (e) { console.warn('WA template failed', e); }
    }
    var what = p.service_type === 'on_site' ? 'on-site service request' : p.service_type === 'remote' ? 'remote support request' : 'service request';
    return capText(greeting(p.customer_name) + '\nThank you for choosing Neo Tokyo. We have logged your ' + what +
      (job.device_label ? ' for your ' + job.device_label : '') + '.\n' +
      'Code: ' + code + '\nTrack it here: ' + trackUrl(code) + '\n' +
      'Use the last 4 digits of this phone number to open it.\n— Neo Tokyo');
  }

  function nsRenderDone() {
    var host = $('ns-done');
    var d = ns.done.res, p = ns.done.payload;
    var code = String(d.public_code);
    clear(host);
    var fb = h('div', { className: 'wo-wa-fallback hidden' });

    var replay = ns.done.replay || null;
    host.appendChild(h('h3', { className: 'wo-done-title', tabindex: '-1', text: d.duplicate ? 'This request was already created' : 'Service request created' }));
    if (d.duplicate) {
      host.appendChild(h('p', { className: 'wo-hint', text: 'Your first try reached us even though the answer did not come back. No second ticket was made. Here is its code.' }));
      var rn = replayNote(replay);
      if (rn) host.appendChild(rn);
    }
    host.appendChild(h('div', { className: 'wo-code-row' }, [
      h('span', { className: 'wo-code mono', text: code }),
      copyBtn('Copy code', code)
    ]));
    var link = trackUrl(code);
    host.appendChild(h('div', { className: 'wo-link-row' }, [
      h('a', { className: 'wo-link mono', href: link, target: '_blank', rel: 'noopener noreferrer', text: link }),
      copyBtn('Copy link', link)
    ]));
    if (!(replay && replay.phoneUnsure)) {
      host.appendChild(h('p', { className: 'wo-hint', text: 'The customer opens it with the last 4 digits of ' + fmtPhone(p.customer_phone) + '.' }));
    }

    var facts = [];
    if (d.stage) facts.push(staffStage(d.stage));
    facts.push(typeLabel(p.service_type));
    if (p.suggested_tech_email) {
      var opt = Array.prototype.filter.call($('ns-tech').options, function (o) { return o.value === p.suggested_tech_email; })[0];
      var tn = opt ? opt.textContent.split(' · ')[0] : p.suggested_tech_email;
      facts.push('In the queue, suggested for ' + tn);
    } else {
      facts.push('In the queue for the next free technician');
    }
    host.appendChild(h('p', { className: 'wo-done-facts', text: facts.join(' · ') }));

    var same = Array.isArray(d.open_same_phone) ? d.open_same_phone : [];
    if (same.length) {
      var box = h('div', { className: 'wo-dup' }, [h('div', { className: 'wo-dup-title', text: 'This customer has other open tickets' })]);
      same.slice(0, 6).forEach(function (j) {
        box.appendChild(h('div', { className: 'wo-dup-row' }, [
          h('span', { className: 'mono', text: j.public_code || '—' }),
          ' ' + [staffStage(j.stage), typeLabel(j.service_type)].join(' · ')
        ]));
      });
      box.appendChild(h('div', { className: 'wo-dup-note', text: 'If one of them is the same problem, tell the shop so they can close the duplicate.' }));
      host.appendChild(box);
    }

    var acts = h('div', { className: 'wo-done-actions' });
    if (!(replay && replay.phoneUnsure)) {
      acts.appendChild(waButton('Message on WhatsApp', p.customer_phone, function () { return nsWaText(p, code); }, fb));
    }
    var again = h('button', { type: 'button', className: 'btn-ghost', text: 'Another request for this customer' });
    again.addEventListener('click', function () { nsReset(true); });
    var fresh = h('button', { type: 'button', className: 'btn-ghost', text: 'New request' });
    fresh.addEventListener('click', function () { nsReset(false); });
    var mine = h('button', { type: 'button', className: 'btn-ghost', text: 'My requests' });
    mine.addEventListener('click', function () { activateView('my-requests'); });
    appendKids(acts, [again, fresh, mine]);
    host.appendChild(acts);
    host.appendChild(fb);

    show($('ns-form'), false);
    show(host, true);
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    focusDone(host);
  }

  // ═════════════════════════════════ NEW RMA ═════════════════════════════════
  var nr = {
    bound: false, rid: null, busy: false, done: null,
    units: [], uidSeq: 0, chips: {}, lk: null, draftTimer: null,
    // What the lookup filled (name, return address) and for which number, and
    // whether it switched the sender to a trade partner (see withdrawAuto).
    auto: {}, autoFor: null, autoSender: false,
    unsure: []
  };
  var NR_FIELDS = ['nr-phone', 'nr-name', 'nr-courier-name', 'nr-awb', 'nr-return-address', 'nr-notes'];
  var NR_AUTO_FIELDS = ['nr-name', 'nr-return-address'];
  var UNIT_FIELDS = ['kind', 'brand', 'model', 'serial', 'fault', 'diagnosed_by', 'invoice_no', 'purchase_date', 'owner_name', 'owner_phone'];

  function nrSender() { return (nr.chips.sender && nr.chips.sender.get()) || 'customer'; }
  function nrNewUnit() {
    var u = { uid: 'u' + (++nr.uidSeq), diagTouched: false, purchase_source: null };
    UNIT_FIELDS.forEach(function (f) { u[f] = ''; });
    u.diagnosed_by = DIAG_DEFAULT[nrSender()] || 'customer';
    return u;
  }
  function unitFieldId(u, f) { return 'nr-u-' + u.uid + '-' + f; }

  function nrBind() {
    if (nr.bound) return true;
    var root = $('nr-form');
    if (!root) return false;
    nr.bound = true;

    nr.chips.sender = chipGroup($('nr-sender-kind'), WEB_SENDERS.map(function (s) {
      return { value: s.value, label: s.label };
    }), {
      value: 'customer',
      // A sender picked by hand is theirs: a later number change never undoes it.
      onChange: function (v) { nr.autoSender = false; nrSenderChanged(v); }
    });
    nr.chips.arrival = chipGroup($('nr-arrival'), ARRIVALS, { value: 'walk_in', onChange: nrArrivalChanged });
    nr.chips.ret = chipGroup($('nr-return'), RETURNS, { value: 'collect', onChange: nrReturnChanged });

    nr.lk = makeLookup($('nr-phone'), $('nr-lookup'), {
      view: 'new-rma',
      paint: function (panel, d) { paintLookup(panel, d, {}); },
      onResult: nrApplyLookup
    });

    enterGuard(root);
    unmarkOnInput(root);
    root.addEventListener('input', nrChanged);
    root.addEventListener('change', nrChanged);

    var unitsHost = $('nr-units');
    unitsHost.addEventListener('input', nrUnitInput);
    unitsHost.addEventListener('change', nrUnitInput);
    unitsHost.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.wo-unit-remove') : null;
      if (!b) return;
      var uid = b.dataset.uid;
      var u = nr.units.filter(function (x) { return x.uid === uid; })[0];
      if (!u) return;
      var hasContent = UNIT_FIELDS.some(function (f) { return f !== 'diagnosed_by' && u[f]; }) || u.purchase_source;
      if (hasContent && !confirm('Remove this part from the list?')) return;
      nr.units = nr.units.filter(function (x) { return x.uid !== uid; });
      nrRenderUnits();
      nrChanged();
    });
    $('nr-add-unit').addEventListener('click', function () {
      if (nr.units.length >= MAX_UNITS) {
        setStatus('nr-status', 'One RMA can hold up to ' + MAX_UNITS + ' parts. Log the rest as a second RMA.', 'err');
        return;
      }
      var u = nrNewUnit();
      nr.units.push(u);
      nrRenderUnits();
      nrChanged();
      var k = $(unitFieldId(u, 'kind'));
      if (k) { try { k.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* old browser */ } k.focus(); }
    });
    $('nr-submit').addEventListener('click', nrSubmit);
    $('nr-clear').addEventListener('click', function () {
      if (nr.busy) { setStatus('nr-status', 'Wait for this RMA to finish logging first.', 'busy'); return; }
      if (!nr.done && nrDirty() && !confirm('Clear this RMA and start again? Nothing has been sent yet.')) return;
      nrReset(false);
    });

    var draft = loadDraft('nr');             // before nrReset(), which drops it
    nrReset(true);
    if (draft) nrRestore(draft);
    return true;
  }

  function showNewRma() {
    if (!nrBind()) return;
    nrSetMins();
    if (nr.done) { show($('nr-form'), false); show($('nr-done'), true); }
  }
  function nrSetMins() {
    var today = localDay(new Date());
    nr.units.forEach(function (u) { var n = $(unitFieldId(u, 'purchase_date')); if (n) n.max = today; });
  }

  function nrChanged() {
    if (!nr.bound || nr.done) return;
    clearTimeout(nr.draftTimer);
    nr.draftTimer = setTimeout(function () {
      if (nr.done) return;
      if (nrDirty()) saveDraft('nr', nrState(), 'nr-draft-note');
      else dropDraft('nr');
    }, 400);
  }
  function nrDirty() {
    if (!nr.bound) return false;
    if (NR_FIELDS.some(function (id) { return !!val(id); })) return true;
    return nr.units.some(function (u) {
      return u.purchase_source || UNIT_FIELDS.some(function (f) { return f !== 'diagnosed_by' && u[f]; });
    });
  }
  function nrState() {
    var fields = {};
    NR_FIELDS.forEach(function (id) { fields[id] = val(id); });
    return {
      rid: nr.rid, fields: fields,
      sender: nr.chips.sender.get(), arrival: nr.chips.arrival.get(), ret: nr.chips.ret.get(),
      units: nr.units.map(function (u) {
        var o = { diagTouched: !!u.diagTouched, purchase_source: u.purchase_source };
        UNIT_FIELDS.forEach(function (f) { o[f] = u[f]; });
        return o;
      }),
      auto: nr.auto, autoFor: nr.autoFor, autoSender: nr.autoSender, unsure: nr.unsure
    };
  }
  function nrRestore(st) {
    if (/^[0-9a-f-]{36}$/i.test(String(st.rid || ''))) {
      nr.rid = st.rid;
      nr.unsure = cleanUnsure(st.unsure);
    }
    nr.auto = cleanAuto(st.auto, NR_AUTO_FIELDS);
    nr.autoFor = typeof st.autoFor === 'string' ? st.autoFor : null;
    nr.autoSender = !!st.autoSender;
    var f = st.fields || {};
    NR_FIELDS.forEach(function (id) { if (typeof f[id] === 'string') setVal(id, f[id]); });
    if (st.sender) nr.chips.sender.set(st.sender);
    if (st.arrival) nr.chips.arrival.set(st.arrival);
    if (st.ret) nr.chips.ret.set(st.ret);
    var units = Array.isArray(st.units) ? st.units.slice(0, MAX_UNITS) : [];
    if (units.length) {
      nr.units = units.map(function (s) {
        var u = nrNewUnit();
        UNIT_FIELDS.forEach(function (fld) { if (typeof s[fld] === 'string') u[fld] = s[fld]; });
        u.diagTouched = !!s.diagTouched;
        u.purchase_source = typeof s.purchase_source === 'string' ? s.purchase_source : null;
        return u;
      });
    }
    nrSenderChanged(nrSender(), true);
    nrArrivalChanged();
    nrReturnChanged();
    nrRenderUnits();
    nr.lk.refresh();
    saveDraft('nr', nrState(), null);        // the reset before this dropped it; keep it for a second reload
    setStatus('nr-status', 'Your unsent RMA was kept from before the page reloaded.', 'info');
  }

  function nrReset(silent) {
    clearTimeout(nr.draftTimer);
    nr.rid = newRequestId();
    nr.unsure = [];
    nr.done = null;
    nr.busy = false;
    NR_FIELDS.forEach(function (id) { setVal(id, ''); });
    nr.chips.sender.set('customer');
    nr.chips.arrival.set('walk_in');
    nr.chips.ret.set('collect');
    nr.auto = {}; nr.autoFor = null; nr.autoSender = false;
    if (nr.lk) nr.lk.reset();
    nr.units = [nrNewUnit()];
    nrSenderChanged('customer', true);
    nrArrivalChanged();
    nrReturnChanged();
    nrRenderUnits();
    markErrors($('nr-form'), [], 'nr-status');
    setStatus('nr-status', '', '');
    var btn = $('nr-submit');
    btn.disabled = false; btn.textContent = 'Log RMA';
    clear($('nr-done')); show($('nr-done'), false);
    show($('nr-form'), true);
    dropDraft('nr');
    if (!silent) {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      setTimeout(function () { var n = $('nr-phone'); if (n) n.focus(); }, 60);
    }
  }

  function nrSenderChanged(kind, noSave) {
    kind = kind || nrSender();
    var lbl = $('nr-name-label');
    if (lbl) lbl.textContent = kind === 'third_party_tech' ? "Shop or technician's name" : "Customer's name";
    var nm = $('nr-name');
    if (nm) nm.placeholder = kind === 'third_party_tech' ? 'e.g. Sreekumar Computers, Thrissur' : 'Customer name';
    nr.units.forEach(function (u) { if (!u.diagTouched) u.diagnosed_by = DIAG_DEFAULT[kind] || 'customer'; });
    nrRenderUnits();
    if (!noSave) nrChanged();
  }
  function nrArrivalChanged() { show($('nr-courier'), nr.chips.arrival.get() === 'courier'); nrChanged(); }
  function nrReturnChanged() {
    var courier = nr.chips.ret.get() === 'courier';
    show($('nr-return-address-wrap'), courier);
    if (courier) nrPrefillReturnAddress();
    nrChanged();
  }
  function nrPrefillReturnAddress() {
    var d = nr.lk ? nr.lk.data() : null;
    var c = d && d.customer;
    if (!c || !c.address) return;
    var addr = [c.address, c.area, c.pincode].filter(function (x) { return x; }).join(', ');
    fillAuto(nr.auto, 'nr-return-address', addr);
  }
  // Every lookup outcome lands here, as for the service form: what the last
  // number's lookup filled is taken back first (name, return address, and the
  // trade-partner sender switch), then the new customer's values go in.
  function nrApplyLookup(d, norm, failed) {
    if (lookupKeeps(failed, norm, nr.autoFor)) return;
    nr.auto = withdrawAuto(nr.auto);
    if (nr.autoSender) {
      nr.autoSender = false;
      if (nrSender() === 'third_party_tech') { nr.chips.sender.set('customer'); nrSenderChanged('customer', true); }
    }
    nr.autoFor = norm || null;
    var c = d && d.customer;
    if (c) {
      fillAuto(nr.auto, 'nr-name', c.name);
      if (c.kind === 'trade_partner' && nrSender() === 'customer' && !nr.units.some(function (u) { return u.diagTouched; })) {
        // A trade partner calling about a part is almost always sending it for
        // their own customer.
        nr.chips.sender.set('third_party_tech');
        nrSenderChanged('third_party_tech', true);
        nr.autoSender = true;
      }
    }
    if (nr.chips.ret.get() === 'courier') nrPrefillReturnAddress();
    nrChanged();
  }

  function feeFor(kind) {
    var C = CAT();
    if (C && typeof C.handlingFee === 'function') {
      try {
        var amt = Number(C.handlingFee(kind));
        if (isFinite(amt) && amt >= 0) return { amount: amt, fromCatalog: true };
      } catch (e) { console.warn('handlingFee failed', e); }
    }
    if (C) {
      var by = C.HANDLING_FEE_BY_KIND || {};
      if (kind && by[kind] != null && isFinite(Number(by[kind]))) return { amount: Number(by[kind]), fromCatalog: true };
      if (C.DEFAULT_HANDLING_FEE != null && isFinite(Number(C.DEFAULT_HANDLING_FEE))) return { amount: Number(C.DEFAULT_HANDLING_FEE), fromCatalog: true };
    }
    return { amount: 300, fromCatalog: false };      // the SQL default when no fee is sent
  }
  function feeNoteText(u) {
    var f = feeFor(u.kind);
    return 'Paid handling service: ₹' + Math.round(f.amount).toLocaleString('en-IN') +
      '. The customer\'s purchase invoice is needed before we can send it to the manufacturer.';
  }

  function nrRenderUnits() {
    var host = $('nr-units');
    if (!host) return;
    clear(host);
    var kinds = vocabList('ITEM_KINDS', FB_ITEM_KINDS);
    var sources = vocabList('PURCHASE_SOURCES', FB_SOURCES);
    var third = nrSender() === 'third_party_tech';
    var today = localDay(new Date());
    nr.units.forEach(function (u, i) {
      function input(f, props, tag) {
        var p = Object.assign({ id: unitFieldId(u, f), className: 'wo-input', dataset: { f: f }, autocomplete: 'off' }, props || {});
        var n = h(tag || 'input', p);
        n.value = u[f] || '';
        return n;
      }
      function field(labelText, control, extraClass) {
        return h('label', { className: 'wo-field' + (extraClass ? ' ' + extraClass : '') }, [h('span', { className: 'wo-flabel', text: labelText }), control]);
      }
      var kindSel = h('select', { id: unitFieldId(u, 'kind'), className: 'wo-input', dataset: { f: 'kind' } });
      kindSel.appendChild(h('option', { value: '', text: 'Choose…' }));
      kinds.forEach(function (k) { kindSel.appendChild(h('option', { value: k.value, text: k.label })); });
      kindSel.value = u.kind || '';
      var diagSel = h('select', { id: unitFieldId(u, 'diagnosed_by'), className: 'wo-input', dataset: { f: 'diagnosed_by' } });
      DIAG_BY.forEach(function (o) { diagSel.appendChild(h('option', { value: o.value, text: o.label })); });
      diagSel.value = u.diagnosed_by || 'customer';

      var srcHost = h('div', { id: unitFieldId(u, 'purchase_source'), className: 'wo-chips', role: 'group', 'aria-label': 'Where was part ' + (i + 1) + ' bought?', tabindex: '-1' });
      var buyBlock = h('div', { className: 'wo-grid2' + (u.purchase_source === 'neo_tokyo' || u.purchase_source === 'elsewhere' ? '' : ' hidden'), dataset: { block: 'buy' } }, [
        field('Invoice number (optional)', input('invoice_no', { maxlength: '60', placeholder: 'From their bill' })),
        field('Purchase date (optional)', input('purchase_date', { type: 'date', max: today }))
      ]);
      var feeNote = h('div', { className: 'wo-fee' + (u.purchase_source === 'elsewhere' ? '' : ' hidden'), dataset: { block: 'fee' }, text: feeNoteText(u) });

      var removeBtn = nr.units.length > 1
        ? h('button', { type: 'button', className: 'wo-mini wo-unit-remove', dataset: { uid: u.uid }, 'aria-label': 'Remove part ' + (i + 1), text: 'Remove' })
        : null;

      var card = h('div', { className: 'wo-unit', dataset: { uid: u.uid } }, [
        h('div', { className: 'wo-unit-head' }, [h('span', { className: 'wo-unit-title', text: 'Part ' + (i + 1) }), removeBtn]),
        h('div', { className: 'wo-grid3' }, [
          field('What is it?', kindSel),
          field('Brand', input('brand', { maxlength: '60', placeholder: 'e.g. Corsair' })),
          field('Model', input('model', { maxlength: '120', placeholder: 'e.g. RM750e' }))
        ]),
        field('Serial (as printed on the label, optional)', input('serial', { maxlength: '80', placeholder: 'Needed before it can ship to the vendor', spellcheck: 'false' })),
        field("What's wrong with it?", input('fault', { rows: '2', maxlength: '1000', placeholder: 'e.g. Clicks and shuts down under load' }, 'textarea')),
        field('Who found the fault?', diagSel),
        h('div', { className: 'wo-field' }, [h('span', { className: 'wo-flabel', text: 'Where was it bought?' }), srcHost]),
        buyBlock,
        feeNote,
        third ? h('div', { className: 'wo-owner' }, [
          h('div', { className: 'wo-owner-title', text: 'End customer (optional)' }),
          h('p', { className: 'wo-hint', text: "If you add the end customer's phone, tracking updates for this part go to them instead of the sender." }),
          h('div', { className: 'wo-grid2' }, [
            field('Name', input('owner_name', { maxlength: '120' })),
            field('Phone', input('owner_phone', { type: 'tel', inputmode: 'tel', maxlength: '20', placeholder: 'Mobile, or with the country code' }))
          ])
        ]) : null
      ]);
      host.appendChild(card);

      chipGroup(srcHost, sources, {
        value: u.purchase_source,
        onChange: function (v) {
          u.purchase_source = v;
          srcHost.classList.remove('wo-invalid');
          buyBlock.classList.toggle('hidden', !(v === 'neo_tokyo' || v === 'elsewhere'));
          feeNote.textContent = feeNoteText(u);
          feeNote.classList.toggle('hidden', v !== 'elsewhere');
          nrChanged();
        }
      });
    });
    var add = $('nr-add-unit');
    if (add) add.disabled = nr.units.length >= MAX_UNITS;
  }

  function nrUnitInput(e) {
    var t = e.target;
    if (!t || !t.dataset || !t.dataset.f) return;
    var card = t.closest('.wo-unit');
    if (!card) return;
    var u = nr.units.filter(function (x) { return x.uid === card.dataset.uid; })[0];
    if (!u) return;
    var f = t.dataset.f;
    if (UNIT_FIELDS.indexOf(f) === -1) return;
    u[f] = String(t.value == null ? '' : t.value);
    if (f === 'diagnosed_by') u.diagTouched = true;
    if (f === 'kind') {
      var note = card.querySelector('[data-block="fee"]');
      if (note) note.textContent = feeNoteText(u);
    }
  }

  function nrCollect() {
    var errors = [];
    function err(id, msg) { errors.push({ id: id, msg: msg }); }
    var sender = nrSender();
    var phoneRaw = val('nr-phone');
    if (!isValidPhone(phoneRaw)) err('nr-phone', "Enter the sender's phone: " + PHONE_HELP + '.');
    var name = val('nr-name');
    if (!name) err('nr-name', sender === 'third_party_tech' ? "Enter the shop or technician's name." : "Enter the customer's name.");
    var arrival = nr.chips.arrival.get() || 'walk_in';
    var ret = nr.chips.ret.get() || 'collect';
    var retAddr = val('nr-return-address');
    if (ret === 'courier' && !retAddr) err('nr-return-address', 'Enter the address to courier it back to.');
    var today = localDay(new Date());

    var units = nr.units.map(function (u, i) {
      var n = i + 1;
      if (!u.kind) err(unitFieldId(u, 'kind'), 'Choose what part ' + n + ' is.');
      if (!String(u.brand).trim() && !String(u.model).trim()) err(unitFieldId(u, 'brand'), 'Enter the brand or model of part ' + n + '.');
      if (!String(u.fault).trim()) err(unitFieldId(u, 'fault'), "Say what's wrong with part " + n + '.');
      if (!u.purchase_source) err(unitFieldId(u, 'purchase_source'), 'Say where part ' + n + ' was bought (Not sure is fine).');
      var pd = String(u.purchase_date || '').trim();
      if (pd && (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || pd > today)) err(unitFieldId(u, 'purchase_date'), 'The purchase date of part ' + n + " can't be in the future.");
      var useOwner = sender === 'third_party_tech';
      var op = useOwner ? String(u.owner_phone || '').trim() : '';
      if (op && !isValidPhone(op)) err(unitFieldId(u, 'owner_phone'), "The end customer's phone for part " + n + ' should be ' + PHONE_HELP + '.');
      var bought = u.purchase_source === 'neo_tokyo' || u.purchase_source === 'elsewhere';
      var unit = compact({
        kind: u.kind,
        brand: String(u.brand).trim(),
        model: String(u.model).trim(),
        serial: String(u.serial).trim(),
        fault: String(u.fault).trim(),
        diagnosed_by: u.diagnosed_by || DIAG_DEFAULT[sender] || 'customer',
        purchase_source: u.purchase_source,
        invoice_no: bought ? String(u.invoice_no).trim() : '',
        purchase_date: bought ? pd : '',
        owner_name: useOwner ? String(u.owner_name || '').trim() : '',
        owner_phone: op ? phoneOut(op) : ''
      });
      if (u.purchase_source === 'elsewhere') {
        var fee = feeFor(u.kind);
        if (fee.fromCatalog) unit.handling_fee = fee.amount;    // else the server's own default applies
      }
      return unit;
    });

    var p = compact({
      client_request_id: nr.rid,
      source: arrival,
      sender_kind: sender,
      sender_name: name,
      sender_phone: phoneOut(phoneRaw),
      inbound_courier: arrival === 'courier' ? val('nr-courier-name') : '',
      inbound_awb: arrival === 'courier' ? val('nr-awb') : '',
      return_method: ret,
      return_address: ret === 'courier' ? retAddr : '',
      notes: val('nr-notes')
    });
    p.in_hand = false;          // only the desk can say a part is physically here
    p.units = units;
    return { payload: p, errors: errors };
  }

  async function nrSubmit() {
    if (nr.busy || nr.done) return;
    var root = $('nr-form');
    var c = nrCollect();
    markErrors(root, c.errors, 'nr-status');
    if (c.errors.length) return;
    var cli = client();
    if (!cli) { setStatus('nr-status', "Couldn't reach the server. Reload the page and try again.", 'err'); return; }
    var rid = c.payload.client_request_id;
    var btn = $('nr-submit');
    nr.busy = true;
    btn.disabled = true;
    btn.textContent = 'Logging…';
    setStatus('nr-status', 'Logging the RMA…', 'busy');
    try {
      var res = await cli.rpc('rma_create', { p: c.payload });
      if (res.error) throw res.error;
      if (nr.rid !== rid) return;
      var data = res.data || {};
      var codes = Array.isArray(data.units) ? data.units.filter(function (x) { return x && x.public_code; }) : [];
      // SPEC-GAP: §2.10 says rma_create is idempotent but not what a replay
      // returns. A replay without the unit list is still a success (nothing was
      // logged twice); retrying would only get the same answer forever.
      if (!codes.length && !data.duplicate) throw new Error('The server did not send back any RM codes. Check My requests before trying again.');
      // Same replay rule as the service form: the parts that exist are the
      // ones an earlier try sent, not an edited form.
      var replay = data.duplicate ? settleReplay(nr.unsure, c.payload, function (p) {
        return [normPhone(p.sender_phone)].concat((Array.isArray(p.units) ? p.units : []).map(function (u) {
          return u && u.owner_phone ? normPhone(u.owner_phone) : '';
        })).join('|');
      }) : null;
      nr.done = { res: data, payload: replay ? replay.payload : c.payload, replay: replay };
      nr.unsure = [];
      clearTimeout(nr.draftTimer);
      dropDraft('nr');
      nrRenderDone();
    } catch (e) {
      if (nr.rid !== rid) return;
      if (outcomeUnknown(e)) rememberUnsure(nr.unsure, c.payload);
      else if (provesNoneLanded(e)) nr.unsure = [];
      saveDraft('nr', nrState(), null);
      setStatusErr('nr-status', e, 'Nothing you typed was lost; press Log RMA again when ready — it never logs anything twice.', 'new-rma');
    } finally {
      if (nr.rid === rid) {
        nr.busy = false;
        if (!nr.done) { btn.disabled = false; btn.textContent = 'Log RMA'; }
      }
    }
  }

  // SPEC-GAP: WA_TEMPLATES.rma_received says the part has REACHED us, which is
  // false for a unit the website logs (always "Expected"). This message says
  // what is true: the claim is logged, and how to get the part to us.
  function nrWaText(p, rows, toName, isSender) {
    // Same shape as NeoQcCatalog.WA_TEMPLATES: greeting, body, code + link +
    // phone-digits footer, shop sign-off.
    var head = greeting(toName) + '\nThank you for choosing Neo Tokyo. We have logged your warranty claim' +
      (rows.length > 1 ? 's' : '') + ':';
    var how;
    if (!isSender) {
      // An end customer: their technician is the one sending the part.
      how = (p.sender_name || 'Your technician') + ' is sending it to us. This page shows where it is at every step.';
    } else if (p.source === 'courier') {
      how = rows.length > 1 ? 'Write each code on its part when you pack the box.' : 'Write the code on the box when you send it.';
    } else {
      how = rows.length > 1 ? 'Bring the parts to the shop and quote the codes.' : 'Bring the part to the shop and quote the code.';
    }
    if (isSender && rows.some(function (r) { return r.owned; })) {
      how += ' Parts marked "end customer" are tracked with the end customer\'s phone.';
    }
    // The link must be one THIS reader can open: a part tracked with an end
    // customer's phone would refuse the sender's digits.
    var mine = rows.filter(function (r) { return !isSender || !r.owned; })[0];
    var tail = mine
      ? 'Track it here: ' + trackUrl(mine.code) + '\nUse the last 4 digits of this phone number to open it.\n— Neo Tokyo'
      : 'Each end customer can follow their part with their own phone number.\n— Neo Tokyo';
    var lines = [];
    var budget = 600 - head.length - how.length - tail.length - 8;
    for (var i = 0; i < rows.length; i++) {
      var lab = String(rows[i].label || 'Part');
      if (lab.length > 60) lab = lab.slice(0, 59).trim() + '…';
      var line = '- ' + lab + ': ' + rows[i].code + (isSender && rows[i].owned ? ' (end customer)' : '');
      if (budget - line.length - 1 < 40 && i < rows.length - 1) {
        lines.push('- and ' + (rows.length - i) + ' more parts, each with its own code (ask us for them)');
        break;
      }
      lines.push(line);
      budget -= line.length + 1;
    }
    return capText(head + '\n' + lines.join('\n') + '\n' + how + '\n' + tail);
  }

  function nrRenderDone() {
    var host = $('nr-done');
    var d = nr.done.res, p = nr.done.payload;
    clear(host);
    var created = (Array.isArray(d.units) ? d.units : []).filter(function (x) { return x && x.public_code; });
    // SPEC-GAP: rma_create returns units in payload order (it creates them in a
    // loop over p.units); the labels and owners are matched back by position
    // only when the counts agree.
    var aligned = created.length === p.units.length;
    var rows = created.map(function (x, i) {
      var src = aligned ? p.units[i] : null;
      return {
        code: String(x.public_code),
        label: src ? partLabel(src.kind, src.brand, src.model) : 'Part ' + (i + 1),
        phone: (src && src.owner_phone) || p.sender_phone,
        name: (src && src.owner_phone) ? (src.owner_name || '') : p.sender_name,
        owned: !!(src && src.owner_phone),
        stage: x.stage
      };
    });

    var replay = nr.done.replay || null;
    host.appendChild(h('h3', { className: 'wo-done-title', tabindex: '-1', text: d.duplicate ? 'This RMA was already logged' : (rows.length === 1 ? 'RMA logged' : rows.length + ' parts logged') }));
    if (d.duplicate) {
      host.appendChild(h('p', { className: 'wo-hint', text: 'Your first try reached us even though the answer did not come back. Nothing was logged twice.' +
        (rows.length ? '' : ' The RM codes are in My requests.') }));
      var rn = replayNote(replay);
      if (rn) host.appendChild(rn);
    }
    host.appendChild(h('p', { className: 'wo-hint', text: 'Each part shows as "' + rmaStage('logged') + '" until it reaches the shop and the desk marks it received.' }));

    var list = h('div', { className: 'wo-rma-list' });
    rows.forEach(function (r) {
      var link = trackUrl(r.code);
      list.appendChild(h('div', { className: 'wo-rma-row' }, [
        h('div', { className: 'wo-rma-main' }, [
          h('span', { className: 'wo-code wo-code-sm mono', text: r.code }),
          h('span', { className: 'wo-rma-label', text: r.label + (r.owned ? ' · tracked with the end customer\'s phone' : '') })
        ]),
        h('div', { className: 'wo-rma-acts' }, [copyBtn('Copy code', r.code), copyBtn('Copy link', link)])
      ]));
    });
    host.appendChild(list);

    // One WhatsApp per person: the sender, and each end customer for their own
    // parts. A technician sender gets EVERY code, because they pack the box.
    var fb = h('div', { className: 'wo-wa-fallback hidden' });
    var acts = h('div', { className: 'wo-done-actions' });
    var senderKey = normPhone(p.sender_phone);
    var thirdParty = p.sender_kind === 'third_party_tech';
    var groups = {}, order = [senderKey];
    groups[senderKey] = { phone: p.sender_phone, name: p.sender_name, rows: [], sender: true };
    rows.forEach(function (r) {
      var key = normPhone(r.phone);
      if (thirdParty || key === senderKey) groups[senderKey].rows.push(r);
      if (key === senderKey) return;
      if (!groups[key]) { groups[key] = { phone: r.phone, name: r.name, rows: [], sender: false }; order.push(key); }
      groups[key].rows.push(r);
    });
    order = order.filter(function (k) { return groups[k].rows.length; });
    if (replay && replay.phoneUnsure) order = [];        // which phones the parts carry is not known
    order.forEach(function (k) {
      var g = groups[k];
      var who = g.sender ? (p.sender_name || 'the sender') : (g.name || fmtPhone(g.phone));
      acts.appendChild(waButton(order.length > 1 ? 'WhatsApp ' + who : 'Message on WhatsApp', g.phone,
        function () { return nrWaText(p, g.rows, g.name, g.sender); }, fb));
    });
    var fresh = h('button', { type: 'button', className: 'btn-ghost', text: 'New RMA' });
    fresh.addEventListener('click', function () { nrReset(false); });
    var mine = h('button', { type: 'button', className: 'btn-ghost', text: 'My requests' });
    mine.addEventListener('click', function () { activateView('my-requests'); });
    appendKids(acts, [fresh, mine]);
    host.appendChild(acts);
    host.appendChild(fb);

    show($('nr-form'), false);
    show(host, true);
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    focusDone(host);
  }

  // ════════════════════════════════ MY REQUESTS ══════════════════════════════
  var mr = { bound: false, timer: null, seq: 0, data: null, loadedAt: 0, busy: false };
  var MR_PROMISE_DONE = { ready: true, closed: true, work_done: true, resolved: true };

  // SPEC-GAP: §2.9 names the two lists but not the JSON keys around them;
  // accept a bare array (jobs only) or an object with any of the likely keys.
  function splitMine(d) {
    if (Array.isArray(d)) return { jobs: d, rma: [] };
    d = d || {};
    var jobs = d.jobs || d.service || d.service_jobs || d.requests || [];
    var rma = d.rma || d.rma_units || d.units || d.rma_cases || [];
    return { jobs: Array.isArray(jobs) ? jobs : [], rma: Array.isArray(rma) ? rma : [] };
  }

  function mrBind() {
    if (mr.bound) return true;
    if (!$('view-my-requests')) return false;
    mr.bound = true;
    $('mr-refresh').addEventListener('click', function () { mrLoad(false); });
    $('mr-search').addEventListener('input', mrRender);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !mrVisible()) return;
      if (Date.now() - mr.loadedAt >= MY_POLL_MS) mrLoad(true);
    });
    return true;
  }
  function mrVisible() { var v = $('view-my-requests'); return !!(v && !v.classList.contains('hidden')); }

  function showMyRequests() {
    if (!mrBind()) return;
    mrRender();
    mrLoad(!!mr.data);
    startPolling();
  }
  function startPolling() {
    stopPolling();
    mr.timer = setInterval(function () {
      if (!mrVisible()) { stopPolling(); return; }
      if (document.hidden) return;                 // no point polling a hidden tab
      mrLoad(true);
    }, MY_POLL_MS);
  }
  function stopPolling() { if (mr.timer) { clearInterval(mr.timer); mr.timer = null; } }

  async function mrLoad(quiet) {
    var cli = client();
    if (!cli) { setStatus('mr-status', "Couldn't reach the server. Reload the page and try again.", 'err'); return; }
    var seq = ++mr.seq;
    var btn = $('mr-refresh');
    if (!quiet) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    if (!mr.data) setStatus('mr-status', 'Loading your requests…', 'busy');
    try {
      var res = await cli.rpc('service_my_requests');
      if (res.error) throw res.error;
      if (seq !== mr.seq) return;                  // a newer refresh already answered
      mr.data = splitMine(res.data);
      mr.loadedAt = Date.now();
      setStatus('mr-status', '', '');
      mrRender();
    } catch (e) {
      if (seq !== mr.seq) return;
      // Keep the last good list on screen; say plainly that it may be stale.
      setStatus('mr-status', "Couldn't refresh: " + errText(e) + (mr.data ? ' Showing the list from ' + fmtClock(mr.loadedAt) + '.' : ''), 'err');
      if (authLapsed(e)) { var ms = $('mr-status'); if (ms) { ms.appendChild(document.createTextNode(' ')); ms.appendChild(signInAgainBtn('my-requests')); } }
    } finally {
      if (seq === mr.seq) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
  }

  function cell(label, content, cls) {
    var td = h('td', { className: cls || null, dataset: { label: label } });
    appendKids(td, content);
    return td;
  }
  function mrMatch(q, parts) {
    if (!q) return true;
    return parts.some(function (x) { return x && String(x).toLowerCase().indexOf(q) !== -1; });
  }
  function byNewest(a, b) { return (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0); }

  function mrRender() {
    var jobsBody = $('mr-jobs'), rmaBody = $('mr-rma');
    if (!jobsBody || !rmaBody) return;
    var d = mr.data || { jobs: [], rma: [] };
    var q = val('mr-search').toLowerCase();
    var upd = $('mr-updated');
    if (upd) upd.textContent = mr.loadedAt ? 'Updated ' + fmtClock(mr.loadedAt) : '';

    var jobs = d.jobs.slice().sort(byNewest).filter(function (j) {
      return mrMatch(q, [j.public_code, j.customer_name, j.device_label, staffStage(j.stage), j.assignee, typeLabel(j.service_type)]);
    });
    clear(jobsBody);
    jobs.forEach(function (j) {
      var code = j.public_code || '';
      var closed = j.stage === 'closed';
      var next = '—', late = false;
      if (!closed && j.visit_start) next = (j.service_type === 'remote' ? 'Session ' : 'Visit ') + fmtDayTime(j.visit_start);
      else if (!closed && j.promised_at) {
        next = 'Promised ' + fmtDay(j.promised_at);
        // Same "done" set as the public page and serviceRisk: once the shop's
        // part is finished (or it waits on the customer's sign-off) a passed
        // date is not late.
        late = Date.parse(j.promised_at) < Date.now() && !MR_PROMISE_DONE[j.stage];
      }
      var nextCell = late ? [next + ' · ', h('span', { className: 'wo-late', text: 'late' })] : next;
      jobsBody.appendChild(h('tr', { className: closed ? 'wo-row-closed' : null }, [
        cell('Code', h('span', { className: 'mono', text: code || '—' }), 'cell-id'),
        cell('Customer', j.customer_name || '—', 'cell-customer'),
        cell('Type', typeLabel(j.service_type)),
        cell('Device', j.device_label || '—'),
        cell('Where it is', staffStage(j.stage)),
        cell('Technician', j.assignee || (closed ? '—' : 'In the queue')),
        cell('Logged', fmtDay(j.created_at) || '—'),
        cell('Next', nextCell),
        cell('', code ? copyBtn('Copy link', trackUrl(code)) : null, 'wo-cell-act')
      ]));
    });
    show($('mr-jobs-empty'), !jobs.length);
    $('mr-jobs-empty').textContent = d.jobs.length && q ? 'No service requests match that search.' : 'No service requests from you in the last 60 days.';
    $('mr-jobs-count').textContent = d.jobs.length ? String(d.jobs.length) : '';

    var units = d.rma.slice().sort(byNewest).filter(function (u) {
      return mrMatch(q, [u.public_code, u.brand, u.model, kindLabel(u.kind), rmaStage(u.stage)]);
    });
    clear(rmaBody);
    units.forEach(function (u) {
      var code = u.public_code || '';
      rmaBody.appendChild(h('tr', { className: u.stage === 'closed' ? 'wo-row-closed' : null }, [
        cell('Code', h('span', { className: 'mono', text: code || '—' }), 'cell-id'),
        cell('Part', partLabel(u.kind, u.brand, u.model)),
        cell('Where it is', rmaStage(u.stage)),
        cell('Logged', fmtDay(u.created_at) || '—'),
        cell('', code ? copyBtn('Copy link', trackUrl(code)) : null, 'wo-cell-act')
      ]));
    });
    show($('mr-rma-empty'), !units.length);
    $('mr-rma-empty').textContent = d.rma.length && q ? 'No RMA parts match that search.' : 'No RMA parts from you in the last 60 days.';
    $('mr-rma-count').textContent = d.rma.length ? String(d.rma.length) : '';
  }

  // ═══════════════════════════════════ reset ═════════════════════════════════
  // Sign-out: wipe both forms, drafts and the list, so the next person on a
  // shared PC sees none of the previous customer's details.
  function resetAll() {
    stopPolling();
    if (ns.bound) nsReset(false, true);
    if (nr.bound) nrReset(true);
    dropDraft('ns'); dropDraft('nr');
    ns.techs = null; ns.techsAt = 0;
    mr.seq++; mr.data = null; mr.loadedAt = 0;
    if (mr.bound) { setVal('mr-search', ''); setStatus('mr-status', '', ''); mrRender(); }
  }
  // Something typed that has not been sent (Sign out asks before wiping it).
  function hasUnsent() {
    return !!((ns.bound && !ns.done && nsDirty()) || (nr.bound && !nr.done && nrDirty()));
  }
  // Write both drafts now rather than after the debounce: the sign-in screen
  // may be where the phone discards this tab.
  function flushDrafts() {
    if (ns.bound && !ns.done && nsDirty()) { clearTimeout(ns.draftTimer); saveDraft('ns', nsState(), null); }
    if (nr.bound && !nr.done && nrDirty()) { clearTimeout(nr.draftTimer); saveDraft('nr', nrState(), null); }
  }

  window.NeoQcWebOps = {
    showNewService: showNewService,
    showNewRma: showNewRma,
    showMyRequests: showMyRequests,
    stopPolling: stopPolling,
    reset: resetAll,
    hasUnsent: hasUnsent,
    // exposed for the harness and tests
    _normPhone: normPhone,
    _phoneOk: phoneOk,
    _isValidPhone: isValidPhone,
    _normPhoneInline: normPhoneInline,
    _phoneOkInline: phoneOkInline,
    _fmtPhone: fmtPhone,
    _waUrl: waUrl,
    _authLapsed: authLapsed,
    _outcomeUnknown: outcomeUnknown,
    _readMapLink: readMapLink,
    _dayToIso: dayToIso,
    _parseLocalInput: parseLocalInput,
    _errText: errText,
    _splitMine: splitMine,
    _nsCollect: function () { return nsCollect(); },
    _nrCollect: function () { return nrCollect(); }
  };
})();
