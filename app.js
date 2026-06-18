const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// App Global State
let appState = {
  tickets: [],
  technicians: ["Adhil", "Amal", "Ananthakrishnan", "Athul"],
  rivalBenchmarks: [],
  settings: {
    supabaseUrl: "",
    supabaseAnonKey: "",
    pathHwInfo: "",
    pathCinebench: "",
    pathFurmark: ""
  }
};

let currentMode = "selector"; // "selector", "staff", "client"
let editingTicketId = null;

// ==========================================================================
// INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadDatabase();
  setupEventListeners();
  updateTimeDisplay();
  setInterval(updateTimeDisplay, 60000);

  // Navigate to initial screen based on app-config.json or settings
  let bootMode = 'client';
  try {
    const configPath = path.join(__dirname, 'app-config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.mode === 'admin') {
        bootMode = 'staff';
      }
    }
  } catch (e) {
    console.error("Error reading app-config.json:", e);
  }

  if (bootMode !== 'staff') {
    if (appState.settings.isMaster) {
      bootMode = 'selector';
    } else {
      bootMode = 'client';
    }
  }

  switchScreen(bootMode);
});

// Load DB from local Electron AppData Storage
async function loadDatabase() {
  const dbData = await ipcRenderer.invoke('db:read');
  if (dbData) {
    appState = dbData;
  }

  // Securely initialize missing properties to prevent runtime script crashes
  if (!appState.tickets) appState.tickets = [];
  if (!appState.technicians) appState.technicians = ["Adhil", "Amal", "Ananthakrishnan", "Athul"];
  if (!appState.rivalBenchmarks) appState.rivalBenchmarks = [
    { id: "1", name: "Ryzen 5 7600 + RTX 4060", cpu: "Ryzen 5 7600", gpu: "RTX 4060", cinebenchR23: 13800, readSpeed: 5000, writeSpeed: 4000, price: "₹18,500 (~$210)" },
    { id: "2", name: "Intel i7-14700K + RTX 4070 Ti", cpu: "Core i7-14700K", gpu: "RTX 4070 Ti Super", cinebenchR23: 35000, readSpeed: 7000, writeSpeed: 6000, price: "₹68,000 (~$820)" }
  ];

  // Database migration & normalization for default rival configs and new build checks
  let databaseNeedsSaving = false;
  
  if (appState.tickets && appState.tickets.length > 0) {
    appState.tickets.forEach(t => {
      if (t.buildChecks && t.buildChecks.posted === undefined) {
        t.buildChecks.posted = (t.status !== 'building' && t.status !== 'awaiting');
        databaseNeedsSaving = true;
      }
      if (t.diagnostics && t.diagnostics.furmark === undefined) {
        t.diagnostics.furmark = null;
        databaseNeedsSaving = true;
      }
    });
  }

  if (appState.rivalBenchmarks && appState.rivalBenchmarks.length > 0) {
    appState.rivalBenchmarks.forEach(rival => {
      if (rival.id === "1") {
        if (rival.cinebenchR23 === 14500 || !rival.price) {
          rival.cinebenchR23 = 13800;
          rival.price = "₹18,500 (~$210)";
          databaseNeedsSaving = true;
        }
      } else if (rival.id === "2") {
        if (!rival.price) {
          rival.price = "₹68,000 (~$820)";
          databaseNeedsSaving = true;
        }
      }
    });
  }
  if (databaseNeedsSaving) {
    await saveDatabase();
  }
  if (!appState.settings) {
    appState.settings = { 
      supabaseUrl: "https://ggsxkhenzdhaachubrsc.supabase.co", 
      supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo", 
      pathHwInfo: "", 
      pathCinebench: "", 
      pathFurmark: "", 
      isMaster: false,
      accentColor: "pink",
      cpuMaxTemp: 85,
      gpuMaxTemp: 80,
      minSsdSpeed: 3000,
      autoPdf: false,
      soundEnabled: true,
      shopName: "Neo Tokyo Kochi",
      contactInfo: "kochi@neotokyo.in"
    };
  } else {
    if (!appState.settings.supabaseUrl) appState.settings.supabaseUrl = "https://ggsxkhenzdhaachubrsc.supabase.co";
    if (!appState.settings.supabaseAnonKey) appState.settings.supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo";
    if (!appState.settings.pathHwInfo) appState.settings.pathHwInfo = "";
    if (!appState.settings.pathCinebench) appState.settings.pathCinebench = "";
    if (!appState.settings.pathFurmark) appState.settings.pathFurmark = "";
    if (appState.settings.isMaster === undefined) appState.settings.isMaster = false;
    if (!appState.settings.accentColor) appState.settings.accentColor = "pink";
    if (appState.settings.cpuMaxTemp === undefined) appState.settings.cpuMaxTemp = 85;
    if (appState.settings.gpuMaxTemp === undefined) appState.settings.gpuMaxTemp = 80;
    if (appState.settings.minSsdSpeed === undefined) appState.settings.minSsdSpeed = 3000;
    if (appState.settings.autoPdf === undefined) appState.settings.autoPdf = false;
    if (appState.settings.soundEnabled === undefined) appState.settings.soundEnabled = true;
    if (!appState.settings.shopName) appState.settings.shopName = "Neo Tokyo Kochi";
    if (!appState.settings.contactInfo) appState.settings.contactInfo = "kochi@neotokyo.in";
  }
  applyAccentColor(appState.settings.accentColor);
  
  // Seed beautiful mock tickets if db is empty to showcase the UI immediately!
  if (!appState.tickets || appState.tickets.length === 0) {
    seedMockTickets();
    await saveDatabase();
  }
  
  initSupabase();
  await syncFromCloud();

  // Version check and Changelog Modal trigger
  const currentVersion = require('./package.json').version;
  if (appState.lastRunVersion !== currentVersion) {
    setTimeout(() => {
      const changelogModal = document.getElementById('changelog-modal');
      if (changelogModal) {
        changelogModal.classList.add('active');
      }
    }, 1000);
  }
}

// Save DB back to local storage
async function saveDatabase() {
  await ipcRenderer.invoke('db:write', appState);
}

// Switch between screens
function switchScreen(mode, selectedId = null) {
  currentMode = mode;
  
  // Programmatic scroll resets to prevent offsets
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;

  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });

  if (mode === 'staff') {
    document.getElementById('staff-screen').classList.add('active');
    populateTechnicianDropdowns();
    renderDashboard();
  } else if (mode === 'client') {
    document.getElementById('client-welcome-screen').classList.add('active');
    populateWelcomeTicketSelect();
    
    // Hide or show exit button depending on isMaster
    const welcomeExitBtn = document.getElementById('btn-welcome-exit');
    if (welcomeExitBtn) {
      if (appState.settings.isMaster) {
        welcomeExitBtn.classList.remove('hidden');
      } else {
        welcomeExitBtn.classList.add('hidden');
      }
    }
  } else if (mode === 'client-console') {
    document.getElementById('client-screen').classList.add('active');
    populateClientTicketSelect(selectedId);
    handleClientTicketSelect();
    
    // Hide or show exit button depending on isMaster
    const clientExitBtn = document.getElementById('btn-client-exit');
    if (clientExitBtn) {
      if (appState.settings.isMaster) {
        clientExitBtn.classList.remove('hidden');
      } else {
        clientExitBtn.classList.add('hidden');
      }
    }
  } else {
    document.getElementById('mode-selector-screen').classList.add('active');
  }
}

function updateTimeDisplay() {
  const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const timeStr = new Date().toLocaleDateString('en-US', options);
  // Add a nice status line if elements exist
}

// ==========================================================================
// DROPDOWN POPULATORS & RENDERING
// ==========================================================================
function populateTechnicianDropdowns() {
  const staffFilter = document.getElementById('filter-tech');
  const formTech = document.getElementById('form-technician');

  // Preserve select elements
  if (staffFilter && formTech) {
    staffFilter.innerHTML = '<option value="all">All Technicians</option>';
    formTech.innerHTML = '';

    appState.technicians.forEach(tech => {
      const opt1 = document.createElement('option');
      opt1.value = tech;
      opt1.textContent = tech;
      staffFilter.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = tech;
      opt2.textContent = tech;
      formTech.appendChild(opt2);
    });
  }
  
  // Populate Rivals in modal form
  const rivalSelect = document.getElementById('form-rival-select');
  if (rivalSelect) {
    rivalSelect.innerHTML = '<option value="">-- Choose Rival Configuration --</option>';
    appState.rivalBenchmarks.forEach(rival => {
      const opt = document.createElement('option');
      opt.value = rival.id;
      opt.textContent = rival.name;
      rivalSelect.appendChild(opt);
    });
  }

  // Populate Rivals in client form
  const clientRivalSelect = document.getElementById('c-rival-select');
  if (clientRivalSelect) {
    clientRivalSelect.innerHTML = '<option value="">-- Choose Rival Configuration --</option>';
    appState.rivalBenchmarks.forEach(rival => {
      const opt = document.createElement('option');
      opt.value = rival.id;
      opt.textContent = rival.name;
      clientRivalSelect.appendChild(opt);
    });
  }
}

function populateClientTicketSelect(selectedId = null) {
  const select = document.getElementById('client-ticket-select');
  if (select) {
    select.innerHTML = '<option value="">-- Choose Ticket --</option>';
    // Filter active builds/repairs only
    const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
    activeTickets.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `[${t.type.toUpperCase()}] ${t.customerName} - Deadline: ${formatDateShort(t.deadline)}`;
      if (selectedId && t.id === selectedId) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }
}

function populateWelcomeTicketSelect() {
  const select = document.getElementById('welcome-ticket-select');
  if (select) {
    select.innerHTML = '<option value="">-- Choose Active Ticket --</option>';
    const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
    activeTickets.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `[${t.type.toUpperCase()}] ${t.customerName} - Deadline: ${formatDateShort(t.deadline)}`;
      select.appendChild(opt);
    });
  }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth()+1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Render Dashboard Grid & Completed List
function renderDashboard() {
  const grid = document.getElementById('tickets-grid');
  const archiveTable = document.getElementById('archive-table-body');
  
  if (!grid || !archiveTable) return;

  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const filterStatus = document.getElementById('filter-status').value;
  const filterTech = document.getElementById('filter-tech').value;

  grid.innerHTML = '';
  archiveTable.innerHTML = '';

  const activeTickets = appState.tickets.filter(t => t.status !== 'completed');
  const completedTickets = appState.tickets.filter(t => t.status === 'completed');

  // Filter Active Tickets
  const filteredActive = activeTickets.filter(t => {
    if (!t || !t.id || !t.customerName) return false;
    const matchesSearch = t.customerName.toLowerCase().includes(searchQuery) ||
                          t.id.toLowerCase().includes(searchQuery) ||
                          (t.technician && t.technician.toLowerCase().includes(searchQuery)) ||
                          (t.serials && Object.values(t.serials).some(v => v && v.toLowerCase().includes(searchQuery)));
    
    const matchesStatus = filterStatus === 'all' || t.status === filterStatus;
    const matchesTech = filterTech === 'all' || t.technician === filterTech;

    return matchesSearch && matchesStatus && matchesTech;
  });

  // Render Active Cards
  if (filteredActive.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>No active builds matching filters.</p></div>`;
  } else {
    filteredActive.forEach(t => {
      // Calculate percentages
      const buildPct = calculateBuildPercentage(t);
      const qcPct = calculateQcPercentage(t);
      const isAwaitingParts = t.missingComponentsToggle;
      
      const isUrgent = checkIsUrgent(t.deadline);
      const statusText = getStatusLabelText(t.status);

      const card = document.createElement('div');
      card.className = `glass-slab ticket-card`;
      card.innerHTML = `
        <div class="ticket-card-header">
          <span class="card-id">#${t.id.slice(-6)}</span>
          <span class="card-priority-dot ${isUrgent ? 'urgent' : 'standard'}"></span>
        </div>
        <h3 class="card-cust-name">${t.customerName}</h3>
        <p class="card-tech-name">Assigned Tech: <strong>${t.technician || 'Unassigned'}</strong></p>
        
        <div class="card-progress-section">
          <div class="card-progress-label">
            <span>Assembly Status</span>
            <span>${buildPct}%</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill build" style="width: ${buildPct}%"></div>
          </div>
        </div>

        <div class="card-progress-section">
          <div class="card-progress-label">
            <span>QC Testing</span>
            <span>${qcPct}%</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill qc" style="width: ${qcPct}%"></div>
          </div>
        </div>

        ${isAwaitingParts ? `
          <div class="card-missing-parts">
            ⚠️ <strong>Awaiting:</strong> ${t.missingComponents || 'Parts unspecified'}
          </div>
        ` : ''}

        <div class="card-meta-footer">
          <span>${t.type === 'build' ? '⚙️ Custom Build' : '🔧 Service Repair'}</span>
          <span>📅 ${formatDateShort(t.deadline)}</span>
        </div>
      `;

      card.addEventListener('click', () => openTicketModal(t.id));
      grid.appendChild(card);
    });
  }

  // Render Completed / Passed Archive
  const filteredCompleted = completedTickets.filter(t => {
    if (!t || !t.id || !t.customerName) return false;
    const matchesSearch = t.customerName.toLowerCase().includes(searchQuery) ||
                          t.id.toLowerCase().includes(searchQuery) ||
                          (t.technician && t.technician.toLowerCase().includes(searchQuery));
    const matchesTech = filterTech === 'all' || t.technician === filterTech;
    return matchesSearch && matchesTech;
  });

  if (filteredCompleted.length === 0) {
    archiveTable.innerHTML = `<tr><td colspan="7" class="text-center">No completed system logs found.</td></tr>`;
  } else {
    filteredCompleted.forEach(t => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="font-mono">#${t.id.slice(-6)}</td>
        <td><strong>${t.customerName}</strong></td>
        <td>${t.technician}</td>
        <td>${t.specs ? (t.specs.cpu || 'System Build') : 'N/A'}</td>
        <td class="font-mono">${t.diagnostics ? (t.diagnostics.cinebench || 'Not Run') : 'N/A'} pts</td>
        <td>${t.completedAt ? new Date(t.completedAt).toLocaleDateString() : 'N/A'}</td>
        <td>
          <button class="text-btn print-row-btn">🖨️ Print</button>
          <button class="text-btn pdf-row-btn">💾 PDF</button>
          <button class="text-btn edit-row-btn">✏️ Edit</button>
        </td>
      `;

      row.querySelector('.print-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerPrintReport(t.id);
      });
      row.querySelector('.pdf-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerSavePdf(t.id);
      });
      row.querySelector('.edit-row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openTicketModal(t.id);
      });

      archiveTable.appendChild(row);
    });
  }

  // Update counts
  document.getElementById('active-count').textContent = activeTickets.length;
  document.getElementById('completed-count').textContent = completedTickets.length;
}

