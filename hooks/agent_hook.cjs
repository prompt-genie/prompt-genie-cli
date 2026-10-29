#!/usr/bin/env node
// Entry point for coding agents other than Claude Code:
//   node agent_hook.cjs <agent> <event>     agent: codex | gemini | copilot
//                                           event: post_tool | session_start | compact | stop
// Each adapter turns the agent's hook payload into the calls the Claude Code
// hooks already make, and turns a replacement note into the reply that agent
// understands. Anything unrecognised passes through untouched.
process.on("uncaughtException", (err) => { process.stderr.write("pg agent_hook: " + err.message + "\n"); process.exit(0); });
const path = require("path");
const lib = require("./_lib.cjs");
const { handleBash } = require("./post_bash.cjs");
const { handleAgentRead } = require("./post_read.cjs");
const { onSessionStart, forgetContext } = require("./session_start.cjs");
const { flush } = require("./stop_flush.cjs");

function asObject(value) {
  if (typeof value !== "string") return value || {};
  try { return JSON.parse(value); } catch { return {}; }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return null;
}

// Codex sometimes reports the command as argv, e.g. ["bash", "-lc", "sed -n ..."]
function commandOf(command) {
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    const i = command.findIndex((a) => a === "-c" || a === "-lc");
    return i >= 0 && typeof command[i + 1] === "string" ? command[i + 1] : command.join(" ");
  }
  return null;
}

function shellEvent(sessionId, cwd, command, output) {
  const cmd = commandOf(command);
  if (!cmd || typeof output !== "string") return null;
  return {
    kind: "shell",
    data: { tool_name: "Bash", session_id: sessionId, cwd, tool_input: { command: cmd }, tool_response: output },
  };
}

// Gemini reports shell results as "Command: ...\nDirectory: ...\nOutput: <stdout>\n
// Error: ...\nExit Code: ..."; take the stdout so file reads and repeats line up.
function geminiShellOutput(text) {
  const m = text.match(/(?:^|\n)Output: ([\s\S]*?)\n(?:Error|Exit Code|Signal|Background PIDs|Process Group PGID): /);
  return m ? m[1] : text;
}

const ADAPTERS = {
  codex: {
    source: "CODEX",
    // Codex has no file-read tool: it reads files with sed/cat, handled as shell reads.
    toolEvent(e) {
      if (e.tool_name !== "Bash") return null;
      const r = e.tool_response;
      const output = textOf(r) ?? textOf(r?.output) ?? textOf(r?.stdout) ?? textOf(r?.aggregated_output) ?? textOf(r?.formatted_output);
      return shellEvent(e.session_id, e.cwd, e.tool_input?.command, output);
    },
    sessionId: (e) => e.session_id,
    cwd: (e) => e.cwd,
    startSource: (e) => e.source,
    reply: (note) => ({ decision: "block", reason: note }),
  },

  gemini: {
    source: "GEMINI_CLI",
    toolEvent(e) {
      const input = e.tool_input || {};
      const text = textOf(e.tool_response?.llmContent);
      if (e.tool_response?.error || text == null) return null;
      if (e.tool_name === "read_file") {
        const file = input.file_path || input.absolute_path || input.path;
        if (!file) return null;
        return {
          kind: "read",
          filePath: path.resolve(e.cwd || process.cwd(), file),
          from: Number.isInteger(input.offset) ? input.offset + 1 : 1,
          text,
        };
      }
      if (e.tool_name === "run_shell_command") {
        const cwd = input.dir_path ? path.resolve(e.cwd || process.cwd(), input.dir_path) : e.cwd;
        return shellEvent(e.session_id, cwd, input.command, geminiShellOutput(text));
      }
      return null;
    },
    sessionId: (e) => e.session_id,
    cwd: (e) => e.cwd,
    startSource: (e) => e.source,
    reply: (note) => ({ decision: "deny", reason: note }),
  },

  copilot: {
    source: "COPILOT",
    // camelCase payloads (we register camelCase event names)
    toolEvent(e) {
      const args = asObject(e.toolArgs);
      const text = textOf(e.toolResult?.textResultForLlm);
      if (text == null || (e.toolResult?.resultType && e.toolResult.resultType !== "success")) return null;
      if (e.toolName === "view") {
        if (!args.path) return null;
        const range = Array.isArray(args.view_range) ? args.view_range : null;
        return {
          kind: "read",
          filePath: path.resolve(e.cwd || process.cwd(), args.path),
          from: range && range[0] >= 1 ? range[0] : 1,
          text,
        };
      }
      if (e.toolName === "bash") return shellEvent(e.sessionId, e.cwd, args.command, text);
      return null;
    },
    sessionId: (e) => e.sessionId,
    cwd: (e) => e.cwd,
    startSource: (e) => (e.source === "new" ? "startup" : e.source),
    reply: (note) => ({ modifiedResult: { resultType: "success", textResultForLlm: note } }),
  },
};

// Returns the JSON reply for the agent, or null for no reply.
async function run(agentName, eventName, raw) {
  const agent = ADAPTERS[agentName];
  if (!agent || !raw || typeof raw !== "object") return null;
  const sessionId = agent.sessionId(raw);
  if (!sessionId) return null;

  if (eventName === "post_tool") {
    const ev = agent.toolEvent(raw);
    if (!ev) return null;
    const note = ev.kind === "read"
      ? handleAgentRead({ sessionId, cwd: agent.cwd(raw), filePath: ev.filePath, from: ev.from, text: ev.text })
      : handleBash(ev.data);
    return note ? agent.reply(note) : null;
  }
  if (eventName === "session_start") onSessionStart(sessionId, agent.startSource(raw));
  if (eventName === "compact") forgetContext(sessionId);
  if (eventName === "stop") await flush({ session_id: sessionId, cwd: agent.cwd(raw) }, { source: agent.source });
  return null;
}

async function main() {
  const [agentName, eventName] = process.argv.slice(2);
  const reply = await run(agentName, eventName, await lib.readStdinJson());
  if (reply) process.stdout.write(JSON.stringify(reply));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { ADAPTERS, run };
