// Read-only preflight for a database provisioned through the separate DBA procedure.
const requiredColumns = {
  bookings: ["id", "room_id", "date", "start", "end", "owner", "team", "purpose", "created_at", "owner_email", "owner_id", "series_id", "attendees", "attendee_accounts", "revision", "ended_at", "source"],
  kiosk_requests: ["device_id", "request_key", "request_hash", "result_json", "created_at"],
  kiosk_devices: ["device_id", "expires_at", "revoked"],
  calendar_jobs: ["booking_id", "owner_id", "desired_json", "version", "synced_version", "event_id", "transaction_id", "first_payload", "status", "attempts", "next_attempt", "lease_token", "lease_until", "error_code", "updated_at"],
  employees: ["id", "name", "email"],
  room_favorites: ["owner_id", "room_id"],
  microsoft_connections: ["owner_id", "encrypted_tokens"],
  sessions: ["sid", "user_json", "expires_at"],
  meta: ["key", "value"],
  booking_audit: ["id", "at", "action", "booking_id", "actor_id", "actor_name", "before_json", "after_json", "changed_json"],
};

export function validateProductionSchema(db) {
  const tableInfo = db.prepare("SELECT name FROM pragma_table_info(?)");
  const missing = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(tableInfo.all(table).map(row => row.name));
    for (const column of columns) if (!actual.has(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length) {
    throw new Error(`운영 DB 구조가 이 버전과 맞지 않습니다 (${missing.join(", ")}). 서버는 DB를 자동 변경하지 않습니다. 별도 승인된 백업·마이그레이션 절차를 완료한 뒤 다시 시작하세요.`);
  }
}