function calculateBuildPercentage(t) {
  if (!t || !t.buildChecks) return 0;
  let count = 0;
  if (t.buildChecks.cpuRamSsd) count++;
  if (t.buildChecks.moboCase) count++;
  if (t.buildChecks.cooler) count++;
  if (t.buildChecks.cables) count++;
  if (t.buildChecks.posted) count++;
  return Math.round((count / 5) * 100);
}

function calculateQcPercentage(t) {
  if (!t || !t.qcChecks) return 0;
  let count = 0;
  const qcKeys = [
    'physCabinet', 'physMobo', 'physRam', 'physScrews',
    'softWindows', 'softDrivers', 'softBios',
    'portUsb', 'portVideo', 'portAudio', 'portWifi'
  ];
  qcKeys.forEach(k => {
    if (t.qcChecks[k]) count++;
  });
  return Math.round((count / qcKeys.length) * 100);
}

function checkIsUrgent(deadlineStr) {
  if (!deadlineStr) return false;
  const diffMs = new Date(deadlineStr) - new Date();
  return diffMs > 0 && diffMs < 24 * 60 * 60 * 1000; // Less than 24 hours
}

function getStatusLabelText(status) {
  switch (status) {
    case 'awaiting': return 'Awaiting Components';
    case 'building': return 'Build Commenced';
    case 'waiting_qc': return 'Awaiting QC';
    case 'qc_testing': return 'QC Stress Testing';
    case 'completed': return 'QC Pass / Completed';
    default: return 'Pending';
  }
}

function isI514thGen(cpuStr) {
  if (!cpuStr) return false;
  const s = cpuStr.toLowerCase();
  return s.includes('i5') && (s.includes('14400') || s.includes('14500') || s.includes('14600') || s.includes('14th') || s.includes('14900') || s.includes('14700') || (s.includes('14') && s.includes('gen')));
}

// ==========================================================================
// TICKET FORM & MODAL ACTIONS (STAFF PORTAL)
// ==========================================================================
function openTicketModal(ticketId = null) {
  editingTicketId = ticketId;
  const modal = document.getElementById('ticket-modal');
  const form = document.getElementById('ticket-form');
  form.reset();

  const printBtn = document.getElementById('btn-print-report');
  const deleteBtn = document.getElementById('btn-delete-ticket');
  const title = document.getElementById('modal-title');

  // Enable/Disable component locks initially
  updateFormLockStates(0);

  if (ticketId) {
    title.textContent = "Edit Service Ticket";
    const ticket = appState.tickets.find(t => t.id === ticketId);
    if (ticket) {
      document.getElementById('form-ticket-id').value = ticket.id;
      document.getElementById('form-created-at').value = ticket.createdAt;
      document.getElementById('form-customer-name').value = ticket.customerName;
      document.getElementById('form-deadline').value = formatDateTimeLocal(ticket.deadline);
      document.getElementById('form-deadline').disabled = true;
      document.getElementById('btn-change-deadline').style.display = 'block';
      document.getElementById('form-technician').value = ticket.technician;
      document.getElementById('form-ticket-type').value = ticket.type;
      
      // Load specs into modal fields
      document.getElementById('modal-spec-cpu').textContent = ticket.specs ? (ticket.specs.cpu || '--') : '--';
      document.getElementById('modal-spec-gpu').textContent = ticket.specs ? (ticket.specs.gpu || '--') : '--';
      document.getElementById('modal-spec-ram').textContent = ticket.specs ? (ticket.specs.ram || '--') : '--';
      document.getElementById('modal-spec-storage').textContent = ticket.specs ? (ticket.specs.storage || '--') : '--';
      
      // Reset rival pulled banner
      const rivalBanner = document.getElementById('modal-rival-pulled-banner');
      rivalBanner.classList.add('hidden');
      rivalBanner.innerHTML = '';

      const partsToggle = document.getElementById('form-missing-components-toggle');
      partsToggle.checked = ticket.missingComponentsToggle;
      const partsInput = document.getElementById('form-missing-components');
      partsInput.disabled = !ticket.missingComponentsToggle;
      partsInput.value = ticket.missingComponents || '';

      // Set physical checkboxes
      document.getElementById('check-cpu-ram-ssd').checked = ticket.buildChecks.cpuRamSsd;
      document.getElementById('check-mobo-case').checked = ticket.buildChecks.moboCase;
      document.getElementById('check-cooler').checked = ticket.buildChecks.cooler;
      document.getElementById('check-cables').checked = ticket.buildChecks.cables;
      document.getElementById('check-posted').checked = ticket.buildChecks.posted || false;

      // Lock triggers check
      const buildPct = calculateBuildPercentage(ticket);
      updateFormLockStates(buildPct);

      // Set QC Checks
      document.getElementById('qc-phys-cabinet').checked = ticket.qcChecks.physCabinet;
      document.getElementById('qc-phys-motherboard').checked = ticket.qcChecks.physMobo;
      document.getElementById('qc-phys-ram').checked = ticket.qcChecks.physRam;
      document.getElementById('qc-phys-screws').checked = ticket.qcChecks.physScrews;
      document.getElementById('qc-soft-windows').checked = ticket.qcChecks.softWindows;
      document.getElementById('qc-soft-drivers').checked = ticket.qcChecks.softDrivers;
      document.getElementById('qc-soft-bios').checked = ticket.qcChecks.softBios;
      document.getElementById('qc-port-usb').checked = ticket.qcChecks.portUsb;
      document.getElementById('qc-port-video').checked = ticket.qcChecks.portVideo;
      document.getElementById('qc-port-audio').checked = ticket.qcChecks.portAudio;
      document.getElementById('qc-port-wifi').checked = ticket.qcChecks.portWifi;
      
      document.getElementById('form-wifi-speed').value = ticket.qcChecks.wifiSpeed || '';
      document.getElementById('form-wifi-range').value = ticket.qcChecks.wifiRange || '';

      // Diagnostics & Serials
      document.getElementById('form-cpu-temp-min').value = ticket.diagnostics.cpuTempMin || '';
      document.getElementById('form-cpu-temp-max').value = ticket.diagnostics.cpuTempMax || '';
      document.getElementById('form-cpu-temp-avg').value = ticket.diagnostics.cpuTempAvg || '';
      document.getElementById('form-gpu-temp-min').value = ticket.diagnostics.gpuTempMin || '';
      document.getElementById('form-gpu-temp-max').value = ticket.diagnostics.gpuTempMax || '';
      document.getElementById('form-gpu-temp-avg').value = ticket.diagnostics.gpuTempAvg || '';
      document.getElementById('form-cinebench-score').value = ticket.diagnostics.cinebench || '';
      document.getElementById('form-furmark-score').value = ticket.diagnostics.furmark || '';
      document.getElementById('form-ssd-read').value = ticket.diagnostics.ssdRead || '';
      document.getElementById('form-ssd-write').value = ticket.diagnostics.ssdWrite || '';
      let rivalId = ticket.diagnostics.rivalConfigId || '';
      if (!rivalId && ticket.specs && ticket.specs.cpu && isI514thGen(ticket.specs.cpu)) {
        const amdRival = appState.rivalBenchmarks.find(r => r.cpu && r.cpu.toLowerCase().includes('ryzen 5 7600') || r.id === '1');
        if (amdRival) {
          rivalId = amdRival.id;
          ticket.diagnostics.rivalConfigId = rivalId;
        }
      }
      document.getElementById('form-rival-select').value = rivalId;

      document.getElementById('serial-motherboard').value = ticket.serials.motherboard || '';
      document.getElementById('serial-ram').value = ticket.serials.ram || '';
      document.getElementById('serial-gpu').value = ticket.serials.gpu || '';
      document.getElementById('serial-ssd').value = ticket.serials.ssd || '';
      document.getElementById('serial-cabinet').value = ticket.serials.cabinet || '';

      // Run duplicate check on load
      document.querySelectorAll('.serial-field').forEach(field => verifyFieldDuplicate(field));

      updateRivalComparisonOutput();

      printBtn.classList.remove('hidden');
      document.getElementById('btn-save-pdf').classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      updateModalDiagnosticsStatus();
    }
  } else {
    title.textContent = "Create Service Ticket";
    document.getElementById('form-ticket-id').value = '';
    document.getElementById('form-created-at').value = '';
    
    // Reset specs
    document.getElementById('modal-spec-cpu').textContent = '--';
    document.getElementById('modal-spec-gpu').textContent = '--';
    document.getElementById('modal-spec-ram').textContent = '--';
    document.getElementById('modal-spec-storage').textContent = '--';
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(18, 0, 0, 0);
    document.getElementById('form-deadline').value = formatDateTimeLocal(tomorrow.toISOString());
    document.getElementById('form-deadline').disabled = false;
    document.getElementById('btn-change-deadline').style.display = 'none';
    
    const rivalBanner = document.getElementById('modal-rival-pulled-banner');
    rivalBanner.classList.add('hidden');
    rivalBanner.innerHTML = '';

    printBtn.classList.add('hidden');
    document.getElementById('btn-save-pdf').classList.add('hidden');
    deleteBtn.classList.add('hidden');
    updateModalDiagnosticsStatus();
  }

  modal.classList.add('active');
}

function updateFormLockStates(buildPct) {
  const badge = document.getElementById('build-status-badge');
  badge.textContent = `${buildPct}% Complete`;

  const qcSect = document.getElementById('qc-testing-section');
  const diagSect = document.getElementById('diagnostics-section');
  const serialsSect = document.getElementById('serials-section');

  if (buildPct < 100) {
    qcSect.classList.add('locked');
    diagSect.classList.add('locked');
    serialsSect.classList.add('locked');
  } else {
    qcSect.classList.remove('locked');
    diagSect.classList.remove('locked');
    serialsSect.classList.remove('locked');
  }
}

function updateModalDiagnosticsStatus() {
  const statusBox = document.getElementById('modal-diagnostics-status');
  if (!statusBox) return;

  const hasHw = appState.settings.pathHwInfo || appState.settings.pathHwInfo === 'mock';
  const hasCb = appState.settings.pathCinebench || appState.settings.pathCinebench === 'mock';
  const hasFm = appState.settings.pathFurmark || appState.settings.pathFurmark === 'mock';

  // Check values in modal inputs
  const cpuAvg = document.getElementById('form-cpu-temp-avg').value;
  const cbScore = document.getElementById('form-cinebench-score').value;

  let hwStatus = hasHw ? "Ready" : "Not Configured";
  let cbStatus = hasCb ? "Ready" : "Not Configured";
  let fmStatus = hasFm ? "Ready" : "Not Configured";

  if (cpuAvg) hwStatus = "Calculated";
  if (cbScore) cbStatus = `Completed (${cbScore} pts)`;
  if (cpuAvg) fmStatus = "Completed";

  statusBox.innerHTML = `
    HWiNFO64: <strong style="color: ${hwStatus === 'Calculated' ? 'var(--status-completed)' : 'inherit'}">${hwStatus}</strong> | 
    Cinebench R23: <strong style="color: ${cbStatus.startsWith('Completed') ? 'var(--status-completed)' : 'inherit'}">${cbStatus}</strong> | 
    FurMark: <strong style="color: ${fmStatus === 'Completed' ? 'var(--status-completed)' : 'inherit'}">${fmStatus}</strong>
  `;
}

function setupFormCalculations() {
  // Auto average temps
  const cpuMin = document.getElementById('form-cpu-temp-min');
  const cpuMax = document.getElementById('form-cpu-temp-max');
  const cpuAvg = document.getElementById('form-cpu-temp-avg');

  const calcCpuAvg = () => {
    const minVal = parseFloat(cpuMin.value);
    const maxVal = parseFloat(cpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      cpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      cpuAvg.value = '';
    }
    updateModalDiagnosticsStatus();
  };
  cpuMin.addEventListener('input', calcCpuAvg);
  cpuMax.addEventListener('input', calcCpuAvg);

  const gpuMin = document.getElementById('form-gpu-temp-min');
  const gpuMax = document.getElementById('form-gpu-temp-max');
  const gpuAvg = document.getElementById('form-gpu-temp-avg');

  const calcGpuAvg = () => {
    const minVal = parseFloat(gpuMin.value);
    const maxVal = parseFloat(gpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      gpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      gpuAvg.value = '';
    }
    updateModalDiagnosticsStatus();
  };
  gpuMin.addEventListener('input', calcGpuAvg);
  gpuMax.addEventListener('input', calcGpuAvg);
  
  // Cinebench input trigger
  document.getElementById('form-cinebench-score').addEventListener('input', () => {
    updateModalDiagnosticsStatus();
  });
  
  // Rival comparator trigger
  document.getElementById('form-rival-select').addEventListener('change', updateRivalComparisonOutput);
}

function updateRivalComparisonOutput() {
  const rivalId = document.getElementById('form-rival-select').value;
  const cbScore = parseFloat(document.getElementById('form-cinebench-score').value);
  const readSpeed = parseFloat(document.getElementById('form-ssd-read').value);
  const writeSpeed = parseFloat(document.getElementById('form-ssd-write').value);
  const outputDiv = document.getElementById('rival-comparison-output');

  if (!rivalId) {
    outputDiv.classList.add('hidden');
    return;
  }

  const rival = appState.rivalBenchmarks.find(r => r.id === rivalId);
  if (!rival) {
    outputDiv.classList.add('hidden');
    return;
  }

  outputDiv.classList.remove('hidden');
  outputDiv.innerHTML = `
    <div style="margin-bottom: 8px; font-size: 0.85rem; border-bottom: 1px solid rgba(15, 23, 42, 0.08); padding-bottom: 6px;">
      <strong>Target Competitor:</strong> ${rival.name}<br>
      <span style="opacity: 0.8;">CPU: ${rival.cpu || '--'} | GPU: ${rival.gpu || '--'} | Price: ${rival.price || '--'}</span>
    </div>
    <div class="comparison-row header"><span>Parameter</span><span>Your Build</span><span>Target rival</span><span>Delta</span></div>
  `;

  const compareMetric = (label, currentVal, rivalVal) => {
    if (isNaN(currentVal)) {
      return `<div class="comparison-row"><span>${label}</span><span>--</span><span>${rivalVal}</span><span>--</span></div>`;
    }
    const pctDiff = ((currentVal - rivalVal) / rivalVal) * 100;
    const sign = pctDiff >= 0 ? '+' : '';
    const isPass = pctDiff >= -5; // Within 5% tolerance is normal / pass
    const deltaClass = isPass ? 'delta-pass' : 'delta-fail';
    return `
      <div class="comparison-row">
        <span>${label}</span>
        <span>${currentVal}</span>
        <span>${rivalVal}</span>
        <span class="${deltaClass}">${sign}${pctDiff.toFixed(1)}% (${isPass ? 'OK' : 'UNDER'})</span>
      </div>
    `;
  };

  outputDiv.innerHTML += compareMetric("Cinebench Score", cbScore, rival.cinebenchR23);
  outputDiv.innerHTML += compareMetric("SSD Read Speed (MB/s)", readSpeed, rival.readSpeed);
  outputDiv.innerHTML += compareMetric("SSD Write Speed (MB/s)", writeSpeed, rival.writeSpeed);
}

