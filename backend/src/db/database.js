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

  // GPS History (Composite timestamp + id cursor support)
  insertGpsPoint: db.prepare(`
    INSERT INTO gps_history (
      sim_no, latitude, longitude, speed_kmh, direction, altitude,
      acc_on, address, satellites, signal_strength, timestamp
    ) VALUES (
      @sim_no, @latitude, @longitude, @speed_kmh, @direction, @altitude,
      @acc_on, @address, @satellites, @signal_strength, @timestamp
    )
  `),
  getGpsHistoryInitial: db.prepare(`
    SELECT * FROM gps_history
    WHERE sim_no = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC, id ASC
    LIMIT ?
  `),
  getGpsHistoryWithCursor: db.prepare(`
    SELECT * FROM gps_history
    WHERE sim_no = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND timestamp <= ?
    ORDER BY timestamp ASC, id ASC
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
  getAllAlarms: db.prepare(`
    SELECT * FROM alarms
    ORDER BY timestamp DESC
    LIMIT ?
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
  getAlarmsByAssignedUser: db.prepare(`
    SELECT a.* FROM alarms a
    JOIN vehicles v ON a.sim_no = v.sim_no
    WHERE v.assigned_user_id = ? OR v.assigned_user_name LIKE ?
    ORDER BY a.timestamp DESC
    LIMIT ?
  `),
  getAlarmWithVehicle: db.prepare(`
    SELECT a.*, v.assigned_user_id, v.assigned_user_name, v.tenant_id
    FROM alarms a
    LEFT JOIN vehicles v ON a.sim_no = v.sim_no
    WHERE a.id = ?
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
