# Prompt Genie for Claude Code

**Stop paying to re-read the same code.** Prompt Genie remembers what Claude Code
has already read this session, so identical re-reads cost ~15 tokens instead of
the whole file.

```bash
npx prompt-genie
```

That's it. Enter your email, restart your editor, and context memory runs
silently on every session.

---

## The problem

Claude Code re-reads files and re-runs the same read-only commands constantly.
`git status` between every step, the same source file on turn 2, turn 6, turn 11.
Every repeat is sent to the model again, and you pay for all of it. On a long
session in a real codebase that's tens of thousands of duplicate tokens.

## What Prompt Genie does

It installs a set of Claude Code hooks that fingerprint every file read and
read-only command output **per session**. When Claude reads something it has
already seen this session and the content is byte-for-byte unchanged, the hook
replaces the output with a short note:

```
✓ Already in context, unchanged since your last read. 420 lines.
```

Claude still knows the file is there (it's earlier in the conversation), but you
don't pay to send it again.

### Why it's safe

The check runs **after** the tool executes, comparing a hash of the fresh output
against what was already delivered this session. If anything changed, a file was
edited or a command's output differs, it passes straight through untouched. There
are no stale caches and no TTLs to tune.

- **Per-session.** State is keyed by session id, so concurrent Claude Code
  windows never interfere with each other.
- **Compaction-aware.** After `/compact` or `/clear`, the memory resets because
  the files are no longer in context.
- **Line-aware.** Every line Claude has been shown is remembered, so a read of
  a range it has mostly seen sends only the new lines, and a fully seen range is
  a short note. Plain shell reads (`cat`, `sed -n 'A,Bp'`, `head -n N`) share the
  same memory as the Read tool. Any change to the file on disk resets it.
- **Local-only.** Fingerprints (hashes) are stored on your machine. File
  contents are never stored or transmitted.

## Installing

```bash
npx prompt-genie
```

The installer:

1. Copies the hooks to `~/.prompt-genie/hooks`
2. Wires them into `~/.claude/settings.json` (`PreToolUse`, `PostToolUse`,
   `UserPromptSubmit`, `SessionStart`, `Stop`)
3. Verifies your plan

Restart Claude Code (or your IDE) after installing so the new hooks load.

## Seeing your savings

At the end of each session, savings sync to your dashboard at
[prompt-genie.com](https://prompt-genie.com): tokens saved, hit rate, and a
per-codebase breakdown over time.

For a quick local view any time:

```bash
node ~/.prompt-genie/hooks/stats.cjs
```

## Plans

Context memory is a paid feature. On the free plan Prompt Genie runs in
measure-only mode and shows you, at the end of each session, how many tokens you
*would* have saved. Activate at
[prompt-genie.com/pricing](https://prompt-genie.com/pricing).

## Uninstalling

Remove the Prompt Genie entries from `~/.claude/settings.json` and delete
`~/.prompt-genie/`.

## How your data is handled

The hooks store only content hashes and aggregate counters locally under
`~/.claude/`. At session end, aggregate stats (tokens saved, hit/miss counts, and
the project folder name) are sent to your dashboard. File contents and command
outputs never leave your machine.

### Usage events

To understand how Prompt Genie is used, the hooks also send a few usage events
linked to your account: install and sign-in, session starts, and per-turn token
counts (tokens saved, hits, misses). They carry no prompts, code, file paths,
command text or project names. Events are queued in `~/.claude/pg_events.json`
and sent at the end of a turn.

To turn them off, set either environment variable:

```bash
export PROMPT_GENIE_TELEMETRY=0
```

```bash
export DO_NOT_TRACK=1
```

or add `"telemetry": false` to `~/.claude/pg_config.json`.

### Automatic updates

Once a day, at the start of a Claude Code session, Prompt Genie checks npm for a
newer release in the background (the session never waits on it). A new release
is downloaded from registry.npmjs.org, checked against npm's published sha512
checksum, and swapped in for the hooks in `~/.prompt-genie/hooks`. Your settings
and stats are kept.

To turn it off, set `PROMPT_GENIE_AUTO_UPDATE=0`, or add `"autoUpdate": false`
to `~/.claude/pg_config.json`. You can always update by hand with `npx prompt-genie`.

---

MIT © Prompt Genie
