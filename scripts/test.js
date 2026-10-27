#!/usr/bin/env node
/**
 * Hook health tests — run against the BUILT dist/hooks/ so we also catch
 * obfuscation bugs before anything ships.
 *
 * Each test sends a realistic stdin payload to the hook binary, checks the
 * exit code, and validates stdout/stderr where applicable.
 */

const { spawnSync } = require("child_process");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

const HOOKS_DIR = path.join(__dirname, "..", "dist", "hooks");

// ── Test auth keypair ───────────────────────────────────────────────────────
// The hooks verify the plan JWT against PG_PUBLIC_KEY (falling back to the
// baked-in key in production). We generate a throwaway keypair, point the hooks
// at our public key, and sign our own paid/free tokens so the paid-gating path
// is exercised with real signature verification.
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding:  { type: "spki",  format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.PG_PUBLIC_KEY = testPublicKey;
// Usage events are off for the hook tests; the "usage events" tests turn them on.
process.env.PROMPT_GENIE_TELEMETRY = "0";
delete process.env.DO_NOT_TRACK;

function makeToken(plan) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header  = b64({ alg: "RS256", typ: "JWT" });
  const payload = b64({ email: "test@example.com", plan, exp: Math.floor(Date.now() / 1000) + 3600 });
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(testPrivateKey, "base64url")}`;
}

// ── Isolated home dir ─────────────────────────────────────────────────────────

const tmpHome     = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
const claudeDir   = path.join(tmpHome, ".claude");
const sessionsDir = path.join(claudeDir, "pg_sessions");
fs.mkdirSync(claudeDir, { recursive: true });

// A real file on disk for file-read tests
const testFile    = path.join(tmpHome, "sample.ts");
const testContent = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
fs.writeFileSync(testFile, testContent);

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeClaudeFile(name, data) {
  fs.writeFileSync(
    path.join(claudeDir, name),
    typeof data === "string" ? data : JSON.stringify(data, null, 2)
  );
}

function writePaidConfig() {
  writeClaudeFile("pg_config.json", { email: "test@example.com", plan: "PRO", token: makeToken("PRO") });
}

function writeFreeConfig() {
  // No token => currentPlanIsPaid() is false => measure-only, no suppression.
  removeClaudeFile("pg_config.json");
}

function removeClaudeFile(name) {
  try { fs.unlinkSync(path.join(claudeDir, name)); } catch {}
}

function readSession(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir, `${sessionId}.json`), "utf8"));
  } catch { return null; }
}

function writeSession(sessionId, data) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(data));
}

function clearSessions() {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
}

function runHook(hookName, input) {
  const result = spawnSync("node", [path.join(HOOKS_DIR, hookName)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, HOME: tmpHome },
    timeout: 6000,
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? -1,
    stdout:   result.stdout || "",
    stderr:   result.stderr || "",
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function parseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function expectSuppression(r, label) {
  assert(!r.timedOut,         `${label}: timed out`);
  assert(r.exitCode === 0,    `${label}: exit ${r.exitCode}. stderr: ${r.stderr}`);
  assert(r.stdout.length > 0, `${label}: expected updatedToolOutput in stdout`);
  const out = parseJSON(r.stdout);
  assert(out !== null,        `${label}: stdout is not valid JSON: ${r.stdout.slice(0, 120)}`);
  assert(out.hookSpecificOutput?.hookEventName === "PostToolUse", `${label}: wrong hookEventName`);
  assert(typeof out.hookSpecificOutput?.updatedToolOutput === "string", `${label}: updatedToolOutput must be a string`);
  assert(out.hookSpecificOutput.updatedToolOutput.length > 0, `${label}: updatedToolOutput is empty`);
}

function expectPassThrough(r, label) {
  assert(!r.timedOut,      `${label}: timed out`);
  assert(r.exitCode === 0, `${label}: exit ${r.exitCode}. stderr: ${r.stderr}`);
  assert(r.stdout === "",  `${label}: should not modify output, got: ${r.stdout.slice(0, 120)}`);
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failures.push({ name, message: err.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SID = "sess-a";

const preReadEvent = (fp) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  session_id: SID,
  tool_input: { file_path: fp },
});

const postReadEvent = (fp, content, sessionId = SID, extraInput = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  session_id: sessionId,
  cwd: tmpHome,
  tool_input: { file_path: fp, ...extraInput },
  tool_response: {
    type: "text",
    file: {
      filePath: fp,
      content,
      numLines: content.split("\n").length,
      startLine: 1,
      totalLines: content.split("\n").length,
    },
  },
});

const preBashEvent = (cmd) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  session_id: SID,
  tool_input: { command: cmd },
});

const postBashEvent = (cmd, output, sessionId = SID) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  session_id: sessionId,
  cwd: tmpHome,
  tool_input: { command: cmd },
  tool_response: output,
});

// Long enough to clear post_bash's minimum-output threshold (200 chars)
const bigBashOutput = Array.from({ length: 30 }, (_, i) => `file${i}.txt`).join("\n") + "\n";

// ── pre_read tests ────────────────────────────────────────────────────────────

console.log("\n  pre_read");

test("exits 0 on malformed JSON", () => {
  const r = runHook("pre_read.cjs", "{{not json}}");
  assert(!r.timedOut,       "timed out");
  assert(r.exitCode === 0,  `exit ${r.exitCode}`);
});

test("exits 0 on valid PreToolUse Read", () => {
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(!r.timedOut,       "timed out");
  assert(r.exitCode === 0,  `exit ${r.exitCode}`);
});

test("never writes to stdout", () => {
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(r.stdout === "",   `unexpected stdout: ${r.stdout.slice(0, 80)}`);
});

test("never exits 2 (must not block reads)", () => {
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(r.exitCode !== 2,  "hook exited 2 — would block the Read tool");
});

// ── pre_bash tests ────────────────────────────────────────────────────────────

console.log("\n  pre_bash");

test("exits 0 on malformed JSON", () => {
  const r = runHook("pre_bash.cjs", "garbage");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("exits 0 on valid PreToolUse Bash", () => {
  const r = runHook("pre_bash.cjs", preBashEvent("ls -la"));
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("never exits 2 (must not block Bash commands)", () => {
  const r = runHook("pre_bash.cjs", preBashEvent("git log --oneline -10"));
  assert(r.exitCode !== 2, "hook exited 2 — would block the Bash tool");
});

// ── post_read tests ───────────────────────────────────────────────────────────

// Default to a paid plan so the suppression mechanics are exercised. Individual
// tests below switch to a free config to verify gating.
writePaidConfig();

console.log("\n  post_read");

test("exits 0 on malformed JSON", () => {
  const r = runHook("post_read.cjs", "{{bad}}");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("exits 0 on non-Read tool event", () => {
  const r = runHook("post_read.cjs", { tool_name: "Bash", session_id: SID, tool_input: {}, tool_response: "output" });
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
  assert(r.stdout === "",  "should produce no output");
});

test("first read: passes through and populates session state", () => {
  clearSessions();
  const r = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectPassThrough(r, "first read");

  const session = readSession(SID);
  assert(session,                "session file missing");
  assert(session.files,          "session.files missing");
  const entry = Object.values(session.files).find((e) => e.path === testFile);
  assert(entry,                  "testFile missing from session.files");
  assert(entry.hash,             "entry missing hash");
  assert(!("content" in entry),  "entry must not store file content");
  assert(session.misses === 1,   `expected 1 miss, got ${session.misses}`);
});

test("repeated read (same content): outputs valid updatedToolOutput JSON", () => {
  const r = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectSuppression(r, "repeat read");

  const session = readSession(SID);
  assert(session.hits === 1,        `expected 1 hit, got ${session.hits}`);
  assert(session.tokensSaved >= 0,  "tokensSaved missing");
});

test("free plan: repeat read is measured but NOT suppressed", () => {
  writeFreeConfig();
  clearSessions();
  const first = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectPassThrough(first, "free first read");

  const repeat = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectPassThrough(repeat, "free repeat read must not be suppressed");

  const session = readSession(SID);
  assert(session.hits === 1,       `free repeat should still record a hit, got ${session.hits}`);
  assert(session.tokensSaved > 0,  "free plan must still record would-be tokensSaved for the upgrade prompt");

  writePaidConfig(); // restore for subsequent tests
});

test("repeated read (changed content): passes through", () => {
  const changedContent = "// completely rewritten\nexport const x = 42;\n";
  const r = runHook("post_read.cjs", postReadEvent(testFile, changedContent));
  expectPassThrough(r, "changed read");
});

test("session isolation: same read in a different session passes through", () => {
  clearSessions();
  const first = runHook("post_read.cjs", postReadEvent(testFile, testContent, "sess-a"));
  expectPassThrough(first, "sess-a first read");

  const other = runHook("post_read.cjs", postReadEvent(testFile, testContent, "sess-b"));
  expectPassThrough(other, "sess-b must not be suppressed by sess-a's read");
});

test("range keys: partial read does not clobber full read", () => {
  clearSessions();
  const full = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectPassThrough(full, "full read");

  // Partial read of the same file — different range, passes through
  const partial = runHook("post_read.cjs", postReadEvent(testFile, "export function add", SID, { offset: 1, limit: 1 }));
  expectPassThrough(partial, "first partial read");

  // Repeat of the same partial range — suppressed
  const partialAgain = runHook("post_read.cjs", postReadEvent(testFile, "export function add", SID, { offset: 1, limit: 1 }));
  expectSuppression(partialAgain, "repeat partial read");

  // Repeat of the full read — its entry must still be intact
  const fullAgain = runHook("post_read.cjs", postReadEvent(testFile, testContent));
  expectSuppression(fullAgain, "repeat full read");
});

test("handles old-format tool_response (plain string)", () => {
  clearSessions();
  const r = runHook("post_read.cjs", {
    tool_name: "Read",
    session_id: SID,
    tool_input: { file_path: testFile },
    tool_response: testContent,
  });
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
});

test("state files are valid JSON after a run (atomic writes, no tmp leftovers)", () => {
  const session = readSession(SID);
  assert(session !== null, "session file is not valid JSON");
  const stats = parseJSON(fs.readFileSync(path.join(claudeDir, "pg_stats.json"), "utf8"));
  assert(stats !== null,   "stats file is not valid JSON");
  const leftovers = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"));
  assert(leftovers.length === 0, `tmp files left behind: ${leftovers.join(", ")}`);
});

// ── post_read delta tests (edit -> re-read) ─────────────────────────────────────

console.log("\n  post_read delta");

// A large file (well over DELTA_MIN_CHARS) so the delta path is eligible.
const bigLines = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i}; // value ${i}`);
const bigFile = bigLines.join("\n") + "\n";
const editedFile = bigLines.map((l, i) => (i === 150 ? `const line150 = 999; // CHANGED` : l)).join("\n") + "\n";

