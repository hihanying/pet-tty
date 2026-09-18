import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getLocale, setLocale, t } from "./i18n";
import { buildDemoEvents } from "./events/demo-script";
import { EventPlayer } from "./events/player";
import type { AgentEvent, AgentState } from "./events/types";
import {
  getClaudeAdapterStatus,
  setBridgeStatus,
} from "./adapters/claude-code/stub";
import { loadSettings, saveSettings } from "./settings";
import {
  addCustomSkin,
  getActiveSkin,
  getActiveSkinId,
  listAllSkins,
  makeCustomId,
  removeCustomSkin,
  setActiveSkinId,
} from "./skins/store";
import { applySkinToDom } from "./skins/render";
import { getVectorCharacter } from "./skins/vector";
import { fileToDataUrl, normalizeImport, type PixelQuality } from "./skins/pixelize";
import { makePixelDollFromImage } from "./skins/pixel-doll";
import * as spriteImport from "./skins/spriteImport";
import { synthesizeSpriteFromImage } from "./skins/spriteSynth";
import { isolateSubject } from "./skins/segment";
import { spritePlayer } from "./skins/spritePlayer";
import { hideWorkProgress, setWorkProgress } from "./skins/progress";
import type { SkinMeta } from "./skins/types";
import {
  listSessions,
  markIdle,
  primarySession,
  upsertSession,
} from "./sessions";

const PET_SIZE = { w: 210, h: 340 };
/** Taller when multiple AI sessions are active */
const PET_MULTI = { w: 220, h: 480 };
/** Expanded while context menu is open so list can scroll */
const MENU_SIZE = { w: 250, h: 440 };
const INSP_SIZE = { w: 360, h: 640 };

const player = new EventPlayer();
let latest: AgentEvent | null = null;

/** True while the pet window is being dragged - pauses the costly 2s polls
 *  (presence snapshot spawns a tasklist scan in Rust) so the drag stays smooth. */
let dragging = false;
let demoPlaying = false;
let showBubble = true;
let idleHideTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let pixelQuality: PixelQuality = "fine";
/** Last live source label e.g. claude-code / grok */
let liveSource: string | null = null;
let liveAt = 0;
/** Timestamp of the last "Claude connected" (SessionStart / presence-just
 *  -connected) signal. Drives the short connection grace in updateConnPanel -
 *  distinct from `liveAt` (updated on every event) so that the Stop/SessionEnd
 *  event fired when Claude CLOSES cannot keep the indicator "connected". */
let liveConnectAt = 0;

/** Connection strip state (process presence + activity) */
type ConnUi = "offline" | "online" | "busy" | "closed";
let connUi: ConnUi = "offline";
let claudeConnected = false;
let claudeLiveCount = 0;
/** Consecutive false presence readings - used to debounce disconnects so a
 *  single tasklist hiccup can't flash "对话已关闭" mid-conversation. */
let presenceFalseStreak = 0;
let toastTimerConn: ReturnType<typeof setTimeout> | null = null;

interface ClaudePresence {
  connected: boolean;
  liveCount: number;
  sessions: { sessionId: string; pid: number; name: string; status: string }[];
  justConnected: boolean;
  justDisconnected: boolean;
}

function showConnToast(msg: string) {
  const el = document.getElementById("conn-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimerConn) clearTimeout(toastTimerConn);
  toastTimerConn = setTimeout(() => el.classList.add("hidden"), 3200);
}

function updateConnPanel() {
  const panel = document.getElementById("conn-panel");
  const title = document.getElementById("conn-title");
  const sub = document.getElementById("conn-sub");
  if (!panel || !title || !sub) return;

  const zh = getLocale() === "zh-CN";
  panel.classList.remove(
    "conn-offline",
    "conn-online",
    "conn-busy",
    "conn-closed",
  );

  // `success` is terminal - it fires on Stop, i.e. when Claude finishes a reply
  // or CLOSES. Treating it as "working" made the pet show 执行中 for 120s after
  // Claude stopped/closed. Keep error/waiting_user: they still need attention.
  const busyStates = new Set([
    "thinking",
    "tool_call",
    "editing",
    "running_tests",
    "waiting_user",
    "error",
  ]);
  // Recent BUSY activity -> "working" (also covers `pettty test` with no Claude
  // process). success no longer counts (terminal).
  const activityBusy =
    latest != null &&
    busyStates.has(latest.state) &&
    liveSource != null &&
    Date.now() - liveAt < 120_000;
  // "Connected" follows actual Claude presence. A "Claude connected" event
  // (SessionStart, or the soft event injected when presence first detects
  // Claude) also counts for a SHORT grace so the indicator lights up the
  // instant Claude opens - before the ~2s presence poll catches up.
  // A 5-minute window must NOT be used: the Stop/SessionEnd event fires exactly
  // when Claude CLOSES, so a long grace made "closing Claude" look "connected"
  // for minutes and survive a reopen.
  const hasLiveSignal =
    claudeConnected ||
    (liveSource != null && Date.now() - liveConnectAt < 30_000);

  if (activityBusy) {
    connUi = "busy";
  } else if (hasLiveSignal || claudeConnected) {
    connUi = "online";
  } else if (connUi === "online" || connUi === "busy" || connUi === "closed") {
    connUi = "closed";
  } else {
    connUi = "offline";
  }

  panel.classList.add(`conn-${connUi}`);

  if (connUi === "offline") {
    title.textContent = zh ? "未连接" : "Not connected";
    sub.textContent = zh
      ? "启动 Claude 或运行 pettty test"
      : "Start Claude or run: pettty test";
  } else if (connUi === "online") {
    title.textContent = zh ? "已连接 · 待命" : "Connected · idle";
    sub.textContent = zh
      ? claudeConnected
        ? `${claudeLiveCount} 个终端 · 可拖动/换肤`
        : "桥接在线 · 待命"
      : claudeConnected
        ? `${claudeLiveCount} session(s) · idle`
        : "Bridge online · idle";
  } else if (connUi === "busy") {
    title.textContent = zh ? "执行中" : "Working";
    const st = latest ? stateLabel(latest.state) : "";
    sub.textContent = latest
      ? `${st} · ${latest.title}`
      : zh
        ? "正在工作…"
        : "Working…";
  } else {
    title.textContent = zh ? "对话已关闭" : "Session closed";
    sub.textContent = zh
      ? "再次启动 Claude 或 pettty test"
      : "Start Claude or pettty test again";
  }
}

function onClaudePresence(p: ClaudePresence) {
  const was = claudeConnected;
  // Debounce disconnects: a single false reading (tasklist hiccup) must NOT
  // drop us to "closed" mid-conversation or flash "对话已关闭". Require 2
  // consecutive false before treating Claude as gone.
  if (p.connected) {
    presenceFalseStreak = 0;
    if (!claudeConnected) claudeConnected = true;
  } else {
    presenceFalseStreak += 1;
    if (presenceFalseStreak >= 2 && claudeConnected) {
      claudeConnected = false;
    }
  }
  claudeLiveCount = p.liveCount ?? p.sessions?.length ?? 0;

  // Fire connect/disconnect side effects only on debounced transitions - not
  // on every snapshot poll (which would re-fire toasts and overwrite `latest`).
  const justConnected = !was && claudeConnected;
  const justDisconnected = was && !claudeConnected;

  if (justConnected) {
    showConnToast(
      getLocale() === "zh-CN" ? "已检测到 Claude" : "Claude detected",
    );
    // Also push a soft live event so multi-session stack knows
    ingestLiveEvent({
      schema: "petdeck.event.v1",
      source: "claude-code",
      sessionId: p.sessions?.[0]?.sessionId || "claude-presence",
      sessionLabel: "live",
      ts: new Date().toISOString(),
      state: "idle",
      title: "Claude connected",
      detail: getLocale() === "zh-CN" ? "连接中 · 待命" : "Connected · idle",
      progress: { kind: "none" },
      needsAttention: false,
      stickyMs: 0,
    });
  }
  if (justDisconnected) {
    showConnToast(
      getLocale() === "zh-CN" ? "对话已关闭" : "Session closed",
    );
    // liveSource is intentionally kept (not cleared) so the adapter hint still
    // shows the last source after disconnect.
    if (latest && latest.source === "claude-code") {
      latest = {
        ...latest,
        state: "idle",
        title:
          getLocale() === "zh-CN" ? "对话已关闭" : "Session closed",
        detail: undefined,
        progress: { kind: "none" },
        needsAttention: false,
        ts: new Date().toISOString(),
      };
      renderEvent(latest);
    }
  }
  updateConnPanel();
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function win() {
  return getCurrentWindow();
}

async function resizeTo(mode: "pet" | "menu" | "inspector") {
  if (!isTauri()) return;
  try {
    let size = INSP_SIZE;
    if (mode === "menu") size = MENU_SIZE;
    else if (mode === "pet") {
      const multi = listSessions().filter((s) => s.event.state !== "idle").length > 1
        || listSessions().length > 1;
      size = multi ? PET_MULTI : PET_SIZE;
    }
    await (await win()).setSize(new LogicalSize(size.w, size.h));
  } catch {
    /* ignore */
  }
}

async function fitPetWindow() {
  if (menuOpen) return;
  if (!$("inspector").classList.contains("hidden")) return;
  await resizeTo("pet");
}

/** Must be invoked directly from a user gesture (no await before call). */
function startWindowDrag() {
  if (!isTauri()) return;
  try {
    // Fire-and-forget: awaiting first would drop the OS gesture on Windows
    void getCurrentWindow().startDragging();
  } catch {
    /* ignore */
  }
}

async function setAlwaysOnTop(on: boolean) {
  saveSettings({ alwaysOnTop: on });
  if (!isTauri()) return;
  try {
    await (await win()).setAlwaysOnTop(on);
  } catch {
    /* ignore */
  }
}

async function restorePosition() {
  if (!isTauri()) return;
  const s = loadSettings();
  if (s.windowX == null || s.windowY == null) return;
  try {
    await (await win()).setPosition(
      new PhysicalPosition(s.windowX, s.windowY),
    );
  } catch {
    /* ignore */
  }
}

async function persistPosition() {
  if (!isTauri()) return;
  if (dragging) return; // skip mid-drag; pointerup persists the final position
  try {
    const pos = await (await win()).outerPosition();
    saveSettings({ windowX: pos.x, windowY: pos.y });
  } catch {
    /* ignore */
  }
}

function refreshSkin() {
  const state = latest?.state ?? "idle";
  applySkinToDom($("pet"), getActiveSkin(), state);
  renderSkinLists();
}

function showToast(msg: string) {
  const el = $("skin-toast");
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.textContent = "";
  }, 3200);
}

