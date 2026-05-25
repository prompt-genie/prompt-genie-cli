#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(process.env.HOME, ".claude/pg_read_cache.json");
const STATS_FILE = path.join(process.env.HOME, ".claude/pg_stats.json");
const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function estimateTokens(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

function recordHit(filePath, tokensSaved) {
  const stats = loadJson(STATS_FILE);
  stats.total_hits = (stats.total_hits || 0) + 1;
  stats.total_tokens_saved = (stats.total_tokens_saved || 0) + tokensSaved;
  stats.files = stats.files || {};
  stats.files[filePath] = stats.files[filePath] || { hits: 0, tokens_saved: 0 };
  stats.files[filePath].hits += 1;
  stats.files[filePath].tokens_saved += tokensSaved;
  saveJson(STATS_FILE, stats);

  const session = loadJson(SESSION_FILE);
  session.hits = (session.hits || 0) + 1;
  session.tokensSaved = (session.tokensSaved || 0) + tokensSaved;
  session.date = new Date().toISOString().slice(0, 10);
  saveJson(SESSION_FILE, session);
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.tool_name !== "Read") process.exit(0);

  const filePath = data.tool_input?.file_path;
  if (!filePath || !fs.existsSync(filePath)) process.exit(0);

  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { process.exit(0); }

  const cache = loadJson(CACHE_FILE);
  const entry = cache[filePath];

  if (entry && entry.mtime === mtime) {
    const tokensSaved = estimateTokens(entry.content);
    recordHit(filePath, tokensSaved);
    process.stdout.write(entry.content);
    process.exit(2);
  }

  process.exit(0);
});
