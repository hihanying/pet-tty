#!/usr/bin/env node
/**
 * Claude Code hook → PetDeck bridge (fast path)
 * - Maps hook JSON → petdeck.event.v1
 * - POSTs to 127.0.0.1:7788/event and exits immediately (does not wait for HTTP response)
 *   so Claude is not blocked for seconds on each tool call.
 */

import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";

const ENDPOINT = process.env.PETDECK_URL || "http://127.0.0.1:7788/event";

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Fire-and-forget POST — do not await response (speed). */
function postJsonFast(urlStr, body) {
  try {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      Connection: "close",
    };
    const token = process.env.PETDECK_BRIDGE_TOKEN?.trim();
    if (token) headers["X-PetDeck-Token"] = token;
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: "POST",
      headers,
      timeout: 400,
    });
    req.on("error", () => {});
    req.on("timeout", () => {
      req.destroy();
    });
    // Drain so socket can close
    req.on("response", (res) => {
      res.resume();
    });
    req.write(data);
    req.end();
  } catch {
    /* ignore — never block Claude */
  }
}

function toolTitle(name, input) {
  if (!name) return "Working";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const p = input?.file_path || input?.path || input?.filePath;
    return p ? `Editing ${String(p).split(/[/\\]/).pop()}` : "Editing";
  }
  if (name === "Bash" || name === "bash") {
    const cmd = String(input?.command || "").slice(0, 48);
    return cmd ? `Shell: ${cmd}` : "Running shell";
  }
  if (name === "Read") {
    const p = input?.file_path || input?.path;
    return p ? `Reading ${String(p).split(/[/\\]/).pop()}` : "Reading";
  }
  if (name === "Grep" || name === "Glob") return `Search: ${name}`;
  if (name === "WebFetch" || name === "WebSearch") return "Web";
  return String(name);
}

function mapHook(raw) {
  const phase =
    process.env.PETDECK_HOOK ||
    raw.hook_event_name ||
    raw.event ||
    raw.type ||
    "";
  const toolName =
    raw.tool_name || raw.toolName || raw.tool?.name || raw.name || "";
  const toolInput =
    raw.tool_input || raw.toolInput || raw.input || raw.parameters || {};
  const sessionId =
    raw.session_id || raw.sessionId || raw.cwd || "claude-session";

  let state = "thinking";
  let title = "Claude Code";
  let detail = phase || undefined;
  let needsAttention = false;
  /** tell PetDeck UI to auto-clear sooner */
  let stickyMs = 0;

  const p = String(phase).toLowerCase();

  if (p.includes("pretool") || p === "pre_tool_use") {
    const n = String(toolName);
    if (/edit|write|notebook/i.test(n)) state = "editing";
    else if (/bash|shell/i.test(n)) state = "tool_call";
    else if (/read/i.test(n)) state = "tool_call";
    else if (
      /test/i.test(n) ||
      /npm test|pytest|cargo test/i.test(JSON.stringify(toolInput))
    )
      state = "running_tests";
    else state = "tool_call";
    title = toolTitle(toolName, toolInput);
    detail =
      toolInput?.file_path ||
      toolInput?.path ||
      toolInput?.command ||
      toolName ||
      "";
    stickyMs = 8000; // stay until next event or auto-idle
  } else if (p.includes("posttool") || p === "post_tool_use") {
    // Tool finished — go idle so we don't stick on "Reading…"
    state = "idle";
    title = "Ready";
    detail = toolName ? `Finished ${toolName}` : "Tool finished";
    stickyMs = 0;
  } else if (p.includes("notification") || p.includes("permission")) {
    state = "waiting_user";
    title = "Needs your input";
    detail = raw.message || raw.content || "Permission or question pending";
    needsAttention = true;
    stickyMs = 60000;
  } else if (
    p.includes("sessionstart") ||
    p.includes("session_start") ||
    p.includes("startup")
  ) {
    state = "idle";
    title = "Claude connected";
    detail = "PetDeck listening";
  } else if (p.includes("userprompt") || p === "userpromptsubmit") {
    state = "thinking";
    title = "Working on your request";
    detail = String(raw.prompt || raw.message || raw.content || "").slice(0, 80);
    stickyMs = 15000;
  } else if (p.includes("stop") || p.includes("end") || p.includes("complete")) {
    state = "success";
    title = "Done";
    detail = raw.reason || "";
    stickyMs = 2500;
  } else if (p.includes("error") || raw.error) {
    state = "error";
    title = "Error";
    detail = String(raw.error || raw.message || "").slice(0, 120);
    needsAttention = true;
    stickyMs = 20000;
  } else if (toolName) {
    state = "tool_call";
    title = toolTitle(toolName, toolInput);
    stickyMs = 8000;
  } else {
    state = "thinking";
    title = "Claude is working";
    detail = p || "hook";
    stickyMs = 10000;
  }

  return {
    schema: "petdeck.event.v1",
    source: "claude-code",
    sessionId: String(sessionId),
    ts: new Date().toISOString(),
    state,
    title: String(title).slice(0, 80),
    detail: detail ? String(detail).slice(0, 160) : undefined,
    progress: {
      kind: state === "success" || state === "idle" ? "none" : "indeterminate",
    },
    needsAttention,
    stickyMs,
  };
}

function main() {
  let rawText = "";
  try {
    rawText = readStdinSync();
  } catch {
    process.exit(0);
  }

  let raw = {};
  if (rawText.trim()) {
    try {
      raw = JSON.parse(rawText);
    } catch {
      raw = {
        message: rawText.slice(0, 200),
        hook_event_name: process.env.PETDECK_HOOK,
      };
    }
  } else {
    raw = { hook_event_name: process.env.PETDECK_HOOK || "manual" };
  }

  const event = mapHook(raw);
  postJsonFast(ENDPOINT, event);
  // Exit immediately — do not wait for HTTP
  process.exit(0);
}

main();
