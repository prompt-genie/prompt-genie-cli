#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_FILE   = path.join(process.env.HOME, ".claude/pg_read_cache.json");
const STATS_FILE   = path.join(process.env.HOME, ".claude/pg_stats.json");
const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");

// Never let a hook crash silently — Claude Code shows "No stderr output" with no detail
process.on("uncaughtException", (err) => {
  process.stderr.write("pg post_read: " + err.message + "\n");
  process.exit(0); // Always pass through on error
});

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* silent */ }
}

function hashContent(str) {
  try { return crypto.createHash("sha1").update(str).digest("hex"); } catch { return null; }
}

function estimateTokens(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

function extractText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (!toolResponse || typeof toolResponse !== "object") return "";
  // New Claude Code format: {type:"text", file:{filePath, content, numLines, ...}}
  if (toolResponse.file && typeof toolResponse.file.content === "string") {
    return toolResponse.file.content;
  }
  // Older format: {content:[{type:"text",text:"..."}]}
  if (Array.isArray(toolResponse.content)) {
    return toolResponse.content.map((b) => b.text ?? "").join("");
  }
  return JSON.stringify(toolResponse);
}

function recordHit(tokensSaved) {
  const stats = loadJson(STATS_FILE);
  stats.total_hits = (stats.total_hits || 0) + 1;
  stats.total_tokens_saved = (stats.total_tokens_saved || 0) + tokensSaved;
  saveJson(STATS_FILE, stats);

  const session = loadJson(SESSION_FILE);
  session.hits = (session.hits || 0) + 1;
  session.tokensSaved = (session.tokensSaved || 0) + tokensSaved;
  session.date = new Date().toISOString().slice(0, 10);
  saveJson(SESSION_FILE, session);
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

  if (data.tool_name !== "Read") process.exit(0);

  const filePath = data.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const content = extractText(data.tool_response);
  if (!content) process.exit(0);

  const hash = hashContent(content);
  const cache = loadJson(CACHE_FILE);
  const session = loadJson(SESSION_FILE);
  const filesRead = session.filesRead || [];

  // Check if this file was already read earlier in this session with identical content
  const isRepeat = filesRead.includes(filePath);
  const cachedHash = cache[filePath]?.hash;

  if (isRepeat && hash && cachedHash && hash === cachedHash) {
    // File is already in Claude's context and hasn't changed — replace content with brief note
    // This uses updatedToolOutput so Claude gets ~10 tokens instead of the full file
    const lineCount = content.split("\n").length;
    const tokensSaved = Math.max(0, estimateTokens(content) - 15);
    recordHit(tokensSaved);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: `[Already in context — file unchanged since your last read. ${lineCount} lines. Refer to your earlier read for the content.]`,
      },
    }));
    process.exit(0);
  }

  // First read or content changed — update cache and session tracking
  let mtime = null;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ok */ }

  cache[filePath] = { mtime, hash, content };
  saveJson(CACHE_FILE, cache);

  if (!filesRead.includes(filePath)) filesRead.push(filePath);
  session.filesRead = filesRead;
  session.date = new Date().toISOString().slice(0, 10);
  saveJson(SESSION_FILE, session);

  recordMiss();
  process.exit(0);
});
