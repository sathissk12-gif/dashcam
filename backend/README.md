# 🛠️ Dashcam Backend Core Engine (JT808 & JT1078)

This directory contains the core TCP signaling server, media decoding engine, and real-time streaming pipelines.

---

## 📦 Components Overview

### 1. `src/jt808/codec.js`
- **Frame Delimiting**: Handles `0x7E` framing, `0x7D 0x02` <-> `0x7E` and `0x7D 0x01` <-> `0x7D` unescaping.
- **XOR Checksum**: Calculates standard 1-byte XOR checksum on unescaped payload.
- **BCD Converter**: Converts 12-digit hex-packed BCD strings to human-readable SIM/IMEI numbers.
- **Location Parser (`0x0200`)**: Extracts 28-byte mandatory fields (Alarm, Status, Latitude, Longitude, Altitude, Speed, Heading, BCD Timestamp) and optional TLV extension attributes (Mileage `0x01`, Signal Strength `0x30`, Satellites `0x31`).

### 2. `src/jt808/server.js`
- **TCP Connection Pool**: Maintains active persistent TCP connections for all registered dashcams.
- **Protocol Handlers**:
  - `0x0100`: Auto-generates authentication code (`AUTH_xxxxxx`) and sends `0x8100` Registration Success.
  - `0x0102`: Validates device authentication and returns `0x8001` ACK.
  - `0x0002`: Handles device heartbeat keepalive.
  - `0x0200`: Processes GPS telemetry and emits `device_location` events.
  - `0x8103`: Sends parameter update to disable video sleep mode (`0x0075 = 0x00`).
  - `0x9101`: Dispatches live video streaming instruction with target IP & port.
  - `0x9102`: Dispatches live video stop and channel switch instructions.
- **Integrated JT1078 Demuxer**: Detects `0x30 0x31 0x63 0x64` RTP packets arriving on the same port and decodes video frames.

### 3. `src/jt1078/server.js`
- **RTP Parser**: Parses 30-byte fixed media header (PT=98 H.264, Sequence Number, Timestamp, Body Length).
- **Sub-packet Reassembler**: Assembles fragmented I-Frames and P-Frames across multi-packet payloads into complete H.264 Annex-B NAL units (`0x00 0x00 0x00 0x01`).

### 4. `server.js` (Master Application)
- **Express Static Server**: Serves frontend UI.
- **WebSocket Gateway (`/ws`)**: Broadcasts JSON telemetry updates and streams binary H.264 video chunks to web browsers.
- **Multi-Port Listeners**: Automatically binds `5023` (Default), `8081`, `9901`, `7788`, and `9092`.

---

## 🧪 Running Automated Tests
```bash
node test_system.js
```
Runs an end-to-end simulation verifying JT808 registration, authentication, GPS telemetry, live video request (`0x9101`), and H.264 frame delivery.