// An edit always moves the file's mtime; without it, line memory would answer first.
let editClock = Date.now();
function simulateEdit(fp) {
  editClock += 5000;
  fs.utimesSync(fp, new Date(editClock), new Date(editClock));
}

test("first large read stores text for diffing", () => {
  clearSessions();
  const r = runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  expectPassThrough(r, "first large read");
  const entry = Object.values(readSession(SID).files).find((e) => e.path === testFile);
  assert(entry && typeof entry.text === "string", "large read should retain text for delta");
});

test("re-read after a small edit: serves a delta, not the whole file", () => {
  simulateEdit(testFile);
  const r = runHook("post_read.cjs", postReadEvent(testFile, editedFile));
  expectSuppression(r, "edited re-read");
  const out = parseJSON(r.stdout);
  const note = out.hookSpecificOutput.updatedToolOutput;
  assert(/Prompt Genie delta/.test(note), "expected a delta note");
  assert(note.includes("line150 = 999"), "delta must contain the changed line");
  assert(note.length < editedFile.length / 2, "delta must be much smaller than the full file");

  const session = readSession(SID);
  assert(session.hits >= 1, "delta should record a hit");
  assert(session.tokensSaved > 0, "delta should record tokens saved");
});

test("delta advances the stored copy (second small edit also deltas)", () => {
  const edited2 = bigLines.map((l, i) => (i === 150 ? `const line150 = 12345; // CHANGED AGAIN` : l)).join("\n") + "\n";
  simulateEdit(testFile);
  const r = runHook("post_read.cjs", postReadEvent(testFile, edited2));
  expectSuppression(r, "second edited re-read");
  assert(parseJSON(r.stdout).hookSpecificOutput.updatedToolOutput.includes("12345"), "second delta must reflect newest change");
});

