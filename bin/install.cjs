#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const readline = require("readline");
const crypto = require("crypto");

const HOOKS_DEST    = path.join(os.homedir(), ".prompt-genie", "hooks");
const SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
const CONFIG_FILE   = path.join(os.homedir(), ".claude", "pg_config.json");
const HOOKS_SRC     = path.join(__dirname, "..", "dist", "hooks");

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

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
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

function gqlPost(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
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

function copyHooks() {
  fs.mkdirSync(HOOKS_DEST, { recursive: true });
  for (const file of fs.readdirSync(HOOKS_SRC)) {
    if (file.endsWith(".cjs")) {
      fs.copyFileSync(path.join(HOOKS_SRC, file), path.join(HOOKS_DEST, file));
    }
  }
}

function wireHooks() {
  const settings = loadJson(SETTINGS_FILE);
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = [
    { matcher: "Read", hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "pre_read.cjs")}` }] },
    { matcher: "Bash", hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "pre_bash.cjs")}` }] },
  ];
  settings.hooks.PostToolUse = [
    { matcher: "Read", hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "post_read.cjs")}` }] },
    { matcher: "Bash", hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "post_bash.cjs")}` }] },
  ];
  settings.hooks.Stop = [
    { hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "stop_flush.cjs")}` }] },
  ];
  saveJson(SETTINGS_FILE, settings);
}

function finishInstall(email, plan, token) {
  copyHooks();
  wireHooks();
  saveJson(CONFIG_FILE, { email, plan, token });

  const isPaid = ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);
  if (isPaid) {
    console.log(`
  You're all set.

  Prompt Genie is now active in Claude Code. Every file Claude reads
  gets remembered for the session. No more paying to re-read
  the same code on every turn.

  Restart VS Code to activate, then start a session as normal.
  Your context savings will appear at prompt-genie.com/dashboard.
`);
  } else {
    console.log(`
  Installed.

  You're on the Free plan. Prompt Genie is running but context
  memory is paused. At the end of each session you'll see how much
  you would have saved.

  Activate context memory -> prompt-genie.com/pricing
`);
  }
}

async function main() {
  console.log("\n  Prompt Genie for Claude Code\n");

  // Check for existing valid token — skip auth if still good
  const existing = loadJson(CONFIG_FILE);
  if (existing.token && existing.email) {
    const jwt = verifyJWT(existing.token);
    if (jwt) {
      console.log(`  Updating hooks for ${existing.email}...`);
      finishInstall(existing.email, existing.plan, existing.token);
      return;
    }

    // Token expired — try a silent refresh before asking for email
    console.log("  Refreshing session...");
    try {
      const res = await gqlPost(
        `mutation { cliAuth(action: "refresh_token", token: ${JSON.stringify(existing.token)}) }`
      );
      const result = JSON.parse(res.data?.cliAuth || "{}");
      if (result.success && result.token) {
        finishInstall(existing.email, result.plan, result.token);
        return;
      }
    } catch { /* fall through to full auth */ }
  }

  // Full auth flow (first install or refresh failed)
  console.log("  Reduce what Claude re-reads every session.\n");

  const email = await ask("  Enter your Prompt Genie email: ");
  if (!email || !email.includes("@")) {
    console.error("  Invalid email. Run again with a valid address.");
    process.exit(1);
  }

  console.log("\n  Sending verification code to " + email + "...");
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "send_magic_link", email: ${JSON.stringify(email)}) }`
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (!result.success) {
      console.error("  " + (result.error || "Failed to send code. Try again."));
      process.exit(1);
    }
  } catch (err) {
    console.error("  Network error:", err.message);
    process.exit(1);
  }

  console.log("  Check your email for a 6-digit code.\n");
  const code = await ask("  Enter code: ");
  if (!code || code.length !== 6) {
    console.error("  Invalid code.");
    process.exit(1);
  }

  console.log("\n  Verifying...");
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "verify_magic_link", email: ${JSON.stringify(email)}, code: ${JSON.stringify(code)}) }`
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (!result.success || !result.token) {
      console.error("  " + (result.error || "Verification failed. Try again."));
      process.exit(1);
    }
    finishInstall(email, result.plan, result.token);
  } catch (err) {
    console.error("  Network error:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Install failed:", err.message);
  process.exit(1);
});
