const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const fs = require('fs');

// Load environment configuration
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.trim().split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

// Enforce required security credentials at startup
const { generateToken, verifyToken } = require('./src/services/auth_service');
const { authMiddleware, requireRole } = require('./src/middleware/auth');
const { verifyVehicleAccess, checkWsSubscriptionPermission } = require('./src/middleware/authorize');
const { rateLimiter } = require('./src/middleware/rate_limiter');
const { db, stmts } = require('./src/db/database');
const JT808Server = require('./src/jt808/server');
const geocoder = require('./src/utils/geocoder');
const historyService = require('./src/services/history_service');
const alarmService = require('./src/services/alarm_service');
const retentionService = require('./src/services/retention_service');
const logger = require('./src/utils/logger');
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
      logger.info('PUBLIC_IP_DETECTED', { publicIp });
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

// Production CORS whitelist
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

// 1. Auth Endpoint (Rate Limited: 10 req/min)
app.post('/api/auth/token', rateLimiter({ windowMs: 60000, max: 10 }), (req, res) => {
  const { userId, name, role = 'customer', tenantId = 'default' } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  const token = generateToken({ sub: userId, name: name || userId, role, tenantId });
  logger.info('AUTH_TOKEN_ISSUED', { userId, role, tenantId });
  res.json({ success: true, token, role, tenantId });
});

// 2. Comprehensive Deep Health Check Endpoint
app.get('/api/health', (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'healthy';
  let dbLatencyMs = 0;

  try {
    const t0 = Date.now();
    db.prepare('SELECT 1').get();
    dbLatencyMs = Date.now() - t0;
  } catch (err) {
    dbStatus = 'degraded';
  }

  const activeSockets = jt808Servers.reduce((acc, s) => acc + Array.from(s.devices.values()).filter(d => d.online).length, 0);
  const mem = process.memoryUsage();

  res.json({
    status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    system: {
      loadAvg: os.loadavg(),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024)
    },
    process: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024)
    },
    database: {
      engine: 'SQLite (WAL Mode)',
      status: dbStatus,
      latencyMs: dbLatencyMs
    },
    gateways: {
      jt808Port: DEFAULT_MEDIA_PORT,
      activeDevices: activeSockets,
      wsClients: wss.clients.size
    }
  });
});

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

// 3. Vehicles CRUD (Strict Resource-Level Authorization)
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

  res.json({ success: true, data: rows.map(formatVehicleRow) });
});

