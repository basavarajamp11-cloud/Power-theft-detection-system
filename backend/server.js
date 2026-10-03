'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const os = require('os');
const twilio = require('twilio');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuration Constants
const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = '0.0.0.0';
const THEFT_THRESHOLD = parseFloat(process.env.THEFT_THRESHOLD || '0.15');
const ALERT_COOLDOWN_SEC = parseInt(process.env.ALERT_COOLDOWN_SEC || '60', 10);
const NOMINAL_VOLTAGE = 230; // Volts (for active power calculation)

// Twilio Setup
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886';
const targetWhatsAppNumber = process.env.TARGET_WHATSAPP_NUMBER || '+919876543210';

const isTwilioConfigured =
  accountSid &&
  authToken &&
  !accountSid.includes('your_') &&
  !authToken.includes('your_');

let twilioClient = null;
if (isTwilioConfigured) {
  twilioClient = twilio(accountSid, authToken);
}

// In-Memory State
let lastAlertTimestamp = 0;
let currentRelayStatus = 'CLOSED'; // Default closed circuit (power supplied)
let latestTelemetry = null;

/**
 * Helper to get local network IPv4 addresses
 */
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4') {
        addresses.push({ interface: name, address: iface.address });
      }
    }
  }
  return addresses;
}

/**
 * Dispatches WhatsApp Alert using Twilio API (or logs simulation if placeholder keys are present)
 */
async function sendWhatsAppAlert({ zone, I_in, I_out, I_auth1, I_auth2, unauthorizedCurrent, unauthorizedWatts, relayStatus }) {
  const fromNumber = twilioWhatsAppNumber.startsWith('whatsapp:')
    ? twilioWhatsAppNumber
    : `whatsapp:${twilioWhatsAppNumber}`;
  const toNumber = targetWhatsAppNumber.startsWith('whatsapp:')
    ? targetWhatsAppNumber
    : `whatsapp:${targetWhatsAppNumber}`;

  const messageBody = [
    '🚨 *POWER THEFT ALERT DETECTED* 🚨',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📍 *Zone:* ${zone || 'Main Zone'}`,
    `⚡ *Total Entering Current (I_in):* ${I_in.toFixed(3)} A`,
    `➡️ *Exiting Current to Zone 2 (I_out):* ${I_out.toFixed(3)} A`,
    `🏠 *House 1 Consumption (I_auth1):* ${I_auth1.toFixed(3)} A`,
    `🏠 *House 2 Consumption (I_auth2):* ${I_auth2.toFixed(3)} A`,
    `⚠️ *Unauthorized Power Draw:* ${unauthorizedWatts.toFixed(1)} W (${unauthorizedCurrent.toFixed(3)} A)`,
    `🔒 *Relay Status:* ${relayStatus || currentRelayStatus}`,
    `⏰ *Timestamp:* ${new Date().toISOString()}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '⚠️ Immediate inspection required on line segment.'
  ].join('\n');

  if (isTwilioConfigured && twilioClient) {
    try {
      const result = await twilioClient.messages.create({
        body: messageBody,
        from: fromNumber,
        to: toNumber
      });
      console.log(`[Twilio WhatsApp] Alert dispatched successfully. SID: ${result.sid}`);
      return { sent: true, sid: result.sid };
    } catch (err) {
      console.error('[Twilio WhatsApp Error]:', err.message);
      return { sent: false, error: err.message };
    }
  } else {
    console.log('\n[SIMULATED TWILIO WHATSAPP ALERT (Replace placeholder credentials in .env to send real messages)]');
    console.log(`From: ${fromNumber}`);
    console.log(`To:   ${toNumber}`);
    console.log(messageBody);
    console.log('------------------------------------------------------------\n');
    return { sent: false, simulated: true, reason: 'Placeholder Twilio credentials in .env' };
  }
}

// ================= ROUTES =================

