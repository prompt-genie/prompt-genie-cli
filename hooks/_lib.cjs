#!/usr/bin/env node
// Shared helpers for Prompt Genie hooks. Not a hook itself — required by the others.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CLAUDE_DIR   = path.join(process.env.HOME || os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "pg_sessions");
const STATS_FILE   = path.join(CLAUDE_DIR, "pg_stats.json");
const CONFIG_FILE  = path.join(CLAUDE_DIR, "pg_config.json");

const PUBLIC_KEY = process.env.PG_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArjBMJfK6K8JnPvZR3kuS
d80nO2gvF2AULghE6WNtD1N0+k2GPShpGBiV/6WugrP840i8MRL+fyBid7DQw6Tj
eqZ7lj8wHTKglNZCRgOvmV+Q9LOpUfDCV+znUlEJLlbZy73X2CNPN6D2kfKPL7yT
Yo9HJG2j2n0BQhrQELbSct1q4hNMwcie2X5S9mR+lwcxRFEsvLuVe33hH0Rk6CSz
BP0MCcqwkHCs8a5bdm2U5KveIv1pMUwwl8HKki3rjYbv7scdXPgERs27tRbpLdYj
2+MhWaGHrt21pfASIKPwFiZaMhOV49hT3CC3rRY4zgtExFfYIx8qHt4LDM3rSheM
dwIDAQAB
-----END PUBLIC KEY-----`;

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

// Write via temp file + rename so a concurrent hook never reads a half-written file
function saveJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch { /* hooks must never break the session */ }
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* ok */ }
}

function sha1(str) {
  try { return crypto.createHash("sha1").update(str).digest("hex"); } catch { return null; }
}

function estimateTokens(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Build a compact "reuse your earlier copy + apply this change" note describing
// how currText differs from prevText, assuming prevText is already in the model's
// context (it was delivered on the earlier read/run). Uses a common-prefix /
// common-suffix diff: O(n), and perfectly tight for the dominant case of an edit
// to one contiguous region. Returns { note, savedTokens } only when the delta is
// meaningfully smaller than the full text — otherwise null, and the caller passes
// the full text through unchanged. Lossless by reconstruction.
function buildLineDelta(prevText, currText, kind) {
  if (typeof prevText !== "string" || typeof currText !== "string") return null;
  if (prevText === currText) return null; // exact match is handled elsewhere

  const a = prevText.split("\n");
  const b = currText.split("\n");
  const aN = a.length;
  const bN = b.length;

  let p = 0;
  while (p < aN && p < bN && a[p] === b[p]) p++;
  let s = 0;
  while (s < aN - p && s < bN - p && a[aN - 1 - s] === b[bN - 1 - s]) s++;

  const removed = a.slice(p, aN - s);
  const added = b.slice(p, bN - s);

  const note =
    `[Prompt Genie delta] This ${kind} is identical to your previous ${kind} of the same ` +
    `target except for one region — reuse that earlier copy and apply this change:\n` +
    `- lines 1-${p} unchanged\n` +
    `- the last ${s} line(s) unchanged\n` +
    `- at line ${p + 1}, replace these ${removed.length} line(s):\n` +
    (removed.length ? removed.join("\n") + "\n" : "(none)\n") +
    `- with these ${added.length} line(s):\n` +
    (added.length ? added.join("\n") : "(none)");

  const fullTokens = estimateTokens(currText);
  const noteTokens = estimateTokens(note);
  // Only worth it if the delta is comfortably smaller than the full content.
  if (noteTokens >= Math.floor(fullTokens * 0.6)) return null;
  return { note, savedTokens: Math.max(0, fullTokens - noteTokens) };
}

// ── Per-session state ─────────────────────────────────────────────────────────

function sessionFile(sessionId) {
  const id = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(sessionId) {
  return loadJson(sessionFile(sessionId));
}

function saveSession(sessionId, data) {
  saveJsonAtomic(sessionFile(sessionId), data);
}

function deleteSession(sessionId) {
  unlinkQuiet(sessionFile(sessionId));
}

// Remove session files older than maxAgeDays (sessions that never flushed)
function gcSessions(maxAgeDays = 7) {
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      const full = path.join(SESSIONS_DIR, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* ok */ }
    }
  } catch { /* no sessions dir yet */ }
}

// Evict the oldest ~20% of entries (by .ts) when a map exceeds maxEntries
function evictOldest(map, maxEntries) {
  const keys = Object.keys(map);
  if (keys.length <= maxEntries) return;
  const sorted = keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
  const toDrop = Math.max(1, Math.floor(maxEntries * 0.2));
  for (let i = 0; i < toDrop; i++) delete map[sorted[i]];
}

// ── Lifetime stats ────────────────────────────────────────────────────────────

function bumpStats({ hits = 0, misses = 0, tokensSaved = 0 }) {
  const stats = loadJson(STATS_FILE);
  if (hits) stats.total_hits = (stats.total_hits || 0) + hits;
  if (misses) stats.total_misses = (stats.total_misses || 0) + misses;
  if (tokensSaved) stats.total_tokens_saved = (stats.total_tokens_saved || 0) + tokensSaved;
  saveJsonAtomic(STATS_FILE, stats);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Returns decoded payload, or null if signature invalid or token expired
function verifyJWT(token) {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (!verify.verify(PUBLIC_KEY, signature, "base64url")) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch { return null; }
}

function decodeJWT(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch { return null; }
}

function isPaidPlan(plan) {
  return ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);
}

// True only when the local config holds a signature-valid, unexpired paid token.
// Used to gate the actual context-memory benefit: free users are measured but
// their repeat reads/commands are NOT served from memory.
function currentPlanIsPaid() {
  try {
    const config = loadJson(CONFIG_FILE);
    if (!config || !config.token) return false;
    const jwt = verifyJWT(config.token);
    return !!(jwt && isPaidPlan(jwt.plan));
  } catch {
    return false;
  }
}

// ── stdin ─────────────────────────────────────────────────────────────────────

// Resolves with the parsed hook event, or null on malformed/missing input.
// Every hook ends with process.exit(), so the fallback timer never keeps us alive.
function readStdinJson(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    };
    process.stdin.resume();
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, timeoutMs);
  });
}

module.exports = {
  CLAUDE_DIR, SESSIONS_DIR, STATS_FILE, CONFIG_FILE, PUBLIC_KEY,
  loadJson, saveJsonAtomic, unlinkQuiet,
  sha1, estimateTokens, today, buildLineDelta,
  sessionFile, loadSession, saveSession, deleteSession, gcSessions, evictOldest,
  bumpStats,
  verifyJWT, decodeJWT, isPaidPlan, currentPlanIsPaid,
  readStdinJson,
};