let skinPopTargetId: string | null = null;

function hideSkinPop() {
  const pop = document.getElementById("skin-pop");
  if (pop) pop.classList.add("hidden");
  skinPopTargetId = null;
}

function showSkinPop(skinId: string, clientX: number, clientY: number) {
  const d = t();
  const skin = listAllSkins().find((s) => s.id === skinId);
  if (!skin) return;

  // Built-in: toast only, no delete popup
  if (skin.builtin) {
    showToast(d.ui.cannotDeleteBuiltin);
    return;
  }

  const pop = $("skin-pop");
  const loc = getLocale();
  $("skin-pop-name").textContent =
    loc === "zh-CN" ? skin.nameZh : skin.nameEn;
  $("skin-pop-delete").textContent = d.ui.deleteConfirm;
  $("skin-pop-cancel").textContent = d.ui.cancel;
  skinPopTargetId = skinId;

  pop.classList.remove("hidden");
  // Position inside viewport
  const pad = 8;
  const pw = 160;
  const ph = 100;
  let x = clientX;
  let y = clientY;
  x = Math.max(pad, Math.min(x, window.innerWidth - pw - pad));
  y = Math.max(pad, Math.min(y, window.innerHeight - ph - pad));
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

function confirmDeleteSkin() {
  const d = t();
  const id = skinPopTargetId;
  hideSkinPop();
  if (!id) return;
  const skin = listAllSkins().find((s) => s.id === id);
  if (!skin || skin.builtin) {
    showToast(d.ui.cannotDeleteBuiltin);
    return;
  }
  removeCustomSkin(id);
  refreshSkin();
  showToast(d.ui.deleted);
}

function renderSkinLists() {
  const d = t();
  const active = getActiveSkinId();
  const skins = listAllSkins();
  const loc = getLocale();

  // Context menu list
  const ctxList = $("ctx-skin-list");
  ctxList.innerHTML = "";
  for (const skin of skins) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item" + (skin.id === active ? " active-skin" : "");
    btn.dataset.action = "skin";
    btn.dataset.skinId = skin.id;
    const mark = skin.id === active ? "✓ " : "";
    const name = loc === "zh-CN" ? skin.nameZh : skin.nameEn;
    btn.textContent = `${mark}${name}`;
    btn.title = skin.builtin ? d.ui.cannotDeleteBuiltin : d.ui.deleteSkinHint;
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSkinPop(skin.id, e.clientX, e.clientY);
    });
    ctxList.appendChild(btn);
  }

  // Inspector grid
  const grid = $("skin-grid");
  grid.innerHTML = "";
  for (const skin of skins) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skin-card" + (skin.id === active ? " active" : "");
    card.dataset.skinId = skin.id;

    const preview = document.createElement("div");
    preview.className = "skin-card-preview";
    if (skin.kind === "image" && skin.imageDataUrl) {
      const img = document.createElement("img");
      img.src = skin.imageDataUrl;
      img.alt = "";
      if (skin.pixelated) img.style.imageRendering = "pixelated";
      preview.appendChild(img);
    } else if (skin.kind === "vector") {
      const vc = getVectorCharacter(skin.vectorId ?? "");
      if (vc) {
        preview.classList.add("vector-preview");
        preview.innerHTML = vc.svg;
      } else {
        preview.textContent = "◉";
      }
    } else if (skin.kind === "sprite") {
      const img = document.createElement("img");
      img.alt = "";
      if (skin.pixelated) img.style.imageRendering = "pixelated";
      preview.appendChild(img);
      void spriteImport.firstFrameSrc(skin).then((src) => {
        if (src) img.src = src;
        else img.replaceWith(Object.assign(document.createElement("span"), { textContent: "▷" }));
      });
    } else {
      preview.classList.add(`swatch-${skin.theme ?? "ember"}`);
      preview.textContent =
        skin.theme === "pixel-blob" ? "▣" : skin.theme === "ghost" ? "◌" : "◕";
    }

    const name = document.createElement("div");
    name.className = "skin-card-name";
    name.textContent = loc === "zh-CN" ? skin.nameZh : skin.nameEn;

    const tag = document.createElement("div");
    tag.className = "skin-card-tag";
    tag.textContent = skin.builtin ? d.ui.skinBuiltin : d.ui.skinCustom;
    if (skin.id === active) tag.textContent += ` · ${d.ui.skinActive}`;

    card.append(preview, name, tag);
    card.title = skin.builtin ? d.ui.cannotDeleteBuiltin : d.ui.deleteSkinHint;
    card.addEventListener("click", () => {
      hideSkinPop();
      setActiveSkinId(skin.id);
      refreshSkin();
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSkinPop(skin.id, e.clientX, e.clientY);
    });
    grid.appendChild(card);
  }
}

