/**
 * G.711 A-law Audio Codec & JT1078 RTP Audio Frame Packager
 * Converts 16-bit PCM (from browser mic) to G.711A and builds JT1078 audio packets.
 */
const { stringToBcd } = require('../jt808/codec');

// Linear 16-bit PCM to G.711 A-law lookup/conversion
const ALAW_MAX = 0xFFF;

function linearToAlaw(pcmVal) {
  let mask;
  let seg;

  if (pcmVal >= 0) {
    mask = 0xD5;
  } else {
    mask = 0x55;
    pcmVal = -pcmVal - 1;
  }

  if (pcmVal < 0) pcmVal = 0;
  if (pcmVal > 32767) pcmVal = 32767;

  // Convert to 13-bit representation
  pcmVal = pcmVal >> 3;

  if (pcmVal < 32) {
    return (pcmVal >> 1) ^ mask;
  }
  if (pcmVal < 64) {
    return ((pcmVal >> 2) + 16) ^ mask;
  }
  if (pcmVal < 128) {
    return ((pcmVal >> 3) + 32) ^ mask;
  }
  if (pcmVal < 256) {
    return ((pcmVal >> 4) + 48) ^ mask;
  }
  if (pcmVal < 512) {
    return ((pcmVal >> 5) + 64) ^ mask;
  }
  if (pcmVal < 1024) {
    return ((pcmVal >> 6) + 80) ^ mask;
  }
  if (pcmVal < 2048) {
    return ((pcmVal >> 7) + 96) ^ mask;
  }
  return ((pcmVal >> 8) + 112) ^ mask;
}

function encodePcmToAlaw(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const alawBuf = Buffer.alloc(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const pcmSample = pcmBuffer.readInt16LE(i * 2);
    alawBuf[i] = linearToAlaw(pcmSample);
  }

  return alawBuf;
}

/**
 * Builds a JT1078 26-byte Audio RTP Packet
 */
function buildJT1078AudioPacket({ simNo, channel = 1, seqNo, alawData, timestamp = Date.now() }) {
  const headerLen = 26;
  const bodyLen = alawData.length;
  const packet = Buffer.alloc(headerLen + bodyLen);

  // 1. Sync Header (0x30 0x31 0x63 0x64)
  packet.writeUInt8(0x30, 0);
  packet.writeUInt8(0x31, 1);
  packet.writeUInt8(0x63, 2);
  packet.writeUInt8(0x64, 3);

  // 2. V=2, P=0, X=0, CC=0 (0x80), M=0, PT=6 (0x06 for G.711A)
  packet.writeUInt8(0x80, 4);
  packet.writeUInt8(6, 5); // PT 6 = G.711A

  // 3. Sequence Number
  packet.writeUInt16BE(seqNo & 0xffff, 6);

  // 4. SIM Number (6 Bytes BCD)
  stringToBcd(simNo, 6).copy(packet, 8);

  // 5. Logical Channel
  packet.writeUInt8(channel, 14);

  // 6. Data Type (3: Audio) & Subpackage (0: Atomic)
  packet.writeUInt8((3 << 4) | 0, 15);

  // 7. Timestamp (8 Bytes / 64-bit int ms)
  packet.writeBigUInt64BE(BigInt(timestamp), 16);

  // 8. Audio Body Length (2 Bytes)
  packet.writeUInt16BE(bodyLen, 24);

  // 9. Payload Audio Data (G.711A)
  alawData.copy(packet, 26);

  return packet;
}

module.exports = {
  linearToAlaw,
  encodePcmToAlaw,
  buildJT1078AudioPacket
};