/**
 * GET /health
 * Health check & runtime monitoring endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'IoT Power Theft Detection Backend',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    config: {
      port: PORT,
      theftThresholdAmp: THEFT_THRESHOLD,
      alertCooldownSec: ALERT_COOLDOWN_SEC,
      twilioConfigured: Boolean(isTwilioConfigured)
    },
    relayStatus: currentRelayStatus,
    network: getLocalIpAddresses()
  });
});

/**
 * GET /api/telemetry/latest
 * Returns most recent telemetry packet for dashboard
 */
app.get('/api/telemetry/latest', (req, res) => {
  if (!latestTelemetry) {
    return res.status(200).json({
      success: true,
      message: 'No telemetry received yet. Awaiting ESP32 transmission.',
      data: {
        kclVerification: { I_in: 0, I_out: 0, I_auth1: 0, I_auth2: 0, calculated_I_theft: 0 },
        theftAnalysis: { theftDetected: false, unauthorizedCurrentAmp: 0, unauthorizedPowerWatts: 0, cooldownRemainingSec: 0 },
        relayStatus: currentRelayStatus,
        timestamp: new Date().toISOString()
      }
    });
  }
  res.status(200).json({ success: true, data: latestTelemetry });
});

/**
 * POST /api/relay
 * Remote actuation command to trip (OPEN) or restore (CLOSED) the relay
 */
