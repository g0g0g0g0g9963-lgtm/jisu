import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Explicit IDs and verified account details only. Never guess ownership from names.
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!["--db", "--mapping", "--apply", "--offline-confirmed", "--help"].includes(key) || flags.has(key)) {
    throw new Error("Unknown or duplicate argument: " + key);
  }
  if (["--apply", "--offline-confirmed", "--help"].includes(key)) flags.set(key, true);
  else {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + key);
    flags.set(key, value);
  }
}
if (flags.has("--help")) {
  console.log("Usage: node server/assign-legacy-owner.mjs --db <bookings.sqlite> --mapping <mapping.json> [--apply --offline-confirmed]");
  console.log("Default is read-only preview. For apply, stop the reservation app first and confirm that every ID belongs to the specified account.");
  console.log('Mapping JSON: [{"bookingId":"bk-...","expectedOwner":"Exact stored display name","ownerId":"Microsoft Entra object ID (GUID)","ownerEmail":"verified@example.com"}]');
  process.exit(0);
}
if (!flags.has("--db") || !flags.has("--mapping")) throw new Error("Explicit --db and --mapping paths are required. Use --help.");
const apply = flags.has("--apply");
if (apply && !flags.has("--offline-confirmed")) throw new Error("Stop the app first, then add --offline-confirmed with --apply.");
const dbPath = resolve(flags.get("--db"));
if (!existsSync(dbPath)) throw new Error("Database does not exist: " + dbPath);
const mapping = JSON.parse(readFileSync(resolve(flags.get("--mapping")), "utf8"));
if (!Array.isArray(mapping) || !mapping.length || mapping.length > 500) throw new Error("Mapping must contain 1–500 explicit booking entries.");
const seen = new Set();
for (const entry of mapping) {
  if (!entry || typeof entry.bookingId !== "string" || !entry.bookingId ||
      typeof entry.expectedOwner !== "string" || !entry.expectedOwner ||
      typeof entry.ownerId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.ownerId) ||
      typeof entry.ownerEmail !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry.ownerEmail) || seen.has(entry.bookingId)) {
    throw new Error("Every mapping requires a unique bookingId, exact expectedOwner, valid Entra object ID and verified email.");
  }
  seen.add(entry.bookingId);
  entry.ownerId = entry.ownerId.toLowerCase();
  entry.ownerEmail = entry.ownerEmail.toLowerCase();
}
const db = new DatabaseSync(dbPath, { readOnly: !apply });
let transaction = false;
try {
  db.exec("PRAGMA busy_timeout = 0");
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('bookings')").all().map((row) => row.name));
  if (!columns.has("id") || !columns.has("owner")) throw new Error("Unrecognized bookings schema.");
  const readColumns = ["id", "owner", columns.has("owner_id") ? "owner_id" : "'' AS owner_id", columns.has("owner_email") ? "owner_email" : "'' AS owner_email"];
  const read = db.prepare("SELECT " + readColumns.join(", ") + " FROM bookings WHERE id = ?");
  const validate = () => mapping.map((entry) => {
    const row = read.get(entry.bookingId);
    if (!row) throw new Error("Booking not found: " + entry.bookingId);
    if (row.owner !== entry.expectedOwner) throw new Error("Display name changed or wrong booking selected: " + entry.bookingId);
    if (row.owner_id?.trim()) throw new Error("Booking already has an owner ID: " + entry.bookingId);
    if (row.owner_email?.trim() && row.owner_email.trim().toLowerCase() !== entry.ownerEmail) {
      throw new Error("Existing email conflicts with mapping: " + entry.bookingId);
    }
    return { bookingId: row.id, owner: row.owner, ownerId: entry.ownerId, ownerEmail: entry.ownerEmail };
  });
  const preview = validate();
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", database: dbPath, changes: preview }, null, 2));
  } else {
    // VACUUM INTO makes a consistent backup, including any committed WAL contents.
    const backupPath = dbPath + ".before-owner-migration-" + Date.now() + ".sqlite";
    db.prepare("VACUUM INTO ?").run(backupPath);
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    validate();
    if (!columns.has("owner_id")) db.exec("ALTER TABLE bookings ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("owner_email")) db.exec("ALTER TABLE bookings ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''");
    const update = db.prepare("UPDATE bookings SET owner_id = ?, owner_email = ? WHERE id = ? AND trim(COALESCE(owner_id, '')) = ''");
    for (const entry of mapping) {
      const result = update.run(entry.ownerId, entry.ownerEmail, entry.bookingId);
      if (Number(result.changes) !== 1) throw new Error("Booking changed during migration: " + entry.bookingId);
    }
    db.exec("COMMIT");
    transaction = false;
    console.log(JSON.stringify({ mode: "applied", database: dbPath, backup: backupPath, updated: mapping.length }, null, 2));
  }
} catch (error) {
  if (transaction) db.exec("ROLLBACK");
  throw error;
} finally { db.close(); }
