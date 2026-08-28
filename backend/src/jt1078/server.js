const net = require('net');
const EventEmitter = require('events');
const { bcdToString } = require('../jt808/codec');

class JT1078Server extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 1078;
    this.frameAssemblers = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const clientKey = `${socket.remoteAddress}:${socket.remotePort}`;
        let rxBuffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
          rxBuffer = Buffer.concat([rxBuffer, chunk]);

          while (rxBuffer.length >= 4) {
            const syncIdx = this.findSyncHeader(rxBuffer);
            if (syncIdx === -1) {
              rxBuffer = rxBuffer.subarray(Math.max(0, rxBuffer.length - 3));
              break;
            }

            if (syncIdx > 0) {
              rxBuffer = rxBuffer.subarray(syncIdx);
            }

            if (rxBuffer.length < 30) {
              break;
            }

            try {
              const dataTypeSub = rxBuffer[15];
              const dataType = (dataTypeSub >> 4) & 0x0f;
              const subpackage = dataTypeSub & 0x0f;

              const isVideo = dataType <= 2;
              const isAudio = dataType === 3;
              const headerLen = isVideo ? 30 : (isAudio ? 26 : 16);

              if (rxBuffer.length < headerLen) break;

              let bodyLen = 0;
              if (isVideo) {
                bodyLen = rxBuffer.readUInt16BE(28);
              } else if (isAudio) {
                bodyLen = rxBuffer.readUInt16BE(24);
              }

              const totalPacketLen = headerLen + bodyLen;
              if (rxBuffer.length < totalPacketLen) {
                break;
              }

              const packet = rxBuffer.subarray(0, totalPacketLen);
              rxBuffer = rxBuffer.subarray(totalPacketLen);

              this.parseAndDispatchPacket(packet, { headerLen, bodyLen, dataType, subpackage, isVideo, isAudio });
            } catch (err) {
              this.emit('error', { error: err.message, clientKey });
              rxBuffer = rxBuffer.subarray(4);
            }
          }
        });

        socket.on('close', () => {
          this.emit('client_disconnected', { clientKey });
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

  findSyncHeader(buf) {
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x30 && buf[i + 1] === 0x31 && buf[i + 2] === 0x63 && buf[i + 3] === 0x64) {
        return i;
      }
    }
    return -1;
  }

  parseAndDispatchPacket(packet, meta) {
    const pt = packet[5] & 0x7f;
    const seqNo = packet.readUInt16BE(6);
    const simNo = bcdToString(packet.subarray(8, 14));
    const channel = packet[14];
    const { headerLen, bodyLen, dataType, subpackage, isVideo } = meta;

    const payload = packet.subarray(headerLen, headerLen + bodyLen);
    const streamKey = `${simNo}_${channel}`;

    const dataTypeName = ['I-Frame', 'P-Frame', 'B-Frame', 'Audio', 'Transparent'][dataType] || `Type-${dataType}`;
    const subpackageNames = ['Atomic', 'First', 'Last', 'Intermediate'];

    this.emit('packet', {
      simNo,
      channel,
      seqNo,
      pt,
      dataType: dataTypeName,
      subpackage: subpackageNames[subpackage] || subpackage,
      bodyLen,
      timestamp: Date.now()
    });

    if (isVideo) {
      if (subpackage === 0) {
        this.emit('video_frame', {
          simNo,
          channel,
          pt,
          isKeyframe: dataType === 0,
          data: payload
        });
      } else if (subpackage === 1) {
        this.frameAssemblers.set(streamKey, [payload]);
      } else if (subpackage === 3) {
        if (this.frameAssemblers.has(streamKey)) {
          this.frameAssemblers.get(streamKey).push(payload);
        }
      } else if (subpackage === 2) {
        if (this.frameAssemblers.has(streamKey)) {
          const parts = this.frameAssemblers.get(streamKey);
          parts.push(payload);
          const fullFrame = Buffer.concat(parts);
          this.frameAssemblers.delete(streamKey);

          this.emit('video_frame', {
            simNo,
            channel,
            pt,
            isKeyframe: dataType === 0,
            data: fullFrame
          });
        }
      }
    } else if (meta.isAudio) {
      this.emit('audio_frame', {
        simNo,
        channel,
        pt,
        data: payload
      });
    }
  }
}

module.exports = JT1078Server;
