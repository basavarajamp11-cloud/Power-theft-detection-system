'use strict';

// State Management
const state = {
  currentFeederId: 'FEEDER-ALPHA-01',
  ws: null,
  reconnectAttempts: 0,
  audioEnabled: false,
  audioCtx: null,
  activeTheft: false,
  activeAlerts: [],
  chartHistory: [], // Array of { time, sourcePower, consumerPower, powerDelta }
  chartMaxPoints: 40,
  simulatorStatus: {
    tapActive: false,
    tapWatts: 850,
    magneticActive: false,
    coverActive: false
  }
};

// DOM Elements
const el = {
  feederSelect: document.getElementById('feederSelect'),
  connectionBadge: document.getElementById('connectionBadge'),
  systemClock: document.getElementById('systemClock'),
  toggleAudioBtn: document.getElementById('toggleAudioBtn'),
  audioIcon: document.getElementById('audioIcon'),
  
  // Alarm Banner
  alarmBanner: document.getElementById('theftAlarmBanner'),
  alarmTitle: document.getElementById('alarmBannerTitle'),
  alarmDesc: document.getElementById('alarmBannerDesc'),
  ackBannerBtn: document.getElementById('acknowledgeBannerBtn'),

  // KPIs
  sourcePowerVal: document.getElementById('sourcePowerVal'),
  sourceVoltageVal: document.getElementById('sourceVoltageVal'),
  sourceCurrentVal: document.getElementById('sourceCurrentVal'),
  sourceFreqVal: document.getElementById('sourceFreqVal'),
  consumerPowerVal: document.getElementById('consumerPowerVal'),
  activeConsumersVal: document.getElementById('activeConsumersVal'),
  consumerCurrentVal: document.getElementById('consumerCurrentVal'),
  legalShareVal: document.getElementById('legalShareVal'),
  powerDeltaVal: document.getElementById('powerDeltaVal'),
  lossPercentageVal: document.getElementById('lossPercentageVal'),
  stolenWattsVal: document.getElementById('stolenWattsVal'),
  theftStatusPill: document.getElementById('theftStatusPill'),
  discrepancyCard: document.getElementById('discrepancyCard'),
  hourlyLossVal: document.getElementById('hourlyLossVal'),
  dailyLossVal: document.getElementById('dailyLossVal'),
  revenueStatusVal: document.getElementById('revenueStatusVal'),

  // Schematic Nodes
  topologySvg: document.getElementById('topologySvg'),
  schemSourcePower: document.getElementById('schemSourcePower'),
  illegalTapNode: document.getElementById('illegalTapNode'),
  schemTheftWatts: document.getElementById('schemTheftWatts'),

  // Sandbox Controls
  theftTapBadge: document.getElementById('theftTapBadge'),
  tapPowerInput: document.getElementById('tapPowerInput'),
  toggleTapBtn: document.getElementById('toggleTapBtn'),
  magneticTamperBadge: document.getElementById('magneticTamperBadge'),
  magneticMeterSelect: document.getElementById('magneticMeterSelect'),
  toggleMagnetBtn: document.getElementById('toggleMagnetBtn'),
  coverTamperBadge: document.getElementById('coverTamperBadge'),
  coverMeterSelect: document.getElementById('coverMeterSelect'),
  toggleCoverBtn: document.getElementById('toggleCoverBtn'),

  // Chart Canvas
  canvas: document.getElementById('liveChart'),

  // Tables & Feeds
  metersTableBody: document.getElementById('metersTableBody'),
  meterCountBadge: document.getElementById('meterCountBadge'),
  alertsList: document.getElementById('alertsList'),
  refreshAlertsBtn: document.getElementById('refreshAlertsBtn')
};

// System Clock
function updateClock() {
  const now = new Date();
  el.systemClock.textContent = now.toTimeString().split(' ')[0] + ' UTC';
}
setInterval(updateClock, 1000);
updateClock();

