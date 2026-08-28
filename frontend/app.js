/**
 * Dashcam Command Center Frontend Application
 * Handles WebSocket communication, Leaflet GPS live tracking, and JMuxer H.264 video rendering.
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
let lastFpsTime = Date.now();

// DOM Elements
const playerEl = document.getElementById('player');
const videoOverlay = document.getElementById('videoOverlay');
const overlayText = document.getElementById('overlayText');
const liveBadge = document.getElementById('liveBadge');
const fpsBadge = document.getElementById('fpsBadge');
const gpsStatusBadge = document.getElementById('gpsStatusBadge');
const deviceSelect = document.getElementById('deviceSelect');
const channelSelect = document.getElementById('channelSelect');
const streamTypeSelect = document.getElementById('streamTypeSelect');
const startLiveBtn = document.getElementById('startLiveBtn');
const stopLiveBtn = document.getElementById('stopLiveBtn');
const simControlBtn = document.getElementById('simControlBtn');
const simBtnText = document.getElementById('simBtnText');
const logsContainer = document.getElementById('logsContainer');
const clearLogsBtn = document.getElementById('clearLogsBtn');

const jt808PortDisplay = document.getElementById('jt808PortDisplay');
const jt1078PortDisplay = document.getElementById('jt1078PortDisplay');

// Telemetry DOM
const speedVal = document.getElementById('speedVal');
const headingVal = document.getElementById('headingVal');
const accVal = document.getElementById('accVal');
const satVal = document.getElementById('satVal');
const signalVal = document.getElementById('signalVal');
const mileageVal = document.getElementById('mileageVal');

function initMap() {
  const defaultPos = [13.0827, 80.2707];
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
  vehicleMarker.bindPopup("<b>Dashcam Vehicle</b><br>Waiting for GPS...").openPopup();

  trajectoryPath = L.polyline([], { color: '#00f2fe', weight: 4, opacity: 0.8 }).addTo(map);
}

function initJMuxer() {
  if (jmuxer) {
    try { jmuxer.destroy(); } catch (e) {}
  }

  jmuxer = new JMuxer({
    node: 'player',
    mode: 'video',
    flushingTime: 0,
    clearBuffer: true,
    fps: 25,
    debug: false,
    onError: function(data) {
      console.warn('JMuxer warning/error:', data);
    }
  });
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  addLog(`[SYSTEM] Connecting to WebSocket Server at ${wsUrl}...`, 'system-log');
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    addLog('[SYSTEM] WebSocket Connected successfully.', 'system-log');
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

  ws.onclose = () => {
    addLog('[SYSTEM] WebSocket Disconnected. Reconnecting in 3s...', 'system-log');
    setTimeout(connectWebSocket, 3000);
  };
}

function handleVideoFrame(arrayBuffer) {
  if (!isStreaming) {
    setStreamingState(true);
  }

  frameCount++;
  const uint8 = new Uint8Array(arrayBuffer);

  if (jmuxer) {
    jmuxer.feed({
      video: uint8
    });
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
    case 'server_info':
      if (jt808PortDisplay && msg.jt808Port) jt808PortDisplay.textContent = msg.jt808Port;
      if (jt1078PortDisplay && msg.jt1078Port) jt1078PortDisplay.textContent = msg.jt1078Port;
      break;

    case 'device_list':
      updateDeviceList(msg.devices);
      break;

    case 'device_connected':
      addLog(`[JT808] Device Online: ${msg.simNo}`, 'log-in');
      refreshDevices();
      break;

    case 'device_location':
      handleLocationUpdate(msg);
      break;

    case 'packet_log':
      const cls = msg.direction === 'IN' ? 'log-in' : (msg.direction === 'MEDIA' ? 'log-media' : 'log-out');
      addLog(`[${msg.protocol || 'JT808'}] ${msg.direction} ${msg.msgId || ''} ${msg.desc || ''}`, cls);
      break;

    case 'stream_started':
      setStreamingState(true);
      addLog(`[JT1078] Live video stream request sent (Seq: ${msg.seqNo})`, 'log-out');
      break;

    case 'stream_stopped':
      setStreamingState(false);
      addLog(`[JT1078] Live video stream stopped.`, 'log-out');
      break;

    case 'sim_status':
      isSimRunning = msg.running;
      simBtnText.textContent = isSimRunning ? 'Stop Mock Dashcam' : 'Start Mock Dashcam';
      simControlBtn.classList.toggle('running', isSimRunning);
      break;
  }
}

function updateDeviceList(devices) {
  const currentVal = deviceSelect.value;
  deviceSelect.innerHTML = '';

  if (!devices || devices.length === 0) {
    deviceSelect.innerHTML = '<option value="">No device connected</option>';
    activeDevice = null;
    return;
  }

  devices.forEach(dev => {
    const opt = document.createElement('option');
    opt.value = dev.simNo;
    opt.textContent = `SIM: ${dev.simNo} ${dev.online ? '(ONLINE)' : '(OFFLINE)'}`;
    deviceSelect.appendChild(opt);
  });

  if (currentVal && devices.some(d => d.simNo === currentVal)) {
    deviceSelect.value = currentVal;
  } else {
    deviceSelect.value = devices[0].simNo;
  }
  activeDevice = deviceSelect.value;
}

function handleLocationUpdate(data) {
  if (data.latitude && data.longitude) {
    const latLng = [data.latitude, data.longitude];
    vehicleMarker.setLatLng(latLng);

    const iconEl = document.getElementById('vehicleIcon');
    if (iconEl && data.direction !== undefined) {
      iconEl.style.transform = `rotate(${data.direction - 45}deg)`;
    }

    trajectoryCoords.push(latLng);
    if (trajectoryCoords.length > 500) trajectoryCoords.shift();
    trajectoryPath.setLatLngs(trajectoryCoords);

    map.panTo(latLng);
    gpsStatusBadge.className = 'badge badge-online';
    gpsStatusBadge.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> GPS 3D FIX';

    vehicleMarker.getPopup().setContent(`
      <b>Device: ${data.simNo}</b><br>
      Speed: ${data.speedKmh.toFixed(1)} km/h<br>
      Heading: ${data.direction}°<br>
      Time: ${data.time}
    `);
  }

  speedVal.innerHTML = `${(data.speedKmh || 0).toFixed(1)} <small>km/h</small>`;
  headingVal.innerHTML = `${data.direction || 0}° <small>${getCardinalDirection(data.direction || 0)}</small>`;

  if (data.accOn !== undefined) {
    accVal.textContent = data.accOn ? 'ON' : 'OFF';
    accVal.className = `stat-val ${data.accOn ? 'status-acc-on' : 'status-acc-off'}`;
  }

  if (data.extras) {
    if (data.extras.satellites !== undefined) satVal.textContent = data.extras.satellites;
    if (data.extras.signalStrength !== undefined) signalVal.textContent = `${data.extras.signalStrength} / 31`;
    if (data.extras.mileageKm !== undefined) mileageVal.innerHTML = `${data.extras.mileageKm.toFixed(1)} <small>km</small>`;
  }
}

function getCardinalDirection(deg) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(deg / 45) % 8];
}

function setStreamingState(streaming) {
  isStreaming = streaming;
  if (streaming) {
    liveBadge.className = 'badge badge-online';
    liveBadge.innerHTML = '<i class="fa-solid fa-circle"></i> LIVE (JT1078)';
    videoOverlay.classList.add('hidden');
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = false;
  } else {
    liveBadge.className = 'badge badge-offline';
    liveBadge.innerHTML = '<i class="fa-solid fa-circle"></i> STANDBY';
    fpsBadge.textContent = '0 FPS';
    videoOverlay.classList.remove('hidden');
    overlayText.textContent = 'Live stream standby. Click Request Live Stream below.';
    startLiveBtn.disabled = false;
    stopLiveBtn.disabled = true;
  }
}

function addLog(text, className = '') {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${className}`;
  entry.innerHTML = `<span class="timestamp">[${time}]</span> ${text}`;
  logsContainer.appendChild(entry);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function refreshDevices() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'get_devices' }));
  }
}

startLiveBtn.addEventListener('click', () => {
  const simNo = deviceSelect.value;
  if (!simNo) {
    alert('Please select or connect a dashcam device first.');
    return;
  }
  const channel = parseInt(channelSelect.value, 10);
  const streamType = parseInt(streamTypeSelect.value, 10);

  initJMuxer();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'start_stream',
      simNo,
      channel,
      streamType
    }));
  }
  overlayText.textContent = 'Sending 0x9101 request to Dashcam...';
});

stopLiveBtn.addEventListener('click', () => {
  const simNo = deviceSelect.value;
  const channel = parseInt(channelSelect.value, 10);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'stop_stream',
      simNo,
      channel
    }));
  }
  setStreamingState(false);
});

simControlBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'toggle_simulator'
    }));
  }
});

clearLogsBtn.addEventListener('click', () => {
  logsContainer.innerHTML = '';
});

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  initJMuxer();
  connectWebSocket();
});
