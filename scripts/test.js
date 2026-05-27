#!/usr/bin/env node
/**
 * Hook health tests — run against the BUILT dist/hooks/ so we also catch
 * obfuscation bugs before anything ships.
 *
 * Each test sends a realistic stdin payload to the hook binary, checks the
 * exit code, and validates stdout/stderr where applicable.
 */

const { spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const HOOKS_DIR = path.join(__dirname, "..", "dist", "hooks");

// ── Isolated home dir ─────────────────────────────────────────────────────────

const tmpHome   = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
const claudeDir = path.join(tmpHome, ".claude");
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

function removeClaudeFile(name) {
  try { fs.unlinkSync(path.join(claudeDir, name)); } catch {}
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

const preReadEvent = (fp) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: fp },
});

const postReadEvent = (fp, content) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: fp },
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

const preBashEvent  = (cmd) => ({ hook_event_name: "PreToolUse",  tool_name: "Bash", tool_input: { command: cmd } });
const postBashEvent = (cmd, output) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: output });

// ── pre_read tests ────────────────────────────────────────────────────────────

console.log("\n  pre_read");

test("exits 0 on malformed JSON", () => {
  const r = runHook("pre_read.cjs", "{{not json}}");
  assert(!r.timedOut,       "timed out");
  assert(r.exitCode === 0,  `exit ${r.exitCode}`);
});

test("exits 0 on valid PreToolUse Read (no cache)", () => {
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(!r.timedOut,       "timed out");
  assert(r.exitCode === 0,  `exit ${r.exitCode}`);
});

test("never writes to stdout", () => {
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(r.stdout === "",   `unexpected stdout: ${r.stdout.slice(0, 80)}`);
});

test("never exits 2 (must not block reads)", () => {
  // Run with a populated cache to ensure we don't accidentally re-introduce exit 2
  writeClaudeFile("pg_read_cache.json", { [testFile]: { mtime: 0, hash: "abc", content: testContent } });
  const r = runHook("pre_read.cjs", preReadEvent(testFile));
  assert(r.exitCode !== 2,  "hook exited 2 — would block the Read tool");
  removeClaudeFile("pg_read_cache.json");
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

console.log("\n  post_read");

test("exits 0 on malformed JSON", () => {
  const r = runHook("post_read.cjs", "{{bad}}");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("exits 0 on non-Read tool event", () => {
  const r = runHook("post_read.cjs", { tool_name: "Bash", tool_input: {}, tool_response: "output" });
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
  assert(r.stdout === "",  "should produce no output");
});

test("first read: exits 0 with no stdout and populates cache", () => {
  removeClaudeFile("pg_read_cache.json");
  removeClaudeFile("pg_session.json");

  const r = runHook("post_read.cjs", postReadEvent(testFile, testContent));

  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
  assert(r.stdout === "",  `first read should not modify output, got: ${r.stdout.slice(0, 120)}`);

  const cache = parseJSON(fs.readFileSync(path.join(claudeDir, "pg_read_cache.json"), "utf8"));
  assert(cache?.[testFile],       "file missing from cache");
  assert(cache[testFile].hash,    "cache entry missing hash");

  const session = parseJSON(fs.readFileSync(path.join(claudeDir, "pg_session.json"), "utf8"));
  assert(session?.filesRead?.includes(testFile), "testFile missing from session.filesRead");
});

test("repeated read (same content): outputs valid updatedToolOutput JSON", () => {
  // Cache was written by previous test; mark file as already read in session
  writeClaudeFile("pg_session.json", {
    filesRead: [testFile],
    hits: 0, misses: 1,
    date: new Date().toISOString().slice(0, 10),
  });

  const r = runHook("post_read.cjs", postReadEvent(testFile, testContent));

  assert(!r.timedOut,        "timed out");
  assert(r.exitCode === 0,   `exit ${r.exitCode}. stderr: ${r.stderr}`);
  assert(r.stdout.length > 0, "expected updatedToolOutput in stdout");

  const out = parseJSON(r.stdout);
  assert(out !== null,       `stdout is not valid JSON: ${r.stdout.slice(0, 120)}`);
  assert(out.hookSpecificOutput?.hookEventName === "PostToolUse", "wrong hookEventName");
  assert(typeof out.hookSpecificOutput?.updatedToolOutput === "string", "updatedToolOutput must be a string");
  assert(out.hookSpecificOutput.updatedToolOutput.length > 0, "updatedToolOutput is empty");
});

test("repeated read (changed content): exits 0 with no stdout", () => {
  // Session still has file as read, but we send different content
  const changedContent = "// completely rewritten\nexport const x = 42;\n";

  const r = runHook("post_read.cjs", postReadEvent(testFile, changedContent));

  assert(r.exitCode === 0,  `exit ${r.exitCode}`);
  assert(r.stdout === "",   `changed file should not serve cached version, got: ${r.stdout.slice(0, 120)}`);
});

test("handles old-format tool_response (plain string)", () => {
  removeClaudeFile("pg_session.json");
  // Old Claude Code returned plain text from Read tool
  const r = runHook("post_read.cjs", {
    tool_name: "Read",
    tool_input: { file_path: testFile },
    tool_response: testContent,
  });
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
});

// ── post_bash tests ───────────────────────────────────────────────────────────

console.log("\n  post_bash");

test("exits 0 on malformed JSON", () => {
  const r = runHook("post_bash.cjs", "bad input");
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
});

test("exits 0 on valid read-only Bash PostToolUse", () => {
  const r = runHook("post_bash.cjs", postBashEvent("ls -la", "file1.txt\nfile2.txt\n"));
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
});

test("exits 0 on write command (must not cache)", () => {
  const r = runHook("post_bash.cjs", postBashEvent("rm -rf /tmp/test", ""));
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
  assert(r.stdout === "",  "write command should not produce output");
});

// ── user_prompt_submit tests ──────────────────────────────────────────────────

console.log("\n  user_prompt_submit");

const promptEvent = (cwd = tmpHome) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: "test-session",
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
  writeClaudeFile("pg_session.json", {});
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

// ── stop_flush tests ──────────────────────────────────────────────────────────

console.log("\n  stop_flush");

test("exits 0 immediately with empty session (no network call)", () => {
  writeClaudeFile("pg_session.json", {});
  removeClaudeFile("pg_config.json");
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop" });
  assert(!r.timedOut,      "timed out — possible hang");
  assert(r.exitCode === 0, `exit ${r.exitCode}. stderr: ${r.stderr}`);
});

test("exits 0 with hits/misses but no token (skips network)", () => {
  writeClaudeFile("pg_session.json", { hits: 5, misses: 10, tokensSaved: 5000 });
  removeClaudeFile("pg_config.json");
  const r = runHook("stop_flush.cjs", { hook_event_name: "Stop" });
  assert(!r.timedOut,      "timed out");
  assert(r.exitCode === 0, `exit ${r.exitCode}`);
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