// Audio Synthesizer for Industrial Alarm Chime
function initAudio() {
  if (!state.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
}

function playBuzzerAlert() {
  if (!state.audioEnabled) return;
  try {
    initAudio();
    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // High pitch warning
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35);

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (err) {
    console.warn('Audio playback error:', err);
  }
}

el.toggleAudioBtn.addEventListener('click', () => {
  initAudio();
  state.audioEnabled = !state.audioEnabled;
  el.audioIcon.textContent = state.audioEnabled ? '🔊' : '🔔';
  el.toggleAudioBtn.style.background = state.audioEnabled ? '#1e3a8a' : '';
  if (state.audioEnabled) {
    playBuzzerAlert();
  }
});

// WebSocket Manager
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  el.connectionBadge.className = 'connection-status';
  el.connectionBadge.querySelector('.status-text').textContent = 'CONNECTING...';

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.reconnectAttempts = 0;
    el.connectionBadge.className = 'connection-status connected';
    el.connectionBadge.querySelector('.status-text').textContent = 'LIVE SCADA WS';
    console.log('[SCADA WS] Connected to live stream.');
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerEvent(msg);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };

  state.ws.onclose = () => {
    el.connectionBadge.className = 'connection-status disconnected';
    el.connectionBadge.querySelector('.status-text').textContent = 'OFFLINE (RETRYING)';
    const delay = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts++), 10000);
    setTimeout(initWebSocket, delay);
  };

  state.ws.onerror = (err) => {
    console.warn('[SCADA WS] Error:', err);
    state.ws.close();
  };
}

// Event Dispatcher
function handleServerEvent(msg) {
  const { type, data } = msg;

  switch (type) {
    case 'FEEDER_AUDIT':
      if (data.feederId === state.currentFeederId) {
        applyAuditUpdate(data);
      }
      break;

    case 'NEW_ALERT':
    case 'ALERT_UPDATE':
      playBuzzerAlert();
      fetchAlerts();
      break;

    case 'ALERT_RESOLVED':
    case 'ALERT_ACKNOWLEDGED':
      fetchAlerts();
      break;

    case 'RELAY_STATE_CHANGED':
      fetchSnapshot();
      break;

    case 'TELEMETRY_SOURCE':
    case 'TELEMETRY_CONSUMER':
      // Snapshot fetch will keep table synced
      break;
  }
}

