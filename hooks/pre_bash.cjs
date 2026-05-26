#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASH_CACHE_FILE = path.join(process.env.HOME, ".claude/pg_bash_cache.json");
const SESSION_FILE    = path.join(process.env.HOME, ".claude/pg_session.json");
const STATS_FILE      = path.join(process.env.HOME, ".claude/pg_stats.json");
const CONFIG_FILE     = path.join(process.env.HOME, ".claude/pg_config.json");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArjBMJfK6K8JnPvZR3kuS
d80nO2gvF2AULghE6WNtD1N0+k2GPShpGBiV/6WugrP840i8MRL+fyBid7DQw6Tj
eqZ7lj8wHTKglNZCRgOvmV+Q9LOpUfDCV+znUlEJLlbZy73X2CNPN6D2kfKPL7yT
Yo9HJG2j2n0BQhrQELbSct1q4hNMwcie2X5S9mR+lwcxRFEsvLuVe33hH0Rk6CSz
BP0MCcqwkHCs8a5bdm2U5KveIv1pMUwwl8HKki3rjYbv7scdXPgERs27tRbpLdYj
2+MhWaGHrt21pfASIKPwFiZaMhOV49hT3CC3rRY4zgtExFfYIx8qHt4LDM3rSheM
dwIDAQAB
-----END PUBLIC KEY-----`;

// 2-minute TTL for bash command results
const CACHE_TTL_MS = 120_000;

// Commands that only read data and never modify the filesystem
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

// These make any command unsafe regardless of prefix
const UNSAFE_PATTERNS = [
  /\s>>?\s/,         // redirect to file (with surrounding spaces)
  />>?[./~]/,        // redirect directly to a path
  /\|\s*tee\s+\S/,  // tee output to a file
  /\bsed\s+-i\b/,   // in-place sed
  /\bawk\s+-i\b/,   // in-place awk
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
  // Skip multi-line commands
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

function estimateTokens(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

function verifyJWT(token) {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (!verify.verify(PUBLIC_KEY, signature, "base64url")) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch { return null; }
}

function isPaidPlan(plan) {
  return ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);
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

process.stdin.resume();
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.tool_name !== "Bash") process.exit(0);

  const config = loadJson(CONFIG_FILE);
  if (!config.token) process.exit(0);

  const jwt = verifyJWT(config.token);
  if (!jwt || !isPaidPlan(jwt.plan)) process.exit(0);

  const command = data.tool_input?.command;
  if (!command || !isReadOnly(command)) process.exit(0);

  const key = cacheKey(command);
  const bashCache = loadJson(BASH_CACHE_FILE);
  const entry = bashCache[key];
  if (!entry) process.exit(0);

  const age = Date.now() - entry.ts;
  if (age > CACHE_TTL_MS) process.exit(0);

  const tokensSaved = estimateTokens(entry.output);
  recordHit(tokensSaved);
  process.stdout.write(entry.output);
  process.exit(2);
});
