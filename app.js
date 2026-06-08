const { ipcRenderer } = require('electron');

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
    { id: "1", name: "Ryzen 5 7600 + RTX 4060", cpu: "Ryzen 5 7600", gpu: "RTX 4060", cinebenchR23: 14500, readSpeed: 5000, writeSpeed: 4000 },
    { id: "2", name: "Intel i7-14700K + RTX 4070 Ti", cpu: "Core i7-14700K", gpu: "RTX 4070 Ti Super", cinebenchR23: 35000, readSpeed: 7000, writeSpeed: 6000 }
  ];
  if (!appState.settings) {
    appState.settings = { supabaseUrl: "", supabaseAnonKey: "", pathHwInfo: "", pathCinebench: "", pathFurmark: "" };
  } else {
    if (!appState.settings.pathHwInfo) appState.settings.pathHwInfo = "";
    if (!appState.settings.pathCinebench) appState.settings.pathCinebench = "";
    if (!appState.settings.pathFurmark) appState.settings.pathFurmark = "";
  }
  
  // Seed beautiful mock tickets if db is empty to showcase the UI immediately!
  if (!appState.tickets || appState.tickets.length === 0) {
    seedMockTickets();
    await saveDatabase();
  }
  
  initSupabase();
  await syncFromCloud();
}

// Save DB back to local storage
async function saveDatabase() {
  await ipcRenderer.invoke('db:write', appState);
}

// Switch between screens
function switchScreen(mode) {
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
    document.getElementById('client-screen').classList.add('active');
    populateClientTicketSelect();
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
}

