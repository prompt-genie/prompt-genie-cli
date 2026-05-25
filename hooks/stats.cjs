#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const STATS_FILE = path.join(process.env.HOME, ".claude/pg_stats.json");

if (!fs.existsSync(STATS_FILE)) {
  console.log("No data yet — stats are recorded after your first Claude Code session.");
  process.exit(0);
}

const stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
const hits = stats.total_hits || 0;
const misses = stats.total_misses || 0;
const total = hits + misses;
const tokensSaved = stats.total_tokens_saved || 0;
const hitRate = total ? ((hits / total) * 100).toFixed(1) : "0.0";
const costSaved = ((tokensSaved / 1_000_000) * 3).toFixed(4);

console.log("============================================");
console.log("  Prompt Genie — Read Cache Stats");
console.log("============================================");
console.log(`  Cache hits   : ${hits.toLocaleString()}`);
console.log(`  Cache misses : ${misses.toLocaleString()}`);
console.log(`  Hit rate     : ${hitRate}%`);
console.log(`  Tokens saved : ~${tokensSaved.toLocaleString()}`);
console.log(`  Cost saved   : ~$${costSaved}  (at $3/M input tokens)`);
console.log("============================================");

const files = stats.files || {};
const sorted = Object.entries(files).sort((a, b) => b[1].tokens_saved - a[1].tokens_saved);
if (sorted.length) {
  console.log("\n  Top files by tokens saved:");
  sorted.slice(0, 10).forEach(([p, d]) => {
    console.log(`    ${String(d.tokens_saved).padStart(6)} tokens  (${d.hits} hits)  ${path.basename(p)}`);
  });
}