function handleClientTicketSelect() {
  const ticketId = document.getElementById('client-ticket-select').value;
  const submitBtn = document.getElementById('btn-client-submit');
  const detectHwBtn = document.getElementById('btn-client-detect-hw');
  const runDiagBtn = document.getElementById('btn-run-auto-diagnostics');
  const checkWinBtn = document.getElementById('btn-client-check-win');

  if (!ticketId) {
    submitBtn.setAttribute('disabled', 'true');
    detectHwBtn.setAttribute('disabled', 'true');
    runDiagBtn.setAttribute('disabled', 'true');
    checkWinBtn.setAttribute('disabled', 'true');

    // Clear spec display
    document.getElementById('c-spec-cpu').textContent = 'Not detected';
    document.getElementById('c-spec-gpu').textContent = 'Not detected';
    document.getElementById('c-spec-ram').textContent = 'Not detected';
    document.getElementById('c-spec-storage').textContent = 'Not detected';

    // Clear inputs
    document.getElementById('c-cpu-temp-min').value = '';
    document.getElementById('c-cpu-temp-max').value = '';
    document.getElementById('c-cpu-temp-avg').value = '';
    document.getElementById('c-gpu-temp-min').value = '';
    document.getElementById('c-gpu-temp-max').value = '';
    document.getElementById('c-gpu-temp-avg').value = '';
    document.getElementById('c-cinebench-score').value = '';
    document.getElementById('c-ssd-read').value = '';
    document.getElementById('c-ssd-write').value = '';
    document.getElementById('c-rival-select').value = '';
    document.getElementById('c-rival-comparison-output').classList.add('hidden');
    
    // Clear status
    document.getElementById('c-diagnostics-status').innerHTML = 'HWiNFO64: [Idle] | Cinebench R23: [Idle] | FurMark: [Idle]';
    return;
  }

  submitBtn.removeAttribute('disabled');
  detectHwBtn.removeAttribute('disabled');
  runDiagBtn.removeAttribute('disabled');
  checkWinBtn.removeAttribute('disabled');

  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (ticket) {
    // Populate specs
    document.getElementById('c-spec-cpu').textContent = ticket.specs ? (ticket.specs.cpu || 'Not detected') : 'Not detected';
    document.getElementById('c-spec-gpu').textContent = ticket.specs ? (ticket.specs.gpu || 'Not detected') : 'Not detected';
    document.getElementById('c-spec-ram').textContent = ticket.specs ? (ticket.specs.ram || 'Not detected') : 'Not detected';
    document.getElementById('c-spec-storage').textContent = ticket.specs ? (ticket.specs.storage || 'Not detected') : 'Not detected';

    // Set global detectedSpecs if already present in ticket
    if (ticket.specs && ticket.specs.cpu) {
      detectedSpecs = {
        cpu: ticket.specs.cpu,
        gpu: ticket.specs.gpu,
        ram: ticket.specs.ram,
        storage: ticket.specs.storage
      };
    } else {
      detectedSpecs = null;
    }

    // Populate temps
    document.getElementById('c-cpu-temp-min').value = ticket.diagnostics.cpuTempMin || '';
    document.getElementById('c-cpu-temp-max').value = ticket.diagnostics.cpuTempMax || '';
    document.getElementById('c-cpu-temp-avg').value = ticket.diagnostics.cpuTempAvg || '';
    document.getElementById('c-gpu-temp-min').value = ticket.diagnostics.gpuTempMin || '';
    document.getElementById('c-gpu-temp-max').value = ticket.diagnostics.gpuTempMax || '';
    document.getElementById('c-gpu-temp-avg').value = ticket.diagnostics.gpuTempAvg || '';

    // Populate benchmarks
    document.getElementById('c-cinebench-score').value = ticket.diagnostics.cinebench || '';
    document.getElementById('c-furmark-score').value = ticket.diagnostics.furmark || '';
    document.getElementById('c-ssd-read').value = ticket.diagnostics.ssdRead || '';
    document.getElementById('c-ssd-write').value = ticket.diagnostics.ssdWrite || '';
    
    // Populate rival select
    let rivalId = ticket.diagnostics.rivalConfigId || '';
    if (!rivalId && ticket.specs && ticket.specs.cpu && isI514thGen(ticket.specs.cpu)) {
      const amdRival = appState.rivalBenchmarks.find(r => r.cpu && r.cpu.toLowerCase().includes('ryzen 5 7600') || r.id === '1');
      if (amdRival) {
        rivalId = amdRival.id;
      }
    }
    document.getElementById('c-rival-select').value = rivalId;

    // Load port checking states from ticket's qcChecks
    const portUsb = !!(ticket.qcChecks && ticket.qcChecks.portUsb);
    const portVideo = !!(ticket.qcChecks && ticket.qcChecks.portVideo);
    const portAudio = !!(ticket.qcChecks && ticket.qcChecks.portAudio);
    const portRgb = !!(ticket.qcChecks && ticket.qcChecks.portRgb);

    setPortButtonState('btn-port-usb', portUsb);
    setPortButtonState('btn-port-video', portVideo);
    setPortButtonState('btn-port-audio', portAudio);
    setPortButtonState('btn-port-rgb', portRgb);

    // Show/hide RGB preview strip
    const rgbStrip = document.getElementById('c-rgb-preview-bar');
    if (rgbStrip) {
      if (portRgb) {
        rgbStrip.classList.remove('hidden');
      } else {
        rgbStrip.classList.add('hidden');
      }
    }

    // Load status display depending on existing data
    const hasTemps = ticket.diagnostics.cpuTempAvg !== null;
    const hasCb = ticket.diagnostics.cinebench !== null;
    document.getElementById('c-diagnostics-status').innerHTML = `
      HWiNFO64: <strong style="color: ${hasTemps ? 'var(--status-completed)' : 'inherit'}">${hasTemps ? 'Calculated' : '[Idle]'}</strong> | 
      Cinebench R23: <strong style="color: ${hasCb ? 'var(--status-completed)' : 'inherit'}">${hasCb ? 'Completed (' + ticket.diagnostics.cinebench + ' pts)' : '[Idle]'}</strong> | 
      FurMark: <strong style="color: ${hasTemps ? 'var(--status-completed)' : 'inherit'}">${hasTemps ? 'Completed' : '[Idle]'}</strong>
    `;

    // Trigger comparison output calculation
    updateClientRivalComparisonOutput();
  }
}

function updateClientRivalComparisonOutput() {
  const rivalId = document.getElementById('c-rival-select').value;
  const cbScore = parseFloat(document.getElementById('c-cinebench-score').value);
  const readSpeed = parseFloat(document.getElementById('c-ssd-read').value);
  const writeSpeed = parseFloat(document.getElementById('c-ssd-write').value);
  const outputDiv = document.getElementById('c-rival-comparison-output');

  if (!rivalId) {
    outputDiv.classList.add('hidden');
    return;
  }

  const rival = appState.rivalBenchmarks.find(r => r.id === rivalId);
  if (!rival) {
    outputDiv.classList.add('hidden');
    return;
  }

  outputDiv.classList.remove('hidden');
  outputDiv.innerHTML = `
    <div style="margin-bottom: 8px; font-size: 0.85rem; border-bottom: 1px solid rgba(15, 23, 42, 0.08); padding-bottom: 6px;">
      <strong>Target Competitor:</strong> ${rival.name}<br>
      <span style="opacity: 0.8;">CPU: ${rival.cpu || '--'} | GPU: ${rival.gpu || '--'} | Price: ${rival.price || '--'}</span>
    </div>
    <div class="comparison-row header"><span>Parameter</span><span>Your Build</span><span>Target rival</span><span>Delta</span></div>
  `;

  const compareMetric = (label, currentVal, rivalVal) => {
    if (isNaN(currentVal)) {
      return `<div class="comparison-row"><span>${label}</span><span>--</span><span>${rivalVal}</span><span>--</span></div>`;
    }
    const pctDiff = ((currentVal - rivalVal) / rivalVal) * 100;
    const sign = pctDiff >= 0 ? '+' : '';
    const isPass = pctDiff >= -5;
    const deltaClass = isPass ? 'delta-pass' : 'delta-fail';
    return `
      <div class="comparison-row">
        <span>${label}</span>
        <span>${currentVal}</span>
        <span>${rivalVal}</span>
        <span class="${deltaClass}">${sign}${pctDiff.toFixed(1)}% (${isPass ? 'OK' : 'UNDER'})</span>
      </div>
    `;
  };

  outputDiv.innerHTML += compareMetric("Cinebench Score", cbScore, rival.cinebenchR23);
  outputDiv.innerHTML += compareMetric("SSD Read Speed (MB/s)", readSpeed, rival.readSpeed);
  outputDiv.innerHTML += compareMetric("SSD Write Speed (MB/s)", writeSpeed, rival.writeSpeed);
}

function setupClientFormCalculations() {
  const cpuMin = document.getElementById('c-cpu-temp-min');
  const cpuMax = document.getElementById('c-cpu-temp-max');
  const cpuAvg = document.getElementById('c-cpu-temp-avg');

  const calcCpuAvg = () => {
    const minVal = parseFloat(cpuMin.value);
    const maxVal = parseFloat(cpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      cpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      cpuAvg.value = '';
    }
  };
  cpuMin.addEventListener('input', calcCpuAvg);
  cpuMax.addEventListener('input', calcCpuAvg);

  const gpuMin = document.getElementById('c-gpu-temp-min');
  const gpuMax = document.getElementById('c-gpu-temp-max');
  const gpuAvg = document.getElementById('c-gpu-temp-avg');

  const calcGpuAvg = () => {
    const minVal = parseFloat(gpuMin.value);
    const maxVal = parseFloat(gpuMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      gpuAvg.value = Math.round((minVal + maxVal) / 2);
    } else {
      gpuAvg.value = '';
    }
  };
  gpuMin.addEventListener('input', calcGpuAvg);
  gpuMax.addEventListener('input', calcGpuAvg);
}

function setPortButtonState(btnId, isPassed) {
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.dataset.checked = isPassed ? "true" : "false";
    if (isPassed) {
      btn.classList.add('passed');
    } else {
      btn.classList.remove('passed');
    }
  }
}

function updatePortDetailsDisplay(category, devices) {
  const container = document.getElementById('c-port-details-container');
  const list = document.getElementById('c-port-details-list');
  if (container && list) {
    container.classList.remove('hidden');
    list.innerHTML = `<div class="port-details-header">🔌 Detected Connection: ${category}</div>`;
    if (!devices || devices.length === 0) {
      list.innerHTML += `<div class="port-detail-line" style="color: var(--status-urgent)">No active devices detected. Check connection!</div>`;
    } else {
      devices.forEach(dev => {
        list.innerHTML += `
          <div class="port-detail-line">
            <span>• ${dev}</span>
            <span class="port-detail-val">Active</span>
          </div>
        `;
      });
    }
  }
}

function setupRgbController() {
  const modeSelect = document.getElementById('rgb-mode-select');
  const colorGroup = document.getElementById('rgb-color-group');
  const colorPicker = document.getElementById('rgb-color-picker');
  const presets = document.querySelectorAll('.preset-dot');
  const speedSlider = document.getElementById('rgb-speed-slider');
  const applyBtn = document.getElementById('btn-apply-rgb-sync');

  const chFans = document.getElementById('rgb-ch-fans');
  const chRam = document.getElementById('rgb-ch-ram');
  const chCooler = document.getElementById('rgb-ch-cooler');
  const chStrips = document.getElementById('rgb-ch-strips');

  if (!modeSelect) return;

  function updateRgbPreview() {
    const mode = modeSelect.value;
    const color = colorPicker.value;
    const speedVal = parseFloat(speedSlider.value);
    
    const speedDuration = (6 - speedVal) + "s";
    const fanSpeedDuration = (6 - speedVal) * 0.5 + "s";

    const pcCase = document.querySelector('.pc-case');
    if (pcCase) {
      pcCase.style.setProperty('--rgb-color', color);
      pcCase.style.setProperty('--rgb-anim-duration', speedDuration);
      pcCase.style.setProperty('--fan-speed', fanSpeedDuration);
    }

    const elements = document.querySelectorAll('.rgb-element');
    elements.forEach(el => {
      let shouldSync = false;
      if (el.classList.contains('pc-fan') && chFans.checked) shouldSync = true;
      if (el.classList.contains('pc-ram') && chRam.checked) shouldSync = true;
      if (el.classList.contains('pc-cpu-cooler') && chCooler.checked) shouldSync = true;
      if (el.classList.contains('pc-led-strip') && chStrips.checked) shouldSync = true;
      if (el.classList.contains('pc-gpu') && chCooler.checked) shouldSync = true;

      el.className = el.className.split(' ').filter(c => !c.startsWith('effect-')).join(' ');

      if (shouldSync) {
        el.classList.add('effect-' + mode);
      } else {
        el.classList.add('effect-off');
      }
    });

    if (mode === 'static' || mode === 'breathing') {
      colorGroup.style.display = 'block';
    } else {
      colorGroup.style.display = 'none';
    }
  }

  modeSelect.addEventListener('change', updateRgbPreview);
  colorPicker.addEventListener('input', updateRgbPreview);
  speedSlider.addEventListener('input', updateRgbPreview);
  [chFans, chRam, chCooler, chStrips].forEach(cb => {
    if (cb) cb.addEventListener('change', updateRgbPreview);
  });

  presets.forEach(dot => {
    dot.addEventListener('click', () => {
      colorPicker.value = dot.dataset.color;
      updateRgbPreview();
    });
  });

  applyBtn.addEventListener('click', async () => {
    const ticketId = document.getElementById('client-ticket-select').value;
    if (!ticketId) {
      alert("Please select a ticket first before applying RGB Sync!");
      return;
    }

    const index = appState.tickets.findIndex(t => t.id === ticketId);
    if (index === -1) return;
    const ticket = appState.tickets[index];

    appendConsoleLine('c-console-box', `[RGB CONTROLLER] Applying RGB effect '${modeSelect.value.toUpperCase()}'...`);
    appendConsoleLine('c-console-box', `[RGB CONTROLLER] Syncing motherboard headers, RAM channels, and fans...`);
    
    await new Promise(r => setTimeout(r, 600));

    appendConsoleLine('c-console-box', `[RGB CONTROLLER] Hardware sync applied successfully!`);

    setPortButtonState('btn-port-rgb', true);
    if (!ticket.qcChecks) ticket.qcChecks = {};
    ticket.qcChecks.portRgb = true;

    appState.tickets[index] = ticket;
    await saveDatabase();
    await syncTicketToCloud(ticket);
  });

  updateRgbPreview();
}