test("wholesale rewrite is too big to delta: passes through", () => {
  clearSessions();
  runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  const rewritten = Array.from({ length: 300 }, (_, i) => `totally different content row ${i} ${"x".repeat(20)}`).join("\n") + "\n";
  simulateEdit(testFile);
  const r = runHook("post_read.cjs", postReadEvent(testFile, rewritten));
  expectPassThrough(r, "wholesale rewrite");
  assert(readSession(SID).misses >= 1, "wholesale change should count as a miss");
});

test("free plan: delta is measured but NOT served", () => {
  writeFreeConfig();
  clearSessions();
  runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  simulateEdit(testFile);
  const r = runHook("post_read.cjs", postReadEvent(testFile, editedFile));
  expectPassThrough(r, "free delta must not be served");
  const session = readSession(SID);
  assert(session.hits >= 1 && session.tokensSaved > 0, "free plan must still measure the delta saving");
  writePaidConfig(); // restore
});

// ── line memory (range reads and shell reads) ───────────────────────────────────

console.log("\n  line memory");

const lmFile  = path.join(tmpHome, "lines.ts");
const lmLines = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i} * 2; // line ${i + 1}`);
fs.writeFileSync(lmFile, lmLines.join("\n") + "\n");

// A Read of lines from..to (1-based, inclusive), shaped like Claude Code's response
const rangeReadEvent = (fp, lines, from, to, sessionId = SID) => {
  const slice = lines.slice(from - 1, to);
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    session_id: sessionId,
    cwd: tmpHome,
    tool_input: from === 1 && to === lines.length
      ? { file_path: fp }
      : { file_path: fp, offset: from, limit: to - from + 1 },
    tool_response: {
      type: "text",
      file: { filePath: fp, content: slice.join("\n"), numLines: slice.length, startLine: from, totalLines: lines.length },
    },
  };
};
const shownLines = (from, to) => lmLines.slice(from - 1, to).join("\n") + "\n";
const noteOf = (r) => parseJSON(r.stdout)?.hookSpecificOutput?.updatedToolOutput || "";

test("sub-range read after a full read is served from line memory", () => {
  writePaidConfig();
  clearSessions();
  expectPassThrough(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 300)), "full read");
  const r = runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 50, 150));
  expectSuppression(r, "sub-range read");
  assert(noteOf(r).includes("lines 50-150"), `note should name the range: ${noteOf(r).slice(0, 120)}`);
  const session = readSession(SID);
  assert(session.hits === 1 && session.tokensSaved > 0, "coverage hit not counted");
});

test("growing a range sends only the lines not yet seen", () => {
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 100));
  const r = runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 200));
  expectSuppression(r, "grown range");
  const note = noteOf(r);
  assert(note.includes("Lines 1-100"), "note should say which lines are already known");
  assert(note.includes(`101\t${lmLines[100]}`), "unseen line 101 must be included, numbered");
  assert(note.includes(`200\t${lmLines[199]}`), "unseen line 200 must be included");
  assert(!note.includes(lmLines[10]), "already-seen line 11 must not be resent");
});

test("a mostly unseen range passes through whole", () => {
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 50));
  expectPassThrough(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 200)), "mostly new range");
});

test("file changed on disk: earlier lines are not trusted", () => {
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 300));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(lmFile, later, later);
  expectPassThrough(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 50, 150)), "range after edit");
});

test("sed -n after a Read is served from line memory", () => {
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 300));
  const r = runHook("post_bash.cjs", postBashEvent(`sed -n '20,120p' ${lmFile}`, shownLines(20, 120)));
  expectSuppression(r, "sed after Read");
  assert(noteOf(r).includes("lines 20-120"), `note should name the range: ${noteOf(r).slice(0, 120)}`);
});

test("Read after cat is served from line memory", () => {
  clearSessions();
  expectPassThrough(runHook("post_bash.cjs", postBashEvent(`cat "${lmFile}"`, shownLines(1, 300))), "first cat");
  expectSuppression(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 10, 200)), "Read after cat");
});

test("head -n then a repeat head is served from line memory", () => {
  clearSessions();
  runHook("post_bash.cjs", postBashEvent(`head -n 80 lines.ts`, shownLines(1, 80)));
  expectSuppression(runHook("post_bash.cjs", postBashEvent(`head -80 lines.ts`, shownLines(1, 80))), "repeat head");
});

test("shell output that doesn't match the file is not a file read", () => {
  clearSessions();
  runHook("post_bash.cjs", postBashEvent(`cat ${lmFile}`, "not the file\n" + bigBashOutput));
  const session = readSession(SID);
  assert(!session?.lines || Object.keys(session.lines).length === 0, "mismatched output must not be remembered");
});

test("piped or chained commands are not file reads", () => {
  clearSessions();
  runHook("post_bash.cjs", postBashEvent(`cat ${lmFile} | head -n 300`, shownLines(1, 300)));
  runHook("post_bash.cjs", postBashEvent(`sed -n '1,300p' ${lmFile}; echo done`, shownLines(1, 300)));
  const session = readSession(SID);
  assert(!session?.lines || Object.keys(session.lines).length === 0, "compound commands must not be remembered");
});

test("free plan: line-memory hit is measured but NOT served", () => {
  writeFreeConfig();
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 300));
  expectPassThrough(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 50, 150)), "free sub-range");
  assert(readSession(SID).hits === 1, "free coverage hit should still be counted");
  writePaidConfig();
});

