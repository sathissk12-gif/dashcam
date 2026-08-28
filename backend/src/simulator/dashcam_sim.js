const net = require('net');
const { parseJT808Frame, buildJT808Packet, stringToBcd } = require('../jt808/codec');
const { getSampleFrame } = require('./h264_sample');

class DashcamSimulator {
  constructor(options = {}) {
    this.serverHost = options.serverHost || '127.0.0.1';
    this.jt808Port = options.jt808Port || 7788;
    this.simNo = options.simNo || '013800138000';
    this.seqNo = 0;
    this.mediaSocket = null;
    this.mediaInterval = null;
    this.gpsInterval = null;
    this.heartbeatInterval = null;
    this.frameIndex = 0;
    this.mediaSeq = 0;

    // Initial GPS Coordinates (e.g. Chennai city route)
    this.lat = 13.0827;
    this.lng = 80.2707;
    this.speed = 38.5;
    this.heading = 90;
    this.mileage = 12450.0;
  }

  getNextSeq() {
    this.seqNo = (this.seqNo + 1) & 0xffff;
    return this.seqNo;
  }

  start() {
    console.log(`[Simulator] Connecting to JT808 Server at ${this.serverHost}:${this.jt808Port}...`);
    this.jt808Socket = net.createConnection({ host: this.serverHost, port: this.jt808Port }, () => {
      console.log(`[Simulator] Connected to JT808 Server. Starting registration...`);
      this.sendRegistration();
    });

    let rxBuffer = Buffer.alloc(0);
    this.jt808Socket.on('data', (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      while (rxBuffer.length > 0) {
        const startIdx = rxBuffer.indexOf(0x7e);
        if (startIdx === -1) {
          rxBuffer = Buffer.alloc(0);
          break;
        }

        const endIdx = rxBuffer.indexOf(0x7e, startIdx + 1);
        if (endIdx === -1) {
          if (startIdx > 0) rxBuffer = rxBuffer.subarray(startIdx);
          break;
        }

        const frameBuf = rxBuffer.subarray(startIdx, endIdx + 1);
        rxBuffer = rxBuffer.subarray(endIdx + 1);

        try {
          const parsed = parseJT808Frame(frameBuf);
          this.handleServerMessage(parsed);
        } catch (err) {
          console.error(`[Simulator] Parse error:`, err.message);
        }
      }
    });

    this.jt808Socket.on('close', () => {
      console.log(`[Simulator] Disconnected from JT808 Server.`);
      this.stop();
    });

    this.jt808Socket.on('error', (err) => {
      console.error(`[Simulator] Socket error:`, err.message);
    });
  }

  handleServerMessage(parsed) {
    const { msgId, seqNo, body } = parsed;
    const msgIdHex = `0x${msgId.toString(16).padStart(4, '0').toUpperCase()}`;
    console.log(`[Simulator] Received from server: ${msgIdHex} (Seq: ${seqNo})`);

    if (msgId === 0x8100) {
      const result = body[2];
      const authCode = body.subarray(3).toString('ascii');
      console.log(`[Simulator] Registration Result: ${result === 0 ? 'Success' : 'Fail'}, AuthCode: ${authCode}`);
      if (result === 0) {
        this.sendAuthentication(authCode);
      }
    }

    if (msgId === 0x8001) {
      const replyMsgId = body.readUInt16BE(2);
      if (replyMsgId === 0x0102) {
        console.log(`[Simulator] Authentication Successful! Starting GPS Location & Heartbeat timers.`);
        this.startTimers();
      }
    }

    if (msgId === 0x9101) {
      console.log(`[Simulator] Received 0x9101 Live Video Request!`);
      const ipLen = body[0];
      const ip = body.subarray(1, 1 + ipLen).toString('ascii');
      const tcpPort = body.readUInt16BE(1 + ipLen);
      const udpPort = body.readUInt16BE(3 + ipLen);
      const channel = body[5 + ipLen];
      const dataType = body[6 + ipLen];
      const streamType = body[7 + ipLen];

      console.log(`[Simulator] Streaming Target -> ${ip}:${tcpPort} (Channel ${channel}, Stream ${streamType})`);

      this.sendGeneralAck(seqNo, 0x9101, 0);
      this.startMediaStreaming({ ip, port: tcpPort, channel, dataType, streamType });
    }

    if (msgId === 0x9102) {
      console.log(`[Simulator] Received 0x9102 Stop Video Stream.`);
      this.stopMediaStreaming();
      this.sendGeneralAck(seqNo, 0x9102, 0);
    }
  }

  sendRegistration() {
    const body = Buffer.alloc(2 + 2 + 5 + 20 + 7 + 1 + 8);
    body.writeUInt16BE(33, 0);
    body.writeUInt16BE(100, 2);
    Buffer.from('BSJ01', 'ascii').copy(body, 4);
    Buffer.from('T98-NON-AI'.padEnd(20, '\0'), 'ascii').copy(body, 9);
    Buffer.from('T980001'.padEnd(7, '\0'), 'ascii').copy(body, 29);
    body.writeUInt8(1, 36);
    Buffer.from('TN01AB1234', 'ascii').copy(body, 37);

    const packet = buildJT808Packet({
      msgId: 0x0100,
      simNo: this.simNo,
      seqNo: this.getNextSeq(),
      body
    });

    this.jt808Socket.write(packet);
    console.log(`[Simulator] Sent 0x0100 Registration Packet.`);
  }

