const net = require('net');
const EventEmitter = require('events');
const { 
  parseJT808Frame, 
  buildJT808Packet, 
  parseLocationReport, 
  bcdToString,
  build0x9205,
  parse0x1205,
  build0x9201
} = require('./codec');
const { encodePcmToAlaw, buildJT1078AudioPacket } = require('../jt1078/audio');
const historyService = require('../services/history_service');
const alarmService = require('../services/alarm_service');

class JT808Server extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 5023;
    this.devices = new Map();
    this.serverSeq = 0;
    this.audioSeq = 0;
    this.frameAssemblers = new Map();
    this.lastSpsPpsMap = new Map();
    this.pendingQueries = new Map();

    // Start dead socket cleanup timer (reaps sockets dead for > 120s)
    this.cleanupTimer = setInterval(() => this.reapDeadSockets(), 30000);
  }

  reapDeadSockets() {
    const now = Date.now();
    for (const [simNo, dev] of this.devices.entries()) {
      if (dev.online && dev.lastSeen && (now - dev.lastSeen.getTime() > 120000)) {
        console.warn(`[JT808] Reaping dead/stale device session: ${simNo}`);
        dev.online = false;
        try { if (dev.socket) dev.socket.destroy(); } catch (e) {}
        this.emit('device_offline', { simNo });
      }
    }
  }

  getNextSeq() {
    this.serverSeq = (this.serverSeq + 1) & 0xffff;
    return this.serverSeq;
  }

  getNextAudioSeq() {
    this.audioSeq = (this.audioSeq + 1) & 0xffff;
    return this.audioSeq;
  }

  findJt1078Sync(buf) {
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x30 && buf[i + 1] === 0x31 && buf[i + 2] === 0x63 && buf[i + 3] === 0x64) {
        return i;
      }
    }
    return -1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const clientKey = `${socket.remoteAddress}:${socket.remotePort}`;
        let socketSim = null;
        let rxBuffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
          rxBuffer = Buffer.concat([rxBuffer, chunk]);

          while (rxBuffer.length > 0) {
            const rtpIdx = this.findJt1078Sync(rxBuffer);
            const jt808Idx = rxBuffer.indexOf(0x7e);

            if (rtpIdx !== -1 && (jt808Idx === -1 || rtpIdx < jt808Idx)) {
              if (rtpIdx > 0) rxBuffer = rxBuffer.subarray(rtpIdx);
              if (rxBuffer.length < 30) break;

              try {
                const dataTypeSub = rxBuffer[15];
                const dataType = (dataTypeSub >> 4) & 0x0f;
                const subpackage = dataTypeSub & 0x0f;
                const isVideo = dataType <= 2;
                const isAudio = dataType === 3;
                const headerLen = isVideo ? 30 : (isAudio ? 26 : 16);

                if (rxBuffer.length < headerLen) break;

                let bodyLen = 0;
                if (isVideo) bodyLen = rxBuffer.readUInt16BE(28);
                else if (isAudio) bodyLen = rxBuffer.readUInt16BE(24);

                const totalLen = headerLen + bodyLen;
                if (rxBuffer.length < totalLen) break;

                const packet = rxBuffer.subarray(0, totalLen);
                rxBuffer = rxBuffer.subarray(totalLen);

                this.handleJt1078Packet(packet, { headerLen, bodyLen, dataType, subpackage, isVideo, isAudio });
                continue;
              } catch (e) {
                rxBuffer = rxBuffer.subarray(4);
                continue;
              }
            }

            if (jt808Idx === -1) {
              rxBuffer = Buffer.alloc(0);
              break;
            }

            const endIdx = rxBuffer.indexOf(0x7e, jt808Idx + 1);
            if (endIdx === -1) {
              if (jt808Idx > 0) rxBuffer = rxBuffer.subarray(jt808Idx);
              break;
            }

            const frameBuf = rxBuffer.subarray(jt808Idx, endIdx + 1);
            rxBuffer = rxBuffer.subarray(endIdx + 1);

            try {
              const parsed = parseJT808Frame(frameBuf);
              socketSim = parsed.simNo;
              this.handleMessage(socket, parsed);
            } catch (err) {
              console.warn(`[JT808] Parse error on port ${this.port}:`, err.message);
            }
          }
        });

        socket.on('error', (err) => {
          if (socketSim) {
            const dev = this.devices.get(socketSim);
            if (dev) dev.online = false;
            this.emit('device_offline', { simNo: socketSim, error: err.message });
          }
        });

        socket.on('close', () => {
          if (socketSim) {
            const dev = this.devices.get(socketSim);
            if (dev && dev.socket === socket) {
              dev.online = false;
              this.emit('device_offline', { simNo: socketSim });
            }
            this.frameAssemblers.delete(`${socketSim}_1`);
            this.frameAssemblers.delete(`${socketSim}_2`);
          }
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  handleJt1078Packet(packet, meta) {
    const simNo = bcdToString(packet.subarray(4, 10));
    const channel = packet[14];
    const seqNo = packet.readUInt16BE(10);
    const streamKey = `${simNo}_${channel}`;
    const payload = packet.subarray(meta.headerLen);

    this.emit('media_packet', {
      simNo,
      channel,
      seqNo,
      dataType: meta.dataType,
      subpackage: meta.subpackage,
      bodyLen: meta.bodyLen
    });

    if (meta.isVideo) {
      const isKeyframe = meta.dataType === 0;

      if (meta.subpackage === 0) {
        let fullPayload = payload;
        if (isKeyframe) {
          const hasSpsPps = this.checkSpsPps(fullPayload);
          if (hasSpsPps) {
            this.lastSpsPpsMap.set(streamKey, fullPayload);
          }
        }
        this.emit('video_frame', {
          simNo,
          channel,
          isKeyframe,
          data: fullPayload
        });
      } else if (meta.subpackage === 1) {
        this.frameAssemblers.set(streamKey, [payload]);
      } else if (meta.subpackage === 3) {
        const chunks = this.frameAssemblers.get(streamKey) || [];
        chunks.push(payload);
        this.frameAssemblers.delete(streamKey);

        const fullFrame = Buffer.concat(chunks);
        this.emit('video_frame', {
          simNo,
          channel,
          isKeyframe,
          data: fullFrame
        });
      } else {
        const chunks = this.frameAssemblers.get(streamKey);
        if (chunks) {
          chunks.push(payload);
        }
      }
    } else if (meta.isAudio) {
      this.emit('audio_frame', {
        simNo,
        channel,
        seqNo,
        pt: packet[12] & 0x7f,
        data: payload
      });
    }
  }

  checkSpsPps(buf) {
    for (let i = 0; i < Math.min(buf.length - 4, 64); i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x00 && (buf[i + 2] === 0x01 || (buf[i + 2] === 0x00 && buf[i + 3] === 0x01))) {
        const nal = (buf[i + 2] === 0x01 ? buf[i + 3] : buf[i + 4]) & 0x1f;
        if (nal === 7 || nal === 8) return true;
      }
    }
    return false;
  }

  handleMessage(socket, parsed) {
    const { msgId, simNo, seqNo, body } = parsed;

    let device = this.devices.get(simNo);
    if (!device) {
      device = {
        simNo,
        socket,
        online: true,
        authenticated: false,
        lastSeen: new Date(),
        location: null,
        activeChannel: null
      };
      this.devices.set(simNo, device);
    } else {
      device.socket = socket;
      device.online = true;
      device.lastSeen = new Date();
    }

    this.emit('packet', {
      direction: 'IN',
      msgId: `0x${msgId.toString(16).padStart(4, '0').toUpperCase()}`,
      simNo,
      seqNo,
      desc: `Received packet 0x${msgId.toString(16).toUpperCase()}`
    });

    switch (msgId) {
      case 0x0100: {
        const authCode = `AUTH_${simNo.slice(-6)}`;
        device.authCode = authCode;

        const respBody = Buffer.alloc(3 + Buffer.byteLength(authCode, 'ascii'));
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt8(0, 2);
        respBody.write(authCode, 3, 'ascii');

        const packet = buildJT808Packet({
          msgId: 0x8100,
          simNo,
          seqNo: this.getNextSeq(),
          body: respBody
        });
        socket.write(packet);

        this.emit('device_registered', { simNo, authCode });
        break;
      }

      case 0x0102: {
        device.authenticated = true;
        const respBody = Buffer.alloc(5);
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt16BE(0x0102, 2);
        respBody.writeUInt8(0, 4);

        const packet = buildJT808Packet({
          msgId: 0x8001,
          simNo,
          seqNo: this.getNextSeq(),
          body: respBody
        });
        socket.write(packet);

        this.emit('device_authenticated', { simNo });
        break;
      }

      case 0x0002: {
        const respBody = Buffer.alloc(5);
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt16BE(0x0002, 2);
        respBody.writeUInt8(0, 4);

        const packet = buildJT808Packet({
          msgId: 0x8001,
          simNo,
          seqNo: this.getNextSeq(),
          body: respBody
        });
        socket.write(packet);

        this.emit('device_heartbeat', { simNo });
        break;
      }

      case 0x0200: {
        const locationData = parseLocationReport(body);
        if (locationData) {
          device.location = locationData;
          
          // 1. Persist to SQLite GPS History
          historyService.recordGpsPoint({ simNo, ...locationData });

          // 2. Persist Alarm if triggered
          if (locationData.alarmSign > 0) {
            alarmService.recordAlarm({
              simNo,
              alarmType: locationData.alarmSign,
              latitude: locationData.latitude,
              longitude: locationData.longitude,
              speedKmh: locationData.speedKmh
            });
          }

          this.emit('device_location', { simNo, ...locationData });
        }

        const respBody = Buffer.alloc(5);
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt16BE(0x0200, 2);
        respBody.writeUInt8(0, 4);

        const packet = buildJT808Packet({
          msgId: 0x8001,
          simNo,
          seqNo: this.getNextSeq(),
          body: respBody
        });
        socket.write(packet);
        break;
      }

      case 0x1205: {
        const result = parse0x1205(body);
        console.log(`[JT1078] Received 0x1205 SD Record List from ${simNo} (Found: ${result.count} files)`);
        
        const queryKey = `${simNo}_sd_records`;
        if (this.pendingQueries.has(queryKey)) {
          const resolver = this.pendingQueries.get(queryKey);
          this.pendingQueries.delete(queryKey);
          resolver(result.records);
        }

        this.emit('device_sd_records', { simNo, ...result });

        const respBody = Buffer.alloc(5);
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt16BE(0x1205, 2);
        respBody.writeUInt8(0, 4);
        socket.write(buildJT808Packet({ msgId: 0x8001, simNo, seqNo: this.getNextSeq(), body: respBody }));
        break;
      }

      default: {
        const respBody = Buffer.alloc(5);
        respBody.writeUInt16BE(seqNo, 0);
        respBody.writeUInt16BE(msgId, 2);
        respBody.writeUInt8(0, 4);

        const packet = buildJT808Packet({
          msgId: 0x8001,
          simNo,
          seqNo: this.getNextSeq(),
          body: respBody
        });
        socket.write(packet);
        break;
      }
    }
  }

  // 1. Query Real SD Card Records (0x9205)
  querySdRecordings(simNo, options = {}) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      return Promise.reject(new Error(`Device ${simNo} is not online`));
    }

    const body = build0x9205(options);
    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({
      msgId: 0x9205,
      simNo,
      seqNo,
      body
    });

    device.socket.write(packet);

    return new Promise((resolve) => {
      const queryKey = `${simNo}_sd_records`;
      const timeout = setTimeout(() => {
        if (this.pendingQueries.has(queryKey)) {
          this.pendingQueries.delete(queryKey);
          resolve([]);
        }
      }, 5000);

      this.pendingQueries.set(queryKey, (records) => {
        clearTimeout(timeout);
        resolve(records);
      });
    });
  }

  // 2. Request Real SD Card Playback Stream (0x9201)
  requestPlaybackStream(simNo, options = {}) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      throw new Error(`Device ${simNo} is not online`);
    }

    const body = build0x9201(options);
    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({
      msgId: 0x9201,
      simNo,
      seqNo,
      body
    });

    device.socket.write(packet);
    device.activeChannel = options.channel || 1;

    return { seqNo, simNo, channel: options.channel || 1 };
  }

  disableSleepMode(simNo) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) return;

    const body = Buffer.alloc(1 + 4 + 1 + 4);
    body.writeUInt8(1, 0);
    body.writeUInt32BE(0x0075, 1);
    body.writeUInt8(4, 5);
    body.writeUInt32BE(0x00000000, 6);

    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({ msgId: 0x8103, simNo, seqNo, body });
    device.socket.write(packet);
  }

  requestLiveVideo(simNo, options = {}) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      throw new Error(`Device ${simNo} is not online`);
    }

    const serverIp = options.serverIp || '127.0.0.1';
    const tcpPort = options.tcpPort || 5023;
    const udpPort = options.udpPort || 0;
    const channel = options.channel !== undefined ? options.channel : 1;
    const dataType = options.dataType !== undefined ? options.dataType : 0;
    const streamType = options.streamType !== undefined ? options.streamType : 1;

    const ipBuf = Buffer.from(serverIp, 'ascii');
    const ipLen = ipBuf.length;

    const body = Buffer.alloc(1 + ipLen + 2 + 2 + 1 + 1 + 1);
    let offset = 0;
    body.writeUInt8(ipLen, offset++);
    ipBuf.copy(body, offset);
    offset += ipLen;
    body.writeUInt16BE(tcpPort, offset);
    offset += 2;
    body.writeUInt16BE(udpPort, offset);
    offset += 2;
    body.writeUInt8(channel, offset++);
    body.writeUInt8(dataType, offset++);
    body.writeUInt8(streamType, offset++);

    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({ msgId: 0x9101, simNo, seqNo, body });
    device.socket.write(packet);
    device.activeChannel = channel;

    return { seqNo, simNo, channel, serverIp, tcpPort };
  }

  sendAudioFrame(simNo, pcmBuffer, channel = 1) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) return false;

    try {
      const alawData = encodePcmToAlaw(pcmBuffer);
      const rtpPacket = buildJT1078AudioPacket({
        simNo,
        channel,
        seqNo: this.getNextAudioSeq(),
        alawData,
        timestamp: Date.now()
      });

      device.socket.write(rtpPacket);
      return true;
    } catch (err) {
      return false;
    }
  }

  stopLiveVideo(simNo, channel = 0) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) return { success: false };

    const body = Buffer.alloc(4);
    body.writeUInt8(channel, 0);
    body.writeUInt8(0, 1);
    body.writeUInt8(0, 2);
    body.writeUInt8(0, 3);

    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({ msgId: 0x9102, simNo, seqNo, body });
    device.socket.write(packet);
    device.activeChannel = null;

    return { seqNo, simNo, channel };
  }
}

module.exports = JT808Server;
