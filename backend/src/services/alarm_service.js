const { stmts } = require('../db/database');

const ALARM_NAMES = {
  0: 'SOS Emergency Button',
  1: 'Overspeeding Alert',
  2: 'Fatigue Driving (DMS)',
  3: 'Dangerous Driving Warning',
  4: 'GNSS Antenna Disconnected',
  5: 'GNSS Antenna Short Circuit',
  6: 'Terminal Main Power Low',
  7: 'Terminal Main Power Cut',
  8: 'TTS Module Fault',
  9: 'Camera Fault',
  10: 'Driver Facial Recognition Failed',
  11: 'Distracted Driving (DMS)',
  12: 'Driver Smoking Alert (DMS)',
  13: 'Driver Phone Call Alert (DMS)',
  14: 'Lane Departure Warning (ADAS)',
  15: 'Forward Collision Warning (ADAS)',
  16: 'Headway Monitoring Warning (ADAS)',
  17: 'Pedestrian Collision Warning (ADAS)'
};

class AlarmService {
  recordAlarm(data) {
    if (!data.simNo) return null;

    const id = `alm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const alarmType = parseInt(data.alarmType || data.type || 0, 10);
    const alarmName = data.alarmName || ALARM_NAMES[alarmType] || `Alarm Code 0x${alarmType.toString(16)}`;

    try {
      stmts.insertAlarm.run({
        id,
        sim_no: data.simNo,
        alarm_type: alarmType,
        alarm_name: alarmName,
        latitude: parseFloat(data.latitude) || null,
        longitude: parseFloat(data.longitude) || null,
        speed_kmh: parseFloat(data.speedKmh || data.speed) || 0.0,
        channel: parseInt(data.channel || 1, 10),
        media_url: data.mediaUrl || '',
        timestamp: data.timestamp || data.time || new Date().toISOString()
      });

      return { id, simNo: data.simNo, alarmType, alarmName, timestamp: new Date().toISOString() };
    } catch (err) {
      return null;
    }
  }

  getAllAlarms(limit = 100) {
    return stmts.getAllAlarms.all(limit);
  }

  getAlarmsBySim(simNo, limit = 100) {
    return stmts.getAlarmsBySim.all(simNo, limit);
  }

  getAlarmsByTenant(tenantId = 'default', limit = 100) {
    return stmts.getAlarmsByTenant.all(tenantId, limit);
  }

  getAlarmsByUser(userId, userName, limit = 100) {
    return stmts.getAlarmsByAssignedUser.all(userId, `%${userName || userId}%`, limit);
  }

  acknowledge(alarmId, user) {
    if (!user) {
      return { success: false, error: 'Unauthorized' };
    }

    const alarmRecord = stmts.getAlarmWithVehicle.get(alarmId);
    if (!alarmRecord) {
      return { success: false, error: 'Alarm not found' };
    }

    // Role-based ownership check
    if (user.role !== 'admin') {
      if (user.role === 'dealer' && alarmRecord.tenant_id !== user.tenantId) {
        return { success: false, error: 'Forbidden: Alarm belongs to a vehicle in another tenant' };
      }
      if (user.role === 'customer' && alarmRecord.assigned_user_id !== user.id && alarmRecord.assigned_user_name !== user.name) {
        return { success: false, error: 'Forbidden: You do not own the vehicle associated with this alarm' };
      }
    }

    try {
      stmts.acknowledgeAlarm.run({ id: alarmId, acknowledged_by: user.name || user.id });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new AlarmService();
