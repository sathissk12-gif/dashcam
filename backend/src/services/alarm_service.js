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

      console.log(`🚨 [Alarm Stored] ${data.simNo} -> ${alarmName}`);
      return { id, simNo: data.simNo, alarmType, alarmName, timestamp: new Date().toISOString() };
    } catch (err) {
      console.warn(`[Alarm] Failed to record alarm: ${err.message}`);
      return null;
    }
  }

  getAlarmsBySim(simNo, limit = 100) {
    return stmts.getAlarmsBySim.all(simNo, limit);
  }

  getAlarmsByTenant(tenantId = 'default', limit = 100) {
    return stmts.getAlarmsByTenant.all(tenantId, limit);
  }

  acknowledge(alarmId, acknowledgedBy = 'user') {
    try {
      stmts.acknowledgeAlarm.run({ id: alarmId, acknowledged_by: acknowledgedBy });
      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = new AlarmService();