function applyI18n() {
  const d = t();
  document.title = d.appName;

  const headTitle = document.getElementById("ctx-head-title");
  if (headTitle) headTitle.textContent = d.appName;

  $("ctx-bubble").textContent = showBubble
    ? d.ui.hideBubble
    : d.ui.showBubble;
  $("ctx-more").textContent = d.ui.moreInfo;
  $("ctx-lang-label").textContent = d.ui.language;
  $("ctx-zh").textContent = d.ui.chinese;
  $("ctx-en").textContent = d.ui.english;
  $("ctx-skins-label").textContent = d.ui.skins;
  $("ctx-import").textContent = d.ui.importImage;
  $("ctx-import-pixel").textContent = d.ui.importPixel;
  $("ctx-import-sprite").textContent = d.ui.importSprite;
  $("ctx-import-sprite-img").textContent = d.ui.importSpriteImg;
  $("ctx-ontop-label").textContent = d.ui.alwaysOnTop;
  $("ctx-demo").textContent = demoPlaying ? d.ui.demoPause : d.ui.demoPlay;
  $("ctx-step").textContent = d.ui.demoStep;
  $("ctx-reset").textContent = d.ui.demoReset;
  $("ctx-quit").textContent = d.ui.quit;

  $("insp-title").textContent = d.appName;
  $("insp-tag").textContent = d.tagline;
  $("insp-close").textContent = d.ui.closeInspector;
  $("insp-skins-title").textContent = d.ui.skins;
  $("label-progress").textContent = d.ui.progress;
  $("label-host").textContent = d.ui.host;
  $("label-version").textContent = d.ui.version;
  $("host-value").textContent = d.ui.hostClaude;
  $("btn-step").textContent = d.ui.demoStep;
  $("btn-reset").textContent = d.ui.demoReset;
  $("btn-play").textContent = demoPlaying ? d.ui.demoPause : d.ui.demoPlay;
  $("btn-import").textContent = d.ui.importImage;
  $("btn-import-pixel").textContent = d.ui.importPixel;
  $("btn-import-sprite").textContent = d.ui.importSprite;
  $("btn-import-sprite-img").textContent = d.ui.importSpriteImg;
  $("btn-delete-skin").textContent = d.ui.deleteSkin;
  // pixel-size / pixel-colors inputs were removed from index.html (the doll
  // importer uses the fine/standard/chunky quality presets + opt-subject
  // instead). Guard these: a missing element used to throw here, aborting
  // boot() before it could wire the Claude presence listener.
  const lblSize = document.getElementById("label-pixel-size");
  if (lblSize) lblSize.textContent = d.ui.pixelSize;
  const lblColors = document.getElementById("label-pixel-colors");
  if (lblColors) lblColors.textContent = d.ui.pixelColors;
  $("label-subject-only").textContent = d.ui.subjectOnly;
  $("label-quality").textContent = d.ui.quality;
  $("q-fine").textContent = d.ui.qualityFine;
  $("q-standard").textContent = d.ui.qualityStandard;
  $("q-chunky").textContent = d.ui.qualityChunky;
  const dollHint = document.getElementById("hint-doll-mode");
  if (dollHint) dollHint.textContent = d.ui.dollModeHint;
  const delHint = document.getElementById("hint-delete-skin");
  if (delHint) delHint.textContent = d.ui.deleteSkinHint;
  const ctxDel = document.getElementById("ctx-delete-hint");
  if (ctxDel) ctxDel.textContent = d.ui.deleteSkinHint;
  document.querySelectorAll(".quality-btn").forEach((el) => {
    el.classList.toggle(
      "active",
      (el as HTMLElement).dataset.quality === pixelQuality,
    );
  });
  $("drag-hint").textContent = d.ui.dragHint;
  $("mood-title").textContent = d.ui.moodTitle;
  $("mood-hint").textContent = d.ui.moodHint;
  $("mood-working-label").textContent = d.ui.moodWorking;
  $("mood-success-label").textContent = d.ui.moodSuccess;
  $("mood-idle-label").textContent = d.ui.moodIdle;
  $("mood-save").textContent = d.ui.moodSave;
  $("mood-reset").textContent = d.ui.moodReset;
  let liveLine = getClaudeAdapterStatus().message;
  if (liveSource && Date.now() - liveAt < 300_000) {
    const ago = Math.round((Date.now() - liveAt) / 1000);
    liveLine =
      (getLocale() === "zh-CN"
        ? `● 已检测到 Claude 事件（${ago}s 前）· ${liveSource}\n最近：${latest?.title ?? "—"}\n拖动/换肤不受影响`
        : `● Claude event ${ago}s ago · ${liveSource}\nLast: ${latest?.title ?? "—"}\nDrag/skins still work`) +
      "\n" +
      liveLine;
  } else if (getLocale() === "zh-CN") {
    liveLine =
      "若 Claude 在干活但这里一直空闲：可能是事件被过早清掉（已修复），请重启 PetDeck 后再试。\n" +
      liveLine;
  }
  $("adapter-hint").textContent = liveLine;

  // Vestigial pixel-size / pixel-colors inputs (removed from index.html) -
  // guard so they can't throw.
  const pxSize = document.getElementById("pixel-size") as HTMLInputElement | null;
  const pxSizeVal = document.getElementById("pixel-size-val");
  if (pxSize && pxSizeVal) pxSizeVal.textContent = String(pxSize.value);
  const pxColors = document.getElementById("pixel-colors") as HTMLInputElement | null;
  const pxColorsVal = document.getElementById("pixel-colors-val");
  if (pxColors && pxColorsVal) pxColorsVal.textContent = String(pxColors.value);

  if (latest) renderEvent(latest);
  else {
    $("status-title").textContent = d.ui.noEvent;
    $("status-detail").textContent = "";
    $("state-pill").textContent = d.state.idle;
    updateBubble(null);
    refreshSkin();
  }
  renderSkinLists();
  updateConnPanel();
}

function stateLabel(state: AgentState): string {
  return t().state[state] ?? state;
}

/** User-editable mood-line pools (null = use i18n defaults). */
let _workingMsgs: string[] | null = null;
let _completionMsgs: string[] | null = null;
let _idleMsgs: string[] | null = null;

