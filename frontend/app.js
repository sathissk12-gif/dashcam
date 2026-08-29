/**
 * Dashcam Command Center Frontend Application (Production Hardened)
 * Ultra-Low-Latency H.264 Live Stream Player, Two-Way Audio Talkback, Real SD Playback & GPS Live Tracking
 */

// State
let ws = null;
let jmuxer = null;
let map = null;
let vehicleMarker = null;
let trajectoryPath = null;
let trajectoryCoords = [];
let activeDevice = null;
let isStreaming = false;
let isSimRunning = false;
let frameCount = 0;
let currentChannel = 1;
let lastFpsTime = Date.now();
let hasSeenKeyframe = false;
let currentToken = null;

// Audio Talkback State
let audioContext = null;
let micStream = null;
let audioProcessor = null;
let isTalking = false;

// DOM Elements
const playerEl = document.getElementById('player');
const videoOverlay = document.getElementById('videoOverlay');
const overlayText = document.getElementById('overlayText');
const liveBadge = document.getElementById('liveBadge');
const fpsBadge = document.getElementById('fpsBadge');
const channelBadge = document.getElementById('channelBadge');
const gpsStatusBadge = document.getElementById('gpsStatusBadge');
const deviceSelect = document.getElementById('deviceSelect');
const channelSelect = document.getElementById('channelSelect');
const streamTypeSelect = document.getElementById('streamTypeSelect');
const startLiveBtn = document.getElementById('startLiveBtn');
const stopLiveBtn = document.getElementById('stopLiveBtn');
const btnFrontCam = document.getElementById('btnFrontCam');
const btnCabinCam = document.getElementById('btnCabinCam');
const talkbackBtn = document.getElementById('talkbackBtn');
const talkbackStatus = document.getElementById('talkbackStatus');
const simControlBtn = document.getElementById('simControlBtn');
const simBtnText = document.getElementById('simBtnText');
const logsContainer = document.getElementById('logsContainer');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const jt808PortDisplay = document.getElementById('jt808PortDisplay');
const roleSwitcher = document.getElementById('roleSwitcher');

// Playback Modal DOM
const playbackModal = document.getElementById('playbackModal');
const btnQueryPlayback = document.getElementById('btnQueryPlayback');
const closePlaybackBtn = document.getElementById('closePlaybackBtn');
const btnFetchSdRecords = document.getElementById('btnFetchSdRecords');
const playbackRecordsList = document.getElementById('playbackRecordsList');

// Telemetry DOM
const speedVal = document.getElementById('speedVal');
const headingVal = document.getElementById('headingVal');
const accVal = document.getElementById('accVal');
const satVal = document.getElementById('satVal');
const signalVal = document.getElementById('signalVal');
const mileageVal = document.getElementById('mileageVal');

