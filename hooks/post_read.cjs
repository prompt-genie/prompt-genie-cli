#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_FILE   = path.join(process.env.HOME, ".claude/pg_read_cache.json");
const STATS_FILE   = path.join(process.env.HOME, ".claude/pg_stats.json");
const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hashContent(str) {
  try { return crypto.createHash("sha1").update(str).digest("hex"); } catch { return null; }
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
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.tool_name !== "Read") process.exit(0);

  const filePath = data.tool_input?.file_path;
  let content = data.tool_response ?? "";

  if (typeof content === "object") {
    const blocks = content.content;
    content = Array.isArray(blocks)
      ? blocks.map((b) => b.text ?? "").join("")
      : JSON.stringify(content);
  }

  if (!filePath || !content || !fs.existsSync(filePath)) process.exit(0);

  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { process.exit(0); }

  const hash = hashContent(content);
  const cache = loadJson(CACHE_FILE);
  cache[filePath] = { mtime, hash, content };
  saveJson(CACHE_FILE, cache);
  recordMiss();

  process.exit(0);
});
