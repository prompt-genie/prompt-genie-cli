#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const SESSION_FILE = path.join(process.env.HOME, ".claude/pg_session.json");
const CONFIG_FILE  = path.join(process.env.HOME, ".claude/pg_config.json");

const GRAPHQL_URL = "https://ouybbvbacjd3tbbvf3jpqbiizy.appsync-api.us-east-2.amazonaws.com/graphql";
const API_KEY     = "da2-xj6noinlgffx3ms3lgeopbhrjq";

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

function isPaidPlan(plan) {
  return ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);
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

    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
}

function decodeJWT(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch { return null; }
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

async function refreshToken(oldToken) {
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "refresh_token", token: ${JSON.stringify(oldToken)}) }`,
      {}
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (result.token) {
      const config = loadJson(CONFIG_FILE);
      config.token = result.token;
      config.plan = result.plan;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      return result;
    }
  } catch { /* silent */ }
  return null;
}

async function main() {
  const session = loadJson(SESSION_FILE);
  const config = loadJson(CONFIG_FILE);

  const hits = session.hits || 0;
  const misses = session.misses || 0;
  const tokensSaved = session.tokensSaved || 0;

  if (hits === 0 && misses === 0) process.exit(0);

  const token = config.token;
  if (!token) process.exit(0);

  // Verify or refresh JWT
  let jwt = verifyJWT(token);
  let plan = jwt?.plan;

  if (!jwt) {
    // Token invalid or expired — try refresh
    const refreshed = await refreshToken(token);
    if (refreshed) {
      plan = refreshed.plan;
      jwt = decodeJWT(refreshed.token);
    } else {
      process.exit(0);
    }
  }

  // FREE plan — show FOMO, don't write stats
  if (!isPaidPlan(plan)) {
    const savings = tokensSaved.toLocaleString();
    process.stderr.write(
      `\n💡 Prompt Genie: You would have saved ~${savings} tokens this session.\n` +
      `   Upgrade to Pro to activate caching → prompt-genie.com\n\n`
    );
    fs.writeFileSync(SESSION_FILE, JSON.stringify({}));
    process.exit(0);
  }

  // PRO/TEAMS — write stats
  try {
    const decoded = jwt || decodeJWT(token);
    await gqlPost(
      `mutation CreateSmartContextSessionStats($input: CreateSmartContextSessionStatsInput!) {
        createSmartContextSessionStats(input: $input) { id }
      }`,
      {
        input: {
          email: decoded.email,
          sessionDate: session.date || new Date().toISOString().slice(0, 10),
          hits,
          misses,
          tokensSaved,
          source: "CLAUDE_CODE",
          createdAt: new Date().toISOString(),
        },
      }
    );
    fs.writeFileSync(SESSION_FILE, JSON.stringify({}));
  } catch { /* silent */ }

  process.exit(0);
}

main();