// Apply Feeder Audit Update to UI
function applyAuditUpdate(audit) {
  // Update KPI Cards
  el.sourcePowerVal.textContent = audit.sourcePower.toLocaleString();
  el.consumerPowerVal.textContent = audit.totalConsumerPower.toLocaleString();
  el.powerDeltaVal.textContent = audit.powerDelta.toLocaleString();
  el.lossPercentageVal.textContent = `${audit.lossPercentage}%`;
  el.stolenWattsVal.textContent = `${audit.illegalTapPowerEst} W`;
  el.sourceCurrentVal.textContent = `${audit.sourceCurrent} A`;
  el.consumerCurrentVal.textContent = `${audit.totalConsumerCurrent} A`;
  el.activeConsumersVal.textContent = `${audit.activeConsumerCount} Units`;

  const legalPct = audit.sourcePower > 0
    ? Math.min(100, Math.round((audit.totalConsumerPower / audit.sourcePower) * 100))
    : 100;
  el.legalShareVal.textContent = `${legalPct}%`;

  el.hourlyLossVal.textContent = audit.estimatedHourlyCostLoss.toFixed(2);
  el.dailyLossVal.textContent = `$${(audit.estimatedHourlyCostLoss * 24).toFixed(2)}`;

  // Update Status Pill
  el.theftStatusPill.className = 'status-pill';
  if (audit.theftStatus === 'THEFT_CONFIRMED') {
    el.theftStatusPill.classList.add('status-theft');
    el.theftStatusPill.textContent = 'THEFT CONFIRMED';
    el.discrepancyCard.classList.add('theft-active');
    el.revenueStatusVal.textContent = 'REVENUE LEAKING';
    el.revenueStatusVal.style.color = 'var(--accent-red)';
    state.activeTheft = true;

    // Show Alarm Banner
    el.alarmBanner.classList.remove('hidden');
    el.alarmTitle.textContent = `CRITICAL: UNMETERED LINE THEFT DETECTED ON ${audit.feederId}`;
    el.alarmDesc.textContent = `Active illegal hookup detected. Siphoning ~${Math.round(audit.illegalTapPowerEst)}W (${audit.lossPercentage}% of feeder power). Instant loss rate: $${audit.estimatedHourlyCostLoss.toFixed(2)}/hr.`;
  } else if (audit.theftStatus === 'SUSPECTED_LOSS') {
    el.theftStatusPill.classList.add('status-suspected');
    el.theftStatusPill.textContent = 'SUSPECTED LOSS';
    el.discrepancyCard.classList.remove('theft-active');
    el.revenueStatusVal.textContent = 'Investigating';
    el.revenueStatusVal.style.color = 'var(--accent-yellow)';
    state.activeTheft = false;
  } else {
    el.theftStatusPill.classList.add('status-normal');
    el.theftStatusPill.textContent = 'NORMAL';
    el.discrepancyCard.classList.remove('theft-active');
    el.revenueStatusVal.textContent = 'Protected';
    el.revenueStatusVal.style.color = 'var(--accent-green)';
    el.alarmBanner.classList.add('hidden');
    state.activeTheft = false;
  }

  // Update Topology Schematic
  el.schemSourcePower.textContent = `${Math.round(audit.sourcePower)} W`;
  if (audit.illegalTapPowerEst > 0 || state.simulatorStatus.tapActive) {
    el.illegalTapNode.classList.remove('hidden');
    el.schemTheftWatts.textContent = `${Math.round(audit.illegalTapPowerEst || state.simulatorStatus.tapWatts)}W Siphoned Load`;
    el.topologySvg.classList.add('theft-active-line');
  } else {
    el.illegalTapNode.classList.add('hidden');
    el.topologySvg.classList.remove('theft-active-line');
  }

  // Update Rolling Chart Data
  const now = new Date();
  const timeLabel = now.toTimeString().split(' ')[0];
  state.chartHistory.push({
    time: timeLabel,
    sourcePower: audit.sourcePower,
    consumerPower: audit.totalConsumerPower,
    powerDelta: audit.powerDelta
  });

  if (state.chartHistory.length > state.chartMaxPoints) {
    state.chartHistory.shift();
  }

  drawLiveChart();
}

