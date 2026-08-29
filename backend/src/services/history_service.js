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

function encodeCursor(timestamp, id) {
  return Buffer.from(`${timestamp}|${id}`).toString('base64');
}

function decodeCursor(cursorStr) {
  try {
    const raw = Buffer.from(cursorStr, 'base64').toString('utf8');
    const [timestamp, idStr] = raw.split('|');
    const id = parseInt(idStr, 10);
    if (timestamp && !isNaN(id)) {
      return { timestamp, id };
    }
  } catch (e) {}
  return null;
}

class HistoryService {
  isValidCoordinate(lat, lng) {
    if (lat === 0.0 && lng === 0.0) return false;
    if (isNaN(lat) || isNaN(lng)) return false;
    if (lat < -90.0 || lat > 90.0) return false;
    if (lng < -180.0 || lng > 180.0) return false;
    return true;
  }

  recordGpsPoint(data) {
    if (!data.simNo || data.latitude === undefined || data.longitude === undefined) {
      return;
    }

    const lat = parseFloat(data.latitude);
    const lng = parseFloat(data.longitude);

    if (!this.isValidCoordinate(lat, lng)) {
      return;
    }
    if (data.isPositioned === false) {
      return;
    }

    try {
      stmts.insertGpsPoint.run({
        sim_no: data.simNo,
        latitude: lat,
        longitude: lng,
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
      // Vehicle foreign key mismatch ignored
    }
  }

  getHistory(simNo, startTime, endTime, limit = 500, cursor = null) {
    const start = startTime || new Date(Date.now() - 86400000).toISOString();
    const end = endTime || new Date().toISOString();
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);

    let rows = [];
    const parsedCursor = cursor ? decodeCursor(cursor) : null;

    if (parsedCursor) {
      rows = stmts.getGpsHistoryWithCursor.all(simNo, parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.id, end, cleanLimit);
    } else {
      rows = stmts.getGpsHistoryInitial.all(simNo, start, end, cleanLimit);
    }

    const data = rows.map(r => ({
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

    let nextCursor = null;
    if (rows.length === cleanLimit) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor(last.timestamp, last.id);
    }

    return {
      data,
      count: data.length,
      nextCursor
    };
  }

  getTripSummary(simNo, startTime, endTime) {
    const historyResult = this.getHistory(simNo, startTime, endTime, 5000);
    const points = historyResult.data;
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
    let validSpeedCount = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.speed > maxSpeed && p.speed <= 180) {
        maxSpeed = p.speed;
      }
      if (p.speed <= 180) {
        speedSum += p.speed;
        validSpeedCount++;
      }

      if (i > 0) {
        const prev = points[i - 1];
        const distKm = calculateDistanceKm(prev.latitude, prev.longitude, p.latitude, p.longitude);
        const timeDiffSec = (new Date(p.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;

        if (timeDiffSec > 0) {
          const impliedSpeedKmh = (distKm / timeDiffSec) * 3600;
          if (impliedSpeedKmh <= 180) {
            totalDistance += distKm;
          }
        } else if (distKm < 0.5) {
          totalDistance += distKm;
        }
      }
    }

    return {
      totalPoints: points.length,
      totalDistanceKm: parseFloat(totalDistance.toFixed(2)),
      maxSpeedKmh: parseFloat(maxSpeed.toFixed(1)),
      avgSpeedKmh: validSpeedCount > 0 ? parseFloat((speedSum / validSpeedCount).toFixed(1)) : 0,
      startTime: points[0].timestamp,
      endTime: points[points.length - 1].timestamp
    };
  }
}

module.exports = new HistoryService();