function workingMessages(): string[] {
  return _workingMsgs ?? t().ui.workingMessages;
}
function completionMessages(): string[] {
  return _completionMsgs ?? t().ui.completionMessages;
}
function idleMessages(): string[] {
  return _idleMsgs ?? t().ui.idleMessages;
}

const WORKING_STATES = new Set<AgentState>([
  "thinking",
  "tool_call",
  "editing",
  "running_tests",
]);

/** Stable-per-event pick from a pool, seeded by `seed` (event ts) so re-renders
 *  don't flicker the chosen line. */
function pickSeeded(pool: string[], seed: string): string {
  if (!pool || pool.length === 0) return "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length]!;
}

function completionMessage(seed: string): string {
  return pickSeeded(completionMessages(), seed);
}
function workingMessage(seed: string): string {
  return pickSeeded(workingMessages(), seed);
}

/** Idle lines rotate over time (not per-event) so the standby bubble feels
 *  alive without flickering on every re-render. */
let _idleIdx = 0;
let _currentIdleMsg = "";
function pickNextIdle(): string {
  const pool = idleMessages();
  if (pool.length === 0) {
    _currentIdleMsg = "";
    return "";
  }
  _idleIdx = (_idleIdx + 1) % pool.length;
  _currentIdleMsg = pool[_idleIdx] ?? "";
  return _currentIdleMsg;
}
function idleMessageForBubble(): string {
  if (!_currentIdleMsg) pickNextIdle();
  return _currentIdleMsg;
}

/** Display title for an event - success / working show a cute mood line
 *  instead of the raw "Reply finished" / "Editing X". */
function displayTitle(event: AgentEvent): string {
  if (event.state === "success") {
    const cm = completionMessage(event.ts);
    if (cm) return cm;
  } else if (WORKING_STATES.has(event.state)) {
    const wm = workingMessage(event.ts);
    if (wm) return wm;
  }
  return event.title || stateLabel(event.state);
}

// —— 成功礼花：进入 success 状态时边沿触发（8s 冷却防连喷） ——
let _prevBubbleState: AgentState | null = null;
let _lastConfettiAt = 0;
function maybeConfetti(state: AgentState) {
  const entering = state === "success" && _prevBubbleState !== "success";
  _prevBubbleState = state;
  if (!entering || !isTauri()) return;
  const now = Date.now();
  if (now - _lastConfettiAt < 8000) return;
  _lastConfettiAt = now;
  void invoke("confetti_burst").catch((e) => {
    // 失败别静默：打到终端日志，方便排查 ACL/窗口问题
    void invoke("ui_log", { message: `confetti error: ${e}` }).catch(() => {});
  });
}

function updateBubble(event: AgentEvent | null) {
  const bubble = $("bubble");
  if (!event || !showBubble) {
    bubble.classList.add("hidden");
    return;
  }
  maybeConfetti(event.state);

  // Per-state title/detail/visibility. Mood lines (working / completion /
  // idle) replace the raw title; the technical info drops to the detail line so
  // the user still sees what Claude is doing.
  let title = "";
  let detail = "";
  let show: boolean;
  if (event.state === "success") {
    title = displayTitle(event);
    detail = event.detail ?? "";
    show = true;
  } else if (WORKING_STATES.has(event.state)) {
    title = workingMessage(event.ts) || event.title || stateLabel(event.state);
    detail = event.detail || event.title || "";
    show = true;
    _currentIdleMsg = ""; // leaving standby - next idle picks a fresh line
  } else if (event.state === "idle") {
    if (claudeConnected) {
      // Standby: show a rotating cute idle line.
      title = idleMessageForBubble();
      detail = "";
      show = true;
    } else {
      show = false; // Claude closed -> hide
    }
  } else {
    // waiting_user, error
    title = event.title || stateLabel(event.state);
    detail = event.detail ?? "";
    show = true;
    _currentIdleMsg = "";
  }

  if (!show) {
    bubble.classList.add("hidden");
    return;
  }

  bubble.classList.remove("hidden");
  bubble.dataset.state = event.state;
  const sessEl = document.getElementById("bubble-session");
  if (sessEl) {
    const label = event.sessionLabel || event.sessionId?.slice(-6) || "";
    sessEl.textContent = event.source
      ? `${event.source}${label ? " · " + label : ""}`
      : label;
  }
  $("bubble-state").textContent = stateLabel(event.state);
  $("bubble-title").textContent = title;
  $("bubble-detail").textContent = detail;

  const wrap = $("bubble-progress-wrap");
  const bar = $("bubble-progress-bar");
  const kind = event.progress?.kind ?? "none";
  if (kind === "none") {
    wrap.classList.add("hidden");
  } else {
    wrap.classList.remove("hidden");
    wrap.classList.toggle("indeterminate", kind === "indeterminate");
    if (kind === "ratio") {
      const v = Math.max(0, Math.min(1, event.progress?.value ?? 0));
      bar.style.width = `${Math.round(v * 100)}%`;
    } else {
      bar.style.width = "40%";
    }
  }

  if (idleHideTimer) clearTimeout(idleHideTimer);
  if (event.state === "success") {
    // Completion line lingers ~5s so the user can read it.
    idleHideTimer = setTimeout(() => {
      if (latest?.state === "success") bubble.classList.add("hidden");
    }, 5000);
  }
}

const VALID_STATES = new Set<AgentState>([
  "idle",
  "thinking",
  "tool_call",
  "editing",
  "waiting_user",
  "running_tests",
  "success",
  "error",
]);

function normalizeAgentEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const state = String(o.state ?? "") as AgentState;
  if (!VALID_STATES.has(state)) return null;
  const stickyRaw = o.stickyMs ?? o.sticky_ms;
  return {
    schema: "petdeck.event.v1",
    source: String(o.source ?? "claude-code"),
    sessionId: String(o.sessionId ?? o.session_id ?? "session"),
    ts: String(o.ts ?? new Date().toISOString()),
    state,
    title: String(o.title ?? state).slice(0, 120),
    detail: o.detail != null ? String(o.detail).slice(0, 200) : undefined,
    progress:
      o.progress && typeof o.progress === "object"
        ? (o.progress as AgentEvent["progress"])
        : { kind: "indeterminate" },
    needsAttention: Boolean(o.needsAttention ?? o.needs_attention),
    stickyMs:
      typeof stickyRaw === "number"
        ? stickyRaw
        : stickyRaw != null
          ? Number(stickyRaw)
          : undefined,
    sessionLabel:
      o.sessionLabel != null
        ? String(o.sessionLabel)
        : o.session_label != null
          ? String(o.session_label)
          : undefined,
  };
}

const sessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoIdle(event: AgentEvent) {
  const sid = event.sessionId;
  const prev = sessionIdleTimers.get(sid);
  if (prev) clearTimeout(prev);

  if (event.state === "waiting_user" || event.state === "error") return;
  if (event.state === "idle") {
    void fitPetWindow();
    return;
  }

  /**
   * Critical fix: while Claude is mid-tool (read/edit/bash), do NOT clear to idle
   * after a few seconds — wait for PostToolUse / Stop. Only a long safety timeout.
   * Previously sticky ~4–8s made long reads look like "never detected".
   */
  let ms = event.stickyMs ?? 0;
  if (!ms || Number.isNaN(ms)) {
    if (event.state === "success") ms = 2200;
    else if (event.state === "thinking") ms = 45_000;
    else if (
      event.state === "tool_call" ||
      event.state === "editing" ||
      event.state === "running_tests"
    ) {
      ms = 15 * 60_000; // 15 min safety only
    } else ms = 30_000;
  }
  // Honor long sticky from bridge; bump short sticky for tool states
  if (
    (event.state === "tool_call" ||
      event.state === "editing" ||
      event.state === "running_tests") &&
    ms < 60_000
  ) {
    ms = 15 * 60_000;
  }

  const eventKey = `${sid}|${event.ts}|${event.state}|${event.title}`;
  const timer = setTimeout(() => {
    sessionIdleTimers.delete(sid);
    // Only clear if this session still shows the same busy event
    const slotsNow = listSessions();
    const cur = slotsNow.find((s) => s.id === sid);
    if (!cur) return;
    const same =
      cur.event.state === event.state &&
      cur.event.title === event.title &&
      (Date.now() - cur.updatedAt >= ms - 500);
    if (!same && cur.event.state !== event.state) return;
    if (cur.event.state === "waiting_user" || cur.event.state === "error") return;
    if (cur.event.state === "idle") return;

    const idle: AgentEvent = {
      schema: "petdeck.event.v1",
      source: event.source,
      sessionId: sid,
      sessionLabel: event.sessionLabel,
      ts: new Date().toISOString(),
      state: "idle",
      title: "Ready",
      detail: "Timed out waiting for next event",
      progress: { kind: "none" },
      needsAttention: false,
    };
    const slots = markIdle(sid, idle);
    const primary = primarySession();
    renderSessions(slots);
    if (primary) {
      latest = primary.event;
      renderEvent(primary.event);
    } else {
      latest = idle;
      renderEvent(idle);
    }
    void fitPetWindow();
    applyI18n();
  }, ms);
  sessionIdleTimers.set(sid, timer);
  void eventKey;
}

function renderSessions(slots = listSessions()) {
  const stack = document.getElementById("session-stack");
  if (!stack) return;

  // Primary = most recent — shown in main bubble; extras in stack
  const [primary, ...rest] = slots;
  stack.innerHTML = "";

  if (primary) {
    const sessEl = document.getElementById("bubble-session");
    if (sessEl) {
      sessEl.textContent = `${primary.source} · ${primary.label}`;
      sessEl.classList.toggle("hidden", false);
    }
  }

  for (const s of rest.slice(0, 4)) {
    if (s.event.state === "idle" && Date.now() - s.updatedAt > 8000) continue;
    const card = document.createElement("div");
    card.className = "session-card";
    card.dataset.state = s.event.state;
    card.innerHTML = `
      <div class="sc-head"><span>${escapeHtml(s.source)}</span><span>#${escapeHtml(s.label)}</span></div>
      <div class="sc-title">${escapeHtml(s.event.title || s.event.state)}</div>
      ${s.event.detail ? `<div class="sc-detail">${escapeHtml(s.event.detail)}</div>` : ""}
    `;
    stack.appendChild(card);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Dedup key so emit + poll do not double-apply the same event. */
const seenEventKeys = new Set<string>();
let lastPulledSeq = 0;

function eventDedupeKey(raw: unknown, event: AgentEvent): string {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o._seq != null) return `seq:${o._seq}`;
  }
  return `${event.sessionId}|${event.ts}|${event.state}|${event.title}|${event.detail ?? ""}`;
}

function uiLog(msg: string) {
  console.log("[pettty-ui]", msg);
  if (!isTauri()) return;
  void invoke("ui_log", { message: msg }).catch(() => {
    /* ignore ACL / early boot */
  });
}

/** Live events from bridge stop the demo player so real status wins. */
function ingestLiveEvent(raw: unknown) {
  const event = normalizeAgentEvent(raw);
  if (!event) {
    uiLog(`drop event (normalize failed): ${JSON.stringify(raw)?.slice(0, 120)}`);
    return;
  }
  const key = eventDedupeKey(raw, event);
  if (seenEventKeys.has(key)) return;
  seenEventKeys.add(key);
  if (seenEventKeys.size > 200) {
    const first = seenEventKeys.values().next().value;
    if (first) seenEventKeys.delete(first);
  }

  if (demoPlaying) {
    player.pause();
    demoPlaying = false;
  }
  liveSource = event.source;
  liveAt = Date.now();
  // SessionStart (and the soft event injected by onClaudePresence when presence
  // first detects Claude) both arrive titled "Claude connected" - count that as
  // a connection signal for the short grace in updateConnPanel, so opening
  // Claude lights the indicator instantly. Stop / SessionEnd do NOT match, so
  // closing Claude lets the indicator drop to "closed" right away.
  if (event.title.toLowerCase().includes("claude connected")) {
    liveConnectAt = Date.now();
  }

  // Track ring seq if present
  if (raw && typeof raw === "object") {
    const seq = Number((raw as Record<string, unknown>)._seq);
    if (Number.isFinite(seq) && seq > lastPulledSeq) lastPulledSeq = seq;
  }

  uiLog(
    `applied ${event.state} · ${event.title} · ${event.sessionLabel ?? event.sessionId.slice(-6)}`,
  );

  // Force bubble visible for live work (user may have toggled off demo idle)
  if (event.state !== "idle") {
    showBubble = true;
  }

  const slots = upsertSession(event);
  const primary = primarySession();
  if (primary) {
    latest = primary.event;
    renderEvent(primary.event);
  } else {
    renderEvent(event);
  }
  renderSessions(slots);
  scheduleAutoIdle(event);
  updateConnPanel();
  void fitPetWindow();
  applyI18n();
}

// Bridge injects via webview.eval — works even when emit/listen fails
declare global {
  interface Window {
    __petdeckIngest?: (raw: unknown) => void;
    __petdeckPending?: unknown[];
  }
}
window.__petdeckIngest = (raw: unknown) => {
  try {
    ingestLiveEvent(raw);
  } catch (e) {
    console.error("[pettty] ingest failed", e);
  }
};
// Drain events injected before boot finished
if (Array.isArray(window.__petdeckPending)) {
  for (const p of window.__petdeckPending) ingestLiveEvent(p);
  window.__petdeckPending = [];
}

/**
 * Poll ring buffer every 250ms — HTTP first (always works), then Tauri invoke.
 */
async function pollAgentEvents() {
  // Prefer HTTP: proven path (same as send-test-event.ps1)
  try {
    const r = await fetch(
      `http://127.0.0.1:7788/events?after=${lastPulledSeq}`,
      { cache: "no-store" },
    );
    if (r.ok) {
      const data = (await r.json()) as { lastSeq?: number; events?: unknown[] };
      for (const ev of data.events ?? []) ingestLiveEvent(ev);
      if (typeof data.lastSeq === "number" && data.lastSeq > lastPulledSeq) {
        lastPulledSeq = data.lastSeq;
      }
      return;
    }
  } catch {
    /* try invoke */
  }

  if (!isTauri()) return;
  try {
    const data = await invoke<{ lastSeq: number; events: unknown[] }>(
      "pull_agent_events",
      { afterSeq: lastPulledSeq },
    );
    for (const ev of data.events ?? []) ingestLiveEvent(ev);
    if (typeof data.lastSeq === "number" && data.lastSeq > lastPulledSeq) {
      lastPulledSeq = data.lastSeq;
    }
  } catch {
    /* bridge down */
  }
}

