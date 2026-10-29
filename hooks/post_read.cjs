#!/usr/bin/env node
const lib = require("./_lib.cjs");

// Never let a hook crash silently — Claude Code shows "No stderr output" with no detail
process.on("uncaughtException", (err) => {
  process.stderr.write("pg post_read: " + err.message + "\n");
  process.exit(0); // Always pass through on error
});

const MAX_FILE_ENTRIES = 500;
const NOTE_TOKENS = 15;

// Delta encoding: when a re-read differs from the earlier read only in a small
// region (the edit -> re-read pattern), serve a compact diff instead of the whole
// file. We keep the prior text to diff against, but only for reasonably sized
// files and only for a bounded number of entries, so session state stays small.
const DELTA_MIN_CHARS = 2000;        // don't bother for small files
const DELTA_SOURCE_MAX = 48 * 1024;  // don't retain text for very large reads
const MAX_TEXT_ENTRIES = 40;         // cap how many entries keep their text

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

// The lines this read delivered and the line number of the first one, from the
// current {file:{content, startLine, numLines}} format only. Older formats carry
// display line numbers in the text and can't be matched line by line.
function readLines(toolResponse, toolInput) {
  const file = toolResponse && typeof toolResponse === "object" ? toolResponse.file : null;
  if (!file || typeof file.content !== "string") return null;
  const start = Number(file.startLine) || Number(toolInput?.offset) || 1;
  let lines = file.content.split("\n");
  if (Number.isInteger(file.numLines) && file.numLines >= 0) lines = lines.slice(0, file.numLines);
  return { start, lines };
}

// Keep the text only when it's worth retaining for a future delta.
function textToStore(content) {
  return content.length <= DELTA_SOURCE_MAX ? content : undefined;
}

// Drop .text from the oldest text-bearing entries once we exceed the cap.
function trimStoredText(files) {
  const withText = Object.keys(files).filter((k) => typeof files[k].text === "string");
  if (withText.length <= MAX_TEXT_ENTRIES) return;
  withText.sort((a, b) => (files[a].ts || 0) - (files[b].ts || 0));
  for (let i = 0; i < withText.length - MAX_TEXT_ENTRIES; i++) {
    delete files[withText[i]].text;
  }
}

// Records a Read in session memory and returns the note that should replace its
// output, or null to let the output through. Free plans are measured only.
function handleRead(data) {
  if (!data || data.tool_name !== "Read") return null;

  const filePath = data.tool_input?.file_path;
  if (!filePath) return null;

  const content = extractText(data.tool_response);
  if (!content) return null;

  // Key by file + range so partial reads of big files dedupe independently
  // and a chunked read never clobbers the full-read entry
  const offset = data.tool_input?.offset ?? 0;
  const limit = data.tool_input?.limit ?? "all";
  const key = `${filePath}@${offset}-${limit}`;

  const hash = lib.sha1(content);
  const session = lib.loadSession(data.session_id);
  const files = session.files || {};
  const prev = files[key];

  const mtime = lib.fileMtime(filePath);
  const read = readLines(data.tool_response, data.tool_input);
  // Whatever happens below, the model ends up holding these lines
  const remember = () => read && lib.rememberLines(session, filePath, mtime, read.start, read.lines);

  // 1) Exact repeat — identical content delivered earlier this session.
  if (hash && prev && prev.hash === hash) {
    const lineCount = content.split("\n").length;
    const tokensSaved = Math.max(0, lib.estimateTokens(content) - NOTE_TOKENS);

    session.hits = (session.hits || 0) + 1;
    session.tokensSaved = (session.tokensSaved || 0) + tokensSaved;
    session.date = lib.today();
    remember();
    lib.saveSession(data.session_id, session);
    lib.bumpStats({ hits: 1, tokensSaved });

    // Paid plans get the actual benefit; free plans are measured only.
    return paidOnly(`[Already in context, file unchanged since your last read. ${lineCount} lines. Refer to your earlier read for the content.]`);
  }

  // 2) Covered by earlier reads of other ranges (or shell reads) of the
  //    unchanged file: point back to them, sending only lines not yet seen.
  const cover = read && lib.buildCoverageNote(
    lib.seenLines(session, filePath, mtime), read.start, read.lines, "this file");
  if (cover) {
    session.hits = (session.hits || 0) + 1;
    session.tokensSaved = (session.tokensSaved || 0) + cover.savedTokens;
    session.date = lib.today();
    files[key] = { path: filePath, hash, mtime, ts: Date.now(), text: textToStore(content) };
    lib.evictOldest(files, MAX_FILE_ENTRIES);
    trimStoredText(files);
    session.files = files;
    remember();
    lib.saveSession(data.session_id, session);
    lib.bumpStats({ hits: 1, tokensSaved: cover.savedTokens });

    return paidOnly(cover.note);
  }

  // 3) Near repeat — same target, small change vs the earlier read (edit -> re-read).
  //    Serve a delta the model can apply to its earlier copy.
  if (prev && typeof prev.text === "string" && content.length >= DELTA_MIN_CHARS) {
    const delta = lib.buildLineDelta(prev.text, content, "read");
    if (delta) {
      session.hits = (session.hits || 0) + 1;
      session.tokensSaved = (session.tokensSaved || 0) + delta.savedTokens;
      session.date = lib.today();
      // Advance the stored copy to the current content for the next diff.
      files[key] = { path: filePath, hash, mtime, ts: Date.now(), text: textToStore(content) };
      trimStoredText(files);
      session.files = files;
      remember();
      lib.saveSession(data.session_id, session);
      lib.bumpStats({ hits: 1, tokensSaved: delta.savedTokens });

      return paidOnly(delta.note);
    }
  }

  // 4) First read of this range, or a change too large to delta — record it.
  files[key] = { path: filePath, hash, mtime, ts: Date.now(), text: textToStore(content) };
  lib.evictOldest(files, MAX_FILE_ENTRIES);
  trimStoredText(files);
  session.files = files;
  session.misses = (session.misses || 0) + 1;
  session.date = lib.today();
  remember();
  lib.saveSession(data.session_id, session);
  lib.bumpStats({ misses: 1 });
  return null;
}

function paidOnly(note) {
  return lib.currentPlanIsPaid() ? note : null;
}

// A file read from another agent (Copilot's view, Gemini's read_file), given
// as the path, the first line it asked for and the model-visible text. When the
// text is verifiably lines of the file on disk (once headers and line-number
// prefixes are set aside) it gets full line memory; otherwise it's matched
// only against byte-identical repeats of the same read.
function handleAgentRead({ sessionId, cwd, filePath, from = 1, text }) {
  if (!filePath || typeof text !== "string" || !text) return null;
  const shown = lib.fileLinesShown(filePath, from, text);
  const tool_response = shown
    ? { file: { content: shown.lines.join("\n"), startLine: shown.start, numLines: shown.lines.length } }
    : text;
  return handleRead({
    tool_name: "Read",
    session_id: sessionId,
    cwd,
    tool_input: { file_path: filePath, ...(from > 1 ? { offset: from } : {}) },
    tool_response,
  });
}

async function main() {
  const note = handleRead(await lib.readStdinJson());
  if (note) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: note },
    }));
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { handleRead, handleAgentRead };
