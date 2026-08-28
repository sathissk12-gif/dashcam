const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const fs = require('fs');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.trim().split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const JT808Server = require('./src/jt808/server');
const JT1078Server = require('./src/jt1078/server');
const DashcamSimulator = require('./src/simulator/dashcam_sim');
const geocoder = require('./src/utils/geocoder');

const HTTP_PORT = parseInt(process.env.PORT || '9090', 10);
const ALT_HTTP_PORT = 8798;
const DEFAULT_MEDIA_PORT = 5023;
let publicIp = process.env.PUBLIC_IP || null;

// Vehicle Storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const VEHICLES_FILE = path.join(DATA_DIR, 'vehicles.json');

function loadVehicles() {
  try {
    if (fs.existsSync(VEHICLES_FILE)) {
      return JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading vehicles:', e.message);
  }
  return {};
}

function saveVehicles(data) {
  try {
    fs.writeFileSync(VEHICLES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving vehicles:', e.message);
  }
}

let dashcamVehicles = loadVehicles();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const localServerIp = getLocalIp();

async function detectPublicIp() {
  if (publicIp) return publicIp;
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data && data.ip) {
      publicIp = data.ip;
      console.log(`🌐 Detected Public Server IP: ${publicIp}`);
    }
  } catch (e) {
    publicIp = localServerIp;
  }
  return publicIp;
}

detectPublicIp();

const app = express();
app.use(express.json());
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

// CORS for mobile app access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 1. Status API
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    serverIp: publicIp || localServerIp,
    localIp: localServerIp,
    jt808Ports: activeJt808Ports,
    devicesCount: jt808Servers.reduce((acc, s) => acc + s.devices.size, 0),
    totalVehicles: getDistinctVehicles().length,
    geocoderProvider: process.env.OLA_MAPS_API_KEY ? 'Ola Maps' : 'OpenStreetMap'
  });
});

function getDistinctVehicles() {
  const map = new Map();
  Object.values(dashcamVehicles).forEach(v => {
    if (v && v.id) map.set(v.id, v);
  });
  return Array.from(map.values());
}

// Helper: Format vehicle for Flutter DashcamVehicle model
function formatVehicleObj(v) {
  const isOnline = jt808Servers.some(s => s.devices.has(v.simNo) && s.devices.get(v.simNo).online);
  const activeDev = jt808Servers.map(s => s.devices.get(v.simNo)).find(Boolean);
  const loc = activeDev?.location;

  return {
    id: v.id || v.simNo,
    numberPlate: v.numberPlate || 'UNKNOWN',
    simNo: v.simNo,
    model: v.model || 'T98 NON-AI 4G Dual-Cam',
    driverName: v.driverName || '',
    driverPhone: v.driverPhone || '',
    assignedUserId: v.assignedUserId || '',
    assignedUserName: v.assignedUserName || '',
    assignedUserPhone: v.assignedUserPhone || '',
    channelCount: v.channelCount || 2,
    channels: v.channels || [
      { id: 1, name: 'Channel 1 (Front Road)', enabled: true },
      { id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true }
    ],
    isOnline: !!isOnline,
    isDeviceConnected: !!isOnline,
    lastSeen: activeDev?.lastSeen?.toISOString() || v.updatedAt || new Date().toISOString(),
    telemetry: {
      latitude: loc?.latitude || v.telemetry?.latitude || 11.295318,
      longitude: loc?.longitude || v.telemetry?.longitude || 77.737556,
      speed: loc?.speedKmh || v.telemetry?.speed || 0.0,
      course: loc?.direction || v.telemetry?.course || 0.0,
      altitude: loc?.altitude || v.telemetry?.altitude || 0.0,
      acc: loc?.accOn ?? v.telemetry?.acc ?? false,
      address: loc?.address || v.telemetry?.address || '',
      lastUpdate: loc?.time || v.telemetry?.lastUpdate || new Date().toISOString()
    },
    activeStreams: activeDev?.activeChannel ? [activeDev.activeChannel] : [],
    alarms: [],
    createdAt: v.createdAt || new Date().toISOString(),
    updatedAt: v.updatedAt || new Date().toISOString()
  };
}

// 2. Vehicles CRUD for Flutter App DashcamApiService
app.get('/api/vehicles', (req, res) => {
  const { userId } = req.query;
  let list = getDistinctVehicles();
  if (userId) {
    list = list.filter(v => 
      v.assignedUserId === userId || 
      (v.assignedUserName && v.assignedUserName.toLowerCase().includes(userId.toLowerCase()))
    );
  }
  res.json({
    success: true,
    data: list.map(formatVehicleObj)
  });
});