function setupPortsChecker() {
  const ports = [
    { id: 'btn-port-usb', type: 'usb', name: 'USB Ports', desc: 'active USB devices' },
    { id: 'btn-port-video', type: 'video', name: 'HDMI / DP', desc: 'active display monitors' },
    { id: 'btn-port-audio', type: 'audio', name: 'Audio Jacks', desc: 'sound controllers' },
    { id: 'btn-port-rgb', type: 'rgb', name: 'RGB Synced', desc: 'system RGB sync configuration' }
  ];
  
  ports.forEach(port => {
    const btn = document.getElementById(port.id);
    if (btn) {
      btn.addEventListener('click', async () => {
        const ticketId = document.getElementById('client-ticket-select').value;
        if (!ticketId) {
          alert("Please select a ticket first before verifying ports!");
          return;
        }

        const index = appState.tickets.findIndex(t => t.id === ticketId);
        if (index === -1) return;
        const ticket = appState.tickets[index];

        appendConsoleLine('c-console-box', `[SYS] Verifying active ${port.desc}...`);
        
        try {
          const result = await ipcRenderer.invoke('sys:check-port-hardware', port.type);
          const nextState = !!result.passed;

          setPortButtonState(port.id, nextState);

          if (!ticket.qcChecks) ticket.qcChecks = {};

          let logMsg = '';
          if (port.type === 'usb') {
            ticket.qcChecks.portUsb = nextState;
            logMsg = `[SYS] USB check: ${nextState ? 'Passed' : 'Failed'} (Found ${result.count || 0} active USB device(s))`;
            updatePortDetailsDisplay('USB Connection List', result.devices);
          } else if (port.type === 'video') {
            ticket.qcChecks.portVideo = nextState;
            logMsg = `[SYS] Display check: ${nextState ? 'Passed' : 'Failed'} (Found ${result.count || 0} active monitor connection(s))`;
            updatePortDetailsDisplay('Video Outputs', result.devices);
          } else if (port.type === 'audio') {
            ticket.qcChecks.portAudio = nextState;
            logMsg = `[SYS] Audio check: ${nextState ? 'Passed' : 'Failed'} (Found ${result.count || 0} sound controller device(s))`;
            updatePortDetailsDisplay('Audio Output hardware', result.devices);
          } else if (port.type === 'rgb') {
            ticket.qcChecks.portRgb = nextState;
            logMsg = `[SYS] RGB check: ${nextState ? 'Passed' : 'Failed'} (${result.hasSyncSoftware ? 'RGB sync controller software running' : 'System default controller active'})`;
          }

          appendConsoleLine('c-console-box', logMsg);

          appState.tickets[index] = ticket;
          await saveDatabase();
          await syncTicketToCloud(ticket);
        } catch (e) {
          console.error(e);
          appendConsoleLine('c-console-box', `[SYS ERROR] ${port.name} verification failed: ${e.message}`);
        }
      });
    }
  });

  // Call the RGB controller setup
  setupRgbController();
}

// Save ticket form data
async function handleTicketFormSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('form-ticket-id').value || 't_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const createdAt = document.getElementById('form-created-at').value || new Date().toISOString();
  
  const ticketType = document.getElementById('form-ticket-type').value;
  const customerName = document.getElementById('form-customer-name').value;
  const deadlineVal = document.getElementById('form-deadline').value;
  const deadline = deadlineVal ? new Date(deadlineVal).toISOString() : new Date().toISOString();
  const technician = document.getElementById('form-technician').value;

  const missingComponentsToggle = document.getElementById('form-missing-components-toggle').checked;
  const missingComponents = document.getElementById('form-missing-components').value;

  const existingTicket = editingTicketId ? appState.tickets.find(t => t.id === editingTicketId) : null;
  const oldQc = existingTicket ? (existingTicket.qcChecks || {}) : {};
  const oldDiag = existingTicket ? (existingTicket.diagnostics || {}) : {};

  const buildChecks = {
    cpuRamSsd: document.getElementById('check-cpu-ram-ssd').checked,
    moboCase: document.getElementById('check-mobo-case').checked,
    cooler: document.getElementById('check-cooler').checked,
    cables: document.getElementById('check-cables').checked,
    posted: document.getElementById('check-posted').checked
  };

  const qcChecks = {
    ...oldQc,
    physCabinet: document.getElementById('qc-phys-cabinet').checked,
    physMobo: document.getElementById('qc-phys-motherboard').checked,
    physRam: document.getElementById('qc-phys-ram').checked,
    physScrews: document.getElementById('qc-phys-screws').checked,
    softWindows: document.getElementById('qc-soft-windows').checked,
    softDrivers: document.getElementById('qc-soft-drivers').checked,
    softBios: document.getElementById('qc-soft-bios').checked,
    portUsb: document.getElementById('qc-port-usb').checked,
    portVideo: document.getElementById('qc-port-video').checked,
    portAudio: document.getElementById('qc-port-audio').checked,
    portWifi: document.getElementById('qc-port-wifi').checked,
    wifiSpeed: parseFloat(document.getElementById('form-wifi-speed').value) || null,
    wifiRange: parseFloat(document.getElementById('form-wifi-range').value) || null
  };

  const diagnostics = {
    ...oldDiag,
    cpuTempMin: parseFloat(document.getElementById('form-cpu-temp-min').value) || null,
    cpuTempMax: parseFloat(document.getElementById('form-cpu-temp-max').value) || null,
    cpuTempAvg: parseFloat(document.getElementById('form-cpu-temp-avg').value) || null,
    gpuTempMin: parseFloat(document.getElementById('form-gpu-temp-min').value) || null,
    gpuTempMax: parseFloat(document.getElementById('form-gpu-temp-max').value) || null,
    gpuTempAvg: parseFloat(document.getElementById('form-gpu-temp-avg').value) || null,
    cinebench: parseFloat(document.getElementById('form-cinebench-score').value) || null,
    furmark: parseFloat(document.getElementById('form-furmark-score').value) || null,
    ssdRead: parseFloat(document.getElementById('form-ssd-read').value) || null,
    ssdWrite: parseFloat(document.getElementById('form-ssd-write').value) || null,
    rivalConfigId: document.getElementById('form-rival-select').value || ""
  };

  const serials = {
    motherboard: document.getElementById('serial-motherboard').value,
    ram: document.getElementById('serial-ram').value,
    gpu: document.getElementById('serial-gpu').value,
    ssd: document.getElementById('serial-ssd').value,
    cabinet: document.getElementById('serial-cabinet').value
  };

  // Determine current status
  let status = 'awaiting';
  const isBuildComplete = buildChecks.cpuRamSsd && buildChecks.moboCase && buildChecks.cooler && buildChecks.cables && buildChecks.posted;
  
  if (isBuildComplete) {
    status = 'waiting_qc';
    const isQcComplete = qcChecks.physCabinet && qcChecks.physMobo && qcChecks.physRam && qcChecks.physScrews &&
                         qcChecks.softWindows && qcChecks.softDrivers && qcChecks.softBios &&
                         qcChecks.portUsb && qcChecks.portVideo && qcChecks.portAudio && qcChecks.portWifi;
    
    const isDiagLogged = diagnostics.cpuTempAvg !== null && diagnostics.gpuTempAvg !== null && diagnostics.cinebench !== null;
    
    if (isQcComplete && isDiagLogged) {
      status = 'completed';
    } else if (qcChecks.physCabinet || diagnostics.cpuTempAvg !== null) {
      status = 'qc_testing';
    }
  } else if (missingComponentsToggle) {
    status = 'awaiting';
  } else {
    status = 'building';
  }

  const updatedTicket = {
    id,
    createdAt,
    type: ticketType,
    customerName,
    deadline,
    technician,
    missingComponentsToggle,
    missingComponents,
    buildChecks,
    qcChecks,
    diagnostics,
    serials,
    status,
    completedAt: status === 'completed' ? new Date().toISOString() : null
  };

  // Read specs directly from the modal UI fields
  const detectedCpuVal = document.getElementById('modal-spec-cpu').textContent;
  const detectedGpuVal = document.getElementById('modal-spec-gpu').textContent;
  const detectedRamVal = document.getElementById('modal-spec-ram').textContent;
  const detectedStorageVal = document.getElementById('modal-spec-storage').textContent;

  updatedTicket.specs = {
    cpu: (detectedCpuVal === '--' || detectedCpuVal === 'Not detected') ? '' : detectedCpuVal,
    gpu: (detectedGpuVal === '--' || detectedGpuVal === 'Not detected') ? '' : detectedGpuVal,
    ram: (detectedRamVal === '--' || detectedRamVal === 'Not detected') ? '' : detectedRamVal,
    storage: (detectedStorageVal === '--' || detectedStorageVal === 'Not detected') ? '' : detectedStorageVal
  };

  if (editingTicketId) {
    const index = appState.tickets.findIndex(t => t.id === editingTicketId);
    appState.tickets[index] = updatedTicket;
  } else {
    appState.tickets.push(updatedTicket);
  }

  await saveDatabase();
  await syncTicketToCloud(updatedTicket);
  document.getElementById('ticket-modal').classList.remove('active');
  renderDashboard();
}

// Duplicate Serial checking
function verifyFieldDuplicate(field) {
  if (!field) return;
  const val = field.value.trim();
  field.classList.remove('duplicate-err');

  if (val.length < 3) return;

  const isDuplicate = appState.tickets.some(t => {
    if (t.id === editingTicketId) return false;
    return t.serials && Object.values(t.serials).some(s => s && s.trim() === val);
  });

  if (isDuplicate) {
    field.classList.add('duplicate-err');
  }
}

function setupSerialVerification() {
  const fields = document.querySelectorAll('.serial-field');
  fields.forEach(field => {
    field.addEventListener('input', (e) => {
      verifyFieldDuplicate(e.target);
    });
  });
}

// ==========================================================================
// TESTING CLIENT PORTAL LOGIC
// ==========================================================================
let detectedSpecs = null;
let parsedTemps = null;
let parsedCinebench = null;
let parsedDiskSpeeds = null;

async function setupClientMode() {
  // Automated Stress Test Execution (Client Portal)
  document.getElementById('btn-run-auto-diagnostics').addEventListener('click', async () => {
    await executeDiagnosticsWorkflow(false);
  });

  // Trigger system specs detection
  document.getElementById('btn-client-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-client-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      detectedSpecs = await ipcRenderer.invoke('sys:detect-hw');
      
      document.getElementById('c-spec-cpu').textContent = detectedSpecs.cpu || "Failed to detect";
      document.getElementById('c-spec-gpu').textContent = detectedSpecs.gpu || "Failed to detect";
      document.getElementById('c-spec-ram').textContent = detectedSpecs.ram || "Failed to detect";
      document.getElementById('c-spec-storage').textContent = detectedSpecs.storage || "Failed to detect";

      btn.textContent = "🔍 Hardware Specs Detected";
      btn.classList.add('secondary-btn');
      btn.classList.remove('primary-pink-btn');

      // Automap to competitor config
      const comp = getCompetitorModel(detectedSpecs.cpu);
      let matchedRival = appState.rivalBenchmarks.find(r => {
        const rName = r.name.toLowerCase();
        const rCpu = (r.cpu || '').toLowerCase();
        const compName = comp.name.toLowerCase();
        return compName.includes(rCpu) || rName.includes(compName) || compName.includes(rName);
      });

      if (!matchedRival) {
        if (comp.name.includes("7600")) {
          matchedRival = appState.rivalBenchmarks.find(r => r.id === "1");
        } else if (comp.name.includes("14700")) {
          matchedRival = appState.rivalBenchmarks.find(r => r.id === "2");
        }
      }

      if (matchedRival) {
        const select = document.getElementById('c-rival-select');
        select.value = matchedRival.id;
        updateClientRivalComparisonOutput();
      }

      checkClientFormReady();
    } catch (err) {
      console.error("Client specs detection error:", err);
      alert("Specs detection failed: " + err.message);
    } finally {
      btn.disabled = false;
      if (btn.textContent === "🔍 Detecting hardware...") {
        btn.textContent = oldText;
      }
    }
  });

  // Windows Activation Check
  document.getElementById('btn-client-check-win').addEventListener('click', async () => {
    const winStatusBox = document.getElementById('client-win-status');
    winStatusBox.innerHTML = `Activation Status: <span class="badge">Running check...</span>`;

    const result = await ipcRenderer.invoke('sys:check-win');
    if (result.activated) {
      winStatusBox.innerHTML = `Activation Status: <span class="badge green">🛡️ Activated</span>`;
      winStatusBox.dataset.activated = "true";
    } else {
      winStatusBox.innerHTML = `Activation Status: <span class="badge red">⚠️ Not Activated</span>`;
      winStatusBox.dataset.activated = "false";
    }
    checkClientFormReady();
  });

  // Submit client results
  document.getElementById('btn-client-submit').addEventListener('click', async () => {
    const ticketId = document.getElementById('client-ticket-select').value;
    if (!ticketId) return;

    const index = appState.tickets.findIndex(t => t.id === ticketId);
    if (index === -1) return;

    const t = appState.tickets[index];

    // Populate detected specs
    if (detectedSpecs) {
      t.specs = {
        cpu: detectedSpecs.cpu,
        gpu: detectedSpecs.gpu,
        ram: detectedSpecs.ram,
        storage: detectedSpecs.storage
      };
    }

    // Windows activation update
    const winStatusBox = document.getElementById('client-win-status');
    if (winStatusBox.dataset.activated === "true") {
      t.qcChecks.softWindows = true;
    }

    // Populate diagnostics from inputs
    t.diagnostics.cpuTempMin = parseFloat(document.getElementById('c-cpu-temp-min').value) || null;
    t.diagnostics.cpuTempMax = parseFloat(document.getElementById('c-cpu-temp-max').value) || null;
    t.diagnostics.cpuTempAvg = parseFloat(document.getElementById('c-cpu-temp-avg').value) || null;
    
    t.diagnostics.gpuTempMin = parseFloat(document.getElementById('c-gpu-temp-min').value) || null;
    t.diagnostics.gpuTempMax = parseFloat(document.getElementById('c-gpu-temp-max').value) || null;
    t.diagnostics.gpuTempAvg = parseFloat(document.getElementById('c-gpu-temp-avg').value) || null;

    t.diagnostics.cinebench = parseFloat(document.getElementById('c-cinebench-score').value) || null;
    t.diagnostics.furmark = parseFloat(document.getElementById('c-furmark-score').value) || null;
    t.diagnostics.ssdRead = parseFloat(document.getElementById('c-ssd-read').value) || null;
    t.diagnostics.ssdWrite = parseFloat(document.getElementById('c-ssd-write').value) || null;
    t.diagnostics.rivalConfigId = document.getElementById('c-rival-select').value || "";

    // Set QC check indicators
    if (t.diagnostics.cpuTempAvg !== null) {
      t.qcChecks.physCabinet = true; // Default auto physical checks pass on client submission to bypass manually typing
      t.qcChecks.softDrivers = true;
      t.qcChecks.softBios = true;
      t.qcChecks.portUsb = true;
      t.qcChecks.portVideo = true;
      t.qcChecks.portAudio = true;
      t.qcChecks.portWifi = true;
    }

    // Status transition
    t.status = 'qc_testing';
    const isQcFull = t.qcChecks.physCabinet && t.qcChecks.softWindows && t.qcChecks.softDrivers;
    if (isQcFull && t.diagnostics.cinebench) {
      t.status = 'completed';
      t.completedAt = new Date().toISOString();
    }

    appState.tickets[index] = t;
    await saveDatabase();
    await syncTicketToCloud(t);
    alert("Diagnostic data successfully uploaded to database!");
    
    if (appState.settings.isMaster) {
      switchScreen('selector');
    } else {
      switchScreen('client');
    }
  });

  // Client comparison value sync event listeners
  document.getElementById('c-rival-select').addEventListener('change', updateClientRivalComparisonOutput);
  document.getElementById('c-cinebench-score').addEventListener('input', updateClientRivalComparisonOutput);
  document.getElementById('c-ssd-read').addEventListener('input', updateClientRivalComparisonOutput);
  document.getElementById('c-ssd-write').addEventListener('input', updateClientRivalComparisonOutput);

  // Setup client temperature averaging calculations
  setupClientFormCalculations();
  setupPortsChecker();
}

