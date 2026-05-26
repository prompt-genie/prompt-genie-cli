#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_FILE   = path.join(process.env.HOME, ".claude/pg_read_cache.json");
const STATS_FILE   = path.join(process.env.HOME, ".claude/pg_stats.json");
const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");
const CONFIG_FILE  = path.join(process.env.HOME, ".claude/pg_config.json");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
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

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function estimateTokens(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

// Returns decoded payload or null if invalid/expired
function verifyJWT(token) {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;

    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    const valid = verify.verify(PUBLIC_KEY, signature, "base64url");
    if (!valid) return null;

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return decoded;
  } catch {
    return null;
  }
}

function isPaidPlan(plan) {
  return ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);
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

  // Check JWT — gate cache on paid plan
  const config = loadJson(CONFIG_FILE);
  const token = config.token;
  if (!token) process.exit(0);

  const jwt = verifyJWT(token);
  if (!jwt || !isPaidPlan(jwt.plan)) process.exit(0);

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