app.get('/api/vehicles/:id', (req, res) => {
  const { id } = req.params;
  const v = dashcamVehicles[id] || Object.values(dashcamVehicles).find(x => x.simNo === id || x.numberPlate === id);
  if (v) {
    res.json({
      success: true,
      data: formatVehicleObj(v)
    });
  } else {
    res.status(404).json({ success: false, error: 'Vehicle not found' });
  }
});

app.post('/api/vehicles', (req, res) => {
  const { 
    numberPlate, 
    simNo, 
    model, 
    driverName, 
    driverPhone, 
    assignedUserId, 
    assignedUserName, 
    assignedUserPhone, 
    channelCount, 
    channels 
  } = req.body;

  if (!numberPlate || !simNo) {
    return res.status(400).json({ success: false, error: 'numberPlate and simNo are required' });
  }

  const id = `veh_${Date.now()}_${simNo.slice(-4)}`;
  const cleanPlate = numberPlate.trim().toUpperCase();
  const cleanSim = simNo.trim();

  const newVehicle = {
    id,
    numberPlate: cleanPlate,
    simNo: cleanSim,
    model: model || 'T98 NON-AI 4G Dual-Cam',
    driverName: driverName || '',
    driverPhone: driverPhone || '',
    assignedUserId: assignedUserId || '',
    assignedUserName: assignedUserName || '',
    assignedUserPhone: assignedUserPhone || '',
    channelCount: channelCount || 2,
    channels: channels || [
      { id: 1, name: 'Channel 1 (Front Road)', enabled: true },
      { id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  dashcamVehicles[id] = newVehicle;
  saveVehicles(dashcamVehicles);

  console.log(`[API] Created Dashcam Vehicle: ${cleanPlate} -> SIM: ${cleanSim}`);

  broadcastJson({
    type: 'vehicle_updated',
    data: formatVehicleObj(newVehicle)
  });

  res.json({
    success: true,
    data: formatVehicleObj(newVehicle)
  });
});

app.put('/api/vehicles/:id', (req, res) => {
  const { id } = req.params;
  let v = dashcamVehicles[id] || Object.values(dashcamVehicles).find(x => x.simNo === id);
  if (!v) {
    return res.status(404).json({ success: false, error: 'Vehicle not found' });
  }

  Object.assign(v, req.body, { updatedAt: new Date().toISOString() });
  saveVehicles(dashcamVehicles);

  res.json({
    success: true,
    data: formatVehicleObj(v)
  });
});

app.delete('/api/vehicles/:id', (req, res) => {
  const { id } = req.params;
  let deleted = false;
  if (dashcamVehicles[id]) {
    delete dashcamVehicles[id];
    deleted = true;
  }
  if (deleted) {
    saveVehicles(dashcamVehicles);
    res.json({ success: true, message: 'Vehicle deleted' });
  } else {
    res.status(404).json({ success: false, error: 'Vehicle not found' });
  }
});

// 3. Live Stream Signaling APIs
app.post('/api/vehicles/:simNo/stream/start', async (req, res) => {
  const { simNo } = req.params;
  const { channel = 1, dataType = 0, streamType = 0 } = req.body;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    try { targetServer.stopLiveVideo(simNo, 0); } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
    try { targetServer.disableSleepMode(simNo); } catch (e) {}

    const reqResult = targetServer.requestLiveVideo(simNo, {
      serverIp: publicIp || localServerIp,
      tcpPort: DEFAULT_MEDIA_PORT,
      udpPort: 0,
      channel: parseInt(channel, 10),
      dataType: parseInt(dataType, 10),
      streamType: parseInt(streamType, 10)
    });

    res.json({
      success: true,
      data: reqResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vehicles/:simNo/stream/stop', (req, res) => {
  const { simNo } = req.params;
  const { channel = 0 } = req.body;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    const stopResult = targetServer.stopLiveVideo(simNo, parseInt(channel, 10));
    res.json({ success: true, data: stopResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Remote SD Card Playback APIs
app.get('/api/vehicles/:simNo/playback/records', (req, res) => {
  const { simNo } = req.params;
  const channel = parseInt(req.query.channel || '1', 10);
  const now = new Date();
  
  // Generate available hourly recording blocks for the selected day
  const records = [];
  const hours = [8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20];
  const datePrefix = req.query.startTime ? req.query.startTime.substring(0, 10) : now.toISOString().substring(0, 10);

  hours.forEach(h => {
    const startHourStr = String(h).padStart(2, '0');
    const endHourStr = String(h + 1).padStart(2, '0');
    records.push({
      channel: channel,
      startTime: `${datePrefix} ${startHourStr}:00:00`,
      endTime: `${datePrefix} ${endHourStr}:00:00`,
      alarmFlag: 0,
      mediaType: 0,
      streamType: 1,
      storageType: 1,
      fileSize: 154820000 // ~150 MB
    });
  });

  res.json({
    success: true,
    data: records
  });
});

app.post('/api/vehicles/:simNo/playback/start', async (req, res) => {
  const { simNo } = req.params;
  const { channel = 1, startTime, endTime, mode = 0, speed = 0 } = req.body;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    const reqResult = targetServer.requestLiveVideo(simNo, {
      serverIp: publicIp || localServerIp,
      tcpPort: DEFAULT_MEDIA_PORT,
      udpPort: 0,
      channel: parseInt(channel, 10),
      dataType: 1, // Playback video stream
      streamType: 1
    });

    res.json({
      success: true,
      data: reqResult,
      streamUrl: `http://${publicIp || localServerIp}:${HTTP_PORT}/player.html?sim=${simNo}&channel=${channel}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vehicles/:simNo/playback/control', (req, res) => {
  res.json({ success: true, message: 'Playback control sent' });
});

// 5. Reverse Geocode API
app.get('/api/geocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng parameters required' });
  }
  const address = await geocoder.getAddress(lat, lng);
  res.json({ success: true, lat, lng, address });
});

// Create HTTP Server & WebSocket
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const altHttpServer = http.createServer(app);

function broadcastJson(obj) {
  const jsonStr = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jsonStr);
    }
  });
}

function broadcastBinary(binaryData) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(binaryData);
    }
  });
}

// Multi-port listeners for Unified Signaling & Media
const candidateJt808Ports = [5023, 8081, 9901, 7788, 9092];
const jt808Servers = candidateJt808Ports.map(p => new JT808Server({ port: p }));
const activeJt808Ports = [];

function setupJT808Handlers(serverInstance, portName) {
  serverInstance.on('packet', (data) => {
    broadcastJson({
      type: 'packet_log',
      protocol: `JT808 (${portName})`,
      ...data
    });
  });

  serverInstance.on('media_packet', (data) => {
    broadcastJson({
      type: 'packet_log',
      protocol: `JT1078 (${portName})`,
      direction: 'MEDIA',
      msgId: `[${data.dataType}]`,
      desc: `Ch:${data.channel} Seq:${data.seqNo} Sub:${data.subpackage} Len:${data.bodyLen}B`
    });
  });

  serverInstance.on('video_frame', (frame) => {
    broadcastBinary(frame.data);
  });

  serverInstance.on('audio_frame', (audioFrame) => {
    broadcastJson({
      type: 'dashcam_audio',
      simNo: audioFrame.simNo,
      channel: audioFrame.channel,
      pt: audioFrame.pt,
      data: audioFrame.data.toString('base64')
    });
  });

  serverInstance.on('device_registered', ({ simNo, authCode }) => {
    console.log(`[JT808:${portName}] Device Registered: ${simNo}`);
    broadcastJson({
      type: 'device_connected',
      simNo,
      authCode
    });
    broadcastDeviceList();
  });

  serverInstance.on('device_authenticated', ({ simNo }) => {
    console.log(`[JT808:${portName}] Device Authenticated: ${simNo}`);
    broadcastDeviceList();
  });

  serverInstance.on('device_location', async (locData) => {
    let address = 'Loading Address...';
    try {
      address = await geocoder.getAddress(locData.latitude, locData.longitude, locData.simNo);
    } catch (e) {}

    locData.address = address;

    broadcastJson({
      type: 'device_location',
      ...locData,
      address
    });
  });

  serverInstance.on('device_offline', ({ simNo }) => {
    console.log(`[JT808:${portName}] Device Offline: ${simNo}`);
    broadcastDeviceList();
  });
}

jt808Servers.forEach((serverInstance, idx) => {
  setupJT808Handlers(serverInstance, candidateJt808Ports[idx]);
});

function broadcastDeviceList() {
  const devices = [];
  jt808Servers.forEach((server) => {
    server.devices.forEach((dev, simNo) => {
      if (!devices.some(d => d.simNo === simNo)) {
        devices.push({
          simNo,
          online: dev.online,
          authenticated: dev.authenticated,
          activeChannel: dev.activeChannel,
          lastSeen: dev.lastSeen,
          location: dev.location
        });
      }
    });
  });
  broadcastJson({
    type: 'device_list',
    devices,
    serverIp: publicIp || localServerIp,
    vehicles: getDistinctVehicles().map(formatVehicleObj)
  });
}

wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected.');
  broadcastDeviceList();
  ws.send(JSON.stringify({
    type: 'server_info',
    serverIp: publicIp || localServerIp,
    jt808Ports: activeJt808Ports,
    defaultMediaPort: DEFAULT_MEDIA_PORT
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleWsClientMessage(ws, data);
    } catch (e) {
      console.error('[WebSocket] Invalid client message:', e.message);
    }
  });
});

async function handleWsClientMessage(clientWs, data) {
  const { action, simNo, channel = 1, streamType = 0, customIp, mediaPort, audioData } = data;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];
  const videoMediaIp = customIp || publicIp || localServerIp;
  const videoMediaPort = parseInt(mediaPort || DEFAULT_MEDIA_PORT, 10);

  switch (action) {
    case 'get_devices':
      broadcastDeviceList();
      break;

    case 'start_stream': {
      try {
        console.log(`[Command] Switching/Starting Live Video on ${simNo} (Target: ${videoMediaIp}:${videoMediaPort}, Channel:${channel})...`);
        try { targetServer.stopLiveVideo(simNo, 0); } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
        try { targetServer.disableSleepMode(simNo); } catch (e) {}

        const reqResult = targetServer.requestLiveVideo(simNo, {
          serverIp: videoMediaIp,
          tcpPort: videoMediaPort,
          udpPort: 0,
          channel: parseInt(channel, 10),
          dataType: 0,
          streamType: parseInt(streamType, 10)
        });

        clientWs.send(JSON.stringify({
          type: 'stream_started',
          channel: parseInt(channel, 10),
          ...reqResult
        }));
      } catch (err) {
        clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      break;
    }

    case 'start_talkback': {
      try {
        console.log(`[Talkback] Enabling Two-way Audio Intercom with ${simNo}...`);
        const reqResult = targetServer.requestLiveVideo(simNo, {
          serverIp: videoMediaIp,
          tcpPort: videoMediaPort,
          udpPort: 0,
          channel: parseInt(channel, 10),
          dataType: 2,
          streamType: 1
        });

        clientWs.send(JSON.stringify({
          type: 'talkback_started',
          simNo,
          channel: parseInt(channel, 10),
          ...reqResult
        }));
      } catch (err) {
        clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      break;
    }

    case 'talkback_audio': {
      if (audioData) {
        try {
          const pcmBuf = Buffer.from(audioData, 'base64');
          targetServer.sendAudioFrame(simNo, pcmBuf, parseInt(channel, 10));
        } catch (e) {
          console.warn('Audio send error:', e.message);
        }
      }
      break;
    }

    case 'stop_stream': {
      try {
        console.log(`[Command] Stopping Live Video for ${simNo}...`);
        const stopResult = targetServer.stopLiveVideo(simNo, parseInt(channel || 0, 10));
        clientWs.send(JSON.stringify({ type: 'stream_stopped', ...stopResult }));
      } catch (err) {
        clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      break;
    }
  }
}

async function startAll() {
  for (const s of jt808Servers) {
    try {
      await s.start();
      activeJt808Ports.push(s.port);
      console.log(`📡 Unified JT808/JT1078 Server listening on port ${s.port}`);
    } catch (e) {
      console.warn(`Could not bind port ${s.port}: ${e.message}`);
    }
  }

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`🚀 Web Dashboard & API available at http://0.0.0.0:${HTTP_PORT}`);
    console.log(`🌐 Server IP for Dashcam: ${publicIp || localServerIp}`);
  });

  try {
    altHttpServer.listen(ALT_HTTP_PORT, '0.0.0.0', () => {
      console.log(`🚀 Alt HTTP Port listening on http://0.0.0.0:${ALT_HTTP_PORT}`);
    });
  } catch (e) {}
}

startAll().catch((err) => {
  console.error('Fatal Server Error:', err);
});
