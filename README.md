# 📡 T98 4G Dashcam Command Center — Backend Architecture & Protocol Documentation

A high-performance, production-ready Node.js server implementing **JT/T 808** (GPS Tracking & Telemetry Signaling) and **JT/T 1078** (Real-Time Audio/Video Media Streaming) protocols for 4G vehicle dashcams (such as the T98 NON-AI Cat-1 LTE Dashcam).

---

## 📑 Table of Contents
1. [System Architecture](#-system-architecture)
2. [Supported Protocols](#-supported-protocols)
   - [JT/T 808 GPS & Signaling Messages](#1-jtt-808-gps--signaling-messages)
   - [JT/T 1078 Video & Audio Streaming Messages](#2-jtt-1078-video--audio-streaming-messages)
   - [JT1078 RTP Media Framing Format](#3-jt1078-rtp-media-framing-format)
3. [Unified Port Demuxing Engine](#-unified-port-demuxing-engine)
4. [Backend Codebase Directory Structure](#-backend-codebase-directory-structure)
5. [Hardware SMS Commands (BSJ / T98)](#-hardware-sms-commands-bsj--t98)
6. [Web & WebSocket API Reference](#-web--websocket-api-reference)
7. [Deployment & CI/CD](#-deployment--cicd)

---

## 🏗️ System Architecture

```
+-----------------------------------------------------------------------------------+
|                           PHYSICAL 4G DASHCAM (T98)                               |
|   (GPS Satellites, 4G LTE SIM, Front Camera CH1, Cabin Camera CH2, HC1723C SoC)   |
+-----------------------------------------------------------------------------------+
                                   │
              ┌────────────────────┴────────────────────┐
              │ TCP (Port 5023 / 8081 / 9901)           │
              ▼                                         ▼
   [ JT/T 808 Signaling ]                    [ JT/T 1078 RTP Media ]
   - 0x0100 Terminal Register                - Sync Header: 0x30 0x31 0x63 0x64
   - 0x0102 Authentication                   - Payload Type: PT 98 (H.264)
   - 0x0002 Heartbeat                        - Sub-packet Reassembly
   - 0x0200 Location Telemetry               - Annex-B NAL Units (00 00 00 01)
   - 0x8103 Disable Sleep Mode               - I-Frames & P-Frames (25-30 FPS)
   - 0x9101 Live Video Request                          │
              │                                         │
              └────────────────────┬────────────────────┘
                                   ▼
+-----------------------------------------------------------------------------------+
|                        BACKEND ENGINE (Node.js / PM2)                             |
|  - Unified Port Demuxer (Demuxes 0x7E vs 0x30 0x31 0x63 0x64 on any port)        |
|  - Express Web Server (Port 9090)                                                 |
|  - WebSocket Broadcaster (/ws) — JSON telemetry & Binary H.264 video chunks       |
+-----------------------------------------------------------------------------------+
                                   │ WebSocket / Binary
                                   ▼
+-----------------------------------------------------------------------------------+
|                         WEB DASHBOARD FRONTEND                                    |
|  - Leaflet GPS Real-time Map with Vehicle Heading & Track History                 |
|  - JMuxer H.264 HTML5 Video Player (Zero-Latency Live Camera Feed)                |
|  - Camera Switcher: Front Camera (CH 1) / Cabin Camera (CH 2)                     |
|  - Real-time Protocol Packet Console & Telemetry Cards (Speed, ACC, Satellites)   |
+-----------------------------------------------------------------------------------+
```

---

## 📜 Supported Protocols

### 1. JT/T 808 GPS & Signaling Messages

| Message ID | Direction | Description | Packet Format & Details |
| :--- | :--- | :--- | :--- |
| **`0x0100`** | `Terminal → Server` | **Terminal Registration** | Uploads Province ID, City ID, Manufacturer ID, Device Model, Terminal ID, and Plate Color. |
| **`0x8100`** | `Server → Terminal` | **Registration Response** | Returns Result (0: Success) and Auth Code (e.g. `AUTH_054447`). |
| **`0x0102`** | `Terminal → Server` | **Terminal Authentication** | Terminal sends the Auth Code received during registration. |
| **`0x8001`** | `Server → Terminal` | **Platform General ACK** | Acknowledges terminal packets with Result (0: Success). |
| **`0x0002`** | `Terminal → Server` | **Heartbeat** | Periodic keepalive to maintain active TCP connection. |
| **`0x0200`** | `Terminal → Server` | **Location Telemetry Report** | Contains Latitude, Longitude, Altitude, Speed, Heading, Timestamp, Status bits (ACC ON/OFF, GPS 2D/3D fix), and Extra attributes (Odometer, Signal strength CSQ, Satellites). |
| **`0x8103`** | `Server → Terminal` | **Set Terminal Parameters** | Configures parameters such as `0x0075 = 0x00` (Disable audio/video sleep mode on ACC OFF) and `0x005B` (Wakeup control). |
| **`0x0001`** | `Terminal → Server` | **Terminal General ACK** | Terminal acknowledges server commands like `0x9101` and `0x8103` with Result (0: Success). |

---

### 2. JT/T 1078 Video & Audio Streaming Messages

| Message ID | Direction | Description | Details |
| :--- | :--- | :--- | :--- |
| **`0x1003`** | `Terminal → Server` | **Audio/Video Attributes Upload** | Terminal announces its codecs (H.264 Video, G.711 Audio) and available camera channels (2 channels: Front & Cabin). |
| **`0x9101`** | `Server → Terminal` | **Real-Time Live Video Request** | Tells the dashcam to begin streaming video: Server IP, TCP Port, Channel (1: Front, 2: Cabin), Data Type (0: Audio & Video), Stream Type (0: Main, 1: Sub). |
| **`0x9102`** | `Server → Terminal` | **Live Stream Control (Stop/Switch)** | Controls active stream: Channel (1, 2, or 0 for ALL), Control type (0: Close stream, 1: Switch stream, 2: Pause, 3: Resume). |

---

### 3. JT1078 RTP Media Framing Format

JT1078 video data packets transmitted by the Dashcam have a fixed **30-byte header** followed by the raw H.264 Annex-B NAL units:

```
0                   1                   2                   3
0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 0x30 0x31 0x63 0x64 (Fixed Sync Header)       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V|P|X|  CC     |M|     PT(98)  |        Sequence Number        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   SIM Number (6 Bytes BCD)                    |
|                               +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                               | Logical Ch (1)| Data/Sub Type |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          Timestamp (8 Bytes)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Last I-Frame Interval     |     Last Frame Interval       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       Data Body Length        |   H.264 NAL Payload Data ...  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

#### Sub-packet Assembly Flags:
- `0` (**Atomic**): Packet contains a complete standalone H.264 frame.
- `1` (**First**): First fragment of a large I-Frame / P-Frame.
- `3` (**Intermediate**): Middle fragment of an H.264 frame.
- `2` (**Last**): Final fragment. Once received, the backend concatenates all parts into a complete Annex-B NAL unit and feeds it to the video player.

---

## 🔀 Unified Port Demuxing Engine

Standard GPS servers require separate ports for GPS signaling (e.g. 5023) and video streaming (e.g. 1078/9902). However, in restricted cloud hosting or NAT firewall environments, opening multiple arbitrary ports can cause connectivity issues.

Our backend implements an **Intelligent Unified Protocol Demuxer**:
```javascript
// Check first 4 bytes of incoming TCP stream:
if (buf[0] === 0x30 && buf[1] === 0x31 && buf[2] === 0x63 && buf[3] === 0x64) {
  // Dispatched directly to JT1078 Media Decoder
  handleJt1078Packet(buf);
} else if (buf[0] === 0x7E) {
  // Dispatched directly to JT808 Signaling Decoder
  handleJt808Frame(buf);
}
```
**Benefits**:
- Port `5023` handles **both GPS location telemetry AND Real-time Video streaming simultaneously**.
- Zero firewall blocking / port conflict issues.
- Seamless compatibility with both legacy and modern BSJ dashcams.

---

## 📁 Backend Codebase Directory Structure

```
backend/
├── src/
│   ├── jt808/
│   │   ├── codec.js           # JT808 parser: 0x7E unescaping, XOR checksum, BCD converter, 0x0200 location parser
│   │   └── server.js          # TCP Signaling Server, device registry, 0x8103 wakeup & 0x9101/0x9102 stream dispatcher
│   ├── jt1078/
│   │   └── server.js          # Standalone JT1078 media server, RTP header parser & NAL assembler
│   └── simulator/
│       └── dashcam_sim.js     # Mock Dashcam simulator for automated testing & E2E verification
├── ecosystem.config.js        # PM2 process configuration for production (dashcam-backend)
├── package.json               # Backend dependencies (express, ws)
├── server.js                  # Master application entrypoint: Express + WebSocket Server + Multi-port listeners
└── test_system.js             # Automated E2E test suite (100% pass)
```

---

## 📲 Hardware SMS Commands (BSJ / T98)

Send these SMS commands from any phone to the SIM card installed inside the Dashcam:

| Purpose | SMS Command | Expected Dashcam Reply |
| :--- | :--- | :--- |
| **Set Primary GPS Server** | `<SPBSJ*P:BSJGPS*D:163.128.112.26,5023>` | `<BSJ*...*T:163.128.112.26,5023*...>` |
| **Set Video Media Gateway** | `<SPBSJ*P:BSJGPS*G:163.128.112.26:5023>` | `<BSJ*...*G:163.128.112.26:5023*...>` |
| **Virtual ACC (Always ON)** | `<SPBSJ*P:BSJGPS*ACC:1>` | `<BSJ*...*ACCALM:ON*...>` |
| **Disable Sleep Mode** | `<SPBSJ*P:BSJGPS*SLEEP:0>` | `OK` |
| **Query Status** | `<SPBSJ*P:BSJGPS*Q>` | Full telemetry status (Signal, GPS, Server IP, IMEI, Firmware) |

---

## 🌐 Web & WebSocket API Reference

### 1. REST Status Endpoint
`GET /api/status`

**Response:**
```json
{
  "status": "online",
  "serverIp": "163.128.112.26",
  "localIp": "127.0.0.1",
  "jt808Ports": [5023, 8081, 9901, 7788, 9092],
  "devicesCount": 1
}
```

---

### 2. WebSocket Protocol (`ws://<SERVER_IP>:9090/ws`)

#### Downlink JSON Messages (Server → Client):
- `device_list`: Active connected dashcam devices list with online status & location.
- `device_connected`: Fired when a new dashcam authenticates.
- `device_location`: Real-time location packet (`0x0200`) containing Lat/Lng, speed, heading, ACC status, satellites, signal, and odometer.
- `packet_log`: Real-time protocol debug trace for the UI Terminal Console.
- `stream_started` / `stream_stopped`: Confirmation of video streaming state.

#### Binary Stream (Server → Client):
- **Raw H.264 Annex-B Video Frames**: Sent as binary ArrayBuffers directly to the client and fed into `JMuxer` for 25–30 FPS live playback.

#### Uplink JSON Commands (Client → Server):
```json
// Request Live Video Stream (Channel 1: Front, Channel 2: Cabin)
{
  "action": "start_stream",
  "simNo": "015770054447",
  "channel": 1,
  "streamType": 1,
  "mediaPort": 5023
}

// Stop Live Video Stream
{
  "action": "stop_stream",
  "simNo": "015770054447",
  "channel": 1
}
```

---

## 🚀 Deployment & CI/CD

### 🔄 GitHub Actions Automatic Deployment
Every `git push` to `main` triggers `.github/workflows/deploy.yml`:
1. Connects to VPS via SSH.
2. Pulls latest code from `main`.
3. Runs `npm install --production`.
4. Executes zero-downtime restart:
   ```bash
   pm2 restart dashcam-backend --update-env || pm2 start backend/ecosystem.config.js
   pm2 save
   ```

### 🖥️ Manual Production Start with PM2
```bash
# Start server
pm2 start ecosystem.config.js

# View live logs
pm2 logs dashcam-backend

# Restart
pm2 restart dashcam-backend --update-env
```