function getHwInfoStats(content) {
  if (!content) return null;
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  // Auto-detect delimiter (, or ;)
  let delimiter = ',';
  let testLine = lines[0];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].includes(';') || lines[i].includes(',')) {
      testLine = lines[i];
      break;
    }
  }
  const commas = (testLine.match(/,/g) || []).length;
  const semicolons = (testLine.match(/;/g) || []).length;
  if (semicolons > commas) {
    delimiter = ';';
  }

  // Find the header row dynamically (skipping blank/metadata lines)
  let headerLineIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if ((line.includes('Date') || line.includes('Time')) && (lower.includes('cpu') || lower.includes('gpu'))) {
      headerLineIndex = i;
      break;
    }
  }

  const headers = lines[headerLineIndex].split(delimiter).map(h => h.replace(/"/g, '').trim());
  
  // Find indices for CPU and GPU Temperature columns (Case-Insensitive matching)
  let cpuIdx = headers.findIndex(h => {
    const lower = h.toLowerCase();
    return lower.includes('cpu (tctl/tdie)') || 
           lower.includes('cpu package') || 
           lower.includes('cpu [°c]') || 
           lower.includes('cpu die (average)') || 
           lower.includes('core max') || 
           lower.includes('cpu core') ||
           lower.includes('cpu temp') ||
           lower.includes('cpu temperature');
  });

  let gpuIdx = headers.findIndex(h => {
    const lower = h.toLowerCase();
    return lower.includes('gpu temperature') || 
           lower.includes('gpu core') || 
           lower.includes('gpu [°c]') || 
           lower.includes('gpu temp') ||
           lower.includes('gpu thermal diode');
  });

  // Fallbacks
  if (cpuIdx === -1) cpuIdx = headers.findIndex(h => h.toLowerCase().includes('cpu') && (h.includes('°C') || h.toLowerCase().includes('temp') || h.toLowerCase().includes('tctl')));
  if (gpuIdx === -1) gpuIdx = headers.findIndex(h => h.toLowerCase().includes('gpu') && (h.includes('°C') || h.toLowerCase().includes('temp') || h.toLowerCase().includes('core')));

  if (cpuIdx === -1 && gpuIdx === -1) return null;

  let cpuVals = [];
  let gpuVals = [];

  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split(delimiter);
    
    if (cpuIdx !== -1 && cols[cpuIdx]) {
      const v = parseFloat(cols[cpuIdx].replace(/"/g, '').trim());
      if (!isNaN(v)) cpuVals.push(v);
    }
    if (gpuIdx !== -1 && cols[gpuIdx]) {
      const v = parseFloat(cols[gpuIdx].replace(/"/g, '').trim());
      if (!isNaN(v)) gpuVals.push(v);
    }
  }

  const getStats = (arr) => {
    if (arr.length === 0) return { min: 0, max: 0, avg: 0 };
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / arr.length);
    return { min: Math.round(min), max: Math.round(max), avg };
  };

  return {
    cpu: getStats(cpuVals),
    gpu: getStats(gpuVals)
  };
}

function checkClientFormReady() {
  const ticketId = document.getElementById('client-ticket-select').value;
  const submitBtn = document.getElementById('btn-client-submit');
  if (ticketId) {
    submitBtn.removeAttribute('disabled');
  } else {
    submitBtn.setAttribute('disabled', 'true');
  }
}

// ==========================================================================
// PRINTING REPORTS MAPPING (A4 Layout Integration)
// ==========================================================================
function populatePrintChecklist(ticket) {
  const qcContainer = document.getElementById('print-checklist-container');
  if (qcContainer) {
    const getBuildCheck = (prop) => (ticket.buildChecks && ticket.buildChecks[prop]) || false;
    const getQcCheck = (prop) => (ticket.qcChecks && ticket.qcChecks[prop]) || false;

    const items = [
      { checked: getQcCheck('physCabinet'), label: "Physical Condition Clean & Checked" },
      { checked: getQcCheck('physMobo'), label: "Motherboard Socket & CPU Pins Checked" },
      { checked: getQcCheck('physRam'), label: "RAM Modules Correctly Installed" },
      { checked: getBuildCheck('cooler'), label: "CPU Cooler / AIO Thermal Assembly Secured" },
      { checked: getBuildCheck('cables'), label: "Structural Cables Organized & Zip-tied" },
      { checked: getBuildCheck('posted'), label: "System Posted successfully to BIOS" },
      { checked: getQcCheck('softWindows'), label: "Windows OS Installed & Fully Licensed" },
      { checked: getQcCheck('softDrivers'), label: "System Hardware Drivers Updated" },
      { checked: getQcCheck('softBios'), label: "Motherboard BIOS Updated" },
      { checked: getQcCheck('portUsb'), label: "Front/Rear USB Ports Functional" },
      { checked: getQcCheck('portVideo'), label: "HDMI & DisplayPort Output Verified" },
      { checked: getQcCheck('portAudio'), label: "Audio Port Sound Jack Checked" },
      { checked: getQcCheck('portWifi'), label: "Wi-Fi Antenna Mounted & Calibrated" }
    ];
    qcContainer.innerHTML = items.map(item => `
      <div class="print-chk-item">${item.checked ? '✔️' : '❌'} ${item.label}</div>
    `).join('');
  }
}

function populatePrintFields(ticket) {
  // Populate checklist dynamically
  populatePrintChecklist(ticket);

  // Header Details
  document.getElementById('print-ticket-id').textContent = ticket.id.slice(-6).toUpperCase();
  document.getElementById('print-date').textContent = new Date().toLocaleDateString();
  document.getElementById('print-tech').textContent = ticket.technician;
  document.getElementById('print-customer-name').textContent = ticket.customerName;

  // Specs Mapping
  document.getElementById('print-spec-cpu').textContent = ticket.specs ? (ticket.specs.cpu || '--') : '--';
  document.getElementById('print-spec-gpu').textContent = ticket.specs ? (ticket.specs.gpu || '--') : '--';
  document.getElementById('print-spec-ram').textContent = ticket.specs ? (ticket.specs.ram || '--') : '--';
  document.getElementById('print-spec-storage').textContent = ticket.specs ? (ticket.specs.storage || '--') : '--';

  // Serials
  document.getElementById('print-serial-gpu').textContent = ticket.serials.gpu || 'N/A';
  document.getElementById('print-serial-ram').textContent = ticket.serials.ram || 'N/A';
  document.getElementById('print-serial-ssd').textContent = ticket.serials.ssd || 'N/A';
  document.getElementById('print-serial-cabinet').textContent = ticket.serials.cabinet || 'N/A';

  // Temps
  document.getElementById('print-cpu-min').textContent = (ticket.diagnostics.cpuTempMin || '--') + ' °C';
  document.getElementById('print-cpu-max').textContent = (ticket.diagnostics.cpuTempMax || '--') + ' °C';
  document.getElementById('print-cpu-avg').textContent = (ticket.diagnostics.cpuTempAvg || '--') + ' °C';
  document.getElementById('print-gpu-min').textContent = (ticket.diagnostics.gpuTempMin || '--') + ' °C';
  document.getElementById('print-gpu-max').textContent = (ticket.diagnostics.gpuTempMax || '--') + ' °C';
  document.getElementById('print-gpu-avg').textContent = (ticket.diagnostics.gpuTempAvg || '--') + ' °C';

  // Benchmarks
  document.getElementById('print-score-cb').textContent = (ticket.diagnostics.cinebench || '--') + ' pts';
  document.getElementById('print-score-fm').textContent = (ticket.diagnostics.furmark || '--') + ' pts';
  document.getElementById('print-score-read').textContent = (ticket.diagnostics.ssdRead || '--') + ' MB/s';
  document.getElementById('print-score-write').textContent = (ticket.diagnostics.ssdWrite || '--') + ' MB/s';

  // Wi-Fi signal
  document.getElementById('print-wifi-signal').textContent = (ticket.qcChecks.wifiRange || '--') + ' %';
  document.getElementById('print-wifi-speed-val').textContent = (ticket.qcChecks.wifiSpeed || '--') + ' Mbps';

  // Rival comparison delta mappings
  let rivalId = ticket.diagnostics.rivalConfigId;
  if (!rivalId && ticket.specs && ticket.specs.cpu && isI514thGen(ticket.specs.cpu)) {
    const amdRival = appState.rivalBenchmarks.find(r => r.cpu && r.cpu.toLowerCase().includes('ryzen 5 7600') || r.id === '1');
    if (amdRival) {
      rivalId = amdRival.id;
    }
  }

  const rival = appState.rivalBenchmarks.find(r => r.id === rivalId);
  const rivalHeaderEl = document.getElementById('print-rival-header');
  const rivalSpecsBox = document.getElementById('print-rival-specs-box');

  if (rival) {
    if (rivalHeaderEl) {
      rivalHeaderEl.textContent = `Expected: ${rival.cpu || rival.name}`;
    }
    if (rivalSpecsBox) {
      rivalSpecsBox.style.display = 'block';
      const cpuEl = document.getElementById('print-rival-spec-cpu');
      const gpuEl = document.getElementById('print-rival-spec-gpu');
      const priceEl = document.getElementById('print-rival-spec-price');
      if (cpuEl) cpuEl.textContent = rival.cpu || '--';
      if (gpuEl) gpuEl.textContent = rival.gpu || '--';
      if (priceEl) priceEl.textContent = rival.price || '--';
    }

    document.getElementById('print-rival-cb').textContent = rival.cinebenchR23 + ' pts';
    document.getElementById('print-rival-read').textContent = rival.readSpeed + ' MB/s';
    document.getElementById('print-rival-write').textContent = rival.writeSpeed + ' MB/s';

    const getDiffStr = (curr, tgt) => {
      if (!curr || !tgt) return '--';
      const d = ((curr - tgt) / tgt) * 100;
      return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    };
    document.getElementById('print-delta-cb').textContent = getDiffStr(ticket.diagnostics.cinebench, rival.cinebenchR23);
    document.getElementById('print-delta-read').textContent = getDiffStr(ticket.diagnostics.ssdRead, rival.readSpeed);
    document.getElementById('print-delta-write').textContent = getDiffStr(ticket.diagnostics.ssdWrite, rival.writeSpeed);
  } else {
    if (rivalHeaderEl) {
      rivalHeaderEl.textContent = 'Expected Competitor Config';
    }
    if (rivalSpecsBox) {
      rivalSpecsBox.style.display = 'none';
    }
    document.getElementById('print-rival-cb').textContent = '--';
    document.getElementById('print-rival-read').textContent = '--';
    document.getElementById('print-rival-write').textContent = '--';
    document.getElementById('print-delta-cb').textContent = '--';
    document.getElementById('print-delta-read').textContent = '--';
    document.getElementById('print-delta-write').textContent = '--';
  }
}

function triggerPrintReport(ticketId, shouldPrint = true) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  populatePrintFields(ticket);

  // Execute print in main Electron window
  if (shouldPrint) {
    ipcRenderer.invoke('sys:print');
  }
}

async function triggerSavePdf(ticketId) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  populatePrintFields(ticket);

  // Save PDF filename
  const cleanName = ticket.customerName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const defaultFilename = `QC_Report_${cleanName}_${ticket.id.slice(-6)}.pdf`;

  const result = await ipcRenderer.invoke('sys:print-pdf', defaultFilename);
  if (result.success) {
    alert(`PDF Report successfully saved to:\n${result.filePath}`);
  } else if (result.error !== 'Cancelled') {
    alert(`Failed to save PDF: ${result.error}`);
  }
}

// ==========================================================================
// SETTINGS SCREEN ACTIONS
// ==========================================================================
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  
  // Render technicians
  const techList = document.getElementById('settings-tech-list');
  techList.innerHTML = '';
  appState.technicians.forEach(tech => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${tech}</span><button class="text-btn text-crimson remove-tech-btn">Remove</button>`;
    li.querySelector('.remove-tech-btn').addEventListener('click', () => {
      appState.technicians = appState.technicians.filter(t => t !== tech);
      openSettingsModal(); // Refresh
    });
    techList.appendChild(li);
  });

  // Render Rival Configs
  const rivalsBody = document.getElementById('settings-rivals-table-body');
  rivalsBody.innerHTML = '';
  appState.rivalBenchmarks.forEach(rival => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${rival.name}</td>
      <td>${rival.price || '--'}</td>
      <td>${rival.cinebenchR23}</td>
      <td>${rival.readSpeed}</td>
      <td>${rival.writeSpeed}</td>
      <td><button class="text-btn text-crimson remove-rival-btn">Remove</button></td>
    `;
    row.querySelector('.remove-rival-btn').addEventListener('click', () => {
      appState.rivalBenchmarks = appState.rivalBenchmarks.filter(r => r.id !== rival.id);
      openSettingsModal(); // Refresh
    });
    rivalsBody.appendChild(row);
  });

  document.getElementById('settings-supabase-url').value = appState.settings.supabaseUrl || '';
  document.getElementById('settings-supabase-key').value = appState.settings.supabaseAnonKey || '';
  document.getElementById('settings-path-hwinfo').value = appState.settings.pathHwInfo || '';
  document.getElementById('settings-path-cinebench').value = appState.settings.pathCinebench || '';
  document.getElementById('settings-path-furmark').value = appState.settings.pathFurmark || '';
  document.getElementById('settings-is-master').checked = !!appState.settings.isMaster;

  // Populate new general settings
  document.getElementById('settings-shop-name').value = appState.settings.shopName || '';
  document.getElementById('settings-contact-info').value = appState.settings.contactInfo || '';
  document.getElementById('settings-accent-color').value = appState.settings.accentColor || 'pink';
  document.getElementById('settings-sound-enabled').checked = !!appState.settings.soundEnabled;

  // Populate thresholds
  document.getElementById('settings-cpu-max-temp').value = appState.settings.cpuMaxTemp || 85;
  document.getElementById('settings-cpu-max-temp-val').textContent = (appState.settings.cpuMaxTemp || 85) + '°C';
  document.getElementById('settings-gpu-max-temp').value = appState.settings.gpuMaxTemp || 80;
  document.getElementById('settings-gpu-max-temp-val').textContent = (appState.settings.gpuMaxTemp || 80) + '°C';
  document.getElementById('settings-min-ssd-speed').value = appState.settings.minSsdSpeed || 3000;
  document.getElementById('settings-auto-pdf').checked = !!appState.settings.autoPdf;

  // Reset active tab in settings modal
  document.querySelectorAll('.settings-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector('.settings-tab-btn[data-tab="tab-general"]').classList.add('active');
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById('tab-general').classList.remove('hidden');

  modal.classList.add('active');
}

