-- Dashcam SQLite Production Relational Schema
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Vehicles Registry Table
CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    number_plate TEXT NOT NULL,
    sim_no TEXT UNIQUE NOT NULL,
    model TEXT DEFAULT 'T98 NON-AI 4G Dual-Cam',
    driver_name TEXT DEFAULT '',
    driver_phone TEXT DEFAULT '',
    assigned_user_id TEXT DEFAULT '',
    assigned_user_name TEXT DEFAULT '',
    assigned_user_phone TEXT DEFAULT '',
    tenant_id TEXT DEFAULT 'default',
    channel_count INTEGER DEFAULT 2,
    channels_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicles_sim ON vehicles(sim_no);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant ON vehicles(tenant_id);

-- 2. High-Throughput GPS Telemetry History Table
CREATE TABLE IF NOT EXISTS gps_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_no TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed_kmh REAL DEFAULT 0.0,
    direction REAL DEFAULT 0.0,
    altitude REAL DEFAULT 0.0,
    acc_on INTEGER DEFAULT 0,
    address TEXT DEFAULT '',
    satellites INTEGER DEFAULT 0,
    signal_strength INTEGER DEFAULT 0,
    timestamp DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gps_sim_time ON gps_history(sim_no, timestamp);
CREATE INDEX IF NOT EXISTS idx_gps_time ON gps_history(timestamp);

-- 3. ADAS / DMS / Safety Alarms Table
CREATE TABLE IF NOT EXISTS alarms (
    id TEXT PRIMARY KEY,
    sim_no TEXT NOT NULL,
    alarm_type INTEGER NOT NULL,
    alarm_name TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    speed_kmh REAL DEFAULT 0.0,
    channel INTEGER DEFAULT 1,
    media_url TEXT DEFAULT '',
    acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT DEFAULT '',
    acknowledged_at DATETIME,
    timestamp DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alarms_sim_time ON alarms(sim_no, timestamp);
CREATE INDEX IF NOT EXISTS idx_alarms_type ON alarms(alarm_type);

-- 4. Video Recordings Registry Table (SD Card & Server Archive)
CREATE TABLE IF NOT EXISTS video_recordings (
    id TEXT PRIMARY KEY,
    sim_no TEXT NOT NULL,
    channel INTEGER DEFAULT 1,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    file_path TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    stream_type INTEGER DEFAULT 1,
    storage_type INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_video_sim_time ON video_recordings(sim_no, channel, start_time);

-- 5. API Auth Tokens Table
CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tenant_id TEXT DEFAULT 'default',
    role TEXT DEFAULT 'customer',
    token_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
);
