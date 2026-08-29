const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'dashcam.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH, { verbose: process.env.DB_VERBOSE === 'true' ? console.log : null });

// Initialize WAL mode and schema
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);
console.log(`🗄️ SQLite WAL Database initialized at: ${DB_PATH}`);

// Auto-migrate legacy vehicles.json if present
const LEGACY_JSON = path.join(DATA_DIR, 'vehicles.json');
function migrateLegacyJson() {
  try {
    if (fs.existsSync(LEGACY_JSON)) {
      const data = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
      const count = db.prepare('SELECT COUNT(*) as count FROM vehicles').get().count;
      if (count === 0 && Object.keys(data).length > 0) {
        console.log(`🔄 Migrating ${Object.keys(data).length} vehicles from legacy vehicles.json to SQLite...`);
        const insertStmt = db.prepare(`
          INSERT INTO vehicles (
            id, number_plate, sim_no, model, driver_name, driver_phone,
            assigned_user_id, assigned_user_name, assigned_user_phone,
            channel_count, channels_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((vehicles) => {
          for (const v of Object.values(vehicles)) {
            if (v && v.simNo) {
              insertStmt.run(
                v.id || `veh_${Date.now()}_${v.simNo.slice(-4)}`,
                v.numberPlate || 'UNKNOWN',
                v.simNo,
                v.model || 'T98 NON-AI 4G Dual-Cam',
                v.driverName || '',
                v.driverPhone || '',
                v.assignedUserId || '',
                v.assignedUserName || '',
                v.assignedUserPhone || '',
                v.channelCount || 2,
                JSON.stringify(v.channels || []),
                v.createdAt || new Date().toISOString(),
                v.updatedAt || new Date().toISOString()
              );
            }
          }
        });

        insertMany(data);
        console.log(`✅ Legacy migration complete!`);
      }
    }
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

migrateLegacyJson();

// Prepared Statements for high-throughput queries
const stmts = {
  // Vehicles
  getAllVehicles: db.prepare('SELECT * FROM vehicles ORDER BY created_at DESC'),
  getVehiclesByUser: db.prepare('SELECT * FROM vehicles WHERE assigned_user_id = ? OR assigned_user_name LIKE ? ORDER BY created_at DESC'),
  getVehiclesByTenant: db.prepare('SELECT * FROM vehicles WHERE tenant_id = ? ORDER BY created_at DESC'),
  getVehicleById: db.prepare('SELECT * FROM vehicles WHERE id = ?'),
  getVehicleBySim: db.prepare('SELECT * FROM vehicles WHERE sim_no = ?'),
  getVehicleByPlate: db.prepare('SELECT * FROM vehicles WHERE number_plate = ?'),
  insertVehicle: db.prepare(`
    INSERT INTO vehicles (
      id, number_plate, sim_no, model, driver_name, driver_phone,
      assigned_user_id, assigned_user_name, assigned_user_phone,
      tenant_id, channel_count, channels_json, created_at, updated_at
    ) VALUES (
      @id, @number_plate, @sim_no, @model, @driver_name, @driver_phone,
      @assigned_user_id, @assigned_user_name, @assigned_user_phone,
      @tenant_id, @channel_count, @channels_json, @created_at, @updated_at
    )
  `),
  updateVehicle: db.prepare(`
    UPDATE vehicles SET
      number_plate = COALESCE(@number_plate, number_plate),
      model = COALESCE(@model, model),
      driver_name = COALESCE(@driver_name, driver_name),
      driver_phone = COALESCE(@driver_phone, driver_phone),
      assigned_user_id = COALESCE(@assigned_user_id, assigned_user_id),
      assigned_user_name = COALESCE(@assigned_user_name, assigned_user_name),
      assigned_user_phone = COALESCE(@assigned_user_phone, assigned_user_phone),
      tenant_id = COALESCE(@tenant_id, tenant_id),
      channel_count = COALESCE(@channel_count, channel_count),
      channels_json = COALESCE(@channels_json, channels_json),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id OR sim_no = @sim_no
  `),
  deleteVehicle: db.prepare('DELETE FROM vehicles WHERE id = ? OR sim_no = ?'),

  // GPS History
  insertGpsPoint: db.prepare(`
    INSERT INTO gps_history (
      sim_no, latitude, longitude, speed_kmh, direction, altitude,
      acc_on, address, satellites, signal_strength, timestamp
    ) VALUES (
      @sim_no, @latitude, @longitude, @speed_kmh, @direction, @altitude,
      @acc_on, @address, @satellites, @signal_strength, @timestamp
    )
  `),
  getGpsHistory: db.prepare(`
    SELECT * FROM gps_history
    WHERE sim_no = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
    LIMIT ?
  `),
  getLatestGpsPoint: db.prepare(`
    SELECT * FROM gps_history
    WHERE sim_no = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `),

  // Alarms
  insertAlarm: db.prepare(`
    INSERT INTO alarms (
      id, sim_no, alarm_type, alarm_name, latitude, longitude,
      speed_kmh, channel, media_url, timestamp
    ) VALUES (
      @id, @sim_no, @alarm_type, @alarm_name, @latitude, @longitude,
      @speed_kmh, @channel, @media_url, @timestamp
    )
  `),
  getAlarmsBySim: db.prepare(`
    SELECT * FROM alarms
    WHERE sim_no = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `),
  getAlarmsByTenant: db.prepare(`
    SELECT a.* FROM alarms a
    JOIN vehicles v ON a.sim_no = v.sim_no
    WHERE v.tenant_id = ?
    ORDER BY a.timestamp DESC
    LIMIT ?
  `),
  acknowledgeAlarm: db.prepare(`
    UPDATE alarms SET
      acknowledged = 1,
      acknowledged_by = @acknowledged_by,
      acknowledged_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `),

  // Video Recordings
  insertRecording: db.prepare(`
    INSERT INTO video_recordings (
      id, sim_no, channel, start_time, end_time, file_path, file_size, stream_type, storage_type
    ) VALUES (
      @id, @sim_no, @channel, @start_time, @end_time, @file_path, @file_size, @stream_type, @storage_type
    )
  `),
  getRecordings: db.prepare(`
    SELECT * FROM video_recordings
    WHERE sim_no = ? AND channel = ? AND start_time >= ? AND end_time <= ?
    ORDER BY start_time ASC
  `)
};

module.exports = {
  db,
  stmts
};
