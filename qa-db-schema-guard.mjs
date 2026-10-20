import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname);
const fixture = mkdtempSync(join(tmpdir(), "meeting-schema-guard-"));
const run = (dir, mode) => spawnSync(process.execPath,
  ["--input-type=module", "-e", "await import('./server/db.mjs')"],
  { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: mode, DATA_DIR: dir } });

const absent = join(fixture, "absent");
const noDatabase = run(absent, "production");
assert.notEqual(noDatabase.status, 0);
assert.match(noDatabase.stderr, /DB 파일이 없습니다/);
assert.equal(existsSync(absent), false, "production startup must not create a data directory");

const legacy = join(fixture, "legacy");
mkdirSync(legacy);
const legacyFile = join(legacy, "bookings.sqlite");
const old = new DatabaseSync(legacyFile);
old.exec("CREATE TABLE bookings (id TEXT PRIMARY KEY, owner TEXT NOT NULL)");
old.prepare("INSERT INTO bookings VALUES (?, ?)").run("existing-reservation", "Existing Owner");
old.close();
const hash = () => createHash("sha256").update(readFileSync(legacyFile)).digest("hex");
const before = hash();
const wrongSchema = run(legacy, "production");
assert.notEqual(wrongSchema.status, 0);
assert.match(wrongSchema.stderr, /운영 DB 구조가 이 버전과 맞지 않습니다/);
assert.equal(hash(), before, "rejected production startup must not change the DB file");

const ready = join(fixture, "ready");
assert.equal(run(ready, "test").status, 0, "isolated test schema must initialize");
const accepted = run(ready, "production");
assert.equal(accepted.status, 0, accepted.stderr);

console.log("DB startup guard passed: missing and old production databases remain untouched; prepared schema opens.");
