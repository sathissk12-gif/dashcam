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
const frontendDir = path.join(__dirname, '../frontend');
app.use(express.static(frontendDir));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    serverIp: publicIp || localServerIp,
    localIp: localServerIp,
    jt808Ports: activeJt808Ports,
    devicesCount: jt808Servers.reduce((acc, s) => acc + s.devices.size, 0)
  });
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
  broadcastJson({ type: 'device_list', devices, serverIp: publicIp || localServerIp });
}

wss.on('connection', (ws) => {
  console.log('[WebSocket] Web client connected.');
  broadcastDeviceList();
  ws.send(JSON.stringify({
    type: 'server_info',
    serverIp: publicIp || localServerIp,
    jt808Ports: activeJt808Ports,
    defaultMediaPort: DEFAULT_MEDIA_PORT
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
  const { action, simNo, channel = 1, streamType = 0, customIp, mediaPort } = data;
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
        
        // 1. Send stop command (0x9102) to reset existing channel stream
        try {
          targetServer.stopLiveVideo(simNo, 0);
        } catch (e) {}

        // 2. Wait 200ms for hardware sensor switch
        await new Promise(r => setTimeout(r, 200));

        // 3. Force Wakeup / Disable Sleep Mode (0x8103)
        try {
          targetServer.disableSleepMode(simNo);
        } catch (e) {}

        // 4. Request Live Video Stream on requested Channel (0x9101)
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
    console.log(`🚀 Web Dashboard available at http://0.0.0.0:${HTTP_PORT}`);
    console.log(`🌐 Server IP for Dashcam: ${publicIp || localServerIp}`);
  });
}

startAll().catch((err) => {
  console.error('Fatal Server Error:', err);
});
