#!/usr/bin/env node
/**
 * Build script: obfuscates hook files into dist/hooks/
 * install.cjs (bin) is NOT obfuscated — it needs to be readable for npm audit / trust.
 * The hooks that run silently on every file read ARE obfuscated to protect the logic.
 */
const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const HOOKS_SRC  = path.join(__dirname, "..", "hooks");
const HOOKS_DEST = path.join(__dirname, "..", "dist", "hooks");

// Obfuscator options — high protection, still runs fast in Node
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: false,          // keep it lean — hooks run on every Read
  identifierNamesGenerator: "mangled",
  renameGlobals: false,              // don't rename require/process/etc.
  rotateStringArray: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.85,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

fs.mkdirSync(HOOKS_DEST, { recursive: true });

let built = 0;
for (const file of fs.readdirSync(HOOKS_SRC)) {
  if (!file.endsWith(".cjs")) continue;

  const src  = path.join(HOOKS_SRC, file);
  const dest = path.join(HOOKS_DEST, file);
  const code = fs.readFileSync(src, "utf8");

  // Strip the shebang line before obfuscating (obfuscator chokes on it),
  // then put it back so the file stays executable.
  const hasBang  = code.startsWith("#!");
  const bangLine = hasBang ? code.split("\n")[0] + "\n" : "";
  const body     = hasBang ? code.slice(bangLine.length) : code;

  const result = JavaScriptObfuscator.obfuscate(body, OBFUSCATOR_OPTIONS);
  fs.writeFileSync(dest, bangLine + result.getObfuscatedCode());
  built++;
  console.log(`  ✓ obfuscated ${file}`);
}

console.log(`\nBuild done — ${built} hook(s) written to dist/hooks/`);
