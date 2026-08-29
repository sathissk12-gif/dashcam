const { stmts } = require('../db/database');

function verifyVehicleAccess(paramName = 'simNo', isBody = false) {
  return (req, res, next) => {
    const caller = req.user;
    if (!caller) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Admins bypass resource ownership
    if (caller.role === 'admin') {
      return next();
    }

    const targetVal = isBody ? req.body[paramName] : req.params[paramName];
    if (!targetVal) {
      return res.status(400).json({ success: false, error: `Missing ${paramName} parameter for authorization check` });
    }

    const vehicle = stmts.getVehicleBySim.get(targetVal) || stmts.getVehicleById.get(targetVal) || stmts.getVehicleByPlate.get(targetVal);
    if (!vehicle) {
      return res.status(404).json({ success: false, error: 'Vehicle not found' });
    }

    // Dealers must match tenant_id
    if (caller.role === 'dealer') {
      if (vehicle.tenant_id === caller.tenantId) {
        req.vehicle = vehicle;
        return next();
      }
      return res.status(403).json({ success: false, error: 'Forbidden: Vehicle belongs to another tenant' });
    }

    // Customers must match assigned_user_id
    if (vehicle.assigned_user_id === caller.id || vehicle.assigned_user_name === caller.name) {
      req.vehicle = vehicle;
      return next();
    }

    return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to access this vehicle' });
  };
}

function checkWsSubscriptionPermission(user, simNo) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  const vehicle = stmts.getVehicleBySim.get(simNo);
  if (!vehicle) return false;

  if (user.role === 'dealer') {
    return vehicle.tenant_id === user.tenantId;
  }

  return vehicle.assigned_user_id === user.id || vehicle.assigned_user_name === user.name;
}

module.exports = {
  verifyVehicleAccess,
  checkWsSubscriptionPermission
};
