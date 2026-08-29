const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';

const clients = new Map();

function rateLimiter({ windowMs = 60000, max = 60, message = 'Too many requests, please try again later.' } = {}) {
  if (!RATE_LIMIT_ENABLED) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let record = clients.get(key);
    if (!record || now - record.startTime > windowMs) {
      record = { startTime: now, count: 1 };
      clients.set(key, record);
    } else {
      record.count++;
    }

    if (record.count > max) {
      res.setHeader('Retry-After', Math.ceil((record.startTime + windowMs - now) / 1000));
      return res.status(429).json({
        success: false,
        error: message,
        retryAfterSec: Math.ceil((record.startTime + windowMs - now) / 1000)
      });
    }

    next();
  };
}

// Cleanup stale rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of clients.entries()) {
    if (now - record.startTime > 300000) {
      clients.delete(key);
    }
  }
}, 300000);

module.exports = {
  rateLimiter
};
