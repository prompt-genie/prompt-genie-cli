#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");
const lib = require("./_lib.cjs");

// Keeps the installed hooks current. session_start launches this in the
// background at most once a day; it never runs inside a hook's own time budget.
// It checks npm for a newer prompt-genie, verifies the tarball against the
// registry's sha512 integrity, and swaps in the new hooks. Off with
// PROMPT_GENIE_AUTO_UPDATE=0 or "autoUpdate": false in pg_config.json.

const HOME = process.env.HOME || os.homedir();
const HOOKS_DIR = path.join(HOME, ".prompt-genie", "hooks");
const STATE_FILE = path.join(lib.CLAUDE_DIR, "pg_update.json");
const LOCK_FILE = path.join(lib.CLAUDE_DIR, "pg_update.lock");
const REGISTRY = process.env.PG_REGISTRY_URL || "https://registry.npmjs.org";
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const HOOK_NAME_RE = /^[a-z_]+\.cjs$/;

function autoUpdateEnabled() {
  const flag = String(process.env.PROMPT_GENIE_AUTO_UPDATE || "").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return lib.loadJson(lib.CONFIG_FILE).autoUpdate !== false;
}

function isDue(now = Date.now()) {
  const state = lib.loadJson(STATE_FILE);
  return !(typeof state.checkedAt === "number" && now - state.checkedAt < CHECK_EVERY_MS);
}

// 1.2.3 > 1.2.2; pre-release tags are ignored (we never publish them as latest).
function isNewer(candidate, current) {
  const parse = (v) => String(v || "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Only the npm registry over https, unless a test points PG_REGISTRY_URL elsewhere.
function allowedUrl(raw) {
  try {
    const url = new URL(raw);
    if (process.env.PG_REGISTRY_URL) return url.origin === new URL(REGISTRY).origin;
    return url.protocol === "https:" && url.hostname === "registry.npmjs.org";
  } catch {
    return false;
  }
}

function fetchBuffer(raw, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(raw)) return reject(new Error("url not allowed"));
    const url = new URL(raw);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.get(url, { headers: { accept: "application/json, application/octet-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error("too large"));
        else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// npm's dist.integrity is "sha512-<base64>".
function integrityMatches(buf, integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ""));
  if (!m) return false;
  const actual = crypto.createHash("sha512").update(buf).digest();
  const expected = Buffer.from(m[1], "base64");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

// Minimal reader for the ustar archives npm publishes: regular files only.
function readTar(buf) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (type === "0" || type === "") files.set(full, buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

function takeLock() {
  try {
    fs.mkdirSync(lib.CLAUDE_DIR, { recursive: true });
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_FILE);
    } catch { /* no lock yet */ }
    fs.closeSync(fs.openSync(LOCK_FILE, "wx"));
    return true;
  } catch {
    return false; // another session is already updating
  }
}

async function main() {
  if (!autoUpdateEnabled() || !isDue() || !takeLock()) process.exit(0);
  try {
    // Record the check first so a failing registry is retried tomorrow, not every session.
    lib.saveJsonAtomic(STATE_FILE, { ...lib.loadJson(STATE_FILE), checkedAt: Date.now() });

    const meta = JSON.parse((await fetchBuffer(`${REGISTRY}/prompt-genie/latest`, 1024 * 1024)).toString("utf8"));
    if (!isNewer(meta.version, lib.CLI_VERSION)) return;

    const tarball = await fetchBuffer(meta.dist && meta.dist.tarball, MAX_TARBALL_BYTES);
    if (!integrityMatches(tarball, meta.dist.integrity)) throw new Error("integrity mismatch");
    const files = readTar(zlib.gunzipSync(tarball));

    const hooks = [...files.keys()]
      .filter((f) => f.startsWith("package/dist/hooks/") && HOOK_NAME_RE.test(path.basename(f)))
      .map((f) => [path.basename(f), files.get(f)]);
    const names = new Set(hooks.map(([n]) => n));
    if (!names.has("_lib.cjs") || !names.has("stop_flush.cjs") || !names.has("self_update.cjs")) {
      throw new Error("incomplete package");
    }

    // Write every new hook next to the old ones first, then rename them in, so a
    // session starting mid-update sees each file either whole or not at all.
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    const tag = `.update-${process.pid}`;
    for (const [name, body] of hooks) fs.writeFileSync(path.join(HOOKS_DIR, name + tag), body);
    for (const [name] of hooks) fs.renameSync(path.join(HOOKS_DIR, name + tag), path.join(HOOKS_DIR, name));

    // A release may add hook events; re-run the installer's wiring, which only
    // touches our own entries in ~/.claude/settings.json.
    const installer = files.get("package/bin/install.cjs");
    const pkgJson = files.get("package/package.json");
    if (installer && pkgJson) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pg-update-"));
      try {
        fs.mkdirSync(path.join(stage, "bin"));
        fs.writeFileSync(path.join(stage, "bin", "install.cjs"), installer);
        fs.writeFileSync(path.join(stage, "package.json"), pkgJson);
        require(path.join(stage, "bin", "install.cjs")).wireHooks();
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }

    lib.saveJsonAtomic(STATE_FILE, { ...lib.loadJson(STATE_FILE), version: meta.version, updatedAt: Date.now() });
    lib.queueEvent("cli_updated", { from_version: lib.CLI_VERSION, to_version: meta.version });
  } catch (err) {
    lib.saveJsonAtomic(STATE_FILE, { ...lib.loadJson(STATE_FILE), lastError: String(err && err.message).slice(0, 200) });
  } finally {
    lib.unlinkQuiet(LOCK_FILE);
  }
  process.exit(0);
}

if (require.main === module) {
  process.on("uncaughtException", () => process.exit(0));
  main();
}

module.exports = { isNewer, integrityMatches, readTar, isDue, autoUpdateEnabled, HOOKS_DIR };