test("compact clears line memory", () => {
  clearSessions();
  runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 1, 300));
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "compact" });
  expectPassThrough(runHook("post_read.cjs", rangeReadEvent(lmFile, lmLines, 50, 150)), "range after compact");
});

// ── post_bash tests ───────────────────────────────────────────────────────────

console.log("\n  post_bash");

test("exits 0 on malformed JSON", () => {
  const r = runHook("post_bash.cjs", "bad input");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("first read-only command: passes through and records hash", () => {
  clearSessions();
  const r = runHook("post_bash.cjs", postBashEvent("ls -la", bigBashOutput));
  expectPassThrough(r, "first bash run");

  const session = readSession(SID);
  assert(session?.bash,    "session.bash missing");
  const entry = Object.values(session.bash)[0];
  assert(entry?.hash,      "bash entry missing hash");
  assert(!("output" in entry), "bash entry must not store the output");
});

test("repeat command with identical output: suppressed via updatedToolOutput", () => {
  const r = runHook("post_bash.cjs", postBashEvent("ls -la", bigBashOutput));
  expectSuppression(r, "repeat bash run");

  const session = readSession(SID);
  assert(session.hits >= 1, `expected a hit, got ${session.hits}`);
});

test("free plan: repeat command is measured but NOT suppressed", () => {
  writeFreeConfig();
  clearSessions();
  const first = runHook("post_bash.cjs", postBashEvent("ls -la", bigBashOutput));
  expectPassThrough(first, "free first bash run");

  const repeat = runHook("post_bash.cjs", postBashEvent("ls -la", bigBashOutput));
  expectPassThrough(repeat, "free repeat bash run must not be suppressed");

  const session = readSession(SID);
  assert(session.hits >= 1, `free repeat should still record a hit, got ${session.hits}`);

  writePaidConfig(); // restore for subsequent tests
});

test("repeat command with changed output: passes through", () => {
  const r = runHook("post_bash.cjs", postBashEvent("ls -la", bigBashOutput + "new-file.txt\n"));
  expectPassThrough(r, "changed bash output");
});

test("small outputs are never suppressed", () => {
  clearSessions();
  runHook("post_bash.cjs", postBashEvent("pwd", "/tmp/short"));
  const r = runHook("post_bash.cjs", postBashEvent("pwd", "/tmp/short"));
  expectPassThrough(r, "small output repeat");
});

test("write command is never cached or suppressed", () => {
  clearSessions();
  runHook("post_bash.cjs", postBashEvent("rm -rf /tmp/test", bigBashOutput));
  const r = runHook("post_bash.cjs", postBashEvent("rm -rf /tmp/test", bigBashOutput));
  expectPassThrough(r, "write command repeat");
  const session = readSession(SID);
  assert(!session || !session.bash || Object.keys(session.bash).length === 0, "write command must not be cached");
});

test("handles new-format tool_response ({stdout, stderr})", () => {
  clearSessions();
  const first = runHook("post_bash.cjs", postBashEvent("ls -la", { stdout: bigBashOutput, stderr: "" }));
  expectPassThrough(first, "first stdout-format run");
  const again = runHook("post_bash.cjs", postBashEvent("ls -la", { stdout: bigBashOutput, stderr: "" }));
  expectSuppression(again, "repeat stdout-format run");
});

// ── user_prompt_submit tests ──────────────────────────────────────────────────

console.log("\n  user_prompt_submit");

const promptEvent = (cwd = tmpHome) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: SID,
  prompt: "can you look at the code",
  cwd,
});

test("exits 0 with no config file", () => {
  removeClaudeFile("pg_config.json");
  const r = runHook("user_prompt_submit.cjs", promptEvent());
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
  assert(r.stdout === "",  "no config means no output");
});

test("exits 0 with empty session (no files)", () => {
  clearSessions();
  const r = runHook("user_prompt_submit.cjs", promptEvent());
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
  assert(r.stdout === "",  "empty session means no context hint");
});

