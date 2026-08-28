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

const HTTP_PORT = parseInt(process.env.PORT || '9090', 10);
const DEFAULT_MEDIA_PORT = 5023;
let publicIp = process.env.PUBLIC_IP || null;

// Vehicle to Camera Registry Storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LINKS_FILE = path.join(DATA_DIR, 'vehicle_links.json');

function loadVehicleLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading vehicle links:', e.message);
  }
  return {};
}

function saveVehicleLinks(links) {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving vehicle links:', e.message);
  }
}

let vehicleLinks = loadVehicleLinks();

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
    linkedVehiclesCount: Object.keys(vehicleLinks).length
  });
});

// 2. Vehicle-Camera Link Registry APIs
app.get('/api/vehicles/links', (req, res) => {
  res.json({
    success: true,
    links: vehicleLinks
  });
});

app.get('/api/vehicles/link/:vehicleId', (req, res) => {
  const { vehicleId } = req.params;
  const link = vehicleLinks[vehicleId] || Object.values(vehicleLinks).find(v => v.imei === vehicleId || v.plateNo === vehicleId);
  if (link) {
    res.json({ success: true, link });
  } else {
    res.status(404).json({ success: false, message: 'Vehicle camera link not found' });
  }
});

app.post('/api/vehicles/link', (req, res) => {
  const { vehicleId, plateNo, imei, cameraId, isCameraLicense = true, cameraChannel = 1 } = req.body;
  if (!vehicleId || !cameraId) {
    return res.status(400).json({ success: false, message: 'vehicleId and cameraId are required' });
  }

  vehicleLinks[vehicleId] = {
    vehicleId,
    plateNo: plateNo || vehicleId,
    imei: imei || '',
    cameraId: String(cameraId).trim(),
    isCameraLicense: !!isCameraLicense,
    cameraChannel: parseInt(cameraChannel, 10) || 1,
    updatedAt: new Date().toISOString()
  };

  saveVehicleLinks(vehicleLinks);
  console.log(`[Registry] Linked Vehicle ${vehicleId} (${plateNo || ''}) -> Camera SIM ${cameraId}`);

  broadcastJson({
    type: 'vehicle_link_updated',
    link: vehicleLinks[vehicleId]
  });

  res.json({
    success: true,
    message: 'Vehicle camera link saved successfully',
    link: vehicleLinks[vehicleId]
  });
});

app.delete('/api/vehicles/link/:vehicleId', (req, res) => {
  const { vehicleId } = req.params;
  if (vehicleLinks[vehicleId]) {
    delete vehicleLinks[vehicleId];
    saveVehicleLinks(vehicleLinks);
    console.log(`[Registry] Unlinked Vehicle ${vehicleId}`);
    res.json({ success: true, message: 'Vehicle camera unlinked' });
  } else {
    res.status(404).json({ success: false, message: 'Link not found' });
  }
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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

// Multi-port listeners for Unified Signaling & Media: 5023, 8081, 9901, 7788, 9092
const candidateJt808Ports = [5023, 8081, 9901, 7788, 9092];
const jt808Servers = candidateJt808Ports.map(p => new JT808Server({ port: p }));
const activeJt808Ports = [];

let activeSimulator = null;

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

  serverInstance.on('device_location', (locData) => {
    broadcastJson({
      type: 'device_location',
      ...locData
    });
  });

  serverInstance.on('device_ack', (ackData) => {
    console.log(`[JT808:${portName}] Device ACK:`, ackData);
    broadcastJson({
      type: 'packet_log',
      protocol: `JT808 (${portName})`,
      direction: 'IN',
      msgId: '0x0001',
      desc: `Device ACK for ${ackData.replyMsgId} Result: ${ackData.result}`
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
    vehicleLinks
  });
}

wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected.');
  broadcastDeviceList();
  ws.send(JSON.stringify({
    type: 'server_info',
    serverIp: publicIp || localServerIp,
    jt808Ports: activeJt808Ports,
    defaultMediaPort: DEFAULT_MEDIA_PORT,
    vehicleLinks
  }));
  ws.send(JSON.stringify({ type: 'sim_status', running: !!activeSimulator }));

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

    case 'get_links':
      clientWs.send(JSON.stringify({ type: 'vehicle_links', links: vehicleLinks }));
      break;

    case 'start_stream': {
      try {
        console.log(`[Command] Switching/Starting Live Video on ${simNo} (Target: ${videoMediaIp}:${videoMediaPort}, Channel:${channel})...`);
        
        try {
          targetServer.stopLiveVideo(simNo, 0);
        } catch (e) {}

        await new Promise(r => setTimeout(r, 200));

        try {
          targetServer.disableSleepMode(simNo);
        } catch (e) {}

        const reqResult = targetServer.requestLiveVideo(simNo, {
          serverIp: videoMediaIp,
          tcpPort: videoMediaPort,
          udpPort: 0,
          channel: parseInt(channel, 10),
          dataType: 0, // Audio & Video
          streamType: parseInt(streamType, 10)
        });

        clientWs.send(JSON.stringify({
          type: 'stream_started',
          channel: parseInt(channel, 10),
          ...reqResult
        }));
      } catch (err) {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: err.message
        }));
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
          dataType: 2, // 2: Two-way Talkback Intercom
          streamType: 1
        });

        clientWs.send(JSON.stringify({
          type: 'talkback_started',
          simNo,
          channel: parseInt(channel, 10),
          ...reqResult
        }));
      } catch (err) {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: err.message
        }));
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
        clientWs.send(JSON.stringify({
          type: 'stream_stopped',
          ...stopResult
        }));
      } catch (err) {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: err.message
        }));
      }
      break;
    }

    case 'toggle_simulator': {
      if (activeSimulator) {
        activeSimulator.stop();
        activeSimulator = null;
        console.log('[Simulator] Mock Dashcam Stopped.');
      } else {
        activeSimulator = new DashcamSimulator({
          serverHost: '127.0.0.1',
          jt808Port: 5023,
          simNo: '013800138000'
        });
        activeSimulator.start();
        console.log('[Simulator] Mock Dashcam Started.');
      }
      broadcastJson({ type: 'sim_status', running: !!activeSimulator });
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
}

startAll().catch((err) => {
  console.error('Fatal Server Error:', err);
});
