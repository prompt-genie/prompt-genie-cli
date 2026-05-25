#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(process.env.HOME, ".claude/pg_config.json");

const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.log("Usage: node hooks/setup.cjs your@email.com");
  process.exit(1);
}

fs.writeFileSync(CONFIG_FILE, JSON.stringify({ email }, null, 2));
console.log(`Prompt Genie configured for ${email}`);
console.log("Token savings will now sync to your dashboard after each session.");
