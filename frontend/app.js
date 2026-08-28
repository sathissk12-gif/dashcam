/**
 * Dashcam Command Center Frontend Application
 * Ultra-Low-Latency H.264 Live Stream Player, Two-Way Audio Talkback & GPS Live Tracking
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

function isH264Keyframe(uint8) {
  for (let i = 0; i < Math.min(uint8.length - 4, 64); i++) {
    if (uint8[i] === 0x00 && uint8[i + 1] === 0x00 && (uint8[i + 2] === 0x01 || (uint8[i + 2] === 0x00 && uint8[i + 3] === 0x01))) {
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
    jmuxer.feed({
      video: uint8
    });
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
    case 'server_info':
      if (jt808PortDisplay) jt808PortDisplay.textContent = '5023';
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
      if (msg.channel) updateChannelUI(msg.channel);
      addLog(`[JT1078] Live video stream request sent (Ch: ${msg.channel || currentChannel})`, 'log-out');
      break;

    case 'talkback_started':
      addLog(`[JT1078] Two-Way Talkback Audio Enabled (Ch: ${msg.channel})`, 'log-out');
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

function updateChannelUI(ch) {
  currentChannel = ch;
  channelSelect.value = ch;
  if (ch === 1 || ch === 64) {
    channelBadge.className = 'badge badge-info';
    channelBadge.innerHTML = `<i class="fa-solid fa-road"></i> FRONT (CH ${ch})`;
    if (btnFrontCam) {
      btnFrontCam.style.background = '#0284c7';
      btnFrontCam.style.color = '#fff';
    }
    if (btnCabinCam) {
      btnCabinCam.style.background = '#334155';
      btnCabinCam.style.color = '#fff';
    }
  } else {
    channelBadge.className = 'badge badge-warning';
    channelBadge.innerHTML = `<i class="fa-solid fa-user"></i> CABIN (CH ${ch})`;
    if (btnCabinCam) {
      btnCabinCam.style.background = '#0284c7';
      btnCabinCam.style.color = '#fff';
    }
    if (btnFrontCam) {
      btnFrontCam.style.background = '#334155';
      btnFrontCam.style.color = '#fff';
    }
  }
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

function requestStream(channel) {
  const simNo = deviceSelect.value;
  if (!simNo) {
    alert('Please select or connect a dashcam device first.');
    return;
  }
  const streamType = parseInt(streamTypeSelect.value, 10);
  updateChannelUI(channel);

  initJMuxer();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'start_stream',
      simNo,
      channel,
      streamType,
      mediaPort: 5023
    }));
  }
  overlayText.textContent = `Streaming Camera Channel ${channel} (Live)...`;
}

// 🎤 Two-Way Talkback Microphone Functions
async function startTalkback() {
  const simNo = deviceSelect.value;
  if (!simNo) {
    alert('Please select a connected dashcam first.');
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 8000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
    const source = audioContext.createMediaStreamSource(micStream);
    audioProcessor = audioContext.createScriptProcessor(512, 1, 1);

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        action: 'start_talkback',
        simNo,
        channel: currentChannel
      }));
    }

    audioProcessor.onaudioprocess = (e) => {
      if (!isTalking) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert Float32Array [-1.0, 1.0] to 16-bit PCM Buffer
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Convert to Base64 and send via WebSocket
      const bytes = new Uint8Array(pcm16.buffer);
      let binaryStr = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binaryStr += String.fromCharCode(bytes[i]);
      }
      const b64Audio = btoa(binaryStr);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'talkback_audio',
          simNo,
          channel: currentChannel,
          audioData: b64Audio
        }));
      }
    };

    isTalking = true;
    talkbackBtn.style.background = '#dc2626';
    talkbackBtn.innerHTML = '<i class="fa-solid fa-microphone-lines"></i> 🔴 TRANSMITTING VOICE (Click to Stop)';
    talkbackStatus.textContent = 'Transmitting Voice...';
    talkbackStatus.style.color = '#ef4444';
    addLog('[TALKBACK] Microphone active. Transmitting voice to Dashcam speaker...', 'log-out');

  } catch (err) {
    alert('Microphone access error: ' + err.message);
    stopTalkback();
  }
}

function stopTalkback() {
  isTalking = false;
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  talkbackBtn.style.background = '#059669';
  talkbackBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Hold to Talk / Start Two-Way Audio';
  talkbackStatus.textContent = 'Mic Idle';
  talkbackStatus.style.color = '#94a3b8';
  addLog('[TALKBACK] Voice transmission stopped.', 'log-out');
}

if (talkbackBtn) {
  talkbackBtn.addEventListener('click', () => {
    if (isTalking) {
      stopTalkback();
    } else {
      startTalkback();
    }
  });
}

startLiveBtn.addEventListener('click', () => {
  const channel = parseInt(channelSelect.value, 10);
  requestStream(channel);
});

if (btnFrontCam) {
  btnFrontCam.addEventListener('click', () => {
    requestStream(1);
  });
}

if (btnCabinCam) {
  btnCabinCam.addEventListener('click', () => {
    requestStream(2);
  });
}

channelSelect.addEventListener('change', () => {
  const channel = parseInt(channelSelect.value, 10);
  if (isStreaming) {
    requestStream(channel);
  } else {
    updateChannelUI(channel);
  }
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