// Canvas Real-Time Chart Renderer
function drawLiveChart() {
  const cvs = el.canvas;
  const ctx = cvs.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const width = cvs.clientWidth || 960;
  const height = cvs.clientHeight || 220;

  cvs.width = width * dpr;
  cvs.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const data = state.chartHistory;
  if (data.length < 2) return;

  const padding = { top: 20, right: 30, bottom: 30, left: 55 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  // Find max value for Y-axis scale
  let maxVal = 1000;
  for (const d of data) {
    if (d.sourcePower > maxVal) maxVal = d.sourcePower;
  }
  maxVal = Math.ceil((maxVal * 1.15) / 500) * 500;

  // Grid Lines & Y-Axis Labels
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'right';

  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = (maxVal / yTicks) * i;
    const y = padding.top + graphHeight - (i / yTicks) * graphHeight;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(`${Math.round(yVal)}W`, padding.left - 8, y + 3);
  }

  // Helper to map values to coordinates
  const getX = (idx) => padding.left + (idx / (data.length - 1)) * graphWidth;
  const getY = (val) => padding.top + graphHeight - (val / maxVal) * graphHeight;

  // Draw Shaded Power Delta / Theft Area
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = getX(i);
    const y = getY(data[i].sourcePower);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = data.length - 1; i >= 0; i--) {
    const x = getX(i);
    const y = getY(data[i].consumerPower);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
  ctx.fill();

  // Helper to draw a smooth line
  function drawLine(key, strokeColor, lineWidth = 2) {
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    for (let i = 0; i < data.length; i++) {
      const x = getX(i);
      const y = getY(data[i][key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Draw Lines
  drawLine('sourcePower', '#38bdf8', 2.5);  // Master Transformer Source (Blue)
  drawLine('consumerPower', '#10b981', 2);  // Consumer Total (Green)
  drawLine('powerDelta', '#ef4444', 1.8);   // Power Delta (Red)

  // Draw X-axis timestamps
  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748b';
  const xStep = Math.max(1, Math.floor(data.length / 5));
  for (let i = 0; i < data.length; i += xStep) {
    ctx.fillText(data[i].time, getX(i), height - 8);
  }
}

// Fetch Full Live Snapshot
async function fetchSnapshot() {
  try {
    const res = await fetch('/api/telemetry/live');
    const json = await res.json();
    if (!json.success || !json.data) return;

    const currentFeederData = json.data.find(f => f.feeder.id === state.currentFeederId);
    if (!currentFeederData) return;

    if (currentFeederData.sourceMeter) {
      el.sourceVoltageVal.textContent = `${currentFeederData.sourceMeter.voltage} V`;
      el.sourceFreqVal.textContent = `${currentFeederData.sourceMeter.frequency || 50.0} Hz`;
    }

    if (currentFeederData.lastAudit) {
      applyAuditUpdate(currentFeederData.lastAudit);
    }

    renderMetersTable(currentFeederData.consumers);
  } catch (err) {
    console.error('Failed to fetch live snapshot:', err);
  }
}

// Render Smart Meters Table
function renderMetersTable(consumers) {
  el.meterCountBadge.textContent = `${consumers.length} Meters`;
  el.metersTableBody.innerHTML = '';

  consumers.forEach(meter => {
    const tr = document.createElement('tr');
    const telem = meter.telemetry || {};
    const isRelayOpen = meter.relay_state === 'OPEN';
    const isTampered = telem.tamper_magnetic || telem.tamper_cover || telem.tamper_neutral;

    // Update schematic node if matching MTR-101, 102, 103
    const schemNode = document.getElementById(`node${meter.id.replace('-', '')}`);
    if (schemNode) {
      const pText = schemNode.querySelector('.schem-metric');
      if (pText) pText.textContent = `${Math.round(telem.active_power || 0)} W`;
      if (isTampered) schemNode.classList.add('tampered');
      else schemNode.classList.remove('tampered');

      if (isRelayOpen) {
        schemNode.classList.add('tripped');
        const rText = schemNode.querySelector('.relay-text');
        if (rText) rText.textContent = 'RELAY: OPEN (TRIPPED)';
      } else {
        schemNode.classList.remove('tripped');
        const rText = schemNode.querySelector('.relay-text');
        if (rText) rText.textContent = 'RELAY: CLOSED';
      }
    }

    tr.innerHTML = `
      <td>
        <span class="meter-id-cell">${meter.id}</span>
      </td>
      <td>
        <div><b>${meter.consumer_name || 'N/A'}</b></div>
        <div class="meter-acct">${meter.consumer_account || meter.consumer_address || ''}</div>
      </td>
      <td>
        <span class="load-cell" style="color: ${isRelayOpen ? '#ef4444' : '#38bdf8'}">
          ${Math.round(telem.active_power || 0)} W
        </span>
      </td>
      <td>
        <span>${telem.voltage || 230}V / ${(telem.current || 0).toFixed(2)}A</span>
      </td>
      <td>
        <span style="font-family: var(--font-mono)">${(telem.cumulative_energy_kwh || 0).toFixed(2)} kWh</span>
      </td>
      <td>
        <div class="tamper-badge-list">
          <span class="tamper-chip ${telem.tamper_magnetic ? 'active' : ''}" title="Magnetic Sensor">MAG</span>
          <span class="tamper-chip ${telem.tamper_cover ? 'active' : ''}" title="Cover Switch">COV</span>
          <span class="tamper-chip ${telem.tamper_neutral ? 'active' : ''}" title="Neutral Bypass">NEU</span>
        </div>
      </td>
      <td>
        <button class="relay-btn ${isRelayOpen ? 'restore' : 'trip'}" data-meter-id="${meter.id}" data-action="${isRelayOpen ? 'CLOSED' : 'OPEN'}">
          ${isRelayOpen ? '🔌 RESTORE' : '🛑 CUTOFF'}
        </button>
      </td>
    `;

    el.metersTableBody.appendChild(tr);
  });

  // Attach Relay Action Listeners
  document.querySelectorAll('.relay-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const meterId = e.target.getAttribute('data-meter-id');
      const targetState = e.target.getAttribute('data-action');
      try {
        const res = await fetch(`/api/meters/${meterId}/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: targetState,
            requestedBy: 'SCADA Web Console',
            reason: targetState === 'OPEN' ? 'Remote theft prevention cutoff' : 'Relay reset command'
          })
        });
        const result = await res.json();
        if (result.success) {
          fetchSnapshot();
        }
      } catch (err) {
        console.error('Relay toggle failed:', err);
      }
    });
  });
}

// Fetch Active & Recent Alerts
async function fetchAlerts() {
  try {
    const res = await fetch('/api/alerts?limit=25');
    const json = await res.json();
    if (!json.success || !json.data) return;

    state.activeAlerts = json.data;
    renderAlertsList(json.data);
  } catch (err) {
    console.error('Failed to fetch alerts:', err);
  }
}

function renderAlertsList(alerts) {
  el.alertsList.innerHTML = '';

  if (alerts.length === 0) {
    el.alertsList.innerHTML = '<div class="no-alerts">✓ All distribution feeder lines operating within nominal parameters. No active security alerts.</div>';
    return;
  }

  alerts.forEach(alert => {
    const item = document.createElement('div');
    item.className = `alert-item severity-${alert.severity}`;

    const dateStr = new Date(alert.timestamp).toLocaleTimeString();

    item.innerHTML = `
      <div class="alert-item-header">
        <span class="alert-type-badge">${alert.alert_type}</span>
        <span class="alert-time">${dateStr}</span>
      </div>
      <div class="alert-msg">${alert.message}</div>
      <div class="alert-item-actions">
        ${alert.status === 'ACTIVE' ? `
          <button class="cyber-btn small danger-outline ack-btn" data-id="${alert.id}">Acknowledge</button>
          <button class="cyber-btn small resolve-btn" data-id="${alert.id}">Resolve</button>
        ` : `
          <span class="badge-online">${alert.status}</span>
        `}
      </div>
    `;

    el.alertsList.appendChild(item);
  });

  // Attach Acknowledge & Resolve handlers
  document.querySelectorAll('.ack-btn').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-id');
      await fetch(`/api/alerts/${id}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName: 'SCADA Dispatcher' })
      });
      fetchAlerts();
    });
  });

  document.querySelectorAll('.resolve-btn').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-id');
      await fetch(`/api/alerts/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName: 'SCADA Dispatcher' })
      });
      fetchAlerts();
    });
  });
}

// Acknowledge Banner Button
el.ackBannerBtn.addEventListener('click', async () => {
  const activeTheftAlert = state.activeAlerts.find(a => a.alert_type === 'ILLEGAL_LINE_TAP_DETECTED' && a.status === 'ACTIVE');
  if (activeTheftAlert) {
    await fetch(`/api/alerts/${activeTheftAlert.id}/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorName: 'SCADA Alarm Banner' })
    });
  }
  el.alarmBanner.classList.add('hidden');
});