test("does not hang on malformed JSON", () => {
  const r = runHook("user_prompt_submit.cjs", "{{bad}}");
  assert(!r.timedOut,      "hook timed out — possible hang");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

// ── session_start tests ───────────────────────────────────────────────────────

console.log("\n  session_start");

const sessionStartEvent = (source) => ({
  hook_event_name: "SessionStart",
  session_id: SID,
  source,
});

const populatedSession = () => ({
  hits: 2, misses: 3, tokensSaved: 1000,
  files: { [`${testFile}@0-all`]: { path: testFile, hash: "abc", mtime: 1, ts: Date.now() } },
  bash:  { deadbeef: { cmd: "ls -la", hash: "def", ts: Date.now() } },
  hintedCount: 1,
});

test("compact clears file/bash maps but keeps tallies", () => {
  clearSessions();
  writeSession(SID, populatedSession());
  const r = runHook("session_start.cjs", sessionStartEvent("compact"));
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);

  const session = readSession(SID);
  assert(Object.keys(session.files).length === 0, "files map not cleared after compact");
  assert(Object.keys(session.bash).length === 0,  "bash map not cleared after compact");
  assert(session.hintedCount === 0,               "hintedCount not reset after compact");
  assert(session.hits === 2 && session.misses === 3, "hit/miss tallies must survive compact");
});

test("clear wipes the dedup maps too", () => {
  writeSession(SID, populatedSession());
  runHook("session_start.cjs", sessionStartEvent("clear"));
  const session = readSession(SID);
  assert(Object.keys(session.files).length === 0, "files map not cleared after clear");
});

test("resume/startup leave state alone", () => {
  writeSession(SID, populatedSession());
  runHook("session_start.cjs", sessionStartEvent("resume"));
  runHook("session_start.cjs", sessionStartEvent("startup"));
  const session = readSession(SID);
  assert(Object.keys(session.files).length === 1, "resume/startup must not clear state");
});

test("exits 0 on malformed JSON", () => {
  const r = runHook("session_start.cjs", "{{bad}}");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

// ── stop_flush tests ──────────────────────────────────────────────────────────

console.log("\n  stop_flush");

test("exits 0 immediately with empty session (no network call)", () => {
  clearSessions();
  removeClaudeFile("pg_config.json");
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(!r.timedOut,      "timed out — possible hang");
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
});

test("exits 0 with hits/misses but no token (skips network)", () => {
  writeSession(SID, { hits: 5, misses: 10, tokensSaved: 5000 });
  removeClaudeFile("pg_config.json");
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("removes legacy pre-0.4 global cache files", () => {
  writeClaudeFile("pg_session.json", {});
  writeClaudeFile("pg_read_cache.json", {});
  writeClaudeFile("pg_bash_cache.json", {});
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  for (const legacy of ["pg_session.json", "pg_read_cache.json", "pg_bash_cache.json"]) {
    assert(!fs.existsSync(path.join(claudeDir, legacy)), `${legacy} should have been removed`);
  }
});

test("garbage-collects week-old session files", () => {
  clearSessions();
  writeSession("ancient", { hits: 1 });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(sessionsDir, "ancient.json"), old, old);
  writeSession("fresh", { hits: 1 });

  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: "other" });
  assert(!fs.existsSync(path.join(sessionsDir, "ancient.json")), "old session file should be GC'd");
  assert(fs.existsSync(path.join(sessionsDir, "fresh.json")),    "fresh session file must survive GC");
});

// ── Upload tests (against a local fake backend) ───────────────────────────────

console.log("\n  stop_flush uploads");

// A tiny GraphQL stand-in in a separate process (the tests run hooks with
// spawnSync, which blocks this process). It logs every request body and answers
// with response.json when present.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-fake-api-"));
const fakeServer = require("child_process").spawn(process.execPath, ["-e", `
  const http = require("http"), fs = require("fs"), dir = process.argv[1];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fs.appendFileSync(dir + "/requests.log", body + "\\n");
      let resp = { data: { recordTokenSavings: JSON.stringify({ success: true, recorded: 1, duplicates: 0 }) } };
      try { resp = JSON.parse(fs.readFileSync(dir + "/response.json", "utf8")); } catch {}
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(resp));
    });
  });
  srv.listen(0, "127.0.0.1", () => fs.writeFileSync(dir + "/port", String(srv.address().port)));
`, fakeDir], { stdio: "ignore" });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 100 && !fs.existsSync(path.join(fakeDir, "port")); i++) sleep(50);
const fakeUrl = `http://127.0.0.1:${fs.readFileSync(path.join(fakeDir, "port"), "utf8")}/graphql`;

function useFakeApi(url = fakeUrl) {
  process.env.PG_GRAPHQL_URL = url;
}
function fakeRequests() {
  try {
    return fs.readFileSync(path.join(fakeDir, "requests.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function resetFake(response) {
  removeFile(path.join(fakeDir, "requests.log"));
  removeFile(path.join(fakeDir, "response.json"));
  if (response) fs.writeFileSync(path.join(fakeDir, "response.json"), JSON.stringify(response));
}
function removeFile(f) { try { fs.unlinkSync(f); } catch {} }
const serverSays = (result) => ({ data: { recordTokenSavings: JSON.stringify(result) } });

const sessionWithSavings = () => ({
  hits: 4,
  misses: 6,
  tokensSaved: 9000,
  date: new Date().toISOString().slice(0, 10),
  files: { [`${testFile}@0-all`]: { path: testFile, hash: "abc", ts: Date.now() } },
});

test("paid: uploads the turn's savings with the signed token and no email", () => {
  useFakeApi();
  resetFake();
  clearSessions();
  writePaidConfig();
  writeSession(SID, sessionWithSavings());
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID, cwd: "/work/shop-api" });
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
  const reqs = fakeRequests();
  assert(reqs.length === 1, `expected 1 request, got ${reqs.length}`);
  assert(/recordTokenSavings/.test(reqs[0].query), "should call recordTokenSavings");
  const savedToken = JSON.parse(fs.readFileSync(path.join(claudeDir, "pg_config.json"), "utf8")).token;
  assert(reqs[0].variables.token === savedToken, "sends the signed CLI token");
  const entries = JSON.parse(reqs[0].variables.entries);
  assert(entries.length === 1, "one entry");
  const e = entries[0];
  assert(e.source === "CLAUDE_CODE" && e.feature === "CONTEXT_MEMORY", "source/feature");
  assert(e.hits === 4 && e.misses === 6 && e.tokensSaved === 9000, "counts");
  assert(e.codebase === "shop-api", `codebase ${e.codebase}`);
  assert(/^cc-[0-9a-f-]{36}$/.test(e.id), `id ${e.id}`);
  assert(!("email" in e) && !JSON.stringify(reqs[0].variables).includes("test@example.com"), "no email in the request");
});

test("paid: counters reset after upload but the read memory survives (re-reads keep hitting)", () => {
  const s = readSession(SID);
  assert(s && s.hits === 0 && s.misses === 0 && s.tokensSaved === 0, "counters reset");
  assert(Object.keys(s.files || {}).length === 1, "files map must survive the Stop hook");
  assert((s.pendingUploads || []).length === 0, "nothing left pending");
});

test("paid: offline keeps the upload pending and retries it with the same id", () => {
  useFakeApi("http://127.0.0.1:1/graphql"); // nothing listens on port 1
  clearSessions();
  writePaidConfig();
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID, cwd: "/work/app" });
  const pending = readSession(SID).pendingUploads || [];
  assert(pending.length === 1, `expected 1 pending, got ${pending.length}`);
  const id = pending[0].id;

  useFakeApi();
  resetFake();
  const s = readSession(SID);
  s.hits = 1; s.misses = 1; s.tokensSaved = 50;
  writeSession(SID, s);
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID, cwd: "/work/app" });
  const entries = JSON.parse(fakeRequests()[0].variables.entries);
  assert(entries.length === 2, `expected retry + new entry, got ${entries.length}`);
  assert(entries[0].id === id && entries[0].tokensSaved === 9000, "retry reuses the original id and numbers");
  assert(entries[1].tokensSaved === 50, "new savings sent as their own entry");
  assert((readSession(SID).pendingUploads || []).length === 0, "cleared after success");
});

