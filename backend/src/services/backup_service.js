const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const logger = require('../utils/logger');

const BACKUP_DIR = path.join(__dirname, '../../data/backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

class BackupService {
  constructor() {
    // Run initial backup after 1 minute, then every 24 hours
    setTimeout(() => this.createBackup(), 60000);
    this.timer = setInterval(() => this.createBackup(), 24 * 60 * 60 * 1000);
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `dashcam_backup_${timestamp}.db`;
    const backupFilePath = path.join(BACKUP_DIR, backupFileName);

    try {
      // Use SQLite online backup API to create hot non-blocking snapshot
      await db.backup(backupFilePath);
      logger.info('DATABASE_BACKUP_SUCCESS', { file: backupFileName, path: backupFilePath });

      // Clean old backups keeping last 7 days
      this.cleanOldBackups(7);
    } catch (err) {
      logger.error('DATABASE_BACKUP_FAILED', { error: err.message });
    }
  }

  cleanOldBackups(retentionDays = 7) {
    try {
      const files = fs.readdirSync(BACKUP_DIR);
      const now = Date.now();
      const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.endsWith('.db')) {
          const filePath = path.join(BACKUP_DIR, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            logger.info('DATABASE_BACKUP_PURGED', { file });
          }
        }
      }
    } catch (e) {}
  }
}

module.exports = new BackupService();