function populateClientTicketSelect() {
  const select = document.getElementById('client-ticket-select');
  if (select) {
    select.innerHTML = '<option value="">-- Choose Ticket --</option>';
    // Filter active builds/repairs only
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
  return Math.round((count / 4) * 100);
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
      document.getElementById('form-deadline').value = ticket.deadline;
      document.getElementById('form-technician').value = ticket.technician;
      document.getElementById('form-ticket-type').value = ticket.type;
      
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
      document.getElementById('form-ssd-read').value = ticket.diagnostics.ssdRead || '';
      document.getElementById('form-ssd-write').value = ticket.diagnostics.ssdWrite || '';
      document.getElementById('form-rival-select').value = ticket.diagnostics.rivalConfigId || '';

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
  outputDiv.innerHTML = `<div class="comparison-row header"><span>Parameter</span><span>Your Build</span><span>Target rival</span><span>Delta</span></div>`;

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

// Save ticket form data
async function handleTicketFormSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('form-ticket-id').value || 't_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const createdAt = document.getElementById('form-created-at').value || new Date().toISOString();
  
  const ticketType = document.getElementById('form-ticket-type').value;
  const customerName = document.getElementById('form-customer-name').value;
  const deadline = document.getElementById('form-deadline').value;
  const technician = document.getElementById('form-technician').value;

  const missingComponentsToggle = document.getElementById('form-missing-components-toggle').checked;
  const missingComponents = document.getElementById('form-missing-components').value;

  const buildChecks = {
    cpuRamSsd: document.getElementById('check-cpu-ram-ssd').checked,
    moboCase: document.getElementById('check-mobo-case').checked,
    cooler: document.getElementById('check-cooler').checked,
    cables: document.getElementById('check-cables').checked
  };

  const qcChecks = {
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
    cpuTempMin: parseFloat(document.getElementById('form-cpu-temp-min').value) || null,
    cpuTempMax: parseFloat(document.getElementById('form-cpu-temp-max').value) || null,
    cpuTempAvg: parseFloat(document.getElementById('form-cpu-temp-avg').value) || null,
    gpuTempMin: parseFloat(document.getElementById('form-gpu-temp-min').value) || null,
    gpuTempMax: parseFloat(document.getElementById('form-gpu-temp-max').value) || null,
    gpuTempAvg: parseFloat(document.getElementById('form-gpu-temp-avg').value) || null,
    cinebench: parseFloat(document.getElementById('form-cinebench-score').value) || null,
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
  const isBuildComplete = buildChecks.cpuRamSsd && buildChecks.moboCase && buildChecks.cooler && buildChecks.cables;
  
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

  // Check specs (retrieve hardware info from ticket logs if available)
  if (editingTicketId) {
    const existing = appState.tickets.find(t => t.id === editingTicketId);
    updatedTicket.specs = existing ? existing.specs : {};
    const index = appState.tickets.findIndex(t => t.id === editingTicketId);
    appState.tickets[index] = updatedTicket;
  } else {
    updatedTicket.specs = {};
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
  // Automated Stress Test Execution
  document.getElementById('btn-run-auto-diagnostics').addEventListener('click', async () => {
    const btn = document.getElementById('btn-run-auto-diagnostics');
    const consoleBox = document.getElementById('diagnostics-log-console');
    
    consoleBox.classList.remove('hidden');
    consoleBox.innerHTML = `[${new Date().toLocaleTimeString()}] Checking diagnostic tool configurations...<br>`;
    
    btn.disabled = true;
    btn.textContent = "⚡ Running Stress Tests...";

    const res = await ipcRenderer.invoke('sys:run-diagnostics', appState.settings);
    if (!res.success) {
      consoleBox.innerHTML += `<span style="color: var(--status-urgent)">[Error] ${res.error}</span><br>`;
      btn.disabled = false;
      btn.textContent = "Run Automated Diagnostics";
      return;
    }

    consoleBox.innerHTML += `[${new Date().toLocaleTimeString()}] Diagnostics completed successfully.<br>`;
    if (res.mock) {
      consoleBox.innerHTML += `[Info] Running in MOCK Mode.<br>`;
    }

    // Parse HWiNFO log CSV
    if (res.csvContent) {
      consoleBox.innerHTML += `[${new Date().toLocaleTimeString()}] Parsing thermal logs...<br>`;
      parseHwInfoCsv(res.csvContent);
    }

    // Load Cinebench
    if (res.cinebenchScore) {
      consoleBox.innerHTML += `[${new Date().toLocaleTimeString()}] Cinebench Score parsed: ${res.cinebenchScore} pts<br>`;
      parsedCinebench = res.cinebenchScore;
      document.getElementById('cinebench-preview').textContent = `Cinebench Score: ${parsedCinebench} pts`;
    }

    btn.textContent = "✅ Stress Tests Complete";
    btn.classList.add('secondary-btn');
    btn.classList.remove('primary-pink-btn');
    
    checkClientFormReady();
  });

  // Trigger system specs detection
  document.getElementById('btn-client-detect-hw').addEventListener('click', async () => {
    const btn = document.getElementById('btn-client-detect-hw');
    btn.textContent = "🔍 Detecting hardware...";
    btn.disabled = true;

    detectedSpecs = await ipcRenderer.invoke('sys:detect-hw');
    
    document.getElementById('c-spec-cpu').textContent = detectedSpecs.cpu || "Failed to detect";
    document.getElementById('c-spec-gpu').textContent = detectedSpecs.gpu || "Failed to detect";
    document.getElementById('c-spec-ram').textContent = detectedSpecs.ram || "Failed to detect";
    document.getElementById('c-spec-storage').textContent = detectedSpecs.storage || "Failed to detect";

    btn.textContent = "🔍 Hardware Specs Detected";
    btn.classList.add('secondary-btn');
    btn.classList.remove('primary-pink-btn');
    checkClientFormReady();
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

  // Select HWiNFO64 Log CSV
  document.getElementById('btn-select-hwinfo').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('dialog:open-file', [{ name: 'CSV Files', extensions: ['csv'] }]);
    if (filePath) {
      document.getElementById('label-hwinfo-file').textContent = filePath.split('\\').pop();
      const csvContent = await ipcRenderer.invoke('file:read-text', filePath);
      parseHwInfoCsv(csvContent);
    }
  });

  // Select Cinebench Log File
  document.getElementById('btn-select-cinebench').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('dialog:open-file', [{ name: 'Text Reports', extensions: ['txt', 'log'] }]);
    if (filePath) {
      document.getElementById('label-cinebench-file').textContent = filePath.split('\\').pop();
      const txtContent = await ipcRenderer.invoke('file:read-text', filePath);
      parseCinebenchLog(txtContent);
    }
  });

  // Select CrystalDiskMark file
  document.getElementById('btn-select-crystal').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('dialog:open-file', [{ name: 'Text Reports', extensions: ['txt', 'log'] }]);
    if (filePath) {
      document.getElementById('label-crystal-file').textContent = filePath.split('\\').pop();
      const txtContent = await ipcRenderer.invoke('file:read-text', filePath);
      parseCrystalDiskLog(txtContent);
    }
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

    // Populate parsed temperatures
    if (parsedTemps) {
      t.diagnostics.cpuTempMin = parsedTemps.cpu.min;
      t.diagnostics.cpuTempMax = parsedTemps.cpu.max;
      t.diagnostics.cpuTempAvg = parsedTemps.cpu.avg;
      
      t.diagnostics.gpuTempMin = parsedTemps.gpu.min;
      t.diagnostics.gpuTempMax = parsedTemps.gpu.max;
      t.diagnostics.gpuTempAvg = parsedTemps.gpu.avg;
    }

    // Cinebench & SSD speed updates
    if (parsedCinebench) t.diagnostics.cinebench = parsedCinebench;
    if (parsedDiskSpeeds) {
      t.diagnostics.ssdRead = parsedDiskSpeeds.read;
      t.diagnostics.ssdWrite = parsedDiskSpeeds.write;
    }

    // Set QC check indicators
    if (parsedTemps) {
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
    switchScreen('selector');
  });
}