  sendAuthentication(authCode) {
    const body = Buffer.from(authCode, 'ascii');
    const packet = buildJT808Packet({
      msgId: 0x0102,
      simNo: this.simNo,
      seqNo: this.getNextSeq(),
      body
    });

    this.jt808Socket.write(packet);
    console.log(`[Simulator] Sent 0x0102 Authentication Packet.`);
  }

  sendGeneralAck(replySeq, replyMsgId, result = 0) {
    const body = Buffer.alloc(5);
    body.writeUInt16BE(replySeq, 0);
    body.writeUInt16BE(replyMsgId, 2);
    body.writeUInt8(result, 4);

    const packet = buildJT808Packet({
      msgId: 0x0001,
      simNo: this.simNo,
      seqNo: this.getNextSeq(),
      body
    });

    this.jt808Socket.write(packet);
  }

  startTimers() {
    if (!this.gpsInterval) {
      this.gpsInterval = setInterval(() => this.sendLocationReport(), 2000);
      this.sendLocationReport();
    }

    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 15000);
    }
  }

  sendHeartbeat() {
    const packet = buildJT808Packet({
      msgId: 0x0002,
      simNo: this.simNo,
      seqNo: this.getNextSeq(),
      body: Buffer.alloc(0)
    });
    this.jt808Socket.write(packet);
    console.log(`[Simulator] Sent 0x0002 Heartbeat.`);
  }

  sendLocationReport() {
    this.lat += 0.00015 * Math.cos(this.heading * Math.PI / 180);
    this.lng += 0.00015 * Math.sin(this.heading * Math.PI / 180);
    this.mileage += 0.015;

    const body = Buffer.alloc(28 + 6 + 3 + 3);
    body.writeUInt32BE(0, 0);
    body.writeUInt32BE(0x00000003, 4);

    body.writeUInt32BE(Math.round(this.lat * 1000000), 8);
    body.writeUInt32BE(Math.round(this.lng * 1000000), 12);
    body.writeUInt16BE(15, 16);
    body.writeUInt16BE(Math.round(this.speed * 10), 18);
    body.writeUInt16BE(this.heading, 20);

    const now = new Date();
    const yy = (now.getFullYear() % 100).toString().padStart(2, '0');
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    const hh = now.getHours().toString().padStart(2, '0');
    const min = now.getMinutes().toString().padStart(2, '0');
    const ss = now.getSeconds().toString().padStart(2, '0');
    const timeBcd = stringToBcd(`${yy}${mm}${dd}${hh}${min}${ss}`, 6);
    timeBcd.copy(body, 22);

    let offset = 28;
    body.writeUInt8(0x01, offset++);
    body.writeUInt8(4, offset++);
    body.writeUInt32BE(Math.round(this.mileage * 10), offset);
    offset += 4;

    body.writeUInt8(0x30, offset++);
    body.writeUInt8(1, offset++);
    body.writeUInt8(28, offset++);

    body.writeUInt8(0x31, offset++);
    body.writeUInt8(1, offset++);
    body.writeUInt8(12, offset++);

    const packet = buildJT808Packet({
      msgId: 0x0200,
      simNo: this.simNo,
      seqNo: this.getNextSeq(),
      body: body.subarray(0, offset)
    });

    this.jt808Socket.write(packet);
  }

  startMediaStreaming({ ip, port, channel = 1 }) {
    this.stopMediaStreaming();

    console.log(`[Simulator] Connecting to JT1078 Media Server at ${ip}:${port}...`);
    this.mediaSocket = net.createConnection({ host: ip, port }, () => {
      console.log(`[Simulator] Connected to Media Server. Streaming H.264 at 25fps...`);
      this.frameIndex = 0;

      this.mediaInterval = setInterval(() => {
        const frame = getSampleFrame(this.frameIndex++);
        this.sendJT1078Frame(channel, frame);
      }, 40);
    });

    this.mediaSocket.on('error', (err) => {
      console.error(`[Simulator Media] Error:`, err.message);
    });
  }

  sendJT1078Frame(channel, { isKeyframe, data }) {
    if (!this.mediaSocket || this.mediaSocket.destroyed) return;

    const header = Buffer.alloc(30);
    header[0] = 0x30;
    header[1] = 0x31;
    header[2] = 0x63;
    header[3] = 0x64;

    header[4] = 0x81;
    header[5] = (1 << 7) | 98;

    header.writeUInt16BE(this.mediaSeq++ & 0xffff, 6);
    stringToBcd(this.simNo, 6).copy(header, 8);
    header.writeUInt8(channel, 14);

    const dataType = isKeyframe ? 0 : 1;
    header.writeUInt8((dataType << 4) | 0, 15);

    const nowMs = BigInt(Date.now());
    header.writeBigUInt64BE(nowMs, 16);
    header.writeUInt16BE(1000, 24);
    header.writeUInt16BE(40, 26);
    header.writeUInt16BE(data.length, 28);

    const fullPacket = Buffer.concat([header, data]);
    this.mediaSocket.write(fullPacket);
  }

  stopMediaStreaming() {
    if (this.mediaInterval) {
      clearInterval(this.mediaInterval);
      this.mediaInterval = null;
    }
    if (this.mediaSocket) {
      this.mediaSocket.destroy();
      this.mediaSocket = null;
    }
    console.log(`[Simulator] Media streaming stopped.`);
  }

  stop() {
    if (this.gpsInterval) clearInterval(this.gpsInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.stopMediaStreaming();
    if (this.jt808Socket) this.jt808Socket.destroy();
  }
}

module.exports = DashcamSimulator;
