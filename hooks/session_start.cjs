#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg session_start: " + err.message + "\n"); process.exit(0); });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const lib = require("./_lib.cjs");

// After /compact or /clear the conversation context no longer holds the files,
// lines and command outputs we recorded — wipe the dedup maps so re-reads pass through.
// On startup/resume the context (if any) is intact, so leave state alone.

// Once a day, check for a newer release in a detached process so the session
// never waits on the network. Only from the installed hooks folder, never from
// a checkout of this repo.
function maybeSelfUpdate() {
  try {
    const installed = path.join(process.env.HOME || os.homedir(), ".prompt-genie", "hooks");
    // Compare real paths: __dirname has symlinks resolved, HOME may not (macOS /var).
    if (fs.realpathSync(__dirname) !== fs.realpathSync(installed)) return;
    const updater = require("./self_update.cjs");
    if (!updater.autoUpdateEnabled() || !updater.isDue()) return;
    spawn(process.execPath, [path.join(__dirname, "self_update.cjs")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch { /* updating is best-effort */ }
}

async function main() {
  const data = await lib.readStdinJson();
  if (!data || data.hook_event_name !== "SessionStart") process.exit(0);

  if (data.source === "startup" || data.source === "resume") {
    lib.queueEvent("cli_session_started", { source: data.source });
    maybeSelfUpdate();
  }

  if (data.source !== "compact" && data.source !== "clear") process.exit(0);

  const session = lib.loadSession(data.session_id);
  if (!session.files && !session.bash && !session.lines && !session.hintedCount) process.exit(0);

  session.files = {};
  session.bash = {};
  session.lines = {};
  session.hintedCount = 0;
  lib.saveSession(data.session_id, session);
  process.exit(0);
}

main();