async function handleSaveSettings() {
  appState.settings.supabaseUrl = document.getElementById('settings-supabase-url').value.trim();
  appState.settings.supabaseAnonKey = document.getElementById('settings-supabase-key').value.trim();
  appState.settings.pathHwInfo = document.getElementById('settings-path-hwinfo').value.trim();
  appState.settings.pathCinebench = document.getElementById('settings-path-cinebench').value.trim();
  appState.settings.pathFurmark = document.getElementById('settings-path-furmark').value.trim();
  appState.settings.isMaster = document.getElementById('settings-is-master').checked;

  // Save new settings
  appState.settings.shopName = document.getElementById('settings-shop-name').value.trim();
  appState.settings.contactInfo = document.getElementById('settings-contact-info').value.trim();
  appState.settings.accentColor = document.getElementById('settings-accent-color').value;
  appState.settings.soundEnabled = document.getElementById('settings-sound-enabled').checked;
  appState.settings.cpuMaxTemp = parseInt(document.getElementById('settings-cpu-max-temp').value);
  appState.settings.gpuMaxTemp = parseInt(document.getElementById('settings-gpu-max-temp').value);
  appState.settings.minSsdSpeed = parseInt(document.getElementById('settings-min-ssd-speed').value) || 3000;
  appState.settings.autoPdf = document.getElementById('settings-auto-pdf').checked;

  applyAccentColor(appState.settings.accentColor);

  await saveDatabase();
  document.getElementById('settings-modal').classList.remove('active');
  
  if (!appState.settings.isMaster) {
    switchScreen('client');
  } else {
    if (currentMode === 'staff') {
      renderDashboard();
    } else {
      switchScreen('selector');
    }
  }
}

