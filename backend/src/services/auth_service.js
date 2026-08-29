const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Ensure .env is loaded if running in standalone script or worker
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath) && (!process.env.DASHCAM_SECRET_KEY || !process.env.DASHCAM_API_KEY)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.trim().split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const SECRET_KEY = process.env.DASHCAM_SECRET_KEY;
const API_KEY = process.env.DASHCAM_API_KEY;

if (!SECRET_KEY || !API_KEY) {
  console.error('❌ FATAL: DASHCAM_SECRET_KEY and DASHCAM_API_KEY must be defined in .env.');
  console.error('❌ Server startup aborted to prevent unauthenticated/insecure operation.');
  process.exit(1);
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function generateToken(payload, expiresInSeconds = 86400 * 30) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function verifyApiKey(key) {
  if (!key || !API_KEY) return false;
  return key === API_KEY;
}

module.exports = {
  SECRET_KEY,
  API_KEY,
  generateToken,
  verifyToken,
  verifyApiKey
};