function renderEvent(event: AgentEvent) {
  latest = event;
  applySkinToDom($("pet"), getActiveSkin(), event.state);
  updateBubble(event);

  const dict = t();
  const pill = $("state-pill");
  pill.textContent = stateLabel(event.state);
  pill.dataset.state = event.state;
  $("status-title").textContent = displayTitle(event);
  $("status-detail").textContent = event.detail ?? dict.petMood[event.state];
  $("source-label").textContent =
    event.source === "claude-code"
      ? dict.source["claude-code"]
      : event.source;

  const track = $("progress-track");
  const bar = $("progress-bar");
  const progressText = $("progress-text");
  const kind = event.progress?.kind ?? "none";
  track.classList.toggle("indeterminate", kind === "indeterminate");
  if (kind === "ratio") {
    const v = Math.max(0, Math.min(1, event.progress?.value ?? 0));
    bar.style.width = `${Math.round(v * 100)}%`;
    progressText.textContent = `${Math.round(v * 100)}%`;
  } else if (kind === "indeterminate") {
    bar.style.width = "40%";
    progressText.textContent = "…";
  } else {
    bar.style.width = "0%";
    progressText.textContent = "—";
  }
}

let menuOpen = false;

async function hideCtx() {
  $("ctx").classList.add("hidden");
  document.body.classList.remove("menu-open");
  if (menuOpen) {
    menuOpen = false;
    // only shrink if not in inspector
    if (!$("inspector").classList.contains("hidden")) return;
    await resizeTo("pet");
  }
}

async function showCtx(_x: number, _y: number) {
  renderSkinLists();
  const menu = $("ctx");
  menuOpen = true;
  document.body.classList.add("menu-open");
  // Grow window first so the full menu (with scroll) fits
  await resizeTo("menu");
  menu.classList.remove("hidden");
  // Panel mode: fill the expanded window, scroll inside
  menu.style.left = "0";
  menu.style.top = "0";
  menu.style.right = "0";
  menu.style.bottom = "0";
  menu.style.width = "100%";
  menu.style.height = "100%";
  // focus menu so wheel scroll works reliably
  menu.focus({ preventScroll: true });
}

async function openInspector() {
  await hideCtx();
  document.body.classList.add("mode-inspector");
  $("inspector").classList.remove("hidden");
  $("shell").classList.add("hidden");
  await resizeTo("inspector");
  applyI18n();
  populateMood();
}

async function closeInspector() {
  document.body.classList.remove("mode-inspector");
  $("inspector").classList.add("hidden");
  $("shell").classList.remove("hidden");
  await resizeTo("pet");
  applyI18n();
}

async function quitApp() {
  await persistPosition();
  if (!isTauri()) {
    window.close();
    return;
  }
  try {
    await (await win()).close();
  } catch {
    /* ignore */
  }
}

function toggleDemo() {
  if (demoPlaying) {
    player.pause();
    demoPlaying = false;
  } else {
    player.play(1500);
    demoPlaying = true;
  }
  applyI18n();
}

function applyQualityPreset(q: PixelQuality) {
  pixelQuality = q;
  applyI18n();
}

function stageLabel(stage: string): string {
  const d = t().ui;
  switch (stage) {
    case "load":
      return d.stageLoad;
    case "isolate":
      return d.stageIsolate;
    case "analyze":
      return d.stageAnalyze;
    case "draw":
      return d.stageDraw;
    case "done":
      return d.stageDone;
    default:
      return d.pixelWorking;
  }
}

async function importImage(asPixel: boolean) {
  const input = $(asPixel ? "file-pixel" : "file-import") as unknown as HTMLInputElement;
  input.value = "";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const d = t();
    try {
      let dataUrl = await fileToDataUrl(file);
      let pixelated = false;

      if (asPixel) {
        setWorkProgress(0.02, d.ui.pixelWorking);
        const subjectOnly = ($("opt-subject") as unknown as HTMLInputElement)
          .checked;
        // Doll width by quality preset
        const width =
          pixelQuality === "fine" ? 128 : pixelQuality === "standard" ? 44 : 28;
        dataUrl = await makePixelDollFromImage(dataUrl, {
          isolate: subjectOnly,
          width,
          onProgress: (stage, ratio) => {
            setWorkProgress(ratio, stageLabel(stage));
          },
        });
        pixelated = true;
      } else {
        dataUrl = await normalizeImport(dataUrl, 360);
      }

      const base = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Custom";
      const skin: SkinMeta = {
        id: makeCustomId(asPixel ? "doll" : "img"),
        nameEn: base,
        nameZh: base,
        kind: "image",
        builtin: false,
        imageDataUrl: dataUrl,
        pixelated,
        createdAt: new Date().toISOString(),
      };
      addCustomSkin(skin);
      setActiveSkinId(skin.id);
      refreshSkin();
      showToast(asPixel ? d.ui.pixelOk : d.ui.importOk);
    } catch (err) {
      console.error(err);
      showToast(d.ui.importFail);
    } finally {
      hideWorkProgress();
    }
  };
  input.click();
}

/** Import a DyberPet character folder as a sprite skin: pick folder, discover
 *  actions, show a mapping dialog, then build + store (IndexedDB) + activate. */
async function importSprite() {
  const input = $("file-sprite") as unknown as HTMLInputElement;
  input.value = "";
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    const d = t();
    try {
      const actionMap = spriteImport.discoverActions(files);
      const actionNames = Array.from(actionMap.keys()).sort();
      if (!actionNames.length) {
        showToast(d.ui.spriteImportFail);
        return;
      }
      const auto = spriteImport.defaultMapping(actionNames);
      const defaultName =
        (await spriteImport.readCharName(files)) || folderName(files);
      openSpriteMappingDialog(actionNames, auto, defaultName, (mapping, name) => {
        void buildAndSaveSprite(files, mapping, name);
      });
    } catch (err) {
      console.error(err);
      showToast(d.ui.importFail);
    }
  };
  input.click();
}

function folderName(files: File[]): string {
  const p = files[0]?.webkitRelativePath || files[0]?.name || "";
  return p.split(/[\\/]/)[0] || "Sprite";
}

async function buildAndSaveSprite(
  files: File[],
  mapping: Partial<Record<AgentState, string>>,
  name: string,
) {
  const d = t();
  try {
    setWorkProgress(0.02, d.ui.spriteWorking);
    const skin = await spriteImport.buildSpriteSkin(files, mapping, name, (p) =>
      setWorkProgress(p.ratio, `${d.ui.spriteWorking} · ${p.label}`),
    );
    addCustomSkin(skin);
    setActiveSkinId(skin.id);
    refreshSkin();
    showToast(d.ui.spriteImportOk);
  } catch (err) {
    console.error(err);
    showToast(d.ui.importFail);
  } finally {
    hideWorkProgress();
  }
}

const SPRITE_STATES: AgentState[] = [
  "idle",
  "thinking",
  "tool_call",
  "editing",
  "waiting_user",
  "running_tests",
  "success",
  "error",
];