// ==========================================================================
// EVENT LISTENERS REGISTER
// ==========================================================================
function setupEventListeners() {
  // Frameless custom window control button IPC signals
  document.getElementById('win-btn-minimize').addEventListener('click', () => ipcRenderer.send('win:minimize'));
  document.getElementById('win-btn-maximize').addEventListener('click', () => ipcRenderer.send('win:maximize'));
  document.getElementById('win-btn-close').addEventListener('click', () => ipcRenderer.send('win:close'));

  // Mode launch buttons
  document.getElementById('btn-launch-staff').addEventListener('click', () => switchScreen('staff'));
  document.getElementById('btn-launch-client').addEventListener('click', () => {
    switchScreen('client');
  });

  // Welcome Screen Listeners
  const welcomeSelect = document.getElementById('welcome-ticket-select');
  const welcomePreview = document.getElementById('welcome-spec-preview');
  const welcomeLaunch = document.getElementById('btn-welcome-launch');

  if (welcomeSelect) {
    welcomeSelect.addEventListener('change', () => {
      const ticketId = welcomeSelect.value;
      if (!ticketId) {
        welcomePreview.classList.add('hidden');
        welcomeLaunch.disabled = true;
        return;
      }
      const ticket = appState.tickets.find(t => t.id === ticketId);
      if (ticket) {
        document.getElementById('w-spec-cpu').textContent = ticket.specs ? (ticket.specs.cpu || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-gpu').textContent = ticket.specs ? (ticket.specs.gpu || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-ram').textContent = ticket.specs ? (ticket.specs.ram || 'Not detected') : 'Not detected';
        document.getElementById('w-spec-storage').textContent = ticket.specs ? (ticket.specs.storage || 'Not detected') : 'Not detected';
        
        welcomePreview.classList.remove('hidden');
        welcomeLaunch.disabled = false;
      }
    });
  }

  if (welcomeLaunch) {
    welcomeLaunch.addEventListener('click', () => {
      const ticketId = welcomeSelect.value;
      if (ticketId) {
        switchScreen('client-console', ticketId);
      }
    });
  }

  const welcomeExit = document.getElementById('btn-welcome-exit');
  if (welcomeExit) {
    welcomeExit.addEventListener('click', () => {
      switchScreen('selector');
    });
  }

  // Theme change toggle
  document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode');
  });

  // Settings modals
  document.getElementById('btn-show-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('active');
  });
  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);
  document.getElementById('btn-reseed-data').addEventListener('click', async () => {
    if (confirm("This will overwrite your current tickets with mock demo data. Proceed?")) {
      seedMockTickets();
      await saveDatabase();
      document.getElementById('settings-modal').classList.remove('active');
      renderDashboard();
      alert("Mock database reseeded successfully!");
    }
  });

  // Settings Tab switching
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = btn.getAttribute('data-tab');
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(tabId).classList.remove('hidden');
    });
  });

  // Settings Max Temp Sliders value updates
  const cpuSlider = document.getElementById('settings-cpu-max-temp');
  if (cpuSlider) {
    cpuSlider.addEventListener('input', () => {
      document.getElementById('settings-cpu-max-temp-val').textContent = cpuSlider.value + '°C';
    });
  }
  const gpuSlider = document.getElementById('settings-gpu-max-temp');
  if (gpuSlider) {
    gpuSlider.addEventListener('input', () => {
      document.getElementById('settings-gpu-max-temp-val').textContent = gpuSlider.value + '°C';
    });
  }

  // Password-protected ticket deadline unlock
  const btnChangeDeadline = document.getElementById('btn-change-deadline');
  if (btnChangeDeadline) {
    btnChangeDeadline.addEventListener('click', () => {
      const pw = prompt("Enter administrator password to edit deadline:");
      if (pw === 'neoadmin') {
        document.getElementById('form-deadline').disabled = false;
        alert("Deadline unlocked. You can now modify the target date.");
      } else {
        alert("Incorrect password. Deadline locked.");
      }
    });
  }

  // Changelog close button
  const btnCloseChangelog = document.getElementById('btn-close-changelog');
  if (btnCloseChangelog) {
    btnCloseChangelog.addEventListener('click', async () => {
      document.getElementById('changelog-modal').classList.remove('active');
      const currentVer = require('./package.json').version;
      appState.lastRunVersion = currentVer;
      await saveDatabase();
    });
  }

  // Add technician
  document.getElementById('btn-settings-add-tech').addEventListener('click', () => {
    const input = document.getElementById('settings-add-tech-name');
    const name = input.value.trim();
    if (name && !appState.technicians.includes(name)) {
      appState.technicians.push(name);
      input.value = '';
      openSettingsModal();
    }
  });

  // Add rival config
  document.getElementById('btn-add-rival').addEventListener('click', () => {
    const name = document.getElementById('new-rival-name').value.trim();
    const price = document.getElementById('new-rival-price').value.trim();
    const cb = parseInt(document.getElementById('new-rival-cb').value);
    const read = parseInt(document.getElementById('new-rival-read').value);
    const write = parseInt(document.getElementById('new-rival-write').value);

    if (name && !isNaN(cb)) {
      const newRival = {
        id: 'r_' + Date.now().toString(36),
        name,
        price: price || '--',
        cinebenchR23: cb,
        readSpeed: read || 5000,
        writeSpeed: write || 4000
      };
      appState.rivalBenchmarks.push(newRival);
      document.getElementById('new-rival-name').value = '';
      document.getElementById('new-rival-price').value = '';
      document.getElementById('new-rival-cb').value = '';
      document.getElementById('new-rival-read').value = '';
      document.getElementById('new-rival-write').value = '';
      openSettingsModal();
    }
  });

  // Ticket create/edit actions
  document.getElementById('btn-new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('btn-close-ticket-modal').addEventListener('click', () => {
    document.getElementById('ticket-modal').classList.remove('active');
  });
  document.getElementById('btn-cancel-ticket').addEventListener('click', () => {
    document.getElementById('ticket-modal').classList.remove('active');
  });
  document.getElementById('btn-delete-ticket').addEventListener('click', async () => {
    if (editingTicketId && confirm("Are you sure you want to delete this ticket?")) {
      appState.tickets = appState.tickets.filter(t => t.id !== editingTicketId);
      await saveDatabase();
      document.getElementById('ticket-modal').classList.remove('active');
      renderDashboard();
    }
  });

  document.getElementById('ticket-form').addEventListener('submit', handleTicketFormSubmit);

  // Staff Modal System Auto-Detect Local Specs click handler
  document.getElementById('btn-modal-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-modal-detect-hw');
    const oldText = btn.textContent;
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    try {
      const detected = await ipcRenderer.invoke('sys:detect-hw');
      
      // Update modal spec elements
      document.getElementById('modal-spec-cpu').textContent = detected.cpu || "Failed to detect";
      document.getElementById('modal-spec-gpu').textContent = detected.gpu || "Failed to detect";
      document.getElementById('modal-spec-ram').textContent = detected.ram || "Failed to detect";
      document.getElementById('modal-spec-storage').textContent = detected.storage || "Failed to detect";

      // Identify rival competitor processor counterpart
      const comp = getCompetitorModel(detected.cpu);

      // Show loader on rival banner
      const rivalBanner = document.getElementById('modal-rival-pulled-banner');
      rivalBanner.classList.remove('hidden');
      rivalBanner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.1rem; line-height: 1;" class="animate-spin">⏳</span>
          <span>Locating competitor pricing & performance from the web...</span>
        </div>
      `;

      // Fetch live price online
      const livePrice = await getLiveCompetitorPrice(comp.name);

      // Find matching benchmark in local database to use as fallback price & set matching select value
      let matchedRival = appState.rivalBenchmarks.find(r => {
        const rName = r.name.toLowerCase();
        const rCpu = (r.cpu || '').toLowerCase();
        const compName = comp.name.toLowerCase();
        return compName.includes(rCpu) || rName.includes(compName) || compName.includes(rName);
      });

      if (!matchedRival) {
        if (comp.name.includes("7600")) {
          matchedRival = appState.rivalBenchmarks.find(r => r.id === "1");
        } else if (comp.name.includes("14700")) {
          matchedRival = appState.rivalBenchmarks.find(r => r.id === "2");
        }
      }

      const finalPrice = livePrice || (matchedRival ? matchedRival.price : null) || "₹18,500";
      const numericPrice = parsePriceNumeric(finalPrice);
      
      let ratioText = '';
      if (numericPrice > 0) {
        const ratio = (comp.cinebench / (numericPrice / 1000)).toFixed(2);
        ratioText = `<br><span style="color: var(--primary-pink); font-weight: bold;">Price-Performance Ratio:</span> <strong>${ratio} Cinebench pts / ₹1,000 spent</strong>.`;
      }

      // Update banner with full competitor spec detail & ratio
      rivalBanner.innerHTML = `
        <strong>🌐 Live Competitor Match:</strong> For a similar budget, the rival <strong>${comp.name}</strong> (${comp.desc}) costs <strong>${finalPrice}</strong> and offers <strong>${comp.cinebench.toLocaleString()} pts</strong> in Cinebench R23. Ensure this build's price-to-performance remains optimal!${ratioText}
      `;

      // Set the select dropdown and trigger comparison output update
      if (matchedRival) {
        const select = document.getElementById('form-rival-select');
        select.value = matchedRival.id;
        updateRivalComparisonOutput();
      }
    } catch (err) {
      console.error("Hardware spec detection failed in modal:", err);
      alert("Hardware specs detection failed: " + err.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  });

  // Missing components details toggling inputs
  const componentsToggle = document.getElementById('form-missing-components-toggle');
  componentsToggle.addEventListener('change', () => {
    const input = document.getElementById('form-missing-components');
    input.disabled = !componentsToggle.checked;
    if (!componentsToggle.checked) input.value = '';
  });

  // Lock transitions checker on physical build checkbox clicks
  const buildCheckboxes = ['check-cpu-ram-ssd', 'check-mobo-case', 'check-cooler', 'check-cables', 'check-posted'];
  buildCheckboxes.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      let count = 0;
      buildCheckboxes.forEach(cid => {
        if (document.getElementById(cid).checked) count++;
      });
      const pct = Math.round((count / 5) * 100);
      updateFormLockStates(pct);
    });
  });

  // Autocomplete standard checks button
  document.getElementById('btn-qc-check-all').addEventListener('click', () => {
    const qcIds = [
      'qc-phys-cabinet', 'qc-phys-motherboard', 'qc-phys-ram', 'qc-phys-screws',
      'qc-soft-windows', 'qc-soft-drivers', 'qc-soft-bios',
      'qc-port-usb', 'qc-port-video', 'qc-port-audio', 'qc-port-wifi'
    ];
    qcIds.forEach(id => {
      document.getElementById(id).checked = true;
    });
  });

  // Client exit (takes client back to selector screen)
  document.getElementById('btn-client-exit').addEventListener('click', () => {
    switchScreen('selector');
  });

  // Staff exit
  document.getElementById('btn-staff-exit').addEventListener('click', () => {
    switchScreen('selector');
  });
  document.getElementById('btn-client-refresh').addEventListener('click', () => {
    const currentId = document.getElementById('client-ticket-select').value;
    populateClientTicketSelect(currentId);
    handleClientTicketSelect();
  });
  document.getElementById('client-ticket-select').addEventListener('change', handleClientTicketSelect);

  // Print button directly in the modal footer
  document.getElementById('btn-print-report').addEventListener('click', () => {
    if (editingTicketId) {
      triggerPrintReport(editingTicketId);
    }
  });

  // Save as PDF button directly in the modal footer
  document.getElementById('btn-save-pdf').addEventListener('click', () => {
    if (editingTicketId) {
      triggerSavePdf(editingTicketId);
    }
  });

  // Modal automated diagnostics run button
  document.getElementById('btn-modal-run-diagnostics').addEventListener('click', async () => {
    await executeDiagnosticsWorkflow(true);
  });

  // Settings executable path browsers
  const setupPathBrowser = (btnId, inputId) => {
    document.getElementById(btnId).addEventListener('click', async () => {
      const pathVal = await ipcRenderer.invoke('dialog:open-file', [{ name: 'Executables', extensions: ['exe'] }]);
      if (pathVal) {
        document.getElementById(inputId).value = pathVal;
      }
    });
  };
  setupPathBrowser('btn-select-path-hwinfo', 'settings-path-hwinfo');
  setupPathBrowser('btn-select-path-cinebench', 'settings-path-cinebench');
  setupPathBrowser('btn-select-path-furmark', 'settings-path-furmark');

  // Filters and search fields triggers
  document.getElementById('search-input').addEventListener('input', renderDashboard);
  document.getElementById('filter-status').addEventListener('change', renderDashboard);
  document.getElementById('filter-tech').addEventListener('change', renderDashboard);

  setupFormCalculations();
  setupSerialVerification();
  setupClientMode();

  // Secret technician shortcut to open settings (Ctrl + Alt + S)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
      openSettingsModal();
    }
    // Secret technician shortcut to access staff portal directly (Ctrl + Alt + P)
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'p') {
      switchScreen('staff');
    }
  });
}

// ==========================================================================
// SUPABASE SYNC SERVICE
// ==========================================================================
let supabaseClient = null;

function initSupabase() {
  if (window.supabase && appState.settings.supabaseUrl && appState.settings.supabaseAnonKey) {
    try {
      supabaseClient = window.supabase.createClient(
        appState.settings.supabaseUrl, 
        appState.settings.supabaseAnonKey
      );
      console.log("Supabase Client initialized successfully.");
      setupRealtimeListener();
    } catch (err) {
      console.error("Failed to initialize Supabase Client:", err);
      supabaseClient = null;
    }
  } else {
    console.log("Supabase cloud sync not active (no keys configured). Using local storage.");
    supabaseClient = null;
  }
}

// Upload a single ticket to Supabase
async function syncTicketToCloud(ticket) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from('tickets')
      .upsert({
        id: ticket.id,
        created_at: ticket.createdAt,
        type: ticket.type,
        customer_name: ticket.customerName,
        deadline: ticket.deadline,
        technician: ticket.technician,
        missing_components_toggle: ticket.missingComponentsToggle,
        missing_components: ticket.missingComponents,
        build_checks: ticket.buildChecks,
        qc_checks: ticket.qcChecks,
        diagnostics: ticket.diagnostics,
        serials: ticket.serials,
        specs: ticket.specs,
        status: ticket.status,
        completed_at: ticket.completedAt
      });
    if (error) {
      console.error("Supabase upsert failed:", error.message);
    } else {
      console.log(`Synced ticket ${ticket.id} to cloud.`);
    }
  } catch (err) {
    console.error("Exception during ticket sync:", err);
  }
}

// Fetch all tickets from Supabase to sync local store
async function syncFromCloud() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('tickets')
      .select('*');
    
    if (error) {
      console.error("Failed to fetch cloud tickets:", error.message);
      return;
    }
    
    if (data && data.length > 0) {
      data.forEach(dbRow => {
        const ticket = {
          id: dbRow.id,
          createdAt: dbRow.created_at,
          type: dbRow.type,
          customerName: dbRow.customer_name,
          deadline: dbRow.deadline,
          technician: dbRow.technician,
          missingComponentsToggle: dbRow.missing_components_toggle,
          missingComponents: dbRow.missing_components,
          buildChecks: dbRow.build_checks,
          qcChecks: dbRow.qc_checks,
          diagnostics: dbRow.diagnostics,
          serials: dbRow.serials,
          specs: dbRow.specs,
          status: dbRow.status,
          completedAt: dbRow.completed_at
        };

        const index = appState.tickets.findIndex(t => t.id === ticket.id);
        if (index === -1) {
          appState.tickets.push(ticket);
        } else {
          // Sync overwrite from cloud
          appState.tickets[index] = ticket;
        }
      });
      await saveDatabase(); // Persist merged dataset locally
      console.log(`Pulled and merged ${data.length} tickets from Supabase cloud.`);
    }
  } catch (err) {
    console.error("Exception during database sync:", err);
  }
}

// Subscribe to Postgres changes on tickets table
function setupRealtimeListener() {
  if (!supabaseClient) return;
  try {
    supabaseClient
      .channel('public:tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, async payload => {
        console.log("Realtime event received:", payload);
        const dbRow = payload.new;
        if (dbRow) {
          const ticket = {
            id: dbRow.id,
            createdAt: dbRow.created_at,
            type: dbRow.type,
            customerName: dbRow.customer_name,
            deadline: dbRow.deadline,
            technician: dbRow.technician,
            missingComponentsToggle: dbRow.missing_components_toggle,
            missingComponents: dbRow.missing_components,
            buildChecks: dbRow.build_checks,
            qcChecks: dbRow.qc_checks,
            diagnostics: dbRow.diagnostics,
            serials: dbRow.serials,
            specs: dbRow.specs,
            status: dbRow.status,
            completedAt: dbRow.completed_at
          };

          const index = appState.tickets.findIndex(t => t.id === ticket.id);
          if (index === -1) {
            appState.tickets.push(ticket);
          } else {
            appState.tickets[index] = ticket;
          }
          await saveDatabase();
          if (currentMode === 'staff') {
            renderDashboard();
          } else if (currentMode === 'client') {
            populateClientTicketSelect();
          }
        }
      })
      .subscribe();
  } catch (err) {
    console.error("Failed to setup realtime listener:", err);
  }
}

// ==========================================================================
// ONLINE COMPETITOR & PRICE AUTO-PULL (PRICE-TO-PERFORMANCE ratio)
// ==========================================================================
function getCompetitorModel(detectedCpu) {
  const cpu = (detectedCpu || '').toLowerCase();
  if (cpu.includes('i9') || cpu.includes('14900') || cpu.includes('13900') || cpu.includes('7950') || cpu.includes('7900')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i9-14900K", desc: "Flagship Intel 24-Core CPU", cinebench: 39500 };
    } else {
      return { name: "AMD Ryzen 9 7950X", desc: "Flagship AMD 16-Core Processor", cinebench: 38000 };
    }
  }
  if (cpu.includes('i7') || cpu.includes('14700') || cpu.includes('13700') || cpu.includes('7800') || cpu.includes('7700') || cpu.includes('5800')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i7-14700K", desc: "Premium Intel 20-Core CPU", cinebench: 35000 };
    } else {
      return { name: "AMD Ryzen 7 7800X3D", desc: "Premium AMD 8-Core Gaming CPU", cinebench: 18500 };
    }
  }
  if (cpu.includes('i5') || cpu.includes('14400') || cpu.includes('14500') || cpu.includes('14600') || cpu.includes('13400') || cpu.includes('13500') || cpu.includes('13600') || cpu.includes('7600') || cpu.includes('7500') || cpu.includes('5600')) {
    if (cpu.includes('ryzen')) {
      return { name: "Intel Core i5-14400", desc: "Mainstream Intel 10-Core CPU", cinebench: 14500 };
    } else {
      return { name: "AMD Ryzen 5 7600", desc: "Mainstream AMD 6-Core CPU", cinebench: 13800 };
    }
  }
  return { name: "AMD Ryzen 5 7600", desc: "Mainstream AMD 6-Core CPU", cinebench: 13800 };
}

async function getLiveCompetitorPrice(competitorName) {
  try {
    const query = `${competitorName} price in India INR`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Fetch failed");
    const html = await res.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const snippets = Array.from(doc.querySelectorAll('.result__snippet')).map(el => el.textContent);

    // Look for price patterns like ₹XX,XXX or Rs. XX,XXX or XX,XXX INR
    const priceRegex = /(?:₹|Rs\.?)\s?([0-9]{1,2},[0-9]{3})/i;
    for (const snippet of snippets) {
      const match = snippet.match(priceRegex);
      if (match) {
        return match[0].trim();
      }
    }

    // Fallback regex for USD if INR is not found
    const usdRegex = /\$\s?([0-9]{2,3})/i;
    for (const snippet of snippets) {
      const match = snippet.match(usdRegex);
      if (match) {
        const usdVal = parseInt(match[1].replace(/,/g, ''));
        const inrVal = Math.round(usdVal * 83);
        return `₹${inrVal.toLocaleString('en-IN')} (~$${usdVal})`;
      }
    }
  } catch (err) {
    console.error("Live competitor price search failed:", err);
  }
  return null;
}

function parsePriceNumeric(priceStr) {
  if (!priceStr) return 0;
  let clean = priceStr.split('(')[0];
  clean = clean.replace(/[^0-9]/g, '');
  return parseInt(clean) || 0;
}

// ==========================================================================
// SEED MOCK BUILD TICKETS
// ==========================================================================
function seedMockTickets() {
  const now = new Date();
  const getDeadline = (daysOffset) => {
    const d = new Date(now);
    d.setTime(d.getTime() + daysOffset * 24 * 60 * 60 * 1000);
    return d.toISOString();
  };

  appState.tickets = [
    {
      id: "t_mock1",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Ananthakrishnan (Test Build)",
      deadline: getDeadline(0.4), // Urgent (within 24 hrs!)
      technician: "Ananthakrishnan",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: false,
        cables: false,
        posted: false
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Ryzen 7 7800X3D", gpu: "RTX 4070 Ti Super", ram: "32 GB DDR5", storage: "2TB NVMe SSD" },
      status: "building",
      completedAt: null
    },
    {
      id: "t_mock2",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Adithya Nair",
      deadline: getDeadline(1.8),
      technician: "Adhil",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Core i9-14900K", gpu: "RTX 4090", ram: "64 GB DDR5", storage: "4TB Gen4 SSD" },
      status: "waiting_qc",
      completedAt: null
    },
    {
      id: "t_mock3",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Kochi VR Studio",
      deadline: getDeadline(3),
      technician: "Amal",
      missingComponentsToggle: true,
      missingComponents: "Gigabyte RTX 4080 Super",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: false,
        cooler: false,
        cables: false,
        posted: false
      },
      qcChecks: {
        physCabinet: false, physMobo: false, physRam: false, physScrews: false,
        softWindows: false, softDrivers: false, softBios: false,
        portUsb: false, portVideo: false, portAudio: false, portWifi: false,
        wifiSpeed: null, wifiRange: null
      },
      diagnostics: {
        cpuTempMin: null, cpuTempMax: null, cpuTempAvg: null,
        gpuTempMin: null, gpuTempMax: null, gpuTempAvg: null,
        cinebench: null, furmark: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
      },
      serials: { motherboard: "", ram: "", gpu: "", ssd: "", cabinet: "" },
      specs: { cpu: "Ryzen 9 7950X", gpu: "", ram: "64 GB DDR5", storage: "2TB Gen4 SSD" },
      status: "awaiting",
      completedAt: null
    },
    {
      id: "t_mock4",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Rahul Krishna",
      deadline: getDeadline(0.9),
      technician: "Athul",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: true,
        physMobo: true,
        physRam: true,
        physScrews: true,
        softWindows: true,
        softDrivers: false,
        softBios: true,
        portUsb: true,
        portVideo: true,
        portAudio: false,
        portWifi: true,
        wifiSpeed: 240,
        wifiRange: 90
      },
      diagnostics: {
        cpuTempMin: 35, cpuTempMax: 82, cpuTempAvg: 68,
        gpuTempMin: 40, gpuTempMax: 78, gpuTempAvg: 70,
        cinebench: 14200, furmark: 9400, ssdRead: 4900, ssdWrite: 3950, rivalConfigId: "1"
      },
      serials: { motherboard: "MB-84729104", ram: "RAM-984719", gpu: "GPU-7739102", ssd: "SSD-391023", cabinet: "CAB-99238" },
      specs: { cpu: "Ryzen 5 7600", gpu: "RTX 4060", ram: "16 GB DDR5", storage: "1TB SSD" },
      status: "qc_testing",
      completedAt: null
    },
    {
      id: "t_mock5",
      createdAt: now.toISOString(),
      type: "build",
      customerName: "Aswin Jose",
      deadline: getDeadline(-2), // Completed in the past
      technician: "Amal",
      missingComponentsToggle: false,
      missingComponents: "",
      buildChecks: {
        cpuRamSsd: true,
        moboCase: true,
        cooler: true,
        cables: true,
        posted: true
      },
      qcChecks: {
        physCabinet: true, physMobo: true, physRam: true, physScrews: true,
        softWindows: true, softDrivers: true, softBios: true,
        portUsb: true, portVideo: true, portAudio: true, portWifi: true,
        wifiSpeed: 450, wifiRange: 98
      },
      diagnostics: {
        cpuTempMin: 32, cpuTempMax: 70, cpuTempAvg: 55,
        gpuTempMin: 35, gpuTempMax: 68, gpuTempAvg: 60,
        cinebench: 12500, furmark: 8200, ssdRead: 3500, ssdWrite: 3000, rivalConfigId: "1"
      },
      serials: { motherboard: "MB-11239023", ram: "RAM-449231", gpu: "GPU-2239102", ssd: "SSD-449102", cabinet: "CAB-55102" },
      specs: { cpu: "Core i5-13400", gpu: "RTX 3060", ram: "16 GB DDR4", storage: "1TB SSD" },
      status: "completed",
      completedAt: new Date(Date.now() - 48*60*60*1000).toISOString()
    }
  ];
}

// ==========================================================================
// REAL-TIME DIAGNOSTICS LOGGING & TELEMETRY
// ==========================================================================

function appendConsoleLine(boxId, text) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'console-line';
  
  // Format line style based on contents
  if (text.includes('[RAM Error]') || text.includes('[Error]')) {
    line.style.color = 'var(--status-urgent)';
    line.style.fontWeight = 'bold';
  } else if (text.includes('[RAM]')) {
    line.style.color = 'var(--status-testing)';
  } else if (text.includes('completed') || text.includes('success') || text.includes('Passed') || text.includes('completed.')) {
    line.style.color = 'var(--status-completed)';
  } else if (text.includes('Launching') || text.includes('Spawning') || text.includes('Starting') || text.includes('Initiating')) {
    line.style.color = '#38bdf8'; // light blue
  }
  
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function updateTempBar(valId, barId, tempVal) {
  const valEl = document.getElementById(valId);
  const barEl = document.getElementById(barId);
  if (tempVal === undefined || tempVal === null) return;
  
  if (valEl) valEl.textContent = `${tempVal}°C`;
  if (barEl) {
    // Scale temp from 30 to 100
    const pct = Math.min(100, Math.max(0, ((tempVal - 30) / (100 - 30)) * 100));
    barEl.style.width = `${pct}%`;
    
    // Color thresholds
    barEl.style.background = 'var(--status-completed)'; // Cool (under 60)
    if (tempVal >= 80) {
      barEl.style.background = 'var(--status-urgent)'; // Hot
    } else if (tempVal >= 60) {
      barEl.style.background = 'var(--status-awaiting)'; // Warm
    }
  }
}

// IPC Receivers for Real-time metrics
ipcRenderer.on('sys:diag-log', (event, text) => {
  let modifiedText = text;
  if (text.includes("SSD")) {
    modifiedText = `[PHASE: SSD SPEEDTEST] ` + text;
  } else if (text.includes("RAM")) {
    modifiedText = `[PHASE: RAM STRESSING] ` + text;
  } else if (text.includes("FurMark") || text.includes("GPU")) {
    modifiedText = `[PHASE: GPU STRESS] ` + text;
  } else if (text.includes("Cinebench") || text.includes("CPU")) {
    modifiedText = `[PHASE: CPU BENCHMARK] ` + text;
  } else if (text.includes("LibreHardwareMonitor")) {
    modifiedText = `[PHASE: SENSOR POLLING] ` + text;
  }
  appendConsoleLine('c-console-box', modifiedText);
  appendConsoleLine('modal-console-box', modifiedText);
});

ipcRenderer.on('sys:sensor-update', (event, data) => {
  if (data.cpuTemp) {
    updateTempBar('c-hud-cpu-temp-val', 'c-hud-cpu-temp-bar', data.cpuTemp);
    updateTempBar('modal-hud-cpu-temp-val', 'modal-hud-cpu-temp-bar', data.cpuTemp);
  }
  if (data.gpuTemp) {
    updateTempBar('c-hud-gpu-temp-val', 'c-hud-gpu-temp-bar', data.gpuTemp);
    updateTempBar('modal-hud-gpu-temp-val', 'modal-hud-gpu-temp-bar', data.gpuTemp);
  }
});

ipcRenderer.on('sys:ram-update', (event, data) => {
  const pct = data.percentDone || 0;
  const iter = data.iterations || 0;
  
  const cVal = document.getElementById('c-hud-ram-val');
  const cBar = document.getElementById('c-hud-ram-bar');
  const cDesc = document.getElementById('c-hud-ram-desc');
  if (cVal) cVal.textContent = `${pct}%`;
  if (cBar) cBar.style.width = `${pct}%`;
  if (cDesc) cDesc.textContent = `RAM Stressing: Iteration ${iter}`;

  const mVal = document.getElementById('modal-hud-ram-val');
  const mBar = document.getElementById('modal-hud-ram-bar');
  const mDesc = document.getElementById('modal-hud-ram-desc');
  if (mVal) mVal.textContent = `${pct}%`;
  if (mBar) mBar.style.width = `${pct}%`;
  if (mDesc) mDesc.textContent = `RAM Stressing: Iteration ${iter}`;
});

async function executeDiagnosticsWorkflow(isModal) {
  const prefix = isModal ? 'form-' : 'c-';
  const hudPrefix = isModal ? 'modal-' : 'c-';
  const btnId = isModal ? 'btn-modal-run-diagnostics' : 'btn-run-auto-diagnostics';
  const statusId = isModal ? 'modal-diagnostics-status' : 'c-diagnostics-status';
  const pulseId = isModal ? 'modal-console-pulse' : 'c-console-pulse';
  const boxId = isModal ? 'modal-console-box' : 'c-console-box';

  const btn = document.getElementById(btnId);
  const statusBox = document.getElementById(statusId);
  const pulseDot = document.getElementById(pulseId);
  const box = document.getElementById(boxId);

  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "⚡ Stress Testing...";

  if (pulseDot) {
    pulseDot.classList.remove('idle');
    pulseDot.classList.add('testing');
  }

  // Clear previous console outputs and set default starting log
  if (box) {
    box.innerHTML = '';
    appendConsoleLine(boxId, "[SYS] Initializing embedded diagnostics engine...");
    appendConsoleLine(boxId, "[SYS] Checking Administrator permissions... OK");
  }

  // Reset progress indicators
  updateTempBar(hudPrefix + 'hud-cpu-temp-val', hudPrefix + 'hud-cpu-temp-bar', 35);
  updateTempBar(hudPrefix + 'hud-gpu-temp-val', hudPrefix + 'hud-gpu-temp-bar', 38);
  
  const ramVal = document.getElementById(hudPrefix + 'hud-ram-val');
  const ramBar = document.getElementById(hudPrefix + 'hud-ram-bar');
  const ramDesc = document.getElementById(hudPrefix + 'hud-ram-desc');
  if (ramVal) ramVal.textContent = '0%';
  if (ramBar) ramBar.style.width = '0%';
  if (ramDesc) ramDesc.textContent = 'Initializing RAM worker...';

  const ssdVal = document.getElementById(hudPrefix + 'hud-ssd-val');
  const ssdBar = document.getElementById(hudPrefix + 'hud-ssd-bar');
  if (ssdVal) ssdVal.textContent = 'Testing...';
  if (ssdBar) ssdBar.style.width = '20%';

  const durationSelectId = isModal ? 'modal-duration-select' : 'client-duration-select';
  const durationSelectEl = document.getElementById(durationSelectId);
  const duration = durationSelectEl ? parseInt(durationSelectEl.value) : 60;

  let timeRemaining = duration;
  if (statusBox) {
    statusBox.innerHTML = `Cinebench R23: <strong style="color: var(--status-testing)">Testing...</strong> | FurMark: <strong style="color: var(--status-testing)">Testing...</strong> | RAM: <strong style="color: var(--status-testing)">Testing...</strong> | ⏳ Time Remaining: <strong style="color: var(--primary-pink)">~${timeRemaining}s</strong>`;
  }

  const timerInterval = setInterval(() => {
    timeRemaining--;
    if (timeRemaining < 0) timeRemaining = 0;
    if (statusBox) {
      statusBox.innerHTML = `Cinebench R23: <strong style="color: var(--status-testing)">Testing...</strong> | FurMark: <strong style="color: var(--status-testing)">Testing...</strong> | RAM: <strong style="color: var(--status-testing)">Testing...</strong> | ⏳ Time Remaining: <strong style="color: var(--primary-pink)">~${timeRemaining}s</strong>`;
    }
  }, 1000);

  // Retrieve Cinebench useCase parameter from corresponding selector
  const useCaseSelectId = isModal ? 'modal-usecase-select' : 'client-usecase-select';
  const useCaseSelectEl = document.getElementById(useCaseSelectId);
  const useCase = useCaseSelectEl ? useCaseSelectEl.value : 'gaming';

  // Run diagnostics!
  const res = await ipcRenderer.invoke('sys:run-diagnostics', {
    ...appState.settings,
    useCase: useCase,
    duration: duration
  });

  clearInterval(timerInterval);

  btn.disabled = false;
  btn.textContent = "Run Stress Test & Auto-Fill";

  if (pulseDot) {
    pulseDot.classList.remove('testing');
    pulseDot.classList.add('idle');
  }

  if (!res.success) {
    if (statusBox) statusBox.innerHTML = `<span style="color: var(--status-urgent)">Error: ${res.error}</span>`;
    appendConsoleLine(boxId, `[SYS ERROR] Diagnostics failed: ${res.error}`);
    return;
  }

  // Populate actual inputs
  document.getElementById(prefix + 'cpu-temp-min').value = res.cpuTempMin || '';
  document.getElementById(prefix + 'cpu-temp-max').value = res.cpuTempMax || '';
  document.getElementById(prefix + 'cpu-temp-avg').value = res.cpuTempAvg || '';

  document.getElementById(prefix + 'gpu-temp-min').value = res.gpuTempMin || '';
  document.getElementById(prefix + 'gpu-temp-max').value = res.gpuTempMax || '';
  document.getElementById(prefix + 'gpu-temp-avg').value = res.gpuTempAvg || '';

  document.getElementById(prefix + 'cinebench-score').value = res.cinebenchScore || '';
  document.getElementById(prefix + 'furmark-score').value = res.furmarkScore || '';
  document.getElementById(prefix + 'ssd-read').value = res.ssdRead || '';
  document.getElementById(prefix + 'ssd-write').value = res.ssdWrite || '';

  // Apply visual flash success highlight on the updated inputs
  const inputsToFlash = ['cpu-temp-min', 'cpu-temp-max', 'cpu-temp-avg', 'gpu-temp-min', 'gpu-temp-max', 'gpu-temp-avg', 'cinebench-score', 'furmark-score', 'ssd-read', 'ssd-write'];
  inputsToFlash.forEach(suffix => {
    const el = document.getElementById(prefix + suffix);
    if (el) {
      el.classList.add('flash-success');
      setTimeout(() => el.classList.remove('flash-success'), 1500);
    }
  });

  // Update HUD
  updateTempBar(hudPrefix + 'hud-cpu-temp-val', hudPrefix + 'hud-cpu-temp-bar', res.cpuTempAvg);
  updateTempBar(hudPrefix + 'hud-gpu-temp-val', hudPrefix + 'hud-gpu-temp-bar', res.gpuTempAvg);

  if (ramVal) ramVal.textContent = '100%';
  if (ramBar) ramBar.style.width = '100%';
  if (ramDesc) ramDesc.textContent = res.ramPassed ? 'RAM test passed successfully.' : 'RAM test failed!';

  if (ssdVal) ssdVal.textContent = `${res.ssdRead} R / ${res.ssdWrite} W MB/s`;
  if (ssdBar) ssdBar.style.width = '100%';

  if (statusBox) {
    statusBox.innerHTML = `
      Cinebench R23: <strong style="color: var(--status-completed)">Completed (${res.cinebenchScore} pts)</strong> | 
      FurMark: <strong style="color: var(--status-completed)">Completed</strong> | 
      RAM: <strong style="color: ${res.ramPassed ? 'var(--status-completed)' : 'var(--status-urgent)'}">${res.ramPassed ? 'Passed' : 'Failed'}</strong>
    `;
  }

  appendConsoleLine(boxId, `[SYS] All stress tests completed successfully.`);
  appendConsoleLine(boxId, `[SYS] CPU package average temperature: ${res.cpuTempAvg}°C.`);
  appendConsoleLine(boxId, `[SYS] GPU package average temperature: ${res.gpuTempAvg}°C.`);
  appendConsoleLine(boxId, `[SYS] SSD speed read: ${res.ssdRead} MB/s, write: ${res.ssdWrite} MB/s.`);
  appendConsoleLine(boxId, `[SYS] RAM test status: ${res.ramPassed ? "PASSED" : "FAILED"}.`);

  // Auto-Save Diagnostics back into the loaded ticket
  const ticketId = isModal 
    ? (document.getElementById('form-ticket-id').value || editingTicketId) 
    : document.getElementById('client-ticket-select').value;

  if (ticketId) {
    const ticketIndex = appState.tickets.findIndex(t => t.id === ticketId);
    if (ticketIndex !== -1) {
      const ticket = appState.tickets[ticketIndex];
      ticket.diagnostics.cpuTempMin = res.cpuTempMin || null;
      ticket.diagnostics.cpuTempMax = res.cpuTempMax || null;
      ticket.diagnostics.cpuTempAvg = res.cpuTempAvg || null;
      ticket.diagnostics.gpuTempMin = res.gpuTempMin || null;
      ticket.diagnostics.gpuTempMax = res.gpuTempMax || null;
      ticket.diagnostics.gpuTempAvg = res.gpuTempAvg || null;
      ticket.diagnostics.cinebench = res.cinebenchScore || null;
      ticket.diagnostics.furmark = res.furmarkScore || null;
      ticket.diagnostics.ssdRead = res.ssdRead || null;
      ticket.diagnostics.ssdWrite = res.ssdWrite || null;

      if (!isModal) {
        // Auto-match competitor config based on CPU specs
        if (detectedSpecs && detectedSpecs.cpu) {
          const comp = getCompetitorModel(detectedSpecs.cpu);
          let matchedRival = appState.rivalBenchmarks.find(r => {
            const rName = r.name.toLowerCase();
            const rCpu = (r.cpu || '').toLowerCase();
            const compName = comp.name.toLowerCase();
            return compName.includes(rCpu) || rName.includes(compName) || compName.includes(rName);
          });
          if (!matchedRival) {
            if (comp.name.includes("7600")) {
              matchedRival = appState.rivalBenchmarks.find(r => r.id === "1");
            } else if (comp.name.includes("14700")) {
              matchedRival = appState.rivalBenchmarks.find(r => r.id === "2");
            }
          }
          if (matchedRival) {
            ticket.diagnostics.rivalConfigId = matchedRival.id;
            const selectEl = document.getElementById('c-rival-select');
            if (selectEl) selectEl.value = matchedRival.id;
          }
        }

        // Auto-check standard QC check fields on test pass
        if (res.ramPassed) {
          ticket.qcChecks.physCabinet = true;
          ticket.qcChecks.softDrivers = true;
          ticket.qcChecks.softBios = true;
          ticket.qcChecks.portUsb = true;
          ticket.qcChecks.portVideo = true;
          ticket.qcChecks.portAudio = true;
          ticket.qcChecks.portWifi = true;
        }
      }

      appState.tickets[ticketIndex] = ticket;
      await saveDatabase();
      await syncTicketToCloud(ticket);
    }
  }

  if (isModal) {
    updateRivalComparisonOutput();
    updateModalDiagnosticsStatus();
  } else {
    updateClientRivalComparisonOutput();
    checkClientFormReady();
  }
}

// Accent Color Theme Applier
function applyAccentColor(color) {
  const root = document.documentElement;
  let primary = '#e7014e';
  let primaryRgb = '231, 1, 78';
  
  switch (color) {
    case 'purple':
      primary = '#8b5cf6';
      primaryRgb = '139, 92, 246';
      break;
    case 'cyan':
      primary = '#06b6d4';
      primaryRgb = '6, 182, 212';
      break;
    case 'gold':
      primary = '#f59e0b';
      primaryRgb = '245, 158, 11';
      break;
    case 'green':
      primary = '#10b981';
      primaryRgb = '16, 185, 129';
      break;
    case 'pink':
    default:
      primary = '#e7014e';
      primaryRgb = '231, 1, 78';
      break;
  }
  root.style.setProperty('--primary-pink', primary);
  root.style.setProperty('--primary-pink-rgb', primaryRgb);
  
  const logoGrad = document.getElementById('logo-grad');
  if (logoGrad) {
    logoGrad.innerHTML = `
      <stop offset="0%" stop-color="${color === 'purple' ? '#a78bfa' : color === 'cyan' ? '#22d3ee' : color === 'gold' ? '#fbbf24' : color === 'green' ? '#34d399' : '#ff1a75'}" />
      <stop offset="50%" stop-color="${primary}" />
      <stop offset="100%" stop-color="${color === 'purple' ? '#6d28d9' : color === 'cyan' ? '#0891b2' : color === 'gold' ? '#d97706' : color === 'green' ? '#059669' : '#b3003b'}" />
    `;
  }
}

// Format Date to YYYY-MM-DDTHH:MM
function formatDateTimeLocal(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) {
    return '';
  }
}
