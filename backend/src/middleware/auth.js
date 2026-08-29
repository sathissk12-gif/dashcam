const { verifyToken, verifyApiKey } = require('../services/auth_service');

const AUTH_REQUIRED = process.env.REQUIRE_AUTH === 'true';

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];
  const tokenQuery = req.query.token;
  const apiKeyQuery = req.query.apiKey;

  // 1. API Key check
  const apiKey = apiKeyHeader || apiKeyQuery;
  if (apiKey && verifyApiKey(apiKey)) {
    req.user = { id: 'system_api', role: 'admin', tenantId: 'default' };
    return next();
  }

  // 2. JWT Bearer token check
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (tokenQuery) {
    token = tokenQuery.trim();
  }

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = {
        id: payload.sub || payload.id || 'user',
        name: payload.name || '',
        role: payload.role || 'customer',
        tenantId: payload.tenantId || 'default'
      };
      return next();
    }
  }

  // 3. Fallback if auth is not strictly enforced in environment
  if (!AUTH_REQUIRED) {
    req.user = { id: 'anonymous', role: 'admin', tenantId: 'default' };
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid Bearer token or API key required'
  });
}

function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ success: false, error: 'Forbidden: Insufficient privileges' });
  };
}

module.exports = {
  authMiddleware,
  requireRole
};
