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
const EVENTS_FILE   = path.join(os.homedir(), ".claude", "pg_events.json");
const VERSION       = require("../package.json").version;
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

// Build a hook command string for settings.json. Claude Code runs these through
// a shell, which eats backslashes as escapes, so a Windows path.join result like
// C:\Users\me\.prompt-genie\hooks\pre_read.cjs collapses to C:Usersme... and the
// hook dies with MODULE_NOT_FOUND. Normalize to forward slashes (Node accepts
// them on every platform) and quote for paths that contain spaces.
function hookCommand(file) {
  const p = path.join(HOOKS_DEST, file).replace(/\\/g, "/");
  return `node "${p}"`;
}

// Our hook groups, by Claude Code event.
function ourHooks() {
  return {
    PreToolUse: [
      { matcher: "Read", hooks: [{ type: "command", command: hookCommand("pre_read.cjs") }] },
      { matcher: "Bash", hooks: [{ type: "command", command: hookCommand("pre_bash.cjs") }] },
    ],
    PostToolUse: [
      { matcher: "Read", hooks: [{ type: "command", command: hookCommand("post_read.cjs") }] },
      { matcher: "Bash", hooks: [{ type: "command", command: hookCommand("post_bash.cjs") }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("user_prompt_submit.cjs") }] }],
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand("session_start.cjs") }] }],
    Stop: [{ hooks: [{ type: "command", command: hookCommand("stop_flush.cjs") }] }],
  };
}

function isOurs(hook) {
  return typeof hook?.command === "string" && hook.command.replace(/\\/g, "/").includes("/.prompt-genie/hooks/");
}

// Add our hook groups to a { Event: [group, ...] } map next to whatever the user
// already has. Earlier installs replaced whole event lists, which deleted the
// user's own hooks; now we only remove our previous entries (so reinstalling
// never duplicates them) and keep the rest.
function mergeHookGroups(hooks, ours) {
  for (const [event, groups] of Object.entries(ours)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = existing
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    hooks[event] = [...kept, ...groups];
  }
  return hooks;
}

// ── Other coding agents ───────────────────────────────────────────────────────

// Each runs hooks/agent_hook.cjs with its own name and event. Codex and Gemini
// keep hooks in a settings file we merge into; Copilot reads every file in its
// hooks folder, so it gets a file of its own.
const AGENTS = {
  codex: {
    name: "Codex CLI",
    dir: ".codex",
    bin: "codex",
    wire() {
      const file = path.join(os.homedir(), ".codex", "hooks.json");
      const cmd = (event) => [{ type: "command", command: agentCommand("codex", event), timeout: 30 }];
      const config = loadJson(file);
      config.hooks = mergeHookGroups(config.hooks || {}, {
        PostToolUse: [{ matcher: "Bash", hooks: cmd("post_tool") }],
        SessionStart: [{ hooks: cmd("session_start") }],
        Stop: [{ hooks: cmd("stop") }],
      });
      saveJson(file, config);
    },
  },
  gemini: {
    name: "Gemini CLI",
    dir: ".gemini",
    bin: "gemini",
    wire() {
      const file = path.join(os.homedir(), ".gemini", "settings.json");
      const cmd = (event) => [{ name: "prompt-genie", type: "command", command: agentCommand("gemini", event), timeout: 30000 }];
      const settings = loadJson(file);
      settings.hooks = mergeHookGroups(settings.hooks || {}, {
        AfterTool: [{ matcher: "read_file|run_shell_command", hooks: cmd("post_tool") }],
        SessionStart: [{ hooks: cmd("session_start") }],
        PreCompress: [{ hooks: cmd("compact") }],
        AfterAgent: [{ hooks: cmd("stop") }],
      });
      saveJson(file, settings);
    },
  },
  copilot: {
    name: "GitHub Copilot CLI",
    dir: ".copilot",
    bin: "copilot",
    wire() {
      const cmd = (event) => [{ type: "command", command: agentCommand("copilot", event), timeoutSec: 30 }];
      saveJson(path.join(os.homedir(), ".copilot", "hooks", "prompt-genie.json"), {
        version: 1,
        hooks: {
          postToolUse: cmd("post_tool"),
          sessionStart: cmd("session_start"),
          preCompact: cmd("compact"),
          agentStop: cmd("stop"),
        },
      });
    },
  },
};

function agentCommand(agent, event) {
  return `${hookCommand("agent_hook.cjs")} ${agent} ${event}`;
}

function onPath(bin) {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (process.env.PATH || "").split(path.delimiter).some((dir) =>
    exts.some((ext) => dir && fs.existsSync(path.join(dir, bin + ext))));
}

// Agents installed on this machine that we could set up
function detectAgents() {
  return Object.keys(AGENTS).filter((id) =>
    fs.existsSync(path.join(os.homedir(), AGENTS[id].dir)) || onPath(AGENTS[id].bin));
}

// The agents the user chose at install time (kept in pg_config.json)
function chosenAgents() {
  const agents = loadJson(CONFIG_FILE).agents;
  return Array.isArray(agents) ? agents.filter((id) => AGENTS[id]) : [];
}