function getHwInfoStats(content) {
  if (!content) return null;
  const lines = content.split('\n');
  if (lines.length < 2) return null;

  // Auto-detect delimiter (, or ;)
  let delimiter = ',';
  if (lines[0].includes(';')) {
    const commas = (lines[0].match(/,/g) || []).length;
    const semicolons = (lines[0].match(/;/g) || []).length;
    if (semicolons > commas) {
      delimiter = ';';
    }
  }

  const headers = lines[0].split(delimiter).map(h => h.replace(/"/g, '').trim());
  
  // Find indices for CPU and GPU Temperature columns
  let cpuIdx = headers.findIndex(h => h.includes('CPU (Tctl/Tdie)') || h.includes('CPU Package') || h.includes('CPU [°C]'));
  let gpuIdx = headers.findIndex(h => h.includes('GPU Temperature') || h.includes('GPU Core') || h.includes('GPU [°C]'));

  // Fallbacks
  if (cpuIdx === -1) cpuIdx = headers.findIndex(h => h.toLowerCase().includes('cpu') && h.includes('°C'));
  if (gpuIdx === -1) gpuIdx = headers.findIndex(h => h.toLowerCase().includes('gpu') && h.includes('°C'));

  if (cpuIdx === -1 && gpuIdx === -1) return null;

  let cpuVals = [];
  let gpuVals = [];

  for (let i = 1; i < lines.length; i++) {
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

function parseHwInfoCsv(content) {
  const stats = getHwInfoStats(content);
  if (!stats) {
    alert("Could not map temperature columns in this CSV. Please check HWiNFO64 sensor headers.");
    return;
  }
  parsedTemps = stats;

  document.getElementById('hwinfo-preview').innerHTML = `
    CPU Temp: Min: ${parsedTemps.cpu.min}°C | Max: ${parsedTemps.cpu.max}°C | Avg: ${parsedTemps.cpu.avg}°C<br>
    GPU Temp: Min: ${parsedTemps.gpu.min}°C | Max: ${parsedTemps.gpu.max}°C | Avg: ${parsedTemps.gpu.avg}°C
  `;
  checkClientFormReady();
}

function parseCinebenchLog(content) {
  // Prioritize Multi Core score explicitly to prevent grabbing Single Core score if listed first
  const multiCoreRegex = /(?:Multi\s*Core|Multi-Core|MC)[^\d]*:\s*([\d,]+)/i;
  const matchMulti = content.match(multiCoreRegex);
  
  const scoreRegex = /(?:Score|Points|Result)\s*:\s*([\d,]+)/i;
  const matchGen = content.match(scoreRegex) || content.match(/(\d+)\s*(?:pts|points)/i);
  
  const finalMatch = matchMulti || matchGen;
  
  if (finalMatch) {
    parsedCinebench = parseInt(finalMatch[1].replace(/,/g, ''));
    document.getElementById('cinebench-preview').textContent = `Cinebench Score: ${parsedCinebench} pts`;
  } else {
    // Attempt raw numeric extract
    const nums = content.match(/\b\d{3,5}\b/g);
    if (nums) {
      parsedCinebench = parseInt(nums[0]);
      document.getElementById('cinebench-preview').textContent = `Cinebench Score (Extracted): ${parsedCinebench} pts`;
    } else {
      alert("Cinebench score could not be automatically extracted. Please paste standard result TXT.");
    }
  }
  checkClientFormReady();
}

function parseCrystalDiskLog(content) {
  // CrystalDiskMark output matches:
  // [Read]
  // SEQ    1MiB Q8T1:  7435.21 MB/s
  // [Write]
  // SEQ    1MiB Q8T1:  6320.12 MB/s
  const lines = content.split('\n');
  let readSpeed = 0;
  let writeSpeed = 0;

  let isWriteSection = false;
  lines.forEach(line => {
    if (line.toLowerCase().includes('[write]')) {
      isWriteSection = true;
    }
    const match = line.match(/(?:SEQ|Seq)\s+\d+M\w+\s+\w+\s*:\s*([\d.]+)/);
    if (match) {
      const speedVal = parseFloat(match[1]);
      if (isWriteSection && !writeSpeed) {
        writeSpeed = speedVal;
      } else if (!isWriteSection && !readSpeed) {
        readSpeed = speedVal;
      }
    }
  });

  // Secondary layout regex check
  if (!readSpeed || !writeSpeed) {
    const reads = content.match(/Read\s*\(MB\/s\)\s*:\s*([\d.]+)/i) || content.match(/Seq\s*Read\s*.*:\s*([\d.]+)/i);
    const writes = content.match(/Write\s*\(MB\/s\)\s*:\s*([\d.]+)/i) || content.match(/Seq\s*Write\s*.*:\s*([\d.]+)/i);
    if (reads) readSpeed = parseFloat(reads[1]);
    if (writes) writeSpeed = parseFloat(writes[1]);
  }

  if (readSpeed && writeSpeed) {
    parsedDiskSpeeds = {
      read: Math.round(readSpeed),
      write: Math.round(writeSpeed)
    };
    document.getElementById('crystal-preview').textContent = `Sequential Read: ${parsedDiskSpeeds.read} MB/s | Write: ${parsedDiskSpeeds.write} MB/s`;
  } else {
    alert("Could not automatically parse CrystalDiskMark. Ensure it is saved via 'File -> Save Test Result as TXT'.");
  }
  checkClientFormReady();
}

function checkClientFormReady() {
  const ticketId = document.getElementById('client-ticket-select').value;
  const submitBtn = document.getElementById('btn-client-submit');
  if (ticketId && (detectedSpecs || parsedTemps || parsedCinebench || parsedDiskSpeeds)) {
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

function triggerPrintReport(ticketId, shouldPrint = true) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

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
  document.getElementById('print-score-read').textContent = (ticket.diagnostics.ssdRead || '--') + ' MB/s';
  document.getElementById('print-score-write').textContent = (ticket.diagnostics.ssdWrite || '--') + ' MB/s';

  // Wi-Fi signal
  document.getElementById('print-wifi-signal').textContent = (ticket.qcChecks.wifiRange || '--') + ' %';
  document.getElementById('print-wifi-speed-val').textContent = (ticket.qcChecks.wifiSpeed || '--') + ' Mbps';

  // Rival comparison delta mappings
  const rivalId = ticket.diagnostics.rivalConfigId;
  const rival = appState.rivalBenchmarks.find(r => r.id === rivalId);
  if (rival) {
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
    document.getElementById('print-rival-cb').textContent = '--';
    document.getElementById('print-rival-read').textContent = '--';
    document.getElementById('print-rival-write').textContent = '--';
    document.getElementById('print-delta-cb').textContent = '--';
    document.getElementById('print-delta-read').textContent = '--';
    document.getElementById('print-delta-write').textContent = '--';
  }

  // Execute print in main Electron window
  if (shouldPrint) {
    ipcRenderer.invoke('sys:print');
  }
}

// Save Report as PDF File
async function triggerSavePdf(ticketId) {
  const ticket = appState.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

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
  document.getElementById('print-score-read').textContent = (ticket.diagnostics.ssdRead || '--') + ' MB/s';
  document.getElementById('print-score-write').textContent = (ticket.diagnostics.ssdWrite || '--') + ' MB/s';

  // Wi-Fi signal
  document.getElementById('print-wifi-signal').textContent = (ticket.qcChecks.wifiRange || '--') + ' %';
  document.getElementById('print-wifi-speed-val').textContent = (ticket.qcChecks.wifiSpeed || '--') + ' Mbps';

  // Rival comparison delta mappings
  const rivalId = ticket.diagnostics.rivalConfigId;
  const rival = appState.rivalBenchmarks.find(r => r.id === rivalId);
  if (rival) {
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
    document.getElementById('print-rival-cb').textContent = '--';
    document.getElementById('print-rival-read').textContent = '--';
    document.getElementById('print-rival-write').textContent = '--';
    document.getElementById('print-delta-cb').textContent = '--';
    document.getElementById('print-delta-read').textContent = '--';
    document.getElementById('print-delta-write').textContent = '--';
  }

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

  modal.classList.add('active');
}

async function handleSaveSettings() {
  appState.settings.supabaseUrl = document.getElementById('settings-supabase-url').value.trim();
  appState.settings.supabaseAnonKey = document.getElementById('settings-supabase-key').value.trim();
  appState.settings.pathHwInfo = document.getElementById('settings-path-hwinfo').value.trim();
  appState.settings.pathCinebench = document.getElementById('settings-path-cinebench').value.trim();
  appState.settings.pathFurmark = document.getElementById('settings-path-furmark').value.trim();

  await saveDatabase();
  document.getElementById('settings-modal').classList.remove('active');
  renderDashboard();
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
    setupClientMode();
  });

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
    const cb = parseInt(document.getElementById('new-rival-cb').value);
    const read = parseInt(document.getElementById('new-rival-read').value);
    const write = parseInt(document.getElementById('new-rival-write').value);

    if (name && !isNaN(cb)) {
      const newRival = {
        id: 'r_' + Date.now().toString(36),
        name,
        cinebenchR23: cb,
        readSpeed: read || 5000,
        writeSpeed: write || 4000
      };
      appState.rivalBenchmarks.push(newRival);
      document.getElementById('new-rival-name').value = '';
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

  // Missing components details toggling inputs
  const componentsToggle = document.getElementById('form-missing-components-toggle');
  componentsToggle.addEventListener('change', () => {
    const input = document.getElementById('form-missing-components');
    input.disabled = !componentsToggle.checked;
    if (!componentsToggle.checked) input.value = '';
  });

  // Lock transitions checker on physical build checkbox clicks
  const buildCheckboxes = ['check-cpu-ram-ssd', 'check-mobo-case', 'check-cooler', 'check-cables'];
  buildCheckboxes.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      let count = 0;
      buildCheckboxes.forEach(cid => {
        if (document.getElementById(cid).checked) count++;
      });
      const pct = Math.round((count / 4) * 100);
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

  // Client exit
  document.getElementById('btn-client-exit').addEventListener('click', () => {
    switchScreen('selector');
  });
  document.getElementById('btn-client-refresh').addEventListener('click', () => {
    populateClientTicketSelect();
    checkClientFormReady();
  });
  document.getElementById('client-ticket-select').addEventListener('change', checkClientFormReady);

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
    const btn = document.getElementById('btn-modal-run-diagnostics');
    const statusBox = document.getElementById('modal-diagnostics-status');
    if (!statusBox) return;

    // Check if paths are configured
    const hasHw = appState.settings.pathHwInfo || appState.settings.pathHwInfo === 'mock';
    const hasCb = appState.settings.pathCinebench || appState.settings.pathCinebench === 'mock';
    const hasFm = appState.settings.pathFurmark || appState.settings.pathFurmark === 'mock';

    if (!hasHw && !hasCb && !hasFm) {
      alert("No diagnostic tools configured! Please go to Settings and enter the executable paths or 'mock' to simulate.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "⚡ Running Stress Tests...";
    
    // Set status to running for active tools
    let hwRunText = hasHw ? "<strong style='color: var(--status-urgent)'>Running...</strong>" : "Not Configured";
    let cbRunText = hasCb ? "<strong style='color: var(--status-urgent)'>Running...</strong>" : "Not Configured";
    let fmRunText = hasFm ? "<strong style='color: var(--status-urgent)'>Running...</strong>" : "Not Configured";

    statusBox.innerHTML = `
      HWiNFO64: ${hwRunText} | 
      Cinebench R23: ${cbRunText} | 
      FurMark: ${fmRunText}
    `;

    const res = await ipcRenderer.invoke('sys:run-diagnostics', appState.settings);
    
    btn.disabled = false;
    btn.textContent = "Run Stress Test & Auto-Fill";

    if (!res.success) {
      statusBox.innerHTML = `<span style="color: var(--status-urgent)">Error: ${res.error}</span>`;
      return;
    }

    // Populate parsed temperatures
    if (res.csvContent) {
      const stats = getHwInfoStats(res.csvContent);
      if (stats) {
        if (stats.cpu.min !== null) document.getElementById('form-cpu-temp-min').value = stats.cpu.min;
        if (stats.cpu.max !== null) document.getElementById('form-cpu-temp-max').value = stats.cpu.max;
        if (stats.cpu.avg !== null) document.getElementById('form-cpu-temp-avg').value = stats.cpu.avg;
        
        if (stats.gpu.min !== null) document.getElementById('form-gpu-temp-min').value = stats.gpu.min;
        if (stats.gpu.max !== null) document.getElementById('form-gpu-temp-max').value = stats.gpu.max;
        if (stats.gpu.avg !== null) document.getElementById('form-gpu-temp-avg').value = stats.gpu.avg;
      }
    }

    // Populate Cinebench score
    if (res.cinebenchScore) {
      document.getElementById('form-cinebench-score').value = res.cinebenchScore;
    }

    // Trigger calculations and comparisons
    updateRivalComparisonOutput();
    updateModalDiagnosticsStatus();
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
        cables: false
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
        cinebench: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
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
        cables: true
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
        cinebench: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
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
        cables: false
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
        cinebench: null, ssdRead: null, ssdWrite: null, rivalConfigId: ""
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
        cables: true
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
        cinebench: 14200, ssdRead: 4900, ssdWrite: 3950, rivalConfigId: "1"
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
        cables: true
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
        cinebench: 12500, ssdRead: 3500, ssdWrite: 3000, rivalConfigId: "1"
      },
      serials: { motherboard: "MB-11239023", ram: "RAM-449231", gpu: "GPU-2239102", ssd: "SSD-449102", cabinet: "CAB-55102" },
      specs: { cpu: "Core i5-13400", gpu: "RTX 3060", ram: "16 GB DDR4", storage: "1TB SSD" },
      status: "completed",
      completedAt: new Date(Date.now() - 48*60*60*1000).toISOString()
    }
  ];
}
