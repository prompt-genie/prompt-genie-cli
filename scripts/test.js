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

test("first large read stores text for diffing", () => {
  clearSessions();
  const r = runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  expectPassThrough(r, "first large read");
  const entry = Object.values(readSession(SID).files).find((e) => e.path === testFile);
  assert(entry && typeof entry.text === "string", "large read should retain text for delta");
});

test("re-read after a small edit: serves a delta, not the whole file", () => {
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
  const r = runHook("post_read.cjs", postReadEvent(testFile, edited2));
  expectSuppression(r, "second edited re-read");
  assert(parseJSON(r.stdout).hookSpecificOutput.updatedToolOutput.includes("12345"), "second delta must reflect newest change");
});

test("wholesale rewrite is too big to delta: passes through", () => {
  clearSessions();
  runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  const rewritten = Array.from({ length: 300 }, (_, i) => `totally different content row ${i} ${"x".repeat(20)}`).join("\n") + "\n";
  const r = runHook("post_read.cjs", postReadEvent(testFile, rewritten));
  expectPassThrough(r, "wholesale rewrite");
  assert(readSession(SID).misses >= 1, "wholesale change should count as a miss");
});

test("free plan: delta is measured but NOT served", () => {
  writeFreeConfig();
  clearSessions();
  runHook("post_read.cjs", postReadEvent(testFile, bigFile));
  const r = runHook("post_read.cjs", postReadEvent(testFile, editedFile));
  expectPassThrough(r, "free delta must not be served");
  const session = readSession(SID);
  assert(session.hits >= 1 && session.tokensSaved > 0, "free plan must still measure the delta saving");
  writePaidConfig(); // restore
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
