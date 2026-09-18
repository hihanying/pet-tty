#!/usr/bin/env node
/**
 * pettty — one-command launcher for PetDeck / pet-tty
 *
 * Usage:
 *   pettty              Start (same as working: npm run tauri dev)
 *   pettty release      Start release .exe only (after pettty build)
 *   pettty dev          Force tauri dev
 *   pettty build        Build release binary
 *   pettty test         Send a test event
 *   pettty hooks        Install/repair Claude Code hooks
 *   pettty health       Check bridge
 *   pettty help
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

const args = process.argv.slice(2);
const cmd = (args[0] || "start").toLowerCase();

function log(msg) {
  console.log(msg);
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function releaseExe() {
  return path.join(
    ROOT,
    "src-tauri",
    "target",
    "release",
    isWin ? "petdeck.exe" : "petdeck",
  );
}

function distIndex() {
  return path.join(ROOT, "dist", "index.html");
}

/** Release binary is usable only if it exists AND frontend dist is present. */
function canUseRelease() {
  return fs.existsSync(releaseExe()) && fs.existsSync(distIndex());
}

function runNpm(npmArgs) {
  const npm = isWin ? "npm.cmd" : "npm";
  const r = spawn(npm, npmArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: isWin,
    env: {
      ...process.env,
      // Ensure cargo on PATH for typical Windows install
      Path: `${path.join(process.env.USERPROFILE || "", ".cargo", "bin")}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
      PATH: `${path.join(process.env.USERPROFILE || "", ".cargo", "bin")}${path.delimiter}${process.env.PATH || process.env.Path || ""}`,
    },
  });
  r.on("exit", (code) => process.exit(code ?? 0));
  return r;
}

function ensureHooksQuiet() {
  const script = path.join(ROOT, "adapters", "claude-code", "fix-hooks.mjs");
  if (!fs.existsSync(script)) return;
  // Always repair: settings often get overwritten when users change API keys
  const r = spawnSync(process.execPath, [script, "--quiet"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    log("[pettty] warning: could not install Claude hooks (run: pettty hooks)");
  }
}

function startDev() {
  log("[pettty] starting like: npm run tauri dev");
  log(`[pettty] project: ${ROOT}`);
  log("[pettty] bridge: http://127.0.0.1:7788");
  log("[pettty] repairing Claude hooks if needed…");
  ensureHooksQuiet();
  log("");
  log("  After the pet window opens:");
  log("    • pettty test     — self-test bubble");
  log("    • fully quit & reopen Claude Code for hooks");
  log("");
  runNpm(["run", "tauri", "dev"]);
}

function startRelease() {
  if (!canUseRelease()) {
    die(
      "[pettty] no usable release build.\n" +
        "  Run:  pettty build\n" +
        "  Or:   pettty          (dev mode, recommended)",
    );
  }
  ensureHooksQuiet();
  const exe = releaseExe();
  log(`[pettty] starting release: ${exe}`);
  const child = spawn(exe, [], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * Default start: ALWAYS use tauri dev unless user asks for release.
 * Never launch debug petdeck.exe alone — that loads :1420 and shows
 * "无法访问此页面" when Vite is not running.
 */
function startApp({ mode = "dev" } = {}) {
  if (mode === "release") {
    startRelease();
    return;
  }
  startDev();
}

function buildApp() {
  log("[pettty] building release (npm run tauri build)…");
  log("[pettty] this may take several minutes");
  runNpm(["run", "tauri", "build"]);
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const token = process.env.PETDECK_BRIDGE_TOKEN?.trim();
    const headers = data
      ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        }
      : {};
    if (token) headers["X-PetDeck-Token"] = token;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 7788,
        path: urlPath,
        method,
        headers,
        timeout: 3000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") });
          } catch {
            resolve({ status: res.statusCode, json: buf });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function health() {
  try {
    const r = await httpJson("GET", "/health");
    log(JSON.stringify(r.json, null, 2));
    process.exit(r.status === 200 ? 0 : 1);
  } catch (e) {
    die(`[pettty] bridge not reachable (is pet running?)\n${e.message || e}`);
  }
}

async function sendTest() {
  const body = {
    schema: "petdeck.event.v1",
    source: "claude-code",
    sessionId: "manual-test",
    sessionLabel: "test",
    ts: new Date().toISOString(),
    state: "editing",
    title: "Editing auth.ts",
    detail: "src/lib/auth.ts",
    progress: { kind: "indeterminate" },
    needsAttention: false,
    stickyMs: 60000,
  };
  try {
    const r = await httpJson("POST", "/event", body);
    log(`[pettty] test event → HTTP ${r.status}`);
    log(JSON.stringify(r.json, null, 2));
    log("[pettty] pet bubble should show Editing auth.ts");
    process.exit(r.status === 200 ? 0 : 1);
  } catch (e) {
    die(`[pettty] failed — start the pet first:  pettty\n${e.message || e}`);
  }
}

function installHooks() {
  const script = path.join(ROOT, "adapters", "claude-code", "fix-hooks.mjs");
  if (!fs.existsSync(script)) die(`[pettty] missing ${script}`);
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

function help() {
  log(`
pettty — PetDeck / pet-tty  (Claude Code desktop pet)

  pettty              Start pet  =  npm run tauri dev  (recommended)
  pettty release      Start release .exe (after: pettty build)
  pettty dev          Same as pettty
  pettty build        Build release binary
  pettty test         Send test status (pet must be running)
  pettty hooks        Install/repair Claude Code hooks
  pettty health       Check http://127.0.0.1:7788/health
  pettty help

中文：
  pettty              启动桌宠（与 npm run tauri dev 相同，会自动修 hooks）
  pettty test         发送测试气泡
  pettty hooks        重装 Claude hooks（改 API/settings 后若连不上就跑这个）
  pettty release      启动发布版 exe

NOTE: Do NOT run debug petdeck.exe alone — it needs Vite on :1420.
      That was why bare "pettty" showed 无法访问此页面.
`);
}

switch (cmd) {
  case "start":
  case "run":
  case "open":
    startApp({ mode: "dev" });
    break;
  case "dev":
    startApp({ mode: "dev" });
    break;
  case "release":
  case "prod":
    startApp({ mode: "release" });
    break;
  case "build":
    buildApp();
    break;
  case "test":
  case "send-test":
    void sendTest();
    break;
  case "hooks":
  case "install-hooks":
    installHooks();
    break;
  case "health":
  case "status":
    void health();
    break;
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    if (cmd.startsWith("-")) help();
    else {
      log(`[pettty] unknown: ${cmd}`);
      help();
      process.exit(1);
    }
}