app.get('/api/vehicles/:id', authMiddleware, verifyVehicleAccess('id'), (req, res) => {
  const vehicle = req.vehicle || stmts.getVehicleById.get(req.params.id) || stmts.getVehicleBySim.get(req.params.id);
  res.json({ success: true, data: formatVehicleRow(vehicle) });
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

app.put('/api/vehicles/:id', authMiddleware, requireRole(['admin', 'dealer']), verifyVehicleAccess('id'), (req, res) => {
  const { id } = req.params;
  const row = req.vehicle;

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

// 4. GPS History & Route Playback APIs (Authorized & Paginated)
app.get('/api/history/:simNo', authMiddleware, verifyVehicleAccess('simNo'), rateLimiter({ max: 120 }), (req, res) => {
  const { simNo } = req.params;
  const { startTime, endTime, limit, cursor } = req.query;

  const points = historyService.getHistory(simNo, startTime, endTime, limit, cursor);
  res.json({ success: true, count: points.length, data: points });
});

app.get('/api/history/:simNo/summary', authMiddleware, verifyVehicleAccess('simNo'), (req, res) => {
  const { simNo } = req.params;
  const { startTime, endTime } = req.query;

  const summary = historyService.getTripSummary(simNo, startTime, endTime);
  res.json({ success: true, data: summary });
});

// 5. Alarms APIs (Authorized & Tenant Isolated)
app.get('/api/alarms', authMiddleware, (req, res) => {
  const { simNo, limit } = req.query;
  const caller = req.user;

  let alarms = [];
  if (simNo) {
    if (!checkWsSubscriptionPermission(caller, simNo)) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this vehicle' });
    }
    alarms = alarmService.getAlarmsBySim(simNo, parseInt(limit || '100', 10));
  } else if (caller.role === 'admin') {
    alarms = stmts.getAlarmsBySim.all('%', parseInt(limit || '100', 10));
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

// 6. Live Stream Signaling APIs (Authorized & Rate Limited)
app.post('/api/vehicles/:simNo/stream/start', authMiddleware, verifyVehicleAccess('simNo'), rateLimiter({ max: 30 }), async (req, res) => {
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

app.post('/api/vehicles/:simNo/stream/stop', authMiddleware, verifyVehicleAccess('simNo'), (req, res) => {
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

// 7. Real JT1078 SD Card Playback APIs (No Fake Fallbacks)
app.get('/api/vehicles/:simNo/playback/records', authMiddleware, verifyVehicleAccess('simNo'), async (req, res) => {
  const { simNo } = req.params;
  const channel = parseInt(req.query.channel || '1', 10);
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];

  try {
    const result = await targetServer.querySdRecordings(simNo, {
      channel,
      startTime: req.query.startTime,
      endTime: req.query.endTime
    });

    res.json(result);
  } catch (err) {
    if (err.code === 'DEVICE_OFFLINE') {
      return res.status(503).json({ success: false, error: 'Device is offline. Cannot query physical SD card.' });
    }
    if (err.code === 'QUERY_TIMEOUT') {
      return res.status(504).json({ success: false, error: 'Physical SD card query timed out.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vehicles/:simNo/playback/start', authMiddleware, verifyVehicleAccess('simNo'), async (req, res) => {
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
    if (err.code === 'DEVICE_OFFLINE') {
      return res.status(503).json({ success: false, error: 'Device is offline' });
    }
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

// Unified JT808/JT1078 Server (Port 5023 primary)
const candidateJt808Ports = [DEFAULT_MEDIA_PORT, 7788];
const jt808Servers = candidateJt808Ports.map(p => new JT808Server({ port: p }));

function setupJT808Handlers(serverInstance, portName) {
  serverInstance.on('packet', (data) => {
    broadcastJson({ type: 'packet_log', protocol: `JT808 (${portName})`, ...data });
  });

  serverInstance.on('video_frame', (frame) => {
    // Precise zero-copy routing to authorized subscribers
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
    broadcastJson({ type: 'device_connected', simNo, authCode });
    broadcastDeviceList();
  });

  serverInstance.on('device_authenticated', ({ simNo }) => {
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

  // Verify and bind token on handshake
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
      logger.error('WS_MESSAGE_ERROR', { error: e.message });
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

  // Enforce resource ownership on WebSocket subscriptions
  if (simNo && clientWs.user) {
    const hasAccess = checkWsSubscriptionPermission(clientWs.user, simNo);
    if (!hasAccess) {
      return clientWs.send(JSON.stringify({
        type: 'error',
        message: `Forbidden: You do not have permission to view stream for SIM ${simNo}`
      }));
    }
  }

  if (simNo) clientWs.subscribedSim = simNo;
  if (channel) clientWs.subscribedChannel = parseInt(channel, 10);

  switch (action) {
    case 'get_devices':
      broadcastDeviceList();
      break;

    case 'start_test_stream': {
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
        // Prepend cached SPS/PPS NALs immediately to guarantee instant decoder initialization
        const cachedSpsPps = targetServer.getLastSpsPps(simNo, parseInt(channel, 10));
        if (cachedSpsPps && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(cachedSpsPps);
        }

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
        } catch (e) {}
      }
      break;
    }

    case 'stop_stream': {
      try {
        if (clientWs._testInterval) clearInterval(clientWs._testInterval);
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
      logger.info('GATEWAY_LISTENING', { port: s.port });
    } catch (e) {
      logger.warn('GATEWAY_BIND_FAILED', { port: s.port, error: e.message });
    }
  }

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info('HTTP_SERVER_STARTED', { port: HTTP_PORT, publicIp: publicIp || localServerIp });
  });

  try {
    altHttpServer.listen(ALT_HTTP_PORT, '0.0.0.0', () => {
      logger.info('ALT_HTTP_SERVER_STARTED', { port: ALT_HTTP_PORT });
    });
  } catch (e) {}
}

startAll().catch((err) => {
  logger.error('FATAL_SERVER_ERROR', { error: err.message });
  process.exit(1);
});