// Sandbox Simulator Controls Handlers
el.toggleTapBtn.addEventListener('click', async () => {
  initAudio();
  state.simulatorStatus.tapActive = !state.simulatorStatus.tapActive;
  const watts = parseInt(el.tapPowerInput.value, 10);
  state.simulatorStatus.tapWatts = watts;

  try {
    const res = await fetch('/api/theft/simulate-tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feederId: state.currentFeederId,
        active: state.simulatorStatus.tapActive,
        tapWatts: watts
      })
    });
    const result = await res.json();

    if (state.simulatorStatus.tapActive) {
      el.theftTapBadge.textContent = `CONNECTED (${watts}W)`;
      el.theftTapBadge.className = 'badge-danger';
      el.toggleTapBtn.textContent = '❌ DISCONNECT ILLEGAL LINE TAP';
      el.toggleTapBtn.className = 'cyber-btn danger-outline';
    } else {
      el.theftTapBadge.textContent = 'DISCONNECTED';
      el.theftTapBadge.className = 'badge-online';
      el.toggleTapBtn.textContent = '⚡ ATTACH ILLEGAL LINE TAP';
      el.toggleTapBtn.className = 'cyber-btn cyber-btn-danger';
    }
  } catch (err) {
    console.error('Failed to toggle simulated theft tap:', err);
  }
});

