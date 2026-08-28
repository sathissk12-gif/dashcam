const net = require('net');
const EventEmitter = require('events');
const { parseJT808Frame, buildJT808Packet, parseLocationReport } = require('./codec');

class JT808Server extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 7788;
    this.devices = new Map();
    this.serverSeq = 0;
  }

  getNextSeq() {
    this.serverSeq = (this.serverSeq + 1) & 0xffff;
    return this.serverSeq;
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
            const startIdx = rxBuffer.indexOf(0x7e);
            if (startIdx === -1) {
              rxBuffer = Buffer.alloc(0);
              break;
            }

            const endIdx = rxBuffer.indexOf(0x7e, startIdx + 1);
            if (endIdx === -1) {
              if (startIdx > 0) {
                rxBuffer = rxBuffer.subarray(startIdx);
              }
              break;
            }

            const frameBuf = rxBuffer.subarray(startIdx, endIdx + 1);
            rxBuffer = rxBuffer.subarray(endIdx + 1);

            try {
              const parsed = parseJT808Frame(frameBuf);
              socketSim = parsed.simNo;
              this.handleMessage(socket, parsed);
            } catch (err) {
              this.emit('error', { error: err.message, rawHex: frameBuf.toString('hex') });
            }
          }
        });

        socket.on('close', () => {
          if (socketSim && this.devices.has(socketSim)) {
            const dev = this.devices.get(socketSim);
            dev.online = false;
            this.emit('device_offline', { simNo: socketSim });
          }
        });

        socket.on('error', (err) => {
          this.emit('socket_error', { clientKey, error: err.message });
        });
      });

      this.server.listen(this.port, () => {
        resolve(this.port);
      });

      this.server.on('error', (err) => reject(err));
    });
  }

  handleMessage(socket, parsed) {
    const { msgId, simNo, seqNo, body } = parsed;

    if (!this.devices.has(simNo)) {
      this.devices.set(simNo, {
        simNo,
        socket,
        online: true,
        authenticated: false,
        registered: false,
        lastSeen: new Date(),
        location: null
      });
    }

    const device = this.devices.get(simNo);
    device.socket = socket;
    device.online = true;
    device.lastSeen = new Date();

    this.emit('packet', {
      direction: 'IN',
      msgId: `0x${msgId.toString(16).padStart(4, '0').toUpperCase()}`,
      simNo,
      seqNo,
      bodyHex: body.toString('hex')
    });

    switch (msgId) {
      case 0x0100: {
        device.registered = true;
        const authCode = `AUTH_${simNo.slice(-6)}`;
        const respBody = Buffer.alloc(3 + authCode.length);
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
        this.emit('packet', {
          direction: 'OUT',
          msgId: '0x8100',
          simNo,
          seqNo: this.serverSeq,
          desc: `Registration Success (Auth Code: ${authCode})`
        });
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
        this.emit('packet', {
          direction: 'OUT',
          msgId: '0x8001',
          simNo,
          seqNo: this.serverSeq,
          desc: 'Authentication ACK'
        });
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

      case 0x0001: {
        const replySeq = body.readUInt16BE(0);
        const replyMsgId = body.readUInt16BE(2);
        const result = body.readUInt8(4);
        this.emit('device_ack', {
          simNo,
          replySeq,
          replyMsgId: `0x${replyMsgId.toString(16).toUpperCase()}`,
          result: result === 0 ? 'Success' : 'Failed'
        });
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

  // Disable sleep & wake up video sensor (0x8103)
  disableSleepMode(simNo) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      throw new Error(`Device ${simNo} is not online`);
    }

    // 0x8103: Param count = 1, Param 0x0075 (Sleep param) = 0x00 (No sleep)
    const body = Buffer.alloc(1 + 4 + 1 + 4);
    body.writeUInt8(1, 0); // 1 param
    body.writeUInt32BE(0x0075, 1); // 0x0075: Audio/Video sleep mode
    body.writeUInt8(4, 5); // 4 bytes len
    body.writeUInt32BE(0x00000000, 6); // 0 = Disable sleep

    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({
      msgId: 0x8103,
      simNo,
      seqNo,
      body
    });

    device.socket.write(packet);

    this.emit('packet', {
      direction: 'OUT',
      msgId: '0x8103',
      simNo,
      seqNo,
      desc: 'Set Parameters: Disable Audio/Video Sleep Mode (0x0075 = 0)'
    });
  }

  requestLiveVideo(simNo, options = {}) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      throw new Error(`Device ${simNo} is not online`);
    }

    const serverIp = options.serverIp || '127.0.0.1';
    const tcpPort = options.tcpPort || 8081;
    const udpPort = options.udpPort || 0;
    const channel = options.channel || 1;
    const dataType = options.dataType !== undefined ? options.dataType : 0;
    const streamType = options.streamType !== undefined ? options.streamType : 0;

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
    const packet = buildJT808Packet({
      msgId: 0x9101,
      simNo,
      seqNo,
      body
    });

    device.socket.write(packet);

    this.emit('packet', {
      direction: 'OUT',
      msgId: '0x9101',
      simNo,
      seqNo,
      desc: `Request Live Stream (IP: ${serverIp}:${tcpPort}, Ch: ${channel}, Stream: ${streamType === 0 ? 'Main' : 'Sub'})`
    });

    return { seqNo, simNo, channel, serverIp, tcpPort };
  }

  stopLiveVideo(simNo, channel = 1) {
    const device = this.devices.get(simNo);
    if (!device || !device.socket || !device.online) {
      throw new Error(`Device ${simNo} is not online`);
    }

    const body = Buffer.alloc(4);
    body.writeUInt8(channel, 0);
    body.writeUInt8(0, 1);
    body.writeUInt8(0, 2);
    body.writeUInt8(0, 3);

    const seqNo = this.getNextSeq();
    const packet = buildJT808Packet({
      msgId: 0x9102,
      simNo,
      seqNo,
      body
    });

    device.socket.write(packet);

    this.emit('packet', {
      direction: 'OUT',
      msgId: '0x9102',
      simNo,
      seqNo,
      desc: `Stop Live Stream (Ch: ${channel})`
    });

    return { seqNo, simNo, channel };
  }
}

module.exports = JT808Server;