test("paid: a temporary server error keeps the upload for retry", () => {
  useFakeApi();
  resetFake(serverSays({ success: false, error: "Write failed" }));
  clearSessions();
  writePaidConfig();
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert((readSession(SID).pendingUploads || []).length === 1, "kept for retry");
});

test("paid: a rejected batch is dropped instead of retried forever", () => {
  useFakeApi();
  resetFake(serverSays({ success: false, error: "Entry 0: invalid tokensSaved" }));
  clearSessions();
  writePaidConfig();
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert((readSession(SID).pendingUploads || []).length === 0, "dropped");
});

test("paid: uploads stuck offline for weeks are dropped (server would reject the old date)", () => {
  useFakeApi();
  resetFake();
  clearSessions();
  writePaidConfig();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  writeSession(SID, { hits: 0, misses: 0, tokensSaved: 0, pendingUploads: [{ id: "cc-old-upload-0001", date: old, source: "CLAUDE_CODE", feature: "CONTEXT_MEMORY", hits: 1, misses: 1, tokensSaved: 10 }] });
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(fakeRequests().length === 0, "nothing worth sending");
  assert((readSession(SID).pendingUploads || []).length === 0, "stale upload dropped");
});

test("free: never uploads, resets counters, keeps the read memory", () => {
  useFakeApi();
  resetFake();
  clearSessions();
  writeClaudeFile("pg_config.json", { email: "test@example.com", plan: "FREE", token: makeToken("FREE") });
  writeSession(SID, sessionWithSavings());
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(fakeRequests().length === 0, "free plan must not upload");
  assert(/Context Memory paused/.test(r.stderr), "shows what it would have saved");
  const s = readSession(SID);
  assert(s.tokensSaved === 0 && Object.keys(s.files || {}).length === 1, "counters reset, memory kept");
});

// ── Usage events ──────────────────────────────────────────────────────────────

console.log("\n  usage events");

const eventsFile = path.join(claudeDir, "pg_events.json");
const queued = () => { try { return JSON.parse(fs.readFileSync(eventsFile, "utf8")).events || []; } catch { return []; } };
const bothOk = {
  data: {
    recordTokenSavings: JSON.stringify({ success: true, recorded: 1, duplicates: 0 }),
    trackProductEvents: JSON.stringify({ success: true, accepted: 2, dropped: 0 }),
  },
};
const trackRequests = () => fakeRequests().filter((r) => /trackProductEvents/.test(r.query));

test("opted out (PROMPT_GENIE_TELEMETRY=0): nothing is queued", () => {
  removeFile(eventsFile);
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "startup" });
  assert(!fs.existsSync(eventsFile), "no queue file when opted out");
});

process.env.PROMPT_GENIE_TELEMETRY = "1";

test("session start queues cli_session_started; compact does not", () => {
  removeFile(eventsFile);
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "startup" });
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "compact" });
  const q = queued();
  assert(q.length === 1, `expected 1 event, got ${q.length}`);
  assert(q[0].event === "cli_session_started" && q[0].properties.source === "startup", "event and source");
  assert(/^cli-[0-9a-f-]{36}$/.test(q[0].id), `id ${q[0].id}`);
  assert(/^\d+\.\d+\.\d+/.test(q[0].properties.client_version), "carries the client version");
});

test("DO_NOT_TRACK=1 also opts out", () => {
  removeFile(eventsFile);
  process.env.DO_NOT_TRACK = "1";
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "startup" });
  delete process.env.DO_NOT_TRACK;
  assert(queued().length === 0, "nothing queued");
});

test("paid: Stop sends queued events with the token and clears the queue", () => {
  useFakeApi();
  resetFake(bothOk);
  clearSessions();
  writePaidConfig();
  removeFile(eventsFile);
  runHook("session_start.cjs", { hook_event_name: "SessionStart", session_id: SID, source: "startup" });
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID, cwd: "/work/shop-api" });
  const reqs = trackRequests();
  assert(reqs.length === 1, `expected 1 trackProductEvents request, got ${reqs.length}`);
  const savedToken = JSON.parse(fs.readFileSync(path.join(claudeDir, "pg_config.json"), "utf8")).token;
  assert(reqs[0].variables.token === savedToken, "sends the signed CLI token");
  const events = JSON.parse(reqs[0].variables.events);
  assert(events.map((e) => e.event).join(",") === "cli_session_started,cli_savings_recorded", `events ${events.map((e) => e.event)}`);
  assert(events[1].properties.tokens_saved === 9000 && events[1].properties.hits === 4, "savings counts");
  const raw = JSON.stringify(reqs[0].variables);
  assert(!raw.includes("shop-api") && !raw.includes(testFile) && !raw.includes("test@example.com"), "no codebase, paths or email");
  assert(queued().length === 0, "queue cleared after success");
});

test("events are kept when the backend doesn't have trackProductEvents yet", () => {
  useFakeApi();
  resetFake({ data: { recordTokenSavings: JSON.stringify({ success: true, recorded: 1, duplicates: 0 }) }, errors: [{ message: "FieldUndefined" }] });
  clearSessions();
  writePaidConfig();
  removeFile(eventsFile);
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(trackRequests().length === 1, "tried once");
  assert(queued().length === 1, "kept for a retry");
});

