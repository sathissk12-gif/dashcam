const { db } = require('../db/database');
const logger = require('../utils/logger');

const RETENTION_DAYS = parseInt(process.env.GPS_RETENTION_DAYS || '60', 10);

class RetentionService {
  constructor() {
    this.cleanupStmt = db.prepare(`
      DELETE FROM gps_history
      WHERE timestamp < datetime('now', ? || ' days')
    `);

    this.alarmsCleanupStmt = db.prepare(`
      DELETE FROM alarms
      WHERE timestamp < datetime('now', ? || ' days')
    `);

    // Run on startup, then every 24 hours
    this.runCleanup();
    this.timer = setInterval(() => this.runCleanup(), 24 * 60 * 60 * 1000);
  }

  runCleanup() {
    try {
      const daysArg = `-${RETENTION_DAYS}`;
      const gpsResult = this.cleanupStmt.run(daysArg);
      const alarmResult = this.alarmsCleanupStmt.run(daysArg);

      if (gpsResult.changes > 0 || alarmResult.changes > 0) {
        logger.info('DATABASE_RETENTION_CLEANUP', {
          purgedGpsRecords: gpsResult.changes,
          purgedAlarms: alarmResult.changes,
          retentionDays: RETENTION_DAYS
        });
        db.exec('PRAGMA incremental_vacuum;');
      }
    } catch (err) {
      logger.error('DATABASE_RETENTION_ERROR', { error: err.message });
    }
  }
}

module.exports = new RetentionService();
