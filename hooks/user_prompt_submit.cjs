#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

function buildContextNote(filesRead, cwd) {
  const count = filesRead.length;
  if (count === 0) return null;

  // Convert absolute paths to short relative paths where possible
  const shortPaths = filesRead.map((f) => {
    try {
      const rel = path.relative(cwd, f);
      // If the file is deep outside cwd, just use the basename
      return rel.startsWith("../../") ? path.basename(f) : rel;
    } catch {
      return path.basename(f);
    }
  });

  if (count <= 15) {
    return (
      `[Prompt Genie] ${count} file${count === 1 ? "" : "s"} already in context this session: ` +
      shortPaths.join(", ") +
      `. Check your context before using the Read tool — these are already there.`
    );
  }

  if (count <= 40) {
    const shown = shortPaths.slice(-12); // most recently read
    return (
      `[Prompt Genie] ${count} files in context this session. Most recent: ` +
      shown.join(", ") +
      ` (and ${count - shown.length} more). Check your context before using the Read tool.`
    );
  }

  return (
    `[Prompt Genie] ${count} files in context this session. ` +
    `Most project files are already there — check context before using the Read tool.`
  );
}

process.stdin.resume();
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  if (data.hook_event_name !== "UserPromptSubmit") process.exit(0);

  const config = loadJson(CONFIG_FILE);
  if (!config.token) process.exit(0);

  const jwt = verifyJWT(config.token);
  if (!jwt || !isPaidPlan(jwt.plan)) process.exit(0);

  const session = loadJson(SESSION_FILE);
  const filesRead = session.filesRead || [];
  if (filesRead.length === 0) process.exit(0);

  const cwd = data.cwd || process.cwd();
  const note = buildContextNote(filesRead, cwd);
  if (!note) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: note,
    },
  }));
  process.exit(0);
});