app.post('/api/relay', (req, res) => {
  const { relayStatus } = req.body;
  if (!relayStatus || !['OPEN', 'CLOSED'].includes(relayStatus.toUpperCase())) {
    return res.status(400).json({
      success: false,
      error: 'Invalid relayStatus. Must be either "OPEN" or "CLOSED".'
    });
  }

  currentRelayStatus = relayStatus.toUpperCase();
  console.log(`[RELAY COMMAND] Remote relay state updated to: ${currentRelayStatus}`);

  res.status(200).json({
    success: true,
    message: `Relay state updated to ${currentRelayStatus}`,
    relayStatus: currentRelayStatus,
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/telemetry
 * Ingestion route accepting IoT sensor telemetry, verifying KCL, and dispatching alerts
 */
app.post('/api/telemetry', async (req, res) => {
  try {
    const {
      zone = 'Zone 1',
      I_in,
      I_out = 0,
      I_auth1 = 0,
      I_auth2 = 0,
      I_theft,
      theftDetected,
      relayStatus
    } = req.body;

    if (I_in === undefined || isNaN(Number(I_in))) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid required field: I_in (Entering current) must be a valid number.'
      });
    }

    const currentIn = parseFloat(Number(I_in).toFixed(4));
    const currentOut = parseFloat(Number(I_out).toFixed(4));
    const auth1 = parseFloat(Number(I_auth1).toFixed(4));
    const auth2 = parseFloat(Number(I_auth2).toFixed(4));
    const reportedTheft = I_theft !== undefined ? parseFloat(Number(I_theft).toFixed(4)) : null;

    // If device reports a relay status, track it unless overridden by server command
    const effectiveRelayStatus = currentRelayStatus;

    // Kirchhoff's Current Law (KCL) Verification:
    // I_theft = I_in - I_out - (I_auth1 + I_auth2)
    const calculated_I_theft = parseFloat((currentIn - currentOut - (auth1 + auth2)).toFixed(4));
    const effectiveTheftCurrent = Math.max(0, calculated_I_theft, reportedTheft || 0);
    const unauthorizedWatts = parseFloat((effectiveTheftCurrent * NOMINAL_VOLTAGE).toFixed(2));

    // Theft condition evaluation
    const isTheftByThreshold = effectiveTheftCurrent > THEFT_THRESHOLD;
    const isTheftFlagged = Boolean(theftDetected === true || theftDetected === 'true');
    const isTheftActive = isTheftByThreshold || isTheftFlagged;

    let alertTriggered = false;
    let alertThrottled = false;
    let cooldownRemainingSec = 0;
    let twilioResult = null;

    if (isTheftActive) {
      const now = Date.now();
      const cooldownMs = ALERT_COOLDOWN_SEC * 1000;
      const timeSinceLastAlert = now - lastAlertTimestamp;

      if (timeSinceLastAlert < cooldownMs) {
        alertThrottled = true;
        cooldownRemainingSec = Math.ceil((cooldownMs - timeSinceLastAlert) / 1000);
        console.warn(`[THROTTLE] Theft detected (${effectiveTheftCurrent}A), but alert throttled. Cooldown remaining: ${cooldownRemainingSec}s`);
      } else {
        alertTriggered = true;
        lastAlertTimestamp = now;
        console.warn(`[THEFT ALERT] Triggering WhatsApp Alert for ${zone}: I_theft = ${effectiveTheftCurrent}A (> threshold ${THEFT_THRESHOLD}A)`);
        twilioResult = await sendWhatsAppAlert({
          zone,
          I_in: currentIn,
          I_out: currentOut,
          I_auth1: auth1,
          I_auth2: auth2,
          unauthorizedCurrent: effectiveTheftCurrent,
          unauthorizedWatts,
          relayStatus: effectiveRelayStatus
        });
      }
    }

    const responsePayload = {
      success: true,
      message: isTheftActive ? 'Telemetry processed: Power theft identified!' : 'Telemetry processed: Normal grid operation.',
      kclVerification: {
        equation: 'I_theft = I_in - I_out - (I_auth1 + I_auth2)',
        I_in: currentIn,
        I_out: currentOut,
        I_auth1: auth1,
        I_auth2: auth2,
        calculated_I_theft,
        reported_I_theft: reportedTheft,
        kclVerified: true
      },
      theftAnalysis: {
        theftDetected: isTheftActive,
        thresholdExceeded: isTheftByThreshold,
        flaggedByHardware: isTheftFlagged,
        theftThresholdAmp: THEFT_THRESHOLD,
        unauthorizedCurrentAmp: effectiveTheftCurrent,
        unauthorizedPowerWatts: unauthorizedWatts,
        alertTriggered,
        alertThrottled,
        cooldownRemainingSec
      },
      relayStatus: effectiveRelayStatus,
      targetRelayAction: currentRelayStatus, // For ESP32 actuator feedback
      twilioResult,
      timestamp: new Date().toISOString()
    };

    latestTelemetry = responsePayload;
    res.status(200).json(responsePayload);
  } catch (err) {
    console.error('[Telemetry Ingestion Error]:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error processing telemetry',
      details: err.message
    });
  }
});

// Fallback to Dashboard UI
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, HOST, () => {
  const ips = getLocalIpAddresses();
  console.log('================================================================');
  console.log('⚡ IoT Power Theft Detection System (ESP32 Backend) Running');
  console.log(`🌐 Dashboard UI   : http://${HOST}:${PORT}`);
  console.log(`🔍 Health Check   : http://localhost:${PORT}/health`);
  console.log(`📥 Telemetry Post : http://localhost:${PORT}/api/telemetry`);
  console.log('----------------------------------------------------------------');
  console.log('📡 Local Network IP Addresses for ESP32 Connection:');
  ips.forEach((net) => {
    console.log(`   👉 ${net.interface}: http://${net.address}:${PORT}/api/telemetry`);
  });
  console.log('----------------------------------------------------------------');
  console.log(`⚙️  THEFT_THRESHOLD   : ${THEFT_THRESHOLD} A`);
  console.log(`⏱️  ALERT_COOLDOWN_SEC: ${ALERT_COOLDOWN_SEC} s`);
  console.log(`📲 Twilio WhatsApp    : ${isTwilioConfigured ? 'ENABLED' : 'SIMULATION MODE (Active & safe)'}`);
  console.log('================================================================');
});

module.exports = app;
