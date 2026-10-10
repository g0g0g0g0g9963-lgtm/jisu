// Isolated follow-up for cold-start timing in the legacy 5-second config test.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import net from "node:net";
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, "data-qa-final-auth-config", String(Date.now())); mkdirSync(run, { recursive: true });
const results = [], pause = ms => new Promise(r => setTimeout(r, ms));
for (const mode of ["unconfigured", "partial", "production-anonymous", "production-http"]) {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: resolve(run, mode), CLIENT_DIR: resolve(root, "dist"),
    MS_TENANT_ID: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "", APP_BASE_URL: "", MICROSOFT_TOKEN_KEY: "", ALLOW_ANONYMOUS: "", SEED_DEMO: "0",
    ADMIN_MS_EMAIL: "", ADMIN_MS_OBJECT_ID: "", BACKUP_DIR: "", BACKUP_INTERVAL_MINUTES: "0", TEST_FIXTURE_SSO: "0", TEST_FIXTURE_BOUNDARIES: "0" };
  if (mode === "partial") Object.assign(env, { MS_TENANT_ID: "qa-tenant", MS_CLIENT_ID: "qa-client", APP_BASE_URL: base, ALLOW_ANONYMOUS: "1" });
  if (mode === "production-anonymous") Object.assign(env, { NODE_ENV: "production", ALLOW_ANONYMOUS: "1" });
  if (mode === "production-http") Object.assign(env, { NODE_ENV: "production", MS_TENANT_ID: "qa-tenant", MS_CLIENT_ID: "qa-client", MS_CLIENT_SECRET: "qa-fake", APP_BASE_URL: base });
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", "./qa-preload.mjs", "server/index.mjs"], { cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "", exited = false, exitCode = null, signal = null, listening = false;
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  child.on("exit", (code, sig) => { exited = true; exitCode = code; signal = sig; });
  while (!exited && performance.now() - started < 30000) {
    try { await fetch(base + "/api/health", { signal: AbortSignal.timeout(300) }); listening = true; } catch {}
    await pause(100);
  }
  const knownError = mode === "partial" ? "SSO configuration is incomplete" : mode === "production-http" ? "Production SSO requires an HTTPS" : "Microsoft SSO is required";
  const result = { mode, pass: !listening && exited && exitCode !== 0 && logs.includes(knownError), elapsedMs: Math.round(performance.now() - started), exited, exitCode, signal, listening, knownError };
  results.push(result); console.log(JSON.stringify(result));
  if (!exited) child.kill();
  writeFileSync(resolve(run, mode + ".log"), logs);
}
writeFileSync(resolve(run, "results.json"), JSON.stringify({ results }, null, 2));
console.log("OUTPUT " + run); process.exitCode = results.every(r => r.pass) ? 0 : 1;