/** Modal listing each PetDeck state with a <select> of discovered DyberPet
 *  actions (defaulted to the auto-mapping). On confirm, builds the skin. */
function openSpriteMappingDialog(
  actionNames: string[],
  auto: Partial<Record<AgentState, string>>,
  defaultName: string,
  onConfirm: (mapping: Partial<Record<AgentState, string>>, name: string) => void,
) {
  const d = t();
  const overlay = document.createElement("div");
  overlay.className = "sprite-map-overlay";
  const panel = document.createElement("div");
  panel.className = "sprite-map-panel";

  const title = document.createElement("div");
  title.className = "sprite-map-title";
  title.textContent = d.ui.spriteMappingTitle;
  panel.appendChild(title);

  const nameLabel = document.createElement("label");
  nameLabel.className = "sprite-map-name";
  const nameCaption = document.createElement("span");
  nameCaption.textContent = d.ui.skins;
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = defaultName;
  nameLabel.append(nameCaption, nameInput);
  panel.appendChild(nameLabel);

  const selects: Partial<Record<AgentState, HTMLSelectElement>> = {};
  for (const st of SPRITE_STATES) {
    const row = document.createElement("div");
    row.className = "sprite-map-row";
    const lbl = document.createElement("span");
    lbl.textContent = d.state[st];
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "—";
    sel.appendChild(none);
    for (const a of actionNames) {
      const o = document.createElement("option");
      o.value = a;
      o.textContent = a;
      sel.appendChild(o);
    }
    if (auto[st]) sel.value = auto[st]!;
    selects[st] = sel;
    row.append(lbl, sel);
    panel.appendChild(row);
  }

  const btns = document.createElement("div");
  btns.className = "sprite-map-btns";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = d.ui.cancel;
  const ok = document.createElement("button");
  ok.className = "btn";
  ok.textContent = d.ui.moodSave;
  btns.append(cancel, ok);
  panel.appendChild(btns);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  ok.onclick = () => {
    const mapping: Partial<Record<AgentState, string>> = {};
    for (const st of SPRITE_STATES) {
      const v = selects[st]!.value;
      if (v) mapping[st] = v;
    }
    const name = nameInput.value.trim() || defaultName;
    close();
    onConfirm(mapping, name);
  };
}

/** Import a single image and synthesize per-state action frames into a sprite
 *  skin (breathing / tilt / hop / shake …). Lets any image character animate
 *  like a DyberPet mod. Best with a transparent-background character PNG. */
async function importSpriteFromImage() {
  const input = $("file-sprite-img") as unknown as HTMLInputElement;
  input.value = "";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const d = t();
    try {
      let dataUrl = await fileToDataUrl(file);
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Sprite";
      // 抠图: isolate the subject so only the character animates, not the bg
      setWorkProgress(0.05, d.ui.stageIsolate);
      try {
        dataUrl = await isolateSubject(dataUrl);
      } catch (e) {
        console.warn("[petdeck] subject isolation failed, using original", e);
      }
      setWorkProgress(0.15, d.ui.spriteWorking);
      const skin = await synthesizeSpriteFromImage(dataUrl, name, (p) =>
        setWorkProgress(0.15 + p.ratio * 0.85, `${d.ui.spriteWorking} · ${p.label}`),
      );
      addCustomSkin(skin);
      setActiveSkinId(skin.id);
      refreshSkin();
      showToast(d.ui.spriteImportOk);
    } catch (err) {
      console.error(err);
      showToast(d.ui.importFail);
    } finally {
      hideWorkProgress();
    }
  };
  input.click();
}

function populateMood() {
  const set = (id: string, arr: string[]) => {
    const el = $(id) as unknown as HTMLTextAreaElement | null;
    if (el) el.value = arr.join("\n");
  };
  set("mood-working", workingMessages());
  set("mood-success", completionMessages());
  set("mood-idle", idleMessages());
}

function parseMoodArea(id: string): string[] {
  const el = $(id) as unknown as HTMLTextAreaElement | null;
  if (!el) return [];
  return el.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function flashMoodToast(msg: string) {
  const toast = $("mood-toast");
  if (!toast) return;
  toast.textContent = msg;
  setTimeout(() => {
    if (toast) toast.textContent = "";
  }, 2000);
}

function saveMood() {
  const w = parseMoodArea("mood-working");
  const c = parseMoodArea("mood-success");
  const i = parseMoodArea("mood-idle");
  const next = saveSettings({
    workingMessages: w.length ? w : null,
    completionMessages: c.length ? c : null,
    idleMessages: i.length ? i : null,
  });
  _workingMsgs = next.workingMessages ?? null;
  _completionMsgs = next.completionMessages ?? null;
  _idleMsgs = next.idleMessages ?? null;
  _currentIdleMsg = ""; // force a fresh idle pick next standby
  flashMoodToast(t().ui.moodSaved);
  if (latest) renderEvent(latest);
  else applyI18n();
}

function resetMood() {
  const next = saveSettings({
    workingMessages: null,
    completionMessages: null,
    idleMessages: null,
  });
  _workingMsgs = next.workingMessages ?? null;
  _completionMsgs = next.completionMessages ?? null;
  _idleMsgs = next.idleMessages ?? null;
  _currentIdleMsg = "";
  populateMood();
  flashMoodToast(t().ui.moodResetDone);
  if (latest) renderEvent(latest);
  else applyI18n();
}

function wireUi() {
  const petHit = $("pet-hit");

  // Explicit drag — data-tauri-drag-region is unreliable on transparent Win windows
  petHit.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (menuOpen) return;
    if (!$("inspector").classList.contains("hidden")) return;
    spritePlayer.pause(); // freeze the frame loop during drag to keep it smooth
    dragging = true;
    startWindowDrag();
  });
  petHit.addEventListener("pointerup", () => {
    dragging = false;
    spritePlayer.resume();
    void persistPosition();
  });

  petHit.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void showCtx(e.clientX, e.clientY);
  });

  $("shell").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void showCtx(e.clientX, e.clientY);
  });

  // Close menu when clicking the dimmed shell behind (if any)
  document.addEventListener("click", (e) => {
    const ctx = $("ctx");
    if (ctx.classList.contains("hidden")) return;
    if (ctx.contains(e.target as Node)) return;
    void hideCtx();
  });

  // Escape closes menu
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) void hideCtx();
  });

  $("ctx").addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as
      | HTMLElement
      | null;
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "skin" && btn.dataset.skinId) {
      setActiveSkinId(btn.dataset.skinId);
      refreshSkin();
      await hideCtx();
      return;
    }

    if (action === "close-menu") {
      await hideCtx();
      return;
    }

    switch (action) {
      case "toggle-bubble":
        showBubble = !showBubble;
        saveSettings({ showBubble });
        updateBubble(latest);
        await hideCtx();
        applyI18n();
        break;
      case "more":
        await openInspector();
        break;
      case "lang-zh":
        setLocale("zh-CN");
        saveSettings({ locale: "zh-CN" });
        applyI18n();
        await hideCtx();
        break;
      case "lang-en":
        setLocale("en");
        saveSettings({ locale: "en" });
        applyI18n();
        await hideCtx();
        break;
      case "import":
        await hideCtx();
        await importImage(false);
        break;
      case "import-pixel":
        await hideCtx();
        await importImage(true);
        break;
      case "import-sprite":
        await hideCtx();
        void importSprite();
        break;
      case "import-sprite-img":
        await hideCtx();
        void importSpriteFromImage();
        break;
      case "demo-play":
        toggleDemo();
        await hideCtx();
        break;
      case "demo-step":
        player.pause();
        demoPlaying = false;
        player.step();
        applyI18n();
        await hideCtx();
        break;
      case "demo-reset":
        player.stop();
        demoPlaying = false;
        player.load(buildDemoEvents());
        {
          const first = player.current();
          if (first) renderEvent(first);
        }
        applyI18n();
        await hideCtx();
        break;
      case "quit":
        await quitApp();
        break;
      default:
        break;
    }
  });

  const onTop = $("ctx-ontop") as unknown as HTMLInputElement;
  onTop.addEventListener("change", () => {
    void setAlwaysOnTop(onTop.checked);
  });

  const inspHead = document.querySelector(".insp-head") as HTMLElement | null;
  inspHead?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    startWindowDrag();
  });

  $("insp-close").addEventListener("click", () => void closeInspector());
  $("btn-play").addEventListener("click", () => toggleDemo());
  $("btn-step").addEventListener("click", () => {
    player.pause();
    demoPlaying = false;
    player.step();
    applyI18n();
  });
  $("btn-reset").addEventListener("click", () => {
    player.stop();
    demoPlaying = false;
    player.load(buildDemoEvents());
    const first = player.current();
    if (first) renderEvent(first);
    applyI18n();
  });

  $("btn-import").addEventListener("click", () => void importImage(false));
  $("btn-import-pixel").addEventListener("click", () => void importImage(true));
  $("btn-import-sprite").addEventListener("click", () => void importSprite());
  $("btn-import-sprite-img").addEventListener("click", () => void importSpriteFromImage());
  $("btn-delete-skin").addEventListener("click", () => {
    const skin = getActiveSkin();
    if (skin.builtin) {
      showToast(t().ui.cannotDeleteBuiltin);
      return;
    }
    // Show popup near button for consistency
    const rect = $("btn-delete-skin").getBoundingClientRect();
    showSkinPop(skin.id, rect.left, rect.bottom + 4);
  });

  $("skin-pop-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    confirmDeleteSkin();
  });
  $("skin-pop-cancel").addEventListener("click", (e) => {
    e.stopPropagation();
    hideSkinPop();
  });
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("skin-pop");
    if (!pop || pop.classList.contains("hidden")) return;
    if (pop.contains(e.target as Node)) return;
    hideSkinPop();
  });

  document.querySelectorAll(".quality-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = (btn as HTMLElement).dataset.quality as PixelQuality;
      if (q) applyQualityPreset(q);
    });
  });

  $("mood-save").addEventListener("click", () => saveMood());
  $("mood-reset").addEventListener("click", () => resetMood());

  petHit.addEventListener("dblclick", () => void openInspector());
}

