const { verifyToken, verifyApiKey } = require('../services/auth_service');

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];
  const tokenQuery = req.query.token;

  // 1. Check API Key (Header only - preventing URL log leaks)
  if (apiKeyHeader && verifyApiKey(apiKeyHeader)) {
    req.user = { id: 'system_api', name: 'API Master', role: 'admin', tenantId: 'default' };
    return next();
  }

  // 2. Check JWT Bearer token
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

  // Strict: Unauthenticated requests are rejected
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
    return res.status(403).json({ success: false, error: 'Forbidden: Insufficient role privileges' });
  };
}

module.exports = {
  authMiddleware,
  requireRole
};
