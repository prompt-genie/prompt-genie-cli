#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const readline = require("readline");

const HOOKS_DEST    = path.join(os.homedir(), ".prompt-genie", "hooks");
const SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
const CONFIG_FILE   = path.join(os.homedir(), ".claude", "pg_config.json");
const HOOKS_SRC     = path.join(__dirname, "..", "hooks");

const GRAPHQL_URL = "https://ouybbvbacjd3tbbvf3jpqbiizy.appsync-api.us-east-2.amazonaws.com/graphql";
const API_KEY     = "da2-xj6noinlgffx3ms3lgeopbhrjq";

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
    {
      matcher: "Read",
      hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "pre_read.cjs")}` }],
    },
  ];
  settings.hooks.PostToolUse = [
    {
      matcher: "Read",
      hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "post_read.cjs")}` }],
    },
  ];
  settings.hooks.Stop = [
    {
      hooks: [{ type: "command", command: `node ${path.join(HOOKS_DEST, "stop_flush.cjs")}` }],
    },
  ];

  saveJson(SETTINGS_FILE, settings);
}

async function main() {
  console.log("\n  Prompt Genie — Token Saver for Claude Code\n");

  // Step 1: get email
  const email = await ask("  Enter your Prompt Genie email: ");
  if (!email || !email.includes("@")) {
    console.error("  Invalid email. Run again with a valid address.");
    process.exit(1);
  }

  // Step 2: send magic link
  console.log("\n  Sending verification code to " + email + "...");
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "send_magic_link", email: ${JSON.stringify(email)}) }`
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (!result.success) {
      console.error("  Failed to send code. Check your email and try again.");
      process.exit(1);
    }
  } catch (err) {
    console.error("  Network error:", err.message);
    process.exit(1);
  }

  // Step 3: ask for code
  console.log("  Check your email for a 6-digit code.\n");
  const code = await ask("  Enter code: ");
  if (!code || code.length !== 6) {
    console.error("  Invalid code.");
    process.exit(1);
  }

  // Step 4: verify code → get JWT
  console.log("\n  Verifying...");
  let token, plan;
  try {
    const res = await gqlPost(
      `mutation { cliAuth(action: "verify_magic_link", email: ${JSON.stringify(email)}, code: ${JSON.stringify(code)}) }`
    );
    const result = JSON.parse(res.data?.cliAuth || "{}");
    if (!result.success || !result.token) {
      console.error("  " + (result.error || "Verification failed. Try again."));
      process.exit(1);
    }
    token = result.token;
    plan  = result.plan;
  } catch (err) {
    console.error("  Network error:", err.message);
    process.exit(1);
  }

  // Step 5: install
  console.log("  Installing hooks...");
  copyHooks();

  console.log("  Wiring Claude Code settings...");
  wireHooks();

  console.log("  Saving config...");
  saveJson(CONFIG_FILE, { email, plan, token });

  // Step 6: result message based on plan
  const isPaid = ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE"].includes(plan);

  if (isPaid) {
    console.log(`
  ✅ All done! Caching is active.

  Restart VS Code to activate.
  Your token savings will appear at prompt-genie.com after your first session.
`);
  } else {
    console.log(`
  ✅ Installed! You're on the Free plan.

  Caching is disabled on Free — you'll see how many tokens you would have
  saved at the end of each session.

  Upgrade to Pro to activate → prompt-genie.com/pricing
`);
  }
}

main().catch((err) => {
  console.error("Install failed:", err.message);
  process.exit(1);
});
