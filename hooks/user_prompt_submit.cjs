#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg user_prompt_submit: " + err.message + "\n"); process.exit(0); });
const fs = require("fs");
const path = require("path");
const lib = require("./_lib.cjs");

// Don't re-inject unless this many new files entered context since the last hint —
// the hint itself costs tokens on every prompt
const MIN_NEW_FILES = 3;

function buildContextNote(filesRead, cwd) {
  const count = filesRead.length;
  if (count === 0) return null;

  // Convert absolute paths to short relative paths where possible
  const shortPaths = filesRead.map((f) => {
    try {
      const rel = path.relative(cwd, f);
      // If the file is deep outside cwd, just use the basename
      return rel.startsWith("../../") ? path.basename(f) : rel;
    } catch {
      return path.basename(f);
    }
  });

  if (count <= 15) {
    return (
      `[Prompt Genie] ${count} file${count === 1 ? "" : "s"} already in context this session: ` +
      shortPaths.join(", ") +
      `. Check your context before using the Read tool — these are already there.`
    );
  }

  if (count <= 40) {
    const shown = shortPaths.slice(-12); // most recently read
    return (
      `[Prompt Genie] ${count} files in context this session. Most recent: ` +
      shown.join(", ") +
      ` (and ${count - shown.length} more). Check your context before using the Read tool.`
    );
  }

  return (
    `[Prompt Genie] ${count} files in context this session. ` +
    `Most project files are already there — check context before using the Read tool.`
  );
}

// Distinct file paths from the session's range-keyed entries, oldest-read first,
// excluding files that changed on disk since they were read (those need a re-read)
function contextPaths(files) {
  const byPath = new Map();
  for (const entry of Object.values(files)) {
    if (!entry || !entry.path) continue;
    const cur = byPath.get(entry.path);
    if (!cur || (entry.ts || 0) > (cur.ts || 0)) byPath.set(entry.path, entry);
  }

  const paths = [];
  for (const entry of [...byPath.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    try {
      const mtime = fs.statSync(entry.path).mtimeMs;
      if (entry.mtime != null && mtime !== entry.mtime) continue; // edited since read
    } catch { continue; } // deleted
    paths.push(entry.path);
  }
  return paths;
}

async function main() {
  const data = await lib.readStdinJson();
  if (!data || data.hook_event_name !== "UserPromptSubmit") process.exit(0);

  const config = lib.loadJson(lib.CONFIG_FILE);
  if (!config.token) process.exit(0);

  const jwt = lib.verifyJWT(config.token);
  if (!jwt || !lib.isPaidPlan(jwt.plan)) process.exit(0);

  const session = lib.loadSession(data.session_id);
  const paths = contextPaths(session.files || {});
  if (paths.length === 0) process.exit(0);

  if (paths.length - (session.hintedCount || 0) < MIN_NEW_FILES) process.exit(0);

  const cwd = data.cwd || process.cwd();
  const note = buildContextNote(paths, cwd);
  if (!note) process.exit(0);

  session.hintedCount = paths.length;
  lib.saveSession(data.session_id, session);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: note,
    },
  }));
  process.exit(0);
}

main();
