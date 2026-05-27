#!/usr/bin/env node
// PreToolUse:Bash — reserved for future use.
// Caching is handled in PostToolUse (post_bash.cjs) via updatedToolOutput.
process.on("uncaughtException", () => process.exit(0));
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
