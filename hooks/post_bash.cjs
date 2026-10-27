#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg post_bash: " + err.message + "\n"); process.exit(0); });
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./_lib.cjs");

const MAX_OUTPUT_BYTES = 512_000; // skip huge outputs (>512 KB)
const MIN_OUTPUT_CHARS = 200;     // below this the replacement note saves nothing
const MAX_BASH_ENTRIES = 300;
const NOTE_TOKENS = 15;

const READONLY_PREFIXES = [
  /^cat\s+/,
  /^ls(\s|$)/,
  /^find\s+/,
  /^grep(\s+|\s+-[a-zA-Z]+\s+)/,
  /^rg\s+/,
  /^ag\s+/,
  /^head(\s+|\s+-[a-zA-Z0-9]+\s+)/,
  /^tail(\s+|\s+-[a-zA-Z0-9]+\s+)/,
  /^wc(\s+|\s+-[a-zA-Z]+\s+)/,
  /^stat\s+/,
  /^file\s+/,
  /^which\s+/,
  /^type\s+/,
  /^pwd(\s|$)/,
  /^sort(\s+|\s+-[a-zA-Z]+\s+)/,
  /^uniq(\s+|\s+-[a-zA-Z]+\s+)/,
  /^du(\s+|\s+-[a-zA-Z]+\s+)/,
  /^df(\s|$)/,
  /^jq\s+/,
  /^git\s+(log|show|diff|status|branch|config|tag|stash list|remote|describe|rev-parse|shortlog|blame|ls-files)\b/,
  /^npm\s+(list|ls|view|info|outdated|audit)\b/,
  /^yarn\s+(list|info|why)\b/,
  /^node\s+(-v|--version)(\s|$)/,
  /^node\s+--version(\s|$)/,
  /^echo\s+/,
  /^printf\s+/,
  /^env(\s|$)/,
  /^printenv(\s|$)/,
];

const UNSAFE_PATTERNS = [
  /\s>>?\s/,
  />>?[./~]/,
  /\|\s*tee\s+\S/,
  /\bsed\s+-i\b/,
  /\bawk\s+-i\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash (push|pop|drop)|rm|mv|clean)\b/,
  /\bnpx\b/,
];

function isReadOnly(command) {
  if (command.includes("\n")) return false;
  const cmd = command.trim();
  if (!READONLY_PREFIXES.some((re) => re.test(cmd))) return false;
  return !UNSAFE_PATTERNS.some((re) => re.test(cmd));
}

// ── Shell reads of a file ────────────────────────────────────────────────────

// `cat FILE`, `sed -n 'A,Bp' FILE` and `head -n N FILE` are file reads by
// another name. Only the plain single-file forms count; anything piped,
// chained or globbed is left to the command-level dedup below.
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const FILE_ARG = String.raw`('[^']+'|"[^"$\`\\]+"|[^\s'"$\`;|&<>*?(){}\\]+)`;
const CAT_RE  = new RegExp(String.raw`^cat\s+${FILE_ARG}$`);
const SED_RE  = new RegExp(String.raw`^sed\s+-n\s+(['"]?)(\d+)(?:,(\d+))?p\1\s+${FILE_ARG}$`);
const HEAD_RE = new RegExp(String.raw`^head\s+(?:-n\s*(\d+)\s+|-(\d+)\s+)?${FILE_ARG}$`);

