# 🚗 T98 4G Dashcam JT/T 808 & JT/T 1078 Server

A complete, high-performance Node.js server implementation for **BSJ T98 4G Dashcams** supporting:
1. **JT/T 808 Protocol**: Registration, Authentication, Heartbeat, GPS Live Tracking (`0x0200`).
2. **JT/T 1078 Protocol**: Real-time H.264/H.265 video streaming (`0x9101` / `0x9102`), RTP packet parsing & frame reassembly.
3. **Web Live Dashboard**: Real-time Leaflet GPS map, video player (JMuxer), vehicle telemetry, and protocol console.
4. **Built-in Mock Dashcam Simulator**: Test everything locally with 1-click.

---

## 📁 Project Structure

```text
├── src/
│   ├── jt808/
│   │   ├── codec.js          # 0x7E escape/unescape, XOR checksum, BCD codecs
│   │   └── server.js         # JT808 TCP Server (0x0100, 0x0102, 0x0002, 0x0200, 0x9101)
│   ├── jt1078/
│   │   └── server.js         # JT1078 Media TCP Server (RTP parser, H.264 extractor)
│   ├── simulator/
│   │   ├── dashcam_sim.js    # Mock T98 Dashcam with moving GPS & 25fps video
│   │   └── h264_sample.js    # Baseline H.264 NALU generator
│   └── web/
│       └── public/
│           ├── index.html    # Modern Cyber-Tech Glassmorphic UI
│           ├── app.js        # WebSocket, Leaflet map, JMuxer player
│           └── style.css     # Premium dark theme styles
├── server.js                 # Main server entrypoint
├── deploy.sh                 # 1-click VPS deployment script
├── ecosystem.config.js       # PM2 Production configuration
├── Dockerfile                # Docker container build
├── docker-compose.yml        # Docker compose configuration
├── test_system.js            # Automated E2E verification test
└── package.json
```

---

## 🚀 How to Deploy on VPS (Ubuntu / Debian)

### Method 1: Using `deploy.sh` (Easiest & Recommended)

1. Copy this project folder to your VPS (via Git, SCP, or FileZilla):
   ```bash
   scp -r "c:\Users\sathi\Desktop\dashcam v1" root@YOUR_VPS_IP:/root/dashcam-v1
   ```
2. SSH into your VPS:
   ```bash
   ssh root@YOUR_VPS_IP
   cd /root/dashcam-v1
   ```
3. Run the 1-click deployment script:
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

---

### Method 2: Using Docker Compose

```bash
docker-compose up -d --build
```

---

### Method 3: Manual Node.js / PM2 Setup

```bash
# 1. Install dependencies
npm install

# 2. Start in background with PM2
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

---

## 📲 Connecting Your Physical T98 Dashcam

Once deployed on your VPS, send the following SMS commands to your Dashcam SIM card:

### 1. Set Server IP & Port:
```text
<SPBSJ*P:BSJGPS*D:YOUR_VPS_IP,7788>
```

### 2. Set APN (if needed):
- **Airtel**: `<SPBSJ*P:BSJGPS*A:airtelgprs.com>`
- **Jio**: `<SPBSJ*P:BSJGPS*A:jionet>`
- **Vi / Vodafone**: `<SPBSJ*P:BSJGPS*A:www>`

### 3. Check Dashcam Status:
```text
<SPBSJ*P:BSJGPS*Q>
```

---

## 🌐 Opening the Live Web Dashboard

Open your browser and navigate to:
```
http://YOUR_VPS_IP:3000
```

- Watch the **Live GPS location** update on the interactive map.
- Click **"Request Live Stream (0x9101)"** to watch live front / cabin camera feed!
