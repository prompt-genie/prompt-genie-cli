#!/usr/bin/env node
// PreToolUse:Read — reserved for future use.
// Caching is handled in PostToolUse (post_read.cjs) via updatedToolOutput.
process.on("uncaughtException", () => process.exit(0));
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
