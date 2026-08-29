const { stmts } = require('../db/database');

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

class HistoryService {
  recordGpsPoint(data) {
    if (!data.simNo || data.latitude === undefined || data.longitude === undefined) {
      return;
    }

    try {
      stmts.insertGpsPoint.run({
        sim_no: data.simNo,
        latitude: parseFloat(data.latitude) || 0.0,
        longitude: parseFloat(data.longitude) || 0.0,
        speed_kmh: parseFloat(data.speedKmh || data.speed) || 0.0,
        direction: parseFloat(data.direction || data.course) || 0.0,
        altitude: parseFloat(data.altitude) || 0.0,
        acc_on: data.accOn ? 1 : 0,
        address: data.address || '',
        satellites: parseInt(data.extras?.satellites || data.satellites || 0, 10),
        signal_strength: parseInt(data.extras?.signalStrength || data.signalStrength || 0, 10),
        timestamp: data.time || new Date().toISOString()
      });
    } catch (err) {
      console.warn(`[History] Failed to record GPS point: ${err.message}`);
    }
  }

  getHistory(simNo, startTime, endTime, limit = 5000) {
    const start = startTime || new Date(Date.now() - 86400000).toISOString();
    const end = endTime || new Date().toISOString();
    const rows = stmts.getGpsHistory.all(simNo, start, end, limit);

    return rows.map(r => ({
      id: r.id,
      simNo: r.sim_no,
      latitude: r.latitude,
      longitude: r.longitude,
      speed: r.speed_kmh,
      course: r.direction,
      altitude: r.altitude,
      acc: r.acc_on === 1,
      address: r.address,
      satellites: r.satellites,
      signal: r.signal_strength,
      timestamp: r.timestamp
    }));
  }

  getTripSummary(simNo, startTime, endTime) {
    const points = this.getHistory(simNo, startTime, endTime, 10000);
    if (points.length === 0) {
      return {
        totalPoints: 0,
        totalDistanceKm: 0,
        maxSpeedKmh: 0,
        avgSpeedKmh: 0,
        startTime: null,
        endTime: null
      };
    }

    let totalDistance = 0;
    let maxSpeed = 0;
    let speedSum = 0;

    for (let i = 0; i < points.length; i++) {
      if (points[i].speed > maxSpeed) maxSpeed = points[i].speed;
      speedSum += points[i].speed;

      if (i > 0) {
        totalDistance += calculateDistanceKm(
          points[i - 1].latitude,
          points[i - 1].longitude,
          points[i].latitude,
          points[i].longitude
        );
      }
    }

    return {
      totalPoints: points.length,
      totalDistanceKm: parseFloat(totalDistance.toFixed(2)),
      maxSpeedKmh: parseFloat(maxSpeed.toFixed(1)),
      avgSpeedKmh: parseFloat((speedSum / points.length).toFixed(1)),
      startTime: points[0].timestamp,
      endTime: points[points.length - 1].timestamp
    };
  }
}

module.exports = new HistoryService();
