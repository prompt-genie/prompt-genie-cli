#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg stop_flush: " + err.message + "\n"); process.exit(0); });
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const lib = require("./_lib.cjs");

// Runs when Claude finishes a turn. Uploads the savings counted since the last
// upload and resets those counters. The session's memory of what Claude already
// read is kept, so re-reads in later turns of the same session still hit.

const CLI_VERSION = "0.5.0";
const GRAPHQL_URL = process.env.PG_GRAPHQL_URL || "https://ouybbvbacjd3tbbvf3jpqbiizy.appsync-api.us-east-2.amazonaws.com/graphql";
const API_KEY     = process.env.PG_API_KEY || "da2-xj6noinlgffx3ms3lgeopbhrjq";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PENDING_DAYS = 25;
// Server answers that mean "try again later"; anything else means the batch
// itself was rejected and resending it can never succeed.
const RETRYABLE_ERRORS = new Set(["Unauthorized", "Write failed", "Internal error"]);

function gqlPost(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(GRAPHQL_URL);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || undefined,
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
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function refreshToken(oldToken) {
  try {
    const res = await gqlPost(
      `mutation Refresh($token: String) { cliAuth(action: "refresh_token", token: $token) }`,
      { token: oldToken }
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

// Move the live counters into a pending upload with its own id. If the upload
// fails or its response is lost, the same entry (same id) is retried next time
// and the server records it once; new savings keep counting separately.
function stagePendingUpload(session, codebase) {
  const hits = session.hits || 0;
  const misses = session.misses || 0;
  const tokensSaved = session.tokensSaved || 0;
  const pending = session.pendingUploads || [];
  if (hits > 0 || misses > 0) pending.push({
    id: `cc-${crypto.randomUUID()}`,
    date: session.date || lib.today(),
    source: "CLAUDE_CODE",
    feature: "CONTEXT_MEMORY",
    hits,
    misses,
    tokensSaved,
    codebase,
    clientVersion: CLI_VERSION,
  });
  // The server only accepts recent dates, so drop uploads that sat unsent for
  // weeks, and cap how many we keep while offline.
  const cutoff = new Date(Date.now() - MAX_PENDING_DAYS * 86_400_000).toISOString().slice(0, 10);
  session.pendingUploads = pending.filter((p) => p.date >= cutoff).slice(-50);
  session.hits = 0;
  session.misses = 0;
  session.tokensSaved = 0;
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
  const hasPending = (session.pendingUploads || []).length > 0;
  if (hits === 0 && misses === 0 && !hasPending) process.exit(0);

  const token = config.token;
  if (!token) process.exit(0);

  // Verify or refresh JWT
  let jwt = lib.verifyJWT(token);
  let plan = jwt?.plan;
  let liveToken = token;

  if (!jwt) {
    const refreshed = await refreshToken(token);
    if (!refreshed) process.exit(0);
    plan = refreshed.plan;
    liveToken = refreshed.token;
  }

  // FREE plan: show what memory would have saved, then start counting afresh.
  if (!lib.isPaidPlan(plan)) {
    if (tokensSaved > 0) {
      process.stderr.write(
        `\n  Prompt Genie: Context Memory paused\n` +
        `  Claude re-read ~${tokensSaved.toLocaleString()} tokens worth of context this turn.\n` +
        `  Activate to stop paying for what Claude already knows → prompt-genie.com\n\n`
      );
    }
    session.hits = 0;
    session.misses = 0;
    session.tokensSaved = 0;
    session.pendingUploads = [];
    lib.saveSession(sessionId, session);
    process.exit(0);
  }

  // PRO/TEAMS: upload. The server takes the account from the signed token, so
  // the request carries no email.
  stagePendingUpload(session, path.basename(event.cwd || process.cwd()));
  lib.saveSession(sessionId, session);
  if (!session.pendingUploads.length) process.exit(0);

  try {
    const res = await gqlPost(
      `mutation Record($token: String!, $entries: String!) { recordTokenSavings(token: $token, entries: $entries) }`,
      { token: liveToken, entries: JSON.stringify(session.pendingUploads) }
    );
    const result = JSON.parse(res.data?.recordTokenSavings || "{}");
    if (result.success || (result.error && !RETRYABLE_ERRORS.has(result.error))) {
      const latest = lib.loadSession(sessionId);
      const sentIds = new Set(session.pendingUploads.map((p) => p.id));
      latest.pendingUploads = (latest.pendingUploads || []).filter((p) => !sentIds.has(p.id));
      lib.saveSession(sessionId, latest);
    }
  } catch { /* offline: pending uploads are retried at the next Stop */ }

  process.exit(0);
}

main();
