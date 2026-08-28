#!/usr/bin/env bash
set -e

echo "========================================================="
echo "   🚀 Dashcam JT808 & JT1078 VPS Setup & Deploy Script   "
echo "========================================================="

# 1. Update system packages
echo "📦 Updating apt packages..."
sudo apt update -y

# 2. Install Node.js 20 LTS if not installed
if ! command -v node &> /dev/null; then
    echo "📥 Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "✔ Node.js version: $(node -v)"
echo "✔ npm version: $(npm -v)"

# 3. Install PM2 globally
if ! command -v pm2 &> /dev/null; then
    echo "📥 Installing PM2 process manager..."
    sudo npm install -g pm2
fi

# 4. Install project dependencies
echo "📦 Installing project dependencies..."
npm install --production

# 5. Open Firewall ports (UFW)
if command -v ufw &> /dev/null; then
    echo "🛡️ Configuring firewall ports..."
    sudo ufw allow 3000/tcp || true
    sudo ufw allow 7788/tcp || true
    sudo ufw allow 8088/tcp || true
    sudo ufw allow 1078/tcp || true
fi

# 6. Start / Restart with PM2
echo "🚀 Starting server with PM2..."
pm2 delete dashcam-server 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

PUBLIC_IP=$(curl -s https://api.ipify.org || hostname -I | awk '{print $1}')

echo ""
echo "========================================================="
echo "   🎉 DEPLOYMENT COMPLETE & SERVER IS RUNNING 24/7!      "
echo "========================================================="
echo "🌐 Web Dashboard: http://${PUBLIC_IP}:3000"
echo "📡 JT808 Port:    7788 (or 8088)"
echo "🎥 JT1078 Port:   1078"
echo ""
echo "📲 Dashcam SMS Command to connect:"
echo "   <SPBSJ*P:BSJGPS*D:${PUBLIC_IP},7788>"
echo "========================================================="
