#!/usr/bin/env node
process.on("uncaughtException", (err) => { process.stderr.write("pg post_bash: " + err.message + "\n"); process.exit(0); });
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
  if (!command || !isReadOnly(command)) process.exit(0);

  const output = extractOutput(data.tool_response);
  if (!output || output.length < MIN_OUTPUT_CHARS || output.length > MAX_OUTPUT_BYTES) process.exit(0);

  const cwd = data.cwd || process.cwd();
  const normalized = command.trim().replace(/\s+/g, " ");
  const key = lib.sha1(cwd + "\x00" + normalized);
  const hash = lib.sha1(output);

  const session = lib.loadSession(data.session_id);
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