function initMap() {
  const defaultPos = [11.2953, 77.7375];
  map = L.map('map', { zoomControl: true }).setView(defaultPos, 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  const customIcon = L.divIcon({
    className: 'vehicle-marker-icon',
    html: `<div id="vehicleIcon" style="transform: rotate(0deg); font-size: 24px; color: #00f2fe; filter: drop-shadow(0 0 6px rgba(0,242,254,0.8));">
            <i class="fa-solid fa-location-arrow"></i>
          </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  vehicleMarker = L.marker(defaultPos, { icon: customIcon }).addTo(map);
  vehicleMarker.bindPopup("<b>T98 Dashcam</b><br>Connecting...").openPopup();

  trajectoryPath = L.polyline([], { color: '#00f2fe', weight: 4, opacity: 0.8 }).addTo(map);
}

function initJMuxer() {
  hasSeenKeyframe = false;
  
  if (jmuxer) {
    try { jmuxer.destroy(); } catch (e) {}
    jmuxer = null;
  }

  playerEl.muted = true;
  playerEl.setAttribute('playsinline', '');
  playerEl.setAttribute('autoplay', '');

  jmuxer = new JMuxer({
    node: 'player',
    mode: 'video',
    flushingTime: 0,
    clearBuffer: true,
    fps: 25,
    debug: false,
    onError: function(data) {
      console.warn('JMuxer event:', data);
    }
  });

  playerEl.addEventListener('timeupdate', () => {
    if (playerEl.buffered && playerEl.buffered.length > 0) {
      const bufferEnd = playerEl.buffered.end(playerEl.buffered.length - 1);
      const lag = bufferEnd - playerEl.currentTime;
      if (lag > 0.35) {
        playerEl.currentTime = bufferEnd - 0.05;
      }
    }
  });

  playerEl.play().catch(() => {});
}

async function obtainTokenForRole(roleKey) {
  const MASTER_API_KEY = 'traxen_live_api_8899aabbccddeeff00112233';
  let payload = { userId: 'admin_user', name: 'Master Admin', role: 'admin', tenantId: 'default' };

  if (roleKey === 'cust_1') {
    payload = { userId: 'user_cust_1', name: 'Customer One', role: 'customer', tenantId: 'tenant_A' };
  } else if (roleKey === 'cust_2') {
    payload = { userId: 'user_cust_2', name: 'Customer Two', role: 'customer', tenantId: 'tenant_B' };
  } else if (roleKey === 'dealer_A') {
    payload = { userId: 'dealer_1', name: 'Dealer A', role: 'dealer', tenantId: 'tenant_A' };
  }

  try {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': MASTER_API_KEY
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success && data.token) {
      currentToken = data.token;
      return currentToken;
    }
  } catch (e) {}

  return null;
}

async function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch (e) {}
  }

  const selectedRole = roleSwitcher ? roleSwitcher.value : 'admin';
  const token = await obtainTokenForRole(selectedRole);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${token || ''}`;

  addLog(`[SYSTEM] Authenticating WebSocket as [${selectedRole.toUpperCase()}]...`, 'system-log');
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    addLog(`[SYSTEM] WebSocket Connected & Authenticated (${selectedRole}).`, 'system-log');
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleVideoFrame(event.data);
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      handleJsonMessage(msg);
    } catch (e) {
      console.error('Invalid WS JSON:', e);
    }
  };

  ws.onclose = (evt) => {
    if (evt.code === 1008) {
      addLog('[SECURITY] WebSocket Handshake Rejected: Policy Violation (1008).', 'error-log');
    } else {
      addLog('[SYSTEM] WebSocket Disconnected. Reconnecting in 3s...', 'system-log');
      setTimeout(connectWebSocket, 3000);
    }
  };
}

function isH264Keyframe(uint8) {
  for (let i = 0; i < Math.min(uint8.length - 4, 64); i++) {
    if (uint8[i] === 0x00 && uint8[i + 1] === 0x00 && (uint8[i + 2] === 0x01 || (uint8[i + 2] === 0x00 && buf[i + 3] === 0x01))) {
      const nalByte = uint8[i + 2] === 0x01 ? uint8[i + 3] : uint8[i + 4];
      const nalType = nalByte & 0x1f;
      if (nalType === 7 || nalType === 8 || nalType === 5) {
        return true;
      }
    }
  }
  return false;
}

function handleVideoFrame(arrayBuffer) {
  frameCount++;
  const uint8 = new Uint8Array(arrayBuffer);

  if (!hasSeenKeyframe) {
    if (isH264Keyframe(uint8)) {
      hasSeenKeyframe = true;
    }
  }

  if (!isStreaming) {
    setStreamingState(true);
  }

  if (jmuxer) {
    jmuxer.feed({ video: uint8 });
  }

  if (videoOverlay && !videoOverlay.classList.contains('hidden')) {
    videoOverlay.classList.add('hidden');
  }

  if (playerEl.paused) {
    playerEl.play().catch(() => {});
  }

  const now = Date.now();
  if (now - lastFpsTime >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    fpsBadge.textContent = `${fps} FPS`;
    frameCount = 0;
    lastFpsTime = now;
  }
}

function handleJsonMessage(msg) {
  switch (msg.type) {
    case 'device_list':
      updateDeviceList(msg.devices || [], msg.vehicles || []);
      break;

    case 'device_connected':
      addLog(`[JT808] 0x0100 Device Registered: ${msg.simNo} (Auth: ${msg.authCode})`, 'rx-log');
      break;

    case 'device_location':
      updateLocation(msg);
      break;

    case 'packet_log':
      addPacketLog(msg);
      break;

    case 'stream_started':
      addLog(`[JT1078] Live Stream Started on Channel ${msg.channel}`, 'system-log');
      setStreamingState(true);
      break;

    case 'stream_stopped':
      addLog(`[JT1078] Live Stream Stopped`, 'system-log');
      setStreamingState(false);
      break;

    case 'error':
      addLog(`[ERROR] ${msg.message}`, 'error-log');
      break;
  }
}

function updateDeviceList(devices, vehicles = []) {
  const currentVal = deviceSelect.value;
  deviceSelect.innerHTML = '';

  const displayList = vehicles.length > 0 ? vehicles : devices;

  if (displayList.length === 0) {
    deviceSelect.innerHTML = '<option value="">No vehicles assigned</option>';
    activeDevice = null;
    return;
  }

  displayList.forEach((item) => {
    const sim = item.simNo;
    const isOnline = item.isOnline || item.online;
    const plate = item.numberPlate ? ` [${item.numberPlate}]` : '';
    const opt = document.createElement('option');
    opt.value = sim;
    opt.textContent = `${sim}${plate} (${isOnline ? 'ONLINE' : 'OFFLINE'})`;
    deviceSelect.appendChild(opt);
  });

  if (currentVal && Array.from(deviceSelect.options).some(o => o.value === currentVal)) {
    deviceSelect.value = currentVal;
  } else {
    deviceSelect.value = displayList[0].simNo;
  }

  activeDevice = deviceSelect.value;
}

function updateLocation(data) {
  if (data.simNo !== activeDevice && activeDevice !== null) return;

  const lat = data.latitude;
  const lng = data.longitude;
  const speed = data.speedKmh || data.speed || 0.0;
  const course = data.direction || data.course || 0;
  const acc = data.accOn !== undefined ? data.accOn : data.acc;

  speedVal.innerHTML = `${speed.toFixed(1)} <small>km/h</small>`;
  headingVal.innerHTML = `${course.toFixed(0)}° <small>${getCardinalDirection(course)}</small>`;

  if (acc) {
    accVal.textContent = 'ON';
    accVal.className = 'stat-val status-acc-on';
  } else {
    accVal.textContent = 'OFF';
    accVal.className = 'stat-val status-acc-off';
  }

  if (data.extras) {
    if (data.extras.satellites !== undefined) satVal.textContent = data.extras.satellites;
    if (data.extras.signalStrength !== undefined) signalVal.textContent = `${data.extras.signalStrength} / 31`;
    if (data.extras.mileageKm !== undefined) mileageVal.innerHTML = `${data.extras.mileageKm.toFixed(1)} <small>km</small>`;
  }

  if (lat && lng && map && vehicleMarker) {
    const latLng = [lat, lng];
    vehicleMarker.setLatLng(latLng);
    map.panTo(latLng);

    const vehicleIcon = document.getElementById('vehicleIcon');
    if (vehicleIcon) {
      vehicleIcon.style.transform = `rotate(${course}deg)`;
    }

    gpsStatusBadge.className = 'badge badge-online';
    gpsStatusBadge.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    trajectoryCoords.push(latLng);
    if (trajectoryCoords.length > 500) trajectoryCoords.shift();
    if (trajectoryPath) trajectoryPath.setLatLngs(trajectoryCoords);
  }
}

function getCardinalDirection(angle) {
  const directions = ['North', 'NE', 'East', 'SE', 'South', 'SW', 'West', 'NW'];
  return directions[Math.round(angle / 45) % 8];
}

function setStreamingState(streaming) {
  isStreaming = streaming;
  if (streaming) {
    liveBadge.className = 'badge badge-online';
    liveBadge.innerHTML = '<i class="fa-solid fa-circle"></i> LIVE';
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = false;
  } else {
    liveBadge.className = 'badge badge-offline';
    liveBadge.innerHTML = '<i class="fa-solid fa-circle"></i> STANDBY';
    startLiveBtn.disabled = false;
    stopLiveBtn.disabled = true;
    fpsBadge.textContent = '0 FPS';
    hasSeenKeyframe = false;

    if (videoOverlay) {
      videoOverlay.classList.remove('hidden');
      overlayText.textContent = 'Live stream stopped';
    }
  }
}

function addLog(text, className = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${className}`;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="timestamp">[${time}]</span> ${text}`;
  logsContainer.appendChild(entry);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function addPacketLog(p) {
  const isTx = p.direction === 'OUT';
  const entry = document.createElement('div');
  entry.className = `log-entry ${isTx ? 'tx-log' : 'rx-log'}`;
  const time = new Date().toLocaleTimeString();
  const dirIcon = isTx ? '⬆️ OUT' : (p.direction === 'MEDIA' ? '🎥 MEDIA' : '⬇️ IN');
  entry.innerHTML = `<span class="timestamp">[${time}]</span> <span class="badge ${isTx ? 'badge-primary' : 'badge-info'}">${p.protocol || 'JT808'}</span> <b>${dirIcon} ${p.msgId}</b>: ${p.desc || ''}`;
  logsContainer.appendChild(entry);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Event Listeners
startLiveBtn.addEventListener('click', () => {
  if (!activeDevice || !ws || ws.readyState !== WebSocket.OPEN) return;

  const channel = parseInt(channelSelect.value, 10);
  const streamType = parseInt(streamTypeSelect.value, 10);

  currentChannel = channel;
  channelBadge.textContent = channel === 1 ? 'FRONT (CH 1)' : (channel === 2 ? 'CABIN (CH 2)' : `CH ${channel}`);

  initJMuxer();
  overlayText.textContent = `Requesting Channel ${channel} Live Stream from ${activeDevice}...`;

  ws.send(JSON.stringify({
    action: 'start_stream',
    simNo: activeDevice,
    channel,
    streamType
  }));
});

stopLiveBtn.addEventListener('click', () => {
  if (!activeDevice || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    action: 'stop_stream',
    simNo: activeDevice,
    channel: currentChannel
  }));

  setStreamingState(false);
});

btnFrontCam.addEventListener('click', () => {
  channelSelect.value = "1";
  startLiveBtn.click();
});

btnCabinCam.addEventListener('click', () => {
  channelSelect.value = "2";
  startLiveBtn.click();
});

if (roleSwitcher) {
  roleSwitcher.addEventListener('change', () => {
    connectWebSocket();
  });
}

// SD Playback Modal
if (btnQueryPlayback) {
  btnQueryPlayback.addEventListener('click', () => {
    playbackModal.style.display = 'flex';
  });
}

if (closePlaybackBtn) {
  closePlaybackBtn.addEventListener('click', () => {
    playbackModal.style.display = 'none';
  });
}

if (btnFetchSdRecords) {
  btnFetchSdRecords.addEventListener('click', async () => {
    if (!activeDevice) return;
    playbackRecordsList.innerHTML = '<p style="color: #38bdf8;">Querying physical SD card (0x9205)...</p>';

    try {
      const res = await fetch(`/api/vehicles/${activeDevice}/playback/records?channel=${currentChannel}`, {
        headers: {
          'Authorization': `Bearer ${currentToken}`
        }
      });
      const data = await res.json();

      if (data.success && data.data && data.data.length > 0) {
        playbackRecordsList.innerHTML = '';
        data.data.forEach((rec, idx) => {
          const div = document.createElement('div');
          div.style.cssText = 'background: #1e293b; padding: 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;';
          div.innerHTML = `
            <div>
              <b>Ch ${rec.channel}: ${rec.startTime} ➔ ${rec.endTime}</b><br>
              <small style="color: #94a3b8;">Size: ${(rec.fileSize / 1024 / 1024).toFixed(1)} MB | Storage: SD Card</small>
            </div>
            <button class="btn btn-primary btn-sm" onclick="startSdPlayback('${rec.startTime}', '${rec.endTime}')">Play (0x9201)</button>
          `;
          playbackRecordsList.appendChild(div);
        });
      } else {
        playbackRecordsList.innerHTML = `<p style="color: #f59e0b;">No recordings found on SD card for this period.</p>`;
      }
    } catch (err) {
      playbackRecordsList.innerHTML = `<p style="color: #ef4444;">Error: ${err.message}</p>`;
    }
  });
}

window.startSdPlayback = async (startTime, endTime) => {
  if (!activeDevice) return;
  addLog(`[PLAYBACK] Requesting 0x9201 SD Playback: ${startTime} - ${endTime}`, 'system-log');
  playbackModal.style.display = 'none';

  initJMuxer();
  try {
    const res = await fetch(`/api/vehicles/${activeDevice}/playback/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({
        channel: currentChannel,
        startTime,
        endTime
      })
    });
    const data = await res.json();
    if (data.success) {
      setStreamingState(true);
    }
  } catch (e) {}
};

clearLogsBtn.addEventListener('click', () => {
  logsContainer.innerHTML = '';
});

// App Startup
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  initJMuxer();
  connectWebSocket();
});
