/**
 * Install / repair PetDeck hooks in ~/.claude/settings.json
 *
 * Installs BOTH:
 *   - type: "http"   (fast, official Claude Code)
 *   - type: "command" (fallback — works when HTTP hooks unsupported)
 *
 * Usage:
 *   node fix-hooks.mjs
 *   node fix-hooks.mjs --quiet
 *   pettty hooks
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const quiet = process.argv.includes("--quiet");
const log = (...a) => {
  if (!quiet) console.log(...a);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path
  .join(__dirname, "petdeck-hook.mjs")
  .replace(/\\/g, "/");
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const BASE = "http://127.0.0.1:7788/hooks/claude";
const EVENT = "http://127.0.0.1:7788/event";
const tokenMode = Boolean(process.env.PETDECK_BRIDGE_TOKEN?.trim());

const PHASES = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "Notification",
  "SessionStart",
  "SessionEnd",
];

function httpHook(phase) {
  return {
    type: "http",
    url: `${BASE}?phase=${encodeURIComponent(phase)}`,
    timeout: 5,
  };
}

function commandHook(phase) {
  // Windows-safe: node + absolute path in double quotes
  return {
    type: "command",
    command: `node "${hookScript}"`,
    timeout: 8,
    env: {
      PETDECK_HOOK: phase,
      PETDECK_URL: EVENT,
    },
  };
}

/** Use command-only hooks in token mode so the token stays out of settings.json. */
function phaseEntry(phase) {
  return {
    matcher: "*",
    hooks: tokenMode ? [commandHook(phase)] : [httpHook(phase), commandHook(phase)],
  };
}

function hasPetdeckHooks(hooks) {
  if (!hooks || typeof hooks !== "object") return false;
  const pre = hooks.PreToolUse;
  if (!Array.isArray(pre) || pre.length === 0) return false;
  const blob = JSON.stringify(pre);
  return blob.includes("7788") || blob.includes("petdeck-hook");
}

const settingsDir = path.dirname(settingsPath);
if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
  } catch (e) {
    console.error("Parse settings failed:", e.message);
    process.exit(1);
  }
}

const already = hasPetdeckHooks(settings.hooks);
if (already && quiet) {
  // Still rewrite to dual http+command (self-heal partial installs)
}

const bak = `${settingsPath}.petdeck-http-${Date.now()}`;
if (fs.existsSync(settingsPath)) {
  fs.copyFileSync(settingsPath, bak);
  log("Backup:", bak);
}

const hooks = {};
for (const phase of PHASES) {
  hooks[phase] = [phaseEntry(phase)];
}
settings.hooks = hooks;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

if (quiet) {
  console.log(
    already
      ? "[pettty] Claude hooks OK (http + command → :7788)"
      : "[pettty] Claude hooks installed (http + command → :7788)",
  );
} else {
  console.log("OK: Claude → PetDeck hooks installed");
  console.log("  settings:", settingsPath);
  console.log("  HTTP:   ", tokenMode ? "disabled in token mode" : BASE);
  console.log("  command:", hookScript);
  console.log("  phases: ", PHASES.join(", "));
  console.log("");
  console.log("IMPORTANT:");
  console.log("  1) Start pet first:  pettty");
  console.log("  2) FULLY quit all Claude Code windows, then reopen");
  console.log("  3) Send a message / use a tool — pet should update");
  console.log("  4) If you change API keys and hooks disappear, run:  pettty hooks");
}

// Verify without printing secrets
try {
  const v = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!hasPetdeckHooks(v.hooks)) {
    console.error("ERROR: hooks missing after write");
    process.exit(1);
  }
} catch (e) {
  console.error("Verify failed:", e.message);
  process.exit(1);
}