// Wire Claude Code, plus every other agent the user opted into. The
// self-updater calls this too, so it never adds an agent on its own.
function wireHooks() {
  const settings = loadJson(SETTINGS_FILE);
  settings.hooks = mergeHookGroups(settings.hooks || {}, ourHooks());
  saveJson(SETTINGS_FILE, settings);
  for (const id of chosenAgents()) {
    try { AGENTS[id].wire(); } catch (err) { console.error(`  Could not set up ${AGENTS[id].name}: ${err.message}`); }
  }
}

// Ask about agents found on this machine that aren't set up yet (only when
// someone is at the keyboard). Returns the full list of chosen agents.
async function chooseAgents() {
  const chosen = chosenAgents();
  if (!process.stdin.isTTY) return chosen;
  for (const id of detectAgents().filter((a) => !chosen.includes(a))) {
    const ans = await ask(`  Found ${AGENTS[id].name}. Use Prompt Genie there too? [Y/n] `);
    if (!/^n/i.test(ans)) chosen.push(id);
  }
  return chosen;
}

// Queue install events for the hooks to send at the end of the first turn
// (same queue and opt-outs as hooks/_lib.cjs; nothing is sent from here).
function queueInstallEvents(events) {
  try {
    const flag = String(process.env.PROMPT_GENIE_TELEMETRY || "").toLowerCase();
    if (flag === "0" || flag === "false" || flag === "off") return;
    if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== "0") return;
    if (loadJson(CONFIG_FILE).telemetry === false) return;
    const queue = loadJson(EVENTS_FILE);
    const list = Array.isArray(queue.events) ? queue.events : [];
    for (const [event, properties] of events) {
      list.push({
        id: `cli-${crypto.randomUUID()}`,
        event,
        timestamp: new Date().toISOString(),
        properties: { ...properties, client_version: VERSION },
      });
    }
    saveJson(EVENTS_FILE, { events: list.slice(-200) });
  } catch { /* never fail an install over analytics */ }
}

async function finishInstall(email, plan, token, { signedIn = false } = {}) {
  const reinstall = fs.existsSync(path.join(HOOKS_DEST, "stop_flush.cjs"));
  const agents = await chooseAgents();
  const telemetry = loadJson(CONFIG_FILE).telemetry;
  saveJson(CONFIG_FILE, {
    email, plan, token,
    ...(agents.length ? { agents } : {}),
    ...(telemetry === false ? { telemetry } : {}),
  });
  copyHooks();
  wireHooks();
  queueInstallEvents([
    ...(signedIn ? [["cli_signed_in", {}]] : []),
    ...agents.map((id) => ["cli_installed", {
      agent: id,
      os: process.platform,
      node_major: Number(process.versions.node.split(".")[0]),
      reinstall: reinstall ? "yes" : "no",
    }]),
    ["cli_installed", {
      agent: "claude_code",
      os: process.platform,
      node_major: Number(process.versions.node.split(".")[0]),
      reinstall: reinstall ? "yes" : "no",
    }],
  ]);

  const where = ["Claude Code", ...agents.map((id) => AGENTS[id].name)].join(", ");
  const isPaid = ["PRO", "ANNUAL_PRO", "THREE_DAY_PASS", "TEAMS", "ENTERPRISE", "LIFETIME"].includes(plan);
  if (isPaid) {
    console.log(`
  You're all set.

  Prompt Genie is now active in ${where}. Every file your agent
  reads gets remembered for the session. No more paying to re-read
  the same code on every turn.

  Restart them to activate, then start a session as normal.
  Your context savings will appear at prompt-genie.com/dashboard.

  Prompt Genie sends usage events linked to your account (session starts
  and token counts, never your code or prompts). Opt out: PROMPT_GENIE_TELEMETRY=0
`);
  } else {
    console.log(`
  Installed.

  You're on the Free plan. Prompt Genie is running but context
  memory is paused. At the end of each session you'll see how much
  you would have saved.

  Activate context memory -> prompt-genie.com/pricing

  Prompt Genie sends usage events linked to your account (session starts
  and token counts, never your code or prompts). Opt out: PROMPT_GENIE_TELEMETRY=0
`);
  }
}

async function main() {
  console.log("\n  Prompt Genie for Claude Code, Codex, Gemini CLI and Copilot CLI\n");

  // Check for existing valid token — skip auth if still good
  const existing = loadJson(CONFIG_FILE);
  if (existing.token && existing.email) {
    const jwt = verifyJWT(existing.token);
    if (jwt) {
      console.log(`  Updating hooks for ${existing.email}...`);
      await finishInstall(existing.email, existing.plan, existing.token);
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
        await finishInstall(existing.email, result.plan, result.token);
        return;
      }
    } catch { /* fall through to full auth */ }
  }

  // Full auth flow (first install or refresh failed)
  console.log("  Reduce what your coding agent re-reads every session.\n");

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
    await finishInstall(email, result.plan, result.token, { signedIn: true });
  } catch (err) {
    console.error("  Network error:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Install failed:", err.message);
    process.exit(1);
  });
}

module.exports = { wireHooks, isOurs, finishInstall, AGENTS, detectAgents };
