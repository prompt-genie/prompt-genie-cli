#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg session_start: " + err.message + "\n"); process.exit(0); });
const lib = require("./_lib.cjs");

// After /compact or /clear the conversation context no longer holds the files and
// command outputs we recorded — wipe the dedup maps so re-reads pass through.
// On startup/resume the context (if any) is intact, so leave state alone.

async function main() {
  const data = await lib.readStdinJson();
  if (!data || data.hook_event_name !== "SessionStart") process.exit(0);

  if (data.source !== "compact" && data.source !== "clear") process.exit(0);

  const session = lib.loadSession(data.session_id);
  if (!session.files && !session.bash && !session.hintedCount) process.exit(0);

  session.files = {};
  session.bash = {};
  session.hintedCount = 0;
  lib.saveSession(data.session_id, session);
  process.exit(0);
}

main();
