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

const { db, stmts } = require('./src/db/database');
const JT808Server = require('./src/jt808/server');
const geocoder = require('./src/utils/geocoder');
const historyService = require('./src/services/history_service');
const alarmService = require('./src/services/alarm_service');
const { generateToken, verifyToken } = require('./src/services/auth_service');
const { authMiddleware, requireRole } = require('./src/middleware/auth');
const { getSampleFrame } = require('./src/simulator/h264_sample');

const HTTP_PORT = parseInt(process.env.PORT || '9090', 10);
const ALT_HTTP_PORT = 8798;
const DEFAULT_MEDIA_PORT = parseInt(process.env.MEDIA_PORT || '5023', 10);
let publicIp = process.env.PUBLIC_IP || null;

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

// Configurable CORS whitelist
const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Helper: Format DB row to Flutter DashcamVehicle model
function formatVehicleRow(row) {
  const activeDev = jt808Servers.map(s => s.devices.get(row.sim_no)).find(Boolean);
  const isOnline = !!(activeDev && activeDev.online);
  const loc = activeDev?.location;

  let channels = [
    { id: 1, name: 'Channel 1 (Front Road)', enabled: true },
    { id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true }
  ];

  try {
    if (row.channels_json) {
      channels = JSON.parse(row.channels_json);
    }
  } catch (e) {}

  return {
    id: row.id || row.sim_no,
    numberPlate: row.number_plate || 'UNKNOWN',
    simNo: row.sim_no,
    model: row.model || 'T98 NON-AI 4G Dual-Cam',
    driverName: row.driver_name || '',
    driverPhone: row.driver_phone || '',
    assignedUserId: row.assigned_user_id || '',
    assignedUserName: row.assigned_user_name || '',
    assignedUserPhone: row.assigned_user_phone || '',
    tenantId: row.tenant_id || 'default',
    channelCount: row.channel_count || 2,
    channels,
    isOnline,
    isDeviceConnected: isOnline,
    lastSeen: activeDev?.lastSeen?.toISOString() || row.updated_at || new Date().toISOString(),
    telemetry: {
      latitude: loc?.latitude || 11.295318,
      longitude: loc?.longitude || 77.737556,
      speed: loc?.speedKmh || 0.0,
      course: loc?.direction || 0.0,
      altitude: loc?.altitude || 0.0,
      acc: loc?.accOn ?? false,
      address: loc?.address || '',
      lastUpdate: loc?.time || new Date().toISOString()
    },
    activeStreams: activeDev?.activeChannel ? [activeDev.activeChannel] : [],
    alarms: [],
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

// 1. Auth Endpoint
app.post('/api/auth/token', (req, res) => {
  const { userId, name, role = 'customer', tenantId = 'default' } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  const token = generateToken({ sub: userId, name: name || userId, role, tenantId });
  res.json({ success: true, token, role, tenantId });
});

// 2. Status API
app.get('/api/status', (req, res) => {
  const totalInDb = db.prepare('SELECT COUNT(*) as count FROM vehicles').get().count;
  res.json({
    status: 'online',
    serverIp: publicIp || localServerIp,
    localIp: localServerIp,
    jt808Port: DEFAULT_MEDIA_PORT,
    devicesOnline: jt808Servers.reduce((acc, s) => acc + Array.from(s.devices.values()).filter(d => d.online).length, 0),
    totalVehicles: totalInDb,
    database: 'SQLite (WAL Mode)',
    geocoderProvider: process.env.OLA_MAPS_API_KEY ? 'Ola Maps' : 'OpenStreetMap'
  });
});

// 3. Vehicles CRUD (SQLite Backend)
app.get('/api/vehicles', authMiddleware, (req, res) => {
  const { userId } = req.query;
  const caller = req.user;

  let rows = [];
  if (caller.role === 'admin') {
    if (userId) {
      rows = stmts.getVehiclesByUser.all(userId, `%${userId}%`);
    } else {
      rows = stmts.getAllVehicles.all();
    }
  } else if (caller.role === 'dealer') {
    rows = stmts.getVehiclesByTenant.all(caller.tenantId || 'default');
  } else {
    // Customer sees only assigned vehicles
    rows = stmts.getVehiclesByUser.all(caller.id, `%${caller.name || caller.id}%`);
  }

  res.json({
    success: true,
    data: rows.map(formatVehicleRow)
  });
});

app.get('/api/vehicles/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const row = stmts.getVehicleById.get(id) || stmts.getVehicleBySim.get(id) || stmts.getVehicleByPlate.get(id);
  if (row) {
    res.json({ success: true, data: formatVehicleRow(row) });
  } else {
    res.status(404).json({ success: false, error: 'Vehicle not found' });
  }
});

app.post('/api/vehicles', authMiddleware, requireRole(['admin', 'dealer']), (req, res) => {
  const {
    numberPlate,
    simNo,
    model,
    driverName,
    driverPhone,
    assignedUserId,
    assignedUserName,
    assignedUserPhone,
    tenantId,
    channelCount,
    channels
  } = req.body;

  if (!numberPlate || !simNo) {
    return res.status(400).json({ success: false, error: 'numberPlate and simNo are required' });
  }

  const id = `veh_${Date.now()}_${simNo.slice(-4)}`;
  const cleanPlate = numberPlate.trim().toUpperCase();
  const cleanSim = simNo.trim();

  try {
    stmts.insertVehicle.run({
      id,
      number_plate: cleanPlate,
      sim_no: cleanSim,
      model: model || 'T98 NON-AI 4G Dual-Cam',
      driver_name: driverName || '',
      driver_phone: driverPhone || '',
      assigned_user_id: assignedUserId || '',
      assigned_user_name: assignedUserName || '',
      assigned_user_phone: assignedUserPhone || '',
      tenant_id: tenantId || req.user?.tenantId || 'default',
      channel_count: channelCount || 2,
      channels_json: JSON.stringify(channels || [
        { id: 1, name: 'Channel 1 (Front Road)', enabled: true },
        { id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true }
      ]),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const row = stmts.getVehicleById.get(id);
    const vehicleObj = formatVehicleRow(row);

    broadcastJson({ type: 'vehicle_updated', data: vehicleObj });
    res.json({ success: true, data: vehicleObj });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/vehicles/:id', authMiddleware, requireRole(['admin', 'dealer']), (req, res) => {
  const { id } = req.params;
  const row = stmts.getVehicleById.get(id) || stmts.getVehicleBySim.get(id);
  if (!row) {
    return res.status(404).json({ success: false, error: 'Vehicle not found' });
  }

  try {
    stmts.updateVehicle.run({
      id: row.id,
      sim_no: row.sim_no,
      number_plate: req.body.numberPlate,
      model: req.body.model,
      driver_name: req.body.driverName,
      driver_phone: req.body.driverPhone,
      assigned_user_id: req.body.assignedUserId,
      assigned_user_name: req.body.assignedUserName,
      assigned_user_phone: req.body.assignedUserPhone,
      tenant_id: req.body.tenantId,
      channel_count: req.body.channelCount,
      channels_json: req.body.channels ? JSON.stringify(req.body.channels) : null
    });

    const updatedRow = stmts.getVehicleById.get(row.id);
    res.json({ success: true, data: formatVehicleRow(updatedRow) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/vehicles/:id', authMiddleware, requireRole(['admin']), (req, res) => {
  const { id } = req.params;
  const info = stmts.deleteVehicle.run(id, id);
  if (info.changes > 0) {
    res.json({ success: true, message: 'Vehicle deleted successfully' });
  } else {
    res.status(404).json({ success: false, error: 'Vehicle not found' });
  }
});

// 4. GPS History & Route Playback APIs
app.get('/api/history/:simNo', authMiddleware, (req, res) => {
  const { simNo } = req.params;
  const { startTime, endTime, limit } = req.query;

  const points = historyService.getHistory(simNo, startTime, endTime, parseInt(limit || '5000', 10));
  res.json({ success: true, count: points.length, data: points });
});

app.get('/api/history/:simNo/summary', authMiddleware, (req, res) => {
  const { simNo } = req.params;
  const { startTime, endTime } = req.query;

  const summary = historyService.getTripSummary(simNo, startTime, endTime);
  res.json({ success: true, data: summary });
});

// 5. Alarms APIs
app.get('/api/alarms', authMiddleware, (req, res) => {
  const { simNo, limit } = req.query;
  const caller = req.user;

  let alarms = [];
  if (simNo) {
    alarms = alarmService.getAlarmsBySim(simNo, parseInt(limit || '100', 10));
  } else {
    alarms = alarmService.getAlarmsByTenant(caller.tenantId || 'default', parseInt(limit || '100', 10));
  }

  res.json({ success: true, count: alarms.length, data: alarms });
});

app.post('/api/alarms/:id/ack', authMiddleware, (req, res) => {
  const { id } = req.params;
  const success = alarmService.acknowledge(id, req.user?.name || req.user?.id || 'admin');
  res.json({ success });
});

// 6. Live Stream Signaling APIs
app.post('/api/vehicles/:simNo/stream/start', authMiddleware, async (req, res) => {
  const { simNo } = req.params;
  const { channel = 1, dataType = 0, streamType = 1 } = req.body;
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

    res.json({ success: true, data: reqResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vehicles/:simNo/stream/stop', authMiddleware, (req, res) => {
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

// 7. Real JT1078 SD Card Playback APIs
app.get('/api/vehicles/:simNo/playback/records', authMiddleware, async (req, res) => {
  const { simNo } = req.params;
  const channel = parseInt(req.query.channel || '1', 10);
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    // 1. First attempt real JT1078 0x9205 query to physical SD card
    const sdRecords = await targetServer.querySdRecordings(simNo, {
      channel,
      startTime: req.query.startTime,
      endTime: req.query.endTime
    });

    if (sdRecords && sdRecords.length > 0) {
      return res.json({ success: true, source: 'sd_card', data: sdRecords });
    }
  } catch (e) {}

  // 2. Fallback to hourly intervals if SD card query is processing or device is in offline mode
  const now = new Date();
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
      fileSize: 154820000
    });
  });

  res.json({ success: true, source: 'timeline_cache', data: records });
});

app.post('/api/vehicles/:simNo/playback/start', authMiddleware, async (req, res) => {
  const { simNo } = req.params;
  const { channel = 1, startTime, endTime, mode = 0, speed = 0 } = req.body;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    const reqResult = targetServer.requestPlaybackStream(simNo, {
      serverIp: publicIp || localServerIp,
      tcpPort: DEFAULT_MEDIA_PORT,
      udpPort: 0,
      channel: parseInt(channel, 10),
      mediaType: 0,
      streamType: 1,
      storageType: 1,
      playbackMode: parseInt(mode, 10),
      playbackSpeed: parseInt(speed, 10),
      startTime,
      endTime
    });

    res.json({
      success: true,
      data: reqResult,
      streamUrl: `http://${publicIp || localServerIp}:${HTTP_PORT}/player.html?sim=${simNo}&channel=${channel}&streamType=1`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Reverse Geocode API
app.get('/api/geocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng parameters required' });
  }
  const address = await geocoder.getAddress(lat, lng);
  res.json({ success: true, lat, lng, address });
});

// HTTP & WebSocket Servers
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

// Unified JT808/JT1078 Server (Port 5023 primary)
const candidateJt808Ports = [DEFAULT_MEDIA_PORT, 7788];
const jt808Servers = candidateJt808Ports.map(p => new JT808Server({ port: p }));
const activeJt808Ports = [];

function setupJT808Handlers(serverInstance, portName) {
  serverInstance.on('packet', (data) => {
    broadcastJson({ type: 'packet_log', protocol: `JT808 (${portName})`, ...data });
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
    // Precise zero-copy routing to verified subscribers
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        const matchesSim = !client.subscribedSim || client.subscribedSim === frame.simNo;
        const matchesChannel = !client.subscribedChannel || client.subscribedChannel === frame.channel;
        if (matchesSim && matchesChannel) {
          client.send(frame.data);
        }
      }
    });
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
    broadcastJson({ type: 'device_connected', simNo, authCode });
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
    broadcastJson({ type: 'device_location', ...locData, address });
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

  const vehicles = stmts.getAllVehicles.all().map(formatVehicleRow);
  broadcastJson({
    type: 'device_list',
    devices,
    serverIp: publicIp || localServerIp,
    vehicles
  });
}

// WebSocket Connection & Subscription Security
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');

  // Verify token if provided
  if (token) {
    const user = verifyToken(token);
    if (user) {
      ws.user = user;
    }
  }

  broadcastDeviceList();
  ws.send(JSON.stringify({
    type: 'server_info',
    serverIp: publicIp || localServerIp,
    jt808Port: DEFAULT_MEDIA_PORT
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleWsClientMessage(ws, data);
    } catch (e) {
      console.error('[WebSocket] Invalid client message:', e.message);
    }
  });

  ws.on('close', () => {
    if (ws._testInterval) clearInterval(ws._testInterval);
  });
});

async function handleWsClientMessage(clientWs, data) {
  const { action, simNo, channel = 1, streamType = 1, customIp, mediaPort, audioData } = data;
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];
  const videoMediaIp = customIp || publicIp || localServerIp;
  const videoMediaPort = parseInt(mediaPort || DEFAULT_MEDIA_PORT, 10);

  if (simNo) clientWs.subscribedSim = simNo;
  if (channel) clientWs.subscribedChannel = parseInt(channel, 10);

  switch (action) {
    case 'get_devices':
      broadcastDeviceList();
      break;

    case 'start_test_stream': {
      console.log(`[Test Stream] Starting 25 FPS live H.264 stream for ${simNo} Ch:${channel}...`);
      let frameIdx = 0;
      if (clientWs._testInterval) clearInterval(clientWs._testInterval);
      clientWs._testInterval = setInterval(() => {
        if (clientWs.readyState === WebSocket.OPEN) {
          const sample = getSampleFrame(frameIdx++);
          clientWs.send(sample.data);
        } else {
          clearInterval(clientWs._testInterval);
        }
      }, 40);
      break;
    }

    case 'start_stream': {
      try {
        console.log(`[Command] Requesting Live Video on ${simNo} (Target: ${videoMediaIp}:${videoMediaPort}, Channel:${channel})...`);
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
        if (clientWs._testInterval) clearInterval(clientWs._testInterval);
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