async function boot() {
  const settings = loadSettings();
  showBubble = settings.showBubble !== false;
  _workingMsgs = settings.workingMessages ?? null;
  _completionMsgs = settings.completionMessages ?? null;
  _idleMsgs = settings.idleMessages ?? null;

  if (settings.locale === "en" || settings.locale === "zh-CN") {
    setLocale(settings.locale);
  } else {
    setLocale(getLocale());
  }

  ($("ctx-ontop") as unknown as HTMLInputElement).checked =
    settings.alwaysOnTop;

  // Soft idle shell — real events replace this immediately
  player.load(buildDemoEvents());
  player.onEvent(renderEvent);
  // DOM setup is wrapped: a missing/typo'd DOM id must not abort boot and
  // leave event polling + presence listeners unwired (the safety net only logs).
  try {
    refreshSkin();
    updateConnPanel();

    wireUi();
    applyQualityPreset("fine");
    applyI18n();
  } catch (e) {
    uiLog(`boot: DOM setup partial: ${String((e as Error)?.message ?? e)}`);
    console.error("[pettty] boot DOM setup", e);
  }

  // —— CRITICAL: wire events BEFORE any awaited window ops ——
  // (await hang would leave poll never starting)
  setInterval(() => void pollAgentEvents(), 250);
  void pollAgentEvents();
  uiLog("boot: poll started");

  // Rotate the standby idle line every ~10s so the bubble feels alive.
  setInterval(() => {
    if (latest && latest.state === "idle" && claudeConnected && showBubble) {
      const bubble = $("bubble");
      if (!bubble.classList.contains("hidden")) {
        $("bubble-title").textContent = pickNextIdle();
      }
    }
  }, 10000);

  if (isTauri()) {
    setInterval(() => void persistPosition(), 2000);

    // Pause the sprite frame loop while the window is dragged, and resume
    // ~200ms after movement stops. Per-frame img.src + drop-shadow re-render
    // contends with the drag compositor; freezing frames keeps dragging smooth.
    let moveResume: number | null = null;
    void getCurrentWindow().onMoved(() => {
      dragging = true;
      spritePlayer.pause();
      if (moveResume !== null) clearTimeout(moveResume);
      moveResume = window.setTimeout(() => {
        dragging = false;
        spritePlayer.resume();
        moveResume = null;
      }, 200);
    });

    // Fire-and-forget listeners (do not block boot)
    void listen("agent-event", (ev) => {
      ingestLiveEvent(ev.payload);
    }).then(() => uiLog("listen agent-event ok"));

    void listen("bridge-status", (ev) => {
      const p = ev.payload as { ok?: boolean; error?: string };
      setBridgeStatus(Boolean(p?.ok), p?.error);
      applyI18n();
    });

    void listen<ClaudePresence>("claude-presence", (ev) => {
      onClaudePresence(ev.payload);
    });

    void invoke<ClaudePresence>("claude_presence_snapshot")
      .then((snap) => onClaudePresence(snap))
      .catch(() => {
        /* ignore */
      });

    setInterval(() => {
      if (dragging) return; // presence poll spawns a tasklist scan in Rust - skip mid-drag
      void invoke<ClaudePresence>("claude_presence_snapshot")
        .then((snap) =>
          onClaudePresence({
            ...snap,
            justConnected: false,
            justDisconnected: false,
          }),
        )
        .catch(() => {
          /* ignore */
        });
    }, 2000);

    setTimeout(() => {
      void fetch("http://127.0.0.1:7788/health")
        .then((r) => {
          setBridgeStatus(r.ok);
          applyI18n();
        })
        .catch(() => {
          setBridgeStatus(false, "health fetch failed");
          applyI18n();
        });
    }, 400);

    // Window chrome last — never block event wiring
    void resizeTo("pet");
    void setAlwaysOnTop(settings.alwaysOnTop);
    void restorePosition();
  }
}

// Safety net: if boot ever throws again (e.g. another missing DOM id), surface
// it in the Rust log instead of silently leaving the presence listener unwired.
boot().catch((e) => {
  console.error("[pettty] boot failed", e);
  uiLog(`BOOT THREW: ${String((e as Error)?.stack ?? e)}`);
});
