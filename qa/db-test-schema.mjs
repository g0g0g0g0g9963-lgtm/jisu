// Development and isolated QA only. Production startup never imports this module.
// Operational schema changes require the separate reviewed backup/migration procedure.
export function initializeDevelopmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      owner TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '회의',
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings (room_id, date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date)");
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('bookings')").all().map(row => row.name));
  for (const [name, definition] of [
    ["owner_email", "TEXT NOT NULL DEFAULT ''"],
    ["owner_id", "TEXT NOT NULL DEFAULT ''"],
    ["series_id", "TEXT"],
    ["attendees", "TEXT NOT NULL DEFAULT '[]'"],
    ["attendee_accounts", "TEXT NOT NULL DEFAULT '[]'"],
    ["revision", "INTEGER NOT NULL DEFAULT 1"],
    ["ended_at", "TEXT"],
    ["source", "TEXT NOT NULL DEFAULT 'site'"],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS kiosk_requests (
    device_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(device_id, request_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS kiosk_devices (
    device_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_jobs (
    booking_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, desired_json TEXT,
    version INTEGER NOT NULL DEFAULT 1, synced_version INTEGER NOT NULL DEFAULT 0,
    event_id TEXT, transaction_id TEXT NOT NULL, first_payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_jobs_due ON calendar_jobs(status, next_attempt);
  CREATE INDEX IF NOT EXISTS idx_calendar_jobs_owner_updated ON calendar_jobs(owner_id,updated_at DESC);
  CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS room_favorites (owner_id TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(owner_id,room_id));
  CREATE TABLE IF NOT EXISTS microsoft_connections (owner_id TEXT PRIMARY KEY, encrypted_tokens TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, user_json TEXT NOT NULL, expires_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS booking_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, action TEXT NOT NULL, booking_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
    before_json TEXT, after_json TEXT, changed_json TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_booking_audit_action_id ON booking_audit(action, id)");
}