el.toggleMagnetBtn.addEventListener('click', async () => {
  initAudio();
  state.simulatorStatus.magneticActive = !state.simulatorStatus.magneticActive;
  const meterId = el.magneticMeterSelect.value;

  try {
    await fetch('/api/theft/simulate-tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: meterId,
        magnetic: state.simulatorStatus.magneticActive
      })
    });

    if (state.simulatorStatus.magneticActive) {
      el.magneticTamperBadge.textContent = `MAGNET DETECTED (${meterId})`;
      el.magneticTamperBadge.className = 'badge-danger';
      el.toggleMagnetBtn.textContent = '🧲 REMOVE NEODYMIUM MAGNET';
      el.toggleMagnetBtn.className = 'cyber-btn';
    } else {
      el.magneticTamperBadge.textContent = 'NORMAL FIELD';
      el.magneticTamperBadge.className = 'badge-warning';
      el.toggleMagnetBtn.textContent = '🧲 APPLY STRONG MAGNET';
      el.toggleMagnetBtn.className = 'cyber-btn cyber-btn-warning';
    }
  } catch (err) {
    console.error('Failed to toggle magnetic tamper:', err);
  }
});

el.toggleCoverBtn.addEventListener('click', async () => {
  initAudio();
  state.simulatorStatus.coverActive = !state.simulatorStatus.coverActive;
  const meterId = el.coverMeterSelect.value;

  try {
    await fetch('/api/theft/simulate-tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: meterId,
        cover: state.simulatorStatus.coverActive
      })
    });

    if (state.simulatorStatus.coverActive) {
      el.coverTamperBadge.textContent = `BREACH DETECTED (${meterId})`;
      el.coverTamperBadge.className = 'badge-danger';
      el.toggleCoverBtn.textContent = '🔒 CLOSE & SEAL ENCLOSURE';
      el.toggleCoverBtn.className = 'cyber-btn';
    } else {
      el.coverTamperBadge.textContent = 'CASE SEALED';
      el.coverTamperBadge.className = 'badge-info';
      el.toggleCoverBtn.textContent = '🔓 OPEN METER ENCLOSURE';
      el.toggleCoverBtn.className = 'cyber-btn cyber-btn-info';
    }
  } catch (err) {
    console.error('Failed to toggle cover tamper:', err);
  }
});

// Feeder Select Dropdown Switcher
el.feederSelect.addEventListener('change', (e) => {
  state.currentFeederId = e.target.value;
  state.chartHistory = [];
  fetchSnapshot();
});

// Refresh Alerts Button
el.refreshAlertsBtn.addEventListener('click', fetchAlerts);

// Initial Bootstrapping
window.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  fetchSnapshot();
  fetchAlerts();

  // Periodic polling fallback in case WebSocket drops
  setInterval(fetchSnapshot, 4000);
});
