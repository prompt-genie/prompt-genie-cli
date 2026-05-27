#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg post_bash: " + err.message + "\n"); process.exit(0); });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASH_CACHE_FILE = path.join(process.env.HOME, ".claude/pg_bash_cache.json");
const SESSION_FILE    = path.join(process.env.HOME, ".claude/pg_session.json");
const STATS_FILE      = path.join(process.env.HOME, ".claude/pg_stats.json");

const MAX_OUTPUT_BYTES = 512_000; // skip caching huge outputs (>512 KB)
const MAX_CACHE_ENTRIES = 300;

const READONLY_PREFIXES = [
  /^cat\s+/,
  /^ls(\s|$)/,
  /^find\s+/,
  /^grep(\s+|\s+-[a-zA-Z]+\s+)/,
  /^rg\s+/,
  /^ag\s+/,
  /^head(\s+|\s+-[a-zA-Z0-9]+\s+)/,
  /^tail(\s+|\s+-[a-zA-Z0-9]+\s+)/,
  /^wc(\s+|\s+-[a-zA-Z]+\s+)/,
  /^stat\s+/,
  /^file\s+/,
  /^which\s+/,
  /^type\s+/,
  /^pwd(\s|$)/,
  /^sort(\s+|\s+-[a-zA-Z]+\s+)/,
  /^uniq(\s+|\s+-[a-zA-Z]+\s+)/,
  /^du(\s+|\s+-[a-zA-Z]+\s+)/,
  /^df(\s|$)/,
  /^jq\s+/,
  /^git\s+(log|show|diff|status|branch|config|tag|stash list|remote|describe|rev-parse|shortlog|blame|ls-files)\b/,
  /^npm\s+(list|ls|view|info|outdated|audit)\b/,
  /^yarn\s+(list|info|why)\b/,
  /^node\s+(-v|--version)(\s|$)/,
  /^node\s+--version(\s|$)/,
  /^echo\s+/,
  /^printf\s+/,
  /^env(\s|$)/,
  /^printenv(\s|$)/,
];

const UNSAFE_PATTERNS = [
  /\s>>?\s/,
  />>?[./~]/,
  /\|\s*tee\s+\S/,
  /\bsed\s+-i\b/,
  /\bawk\s+-i\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash (push|pop|drop)|rm|mv|clean)\b/,
  /\bnpx\b/,
];

function isReadOnly(command) {
  if (command.includes("\n")) return false;
  const cmd = command.trim();
  if (!READONLY_PREFIXES.some((re) => re.test(cmd))) return false;
  return !UNSAFE_PATTERNS.some((re) => re.test(cmd));
}

function cacheKey(command) {
  return crypto.createHash("sha1").update(process.cwd() + "\x00" + command).digest("hex");
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function recordMiss() {
  const stats = loadJson(STATS_FILE);
  stats.total_misses = (stats.total_misses || 0) + 1;
  saveJson(STATS_FILE, stats);

  const session = loadJson(SESSION_FILE);
  session.misses = (session.misses || 0) + 1;
  session.date = new Date().toISOString().slice(0, 10);
  saveJson(SESSION_FILE, session);
}

process.stdin.resume();
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.tool_name !== "Bash") process.exit(0);

  const command = data.tool_input?.command;
  if (!command || !isReadOnly(command)) process.exit(0);

  let output = data.tool_response ?? "";
  if (typeof output === "object") {
    const blocks = output.content;
    output = Array.isArray(blocks)
      ? blocks.map((b) => b.text ?? "").join("")
      : JSON.stringify(output);
  }

  if (!output || output.length > MAX_OUTPUT_BYTES) process.exit(0);

  const key = cacheKey(command);
  const bashCache = loadJson(BASH_CACHE_FILE);

  // Evict oldest entries if over limit
  const keys = Object.keys(bashCache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a, b) => (bashCache[a].ts || 0) - (bashCache[b].ts || 0));
    for (let i = 0; i < Math.floor(MAX_CACHE_ENTRIES * 0.2); i++) {
      delete bashCache[sorted[i]];
    }
  }

  bashCache[key] = { cmd: command.slice(0, 120), ts: Date.now(), output };
  saveJson(BASH_CACHE_FILE, bashCache);
  recordMiss();

  process.exit(0);
});
