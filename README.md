# PetDeck / pet-tty

<p align="center">
  <em>Desktop pet for Claude Code — see what your AI agent is doing, at a glance.</em><br/>
  给 Claude Code 的桌面宠物 · 终端输入 <code>pettty</code> 启动
</p>

<p align="center"><strong>Windows-first development build. Tagged releases publish MSI and NSIS installers.</strong></p>

<p align="center">
  <a href="https://github.com/Wanbinyu/pet-tty/releases"><img src="https://img.shields.io/github/v/release/Wanbinyu/pet-tty?label=version" alt="version"/></a>
  <a href="https://github.com/Wanbinyu/pet-tty/actions/workflows/ci.yml"><img src="https://github.com/Wanbinyu/pet-tty/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <a href="https://github.com/Wanbinyu/pet-tty"><img src="https://img.shields.io/github/stars/Wanbinyu/pet-tty?style=social" alt="stars"/></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="platform"/>
  <img src="https://img.shields.io/badge/stack-Tauri%202%20%7C%20Vite%20%7C%20Rust-DEA584" alt="stack"/>
  <img src="https://img.shields.io/github/license/Wanbinyu/pet-tty?color=blue" alt="license"/>
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a> · <a href="docs/SPRITES.md">Skins / 皮肤</a>
</p>

---

## English

**PetDeck** (repo: [`pet-tty`](https://github.com/Wanbinyu/pet-tty)) is a tiny always-on-top desktop pet that shows what your AI coding agent is doing — thinking, reading, editing, waiting for you — without a big dashboard.

### One-command start: `pettty`

Like `claude`, after a one-time install you only type:

```powershell
pettty
```

This runs **`npm run tauri dev`** (Vite + Rust). Do **not** launch bare `debug/petdeck.exe` — that shows “无法访问此页面” because port 1420 is empty.

| Command | What it does |
|--------|----------------|
| `pettty` | Start pet (= `tauri dev`), auto-repair Claude hooks |
| `pettty release` | Start a local or downloaded release `.exe` |
| `pettty build` | Build release binary |
| `pettty test` | Send a test status event (pet must be running) |
| `pettty hooks` | Install/repair Claude hooks (HTTP + command) |
| `pettty health` | Check local bridge |
| `pettty help` | Help |

**Claude not connecting?** Settings often lose hooks when you change API keys. Run `pettty hooks`, fully quit Claude, reopen.

#### Install the `pettty` command (once)

```powershell
git clone https://github.com/Wanbinyu/pet-tty.git
cd pet-tty
npm install
powershell -ExecutionPolicy Bypass -File scripts/install-pettty.ps1
```

Open a **new** terminal, then:

```powershell
pettty
```

Or without installing to PATH (from the repo folder):

```powershell
npm start
# same as:  node bin/pettty.mjs
```

### Connect Claude Code

1. `pettty` — keep the pet running (bridge on **7788**)
2. `pettty hooks` — write HTTP hooks into Claude settings  
3. Restart Claude Code and chat / use tools  
4. Pet terminal should log `publish seq=…` and `webview.eval ok` / `pettty-ui applied …`  
5. Connection strip + bubble update on the pet

Manual test without Claude:

```powershell
pettty test
```

### Build and release

For a local development build:

```powershell
npm ci
npm run typecheck
npm run build
npm run tauri:build
```

Pushing a tag such as `v0.3.2` runs the Windows release workflow and publishes
the generated MSI and NSIS installers to GitHub Releases.

### Features

- Local HTTP bridge `127.0.0.1:7788`
- HTTP hooks + process presence (`~/.claude/sessions`)
- Multi-session stack
- Sticky tool states (long read/edit won’t flash idle)
- Triple delivery: Tauri emit + ring poll + **webview.eval** inject
- Skins / pixel doll / animated sprite import ([docs/SPRITES.md](docs/SPRITES.md))
- UI: 中文 / English

### Stack

| Piece | Tech |
|------|------|
| Shell | Tauri 2 |
| UI | Vite + TypeScript |
| CLI | `pettty` (Node) |
| Bridge | Rust `tiny_http` |

### Privacy and security

Runs locally. The bridge binds to `127.0.0.1:7788` and is intended for a trusted
local machine; it does not provide remote authentication. Hooks only hit the
local bridge. Don’t commit secrets.

### Prerequisites

Node.js 18+, Rust (rustup), WebView2. Windows: MSVC Build Tools (`link.exe`).

---

## 中文

**PetDeck**（仓库：[`pet-tty`](https://github.com/Wanbinyu/pet-tty)）是挂在桌面角落的轻量宠物：用气泡显示 Claude Code 在想什么、读/改哪个文件、是否等你确认。

### 一条命令启动：`pettty`

安装一次后，像 `claude` 一样，在任意终端输入：

```powershell
pettty
```

等价于 **`npm run tauri dev`**。不要单独运行 `debug/petdeck.exe`，否则会出现「无法访问此页面」（前端 1420 没起来）。

| 命令 | 作用 |
|------|------|
| `pettty` | 启动桌宠（= tauri dev），并自动修复 hooks |
| `pettty release` | 启动发布版 exe（需先 `pettty build`） |
| `pettty build` | 编译发布版 |
| `pettty test` | 发送测试状态 |
| `pettty hooks` | 安装/修复 Claude hooks（HTTP + command） |
| `pettty health` | 检查本机桥接 |
| `pettty help` | 帮助 |

**Claude 连不上？** 改 API Key 时 `settings.json` 里的 hooks 常被覆盖。执行 `pettty hooks`，**完全退出** Claude 再开。

#### 安装 `pettty` 命令（只需一次）

```powershell
git clone https://github.com/Wanbinyu/pet-tty.git
cd pet-tty
npm install
powershell -ExecutionPolicy Bypass -File scripts/install-pettty.ps1
```

**新开一个终端**，然后输入：

```powershell
pettty
```

不装 PATH 时，在仓库目录：

```powershell
npm start
```

### 连接 Claude Code

1. 运行 `pettty`，保持宠物开启（监听 **7788**）
2. 运行 `pettty hooks`
3. **重启 Claude Code**，随便聊一句
4. 宠物终端应出现 `publish seq=…` 和 `pettty-ui applied …`
5. 上方连接条 / 气泡应显示「执行中」等状态

无 Claude 自测：

```powershell
pettty test
```

### 功能摘要

- 本机桥 `127.0.0.1:7788`
- HTTP Hooks + 进程在线检测
- 多会话
- 工具状态粘性
- 三通道刷新 UI：事件 emit + 轮询 + **webview 直注**
- 皮肤 / 像素小人 / 动画皮肤([docs/SPRITES.md](docs/SPRITES.md))
- 中英双语界面

### 隐私

默认只在本机通信。请勿提交 API Key 或个人会话。

### 环境

Node.js 18+、Rust、WebView2；Windows 需 C++ 生成工具。

---

## Status

| Version | Notes |
|--------|--------|
| **0.3.2** | Fix `pettty` blank page · dual HTTP+command hooks · process detect · auto-repair hooks |
| **0.3.1** | `pettty` CLI · UI delivery fix (eval + poll) · bilingual README |

Repo: [github.com/Wanbinyu/pet-tty](https://github.com/Wanbinyu/pet-tty)

## License

MIT. See [LICENSE](LICENSE).
