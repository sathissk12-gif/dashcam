/**
 * JT/T 808 Protocol Codec
 * Handles escaping, unescaping, XOR checksums, header parsing and building.
 */

function escapeBuffer(buf) {
  const result = [];
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0x7e) {
      result.push(0x7d, 0x02);
    } else if (byte === 0x7d) {
      result.push(0x7d, 0x01);
    } else {
      result.push(byte);
    }
  }
  return Buffer.from(result);
}

function unescapeBuffer(buf) {
  const result = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) {
        result.push(0x7e);
        i++;
      } else if (buf[i + 1] === 0x01) {
        result.push(0x7d);
        i++;
      } else {
        result.push(buf[i]);
      }
    } else {
      result.push(buf[i]);
    }
  }
  return Buffer.from(result);
}

function calculateChecksum(buf) {
  let checksum = 0;
  for (let i = 0; i < buf.length; i++) {
    checksum ^= buf[i];
  }
  return checksum;
}

function bcdToString(buf) {
  let str = '';
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    str += high.toString(16) + low.toString(16);
  }
  return str;
}

function stringToBcd(str, byteLen = 6) {
  const padded = str.padStart(byteLen * 2, '0');
  const buf = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen; i++) {
    const high = parseInt(padded[i * 2], 16) || 0;
    const low = parseInt(padded[i * 2 + 1], 16) || 0;
    buf[i] = (high << 4) | low;
  }
  return buf;
}

function parseJT808Frame(rawBuf) {
  let start = 0;
  let end = rawBuf.length;
  if (rawBuf[0] === 0x7e) start = 1;
  if (rawBuf[rawBuf.length - 1] === 0x7e) end = rawBuf.length - 1;

  const contentWithCheck = unescapeBuffer(rawBuf.subarray(start, end));
  if (contentWithCheck.length < 13) {
    throw new Error('Frame too short');
  }

  const payload = contentWithCheck.subarray(0, contentWithCheck.length - 1);
  const expectedCheck = contentWithCheck[contentWithCheck.length - 1];
  const actualCheck = calculateChecksum(payload);

  if (expectedCheck !== actualCheck) {
    throw new Error(`Checksum mismatch: expected 0x${expectedCheck.toString(16)}, got 0x${actualCheck.toString(16)}`);
  }

  const msgId = payload.readUInt16BE(0);
  const bodyProps = payload.readUInt16BE(2);
  const isSubpackage = (bodyProps & 0x2000) !== 0;
  const encryptionType = (bodyProps >> 10) & 0x07;
  const bodyLen = bodyProps & 0x03ff;

  const simNo = bcdToString(payload.subarray(4, 10));
  const seqNo = payload.readUInt16BE(10);

  let headerLen = 12;
  let subpackage = null;
  if (isSubpackage) {
    subpackage = {
      total: payload.readUInt16BE(12),
      index: payload.readUInt16BE(14)
    };
    headerLen = 16;
  }

  const body = payload.subarray(headerLen, headerLen + bodyLen);

  return {
    msgId,
    bodyProps,
    isSubpackage,
    encryptionType,
    bodyLen,
    simNo,
    seqNo,
    subpackage,
    body
  };
}

function buildJT808Packet({ msgId, simNo, seqNo, body = Buffer.alloc(0), isSubpackage = false, subpackage = null }) {
  let headerLen = 12;
  if (isSubpackage) headerLen = 16;

  let bodyProps = body.length & 0x03ff;
  if (isSubpackage) bodyProps |= 0x2000;

  const header = Buffer.alloc(headerLen);
  header.writeUInt16BE(msgId, 0);
  header.writeUInt16BE(bodyProps, 2);
  stringToBcd(simNo, 6).copy(header, 4);
  header.writeUInt16BE(seqNo, 10);

  if (isSubpackage && subpackage) {
    header.writeUInt16BE(subpackage.total, 12);
    header.writeUInt16BE(subpackage.index, 14);
  }

  const unescapedPayload = Buffer.concat([header, body]);
  const checksum = calculateChecksum(unescapedPayload);
  const unescapedFull = Buffer.concat([unescapedPayload, Buffer.from([checksum])]);

  const escaped = escapeBuffer(unescapedFull);
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

function parseLocationReport(body) {
  if (body.length < 28) return null;

  const alarmSign = body.readUInt32BE(0);
  const status = body.readUInt32BE(4);
  const latRaw = body.readUInt32BE(8);
  const lngRaw = body.readUInt32BE(12);
  const altitude = body.readUInt16BE(16);
  const speedRaw = body.readUInt16BE(18);
  const direction = body.readUInt16BE(20);

  const accOn = (status & 0x01) === 1;
  const isPositioned = ((status >> 1) & 0x01) === 1;
  const isSouthLat = ((status >> 2) & 0x01) === 1;
  const isWestLng = ((status >> 3) & 0x01) === 1;

  let latitude = latRaw / 1000000.0;
  if (isSouthLat) latitude = -latitude;

  let longitude = lngRaw / 1000000.0;
  if (isWestLng) longitude = -longitude;

  const speedKmh = (speedRaw / 10.0);

  const timeStr = bcdToString(body.subarray(22, 28));
  const timeFormatted = `20${timeStr.substring(0, 2)}-${timeStr.substring(2, 4)}-${timeStr.substring(4, 6)} ${timeStr.substring(6, 8)}:${timeStr.substring(8, 10)}:${timeStr.substring(10, 12)}`;

  const extras = {};
  let offset = 28;
  while (offset + 2 <= body.length) {
    const extraId = body[offset];
    const extraLen = body[offset + 1];
    offset += 2;
    if (offset + extraLen <= body.length) {
      const extraVal = body.subarray(offset, offset + extraLen);
      if (extraId === 0x01 && extraLen === 4) {
        extras.mileageKm = extraVal.readUInt32BE(0) / 10.0;
      } else if (extraId === 0x02 && extraLen === 2) {
        extras.fuelLiters = extraVal.readUInt16BE(0) / 10.0;
      } else if (extraId === 0x30 && extraLen === 1) {
        extras.signalStrength = extraVal[0];
      } else if (extraId === 0x31 && extraLen === 1) {
        extras.satellites = extraVal[0];
      }
      offset += extraLen;
    } else {
      break;
    }
  }

  return {
    alarmSign,
    status,
    accOn,
    isPositioned,
    latitude,
    longitude,
    altitude,
    speedKmh,
    direction,
    time: timeFormatted,
    extras
  };
}

module.exports = {
  escapeBuffer,
  unescapeBuffer,
  calculateChecksum,
  bcdToString,
  stringToBcd,
  parseJT808Frame,
  buildJT808Packet,
  parseLocationReport
};