test("free: fresh events wait to be batched, then go out", () => {
  useFakeApi();
  resetFake(bothOk);
  clearSessions();
  writeClaudeFile("pg_config.json", { email: "test@example.com", plan: "FREE", token: makeToken("FREE") });
  removeFile(eventsFile);
  writeSession(SID, sessionWithSavings());
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(fakeRequests().length === 0, "no request for a fresh queue");
  const q = queued();
  assert(q.length === 1 && q[0].event === "cli_free_savings_shown" && q[0].properties.tokens_saved === 9000, "would-have-saved event queued");

  const aged = q.map((e) => ({ ...e, timestamp: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  writeClaudeFile("pg_events.json", { events: aged });
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(trackRequests().length === 1, "sent once the queue is old enough");
  assert(fakeRequests().every((r) => !/recordTokenSavings/.test(r.query)), "free plan still never uploads savings");
  assert(queued().length === 0, "queue cleared");
});

test("events older than the server accepts are dropped locally", () => {
  removeFile(eventsFile);
  writeClaudeFile("pg_events.json", { events: [{ id: "cli-old-event-01", event: "cli_signed_in", timestamp: new Date(Date.now() - 8 * 86_400_000).toISOString(), properties: {} }] });
  useFakeApi();
  resetFake(bothOk);
  clearSessions();
  writePaidConfig();
  runHook("stop_flush.cjs", { hook_event_name: "Stop", session_id: SID });
  assert(trackRequests().length === 0, "nothing worth sending");
});

process.env.PROMPT_GENIE_TELEMETRY = "0";

fakeServer.kill();
delete process.env.PG_GRAPHQL_URL;
fs.rmSync(fakeDir, { recursive: true, force: true });

// ── Installer: hooks are merged, not overwritten ──────────────────────────────

console.log("\n  install");

test("keeps the user's own hooks and replaces only ours, idempotently", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-install-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    model: "opus",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "my-linter --check" }] },
        { matcher: "Read", hooks: [{ type: "command", command: `node "${home}/.prompt-genie/hooks/pre_read.cjs"` }] },
      ],
      Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  }));
  const run = () => spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "bin", "install.cjs"))}).wireHooks()`], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  const r1 = run();
  assert(r1.status === 0, `install exited ${r1.status}: ${r1.stderr}`);
  run(); // reinstall must not duplicate
  const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const commands = (event) => (s.hooks[event] || []).flatMap((g) => g.hooks.map((h) => h.command));
  assert(s.model === "opus", "other settings untouched");
  assert(commands("PreToolUse").includes("my-linter --check"), "user's PreToolUse hook kept");
  assert(commands("Notification").includes("say done"), "user's other events kept");
  assert(commands("PreToolUse").filter((c) => c.includes("pre_read.cjs")).length === 1, "our pre_read hook present exactly once");
  assert(commands("Stop").filter((c) => c.includes("stop_flush.cjs")).length === 1, "our Stop hook present exactly once");
  fs.rmSync(home, { recursive: true, force: true });
});

test("install queues cli_signed_in and cli_installed for the first Stop", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-install-"));
  const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "bin", "install.cjs"))}).finishInstall("a@b.co", "PRO", "tok", { signedIn: true })`], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PROMPT_GENIE_TELEMETRY: "1" },
    encoding: "utf8",
  });
  assert(r.status === 0, `install exited ${r.status}: ${r.stderr}`);
  const events = JSON.parse(fs.readFileSync(path.join(home, ".claude", "pg_events.json"), "utf8")).events;
  assert(events.map((e) => e.event).join(",") === "cli_signed_in,cli_installed", `events ${events.map((e) => e.event)}`);
  assert(events[1].properties.reinstall === "no" && events[1].properties.agent === "claude_code", "install properties");
  fs.rmSync(home, { recursive: true, force: true });
});

test("install keeps a telemetry opt-out in pg_config.json and queues nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-install-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "pg_config.json"), JSON.stringify({ telemetry: false }));
  spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "bin", "install.cjs"))}).finishInstall("a@b.co", "PRO", "tok")`], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PROMPT_GENIE_TELEMETRY: "1" },
    encoding: "utf8",
  });
  assert(JSON.parse(fs.readFileSync(path.join(home, ".claude", "pg_config.json"), "utf8")).telemetry === false, "opt-out kept");
  assert(!fs.existsSync(path.join(home, ".claude", "pg_events.json")), "nothing queued");
  fs.rmSync(home, { recursive: true, force: true });
});

// ── Self-update ───────────────────────────────────────────────────────────────

console.log("\n  self update");

// Minimal ustar writer, the format npm publishes.
function makeTar(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("0", 156);
    h.write("ustar\0", 257); h.write("00", 263);
    h.fill(" ", 148, 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const regDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-registry-"));
const registry = require("child_process").spawn(process.execPath, ["-e", `
  const http = require("http"), fs = require("fs"), dir = process.argv[1];
  const srv = http.createServer((req, res) => {
    fs.appendFileSync(dir + "/requests.log", req.url + "\\n");
    const file = req.url === "/prompt-genie/latest" ? "latest.json" : req.url.slice(1);
    try { res.end(fs.readFileSync(dir + "/" + file)); } catch { res.statusCode = 404; res.end(); }
  });
  srv.listen(0, "127.0.0.1", () => fs.writeFileSync(dir + "/port", String(srv.address().port)));
`, regDir], { stdio: "ignore" });
for (let i = 0; i < 100 && !fs.existsSync(path.join(regDir, "port")); i++) sleep(50);
const regUrl = `http://127.0.0.1:${fs.readFileSync(path.join(regDir, "port"), "utf8")}`;

// Publish a fake release: today's built hooks with a marker appended.
function publish(version, { corrupt = false, dropFile = null } = {}) {
  const entries = [];
  for (const f of fs.readdirSync(HOOKS_DIR)) {
    if (!f.endsWith(".cjs") || f === dropFile) continue;
    entries.push([`package/dist/hooks/${f}`, Buffer.concat([fs.readFileSync(path.join(HOOKS_DIR, f)), Buffer.from(`\n// release ${version}\n`)])]);
  }
  entries.push(["package/bin/install.cjs", fs.readFileSync(path.join(__dirname, "..", "bin", "install.cjs"))]);
  entries.push(["package/package.json", Buffer.from(JSON.stringify({ name: "prompt-genie", version }))]);
  const tgz = require("zlib").gzipSync(makeTar(entries));
  const integrity = "sha512-" + crypto.createHash("sha512").update(corrupt ? Buffer.from("tampered") : tgz).digest("base64");
  fs.writeFileSync(path.join(regDir, "pkg.tgz"), tgz);
  fs.writeFileSync(path.join(regDir, "latest.json"), JSON.stringify({ name: "prompt-genie", version, dist: { tarball: `${regUrl}/pkg.tgz`, integrity } }));
  removeFile(path.join(regDir, "requests.log"));
}