function resolveArg(arg, cwd) {
  const unquoted = /^['"]/.test(arg) ? arg.slice(1, -1) : arg;
  const home = process.env.HOME || os.homedir();
  const expanded = unquoted === "~" ? home : unquoted.replace(/^~\//, home + "/");
  return path.resolve(cwd, expanded);
}

// { filePath, from, to } (1-based, inclusive) for a plain file-read command, else null
function parseFileRead(command, cwd) {
  const cmd = command.trim();
  let m;
  if ((m = cmd.match(CAT_RE))) return { filePath: resolveArg(m[1], cwd), from: 1, to: Infinity };
  if ((m = cmd.match(SED_RE))) {
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    if (from < 1 || to < from) return null;
    return { filePath: resolveArg(m[4], cwd), from, to };
  }
  if ((m = cmd.match(HEAD_RE))) {
    const n = Number(m[1] ?? m[2] ?? 10);
    if (n < 1) return null;
    return { filePath: resolveArg(m[3], cwd), from: 1, to: n };
  }
  return null;
}

// The file lines the command printed, or null unless the output is exactly
// those lines of the file as it is on disk now (so line numbers are trustworthy)
function linesShown(fileRead, stdout) {
  let text;
  try {
    if (fs.statSync(fileRead.filePath).size > MAX_FILE_READ_BYTES) return null;
    text = fs.readFileSync(fileRead.filePath, "utf8");
  } catch { return null; }
  const all = text.split("\n");
  if (text.endsWith("\n")) all.pop();
  const lines = all.slice(fileRead.from - 1, Math.min(fileRead.to, all.length));
  if (!lines.length) return null;
  if (stdout.replace(/\n$/, "") !== lines.join("\n")) return null;
  return lines;
}

function stdoutOf(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse && typeof toolResponse.stdout === "string" && !toolResponse.stderr) return toolResponse.stdout;
  return null;
}

function extractOutput(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (!toolResponse || typeof toolResponse !== "object") return "";
  if (typeof toolResponse.stdout === "string") {
    return toolResponse.stdout + (toolResponse.stderr ? "\n" + toolResponse.stderr : "");
  }
  if (Array.isArray(toolResponse.content)) {
    return toolResponse.content.map((b) => b.text ?? "").join("");
  }
  return JSON.stringify(toolResponse);
}

async function main() {
  const data = await lib.readStdinJson();
  if (!data || data.tool_name !== "Bash") process.exit(0);

  const command = data.tool_input?.command;
  if (!command) process.exit(0);

  const cwd = data.cwd || process.cwd();
  const session = lib.loadSession(data.session_id);

  // A shell read of a file shares line memory with the Read tool, so reading
  // lines the model was already shown (by either) is a hit.
  const fileRead = parseFileRead(command, cwd);
  const stdout = fileRead && stdoutOf(data.tool_response);
  const lines = stdout != null && linesShown(fileRead, stdout);
  if (lines) {
    const mtime = lib.fileMtime(fileRead.filePath);
    const cover = lib.buildCoverageNote(
      lib.seenLines(session, fileRead.filePath, mtime), fileRead.from, lines,
      path.relative(cwd, fileRead.filePath) || fileRead.filePath);
    lib.rememberLines(session, fileRead.filePath, mtime, fileRead.from, lines);
    if (cover) {
      session.hits = (session.hits || 0) + 1;
      session.tokensSaved = (session.tokensSaved || 0) + cover.savedTokens;
      session.date = lib.today();
      lib.saveSession(data.session_id, session);
      lib.bumpStats({ hits: 1, tokensSaved: cover.savedTokens });
      if (lib.currentPlanIsPaid()) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            updatedToolOutput: cover.note,
          },
        }));
      }
      process.exit(0);
    }
    // Not seen before: the lines are remembered; carry on as a normal command.
  }

  const saveIfRemembered = () => { if (lines) lib.saveSession(data.session_id, session); };
  if (!isReadOnly(command)) { saveIfRemembered(); process.exit(0); }

  const output = extractOutput(data.tool_response);
  if (!output || output.length < MIN_OUTPUT_CHARS || output.length > MAX_OUTPUT_BYTES) {
    saveIfRemembered();
    process.exit(0);
  }

  const normalized = command.trim().replace(/\s+/g, " ");
  const key = lib.sha1(cwd + "\x00" + normalized);
  const hash = lib.sha1(output);

  const bash = session.bash || {};
  const prev = bash[key];

  if (hash && prev && prev.hash === hash) {
    // Same command, byte-identical output, earlier this session — the output
    // is already in context, so replace it with a brief note
    const lineCount = output.split("\n").length;
    const tokensSaved = Math.max(0, lib.estimateTokens(output) - NOTE_TOKENS);

    session.hits = (session.hits || 0) + 1;
    session.tokensSaved = (session.tokensSaved || 0) + tokensSaved;
    session.date = lib.today();
    lib.saveSession(data.session_id, session);
    lib.bumpStats({ hits: 1, tokensSaved });

    // Paid plans get the actual benefit: replace the repeated output with a
    // short note. Free plans are measured only and the output passes through.
    if (lib.currentPlanIsPaid()) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: `[Output unchanged since you ran this command earlier this session. ${lineCount} lines. Refer to the earlier output.]`,
        },
      }));
    }
    process.exit(0);
  }

  // First run, or output changed — record the hash only (never the output)
  bash[key] = { cmd: normalized.slice(0, 120), hash, ts: Date.now() };
  lib.evictOldest(bash, MAX_BASH_ENTRIES);
  session.bash = bash;
  session.misses = (session.misses || 0) + 1;
  session.date = lib.today();
  lib.saveSession(data.session_id, session);
  lib.bumpStats({ misses: 1 });

  process.exit(0);
}

main();
