#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg stop_flush: " + err.message + "\n"); process.exit(0); });
const path = require("path");
const https = require("https");
const lib = require("./_lib.cjs");

const GRAPHQL_URL = "https://ouybbvbacjd3tbbvf3jpqbiizy.appsync-api.us-east-2.amazonaws.com/graphql";
const API_KEY     = "da2-xj6noinlgffx3ms3lgeopbhrjq";

function gqlPost(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(GRAPHQL_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function refreshToken(oldToken) {
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "refresh_token", token: ${JSON.stringify(oldToken)}) }`,
      {}
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (result.token) {
      const config = lib.loadJson(lib.CONFIG_FILE);
      config.token = result.token;
      config.plan = result.plan;
      lib.saveJsonAtomic(lib.CONFIG_FILE, config);
      return result;
    }
  } catch { /* silent */ }
  return null;
}

async function main() {
  const event = (await lib.readStdinJson(500)) || {};
  const sessionId = event.session_id;

  // Housekeeping: drop stale per-session files and pre-0.4 global caches
  lib.gcSessions();
  lib.unlinkQuiet(path.join(lib.CLAUDE_DIR, "pg_session.json"));
  lib.unlinkQuiet(path.join(lib.CLAUDE_DIR, "pg_read_cache.json"));
  lib.unlinkQuiet(path.join(lib.CLAUDE_DIR, "pg_bash_cache.json"));

  const session = lib.loadSession(sessionId);
  const config = lib.loadJson(lib.CONFIG_FILE);

  const hits = session.hits || 0;
  const misses = session.misses || 0;
  const tokensSaved = session.tokensSaved || 0;

  // Capture codebase (project folder name) from cwd
  const codebase = path.basename(event.cwd || process.cwd());

  if (hits === 0 && misses === 0) process.exit(0);

  const token = config.token;
  if (!token) process.exit(0);

  // Verify or refresh JWT
  let jwt = lib.verifyJWT(token);
  let plan = jwt?.plan;

  if (!jwt) {
    // Token invalid or expired, try refresh
    const refreshed = await refreshToken(token);
    if (refreshed) {
      plan = refreshed.plan;
      jwt = lib.decodeJWT(refreshed.token);
    } else {
      process.exit(0);
    }
  }

  // FREE plan: show FOMO, don't write stats
  if (!lib.isPaidPlan(plan)) {
    const savings = tokensSaved.toLocaleString();
    process.stderr.write(
      `\n  Prompt Genie: Context Memory paused\n` +
      `  Claude re-read ~${savings} tokens worth of context this session.\n` +
      `  Activate to stop paying for what Claude already knows → prompt-genie.com\n\n`
    );
    lib.deleteSession(sessionId);
    process.exit(0);
  }

  // PRO/TEAMS: write stats
  try {
    const decoded = jwt || lib.decodeJWT(token);
    await gqlPost(
      `mutation CreateSmartContextSessionStats($input: CreateSmartContextSessionStatsInput!) {
        createSmartContextSessionStats(input: $input) { id }
      }`,
      {
        input: {
          email: decoded.email,
          sessionDate: session.date || lib.today(),
          hits,
          misses,
          tokensSaved,
          source: "CLAUDE_CODE",
          codebase,
          createdAt: new Date().toISOString(),
        },
      }
    );
    lib.deleteSession(sessionId);
  } catch { /* silent */ }

  process.exit(0);
}

main();
