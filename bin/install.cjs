#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const readline = require("readline");

const HOOKS_DEST = path.join(os.homedir(), ".prompt-genie", "hooks");
const SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
const CONFIG_FILE = path.join(os.homedir(), ".claude", "pg_config.json");

const HOOKS_SRC = path.join(__dirname, "..", "hooks");

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

  const email = await ask("  Enter your Prompt Genie email: ");
  if (!email || !email.includes("@")) {
    console.error("  Invalid email. Run again with a valid address.");
    process.exit(1);
  }

  console.log("\n  Installing hooks...");
  copyHooks();

  console.log("  Wiring Claude Code settings...");
  wireHooks();

  console.log("  Saving config...");
  saveJson(CONFIG_FILE, { email });

  console.log(`
  All done!

  Restart VS Code to activate.
  Your token savings will appear at prompt-genie.com after your first session.
`);
}

main().catch((err) => {
  console.error("Install failed:", err.message);
  process.exit(1);
});
