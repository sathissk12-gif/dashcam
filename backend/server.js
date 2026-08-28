const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const fs = require('fs');

// Load environment variables from .env if present
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
const JT808_PORT = parseInt(process.env.JT808_PORT || '9901', 10);      // Primary Signaling (9901)
const JT808_ALT_PORT = parseInt(process.env.JT808_ALT_PORT || '9092', 10); // Alt Signaling (9092)
const JT1078_PORT = parseInt(process.env.JT1078_PORT || '9902', 10);    // Video Media (9902)
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

// 1. Initialize Express App (Serving ../frontend)
const app = express();
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    serverIp: publicIp || localServerIp,
    localIp: localServerIp,
    jt808Port: JT808_PORT,
    jt808AltPort: JT808_ALT_PORT,
    jt1078Port: JT1078_PORT,
    devicesCount: jt808Servers.reduce((acc, s) => acc + s.devices.size, 0)
  });
});

const httpServer = http.createServer(app);

// 2. Initialize WebSocket Server
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

// 3. Initialize Protocol Servers (Multi-port listeners for max compatibility)
const listeningPorts = Array.from(new Set([JT808_PORT, JT808_ALT_PORT]));
const jt808Servers = listeningPorts.map(p => new JT808Server({ port: p }));
const jt1078Server = new JT1078Server({ port: JT1078_PORT });

let activeSimulator = null;

function setupJT808Handlers(serverInstance, portName) {
  serverInstance.on('packet', (data) => {
    broadcastJson({
      type: 'packet_log',
      protocol: `JT808 (${portName})`,
      ...data
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

  serverInstance.on('device_offline', ({ simNo }) => {
    console.log(`[JT808:${portName}] Device Offline: ${simNo}`);
    broadcastDeviceList();
  });
}

jt808Servers.forEach((serverInstance, idx) => {
  setupJT808Handlers(serverInstance, listeningPorts[idx]);
});

// JT1078 Server Events
jt1078Server.on('packet', (data) => {
  broadcastJson({
    type: 'packet_log',
    protocol: 'JT1078',
    direction: 'MEDIA',
    msgId: `[${data.dataType}]`,
    desc: `Ch:${data.channel} Seq:${data.seqNo} Sub:${data.subpackage} Len:${data.bodyLen}B`
  });
});

jt1078Server.on('video_frame', (frame) => {
  broadcastBinary(frame.data);
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
          lastSeen: dev.lastSeen,
          location: dev.location
        });
      }
    });
  });
  broadcastJson({ type: 'device_list', devices, serverIp: publicIp || localServerIp });
}

// WebSocket Client Commands
wss.on('connection', (ws) => {
  console.log('[WebSocket] Web client connected.');
  broadcastDeviceList();
  ws.send(JSON.stringify({
    type: 'server_info',
    serverIp: publicIp || localServerIp,
    jt808Port: JT808_PORT,
    jt1078Port: JT1078_PORT
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

function handleWsClientMessage(clientWs, data) {
  const { action, simNo, channel = 1, streamType = 0, customIp } = data;
  
  const targetServer = jt808Servers.find(s => s.devices.has(simNo)) || jt808Servers[0];
  const videoMediaIp = customIp || publicIp || localServerIp;

  switch (action) {
    case 'get_devices':
      broadcastDeviceList();
      break;

    case 'start_stream': {
      try {
        console.log(`[Command] Requesting Live Video from ${simNo} (Media Target: ${videoMediaIp}:${JT1078_PORT}, Ch:${channel})...`);
        const reqResult = targetServer.requestLiveVideo(simNo, {
          serverIp: videoMediaIp,
          tcpPort: JT1078_PORT,
          channel: parseInt(channel, 10),
          dataType: 0,
          streamType: parseInt(streamType, 10)
        });
        clientWs.send(JSON.stringify({
          type: 'stream_started',
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

    case 'stop_stream': {
      try {
        console.log(`[Command] Stopping Live Video for ${simNo}...`);
        const stopResult = targetServer.stopLiveVideo(simNo, parseInt(channel, 10));
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
          jt808Port: JT808_PORT,
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
      console.log(`📡 JT808 TCP Server listening on port ${s.port}`);
    } catch (e) {
      console.warn(`Could not bind JT808 on port ${s.port}: ${e.message}`);
    }
  }

  try {
    await jt1078Server.start();
    console.log(`🎥 JT1078 Media TCP Server listening on port ${JT1078_PORT}`);
  } catch (e) {
    console.warn(`Could not bind JT1078 on port ${JT1078_PORT}: ${e.message}`);
  }

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`🚀 Web Dashboard available at http://0.0.0.0:${HTTP_PORT}`);
    console.log(`🌐 Server IP for Dashcam: ${publicIp || localServerIp}`);
  });
}

startAll().catch((err) => {
  console.error('Fatal Server Error:', err);
});
