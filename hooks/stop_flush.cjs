#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");

const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");
const CONFIG_FILE = path.join(process.env.HOME, ".claude/pg_config.json");

const GRAPHQL_URL = "https://23syl46x2fct5i7bpkeusy7mt4.appsync-api.us-east-2.amazonaws.com/graphql";
const API_KEY = "da2-uhde7fi4n5fyhat4giiuqflgsi";

const CREATE_MUTATION = `
  mutation CreateSmartContextSessionStats($input: CreateSmartContextSessionStatsInput!) {
    createSmartContextSessionStats(input: $input) { id }
  }
`;

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

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

async function main() {
  const session = loadJson(SESSION_FILE);
  const config = loadJson(CONFIG_FILE);

  const hits = session.hits || 0;
  const misses = session.misses || 0;
  const tokensSaved = session.tokensSaved || 0;
  const email = config.email;

  // Nothing to flush or user not configured
  if ((hits === 0 && misses === 0) || !email) process.exit(0);

  try {
    await gqlPost(CREATE_MUTATION, {
      input: {
        email,
        sessionDate: session.date || new Date().toISOString().slice(0, 10),
        hits,
        misses,
        tokensSaved,
        source: "CLAUDE_CODE",
        createdAt: new Date().toISOString(),
      },
    });
    // Clear session accumulator after successful flush
    fs.writeFileSync(SESSION_FILE, JSON.stringify({}));
  } catch {
    // Silent fail — never block Claude Code from stopping
  }

  process.exit(0);
}

main();