// A fresh install of the current hooks under a throwaway home.
function freshInstall() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-home-"));
  const hooksDir = path.join(home, ".prompt-genie", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  for (const f of fs.readdirSync(HOOKS_DIR)) fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(hooksDir, f));
  return { home, hooksDir };
}
const runUpdater = (home, env = {}) => spawnSync(process.execPath, [path.join(home, ".prompt-genie", "hooks", "self_update.cjs")], {
  env: { ...process.env, HOME: home, USERPROFILE: home, PG_REGISTRY_URL: regUrl, PROMPT_GENIE_TELEMETRY: "1", ...env },
  encoding: "utf8", timeout: 20000,
});
const libMarker = (hooksDir) => fs.readFileSync(path.join(hooksDir, "_lib.cjs"), "utf8").match(/\/\/ release (\S+)/)?.[1] || null;
const updateState = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, ".claude", "pg_update.json"), "utf8")); } catch { return {}; } };
const registryHits = () => { try { return fs.readFileSync(path.join(regDir, "requests.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

test("installs a newer verified release and records it", () => {
  publish("9.9.9");
  const { home, hooksDir } = freshInstall();
  const r = runUpdater(home);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(libMarker(hooksDir) === "9.9.9", "hooks replaced with the new release");
  assert(libMarker(hooksDir) && fs.readdirSync(hooksDir).every((f) => !f.includes(".update-")), "no temp files left");
  const st = updateState(home);
  assert(st.version === "9.9.9" && typeof st.checkedAt === "number", `state ${JSON.stringify(st)}`);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert((settings.hooks.Stop || []).some((g) => g.hooks.some((h) => h.command.includes("stop_flush.cjs"))), "hooks re-wired in settings.json");
  const events = JSON.parse(fs.readFileSync(path.join(home, ".claude", "pg_events.json"), "utf8")).events;
  assert(events.some((e) => e.event === "cli_updated" && e.properties.to_version === "9.9.9"), "cli_updated queued");
  fs.rmSync(home, { recursive: true, force: true });
});

test("checks at most once a day", () => {
  publish("9.9.9");
  const { home, hooksDir } = freshInstall();
  fs.writeFileSync(path.join(home, ".claude", "pg_update.json"), JSON.stringify({ checkedAt: Date.now() - 60 * 60 * 1000 }));
  runUpdater(home);
  assert(registryHits().length === 0, "no registry call within 24h");
  assert(libMarker(hooksDir) === null, "hooks untouched");
  fs.rmSync(home, { recursive: true, force: true });
});

test("does nothing when the registry has no newer version", () => {
  publish("0.0.1");
  const { home, hooksDir } = freshInstall();
  runUpdater(home);
  assert(registryHits().length === 1, `only the version check, got ${registryHits()}`);
  assert(libMarker(hooksDir) === null, "hooks untouched");
  fs.rmSync(home, { recursive: true, force: true });
});

test("rejects a tarball that fails the integrity check", () => {
  publish("9.9.9", { corrupt: true });
  const { home, hooksDir } = freshInstall();
  runUpdater(home);
  assert(libMarker(hooksDir) === null, "hooks untouched");
  assert(/integrity/.test(updateState(home).lastError || ""), `lastError ${updateState(home).lastError}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test("rejects a release missing core hooks", () => {
  publish("9.9.9", { dropFile: "stop_flush.cjs" });
  const { home, hooksDir } = freshInstall();
  runUpdater(home);
  assert(libMarker(hooksDir) === null, "hooks untouched");
  fs.rmSync(home, { recursive: true, force: true });
});

test("PROMPT_GENIE_AUTO_UPDATE=0 and autoUpdate:false turn it off", () => {
  publish("9.9.9");
  const a = freshInstall();
  runUpdater(a.home, { PROMPT_GENIE_AUTO_UPDATE: "0" });
  const b = freshInstall();
  fs.writeFileSync(path.join(b.home, ".claude", "pg_config.json"), JSON.stringify({ autoUpdate: false }));
  runUpdater(b.home);
  assert(registryHits().length === 0, "no registry call when opted out");
  assert(libMarker(a.hooksDir) === null && libMarker(b.hooksDir) === null, "hooks untouched");
  fs.rmSync(a.home, { recursive: true, force: true });
  fs.rmSync(b.home, { recursive: true, force: true });
});

test("session start launches the update in the background without waiting", () => {
  publish("9.9.9");
  const { home, hooksDir } = freshInstall();
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(hooksDir, "session_start.cjs")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID, source: "startup" }),
    env: { ...process.env, HOME: home, USERPROFILE: home, PG_REGISTRY_URL: regUrl },
    encoding: "utf8", timeout: 6000,
  });
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(Date.now() - started < 3000, "session start must not wait for the update");
  for (let i = 0; i < 100 && libMarker(hooksDir) !== "9.9.9"; i++) sleep(100);
  assert(libMarker(hooksDir) === "9.9.9", "background update completed");
  fs.rmSync(home, { recursive: true, force: true });
});

test("hooks run from a checkout never self-update", () => {
  publish("9.9.9");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  spawnSync(process.execPath, [path.join(HOOKS_DIR, "session_start.cjs")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID, source: "startup" }),
    env: { ...process.env, HOME: home, USERPROFILE: home, PG_REGISTRY_URL: regUrl },
    encoding: "utf8", timeout: 6000,
  });
  sleep(500);
  assert(registryHits().length === 0, "no registry call from a checkout");
  fs.rmSync(home, { recursive: true, force: true });
});

registry.kill();
fs.rmSync(regDir, { recursive: true, force: true });

// ── Summary ───────────────────────────────────────────────────────────────────

fs.rmSync(tmpHome, { recursive: true, force: true });

const total = passed + failed;
console.log(`\n  ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : " — all good"}\n`);

if (failed > 0) {
  console.error("  Failing tests:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`);
  console.error();
  process.exit(1);
}
