#!/usr/bin/env node
const fs = require("fs");
const lib = require("./_lib.cjs");

// Never let a hook crash silently — Claude Code shows "No stderr output" with no detail
process.on("uncaughtException", (err) => {
  process.stderr.write("pg post_read: " + err.message + "\n");
  process.exit(0); // Always pass through on error
});

const MAX_FILE_ENTRIES = 500;
const NOTE_TOKENS = 15; // rough size of the replacement note

function extractText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (!toolResponse || typeof toolResponse !== "object") return "";
  // New Claude Code format: {type:"text", file:{filePath, content, numLines, ...}}
  if (toolResponse.file && typeof toolResponse.file.content === "string") {
    return toolResponse.file.content;
  }
  // Older format: {content:[{type:"text",text:"..."}]}
  if (Array.isArray(toolResponse.content)) {
    return toolResponse.content.map((b) => b.text ?? "").join("");
  }
  return JSON.stringify(toolResponse);
}

async function main() {
  const data = await lib.readStdinJson();
  if (!data || data.tool_name !== "Read") process.exit(0);

  const filePath = data.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const content = extractText(data.tool_response);
  if (!content) process.exit(0);

  // Key by file + range so partial reads of big files dedupe independently
  // and a chunked read never clobbers the full-read entry
  const offset = data.tool_input?.offset ?? 0;
  const limit = data.tool_input?.limit ?? "all";
  const key = `${filePath}@${offset}-${limit}`;

  const hash = lib.sha1(content);
  const session = lib.loadSession(data.session_id);
  const files = session.files || {};
  const prev = files[key];

  if (hash && prev && prev.hash === hash) {
    // Same range delivered earlier this session with identical content —
    // replace it with a brief note so Claude gets ~15 tokens instead of the full file
    const lineCount = content.split("\n").length;
    const tokensSaved = Math.max(0, lib.estimateTokens(content) - NOTE_TOKENS);

    session.hits = (session.hits || 0) + 1;
    session.tokensSaved = (session.tokensSaved || 0) + tokensSaved;
    session.date = lib.today();
    lib.saveSession(data.session_id, session);
    lib.bumpStats({ hits: 1, tokensSaved });

    // Paid plans get the actual benefit: replace the repeated content with a
    // short note. Free plans are measured only (we recorded the would-be saving
    // above) and the full content passes through unchanged.
    if (lib.currentPlanIsPaid()) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: `[Already in context, file unchanged since your last read. ${lineCount} lines. Refer to your earlier read for the content.]`,
        },
      }));
    }
    process.exit(0);
  }

  // First read of this range, or content changed — record it
  let mtime = null;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ok */ }

  files[key] = { path: filePath, hash, mtime, ts: Date.now() };
  lib.evictOldest(files, MAX_FILE_ENTRIES);
  session.files = files;
  session.misses = (session.misses || 0) + 1;
  session.date = lib.today();
  lib.saveSession(data.session_id, session);
  lib.bumpStats({ misses: 1 });

  process.exit(0);
}

main();
